import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, getLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { approvalDecisionBroker } from "../agent/approval-decision-broker"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { getPendingUserInputForThread, requestUserInput, submitUserInputResponse } from "../services/user-input"
import type { BotTask } from "../../shared/bots/contracts"
import { LocalBotHost } from "./host"
import { BotStore } from "./store"
import { botWorkApprovals } from "./work-approvals"
import { botImScopeId } from "./im-gateway-store"

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const active = new Map<string, {
    signal: AbortSignal
    waiting(active: boolean): void
    finish(): void
    approvalRequestIds: Set<string>
  }>()
  const registered = new Set<string>()
  const unsubscribeApprovals = vi.fn()
  const host = new LocalBotHost(store, {
    ...botWorkApprovals,
    subscribeApprovalChanges(listener) {
      const unsubscribe = botWorkApprovals.subscribeApprovalChanges(listener)
      return () => {
        unsubscribe()
        unsubscribeApprovals()
      }
    },
    acquire(_bot, task) {
      if (!claimLocalThreadRunLease({ threadId: task.threadId, runId: task.id, owner: "bot" }).acquired) return null
      const approvalRequestIds = new Set<string>()
      return {
        approvalRequestIds,
        execute(signal, waiting) {
          return new Promise((resolve) => {
            const finish = () => {
              signal.removeEventListener("abort", finish)
              resolve({ state: "completed" })
            }
            signal.addEventListener("abort", finish, { once: true })
            active.set(task.id, { signal, waiting, finish, approvalRequestIds })
          })
        },
        release() { releaseLocalThreadRunLease(task.threadId, "bot", task.id) }
      }
    },
    onAvailable: () => () => {},
    pendingUserInput(task) {
      return getLocalThreadRunLease(task.threadId)?.runId === task.id
        ? getPendingUserInputForThread(task.threadId)
        : null
    },
    answerUserInput: submitUserInputResponse
  }, Number.POSITIVE_INFINITY)
  cleanups.push(async () => {
    await host.stop()
    for (const id of registered) approvalDecisionBroker.unregister(id)
    db.close()
  })
  const bot = (name: string) => host.create({ name, instructions: "", color: "#123456", modelRef: null })
  const ask = (task: BotTask, text: string) => {
    const run = active.get(task.id)!
    run.waiting(true)
    const result = requestUserInput({ threadId: task.threadId, questions: [
      { id: "choice", header: "Choice", question: text, options: [] }
    ], abortSignal: run.signal, allowDeferredRenderer: true }).finally(() => run.waiting(false))
    void result.catch(() => {})
    return { request: getPendingUserInputForThread(task.threadId)!, result }
  }
  const waitForRun = (task: BotTask) => vi.waitFor(() => expect(active.has(task.id)).toBe(true))
  const waitForReply = async (task: BotTask) => {
    let reply: BotTask | undefined
    await vi.waitFor(() => {
      reply = host.snapshot().tasks.find(candidate => candidate.requestId === `reply-${task.id}`)
      expect(reply).toBeDefined()
    })
    await waitForRun(reply!)
    return reply!
  }
  const startNestedReturn = async () => {
    const owner = bot("Owner"), peer = bot("Peer"), reviewer = bot("Reviewer")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const handoff = host.delegate(task.id, peer.id, "Integrate the review", "first")
    await waitForRun(handoff)
    const review = host.delegate(handoff.id, reviewer.id, "Check the source", "second")
    await waitForRun(review)
    active.get(task.id)!.finish()
    active.get(handoff.id)!.finish()
    active.get(review.id)!.finish()
    const reply = await waitForReply(review)
    expect(reply).toMatchObject({ botId: peer.id, threadId: peer.threadId,
      origin: { kind: "bot", expectsReply: false, upstreamTaskId: handoff.id, rootTaskId: task.id, rootWorkId: work.id } })
    return { owner, peer, work, handoff, reply }
  }
  const approval = (task: BotTask, id: string, runtimeThreadId = task.threadId, captured = true) => {
    const run = active.get(task.id)!
    if (captured) {
      run.approvalRequestIds.add(id)
      run.waiting(true)
    }
    const resolve = vi.fn()
    return {
      register() {
        approvalDecisionBroker.register({
          threadId: task.threadId, runtimeThreadId, resolve,
          request: {
            id, safety_level: "needs_approval", operation: "execute", command: "private command", cwd: "/fixture",
            tool_call: { id, name: "execute", args: {} },
            allowed_decisions: ["reject"], allowed_approval_types: ["reject"]
          }
        })
        registered.add(id)
        run.signal.addEventListener("abort", () => approvalDecisionBroker.unregister(id), { once: true })
      },
      endWait() {
        if (!captured) return
        run.approvalRequestIds.delete(id)
        run.waiting(false)
      },
      resolve
    }
  }
  return { bot, host, store, active, ask, waitForRun, waitForReply, startNestedReturn, approval, unsubscribeApprovals }
}

