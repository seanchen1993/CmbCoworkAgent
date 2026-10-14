import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve, join } from "node:path"
import { existsSync, writeFileSync, readdirSync } from "node:fs"
const output = resolve("output/sparks-remediation-20261010/product")
const contents = `
import React from 'react';import{createRoot}from'react-dom/client';
import{DevelopmentReusePanel}from${JSON.stringify(resolve("src/renderer/src/components/customize/DevelopmentReusePanel.tsx"))};
const root=createRoot(document.getElementById('root')), calls=[],changed=new Set();let outcome='partial',reconciled=!!window.restarted,key=0,ready=false;
const doc={id:'formal',name:'Counter',workspace:'c:/isolated',revision:1,currentRevision:1,updatedAt:1,source:{schemaVersion:1,digest:'a'.repeat(64),files:[]},versions:[]};
const candidate={handle:'handle',installationId:'install',versionId:'version',name:'Counter',sourceDigest:doc.source.digest,compiledDigest:'b'.repeat(64),catalogDigest:'c'.repeat(64),configuration:'unchanged'};
const state={threadId:'thread',workspace:doc.workspace,enabled:true,drafts:[{id:'draft',name:'Counter',revision:2,digest:doc.source.digest}],trials:[{componentId:'component',draftId:'draft',phase:window.restarted?'stopped':'active'}]};
window.api={mods:{development:{status:async()=>{calls.push(['development.status']);return structuredClone(state)},onChanged:fn=>{changed.add(fn);return()=>changed.delete(fn)},stop:async input=>{calls.push(['stop',input]);state.trials[0].phase='stopped';return structuredClone(state)}},authoring:{read:async()=>structuredClone(doc)},onConfigurationChanged:()=>()=>{},
authoringInstall:{resolveInstalled:async input=>{calls.push(['resolveInstalled',input]);return{ok:true,value:reconciled?candidate:null}},prepare:async input=>{calls.push(['prepare',input]);return{ok:true,value:candidate}},apply:async input=>{calls.push(['apply',input]);return{ok:true,value:{operationId:'op',installationId:'install',versionId:'version',state:outcome}}},cancel:async()=>({ok:true}),
list:async()=>{calls.push(['list']);return{ok:true,value:{workspace:doc.workspace,installations:[{installationId:'install',name:'Counter',versions:[{versionId:'version',sourceDigest:doc.source.digest,compiledDigest:candidate.compiledDigest,revision:1,createdAt:1}],...(reconciled?{currentVersionId:'version'}:{pending:{operationId:'op',state:outcome,reason:'storage-failed'}})}]}}},
inspectUncertain:async input=>{calls.push(['inspect',input]);return{ok:true,value:{operationId:'op',installationId:'install',originalState:outcome,catalog:'after',configuration:'unchanged',observedVersionId:'version',inspectionDigest:'d'.repeat(64),canAccept:true}}},
reconcile:async input=>{calls.push(['reconcile',input]);reconciled=true;return{ok:true,value:{state:'reconciled',operationId:'op'}}}},
status:async()=>{calls.push(['mods.status']);return{workspace:doc.workspace,functionMods:[{pluginId:'install',name:'Counter',digest:candidate.compiledDigest,state:ready?'ready':'needs-approval'}]}},approveFunction:async()=>{calls.push(['grant']);ready=true}
},threads:{create:async()=>{calls.push(['create']);return{thread_id:'new'}}}};
const mount=()=>root.render(<DevelopmentReusePanel key={++key} threadId='thread' document={doc} origin={{id:'draft',revision:2,digest:doc.source.digest}} onOpenThread={async id=>calls.push(['open',id])}/>);
window.probe={calls,setOutcome:v=>outcome=v,refresh:()=>{changed.forEach(fn=>fn({threadId:'thread'}));window.dispatchEvent(new Event('mods:configuration-changed'))},remount:mount,expire:()=>{state.drafts[0].digest='z'.repeat(64);changed.forEach(fn=>fn({threadId:'thread'}))}};mount();`
const bundle = await build({
  stdin: { contents, loader: "tsx", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic"
})
const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  }),
  results = {}
