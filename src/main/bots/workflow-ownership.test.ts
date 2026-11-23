import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import type { WorkflowRunReference } from "../agent/workflow/run-manager"

const hosts: LocalBotHost[] = []
const databases: NativeSqliteAdapter[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  databases.splice(0).forEach((db) => db.close())
})
function fixture(outputs: string[] = []) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null })
  hosts.push(host)
  const make = (name: string) =>
    host.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = make("A"),
    b = make("B"),
    c = make("C")
  const root = host.send({ botId: a.id, requestId: "root", message: "Delegate" })
  store.transition(root.id, "running")
  const peer = store.delegate(root.id, b.id, "background", "peer", outputs)
  store.transition(peer.id, "running")
  const run: WorkflowRunReference = {
    threadId: peer.threadId,
    workspacePath: "/synthetic",
    runId: "wf-b",
    startedAt: "2026-10-31T00:00:00.001Z"
  }
  store.acceptWorkflow(peer.id, run)
  return { db, store, host, a, b, c, root, peer, run }
}

it.each([false, true])("resumes an owned workflow handoff on partial results without replay (nested=%s)", (nested) => {
  const { db, store, host, a, b, root, peer, run } = fixture()
  store.settle(root.id, "completed", null, "Delegated")
  store.settle(peer.id, "completed", null, "Workflow started")
  let notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Verify results", undefined, run.startedAt)!
  store.transition(notice.id, "running")
  if (nested) {
    const next = { ...run, runId: "wf-next", startedAt: "2026-10-31T00:01:00.000Z" }
    store.acceptWorkflow(notice.id, next)
    store.settle(notice.id, "completed", null, "More verification")
    notice = host.enqueueNotification(b.id, peer.threadId, "workflow", next.runId, "Verify next results", undefined, next.startedAt)!
    store.transition(notice.id, "running")
  }
  expect(store.peerHandoff(notice.id).owned).toBe(true)
  for (const id of ["build", "waiting-for-build"])
    store.acceptCommand(notice.id, { id, threadId: notice.threadId, command: id, cwd: "/synthetic", startedAt: 1 }, true)
  store.deferTask(notice.id, "before-results")
  expect(store.nextQueued([])).toBeNull()
  const finish = (id: string, exitCode: number) => store.settleCommand({
    id, threadId: notice.threadId, exitCode, output: id, cancelled: false, truncated: false
  })
  finish("build", 7)
  expect(store.nextQueued([])?.id).toBe(notice.id)
  expect(store.continuationCommandResults(notice.id)).toMatchObject([{ task_id: "build", exitCode: 7 }])
  store.transition(notice.id, "running")
  store.deferTask(notice.id, "failure-observed", [], ["build"])
  expect(store.nextQueued([])).toBeNull()
  expect(new BotStore(db).nextQueued([])).toBeNull()
  expect(store.recentTasks().filter(task => task.botId === a.id && task.origin.kind === "bot")).toHaveLength(0)
  finish("waiting-for-build", 0)
  expect(store.nextQueued([])?.id).toBe(notice.id)
  expect(store.continuationCommandResults(notice.id)).toHaveLength(2)
  host.cancel(notice.id)
  expect(store.nextQueued([])?.id).not.toBe(notice.id)
  expect(store.getTask(notice.id).state).toBe("cancelled")
})

it("does not retain a non-collaboration workflow notification as a peer continuation", () => {
  const { store, host, c } = fixture()
  const task = host.send({ botId: c.id, requestId: "own-workflow", message: "Run workflow" })
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic", runId: "own", startedAt: "2026-10-31T00:01:00.000Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started")
  const notice = host.enqueueNotification(c.id, task.threadId, "workflow", run.runId, "Result", undefined, run.startedAt)!
  store.transition(notice.id, "running")
  const command = { id: "ordinary", threadId: notice.threadId, command: "check", cwd: "/synthetic", startedAt: 1 }
  expect(store.peerHandoff(notice.id).owned).toBe(false)
  expect(() => store.acceptCommand(notice.id, command, true)).toThrow("协作")
  expect(() => store.acceptCommand(notice.id, command, false)).not.toThrow()
})

it.each([false, true])("blocks archive until a Bot's own workflow retires (group=%s)", (inGroup) => {
  const { store, host, a, c } = fixture()
  let task
  if (inGroup) {
    const group = host.saveGroup({ name: "Archive", memberIds: [a.id, c.id] })
    host.sendGroup({ groupId: group.id, requestId: "22222222-2222-4222-8222-222222222222", text: "Run", targetBotIds: [c.id] })
    task = store.recentTasks().find(t => t.origin.kind === "group")!
  } else task = host.send({ botId: c.id, requestId: "archive-own", message: "Run" })
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic", runId: "archive-own", startedAt: "2026-10-31T00:00:00.003Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started", undefined, true)
  const archive = () => host.update({ ...c, expectedVersion: c.version, archived: true })
  expect(archive).toThrow("后台")
  expect(host.getBot(c.id).version).toBe(c.version)
  store.suppressConversationWorkflows(task.threadId)
  expect(archive).toThrow("后台")
  host.retireWorkflow(run)
  expect(archive().archived).toBe(true)
})

