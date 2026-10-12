/** Real settings UI, API and SQLite. Transport faults exercise durable save recovery. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotDomainError } from "../src/shared/bot-types"
import { startBotModelUsage, settleBotModelUsage } from "../src/main/bots/model-usage"
import type { ModelResponseDiagnostic } from "../src/main/agent/model-response-diagnostics"
import type { BotUsageBudgetChange } from "../src/shared/bot-usage-budget"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "cmb-budget-ui-")),
    output = resolve("output/bot-budget"),
    renderer = resolve("src/renderer/src")
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(root, "bots.sqlite")),
    host = new BotHost(store),
    api = createBotAPI(host)
  const bots = ["项目助手", "质量助手"].map(
    (name, index) => store.createBot({ nonce: `bot-${index}`, name }).bot
  )
  const model = { id: "fixture", model: "配置的模型", baseUrl: "https://unused.invalid" }
  const known = startBotModelUsage(store, {
    botId: bots[0].id,
    model,
    purpose: "memory-synthesis",
    reserved: 500
  })
  settleBotModelUsage(store, known, {
    doneEvents: 1,
    errorEvents: 0,
    uninspectedEvents: 0,
    inputTokens: 240,
    outputTokens: 120
  } as ModelResponseDiagnostic)
  startBotModelUsage(store, {
    botId: bots[1].id,
    model,
    purpose: "memory-verification",
    reserved: 200
  })
  const change = (botId: string | null, outputLimit: number | null, nonce: string) => {
    const current = store.usageBudgets.view({ botId })
    return store.usageBudgets.change({
      botId,
      outputLimit,
      nonce,
      revision: current.revision,
      dataEpoch: current.dataEpoch
    })
  }
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
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BotUsageBudget} from './src/renderer/src/components/bots/BotUsageBudget';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';import {useBotWorkspaceStore} from './src/renderer/src/lib/bot-workspace-store';import './src/renderer/src/components/bots/bot-workspace.css';
        window.fixtureStore=useBotWorkspaceStore;useBotWorkspaceStore.setState({host:${JSON.stringify(await api.status())},snapshot:${JSON.stringify(store.snapshot())}});window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({}, {get:(_,method)=>(input)=>window.botCall(method,input)})};
        const root=createRoot(document.getElementById('root'));window.fixtureOpen=()=>root.render(<BotUsageBudget bots={${JSON.stringify(bots)}} close={()=>root.render(null)}/>);window.fixtureOpen();`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(root, "budget.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1060, height: 860 } }),
    errors: string[] = [],
    saves: BotUsageBudgetChange[] = []
  let loseResponse = false
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  try {
    await page.exposeFunction("botCall", async (method: keyof typeof api, input: unknown) => {
      if (method !== "usageBudget" && method !== "changeUsageBudget")
        throw new Error("Unexpected API")
      if (method === "changeUsageBudget") saves.push(input as BotUsageBudgetChange)
      try {
        const result = await api[method](input as never)
        if (method === "changeUsageBudget" && loseResponse) {
          loseResponse = false
          throw new Error("模拟保存回执丢失")
        }
        return result
      } catch (error) {
        if (error instanceof BotDomainError)
          return { botFailure: { code: error.code, message: error.message } }
        throw error
      }
    })
    await page.route("http://127.0.0.1:39177/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.build(scanner.scan())}\n${bundle.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join(
            "\n"
          )}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39177")
    await page.getByText("未设上限", { exact: true }).waitFor()
    await page.getByRole("switch", { name: "限制输出用量" }).click()
    const input = page.getByLabel("过去 24 小时输出上限"),
      save = page.getByRole("button", { name: "保存额度", exact: true })
    await input.fill("-1")
    assert.equal(await save.isEnabled(), false)
    assert.equal(saves.length, 0)
    await input.fill("2000")
    await save.click()
    await page.getByRole("status").filter({ hasText: "保存操作已确认" }).waitFor()
    assert.equal(store.usageBudgets.view({ botId: null }).available, 1680)
    await page.locator("summary").filter({ hasText: "模型用量" }).click()
    await page.getByText(/已报告输入 240、输出 120 tokens/).waitFor()
    await page.screenshot({ path: join(output, "budget-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "budget-dark.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-light')")
    await page.locator("summary").click()

    // The original mutation commits; a later setting must survive replay after reopening.
    loseResponse = true
    await input.fill("1800")
    await save.click()
    await page.getByRole("alert").filter({ hasText: "模拟保存回执丢失" }).waitFor()
    const pending = saves.at(-1)!
    assert.equal(store.usageBudgets.view({ botId: null }).outputLimit, 1800)
    assert.equal(await input.isEnabled(), false)
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    change(null, 1500, "other-window")
    await page.evaluate("window.fixtureOpen()")
    await page.getByRole("button", { name: "确认保存结果", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "保存操作已确认" }).waitFor()
    await page.waitForFunction(
      () => (document.getElementById("bot-budget-limit") as HTMLInputElement)?.value === "1500"
    )
    assert.deepEqual(saves.at(-1), pending)
    assert.equal(store.usageBudgets.view({ botId: null }).revision, 3)

    await page.getByRole("combobox", { name: "用量范围" }).click()
    await page.getByRole("option", { name: "质量助手", exact: true }).click()
    await page.getByText("未设上限", { exact: true }).waitFor()
    await page.getByRole("switch", { name: "限制输出用量" }).click()
    await input.fill("600")
    await save.click()
    await page.getByRole("status").filter({ hasText: "保存操作已确认" }).waitFor()
    assert.equal(store.usageBudgets.view({ botId: bots[1].id }).available, 400)
    assert.equal(store.usageBudgets.view({ botId: bots[0].id }).outputLimit, null)
    assert.equal(store.usageBudgets.view({ botId: null }).outputLimit, 1500)

    // Editing retains its revision even when the live view refreshes.
    await input.fill("900")
    change(bots[1].id, 700, "concurrent-edit")
    await save.click()
    await page.getByRole("alert").filter({ hasText: "用量设置已变化" }).waitFor()
    await page.waitForFunction(
      () => (document.getElementById("bot-budget-limit") as HTMLInputElement)?.value === "700"
    )
    assert.equal(store.usageBudgets.view({ botId: bots[1].id }).outputLimit, 700)
    await input.fill("800")
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,?,?)",
      ["restored-fixture", "{}", store.now()]
    )
    await page.evaluate((snapshot) => window.fixtureStore.setState({ snapshot }), store.snapshot())
    await page.getByRole("alert").filter({ hasText: "数据已恢复" }).waitFor()
    assert.equal(await input.inputValue(), "800")
    assert.equal(await save.isEnabled(), false)
    await page.setViewportSize({ width: 390, height: 760 })
    await page.locator("summary").click()
    const dialog = page.getByRole("dialog")
    const bounds = await dialog.boundingBox()
    assert.ok(bounds && bounds.y >= 24 && bounds.y + bounds.height <= 736)
    assert.equal(await dialog.evaluate((node) => getComputedStyle(node).borderRadius), "20px")
    await page.getByRole("alert").scrollIntoViewIfNeeded()
    assert.equal(await page.getByRole("heading", { name: "用量与额度" }).isVisible(), true)
    await page.screenshot({ path: join(output, "budget-narrow.png"), animations: "disabled" })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "checks.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "real-api-ledger",
            "invalid-input",
            "scope-isolation",
            "lost-receipt-reopen-replay",
            "revision-conflict",
            "restored-epoch",
            "light-dark-narrow"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log("PASS: Bot usage budget UI and durable save recovery")
  } catch (error) {
    console.error(await page.locator("body").innerText())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
    await host.stop()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
