import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

interface FixtureWindow { fixture: { calls: string[]; show(id: string): void; finish(index: number, authorized?: boolean): void } }
async function main() {
  const root = resolve(__dirname, "..")
  const result = await build({ write: false, bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, stdin: { loader: "tsx", resolveDir: root, contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{ProjectActionResults}from'./src/renderer/src/components/harness-board/ProjectActionResults';
      const root=createRoot(document.getElementById('root')),calls=[],pending=[];
      window.api={harnessBoard:{localProjects:{actionResults:async(projectId,operationId)=>{calls.push(projectId);return new Promise(resolve=>pending.push(authorized=>resolve({projectId,operationId,packageVersion:'1.0.0',pluginDigest:'digest',observedAt:1,flowStatus:'complete',message:'这是历史结果，不代表当前文件通过。',actions:[{id:'format',plugin:'公开整理插件',actionId:'format',providerDigest:'digest',authorizedNow:authorized,status:'passed',summary:authorized?'实际完成':null,output:authorized?'结果 '+projectId:null,inputSchema:'{}',outputSchema:'{}',truncated:false}]})))}}}};
      window.fixture={calls,show:id=>root.render(<ProjectActionResults projectId={id} operationId={'op-'+id}/>),finish:(index,authorized=true)=>pending[index](authorized)};
      window.fixture.show('A');
    ` } })
  let browser
  try { browser = await chromium.launch({ headless: true }) }
  catch { browser = await chromium.launch({ headless: true, channel: "msedge" }) }
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 800 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: result.outputFiles[0].text })
    assert.equal(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.calls.length), 0)
    await page.getByRole("button", { name: "查看公开动作结果" }).click()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.show("B"))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish(0))
    assert.equal(await page.getByText("结果 A", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "查看公开动作结果" }).click()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish(1))
    await page.getByText("结果 B", { exact: true }).waitFor()
    await page.getByText("锁定的动作版本与数据结构", { exact: true }).click()
    await page.getByText("输出结构", { exact: true }).waitFor()
    await page.getByRole("button", { name: "更新公开动作结果" }).click()
    assert.equal(await page.getByText("结果 B", { exact: true }).count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finish(2, false))
    await page.getByText(/当前目录未授权此提供者/).waitFor()
    assert.equal(await page.getByText("结果 B", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    const artifacts = resolve(root, "output/project-platform-20261012/browser")
    mkdirSync(artifacts, { recursive: true })
    await page.screenshot({ path: resolve(artifacts, "project-action-results-revoked.png"), fullPage: true })
    console.log("PASS explicit action result reads, stale project response rejected, schema visible, revoked outputs hidden; no execution endpoint")
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
