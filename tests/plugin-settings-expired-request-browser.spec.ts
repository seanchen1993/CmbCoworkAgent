import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface SettingsFixtureWindow extends Window {
  requests: Array<{ resolve(plugins: unknown[]): void; reject(error: Error): void }>
  details: string[]
  pending: { id: string; pluginId: string } | null
  openRequest(pluginId: string): void
  renderSettings(show?: boolean): void
  setClaw(): void
}

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React,{StrictMode} from 'react';import {createRoot} from 'react-dom/client';
        import {CustomizeView} from './src/renderer/src/components/customize/CustomizeView';
        import {openPluginSettings,usePluginSettingsRequest} from './src/renderer/src/lib/plugin-settings-intent';
        import {useAppStore} from '@/lib/store';
        window.requests=[];window.details=[];
        window.api={plugins:{getDetail:async id=>{window.details.push(id);return {skills:[],mcpServers:[],mcpServerDetails:[],hooks:[],hookCount:0,manifest:null}}}};
        const root=createRoot(document.getElementById('root'));
        function Observer(){const request=usePluginSettingsRequest();window.pending=request;return null}
        window.openRequest=openPluginSettings;
        window.renderSettings=(show=true)=>root.render(<StrictMode><Observer/>{show&&<CustomizeView/>}</StrictMode>);
        window.setClaw=()=>useAppStore.getState().setShowCustomizeView(true,'claw');
        window.renderSettings();`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "import.meta.env": "{}" },
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "expired-request-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^@\/lib\/app-catalog-cache$/ }, () => ({
            path: "catalog",
            namespace: "fixture"
          }))
          builder.onResolve(
            {
              filter:
                /^(?:\.\.\/\.\.\/api\/market|\.\/MarketPanel\/MarketPublishDialog|\.\/PluginFileEditorDialog)$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "js",
            contents:
              args.path === "store"
                ? `import {useSyncExternalStore} from 'react';
              const listeners=new Set();let state={currentThreadId:null,threads:[],customizeInitialTab:'claw',pluginVersion:0,bumpPluginVersion(){},
              setShowCustomizeView(show,tab){state={...state,customizeInitialTab:tab};listeners.forEach(fn=>fn())}};
              export const useAppStore=(selector=x=>x)=>selector(useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state));useAppStore.getState=()=>state;`
                : args.path === "catalog"
                  ? `export const invalidatePluginCatalog=()=>{};export const subscribePluginCatalogInvalidation=()=>()=>{};
                export const revalidatePluginCatalog=()=>new Promise((resolve,reject)=>window.requests.push({resolve:plugins=>resolve({plugins}),reject}));`
                  : args.path.includes("api/market")
                    ? "export const marketApi={getPlugins:async()=>({success:false})}"
                    : args.path.endsWith("MarketPublishDialog")
                      ? "export const MarketPublishDialog=()=>null"
                      : "export const PluginFileEditorDialog=()=>null"
          }))
          builder.onResolve({ filter: /^\.\// }, (args) => {
            if (
              args.importer.endsWith("CustomizeView.tsx") &&
              !["./settings-return-focus", "./PluginsPanel"].includes(args.path)
            ) {
              return { path: args.path.slice(2), namespace: "panel" }
            }
          })
          builder.onLoad({ filter: /.*/, namespace: "panel" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents:
              args.path === "ClawPanel"
                ? "export const ClawPanel=()=> <p>组合入口 fixture</p>"
                : `export const ${args.path}=()=>null`
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://localhost/settings", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/settings")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByText("组合入口 fixture", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).openRequest("removed"))
    await page.waitForFunction(
      () => (window as unknown as SettingsFixtureWindow).requests.length > 0
    )
    assert.equal(
      await page.getByText("此插件已不在已安装列表中，可能已被卸载。", { exact: true }).count(),
      0
    )
    await page.evaluate(() => {
      for (const request of (window as unknown as SettingsFixtureWindow).requests.splice(0))
        request.resolve([
          {
            id: "available",
            name: "Available plugin",
            description: "",
            path: "fixture",
            enabled: true,
            origin: "local",
            skillCount: 0,
            mcpServerCount: 0
          }
        ])
    })
    await page.getByText("此插件已不在已安装列表中，可能已被卸载。", { exact: true }).waitFor()
    await page.waitForFunction(() => (window as unknown as SettingsFixtureWindow).pending === null)
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).openRequest("available"))
    await page.waitForFunction(() =>
      (window as unknown as SettingsFixtureWindow).details.includes("available")
    )
    await page
      .getByText("此插件已不在已安装列表中，可能已被卸载。", { exact: true })
      .waitFor({ state: "hidden" })
    await page.waitForFunction(() => (window as unknown as SettingsFixtureWindow).pending === null)
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).renderSettings(false))
    await page.evaluate(() => {
      ;(window as unknown as SettingsFixtureWindow).setClaw()
      ;(window as unknown as SettingsFixtureWindow).renderSettings()
    })
    await page.getByText("组合入口 fixture", { exact: true }).waitFor()

    // A closing view cancels only its request, even while the catalog is unresolved.
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).openRequest("old"))
    await page.waitForFunction(
      () => (window as unknown as SettingsFixtureWindow).requests.length > 0
    )
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).renderSettings(false))
    await page.waitForFunction(() => (window as unknown as SettingsFixtureWindow).pending === null)
    await page.evaluate(() => {
      for (const request of (window as unknown as SettingsFixtureWindow).requests.splice(0))
        request.resolve([])
    })
    await page.evaluate(() => {
      ;(window as unknown as SettingsFixtureWindow).setClaw()
      ;(window as unknown as SettingsFixtureWindow).renderSettings()
    })
    await page.getByText("组合入口 fixture", { exact: true }).waitFor()

    // The latest request wins while a previous lookup is still pending.
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).openRequest("removed"))
    await page.waitForFunction(
      () => (window as unknown as SettingsFixtureWindow).requests.length > 0
    )
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).openRequest("available"))
    await page.evaluate(() => {
      for (const request of (window as unknown as SettingsFixtureWindow).requests.splice(0))
        request.resolve([
          {
            id: "available",
            name: "Available plugin",
            description: "",
            path: "fixture",
            enabled: true,
            origin: "local",
            skillCount: 0,
            mcpServerCount: 0
          }
        ])
    })
    await page.waitForFunction(() =>
      (window as unknown as SettingsFixtureWindow).details.includes("available")
    )
    await page.waitForFunction(() => (window as unknown as SettingsFixtureWindow).pending === null)
    assert.equal(
      await page.getByText("此插件已不在已安装列表中，可能已被卸载。", { exact: true }).count(),
      0
    )
    await page.evaluate(() => (window as unknown as SettingsFixtureWindow).renderSettings(false))
    await page.evaluate(() => {
      ;(window as unknown as SettingsFixtureWindow).setClaw()
      ;(window as unknown as SettingsFixtureWindow).renderSettings()
    })
    await page.getByText("组合入口 fixture", { exact: true }).waitFor()
    await page.evaluate(() =>
      (window as unknown as SettingsFixtureWindow).openRequest("unreadable")
    )
    await page.waitForFunction(
      () => (window as unknown as SettingsFixtureWindow).requests.length > 0
    )
    await page.evaluate(() => {
      for (const request of (window as unknown as SettingsFixtureWindow).requests.splice(0))
        request.reject(Error("fixture read failed"))
    })
    await page.getByText("暂时无法读取插件列表，请重新打开插件管理。", { exact: true }).waitFor()
    await page.waitForFunction(() => (window as unknown as SettingsFixtureWindow).pending === null)
    assert.deepEqual(errors, [])
    console.log(
      "PASS expired settings requests resolve once, wait for catalog, cancel on close and preserve replacement requests (StrictMode)"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
