import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"
import { openCreatorStep, openCreatorProjectPreview } from "./support/creator-navigation"

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
      const calls=[];const listeners=new Set();const reviewListeners=new Set();let reviewIntent;
      let current={threadId:"creator",workspace:"C:/creator",enabled:true,mode:"creator",drafts:[],trials:[],
        business:{drafts:[],review:{planId:"plan",phase:"needs-approval",name:"独立测试插件",version:"1.0.0",
          digest:"a".repeat(64),contentDigest:"1".repeat(64),copyId:"new-plugin",canConfirm:true,diagnostics:[],
          steps:Array.from({length:18},(_,index)=>({id:"stage-"+index,title:"流程阶段 "+(index+1),sourceName:"来源模块"}))}}};
      const api={status:async()=>structuredClone(current),onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        approveBusiness:async input=>{calls.push(["install",input]);current.business.review={...current.business.review,phase:"installed",pluginId:"installed-copy"};return structuredClone(current)},
        exportBusiness:async input=>{calls.push(["export",input]);current.business.review={...current.business.review,phase:"exported",output:"C:/chosen/plugin.zip"};return structuredClone(current)}};
      const settings={globalEnabled:async()=>true,status:async()=>({workspace:"C:/creator",enabled:true,outputPolicy:true,mods:[],diagnostics:[]})};
      window.api={mods:{development:api,...settings,stageDebugReview:{current:async()=>{if(reviewIntent?.expiresAt<=Date.now())calls.push(["review-current-expired"]);return structuredClone(reviewIntent)},onRequested:fn=>{reviewListeners.add(fn);return()=>reviewListeners.delete(fn)}}}};
      const root=createRoot(document.getElementById("root"));
      const renderMain=()=>root.render(<ModsDevelopmentPanel threadId="creator" workspaceHint="C:/creator" mode="chat" api={api} onReturnToChat={()=>document.getElementById("composer").focus()} onRequestRepair={async message=>{calls.push(["repair",message])}}/>);
      renderMain();
      const request={id:"request",draftId:"draft",name:"host-source",revision:3,digest:"b".repeat(64),goal:"验收"};
      let delivery;let persistentColdTrial;
      const renderHost=()=>root.render(<CreatorProjectDeliveryCard threadId="creator" workspace="C:/creator" request={request} delivery={delivery} api={api} onStatus={next=>{delivery=next.projectDelivery;renderHost()}}/>);
      api.prepareProjectDelivery=async input=>{calls.push(["prepare-host",input]);delivery={id:"delivery",requestId:request.id,sourceDigest:request.digest,name:input.name,version:input.version,digest:"c".repeat(64),phase:"needs-confirmation",canInstall:true,canExport:true};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.installProjectDelivery=async input=>{calls.push(["install-host",input]);delivery={...delivery,phase:"installed",canInstall:false,pluginId:"host-copy"};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.exportProjectDelivery=async input=>{calls.push(["export-host",input]);delivery={...delivery,phase:"exported",output:"C:/chosen/host.zip"};return {...structuredClone(current),projectDelivery:structuredClone(delivery)}};
      api.setMode=async input=>{calls.push(["set-mode",input]);current.mode=input.mode;
        if(input.mode==="creator"){current.enabled=true;if(persistentColdTrial)current.projectTrial=structuredClone(persistentColdTrial)}
        return structuredClone(current)};
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
        delete current.sourceSet;
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
      const requestNativeReview=(mode="none")=>{
        current.business={drafts:[]};
        if(mode==="none")delete current.projectTrial;
        else current.projectTrial={id:"native-existing-request",draftId:"native-review-draft",revision:2,digest:"d".repeat(64),name:"应保留的原试用",goal:"原生保留目标"};
        const different=mode==="different";
        const selectedRevision=mode==="revision"?3:2;const selectedDigest=(different||mode==="digest"?"f":"d").repeat(64);
        reviewIntent={id:"native-review-intent-"+mode,threadId:"creator",workspace:"C:/creator",incarnation:{token:"native",legacyCreatedAt:1},
          snapshotId:"native-review-snapshot",draftId:different?"native-other-draft":"native-review-draft",revision:selectedRevision,candidateDigest:selectedDigest,mode:"stage",caller:{name:"独立调试助手",digest:"e".repeat(64)},expiresAt:Date.now()+(mode==="expired"?-1000:60000)};
        window.api.harnessBoard={localProjects:{preview:{list:async threadId=>({threadId,workspace:"C:/creator",drafts:[{id:"native-review-draft",name:"原生建议候选",revision:mode==="revision"?3:2,digest:(mode==="digest"?"f":"d").repeat(64)},{id:"native-other-draft",name:"另一原生候选",revision:2,digest:"f".repeat(64)}]}),
          stageDebug:{list:async()=>({snapshots:[{id:"native-review-snapshot",projectId:"native-original",stageId:"review",stageTitle:"原生复核阶段",sourceDigest:"c".repeat(64),createdAt:1,fileCount:1,totalBytes:2}],branches:[],diagnostics:[]}),prepare:async input=>{calls.push(["review-auto-prepare",input]);throw Error("must require explicit native prepare")},create:async input=>{calls.push(["review-auto-create",input]);throw Error("must require explicit native create")}}}}};
        renderMain();listeners.forEach(fn=>fn({threadId:"creator"}));reviewListeners.forEach(fn=>fn(reviewIntent));
      };
      const coldCreator=()=>{
        persistentColdTrial={id:"persisted-cold-request",draftId:"native-review-draft",name:"持久化项目与S6历史",revision:2,digest:"d".repeat(64),goal:"保留历史，仅核对"};
        current.enabled=false;current.mode="normal";current.business={drafts:[]};delete current.projectTrial;reviewIntent=undefined;
        window.api.harnessBoard.localProjects.preview.list=async threadId=>{calls.push(["cold-history-list"]);return {threadId,workspace:"C:/creator",drafts:[{id:"native-review-draft",name:"冷启动保留的项目候选",revision:2,digest:"d".repeat(64),recovery:{projectId:"cold-branch",revision:2,digest:"d".repeat(64),workspace:"C:/retained-branch",goal:"保留历史，仅核对",projectVersion:1,status:"needs-confirmation",debugBranch:true,hasUnconfirmedEffects:false}}]}};
        window.api.harnessBoard.localProjects.preview.stageDebug.list=async()=>({snapshots:[{id:"cold-input",projectId:"original",stageId:"review",stageTitle:"保留的阶段起点",sourceDigest:"c".repeat(64),createdAt:1,fileCount:1,totalBytes:2}],branches:[{id:"cold-branch",projectId:"cold-branch",sourceProjectId:"original",snapshotId:"cold-input",candidateDigest:"d".repeat(64),currentCandidateMatches:true,stageId:"review",mode:"stage",status:"passed",diagnostics:["冷启动保留的调试记录；本进程没有此分支的运行授权。"]}],diagnostics:[]});
        renderMain();listeners.forEach(fn=>fn({threadId:"creator"}));
      };
      window.fixture={calls,cold: coldCreator,host:renderHost,journey:renderJourney,hostRoute:renderHostRoute,nativeReview:requestNativeReview,
        emptySource:()=>{
          persistentColdTrial=undefined;reviewIntent=undefined;
          current={threadId:"creator",workspace:"C:/creator",enabled:true,mode:"normal",drafts:[],trials:[],business:{drafts:[]}};
          api.importSourceSet=async input=>{calls.push(["import-source",input]);current.sourceSet={id:"imported-source",title:"本次导入的源码",phase:"dependencies",dependencies:[{id:"dependency",name:"待确认依赖",version:"1.0.0",digest:"7".repeat(64),phase:"prepared"}]};return structuredClone(current)};
          renderMain();listeners.forEach(fn=>fn({threadId:"creator"}));reviewListeners.forEach(fn=>fn(undefined));
        },
        deliveryAttention:phase=>{current.projectDelivery=phase?{id:'retained-delivery',requestId:'historical-request',sourceDigest:'9'.repeat(64),name:'retained-copy',version:'1.0.0',digest:'8'.repeat(64),phase,canInstall:false,canExport:false,canReconcile:true,error:phase==='failed'?'PROJECT_DELIVERY_NAME_ALREADY_INSTALLED':undefined}:undefined;listeners.forEach(fn=>fn({threadId:'creator'}))},
        sourceSetReady:()=>{current.sourceSet={id:"native-source-set",title:"导入的作者源码",phase:"ready",dependencies:[]};listeners.forEach(fn=>fn({threadId:"creator"}))},
        hostRoutePassed:()=>{const journey=structuredClone(hostRouteEvidence);journey.phase="passed";journey.canDeliver=true;journey.stages[0].status="passed";current.projectTrial.journey=journey;listeners.forEach(fn=>fn({threadId:"creator"}))},
        changeHost:()=>{request.digest="d".repeat(64);renderHost()},modularize:()=>{current.business={drafts:[],modularization:{requestId:"migration",sourceDigest:"e".repeat(64),sourceName:"原始插件",phase:"needs-confirmation",summary:"保留原运行器、配置与校验，拆分可识别步骤",resources:8,mods:[{id:"step-a",title:"识别阶段"}],diagnostics:[],canConfirm:true}};renderMain()}};
    `
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    define: { "import.meta.env": "{}", "import.meta.hot": "undefined",
      "import.meta.url": '"http://creator.fixture/test-bundle.js"' },
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
      3
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
    await openCreatorStep(page, "delivery")
    await page.getByRole("button", { name: "保存插件", exact: true }).click()
    await page.getByRole("region", { name: "已安装插件开始使用", exact: true }).waitFor()
    await page.getByRole("button", { name: "开始使用", exact: true }).waitFor()
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
    await page.getByRole("button", { name: "返回聊天修改", exact: true }).click()
    await page.getByRole("textbox", { name: "原聊天输入框" }).fill("继续优化新插件")
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天输入框" }).inputValue(),
      "继续优化新插件"
    )
    await page.evaluate("window.fixture.host()")
    await page.getByRole("textbox", { name: "新插件标识", exact: true }).fill("host-created-copy")
    await page.getByText("版本设置", { exact: true }).click()
    await page.getByRole("textbox", { name: "新插件版本", exact: true }).fill("2.0.0")
    await page.getByRole("button", { name: "保存插件", exact: true }).click()
    await page.getByRole("heading", { name: "插件已保存", exact: true }).waitFor()
    await page.getByRole("button", { name: "开始使用", exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.filter(row=>row[0]==='install-host').length"),
      1
    )
    assert.equal(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='prepare-host')[1].digest"),
      "b".repeat(64)
    )
    await page.getByRole("button", { name: "导出 ZIP…", exact: true }).click()
    await page.getByText("导出位置：C:/chosen/host.zip", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.fixture.calls.find(row=>row[0]==='install-host')[1].digest"),
      "c".repeat(64)
    )
    await page.evaluate("window.fixture.changeHost()")
    await page
      .getByText(/^下方交付记录属于历史候选/)
      .waitFor()
    assert.equal(await page.getByRole("button", { name: "开始使用", exact: true }).count(), 0)
    assert.equal(await page.getByRole("region", { name: "已安装插件开始使用", exact: true }).count(), 0)
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
    await journeyCard.getByText("已通过 0 / 18 步 · 查看结果", { exact: true }).click()
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
    await workspace.getByRole("button", { name: "开始试用", exact: true }).click()
    const routeDialog = page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true })
    await routeDialog.getByRole("textbox", { name: "本次试用目标", exact: true }).fill("先准备Host项目，再核对整轮试用")
    await routeDialog.getByRole("button", { name: "开始试用", exact: true }).click()
    await workspace.waitFor()
    assert.equal(await routeDialog.count(), 0,
      "A native Host response must close the legacy allocation dialog and continue in the same workspace")
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='legacy-trial-request').length"), 1,
      "Only the explicit trial request may prepare the initial Host project")
    const hostTrigger = page.locator('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "尚无整轮验收记录")
    await workspace.getByRole("button", { name: "开始试用", exact: true }).waitFor()
    await openCreatorProjectPreview(page)
    await page.screenshot({ path: join(output, "host-trial-default.png"), fullPage: true })
    assert.equal(await workspace.getByRole("button", { name: "配置并试用此版本", exact: true }).count(), 0,
      "A matched Host candidate must not route through the legacy business trial dialog")
    assert.equal(await page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true }).count(), 0)
    await workspace.getByRole("button", { name: "3 · 保存插件", exact: true }).click()
    await workspace.getByRole("region", { name: "项目候选保存为新插件", exact: true }).getByRole("button", { name: "保存插件", exact: true }).waitFor()
    assert.equal(await workspace.getByRole("article", { name: "业务插件组装确认", exact: true }).getByRole("button", { name: "保存插件", exact: true }).count(), 0,
      "A matched Host candidate must expose one independent delivery workflow")
    await workspace.getByText("组装详情", { exact: true }).click()
    const sourceReview = workspace.getByRole("article", { name: "业务插件组装确认", exact: true })
    await sourceReview.getByRole("heading", { name: "组装来源与候选版本", exact: true }).waitFor()
    await sourceReview.getByText("原生组装预审已保留", { exact: true }).waitFor()
    await sourceReview.locator("summary").filter({ hasText: "核对插件内容（18 个步骤）" }).click()
    assert.equal(await sourceReview.getByRole("list", { name: "组合的业务步骤", exact: true }).locator(":scope > li").count(), 18)
    await page.evaluate("window.fixture.hostRoutePassed()")
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "整轮试用已通过")
    assert.equal(await hostTrigger.textContent(), "整轮试用已通过")
    await page.screenshot({ path: join(output, "matched-host-route.png"), fullPage: true })
    const beforeDeliveryAttention = await page.evaluate("window.fixture.calls.length")
    for (const phase of ["unknown", "failed"]) {
      await openCreatorStep(page, "trial")
      await workspace.getByRole("button", { name: "返回聊天修改", exact: true }).click()
      await workspace.waitFor({ state: "detached" })
      await page.evaluate(
        (phase) => window.eval("window.fixture.deliveryAttention(" + JSON.stringify(phase) + ")"),
        phase
      )
      await workspace.waitFor()
      await workspace.getByRole("region", { name: "保存插件交付", exact: true }).waitFor()
      assert.equal(
        await workspace.getByRole("region", { name: "试用当前候选", exact: true }).count(),
        0,
        "An unresolved or failed delivery must surface its own visible destination even with a retained trial"
      )
      if (phase === "unknown")
        await workspace.getByRole("status").filter({ hasText: "上次操作结果待核对" }).waitFor()
      else
        await workspace.getByRole("alert").filter({ hasText: "此名称已被已安装插件使用" }).waitFor()
      assert.equal(
        await page.evaluate("window.fixture.calls.length"),
        beforeDeliveryAttention,
        "Attention routing only presents retained facts; it must not install, export or replay the trial"
      )
    }
    await page.screenshot({
      path: join(output, "delivery-attention-with-retained-trial.png"),
      fullPage: true
    })
    await page.evaluate("window.fixture.deliveryAttention(null)")
    await openCreatorStep(page, "trial")
    const beforeSourceReady = await page.evaluate("window.fixture.calls.length")
    await page.evaluate("window.fixture.sourceSetReady()")
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="插件制作步骤"] button')]
      .some(button => button.textContent === "3 · 保存插件" && button.getAttribute("aria-current") === "step"))
    assert.equal(await page.evaluate("window.fixture.calls.length"), beforeSourceReady,
      "An imported ready source set opens delivery without installing or starting a trial")
    await page.evaluate("window.fixture.hostRoute(false)")
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式与 Mod 状态"] button[aria-haspopup="dialog"]')?.textContent === "业务插件组装")
    await workspace.getByRole("button", { name: "3 · 保存插件", exact: true }).click()
    assert.equal(await workspace.getByRole("region", { name: "项目候选保存为新插件", exact: true }).count(), 0,
      "An unrelated Host request must not become this business review's delivery candidate")
    await workspace.getByRole("button", { name: "保存插件", exact: true }).waitFor()
    await workspace.getByRole("button", { name: "2 · 试用", exact: true }).click()
    await workspace.getByRole("region", { name: "业务插件试用", exact: true }).getByRole("button", { name: "开始试用", exact: true }).click()
    await page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true }).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='legacy-trial-request').length"), 1,
      "Opening the original legacy route must never itself request or approve execution")
    await page.keyboard.press("Escape")
    await page.getByRole("dialog", { name: "插件试用与整轮验收", exact: true }).waitFor({ state: "detached" })
    await page.evaluate("window.fixture.nativeReview()")
    await workspace.waitFor()
    const advancedReview = workspace.getByText("高级：独立项目试用", { exact: true }).locator("..")
    await advancedReview.waitFor()
    assert.equal(await advancedReview.evaluate(element => (element as HTMLDetailsElement).open), true,
      "A native Mod review must open the actual containing details even when no projectTrial card exists")
    const nativeReviewPanel = advancedReview.getByRole("region", { name: "阶段隔离调试", exact: true })
    await nativeReviewPanel.getByText("建议来自 Mod：独立调试助手", { exact: true }).waitFor()
    assert.equal(await nativeReviewPanel.getByLabel("选择阶段输入快照", { exact: true }).inputValue(), "native-review-snapshot")
    assert.equal(await nativeReviewPanel.getByLabel("选择已保存的最新候选", { exact: true }).inputValue(), "native-review-draft")
    assert.equal(await workspace.getByRole("article", { name: "项目真实试用请求", exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='review-auto-prepare'||row[0]==='review-auto-create').length"), 0,
      "Review navigation may neither prepare nor confirm execution")
    await page.screenshot({ path: join(output, "native-review-open-without-project-trial.png"), fullPage: true })
    for (const mode of ["matching", "different", "revision", "digest"]) {
      console.log("Native review route mode", mode)
      await page.evaluate(mode => (window as unknown as { fixture: { nativeReview(mode: string): void } }).fixture.nativeReview(mode), mode)
      const originalTrial = workspace.getByRole("article", { name: "项目真实试用请求", exact: true })
      await workspace.getByRole("heading", { name: "应保留的原试用", exact: true }).waitFor()
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="阶段隔离调试"]').length === 1)
      const selectedPanel = workspace.getByRole("region", { name: "阶段隔离调试", exact: true })
      try {
        await selectedPanel.getByText("建议来自 Mod：独立调试助手", { exact: true }).waitFor()
      } catch (error) {
        writeFileSync(join(output, "native-review-route-failure.json"), JSON.stringify({ mode,
          state: await page.evaluate(() => ({ text: document.body.innerText,
            details: [...document.querySelectorAll("details")].map(element => ({ summary: element.querySelector("summary")?.textContent, open: element.open })),
            reviewHeaders: [...document.querySelectorAll('[aria-label="Mod 提交的阶段调试建议"]')].map(element => element.textContent) })), errors }, null, 2))
        await page.screenshot({ path: join(output, "native-review-route-failure.png"), fullPage: true })
        throw error
      }
      assert.equal(await selectedPanel.getByLabel("选择已保存的最新候选", { exact: true }).inputValue(),
        mode === "different" ? "native-other-draft" : "native-review-draft")
      assert.equal(await advancedReview.evaluate(element => (element as HTMLDetailsElement).open), mode !== "matching")
      if (mode !== "matching") assert.equal(
        await workspace.getByText("组件与高级设置", { exact: true }).locator("..").evaluate(element => (element as HTMLDetailsElement).open), true,
        "Independent native review must also open the actual ancestor disclosure, not just its nested details")
      assert.equal(await originalTrial.getByRole("region", { name: "阶段隔离调试", exact: true }).count(), mode === "matching" ? 1 : 0,
        "Only an exact request revision/digest match may route review into the original trial card")
      assert.equal(await workspace.locator('[aria-label="Mod 提交的阶段调试建议"]').count(), 1,
        "One native intent must expose one review target, while retaining the original trial")
    }
    await workspace.getByRole("button", { name: "返回聊天修改", exact: true }).click()
    await workspace.waitFor({ state: "detached" })
    await page.evaluate("window.fixture.nativeReview('expired')")
    // Await native readback, rather than allowing the timeout to stand in for a result.
    await page.waitForFunction(() => (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.some(row => row[0] === "review-current-expired"))
    assert.equal(await workspace.count(), 0, "An expired intent must not reopen or confirm native review")
    const retainedTrial = await page.evaluate(() => window.api.mods.development.status({ threadId: "creator" }))
    assert.equal(retainedTrial.projectTrial?.id, "native-existing-request")
    assert.equal(retainedTrial.projectTrial?.draftId, "native-review-draft")
    assert.equal(retainedTrial.projectTrial?.digest, "d".repeat(64))
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='review-auto-prepare'||row[0]==='review-auto-create').length"), 0)


    await page.evaluate("window.fixture.cold()")
    const rail = page.getByLabel("聊天模式与 Mod 状态", { exact: true })
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式"] button[aria-pressed="true"]')?.textContent?.trim() === "普通模式")
    assert.equal(await rail.locator('button[aria-haspopup="dialog"]').count(), 0,
      "Ordinary mode must not expose a creation workspace")
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='cold-history-list').length"), 0,
      "Ordinary mode must not read or authorize persisted creator history")
    const beforeModeChanges = await page.evaluate("window.fixture.calls.filter(row=>row[0]==='set-mode').length")
    await rail.getByRole("button", { name: "创造者模式", exact: true }).click()
    await workspace.getByRole("heading", { name: "持久化项目与S6历史", exact: true }).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='set-mode').length"), beforeModeChanges + 1)
    assert.deepEqual(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='set-mode').at(-1)[1]"),
      { threadId: "creator", expectedWorkspace: "C:/creator", mode: "creator" })
    await page.screenshot({ path: join(output, "cold-creator-explicit-entry.png"), fullPage: true })
    const coldTrial = workspace.getByRole("article", { name: "项目真实试用请求", exact: true })
    await coldTrial.getByText(/调试分支仅保留历史记录/).waitFor()
    await coldTrial.getByText("按阶段修改与隔离调试", { exact: true }).click()
    const coldDebug = coldTrial.getByRole("region", { name: "阶段隔离调试", exact: true })
    await coldDebug.locator("summary").filter({ hasText: "隔离调试结果与来源对照" }).click()
    await coldDebug.getByText("冷启动保留的调试记录；本进程没有此分支的运行授权。", { exact: true }).waitFor()
    assert.equal(await workspace.getByText("整轮试用已通过", { exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='review-auto-prepare'||row[0]==='review-auto-create').length"), 0,
      "Reentering creator mode must not prepare/create or restore a branch execution grant")
    await page.screenshot({ path: join(output, "cold-history-readonly-after-entry.png"), fullPage: true })
    await workspace.getByRole("button", { name: "返回聊天修改", exact: true }).click()
    await rail.getByRole("button", { name: "普通模式", exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="聊天模式"] button[aria-pressed="true"]')?.textContent?.trim() === "普通模式")
    assert.equal(await rail.getByRole("button", { name: "普通模式", exact: true }).getAttribute("aria-pressed"), "true")
    assert.equal(await page.evaluate("window.fixture.calls.filter(row=>row[0]==='set-mode').at(-1)[1].mode"), "normal",
      "Normal mode remains an explicit user choice and must not auto-reenter creator mode")

    await page.evaluate("window.fixture.emptySource()")
    await workspace.waitFor({ state: "hidden" })
    assert.equal(await rail.getByRole("button", { name: "导入插件源码", exact: true }).count(), 0)
    await rail.getByRole("button", { name: "创造者模式", exact: true }).click()
    await workspace.waitFor({ state: "hidden" })
    const importStart = await page.evaluate("window.fixture.calls.length")
    await rail.getByRole("button", { name: "导入插件源码", exact: true }).click()
    const importedSource = workspace.getByRole("region", { name: "导入项目作者源码", exact: true })
    await importedSource.getByText("本次导入的源码", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.calls.slice(" + importStart + ").filter(row=>row[0]!=='cold-history-list')"), [
      ["import-source", { threadId: "creator", expectedWorkspace: "C:/creator" }]
    ], "Importing an author source opens its dependency review without installing or authorizing anything")
    await page.screenshot({ path: join(output, "empty-creator-source-import.png") })
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
