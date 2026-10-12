import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import { listBotAsyncTasks } from "./async-tasks"
import type { BotAsyncTasksRequest } from "../../shared/bot-async-tasks"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
const definition: BotWorkflowDefinition = {
  script:
    'export const meta={name:"检查构建",description:"SECRET_DESCRIPTION"}; return "PRIVATE_SCRIPT";',
  maxConcurrency: 1,
  defaultModelId: "PRIVATE_MODEL",
  agentProfiles: [],
  authority: { private: "PRIVATE_AUTHORITY" }
}
function fixture(branch = false) {
  const root = mkdtempSync(join(tmpdir(), "cmb-async-tasks-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "Owner" })
  const other = store.createBot({ nonce: "other", name: "Other" })
  const rootMessage = store.send({
    nonce: "root",
    conversationId: owner.conversationId,
    text: "Original task"
  })
  store.cancel(rootMessage.runIds[0])
  store.send({
    nonce: "task",
    conversationId: owner.conversationId,
    text: "Current task",
    ...(branch ? { threadRootId: rootMessage.messageId } : {})
  })
  const parent = store.claim("host", 60_000)!
  const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", definition)
  const child = (index = 0) =>
    store.workflowChildren.reserve(workflow, parent.lease, {
      prompt: "PRIVATE_CHILD_PROMPT",
      agentIndex: index,
      toolStreamKey: `${"a".repeat(64)}_c${index}`,
      durableCallKey: `${"a".repeat(64)}_n${index}`,
      label: `检查项 ${index}`,
      phase: "验证",
      shellAccess: "read_only"
    })
  return { path, store, owner, other, parent, workflow, child, rootMessage }
}

it("projects only scoped live task metadata and preserves branch addresses without dispatching work", () => {
  const f = fixture(true),
    child = f.child()
  const cursor = f.store.snapshot().cursor
  const page = listBotAsyncTasks(f.store, { botId: f.owner.bot.id })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({
    kind: "child",
    status: "queued",
    label: "检查项 0",
    phase: "验证",
    address: {
      runId: child.id,
      conversationId: f.owner.conversationId,
      threadRootId: f.rootMessage.messageId
    }
  })
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|SECRET_/)
  expect(f.store.snapshot().cursor).toBe(cursor)
  expect(listBotAsyncTasks(f.store, { botId: f.other.bot.id }).items).toEqual([])
  f.store.cancel(child.id)
  expect(listBotAsyncTasks(f.store, { botId: f.owner.bot.id }).items).toEqual([])
})

it("paginates tied timestamps without duplicates and accepts a cursor whose task has just finished", () => {
  const f = fixture()
  for (let index = 0; index < 48; index++) f.child(index)
  let before: BotAsyncTasksRequest["before"]
  const ids = new Set<string>()
  do {
    const page = listBotAsyncTasks(f.store, { botId: f.owner.bot.id, before, limit: 7 })
    expect(page.items.length).toBeLessThanOrEqual(7)
    for (const task of page.items) {
      expect(ids.has(task.key)).toBe(false)
      ids.add(task.key)
    }
    before = page.next ?? undefined
    if (before) f.store.cancel(page.items.at(-1)!.address.runId)
  } while (before)
  expect(ids.size).toBe(48)
  const first = listBotAsyncTasks(f.store, { botId: f.owner.bot.id, limit: 1 })
  expect(() => listBotAsyncTasks(f.store, { botId: f.other.bot.id, before: first.next })).toThrow(
    "不属于"
  )
  for (const input of [
    { botId: f.owner.bot.id, limit: 1000 },
    { botId: "missing" },
    { botId: f.owner.bot.id, credentials: true }
  ])
    expect(() => listBotAsyncTasks(f.store, input)).toThrow()
})

it("keeps uncollected background workflows visible without duplicating their active children", () => {
  const f = fixture()
  f.store.db.run("INSERT INTO bot_background_workflows VALUES(?,?,NULL)", [
    f.workflow.id,
    JSON.stringify(definition)
  ])
  let page = listBotAsyncTasks(f.store, { botId: f.owner.bot.id })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({
    kind: "workflow",
    label: "检查构建",
    address: { runId: f.parent.run.id }
  })
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|SECRET_/)
  const child = f.child()
  page = listBotAsyncTasks(f.store, { botId: f.owner.bot.id })
  expect(page.items).toHaveLength(1)
  expect(page.items[0].kind).toBe("child")
  f.store.cancel(child.id)
  expect(listBotAsyncTasks(f.store, { botId: f.owner.bot.id }).items[0].kind).toBe("workflow")
  f.store.db.run("UPDATE bot_background_workflows SET receipt=? WHERE workflow_id=?", [
    '{"status":"completed"}',
    f.workflow.id
  ])
  expect(listBotAsyncTasks(f.store, { botId: f.owner.bot.id }).items).toEqual([])
})

it("retains interrupted tasks after restart and excludes tasks after membership is revoked", () => {
  const f = fixture(),
    queued = f.child()
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  next.recoverAbandonedAtStartup()
  const page = listBotAsyncTasks(next, { botId: f.owner.bot.id })
  expect(page.items[0].address.runId).toBe(queued.id)
  expect(page.items[0].status).toBe("needs_review")
  expect(next.getRun(f.parent.run.id).status).toBe("needs_review")
  next.db.run("DELETE FROM bot_members WHERE bot_id=? AND conversation_id=?", [
    f.owner.bot.id,
    f.owner.conversationId
  ])
  expect(listBotAsyncTasks(next, { botId: f.owner.bot.id }).items).toEqual([])
})