it("prevents archiving a caller while its peer executes, but preserves terminal and queued archive", () => {
  const { store, host, a, c, root, peer, run } = fixture()
  store.settle(root.id, "completed", null, "Delegated")
  expect(() => host.update({ ...a, expectedVersion: a.version, archived: true })).toThrow("协作")
  store.retireWorkflow(run)
  store.settle(peer.id, "completed", null, "Peer result")
  expect(host.update({ ...a, expectedVersion: a.version, archived: true }).archived).toBe(true)
  store.flushReplies()
  expect(store.recentTasks().some(t => t.requestId.startsWith("reply-"))).toBe(false)
  const queued = host.send({ botId: c.id, requestId: "only-queued", message: "Later" })
  expect(host.update({ ...c, expectedVersion: c.version, archived: true }).archived).toBe(true)
  expect(store.getTask(queued.id).state).toBe("cancelled")
})

it.each(["private", "group", "work"] as const)("preserves the queued-peer archive boundary for %s callers", scope => {
  const { store, host, c } = fixture()
  const d = host.create({ name: "D", instructions: "", color: "#123456", modelRef: null })
  let root
  if (scope === "work") {
    root = store.createWork({ botId: c.id, operationId: "archive-queued", title: "Review", goal: "Review" }).task
  } else if (scope === "group") {
    const group = host.saveGroup({ name: "Queued", memberIds: [c.id, d.id] })
    host.sendGroup({ groupId: group.id, requestId: "33333333-3333-4333-8333-333333333333", text: "Review", targetBotIds: [c.id] })
    root = store.recentTasks().find(t => t.origin.kind === "group")!
  } else root = host.send({ botId: c.id, requestId: "archive-queued", message: "Review" })
  store.transition(root.id, "running")
  const peer = store.delegate(root.id, d.id, "Review", "queued")
  store.settle(root.id, "completed", null, "Delegated")
  const archive = () => host.update({ ...c, expectedVersion: c.version, archived: true })
  if (scope === "work") {
    expect(archive().archived).toBe(true)
    expect(store.getTask(peer.id).state).toBe("cancelled")
  } else {
    expect(archive).toThrow("关联协作")
    expect(store.getTask(peer.id).state).toBe("queued")
    expect(store.getBot(c.id).archived).toBe(false)
  }
})

it("individual task Stop cleans only its exact workflows and retains the cleanup fence", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  let releaseCleanup!: () => void
  const cleanup = vi.fn(async (runs: readonly WorkflowRunReference[]) => {
    await new Promise<void>(resolve => { releaseCleanup = resolve })
    for (const run of runs) host.retireWorkflow(run)
  })
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {}, cancelWorkflowInstances: cleanup,
    acquire: (_bot, task) => ({ release() {}, execute: async signal => {
      host.acceptWorkflow(task.id, { threadId: task.threadId, workspacePath: "/synthetic", runId: "own", startedAt: "2026-10-31T00:00:00.004Z" })
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
      return { state: "completed", result: "aborted" }
    } })
  })
  hosts.push(host)
  const bot = host.create({ name: "Stop", instructions: "", color: "#123456", modelRef: null })
  const first = host.send({ botId: bot.id, requestId: "previous", message: "Previous" })
  store.transition(first.id, "running")
  const other = { threadId: first.threadId, workspacePath: "/synthetic", runId: "unrelated", startedAt: "2026-10-31T00:00:00.001Z" }
  store.acceptWorkflow(first.id, other)
  store.settle(first.id, "completed", null)
  const task = host.send({ botId: bot.id, requestId: "cancel-own", message: "Run" })
  await vi.waitFor(() => expect(store.workflowReferences()).toHaveLength(2))
  host.cancel(task.id)
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
  expect(cleanup.mock.calls[0][0].map(run => run.runId)).toEqual(["own"])
  expect(store.workflowReferences().find(run => run.runId === "own")?.suppressed).toBe(true)
  expect(store.workflowReference(other.threadId, other.runId, other.startedAt)?.suppressed).toBe(false)
  await vi.waitFor(() => expect(store.getTask(task.id).state).toBe("cancelled"))
  expect(store.workflowReferences()).toHaveLength(2)
  releaseCleanup()
  await vi.waitFor(() => expect(store.workflowReferences().map(run => run.runId)).toEqual(["unrelated"]))
})

it("keeps a direct group's workflow stoppable until cleanup retires its exact instance", async () => {
  const { store, host, a, b } = fixture()
  const group = host.saveGroup({ name: "Workflow", memberIds: [a.id, b.id] })
  host.sendGroup({ groupId: group.id, requestId: "11111111-1111-4111-8111-111111111111", text: "Run workflow", targetBotIds: [b.id] })
  const task = store.recentTasks().find(task => task.origin.kind === "group")!
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic", runId: "group-wf", startedAt: "2026-10-31T00:00:00.002Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started", undefined, true)
  expect(host.snapshot().backgroundThreads).toContain(task.threadId)
  store.suppressConversationWorkflows(task.threadId)
  expect(host.snapshot().backgroundThreads).toContain(task.threadId)
  host.retireWorkflow(run)
  expect(host.snapshot().backgroundThreads).not.toContain(task.threadId)
})

