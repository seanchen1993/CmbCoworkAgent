import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/sparks-ux-redesign-20261010", `development-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/customize/ModsDevelopmentPanel.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React from "react";import{createRoot}from"react-dom/client";import{ModsDevelopmentPanel}from${JSON.stringify(entry)};
    const root=createRoot(document.getElementById("root"));let key=0,listeners=new Set(),calls=[],returned=0,promoted=[],workbench=0,repairs=[],repairSnapshots=[],holdRepair=false,finishRepair,reads=0,defer=false,finish,readDefer=false,finishRead,failRead=false,reuseDeferred=false,finishReuse; 
    let current={threadId:"thread",workspace:"c:/owned/workspace",enabled:false,mode:"normal",drafts:[],trials:[]};
    const trial=phase=>({componentId:"counter",draftId:"draft",revision:2,bundleDigest:"b".repeat(64),compiledDigest:"c".repeat(64),phase,activeRevision:1,activeDigest:"a".repeat(64),capabilities:["event:tool.call","ui.resolve"]});
    const api={status:async({threadId})=>{reads++;if(failRead){const reason=failRead;failRead=false;throw Error(reason==="disabled"?"DEVELOPMENT_MODS_DISABLED":"PRIVATE_ERROR")};const data=structuredClone(threadId==="other"?{...current,threadId:"other",workspace:"other-space",enabled:false,mode:"normal",drafts:[],trials:[]}:current);if(readDefer&&threadId==="thread")return new Promise(r=>finishRead=()=>r(data));return data},
      setEnabled:async input=>{calls.push(["enable",input]);current={...current,enabled:input.enabled,mode:input.enabled?"creator":"normal"};return structuredClone(current)},
      setMode:async input=>{calls.push(["mode",input]);current={...current,mode:input.mode,enabled:input.mode==="creator"?true:current.enabled};return structuredClone(current)},
      approve:async input=>{calls.push(["approve",input]);const done=()=>{current={...current,trials:[trial("queued")]};return structuredClone(current)};return defer?await new Promise(r=>finish=()=>r(done())):done()},
      stop:async input=>{calls.push(["stop",input]);current={...current,trials:[trial("stopped")]};return structuredClone(current)},
      requestReuse:async input=>{calls.push(["requestReuse",input]);const draft=current.drafts.find(row=>row.id===input.id);if(!draft||draft.revision!==input.revision)throw Error("STALE");current.reuse={phase:"needs-approval",planId:"plan-"+draft.revision,name:draft.name,draftId:draft.id,revision:draft.revision,sourceDigest:draft.digest,compiledDigest:"f".repeat(64),targetProfileDigest:"9".repeat(64),capabilities:["event:tool.call","ui.resolve"]};return structuredClone(current)},
      approveReuse:async input=>{calls.push(["approveReuse",input]);const plan=current.reuse;if(input.planId!==plan.planId||input.sourceDigest!==plan.sourceDigest||input.compiledDigest!==plan.compiledDigest||input.targetProfileDigest!==plan.targetProfileDigest)throw Error("STALE");const done=()=>{current.reuse={...plan,phase:"active"};return structuredClone(current)};return reuseDeferred?await new Promise(resolve=>finishReuse=()=>{reuseDeferred=false;resolve(done())}):done()},
      undoTrial:async input=>{calls.push(["undoTrial",input]);current.trials=[{...trial("active"),revision:1,activeRevision:1,canUndo:false}];current.undo={phase:"queued"};return structuredClone(current)},
      cancelComposition:async input=>{calls.push(["cancelComposition",input]);current.composition={...current.composition,phase:"cancelled",canCancel:false,canUndo:false};return structuredClone(current)},
      undoComposition:async input=>{calls.push(["undoComposition",input]);current.composition={...current.composition,phase:"queued",name:"撤销：统计与重试",canCancel:true,canUndo:false};return structuredClone(current)},
      promote:async input=>{calls.push(["promote",input]);return {workspace:current.workspace,id:"saved",revision:1,name:"Saved",source:{digest:"b".repeat(64),files:[]}}},
      onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}};
    let globalEnabled=false,workspaceEnabled=false,holdSetup=false,finishSetup;
    const settings={globalEnabled:async()=>holdSetup?await new Promise(resolve=>finishSetup=()=>{holdSetup=false;resolve(globalEnabled)}):globalEnabled,status:async()=>({workspace:current.workspace,enabled:workspaceEnabled,outputPolicy:true,mods:[],diagnostics:[]}),configureGlobal:async value=>{calls.push(["global",value]);globalEnabled=value;return value},configure:async(thread,enabled,policy,workspace)=>{calls.push(["workspace",{thread,enabled,policy,workspace}]);workspaceEnabled=enabled}};
    window.electron={process:{platform:"win32"}};
    window.api={mods:{development:api,...settings}};
    const requestRepair=async text=>{repairs.push(text);repairSnapshots.push({mode:current.mode,threadId:current.threadId,input:document.getElementById("composer").value});if(current.mode!=="creator")throw Error("CREATOR_REPAIR_MODE_REQUIRED");if(holdRepair)await new Promise((resolve,reject)=>{finishRepair=error=>{holdRepair=false;finishRepair=undefined;if(error)reject(Error(error));else resolve()}})};
    const mount=(mode="entry",threadId="thread",workspaceHint="C:/Owned/Workspace",blocked=false)=>root.render(<ModsDevelopmentPanel key={++key} api={api} threadId={threadId} workspaceHint={workspaceHint} mode={mode} promotionBlocked={blocked} onSelectWorkspaceForCreator={async()=>{calls.push(["selectWorkspace",{threadId}])}} onOpenWorkbench={()=>workbench++} onReturnToChat={()=>{returned++;document.getElementById("composer").focus()}} onRequestRepair={requestRepair} onPromoted={value=>promoted.push(value)}/>);
    const emit=(threadId="thread")=>listeners.forEach(fn=>fn({threadId}));
    window.fixture={longNeeds:()=>{current.trials=[{...trial("needs-approval"),activeRevision:undefined,capabilities:["event:tool.call","ui.toast","store.get","command.register","event:turn.complete","session.usage","clock.now",...Array.from({length:80},(_,i)=>"custom.permission."+i)]}];emit()},firstFailed:()=>{current.trials=[{...trial("failed"),activeRevision:undefined,error:"MODS_COMMAND_CONFLICT: SECRET_PRIVATE_PATH"}];emit()},failDisabled:()=>{failRead="disabled"},failRead:()=>failRead=true,calls,mount,emit,get:()=>({current,calls,returned,promoted,workbench,repairs,reads,listeners:listeners.size,readReady:!!finishRead,setupReady:!!finishSetup}),needs:()=>{current={...current,enabled:true,mode:"creator",drafts:[{id:"draft",name:"Counter",revision:2,digest:"b".repeat(64)}],trials:[trial("needs-approval")]};emit()},defer:()=>defer=true,finish:()=>{defer=false;finish()},queuedReason:reason=>{current.trials=[{...trial("queued"),waitingReason:reason}];emit()},queuedBusy:()=>{current.trials=[{...trial("queued"),error:"MODS_DEVELOPMENT_BUSY"}];emit()},usageDenied:()=>{current.trials=[{...trial("failed"),error:"CLAW_COMPONENT_USAGE_UNAVAILABLE: project-only"}];emit()},failed:()=>{current.trials=[{...trial("failed"),error:"SECRET_PRIVATE_PATH"}];emit()},active:()=>{current.trials=[{...trial("active"),activeRevision:2,canUndo:true}];current.undo=undefined;emit()},disabled:()=>{current.trials=[{...trial("failed"),error:"DEVELOPMENT_MODS_DISABLED"}];emit()},foreign:()=>{current.workspace="foreign";emit()},readDefer:()=>readDefer=true,finishRead:()=>finishRead()};mount("chat");
    const priorApprove=api.approve;
    api.approve=async input=>{if(current.trials[0]?.validation!=="authorized-real")return priorApprove(input);calls.push(["approve",input]);current.trials[0]={...current.trials[0],phase:"active",activeRevision:current.trials[0].revision};return structuredClone(current)};
    window.fixture.realNeeds=(changed=false)=>{readDefer=false;current={threadId:"thread",workspace:"c:/owned/workspace",enabled:true,mode:"creator",drafts:[{id:"draft",name:"真实文件动作",revision:changed?3:2,digest:"d".repeat(64)}],trials:[{...trial("needs-approval"),revision:changed?3:2,bundleDigest:(changed?"e":"d").repeat(64),validation:"authorized-real",purpose:"在当前目标读取文件并写入经过批准的结果",capabilities:["fs.read","fs.write"],addedCapabilities:["fs.write"]}]};emit()};
    window.fixture.composition=(phase,error)=>{current.composition=phase==="clear"?undefined:{phase,name:"统计与重试",pluginNames:["工具统计","失败重试"],canCancel:phase==="queued",canUndo:phase==="active"||error==="COMPOSITION_RUNTIME_UNCONFIRMED",savedName:phase==="active"?"我的工具搭配":undefined,error:phase==="failed"?(error??"SECRET_COMPOSITION_ERROR"):undefined};emit()};
    window.fixture.failCurrentComposition=()=>{current.composition={...current.composition,phase:"failed",error:"PRIVATE_UNDO_ERROR",canUndo:false,canCancel:false};emit()};window.fixture.undoPhase=phase=>{current.undo={phase};emit()};window.fixture.reuseUnknown=()=>{current.reuse={...current.reuse,phase:"unknown"};emit()};window.fixture.clearReuse=()=>{current.reuse=undefined;current.drafts[0]={...current.drafts[0],revision:2,digest:"b".repeat(64)};emit()};window.fixture.changeReuseSource=()=>{current.drafts[0]={...current.drafts[0],revision:3,digest:"7".repeat(64)};emit()};window.fixture.deferReuse=()=>reuseDeferred=true;window.fixture.finishReuse=()=>finishReuse();
    window.fixture.deferSetup=()=>holdSetup=true;window.fixture.finishSetup=()=>finishSetup();
    window.fixture.deferRepair=()=>holdRepair=true;window.fixture.finishRepair=error=>finishRepair(error);window.fixture.repairState=()=>({repairs,repairSnapshots,repairReady:typeof finishRepair==="function"});
    window.fixture.realUnknown=()=>{current.trials[0]={...current.trials[0],phase:"active",diagnostics:{providers:1,subscriptions:2,inFlight:0,unknownRequests:1}};emit()};
    window.fixture.unknownStop=()=>{current.trials[0]={...current.trials[0],phase:"unknown"};emit()};
    window.fixture.requestBudget=request=>{current.request=request;emit()};
  `
    },
    bundle: true,
    plugins: [browserWorkerPlugin()],
    loader: { ".md": "text", ".png": "dataurl" },
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
    const page = await browser.newPage({ viewport: { width: 1050, height: 950 } }),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><meta charset="utf-8"><textarea id="composer" aria-label="原聊天输入框"></textarea><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://fixture.test")
    for (const file of readdirSync("out/renderer/assets").filter(name => name.endsWith(".css")))
      await page.addStyleTag({path: resolve("out/renderer/assets", file)})
    await page.evaluate(() => { document.body.style.padding = "12px" })
    await page.waitForFunction(
      () => (window as unknown as { fixture: { get(): { reads: number } } }).fixture.get().reads > 0
    )
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    const call = async (name: string, ...args: unknown[]) =>
      page.evaluate(
        ({ name, args }) => {
          const f = (
            window as unknown as { fixture: Record<string, (...args: unknown[]) => unknown> }
          ).fixture
          return f[name](...args)
        },
        { name, args }
      )
    const openAdvanced = async () => {
      const details = page.locator('details[data-creator-section="create"]')
      if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
        await details.locator(":scope > summary").click()
    }
    await call("failRead")
    await call("mount", "chat")
    const readFailure = page.getByText("暂时无法读取创作状态。请点击“重新读取状态”后继续。", { exact: true })
    await readFailure.waitFor()
    await page.getByRole("button", { name: "重新读取状态", exact: true }).click()
    await readFailure.waitFor({ state: "hidden" })
    await page.keyboard.press("Escape")
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    await page.getByRole("textbox", { name: "原聊天输入框" }).fill("保留尚未发送的需求")
    await page.getByRole("button", { name: "创造者模式", exact: true }).click()
    await page.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
    assert.equal(await page.getByLabel("灵件对话创作").count(), 0)
    assert.equal(await page.getByRole("textbox", { name: "原聊天输入框" }).inputValue(), "保留尚未发送的需求")
    await page.waitForFunction(() => document.activeElement?.id === "composer")
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    assert.equal(((await call("get")) as { returned: number }).returned, 1)
    const enable = (
      (await call("get")) as { calls: [string, { expectedWorkspace: string }][] }
    ).calls.find((item) => item[0] === "mode")!
    assert.equal(enable[1].expectedWorkspace, "c:/owned/workspace")
    await call("needs")
    await page.getByRole("button", { name: /确认灵件试用，1 项待确认/, includeHidden: true })
      .waitFor({ state: "attached" })
    assert.equal(await page.getByRole("checkbox").count(), 0)
    await page.getByText("查看和调整工具调用", { exact: true }).waitFor()
    assert.equal(await page.getByText(/源码摘要/).isVisible(), false)
    const approve = page.getByRole("button", { name: "确认并应用到这段聊天" })
    await approve.waitFor()
    assert(await approve.isEnabled())
    await call("requestBudget", { runId: "original-run", startedAt: 1, operations: 4, candidates: 3 })
    await page.getByText("制作记录与用量", { exact: true }).click()
    await page.getByText("最近一次需求已检查 3/3 个候选；重新打开界面不会重置修复次数。", { exact: true }).waitFor()
    await call("requestBudget", { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" })
    await page.getByText("本次制作预算无法核对，已停止继续提交。草稿和当前功能仍保留。", { exact: true }).waitFor()
    await call("requestBudget", undefined)
    const approvalsBeforeClick = ((await call("get")) as { calls: unknown[][] }).calls
      .filter(([name]) => name === "approve").length
    assert.equal(approvalsBeforeClick, 0, "auto-opening the permission summary must not approve")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /确认灵件试用，1 项待确认/ }).click()
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls
      .filter(([name]) => name === "approve").length, 0, "opening the summary must not approve")
    await call("defer")
    await approve.click()
    assert(await approve.isDisabled())
    await approve.evaluate((element) => (element as HTMLButtonElement).click())
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls
      .filter(([name]) => name === "approve").length, 1, "busy approval must not submit twice")
    await call("finish")
    await openAdvanced()
    await page.getByText(/已排队，等待本轮结束/).waitFor()
    assert.equal(await page.getByText(/本会话已生效/).count(), 0)
    assert.equal(
      ((await call("get")) as { calls: [string, unknown][] }).calls.filter(
        (c) => c[0] === "approve"
      ).length,
      1
    )
    await page.getByText("高级：源码与手动复用", {exact:true}).click()
    await page.getByRole("button", { name: "保存复用并打开源码" }).click()
    assert.equal(((await call("get")) as { promoted: unknown[] }).promoted.length, 1)
    await call("usageDenied")
    await page.getByText("这个版本未能启动。请让助手检查原因、修改后再试用。", { exact: true }).waitFor()
    assert.equal(await page.getByText(/CLAW_COMPONENT_USAGE_UNAVAILABLE/).count(), 0)
    await page.keyboard.press("Escape")
    await call("failed")
    await page.getByText(/新版本试用失败/).waitFor()
    assert.equal(((await call("get")) as { repairs: string[] }).repairs.length, 0,
      "a new failure opens its card without automatically requesting repair")
    await page.keyboard.press("Escape")
    const failureReads = ((await call("get")) as { reads: number }).reads
    await call("emit")
    await page.waitForFunction(before =>
      (window as unknown as { fixture: { get(): { reads: number } } }).fixture.get().reads > before,
    failureReads)
    assert.equal(await page.getByText(/新版本试用失败/).isVisible(), false,
      "the same failed revision must stay dismissed on repeated status notifications")
    await page.getByRole("button", { name: "试用失败 · 查看处理", exact: true }).click()
    assert(await page.getByText(/正在使用：v1/).isVisible())
    assert.equal(await page.getByText("SECRET_PRIVATE_PATH", { exact: false }).count(), 0)
    await page.screenshot({ path: join(output, "development-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 540, height: 920 })
    await page.screenshot({ path: join(output, "development-narrow.png"), fullPage: true })
    assert.equal(await page.getByRole("button", {name:"确认并应用到这段聊天"}).count(), 0)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "普通模式", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "试用失败 · 查看处理", exact: true }).count(), 0,
      "Ordinary mode hides creation controls while retaining the original failed trial")
    await page.getByRole("button", { name: "创造者模式", exact: true }).click()
    await page.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
    await page.getByRole("button", { name: "试用失败 · 查看处理", exact: true }).click()
    const beforeRepair = (await call("get")) as { calls: unknown[][]; returned: number }
    const approvalsBeforeRepair = beforeRepair.calls.filter(([name]) => name === "approve").length
    await call("deferRepair")
    await page.getByRole("button", { name: "修复并重新检查", exact: true }).click()
    const submittingRepair = page.getByRole("button", { name: "正在提交修复…", exact: true })
    await submittingRepair.waitFor()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { repairState(): { repairReady: boolean } } }).fixture.repairState().repairReady)
    await submittingRepair.evaluate(element => (element as HTMLButtonElement).click())
    const firstRepair = (await call("repairState")) as {
      repairs: string[]; repairSnapshots: { mode: string; threadId: string; input: string }[]
    }
    assert.equal(firstRepair.repairs.length, 1, "one click submits one asynchronous repair")
    assert.deepEqual(firstRepair.repairSnapshots, [{
      mode: "creator", threadId: "thread", input: "保留尚未发送的需求"
    }], "the native creator mode must be entered before invoking the repair callback")
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.length, beforeRepair.calls.length + 1)
    assert.equal(((await call("get")) as { returned: number }).returned, beforeRepair.returned)
    await call("finishRepair", "CREATOR_REPAIR_MODEL_REQUIRED")
    await page.getByText("请先选择可用模型，再修复灵件。", { exact: true }).waitFor()
    assert.equal(await page.getByText("CREATOR_REPAIR_MODEL_REQUIRED", { exact: false }).count(), 0)
    await page.getByText(/新版本试用失败/).waitFor()
    const retryRepair = page.getByRole("button", { name: "修复并重新检查", exact: true })
    assert(await retryRepair.isEnabled(), "a rejected repair must leave the card open and allow retry")
    assert.equal(((await call("get")) as { returned: number }).returned, beforeRepair.returned)
    // The native modal intentionally hides its background from the accessibility tree.
    // Observe the retained draft without interacting through the modal; after successful
    // repair below, the ordinary role lookup and focus checks must work again.
    assert.equal(await page.getByRole("textbox", {
      name: "原聊天输入框", includeHidden: true
    }).inputValue(), "保留尚未发送的需求")
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "approve").length,
      approvalsBeforeRepair, "repair failure must not approve a candidate")
    await call("deferRepair")
    await retryRepair.click()
    await submittingRepair.waitFor()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { repairState(): { repairReady: boolean } } }).fixture.repairState().repairReady)
    assert.equal(((await call("repairState")) as { repairs: string[] }).repairs.length, 2)
    assert.equal(((await call("get")) as { returned: number }).returned, beforeRepair.returned)
    await call("finishRepair")
    await page.waitForFunction(() => document.activeElement?.id === "composer")
    assert.equal(await retryRepair.count(), 0, "only a successfully accepted repair closes the card")
    assert.equal(((await call("get")) as { returned: number }).returned, beforeRepair.returned + 1)
    assert.equal(await page.getByRole("textbox", { name: "原聊天输入框" }).inputValue(), "保留尚未发送的需求")
    assert(await page.getByRole("textbox", { name: "原聊天输入框" }).isEditable(),
      "accepted repair must close the modal and restore the retained editable composer")
    assert(((await call("repairState")) as { repairs: string[] }).repairs.every(text => !text.includes("SECRET_PRIVATE_PATH")))
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "approve").length,
      approvalsBeforeRepair, "submitting repair never substitutes for exact-version human approval")
    await page.getByRole("button", {name:"试用失败 · 查看处理",exact:true}).click()
    await call("firstFailed")
    await page.getByText("此灵件还没有在这段聊天生效，无需再次寻找批准按钮。",{exact:true}).waitFor()
    await page.getByText("快捷指令与已启用的灵件重名。请让助手更换指令名称后再试。",{exact:true}).waitFor()
    await call("failDisabled")
    await page.getByRole("button",{name:"刷新状态",exact:true}).click()
    await page.getByRole("button",{name:"开启灵件功能",exact:true}).waitFor()
    await page.getByRole("button",{name:"刷新状态",exact:true}).click()
    await call("queuedReason", "turn-interrupted")
    await openAdvanced()
    await page.getByText("本轮制作被停止或未完成", {exact:false}).waitFor()
    assert.equal(await page.getByRole("button", {name:"重新检查试用"}).count(), 0)
    await call("queuedReason", "conversation-busy")
    await page.getByText("当前聊天还有任务或界面操作", {exact:false}).waitFor()
    const beforeRetry = ((await call("get")) as {calls: unknown[][]}).calls.filter(row=>row[0]==="approve").length
    await page.getByRole("button", {name:"重新检查试用"}).click()
    assert.equal(((await call("get")) as {calls: unknown[][]}).calls.filter(row=>row[0]==="approve").length, beforeRetry + 1)
    await call("queuedBusy")
    await page.getByText("等待当前界面操作结束；已生效的旧版仍保留。").waitFor()
    await page.getByText(/正在使用：v1/).waitFor()
    await call("active")
    await call("mount", "chat")
    await page.getByRole("button", { name: "普通模式", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    const normal = (await call("get")) as { current: { enabled: boolean; trials: { phase: string }[] }; calls: [string, { mode?: string }][] }
    assert.equal(normal.current.enabled, true)
    assert.equal(normal.current.trials[0].phase, "active")
    assert.equal(normal.calls.filter(([name]) => name === "enable" || name === "stop").length, 0)
    assert.equal(normal.calls.at(-1)![1].mode, "normal")
    assert.equal(await page.getByRole("textbox", { name: "原聊天输入框" }).inputValue(), "保留尚未发送的需求")
    assert.equal(await page.getByRole("button", { name: "灵件试用中", exact: true }).count(), 0,
      "Ordinary mode keeps active Mods without displaying the creator workspace")
    await page.getByRole("button", { name: "创造者模式", exact: true }).click()
    await page.getByRole("button", { name: "创造者模式", exact: true, pressed: true }).waitFor()
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    await openAdvanced()
    assert.equal(await page.getByLabel("项目模板隔离试用").count(), 0, "project authoring stays collapsed")
    await page.getByRole("button", { name: "撤销这次修改", exact: true }).click()
    const trialUndo = ((await call("get")) as { calls: [string, unknown][] }).calls.filter(([name]) => name === "undoTrial")
    assert.deepEqual(trialUndo, [["undoTrial", { threadId: "thread", expectedWorkspace: "c:/owned/workspace" }]])
    await page.getByText("已准备撤销，正在等待当前操作结束并恢复运行状态。", { exact: true }).waitFor()
    await call("undoPhase", "active")
    await page.getByText("撤销已完成。请核对当前聊天显示与操作效果。", { exact: true }).waitFor()
    await call("undoPhase", "failed")
    await page.getByText("撤销尚未确认完成，请先刷新状态核对当前运行版本，不要重复执行。", { exact: true }).waitFor()
    await call("active")
    await page.getByRole("button", { name: /^保存“.+”并在其他聊天复用…$/ }).click()
    const reuseApprove = page.getByRole("button", { name: "确认保存并复用", exact: true })
    await page.getByText("可在其他聊天选择这份组合；使用默认继承设置的聊天也会包含本项目已授权的功能。保存不会发送消息或执行任务。", { exact: true }).waitFor()
    await reuseApprove.waitFor()
    await page.screenshot({ path: join(output, "reuse-confirmation.png"), fullPage: true })
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "approveReuse").length, 0)
    await call("changeReuseSource")
    await page.getByText("当前草稿已更新，请先重新准备最新版本。", { exact: true }).waitFor()
    assert(await reuseApprove.isDisabled())
    await page.getByRole("button", { name: "重新准备最新版本", exact: true }).click()
    await page.getByText("当前草稿已更新，请先重新准备最新版本。", { exact: true }).waitFor({ state: "hidden" })
    await call("deferReuse")
    await reuseApprove.click()
    assert(await reuseApprove.isDisabled())
    await reuseApprove.evaluate(element => (element as HTMLButtonElement).click())
    await call("finishReuse")
    await page.getByText("正式版本和可复用组合已保存，当前聊天已使用。可在其他聊天选择这份组合。", { exact: true }).waitFor()
    const reuseCalls = ((await call("get")) as { calls: [string, unknown][] }).calls.filter(([name]) => name === "approveReuse")
    assert.equal(reuseCalls.length, 1, "one explicit confirmation drives the whole reuse operation")
    assert.deepEqual(reuseCalls[0][1], { threadId: "thread", expectedWorkspace: "c:/owned/workspace", planId: "plan-3", sourceDigest: "7".repeat(64), compiledDigest: "f".repeat(64), targetProfileDigest: "9".repeat(64) })
    await call("reuseUnknown")
    await page.getByText("保存或切换结果待核对。请先核对当前状态，不要重复安装或授权。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "核对复用状态", exact: true }).click()
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "approveReuse").length, 1,
      "unknown reuse state offers a read, never another approval")
    await call("clearReuse")
    await page.keyboard.press("Escape")
    await call("composition", "queued")
    await page.getByRole("button", { name: "正在应用组合", exact: true }).click()
    await openAdvanced()
    await page.getByText("组合已准备好，本轮任务结束且聊天空闲后自动应用。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "取消排队", exact: true }).click()
    await page.getByText("已取消这次组合变更，原有设置继续使用。", { exact: true }).waitFor()
    await call("composition", "active")
    await page.getByText("组合已应用到当前聊天，普通模式下也会继续使用。", { exact: true }).waitFor()
    await page.getByText("已保存组合“我的工具搭配”，可在其他聊天选择使用。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "撤销这次组合", exact: true }).click()
    await page.getByText("组合已准备好，本轮任务结束且聊天空闲后自动应用。", { exact: true }).waitFor()
    const combinationCalls = ((await call("get")) as { calls: [string, unknown][] }).calls.filter(([name]) => name === "cancelComposition" || name === "undoComposition")
    assert.deepEqual(combinationCalls, [["cancelComposition", { threadId: "thread", expectedWorkspace: "c:/owned/workspace" }], ["undoComposition", { threadId: "thread", expectedWorkspace: "c:/owned/workspace" }]])
    await call("failCurrentComposition")
    await page.getByText("撤销：统计与重试", { exact: true }).waitFor()
    await page.getByText("组合未能应用。请让助手检查当前权限和功能可用状态后重试。", { exact: true }).waitFor()
    assert.equal(await page.getByText("组合已应用到当前聊天，普通模式下也会继续使用。", { exact: true }).count(), 0,
      "failed undo must not report the previous selection as restored")
    assert.equal(await page.getByText("已取消这次组合变更，原有设置继续使用。", { exact: true }).count(), 0)
    assert.equal(await page.getByText("撤销已完成。请核对当前聊天显示与操作效果。", { exact: true }).count(), 0)
    assert.equal(await page.getByText("PRIVATE_UNDO_ERROR", { exact: false }).count(), 0)
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "undoComposition").length, 1,
      "failed undo must not retry itself")
    await page.keyboard.press("Escape")
    await call("composition", "failed")
    await openAdvanced()
    await page.getByLabel("Mod 组合状态").waitFor()
    await page.getByText("组合未能应用。请让助手检查当前权限和功能可用状态后重试。", { exact: true }).waitFor()
    assert.equal(await page.getByText("SECRET_COMPOSITION_ERROR", { exact: false }).count(), 0)
    await page.keyboard.press("Escape")
    const beforeUnconfirmed = ((await call("get")) as { calls: unknown[] }).calls.length
    await call("composition", "failed", "MODS_COMPOSITION_APPLY_UNCONFIRMED")
    await openAdvanced()
    await page.getByRole("button", { name: "组合切换待核对", exact: true, includeHidden: true })
      .waitFor({ state: "attached" })
    await page.getByText("组合已保存，运行切换结果待核对。请先核对当前运行状态，不要重复应用。", { exact: true }).waitFor()
    assert.equal(await page.getByText("MODS_COMPOSITION_APPLY_UNCONFIRMED", { exact: false }).count(), 0)
    assert.equal(await page.getByText("组合未能应用。请让助手检查当前权限和功能可用状态后重试。", { exact: true }).count(), 0)
    assert.equal(((await call("get")) as { calls: unknown[] }).calls.length, beforeUnconfirmed,
      "an unconfirmed runtime switch must not trigger another application")
    await page.keyboard.press("Escape")
    await call("composition", "failed", "COMPOSITION_RUNTIME_UNCONFIRMED")
    await openAdvanced()
    await page.getByRole("button", { name: "组合运行待核对", exact: true, includeHidden: true })
      .waitFor({ state: "attached" })
    await page.getByText("组合选择仍保留，组件运行状态待核对。请先核对当前运行状态，不要重复应用。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "撤销这次组合", exact: true }).waitFor()
    assert.equal(await page.getByText("COMPOSITION_RUNTIME_UNCONFIRMED", { exact: false }).count(), 0)
    assert.equal(await page.getByText("组合未能应用。请让助手检查当前权限和功能可用状态后重试。", { exact: true }).count(), 0)
    assert.equal(await page.getByText("组合已应用到当前聊天，普通模式下也会继续使用。", { exact: true }).count(), 0)
    assert.equal(((await call("get")) as { calls: unknown[] }).calls.length, beforeUnconfirmed,
      "unconfirmed component health preserves undo without triggering another application")
    await call("composition", "active")
    await page.getByText("组合已应用到当前聊天，普通模式下也会继续使用。", { exact: true }).waitFor()
    await call("composition", "clear")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    await openAdvanced()
    await page.getByText(/本会话已生效/).waitFor()
    assert.equal(await page.getByText(/直接描述想做的组件/).count(), 0)
    assert.equal(await page.getByRole("button", {name:"结束创作并停止本会话试用"}).isVisible(), false)
    await page.getByText("创作选项",{exact:true}).click()
    assert(await page.getByRole("button", {name:"结束创作并停止本会话试用"}).isVisible())
    assert.equal(await page.getByText(/源码摘要/).isVisible(), false)
    await page.getByText("制作详情与完整权限", { exact: true }).click()
    assert(await page.getByText(/源码摘要/).isVisible())
    await page.getByText("制作详情与完整权限", { exact: true }).click()
    await page.getByText("高级：源码与手动复用",{exact:true}).click()
    await page.getByRole("button", { name: "保存并复用…", exact: true }).click()
    assert.equal(((await call("get")) as { workbench: number }).workbench, 1)
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    await page.screenshot({ path: join(output, "development-compact-chat.png"), fullPage: true })
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    await call("longNeeds")
    await page.setViewportSize({width:375,height:812})
    await page.keyboard.press("Escape")
    await page.getByRole("button",{name:/确认灵件试用，1 项待确认/}).click()
    const primary = page.getByRole("button",{name:"确认并应用到这段聊天",exact:true})
    await primary.waitFor()
    const box = await primary.boundingBox()
    assert(box && box.y >= 0 && box.y+box.height <= 812, "approval must remain in first viewport")
    assert.equal(await page.getByText("custom.permission.79",{exact:true}).isVisible(),false)
    assert(await primary.isEnabled())
    assert.equal(await page.getByRole("checkbox").count(), 0)
    await page.screenshot({path:join(output,"approval-long-375.png"),fullPage:true})
    await page.getByText("制作详情与完整权限",{exact:true}).click()
    assert.equal(await page.locator("article li").filter({hasText:/^custom.permission./}).count(),80)
    await page.getByText("制作详情与完整权限",{exact:true}).click()
    const before = ((await call("get")) as { reads: number }).reads
    await call("emit", "unrelated")
    assert.equal(((await call("get")) as { reads: number }).reads, before)
    await call("foreign")
    await page.getByText("会话、项目或版本已变化，请刷新状态后核对。").waitFor()
    await call("readDefer")
    await call("mount")
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { get(): { readReady: boolean } } }).fixture.get()
          .readReady
    )
    await call("mount", "chat", "other", "other-space")
    await call("finishRead")
    await page.waitForFunction(
      () =>
        (window as unknown as { fixture: { get(): { listeners: number } } }).fixture.get()
          .listeners === 1
    )
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    const approvalCalls = ((await call("get")) as {calls:[string,unknown][]}).calls.filter(row=>row[0]==="approve")
    assert.deepEqual(approvalCalls[0][1], {threadId:"thread",expectedWorkspace:"c:/owned/workspace",id:"counter",revision:2,digest:"c".repeat(64),sourceDigest:"b".repeat(64)})
    await call("realNeeds")
    await call("mount", "entry", "thread", "C:/Owned/Workspace")
    await page.getByText("允许这个灵件：", {exact:true}).waitFor()
    await page.getByText(/本次新增权限：.*修改当前目标的文件/).waitFor()
    await call("realNeeds", true)
    const realApprove = page.getByRole("button", {name:"确认并应用到这段聊天",exact:true})
    await page.getByText("· v3", { exact: true }).waitFor()
    assert(await realApprove.isEnabled())
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls
      .filter(([name]) => name === "approve").length, approvalCalls.length,
      "changing source must wait for a fresh explicit application click")
    await page.screenshot({path:join(output,"real-approval-375.png"),fullPage:true})
    await realApprove.click()
    await openAdvanced()
    await page.getByText("版本已生效，真实结果待核对",{exact:true}).waitFor()
    await page.getByText(/执行目标动作后读取实际状态/).waitFor()
    const realCalls = ((await call("get")) as {calls:[string,{revision?:number;digest?:string;sourceDigest?:string}][]}).calls
      .filter(([name])=>name==="approve")
    assert.equal(realCalls.length,approvalCalls.length+1)
    assert.equal(realCalls.at(-1)![1].sourceDigest,"e".repeat(64))
    assert.equal(realCalls.at(-1)![1].digest,"c".repeat(64))
    assert.equal(realCalls.at(-1)![1].revision,3)
    await call("realUnknown")
    await page.getByText(/存在结果未知的真实调用/).waitFor()
    await page.getByText("制作详情与完整权限",{exact:true}).click()
    await page.getByLabel("宿主资源诊断").getByText(/后台资源 未知/).waitFor()
    await call("unknownStop")
    await page.getByText(/未知操作不会自动重试/).waitFor()
    await page.screenshot({path:join(output,"real-unknown-375.png"),fullPage:true})
    await call("mount", "chat")
    await page.getByRole("button", { name: "恢复这个灵件", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    const attentionReads = ((await call("get")) as { reads: number }).reads
    await call("emit")
    await page.waitForFunction(before =>
      (window as unknown as { fixture: { get(): { reads: number } } }).fixture.get().reads > before,
    attentionReads)
    assert.equal(await page.getByRole("button", { name: "恢复这个灵件", exact: true }).isVisible(), false,
      "repeated notices for the same trial attention must not reopen a dismissed card")
    await page.getByRole("button", { name: "试用结果待核对", exact: true }).click()
    const beforeRestore = ((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "requestReuse").length
    await page.getByRole("button", { name: "恢复这个灵件", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === "composer")
    assert.equal(((await call("get")) as { calls: unknown[][] }).calls.filter(([name]) => name === "requestReuse").length, beforeRestore,
      "recovering this chat must not prepare a formal installation")
    assert(((await call("get")) as { repairs: string[] }).repairs.at(-1)?.includes("无需正式安装或跨聊天复用"))
    await page.getByRole("button", { name: "普通模式", exact: true }).click()
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    await call("deferSetup")
    const beforeStaleSetup = ((await call("get")) as { calls: unknown[] }).calls.length
    await page.getByRole("button", { name: "创造者模式", exact: true }).click()
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { get(): { setupReady: boolean } } }).fixture.get().setupReady
    )
    await call("mount", "chat", "other", "other-space")
    await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).waitFor()
    await call("finishSetup")
    await page.waitForFunction(() =>
      (window as unknown as { fixture: { get(): { listeners: number } } }).fixture.get().listeners === 1
    )
    assert.equal(((await call("get")) as { calls: unknown[] }).calls.length, beforeStaleSetup,
      "switching chats while setup is pending must not write settings or activate creator mode")
    assert(await page.getByRole("button", { name: "普通模式", exact: true, pressed: true }).isVisible())
    await call("mount", "chat", "other", null)
    await page.getByRole("button", { name: "选择目录并进入创造者模式", exact: true }).click()
    const selected = ((await call("get")) as { calls: [string, unknown][] }).calls.filter(([name]) => name === "selectWorkspace")
    assert.deepEqual(selected, [["selectWorkspace", { threadId: "other" }]])
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "chat status failure is retryable from compact control",
            "ordinary chat has one click ordinary and creator mode switch",
            "normal mode preserves active Mods and unsent drafts",
            "repair enters creator mode before one asynchronous callback and preserves the unsent draft",
            "model rejection keeps the repair card open without approval; explicit retry closes and focuses only on success",
            "new failure and unknown state open once; repeated status notices respect dismissal and never submit repair",
            "same-chat sources remain saved and recovery avoids formal installation",
            "one confirmation reuses exact source, compiled artifact and target profile",
            "queued and unconfirmed undo states are visible without automatic retry",
            "manual project trials and old reuse steps remain available under advanced controls",
            "pending approval opens without another menu click",
            "composition reports queued and active states and opens failure details",
            "saved composition with an unconfirmed runtime switch asks for verification without retrying",
            "one click creator mode opens required switches and restores composer focus",
            "approval details open automatically and badge remains visible",
            "human capability labels visible and technical digests collapsed",
            "opening or auto-opening a permission summary never approves",
            "chat promote opens workbench without installation",
            "explicit enable returns same chat",
            "host canonical scope",
            "one explicit click approves only the displayed revision and both digests",
            "source changes require a fresh click and busy state prevents duplicate approval",
            "duplicate prevention",
            "queued is not active",
            "queued UI busy retains old active version",
            "promotion not installation",
            "failure retains reported active version and private error hidden",
            "disabled Mods gives explicit settings guidance",
            "active chat compact with expandable review",
            "unrelated events ignored",
            "foreign workspace and late response fenced"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS development browser: compact creation and scoped controls; ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
