import { afterEach, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BOT_FILE_BYTES, BOT_VIDEO_BYTES } from "../../shared/bot-files"

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(bytes = Buffer.from("upload-proof")) {
  const root = await mkdtemp(join(tmpdir(), "bot-transfer-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const { conversationId } = store.createBot({ nonce: "create", name: "Files" })
  const directory = join(root, "objects"),
    files = new BotArtifacts(directory, store)
  const request = {
    nonce: "file",
    conversationId,
    name: "report.txt",
    mime: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }
  return { root, directory, files, store, bytes, request }
}
it("resumes private staging after service recreation and publishes only after hash verification", async () => {
  const f = await fixture()
  await f.files.transfers.begin(f.request)
  const first = {
    id: f.request.nonce,
    offset: 0,
    base64: f.bytes.subarray(0, 5).toString("base64")
  }
  await f.files.transfers.chunk(first)
  await f.files.close()
  const reopened = new BotArtifacts(f.directory, f.store)
  cleanup.push(() => reopened.close())
  await reopened.recover()
  expect((await reopened.transfers.begin(f.request)).offset).toBe(5)
  expect(f.store.artifacts(f.request.conversationId)).toEqual([])
  await expect(reopened.transfers.finish(f.request.nonce)).rejects.toThrow("完整上传")
  await expect(
    reopened.transfers.chunk({ ...first, base64: Buffer.from("wrong").toString("base64") })
  ).rejects.toThrow("内容不一致")
  await expect(reopened.transfers.chunk({ ...first, offset: 6 })).rejects.toThrow("不连续")
  await reopened.transfers.chunk({
    ...first,
    offset: 5,
    base64: f.bytes.subarray(5).toString("base64")
  })
  const artifact = await reopened.transfers.finish(f.request.nonce)
  expect((await reopened.read(artifact.id)).bytes).toEqual(f.bytes)
  expect(await reopened.transfers.begin(f.request)).toMatchObject({
    offset: f.bytes.length,
    artifact
  })
  await reopened.transfers.cancel(f.request.nonce)
  expect(f.store.getArtifact(f.request.nonce)).toEqual(artifact)
})
it("rejects corrupt content and refuses linked staging writes", async () => {
  const f = await fixture()
  await f.files.transfers.begin(f.request)
  const part = join(
    f.directory,
    "uploads",
    `${createHash("sha256").update(f.request.nonce).digest("hex")}.part`
  )
  await writeFile(part, Buffer.alloc(f.bytes.length, 45))
  await expect(f.files.transfers.finish(f.request.nonce)).rejects.toThrow("完整性")
  expect(f.store.artifacts(f.request.conversationId)).toEqual([])
  const outside = join(f.root, "outside.txt")
  await writeFile(outside, "private")
  await unlink(part)
  await symlink(outside, part)
  await expect(
    f.files.transfers.chunk({ id: f.request.nonce, offset: 7, base64: "YQ==" })
  ).rejects.toThrow()
})
it("enforces 25 MiB files, 200 MiB video reservations, capacity and cancellation", async () => {
  const f = await fixture()
  await f.files.transfers.begin({ ...f.request, size: BOT_FILE_BYTES })
  await expect(
    f.files.transfers.begin({ ...f.request, nonce: "large", size: BOT_FILE_BYTES + 1 })
  ).rejects.toThrow("25 MiB")
  await f.files.transfers.cancel(f.request.nonce)
  const video = { ...f.request, name: "clip.mp4", mime: "video/mp4", size: BOT_VIDEO_BYTES }
  await f.files.transfers.begin(video)
  await f.files.transfers.begin({ ...video, nonce: "second" })
  await expect(f.files.transfers.begin({ ...video, nonce: "third" })).rejects.toThrow("未完成")
  await expect(
    f.files.transfers.begin({ ...video, nonce: "oversize", size: BOT_VIDEO_BYTES + 1 })
  ).rejects.toThrow()
  await f.files.transfers.cancel("second")
  await f.files.transfers.begin({ ...video, nonce: "third" })
})
it("handles empty files and concurrent duplicate chunks without adding duplicate bytes", async () => {
  const f = await fixture()
  await f.files.transfers.begin(f.request)
  const chunk = { id: f.request.nonce, offset: 0, base64: f.bytes.toString("base64") }
  await Promise.all([f.files.transfers.chunk(chunk), f.files.transfers.chunk(chunk)])
  expect((await f.files.transfers.finish(f.request.nonce)).size).toBe(f.bytes.length)
  const empty = {
    ...f.request,
    nonce: "empty",
    size: 0,
    sha256: createHash("sha256").digest("hex")
  }
  await f.files.transfers.begin(empty)
  expect((await f.files.transfers.finish("empty")).size).toBe(0)
  expect((await f.files.chunk({ id: "empty", offset: 0 })).base64).toBe("")
})
