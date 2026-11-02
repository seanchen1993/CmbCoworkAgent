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
          {state?.liveOutput && <DesignLiveOutput output={state.liveOutput}/>}
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
  assert.deepEqual(errors, [])
  console.log("PASS: Design streams provider/inline reasoning, respects manual and automatic collapse, preserves history and isolates HTML")
} finally {
  await browser.close()
  db.close()
}
