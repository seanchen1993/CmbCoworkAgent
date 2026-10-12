import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { BotWebhookServer } from "./webhook-server"
import type { BotWebhookChange } from "../../shared/bot-webhooks"

it.skipIf(process.env.CMB_WEBHOOK_UI_TEST !== "1").each(["every-event", "latest-state"])(
  "configures a real %s endpoint, copies its header and recovers a lost rotation without rotating twice",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "cmb-webhook-ui-"))
    const output = resolve("output/bot-webhooks", mode)
    await mkdir(output, { recursive: true })
    const store = new BotStore(join(root, "bots.sqlite"))
    const owner = store.createBot({ nonce: "owner", name: "研发助手" })
    const routine = store.saveRoutine({
      botId: owner.bot.id,
      name: "构建事件核验",
      prompt: "核对构建状态与失败证据",
      timezone: "UTC",
      enabled: true,
      schedule: { kind: "event", topic: "build.finished" }
    })
    const host = new BotHost(store)
    host.webhooks = new BotWebhookServer(store, () => {})
    await host.webhooks.start()
    const api = createBotAPI(host)
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const context = await browser.newContext({
      viewport: { width: 1160, height: 940 },
      permissions: ["clipboard-read", "clipboard-write"]
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const requests: BotWebhookChange[] = []
    try {
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
      const workspaceCss = await readFile(
        join(renderer, "components/bots/bot-workspace.css"),
        "utf8"
      )
      const bundle = await build({
        stdin: {
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>(input)=>window.apiCall(method,input)})};useBotWorkspaceStore.setState({host:${JSON.stringify(await api.status())},snapshot:${JSON.stringify(store.snapshot())}});function Fixture(){const[open,setOpen]=useState(false);return <main className="p-8 text-foreground"><h1 className="text-xl font-medium">项目例程</h1><button onClick={()=>setOpen(true)}>打开例程</button>{open&&<BotResources bot={${JSON.stringify(owner.bot)}} tab="routines" close={()=>setOpen(false)}/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
          loader: "tsx",
          resolveDir: process.cwd()
        },
        bundle: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(root, "ui.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
      })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const allowed = new Set([
        "routines",
        "skills",
        "availableSkills",
        "webhook",
        "changeWebhook",
        "restartWebhook",
        "saveRoutine"
      ])
      await page.exposeFunction("apiCall", async (method: string, input: unknown) => {
        if (!allowed.has(method)) throw new Error(`Unexpected UI method: ${method}`)
        if (method === "changeWebhook") requests.push(input as BotWebhookChange)
        const result = await (
          api[method as keyof typeof api] as (input: unknown) => Promise<unknown>
        )(input)
        if (method === "changeWebhook" && requests.length === 2)
          throw new Error("Fixture: rotation acknowledgement lost")
        return result
      })
      await page.route("http://127.0.0.1:39196/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}${workspaceCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
        })
      )
      await page.goto("http://127.0.0.1:39196")
      if (mode === "latest-state") {
        await page.getByRole("button", { name: "打开例程", exact: true }).click()
        await page.getByRole("button", { name: "编辑", exact: true }).click()
        await page.getByRole("combobox", { name: "事件处理方式", exact: true }).click()
        await page.getByRole("option", { name: "只处理对象的最新状态", exact: true }).click()
        await page.getByLabel("事件来源批次", { exact: true }).fill("builds-v1")
        await page.getByRole("button", { name: "保存修改", exact: true }).click()
        await page
          .getByRole("dialog", { name: "编辑例程", exact: true })
          .waitFor({ state: "hidden" })
        expect(store.routine(owner.bot.id, routine.id).schedule).toEqual({
          kind: "event",
          topic: "build.finished",
          eventPolicy: { mode: "latest-state", sourceEpoch: "builds-v1" }
        })
      }
      const open = async () => {
        if (
          !(await page
            .getByRole("button", { name: "例程 构建事件核验 的更多操作", exact: true })
            .count())
        )
          await page.getByRole("button", { name: "打开例程", exact: true }).click()
        await page
          .getByRole("button", { name: "例程 构建事件核验 的更多操作", exact: true })
          .click()
        await page.getByRole("menuitem", { name: "配置 Webhook", exact: true }).click()
      }
      await open()
      await page.getByRole("button", { name: "生成密钥并启用", exact: true }).click()
      const key = await page.getByLabel("Webhook 密钥", { exact: true }).inputValue()
      expect(await page.getByLabel("Webhook 密钥", { exact: true }).getAttribute("type")).toBe(
        "password"
      )
      const url = await page.getByLabel("POST 地址", { exact: true }).inputValue()
      await page.getByRole("button", { name: "复制完整请求头", exact: true }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `Authorization: Bearer ${key}`
      )
      const accepted = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Idempotency-Key": "build-42",
          "Content-Type": "application/json"
        },
        body:
          mode === "latest-state"
            ? JSON.stringify({
                sourceEpoch: "builds-v1",
                entityKey: "build-42",
                sequence: 5,
                payload: { build: 42 }
              })
            : '{"build":42}'
      })
      expect(accepted.status).toBe(200)
      expect(store.snapshot().runs).toHaveLength(1)
      if (mode === "latest-state") {
        await page.getByText('"sourceEpoch": "builds-v1"', { exact: false }).waitFor()
        const stale = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Idempotency-Key": "build-old",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sourceEpoch: "builds-v1",
            entityKey: "build-42",
            sequence: 4,
            payload: { build: 42 }
          })
        })
        expect(stale.status).toBe(200)
        expect(await stale.json()).toMatchObject({
          accepted: true,
          disposition: "stale",
          runIds: []
        })
        expect(store.snapshot().runs).toHaveLength(1)
      }
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key)
      await page.screenshot({ path: join(output, "webhook-light.png"), animations: "disabled" })
      await page.getByRole("button", { name: "替换密钥", exact: true }).click()
      await page.getByRole("button", { name: "确认替换密钥", exact: true }).click()
      await page.getByRole("alert").filter({ hasText: "rotation acknowledgement lost" }).waitFor()
      await page.reload()
      await open()
      await page.getByRole("button", { name: "核对原操作", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "上次替换已确认" }).waitFor()
      expect(requests[1]).toEqual(requests[2])
      expect(store.webhooks.describe({ botId: owner.bot.id, routineId: routine.id }).revision).toBe(
        2
      )
      expect(await page.getByLabel("Webhook 密钥", { exact: true }).count()).toBe(0)
      expect(store.webhooks.authorize(routine.id, `Bearer ${key}`)).toBeNull()
      await page.evaluate("window.fixtureTheme('codex-dark')")
      await page.screenshot({
        path: join(output, "webhook-recovered-dark.png"),
        animations: "disabled"
      })
      await page.getByRole("button", { name: "替换密钥", exact: true }).click()
      await page.getByRole("button", { name: "确认替换密钥", exact: true }).click()
      const newKey = await page.getByLabel("Webhook 密钥", { exact: true }).inputValue()
      expect(store.webhooks.authorize(routine.id, `Bearer ${newKey}`)).not.toBeNull()
      await page.getByRole("button", { name: "撤销密钥", exact: true }).click()
      await page.getByRole("button", { name: "确认撤销密钥", exact: true }).click()
      await page.getByRole("status").filter({ hasText: "密钥已撤销" }).waitFor()
      expect(store.webhooks.authorize(routine.id, `Bearer ${newKey}`)).toBeNull()
      expect(store.snapshot().runs).toHaveLength(1)
      expect(await page.getByLabel("Webhook 密钥", { exact: true }).count()).toBe(0)
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(newKey)
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(output, "failure.png"), animations: "disabled" })
      throw error
    } finally {
      await browser.close()
      await host.webhooks.close()
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
