import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ImageAssetStore, MAX_IMAGE_BYTES, detectImageMime } from "./image-assets"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4hEAAAAASUVORK5CYII=",
  "base64"
)

describe("conversation image assets", () => {
  let root: string
  let store: ImageAssetStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vision-assets-"))
    store = new ImageAssetStore(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("persists a stable reference for follow-up questions and detects the actual MIME", async () => {
    const first = await store.register("thread-a", png, "misnamed.jpg")
    expect(first.mimeType).toBe("image/png")
    expect((await store.register("thread-a", png, "second source")).id).toBe(first.id)
    const [resolved] = await new ImageAssetStore(root).resolve("thread-a", [first.id])
    expect(resolved.data).toEqual(png)
    expect(resolved.source).toBe("misnamed.jpg")
  })

  it("rejects references from another thread, arbitrary paths and URLs", async () => {
    const image = await store.register("thread-a", png, "upload.png")
    await expect(store.resolve("thread-b", [image.id])).rejects.toThrow("无权限")
    for (const id of ["../../secret.png", "https://example.com/image.png", "img_bad"]) {
      await expect(store.resolve("thread-a", [id])).rejects.toThrow("无效的 image_id")
    }
    expect((await store.register("thread-b", png, "upload.png")).id).not.toBe(image.id)
  })

  it("cleans deleted conversation images while retaining other conversations", async () => {
    const first = await store.register("thread-a", png, "upload-a")
    const second = await store.register("thread-b", png, "upload-b")
    await store.deleteThread("thread-a")
    await store.deleteThread("thread-a")
    await expect(store.resolve("thread-a", [first.id])).rejects.toThrow("无权限")
    expect((await store.resolve("thread-b", [second.id]))[0].data).toEqual(png)
  })

  it("projects uploaded images and MCP screenshot blocks into ordered references without mutating history", async () => {
    const history = [
      { type: "text", text: "Compare both images" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${png.toString("base64")}` } },
      {
        type: "image",
        source_type: "base64",
        data: png.toString("base64"),
        mime_type: "image/jpeg"
      }
    ]
    const original = structuredClone(history)
    const projected = (await store.projectContent(
      "thread-a",
      history,
      "browser screenshot"
    )) as Array<{ type: string; text: string }>
    expect(history).toEqual(original)
    expect(projected.map((item) => item.type)).toEqual(["text", "text", "text"])
    expect(projected[1].text).toContain("image/png")
    expect(projected[1].text).toContain("browser screenshot #2")
    expect(projected[2].text).toContain("browser screenshot #3")
    expect(JSON.stringify(projected)).not.toContain(png.toString("base64"))
    const id = /image_id=(img_[a-f0-9]{64})/.exec(projected[1].text)![1]
    expect((await store.resolve("thread-a", [id, id])).map((item) => item.id)).toEqual([id, id])
  })

  it("leaves ordinary text history unchanged and makes unsupported or unavailable images explicit", async () => {
    const content = [{ type: "text", text: "ordinary chat" }]
    const projected = (await store.projectContent("thread-a", content, "upload")) as unknown[]
    expect(projected[0]).toBe(content[0])
    expect(await store.projectContent("thread-a", "ordinary chat", "upload")).toBe("ordinary chat")
    const result = await store.projectContent(
      "thread-a",
      [{ type: "image_url", image_url: { url: "https://private.example/image" } }],
      "upload"
    )
    expect(JSON.stringify(result)).toContain("不接受远端图片 URL")
    expect(JSON.stringify(result)).not.toContain("https://private.example")
    await expect(store.register("thread-a", Buffer.from("<svg/>"), "image.svg")).rejects.toThrow(
      "格式无效"
    )
    await expect(
      store.register("thread-a", Buffer.alloc(MAX_IMAGE_BYTES + 1), "huge.png")
    ).rejects.toThrow("5MB")
  })

  it("bounds count and aggregate encoded size before analysis", async () => {
    await expect(store.resolve("thread-a", [])).rejects.toThrow("1 至 8")
    await expect(store.resolve("thread-a", Array(9).fill("x"))).rejects.toThrow("1 至 8")
    const data = Buffer.alloc(MAX_IMAGE_BYTES)
    png.copy(data)
    const image = await store.register("thread-a", data, "large.png")
    await expect(store.resolve("thread-a", Array(4).fill(image.id))).rejects.toThrow("20MB")
  })

  it("rejects tampering and missing image files", async () => {
    const image = await store.register("thread-a", png, "upload.png")
    const { createHash } = await import("node:crypto")
    const directory = join(root, createHash("sha256").update("thread-a").digest("hex"))
    await writeFile(join(directory, `${image.id}.bin`), Buffer.from("changed"))
    await expect(store.resolve("thread-a", [image.id])).rejects.toThrow("已损坏")
  })

  it("recognizes all supported binary signatures", () => {
    expect(detectImageMime(Buffer.from([255, 216, 255, 224]))).toBe("image/jpeg")
    expect(detectImageMime(Buffer.from("GIF89a"))).toBe("image/gif")
    expect(detectImageMime(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp")
  })
})
