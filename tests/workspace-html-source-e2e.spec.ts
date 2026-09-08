/**
 * Real Electron E2E for opening HTML files from the workspace file tree.
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
import { _electron as electron, type ElectronApplication, type Page } from "playwright"

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
const HTML_FIXTURES = [
  { fileName: "source-proof.html", sentinel: "HTML_SOURCE_SENTINEL" },
  { fileName: "legacy-proof.HTM", sentinel: "HTM_SOURCE_SENTINEL" }
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

async function createWorkspaceThread(page: Page, workspacePath: string): Promise<string> {
  return page.evaluate<string, { title: string; workspacePath: string }>(
    async ({ title, workspacePath }) => {
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
        !["source-proof.html", "legacy-proof.HTM"].every((fileName) =>
          discoveredNames.has(fileName)
        )
      ) {
        throw new Error(
          `Expected HTML fixtures before UI navigation: ${JSON.stringify(workspaceState)}`
        )
      }
      return threadId
    },
    { title: THREAD_TITLE, workspacePath }
  )
}

async function openWorkspaceFiles(page: Page): Promise<void> {
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

    await page.waitForFunction(
      (sentinel) =>
        Array.from(document.querySelectorAll(".shiki-wrapper")).some((element) =>
          element.textContent?.includes(sentinel)
        ),
      fixture.sentinel,
      { timeout: 30_000 }
    )

    const sourceViewer = page.locator(".shiki-wrapper").filter({ hasText: fixture.sentinel }).last()
    const sourceText = (await sourceViewer.textContent()) ?? ""
    assert(sourceText.includes("<!doctype html>"), `${fixture.fileName} 展示完整 HTML 源码`)
    assert(sourceText.includes("<script>"), `${fixture.fileName} 的标签未被执行或吞掉`)

    const matchingIframeCount = await page.locator("iframe").evaluateAll(
      (frames, expectedFileName) =>
        frames.filter((frame) => {
          const normalizedTitle = (frame.getAttribute("title") ?? "").replace(/\\/g, "/")
          return (
            normalizedTitle === expectedFileName || normalizedTitle.endsWith(`/${expectedFileName}`)
          )
        }).length,
      fixture.fileName
    )
    assert(matchingIframeCount === 0, `${fixture.fileName} 未进入 iframe 网页预览`)
  }
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
  for (const fixture of HTML_FIXTURES) {
    writeFileSync(
      join(workspace, fixture.fileName),
      [
        "<!doctype html>",
        "<html>",
        '  <body style="display: none">',
        `    <!-- ${fixture.sentinel} -->`,
        "    <script>",
        '      document.documentElement.dataset.e2eExecuted = "true"',
        "    </script>",
        "  </body>",
        "</html>",
        ""
      ].join("\n"),
      "utf8"
    )
  }

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
    page.on("console", (message) =>
      console.log(`[workspace-html-e2e renderer:${message.type()}] ${message.text()}`)
    )
    threadId = await createWorkspaceThread(page, workspace)

    // Fixture creation is outside this feature journey. From the app reload
    // through both file opens, any unhandled renderer exception fails the E2E.
    const rendererPageErrors: string[] = []
    page.on("pageerror", (error) => {
      rendererPageErrors.push(error.stack ?? error.message)
      console.error(`[workspace-html-e2e renderer:pageerror] ${error.stack ?? error.message}`)
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await openWorkspaceFiles(page)
    assert(rendererPageErrors.length === 0, "页面重载及文件操作未出现 renderer 异常")
    log("ALL PASS workspace HTML source E2E")
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
