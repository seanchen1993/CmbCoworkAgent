import { EventEmitter } from "node:events"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModRuntimeClient } from "../runtime-client"
import { FunctionRuntimeClient } from "./runtime-client"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))

type Client = ModRuntimeClient | FunctionRuntimeClient
const clients: Client[] = []

class Child extends EventEmitter {
  readonly kill = vi.fn(() => this.emit("exit", 0))
  readonly stdout = { resume: vi.fn() }
  postMessage(message: { type: string; id: string; runtimeId: string }): void {
    if (message.type === "load")
      queueMicrotask(() =>
        this.emit("message", {
          type: "result",
          id: message.id,
          runtimeId: message.runtimeId,
          value: []
        })
      )
  }
}

beforeEach(() => {
  fork.mockReset()
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  for (const client of clients.splice(0)) client.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function client(kind: "classic" | "function"): Client {
  const value =
    kind === "classic" ? new ModRuntimeClient("fixture") : new FunctionRuntimeClient("fixture")
  clients.push(value)
  return value
}

function load(value: Client) {
  return value instanceof ModRuntimeClient
    ? value.load("runtime", "fixture")
    : value.load("fixture")
}

function nextChild(child = new Child()): Child {
  fork.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }))
    return child
  })
  return child
}

it.each(["classic", "function"] as const)(
  "%s permits an explicit retry after synchronous fork failure without a leaked watchdog",
  async (kind) => {
    const value = client(kind)
    fork.mockImplementationOnce(() => {
      throw Error("native fork unavailable")
    })
    await expect(load(value)).rejects.toMatchObject({ code: "MODS_HOST_ERROR" })
    expect(vi.getTimerCount()).toBe(0)
    const child = nextChild()
    await expect(load(value)).resolves.toBeDefined()
    expect(fork).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  }
)

it.each(["classic", "function"] as const)(
  "%s retires a partially started utility and retries after synchronous stream setup failure",
  async (kind) => {
    const value = client(kind)
    const broken = new Child()
    broken.stdout.resume.mockImplementationOnce(() => {
      throw Error("pipe failed")
    })
    nextChild(broken)
    await expect(load(value)).rejects.toMatchObject({ code: "MODS_HOST_ERROR" })
    expect(broken.kill).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    if (value instanceof FunctionRuntimeClient) await value.stopAndDrain()
    nextChild()
    await expect(load(value)).resolves.toBeDefined()
    expect(fork).toHaveBeenCalledTimes(2)
  }
)

it.each(["classic", "function"] as const)(
  "%s ignores a retired utility's late error, exit, and ready after replacement",
  async (kind) => {
    const value = client(kind)
    const previous = nextChild()
    await load(value)
    value.stop()
    const replacement = nextChild()
    await load(value)
    previous.emit("error", Error("late native error"))
    previous.emit("exit", 1)
    previous.emit("message", { type: "ready" })
    await expect(load(value)).resolves.toBeDefined()
    expect(replacement.kill).not.toHaveBeenCalled()
    expect(fork).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  }
)
