import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import { projectAgentProgress } from "./project-agent-progress"

describe("project Agent request progress isolation", () => {
  it("binds events to the invoking renderer and a validated one-use channel, dropping cancelled events", () => {
    const send = vi.fn()
    const isDestroyed = vi.fn(() => false)
    const event = { sender: { send, isDestroyed } } as unknown as IpcMainInvokeEvent
    const runId = "10000000-0000-4000-8000-000000000001"
    const controller = new AbortController()
    const notify = projectAgentProgress(event, runId, controller.signal)!
    const payload = { type: "text" as const, stepId: "step-1", text: "可见回答" }
    notify(payload)
    expect(send).toHaveBeenCalledWith(`dashboard:projectAgentRun:${runId}`, payload)
    controller.abort()
    notify(payload)
    expect(send).toHaveBeenCalledTimes(1)
    expect(() => projectAgentProgress(event, "agent:stream:another-thread")).toThrow("标识无效")
    expect(projectAgentProgress(event, undefined)).toBeUndefined()
    const destroyed = projectAgentProgress(event, runId)!
    isDestroyed.mockReturnValue(true)
    destroyed(payload)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
