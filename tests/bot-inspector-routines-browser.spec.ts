/** Real Inspector/Resources React, original IPC packet decoder and actual persistent
 * SQLite/RPC receipts. Controlled workspace visibility is not an Electron/backup proof. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { basename, join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import type { BotWorkspaceSnapshot } from "../src/shared/bot-types"
import type { BotSaveRoutineInput } from "../src/shared/bot-routines"

interface InspectorRoutineFixture {
  fixtureStorageDenied: boolean
  fixtureSettings(value: boolean): void
  fixtureTheme(value: string): void
  fixtureWorkspace: {
    getState(): {
      snapshot: BotWorkspaceSnapshot
      drafts: Record<string, { prompt: string }>
      refresh(): Promise<void>
    }
    setState(value: { selected?: string; snapshot?: BotWorkspaceSnapshot }): void
  }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-inspector-routine-"))
  const store = new BotStore(join(directory, "bots.sqlite"))
  const api = createBotAPI(new BotHost(store))
  const own = store.createBot({ nonce: "own", name: "项目助手" })
  const other = store.createBot({ nonce: "other", name: "另一项目" })
  const first = store.saveRoutine({
    botId: own.bot.id,
    name: "检查项目",
    prompt: "核对项目输入，交付证据",
    enabled: true,
    schedule: { kind: "interval", anchor: Date.now() + 120_000, everyMs: 61_001 },
    timezone: "Asia/Shanghai"
  })
  store.saveRoutine({
    botId: own.bot.id,
    name: "整理资料",
    prompt: "整理现有资料",
    enabled: false,
    schedule: { kind: "event", topic: "docs.changed" },
    timezone: "UTC"
  })
  store.saveRoutine({
    botId: other.bot.id,
    name: "另一项目例程",
    prompt: "另一项目内容",
    enabled: false,
    schedule: { kind: "event", topic: "other.changed" },
    timezone: "UTC"
  })
  const source = resolve(process.env.CMB_INSPECTOR_UI_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const output = resolve(
    process.env.CMB_INSPECTOR_ROUTINES_OUTPUT ?? "output/bot-inspector-routines"
  )
  await mkdir(output, { recursive: true })
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
  const highlight = await build({
    entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent"
  })
  const snapshot = store.snapshot()
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: source,
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{useAppStore}from'@/lib/store';import{applyThemePreference}from'@/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>async input=>window.fixtureCall(method,input)})};window.fixtureStorageDenied=false;const write=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(window.fixtureStorageDenied&&key.startsWith('bot-routine-pending:'))throw Error('storage full');return write.call(this,key,value)};function Fixture(){const[index,setIndex]=useState(0);const[resource,setResource]=useState(null);const[covered,setCovered]=useState(false);const[tab,setTab]=useState('details');const[childModal,setChildModal]=useState(false);const state=useBotWorkspaceStore();const bots=[${JSON.stringify(own)},${JSON.stringify(other)}];const owner=bots[index];window.fixtureInspector=setIndex;window.fixtureCover=setCovered;window.fixtureSettings=value=>useAppStore.setState({showCustomizeView:value});window.fixtureTab=setTab;const panel=resource?.tab==='routines'&&resource.intent?.mode==='view';const resourceContent=resource&&<BotResources key={resource.bot.id+resource.tab+':'+state.snapshot.dataEpoch} bot={resource.bot} tab={resource.tab} focusId={resource.intent?.id} routineIntent={resource.intent} presentation={panel?'panel':'dialog'} back={()=>{setResource(null);setTab('details')}} onPresentationChange={value=>setChildModal(value.modal)} close={()=>setResource(null)}/>;return <main className='bot-workspace flex h-screen bg-background text-foreground'><section className='min-w-0 flex-1 p-8'><h1>例程真实回执验收</h1><div id={'bot-composer-'+state.selected} contentEditable suppressContentEditableWarning aria-label='会话草稿'>{state.drafts[state.selected]?.prompt??''}</div></section><BotInspector key={owner.bot.id+':'+state.snapshot.dataEpoch} bot={owner.bot} conversationId={owner.conversationId} tab={tab} onTabChange={setTab} settings={()=>setCovered(true)} covered={covered||Boolean(resource&&!panel)||childModal} routineDetail={panel?resourceContent:undefined} resource={(tab,intent)=>setResource({bot:owner.bot,tab,intent})} close={()=>setCovered(true)}/>{!panel&&resourceContent}<Toaster/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    outfile: join(directory, "ui.js"),
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "bounded-workspace-facade",
        setup(context) {
          context.onResolve({ filter: /\?url$/ }, async (args) => {
            const result = await context.resolve(args.path.slice(0, -4), {
              resolveDir: args.resolveDir,
              kind: args.kind
            })
            return result.errors.length ? result : { path: result.path, namespace: "url-asset" }
          })
          context.onLoad({ filter: /.*/, namespace: "url-asset" }, async ({ path }) => ({
            loader: "file",
            contents: await readFile(path)
          }))
          context.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight",
            namespace: "preview-worker"
          }))
          context.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker { constructor(options) { const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:"text/javascript"})); super(url,options); URL.revokeObjectURL(url); } }`
          }))
          context.onResolve({ filter: /(?:\/lib\/store|^@\/lib\/store)$/ }, () => ({
            path: "app",
            namespace: "fixture"
          }))
          context.onResolve({ filter: /^\.\/store$/ }, (args) =>
            args.importer.includes("/renderer/src/lib/")
              ? { path: "app", namespace: "fixture" }
              : undefined
          )
          context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "workspace",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "ts",
            resolveDir: source,
            contents:
              path === "app"
                ? `import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false}));`
                : `import{create}from'zustand';export const useBotWorkspaceStore=create((set,get)=>({snapshot:${JSON.stringify(snapshot)},host:{capabilities:['mutation-data-epoch-v2','routine-management','routine-editor','routine-run-version']},selected:${JSON.stringify(own.conversationId)},drafts:{},trackedWork:{},refresh:async()=>set({snapshot:await window.fixtureSnapshot()}),select:selected=>set({selected}),updateDraft:(id,change)=>set(state=>({drafts:{...state.drafts,[id]:{...state.drafts[id],...change,revision:crypto.randomUUID()}}}))}));window.fixtureWorkspace=useBotWorkspaceStore;`
          }))
        }
      }
    ]
  })
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}${bundle.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join(
      "\n"
    )}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script></body></html>`
  const assets = new Map(
    bundle.outputFiles.map((file) => [`/${basename(file.path)}`, file.contents])
  )
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname
    const asset = assets.get(path)
    if (asset) {
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript")
      response.end(asset)
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(html)
  })
  const calls: { method: string; input: unknown }[] = []
  const cases: string[] = []
  const errors: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let release: (() => void) | undefined
  let holdNext = "",
    loseNext = ""
  const started = new Date().toISOString()
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1240, height: 900 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureSnapshot", () => store.snapshot())
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      let result: unknown
      try {
        if (["skills", "availableSkills", "skillTrials", "skillLibrary"].includes(method))
          result = []
        else if (method === "routines") result = await api.routines(input as string)
        else if (method === "saveRoutine")
          result = await api.saveRoutine(input as BotSaveRoutineInput)
        else throw new Error(`Unsupported fixture method: ${method}`)
      } catch (error) {
        result = {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_failure",
            message: error instanceof Error ? error.message : "Fixture failure"
          }
        }
      }
      if (loseNext === method) {
        loseNext = ""
        result = {
          botFailure: { code: "connection_closed", message: "ACK lost after actual SQLite commit" }
        }
      }
      if (holdNext === method) {
        holdNext = ""
        await new Promise<void>((done) => {
          release = done
        })
      }
      return result
    })
    const refresh = () =>
      page.evaluate(() =>
        (window as unknown as InspectorRoutineFixture).fixtureWorkspace.getState().refresh()
      )
    const saves = () =>
      calls
        .filter((call) => call.method === "saveRoutine")
        .map((call) => call.input as BotSaveRoutineInput)
    const listCount = () => calls.filter((call) => call.method === "routines").length
    const control = () => page.getByRole("switch", { name: "启用例程 检查项目", exact: true })
    const closeResource = async () => {
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden" })
      await control().waitFor()
    }
    const check = async (name: string, action: () => Promise<void>) => {
      await action()
      cases.push(name)
      console.log(`PASS ${name}`)
    }
    await page.goto(`http://127.0.0.1:${address.port}`)
    await check(
      "compact real switch and original single-card view; chat edit only prepares a draft for the original owner",
      async () => {
        await control().waitFor()
        assert.equal(await control().getAttribute("aria-checked"), "true")
        await page.evaluate(
          (id) =>
            (window as unknown as InspectorRoutineFixture).fixtureWorkspace.setState({
              selected: id
            }),
          other.conversationId
        )
        const readonlyViewCalls = calls.length
        await page.getByRole("button", { name: "查看例程 检查项目", exact: true }).click()
        await page
          .getByRole("region", { name: "例程详情", exact: true })
          .getByRole("heading", { name: first.name, exact: true })
          .waitFor()
        await page.locator(".bot-routine-card").waitFor()
        assert.equal(await page.locator(".bot-routine-card").count(), 1)
        const coveredReads = listCount()
        await page.evaluate(() => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          for (let i = 0; i < 20; i++)
            s.setState({
              snapshot: { ...s.getState().snapshot, cursor: s.getState().snapshot.cursor + 1 }
            })
        })
        await page.waitForTimeout(2200)
        assert.ok(
          listCount() - coveredReads <= 1,
          "Resources must remain the only routine list reader while it covers Details"
        )
        assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0)
        assert.equal(await page.locator(".bot-routine-form").count(), 0)
        assert.equal(await page.getByRole("dialog").count(), 0)
        assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
        assert.ok(calls.slice(readonlyViewCalls).every(({ method }) => method === "routines"))
        await page.getByRole("button", { name: "返回 Bot 详情", exact: true }).click()
        await control().waitFor()
        await page.getByRole("button", { name: "查看例程 检查项目", exact: true }).click()
        await page
          .getByRole("region", { name: "例程详情", exact: true })
          .getByRole("button", { name: "编辑", exact: true })
          .click()
        await page
          .getByRole("region", { name: "例程详情", exact: true })
          .waitFor({ state: "hidden" })
        const drafts = await page.evaluate(
          () => (window as unknown as InspectorRoutineFixture).fixtureWorkspace.getState().drafts
        )
        assert.match(drafts[own.conversationId].prompt, /检查项目/)
        assert.equal(drafts[other.conversationId], undefined)
        assert.equal(saves().length, 0)
      }
    )
    await check(
      "lost pause ACK reuses the original editor nonce and SQLite receipt instead of resuming",
      async () => {
        loseNext = "saveRoutine"
        await control().click()
        await page.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
        const original = saves()[0]
        assert.equal(original.enabled, false)
        assert.ok(original.nonce)
        assert.equal(original.revision, first.revision)
        assert.deepEqual(original.schedule, first.schedule)
        assert.equal(store.routine(own.bot.id, first.id).revision, first.revision + 1)
        await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
        await page
          .getByRole("heading", { name: "编辑例程", exact: true })
          .waitFor({ state: "hidden" })
        assert.deepEqual(saves()[1], original)
        assert.equal(store.routine(own.bot.id, first.id).revision, first.revision + 1)
        const pending = await page.evaluate(
          (key) => localStorage.getItem(key),
          `bot-routine-pending:${own.bot.id}:${first.id}`
        )
        assert.equal(pending, null)
        await closeResource()
        assert.equal(await control().getAttribute("aria-checked"), "false")
        await control().focus()
        await page.keyboard.press("Space")
        await page.waitForFunction(
          () =>
            document
              .querySelector('[role="switch"][aria-label="启用例程 检查项目"]')
              ?.getAttribute("aria-checked") === "true"
        )
        assert.equal(store.routine(own.bot.id, first.id).revision, first.revision + 2)
        assert.equal(saves().length, 3)
        assert.notEqual(saves()[2].nonce, original.nonce)
      }
    )
    await check("storage failure cannot dispatch an unrecorded switch save", async () => {
      const count = saves().length
      await page.evaluate(() => {
        ;(window as unknown as InspectorRoutineFixture).fixtureStorageDenied = true
      })
      await control().click()
      await page.getByText("无法保留例程保存记录", { exact: false }).waitFor()
      assert.equal(saves().length, count)
      assert.equal(store.routine(own.bot.id, first.id).enabled, true)
      await page.evaluate(() => {
        ;(window as unknown as InspectorRoutineFixture).fixtureStorageDenied = false
      })
    })
    await check(
      "original CAS conflict never retries with the newer revision or overwrites an external edit",
      async () => {
        const current = store.routine(own.bot.id, first.id)
        store.saveRoutine({
          ...current,
          prompt: "另一窗口已修改",
          expectedDataEpoch: store.dataEpoch()
        })
        const count = saves().length
        await control().click()
        await page.getByText("例程已修改", { exact: false }).waitFor()
        assert.equal(saves().length, count + 1)
        assert.equal(saves().at(-1)!.revision, current.revision)
        assert.equal(store.routine(own.bot.id, first.id).prompt, "另一窗口已修改")
        assert.equal(store.routine(own.bot.id, first.id).enabled, true)
        await refresh()
      }
    )
    await check(
      "cursor refresh is bounded and hidden settings retire a delayed list response",
      async () => {
        await page.evaluate(() => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          for (let i = 0; i < 30; i++)
            s.setState({
              snapshot: { ...s.getState().snapshot, cursor: s.getState().snapshot.cursor + 1 }
            })
        })
        const before = listCount()
        await page.waitForTimeout(2200)
        assert.ok(listCount() - before <= 1, `duplicate reads: ${listCount() - before}`)
        const beforeHold = store.routine(own.bot.id, first.id)
        store.saveRoutine({ ...beforeHold, enabled: false, expectedDataEpoch: store.dataEpoch() })
        holdNext = "routines"
        await page.evaluate(() => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          s.setState({
            snapshot: { ...s.getState().snapshot, cursor: s.getState().snapshot.cursor + 1 }
          })
        })
        await page.waitForFunction(
          () => !(window as unknown as InspectorRoutineFixture).fixtureStorageDenied
        )
        for (let i = 0; !release && i < 60; i++) await new Promise((done) => setTimeout(done, 50))
        assert.ok(release, "actual list response was held")
        await page.evaluate(() =>
          (window as unknown as InspectorRoutineFixture).fixtureSettings(true)
        )
        const current = store.routine(own.bot.id, first.id)
        store.saveRoutine({
          ...current,
          prompt: "隐藏期间的新内容",
          enabled: false,
          expectedDataEpoch: store.dataEpoch()
        })
        const heldCount = listCount()
        release()
        release = undefined
        await page.evaluate(() => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          s.setState({
            snapshot: { ...s.getState().snapshot, cursor: s.getState().snapshot.cursor + 10 }
          })
        })
        await page.waitForTimeout(2200)
        assert.equal(listCount(), heldCount)
        assert.equal(
          await control().getAttribute("aria-checked"),
          "true",
          "held false response cannot replace the visible true state after its authority retires"
        )
        await page.evaluate(() =>
          (window as unknown as InspectorRoutineFixture).fixtureSettings(false)
        )
        await page.waitForFunction(
          () =>
            document
              .querySelector('[role="switch"][aria-label="启用例程 检查项目"]')
              ?.getAttribute("aria-checked") === "false"
        )
      }
    )
    await check(
      "delayed committed ACK cannot clear its original request after a controlled workspace epoch replacement",
      async () => {
        holdNext = "saveRoutine"
        await control().click()
        for (let i = 0; !release && i < 60; i++) await new Promise((done) => setTimeout(done, 50))
        assert.ok(release)
        const original = saves().at(-1)!
        await page.evaluate(() => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          s.setState({ snapshot: { ...s.getState().snapshot, dataEpoch: "replacement" } })
        })
        release()
        release = undefined
        await page.waitForTimeout(100)
        const raw = await page.evaluate(
          (key) => localStorage.getItem(key),
          `bot-routine-pending:${own.bot.id}:${first.id}`
        )
        assert.ok(raw)
        assert.deepEqual(JSON.parse(raw).input, original)
        assert.equal(JSON.parse(raw).dataEpoch, "initial")
        await page.evaluate((epoch) => {
          const s = (window as unknown as InspectorRoutineFixture).fixtureWorkspace
          s.setState({ snapshot: { ...s.getState().snapshot, dataEpoch: epoch } })
        }, store.dataEpoch())
        await control().waitFor()
        const count = saves().length
        await control().click()
        await page.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
        assert.equal(saves().length, count)
        await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
        assert.deepEqual(saves().at(-1), original)
        await page
          .getByRole("heading", { name: "编辑例程", exact: true })
          .waitFor({ state: "hidden" })
        await closeResource()
      }
    )
    await page.evaluate(() =>
      (window as unknown as InspectorRoutineFixture).fixtureTheme("codex-dark")
    )
    await page.screenshot({ path: join(output, "routines-dark.png") })
    await page.evaluate(() =>
      (window as unknown as InspectorRoutineFixture).fixtureTheme("codex-light")
    )
    await page.screenshot({ path: join(output, "routines-light.png") })
    await check(
      "a disappeared original routine recovers only its retained save receipt without recreating a card",
      async () => {
        holdNext = "saveRoutine"
        loseNext = "saveRoutine"
        const count = saves().length
        await control().click()
        for (let i = 0; !release && i < 60; i++) await new Promise((done) => setTimeout(done, 50))
        assert.ok(release)
        const original = saves().at(-1)!
        const accepted = store.routine(own.bot.id, first.id)
        store.deleteRoutine({
          botId: own.bot.id,
          id: first.id,
          revision: accepted.revision,
          nonce: "remove-original-after-save"
        })
        release()
        release = undefined
        await page.getByRole("heading", { name: "核对原例程", exact: true }).waitFor()
        await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
        await page
          .getByRole("heading", { name: "核对原例程", exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(saves().length, count + 2)
        assert.deepEqual(saves().at(-1), original)
        assert.equal(store.routines(own.bot.id).filter((item) => item.id === first.id).length, 0)
        assert.equal(
          await page.evaluate(
            (key) => localStorage.getItem(key),
            `bot-routine-pending:${own.bot.id}:${first.id}`
          ),
          null
        )
        await page.keyboard.press("Escape")
        await page.getByRole("dialog").waitFor({ state: "hidden" })
      }
    )
    await check("paused weekly plan stays read-only in the original detail view", async () => {
      type Theme = Pick<InspectorRoutineFixture, "fixtureTheme">
      const weekly = store.saveRoutine({
        botId: own.bot.id,
        name: "周日中午检查",
        prompt: "核对每周保存的项目计划",
        enabled: false,
        schedule: { kind: "cron", expression: "0 12 * * 0" },
        timezone: "Asia/Shanghai"
      })
      const before = calls.length,
        runs = store.snapshot().runs
      const viewport = page.viewportSize()!
      const theme = (await page.locator("html").getAttribute("data-theme")) ?? "codex-light"
      await refresh()
      const row = page.getByRole("button", { name: `查看例程 ${weekly.name}`, exact: true })
      const control = page.getByRole("switch", { name: `启用例程 ${weekly.name}`, exact: true })
      assert.equal(await control.getAttribute("aria-checked"), "false")
      await row.click()
      const card = page.locator(`#bot-routine-${weekly.id}`)
      try {
        await card.waitFor()
        const planText = await card.locator("small").innerText()
        await writeFile(
          join(output, "routine-paused-weekly-card.json"),
          JSON.stringify(
            { routine: weekly, html: await card.evaluate((node) => node.outerHTML), planText },
            null,
            2
          )
        )
        assert.equal(planText, "每星期日 12:00\nAsia/Shanghai")
        assert.equal(await page.locator(".bot-routine-card").count(), 1)
        assert.equal(await card.getByText("已暂停", { exact: true }).count(), 1)
        assert.equal(await card.getByText("Asia/Shanghai", { exact: true }).count(), 1)
        for (const [index, width] of [viewport.width, viewport.width, 390].entries()) {
          const mode = index === 0 ? "codex-dark" : "codex-light"
          await page.evaluate((mode) => (window as unknown as Theme).fixtureTheme(mode), mode)
          await page.setViewportSize({ width, height: viewport.height })
          await page.waitForFunction((mode) => {
            const dialog = document.querySelector<HTMLElement>(
              '[data-testid="bot-routine-detail"][role=region]'
            )
            const workspace = document.querySelector<HTMLElement>(".bot-workspace")
            return (
              document.documentElement.dataset.theme === mode &&
              dialog &&
              workspace &&
              getComputedStyle(dialog).backgroundColor ===
                getComputedStyle(workspace).backgroundColor &&
              getComputedStyle(dialog).opacity === "1"
            )
          }, mode)
          const palette = await card.evaluate((element) => {
            const dialog = element.closest<HTMLElement>(
              '[data-testid="bot-routine-detail"][role=region]'
            )!
            const workspace = document.querySelector<HTMLElement>(".bot-workspace")!
            const background = getComputedStyle(dialog).backgroundColor
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const context = canvas.getContext("2d")!
            const nodes = [
              dialog.querySelector("h2"),
              ...["h3", "p.my-3", "small", "small span"].map((selector) =>
                element.querySelector(selector)
              )
            ]
            return {
              theme: document.documentElement.dataset.theme,
              background,
              workspaceBackground: getComputedStyle(workspace).backgroundColor,
              opacity: getComputedStyle(dialog).opacity,
              transitionProperty: getComputedStyle(dialog).transitionProperty,
              transitionDuration: getComputedStyle(dialog).transitionDuration,
              text: nodes.map((node) => {
                if (!node) throw new Error("Routine detail readability target is missing")
                const color = getComputedStyle(node).color
                const [base, foreground] = [background, color].map((paint) => {
                  context.clearRect(0, 0, 1, 1)
                  context.fillStyle = background
                  context.fillRect(0, 0, 1, 1)
                  context.fillStyle = paint
                  context.fillRect(0, 0, 1, 1)
                  const channels = [...context.getImageData(0, 0, 1, 1).data]
                    .slice(0, 3)
                    .map((value) => {
                      const channel = value / 255
                      return channel <= 0.04045
                        ? channel / 12.92
                        : ((channel + 0.055) / 1.055) ** 2.4
                    })
                  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
                })
                return {
                  text: node.textContent,
                  color,
                  contrast:
                    (Math.max(base, foreground) + 0.05) / (Math.min(base, foreground) + 0.05)
                }
              })
            }
          })
          await writeFile(
            join(output, `routine-paused-weekly-${mode}-${width}-palette.json`),
            JSON.stringify(palette, null, 2)
          )
          assert.equal(palette.theme, mode)
          assert.equal(palette.background, palette.workspaceBackground)
          assert.equal(palette.opacity, "1")
          const detail = page.getByRole("region", { name: "例程详情", exact: true })
          assert.equal(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
          const detailBounds = (await detail.boundingBox())!
          for (const name of ["返回 Bot 详情", "关闭例程详情面板", "恢复", "编辑", "删除"]) {
            const action = detail.getByRole("button", { name, exact: true })
            await action.scrollIntoViewIfNeeded()
            const bounds = (await action.boundingBox())!
            assert.ok(
              bounds.x >= detailBounds.x &&
                bounds.x + bounds.width <= detailBounds.x + detailBounds.width
            )
            assert.ok(
              bounds.y >= detailBounds.y &&
                bounds.y + bounds.height <= detailBounds.y + detailBounds.height
            )
          }
          assert.ok(
            palette.text.every(({ contrast }) => contrast >= 4.5),
            JSON.stringify(palette)
          )
          assert.equal(await card.locator("small").innerText(), "每星期日 12:00\nAsia/Shanghai")
          await page.screenshot({
            path: join(output, `routine-paused-weekly-${mode}-${width}.png`)
          })
        }
      } finally {
        await page.keyboard.press("Escape")
        await page
          .getByRole("region", { name: "例程详情", exact: true })
          .waitFor({ state: "hidden" })
        await page.setViewportSize(viewport)
        await page.evaluate((mode) => (window as unknown as Theme).fixtureTheme(mode), theme)
      }
      await row.waitFor()
      const reads = /^(routines|skills|availableSkills|skillTrials|skillLibrary)$/
      assert.ok(calls.slice(before).every((call) => reads.test(call.method)))
      assert.deepEqual(store.routine(own.bot.id, weekly.id), weekly)
      assert.deepEqual(store.snapshot().runs, runs)
    })
    await check(
      "an exhausted one-shot opens its time editor without changing the chat draft or replaying a task",
      async () => {
        const once = store.saveRoutine({
          botId: own.bot.id,
          name: "已结束的一次任务",
          prompt: "ONLY_THE_SYNTHETIC_MARKER",
          enabled: true,
          schedule: { kind: "once", at: Date.now() + 100 },
          timezone: "Asia/Shanghai"
        })
        await delay(150)
        store.dispatchDueRoutines()
        const original = store.routine(own.bot.id, once.id)
        assert.equal(original.enabled, false)
        assert.equal(original.desiredEnabled, true)
        assert.equal(original.nextAt, null)
        await refresh()
        const control = page.getByRole("switch", {
          name: "重新安排例程 已结束的一次任务",
          exact: true
        })
        await control.waitFor()
        const beforeDrafts = await page.evaluate(
          () => (window as unknown as InspectorRoutineFixture).fixtureWorkspace.getState().drafts
        )
        const beforeSaves = saves().length
        const beforeRuns = store.snapshot().runs
        await control.click()
        const editor = page
          .getByRole("dialog")
          .filter({ has: page.getByRole("heading", { name: "编辑例程", exact: true }) })
        await editor.waitFor()
        await editor.getByLabel("运行时间", { exact: true }).waitFor()
        assert.deepEqual(
          await page.evaluate(
            () => (window as unknown as InspectorRoutineFixture).fixtureWorkspace.getState().drafts
          ),
          beforeDrafts
        )
        await editor.getByRole("button", { name: "取消", exact: true }).click()
        await editor.waitFor({ state: "hidden" })
        assert.equal(saves().length, beforeSaves)
        assert.deepEqual(store.routine(own.bot.id, once.id), original)
        assert.deepEqual(store.snapshot().runs, beforeRuns)
        await page.keyboard.press("Escape")
        await page.getByRole("dialog").waitFor({ state: "hidden" })
        await control.waitFor()
      }
    )
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(
        {
          started,
          ended: new Date().toISOString(),
          source,
          database: join(directory, "bots.sqlite"),
          cases,
          failures: [],
          saves: saves(),
          readCalls: listCount(),
          pageErrors: errors,
          scope:
            "Actual Chrome/React/SQLite/RPC; controlled workspace facade, no Electron/backup/platform shell claim"
        },
        null,
        2
      )
    )
  } catch (error) {
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(
        {
          started,
          ended: new Date().toISOString(),
          source,
          database: join(directory, "bots.sqlite"),
          cases,
          failures: [error instanceof Error ? error.message : String(error)],
          calls,
          pageErrors: errors
        },
        null,
        2
      )
    )
    throw error
  } finally {
    release?.()
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
