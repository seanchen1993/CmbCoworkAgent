import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const models = readFileSync(new URL("./models.ts", import.meta.url), "utf8")
const preload = readFileSync(new URL("../../preload/index.ts", import.meta.url), "utf8")
const chat = readFileSync(
  new URL("../../renderer/src/components/chat/ChatContainer.tsx", import.meta.url),
  "utf8"
)
const worker = readFileSync(
  new URL("../file-attachment-parser/worker.ts", import.meta.url),
  "utf8"
)
const workerClient = readFileSync(
  new URL("../file-attachment-parser/client.ts", import.meta.url),
  "utf8"
)
const parser = readFileSync(new URL("../file-parser.ts", import.meta.url), "utf8")

describe("attachment read authorization boundary", () => {
  it("removes the raw renderer path parse channel from both main and preload", () => {
    expect(models).not.toMatch(/ipcMain\.handle\(\s*"file:parse"\s*,/)
    expect(preload).not.toContain('ipcRenderer.invoke("file:parse",')
    expect(preload).not.toContain("getFilePath: (file: File)")
    expect(preload).not.toContain("webUtils.getPathForFile")
    expect(models).not.toContain("parseFile(filePath")
  })

  it("requires a picker-issued, sender-bound single-file grant", () => {
    expect(models).toContain('"file:parseSelected"')
    expect(models).toContain("issueExternalFileReadGrant(")
    expect(models).toContain("`attachment-picker:${randomUUID()}`")
    expect(models).toContain("resolveExternalFileReadGrant(")
    expect(models).toContain("openStableFileHandle(resolved.rootPath, resolved.filePath)")
    expect(models).toContain("event.sender.id")
    expect(models.indexOf("resolveExternalFileReadGrant(")).toBeLessThan(
      models.indexOf("openStableFileHandle(resolved.rootPath, resolved.filePath)")
    )
    expect(models).not.toContain('{ kind: "path"')
  })

  it("uses bounded browser bytes for drops and parses formats only in a node worker", () => {
    const sizeCheck = chat.indexOf("file.size > MAX_ATTACHMENT_FILE_BYTES")
    const browserRead = chat.indexOf("await file.arrayBuffer()")
    expect(sizeCheck).toBeGreaterThan(0)
    expect(browserRead).toBeGreaterThan(sizeCheck)
    expect(chat).not.toContain("getFilePath(")
    expect(models).toContain('"file:parseBytes"')
    expect(models).toContain("request.bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES")
    expect(models).toContain("getFileAttachmentParserClient().parse(")
    expect(worker).toContain("await parseFileBytes(")
    expect(worker).not.toContain("request.source.filePath")
    expect(worker).toContain("FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES")
    expect(workerClient).toContain("maxOldGenerationSizeMb: 128")
    expect(workerClient).toContain("FILE_ATTACHMENT_PARSE_TIMEOUT_MS")
    expect(workerClient).toContain("void worker.terminate()")
    expect(parser).toContain("MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES")
    expect(parser).toContain("assertBoundedOfficeArchive(buffer)")
  })
})
