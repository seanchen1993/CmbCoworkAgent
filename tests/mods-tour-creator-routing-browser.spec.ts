import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/mods-tour-creator-routing", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const renderer = resolve("src/renderer/src")
  const bundle = await build({
    stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {CustomizeView} from ${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
      import {SettingsReturnFocusContext} from ${JSON.stringify(join(renderer, "components/customize/settings-return-focus.ts"))};
      import {useAppStore} from '@/lib/store';
      window.calls=[];
      window.api={mods:{globalEnabled:async()=>{window.calls.push(['read-global']);return true},
        status:async threadId=>{window.calls.push(['read-settings',threadId]);return {workspace:'C:/Owned/Workspace',enabled:true}},
        configureGlobal:async()=>{throw Error('Unexpected global mutation')},configure:async()=>{throw Error('Unexpected project mutation')},
        development:{status:async({threadId})=>({threadId,workspace:'C:/Owned/Workspace',enabled:true,mode:'creator'}),onChanged:()=>()=>{},setMode:async input=>{window.calls.push(['mode',input]);if(window.routingScenario.error)throw Error(window.routingScenario.error);return {threadId:input.threadId,workspace:input.expectedWorkspace,enabled:true,mode:input.mode,drafts:[],trials:[]}}}}};
      function Fixture(){const showing=useAppStore(state=>state.showCustomizeView);return <>
        <textarea id='composer' aria-label='原聊天草稿' defaultValue='保留原来的任务草稿'/>
        {showing&&<SettingsReturnFocusContext.Provider value={()=>{window.calls.push(['focus-composer']);document.getElementById('composer').focus()}}><CustomizeView/></SettingsReturnFocusContext.Provider>}
      </>};createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    alias: { "@": renderer },
    plugins: [{
      name: "unrelated-settings-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({ path: "store", namespace: "routing-fixture" }))
        builder.onResolve({ filter: /^\.\/(?:\w+Panel|AssistantWorkbench)$/ }, args =>
          /[\\/]CustomizeView\.tsx$/.test(args.importer)
            ? { path: args.path.slice(2), namespace: "routing-panel" } : undefined)
        builder.onLoad({ filter: /.*/, namespace: "routing-fixture" }, () => ({
          resolveDir: process.cwd(),
          contents: `import {useSyncExternalStore} from 'react';const listeners=new Set();const notify=()=>{for(const listener of listeners)listener()};
            const state={showCustomizeView:true,customizeInitialTab:window.routingScenario.tab,customizeInitialSection:null,pendingEvolution:null,
              currentThreadId:'a',threads:[{thread_id:'a',title:'目标聊天',metadata:{workspacePath:'C:/Owned/Workspace',agentMode:'normal',...(window.routingScenario.unavailable?{pluginId:'project-plugin'}:{})}}],
              setShowCustomizeView:(...args)=>{window.calls.push(['settings',...args]);state.showCustomizeView=args[0];notify()},
              selectThread:async id=>{window.calls.push(['thread',id]);state.currentThreadId=id;state.showCustomizeView=false;notify()}};
            export const useAppStore=(selector=value=>value)=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>selector(state));
            useAppStore.getState=()=>state;useAppStore.subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};`
        }))
        builder.onLoad({ filter: /.*/, namespace: "routing-panel" }, args => ({
          resolveDir: process.cwd(),
          contents: `import React,{useEffect} from 'react';export function ${args.path}(props){
            useEffect(()=>{window.calls.push(['panel-mounted',${JSON.stringify(args.path)}])},[]);
            useEffect(()=>{if(props.navigationRequest)window.calls.push(['manual-navigation',${JSON.stringify(args.path)},props.navigationRequest])},[props.navigationRequest]);
            return <section aria-label=${JSON.stringify(`测试边界 ${args.path}`)}><input aria-label=${JSON.stringify(`${args.path}草稿`)} defaultValue=''/></section>}`,
          loader: "tsx"
        }))
      }
    }]
  })
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const results: unknown[] = []
  try {
    for (const scenario of [
      { task: "create", option: "0", tab: "mods" },
      { task: "combine", option: "1", tab: "mods" },
      { task: "create", option: "0", tab: "claw", error: "DEVELOPMENT_SCOPE_CHANGED" },
      { task: "combine", option: "1", tab: "flows", error: "DEVELOPMENT_SCOPE_CHANGED" },
      { task: "create", option: "0", tab: "claw", unavailable: true }
    ]) {
      const { task, option } = scenario
      const page = await browser.newPage()
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await page.setContent('<div id="root"></div>')
      await page.evaluate(scenario => {
        (window as unknown as { routingScenario: unknown }).routingScenario = scenario
      }, scenario)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      if (scenario.unavailable) {
        await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
        assert.equal(await page.getByRole("button", { name: "任务示例演练", exact: true }).count(), 0)
        const calls = await page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls)
        assert.deepEqual(calls.filter(([name]) => name === "mode" || name === "read-global"), [])
        assert.deepEqual(errors, [])
        results.push({ ...scenario, calls, errors, guideSuppressed: true })
        await page.close()
        continue
      }
      const panelDraft = scenario.tab === "claw" ? "ClawPanel草稿" : "FlowsPanel草稿"
      if (scenario.tab !== "mods") await page.getByLabel(panelDraft, { exact: true }).fill("保留页面草稿")
      await page.getByRole("button", { name: "任务示例演练", exact: true }).click()
      const tour = page.getByRole("region", { name: "任务示例演练", exact: true })
      await tour.getByLabel("选择任务", { exact: true }).selectOption(option)
      const primary = tour.locator("button.bg-primary")
      await primary.click()
      if (task === "create") await tour.getByLabel("新插件名称").fill("导览创建需求")
      await primary.click()
      await primary.click()
      if (scenario.error || scenario.unavailable) {
        const message = scenario.unavailable
          ? "请在上方选择普通本地聊天，再进入创造者模式。"
          : "聊天或项目已变化，请重新选择目标聊天后再进入创造者模式。"
        const alert = page.getByRole("alert").filter({ hasText: message })
        await alert.waitFor()
        assert.equal(await alert.innerText(), message)
        assert.equal(await page.getByRole("button", { name: "返回应用", exact: true }).isVisible(), true)
        assert.equal(await page.getByLabel(panelDraft, { exact: true }).inputValue(), "保留页面草稿")
        assert.equal(await page.getByRole("region", { name: "任务示例演练", exact: true }).count(), 0)
      } else {
        await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
        await page.waitForFunction(() => document.activeElement?.id === "composer")
      }
      const calls = await page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls)
      assert.deepEqual(calls.filter(([name]) => name === "mode"), scenario.unavailable ? [] : [["mode", {
        threadId: "a", expectedWorkspace: "C:/Owned/Workspace", mode: "creator"
      }]], `${task} must enter the native creator mode through the production callback`)
      if (scenario.unavailable) assert.equal(calls.some(([name]) => name === "read-global"), false)
      const failed = !!scenario.error || !!scenario.unavailable
      assert.deepEqual(calls.filter(([name]) => name === "settings"), failed ? [] : [["settings", false]])
      assert.deepEqual(calls.filter(([name]) => name === "focus-composer"), failed ? [] : [["focus-composer"]])
      assert.equal(calls.some(([name]) => name === "manual-navigation"), false)
      if (!failed) assert.equal(calls.some(([name, panel]) => name === "panel-mounted" && ["ClawPanel", "FlowsPanel", "AssistantWorkbench"].includes(String(panel))), false,
        `${task} must return to creator chat rather than open a manual module`)
      assert.equal(await page.getByRole("textbox", { name: "原聊天草稿" }).inputValue(), "保留原来的任务草稿")
      assert.deepEqual(errors, [])
      results.push({ ...scenario, calls, errors })
      await page.close()
    }
    writeFileSync(join(output, "report.json"), JSON.stringify({
      passed: true, scope: "Real CustomizeView, tour callback, creator entry and configuration navigation; unrelated panels/store/native IPC are bounded fixtures", results
    }, null, 2))
    console.log(`PASS tour creator routing: creator handoff and visible scope/unavailable errors preserve drafts without retries; ${output}`)
  } finally { await browser.close() }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
