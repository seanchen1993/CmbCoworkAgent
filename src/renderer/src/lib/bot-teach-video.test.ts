import { expect, it } from "vitest"
import { createHash } from "node:crypto"
import { loadBotTeachVideo } from "./bot-teach-video"
import type { BotTeachSession } from "../../../shared/bot-teach"

const bytes = Buffer.alloc(700_000, 42)
const sha256 = createHash("sha256").update(bytes).digest("hex")
const session = {
  id: "recording",
  video: { size: bytes.length, sha256, mime: "video/webm" }
} as BotTeachSession
it("reconstructs bounded chunks and verifies the complete recording before exposing it", async () => {
  const positions: number[] = [],
    progress: number[] = []
  const result = await loadBotTeachVideo(
    session,
    async ({ offset }) => {
      positions.push(offset)
      return {
        offset,
        size: bytes.length,
        sha256,
        base64: bytes.subarray(offset, offset + 512 * 1024).toString("base64")
      }
    },
    new AbortController().signal,
    (value) => progress.push(value)
  )
  expect(positions).toEqual([0, 512 * 1024])
  expect(progress.at(-1)).toBe(100)
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes)
})
it.each(["hash", "offset", "empty", "cancel"])(
  "rejects an invalid or cancelled video: %s",
  async (kind) => {
    const controller = new AbortController()
    await expect(
      loadBotTeachVideo(
        session,
        async ({ offset }) => {
          if (kind === "cancel") controller.abort()
          const part = Buffer.from(bytes.subarray(offset, offset + 512 * 1024))
          if (kind === "hash") part[0] = 0
          return {
            offset: kind === "offset" ? offset + 1 : offset,
            size: bytes.length,
            sha256,
            base64: kind === "empty" ? "" : part.toString("base64")
          }
        },
        controller.signal,
        () => {}
      )
    ).rejects.toThrow()
  }
)
