import { writeBotModelSnapshot } from "./model-config"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { build } from "esbuild"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { BotWorktrees } from "./worktrees"
import { executeBotBackup } from "./backups"
import { randomUUID } from "node:crypto"
import { executeBotWorktreeOperation } from "./worktree-operations"
import { botWorktreeRecord, botWorktreeSource } from "./worktree-contract"
import { BotOperationProcess } from "./operation-process"

let worker: string
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-worktree-worker-"))
  worker = join(root, "worker.cjs")
  await build({
    entryPoints: ["src/main/bots/worktree-worker-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: worker,
    logLevel: "silent"
  })
  return () => rm(root, { recursive: true, force: true })
})
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture(timeouts?: {
  workflowWorktreeTimeoutMinutes: number
  workflowWorktreeRemoveTimeoutMinutes: number
}) {
  const root = await mkdtemp(join(tmpdir(), "bot-worktree-actions-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project"),
    host = join(root, "host")
  await mkdir(project)
  await mkdir(host)
  if (timeouts)
    await writeBotModelSnapshot(join(host, "models.private"), {
      version: 1,
      defaultRef: null,
      models: [],
      ...timeouts
    })
  const git = (cwd: string, ...args: string[]) =>
    promisify(execFile)("git", [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args
    ])
  await git(project, "init", "-b", "main")
  await writeFile(join(project, "app.txt"), "source\n")
  await git(project, "add", "app.txt")
  await git(project, "commit", "-m", "source")
  let store = new BotStore(join(host, "bots.sqlite"))
  cleanup.push(() => store.close())
  const worktrees = new BotWorktrees(join(host, "models.private"), { entry: worker })
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Test",
    workspacePath: project
  })
  store.send({ nonce: "task", conversationId, text: "Do work" })
  const parent = store.claim("worker", 300_000)!
  const workflow = BotWorkflowStore.open(store, parent.lease, "call", {
    script: 'export const meta = { name: "Test", description: "Review actions" }; return "ok"',
    maxConcurrency: 1,
    defaultModelId: "test",
    agentProfiles: [],
    authority: {}
  })
  const child = store.workflowChildren.claim(workflow, parent.lease, {
    prompt: "Edit",
    label: "Edit",
    phase: null,
    agentIndex: 1,
    isolation: "worktree",
    toolStreamKey: `${"a".repeat(64)}_c1`,
    durableCallKey: `${"a".repeat(64)}_n1`
  })
  const signal = new AbortController().signal
  await worktrees.execute(
    { store, bot, run: child.run, lease: child.lease!, messages: [], signal },
    async (request) => {
      await writeFile(join(request.bot.workspacePath!, "scratch.txt"), "private work\n")
      return "done"
    }
  )
  const address = { conversationId, runId: child.run.id }
  const detail = await worktrees.detail(store, address, signal)
  const settle = () =>
    store.workflowChildren.settle(child.lease!, "succeeded", {
      text: "done",
      structured: null,
      outputTokens: 0
    })
  const input = {
    ...address,
    nonce: "discard",
    operation: "discard" as const,
    expectedHeadCommit: detail.worktree.headCommit!
  }
  const restore = async () => {
    store.close()
    try {
      const saved = (await executeBotBackup(host, { action: "create", nonce: randomUUID() }))
        .backup!
      await writeFile(join(detail.worktree.directory, "scratch.txt"), "newer external work\n")
      await executeBotBackup(host, {
        action: "restore",
        nonce: randomUUID(),
        backup: { id: saved.id, sha256: saved.sha256 }
      })
    } finally {
      store = new BotStore(join(host, "bots.sqlite"))
    }
    return store
  }
  return { store, worktrees, address, input, signal, settle, detail, project, restore }
}

it("rejects active-task cleanup, cross-conversation requests and unrecognized operations", async () => {
  const f = await fixture()
  await expect(f.worktrees.cleanup(f.store, f.input, f.signal)).rejects.toThrow("先结束")
  f.settle()
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  await expect(
    f.worktrees.cleanup(f.store, { ...f.input, conversationId: other.conversationId }, f.signal)
  ).rejects.toThrow()
  await expect(
    f.worktrees.cleanup(f.store, { ...f.input, operation: "remove-all" as "discard" }, f.signal)
  ).rejects.toThrow()
  expect(await readFile(join(f.detail.worktree.directory, "scratch.txt"), "utf8")).toBe(
    "private work\n"
  )
  expect(f.worktrees.busy).toBe(false)
}, 20_000)

it("reconciles a stopped task after backup restore while preserving newer external worktree files", async () => {
  const f = await fixture()
  const record = botWorktreeRecord.parse(
    JSON.parse(
      String(
        f.store.db.exec("SELECT record FROM bot_worktrees WHERE run_id=?", [f.address.runId])[0]
          .values[0][0]
      )
    )
  )
  const source = botWorktreeSource.parse(
    JSON.parse(
      String(
        f.store.db.exec("SELECT source FROM bot_worktree_sources WHERE workflow_id=?", [
          record.runId
        ])[0].values[0][0]
      )
    )
  )
  await executeBotWorktreeOperation(
    {
      op: "acquire",
      source,
      appDataRoot: f.worktrees.appDataRoot,
      workspacePath: source.workspacePath,
      runId: record.runId,
      childId: record.threadId
    },
    f.signal
  )
  const restored = await f.restore()
  expect(restored.getRun(f.address.runId).status).toBe("cancelled")
  const detail = await f.worktrees.detail(restored, f.address, f.signal)
  expect(detail.worktree).toMatchObject({
    id: f.detail.worktree.id,
    status: "recoverable",
    dirty: true
  })
  expect(await readFile(join(detail.worktree.directory, "scratch.txt"), "utf8")).toBe(
    "newer external work\n"
  )
  const discarded = await f.worktrees.cleanup(restored, f.input, f.signal)
  expect(discarded.status).toBe("discarded")
  expect(await readFile(join(f.project, "app.txt"), "utf8")).toBe("source\n")
}, 20_000)

