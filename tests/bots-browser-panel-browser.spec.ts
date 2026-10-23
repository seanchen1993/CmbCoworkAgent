/** Real preview component; only browser transport replies and visibility inputs are fixtures. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

declare global {
  interface Window {
    browserPanelFixture: {
      mode: "refused" | "timeout" | null
      previewFailure: boolean
      controlFailure: boolean
      holdNextPreview: boolean
      releasePreview: (() => void) | null
      raceRelease: boolean
      staleAfterFailure: boolean
      previewCalls: string[]
      visible(value: boolean): void
      hidden(value: boolean): void
    }
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-browser-panel-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      stdin: {
        resolveDir: resolve("."),
        loader: "tsx",
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {BotBrowserPanel} from './src/renderer/src/components/bots/BotBrowserPanel';
const image=color=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="'+color+'"/></svg>');
const observers=new Set();let hidden=false;
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
window.IntersectionObserver=class {constructor(callback){this.callback=callback;observers.add(this)}observe(){this.callback([{isIntersecting:true}])}disconnect(){observers.delete(this)}};
const state=window.browserPanelFixture={pages:[{id:'a',url:'https://a.example.test/form',title:'表单 A'},{id:'b',url:'https://b.example.test/preview',title:'预览 B'}],images:{a:image('green'),b:image('blue')},previewCalls:[],navigationCalls:[],mode:null,previewFailure:false,controlFailure:false,holdNextPreview:false,releasePreview:null,raceRelease:false,staleAfterFailure:false,staleReply:null,
visible(value){for(const observer of observers)observer.callback([{isIntersecting:value}])},
hidden(value){hidden=value;document.dispatchEvent(new Event('visibilitychange'))}};
const client={hostId:'local',browserPreview:(botId,pageId)=>{state.previewCalls.push(pageId||'a');if(state.previewFailure)return Promise.reject(new Error('预览暂时不可用'));if(state.staleReply){const reply=state.staleReply;state.staleReply=null;return Promise.resolve(reply)}const selected=pageId||'a',reply={pages:state.pages.map(p=>({...p})),pageId:selected,image:state.images[selected],control:'human',generation:1};if(state.holdNextPreview){state.holdNextPreview=false;return new Promise(resolve=>state.releasePreview=()=>{state.releasePreview=null;resolve(reply)})}return Promise.resolve(reply)},
navigateBrowser:async(botId,pageId,url)=>{state.navigationCalls.push({pageId,url});const page=state.pages.find(p=>p.id===pageId);if(state.mode==='refused'){if(state.staleAfterFailure){state.staleAfterFailure=false;state.staleReply={pages:state.pages.map(p=>({...p})),pageId,image:state.images[pageId],control:'human',generation:1}}page.url='chrome-error://chromewebdata/';page.title='故障页 A';if(state.raceRelease){state.raceRelease=false;queueMicrotask(()=>state.releasePreview?.())}throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at '+url+'\\nCall log:\\n  - navigating to "'+url+'", waiting until "load"')}page.url=url;page.title=pageId==='a'?'表单 A 已恢复':'预览 B';if(state.mode==='timeout')throw new Error('page.goto: Timeout 15000ms exceeded.\\nCall log:\\n - navigating to "'+url+'"')},
giveBackBrowser:async()=>{if(state.controlFailure)throw new Error('浏览器控制权已变化，请重新读取')},takeOverBrowser:async()=>{}};
createRoot(document.getElementById('root')).render(<BotBrowserPanel botId="test-bot" client={client}/>);`
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"' }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><div id="root"></div><script>' +
        bundle.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((request,done)=>done({cancel:!request.url.startsWith('file:')&&!request.url.startsWith('data:')}));new BrowserWindow({show:false,width:1000,height:800,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))})})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env,
      timeout: 15000
    })
    const page = await app.firstWindow({ timeout: 15000 }),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(10000)
    const preview = page.locator(".bot-browser-preview")
    const address = page.getByRole("textbox", { name: "网页地址", exact: true })
    await preview.locator("img").waitFor()
    assert.equal(await address.inputValue(), "https://a.example.test/form")

    // Chromium metadata may retain the former HTTP document for the first new
    // capture after a failed navigation, then report its internal error document.
    const transitionAddress = "http://127.0.0.1:49531/transition-unavailable"
    await page.evaluate(() => {
      window.browserPanelFixture.mode = "refused"
      window.browserPanelFixture.staleAfterFailure = true
    })
    await address.fill(transitionAddress)
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.getByText("无法打开网页", { exact: true }).waitFor()
    assert.equal(await address.inputValue(), transitionAddress)
    await page.getByRole("button", { name: "重试打开", exact: true }).waitFor()
    await page.evaluate(() => (window.browserPanelFixture.mode = null))
    await page.getByRole("button", { name: "重试打开", exact: true }).click()
    await preview.locator('img[alt="表单 A 已恢复的实时预览"]').waitFor()
    assert.equal(await address.inputValue(), transitionAddress)

    // A preview started before navigation may resolve after rejection but before
    // React disposes the old capture effect. It cannot erase the retry address.
    const racedAddress = "http://127.0.0.1:49531/raced-unavailable"
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.holdNextPreview = true
      fixture.raceRelease = true
      fixture.mode = "refused"
    })
    await page.waitForFunction(() => Boolean(window.browserPanelFixture.releasePreview))
    await address.fill(racedAddress)
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.getByText("无法打开网页", { exact: true }).waitFor()
    assert.equal(await address.inputValue(), racedAddress)
    assert.equal(await preview.locator("img").count(), 0)
    await page.evaluate(() => (window.browserPanelFixture.mode = null))
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.locator('img[alt="表单 A 已恢复的实时预览"]').waitFor()
    assert.equal(await address.inputValue(), racedAddress)

    // The failed URL, not Chromium's internal error document, remains editable.
    const refused = "http://127.0.0.1:49531/unavailable"
    await page.evaluate(() => (window.browserPanelFixture.mode = "refused"))
    await address.fill(refused)
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.getByText("无法打开网页", { exact: true }).waitFor()
    assert.equal(await preview.locator("img").count(), 0)
    assert.equal(await address.inputValue(), refused)
    assert.ok((await preview.innerText()).includes("无法连接"))
    assert.doesNotMatch(await page.locator("body").innerText(), /net::|Call log:|chrome-error:/)

    // A healthy different page must neither inherit nor clear page A's failure.
    await page.getByRole("combobox", { name: "浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "预览 B", exact: true }).click()
    await preview.locator('img[alt="预览 B的实时预览"]').waitFor()
    assert.equal(await preview.getByText("无法打开网页", { exact: true }).count(), 0)
    assert.equal(await address.inputValue(), "https://b.example.test/preview")
    await page.getByRole("combobox", { name: "浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "故障页 A", exact: true }).click()
    await preview.getByText("无法打开网页", { exact: true }).waitFor()
    assert.equal(await address.inputValue(), refused)

    // A real successful retry removes the failure without another page or request.
    await page.evaluate(() => (window.browserPanelFixture.mode = null))
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.locator('img[alt="表单 A 已恢复的实时预览"]').waitFor()
    assert.equal(await preview.getByText("无法打开网页", { exact: true }).count(), 0)
    assert.equal(await address.inputValue(), refused)

    // Slow navigation can leave a valid document. Do not hide its usable picture.
    await page.evaluate(() => (window.browserPanelFixture.mode = "timeout"))
    await address.fill("https://a.example.test/slow")
    await page.getByRole("button", { name: "打开网页", exact: true }).click()
    await preview.locator("img").waitFor()
    assert.equal(await preview.getByText("无法打开网页", { exact: true }).count(), 0)
    assert.equal(await address.inputValue(), "https://a.example.test/slow")
    assert.doesNotMatch(await page.locator("body").innerText(), /page\.goto:|Call log:/)

    // Control/permission failures retain the valid image and their actionable text.
    await page.evaluate(() => (window.browserPanelFixture.controlFailure = true))
    await page.getByRole("button", { name: "归还 Bot", exact: true }).click()
    await page.getByRole("alert").getByText("浏览器控制权已变化，请重新读取").waitFor()
    assert.equal(await preview.locator("img").count(), 1)

    // Preview capture errors retain the last usable frame; refreshing can recover.
    await page.evaluate(() => (window.browserPanelFixture.previewFailure = true))
    await page.getByRole("alert").getByText("预览暂时不可用", { exact: false }).waitFor()
    assert.equal(await preview.locator("img").count(), 1)
    await page.evaluate(() => (window.browserPanelFixture.previewFailure = false))
    await page.getByRole("button", { name: "刷新画面", exact: true }).click()
    await page.waitForFunction(() => !document.body.innerText.includes("预览暂时不可用"))

    // Exercise actual component lifecycle with visibility inputs; no profile or browser service.
    for (const kind of ["visible", "hidden"] as const) {
      await page.evaluate((kind) => window.browserPanelFixture[kind](kind === "hidden"), kind)
      const calls = await page.evaluate(() => window.browserPanelFixture.previewCalls.length)
      await page.waitForTimeout(2700)
      assert.equal(await page.evaluate(() => window.browserPanelFixture.previewCalls.length), calls)
      await page.evaluate((kind) => window.browserPanelFixture[kind](kind === "visible"), kind)
      await page.waitForFunction(
        (count) => window.browserPanelFixture.previewCalls.length > count,
        calls
      )
    }
    assert.deepEqual(errors, [])
    console.log(
      "PASS: browser preview refused/retry, failed URL, page isolation, valid timeout, control error, preview recovery and hidden capture lifecycle"
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
