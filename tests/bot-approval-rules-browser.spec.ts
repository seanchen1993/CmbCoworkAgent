/** Actual approval controls and rule settings against the original SQLite owner. No model is called. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { highlightWorkerFixture } from "./fixtures/highlight-worker"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/approval-rules"),
    startedAt = new Date().toISOString()
  await mkdir(output, { recursive: true })
  const store = new BotStore(":memory:")
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const { bot, conversationId } = store.createBot({ nonce: "owner", name: "审批核对 Bot" })
    store.send({ nonce: "task", conversationId, text: "检查当前项目测试" })
    const { lease, run } = store.claim("approval-fixture")!,
      scope = "a".repeat(64)
    const action = {
      shell: {
        command: "npm test",
        cwd: "C:/projects/approval-fixture",
        timeoutSeconds: 60,
        sandbox: "unelevated",
        definition: {
          kind: "package_script",
          path: "package.json",
          sha256: "c".repeat(64),
          definition: "node test.cjs"
        }
      }
    }
    const ask = () =>
      store.requestInteraction(lease, {
        kind: "approval",
        prompt: JSON.stringify(action),
        action,
        ruleScope: scope
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
        resolveDir: root,
        loader: "tsx",
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{BotApprovalActions}from'./src/renderer/src/components/bots/BotApprovalActions';
import{BotApprovalRules}from'./src/renderer/src/components/bots/BotApprovalRules';
import{BotApprovalContent}from'./src/renderer/src/components/bots/BotApprovalContent';
import{botApi}from'./src/renderer/src/lib/bot-api';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
window.api={bots:{approvalRules:input=>window.fixtureCall('rules',input),changeApprovalRule:input=>window.fixtureCall('change',input),answer:input=>window.fixtureCall('answer',input)}};
window.electron={process:{platform:'darwin'}};useBotWorkspaceStore.setState({host:${JSON.stringify(await createBotAPI(new BotHost(store)).status())},snapshot:${JSON.stringify(store.snapshot())}});applyThemePreference('codex-dark');
function Fixture(){const[setup,setSetup]=useState(null),[settings,setSettings]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');window.fixtureSetup=value=>{setSetup(value);setError('');setBusy(false)};window.fixtureSettings=setSettings;window.fixtureTheme=applyThemePreference;if(!setup)return null;const submit=async(answer,remember)=>{setBusy(true);try{const saved=await botApi.answer({id:setup.item.id,revision:setup.item.revision,answer,...(remember?{remember:true}:{})});window.fixtureResult=saved;setSetup({...setup,item:saved})}catch(e){setError(e.message)}finally{setBusy(false)}};return <main className='bot-workspace min-h-screen bg-background p-6 text-foreground'><section aria-label='审批操作' className='mx-auto max-w-lg rounded-2xl border p-5'><BotApprovalContent prompt={setup.item.prompt}/><div className='mt-4 flex flex-wrap gap-2'>{setup.item.status==='pending'?<BotApprovalActions busy={busy} pluginGrant={false} canRemember={!!setup.item.review?.canRemember} canDeny={setup.supported&&!!setup.item.review?.canDeny} submit={(a,r)=>void submit(a,r)}/>:<p>本次决定：{setup.item.answer}</p>}</div>{error&&<p role='alert'>{error}</p>}</section>{settings&&<BotApprovalRules bot={(${JSON.stringify(bot)})} denyRules={setup.supported} close={()=>setSettings(false)}/>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
      },
      plugins: [
        await highlightWorkerFixture(renderer),
        {
          name: "visibility-fixture",
          setup(context) {
            context.onResolve({ filter: /use-bot-view-visibility$/ }, () => ({
              path: "visible",
              namespace: "fixture"
            }))
            context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              contents: "export const useBotViewVisibility=()=>true"
            }))
          }
        }
      ],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      outfile: join(output, "fixture.js"),
      jsx: "automatic",
      alias: { "@": renderer },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
    })
    const workspaceCss = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")
    const componentCss = bundle.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n")
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css.build(scanner.scan())}\n${workspaceCss}\n${componentCss}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script></body></html>`
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    })
    const page = await browser.newPage({ viewport: { width: 1000, height: 820 } }),
      errors: string[] = [],
      journeys: string[] = [],
      calls: { method: string; input: unknown }[] = []
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureCall", (method: string, input: unknown) => {
      calls.push({ method, input })
      if (method === "rules") return store.approvalRules.read(String(input))
      if (method === "change") return store.approvalRules.change(input)
      assert.equal(method, "answer")
      return store.answerInteraction(input as Parameters<BotStore["answerInteraction"]>[0])
    })
    await page.route("http://127.0.0.1:43129/**", (route) =>
      route.fulfill({ contentType: "text/html", body: html })
    )
    await page.goto("http://127.0.0.1:43129/approval")
    const setup = async (supported = true) => {
      const item = ask()
      await page.evaluate(
        (value) =>
          (window as unknown as { fixtureSetup(value: unknown): void }).fixtureSetup(value),
        { item, supported }
      )
      await page.getByRole("region", { name: "审批操作" }).waitFor()
      return item
    }
    const region = page.getByRole("region", { name: "审批操作" })
    let item = await setup(false)
    await region.getByRole("button", { name: "始终允许", exact: true }).waitFor()
    assert.equal(await region.getByRole("button", { name: "从不允许", exact: true }).count(), 0)
    await region.getByRole("button", { name: "拒绝本次", exact: true }).click()
    await region.getByText("本次决定：reject", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(bot.id).rules.length, 0)
    journeys.push("older Host hides unsupported never; one-time rejection creates no rule")
    item = await setup()
    await region.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await region.getByText("本次决定：approve", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(bot.id).rules.length, 0)
    journeys.push("one-time approval creates no rule")
    item = await setup()
    await region.getByRole("button", { name: "始终允许", exact: true }).click()
    await region.getByText("本次决定：approve", { exact: true }).waitFor()
    let rules = store.approvalRules.read(bot.id)
    assert.equal(rules.rules[0].behavior, "allow")
    assert.equal(ask().answer, "approve")
    journeys.push("always allow persists and answers the exact next action")
    rules = store.approvalRules.change({
      botId: bot.id,
      ruleId: rules.rules[0].id,
      revision: rules.revision,
      dataEpoch: rules.dataEpoch,
      nonce: "clear-allow",
      behavior: null
    })
    item = await setup()
    await page.setViewportSize({ width: 380, height: 820 })
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert.equal(await page.getByRole("main").count(), 1)
    assert.equal(await region.count(), 1)
    await writeFile(
      join(output, "narrow-layout.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          regions: [...document.querySelectorAll('section[aria-label="审批操作"]')].map((node) => ({
            html: node.outerHTML,
            bounds: node.getBoundingClientRect().toJSON()
          })),
          viewport: { width: innerWidth, height: innerHeight },
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight
        })),
        null,
        2
      )
    )
    await page.screenshot({
      path: join(output, "approval-choices-dark-narrow.png"),
      animations: "disabled"
    })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await region.getByRole("button", { name: "从不允许", exact: true }).click()
    await region.getByText("本次决定：reject", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(bot.id).rules[0].behavior, "deny")
    const denied = ask()
    assert.equal(denied.answer, "reject")
    assert.equal(store.getRun(run.id).status, "running")
    assert.throws(() =>
      store.beginEffect(lease, { id: "cannot-dispatch", action, approvalId: denied.id })
    )
    journeys.push("never persists, auto-rejects and creates no effect")
    await page.setViewportSize({ width: 1000, height: 820 })
    await page.evaluate(() =>
      (window as unknown as { fixtureSettings(value: boolean): void }).fixtureSettings(true)
    )
    const dialog = page.getByRole("dialog", { name: "审批规则", exact: true })
    let controls = dialog.getByRole("group", { name: "命令处理方式" })
    await controls.getByRole("button", { name: "从不允许", exact: true }).waitFor()
    assert.equal(
      await controls
        .getByRole("button", { name: "从不允许", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    await page.screenshot({ path: join(output, "never-rule-dark.png"), animations: "disabled" })
    await controls.getByRole("button", { name: "每次询问", exact: true }).click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="group"] button[aria-pressed="true"]')
          ?.textContent?.trim() === "每次询问"
    )
    assert.equal(store.approvalRules.read(bot.id).rules[0].behavior, "ask")
    item = ask()
    assert.equal(item.status, "pending")
    store.answerInteraction({ id: item.id, revision: item.revision, answer: "reject" })
    journeys.push("settings revoke never and restore human confirmation")
    await dialog.getByRole("button", { name: "从不允许", exact: true }).click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="group"] button[aria-pressed="true"]')
          ?.textContent?.trim() === "从不允许"
    )
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    await page.evaluate(() => {
      const f = window as unknown as {
        fixtureSettings(value: boolean): void
        fixtureTheme(value: string): void
      }
      f.fixtureTheme("codex-light")
      f.fixtureSettings(true)
    })
    controls = page
      .getByRole("dialog", { name: "审批规则", exact: true })
      .getByRole("group", { name: "命令处理方式" })
    await controls.getByRole("button", { name: "从不允许", exact: true }).waitFor()
    assert.equal(
      await controls
        .getByRole("button", { name: "从不允许", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    await page.screenshot({ path: join(output, "never-rule-light.png"), animations: "disabled" })
    await dialog.getByRole("button", { name: "删除规则", exact: true }).click()
    await dialog.getByText("还没有保存的审批规则", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(bot.id).rules.length, 0)
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
    journeys.push("reopening preserves the stored refusal; explicit deletion removes it")
    store.autoReview.change({
      ...store.autoReview.read(bot.id),
      isEnabled: true,
      nonce: "enable-review"
    })
    item = await setup()
    assert.equal(item.review?.canRemember, false)
    assert.equal(item.review?.canDeny, true)
    assert.equal(await region.getByRole("button", { name: "始终允许", exact: true }).count(), 0)
    await region.getByRole("button", { name: "从不允许", exact: true }).click()
    await region.getByText("本次决定：reject", { exact: true }).waitFor()
    assert.equal(ask().answer, "reject")
    journeys.push("independent review retains the human's permanent refusal choice")
    assert.deepEqual(errors, [])
    assert.equal(calls.filter((c) => c.method === "answer").length, 5)
    console.log(JSON.stringify({ pass: true, journeys, errors, startedAt }))
  } finally {
    await browser?.close()
    store.close()
    console.log(JSON.stringify({ physicallyClosed: true, finishedAt: new Date().toISOString() }))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