describe("desktop work questions", () => {
  it("shows and answers the exact peer question from the original work after its dispatcher completes", async () => {
    const { host, store, bot, active, ask, waitForRun } = fixture()
    const owner = bot("Owner"), peer = bot("Peer"), unrelated = bot("Unrelated")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const delegated = host.delegate(task.id, peer.id, "Review the report", "peer-review")
    const privateTask = host.send({ botId: unrelated.id, requestId: "private", message: "Private request" })
    active.get(task.id)!.finish()
    await waitForRun(delegated)
    await waitForRun(privateTask)
    const question = ask(delegated, "Use the revised report?")
    const other = ask(privateTask, "Private question")
    expect(store.getTask(task.id).state).toBe("completed")
    expect(host.pendingWorkQuestions(owner.id)).toEqual([{
      kind: "question", workId: work.id, workTitle: "Report", askedBy: "Peer", taskId: delegated.id, request: question.request
    }])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
    expect(host.pendingWorkQuestions(unrelated.id)).toEqual([])
    expect(() => host.answerWorkQuestion(peer.id, delegated.id, { requestId: question.request.requestId, answers: {} })).toThrow("失效")
    expect(() => host.answerWorkQuestion(owner.id, privateTask.id, { requestId: other.request.requestId, answers: {} })).toThrow("失效")
    const response = { requestId: question.request.requestId, answers: {
      choice: { type: "other" as const, questionId: "choice", text: "Use the revised version" }
    } }
    host.answerWorkQuestion(owner.id, delegated.id, response)
    await expect(question.result).resolves.toMatchObject(response)
    expect(getPendingUserInputForThread(privateTask.threadId)).toEqual(other.request)
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(() => host.answerWorkQuestion(owner.id, delegated.id, response)).toThrow("失效")
    const replacement = ask(delegated, "Use a PDF too?")
    expect(replacement.request.requestId).not.toBe(response.requestId)
    expect(() => host.answerWorkQuestion(owner.id, delegated.id, response)).toThrow("失效")
    expect(host.pendingWorkQuestions(owner.id)[0]).toMatchObject({ kind: "question", request: replacement.request })
    const nativeResponse = { requestId: replacement.request.requestId, answers: {}, ignored: true }
    expect(submitUserInputResponse(nativeResponse)).toBe(true)
    await expect(replacement.result).resolves.toMatchObject(nativeResponse)
    expect(() => host.answerWorkQuestion(owner.id, delegated.id, nativeResponse)).toThrow("失效")
  })

  it("keeps direct work questions in scope and removes a cancelled collaboration request", async () => {
    const { host, bot, ask, waitForRun } = fixture()
    const owner = bot("Owner"), peer = bot("Peer")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const delegated = host.delegate(task.id, peer.id, "Review", "peer-review")
    await waitForRun(delegated)
    const direct = ask(task, "Which report?")
    const question = ask(delegated, "Need a source?")
    expect(host.pendingWorkQuestions(owner.id).map((item) => item.kind === "question" ? item.request.requestId : item.requestId))
      .toEqual([direct.request.requestId, question.request.requestId])
    host.cancel(delegated.id)
    await expect(question.result).rejects.toThrow("cancelled")
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ kind: "question", request: direct.request }])
    expect(() => host.answerWorkQuestion(owner.id, delegated.id, { requestId: question.request.requestId, answers: {} })).toThrow("失效")
    await host.stopConversation(owner.id, undefined, work.id)
    await expect(direct.result).rejects.toThrow("cancelled")
  })

  it("keeps a nested peer's answer on the original work rather than the intermediate Bot's private chat", async () => {
    const { host, bot, ask, waitForRun } = fixture()
    const owner = bot("Owner"), first = bot("First"), second = bot("Second")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const parent = host.delegate(task.id, first.id, "Review", "first")
    await waitForRun(parent)
    const delegated = host.delegate(parent.id, second.id, "Check the source", "second")
    await waitForRun(delegated)
    const question = ask(delegated, "Which source should I check?")
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ workId: work.id, taskId: delegated.id, askedBy: "Second" }])
    expect(host.pendingWorkQuestions(first.id)).toEqual([])
    expect(host.pendingWorkQuestions(second.id)).toEqual([])
    const response = { requestId: question.request.requestId, answers: {}, ignored: true }
    host.answerWorkQuestion(owner.id, delegated.id, response)
    await expect(question.result).resolves.toMatchObject(response)
  })
})

