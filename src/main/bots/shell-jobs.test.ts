import { afterEach, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotShellJobs } from "./shell-jobs"
import { BotShellProcess } from "./shell-process"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { botBackgroundResultsQueue } from "./background-results"
import { listBotAsyncTasks } from "./async-tasks"
import { createBotAPI } from "./rpc"
import { BotHost } from "./host"
import { withBotProjectMutation } from "./project-lock"
import { BOT_SCHEMA_VERSION } from "./schema"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function fixture(runner = new BotShellProcess()) {
  const root = mkdtempSync(join(tmpdir(), "cmb-shell-jobs-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite"),
    store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Builder" })
  store.send({ nonce: "task", conversationId, text: "Build" })
  const parent = store.claim("host", 60000)!,
    controller = new AbortController()
  cleanup.push(() => controller.abort())
  const request = {
    ...parent,
    store,
    bot,
    signal: controller.signal,
    messages: store.messagesForRun(parent.run.id)
  }
  const manager = new BotShellJobs(request, runner)
  cleanup.push(() => manager.close())
  const action = { shell: { command: "node verify.cjs" } }
  const reserve = (invocation = "cmd") => {
    const value = { ...action, invocation }
    const approval = store.requestInteraction(parent.lease, {
      kind: "approval",
      prompt: "Build",
      action: value
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    return store.toolOnce(parent.lease, invocation, value, () => {
      store.beginEffect(parent.lease, {
        id: `effect:${invocation}`,
        action: value,
        approvalId: approval.id
      })
      return store.shellJobs.reserve(
        parent.lease,
        invocation,
        `effect:${invocation}`,
        "node verify.cjs"
      )
    })
  }
  const address = (jobId: string) => ({ runId: parent.run.id, conversationId, jobId })
  const take = {
    threadId: parent.run.id,
    ownerRunToken: `${parent.lease.owner}:${parent.lease.fence}`,
    appliedIds: [] as string[],
    phase: "afterModel" as const
  }
  return {
    root,
    path,
    store,
    parent,
    request,
    reserve,
    address,
    take,
    manager,
    controller,
    bot,
    conversationId
  }
}

it("keeps one durable job, bounded paginated output and actual nonzero exit status while another action awaits approval", async () => {
  const f = fixture(),
    id = f.reserve()
  f.store.shellJobs.start(f.parent.lease, id)
  const approval = f.store.requestInteraction(f.parent.lease, {
    kind: "approval",
    prompt: "Another action",
    action: { next: 1 }
  })
  f.store.shellJobs.progress(f.parent.lease, id, { output: "a".repeat(300000), truncated: false })
  f.store.shellJobs.finish(f.parent.lease, id, {
    output: "a".repeat(300000),
    exitCode: 7,
    truncated: false
  })
  expect(f.store.getRun(f.parent.run.id).status).toBe("waiting_input")
  const view = f.store.shellJobs.read(f.address(id))
  expect(view).toMatchObject({ status: "failed", exitCode: 7, nextOffset: 16000, truncated: true })
  expect(view.output).toHaveLength(16000)
  expect(f.store.shellJobs.get(f.parent.run.id, id).output).toHaveLength(262144)
  expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "succeeded" }])
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "reject" })
  const queue = botBackgroundResultsQueue(f.request, f.store.steering.queue(f.parent.lease), [
    f.manager
  ])
  const messages = await queue.take(f.take)
  expect(messages).toHaveLength(1)
  expect(String(messages[0].content)).toContain('"exitCode":7')
  expect((await queue.take(f.take))[0].id).toBe(messages[0].id)
  expect(await queue.take({ ...f.take, appliedIds: [messages[0].id!] })).toEqual([])
  expect(
    f.store.runHistory({ runId: f.parent.run.id, conversationId: f.conversationId }).shellJobs
  ).toMatchObject([{ id, status: "failed" }])
})

it("does not hide a completed command behind an unrelated active workflow", async () => {
  const f = fixture(),
    id = f.reserve()
  f.store.shellJobs.finish(f.parent.lease, id, { output: "done", exitCode: 0, truncated: false })
  const busy = {
    assertHealthy() {
      /* Independent source remains healthy. */
    },
    activeCount: () => 1,
    results: () => []
  }
  const queue = botBackgroundResultsQueue(f.request, f.store.steering.queue(f.parent.lease), [
    busy,
    f.manager
  ])
  const result = await Promise.race([queue.take(f.take), delay(500).then(() => "timeout")])
  expect(result).not.toBe("timeout")
  if (typeof result === "string") throw new Error("后台结果未及时交付")
  expect(String(result[0].content)).toContain("done")
})

