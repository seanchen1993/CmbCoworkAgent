import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotWorkflowStore, type BotWorkflowDefinition } from "./workflow-store"
import { BOT_SCHEMA_VERSION } from "./schema"

const roots: string[] = [],
  stores: BotStore[] = []
let now = 1_800_000_000_000
function open(path: string) {
  const store = new BotStore(path, () => now)
  stores.push(store)
  return store
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-workflow-store-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    store = open(path)
  const { conversationId } = store.createBot({ nonce: "owner", name: "Workflow owner" })
  store.send({ nonce: "task", conversationId, text: "Review project" })
  const claimed = store.claim("host-a")!
  return { store, path, root, ...claimed }
}
const definition: BotWorkflowDefinition = {
  script:
    'export const meta={name:"Review",description:"Review source"}; return await agent("review");',
  args: { target: "src" },
  maxConcurrency: 2,
  defaultModelId: "selected-provider-model",
  agentProfiles: [],
  authority: { workspaceIdentity: "test-inode", connectorRevision: 1 }
}
const journal = (index = 0, hash = "a".repeat(64)) => ({
  index,
  hash,
  result: "verified",
  outputTokens: 5
})
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  now = 1_800_000_000_000
})

it("keeps independent same-index replay entries, complete output and agent status across reopening SQLite", async () => {
  const f = fixture(),
    workflow = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  workflow.upsertAgent({
    index: 0,
    label: "Review",
    phase: null,
    status: "running",
    outputTokens: 0
  })
  workflow.appendJournal(journal())
  workflow.appendJournal(journal(0, "b".repeat(64)))
  workflow.appendJournal({ ...journal(), result: "updated evidence" })
  workflow.upsertAgent({
    index: 0,
    label: "Review",
    phase: null,
    status: "completed",
    outputTokens: 5
  })
  await workflow.persistFullResult(JSON.stringify({ full: "long result" }))
  workflow.update((state) => {
    state.status = "completed"
    state.result = "summary"
    state.resultSidecarStatus = "available"
  })
  expect(await workflow.flush()).toBe(true)
  f.store.close()
  const next = open(f.path),
    restored = BotWorkflowStore.open(next, f.lease, "call-1", definition)
  expect(restored.id).toBe(workflow.id)
  expect(restored.state).toMatchObject({ status: "completed", result: "summary", resumed: true })
  expect(restored.state.journal.map((item) => item.result)).toEqual([
    "updated evidence",
    "verified"
  ])
  expect(restored.state.agents[0]).toMatchObject({ status: "completed", outputTokens: 5 })
  expect(
    JSON.parse(
      String(
        next.db.exec("SELECT result FROM bot_workflows WHERE id=?", [restored.id])[0].values[0][0]
      )
    )
  ).toEqual({ full: "long result" })
  expect(await restored.flush()).toBe(true)
})

it("fences replaced instances and expired leases before writes, even with the same invocation", async () => {
  const f = fixture(),
    first = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  const second = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  expect(() => first.appendJournal(journal())).toThrow("接替")
  expect(second.state.journal).toEqual([])
  expect(await second.flush()).toBe(true)
  now += 31_000
  expect(() =>
    second.update((state) => {
      state.status = "completed"
    })
  ).toThrow("执行权已失效")
  expect(
    JSON.parse(
      String(
        f.store.db.exec("SELECT state FROM bot_workflows WHERE id=?", [second.id])[0].values[0][0]
      )
    ).status
  ).toBe("running")
})

it.each([
  { script: definition.script + "\n// revised" },
  { args: { target: "secret" } },
  { defaultModelId: "different" },
  { authority: { workspaceIdentity: "replaced" } }
])("refuses to rebind a persisted call to changed execution inputs: %j", (changed) => {
  const f = fixture(),
    first = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  expect(() =>
    BotWorkflowStore.open(f.store, f.lease, "call-1", { ...definition, ...changed })
  ).toThrow("不能重放")
  first.appendJournal(journal())
  expect(first.state.journal).toHaveLength(1)
})

it("rolls back failed persistence and prevents reuse of the diverged in-memory instance", async () => {
  const f = fixture(),
    workflow = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  f.store.db.run(
    "CREATE TRIGGER workflow_disk_failure BEFORE UPDATE ON bot_workflows BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END"
  )
  expect(() =>
    workflow.update((state) => {
      state.result = "must not commit"
    })
  ).toThrow("simulated disk failure")
  await expect(workflow.flush()).rejects.toThrow("保存失败")
  f.store.db.run("DROP TRIGGER workflow_disk_failure")
  const restored = BotWorkflowStore.open(f.store, f.lease, "call-1", definition)
  expect(restored.state.result).toBeUndefined()
})

it("migrates an actual v18 database with no workflow tables and retains its original task", () => {
  const f = fixture()
  f.store.close()
  const db = new DatabaseSync(f.path)
  db.exec(
    "DROP TABLE bot_workflow_io; DROP TABLE bot_workflow_journal; DROP TABLE bot_workflows; UPDATE bot_schema SET version=18"
  )
  db.close()
  const next = open(f.path)
  expect(next.getRun(f.run.id).messageId).toBe(f.run.messageId)
  expect(next.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  expect(BotWorkflowStore.open(next, f.lease, "after-upgrade", definition).state.journal).toEqual(
    []
  )
  expect(
    readdirSync(join(f.root, "backups")).filter((name) => name.startsWith("bots-v18-"))
  ).toHaveLength(1)
})
