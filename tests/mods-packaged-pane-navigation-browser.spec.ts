import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { waitForPackagedPaneResults } from "./support/mods-packaged-functions"
import { closeModsProgress } from "./support/mods-sidebar-navigation"

async function main() {
  const output = resolve("output/mods-packaged-pane-navigation-browser")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React from 'react';import{createRoot}from'react-dom/client';import{useAppStore}from'@/lib/store';
      import{ClawSidebar,ClawComposerBar}from'./src/renderer/src/components/chat/ClawSidebar';
      import{ClawSidebarHost}from'./src/renderer/src/components/panels/ClawSidebarHost';
      import{publishClawNotice,revealClawPanes}from'./src/renderer/src/lib/claw-sidebar';
      const flow={threadId:'a',enabled:false,choice:null,run:null,flows:[],active:false,busy:false,loading:false,
        load:async()=>{},clear:()=>{},choose:()=>{}};
      window.api={mods:{}};
      function Fixture(){const visible=useAppStore(s=>s.rightModule==='claw'&&!s.rightPanelCollapsed);
        return <div style={{height:600,position:'relative'}}>
          <div style={{position:'absolute',right:20,top:100,width:280}}>
            <ClawComposerBar threadId="a" flow={flow}/><textarea className="composer-textarea" aria-label="聊天输入"/>
          </div>
          <div data-claw-sidebar-shell hidden={!visible} style={{position:'fixed',right:0,top:0,width:520,height:'100vh',zIndex:40,background:'white'}}>
            <ClawSidebarHost threadId="a"/>
          </div>
          <ClawSidebar threadId="a" flow={flow} disabled={false} onStart={async()=>false} onFollowUp={()=>{}}>
            <section data-function-pane="fixture"><h3>Code E2E</h3><p>Pane navigation fixture only</p>
              <input aria-label="Second focus field"/></section>
          </ClawSidebar>
        </div>}
      window.openPane=id=>{publishClawNotice('a','panes','1 个插件面板');revealClawPanes('a',[{key:id,openRequestId:id}])};
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "scoped-store",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/store$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            resolveDir: process.cwd(),
            contents: `
        import{useSyncExternalStore}from'react';const listeners=new Set();const state={currentThreadId:'a',mainView:'thread',rightModule:'work',rightPanelCollapsed:true,models:[],
          setRightModule:value=>{state.rightModule=value;for(const fn of listeners)fn(state)},setRightPanelCollapsed:value=>{state.rightPanelCollapsed=value;for(const fn of listeners)fn(state)}};
        export const useAppStore=select=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>select(state));
        useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      `
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
    const page = await browser.newPage({ viewport: { width: 900, height: 680 } }),
      errors: string[] = []
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByLabel("聊天输入", { exact: true }).waitFor()
    await page.evaluate("window.openPane('code')")
    await waitForPackagedPaneResults(page)
    await page.getByRole("heading", { name: "Code E2E", exact: true }).waitFor()
    const badge = page.getByRole("button", { name: "1 个插件面板 · 查看", exact: true })
    assert(await badge.isVisible())
    await assert.rejects(badge.click({ timeout: 300 }), /Timeout|intercepts pointer events/)
    // The production helper waits for the already-revealed results rather than clicking behind it.
    await waitForPackagedPaneResults(page)
    await closeModsProgress(page)
    await page.getByLabel("聊天输入", { exact: true }).fill("draft remains reachable")
    await page.evaluate("window.openPane('focus')")
    await waitForPackagedPaneResults(page)
    await page
      .getByRole("textbox", { name: "Second focus field", exact: true })
      .fill("actual visible pane input")
    assert(
      await page
        .getByRole("textbox", { name: "Second focus field", exact: true })
        .evaluate((node) => node === document.activeElement)
    )
    await closeModsProgress(page)
    assert.equal(
      await page.getByLabel("聊天输入", { exact: true }).inputValue(),
      "draft remains reachable"
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Real React sidebar/reveal and pointer interactions with a narrow overlay layout fixture; not packaged worker execution",
          checks: [
            "Visible badge behind opened sidebar is physically occluded",
            "Actual packaged helper uses revealed Results without a background click",
            "Native close restores composer reachability; the next pane opens and accepts focused input"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log(
      "PASS narrow sidebar: reproduce occluded badge, wait existing Results, close before composer, reopen next pane without forced clicks"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
