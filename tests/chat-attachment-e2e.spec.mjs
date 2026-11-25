/** Real renderer -> preload -> main -> bundled document and image Workers. Build first. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron } from "playwright"
import sharp from "sharp"

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
  const result = await page.evaluate(async ({ profile, png }) => {
    const thread = await window.api.threads.create({ title: "Attachment smoke", workspacePath: profile })
    const threadId = thread.thread_id ?? thread.id
    const html = new TextEncoder().encode("<h1>Report</h1><script>hidden()</script><table><tr><td>Q2</td><td>317</td></tr></table>")
    const document = await window.api.file.parseBytes({ threadId, workspacePath: profile, fileName: "report.html", bytes: html.buffer })
    const image = await window.api.file.parseBytes({ threadId, workspacePath: profile, fileName: "chart.png", bytes: Uint8Array.from(png).buffer })
    return { document, image }
  }, { profile, png: Array.from(bytes) })
  assert.equal(result.document.success, true, result.document.error)
  assert.match(result.document.attachment.content, /Q2\s+317/)
  assert.doesNotMatch(result.document.attachment.content, /hidden/)
  assert.equal(result.image.success, true, result.image.error)
  assert.equal(result.image.attachment.image.width, 12)
  assert.equal(result.image.attachment.image.height, 6)
  assert.equal(result.image.attachment.content, "")
  console.log("HTML extraction and PNG normalization passed through Electron IPC")
} finally {
  try {
    await app?.close()
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
