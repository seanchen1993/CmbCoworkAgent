import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotShellJobs } from "./shell-jobs"
import { BotShellProcess } from "./shell-process"
import { listBotAsyncTasks } from "./async-tasks"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-shell-services-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  let now = 1_000_000
  const path = join(directory, "bots.sqlite"),
    store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  store.bindLeaseGuard("host", () => {})
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Service" })
  store.send({ nonce: "task", conversationId, text: "Start server" })
  const parent = store.claim("host")!
  const reserve = (name = "server", persistent = true) => {
    const action = { shell: { command: name, keepAlive: persistent } }
    const approval = store.requestInteraction(parent.lease, {
      kind: "approval",
      prompt: name,
      action
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    return store.toolOnce(parent.lease, name, action, () => {
      store.beginEffect(parent.lease, { id: `service:${name}`, action, approvalId: approval.id })
      const jobId = store.shellJobs.reserve(parent.lease, name, `service:${name}`, name)
      return {
        jobId,
        service: persistent ? store.shellServices.attach(parent.lease, jobId, 60000) : undefined
      }
    })
  }
  return {
    directory,
    path,
    store,
    bot,
    conversationId,
    parent,
    reserve,
    advance: (ms: number) => {
      now += ms
    },
    address: (jobId: string) => ({ conversationId, runId: parent.run.id, jobId })
  }
}

it("finishes the model turn without claiming service success and rejects renewal after losing its independent lease", async () => {
  const f = fixture(),
    { jobId, service } = f.reserve()
  f.store.shellJobs.start(f.parent.lease, jobId)
  const request = {
    ...f.parent,
    store: f.store,
    bot: f.bot,
    messages: [],
    signal: new AbortController().signal
  }
  const manager = new BotShellJobs(request, new BotShellProcess())
  expect(() => manager.restore()).not.toThrow()
  expect(manager.activeCount()).toBe(0)
  expect(f.store.finish(f.parent.lease, "succeeded", "Server launched").status).toBe("succeeded")
  expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "started" }])
  expect(listBotAsyncTasks(f.store, { botId: f.bot.id }).items).toMatchObject([
    { jobId, status: "running" }
  ])
  f.advance(31000)
  // A late supervisor cannot renew a lost service, even after its model turn finished.
  expect(() => f.store.shellServices.renew(service!)).toThrow("执行权已失效")
})

it("settles a service under its independent lease and delivers one durable completion without replay", () => {
  const f = fixture(),
    { jobId, service } = f.reserve()
  f.store.shellJobs.start(f.parent.lease, jobId)
  f.store.finish(f.parent.lease, "succeeded", "Started")
  f.advance(20000)
  f.store.shellServices.renew(service!)
  f.advance(20000)
  f.store.shellServices.progress(service!, { output: "READY", truncated: false })
  f.store.shellServices.finish(service!, {
    output: "Server finished",
    exitCode: 7,
    truncated: false
  })
  expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "succeeded" }])
  expect(f.store.shellJobs.read(f.address(jobId))).toMatchObject({
    keepAlive: true,
    status: "failed",
    exitCode: 7
  })
  expect(() =>
    f.store.shellServices.finish(service!, { output: "duplicate", exitCode: 0, truncated: false })
  ).toThrow("执行权已失效")
  const next = f.store.claim("host")!
  expect(next.run).toMatchObject({
    botId: f.bot.id,
    conversationId: f.conversationId,
    source: "shell-service"
  })
  expect(JSON.stringify(f.store.messagesForRun(next.run.id))).toContain("Server finished")
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE source='shell-service'")[0].values[0][0]
  ).toBe(1)
})

it.each(["startup", "expiry", "clock"] as const)(
  "retains orphaned output and requires review after %s instead of recreating a server",
  (kind) => {
    const f = fixture(),
      { jobId, service } = f.reserve()
    f.store.shellJobs.start(f.parent.lease, jobId)
    f.store.shellServices.progress(service!, { output: "BEFORE_LOSS", truncated: false })
    f.store.finish(f.parent.lease, "succeeded", "Started")
    if (kind === "startup") f.store.recoverAbandonedAtStartup()
    else if (kind === "expiry") {
      f.advance(31000)
      f.store.recoverExpired()
    } else f.store.fenceOwner("host", "Clock lost")
    expect(f.store.getRun(f.parent.run.id).status).toBe("needs_review")
    expect(f.store.shellJobs.read(f.address(jobId))).toMatchObject({
      output: "BEFORE_LOSS",
      status: "needs_review"
    })
    expect(f.store.effects(f.parent.run.id)).toMatchObject([{ status: "unknown" }])
    expect(() =>
      f.store.shellServices.progress(service!, { output: "LATE", truncated: false })
    ).toThrow("执行权已失效")
    f.store.send({ nonce: "next", conversationId: f.conversationId, text: "Next" })
    expect(f.store.claim("host")).toBeNull()
    const count = f.store.db.exec("SELECT COUNT(*) FROM bot_messages")[0].values[0][0]
    f.store.recoverAbandonedAtStartup()
    expect(f.store.db.exec("SELECT COUNT(*) FROM bot_messages")[0].values[0][0]).toBe(count)
  }
)

