/** Real Electron, user-facing send controls, a local chat model and a separate image HTTP service. */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect } from "playwright/test"
import sharp from "sharp"
import { launchAttachmentElectron } from "./support/launch-attachment-electron.mjs"

const examples = [
  ["普通会话中的蓝色夜空", [13, 51, 198]],
  ["请画一张绿色森林的海报", [29, 164, 41]],
  ["私聊中的红色花朵", [192, 28, 53]],
  ["群聊中的金色月亮", [215, 176, 22]]
]
const images = new Map()
for (const [prompt, [r, g, b]] of examples) {
  images.set(
    prompt,
    await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r, g, b } }
    })
      .png()
      .toBuffer()
  )
}
const submitted = []
let selectedNaturalTool = false
const naturalPrompt = examples[1][0]
const server = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.url === "/v1/images/generations") {
      assert.equal(request.headers.authorization, "Bearer image-fixture")
      assert.equal(body.model, "pixel-fixture")
      assert.equal(body.n, 1)
      submitted.push(body.prompt)
      assert.ok(
        images.has(body.prompt),
        "only the originating user's requested prompt is dispatched"
      )
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "img-" + submitted.length
      })
      response.end(
        JSON.stringify({ data: [{ b64_json: images.get(body.prompt).toString("base64") }] })
      )
      return
    }
    assert.equal(request.url, "/v1/chat/completions")
    const messages = body.messages
    const user = messages.findLastIndex((message) => message.role === "user")
    const offered = body.tools?.some((tool) => tool.function?.name === "generate_image")
    const choose =
      offered &&
      user >= 0 &&
      JSON.stringify(messages[user].content).includes(naturalPrompt) &&
      !messages.slice(user + 1).some((message) => message.role === "tool")
    selectedNaturalTool ||= Boolean(choose)
    const toolCall = {
      id: "call_natural_image",
      type: "function",
      function: {
        name: "generate_image",
        arguments: JSON.stringify({ prompt: "model rewrite should not leave the host" })
      }
    }
    const message = choose
      ? { role: "assistant", tool_calls: [toolCall] }
      : { role: "assistant", content: "Fixture completed." }
    const finish = choose ? "tool_calls" : "stop"
    const base = { id: "chat-fixture", created: 1, model: body.model }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      const delta = choose
        ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
        : message
      for (const [part, reason] of [
        [delta, null],
        [{}, finish]
      ]) {
        response.write(
          "data: " +
            JSON.stringify({
              ...base,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: part, finish_reason: reason }]
            }) +
            "\n\n"
        )
      }
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: finish }]
        })
      )
    }
  } catch (error) {
    console.error("Local generation fixture:", error.message)
    response.writeHead(400).end()
  }
})