it("retires an unacknowledged terminal workflow when its author leaves the group, preserving other scopes", async () => {
  const raw = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(raw)
  const store = new BotStore(raw)
  let finish!: () => void
  const cleanup = vi.fn(async (runs: readonly WorkflowRunReference[]) => {
    await new Promise<void>(resolve => { finish = resolve })
    for (const run of runs) host.retireWorkflow(run)
  })
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null, cancelBackground: () => {}, cancelWorkflowInstances: cleanup })
  hosts.push(host)
  const make = (name: string) => host.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = make("A"), b = make("B")
  const group = host.saveGroup({ name: "Workflow", memberIds: [a.id, b.id] })
  host.sendGroup({ groupId: group.id, requestId: "11111111-1111-4111-8111-111111111111", text: "Run", targetBotIds: [b.id] })
  const task = store.recentTasks().find(task => task.origin.kind === "group")!
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic", runId: "finished", startedAt: "2026-10-31T00:00:00.002Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started", undefined, true)
  const notice = host.enqueueNotification(b.id, task.threadId, "workflow", run.runId, "Result", group.id, run.startedAt)!
  store.transition(notice.id, "running")
  store.recordNotificationTerminal(notice.id, { outcome: "error", code: "setup_error" })
  store.settle(notice.id, "failed", "Provider unavailable")
  const other = host.send({ botId: b.id, requestId: "other", message: "Unrelated" })
  store.transition(other.id, "running")
  const otherRun = { ...run, runId: "unrelated", threadId: other.threadId }
  store.acceptWorkflow(other.id, otherRun)
  store.settle(other.id, "completed", null)
  const changed = host.saveGroup({ name: group.name, memberIds: [a.id] }, group)
  expect(store.workflowReference(run.threadId, run.runId, run.startedAt)?.suppressed).toBe(true)
  expect(() => store.beginGroupDeletion(changed.id, changed.version)).toThrow("后台")
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
  expect(cleanup.mock.calls[0][0].map(run => run.runId)).toEqual(["finished"])
  finish()
  await vi.waitFor(() => expect(store.workflowReferences(task.threadId)).toEqual([]))
  expect(store.workflowReferences(other.threadId)).toHaveLength(1)
  expect(host.enqueueNotification(b.id, task.threadId, "workflow", run.runId, "Result", group.id, run.startedAt)).toBeUndefined()
  expect(() => store.beginGroupDeletion(changed.id, changed.version)).not.toThrow()
})

it.each([false, true])("retains completed dispatch ancestry and stops only its detached workflow after both Bot turns finish (task stop=%s)", async (taskStop) => {
  const raw = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(raw)
  const store = new BotStore(raw)
  const live = new Map<string, WorkflowRunReference>()
  let child = "",
    target = ""
  const cancelBackground = vi.fn()
  const cancelWorkflowInstances = vi.fn(async (runs) => {
    for (const run of runs) {
      live.delete(run.runId)
      host.retireWorkflow(run)
    }
  })
  const host = new LocalBotHost(
    store,
    {
      onAvailable: () => () => {},
      cancelBackground,
      cancelWorkflowInstances,
      acquire: (_bot, task) => ({
        release() {},
        execute: async () => {
          if (task.requestId === "dispatch")
            child = host.delegate(task.id, target, "Run workflow", "child").id
          if (task.id === child || task.requestId === "unrelated") {
            const run = {
              threadId: task.threadId,
              workspacePath: "/synthetic",
              runId: task.requestId === "unrelated" ? "other" : "child",
              startedAt: "2026-10-31T00:00:00.001Z"
            }
            host.acceptWorkflow(task.id, run)
            live.set(run.runId, run)
          }
          return { state: "completed", result: "Accepted" }
        }
      })
    },
    Infinity
  )
  hosts.push(host)
  const make = (name: string) =>
    host.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = make("A"),
    b = make("B"),
    c = make("C")
  target = b.id
  const unrelated = host.send({
    botId: c.id,
    requestId: "unrelated",
    message: "Start independent workflow"
  })
  const root = host.send({ botId: a.id, requestId: "dispatch", message: "Delegate" })
  await vi.waitFor(() => {
    expect(child).not.toBe("")
    expect(store.getTask(child).state).toBe("completed")
    expect(store.getTask(root.id).state).toBe("completed")
    expect(store.getTask(unrelated.id).state).toBe("completed")
  })
  expect(host.snapshot().collaborationThreads).toContain(a.threadId)
  if (taskStop) host.cancel(root.id)
  else host.stopConversation(a.id)
  await vi.waitFor(() => expect(live.has("child")).toBe(false))
  expect(live.has("other")).toBe(true)
  expect(
    cancelWorkflowInstances.mock.calls.flatMap(([runs]) => runs).map((run) => run.runId)
  ).toEqual(["child"])
  if (taskStop) expect(cancelBackground).not.toHaveBeenCalled()
  else expect(cancelBackground).toHaveBeenCalledExactlyOnceWith(a.threadId)
  expect(host.snapshot().collaborationThreads).not.toContain(a.threadId)
  const count = store.recentTasks().length
  const ref = store.workflowReference(b.threadId, "child", "2026-10-31T00:00:00.001Z")!
  host.enqueueNotification(
    b.id,
    b.threadId,
    "workflow",
    ref.runId,
    "late result",
    undefined,
    ref.startedAt
  )
  expect(store.recentTasks()).toHaveLength(count)
})

