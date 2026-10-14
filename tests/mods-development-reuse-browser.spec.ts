import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/mods-conversational-20261009", `reuse-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/customize/DevelopmentReusePanel.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import{createRoot}from"react-dom/client";import{DevelopmentReusePanel}from${JSON.stringify(entry)};import{getReuseReceipt}from"./src/renderer/src/components/customize/development-reuse-receipts";
    const root=createRoot(document.getElementById("root"));let key=0,calls=[],listeners=new Set(),state,doc,claw,targetClaw,held=[],deferInstall=false,finishInstall,failOpen=false,ready=false,outcome="settled",stopUnknown=false,failNew=false,failStatus=false,failApply=false,failGrantRead=false,failAfterApply=false,failDevelopment=false;
    const candidate={handle:"handle",installationId:"install",versionId:"version",name:"Counter",sourceDigest:"a".repeat(64),compiledDigest:"b".repeat(64),catalogDigest:"c".repeat(64),configuration:"unchanged"};
    function reset(){calls=[];targetClaw=null;deferInstall=false;finishInstall=undefined;failOpen=false;ready=false;outcome="settled";stopUnknown=false,failNew=false,failStatus=false,failApply=false,failGrantRead=false,failAfterApply=false,failDevelopment=false;doc={id:"formal"+key,name:"Counter",workspace:"c:/owned",revision:1,currentRevision:1,updatedAt:1,source:{schemaVersion:1,digest:"a".repeat(64),files:[]},versions:[]};state={threadId:"thread",workspace:doc.workspace,enabled:true,drafts:[{id:"draft",name:"Counter",revision:2,digest:doc.source.digest}],trials:[{componentId:"component",draftId:"draft",phase:"active"}]};claw={workspace:doc.workspace,revision:1,bindingRevision:1,enabled:true,applicable:true,issues:[],capabilities:[],profiles:[],active:{id:"old",name:"Existing",capabilities:[{pluginId:"other",name:"Other",digest:"d".repeat(64)}],skills:{mode:"selected",items:[]},mcp:{mode:"selected",items:[]},models:{roles:{review:"model"}}}};}
    window.api={mods:{development:{status:async()=>{if(failDevelopment){failDevelopment=false;throw Error("FAILED")};return structuredClone(state)},onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},stop:async input=>{calls.push(["stop",input]);state.trials[0].phase=stopUnknown?"unknown":"stopped";return structuredClone(state)}},authoring:{read:async()=>structuredClone(doc)},authoringInstall:{resolveInstalled:async()=>({ok:true,value:calls.some(row=>row[0]==="install")&&outcome==="settled"?candidate:null}),prepare:async input=>{calls.push(["prepare",input]);return {ok:true,value:candidate}},apply:async input=>{calls.push(["install",input]);const result={ok:true,value:{operationId:"op",installationId:"install",versionId:"version",state:outcome}};return deferInstall?await new Promise(r=>finishInstall=()=>r(result)):result},cancel:async()=>({ok:true}),list:async()=>({ok:true,value:{workspace:doc.workspace,installations:[]}})},status:async()=>{if(failStatus){failStatus=false,failApply=false,failGrantRead=false,failAfterApply=false,failDevelopment=false;throw Error("FAILED")};return ({workspace:doc.workspace,functionMods:[{pluginId:"install",name:"counter",digest:candidate.compiledDigest,state:ready?"ready":"needs-approval",capabilities:[]}]})},approveFunction:async(...args)=>{calls.push(["grant",args]);ready=true;if(failGrantRead){failGrantRead=false,failAfterApply=false,failDevelopment=false;failStatus=true}},clawView:async id=>structuredClone(id==="new-thread"?{...claw,active:targetClaw.active,bindingRevision:targetClaw.bindingRevision}:claw),clawChange:async(id,input)=>{if(id==="new-thread"){calls.push(["claw",id,input]);if(failNew){failNew=false;throw Error("FAILED")};if(input.bindingRevision!==targetClaw.bindingRevision)throw Error("STALE");targetClaw.active=claw.profiles.find(p=>p.id===input.id);targetClaw.bindingRevision++;return structuredClone({...claw,...targetClaw})};calls.push(["claw",id,input]);if(id==="thread"&&input.kind==="apply"&&failApply){failApply=false;throw Error("FAILED")};if(id==="new-thread"&&failNew){failNew=false;throw Error("FAILED")};if(input.revision!==claw.revision||input.workspace!==claw.workspace)throw Error("STALE");if(input.kind==="save"){claw.profiles.push(input.profile);claw.revision++}else{if(input.bindingRevision!==claw.bindingRevision)throw Error("STALE");claw.active=claw.profiles.find(p=>p.id===input.id);claw.bindingRevision++;if(failAfterApply){failAfterApply=false;failDevelopment=true}}return structuredClone(claw)}},threads:{create:async metadata=>{calls.push(["create",metadata]);targetClaw={active:null,bindingRevision:0};return {thread_id:"new-thread"}}}};
    const mount=()=>root.render(<DevelopmentReusePanel key={++key} threadId="thread" document={doc} origin={{id:"draft",revision:2,digest:doc.source.digest}} onReturnToChat={()=>calls.push(["return"])} onOpenThread={async id=>{if(failOpen){failOpen=false;throw Error("FAILED")};calls.push(["open",id])}}/>);
    window.fixture={deferInstall:()=>deferInstall=true,finishInstall:()=>finishInstall(),fillCapacity:()=>{for(let i=0;i<16;i++){const r=getReuseReceipt("held-"+i);if(!r)break;r.set("busy",true);held.push(r)};doc={...doc,id:"capacity"+key};mount()},releaseCapacity:()=>held.forEach(r=>r.set("busy",false)),remount:()=>mount(),reset:()=>{reset();mount()},get:()=>({calls,claw}),partial:()=>outcome="partial",unknown:()=>stopUnknown=true,stale:()=>{state.drafts[0].revision++;listeners.forEach(fn=>fn({threadId:"thread"}))},failAfterApply:()=>failAfterApply=true,failApply:()=>failApply=true,failGrantRead:()=>failGrantRead=true,failStatus:()=>failStatus=true,defaultAll:()=>{claw.active=null;claw.capabilities=[{pluginId:"other",name:"Other",digest:"d".repeat(64),state:"ready"}]},failOpen:()=>failOpen=true,targetRace:()=>{targetClaw.active={id:"someone-else"};targetClaw.bindingRevision++},failNew:()=>failNew=true,race:()=>claw.revision++};reset();mount();
  `
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("http://localhost/reuse-test", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/reuse-test")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const call = (name: string) =>
      page.evaluate(
        (name) => (window as unknown as { fixture: Record<string, () => unknown> }).fixture[name](),
        name
      )
    const click = (name: string) => page.getByRole("button", { name, exact: true }).click()
    const install = async () => {
      await click("停止此试用并继续正式复用")
      await click("准备安装当前版本")
      await click("确认安装此版本")
    }
    await page.getByRole("heading", { name: /保存并正式复用/ }).waitFor()
    assert.equal(await page.getByRole("button", { name: "准备安装当前版本" }).count(), 0)
    await install()
    await page.getByText(/正式版本已安装/).waitFor()
    assert.equal(await page.getByRole("button", { name: "准备安装当前版本" }).count(), 0)
    await page.getByText("2. 正式版本已安装 · 回看预览与安装", { exact: true }).click()
    assert(await page.getByRole("button", { name: "查看可试用的功能", exact: true }).isVisible())
    await page.getByText("2. 正式版本已安装 · 回看预览与安装", { exact: true }).click()
    assert(await page.getByRole("button", { name: "授权此正式版本" }).isDisabled())
    await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).check()
    await click("授权此正式版本")
    await click("核对当前 Claw 组合")
    await click("保留其他选择并应用此组合")
    await page.getByRole("button", { name: "继续当前聊天", exact: true }).waitFor()
    assert.equal(await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "核对当前 Claw 组合" }).count(), 0)
    await click("继续当前聊天")
    const continued = (await call("get")) as { calls: unknown[][] }
    assert.equal(continued.calls.filter((row) => row[0] === "return").length, 1)
    assert.equal(continued.calls.filter((row) => row[0] === "create").length, 0)
    await click("新聊天使用此助手")
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { get(): { calls: unknown[][] } } }).fixture
        .get()
        .calls.some((row) => row[0] === "open")
    )
    const result = (await call("get")) as {
      calls: unknown[][]
      claw: { active: { capabilities: unknown[]; models: unknown } }
    }
    assert.deepEqual(result.calls.filter((row) => row[0] === "grant").length, 1)
    assert.equal(result.claw.active.capabilities.length, 2)
    assert.deepEqual(result.claw.active.models, { roles: { review: "model" } })
    await page.screenshot({ path: join(output, "reuse-complete.png"), fullPage: true })

    await call("reset")
    await call("partial")
    await install()
    await page.getByText(/安装部分完成/).waitFor()
    assert.equal(await page.getByRole("button", { name: "授权此正式版本" }).count(), 0)

    await call("reset")
    await call("unknown")
    await click("停止此试用并继续正式复用")
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByRole("button", { name: "准备安装当前版本" }).count(), 0)

    await call("reset")
    await call("stale")
    await page.getByText(/此复用计划已过期/).waitFor()
    assert(await page.getByRole("button", { name: "停止此试用并继续正式复用" }).isDisabled())

    await call("reset")
    await install()
    await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).check()
    await click("授权此正式版本")
    await click("核对当前 Claw 组合")
    await call("race")
    await click("保留其他选择并应用此组合")
    await page.getByText(/此复用计划已过期/).waitFor()
    const raced = (await call("get")) as { calls: unknown[][] }
    assert.equal(raced.calls.filter((row) => row[0] === "claw").length, 0)
    await call("reset")
    await call("defaultAll")
    await install()
    await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).check()
    await click("授权此正式版本")
    await click("核对当前 Claw 组合")
    await click("保留其他选择并应用此组合")
    await call("failNew")
    await click("新聊天使用此助手")
    await page.getByRole("alert").waitFor()
    await click("新聊天使用此助手")
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { get(): { calls: unknown[][] } } }).fixture
        .get()
        .calls.some((row) => row[0] === "open")
    )
    const retried = (await call("get")) as {
      calls: unknown[][]
      claw: { active: { capabilities: unknown[] } }
    }
    assert.equal(retried.calls.filter((row) => row[0] === "create").length, 1)
    assert.equal(retried.claw.active.capabilities.length, 2)
    await call("reset")
    await call("failStatus")
    await install()
    await page.getByText(/正式版本已安装/).waitFor()
    await click("重新核对已安装版本（只读）")
    await page.getByRole("button", { name: "授权此正式版本" }).waitFor()
    const recovered = (await call("get")) as { calls: unknown[][] }
    assert.equal(recovered.calls.filter((row) => row[0] === "install").length, 1)
    await call("reset")
    await install()
    await call("failGrantRead")
    await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).check()
    await click("授权此正式版本")
    await page.getByText(/正式授权结果待核对/).waitFor()
    await click("只读核对正式授权状态")
    await click("核对当前 Claw 组合")
    await call("failApply")
    await click("保留其他选择并应用此组合")
    await page.getByText(/应用结果尚未确认/).waitFor()
    await click("保留其他选择并应用此组合")
    await page.getByRole("button", { name: "新聊天使用此助手" }).waitFor()
    const partialClaw = (await call("get")) as { calls: unknown[][] }
    assert.equal(partialClaw.calls.filter((row) => row[0] === "grant").length, 1)
    assert.equal(
      partialClaw.calls.filter(
        (row) => row[0] === "claw" && (row[2] as { kind: string }).kind === "save"
      ).length,
      1
    )
    await call("reset")
    await install()
    await page.getByRole("checkbox", { name: /我已核对这个正式版本/ }).check()
    await click("授权此正式版本")
    await click("核对当前 Claw 组合")
    await call("failAfterApply")
    await click("保留其他选择并应用此组合")
    await page.getByRole("alert").waitFor()
    await click("核对当前 Claw 组合")
    await page.getByRole("button", { name: "新聊天使用此助手" }).waitFor()
    const appliedRecovery = (await call("get")) as { calls: unknown[][] }
    assert.equal(
      appliedRecovery.calls.filter(
        (row) => row[0] === "claw" && (row[2] as { kind: string }).kind === "save"
      ).length,
      1
    )
    assert.equal(
      appliedRecovery.calls.filter(
        (row) => row[0] === "claw" && (row[2] as { kind: string }).kind === "apply"
      ).length,
      1
    )
    await call("failOpen")
    await click("新聊天使用此助手")
    await page.getByRole("alert").waitFor()
    await click("新聊天使用此助手")
    const navigationRecovery = (await call("get")) as { calls: unknown[][] }
    assert.equal(navigationRecovery.calls.filter((row) => row[0] === "create").length, 1)
    assert.equal(
      navigationRecovery.calls.filter((row) => row[0] === "claw" && row[1] === "new-thread").length,
      1
    )
    await call("remount")
    await page.getByRole("button", { name: "新聊天使用此助手" }).waitFor()
    await page.getByText("4. 已加入当前助手 · 回看组合", { exact: true }).click()
    await click("核对当前 Claw 组合")
    assert(await page.getByRole("button", { name: "保留其他选择并应用此组合" }).isDisabled())
    await click("新聊天使用此助手")
    const remounted = (await call("get")) as { calls: unknown[][] }
    assert.equal(remounted.calls.filter((row) => row[0] === "create").length, 1)
    await call("targetRace")
    await click("新聊天使用此助手")
    await page.getByText("此复用计划已过期，请重新选择当前开发版本。").waitFor()
    const navigationRace = (await call("get")) as { calls: unknown[][] }
    assert.equal(
      navigationRace.calls.filter((row) => row[0] === "claw" && row[1] === "new-thread").length,
      1
    )
    await call("reset")
    await call("deferInstall")
    await install()
    await call("remount")
    await page.getByText("正在只读核对已完成的复用步骤…").waitFor()
    await call("finishInstall")
    await page.getByRole("button", { name: "授权此正式版本" }).waitFor()
    const inFlight = (await call("get")) as { calls: unknown[][] }
    assert.equal(inFlight.calls.filter((row) => row[0] === "install").length, 1)
    await call("fillCapacity")
    await page.getByRole("button", { name: "重新检查复用位置" }).waitFor()
    await call("releaseCapacity")
    await click("重新检查复用位置")
    await page.getByRole("heading", { name: /保存并正式复用/ }).waitFor()
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "explicit stop before install",
            "install/grant/Claw/new chat sequential user actions",
            "exact source and grant digest",
            "preserve existing Claw selection",
            "partial install cannot grant",
            "unknown stop cannot install",
            "changed draft invalidates plan",
            "Claw CAS race cannot overwrite newer selection",
            "default-all approved components preserved",
            "retry reuses already created chat",
            "settled receipt survives failed status read without another install",
            "grant verification failure retries read only",
            "saved Claw profile reused after apply failure",
            "settled Claw apply recovers by read only",
            "navigation retry does not reapply target and rejects changed target",
            "installed receipt survives remount",
            "saved combination survives remount",
            "created chat survives remount and read does not reset applied state",
            "in-flight installation settles after unmount without replay",
            "capacity exhaustion renders retryable UI instead of throwing"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS reuse browser: 20 checks; ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
