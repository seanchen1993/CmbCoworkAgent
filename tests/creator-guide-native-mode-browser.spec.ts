import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/creator-guide-native-mode-browser")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{useAppStore}from'@/lib/store';
      import{CustomizeView}from'./src/renderer/src/components/customize/CustomizeView';
      import{ApplicationUsageGuide}from'./src/renderer/src/components/guides/ApplicationUsageGuide';
      import{openApplicationUsageGuide}from'./src/renderer/src/components/guides/application-usage-guide';
      import{chooseConfigurationTarget}from'./src/renderer/src/lib/configuration-target';
      const nativeListeners=new Set(),modes=new Map(),calls=[];let held=false,finish;
      const key=id=>useAppStore.getState().accountRevision+':'+id;
      window.api={mods:{development:{status:async({threadId})=>{
        calls.push(['status',threadId]);const row=useAppStore.getState().threads.find(t=>t.thread_id===threadId);
        const captured={threadId,workspace:row.metadata.workspacePath,mode:modes.get(key(threadId))??'normal',enabled:true};
        if(held){held=false;await new Promise(resolve=>finish=resolve)}return captured},
        onChanged:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}}},
        uiGuides:{getState:async()=>({shouldShow:false}),acknowledge:async()=>{},recordDisplay:async()=>false}};
      const host=createRoot(document.getElementById('root'));
      window.control={calls,mode:(id,mode)=>{modes.set(key(id),mode);for(const fn of nativeListeners)fn({threadId:id})},
        hold:()=>held=true,finish:()=>finish(),target:id=>chooseConfigurationTarget({threadId:id,workspace:'C:/'+id}),
        account:()=>window.updateState({accountRevision:useAppStore.getState().accountRevision+1}),
        chat:()=>{window.updateState({showCustomizeView:false});host.render(<><main data-chat-thread-id="a">
          <button data-app-guide="creator" aria-pressed="true">创造者模式</button>
          <button data-app-guide="workspace">创作工作区</button>
          <button data-app-guide="navigation">导航</button><button data-app-guide="customize">自定义设置</button>
          <textarea className="composer-textarea"/><button data-app-guide="progress">进展</button>
          <button onClick={openApplicationUsageGuide}>使用指引</button><section id="messages"/>
          </main><ApplicationUsageGuide active/></>)}};
      window.scans=0;const query=document.querySelectorAll.bind(document);
      document.querySelectorAll=function(selector){if(selector.includes('data-app-guide')||selector.includes('data-cmb-modal-dialog'))window.scans++;return query(selector)};
      host.render(<CustomizeView/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            resolveDir: process.cwd(),
            contents: `
        import{useSyncExternalStore}from'react';const listeners=new Set();let state={accountRevision:0,currentThreadId:'a',showCustomizeView:true,mainView:'thread',customizeInitialTab:'flows',
          threads:[{thread_id:'a',title:'A',metadata:{agentMode:'normal',workspacePath:'C:/a'}},{thread_id:'b',title:'B',metadata:{agentMode:'normal',workspacePath:'C:/b'}}],
          setShowCustomizeView:()=>{},setSidebarCollapsed:()=>{}};
        window.updateState=values=>{const old=state;state={...state,...values};for(const fn of listeners)fn(state,old)};
        export const useAppStore=select=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>select?select(state):state);
        useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      `
          }))
          builder.onResolve({ filter: /^\.\/[A-Z]/ }, (args) =>
            args.importer.endsWith("CustomizeView.tsx") &&
            !["./SparksTour", "./ConfigurationTargetPicker"].includes(args.path)
              ? { path: args.path, namespace: "panel" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "panel" }, (args) => ({
            contents: `export const ${args.path.slice(2)}=()=>null`
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
    const page = await browser.newPage(),
      errors: string[] = [],
      checks: string[] = []
    page.setDefaultTimeout(10000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
    await page.waitForFunction("window.control.calls.length===1")
    await settle()
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    await page.evaluate("window.control.mode('a','creator')")
    await page.getByRole("button", { name: "本页任务示例", exact: true }).click()
    await page.getByRole("region", { name: "任务示例演练", exact: true }).waitFor()
    await page.evaluate("window.control.mode('a','normal')")
    await page
      .getByRole("region", { name: "任务示例演练", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    await page.evaluate("window.control.mode('a','creator')")
    await page.getByRole("button", { name: "本页任务示例", exact: true }).waitFor()
    assert.equal(await page.getByRole("region", { name: "任务示例演练", exact: true }).count(), 0)
    checks.push(
      "native normal→creator→normal gates manual examples and closes old overlay permanently"
    )
    const beforeBurst = await page.evaluate("window.control.calls.length")
    await page.evaluate(
      "window.control.hold();window.control.mode('a','creator');for(let i=0;i<20;i++)window.control.mode('a','normal')"
    )
    await page.evaluate("window.control.finish()")
    await page.waitForFunction(`window.control.calls.length===${beforeBurst + 2}`)
    await settle()
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    checks.push(
      "twenty native changes coalesce into two reads; a stale creator reply cannot revive a normal-mode guide"
    )
    await page.evaluate("window.control.mode('a','creator')")
    await page.getByRole("button", { name: "本页任务示例", exact: true }).waitFor()
    await page.evaluate("window.control.hold();window.control.mode('a','creator')")
    await page.evaluate("window.control.target('b')")
    await settle()
    await page.evaluate("window.control.finish()")
    await settle()
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    await page.evaluate("window.control.mode('b','creator')")
    await page.getByRole("button", { name: "本页任务示例", exact: true }).click()
    await page.getByRole("region", { name: "任务示例演练", exact: true }).waitFor()
    await page.evaluate("window.control.account()")
    await page
      .getByRole("region", { name: "任务示例演练", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("button", { name: "本页任务示例", exact: true }).count(), 0)
    checks.push(
      "old target reply cannot reveal another target; account change immediately hides and retires guide"
    )
    await page.evaluate("window.control.chat()")
    await settle()
    const ordinaryScans = await page.evaluate("window.scans"),
      reads = await page.evaluate("window.control.calls.length")
    await page.evaluate(() => {
      const messages = document.getElementById("messages")!
      for (let index = 0; index < 100; index++) {
        const node = document.createElement("article")
        node.textContent = "历史消息 " + index
        node.style.transform = `translateY(${index}px)`
        messages.append(node)
      }
      messages.scrollTop = 100
      messages.dispatchEvent(new Event("scroll"))
    })
    await settle()
    assert.equal(await page.evaluate("window.scans"), ordinaryScans)
    assert.equal(await page.evaluate("window.control.calls.length"), reads)
    await page.getByRole("button", { name: "使用指引", exact: true }).click()
    assert.equal(await page.locator('[aria-label="应用使用指引"]').count(), 0)
    checks.push(
      "ordinary native mode with stale creator DOM performs zero global guide scans/RPCs during 100 history mutations and scrolling"
    )
    await page.evaluate("window.control.mode('a','creator')")
    await page.waitForFunction("window.scans>0")
    await settle()
    const creatorScans = await page.evaluate("window.scans")
    await page.evaluate(() => {
      const messages = document.getElementById("messages")!
      for (let index = 0; index < 100; index++) {
        const node = document.createElement("article")
        node.textContent = "新增消息 " + index
        messages.append(node)
        node.style.transform = `translateY(${index}px)`
      }
    })
    await settle()
    assert.equal(await page.evaluate("window.scans"), creatorScans)
    checks.push(
      "creator mode with guide closed ignores unrelated history mutations without repeating global layout scans"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify({ passed: true, checks, errors }, null, 2)
    )
    checks.forEach((check) => console.log("PASS " + check))
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
