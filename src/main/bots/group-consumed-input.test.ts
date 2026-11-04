import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { botGroupActiveTasks } from "../../renderer/src/lib/bot-group-question"

vi.mock("../storage", () => ({ getEnabledPluginSkillSourceMetadata: () => [] }))
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function room() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  cleanups.push(() => db.close())
  const store = new BotStore(db)
  const create = (name: string) => store.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = create("Owner"), b = create("Other member")
  const group = store.saveGroup({ name: "Consumed user input", memberIds: [a.id, b.id] })
  return { store, a, b, group }
}

// Ordinary group answers join a live run. The production adapter does not
// defer this owner, so this fixture never manufactures a queued checkpoint.
async function runningGroupInput() {
  const f = room()
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let ownerId = ""
  let waiting!: (value: boolean) => void
  const release = vi.fn()
  const execute = vi.fn(async (signal: AbortSignal, onWaiting: (value: boolean) => void) => {
    waiting = onWaiting
    onWaiting(true)
    signal.addEventListener("abort", finish, { once: true })
    try {
      await pending
      return { state: "completed" as const, result: "Report verified" }
    } finally {
      signal.removeEventListener("abort", finish)
    }
  })
  const host = new LocalBotHost(f.store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.id === ownerId ? {
      execute,
      steer: async (_input, consume) => { const accepted = consume(); if (accepted) waiting(false); return accepted },
      release
    } : null
  })
  cleanups.push(async () => { finish(); await host.stop() })
  host.sendGroup({ groupId: f.group.id, requestId: "original", text: "Prepare report", targetBotIds: [f.a.id] })
  const owner = f.store.recentTasks().find(t => t.botId === f.a.id)!
  ownerId = owner.id
  await vi.waitFor(() => expect(f.store.getTask(owner.id).state).toBe("waiting_user"))
  host.onSteeringReady(owner.id)
  host.sendGroup({ groupId: f.group.id, requestId: "supplement", text: "Use CSV", targetBotIds: [f.a.id] })
  const input = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "supplement")!
  await vi.waitFor(() => expect(f.store.getTask(input.id).injectedInto).toBe(owner.id))
  expect(f.store.getTask(owner.id).state).toBe("running")
  const other = f.store.enqueue({ botId: f.b.id, requestId: "unrelated", message: "Independent task" })
  return { ...f, host, owner, input, other, execute, finish, release }
}

it.each(["selected", "stale-receipt"] as const)("stops the live execution after consuming a group answer (%s)", async mode => {
  const f = await runningGroupInput()
  const selected = botGroupActiveTasks(f.group.id, f.host.snapshot().tasks).find(t => t.botId === f.owner.botId)!
  expect(selected.id).toBe(f.owner.id)
  f.host.cancel(mode === "selected" ? selected.id : f.input.id)
  await vi.waitFor(() => expect(f.store.getTask(f.owner.id).state).toBe("cancelled"))
  expect(f.store.getTask(f.input.id).state).toBe("cancelled")
  expect(f.store.getTask(f.other.id).state).toBe("queued")
  expect(f.execute).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.store.groupMessages(f.group.id).filter(m => m.id === `result-${f.input.id}`)).toHaveLength(0)
})

it("settles the consumed answer with the live owner without another execution or result", async () => {
  const f = await runningGroupInput()
  f.finish()
  await vi.waitFor(() => expect(f.store.getTask(f.owner.id).state).toBe("completed"))
  expect(f.store.getTask(f.input.id).state).toBe("completed")
  expect(f.execute).toHaveBeenCalledOnce()
  const messages = f.store.groupMessages(f.group.id)
  expect(messages.filter(m => m.id === `result-${f.owner.id}`)).toHaveLength(1)
  expect(messages.filter(m => m.id === `result-${f.input.id}`)).toHaveLength(0)
})

