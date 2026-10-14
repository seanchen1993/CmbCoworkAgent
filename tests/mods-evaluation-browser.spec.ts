import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build, type Plugin } from "esbuild"
import { mount as mountFlow } from "./mods-flow-browser.spec"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/mods-harness-20261009", `evaluation-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/customize/EvaluationPanel.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import{createRoot}from"react-dom/client";
    import{EvaluationPanel}from${JSON.stringify(entry)};
    const root=createRoot(document.getElementById("root")),calls=[];
    let deferred=false,finish,rows=[],key=0;
    const flow=id=>({definition:{schemaVersion:2,id,name:id,execution:{kind:"host",profile:"workspace-files-v1"},maxExecutions:5},revision:1,digest:(id==="baseline"?"a":"b").repeat(64)});
    const summary=(passed,unknown)=>({total:1,passed,failed:0,unknown,cancelled:0,confirmedPassRate:passed,metrics:{}});
    const report=(state="complete",workspace="c:/owned/workspace")=>({id:"evaluation",workspace,threadId:"thread",createdAt:1,state,provider:"controlled",tasks:[{id:"task-1",goal:"<img src=x onerror=alert(1)> fixed task"}],budget:{timeoutMs:300000,maxExecutions:10},baseline:{name:"baseline",digest:"a".repeat(64),cases:[]},candidate:{name:"candidate",digest:"b".repeat(64),cases:[{caseId:"task-1",runId:"flow-1",result:"passed",evidenceIds:["evidence"],durationMs:12,modelCalls:2,humanTakeovers:1,inputTokens:null,outputTokens:null}]},comparison:{comparable:false,reasons:["observation-incomplete"],scope:"controlled-runtime-validation",baseline:summary(0,1),candidate:summary(1,0),confirmedPassRateDelta:null,regressions:[],improvements:[],unresolved:["task-1"],recommendation:"incomparable",canAutoApply:false},reasons:[]});
    const api={list:async thread=>({ok:true,value:{workspace:thread==="next"?"next-workspace":"c:/owned/workspace",evaluations:thread==="next"?[]:rows}}),
      start:async input=>{calls.push(["start",input]);if(deferred)return await new Promise(resolve=>finish=()=>{rows=[report("running")];resolve({ok:true,value:rows[0]})});rows=[report("running")];return{ok:true,value:rows[0]}},
      cancel:async input=>{calls.push(["cancel",input]);rows=[report("cancelled")];return{ok:true,value:undefined}}};
    const flowApi={flowList:async()=>[flow("baseline"),flow("candidate")],flowRun:async()=>null,flowDecide:async()=>{calls.push(["approve"]);throw Error("must not autoapprove")}};
    window.electron={process:{platform:"win32"}};window.api={mods:flowApi};
    const mount=(thread="thread",workspace="C:/Owned/Workspace",connected=true)=>root.render(<EvaluationPanel key={++key} threadId={thread} workspace={workspace} api={connected?api:undefined} flowApi={flowApi} onOpenCandidate={digest=>calls.push(["open-candidate",digest])}/>);
    window.fixture={calls,mount,foreign:()=>{rows=[report("complete","other-workspace")]},defer:()=>deferred=true,finish:()=>finish(),report:()=>{rows=[report()]},clear:()=>{rows=[];deferred=false;calls.length=0}};mount();
  `
    },
    bundle: true,
    jsx: "automatic",
    write: false,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    logLevel: "warning"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 960 } })
    const pageErrors: string[] = []
    page.on("pageerror", (error) => {
      pageErrors.push(error.message)
      console.error(error.message)
    })
    const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><head><meta charset="utf-8"><style>body{font:14px system-ui;background:#faf9f6;color:#222;margin:24px}section{max-width:1100px}header,p,label,article{margin-bottom:16px}select,textarea,input,button{font:inherit;border:1px solid #bbb;border-radius:6px;padding:8px;background:white}textarea{display:block;width:96%;min-height:88px}button{margin-right:8px}button:disabled{opacity:.5}label{display:block}article{padding:18px;border:1px solid #ddd;border-radius:8px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}td:first-child{max-width:220px;overflow-wrap:anywhere}p{line-height:1.5}</style></head><body><div id="root"></div><script>${script}</script></body></html>`
      })
    )
    await page.goto("http://fixture.test")
    await page.getByText("比较流程效果", { exact: true }).waitFor()
    await page
      .getByText(
        "测试不会替你安装功能或批准操作。需要确认时会暂停，检查结果不足时不会判定哪套更好。",
        { exact: true }
      )
      .waitFor()
    assert.equal(await page.getByText(/仅项目测试脚本的结果计入通过率/).isVisible(), false)
    await page.getByText("查看比较规则", { exact: true }).click()
    assert.equal(await page.getByText(/模型自评不计分；缺失结果仍计入任务总数/).isVisible(), true)
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls.length
      ),
      0
    )
    await page.getByLabel("原流程").selectOption("baseline")
    await page.getByLabel("新流程").selectOption("candidate")
    await page
      .getByLabel("固定任务（每行一个，最多 5 个）")
      .fill("Task one\nTask two\nTask three\nTask four\nTask five\nTask six")
    assert(await page.getByRole("button", { name: "开始比较" }).isDisabled())
    await page.getByLabel("固定任务（每行一个，最多 5 个）").fill("Fixed task")
    await page.evaluate(() => (window as unknown as { fixture: { defer(): void } }).fixture.defer())
    await page.getByRole("button", { name: "开始比较" }).click()
    assert(await page.getByRole("button", { name: "开始比较" }).isDisabled())
    const calls = await page.evaluate(
      () => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls
    )
    assert.equal(calls.length, 1)
    const request = (
      calls[0] as [
        string,
        { expectedWorkspace: string; tasks: unknown[]; budget: { maxExecutions: number } }
      ]
    )[1]
    assert.equal(request.expectedWorkspace, "c:/owned/workspace")
    assert.equal(request.tasks.length, 1)
    assert.equal(request.budget.maxExecutions, 10)
    await page.evaluate(() =>
      (window as unknown as { fixture: { finish(): void } }).fixture.finish()
    )
    await page.getByRole("button", { name: "取消本次评测" }).click()
    await page.getByText("已取消", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { fixture: { calls: string[][] } }).fixture.calls.filter(
            (call) => call[0] === "approve"
          ).length
      ),
      0
    )
    await page.evaluate(() =>
      (window as unknown as { fixture: { report(): void } }).fixture.report()
    )
    await page.getByRole("button", { name: "读取记录" }).click()
    await page.getByText(/受控服务验证（不代表真实模型效果）/).waitFor()
    assert(await page.getByText(/观测不完整或条件不同，不可比较/).isVisible())
    assert.equal(await page.locator("img").count(), 0)
    await page.getByRole("button", { name: "打开候选流程（使用或编辑）" }).click()
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { fixture: { calls: string[][] } }).fixture.calls.find(
            (call) => call[0] === "open-candidate"
          )?.[1]
      ),
      "b".repeat(64)
    )
    await page.screenshot({ path: join(output, "evaluation-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 540, height: 960 })
    await page.screenshot({ path: join(output, "evaluation-narrow.png"), fullPage: true })
    await page.evaluate(() =>
      (window as unknown as { fixture: { foreign(): void } }).fixture.foreign()
    )
    await page.getByText("项目、流程版本或运行状态已改变，请重新读取。").waitFor()
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          fixture: {
            clear(): void
            mount(thread?: string, workspace?: string): void
            defer(): void
          }
        }
      ).fixture
      fixture.clear()
      fixture.defer()
      fixture.mount()
    })
    await page.getByLabel("原流程").selectOption("baseline")
    await page.getByLabel("新流程").selectOption("candidate")
    await page.getByLabel("固定任务（每行一个，最多 5 个）").fill("Delayed task")
    await page.getByRole("button", { name: "开始比较" }).click()
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          fixture: { mount(thread: string, workspace: string): void; finish(): void }
        }
      ).fixture
      fixture.mount("next", "next-workspace")
      fixture.finish()
    })
    await page.getByLabel("比较流程效果").waitFor()
    assert.equal(await page.getByLabel("评测报告").count(), 0)
    await page.evaluate(() =>
      (
        window as unknown as {
          fixture: { mount(thread: string, workspace: string, connected: boolean): void }
        }
      ).fixture.mount("thread", "c:/owned/workspace", false)
    )
    await page.getByText("评测执行接口尚未接通。").waitFor()
    assert.equal(await page.getByRole("button", { name: "开始比较" }).count(), 0)
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "host canonical workspace accepted; cross-workspace result rejected",
            "no automatic model run",
            "bounded task count",
            "explicit start and duplicate prevention",
            "owned cancellation without autoapproval",
            "controlled unknown evidence display and text escaping",
            "stale scope result discarded",
            "missing backend exposes no fake run",
            "explicit candidate navigation uses exact digest without execution",
            "candidate exact version opens editor",
            "missing candidate never substitutes another version"
          ]
        },
        null,
        2
      )
    )
    const flowPlugins: Plugin[] = []
    await mountFlow(
      page,
      "host.render(<FlowsPanel threadId='a' initialDigest='digest-1'/>);",
      flowPlugins
    )
    await page.getByText("已打开评测候选版本；使用或保存仍需显式操作。").waitFor()
    assert.equal(await page.getByLabel("流程名称", { exact: true }).inputValue(), "Flow a")
    await mountFlow(
      page,
      "host.render(<FlowsPanel threadId='a' initialDigest='missing'/>);",
      flowPlugins
    )
    await page.getByText("评测候选版本已改变或不存在，请重新选择；不会自动使用其它版本。").waitFor()
    assert.equal(await page.getByLabel("流程名称", { exact: true }).count(), 0)
    assert.deepEqual(pageErrors, [])
    console.log(`PASS evaluation browser: 11 checks; ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
