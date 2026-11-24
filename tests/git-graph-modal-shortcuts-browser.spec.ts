import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Run with npx tsx tests/git-graph-modal-shortcuts-browser.spec.ts.
async function main(): Promise<void> {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChatSearchOverlay, useChatSearchShortcut } from "./src/renderer/src/components/chat/ChatSearchOverlay"
import { GitBranchSwitcher } from "./src/renderer/src/components/chat/GitBranchSwitcher"
import { SkillCreateConfirmDialog } from "./src/renderer/src/components/chat/SkillCreateConfirmDialog"
import { UserInputRequestDialog } from "./src/renderer/src/components/chat/UserInputRequestDialog"
import { GitGraphDialog } from "./src/renderer/src/components/git/GitGraphDialog"
import { ThreadSearchDialog } from "./src/renderer/src/components/search/ThreadSearchDialog"

const commits = Array.from({ length: 50 }, (_, index) => ({
  hash: 'commit-' + index,
  subject: 'Fixture commit ' + index,
  parents: index === 49 ? [] : ['commit-' + (index + 1)],
  timestamp: 0,
  author: 'Test',
  refs: []
}))
const question = {
  requestId: "workbench-pending-request",
  threadId: "thread",
  createdAt: Date.now(),
  questions: [{ id: "question", question: "Pending workbench question", options: [] }]
}

window.api = {
  git: {
    currentBranch: async () => ({ isGitRepo: true, branch: "main", isWorktree: false, isInsideWorkTree: true }),
    listBranchMenu: async () => ({ success: true, branch: "main", local: "main", remote: "" }),
    getChangedFileCount: async () => 0,
    cancelBranchList: async () => {},
    cancelBranchProbe: async () => {},
    getCommitGraph: async () => ({ commits, hasMore: false }),
    cancelCommitGraph: async () => {}
  },
  threads: {}
}
window.questionResponses = []
window.skillResponses = []
const canOpenChatSearch = () => true
const getViewport = () => null
const getSearchCorpus = () => ({ stableDocuments: [], dynamicDocuments: [], dynamicMessageIds: new Set() })
const onRevealMessage = () => {}

function App() {
  const chatRoot = useRef(null)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [request, setRequest] = useState(null)
  const [skillRequest, setSkillRequest] = useState(null)
  useChatSearchShortcut(chatRoot, canOpenChatSearch, setChatSearchOpen)
  window.receiveQuestion = () => setRequest(question)
  window.receiveSkillApproval = (requestId) => setSkillRequest({
    requestId, skillId: "test-skill", name: "Test skill",
    description: "An agent workflow", content: "# Test skill"
  })
  return <div ref={chatRoot}>
    <button onClick={() => setShowGraph(true)}>打开 Git 图谱</button>
    <GitBranchSwitcher workspacePath="/repo" environmentRailCollapsed={false} />
    <ChatSearchOverlay open={chatSearchOpen} onClose={() => setChatSearchOpen(false)}
      getViewport={getViewport} getSearchCorpus={getSearchCorpus} onRevealMessage={onRevealMessage}
      recomputeKey={0} />
    {showGraph && <GitGraphDialog cwd="/repo" onClose={() => setShowGraph(false)} />}
    <ThreadSearchDialog activateChat={() => {}} />
    <UserInputRequestDialog request={request} onSubmit={(response) => {
      window.questionResponses.push(response)
      setRequest(null)
    }} />
    <SkillCreateConfirmDialog request={skillRequest} onApprove={(id) => {
      window.skillResponses.push([id, true])
      setSkillRequest(null)
    }} onReject={(id) => {
      window.skillResponses.push([id, false])
      setSkillRequest(null)
    }} />
  </div>
}

createRoot(document.getElementById("root")).render(<App />)
`
    },
    alias: { "@": resolve("src/renderer/src") },
    plugins: [{
      name: "stub-search-data",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/(thread-context|store)$/ }, ({ path }) => ({
          path,
          namespace: "search-data"
        }))
        builder.onLoad({ filter: /.*/, namespace: "search-data" }, ({ path }) => ({
          contents: path.endsWith("/store") ? `
