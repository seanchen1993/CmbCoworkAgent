import { DatabaseSync } from "node:sqlite"
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalSandbox } from "../agent/local-sandbox"
import { BotStore } from "./store"
import type {
  BackgroundCommandResult,
  BackgroundCommandStart
} from "../agent/background-command-lifecycle"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(directGroup = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-background-")))
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const create = (name: string) =>
    store.create({ name, instructions: "", modelRef: null, color: "#123456" })
  const a = create("Caller"),
    b = create("Worker")
  const group = store.saveGroup({ name: "Service verification", memberIds: [a.id, b.id] })
  store.sendGroup({
    groupId: group.id,
    requestId: "request",
    text: "Build and verify",
    targetBotIds: [a.id]
  })
  const root = store.recentTasks()[0]
  store.transition(root.id, "running")
  const task = directGroup ? root : store.delegate(root.id, b.id, "Build and verify", "delegation")
  if (!directGroup) {
    store.settle(root.id, "completed", null, "Waiting for worker")
    store.transition(task.id, "running")
  }
  const starts: BackgroundCommandStart[] = [],
    results: BackgroundCommandResult[] = []
  const sandbox = new LocalSandbox({
    rootDir: dir,
    runId: task.threadId,
    windowsSandbox: "none",
    backgroundCommandLifecycle: {
      ...(directGroup ? { allowSilentServices: true } : { retainSource: true }),
      accepted(start) {
        store.acceptCommand(task.id, start, !directGroup)
        starts.push(start)
      },
      settled(result) {
        store.settleCommand(result)
        results.push(result)
      }
    }
  })
  // No approval UI or configured external hooks; process execution and ownership are real.
  Reflect.set(sandbox, "runPreToolUseHookForTool", async () => null)
  Reflect.set(sandbox, "runPreToolUseHook", async () => null)
  Reflect.set(sandbox, "runHooks", async () => null)
  Reflect.set(sandbox, "requestHumanGateForExecute", async () => undefined)
  cleanups.push(async () => {
    await LocalSandbox.cancelBackgroundTasksAndWait(task.threadId)
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const launch = async (source: string, notify?: boolean) => {
    const script = join(dir, `job-${starts.length}.mjs`)
    await writeFile(script, source)
    return sandbox.executeBackground(`"${process.execPath}" "${script}"`, dir, notify)
  }
  const replies = () =>
    store.recentTasks().filter((t) => t.botId === a.id && t.origin.kind === "bot")
  return { db, store, sandbox, task, b, group, dir, starts, results, launch, replies }
}

it.each([0, 7])(
  "retains the peer request until a real finite command exits (%s), then returns once",
  async (exitCode) => {
    const f = await fixture()
    const response = await f.launch(
      `setTimeout(() => { console.log('ACTUAL_RESULT'); process.exit(${exitCode}) }, 300)`
    )
    expect(response).toContain("resume this same task")
    expect(f.starts).toHaveLength(1)
    f.store.deferTask(f.task.id, "after-launch")
    expect(f.store.nextQueued([])).toBeNull()
    f.store.flushReplies()
    expect(f.replies()).toHaveLength(0)
    await vi.waitFor(() => expect(f.results).toHaveLength(1), { timeout: 5000 })
    expect(f.results[0]).toMatchObject({ exitCode, cancelled: false })
    expect(f.store.nextQueued([])?.id).toBe(f.task.id)
    expect(f.store.continuationCommandResults(f.task.id)[0]).toMatchObject({
      exitCode,
      output: expect.stringContaining("ACTUAL_RESULT")
    })
    f.store.transition(f.task.id, "running")
    f.store.settle(
      f.task.id,
      exitCode === 0 ? "completed" : "failed",
      exitCode ? "Command failed" : null,
      exitCode ? undefined : "Verified actual result"
    )
    f.store.flushReplies()
    f.store.settleCommand(f.results[0])
    f.store.flushReplies()
    expect(f.replies()).toHaveLength(1)
    expect(f.store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(0)
  },
  10000
)

it.each([0, 7])(
  "preserves the earliest finite result after eight later checks finish (exit %s)",
  async (exitCode) => {
    const f = await fixture()
    const accept = (i: number) => f.store.acceptCommand(f.task.id, {
      id: `check-${i}`, threadId: f.task.threadId,
      command: "x".repeat(8_000), cwd: f.dir, startedAt: i
    }, true)
    const settle = (i: number, code: number) => f.store.settleCommand({
      id: `check-${i}`, threadId: f.task.threadId, exitCode: code,
      output: "x".repeat(15_980) + `RESULT_${i}_${code}`,
      cancelled: false, truncated: i === 9
    })
    accept(1)
    for (let i = 2; i <= 9; i++) {
      accept(i)
      settle(i, 0)
    }
    f.store.deferTask(f.task.id, "waiting-for-build")
    expect(f.store.nextQueued([])).toBeNull()
    const firstEight = f.store.continuationCommandResults(f.task.id)
    expect(firstEight).toHaveLength(8)
    expect(firstEight[0]).toMatchObject({ command: "x".repeat(8_000), truncated: false })
    expect(firstEight[7].truncated).toBe(true)
    settle(1, exitCode)
    expect(f.store.nextQueued([])?.id).toBe(f.task.id)
    const receipts = f.store.continuationCommandResults(f.task.id)
    expect(receipts.map(r => r.task_id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `check-${i + 1}`)
    )
    expect(receipts[0]).toMatchObject({ exitCode, state: "completed" })
    expect(String(receipts[0].output)).toContain(`RESULT_1_${exitCode}`)
    expect(receipts.every(r => r.truncated === true)).toBe(true)
    expect(receipts.reduce((sum, r) => sum + String(r.output).length, 0)).toBeLessThanOrEqual(8 * 16_000)
    expect(receipts.reduce((sum, r) => sum + String(r.command).length, 0)).toBeLessThanOrEqual(8 * 8_000)
    const persisted = JSON.parse(String(f.db.exec(
      "SELECT continuation_result_json FROM bot_commands WHERE id='check-1'"
    )[0].values[0][0]))
    expect(persisted.command).toHaveLength(8_000)
    expect(persisted.output).toHaveLength(15_980 + `RESULT_1_${exitCode}`.length)
    expect(persisted.truncated).toBe(false)
    expect(f.store.continuationCommandResults(f.task.id)).toEqual(receipts)
    expect(f.store.continuationCommandIds(f.task.id)).toEqual([])
    expect(f.replies()).toHaveLength(0)
  }
)

it("checks a live HTTP service and returns the verified result without waiting for service exit", async () => {
  const f = await fixture()
  const portFile = join(f.dir, "port")
  const response = await f.launch(
    `import http from 'node:http'; import fs from 'node:fs';
const server = http.createServer((_req,res)=>res.end('READY'));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(server.address().port)));`,
    false
  )
  expect(response).toContain("continue with a health check")
  await vi.waitFor(
    async () => expect(Number(await readFile(portFile, "utf8"))).toBeGreaterThan(0),
    { timeout: 5000 }
  )
  expect(await (await fetch(`http://127.0.0.1:${await readFile(portFile, "utf8")}`)).text()).toBe(
    "READY"
  )
  expect(f.results).toHaveLength(0)
  expect(f.store.continuationCommandIds(f.task.id)).toEqual([])
  expect(f.store.continuationCommandIds(f.task.id, true)).toEqual([f.starts[0].id])
  f.store.settle(f.task.id, "completed", null, "HTTP readiness verified")
  f.store.flushReplies()
  expect(f.replies()).toHaveLength(1)
  expect(f.replies()[0].message).toContain("HTTP readiness verified")
  const returned = f.replies()[0]
  f.store.transition(returned.id, "running")
  f.store.publishGroupMessage(
    returned.id,
    "review-service",
    "@Worker Please review the live service URL."
  )
  f.store.settle(returned.id, "completed", null, "", undefined, true)
  f.store.advanceGroupDiscussions()
  expect(f.store.nextQueued([])?.origin.kind).toBe("discussion")
  expect(f.store.nextQueued([])?.botId).toBe(f.b.id)
  expect(() => f.store.update({ ...f.b, archived: true, expectedVersion: f.b.version })).toThrow()
  await LocalSandbox.cancelBackgroundCommandIdsAndWait([f.starts[0].id])
  expect(f.results).toHaveLength(1)
  expect(f.store.activeCommandThreads()).toEqual([])
  f.store.flushReplies()
  expect(f.replies()).toHaveLength(1)
  expect(f.store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(0)
}, 10000)

it.each([true, false])(
  "reports interruption after restart without replaying an owned command (notify=%s)",
  async (notifyOnComplete) => {
    const f = await fixture()
    f.store.acceptCommand(
      f.task.id,
      {
        id: "lost-process",
        threadId: f.task.threadId,
        command: "node existing-job",
        cwd: f.dir,
        startedAt: 1,
        notifyOnComplete
      },
      true
    )
    f.store.deferTask(f.task.id, "saved-before-restart")
    f.store.recover()
    f.store.flushReplies()
    expect(f.store.getTask(f.task.id).state).toBe("interrupted")
    expect(f.replies()).toHaveLength(1)
    expect(f.replies()[0].message).toContain("应用已重启")
    expect(f.store.activeCommandThreads()).toEqual([])
    expect(f.starts).toHaveLength(0)
    expect(f.store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(0)
    f.store.recover()
    f.store.flushReplies()
    expect(f.replies()).toHaveLength(1)
  }
)

it("honors hook-updated service notification policy and keeps native background behavior unchanged", async () => {
  const f = await fixture()
  Reflect.set(f.sandbox, "runPreToolUseHookForTool", async () => ({
    updatedInput: { notify_on_complete: true }
  }))
  await f.launch("console.log('HOOK_RESULT')", false)
  expect(f.starts[0].notifyOnComplete).not.toBe(false)
  await vi.waitFor(() => expect(f.results).toHaveLength(1), { timeout: 5000 })
  expect(f.store.continuationCommandResults(f.task.id)[0]).toMatchObject({
    exitCode: 0,
    output: expect.stringContaining("HOOK_RESULT")
  })
  Reflect.set(f.sandbox, "backgroundCommandLifecycle", {
    accepted: (start: BackgroundCommandStart) => f.starts.push(start),
    settled: (result: BackgroundCommandResult) => f.results.push(result)
  })
  Reflect.set(f.sandbox, "runPreToolUseHookForTool", async () => ({
    updatedInput: { notify_on_complete: false }
  }))
  const message = await f.launch("console.log('NATIVE_RESULT')", false)
  expect(message).toContain("completion will be delivered automatically")
  expect(f.starts[1].notifyOnComplete).not.toBe(false)
  await vi.waitFor(() => expect(f.results).toHaveLength(2), { timeout: 5000 })
})

it.each([0, 7])(
  "direct group service stays tracked, allows review, and does not spawn a cleanup turn (exit %s)",
  async (exitCode) => {
    const f = await fixture(true)
    const portFile = join(f.dir, "port")
    const response = await f.launch(
      `import http from 'node:http'; import fs from 'node:fs';
const server = http.createServer((req,res)=>{res.end('READY'); if(req.url==='/stop') server.close(()=>process.exit(${exitCode}));});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(server.address().port)));`,
      false
    )
    expect(response).toContain("health check")
    expect(response).not.toContain("completion will be delivered automatically")
    await vi.waitFor(
      async () => expect(Number(await readFile(portFile, "utf8"))).toBeGreaterThan(0),
      { timeout: 5000 }
    )
    const url = `http://127.0.0.1:${await readFile(portFile, "utf8")}`
    expect(await (await fetch(url)).text()).toBe("READY")
    expect(f.results).toHaveLength(0)
    f.store.publishGroupMessage(f.task.id, "review", "@Worker Review the running service.")
    f.store.settle(f.task.id, "completed", null, "", undefined, true)
    f.store.advanceGroupDiscussions()
    expect(f.store.nextQueued([])?.botId).toBe(f.b.id)
    expect(f.store.activeCommandThreads()).toEqual([f.task.threadId])
    // Even a nonzero exit of an explicitly silent service is persisted, not a new user task.
    await fetch(`${url}/stop`)
    await vi.waitFor(() => expect(f.results).toHaveLength(1), { timeout: 5000 })
    expect(f.results[0]).toMatchObject({ exitCode, cancelled: false })
    expect(f.store.activeCommandThreads()).toEqual([])
    f.store.settleCommand(f.results[0])
    expect(f.store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(0)
  },
  10000
)

it.each([0, 7])(
  "direct group finite jobs still notify exactly once with the real result (exit %s)",
  async (exitCode) => {
    const f = await fixture(true)
    const response = await f.launch(
      `setTimeout(()=>{ console.log('FINITE_RESULT'); process.exit(${exitCode}) },300)`
    )
    expect(response).toContain("completion will be delivered automatically")
    f.store.settle(f.task.id, "completed", null, "Waiting for the finite result")
    expect(f.store.activeCommandThreads()).toEqual([f.task.threadId])
    expect(f.store.recentTasks().filter((t) => t.origin.kind === "notification")).toHaveLength(0)
    await vi.waitFor(() => expect(f.results).toHaveLength(1), { timeout: 5000 })
    f.store.settleCommand(f.results[0])
    const notifications = f.store.recentTasks().filter((t) => t.origin.kind === "notification")
    expect(notifications).toHaveLength(1)
    expect(notifications[0].message).toContain("FINITE_RESULT")
    expect(notifications[0].origin).toMatchObject({ commandSucceeded: exitCode === 0 })
  },
  10000
)

it.each([0, 7])(
  "preserves an unread finite result across database reopen beside a live silent service (exit %s)",
  async (exitCode) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-reopen-")))
    const database = join(dir, "control.sqlite")
    let db = new NativeSqliteAdapter(new DatabaseSync(database))
    cleanups.push(async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    })
    let store = new BotStore(db)
    const create = (name: string) =>
      store.create({ name, instructions: "", modelRef: null, color: "#123456" })
    const caller = create("Caller"), worker = create("Worker")
    const root = store.enqueue({ botId: caller.id, requestId: "disk-root", message: "Verify build" })
    store.transition(root.id, "running")
    const peer = store.delegate(root.id, worker.id, "Build and check service", "disk-child")
    store.settle(root.id, "completed", null, "Waiting")
    store.transition(peer.id, "running")
    for (const [id, notifyOnComplete] of [["finite", true], ["service", false]] as const)
      store.acceptCommand(peer.id, {
        id, threadId: peer.threadId, command: "node fixture", cwd: dir,
        startedAt: 1, notifyOnComplete
      }, true)
    store.deferTask(peer.id, "saved-before-reading-result")
    const result = {
      id: "finite", threadId: peer.threadId, exitCode,
      output: "DURABLE_RESULT", cancelled: false, truncated: false
    }
    store.settleCommand(result)
    db.close()
    db = new NativeSqliteAdapter(new DatabaseSync(database))
    store = new BotStore(db)
    expect(store.continuationCommandResults(peer.id)).toEqual([
      expect.objectContaining({ task_id: "finite", exitCode, output: "DURABLE_RESULT" })
    ])
    store.recover()
    store.flushReplies()
    const replies = () => store.recentTasks().filter(t => t.requestId === `reply-${peer.id}`)
    expect(store.getTask(peer.id).state).toBe("interrupted")
    expect(replies()).toHaveLength(1)
    expect(replies()[0].message).toContain("DURABLE_RESULT")
    expect(replies()[0].message).toContain(`"exitCode":${exitCode}`)
    expect(replies()[0].message).toContain("应用已重启")
    expect(store.activeCommandThreads()).toEqual([])
    expect(store.recentTasks().filter(t => t.origin.kind === "notification")).toHaveLength(0)
    // A repeated recovery or stale callback cannot enqueue the result a second time.
    store.settleCommand(result)
    store.recover()
    store.flushReplies()
    expect(replies()).toHaveLength(1)
    expect(store.recentTasks().filter(t => t.botId === worker.id && t.state === "queued")).toHaveLength(0)
  }
)
