import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createBotResultEvidenceReader, type BotResultEvidence } from "./work-result-evidence"

const binding = {
  botId: "bot",
  workId: "work",
  threadId: "thread",
  executionTaskId: "execution",
  reviewTaskId: "review"
}
const text = (messageId: string, body = "evidence"): BotResultEvidence => ({
  kind: "text", sourceTaskId: "execution", messageId, label: "Result", text: body
})

describe("work result evidence", () => {
  it("paginates exact records and refuses IDs or cursors from another review", async () => {
    const entries = Array.from({ length: 9 }, (_, index) => text(String(index)))
    const first = createBotResultEvidenceReader(binding, () => entries)
    const second = createBotResultEvidenceReader({ ...binding, executionTaskId: "newer" }, () => entries)
    const page = first.list()
    expect(page.items).toHaveLength(8)
    expect(first.list(page.nextCursor).items.map(item => item.reference)).toEqual([
      { sourceTaskId: "execution", messageId: "8" }
    ])
    expect(() => second.list(page.nextCursor)).toThrow("不可访问")
    await expect(second.read(page.items[0].id, { signal: new AbortController().signal }))
      .rejects.toThrow("不可访问")
  })

  it("preserves upstream truncation and invalidates a cursor when the exact text changes", async () => {
    let entry = { ...text("result", "x".repeat(6_003)), truncated: true }
    const reader = createBotResultEvidenceReader(binding, () => [entry])
    const id = reader.list().items[0].id
    const signal = new AbortController().signal
    const page = await reader.read(id, { signal })
    expect(page).toMatchObject({ status: "ok", text: "x".repeat(6_000), truncated: true })
    expect("nextCursor" in page).toBe(true)
    if (!("nextCursor" in page)) throw new Error("Expected a continuation")
    expect(await reader.read(id, { signal, cursor: page.nextCursor })).toMatchObject({
      status: "ok", text: "xxx", truncated: true
    })
    entry = { ...text("result", "y".repeat(6_003)), truncated: true }
    await expect(reader.read(id, { signal, cursor: page.nextCursor })).rejects.toThrow("不可访问")
  })

  it("reads only the exact formal snapshot, detects same-size changes and rechecks authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-result-evidence-"))
    try {
      const digest = createHash("sha256").update("original").digest("hex")
      await mkdir(join(root, digest))
      const attachmentPath = join(root, digest, "result.txt")
      const filePath = join(root, "result.txt")
      await writeFile(attachmentPath, "original")
      await writeFile(filePath, "modified")
      const entry: BotResultEvidence = {
        kind: "snapshot", sourceTaskId: "execution", callId: "delivery", fileIndex: 0, root,
        file: { filePath, attachmentPath, name: "result.txt", size: 8 }
      }
      let authorized = true
      const parse = vi.fn(async ({ bytes }: { bytes: Uint8Array }) =>
        ({ text: Buffer.from(bytes).toString("utf8"), truncated: false }))
      const reader = createBotResultEvidenceReader(binding, () => authorized ? [entry] : null, parse)
      const descriptor = reader.list().items[0]
      const signal = new AbortController().signal
      expect(JSON.stringify(descriptor)).not.toContain(root)
      expect(descriptor.reference).toEqual({ sourceTaskId: "execution", callId: "delivery", fileIndex: 0 })
      expect(await reader.read(descriptor.id, { signal })).toMatchObject({ status: "ok", text: "original" })

      await writeFile(attachmentPath, "tampered")
      expect(await reader.read(descriptor.id, { signal })).toMatchObject({ status: "unavailable" })
      expect(parse).toHaveBeenCalledTimes(1)
      await writeFile(attachmentPath, "original")
      parse.mockImplementationOnce(async () => {
        authorized = false
        return { text: "original", truncated: false }
      })
      await expect(reader.read(descriptor.id, { signal })).rejects.toThrow("不可访问")
      expect(() => reader.list()).toThrow("不可访问")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
