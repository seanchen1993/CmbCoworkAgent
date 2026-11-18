import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-dashboard-"))
  const artifacts = resolve(process.env.BOT_DASHBOARD_ARTIFACT_DIR || "out/bot-dashboard-review")
  await mkdir(artifacts, { recursive: true })
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        loader: "tsx",
        contents: `
import React, {useState} from 'react';import {createRoot} from 'react-dom/client';
import {BotOverviewPanel} from './src/renderer/src/components/dashboard/panels/BotOverviewPanel';
import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
window.setTheme=applyThemePreference;applyThemePreference('cmbdevclaw-white');
const data={source:'mock',hasData:true,activeBots:128,activeOwners:8,createdBots:23,started:2468,completed:2320,failed:48,cancelled:28,superseded:72,successRate:2320/2368,avgDurationMs:42000,worksCreated:186,worksCompleted:142,worksReopened:32,connected:18,revoked:3,attachmentsSent:84,
channels:[{key:'app_private',count:1420},{key:'app_group',count:368},{key:'zhaohu_private',count:428},{key:'zhaohu_group',count:252}],
runKinds:[{key:'chat',count:1832},{key:'work',count:386},{key:'schedule',count:120},{key:'collaboration',count:72},{key:'notification',count:58}]};
const users=Array.from({length:8},(_,i)=>({sapId:'demo-0'+(i+1),userName:i===1?undefined:'示例用户 0'+(i+1),organization:['平台研发室','产品工程部','质量保障组'][i%3],activeBots:i===1?0:3+i,zhaohuGroupBindings:i===0?2:i===1?1:0,assignedWorks:i===0?7:0,chatRuns:i===7?117:320-25*i,lastActiveAt:i===1?undefined:'2026-11-01T09:30:00+08:00'}));
const state=window.fixture={calls:[],cancelled:[],mode:'ok',pending:[],activeUserCalls:[],activeUsersPending:[],activeUserMode:'ok',data};
window.api={dashboard:{botOverview:async(range,granularity,opts)=>{state.calls.push({range,granularity,opts});if(state.mode==='hold')return new Promise(resolve=>state.pending.push(resolve));if(state.mode==='error')return {success:false,error:'统计服务暂时不可用'};return {success:true,data:{...data,hasData:state.mode!=='empty'}}},
botActiveUsers:async(range,granularity,opts,cursor)=>{state.activeUserCalls.push({range,granularity,opts,cursor});if(state.activeUserMode==='hold')return new Promise(resolve=>state.activeUsersPending.push(resolve));if(state.activeUserMode==='error')return {success:false,error:'查询失败'};return {success:true,data:cursor?{items:users.slice(4),nextCursor:null}:{items:users.slice(0,4),nextCursor:'first-page'}}},
cancelRequests:async(families)=>state.cancelled.push(families)}};
function Demo(){const [settings,setSettings]=useState({range:{from:'2026-10-26T00:00:00+08:00',to:'2026-11-01T23:59:59+08:00'},granularity:'week',organizations:['示例组织'],refreshKey:0});window.updateSettings=patch=>setSettings(old=>({...old,...patch}));return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mb-5 flex items-center justify-between"><h1 className="text-lg font-semibold">平台运营概览</h1><span className="text-xs text-muted-foreground">示例数据 · 最近 7 天</span></div><BotOverviewPanel {...settings}/></main>};createRoot(document.getElementById('root')).render(<Demo/>);`
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") }
    })
    const assets = resolve(process.env.BOT_TEST_APP_OUT || "out", "renderer/assets")
    const css = (await readdir(assets)).filter(
      (name) => name.startsWith("index-") && name.endsWith(".css")
    )
    assert(css.length, "Build the App before running the UI test")
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8">' +
        css
          .map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(assets, name))}">`)
          .join("") +
        '<div id="root"></div><script>' +
        bundle.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((req,done)=>done({cancel:!req.url.startsWith('file:')&&!req.url.startsWith('data:')}));new BrowserWindow({show:false,width:1240,height:850,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))})})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(10000)
    const panel = page.getByRole("region", { name: "Bot 运营概览" })
    const ready = () =>
      page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Bot 运营概览"]')?.getAttribute("aria-busy") ===
          "false"
      )
    await page.getByText("2,468", { exact: true }).waitFor()
    await ready()
    await panel.getByText("已发送 84 份", { exact: true }).waitFor()
    await panel.getByText("示例数据", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.activeUserCalls.length), 0)
    await page.screenshot({
      path: join(artifacts, "bot-overview-light.png"),
      animations: "disabled"
    })
    await panel.getByRole("button", { name: "查看说明" }).first().hover()
    await page
      .getByRole("tooltip")
      .getByText("统计当前时间范围及可见组织内的新埋点。旧版本数据不回填。")
      .waitFor()
    await page.mouse.move(0, 0)
    await page.keyboard.press("Escape")
    await panel
      .getByText("已发送 84 份", { exact: true })
      .locator("..")
      .getByRole("button", { name: "查看说明" })
      .hover()
    await page
      .getByRole("tooltip")
      .getByText(/本期收到招乎发送成功回执的文件和图片/)
      .waitFor()
    await page.mouse.move(0, 0)
    await page.keyboard.press("Escape")
    await page.getByRole("heading", { name: "平台运营概览", exact: true }).click()
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
    const activeUsers = panel.getByRole("button", { name: "查看活跃用户名单（8）", exact: true })
    const userMenu = page.getByRole("dialog", { name: "活跃用户", exact: true })
    await activeUsers.click()
    assert.equal(await userMenu.getAttribute("data-cmb-modal-dialog"), "true")
    const table = userMenu.getByRole("table", { name: "活跃用户名单" })
    for (const label of ["用户", "部门", "活跃 Bot 数", "绑定招乎群聊数", "交办任务数", "对话处理", "最近活跃"]) {
      await table.getByRole("columnheader", { name: label, exact: true }).waitFor()
    }
    assert.equal(await table.getByRole("columnheader", { name: "处理轮次", exact: true }).count(), 0)
    assert.equal(
      await table.getByRole("columnheader", { name: "交办任务数", exact: true }).getAttribute("title"),
      "本期新建的独立任务数，包含关联已有会话"
    )
    assert.equal(
      await table.locator("thead").evaluate((el) => getComputedStyle(el).position),
      "sticky"
    )
    const firstUser = table.getByRole("row", { name: /示例用户 01/ })
    await firstUser.getByText("demo-01", { exact: true }).waitFor()
    await firstUser.getByRole("cell", { name: "平台研发室", exact: true }).waitFor()
    await firstUser.getByRole("cell", { name: "3", exact: true }).waitFor()
    await firstUser.getByRole("cell", { name: "2", exact: true }).waitFor()
    await firstUser.getByRole("cell", { name: "7", exact: true }).waitFor()
    await firstUser.getByRole("cell", { name: "320", exact: true }).waitFor()
    await firstUser.locator('time[datetime="2026-11-01T09:30:00+08:00"]').waitFor()
    assert.equal(
      await table.getByRole("row", { name: /demo-02/ }).getByRole("cell", { name: "0", exact: true }).count(),
      2
    )
    await userMenu.getByRole("button", { name: "加载更多", exact: true }).click()
    await userMenu.getByText("demo-08", { exact: true }).waitFor()
    assert.equal(await table.locator("tbody tr").count(), 8)
    assert.equal(await userMenu.getByRole("button", { name: "加载更多", exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.activeUserCalls), [
      {
        range: { from: "2026-10-26T00:00:00+08:00", to: "2026-11-01T23:59:59+08:00" },
        granularity: "week",
        opts: { upperOrgLv1: ["示例组织"] },
        cursor: undefined
      },
      {
        range: { from: "2026-10-26T00:00:00+08:00", to: "2026-11-01T23:59:59+08:00" },
        granularity: "week",
        opts: { upperOrgLv1: ["示例组织"] },
        cursor: "first-page"
      }
    ])
    await page.screenshot({ path: join(artifacts, "bot-active-users.png"), animations: "disabled" })
    await userMenu.getByRole("button", { name: "Close", exact: true }).click()
    await userMenu.waitFor({ state: "hidden" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "查看活跃用户名单（8）"
    )
    await activeUsers.click()
    await userMenu.getByText("demo-02", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.activeUserCalls.length), 2)
    await page.keyboard.press("Escape")
    await userMenu.waitFor({ state: "hidden" })
    await page.evaluate(() => (window as any).setTheme("codex-dark"))
    await page.screenshot({
      path: join(artifacts, "bot-overview-dark.png"),
      animations: "disabled"
    })
    await page.setViewportSize({ width: 640, height: 1050 })
    await page.screenshot({
      path: join(artifacts, "bot-overview-compact.png"),
      animations: "disabled"
    })
    assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth), false)
    await page.setViewportSize({ width: 420, height: 680 })
    await activeUsers.click()
    await table.getByRole("columnheader", { name: "部门", exact: true }).waitFor({ state: "hidden" })
    await table.getByRole("columnheader", { name: "活跃 Bot 数", exact: true }).waitFor()
    await table.getByRole("columnheader", { name: "绑定招乎群聊数", exact: true }).waitFor()
    await table.getByRole("columnheader", { name: "交办任务数", exact: true }).waitFor()
    await table.getByRole("columnheader", { name: "对话处理", exact: true }).waitFor()
    await firstUser.getByText("平台研发室", { exact: true }).filter({ visible: true }).waitFor()
    assert.equal(await userMenu.evaluate((el) => el.scrollWidth > el.clientWidth), false)
    await page.screenshot({ path: join(artifacts, "bot-active-users-compact.png"), animations: "disabled" })
    await page.keyboard.press("Escape")
    await userMenu.waitFor({ state: "hidden" })
    await page.setViewportSize({ width: 640, height: 1050 })

    // Rerendering with the same filter values must not refetch.
    await page.evaluate(() => (window as any).updateSettings({ organizations: ["示例组织"] }))
    await page.getByRole("button", { name: "刷新 Bot 统计" }).click()
    await ready()
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 2)
    await page.evaluate(() => {
      ;(window as any).fixture.mode = "error"
      ;(window as any).updateSettings({ refreshKey: 1 })
    })
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByText("2,468", { exact: true }).count(), 0)
    await page.screenshot({
      path: join(artifacts, "bot-overview-error.png"),
      animations: "disabled"
    })
    await page.evaluate(() => {
      ;(window as any).fixture.mode = "empty"
    })
    await page.getByRole("button", { name: "刷新 Bot 统计" }).click()
    await page.getByText("当前范围暂无 Bot 统计。升级后的使用记录上报后将在这里展示。").waitFor()

    // An earlier slow response must never overwrite the newly selected range.
    await page.evaluate(() => {
      ;(window as any).fixture.mode = "hold"
      ;(window as any).updateSettings({ refreshKey: 2 })
    })
    await page.waitForFunction(() => (window as any).fixture.pending.length === 1)
    await page.evaluate(() =>
      (window as any).updateSettings({
        range: { from: "2026-11-02T00:00:00+08:00", to: "2026-11-02T23:59:59+08:00" },
        granularity: "day"
      })
    )
    await page.waitForFunction(() => (window as any).fixture.pending.length === 2)
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.pending[1]({ success: true, data: { ...s.data, started: 777 } })
    })
    await page.getByText("777", { exact: true }).waitFor()
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.pending[0]({ success: true, data: { ...s.data, started: 999 } })
    })
    await ready()
    assert.equal(await page.getByText("999", { exact: true }).count(), 0)
    assert.equal(await page.getByText("777", { exact: true }).count(), 1)

    // Scope changes close the menu and discard a request for the old scope.
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.mode = "ok"
      s.activeUserMode = "hold"
    })
    await activeUsers.click()
    await userMenu.getByRole("status").getByText("正在读取活跃用户…").waitFor()
    await page.evaluate(() => (window as any).updateSettings({ organizations: ["另一组织"] }))
    await userMenu.waitFor({ state: "hidden" })
    await ready()
    assert.equal(
      await page.evaluate(() =>
        (window as any).fixture.cancelled.some((families: string[]) =>
          families.includes("dashboard:botActiveUsers")
        )
      ),
      true
    )
    await page.evaluate(() => {
      const s = (window as any).fixture
      s.activeUsersPending[0]({
        success: true,
        data: { items: [{ sapId: "old-scope", activeBots: 1, zhaohuGroupBindings: 0, assignedWorks: 2, chatRuns: 12 }], nextCursor: null }
      })
      s.activeUserMode = "error"
    })
    await activeUsers.click()
    await userMenu.getByRole("alert").getByText("暂时无法读取用户列表").waitFor()
    await page.evaluate(() => { (window as any).fixture.activeUserMode = "ok" })
    await userMenu.getByRole("button", { name: "重试", exact: true }).click()
    await userMenu.getByText("示例用户 01", { exact: true }).waitFor()
    assert.equal(await userMenu.getByText("old-scope", { exact: true }).count(), 0)
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.activeUserCalls.at(-1).opts),
      { upperOrgLv1: ["另一组织"] }
    )
    assert.deepEqual(errors, [])
    console.log(
      `Bot dashboard UI passed: active users, pagination, refresh, filters, cancellation, stale responses, failure/empty states, light/dark/compact. Screenshots: ${artifacts}`
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
