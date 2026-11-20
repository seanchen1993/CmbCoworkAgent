import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import AdmZip from "adm-zip"
import * as XLSX from "xlsx"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"
import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES
} from "../../shared/workspace-file-preview"
import { readPreviewTextPage, resolveWorkspacePreviewCandidate } from "./reader"

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

function workspaceSource(filePath: string, workspacePathKind: "relative" | "absolute" | "auto") {
  return { threadId: "thread-preview", filePath, workspacePathKind }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe("workspace file preview reader", () => {
  it("requires explicit Office opt-in while preserving the original raw text path", async () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["金额", 74.13]]), "合成")
    const sourceBytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer
    const filePath = await tempFile("report.xlsx", sourceBytes)
    const raw = await readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation())
    expect(raw.result.office).toBeUndefined()
    expect(raw.result.content).toBe(sourceBytes.toString("utf8"))
    const office = await readPreviewTextPage(
      externalSource(filePath),
      undefined,
      0,
      cancellation(),
      true
    )
    expect(office.result.office).toMatchObject({
      kind: "spreadsheet",
      sheets: [{ name: "合成", rows: [["金额", "74.13"]] }]
    })
    expect(office.result.content).toBe("")
    expect(office.result.nextOffset).toBeNull()
  })

  it("keeps Office reads behind the original workspace boundary and offset validation", async () => {
    const filePath = await tempFile("outside.xlsx", Buffer.from("not read"))
    await expect(
      readPreviewTextPage(
        workspaceSource(filePath, "absolute"),
        join(dirname(filePath), "other"),
        0,
        cancellation(),
        true
      )
    ).rejects.toThrow(/outside workspace/)
    await expect(
      readPreviewTextPage(externalSource(filePath), undefined, 1, cancellation(), true)
    ).rejects.toThrow(/文件起始/)
    const textPath = await tempFile("ordinary.txt", "unchanged")
    await expect(
      readPreviewTextPage(externalSource(textPath), undefined, 0, cancellation(), true)
    ).rejects.toThrow(/DOCX、XLSX/)
  })

  it("enforces the existing raw and declared ZIP budgets before Office parsing", async () => {
    const tooBig = await tempFile("large.xlsx", Buffer.alloc(MAX_ATTACHMENT_FILE_BYTES + 1))
    await expect(
      readPreviewTextPage(externalSource(tooBig), undefined, 0, cancellation(), true)
    ).rejects.toMatchObject({ failure: "initial-too-large" })
    const zip = new AdmZip()
    zip.addFile("word/document.xml", Buffer.from("x"))
    const data = zip.toBuffer()
    const centralHeader = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    data.writeUInt32LE(32 * 1024 * 1024 + 1, centralHeader + 24)
    const expanded = await tempFile("large-entry.docx", data)
    await expect(
      readPreviewTextPage(externalSource(expanded), undefined, 0, cancellation(), true)
    ).rejects.toThrow(/32MB/)
  })

  it("pages a large log by both byte and line budgets without reading it whole", async () => {
    const filePath = await tempFile("large.log", "line\n".repeat(20_000))
    const first = await readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation())

    expect(first.result.contentBytes).toBeLessThanOrEqual(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
    expect(first.result.lineCount).toBe(WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES)
    expect(first.result.hasMore).toBe(true)
    expect(first.result.nextOffset).toBeGreaterThan(0)
    expect(first.result.content).toBe("line\n".repeat(WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES))
  })

  it("keeps a four-byte UTF-8 codepoint intact across page boundaries", async () => {
    const prefix = "a".repeat(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES - 2)
    const filePath = await tempFile("unicode.txt", `${prefix}😀tail`)
    const first = await readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation())
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
    const first = await readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation())
    expect(first.result.nextOffset).toBe(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
    expect(first.result.contentBytes).toBeLessThanOrEqual(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
  })

  it("returns a terminal empty page instead of a non-advancing continuation", async () => {
    const filePath = await tempFile("empty.txt", "")
    const page = await readPreviewTextPage(externalSource(filePath), undefined, 0, cancellation())
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

  it("reads an absolute renderer candidate only after main proves it is in the workspace", async () => {
    const filePath = await tempFile("inside.txt", "inside")
    const page = await readPreviewTextPage(
      workspaceSource(filePath, "absolute"),
      dirname(filePath),
      0,
      cancellation()
    )

    expect(page.result.content).toBe("inside")
    expect(page.resolvedPath).toBe(await realpath(filePath))
  })

  it("reads a historical absolute directory alias only when it resolves inside the same workspace", async () => {
    const filePath = await tempFile("report.txt", "original artifact")
    const alias = join(dirname(await tempFile("placeholder.txt", "")), "old-workspace")
    await symlink(dirname(filePath), alias, process.platform === "win32" ? "junction" : "dir")
    const page = await readPreviewTextPage(
      workspaceSource(join(alias, "report.txt"), "absolute"),
      dirname(filePath),
      0,
      cancellation()
    )
    expect(page.result.content).toBe("original artifact")
    expect(page.resolvedPath).toBe(await realpath(filePath))
    const outside = await tempFile("private.txt", "unrelated data")
    await symlink(outside, join(dirname(filePath), "escape.txt"))
    await expect(
      readPreviewTextPage(
        workspaceSource(join(alias, "escape.txt"), "absolute"),
        dirname(filePath),
        0,
        cancellation()
      )
    ).rejects.toThrow("Access denied")
  })

  it("rejects an absolute renderer candidate outside the authoritative workspace", async () => {
    const filePath = await tempFile("outside.txt", "outside")
    await expect(
      readPreviewTextPage(
        workspaceSource(filePath, "absolute"),
        join(dirname(filePath), "different-workspace"),
        0,
        cancellation()
      )
    ).rejects.toThrow("Access denied: path outside workspace")
  })

  it("rejects a relative path mislabeled as an absolute workspace candidate", async () => {
    const filePath = await tempFile("relative.txt", "relative")
    await expect(
      readPreviewTextPage(
        workspaceSource("relative.txt", "absolute"),
        dirname(filePath),
        0,
        cancellation()
      )
    ).rejects.toThrow("Access denied: absolute workspace preview path required")
  })

  it("keeps the legacy slash-prefixed workspace-relative contract", async () => {
    const filePath = await tempFile("legacy.txt", "legacy")
    const page = await readPreviewTextPage(
      workspaceSource("/legacy.txt", "relative"),
      dirname(filePath),
      0,
      cancellation()
    )

    expect(page.result.content).toBe("legacy")
  })

  it("resolves the POSIX file-tree /src convention relative to the authoritative root", () => {
    expect(
      resolveWorkspacePreviewCandidate("/src/file.ts", "/workspace", "relative", posix)
    ).toEqual({
      root: "/workspace",
      candidate: "/workspace/src/file.ts"
    })
  })

  it("preserves a genuine in-workspace POSIX absolute path in auto mode", () => {
    expect(
      resolveWorkspacePreviewCandidate("/workspace/src/file.ts", "/workspace", "auto", posix)
    ).toEqual({
      root: "/workspace",
      candidate: "/workspace/src/file.ts"
    })
  })

  it("rejects auto paths whose workspace-relative fallback traverses the root", () => {
    expect(() =>
      resolveWorkspacePreviewCandidate("/../../etc/passwd", "/workspace", "auto", posix)
    ).toThrow("Access denied: path outside workspace")
  })

  it("does not reinterpret an absolute POSIX tool path as workspace-relative", () => {
    expect(() =>
      resolveWorkspacePreviewCandidate("/tmp/report.md", "/workspace", "absolute", posix)
    ).toThrow("Access denied: path outside workspace")
  })

  it("fails safely when workspace metadata is still unavailable", async () => {
    await expect(
      readPreviewTextPage(workspaceSource("/src/file.ts", "auto"), undefined, 0, cancellation())
    ).rejects.toThrow("No workspace folder linked")
  })

  it("reads a slash-prefixed auto path through the authoritative workspace root", async () => {
    const filePath = await tempFile("auto.txt", "auto")
    const page = await readPreviewTextPage(
      workspaceSource("/auto.txt", "auto"),
      dirname(filePath),
      0,
      cancellation()
    )

    expect(page.result.content).toBe("auto")
    expect(page.resolvedPath).toBe(await realpath(filePath))
  })
})
