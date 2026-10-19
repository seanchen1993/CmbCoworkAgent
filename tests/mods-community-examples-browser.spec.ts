import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { PLATFORM_EXAMPLES } from "../src/main/mods/community-examples"

interface CommunityExamplesFixtureWindow extends Window {
  fixture: {
    reset(): void
    hold(): void
    active(value: boolean): void
    release(): void
    deferList(): void
    listPending(): boolean
    releaseList(): void
    get(): { calls: unknown[][] }
  }
}

async function main() {
  const output = resolve("output/plugin-journey-20261013", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const entry = resolve("src/renderer/src/components/customize/OfficialSparksExamples.tsx")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React from "react";import{createRoot}from"react-dom/client";
import{OfficialSparksExamples}from${JSON.stringify(entry)};
import{parseClawProfile}from"./src/shared/mods/claw";
const root=createRoot(document.getElementById("root"));let active=true,key=0,calls=[],claw,status,globalOn,failGrant=false,hold=false,release,holdList=false,releaseList,thread="thread",workspace="c:/owned";
const cap=name=>({pluginId:name+"-uuid",name,digest:"a".repeat(64)});
const examples=[...${JSON.stringify(PLATFORM_EXAMPLES)},...([['token-weather','用量天气'],['replay-theater','修改回放'],['blast-radius','危险命令确认']].map(([id,title])=>({id,title,pluginName:id,description:title+'的中文说明',usage:'在当前聊天中使用'+title,commit:'a'.repeat(40),upstreamUrl:'https://example.invalid/'+id,...(id==='blast-radius'?{}:{conflictNote:'天气与回放占用同一区域，请分开应用。'})})))];
const mount=(replace=true)=>root.render(<div data-active={active}><OfficialSparksExamples active={active} key={replace?++key:key} threadId={thread} workspaceHint={workspace} onReturnToChat={()=>calls.push(['return'])}/></div>);
const reset=(mode='normal')=>{active=true;holdList=mode==='held-list';releaseList=undefined;calls=[];failGrant=false;hold=false;thread='thread';workspace='c:/owned';globalOn=mode!=='disabled';
status={workspace,enabled:globalOn,outputPolicy:true,mods:[],diagnostics:[],functionMods:[{...cap('other'),state:'ready',capabilities:[]},{...cap('token-weather'),state:'ready',capabilities:['ui.resolve']}]};
claw={workspace,enabled:globalOn,applicable:true,revision:1,bindingRevision:1,profiles:[],active:mode==='disabled'?null:{id:'old',name:'原组合',capabilities:[cap('other'),cap('token-weather')],builtins:{contextMeter:true},skills:{mode:'selected',items:[]},mcp:{mode:'all',items:[]},models:{default:'chosen',roles:{Explore:'fast'}},completionRules:[]},issues:[]};mount()};
const mods={communityExamples:{list:async()=>{if(holdList){holdList=false;await new Promise(r=>releaseList=r)}return{examples:examples.map(e=>({...e,installation:status.functionMods.some(x=>x.name===e.id)?{state:'installed',pluginId:e.id+'-uuid'}:{state:'missing'}}))}},install:async({exampleId})=>{calls.push(['install',exampleId]);if(hold)await new Promise(r=>release=r);if(!status.functionMods.some(x=>x.name===exampleId))status.functionMods.push({...cap(exampleId),state:'needs-approval',capabilities:['ui.resolve','file.read']});return{pluginId:exampleId+'-uuid',pluginName:exampleId,alreadyInstalled:false,requiresApproval:true}}},
status:async()=>structuredClone(status),globalEnabled:async()=>globalOn,
clawView:async()=>structuredClone({...claw,capabilities:status.functionMods}),
clawChange:async(t,m)=>{calls.push(['claw',t,m]);if(m.revision!==claw.revision)throw Error('STALE');if(m.kind==='save'){claw.profiles.push(parseClawProfile(m.profile));claw.revision++}else{if(m.bindingRevision!==claw.bindingRevision)throw Error('STALE');claw.active=structuredClone(claw.profiles.find(x=>x.id===m.id));claw.revision++;claw.bindingRevision=claw.revision}return mods.clawView()},
approveFunction:async(t,id,digest,ws)=>{calls.push(['grant',t,id,digest,ws]);if(failGrant)throw Error('受控授权失败');status.functionMods.find(x=>x.pluginId===id).state='ready'},
configureGlobal:async value=>{calls.push(['global',value]);globalOn=value;return value},
configure:async(t,value,policy,ws)=>{calls.push(['configure',t,value,policy,ws]);status.enabled=value;claw.enabled=value}};
window.api={mods};window.electron={openExternal:async url=>{window.openedSource=url}};
window.fixture={remount:()=>mount(),reset,deferList:()=>reset('held-list'),listPending:()=>typeof releaseList==='function',releaseList:()=>releaseList(),disabled:()=>reset('disabled'),noScope:()=>{reset();thread=null;workspace=null;mount()},get:()=>structuredClone({calls,claw,status,globalOn}),failGrant:()=>failGrant=true,hold:()=>hold=true,switchScope:()=>{thread='other-thread';workspace='c:/other';mount()},release:()=>release(),changeRevision:()=>claw.bindingRevision++,active:value=>{active=value;mount(false)}};reset();
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("http://localhost/examples-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<div id='root'></div>"
      })
    )
    await page.goto("http://localhost/examples-test")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const call = (name: string) =>
      page.evaluate(
        (name) => (window as unknown as { fixture: Record<string, () => unknown> }).fixture[name](),
        name
      )
    const get = async () =>
      (await call("get")) as {
        calls: unknown[][]
        claw: {
          active: {
            name: string
            capabilities: { name: string }[]
            models: unknown
            skills: unknown
            builtins: unknown
          }
          profiles: unknown[]
        }
      }
    const card = (title: string) => page.getByRole("article", { name: title, exact: true })
    const click = (name: string) => page.getByRole("button", { name, exact: true }).click()
    const start = async (title = "修改回放") => {
      await card(title)
        .getByRole("button", { name: /添加并使用|用于当前聊天|核对冲突后使用/ })
        .click()
      await page.getByRole("dialog").waitFor()
    }
    const confirm = async () => {
      await page.getByRole("checkbox").check()
      await click("确认并使用")
    }
    await page.getByRole("heading", { name: "挑一个小帮手" }).waitFor()
    assert.equal(await page.getByRole("article").count(), 8)
    assert.deepEqual((await get()).calls, [])
    await card("用量天气").locator("summary").click()
    await card("用量天气").getByRole("button", { name: "查看官方源码", exact: true }).click()
    assert.equal(
      await page.evaluate(() => (window as unknown as { openedSource: string }).openedSource),
      "https://example.invalid/token-weather"
    )
    assert.deepEqual((await get()).calls, [])
    await start()
    assert(await page.getByRole("button", { name: "确认并使用" }).isDisabled())
    assert(
      await page
        .getByRole("dialog")
        .getByText(/换成「修改回放」/)
        .isVisible()
    )
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )
    await click("暂不使用")
    assert.deepEqual(
      (await get()).claw.active.capabilities.map((row) => row.name),
      ["other", "token-weather"]
    )
    await start()
    await confirm()
    await page.getByRole("button", { name: "返回聊天使用修改回放" }).waitFor()
    let state = await get()
    assert.deepEqual(
      state.claw.active.capabilities.map((row) => row.name),
      ["other", "replay-theater"]
    )
    assert.deepEqual(state.claw.active.models, { default: "chosen", roles: { Explore: "fast" } })
    assert.equal(state.claw.active.name, "官方示例 · 修改回放")
    assert.deepEqual(state.claw.active.skills, { mode: "selected", items: [] })
    assert.deepEqual(state.claw.active.builtins, { contextMeter: true })
    await call("remount")
    await card("修改回放").getByRole("button", { name: "正在使用" }).waitFor()
    await card("用量天气").getByRole("button", { name: "核对冲突后使用" }).waitFor()
    const writes = state.calls.filter((row) => row[0] !== "install").length
    await card("修改回放").getByRole("button", { name: "正在使用" }).click()
    await page.getByText(/已在当前聊天使用/).waitFor()
    assert.equal((await get()).calls.filter((row) => row[0] !== "install").length, writes)

    await call("reset")
    await card("任务能力提供方").locator("summary").click()
    assert(
      await card("任务能力提供方")
        .getByText(/来源：CMBDevClaw 本工程示例/)
        .isVisible()
    )
    assert.equal(
      await card("任务能力提供方")
        .getByText(/Anthropic/)
        .count(),
      0
    )
    assert.equal(
      await card("任务能力提供方").getByRole("button", { name: "查看官方源码" }).count(),
      0
    )
    await start("任务能力提供方")
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )
    await confirm()
    await card("任务能力提供方").getByRole("button", { name: "正在使用" }).waitFor()
    await start("个人任务工作台")
    assert.equal((await get()).calls.filter((row) => row[0] === "grant").length, 1)
    await confirm()
    await card("个人任务工作台").getByRole("button", { name: "正在使用" }).waitFor()
    state = await get()
    assert.deepEqual(
      state.claw.active.capabilities.map((row) => row.name),
      ["other", "token-weather", "task-workbench-provider", "task-workbench-consumer"]
    )
    assert.equal(state.calls.filter((row) => row[0] === "grant").length, 2)
    assert.deepEqual(state.claw.active.models, { default: "chosen", roles: { Explore: "fast" } })
    await card("前缀提醒").locator("summary").click()
    assert(
      await card("前缀提醒")
        .getByText(/每个处理点选择一个替代实现并确认应用/)
        .isVisible()
    )
    await card("编辑提醒").locator("summary").click()
    assert(
      await card("编辑提醒")
        .getByText(/默认文件 edit-reminder.txt 只创建一次/)
        .isVisible()
    )

    await call("disabled")
    await start("危险命令确认")
    assert(
      await page
        .getByRole("dialog")
        .getByText(/可能恢复其他已经授权的灵件/)
        .isVisible()
    )
    await confirm()
    await page.getByRole("button", { name: "返回聊天使用危险命令确认" }).waitFor()
    state = await get()
    assert.deepEqual(
      state.calls.map((row) => row[0]),
      ["install", "claw", "claw", "grant", "claw", "claw", "global", "configure"]
    )
    assert.equal(state.calls.at(-1)![3], true)
    assert.deepEqual(
      state.claw.active.capabilities.map((row) => row.name),
      ["other", "token-weather", "blast-radius"]
    )

    await call("reset")
    await call("failGrant")
    await start()
    await confirm()
    await page.getByRole("alert").getByText("受控授权失败", { exact: true }).waitFor()
    assert.equal((await get()).calls.filter((row) => row[0] === "claw").length, 0)
    assert.equal(await page.getByRole("dialog").count(), 0)

    await call("reset")
    await start()
    await call("changeRevision")
    await confirm()
    await page
      .getByRole("alert")
      .getByText(/安装版本、授权或助手组合已变化/)
      .waitFor()
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )

    await call("reset")
    await call("hold")
    await card("修改回放").getByRole("button", { name: "添加并使用" }).click()
    await call("switchScope")
    await call("release")
    await page.getByRole("heading", { name: "挑一个小帮手" }).waitFor()
    await page.waitForTimeout(100)
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )
    assert.equal(await page.getByRole("dialog").count(), 0)

    await call("noScope")
    await card("用量天气").getByRole("button", { name: "用于当前聊天" }).click()
    await page.getByText(/用量天气已安装。为聊天选择项目目录后/).waitFor()
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.reset())
    await page.getByRole("heading", { name: "挑一个小帮手" }).waitFor()
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.hold())
    await card("修改回放").getByRole("button", { name: "添加并使用" }).click()
    await page.waitForFunction(() =>
      (window as CommunityExamplesFixtureWindow).fixture
        .get()
        .calls.some((row) => row[0] === "install")
    )
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(false))
    await page.locator('[data-active="false"]').waitFor()
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(true))
    await page.locator('[data-active="true"]').waitFor()
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.release())
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.deepEqual(
      (await get()).calls.map((row) => row[0]),
      ["install"]
    )
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.reset())
    await page.getByRole("heading", { name: "挑一个小帮手" }).waitFor()
    await card("修改回放").getByRole("button", { name: "添加并使用" }).click()
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(false))
    await page.locator('[data-active="false"]').waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(true))
    await page.locator('[data-active="true"]').waitFor()
    assert.equal(await page.getByRole("dialog").count(), 0)
    for (const resolveWhileHidden of [true, false]) {
      await call("deferList")
      await page.waitForFunction(() =>
        (window as CommunityExamplesFixtureWindow).fixture.listPending()
      )
      await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(false))
      await page.locator('[data-active="false"]').waitFor()
      if (!resolveWhileHidden) {
        await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(true))
        await page.locator('[data-active="true"]').waitFor()
      }
      await call("releaseList")
      if (resolveWhileHidden) {
        await page.evaluate(() => (window as CommunityExamplesFixtureWindow).fixture.active(true))
        await page.locator('[data-active="true"]').waitFor()
      }
      await page.getByRole("article", { name: "用量天气", exact: true }).waitFor()
      assert.equal(await page.getByRole("article").count(), 8)
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.deepEqual((await get()).calls, [])
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "examples.png"), fullPage: true })
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "eight Chinese cards with honest upstream and local provenance; no initial writes",
            "provider and consumer need separate explicit consent and preserve current profile",
            "behavior preview and repeatable file demo guidance",
            "exact consent and conflict cancellation",
            "preserved profile; same-version no-op",
            "pin then grant then apply then enable",
            "grant failure retained installation",
            "changed binding rejects writes",
            "late installation after scope switch cannot authorize",
            "installation without project",
            "hidden and restored page rejects a pending approval receipt",
            "hiding an open approval closes it without restoring stale consent",
            "read-only catalog resolves while hidden without authorizing anything",
            "read-only catalog survives hide/show before the first response"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS official examples browser: 14 scenarios; ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
