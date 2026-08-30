import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES
} from "../../shared/workspace-file-preview"
import { readPreviewTextPage } from "./reader"

const tempDirectories: string[] = []

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cmb-file-preview-"))
  tempDirectories.push(directory)
  const filePath = join(directory, name)
  await writeFile(filePath, content)
  return filePath
}

function cancellation(value = 0): Int32Array {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(state, 0, value)
  return state
}

function externalSource(filePath: string) {
  return { externalFullPath: filePath, trustedRootPath: dirname(filePath) }
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("workspace file preview reader", () => {
  it("pages a large log by both byte and line budgets without reading it whole", async () => {
    const filePath = await tempFile("large.log", "line\n".repeat(20_000))
    const first = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      0,
      cancellation()
    )

    expect(first.result.contentBytes).toBeLessThanOrEqual(
      WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES
    )
    expect(first.result.lineCount).toBe(WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES)
    expect(first.result.hasMore).toBe(true)
    expect(first.result.nextOffset).toBeGreaterThan(0)
    expect(first.result.content).toBe("line\n".repeat(WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES))
  })

  it("keeps a four-byte UTF-8 codepoint intact across page boundaries", async () => {
    const prefix = "a".repeat(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES - 2)
    const filePath = await tempFile("unicode.txt", `${prefix}😀tail`)
    const first = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      0,
      cancellation()
    )
    expect(first.result.content).toBe(prefix)
    expect(first.result.nextOffset).toBe(Buffer.byteLength(prefix))

    const second = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      first.result.nextOffset as number,
      cancellation()
    )
    expect(second.result.content).toBe("😀tail")
    expect(second.result.hasMore).toBe(false)
  })

  it("advances a malformed continuation-byte page and keeps its IPC payload bounded", async () => {
    const filePath = await tempFile(
      "malformed.txt",
      Buffer.alloc(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES + 32, 0x80)
    )
    const first = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      0,
      cancellation()
    )
    expect(first.result.nextOffset).toBe(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
    expect(first.result.contentBytes).toBeLessThanOrEqual(
      WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES
    )
  })

  it("returns a terminal empty page instead of a non-advancing continuation", async () => {
    const filePath = await tempFile("empty.txt", "")
    const page = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      0,
      cancellation()
    )
    expect(page.result).toMatchObject({
      content: "",
      contentBytes: 0,
      hasMore: false,
      nextOffset: null,
      truncated: false
    })
  })

  it("honors cancellation before touching disk", async () => {
    const filePath = await tempFile("cancelled.txt", "content")
    await expect(
      readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation(1))
    ).rejects.toMatchObject({ name: WORKSPACE_FILE_PREVIEW_CANCELLED })
  })
})
