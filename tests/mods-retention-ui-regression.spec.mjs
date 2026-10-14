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
import React from 'react';import {createRoot} from 'react-dom/client';
import {AuthoringInstallPanel} from ${JSON.stringify(resolve("src/renderer/src/components/customize/AuthoringInstallPanel.tsx"))};
const root=createRoot(document.getElementById('root')),calls=[];let workspace='C:/isolated/A',retry=false,fail=false,hold=false,finish,linked=false;
const row=(id,reason,canRetire)=>({versionId:id,installationId:'install',workspace:'C:/isolated/old-project',name:'Counter',revision:1,createdAt:1,canRetire,reason});
const inspection=()=>({fingerprint:'fp',usedVersions:16,limit:16,usedBytes:1048576,byteLimit:4194304,protectedArtifacts:1,versions:[row('current','current',false),row('rollback','rollback',false),row('unknown','uncertain',false),{...row('old',retry?'cleanup-failed':'eligible',true),...(linked?{requiredVersionIds:['old','linked']}: {})},...(linked?[{...row('linked','eligible',true),requiredVersionIds:['old','linked']}]:[])],pendingVersionIds:retry?['old']:[],retiredVersions:0});
const api={inspectRetention:async input=>{calls.push(['inspect',input]);if(hold){hold=false;await new Promise(r=>finish=r)}return{ok:true,value:inspection()}},retireVersions:async input=>{calls.push(['retire',input]);if(fail){fail=false;return{ok:false,code:'STALE'}}retry=!retry;return{ok:true,value:retry?inspection():{...inspection(),usedVersions:15,versions:inspection().versions.filter(v=>v.versionId!=='old'),retiredVersions:1}}}};
const mount=()=>root.render(<AuthoringInstallPanel api={api} threadId='thread' workspace={workspace} dirty={false} document={{id:'draft',name:'Counter',workspace,currentRevision:1,source:{digest:'a'.repeat(64),files:[]}}}/>);
window.fixture={calls,fail:()=>fail=true,hold:()=>hold=true,finish:()=>finish(),linked:()=>linked=true,switch:()=>{workspace='C:/isolated/B';mount()}};mount();`
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
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => route.abort())
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByText("查看空间用量，清理旧版本", { exact: true }).click()
  const read = () => page.getByRole("button", { name: "刷新空间用量", exact: true }).click()
  const old = () => page.getByRole("checkbox", { name: "清理版本 old", exact: true })
  const consent = () =>
    page.getByRole("checkbox", {
      name: "我已核对所选项目和版本，确认永久删除，之后不能恢复到这些旧版本",
      exact: true
    })
  const retire = () => page.getByRole("button", { name: "永久删除所选旧版本（1）", exact: true })
  await read()
  await page.getByText("所有项目合计：16 / 16 个版本", { exact: true }).waitFor()
  await page.getByText("文件与记录占用：1.00 / 4.00 MiB", { exact: true }).waitFor()
  await page.getByText(/个位置用于待核查准备证据/).waitFor()
  for (const id of ["current", "rollback", "unknown"])
    assert.equal(
      await page.getByRole("checkbox", { name: `清理版本 ${id}`, exact: true }).isDisabled(),
      true
    )
  await old().check()
  assert.equal(await retire().isDisabled(), true)
  await consent().check()
  await retire().click()
  await page.getByText("此版本已不能恢复，文件清理尚待确认，可重试", { exact: true }).waitFor()
  assert.equal(await old().isChecked(), false)
  assert.equal(await consent().isChecked(), false)
  await old().check()
  await consent().check()
  await retire().click()
  await page.getByText("所有项目合计：15 / 16 个版本", { exact: true }).waitFor()
  assert.equal(await old().count(), 0)
  const calls = await page.evaluate(() => window.fixture.calls)
  assert.equal(calls.filter((row) => row[0] === "retire").length, 2)
  for (const [, input] of calls.filter((row) => row[0] === "retire")) {
    assert.equal(input.expectedWorkspace, "C:/isolated/A")
    assert.equal(input.expectedFingerprint, "fp")
    assert.deepEqual(input.versionIds, ["old"])
    assert.equal(input.acknowledgeLostRollback, true)
  }
  await read()
  await old().check()
  await consent().check()
  await page.evaluate(() => window.fixture.fail())
  await retire().click()
  await page.getByRole("alert").filter({ hasText: "清理状态未确认" }).waitFor()
  assert.equal(await old().count(), 0)
  await page.evaluate(() => window.fixture.hold())
  await read()
  await page.evaluate(() => window.fixture.switch())
  await page.evaluate(() => window.fixture.finish())
  await page.getByText("查看空间用量，清理旧版本", { exact: true }).click()
  assert.equal(await old().count(), 0)
  await read()
  await old().waitFor()
  assert.equal(
    (await page.evaluate(() => window.fixture.calls)).at(-1)[1].expectedWorkspace,
    "C:/isolated/B"
  )
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.fixture.linked())
  await read()
  await old().check()
  const linked = page.getByRole("checkbox", { name: "清理版本 linked", exact: true })
  assert.equal(await linked.isChecked(), true)
  assert.equal(await consent().isChecked(), false)
  await linked.uncheck()
  assert.equal(await old().isChecked(), false)
  await old().check()
  await consent().check()
  await page.getByRole("button", { name: "永久删除所选旧版本（2）", exact: true }).click()
  await page.getByText("部分旧版本的清理结果尚不确定，请查看下方结果，再选择需要重试的版本。", { exact: true }).waitFor()
  const linkedRequest = (await page.evaluate(() => window.fixture.calls)).filter(row => row[0] === "retire").at(-1)[1]
  assert.deepEqual(linkedRequest.versionIds, ["old", "linked"])
  writeFileSync(
    join(output, "retention-ui-result.json"),
    JSON.stringify({ errors, calls: await page.evaluate(() => window.fixture.calls) }, null, 2)
  )
  await page.screenshot({ path: join(output, "retention-ui.png"), fullPage: true })
  console.log(
    "PASS retention UI: protected versions, explicit consent, partial cleanup retry, stale response, scope lifetime"
  )
} finally {
  await browser.close()
}
