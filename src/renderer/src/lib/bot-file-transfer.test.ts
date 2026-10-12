import { afterEach, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "../../../main/bots/store"
import { BotArtifacts } from "../../../main/bots/artifacts"
import { BotHost } from "../../../main/bots/host"
import { createBotAPI } from "../../../main/bots/rpc"
import { BOT_FILE_CHUNK_BYTES } from "../../../shared/bot-files"
import { uploadBotFile, loadBotFile } from "./bot-file-transfer"

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-transfer-ui-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const { conversationId } = store.createBot({ nonce: "bot", name: "Transfer" })
  const files = new BotArtifacts(root, store)
  cleanup.push(() => files.close())
  const api = createBotAPI(new BotHost(store, undefined, 4, undefined, files))
  return { store, api, conversationId }
}
it("retries after a lost chunk response using the saved offset and verifies downloaded bytes", async () => {
  const f = await fixture(),
    bytes = new Uint8Array(2 * BOT_FILE_CHUNK_BYTES + 17).fill(73)
  const file = new File([bytes], "report.txt", { type: "text/plain" })
  const positions: number[] = [],
    progress: number[] = []
  let fail = true
  const api = {
    ...f.api,
    async uploadChunk(input: Parameters<typeof f.api.uploadChunk>[0]) {
      positions.push(input.offset)
      const result = await f.api.uploadChunk(input)
      if (fail) {
        fail = false
        throw new Error("response lost")
      }
      return result
    }
  }
  await expect(
    uploadBotFile(api, f.conversationId, file, "upload", new AbortController().signal, () => {})
  ).rejects.toThrow("response lost")
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  const artifact = await uploadBotFile(
    api,
    f.conversationId,
    file,
    "upload",
    new AbortController().signal,
    (value) => progress.push(value)
  )
  expect(positions).toEqual([0, BOT_FILE_CHUNK_BYTES, 2 * BOT_FILE_CHUNK_BYTES])
  expect(progress.at(-1)).toBe(100)
  const result = await loadBotFile(artifact.id, f.api.fileChunk, new AbortController().signal)
  expect(Buffer.from(await result.blob.arrayBuffer()).equals(bytes)).toBe(true)
  expect(result.blob.type).toBe("application/octet-stream")
  await expect(
    loadBotFile(
      artifact.id,
      async (input) => ({
        ...(await f.api.fileChunk(input)),
        base64: Buffer.alloc(BOT_FILE_CHUNK_BYTES, 3).toString("base64")
      }),
      new AbortController().signal
    )
  ).rejects.toThrow()
})
it("cancels staging without publishing a partial attachment", async () => {
  const f = await fixture(),
    controller = new AbortController()
  const api = {
    ...f.api,
    async uploadChunk(input: Parameters<typeof f.api.uploadChunk>[0]) {
      const result = await f.api.uploadChunk(input)
      controller.abort(new Error("user canceled"))
      return result
    }
  }
  const file = new File([new Uint8Array(BOT_FILE_CHUNK_BYTES + 1)], "report.txt", {
    type: "text/plain"
  })
  await expect(
    uploadBotFile(api, f.conversationId, file, "canceled", controller.signal, () => {})
  ).rejects.toThrow("user canceled")
  expect(f.store.artifacts(f.conversationId)).toEqual([])
  await expect(f.api.finishUpload("canceled")).rejects.toThrow()
})
it("can upload and download an empty file and refuses oversized ordinary files before calling the Host", async () => {
  const f = await fixture()
  const artifact = await uploadBotFile(
    f.api,
    f.conversationId,
    new File([], "empty.txt", { type: "text/plain" }),
    "empty",
    new AbortController().signal,
    () => {}
  )
  expect(
    (await loadBotFile(artifact.id, f.api.fileChunk, new AbortController().signal)).blob.size
  ).toBe(0)
  await expect(
    uploadBotFile(
      f.api,
      f.conversationId,
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.txt"),
      "big",
      new AbortController().signal,
      () => {}
    )
  ).rejects.toThrow("25 MiB")
})
