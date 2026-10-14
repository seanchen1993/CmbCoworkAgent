/** Real Provider/Holder/stream/transport/model control; mocked store and finite IPC leaves. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join, resolve } from "node:path"
import { build, type PluginBuild, type OnResolveArgs } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"
// @ts-expect-error The existing browser worker plugin is an executable ESM fixture.
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const root = resolve(__dirname, "..")
const artifacts = resolve(
  root,
  process.env.CMB_MODEL_INTENT_PROVIDER_ARTIFACTS ??
    "output/mods-v2-validation/stage43-model-intent-provider-red"
)
assert(!existsSync(artifacts), "Use fresh artifacts; preserve the original RED evidence")
mkdirSync(artifacts, { recursive: true })
const pageErrors: string[] = []
const checks: string[] = []
let browser: Browser | undefined
let page: Page | undefined
let server: Server | undefined
let failure: string | null = null
let readBack: Record<string, unknown> = {}
const observations: Array<{ label: string; data: Record<string, unknown> }> = []
let bundleSource = ""

const sourcePaths = [
  "src/renderer/src/lib/thread-context.tsx",
  "src/renderer/src/lib/model-selection-intent.ts",
  "src/renderer/src/lib/electron-stream.ts",
  "src/renderer/src/lib/use-electron-stream.ts",
  "src/renderer/src/lib/electron-transport.ts",
  "src/renderer/src/components/chat/ModelSwitcher.tsx",
  "tests/mods-model-intent-provider-browser.spec.ts"
]
const sourceHashes = () =>
  sourcePaths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex")
  }))
const before = sourceHashes()

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
    getMessagesPage: async () => {
      window.fixture.leafReads.push("threads.getMessagesPage")
      return emptyPage()
    },
    getGoalEvents: async () => [],
    getSubagentTranscripts: async () => ({}),
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
import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadProvider, useCurrentThread, useThreadStream, useThreadContext }
  from "@/lib/thread-context"
import { ModelSwitcher } from "@/components/chat/ModelSwitcher"
import { useAppStore } from "@/lib/store"

function Probe() {
  const [enabled, setEnabled] = useState(window.fixture.initialEnabled)
  const threadId = useAppStore(state => state.currentThreadId)
  const context = useThreadContext()
  const thread = useCurrentThread(threadId)
  const view = useThreadStream(threadId)
  const ready = !thread.historyLoading && thread.subagentTranscriptBaselineReady && !!view.stream
  window.fixture.inspect = () => ({
    currentModel: thread.currentModel,
    routingResult: thread.routingResult,
    historyLoading: thread.historyLoading,
    baselineReady: thread.subagentTranscriptBaselineReady,
    streamReady: !!view.stream,
    isLoading: view.isLoading,
    enabled
  })
  window.fixture.inspectThreads = () => Object.fromEntries(
    Object.entries(context.getAllThreadStates()).map(([id, state]) => [id, {
      currentModel: state.currentModel, routingResult: state.routingResult
    }])
  )
  window.fixture.finish = () => {
    const request = window.fixture.requests.at(-1)
    if (request) request.emit({ type: "done", threadId: request.threadId })
  }
  const start = () => {
    if (!ready || !view.stream) throw Error("Actual holder not ready")
    window.fixture.settled = false
    window.fixture.submitError = null
    window.fixture.pending = view.stream.submit({
      messages: [{ type: "human", content: "held original Claw turn" }]
    }, { config: { configurable: { model_id: enabled ? "custom:b" : thread.currentModel } } })
    window.fixture.pending.then(() => { window.fixture.settled = true }, error => {
      window.fixture.submitError = String(error)
      window.fixture.settled = true
    })
  }
  return <main>
    <p data-testid="actual-provider-model">{thread.currentModel}</p>
    <button disabled={!ready || view.isLoading} onClick={start}>启动受控旧请求</button>
    <button disabled={!enabled} onClick={() => {
      window.fixture.notifyConfiguration()
      setEnabled(false)
    }}>关闭 Mods（受控配置）</button>
    <button disabled={!enabled} onClick={() => {
      window.fixture.notifyConfiguration()
      setEnabled(false)
      window.fixture.notifyConfiguration()
      setEnabled(true)
    }}>快速关闭再开启 Mods（受控配置）</button>
    <button onClick={() => useAppStore.getState().setCurrentThreadId(
      threadId === "intent-a" ? "intent-b" : "intent-a"
    )}>切换受控会话</button>
    <ModelSwitcher threadId={threadId} composerMode="chat" modsEnabled={enabled}
      clawDefaultModel={enabled ? "custom:b" : undefined} bindingRevision={1} />
  </main>
}
const app = createRoot(document.getElementById("app"))
window.fixture.unmount = () => app.unmount()
app.render(<ThreadProvider><Probe /></ThreadProvider>)
`

async function until(check: () => Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 30))
  }
  throw Error(`Timed out: ${label}`)
}

type ControlledModelState = {
  currentModel: string
  routingResult: { resolvedModelId: string } | null
  historyLoading: boolean
  baselineReady: boolean
  streamReady: boolean
  isLoading: boolean
  enabled: boolean
}
type ProviderObservation = {
  state: ControlledModelState
  threads: Record<string, Pick<ControlledModelState, "currentModel" | "routingResult">>
  metadata: Record<string, unknown>
  metadataWrites: unknown[]
  requests: Array<{ threadId: string; modelId: string; message: string }>
  settled: boolean
  submitError: string | null
}

async function observe(): Promise<ProviderObservation> {
  return page!.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          inspect: () => ControlledModelState
          inspectThreads: () => ProviderObservation["threads"]
          readThread: (id: string) => { metadata: Record<string, unknown> }
          metadataWrites: unknown[]
          requests: ProviderObservation["requests"]
          settled: boolean
          submitError: string | null
        }
      }
    ).fixture
    return {
      state: fixture.inspect(),
      threads: fixture.inspectThreads(),
      metadata: fixture.readThread("intent-a").metadata,
      metadataWrites: fixture.metadataWrites,
      requests: fixture.requests.map(({ threadId, modelId, message }) => ({
        threadId,
        modelId,
        message
      })),
      settled: fixture.settled,
      submitError: fixture.submitError
    }
  })
}

async function waitReady() {
  await until(
    () =>
      page!.evaluate(() => {
        const fixture = (
          window as unknown as {
            fixture?: {
              inspect?: () => ControlledModelState
            }
          }
        ).fixture
        const state = fixture?.inspect?.()
        return !!state && !state.historyLoading && state.baselineReady && state.streamReady
      }),
    "actual Provider history, subagent baseline, and holder"
  )
  assert.deepEqual(pageErrors, [], "Setup must complete before behavioral assertions")
}

async function finishRun() {
  await page!.evaluate(async () => {
    const fixture = (
      window as unknown as {
        fixture: {
          finish: () => void
          pending: Promise<void> | null
          submitError: string | null
        }
      }
    ).fixture
    fixture.finish()
    if (fixture.pending) await fixture.pending
    if (fixture.submitError) throw Error(fixture.submitError)
  })
  await until(async () => !(await observe()).state.isLoading, "owned run settled")
}

async function freshFixture(
  options: {
    mode?: "pinned" | "auto"
    enabled?: boolean
    holdDetails?: boolean
  } = {}
) {
  if (page) {
    await page.evaluate(async () => {
      const fixture = (
        window as unknown as {
          fixture?: {
            finish: () => void
            pending: Promise<void> | null
            releaseAllDetails: () => void
            unmount: () => void
          }
        }
      ).fixture
      fixture?.releaseAllDetails()
      fixture?.finish()
      if (fixture?.pending) await fixture.pending
      fixture?.unmount()
    })
    await page.close()
  }
  page = await browser!.newPage()
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const address = server!.address()
  assert(address && typeof address !== "string")
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.addScriptTag({ content: bootstrap })
  await page.evaluate((optionsJson) => {
    const options = JSON.parse(optionsJson) as {
      mode?: "pinned" | "auto"
      enabled?: boolean
      holdDetails?: boolean
    }
    const fixture = (
      window as unknown as {
        fixture: {
          mode: string
          initialEnabled: boolean
          holdDetails: boolean
        }
      }
    ).fixture
    fixture.mode = options.mode ?? "pinned"
    fixture.initialEnabled = options.enabled ?? true
    fixture.holdDetails = options.holdDetails ?? false
  }, JSON.stringify(options))
  await page.addScriptTag({ content: bundleSource })
  if (!options.holdDetails) await waitReady()
}

async function startRun(count: number) {
  await page!.getByRole("button", { name: "启动受控旧请求", exact: true }).click()
  await until(
    () =>
      page!.evaluate(
        (expected) =>
          (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests.length ===
          expected,
        count
      ),
    "real IPC transport dispatch"
  )
}

async function emitRoute(modelId: string, index = 0) {
  await page!.evaluate((inputJson) => {
    const input = JSON.parse(inputJson) as { modelId: string; index: number }
    const fixture = (
      window as unknown as {
        fixture: {
          requests: Array<{
            threadId: string
            emit: (event: { type: string; threadId: string; data: Record<string, unknown> }) => void
          }>
        }
      }
    ).fixture
    const request = fixture.requests[input.index]
    if (!request) throw Error("Missing owned IPC request")
    request.emit({
      type: "custom",
      threadId: request.threadId,
      data: {
        type: "routing_result",
        resolvedModelId: input.modelId,
        resolvedTier: input.modelId === "custom:b" ? "economy" : "premium",
        routeReason: "controlled held route"
      }
    })
  }, JSON.stringify({ modelId, index }))
  await until(async () => {
    const state = await observe()
    const request = state.requests[index]
    return state.threads[request.threadId]?.routingResult?.resolvedModelId === modelId
  }, "actual Provider records the route fact")
}

async function selectModelD() {
  await page!.getByRole("button", { name: /原聊天模型与智能路由|^Model A$/ }).click()
  await page!.getByRole("button", { name: /^Model D/ }).click()
  await until(
    async () => (await observe()).state.currentModel === "custom:d",
    "actual model control selected D"
  )
}

async function main() {
  const result = await build({
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
        name: "finite-store-leaf-boundary",
        setup(builder: PluginBuild) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args: OnResolveArgs) => {
            if (
              args.path === "./store" &&
              !args.importer.replace(/\\/g, "/").includes("src/renderer/src/lib/")
            )
              return
            return { path: "controlled-store", namespace: "controlled-store" }
          })
          builder.onLoad({ filter: /.*/, namespace: "controlled-store" }, () => ({
            loader: "js",
            contents: storeModule,
            resolveDir: root
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const bundle = result.outputFiles[0].text
  bundleSource = bundle
  writeFileSync(join(artifacts, "fixture.bundle.js"), bundle)
  writeFileSync(
    join(artifacts, "bundle.json"),
    JSON.stringify(
      {
        sha256: createHash("sha256").update(bundle).digest("hex"),
        boundary: "only store and finite window.api leaves; actual Provider and stream chain"
      },
      null,
      2
    )
  )
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end('<!doctype html><html><body><div id="app"></div></body></html>')
  })
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  assert(address && typeof address !== "string")
  browser = await chromium.launch({ channel: "msedge", headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.addScriptTag({ content: bootstrap })
  await page.addScriptTag({ content: bundle })

  await until(
    () =>
      page!.evaluate(() => {
        const fixture = (
          window as unknown as {
            fixture?: {
              inspect?: () => {
                historyLoading: boolean
                baselineReady: boolean
                streamReady: boolean
              }
            }
          }
        ).fixture
        const state = fixture?.inspect?.()
        return !!state && !state.historyLoading && state.baselineReady && state.streamReady
      }),
    "actual Provider history, subagent baseline, and holder"
  )
  assert.deepEqual(pageErrors, [], "Setup must complete before a behavioral RED is accepted")
  assert.equal(await page.getByTestId("actual-provider-model").textContent(), "custom:a")
  await page.getByRole("button", { name: "启动受控旧请求", exact: true }).click()
  await until(
    () =>
      page!.evaluate(
        () =>
          (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests.length === 1
      ),
    "real IPC transport dispatch"
  )
  await page.getByRole("button", { name: "关闭 Mods（受控配置）", exact: true }).click()
  await until(
    () =>
      page!.evaluate(
        () =>
          !(
            window as unknown as { fixture: { inspect: () => { enabled: boolean } } }
          ).fixture.inspect().enabled
      ),
    "actual model control observes OFF"
  )
  await until(
    async () => (await page!.getByRole("button", { name: /当前组合模型/ }).count()) === 0,
    "Claw model chip removed"
  )
  assert.equal(await page.getByTestId("actual-provider-model").textContent(), "custom:a")
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          requests: Array<{
            emit: (event: { type: string; threadId: string; data: Record<string, unknown> }) => void
          }>
        }
      }
    ).fixture
    fixture.requests[0].emit({
      type: "custom",
      threadId: "intent-a",
      data: {
        type: "routing_result",
        resolvedModelId: "custom:b",
        resolvedTier: "economy",
        routeReason: "held old Claw result after OFF"
      }
    })
  })
  await until(
    () =>
      page!.evaluate(
        () =>
          (
            window as unknown as {
              fixture: {
                inspect: () => {
                  routingResult: { resolvedModelId: string } | null
                }
              }
            }
          ).fixture.inspect().routingResult?.resolvedModelId === "custom:b"
      ),
    "actual Provider consumes the old route fact"
  )
  readBack = await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        fixture: {
          inspect: () => Record<string, unknown>
          metadataWrites: unknown[]
          readThread: (id: string) => { metadata: Record<string, unknown> }
          requests: Array<{ threadId: string; modelId: string; message: string }>
        }
      }
    ).fixture
    return {
      state: fixture.inspect(),
      metadata: fixture.readThread("intent-a").metadata,
      metadataWrites: fixture.metadataWrites,
      requests: fixture.requests.map(({ threadId, modelId, message }) => ({
        threadId,
        modelId,
        message
      }))
    }
  })
  await page.screenshot({ path: join(artifacts, "late-route-after-off.png"), fullPage: true })
  assert.deepEqual(pageErrors, [])
  const state = readBack.state as { currentModel: string }
  assert.equal(
    state.currentModel,
    "custom:a",
    "A late old routing result must not overwrite the base restored by actual ModelSwitcher"
  )
  assert.deepEqual(readBack.metadata, { model: "custom:a" })
  assert.deepEqual(readBack.metadataWrites, [])
  assert.deepEqual(readBack.requests, [
    { threadId: "intent-a", modelId: "custom:b", message: "held original Claw turn" }
  ])
  checks.push("real Provider: same-value OFF then late route cannot overwrite A")
  observations.push({ label: "same-value OFF and late B", data: readBack })
  await finishRun()

  await startRun(2)
  assert.equal(
    (await observe()).requests[1].modelId,
    "custom:a",
    "A new OFF request must use the restored current base"
  )
  await emitRoute("custom:d", 1)
  const fallback = await observe()
  assert.equal(
    fallback.state.currentModel,
    "custom:d",
    "A current pinned request can still accept a legitimate fallback"
  )
  assert.deepEqual(fallback.metadata, { model: "custom:a" })
  assert.deepEqual(fallback.metadataWrites, [])
  await page.screenshot({ path: join(artifacts, "new-off-fallback-d.png"), fullPage: true })
  observations.push({ label: "new OFF request and legitimate D fallback", data: fallback })
  checks.push("real Provider: new OFF A request accepts current fallback D")
  await finishRun()

  await freshFixture()
  await startRun(1)
  await page
    .getByRole("button", {
      name: "快速关闭再开启 Mods（受控配置）",
      exact: true
    })
    .click()
  assert.equal((await observe()).state.enabled, true)
  await emitRoute("custom:b")
  const rapid = await observe()
  assert.equal(
    rapid.state.currentModel,
    "custom:a",
    "Synchronous configuration notifications must fence a batched OFF/ON gap"
  )
  assert.deepEqual(rapid.metadata, { model: "custom:a" })
  assert.deepEqual(rapid.metadataWrites, [])
  await finishRun()
  await startRun(2)
  assert.equal((await observe()).requests[1].modelId, "custom:b")
  await emitRoute("custom:b", 1)
  const nextOn = await observe()
  assert.equal(
    nextOn.state.currentModel,
    "custom:b",
    "A newly captured ON request must remain usable after the conservative fence"
  )
  assert.deepEqual(nextOn.metadata, { model: "custom:a" })
  assert.deepEqual(nextOn.metadataWrites, [])
  await page.screenshot({ path: join(artifacts, "rapid-off-on-new-request.png"), fullPage: true })
  observations.push({ label: "rapid OFF/ON old receipt", data: rapid })
  observations.push({ label: "new ON receipt", data: nextOn })
  checks.push("real Provider: rapid OFF/ON fences old route and accepts new ON B")
  await finishRun()

  await freshFixture({ mode: "auto" })
  await startRun(1)
  await page.getByRole("button", { name: "关闭 Mods（受控配置）", exact: true }).click()
  await until(async () => !(await observe()).state.enabled, "auto control observes OFF")
  await emitRoute("custom:b")
  const auto = await observe()
  assert.equal(
    auto.state.currentModel,
    "custom:b",
    "Confirmed auto must keep an otherwise-current late route through a Mods event"
  )
  assert.deepEqual(auto.metadata, { model: "custom:a" })
  assert.deepEqual(auto.metadataWrites, [])
  await page.screenshot({
    path: join(artifacts, "confirmed-auto-off-late-route.png"),
    fullPage: true
  })
  observations.push({ label: "confirmed auto OFF and late route", data: auto })
  checks.push("real Provider: confirmed auto preserves the current late route")
  await finishRun()

  await freshFixture({ enabled: false })
  await startRun(1)
  await selectModelD()
  await until(
    async () => (await observe()).metadata.model === "custom:d",
    "actual selected model persistence acknowledged"
  )
  await page.getByRole("button", { name: "切换受控会话", exact: true }).click()
  await waitReady()
  assert.equal((await observe()).state.currentModel, "custom:a")
  await emitRoute("custom:b")
  const otherThread = await observe()
  assert.equal(otherThread.state.currentModel, "custom:a")
  assert.equal(otherThread.threads["intent-a"].currentModel, "custom:d")
  assert.equal(otherThread.threads["intent-a"].routingResult?.resolvedModelId, "custom:b")
  assert.deepEqual(otherThread.metadata, { model: "custom:d" })
  assert.deepEqual(
    otherThread.requests.map((request) => [request.threadId, request.modelId]),
    [["intent-a", "custom:a"]]
  )
  await page.screenshot({ path: join(artifacts, "cross-thread-old-route.png"), fullPage: true })
  observations.push({ label: "manual A choice and cross-thread route", data: otherThread })
  checks.push("real Provider: old A route preserves A's new choice and cannot write thread B")
  await finishRun()

  await freshFixture({ enabled: false, holdDetails: true })
  await until(
    () =>
      page!.evaluate(
        () =>
          (window as unknown as { fixture: { detailReleases: unknown[] } }).fixture.detailReleases
            .length >= 1
      ),
    "actual Provider details hydration is held"
  )
  await until(
    async () => (await observe()).state.currentModel === "custom:a",
    "actual model control can display the stored base before details settle"
  )
  await selectModelD()
  await until(
    () =>
      page!.evaluate(
        () =>
          (window as unknown as { fixture: { detailReleases: unknown[] } }).fixture.detailReleases
            .length >= 2
      ),
    "manual selection's metadata read is independently held"
  )
  await page.evaluate(() =>
    (
      window as unknown as { fixture: { releaseDetail: (index: number) => void } }
    ).fixture.releaseDetail(0)
  )
  await waitReady()
  const hydrated = await observe()
  assert.equal(
    hydrated.state.currentModel,
    "custom:d",
    "Old details hydration must not overwrite a newer model choice awaiting persistence"
  )
  assert.equal(hydrated.state.historyLoading, false)
  assert.equal(hydrated.state.baselineReady, true)
  assert.equal(hydrated.state.streamReady, true)
  assert.deepEqual(hydrated.metadata, { model: "custom:a" })
  assert.deepEqual(hydrated.metadataWrites, [])
  assert.deepEqual(hydrated.requests, [])
  await page.screenshot({ path: join(artifacts, "late-details-hydration.png"), fullPage: true })
  observations.push({
    label: "late hydration before manual metadata acknowledgement",
    data: hydrated
  })
  await page.evaluate(() =>
    (
      window as unknown as { fixture: { releaseAllDetails: () => void } }
    ).fixture.releaseAllDetails()
  )
  await until(
    async () => (await observe()).metadata.model === "custom:d",
    "manual metadata acknowledgement after hydration"
  )
  assert.equal((await observe()).state.currentModel, "custom:d")
  checks.push("real Provider: held old model hydration preserves D and other hydration completes")
  assert.deepEqual(pageErrors, [])
}

