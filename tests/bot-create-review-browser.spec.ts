/** Real creation forms and SQLite policies; no model or user App is involved. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotCreateInput } from "../src/shared/bot-types"
type FixtureWindow = Window & { fixtureTheme(theme: string): void; fixtureRefresh(): Promise<void> }

async function main() {
  const root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src")
  const output = join(root, "output/create-review-browser")
  await mkdir(output, { recursive: true })
  const store = new BotStore(":memory:")
  const calls: { method: string; input: unknown }[] = []
  let legacy = false
  const status = () => ({
    protocol: 1,
    hostId: "creation-test",
    runtimeReady: true,
    error: null,
    dataEpoch: store.dataEpoch(),
    capabilities: [
      "mutation-data-epoch-v2",
      "scoped-bot-create",
      "bot-update-receipts",
      "primary-bot-v1",
      ...(legacy ? [] : ["bot-create-review-v1"])
    ]
  })
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
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{useBotQuickCreate}from'./src/renderer/src/lib/use-bot-quick-create';
      import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
      import{BotQuickCreateFeedback}from'./src/renderer/src/components/bots/BotQuickCreateFeedback';
      import{BotEditor}from'./src/renderer/src/components/bots/BotEditor';
      import{BotPrimarySettings}from'./src/renderer/src/components/bots/BotPrimarySettings';
      import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      import './src/renderer/src/components/bots/bot-workspace.css';
      window.electron={process:{platform:'darwin'}};
      window.api={bots:new Proxy({}, {get:(_,method)=>input=>window.fixtureCall(method,input)})};
      useBotWorkspaceStore.setState(${JSON.stringify({ snapshot: store.snapshot(), host: status() })});
      window.fixtureTheme=applyThemePreference;window.fixtureRefresh=()=>useBotWorkspaceStore.getState().refresh();
      applyThemePreference('codex-light');
      function App(){const quick=useBotQuickCreate(),[open,setOpen]=useState(false),[editor,setEditor]=useState(false),[primary,setPrimary]=useState(false);return <main className='bot-workspace bg-background text-foreground p-8' style={{height:'100vh'}}>
      <button onClick={()=>{setOpen(true);void quick.start()}}>快速创建</button>
      <button onClick={()=>setEditor(true)}>高级创建</button>
      <button onClick={()=>setPrimary(true)}>主 Bot 创建</button>
      <BotQuickCreateFeedback state={quick.state} dataEpoch={useBotWorkspaceStore.getState().snapshot.dataEpoch} open={open} close={()=>{quick.cancelReview();setOpen(false)}} retry={quick.start} repair={quick.repair} confirmReview={quick.confirmReview}/>
      {editor&&<BotEditor close={()=>setEditor(false)} created={()=>{}}/>}
      {primary&&<BotPrimarySettings initialMode='create' close={()=>setPrimary(false)}/>}
      </main>}createRoot(document.getElementById('root')).render(<App/>);`
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"creation-test"'
    }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      switch (method) {
        case "status":
          return status()
        case "snapshot":
          return store.snapshot()
        case "create":
          return store.createBot(input as BotCreateInput)
        case "primaryBot":
          return store.primary.read()
        case "ensurePrimaryBot":
          return store.primary.ensure(input)
        case "connectors":
          return []
        case "messages":
          return store.messages((input as { conversationId: string }).conversationId)
        case "setReadState":
          return store.setReadState(input as Parameters<BotStore["setReadState"]>[0])
        default:
          throw new Error("Unexpected test method " + method)
      }
    })
    await page.route("http://127.0.0.1:43176/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.build(scanner.scan())}${bundle.outputFiles
          .filter((f) => f.path.endsWith(".css"))
          .map((f) => f.text)
          .join(
            ""
          )}</style><div id="root"></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43176/")
    await page.getByRole("button", { name: "快速创建", exact: true }).click()
    const smart = page.getByRole("radio", { name: /^智能审核/ }),
      manual = page.getByRole("radio", { name: /^逐项确认/ })
    await smart.waitFor()
    assert.equal(await smart.isChecked(), true)
    assert.equal(store.snapshot().bots.length, 0)
    await page.screenshot({ path: join(output, "light.png") })
    await page.evaluate(() => (window as FixtureWindow).fixtureTheme("codex-dark"))
    await page.evaluate(async () => {
      void getComputedStyle(document.querySelector('[role="dialog"]')!).backgroundColor
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished)
      )
    })
    await page.screenshot({ path: join(output, "dark.png"), animations: "disabled" })
    await manual.check()
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(store.snapshot().bots.length, 0)
    assert.equal(store.db.exec("SELECT * FROM bot_auto_review_settings")[0]?.values.length ?? 0, 0)
    await page.getByRole("button", { name: "快速创建", exact: true }).click()
    assert.equal(await smart.isChecked(), true)
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.waitForFunction(
      () => (window as FixtureWindow).fixtureRefresh && !document.querySelector('[role="dialog"]')
    )
    assert.equal(store.snapshot().bots.length, 1)
    assert.equal(store.autoReview.read(store.snapshot().bots[0].id).isEnabled, true)
    await page.getByRole("button", { name: "高级创建", exact: true }).click()
    await manual.check()
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    assert.equal(store.snapshot().bots.length, 2)
    const second = calls.filter((c) => c.method === "create")[1]
    assert.equal((second.input as BotCreateInput).autoReviewEnabled, false)
    await page.getByRole("button", { name: "主 Bot 创建", exact: true }).click()
    await smart.waitFor()
    assert.equal(await smart.isChecked(), true)
    await page.getByRole("button", { name: "创建并设为主 Bot", exact: true }).click()
    await page.getByRole("radio", { name: /^智能审核/ }).waitFor({ state: "hidden" })
    assert.equal(store.autoReview.read(store.primary.read().botId!).isEnabled, true)
    await page.getByRole("dialog").press("Escape")
    legacy = true
    await page.evaluate(() => (window as FixtureWindow).fixtureRefresh())
    await page.getByRole("button", { name: "快速创建", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    const oldRequest = calls.filter((c) => c.method === "create").at(-1)!
    assert.equal(Object.hasOwn(oldRequest.input as BotCreateInput, "autoReviewEnabled"), false)
    assert.equal(store.snapshot().bots.length, 4)
    const legacyBot = store
      .snapshot()
      .bots.find((bot) => store.autoReview.read(bot.id).revision === 0)!
    assert.ok(legacyBot)
    assert.equal(store.autoReview.read(legacyBot.id).isEnabled, false)
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "result.safe.json"),
      JSON.stringify(
        {
          passed: true,
          tests: [
            "explicit smart default",
            "cancel creates nothing",
            "manual advanced create",
            "primary smart creation",
            "legacy Host omits new field"
          ],
          botCount: 4,
          browserErrors: errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS: real creation forms + SQLite policies, both themes; legacy Host remains manual"
    )
  } finally {
    await browser.close()
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
