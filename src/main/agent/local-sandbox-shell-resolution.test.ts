import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { createDeepAgent, getSystemPrompt } from "./runtime"

type SandboxMode = "none" | "unelevated" | "readonly" | "elevated"
interface ShellResolutionState {
  _cachedResolvedShell: string | null
  _resolvedShellPromise: Promise<string> | null
  _cachedSandboxShell: { shell: string; flags: string[] } | null
  _sandboxShellPromise: Promise<{ shell: string; flags: string[] }> | null
}

const state = LocalSandbox as unknown as ShellResolutionState
const git = "C:\\Program Files\\Git\\cmd\\git.EXE"
const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
const pwsh = "C:\\Windows\\System32\\pwsh.EXE"
const powershell = "C:\\Windows\\System32\\powershell.EXE"
const cmd = "C:\\Windows\\System32\\cmd.exe"
const runtimeSource = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8")
let savedState: ShellResolutionState
let savedPlatform: PropertyDescriptor

beforeEach(() => {
  savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
  savedState = {
    _cachedResolvedShell: state._cachedResolvedShell,
    _resolvedShellPromise: state._resolvedShellPromise,
    _cachedSandboxShell: state._cachedSandboxShell,
    _sandboxShellPromise: state._sandboxShellPromise
  }
  Object.assign(state, {
    _cachedResolvedShell: null,
    _resolvedShellPromise: null,
    _cachedSandboxShell: null,
    _sandboxShellPromise: null
  })
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  vi.spyOn(path, "join").mockImplementation(path.win32.join)
  vi.spyOn(path, "basename").mockImplementation(path.win32.basename)
  vi.stubEnv("SHELL", "")
  vi.stubEnv("GIT_BASH_PATH", "")
  vi.stubEnv("COMSPEC", cmd)
  vi.stubEnv("PATH", "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32")
  vi.stubEnv("PATHEXT", ".EXE")
  vi.stubEnv("ProgramFiles", "C:\\Program Files")
  vi.stubEnv("ProgramFiles(x86)", "")
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Object.defineProperty(process, "platform", savedPlatform)
  Object.assign(state, savedState)
})

function mockFiles(files: string[]) {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if (!present.has(String(file).toLowerCase())) throw new Error("ENOENT")
  })
}

function resolvedPath(mode: SandboxMode): string {
  return mode === "none" ? LocalSandbox.resolvedShell() : LocalSandbox.resolvedWindowsSandboxShell()
}

describe("Shell readiness before environment prompts", () => {
  it.each([
    { mode: "none", files: [git, bash], expected: bash },
    { mode: "none", files: [bash], expected: bash },
    { mode: "none", files: [], expected: cmd },
    { mode: "unelevated", files: [git, bash, pwsh, powershell], expected: pwsh },
    { mode: "readonly", files: [pwsh], expected: pwsh },
    { mode: "elevated", files: [pwsh], expected: pwsh },
    { mode: "unelevated", files: [powershell], expected: powershell },
    { mode: "elevated", files: [git, bash], expected: cmd }
  ] as const)("resolves $mode to $expected before rendering", async ({ mode, files, expected }) => {
    const access = mockFiles([...files])
    await LocalSandbox.ensureShellReady(mode)
    expect(resolvedPath(mode)).toBe(expected)
    const probeCount = access.mock.calls.length
    await LocalSandbox.ensureShellReady(mode)
    expect(access).toHaveBeenCalledTimes(probeCount)

    const name = path.win32
      .basename(expected)
      .replace(/\.exe$/i, "")
      .toLowerCase()
    for (const toolStrategy of ["standard", "shell-first"] as const) {
      const prompt = getSystemPrompt("C:\\workspace", mode, {
        toolStrategy,
        includeCurrentTime: false,
        includeMemory: false,
        includeSubagents: false
      })
      let finalPrompt = ""
      createDeepAgent({
        model: "test-model",
        systemPrompt: prompt,
        mainFilesystemEnabled: false,
        mainSubagentsEnabled: false,
        mainTodosEnabled: false,
        includeGeneralPurposeSubagent: false,
        onFinalSystemPrompt: (value) => {
          finalPrompt = value
        }
      })
      expect(finalPrompt).toContain(`- Default shell: ${name}\n`)
      expect(finalPrompt.includes("Use cmd.exe syntax")).toBe(name === "cmd")
      expect(finalPrompt.includes("Commands run in PowerShell (not bash)")).toBe(
        name === "pwsh" || name === "powershell"
      )
      expect(finalPrompt.includes("Use Unix/bash commands")).toBe(name === "bash")
    }
  })

  it.each(["SHELL", "GIT_BASH_PATH"])("preserves explicit %s without probing", async (key) => {
    const access = mockFiles([])
    vi.stubEnv(key, bash)
    await LocalSandbox.ensureShellReady("none")
    expect(resolvedPath("none")).toBe(bash)
    expect(access).not.toHaveBeenCalled()
  })

  it.each(["none", "unelevated"] as const)(
    "waits for and shares the in-flight %s discovery",
    async (mode) => {
      const access = mockFiles([git, bash, pwsh])
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const probe = access.getMockImplementation()!
      access.mockImplementationOnce(async (...args) => {
        await gate
        return probe(...args)
      })
      let completed = 0
      const first = LocalSandbox.ensureShellReady(mode).then(() => completed++)
      const second = LocalSandbox.ensureShellReady(mode).then(() => completed++)
      try {
        await Promise.resolve()
        expect(completed).toBe(0)
        expect(access).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await Promise.all([first, second])
      }
      expect(completed).toBe(2)
      expect(resolvedPath(mode)).toBe(mode === "none" ? bash : pwsh)
    }
  )

  it.each(["darwin", "linux"])("leaves %s initialization unchanged", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true })
    const access = mockFiles([])
    await LocalSandbox.ensureShellReady("none")
    expect(access).not.toHaveBeenCalled()
    expect(state._cachedResolvedShell).toBeNull()
    expect(state._cachedSandboxShell).toBeNull()
  })

  it("awaits readiness before constructing the backend and both runtime prompts", () => {
    const runtime = runtimeSource.slice(
      runtimeSource.indexOf("export async function createAgentRuntime(")
    )
    const ready = runtime.indexOf("await LocalSandbox.ensureShellReady(windowsSandbox)")
    expect(ready).toBeGreaterThanOrEqual(0)
    expect(ready).toBeLessThan(runtime.indexOf("new LocalSandbox("))
    expect(ready).toBeLessThan(runtime.indexOf("getSystemPrompt(fileRoot, windowsSandbox"))
    expect(ready).toBeLessThan(runtime.indexOf("getShellInfo(windowsSandbox)"))
  })
})
