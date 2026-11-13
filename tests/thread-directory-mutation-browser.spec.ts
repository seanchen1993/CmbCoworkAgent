/** Actual Zustand store and actual ThreadProvider; controlled IPC delivery only. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { bootstrap } from "./thread-history-revisit-browser.spec"
// @ts-expect-error Existing executable ESM fixture.
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const root = resolve(__dirname, "..")
const controls = `
window.fixture.heldOnce=true
window.fixture.host={...window.fixture.thread, created_at:new Date(1),updated_at:new Date(1),
  metadata:{model:"custom:a",cmb_thread_incarnation:"original"}}
window.fixture.hostMessages=[{id:"original-message",role:"user",content:"original body",created_at:new Date(1000),ordinal:0}]
window.fixture.updateCalls=0
window.fixture.extraHost={}
window.fixture.extraMessages={}
window.fixture.heldPages=[]
window.fixture.readThread=id=>structuredClone(id===window.fixture.host?.thread_id
  ? window.fixture.host : window.fixture.extraHost[id]??null)
window.api.threads.listPage=async()=>({threads:[structuredClone(window.fixture.host),
  ...Object.values(window.fixture.extraHost).map(row=>structuredClone(row))],hasMore:false,
  beforeThreadId:null,beforeUpdatedAt:null})
window.api.threads.getMessagesPage=async id=>{
  window.fixture.pageReads.push({id,older:false})
  const row=window.fixture.readThread(id)
  if(!row) throw new Error("Error invoking remote method 'threads:messages-page': Error: MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
  const messages=id===window.fixture.host.thread_id ? window.fixture.hostMessages : window.fixture.extraMessages[id]??[]
  const page={messages:structuredClone(messages),hasMore:false,
    beforeOrdinal:null,beforeMessageId:null,total:messages.length,
    hasVisibleMessages:messages.length>0,
    legacyCheckpointMigrationStatus:"complete",legacyMessageTimesPending:false,
    sourceScope:{threadId:id,incarnation:{token:row.metadata.cmb_thread_incarnation,
      legacyCreatedAt:row.created_at.getTime()},
      ...(row.metadata.workspacePath ? {workspacePath:row.metadata.workspacePath} : {})}}
  if(window.fixture.holdNextPage){
    window.fixture.holdNextPage=false
    return new Promise((resolve,reject)=>window.fixture.heldPages.push({resolve:()=>resolve(page),
      reject:()=>reject(new Error("Error invoking remote method 'threads:messages-page': Error: MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"))}))
  }
  return page
}
for(const method of ["update","patchMetadata"]) {
  window.api.threads[method]=async(_id,input)=>{
    if(method==="update") window.fixture.updateCalls++
    const original=structuredClone(window.fixture.host)
    if(window.fixture.holdWrite) {
      window.fixture.holdWrite=false
      return new Promise(resolve=>{window.fixture.releaseWrite=()=>resolve({...original,
        title:"OLD-REPLY",updated_at:new Date(99)})})
    }
    window.fixture.host=method==="update" ? {...original,...input,updated_at:new Date(100)} : {
      ...original,metadata:{...original.metadata,...input.set},updated_at:new Date(100)}
    return structuredClone(window.fixture.host)
  }
}
window.api.threads.generateTitle=async()=>new Promise(resolve=>{
  window.fixture.releaseTitle=()=>resolve("OLD-GENERATED-TITLE")
})
const readThread=window.api.threads.get
window.api.threads.get=async id=>{
  const thread=await readThread(id)
  if(id==="cold-stage" && window.fixture.holdCold){
    window.fixture.holdCold=false
    return new Promise(resolve=>{window.fixture.releaseCold=()=>resolve(thread)})
  }
  return thread
}
`
const entry = `
import React from "react"
import {createRoot} from "react-dom/client"
import {ThreadProvider,useCurrentThread,useThreadStream} from "@/lib/thread-context"
import {useAppStore,isThreadDeletionPending} from "@/lib/store"
import {navigateProjectThread} from "@/components/harness-board/project-thread-navigation"
// No store alias: every mutation and directory merge below uses store.ts.
useAppStore.setState({threads:[structuredClone(window.fixture.host)],currentThreadId:"intent-a",
  models:window.fixture.models,accountRevision:0})
function Probe(){
  const id=useAppStore(state=>state.currentThreadId)??"intent-a"
  const thread=useCurrentThread(id)
  const view=useThreadStream(id)
  const directory=useAppStore(state=>state.threads)
  const summary=directory.find(row=>row.thread_id===id)
  window.fixture.inspect=()=>({id,messages:thread.messages.map(m=>m.id),draft:thread.draftInput,
    loading:thread.historyLoading,
    ready:!thread.historyLoading && thread.subagentTranscriptBaselineReady && !!view.stream,
    token:summary?.metadata?.cmb_thread_incarnation,hostProject:summary?.metadata?.hostProjectRuntime,
    title:summary?.title,pageReads:window.fixture.pageReads.length,
    updateCalls:window.fixture.updateCalls})
  window.fixture.setDraft=value=>thread.setDraftInput(value)
  window.fixture.beginWrite=method=>{
    window.fixture.holdWrite=true
    window.fixture.writing=method==="update"
      ? useAppStore.getState().updateThread("intent-a",{title:"old pending title"})
      : useAppStore.getState().patchThreadMetadata("intent-a",{set:{model:"old-model"}})
  }
  window.fixture.replace=async(token,id)=>{
    window.fixture.host={...window.fixture.host,updated_at:new Date(Date.now()),
      metadata:{...window.fixture.host.metadata,cmb_thread_incarnation:token}}
    window.fixture.hostMessages=[{id,role:"user",content:token+" body",created_at:new Date(2000),ordinal:0}]
    await useAppStore.getState().loadThreads()
  }
  window.fixture.beginTitle=()=>{
    window.fixture.generating=useAppStore.getState().generateTitleForFirstMessage("intent-a","old prompt")
  }
  window.fixture.workspace=()=>useAppStore.getState().patchThreadMetadata("intent-a",{set:{workspacePath:"C:/new"}})
  window.fixture.beginCold=()=>{
    const target={threadId:"cold-stage",projectId:"cold-project",operationId:"cold-op",stageId:"review",
      pluginDigest:"cold-digest",workspace:"C:/cold-project"}
    window.fixture.extraHost[target.threadId]={...window.fixture.host,thread_id:target.threadId,
      metadata:{model:"custom:a",cmb_thread_incarnation:"cold-owner",workspacePath:target.workspace,
        hostProjectRuntime:{projectId:target.projectId,operationId:target.operationId,
          stageId:target.stageId,pluginDigest:target.pluginDigest}}}
    window.fixture.extraMessages[target.threadId]=[{id:"cold-history",role:"user",
      content:"original unloaded stage",created_at:new Date(3000),ordinal:0}]
    const publisher=useAppStore.getState().captureThreadSummaryRead(target.threadId)
    window.fixture.holdCold=true
    window.fixture.coldNavigating=(async()=>{
      try{
        if(!publisher.isCurrent())return
        await navigateProjectThread(target,{read:id=>window.api.threads.get(id),isCurrent:()=>true,
          isRetired:isThreadDeletionPending,add:row=>publisher.publish(row),
          select:id=>useAppStore.getState().selectThread(id)})
      }finally{publisher.close()}
    })()
  }
  window.fixture.touchOther=()=>useAppStore.getState().touchThreadSummaries(["intent-a"],new Date(200))
  window.fixture.beginMissing=()=>{
    const target={messageId:thread.messages[0].id,ordinal:0}
    window.fixture.holdNextPage=true
    window.fixture.oldMissing=thread.loadMessageWindowAround(target)
    window.fixture.holdNextPage=true
    window.fixture.currentMissing=thread.loadMessageWindowAround(target)
  }
  window.fixture.removeSource=()=>{
    window.fixture.savedHost=window.fixture.host
    window.fixture.host=null
    window.fixture.heldPages[1].reject()
  }
  window.fixture.restoreSource=async()=>{
    window.fixture.host={...window.fixture.savedHost,updated_at:new Date(Date.now()),
      metadata:{...window.fixture.savedHost.metadata,cmb_thread_incarnation:"recovered-owner"}}
    window.fixture.hostMessages=[{id:"recovered-history",role:"user",content:"new owner after source was missing",
      created_at:new Date(2500),ordinal:0}]
    await useAppStore.getState().loadThreads()
  }
  window.fixture.abortHeld=()=>window.fixture.heldPages.forEach(page=>page.reject())
  return <main>{thread.messages.map(m=><p key={m.id}>{m.content}</p>)}</main>
}
const app=createRoot(document.getElementById("app"))
window.fixture.unmount=()=>app.unmount()
app.render(<ThreadProvider><Probe/></ThreadProvider>)
`

export async function runThreadDirectoryMutationBrowser() {
  const artifacts = join(root, "output/thread-directory-mutation-browser", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const built = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true, jsx: "automatic", write: false, platform: "browser", format: "iife", target: "es2022",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" },
    plugins: [browserWorkerPlugin()] })
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<div id="app"></div>') })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  const errors: string[] = [], evidence: Record<string, unknown> = {}
  page.on("pageerror", error => errors.push(error.message))
  const run = async <T = unknown>(source: string): Promise<T> => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([page.evaluate<T>(source), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(Error("Fixture evaluate did not finish: " + source.slice(0, 100))), 10_000)
    })]) } finally { clearTimeout(deadline) }
  }
  const inspect = () => run<{ messages: string[]; draft: string; pageReads: number;
    token: string; title: string; updateCalls: number }>("window.fixture.inspect()")
  try {
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({ content: bootstrap + controls })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction("window.fixture.inspect && window.fixture.inspect().ready")
    for (const method of ["update", "patchMetadata"]) {
      await run(`window.fixture.beginWrite(${JSON.stringify(method)})`)
      await page.waitForFunction("!!window.fixture.releaseWrite")
      const token = method + "-replacement", messageId = method + "-new-message"
      await run(`window.fixture.replace(${JSON.stringify(token)},${JSON.stringify(messageId)})`)
      await page.waitForFunction(id => window.fixture.inspect().messages.includes(id), messageId)
      await page.waitForFunction("window.fixture.inspect().ready")
      await run(`window.fixture.setDraft(${JSON.stringify(token + " draft")})`)
      await page.waitForFunction(`window.fixture.inspect().draft === ${JSON.stringify(token + " draft")}`)
      const before = await inspect()
      await run("window.fixture.releaseWrite(); window.fixture.releaseWrite=null; window.fixture.writing")
      await page.waitForTimeout(30)
      const after = await inspect()
      assert.equal(after.token, token)
      assert.deepEqual(after.messages, [messageId])
      assert.equal(after.draft, before.draft, "Old mutation reply must not reset the new draft")
      assert.equal(after.pageReads, before.pageReads, "Rejected old reply must not restart history hydration")
      assert.notEqual(after.title, "OLD-REPLY")
      evidence[method] = { before, after }
    }
    await run("window.fixture.beginTitle()")
    await page.waitForFunction("!!window.fixture.releaseTitle")
    await run('window.fixture.replace("title-replacement","title-new-message")')
    await page.waitForFunction('window.fixture.inspect().messages.join() === "title-new-message" && window.fixture.inspect().ready')
    await run('window.fixture.setDraft("title owner draft")')
    await page.waitForFunction('window.fixture.inspect().draft === "title owner draft"')
    const beforeTitle = await inspect()
    await run("window.fixture.releaseTitle(); window.fixture.generating")
    const afterTitle = await inspect()
    assert.equal(afterTitle.updateCalls, beforeTitle.updateCalls, "Stale title generation must not start a new update")
    assert.equal(afterTitle.draft, beforeTitle.draft)
    assert.equal(afterTitle.pageReads, beforeTitle.pageReads)
    evidence.title = { before: beforeTitle, after: afterTitle }
    await run("window.fixture.workspace()")
    await page.waitForTimeout(30)
    const sameIncarnation = await inspect()
    assert.deepEqual(sameIncarnation.messages, afterTitle.messages)
    assert.equal(sameIncarnation.draft, afterTitle.draft)
    assert.equal(sameIncarnation.pageReads, afterTitle.pageReads)
    evidence.sameIncarnation = sameIncarnation
    await run("window.fixture.beginMissing()")
    await page.waitForFunction("window.fixture.heldPages.length === 2")
    await run("window.fixture.removeSource(); window.fixture.currentMissing")
    await page.waitForFunction('window.fixture.inspect().id === "intent-a" && window.fixture.inspect().messages.length === 0')
    const missing = await inspect()
    evidence.missingSourceCleared = missing
    await run("window.fixture.restoreSource()")
    await page.waitForFunction('window.fixture.inspect().token === "recovered-owner"')
    evidence.afterActualDirectoryRestore = await inspect()
    await page.waitForFunction('window.fixture.inspect().id === "intent-a" && window.fixture.inspect().ready && window.fixture.inspect().messages.join() === "recovered-history"')
    const recovered = await inspect()
    assert.equal(recovered.pageReads, missing.pageReads + 1,
      "A selected missing source must hydrate once after an actual new incarnation arrives")
    await run("window.fixture.heldPages[0].reject(); window.fixture.oldMissing")
    assert.deepEqual((await inspect()).messages, ["recovered-history"],
      "A late old source rejection must not clear the recovered owner")
    evidence.missingRecovery = { missing, recovered }
    await run("window.fixture.beginCold()")
    await page.waitForFunction("!!window.fixture.releaseCold")
    await run("window.fixture.touchOther()")
    await run("window.fixture.releaseCold(); window.fixture.coldNavigating")
    await page.waitForFunction('window.fixture.inspect().id === "cold-stage" && window.fixture.inspect().ready')
    const cold = await run<{ messages: string[]; token: string; pageReads: number;
      hostProject: { projectId: string } }>("window.fixture.inspect()")
    assert.deepEqual(cold.messages, ["cold-history"])
    assert.equal(cold.token, "cold-owner")
    assert.equal(cold.hostProject.projectId, "cold-project")
    assert.equal(cold.pageReads, recovered.pageReads + 1)
    evidence.coldNavigation = cold
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(join(artifacts, "report.json"), JSON.stringify({ evidence, errors }, null, 2) + "\n")
    await run("window.fixture?.abortHeld?.(); window.fixture?.unmount?.()").catch(() => {})
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
    console.log(artifacts)
  }
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  runThreadDirectoryMutationBrowser().catch(error => { console.error(error); process.exitCode = 1 })
}
