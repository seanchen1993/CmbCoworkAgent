import { expect, it, vi } from "vitest"
import { emitWorkspaceFilesChanged, onWorkspaceFilesChanged } from "./workspace-change-events"

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