describe("desktop work interactions on peer return turns", () => {
  it("answers the current question from the original work when the intermediate peer integrates the result", async () => {
    const { host, active, ask, waitForRun, startNestedReturn } = fixture()
    const { owner, peer, work, handoff, reply } = await startNestedReturn()
    const question = ask(reply, "Use the verified source in the report?")
    expect(host.pendingWorkQuestions(owner.id)).toEqual([{
      kind: "question", workId: work.id, workTitle: "Report", askedBy: "Peer", taskId: reply.id, request: question.request
    }])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
    const response = { requestId: question.request.requestId, answers: {}, ignored: true }
    expect(() => host.answerWorkQuestion(owner.id, handoff.id, response)).toThrow("失效")
    host.answerWorkQuestion(owner.id, reply.id, response)
    await expect(question.result).resolves.toMatchObject(response)

    active.get(reply.id)!.finish()
    const privateTask = host.send({ botId: peer.id, requestId: "private", message: "Separate request" })
    await waitForRun(privateTask)
    expect(privateTask.threadId).toBe(reply.threadId)
    const privateQuestion = ask(privateTask, "An unrelated question")
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(() => host.answerWorkQuestion(owner.id, privateTask.id, {
      requestId: privateQuestion.request.requestId, answers: {}, ignored: true
    })).toThrow("失效")
  })

  it("opens the current approval on the intermediate peer's native conversation and removes it on cancellation", async () => {
    const { host, approval, startNestedReturn } = fixture()
    const { owner, peer, work, reply } = await startNestedReturn()
    approval(reply, "integration-approval").register()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([{
      kind: "approval", workId: work.id, workTitle: "Report", askedBy: "Peer", taskId: reply.id,
      requestId: "integration-approval", target: { botId: peer.id, threadId: peer.threadId }
    }])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
    host.cancel(reply.id)
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(approvalDecisionBroker.get("integration-approval")).toBeNull()
  })

  it("withdraws access when the return turn's original handoff has been stopped before physical cleanup", async () => {
    const { host, store, ask, startNestedReturn } = fixture()
    const { owner, handoff, reply } = await startNestedReturn()
    const question = ask(reply, "Confirm integration?")
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ taskId: reply.id }])

    // Observe the durable phase of Stop before the Host aborts the returned runs.
    expect(store.stopTaskPeers(handoff.id).tasks.map(task => task.id)).toContain(reply.id)
    expect(store.getTask(handoff.id).state).toBe("cancelled")
    expect(store.getTask(reply.id).state).toBe("waiting_user")
    expect(getPendingUserInputForThread(reply.threadId)).toEqual(question.request)
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(() => host.answerWorkQuestion(owner.id, reply.id, {
      requestId: question.request.requestId, answers: {}, ignored: true
    })).toThrow("失效")
    host.cancel(reply.id)
    await expect(question.result).rejects.toThrow("cancelled")
  })

  it("keeps a private peer reply without an upstream handoff out of work approvals", async () => {
    const { host, bot, active, approval, waitForRun, waitForReply } = fixture()
    const owner = bot("Owner"), peer = bot("Peer")
    const task = host.send({ botId: owner.id, requestId: "private", message: "Separate private request" })
    await waitForRun(task)
    const handoff = host.delegate(task.id, peer.id, "Check this private request", "private-peer")
    await waitForRun(handoff)
    active.get(task.id)!.finish()
    active.get(handoff.id)!.finish()
    const reply = await waitForReply(handoff)
    expect(reply.origin).toMatchObject({ kind: "bot", expectsReply: false, rootTaskId: task.id })
    expect(reply.origin).not.toHaveProperty("upstreamTaskId")
    approval(reply, "private-reply-approval").register()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
  })
})

