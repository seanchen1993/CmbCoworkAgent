import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const script = await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ModsSettings} from './src/renderer/src/components/customize/ModsPanel';
      window.calls=[]; window.globalOn=true; window.optional=true; window.thread='chat';
      window.api={plugins:{list:async()=>[]},mods:{
        globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{},
        configureGlobal:async value=>{window.calls.push(value);
          if(window.writeFails)throw Error('settings write failed');window.globalOn=value;return value},
        clawView:async()=>null,status:async()=>({workspace:'',enabled:false,outputPolicy:true,
          globalEnabled:window.globalOn,mods:[],diagnostics:[],
          recovery:'MODS_CONTROL_RECOVERY_REQUIRED',recoveryCanDisable:window.optional})}};
      window.api.mods.recoveryStatus=window.api.mods.status;
      const root=createRoot(document.getElementById('root'));
      window.renderFixture=()=>root.render(<ModsSettings threadId={window.thread}
        workspaceHint={window.thread ? 'C:/existing-project' : null} active/>);
      window.renderFixture();
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [{ name: "host-boundaries", setup(builder) {
      builder.onResolve({ filter:
        /^@\/lib\/(store|feature-gates|derived-project-intent|claw-sidebar|plugin-settings-intent)$/
      }, args => ({ path: args.path, namespace: "fixture" }))
      builder.onResolve({ filter:
        /^\.\/(ModCreator|PluginDerivationPanel|OfficialSparksExamples|FunctionCompletionPolicy|FunctionCompatibilityCheck|FunctionUserConfig|SparksDocumentationLink|InstalledPluginStartUse)$/
      }, args => ({ path: args.path, namespace: "component" }))
      builder.onLoad({ filter: /.*/, namespace: "component" }, args => ({ loader: "tsx",
        contents: `export const ${args.path.slice(2)}=()=>null` }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js",
        contents: args.path.endsWith("store")
          ? "const s={accountRevision:1,bumpPluginVersion(){}};export const useAppStore=Object.assign(f=>f(s),{getState:()=>s})"
          : args.path.endsWith("feature-gates")
            ? "export const useFeatureGate=()=>({enabled:false,loading:false})"
            : args.path.endsWith("plugin-settings-intent")
              ? "export const openPluginSettings=()=>{}"
              : args.path.endsWith("claw-sidebar")
                ? "export const openClawSidebar=()=>{}"
                : "export const openDerivedProject=()=>{};export const openExistingPluginProject=()=>{};export const useDerivedProjectIntent=()=>null;export const dismissDerivedProject=()=>{}"
      }))
    } }]
  })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: script.outputFiles[0].text })
    // The fallback has no workspace. A normal selected project's hint must not hide recovery.
    await page.getByText("无法读取灵件的权限设置。可在下方更多设置中关闭灵件", {
      exact: false
    }).waitFor()
    await page.locator("[data-mods-more-settings] > summary").click()
    const toggle = page.getByRole("checkbox", { name: "允许使用灵件" })
    assert.equal(await toggle.isChecked(), true)
    assert.equal(await toggle.isEnabled(), true)
    await toggle.uncheck()
    await page.getByText("灵件已关闭，普通会话可继续使用", { exact: false }).waitFor()
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await toggle.isDisabled(), true)
    assert.deepEqual(await page.evaluate("window.calls"), [false])
    await page.evaluate(`window.globalOn=true;window.optional=false;
      window.dispatchEvent(new Event('mods:configuration-changed'))`)
    await page.getByText("工具操作已暂停", { exact: false }).waitFor()
    assert.equal(await toggle.isChecked(), true)
    assert.equal(await toggle.isDisabled(), true)
    await page.evaluate(`window.thread=null;window.optional=true;window.globalOn=undefined;
      window.writeFails=true;window.renderFixture()`)
    await page.getByText("无法确认灵件开关状态", { exact: false }).waitFor()
    assert.equal(await page.getByText("灵件已关闭，普通会话可继续使用", { exact: false }).count(), 0)
    const recover = page.getByRole("button", { name: "关闭灵件并恢复普通会话" })
    await recover.click()
    await page.getByText("settings write failed", { exact: true }).waitFor()
    assert.equal(await page.getByText("灵件已关闭，普通会话可继续使用", { exact: false }).count(), 0)
    await page.evaluate("window.writeFails=false")
    await recover.click()
    await page.getByText("灵件已关闭，普通会话可继续使用", { exact: false }).waitFor()
    assert.deepEqual(await page.evaluate("window.calls"), [false, false, false])
    assert.deepEqual(errors, [])
    console.log("PASS Mods recovery: workspace/global settings, unknown switch, failed write, opt-out, policy")
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
