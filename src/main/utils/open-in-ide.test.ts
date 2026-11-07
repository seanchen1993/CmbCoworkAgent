import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupportedIde } from "../types"

const testState = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
  configuredPaths: {} as Partial<Record<SupportedIde, string>>,
  macPaths: new Set<string>()
}))

vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof import("fs")>()
  return { ...actual, existsSync: (path: import("fs").PathLike) =>
    typeof path === "string" && testState.macPaths.has(path) || actual.existsSync(path) }
})

vi.mock("path", async importOriginal => {
  const actual = await importOriginal<typeof import("path")>()
  return { ...actual,
    join: (...paths: string[]) => process.platform === "darwin"
      ? actual.posix.join(...paths) : actual.join(...paths),
    normalize: (path: string) => process.platform === "darwin"
      ? actual.posix.normalize(path) : actual.normalize(path) }
})

vi.mock("child_process", () => ({
  execFile: testState.mockExecFile,
  spawn: testState.mockSpawn
}))

vi.mock("../storage", () => ({
  getConfiguredIdeExecutablePath: (ide: SupportedIde) => testState.configuredPaths[ide] ?? null,
  getIdeSettings: () => ({ preferredIde: "webstorm", executablePaths: testState.configuredPaths }),
  saveIdeSettings: vi.fn()
}))

import { configurePreferredIde, invalidatePendingIdeConfiguration, openIde } from "./open-in-ide"
import { saveIdeSettings } from "../storage"

const { mockExecFile, mockSpawn } = testState

type MockChildProcess = EventEmitter & {
  unref: ReturnType<typeof vi.fn>
}

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  })
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.unref = vi.fn()
  return child
}

