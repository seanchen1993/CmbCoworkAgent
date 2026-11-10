import { afterEach, describe, expect, it, vi } from "vitest"
import { createElectronStream } from "./electron-stream"
import { ElectronIPCTransport } from "./electron-transport"

afterEach(() => vi.unstubAllGlobals())

describe("original input transport", () => {
  it.each(["  用户原文\n保持空白  ", "", undefined])(
    "passes the original input separately from the model prompt: %j",
    async (rawUserInput) => {
      let onEvent!: (event: { type: "done" }) => void
      const streamAgent = vi.fn((...args: unknown[]) => {
        onEvent = args[3] as typeof onEvent
        return vi.fn()
      })
      vi.stubGlobal("window", { api: { agent: { streamAgent } } })
      const stream = createElectronStream({
        transport: new ElectronIPCTransport(),
        threadId: "thread-raw-input"
      })
      const decorated = "用户原文\n\n<CMBDEVCLAW-SKILL-USE-V1>程序说明</CMBDEVCLAW-SKILL-USE-V1>"
      const submission = stream.submit(
        { messages: [{ type: "human", content: decorated }] },
        { config: { configurable: { raw_user_input: rawUserInput } } }
      )
      await vi.waitFor(() => expect(streamAgent).toHaveBeenCalledOnce())
      expect(streamAgent.mock.calls[0][1]).toBe(decorated)
      expect(streamAgent.mock.calls[0][8]).toBe(rawUserInput)
      onEvent({ type: "done" })
      await submission
    }
  )
})
