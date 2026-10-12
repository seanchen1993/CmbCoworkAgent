import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ExecuteResponse } from "deepagents"
import { createLocalSandboxClass, type WindowsSandboxMode } from "./local-sandbox-core"
import type { LocalSandboxServices } from "./local-sandbox-services"

const spawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn
}))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  spawn.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const services: LocalSandboxServices = {
  areElevatedRootsPreparedAsync: async () => true,
  isElevatedSetupComplete: async () => true,
  markElevatedRootsPrepared: () => undefined,
  runElevatedSetupForPaths: async () => ({ success: true }),
  normalizeDirKey: (path) => resolve(path).toLowerCase(),
  getElevatedSystemSensitivePathError: () => null,
  validateElevatedWorkspaceRoot: async (path) => ({ ok: true, resolved: path }),
  getWindowsSandboxMode: () => "elevated"
}

interface WindowsExecutor {
  executeInWindowsSandbox(
    command: string,
    attempt?: number,
    mode?: WindowsSandboxMode,
    timeoutMs?: number,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<ExecuteResponse>
  executeRawUnserialized(
    command: string,
    mode?: WindowsSandboxMode,
    timeoutMs?: number,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<ExecuteResponse>
}

async function fixture(preserveSandboxMode: boolean, pluginRoot?: string) {
  const root = await mkdtemp(join(tmpdir(), "cmb-sandbox-preserve-mode-"))
  roots.push(root)
  const Sandbox = createLocalSandboxClass(services)
  // Keep the real execution/automatic retry branch. Only native setup, shell
  // discovery and OS spawning are replaced; no Windows machine is required.
  const replace = (name: string, implementation: unknown) => {
    expect(typeof Reflect.get(Sandbox, name), name).toBe("function")
    Reflect.set(Sandbox, name, implementation)
  }
  replace("prewarmForWorkspace", () => undefined)
  replace("prewarmElevatedWorkspaceRoots", async () => undefined)
  replace("waitForElevatedRootsPrepared", async () => undefined)
  replace("prepareSandboxCacheDirs", async () => [])
  replace("buildSandboxEnv", async () => ({}))
  replace("resolveWindowsSandboxShell", async () => ({ shell: "powershell.exe", flags: [] }))
  replace("shouldPreferUnelevated", async () => false)
  const sandbox = new Sandbox({
    rootDir: root,
    env: {},
    windowsSandbox: "elevated",
    codexExePath: "fixture-codex.exe",
    preserveSandboxMode,
    retrySpawnFailures: false,
    pluginRoot,
    timeout: 1000
  })
  return { sandbox, internal: sandbox as unknown as WindowsExecutor, root }
}

it.each(["Access is denied", "certificate_verify_failed"])(
  "does not change a pinned sandbox or repeat a command after its first execution reports %s",
  async (output) => {
    const { internal, root } = await fixture(true)
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdout: new PassThrough(),
        stderr: new PassThrough()
      })
      queueMicrotask(() => {
        child.stdout.write(output)
        child.emit("close", 1, null)
      })
      return child
    })
    const execute = internal.executeInWindowsSandbox.bind(internal)
    const retry = vi.fn(async () => ({ output: "second execution", exitCode: 0, truncated: false }))
    internal.executeInWindowsSandbox = retry
    expect(await execute("build-tool do-work", 1, "elevated", 1000, undefined, root)).toEqual({
      output,
      exitCode: 1,
      truncated: false
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![1]).toContain('windows.sandbox="elevated"')
    expect(retry).not.toHaveBeenCalled()
  }
)

it("retains the existing desktop fallback when sandbox mode preservation is not requested", async () => {
  const { internal, root } = await fixture(false)
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    queueMicrotask(() => {
      child.stdout.write("Access is denied")
      child.emit("close", 1, null)
    })
    return child
  })
  const execute = internal.executeInWindowsSandbox.bind(internal)
  const retry = vi.fn(async () => ({ output: "desktop retry", exitCode: 0, truncated: false }))
  internal.executeInWindowsSandbox = retry
  expect(await execute("build-tool do-work", 1, "elevated", 1000, undefined, root)).toEqual({
    output: "desktop retry",
    exitCode: 0,
    truncated: false
  })
  expect(retry).toHaveBeenCalledExactlyOnceWith(
    "build-tool do-work",
    1,
    "unelevated",
    1000,
    undefined,
    root,
    undefined
  )
})

it.each([true, false])(
  "keeps project Hook bypass within the mode preservation contract (%s)",
  async (preserve) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const plugin = "C:\\project-plugin"
    const { internal, root } = await fixture(preserve, plugin)
    const execute = internal.executeRawUnserialized.bind(internal)
    const direct = vi.fn(async () => ({ output: "outside", exitCode: 0, truncated: false }))
    const protectedExecute = vi.fn(async () => ({
      output: "sandbox",
      exitCode: 0,
      truncated: false
    }))
    internal.executeRawUnserialized = direct
    internal.executeInWindowsSandbox = protectedExecute
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true })
      const command = 'powershell -File "C:\\project-plugin\\hooks\\inspect.ps1"'
      expect(await execute(command, "elevated", 1000, undefined, root)).toMatchObject({
        output: preserve ? "sandbox" : "outside"
      })
      expect(direct).toHaveBeenCalledTimes(preserve ? 0 : 1)
      expect(protectedExecute).toHaveBeenCalledTimes(preserve ? 1 : 0)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  }
)
