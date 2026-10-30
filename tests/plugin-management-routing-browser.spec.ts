import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/plugin-management-routing-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React from "react";import {createRoot} from "react-dom/client";
        import {CustomizeView} from "./src/renderer/src/components/customize/CustomizeView";
        import {openPluginSettings} from "./src/renderer/src/lib/plugin-settings-intent";
        window.calls=[];window.pluginList=[{id:"original",name:"Original Plugin",description:"Original plugin management",
          version:"1.0.0",author:"Author",path:"C:/plugins/original",enabled:false,origin:"local",skillCount:1,mcpServerCount:0,hookCount:0}];
        window.api={mods:{},plugins:{
          getDetail:async id=>{window.calls.push(["detail",id]);return {skills:["original-skill"],mcpServers:[],mcpServerDetails:[],hooks:[],hookCount:0,manifest:{name:"Original Plugin",version:"1.0.0",description:"Original details"}}},
          setEnabled:async(id,enabled)=>{window.calls.push(["enable",id,enabled]);window.pluginList=window.pluginList.map(plugin=>plugin.id===id?{...plugin,enabled}:plugin);return {success:true}},
          delete:async id=>{window.calls.push(["delete",id]);window.pluginList=window.pluginList.filter(plugin=>plugin.id!==id);return {success:true}},
          installFromDir:async()=>{window.calls.push(["install-directory"]);window.pluginList.push({...window.pluginList[0],id:"added",name:"Added Plugin"});return {success:true,pluginName:"Added Plugin"}},
          install:async(_bytes,name)=>{window.calls.push(["install-zip",name]);window.pluginList=window.pluginList.map(plugin=>plugin.id==="original"?{...plugin,version:"2.0.0"}:plugin);return {success:true,pluginName:"Original Plugin"}}
        }};
        window.openSettings=openPluginSettings;
        createRoot(document.getElementById("root")).render(<CustomizeView/>);`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "import.meta.env": "{}", "import.meta.hot": "undefined" },
    loader: { ".md": "text", ".png": "dataurl" },
    logLevel: "error",
    plugins: [
      {
        name: "plugin-routing-boundaries",
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
            loader: "tsx",
            contents:
              args.path === "store"
                ? `import {useSyncExternalStore} from "react";const listeners=new Set();let state={accountRevision:0,currentThreadId:null,threads:[],customizeInitialTab:"general",pluginVersion:0,
            bumpPluginVersion(){useAppStore.setState({pluginVersion:state.pluginVersion+1})},setShowCustomizeView(show,tab){useAppStore.setState({showCustomizeView:show,...(tab?{customizeInitialTab:tab}:{})})}};
            export const useAppStore=(selector=x=>x)=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));
            useAppStore.getState=()=>state;useAppStore.setState=patch=>{const previous=state;state={...state,...patch};for(const fn of listeners)fn(state,previous)};
            useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
                : args.path === "catalog"
                  ? "export const revalidatePluginCatalog=async()=>({plugins:structuredClone(window.pluginList)});export const invalidatePluginCatalog=()=>{};export const subscribePluginCatalogInvalidation=()=>()=>{};"
                  : args.path.includes("api/market")
                    ? "export const marketApi={getPlugins:async()=>({success:true,data:[]})}"
                    : args.path.endsWith("MarketPublishDialog")
                      ? "export const MarketPublishDialog=()=>null"
                      : "export const PluginFileEditorDialog=props=>props.open?<div role='dialog' aria-label='原插件文件配置'>原插件配置编辑器<button onClick={()=>props.onOpenChange(false)}>关闭配置</button></div>:null"
          }))
          builder.onResolve({ filter: /^\.\/\w+Panel$/ }, (args) =>
            args.importer.endsWith("CustomizeView.tsx") && args.path !== "./PluginsPanel"
              ? { path: args.path.slice(2), namespace: "panel" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "panel" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents: `import React,{useEffect} from "react";export function ${args.path}(){useEffect(()=>{window.calls.push(["panel",${JSON.stringify(args.path)}])},[]);return <section aria-label=${JSON.stringify(args.path)}>${args.path}</section>}`
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://localhost/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root" style="height:100vh"></div>'
      })
    )
    await page.goto("http://localhost/")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    for (const file of readdirSync("out/renderer/assets").filter((name) => name.endsWith(".css")))
      await page.addStyleTag({ path: resolve("out/renderer/assets", file) })
    const nav = page.getByRole("navigation").first()
    const pluginsEntry = nav.getByRole("button", { name: "插件", exact: true })
    const modsEntry = nav.getByRole("button", { name: "灵件", exact: true })
    await pluginsEntry.click()
    await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor()
    assert.equal(await pluginsEntry.getAttribute("aria-current"), "page")
    assert.equal(await modsEntry.getAttribute("aria-current"), null)
    assert.equal(await page.getByRole("combobox", { name: "配置目标聊天", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "返回插件", exact: true }).count(), 0)
    assert.equal(await page.getByRole("heading", { name: "导入与发布", exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "从此插件创建", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.calls.some(row=>row[0]==='panel'&&row[1]==='ModsPanel')"),
      false
    )
    const list = page.locator("[data-plugin-source-list]")
    await list.getByRole("button").filter({ hasText: "Original Plugin" }).click()
    const detail = page.locator("[data-plugin-source-detail]")
    await detail.getByText("original-skill", { exact: true }).waitFor()
    await detail.getByRole("button", { name: "编辑文件", exact: true }).click()
    await page.getByRole("dialog", { name: "原插件文件配置", exact: true }).waitFor()
    await page.getByRole("button", { name: "关闭配置", exact: true }).click()
    await detail.getByRole("button", { name: "已禁用", exact: true }).click()
    await detail.getByRole("button", { name: "已启用", exact: true }).waitFor()
    await detail.getByRole("button", { name: "已启用", exact: true }).click()
    await detail.getByRole("button", { name: "已禁用", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.calls.filter(row=>row[0]==='enable')"), [
      ["enable", "original", true],
      ["enable", "original", false]
    ])
    await page.screenshot({ path: resolve(output, "original-plugin-management.png") })
    // The original installer still owns directory installation and ZIP updates.
    await list.locator("button").first().click()
    const install = page.getByRole("dialog", { name: "安装 Plugin", exact: true })
    await install.getByRole("button", { name: "选择文件夹", exact: true }).click()
    await install.waitFor({ state: "hidden" })
    await list.getByRole("button").filter({ hasText: "Added Plugin" }).waitFor()
    await list.locator("button").first().click()
    await install
      .locator('input[type="file"]')
      .setInputFiles({
        name: "Original-Plugin.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("controlled fixture upload")
      })
    await install.waitFor({ state: "hidden" })
    await list
      .getByRole("button")
      .filter({ hasText: "Original Plugin" })
      .getByText("v2.0.0")
      .waitFor()
    await list.getByRole("button").filter({ hasText: "Added Plugin" }).click()
    await detail.getByRole("button", { name: "卸载", exact: true }).click()
    const remove = page.getByRole("dialog", { name: "确认卸载", exact: true })
    await remove.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await page.evaluate("window.calls.filter(row=>row[0]==='delete').length"), 0)
    await detail.getByRole("button", { name: "卸载", exact: true }).click()
    await remove.getByRole("button", { name: "卸载", exact: true }).click()
    await remove.waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate("window.calls.filter(row=>row[0]==='delete')"), [
      ["delete", "added"]
    ])
    await modsEntry.click()
    await page.getByRole("region", { name: "ModsPanel", exact: true }).waitFor()
    assert.equal(await pluginsEntry.getAttribute("aria-current"), null)
    assert.equal(await modsEntry.getAttribute("aria-current"), "page")
    assert.equal(await page.getByRole("heading", { name: "Plugins", exact: true }).count(), 0)
    // Scoped management links still resolve to the legacy settings page, with accurate selection.
    await page.evaluate("window.openSettings('original')")
    await detail.getByRole("heading", { name: "Original Plugin", exact: true }).waitFor()
    assert.equal(await pluginsEntry.getAttribute("aria-current"), "page")
    assert.equal(await modsEntry.getAttribute("aria-current"), null)
    assert.equal(await page.getByRole("region", { name: "ModsPanel", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS original plugin settings routing, install/update, enable/disable, uninstall and separate creator entry: " +
        output
    )
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
