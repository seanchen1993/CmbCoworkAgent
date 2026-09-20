/**
 * Real Electron E2E for tool-file source preview and isolated workspace HTML/JavaScript UI.
 *
 * Run:
 *   npm run test:workspace-html:e2e
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm as rmAsync } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from "playwright"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const ELECTRON_PACKAGE_ROOT = dirname(require.resolve("electron/package.json"))
const ELECTRON_BINARY = join(
  ELECTRON_PACKAGE_ROOT,
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
)
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : ELECTRON_BINARY
const MAIN_ENTRY = join(PROJECT_ROOT, "out", "main", "index.js")
const THREAD_TITLE = `Workspace HTML source E2E ${process.pid}-${Date.now()}`
const LINKED_BRANCH = "workspace-html-e2e-linked-worktree"
const LAYOUT_FILE_NAME = "source-proof.html"
const LAYOUT_TOOL_CALL_ID = "workspace-preview-layout-read"
const UNAUTHORIZED_FILE_NAME = "outside-secret.html"
const UNAUTHORIZED_TOOL_CALL_ID = "workspace-preview-unauthorized-read"
const STATIC_STYLE_FILE_NAME = "source-proof.css"
const BLOCKED_PREVIEW_ORIGIN = "https://preview-security.invalid"
const PREVIEW_START_SENTINEL = "PREVIEW_START_SENTINEL"
const PREVIEW_END_SENTINEL = "PREVIEW_END_SENTINEL"
const HTML_FIXTURES = [
  {
    fileName: "source-proof.html",
    sentinel: "HTML_SOURCE_SENTINEL",
    testId: "workspace-html-source-ui",
    expectedDisplay: "flex",
    expectedBackground: "rgb(17, 34, 51)",
    expectedBorderRadius: "18px"
  },
  {
    fileName: "legacy-proof.HTM",
    sentinel: "HTM_SOURCE_SENTINEL",
    testId: "workspace-html-legacy-ui",
    expectedDisplay: "grid",
    expectedBackground: "rgb(51, 34, 17)",
    expectedBorderRadius: "12px"
  }
] as const

interface WindowWithApi {
  api: {
    threads: {
      list: () => Promise<Array<{ thread_id?: string; id?: string; title?: string }>>
      create: (metadata?: Record<string, unknown>) => Promise<{
        id?: string
        thread_id?: string
        threadId?: string
      }>
      delete: (threadId: string) => Promise<void>
      appendMessages: (
        threadId: string,
        messages: Array<Record<string, unknown>>
      ) => Promise<{ count: number }>
    }
    workspace: {
      set: (threadId: string, workspacePath: string) => Promise<unknown>
      loadFromDisk: (
        threadId: string,
        workspacePath?: string
      ) => Promise<{
        success: boolean
        files: Array<{ path: string; is_dir: boolean }>
        error?: string
      }>
    }
  }
}

function log(message: string): void {
  console.log(`[workspace-html-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  log(`PASS ${message}`)
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null"
    }
  }).trim()
}

function initializeRepository(mainRepository: string, linkedWorktree: string): void {
  mkdirSync(mainRepository, { recursive: true })
  git(mainRepository, ["init", "-q"])
  git(mainRepository, ["config", "user.name", "Workspace HTML E2E"])
  git(mainRepository, ["config", "user.email", "workspace-html-e2e@example.invalid"])
  writeFileSync(join(mainRepository, "tracked.txt"), "initial\n")
  git(mainRepository, ["add", "tracked.txt"])
  git(mainRepository, ["commit", "-q", "-m", "initial"])
  git(mainRepository, ["worktree", "add", "-q", "-b", LINKED_BRANCH, linkedWorktree])
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createElectronEnvironment(paths: {
  isolatedHome: string
  appData: string
  localAppData: string
  openworkHome: string
  isolatedTemp: string
  xdgConfigHome: string
  xdgCacheHome: string
  xdgDataHome: string
}): NodeJS.ProcessEnv {
  const allowedKeys = new Set(
    [
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "SHELL"
    ].map((key) => key.toLowerCase())
  )
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedKeys.has(key.toLowerCase())) environment[key] = value
  }
  Object.assign(environment, {
    HOME: paths.isolatedHome,
    USERPROFILE: paths.isolatedHome,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    CMB_COWORK_AGENT_HOME: paths.openworkHome,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: ELECTRON_BINARY,
    TEMP: paths.isolatedTemp,
    TMP: paths.isolatedTemp,
    TMPDIR: paths.isolatedTemp,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  })
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

async function waitForApi(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => Boolean((window as unknown as Partial<WindowWithApi>).api), {
    timeout: 30_000
  })
}

async function waitForAppPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const candidate of app.windows().reverse()) {
      if (candidate.isClosed()) continue
      const hasApi = await candidate
        .evaluate(() => Boolean((window as unknown as Partial<WindowWithApi>).api))
        .catch(() => false)
      if (hasApi) return candidate
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error("No Electron renderer with preload API appeared within 30 seconds")
}

async function createWorkspaceThread(
  page: Page,
  workspacePath: string,
  unauthorizedFilePath: string
): Promise<string> {
  return page.evaluate<
    string,
    {
      title: string
      workspacePath: string
      layoutFileName: string
      layoutToolCallId: string
      previewStartSentinel: string
      previewEndSentinel: string
      unauthorizedFilePath: string
      unauthorizedToolCallId: string
    }
  >(
    async ({
      title,
      workspacePath,
      layoutFileName,
      layoutToolCallId,
      previewStartSentinel,
      previewEndSentinel,
      unauthorizedFilePath,
      unauthorizedToolCallId
    }) => {
      const api = (window as unknown as WindowWithApi).api
      const thread = await api.threads.create({
        workspacePath,
        model: "custom:workspace-html-e2e-no-model",
        title
      })
      const threadId = thread.thread_id || thread.id || thread.threadId
      if (!threadId) throw new Error(`threads.create returned no id: ${JSON.stringify(thread)}`)
      await api.workspace.set(threadId, workspacePath)
      const workspaceState = await api.workspace.loadFromDisk(threadId, workspacePath)
      const discoveredNames = new Set(
        workspaceState.files.map((file) => file.path.replace(/\\/g, "/").split("/").pop())
      )
      if (
        !workspaceState.success ||
        !["source-proof.html", "legacy-proof.HTM", layoutFileName].every((fileName) =>
          discoveredNames.has(fileName)
        )
      ) {
        throw new Error(
          `Expected HTML fixtures before UI navigation: ${JSON.stringify(workspaceState)}`
        )
      }
      const createdAt = Date.now()
      const appended = await api.threads.appendMessages(threadId, [
        {
          id: "layout-user",
          role: "user",
          content: "请读取布局回归文件",
          created_at: new Date(createdAt)
        },
        {
          id: "layout-assistant-tool-call",
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: layoutToolCallId,
              name: "read_file",
              args: { path: layoutFileName }
            }
          ],
          created_at: new Date(createdAt + 1)
        },
        {
          id: "layout-tool-result",
          role: "tool",
          content: `${previewStartSentinel}\n${previewEndSentinel}`,
          tool_call_id: layoutToolCallId,
          name: "read_file",
          status: "success",
          is_error: false,
          created_at: new Date(createdAt + 2)
        },
        {
          id: "layout-assistant-complete",
          role: "assistant",
          content: "读取完成",
          created_at: new Date(createdAt + 3)
        },
        {
          id: "unauthorized-assistant-tool-call",
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: unauthorizedToolCallId,
              name: "read_file",
              args: { path: unauthorizedFilePath }
            }
          ],
          created_at: new Date(createdAt + 4)
        },
        {
          id: "unauthorized-tool-result",
          role: "tool",
          content: "outside source",
          tool_call_id: unauthorizedToolCallId,
          name: "read_file",
          status: "success",
          is_error: false,
          created_at: new Date(createdAt + 5)
        },
        {
          id: "unauthorized-assistant-complete",
          role: "assistant",
          content: "外部读取完成",
          created_at: new Date(createdAt + 6)
        }
      ])
      if (appended.count !== 7) {
        throw new Error(`Expected seven persisted preview messages, received ${appended.count}`)
      }
      return threadId
    },
    {
      title: THREAD_TITLE,
      workspacePath,
      layoutFileName: LAYOUT_FILE_NAME,
      layoutToolCallId: LAYOUT_TOOL_CALL_ID,
      previewStartSentinel: PREVIEW_START_SENTINEL,
      previewEndSentinel: PREVIEW_END_SENTINEL,
      unauthorizedFilePath,
      unauthorizedToolCallId: UNAUTHORIZED_TOOL_CALL_ID
    }
  )
}

async function selectWorkspaceThread(page: Page): Promise<void> {
  await waitForApi(page)

  const threadEntry = page.getByText(THREAD_TITLE, { exact: true }).first()
  try {
    await threadEntry.waitFor({ timeout: 30_000 })
  } catch (error) {
    const threads = await page.evaluate(async () => {
      return (window as unknown as WindowWithApi).api.threads.list()
    })
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "<body unavailable>")
    const pageState = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      rootHtml: document.querySelector("#root")?.innerHTML ?? null,
      nameHelperType: typeof (globalThis as { __name?: unknown }).__name
    }))
    console.error(`[workspace-html-e2e] threads: ${JSON.stringify(threads)}`)
    console.error(`[workspace-html-e2e] page: ${JSON.stringify(pageState)}`)
    console.error(`[workspace-html-e2e] UI snapshot:\n${bodyText.slice(0, 8_000)}`)
    throw error
  }
  await threadEntry.click()
  await page.waitForTimeout(750)
}

async function openWorkspaceFiles(page: Page, blockedPreviewRequests: string[]): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 })
  await selectWorkspaceThread(page)
  const showRightPanel = page.getByRole("button", { name: "显示右侧面板" })
  if ((await showRightPanel.count()) > 0) await showRightPanel.first().click()

  const workButton = page.getByRole("button", { name: "工作目录" })
  await workButton.waitFor({ timeout: 30_000 })
  if ((await workButton.getAttribute("aria-pressed")) !== "true") await workButton.click()

  const filesHeader = page.getByRole("button", { name: /^文件(?:\s*\d+)?$/ }).first()
  await filesHeader.waitFor({ timeout: 30_000 })
  if ((await filesHeader.getAttribute("aria-expanded")) !== "true") await filesHeader.click()

  for (const fixture of HTML_FIXTURES) {
    const fileEntry = page.getByText(fixture.fileName, { exact: true }).last()
    await fileEntry.waitFor({ timeout: 30_000 })
    await fileEntry.click()

    const iframe = page.locator("iframe.html-preview-light-canvas").last()
    await iframe.waitFor({ state: "visible", timeout: 30_000 })
    const iframeTitle = ((await iframe.getAttribute("title")) ?? "").replace(/\\/g, "/")
    assert(
      iframeTitle === fixture.fileName || iframeTitle.endsWith(`/${fixture.fileName}`),
      `${fixture.fileName} 工作目录入口打开对应 HTML`
    )
    assert(
      (await iframe.getAttribute("sandbox")) === "allow-scripts",
      `${fixture.fileName} 使用脚本可运行的隔离沙箱`
    )

    const frame = iframe.contentFrame()
    const ui = frame.getByTestId(fixture.testId)
    await ui.waitFor({ state: "visible", timeout: 30_000 })
    const style = await ui.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        display: computed.display,
        backgroundColor: computed.backgroundColor,
        borderRadius: computed.borderRadius
      }
    })
    assert(style.display === fixture.expectedDisplay, `${fixture.fileName} 展示 UI 布局样式`)
    assert(
      style.backgroundColor === fixture.expectedBackground,
      `${fixture.fileName} 展示 UI 背景样式`
    )
    assert(
      style.borderRadius === fixture.expectedBorderRadius,
      `${fixture.fileName} 展示 UI 圆角样式`
    )
    assert(
      (await frame.locator("html").getAttribute("data-e2e-executed")) === "true",
      `${fixture.fileName} 执行工作区脚本`
    )
    assert((await frame.locator("script").count()) > 0, `${fixture.fileName} 保留页面脚本`)
    assert((await frame.locator("iframe").count()) === 0, `${fixture.fileName} 移除嵌套页面`)
    assert(
      (await frame.locator('meta[http-equiv="refresh" i]').count()) === 0,
      `${fixture.fileName} 移除自动跳转`
    )
    assert(
      (await page.locator(".shiki-wrapper").filter({ hasText: fixture.sentinel }).count()) === 0,
      `${fixture.fileName} 工作目录入口不展示源码视图`
    )
    if (fixture.fileName === LAYOUT_FILE_NAME) {
      assert((await ui.getAttribute("data-created-by-js")) === "true", "页面主体由本地 JS 创建")
      assert(
        (await frame.locator("body").evaluate((element) => getComputedStyle(element).opacity)) ===
          "1",
        "JS 初始化后展示原本隐藏的页面"
      )
      assert(
        (await frame.locator("html").getAttribute("data-module-ready")) === "true",
        "内联 module 脚本正常执行"
      )
      const button = frame.getByRole("button", { name: "计数 0" })
      await button.click()
      await frame.getByRole("button", { name: "计数 1" }).waitFor({ state: "visible" })
      log("PASS JS 按钮交互更新页面")
      const isolation = await frame.locator("html").evaluate(() => {
        const result = {
          bridge: typeof (window as unknown as { api?: unknown }).api,
          parentReadable: false,
          storageReadable: false
        }
        try {
          result.parentReadable = Boolean(parent.document.body)
        } catch {
          /* opaque origin */
        }
        try {
          result.storageReadable = Boolean(localStorage)
        } catch {
          /* opaque origin */
        }
        return result
      })
      assert(
        isolation.bridge === "undefined" && !isolation.parentReadable && !isolation.storageReadable,
        "JS 无法读取应用 API、父页面及持久存储"
      )

      // Exercise a real script-created link and location assignment. CSP alone does not stop these.
      await frame.getByRole("button", { name: "测试页面跳转" }).click()
      await frame.getByRole("button", { name: "测试动态链接" }).click()
      await page.waitForTimeout(300)
      await ui.waitFor({ state: "visible" })
      assert(blockedPreviewRequests.length === 0, "JS 自身导航和动态链接在发出请求前被阻止")

      for (const viewport of [
        { width: 1500, height: 900 },
        { width: 1200, height: 700 }
      ]) {
        await page.setViewportSize(viewport)
        await waitForStableLayout(page)
        const geometry = await iframe.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          containerHeight: element.parentElement!.clientHeight
        }))
        assert(
          geometry.height > 350 && closeEnough(geometry.height, geometry.containerHeight),
          `工作目录 ${viewport.width}×${viewport.height} 预览填满可用高度，没有上下空白分块`
        )
        const tail = frame.locator("#page-tail")
        await tail.scrollIntoViewIfNeeded()
        const tailVisible = await tail.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return rect.top >= 0 && rect.bottom <= innerHeight
        })
        assert(tailVisible, `工作目录 ${viewport.width}×${viewport.height} 可滚动到 JS 页面末尾`)
        await frame.locator("html").evaluate(() => window.scrollTo(0, 0))
      }
      await page.setViewportSize({ width: 1500, height: 900 })
      const artifactDirectory = join(PROJECT_ROOT, "output", "html-preview")
      mkdirSync(artifactDirectory, { recursive: true })
      await page.screenshot({ path: join(artifactDirectory, "workspace-javascript-preview.png") })

      await page.getByRole("button", { name: "原文", exact: true }).click()
      await page
        .locator(".shiki-wrapper")
        .filter({ hasText: PREVIEW_END_SENTINEL })
        .waitFor({ state: "visible" })
      assert(
        (await page.locator("iframe.html-preview-light-canvas").count()) === 0,
        "工作目录可切换原文并卸载脚本页面"
      )
      await page.getByRole("button", { name: "预览", exact: true }).click()
      await page
        .frameLocator("iframe.html-preview-light-canvas")
        .getByTestId(fixture.testId)
        .waitFor({ state: "visible" })
      log("PASS 从原文切回 JS 页面可重新渲染")
      for (let reopen = 0; reopen < 10; reopen += 1) {
        await page.getByRole("button", { name: "原文", exact: true }).click()
        await page.getByRole("button", { name: "预览", exact: true }).click()
        await page
          .frameLocator("iframe.html-preview-light-canvas")
          .getByRole("button", { name: "计数 0", exact: true })
          .waitFor({ state: "visible" })
      }
      log("PASS 连续切换原文/预览 10 次仍可加载本地 JS，不耗尽依赖预算")
    }
  }

  for (const fileName of ["broken-script.html", "missing-script.html"]) {
    await page.getByText(fileName, { exact: true }).last().click()
    const issue = page.getByTestId("html-preview-issue")
    await issue.waitFor({ state: "visible" })
    assert(
      (await issue.textContent())?.includes(
        fileName === "broken-script.html" ? "脚本运行出错" : "无法加载脚本"
      ),
      `${fileName} 显示可理解的错误原因`
    )
    await page.getByRole("button", { name: "原文", exact: true }).click()
    await page
      .locator(".shiki-wrapper")
      .filter({ hasText: "<script" })
      .waitFor({ state: "visible" })
    log(`PASS ${fileName} 出错后仍可查看原文`)
  }
  assert(blockedPreviewRequests.length === 0, "HTML/JS 预览没有发起外部网络请求")
}

