import { describe, it, expect, vi, beforeEach } from "vitest"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"

const mocks = vi.hoisted(() => ({
  configured: false,
  project: vi.fn(async (_thread: string, content: unknown) => content)
}))
vi.mock("../models/registry", () => ({
  getVisionModelConfig: () => (mocks.configured ? { model: "vision" } : null)
}))
vi.mock("../vision/image-assets", () => ({ projectImageContent: mocks.project }))
import { createImageAnalysisMiddleware, projectImageMessage } from "./image-analysis-middleware"

describe("shared image analysis provider boundary", () => {
  beforeEach(() => {
    mocks.configured = false
    mocks.project.mockReset().mockImplementation(async (_thread, content) => content)
  })

  it("keeps ordinary text messages and tool inventory intact without vision configuration", async () => {
    const message = new HumanMessage("ordinary chat")
    const tools = [{ name: "read_file" }]
    const handler = vi.fn(async (request) => request)
    const middleware = createImageAnalysisMiddleware("thread-a")
    const result = await middleware.wrapModelCall!(
      { messages: [message], tools } as never,
      handler as never
    )
    expect((result as unknown as { messages: unknown[] }).messages[0]).toBe(message)
    expect(handler.mock.calls[0][0].tools).toEqual(tools)
  })

  it("removes stale cached tools immediately after removing the selected model", async () => {
    const middleware = createImageAnalysisMiddleware("thread-a")
    const handler = vi.fn(async (request) => request)
    const request = { messages: [], tools: [{ name: "analyze_images" }, { name: "read_file" }] }
    mocks.configured = true
    await middleware.wrapModelCall!(request as never, handler as never)
    expect(handler.mock.calls[0][0].tools).toHaveLength(2)
    mocks.configured = false
    await middleware.wrapModelCall!(request as never, handler as never)
    expect(handler.mock.calls[1][0].tools).toEqual([{ name: "read_file" }])
    const execute = vi.fn()
    const result = await middleware.wrapToolCall!(
      { toolCall: { name: "analyze_images", id: "call-1" } } as never,
      execute as never
    )
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "error", tool_call_id: "call-1" })
  })

  it("projects media without mutating the checkpoint, role, metadata or tool pairing", async () => {
    const content = [{ type: "image_url", image_url: { url: "data:image/png;base64,private" } }]
    const original = new ToolMessage({
      content,
      tool_call_id: "call-2",
      name: "browser_take_screenshot",
      id: "m-1"
    })
    mocks.project.mockResolvedValue([{ type: "text", text: "image_id=img_authorized" }])
    const projected = await projectImageMessage("thread-a", original)
    expect(projected).toBeInstanceOf(ToolMessage)
    expect(projected).toMatchObject({
      id: "m-1",
      tool_call_id: "call-2",
      name: "browser_take_screenshot"
    })
    expect(JSON.stringify(projected.content)).not.toContain("base64")
    expect(original.content).toBe(content)
    expect(JSON.stringify(original.content)).toContain("private")
    expect(mocks.project).toHaveBeenCalledWith(
      "thread-a",
      content,
      "tool:browser_take_screenshot:call-2"
    )
  })

  it("persists references from screenshot results before the next model call", async () => {
    mocks.project.mockResolvedValue([{ type: "text", text: "image_id=img_stable" }])
    const middleware = createImageAnalysisMiddleware("thread-a")
    const original = new ToolMessage({
      content: [{ type: "image", data: "private" }],
      tool_call_id: "shot"
    })
    const result = await middleware.wrapToolCall!(
      { toolCall: { name: "browser_take_screenshot", id: "shot" } } as never,
      (async () => original) as never
    )
    expect(result).toMatchObject({
      tool_call_id: "shot",
      content: [{ type: "text", text: "image_id=img_stable" }]
    })
    expect(original.content).toEqual([{ type: "image", data: "private" }])
  })
})
