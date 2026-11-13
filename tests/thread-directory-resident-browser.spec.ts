/** Actual ThreadProvider: source-bound resident history and lossless directory invalidations. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { bootstrap, storeModule } from "./thread-history-revisit-browser.spec"
// @ts-expect-error Existing executable ESM fixture.
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const root = resolve(__dirname, "..")
const controls = `
window.fixture.heldOnce = true
window.fixture.thread.metadata.cmb_thread_incarnation = "original"
window.fixture.rows = [0,1,2,3].map(index => ({ id: "message-"+index,
  role: index%2 ? "assistant" : "user", content: "original "+index,
  created_at: new Date(1000+index), ordinal:index }))
window.fixture.unbinds = 0
window.fixture.cancels = 0
window.fixture.streamNotifications = 0
window.fixture.hookNotifications = 0
window.api.agent.unbindCoordinatorWorkers = async () => { window.fixture.unbinds++ }
window.api.agent.cancel = async () => { window.fixture.cancels++ }
window.api.agent.getCoordinatorWorkers = async id => {
  if (id === "intent-a" && window.fixture.holdNextWorker) {
    window.fixture.holdNextWorker = false
    return new Promise(resolve => { window.fixture.releaseWorker = () => resolve([
      {worker_id:"OLD-WORKER",status:"completed",task:"old private task"}]) })
  }
  return []
}
window.api.threads.getGoalState = async (_id, options) => {
  if (window.fixture.holdNextGoal && options?.includeEvents !== false) {
    window.fixture.holdNextGoal = false
    return new Promise(resolve => { window.fixture.releaseGoal = () => resolve({
      goal:{id:"OLD-GOAL",status:"active"},events:[] }) })
  }
  return {goal:null,events:[]}
}
window.api.threads.replaceMessageId = async () => new Promise(resolve => {
  window.fixture.releaseAlias = () => resolve({replaced:true})
})
window.fixture.source = id => {
  const row = window.fixture.readThread(id)
  return row ? { threadId:id, incarnation: {
    token: row.metadata?.cmb_thread_incarnation ?? null,
    legacyCreatedAt: new Date(row.created_at).getTime() },
    ...(row.metadata?.workspacePath ? { workspacePath:row.metadata.workspacePath } : {}) } : undefined
}
window.fixture.hint = (id, kind="transcript") => {
  window.fixture.emitDirectory({ ...window.fixture.source(id), kind,
    workspacePath: window.fixture.source(id)?.workspacePath ?? "C:/fixture" })
}
window.fixture.pageOverride = (id, options) => {
  if(window.fixture.pageReads.length > 30) return new Promise(()=>{})
  if(!window.fixture.readThread(id)) throw new Error(
    "Error invoking remote method 'threads:messages-page': Error: MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
  const rows = structuredClone(id === "intent-a" ? window.fixture.rows : [])
  const selected = options?.beforeMessageId ? rows.slice(0,2) : options?.targetMessageId ? rows : rows.slice(-2)
  const scope = window.fixture.legacy ? undefined : window.fixture.source(id)
  const page = { messages:selected, sourceScope:scope, total:rows.length,
    beforeOrdinal:selected[0]?.ordinal ?? null, beforeMessageId:selected[0]?.id ?? null,
    hasMore: !options?.beforeMessageId && rows.length > selected.length,
    hasVisibleMessages:rows.length > 0, legacyCheckpointMigrationStatus:"complete",
    legacyMessageTimesPending:false }
  if (options?.targetMessageId && window.fixture.holdNextTarget) {
    window.fixture.holdNextTarget = false
    return new Promise((resolve,reject) => {
      window.fixture.releasePage = () => resolve(page)
      window.fixture.rejectHeldPage = () => reject(new Error(
        "Error invoking remote method 'threads:messages-page': Error: MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"))
    })
  }
  return page
}
`
const entry = `
import React, { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { ThreadProvider, useCurrentThread, useThreadContext, useThreadStream } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
function Probe() {
  const id=useAppStore(s=>s.currentThreadId)
  const thread=useCurrentThread(id)
  const stream=useThreadStream(id)
  const context=useThreadContext()
  useEffect(()=>context.subscribeToStream(id,()=>window.fixture.streamNotifications++),[context,id])
  useEffect(()=>context.subscribeToHookLogs(id,()=>window.fixture.hookNotifications++),[context,id])
  window.fixture.inspect=()=>({ id, messages:thread.messages.map(m=>m.id),
    text:thread.messages.map(m=>m.content), draft:thread.draftInput,
    loading:thread.historyLoading, pageLoading:thread.historyPageLoading,
    baseline:thread.subagentTranscriptBaselineReady, streamReady:!!stream.stream,
    isLoading:stream.isLoading, pageReads:window.fixture.pageReads.length,
    goalId:thread.goalUi.goal?.id??null, workers:thread.coordinatorWorkers.map(w=>w.worker_id),
    streamNotifications:window.fixture.streamNotifications, hookNotifications:window.fixture.hookNotifications,
    unbinds:window.fixture.unbinds, cancels:window.fixture.cancels })
  window.fixture.switch=id=>useAppStore.getState().setCurrentThreadId(id)
  window.fixture.older=()=>thread.loadEarlierMessages()
  window.fixture.target=()=>thread.loadMessageWindowAround({messageId:"message-0",ordinal:0})
  window.fixture.draft=value=>thread.setDraftInput(value)
  window.fixture.refreshGoal=()=>thread.refreshGoalUi()
  window.fixture.changeRow=(token,rows)=>{
    window.fixture.rows=rows
    useAppStore.setState(s=>({threads:s.threads.map(row=>row.thread_id===id ? {
      ...row, metadata:{...row.metadata,cmb_thread_incarnation:token} } : row)}))
  }
  window.fixture.metadata=patch=>useAppStore.setState(s=>({ threads:s.threads.map(row=>row.thread_id===id ? {
    ...row,title:patch.title??row.title, metadata:{...row.metadata,...patch} } : row) }))
  window.fixture.removeRow=()=>useAppStore.setState(s=>({ threads:s.threads.filter(row=>row.thread_id!==id) }))
  window.fixture.start=()=>{
    if(!stream.stream) throw Error("actual stream holder missing")
    window.fixture.pending=stream.stream.submit({messages:[{type:"human",content:"controlled input"}]},
      {config:{configurable:{model_id:thread.currentModel}}})
    window.fixture.pending.catch(()=>{})
  }
  return <main>{thread.messages.map(m=><p key={m.id}>{m.content}</p>)}</main>
}
const app=createRoot(document.getElementById("app"))
window.fixture.unmount=()=>app.unmount()
app.render(<ThreadProvider><Probe/></ThreadProvider>)
`

export async function runThreadDirectoryResidentBrowser() {
  const artifacts = join(root, "output/thread-directory-resident-browser", String(Date.now()))
  mkdirSync(artifacts, { recursive: true })
  const built = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true, jsx: "automatic", write: false, platform: "browser", format: "iife", target: "es2022",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" },
    plugins: [{ name: "controlled-store", setup(builder) {
      builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, args => {
        if (args.path === "./store" && !args.importer.replace(/\\/g, "/").includes("src/renderer/src/lib/")) return
        return { path: "store", namespace: "controlled-store" }
      })
      builder.onLoad({ filter: /.*/, namespace: "controlled-store" }, () => ({
        contents: storeModule, loader: "js", resolveDir: root
      }))
    } }, browserWorkerPlugin()]
  })
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<div id="app"></div>') })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  const evidence: Record<string, unknown> = {}
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") console.log("[browser]", message.text())
  })
  const run = async <T = unknown>(source: string): Promise<T> => {
    console.log("EVALUATE", source.slice(0, 100))
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([page.evaluate<T>(source), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Fixture evaluate did not finish: " + source.slice(0, 100))), 10_000)
      })])
      console.log("EVALUATED", source.slice(0, 60))
      return result
    } finally { clearTimeout(deadline) }
  }
  const ready = () => page.waitForFunction(`window.fixture.inspect && !window.fixture.inspect().loading && window.fixture.inspect().baseline && window.fixture.inspect().streamReady`)
  const inspect = () => run<{ messages: string[]; pageReads: number; draft: string; unbinds: number;
    cancels: number; streamNotifications: number; hookNotifications: number }>("window.fixture.inspect()")
  try {
    // Real old bridge: both the empty first page and nonempty bootstrap omit
    // sourceScope. It must continue that one hydration rather than reset/retry.
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({ content: bootstrap + controls + `
      window.fixture.bootstrapReads=0
      window.fixture.pageOverride=()=>{
        // A third immediate mock response would starve the browser on the
        // deliberately reverted implementation. Hold it so the unchanged
        // exact-one-read assertion can report the already observed loop.
        if(window.fixture.pageReads.length > 2) return new Promise(()=>{})
        return {messages:[],total:0,hasMore:false,
          beforeOrdinal:null,beforeMessageId:null,hasVisibleMessages:false,
          legacyCheckpointMigrationStatus:null,legacyMessageTimesPending:false}
      }
      window.api.threads.bootstrapLegacyCheckpointTranscript=async()=>{
        window.fixture.bootstrapReads++
        return {checkpoint:null,page:{messages:[{id:"legacy-bootstrap",role:"user",
          content:"original legacy checkpoint body",created_at:new Date(1000),ordinal:0}],
          total:1,hasMore:false,beforeOrdinal:null,beforeMessageId:null,
          hasVisibleMessages:true,legacyCheckpointMigrationStatus:"complete",legacyMessageTimesPending:false}}
      }
    ` })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(`window.fixture.inspect &&
      (window.fixture.inspect().messages.includes("legacy-bootstrap") || window.fixture.bootstrapReads > 1)`)
    assert.deepEqual((await inspect()).messages, ["legacy-bootstrap"])
    await ready()
    await page.waitForTimeout(50)
    assert.equal(await run("window.fixture.bootstrapReads"), 1)
    assert.equal((await inspect()).pageReads, 1, "Legacy bootstrap must not restart its first page")
    evidence.legacyBootstrap = await inspect()
    console.log("PASS legacy bootstrap", evidence.legacyBootstrap)
    await run("window.fixture.unmount()")

    // Ordinary rows have no workspace. A complete scoped hint for A must not
    // dirty idle current B; an unknown hint must still refresh B and retain A.
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({ content: bootstrap + controls })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await ready()
    await run('window.fixture.switch("intent-b")')
    await page.waitForFunction('window.fixture.inspect().id === "intent-b"')
    await ready()
    const ordinaryBefore = (await inspect()).pageReads
    await run(`window.fixture.rows.push({ id:"ordinary-background",role:"user",
      content:"ordinary background note",created_at:new Date(2000),ordinal:4 });
      const hint = { ...window.fixture.source("intent-a"),kind:"transcript",workspacePath:undefined };
      if(!Object.hasOwn(hint,"workspacePath")) throw Error("Missing own absent-workspace field");
      window.fixture.emitDirectory(hint)`)
    await page.waitForTimeout(30)
    assert.equal((await inspect()).pageReads, ordinaryBefore,
      "Known no-workspace background hint must not refresh unrelated current thread")
    await run("window.fixture.emitDirectory()")
    await page.waitForFunction(`window.fixture.inspect().pageReads === ${ordinaryBefore + 1}`)
    await ready()
    const unknownRead = (await inspect()).pageReads
    await run('window.fixture.switch("intent-a")')
    await page.waitForFunction('window.fixture.inspect().messages.includes("ordinary-background")')
    await ready()
    assert.equal((await inspect()).pageReads, unknownRead + 1,
      "Background resident must remain dirty until its actual authoritative page is read")
    evidence.ordinaryNoWorkspace = await inspect()
    await run("window.fixture.unmount()")

    // Fresh document and reexecuted IIFE isolate the following modern resident
    // matrix from all legacy module/IPC/cache state.
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({ content: bootstrap + controls })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await ready()
    console.log("READY modern", await inspect())
    await run("window.fixture.older()")
    await run('window.fixture.draft("keep my draft"); window.fixture.metadata({title:"new title"})')
    await page.waitForFunction('window.fixture.inspect().draft === "keep my draft"')
    const initial = await inspect()
    assert.deepEqual(initial.messages, ["message-0", "message-1", "message-2", "message-3"])
    await run('window.fixture.metadata({workspacePath:"C:/fixture"})')
    assert.deepEqual((await inspect()).messages, initial.messages)
    assert.equal((await inspect()).pageReads, initial.pageReads)

    await run('window.fixture.switch("intent-b")')
    await page.waitForFunction('window.fixture.inspect().id === "intent-b"')
    await ready()
    await run(`window.fixture.rows.push({ id:"background-note",role:"user",content:"background SDK note",created_at:new Date(2000),ordinal:4 }); window.fixture.hint("intent-a")`)
    const readsWhileBackground = (await inspect()).pageReads
    await page.waitForTimeout(30)
    assert.equal((await inspect()).pageReads, readsWhileBackground, "Background note must defer its page read")
    await run('window.fixture.switch("intent-a")')
    await page.waitForFunction('window.fixture.inspect().messages.includes("background-note")')
    const revisited = await inspect()
    assert.deepEqual(revisited.messages, [...initial.messages, "background-note"])
    assert.equal(revisited.draft, "keep my draft")
    assert.equal(revisited.pageReads, readsWhileBackground + 1,
      "One background invalidation must complete with one bounded read, without refreshing itself")
    evidence.background = revisited
    console.log("PASS background revisit", revisited)

    await run('window.fixture.holdNextTarget=true; window.fixture.targetPromise=window.fixture.target(); void 0')
    await page.waitForFunction("!!window.fixture.releasePage")
    const heldReads = (await inspect()).pageReads
    await run(`window.fixture.rows.push({id:"during-intent",role:"assistant",content:"new durable answer",created_at:new Date(3000),ordinal:5}); window.fixture.hint("intent-a")`)
    await page.waitForTimeout(30)
    assert.equal((await inspect()).pageReads, heldReads, "Busy history intent must retain its dirty notification")
    await run("window.fixture.releasePage(); window.fixture.releasePage=null; window.fixture.targetPromise")
    await page.waitForFunction('window.fixture.inspect().messages.includes("during-intent")')
    evidence.intent = await inspect()
    console.log("PASS busy intent", evidence.intent)

    // The old foreground worker result and goal request resolve only after the
    // new owner is fully hydrated; ID equality alone must not revive either.
    await run('window.fixture.holdNextWorker=true; window.fixture.switch("intent-b")')
    await page.waitForFunction('window.fixture.inspect().id === "intent-b"')
    await ready()
    await run('window.fixture.switch("intent-a")')
    await page.waitForFunction('window.fixture.inspect().id === "intent-a" && !!window.fixture.releaseWorker')
    await run('window.fixture.holdNextGoal=true; window.fixture.oldGoal=window.fixture.refreshGoal(); void 0')
    await page.waitForFunction("!!window.fixture.releaseGoal")

    // Keep both an old physical page and a real stream alive across same-id recreation.
    await run('window.fixture.holdNextTarget=true; window.fixture.oldPage=window.fixture.target(); window.fixture.start()')
    await page.waitForFunction("!!window.fixture.releasePage && window.fixture.requests.length > 0")
    await run(`window.fixture.oldRequest=window.fixture.requests.at(-1);
      window.fixture.oldRequest.emit({type:"custom",threadId:"intent-a",data:{
        type:"message_id_alias",fromId:"message-0",toId:"old-alias",role:"user"}})`)
    await page.waitForFunction("!!window.fixture.releaseAlias")
    const beforeReset = await inspect()
    await run('window.fixture.changeRow("empty-replacement",[])')
    await ready()
    await page.waitForFunction("window.fixture.inspect().messages.length === 0")
    await run(`window.fixture.releasePage(); window.fixture.releasePage=null;
      window.fixture.oldRequest.emit({type:"custom",threadId:"intent-a",data:{type:"coordinator_ai_snapshot_message",
        assistantMessage:{id:"OLD-PRIVATE",content:"old private body",created_at:new Date()}}});
      window.fixture.oldRequest.emit({type:"done",threadId:"intent-a"}); window.fixture.oldPage`)
    await page.waitForTimeout(40)
    const empty = await inspect()
    assert.deepEqual(empty.messages, [], "Old held page/stream must never repopulate a new empty incarnation")
    assert.equal(empty.draft, "")
    assert.equal(empty.unbinds, beforeReset.unbinds, "Local incarnation reset must not unbind Main's reused id")
    assert.equal(empty.cancels, beforeReset.cancels)
    evidence.empty = empty
    console.log("PASS empty replacement", empty)

    await run(`window.fixture.changeRow("nonempty-replacement",[{id:"message-0",role:"user",content:"new owner body",created_at:new Date(4000),ordinal:0}])`)
    await ready()
    await page.waitForFunction('window.fixture.inspect().messages.join() === "message-0"')
    await run("window.fixture.releaseWorker(); window.fixture.releaseGoal(); window.fixture.releaseAlias(); window.fixture.oldGoal")
    await page.waitForTimeout(40)
    assert.deepEqual(await run("window.fixture.inspect().workers"), [])
    assert.equal(await run("window.fixture.inspect().goalId"), null)
    assert.deepEqual((await inspect()).messages, ["message-0"],
      "Old successful alias must not rename a same-id message in the replacement owner")
    const beforeStream = await inspect()
    await run("window.fixture.start()")
    await page.waitForFunction("window.fixture.requests.length >= 2")
    await run(`window.fixture.requests.at(-1).emit({type:"custom",threadId:"intent-a",
      data:{type:"hook_executed",event:"SessionStart",label:"new owner hook",timestamp:new Date()}})`)
    await page.waitForFunction(`window.fixture.inspect().hookNotifications > ${beforeStream.hookNotifications}`)
    assert((await inspect()).streamNotifications > beforeStream.streamNotifications,
      "Mounted stream subscriber must survive local reset")
    await run('window.fixture.requests.at(-1).emit({type:"done",threadId:"intent-a"})')
    await page.waitForFunction("!window.fixture.inspect().isLoading")
    evidence.nonempty = await inspect()
    console.log("PASS nonempty replacement", evidence.nonempty)

    // A real serialized source rejection from an old pending page must not
    // erase the successor, even when both requests use the same thread id.
    await run('window.fixture.holdNextTarget=true; window.fixture.oldRejected=window.fixture.target(); void 0')
    await page.waitForFunction("!!window.fixture.releasePage")
    await run(`window.fixture.changeRow("after-old-reject",[{id:"after-reject",role:"user",
      content:"successor survives old rejection",created_at:new Date(5000),ordinal:0}])`)
    await page.waitForFunction('window.fixture.inspect().messages.join() === "after-reject"')
    await ready()
    await run("window.fixture.rejectHeldPage(); window.fixture.releasePage=null; window.fixture.oldRejected")
    assert.deepEqual((await inspect()).messages, ["after-reject"])
    evidence.lateRejection = await inspect()

    // A legacy incremental read performs one fresh empty-state hydration, not a reset loop.
    const beforeLegacyReads = (await inspect()).pageReads
    await run("window.fixture.legacy=true; window.fixture.emitDirectory()")
    await page.waitForFunction(`window.fixture.inspect().pageReads >= ${beforeLegacyReads + 2}`)
    await ready()
    const legacy = await inspect()
    assert(legacy.messages.includes("after-reject"))
    const legacyReads = legacy.pageReads
    await page.waitForTimeout(60)
    assert.equal((await inspect()).pageReads, legacyReads, "Legacy fallback must not recursively rehydrate")
    evidence.legacy = legacy

    // Match the actual Electron rejection envelope from captureThreadDisplayRead,
    // rather than returning a fictional successful empty page for a missing row.
    await run("window.fixture.removeRow(); window.fixture.emitDirectory()")
    await page.waitForFunction("window.fixture.inspect().messages.length === 0")
    evidence.notFound = await inspect()
    assert.deepEqual(errors, [])
  } finally {
    writeFileSync(join(artifacts, "report.json"), JSON.stringify({ evidence, errors }, null, 2) + "\n")
    await run("window.fixture?.unmount?.()").catch(() => {})
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
    console.log(artifacts)
  }
}

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
  runThreadDirectoryResidentBrowser().catch(error => { console.error(error); process.exitCode = 1 })
}
