/** Real renderer -> preload -> main -> bundled document and image Workers. Build first. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
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
env.NO_PROXY = "localhost,127.0.0.1"
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
    const previewRequest = { threadId, workspacePath: profile, imageId: ids[0] }
    const imagePreview = await window.api.file.readDraftChatImage(previewRequest)
    const wrongWorkspace = await window.api.file.readDraftChatImage({ ...previewRequest, workspacePath: null })
      .then(() => false, () => true)
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "pin", messageId, ids })
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "pin", messageId, ids })
    await window.api.file.updateImageOwners({ threadId, workspacePath: profile, action: "unpin", messageId })
    await window.api.file.updateImageOwners({ ...previewRequest, action: "discard", ids: [ids[0]] })
    const removedPreview = await window.api.file.readDraftChatImage(previewRequest)
      .then(() => false, () => true)
    return { threadId, document, image, word, sheet, web, atFile, atHtml, bad, status, stale,
      imagePreview, wrongWorkspace, removedPreview }
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
  assert.match(result.imagePreview, /^data:image\/webp;base64,/)
  assert.equal(result.wrongWorkspace, true)
  assert.equal(result.removedPreview, true)
  console.log("HTML, DOCX, XLSX, PNG, workspace mentions, image validation and queue ownership passed through Electron IPC")
  await verifyBotAttachmentPreviews(page, bytes, docx)
  await verifySentImageHistory(page, profile, bytes)
  await verifyImageSendPresentation(app, page, result.threadId, profile, bytes)
  await verifyBotDraftComposerPreview(page, bytes)
  console.log("Attachment previews, image send, cancellation, reload, stop and workspace recovery passed")

} finally {
  try {
    await app?.close()
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function verifyBotAttachmentPreviews(page, bytes, docx) {
  const { direct, embedded, groupImages, wrongBot, wrongGroup, neighboringCounts, nextUpload } = await page.evaluate(async ({ png, document }) => {
    const api = window.api.bots
    const settings = { instructions: "Fixture for local image previews", color: "#168bea",
      modelRef: null, memoryMode: "disabled" }
    const bot = await api.create({ ...settings, name: "Attachment Preview Bot" })
    const other = await api.create({ ...settings, name: "Other Attachment Bot" })
    const group = await api.saveGroup({ name: "Attachment Preview Group", memberIds: [bot.id, other.id] })
    const upload = (fileName, data) => ({ fileName, bytes: Uint8Array.from(data).buffer })
    const [photo, word] = await api.attachFileBytes(bot.id,
      [upload("bot-photo.png", png), upload("bot-document.docx", document)], 500)
    const [groupPhoto] = await api.attachFileBytes(bot.id, [upload("group-photo.png", png)], 500, group.id)
    const neighbors = await api.attachFileBytes(bot.id, ["one.png", "two.png", "three.png"]
      .map(name => upload(name, png)), 500)
    // A scroll can mount several message galleries while the user attaches their next image.
    const previews = [photo, ...neighbors, word, word].map(file =>
      api.readAttachmentImages(bot.id, file.botInputId))
    const [visible, next] = await Promise.all([Promise.all(previews),
      api.attachFileBytes(bot.id, [upload("next.png", png)], 500)])
    return {
      direct: visible[0],
      neighboringCounts: visible.map(images => images.length),
      nextUpload: next[0]?.filename,
      embedded: await api.readAttachmentImages(bot.id, word.botInputId),
      groupImages: await api.readAttachmentImages(other.id, groupPhoto.botInputId, group.id),
      wrongBot: await api.readAttachmentImages(other.id, photo.botInputId).then(() => false, () => true),
      wrongGroup: await api.readAttachmentImages(bot.id, groupPhoto.botInputId).then(() => false, () => true)
    }
  }, { png: Array.from(bytes), document: Array.from(docx) })
  assert.deepEqual(neighboringCounts, [1, 1, 1, 1, 2, 2])
  assert.equal(nextUpload, "next.png")
  assert.deepEqual(direct.map(image => image.filename), ["bot-photo.png"])
  assert.equal(embedded.length, 2)
  assert.deepEqual(groupImages.map(image => image.filename), ["group-photo.png"])
  for (const image of [...direct, ...embedded, ...groupImages]) {
    assert.match(image.url, /^data:image\/webp;base64,/)
    const { width, height } = await sharp(Buffer.from(image.url.split(",")[1], "base64")).metadata()
    assert.deepEqual([width, height], [12, 6])
  }
  assert.equal(wrongBot, true)
  assert.equal(wrongGroup, true)
}

// Keep routing and persistence real while making the model response deterministic and local.
async function verifySentImageHistory(page, workspacePath, bytes) {
  const answer = "Image history fixture completed."
  let receivedImage = false
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const part of request) raw += part
      const body = JSON.parse(raw)
      receivedImage ||= body.messages?.some(message => Array.isArray(message.content) &&
        message.content.some(part => part.type === "image_url" &&
          part.image_url.url.startsWith("data:image/webp;base64,")))
      const base = { id: "inline-image-reply", created: 1, model: body.model }
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const [delta, finish] of [[{ role: "assistant", content: answer }, null], [{}, "stop"]]) {
          response.write("data: " + JSON.stringify({ ...base, object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n")
        }
        response.end("data: [DONE]\n\n")
      } else {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ ...base, object: "chat.completion", choices: [
          { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }
        ] }))
      }
    } catch {
      response.writeHead(400).end()
    }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const title = "Sent image history"
    const threadId = await page.evaluate(async ({ baseUrl, workspacePath, title }) => {
      const api = window.api
      await api.models.setCustomConfig({ id: "image-history", name: "Image history", baseUrl,
        model: "image-history", apiKey: "fixture", maxTokens: 64000, maxOutputTokens: 2048,
        inputModalities: ["text", "image"] })
      const model = "custom:image-history"
      await api.models.setDefault(model)
      await api.routing.setMode("pinned")
      const thread = await api.threads.create({ title, workspacePath, model, agentMode: "normal" })
      await api.workspace.set(thread.thread_id, workspacePath)
      return thread.thread_id
    }, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, workspacePath, title })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
    const filename = "sent-history.png"
    const question = "Describe the uploaded color swatch."
    const composer = chat.locator("textarea.composer-textarea")
    await submitImage(page, composer, composer, filename, bytes, question)
    const message = chat.locator('[data-chat-message-row][data-message-role="user"]').filter({ hasText: question })
    await verifyInlineImage(page, message, filename)
    await chat.getByText(answer, { exact: true }).first().waitFor({ timeout: 90_000 })
    assert.ok(receivedImage, "the submitted image also reached the model")
    await page.reload({ waitUntil: "domcontentloaded" })
    const saved = await page.evaluate(id => window.api.threads.get(id), threadId)
    await page.getByText(saved.title, { exact: true }).first().click()
    await verifyInlineImage(page, message, filename)

    const docQuestion = "Compare the figures in this report."
    const docName = "illustrated-report.docx"
    const other = await sharp({ create: { width: 5, height: 8, channels: 3, background: "red" } }).png().toBuffer()
    await submitImage(page, composer, composer, docName, visualDocx([bytes, other]), docQuestion,
      docName + " · 图 2")
    const docMessage = chat.locator('[data-chat-message-row][data-message-role="user"]').filter({ hasText: docQuestion })
    await verifyInlineImage(page, docMessage, docName + " · 图 1")
    await verifyInlineImage(page, docMessage, docName + " · 图 2", [5, 8])

    const botName = "Attachment Preview Bot"
    await chat.getByText(answer, { exact: true }).nth(1).waitFor({ timeout: 90_000 })
    await verifyLinkedImageHistory(page, { chat, threadId, workspacePath, botName, bytes, message, filename })

    const openBot = async () => {
      await page.getByText("Bots", { exact: true }).first().click()
      await page.getByText(botName, { exact: true }).first().click()
    }
    await openBot()
    const bot = page.locator('[data-chat-surface="bot"]')
    const botComposer = bot.locator('textarea, [role="textbox"][contenteditable="true"]').last()
    const botFilename = "bot-history.png"
    const botQuestion = "Inspect the Bot color swatch."
    await submitImage(page, bot.getByRole("button", { name: "添加文件", exact: true }),
      botComposer, botFilename, bytes, botQuestion)
    const botMessage = bot.locator('[data-chat-message-row][data-message-role="user"]').filter({ hasText: botQuestion })
    await verifyInlineImage(page, botMessage, botFilename)
    await page.reload({ waitUntil: "domcontentloaded" })
    await openBot()
    await verifyInlineImage(page, botMessage, botFilename)
    const groupName = "Attachment Preview Group"
    const openGroup = () => page.getByRole("button", { name: groupName, exact: true }).click()
    await openGroup()
    const groupComposer = page.locator(".bot-group-composer")
    const groupFilename = "group-history.png"
    const groupQuestion = "Describe the group color swatch."
    await submitImage(page, groupComposer, groupComposer.getByRole("textbox"),
      groupFilename, bytes, groupQuestion)
    const groupMessage = page.locator('.bot-group-message[data-user="true"]').filter({ hasText: groupQuestion })
    await verifyInlineImage(page, groupMessage, groupFilename)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Bots", { exact: true }).first().click()
    await openGroup()
    await verifyInlineImage(page, groupMessage, groupFilename)
    console.log("Sent image pixels, lightbox and restored history passed in ordinary, private Bot and group chats")
  } catch (error) {
    console.error("Image history fixture UI at failure:", (await page.locator("body").innerText()).slice(-3600))
    const history = await page.evaluate(async () => {
      const chat = document.querySelector("[data-chat-thread-id]")
      const threadId = chat?.getAttribute("data-chat-thread-id")
      if (!threadId) return { threadId }
      const thread = await window.api.threads.get(threadId)
      const token = thread.metadata?.cmb_thread_incarnation
      const incarnation = token ? "uuid:" + token : "legacy:" + new Date(thread.created_at).getTime()
      const rows = [...chat.querySelectorAll('[data-chat-message-row][data-message-role="user"]')].map(row => ({
        id: row.getAttribute("data-chat-message-id"), galleries: row.querySelectorAll('[data-testid="message-image-gallery"]').length,
        images: row.querySelectorAll('button[aria-label^="预览图片 "] img').length
      }))
      const { messages } = await window.api.threads.getMessagesPage(threadId)
      const receipts = await Promise.all(messages.filter(m => m.role === "user").slice(-8).map(async m => ({
        id: m.id, hasChatImages: m.hasChatImages ?? false, hasBotInputImages: m.botHistoryInputOrigin?.hasInputImages ?? false,
        imageCount: await window.api.file.readMessageChatImages({
          threadId, messageId: m.id, workspacePath: thread.metadata?.workspacePath ?? null, incarnation
        }).then(images => images.length, error => String(error))
      })))
      return { threadId, rows, receipts }
    }).catch(cause => String(cause))
    console.error("Image history fixture rows and receipts:", JSON.stringify(history))
    throw error
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function verifyLinkedImageHistory(page, { chat, threadId, workspacePath, botName, bytes, message, filename }) {
  const waitForIdle = () => page.waitForFunction(async id =>
    (await window.api.threads.get(id)).status === "idle", threadId, { timeout: 90_000 })
  const link = page.getByRole("button", { name: "关联为 Bot 任务", exact: true })
  const more = page.getByRole("button", { name: "更多任务操作", exact: true })
  const associate = async title => {
    await waitForIdle()
    await link.click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox").selectOption({ label: botName })
    await dialog.getByLabel("任务名称").fill(title)
    await dialog.getByLabel("任务目标").fill("Keep the figures visible throughout this conversation.")
    await dialog.getByRole("button", { name: "关联此会话", exact: true }).click()
    await more.waitFor()
  }
  await associate("Image history work")
  await verifyInlineImage(page, message, filename)

  await page.getByRole("button", { name: "获取控制权", exact: true }).click()
  const editor = chat.locator('[data-bot-owner-composer]').locator('textarea, [role="textbox"][contenteditable="true"]').last()
  const workFilename = "linked-work-figure.png"
  const workQuestion = "Inspect the linked work figure."
  await submitImage(page, chat.getByRole("button", { name: "添加文件", exact: true }),
    editor, workFilename, bytes, workQuestion)
  const workMessage = chat.locator('[data-chat-message-row][data-message-role="user"]').filter({ hasText: workQuestion })
  await verifyInlineImage(page, workMessage, workFilename)
  await page.waitForFunction(async id => {
    const snapshot = await window.api.bots.snapshot()
    const tasks = snapshot.tasks.filter(task => task.threadId === id)
    return tasks.length > 0 && tasks.every(task => !["queued", "running", "waiting_user"].includes(task.state))
  }, threadId, { timeout: 90_000 })
  await waitForIdle()
  await more.click()
  await page.getByRole("button", { name: "解除任务关联", exact: true }).click()
  await page.getByRole("button", { name: "确认解除", exact: true }).click()
  await link.waitFor()
  await verifyInlineImage(page, workMessage, workFilename)
  await page.reload({ waitUntil: "domcontentloaded" })
  const saved = await page.evaluate(id => window.api.threads.get(id), threadId)
  await page.getByText(saved.title, { exact: true }).first().click()
  await verifyInlineImage(page, message, filename)
  await verifyInlineImage(page, workMessage, workFilename)
  const ids = await Promise.all([message, workMessage].map(row => row.getAttribute("data-chat-message-id")))
  assert.ok(ids.every(Boolean))
  const foreignResults = await page.evaluate(async ({ ids, workspacePath }) => {
    const api = window.api
    const other = await api.threads.create({ title: "Unrelated image history", workspacePath })
    const token = other.metadata?.cmb_thread_incarnation
    const incarnation = token ? "uuid:" + token : "legacy:" + new Date(other.created_at).getTime()
    return Promise.all(ids.map(async messageId => {
      const images = await api.file.readMessageChatImages({
        threadId: other.thread_id, messageId, workspacePath, incarnation
      })
      return images.length
    }))
  }, { ids, workspacePath })
  assert.deepEqual(foreignResults, [0, 0], "another thread cannot read these messages' image receipts")
  await associate("New work on the same conversation")
  await verifyInlineImage(page, message, filename)
  await verifyInlineImage(page, workMessage, workFilename)
  console.log("Ordinary and work images survived link, unlink, reload and reassociation with cross-thread isolation")
}

async function submitImage(page, drop, composer, filename, bytes, question, previewName = filename) {
  const dataTransfer = await page.evaluateHandle(({ filename, bytes }) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(bytes)], filename))
    return data
  }, { filename, bytes: Array.from(bytes) })
  try {
    await drop.dispatchEvent("drop", { dataTransfer })
    await page.getByRole("button", { name: `预览图片 ${previewName}`, exact: true }).waitFor()
    await composer.fill(question)
    await composer.press("Enter")
  } finally {
    await dataTransfer.dispose()
  }
}

async function verifyInlineImage(page, message, filename, dimensions = [12, 6]) {
  const preview = message.getByRole("button", { name: `预览图片 ${filename}`, exact: true })
  const thumbnail = preview.locator("img")
  // Use the wheel to bring a historical gallery into view and trigger its lazy image read.
  const scroll = await message.getByTestId("message-image-gallery").evaluate(gallery => {
    const viewport = gallery.closest("[data-radix-scroll-area-viewport]") ??
      gallery.closest("[data-virtuoso-scroller]")
    if (!viewport) return null
    const target = gallery.getBoundingClientRect()
    const box = viewport.getBoundingClientRect()
    if (target.bottom > box.top && target.top < box.bottom) return null
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      delta: target.top + target.height / 2 - box.top - box.height / 2
    }
  })
  if (scroll) {
    await page.mouse.move(scroll.x, scroll.y)
    await page.mouse.wheel(0, scroll.delta)
  }
  const pixels = await thumbnail.evaluate(async img => {
    await img.decode()
    return [img.naturalWidth, img.naturalHeight]
  }, undefined, { timeout: 60_000 })
  assert.deepEqual(pixels, dimensions)
  await preview.click()
  const dialog = page.getByRole("dialog", { name: filename })
  await dialog.getByRole("img", { name: filename }).evaluate(img => img.decode())
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
}

async function verifyBotDraftComposerPreview(page, bytes) {
  await page.getByText("Bots", { exact: true }).first().click()
  await page.getByText("Attachment Preview Bot", { exact: true }).first().click()
  const chat = page.locator('[data-chat-surface="bot"]')
  const attach = chat.getByRole("button", { name: "添加文件", exact: true })
  await attach.waitFor()
  const filename = "bot-composer-preview.png"
  const dataTransfer = await page.evaluateHandle(({ filename, bytes }) => {
    const data = new DataTransfer()
    data.items.add(new File([Uint8Array.from(bytes)], filename))
    return data
  }, { filename, bytes: Array.from(bytes) })
  try {
    await attach.dispatchEvent("drop", { dataTransfer })
    const preview = chat.getByRole("button", { name: `预览图片 ${filename}` })
    await preview.click()
    const dialog = page.getByRole("dialog", { name: filename })
    await dialog.getByRole("img", { name: filename }).evaluate(node => node.decode())
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await chat.getByRole("button", { name: `移除附件 ${filename}` }).click()
    await preview.waitFor({ state: "detached" })
  } finally {
    await dataTransfer.dispose()
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
  const dropFile = async (name, content) => {
    const dataTransfer = await page.evaluateHandle(({ name, content }) => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(content)], name))
      return data
    }, { name, content: Array.from(content) })
    try {
      await composer.dispatchEvent("drop", { dataTransfer })
      await chat.getByText(name, { exact: true }).waitFor()
    } finally {
      await dataTransfer.dispose()
    }
  }
  const sendImage = async (name, question) => {
    await dropFile(name, bytes)
    await composer.fill(question)
    await composer.press("Enter")
  }

  await dropFile("draft-preview.png", bytes)
  const preview = chat.getByRole("button", { name: "预览图片 draft-preview.png" })
  await preview.click()
  const dialog = page.getByRole("dialog", { name: "draft-preview.png" })
  const image = dialog.getByRole("img", { name: "draft-preview.png" })
  assert.equal(await image.evaluate(async node => { await node.decode(); return node.naturalWidth }), 12)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  await chat.getByRole("button", { name: "移除附件 draft-preview.png" }).click()
  await preview.waitFor({ state: "detached" })

  await dropFile("draft-preview.docx", visualDocx([bytes, bytes]))
  await chat.getByRole("button", { name: /预览图片.*draft-preview\.docx/ }).nth(1).waitFor()
  await chat.getByRole("button", { name: "移除附件 draft-preview.docx" }).click()

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
