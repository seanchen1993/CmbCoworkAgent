import { expect, it, vi } from "vitest"
import {
  emitWorkspaceFilesChanged,
  onWorkspaceFilesChanged,
  emitWorkspaceWatchStateChanged,
  onWorkspaceWatchStateChanged
} from "./workspace-change-events"

it("isolates observer errors and unsubscribes without retaining the watcher", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const first = onWorkspaceFilesChanged(() => {
    throw Error("observer failed")
  })
  const listener = vi.fn()
  const stop = onWorkspaceFilesChanged(listener)
  const event = { workspacePath: "/project", threadIds: ["task"], changeType: "file" as const }
  try {
    expect(() => emitWorkspaceFilesChanged(event)).not.toThrow()
    expect(listener).toHaveBeenCalledExactlyOnceWith(event)
    expect(warn).toHaveBeenCalledOnce()
    first()
    stop()
    emitWorkspaceFilesChanged(event)
    expect(listener).toHaveBeenCalledOnce()
  } finally {
    first()
    stop()
    warn.mockRestore()
  }
})

it("isolates lifecycle observers and removes their listeners without starting a watcher", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const stopBroken = onWorkspaceWatchStateChanged(() => {
    throw Error("observer failed")
  })
  const listener = vi.fn()
  const stop = onWorkspaceWatchStateChanged(listener)
  const event = { workspacePath: "/project", threadIds: ["task"] }
  try {
    emitWorkspaceWatchStateChanged(event)
    expect(listener).toHaveBeenCalledExactlyOnceWith(event)
    expect(warn).toHaveBeenCalledOnce()
    stop()
    stopBroken()
    emitWorkspaceWatchStateChanged(event)
    expect(listener).toHaveBeenCalledOnce()
  } finally {
    stop()
    stopBroken()
    warn.mockRestore()
  }
})
