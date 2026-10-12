import { viteUrlAssetsFixture } from "../../../tests/fixtures/vite-url-assets"
/** Full original BotWorkspace/History + real SQLite, authenticated RPC and image parser.
 * Only post-authentication bridge ACK timing and the unrelated outer app store are controlled. */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser } from "playwright"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { avatarImage } from "./image-fixtures"
import { sendReviewedBotPeer } from "./peer-approval"
import { serializeBotFailure } from "./error-diagnostic"
import type { BotRunAddress } from "../../shared/bot-run-history"

const enabled = process.env.CMB_PEER_EXCHANGE_BROWSER_TEST === "1"
let browser: Browser, bundle: string, styles: string
const cleanup: (() => void | Promise<unknown>)[] = []
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
  styles = css.build(
    new Scanner({
      sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
    }).scan()
  )
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{BotRunHistory}from'./src/renderer/src/components/bots/BotRunHistory';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{Toaster}from'sonner';import{useAppStore}from'@/lib/store';window.fixtureCoverBot=open=>useAppStore.setState({showCustomizeView:open});applyThemePreference('codex-dark');window.fixtureTheme=theme=>applyThemePreference(theme);window.fixtureViewportWrites=0;const originalSave=store.getState().saveViewportPosition;store.setState({saveViewportPosition:(...args)=>{window.fixtureViewportWrites++;return originalSave(...args)}});window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};window.fixtureSelect=id=>store.getState().select(id);window.fixtureRefresh=()=>store.getState().refresh();window.fixtureState=()=>({selected:store.getState().selected,snapshot:store.getState().snapshot,drafts:store.getState().drafts,historyFollowTail:store.getState().historyFollowTail,hasOlder:store.getState().hasOlder,loadingOlder:store.getState().loadingOlder});const create=URL.createObjectURL,revoke=URL.revokeObjectURL;window.blobs={created:0,revoked:0};URL.createObjectURL=function(b){window.blobs.created++;return create.call(URL,b)};URL.revokeObjectURL=function(u){window.blobs.revoked++;return revoke.call(URL,u)};function Fixture(){const[history,setHistory]=useState(null);window.fixtureHistory=(input)=>setHistory(input);return <main className="flex h-screen bg-background text-foreground"><BotWorkspace/>{history&&<BotRunHistory key={history.runId} address={history} close={()=>setHistory(null)}/>}<Toaster theme="dark"/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    outfile: "peer-exchange-ui.js",
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
        name: "original-outer-shell",
        setup(b) {
          b.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight",
            namespace: "worker"
          }))
          b.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker {constructor(options){const u=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(u,options);URL.revokeObjectURL(u)}}`
          }))
          b.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (a) =>
            a.path === "./store" && !a.importer.startsWith(join(renderer, "lib"))
              ? undefined
              : { path: "app-store", namespace: "outer" }
          )
          b.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread",
            namespace: "outer"
          }))
          b.onLoad({ filter: /.*/, namespace: "outer" }, (a) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              a.path === "app-store"
                ? 'import{create}from"zustand";export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));'
                : "export const useThreadStateSelector=(_id,select)=>select({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  bundle = output.outputFiles.find((f) => f.path.endsWith(".js"))!.text
  // Match the application bundle: load every imported component stylesheet.
  styles +=
    "\n" +
    output.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("\n")
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  await browser?.close()
})
async function fixture(withImage: boolean | "file" = false, longRequest = false, multiple = false) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-exchange-ui-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const lock = BotHostLock.acquire(directory)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const files = new BotArtifacts(join(directory, "objects"), store, reader)
  cleanup.push(() => files.close())
  const host = new BotHost(store, undefined, 1, undefined, files, undefined, undefined, reader)
  host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-exchange-ui-${token.slice(0, 16)}`
        : join(directory, "rpc.sock")
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
  cleanup.push(() => client.closeAndWait())
  const a = store.createBot({ nonce: "a", name: "设计 Bot" }),
    b = store.createBot({ nonce: "b", name: "复核 Bot" })
  store.send({
    nonce: "task",
    conversationId: a.conversationId,
    text: "SOURCE_PRIVATE_USER_REQUEST"
  })
  const parent = store.claim(host.id)!
  let sent
  if (withImage) {
    const image = await files.publish(
      {
        id: "chart",
        conversationId: a.conversationId,
        runId: parent.run.id,
        name: withImage === "file" ? "result.csv" : "chart.png",
        mime: withImage === "file" ? "text/csv" : "image/png"
      },
      withImage === "file"
        ? Buffer.from("record_id,amount_cny\r\nP101,1200.50\r\n")
        : Buffer.from(await avatarImage(), "base64"),
      parent.lease
    )
    const second = multiple
      ? await files.publish(
          {
            id: "second",
            conversationId: a.conversationId,
            runId: parent.run.id,
            name: "second.png",
            mime: "image/png"
          },
          Buffer.from(await avatarImage("#20a060", 1200), "base64"),
          parent.lease
        )
      : null
    sent = JSON.parse(
      await sendReviewedBotPeer(
        {
          store,
          ...parent,
          bot: a.bot,
          messages: store.messagesForRun(parent.run.id),
          signal: new AbortController().signal
        },
        {
          callId: "image",
          recipient: b.bot.id,
          text: withImage === "file" ? "独立读取交接的 result.csv" : "计算图中的 17+25",
          ...(withImage === "file"
            ? { files: [{ artifact_id: image.id }] }
            : {
                images: [
                  { artifact_id: image.id, alt: "图表蓝色区域" },
                  ...(second ? [{ artifact_id: second.id, alt: "图表绿色区域" }] : [])
                ]
              })
        },
        () => {
          store.assertDispatch(parent.lease)
        },
        async (id, action, operation, commit) => {
          const ask = store.requestInteraction(parent.lease, {
            kind: "approval",
            prompt: JSON.stringify(action),
            action
          })
          store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
          const apply = () =>
            store.approvedToolOnce(parent.lease, { id, action, approvalId: ask.id }, operation)
          return commit ? commit(apply) : apply()
        },
        files,
        reader
      )
    )
  } else
    sent = store.sendPeer(parent.lease, {
      nonce: "text",
      recipient: b.bot.id,
      text: longRequest ? "SCROLL_ANCHOR words and wrapped content\n".repeat(180) : "计算 17+25"
    })
  const child = store.claim(host.id)!
  expect(child.run.id).toBe(sent.runIds[0])
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(5000)
  cleanup.push(() => page.close())
  const calls: { method: string; input: unknown }[] = [],
    errors: string[] = []
  let hold = false,
    held: (() => void) | undefined
  cleanup.push(async () => {
    await mkdir(resolve("output/peer-exchange-debug"), { recursive: true })
    await page.screenshot({
      path: resolve(`output/peer-exchange-debug/${withImage ? "image" : "text"}.png`)
    })
    await writeFile(
      resolve(`output/peer-exchange-debug/${withImage ? "image" : "text"}.json`),
      JSON.stringify({ errors, calls, text: await page.locator("body").innerText() }, null, 2)
    )
    held?.()
  })
  page.on("pageerror", (e) => errors.push(e.message))
  await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
    calls.push({ method, input })
    try {
      const result = await Reflect.apply(client.call, client, [
        method,
        ...(input === undefined ? [] : [input])
      ])
      if (hold && method === "peerExchange") {
        hold = false
        await new Promise<void>((r) => {
          held = r
        })
      }
      return result
    } catch (e) {
      return { botFailure: serializeBotFailure(e) }
    }
  })
  await page.route("http://127.0.0.1:39486/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script>${bundle.replaceAll("</script", "<\\/script")}</script>`
    })
  )
  await page.goto("http://127.0.0.1:39486/")
  await page.getByRole("button", { name: "新建聊天", exact: true }).waitFor()
  const select = async (id: string) => {
    await page.evaluate((id) => Reflect.get(window, "fixtureSelect")(id), id)
  }
  const refresh = async () => {
    await page.evaluate(() => Reflect.get(window, "fixtureRefresh")())
  }
  const showHistory = async (address: BotRunAddress) => {
    await page.evaluate((address) => Reflect.get(window, "fixtureHistory")(address), address)
  }
  const counts = () =>
    ["bot_runs", "bot_messages", "bot_effects", "bot_receipts"].map(
      (t) => store.db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0]
    )
  return {
    directory,
    store,
    client,
    page,
    calls,
    errors,
    a,
    b,
    parent,
    child,
    sent,
    select,
    refresh,
    showHistory,
    counts,
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
  "opens a scoped CSV handoff in the original exchange and file preview without creating work",
  async () => {
    const f = await fixture("file")
    f.store.finish(f.child.lease, "succeeded", "原文件已读取")
    const before = f.counts()
    await f.select(f.a.conversationId)
    await f.page.getByRole("button", { name: "查看发给 复核 Bot 的协作" }).first().click()
    const exchange = f.page.getByRole("region", { name: "交流记录", exact: true })
    await exchange.getByRole("button", { name: "查看附件 result.csv", exact: true }).click()
    const preview = f.page.getByRole("dialog")
    await preview.getByText("P101", { exact: true }).waitFor()
    await preview.getByText("1200.50", { exact: true }).waitFor()
    await preview.getByRole("button", { name: "保存原文件", exact: true }).waitFor()
    await f.page.keyboard.press("Escape")
    await exchange.getByRole("button", { name: "查看附件 result.csv", exact: true }).waitFor()
    await f.page.keyboard.press("Escape")
    await f.select(f.b.conversationId)
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first().click()
    await exchange.getByRole("button", { name: "查看附件 result.csv", exact: true }).waitFor()
    expect(await exchange.getByText("SOURCE_PRIVATE_USER_REQUEST").count()).toBe(0)
    expect(f.errors).toEqual([])
    expect(f.counts()).toEqual(before)
  }
)
it.skipIf(!enabled)(
  "opens the same approved image dispatch from both real chat entries and returns through the original preview",
  async () => {
    const f = await fixture(true, false, true)
    f.store.finish(f.child.lease, "succeeded", "42")
    const before = f.counts()
    // Returned results retain the sender's original dispatch anchor. That relation
    // is outgoing even though this visible message was authored by the other Bot.
    const returned = f.store
      .messages(f.a.conversationId)
      .find(
        (message) =>
          message.sender === "bot" &&
          message.botId === f.b.bot.id &&
          message.runId === f.child.run.id
      )!
    expect(returned.peerExchanges).toMatchObject([
      { direction: "outgoing", anchor: { runId: f.parent.run.id } }
    ])
    await f.select(f.a.conversationId)
    const returnedEntry = f.page
      .locator(`[data-message-id="${returned.id}"]`)
      .getByRole("button", { name: "查看发给 复核 Bot 的协作" })
    await returnedEntry.getByText("发给 复核 Bot", { exact: true }).waitFor()
    expect(await returnedEntry.innerText()).not.toMatch(/发送给|收到来自/)
    await returnedEntry.click()
    const dialog = f.page.getByRole("region", { name: "交流记录", exact: true })
    await dialog.getByText("42", { exact: true }).waitFor()
    expect(await dialog.getByRole("textbox").count()).toBe(0)
    await dialog.getByRole("img", { name: "图表蓝色区域" }).waitFor()
    await expect
      .poll(() =>
        dialog
          .getByRole("img", { name: "图表蓝色区域" })
          .evaluate((e) => (e as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
    await dialog.getByRole("button", { name: "查看图片 图表蓝色区域" }).click()
    await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
    await expect
      .poll(() =>
        f.page
          .getByRole("dialog")
          .getByRole("img", { name: "chart.png" })
          .evaluate((e) => (e as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
    const media = f.page.getByRole("dialog"),
      canvas = media.locator('[data-image-presentation="lightbox"]')
    await f.page.keyboard.press("+")
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("140")
    await f.page.keyboard.press("0")
    await f.page.keyboard.press("ArrowRight")
    await media.getByRole("img", { name: "second.png", exact: true }).waitFor()
    if (process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR) {
      await mkdir(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, { recursive: true })
      await f.page.screenshot({
        path: join(process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR, "peer-filmstrip-dark.png")
      })
      await f.page.emulateMedia({ reducedMotion: "reduce" })
      await f.page.setViewportSize({ width: 420, height: 720 })
      await f.page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-light"))
      await expect.poll(() => media.boundingBox()).toEqual({ x: 0, y: 0, width: 420, height: 720 })
      await f.page.screenshot({
        path: join(
          process.env.CMB_PEER_IMAGE_SCREENSHOT_DIR,
          "peer-filmstrip-light-narrow-reduced.png"
        )
      })
      await f.page.setViewportSize({ width: 1440, height: 960 })
      await f.page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-dark"))
    }
    await media.getByRole("button", { name: "切换图片 1/2 图表蓝色区域" }).click()
    await media.getByRole("img", { name: "chart.png", exact: true }).waitFor()
    expect(await canvas.getAttribute("data-image-scale")).toBe("100")
    await f.page.keyboard.press("Escape")
    await dialog.getByRole("heading", { name: "交流记录" }).waitFor()
    await f.page.keyboard.press("Escape")
    await f.select(f.b.conversationId)
    const incomingEntry = f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first()
    await incomingEntry.getByText("来自 设计 Bot", { exact: true }).waitFor()
    expect(await incomingEntry.innerText()).not.toMatch(/发送给|收到来自/)
    await incomingEntry.click()
    await dialog.getByText("42", { exact: true }).waitFor()
    expect(await dialog.getByText("SOURCE_PRIVATE_USER_REQUEST").count()).toBe(0)
    const reads = f.calls
      .filter((c) => c.method === "peerExchange")
      .map((c) => c.input as { anchor: BotRunAddress; peerRunId: string })
    expect(
      reads.some(
        (r) => r.anchor.runId === f.parent.run.id && r.anchor.conversationId === f.a.conversationId
      )
    ).toBe(true)
    expect(
      reads.some(
        (r) => r.anchor.runId === f.child.run.id && r.anchor.conversationId === f.b.conversationId
      )
    ).toBe(true)
    expect(reads.every((r) => r.peerRunId === f.child.run.id)).toBe(true)
    expect(f.counts()).toEqual(before)
    await dialog.getByRole("img", { name: "图表蓝色区域" }).waitFor()
    await expect
      .poll(() =>
        dialog
          .getByRole("img", { name: "图表蓝色区域" })
          .evaluate((e) => (e as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
    await mkdir(resolve("output/peer-exchange"), { recursive: true })
    await f.page.screenshot({ path: resolve("output/peer-exchange/readonly-dark.png") })
    expect(f.errors).toEqual([])
  },
  20_000
)
it.skipIf(!enabled)(
  "opens legacy text from the actual handoff event, returns, and never displays a late old exchange in another chat",
  async () => {
    const f = await fixture(),
      before = f.counts()
    await f.select(f.a.conversationId)
    await f.showHistory({ conversationId: f.a.conversationId, runId: f.parent.run.id })
    await f.page.getByRole("button", { name: "查看与 复核 Bot 的交流" }).click()
    await f.page.getByRole("dialog").getByText("计算 17+25", { exact: true }).waitFor()
    await f.page.getByRole("button", { name: "返回任务记录" }).click()
    await f.page.getByRole("heading", { name: "任务记录" }).waitFor()
    await f.page.keyboard.press("Escape")
    f.hold()
    await f.select(f.b.conversationId)
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await expect.poll(f.held).toBe(true)
    await f.select(f.a.conversationId)
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect
      .poll(() => f.page.getByRole("region", { name: "交流记录", exact: true }).count())
      .toBe(0)
    f.release()
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    await f.select(f.b.conversationId)
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("等待 Bot 回复", { exact: true })
      .waitFor()
    f.store.finish(f.child.lease, "succeeded", "42")
    await f.refresh()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("42", { exact: true })
      .waitFor()
    const after = f.counts()
    // The new default asynchronous result delivery is real queued work, not a
    // mutation performed by this read-only view. Keep the old exact effect and
    // receipt counts and prove the single additional turn's complete identity.
    expect(after[0]).toBe(Number(before[0]) + 1)
    const fresh = f.store.db.exec("SELECT id FROM bot_runs WHERE bot_id=? AND parent_run_id=?", [
      f.a.bot.id,
      f.child.run.id
    ])[0].values
    expect(fresh).toHaveLength(1)
    const resultTurn = f.store.getRun(String(fresh[0][0]))
    expect(resultTurn).toMatchObject({
      botId: f.a.bot.id,
      conversationId: f.a.conversationId,
      parentRunId: f.child.run.id,
      rootRunId: f.parent.run.rootRunId,
      lane: "agent",
      source: "peer",
      status: "queued"
    })
    expect(f.store.peerDispatch.read(resultTurn.id)).toMatchObject({
      intent: "result",
      automatic: true,
      replyToRunId: f.parent.run.id,
      activationScopeRunId: f.parent.run.id
    })
    expect(
      f.store.message({ conversationId: f.a.conversationId, id: resultTurn.messageId })
    ).toMatchObject({
      sender: "bot",
      botId: f.b.bot.id,
      runId: f.child.run.id,
      replyTo: f.parent.run.messageId,
      text: "42"
    })
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
    expect(f.errors).toEqual([])
  },
  20_000
)

it.skipIf(!enabled)(
  "coalesces actual progress reads, stops while covered, and discards an ACK from the previous restored workspace",
  async () => {
    const f = await fixture(true)
    await f.select(f.b.conversationId)
    f.hold()
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await expect.poll(f.held).toBe(true)
    const reads = () => f.calls.filter((c) => c.method === "peerExchange").length
    expect(reads()).toBe(1)
    const ask = f.store.requestInteraction(f.child.lease, {
      kind: "approval",
      prompt: "Actual child needs review",
      action: { type: "send_peer", recipient: f.a.bot.id, text: "Never approved" }
    })
    await f.refresh()
    await expect
      .poll(async () =>
        f.page.evaluate(
          (id) =>
            Reflect.get(window, "fixtureState")().snapshot?.runs.find((r) => r.id === id)?.status,
          f.child.run.id
        )
      )
      .toBe("waiting_input")
    expect(reads()).toBe(1)
    for (let i = 0; i < 3; i++) {
      await f.page.evaluate(() => Reflect.get(window, "fixtureCoverBot")(true))
      await f.page.evaluate(() => Reflect.get(window, "fixtureCoverBot")(false))
    }
    expect(reads()).toBe(1)
    f.release()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByRole("status")
      .getByText("等待处理", { exact: true })
      .waitFor()
    expect(reads()).toBe(2)
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByRole("img", { name: "图表蓝色区域" })
      .waitFor()
    const blobBefore = await f.page.evaluate(() => Reflect.get(window, "blobs"))
    await f.page.evaluate(() => Reflect.get(window, "fixtureCoverBot")(true))
    await expect
      .poll(async () => f.page.evaluate(() => Reflect.get(window, "blobs").revoked))
      .toBeGreaterThan(blobBefore.revoked)
    const covered = reads()
    await f.page.waitForTimeout(2200)
    expect(reads()).toBe(covered)
    await f.page.evaluate(() => Reflect.get(window, "fixtureCoverBot")(false))
    await expect.poll(reads).toBe(covered + 1)
    await f.page.keyboard.press("Escape")
    f.hold()
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await expect.poll(f.held).toBe(true)
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','ui-new-epoch','{}',?)",
      [Date.now()]
    )
    await f.refresh()
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect
      .poll(() => f.page.getByRole("region", { name: "交流记录", exact: true }).count())
      .toBe(0)
    f.release()
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    await f.select(f.b.conversationId)
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("计算图中的 17+25", { exact: true })
      .waitFor()
    const last = f.calls.filter((c) => c.method === "peerExchange").at(-1)!.input as {
      expectedDataEpoch: string
    }
    expect(last.expectedDataEpoch).toBe("ui-new-epoch")
    expect(f.store.getRun(f.child.run.id).status).toBe("waiting_input")
    expect(f.store.getInteraction(ask.id).status).toBe("pending")
    expect(f.errors).toEqual([])
  },
  20_000
)

it.skipIf(!enabled)(
  "keeps one Workspace read across actual close/reopen, another address and restored Content remount",
  async () => {
    const f = await fixture(true),
      before = f.counts()
    await f.select(f.b.conversationId)
    f.hold()
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await expect.poll(f.held).toBe(true)
    const reads = () => f.calls.filter((c) => c.method === "peerExchange")
    for (let i = 0; i < 3; i++) {
      await f.page.keyboard.press("Escape")
      await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
      await expect
        .poll(() => f.page.getByRole("region", { name: "交流记录", exact: true }).count())
        .toBe(0)
      await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
      await f.page
        .getByRole("region", { name: "交流记录", exact: true })
        .getByRole("heading", { name: "交流记录" })
        .waitFor()
    }
    expect(reads()).toHaveLength(1)
    await f.select(f.a.conversationId)
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect
      .poll(() => f.page.getByRole("region", { name: "交流记录", exact: true }).count())
      .toBe(0)
    await f.page.getByRole("button", { name: "查看发给 复核 Bot 的协作" }).click()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("正在读取交流记录…", { exact: true })
      .waitFor()
    expect(reads()).toHaveLength(1)
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','reopen-new-epoch','{}',?)",
      [Date.now()]
    )
    await f.refresh()
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect
      .poll(() => f.page.getByRole("region", { name: "交流记录", exact: true }).count())
      .toBe(0)
    await f.select(f.b.conversationId)
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).click()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("正在读取交流记录…", { exact: true })
      .waitFor()
    expect(reads()).toHaveLength(1)
    f.release()
    await f.page
      .getByRole("region", { name: "交流记录", exact: true })
      .getByText("计算图中的 17+25", { exact: true })
      .waitFor()
    expect(reads()).toHaveLength(2)
    const last = reads().at(-1)!.input as { anchor: BotRunAddress; expectedDataEpoch: string }
    expect(last.anchor).toEqual({ conversationId: f.b.conversationId, runId: f.child.run.id })
    expect(last.expectedDataEpoch).toBe("reopen-new-epoch")
    expect(f.counts()).toEqual(before)
    expect(f.errors).toEqual([])
  },
  20_000
)

it.skipIf(!enabled)(
  "keeps the real chat DOM and draft while the read-only exchange owns only the middle column",
  async () => {
    const f = await fixture(true, false, true)
    f.store.finish(f.child.lease, "succeeded", "42")
    await f.select(f.b.conversationId)
    const before = f.counts()
    await f.page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
    await f.page.locator(".bot-inspector-panel").waitFor()
    await f.page.evaluate(() =>
      Reflect.set(window, "originalInspector", document.querySelector(".bot-inspector-panel"))
    )
    const entry = f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first()
    const composer = f.page.locator(".bot-composer-input")
    await composer.fill("KEEP_DRAFT_中间栏")
    await f.page.evaluate(() => {
      Reflect.set(window, "originalComposer", document.querySelector(".bot-composer-input"))
      Reflect.set(window, "originalTranscript", document.querySelector(".bot-transcript-content"))
    })
    await entry.click()
    const sheet = f.page.getByRole("region", { name: "交流记录", exact: true })
    await sheet.getByText("42", { exact: true }).waitFor()
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    expect(
      await f.page
        .locator(".bot-inspector-panel")
        .evaluate((node) => node === Reflect.get(window, "originalInspector"))
    ).toBe(true)
    expect(await sheet.getByRole("textbox").count()).toBe(0)
    expect(await sheet.getByRole("button", { name: "关闭聊天" }).count()).toBe(1)
    expect(
      await sheet.evaluate((node) => node.parentElement?.classList.contains("bot-conversation"))
    ).toBe(true)
    expect(
      await f.page.locator(".bot-conversation-primary").evaluate((node) => ({
        inert: (node as HTMLElement).inert,
        visibility: getComputedStyle(node).visibility,
        sameComposer:
          node.querySelector(".bot-composer-input") === Reflect.get(window, "originalComposer"),
        sameTranscript:
          node.querySelector(".bot-transcript-content") ===
          Reflect.get(window, "originalTranscript")
      }))
    ).toEqual({ inert: true, visibility: "hidden", sameComposer: true, sameTranscript: true })
    // Tab is ordinary document navigation; this sheet never traps or loops focus.
    await sheet.getByRole("button", { name: "关闭聊天" }).focus()
    await f.page.keyboard.press("Tab")
    expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(false)
    await sheet.getByRole("button", { name: "关闭聊天" }).focus()
    const imageButton = sheet.getByRole("button", { name: "查看图片 图表蓝色区域" })
    await imageButton.click()
    await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
    expect(await f.page.locator(".bot-peer-sheet").count()).toBe(1)
    const media = f.page.getByRole("dialog")
    await media.getByRole("img", { name: "chart.png", exact: true }).waitFor()
    await f.page.keyboard.press("ArrowRight")
    await media.getByRole("img", { name: "second.png", exact: true }).waitFor()
    const canvas = media.locator('[data-image-presentation="lightbox"]'),
      draggingImage = media.getByRole("img", { name: "second.png", exact: true })
    await draggingImage.click()
    await expect.poll(() => canvas.getAttribute("data-image-scale")).toBe("250")
    await draggingImage.evaluate((node) => {
      Reflect.set(window, "dragImage", node)
      node.addEventListener(
        "pointerdown",
        (event) => Reflect.set(window, "dragPointerId", (event as PointerEvent).pointerId),
        { once: true }
      )
    })
    const frame = (await canvas.boundingBox())!
    await f.page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await f.page.mouse.down()
    const capture = () =>
      draggingImage.evaluate(
        (node) =>
          node === Reflect.get(window, "dragImage") &&
          node.hasPointerCapture(Reflect.get(window, "dragPointerId"))
      )
    await expect.poll(capture).toBe(true)
    const snapshotReads = f.calls.filter((call) => call.method === "snapshot").length
    // The same real card receives a new authenticated snapshot during a held drag.
    await f.refresh()
    expect(f.calls.filter((call) => call.method === "snapshot").length).toBeGreaterThan(
      snapshotReads
    )
    expect(await capture()).toBe(true)
    await f.page.mouse.move(frame.x + frame.width / 2 + 80, frame.y + frame.height / 2 + 60)
    await expect
      .poll(() =>
        draggingImage.evaluate((node) => {
          const transform = new DOMMatrixReadOnly(getComputedStyle(node).transform)
          return transform.m41 > 40 && transform.m42 > 30
        })
      )
      .toBe(true)
    await f.page.mouse.up()
    expect(await capture()).toBe(false)
    await f.page.keyboard.press("0")
    await f.page.keyboard.press("ArrowLeft")
    await media.getByRole("img", { name: "chart.png", exact: true }).waitFor()
    await f.page.keyboard.press("ArrowRight")
    await media.getByRole("img", { name: "second.png", exact: true }).waitFor()
    await media.getByRole("button", { name: "切换图片 1/2 图表蓝色区域" }).click()
    await media.getByRole("img", { name: "chart.png", exact: true }).waitFor()
    await f.page.keyboard.press("Escape")
    await expect
      .poll(() => imageButton.evaluate((node) => node === document.activeElement))
      .toBe(true)
    await imageButton.click()
    await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
    await f.page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await expect
      .poll(() => imageButton.evaluate((node) => node === document.activeElement))
      .toBe(true)
    for (const [theme, width, reduced] of [
      ["codex-dark", 1440, false],
      ["codex-light", 1440, false],
      ["codex-dark", 760, true]
    ] as const) {
      await f.page.evaluate((value) => Reflect.get(window, "fixtureTheme")(value), theme)
      await f.page.setViewportSize({ width, height: 960 })
      await f.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" })
      // On narrow screens the original Inspector becomes an overlay; dismiss it
      // through its existing control before checking the uncovered middle column.
      if (width === 760)
        await f.page.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await sheet.getByRole("img", { name: "图表蓝色区域" }).waitFor()
      await expect
        .poll(() =>
          sheet
            .getByRole("img", { name: "图表蓝色区域" })
            .evaluate((node) => (node as HTMLImageElement).naturalWidth)
        )
        .toBeGreaterThan(0)
      const bounds = await sheet.boundingBox()
      const closeBounds = await sheet.getByRole("button", { name: "关闭聊天" }).boundingBox()
      expect(bounds).not.toBeNull()
      expect(closeBounds).not.toBeNull()
      expect(closeBounds!.x).toBeGreaterThanOrEqual(bounds!.x)
      expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
      expect(
        await sheet.getByRole("button", { name: "关闭聊天" }).evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return node.contains(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          )
        })
      ).toBe(true)
      // Capture the selected theme after the existing finite button color transition.
      await sheet.getByRole("button", { name: "关闭聊天" }).evaluate(async (node) => {
        await Promise.all(
          node
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .map((animation) => animation.finished.catch(() => {}))
        )
      })
      await mkdir(resolve("output/peer-exchange/inline"), { recursive: true })
      await f.page.screenshot({
        path: resolve(
          `output/peer-exchange/inline/${theme}-${width}-${reduced ? "reduce" : "normal"}.png`
        )
      })
    }
    await f.page.setViewportSize({ width: 1440, height: 960 })
    await sheet.getByRole("button", { name: "关闭聊天" }).click()
    await expect.poll(() => sheet.count()).toBe(0)
    await expect.poll(() => entry.evaluate((node) => node === document.activeElement)).toBe(true)
    expect(await composer.innerText()).toBe("KEEP_DRAFT_中间栏")
    expect(
      await composer.evaluate((node) => node === Reflect.get(window, "originalComposer"))
    ).toBe(true)
    expect(f.counts()).toEqual(before)
    expect(f.errors).toEqual([])
  },
  20_000
)
it.skipIf(!enabled)(
  "pauses hidden transcript reads and writers without replacing its detached viewport",
  async () => {
    const f = await fixture(false, true)
    await f.select(f.b.conversationId)
    const viewport = f.page.locator(".bot-transcript")
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight))
      .toBeGreaterThan(1000)
    await viewport.hover()
    await f.page.mouse.wheel(0, 100_000)
    await expect
      .poll(() =>
        viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
      )
      .toBeLessThanOrEqual(1)
    await f.page.mouse.wheel(0, -700)
    await expect
      .poll(() =>
        viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
      )
      .toBeGreaterThanOrEqual(600)
    await expect
      .poll(() =>
        f.page.evaluate(
          (id) => Reflect.get(window, "fixtureState")().historyFollowTail[id],
          f.b.conversationId
        )
      )
      .toBe(false)
    // The original visible old-page request can remove its 36px loading row.
    // Sample the detached viewport only after that real cursor has settled.
    await expect
      .poll(() =>
        f.page.evaluate(
          (id) => Reflect.get(window, "fixtureState")().hasOlder[id],
          f.b.conversationId
        )
      )
      .toBe(false)
    const held = await viewport.evaluate((node) => node.scrollTop)
    const entry = f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first()
    // The connected original entry is invoked without scrolling the reading viewport.
    await entry.evaluate((node) => (node as HTMLButtonElement).click())
    const sheet = f.page.getByRole("region", { name: "交流记录", exact: true })
    await sheet.getByText("等待 Bot 回复", { exact: true }).waitFor()
    const reads = f.calls.filter((call) => call.method === "setReadState").length
    const saved = await f.page.evaluate(() => Reflect.get(window, "fixtureViewportWrites"))
    f.store.send({
      nonce: "hidden-new-message",
      conversationId: f.b.conversationId,
      text: "HIDDEN_NEW_MESSAGE"
    })
    await f.refresh()
    await f.page.waitForTimeout(250)
    expect(f.calls.filter((call) => call.method === "setReadState")).toHaveLength(reads)
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(held, 0)
    expect(await f.page.evaluate(() => Reflect.get(window, "fixtureViewportWrites"))).toBe(saved)
    await sheet.getByRole("button", { name: "关闭聊天" }).click()
    await expect.poll(() => sheet.count()).toBe(0)
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(held, 0)
    expect(
      await f.page.evaluate(
        (id) => Reflect.get(window, "fixtureState")().historyFollowTail[id],
        f.b.conversationId
      )
    ).toBe(false)
    expect(f.errors).toEqual([])
  },
  20_000
)

it.skipIf(!enabled)(
  "suspends the same inline read owner while an existing Inspector resource Dialog covers it",
  async () => {
    const f = await fixture(true)
    await f.select(f.b.conversationId)
    await f.page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
    await f.page.locator(".bot-inspector-panel").waitFor()
    await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first().click()
    const sheet = f.page.getByRole("region", { name: "交流记录", exact: true })
    await sheet.getByText("计算图中的 17+25", { exact: true }).waitFor()
    const reads = () => f.calls.filter((call) => call.method === "peerExchange").length
    await f.page
      .locator(".bot-inspector-panel")
      .getByRole("button", { name: "记忆", exact: true })
      .click()
    await f.page.getByRole("dialog").waitFor()
    const covered = reads()
    await f.page.waitForTimeout(2200)
    expect(reads()).toBe(covered)
    expect(await f.page.locator(".bot-peer-sheet").count()).toBe(1)
    await f.page.keyboard.press("Escape")
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect.poll(reads).toBe(covered + 1)
    await sheet.getByText("计算图中的 17+25", { exact: true }).waitFor()
    expect(f.errors).toEqual([])
  },
  20_000
)

it.skipIf(!enabled)(
  "does not restore a retired preview trigger after navigation or an actual data epoch change",
  async () => {
    const f = await fixture(true)
    f.store.finish(f.child.lease, "succeeded", "42")
    const before = f.counts()
    await f.select(f.b.conversationId)
    const open = async () => {
      await f.page.getByRole("button", { name: "查看来自 设计 Bot 的协作" }).first().click()
      const sheet = f.page.getByRole("region", { name: "交流记录", exact: true })
      await sheet.getByText("42", { exact: true }).waitFor()
      await sheet.getByRole("button", { name: "查看图片 图表蓝色区域" }).click()
      await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
    }
    await open()
    await f.select(f.a.conversationId)
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await f.page.locator(".bot-composer-input").focus()
    expect(
      await f.page
        .locator(".bot-composer-input")
        .evaluate((node) => node === document.activeElement)
    ).toBe(true)
    expect(await f.page.locator(".bot-peer-sheet").count()).toBe(0)
    await f.select(f.b.conversationId)
    await open()
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','preview-new-epoch','{}',?)",
      [Date.now()]
    )
    await f.refresh()
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await f.page.locator(".bot-composer-input").focus()
    expect(
      await f.page
        .locator(".bot-composer-input")
        .evaluate((node) => node === document.activeElement)
    ).toBe(true)
    expect(await f.page.locator(".bot-peer-sheet").count()).toBe(0)
    expect(f.counts()).toEqual(before)
    expect(f.errors).toEqual([])
  },
  20_000
)
