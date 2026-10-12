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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{BotRunHistory}from'./src/renderer/src/components/bots/BotRunHistory';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{Toaster}from'sonner';import{useAppStore}from'@/lib/store';window.fixtureCoverBot=open=>useAppStore.setState({showCustomizeView:open});applyThemePreference('codex-dark');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};window.fixtureSelect=id=>store.getState().select(id);window.fixtureRefresh=()=>store.getState().refresh();window.fixtureState=()=>({selected:store.getState().selected,snapshot:store.getState().snapshot});const create=URL.createObjectURL,revoke=URL.revokeObjectURL;window.blobs={created:0,revoked:0};URL.createObjectURL=function(b){window.blobs.created++;return create.call(URL,b)};URL.revokeObjectURL=function(u){window.blobs.revoked++;return revoke.call(URL,u)};function Fixture(){const[history,setHistory]=useState(null);window.fixtureHistory=(input)=>setHistory(input);return <main className="flex h-screen bg-background text-foreground"><BotWorkspace/>{history&&<BotRunHistory key={history.runId} address={history} close={()=>setHistory(null)}/>}<Toaster theme="dark"/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
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
async function fixture(withImage = false) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-dispatch-ui-"))
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
        ? `\\\\.\\pipe\\cmb-peer-dispatch-ui-${token.slice(0, 16)}`
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
        name: "chart.png",
        mime: "image/png"
      },
      Buffer.from(await avatarImage(), "base64"),
      parent.lease
    )
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
          text: "计算图中的 17+25",
          images: [{ artifact_id: image.id, alt: "图表蓝色区域" }]
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
    sent = store.sendPeer(parent.lease, { nonce: "text", recipient: b.bot.id, text: "计算 17+25" })
  const child = store.claim(host.id)!
  expect(child.run.id).toBe(sent.runIds[0])
  store.waitForPeer(parent.lease, child.run.id)
  const merged = withImage
    ? JSON.parse(
        await sendReviewedBotPeer(
          {
            store,
            ...child,
            bot: b.bot,
            messages: store.messagesForRun(child.run.id),
            signal: new AbortController().signal
          },
          {
            callId: "actual-merged",
            recipient: a.bot.id,
            text: "MERGED_REPLY_ONLY",
            intent: "status",
            images: [
              {
                artifact_id: store.message({ conversationId: b.conversationId, id: sent.messageId })
                  .attachments[0],
                alt: "合并回复图表"
              }
            ]
          },
          () => {
            store.assertDispatch(child.lease)
          },
          async (id, action, operation, commit) => {
            const ask = store.requestInteraction(child.lease, {
              kind: "approval",
              prompt: JSON.stringify(action),
              action
            })
            store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
            const apply = () =>
              store.approvedToolOnce(child.lease, { id, action, approvalId: ask.id }, operation)
            return commit ? commit(apply) : apply()
          },
          files,
          reader
        )
      )
    : store.sendPeer(child.lease, {
        nonce: "merged-reply",
        recipient: a.bot.id,
        text: "MERGED_REPLY_ONLY",
        intent: "status"
      })
  expect(merged).toMatchObject({ runIds: [], mergedIntoRunId: parent.run.id })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  page.setDefaultTimeout(5000)
  cleanup.push(() => page.close())
  const calls: { method: string; input: unknown }[] = [],
    errors: string[] = []
  let hold = false,
    held: (() => void) | undefined
  cleanup.push(async () => {
    await mkdir(resolve("output/peer-dispatch-debug"), { recursive: true })
    await page.screenshot({
      path: resolve(`output/peer-dispatch-debug/${withImage ? "image" : "text"}.png`)
    })
    await writeFile(
      resolve(`output/peer-dispatch-debug/${withImage ? "image" : "text"}.json`),
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
    merged,
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
it.skipIf(!enabled).each([false, true])(
  "real Workspace/History and authenticated merged exchange preserve one original task and scoped preview (image=%s)",
  async (image) => {
    const f = await fixture(image),
      before = f.counts()
    await f.select(f.a.conversationId)
    await f.page.getByRole("button", { name: "查看来自 复核 Bot 的协作" }).last().click()
    const dialog = f.page.getByRole("dialog")
    const sheet = f.page.getByRole("region", { name: "交流记录", exact: true })
    await sheet.getByText("MERGED_REPLY_ONLY", { exact: true }).waitFor()
    expect(await sheet.getByRole("textbox").count()).toBe(0)
    expect(await sheet.getByText("SOURCE_PRIVATE_USER_REQUEST").count()).toBe(0)
    if (image) {
      await expect
        .poll(() =>
          sheet
            .getByRole("img", { name: "合并回复图表" })
            .evaluate((e) => (e as HTMLImageElement).naturalWidth)
        )
        .toBeGreaterThan(0)
      await sheet.getByRole("button", { name: "查看图片 合并回复图表" }).click()
      await f.page.getByRole("button", { name: "保存原文件" }).waitFor()
      await expect
        .poll(() =>
          f.page
            .getByRole("dialog")
            .getByRole("img", { name: "chart.png" })
            .evaluate((e) => (e as HTMLImageElement).naturalWidth)
        )
        .toBeGreaterThan(0)
      await f.page.keyboard.press("Escape")
      await sheet.getByRole("heading", { name: "交流记录" }).waitFor()
      // The same sheet remains mounted during the preview's native exit.
      // Wait for its real close-focus event before sending the next Escape.
      await expect
        .poll(() =>
          sheet
            .getByRole("button", { name: "查看图片 合并回复图表" })
            .evaluate((node) => node === document.activeElement)
        )
        .toBe(true)
    }
    await f.page.keyboard.press("Escape")
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect.poll(() => sheet.count()).toBe(0)
    await f.showHistory({ conversationId: f.a.conversationId, runId: f.parent.run.id })
    const history = f.page
      .getByRole("dialog")
      .filter({ has: f.page.getByRole("heading", { name: "任务记录" }) })
    await history.getByRole("heading", { name: "任务记录" }).waitFor()
    await history
      .locator("li")
      .filter({ hasText: "回信已进入原任务" })
      .getByRole("button", { name: "查看与 复核 Bot 的交流" })
      .click()
    await dialog.getByText("MERGED_REPLY_ONLY", { exact: true }).waitFor()
    await f.page.getByRole("button", { name: "返回任务记录" }).click()
    await f.page.getByRole("heading", { name: "任务记录" }).waitFor()
    await f.page.keyboard.press("Escape")
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await f.select(f.b.conversationId)
    const openSource = async () => {
      if (image) {
        await f.page.getByRole("button", { name: "查看发给 设计 Bot 的协作" }).last().click()
      } else {
        // Plain text retains the original message format; the outgoing update
        // is linked from its real task event rather than fabricating a message.
        await f.showHistory({ conversationId: f.b.conversationId, runId: f.child.run.id })
        const history = f.page
          .getByRole("dialog")
          .filter({ has: f.page.getByRole("heading", { name: "任务记录" }) })
        await history.getByRole("heading", { name: "任务记录" }).waitFor()
        await history
          .locator("li")
          .filter({ hasText: "回信已进入原任务" })
          .getByRole("button", { name: "查看与 设计 Bot 的交流" })
          .click()
      }
    }
    const closeSource = async () => {
      if (!image) {
        await f.page.getByRole("button", { name: "返回任务记录" }).click()
        await f.page.getByRole("heading", { name: "任务记录" }).waitFor()
      }
      await f.page.keyboard.press("Escape")
      await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
      if (image) await expect.poll(() => sheet.count()).toBe(0)
    }
    await openSource()
    const source = image ? sheet : dialog
    await source.getByText("MERGED_REPLY_ONLY", { exact: true }).waitFor()
    expect(await source.getByText("SOURCE_PRIVATE_USER_REQUEST").count()).toBe(0)
    const reads = f.calls
      .filter((c) => c.method === "peerExchange")
      .map((c) => c.input as { anchor: BotRunAddress; peerRunId: string; mergedMessageId?: string })
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
    expect(
      reads.every((r) => r.peerRunId === f.child.run.id && r.mergedMessageId === f.merged.messageId)
    ).toBe(true)
    expect(f.counts()).toEqual(before)
    await mkdir(resolve("output/peer-dispatch"), { recursive: true })
    await f.page.screenshot({
      path: resolve(`output/peer-dispatch/merged-${image ? "image" : "text"}-dark.png`)
    })
    await closeSource()
    // Exercise restoration under the actual Workspace view owner, not the
    // deliberately standalone history fixture outside that owner.
    await f.select(f.a.conversationId)
    f.hold()
    await f.page.getByRole("button", { name: "查看来自 复核 Bot 的协作" }).last().click()
    await expect.poll(f.held).toBe(true)
    const pending = f.calls.filter((c) => c.method === "peerExchange").length
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at)VALUES('workspace.restored','merged-new-epoch','{}',?)",
      [Date.now()]
    )
    await f.refresh()
    await expect.poll(() => f.page.getByRole("dialog").count()).toBe(0)
    await expect.poll(() => sheet.count()).toBe(0)
    // Restoring must retire the old selection before it can request data from
    // the new workspace. Only the explicit reopen below owns that new read.
    expect(f.calls.filter((c) => c.method === "peerExchange")).toHaveLength(pending)
    f.release()
    expect(await f.page.getByRole("dialog").count()).toBe(0)
    expect(await sheet.count()).toBe(0)
    await f.select(f.a.conversationId)
    await f.page.getByRole("button", { name: "查看来自 复核 Bot 的协作" }).last().click()
    await sheet.getByText("MERGED_REPLY_ONLY", { exact: true }).waitFor()
    expect(f.calls.filter((c) => c.method === "peerExchange")).toHaveLength(pending + 1)
    expect(
      (
        f.calls.filter((c) => c.method === "peerExchange").at(-1)!.input as {
          expectedDataEpoch: string
        }
      ).expectedDataEpoch
    ).toBe("merged-new-epoch")
    expect(f.store.getRun(f.parent.run.id).status).toBe("waiting_input")
    expect(f.errors).toEqual([])
  },
  20_000
)