it("stopping A reaches a workflow launched by C delegated from B's workflow result", () => {
  const { store, host, a, b, c, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "launched")
  store.settle(root.id, "completed", null, "waiting")
  host.enqueueNotification(
    b.id,
    peer.threadId,
    "workflow",
    run.runId,
    "summary",
    undefined,
    run.startedAt
  )
  const notice = store.recentTasks().find((task) => task.origin.kind === "notification")!
  expect(notice.origin.kind === "notification" && notice.origin.rootTaskId).toBe(root.id)
  store.transition(notice.id, "running")
  const third = store.delegate(notice.id, c.id, "continue", "third")
  expect(third.origin).toMatchObject({ rootTaskId: root.id, upstreamTaskId: notice.id, depth: 2 })
  store.transition(third.id, "running")
  const next = {
    ...run,
    threadId: third.threadId,
    runId: "wf-c",
    startedAt: "2026-10-31T00:00:00.002Z"
  }
  store.acceptWorkflow(third.id, next)
  store.settle(third.id, "completed", null, "launched again")
  store.settle(notice.id, "completed", null, "handed off")
  store.retireWorkflow(run)
  expect(store.stopConversationPeers(a.id, a.threadId).workflows.map((run) => run.runId)).toContain(
    next.runId
  )
  expect(store.taskRootCancelled(store.getTask(third.id))).toBe(true)
})

it("preserves workflow ownership and the stop fence across Store reconstruction", () => {
  const { db, store, a, b, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "launched")
  store.settle(root.id, "completed", null, "waiting")
  const recovered = new BotStore(db)
  expect(recovered.stoppableCollaborationThreads()).toContain(a.threadId)
  expect(recovered.workflowReferences()).toEqual([
    expect.objectContaining({ ...run, sourceTaskId: peer.id, suppressed: false })
  ])
  recovered.stopConversationPeers(a.id, a.threadId)
  const again = new BotStore(db)
  expect(again.workflowReference(b.threadId, run.runId, run.startedAt)?.suppressed).toBe(true)
  expect(again.getTask(root.id).state).toBe("cancelled")
  expect(() => again.beginDeletion(b.id, b.version)).toThrow("后台任务")
  again.retireWorkflow(run)
  expect(again.workflowReferences()).toEqual([])
})

it("does not let a stopped source launch a new workflow", () => {
  const { store, root, peer, run } = fixture()
  store.settle(root.id, "cancelled", "Stopped")
  expect(() => store.acceptWorkflow(peer.id, { ...run, runId: "late" })).toThrow("任务已停止")
  expect(store.workflowReferences().map((run) => run.runId)).toEqual(["wf-b"])
})

it.each(["group", "dm"] as const)(
  "keeps %s workflow notification source after a later IM message",
  async (kind) => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(db)
    const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null })
    try {
      const bot = host.create({ name: "A", instructions: "", color: "#123456", modelRef: null })
      const binding = store.imGateway.register("realm", "owner", {
        id: "binding",
        botId: bot.id,
        kind,
        label: "IM",
        state: "active",
        version: 1,
        conversationKey: "convo",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString()
      })
      store.im.importImBinding({
        id: binding.id,
        botId: bot.id,
        kind,
        label: "IM",
        channelKey: "channel",
        version: 1
      })
      store.im.setOnline(bot.id, binding.id, true)
      const incoming = (n: number) => {
        const ingress = store.imGateway.receive("realm", "owner", {
          route: {
            bindingId: "binding",
            botId: bot.id,
            kind,
            label: "IM",
            version: 1,
            senderId: "member"
          },
          event: {
            schemaVersion: 1,
            eventId: `event-${n}`,
            platformMessageId: `message-${n}`,
            principalId: "owner",
            conversationKey: "convo",
            conversationSeq: n,
            message: { type: "text", text: `request ${n}` },
            occurredAt: new Date().toISOString(),
            redelivered: false,
            lease: { id: `lease-${n}`, expiresAt: new Date(Date.now() + 900000).toISOString() }
          }
        })
        store.imGateway.settle(ingress.id, "active", undefined, Date.now() + 900000)
        const accepted = store.im.inject({
          simulation: true,
          bindingId: binding.id,
          eventId: ingress.id,
          messageId: `message-${n}`,
          senderId: "member",
          text: `request ${n}`,
          mentionsBotIds: [bot.id]
        })
        return store.getTask(accepted.taskId!)
      }
      const first = incoming(1)
      store.transition(first.id, "running")
      const run = {
        threadId: first.threadId,
        workspacePath: "/private/tmp",
        runId: "wf-first",
        startedAt: "2026-10-31T00:00:00.001Z"
      }
      store.acceptWorkflow(first.id, run)
      store.settle(first.id, "completed", null, "launched")
      const later = incoming(2)
      expect(later.threadId).toBe(first.threadId)
      store.transition(later.id, "running")
      store.settle(later.id, "completed", null, "later response")
      expect(() =>
        host.enqueueNotification(
          bot.id,
          first.threadId,
          "workflow",
          run.runId,
          "summary",
          undefined,
          run.startedAt
        )
      ).not.toThrow()
      const notice = store.recentTasks().find((t) => t.origin.kind === "notification")!
      expect(notice.mockSource?.eventId).toBe(first.mockSource!.eventId)
    } finally {
      await host.stop()
      db.close()
    }
  }
)

