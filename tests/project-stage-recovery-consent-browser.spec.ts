/** Real native consent UI; only its original IPC boundaries are deterministic fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/project-stage-recovery-consent-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const script = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    alias: { "@": resolve(root, "src/renderer/src") },
    plugins: [
      {
        name: "bound-native-configuration-form",
        setup(builder) {
          builder.onLoad({ filter: /FunctionUserConfig\.tsx$/ }, () => ({
            loader: "tsx",
            contents: `import React from'react';export function FunctionUserConfig(props){
          return <button onClick={()=>{window.configurationReady=true;props.onSaved()}}>保存原生参数</button>}`
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from'react';import{createRoot}from'react-dom/client';
      import{ProjectStageDebugPanel}from'./src/renderer/src/components/customize/ProjectStageDebugPanel';
      import{ProjectFunctionConsent}from'./src/renderer/src/components/harness-board/ProjectFunctionConsent';
      const root=createRoot(document.getElementById('root')),calls=[];let plan=0,inspect=0;
      window.electron={process:{platform:'win32'}};
      window.api={mods:{development:{onChanged:()=>()=>{}}}};
      const snapshot={id:'snapshot',projectId:'original',stageId:'review',stageTitle:'复核',sourceDigest:'a'.repeat(64),createdAt:1,fileCount:1,totalBytes:10};
      const stageDebug={list:async()=>({snapshots:[snapshot],branches:[{id:'branch',projectId:'branch',sourceProjectId:'original',snapshotId:'snapshot',stageId:'review',mode:'stage',candidateDigest:'b'.repeat(64),currentCandidateMatches:true,status:'unknown',diagnostics:[]}],diagnostics:[]}),
        prepare:async input=>({id:'plan-'+(++plan),snapshotId:input.snapshotId,sourceProjectId:'original',stageId:'review',mode:input.mode,candidateDigest:input.expectedDigest,affectedStageIds:['review'],canCreate:true,diagnostics:[],recovery:{profile:'windows-sandbox',policyDigest:'d'.repeat(64),requiresNetworkApproval:true}}),
        create:async input=>{calls.push(['create',input]);return{projectId:'new-branch'}},
        reconcileHooks:async input=>{calls.push(['inspect',input]);inspect++;return inspect===2?{remaining:1,diagnostics:['检查器需要另行确认'],requiresNetworkInspection:true}:{remaining:0,diagnostics:['宿主终态已核实；整阶段仍须原生核对']}}};
      const preview={stageDebug,list:async()=>({threadId:'chat',workspace:'C:/project',drafts:[{id:'draft',name:'review',revision:1,digest:'b'.repeat(64)}]})};
      const showStage=()=>root.render(<ProjectStageDebugPanel threadId='chat'workspace='C:/project'draftId='draft'preview={preview}onOpenProject={id=>calls.push(['open',id])}/>);
      const showConfig=()=>root.render(<ProjectFunctionConsent projectId='project'version={1}onReady={ready=>calls.push(['ready',ready])}
        api={{config:{},read:async()=>({projectId:'project',projectVersion:1,packageDigest:'a'.repeat(64),workspace:'C:/project',globallyEnabled:false,workspaceEnabled:false,source:{pluginId:'native',name:'configuration-only',digest:'b'.repeat(64),state:'ready',configurationOnly:true,configurationReady:window.configurationReady===true,hasConfiguration:true,capabilities:[],scannedMethods:[],scanIncomplete:false}}),approve:async()=>{calls.push(['forbidden-approve']);throw Error('NATIVE_CONFIGURATION_IS_NOT_GUEST_APPROVAL')}}}/>);
      window.fixture={calls,showStage,showConfig};showConfig();
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByText("此包仅需配置参数，无需代码运行授权。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "允许本包在当前目录运行", exact: true }).count(),
      0
    )
    await page.getByRole("button", { name: "保存原生参数", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(c=>c[0]==='ready'&&c[1]===true)")
    assert.equal(
      await page.evaluate<number>(
        "window.fixture.calls.filter(c=>c[0]==='forbidden-approve').length"
      ),
      0
    )
    checks.push(
      "metadata-only native configuration becomes ready without enabling Mods or approving code"
    )

    await page.evaluate("window.fixture.showStage()")
    const panel = page.getByRole("region", { name: "阶段隔离调试", exact: true })
    await panel.waitFor()
    const prepare = page.getByRole("button", { name: "准备阶段调试方案", exact: true })
    await prepare.click()
    const create = page.getByRole("button", {
      name: "确认创建隔离调试分支（尚不执行）",
      exact: true
    })
    const general = page.getByRole("checkbox", { name: /我已核对输入、候选和范围/ })
    const network = page.getByRole("checkbox", {
      name: /我已核对本次命令 Hooks 的网络与外部副作用/
    })
    await general.check()
    assert.equal(await create.isDisabled(), true)
    assert.equal(
      await page.evaluate<number>("window.fixture.calls.filter(c=>c[0]==='create').length"),
      0
    )
    await network.check()
    await create.click()
    await page.waitForFunction("window.fixture.calls.some(c=>c[0]==='create')")
    const created = await page.evaluate<Record<string, unknown>>(
      "window.fixture.calls.find(c=>c[0]==='create')[1]"
    )
    assert.deepEqual(created, {
      threadId: "chat",
      preparationId: "plan-1",
      expectedDigest: "b".repeat(64),
      recoveryApproval: { policyDigest: "d".repeat(64), allowNetworkSideEffects: true }
    })
    checks.push(
      "command recovery needs two separate exact native confirmations and creates without starting"
    )
    await prepare.click()
    await network.waitFor()
    assert.equal(await network.isChecked(), false)
    assert.equal(await general.isChecked(), false)
    checks.push("preparing another branch does not reuse either previous approval")

    await page.getByText("隔离调试结果与来源对照（1）", { exact: true }).click()
    const inspect = page.getByRole("button", { name: "核对 Hooks 真实结果", exact: true })
    await inspect.click()
    await page.getByText("仍待核实的 Hook：0", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.calls.find(c=>c[0]==='inspect')[1]"), {
      threadId: "chat",
      projectId: "branch"
    })
    checks.push("native outcome inspection requests no network permission and never runs the Hook")
    await inspect.click()
    const external = page.getByRole("checkbox", { name: /我同意本次原生恢复检查器核对外部结果/ })
    await external.waitFor()
    assert.equal(await inspect.isDisabled(), true)
    await external.check()
    await inspect.click()
    const inspections = await page.evaluate<Array<[string, Record<string, unknown>]>>(
      "window.fixture.calls.filter(c=>c[0]==='inspect')"
    )
    assert.equal(inspections.length, 3)
    assert.equal(inspections[2][1].approveNetworkInspection, true)
    assert.equal(
      await page.evaluate<number>("window.fixture.calls.filter(c=>c[0]==='create').length"),
      1
    )
    checks.push(
      "external inspector requires its own new consent and cannot create or rerun a branch"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "recovery-consent.png"), fullPage: true })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } catch (error) {
    writeFileSync(
      resolve(output, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          errors,
          body: await page.locator("body").innerText(),
          calls: await page.evaluate("window.fixture?.calls")
        },
        null,
        2
      )
    )
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
