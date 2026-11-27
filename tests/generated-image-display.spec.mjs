/** Exercise the real Electron renderer with an in-memory media IPC fixture. */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron } from "playwright"

const dir = await mkdtemp(join(tmpdir(), "generated-image-renderer-"))
let app
try {
  const fixture = await build({
    stdin: {
      contents: `
        import React from "react"
        import { createRoot } from "react-dom/client"
        import { GeneratedImagePreview, GeneratedImageToolResult } from "./src/renderer/src/components/chat/GeneratedImagePreview"
        import { ChatImageRegenerationContext } from "./src/renderer/src/components/chat/chat-presentation-context"

        const root = createRoot(document.querySelector("main"))
        const image = { kind:"generated-image", actionId:"f0b10276-f235-4d55-91f5-2de13e725a32",
          width:96, height:64, mimeType:"image/png", userMessageId:"user" }
        window.calls = []
        window.api = { generatedImages:{
          lookup:async source => {
            calls.push(["lookup",source])
            if (window.fail === "lookup") {
              window.fail = undefined
              throw Error("生图结果待确认，请勿重复提交")
            }
            return image
          },
          read:async (source,variant) => {
            calls.push([variant,source])
            if (window.fail === variant) { window.fail = undefined; throw Error("unavailable") }
            const group = "groupId" in source
            const canvas = document.createElement("canvas")
            canvas.width = variant === "original" ? 96 : 24
            canvas.height = canvas.width * 2 / 3
            const ctx = canvas.getContext("2d")
            ctx.fillStyle = group ? "blue" : "red"
            ctx.fillRect(0,0,canvas.width,canvas.height)
            return canvas.toDataURL("image/png")
          },
          save:async source => { calls.push(["save",source]); return true }
        }}
        window.show = kind => {
          if (kind === "group") {
            root.render(<GeneratedImagePreview image={image} source={{
              groupId:"group",messageId:"published",fileIndex:0,actionId:image.actionId
            }} />)
          } else {
            root.render(<ChatImageRegenerationContext.Provider value={id =>
              id === "user" ? () => calls.push(["draft",id]) : undefined}>
              <GeneratedImageToolResult key={kind} threadId="thread" messageId={"assistant-" + kind}
                callId="tool" running={kind === "running"}
                result={kind === "success" ? {content:JSON.stringify(image)} : undefined} />
            </ChatImageRegenerationContext.Provider>)
          }
        }
        window.show("running")
      `,
      loader: "tsx",
      resolveDir: process.cwd()
    },
    alias: { "@": resolve("src/renderer/src") },
    bundle: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: join(dir, "fixture.js")
  })
  assert.equal(fixture.errors.length, 0)
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><meta charset="utf-8"><main></main><script src="fixture.js"></script>'
  )
  const entry = join(dir, "app.cjs")
  await writeFile(
    entry,
    `
    const { app, BrowserWindow } = require("electron")
    app.whenReady().then(() => {
      const win = new BrowserWindow({ show: false })
      win.loadFile(require("node:path").join(__dirname,"index.html"))
    })
  `
  )
  const electron = createRequire(import.meta.url)("electron")
  app = await _electron.launch({
    executablePath:
      process.platform === "win32" ? resolve("tests/support/electron-launcher.cmd") : electron,
    args: [entry, "--disable-gpu", "--user-data-dir=" + join(dir, "profile")],
    env: { ...process.env, CMB_E2E_ELECTRON_BIN: electron, CMB_E2E_DISABLE_GPU: "1" }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  const preview = page.getByRole("button", { name: "预览图片 生成图片.png" })
  const count = (kind) => page.evaluate((k) => window.calls.filter(([op]) => op === k).length, kind)
  const pixel = async (locator) =>
    locator.evaluate(async (image) => {
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext("2d")
      ctx.drawImage(image, 0, 0)
      return [image.naturalWidth, image.naturalHeight, ...ctx.getImageData(0, 0, 1, 1).data]
    })
  await page.getByText("正在生成图片…").waitFor()
  assert.deepEqual(await page.evaluate(() => window.calls), [])
  await page.evaluate(() => {
    window.fail = "thumbnail"
    window.show("success")
  })
  await page.getByRole("button", { name: "图片加载失败，点击重试" }).click()
  assert.deepEqual(await pixel(preview.locator("img")), [24, 16, 255, 0, 0, 255])
  assert.equal(await count("original"), 0)
  await page.evaluate(() => {
    window.fail = "original"
  })
  await preview.click()
  await page.getByRole("button", { name: "原图加载失败，点击重试" }).click()
  const dialog = page.getByRole("dialog")
  assert.deepEqual(
    await pixel(dialog.getByRole("img", { name: "生成图片.png" })),
    [96, 64, 255, 0, 0, 255]
  )
  await dialog.getByRole("button", { name: "保存原图" }).click()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "重新生成" }).click()
  assert.equal(await count("draft"), 1)
  assert.equal(await count("save"), 1)
  await page.evaluate(() => {
    window.fail = "lookup"
    window.show("recovered")
  })
  await page.getByRole("status").filter({ hasText: "生图结果待确认，请勿重复提交" }).waitFor()
  await page.getByRole("button", { name: "重新读取生成结果" }).click()
  await preview.waitFor()
  assert.equal(await count("lookup"), 2)
  await page.evaluate(() => window.show("group"))
  await page.waitForFunction(() =>
    window.calls.some(([op, source]) => op === "thumbnail" && source.groupId === "group")
  )
  assert.deepEqual(await pixel(preview.locator("img")), [24, 16, 0, 0, 255, 255])
  const source = await page.evaluate(() => window.calls.at(-1)[1])
  assert.deepEqual(source, {
    groupId: "group",
    messageId: "published",
    fileIndex: 0,
    actionId: "f0b10276-f235-4d55-91f5-2de13e725a32"
  })
  console.log(
    "Generated image thumbnails, original pixels, retry, save, history and group receipts passed"
  )
} finally {
  await app?.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}