it("returns delegated workflow verification through B to A exactly once", () => {
  const { store, host, b, c, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "launched")
  store.settle(root.id, "completed", null, "waiting")
  host.enqueueNotification(
    b.id,
    peer.threadId,
    "workflow",
    run.runId,
    "summary",
    undefined,
    run.startedAt
  )
  const notice = store.recentTasks().find((task) => task.origin.kind === "notification")!
  store.transition(notice.id, "running")
  const third = store.delegate(notice.id, c.id, "verify", "third")
  store.transition(third.id, "running")
  store.settle(third.id, "completed", null, "C verified result")
  store.settle(notice.id, "completed", null, "handed off")
  store.flushReplies()
  const returned = store.recentTasks().find((task) => task.requestId === `reply-${third.id}`)!
  expect(returned.botId).toBe(b.id)
  expect(returned.message).toContain("C verified result")
  store.transition(returned.id, "running")
  store.settle(returned.id, "completed", null, "B integrated result")
  store.flushReplies()
  const final = store.recentTasks().filter((task) => task.requestId === `reply-${returned.id}`)
  expect(final).toHaveLength(1)
  expect(final[0].botId).toBe(root.botId)
  expect(final[0].message).toContain("B integrated result")
  store.flushReplies()
  expect(store.recentTasks().filter((task) => task.requestId === final[0].requestId)).toHaveLength(
    1
  )
})

it("does not deliver a child result after its workflow summary has been stopped", () => {
  const { store, host, b, c, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "launched")
  store.settle(root.id, "completed", null, "waiting")
  host.enqueueNotification(
    b.id,
    peer.threadId,
    "workflow",
    run.runId,
    "summary",
    undefined,
    run.startedAt
  )
  const notice = store.recentTasks().find((task) => task.origin.kind === "notification")!
  store.transition(notice.id, "running")
  const third = store.delegate(notice.id, c.id, "verify", "third")
  store.transition(third.id, "running")
  store.settle(notice.id, "cancelled", "Stopped")
  store.settle(third.id, "completed", null, "late result")
  store.flushReplies()
  expect(store.recentTasks().find((task) => task.requestId === `reply-${third.id}`)).toBeUndefined()
})

it.each(["stop", "restart"])(
  "cancels an already queued child receipt when its workflow summary ends by %s",
  (action) => {
    const { db, store, host, b, c, root, peer, run } = fixture()
    store.settle(peer.id, "completed", null, "launched")
    store.settle(root.id, "completed", null, "waiting")
    host.enqueueNotification(
      b.id,
      peer.threadId,
      "workflow",
      run.runId,
      "summary",
      undefined,
      run.startedAt
    )
    const notice = store.recentTasks().find((task) => task.origin.kind === "notification")!
    store.transition(notice.id, "running")
    const child = store.delegate(notice.id, c.id, "verify", "third")
    store.transition(child.id, "running")
    store.settle(child.id, "completed", null, "verified")
    store.flushReplies()
    const receipt = store.recentTasks().find((task) => task.requestId === `reply-${child.id}`)!
    expect(receipt.state).toBe("queued")
    const current = action === "restart" ? new BotStore(db) : store
    if (action === "restart") current.recover()
    else current.settle(notice.id, "cancelled", "Stopped")
    expect(current.getTask(receipt.id).state).toBe("cancelled")
    expect(current.nextQueued([root.threadId, c.threadId])?.id).not.toBe(receipt.id)
  }
)

function workWorkflowFixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null })
  hosts.push(host)
  const make = (name: string) => host.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = make("A"), b = make("B"), c = make("C")
  const { work, task } = store.createWork({ botId: a.id, operationId: "work", title: "Analysis", goal: "Delegate analysis" })
  store.transition(task.id, "running")
  const peer = store.delegate(task.id, b.id, "Run workflow", "work-peer")
  store.transition(peer.id, "running")
  const run = { threadId: peer.threadId, workspacePath: "/synthetic", runId: "work-wf", startedAt: "2026-10-31T01:00:00Z" }
  store.acceptWorkflow(peer.id, run)
  store.settle(peer.id, "completed", null, "Started")
  store.settle(task.id, "completed", null, "Waiting")
  store.flushReplies()
  for (const receipt of store.recentTasks().filter(t => t.state === "queued")) {
    store.transition(receipt.id, "running")
    store.settle(receipt.id, "completed", null, "Acknowledged")
  }
  return { store, host, a, b, c, work, task, peer, run }
}

it("keeps a work busy while its collaborator's workflow is running or awaiting its final receipt", async () => {
  const { store, host, a, b, work, peer, run } = workWorkflowFixture()
  expect(store.pendingWorkFamily(a.id, work.id)).toEqual([])
  expect(store.getWork(a.id, work.id).backgroundBusy).toBe(true)
  await expect(host.changeWork(a.id, work.id, store.getWork(a.id, work.id).version, "complete", "complete")).rejects.toThrow()
  expect(() => store.conversations.assertIdle(a.id, work.id)).toThrow()
  expect(() => store.beginDeletion(a.id, a.version)).toThrow()
  // Ownership guards preserve the result's execution path rather than completing the work early.
  const notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Final result", undefined, run.startedAt)!
  expect(store.nextQueued([a.threadId])?.id).toBe(notice.id)
  store.transition(notice.id, "running")
  store.settle(notice.id, "completed", null, "Final result")
  store.retireWorkflow(run)
  expect(store.getWork(a.id, work.id).backgroundBusy).toBe(false)
})

