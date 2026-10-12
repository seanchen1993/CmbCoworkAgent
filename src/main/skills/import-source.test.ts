import AdmZip from "adm-zip"
import { createServer, type RequestListener } from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { inspectSkillImport } from "./import-preview"
import { readSkillImportSource } from "./import-source"
import { SKILL_IMPORT_MAX_BYTES } from "../../shared/skill-import"

const markdown =
  "---\nname: release-review\ndescription: 发布评审\ncompatibility: 需要 Node.js 22\nhooks:\n  PreToolUse: []\n---\n检查变更、测试和回退步骤。"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function server(handler: RequestListener) {
  const service = createServer(handler)
  service.listen(0, "127.0.0.1")
  await once(service, "listening")
  cleanups.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((resolve) => service.close(() => resolve()))
  })
  const address = service.address()
  if (!address || typeof address === "string") throw new Error("missing port")
  return `http://127.0.0.1:${address.port}`
}

it("previews exact Markdown, declared dependencies and Hooks without running content", () => {
  const bytes = Buffer.from(markdown)
  expect(inspectSkillImport(bytes, "SKILL.md")).toEqual({
    name: "release-review",
    description: "发布评审",
    compatibility: "需要 Node.js 22",
    dependencies: {
      source: "none",
      state: "unstructured",
      checks: [],
      reason: "兼容性说明为自由文本，依赖未核验"
    },
    markdown,
    resourceCount: 0,
    hasHooks: true,
    unsupportedBotHooks: [],
    sha256: createHash("sha256").update(bytes).digest("hex")
  })
  const zip = new AdmZip()
  zip.addFile("review/SKILL.md", bytes)
  zip.addFile("review/scripts/check.ps1", Buffer.from("throw 'MUST_NOT_EXECUTE'"))
  expect(inspectSkillImport(zip.toBuffer(), "review.zip")).toMatchObject({
    resourceCount: 1,
    markdown
  })
})

it("recognizes the wired Bot lifecycle events using the runtime's original Hook parser", () => {
  const zip = new AdmZip()
  zip.addFile("SKILL.md", Buffer.from(markdown))
  zip.addFile(
    "hooks/hooks.json",
    Buffer.from(
      JSON.stringify([
        { id: "setup", enabled: true, event: "Setup", command: "node setup.cjs" },
        { id: "notify", enabled: true, event: "Notification", command: "node notify.cjs" },
        { id: "start", enabled: true, event: "SessionStart", command: "node start.cjs" },
        { id: "end", enabled: true, event: "SessionEnd", command: "node report.cjs" },
        { id: "supported", enabled: true, event: "PostToolUseFailure", command: "node check.cjs" },
        { id: "disabled", enabled: false, event: "Notification", command: "node skip.cjs" }
      ])
    )
  )
  expect(inspectSkillImport(zip.toBuffer(), "skill.zip")).toMatchObject({
    hasHooks: true,
    unsupportedBotHooks: []
  })
})

it.each(["CON.txt", "a.", "a ", "C:/escape", "file:stream"])(
  "rejects Windows-unsafe archive path %s",
  (name) => {
    const zip = new AdmZip()
    zip.addFile("SKILL.md", Buffer.from(markdown))
    zip.addFile(name, Buffer.from("payload"))
    expect(() => inspectSkillImport(zip.toBuffer(), "skill.zip")).toThrow("Windows")
  }
)

it("rejects aliases, links, file-directory collisions and expanded archives before installation", () => {
  for (const scenario of ["case", "link", "directory", "large", "zero-size"]) {
    const zip = new AdmZip()
    zip.addFile("SKILL.md", Buffer.from(markdown))
    if (scenario === "case") zip.addFile("skill.MD", Buffer.from(markdown))
    if (scenario === "link") {
      zip.addFile("link", Buffer.from("outside"))
      zip.getEntry("link")!.attr = (0xa1ff << 16) >>> 0
    }
    if (scenario === "directory") {
      zip.addFile("file", Buffer.from("x"))
      zip.addFile("file/child", Buffer.from("x"))
    }
    if (scenario === "large") zip.addFile("large", Buffer.alloc(4 * 1024 * 1024 + 1))
    if (scenario === "zero-size") zip.addFile("payload", Buffer.alloc(1024 * 1024, 42))
    const bytes = zip.toBuffer()
    if (scenario === "zero-size") {
      // Forge the declared uncompressed length; a zero header used to disable
      // AdmZip's inflater limit. The preview must reject rather than allocate it.
      for (let offset = 0; offset < bytes.length - 46; offset++)
        if (
          bytes.readUInt32LE(offset) === 0x02014b50 &&
          bytes.toString("utf8", offset + 46, offset + 53) === "payload"
        )
          bytes.writeUInt32LE(0, offset + 24)
    }
    expect(() => inspectSkillImport(bytes, "skill.zip"), scenario).toThrow()
  }
})

it("downloads an exact snapshot across a bounded redirect without cookies or authorization", async () => {
  const observed: Record<string, unknown>[] = []
  const base = await server((request, response) => {
    observed.push(request.headers)
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/SKILL.md" })
      response.end()
    } else {
      response.setHeader("content-type", "text/markdown")
      response.end(markdown)
    }
  })
  const result = await readSkillImportSource(
    { kind: "url", url: `${base}/redirect` },
    new AbortController().signal
  )
  expect(result.success).toBe(true)
  if (!result.success) throw new Error(result.error)
  expect(Buffer.from(result.file.buffer).toString()).toBe(markdown)
  expect(observed).toHaveLength(2)
  expect(observed.every((headers) => !headers.cookie && !headers.authorization)).toBe(true)
})

it("rejects unsafe protocols, embedded credentials, HTML and oversized chunked bodies", async () => {
  const base = await server((request, response) => {
    if (request.url === "/html") {
      response.setHeader("content-type", "text/html")
      response.end("<html>Login</html>")
    } else {
      response.setHeader("transfer-encoding", "chunked")
      response.end(Buffer.alloc(SKILL_IMPORT_MAX_BYTES + 1))
    }
  })
  for (const url of [
    "file:///private/secret",
    "http://user:password@localhost/",
    `${base}/html`,
    `${base}/large`
  ])
    expect(
      await readSkillImportSource({ kind: "url", url }, new AbortController().signal)
    ).toMatchObject({ success: false })
  const downgrade = await readSkillImportSource(
    { kind: "url", url: "https://example.invalid/skill" },
    new AbortController().signal,
    {
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "http://example.invalid/skill" } })
    }
  )
  expect(downgrade).toMatchObject({ success: false, error: expect.stringContaining("降级") })
})

it("cancels or times out after headers when a download body stops responding", async () => {
  let received!: () => void
  let headers = new Promise<void>((resolve) => {
    received = resolve
  })
  const base = await server((_request, response) => {
    response.writeHead(200, { "content-type": "text/markdown" })
    response.write("---\nname: partial\n")
    received()
  })
  const controller = new AbortController()
  const pending = readSkillImportSource({ kind: "url", url: base }, controller.signal)
  await headers
  controller.abort()
  expect(await pending).toMatchObject({ success: false, error: "已取消读取技能" })
  headers = new Promise<void>((resolve) => {
    received = resolve
  })
  const timed = readSkillImportSource({ kind: "url", url: base }, new AbortController().signal, {
    timeoutMs: 100
  })
  await headers
  expect(await timed).toMatchObject({ success: false, error: expect.stringContaining("超时") })
})