const state = { currentThreadId: null, threads: [], showCustomizeView: false };
export const useAppStore = select => select(state);
useAppStore.getState = () => state;
export const adoptThreadSearchSummary = () => {};
export const isThreadDeletionPending = () => false;
` : "export const useThreadStateSelector = () => undefined;"
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
    const pageErrors: Error[] = []
    page.on("pageerror", (error) => pageErrors.push(error))
    page.setDefaultTimeout(5000)
    await page.setContent('<main id="root"></main>')
    await page.addStyleTag({ path: resolve("src/renderer/src/components/chat/git-branch-menu.css") })
    await page.addStyleTag({ content: `
      [aria-label="提交历史"] { height: 280px; overflow: auto }
      [aria-label="提交历史"] .relative { position: relative }
      [aria-label="提交历史"] .absolute { position: absolute; left: 0 }
      [aria-label="提交历史"] button { display: block }
    ` })
    await page.addScriptTag({ content: outputFiles[0].text })

    const trigger = page.getByRole("button", { name: "打开 Git 图谱" })
    const graph = page.locator("[popover] [role=dialog]")
    const refresh = graph.getByRole("button", { name: "刷新 Git 图谱" })
    const close = graph.getByRole("button", { name: "关闭 Git 图谱" })
    const searchInput = page.locator('input[aria-label="搜索会话"]')
    const chatSearchInput = page.getByPlaceholder("在当前会话中搜索")
    const pendingQuestion = page.getByText("Pending workbench question", { exact: true })
    const shortcut = () => page.keyboard.press("Control+Shift+F")
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const list = document.querySelector<HTMLElement>('[aria-label="提交历史"]')
        if (!list) return
        const count = list.querySelectorAll("button").length
        if (!count) return
        observer.disconnect()
        document.documentElement.dataset.initialGraphRows = String(count)
        const drawings = list.querySelectorAll<SVGSVGElement>('svg[aria-label="Git 提交图"]')
        document.documentElement.dataset.initialGraphDrawingMatchesRows = String(
          drawings.length === 1 && drawings[0].viewBox.baseVal.height === count * 42 &&
          drawings[0].querySelectorAll("circle").length === count + 1
        )
        // Scroll while the first batch is still the only batch in the DOM.
        list.scrollTop = 22 * 42
        list.dispatchEvent(new Event("scroll"))
        document.documentElement.dataset.graphScrollReady = String(
          [...list.querySelectorAll("button span")].some((node) => node.textContent === "Fixture commit 22")
        )
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.matches('button[aria-label="刷新 Git 图谱"][autofocus]'))
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#root button")?.focus())
    assert.equal(await refresh.evaluate((button) => button === document.activeElement), true)
    await page.keyboard.press("Shift+Tab")
    assert.equal(await close.evaluate((button) => button === document.activeElement), true)
    await page.keyboard.press("Tab")
    assert.equal(await refresh.evaluate((button) => button === document.activeElement), true)
    await page.locator('html[data-initial-graph-rows]').waitFor({ state: "attached" })
    const firstBatchRows = Number(await page.locator("html").getAttribute("data-initial-graph-rows"))
    assert.ok(firstBatchRows > 0 && firstBatchRows < 9, "the first frame contains a partial viewport")
    assert.equal(await page.locator("html").getAttribute("data-initial-graph-drawing-matches-rows"), "true")
    assert.equal(await page.locator("html").getAttribute("data-graph-scroll-ready"), "true")
    await shortcut()
    await page.keyboard.press("Control+f")
    await page.keyboard.press("Meta+f")
    assert.equal(await searchInput.count(), 0)
    assert.equal(await chatSearchInput.count(), 0)
    assert.equal(await graph.evaluate((node) => node.contains(document.activeElement)), true)
    await page.evaluate("window.receiveQuestion()")
    await pendingQuestion.waitFor({ state: "attached" })
    await page.keyboard.press("Escape")
    await graph.waitFor({ state: "detached" })
    assert.equal(await chatSearchInput.count(), 0)
    assert.equal(await page.evaluate("window.questionResponses.length"), 0)

    await trigger.click()
    const history = graph.getByRole("region", { name: "提交历史" })
    const firstCommit = history.getByRole("button", { name: /Fixture commit 0/ })
    await history.getByRole("button", { name: /Fixture commit 9/ }).waitFor()
    await firstCommit.focus()
    await history.hover()
    await page.mouse.wheel(0, 1000)
    await firstCommit.waitFor({ state: "detached" })
    assert.ok(await history.evaluate((node) => node.scrollTop > 0))
    // A focused commit can disappear after a scroll. Exercise Escape with focus on the document.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    assert.equal(await graph.evaluate((node) => node.contains(document.activeElement)), false)
    await page.keyboard.press("Control+f")
    assert.equal(await chatSearchInput.count(), 0)
    await page.keyboard.press("Escape")
    await graph.waitFor({ state: "detached" })
    assert.equal(await page.evaluate("window.questionResponses.length"), 0)

    await page.keyboard.press("Escape")
    await pendingQuestion.waitFor({ state: "detached" })
    assert.equal(await page.evaluate("window.questionResponses[0].ignored"), true)

    await trigger.click()
    await refresh.focus()
    await page.evaluate("window.receiveSkillApproval('graph-skill-request')")
    await graph.waitFor({ state: "detached" })
    const skillApproval = page.getByRole("dialog", { name: "保存为技能？" })
    await skillApproval.waitFor()
    assert.equal(await skillApproval.evaluate((node) => node.contains(document.activeElement)), true)
    assert.deepEqual(await page.evaluate("window.skillResponses"), [])
    await page.keyboard.press("Escape")
    await skillApproval.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.skillResponses"), [["graph-skill-request", false]])

    await page.getByRole("button", { name: "切换 Git 分支" }).click()
    const branchMenu = page.locator(".git-branch-menu")
    await branchMenu.locator("svg.lucide-search").click()
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true)
    await page.evaluate("window.receiveSkillApproval('branch-skill-request')")
    await branchMenu.waitFor({ state: "hidden" })
    await skillApproval.waitFor()
    assert.equal(await skillApproval.evaluate((node) => node.contains(document.activeElement)), true)
    assert.deepEqual(await page.evaluate("window.skillResponses"), [["graph-skill-request", false]])
    await page.keyboard.press("Escape")
    await skillApproval.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.skillResponses"), [
      ["graph-skill-request", false], ["branch-skill-request", false]
    ])

    await shortcut()
    await searchInput.waitFor()
    await shortcut()
    assert.equal(await searchInput.evaluate((input) => input === document.activeElement), true)
    await page.keyboard.press("Escape")
    await searchInput.waitFor({ state: "detached" })
    await page.keyboard.press("Control+f")
    await chatSearchInput.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "在当前会话中搜索")
    await page.keyboard.press("Escape")
    await chatSearchInput.waitFor({ state: "detached" })
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
