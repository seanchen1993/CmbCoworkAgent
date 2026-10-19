import { describe, expect, it, vi } from "vitest"
import { createPluginDerivationBridge } from "./plugin-derivation"

describe("complete flow preparation bridge", () => {
  it("forwards only the scoped preparation request and waits for the host proposal", async () => {
    const proposal = { proposalId: "host-proposal", files: [] }
    const invoke = vi.fn().mockResolvedValue(proposal)
    const input = {
      threadId: "thread",
      expectedWorkspace: "C:/fixture",
      copyId: "copy",
      expectedDigest: "current-copy",
      requestId: "request"
    }
    expect(await createPluginDerivationBridge(invoke).prepareFlowComposition(input)).toBe(proposal)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "plugins:derivation:prepare-flow-composition",
      input
    )
  })
})
