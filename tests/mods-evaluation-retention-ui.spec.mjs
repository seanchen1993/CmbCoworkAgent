import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
const output = resolve("output/sparks-remediation-20261010/product")
mkdirSync(output, { recursive: true })
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{EvaluationPanel}from${JSON.stringify(resolve("src/renderer/src/components/customize/EvaluationPanel.tsx"))};
const root=createRoot(document.getElementById('root')),calls=[];let fail=false,workspace='C:/isolated/A';
const row=i=>({id:'report-'+i,workspace,threadId:'thread',state:'complete',provider:'controlled',discardDigest:i===0?'digest':undefined,baseline:{name:'base '+i,cases:[]},candidate:{name:'candidate '+i,cases:[]},tasks:[],comparison:{comparable:false,baseline:{confirmedPassRate:0,unknown:0},candidate:{confirmedPassRate:0,unknown:0}}});let rows=Array.from({length:16},(_,i)=>row(i));
const api={list:async()=>({ok:true,value:{workspace,evaluations:structuredClone(rows)}}),discard:async input=>{calls.push(['discard',input]);if(fail){fail=false;return{ok:false,code:'STALE'}}rows=rows.filter(row=>row.id!==input.evaluationId);return{ok:true}}};const flowApi={flowList:async()=>[]};window.api={mods:{}};
const mount=()=>root.render(<EvaluationPanel threadId='thread' workspace={workspace} api={api} flowApi={flowApi}/>);window.fixture={calls,stale:()=>{rows[0].discardDigest='changed'},eligible:()=>{rows[1].discardDigest='second'},fail:()=>fail=true,switch:()=>{workspace='C:/isolated/B';rows=[];mount()}};mount();`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic"
})
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
})
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } }),
    errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/*", (r) => r.abort())
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText(/本会话评测报告：16 \/ 16/).waitFor()
  const choose = () => page.getByRole("button", { name: "清理这份历史报告…", exact: true }).click()
  const confirm = () => page.getByRole("button", { name: "确认永久清理这份报告", exact: true })
  const consent = () =>
    page.getByRole("checkbox", { name: "我确认不再需要这份评测报告及其历史证据", exact: true })
  assert.equal(
    await page.getByRole("button", { name: "清理这份历史报告…", exact: true }).count(),
    1
  )
  await choose()
  assert.equal(await confirm().isDisabled(), true)
  await consent().check()
  await page.evaluate(() => window.fixture.stale())
  await page.getByRole("button", { name: "读取记录", exact: true }).click()
  await page.getByText("报告状态已变化，请重新读取并选择可清理报告。", { exact: true }).waitFor()
  assert.equal(await confirm().isDisabled(), true)
  assert.equal((await page.evaluate(() => window.fixture.calls)).length, 0)
  await page.getByRole("button", { name: "保留报告", exact: true }).click()
  await choose()
  assert.equal(await consent().isChecked(), false)
  await consent().check()
  await confirm().click()
  await page.getByText(/本会话评测报告：15 \/ 16/).waitFor()
  const first = (await page.evaluate(() => window.fixture.calls))[0]
  assert.deepEqual(first, [
    "discard",
    {
      threadId: "thread",
      expectedWorkspace: "C:/isolated/A",
      evaluationId: "report-0",
      expectedDigest: "changed"
    }
  ])
  await page.evaluate(() => window.fixture.eligible())
  await page.getByRole("button", { name: "读取记录", exact: true }).click()
  await choose()
  await consent().check()
  await page.evaluate(() => window.fixture.fail())
  await confirm().click()
  await page.getByText("项目、流程版本或运行状态已改变，请重新读取。", { exact: true }).waitFor()
  assert.equal(await confirm().count(), 0)
  await choose()
  assert.equal(await consent().isChecked(), false)
  await page.evaluate(() => window.fixture.switch())
  await page.getByText(/本会话评测报告：0 \/ 16/).waitFor()
  assert.equal(await confirm().count(), 0)
  assert.deepEqual(errors, [])
  writeFileSync(
    join(output, "evaluation-retention-ui-result.json"),
    JSON.stringify({ errors, calls: await page.evaluate(() => window.fixture.calls) }, null, 2)
  )
  console.log(
    "PASS evaluation retention UI: scope quota, protected reports, confirmation, changed digest, stale retry, workspace reset"
  )
} finally {
  await browser.close()
}