interface PreviewGeometry {
  parent: { top: number; bottom: number; height: number }
  surface: { top: number; bottom: number; height: number }
  root: { top: number; bottom: number; height: number }
  content: { top: number; bottom: number; height: number }
  bottomHitsContent: boolean
}

function closeEnough(left: number, right: number, tolerance = 3): boolean {
  return Math.abs(left - right) <= tolerance
}

async function waitForStableLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
      })
  )
}

async function assertPreviewGeometry(page: Page, scope: Locator, label: string): Promise<void> {
  const surface = scope.getByTestId("resource-preview-surface")
  await surface.waitFor({ state: "visible", timeout: 30_000 })
  await scope.getByTestId("resource-preview").waitFor({ state: "visible", timeout: 30_000 })
  await scope.getByTestId("resource-preview-content").waitFor({ state: "visible", timeout: 30_000 })
  await waitForStableLayout(page)

  const geometry = await surface.evaluate<PreviewGeometry>((surfaceElement) => {
    const parentElement = surfaceElement.parentElement
    const rootElement = surfaceElement.querySelector<HTMLElement>(
      '[data-testid="resource-preview"]'
    )
    const contentElement = surfaceElement.querySelector<HTMLElement>(
      '[data-testid="resource-preview-content"]'
    )
    if (!parentElement || !rootElement || !contentElement) {
      throw new Error("Preview geometry elements are incomplete")
    }
    const parentRect = parentElement.getBoundingClientRect()
    const surfaceRect = surfaceElement.getBoundingClientRect()
    const rootRect = rootElement.getBoundingClientRect()
    const contentRect = contentElement.getBoundingClientRect()
    const hit = document.elementFromPoint(
      contentRect.left + Math.max(1, contentRect.width / 2),
      contentRect.bottom - 2
    )
    return {
      parent: { top: parentRect.top, bottom: parentRect.bottom, height: parentRect.height },
      surface: { top: surfaceRect.top, bottom: surfaceRect.bottom, height: surfaceRect.height },
      root: { top: rootRect.top, bottom: rootRect.bottom, height: rootRect.height },
      content: { top: contentRect.top, bottom: contentRect.bottom, height: contentRect.height },
      bottomHitsContent: Boolean(hit && contentElement.contains(hit))
    }
  })

  assert(closeEnough(geometry.surface.top, geometry.parent.top), `${label} 预览顶部贴合容器`)
  assert(closeEnough(geometry.surface.bottom, geometry.parent.bottom), `${label} 预览底部不越界`)
  assert(closeEnough(geometry.surface.height, geometry.parent.height), `${label} 预览填满容器高度`)
  assert(closeEnough(geometry.root.top, geometry.surface.top), `${label} 文件预览顶部完整`)
  assert(closeEnough(geometry.root.bottom, geometry.surface.bottom), `${label} 文件预览底部完整`)
  assert(closeEnough(geometry.root.height, geometry.surface.height), `${label} 文件预览高度完整`)
  assert(geometry.content.height > geometry.surface.height * 0.7, `${label} 内容区占据主要可用高度`)
  assert(closeEnough(geometry.content.bottom, geometry.surface.bottom), `${label} 内容区延伸到底部`)
  assert(geometry.bottomHitsContent, `${label} 底部不存在独立空白分块`)

  const sourceViewer = scope
    .locator(".shiki-wrapper")
    .filter({ hasText: PREVIEW_END_SENTINEL })
    .last()
  await sourceViewer.waitFor({ state: "visible", timeout: 30_000 })
  const viewport = scope
    .getByTestId("resource-preview-content")
    .locator("[data-radix-scroll-area-viewport]")
    .first()
  await viewport.waitFor({ state: "visible", timeout: 30_000 })
  const scrollMetrics = await viewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }))
  assert(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, `${label} 长文件具有可滚动内容`)
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await waitForStableLayout(page)

  const endLineGeometry = await sourceViewer.evaluate<
    { top: number; bottom: number; contentTop: number; contentBottom: number },
    string
  >((element, sentinel) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const value = node.textContent ?? ""
      const index = value.indexOf(sentinel)
      if (index >= 0) {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + sentinel.length)
        const rect = range.getBoundingClientRect()
        const content = element.closest<HTMLElement>('[data-testid="resource-preview-content"]')
        if (!content) throw new Error("Preview content container is missing")
        const contentRect = content.getBoundingClientRect()
        return {
          top: rect.top,
          bottom: rect.bottom,
          contentTop: contentRect.top,
          contentBottom: contentRect.bottom
        }
      }
      node = walker.nextNode()
    }
    throw new Error(`Sentinel ${sentinel} is missing from highlighted source`)
  }, PREVIEW_END_SENTINEL)
  assert(
    endLineGeometry.top >= endLineGeometry.contentTop - 3 &&
      endLineGeometry.bottom <= endLineGeometry.contentBottom + 3,
    `${label} 滚动到底后末行完整可见`
  )
}