describe("openIde", () => {
  beforeEach(() => {
    testState.configuredPaths = {}
    testState.macPaths = new Set([
      "/Applications/WebStorm.app", "/Applications/WebStorm.app/Contents/MacOS/webstorm"
    ])
    mockSpawn.mockReset()
    mockExecFile.mockReset()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it("keeps the event loop free while PATH detection waits, preserving fallback order", async () => {
    setPlatform("win32")
    vi.stubEnv("CMB_WEBSTORM_BIN", "")
    vi.stubEnv("CMB_LOCAL_IDE", "")
    vi.stubEnv("OPENWORK_IDE", "")
    const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = []
    mockExecFile.mockImplementation((_cmd, _args, _options, callback) => { callbacks.push(callback) })
    vi.mocked(saveIdeSettings).mockImplementation(settings => ({
      preferredIde: settings.preferredIde ?? "webstorm", executablePaths: settings.executablePaths ?? {}
    }))
    try {
      const result = configurePreferredIde({ preferredIde: "webstorm" })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(mockExecFile).toHaveBeenCalledTimes(1)
      expect(mockExecFile.mock.calls[0].slice(0, 3)).toEqual([
        "where.exe", ["webstorm64.exe"], { encoding: "utf-8", windowsHide: true, timeout: 2000 }
      ])
      callbacks[0](Error("lookup timed out"), "", "")
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(mockExecFile.mock.calls[1][1]).toEqual(["webstorm.exe"])
      callbacks[1](null, "D:\\IDE\\webstorm.exe\r\nD:\\other.exe", "")
      await expect(result).resolves.toMatchObject({ status: "configured",
        settings: { executablePaths: { webstorm: "D:\\IDE\\webstorm.exe" } } })
      expect(mockExecFile).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllEnvs() }
  })

  it.each(["saved", "invalid", "direct-preference"] as const)(
    "does not let an older slow lookup overwrite a later %s intent", async latest => {
      setPlatform("win32")
      vi.stubEnv("CMB_WEBSTORM_BIN", "")
      vi.stubEnv("CMB_LOCAL_IDE", "")
      vi.stubEnv("OPENWORK_IDE", "")
      let complete!: (error: Error | null, stdout: string) => void
      mockExecFile.mockImplementation((_cmd, _args, _options, callback) => { complete = callback })
      vi.mocked(saveIdeSettings).mockClear()
      vi.mocked(saveIdeSettings).mockImplementation(settings => {
        testState.configuredPaths = { ...testState.configuredPaths, ...settings.executablePaths }
        return { preferredIde: settings.preferredIde ?? "webstorm",
          executablePaths: testState.configuredPaths }
      })
      try {
        const old = configurePreferredIde({ preferredIde: "webstorm" })
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(mockExecFile).toHaveBeenCalledTimes(1)
        const path = "C:\\IDE\\code.exe"
        testState.macPaths.add(path)
        if (latest === "direct-preference") invalidatePendingIdeConfiguration()
        else await expect(configurePreferredIde({ preferredIde: "vscode",
          executablePath: latest === "saved" ? path : "C:\\missing-ide.exe" }))
          .resolves.toMatchObject({ status: latest === "saved" ? "configured" : "needs_executable_path" })
        const writes = vi.mocked(saveIdeSettings).mock.calls.length
        // Both success and failure of the old process must leave the later intent alone.
        complete(latest === "invalid" ? Error("timeout") : null, "C:\\old-webstorm.exe")
        await expect(old).resolves.toMatchObject({ status: "superseded" })
        expect(saveIdeSettings).toHaveBeenCalledTimes(writes)
        expect(mockExecFile).toHaveBeenCalledTimes(1)
        expect(testState.configuredPaths.webstorm).toBeUndefined()
        if (latest === "saved") expect(testState.configuredPaths.vscode).toBe(path)
      } finally { vi.unstubAllEnvs() }
    })

  it("treats spawned Windows IDE executables with exit code 1 as success", async () => {
    setPlatform("win32")
    testState.configuredPaths.webstorm = "D:\\tools\\WebStorm\\bin\\webstorm64.exe"

    const workspaceFileChild = createMockChildProcess()
    const lineChild = createMockChildProcess()
    mockSpawn
      .mockImplementationOnce(() => {
        queueMicrotask(() => workspaceFileChild.emit("exit", 1))
        return workspaceFileChild
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => lineChild.emit("exit", 1))
        return lineChild
      })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "D:\\repo",
        filePath: "D:\\repo\\src\\main.ts",
        line: 27
      })
    ).resolves.toEqual({
      editor: testState.configuredPaths.webstorm,
      mode: "workspace+file+line"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      testState.configuredPaths.webstorm,
      ["D:\\repo", "D:\\repo\\src\\main.ts"],
      expect.objectContaining({ detached: true })
    )
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      testState.configuredPaths.webstorm,
      ["--line", "27", "D:\\repo\\src\\main.ts"],
      expect.objectContaining({ detached: true })
    )
    expect(workspaceFileChild.unref).toHaveBeenCalledTimes(1)
    expect(lineChild.unref).toHaveBeenCalledTimes(1)
  })

  it("opens the workspace and target file before focusing the line on macOS JetBrains", async () => {
    setPlatform("darwin")
    testState.configuredPaths.webstorm = "/Applications/WebStorm.app"

    const workspaceFileChild = createMockChildProcess()
    const lineChild = createMockChildProcess()
    mockSpawn
      .mockImplementationOnce(() => {
        queueMicrotask(() => workspaceFileChild.emit("exit", 0))
        return workspaceFileChild
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => lineChild.emit("exit", 0))
        return lineChild
      })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "/repo",
        filePath: "/repo/src/main.ts",
        line: 27
      })
    ).resolves.toEqual({
      editor: testState.configuredPaths.webstorm,
      mode: "workspace+file+line"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/WebStorm.app/Contents/MacOS/webstorm",
      ["/repo", "/repo/src/main.ts"],
      expect.objectContaining({ detached: true, shell: false })
    )
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "/Applications/WebStorm.app/Contents/MacOS/webstorm",
      ["--line", "27", "/repo/src/main.ts"],
      expect.objectContaining({ detached: true, shell: false })
    )
  })

  it("keeps the workspace and file open when follow-up line navigation fails", async () => {
    setPlatform("darwin")
    testState.configuredPaths.webstorm = "/Applications/WebStorm.app"

    const workspaceFileChild = createMockChildProcess()
    const failedLineChild = createMockChildProcess()
    mockSpawn
      .mockImplementationOnce(() => {
        queueMicrotask(() => workspaceFileChild.emit("exit", 0))
        return workspaceFileChild
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => failedLineChild.emit("error", new Error("line jump failed")))
        return failedLineChild
      })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "/repo",
        filePath: "/repo/src/main.ts",
        line: 27
      })
    ).resolves.toEqual({
      editor: "/Applications/WebStorm.app",
      mode: "workspace+file"
    })
  })

  it("uses the JetBrains app executable directly on macOS", async () => {
    setPlatform("darwin")
    testState.configuredPaths.webstorm = "/Applications/WebStorm.app"

    const workspaceChild = createMockChildProcess()
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => workspaceChild.emit("exit", 0))
      return workspaceChild
    })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "/repo"
      })
    ).resolves.toEqual({
      editor: "/Applications/WebStorm.app",
      mode: "workspace"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/WebStorm.app/Contents/MacOS/webstorm",
      ["/repo"],
      expect.objectContaining({ detached: true, shell: false })
    )
  })

  it("passes workspace and file together for JetBrains workspace+file opens on macOS", async () => {
    setPlatform("darwin")
    testState.configuredPaths.webstorm = "/Applications/WebStorm.app"

    const workspaceFileChild = createMockChildProcess()
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => workspaceFileChild.emit("exit", 0))
      return workspaceFileChild
    })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "/repo",
        filePath: "/repo/src/main.ts"
      })
    ).resolves.toEqual({
      editor: "/Applications/WebStorm.app",
      mode: "workspace+file"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/WebStorm.app/Contents/MacOS/webstorm",
      ["/repo", "/repo/src/main.ts"],
      expect.objectContaining({ detached: true, shell: false })
    )
  })

  it("normalizes a saved macOS JetBrains executable path back to the app bundle", async () => {
    setPlatform("darwin")
    testState.configuredPaths.webstorm = "/Applications/WebStorm.app/Contents/MacOS/webstorm"

    const workspaceFileChild = createMockChildProcess()
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => workspaceFileChild.emit("exit", 0))
      return workspaceFileChild
    })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "/repo",
        filePath: "/repo/src/main.ts"
      })
    ).resolves.toEqual({
      editor: "/Applications/WebStorm.app",
      mode: "workspace+file"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/WebStorm.app/Contents/MacOS/webstorm",
      ["/repo", "/repo/src/main.ts"],
      expect.objectContaining({ detached: true, shell: false })
    )
  })

  it("still rejects non-zero exits from shell launchers on Windows", async () => {
    setPlatform("win32")
    testState.configuredPaths.vscode = "C:\\tools\\Microsoft VS Code\\bin\\code.cmd"

    const child = createMockChildProcess()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 1))
      return child
    })

    await expect(
      openIde({
        ide: "vscode",
        workspacePath: "D:\\repo"
      })
    ).rejects.toThrow(/exited with code 1/)

    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it("still rejects real spawn errors for Windows IDE executables", async () => {
    setPlatform("win32")
    testState.configuredPaths.webstorm = "D:\\tools\\WebStorm\\bin\\webstorm64.exe"

    const child = createMockChildProcess()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")))
      return child
    })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "D:\\repo"
      })
    ).rejects.toThrow(/spawn failed/)

    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it.each(["/Applications/WebStorm.app", "/Applications/WebStorm.app/Contents/MacOS/webstorm"])(
    "rejects a missing macOS launcher resource %s without spawning", async missing => {
      setPlatform("darwin")
      testState.configuredPaths.webstorm = "/Applications/WebStorm.app"
      testState.macPaths.delete(missing)
      await expect(openIde({ ide: "webstorm", workspacePath: "/repo" }))
        .rejects.toThrow("应用路径无效")
      expect(mockSpawn).not.toHaveBeenCalled()
    }
  )
})
