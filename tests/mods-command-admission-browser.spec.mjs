import { build } from "esbuild"
import { chromium } from "playwright"
const stage = process.cwd()
const result = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import{useModCommands}from'./src/renderer/src/features/slash-commands/useModCommands';window.options={threadId:'t',enabled:false,workspace:'w'};window.calls=[];window.api={mods:{globalEnabled:()=>new Promise(r=>window.enable=r),commands:()=>new Promise(r=>(window.registries??=[]).push(r)),enqueue:async(...args)=>window.calls.push(args),onCardsChanged:()=>()=>{},onJobsChanged:()=>()=>{}}};function App(){window.commands=useModCommands(window.options.threadId,window.options.enabled,window.options.workspace);return React.createElement('div',null,'ready')}const root=createRoot(document.getElementById('root'));window.render=()=>root.render(React.createElement(App));window.render();`,
    resolveDir: stage,
    loader: "tsx"
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife"
})
let deadline
const browser = await chromium.launch({ headless: true, channel: "msedge" })
try {
  const page = await browser.newPage()
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: result.outputFiles[0].text })
  await page.waitForFunction(() => window.commands)
  const answer = await Promise.race([
    page.evaluate(async () => {
      const c = window.commands
      if (!c.mayHandle("/demo first")) throw Error("disabled UI skipped admission")
      let done = false
      const pending = c.submit("/demo first").then((v) => {
        done = true
        return v
      })
      window.options.enabled = true
      window.render()
      await new Promise((r) => setTimeout(r, 30))
      window.enable(true)
      await new Promise((r) => setTimeout(r, 30))
      if (done || !window.registries?.length) throw Error("did not wait catalog")
      window.registries.splice(0).forEach((resolve) =>
        resolve([
          {
            apiVersion: "cmb.mods/v2",
            modId: "function:demo",
            name: "demo",
            command: "demo",
            digest: "d",
            grantEpoch: 1,
            workspaceEpoch: 1,
            turnId: "f:t"
          }
        ])
      )
      if (!(await pending) || window.calls.length !== 1) throw Error("did not enqueue")
      const stale = c.submit("/demo second")
      window.enable(true)
      await new Promise((r) => setTimeout(r, 30))
      window.options.workspace = "other"
      window.render()
      await new Promise((r) => setTimeout(r, 30))
      window.registries.splice(0).forEach((resolve) => resolve([]))
      let rejected = false
      try {
        await stale
      } catch {
        rejected = true
      }
      if (!rejected || window.calls.length !== 1) throw Error("scope escape")
      window.options = { threadId: "new", enabled: false, workspace: "new-workspace" }
      window.render()
      await new Promise((r) => setTimeout(r, 30))
      const next = window.commands.submit("/demo third")
      window.enable(true)
      await new Promise((r) => setTimeout(r, 30))
      window.registries.splice(0).forEach((resolve) =>
        resolve([
          {
            apiVersion: "cmb.mods/v2",
            modId: "function:demo",
            name: "demo",
            command: "demo",
            digest: "d",
            grantEpoch: 1,
            workspaceEpoch: 1,
            turnId: "f:new"
          }
        ])
      )
      if (!(await next) || window.calls.length !== 2 || window.calls[1][0] !== "new")
        throw Error("disabled thread cleanup")
      return {
        coldDisabledHook: true,
        uiEnableRefreshDuringSend: true,
        waitedCatalog: true,
        enqueuedOnce: true,
        changedWorkspaceRejected: true,
        disabledThreadChange: true
      }
    }),
    new Promise((_, reject) => (deadline = setTimeout(() => reject(Error("HOOK_TIMEOUT")), 12000)))
  ])
  console.log(answer)
} finally {
  clearTimeout(deadline)
  await browser.close()
}
