import { describe, expect, it, vi } from "vitest"
import { projectMcpImageResult } from "./mcp-image-result"
import type { McpInvocationResult } from "../mcp/capability-types"
import { getUsefulMcpResultData, toEagerToolResponse } from "../mcp/result-utils"

describe("MCP screenshot projection", () => {
  it("preserves non-image tools without loading storage or invoking projection", async () => {
    const result: McpInvocationResult = {
      capabilityId: "tool",
      raw: {},
      text: "ordinary",
      isError: false
    }
    const project = vi.fn()
    expect(await projectMcpImageResult("thread", result, "tool", project)).toBe(result)
    expect(project).not.toHaveBeenCalled()
  })

  it("makes references visible to eager and lazy tools and removes duplicate base64 payloads", async () => {
    const result: McpInvocationResult = {
      capabilityId: "screenshot",
      fallbackCapabilityId: "fallback",
      isError: false,
      raw: { content: [{ type: "image", data: "SECRET_IMAGE_BYTES" }] },
      text: "serialized SECRET_IMAGE_BYTES",
      structuredContent: { image: "SECRET_IMAGE_BYTES" },
      contentBlocks: [
        { type: "text", text: "Screenshot captured" },
        { type: "image", data: "SECRET_IMAGE_BYTES" }
      ]
    }
    const project = vi.fn(async () => [
      { type: "text", text: "Screenshot captured" },
      { type: "text", text: "image_id=img_123" }
    ])
    const safe = await projectMcpImageResult("thread", result, "browser", project)
    expect(project).toHaveBeenCalledWith("thread", result.contentBlocks, "browser")
    expect(JSON.stringify(safe)).not.toContain("SECRET_IMAGE_BYTES")
    expect(safe.structuredContent).toBeUndefined()
    expect(getUsefulMcpResultData(safe)).toContain("image_id=img_123")
    expect(toEagerToolResponse(safe)[0]).toContain("image_id=img_123")
    expect(safe.fallbackCapabilityId).toBe("fallback")
    expect(result.text).toContain("SECRET_IMAGE_BYTES")
  })
})
