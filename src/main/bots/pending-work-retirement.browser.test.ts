/** Actual React pending cards and Store projections; no model, personal data or desktop input. */
import { afterAll, beforeAll, expect, it } from "vitest"
import { build } from "esbuild"
import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join, resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { BotStore } from "./store"
import type { BotPendingCardRequest, BotTrackedWorkRequest } from "../../shared/bot-work-pages"

const enabled = process.env.CMB_PENDING_WORK_UI_TEST === "1"
let browser: Browser, server: Server, url: string
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{PendingWorkCard}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';
      window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};
      function Fixture(){const[descriptor,setDescriptor]=useState(null);window.fixtureShow=input=>{store.setState({host:input.host,snapshot:input.snapshot,selected:null,trackedWork:{}});setDescriptor(input.descriptor)};window.fixtureRemoveDescriptor=()=>setDescriptor(null);window.fixtureDescriptor=()=>descriptor?.id;window.fixtureRefresh=()=>store.getState().refreshWorkPages();return <main id="pending-surface">{descriptor&&<PendingWorkCard descriptor={descriptor} refresh={async()=>{await store.getState().refreshWorkPages();window.fixtureRefreshed=true}} openComputerHelp={()=>{}}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    outfile: "pending-work-fixture.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"pending-fixture"'
    },
    plugins: [
      await highlightWorkerFixture(renderer),
      {
        name: "internal-pending-card-fixture",
        setup(builder) {
          // Expose the internal card only in this fixture, without a production export.
          builder.onLoad({ filter: /\/BotWorkspace\.tsx$/ }, async (args) => ({
            loader: "tsx",
            contents: (await readFile(args.path, "utf8")) + "\nexport { PendingWorkCard };",
            resolveDir: join(renderer, "components/bots")
          }))
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) =>
            args.path === "./store" && !args.importer.startsWith(join(renderer, "lib"))
              ? undefined
              : { path: "app-store", namespace: "outer" }
          )
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread",
            namespace: "outer"
          }))
          builder.onLoad({ filter: /.*/, namespace: "outer" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              args.path === "app-store"
                ? 'import{create}from"zustand";export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));'
                : "export const useThreadStateSelector=(_id,select)=>select({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))
  if (!script) throw new Error("Missing pending-card fixture bundle")
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(`<div id="root"></div><script>${script.text}</script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  url = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 10_000)

async function fixture(options: { expired?: boolean; holdTracked?: boolean } = {}) {
  let now = Date.now()
  const store = new BotStore(":memory:", () => now)
  let page: Page | undefined
  let releaseTracked!: () => void
  const held = new Promise<void>((resolve) => {
    releaseTracked = resolve
  })
  const stop = async () => {
    releaseTracked()
    try {
      await page?.close()
    } finally {
      store.close()
    }
  }
  try {
    const bot = store.createBot({ nonce: "bot", name: "Pending projection fixture" })
    store.send({ nonce: "task", conversationId: bot.conversationId, text: "Fixture task" })
    const claim = store.claim("worker", 300_000)!
    const item = store.requestInteraction(claim.lease, {
      kind: "approval",
      prompt: "Fixture exact write approval",
      action: { kind: "write", path: "fixture.txt", sha256: "a".repeat(64) },
      expiresInMs: 60_000
    })
    if (options.expired) now = item.expiresAt + 1
    const owner = { hostId: "pending-fixture-host", dataEpoch: store.dataEpoch() }
    const descriptor = store.workPages.pendingInteractions(
      { ...owner, scope: { kind: "conversation", conversationId: bot.conversationId } },
      owner.hostId
    ).items[0]
    const host = {
      ...owner,
      platform: process.platform,
      protocol: 1,
      runtimeReady: true,
      error: null,
      capabilities: ["work-pages-v1"]
    }
    const snapshot = {
      ...store.snapshot(
        {
          ...owner,
          runProjection: "summary",
          workProjection: "paged",
          view: { conversationId: bot.conversationId }
        },
        owner.hostId
      ),
      // The real Host stamps this owner on the Store's work projection.
      hostId: owner.hostId
    }
    let answerCalls = 0
    page = await browser.newPage()
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      switch (method) {
        case "pendingCard":
          return store.workPages.pendingCard(input as BotPendingCardRequest, owner.hostId)
        case "trackedWork":
          if (options.holdTracked) await held
          return store.workPages.trackedWork(input as BotTrackedWorkRequest, owner.hostId)
        case "answer":
          answerCalls++
          return store.answerInteraction(input as Parameters<BotStore["answerInteraction"]>[0])
        default:
          throw new Error(`Unexpected fixture method: ${method}`)
      }
    })
    await page.goto(url)
    await page.waitForFunction(() => typeof window["fixtureShow"] === "function")
    await page.evaluate((input) => window["fixtureShow"](input), { host, snapshot, descriptor })
    return { store, item, claim, descriptor, page, stop, answerCalls: () => answerCalls }
  } catch (error) {
    await stop()
    throw error
  }
}

it.runIf(enabled).each([
  ["approve", "批准本次操作"],
  ["reject", "拒绝本次"]
] as const)(
  "%s retires the card after one exact answer while its old descriptor is still mounted",
  async (answer, button) => {
    const f = await fixture()
    try {
      await f.page.getByRole("button", { name: button, exact: true }).click()
      await f.page.waitForFunction(() => window["fixtureRefreshed"] === true)
      expect(f.answerCalls()).toBe(1)
      const receipt = f.store.getInteraction(f.item.id)
      expect(receipt).toMatchObject({
        id: f.item.id,
        status: "answered",
        answer,
        revision: f.item.revision + 1
      })
      expect(
        f.store
          .events()
          .filter((event) => event.kind === "interaction.answered" && event.entityId === f.item.id)
      ).toHaveLength(1)
      expect(await f.page.evaluate(() => window["fixtureDescriptor"]())).toBe(f.descriptor.id)
      await expect.poll(() => f.page.locator("#pending-surface").innerText()).toBe("")
      expect(await f.page.getByRole("button").count()).toBe(0)
      await f.page.evaluate(() => window["fixtureRemoveDescriptor"]())
      expect(await f.page.locator("#pending-surface").innerText()).toBe("")
    } finally {
      await f.stop()
    }
  },
  10_000
)

it.runIf(enabled)(
  "an authoritative cancelled interaction retires without claiming success or expiry",
  async () => {
    const f = await fixture()
    try {
      await f.page.getByRole("button", { name: "批准本次操作", exact: true }).waitFor()
      f.store.cancel(f.claim.run.id)
      await f.page.evaluate(() => window["fixtureRefresh"]())
      expect(f.store.getInteraction(f.item.id).status).toBe("cancelled")
      expect(f.answerCalls()).toBe(0)
      await expect.poll(() => f.page.locator("#pending-surface").innerText()).toBe("")
      expect(await f.page.getByRole("button").count()).toBe(0)
    } finally {
      await f.stop()
    }
  },
  10_000
)

it.runIf(enabled)(
  "an explicitly expired pending descriptor remains expired and cannot be answered",
  async () => {
    const f = await fixture({ expired: true })
    try {
      expect(f.descriptor.status).toBe("expired")
      await expect
        .poll(() => f.page.getByRole("status").innerText())
        .toBe("此请求已结束或过期。刷新后查看最新进展。")
      expect(await f.page.getByRole("button").count()).toBe(0)
      expect(f.answerCalls()).toBe(0)
      expect(() =>
        f.store.answerInteraction({ id: f.item.id, revision: f.item.revision, answer: "approve" })
      ).toThrow("过期")
    } finally {
      await f.stop()
    }
  },
  10_000
)

it.runIf(enabled)(
  "an unobserved tracked response stays loading without an answer control or expiry claim",
  async () => {
    const f = await fixture({ holdTracked: true })
    try {
      await expect.poll(() => f.page.getByRole("status").innerText()).toBe("正在读取待处理事项…")
      expect(await f.page.getByRole("button").count()).toBe(0)
      expect(f.answerCalls()).toBe(0)
      expect(f.store.getInteraction(f.item.id).status).toBe("pending")
    } finally {
      await f.stop()
    }
  },
  10_000
)
