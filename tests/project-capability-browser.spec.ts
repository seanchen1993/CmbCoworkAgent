import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

async function main(): Promise<void> {
  const output = resolve("output/project-capability-20261011", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/harness-board/ProjectCapabilityPanel.tsx")
  const cssEntry = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: dirname(cssEntry),
    from: cssEntry,
    onDependency: () => undefined
  })
  const scanner = new Scanner({})
  const candidates = scanner.scanFiles([
    { content: readFileSync(entry, "utf8"), extension: "tsx" },
    { content: "bg-background text-foreground p-4 max-w-5xl mx-auto", extension: "html" }
  ])
  for (const utility of ["bg-primary", "px-3", "py-2", "rounded-xl", "sm:grid-cols-2"]) {
    assert.ok(candidates.includes(utility), `Component utility was not scanned: ${utility}`)
  }
  const css = compiler.build(candidates)
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React from "react";import{createRoot}from"react-dom/client";
import{ProjectCapabilityPanel}from${JSON.stringify(entry)};
import{prepareProjectCapabilitySession}from"./src/renderer/src/components/harness-board/project-capability-session";
import{getHarnessRunNextAction}from"./src/renderer/src/lib/harness-run-next-action";
import{getPendingHarnessNextAction}from"./src/renderer/src/lib/harness-next-action";
const root=createRoot(document.getElementById("root"));
let version=0,calls=[],shown,latest,selected,activity,notifications,disabled,hold,release,fail=false,failGrant=false,failCreate=false,releaseAtCommit=false;
const make=()=>({project:{projectId:'project'},projectCapability:{status:'ready',manifest:{apiVersion:'devclaw.project/v1',name:'项目能力工作台',description:'连接阶段指导、真实产物与原项目会话。',help:[{title:'如何使用',body:'先阅读检查规则，再准备下一步会话。<img src=x onerror=alert(1)>'}],stages:[{nodeId:'plan',guidance:'形成可评审计划，确认输入和验收条件。',before:['需求范围已明确'],after:['原验证器检查通过']}] }},workflow:{display:{mode:'ordered_nodes'},nodes:[{id:'plan',label:'计划',states:[{nodeStatus:'in_progress',nextAction:{slashSkill:'project-plan',userMessage:'继续制定计划'}}]},{id:'code',label:'开发',states:[{nodeStatus:'in_progress',nextAction:{slashSkill:'project-code',userMessage:'按已批准计划实施'}}]}]},run:{slug:'feature',currentNodeId:'plan',resolvedSessionWorkspacePath:'C:/old-workspace',nodes:[{id:'plan',label:'计划',nodeStatus:'in_progress',status:{label:'进行中',uiKind:'active'},artifacts:[{id:'plan-file',artifactLabel:'计划文件',artifactType:'file',path:'plan.md',required:true,artifactStatus:'generated',status:{label:'已生成',uiKind:'ok'},validation:{status:'invalid',message:'验收已过期，请重新检查'}}],hooks:[{ts:'2026-10-09 10:00',eventId:'check',eventStatus:'success',message:'旧版计划检查成功'}]},{id:'code',label:'开发',nodeStatus:'not_started',status:{label:'尚未开始',uiKind:'unknown'},artifacts:[],hooks:[]}]},sessions:[]});
window.api={harnessBoard:{ensureFeatureThreadImGrant:async input=>{calls.push(['grant',input]);if(failGrant)throw Error('grant unavailable');return{required:false,granted:false}}}};
function CommitRelease({feature}){React.useLayoutEffect(()=>{if(feature==='another'&&releaseAtCommit){releaseAtCommit=false;hold=null;calls.push(['release-at-commit']);release()}},[feature]);return null}
const mount=()=>root.render(<main data-feature={shown.run.slug} data-fixture-version={version} className="max-w-5xl mx-auto p-4"><ProjectCapabilityPanel key={version} detail={shown} selectedNodeId={selected} disabledReason={disabled}
loadLatest={async()=>{calls.push(['load']);const reply=structuredClone(latest);if(hold==='load')await new Promise(r=>{release=r;calls.push(['held','load'])});if(fail)throw Error('通知读取失败');return{detail:reply,notifications:structuredClone(notifications)}}}
readActivity={()=>activity}
createSession={async value=>{if(hold==='create')await new Promise(r=>{release=r;calls.push(['held','create'])});return prepareProjectCapabilitySession({projectId:value.project.projectId,slug:value.run.slug,workspacePath:value.run.resolvedSessionWorkspacePath,nextAction:getHarnessRunNextAction(value),createThread:async(config,options)=>{calls.push(['create',config,options]);if(failCreate)throw Error('创建失败');return{thread_id:'thread-'+version}}},message=>calls.push(['warning',message]))}}
onOpenSession={id=>calls.push(['open',id])} onShowApproval={id=>calls.push(['approval',id])} onSelectCurrent={id=>{selected=id;mount()}}/><CommitRelease feature={shown.run.slug}/></main>);
const reset=()=>{version++;calls=[];shown=make();latest=make();selected='code';activity={known:true};notifications=[];disabled=undefined;hold=null;fail=false;failGrant=false;failCreate=false;releaseAtCommit=false;mount();return version};
window.fixture={reset,get:()=>({calls,pending:getPendingHarnessNextAction('thread-'+version)}),selectCurrent:()=>{selected='plan';mount()},
fresh:()=>{latest.run.currentNodeId='code';latest.run.nodes[1].nodeStatus='in_progress';latest.run.resolvedSessionWorkspacePath='C:/fresh-workspace'},
running:()=>{activity={known:true,runningThreadId:'ordinary-running'};mount()},
gate:()=>{activity={known:true,gatePending:true,gateThreadId:'approval-source'};mount()},
freshGate:()=>{notifications=[{notificationId:'gate',type:'human_gate',status:'pending',payload:{projectId:'project',featureId:'feature',sourceThreadId:'approval-source',humanGate:{hookId:'approve'}}}]},
unknown:()=>{activity={known:false};mount()},noAction:()=>{shown.workflow.nodes[0].states=[];mount()},
legacy:()=>{delete shown.projectCapability;mount()},invalid:()=>{shown.projectCapability={status:'invalid',message:'格式无效'};mount()},
completed:()=>{shown.run.featureStatus='done';mount()},fail:()=>fail=true,failGrant:()=>failGrant=true,failCreate:()=>failCreate=true,
holdLoad:()=>hold='load',holdCreate:()=>hold='create',release:()=>{hold=null;release()},releaseDuringNextCommit:()=>releaseAtCommit=true,
disable:()=>{disabled='项目暂不可用';mount()},enable:()=>{disabled=undefined;mount()},
switchFeature:()=>{version++;shown=make();shown.run.slug='another';latest=structuredClone(shown);mount()}};reset();
`
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    target: "chrome130",
    logLevel: "warning",
    alias: { "@": resolve("src/renderer/src") }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("http://localhost/project-capability-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<body class='bg-background text-foreground'><div id='root'></div></body>"
      })
    )
    await page.goto("http://localhost/project-capability-test")
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const call = (name: string) =>
      page.evaluate(
        (name) => (window as unknown as { fixture: Record<string, () => unknown> }).fixture[name](),
        name
      )
    const get = async () =>
      (await call("get")) as {
        calls: Array<[string, ...unknown[]]>
        pending?: { slashSkill?: string }
      }
    const prepare = () => page.getByRole("button", { name: "准备下一步会话", exact: true })
    const reset = async () => {
      const version = await call("reset")
      await page.locator(`[data-fixture-version="${version}"]`).waitFor()
      await prepare().waitFor()
    }
    const waitCall = (kind: string) =>
      page.waitForFunction(
        (kind) =>
          (window as unknown as { fixture: { get: () => { calls: unknown[][] } } }).fixture
            .get()
            .calls.some((item) => item[0] === kind),
        kind
      )

    await page.getByText("当前阶段：计划", { exact: true }).waitFor()
    await page.getByText("正在查看：开发", { exact: true }).waitFor()
    await page.getByRole("button", { name: "返回当前阶段" }).click()
    await page.getByText("验收已过期，请重新检查", { exact: false }).waitFor()
    assert.equal(await page.locator("details[open]").count(), 0)
    await page.getByText("阶段规则（声明说明）", { exact: true }).focus()
    await page.keyboard.press("Enter")
    await page.getByText("需求范围已明确", { exact: true }).waitFor()
    await page.getByText("使用帮助", { exact: true }).click()
    assert.equal(await page.locator("img").count(), 0)
    const buttonStyle = await prepare().evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        paddingX: parseFloat(style.paddingLeft),
        paddingY: parseFloat(style.paddingTop),
        border: parseFloat(style.borderTopWidth),
        background: style.backgroundColor,
        color: style.color
      }
    })
    assert.ok(
      buttonStyle.paddingX >= 8 && buttonStyle.paddingY >= 6,
      "Button padding utility missing"
    )
    assert.ok(buttonStyle.border >= 1, "Button border utility missing")
    assert.notEqual(buttonStyle.background, "rgba(0, 0, 0, 0)")
    assert.notEqual(buttonStyle.background, "transparent")
    assert.notEqual(buttonStyle.background, buttonStyle.color)
    const panelStyle = await page
      .locator('section[aria-label="项目能力控制台"]')
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          padding: parseFloat(style.paddingLeft),
          border: parseFloat(style.borderTopWidth),
          radius: parseFloat(style.borderTopLeftRadius)
        }
      })
    assert.ok(
      panelStyle.padding >= 12 && panelStyle.border >= 1 && panelStyle.radius > 0,
      "Panel card utilities missing"
    )
    const desktopGrids = await page
      .locator('section[aria-label="项目能力控制台"] .grid')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element)
          return {
            display: style.display,
            columns: style.gridTemplateColumns.trim().split(/\s+/).length
          }
        })
      )
    assert.ok(desktopGrids.length >= 2)
    assert.ok(
      desktopGrids.every((grid) => grid.display === "grid" && grid.columns === 2),
      "Desktop two-column utilities missing"
    )
    await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true })

    await call("fresh")
    await prepare().click()
    await waitCall("open")
    let result = await get()
    assert.equal(result.pending?.slashSkill, "project-code")
    const config = result.calls.find((item) => item[0] === "create")?.[1] as {
      workspacePath: string
    }
    assert.equal(config.workspacePath, "C:/fresh-workspace")
    assert.ok(result.calls.some((item) => item[0] === "grant"))

    await reset()
    await call("failGrant")
    await prepare().evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    await waitCall("open")
    result = await get()
    assert.equal(result.calls.filter((item) => item[0] === "create").length, 1)
    assert.equal(result.calls.filter((item) => item[0] === "grant").length, 1)
    assert.equal(result.calls.filter((item) => item[0] === "open").length, 1)
    assert.match(String(result.calls.find((item) => item[0] === "warning")?.[1]), /会话已创建，但/)
    assert.equal(result.pending?.slashSkill, "project-plan")
    const grantInput = result.calls.find((item) => item[0] === "grant")?.[1] as { threadId: string }
    assert.equal(result.calls.find((item) => item[0] === "open")?.[1], grantInput.threadId)

    await reset()
    await call("failCreate")
    await prepare().click()
    await page.getByRole("status").filter({ hasText: "创建失败" }).waitFor()
    result = await get()
    assert.equal(result.calls.filter((item) => item[0] === "grant").length, 0)
    assert.equal(result.calls.filter((item) => item[0] === "open").length, 0)
    assert.equal(result.calls.filter((item) => item[0] === "warning").length, 0)

    await reset()
    await call("running")
    await page.getByRole("button", { name: "查看运行中的会话" }).click()
    await waitCall("open")
    assert.equal((await get()).calls.filter((item) => item[0] === "create").length, 0)

    for (const newState of ["running", "gate", "freshGate"]) {
      await reset()
      await call("holdLoad")
      await prepare().click()
      await call(newState)
      await call("release")
      await waitCall(newState === "running" ? "open" : "approval")
      assert.equal((await get()).calls.filter((item) => item[0] === "create").length, 0)
    }

    await reset()
    await call("holdLoad")
    await prepare().evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
    assert.equal((await get()).calls.filter((item) => item[0] === "load").length, 1)
    await call("release")
    await waitCall("create")
    assert.equal((await get()).calls.filter((item) => item[0] === "create").length, 1)

    await reset()
    await call("holdLoad")
    await prepare().click()
    await call("disable")
    await page.getByText("项目暂不可用", { exact: true }).waitFor()
    await call("release")
    await page.getByRole("button", { name: "准备下一步会话" }).waitFor()
    await call("enable")
    await prepare().click()
    await waitCall("create")
    assert.equal((await get()).calls.filter((item) => item[0] === "create").length, 1)

    for (const hold of ["holdLoad", "holdCreate"]) {
      await reset()
      await call(hold)
      await prepare().click()
      await waitCall("held")
      await call("switchFeature")
      // root.render schedules work; release only after the new Feature has actually committed.
      await page.locator('[data-feature="another"]').waitFor()
      await call("release")
      // Await two paints after resolving the old async continuation.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      result = await get()
      assert.equal(result.calls.filter((item) => item[0] === "open").length, 0)
      if (hold === "holdLoad")
        assert.equal(result.calls.filter((item) => item[0] === "create").length, 0)
    }

    // Resolve from a real layout effect in the new Feature's commit, without waiting for
    // passive cleanup or delaying the old receipt. Both refresh and creation receipts are guarded.
    for (const hold of ["holdLoad", "holdCreate"]) {
      await reset()
      await call(hold)
      await prepare().click()
      await waitCall("held")
      await call("releaseDuringNextCommit")
      await call("switchFeature")
      await waitCall("release-at-commit")
      await page.locator('[data-feature="another"]').waitFor()
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
      result = await get()
      assert.equal(result.calls.filter((item) => item[0] === "open").length, 0)
      if (hold === "holdLoad") {
        assert.equal(result.calls.filter((item) => item[0] === "create").length, 0)
      } else {
        assert.equal(result.calls.filter((item) => item[0] === "create").length, 1)
      }
    }

    await reset()
    await call("fail")
    await prepare().click()
    await page.getByRole("status").filter({ hasText: "通知读取失败" }).waitFor()
    assert.equal((await get()).calls.filter((item) => item[0] === "create").length, 0)
    for (const state of ["unknown", "noAction", "completed"]) {
      await reset()
      await call(state)
      assert.equal(await prepare().isDisabled(), true)
    }
    await reset()
    await call("invalid")
    await page.getByText("项目能力说明暂不可用", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button").count(), 0)
    await reset()
    await call("legacy")
    assert.equal(await page.getByRole("region").count(), 0)

    await reset()
    await call("selectCurrent")
    await page.setViewportSize({ width: 375, height: 900 })
    await page.getByText("使用帮助", { exact: true }).click()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    const narrowGrid = await page
      .locator('section[aria-label="项目能力控制台"] .grid')
      .last()
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          display: style.display,
          columns: style.gridTemplateColumns.trim().split(/\s+/).length
        }
      })
    assert.deepEqual(narrowGrid, { display: "grid", columns: 1 })
    await page.screenshot({ path: resolve(output, "narrow.png"), fullPage: true })
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          errors,
          buttonStyle,
          panelStyle,
          desktopGrids,
          narrowGrid,
          screenshots: ["desktop.png", "narrow.png"]
        },
        null,
        2
      )
    )
    console.log(`Project capability browser tests passed: ${output}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
