/** Test-only current main/preload/App journey. No model generation or business implementation. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Locator, Page } from "playwright"
import {
  assertCreatorLiveCandidate,
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { readModsSourceCandidate } from "./support/mods-source-candidate"
import { modsSourceDriverHashes } from "./support/mods-source-driver-hashes"
import { openModsSettings } from "./support/mods-sidebar-navigation"
import { pollPublicState } from "./support/poll-public-state"
import { installLiveNativeProcessApprovals } from "./support/live-native-process-approvals"
import { isSameWorkspacePath } from "../src/shared/workspace-path"
import {
  verifyWorkbenchNodeVersionApproval,
  workbenchVisibleJson,
  workbenchNativeStateDetails,
  workbenchWorkspacePackets,
  type WorkbenchWorkspacePacket
} from "./support/developer-workbench-native-protocol"

async function main() {
  assert.equal(
    process.env.DEVELOPER_WORKBENCH_NATIVE,
    "1",
    "EXPLICIT_WORKBENCH_NATIVE_OPT_IN_REQUIRED"
  )
  assert.equal(Number(process.versions.node.split(".")[0]), 22, "WORKBENCH_NODE22_REQUIRED")
  assert(
    process.env.COMPOSITION_E2E_SOURCE_CANDIDATE,
    "WORKBENCH_EXPLICIT_SOURCE_MANIFEST_REQUIRED"
  )
  const root = resolve(__dirname, "..")
  const build = assertCreatorLiveCandidate(root)
  assert.equal(build.execution, "source-isolated", "WORKBENCH_REQUIRES_CURRENT_SOURCE")
  const manifestPath = process.env.COMPOSITION_E2E_SOURCE_CANDIDATE!
  const manifest = readModsSourceCandidate(manifestPath)
  const fixture = projectCompositionEnvironment(root)
  mkdirSync(fixture.workspace, { recursive: true })
  fixture.env.CMB_MODS_E2E = "0"
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")
  const manifestHash = hash(manifestPath)
  const driverHashes = await modsSourceDriverHashes(root, [
    "tests/developer-workbench-source-e2e.spec.ts"
  ])
  const driverHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  }).trim()
  const node = realpathSync(process.execPath),
    nodeSha256 = hash(node)
  const deadline = Date.now() + 8 * 60_000
  const evidencePath = join(fixture.isolated, "developer-workbench-evidence.json")
  const events: unknown[] = [],
    environmentIssues: unknown[] = [],
    cleanupFailures: unknown[] = [],
    pageErrors: string[] = []
  const temporaryThreads: string[] = [],
    approvedDigests = new Set<string>()
  const decisions: Record<string, "approve" | "reject"> = Object.create(null)
  let app: ElectronApplication | undefined,
    page: Page | undefined,
    threadId = "",
    pluginId = "",
    runtimeName = "",
    nativeWorkspace = ""
  let passed = false,
    error: string | undefined,
    monitorStopped = false,
    monitor: Promise<void> | undefined
  let modelRequests = 0,
    previewResourceRequests = 0,
    otherRequests = 0,
    unexpectedApproval = false
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) modelRequests++
    else if (request.url === "/media-probe") previewResourceRequests++
    else otherRequests++
    response.writeHead(503)
    response.end("Unexpected fixture network request")
  })
  const record = (kind: string, value: unknown) => {
    events.push({ kind, at: new Date().toISOString(), value })
    save()
  }
  const save = () =>
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          scenario: "developer-workbench",
          passed,
          error,
          publisher: {
            metadata: {
              source: {
                manifestPath,
                manifestSha256: manifestHash,
                recordedHead: manifest.head,
                headBasis:
                  "recorded-head; actual-input-proven-by-source-signatures-and-current-source-fences"
              },
              driver: { head: driverHead, hashes: driverHashes }
            }
          },
          model: { commercial: false, requests: modelRequests },
          unexpectedNetwork: {
            scope:
              "This isolated loopback model/media fixture only; no claim about unrelated application traffic",
            previewResourceRequests,
            otherRequests
          },
          threadId,
          pluginId,
          node: { executable: node, sha256: nodeSha256 },
          approvedDigests: [...approvedDigests],
          events,
          environmentIssues,
          cleanupFailures,
          pageErrors
        },
        null,
        2
      )
    )
  writeFileSync(evidencePath, "{}", { flag: "wx" })
  const until = <T>(
    read: () => T | Promise<T>,
    accept: (value: T) => boolean,
    code: string,
    ms = 30000
  ) =>
    pollPublicState(read, accept, {
      code,
      deadline: Math.min(deadline, Date.now() + ms),
      delayMs: 100
    })
  const resourceZero = async (label: string) => {
    const value = await until(
      () => page!.evaluate((id) => window.api.mods.runtimeSessions(id), threadId),
      (value) => {
        const row = value.sessions.find(
          (row) => row.threadId === threadId && row.state === "resident"
        )
        return Boolean(
          row?.diagnostics &&
          row.diagnostics.subscriptions === 0 &&
          row.diagnostics.inFlight === 0 &&
          row.diagnostics.backgroundResources === 0
        )
      },
      label
    )
    record(label, value)
  }
  const clean = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (cause) {
      cleanupFailures.push({ label, error: String(cause) })
    }
  }
  const capture = async (label: string) => {
    const path = join(fixture.isolated, `${label}.png`)
    try {
      await page!.screenshot({ path, timeout: 3000 })
      record("readonly-screenshot", { label, path })
    } catch (cause) {
      record("readonly-screenshot-unavailable", { label, error: String(cause) })
    }
  }
  const watchdog = setTimeout(() => {
    error ??= "WORKBENCH_TOTAL_TIMEOUT"
    void app?.close().catch(() => {})
  }, 8 * 60_000)
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert(address && typeof address !== "string")
    writeFileSync(join(fixture.workspace, "Main.java"), 'class Main { String value = "hello"; }\n')
    const html =
      "<!doctype html>\n<html><body>\n<script>window.__workbenchExecuted=true</script>\n" +
      `<img src="http://127.0.0.1:${address.port}/media-probe" onerror="window.__workbenchExecuted=true">\n` +
      'const marker = "SAFE_TEXT_TARGET"\n</body></html>\n'
    writeFileSync(join(fixture.workspace, "preview.html"), html)
    writeFileSync(join(fixture.workspace, "watch-receipt.txt"), "before\n")
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main-${name}.log`), bytes)
      )
    const native = await app.evaluate(({ app }) => ({
      path: app.getAppPath(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      pid: process.pid,
      creationTime: app.getAppMetrics().find((row) => row.pid === process.pid)?.creationTime,
      testEntry: process.env.CMB_MODS_E2E
    }))
    assert.equal(realpathSync(native.path), realpathSync(manifest.root))
    assert.equal(native.version, "2.0.0")
    assert.equal(native.packaged, false)
    assert.equal(native.testEntry, "0")
    record("actual-current-main", native)
    page = await app.firstWindow({ timeout: 60000 })
    page.on("pageerror", (cause) => pageErrors.push(cause.message))
    page.setDefaultTimeout(20000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.runtimeSessions))
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => window.setContentSize(1366, 900))
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    const title = `开发工作台原生验收 ${randomUUID().slice(0, 8)}`
    threadId = await page.evaluate(
      async ({ workspace, title, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "workbench-no-model",
          name: "No model must be called",
          baseUrl: url,
          model: "workbench-no-model",
          apiKey: "localhost-dummy-only",
          maxTokens: 128000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:workbench-no-model")
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { workspace: fixture.workspace, title, url: `http://127.0.0.1:${address.port}/v1` }
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.mods))
    await page.evaluate("window.__name = value => value")
    await page.getByText(title, { exact: true }).first().click()
    const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
    const composer = chat.locator("textarea.composer-textarea")
    const draft = "保留未发送草稿：只验收开发工作台，不执行业务。"
    await composer.fill(draft)
    const zip = new AdmZip()
    zip.addLocalFolder(join(root, "examples/developer-workbench"))
    const zipPath = join(fixture.isolated, "developer-workbench.zip")
    writeFileSync(zipPath, zip.toBuffer())
    const before = await page.evaluate(() => window.api.plugins.list())
    await page.locator('[data-app-guide="customize"]').click()
    await page.getByRole("button", { name: "插件", exact: true }).click()
    const sources = page.locator("[data-plugin-source-list]")
    await sources.getByRole("heading", { name: "Plugins", exact: true }).waitFor()
    await sources
      .getByRole("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .first()
      .click()
    await page
      .getByRole("dialog", { name: "安装 Plugin", exact: true })
      .locator("#upload-plugin-input")
      .setInputFiles(zipPath)
    const installed = await until(
      () => page!.evaluate(() => window.api.plugins.list()),
      (list) =>
        list.some(
          (item) => item.name === "developer-workbench" && !before.some((old) => old.id === item.id)
        ),
      "WORKBENCH_ORIGINAL_ZIP_UPLOAD"
    )
    const fresh = installed.filter(
      (item) => item.name === "developer-workbench" && !before.some((old) => old.id === item.id)
    )
    assert.equal(fresh.length, 1)
    pluginId = fresh[0].id
    record("original-ZIP-upload", { plugin: fresh[0], zipSha256: hash(zipPath) })
    await openModsSettings(page)
    const card = page
      .getByRole("region", { name: "已安装插件", exact: true })
      .locator(`[data-installed-mod-id="${pluginId}"]`)
    await card.getByRole("button", { name: "开始使用", exact: true }).click()
    const consent = card.getByRole("button", { name: "确认并进入使用", exact: true })
    await consent.waitFor()
    const beforeConsent = await page.evaluate((id) => window.api.mods.status(id), threadId)
    assert(isSameWorkspacePath(beforeConsent.workspace, fixture.workspace))
    nativeWorkspace = beforeConsent.workspace
    const prepared = beforeConsent.functionMods?.find((item) => item.pluginId === pluginId)
    assert(prepared?.digest && prepared.state !== "ready")
    await consent.click()
    const enabled = await until(
      () => page!.evaluate((id) => window.api.mods.status(id), threadId),
      (value) =>
        value.functionMods?.some(
          (item) =>
            item.pluginId === pluginId && item.digest === prepared.digest && item.state === "ready"
        ) === true,
      "WORKBENCH_EXACT_CURRENT_SOURCE_CONSENT"
    )
    runtimeName = enabled.functionMods!.find((item) => item.pluginId === pluginId)!.name
    record("original-current-source-confirmation", { prepared, enabled })
    if (await page.getByRole("button", { name: "返回应用", exact: true }).isVisible())
      await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await chat.waitFor({ state: "visible" })
    assert.equal(await composer.inputValue(), draft, "WORKBENCH_PREINSTALL_DRAFT_RETAINED")
    await composer.evaluate((node, expectedText) => {
      const textarea = node as HTMLTextAreaElement
      const state = {
        offers: [] as unknown[],
        broadcasts: [] as unknown[],
        cursorTrace: [] as unknown[],
        cursorOverflow: 0
      }
      const target = window as unknown as {
        workbenchNativeProbe: typeof state
        workbenchCursorStop?: () => void
      }
      target.workbenchNativeProbe = state
      const observe = (kind: string) => {
        if (state.cursorTrace.length >= 128) {
          state.cursorOverflow++
          return
        }
        state.cursorTrace.push({
          kind,
          at: Date.now(),
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          direction: textarea.selectionDirection,
          sameDraft: textarea.value === expectedText,
          disabled: textarea.disabled,
          readOnly: textarea.readOnly,
          focused: document.activeElement === textarea,
          connected: textarea.isConnected
        })
      }
      const event = (value: Event) => observe(value.type)
      for (const kind of ["select", "focus", "blur"])
        textarea.addEventListener(kind, event, { passive: true })
      document.addEventListener("selectionchange", event, { passive: true })
      const attributes = new MutationObserver(() => observe("owned-attributes"))
      attributes.observe(textarea, { attributes: true, attributeFilter: ["disabled", "readonly"] })
      target.workbenchCursorStop = () => {
        for (const kind of ["select", "focus", "blur"]) textarea.removeEventListener(kind, event)
        document.removeEventListener("selectionchange", event)
        attributes.disconnect()
      }
      observe("before-baseline")
    }, draft)
    await composer.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(5, 8))
    const composerHandle = await composer.elementHandle()
    assert(composerHandle)
    const assertDraft = async () => {
      assert.equal(await composer.inputValue(), draft)
      assert(
        await composerHandle.evaluate(
          (node, id) =>
            node ===
            document.querySelector(
              `[data-chat-thread-id="${CSS.escape(id)}"] textarea.composer-textarea`
            ),
          threadId
        )
      )
      assert.deepEqual(
        await composer.evaluate((node) => ({
          start: (node as HTMLTextAreaElement).selectionStart,
          end: (node as HTMLTextAreaElement).selectionEnd
        })),
        { start: 5, end: 8 }
      )
    }
    const cursorCheckpoint = async (label: string) =>
      record("composer-cursor-checkpoint", {
        label,
        ...(await composer.evaluate((node, expectedText) => {
          const textarea = node as HTMLTextAreaElement
          return {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            direction: textarea.selectionDirection,
            sameDraft: textarea.value === expectedText,
            disabled: textarea.disabled,
            readOnly: textarea.readOnly,
            focused: document.activeElement === textarea,
            connected: textarea.isConnected
          }
        }, draft))
      })
    await cursorCheckpoint("initial-baseline")
    await assertDraft()
    await app.evaluate(installLiveNativeProcessApprovals, {
      isolated: fixture.isolated,
      workspace: fixture.workspace
    })
    await page.evaluate(() => {
      const state = (
        window as unknown as { workbenchNativeProbe: { offers: unknown[]; broadcasts: unknown[] } }
      ).workbenchNativeProbe
      window.api.mods.onEditorNavigation((event) => {
        if (event.kind === "offer") state.offers.push(event.intent)
      })
      window.api.workspace.onFilesChanged((event) => state.broadcasts.push(event))
    })
    const nav = page.getByRole("navigation", { name: "扩展工作区", exact: true })
    const firstCatalog = await until(
      () => page!.evaluate((id) => window.api.mods.platformSurfaceList(id), threadId),
      (value) =>
        value.canPrepare === true ||
        value.entries.filter(
          (entry) =>
            entry.ref.provider === runtimeName &&
            entry.source.provider === runtimeName &&
            entry.source.digest === prepared.digest
        ).length === 5,
      "WORKBENCH_SURFACES_ORIGINAL_PREPARATION_AVAILABLE"
    )
    if (firstCatalog.canPrepare)
      await nav.getByRole("button", { name: "查找可用插件界面", exact: true }).click()
    const catalog = await until(
      () => page!.evaluate((id) => window.api.mods.platformSurfaceList(id), threadId),
      (value) =>
        value.entries.filter(
          (entry) =>
            entry.ref.provider === runtimeName &&
            entry.source.provider === runtimeName &&
            entry.source.digest === prepared.digest
        ).length === 5,
      "WORKBENCH_CURRENT_SOURCE_SURFACES_PREPARED"
    )
    assert.equal(
      catalog.entries.filter((entry) => entry.ref.provider === "developer-workbench").length,
      5
    )
    record("actual-native-surface-catalog", catalog)
    const open = async (placement: "page" | "settings"): Promise<Locator> => {
      await cursorCheckpoint(`before-surface-${placement}`)
      const current = await page!.evaluate(
        (id) => window.api.mods.platformSurfaceList(id),
        threadId
      )
      const entries = current.entries.filter((entry) =>
        ["page", "navigation", "toolbar", "settings"].includes(entry.placement)
      )
      const index = entries.findIndex(
        (entry) => entry.ref.provider === "developer-workbench" && entry.placement === placement
      )
      assert(index >= 0)
      await nav.getByRole("button", { name: "开发工作台", exact: true }).nth(index).click()
      const surface = page!.getByRole("region", { name: "开发工作台", exact: true })
      await surface.waitFor()
      await cursorCheckpoint(`after-surface-${placement}`)
      return surface
    }
    let surface = await open("page")
    await surface.getByRole("button", { name: "读取能力与原生状态", exact: true }).click()
    const statusLabels = surface.getByText(
      /^(?:Java服务：(未启动|运行中|状态未知)|源码预览：(安全源文本|状态未知)|文件变化：(正在观察|未观察|状态未知)|Git检查：(只读，需明确绑定仓库|状态未知)|工作流：(无活动运行|运行中|状态未知))$/
    )
    const ordinaryLabels = await until(
      async () => {
        const labels: string[] = []
        for (const label of await statusLabels.all())
          if (await label.isVisible()) labels.push(await label.innerText())
        return labels
      },
      (labels) => labels.length === 5,
      "WORKBENCH_DEFAULT_FIVE_HUMAN_STATE_LABELS"
    )
    assert.deepEqual(
      ordinaryLabels.map((label) => label.split("：")[0]).sort(),
      ["Java服务", "Git检查", "工作流", "文件变化", "源码预览"].sort()
    )
    assert.equal(await surface.getByText(/^开发信息：/).count(), 0)
    assert.equal(workbenchNativeStateDetails(await workbenchVisibleJson(surface)).length, 0)
    const developerInfo = surface.getByRole("button", { name: "查看开发信息", exact: true })
    assert(await developerInfo.isVisible())
    record("default-human-status-with-debug-collapsed", { ordinaryLabels, developerDetails: 0 })
    await capture("native-default-status")
    await developerInfo.click()
    await surface.getByRole("button", { name: "收起开发信息", exact: true }).waitFor()
    const expectedNativeProviders = [
      "native.code",
      "native.editor",
      "native.workspace",
      "native.git",
      "native.workflow"
    ]
    const states = await until(
      () => workbenchVisibleJson(surface).then(workbenchNativeStateDetails),
      (rows) =>
        expectedNativeProviders.every(
          (provider) => rows.filter((row) => row.ref.provider === provider).length === 1
        ),
      "WORKBENCH_VISIBLE_NATIVE_STATES"
    )
    assert.deepEqual(
      states.map((row) => row.ref.provider).sort(),
      [...expectedNativeProviders].sort()
    )
    const javaBefore = await page.evaluate(
      (workspace) => window.api.lsp.isRunning(workspace),
      fixture.workspace
    )
    const javaState = states.find((row) => row.ref.provider === "native.code")!
    assert.equal(javaState.state.status, "ready")
    assert.equal(
      javaState.observation.status,
      javaBefore ? "running" : "unavailable",
      "WORKBENCH_REAL_VISIBLE_JAVA_STATE"
    )
    const javaLabel = `Java服务：${javaBefore ? "运行中" : "未启动"}`
    assert(await surface.getByText(javaLabel, { exact: true }).isVisible())
    const workspaceState = states.find((row) => row.ref.provider === "native.workspace")!
    assert.equal(workspaceState.state.status, "ready")
    assert.equal(typeof workspaceState.observation.observing, "boolean")
    assert(
      await surface
        .getByText(`文件变化：${workspaceState.observation.observing ? "正在观察" : "未观察"}`, {
          exact: true
        })
        .isVisible()
    )
    const workflowState = states.find((row) => row.ref.provider === "native.workflow")!
    assert.equal(workflowState.state.status, "ready")
    assert.equal(workflowState.observation.status, "ready")
    assert.equal(workflowState.observation.activeRunId, null)
    assert(await surface.getByText("工作流：无活动运行", { exact: true }).isVisible())
    record("visible-native-states", { states, javaLabel, visible: await surface.innerText() })
    await capture("native-expanded-status")
    await cursorCheckpoint("after-status-refresh")
    await surface.getByRole("button", { name: "查询所选 Java 文件诊断", exact: true }).click()
    if (!javaBefore) await surface.getByText(/MODS_CODE_UNAVAILABLE/).waitFor()
    else
      await until(
        () => workbenchVisibleJson(surface),
        (rows) =>
          rows.some(
            (row) =>
              row.language === "java" &&
              row.diagnostics === "cached" &&
              row.versionUnknown === true &&
              Array.isArray(row.items)
          ),
        "WORKBENCH_ACTUAL_JAVA_CACHED_RESULT"
      )
    assert.equal(
      await page.evaluate((workspace) => window.api.lsp.isRunning(workspace), fixture.workspace),
      javaBefore
    )
    record("actual-Java-availability", {
      running: javaBefore,
      notStartedByMod: true,
      visible: await surface.innerText()
    })
    await cursorCheckpoint("after-java-query")
    surface = await open("settings")
    await cursorCheckpoint("before-settings-edit")
    for (const [label, value] of [
      ["检查 argv JSON", JSON.stringify([node, "--version"])],
      ["工作区相对源码路径", "preview.html"],
      ["行（从 1 开始）", "5"],
      ["列（从 1 开始）", "7"]
    ])
      await surface.getByLabel(label, { exact: true }).fill(value)
    await surface.getByRole("button", { name: "保存并读回设置", exact: true }).click()
    await surface.getByText("设置已保存并读回；尚未执行检查。", { exact: true }).waitFor()
    record("original-workbench-settings", {
      argv: [node, "--version"],
      path: "preview.html",
      line: 5,
      column: 7,
      modelRequests
    })
    await cursorCheckpoint("after-settings-save")
    surface = await open("page")
    await cursorCheckpoint("before-preview")
    await surface.getByRole("button", { name: "原生安全源码定位", exact: true }).click()
    const preview = page.getByRole("region", { name: "安全源文件预览", exact: true })
    await preview.waitFor()
    const mark = preview.locator(
      '[data-native-editor-line="5"] mark[data-native-editor-column="7"]'
    )
    await mark.waitFor({ state: "visible" })
    assert(await mark.boundingBox())
    const renderedLines = await preview.locator("[data-native-editor-line]").evaluateAll((nodes) =>
      nodes.map((node) => {
        const copy = node.cloneNode(true) as HTMLElement
        copy.querySelector("[aria-hidden]")?.remove()
        return {
          line: Number(node.getAttribute("data-native-editor-line")),
          text: copy.textContent
        }
      })
    )
    for (const line of [3, 4, 5])
      assert.equal(renderedLines.find((row) => row.line === line)?.text, html.split("\n")[line - 1])
    assert.equal(await preview.locator("script,img,iframe").count(), 0)
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { __workbenchExecuted?: unknown }).__workbenchExecuted
      ),
      undefined
    )
    const receiptRows = await until(
      () => workbenchVisibleJson(surface),
      (rows) =>
        rows.some(
          (row) =>
            row.status === "preview-loaded" &&
            row.line === 5 &&
            row.column === 7 &&
            row.preview === "source-text"
        ),
      "WORKBENCH_REAL_RENDERER_LINE_ACK"
    )
    const offers = await page.evaluate(
      () =>
        (window as unknown as { workbenchNativeProbe: { offers: unknown[] } }).workbenchNativeProbe
          .offers
    )
    const intent = await preview.getAttribute("data-native-editor-intent")
    const offer = offers.find((value) => (value as { id: string }).id === intent) as
      | {
          threadId: string
          workspace: string
          source: { provider: string; digest: string }
        }
      | undefined
    assert(
      offer &&
        offer.threadId === threadId &&
        isSameWorkspacePath(realpathSync(offer.workspace), realpathSync(fixture.workspace)),
      "WORKBENCH_OFFER_TARGET_MUST_MATCH_THE_NATIVE_WORKSPACE"
    )
    assert.equal(offer.source.provider, runtimeName)
    assert.equal(offer.source.digest, prepared.digest)
    record("actual-safe-source-location-ACK", {
      receiptRows,
      offers,
      renderedLines,
      DOMIntent: intent,
      executableHtml: false
    })
    await cursorCheckpoint("after-preview-ACK")
    const ordinary = (await page.evaluate((id) => window.api.mods.commands(id), threadId)).find(
      (command) => command.command === "dev-workbench" && command.digest === prepared.digest
    )
    assert(ordinary, "WORKBENCH_REAL_ORDINARY_COMMAND_REQUIRED")
    await cursorCheckpoint("before-ordinary-command")
    const queued = await page.evaluate(
      ({ id, command }) => window.api.mods.enqueue(id, command, { text: "" }),
      { id: threadId, command: ordinary }
    )
    const ordinaryDone = await until(
      () => page!.evaluate((id) => window.api.mods.jobs(id), threadId),
      (jobs) => {
        const job = jobs.find((job) => job.id === queued.id)
        if (!job || ["queued", "running"].includes(job.state)) return false
        assert.equal(job.state, "succeeded", "WORKBENCH_ORDINARY_SDK_FRAME_FAILED")
        return true
      },
      "WORKBENCH_ORDINARY_SDK_FRAME_COMPLETED"
    )
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    )
    assert.equal(await preview.getAttribute("data-native-editor-intent"), intent)
    assert(
      (await preview.isVisible()) && (await mark.isVisible()),
      "WORKBENCH_LOADED_PREVIEW_DIED_AFTER_RPC"
    )
    record("preview-retained-after-ordinary-SDK-frame", {
      intent,
      completed: ordinaryDone.find((job) => job.id === queued.id),
      targetStillVisible: true,
      proofBoundary:
        "Preview created by the actual ui.resolve callback; a subsequent ordinary command completed. Original RPC-signal retirement is covered by the native core integration separately."
    })
    await cursorCheckpoint("after-ordinary-command")
    await capture("native-file-line-ACK")
    await cursorCheckpoint("before-preview-close")
    await preview.getByRole("button", { name: "关闭预览", exact: true }).click()
    await cursorCheckpoint("after-preview-close")
    await assertDraft()
    assert.equal(modelRequests, 0)
    assert.equal(previewResourceRequests + otherRequests, 0)
    surface = await open("page")
    assert((await page.evaluate((id) => window.api.workspace.ensureWatching(id), threadId)).success)
    await surface.getByRole("button", { name: "订阅工作区变更（仅失效提示）", exact: true }).click()
    await until(
      () => page!.evaluate((id) => window.api.mods.runtimeSessions(id), threadId),
      (value) =>
        value.sessions.some(
          (row) => row.threadId === threadId && (row.diagnostics?.subscriptions ?? 0) > 0
        ),
      "WORKBENCH_ACTUAL_SUBSCRIPTION"
    )
    const changedText = "after-real-watcher\n"
    writeFileSync(join(fixture.workspace, "watch-receipt.txt"), changedText)
    const packets = () => workbenchVisibleJson(surface).then(workbenchWorkspacePackets)
    const patchMatches = (
      packet: WorkbenchWorkspacePacket,
      event: WorkbenchWorkspacePacket["events"][number]
    ) =>
      packet.state.value.observing === true &&
      event.value.kind === "patch" &&
      typeof event.value.observationId === "string" &&
      packet.state.value.observationId === event.value.observationId &&
      Array.isArray(event.value.upserts) &&
      event.value.upserts.some(
        (value) =>
          value &&
          typeof value === "object" &&
          "path" in value &&
          value.path === "watch-receipt.txt" &&
          "size" in value &&
          value.size === Buffer.byteLength(changedText)
      )
    const patch = await until(
      packets,
      (rows) => rows.some((row) => row.events.some((event) => patchMatches(row, event))),
      "WORKBENCH_REAL_WATCHER_PATCH"
    )
    const patchPacket = patch.find((row) => row.events.some((event) => patchMatches(row, event)))!
    const patchEvent = patchPacket.events.find((event) => patchMatches(patchPacket, event))!
    assert.deepEqual(patchPacket.state.source, patchEvent.source)
    const observationId = patchEvent.value.observationId
    record("real-existing-watcher-patch", {
      patch,
      observationId,
      revision: patchEvent.revision,
      source: patchEvent.source
    })
    // read() after poll publishes a status once. Observe that acknowledgement before eviction,
    // so strict cached-poll guards do not have to return an obsolete positive packet.
    const ready = await until(
      packets,
      (rows) =>
        rows.some(
          (row) =>
            row.state.value.observing === true &&
            row.state.value.observationId === observationId &&
            row.events.some(
              (event) =>
                event.revision > patchEvent.revision &&
                event.value.kind === "status" &&
                event.value.observationId === observationId
            )
        ),
      "WORKBENCH_PATCH_STATUS_ACKNOWLEDGED"
    )
    const lastRevision = Math.max(
      ...ready.flatMap((row) => [row.state.revision, ...row.events.map((event) => event.revision)])
    )
    const beforeLruSnapshot = await page.evaluate(
      (id) => window.api.mods.runtimeSessions(id),
      threadId
    )
    const beforeLru = beforeLruSnapshot.sessions.find(
      (row) => row.threadId === threadId && row.state === "resident"
    )
    assert(beforeLru)
    for (let index = 0; index < 16; index++) {
      await page.evaluate(() => window.api.workspace.setActiveThread(null))
      const id = await page.evaluate(
        async ({ workspace, title }) => {
          const row = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          return row.thread_id
        },
        {
          workspace: fixture.workspace,
          title: `Owned watcher lifecycle ${threadId.slice(0, 8)}-${index}`
        }
      )
      temporaryThreads.push(id)
      const watching = await page.evaluate(
        async ({ id, workspace }) => {
          await window.api.workspace.set(id, workspace)
          return window.api.workspace.ensureWatching(id)
        },
        { id, workspace: fixture.workspace }
      )
      assert(watching.success, "WORKBENCH_LRU_TEST_WATCHER_NOT_READY")
    }
    const invalidated = await until(
      packets,
      (rows) =>
        rows.some(
          (row) =>
            row.state.value.observing === false &&
            row.state.value.observationId === null &&
            JSON.stringify(row.state.source) === JSON.stringify(patchEvent.source) &&
            row.events.some(
              (event) =>
                event.revision > lastRevision &&
                event.value.kind === "invalidate" &&
                event.value.reason === "watcher-changed" &&
                event.value.observing === false &&
                JSON.stringify(event.source) === JSON.stringify(patchEvent.source)
            )
        ),
      "WORKBENCH_REAL_WATCHER_EVICTION"
    )
    const afterEviction = await page.evaluate((id) => window.api.mods.status(id), threadId)
    assert(
      afterEviction.functionMods?.some(
        (item) =>
          item.pluginId === pluginId && item.digest === prepared.digest && item.state === "ready"
      )
    )
    const residents = await page.evaluate((id) => window.api.mods.runtimeSessions(id), threadId)
    const sameRuntime = residents.sessions.find(
      (row) => row.threadId === threadId && row.state === "resident"
    )
    assert(
      sameRuntime &&
        sameRuntime.generation === beforeLru.generation &&
        sameRuntime.incarnationKey === beforeLru.incarnationKey
    )
    assert(
      !residents.sessions.some(
        (row) =>
          temporaryThreads.includes(row.threadId) &&
          (row.guestEntered === true || ["resident", "loading"].includes(row.state))
      )
    )
    assert.equal(residents.resident, beforeLruSnapshot.resident)
    assert.equal(residents.reserved, beforeLruSnapshot.reserved)
    assert.equal(residents.stoppedTotal, beforeLruSnapshot.stoppedTotal)
    assert.equal(residents.retiring, 0)
    record("real-LRU-invalidation-with-current-source", {
      invalidated,
      temporaryThreads: [...temporaryThreads],
      runtime: residents
    })
    await surface.getByRole("button", { name: "关闭观察", exact: true }).click()
    await surface.getByText("观察已关闭。", { exact: true }).waitFor()
    await resourceZero("actual-observer-unsubscribed")
    await page.evaluate(async (id) => {
      await window.api.workspace.ensureWatching(id)
      await window.api.workspace.setActiveThread(id)
    }, threadId)
    while (temporaryThreads.length) {
      await page.evaluate((id) => window.api.threads.delete(id), temporaryThreads[0])
      temporaryThreads.shift()
    }
    monitor = (async () => {
      const pendingPath = join(fixture.isolated, "pending-native-approval.json")
      while (!monitorStopped && Date.now() < deadline) {
        if (existsSync(pendingPath)) {
          let pending: { digest?: string } | undefined
          try {
            pending = JSON.parse(readFileSync(pendingPath, "utf8"))
          } catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause
          }
          if (pending?.digest && !Object.hasOwn(decisions, pending.digest)) {
            let decision: "approve" | "reject" = "reject"
            try {
              const proof = verifyWorkbenchNodeVersionApproval(pending, {
                executable: node,
                executableSha256: nodeSha256,
                workspace: fixture.workspace,
                requester: `function:${runtimeName}`
              })
              assert.equal(approvedDigests.size, 0, "WORKBENCH_ONLY_ONE_COMMAND_ALLOWED")
              approvedDigests.add(proof.digest)
              decision = "approve"
              record("exact-native-Node-version-review", proof)
            } catch (cause) {
              unexpectedApproval = true
              environmentIssues.push({
                code: "UNEXPECTED_NATIVE_COMMAND_REJECTED",
                error: String(cause)
              })
            }
            decisions[pending.digest] = decision
            writeFileSync(
              join(fixture.isolated, "reviewed-approvals.json"),
              JSON.stringify(decisions, null, 2)
            )
          }
        }
        await new Promise((done) => setTimeout(done, 100))
      }
    })()
    void monitor.catch((cause) => {
      unexpectedApproval = true
      error ??= "WORKBENCH_APPROVAL_MONITOR_FAILED"
      environmentIssues.push({ code: "APPROVAL_MONITOR_FAILED", error: String(cause) })
    })
    await surface.getByRole("button", { name: "启动已保存的检查（原生审批）", exact: true }).click()
    const terminal = await until(
      () => {
        assert(!unexpectedApproval, "WORKBENCH_UNEXPECTED_NATIVE_COMMAND_OR_REVIEW_FAILURE")
        return workbenchVisibleJson(surface)
      },
      (rows) => rows.some((row) => row.phase === "closed-with-result"),
      "WORKBENCH_NODE_NATURAL_EXIT_AND_CLOSE",
      60000
    )
    const task = terminal.find((row) => row.phase === "closed-with-result")!
    assert.equal(task.exitObserved, true)
    assert.equal(task.closeConfirmed, true)
    assert.equal(task.code, 0)
    assert.equal(task.signal, null)
    assert.equal(task.startEvidence, "sdk-result-observed")
    assert.match(String(task.output), /v22\./)
    assert.equal(approvedDigests.size, 1)
    assert.equal(unexpectedApproval, false)
    record("actual-Node-exit-and-close", task)
    await capture("native-Node-result")
    monitorStopped = true
    await monitor
    await nav.getByRole("button", { name: "返回聊天", exact: true }).click()
    await resourceZero("actual-page-close-zero-resources")
    await assertDraft()
    await composerHandle.dispose()
    await page.evaluate(
      ({ id, name, workspace }) => window.api.mods.revokeFunction(id, name, workspace),
      { id: threadId, name: runtimeName, workspace: nativeWorkspace }
    )
    const revoked = await until(
      () => page!.evaluate((id) => window.api.mods.status(id), threadId),
      (value) =>
        value.functionMods?.some(
          (item) => item.pluginId === pluginId && item.state === "needs-approval"
        ) === true,
      "WORKBENCH_REAL_SOURCE_REVOKED"
    )
    record("actual-source-revoked", revoked)
    const resident = (
      await page.evaluate((id) => window.api.mods.runtimeSessions(id), threadId)
    ).sessions.find((row) => row.threadId === threadId && row.state === "resident")
    if (resident) {
      assert(
        resident.diagnostics &&
          resident.diagnostics.subscriptions === 0 &&
          resident.diagnostics.inFlight === 0 &&
          resident.diagnostics.backgroundResources === 0
      )
      assert.equal(resident.canRelease, true)
      record(
        "original-native-runtime-release",
        await page.evaluate((row) => window.api.mods.releaseRuntimeSession(row), resident)
      )
    }
    const released = await until(
      () => page!.evaluate((id) => window.api.mods.runtimeSessions(id), threadId),
      (value) =>
        !value.sessions.some(
          (row) =>
            row.threadId === threadId && ["resident", "loading", "releasing"].includes(row.state)
        ) && value.retiring === 0,
      "WORKBENCH_NO_RETAINED_RUNTIME"
    )
    record("actual-retirement-settled", released)
    assert.equal(modelRequests, 0)
    assert.deepEqual(pageErrors, [])
    passed = true
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    const codeDescriptor =
      cause && typeof cause === "object"
        ? Object.getOwnPropertyDescriptor(cause, "code")
        : undefined
    const code =
      codeDescriptor &&
      "value" in codeDescriptor &&
      (typeof codeDescriptor.value === "string" || typeof codeDescriptor.value === "number")
        ? codeDescriptor.value
        : undefined
    record("failure", {
      message: error,
      code,
      stack: cause instanceof Error ? cause.stack : undefined
    })
    if (page) {
      const observed = await page
        .evaluate(() => ({
          passive:
            (window as unknown as { workbenchNativeProbe?: unknown }).workbenchNativeProbe ?? null,
          visibility: document.visibilityState,
          editorIntents: [...document.querySelectorAll("[data-native-editor-intent]")].map(
            (node) => ({
              id: node.getAttribute("data-native-editor-intent"),
              visible: node.getClientRects().length > 0
            })
          )
        }))
        .catch((cause) => ({ unavailable: String(cause) }))
      record("failure-readonly-observations", observed)
      await page
        .screenshot({
          path: join(fixture.isolated, "workbench-failure.png"),
          timeout: 3000,
          animations: "disabled"
        })
        .catch(() => {})
      writeFileSync(
        join(fixture.isolated, "workbench-failure-body.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "renderer unavailable")
      )
    }
  } finally {
    clearTimeout(watchdog)
    if (page)
      await clean("owned-cursor-observer", async () => {
        const observed = await page!.evaluate(() => {
          const target = window as unknown as {
            workbenchNativeProbe?: unknown
            workbenchCursorStop?: () => void
          }
          target.workbenchCursorStop?.()
          delete target.workbenchCursorStop
          return target.workbenchNativeProbe ?? null
        })
        record("owned-composer-passive-trace", observed)
      })
    if (page && threadId) {
      if (runtimeName)
        await clean("revoke-owned-source", () =>
          page!.evaluate(
            ({ id, name, workspace }) => window.api.mods.revokeFunction(id, name, workspace),
            { id: threadId, name: runtimeName, workspace: nativeWorkspace }
          )
        )
      await clean("cancel-owned-run", () =>
        page!.evaluate((id) => window.api.agent.cancel(id, { cancelWorkers: true }), threadId)
      )
      await clean("restore-own-watcher", () =>
        page!.evaluate(async (id) => {
          await window.api.workspace.ensureWatching(id)
          return window.api.workspace.setActiveThread(id)
        }, threadId)
      )
      for (const id of temporaryThreads)
        await clean(`delete-owned-LRU-thread:${id}`, () =>
          page!.evaluate((id) => window.api.threads.delete(id), id)
        )
    }
    monitorStopped = true
    await clean("approval-monitor", async () => {
      await monitor
    })
    await clean("normal-app-close", async () => {
      await app?.close()
    })
    await new Promise<void>((done) => server.close(() => done()))
    await clean("source-and-driver-fences", async () => {
      assert.equal(hash(manifestPath), manifestHash)
      readModsSourceCandidate(manifestPath)
      for (const [file, expected] of Object.entries(driverHashes))
        assert.equal(hash(join(root, file)), expected, `WORKBENCH_DRIVER_CHANGED:${file}`)
      const endHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true
      }).trim()
      assert.equal(endHead, driverHead, "WORKBENCH_DRIVER_HEAD_CHANGED")
      record("final-driver-head", { head: endHead })
    })
    if (cleanupFailures.length) {
      passed = false
      error ??= "WORKBENCH_CLEANUP_OR_INTEGRITY_UNVERIFIED"
    }
    if (modelRequests || previewResourceRequests || otherRequests) {
      passed = false
      error ??= "WORKBENCH_UNEXPECTED_NETWORK_REQUEST"
    }
    const reviewFiles = join(fixture.isolated, "native-dialog-reviews")
    if (existsSync(reviewFiles)) record("native-review-journal", readdirSync(reviewFiles))
    save()
    console.log(JSON.stringify({ passed, error, evidence: evidencePath }))
    if (!passed) process.exitCode = 1
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
