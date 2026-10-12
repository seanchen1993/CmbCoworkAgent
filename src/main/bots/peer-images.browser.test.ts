import { viteUrlAssetsFixture } from "../../../tests/fixtures/vite-url-assets"
/** Actual React + SQLite + authenticated RPC + bounded native image parser.
 * Only delivery of a completed preview ACK is controlled at the Electron seam. */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser } from "playwright"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotDocumentReader } from "./document-reader"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { serializeBotFailure } from "./error-diagnostic"
import { avatarImage } from "./image-fixtures"
import { sendReviewedBotPeer } from "./peer-approval"
import type { BotRuntimeRequest } from "./host"

const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"
let browser: Browser, bundle: string, styles: string
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src")
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  styles = css.build(scanner.scan())
  const highlight = await build({
    entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const output = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotPeerImages,BotPeerExchangeHeader}from'./src/renderer/src/components/bots/BotPeerImages';import{BotApprovalContent}from'./src/renderer/src/components/bots/BotApprovalContent';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};applyThemePreference('codex-dark');const create=URL.createObjectURL,revoke=URL.revokeObjectURL;window.blobs={created:0,revoked:0};URL.createObjectURL=function(b){window.blobs.created++;return create.call(URL,b)};URL.revokeObjectURL=function(u){window.blobs.revoked++;return revoke.call(URL,u)};function Fixture(){const[value,setValue]=useState(null);window.fixtureShow=setValue;return <main className="mx-auto max-w-xl p-6 bg-background text-foreground"><h1>Bot 协作</h1><input aria-label="保留草稿" defaultValue="尚未发送的草稿"/>{value?.approval?<BotApprovalContent prompt={value.approval}/>:value&&<section>{value.peerDelivery&&<BotPeerExchangeHeader delivery={value.peerDelivery}/>}<p>{value.text}</p><BotPeerImages key={value.conversationId} images={value.peerImages} conversationId={value.conversationId}/></section>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    outfile: "peer-ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"fixture"'
    },
    plugins: [
      viteUrlAssetsFixture(),
      {
        name: "original-highlight-worker",
        setup(b) {
          b.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight",
            namespace: "worker"
          }))
          b.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker {constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url)}}`
          }))
        }
      }
    ]
  })
  bundle = output.outputFiles.find((file) => file.path.endsWith(".js"))!.text
  // Match the application: include every stylesheet imported by the real components.
  styles +=
    "\n" +
    output.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n")
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 20_000)
afterAll(async () => {
  await browser?.close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-ui-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, "host"))
  const lock = BotHostLock.acquire(join(directory, "host"))!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const files = new BotArtifacts(join(directory, "objects"), store, reader)
  cleanup.push(() => files.close())
  const host = new BotHost(store, undefined, 2, undefined, files, undefined, undefined, reader)
  host.bindOwnership(lock)
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\peer-ui-${token.slice(0, 16)}`
        : join(directory, "s.sock")
  const server = new BotRpcServer(host, token)
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  cleanup.push(() => client.close())
  const a = store.createBot({ nonce: "a", name: "设计 Bot" }),
    b = store.createBot({ nonce: "b", name: "复核 Bot" })
  const image = await files.publish(
    {
      id: "image",
      conversationId: a.conversationId,
      runId: null,
      name: "blue.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage("#1084fe", 1200), "base64")
  )
  store.send({
    nonce: "task",
    conversationId: a.conversationId,
    text: "验证图片",
    attachments: [image.id]
  })
  const { run, lease } = store.claim("fixture")!
  const request: BotRuntimeRequest = {
    store,
    run,
    lease,
    bot: a.bot,
    messages: store.messagesForRun(run.id),
    signal: new AbortController().signal
  }
  let approvalPrompt = ""
  await sendReviewedBotPeer(
    request,
    {
      callId: "image",
      recipient: b.bot.id,
      text: "复核图表",
      images: [{ artifact_id: image.id, alt: "图表蓝色区域" }]
    },
    () => {
      store.assertDispatch(lease)
    },
    async (id, action, operation, commit) => {
      approvalPrompt = JSON.stringify(action)
      const ask = store.requestInteraction(lease, {
        kind: "approval",
        prompt: approvalPrompt,
        action
      })
      store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
      const apply = () =>
        store.approvedToolOnce(lease, { id, action, approvalId: ask.id }, operation)
      return commit ? commit(apply) : apply()
    },
    files,
    reader
  )
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
  cleanup.push(() => page.close())
  page.setDefaultTimeout(2500)
  const errors: string[] = [],
    calls: { method: string; input: unknown }[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let hold = false,
    held: (() => void) | undefined
  cleanup.push(() => {
    held?.()
  })
  await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
    calls.push({ method, input })
    try {
      const result = await Reflect.apply(client.call, client, [
        method,
        ...(input === undefined ? [] : [input])
      ])
      if (hold && method === "filePreview") {
        hold = false
        await new Promise<void>((done) => {
          held = done
        })
      }
      return result
    } catch (error) {
      return { botFailure: serializeBotFailure(error) }
    }
  })
  await page.route("http://127.0.0.1:39482/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script>`
    })
  )
  await page.goto("http://127.0.0.1:39482/")
  const show = async (value: unknown) =>
    page.evaluate((input) => Reflect.get(window, "fixtureShow")(input), value)
  return {
    directory,
    page,
    a,
    b,
    client,
    errors,
    calls,
    show,
    approvalPrompt,
    multi: async () => {
      const green = await files.publish(
        {
          id: "green",
          conversationId: a.conversationId,
          runId: run.id,
          name: "green.png",
          mime: "image/png"
        },
        Buffer.from(await avatarImage("#20a060", 1200), "base64"),
        lease
      )
      await sendReviewedBotPeer(
        request,
        {
          callId: "two-images",
          recipient: b.bot.id,
          text: "复核两张图表",
          images: [
            { artifact_id: image.id, alt: "图表蓝色区域" },
            { artifact_id: green.id, alt: "图表绿色区域" }
          ]
        },
        () => store.assertDispatch(lease),
        async (id, action, operation, commit) => {
          const ask = store.requestInteraction(lease, {
            kind: "approval",
            prompt: JSON.stringify(action),
            action
          })
          store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
          const apply = () =>
            store.approvedToolOnce(lease, { id, action, approvalId: ask.id }, operation)
          return commit ? commit(apply) : apply()
        },
        files,
        reader
      )
      return (await client.call("messages", { conversationId: b.conversationId })).find(
        (message) =>
          message.peerDelivery?.direction === "incoming" && message.peerImages?.length === 2
      )!
    },
    hold: () => {
      hold = true
    },
    held: () => Boolean(held),
    release: () => {
      held?.()
      held = undefined
    }
  }
}
it.skipIf(!enabled)(
  "shows exact two-way image exchanges and the approved image in original Dialog previews",
  async () => {
    const f = await fixture()
    await f.show({ approval: f.approvalPrompt })
    await f.page.getByText("同时发送 1 张图片；接收方可查看这些附件。").waitFor()
    const image = f.page.getByRole("img", { name: "图表蓝色区域", exact: true })
    await image.waitFor()
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
    await f.page.getByRole("button", { name: "查看图片 图表蓝色区域" }).click()
    await f.page.getByRole("dialog").waitFor()
    await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
    const dialog = f.page.getByRole("dialog"),
      canvas = dialog.locator('[data-image-presentation="lightbox"]'),
      fullImage = dialog.getByRole("img", { name: "blue.png", exact: true })
    await fullImage.waitFor()
    expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 960, height: 720 })
    expect(await dialog.getByRole("button", { name: "保存原文件" }).innerText()).toBe("")
    expect(await dialog.getByText("图表蓝色区域", { exact: true }).last().isVisible()).toBe(true)
    expect(await dialog.getByText("Image", { exact: true }).count()).toBe(0)
    await fullImage.click()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("250")
    await fullImage.click()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("500")
    const bounds = await canvas.boundingBox()
    expect(bounds).not.toBeNull()
    await f.page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await f.page.mouse.down()
    await f.page.mouse.move(
      bounds!.x + bounds!.width / 2 + 24,
      bounds!.y + bounds!.height / 2 + 30,
      { steps: 3 }
    )
    await f.page.mouse.up()
    expect(await canvas.getAttribute("data-image-scale")).toBe("500")
    expect(await fullImage.getAttribute("style")).not.toContain("translate(0px, 0px)")
    await f.page.emulateMedia({ reducedMotion: "reduce" })
    await f.page.setViewportSize({ width: 600, height: 400 })
    await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 600, height: 400 })
    await canvas.focus()
    await f.page.keyboard.press("0")
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("100")
    await fullImage.click()
    await fullImage.click()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("500")
    const frame = (await canvas.boundingBox())!,
      focal = { x: frame.x + frame.width / 2 + 40, y: frame.y + frame.height / 2 }
    const position = async () =>
      canvas.evaluate((node) => {
        const image = node.querySelector("img")!,
          matrix = new DOMMatrix(getComputedStyle(image).transform),
          frame = node.getBoundingClientRect(),
          bounds = image.getBoundingClientRect()
        return {
          scale: matrix.a,
          x: matrix.e,
          y: matrix.f,
          layoutWidth: image.offsetWidth,
          layoutHeight: image.offsetHeight,
          width: frame.width,
          height: frame.height,
          overlapWidth: Math.max(
            0,
            Math.min(frame.right, bounds.right) - Math.max(frame.left, bounds.left)
          ),
          overlapHeight: Math.max(
            0,
            Math.min(frame.bottom, bounds.bottom) - Math.max(frame.top, bounds.top)
          )
        }
      })
    const beforeWheel = await position(),
      contentAtFocal = (40 - beforeWheel.x) / beforeWheel.scale
    await f.page.mouse.move(focal.x, focal.y)
    await f.page.mouse.wheel(0, 100)
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-image-scale")))
      .toBeLessThan(500)
    await expect
      .poll(async () =>
        Math.abs((40 - (await position()).x) / (await position()).scale - contentAtFocal)
      )
      .toBeLessThan(0.5)
    const beforeArrow = (await position()).x
    await f.page.keyboard.press("ArrowRight")
    await expect.poll(async () => (await position()).x).toBeLessThan(beforeArrow)
    await f.page.keyboard.press("0")
    await fullImage.click()
    await fullImage.click()
    await f.page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await f.page.mouse.down()
    await f.page.mouse.move(620, 460, { steps: 3 })
    await f.page.mouse.up()
    // The original zoom-out regression left this large dragged offset outside
    // the frame. Every zoom must clamp it, not just the eventual reset key.
    await f.page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await f.page.mouse.wheel(0, Math.log(4) / 0.0015)
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-image-scale")))
      .toBeCloseTo(125, 0)
    const shrunk = await position()
    expect(Math.abs(shrunk.x)).toBeLessThanOrEqual(
      Math.max(0, (shrunk.layoutWidth * shrunk.scale - shrunk.width) / 2) + 0.5
    )
    expect(Math.abs(shrunk.y)).toBeLessThanOrEqual(
      Math.max(0, (shrunk.layoutHeight * shrunk.scale - shrunk.height) / 2) + 0.5
    )
    expect(shrunk.overlapWidth).toBeGreaterThan(0)
    expect(shrunk.overlapHeight).toBeGreaterThan(0)
    await canvas.focus()
    for (let count = 0; count < 11; count++) await f.page.keyboard.press("-")
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("100")
    await fullImage.click()
    await f.page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await canvas.evaluate((node) =>
      node.addEventListener(
        "pointerdown",
        (event) => Reflect.set(window, "mediaPointerId", (event as PointerEvent).pointerId),
        { once: true }
      )
    )
    await f.page.mouse.down()
    // Keep a drag update and reset in the same browser turn, before RAF can run.
    await fullImage.evaluate((node) => {
      const frame = node.closest('[data-image-presentation="lightbox"]')!,
        bounds = frame.getBoundingClientRect()
      node.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: Reflect.get(window, "mediaPointerId"),
          isPrimary: true,
          bubbles: true,
          clientX: bounds.x + bounds.width / 2 + 60,
          clientY: bounds.y + bounds.height / 2 + 30
        })
      )
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }))
    })
    await f.page.mouse.up()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("100")
    await expect.poll(() => fullImage.getAttribute("style")).toContain("translate(0px, 0px)")
    await f.page.setViewportSize({ width: 960, height: 720 })
    await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 960, height: 720 })
    await f.page.keyboard.press("Escape")
    const approvalTrigger = f.page.getByRole("button", { name: "查看图片 图表蓝色区域" })
    await expect
      .poll(() => approvalTrigger.evaluate((node) => document.activeElement === node))
      .toBe(true)
    await approvalTrigger.click()
    await fullImage.waitFor()
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await expect
      .poll(() => approvalTrigger.evaluate((node) => document.activeElement === node))
      .toBe(true)
    expect(await f.page.getByRole("textbox", { name: "保留草稿" }).inputValue()).toBe(
      "尚未发送的草稿"
    )
    const source = (await f.client.call("messages", { conversationId: f.a.conversationId })).find(
      (message) => message.peerDelivery?.direction === "outgoing"
    )!
    await f.show(source)
    await f.page.getByText("发送给 复核 Bot · 协作记录").waitFor()
    await image.waitFor()
    const target = (await f.client.call("messages", { conversationId: f.b.conversationId })).find(
      (message) => message.peerDelivery?.direction === "incoming"
    )!
    await f.show(target)
    await f.page.getByText("收到来自 设计 Bot · 协作记录").waitFor()
    await image.waitFor()
    const incomingTrigger = f.page.getByRole("button", { name: "查看图片 图表蓝色区域" })
    await incomingTrigger.click()
    await fullImage.waitFor()
    expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 960, height: 720 })
    expect(await dialog.getByRole("alert").count()).toBe(0)
    if (process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR) {
      await mkdir(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, { recursive: true })
      await f.page.screenshot({
        path: join(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, "peer-media-dark.png")
      })
      await f.page.emulateMedia({ reducedMotion: "reduce" })
      await f.page.setViewportSize({ width: 420, height: 720 })
      await f.page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-light"))
      await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 420, height: 720 })
      await f.page.screenshot({
        path: join(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, "peer-media-light-narrow-reduced.png")
      })
    }
    await f.page.keyboard.press("Escape")
    await expect
      .poll(() => incomingTrigger.evaluate((node) => document.activeElement === node))
      .toBe(true)
    expect(await f.page.getByRole("textbox", { name: "保留草稿" }).inputValue()).toBe(
      "尚未发送的草稿"
    )
    expect(
      f.calls
        .filter((call) => call.method === "filePreview")
        .some(
          (call) => (call.input as { conversationId: string }).conversationId === f.b.conversationId
        )
    ).toBe(true)
    if (process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR) {
      await mkdir(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, { recursive: true })
      await f.page.screenshot({
        path: join(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, "peer-image-incoming-dark.png")
      })
    }
    expect(f.errors).toEqual([])
    const multi = await f.multi()
    await f.show(multi)
    const first = f.page.getByRole("button", { name: "查看图片 图表蓝色区域" })
    await first.click()
    await fullImage.waitFor()
    await f.page.evaluate(() =>
      Reflect.set(window, "mediaDialog", document.querySelector('[role="dialog"]'))
    )
    // Radix initially focuses a toolbar button: keyboard shortcuts belong to
    // this local Dialog, without stealing focus or listening on document.
    await f.page.keyboard.press("+")
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("140")
    await f.page.keyboard.press("0")
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("100")
    await f.page.keyboard.press("ArrowRight")
    const green = dialog.getByRole("img", { name: "green.png", exact: true })
    await green.waitFor()
    expect(await canvas.getAttribute("data-image-scale")).toBe("100")
    expect(await dialog.evaluate((node) => node === Reflect.get(window, "mediaDialog"))).toBe(true)
    expect(
      await dialog
        .getByRole("button", { name: "切换图片 2/2 图表绿色区域" })
        .getAttribute("aria-current")
    ).toBe("true")
    await green.click()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("250")
    await f.page.keyboard.press("ArrowLeft")
    expect(await green.count()).toBe(1)
    await f.page.keyboard.press("0")
    await dialog.getByRole("button", { name: "切换图片 1/2 图表蓝色区域" }).click()
    await fullImage.waitFor()
    expect(await canvas.getAttribute("data-image-scale")).toBe("100")
    await f.page.keyboard.press("ArrowLeft")
    await green.waitFor()
    await f.page.keyboard.press("Escape")
    await expect.poll(() => first.evaluate((node) => document.activeElement === node)).toBe(true)
    expect(await f.page.getByRole("textbox", { name: "保留草稿" }).inputValue()).toBe(
      "尚未发送的草稿"
    )
    await f.show(null)
    await expect
      .poll(async () => {
        const blobs = await f.page.evaluate(() => Reflect.get(window, "blobs"))
        return blobs.created === blobs.revoked
      })
      .toBe(true)
    expect(f.errors).toEqual([])
  },
  20_000
)
it.skipIf(!enabled)(
  "cancels hidden preview admission and ignores a late authenticated ACK after the conversation changes",
  async () => {
    const f = await fixture()
    const source = (await f.client.call("messages", { conversationId: f.a.conversationId })).find(
      (message) => message.peerDelivery?.direction === "outgoing"
    )!
    f.hold()
    await f.show(source)
    await expect.poll(f.held).toBe(true)
    await f.show(null)
    await expect
      .poll(() => f.calls.filter((call) => call.method === "cancelFilePreview").length)
      .toBe(1)
    f.release()
    expect(await f.page.evaluate(() => Reflect.get(window, "blobs"))).toEqual({
      created: 0,
      revoked: 0
    })
    const target = (await f.client.call("messages", { conversationId: f.b.conversationId })).find(
      (message) => message.peerDelivery?.direction === "incoming"
    )!
    await f.show(target)
    await f.page.getByRole("img", { name: "图表蓝色区域", exact: true }).waitFor()
    await f.show(null)
    await expect
      .poll(() => f.page.evaluate(() => Reflect.get(window, "blobs")))
      .toEqual({ created: 1, revoked: 1 })
    await f.show(target)
    const thumbnail = f.page.getByRole("img", { name: "图表蓝色区域", exact: true })
    await thumbnail.waitFor()
    await expect
      .poll(() => thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0)
    f.hold()
    await f.page.getByRole("button", { name: "查看图片 图表蓝色区域" }).click()
    await expect.poll(f.held).toBe(true)
    const beforeClose = await f.page.evaluate(() => Reflect.get(window, "blobs"))
    await f.show(null)
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    f.release()
    await expect
      .poll(() => f.page.evaluate(() => Reflect.get(window, "blobs")))
      .toEqual({
        created: beforeClose.created,
        revoked: beforeClose.created
      })
    expect(f.errors).toEqual([])
  },
  20_000
)