it("does not stop the live owner when cancelling an unconsumed later message", async () => {
  const f = await runningGroupInput()
  f.host.sendGroup({ groupId: f.group.id, requestId: "later", text: "Separate follow-up", targetBotIds: [f.owner.botId] })
  const later = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "later")!
  expect(later.state).toBe("queued")
  expect(later.injectedInto).toBeUndefined()
  f.host.cancel(later.id)
  expect(f.store.getTask(later.id).state).toBe("cancelled")
  expect(f.store.getTask(f.owner.id).state).toBe("running")
  expect(f.store.getTask(f.input.id).state).toBe("running")
  expect(f.release).not.toHaveBeenCalled()
})

it("does not let a consumed answer block other members when its owner asks another question", () => {
  const { store, a, b, group } = room()
  store.sendGroup({ groupId: group.id, requestId: "original", text: "Collaborate", targetBotIds: [a.id, b.id] })
  const owner = store.recentTasks().find(t => t.botId === a.id)!
  const other = store.recentTasks().find(t => t.botId === b.id)!
  store.transition(owner.id, "running")
  store.transition(owner.id, "waiting_user")
  store.sendGroup({ groupId: group.id, requestId: "answer", text: "Use CSV", targetBotIds: [a.id] })
  const input = store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "answer")!
  store.injectIntoRun(input.id, owner.id)
  store.transition(owner.id, "running")
  store.transition(owner.id, "waiting_user")
  expect(store.nextQueued([owner.threadId])?.id).toBe(other.id)
  expect(store.nextQueued([])?.id).toBe(other.id)
})

it("reports one interrupted running execution after recovery, preserving its consumed user message", () => {
  const { store, a, group } = room()
  store.sendGroup({ groupId: group.id, requestId: "original", text: "Prepare report", targetBotIds: [a.id] })
  const owner = store.recentTasks()[0]
  store.transition(owner.id, "running")
  store.transition(owner.id, "waiting_user")
  store.sendGroup({ groupId: group.id, requestId: "answer", text: "Use CSV", targetBotIds: [a.id] })
  const input = store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "answer")!
  store.injectIntoRun(input.id, owner.id)
  store.transition(owner.id, "running")
  store.recover()
  expect(store.getTask(owner.id).state).toBe("interrupted")
  expect(store.getTask(input.id).state).toBe("interrupted")
  const messages = store.groupMessages(group.id)
  expect(messages.filter(m => m.id === `result-${owner.id}`)).toHaveLength(1)
  expect(messages.filter(m => m.id === `result-${input.id}`)).toHaveLength(0)
  expect(messages.some(m => m.id === "answer")).toBe(true)
  expect(store.nextQueued([])).toBeNull()
  store.recover()
  expect(store.groupMessages(group.id)).toEqual(messages)
})

it("retains uncertainty when cancellation of a peer continuation cannot be confirmed", async () => {
  const { store, a, b, group } = room()
  const errors: unknown[] = []
  const cancelCommands = vi.fn(async () => { throw new Error("No stop receipt") })
  const host = new LocalBotHost(store, { onAvailable: () => () => {}, acquire: () => null, cancelCommands }, undefined, error => errors.push(error))
  cleanups.push(() => host.stop())
  store.sendGroup({ groupId: group.id, requestId: "original", text: "Build report", targetBotIds: [a.id] })
  const root = store.recentTasks()[0]
  expect(() => store.transition(root.id, "outcome_unknown")).toThrow()
  store.transition(root.id, "running")
  const peer = store.delegate(root.id, b.id, "Build report", "delegate")
  store.settle(root.id, "completed", null, "Waiting for peer")
  store.transition(peer.id, "running")
  store.acceptCommand(peer.id, { id: "peer-command", threadId: peer.threadId, command: "build", cwd: "/tmp", startedAt: 1 }, true)
  store.deferTask(peer.id, "peer-checkpoint")
  host.cancel(peer.id)
  await vi.waitFor(() => expect(store.getTask(peer.id).state).toBe("outcome_unknown"))
  expect(store.getTask(peer.id).error).toBe("No stop receipt")
  expect(cancelCommands).toHaveBeenCalledExactlyOnceWith(peer.threadId, ["peer-command"])
  expect(errors).toHaveLength(1)
  expect(store.getTask(root.id).state).toBe("completed")
})
