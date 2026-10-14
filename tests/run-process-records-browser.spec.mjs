import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = process.cwd()
const renderer = resolve("src/renderer/src")
const output = resolve("output/run-process-20261012", `records-${Date.now()}`)
mkdirSync(output, { recursive: true })
const compiled = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{FunctionLogs}from './src/renderer/src/components/chat/FunctionLogs';
    import{ModsAudit}from './src/renderer/src/components/customize/ModsAudit';
    import{ModsChatScope}from './src/renderer/src/lib/mods-chat-scope';
    const root=createRoot(document.getElementById('root'));
    const changes=new Set(),config=new Set(); window.pending=[];window.calls=[];
    window.api={mods:{logs:id=>new Promise((resolve,reject)=>{window.calls.push(['logs',id]);window.pending.push({id,resolve,reject})}),
      onCardsChanged:fn=>{changes.add(fn);return()=>changes.delete(fn)},onConfigurationChanged:fn=>{config.add(fn);return()=>config.delete(fn)},
      audit:(id,cursor,workspace)=>new Promise(resolve=>{window.calls.push(['audit',id,workspace]);window.pending.push({id,workspace,resolve})})}};
    window.emit=scope=>changes.forEach(fn=>fn({threadId:'a',scope}));
    window.render=(id,enabled=true,workspace=id)=>root.render(<ModsChatScope.Provider value={{threadId:id,enabled}}><FunctionLogs key={id} threadId={id} showEmpty/><ModsAudit threadId={id} expectedWorkspace={workspace}/></ModsChatScope.Provider>);
    window.render('a');`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  define: { "process.env.NODE_ENV": '"production"' }
})
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
})
const errors = []
const checks = []
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(e.message))
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  await page.waitForFunction(() => window.pending.length === 1)
  assert.deepEqual(await page.evaluate(() => window.calls), [["logs", "a"]])
  await page.evaluate(() => window.pending.shift().reject(Error("unavailable")))
  await page.getByRole("alert").filter({ hasText: "不代表任务没有执行" }).waitFor()
  await page.getByRole("button", { name: "重新读取日志" }).click()
  await page.waitForFunction(() => window.pending.length === 1)
  await page.evaluate(() =>
    window.pending.shift().resolve([{ id: "one", plugin: "review", text: "已读取材料" }])
  )
  await page.getByText("已读取材料", { exact: false }).waitFor()
  checks.push("Read error differs from empty logs; explicit read retry does not execute a task")
  const count = await page.evaluate(() => window.calls.length)
  await page.evaluate(() => {
    window.emit("panes")
    window.emit("site-redraw:owner")
  })
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.calls.length), count)
  await page.evaluate(() => window.emit("records"))
  await page.waitForFunction(() => window.pending.length === 1)
  assert(await page.getByText("已读取材料", { exact: false }).isVisible())
  await page.evaluate(() => {
    window.render("b")
  })
  await page.waitForFunction(() => window.pending.length === 2)
  await page.evaluate(() => {
    window.render("a")
  })
  await page.waitForFunction(() => window.pending.length === 3)
  await page.evaluate(() => {
    window.pending[0].resolve([{ id: "old-a", plugin: "old", text: "禁止回流A" }])
    window.pending[1].resolve([{ id: "old-b", plugin: "old", text: "禁止串入B" }])
    window.pending[2].resolve([])
    window.pending = []
  })
  await page.getByText("尚无灵件主动提供的日志；这不表示任务没有执行。", { exact: true }).waitFor()
  assert.equal(await page.getByText(/禁止回流|禁止串入/).count(), 0)
  checks.push(
    "Scoped delayed A→B→A replies discarded; record refresh keeps painted logs; unrelated redraws ignored"
  )
  await page.getByText("项目调用记录 · 包含本项目其他聊天", { exact: true }).click()
  await page.waitForFunction(() => window.pending.length === 1)
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ["audit", "a", "a"])
  await page.evaluate(() => window.render("a", true, "new-workspace"))
  await page.getByText("项目调用记录 · 包含本项目其他聊天", { exact: true }).click()
  await page.waitForFunction(() => window.pending.length === 2)
  await page.evaluate(() => {
    const row = {
      callId: "obsolete",
      toolId: "旧项目不可见",
      status: "succeeded",
      publication: "published",
      startedAt: 1,
      ruleIds: [],
      originalArgsHash: "old"
    }
    window.pending[0].resolve([row])
    window.pending[1].resolve([])
    window.pending = []
  })
  await page.getByText("暂无执行记录。", { exact: true }).waitFor()
  assert.equal(await page.getByText("旧项目不可见").count(), 0)
  const beforeDisabled = await page.evaluate(() => window.calls.length)
  await page.evaluate(() => {
    window.render("a", false, "new-workspace")
    window.emit("records")
  })
  await page.waitForTimeout(100)
  assert.equal(await page.locator("[data-function-logs]").count(), 0)
  // A queued event before React commits may trigger one read; after commit there is no subscriber.
  const afterCommit = await page.evaluate(() => window.calls.length)
  await page.evaluate(() => window.emit("records"))
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.calls.length), afterCommit)
  assert(afterCommit <= beforeDisabled + 1)
  checks.push(
    "Project audit is explicitly cross-chat and workspace-bound; disabling logs removes subscriptions"
  )
  assert.deepEqual(errors, [])
  writeFileSync(
    resolve(output, "result.json"),
    JSON.stringify({ passed: true, checks, errors }, null, 2)
  )
  console.log(JSON.stringify({ passed: true, output, checks }))
} finally {
  await browser.close()
}
