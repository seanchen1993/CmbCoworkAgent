import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupportedIde } from "../types"

const testState = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  configuredPaths: {} as Partial<Record<SupportedIde, string>>
}))

vi.mock("child_process", () => ({
  execFileSync: testState.mockExecFileSync,
  spawn: testState.mockSpawn
}))

vi.mock("../storage", () => ({
  getConfiguredIdeExecutablePath: (ide: SupportedIde) => testState.configuredPaths[ide] ?? null,
  getIdeSettings: () => ({ preferredIde: "webstorm", executablePaths: testState.configuredPaths }),
  saveIdeSettings: vi.fn()
}))

import { openIde } from "./open-in-ide"

const { mockExecFileSync, mockSpawn } = testState

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
    mockSpawn.mockReset()
    mockExecFileSync.mockReset()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
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
})
