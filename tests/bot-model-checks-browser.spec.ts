/** Actual React form, keyboard and late response behavior. Provider protocol is
 * verified separately by the real HTTP/SSE service tests. No paid model calls. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { botModelCheckInput, type BotModelCheckInput } from "../src/shared/bot-model-check"

async function main() {
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-model-checks")
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
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotModelChecks}from'./src/renderer/src/components/bots/BotModelChecks';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:{checkModel:window.fixtureCheck,cancelModelCheck:window.fixtureCancel}};window.submitted=0;
      function Fixture(){const[model,setModel]=useState('alpha');return <main className="mx-auto max-w-lg p-5"><form className="space-y-4" onSubmit={e=>{e.preventDefault();window.submitted++}}><h1 className="text-lg font-semibold">Bot 设置</h1><label className="block text-sm">模型<select aria-label="模型" className="ml-3 rounded border border-border bg-background p-2" value={model} onChange={e=>setModel(e.target.value)}><option value="alpha">研发模型</option><option value="beta">备用模型</option></select></label><BotModelChecks key={model} modelRef={model}/><button>保存</button></form></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 700, height: 740 } }),
    errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  let mode: "normal" | "hold" | "changed" | "error" = "normal",
    release: (() => void) | undefined
  const calls: BotModelCheckInput[] = [],
    cancelled: string[] = []
  try {
    await page.exposeFunction("fixtureCheck", async (raw: unknown) => {
      const input = botModelCheckInput.parse(raw)
      calls.push(input)
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (mode === "error" && input.kind === "tools") throw new Error("Configuration changed")
      return {
        ...input,
        modelName: "研发模型",
        model: "fixture-model",
        configuration: mode === "changed" && input.kind === "tools" ? "new" : "old",
        checkedAt: Date.now(),
        latencyMs: 8,
        status: input.kind === "tools" ? "failed" : "passed",
        detail:
          input.kind === "tools"
            ? "接口有响应，但未返回预期结果；请检查模型能力和服务配置。"
            : "基础样例检查通过。"
      }
    })
    await page.exposeFunction("fixtureCancel", ({ nonce }: { nonce: string }) => {
      cancelled.push(nonce)
    })
    await page.route("http://127.0.0.1:39179/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39179")
    const panel = page.getByRole("region", { name: "模型能力检查" })
    await panel.getByRole("button", { name: "检查模型", exact: true }).click()
    await panel.getByText("结果仅代表本次基础样例", { exact: false }).waitFor()
    await panel.locator('[data-model-check="vision"]').getByText("通过", { exact: true }).waitFor()
    assert.deepEqual(
      calls.map((c) => c.kind),
      ["text", "tools", "vision"]
    )
    assert.equal(await panel.getByText("未通过", { exact: true }).count(), 1)
    assert.equal(await page.evaluate("window.submitted"), 0)
    await page.screenshot({ path: join(output, "checks-light.png") })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "checks-dark.png") })
    mode = "hold"
    await panel.getByRole("button", { name: "重新检查" }).click()
    await panel.getByText("检查中…").waitFor()
    await page.waitForFunction(() => window !== null) // Yield the pending exposed call.
    for (let i = 0; !release && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(release)
    const old = calls.at(-1)!
    await page.getByRole("combobox", { name: "模型", exact: true }).selectOption("beta")
    await panel.getByRole("button", { name: "检查模型", exact: true }).waitFor()
    for (let i = 0; !cancelled.includes(old.nonce) && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(cancelled.includes(old.nonce))
    release!()
    release = undefined
    await page.waitForTimeout(50)
    assert.equal(await panel.getByText("未检查", { exact: true }).count(), 3)
    mode = "changed"
    const count = calls.length
    await panel.getByRole("button", { name: "检查模型", exact: true }).click()
    await panel.getByText("模型配置已变化，请重新检查。").waitFor()
    assert.equal(calls.length, count + 2)
    assert.equal(await panel.getByText("未检查", { exact: true }).count(), 3)
    mode = "error"
    await panel.getByRole("button", { name: "检查模型", exact: true }).click()
    await panel.getByText("检查未完成。", { exact: false }).waitFor()
    assert.equal(await panel.getByText("未检查", { exact: true }).count(), 3)
    mode = "hold"
    await panel.getByRole("button", { name: "检查模型", exact: true }).click()
    for (let i = 0; !release && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(release)
    await panel.getByRole("button", { name: "取消检查" }).click()
    release!()
    release = undefined
    await panel.getByText("检查已取消。").waitFor()
    assert.equal(await panel.getByText("未检查", { exact: true }).count(), 3)
    await page.setViewportSize({ width: 390, height: 740 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.screenshot({ path: join(output, "checks-narrow.png") })
    assert.deepEqual(errors, [])
    console.log("Bot model checks browser journey passed")
  } finally {
    release?.()
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
