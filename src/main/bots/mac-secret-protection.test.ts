import { afterEach, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { MacBotSecretProtection } from "./mac-secret-protection"
import { BOT_MAC_SECRET_HELPER_FLAG, BOT_SECRET_CIPHER_LIMIT } from "./mac-secret-protocol"

const spawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn }))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  spawn.mockReset()
})
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [] as PassThrough[],
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => true)
  })
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
  spawn.mockReturnValue(child)
  const provider = new MacBotSecretProtection(
    "/Applications/CMBDevClaw.app/Contents/MacOS/CMBDevClaw",
    "/app root"
  )
  cleanup.push(() => provider.close())
  const received: Buffer[] = []
  child.stdin.on("data", (bytes) => received.push(Buffer.from(bytes)))
  return {
    child,
    provider,
    request: () => JSON.parse(Buffer.concat(received).toString()),
    complete(bytes: string, code = 0) {
      child.stdout.write(bytes)
      child.exitCode = code
      child.emit("close", code)
    }
  }
}

it("uses the same app identity, private pipes and a sanitized Electron environment", async () => {
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1")
  vi.stubEnv("NODE_OPTIONS", "--require injected")
  vi.stubEnv("PRIVATE_KEY", "SECRET_VALUE")
  const f = fixture(),
    bytes = Buffer.from("SECRET_VALUE")
  const result = f.provider.protect(bytes)
  const [executable, args, options] = spawn.mock.calls[0]
  expect(executable).toContain("CMBDevClaw.app/Contents/MacOS/CMBDevClaw")
  expect(args).toEqual(["/app root", BOT_MAC_SECRET_HELPER_FLAG])
  expect(options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"])
  expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE")
  expect(options.env).not.toHaveProperty("NODE_OPTIONS")
  expect(JSON.stringify(spawn.mock.calls)).not.toContain("SECRET_VALUE")
  expect(f.request()).toEqual({ version: 1, operation: "protect", data: bytes.toString("base64") })
  f.complete(Buffer.from("cipher").toString("base64"))
  expect(await result).toEqual(Buffer.from("cipher"))
  expect(f.child.kill).not.toHaveBeenCalled()
})

it("supports decrypt and discards native stderr", async () => {
  const f = fixture(),
    result = f.provider.unprotect(Buffer.from("cipher"))
  expect(f.request().operation).toBe("unprotect")
  f.child.stderr.write("PRIVATE_NATIVE_ERROR")
  f.complete(Buffer.from("decrypted").toString("base64"))
  expect(await result).toEqual(Buffer.from("decrypted"))
})

it.each(["invalid", "oversized", "exit", "signal", "spawn", "pipe"])(
  "rejects %s without reflecting helper content",
  async (mode) => {
    const f = fixture(),
      pending = f.provider.protect(Buffer.from("private"))
    const result = expect(pending).rejects.toThrow(/macOS 凭据保护/)
    if (mode === "invalid") f.complete("PRIVATE_NATIVE_ERROR")
    if (mode === "oversized")
      f.child.stdout.write(Buffer.alloc(Math.ceil(BOT_SECRET_CIPHER_LIMIT / 3) * 4 + 1))
    if (mode === "exit") f.complete("PRIVATE_NATIVE_ERROR", 1)
    if (mode === "signal") {
      f.child.signalCode = "SIGKILL"
      f.child.emit("close", null)
    }
    if (mode === "spawn") f.child.emit("error", new Error("PRIVATE_NATIVE_ERROR"))
    if (mode === "pipe") f.child.stdin.emit("error", new Error("PRIVATE_NATIVE_ERROR"))
    await result
  }
)

it("bounds a blocked Keychain process and ignores late replies", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    result = expect(f.provider.protect(Buffer.from("value"))).rejects.toThrow("超时")
  await vi.advanceTimersByTimeAsync(25_000)
  await result
  expect(f.child.kill).toHaveBeenCalledWith("SIGKILL")
  f.child.emit("close", 0)
  expect(vi.getTimerCount()).toBe(0)
})

it("cancels active native work at shutdown and refuses queued work", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    result = expect(f.provider.protect(Buffer.from("value"))).rejects.toThrow("关闭")
  await expect(f.provider.protect(Buffer.from("second"))).rejects.toThrow("繁忙")
  f.provider.close()
  await result
  expect(f.child.kill).toHaveBeenCalledWith("SIGKILL")
  await expect(f.provider.unprotect(Buffer.from("cipher"))).rejects.toThrow("关闭")
  expect(vi.getTimerCount()).toBe(0)
  expect(f.child.stdio.every((stream) => stream.destroyed)).toBe(true)
})

it("refuses invalid input without launching and permits a fresh request after a failed process", async () => {
  const f = fixture()
  await expect(f.provider.protect(Buffer.alloc(0))).rejects.toThrow("限额")
  expect(spawn).not.toHaveBeenCalled()
  const failure = expect(f.provider.protect(Buffer.from("value"))).rejects.toThrow("失败")
  f.complete("", 1)
  await failure
  spawn.mockImplementationOnce(() => {
    throw new Error("PRIVATE_LAUNCH_ERROR")
  })
  await expect(f.provider.protect(Buffer.from("retry"))).rejects.toThrow("无法启动")
  expect(spawn).toHaveBeenCalledTimes(2)
})
