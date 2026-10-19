import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mock.spawn }))
import { startOwnedHookCommand } from "./owned-command"

const header = "MODS_HOOK_STARTED_V1:" + "a".repeat(32) + "\n"
const footer = "MODS_HOOK_SETTLED_V1:" + "a".repeat(32) + ":0\n"

function fixture(signal?: AbortSignal) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123456789,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  mock.spawn.mockReturnValue(child)
  const stdout = vi.fn(),
    stderr = vi.fn()
  const input = {
    executable: process.execPath,
    args: ["-e", "0"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    stdin: "{}",
    stdout,
    stderr,
    signal
  }
  return { child, input, stdout, stderr }
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  mock.spawn.mockReset()
})

it("does not spawn when the original signal is already aborted", () => {
  const controller = new AbortController()
  controller.abort(new Error("NO_SPAWN"))
  expect(() => startOwnedHookCommand(fixture(controller.signal).input)).toThrow("NO_SPAWN")
  expect(mock.spawn).not.toHaveBeenCalled()
})

it.runIf(process.platform === "win32")(
  "strips chunked private READY and awaits physical close after abort",
  async () => {
    const controller = new AbortController(),
      f = fixture(controller.signal)
    const owned = startOwnedHookCommand(f.input)
    f.child.stdout.write(header.slice(0, 12))
    expect(f.stdout).not.toHaveBeenCalled()
    f.child.stdout.write(header.slice(12) + '{"decision":"allow"}')
    controller.abort()
    expect(f.child.kill).toHaveBeenCalledOnce()
    let settled = false
    void owned.completion.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit("close", null)
    expect(Buffer.concat(f.stdout.mock.calls.map(([chunk]) => chunk)).toString()).toBe(
      '{"decision":"allow"}'
    )
    expect(await owned.completion).toEqual({ code: null, error: undefined })
    owned.stop()
    expect(f.child.kill).toHaveBeenCalledOnce()
  }
)

it.runIf(process.platform === "win32")(
  "never reports a successful execution when owned cleanup cannot be confirmed",
  async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.child.kill.mockReturnValue(false)
    const owned = startOwnedHookCommand(f.input)
    const failure = expect(owned.completion).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
    owned.stop()
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    // A late close must not turn the already rejected execution into a successful one.
    f.child.emit("close", 0)
    await expect(owned.completion).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
  }
)

it.runIf(process.platform === "win32")(
  "rejects malformed startup protocol without publishing it as Hook JSON",
  async () => {
    const f = fixture(),
      owned = startOwnedHookCommand(f.input)
    f.child.stdout.write('{"decision":"allow","notController":true,"padding":"xxxxxxxxxxxxxxxx"}')
    expect(f.stdout).not.toHaveBeenCalled()
    expect(f.child.kill).toHaveBeenCalledOnce()
    f.child.emit("close", 0)
    expect((await owned.completion).error?.message).toBe("HOOK_PROCESS_START_UNCONFIRMED")
  }
)

it.runIf(process.platform === "win32")(
  "normal exit racing cancellation cannot kill a later PID",
  async () => {
    const controller = new AbortController(),
      f = fixture(controller.signal)
    const owned = startOwnedHookCommand(f.input)
    f.child.stdout.write(header + footer)
    f.child.emit("close", 0)
    controller.abort()
    owned.stop()
    expect((await owned.completion).code).toBe(0)
    expect(f.child.kill).not.toHaveBeenCalled()
  }
)

it("preserves Unix detached group escalation when the launcher exits first", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "linux" })
  vi.useFakeTimers()
  const kill = vi.spyOn(process, "kill").mockReturnValue(true)
  try {
    const f = fixture(),
      owned = startOwnedHookCommand(f.input)
    expect(mock.spawn.mock.calls[0][2].detached).toBe(true)
    f.child.emit("exit", 0)
    f.child.emit("close", 0)
    let settled = false
    void owned.completion.then(() => {
      settled = true
    })
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(110)
    expect((await owned.completion).code).toBe(0)
    expect(kill.mock.calls).toEqual([
      [-f.child.pid, "SIGTERM"],
      [-f.child.pid, "SIGKILL"]
    ])
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
})

it("Unix group permission failure stays unconfirmed after launcher exit zero", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "linux" })
  vi.useFakeTimers()
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" })
  })
  try {
    const f = fixture(),
      owned = startOwnedHookCommand(f.input)
    const failure = expect(owned.completion).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
    f.child.emit("exit", 0)
    f.child.emit("close", 0)
    await vi.advanceTimersByTimeAsync(110)
    await failure
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
})

it.runIf(process.platform === "win32")(
  "native missing/mismatched private settlement cannot be replaced by child output",
  async () => {
    const f = fixture(),
      owned = startOwnedHookCommand(f.input)
    const failure = expect(owned.completion).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
    f.child.stdout.write(header + "MODS_HOOK_SETTLED_V1:" + "b".repeat(32) + ":0\n")
    f.child.emit("close", 125)
    await failure
  }
)

it.runIf(process.platform === "win32")(
  "a child exit125 with a real native settlement stays an ordinary process error",
  async () => {
    const f = fixture(),
      owned = startOwnedHookCommand(f.input)
    f.child.stdout.write(header + "child output" + footer)
    f.child.emit("close", 125)
    expect(await owned.completion).toEqual({ code: 125, error: undefined })
    expect(Buffer.concat(f.stdout.mock.calls.map(([chunk]) => chunk)).toString()).toBe(
      "child output"
    )
  }
)

it.runIf(process.platform === "win32")(
  "owner stop before READY still waits exact Job controller close",
  async () => {
    const controller = new AbortController(),
      f = fixture(controller.signal)
    const owned = startOwnedHookCommand(f.input)
    controller.abort()
    expect(f.child.kill).toHaveBeenCalledOnce()
    let settled = false
    void owned.completion.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit("close", null)
    expect((await owned.completion).error?.message).toBe("HOOK_PROCESS_START_UNCONFIRMED")
  }
)
