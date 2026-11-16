/** Provider chunks → durable Design sessions → real React reasoning controls. */
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { AIMessageChunk } from "@langchain/core/messages"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { DesignSessionStore } from "../src/main/services/design/session-store"
import { DesignRunManager } from "../src/main/services/design/run-manager"
import { createDesignState, type DesignRunEvent } from "../src/shared/managed-design-session"
import { createDesignModelActivity } from "../src/shared/design-live-output"

const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { DesignLiveOutput } from './src/renderer/src/components/design/DesignLiveOutput';
      import { MessageBubble } from './src/renderer/src/components/design/MessageBubble';
      function Fixture() {
        const [state, setState] = useState(null);
        window.renderDesignState = setState;
        return <main style={{width:420,padding:20}}>
          {state?.messages.map((message, index) => <MessageBubble key={message.id || index}
            message={message} hasLiveOutput={Boolean(state.liveOutput)}/>)}
          {state?.liveOutput && <DesignLiveOutput output={state.liveOutput}
            questionCount={state.generationState === 'asking' ? state.questions.length : undefined}/>}
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
    resolveDir: process.cwd(), loader: "tsx"
  },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": resolve("src/renderer/src") }, define: { "process.env.NODE_ENV": '"test"' }
})
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined })
const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 700 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => typeof (window as any).renderDesignState === "function")
  let delivery = Promise.resolve()
  let emit!: (event: DesignRunEvent) => void
  let finish!: () => void
  const store = new DesignSessionStore(db)
  const manager = new DesignRunManager(store, {
    execute: (_request, _runId, callback) => { emit = callback; return new Promise<void>((done) => { finish = done }) },
    abort: () => {}, finalize: (event) => event,
    publish: (change) => {
      if (change.snapshot) delivery = delivery.then(() => page.evaluate((state) => (window as any).renderDesignState(state), change.snapshot!.state))
    }
  })
  manager.create({ id: "ds_reasoning", meta: { id: "ds_reasoning", title: "思考测试", createdAt: 1, updatedAt: 1 }, state: createDesignState(), workspacePath: null })
  manager.start({ requestId: "first", designSessionId: "ds_reasoning", kind: "agent", prompt: "创建页面" })
  await Promise.resolve()
  const live = page.getByTestId("design-live-output")
  await live.waitFor()
  const reasoning = live.getByTestId("design-reasoning")
  const sendReasoning = (text: string) => emit({ type: "model_activity", activity: createDesignModelActivity(
    JSON.parse(JSON.stringify(new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: text } }))), "ai") })
  sendReasoning("先分析页面结构，")
  sendReasoning("再规划视觉层级。")
  await reasoning.getByLabel("模型思考内容").filter({ hasText: "先分析页面结构，再规划视觉层级。" }).waitFor()
  assert.match(await live.innerText(), /模型正在思考/)
  assert.doesNotMatch(await live.innerText(), /等待可显示的模型输出/)
  await reasoning.getByRole("button").click()
  assert.equal(await reasoning.getByLabel("模型思考内容").count(), 0)
  emit({ type: "model_activity", activity: { scope: "ai", reasoning: "先分析页面结构，再规划视觉层级。", reasoningMode: "snapshot" } })
  await reasoning.getByRole("button").click()
  await reasoning.getByLabel("模型思考内容").waitFor()
  if (process.env.DESIGN_REASONING_SCREENSHOT) await page.screenshot({ path: process.env.DESIGN_REASONING_SCREENSHOT })

  // Inline think tags from another model call are captured without entering the file output.
  emit({ type: "model_activity", activity: { scope: "inline" } })
  emit({ type: "token", token: "<thi" })
  emit({ type: "token", token: "nk>继续检查配色" })
  await reasoning.getByLabel("模型思考内容").filter({ hasText: "继续检查配色" }).waitFor()
  emit({ type: "token", token: "</think>" })
  emit({ type: "model_activity", activity: { scope: "inline", toolCallChunks: [{ name: "write_file", args: JSON.stringify({ content: "<html>页面内容</html>" }) }] } })
  await live.getByLabel("模型实时输出").filter({ hasText: "<html>页面内容</html>" }).waitFor()
  assert.equal(await reasoning.getByLabel("模型思考内容").count(), 0, "file output auto-collapses thinking")
  assert.doesNotMatch(await live.getByLabel("模型实时输出").innerText(), /继续检查配色/)
  await reasoning.getByRole("button").click()
  await reasoning.getByLabel("模型思考内容").waitFor()

  const html = '<!doctype html><html><body><h1>页面内容</h1></body></html>'
  emit({ type: "done", html })
  finish()
  await live.waitFor({ state: "detached" })
  await delivery
  const saved = store.get("ds_reasoning")!
  assert.equal(saved.state.messages.at(-1)!.reasoning, "先分析页面结构，再规划视觉层级。\n\n继续检查配色")
  assert.equal(saved.state.html, html)
  // Remount the conversation from the persisted snapshot, as when reopening Design.
  await page.evaluate(() => (window as any).renderDesignState(null))
  await page.getByTestId("design-reasoning").waitFor({ state: "detached" })
  await page.evaluate((state) => (window as any).renderDesignState(state), saved.state)
  const history = page.getByTestId("design-reasoning")
  await history.waitFor()
  assert.equal(await history.getByLabel("模型思考内容").count(), 0, "history starts collapsed")
  await history.getByRole("button", { name: "思考", exact: true }).click()
  await history.getByLabel("模型思考内容").filter({ hasText: "继续检查配色" }).waitFor()

  manager.create({ id: "ds_questions", meta: { id: "ds_questions", title: "提问思考", createdAt: 1, updatedAt: 1 }, state: createDesignState(), workspacePath: null })
  manager.start({ requestId: "questions", designSessionId: "ds_questions", kind: "questions", prompt: "创建销售看板" })
  await Promise.resolve()
  await live.getByLabel("模型响应状态").filter({ hasText: "等待模型响应" }).waitFor()
  assert.equal(await live.getByLabel("问题生成进度").innerText(), "已生成 0 个问题")
  emit({ type: "model_activity", activity: { scope: "questions-ai" } })
  await live.getByLabel("模型响应状态").filter({ hasText: "已收到响应" }).waitFor()
  assert.match(await live.getByLabel("模型实时输出").innerText(), /正在整理需求/)
  assert.equal(await live.getByLabel("问题生成进度").innerText(), "已生成 0 个问题")
  sendReasoning("先梳理需求中的信息缺口，")
  sendReasoning("再生成与业务相关的问题。")
  await reasoning.getByLabel("模型思考内容").filter({ hasText: "先梳理需求中的信息缺口，再生成与业务相关的问题。" }).waitFor()
  const firstQuestion = { id: "scope", type: "text", label: "需要哪些页面？" }
  const secondQuestion = { id: "audience", type: "text", label: "面向哪些用户？" }
  emit({ type: "token", token: '<question-form>{"questions":[{"id":"scope"' })
  await live.getByText("正在生成问题", { exact: true }).waitFor()
  assert.equal(await live.getByLabel("问题生成进度").innerText(), "已生成 0 个问题", "partial JSON is not a generated question")
  emit({ type: "question", question: firstQuestion })
  await live.getByLabel("问题生成进度").filter({ hasText: "已生成 1 个问题" }).waitFor()
  emit({ type: "question", question: firstQuestion })
  emit({ type: "question", question: secondQuestion })
  await live.getByLabel("问题生成进度").filter({ hasText: "已生成 2 个问题" }).waitFor()
  assert.doesNotMatch(await live.innerText(), /question-form|等待可显示的模型输出/)
  const questionsSnapshot = store.get("ds_questions")!
  await page.evaluate(() => (window as any).renderDesignState(null))
  await live.waitFor({ state: "detached" })
  await page.evaluate((state) => (window as any).renderDesignState(state), questionsSnapshot.state)
  await live.getByLabel("模型响应状态").filter({ hasText: "已收到响应" }).waitFor()
  assert.equal(await live.getByLabel("问题生成进度").innerText(), "已生成 2 个问题")
  await reasoning.getByRole("button", { name: "思考", exact: true }).click()
  await reasoning.getByLabel("模型思考内容").filter({ hasText: "先梳理需求中的信息缺口" }).waitFor()
  if (process.env.DESIGN_QUESTIONS_SCREENSHOT) await page.screenshot({ path: process.env.DESIGN_QUESTIONS_SCREENSHOT })
  emit({ type: "done", questions: [firstQuestion, secondQuestion] })
  finish()
  await live.waitFor({ state: "detached" })
  await page.getByTestId("design-reasoning").getByRole("button", { name: "思考", exact: true }).click()
  await page.getByLabel("模型思考内容").filter({ hasText: "先梳理需求中的信息缺口" }).waitFor()
  assert.equal(store.get("ds_questions")!.state.messages.at(-1)!.reasoning, "先梳理需求中的信息缺口，再生成与业务相关的问题。")

  for (const mode of ["Comment", "Draw"]) {
    const id = `ds_patch_${mode}`
    manager.create({ id, meta: { id, title: mode, createdAt: 1, updatedAt: 1 },
      state: { ...createDesignState(), html }, workspacePath: null })
    manager.start({ requestId: id, designSessionId: id, kind: "patch", prompt: "放大标题",
      patch: { targets: [], variationId: null, artifactRevision: 0 } })
    await Promise.resolve()
    emit({ type: "model_activity", activity: { scope: id, reasoning: "先检查标题与容器尺寸" } })
    await reasoning.getByLabel("模型思考内容").filter({ hasText: "先检查标题与容器尺寸" }).waitFor()
    emit({ type: "token", token: '{"protocol":"design-patch/1"}', displayText: false })
    emit({ type: "token", token: "候选修改：将标题字号调整为 24px\n" })
    emit({ type: "patch_status", patchStatus: { phase: "validating", message: "正在校验局部修改与页面交互" } })
    await live.getByLabel("模型实时输出").filter({ hasText: "候选修改：将标题字号调整为 24px" }).waitFor()
    assert.match(await live.innerText(), /正在检查页面/)
    assert.doesNotMatch(await live.innerText(), /design-patch\/1/)
    assert.equal(await reasoning.getByLabel("模型思考内容").count(), 0, `${mode} response collapses thinking`)
    emit({ type: "error", error: "修改产生横向溢出：document（视口 390px）" })
    finish()
    await live.waitFor({ state: "detached" })
    await delivery
    const rejected = store.get(id)!
    assert.equal(rejected.state.html, html)
    await page.evaluate(() => (window as any).renderDesignState(null))
    await page.getByText("候选修改：将标题字号调整为 24px", { exact: true }).waitFor({ state: "detached" })
    await page.evaluate((state) => (window as any).renderDesignState(state), rejected.state)
    await page.getByText("候选修改：将标题字号调整为 24px", { exact: true }).waitFor()
    await page.getByText(/修改产生横向溢出.*视口 390px/).waitFor()
  }
  assert.deepEqual(errors, [])
  console.log("PASS: Design shows reasoning, question progress and Comment/Draw responses, preserving rejected candidates in history")
} finally {
  await browser.close()
  db.close()
}
