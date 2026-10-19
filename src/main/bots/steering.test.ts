import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunLease, type BotRunPort } from "./host"

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
    wait: (value: boolean) => waiting(value)
  }
}

async function running(f: ReturnType<typeof fixture>) {
  const root = f.host.send({ botId: f.bot.id, requestId: "root", message: "Original goal" })
  await vi.waitFor(() => expect(f.store.getTask(root.id).state).toBe("running"))
  f.host.onSteeringReady(root.id)
  return root
}

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
