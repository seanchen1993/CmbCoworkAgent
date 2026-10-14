import { describe, expect, it, vi } from "vitest"
import { functionMarkdownIpcLink, functionMarkdownIpcReceipt } from "./markdown-ipc-input"

const action = {
  address: { kind: "pane", pane: "Q:panel", generation: "drawing-1" },
  nonce: "native-leaf-1",
  intentId: "click-1",
  href: "https://example.com/report"
}
const receipt = "823b2f4a-c32f-4d3e-8f88-9f27ddcdecb3"

describe("Markdown native IPC envelopes", () => {
  it("accepts complete link and receipt data without allocating authority", () => {
    expect(functionMarkdownIpcLink({ threadId: "thread-1", action })).toEqual({
      threadId: "thread-1",
      action
    })
    expect(functionMarkdownIpcReceipt({ threadId: "thread-1", receipt })).toEqual({
      threadId: "thread-1",
      receipt
    })
  })

  it("rejects getters, inherited data, hidden fields and claimed authority without reading them", () => {
    const getter = vi.fn(() => "thread-1")
    for (const parse of [functionMarkdownIpcLink, functionMarkdownIpcReceipt]) {
      const input = { action, receipt }
      Object.defineProperty(input, "threadId", { enumerable: true, get: getter })
      expect(() => parse(input)).toThrow("MODS_IPC_ARGUMENTS")
      expect(() => parse(Object.create({ threadId: "thread-1", action, receipt }))).toThrow()
    }
    expect(getter).not.toHaveBeenCalled()
    const link = { threadId: "thread-1", action }
    Object.defineProperty(link, "runtimeAuthority", { value: "human" })
    expect(() => functionMarkdownIpcLink(link)).toThrow()
    expect(() =>
      functionMarkdownIpcReceipt({ threadId: "thread-1", receipt, [Symbol("proof")]: true })
    ).toThrow()
  })

  it("rejects missing fields, invalid receipts and nested forged actions", () => {
    expect(() => functionMarkdownIpcLink({ action })).toThrow()
    expect(() => functionMarkdownIpcLink({ threadId: "x".repeat(201), action })).toThrow()
    expect(() =>
      functionMarkdownIpcLink({
        threadId: "thread-1",
        action: {
          ...action,
          plugin: "Q"
        }
      })
    ).toThrow()
    expect(() =>
      functionMarkdownIpcReceipt({ threadId: "thread-1", receipt: "-".repeat(36) })
    ).toThrow()
  })
})
