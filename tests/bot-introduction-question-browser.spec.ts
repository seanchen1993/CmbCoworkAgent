/** Isolated real React questions and SQLite receipts. Native IPC is the only
 * seam; no official App, user database or real model is controlled here. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotIntroductionQuestionReply } from "../src/shared/bot-introduction-question"

interface QuestionFixtureWindow extends Window {
  fixtureLoad(index: number): Promise<void>
  fixtureUnmount(): void
  fixtureEpoch(epoch: string): void
  fixtureTheme(theme: "codex-light" | "codex-dark"): void
  fixtureHasHeld(): Promise<boolean>
}

async function main() {
  const root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src")
  const output = join(root, "output/introduction-question")
  await mkdir(output, { recursive: true })
  const store = new BotStore(":memory:")
  const bots = []
  for (let i = 0; i < 5; i++) {
    const created = store.createBot({
      nonce: `bot-${i}`,
      name: "结果核对助手",
      introduction: { language: "zh-CN" }
    })
    const task = store.claim("fixture-host")!
    store.introductionQuestions.stage(task.lease, "optional-question", {
      questions: [
        {
          id: "work",
          header: "工作范围",
          question: "你想先核对哪类材料？",
          options: [
            { label: "报表数字", description: "检查合计和差额" },
            { label: "文档内容", description: "检查材料一致性" }
          ]
        }
      ]
    })
    store.finish(task.lease, "succeeded", "你好！发来要核对的材料就可以开始。")
    bots.push(created)
  }
  const frame = (index: number) => ({
    snapshot: store.snapshot(),
    host: {
      hostId: "fixture-host",
      capabilities: ["mutation-data-epoch-v2", "bot-introduction-question-v1"]
    },
    greeting: store.messages(bots[index].conversationId)[0].text,
    message: store
      .messages(bots[index].conversationId)
      .find((message) => message.introductionQuestion)!
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotIntroductionQuestion}from'./src/renderer/src/components/bots/BotIntroductionQuestion';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      window.api={bots:{answerIntroductionQuestion:async input=>window.fixtureCall('answer',input)}};window.electron={process:{platform:'darwin'}};
      let renderFrame;window.fixtureUnmount=()=>renderFrame(null);window.fixtureLoad=async index=>{window.fixtureIndex=index;const f=await window.fixtureCall('frame',index);useBotWorkspaceStore.setState({...f,selected:f.message.conversationId,loadMessages:async()=>{const next=await window.fixtureCall('frame',window.fixtureIndex);useBotWorkspaceStore.setState(next);renderFrame(next)},refresh:async()=>{}});renderFrame(f)};
      window.fixtureEpoch=epoch=>useBotWorkspaceStore.setState({snapshot:{...useBotWorkspaceStore.getState().snapshot,dataEpoch:epoch}});window.fixtureTheme=applyThemePreference;
      function Fixture(){const[f,set]=useState(null);renderFrame=set;return f?<main className='mx-auto max-w-xl p-6' aria-label='验收聊天'><p>{f.greeting}</p><BotIntroductionQuestion key={f.message.id} question={f.message.introductionQuestion}/></main>:<p>已离开会话</p>};applyThemePreference('codex-light');createRoot(document.getElementById('root')).render(<Fixture/>);`,
      loader: "tsx",
      resolveDir: root
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      "import.meta.hot": "false"
    }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  await page.emulateMedia({ reducedMotion: "reduce" })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [],
    calls: BotIntroductionQuestionReply[] = []
  let loseNext = false,
    holdNext = false,
    release: (() => void) | undefined
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureHasHeld", () => Boolean(release))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (method === "frame") return frame(Number(input))
      assert.equal(method, "answer")
      const request = input as BotIntroductionQuestionReply
      calls.push(request)
      try {
        const receipt = store.introductionQuestions.reply(request)
        if (holdNext) {
          holdNext = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        if (loseNext) {
          loseNext = false
          return { botFailure: { code: "transport_error", message: "连接中断，回答结果待核对" } }
        }
        return receipt
      } catch (failure) {
        return {
          botFailure: {
            code: (failure as { code?: string }).code ?? "invalid_input",
            message: (failure as Error).message
          }
        }
      }
    })
    // Match Electron's secure renderer context so native Web Crypto is exercised.
    await page.route("https://introduction.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>${css.build(scanner.scan())}</style></head><body><div id='root'></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("https://introduction.test/")
    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureLoad(0))
    const question = page.getByRole("region", { name: "开始使用 Bot" })
    await question.getByRole("button", { name: "报表数字 检查合计和差额" }).waitFor()
    assert.equal(
      await question.getByRole("button", { name: "发送回答", exact: true }).isDisabled(),
      true
    )
    await page.screenshot({ path: join(output, "light.png"), animations: "disabled" })
    await question.getByRole("button", { name: "忽略问题" }).click()
    await question.getByText("已略过", { exact: false }).waitFor()
    assert.equal(store.messages(bots[0].conversationId).length, 2)
    assert.equal(
      store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE source='user'")[0].values[0][0],
      0
    )

    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureLoad(1))
    loseNext = true
    await question.getByRole("button", { name: "文档内容 检查材料一致性" }).click()
    await question.getByRole("alert").filter({ hasText: "连接中断" }).waitFor()
    const first = calls.at(-1)!
    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      `bot-introduction-question-pending:${first.runId}`
    )
    assert.ok(raw)
    await question.getByRole("button", { name: "核对原回答" }).click()
    await question.getByText("已回答", { exact: false }).waitFor()
    assert.deepEqual(calls.at(-1), first)
    assert.equal(store.messages(bots[1].conversationId).length, 3)
    assert.equal(
      store.db.exec("SELECT COUNT(*) FROM bot_runs WHERE source='user'")[0].values[0][0],
      1
    )

    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureLoad(2))
    holdNext = true
    await question.getByRole("button", { name: "报表数字 检查合计和差额" }).click()
    await page.waitForFunction(() => (window as QuestionFixtureWindow).fixtureHasHeld())
    // Native transport seam commits synchronously before holding its response.
    assert.equal(store.messages(bots[2].conversationId).length, 3)
    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureUnmount())
    await page.getByText("已离开会话").waitFor()
    assert.ok(release)
    release!()
    release = undefined
    await page.waitForFunction(
      (key) => localStorage.getItem(key) === null,
      `bot-introduction-question-pending:${calls.at(-1)!.runId}`
    )
    assert.deepEqual(errors, [])

    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureLoad(3))
    holdNext = true
    await question.getByRole("button", { name: "报表数字 检查合计和差额" }).click()
    await page.waitForFunction(() => (window as QuestionFixtureWindow).fixtureHasHeld())
    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureEpoch("replacement"))
    assert.ok(release)
    release!()
    release = undefined
    await question
      .getByRole("button", { name: "发送回答", exact: true })
      .waitFor({ state: "visible" })
    assert.ok(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `bot-introduction-question-pending:${calls.at(-1)!.runId}`
      )
    )
    assert.equal(
      await question.getByRole("button", { name: "发送回答", exact: true }).isDisabled(),
      true
    )

    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureLoad(4))
    await page.evaluate(() => (window as QuestionFixtureWindow).fixtureTheme("codex-dark"))
    await page.screenshot({ path: join(output, "dark.png"), animations: "disabled" })
    const darkOption = await question.evaluate((section) => {
      const radio = section.querySelector('[role="group"] button')!
      return {
        foreground: getComputedStyle(document.body).color,
        optionColor: getComputedStyle(radio).color
      }
    })
    assert.equal(darkOption.optionColor, darkOption.foreground)
    await page.setViewportSize({ width: 420, height: 780 })
    await page.screenshot({ path: join(output, "narrow.png"), animations: "disabled" })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await question
      .getByRole("textbox", { name: "自定义回答" })
      .fill("我先发一份需求说明，请核对术语一致性")
    await question.getByRole("textbox", { name: "自定义回答" }).press("Enter")
    await question.getByText("已回答", { exact: false }).waitFor()
    assert.equal(
      store.messages(bots[4].conversationId)[2].text,
      "补充信息\n\n你想先核对哪类材料？\n我先发一份需求说明，请核对术语一致性"
    )
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          journeys: 5,
          nativeOrRealModelClaimed: false,
          requestCalls: calls.length,
          pageErrors: errors
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ passed: true, journeys: 5, requestCalls: calls.length, output }))
  } catch (failure) {
    await writeFile(
      join(output, "failure.json"),
      JSON.stringify(
        {
          error: failure instanceof Error ? failure.message : String(failure),
          pageErrors: errors,
          bodyText: await page.locator("body").innerText(),
          requestCalls: calls,
          firstQuestion: frame(0).message.introductionQuestion,
          localRecords: await page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("bot-introduction-question-pending:"))
              .map((key) => [key, localStorage.getItem(key)])
          )
        },
        null,
        2
      )
    )
    throw failure
  } finally {
    release?.()
    await browser.close()
    store.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