async function assertToolHtmlSource(scope: Locator, label: string): Promise<void> {
  const content = scope.getByTestId("resource-preview-content")
  const sourceViewer = content.locator(".shiki-wrapper").filter({ hasText: "HTML_SOURCE_SENTINEL" })
  await sourceViewer.waitFor({ state: "visible", timeout: 30_000 })
  const sourceText = (await sourceViewer.textContent()) ?? ""
  assert(sourceText.includes("<!doctype html>"), `${label} 会话小眼睛展示 HTML 原文`)
  assert(sourceText.includes("<script>"), `${label} 会话源码保留 script 标签文本`)
  assert(sourceText.includes(PREVIEW_END_SENTINEL), `${label} 会话源码完整到末行`)
  assert((await content.locator("iframe").count()) === 0, `${label} 会话小眼睛不渲染 HTML`)
}

async function openToolFilePreviewLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 })
  await selectWorkspaceThread(page)
  const backToConversation = page.getByRole("button", { name: "返回对话", exact: true })
  if (await backToConversation.isVisible()) await backToConversation.click()

  const showRightPanel = page.getByRole("button", { name: "显示右侧面板" })
  if ((await showRightPanel.count()) > 0) await showRightPanel.first().click()

  const previewEyes = page.getByRole("button", { name: "在右侧资源预览中打开" })
  await previewEyes.first().waitFor({ state: "visible", timeout: 30_000 })
  assert((await previewEyes.count()) === 2, "真实消息中展示两个工具文件预览入口")
  const previewEye = previewEyes.first()
  await previewEye.click()
  await page.waitForFunction(
    () =>
      document.querySelector('button[aria-label="文件预览"]')?.getAttribute("aria-pressed") ===
      "true",
    undefined,
    { timeout: 30_000 }
  )
  await page.getByRole("button", { name: "全屏预览" }).waitFor({ state: "visible" })
  await assertToolHtmlSource(page.locator("body"), "普通右侧栏")
  await assertPreviewGeometry(page, page.locator("body"), "普通右侧栏 1500×900")

  await page.getByRole("button", { name: "隐藏预览并切换到工作目录" }).click()
  await page.getByRole("button", { name: "隐藏右侧面板" }).click()
  await page.setViewportSize({ width: 1200, height: 700 })
  await previewEye.click()

  const dialog = page.getByRole("dialog", { name: "文件预览" })
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  assert(
    (await dialog.getByRole("button", { name: "全屏预览" }).count()) === 0,
    "折叠抽屉不展示失效的全屏操作"
  )
  await assertToolHtmlSource(dialog, "折叠抽屉")
  await assertPreviewGeometry(page, dialog, "折叠抽屉 1200×700")
  await dialog.getByRole("button", { name: "关闭面板" }).click()

  await previewEyes.nth(1).click()
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  await dialog.getByText(UNAUTHORIZED_FILE_NAME, { exact: true }).waitFor({ state: "visible" })
  const revealButton = dialog.getByTestId("resource-preview-reveal")
  assert(await revealButton.isDisabled(), "未授权外部路径不能调用系统文件夹打开操作")
  await dialog
    .getByText("文件预览需要授权", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 })
  log("PASS 未授权外部路径只显示受控拒绝提示")
  await dialog.getByRole("button", { name: "关闭面板" }).click()
}

