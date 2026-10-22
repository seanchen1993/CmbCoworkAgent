import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease, type BotRunPort } from "./host"
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
  const host = new LocalBotHost(store, { acquire, onAvailable: () => () => {} })
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
  it.each(["direct", "forwarded"] as const)(
    "injects a %s revision into an autonomously created task and returns the actual context",
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
        { taskId: source.id, callId: "create", key: "create" }
      )
      f.store.settle(source.id, "completed", null, "Started")
      await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe("running"))
      f.host.onSteeringReady(task.id)
      f.wait(true)
      const revision = "Change the time to four; keep the directory"
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
              "Edit plan"
            )
            return { state: "completed", result: "Forwarded" }
          },
          release: vi.fn()
        }))
        f.host.send({ botId: f.bot.id, requestId: "main", message: revision })
        await vi.waitFor(() => expect(child).toBeDefined())
      }
      expect(f.injections.has(child.id)).toBe(true)
      expect(f.injections.get(child.id)!()).toBe(true)
      expect(f.store.getTask(child.id).state).toBe("running")
      expect(f.store.getTask(child.id).threadId).toBe(work.threadId)
      f.finish({ state: "completed", result: "Plan at four" })
      await vi.waitFor(() => expect(f.store.getTask(child.id).state).toBe("completed"))
      const report = f.store.recentTasks().find((item) => item.origin.kind === "work_result")
      expect(report?.message).toContain(revision)
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
})

describe("Bot messages during a user run", () => {
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
    f.host.onSteeringReady(intro.id)
    const child = f.host.send({ botId: f.bot.id, requestId: "first-user", message: "Start here" })
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

  it("preserves early private-inbox priority during group startup", async () => {
    const f = await groupQuestion(false)
    f.host.send({ botId: f.bot.id, requestId: "private-first", message: "Private question" })
    expect(f.yieldToUser).not.toHaveBeenCalled()
    f.host.onSteeringReady(f.root.id)
    expect(f.yieldToUser).toHaveBeenCalledOnce()
    expect(f.yieldToUser.mock.calls[0][0]()).toBe(true)
    expect(f.steer).not.toHaveBeenCalled()
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
