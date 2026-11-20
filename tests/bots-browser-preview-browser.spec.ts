/** Real renderer with a controlled preview transport; no user profile or external network. */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-preview-ui-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        loader: "tsx",
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {BotBrowserPanel} from './src/renderer/src/components/bots/BotBrowserPanel';
const f=window.fixture={mode:'failed',calls:[],late:[],takeovers:[]};
const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="green"/></svg>');
const state=(id='first',ok=true)=>({pages:[{id:'first',title:'第一页',url:'https://first.test'},{id:'second',title:'第二页',url:'https://second.test'}],pageId:id,generation:1,control:'bot',image:ok?image:null,...(!ok?{captureError:'获取浏览器画面超时，请刷新或接管后重试'}:{})});
const client={browserPreview:async(bot,id)=>{f.calls.push({bot,id});if(f.mode==='hang')return new Promise(resolve=>f.late.push(()=>resolve(state('first',true))));return state(id,f.mode==='ok')},takeOverBrowser:async(bot,id)=>f.takeovers.push({bot,id})};
createRoot(document.getElementById('root')).render(<BotBrowserPanel botId="a" client={client}/>);`
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8"><div id="root"></div><script>' +
        bundle.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((request,done)=>done({cancel:!request.url.startsWith('file:')&&!request.url.startsWith('data:')}));new BrowserWindow({show:false,width:750,height:900,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))})})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env,
      timeout: 15000
    })
    const page = await app.firstWindow({ timeout: 15000 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(10000)
    await page.clock.install()
    await page.getByText("画面暂不可用", { exact: true }).waitFor()
    await page.getByRole("alert").getByText("获取浏览器画面超时", { exact: false }).waitFor()
    assert.equal(await page.getByText("正在获取画面…", { exact: true }).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "接管浏览器", exact: true }).isEnabled(),
      true
    )

    await page.evaluate("window.fixture.mode='ok'")
    await page.getByRole("button", { name: "刷新画面", exact: true }).click()
    await page.getByRole("img", { name: "第一页的实时预览" }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    await page.evaluate("window.fixture.mode='hang'")
    await page.getByRole("combobox", { name: "浏览器页面" }).click()
    await page.getByRole("option", { name: "第二页" }).click()
    await page.waitForFunction("window.fixture.late.length === 1")
    await page.clock.fastForward(25_001)
    await page.getByRole("alert").getByText("获取浏览器画面超时", { exact: false }).waitFor()
    await page.evaluate("window.fixture.mode='ok'")
    await page.getByRole("button", { name: "刷新画面", exact: true }).click()
    await page.getByRole("img", { name: "第二页的实时预览" }).waitFor()
    assert.equal(await page.evaluate("window.fixture.calls.at(-1).id"), "second")
    await page.evaluate("window.fixture.late.forEach(resolve => resolve())")
    await page.getByRole("button", { name: "接管浏览器", exact: true }).click()
    await page.waitForFunction("window.fixture.takeovers.length === 1")
    assert.equal(await page.evaluate("window.fixture.takeovers[0].id"), "second")
    assert.equal(await page.getByRole("img", { name: "第二页的实时预览" }).count(), 1)
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: preview failures/timeouts are visible, retry keeps the selected page, stale responses cannot replace it, and takeover stays available"
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