async function deleteWorkspaceThread(page: Page, threadId: string): Promise<void> {
  await page.evaluate<void, string>(async (id) => {
    await (window as unknown as WindowWithApi).api.threads.delete(id)
  }, threadId)
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY}; run npm run build first`)
  }

  const testRoot = mkdtempSync(join(tmpdir(), "cmb-workspace-html-e2e-"))
  // Third-party Windows IMEs can inherit USERPROFILE and briefly keep their own
  // logs open after Electron exits. Keep that isolated profile outside the
  // per-run root so it neither touches the real profile nor blocks cleanup.
  const profileKey = basename(PROJECT_ROOT).replace(/[^a-zA-Z0-9._-]/g, "-")
  const isolatedHome =
    process.platform === "win32"
      ? join(tmpdir(), "cmb-workspace-html-e2e-os-profile", profileKey)
      : join(testRoot, "home")
  const appData = join(isolatedHome, "AppData", "Roaming")
  const localAppData = join(isolatedHome, "AppData", "Local")
  const openworkHome = join(testRoot, "cmbcoworkagent-home")
  const electronUserData = join(testRoot, "electron-user-data")
  const workspace = join(testRoot, "workspace")
  const unauthorizedFilePath = join(testRoot, UNAUTHORIZED_FILE_NAME)
  const mainRepository = join(workspace, "main")
  const linkedWorktree = join(workspace, "linked")
  const isolatedTemp = join(testRoot, "temp")
  const xdgConfigHome = join(testRoot, "xdg-config")
  const xdgCacheHome = join(testRoot, "xdg-cache")
  const xdgDataHome = join(testRoot, "xdg-data")
  for (const directory of [
    isolatedHome,
    appData,
    localAppData,
    openworkHome,
    workspace,
    isolatedTemp,
    xdgConfigHome,
    xdgCacheHome,
    xdgDataHome
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  initializeRepository(mainRepository, linkedWorktree)
  mkdirSync(join(workspace, "assets"), { recursive: true })
  writeFileSync(
    join(workspace, "assets", "source-proof.js"),
    [
      'const root = document.getElementById("script-root")',
      `root.innerHTML = '<main data-testid="${HTML_FIXTURES[0].testId}" class="workspace-preview-card network-probe" data-created-by-js="true">${HTML_FIXTURES[0].sentinel} · JS 工作目录预览</main><button id="counter">计数 0</button><button id="navigate">测试页面跳转</button><button id="link">测试动态链接</button>'`,
      "let count = 0",
      'document.getElementById("counter").onclick = (event) => { event.target.textContent = `计数 ${++count}` }',
      `document.getElementById("navigate").onclick = () => { location.href = "${BLOCKED_PREVIEW_ORIGIN}/navigation" }`,
      `document.getElementById("link").onclick = () => { const link = document.createElement("a"); link.href = "${BLOCKED_PREVIEW_ORIGIN}/dynamic-link"; document.body.append(link); link.click() }`,
      'document.body.style.opacity = "1"',
      'root.insertAdjacentHTML("beforeend", Array.from({ length: 10 }, (_, index) => `<section style="padding:24px;margin:12px;background:#eef4fa;min-height:90px">JS 动态生成内容 ${index + 1}</section>`).join("") + \'<footer id="page-tail">JS 页面末尾</footer>\')'
    ].join("\n"),
    "utf8"
  )
  writeFileSync(
    join(workspace, "broken-script.html"),
    '<!doctype html><body><script>throw new Error("intentional fixture initialization failure")</script></body>',
    "utf8"
  )
  writeFileSync(
    join(workspace, "missing-script.html"),
    '<!doctype html><body><script src="missing.js"></script></body>',
    "utf8"
  )
  writeFileSync(
    join(workspace, STATIC_STYLE_FILE_NAME),
    [
      ".workspace-preview-card {",
      "  display: flex;",
      "  align-items: center;",
      "  min-height: 180px;",
      "  padding: 24px;",
      "  color: rgb(255, 255, 255);",
      "  background-color: rgb(17, 34, 51);",
      "  border-radius: 18px;",
      "}",
      `.network-probe { background-image: url("${BLOCKED_PREVIEW_ORIGIN}/css-pixel.png"); }`,
      `</style><meta http-equiv="refresh" content="0;url=${BLOCKED_PREVIEW_ORIGIN}/css-breakout"><style>`,
      ""
    ].join("\n"),
    "utf8"
  )
  writeFileSync(
    join(workspace, HTML_FIXTURES[0].fileName),
    [
      "<!doctype html>",
      "<html>",
      "  <head>",
      '    <script defer src="./assets/source-proof.js"></script>',
      `    <link rel="stylesheet" href="./${STATIC_STYLE_FILE_NAME}">`,
      `    <link rel="stylesheet" href="${BLOCKED_PREVIEW_ORIGIN}/external.css">`,
      `    <meta http-equiv="refresh" content="0;url=${BLOCKED_PREVIEW_ORIGIN}/refresh">`,
      "  </head>",
      '  <body style="opacity:0">',
      `    <!-- ${PREVIEW_START_SENTINEL} -->`,
      // Keep this layout fixture under CodeViewer's 100-line virtualization threshold.
      // It remains taller than the viewport so the same non-virtualized source layout is exercised.
      ...Array.from(
        { length: 70 },
        (_, index) => `    <!-- layout line ${String(index + 2).padStart(2, "0")} -->`
      ),
      `    <!-- ${HTML_FIXTURES[0].sentinel} -->`,
      '    <div id="script-root"></div>',
      '    <script type="module">document.documentElement.dataset.moduleReady = "true"</script>',
      `    <img src="${BLOCKED_PREVIEW_ORIGIN}/image.png" alt="blocked network probe">`,
      `    <iframe src="${BLOCKED_PREVIEW_ORIGIN}/nested-frame"></iframe>`,
      "    <script>",
      '      document.documentElement.dataset.e2eExecuted = "true"',
      `      fetch("${BLOCKED_PREVIEW_ORIGIN}/script-fetch").catch(() => {})`,
      "    </script>",
      `    <!-- ${PREVIEW_END_SENTINEL} -->`,
      "  </body>",
      "</html>",
      ""
    ].join("\n"),
    "utf8"
  )
  writeFileSync(
    join(workspace, HTML_FIXTURES[1].fileName),
    [
      "<!doctype html>",
      "<html>",
      "  <body>",
      `    <main data-testid="${HTML_FIXTURES[1].testId}" style="display:grid;background-color:rgb(51, 34, 17);border-radius:12px;min-height:160px">`,
      `      ${HTML_FIXTURES[1].sentinel} · 工作目录 HTM UI 预览`,
      "    </main>",
      "    <script>",
      '      document.documentElement.dataset.e2eExecuted = "true"',
      "    </script>",
      "  </body>",
      "</html>",
      ""
    ].join("\n"),
    "utf8"
  )
  writeFileSync(
    unauthorizedFilePath,
    "<!doctype html><script>window.pwned = true</script>\n",
    "utf8"
  )

  const cleanEnv = createElectronEnvironment({
    isolatedHome,
    appData,
    localAppData,
    openworkHome,
    isolatedTemp,
    xdgConfigHome,
    xdgCacheHome,
    xdgDataHome
  })

  let app: ElectronApplication | undefined
  let page: Page | undefined
  let threadId: string | undefined
  const blockedPreviewRequests: string[] = []
  try {
    app = await electron.launch({
      executablePath: ELECTRON_LAUNCHER,
      args: [MAIN_ENTRY, `--user-data-dir=${electronUserData}`],
      cwd: PROJECT_ROOT,
      env: cleanEnv,
      timeout: 60_000
    })
    page = await waitForAppPage(app)
    await waitForApi(page)
    await page.route(`${BLOCKED_PREVIEW_ORIGIN}/**`, async (route) => {
      blockedPreviewRequests.push(route.request().url())
      await route.abort("blockedbyclient")
    })
    page.on("console", (message) =>
      console.log(`[workspace-html-e2e renderer:${message.type()}] ${message.text()}`)
    )
    threadId = await createWorkspaceThread(page, workspace, unauthorizedFilePath)

    // Fixture creation is outside this feature journey. From the app reload
    // through both file opens, any unhandled renderer exception fails the E2E.
    const rendererPageErrors: string[] = []
    page.on("pageerror", (error) => {
      if (error.message === "intentional fixture initialization failure") return
      rendererPageErrors.push(error.stack ?? error.message)
      console.error(`[workspace-html-e2e renderer:pageerror] ${error.stack ?? error.message}`)
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await openWorkspaceFiles(page, blockedPreviewRequests)
    await openToolFilePreviewLayout(page)
    assert(rendererPageErrors.length === 0, "页面重载及文件操作未出现 renderer 异常")
    log("ALL PASS workspace HTML source E2E")
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(
        `[workspace-html-e2e] preview snapshot: ${await page.locator("body").innerText()}`
      )
      const artifactDirectory = join(PROJECT_ROOT, "output", "html-preview")
      mkdirSync(artifactDirectory, { recursive: true })
      await page.screenshot({ path: join(artifactDirectory, "e2e-failure.png") })
    }
    throw error
  } finally {
    if (app) {
      if (page && threadId) {
        await withTimeout(deleteWorkspaceThread(page, threadId), 5_000, "thread cleanup")
          .then(() => log("Temporary thread removed"))
          .catch((cleanupError) => {
            console.warn(`[workspace-html-e2e] thread cleanup deferred: ${String(cleanupError)}`)
          })
      }
      const processHandle = (() => {
        try {
          return app.process()
        } catch {
          return undefined
        }
      })()
      await withTimeout(app.close(), 5_000, "Electron close").catch((closeError) => {
        console.warn(`[workspace-html-e2e] graceful close failed: ${String(closeError)}`)
      })
      if (processHandle && processHandle.exitCode === null && !processHandle.killed) {
        processHandle.kill()
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    await withTimeout(
      rmAsync(testRoot, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 10 : 2,
        retryDelay: 250
      }),
      5_000,
      "temporary directory cleanup"
    ).catch((cleanupError) => {
      console.warn(
        `[workspace-html-e2e] temporary directory cleanup deferred: ${String(cleanupError)}`
      )
    })
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(`\n❌ ${error.stack || error.message}`)
    process.exit(1)
  })
