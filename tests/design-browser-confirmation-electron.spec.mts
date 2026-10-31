/** Verify native WebContentsView bounds against the real browser confirmation bar and URL dialog. */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { _electron as electron, type ElectronApplication } from "playwright"

const root = process.cwd()
await fs.mkdir(path.join(root, "node_modules/.cache"), { recursive: true })
const directory = await fs.mkdtemp(path.join(root, "node_modules/.cache/design-confirmation-"))
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "design-confirmation-"))
let application: ElectronApplication | undefined
try {
  const cssBase = path.join(root, "src/renderer/src")
  const compiler = await compile(await fs.readFile(path.join(cssBase, "index.css"), "utf8"), {
    base: cssBase,
    onDependency: () => {},
    shouldRewriteUrls: true
  })
  const scanner = new Scanner({
    sources: [{ base: cssBase, pattern: "**/*.{tsx,ts}", negated: false }]
  })
  const css = compiler
    .build(scanner.scan())
    .replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (original, _quote, url) =>
      /^(?:data:|https?:|file:|#|\/)/i.test(url)
        ? original
        : `url("${pathToFileURL(path.resolve(cssBase, url)).href}")`
    )
  await fs.writeFile(path.join(directory, "style.css"), css)
  await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {BrowserPanel} from './src/renderer/src/components/browser/BrowserPanel';
        import {OverlayDrawer} from './src/renderer/src/components/panels/OverlayDrawer';
        import {useBrowserViewLifecycle} from './src/renderer/src/components/browser/useBrowserViewLifecycle';
        import {LinkModal} from './src/renderer/src/components/design/DesignModals';
        import {setBrowserPageConfirmation,clearBrowserPageConfirmation} from './src/renderer/src/lib/browser-page-confirmation';
        function Fixture(){
          const [modal,setModal]=useState(false);
          const [open,setOpen]=useState(true);
          const [url,setUrl]=useState('https://example.com/');
          useBrowserViewLifecycle({currentThreadId:null,harnessSessionThreadId:null,mainView:'design',
            rightPanelCollapsed:true,isAgentFocusActive:false,overlayModule:open?'browser':null,onRequestBrowserPanel:()=>{}});
          const close=()=>{clearBrowserPageConfirmation('layout');setOpen(false)};
          const showConfirmation=()=>setBrowserPageConfirmation({id:'layout',phase:'ready',
            message:'请确认下方页面，完成登录后再还原。',onConfirm:()=>{},onConfirmRestricted:()=>{},
            onCancel:close,onEditUrl:()=>setModal(true)});
          return <div style={{height:'100vh',position:'relative'}}><div style={{height:48}}>
            <button onClick={showConfirmation}>开始确认</button>
            <button onClick={()=>setOpen(true)}>打开浏览器</button></div>
            <OverlayDrawer open={open} title="内置浏览器" onClose={close}>
              <BrowserPanel workspacePath={${JSON.stringify(directory)}} initialUrl={${JSON.stringify(pathToFileURL(path.join(directory, "page.html")).href)}}/>
            </OverlayDrawer>
            <LinkModal open={modal} mode="import" url={url} onUrlChange={setUrl} onConfirm={()=>setModal(false)} onClose={()=>setModal(false)}/></div>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `
    },
    outfile: path.join(directory, "renderer.js"),
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    alias: { "@": cssBase },
    define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
    plugins: [
      {
        name: "fixture-store",
        setup(builder) {
          builder.onLoad({ filter: /\/lib\/store\.ts$/ }, () => ({
            loader: "js",
            contents: `const state={rightModule:'browser',showCustomizeView:false};export function useAppStore(select){return select?select(state):state};useAppStore.getState=()=>state;`
          }))
        }
      }
    ]
  })
  await fs.writeFile(
    path.join(directory, "index.html"),
    '<link rel="stylesheet" href="style.css"><div id="root"></div><script src="renderer.js"></script>'
  )
  await fs.writeFile(
    path.join(directory, "page.html"),
    '<body style="background:#e0f2fe"><h1>原生浏览器页面</h1></body>'
  )
  const preload = path.join(directory, "preload.cjs")
  await fs.writeFile(
    preload,
    `
    const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('electron',{process:{platform:process.platform}});
    contextBridge.exposeInMainWorld('api',{browser:{
      attach:options=>ipcRenderer.invoke('fixture:attach',options),
      navigate:(url,options)=>ipcRenderer.invoke('fixture:navigate',url,options),
      setBounds:(bounds,visible)=>ipcRenderer.invoke('fixture:bounds',bounds,visible),
      onState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('browser:state:app-browser',listener);return()=>ipcRenderer.removeListener('browser:state:app-browser',listener)},
      onPanelRequest:()=>()=>{},disposeAllForRendererUnload:()=>{},
      isProfileImportRuntimeEnabled:async()=>false,getCdpConfig:async()=>({enabled:false,profileImportEnabled:false})
    }});
  `
  )
  const main = path.join(directory, "main.cjs")
  await build({
    stdin: {
      resolveDir: root,
      contents: `
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {BrowserService} from './src/main/browser/core/browser-service';
      app.setPath('userData',process.env.DESIGN_CONFIRMATION_PROFILE);
      app.whenReady().then(()=>{
        const window=new BrowserWindow({width:1000,height:800,webPreferences:{preload:${JSON.stringify(preload)}}});
        const service=new BrowserService(()=>window);
        globalThis.layoutTest={window,service,visibilityHistory:[]};
        ipcMain.handle('fixture:attach',(_event,options)=>service.attach(options));
        ipcMain.handle('fixture:navigate',(_event,url,options)=>service.navigate(url,options));
        ipcMain.handle('fixture:bounds',(_event,bounds,visible)=>{
          const state=service.setBounds(bounds,visible);
          globalThis.layoutTest.visibilityHistory.push(state.visible);
          return state;
        });
        window.loadFile(${JSON.stringify(path.join(directory, "index.html"))});
      });
    `
    },
    outfile: main,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external"
  })
  const executablePath =
    process.platform === "darwin"
      ? path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
      : path.join(
          root,
          "node_modules/electron/dist",
          process.platform === "win32" ? "electron.exe" : "electron"
        )
  const environment = { ...process.env, DESIGN_CONFIRMATION_PROFILE: profile }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ executablePath, args: [main], env: environment })
  const page = await application.firstWindow()
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") console.log("RENDERER", message.text())
  })
  // The native view is a child of the shell's content view, separate from its DOM.
  const nativeState = () =>
    application!.evaluate(() => {
      const { window, service } = (globalThis as any).layoutTest
      const view = window.contentView.children[0]
      return {
        visible: service.getState().visible,
        bounds: view.getBounds(),
        url: service.getState().url,
        error: service.getState().error
      }
    })
  await page.waitForFunction(() => document.querySelector("input[placeholder]"))
  for (let attempt = 0; attempt < 100 && !(await nativeState()).visible; attempt++)
    await page.waitForTimeout(50)
  assert.equal(
    (await nativeState()).visible,
    true,
    JSON.stringify({
      native: await nativeState(),
      errors,
      body: (await page.locator("body").innerText()).slice(-1200)
    })
  )
  await page.getByRole("button", { name: "开始确认", exact: true }).click()
  const bar = page.getByRole("region", { name: "确认页面并还原" })
  const barBounds = (await bar.boundingBox())!
  let native = await nativeState()
  for (
    let attempt = 0;
    attempt < 100 && native.bounds.y < barBounds.y + barBounds.height - 1;
    attempt++
  ) {
    await page.waitForTimeout(50)
    native = await nativeState()
  }
  assert.ok(
    native.bounds.y >= barBounds.y + barBounds.height - 1,
    "native page starts below the confirmation controls"
  )
  assert.match(
    await application.evaluate(async () =>
      (globalThis as any).layoutTest.service
        .getWebContents()
        .executeJavaScript("document.body.innerText")
    ),
    /原生浏览器页面/
  )
  await page.getByRole("button", { name: "修改链接", exact: true }).click()
  await page.getByRole("dialog", { name: "通过链接还原页面" }).waitFor()
  for (let attempt = 0; attempt < 100 && (await nativeState()).visible; attempt++)
    await page.waitForTimeout(50)
  assert.equal(
    (await nativeState()).visible,
    false,
    "native view hides while the URL modal is open"
  )
  await page.getByRole("button", { name: "×", exact: true }).click()
  for (let attempt = 0; attempt < 100 && !(await nativeState()).visible; attempt++)
    await page.waitForTimeout(50)
  assert.equal(
    (await nativeState()).visible,
    true,
    "closing the modal restores the same browser page"
  )
  assert.equal((await nativeState()).url, native.url)
  await application.evaluate(() => {
    ;(globalThis as any).layoutTest.visibilityHistory = []
  })
  await page.getByRole("button", { name: "关闭面板", exact: true }).click()
  await page
    .getByRole("dialog", { name: "内置浏览器", exact: true, includeHidden: true })
    .waitFor({ state: "detached" })
  await page.waitForTimeout(350)
  assert.equal(
    (await nativeState()).visible,
    false,
    "closing the drawer must leave no native page visible after its exit animation"
  )
  await page.evaluate(() => window.dispatchEvent(new Event("resize")))
  await page.waitForTimeout(1200)
  assert.equal(
    (await nativeState()).visible,
    false,
    "late bounds updates cannot restore a closed browser"
  )
  const visibilityHistory = await application.evaluate(
    () => (globalThis as any).layoutTest.visibilityHistory as boolean[]
  )
  const hiddenIndex = visibilityHistory.indexOf(false)
  assert.ok(hiddenIndex >= 0, "closing must hide the native view")
  assert.ok(
    visibilityHistory.slice(hiddenIndex).every((visible) => !visible),
    "the native view stays hidden throughout the exit animation and unmount"
  )
  await page.getByRole("button", { name: "打开浏览器", exact: true }).click()
  for (let attempt = 0; attempt < 100 && !(await nativeState()).visible; attempt++)
    await page.waitForTimeout(50)
  assert.equal((await nativeState()).visible, true, "reopening restores the retained browser page")
  assert.equal((await nativeState()).url, native.url)
  await page.getByRole("button", { name: "开始确认", exact: true }).click()
  await page
    .getByRole("region", { name: "确认页面并还原" })
    .getByRole("button", { name: "取消", exact: true })
    .click()
  await page
    .getByRole("dialog", { name: "内置浏览器", exact: true, includeHidden: true })
    .waitFor({ state: "detached" })
  assert.equal(
    (await nativeState()).visible,
    false,
    "cancelling page confirmation also hides the native page"
  )
  assert.deepEqual(errors, [])
  console.log(
    "PASS real Electron confirmation layout, modal restoration, drawer close and cancellation without native view resurrection"
  )
} finally {
  await application?.close()
  await fs.rm(directory, { recursive: true, force: true })
  await fs.rm(profile, { recursive: true, force: true })
}
