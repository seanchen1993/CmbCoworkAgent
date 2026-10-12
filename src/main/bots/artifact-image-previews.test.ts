import { expect, it, vi } from "vitest"
import { BotArtifactImagePreviews } from "./artifact-image-previews"
import { BotDocumentReader } from "./document-reader"
import type { BotImageResult } from "./image-contract"

const image = (bytes = 32): BotImageResult => ({
  mime: "image/jpeg",
  base64: Buffer.alloc(bytes).toString("base64"),
  width: 1,
  height: 1,
  originalWidth: 1,
  originalHeight: 1,
  region: { x: 0, y: 0, width: 1, height: 1 }
})
const signal = () => new AbortController().signal
it("shares exact raster work while cancellation only releases the requesting consumer", async () => {
  const reader = new BotDocumentReader()
  let finish!: (result: BotImageResult) => void, workerSignal!: AbortSignal
  const parse = vi.spyOn(reader, "image").mockImplementation((_bytes, _region, signal) => {
    workerSignal = signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const previews = new BotArtifactImagePreviews(reader),
    first = new AbortController()
  const a = previews.get("same-original", Buffer.from("immutable"), first.signal)
  const rejected = expect(a).rejects.toThrow("first cancelled")
  const b = previews.get("same-original", Buffer.from("immutable"), signal())
  await Promise.resolve()
  expect(parse).toHaveBeenCalledTimes(1)
  first.abort(new Error("first cancelled"))
  await rejected
  expect(workerSignal.aborted).toBe(false)
  finish(image())
  expect(await b).toEqual(image())
  expect(await previews.get("same-original", Buffer.from("immutable"), signal())).toEqual(image())
  expect(parse).toHaveBeenCalledTimes(1)
  await previews.close()
})
it("the final consumer cancels its worker, a new request retries, and failures never enter the cache", async () => {
  const reader = new BotDocumentReader()
  const parse = vi
    .spyOn(reader, "image")
    .mockImplementationOnce(
      (_bytes, _region, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
    )
    .mockRejectedValueOnce(new Error("decode failed"))
    .mockResolvedValue(image())
  const previews = new BotArtifactImagePreviews(reader),
    controller = new AbortController()
  const a = previews.get("original", Buffer.alloc(1), controller.signal)
  const rejected = expect(a).rejects.toThrow("last cancelled")
  await Promise.resolve()
  controller.abort(new Error("last cancelled"))
  await rejected
  await expect(previews.get("original", Buffer.alloc(1), signal())).rejects.toThrow("decode failed")
  expect(await previews.get("original", Buffer.alloc(1), signal())).toEqual(image())
  expect(parse).toHaveBeenCalledTimes(3)
  await previews.close()
})
it("bounds retained strings by bytes as well as entries and keeps the recently used view", async () => {
  const reader = new BotDocumentReader(),
    parse = vi.spyOn(reader, "image").mockResolvedValue(image(1024 * 1024))
  const previews = new BotArtifactImagePreviews(reader)
  await previews.get("one", Buffer.alloc(1), signal())
  await previews.get("two", Buffer.alloc(1), signal())
  await previews.get("one", Buffer.alloc(1), signal())
  await previews.get("three", Buffer.alloc(1), signal())
  await previews.get("one", Buffer.alloc(1), signal())
  expect(parse).toHaveBeenCalledTimes(3)
  await previews.get("two", Buffer.alloc(1), signal())
  expect(parse).toHaveBeenCalledTimes(4)
  await previews.close()
  const small = new BotArtifactImagePreviews(reader)
  parse.mockResolvedValue(image())
  for (let n = 0; n < 17; n++) await small.get(String(n), Buffer.alloc(1), signal())
  const count = parse.mock.calls.length
  await small.get("16", Buffer.alloc(1), signal())
  expect(parse).toHaveBeenCalledTimes(count)
  await small.get("0", Buffer.alloc(1), signal())
  expect(parse).toHaveBeenCalledTimes(count + 1)
  await small.close()
})
it("close drains running workers, rejects late results and never admits another cache hit", async () => {
  const reader = new BotDocumentReader()
  let finish!: (value: BotImageResult) => void
  vi.spyOn(reader, "image").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const previews = new BotArtifactImagePreviews(reader)
  const pending = previews.get("one", Buffer.alloc(1), signal())
  const rejected = expect(pending).rejects.toThrow("关闭")
  await Promise.resolve()
  let closed = false
  const closing = previews.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  finish(image())
  await rejected
  await closing
  await expect(previews.get("one", Buffer.alloc(1), signal())).rejects.toThrow("关闭")
})
