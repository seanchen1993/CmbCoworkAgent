/** Actual React/Radix in Chrome against controlled local callbacks and SQLite
 * receipts. No model, Electron App or Bot Host is started. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type {
  BotRunRoutineInput,
  BotSaveRoutineInput,
  BotDeleteRoutineInput,
  BotRoutineHistoryRequest
} from "../src/shared/bot-routines"
import { BotStore } from "../src/main/bots/store"
import { highlightWorkerFixture } from "./fixtures/highlight-worker"

async function main() {
  const root = process.cwd(),
    renderer = join(root, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-routine-menu-fixture-"))
  const store = new BotStore(join(directory, "bots.sqlite"))
  const owner = store.createBot({ nonce: "menu-owner", name: "Menu Bot" })
  const routine = store.saveRoutine(
    {
      nonce: "menu-routine",
      botId: owner.bot.id,
      name: "检查项目",
      prompt: "检查合成证据",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "interval", everyMs: 60000, anchor: Date.now() }
    },
    { kind: "human" }
  )
  const setup = store.saveRoutine({
    nonce: "setup",
    botId: owner.bot.id,
    name: "待设置例程",
    prompt: "合成设置",
    enabled: false,
    timezone: "UTC",
    schedule: { kind: "event", topic: "fixture.ready" }
  })
  const mainRoutine = store.saveRoutine({
    nonce: "main",
    botId: owner.bot.id,
    name: "Main 跟进",
    prompt: "合成跟进",
    enabled: false,
    timezone: "UTC",
    schedule: { kind: "interval", everyMs: 60000, anchor: Date.now() }
  })
  const snapshot = store.snapshot(),
    epoch = snapshot.dataEpoch
  const primary = {
    revision: 1,
    botId: owner.bot.id,
    dataEpoch: epoch,
    checkInRevision: 1,
    checkIn: {
      revision: 1,
      botId: owner.bot.id,
      enabled: false,
      prompt: "合成跟进",
      targetBotIds: [owner.bot.id],
      everyMs: 60000,
      timezone: "UTC",
      routineId: mainRoutine.id
    }
  }
  const capabilities = [
    "routine-management",
    "routine-editor",
    "routine-readiness-state",
    "routine-run-version",
    "mutation-data-epoch-v2",
    "routine-history"
  ]
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
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';
import{BotRoutineSummary}from'./src/renderer/src/components/bots/BotRoutineSummary';import{BotRoutineCard}from'./src/renderer/src/components/bots/BotRoutineCard';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';
applyThemePreference('codex-dark');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};window.fixtureActions={toggle:0,edit:0,remove:0,history:0,view:0};window.fixtureTheme=applyThemePreference;
function App(){const[resource,setResource]=useState(null),[key,setKey]=useState(0),[busy,setBusy]=useState(false);window.fixtureBusy=setBusy;window.fixtureRemount=()=>setKey(v=>v+1);const state=useBotWorkspaceStore();const r=${JSON.stringify(routine)};return <main className='bot-workspace min-h-screen bg-background p-8 text-foreground'><section aria-label='例程摘要'><BotRoutineSummary key={'summary'+key+state.snapshot.dataEpoch} botId='${owner.bot.id}' dataEpoch={state.snapshot.dataEpoch} active={!resource} manage={()=>setResource({mode:'view',dataEpoch:state.snapshot.dataEpoch})} open={setResource}/></section><section aria-label='列表例程' className='mt-10'><BotRoutineCard key={'card'+key+state.snapshot.dataEpoch} routine={r} dataEpoch={state.snapshot.dataEpoch} readinessSupport busy={busy} toggle={()=>window.fixtureActions.toggle++} editInChat={()=>window.fixtureActions.edit++} remove={()=>window.fixtureActions.remove++} history={()=>window.fixtureActions.history++}/></section><button id='outside' type='button'>外部焦点</button><div id='bot-composer-${owner.conversationId}' contentEditable suppressContentEditableWarning>{state.drafts['${owner.conversationId}']?.prompt??''}</div>{resource&&<BotResources bot={${JSON.stringify(owner.bot)}} tab='routines' routineIntent={resource} close={()=>setResource(null)}/>}<Toaster/></main>};createRoot(document.getElementById('root')).render(<App/>);`
    },
    outfile: join(directory, "ui.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      await highlightWorkerFixture(renderer),
      {
        name: "controlled-outer-workspace",
        setup(context) {
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
            resolveDir: root,
            contents:
              path === "app"
                ? `import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false}));`
                : `import{create}from'zustand';export const useBotWorkspaceStore=create((set,get)=>({snapshot:${JSON.stringify({ ...snapshot, primaryBot: primary })},host:{hostId:'fixture',capabilities:${JSON.stringify(capabilities)}},selected:'${owner.conversationId}',drafts:{},trackedWork:{},refresh:async()=>set({snapshot:await window.fixtureSnapshot()}),select:selected=>set({selected}),updateDraft:(id,change)=>set(state=>({drafts:{...state.drafts,[id]:{...state.drafts[id],...change,revision:crypto.randomUUID()}}}))}));window.fixtureWorkspace=useBotWorkspaceStore;`
          }))
        }
      }
    ]
  })
  const script = bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}${bundle.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n")}</style><body><div id="root"></div><script>${script}</script></body></html>`
  const server = createServer((_, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end(html)
  })
  const calls: { method: string; input: unknown }[] = [],
    cases: string[] = [],
    errors: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let lastPage: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined
  let releaseFirstRun: (() => void) | undefined
  let loseRun = true
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    lastPage = page
    page.setDefaultTimeout(7000)
    page.on("pageerror", (e) => errors.push(e.message))
    await page.exposeFunction("fixtureSnapshot", () => ({
      ...store.snapshot(),
      primaryBot: primary
    }))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        if (method === "routines")
          return store
            .routines(input)
            .map((r) =>
              r.id === setup.id
                ? { ...r, effectiveState: "needs_setup", skillIssue: "合成绑定待核对" }
                : r
            )
        if (["skills", "availableSkills", "skillTrials", "skillLibrary"].includes(method)) return []
        if (method === "saveRoutine")
          return store.saveRoutine(input as BotSaveRoutineInput, { kind: "human" })
        if (method === "deleteRoutine") return store.deleteRoutine(input as BotDeleteRoutineInput)
        if (method === "runRoutine") {
          const value = store.runRoutine(input as BotRunRoutineInput)
          if (loseRun) {
            await new Promise<void>((done) => {
              releaseFirstRun = done
            })
            releaseFirstRun = undefined
            loseRun = false
            return {
              botFailure: { code: "connection_closed", message: "lost receipt after owned commit" }
            }
          }
          return value
        }
        if (method === "routineHistory")
          return store.routineHistory(input as BotRoutineHistoryRequest)
        throw Error(`Unexpected callback ${method}`)
      } catch (error) {
        return {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_failure",
            message: error instanceof Error ? error.message : "fixture error"
          }
        }
      }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const summary = page.getByRole("region", { name: "例程摘要" }),
      card = page.getByRole("region", { name: "列表例程" })
    await summary.getByRole("button", { name: "查看例程 检查项目", exact: true }).waitFor()
    const runCalls = () => calls.filter((c) => c.method === "runRoutine")
    await card.getByText("检查项目", { exact: true }).click()
    assert.equal(runCalls().length, 0)
    await card.getByText("检查项目", { exact: true }).click({ button: "right" })
    let menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    await menu.waitFor()
    assert.equal(runCalls().length, 0)
    await menu.getByRole("menuitem", { name: "对话调整", exact: true }).click()
    await page.waitForFunction(() => window.fixtureActions.edit === 1)
    assert.equal(runCalls().length, 0)
    cases.push("Card right click and shared edit callback never start Test")
    const more = card.getByRole("button", { name: "例程 检查项目 的更多操作" })
    await more.click()
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作", exact: true })
    await menu.waitFor()
    await menu.getByRole("menuitem", { name: "暂停", exact: true }).click()
    await page.waitForFunction(() => window.fixtureActions.toggle === 1)
    await menu.waitFor({ state: "detached" })
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    cases.push("Accessible dropdown uses the exact same toggle owner callback")
    const row = card.locator(".bot-routine-card")
    await row.focus()
    await row.press("Shift+F10")
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    await menu.waitFor()
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      (id) => document.activeElement?.id === id,
      `bot-routine-${routine.id}`
    )
    assert.ok(await row.evaluate((el) => el === document.activeElement))
    cases.push("Shift+F10 opens context menu and Escape restores row focus")
    await row.focus()
    await row.press("ContextMenu")
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    await menu.waitFor()
    await menu.getByRole("menuitem", { name: "运行一次", exact: true }).click()
    await card.getByRole("button", { name: "确认中…", exact: true }).waitFor()
    assert.ok(await card.getByRole("button", { name: "确认中…", exact: true }).isDisabled())
    await row.click({ button: "right" })
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    assert.equal(
      await menu
        .getByRole("menuitem", { name: "确认中…", exact: true })
        .getAttribute("data-disabled"),
      ""
    )
    assert.equal(runCalls().length, 1)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "detached" })
    assert.ok(releaseFirstRun)
    releaseFirstRun()
    await card.getByText("尚未确认运行状态。重试将核对同一次请求。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(runCalls().length, 1)
    const first = runCalls()[0].input as BotRunRoutineInput
    assert.equal(first.id, routine.id)
    assert.equal(first.revision, routine.revision)
    assert.equal(first.expectedDataEpoch, epoch)
    assert.ok(first.nonce)
    await row.click({ button: "right" })
    await page
      .getByRole("menu", { name: "例程 检查项目 的操作" })
      .getByRole("menuitem", { name: "核对并重试" })
      .click()
    await page.waitForFunction(() => window.fixtureWorkspace.getState().snapshot.runs.length === 1)
    assert.equal(runCalls().length, 2)
    assert.deepEqual(runCalls()[1].input, first)
    assert.equal(store.snapshot().runs.length, 1)
    cases.push(
      "Single Test selection uses same persistent controller as inline button; ACK lost retry keeps nonce/revision/epoch"
    )
    const active = store.snapshot().runs[0]
    store.cancel(active.id)
    await page.evaluate(() => window.fixtureWorkspace.getState().refresh())
    await summary
      .getByRole("button", { name: "查看例程 待设置例程", exact: true })
      .click({ button: "right" })
    menu = page.getByRole("menu", { name: "例程 待设置例程 的操作" })
    assert.equal(
      await menu.getByRole("menuitem", { name: "运行一次" }).getAttribute("data-disabled"),
      ""
    )
    await menu.getByRole("menuitem", { name: "核对设置" }).click()
    await page.getByRole("dialog", { name: /例程/ }).waitFor()
    await page.keyboard.press("Escape")
    cases.push("needs_setup disables Test and retains setup owner path")
    await summary
      .getByRole("button", { name: "查看例程 Main 跟进", exact: true })
      .click({ button: "right" })
    menu = page.getByRole("menu", { name: "例程 Main 跟进 的操作" })
    assert.equal(await menu.getByRole("menuitem", { name: "运行一次" }).count(), 0)
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "detached" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "查看例程 Main 跟进"
    )
    await summary.getByRole("button", { name: "查看例程 Main 跟进", exact: true }).click()
    const mainDialog = page.getByRole("dialog", { name: "例程详情", exact: true })
    await mainDialog.waitFor()
    assert.equal(
      await mainDialog
        .locator(`#bot-routine-${mainRoutine.id}`)
        .getByRole("button", { name: "运行一次", exact: true })
        .count(),
      0
    )
    await page.keyboard.press("Escape")
    await mainDialog.waitFor({ state: "detached" })
    await summary.getByRole("button", { name: "查看例程 检查项目", exact: true }).waitFor()
    cases.push("Managed Main has no fresh manual Test in menu or original card")
    await summary.getByRole("button", { name: "查看例程 检查项目", exact: true }).focus()
    await page.keyboard.press("Shift+F10")
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    await menu.getByRole("menuitem", { name: "对话调整" }).click()
    await page.waitForFunction(() =>
      window.fixtureWorkspace
        .getState()
        .drafts[window.fixtureWorkspace.getState().selected]?.prompt.includes("请修改例程")
    )
    assert.ok(
      (await page.locator(`#bot-composer-${owner.conversationId}`).innerText()).includes(
        routine.name
      )
    )
    cases.push("Summary keyboard Edit reuses Resources natural-language draft without sending")
    assert.equal(runCalls().length, 2)
    await summary
      .getByRole("button", { name: "查看例程 检查项目", exact: true })
      .click({ button: "right" })
    await page
      .getByRole("menu", { name: "例程 检查项目 的操作" })
      .getByRole("menuitem", { name: "删除例程" })
      .click()
    const dialog = page.getByRole("dialog", { name: `删除例程「${routine.name}」？` })
    await dialog.waitFor()
    assert.equal(calls.filter((c) => c.method === "deleteRoutine").length, 0)
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      (id) => !document.querySelector(`[aria-label="查看例程 ${id}"]`),
      routine.name
    )
    assert.equal(calls.filter((c) => c.method === "deleteRoutine").length, 1)
    assert.ok(!store.routines(owner.bot.id).some((r) => r.id === routine.id))
    cases.push(
      "Summary Delete opens original confirmation; only explicit confirm mutates exact revision"
    )
    await page.evaluate(() => window.fixtureBusy(true))
    await card.getByText("检查项目", { exact: true }).click({ button: "right" })
    menu = page.getByRole("menu", { name: "例程 检查项目 的操作" })
    for (const item of await menu.getByRole("menuitem").all())
      assert.equal(await item.getAttribute("data-disabled"), "")
    await page.keyboard.press("Escape")
    cases.push("Busy Card disables all shared menu actions")
    assert.deepEqual(errors, [])
    await writeFile(
      join(directory, "result.safe.json"),
      JSON.stringify(
        {
          cases,
          passed: cases.length,
          pageErrors: errors,
          modelOrHostStarted: false,
          runCallbackCount: runCalls().length
        },
        null,
        2
      ) + "\n"
    )
    process.stdout.write(
      JSON.stringify({ directory, cases, passed: cases.length, modelOrHostStarted: false }) + "\n"
    )
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        pageErrors: errors,
        cases,
        browser: await lastPage?.evaluate(() => ({
          text: document.body.innerText.slice(0, 5000),
          menus: Array.from(document.querySelectorAll("[role=menu]")).map((el) =>
            el.outerHTML.slice(0, 1500)
          ),
          triggers: Array.from(document.querySelectorAll("button[aria-haspopup=menu]")).map(
            (el) => ({
              name: el.getAttribute("aria-label"),
              state: el.getAttribute("data-state"),
              expanded: el.getAttribute("aria-expanded")
            })
          )
        }))
      }) + "\n"
    )
    throw error
  } finally {
    releaseFirstRun?.()
    await browser?.close()
    await new Promise<void>((done) => server.close(() => done()))
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
