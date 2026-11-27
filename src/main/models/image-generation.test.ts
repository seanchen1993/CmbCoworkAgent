import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getImageGenerationDeployment, ImageGenerationError } from "./image-generation"

const config = {
  CMB_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
  CMB_IMAGE_GENERATION_MODEL: "test-image",
  CMB_IMAGE_GENERATION_API_KEY: "test-credential",
  CMB_IMAGE_GENERATION_ENVIRONMENT: "uat"
}

const png = sharp({
  create: { width: 17, height: 8, channels: 3, background: "#c02140" }
}).png().toBuffer()

function payload(bytes: Buffer, headers?: HeadersInit) {
  return Response.json({ data: [{ b64_json: bytes.toString("base64") }] }, { headers })
}

afterEach(() => vi.unstubAllEnvs())

describe("explicit image generation deployment", () => {
  it("stays disabled for chat-only configuration and pins the credential and environment", () => {
    expect(getImageGenerationDeployment({ OPENAI_BASE_URL: config.CMB_IMAGE_GENERATION_ENDPOINT }))
      .toBeUndefined()
    const original = getImageGenerationDeployment(config)!
    for (const [field, value] of Object.entries({
      CMB_IMAGE_GENERATION_ENVIRONMENT: "production",
      CMB_IMAGE_GENERATION_ENDPOINT: "https://other.example.test/generate",
      CMB_IMAGE_GENERATION_API_KEY: "another-credential",
      CMB_IMAGE_GENERATION_MODEL: "other-model",
      CMB_IMAGE_GENERATION_RESPONSE_FORMAT: "b64_json"
    })) {
      expect(getImageGenerationDeployment({ ...config, [field]: value })?.id).not.toBe(original.id)
    }
    expect(JSON.stringify(original)).toBe(JSON.stringify({ id: original.id }))
    expect(original.id).toMatch(/^[a-f0-9]{64}$/)
  })

  it("keeps the credential out of subprocess environments and reports capability only", async () => {
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value)
    vi.resetModules()
    const { imageGenerationAvailability } = await import("./image-generation")
    expect(imageGenerationAvailability()).toEqual({ available: true })
    expect(process.env.CMB_IMAGE_GENERATION_API_KEY).toBeUndefined()
  })

  it.each([
    "https://user:password@host.test/generate", "http://images.example.test/generate",
    "https://images.example.test/v1?token=test", "file:///tmp/generation", "broken"
  ])("rejects invalid endpoints before dispatch", endpoint => {
    expect(() => getImageGenerationDeployment({ ...config, CMB_IMAGE_GENERATION_ENDPOINT: endpoint }))
      .toThrowError(ImageGenerationError)
  })

  it("sends one request to the configured endpoint and returns original pixels and a thumbnail", async () => {
    const original = await png
    const send = vi.fn<typeof fetch>(async () => payload(original, { "x-request-id": "req-17" }))
    const deployment = getImageGenerationDeployment(config, send)!
    const result = await deployment.generate("  画一张风景画  ")
    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0]
    expect(url).toBe(config.CMB_IMAGE_GENERATION_ENDPOINT)
    expect(init).toMatchObject({
      method: "POST", redirect: "manual",
      headers: { authorization: "Bearer test-credential", "content-type": "application/json" }
    })
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "画一张风景画", model: "test-image", n: 1 })
    expect(result).toMatchObject({ width: 17, height: 8, mimeType: "image/png", requestId: "req-17" })
    expect(result.bytes.equals(original)).toBe(true)
    expect(await sharp(result.preview).metadata()).toMatchObject({ format: "webp", width: 17, height: 8 })
  })

  it("sends response_format only when the deployed protocol requires it", async () => {
    const send = vi.fn<typeof fetch>(async () => payload(await png))
    const deployment = getImageGenerationDeployment({
      ...config, CMB_IMAGE_GENERATION_RESPONSE_FORMAT: "b64_json",
      CMB_IMAGE_GENERATION_ENDPOINT: "http://127.0.0.1:3000/test"
    }, send)!
    await deployment.generate("画一只猫")
    expect(JSON.parse(String(send.mock.calls[0][1]?.body)).response_format).toBe("b64_json")
  })

  it("refuses an empty, oversized or cancelled prompt before submitting", async () => {
    const send = vi.fn<typeof fetch>()
    const deployment = getImageGenerationDeployment(config, send)!
    for (const prompt of ["", "a".repeat(16_001)]) {
      await expect(deployment.generate(prompt)).rejects.toMatchObject({ outcome: "not-submitted" })
    }
    await expect(deployment.generate("画图", AbortSignal.abort()))
      .rejects.toMatchObject({ outcome: "not-submitted" })
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    [302, "unknown"], [401, "rejected"], [402, "rejected"], [403, "rejected"], [408, "unknown"],
    [409, "unknown"], [422, "rejected"], [429, "rejected"], [503, "unknown"]
  ] as const)("classifies status %s without repeating or exposing upstream content", async (status, outcome) => {
    const send = vi.fn<typeof fetch>(async () => new Response("private prompt and credential", {
      status, headers: { location: "https://other.example.test/img?secret=test" }
    }))
    const deployment = getImageGenerationDeployment(config, send)!
    const error = await deployment.generate("画图").catch(reason => reason)
    expect(error).toMatchObject({ outcome })
    expect(String(error)).not.toMatch(/private prompt|credential|secret/)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("does not retry after a connection interruption or publish secrets from the fetch error", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("Bearer private-key"))
    const error = await getImageGenerationDeployment(config, send)!.generate("画图").catch(reason => reason)
    expect(error).toMatchObject({ outcome: "unknown" })
    expect(String(error)).not.toContain("private-key")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("rejects URLs, missing and multiple images without dereferencing the supplied results", async () => {
    const base64 = (await png).toString("base64")
    for (const data of [[], [{ url: "https://other.test/p?token=secret" }], [{ b64_json: "bad%" }],
      [{ b64_json: base64 }, { b64_json: base64 }]]) {
      const send = vi.fn<typeof fetch>(async () => Response.json({ data }))
      await expect(getImageGenerationDeployment(config, send)!.generate("画图"))
        .rejects.toMatchObject({ outcome: "unrecoverable" })
      expect(send).toHaveBeenCalledTimes(1)
    }
  })

  it("rejects a wrong signature, bad dimensions, animation, truncation and damaged pixels", async () => {
    const source = await png
    const dimensions = Buffer.from(source)
    dimensions.writeUInt32BE(8192, 16)
    dimensions.writeUInt32BE(8192, 20)
    const damaged = Buffer.from(source)
    damaged.fill(0, damaged.indexOf("IDAT") + 4, damaged.indexOf("IDAT") + 9)
    const animationChunk = Buffer.alloc(20)
    animationChunk.writeUInt32BE(8)
    animationChunk.write("acTL", 4)
    for (const bytes of [Buffer.alloc(64), dimensions, damaged, source.subarray(0, -1),
      Buffer.concat([source.subarray(0, 33), animationChunk, source.subarray(33)])]) {
      const deployment = getImageGenerationDeployment(config, async () => payload(bytes))!
      await expect(deployment.generate("画图")).rejects.toMatchObject({ outcome: "unrecoverable" })
    }
  })

  it("bounds both declared and chunked response sizes", async () => {
    const deployment = getImageGenerationDeployment(config, async () => new Response("{}", {
      headers: { "content-length": "1000000000" }
    }))!
    await expect(deployment.generate("画图")).rejects.toThrow("大小限制")
    const chunk = new Uint8Array(1024 * 1024)
    const cancel = vi.fn()
    const chunked = getImageGenerationDeployment(config, async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk) }, cancel
    })))!
    await expect(chunked.generate("画图")).rejects.toThrow("大小限制")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("bounds concurrent outbound requests and releases slots after incomplete requests", async () => {
    let release!: () => void
    const interrupted = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn<typeof fetch>(async () => {
      await interrupted
      throw new Error("connection reset")
    })
    const deployment = getImageGenerationDeployment(config, send)!
    const occupied = Promise.allSettled([deployment.generate("一"), deployment.generate("二")])
    try {
      await expect(deployment.generate("三")).rejects.toMatchObject({ outcome: "not-submitted" })
      expect(send).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await occupied
    }
    await expect(deployment.generate("四")).rejects.toMatchObject({ outcome: "unknown" })
    expect(send).toHaveBeenCalledTimes(3)
  })
})
