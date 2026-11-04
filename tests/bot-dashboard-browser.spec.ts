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
const data={source:'mock',hasData:true,activeBots:128,activeOwners:76,createdBots:23,started:2468,completed:2320,failed:48,cancelled:28,superseded:72,successRate:2320/2368,avgDurationMs:42000,worksCreated:186,worksCompleted:142,worksReopened:32,connected:18,revoked:3,
channels:[{key:'app_private',count:1420},{key:'app_group',count:368},{key:'zhaohu_private',count:428},{key:'zhaohu_group',count:252}],
runKinds:[{key:'chat',count:1832},{key:'work',count:386},{key:'schedule',count:120},{key:'collaboration',count:72},{key:'notification',count:58}]};
const state=window.fixture={calls:[],cancelled:[],mode:'ok',pending:[],data};
window.api={dashboard:{botOverview:async(range,granularity,opts)=>{state.calls.push({range,granularity,opts});if(state.mode==='hold')return new Promise(resolve=>state.pending.push(resolve));if(state.mode==='error')return {success:false,error:'统计服务暂时不可用'};return {success:true,data:{...data,hasData:state.mode!=='empty'}}},cancelRequests:async(families)=>state.cancelled.push(families)}};
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
    const assets = resolve("out/renderer/assets")
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
    await panel.getByText("示例数据", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), 1)
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
    await page.getByRole("heading", { name: "平台运营概览", exact: true }).click()
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
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
    assert.deepEqual(errors, [])
    console.log(
      `Bot dashboard UI passed: refresh, filters, cancellation, stale responses, failure/empty states, light/dark/compact. Screenshots: ${artifacts}`
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
