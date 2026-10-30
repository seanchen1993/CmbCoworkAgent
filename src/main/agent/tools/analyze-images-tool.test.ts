import { beforeEach, describe, expect, it, vi } from "vitest"
import type { VisionImage } from "../../vision/analyze-images"

const mocks = vi.hoisted(() => ({
  model: { value: null as null | { model: string; baseUrl: string; apiKey: string } },
  analyze: vi.fn()
}))
vi.mock("../../models/registry", () => ({ getVisionModelConfig: () => mocks.model.value }))
vi.mock("../../vision/analyze-images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vision/analyze-images")>()),
  analyzeImages: mocks.analyze
}))
import { createAnalyzeImagesTool } from "./analyze-images-tool"

const image: VisionImage = {
  id: "image-authorized",
  mimeType: "image/png",
  data: Buffer.from("png"),
  source: "upload"
}

describe("analyze_images configuration and authorization", () => {
  beforeEach(() => {
    mocks.model.value = {
      model: "vision",
      baseUrl: "https://example.invalid/v1",
      apiKey: "private-key"
    }
    mocks.analyze.mockReset()
    mocks.analyze.mockResolvedValue({
      status: "complete",
      sources: [{ image_id: image.id }],
      analysis: "evidence"
    })
  })

  it("rechecks configuration on every execution of a cached tool", async () => {
    const resolveImages = vi.fn(async () => [image])
    const tool = createAnalyzeImagesTool({ threadId: "current", resolveImages })
    expect(
      JSON.parse(await tool.invoke({ image_ids: [image.id], question: "Describe" }))
    ).toMatchObject({ status: "complete" })
    mocks.model.value = null
    expect(
      JSON.parse(await tool.invoke({ image_ids: [image.id], question: "Again" }))
    ).toMatchObject({ status: "error", code: "VISION_NOT_CONFIGURED" })
    expect(resolveImages).toHaveBeenCalledTimes(1)
    expect(mocks.analyze).toHaveBeenCalledTimes(1)
  })

  it("rechecks deletion while reading images and prevents stale credentials", async () => {
    const tool = createAnalyzeImagesTool({
      threadId: "current",
      resolveImages: async () => {
        mocks.model.value = null
        return [image]
      }
    })
    expect(
      JSON.parse(await tool.invoke({ image_ids: [image.id], question: "Describe" }))
    ).toMatchObject({ code: "VISION_NOT_CONFIGURED" })
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it("uses a newly selected model instead of a captured configuration", async () => {
    const tool = createAnalyzeImagesTool({
      threadId: "current",
      resolveImages: async () => [image]
    })
    mocks.model.value = {
      model: "new-vision",
      baseUrl: "https://replacement.invalid/llm/new/v1",
      apiKey: "new-key"
    }
    await tool.invoke({ image_ids: [image.id], question: "Describe" })
    expect(mocks.analyze.mock.calls[0][0].model.model).toBe("new-vision")
  })

  it("rejects missing or mismatched authorized references", async () => {
    const tool = createAnalyzeImagesTool({
      threadId: "current",
      resolveImages: async () => [image]
    })
    expect(
      JSON.parse(await tool.invoke({ image_ids: ["another-thread"], question: "Describe" }))
    ).toMatchObject({ code: "IMAGE_ACCESS" })
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it("does not expose filesystem paths or resolver error messages", async () => {
    const tool = createAnalyzeImagesTool({
      threadId: "current",
      resolveImages: async () => {
        throw new Error("/private/path secret-token")
      }
    })
    const result = await tool.invoke({ image_ids: [image.id], question: "Describe" })
    expect(JSON.parse(result)).toMatchObject({ status: "error", code: "IMAGE_ACCESS" })
    expect(result).not.toContain("/private/path")
    expect(result).not.toContain("secret-token")
  })

  it("cancels before resolving images", async () => {
    const controller = new AbortController()
    controller.abort()
    const resolveImages = vi.fn(async () => [image])
    const tool = createAnalyzeImagesTool({
      threadId: "current",
      resolveImages,
      abortSignal: controller.signal
    })
    expect(
      JSON.parse(await tool.invoke({ image_ids: [image.id], question: "Describe" }))
    ).toMatchObject({ code: "VISION_CANCELLED" })
    expect(resolveImages).not.toHaveBeenCalled()
  })
})
