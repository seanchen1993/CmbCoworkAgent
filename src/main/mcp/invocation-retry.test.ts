import { describe, expect, it, vi } from "vitest"
import { modCallContext } from "../mods/context"
import { invokeMcpToolWithRetry } from "./invocation-retry"

describe("MCP retry boundary", () => {
  it("retains a legacy retry outside Mods", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue("ok")
    expect(await invokeMcpToolWithRetry(call, { name: "write", arguments: {} })).toBe("ok")
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("does not replay an uncertain Mod operation after a transport failure", async () => {
    const call = vi.fn().mockRejectedValue(new Error("disconnected after remote write"))
    await expect(
      modCallContext.run(
        {
          identity: {
            callId: "call",
            threadId: "thread",
            turnId: "turn",
            agentId: "main",
            workspace: "workspace",
            origin: "model",
            grantEpoch: 0
          },
          toolId: "mcp:write",
          routeClaimed: true,
          protectedOutput: false,
          readOnly: false
        },
        () => invokeMcpToolWithRetry(call, { name: "write", arguments: {} })
      )
    ).rejects.toThrow("disconnected")
    expect(call).toHaveBeenCalledTimes(1)
  })
})
