import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

declare global {
  interface Window {
    panelFixture: {
      records: Array<{ threadId: string; files: string[] }>
      previews: string[]
      requests: { catalogs: number; lsp: number; fileScans: number; ensureWatching: number }
      activeAgentTimers: number
      lspListenerCount: number
      restartWatcherOnNextCheck?: boolean
      completeWrite: (name: string) => void
      addReportedFile: () => void
      reportedFileTreeReady: () => boolean
      finishClose: (success: boolean, id?: string) => void
      switchThread: (threadId?: string) => void
      setModalOpen: (open: boolean) => void
      requestBrowserPanel: (threadId: string) => void
      setBrowserOpen: (open: boolean) => void
      setBtwVisible: (visible: boolean) => void
      setMainComposerVisible: (visible: boolean) => void
      launchedModel?: string
    }
  }
}

async function main(): Promise<void> {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { RightPanel } from "./src/renderer/src/components/panels/RightPanel"
import { BtwPane } from "./src/renderer/src/components/panels/BtwPane"
import { useMainComposerActionsRef } from "./src/renderer/src/components/chat/use-floating-chat-layout"
import { ResourcePanelOverlay } from "./src/renderer/src/components/panels/ResourcePanelOverlay"
import { openResourcePanelOverlay } from "./src/renderer/src/lib/resource-panel-overlay-events"
import { openBtw, useBtwChat } from "@/lib/btw-chat"
import { useAppStore } from "@/lib/store"
import { setFixtureStream, addReportedFile, reportedFileTreeReady } from "@/lib/thread-context"

const records = []
const previews = []
const requests = { catalogs: 0, lsp: 0, fileScans: 0, ensureWatching: 0 }
const unsubscribe = () => () => {}
const browserListeners = new Set()
const lspListeners = new Set()
const agentTimers = new Set()
const setInterval = window.setInterval.bind(window)
const clearInterval = window.clearInterval.bind(window)
window.setInterval = (callback, delay, ...args) => {
  const timer = setInterval(callback, delay, ...args)
  if (delay === 1000) agentTimers.add(timer)
  return timer
}
window.clearInterval = timer => {
  agentTimers.delete(timer)
  clearInterval(timer)
}
window.electron = { process: { platform: "linux" } }
window.api = {
  browser: {
    onPanelRequest: listener => {
      browserListeners.add(listener)
      return () => browserListeners.delete(listener)
    },
    setBounds: async () => {},
    disposeAllForRendererUnload: () => {}
  },
  skills: { onChanged: unsubscribe },
  hooks: {
    onChanged: unsubscribe,
    workspace: { onChanged: unsubscribe },
    catalog: { read: async () => { requests.catalogs++; return { relatedSummary: {} } }, cancel: async () => {} }
  },
  lsp: {
    getConfig: async () => { requests.lsp++; return { enabled: false } },
    onChanged: listener => {
      lspListeners.add(listener)
      return () => lspListeners.delete(listener)
    }
  },
  workspace: {
    loadFromDisk: async (threadId, workspacePath) => {
      requests.fileScans++
      return {
        success: true,
        files: [
          { path: "notes.txt", is_dir: false },
          ...Array.from({ length: 240 }, (_, i) => ({
            path: "/large/file-" + String(i).padStart(3, "0") + ".txt",
            is_dir: false
          }))
        ],
        workspacePath
      }
    },
    ensureWatching: async () => {
      requests.ensureWatching++
      const restarted = window.panelFixture.restartWatcherOnNextCheck
      window.panelFixture.restartWatcherOnNextCheck = false
      return { success: true, restarted }
    },
    recordLlmModifiedFiles: async (threadId, files) => records.push({ threadId, files }),
    authorizeToolFilePreview: async ({ toolCallId }) => {
      previews.push(toolCallId)
      return { success: false }
    }
  }
}
window.panelFixture = {
  records, previews, requests, completeWrite, addReportedFile, reportedFileTreeReady,
  get activeAgentTimers() { return agentTimers.size },
  get lspListenerCount() { return lspListeners.size },
  requestBrowserPanel: threadId => {
    for (const listener of browserListeners) listener({ threadId })
  }
}
function completeWrite(name) {
  setFixtureStream(false, [
    { id: "assistant-" + name, role: "assistant", tool_calls: [
      { id: "call-" + name, name: "write_file", args: { path: name, content: "updated" } }
    ] },
    { id: "tool-" + name, role: "tool", tool_call_id: "call-" + name }
  ])
}
function App() {
  const [sideOpen, setSideOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [modal, setModal] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [btwVisible, setBtwVisible] = useState(true)
  const [mainComposerVisible, setMainComposerVisible] = useState(true)
  const mainComposerActionsRef = useMainComposerActionsRef("main", true)
  const focusTab = useBtwChat(state => state.selected.main)
  const visibleBtw = Boolean(btwVisible && focusTab && !browserOpen)
  window.panelFixture.switchThread = (threadId = "other") => { useAppStore.getState().currentThreadId = threadId }
  window.panelFixture.setModalOpen = setModal
  window.panelFixture.setBrowserOpen = setBrowserOpen
  window.panelFixture.setBtwVisible = setBtwVisible
  window.panelFixture.setMainComposerVisible = setMainComposerVisible
  return <>
    <button onClick={() => setSideOpen(!sideOpen)}>{sideOpen ? "Close side" : "Open side"}</button>
    <button onClick={() => setFixtureStream(true, [])}>Start write</button>
    <button onClick={() => openResourcePanelOverlay("browser")}>Open parent browser</button>
    <RightPanel threadId="main" moduleMode={browserOpen ? "browser" : sideOpen ? "btw" : "work"} />
    {sideOpen && <textarea aria-label="Side composer" />}
    <button onClick={() => { setFull(false); void openBtw() }}>Open focus fixture</button>
    <button onClick={() => { void openBtw() }}>Append focus fixture</button>
    <button>Other control</button>
    {mainComposerVisible && <div data-chat-surface="default" data-chat-thread-id="main" style={focusTab && full ? { display: "none" } : undefined}>
      <textarea aria-label="Main composer" className="composer-textarea" />
      <div ref={mainComposerActionsRef} data-composer-actions style={{ height: 40 }} />
    </div>}
    {visibleBtw && <BtwPane parentId="main" full={full} toggleFull={() => setFull(!full)} />}
    <ResourcePanelOverlay renderedMainView="thread" renderedPanelThreadId="main" isAgentFocusActive={false}
      btwPaneVisible={visibleBtw} />
    {modal && <div role="dialog" data-cmb-modal-dialog="true" data-state="open">Fixture modal</div>}
  </>
}
createRoot(document.getElementById("root")).render(<App />)
`
    },
    alias: { "@": resolve("src/renderer/src") },
    plugins: [{
      name: "stub-right-panel-data",
      setup(builder) {
        builder.onResolve({
          filter: /^(?:\.\.\/chat\/ChatContainer|@\/(?:lib\/(?:btw-chat|store|thread-context)|components\/(?:tabs\/FileViewer|panels\/(?:GitPanelView|SubagentPanel|SystemConstraintsPanel)|browser\/BrowserPanel|customize\/(?:LspPanel|ProjectPluginDevelopmentGuide))))$/
        }, ({ path }) => ({ path, namespace: "right-panel-data" }))
        builder.onLoad({ filter: /.*/, namespace: "right-panel-data" }, ({ path }) => ({
          contents: path.endsWith("/btw-chat") ? `
import { create } from "zustand"
export const useBtwChat = create(() => ({ selected: {}, tabs: [] }))
export async function openBtw(parentId, modelId) {
  if (parentId) window.panelFixture.launchedModel = modelId
  const number = useBtwChat.getState().tabs.length + 1
  const id = "side-" + number
  useBtwChat.setState(({ tabs }) => {
    return { selected: { main: id }, tabs: [...tabs, { id, parentId: "main", number }] }
  })
  return id
}
const pendingCloses = new Map()
export async function closeBtw(id) {
  if (pendingCloses.has(id)) return
  window.panelFixture.finishClose = (success, target) => {
    if (target) pendingCloses.get(target)?.(success)
    else pendingCloses.forEach(resolve => resolve(success))
  }
  useBtwChat.setState(({ tabs }) => ({ tabs: tabs.map(tab => tab.id === id ? { ...tab, closeState: "closing" } : tab) }))
  const success = await new Promise(resolve => { pendingCloses.set(id, resolve) })
  pendingCloses.delete(id)
  useBtwChat.setState(({ selected, tabs }) => {
    if (!success) return { tabs: tabs.map(tab => tab.id === id ? { ...tab, closeState: "failed" } : tab) }
    const remaining = tabs.filter(tab => tab.id !== id)
    const active = selected.main === id ? remaining.at(-1)?.id : selected.main
    return { selected: active ? { main: active } : {}, tabs: remaining }
  })
}
export const loadBtwThread = async () => null
export const retryBtwSkillGeneration = async () => {}
` : path.endsWith("/store") ? `
const state = { currentThreadId: "main", mainView: "thread", threads: [], sideThreads: new Map([["side-1", {}], ["side-2", {}]]), skillGenerationByThread: new Map(),
  setRightModule: mode => {
    window.panelFixture.setBrowserOpen(mode === "browser")
  } }
export const useAppStore = select => select(state)
useAppStore.getState = () => state
useAppStore.setState = patch => Object.assign(state, patch)
export const selectSkillGenerationAgent = () => ({ phase: null })
export const selectSkillRetryContext = () => null
` : path.endsWith("/thread-context") ? `
import { useSyncExternalStore } from "react"
import { mergeWorkspaceStreamFiles } from "./src/renderer/src/lib/workspace-file-load"
import { getWorkspaceFileTreeProjection } from "./src/renderer/src/lib/workspace-file-tree-projection"
const listeners = new Set()
let state = {
  currentModel: "custom:parent-model", workspacePath: "/parent-workspace", workspaceFiles: [],
  coordinatorWorkers: [{
    worker_id: "worker-1", worker_thread_id: "worker-thread", parent_thread_id: "main", role: "implementer",
    workload: "write", owned_files: ["notes.txt"], description: "Running fixture worker", status: "running",
    turns: 1, created_at: new Date().toISOString(), tool_call_count: 0, last_event: "running"
  }]
}
let stream = { isLoading: false, messages: [] }
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
export const useThreadStream = () => useSyncExternalStore(subscribe, () => stream)
export const useThreadStateSelector = (id, selector) => {
  const snapshot = useSyncExternalStore(subscribe, () => state)
  return selector(id?.startsWith("side-") ? { ...snapshot, workspacePath: "/side-workspace" } : snapshot)
}
export const useThreadContext = () => ({ getThreadState: () => state, subscribeToThreadState: (_, notify) => subscribe(notify) })
const actions = {
  setWorkspacePath: () => {},
  setWorkspaceFiles: workspaceFiles => {
    if (state.workspaceFiles === workspaceFiles) return
    state = { ...state, workspaceFiles }
    for (const listener of listeners) listener()
  }
}
export const useThreadActions = () => actions
let reportedFiles
export function addReportedFile() {
  reportedFiles = mergeWorkspaceStreamFiles(state.workspaceFiles, [{path: "/reported.txt", is_dir: false}])
  actions.setWorkspaceFiles(reportedFiles)
}
export function reportedFileTreeReady() {
  return Boolean(reportedFiles && getWorkspaceFileTreeProjection(reportedFiles))
}
export function setFixtureStream(isLoading, messages) {
  stream = { isLoading, messages }
  for (const listener of listeners) listener()
}
` : `
import { createElement, useEffect, useState } from "react"
import { createPortal } from "react-dom"
export const ChatContainer = () => null
export const focusBtwPaneComposer = () => {}
export const prepareBtwComposerFocus = () => () => {}
export const FileViewer = () => null
export const GitPanelView = () => null
export const SubagentCard = () => null
export const SystemConstraintsPanel = () => null
export const getSystemConstraintsLoadCounts = () => ({})
export const BrowserPanel = ({ threadId, workspacePath }) => createElement("div", {
  "data-testid": "browser-panel-ready", "data-thread-id": threadId, "data-workspace-path": workspacePath
})
export function LspPanel() {
  useEffect(() => window.api.lsp.onChanged(() => {}), [])
  return createElement("div", { "data-testid": "lsp-panel-fixture" })
}
export function ProjectPluginDevelopmentGuide() {
  const [open, setOpen] = useState(false)
  return createElement("div", null,
    createElement("button", { onClick: () => setOpen(true) }, "Guide"),
    open && createPortal(createElement("div", { role: "dialog" }, "Workspace guide"), document.body)
  )
}
`,
          resolveDir: resolve(".")
        }))
      }
    }],
    bundle: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage()
    const errors: Error[] = []
    page.on("pageerror", error => errors.push(error))
    await page.setContent('<style>[data-testid="workspace-info-panel"] { height: 720px }</style><div id="root"></div>')
    await page.addScriptTag({ content: outputFiles[0].text })
    await page.getByRole("button", { name: "任务" }).click()
    await page.getByText("暂无任务").waitFor()
    await page.waitForFunction(() => window.panelFixture.requests.catalogs === 2 && window.panelFixture.requests.lsp === 1)
    const workPanel = page.getByTestId("workspace-info-panel")
    const workPanelNode = await workPanel.elementHandle()
    const assertSameWorkPanel = async () => {
      assert.equal(await workPanel.evaluate((node, original) => node === original, workPanelNode), true)
    }
    await page.getByRole("button", { name: "Guide" }).dispatchEvent("click")
    const guideDialog = page.getByRole("dialog").filter({ hasText: "Workspace guide" })
    await guideDialog.waitFor()
    await page.getByRole("button", { name: "Open side" }).click()
    await workPanel.waitFor({ state: "hidden" })
    await assertSameWorkPanel()
    await guideDialog.waitFor({ state: "detached" })
    const composer = page.getByRole("textbox", { name: "Side composer" })
    for (const [index, name] of ["first.md", "second.md"].entries()) {
      await page.getByRole("button", { name: "Start write" }).click()
      await composer.focus()
      await page.evaluate(file => window.panelFixture.completeWrite(file), name)
      await page.waitForFunction(count => window.panelFixture.records.length === count, index + 1)
      assert.equal(await composer.evaluate(element => document.activeElement === element), true)
    }
    await page.getByRole("button", { name: "Close side" }).click()
    await page.getByText("暂无任务").waitFor()
    await assertSameWorkPanel()
    const { records, previews } = await page.evaluate(() => {
      const { records, previews } = window.panelFixture
      return { records, previews }
    })
    assert.deepEqual(records, [
      { threadId: "main", files: ["first.md"] },
      { threadId: "main", files: ["second.md"] }
    ])
    assert.deepEqual(previews, [])

    await page.getByRole("button", { name: "文件", exact: false }).click()
    const file = workPanel.getByText("notes.txt", { exact: true })
    await file.waitFor()
    const fileNode = await file.elementHandle()
    await page.getByRole("button", { name: "Open side" }).click()
    await workPanel.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "Close side" }).click()
    await file.waitFor()
    assert.equal(await file.evaluate((node, original) => node === original, fileNode), true)
    await page.waitForFunction(() => window.panelFixture.requests.ensureWatching >= 1)
    assert.deepEqual(await page.evaluate(() => window.panelFixture.requests), {
      catalogs: 2, lsp: 1, fileScans: 1, ensureWatching: 1
    })

    await workPanel.getByText("large", { exact: true }).click()
    await workPanel.getByRole("button", { name: "下一页" }).click()
    const secondPageRow = workPanel.getByText("file-220.txt", { exact: true })
    const secondPageNode = await secondPageRow.elementHandle()
    assert.ok(secondPageNode)
    await page.getByRole("button", { name: "Open side" }).click()
    await workPanel.waitFor({ state: "hidden" })
    await page.evaluate(async () => {
      window.panelFixture.addReportedFile()
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    assert.equal(await page.evaluate(() => window.panelFixture.reportedFileTreeReady()), false)
    assert.equal(await secondPageNode.evaluate((node) => node.isConnected), true)
    await page.getByRole("button", { name: "Close side" }).click()
    await workPanel.getByText("reported.txt", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.panelFixture.reportedFileTreeReady()), true)
    assert.equal(await secondPageRow.evaluate((node, original) => node === original, secondPageNode), true)
    await page.getByRole("button", { name: "Open side" }).click()
    await workPanel.waitFor({ state: "hidden" })
    await page.evaluate(() => { window.panelFixture.restartWatcherOnNextCheck = true })
    assert.equal(await page.evaluate(() => window.panelFixture.requests.fileScans), 1)
    await page.getByRole("button", { name: "Close side" }).click()
    await page.waitForFunction(() => window.panelFixture.requests.fileScans === 2)
    await file.waitFor()

    await workPanel.getByRole("button", { name: /^代理/ }).click()
    await workPanel.getByRole("button", { name: "更多信息" }).click()
    await page.waitForFunction(() => window.panelFixture.activeAgentTimers === 1)
    await page.getByRole("button", { name: "Open side" }).click()
    await workPanel.waitFor({ state: "hidden" })
    await page.waitForFunction(() => window.panelFixture.activeAgentTimers === 0, undefined, { timeout: 2000 })
    await page.getByRole("button", { name: "Close side" }).click()
    await workPanel.getByRole("button", { name: "收起细节" }).waitFor()
    await page.waitForFunction(() => window.panelFixture.activeAgentTimers === 1)

    await workPanel.getByRole("button", { name: /^LSP/ }).click()
    const lspPanel = workPanel.getByTestId("lsp-panel-fixture")
    await lspPanel.waitFor({ state: "attached" })
    await page.waitForFunction(() => window.panelFixture.lspListenerCount === 2)
    await page.getByRole("button", { name: "Open side" }).click()
    await lspPanel.waitFor({ state: "detached" })
    await page.waitForFunction(() => window.panelFixture.lspListenerCount === 1)
    await page.getByRole("button", { name: "Close side" }).click()
    await lspPanel.waitFor({ state: "attached" })
    await page.waitForFunction(() => window.panelFixture.lspListenerCount === 2)

    const mainComposer = page.getByRole("textbox", { name: "Main composer" })
    const otherControl = page.getByRole("button", { name: "Other control" })
    const openFocusFixture = async () => {
      await page.getByRole("button", { name: "Open focus fixture" }).click()
      const close = page.getByRole("button", { name: "关闭 辅助对话 1" })
      await close.waitFor()
      return close
    }
    const settleClose = async () => {
      await page.evaluate(() => window.panelFixture.finishClose(true))
      await page.locator("[data-btw-pane]").waitFor({ state: "detached" })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }

    const mainActions = page.locator('[data-chat-surface="default"] [data-composer-actions]')
    const waitForToolbarHeight = (height: string) => page.waitForFunction(expected =>
      document.querySelector<HTMLElement>("[data-btw-pane]")?.style.getPropertyValue("--btw-toolbar-height") === expected,
      height
    )
    await page.evaluate(() => window.panelFixture.setMainComposerVisible(false))
    await mainActions.waitFor({ state: "detached" })
    let close = await openFocusFixture()
    await waitForToolbarHeight("")
    await page.evaluate(() => window.panelFixture.setMainComposerVisible(true))
    await waitForToolbarHeight("40px")
    for (const height of [46, 40]) {
      await mainActions.evaluate((el, size) => { el.style.height = size + "px" }, height)
      await waitForToolbarHeight(height + "px")
    }
    await page.evaluate(() => window.panelFixture.setMainComposerVisible(false))
    await waitForToolbarHeight("")
    await page.evaluate(() => window.panelFixture.setMainComposerVisible(true))
    await waitForToolbarHeight("40px")
    await page.getByRole("button", { name: "进入完整视图" }).click()
    assert.equal(await mainComposer.isVisible(), false)
    await waitForToolbarHeight("")
    await close.press("Enter")
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await page.getByRole("button", { name: "Append focus fixture" }).click()
    await close.click()
    await page.getByRole("button", { name: "辅助对话 2", exact: true }).click({ button: "right" })
    await page.getByRole("menuitem", { name: "关闭所有标签页", exact: true }).click()
    await page.evaluate(() => window.panelFixture.finishClose(true, "side-2"))
    await page.locator('[data-btw-pane="side-1"]').waitFor()
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    // Two separate close clicks can overlap, and either acknowledgement can arrive first.
    for (const activeFirst of [false, true]) {
      for (const firstAck of ["side-1", "side-2"]) {
        const background = await openFocusFixture()
        await page.getByRole("button", { name: "Append focus fixture" }).click()
        const active = page.getByRole("button", { name: "关闭 辅助对话 2" })
        for (const button of activeFirst ? [active, background] : [background, active]) {
          await button.click()
        }
        await page.evaluate(id => window.panelFixture.finishClose(true, id), firstAck)
        await settleClose()
        assert.equal(await mainComposer.evaluate(el => document.activeElement === el), true)
      }
    }

    close = await openFocusFixture()
    await page.getByRole("button", { name: "搜索标签页" }).click()
    const tabSearch = page.locator("[data-btw-tab-search]")
    await tabSearch.getByRole("button", { name: "关闭 辅助对话 1" }).click()
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await page.getByRole("button", { name: "辅助对话 1", exact: true }).click({ button: "right" })
    await page.getByRole("menuitem", { name: "关闭标签页", exact: true }).click()
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await page.getByRole("button", { name: "Append focus fixture" }).click()
    await page.getByRole("button", { name: "辅助对话 2", exact: true }).click({ button: "right" })
    await page.getByRole("menuitem", { name: "关闭所有标签页", exact: true }).click()
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await close.press("Enter")
    await otherControl.focus()
    await settleClose()
    assert.equal(await otherControl.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await close.press("Enter")
    await page.evaluate(() => window.panelFixture.finishClose(false))
    const retry = page.getByRole("button", { name: "重试关闭" })
    await retry.waitFor()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), false)
    await retry.press("Enter")
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), true)

    close = await openFocusFixture()
    await close.press("Enter")
    await page.evaluate(() => window.panelFixture.setModalOpen(true))
    const modal = page.locator("[data-cmb-modal-dialog]")
    await modal.waitFor()
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), false)

    await page.evaluate(() => window.panelFixture.setModalOpen(false))
    close = await openFocusFixture()
    await close.press("Enter")
    await page.evaluate(() => window.panelFixture.switchThread())
    await settleClose()
    assert.equal(await mainComposer.evaluate(element => document.activeElement === element), false)

    await page.evaluate(() => window.panelFixture.switchThread("main"))
    await openFocusFixture()
    await page.getByRole("button", { name: "新增标签" }).click()
    await page.getByText("在侧边面板中继续对话。", { exact: true }).click()
    await page.waitForFunction(() => window.panelFixture.launchedModel === "custom:parent-model")
    const browserReady = page.getByTestId("browser-panel-ready")
    const requestBrowser = (id: string) => page.evaluate(threadId => window.panelFixture.requestBrowserPanel(threadId), id)
    const browserOwner = () => browserReady.evaluate(element => [element.dataset.threadId, element.dataset.workspacePath])
    const sidePane = page.locator('[data-btw-pane="side-2"]')
    await sidePane.waitFor()
    const sideTab = sidePane.getByRole("button", { name: "辅助对话 2", exact: true })
    await sideTab.focus()
    await requestBrowser("side-1")
    await requestBrowser("other")
    await requestBrowser("main")
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await browserReady.count(), 0, "automatic requests cannot displace the active side chat")
    assert.equal(await sideTab.evaluate(element => document.activeElement === element), true)
    await requestBrowser("side-2")
    await page.getByRole("dialog", { name: "内置浏览器" }).getByTestId("browser-panel-ready").waitFor({ state: "attached" })
    assert.deepEqual(await browserOwner(), ["side-2", "/side-workspace"])
    await requestBrowser("main")
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await browserOwner(), ["side-2", "/side-workspace"])

    await page.getByRole("button", { name: "Open parent browser" }).click()
    await browserReady.waitFor({ state: "attached" })
    assert.deepEqual(await browserOwner(), ["main", "/parent-workspace"])
    await page.evaluate(() => {
      window.panelFixture.setBrowserOpen(false)
      window.panelFixture.setBtwVisible(false)
    })
    await browserReady.waitFor({ state: "detached" })
    await page.locator("[data-btw-pane]").waitFor({ state: "detached" })
    await requestBrowser("side-2")
    assert.equal(await browserReady.count(), 0, "a hidden auxiliary conversation cannot open the browser")
    await requestBrowser("main")
    await browserReady.waitFor({ state: "attached" })
    assert.deepEqual(await browserOwner(), ["main", "/parent-workspace"])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
