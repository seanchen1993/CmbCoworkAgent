import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve, join } from "node:path"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
const root = process.cwd(),
  output = resolve("output/sparks-ux-redesign-20261010/layout-test")
mkdirSync(output, { recursive: true })
const renderer = resolve("src/renderer/src")
const script = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {CustomizeView} from ${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
window.api={plugins:{list:async()=>[]},skills:{listPlugins:async()=>[]},mods:{
clawView:async()=>({workspace:'C:/isolated/project',revision:0,bindingRevision:0,profiles:[],active:null,enabled:true,applicable:true,issues:[],capabilities:[]}),
flowCatalog:async()=>({available:true,hostAvailable:true,workspace:'C:/isolated/project',plugins:[],actions:[],agents:[],models:[],features:[]}),
flowList:async()=>[],clawSources:async()=>({skills:[],mcp:[]}),onConfigurationChanged:()=>()=>{},
evaluation:{list:async()=>({ok:true,value:{workspace:'C:/isolated/project',evaluations:[{id:'eval-one',threadId:'t',workspace:'C:/isolated/project',state:'complete',provider:'controlled',baseline:{name:'基线',cases:[]},candidate:{name:'候选',digest:'candidate',cases:[]},tasks:Array.from({length:5},(_,i)=>({id:'task-'+i,goal:'受控任务 '+i})),comparison:{comparable:false,baseline:{confirmedPassRate:0,unknown:5},candidate:{confirmedPassRate:0,unknown:5}}}]}})}
}};
window.mountTab=(tab)=>{window.fixtureState.customizeInitialTab=tab;createRoot(document.getElementById('root')).render(<CustomizeView/>)};
window.mountTab(location.hash.slice(1)||'claw');`
const bundle = await build({
  stdin: { contents: script, loader: "tsx", resolveDir: root },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  loader: { ".md": "text", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /^(?:@\/lib\/store|\.\.\/\.\.\/lib\/store)$/ }, () => ({
          path: "store",
          namespace: "fixture"
        }))
        // Stub unrelated PascalCase panels; real lower-case utilities keep their host contracts.
        b.onResolve({ filter: /^\.\/(?:[A-Z][A-Za-z0-9]*Panel|AssistantWorkbench)$/ }, (a) => {
          if (
            a.importer.endsWith("CustomizeView.tsx") &&
            !["./ClawPanel", "./EvaluationPanel"].includes(a.path)
          )
            return { path: a.path, namespace: "empty-panel" }
        })
        b.onLoad({ filter: /.*/, namespace: "empty-panel" }, (a) => ({
          resolveDir: root,
          contents:
            a.path === "./ModsPanel"
              ? `import React from "react";export const ModsPanel=({onManageSources})=>React.createElement("section",null,React.createElement("p",null,"installed-management"),React.createElement("button",{onClick:onManageSources},"导入与发布"))`
              : `export const ${a.path.slice(2)}=()=>null`,
          loader: "js"
        }))
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `window.fixtureState={accountRevision:0,currentThreadId:'t',threads:[{thread_id:'t',metadata:{workspacePath:'C:/isolated/project',agentMode:'normal'}}],setShowCustomizeView:()=>{}};export const useAppStore=(select)=>select?select(window.fixtureState):window.fixtureState;useAppStore.getState=()=>window.fixtureState;useAppStore.subscribe=()=>()=>{};export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`,
          loader: "js"
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
})
const errors = [],
  result = {}
try {
  for (const width of [900, 600])
    for (const tab of ["claw", "evaluation"]) {
      const page = await browser.newPage({ viewport: { width, height: 650 } })
      page.on("pageerror", (e) => errors.push(e.message))
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<html><head></head><body><div id="root" style="height:100vh"></div></body></html>'
        })
      )
      await page.goto("http://127.0.0.1/layout#" + tab)
      const assets = resolve("out/renderer/assets"),
        css = readdirSync(assets).find((n) => /^index-.*\.css$/.test(n))
      if (!css) throw Error("No built stylesheet")
      await page.addStyleTag({ path: join(assets, css) })
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      const draft = `保留布局草稿-${width}`
      if (tab === "claw") {
        await page.getByRole("region", { name: "简单组合", exact: true })
          .getByLabel("组合名称", { exact: true }).fill(draft)
        await page.getByText("高级编辑与已保存组合", { exact: true }).click()
        await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
      }
      const button = page.getByRole("button", {
        name: tab === "claw" ? "保存组合" : "打开候选流程（使用或编辑）",
        exact: true
      })
      await button.waitFor({ state: "visible" })
      const region = page.getByLabel(tab === "claw" ? "助手组合设置" : "评测设置", { exact: true })
      // Opening folded controls may scroll them into view. Start the wheel probe from the top.
      await region.focus()
      await page.keyboard.press("Home")
      await page.keyboard.press("Control+Home")
      await page.waitForFunction(
        (label) => document.querySelector(`[aria-label="${label}"]`)?.scrollTop === 0,
        tab === "claw" ? "助手组合设置" : "评测设置",
        { timeout: 1800 }
      )
      const geometry = () =>
        button.evaluate((el) => {
          const ancestors = []
          let p = el
          while (p) {
            const r = p.getBoundingClientRect(),
              s = getComputedStyle(p)
            ancestors.push({
              tag: p.tagName,
              className: p.className,
              top: r.top,
              bottom: r.bottom,
              clientHeight: p.clientHeight,
              scrollHeight: p.scrollHeight,
              scrollTop: p.scrollTop,
              overflowY: s.overflowY,
              display: s.display
            })
            p = p.parentElement
          }
          return { innerHeight, ancestors }
        })
      const before = await geometry()
      await page.mouse.move(width - 60, 500)
      await page.mouse.wheel(0, 3000)
      await page.waitForTimeout(250)
      const afterWheel = await geometry()
      writeFileSync(
        join(output, `${tab}-${width}-scroll-observation.json`),
        JSON.stringify({ before, afterWheel }, null, 2)
      )
      await page.screenshot({ path: join(output, `${tab}-${width}-after-wheel.png`) })
      assert(
        afterWheel.ancestors[0].bottom <= 650 && afterWheel.ancestors[0].top >= 0,
        "Wheel must reveal bottom action " + tab + " " + width
      )
      await region.focus()
      await page.keyboard.press("Home")
      await page.keyboard.press("Control+Home")
      await page.keyboard.press("End")
      await page.keyboard.press("Control+End")
      await page.waitForTimeout(250)
      const afterKeyboard = await geometry()
      assert(
        afterKeyboard.ancestors[0].bottom <= 650 && afterKeyboard.ancestors[0].top >= 0,
        "Keyboard must reveal action " + tab + " " + width
      )
      await page.screenshot({ path: join(output, tab + "-" + width + "-layout.png") })
      await button.click({ trial: true, timeout: 1800 })
      result[tab + "-" + width] = {
        css,
        before,
        afterWheel,
        afterKeyboard,
        clickResult: "trial click succeeded without invoking the action",
        afterTrial: await geometry()
      }
      const advanced = page.getByRole("button", { name: "基础功能", exact: true })
      if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.click()
      await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "插件", exact: true }).click()
      await page.getByText("installed-management", { exact: true }).waitFor()
      assert.equal(await page.getByText("creator-tools", { exact: true }).count(), 0)
      if (tab === "claw") {
        await page.getByRole("button", { name: "搭配管理", exact: true }).click()
        assert.equal(await page.getByLabel("助手组合名称", { exact: true }).inputValue(), draft,
          "Switching settings tabs must retain the unsaved combination draft")
      }
      await page.close()
    }
  assert.deepEqual(errors, [])
  writeFileSync(join(output, "layout-result.json"), JSON.stringify({ result, errors }, null, 2))
  console.log(JSON.stringify({ output, errors, scenarios: Object.keys(result) }))
} finally {
  await browser.close()
}
