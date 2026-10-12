/** Real React/Chrome and isolated durable Host storage; no application/user data is touched. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotSaveSkillInput } from "../src/shared/bot-skill-save"
import type { BotSkillEnablementInput, BotWithdrawSkill } from "../src/shared/bot-skill-library"

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-user-skills-ui-"))
  const store = new BotStore(join(directory, "bots.sqlite"))
  const a = store.createBot({ nonce: "a", name: "需求 Bot" }).bot,
    b = store.createBot({ nonce: "b", name: "质量 Bot" }).bot
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-user-skills")
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotSkillCreateForm}from'./src/renderer/src/components/bots/BotSkillCreateForm';import{BotSkillLibraryPanel}from'./src/renderer/src/components/bots/BotSkillLibrary';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';applyThemePreference('codex-light');window.theme=applyThemePreference;
      window.api={bots:{saveSkill:window.saveSkill,setSkillEnabled:window.setSkillEnabled,withdrawSkill:window.withdrawSkill}};
      function Workspace({botId}){const[data,setData]=useState({items:[],available:[]});const reload=async()=>setData(await window.read(botId));window.reload=reload;return <section className="space-y-5"><BotSkillLibraryPanel botId={botId} items={data.items} available={data.available} trials={[]} reload={reload}/><BotSkillCreateForm botId={botId} reload={reload}/></section>}
      function App(){const[botId,select]=useState('${a.id}');window.select=select;return <main className="bot-workspace min-h-screen bg-background p-8 text-foreground"><div className="mx-auto max-w-xl space-y-5"><h1 className="text-xl font-medium">{botId==='${a.id}'?'需求 Bot':'质量 Bot'} · 我的技能库</h1><Workspace key={botId} botId={botId}/></div></main>};createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "workspace",
        setup(context) {
          context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "workspace",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: process.cwd(),
            contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(store.snapshot())},host:{capabilities:['skill-save-receipts','mutation-data-epoch-v2','user-skill-definitions-v1']}}));`
          }))
        }
      }
    ]
  })
  const workspaceCss = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}\n${workspaceCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(html)
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [],
    toggles: BotSkillEnablementInput[] = []
  let loseToggle = false
  page.on("pageerror", (error) => errors.push(error.message))
  const result = (operation: () => unknown) => {
    try {
      return operation()
    } catch (error) {
      const failure = error as Error & { code?: string }
      return { botFailure: { code: failure.code ?? "unknown", message: failure.message } }
    }
  }
  try {
    await page.exposeFunction("saveSkill", (input: BotSaveSkillInput) =>
      result(() => store.saveSkill(input))
    )
    await page.exposeFunction("setSkillEnabled", (input: BotSkillEnablementInput) => {
      toggles.push(input)
      const saved = result(() => store.skillLibrary.setEnabled(input))
      if (loseToggle) {
        loseToggle = false
        return { botFailure: { code: "connection_closed", message: "回执未收到" } }
      }
      return saved
    })
    await page.exposeFunction("withdrawSkill", (input: BotWithdrawSkill) =>
      result(() => store.skillLibrary.withdraw(input))
    )
    await page.exposeFunction("read", (botId: string) => ({
      items: store.skillLibrary.list(),
      available: store.skillLibrary.available(botId)
    }))
    await page.goto(`http://127.0.0.1:${address.port}`)
    const invoke = async (name: string, value?: unknown) =>
      page.evaluate(
        async ({ name, value }) => {
          const fn = (window as unknown as Record<string, (value?: unknown) => unknown>)[name]
          await fn(value)
        },
        { name, value }
      )
    await page.getByLabel("技能保存位置").waitFor()
    assert.equal(await page.getByLabel("技能保存位置").inputValue(), "user")
    await page.getByLabel("名称", { exact: true }).fill("项目检查")
    await page.getByLabel("内容", { exact: true }).fill("先核对需求，再检查实现与证据。")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("heading", { name: "项目检查", exact: true }).waitFor()
    const skill = store.skillLibrary.list()[0]
    assert(skill)
    assert.equal(store.skills(a.id).length, 0)
    await invoke("select", b.id)
    await page.getByRole("heading", { name: "质量 Bot · 我的技能库" }).waitFor()
    await invoke("reload")
    await page.getByRole("heading", { name: "项目检查", exact: true }).waitFor()
    await page.getByText("管理技能", { exact: true }).click()
    await page.getByRole("button", { name: "修订技能 项目检查" }).click()
    await page.locator("article textarea").fill("核对最新需求、实现与测试证据。")
    await page.locator("article").getByRole("button", { name: "保存新版本", exact: true }).click()
    await page.getByText("版本 2", { exact: false }).waitFor()
    assert.equal(store.skillLibrary.current(a.id, skill.id).version, 2)
    loseToggle = true
    await page.getByRole("button", { name: "对此 Bot 停用", exact: true }).click()
    await page.getByRole("button", { name: "核对启用状态", exact: true }).waitFor()
    await page.getByRole("button", { name: "核对启用状态", exact: true }).click()
    await page.getByRole("button", { name: "对此 Bot 启用", exact: true }).waitFor()
    assert.equal(toggles.length, 2)
    assert.deepEqual(toggles[0], toggles[1])
    assert.equal(store.skillLibrary.current(a.id, skill.id).enabled, true)
    assert.throws(() => store.skillLibrary.current(b.id, skill.id), /停用/)
    await page.screenshot({
      path: join(output, "shared-disabled-light.png"),
      fullPage: true,
      animations: "disabled"
    })
    await invoke("theme", "codex-dark")
    assert.equal(await page.locator("html").getAttribute("data-color-scheme"), "dark")
    await page.screenshot({
      path: join(output, "shared-disabled-dark.png"),
      fullPage: true,
      animations: "disabled"
    })
    await page.getByRole("button", { name: "对此 Bot 启用", exact: true }).click()
    await page.getByRole("button", { name: "对此 Bot 停用", exact: true }).waitFor()
    await page.getByRole("button", { name: "删除我的技能", exact: true }).click()
    await page.getByRole("button", { name: "确认撤回", exact: true }).click()
    await page.getByText("暂无共享技能", { exact: true }).waitFor()
    assert.equal(store.skillLibrary.list().length, 0)
    assert.equal(store.db.exec("SELECT COUNT(*) FROM bot_user_skill_versions")[0].values[0][0], 2)
    const removed = store.saveSkill({
      nonce: "removed-before-ack",
      botId: b.id,
      scope: "user",
      name: "待核对开关",
      instructions: "Reusable steps",
      enabled: true
    })
    await invoke("reload")
    loseToggle = true
    await page.getByRole("button", { name: "对此 Bot 停用", exact: true }).click()
    await page.getByRole("button", { name: "核对启用状态", exact: true }).waitFor()
    store.skillLibrary.withdraw({
      nonce: "removed-elsewhere",
      expectedDataEpoch: store.snapshot().dataEpoch,
      id: removed.id,
      revision: 1
    })
    await invoke("reload")
    const recovery = page.getByLabel("已移除技能的待确认启用状态")
    await recovery.getByRole("button", { name: "核对启用状态", exact: true }).click()
    await recovery.waitFor({ state: "detached" })
    assert.deepEqual(toggles.at(-1), toggles.at(-2))
    assert.equal(
      await page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) => key.startsWith("bot-skill-enablement:")).length
      ),
      0
    )
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(
        {
          passed: true,
          scenarios: [
            "default-user-create",
            "cross-bot-canonical-edit",
            "per-bot-disable",
            "lost-toggle-receipt-retry",
            "re-enable",
            "global-withdraw-retains-history",
            "removed-skill-pending-toggle-recovery"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS shared user skill UI: canonical create/edit, per-Bot enablement, exact retry and global withdrawal"
    )
  } finally {
    await browser.close()
    await new Promise<void>((ready) => server.close(() => ready()))
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
