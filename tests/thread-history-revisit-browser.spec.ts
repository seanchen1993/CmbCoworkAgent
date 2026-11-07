/** Real ThreadProvider: slow sidecar restoration must not reset a retained history window. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
// @ts-expect-error Existing executable ESM fixture.
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

interface RevisitSnapshot {
  id: string
  messages: string[]
  loading: boolean
  baseline: boolean
  pageReads: Array<{ id: string; older: boolean }>
  subagentReads: string[]
}

declare global {
  interface Window {
    fixture: {
      inspect(): RevisitSnapshot
      loadEarlier(): Promise<number>
      switch(id: string): void
      releaseHeld(): void
      failSidecarOnce(): void
      resetThread(): void
      unmount(): void
    }
  }
}

const root = resolve(__dirname, "..")
const artifacts = join(root, "output", "thread-history-revisit-browser", String(Date.now()))
mkdirSync(artifacts, { recursive: true })

const storeModule = `
import { useSyncExternalStore } from "react"
const listeners = new Set()
let state = {
  currentThreadId: "intent-a",
  threads: [window.fixture.thread, { ...window.fixture.thread, thread_id: "intent-b" }],
  models: window.fixture.models,
  workerFocusView: null,
  workerFocusMessages: [],
  rightModule: "work",
  rightPanelCollapsed: true
}
const publish = next => {
  const previous = state
  state = { ...state, ...next }
  for (const callback of listeners) callback(state, previous)
}
const subscribe = callback => {
  listeners.add(callback)
  return () => listeners.delete(callback)
}
state.loadModels = async force => {
  const { revalidateModelCatalog } = await import("@/lib/model-catalog-cache")
  const catalog = await revalidateModelCatalog(force)
  publish({ models: catalog.models })
}
state.patchThreadMetadata = async (id, patch) => {
  window.fixture.metadataWrites.push({ id, patch })
  const thread = state.threads.find(row => row.thread_id === id)
  if (!thread) throw Error("Unknown controlled thread")
  const next = { ...thread, metadata: { ...thread.metadata, ...patch.set } }
  publish({ threads: state.threads.map(row => row.thread_id === id ? next : row) })
  return next
}
state.setRightModule = value => publish({ rightModule: value })
state.setRightPanelCollapsed = value => publish({ rightPanelCollapsed: value })
state.addThreadSummary = thread => publish({ threads: [...state.threads, thread] })
state.setCurrentThreadId = id => publish({ currentThreadId: id })
export const useAppStore = selector => selector(useSyncExternalStore(subscribe, () => state))
useAppStore.getState = () => state
useAppStore.subscribe = subscribe
useAppStore.setState = next => publish(typeof next === "function" ? next(state) : next)
export const isThreadDeletionPending = () => false
export const isThreadRetired = () => false
window.fixture.readThread = id => state.threads.find(row => row.thread_id === id) ?? null
`
const bootstrap = `
const listeners = new Set()
const noopListener = () => () => {}
const models = [
  { id: "custom:a", name: "Model A", source: "custom", model: "intent-a",
    available: true, tier: "premium" },
  { id: "custom:b", name: "Model B", source: "custom", model: "intent-b",
    available: true, tier: "economy" },
  { id: "custom:d", name: "Model D", source: "custom", model: "intent-d",
    available: true, tier: "premium" }
]
window.fixture = {
  pageReads: [], subagentReads: [], heldOnce: false, sidecarFailures: 0,
  failSidecarOnce: () => { window.fixture.sidecarFailures = 1 },
  models,
  thread: { thread_id: "intent-a", title: "Intent fixture", metadata: { model: "custom:a" },
    thread_values: {}, created_at: "2026-10-08T00:00:00Z",
    updated_at: "2026-10-08T00:00:00Z" },
  metadataWrites: [],
  requests: [],
  cleanups: 0,
  leafReads: [],
  pending: null,
  settled: false,
  submitError: null,
  mode: "pinned",
  initialEnabled: true,
  holdDetails: false,
  detailReleases: [],
  releaseDetail: index => {
    const release = window.fixture.detailReleases[index]
    if (!release) throw Error("Missing held detail read")
    release()
  },
  releaseAllDetails: () => {
    for (const release of window.fixture.detailReleases) release()
    window.fixture.holdDetails = false
  },
  configurationListeners: listeners,
  notifyConfiguration: () => { for (const callback of listeners) callback() }
}
const emptyPage = () => ({ messages: [], beforeOrdinal: null, beforeMessageId: null,
  hasMore: false, total: 0, hasVisibleMessages: false,
  legacyCheckpointMigrationStatus: "complete", legacyMessageTimesPending: false })
window.api = {
  models: {
    getCatalog: async () => ({ models, providers: [], defaultModelId: "custom:a",
      routingMode: window.fixture.mode })
  },
  routing: { getMode: async () => window.fixture.mode,
    setMode: async mode => { window.fixture.mode = mode } },
  workspace: {
    onFilesChanged: noopListener,
    setActiveThread: async () => ({ success: true, restarted: false })
  },
  threads: {
    get: async id => {
      window.fixture.leafReads.push("threads.get")
      const thread = structuredClone(window.fixture.readThread(id))
      if (!window.fixture.holdDetails) return thread
      return new Promise(resolve => window.fixture.detailReleases.push(() => resolve(thread)))
    },
    getMessagesPage: async (id, options) => {
      window.fixture.pageReads.push({id, older: !!options?.beforeMessageId})
      if (id !== "intent-a") return emptyPage()
      const older = !!options?.beforeMessageId
      return {...emptyPage(), messages: (older ? [0,1] : [2,3]).map(index => ({
        id: "message-"+index, role: index % 2 ? "assistant" : "user",
        content: "durable message "+index, created_at: new Date(1000+index), ordinal:index
      })), total:4, hasMore:!older, hasVisibleMessages:true,
        beforeOrdinal:older ? null : 2, beforeMessageId:older ? null : "message-2"}
    },
    getGoalEvents: async () => [],
    getSubagentTranscripts: async id => {
      window.fixture.subagentReads.push(id)
      if (id === "intent-a" && !window.fixture.heldOnce) {
        window.fixture.heldOnce = true
        return new Promise(resolve => { window.fixture.releaseHeld = () => resolve({}) })
      }
      if (id === "intent-a" && window.fixture.sidecarFailures > 0) {
        window.fixture.sidecarFailures--
        throw Error("controlled sidecar retry")
      }
      return {}
    },
    getLatestCheckpointRuntimeState: async () => null,
    getGoalState: async () => ({ goal: null, events: [] }),
    appendMessages: async () => undefined,
    persistSubagentTranscripts: async () => ({})
  },
  agent: {
    getCoordinatorWorkers: async () => [],
    hasCoordinatorWorkerNotifications: async () => false,
    unbindCoordinatorWorkers: async () => undefined,
    onCoordinatorWorkerHook: noopListener,
    onQueuedMessagesInjected: noopListener,
    onManagedAutoSendStreamStart: noopListener,
    streamAgent: (threadId, message, command, emit, modelId) => {
      window.fixture.requests.push({ threadId, message, command, modelId, emit })
      return () => { window.fixture.cleanups += 1 }
    }
  },
  sandbox: {
    getPendingApprovals: async () => [],
    onApprovalRequest: noopListener,
    onApprovalResolved: noopListener,
    onApprovalTimeout: noopListener,
    onApprovalCancel: noopListener
  },
  userInput: { onRequest: noopListener, onCancel: noopListener, getPending: async () => null },
  workflows: {
    onWorkflowEvents: noopListener,
    requestPendingNotification: async () => undefined,
    suppressPendingNotification: async () => undefined
  },
  heartbeat: { onChanged: noopListener, isRunning: async () => false },
  scheduledTasks: {
    listenToStream: noopListener,
    listenToThreadActivity: noopListener,
    onChanged: noopListener,
    isRunning: async () => false
  },
  harnessBoard: { onManagedRunThreadCreated: noopListener },
  mods: {
    onConversationNotice: noopListener,
    onConfigurationChanged: callback => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}
`
const entry = `
import React from "react"
import { createRoot } from "react-dom/client"
import { ThreadProvider, useCurrentThread, useThreadContext } from "@/lib/thread-context"
import { useAppStore } from "@/lib/store"
function Probe() {
 const id = useAppStore(s => s.currentThreadId)
 const thread = useCurrentThread(id)
 const context = useThreadContext()
 window.fixture.inspect = () => ({ id, messages:thread.messages.map(m=>m.id),
   loading:thread.historyLoading, baseline:thread.subagentTranscriptBaselineReady,
   pageReads:window.fixture.pageReads, subagentReads:window.fixture.subagentReads })
 window.fixture.loadEarlier = () => thread.loadEarlierMessages()
 window.fixture.switch = id => useAppStore.getState().setCurrentThreadId(id)
 window.fixture.resetThread = () => {
   context.cleanupThread(id)
   context.initializeThread(id)
 }
 return <main>{thread.messages.map(m=><p key={m.id}>{m.content}</p>)}</main>
}
const app=createRoot(document.getElementById("app"))
window.fixture.unmount=()=>app.unmount()
app.render(<ThreadProvider><Probe/></ThreadProvider>)

`

async function main() {
  const built = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    jsx: "automatic",
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    alias: { "@": join(root, "src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" },
    plugins: [
      {
        name: "controlled-store",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) => {
            if (
              args.path === "./store" &&
              !args.importer.replace(/\\/g, "/").includes("src/renderer/src/lib/")
            )
              return
            return { path: "store", namespace: "controlled-store" }
          })
          builder.onLoad({ filter: /.*/, namespace: "controlled-store" }, () => ({
            contents: storeModule,
            loader: "js",
            resolveDir: root
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end('<div id="app"></div>')
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let before: RevisitSnapshot | undefined
  let after: RevisitSnapshot | undefined
  let failure: string | undefined
  let afterRetry: RevisitSnapshot | undefined
  let afterReset: RevisitSnapshot | undefined
  try {
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.addScriptTag({ content: bootstrap })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForFunction(
      () => window.fixture?.inspect?.().messages.length === 2 && !window.fixture.inspect().loading
    )
    await page.evaluate(() => window.fixture.loadEarlier())
    await page.waitForFunction(() => window.fixture.inspect().messages.length === 4)
    before = await page.evaluate(() => window.fixture.inspect())
    await page.evaluate(() => window.fixture.switch("intent-b"))
    await page.waitForFunction(
      () => window.fixture.inspect().id === "intent-b" && window.fixture.inspect().baseline
    )
    await page.evaluate(() => window.fixture.switch("intent-a"))
    await page.waitForFunction(
      () => window.fixture.inspect().id === "intent-a" && window.fixture.inspect().baseline
    )
    after = await page.evaluate(() => window.fixture.inspect())
    assert.deepEqual(
      after.messages,
      ["message-0", "message-1", "message-2", "message-3"],
      "Reopening must retain the selected historical window while only the subagent baseline retries"
    )
    assert.equal(
      after.pageReads.filter((r) => r.id === "intent-a").length,
      2,
      "Only initial and explicitly requested older pages should be read"
    )
    await page.evaluate(() => window.fixture.releaseHeld())
    await page.waitForTimeout(40)
    assert.deepEqual(await page.evaluate(() => window.fixture.inspect().messages), [
      "message-0",
      "message-1",
      "message-2",
      "message-3"
    ])
    for (let round = 0; round < 5; round++) {
      for (const id of ["intent-b", "intent-a"]) {
        await page.evaluate((next) => window.fixture.switch(next), id)
        await page.waitForFunction((next) => window.fixture.inspect().id === next, id)
      }
    }
    const revisited = await page.evaluate(() => window.fixture.inspect())
    assert.deepEqual(revisited.messages, after.messages)
    assert.deepEqual(revisited.pageReads, after.pageReads)
    assert.deepEqual(revisited.subagentReads, after.subagentReads)
    // Cleanup/reinitialization must retire the completed-main marker. A failed
    // sidecar retry must then restore only its baseline, keeping user history.
    await page.evaluate(() => {
      window.fixture.failSidecarOnce()
      window.fixture.resetThread()
    })
    await page.waitForFunction(() => {
      const state = window.fixture.inspect()
      return state.messages.length === 2 && !state.loading &&
        state.pageReads.filter(row => row.id === "intent-a").length === 3
    })
    afterReset = await page.evaluate(() => window.fixture.inspect())
    await page.evaluate(() => window.fixture.loadEarlier())
    await page.waitForFunction(() => window.fixture.inspect().baseline)
    afterRetry = await page.evaluate(() => window.fixture.inspect())
    assert.deepEqual(afterRetry.messages, ["message-0", "message-1", "message-2", "message-3"])
    assert.equal(afterRetry.pageReads.filter(row => row.id === "intent-a").length, 4)
    assert.equal(afterRetry.subagentReads.filter(id => id === "intent-a").length,
      after.subagentReads.filter(id => id === "intent-a").length + 2)
    assert.deepEqual(errors, [])
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          before,
          after,
          afterReset,
          afterRetry,
          errors,
          failure,
          scope: "Real Provider and browser; controlled IPC leaves"
        },
        null,
        2
      ) + "\n"
    )
    await page.evaluate(() => window.fixture?.unmount?.()).catch(() => {})
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
    console.log(artifacts)
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
