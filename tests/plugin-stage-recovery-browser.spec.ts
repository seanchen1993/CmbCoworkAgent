/** Actual recovery card; deterministic native boundary never edits state or executes scripts. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/plugin-stage-recovery-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundled = await build({
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
      import React from'react';import{createRoot}from'react-dom/client';
      import{PluginStageRecoveryCard}from'./src/renderer/src/components/customize/PluginStageRecoveryCard';
      const root=createRoot(document.getElementById('root')),calls=[];
      const source='creator-business-trial:11111111-1111-4111-8111-111111111111';
      const plan={id:'22222222-2222-4222-8222-222222222222',digest:'d'.repeat(64),sourceId:source,
        stageId:'design',stateMode:'target_in_progress',phase:'needs-confirmation',summary:'原插件规划：归档后续产物',
        affectedArtifacts:['demo/design.md'],diagnostics:[],canApply:true,requiresNetworkApproval:true};
      let current,failApply=false,phase='failed',revision=0;
      const api={latest:async input=>{calls.push(['latest',input]);return current},
        inspect:async input=>{calls.push(['inspect',input]);return{sourceId:input.trialId,packageDigest:'a'.repeat(64),
          adapterDigest:'b'.repeat(64),inputsDigest:'c'.repeat(64),featureId:'demo',stages:[{id:'design',title:'原生技术设计'}],requiresNetworkApproval:true}},
        prepare:async input=>{calls.push(['prepare',input]);current={...plan,sourceId:input.trialId};return current},
        apply:async input=>{calls.push(['apply',input]);if(failApply){current={...plan,phase:'unknown',canApply:false,canReconcile:true};throw Error('LOST_REPLY')}
          current={...plan,phase:'adopted',canApply:false,recoveredTrialId:'recovered',recoveredProjectId:'recovered'};
          return{trialId:'recovered',projectId:'recovered',preparation:current}},
        reconcile:async input=>{calls.push(['reconcile',input]);if(input.allowNetworkSideEffects)current={...plan,phase:'adopted',canApply:false};
          return current}};
      const show=(recovered=false,started=false)=>root.render(<PluginStageRecoveryCard key={++revision}threadId='creator'workspace='C:/owned'
        trial={{id:recovered?'recovered':source,phase,version:1,digest:'e'.repeat(64),planId:'plan',name:'sample',goal:'goal',
          canPrepare:false,canRefresh:true,canStart:false,canStop:false,diagnostics:[],
          ...(recovered?{stageRecovery:{sourceTrialId:source,preparationId:plan.id,started}}:{}),
          journey:{stages:[]}}}api={api}onChanged={()=>calls.push(['changed'])}/>);
      window.fixture={calls,show,fail:()=>{failApply=true},reset:()=>{current=undefined;failApply=false;show()},
        cold:()=>{current={...plan,phase:'unknown',canApply:false,canReconcile:true};show(true)},
        continued:()=>{current=undefined;phase='completed';show(true,true)}};show();
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  const calls = (kind: string) =>
    page.evaluate<number>(`window.fixture.calls.filter(c=>c[0]===${JSON.stringify(kind)}).length`)
  async function prepare() {
    await page.getByRole("button", { name: "检查阶段恢复条件", exact: true }).click()
    const button = page.getByRole("button", { name: "准备插件阶段恢复方案", exact: true })
    await button.waitFor()
    assert.equal(await button.isDisabled(), true)
    await page.getByLabel("恢复起点", { exact: true }).selectOption("design")
    assert.equal(await button.isDisabled(), true)
    await page.getByRole("checkbox", { name: /同意运行本次规划脚本/ }).check()
    await button.click()
    await page.getByText("方案已准备，等待确认", { exact: true }).waitFor()
  }
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("region", { name: "插件阶段恢复", exact: true }).waitFor()
    assert.equal(await calls("prepare"), 0)
    assert.equal(await calls("apply"), 0)
    await prepare()
    const request = await page.evaluate("window.fixture.calls.find(c=>c[0]==='prepare')[1]")
    assert.deepEqual(request, {
      threadId: "creator",
      expectedWorkspace: "C:/owned",
      trialId: "creator-business-trial:11111111-1111-4111-8111-111111111111",
      stageId: "design",
      stateMode: "target_in_progress",
      expectedPackageDigest: "a".repeat(64),
      expectedAdapterDigest: "b".repeat(64),
      expectedInputsDigest: "c".repeat(64),
      allowNetworkSideEffects: true
    })
    checks.push(
      "native inspection, actual stage selection and first separate consent bind exact plan inputs"
    )
    const apply = page.getByRole("button", {
      name: "确认创建恢复后的独立试用（尚不运行）",
      exact: true
    })
    assert.equal(await apply.isDisabled(), true)
    assert.equal(await calls("apply"), 0)
    await page.getByRole("checkbox", { name: /同意此次插件恢复命令/ }).check()
    await apply.click()
    await page.getByText("独立试用已创建，尚需重新配置并批准运行", { exact: true }).waitFor()
    assert.equal(await calls("apply"), 1)
    assert.equal(await calls("changed"), 1)
    checks.push(
      "applying requires new exact-plan consent and returns to native configuration without starting"
    )

    await page.evaluate("window.fixture.reset();window.fixture.fail()")
    await prepare()
    await page.getByRole("checkbox", { name: /同意此次插件恢复命令/ }).check()
    const before = await calls("latest")
    await apply.click()
    await page.getByText("结果尚未确认，禁止重放恢复操作", { exact: true }).waitFor()
    assert.equal(await calls("apply"), 2)
    assert.equal(await calls("latest"), before + 1)
    assert.equal(await apply.count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "准备插件阶段恢复方案", exact: true }).isDisabled(),
      true
    )
    checks.push(
      "lost apply reply reads the persisted native intent once and offers no replay or new plan"
    )
    await page
      .getByRole("button", { name: "只核对恢复执行记录（不运行脚本）", exact: true })
      .click()
    assert.deepEqual(await page.evaluate("window.fixture.calls.find(c=>c[0]==='reconcile')[1]"), {
      threadId: "creator",
      expectedWorkspace: "C:/owned",
      preparationId: "22222222-2222-4222-8222-222222222222",
      expectedDigest: "d".repeat(64)
    })
    const verify = page.getByRole("button", {
      name: "验证并接管已恢复副本（不重放恢复）",
      exact: true
    })
    assert.equal(await verify.isDisabled(), true)
    await page.getByRole("checkbox", { name: /重新运行只读验证脚本/ }).check()
    await verify.click()
    await page.getByText("独立试用已创建，尚需重新配置并批准运行", { exact: true }).waitFor()
    assert.equal(await calls("apply"), 2)
    const reconciles = await page.evaluate<Array<[string, { allowNetworkSideEffects?: boolean }]>>(
      "window.fixture.calls.filter(c=>c[0]==='reconcile')"
    )
    assert.equal(reconciles[1][1].allowNetworkSideEffects, true)
    checks.push(
      "native-only reconciliation and separately approved verification never resend apply"
    )

    await page.evaluate("window.fixture.cold()")
    await page.getByRole("button", { name: "读取已保存的恢复记录", exact: true }).click()
    await page.getByText("结果尚未确认，禁止重放恢复操作", { exact: true }).waitFor()
    const last = await page.evaluate<{ trialId: string }>(
      "window.fixture.calls.filter(c=>c[0]==='latest').at(-1)[1]"
    )
    assert.equal(last.trialId, "creator-business-trial:11111111-1111-4111-8111-111111111111")
    assert.equal(await verify.isDisabled(), true)
    checks.push(
      "cold recovered trial locates original persistent intent without restoring previous consent"
    )
    await page.evaluate("window.fixture.continued()")
    await prepare()
    const nextPlan = await page.evaluate<{ trialId: string }>(
      "window.fixture.calls.filter(c=>c[0]==='prepare').at(-1)[1]"
    )
    assert.equal(
      nextPlan.trialId,
      "recovered",
      "A second recovery must copy current trial outputs, never the original ancestor"
    )
    assert.equal(await calls("apply"), 2, "A new plan does not inherit or replay the prior apply")
    checks.push(
      "a settled recovered child uses its own native source for a freshly approved next recovery"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "plugin-stage-recovery.png"), fullPage: true })
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