it("recovers a completed discard after the database acknowledgement is lost without deleting the source", async () => {
  const f = await fixture()
  f.settle()
  const original = f.store.db.run.bind(f.store.db)
  let failOnce = true
  vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
    if (failOnce && sql.startsWith("UPDATE bot_worktrees")) {
      failOnce = false
      throw new Error("Injected acknowledgement loss")
    }
    return original(sql, params)
  })
  await expect(f.worktrees.cleanup(f.store, f.input, f.signal)).rejects.toThrow(
    "acknowledgement loss"
  )
  expect(f.worktrees.busy).toBe(false)
  await expect(readFile(join(f.detail.worktree.directory, "scratch.txt"))).rejects.toThrow()
  const discarded = await f.worktrees.cleanup(f.store, f.input, f.signal)
  expect(discarded).toMatchObject({ status: "discarded", cleanupPending: false })
  expect(await f.worktrees.cleanup(f.store, f.input, f.signal)).toEqual(discarded)
  await expect(f.worktrees.merge(f.store, f.input, f.signal)).rejects.toThrow("另一项操作")
  const detail = await f.worktrees.detail(f.store, f.address, f.signal)
  expect(detail.worktree.status).toBe("discarded")
  expect(await readFile(join(f.project, "app.txt"), "utf8")).toBe("source\n")
}, 20_000)

it("reattaches the exact owned checkout when Host lost its database acknowledgement", async () => {
  const f = await fixture()
  f.settle()
  f.store.db.run("DELETE FROM bot_worktrees WHERE run_id=?", [f.address.runId])
  expect(f.store.runHistory(f.address).hasWorktree).toBe(true)
  const recovered = await f.worktrees.detail(f.store, f.address, f.signal)
  expect(recovered.worktree).toMatchObject({
    id: f.detail.worktree.id,
    directory: f.detail.worktree.directory,
    dirty: true
  })
  expect(await readFile(join(recovered.worktree.directory, "scratch.txt"), "utf8")).toBe(
    "private work\n"
  )
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_worktrees")[0].values[0][0]).toBe(1)
  expect((await f.worktrees.cleanup(f.store, f.input, f.signal)).status).toBe("discarded")
  expect(await readFile(join(f.project, "app.txt"), "utf8")).toBe("source\n")
}, 20_000)

it("preserves explicit cleanup access when a registered checkout is missing", async () => {
  const f = await fixture()
  f.settle()
  await rm(f.detail.worktree.directory, { recursive: true })
  const detail = await f.worktrees.detail(f.store, f.address, f.signal)
  expect(detail.worktree.id).toBe(f.detail.worktree.id)
  expect(detail.worktree.error).toMatch(/missing|registered/)
  expect(detail.patchTruncated).toBe(true)
  expect(detail.patch).toBe("")
  expect(await f.worktrees.cleanup(f.store, f.input, f.signal)).toMatchObject({
    status: "discarded",
    cleanupPending: false
  })
  expect(await readFile(join(f.project, "app.txt"), "utf8")).toBe("source\n")
}, 20_000)

it("returns a valid empty lookup through the worker without creating a checkout", async () => {
  const f = await fixture()
  const record = botWorktreeRecord.parse(
    JSON.parse(
      String(
        f.store.db.exec("SELECT record FROM bot_worktrees WHERE run_id=?", [f.address.runId])[0]
          .values[0][0]
      )
    )
  )
  const source = botWorktreeSource.parse(
    JSON.parse(
      String(
        f.store.db.exec("SELECT source FROM bot_worktree_sources WHERE workflow_id=?", [
          record.runId
        ])[0].values[0][0]
      )
    )
  )
  const result = await new BotOperationProcess({ entry: worker }, "lookup").execute(
    {
      op: "lookup",
      source,
      workspacePath: source.workspacePath,
      appDataRoot: f.worktrees.appDataRoot,
      runId: record.runId,
      childId: "never-started"
    },
    60_000,
    (value) => botWorktreeRecord.nullable().parse(value),
    f.signal
  )
  expect(result).toBeNull()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_worktrees")[0].values[0][0]).toBe(1)
  expect(f.worktrees.busy).toBe(false)
}, 20_000)

it("forwards configured budgets to real Git workers and preserves timeout policy for maintenance", async () => {
  const execute = vi.spyOn(BotOperationProcess.prototype, "execute")
  const f = await fixture({
    workflowWorktreeTimeoutMinutes: 7,
    workflowWorktreeRemoveTimeoutMinutes: 2
  })
  const prepare = execute.mock.calls.find(([input]) => (input as { op: string }).op === "prepare")!
  const acquire = execute.mock.calls.find(([input]) => (input as { op: string }).op === "acquire")!
  for (const call of [prepare, acquire]) {
    expect(call[0]).toMatchObject({ timeouts: { createMinutes: 7, removeMinutes: 2 } })
    expect(call[1]).toBe(9 * 60_000)
  }
  f.settle()
  await f.worktrees.cleanup(f.store, f.input, f.signal)
  const discard = execute.mock.calls.find(([input]) => (input as { op: string }).op === "discard")!
  expect(discard[0]).toMatchObject({ timeouts: { createMinutes: 7, removeMinutes: 2 } })
  expect(discard[1]).toBe(4 * 60_000)
  expect(f.worktrees.busy).toBe(false)
}, 20_000)
