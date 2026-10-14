import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/mods-harness-20261009", `skill-evaluation-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/customize/SkillEvaluationPanel.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import{createRoot}from"react-dom/client";import{SkillEvaluationPanel}from${JSON.stringify(entry)};
    const root=createRoot(document.getElementById("root")),calls=[];let rows=[],key=0,deferred=false,finish,fail=false;
    const report=()=>({id:"evaluation",state:"complete",provider:"controlled",tasks:[{id:"t",goal:"fixed"}],candidate:{cases:[{result:"passed"}]},comparison:{comparable:true,baseline:{passed:0,unknown:0},candidate:{passed:1,unknown:0},regressions:[]}});
    const record=()=>({id:"record",digest:"a".repeat(64),name:"Safe <img src=x onerror=alert(1)>",skillId:"sample",candidateId:"candidate",maxExecutions:3,baselineText:"old exact text",candidateText:"new <img src=x onerror=alert(1)> exact text",baselineDigest:"b".repeat(64),candidateDigest:"c".repeat(64),sourceTraceIds:["trace-1"],state:"prepared"});
    const api={list:async thread=>({ok:true,value:{workspace:thread==="next"?"next-space":"c:/owned/space",candidates:[{candidateId:"candidate",skillId:"sample",name:"Sample"}],records:thread==="next"?[]:rows}}),
      prepare:async input=>{calls.push(["prepare",input]);rows=[record()];return{ok:true,value:rows[0]}},
      start:async input=>{calls.push(["start",input]);if(deferred)return await new Promise(resolve=>finish=()=>{rows=[{...record(),state:"evaluating",evaluation:report()}];resolve({ok:true,value:rows[0]})});rows=[{...record(),state:"evaluating",evaluation:report()}];return{ok:true,value:rows[0]}},
      change:async input=>{calls.push([input.action,input]);if(fail)return{ok:false,code:"STALE"};rows=[{...rows[0],state:input.action==="adopt"?"adopted":"rolled-back"}];return{ok:true,value:rows[0]}}};
    const flowApi={flowList:async()=>[{definition:{id:"fixture",name:"Fixture",schemaVersion:2,execution:{kind:"host",profile:"workspace-files-v1"},steps:[{id:"agent",name:"Agent",kind:"agent",enabled:true}]},digest:"d".repeat(64),revision:1}],flowRun:async()=>null,flowDecide:async()=>{calls.push(["unexpected approve"])}};
    window.api={mods:flowApi};
    const mount=(thread="thread",workspace="C:/Owned/SPACE")=>root.render(<SkillEvaluationPanel key={++key} threadId={thread} workspace={workspace} api={api} flowApi={flowApi}/>);
    window.fixture={calls,mount,defer:()=>deferred=true,finish:()=>finish(),fail:()=>fail=true};mount();
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
    const page = await browser.newPage({ viewport: { width: 1160, height: 950 } }),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><meta charset="utf-8"><style>body{font:14px system-ui;margin:24px;background:#faf9f6}section,article{padding:16px;border:1px solid #ccc;border-radius:8px}label,p,button,article{display:block;margin:12px 0}button,select,input,textarea{font:inherit;padding:8px}textarea{width:95%}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}button:disabled{opacity:.5}.break-all{word-break:break-all}</style><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://fixture.test")
    await page.getByLabel("Skill 待审候选").selectOption("candidate")
    await page.getByLabel("Skill 固定流程夹具").selectOption("fixture")
    await page.getByLabel("Skill 注入步骤").selectOption("agent")
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixture: { calls: unknown[] } }).fixture.calls.length
      ),
      0
    )
    await page.getByRole("button", { name: "冻结基线与候选（不运行）" }).click()
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { fixture: { calls: [string, { expectedWorkspace: string }][] } })
            .fixture.calls[0][1].expectedWorkspace
      ),
      "c:/owned/space"
    )
    await page.getByText("核对冻结文本").click()
    assert(await page.getByText("old exact text", { exact: true }).isVisible())
    assert.equal(await page.locator("img").count(), 0)
    await page.getByLabel("Skill 固定任务").fill("fixed")
    await page.getByRole("button", { name: /运行此 Skill 对比/ }).click()
    await page.getByText(/受控服务，只验证机制/).waitFor()
    page.once("dialog", (dialog) => dialog.dismiss())
    await page.getByRole("button", { name: "核对并采纳此候选" }).click()
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { fixture: { calls: string[][] } }).fixture.calls.filter(
            (call) => call[0] === "adopt"
          ).length
      ),
      0
    )
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "核对并采纳此候选" }).click()
    await page.getByRole("button", { name: "回退本次 Skill 文本" }).waitFor()
    await page.screenshot({ path: join(output, "skill-evaluation-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 540, height: 900 })
    await page.screenshot({ path: join(output, "skill-evaluation-narrow.png"), fullPage: true })
    await page.evaluate(() => (window as unknown as { fixture: { fail(): void } }).fixture.fail())
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "回退本次 Skill 文本" }).click()
    await page.getByText("候选、基线或项目已经变化，请重新读取和冻结。").waitFor()
    assert(await page.getByRole("button", { name: "回退本次 Skill 文本" }).isVisible())
    await page.getByRole("button", { name: "冻结基线与候选（不运行）" }).click()
    await page.evaluate(() => (window as unknown as { fixture: { defer(): void } }).fixture.defer())
    await page.getByRole("button", { name: /运行此 Skill 对比/ }).click()
    assert(await page.getByRole("button", { name: /运行此 Skill 对比/ }).isDisabled())
    await page.evaluate(() => {
      const f = (
        window as unknown as {
          fixture: { mount(thread: string, workspace: string): void; finish(): void }
        }
      ).fixture
      f.mount("next", "next-space")
      f.finish()
    })
    await page.getByLabel("Skill 待审候选").waitFor()
    assert.equal(await page.getByLabel("Skill 评测记录").count(), 0)
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "read-only before explicit click",
            "immutable text preview and escaping",
            "explicit task budget run",
            "controlled quality label",
            "confirm adoption without automatic apply",
            "rollback CAS conflict preserves record",
            "duplicate prevented",
            "stale scope reply discarded"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS Skill evaluation browser: 8 checks; ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
