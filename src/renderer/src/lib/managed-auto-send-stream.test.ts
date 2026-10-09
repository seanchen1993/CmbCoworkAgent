import { afterEach, describe, expect, it, vi } from "vitest"
import { createElectronStream } from "./electron-stream"
import { ElectronIPCTransport } from "./electron-transport"

afterEach(() => vi.unstubAllGlobals())

describe("managed auto-send stream lifecycle", () => {
  it("marks a managed run terminal only after its stream ends", async () => {
    let onEvent!: (event: { type: "done" }) => void
    const observeManagedAutoSendStream = vi.fn((_runId, callback) => {
      onEvent = callback
      return vi.fn()
    })
    vi.stubGlobal("window", { api: { agent: { observeManagedAutoSendStream } } })
    const onTerminal = vi.fn()
    const stream = createElectronStream({
      transport: new ElectronIPCTransport({
        managedAutoSendRunId: "managed-run-1",
        onManagedAutoSendRunTerminal: onTerminal
      }),
      threadId: "thread-1"
    })

    const submission = stream.submit(null)
    await vi.waitFor(() => expect(observeManagedAutoSendStream).toHaveBeenCalledOnce())
    expect(observeManagedAutoSendStream).toHaveBeenCalledWith("managed-run-1", expect.any(Function))
    expect(onTerminal).not.toHaveBeenCalled()

    onEvent({ type: "done" })
    await submission
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith("managed-run-1")
  })

  it("marks a failed managed stream terminal", async () => {
    let onEvent!: (event: { type: "error"; error: string }) => void
    const observeManagedAutoSendStream = vi.fn((_runId, callback) => {
      onEvent = callback
      return vi.fn()
    })
    vi.stubGlobal("window", { api: { agent: { observeManagedAutoSendStream } } })
    const onTerminal = vi.fn()
    const stream = createElectronStream({
      transport: new ElectronIPCTransport({
        managedAutoSendRunId: "managed-run-error",
        onManagedAutoSendRunTerminal: onTerminal
      }),
      threadId: "thread-1"
    })

    const submission = stream.submit(null)
    await vi.waitFor(() => expect(observeManagedAutoSendStream).toHaveBeenCalledOnce())
    onEvent({ type: "error", error: "run failed" })
    await submission.catch(() => undefined)
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith("managed-run-error")
  })

  it("does not mark an interrupted observer as a finished managed run", async () => {
    const observeManagedAutoSendStream = vi.fn(() => vi.fn())
    vi.stubGlobal("window", { api: { agent: { observeManagedAutoSendStream } } })
    const onTerminal = vi.fn()
    const stream = createElectronStream({
      transport: new ElectronIPCTransport({
        managedAutoSendRunId: "managed-run-2",
        onManagedAutoSendRunTerminal: onTerminal
      }),
      threadId: "thread-1"
    })

    const submission = stream.submit(null)
    await vi.waitFor(() => expect(observeManagedAutoSendStream).toHaveBeenCalledOnce())
    await stream.stop()
    await submission
    expect(onTerminal).not.toHaveBeenCalled()
  })
})
