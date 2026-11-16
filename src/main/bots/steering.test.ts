import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease, type BotRunPort } from "./host"
import { buildBotPrompt } from "./prompt"
import type { BotTask } from "../../shared/bots/contracts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const bot = store.create({
    name: "Synthetic",
    instructions: "",
    color: "#ea2845",
    modelRef: null
  })
  let finish!: (value: { state: "completed" | "superseded"; result: string }) => void
  const pending = new Promise<{ state: "completed" | "superseded"; result: string }>((resolve) => {
    finish = resolve
  })
  const injections = new Map<string, () => boolean>()
  const steer = vi.fn<NonNullable<BotRunLease["steer"]>>(async (task, inject) => {
    injections.set(task.id, inject)
    return true
  })
  let first = true
  let waiting!: (value: boolean) => void
  const yieldToUser = vi.fn()
  const dismissQuestion = vi.fn()
  const acquire = vi.fn<BotRunPort["acquire"]>(() => {
    if (!first) return null
    first = false
    return {
      execute: (_signal, onWaiting) => {
        waiting = onWaiting
        return pending
      },
      steer,
      yieldToUser,
      dismissQuestion,
      release: vi.fn()
    }
  })
  const onSettled = vi.fn<NonNullable<BotRunPort["onSettled"]>>()
  const host = new LocalBotHost(store, { acquire, onAvailable: () => () => {}, onSettled })
  cleanups.push(async () => {
    finish({ state: "completed", result: "Done" })
    await host.stop()
    db.close()
  })
  return {
    db,
    store,
    bot,
    host,
    steer,
    injections,
    finish,
    acquire,
    onSettled,
    yieldToUser,
    dismissQuestion,
    wait: (value: boolean) => waiting(value)
  }
}

async function running(f: ReturnType<typeof fixture>) {
  const root = f.host.send({ botId: f.bot.id, requestId: "root", message: "Original goal" })
  await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
  f.host.onSteeringReady(root.id)
  return root
}