try {
  for (const outcome of ["partial", "unknown"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }),
      errors = []
    page.setDefaultTimeout(5000)
    page.on("pageerror", (e) => errors.push(e.message))
    await page.route("**/*", (r) => r.abort())
    await page.setContent('<div id="root"></div>')
    const assets = resolve("out/renderer/assets"),
      css = readdirSync(assets).find((n) => /^index-.*\.css$/.test(n))
    if (css) await page.addStyleTag({ path: join(assets, css) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.evaluate((v) => window.probe.setOutcome(v), outcome)
    const click = (name) => page.getByRole("button", { name, exact: true }).click()
    await click("停止此试用并继续正式复用")
    await click("准备安装当前版本")
    await click("确认安装此版本")
    await click("刷新安装记录")
    await click("查看上次中断的结果")
    await click("确认保留当前状态")
    await click("刷新安装记录")
    await page.getByText("当前版本：version", { exact: true }).waitFor()
    await page.getByRole("button", { name: "授权此正式版本", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "授权此正式版本", exact: true }).isEnabled(),
      false
    )
    await page.evaluate(() => window.probe.refresh())
    await page.waitForTimeout(100)
    const beforeRemount = {
      authorizationButtons: await page.getByRole("button", { name: "授权此正式版本" }).count(),
      continuationButtons: await page.getByRole("button", { name: "核对当前 Claw 组合" }).count(),
      text: await page.locator("body").innerText()
    }
    await page.evaluate(() => window.probe.remount())
    await page.getByRole("heading", { name: /保存并正式复用/ }).waitFor()
    await click("刷新安装记录")
    await page.getByText("当前版本：version", { exact: true }).waitFor()
    const afterRemount = {
      authorizationButtons: await page.getByRole("button", { name: "授权此正式版本" }).count(),
      text: await page.locator("body").innerText()
    }
    await page.screenshot({
      path: join(output, "reuse-" + outcome + "-reconciled.png"),
      fullPage: true
    })
    assert.equal(beforeRemount.authorizationButtons, 1)
    assert.equal(afterRemount.authorizationButtons, 1)
    const calls = await page.evaluate(() => window.probe.calls)
    for (const name of ["stop", "prepare", "apply", "inspect", "reconcile"])
      assert.equal(calls.filter((row) => row[0] === name).length, 1, name)
    assert.equal(calls.filter((row) => row[0] === "grant").length, 0)
    assert.equal(calls.filter((row) => row[0] === "create").length, 0)
    await page.getByRole("checkbox", { name: "我已核对这个正式版本及以上权限" }).check()
    await click("授权此正式版本")
    await page.getByRole("button", { name: "核对当前 Claw 组合" }).waitFor()
    await page.evaluate(() => window.probe.expire())
    await page.getByText("此复用计划已过期，请重新选择当前开发版本。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "核对当前 Claw 组合" }).count(), 0)
    assert.deepEqual(errors, [])
    results[outcome] = { errors, beforeRemount, afterRemount, calls }
    await page.close()
  }
  const restartPage = await browser.newPage()
  await restartPage.route("**/*", (r) => r.abort())
  await restartPage.setContent('<div id="root"></div>')
  await restartPage.evaluate(() => (window.restarted = true))
  await restartPage.addScriptTag({ content: bundle.outputFiles[0].text })
  await restartPage.getByRole("button", { name: "授权此正式版本", exact: true }).waitFor()
  const restartCalls = await restartPage.evaluate(() => window.probe.calls)
  assert.equal(
    restartCalls.some((row) => ["stop", "prepare", "apply", "grant", "create"].includes(row[0])),
    false
  )
  results.restart = { calls: restartCalls }
  await restartPage.close()
  writeFileSync(join(output, "reuse-recovery-result.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
}
