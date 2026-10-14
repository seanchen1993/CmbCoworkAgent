import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve(
    "output",
    "mods-harness-20261009",
    `authoring-preview-browser-${Date.now()}`
  )
  mkdirSync(output, { recursive: true })
  const source = resolve("src/renderer/src/components/customize/AuthoringPreviewPanel.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {AuthoringPreviewPanel} from ${JSON.stringify(source)};
    const host=createRoot(document.getElementById('root')),calls=[];let deferred=false,finish,mismatch=false;
    const view=input=>({...input,compiledDigest:'b'.repeat(64),action:input.action.kind,sourceDigest:mismatch?'c'.repeat(64):input.sourceDigest,failures:input.action.kind==='inspect'?0:2,
      commands:[{name:'sample',description:'Sample command'}],tools:[{name:'format',description:'Sample tool'}],checks:{types:true,events:false,sdk:false},diagnostics:[{source:'sdk',message:'部分用法未验证'}],omittedDiagnostics:0,
      result:{text:'<button onclick="window.evil=true">UNTRUSTED</button>'},panes:[{title:'Static pane',text:'静态内容 <a href="javascript:window.evil=true">link</a>'}],paneTextTruncated:false});
    window.api={mods:{authoringPreview:{start:input=>{calls.push(['start',structuredClone(input)]);return deferred?new Promise(resolve=>{finish=()=>resolve(view(input))}):Promise.resolve(view(input))},cancel:async input=>{calls.push(['cancel',input])}}}};
    const show=(thread='a',dirty=false)=>host.render(<AuthoringPreviewPanel threadId={thread} workspace={thread} document={{id:'demo',currentRevision:1,source:{digest:'a'.repeat(64)}}} dirty={dirty}/>);
    window.previewFixture={calls,show,defer:value=>deferred=value,finish:()=>finish(),mismatch:value=>mismatch=value};show('a',true);
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  const checks: string[] = [],
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const css = readdirSync(resolve("out/renderer/assets")).find((name) =>
      /^index-.*\.css$/.test(name)
    )
    if (css) await page.addStyleTag({ path: resolve("out/renderer/assets", css) })
    await page.getByText("请先保存修改，再用样例试用。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "查看可试用的功能" }).isDisabled(), true)
    assert.deepEqual(await page.evaluate("window.previewFixture.calls"), [])
    await page.evaluate("window.previewFixture.show('a',false)")
    await page
      .getByRole("button", { name: "查看可试用的功能" })
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await page
      .getByText("功能列表已准备好。选择一项并输入样例，就可以开始试用。", { exact: true })
      .waitFor()
    assert.equal(
      await page.evaluate("window.previewFixture.calls.filter(c=>c[0]==='start').length"),
      1
    )
    assert.equal(await page.getByText("本次样例输出", { exact: true }).count(), 0)
    checks.push(
      "Dirty source cannot preview; inspection is explicit and does not claim a command ran"
    )
    await page.getByLabel("预览样例输入").fill("sample input")
    await page.getByRole("button", { name: "运行这个样例" }).click()
    await page.getByText("包含 2 次失败或备用处理，请先查看问题再继续。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "UNTRUSTED" }).count(), 0)
    assert.equal(await page.getByRole("link", { name: "link", exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.evil===true"), false)
    await page.screenshot({ path: join(output, "preview-desktop.png"), fullPage: true })
    checks.push("Recovered failures remain visible and guest output/panes are inert text")
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true)
    await page.screenshot({ path: join(output, "preview-narrow.png"), fullPage: true })
    checks.push("Preview report and sample output fit a narrow viewport")
    await page.evaluate("window.previewFixture.defer(true)")
    await page.getByRole("button", { name: "运行这个样例" }).click()
    await page.getByRole("button", { name: "取消试用" }).click()
    await page.getByText("正在取消试用…", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "取消试用" }).isDisabled(), true)
    await page.evaluate("window.previewFixture.finish()")
    await page.getByRole("button", { name: "运行这个样例" }).waitFor({ state: "visible" })
    assert.equal(await page.getByLabel("隔离预览报告").count(), 0)
    checks.push(
      "Explicit cancellation waits for the pending invocation and suppresses a late success"
    )
    await page.getByRole("button", { name: "运行这个样例" }).click()
    await page.evaluate("window.previewFixture.show('b',false)")
    await page.getByRole("button", { name: "查看可试用的功能" }).waitFor()
    await page.evaluate("window.previewFixture.finish()")
    assert.equal(await page.getByLabel("隔离预览报告").count(), 0)
    assert.equal(await page.getByRole("button", { name: "运行这个样例" }).count(), 0)
    assert.equal(
      await page.evaluate("window.previewFixture.calls.filter(c=>c[0]==='cancel').length>=2"),
      true
    )
    checks.push("Scope changes cancel owned preview and discard old results and action catalog")
    await page.evaluate("window.previewFixture.defer(false);window.previewFixture.mismatch(true)")
    await page.getByRole("button", { name: "查看可试用的功能" }).click()
    await page.getByText("预览结果与当前源码不一致，请重新检查。", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("隔离预览报告").count(), 0)
    checks.push("A mismatched source digest cannot become a displayed preview report")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ passed: true, checks }, null, 2))
    console.log(JSON.stringify({ passed: true, checks, artifacts: output }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