it("keeps stopped workflow cleanup busy until retirement, without blocking on unrelated workflows", async () => {
  const { store, host, a, c, work, run } = workWorkflowFixture()
  store.suppressConversationWorkflows(work.threadId, work.id)
  expect(store.getWork(a.id, work.id).backgroundBusy).toBe(true)
  expect(() => store.conversations.assertIdle(a.id, work.id)).toThrow()
  store.retireWorkflow(run)
  const other = host.send({ botId: c.id, requestId: "unrelated-workflow", message: "Other task" })
  store.transition(other.id, "running")
  store.acceptWorkflow(other.id, { ...run, threadId: other.threadId, runId: "other" })
  store.settle(other.id, "completed", null, "Started")
  expect(store.getWork(a.id, work.id).backgroundBusy).toBe(false)
  expect(() => store.conversations.assertIdle(a.id, work.id)).not.toThrow()
  expect((await host.changeWork(a.id, work.id, store.getWork(a.id, work.id).version, "complete", "complete")).state).toBe("completed")
  expect(() => store.beginDeletion(a.id, a.version)).not.toThrow()
})


it.each(["completed", "failed"] as const)("returns the direct workflow %s result to its original delegator once", (state) => {
  const { store, host, a, b, root, peer, run } = fixture(["report.md"])
  expect(store.peerHandoff(peer.id).pending).toBe(true)
  store.settle(peer.id, "completed", null, "Workflow launched")
  store.settle(root.id, "completed", null, "Waiting")
  store.flushReplies()
  expect(store.recentTasks().some(t => t.requestId === `reply-${peer.id}`)).toBe(false)
  const notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Summary", undefined, run.startedAt)!
  store.transition(notice.id, "running")
  expect(store.peerHandoff(notice.id)).toMatchObject({ owned: true, pending: false, outputFiles: ["report.md"] })
  const files = [{ name: "report.md", filePath: "/synthetic/report.md", size: 12, attachmentPath: "/synthetic/snapshot.md" }]
  store.recordPeerDelivery(notice.id, files)
  expect(store.peerHandoff(notice.id).files).toEqual(files)
  store.settle(notice.id, state, state === "failed" ? "Summary failed" : null, "Exact final result", files)
  store.flushReplies()
  const returned = store.recentTasks().filter(t => t.requestId === `reply-${notice.id}`)
  expect(returned).toHaveLength(1)
  expect(returned[0].botId).toBe(a.id)
  expect(returned[0].message).toContain("Exact final result")
  expect(returned[0].origin).toMatchObject({ expectsReply: false, rootTaskId: root.id,
    ...(state === "completed" ? { replyFiles: files } : {}) })
  store.settle(notice.id, state, null, "Exact final result", files)
  store.flushReplies()
  expect(store.recentTasks().filter(t => t.requestId === `reply-${notice.id}`)).toHaveLength(1)
})


it.each([undefined, { outcome: "success", code: "normal" }, { outcome: "error", code: "hook_halt" }, { outcome: "error", code: "cancelled" }] as const)("reports an interrupted workflow summary once without replay (prior terminal %j)", async (terminal) => {
  const { db, store, host, a, b, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "Started")
  store.settle(root.id, "completed", null, "Waiting")
  const notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Summary", undefined, run.startedAt)!
  store.transition(notice.id, "running")
  if (terminal) store.recordNotificationTerminal(notice.id, terminal)
  const recovered = new BotStore(db)
  recovered.recover()
  recovered.flushReplies()
  const receipt = recovered.recentTasks().find(t => t.requestId === `reply-${notice.id}`)
  expect(receipt).toMatchObject({ botId: a.id })
  expect(receipt!.message).toContain("中断")
  expect(recovered.notificationTerminal(notice.id)).toEqual(terminal ?? { outcome: "unknown", code: "recovery_interrupted" })
  const acquire = vi.fn(() => null)
  const acknowledgeWorkflowNotification = vi.fn(async (task) => {
    expect(task.state).toBe("interrupted")
    expect(recovered.recentTasks().some(t => t.requestId === `reply-${notice.id}`)).toBe(true)
    recovered.retireWorkflow(run)
  })
  const restarted = new LocalBotHost(recovered, { onAvailable: () => () => {}, acquire, acknowledgeWorkflowNotification })
  hosts.push(restarted)
  const dispatch = createBotNotificationDispatcher(() => ({ metadata: JSON.stringify({ botId: b.id, botHostId: "local" }) }), () => restarted)
  const result = await dispatch({ threadId: peer.threadId, kind: "workflow", key: run.runId, runStartedAt: run.startedAt })
  expect(result).toMatchObject({ acknowledged: true, terminal: terminal ?? { outcome: "unknown", code: "recovery_interrupted" } })
  expect(acknowledgeWorkflowNotification).toHaveBeenCalledTimes(1)
  expect(acquire.mock.calls.some(call => (call as unknown as [unknown, { id: string }])[1]?.id === notice.id)).toBe(false)
  recovered.recover()
  recovered.flushReplies()
  expect(recovered.recentTasks().filter(t => t.requestId === `reply-${notice.id}`)).toHaveLength(1)
  expect(recovered.recentTasks().filter(t => t.origin.kind === "notification")).toHaveLength(1)
})


