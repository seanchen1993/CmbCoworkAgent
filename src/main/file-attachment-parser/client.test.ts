import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"
import { FileAttachmentParserClient } from "./client"
import { FILE_ATTACHMENT_PARSE_CANCELLED } from "./protocol"
import { FILE_ATTACHMENT_PARSE_TIMEOUT } from "./protocol"

let workerBuildDirectory = ""
let workerBundlePath = ""
const clients: FileAttachmentParserClient[] = []
const tempDirectories: string[] = []

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-attachment-parser-build-"))
  workerBundlePath = join(workerBuildDirectory, "file-attachment-parser-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

function createClient(): FileAttachmentParserClient {
  const client = new FileAttachmentParserClient(
    async () => new Worker(workerBundlePath, { name: "file-attachment-parser-test" })
  )
  clients.push(client)
  return client
}

function textBytes(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, "utf8")).buffer
}

describe("file attachment parser worker", () => {
  it("parses picker bytes outside the Electron main thread without reopening a path", async () => {
    const attachment = await createClient().parse(
      {
        kind: "bytes",
        fileName: "selected.txt",
        bytes: textBytes("selected through native picker")
      },
      1_000,
      "sender:1"
    )
    expect(attachment).toMatchObject({
      filename: "selected.txt",
      content: "selected through native picker",
      truncated: false
    })
  })

  it("parses a near-limit dropped CSV while the main-thread ticker advances", async () => {
    const content = "row,value\n".repeat(450_000)
    const payload = textBytes(content)
    expect(payload.byteLength).toBeLessThanOrEqual(MAX_ATTACHMENT_FILE_BYTES)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const attachment = await createClient().parse(
        { kind: "bytes", fileName: "dropped.csv", bytes: payload },
        24_000,
        "sender:1"
      )
      expect(attachment.truncated).toBe(true)
      expect(attachment.content.length).toBeLessThan(32_000)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  }, 30_000)

  it("supersedes an older request in the same sender lane", async () => {
    const client = createClient()
    const first = client.parse(
      { kind: "bytes", fileName: "first.txt", bytes: textBytes("first") },
      1_000,
      "sender:1"
    )
    const second = client.parse(
      { kind: "bytes", fileName: "second.txt", bytes: textBytes("second") },
      1_000,
      "sender:1"
    )
    await expect(first).rejects.toMatchObject({ name: FILE_ATTACHMENT_PARSE_CANCELLED })
    await expect(second).resolves.toMatchObject({ content: "second" })
  })

  it("terminates a timed-out parser and recovers with a fresh worker", async () => {
    let workerCount = 0
    const client = new FileAttachmentParserClient(async () => {
      workerCount += 1
      if (workerCount === 1) {
        return new Worker("while (true) {}", {
          eval: true,
          name: "file-attachment-parser-timeout-test",
          resourceLimits: { maxOldGenerationSizeMb: 128 }
        })
      }
      return new Worker(
        `
          const { parentPort } = require("node:worker_threads")
          parentPort.on("message", (request) => {
            if (request.type !== "parse") return
            parentPort.postMessage({
              type: "parse-result",
              requestId: request.requestId,
              ok: true,
              attachment: {
                filename: "recovered.txt",
                filePath: "recovered.txt",
                content: "recovered",
                mimeType: "text/plain",
                size: 9,
                truncated: false
              }
            })
          })
        `,
        { eval: true, name: "file-attachment-parser-recovery-test" }
      )
    }, 250)
    clients.push(client)

    await expect(
      client.parse(
        { kind: "bytes", fileName: "blocked.txt", bytes: textBytes("blocked") },
        1_000,
        "sender:1"
      )
    ).rejects.toMatchObject({ name: FILE_ATTACHMENT_PARSE_TIMEOUT })
    await expect(
      client.parse(
        { kind: "bytes", fileName: "recovered.txt", bytes: textBytes("recovered") },
        1_000,
        "sender:1"
      )
    ).resolves.toMatchObject({ content: "recovered" })
    expect(workerCount).toBe(2)
  })
})