const profile = await mkdtemp(join(tmpdir(), "chat-generation-e2e-"))
let app, page
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1"
  app = await launchAttachmentElectron(profile, {
    CMB_IMAGE_GENERATION_ENDPOINT: baseUrl + "/images/generations",
    CMB_IMAGE_GENERATION_MODEL: "pixel-fixture",
    CMB_IMAGE_GENERATION_API_KEY: "image-fixture"
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(90_000)
  await page.waitForFunction(() => Boolean(window.api?.generatedImages?.availability))
  assert.equal(
    await page.evaluate(async () => (await window.api.generatedImages.availability()).available),
    true
  )
  const setup = await page.evaluate(
    async ({ baseUrl, profile }) => {
      const api = window.api
      await api.models.setCustomConfig({
        id: "gen-test",
        name: "Generation chat model",
        baseUrl,
        model: "chat-fixture",
        apiKey: "chat-fixture",
        maxTokens: 64000,
        maxOutputTokens: 2048
      })
      const model = "custom:gen-test"
      await api.models.setDefault(model)
      await api.routing.setMode("pinned")
      const threads = []
      for (const title of ["Explicit generation", "Natural generation"]) {
        const thread = await api.threads.create({
          title,
          workspacePath: profile,
          model,
          agentMode: "normal"
        })
        await api.workspace.set(thread.thread_id, profile)
        threads.push(thread.thread_id)
      }
      const settings = {
        instructions: "Reply to local image generation tests.",
        color: "#168bea",
        modelRef: model,
        memoryMode: "disabled"
      }
      const bot = await api.bots.create({ ...settings, name: "Image Workshop" })
      const other = await api.bots.create({ ...settings, name: "Other Workshop" })
      const members = { memberIds: [bot.id, other.id] }
      const group = await api.bots.saveGroup({ ...members, name: "Image Studio Group" })
      const another = await api.bots.saveGroup({ ...members, name: "Other Studio Group" })
      return { threads, bot, other, group, another }
    },
    { baseUrl, profile }
  )

  async function openThread(id) {
    const title = await page.evaluate(async (id) => (await window.api.threads.get(id)).title, id)
    await page.getByText(title, { exact: true }).first().click()
    return page.locator('[data-chat-thread-id="' + id + '"]')
  }
  async function send(composer, text) {
    const form = composer.locator("xpath=ancestor::form[1]")
    const button = form
      .locator('button[aria-label="发送消息"],button.bot-group-send,button[type="submit"]')
      .last()
    // Restoring a private draft can briefly replace or disable the contenteditable node.
    // Only prepare the draft again. The send action must happen exactly once.
    await expect(async () => {
      await composer.fill(text, { timeout: 2_000 })
      const draft = await composer.evaluate((editor) => editor.value ?? editor.innerText)
      expect(draft).toBe(text)
      await expect(button).toBeEnabled({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    await button.click()
    console.log("Submitted through the composer:", text)
  }
  async function verifyPixels(surface, index, exportFile = false) {
    const button = surface.getByRole("button", { name: "预览图片 生成图片.png", exact: true })
    const thumbnail = button.locator("img")
    const dimensions = await thumbnail.evaluate(async (img) => {
      await img.decode()
      return [img.naturalWidth, img.naturalHeight]
    })
    assert.deepEqual(dimensions, [512, 256])
    await button.click()
    const dialog = page.getByRole("dialog")
    const src = await dialog.getByRole("img", { name: "生成图片.png" }).evaluate(async (img) => {
      await img.decode()
      return img.src
    })
    const [prompt, color] = examples[index]
    assert.match(src, /^data:image\/png;base64,/)
    const original = Buffer.from(src.split(",")[1], "base64")
    assert.ok(
      original.equals(images.get(prompt)),
      "lightbox opens the exact original for this reply"
    )
    const { info, data } = await sharp(original).raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height, ...data.subarray(0, 3)], [600, 300, ...color])
    if (exportFile) {
      const target = join(profile, "exported.png")
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, target)
      await dialog.getByRole("button", { name: "保存原图" }).click()
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('[role="dialog"] button')].some(
            (button) => button.textContent.includes("保存原图") && button.disabled
          )
      )
      assert.ok(
        (await readFile(target)).equals(original),
        "save exports the original with no second POST"
      )
    }
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  for (const [index, id] of setup.threads.entries()) {
    const chat = await openThread(id)
    await send(
      chat.locator("textarea.composer-textarea"),
      (index === 0 ? "/生成图片 " : "") + examples[index][0]
    )
    const assistant = chat.locator('[data-chat-message-row][data-message-role="assistant"]')
    await verifyPixels(assistant, index, index === 0)
    await page.reload({ waitUntil: "domcontentloaded" })
    await openThread(id)
    await verifyPixels(assistant, index)
    assert.deepEqual(
      submitted,
      examples.slice(0, index + 1).map(([prompt]) => prompt)
    )
  }
  assert.equal(
    selectedNaturalTool,
    true,
    "ordinary natural-language generation traverses model tool calls"
  )
  console.log("Ordinary explicit and natural requests, saved pixels and restored replies passed")

  const openBot = async () => {
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText(setup.bot.name, { exact: true }).first().click()
  }
  await openBot()
  const privateChat = page.locator('[data-chat-surface="bot"]')
  const privateRows = privateChat.locator('[data-chat-message-row][data-message-role="assistant"]')
  await send(
    privateChat.locator('textarea, [contenteditable="true"][role="textbox"]').last(),
    "/生成图片 " + examples[2][0]
  )
  await verifyPixels(privateRows, 2)
  await page.reload({ waitUntil: "domcontentloaded" })
  await openBot()
  await verifyPixels(privateRows, 2)
  console.log("Private Bot generated and restored its own reply image")

  const openGroup = () => page.getByRole("button", { name: setup.group.name, exact: true }).click()
  await openGroup()
  await send(
    page.locator(".bot-group-composer").getByRole("textbox"),
    "/生成图片 " + examples[3][0]
  )
  const groupRows = page.locator('.bot-group-message[data-user="false"]')
  await verifyPixels(groupRows, 3)
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Bots", { exact: true }).first().click()
  await openGroup()
  await verifyPixels(groupRows, 3)
  const receipts = await page.evaluate(async ({ group, another }) => {
    const messages = await window.api.bots.groupMessages(group.id)
    const other = await window.api.bots.groupMessages(another.id)
    const published = messages.filter((message) =>
      message.files?.some((file) => file.generatedImage)
    )
    const first = published[0]
    const fileIndex = first?.files?.findIndex((file) => file.generatedImage)
    const image = first?.files?.[fileIndex]?.generatedImage
    const file = first?.files?.[fileIndex]
    const genericExportDenied =
      file &&
      (await window.api.bots.exportGroupFile(group.id, file.filePath).then(
        (delivered) => !delivered,
        () => true
      ))
    const wrongRecipient =
      image &&
      (await window.api.generatedImages
        .read(
          {
            groupId: another.id,
            messageId: first.id,
            fileIndex,
            actionId: image.actionId
          },
          "original"
        )
        .then(
          () => false,
          () => true
        ))
    return {
      published: published.map((message) => ({
        group: message.groupId,
        bot: message.authorBotId,
        images: message.files.filter((file) => file.generatedImage).length
      })),
      others: other.filter((message) => message.files?.some((file) => file.generatedImage)).length,
      wrongRecipient,
      actionId: image?.actionId,
      genericExportDenied,
      attachmentPath: file?.attachmentPath
    }
  }, setup)
  assert.equal(receipts.published.length, 1)
  assert.ok([setup.bot.id, setup.other.id].includes(receipts.published[0].bot))
  assert.equal(receipts.published[0].group, setup.group.id)
  assert.equal(receipts.published[0].images, 1)
  assert.equal(receipts.others, 0)
  assert.equal(receipts.wrongRecipient, true)
  assert.equal(receipts.attachmentPath, undefined)
  assert.equal(receipts.genericExportDenied, true)
  assert.match(receipts.actionId, /^[a-f0-9-]{36}$/)
  // Remove the producer from this isolated profile. A reopened group must rely on its own receipt.
  const dataRoot = join(profile, "CMB_COWORK_AGENT_HOME")
  const database = new DatabaseSync(join(dataRoot, "cmbcoworkagent.sqlite"))
  try {
    database.exec("PRAGMA busy_timeout=5000")
    const grant = database
      .prepare(
        "SELECT thread_id FROM generated_image_grants WHERE action_id=? AND audience='group'"
      )
      .get(receipts.actionId)
    assert.ok(grant?.thread_id)
    assert.equal(
      database.prepare("DELETE FROM threads WHERE thread_id=?").run(grant.thread_id).changes,
      1
    )
  } finally {
    database.close()
  }
  for (const ext of [".png", ".webp"]) {
    await rm(join(dataRoot, "generated-images", receipts.actionId + ext), { force: true })
  }
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Bots", { exact: true }).first().click()
  await openGroup()
  await verifyPixels(groupRows, 3)
  assert.deepEqual(
    submitted,
    examples.map(([prompt]) => prompt)
  )
  console.log(
    "Group pixels survived producer deletion; generic export and cross-group access were denied with one POST per request"
  )
} catch (error) {
  if (page)
    console.error(
      "Local image generation UI at failure:",
      (await page.locator("body").innerText()).slice(-3800)
    )
  if (page)
    console.error(
      "Visible composer state:",
      await page
        .locator("textarea:visible")
        .evaluateAll((nodes) =>
          nodes.map((input) => ({
            value: input.value,
            disabled: input.disabled,
            buttons: [...(input.closest("form")?.querySelectorAll("button") ?? [])].map(
              (button) => [button.getAttribute("aria-label") ?? button.title, button.disabled]
            )
          }))
        )
    )
  console.error("Submitted local fixture prompts:", submitted)
  throw error
} finally {
  try {
    await app?.close()
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