it("allows historical service control only for the owning Bot and exact branch, and blocks configuration changes while live", () => {
  const f = fixture(),
    { jobId } = f.reserve()
  f.store.shellJobs.start(f.parent.lease, jobId)
  f.store.finish(f.parent.lease, "succeeded", "Started")
  expect(() =>
    f.store.updateBot({ id: f.bot.id, revision: f.bot.revision, workspacePath: "/changed" })
  ).toThrow("请先停止")
  expect(() => f.store.deleteBot(f.bot.id, f.bot.revision)).toThrow("请先停止")
  f.store.send({ nonce: "next", conversationId: f.conversationId, text: "Check server" })
  const next = f.store.claim("host")!
  expect(f.store.shellServices.address(next.run.id, jobId)).toEqual({
    ...f.address(jobId),
    threadRootId: undefined
  })
  expect(f.store.shellServices.list(next.run.id)).toMatchObject([
    { task_id: jobId, status: "running" }
  ])
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  f.store.send({ nonce: "other-run", conversationId: other.conversationId, text: "Other" })
  const unrelated = f.store.claim("host")!
  expect(() => f.store.shellServices.address(unrelated.run.id, jobId)).toThrow(
    "当前 Bot 或对话分支"
  )
  expect(f.store.shellServices.list(unrelated.run.id)).toEqual([])
  f.store.finish(next.lease, "succeeded", "Checked")
  const branch = f.store.send({
    nonce: "branch",
    conversationId: f.conversationId,
    threadRootId: f.parent.run.messageId,
    text: "Unrelated branch"
  })
  const scoped = f.store.claim("host")!
  expect(scoped.run.id).toBe(branch.runIds[0])
  expect(() => f.store.shellServices.address(scoped.run.id, jobId)).toThrow("对话分支")
  expect(f.store.shellServices.list(scoped.run.id)).toEqual([])
  const stopped = f.store.shellJobs.stop({
    ...f.address(jobId),
    revision: f.store.shellJobs.read(f.address(jobId)).revision,
    dataEpoch: "initial",
    nonce: crypto.randomUUID()
  })
  expect(stopped.status).toBe("cancelling")
})

it("does not exempt ordinary background commands or unstarted services from pending effect review", () => {
  const f = fixture(),
    { jobId } = f.reserve("finite", false)
  f.store.shellJobs.start(f.parent.lease, jobId)
  expect(f.store.finish(f.parent.lease, "succeeded", "Invalid completion").status).toBe(
    "needs_review"
  )
  const second = fixture()
  second.reserve()
  expect(second.store.finish(second.parent.lease, "succeeded", "Unstarted").status).toBe(
    "needs_review"
  )
})

it("adds service ownership to v30 without adopting or changing existing job records", () => {
  const f = fixture(),
    { jobId } = f.reserve("finite", false)
  f.store.db.run("DROP TABLE bot_shell_services")
  f.store.db.run("UPDATE bot_schema SET version=30")
  f.store.close()
  const next = new BotStore(f.path)
  cleanup.push(() => next.close())
  expect(next.shellServices.isService(jobId)).toBe(false)
  expect(next.shellJobs.read(f.address(jobId)).status).toBe("queued")
  expect(
    readdirSync(join(f.directory, "backups")).some((name) => name.startsWith("bots-v30-"))
  ).toBe(true)
})

it("drains a later turn's already-started operation before promoting an older interrupted service to review", () => {
  const f = fixture(),
    { jobId, service } = f.reserve()
  f.store.shellJobs.start(f.parent.lease, jobId)
  f.store.finish(f.parent.lease, "succeeded", "Started")
  f.store.send({ nonce: "next", conversationId: f.conversationId, text: "Another operation" })
  const next = f.store.claim("host")!
  const action = { change: "approved write" }
  const approval = f.store.requestInteraction(next.lease, {
    kind: "approval",
    prompt: "Write",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(next.lease, { id: "other-effect", action, approvalId: approval.id })
  f.store.shellServices.finish(service!, {
    output: "Interrupted",
    exitCode: null,
    truncated: false
  })
  expect(f.store.getRun(f.parent.run.id).status).toBe("succeeded")
  expect(f.store.shellJobs.read(f.address(jobId)).status).toBe("needs_review")
  expect(() => f.store.assertDispatch(next.lease)).toThrow("中断的后台服务")
  f.store.settleEffect(next.lease, "other-effect", "succeeded", "Actual receipt")
  f.store.finish(next.lease, "failed", "Stopped after service interruption")
  expect(f.store.claim("host")).toBeNull()
  f.store.recoverExpired()
  expect(f.store.getRun(f.parent.run.id).status).toBe("needs_review")
  const review = f.store.getRun(f.parent.run.id)
  let draining = true
  f.store.bindServiceActivity("host", () => draining)
  expect(() =>
    f.store.recover({
      id: review.id,
      revision: review.revision,
      decision: "cancel",
      note: "核对现场",
      effects: [{ id: "service:server", outcome: "succeeded", note: "已确认服务停止" }]
    })
  ).toThrow("仍在停止")
  draining = false
  f.store.recover({
    id: review.id,
    revision: review.revision,
    decision: "cancel",
    note: "核对现场",
    effects: [{ id: `service:server`, outcome: "succeeded", note: "已确认服务停止" }]
  })
  expect(f.store.shellServices.unresolved(f.bot.id)).toBe(false)
  expect(f.store.shellJobs.read(f.address(jobId))).toMatchObject({
    status: "needs_review",
    reviewed: true,
    output: "Interrupted"
  })
  expect(listBotAsyncTasks(f.store, { botId: f.bot.id }).items).toEqual([])
})
