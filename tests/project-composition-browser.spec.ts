/** Actual React UI with deterministic IPC fixtures; no native business execution. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/project-composition-browser")
  mkdirSync(output, { recursive: true })
  const compiled = await build({
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: "tsconfig.web.json",
    define: { "process.env.NODE_ENV": '"test"' },
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ProjectCompositionPanel} from './src/renderer/src/components/harness-board/ProjectCompositionPanel';
      const scope={projectId:'project',threadId:'thread',expectedWorkspace:'C:/fixture'};
      const entries=[{source:{pluginId:'plugin',capabilityId:'check',packageDigest:'a'.repeat(64)},sourceName:'示例插件',title:'文档检查',kind:'flow',available:true,reasons:[],inputs:[],outputs:[{id:'report',title:'检查报告',path:'report.json'}]},
      {source:{pluginId:'plugin',capabilityId:'flow',packageDigest:'a'.repeat(64)},sourceName:'示例插件',title:'完整审核流程',kind:'flow',available:true,reasons:[],inputs:[{id:'document',title:'待审核报告',required:true}],outputs:[]}];
      const calls=[];let definition,run,deferPreview=false,finishPreview,legacyApproval=false,toolItems=[],failTool=true;
      entries[0].workflow={config:{templates:[{id:'custom',templateType:'custom',label:'自选步骤',requiredNodes:['dev.code','ops.archive'],nodes:[],description:''}],nodes:[{id:'dev.specs',label:'规格设计'},{id:'dev.code',label:'代码开发'},{id:'ops.archive',label:'归档'}]},nodes:[]};
      entries.push({source:{pluginId:'skills',capabilityId:'summary',packageDigest:'b'.repeat(64)},sourceName:'写作插件',title:'资料摘要',kind:'capability',available:true,reasons:[],inputs:[],outputs:[]});
      entries.push({source:{pluginId:'checks',capabilityId:'base',packageDigest:'c'.repeat(64)},sourceName:'检查插件',title:'基础检查',kind:'capability',available:true,reasons:[],inputs:[],outputs:[]});
      let retry=null,retryFinish,catalogTimeout=false,retryBusy=false;
      let profile={revision:'one',contextKey:'project',sources:[]},failApply=true,binary=false;
      const api={catalog:async s=>{if(catalogTimeout){catalogTimeout=false;throw Error("CAPABILITY_PACKAGE_TIMEOUT")}return ({revision:'r',contextKey:s.projectId,projectName:s.projectId,entries})},
        openWorkspace:async i=>{calls.push(['workspace',i]);if(window.fixture.workspaceUnavailable)throw Error('COMPOSITION_EXECUTION_WORKSPACE_MISSING');return {path:'C:/host-owned/run/unit'}},
        readLegacyDecision:async()=>retry,
        decideLegacyDecision:async i=>{calls.push(['retry',i]);if(retryBusy){retryBusy=false;throw Error('COMPOSITION_CATALOG_BUSY')}return new Promise(r=>retryFinish=ok=>{retry=null;r({applied:ok,message:ok?'业务决定已提交':'这条业务决定已过期，请核对当前运行。'})})},
        readToolApprovals:async()=>toolItems,
        respondToolApproval:async i=>{calls.push(['toolApproval',i]);if(failTool){failTool=false;throw Error('stale request')}toolItems=[]},
        readCapabilities:async s=>({...profile,contextKey:s.projectId}),
        previewCapabilities:async i=>{calls.push(['capPreview',i]);return {id:'capPreview',contextKey:i.scope.projectId,sources:[...i.sources,entries[3].source],addedSources:[entries[3].source],issues:[]}},
        applyCapabilities:async i=>{calls.push(['capApply',i]);if(failApply){failApply=false;throw Error('CAPABILITY_SOURCE_CHANGED')}profile={revision:'two',contextKey:i.scope.projectId,sources:[entries[2].source,entries[3].source]};return profile},
        preview:async i=>{calls.push(['preview',i]);definition=i.definition;const p={id:'preview',contextKey:i.scope.projectId,definition,addedUnitIds:[],issues:[]};if(deferPreview)return new Promise(r=>finishPreview=()=>r(p));return p},
        start:async i=>{calls.push(['start',i]);run={id:'run',requestId:i.requestId,version:1,definition,definitionDigest:'d',status:'waiting-approval',units:definition.units.map((u,j)=>({id:u.id,status:j?'pending':'waiting-approval'})),createdAt:1,updatedAt:1};return run},
        read:async()=>run,resume:async()=>({...run,status:'failed',version:run.version+1,units:run.units.map((u,j)=>j?{...u,status:'failed',reason:'COMPOSITION_HANDOFF_UNVERIFIED'}:{...u,status:'succeeded',proof:{kind:'flow-completed',engineRunId:'engine',evidenceDigest:'a'.repeat(64),artifacts:[{id:'report',path:'report.json',digest:'b'.repeat(64)}]}})}),cancel:async()=>({...run,status:'cancelled',version:3}),
        readArtifact:async i=>{calls.push(['artifact',i]);return {path:'report.json',title:'检查报告',content:binary?null:'<script>window.untrustedExecuted=true</script> 原始检查结果',message:'二进制文件暂不支持文本预览。'}},
        waitingApproval:async()=>legacyApproval?({kind:'legacy-human-gate',unitId:definition.units[0].id,gateId:'original-gate',projectId:'internal-project',featureId:'internal-feature',sourceThreadId:'internal-thread',message:'请核对原流程部署检查，拒绝后不得继续。'}):({unitId:definition.units[0].id,operationId:'original-op',operationVersion:7,inputFingerprint:'original-input',stageTitle:'人工审查',checks:['格式检查已通过'],artifacts:['检查报告']}),
        approve:async i=>{calls.push(['approve',i]);return {...run,version:run.version+1}}};
      let root=createRoot(document.getElementById('root'));const render=s=>root.render(<ProjectCompositionPanel scope={s} api={api}/>);render(scope);
      window.fixture={calls,tool:(allow)=>{toolItems=[{unitId:definition.units[0].id,requestId:'native-request',operation:allow?'write_file':'git_commit',filePath:'C:/fixture/report.md',cwd:'C:/fixture',allow}]},legacyApproval:()=>{legacyApproval=true;run.version=8},binary:()=>{binary=true},reopen:()=>{root.unmount();root=createRoot(document.getElementById('root'));render(scope)},defer:()=>{deferPreview=true},switch:()=>render({...scope,projectId:'other',threadId:'other'}),finish:()=>finishPreview()};
      window.fixture.catalogTimeout=()=>{catalogTimeout=true};
      window.fixture.retryBusy=()=>{retryBusy=true};
      window.fixture.retry=()=>{retry={unitId:definition.units[0].id,notificationId:'original-retry',message:'原检查尚未通过，请决定如何继续。',humanGatePending:false};run.version++;window.fixture.reopen()};
      window.fixture.finishRetry=ok=>retryFinish(ok);
      window.fixture.unknown=()=>{run={...run,status:'unknown',version:run.version+1,units:run.units.map(u=>({...u,status:'unknown',reason:'AUTOBIZ_COMMIT_UNKNOWN'}))};window.fixture.reopen()};
      window.fixture.emptySuccess=()=>{run={...run,status:'succeeded',units:run.units.map(u=>({...u,status:'succeeded',proof:{kind:'flow-completed',engineRunId:'engine',evidenceDigest:'a'.repeat(64),artifacts:[]}})),definition:{...definition,units:definition.units.map(u=>({...u,outputs:[]}))}};window.fixture.reopen()};
    `
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(20000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/**", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
    )
    await page.goto("http://localhost/")
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    const assets = resolve("out/renderer/assets")
    const css =
      existsSync(assets) && readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
    assert(css, "Existing renderer CSS is needed for the 375px layout check")
    await page.addStyleTag({ path: join(assets, css) })
    const callsBeforeGuide = await page.evaluate("window.fixture.calls.length")
    await page.getByText("第一次使用？看一个完整例子", { exact: true }).click()
    const guide = page.getByLabel("项目组合操作演示")
    await guide.getByRole("button", { name: "先开发，再生成验收报告", exact: true }).click()
    for (let step = 0; step < 3; step++)
      await guide.getByRole("button", { name: "下一个演示步骤", exact: true }).click()
    await guide.getByText("① 检查失败：空购物车测试未通过", { exact: true }).waitFor()
    await guide.getByRole("button", { name: "下一个演示步骤", exact: true }).click()
    await guide.getByText("查看结果：需求、修改内容、测试结论", { exact: true }).waitFor()
    assert(await guide.getByRole("button", { name: "下一个演示步骤", exact: true }).isDisabled())
    assert.equal(await page.evaluate("window.fixture.calls.length"), callsBeforeGuide)
    await page.getByText("第一次使用？看一个完整例子", { exact: true }).click()
    await page.getByRole("checkbox", { name: "在对话中使用 资料摘要 · 写作插件" }).check()
    await page.getByRole("button", { name: "预览对话能力", exact: true }).click()
    await page.getByText("基础检查 · 检查插件（自动补齐的必要能力）").waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='capApply').length"), 0)
    await page.getByRole("button", { name: "确认应用对话能力", exact: true }).click()
    await page.getByText("插件来源、配置或运行状态已变化。", { exact: true }).waitFor()
    assert.equal(
      await page.getByText("CAPABILITY_SOURCE_CHANGED", { exact: true }).isVisible(),
      false
    )
    await page.getByRole("alert").getByText("技术详情", { exact: true }).click()
    await page.getByText("CAPABILITY_SOURCE_CHANGED", { exact: true }).waitFor()
    assert.equal(
      await page.getByText("项目对话能力已应用。后续消息将使用已确认的能力配置。").count(),
      0
    )
    await page.getByRole("button", { name: "确认应用对话能力", exact: true }).click()
    await page.getByText("项目对话能力已应用。后续消息将使用已确认的能力配置。").waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.find(c=>c[0]==='capApply')[1].expectedRevision"),
      "one"
    )
    await page.getByRole("button", { name: "添加 文档检查 · 示例插件" }).click()
    await page.getByRole("combobox", { name: /执行范围/ }).selectOption("custom")
    assert(await page.getByRole("checkbox", { name: "代码开发（必需）" }).isDisabled())
    assert(await page.getByRole("checkbox", { name: "归档（必需）" }).isChecked())
    await page.getByRole("checkbox", { name: "规格设计" }).check()
    await page.getByRole("textbox", { name: "这次要做什么" }).fill("检查项目资料并输出可审核报告。")
    await page.getByRole("button", { name: "添加 完整审核流程 · 示例插件" }).click()
    assert(await page.getByRole("button", { name: "检查并预览组合" }).isDisabled())
    await page.getByRole("combobox", { name: /待审核报告/ }).selectOption({ index: 1 })
    await page.getByRole("button", { name: "保存流程草稿" }).click()
    await page.getByText("流程草稿已保存在本机，尚未启动运行。").waitFor()
    await page.evaluate("window.fixture.reopen()")
    await page.getByRole("button", { name: "检查并预览组合" }).click()
    await page.getByRole("region", { name: "项目组合预览" }).waitFor()
    await page.getByText("任务：检查项目资料并输出可审核报告。", { exact: true }).waitFor()
    await page.getByText("实际执行步骤：规格设计 → 代码开发 → 归档", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.calls.find(c=>c[0]==='preview')[1].definition.units[0].workflow"),
      { templateId: "custom", nodeIds: ["dev.specs", "dev.code", "ops.archive"] })
    await page.getByText(/的“检查报告”，由原流程验证后交接/).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(output, "preview-375.png"), fullPage: true })
    await page.getByRole("button", { name: "确认并启动" }).click()
    await page.getByRole("region", { name: "原流程审批" }).waitFor()
    assert.equal(await page.getByRole("button", { name: /^打开运行文件夹 / }).count(), 1)
    await page.evaluate("window.fixture.reopen()")
    await page.getByRole("region", { name: "原流程审批" }).waitFor()
    await page.evaluate("window.fixture.tool(true)")
    await page.getByRole("region", { name: "原工具操作确认" }).waitFor()
    await page.getByRole("button", { name: "允许本次操作", exact: true }).click()
    await page
      .getByText("确认未提交，原操作可能已变化。请核对当前请求后重试。", { exact: true })
      .waitFor()
    await page.getByRole("button", { name: "允许本次操作", exact: true }).click()
    const toolApproval = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='toolApproval').at(-1)[1]"
    )
    assert.equal(toolApproval.requestId, "native-request")
    assert.equal(toolApproval.decision, "allow")
    assert.equal(toolApproval.threadId, undefined)
    assert.equal(toolApproval.filePath, undefined)
    await page.evaluate("window.fixture.tool(false)")
    await page.getByText("操作：git_commit", { exact: true }).waitFor()
    assert(await page.getByRole("button", { name: "允许本次操作", exact: true }).isDisabled())
    await page.getByRole("button", { name: "拒绝本次操作", exact: true }).click()
    assert.equal(
      await page.evaluate(
        "window.fixture.calls.filter(c=>c[0]==='toolApproval').at(-1)[1].decision"
      ),
      "deny"
    )
    await page.getByRole("button", { name: "批准此阶段" }).click()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='approve').length"), 0)
    await page.getByRole("button", { name: "确认批准", exact: true }).click()
    const approval = await page.evaluate("window.fixture.calls.find(c=>c[0]==='approve')[1]")
    assert.equal(approval.operationId, "original-op")
    assert.equal(approval.expectedVersion, 7)
    assert.equal(approval.inputFingerprint, "original-input")
    await page.evaluate("window.fixture.legacyApproval();window.fixture.reopen()")
    await page.getByText("请核对原流程部署检查，拒绝后不得继续。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "拒绝此阶段" }).click()
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='approve').length"), 1)
    await page.getByRole("button", { name: "确认拒绝", exact: true }).click()
    const legacy = await page.evaluate("window.fixture.calls.filter(c=>c[0]==='approve').at(-1)[1]")
    assert.equal(legacy.kind, "legacy-human-gate")
    assert.equal(legacy.gateId, "original-gate")
    assert.equal(legacy.expectedVersion, 8)
    assert.equal(legacy.decision, "rejected")
    assert.equal(legacy.projectId, undefined)
    assert.equal(legacy.featureId, undefined)
    assert.equal(legacy.sourceThreadId, undefined)
    await page.evaluate("window.fixture.retry()")
    await page.getByText("原检查尚未通过，请决定如何继续。", { exact: true }).waitFor()
    const retainedRun = await page.getByRole("region", { name: "项目组合运行过程" }).innerText()
    const retainedLocal = await page.evaluate("JSON.stringify(localStorage)")
    await page.evaluate("window.fixture.catalogTimeout()")
    await page.getByRole("button", { name: "刷新能力目录", exact: true }).click()
    await page.getByText("能力目录核对暂时超时，最新状态尚未确认。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("region", { name: "项目组合运行过程" }).innerText(),
      retainedRun
    )
    assert.equal(await page.evaluate("JSON.stringify(localStorage)"), retainedLocal)
    await page.evaluate("window.fixture.retryBusy()")
    await page.getByRole("button", { name: "在当前会话继续", exact: true }).click()
    await page
      .getByRole("alert")
      .getByText("能力目录核对暂时超时，最新状态尚未确认。", { exact: true })
      .first()
      .waitFor()
    await page.getByText("原检查尚未通过，请决定如何继续。", { exact: true }).waitFor()
    assert.equal(await page.evaluate("JSON.stringify(localStorage)"), retainedLocal)
    assert.equal(
      await page.getByText("插件来源、配置或运行状态已变化。", { exact: true }).count(),
      0
    )
    await page.getByRole("button", { name: "刷新能力目录", exact: true }).click()

    await page.getByRole("button", { name: "在当前会话继续", exact: true }).click()
    assert(await page.getByRole("button", { name: "终止运行", exact: true }).isDisabled())
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='retry').length"), 2)
    const retryInput = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='retry').at(-1)[1]"
    )
    assert.equal(retryInput.scope.projectId, "project")
    assert.equal(retryInput.notificationId, "original-retry")
    assert.equal(retryInput.action, "continue")
    assert.equal(retryInput.expectedVersion, 9)
    await page.evaluate("window.fixture.finishRetry(false)")
    await page
      .getByRole("alert")
      .getByText("这条业务决定已过期，请核对当前运行。", { exact: true })
      .first()
      .waitFor()
    await page
      .getByRole("button", { name: "在当前会话继续", exact: true })
      .waitFor({ state: "detached" })
    await page.evaluate("window.fixture.retry()")
    await page.getByRole("button", { name: "开启新会话", exact: true }).click()
    await page.evaluate("window.fixture.finishRetry(true)")
    await page
      .getByText("业务决定已提交。请核对并恢复，让原流程继续检查。", { exact: true })
      .waitFor()
    await page
      .getByRole("button", { name: "开启新会话", exact: true })
      .waitFor({ state: "detached" })
    await page.getByRole("button", { name: "核对并恢复" }).click()
    await page.getByText("运行过程 · 执行失败", { exact: true }).waitFor()
    await page.getByText("结果文件或交接资料未通过核对。", { exact: true }).waitFor()
    assert.equal(
      await page.getByText("COMPOSITION_HANDOFF_UNVERIFIED", { exact: true }).isVisible(),
      false
    )
    assert.equal(await page.getByText("运行过程 · 已完成", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: /^打开运行文件夹 / }).count(), 2)
    await page.getByRole("button", { name: /^打开运行文件夹 / }).last().click()
    const folderInput = await page.evaluate("window.fixture.calls.filter(c=>c[0]==='workspace').at(-1)[1]")
    assert.deepEqual(Object.keys(folderInput).sort(), ["runId", "scope", "unitId"])
    assert.equal(folderInput.scope.projectId, "project")
    assert.equal(folderInput.runId, "run")
    await page.getByRole("button", { name: /^查看结果 / }).click()
    await page
      .getByRole("dialog")
      .getByText(/原始检查结果/)
      .waitFor()
    assert.equal(await page.evaluate("window.untrustedExecuted"), undefined)
    assert.equal(
      await page.evaluate("window.fixture.calls.find(c=>c[0]==='artifact')[1].artifactId"),
      "report"
    )
    await page.keyboard.press("Escape")
    await page.evaluate("window.fixture.binary()")
    await page.getByRole("button", { name: /^查看结果 / }).click()
    await page.getByText("二进制文件暂不支持文本预览。").waitFor()
    await page.keyboard.press("Escape")
    await page.evaluate("window.fixture.emptySuccess()")
    await page.getByText("运行过程 · 已完成", { exact: true }).waitFor()
    assert.equal(await page.getByText("此流程未声明可交接的结果文件，可在运行文件夹中查看。", { exact: true }).count(), 2)
    assert.equal(await page.getByRole("button", { name: /^查看结果 / }).count(), 0)
    await page.getByRole("button", { name: /^打开运行文件夹 / }).first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, "workspace-results-375.png"), fullPage: true })
    await page.getByRole("button", { name: /^打开运行文件夹 / }).first().click()
    await page.evaluate("window.fixture.workspaceUnavailable=true")
    await page.getByRole("button", { name: /^打开运行文件夹 / }).first().click()
    await page.getByText("暂时无法打开本步骤的运行文件夹。", { exact: true }).waitFor()
    assert.equal(await page.getByText("运行过程 · 已完成", { exact: true }).count(), 1)
    const startsBeforeUnknown = await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='start').length"
    )
    await page.evaluate("window.fixture.unknown()")
    await page.getByText("运行过程 · 恢复待确认", { exact: true }).waitFor()
    await page.getByText("运行结果尚未确认。", { exact: true }).first().waitFor()
    await page
      .getByText("先查看原任务状态和已产生的结果，再核对恢复；不要直接重新启动可能已执行的操作。", {
        exact: true
      })
      .first()
      .waitFor()
    assert.equal(
      await page.getByText("AUTOBIZ_COMMIT_UNKNOWN", { exact: true }).first().isVisible(),
      false
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"),
      startsBeforeUnknown
    )
    await page.evaluate("window.fixture.defer()")
    await page.getByRole("button", { name: "检查并预览组合" }).click()
    await page.evaluate("window.fixture.switch();window.fixture.finish()")
    await page.getByText("other · 项目能力", { exact: true }).waitFor()
    assert.equal(await page.getByRole("region", { name: "项目组合预览" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: /^移除 / }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS project composition browser: 375px, draft, explicit handoff, preview confirmation, bound original approval, failure, late response"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
