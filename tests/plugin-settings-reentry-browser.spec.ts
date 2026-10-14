/** Repeated management requests must navigate the retained settings view every time. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const renderer = resolve("src/renderer/src")
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import {CustomizeView} from './src/renderer/src/components/customize/CustomizeView';
        createRoot(document.getElementById('root')).render(<CustomizeView/>);`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    plugins: [
      {
        name: "settings-reentry",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /^store$/, namespace: "fixture" }, () => ({
            resolveDir: process.cwd(),
            loader: "js",
            contents: `import {useSyncExternalStore} from 'react';
            const listeners=new Set();let state={currentThreadId:null,threads:[],customizeInitialTab:'claw',
              setShowCustomizeView(show,tab){state={...state,customizeInitialTab:tab};listeners.forEach(fn=>fn())}};
            export const useAppStore=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state);
            useAppStore.getState=()=>state;`
          }))
          builder.onResolve({ filter: /^\.\// }, (args) => {
            if (
              args.importer.endsWith("CustomizeView.tsx") &&
              args.path !== "./settings-return-focus"
            )
              return { path: args.path.slice(2), namespace: "panel" }
          })
          builder.onLoad({ filter: /.*/, namespace: "panel" }, (args) => ({
            resolveDir: process.cwd(),
            loader: "tsx",
            contents:
              args.path === "ClawPanel"
                ? `import {openPluginSettings} from '@/lib/plugin-settings-intent';
              export function ClawPanel(){return <button onClick={()=>openPluginSettings('original')}>管理原版插件</button>}`
                : args.path === "PluginsPanel"
                  ? `import {useEffect} from 'react';import {usePluginSettingsRequest,consumePluginSettings} from '@/lib/plugin-settings-intent';
                export function PluginsPanel(){const request=usePluginSettingsRequest();
                  useEffect(()=>{if(request)consumePluginSettings(request.id)},[request]);return <p>原版插件管理页</p>}`
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
      route.fulfill({
        contentType: "text/html",
        body: "<div id='root'></div>"
      })
    )
    await page.goto("http://localhost/settings")
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole("button", { name: "管理原版插件", exact: true }).click()
      await page.getByText("原版插件管理页", { exact: true }).waitFor()
      await page.getByRole("button", { name: "助手组合", exact: true }).click()
      await page.getByRole("button", { name: "管理原版插件", exact: true }).waitFor()
      assert.equal(await page.getByText("原版插件管理页", { exact: true }).count(), 0)
    }
    assert.deepEqual(errors, [])
    console.log(
      "PASS repeated plugin management requests navigate the actual retained settings view"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
