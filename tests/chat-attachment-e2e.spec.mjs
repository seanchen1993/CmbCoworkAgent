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
  await writeFile(join(profile, "script.html"), "<script>document.body.append('scripted report')</script>")
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
    const atHtml = await window.api.file.attachWorkspaceImage({
      threadId, workspacePath: profile, filePath: "script.html"
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
    return { threadId, document, image, word, sheet, web, atFile, atHtml, bad, status, stale }
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
  assert.match(result.atHtml.content, /scripted report/)
  assert.equal(result.bad.success, false)
  assert.equal(result.status, "missing")
  assert.equal(result.stale, true, "a recreated thread must reject an old image submission")
  console.log("HTML, DOCX, XLSX, PNG, workspace mentions, image validation and queue ownership passed through Electron IPC")
  await verifyImageSendPresentation(app, page, result.threadId, profile, bytes)
  console.log("Image send, browser option, cancellation, reload, stop and stale workspace recovery passed through the composer")

} finally {
  try {
    await app?.close()
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function verifyImageSendPresentation(app, page, threadId, workspacePath, bytes) {
  await page.evaluate(async ({ threadId, workspacePath }) => {
    await window.api.models.setCustomConfig({
      id: "attachment-queue-fixture", name: "Attachment queue fixture",
      baseUrl: "http://127.0.0.1:9/v1", model: "fixture", apiKey: "fixture",
      maxTokens: 64000, maxOutputTokens: 2048, inputModalities: ["text", "image"]
    })
    await window.api.models.setDefault("custom:attachment-queue-fixture")
    await window.api.routing.setMode("pinned")
    await window.api.workspace.set(threadId, workspacePath)
    await window.api.threads.patchMetadata(threadId, { set: { model: "custom:attachment-queue-fixture" } })
  }, { threadId, workspacePath })
  await app.evaluate(({ ipcMain }) => {
    const statusChannel = "workspace:chatImageSubmissionStatus"
    const originalStatus = ipcMain._invokeHandlers.get(statusChannel)
    const fixture = globalThis.attachmentQueueFixture = { hold: true, runs: [], cancelled: false }
    ipcMain.removeHandler(statusChannel)
    ipcMain.handle(statusChannel, async (event, request) => {
      if (fixture.hold) {
        fixture.hold = false
        await new Promise(resolve => { fixture.releaseStatus = resolve })
      }
      if (fixture.runs.some(run => run.request.userMessageId === request.messageId))
        return fixture.cancelled ? "cancelled" : "running"
      return originalStatus(event, request)
    })
    const originalCancel = ipcMain._invokeHandlers.get("agent:cancel")
    ipcMain.removeHandler("agent:cancel")
    ipcMain.handle("agent:cancel", (event, request) => {
      if (!fixture.runs.some(run => run.request.threadId === request.threadId)) return originalCancel(event, request)
      fixture.cancelled = true
    })
    ipcMain.removeAllListeners("agent:invoke")
    ipcMain.on("agent:invoke", (event, request) => {
      fixture.runs.push({ request, sender: event.sender,
        channel: "agent:stream:" + request.threadId + ":request:" + encodeURIComponent(request.streamRequestId) })
    })
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Attachment smoke", { exact: true }).first().click()
  const chat = page.locator('[data-chat-thread-id="' + threadId + '"]')
  const composer = chat.locator("textarea.composer-textarea")
  const queue = chat.locator("[data-chat-queued-list]")
  const sending = chat.getByText("正在发送图片消息…", { exact: true })
  const waitForFixture = async predicate => {
    for (let tries = 0; tries < 200; tries++) {
      if (await app.evaluate(predicate)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error("Timed out waiting for attachment submission fixture")
  }
  const sendImage = async (name, question) => {
    const dataTransfer = await page.evaluateHandle(({ name, png }) => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(png)], name, { type: "image/png" }))
      return data
    }, { name, png: Array.from(bytes) })
    try {
      await composer.dispatchEvent("drop", { dataTransfer })
      await chat.getByText(name, { exact: true }).waitFor()
      await composer.fill(question)
      await composer.press("Enter")
    } finally {
      await dataTransfer.dispose()
    }
  }

  await sendImage("cancel-before-handoff.png", "Cancel this visual turn")
  await waitForFixture(() => Boolean(globalThis.attachmentQueueFixture.releaseStatus))
  await sending.waitFor()
  assert.equal(await queue.count(), 0, "an idle first image has no queue badge")
  await chat.getByRole("button", { name: "取消发送" }).click()
  await sending.waitFor({ state: "hidden" })
  await app.evaluate(() => globalThis.attachmentQueueFixture.releaseStatus())

  await composer.fill("/browser")
  await chat.getByRole("option", { name: /内置浏览器/ }).click()
  await chat.getByRole("button", { name: "移除内置浏览器" }).waitFor()
  await sendImage("send-now.png", "First accepted image")
  await waitForFixture(() => globalThis.attachmentQueueFixture.runs.length > 0)
  const accepted = await app.evaluate((_electron, workspace) => {
    const { runs } = globalThis.attachmentQueueFixture
    const run = runs[0]
    run.sender.send(run.channel, { type: "custom", data: { type: "user_prompt_accepted", workspacePath: workspace } })
    return {
      total: runs.length, id: run.request.userMessageId,
      files: run.request.chatImages, message: run.request.message
    }
  }, workspacePath)
  assert.equal(accepted.total, 1)
  assert.deepEqual(accepted.files.map(file => file.filename), ["send-now.png"])
  assert.match(accepted.message, /使用内置浏览器/)
  await chat.locator('[data-chat-message-id="' + accepted.id + '"]').waitFor()
  await sending.waitFor({ state: "hidden" })
  assert.equal(await queue.count(), 0, "an acknowledged image is only shown in the transcript")
  await chat.getByRole("button", { name: "停止生成" }).waitFor()
  await sendImage("wait-behind-turn.png", "Remove this waiting image")
  await queue.getByText(/Remove this waiting image/).waitFor()
  await queue.getByRole("button", { name: "删除", exact: true }).click()
  await queue.waitFor({ state: "hidden" })
  // Lose the renderer stream, then hold the first receipt read after reload.
  await app.evaluate(() => {
    const fixture = globalThis.attachmentQueueFixture
    fixture.hold = true
    fixture.releaseStatus = undefined
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Attachment smoke", { exact: true }).first().click()
  await waitForFixture(() => Boolean(globalThis.attachmentQueueFixture.releaseStatus))
  await composer.fill("Wait until the existing image settles")
  await composer.press("Enter")
  await queue.getByText(/Wait until the existing image settles/).waitFor()
  assert.equal(await app.evaluate(() => globalThis.attachmentQueueFixture.runs.length), 1,
    "ordinary chat cannot preempt an in-flight image during receipt recovery")
  await app.evaluate(() => globalThis.attachmentQueueFixture.releaseStatus())
  await chat.getByText("图片消息正在处理…", { exact: true }).waitFor()
  await queue.getByRole("button", { name: "删除", exact: true }).click()
  await queue.waitFor({ state: "hidden" })
  await chat.getByRole("button", { name: "停止生成" }).click()
  await waitForFixture(() => globalThis.attachmentQueueFixture.cancelled)
  await chat.getByText("图片消息正在处理…", { exact: true }).waitFor({ state: "hidden" })
  assert.equal(await queue.count(), 0, "a confirmed stop clears the outbox")
  const total = await app.evaluate(() => globalThis.attachmentQueueFixture.runs.length)
  assert.equal(total, 1, "cancelling the preparation or deleting the waiting image never invokes the model")

  const nextWorkspace = join(workspacePath, "alternate-workspace")
  await mkdir(nextWorkspace)
  await page.evaluate(async ({ threadId, workspacePath, nextWorkspace, png }) => {
    const thread = await window.api.threads.get(threadId)
    const token = thread.metadata?.cmb_thread_incarnation
    const incarnation = token ? "uuid:" + token : "legacy:" + new Date(thread.created_at).getTime()
    const id = crypto.randomUUID()
    const staged = await window.api.file.parseBytes({
      threadId, workspacePath, fileName: "old-workspace.png", bytes: Uint8Array.from(png).buffer
    })
    if (!staged.attachment?.image) throw new Error(staged.error || "Image staging failed")
    const image = { id: staged.attachment.image.id, filename: "old-workspace.png", slot: 0 }
    await window.api.file.updateImageOwners({
      action: "pin", threadId, workspacePath, incarnation, messageId: id, ids: [image.id]
    })
    const common = { created_at: new Date(), updated_at: new Date(), modelId: "custom:attachment-queue-fixture" }
    localStorage.setItem("cmbcowork:message-queue:" + threadId, JSON.stringify([
      { ...common, id, text: "Old workspace image", chatImages: [image],
        attachmentModelBlocks: '\n<attachment filename="old-workspace.png" media="image" slot="0" />',
        imageDelivery: { workspacePath, incarnation, source: "fixture" } },
      { ...common, id: crypto.randomUUID(), text: "Successor in new workspace" }
    ]))
    await window.api.workspace.set(threadId, nextWorkspace)
  }, { threadId, workspacePath, nextWorkspace, png: Array.from(bytes) })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Attachment smoke", { exact: true }).first().click()
  await chat.getByText(/图片消息属于原工作区或原会话/).waitFor()
  await queue.getByText(/Old workspace image/).locator("..").getByRole("button", { name: "删除", exact: true }).click()
  await waitForFixture(() => globalThis.attachmentQueueFixture.runs.length === 2)
  assert.match(await app.evaluate(() => globalThis.attachmentQueueFixture.runs[1].request.message),
    /Successor in new workspace/)
}
