/** Real React comparison/review-intent controls. Native facts only; no executable preview facade. */
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, ".."),
    output = resolve(root, "output/stage-debug-comparison-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectStageDebugComparisonCard} from './src/renderer/src/components/customize/ProjectStageDebugComparisonCard';
      import {ProjectStageDebugPanel} from './src/renderer/src/components/customize/ProjectStageDebugPanel';
      const root=createRoot(document.getElementById('root')),calls=[],pending=[];
      let intentId='intent-1';
      window.api={mods:{development:{onChanged:()=>()=>{}}}};
      const branch=id=>({id,projectId:id,sourceProjectId:'original',snapshotId:'snapshot-'+id,candidateDigest:'c'.repeat(64),currentCandidateMatches:true,stageId:'review',mode:'stage',status:'passed',diagnostics:[]});
      const compare=input=>{calls.push(['compare',input]);return new Promise(resolve=>pending.push({input,resolve}))};
      const show=(id,blocked=false)=>root.render(<ProjectStageDebugComparisonCard key={id} threadId={'creator-'+id} branch={branch(id)} compare={compare} blocked={blocked}/>);
      const resolveComparison=(index,unavailable=false)=>{if(unavailable){const item=pending[index];item.resolve({status:'unavailable',projectId:item.input.projectId,snapshotId:'snapshot-'+item.input.projectId,candidateDigest:'c'.repeat(64),baselineSourceDigest:'b'.repeat(64),baselineCreatedAt:1,observedAt:2,counts:{added:0,deleted:0,modified:0,unchanged:0},files:[],diagnostics:['文件不稳定，未返回部分比较']});return;}const item=pending[index];item.resolve({status:'available',projectId:item.input.projectId,snapshotId:'snapshot-'+item.input.projectId,candidateDigest:'c'.repeat(64),baselineSourceDigest:'b'.repeat(64),baselineCreatedAt:1,observedAt:2,fingerprint:'d'.repeat(64),counts:{added:120,deleted:0,modified:0,unchanged:1},files:Array.from({length:120},(_,n)=>({path:'out/file-'+n+'.md',change:'added',beforeSha256:null,afterSha256:'f'.repeat(64),beforeBytes:null,afterBytes:n,binary:false})),diagnostics:['当前观察，不代表业务通过']})};
      const preview={list:async threadId=>({threadId,workspace:'C:/creator',drafts:[{id:'first',name:'first',revision:1,digest:'a'.repeat(64)},{id:'second',name:'second',revision:2,digest:'b'.repeat(64)}]}),stageDebug:{list:async()=>({snapshots:[{id:'first-snapshot',projectId:'original',stageId:'draft',stageTitle:'first',sourceDigest:'x',createdAt:1,fileCount:0,totalBytes:0},{id:'second-snapshot',projectId:'original',stageId:'review',stageTitle:'second',sourceDigest:'x',createdAt:2,fileCount:1,totalBytes:1}],branches:[],diagnostics:[]}),prepare:async input=>{calls.push(['prepare',input]);return {id:'preparation',snapshotId:input.snapshotId,sourceProjectId:'original',stageId:'review',mode:input.mode,candidateDigest:input.expectedDigest,affectedStageIds:['review'],canCreate:true,diagnostics:[]}},create:async input=>{calls.push(['create',input]);return {projectId:'never-auto'}}}};
      const review=()=>root.render(<ProjectStageDebugPanel key='review' threadId='creator' workspace='C:/creator' preview={preview} onOpenProject={()=>{}} stageDebugReview={{id:intentId,threadId:'creator',workspace:'C:/creator',incarnation:{token:'native',legacyCreatedAt:1},snapshotId:'second-snapshot',draftId:'second',revision:2,candidateDigest:'b'.repeat(64),mode:'downstream',caller:{name:'第三方阶段调试Mod',digest:'e'.repeat(64)},expiresAt:Date.now()+60000}}/>);
      window.fixture={calls,show,resolveComparison,review,nextReview:()=>{intentId='intent-2';review()}};
      show('A');
    `
    }
  })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" })
  }
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const compare = page.getByRole("button", { name: "比较阶段输入与当前文件", exact: true })
    await compare.waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.length"), 0)
    await compare.click()
    await page.evaluate("window.fixture.show('B')")
    await compare.waitFor()
    await page.evaluate("window.fixture.resolveComparison(0)")
    await compare.click()
    await page.evaluate("window.fixture.resolveComparison(1)")
    await page
      .getByText("文件内容变化：新增 120，删除 0，修改 0，未变 1。", { exact: true })
      .waitFor()
    const table = page.getByRole("table", { name: "阶段输入文件变化清单", exact: true })
    assert.equal(await table.locator("tbody tr").count(), 50)
    await page.getByRole("button", { name: /再显示 50 项/ }).click()
    assert.equal(await table.locator("tbody tr").count(), 100)
    assert.equal(await page.getByText("snapshot-A", { exact: false }).count(), 0)
    await page.getByText("输入快照标识：snapshot-B", { exact: true }).waitFor()
    assert.equal(await page.getByText("整轮试用已通过", { exact: true }).count(), 0)
    await page.evaluate("window.fixture.show('B',true)")
    assert.equal(await compare.isDisabled(), true)
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='compare').length"),
      2
    )

    await page.evaluate("window.fixture.show('C')")
    await compare.waitFor()
    await compare.click()
    await page.evaluate("window.fixture.resolveComparison(2,true)")
    await page
      .getByText("比较不可用；未返回部分文件清单，不能据此判断文件没有变化。", { exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole("table", { name: "阶段输入文件变化清单", exact: true }).count(),
      0
    )
    assert.equal(await page.getByText(/文件内容变化：新增 0/).count(), 0)

    await page.evaluate("window.fixture.review()")
    const panel = page.getByRole("region", { name: "阶段隔离调试", exact: true })
    await page.waitForFunction(() =>
      [...document.querySelectorAll("select")].some((select) => select.value === "second-snapshot")
    )
    assert.equal(
      await panel.getByLabel("选择阶段输入快照", { exact: true }).inputValue(),
      "second-snapshot"
    )
    assert.equal(
      await panel.getByLabel("选择已保存的最新候选", { exact: true }).inputValue(),
      "second"
    )
    assert.equal(await panel.getByLabel("调试范围", { exact: true }).inputValue(), "downstream")
    await panel.getByText("建议来自 Mod：第三方阶段调试Mod", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(row=>row[0]==='prepare'||row[0]==='create').length"
      ),
      0,
      "A native review intent must only preselect and never approve or create"
    )
    await panel.getByRole("button", { name: "准备阶段调试方案", exact: true }).click()
    await panel.getByRole("checkbox").check()
    await page.evaluate("window.fixture.nextReview()")
    await panel
      .getByRole("region", { name: "阶段调试原生确认", exact: true })
      .waitFor({ state: "detached" })
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='create').length"),
      0
    )
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: resolve(output, "comparison-and-review-intent.png"),
      fullPage: true
    })
    console.log(
      "PASS explicit hash comparison, bounded rows, stale scope isolation and non-authorizing Mod review intent"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
