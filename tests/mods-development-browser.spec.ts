import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

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
    const root=createRoot(document.getElementById("root"));let key=0,listeners=new Set(),calls=[],returned=0,promoted=[],workbench=0,reads=0,defer=false,finish,readDefer=false,finishRead,failRead=false;
    let current={threadId:"thread",workspace:"c:/owned/workspace",enabled:false,drafts:[],trials:[]};
    const trial=phase=>({componentId:"counter",draftId:"draft",revision:2,bundleDigest:"b".repeat(64),compiledDigest:"c".repeat(64),phase,activeRevision:1,activeDigest:"a".repeat(64),capabilities:["event:tool.call","ui.resolve"]});
    const api={status:async({threadId})=>{reads++;if(failRead){failRead=false;throw Error("PRIVATE_ERROR")};const data=structuredClone(threadId==="other"?{...current,threadId:"other",workspace:"other-space",enabled:false,drafts:[],trials:[]}:current);if(readDefer&&threadId==="thread")return new Promise(r=>finishRead=()=>r(data));return data},
      setEnabled:async input=>{calls.push(["enable",input]);current={...current,enabled:input.enabled};return structuredClone(current)},
      approve:async input=>{calls.push(["approve",input]);const done=()=>{current={...current,trials:[trial("queued")]};return structuredClone(current)};return defer?await new Promise(r=>finish=()=>r(done())):done()},
      stop:async input=>{calls.push(["stop",input]);current={...current,trials:[trial("stopped")]};return structuredClone(current)},
      promote:async input=>{calls.push(["promote",input]);return {workspace:current.workspace,id:"saved",revision:1,name:"Saved",source:{digest:"b".repeat(64),files:[]}}},
      onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}};
    let globalEnabled=false,workspaceEnabled=false;
    const settings={globalEnabled:async()=>globalEnabled,status:async()=>({workspace:current.workspace,enabled:workspaceEnabled,outputPolicy:true,mods:[],diagnostics:[]}),configureGlobal:async value=>{calls.push(["global",value]);globalEnabled=value;return value},configure:async(thread,enabled,policy,workspace)=>{calls.push(["workspace",{thread,enabled,policy,workspace}]);workspaceEnabled=enabled}};
    window.electron={process:{platform:"win32"}};
    window.api={mods:{development:api,...settings}};
    const mount=(mode="entry",threadId="thread",workspaceHint="C:/Owned/Workspace",blocked=false)=>root.render(<ModsDevelopmentPanel key={++key} api={api} threadId={threadId} workspaceHint={workspaceHint} mode={mode} promotionBlocked={blocked} onOpenWorkbench={()=>workbench++} onReturnToChat={()=>{returned++;document.getElementById("composer").focus()}} onPromoted={value=>promoted.push(value)}/>);
    const emit=(threadId="thread")=>listeners.forEach(fn=>fn({threadId}));
    window.fixture={failRead:()=>failRead=true,calls,mount,emit,get:()=>({calls,returned,promoted,workbench,reads,listeners:listeners.size,readReady:!!finishRead}),needs:()=>{current={...current,enabled:true,drafts:[{id:"draft",name:"Counter",revision:2,digest:"b".repeat(64)}],trials:[trial("needs-approval")]};emit()},defer:()=>defer=true,finish:()=>finish(),queuedBusy:()=>{current.trials=[{...trial("queued"),error:"MODS_DEVELOPMENT_BUSY"}];emit()},failed:()=>{current.trials=[{...trial("failed"),error:"SECRET_PRIVATE_PATH"}];emit()},active:()=>{current.trials=[{...trial("active"),activeRevision:2}];emit()},disabled:()=>{current.trials=[{...trial("failed"),error:"DEVELOPMENT_MODS_DISABLED"}];emit()},foreign:()=>{current.workspace="foreign";emit()},readDefer:()=>readDefer=true,finishRead:()=>finishRead()};mount("chat");
  `
    },
    bundle: true,
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
        body: `<html><meta charset="utf-8"><style>body{font:14px system-ui;background:#faf9f6;padding:24px}section,article{border:1px solid #bbb;border-radius:12px;padding:16px;margin:12px 0}button{font:inherit;padding:8px;margin:6px}p,label,details{margin:12px 0;display:block}.break-all{word-break:break-all}button:disabled{opacity:.5}</style><textarea id="composer" aria-label="原聊天输入框"></textarea><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://fixture.test")
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
    await call("failRead")
    await call("mount", "chat")
    await page.getByText("需核对", { exact: true }).waitFor()
    await page.getByRole("button", { name: "制作灵件", exact: true }).click()
    await page.getByRole("button", { name: "刷新状态", exact: true }).click()
    await page.getByText("需核对", { exact: true }).waitFor({ state: "hidden" })
    await page.keyboard.press("Escape")
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    await page.getByRole("button", { name: "制作灵件", exact: true }).click()
    await page
      .getByText(
        "会开启应用和当前项目的灵件功能，并在当前聊天制作；已有授权的灵件可能恢复运行。新功能试用前会请你确认。",
        { exact: true }
      )
      .waitFor()
    await page.getByRole("button", { name: "开启灵件并开始制作" }).click()
    await page.waitForFunction(() => document.activeElement?.id === "composer")
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    assert.equal(((await call("get")) as { returned: number }).returned, 1)
    const enable = (
      (await call("get")) as { calls: [string, { expectedWorkspace: string }][] }
    ).calls.find((item) => item[0] === "enable")!
    assert.equal(enable[1].expectedWorkspace, "c:/owned/workspace")
    await call("needs")
    await page.getByRole("button", { name: /灵件试用中，1 项待确认/ }).waitFor()
    assert.equal(await page.getByRole("checkbox").count(), 0)
    await page.getByRole("button", { name: /灵件试用中，1 项待确认/ }).click()
    await page.getByText("处理工具调用事件", { exact: true }).waitFor()
    assert.equal(await page.getByText(/源码摘要/).isVisible(), false)
    const approve = page.getByRole("button", { name: "确认并试用" })
    await approve.waitFor()
    assert(await approve.isDisabled())
    await page.getByRole("checkbox").check()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /灵件试用中，1 项待确认/ }).click()
    assert(await page.getByRole("checkbox").isChecked())
    await call("defer")
    await approve.click()
    assert(await approve.isDisabled())
    await call("finish")
    await page.getByText(/已排队，等待本轮结束/).waitFor()
    assert.equal(await page.getByText(/本会话已生效/).count(), 0)
    assert.equal(
      ((await call("get")) as { calls: [string, unknown][] }).calls.filter(
        (c) => c[0] === "approve"
      ).length,
      1
    )
    await page.getByRole("button", { name: "保存复用并打开源码" }).click()
    assert.equal(((await call("get")) as { promoted: unknown[] }).promoted.length, 1)
    await call("failed")
    await page.getByText(/新版本试用失败/).waitFor()
    assert(await page.getByText(/正在使用：v1/).isVisible())
    assert.equal(await page.getByText("SECRET_PRIVATE_PATH", { exact: false }).count(), 0)
    await page.screenshot({ path: join(output, "development-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 540, height: 920 })
    await page.screenshot({ path: join(output, "development-narrow.png"), fullPage: true })
    await call("disabled")
    await page
      .getByText("灵件功能尚未开启。点击下方开启按钮即可完成应用、项目和本会话设置。")
      .waitFor()
    await call("queuedBusy")
    await page.getByText("等待当前界面操作结束；已生效的旧版仍保留。").waitFor()
    await page.getByText(/正在使用：v1/).waitFor()
    await call("active")
    await call("mount", "chat")
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
    await page.getByText(/本会话已生效/).waitFor()
    assert.equal(await page.getByText(/直接描述想做的组件/).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "结束创作并停止本会话试用" }).isVisible(),
      true
    )
    assert.equal(await page.getByText(/源码摘要/).isVisible(), false)
    await page.getByText("核对版本与能力", { exact: true }).click()
    assert.equal(await page.getByText(/源码摘要/).isVisible(), false)
    await page.getByText("技术详情", { exact: true }).click()
    assert(await page.getByText(/源码摘要/).isVisible())
    await page.getByText("核对版本与能力", { exact: true }).click()
    await page.getByRole("button", { name: "保存并复用…", exact: true }).click()
    assert.equal(((await call("get")) as { workbench: number }).workbench, 1)
    assert.equal(await page.getByLabel("Mods 对话创作").count(), 0)
    await page.screenshot({ path: join(output, "development-compact-chat.png"), fullPage: true })
    await page.getByRole("button", { name: "灵件试用中", exact: true }).click()
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
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          checks: [
            "chat status failure is retryable from compact control",
            "ordinary chat has discoverable creation control without a card",
            "explicit setup opens required switches and restores composer focus",
            "approval badge is visible while details are closed",
            "human capability labels visible and technical digests collapsed",
            "closing popover preserves exact approval consent",
            "chat promote opens workbench without installation",
            "explicit enable returns same chat",
            "host canonical scope",
            "approval consent and exact version",
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