main()
  .catch((error) => {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (page) {
      await page
        .evaluate(async () => {
          const fixture = (
            window as unknown as {
              fixture?: {
                finish?: () => void
                pending?: Promise<void> | null
                releaseAllDetails?: () => void
                unmount?: () => void
              }
            }
          ).fixture
          fixture?.releaseAllDetails?.()
          fixture?.finish?.()
          if (fixture?.pending) await fixture.pending.catch(() => undefined)
          fixture?.unmount?.()
        })
        .catch((error) => pageErrors.push(`cleanup: ${String(error)}`))
    }
    await browser?.close()
    if (server)
      await new Promise<void>((resolveClose, reject) =>
        server!.close((error) => (error ? reject(error) : resolveClose()))
      )
    const after = sourceHashes()
    if (pageErrors.length || JSON.stringify(before) !== JSON.stringify(after)) {
      failure ??= "Fixture page/cleanup errors or source identity changed; inspect the report"
      process.exitCode = 1
    }
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          checks,
          failure,
          pageErrors,
          readBack,
          observations,
          before,
          after,
          sourceHashesUnchanged: JSON.stringify(before) === JSON.stringify(after),
          scope:
            "controlled actual renderer Provider/Holder/stream/transport, no Main/model HTTP claim"
        },
        null,
        2
      ) + "\n",
      { flag: "wx" }
    )
    if (failure) console.error(failure)
    else console.log(JSON.stringify({ checks, artifacts }))
  })
