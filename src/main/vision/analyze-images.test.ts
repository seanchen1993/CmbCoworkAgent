import { createServer, type Server, type ServerResponse } from "node:http"
import { once } from "node:events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  analyzeImages,
  MAX_VISION_ENCODED_BYTES,
  requireVisionModel,
  type VisionImage
} from "./analyze-images"

const png: VisionImage = {
  id: "image-first",
  mimeType: "image/png",
  data: Buffer.from("89504e470d0a1a0a", "hex"),
  source: "uploaded screenshot.png"
}
const jpeg: VisionImage = {
  id: "image-second",
  mimeType: "image/jpeg",
  data: Buffer.from("ffd8ff", "hex"),
  source: "browser screenshot"
}

function delta(response: ServerResponse, content: string, finishReason: string | null = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "visual-response",
      choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
    })}\n\n`
  )
}

describe("shared image analysis protocol", () => {
  let server: Server
  let baseUrl: string
  let requestBody: Record<string, unknown>
  let requestUrl: string | undefined
  let authorization: string | undefined
  let respond: (response: ServerResponse) => void

  beforeEach(async () => {
    requestBody = {}
    respond = (response) => {
      delta(response, "[image-first] 中文")
      delta(response, " evidence", "stop")
      response.end("data: [DONE]\n\n")
    }
    server = createServer(async (request, response) => {
      const body: Buffer[] = []
      for await (const part of request) body.push(part)
      requestBody = JSON.parse(Buffer.concat(body).toString())
      requestUrl = request.url
      authorization = request.headers.authorization
      response.setHeader("Content-Type", "text/event-stream")
      respond(response)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server address")
    baseUrl = `http://127.0.0.1:${address.port}/llm/replaceable-vision/v1`
  })

  afterEach(async () => {
    server.closeAllConnections()
    server.close()
    await once(server, "close")
  })

  function run(overrides: Partial<Parameters<typeof analyzeImages>[0]> = {}) {
    return analyzeImages({
      model: { model: "replaceable-vision", baseUrl, apiKey: "mock-private-key" },
      images: [png, jpeg],
      question: "比较两张图片",
      ...overrides
    })
  }

  it("uses the configured route, aggregates SSE deltas and preserves ordered sources and actual MIME", async () => {
    const result = await run()
    expect(requestUrl).toBe("/llm/replaceable-vision/v1/chat/completions")
    expect(authorization).toBe("Bearer mock-private-key")
    expect(requestBody).toMatchObject({
      model: "replaceable-vision",
      stream: true,
      temperature: 0,
      top_p: 0.9
    })
    expect(requestBody).not.toHaveProperty("response_format")
    const messages = requestBody.messages as Array<{ role: string; content: unknown }>
    expect(messages[1].content).toEqual([
      { type: "text", text: "比较两张图片" },
      { type: "text", text: "Image 1: image_id=image-first" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png.data.toString("base64")}` }
      },
      { type: "text", text: "Image 2: image_id=image-second" },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${jpeg.data.toString("base64")}` }
      }
    ])
    expect(result).toEqual({
      status: "complete",
      sources: [
        { image_id: png.id, source: png.source, position: 1 },
        { image_id: jpeg.id, source: jpeg.source, position: 2 }
      ],
      analysis: "[image-first] 中文 evidence"
    })
  })

  it("does not add another /v1 or duplicate a trailing slash", async () => {
    await run({ model: { model: "other", baseUrl: `${baseUrl}/`, apiKey: "key" } })
    expect(requestUrl).toBe("/llm/replaceable-vision/v1/chat/completions")
  })

  it("allows follow-up questions using the same image references", async () => {
    await run()
    const result = await run({ images: [png], question: "第一张图中左侧写了什么？" })
    expect(result.sources).toEqual([{ image_id: png.id, source: png.source, position: 1 }])
    expect(JSON.stringify(requestBody)).toContain("第一张图中左侧写了什么")
  })

  it("rejects too many, duplicate, empty, unsupported and oversized images before a request", async () => {
    await expect(run({ images: [] })).rejects.toMatchObject({ code: "IMAGE_LIMIT" })
    await expect(run({ images: Array.from({ length: 9 }, () => png) })).rejects.toMatchObject({
      code: "IMAGE_LIMIT"
    })
    await expect(run({ images: [png, png] })).rejects.toMatchObject({ code: "INVALID_IMAGES" })
    await expect(run({ images: [{ ...png, data: Buffer.alloc(0) }] })).rejects.toMatchObject({
      code: "IMAGE_TYPE"
    })
    await expect(run({ images: [{ ...png, mimeType: "image/svg+xml" }] })).rejects.toMatchObject({
      code: "IMAGE_TYPE"
    })
    await expect(
      run({ images: [{ ...png, data: Buffer.alloc(MAX_VISION_ENCODED_BYTES) }] })
    ).rejects.toMatchObject({ code: "IMAGE_SIZE" })
    expect(requestBody).toEqual({})
  })

  it("rejects incomplete configuration without probing the network", async () => {
    for (const model of [
      null,
      { model: "vision", apiKey: "", baseUrl },
      { model: "vision", apiKey: "key", baseUrl: "file:///secret" }
    ]) {
      expect(() => requireVisionModel(model)).toThrow()
    }
    await expect(run({ question: " " })).rejects.toMatchObject({ code: "INVALID_QUESTION" })
    expect(requestBody).toEqual({})
  })

  it("reports EOF without a finishing delta as interrupted and discards partial text", async () => {
    respond = (response) => {
      delta(response, "partial confidential text")
      response.end()
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_INTERRUPTED" })
  })

  it("reports a length limit explicitly instead of returning partial evidence", async () => {
    respond = (response) => {
      delta(response, "partial text", "length")
      response.end("data: [DONE]\n\n")
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_TRUNCATED" })
  })

  it("reports filtered or empty model responses", async () => {
    respond = (response) => {
      delta(response, "", "content_filter")
      response.end("data: [DONE]\n\n")
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_INCOMPLETE" })
    respond = (response) => {
      delta(response, "", "stop")
      response.end("data: [DONE]\n\n")
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_EMPTY" })
  })

  it("handles abrupt transport termination", async () => {
    respond = (response) => {
      delta(response, "partial")
      response.flushHeaders()
      response.destroy()
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_INTERRUPTED" })
  })

  it("sanitizes provider error bodies and credentials", async () => {
    respond = (response) => {
      response.statusCode = 401
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({ error: { message: "mock-private-key data:image/png;base64,private" } })
      )
    }
    const error = await run().catch((error: Error) => error)
    expect(error).toMatchObject({ code: "VISION_AUTH" })
    expect(String(error)).not.toContain("mock-private-key")
    expect(String(error)).not.toContain("data:image")
  })

  it("reports other provider statuses without exposing response bodies", async () => {
    respond = (response) => {
      response.statusCode = 503
      response.end("private upstream URL and mock-private-key")
    }
    const error = await run().catch((error: Error) => error)
    expect(error).toMatchObject({ code: "VISION_REQUEST_FAILED" })
    expect(String(error)).toContain("HTTP 503")
    expect(String(error)).not.toContain("mock-private-key")
  })

  it("limits oversized text output without presenting partial analysis", async () => {
    respond = (response) => {
      delta(response, "x".repeat(128 * 1024 + 1), "stop")
      response.end("data: [DONE]\n\n")
    }
    await expect(run()).rejects.toMatchObject({ code: "VISION_OUTPUT_LIMIT" })
  })

  it("honors cancellation before starting and during a stream", async () => {
    const prior = new AbortController()
    prior.abort()
    await expect(run({ signal: prior.signal })).rejects.toMatchObject({ code: "VISION_CANCELLED" })
    const active = new AbortController()
    respond = (response) => {
      delta(response, "partial")
      response.flushHeaders()
      active.abort()
    }
    await expect(run({ signal: active.signal })).rejects.toMatchObject({ code: "VISION_CANCELLED" })
  })

  it("times out a stalled stream including after the headers arrive", async () => {
    respond = (response) => {
      response.flushHeaders()
    }
    await expect(run({ timeoutMs: 40 })).rejects.toMatchObject({ code: "VISION_TIMEOUT" })
  })
})
