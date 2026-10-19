import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/creator-workspace-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from "react";import {createRoot} from "react-dom/client";
      import {ModsDevelopmentPanel} from "./src/renderer/src/components/customize/ModsDevelopmentPanel";
      import {CreatorProjectDeliveryCard} from "./src/renderer/src/components/customize/CreatorProjectDeliveryCard";
      import {CreatorTrialJourneyCard} from "./src/renderer/src/components/customize/CreatorTrialJourneyCard";
      const calls=[];const listeners=new Set();
      let current={threadId:"creator",workspace:"C:/creator",enabled:true,mode:"creator",drafts:[],trials:[],
        business:{drafts:[],review:{planId:"plan",phase:"needs-approval",name:"独立测试插件",version:"1.0.0",
          digest:"a".repeat(64),copyId:"new-plugin",canConfirm:true,diagnostics:[],
          steps:Array.from({length:18},(_,index)=>({id:"stage-"+index,title:"流程阶段 "+(index+1),sourceName:"来源模块"}))}}};
      const api={status:async()=>structuredClone(current),onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        approveBusiness:async input=>{calls.push(["install",input]);current.business.review={...current.business.review,phase:"installed",pluginId:"installed-copy"};return structuredClone(current)},
        exportBusiness:async input=>{calls.push(["export",input]);current.business.review={...current.business.review,phase:"exported",output:"C:/chosen/plugin.zip"};return structuredClone(current)}};
      const settings={globalEnabled:async()=>true,status:async()=>({workspace:"C:/creator",enabled:true,outputPolicy:true,mods:[],diagnostics:[]})};
      window.api={mods:{development:api,...settings}};
      const root=createRoot(document.getElementById("root"));
      const renderMain=()=>root.render(<ModsDevelopmentPanel threadId="creator" workspaceHint="C:/creator" mode="chat" api={api} onReturnToChat={()=>document.getElementById("composer").focus()} onRequestRepair={async message=>{calls.push(["repair",message])}}/>);
      renderMain();
      const request={id:"request",draftId:"draft",name:"host-source",revision:3,digest:"b".repeat(64),goal:"验收"};
      let delivery;
      const renderHost=()=>root.render(<CreatorProjectDeliveryCard threadId="creator" workspace="C:/creator" request={request} delivery={delivery} api={api} onStatus={next=>{delivery=next.projectDelivery;renderHost()}}/>);
      api.prepareProjectDelivery=async input=>{calls.push(["prepare-host",input]);delivery={id:"delivery",requestId:request.id,sourceDigest:request.digest,name:input.name,version:input.version,digest:"c".repeat(64),phase:"needs-confirmation",canInstall:true,canExport:true};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.installProjectDelivery=async input=>{calls.push(["install-host",input]);delivery={...delivery,phase:"installed",canInstall:false,pluginId:"host-copy"};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.exportProjectDelivery=async input=>{calls.push(["export-host",input]);delivery={...delivery,phase:"exported",output:"C:/chosen/host.zip"};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.setMode=async()=>structuredClone(current);
      api.approveModularization=async input=>{calls.push(["modularize",input]);current.business.modularization={...current.business.modularization,phase:"ready",canConfirm:false,inspectionId:"native-new-inspection"};return structuredClone(current)};
      const renderJourney=mode=>{
        // Controlled read-only native-status fixture exercises the actual aggregate renderer;
        // native journal/validator authenticity is covered by the separate Host suites.
        const allPassed=mode!=="mixed";
        const journey={projectId:"native-trial-project",creatorThreadId:"creator",candidateDigest:"f".repeat(64),workspace:"C:/isolated-trial",
          candidateCurrent:mode!=="historical",phase:allPassed?"passed":"failed",canDeliver:allPassed&&mode!=="historical",operationsTruncated:false,diagnostics:[],
          stages:Array.from({length:18},(_,index)=>({id:"stage-"+(index+1),title:"验收阶段 "+(index+1),
            status:allPassed?"passed":index===7?"failed":"unknown",
            artifacts:[{id:"artifact-"+(index+1),path:"out/stage-"+(index+1)+".md",required:true}],
            checks:[{id:"check-"+(index+1),artifactId:"artifact-"+(index+1),result:allPassed?"passed":index===7?"failed":"unknown",validatorVersion:"native-validator/v1"}],
            sessions:[{threadId:"native-stage-session-"+(index+1),operationId:"native-operation-"+(index+1),status:"completed",terminalOutcome:"success"}]}))};
        root.render(<CreatorTrialJourneyCard journey={journey} threadId="creator" digest={"f".repeat(64)}/>);
      };
      let hostRouteEvidence;
      const renderHostRoute=matching=>{
        current.business={drafts:[],review:{planId:"host-plan",copyId:"host-copy",digest:"a".repeat(64),name:"Host 编排来源",version:"2.0.0",
          phase:"needs-approval",canConfirm:true,diagnostics:["原生组装预审已保留"],steps:Array.from({length:18},(_,index)=>({id:"host-stage-"+index,title:"Host 步骤 "+(index+1),sourceName:"原始Mod"}))}};
        current.projectTrial={id:"host-request",draftId:"host-draft",name:"Host 当前候选",revision:4,digest:"b".repeat(64),goal:"核对当前Host候选",
          origin:{kind:"business-assembly",planId:"host-plan",copyId:matching?"host-copy":"unrelated-copy",digest:"a".repeat(64)},
          journey:{projectId:"host-project",creatorThreadId:"creator",candidateDigest:"b".repeat(64),candidateCurrent:true,workspace:"C:/host-trial",
            phase:"not-started",canDeliver:false,operationsTruncated:false,diagnostics:[],stages:[{id:"draft",title:"起草",status:"pending",artifacts:[],checks:[],sessions:[]}]}};
        const projectTrial=current.projectTrial;
        hostRouteEvidence=projectTrial.journey;
        delete projectTrial.journey;
        if(matching==="deferred") delete current.projectTrial;
        api.businessTrial={request:async input=>{calls.push(["legacy-trial-request",input]);current.projectTrial=projectTrial;return structuredClone(current)}};
        window.api.harnessBoard={localProjects:{preview:{list:async threadId=>({threadId,workspace:"C:/creator",drafts:[{id:"host-draft",name:"Host 当前候选",revision:4,digest:"b".repeat(64)}]}),
          create:async()=>{throw Error("Route fixture must not execute a project")},finish:async()=>{}}}};
        renderMain();
        listeners.forEach(fn=>fn({threadId:"creator"}));
      };
      window.fixture={calls,host:renderHost,journey:renderJourney,hostRoute:renderHostRoute,
        hostRoutePassed:()=>{const journey=structuredClone(hostRouteEvidence);journey.phase="passed";journey.canDeliver=true;journey.stages[0].status="passed";current.projectTrial.journey=journey;listeners.forEach(fn=>fn({threadId:"creator"}))},
        changeHost:()=>{request.digest="d".repeat(64);renderHost()},modularize:()=>{current.business={drafts:[],modularization:{requestId:"migration",sourceDigest:"e".repeat(64),sourceName:"原始插件",phase:"needs-confirmation",summary:"保留原运行器、配置与校验，拆分可识别步骤",resources:8,mods:[{id:"step-a",title:"识别阶段"}],diagnostics:[],canConfirm:true}};renderMain()}};
    `
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    write: false,
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
    target: "chrome130",
    logLevel: "warning"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://creator.fixture/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><meta charset="utf-8"><textarea id="composer" aria-label="原聊天输入框"></textarea><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://creator.fixture")
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    const workspace = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    await workspace.waitFor()
    assert.equal(
      await page.getByRole("navigation", { name: "插件制作步骤" }).getByRole("button").count(),
      4
    )
    const bounds = await workspace.boundingBox()
    assert(
      bounds && bounds.width > 850 && bounds.x >= 0 && bounds.x + bounds.width <= 1280,
      "long plugin workflows must use a dedicated wide workspace"
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.length"),
      0,
      "opening the workspace must not install"
    )
    assert.equal(await page.getByRole("list", { name: "组合的业务步骤" }).isVisible(), false)
    await page.getByRole("button", { name: /4 · 保存为插件/ }).click()
    await page.getByRole("button", { name: "保存为新插件并安装", exact: true }).click()
    await page.getByText(/从“添加功能 → 我已添加”找到这份新插件/).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls[0][1].digest"), "a".repeat(64))
    assert.equal(
      await page.getByText("整轮试用已通过", { exact: true }).count(),
      0,
      "installation success must not be presented as business acceptance"
    )
    await page.getByRole("button", { name: "导出插件包…", exact: true }).click()
    await page.getByText("导出位置：C:/chosen/plugin.zip", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.calls.map(row=>row[0])"), [
      "install",
      "export"
    ])
    await page.screenshot({ path: join(output, "workspace-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 375, height: 812 })
    const beforeSettle = await workspace.boundingBox()
    const mobileDiagnostics = await workspace.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          clientWidth: document.documentElement.clientWidth
        },
        bounds: element.getBoundingClientRect().toJSON(),
        width: style.width,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        transform: style.transform,
        animation: style.animation,
        animations: element
          .getAnimations()
          .map((animation) => ({
            type: animation.constructor.name,
            property: (animation as CSSTransition).transitionProperty,
            playState: animation.playState,
            currentTime: animation.currentTime,
            timing: animation.effect?.getComputedTiming()
          })),
        overflow: [...element.querySelectorAll("*")]
          .map((child) => ({
            tag: child.tagName,
            text: child.textContent?.slice(0, 60),
            width: child.getBoundingClientRect().width
          }))
          .filter((child) => child.width > innerWidth)
          .slice(0, 10)
      }
    })
    // Resizing changes viewport units and media-query padding. Read after the actual finite
    // native transitions complete, rather than measuring their desktop-size starting frame.
    await workspace.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {}))
      )
    })
    const mobile = await workspace.boundingBox()
    const stableDiagnostics = await workspace.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        bounds: element.getBoundingClientRect().toJSON(),
        width: style.width,
        height: style.height,
        activeAnimations: element.getAnimations().filter((item) => item.playState === "running")
          .length
      }
    })
    writeFileSync(
      join(output, "workspace-mobile-diagnostics.json"),
      JSON.stringify(
        {
          before: { bounds: beforeSettle, ...mobileDiagnostics },
          stable: stableDiagnostics
        },
        null,
        2
      )
    )
    await page.screenshot({ path: join(output, "workspace-mobile.png"), fullPage: true })
    console.log(
      "Mobile workspace diagnostics",
      JSON.stringify({
        output,
        mobile,
        before: { bounds: beforeSettle, ...mobileDiagnostics },
        stable: stableDiagnostics
      })
    )
    assert(
      beforeSettle &&
        beforeSettle.width <= 375 &&
        beforeSettle.x >= 0 &&
        beforeSettle.x + beforeSettle.width <= 375,
      `Viewport resize must immediately reflow workspace geometry: ${JSON.stringify(beforeSettle)}`
    )
    assert(
      mobile && mobile.width <= 375 && mobile.x >= 0 && mobile.x + mobile.width <= 375,
      `Workspace must fit mobile viewport: ${JSON.stringify({ mobile, viewport: mobileDiagnostics.viewport })}`
    )
    await page.getByRole("button", { name: "返回原聊天继续创作", exact: true }).click()
    await page.getByRole("textbox", { name: "原聊天输入框" }).fill("继续优化新插件")
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天输入框" }).inputValue(),
      "继续优化新插件"
    )
    await page.evaluate("window.fixture.host()")
    await page.getByRole("textbox", { name: "新插件标识", exact: true }).fill("host-created-copy")
    await page.getByRole("textbox", { name: "新插件版本", exact: true }).fill("2.0.0")
    await page.getByRole("button", { name: "准备保存为新插件", exact: true }).click()
    await page.getByText("独立插件内容已准备，请选择安装或导出并确认。", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='install-host').length"),
      0
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='prepare-host')[1].digest"),
      "b".repeat(64)
    )
    await page.getByRole("button", { name: "确认安装新插件", exact: true }).click()
    await page.getByText("新插件已安装。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "导出新插件 ZIP…", exact: true }).click()
    await page.getByText("导出位置：C:/chosen/host.zip", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='install-host')[1].digest"),
      "c".repeat(64)
    )
    await page.evaluate("window.fixture.changeHost()")
    await page
      .getByText("下方原交付记录属于另一候选，请重新核对当前版本后准备保存。", { exact: true })
      .waitFor()
    assert.equal(await page.getByRole("button", { name: "确认安装新插件", exact: true }).count(), 0)
    await page.evaluate("window.fixture.modularize()")
    await page.getByRole("article", { name: "原始插件首次模块化确认", exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='modularize').length"),
      0
    )
    await page.getByRole("button", { name: "确认并准备这些 Mods", exact: true }).click()
    await page.waitForFunction("window.fixture.calls.some(row=>row[0]==='repair')")
    assert.equal(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='modularize')[1].sourceDigest"),
      "e".repeat(64)
    )
    assert.match(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='repair')[1]"),
      /native-new-inspection/
    )
    await page.getByRole("textbox", { name: "原聊天输入框" }).fill("继续组合模块")
    await page.evaluate("window.fixture.journey('mixed')")
    const journeyCard = page.getByRole("region", { name: "整轮项目试用验收", exact: true })
    await journeyCard.getByRole("status").getByText("试用未通过", { exact: true }).waitFor()
    const stages = journeyCard
      .getByRole("list", { name: "本轮阶段验收", exact: true })
      .locator(":scope > li")
    assert.equal(await stages.count(), 18, "The aggregate view must retain every declared stage")
    const unknownStage = stages.nth(0).locator("details").first()
    const failedStage = stages.nth(7).locator("details").first()
    assert.equal(
      await unknownStage.getAttribute("open"),
      null,
      "Unknown stages must remain concise summaries until the user expands one"
    )
    assert.equal(
      await unknownStage.getByText("out/stage-1.md · 必需", { exact: true }).isVisible(),
      false
    )
    assert.notEqual(
      await failedStage.getAttribute("open"),
      null,
      "A failed stage must disclose its real artifact/check details without another search"
    )
    await failedStage.getByText("check-8 · 未通过", { exact: false }).waitFor()
    assert.equal(
      await journeyCard.getByText("整轮试用已通过", { exact: true }).count(),
      0,
      "Completed stage sessions must not override failed or unknown native checks"
    )
    await unknownStage.locator("summary").first().click()
    await unknownStage.getByText("out/stage-1.md · 必需", { exact: true }).waitFor()
    await journeyCard.locator("summary").filter({ hasText: "原会话、试用与版本关联" }).click()
    await journeyCard.getByText(`候选摘要：${"f".repeat(64)}`, { exact: true }).waitFor()
    await journeyCard.getByText("原会话：creator", { exact: true }).waitFor()
    await page.screenshot({ path: join(output, "journey-18-stages.png"), fullPage: true })
    await page.evaluate("window.fixture.journey('passed')")
    await journeyCard.getByRole("status").getByText("整轮试用已通过", { exact: true }).waitFor()
    await page.evaluate("window.fixture.journey('historical')")
    await journeyCard
      .getByRole("status")
      .getByText("试用版本或原会话已变化，待重新核对", { exact: true })
      .waitFor()
    assert.equal(
      await journeyCard.getByText("整轮试用已通过", { exact: true }).count(),
      0,
      "A historical passed run cannot become the verdict for an invalidated source"
    )
    await page.evaluate("window.fixture.hostRoute('deferred')")
    await workspace.waitFor()
    await workspace.getByRole("button", { name: "配置并试用此版本", exact: true }).click()
    const routeDialog = page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true })
    await routeDialog.getByRole("textbox", { name: "本次试用目标", exact: true }).fill("先准备Host项目，再核对整轮试用")
    await routeDialog.getByRole("button", { name: "准备此版本的试用请求", exact: true }).click()
    await workspace.waitFor()
    assert.equal(await routeDialog.count(), 0,
      "A native Host response must close the legacy allocation dialog and continue in the same workspace")
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='legacy-trial-request').length"), 1,
      "Only the explicit trial request may prepare the initial Host project")
    const hostTrigger = page.locator('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "尚无整轮验收记录")
    await workspace.getByRole("button", { name: "创建试用项目（稍后开始任务）", exact: true }).waitFor()
    assert.equal(await workspace.getByRole("button", { name: "配置并试用此版本", exact: true }).count(), 0,
      "A matched Host candidate must not route through the legacy business trial dialog")
    assert.equal(await page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true }).count(), 0)
    await workspace.getByRole("button", { name: "准备保存为新插件", exact: true }).waitFor()
    assert.equal(await workspace.getByRole("button", { name: "保存为新插件并安装", exact: true }).count(), 0,
      "A matched Host candidate must expose one independent delivery workflow")
    const sourceReview = workspace.getByRole("article", { name: "业务插件组装确认", exact: true })
    await sourceReview.getByRole("heading", { name: "组装来源与候选版本", exact: true }).waitFor()
    await sourceReview.getByText("原生组装预审已保留", { exact: true }).waitFor()
    await sourceReview.locator("summary").filter({ hasText: "核对插件内容（18 个步骤）" }).click()
    assert.equal(await sourceReview.getByRole("list", { name: "组合的业务步骤", exact: true }).locator(":scope > li").count(), 18)
    await page.evaluate("window.fixture.hostRoutePassed()")
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "整轮试用已通过")
    assert.equal(await hostTrigger.textContent(), "整轮试用已通过")
    await page.screenshot({ path: join(output, "matched-host-route.png"), fullPage: true })
    await page.evaluate("window.fixture.hostRoute(false)")
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "业务插件组装")
    assert.equal(await workspace.getByRole("button", { name: "准备保存为新插件", exact: true }).count(), 0,
      "An unrelated Host request must not become this business review's delivery candidate")
    await workspace.getByRole("button", { name: "保存为新插件并安装", exact: true }).waitFor()
    await workspace.getByRole("button", { name: "配置并试用此版本", exact: true }).click()
    await page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true }).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='legacy-trial-request').length"), 1,
      "Opening the original legacy route must never itself request or approve execution")
    assert.deepEqual(errors, [])
    console.log(
      "PASS creator workspace navigation, long-flow disclosure, delivery, chat return, mobile bounds and 18-stage native-status aggregate verdicts"
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
