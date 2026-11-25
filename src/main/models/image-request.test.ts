import { describe, expect, it } from "vitest"
import { imageRequestRejection } from "./image-request"

const body = (count: number) => JSON.stringify({ messages: [{
  role: "user",
  content: Array.from({ length: count }, () => ({
    type: "image_url", image_url: { url: "data:image/png;base64,AA==" }
  }))
}] })

describe("image request limits", () => {
  it("requires an explicit image capability and counts all retained images", () => {
    expect(imageRequestRejection(body(1), false)?.status).toBe(400)
    expect(imageRequestRejection(body(3), true)).toBeUndefined()
    expect(imageRequestRejection(body(4), true)?.status).toBe(400)
  })

  it("rejects a six-MiB overflow even when the encoded request fits the JSON budget", () => {
    const url = "data:image/webp;base64," + Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64")
    const request = JSON.stringify({ messages: [{ role: "user",
      content: [{ type: "image_url", image_url: { url } }] }] })
    expect(Buffer.byteLength(request)).toBeLessThan(12 * 1024 * 1024)
    expect(imageRequestRejection(request, true)?.status).toBe(400)
  })

  it("allows ordinary text mentioning image_url", () => {
    expect(imageRequestRejection(JSON.stringify({ messages: [
      { role: "user", content: "image_url" }
    ] }), false)).toBeUndefined()
  })
})
