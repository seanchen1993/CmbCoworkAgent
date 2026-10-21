import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
const output = resolve("output/native-plugin-import-20261013", `workspace-regression-${Date.now()}`),
  root = process.cwd()
mkdirSync(output, { recursive: true })
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ModsPanel}from${JSON.stringify(resolve("src/renderer/src/components/customize/ModsPanel.tsx"))};
const calls=[],listeners=new Set();let workspace='C:/isolated/A',grant=null,finish=null,hold=false;
window.api={featureGates:{isEnabled:async()=>({enabled:true})},plugins:{list:async()=>[{id:'pkg',name:'Installed',enabled:true,modCount:1}]},mods:{communityExamples:{list:async()=>({examples:[]})},
globalEnabled:async()=>true,status:async()=>{const captured=workspace;calls.push(['status',workspace]);if(hold){hold=false;await new Promise(resolve=>finish=resolve)}return{workspace:captured,enabled:true,outputPolicy:false,mods:[],diagnostics:[],functionMods:[{pluginId:'pkg',name:'Installed',digest:'a'.repeat(64),state:grant===workspace?'ready':'needs-approval',capabilities:[]}] }},
onConfigurationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
approveFunction:async(...args)=>{calls.push(['approveFunction',args,{hostResolvedWorkspace:workspace}]);if(args[3]!==undefined&&args[3]!==workspace)throw Error('MODS_APPROVAL_SCOPE_CHANGED');grant=workspace;for(const fn of listeners)fn()},
completionPolicy:async()=>({source:'default',policy:{mode:'off',scope:'project',checks:[],maxRepairs:0,timeoutMs:60000,modelTokenBudget:8192}})}};
function Fixture(){const[hint,setHint]=useState(workspace);window.probe={calls,completeWorktree:()=>{workspace='C:/isolated/B';setHint(workspace)},grant:()=>grant,lateRead:()=>{hold=true;for(const fn of listeners)fn()},finish:()=>finish()};return <ModsPanel threadId='empty-thread' workspaceHint={hint} developmentAllowed={false}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);`
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@": resolve("src/renderer/src") },
  loader: { ".md": "text", ".png": "dataurl" },
  plugins: [
    {
      name: "store",
      setup(b) {
        // Only installed settings are exercised; no authoring editor is opened in this fixture.
        b.onResolve({filter:/^\.\/ModCreator$/},args=>args.importer.endsWith('ModsPanel.tsx')?{path:'creator',namespace:'unused-creator'}:undefined)
        b.onLoad({filter:/.*/,namespace:'unused-creator'},()=>({contents:'export const ModCreator=()=>null'}))
        b.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, args =>
          args.path === "@/lib/store" || args.importer.replaceAll("\\", "/").includes("/src/renderer/src/lib/")
            ? { path: "store", namespace: "fixture" } : undefined)
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "const state={accountRevision:0,bumpPluginVersion:()=>{},setShowCustomizeView:()=>{}};export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false"
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } }),
    errors = []
  page.setDefaultTimeout(5000)
  page.on("pageerror", (e) => { errors.push(e.message); console.error("Browser error:", e.message) })
  await page.route("**/*", (r) => r.abort())
  await page.route("http://localhost/workspace-fixture", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }))
  await page.goto("http://localhost/workspace-fixture")
  const dir = resolve("out/renderer/assets"),
    css = readdirSync(dir).find((n) => /^index-.*\.css$/.test(n))
  await page.addStyleTag({ path: join(dir, css) })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole("button", { name: "我已添加", exact: true }).click()
  await page.getByLabel("灵件设置", { exact: true }).getByText("当前项目：C:/isolated/A", { exact: true }).waitFor()
  await page.evaluate(() => window.probe.lateRead())
  await page.evaluate(() => window.probe.completeWorktree())
  await page.waitForTimeout(100)
  await page.getByLabel("灵件设置", { exact: true }).getByText("当前项目：C:/isolated/B", { exact: true }).waitFor()
  await page.evaluate(() => window.probe.finish())
  await page.waitForTimeout(100)
  assert.equal(await page.getByRole("button", { name: "我已添加", exact: true }).getAttribute("aria-pressed"), "true")
  assert.equal(
    await page.getByRole("button", { name: "开启创作并返回聊天", exact: true }).count(),
    0
  )
  const displayedBefore = await page.getByLabel("灵件设置", { exact: true }).getByText(/^当前项目：/).innerText()
  const callsBefore = await page.evaluate(() => window.probe.calls.slice())
  await page.getByRole("button", { name: "授权以上能力", exact: true }).click()
  await page.getByLabel("灵件设置", { exact: true }).getByText("当前项目：C:/isolated/B", { exact: true }).waitFor()
  const result = {
    errors,
    displayedBefore,
    callsBefore,
    calls: await page.evaluate(() => window.probe.calls),
    grant: await page.evaluate(() => window.probe.grant())
  }
  assert.equal(displayedBefore, "当前项目：C:/isolated/B")
  assert.equal(result.calls.find((row) => row[0] === "approveFunction")[1][3], "C:/isolated/B")
  assert.equal(result.calls.filter((row) => row[0] === "status").length >= 3, true)
  assert.deepEqual(errors, [])
  writeFileSync(join(output, "workspace-settings-result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  await page.screenshot({ path: join(output, "workspace-settings-after.png"), fullPage: true })
} finally {
  await browser.close()
}




