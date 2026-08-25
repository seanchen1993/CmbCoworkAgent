import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const config = {
    enabled: true,
    intervalMinutes: 30,
    prompt: "heartbeat",
    modelId: "model",
    workDir: "/workspace/old",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null
  }
  return {
    config,
    sentChannels: [] as string[],
    saveConfig: vi.fn((updates: Record<string, unknown>) => Object.assign(config, updates)),
    resetConfig: vi.fn(() => Object.assign(config, { enabled: false, workDir: null })),
    resetSession: vi.fn(),
    runNow: vi.fn(),
    assertCanStart: vi.fn(),
    running: false,
    stop: vi.fn(),
    restart: vi.fn(),
    beginWorkspaceReset: vi.fn(() => mocks.stop()),
    endWorkspaceReset: vi.fn()
  }
})

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string) => mocks.sentChannels.push(channel) } }
    ]
  }
}))
vi.mock("../storage", () => ({
  getHeartbeatConfig: () => ({ ...mocks.config }),
  saveHeartbeatConfig: mocks.saveConfig,
  resetHeartbeatConfig: mocks.resetConfig,
  getHeartbeatContent: vi.fn(),
  saveHeartbeatContent: vi.fn()
}))
vi.mock("../services/heartbeat", () => ({
  runHeartbeatNow: mocks.runNow,
  isHeartbeatRunning: () => mocks.running,
  assertHeartbeatCanStart: mocks.assertCanStart,
  cancelHeartbeat: vi.fn(),
  restartHeartbeat: mocks.restart,
  stopHeartbeat: mocks.stop,
  beginHeartbeatWorkspaceReset: mocks.beginWorkspaceReset
}))
vi.mock("../services/heartbeat-session", () => ({
  resetHeartbeatSessionForWorkspaceChange: mocks.resetSession
}))
vi.mock("../agent/context-history-path", () => ({
  canonicalizeWorkspacePath: (value: string) =>
    Promise.resolve(value.replace("/workspace/link", "/workspace/old").replace(/\/$/, ""))
}))

import { registerHeartbeatHandlers } from "./heartbeat"

type Handler = (_event?: unknown, payload?: unknown) => Promise<unknown>

function handlers(): Map<string, Handler> {
  const registered = new Map<string, Handler>()
  registerHeartbeatHandlers({
    handle: (channel: string, handler: Handler) => registered.set(channel, handler)
  } as never)
  return registered
}

describe("heartbeat config workspace boundary", () => {
  beforeEach(() => {
    Object.assign(mocks.config, { enabled: true, workDir: "/workspace/old" })
    mocks.sentChannels.length = 0
    mocks.running = false
    vi.clearAllMocks()
    mocks.resetSession.mockResolvedValue(undefined)
    mocks.runNow.mockResolvedValue(undefined)
    mocks.beginWorkspaceReset.mockImplementation(() => {
      if (mocks.running) {
        throw new Error("Heartbeat 正在运行，无法切换工作目录。请等待运行结束或先取消运行。")
      }
      mocks.stop()
      return mocks.endWorkspaceReset
    })
  })

  it("starts a new heartbeat session before saving a different workspace", async () => {
    const save = handlers().get("heartbeat:saveConfig")!
    await save(undefined, { workDir: "/workspace/new" })

    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(mocks.beginWorkspaceReset).toHaveBeenCalledTimes(1)
    expect(mocks.endWorkspaceReset).toHaveBeenCalledTimes(1)
    expect(mocks.resetSession).toHaveBeenCalledWith("/workspace/old")
    expect(mocks.saveConfig).toHaveBeenCalledWith({ workDir: "/workspace/new" })
    expect(mocks.restart).toHaveBeenCalledTimes(1)
    expect(mocks.sentChannels).toContain("threads:changed")
    expect(mocks.sentChannels).toContain("heartbeat:changed")
    expect(mocks.resetSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveConfig.mock.invocationCallOrder[0]
    )
  })

  it("does not reset for a canonically equivalent workspace", async () => {
    const save = handlers().get("heartbeat:saveConfig")!
    await save(undefined, { workDir: "/workspace/link/" })

    expect(mocks.resetSession).not.toHaveBeenCalled()
    expect(mocks.saveConfig).toHaveBeenCalled()
    expect(mocks.sentChannels).not.toContain("threads:changed")
  })

  it("rejects a workspace switch while heartbeat is running", async () => {
    mocks.running = true
    const save = handlers().get("heartbeat:saveConfig")!

    await expect(save(undefined, { workDir: "/workspace/new" })).rejects.toThrow(
      "Heartbeat 正在运行"
    )
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.beginWorkspaceReset).toHaveBeenCalledTimes(1)
    expect(mocks.resetSession).not.toHaveBeenCalled()
    expect(mocks.saveConfig).not.toHaveBeenCalled()
  })

  it("keeps the previous config but leaves scheduling stopped when cleanup fails", async () => {
    mocks.resetSession.mockRejectedValueOnce(new Error("cleanup failed"))
    const save = handlers().get("heartbeat:saveConfig")!

    await expect(save(undefined, { workDir: "/workspace/new" })).rejects.toThrow("cleanup failed")
    expect(mocks.saveConfig).not.toHaveBeenCalled()
    expect(mocks.endWorkspaceReset).toHaveBeenCalledTimes(1)
    expect(mocks.restart).not.toHaveBeenCalled()
    expect(mocks.config.workDir).toBe("/workspace/old")
    expect(mocks.sentChannels).not.toContain("threads:changed")
  })

  it("does not restart the old heartbeat when config persistence fails after reset", async () => {
    mocks.saveConfig.mockImplementationOnce(() => {
      throw new Error("persist failed")
    })
    const save = handlers().get("heartbeat:saveConfig")!

    await expect(save(undefined, { workDir: "/workspace/new" })).rejects.toThrow("persist failed")
    expect(mocks.resetSession).toHaveBeenCalledWith("/workspace/old")
    expect(mocks.endWorkspaceReset).toHaveBeenCalledTimes(1)
    expect(mocks.restart).not.toHaveBeenCalled()
    expect(mocks.config.workDir).toBe("/workspace/old")
    expect(mocks.sentChannels).not.toContain("threads:changed")
  })

  it("resets the old workspace session when heartbeat config is reset", async () => {
    const reset = handlers().get("heartbeat:resetConfig")!
    await reset()

    expect(mocks.resetSession).toHaveBeenCalledWith("/workspace/old")
    expect(mocks.resetConfig).toHaveBeenCalledTimes(1)
    expect(mocks.sentChannels).toContain("threads:changed")
  })

  it("propagates heartbeat start preflight failures to the renderer", async () => {
    mocks.assertCanStart.mockImplementationOnce(() => {
      throw new Error("Heartbeat workspace is being changed")
    })
    const runNow = handlers().get("heartbeat:runNow")!

    await expect(runNow()).rejects.toThrow("workspace is being changed")
    expect(mocks.runNow).not.toHaveBeenCalled()
  })
})
