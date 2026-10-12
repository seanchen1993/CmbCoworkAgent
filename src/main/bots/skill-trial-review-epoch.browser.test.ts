import { afterAll, beforeAll, expect, it } from "vitest"
import { copyFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { chromium, type Browser } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { serializeBotFailure } from "./error-diagnostic"
import { BotDomainError, BOT_PROTOCOL_VERSION } from "../../shared/bot-types"
import type { CoworkBotAPI } from "../../shared/bot-api"

const enabled = process.env.CMB_SKILL_TRIAL_REVIEW_UI_TEST === "1"
let browser: Browser | undefined,
  javascript = "",
  cssText = ""
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src"),
    css = await compile(
      (await readFile(join(renderer, "index.css"), "utf8")).replace(
        /^@import "@fontsource[^\n]+\n/gm,
        ""
      ),
      { base: renderer, onDependency: () => {} }
    ),
    scanner = new Scanner({
      sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
    })
  cssText = css.build(scanner.scan())
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotSkillCard}from'./src/renderer/src/components/bots/BotSkillCard';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';applyThemePreference('codex-light');window.fixtureReplyCount=0;window.api={bots:new Proxy({},{get:(_,method)=>async(input)=>{try{return await window.fixtureRpc(method,input)}finally{window.fixtureReplyCount++}}})};let mount,observe,hide;function Fixture(){const[view,setView]=useState(null),[generation,setGeneration]=useState(0),[shown,setShown]=useState(true);mount=(next)=>{useBotWorkspaceStore.setState({host:next.host,snapshot:next.snapshot});setView(next);setGeneration(value=>value+1);setShown(true)};observe=(next)=>useBotWorkspaceStore.setState({host:next.host,snapshot:next.snapshot});hide=()=>setShown(false);const reload=async()=>{await window.fixtureReload();const next=await window.fixtureView();setView(next)};return <main className="mx-auto max-w-3xl p-8 text-foreground">{view&&shown&&<BotSkillCard key={generation} skill={view.skill} trials={view.trials} reload={reload}/>}</main>}window.fixture={mount:(next)=>mount(next),observe:(next)=>observe(next),hide:()=>hide()};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      loader: "tsx",
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  javascript = bundle.outputFiles[0].text
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
})
afterAll(async () => browser?.close())

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-trial-review-ui-")),
    database = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite")
  let store = new BotStore(database),
    host: BotHost,
    server: BotRpcServer,
    client: BotTransportClient
  const { bot } = store.createBot({ nonce: "owner", name: "对账助手" }),
    skill = store.saveSkill({
      botId: bot.id,
      name: "核对实际产物",
      instructions: "读取订单编号，核对产物并返回证据。",
      enabled: true
    }),
    trial = store.trialSkill({
      nonce: "trial",
      botId: bot.id,
      skillId: skill.id,
      version: skill.version,
      inputs: "ORDER-002",
      criteria: "产物包含 ORDER-002 并附原始证据"
    }),
    claim = store.claim("fixture")!
  store.finish(claim.lease, "succeeded", "ORDER-002 已核对，证据完整")
  store.close()
  copyFileSync(database, point)
  store = new BotStore(database)
  const connect = async () => {
    host = new BotHost(store)
    const token = randomBytes(32).toString("hex"),
      socket =
        process.platform === "win32"
          ? `\\\\.\\pipe\\cmb-trial-ui-${token.slice(0, 16)}`
          : join(directory, `rpc-${token.slice(0, 8)}.sock`)
    server = new BotRpcServer(host, token)
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
  }
  await connect()
  const view = async () => ({
    host: await client.call("status"),
    snapshot: await client.call("snapshot"),
    skill: store.skills(bot.id)[0],
    trials: await client.call("skillTrials", bot.id)
  })
  const state = () => ({
    trials: store.skillTrials(bot.id),
    skills: store.skills(bot.id),
    events: store.db.exec("SELECT * FROM bot_events"),
    runs: store.db.exec("SELECT * FROM bot_runs"),
    receipts: store.db.exec("SELECT * FROM bot_receipts")
  })
  const restore = async () => {
    client.close()
    await server.close()
    await host.stop()
    store.close()
    copyFileSync(point, database)
    const ledger = new BotDeletionLedger(database)
    try {
      fenceBotCheckpointDatabase(database, "replacement", ledger)
    } finally {
      ledger.close()
    }
    store = new BotStore(database)
    await connect()
  }
  return {
    bot,
    skill,
    trial,
    view,
    state,
    restore,
    get store() {
      return store
    },
    call: (input: Parameters<CoworkBotAPI["reviewSkillTrial"]>[0]) =>
      client.call("reviewSkillTrial", input),
    close: async () => {
      client.close()
      await server.close()
      await host.stop()
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

it.skipIf(!enabled).each(["stale", "current", "observed", "legacy", "lost", "late"] as const)(
  "keeps the real skill verdict and scope through React, SQLite and authenticated replacement RPC: %s",
  async (scenario) => {
    const f = await fixture(),
      page = await browser!.newPage({ viewport: { width: 1080, height: 840 } }),
      requests: Parameters<CoworkBotAPI["reviewSkillTrial"]>[0][] = [],
      errors: string[] = []
    let reloads = 0,
      lost = scenario === "lost",
      reply!: () => void,
      committed = false
    const held = new Promise<void>((resolve) => (reply = resolve))
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.exposeFunction("fixtureRpc", async (method: string, input: unknown) => {
        if (method !== "reviewSkillTrial") throw new Error(`Unexpected fixture RPC: ${method}`)
        const request = input as Parameters<CoworkBotAPI["reviewSkillTrial"]>[0]
        requests.push(request)
        try {
          const result = await f.call(request)
          committed = true
          if (scenario === "late") await held
          if (lost) {
            lost = false
            throw new BotDomainError("host_disconnected", "尚未收到操作结果，请核对原操作")
          }
          return result
        } catch (error) {
          return { botFailure: serializeBotFailure(error) }
        }
      })
      await page.exposeFunction("fixtureReload", () => ++reloads)
      await page.exposeFunction("fixtureView", () => f.view())
      await page.route("http://skill-review.fixture/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><div id="root"></div>'
        })
      )
      await page.goto("http://skill-review.fixture/")
      await page.addStyleTag({ content: cssText })
      await page.addScriptTag({ content: javascript })
      if (scenario === "current") await f.restore()
      const view = await f.view()
      if (scenario === "legacy")
        view.host.capabilities = view.host.capabilities?.filter(
          (capability) => capability !== "skill-trial-review-epoch"
        )
      await page.evaluate((view) => Reflect.get(window, "fixture").mount(view), view)
      await page.getByText("试跑记录 · 1", { exact: true }).click()
      await page.getByText("版本 1 · 等待验收", { exact: true }).click()
      await page.getByLabel("试跑验收依据", { exact: true }).fill("已比对 ORDER-002 与原始证据")
      const passed = page.getByRole("button", { name: "通过", exact: true }),
        failed = page.getByRole("button", { name: "需修订", exact: true })
      if (["stale", "observed"].includes(scenario)) await f.restore()
      const before = f.state()
      if (scenario === "observed")
        await page.evaluate((view) => Reflect.get(window, "fixture").observe(view), await f.view())
      if (scenario === "legacy" || scenario === "observed") {
        await expect.poll(() => passed.isDisabled()).toBe(true)
        expect(await failed.isDisabled()).toBe(true)
        expect(requests).toEqual([])
        expect(f.state()).toEqual(before)
        expect(reloads).toBe(0)
      } else {
        await passed.click()
        if (scenario === "stale") {
          await page.getByRole("alert").filter({ hasText: "工作区数据已恢复" }).waitFor()
          expect(requests).toHaveLength(1)
          expect(requests[0].expectedDataEpoch).toBe("initial")
          expect(f.state()).toEqual(before)
          expect(reloads).toBe(0)
          expect(await passed.isDisabled()).toBe(true)
          expect(await failed.isDisabled()).toBe(true)
        } else if (scenario === "late") {
          await expect.poll(() => committed).toBe(true)
          await page.evaluate(() => Reflect.get(window, "fixture").hide())
          await f.restore()
          await page.evaluate(
            (view) => Reflect.get(window, "fixture").observe(view),
            await f.view()
          )
          const restored = f.state()
          reply()
          await expect
            .poll(() => page.evaluate(() => Reflect.get(window, "fixtureReplyCount")))
            .toBe(1)
          await expect.poll(() => passed.count()).toBe(0)
          expect(reloads).toBe(0)
          expect(f.state()).toEqual(restored)
          expect(f.store.skillTrials(f.bot.id)[0].verdict).toBe("pending")
          expect(f.store.skills(f.bot.id)[0].verified).toBe(false)
        } else {
          if (scenario === "lost") {
            await page.getByRole("alert").filter({ hasText: "尚未收到操作结果" }).waitFor()
            expect(f.store.skillTrials(f.bot.id)[0].verdict).toBe("passed")
            const committedState = f.state()
            await passed.click()
            await page.getByText("版本 1 · 试跑通过", { exact: true }).waitFor()
            expect(requests).toHaveLength(2)
            expect(requests[1]).toEqual(requests[0])
            expect(f.state()).toEqual(committedState)
          } else {
            await page.getByText("版本 1 · 试跑通过", { exact: true }).waitFor()
            expect(requests).toHaveLength(1)
            expect(requests[0].expectedDataEpoch).toBe("replacement")
          }
          expect(reloads).toBe(1)
          expect(f.store.skills(f.bot.id)[0].verified).toBe(true)
          expect(f.state().runs).toEqual(before.runs)
          expect(f.state().receipts).toEqual(before.receipts)
        }
      }
      expect(errors).toEqual([])
      expect(f.store.db.exec("PRAGMA foreign_key_check")[0]?.values ?? []).toEqual([])
    } finally {
      reply()
      await page.close()
      await f.close()
    }
  },
  30_000
)
