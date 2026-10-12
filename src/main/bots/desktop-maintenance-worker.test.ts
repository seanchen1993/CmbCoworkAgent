import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const f = vi.hoisted(() => ({ spawn: vi.fn(), maintenance: vi.fn() }))
vi.mock("./owned-maintenance-process", () => ({ spawnOwnedMaintenanceProcess: f.spawn }))
vi.mock("./desktop-client", () => ({ withDesktopBotMaintenance: f.maintenance }))
import {
  desktopComputerMaintenanceProgress,
  runDesktopMaintenanceWorker
} from "./desktop-maintenance-worker"
let child: EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
}
let terminate: ReturnType<typeof vi.fn>
let active = false
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] })
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123
  })
  terminate = vi.fn()
  f.spawn.mockReset().mockReturnValue({ child, terminate, maintenancePid: child.pid })
  f.maintenance.mockReset().mockImplementation(async (operation) => {
    active = true
    try {
      return await operation()
    } finally {
      active = false
    }
  })
})
afterEach(() => {
  child.emit("close", 1)
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  vi.clearAllTimers()
  vi.useRealTimers()
})
function start() {
  const input = { action: "create", nonce: randomUUID() }
  const pending = runDesktopMaintenanceWorker(
    "bot-computer-checkpoint",
    "/fixture",
    input,
    (value) => value as { action: string }
  ).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error })
  )
  return { input, pending }
}
function progress(input: { action: string; nonce: string }) {
  return {
    format: 1,
    owner: {
      pid: 123,
      hostTokenSha256: "a".repeat(64),
      root: { dev: "1", ino: "2" },
      lock: { dev: "1", ino: "3" }
    },
    nonce: input.nonce,
    operation: input.action,
    phase: "capture",
    component: "shared",
    activity: "file-io",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    entries: 0,
    bytes: 0
  }
}
const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n")

it("keeps maintenance admission until exit and exposes only current public progress", async () => {
  const { input, pending } = start()
  const value = progress(input)
  emit({ type: "progress", value })
  expect(desktopComputerMaintenanceProgress()).toMatchObject({ nonce: input.nonce, entries: 0 })
  expect(desktopComputerMaintenanceProgress()).not.toHaveProperty("owner")
  expect(active).toBe(true)
  emit({ type: "result", ok: true, result: { action: "create" } })
  expect(active).toBe(true)
  child.emit("close", 0)
  expect(await pending).toEqual({ result: { action: "create" }, error: null })
  expect(active).toBe(false)
  expect(desktopComputerMaintenanceProgress()).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  expect(terminate).toHaveBeenCalledOnce()
})

it.each(["pid", "nonce"])(
  "rejects %s-mismatched progress and holds admission until the owned tree exits",
  async (kind) => {
    const { input, pending } = start()
    const value = progress(input)
    if (kind === "pid") value.owner.pid++
    else value.nonce = randomUUID()
    emit({ type: "progress", value })
    expect(terminate).toHaveBeenCalledOnce()
    expect(active).toBe(true)
    child.emit("close", 1)
    expect((await pending).error).toMatchObject({ message: expect.stringContaining("当前操作") })
    expect(active).toBe(false)
  }
)

it("stops stalled file I/O despite live heartbeats", async () => {
  const { input, pending } = start()
  const value = progress(input)
  emit({ type: "progress", value })
  for (let sequence = 2; sequence <= 25; sequence++) {
    await vi.advanceTimersByTimeAsync(5000)
    emit({ type: "progress", value: { ...value, sequence, updatedAt: Date.now() } })
  }
  expect(terminate).toHaveBeenCalled()
  expect(active).toBe(true)
  child.emit("close", 1)
  expect((await pending).error.message).toContain("超时")
})

it("allows a live isolated SQLite phase beyond file idle and stops when its owner disappears", async () => {
  const { input, pending } = start()
  const value = { ...progress(input), activity: "native-sqlite" }
  emit({ type: "progress", value })
  for (let sequence = 2; sequence <= 26; sequence++) {
    await vi.advanceTimersByTimeAsync(5000)
    emit({ type: "progress", value: { ...value, sequence, updatedAt: Date.now() } })
  }
  expect(terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(11_000)
  expect(terminate).toHaveBeenCalled()
  child.emit("close", 1)
  expect((await pending).error.message).toContain("超时")
})

it("does not confirm a successful frame if the worker subsequently crashes", async () => {
  const { pending } = start()
  emit({ type: "result", ok: true, result: { action: "create" } })
  child.emit("close", 1)
  expect((await pending).error.message).toContain("未确认完成")
})

it("retains the typed incomplete result so the original request can be retried", async () => {
  const { pending } = start()
  emit({
    type: "result",
    ok: false,
    error: { code: "computer_checkpoint_incomplete", definitive: false, message: "结果尚未确认" }
  })
  child.emit("close", 1)
  expect((await pending).error).toMatchObject({
    code: "computer_checkpoint_incomplete",
    diagnostic: { code: "computer_checkpoint_incomplete" }
  })
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps a process error fenced until close and terminates the owned descendants", async () => {
  const { pending } = start()
  child.emit("error", new Error("launch interrupted"))
  expect(active).toBe(true)
  expect(terminate).toHaveBeenCalledOnce()
  child.emit("close", 1)
  expect((await pending).error.message).toBe("launch interrupted")
  expect(active).toBe(false)
  expect(terminate).toHaveBeenCalledTimes(2)
})