it("keeps the delegator deletable only after its peer workflow cleanup retires", async () => {
  const { store, host, a, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "Launched")
  store.settle(root.id, "completed", null, "Waiting")
  const cleanup = vi.fn(async () => {})
  expect(() => host.remove(a.id, a.version, cleanup)).toThrow("协作")
  store.suppressConversationWorkflows(peer.threadId)
  expect(() => host.remove(a.id, a.version, cleanup)).toThrow("协作")
  expect(store.getBot(a.id).deleting).toBe(false)
  expect(cleanup).not.toHaveBeenCalled()
  store.retireWorkflow(run)
  await host.remove(a.id, a.version, cleanup)
  expect(cleanup).toHaveBeenCalledTimes(1)
})

it("rejects group deletion before the tombstone while a workflow still owns its member thread", async () => {
  const { store, host, a, b } = fixture()
  const group = store.saveGroup({ name: "Workflow deletion", memberIds: [a.id, b.id] })
  store.sendGroup({ groupId: group.id, requestId: "group-workflow", text: "Run", targetBotIds: [b.id] })
  const task = store.recentTasks().find(t => t.threadId === `group-${group.id}-${b.id}`)!
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic/group", runId: "group-run", startedAt: "2026-10-31T02:00:00Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started")
  const cleanup = vi.fn(async () => {})
  expect(() => host.removeGroup(group.id, group.version, cleanup)).toThrow("后台")
  expect(store.getGroup(group.id).deleting).not.toBe(true)
  expect(cleanup).not.toHaveBeenCalled()
  store.suppressConversationWorkflows(task.threadId)
  expect(() => host.removeGroup(group.id, group.version, cleanup)).toThrow("后台")
  store.retireWorkflow(run)
  await host.removeGroup(group.id, group.version, cleanup)
  expect(cleanup).toHaveBeenCalledTimes(1)
})


it("returns a withdrawn queued workflow summary privately exactly once", () => {
  const { store, host, a, b, root, peer, run } = fixture()
  store.settle(peer.id, "completed", null, "Started")
  store.settle(root.id, "completed", null, "Waiting")
  const notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Summary", undefined, run.startedAt)!
  host.cancel(notice.id)
  store.flushReplies()
  expect(store.recentTasks().filter(t => t.requestId === `reply-${notice.id}`)).toHaveLength(1)
  const receipt = store.recentTasks().find(t => t.requestId === `reply-${notice.id}`)!
  expect(receipt.botId).toBe(a.id)
  expect(receipt.message).toContain("已停止")
  host.cancel(notice.id)
  store.flushReplies()
  expect(store.recentTasks().filter(t => t.requestId === `reply-${notice.id}`)).toHaveLength(1)
})

function groupWorkflowFixture(fromPrivatePost = false) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db)
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null })
  hosts.push(host)
  const [a, b, poster] = ["Generator", "Reviewer", "Poster"].map(name => host.create({ name, instructions: "", color: "#123456", modelRef: null }))
  const group = host.saveGroup({ name: "Workflow review", memberIds: [a.id, b.id, poster.id] })
  if (fromPrivatePost) {
    const privateTask = host.send({ botId: poster.id, requestId: "post-request", message: "Ask Generator in the group" })
    store.transition(privateTask.id, "running")
    store.publishGroupMessage(privateTask.id, "post", "@Generator Generate the report, then ask Reviewer", group.id)
    store.settle(privateTask.id, "completed", null, "Posted")
    store.advanceGroupDiscussions()
  } else store.sendGroup({ groupId: group.id, requestId: "group-request", text: "Generate then ask Reviewer", targetBotIds: [a.id] })
  const task = store.recentTasks().find(t => t.botId === a.id && t.state === "queued")!
  store.transition(task.id, "running")
  const run = { threadId: task.threadId, workspacePath: "/synthetic", runId: "report", startedAt: "2026-10-31T01:00:00.000Z" }
  store.acceptWorkflow(task.id, run)
  store.settle(task.id, "completed", null, "Started", undefined, true)
  store.advanceGroupDiscussions()
  const cursor = () => db.exec("SELECT payload FROM bot_group_discussions")[0]?.values[0]?.[0]
  return { db, store, host, a, b, group, task, run, cursor }
}

it.each([false, true])("keeps the group review route until workflow completion (private post=%s)", privatePost => {
  const { store, host, a, b, group, task, run, cursor } = groupWorkflowFixture(privatePost)
  expect(cursor()).toBeDefined()
  const notice = host.enqueueNotification(a.id, task.threadId, "workflow", run.runId, "Report ready", group.id, run.startedAt)!
  store.transition(notice.id, "running")
  const before = JSON.parse(String(cursor())).posts
  store.publishGroupMessage(notice.id, "ask-review", "@Reviewer Report ready, please review it")
  expect(JSON.parse(String(cursor())).posts).toBe(before + 1)
  store.settle(notice.id, "completed", null, "", undefined, true)
  store.retireWorkflow(run)
  store.advanceGroupDiscussions()
  const reviews = store.recentTasks().filter(t => t.botId === b.id && t.state === "queued")
  expect(reviews).toHaveLength(1)
  expect(reviews[0].message).toContain("Report ready")
  store.advanceGroupDiscussions()
  expect(store.recentTasks().filter(t => t.botId === b.id && t.state === "queued")).toHaveLength(1)
})

