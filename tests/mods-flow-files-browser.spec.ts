import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output", `flow-files-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const component = resolve(
    process.env.FLOW_FILES_COMPONENT ??
      "src/renderer/src/components/customize/FlowFilePublicationView.tsx"
  )
  const traceComponent = resolve(component, "../FlowTraceView.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {FlowFilePublicationView} from ${JSON.stringify(component)};
    import {FlowTraceView} from ${JSON.stringify(traceComponent)};
    const root=createRoot(document.getElementById("root")),calls=[];
    let state="unpublished",defer=false,finish,key=0;
    const review=()=>({runId:"run",runDigest:"a".repeat(64),reviewDigest:"b".repeat(64),state,
      canPublish:true,changeCount:1,limited:false,changes:[{path:"answer.txt",kind:"replace",bytes:6,preview:"edited"}],
      operations:state==="unknown"?[{id:"op",kind:"workspace-writeback",state:"unknown",recoveryDirectory:"C:/owned/backup"}]:[]});
    window.api={mods:{flowFileReview:async(...args)=>{calls.push(["review",...args]);return review()},
      flowFilePublish:async input=>{calls.push(["publish",input]);if(defer)return new Promise(resolve=>finish=()=>resolve({state:"published"}));return{state:input.kind==="export"?"exported":"published"}},
      flowFileCancel:async(...args)=>{calls.push(["cancel",...args])}}};
    const show=(profile="workspace-files-v1",status="complete")=>root.render(<FlowFilePublicationView key={++key} run={{id:"run",threadId:"thread",status,flow:{definition:{schemaVersion:2,execution:{profile}}}}}/>);
    window.api.optimizer={getTraceDetail:async id=>{calls.push(["trace",id]);return id==="parent"?null:{traceId:id,threadId:"child",outcome:"success",durationMs:3,nodes:[{id:"node",type:"tool",name:"virtual_write",status:"success"}]}}};
    const trace=()=>root.render(<FlowTraceView key={++key} parentThreadId="thread" attempt={{telemetry:{traceId:"child-trace",childThreadId:"child",rootTraceId:"parent"}}}/>);
    window.fixture={calls,show,trace,setState:value=>state=value,defer:()=>defer=true,finish:()=>finish()};show();
  `
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
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>'
      })
    )
    await page.goto("http://localhost/")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const inspect = page.getByRole("button", { name: "读取成果与发布记录" })
    await inspect.click()
    assert.equal(await page.getByRole("button", { name: "确认写回项目" }).isDisabled(), true)
    assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='publish').length"), 0)
    checks.push("Reading results never publishes; writeback requires explicit confirmation")
    await page.getByRole("button", { name: "导出完整补丁" }).click()
    await page.getByRole("status").filter({ hasText: "项目文件未改变" }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.find(c=>c[0]==='publish')[1].kind"),
      "export"
    )
    checks.push("Export uses the inspected digest and does not claim workspace writeback")
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "确认写回项目" }).click()
    await page.getByRole("status").filter({ hasText: "已写回审阅内容" }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='publish').at(-1)[1].runDigest"),
      "a".repeat(64)
    )
    checks.push("Explicit writeback sends both run and content review digests")
    await page.evaluate("window.fixture.setState('unknown')")
    await inspect.click()
    await page.getByText("恢复目录：C:/owned/backup", { exact: false }).waitFor()
    assert.equal(await page.getByRole("button", { name: "确认写回项目" }).isDisabled(), true)
    await page.screenshot({ path: join(output, "recovery.png"), fullPage: true })
    checks.push("Unknown publication exposes retained recovery directory and blocks retry")
    await page.evaluate("window.fixture.setState('unpublished');window.fixture.defer()")
    await inspect.click()
    await page.getByRole("checkbox").check()
    await page.getByRole("button", { name: "确认写回项目" }).click()
    await page.evaluate("window.fixture.show('prompt-only-v1')")
    await page.waitForFunction("window.fixture.calls.some(c=>c[0]==='cancel')")
    await page.evaluate("window.fixture.finish()")
    assert.equal(await page.getByLabel("虚拟文件成果发布").count(), 0)
    checks.push("Unmount cancels owned publication and ignores its late result")
    await page.evaluate("window.fixture.trace()")
    await page.getByRole("button", { name: "查看父流程轨迹" }).click()
    await page.getByRole("status").filter({ hasText: "轨迹文件缺失" }).waitFor()
    await page.getByRole("button", { name: "查看子执行轨迹" }).click()
    await page.getByText("tool · virtual_write · success", { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate("window.fixture.calls.filter(c=>c[0]==='trace').map(c=>c[1])"),
      ["parent", "child-trace"]
    )
    checks.push("Actual stored trace IDs navigate parent and child; missing files stay explicit")
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "report.json"), JSON.stringify({ checks, errors }, null, 2))
    console.log(`PASS ${checks.length} browser checks: ${output}`)
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
