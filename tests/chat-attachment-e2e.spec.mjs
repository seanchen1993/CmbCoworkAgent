/** Real renderer -> preload -> main -> bundled document and image Workers. Build first. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron } from "playwright"
import sharp from "sharp"

import { visualDocx, visualXlsx } from "./support/document-attachment-fixtures.mjs"
const root = resolve(import.meta.dirname, "..")
const profile = await mkdtemp(join(tmpdir(), "chat-attachment-e2e-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*)$/i.test(key)))
for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_CACHE_HOME", "CMB_COWORK_AGENT_HOME", "TEMP"]) {
  env[key] = join(profile, key)
  await mkdir(env[key])
}
env.HOME = env.USERPROFILE
env.TMP = env.TEMP
env.CMB_E2E_ELECTRON_BIN = createRequire(import.meta.url)("electron")
env.CMB_E2E_DISABLE_GPU = "1"
env.HTTPS_PROXY = env.HTTP_PROXY = "http://127.0.0.1:9"
const packaged = process.env.CHAT_ATTACHMENT_PACKAGED_EXECUTABLE
let app
try {
  app = await _electron.launch({
    executablePath: packaged || (process.platform === "win32"
      ? join(root, "tests/support/electron-launcher.cmd") : env.CMB_E2E_ELECTRON_BIN),
    args: [...(packaged ? [] : [join(root, "out/main/index.js")]),
      "--disable-gpu", "--proxy-server=http://127.0.0.1:9", "--user-data-dir=" + join(profile, "electron")],
    cwd: root, env, timeout: 60_000
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.api?.file?.parseBytes))
  const bytes = await sharp({ create: { width: 12, height: 6, channels: 3, background: "blue" } }).png().toBuffer()
  const docx = visualDocx([bytes, bytes])
  await writeFile(join(profile, "word.docx"), docx)
  const result = await page.evaluate(async ({ profile, png, docx, xlsx, inline }) => {
    const thread = await window.api.threads.create({ title: "Attachment smoke", workspacePath: profile })
    const threadId = thread.thread_id ?? thread.id
    const html = new TextEncoder().encode("<h1>Report</h1><script>hidden()</script><table><tr><td>Q2</td><td>317</td></tr></table>")
    const document = await window.api.file.parseBytes({ threadId, workspacePath: profile, fileName: "report.html", bytes: html.buffer })
    const image = await window.api.file.parseBytes({ threadId, workspacePath: profile, fileName: "chart.png", bytes: Uint8Array.from(png).buffer })
    const upload = (fileName, bytes) => window.api.file.parseBytes({
      threadId, workspacePath: profile, fileName, bytes: Uint8Array.from(bytes).buffer
    })
    const word = await upload("word.docx", docx)
    const sheet = await upload("table.xlsx", xlsx)
    const web = await upload("inline.html", new TextEncoder().encode(inline))
    const atFile = await window.api.file.attachWorkspaceImage({
      threadId, workspacePath: profile, filePath: "word.docx"
    })
    const bad = await upload("bad.html", new TextEncoder().encode('<img src="data:image/png;base64,AAAA">'))
    const token = thread.metadata?.cmb_thread_incarnation
    const incarnation = token ? "uuid:" + token : "legacy:" + new Date(thread.created_at).getTime()
    const messageId = crypto.randomUUID()
    const request = { threadId, workspacePath: profile, incarnation, messageId }
    const status = await window.api.file.chatImageSubmissionStatus(request)
    const stale = await window.api.file.chatImageSubmissionStatus({ ...request, incarnation: "uuid:old" })
      .then(() => false, () => true)
    const ids = [image.attachment.image.id, ...word.attachment.embeddedImages.map(image => image.id)]
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "pin", messageId, ids })
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "pin", messageId, ids })
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "unpin", messageId })
    return { document, image, word, sheet, web, atFile, bad, status, stale }
  }, {
    profile, png: Array.from(bytes), docx: Array.from(docx), xlsx: Array.from(visualXlsx(bytes)),
    inline: '<p>Inline test</p><img src="data:image/png;base64,' + bytes.toString("base64") +
      '"><img src="https://example.invalid/no-fetch.png">'
  })
  assert.equal(result.document.success, true, result.document.error)
  assert.match(result.document.attachment.content, /Q2\s+317/)
  assert.doesNotMatch(result.document.attachment.content, /hidden/)
  assert.equal(result.image.success, true, result.image.error)
  assert.equal(result.image.attachment.image.width, 12)
  assert.equal(result.image.attachment.image.height, 6)
  assert.equal(result.image.attachment.content, "")
  assert.equal(result.word.success, true, result.word.error)
  assert.match(result.word.attachment.content, /Row 1【图 1】[\s\S]*Row 2【图 2】/)
  assert.deepEqual(result.word.attachment.embeddedImages.map(image => [image.width, image.height]), [[12, 6], [12, 6]])
  assert.equal("documentImages" in result.word.attachment, false)
  assert.match(result.sheet.attachment.content, /C5 附近 【图 1】/)
  assert.match(result.sheet.attachment.visualNotice, /原生图表/)
  assert.equal(result.sheet.attachment.embeddedImages.length, 1)
  assert.equal(result.web.attachment.embeddedImages.length, 1)
  assert.match(result.web.attachment.visualNotice, /外部/)
  assert.equal(result.atFile.embeddedImages.length, 2)
  assert.equal(result.bad.success, false)
  assert.equal(result.status, "missing")
  assert.equal(result.stale, true, "a recreated thread must reject an old image submission")
  console.log("HTML, DOCX, XLSX, PNG, workspace mentions, image validation and queue ownership passed through Electron IPC")
} finally {
  try {
    await app?.close()
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
