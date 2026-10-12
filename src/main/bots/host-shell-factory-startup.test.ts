import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { mkdtemp, writeFile, realpath, readdir, rm } from "node:fs/promises"
import childProcess from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
const prepare = vi.hoisted(() => ({
  windows: vi.fn(async (...args: unknown[]) => {
    void args
    throw new Error("Windows native preparation unavailable")
  }),
  mac: vi.fn(async (...args: unknown[]) => {
    void args
    throw new Error("Mac command preparation must not run")
  }),
  linux: vi.fn(async (...args: unknown[]) => {
    void args
    throw new Error("Linux native preparation unavailable")
  })
}))
vi.mock("./windows-host-shell-factory", () => ({
  createWindowsBotHostShellFactory: prepare.windows
}))
vi.mock("./linux-host-shell-factory", () => ({
  createLinuxBotHostShellFactory: prepare.linux
}))
vi.mock("./mac-shell-sandbox", () => ({
  prepareMacBotShell: prepare.mac
}))
import { createBotHostShellFactory, type BotHostShellBinding } from "./host-shell-factory"
import { BotShellProcess, BotShellPreparationError } from "./shell-process"
import type { BotShellOwnedFactory } from "./shell-process"
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-startup-")))
  prepare.windows.mockClear()
  prepare.linux.mockClear()
  prepare.mac.mockClear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
test.each(["win32", "linux"] as const)(
  "%s configured but unavailable native preparation preserves chat startup; first command rejects",
  async (platform) => {
    const originalProcess = process
    vi.stubGlobal(
      "process",
      new Proxy(originalProcess, {
        get(target, key, receiver) {
          return key === "platform" ? platform : Reflect.get(target, key, receiver)
        }
      })
    )
    const helperEntry = join(root, "helper.js"),
      workerEntry = join(root, "worker.js")
    await writeFile(helperEntry, "// fixed fixture\n", { mode: 0o600 })
    await writeFile(workerEntry, "// fixed fixture\n", { mode: 0o600 })
    const owner = vi.fn(async () => {})
    const binding = {
      directory: root,
      helperEntry,
      workerEntry,
      hostId: () => "host",
      dataEpoch: () => "epoch",
      assertOwnership: owner,
      [platform === "win32" ? "windowsNative" : "linuxNative"]: {}
    } as BotHostShellBinding
    const factory = await createBotHostShellFactory(binding)
    const prepareNative = platform === "win32" ? prepare.windows : prepare.linux
    expect(prepareNative).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    await expect(factory({} as Parameters<BotShellOwnedFactory>[0], signal)).rejects.toThrow(
      "preparation unavailable"
    )
    expect(prepareNative).toHaveBeenCalledTimes(1)
    expect(owner).toHaveBeenCalledTimes(1)
    expect(prepareNative.mock.calls[0]?.[2]).toHaveProperty("signal", signal)
  }
)

test("Mac production rejects command capability before artifact preparation or spawn", async () => {
  const originalProcess = process
  vi.stubGlobal(
    "process",
    new Proxy(originalProcess, {
      get(target, key, receiver) {
        return key === "platform" ? "darwin" : Reflect.get(target, key, receiver)
      }
    })
  )
  // Existing test/runtime flags cannot grant the production Host a command backend.
  vi.stubEnv("CMB_BOT_PROCESS_TEST", "1")
  vi.stubEnv("CMB_BOT_SHELL_TEST_COMPILED", "1")
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    throw new Error("Mac production must reject before spawning")
  })
  const platformFactory = vi.fn(async () => {
    throw new Error("A binding-supplied factory must not enable Mac production commands")
  })
  const factory = await createBotHostShellFactory({
    directory: root,
    // No helper/worker artifacts exist: disabling commands must not require them.
    helperEntry: join(root, "absent-helper.js"),
    workerEntry: join(root, "absent-worker.js"),
    hostId: () => "mac-production-host",
    dataEpoch: () => "epoch",
    assertOwnership: vi.fn(async () => {}),
    platformFactory
  })
  const runner = new BotShellProcess(factory)
  const request = {
    command: "node should-not-run.cjs",
    cwd: root,
    runId: "mac-production-scope",
    timeoutMs: 1000,
    execution: { windowsSandbox: "none" as const, resourceDirectory: root }
  }
  expect(factory.unavailableReason).toBeTruthy()
  expect(runner.available).toBe(false)
  expect(() => runner.assertAvailable()).toThrowError(
    expect.objectContaining({ code: "shell_unavailable" })
  )
  await expect(factory(request, new AbortController().signal)).rejects.toMatchObject({
    code: "shell_unavailable"
  })
  const operation = runner.start(request, new AbortController().signal)
  const [admitted, completed] = await Promise.allSettled([operation.admitted, operation.completion])
  expect(admitted.status).toBe("rejected")
  expect(completed.status).toBe("rejected")
  if (admitted.status !== "rejected" || completed.status !== "rejected")
    throw new Error("Disabled production commands must reject admission and completion")
  expect(admitted.reason).toBeInstanceOf(BotShellPreparationError)
  expect(completed.reason).toMatchObject({
    code: "shell_unavailable",
    cancelled: false
  })
  expect(platformFactory).not.toHaveBeenCalled()
  expect(prepare.mac).not.toHaveBeenCalled()
  expect(prepare.windows).not.toHaveBeenCalled()
  expect(prepare.linux).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