describe("independent work uses beta's interactive inbox", () => {
  it.each(["running", "waiting", "cancelled"] as const)(
    "keeps forwarded input behind an owned command receipt (%s), without yielding or replaying",
    async (mode) => {
      const f = fixture()
      const source = f.store.enqueue({ botId: f.bot.id, requestId: "create", message: "Start a work" })
      f.store.transition(source.id, "running")
      const { task, work } = f.store.createWork(
        { botId: f.bot.id, operationId: "work", title: "Work", goal: "Original" },
        { taskId: source.id, callId: "create", key: "create" }
      )
      f.store.settle(source.id, "completed", null, "Started")
      f.store.transition(task.id, "running")
      f.store.settle(task.id, "completed", null, "Command started")
      const receipt = f.store.enqueue(
        { botId: f.bot.id, workId: work.id, requestId: "command-result", message: "Command completed" },
        { kind: "notification", notificationKind: "command", key: "command" }
      )
      const acquireReceipt = f.acquire.getMockImplementation()!
      f.acquire.mockImplementation((bot, candidate, work) => candidate.id === receipt.id
        ? acquireReceipt(bot, candidate, work) : null)
      f.host.resume()
      await vi.waitFor(() => expect(f.store.getTask(receipt.id).state).toBe("running"))
      f.host.onSteeringReady(receipt.id)
      if (mode !== "running") f.wait(true)
      let incoming!: BotTask
      f.acquire.mockImplementation((_bot, source) => source.requestId === "main" ? ({
        execute: async () => {
          incoming = f.host.sendWork({ taskId: source.id, callId: "forward", key: "forward" }, work.id, "Keep the new context")
          return { state: "completed", result: "Forwarded" }
        },
        release: vi.fn()
      }) : null)
      f.host.send({ botId: f.bot.id, requestId: "main", message: "Add context to the existing task" })
      await vi.waitFor(() => expect(incoming).toBeDefined())
      expect(incoming.origin).toMatchObject({ kind: "work", dispatch: "follow_up" })
      expect(f.store.getTask(incoming.id).state).toBe("queued")
      expect(f.store.getTask(receipt.id).state).toBe(mode === "running" ? "running" : "waiting_user")
      expect(f.yieldToUser).not.toHaveBeenCalled()
      expect(f.dismissQuestion).not.toHaveBeenCalled()
      expect(f.steer).not.toHaveBeenCalled()
      if (mode === "cancelled") f.host.cancel(incoming.id)
      const execute = vi.fn(async () => ({ state: "completed" as const, result: "Context handled" }))
      f.acquire.mockImplementation((_bot, candidate) => candidate.id === incoming.id
        ? { execute, release: vi.fn() }
        : null)
      if (mode !== "running") f.wait(false)
      expect(execute).not.toHaveBeenCalled()
      f.finish({ state: "completed", result: "Receipt processed" })
      await vi.waitFor(() => expect(f.store.getTask(receipt.id).state).toBe("completed"))
      await vi.waitFor(() => expect(f.store.getTask(incoming.id).state).toBe(mode === "cancelled" ? "cancelled" : "completed"))
      expect(execute).toHaveBeenCalledTimes(mode === "cancelled" ? 0 : 1)
      expect(f.yieldToUser).not.toHaveBeenCalled()
    }
  )

  it("offers a deferred work supplement once after its interaction ends, without a second execution", async () => {
    const f = fixture()
    const { task: owner, work } = f.store.createWork({ botId: f.bot.id, operationId: "work", title: "Work", goal: "Original" })
    await vi.waitFor(() => expect(f.store.getTask(owner.id).state).toBe("running"))
    f.host.onSteeringReady(owner.id)
    f.wait(true)
    f.steer.mockResolvedValueOnce(false)
    const incoming = f.host.send({ botId: f.bot.id, workId: work.id, requestId: "supplement", message: "Context" })
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.store.getTask(incoming.id).state).toBe("queued")
    f.wait(false)
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(2))
    expect(f.injections.get(incoming.id)!()).toBe(true)
    expect(f.injections.get(incoming.id)!()).toBe(true)
    f.finish({ state: "completed", result: "Both handled" })
    await vi.waitFor(() => expect(f.store.getTask(incoming.id).state).toBe("completed"))
    expect(f.acquire.mock.calls.filter(([, t]) => t.workId === work.id)).toHaveLength(1)
    expect(f.store.recentTasks().filter(t => t.origin.kind === "work_result")).toHaveLength(1)
  })

  it.each(["direct", "forwarded"] as const)(
    "injects the actual %s instruction into the same work and reports the consumed context",
    async (kind) => {
      const f = fixture()
      const source = f.store.enqueue({
        botId: f.bot.id,
        requestId: "create",
        message: "Write a plan"
      })
      f.store.transition(source.id, "running")
      const { work, task } = f.store.createWork(
        { botId: f.bot.id, operationId: "create", title: "Plan", goal: "Write a plan" },
        { taskId: source.id, callId: "create", key: "create" },
        { kind: "directory", path: "/synthetic/plan-workspace" }
      )
      f.store.settle(source.id, "completed", null, "Started")
      await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe("running"))
      f.host.onSteeringReady(task.id)
      f.wait(true)
      const revision = "Change the time to four; keep the directory"
      // bot_work_send executes the Bot's prepared instruction, not the source
      // main-chat wording. Keep both distinct so a raw-text fallback is caught.
      const preparedRevision = "Update the plan to 4 pm in the existing work directory."
      const instruction = kind === "direct" ? revision : preparedRevision
      let child!: BotTask
      if (kind === "direct") {
        child = f.host.send({
          botId: f.bot.id,
          workId: work.id,
          requestId: "revision",
          message: revision
        })
      } else {
        f.acquire.mockImplementationOnce((_bot, main) => ({
          execute: async () => {
            child = f.host.sendWork(
              { taskId: main.id, callId: "forward", key: "forward" },
              work.id,
              preparedRevision
            )
            return { state: "completed", result: "Forwarded" }
          },
          release: vi.fn()
        }))
        f.host.send({ botId: f.bot.id, requestId: "main", message: revision })
        await vi.waitFor(() => expect(child).toBeDefined())
      }
      expect(child.message).toBe(instruction)
      expect(f.steer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: child.id, workId: work.id, message: instruction }),
        expect.any(Function),
        expect.any(Function)
      )
      if (kind === "forwarded") {
        expect(child.origin).toMatchObject({
          kind: "work",
          dispatch: "follow_up",
          sourceMessageIds: ["main"]
        })
        expect(f.store.recentTasks().find((item) => item.requestId === "main")).toMatchObject({
          message: revision
        })
      }
      expect(f.injections.has(child.id)).toBe(true)
      expect(f.injections.get(child.id)!()).toBe(true)
      expect(f.store.getTask(child.id).state).toBe("running")
      expect(f.store.getTask(child.id).threadId).toBe(work.threadId)
      f.finish({ state: "completed", result: "Plan at four" })
      await vi.waitFor(() => expect(f.store.getTask(child.id).state).toBe("completed"))
      const reports = f.store.recentTasks().filter((item) => item.origin.kind === "work_result")
      expect(reports).toHaveLength(1)
      expect(reports[0].threadId).toBe(f.bot.threadId)
      expect(JSON.parse(reports[0].message)).toMatchObject({
        workId: work.id,
        executionState: "completed",
        requestContext: {
          messages: [
            { text: "Write a plan", truncated: false },
            { text: instruction, truncated: false }
          ],
          messagesOmitted: false
        },
        result: "Plan at four",
        businessState: "active",
        pendingExecution: false
      })
      if (kind === "forwarded") expect(reports[0].message).not.toContain(revision)
      expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
      expect(f.store.getWork(f.bot.id, work.id).workspace).toEqual(work.workspace)
      expect(f.acquire.mock.calls.filter(([, run]) => run.workId === work.id)).toHaveLength(1)
    }
  )
  it("does not inject the main conversation or another task into an active work", async () => {
    const f = fixture()
    const { work, task } = f.store.createWork({
      botId: f.bot.id,
      operationId: "one",
      title: "One",
      goal: "First"
    })
    await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe("running"))
    f.host.onSteeringReady(task.id)
    f.host.send({ botId: f.bot.id, requestId: "main", message: "Main only" })
    const other = f.store.createWork({
      botId: f.bot.id,
      operationId: "two",
      title: "Two",
      goal: "Second"
    })
    f.host.send({
      botId: f.bot.id,
      workId: other.work.id,
      requestId: "other",
      message: "Other only"
    })
    expect(f.steer).not.toHaveBeenCalled()
    const own = f.host.send({
      botId: f.bot.id,
      workId: work.id,
      requestId: "own",
      message: "This work"
    })
    expect(f.injections.get(own.id)!()).toBe(true)
  })
  it.each(["rejected", "consumed", "queued"] as const)(
    "does not prepare a %s forwarded addition again when its work command is replayed",
    async (outcome) => {
      const f = fixture()
      const { work, task: owner } = f.store.createWork({
        botId: f.bot.id, operationId: "work", title: "Report", goal: "Write the report"
      })
      await vi.waitFor(() => expect(f.store.getTask(owner.id).state).toBe("running"))
      f.host.onSteeringReady(owner.id)
      f.wait(true)
      f.steer.mockImplementationOnce(async (entry, inject) => {
        if (outcome === "rejected") return { rejected: true }
        f.injections.set(entry.id, inject)
        return outcome === "consumed" ? inject() : true
      })
      // Re-preparation is not harmless: another Hook decision must not discard
      // an already accepted message waiting for the next model boundary.
      f.steer.mockResolvedValueOnce({ rejected: true })
      let child!: BotTask
      let replay!: BotTask
      f.acquire.mockImplementationOnce((_bot, source) => ({
        execute: async () => {
          const key = { taskId: source.id, callId: "call-1", key: "same-request" }
          child = f.host.sendWork(key, work.id, "Add a table")
          await vi.waitFor(() => expect(f.store.getTask(child.id).state)
            .toBe(outcome === "rejected" ? "failed" : outcome === "consumed" ? "running" : "queued"))
          await new Promise<void>((resolve) => setImmediate(resolve))
          replay = f.host.sendWork({ ...key, callId: "call-2" }, work.id, "Add a table")
          return { state: "completed", result: "Forwarded" }
        },
        release: vi.fn()
      }))
      const main = f.host.send({ botId: f.bot.id, requestId: "forward", message: "Ask the report task to add a table" })
      await vi.waitFor(() => expect(f.store.getTask(main.id).state).toBe("completed"))
      expect(replay).toMatchObject({ id: child.id, state: "queued" }) // stable admission receipt
      expect(f.steer).toHaveBeenCalledTimes(1)
      expect(f.store.getTask(owner.id).state).toBe("waiting_user")
      expect(f.store.getTask(child.id).state).toBe(outcome === "rejected" ? "failed" : outcome === "consumed" ? "running" : "queued")
      if (outcome === "queued") {
        expect(f.injections.get(child.id)!()).toBe(true)
        expect(f.store.getTask(child.id).state).toBe("running")
      }
      expect(f.onSettled.mock.calls.filter(([entry]) => entry.id === child.id))
        .toHaveLength(outcome === "rejected" ? 1 : 0)
    }
  )
})

