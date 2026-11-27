import { describe, expect, it } from "vitest"
import { inspectImageRequest } from "./image-request"

const body = (count: number) => JSON.stringify({ messages: [{
  role: "user",
  content: Array.from({ length: count }, () => ({
    type: "image_url", image_url: { url: "data:image/png;base64,AA==" }
  }))
}] })

describe("image request limits", () => {
  it("requires an explicit image capability and counts all retained images", () => {
    expect(inspectImageRequest(body(1), false)?.rejection?.status).toBe(400)
    expect(inspectImageRequest(body(3), true)).toEqual({ rejection: undefined })
    expect(inspectImageRequest(body(4), true)?.rejection?.status).toBe(400)
  })

  it("rejects a six-MiB overflow even when the encoded request fits the JSON budget", () => {
    const url = "data:image/webp;base64," + Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64")
    const request = JSON.stringify({ messages: [{ role: "user",
      content: [{ type: "image_url", image_url: { url } }] }] })
    expect(Buffer.byteLength(request)).toBeLessThan(12 * 1024 * 1024)
    expect(inspectImageRequest(request, true)?.rejection?.status).toBe(400)
  })

  it("allows ordinary text mentioning image_url", () => {
    expect(inspectImageRequest(JSON.stringify({ messages: [
      { role: "user", content: "image_url" }
    ] }), false)).toBeUndefined()
  })
})