it("scopes RPC reads/stops, retries the same stop receipt and rejects stale revisions and restore epochs", async () => {
  const f = fixture(),
    id = f.reserve(),
    api = createBotAPI(new BotHost(f.store))
  f.store.shellJobs.start(f.parent.lease, id)
  const original = await api.shellJob(f.address(id))
  const input = {
    ...f.address(id),
    nonce: randomUUID(),
    revision: original.revision,
    dataEpoch: "initial"
  }
  const stopped = await api.stopShellJob(input)
  expect(stopped.status).toBe("cancelling")
  expect(await api.stopShellJob(input)).toEqual(stopped)
  await expect(api.stopShellJob({ ...input, nonce: randomUUID() })).rejects.toMatchObject({
    code: "revision_conflict"
  })
  await expect(api.stopShellJob({ ...input, dataEpoch: "restored" })).rejects.toMatchObject({
    code: "data_epoch"
  })
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  expect(listBotAsyncTasks(f.store, { botId: other.bot.id }).items).toEqual([])
  expect(listBotAsyncTasks(f.store, { botId: f.bot.id }).items[0]).toMatchObject({
    kind: "shell",
    jobId: id,
    status: "cancelling"
  })
  await expect(
    api.shellJob({ ...f.address(id), conversationId: other.conversationId })
  ).rejects.toMatchObject({ code: "run_scope" })
  await expect(api.shellJob({ ...f.address(id), jobId: randomUUID() })).rejects.toMatchObject({
    code: "shell_job_scope"
  })
  await expect(
    api.shellJob({ ...f.address(id), includeSecrets: true } as never)
  ).rejects.toMatchObject({ code: "invalid_input" })
})

it("fences jobs after Host loss, retains output after reopening and never restarts a recorded command", () => {
  const f = fixture(),
    id = f.reserve()
  f.store.shellJobs.start(f.parent.lease, id)
  f.store.shellJobs.progress(f.parent.lease, id, { output: "before crash", truncated: false })
  expect(() => f.manager.restore()).toThrow("遗留执行记录")
  f.store.recoverAbandonedAtStartup()
  expect(() =>
    f.store.shellJobs.progress(f.parent.lease, id, { output: "late", truncated: false })
  ).toThrow("执行权已失效")
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.shellJobs.read(f.address(id))).toMatchObject({
    output: "before crash",
    status: "needs_review"
  })
  expect(next.effects(f.parent.run.id)).toMatchObject([{ status: "unknown" }])
  expect(next.getRun(f.parent.run.id).status).toBe("needs_review")
})

it("cancels queued commands promptly without releasing the active project mutation lock", async () => {
  const f = fixture(await createTrustedBotShellTestRunner(cleanup)),
    id = f.reserve()
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  cleanup.push(release)
  const owner = withBotProjectMutation(f.root, () => hold)
  f.manager.start(
    id,
    {
      command: "must-never-execute",
      cwd: f.root,
      timeoutMs: 1000,
      runId: f.parent.run.id,
      background: true,
      execution: { windowsSandbox: "none", resourceDirectory: f.root }
    },
    async () => {
      throw new Error("must not reach dispatch")
    }
  )
  const result = await Promise.race([
    f.manager.close().then(() => "closed"),
    delay(1000).then(() => "timeout")
  ])
  expect(result).toBe("closed")
  expect(f.store.shellJobs.read(f.address(id)).status).toBe("cancelled")
  expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "succeeded" }])
  let next = false
  const waiting = withBotProjectMutation(f.root, async () => {
    next = true
  })
  await delay(20)
  expect(next).toBe(false)
  release()
  await owner
  await waiting
  expect(next).toBe(true)
})

it("upgrades v29 with a backup and leaves prior records intact", () => {
  const f = fixture(),
    before = f.store.getRun(f.parent.run.id)
  f.store.db.run("DROP TABLE bot_shell_jobs")
  f.store.db.run("UPDATE bot_schema SET version=29")
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.getRun(before.id)).toEqual(before)
  expect(next.shellJobs.list(before.id)).toEqual([])
  expect(next.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  expect(readdirSync(join(f.root, "backups")).some((name) => name.startsWith("bots-v29-"))).toBe(
    true
  )
})

it("reuses the original dispatch receipt and rolls back capacity rejection without disturbing accepted jobs", () => {
  const f = fixture(),
    first = f.reserve("first")
  expect(f.reserve("first")).toBe(first)
  for (const name of ["second", "third", "fourth"]) f.reserve(name)
  expect(() => f.reserve("fifth")).toThrow("达到并发")
  expect(f.store.shellJobs.list(f.parent.run.id)).toHaveLength(4)
  expect(f.store.effects(f.parent.run.id)).toHaveLength(4)
  expect(f.store.getRun(f.parent.run.id).status).toBe("running")
  expect(() => f.store.shellJobs.start(f.parent.lease, first)).not.toThrow()
  expect(() => f.store.shellJobs.start(f.parent.lease, first)).toThrow("禁止重复执行")
})

it("returns genuine readonly Store scope after restoration without relabelling the original stop receipt", () => {
  const f = fixture(),
    id = f.reserve(),
    address = f.address(id)
  f.store.shellJobs.start(f.parent.lease, id)
  const initial = f.store.shellJobs.read(address),
    input = { ...address, nonce: randomUUID(), dataEpoch: "initial", revision: initial.revision }
  expect(initial.dataEpoch).toBe("initial")
  const receipt = f.store.shellJobs.stop(input)
  expect(receipt).toMatchObject({ dataEpoch: "initial", status: "cancelling" })
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',1)"
  )
  const before = f.store.events()
  expect(f.store.shellJobs.read(address)).toMatchObject({
    dataEpoch: "replacement",
    status: "cancelling"
  })
  expect(() => f.store.shellJobs.stop(input)).toThrow("数据已恢复")
  expect(receipt.dataEpoch).toBe("initial")
  expect(f.store.events()).toEqual(before)
})
