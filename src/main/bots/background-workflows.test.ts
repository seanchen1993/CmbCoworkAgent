import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotBackgroundWorkflows } from "./background-workflows"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import { BotDomainError } from "../../shared/bot-types"
import { BOT_SCHEMA_VERSION } from "./schema"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const definition: BotWorkflowDefinition = {
  script: 'export const meta={name:"Review",description:"Review"}; return "evidence";',
  maxConcurrency: 1,
  defaultModelId: "configured",
  agentProfiles: [],
  authority: { project: "test", roles: 1 }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-background-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Developer" })
  store.send({ nonce: "task", conversationId, text: "Review project" })
  const parent = store.claim("host", 60000)!
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const request = {
    ...parent,
    store,
    bot,
    messages: store.messagesForRun(parent.run.id),
    signal: controller.signal
  }
  const take = {
    threadId: parent.run.id,
    ownerRunToken: `${parent.lease.owner}:${parent.lease.fence}`,
    appliedIds: [] as string[],
    phase: "afterModel" as const
  }
  return { root, path, store, parent, request, take, controller, conversationId }
}

it("persists dispatch and result receipts and redelivers until the graph checkpoint acknowledges them", async () => {
  const f = fixture()
  let executed = 0
  const manager = new BotBackgroundWorkflows(
    f.request,
    async () => definition,
    async (workflow) => {
      executed++
      return JSON.stringify({ workflowId: workflow.id, status: "completed", result: "evidence" })
    }
  )
  cleanup.push(() => manager.close())
  const receipt = manager.dispatch("call-a", definition)
  expect(manager.dispatch("call-a", { ...definition })).toBe(receipt)
  expect(() => manager.dispatch("call-a", { ...definition, args: "changed" })).toThrow("配置已变化")
  const queue = manager.queue(f.store.steering.queue(f.parent.lease))
  const delivered = await queue.take(f.take)
  expect(delivered).toHaveLength(1)
  expect(String(delivered[0].content)).toContain("evidence")
  expect(executed).toBe(1)
  expect((await queue.take(f.take))[0].id).toBe(delivered[0].id)
  expect(await queue.take({ ...f.take, appliedIds: [delivered[0].id!] })).toEqual([])
  await manager.close()
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  const restored = new BotBackgroundWorkflows(
    { ...f.request, store: next },
    async () => {
      throw new Error("Must not rerun completed work")
    },
    async () => {
      throw new Error("Must not execute")
    }
  )
  cleanup.push(() => restored.close())
  await restored.restore()
  const recovered = await restored.queue(next.steering.queue(f.parent.lease)).take(f.take)
  expect(recovered.map((message) => message.id)).toEqual(delivered.map((message) => message.id))
  expect(restored.dispatch("call-a", definition)).toBe(receipt)
  expect(next.db.exec("SELECT COUNT(*) FROM bot_workflows")[0].values[0][0]).toBe(1)
})

it("restores unacknowledged work with the original identity and refuses changed execution authority", async () => {
  const f = fixture()
  const failed = new BotBackgroundWorkflows(
    f.request,
    async () => definition,
    async () => {
      throw new BotDomainError("fixture_interrupted", "Interrupted")
    }
  )
  cleanup.push(() => failed.close())
  const receipt = failed.dispatch("call-a", definition)
  await delay(0)
  await failed.close()
  expect(f.store.db.exec("SELECT receipt FROM bot_background_workflows")[0].values[0][0]).toBeNull()
  const changed = new BotBackgroundWorkflows(
    f.request,
    async () => ({ ...definition, authority: { roles: 2 } }),
    async () => {
      throw new Error("Must not execute")
    }
  )
  cleanup.push(() => changed.close())
  await expect(changed.restore()).rejects.toThrow("授权配置已变化")
  let id: string | undefined
  const resumed = new BotBackgroundWorkflows(
    f.request,
    async () => definition,
    async (workflow) => {
      id = workflow.id
      return JSON.stringify({ workflowId: id, status: "completed", result: "resumed" })
    }
  )
  cleanup.push(() => resumed.close())
  await resumed.restore()
  expect(await resumed.queue(f.store.steering.queue(f.parent.lease)).take(f.take)).toHaveLength(1)
  expect(id).toBe(JSON.parse(receipt).workflowId)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_workflows")[0].values[0][0]).toBe(1)
})

it("keeps foreground steering independent and wakes final waits without losing background work", async () => {
  const f = fixture()
  let complete!: () => void
  const hold = new Promise<void>((resolve) => {
    complete = resolve
  })
  const manager = new BotBackgroundWorkflows(
    f.request,
    async () => definition,
    async (workflow) => {
      await hold
      return JSON.stringify({ workflowId: workflow.id, status: "completed", result: "done" })
    }
  )
  cleanup.push(() => manager.close())
  cleanup.push(complete)
  manager.dispatch("call-a", definition)
  const waiting = manager.queue(f.store.steering.queue(f.parent.lease)).take(f.take)
  const extra = f.store.send({
    nonce: "extra",
    conversationId: f.conversationId,
    text: "Also check tests",
    steerRunId: f.parent.run.id
  })
  const messages = await waiting
  expect(messages.map((message) => message.id)).toEqual([extra.messageId])
  complete()
  const result = await manager
    .queue(f.store.steering.queue(f.parent.lease))
    .take({ ...f.take, appliedIds: [extra.messageId] })
  expect(String(result[0].content)).toContain("done")
})

it("upgrades v22 with a backup and without altering prior workflow identity or model accounting", () => {
  const f = fixture()
  const workflow = BotWorkflowStore.open(f.store, f.parent.lease, "existing", definition)
  f.store.db.run("DROP TABLE bot_background_workflows")
  f.store.db.run("UPDATE bot_schema SET version=22")
  const before = f.store.db.exec("SELECT * FROM bot_workflows")
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  expect(next.db.exec("SELECT * FROM bot_workflows")).toEqual(before)
  expect(next.db.exec("SELECT * FROM bot_background_workflows")[0].values).toEqual([])
  expect(readdirSync(join(f.root, "backups")).some((name) => name.startsWith("bots-v22-"))).toBe(
    true
  )
  expect(workflow.id).toBe(String(before[0].values[0][0]))
})

it("settles a never-started reservation when its worker cannot launch", async () => {
  const { BOT_BACKGROUND_TASK_SCRIPT } = await import("./background-task-input")
  const f = fixture()
  const reservedDefinition = {
    ...definition,
    script: BOT_BACKGROUND_TASK_SCRIPT,
    args: { prompt: "Read project", label: "Read" }
  }
  const manager = new BotBackgroundWorkflows(
    f.request,
    async () => reservedDefinition,
    async () => {
      throw new Error("worker unavailable")
    }
  )
  cleanup.push(() => manager.close())
  const receipt = JSON.parse(manager.dispatch("worker-start", reservedDefinition))
  expect(f.store.getRun(receipt.runId).status).toBe("queued")
  expect(f.store.getRun(receipt.runId).fence).toBe(0)
  const results = await manager.queue(f.store.steering.queue(f.parent.lease)).take(f.take)
  expect(String(results[0].content)).toContain("worker unavailable")
  expect(f.store.getRun(receipt.runId).status).toBe("cancelled")
  expect(f.store.workflowChildren.outstanding(f.parent.run.id)).toEqual([])
})
