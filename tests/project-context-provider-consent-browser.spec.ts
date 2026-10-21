/** Actual stage operation UI; native persistence/process behavior has separate integration tests. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(
    root,
    "output/project-context-provider-consent-browser",
    String(Date.now())
  )
  mkdirSync(output, { recursive: true })
  const script = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve(root, "src/renderer/src") },
    loader: { ".md": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "original-stage-consent-boundaries",
        setup(builder) {
          builder.onLoad({ filter: /ProjectFunctionConsent\.tsx$/ }, () => ({
            loader: "tsx",
            contents:
              "import React,{useEffect}from'react';export function ProjectFunctionConsent({onReady}){useEffect(()=>onReady(true),[onReady]);return <p>原生配置已就绪</p>}"
          }))
          builder.onResolve({ filter: /^\.\.\/\.\.\/lib\/store$/ }, () => ({
            path: "fixture-store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "js",
            contents:
              "export const isThreadDeletionPending=()=>false;export const useAppStore={getState:()=>({})}"
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from'react';import{createRoot}from'react-dom/client';
      import{LocalProjectRun}from'./src/renderer/src/components/harness-board/LocalProjectsPanel';
      const root=createRoot(document.getElementById('root')),calls=[];let generation=0,id=0;
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(++id)});
      const view={project:{projectId:'project',name:'有必需上下文的通用任务',goal:'生成受约束的文档',workspace:'C:/fixture',pluginDigest:'a'.repeat(64),
        status:'active',stageIndex:0,version:1,packageVersion:'1.0.0',manifest:{stages:[{id:'draft',title:'起草',approval:'none',actionIds:[]}],
          actions:[],artifacts:[],checks:[]}},operations:[]};
      const copy=()=>JSON.parse(JSON.stringify(view));
      function next(){view.operations=[{operationId:'operation-'+(++generation),expectedVersion:1,status:'prepared',stageId:'draft',
        inputFingerprint:'f'.repeat(64),receipts:[],contextProvider:{protocol:'devclaw.context-text/v1',policyDigest:String(generation%10).repeat(64),
          notice:'本次脚本采用受限执行，可能访问网络，外部效果不能自动撤回。'}}]}
      window.api={mods:{development:{onChanged:()=>()=>{}}},harnessBoard:{localProjects:{
        get:async()=>copy(),versions:async()=>({retainedVersion:'1.0.0',installedVersion:'1.0.0',differences:[],guidance:''}),
        command:async(_id,input)=>{calls.push(input);if(input.kind==='prepare')next();const op=view.operations[0];
          if(input.kind==='approve'){if(input.decision==='approved'){
            if(input.contextProviderApproval?.policyDigest!==op.contextProvider.policyDigest||input.contextProviderApproval?.allowNetworkSideEffects!==true)
              throw Error('CONTEXT_PROVIDER_APPROVAL_REQUIRED');op.approval={decision:'approved',contextProviderApproval:input.contextProviderApproval}
            }else op.status='cancelled'}
          if(input.kind==='start'){if(!op.approval)throw Error('APPROVAL_REQUIRED');op.status='succeeded'}
          return copy()}
      }}};
      window.fixture={calls,next,clear:()=>{view.operations=[]},changePolicy:()=>{view.operations[0].contextProvider.policyDigest='e'.repeat(64)}};
      root.render(<LocalProjectRun projectId='project'onChanged={()=>{}}/>);
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: script.outputFiles[0].text })
    const start = page.getByRole("button", { name: "开始当前阶段", exact: true })
    await start.click()
    const approval = page.getByRole("button", { name: "批准并执行", exact: true })
    const consent = page.getByRole("checkbox", { name: /我已核对本次上下文脚本及其网络/ })
    await consent.waitFor()
    assert.equal(await approval.isDisabled(), true)
    assert.deepEqual(await page.evaluate("window.fixture.calls.map(c=>c.kind)"), ["prepare"])
    assert.equal(
      await page.getByRole("button", { name: "批准，仅检查已有成果", exact: true }).count(),
      0
    )
    await consent.check()
    await approval.click()
    await page.waitForFunction("window.fixture.calls.some(c=>c.kind==='start')")
    const approved = await page.evaluate<Record<string, unknown>>(
      "window.fixture.calls.find(c=>c.kind==='approve')"
    )
    assert.deepEqual(approved.contextProviderApproval, {
      policyDigest: "1".repeat(64),
      allowNetworkSideEffects: true
    })
    checks.push(
      "automatic stages wait for distinct exact operation and policy consent before any model/provider execution"
    )

    await page.evaluate("window.fixture.next()")
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await consent.waitFor()
    assert.equal(await consent.isChecked(), false)
    assert.equal(await approval.isDisabled(), true)
    await consent.check()
    await page.evaluate("window.fixture.changePolicy()")
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    assert.equal(await consent.isChecked(), false)
    assert.equal(await approval.isDisabled(), true)
    checks.push("a new operation or changed policy cannot inherit a prior checkbox approval")

    await page.getByRole("button", { name: "拒绝本次执行", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(c=>c.decision==='rejected')")
    const rejected = await page.evaluate<Record<string, unknown>>(
      "window.fixture.calls.find(c=>c.decision==='rejected')"
    )
    assert.equal(rejected.contextProviderApproval, undefined)
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c.kind==='start').length"), 1)
    checks.push("refusal never grants network permission and cannot start another operation")

    await page.evaluate("window.fixture.clear()")
    await page.getByRole("button", { name: "更新记录", exact: true }).click()
    await page.getByRole("button", { name: "只检查已有成果", exact: true }).click()
    await consent.waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c.kind==='validate').length"),
      0
    )
    assert.equal(await approval.isDisabled(), true)
    checks.push("file-only validation cannot bypass a newly discovered mandatory context provider")
    assert.deepEqual(errors, [])
    await page.screenshot({
      path: resolve(output, "stage-provider-native-consent.png"),
      fullPage: true
    })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } finally {
    await page.close()
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
