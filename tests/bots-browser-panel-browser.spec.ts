/** Real preview component; only browser transport replies and visibility inputs are fixtures. */
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

declare global {
  interface Window {
    browserPanelFixture: {
      mode: "refused" | "timeout" | null
      previewFailure: boolean
      controlFailure: boolean
      holdNextTakeOver: boolean
      takeOverFailure: boolean
      releaseTakeOver: (() => void) | null
      giveBackCalls: number
      giveBackOutcomes: Array<{ botId: string; generation: number; outcome?: "skipped" }>
      helpInstruction?: string
      showHelp(value: boolean): void
      holdNextPreview: boolean
      releasePreview: (() => void) | null
      raceRelease: boolean
      staleAfterFailure: boolean
      previewCalls: string[]
      previewInFlight: number
      maxPreviewInFlight: number
      readonly observerCount: number
      readonly visibilityListenerCount: number
      control: "bot" | "human" | "other-human" | "requesting"
      generation: number
      captureFailure: boolean
      dialogPending: boolean
      selected: string | null
      takeOverCalls: Array<{ botId: string; pageId?: string }>
      operateFailure: string | null
      operationCalls: Array<{
        botId: string
        action: { action: string; pageId?: string }
        generation: number
      }>
      pages: Array<{
        id: string
        url: string
        title: string
        canGoBack?: boolean
        canGoForward?: boolean
      }>
      target(botId: string, alternateClient?: boolean): void
      prepareResources(): void
      unmount(): void
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
import React from 'react';import {createRoot} from 'react-dom/client';import {BotBrowserPanel} from './src/renderer/src/components/bots/BotBrowserPanel';import {BotBrowserHelpCard} from './src/renderer/src/components/bots/BotBrowserHelpCard';
const image=color=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="'+color+'"/></svg>');
const observers=new Set(),visibilityListeners=new Set();let hidden=false;
const addListener=document.addEventListener.bind(document),removeListener=document.removeEventListener.bind(document);
document.addEventListener=(type,listener,options)=>{if(type==='visibilitychange')visibilityListeners.add(listener);addListener(type,listener,options)};
document.removeEventListener=(type,listener,options)=>{if(type==='visibilitychange')visibilityListeners.delete(listener);removeListener(type,listener,options)};
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
window.IntersectionObserver=class {constructor(callback){this.callback=callback;observers.add(this)}observe(){this.callback([{isIntersecting:true}])}disconnect(){observers.delete(this)}};
const state=window.browserPanelFixture={pages:[{id:'a',url:'https://a.example.test/form',title:'表单 A',canGoBack:true,canGoForward:false},{id:'b',url:'https://b.example.test/preview',title:'预览 B',canGoBack:false,canGoForward:false}],images:{a:image('green'),b:image('blue')},selected:'a',control:'human',generation:1,captureFailure:false,dialogPending:false,operateFailure:null,operationCalls:[],takeOverCalls:[],newPages:0,previewCalls:[],navigationCalls:[],mode:null,previewFailure:false,controlFailure:false,holdNextTakeOver:false,takeOverFailure:false,releaseTakeOver:null,giveBackCalls:0,giveBackOutcomes:[],helpInstruction:undefined,holdNextPreview:false,releasePreview:null,raceRelease:false,staleAfterFailure:false,staleReply:null,
visible(value){for(const observer of observers)observer.callback([{isIntersecting:value}])},
hidden(value){hidden=value;document.dispatchEvent(new Event('visibilitychange'))}};
const client={hostId:'local',browserPreview:(botId,pageId)=>{state.previewCalls.push(pageId||state.selected||'none');if(state.previewFailure)return Promise.reject(new Error('预览暂时不可用'));if(state.staleReply){const reply=state.staleReply;state.staleReply=null;return Promise.resolve(reply)}const selected=state.pages.find(p=>p.id===(pageId||state.selected))?.id??null,reply={pages:state.pages.map(p=>({...p})),pageId:selected,image:state.captureFailure||state.dialogPending?null:state.images[selected],control:state.control,generation:state.generation,dialogPending:state.dialogPending,helpInstruction:state.helpInstruction,captureError:state.captureFailure?'暂时无法获取浏览器画面，请刷新重试':undefined};if(state.holdNextPreview){state.holdNextPreview=false;return new Promise(resolve=>state.releasePreview=()=>{state.releasePreview=null;resolve(reply)})}return Promise.resolve(reply)},
navigateBrowser:async(botId,pageId,url)=>{state.navigationCalls.push({pageId,url});const page=state.pages.find(p=>p.id===pageId);if(state.mode==='refused'){if(state.staleAfterFailure){state.staleAfterFailure=false;state.staleReply={pages:state.pages.map(p=>({...p})),pageId,image:state.images[pageId],control:'human',generation:1}}page.url='chrome-error://chromewebdata/';page.title='故障页 A';if(state.raceRelease){state.raceRelease=false;queueMicrotask(()=>state.releasePreview?.())}throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at '+url+'\\nCall log:\\n  - navigating to "'+url+'", waiting until "load"')}page.url=url;page.title=pageId==='a'?'表单 A 已恢复':'预览 B';if(state.mode==='timeout')throw new Error('page.goto: Timeout 15000ms exceeded.\\nCall log:\\n - navigating to "'+url+'"')},
giveBackBrowser:async(botId,generation,outcome)=>{state.giveBackCalls++;state.giveBackOutcomes.push({botId,generation,outcome});if(state.controlFailure)throw new Error('浏览器控制权已变化，请重新读取');state.control='bot';state.helpInstruction=undefined;state.generation++},takeOverBrowser:async(botId,pageId)=>{state.takeOverCalls.push({botId,pageId});if(state.holdNextTakeOver){state.holdNextTakeOver=false;await new Promise(resolve=>state.releaseTakeOver=()=>{state.releaseTakeOver=null;resolve()})}if(state.takeOverFailure)throw new Error('旧scope选页失败');if(state.control!=='human')state.generation++;state.control='human'},
operateBrowser:async(botId,action,generation)=>{state.operationCalls.push({botId,action:{...action},generation});if(state.operateFailure)throw new Error(state.operateFailure);if(state.control!=='human'||generation!==state.generation)throw new Error('浏览器控制权已变化，请刷新后重试');if(action.action==='new'){if(action.pageId)throw new Error('新建不能指定旧页面');const id='new-'+(++state.newPages);state.pages.push({id,url:'about:blank',title:'新标签页',canGoBack:false,canGoForward:false});state.images[id]=image('purple');return state.selected=id}const page=state.pages.find(p=>p.id===action.pageId);if(!page)throw new Error('页面已关闭');if(action.action==='close'){state.pages=state.pages.filter(p=>p.id!==page.id);delete state.images[page.id];state.selected=state.pages[0]?.id??null;if(!state.selected){state.control='bot';state.generation++}return state.selected}if(action.action==='back'){page.url='https://a.example.test/previous';page.canGoBack=false;page.canGoForward=true}if(action.action==='forward'){page.url='https://a.example.test/form';page.canGoBack=true;page.canGoForward=false}return page.id}};
state.previewInFlight=0;state.maxPreviewInFlight=0;Object.defineProperties(state,{observerCount:{get:()=>observers.size},visibilityListenerCount:{get:()=>visibilityListeners.size}});
const previewTransport=client.browserPreview;client.browserPreview=(...args)=>{state.previewInFlight++;state.maxPreviewInFlight=Math.max(state.maxPreviewInFlight,state.previewInFlight);return previewTransport(...args).finally(()=>state.previewInFlight--)};
const alternateClient={...client};const root=createRoot(document.getElementById('root'));const helpRoot=createRoot(document.getElementById('help'));state.showHelp=value=>helpRoot.render(value?<BotBrowserHelpCard client={client} scopeId='test-bot' instruction='同一请求首条说明'/>:null);
state.target=(botId,alternate=false)=>root.render(<BotBrowserPanel botId={botId} client={alternate?alternateClient:client}/>);
state.unmount=()=>root.render(null);
state.prepareResources=()=>{state.pages=[{id:'resource',url:'https://resource.example.test/',title:'资源回归页'}];state.images={resource:image('orange')};state.selected='resource';state.control='bot';state.helpInstruction=undefined;state.maxPreviewInFlight=0;state.target('resource-bot')};
state.target('test-bot');`
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"' }
    })
    const stylesheet = await compile(await readFile("src/renderer/src/index.css", "utf8"), {
      base: resolve("src/renderer/src"),
      onDependency: () => {}
    })
    const productionStyles =
      stylesheet.build(
        new Scanner({}).scanFiles(
          await Promise.all(
            [
              "src/renderer/src/components/bots/BotBrowserPanel.tsx",
              "src/renderer/src/components/bots/BotBrowserHelpCard.tsx",
              "src/renderer/src/components/ui/button.tsx",
              "src/renderer/src/components/ui/dialog.tsx",
              "src/renderer/src/components/ui/select.tsx"
            ].map(async (file) => ({ content: await readFile(file, "utf8"), extension: "tsx" }))
          )
        )
      ) + (await readFile("src/renderer/src/components/bots/bots.css", "utf8"))
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><style>' +
        productionStyles +
        '</style><div id="root" style="width:500px;--bot-line:#ddd;--bot-panel:#fff"></div><div id="help"></div><script>' +
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
    const assertPanelActionsLayout = async (width: number, help: boolean) => {
      await page.evaluate(
        ({ width, help }) => {
          document.getElementById("root")!.style.width = `${width}px`
          window.browserPanelFixture.helpInstruction = help ? "窄栏协助：请在当前页核对" : undefined
          window.browserPanelFixture.visible(true)
        },
        { width, help }
      )
      await page
        .getByRole("button", { name: help ? "归还并继续" : "归还 Bot", exact: true })
        .waitFor()
      const layout = await page
        .locator(".bot-browser-panel > .bot-browser-controls:not([role])")
        .evaluate((footer) => {
          const bounds = footer.getBoundingClientRect()
          return {
            width: bounds.width,
            scrollWidth: footer.scrollWidth,
            clientWidth: footer.clientWidth,
            items: [...footer.children].map((item) => {
              const rect = item.getBoundingClientRect()
              const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
              const textLines = new Set<number>()
              while (walker.nextNode()) {
                if (!walker.currentNode.textContent?.trim()) continue
                const range = document.createRange()
                range.selectNodeContents(walker.currentNode)
                for (const line of range.getClientRects()) textLines.add(Math.round(line.top))
              }
              return {
                label: item.textContent?.trim(),
                top: rect.top,
                height: rect.height,
                left: rect.left - bounds.left,
                right: rect.right - bounds.left,
                textLines: textLines.size
              }
            }),
            navigation: [
              ...document.querySelectorAll('.bot-browser-controls[role="toolbar"] button')
            ].map((button) => ({
              label: button.getAttribute("aria-label"),
              top: button.getBoundingClientRect().top
            }))
          }
        })
      console.log(`Panel actions ${width}px help=${help}: ` + JSON.stringify(layout))
      assert(layout.scrollWidth <= layout.clientWidth + 1, "footer must fit the panel width")
      for (const item of layout.items) {
        assert(
          item.left >= -1 && item.right <= layout.width + 1,
          `${item.label} stays inside footer`
        )
        assert.equal(
          item.textLines,
          1,
          `${width}px ${item.label} must remain one readable text line`
        )
        assert(
          item.height <= 44,
          `${width}px ${item.label} must not become a tall character column`
        )
      }
      const rows: Array<{ top: number; bottom: number }> = []
      for (const item of layout.items) {
        if (!rows.some((row) => item.top < row.bottom && item.top + item.height > row.top))
          rows.push({ top: item.top, bottom: item.top + item.height })
      }
      assert.equal(rows.length, width === 320 ? 2 : 1, "complete controls wrap only as needed")
      assert.equal(new Set(layout.navigation.map((button) => Math.round(button.top))).size, 1)
      assert.equal(layout.navigation.length, 5, "the original navigation toolbar stays on one row")
    }
    await assertPanelActionsLayout(320, true)
    await assertPanelActionsLayout(480, true)
    await assertPanelActionsLayout(320, false)
    await assertPanelActionsLayout(500, false)
    const openPreview = page.getByRole("button", { name: "查看表单 A的浏览器预览", exact: true })
    await page.evaluate(() => (window.browserPanelFixture.holdNextPreview = true))
    await openPreview.click()
    const viewer = page.getByRole("dialog", { name: "浏览器只读预览", exact: true })
    const assertViewerLayout = async () => {
      const measurements = []
      for (const height of [800, 600]) {
        await page.setViewportSize({ width: 1000, height })
        await viewer.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished.catch(() => {}))
          )
        })
        const geometry = await viewer.evaluate((element) => {
          element.scrollTop = 0
          const dialog = element.getBoundingClientRect()
          const frame = element
            .querySelector<HTMLElement>("[data-browser-viewer-frame]")!
            .getBoundingClientRect()
          const image = element.querySelector("img")?.getBoundingClientRect()
          return {
            viewport: innerHeight,
            dialog: { top: dialog.top, bottom: dialog.bottom },
            frame: { top: frame.top, bottom: frame.bottom, height: frame.height },
            image: image ? { top: image.top, bottom: image.bottom } : null,
            buttons: [...element.querySelectorAll("button")].map((button) => {
              const rect = button.getBoundingClientRect()
              return {
                label: button.textContent?.trim(),
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height
              }
            })
          }
        })
        assert.equal(geometry.viewport, height)
        assert(geometry.dialog.top >= 0 && geometry.dialog.bottom <= height + 1)
        assert(geometry.frame.height > 0, "image uses the remaining positive flex space")
        for (const button of geometry.buttons) {
          assert(
            button.height > 0 &&
              button.top >= geometry.dialog.top - 1 &&
              button.bottom <= geometry.dialog.bottom + 1,
            `${height}px viewer must keep ${button.label} inside its bounds`
          )
        }
        assert(
          geometry.image &&
            geometry.image.top >= geometry.frame.top - 1 &&
            geometry.image.bottom <= geometry.frame.bottom + 1,
          "image must fit its single flex wrapper"
        )
        measurements.push(geometry)
      }
      await page.setViewportSize({ width: 1000, height: 800 })
      console.log("Viewer computed layout: " + JSON.stringify(measurements))
    }
    await viewer.waitFor()
    await page.waitForFunction(() => Boolean(window.browserPanelFixture.releasePreview))
    const heldCalls = await page.evaluate(() => window.browserPanelFixture.previewCalls.length)
    await page.evaluate(() => {
      window.browserPanelFixture.visible(false)
      window.browserPanelFixture.visible(true)
    })
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.previewCalls.length),
      heldCalls,
      "modal and thumbnail share one capture loop"
    )
    assert.equal(await page.evaluate(() => window.browserPanelFixture.takeOverCalls.length), 0)
    await page.evaluate(() => window.browserPanelFixture.releasePreview?.())
    await page.keyboard.press("Escape")
    await viewer.waitFor({ state: "detached" })
    assert.equal(await openPreview.evaluate((button) => button === document.activeElement), true)
    assert.equal(await page.evaluate(() => window.browserPanelFixture.giveBackCalls), 0)
    await openPreview.press("Enter")
    await viewer.waitFor()
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.takeOverCalls.length),
      0,
      "keyboard view does not take control"
    )
    await page.evaluate(() => {
      window.browserPanelFixture.control = "bot"
      window.browserPanelFixture.generation = 0
      window.browserPanelFixture.visible(true)
    })
    await viewer.getByRole("button", { name: "接管浏览器并打开操作窗口", exact: true }).waitFor()
    await viewer.getByRole("combobox", { name: "查看的浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "预览 B", exact: true }).click()
    await viewer.getByRole("img", { name: "预览 B的实时预览", exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.takeOverCalls.length),
      0,
      "view-only page switching never acquires a lease"
    )
    await viewer.getByRole("combobox", { name: "查看的浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "表单 A", exact: true }).click()
    await viewer.getByRole("img", { name: "表单 A的实时预览", exact: true }).waitFor()
    await viewer.getByRole("button", { name: "接管浏览器并打开操作窗口", exact: true }).click()
    await viewer.waitFor({ state: "detached" })
    await page.waitForFunction(() => window.browserPanelFixture.takeOverCalls.length === 1)
    assert.deepEqual(await page.evaluate(() => window.browserPanelFixture.takeOverCalls), [
      { botId: "test-bot", pageId: "a" }
    ])
    const previewBounds = await preview.boundingBox()
    const buttonBounds = await openPreview.boundingBox()
    const imageBounds = await preview.locator("img").boundingBox()
    assert.ok(previewBounds && buttonBounds && imageBounds)
    assert.ok(Math.abs(previewBounds.width / previewBounds.height - 1.6) < 0.02)
    assert.deepEqual(imageBounds, buttonBounds)
    assert.ok(
      buttonBounds.width <= previewBounds.width && buttonBounds.height <= previewBounds.height
    )

    // A model navigation failure while the read-only viewer is already open is
    // a real page error, not an indefinitely pending frame.
    await openPreview.click()
    await viewer.waitFor()
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      const page = fixture.pages.find((page) => page.id === "a")!
      page.url = "chrome-error://chromewebdata/"
      page.title = "故障页 A"
      fixture.visible(true)
    })
    await viewer
      .getByRole("alert")
      .getByText("无法打开网页，请检查地址或稍后重试。", { exact: true })
      .waitFor()
    assert.equal(await viewer.locator("img").count(), 0)
    assert.equal(await viewer.getByText("正在获取画面…", { exact: true }).count(), 0)
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      const page = fixture.pages.find((page) => page.id === "a")!
      page.url = "https://a.example.test/form"
      page.title = "表单 A"
      fixture.visible(true)
    })
    await viewer.locator("img").waitFor()
    await page.keyboard.press("Escape")
    await viewer.waitFor({ state: "detached" })

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
    assert.deepEqual(
      await page.evaluate(() => window.browserPanelFixture.takeOverCalls.at(-1)),
      { botId: "test-bot", pageId: "b" },
      "human tab selection shows exact native target"
    )
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.generation),
      1,
      "switching pages reuses the active lease"
    )
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

    // A failed image must still apply the host's current control and generation.
    const refreshPreview = async () => {
      const count = await page.evaluate(() => window.browserPanelFixture.previewCalls.length)
      await page.evaluate(() => window.browserPanelFixture.visible(true))
      await page.waitForFunction(
        (count) => window.browserPanelFixture.previewCalls.length > count,
        count
      )
    }
    const action = (name: string) => page.getByRole("button", { name, exact: true })
    const frame = await preview.locator("img").getAttribute("src")
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.controlFailure = false
      fixture.mode = null
      fixture.captureFailure = true
      fixture.control = "bot"
      fixture.generation = 9
    })
    await refreshPreview()
    await action("接管浏览器").waitFor()
    assert.equal(await preview.locator("img").getAttribute("src"), frame)
    assert.match((await preview.locator("img").getAttribute("alt")) ?? "", /上次可用画面/)
    assert.ok((await page.locator(".bot-browser-location").innerText()).includes("上次可用画面"))
    for (const name of ["后退", "前进", "刷新网页", "新建网页", "关闭网页"])
      assert.equal(await action(name).isDisabled(), true)
    const viewOnlyCalls = await page.evaluate(() => window.browserPanelFixture.takeOverCalls.length)
    await preview.getByRole("button").click()
    await viewer.waitFor()
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.takeOverCalls.length),
      viewOnlyCalls
    )
    assert.match((await viewer.locator("img").getAttribute("alt")) ?? "", /上次可用画面/)
    await viewer.getByRole("button", { name: "接管浏览器并打开操作窗口", exact: true }).click()
    await viewer.waitFor({ state: "detached" })
    await action("归还 Bot").waitFor()
    assert.equal(await preview.locator("img").getAttribute("src"), frame)
    await action("刷新网页").click()
    await page.waitForFunction(() => window.browserPanelFixture.operationCalls.length === 1)
    assert.deepEqual(await page.evaluate(() => window.browserPanelFixture.operationCalls[0]), {
      botId: "test-bot",
      action: { action: "reload", pageId: "a" },
      generation: 10
    })
    await page.evaluate(() => (window.browserPanelFixture.captureFailure = false))
    await refreshPreview()
    await page.waitForFunction(() => !document.body.innerText.includes("暂时无法获取浏览器画面"))

    // Navigation uses the host's available history and the exact selected page.
    assert.equal(await action("前进").isDisabled(), true)
    await action("后退").click()
    await page.waitForFunction(() =>
      document.querySelector('input[aria-label="网页地址"]')?.value.endsWith("/previous")
    )
    assert.equal(await action("后退").isDisabled(), true)
    await action("前进").click()
    await page.waitForFunction(() =>
      document.querySelector('input[aria-label="网页地址"]')?.value.endsWith("/form")
    )
    await action("新建网页").click()
    await preview.locator('img[alt="新标签页的实时预览"]').waitFor()
    assert.deepEqual(
      await page.evaluate(() => window.browserPanelFixture.operationCalls.at(-1)?.action),
      { action: "new" }
    )
    await action("关闭网页").click()
    await preview.locator('img[alt="表单 A 已恢复的实时预览"]').waitFor()
    assert.deepEqual(
      await page.evaluate(() => window.browserPanelFixture.operationCalls.at(-1)?.action),
      { action: "close", pageId: "new-1" }
    )

    // Failed actions and stale leases do not mutate the target; a fresh retry works.
    await page.evaluate(() => (window.browserPanelFixture.operateFailure = "网页操作暂时不可用"))
    await action("刷新网页").click()
    await page.getByRole("alert").getByText("网页操作暂时不可用").waitFor()
    assert.equal(await preview.locator("img").count(), 1)
    await page.evaluate(() => {
      window.browserPanelFixture.operateFailure = null
      window.browserPanelFixture.generation = 11
    })
    await action("刷新网页").click()
    await page.getByRole("alert").getByText("浏览器控制权已变化，请刷新后重试").waitFor()
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.operationCalls.at(-1)?.generation),
      10
    )
    await action("刷新网页").click()
    await page.waitForFunction(
      () => window.browserPanelFixture.operationCalls.at(-1)?.generation === 11
    )

    // Capture failures cannot reuse another page, document, dialog or target's frame.
    await page.evaluate(() => (window.browserPanelFixture.captureFailure = true))
    await page.getByRole("combobox", { name: "浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "预览 B", exact: true }).click()
    await page.getByRole("alert").getByText("暂时无法获取浏览器画面，请刷新重试").waitFor()
    assert.equal(await preview.locator("img").count(), 0)
    await page.evaluate(() => (window.browserPanelFixture.captureFailure = false))
    await refreshPreview()
    await preview.locator('img[alt="预览 B的实时预览"]').waitFor()
    await preview.getByRole("button").click()
    await viewer.waitFor()
    await viewer.getByRole("button", { name: "打开可操作浏览器窗口", exact: true }).click()
    await viewer.waitFor({ state: "detached" })
    await page.waitForFunction(
      () => window.browserPanelFixture.takeOverCalls.at(-1)?.pageId === "b"
    )
    assert.deepEqual(await page.evaluate(() => window.browserPanelFixture.takeOverCalls.at(-1)), {
      botId: "test-bot",
      pageId: "b"
    })
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.pages.find((page) => page.id === "b")!.url = "https://b.example.test/changed"
      fixture.captureFailure = true
    })
    await refreshPreview()
    await page.waitForFunction(() => !document.querySelector(".bot-browser-preview img"))
    await page.evaluate(() => (window.browserPanelFixture.captureFailure = false))
    await refreshPreview()
    await preview.locator("img").waitFor()
    await page.evaluate(() => (window.browserPanelFixture.dialogPending = true))
    await refreshPreview()
    await preview.getByText("网页有待处理的弹窗", { exact: true }).waitFor()
    assert.equal(await preview.locator("img").count(), 0)
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.dialogPending = false
      fixture.captureFailure = false
    })
    await refreshPreview()
    await preview.locator("img").waitFor()
    await page.evaluate(() => {
      window.browserPanelFixture.captureFailure = true
      window.browserPanelFixture.target("other-bot")
    })
    await page.getByRole("alert").getByText("暂时无法获取浏览器画面，请刷新重试").waitFor()
    await page.waitForFunction(() => !document.querySelector(".bot-browser-preview img"))
    assert.equal(await preview.locator("img").count(), 0)
    await page.evaluate(() => (window.browserPanelFixture.captureFailure = false))
    await refreshPreview()
    await preview.locator("img").waitFor()
    await page.evaluate(() => {
      window.browserPanelFixture.captureFailure = true
      window.browserPanelFixture.target("other-bot", true)
    })
    await page.getByRole("alert").getByText("暂时无法获取浏览器画面，请刷新重试").waitFor()
    await page.waitForFunction(() => !document.querySelector(".bot-browser-preview img"))
    assert.equal(await preview.locator("img").count(), 0)
    await page.evaluate(() => {
      window.browserPanelFixture.captureFailure = false
      window.browserPanelFixture.target("test-bot")
    })
    await preview.locator("img").waitFor()
    await preview.getByRole("button").click()
    await viewer.waitFor()
    await page.evaluate(() => {
      window.browserPanelFixture.holdNextTakeOver = true
      window.browserPanelFixture.takeOverFailure = true
    })
    await viewer.getByRole("combobox", { name: "查看的浏览器页面", exact: true }).click()
    await page.getByRole("option", { name: "预览 B", exact: true }).click()
    await page.waitForFunction(() => Boolean(window.browserPanelFixture.releaseTakeOver))
    await page.evaluate(() => window.browserPanelFixture.target("other-bot", true))
    await viewer.waitFor({ state: "detached" })
    // Returning to the same Bot/client still creates a new UI scope lifetime.
    await page.evaluate(() => window.browserPanelFixture.target("test-bot"))
    await preview.locator("img").waitFor()
    await page.evaluate(() => window.browserPanelFixture.releaseTakeOver?.())
    await page.waitForTimeout(50)
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /旧scope选页失败/,
      "old async selection cannot update another Bot/client"
    )
    await page.evaluate(() => {
      window.browserPanelFixture.takeOverFailure = false
      window.browserPanelFixture.target("test-bot")
    })
    await preview.locator("img").waitFor()
    await preview.getByRole("button").click()
    await viewer.waitFor()
    await page.evaluate(() => window.browserPanelFixture.target("test-bot", true))
    await viewer.waitFor({ state: "detached" })
    await page.evaluate(() => window.browserPanelFixture.target("test-bot"))
    await preview.locator("img").waitFor()
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.helpInstruction = "请手工确认这一页"
      fixture.control = "human"
      fixture.generation = 20
      fixture.controlFailure = true
      fixture.visible(true)
    })
    await action("归还并继续").waitFor()
    await action("跳过此步").click()
    await page.getByRole("alert").getByText("浏览器控制权已变化，请重新读取").waitFor()
    assert.equal(await action("归还并继续").count(), 1, "failed help skip keeps the active lease")
    await page.evaluate(() => (window.browserPanelFixture.controlFailure = false))
    await preview.getByRole("button").click()
    await viewer.waitFor()
    await viewer.getByRole("status").getByText("请手工确认这一页", { exact: true }).waitFor()
    await viewer.getByRole("button", { name: "跳过此步", exact: true }).click()
    await viewer.waitFor({ state: "detached" })
    await action("接管浏览器").waitFor()
    assert.deepEqual(
      await page.evaluate(() => window.browserPanelFixture.giveBackOutcomes.at(-1)),
      { botId: "test-bot", generation: 20, outcome: "skipped" }
    )
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.helpInstruction = "同一请求首条说明"
      fixture.control = "human"
      fixture.generation = 21
      fixture.showHelp(true)
    })
    const helpCard = page.locator("#help")
    await helpCard.getByRole("button", { name: "跳过此步", exact: true }).click()
    await page.waitForFunction(
      () => window.browserPanelFixture.giveBackOutcomes.at(-1)?.generation === 21
    )
    assert.deepEqual(
      await page.evaluate(() => window.browserPanelFixture.giveBackOutcomes.at(-1)),
      { botId: "test-bot", generation: 21, outcome: "skipped" },
      "real help card sends distinct skip outcome on the exact lease"
    )
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.showHelp(false)
      fixture.control = "human"
      fixture.generation = 22
      fixture.helpInstruction = "第二次协助：核对当前页，不要提交"
      fixture.visible(true)
    })
    await action("归还并继续").waitFor()
    await preview.getByRole("button").click()
    await viewer.waitFor()
    await viewer
      .getByRole("status")
      .getByText("第二次协助：核对当前页，不要提交", { exact: true })
      .waitFor()
    assert.equal(
      await viewer.getByText("请手工确认这一页", { exact: true }).count(),
      0,
      "viewer uses the current host instruction"
    )
    await assertViewerLayout()
    await viewer.getByRole("button", { name: "归还并继续", exact: true }).click()
    await viewer.waitFor({ state: "detached" })
    await action("接管浏览器").waitFor()
    assert.deepEqual(
      await page.evaluate(() => {
        const call = window.browserPanelFixture.giveBackOutcomes.at(-1)
        return { botId: call?.botId, generation: call?.generation, outcome: call?.outcome ?? null }
      }),
      { botId: "test-bot", generation: 22, outcome: null },
      "viewer Done returns the exact current lease without a skipped outcome"
    )
    await page.evaluate(() => {
      const fixture = window.browserPanelFixture
      fixture.control = "human"
      fixture.generation = 23
      fixture.visible(true)
    })
    await action("归还 Bot").waitFor()
    await action("关闭网页").click()
    await preview.locator('img[alt="预览 B的实时预览"]').waitFor()
    await action("关闭网页").click()
    await preview
      .getByText("当前没有打开的网页。打开浏览器后可以继续浏览。", { exact: true })
      .waitFor()
    assert.equal(await preview.locator("img").count(), 0)
    assert.equal(await action("新建网页").isDisabled(), true)
    await action("打开浏览器").waitFor()

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

    // Reuse this component fixture for the new viewer's repeated mount lifetime.
    await page.waitForFunction(() => window.browserPanelFixture.previewInFlight === 0)
    await page.evaluate(() => window.browserPanelFixture.prepareResources())
    const resourcePreview = page.getByRole("button", {
      name: "查看资源回归页的浏览器预览",
      exact: true
    })
    const controlsBeforeCycles = await page.evaluate(() => ({
      takeOver: window.browserPanelFixture.takeOverCalls.length,
      giveBack: window.browserPanelFixture.giveBackCalls
    }))
    for (let round = 0; round < 50; round++) {
      if (round) await page.evaluate(() => window.browserPanelFixture.target("resource-bot"))
      await resourcePreview.waitFor()
      await page.waitForFunction(() => window.browserPanelFixture.previewInFlight === 0)
      assert.equal(await page.evaluate(() => window.browserPanelFixture.observerCount), 1)
      assert.equal(await page.evaluate(() => window.browserPanelFixture.visibilityListenerCount), 1)
      await resourcePreview.click()
      await viewer.waitFor()
      await page.keyboard.press("Escape")
      await viewer.waitFor({ state: "detached" })
      await page.waitForFunction(() => window.browserPanelFixture.previewInFlight === 0)
      await page.evaluate(() => window.browserPanelFixture.unmount())
      await page.waitForFunction(
        () =>
          !document.querySelector(".bot-browser-panel") &&
          window.browserPanelFixture.observerCount === 0 &&
          window.browserPanelFixture.visibilityListenerCount === 0
      )
    }
    assert.equal(await page.evaluate(() => window.browserPanelFixture.maxPreviewInFlight), 1)
    assert.deepEqual(
      await page.evaluate(() => ({
        takeOver: window.browserPanelFixture.takeOverCalls.length,
        giveBack: window.browserPanelFixture.giveBackCalls
      })),
      controlsBeforeCycles,
      "50 view-only cycles cannot acquire or return a browser lease"
    )

    // A capture already issued before unmount may finish once, without restarting the loop.
    await page.evaluate(() => {
      window.browserPanelFixture.holdNextPreview = true
      window.browserPanelFixture.target("resource-bot")
    })
    await page.waitForFunction(() => Boolean(window.browserPanelFixture.releasePreview))
    await page.evaluate(() => window.browserPanelFixture.unmount())
    await page.waitForFunction(() => window.browserPanelFixture.observerCount === 0)
    const lateCalls = await page.evaluate(() => window.browserPanelFixture.previewCalls.length)
    await page.evaluate(() => window.browserPanelFixture.releasePreview?.())
    await page.waitForFunction(() => window.browserPanelFixture.previewInFlight === 0)
    await page.waitForTimeout(2700)
    assert.equal(
      await page.evaluate(() => window.browserPanelFixture.previewCalls.length),
      lateCalls
    )
    assert.equal(await page.locator(".bot-browser-panel, [data-browser-viewer-frame]").count(), 0)
    assert.equal(await page.evaluate(() => window.browserPanelFixture.visibilityListenerCount), 0)
    console.log(
      "PASS resources: 50 real viewer/mount/unmount cycles; one capture in flight; observers/listeners released; late capture cannot restart after unmount"
    )
    assert.deepEqual(errors, [])
    console.log(
      "PASS: browser preview recovery, current control metadata, exact-page navigation/new/close, stale leases, frame isolation and hidden capture lifecycle"
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
