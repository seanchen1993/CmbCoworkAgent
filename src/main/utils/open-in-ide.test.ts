import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupportedIde } from "../types"

const mockSpawn = vi.fn()
const mockExecFileSync = vi.fn()
let configuredPaths: Partial<Record<SupportedIde, string>> = {}

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn
}))

vi.mock("../storage", () => ({
  getConfiguredIdeExecutablePath: (ide: SupportedIde) => configuredPaths[ide] ?? null,
  getIdeSettings: () => ({ preferredIde: "webstorm", executablePaths: configuredPaths }),
  saveIdeSettings: vi.fn()
}))

import { openIde } from "./open-in-ide"

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
    configuredPaths = {}
    mockSpawn.mockReset()
    mockExecFileSync.mockReset()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it("treats spawned Windows IDE executables with exit code 1 as success", async () => {
    setPlatform("win32")
    configuredPaths.webstorm = "D:\\tools\\WebStorm\\bin\\webstorm64.exe"

    const child = createMockChildProcess()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 1))
      return child
    })

    await expect(
      openIde({
        ide: "webstorm",
        workspacePath: "D:\\repo",
        filePath: "D:\\repo\\src\\main.ts",
        line: 27
      })
    ).resolves.toEqual({
      editor: configuredPaths.webstorm,
      mode: "workspace+file+line"
    })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it("still rejects non-zero exits from shell launchers on Windows", async () => {
    setPlatform("win32")
    configuredPaths.vscode = "C:\\tools\\Microsoft VS Code\\bin\\code.cmd"

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
    configuredPaths.webstorm = "D:\\tools\\WebStorm\\bin\\webstorm64.exe"

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