describe("Bot messages during a user run", () => {
  it("reoffers a temporarily unready addition within the same live run", async () => {
    const f = fixture(), root = await running(f)
    f.steer.mockResolvedValueOnce(false)
    const child = f.host.send({ botId: f.bot.id, requestId: "not-ready", message: "Include the appendix" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.store.getTask(child.id).state).toBe("queued")
    f.host.onSteeringReady(root.id)
    expect(f.steer).toHaveBeenCalledTimes(2)
    expect(f.injections.get(child.id)!()).toBe(true)
    f.finish({ state: "completed", result: "Included the appendix" })
    await vi.waitFor(() => expect(f.store.getTask(child.id).state).toBe("completed"))
  })
  it.each(["user", "work"] as const)(
    "settles a Hook-rejected %s addition once without restarting it or stopping the owner",
    async (kind) => {
      const f = fixture()
      const root = kind === "work"
        ? f.store.createWork({ botId: f.bot.id, operationId: "work", title: "Report", goal: "Write a report" }).task
        : f.host.send({ botId: f.bot.id, requestId: "root", message: "Write a report" })
      await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
      f.host.onSteeringReady(root.id)
      const reason = "输入检查未通过，未执行这条补充消息。"
      f.steer.mockResolvedValueOnce({ rejected: true })
      const input = { botId: f.bot.id, workId: root.workId, requestId: "blocked", message: "Rejected addition" }
      const rejected = f.host.send(input)
      await vi.waitFor(() => expect(f.store.getTask(rejected.id)).toMatchObject({ state: "failed", error: reason }))
      expect(f.store.getTask(root.id).state).toBe("running")
      expect(f.injections.has(rejected.id)).toBe(false)
      expect(f.host.send(input)).toMatchObject({ id: rejected.id, state: "failed" })
      f.host.onSteeringReady(root.id)
      expect(f.steer).toHaveBeenCalledTimes(1)

      const accepted = f.host.send({ botId: f.bot.id, workId: root.workId, requestId: "allowed", message: "Include the approved appendix" })
      expect(f.injections.get(accepted.id)!()).toBe(true)
      f.finish({ state: "completed", result: "Report with approved appendix" })
      await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("completed"))
      expect(f.store.getTask(accepted.id).state).toBe("completed")
      expect(f.store.getTask(rejected.id).state).toBe("failed")
      expect(f.acquire.mock.calls.some(([, entry]) => entry.id === rejected.id)).toBe(false)
      expect(f.onSettled.mock.calls.filter(([entry]) => entry.id === rejected.id)).toEqual([
        [expect.objectContaining({ id: rejected.id }), "failed", reason]
      ])
      if (kind === "work") {
        const receipts = f.store.recentTasks().filter((entry) => entry.origin.kind === "work_result")
        expect(receipts.filter((entry) => entry.origin.kind === "work_result" && entry.origin.executionTaskId === rejected.id))
          .toHaveLength(1)
        const rejection = receipts.find((entry) => entry.origin.kind === "work_result" && entry.origin.executionTaskId === rejected.id)!
        expect(JSON.parse(rejection.message)).toMatchObject({
          executionState: "failed", result: reason,
          requestContext: { messages: [], messagesOmitted: true }
        })
        expect(rejection.message).not.toContain(input.message)
      }
    }
  )

  it("does not turn a withdrawn addition into a failure when its Hook returns late", async () => {
    const f = fixture(), root = await running(f)
    let reject!: (value: { rejected: true }) => void
    f.steer.mockImplementationOnce(() => new Promise((resolve) => { reject = resolve }))
    const child = f.host.send({ botId: f.bot.id, requestId: "withdraw", message: "Withdraw me" })
    f.host.cancel(child.id)
    reject({ rejected: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.store.getTask(child.id).state).toBe("cancelled")
    expect(f.store.getTask(root.id).state).toBe("running")
    expect(f.onSettled).not.toHaveBeenCalled()
  })

  it("ignores a late refusal from an expired owner instead of settling another run's inbox", async () => {
    const f = fixture(), root = await running(f)
    let reject!: (value: { rejected: true }) => void
    f.steer.mockImplementationOnce(() => new Promise((resolve) => { reject = resolve }))
    const child = f.host.send({ botId: f.bot.id, requestId: "late", message: "Prepare under the next live run" })
    f.finish({ state: "completed", result: "Done" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("completed"))
    reject({ rejected: true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.store.getTask(child.id).state).toBe("queued")
    expect(f.onSettled.mock.calls.some(([entry]) => entry.id === child.id)).toBe(false)
  })

  it("preserves every unconsumed inbox message when its model round is superseded", async () => {
    const f = fixture(),
      root = await running(f)
    f.steer.mockResolvedValue(false)
    const first = f.host.send({
      botId: f.bot.id,
      requestId: "correction-1",
      message: "Keep the original goal and add tests"
    })
    const second = f.host.send({
      botId: f.bot.id,
      requestId: "correction-2",
      message: "Also deliver the files"
    })
    await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(2))
    f.finish({ state: "superseded", result: "" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("superseded"))
    expect(f.store.getTask(root.id).message).toBe("Original goal")
    for (const inbox of [first, second]) {
      expect(f.store.getTask(inbox.id)).toMatchObject({
        state: "queued",
        message: inbox.message,
        requestId: inbox.requestId
      })
    }
    expect(f.store.nextQueued([])?.id).toBe(first.id)
  })
  it("delivers the first direct request into a running introduction with durable ownership", async () => {
    const f = fixture()
    f.host.introduce(f.bot.id)
    await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce())
    const intro = f.acquire.mock.calls[0][1]
    // This prompt is already built when the welcome question starts waiting;
    // the injected request must not need another runtime to receive its routing contract.
    const prompt = buildBotPrompt(f.bot, intro, "/private")
    expect(prompt).toContain("apply when an actual user request arrives in this conversation")
    expect(prompt).toContain("The introduction cue alone is not an assignment")
    expect(prompt).toContain("call bot_work_create before executing the project work")
    f.host.onSteeringReady(intro.id)
    f.wait(true)
    const child = f.host.send({ botId: f.bot.id, requestId: "first-user", message: "Fix the CSV project in /projects/export, test and deliver it" })
    expect(f.injections.get(child.id)!()).toBe(true)
    f.finish({ state: "completed", result: "Actual result" })
    await vi.waitFor(() => expect(f.store.getTask(child.id).state).toBe("completed"))
    expect(f.acquire).toHaveBeenCalledOnce()
  })
  it("offers early arrivals when the original runtime is ready without polling", async () => {
    const f = fixture()
    const root = f.host.send({ botId: f.bot.id, requestId: "root", message: "Original goal" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
    const child = f.host.send({ botId: f.bot.id, requestId: "early", message: "Include tests" })
    expect(f.steer).not.toHaveBeenCalled()
    f.host.onSteeringReady(root.id)
    expect(f.injections.get(child.id)!()).toBe(true)
  })
  it("uses one graph, claims only at injection and settles both receipts with the actual final preview", async () => {
    const f = fixture(),
      root = await running(f)
    const child = f.host.send({ botId: f.bot.id, requestId: "addition", message: "Include tests" })
    expect(f.store.getTask(child.id).state).toBe("queued")
    expect(f.injections.get(child.id)!()).toBe(true)
    expect(f.injections.get(child.id)!()).toBe(true) // original transcript flush may retry
    expect(f.store.getTask(child.id).state).toBe("running")
    f.finish({ state: "completed", result: "Report with tests" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("completed"))
    expect(f.store.getTask(child.id).state).toBe("completed")
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.store.activities().find((a) => a.id === f.bot.id)?.preview).toBe("Report with tests")
  })

  it("leaves an unconsumed message in the durable inbox for a later run", async () => {
    const f = fixture(),
      root = await running(f)
    const child = f.host.send({ botId: f.bot.id, requestId: "late", message: "Follow up" })
    f.finish({ state: "completed", result: "Done" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("completed"))
    expect(f.store.getTask(child.id).state).toBe("queued")
    expect(f.injections.get(child.id)!()).toBe(false)
  })

  it("withdraws a queued message before injection without stopping its parent", async () => {
    const f = fixture(),
      root = await running(f)
    const child = f.host.send({ botId: f.bot.id, requestId: "withdraw", message: "Withdraw me" })
    f.host.cancel(child.id)
    expect(f.injections.get(child.id)!()).toBe(false)
    expect(f.store.getTask(root.id).state).toBe("running")
  })

  it("cancels the owning graph when stopping an already injected task", async () => {
    const f = fixture(),
      root = await running(f)
    const child = f.host.send({ botId: f.bot.id, requestId: "stop", message: "Correction" })
    expect(f.injections.get(child.id)!()).toBe(true)
    f.host.cancel(child.id)
    f.finish({ state: "completed", result: "Late result" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("cancelled"))
    expect(f.store.getTask(child.id).state).toBe("cancelled")
    expect(f.injections.get(child.id)!()).toBe(false)
  })

  it("does not offer another Bot's message to an existing run", async () => {
    const f = fixture()
    await running(f)
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#ea2845",
      modelRef: null
    })
    f.host.send({ botId: other.id, requestId: "foreign", message: "Private" })
    expect(f.steer).not.toHaveBeenCalled()
  })

  it("marks consumed work interrupted on crash without replaying it", async () => {
    const f = fixture(),
      root = await running(f)
    const child = f.host.send({ botId: f.bot.id, requestId: "crash", message: "Correction" })
    expect(f.injections.get(child.id)!()).toBe(true)
    // Simulate durable recovery only after the original host is quiescent; retain active records.
    f.finish({ state: "completed", result: "Done" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("completed"))
    f.db.run("UPDATE bot_tasks SET state='running' WHERE id IN (?,?)", [root.id, child.id])
    const recovered = new BotStore(f.db)
    recovered.recover()
    expect(recovered.getTask(child.id).state).toBe("interrupted")
    expect(recovered.nextQueued([])).toBeNull()
  })

  it("rejects foreign settlement atomically", async () => {
    const f = fixture(),
      root = await running(f)
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#ea2845",
      modelRef: null
    })
    const child = f.store.enqueue({ botId: other.id, requestId: "foreign", message: "Private" })
    f.store.transition(child.id, "running")
    expect(() => f.store.settleRun(root.id, [child.id], "completed", null, "Done")).toThrow(
      "当前会话"
    )
    expect(f.store.getTask(root.id).state).toBe("running")
    expect(f.store.getTask(child.id).state).toBe("running")
  })
})

describe("group input during an existing question", () => {
  async function delegatedQuestion() {
    const f = fixture()
    const parentBot = f.store.create({
      name: "Parent",
      instructions: "",
      color: "#ea2845",
      modelRef: null
    })
    const group = f.store.saveGroup({ name: "Room", memberIds: [f.bot.id, parentBot.id] })
    const parent = f.store.enqueue(
      { botId: parentBot.id, requestId: "parent", message: "Ask the member" },
      { kind: "group", groupId: group.id, messageId: "parent" }
    )
    f.store.transition(parent.id, "running")
    const root = f.store.delegate(parent.id, f.bot.id, "Wait for the user's choice", "delegate")
    f.store.settle(parent.id, "completed", null, "Delegated")
    f.host.resume()
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
    f.host.onSteeringReady(root.id)
    return { ...f, root, group }
  }
  it("yields a waiting same-room delegation, preserving its owner and the new user's separate authority", async () => {
    const f = await delegatedQuestion()
    f.wait(true)
    const foreign = f.store.saveGroup({ name: "Other room", memberIds: [f.bot.id] })
    f.host.sendGroup({
      groupId: foreign.id,
      requestId: "foreign",
      text: "Other",
      targetBotIds: [f.bot.id]
    })
    expect(f.yieldToUser).not.toHaveBeenCalled()
    f.host.sendGroup({
      groupId: f.group.id,
      requestId: "new-topic",
      text: "New work",
      targetBotIds: [f.bot.id]
    })
    expect(f.yieldToUser).toHaveBeenCalledOnce()
    const pending = f.yieldToUser.mock.calls[0][0]
    expect(pending()).toBe(true)
    expect(f.steer).not.toHaveBeenCalled()
    expect(f.dismissQuestion).not.toHaveBeenCalled()
    expect(f.store.getTask(f.root.id)).toMatchObject({
      state: "waiting_user",
      origin: { kind: "bot", expectsReply: true }
    })
    const incoming = f.store
      .recentTasks()
      .find((t) => t.origin.kind === "group" && t.origin.messageId === "new-topic")!
    expect(incoming.state).toBe("queued")
    expect(() => f.store.injectIntoRun(incoming.id, f.root.id)).toThrow("当前执行轮次")
    f.host.cancel(incoming.id)
    expect(pending()).toBe(false)
    expect(f.store.getTask(f.root.id).state).toBe("waiting_user")
  })
  it("rechecks early group input only after the owned delegated question actually registers", async () => {
    const f = await delegatedQuestion()
    f.host.sendGroup({
      groupId: f.group.id,
      requestId: "early",
      text: "New work",
      targetBotIds: [f.bot.id]
    })
    expect(f.yieldToUser).not.toHaveBeenCalled()
    f.wait(true)
    const request = {
      requestId: "question",
      threadId: f.root.threadId,
      createdAt: "now",
      questions: []
    }
    f.host.recordGroupQuestion(f.root.id, { ...request, threadId: "foreign" })
    expect(f.yieldToUser).not.toHaveBeenCalled()
    f.host.recordGroupQuestion(f.root.id, request)
    expect(f.yieldToUser).toHaveBeenCalledOnce()
    expect(f.yieldToUser.mock.calls[0][0]()).toBe(true)
    f.host.recordGroupQuestion(f.root.id, request)
    expect(f.yieldToUser).toHaveBeenCalledOnce()
    expect(f.steer).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    "dismisses an owned command-notification question without injecting new authority (addressed=%s)",
    async (addressed) => {
      const f = fixture()
      const other = f.store.create({
        name: "Other",
        instructions: "",
        color: "#ea2845",
        modelRef: null
      })
      const group = f.store.saveGroup({ name: "Room", memberIds: [f.bot.id, other.id] })
      const root = f.store.enqueue(
        { botId: f.bot.id, requestId: "command-result", message: "Background command completed" },
        { kind: "notification", notificationKind: "command", key: "command", groupId: group.id }
      )
      f.host.resume()
      await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
      f.wait(true)
      f.host.onSteeringReady(root.id)
      const foreign = f.store.saveGroup({ name: "Elsewhere", memberIds: [other.id] })
      f.host.sendGroup({
        groupId: foreign.id,
        requestId: "foreign",
        text: "Other",
        targetBotIds: [other.id]
      })
      expect(f.dismissQuestion).not.toHaveBeenCalled()
      const message = {
        groupId: group.id,
        requestId: "new-topic",
        text: "New work",
        targetBotIds: [addressed ? f.bot.id : other.id]
      }
      f.host.sendGroup(message)
      expect(f.dismissQuestion).toHaveBeenCalledOnce()
      f.host.sendGroup(message)
      expect(f.dismissQuestion).toHaveBeenCalledOnce()
      expect(f.steer).not.toHaveBeenCalled()
      expect(f.injections.size).toBe(0)
      const incoming = f.store
        .recentTasks()
        .find((t) => t.origin.kind === "group" && t.origin.messageId === message.requestId)!
      expect(incoming).toMatchObject({ state: "queued", origin: { kind: "group" } })
      expect(() => f.store.injectIntoRun(incoming.id, root.id)).toThrow("当前执行轮次")
      f.wait(false)
      f.finish({ state: "superseded", result: "" })
      await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("superseded"))
      expect(f.store.groupMessages(group.id).some((m) => m.id === `result-${root.id}`)).toBe(false)
      expect(f.store.getTask(incoming.id).state).toBe("queued")
    }
  )
  it("moves past only an unaddressed question in the same room, never on an exact retry", async () => {
    const f = fixture()
    const other = f.store.create({
      name: "Other",
      instructions: "",
      color: "#ea2845",
      modelRef: null
    })
    const group = f.store.saveGroup({ name: "Room", memberIds: [f.bot.id, other.id] })
    f.host.sendGroup({
      groupId: group.id,
      requestId: "root",
      text: "Ask",
      targetBotIds: [f.bot.id]
    })
    const root = f.store.recentTasks()[0]
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
    f.wait(true)
    f.host.onSteeringReady(root.id)
    const message = {
      groupId: group.id,
      requestId: "new-topic",
      text: "Another topic",
      targetBotIds: [other.id]
    }
    f.host.sendGroup(message)
    expect(f.dismissQuestion).toHaveBeenCalledOnce()
    f.host.sendGroup(message)
    expect(f.dismissQuestion).toHaveBeenCalledOnce()
    expect(() => f.host.sendGroup({ ...message, text: "Changed retry" })).toThrow()
    expect(f.dismissQuestion).toHaveBeenCalledOnce()
    const foreign = f.store.saveGroup({ name: "Other room", memberIds: [other.id] })
    f.host.sendGroup({ ...message, groupId: foreign.id, requestId: "foreign" })
    expect(f.dismissQuestion).toHaveBeenCalledOnce()
    expect(f.steer).not.toHaveBeenCalled()
    // The original input tool reports wait-end before the next model boundary.
    f.wait(false)
    f.finish({ state: "superseded", result: "" })
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("superseded"))
    expect(f.store.groupMessages(group.id).some((m) => m.id === `result-${root.id}`)).toBe(false)
    const addressed = f.store
      .recentTasks()
      .filter((t) => t.origin.kind === "group" && t.origin.messageId === message.requestId)
    expect(addressed).toHaveLength(1)
    expect(addressed[0]).toMatchObject({ botId: other.id, state: "queued" })
  })
  async function groupQuestion(ready = true) {
    const f = fixture()
    const group = f.store.saveGroup({ name: "Room", memberIds: [f.bot.id] })
    const send = (requestId: string, groupId = group.id) => {
      f.host.sendGroup({ groupId, requestId, text: requestId, targetBotIds: [f.bot.id] })
      return f.store
        .recentTasks()
        .find((task) => task.origin.kind === "group" && task.origin.messageId === requestId)!
    }
    const root = send("question-root")
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
    if (ready) f.host.onSteeringReady(root.id)
    f.wait(true)
    return { ...f, group, send, root }
  }

  it("publishes one refusal without consuming or dismissing the group's original question", async () => {
    const f = await groupQuestion()
    f.steer.mockResolvedValueOnce({ rejected: true })
    const rejected = f.send("blocked-answer")
    await vi.waitFor(() => expect(f.store.getTask(rejected.id).state).toBe("failed"))
    expect(f.store.getTask(f.root.id).state).toBe("waiting_user")
    expect(f.injections.has(rejected.id)).toBe(false)
    expect(f.dismissQuestion).not.toHaveBeenCalled()
    expect(f.store.groupMessages(f.group.id).filter((message) => message.id === `result-${rejected.id}`))
      .toEqual([expect.objectContaining({ text: "输入检查未通过，未执行这条补充消息。" })])
    f.send("blocked-answer")
    f.host.onSteeringReady(f.root.id)
    expect(f.steer).toHaveBeenCalledTimes(1)
    expect(f.store.groupMessages(f.group.id).filter((message) => message.id === `result-${rejected.id}`))
      .toHaveLength(1)
  })

  it("uses the original run, acknowledges each inbox once and publishes only its actual result", async () => {
    const f = await groupQuestion()
    const child = f.send("custom-answer")
    expect(f.store.getTask(child.id).state).toBe("queued")
    expect(f.injections.get(child.id)!()).toBe(true)
    f.send("custom-answer") // an accepted transport retry cannot reinject the message
    expect(f.steer).toHaveBeenCalledOnce()
    f.finish({ state: "completed", result: "The actual custom answer" })
    await vi.waitFor(() => expect(f.store.getTask(child.id).state).toBe("completed"))
    expect(f.store.getTask(f.root.id).state).toBe("completed")
    expect(f.acquire).toHaveBeenCalledOnce()
    expect(
      f.store.groupMessages(f.group.id).filter((message) => message.authorBotId)
    ).toMatchObject([{ text: "The actual custom answer" }])
  })

  it("offers an early answer when the original lease becomes ready without polling", async () => {
    const f = await groupQuestion(false)
    const child = f.send("early-answer")
    expect(f.steer).not.toHaveBeenCalled()
    f.host.onSteeringReady(f.root.id)
    expect(f.injections.get(child.id)!()).toBe(true)
  })

  it("does not yield a starting group conversation to unrelated private input", async () => {
    const f = await groupQuestion(false)
    f.host.send({ botId: f.bot.id, requestId: "private-first", message: "Private question" })
    expect(f.yieldToUser).not.toHaveBeenCalled()
    f.host.onSteeringReady(f.root.id)
    expect(f.yieldToUser).not.toHaveBeenCalled()
    expect(f.steer).not.toHaveBeenCalled()
    expect(f.store.getTask(f.root.id).state).toBe("waiting_user")
  })

  it("does not inject another room or a private message into this question", async () => {
    const f = await groupQuestion()
    const other = f.store.saveGroup({ name: "Other", memberIds: [f.bot.id] })
    const foreign = f.send("foreign-answer", other.id)
    const direct = f.host.send({ botId: f.bot.id, requestId: "private", message: "Private" })
    expect(f.steer).not.toHaveBeenCalled()
    expect(() => f.store.injectIntoRun(foreign.id, f.root.id)).toThrow("当前执行轮次")
    expect(() => f.store.injectIntoRun(direct.id, f.root.id)).toThrow("当前执行轮次")
    expect(f.store.getTask(foreign.id).state).toBe("queued")
    expect(f.store.getTask(direct.id).state).toBe("queued")
  })

  it("keeps ordinary group work queued and makes cancelled answers inert", async () => {
    const f = await groupQuestion()
    f.wait(false)
    const queued = f.send("ordinary-follow-up")
    expect(f.steer).not.toHaveBeenCalled()
    f.wait(true)
    const child = f.send("withdraw-answer")
    f.host.cancel(child.id)
    expect(f.injections.get(child.id)!()).toBe(false)
    expect(f.store.getTask(f.root.id).state).toBe("waiting_user")
    expect(f.store.getTask(queued.id).state).toBe("queued")
  })
})

it.each(["message", "files", "workflow", "command"] as const)(
  "keeps the consumed group answer's %s handoff without reusing pre-answer posts",
  async (kind) => {
    const f = fixture()
    const peer = f.store.create({ name: "Reviewer", instructions: "", color: "#123456", modelRef: null })
    const group = f.store.saveGroup({ name: "Answer review", memberIds: [f.bot.id, peer.id] })
    f.host.sendGroup({ groupId: group.id, requestId: "old", text: "Create report", targetBotIds: [f.bot.id] })
    const root = f.store.recentTasks().find(t => t.origin.kind === "group")!
    await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
    f.host.publishGroupMessage(root.id, "before", "@Reviewer BEFORE_ANSWER old idea")
    f.host.onSteeringReady(root.id)
    f.wait(true)
    f.host.sendGroup({ groupId: group.id, requestId: "answer", text: "PDF, then ask Reviewer", targetBotIds: [f.bot.id] })
    const answer = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "answer")!
    expect(f.injections.get(answer.id)!()).toBe(true)
    const run = { threadId: root.threadId, workspacePath: "/synthetic", runId: "report", startedAt: "2026-10-31T02:00:00Z" }
    if (kind === "workflow") f.store.acceptWorkflow(root.id, run)
    else if (kind === "command") f.store.acceptCommand(root.id, { id: "report-job", threadId: root.threadId, command: "report", cwd: "/synthetic", startedAt: 1 })
    else if (kind === "files") f.store.publishGroupFiles(root.id, "files", [{ filePath: "/synthetic/report.pdf", name: "report.pdf", size: 12 }], "@Reviewer AFTER_ANSWER review PDF")
    else f.host.publishGroupMessage(root.id, "after", "@Reviewer AFTER_ANSWER review PDF")
    f.finish({ state: "completed", result: "" })
    await vi.waitFor(() => expect(f.store.getTask(answer.id).state).toBe("completed"))
    if (kind === "workflow" || kind === "command") {
      if (kind === "workflow") f.host.enqueueNotification(f.bot.id, root.threadId, "workflow", run.runId, "Ready", group.id, run.startedAt)
      else f.store.settleCommand({ id: "report-job", threadId: root.threadId, exitCode: 0, output: "Ready", cancelled: false, truncated: false })
      const notice = f.store.recentTasks().find(t => t.origin.kind === "notification")!
      f.store.transition(notice.id, "running")
      f.store.publishGroupMessage(notice.id, "after", "@Reviewer AFTER_ANSWER review PDF")
      f.store.settle(notice.id, "completed", null, "", undefined, true)
      if (kind === "workflow") f.store.retireWorkflow(run)
    }
    f.store.advanceGroupDiscussions()
    const reviews = f.store.recentTasks().filter(t => t.botId === peer.id && t.state === "queued")
    expect(reviews).toHaveLength(1)
    expect(reviews[0].origin).toMatchObject({ kind: "discussion", messageId: "answer" })
    expect(reviews[0].message).toContain("AFTER_ANSWER")
    expect(reviews[0].message).not.toContain("BEFORE_ANSWER")
  }
)
