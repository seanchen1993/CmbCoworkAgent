import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/project-composition-e2e", `flow-progress-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React from "react";import{createRoot}from"react-dom/client";
      import{FlowStepProgress}from"./src/renderer/src/components/customize/FlowStepProgress";
      const root=createRoot(document.getElementById("root"));
      let run={id:"run",status:"running",startedAt:Date.now(),currentStepId:"build",flow:{definition:{steps:[
        {id:"plan",name:"整理需求",enabled:true},{id:"build",name:"生成文档",enabled:true},{id:"verify",name:"检查结果",enabled:true}
      ]}},attempts:[{executionId:"old",stepId:"plan",status:"passed",invalidated:true,startedAt:1},
        {executionId:"a",stepId:"plan",status:"passed",startedAt:1,result:{summary:"需求已整理"}},
        {executionId:"b",stepId:"build",status:"running",startedAt:Date.now()-2000,progress:{phase:"model",text:"正在整理订单字段",updatedAt:Date.now()}}]};
      const render=()=>root.render(<FlowStepProgress run={run}/>);render();
      window.fixture={update:()=>{run={...run,attempts:run.attempts.map(a=>a.executionId==='b'?{...a,progress:{phase:'tool',text:'',updatedAt:Date.now()}}:a)};render()},
        fail:()=>{run={...run,status:'failed',attempts:run.attempts.map(a=>a.executionId==='b'?{...a,status:'failed',reason:'缺少订单编号',result:{summary:'请补充订单编号后再运行'}}:a)};render()},
        restart:()=>{run={...run,id:'another',status:'queued',currentStepId:undefined,attempts:[]};render()}};`
    },
    bundle: true,
    write: false,
    jsx: "automatic",
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
    const page = await browser.newPage({ viewport: { width: 420, height: 850 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("http://localhost/flow-progress", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<style>body{font:14px Arial;padding:12px}li{margin:12px 0}summary{cursor:pointer}</style><div id="root"></div>'
      })
    )
    await page.goto("http://localhost/flow-progress")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByText("正在进行：生成文档", { exact: true }).waitFor()
    await page.getByText("已完成 1 / 3 步", { exact: true }).waitFor()
    await page.getByText("查看全部 3 步与结果", { exact: true }).click()
    assert.equal(await page.getByRole("list", { name: "当前步骤进度" }).locator("li").count(), 3)
    await page.getByText("待执行", { exact: true }).waitFor()
    await page.getByText("正在整理订单字段", { exact: true }).first().waitFor()
    await page.evaluate(() =>
      (window as unknown as { fixture: { update(): void } }).fixture.update()
    )
    await page.getByText("正在处理工具操作", { exact: true }).waitFor()
    assert.equal(await page.getByText("正在整理订单字段", { exact: true }).count(), 0)
    await page.evaluate(() => (window as unknown as { fixture: { fail(): void } }).fixture.fail())
    await page.getByText("缺少订单编号", { exact: true }).first().waitFor()
    await page.getByText("请补充订单编号后再运行", { exact: true }).first().waitFor()
    assert.equal(await page.locator("[data-flow-live-progress]").count(), 0)
    await page.screenshot({ path: join(output, "failure-next-action.png") })
    await page.evaluate(() =>
      (window as unknown as { fixture: { restart(): void } }).fixture.restart()
    )
    await page.getByText("正在准备流程", { exact: true }).waitFor()
    await page.getByText("已完成 0 / 3 步", { exact: true }).waitFor()
    assert.equal(await page.getByText("缺少订单编号", { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          errors,
          checks: [
            "all-steps-visible",
            "latest-non-invalidated-attempt",
            "live-public-progress",
            "tool-transition-clears-stale-text",
            "failure-visible-with-repair",
            "new-run-isolation"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS flow progress: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
