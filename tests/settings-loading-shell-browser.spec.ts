/** Delayed real settings page; the eager fallback keeps return navigation usable. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/settings-loading-shell-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const app = readFileSync("src/renderer/src/App.tsx", "utf8")
  assert.match(app, /const CustomizeView = lazy\(/)
  assert.match(
    app,
    /fallback=\{<SettingsLoadingShell onClose=\{\(\) => setShowCustomizeView\(false\)\} \/>\}/
  )
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{lazy,Suspense,useEffect} from "react";import {createRoot} from "react-dom/client";
      import {SettingsOverlay,SettingsLoadingShell} from "./src/renderer/src/components/customize/SettingsOverlay";
      import {CustomizeView} from "./src/renderer/src/components/customize/CustomizeView";
      import {useAppStore} from "@/lib/store";
      window.calls=[];window.api={mods:{}};
      function LoadedSettings(){const account=useAppStore(state=>state.accountRevision);
        useEffect(()=>{window.calls.push(["mount",account]);return()=>window.calls.push(["unmount",account])},[]);
        return <div data-loaded-account={account} style={{height:"100%"}}><CustomizeView/></div>}
      const LazySettings=lazy(()=>new Promise(resolve=>{window.finishSettings=()=>resolve({default:LoadedSettings})}));
      function Fixture(){const showing=useAppStore(state=>state.showCustomizeView);
        const close=()=>useAppStore.getState().setShowCustomizeView(false);
        return <><textarea className="composer-textarea" aria-label="原聊天草稿" defaultValue="保留未发送的任务"/>
          <button onClick={()=>useAppStore.getState().setShowCustomizeView(true)}>打开自定义助手</button>
          {showing&&<SettingsOverlay onClose={close}><Suspense fallback={<SettingsLoadingShell onClose={close}/>}>
            <LazySettings/></Suspense></SettingsOverlay>}</>}
      window.fixture={open:()=>useAppStore.getState().setShowCustomizeView(true),
        account:()=>useAppStore.setState({accountRevision:1,showCustomizeView:false})};
      createRoot(document.getElementById("root")).render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "unvisited-settings-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "loading-fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "loading-fixture" }, () => ({
            resolveDir: process.cwd(),
            contents: `import {useSyncExternalStore} from "react";const listeners=new Set();
            let state={accountRevision:0,currentThreadId:null,threads:[],showCustomizeView:true,
              customizeInitialTab:"assistant",customizeInitialSection:null,pendingEvolution:null,
              setShowCustomizeView:value=>useAppStore.setState({showCustomizeView:value})};
            export const useAppStore=(selector=value=>value)=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>selector(state));
            useAppStore.getState=()=>state;useAppStore.setState=patch=>{const previous=state;state={...state,...patch};for(const listener of listeners)listener(state,previous)};
            useAppStore.subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
            export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
          }))
          builder.onResolve({ filter: /^\.\/\w+Panel$/ }, (args) =>
            args.importer.endsWith("CustomizeView.tsx")
              ? { path: args.path.slice(2), namespace: "unvisited-panel" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "unvisited-panel" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents: `import React,{useEffect} from "react";export function ${args.path}(){
            useEffect(()=>{window.calls.push(["heavy-panel",${JSON.stringify(args.path)}])},[]);return null}`
          }))
        }
      }
    ],
    loader: { ".md": "text", ".png": "dataurl" },
    define: { "import.meta.env": "{}", "import.meta.hot": "undefined" },
    logLevel: "error"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors: string[] = [],
      checks: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root" style="height:100vh;position:relative"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const settings = page.getByRole("dialog", { name: "设置", exact: true })
    const backText = settings
      .getByRole("button", { name: "返回应用", exact: true })
      .getByText("返回应用", { exact: true })
    await settings.getByRole("status").filter({ hasText: "正在打开自定义助手" }).waitFor()
    assert.equal(await backText.evaluate((element) => !!element.closest("button")), true)
    await backText.click()
    await settings.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.calls"), [])
    checks.push("delayed page keeps its return label clickable before any settings editor mounts")

    await page.evaluate("window.fixture.account();window.finishSettings()")
    // Flush React's settled import without assuming a fixed import latency.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    assert.deepEqual(await page.evaluate("window.calls"), [])
    assert.equal(await settings.count(), 0)
    checks.push("settling an old lazy import after close cannot mount a hidden page")

    await page.getByRole("button", { name: "打开自定义助手", exact: true }).click()
    await page.getByRole("main", { name: "自定义助手总览", exact: true }).waitFor()
    assert.equal(
      await page.locator("[data-loaded-account]").getAttribute("data-loaded-account"),
      "1"
    )
    await page.waitForFunction("window.calls.some(call=>call[0]==='mount')")
    assert.deepEqual(await page.evaluate("window.calls"), [["mount", 1]])
    checks.push(
      "reopening the resolved module mounts only the current account and no unvisited panels"
    )
    assert.equal(await backText.evaluate((element) => !!element.closest("button")), true)
    await backText.click()
    await settings.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.calls"), [
      ["mount", 1],
      ["unmount", 1]
    ])
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天草稿" }).inputValue(),
      "保留未发送的任务"
    )
    checks.push(
      "the loaded page's visible return text closes settings and preserves the original chat draft"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