it.each(["retired", "suppressed"])("does not keep an empty group round alive after workflow is %s", state => {
  const { store, run, task, cursor } = groupWorkflowFixture()
  expect(cursor()).toBeDefined()
  if (state === "retired") store.retireWorkflow(run)
  else store.suppressTaskWorkflows(task.id)
  store.advanceGroupDiscussions()
  expect(cursor()).toBeUndefined()
})

it("does not resurrect a stopped group round when a workflow result arrives", () => {
  const { store, host, a, group, task, run, cursor } = groupWorkflowFixture()
  store.suppressTaskWorkflows(task.id)
  store.stopGroupDiscussion(group.id)
  store.advanceGroupDiscussions()
  expect(cursor()).toBeUndefined()
  expect(host.enqueueNotification(a.id, task.threadId, "workflow", run.runId, "Late result", group.id, run.startedAt)).toBeUndefined()
  expect(store.recentTasks().filter(t => t.state === "queued")).toHaveLength(0)
})

it.each(["workflow", "command"] as const)("does not use an old %s handoff to wake a member for a newer request", kind => {
  const { store, host, a, b, group, task, run, cursor } = groupWorkflowFixture()
  if (kind === "command") {
    store.retireWorkflow(run)
    // Use a separate live old-request turn for command acceptance.
    const old = store.enqueue({ botId: a.id, requestId: "old-command", message: "Run" }, task.origin)
    store.transition(old.id, "running")
    store.acceptCommand(old.id, { id: "old-job", threadId: old.threadId, command: "generate", cwd: "/synthetic", startedAt: 1 })
    store.settle(old.id, "completed", null, "Started", undefined, true)
  }
  store.sendGroup({ groupId: group.id, requestId: "new-request", text: "Generator only, different task", targetBotIds: [a.id] })
  const newer = store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "new-request")!
  store.transition(newer.id, "running")
  // Keep the new request active while the old result arrives, so the assertion
  // checks source filtering as well as not holding an otherwise finished round.
  const notice = kind === "workflow"
    ? host.enqueueNotification(a.id, task.threadId, "workflow", run.runId, "Old report", group.id, run.startedAt)!
    : (store.settleCommand({ id: "old-job", threadId: task.threadId, exitCode: 0, output: "Old report", cancelled: false, truncated: false }),
       store.recentTasks().find(t => t.origin.kind === "notification" && t.origin.notificationKind === "command")!)
  store.settle(newer.id, "completed", null, "New request done", undefined, true)
  store.transition(notice.id, "running")
  store.publishGroupMessage(notice.id, "late-review", "@Reviewer Review the OLD report")
  expect(JSON.parse(String(cursor())).posts).toBe(0)
  store.settle(notice.id, "completed", null, "", undefined, true)
  if (kind === "workflow") store.retireWorkflow(run)
  store.advanceGroupDiscussions()
  expect(store.recentTasks().filter(t => t.botId === b.id && t.state === "queued")).toHaveLength(0)
  expect(cursor()).toBeUndefined()
  expect(store.groupMessages(group.id).some(m => m.text.includes("OLD report"))).toBe(true)
})

it("keeps a private workflow integration linked to its handoff after normal history pruning", () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  try {
    const { store, host, a, b, root, peer, run } = fixture()
    store.settle(root.id, "completed", null, "Waiting")
    store.settle(peer.id, "completed", null, "Started workflow")
    const notice = host.enqueueNotification(b.id, peer.threadId, "workflow", run.runId, "Review result", undefined, run.startedAt)!
    store.transition(notice.id, "running")
    store.settle(notice.id, "completed", null, "WORKFLOW_FINAL")
    host.retireWorkflow(run)
    store.flushReplies()
    const reply = store.recentTasks().find(t => t.requestId === `reply-${notice.id}`)!
    store.transition(reply.id, "running")
    store.settle(reply.id, "completed", null, "Delivered")
    expect(store.exchange(a.id, peer.id).reply?.message).toBe("WORKFLOW_FINAL")
    vi.setSystemTime(Date.now() + 31 * 86400000)
    for (let i = 0; i < 105; i++) {
      const tail = store.enqueue({ botId: a.id, requestId: `exchange-tail-${i}`, message: "Unrelated" })
      store.transition(tail.id, "running")
      store.settle(tail.id, "completed", null, "Done")
    }
    while (store.pruneTaskHistory()) { /* normal bounded pruning */ }
    expect(() => store.getTask(notice.id)).toThrow()
    expect(store.exchange(a.id, peer.id).reply).toMatchObject({ message: "WORKFLOW_FINAL", delivered: true })
    expect(store.exchangeHistory(a.id, peer.id).items.find(item => item.taskId === peer.id)?.reply?.message)
      .toBe("WORKFLOW_FINAL")
  } finally { vi.useRealTimers() }
})