describe("desktop work approvals", () => {
  it("refreshes after registration and removal while projecting only the native queue head", async () => {
    const { host, store, bot, active, approval, waitForRun, unsubscribeApprovals } = fixture()
    const owner = bot("Owner"), peer = bot("Peer")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const delegated = host.delegate(task.id, peer.id, "Review the report", "peer-review")
    active.get(task.id)!.finish()
    await waitForRun(delegated)
    const first = approval(delegated, "first-approval")
    expect(store.getTask(delegated.id).state).toBe("waiting_user")
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])

    const changed = vi.fn()
    const unsubscribe = host.subscribe(changed)
    first.register()
    expect(changed).toHaveBeenCalledOnce()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([{
      kind: "approval", requestId: "first-approval", workId: work.id, workTitle: "Report",
      taskId: delegated.id, askedBy: "Peer", target: { botId: peer.id, threadId: peer.threadId }
    }])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
    expect(() => host.answerWorkQuestion(owner.id, delegated.id, { requestId: "first-approval", answers: {} }))
      .toThrow("失效")

    const second = approval(delegated, "second-approval")
    second.register()
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ requestId: "first-approval" }])
    changed.mockClear()
    expect(approvalDecisionBroker.decide({
      source: { kind: "desktop", webContentsId: 1 }, requestId: "first-approval",
      decision: { type: "reject", tool_call_id: "first-approval" }
    }).accepted).toBe(true)
    expect(first.resolve).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
    expect(store.getTask(delegated.id).state).toBe("waiting_user")
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ requestId: "second-approval" }])
    first.endWait()

    host.cancel(delegated.id)
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(approvalDecisionBroker.get("second-approval")).toBeNull()
    await host.stop()
    expect(unsubscribeApprovals).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("rejects unowned approvals and independent child runtimes sharing the routing thread", async () => {
    const { host, bot, approval, waitForRun } = fixture()
    const owner = bot("Owner"), peer = bot("Peer")
    const { work, task } = await host.createWork({ botId: owner.id, operationId: "work", title: "Report", goal: "Review" })
    await waitForRun(task)
    const delegated = host.delegate(task.id, peer.id, "Review the report", "peer-review")
    await waitForRun(delegated)
    approval(delegated, "previous-run", delegated.threadId, false).register()
    const otherRuntime = approval(delegated, "child-runtime", `${delegated.threadId}__wf_child`)
    otherRuntime.register()
    const current = approval(delegated, "owned-current")
    current.register()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    approvalDecisionBroker.unregister("previous-run")
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    const changed = vi.fn()
    const unsubscribe = host.subscribe(changed)
    approvalDecisionBroker.unregister("child-runtime")
    expect(changed).toHaveBeenCalledOnce()
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{ requestId: "owned-current" }])
    expect(botWorkApprovals.pendingApproval({ ...delegated, id: "different-run" }, new Set(["owned-current"])))
      .toBeUndefined()

    // A private request on the same peer thread after this task settles must stay private.
    approvalDecisionBroker.unregister("owned-current")
    otherRuntime.endWait()
    current.endWait()
    host.cancel(delegated.id)
    const privateTask = host.send({ botId: peer.id, requestId: "private", message: "A private question" })
    await waitForRun(privateTask)
    approval(privateTask, "peer-private").register()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    expect(host.pendingWorkQuestions(peer.id)).toEqual([])
    unsubscribe()

    approval(task, "direct-work").register()
    expect(host.pendingWorkQuestions(owner.id)).toMatchObject([{
      requestId: "direct-work", target: { botId: owner.id, workId: work.id, threadId: work.threadId }
    }])
  })

  it("keeps approvals from an authenticated personal IM assignment out of the desktop work list", async () => {
    const { host, store, bot, active, approval, waitForRun } = fixture()
    const owner = bot("Owner")
    const now = Date.now()
    const expiresAt = new Date(now + 60_000).toISOString()
    const binding = { id: "personal", botId: owner.id, kind: "dm" as const, label: "Personal",
      version: 1, state: "active" as const, conversationKey: "personal-conversation",
      createdAt: new Date(now).toISOString(), expiresAt }
    const route = host.registerImBinding("realm", "principal", binding)
    host.imChannel.importImBinding({
      id: route.id, botId: owner.id, kind: binding.kind, label: binding.label,
      channelKey: botImScopeId("realm", "principal", binding.conversationKey), version: binding.version
    })
    host.setImOnline(owner.id, route.id, true)
    const text = "Review the report from personal IM"
    const ingress = store.imGateway.receive("realm", "principal", {
      route: { bindingId: binding.id, botId: owner.id, kind: binding.kind, label: binding.label,
        version: binding.version, senderId: "principal" },
      event: { schemaVersion: 1, eventId: "personal-event", platformMessageId: "personal-message",
        principalId: "principal", conversationKey: binding.conversationKey, conversationSeq: 1,
        message: { type: "text", text }, occurredAt: new Date(now).toISOString(),
        redelivered: false, lease: { id: "personal-lease", expiresAt } }
    })
    store.imGateway.settle(ingress.id, "active", undefined, now + 60_000)
    const accepted = host.acceptImEvent({ bindingId: ingress.bindingId, eventId: ingress.id,
      messageId: botImScopeId("realm", "principal", "personal-message"), senderId: "principal",
      text, mentionsBotIds: [owner.id] })
    store.imGateway.settle(ingress.id, "active", accepted.taskId!)
    const source = store.getTask(accepted.taskId!)
    await waitForRun(source)
    expect(source).toMatchObject({ threadId: owner.threadId, mockSource: { transport: "im", personal: true } })
    const { task, work } = await host.createWork(
      { botId: owner.id, operationId: "im-work", title: "Report", goal: "Review" },
      { taskId: source.id, callId: "create", key: "create" }
    )
    active.get(source.id)!.finish()
    await waitForRun(task)
    expect(work.audienceKey).toBe("desktop")
    expect(task.mockSource).toMatchObject({ transport: "im", personal: true })
    const wait = approval(task, "personal-im-approval")
    const changed = vi.fn()
    const unsubscribe = host.subscribe(changed)
    wait.register()
    expect(changed).not.toHaveBeenCalled()
    expect(host.pendingWorkQuestions(owner.id)).toEqual([])
    unsubscribe()
  })
})
