/** Actual React/default and Bot-custom components; preload reads/events are controlled fixture seams. */
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const root = resolve(import.meta.dirname, ".."),
    output = join(root, "output/mods-workspace-scope")
  await mkdir(output, { recursive: true })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
import React,{useMemo,useState}from'react';import{createRoot}from'react-dom/client';
import{useModCommands}from'./src/renderer/src/features/slash-commands/useModCommands';
import{useFunctionTurnNotices}from'./src/renderer/src/lib/use-function-turn-notices';
import{createModsThreadScope,modsWorkspaceKey,provideModsThreadScope}from'./src/renderer/src/lib/mods-thread-scope';
import{ModCards}from'./src/renderer/src/components/chat/ModCards';import{ModCommandJobs}from'./src/renderer/src/components/chat/ModCommandJobs';import{FunctionPanes}from'./src/renderer/src/components/chat/FunctionPanes';
window.fixtureCalls=[];window.fixtureHolds=new Set;window.fixtureDeferred=[];window.fixtureCardsListeners=new Set;window.fixtureJobsListeners=new Set;window.fixtureCustomListeners=new Set;window.fixtureInvalidReads=0;window.fixtureLabel='none';window.fixtureHasWorkspace=false;
const descriptor=label=>({apiVersion:'cmb.mods/v2',turnId:label,modId:'mod',name:label,command:'inspect',digest:label,grantEpoch:1,workspaceEpoch:1});
const pane=label=>({key:label,id:label,plugin:'fixture',title:'Pane '+label,generation:label,closeOnEscape:true,rows:8,tree:{type:'Button',props:{key:'act',label:'Act pane '+label},press:{plugin:'fixture',handle:1}}});
function result(method,label){if(method==='commands')return[descriptor(label)];if(method==='turnNotices')return[{id:label,turnId:label,text:'Notice '+label}];if(method==='panes'||method==='customPanes')return[pane(label)];if(method==='cards')return[...Array.from({length:20},(_,i)=>({id:label+'-'+i,agentId:'agent',modId:'mod',name:label,threadId:'thread',callId:'tool-'+i,nodes:[{type:'text',text:'Card '+label+' '+i},{type:'button',label:'Run card '+i,command:'inspect',args:{},actionId:label+'-'+i}]})),{id:label+'-summary',agentId:'agent',modId:'mod',name:label,threadId:'thread',callId:label,slot:'turn.summary',nodes:[{type:'text',text:'Summary '+label}]}];if(method==='jobs')return[{id:label,threadId:'thread',workspace:label,command:'Job '+label,state:'queued',createdAt:1}];if(method==='act')return{text:'Action '+label};if(method==='artifact')return{label,text:'Artifact '+label};if(method==='saveArtifact')return true;return undefined}
function call(method,input,custom=false){const label=custom?'Bot custom':window.fixtureLabel;window.fixtureCalls.push({method,input,label});if(!custom&&!window.fixtureHasWorkspace){window.fixtureInvalidReads++;return Promise.reject(new Error('MODS_WORKSPACE_REQUIRED'))}if(window.fixtureHolds.has(method))return new Promise((resolve,reject)=>window.fixtureDeferred.push({method,label,resolve:()=>resolve(result(method,label)),reject:()=>reject(new Error('late '+label))}));return Promise.resolve(result(method,label))}
const subscribe=set=>callback=>{set.add(callback);return()=>set.delete(callback)};
window.api={mods:{...Object.fromEntries(['commands','turnNotices','cards','jobs','panes','enqueue','paneAct','clientAct','act','artifact','saveArtifact','cancelJob'].map(method=>[method,(...input)=>call(method,input)])),onCardsChanged:subscribe(window.fixtureCardsListeners),onJobsChanged:subscribe(window.fixtureJobsListeners)}};window.electron={process:{platform:'darwin'},openExternal:()=>{}};
const customTransport={panes:(...input)=>call('customPanes',input,true),paneAct:(...input)=>call('customAct',input,true),clientAct:()=>Promise.resolve(),onCardsChanged:subscribe(window.fixtureCustomListeners)};
window.fixtureDispatch=()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('mods:configuration-changed'));for(const cb of [...window.fixtureCardsListeners])cb({threadId:'thread'});for(const cb of [...window.fixtureJobsListeners])cb({threadId:'thread'})};
window.fixtureRelease=(method,reject=false)=>{const chosen=window.fixtureDeferred.filter(item=>!method||item.method===method);window.fixtureDeferred=window.fixtureDeferred.filter(item=>!chosen.includes(item));for(const item of chosen)(reject?item.reject:item.resolve)()};
function Fixture(){const[workspace,setWorkspace]=useState(null),[label,setLabel]=useState('none'),[visible,setVisible]=useState(true),[custom,setCustom]=useState(false),[disabled,setDisabled]=useState(false),[draft,setDraft]=useState('keep draft'),[feedback,setFeedback]=useState('');const workspaceKey=modsWorkspaceKey(workspace),scope=useMemo(()=>createModsThreadScope('thread',workspaceKey),[workspaceKey]);window.fixtureHasWorkspace=!!workspaceKey;window.fixtureLabel=label;window.fixtureChange=(path,label)=>{setWorkspace(path);setLabel(label)};window.fixtureVisible=setVisible;window.fixtureCustom=setCustom;window.fixtureDisabled=setDisabled;window.fixtureDraft=setDraft;const commands=useModCommands('thread',visible?scope:null),notices=useFunctionTurnNotices('thread',visible?scope:null);window.fixtureHook=commands;
window.fixtureSubmit=async()=>{const current=commands;try{const handled=await current.submit('/inspect test');if(!current.isCurrent())return;if(handled){setDraft('');setFeedback('handled')}}catch(error){if(current.isCurrent())setFeedback(String(error))}};
return provideModsThreadScope(visible?scope:null,<main><input aria-label='draft' value={draft} onChange={e=>setDraft(e.target.value)}/><p data-feedback>{feedback}</p><div data-commands>{commands.items.map(item=><span key={item.id}>{item.title}</span>)}</div><div data-notices>{notices.map(item=><p key={item.id}>{item.text}</p>)}</div>{visible&&<><ModCards threadId='thread' slot='turn.summary'/>{Array.from({length:20},(_,i)=><ModCards key={i} threadId='thread' callId={'tool-'+i}/>)}<ModCommandJobs threadId='thread'/><FunctionPanes threadId='thread'/></>}{custom&&<section data-custom><FunctionPanes threadId='bot:custom' transport={customTransport} disabled={disabled}/></section>}</main>)}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const count = (method: string) =>
    page.evaluate(
      (value) => window.fixtureCalls.filter((item) => item.method === value).length,
      method
    )
  const change = async (workspace: string | null, label: string) => {
    await page.evaluate(({ workspace, label }) => window.fixtureChange(workspace, label), {
      workspace,
      label
    })
    await page.waitForFunction((value) => window.fixtureLabel === value, label)
  }
  try {
    await page.route("http://127.0.0.1:43129/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><div id='root'></div><script>${bundle.outputFiles[0].text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43129/")
    await page.getByRole("textbox", { name: "draft" }).waitFor()
    await page.evaluate(() => window.fixtureDispatch())
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.fixtureCalls.length), 0)
    assert.equal(await page.evaluate(() => window.fixtureInvalidReads), 0)
    assert.equal(
      await page.evaluate(
        () => window.fixtureCardsListeners.size + window.fixtureJobsListeners.size
      ),
      0
    )
    await change("/a", "A1")
    await page.getByText("Summary A1", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Act pane A1", exact: true }).waitFor()
    assert.equal(await count("cards"), 1)
    assert.equal(await page.locator("[data-mod-cards]").count(), 21)
    await page.evaluate(() => {
      window.fixtureHolds.add("commands")
      window.fixtureHolds.add("turnNotices")
      window.fixtureHolds.add("panes")
      window.fixtureHolds.add("cards")
      window.fixtureHolds.add("jobs")
    })
    await change("/b", "B2")
    await page.waitForFunction(() => window.fixtureDeferred.length === 5)
    assert.equal(await page.getByText("Summary A1", { exact: true }).count(), 0)
    await change(null, "removed")
    await page.waitForFunction(
      () => window.fixtureCardsListeners.size + window.fixtureJobsListeners.size === 0
    )
    const removedCalls = await page.evaluate(() => window.fixtureCalls.length)
    await page.evaluate(() => {
      window.fixtureDispatch()
      window.fixtureRelease()
      window.fixtureHolds.clear()
    })
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.fixtureCalls.length), removedCalls)
    assert.equal(
      await page.locator("[data-mod-cards],[data-function-panes],[data-mod-jobs]").count(),
      0
    )
    assert.equal(await page.locator("[data-commands]").textContent(), "")
    assert.equal(await page.locator("[data-notices]").textContent(), "")
    await page.evaluate(() =>
      ["commands", "turnNotices", "panes", "cards", "jobs"].forEach((method) =>
        window.fixtureHolds.add(method)
      )
    )
    await change("/a", "A3")
    await page.waitForFunction(() => window.fixtureDeferred.length === 5)
    await page.evaluate(() => window.fixtureHolds.clear())
    await change("/b", "B4")
    await page.getByText("Summary B4", { exact: true }).waitFor()
    await change("/a", "A5")
    await page.getByText("Summary A5", { exact: true }).waitFor()
    await page.evaluate(() => window.fixtureRelease())
    await page.waitForTimeout(50)
    assert.equal(await page.getByText("Summary A3", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Summary A5", { exact: true }).count(), 1)
    assert.equal(await page.locator("[data-notices]").textContent(), "Notice A5")
    await page.evaluate(() => window.fixtureHolds.add("commands"))
    const enqueuesBefore = await count("enqueue")
    const submission = page.evaluate(() => window.fixtureSubmit())
    await page.waitForFunction(() =>
      window.fixtureDeferred.some((item) => item.method === "commands")
    )
    await page.evaluate(() => window.fixtureHolds.delete("commands"))
    await change("/b", "B6")
    await page.getByRole("textbox", { name: "draft" }).fill("new workspace draft")
    await page.evaluate(() => window.fixtureRelease("commands"))
    await submission
    assert.equal(await count("enqueue"), enqueuesBefore)
    assert.equal(
      await page.getByRole("textbox", { name: "draft" }).inputValue(),
      "new workspace draft"
    )
    assert.equal(await page.locator("[data-feedback]").textContent(), "")
    await page.evaluate(() => window.fixtureHolds.add("enqueue"))
    const submitted = page.evaluate(() =>
      Promise.all([window.fixtureSubmit(), window.fixtureSubmit()])
    )
    await page.waitForFunction(
      () => window.fixtureDeferred.filter((item) => item.method === "enqueue").length === 1
    )
    assert.equal(await count("enqueue"), enqueuesBefore + 1)
    await page.evaluate(() => {
      window.fixtureHolds.delete("enqueue")
      window.fixtureRelease("enqueue")
    })
    await submitted
    assert.equal(await page.locator("[data-feedback]").textContent(), "handled")
    await page.getByRole("textbox", { name: "draft" }).fill("preserved after pane stop")
    await page.evaluate(() => window.fixtureHolds.add("paneAct"))
    await page.getByRole("button", { name: "Act pane B6", exact: true }).click()
    await page.waitForFunction(() =>
      window.fixtureDeferred.some((item) => item.method === "paneAct")
    )
    await change(null, "no pane")
    await page.waitForFunction(
      () => window.fixtureCardsListeners.size + window.fixtureJobsListeners.size === 0
    )
    const paneReads = await count("panes")
    await page.evaluate(() => {
      window.fixtureHolds.delete("paneAct")
      window.fixtureRelease("paneAct")
    })
    await page.waitForTimeout(50)
    assert.equal(await count("panes"), paneReads)
    assert.equal(
      await page.getByRole("textbox", { name: "draft" }).inputValue(),
      "preserved after pane stop"
    )
    await page.evaluate(() => window.fixtureCustom(true))
    await page.getByRole("button", { name: "Act pane Bot custom", exact: true }).waitFor()
    assert.equal(await count("customPanes"), 1)
    assert.equal(await page.evaluate(() => window.fixtureInvalidReads), 0)
    await page.getByRole("button", { name: "Act pane Bot custom", exact: true }).click()
    await page.waitForFunction(
      () => window.fixtureCalls.filter((item) => item.method === "customAct").length === 1
    )
    await page.waitForFunction(
      () => window.fixtureCalls.filter((item) => item.method === "customPanes").length === 2
    )
    await page.evaluate(() => window.fixtureDisabled(true))
    await page.waitForFunction(() => document.querySelector("[data-custom] button")?.disabled)
    await page.evaluate(() => window.fixtureCustom(false))
    await page.waitForFunction(() => window.fixtureCustomListeners.size === 0)
    await change("/a", "A7")
    await page.getByText("Summary A7", { exact: true }).waitFor()
    await page.evaluate(() => window.fixtureHolds.add("cancelJob"))
    await page.getByRole("button", { name: "取消排队", exact: true }).click()
    await page.waitForFunction(() =>
      window.fixtureDeferred.some((item) => item.method === "cancelJob")
    )
    await change("/b", "B8")
    await page.getByText("Summary B8", { exact: true }).waitFor()
    await page.evaluate(() => {
      window.fixtureHolds.delete("cancelJob")
      window.fixtureRelease("cancelJob", true)
    })
    await page.waitForTimeout(50)
    assert.equal(await page.getByText("late A7", { exact: true }).count(), 0)
    await page.evaluate(() => window.fixtureVisible(false))
    await page.waitForFunction(
      () => window.fixtureCardsListeners.size + window.fixtureJobsListeners.size === 0
    )
    const unmountedCalls = await page.evaluate(() => window.fixtureCalls.length)
    await page.evaluate(() => window.fixtureDispatch())
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.fixtureCalls.length), unmountedCalls)
    assert.deepEqual(errors, [])
    const evidence = {
      pass: true,
      journeys: [
        "no-workspace-no-IPC",
        "shared-20-cards-one-fetch",
        "scope-removed-deferred",
        "A-B-A-owner",
        "superseded-command-draft",
        "double-submit-one-enqueue",
        "late-pane-completion-no-read",
        "Bot-custom-transport-no-Thread",
        "disabled-custom-actions",
        "late-job-error-retired",
        "unmount-listener-cleanup"
      ],
      actual: "React/hooks/cards-cache/default and custom panes",
      seams: "preload reads/events/action results are controlled fixtures",
      invalidReads: await page.evaluate(() => window.fixtureInvalidReads),
      errors: errors.length
    }
    await writeFile(join(output, "result.json"), JSON.stringify(evidence, null, 2))
    process.stdout.write(JSON.stringify(evidence) + "\n")
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + "\n")
  process.exitCode = 1
})
