import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
import { startBotModelUsage, settleBotModelUsage } from "../src/main/bots/model-usage"
import { botIpcFailure } from "../src/main/bots/error-diagnostic"
import type { ModelResponseDiagnostic } from "../src/main/agent/model-response-diagnostics"
import { CmbBotRuntime } from "../src/main/bots/agent-runtime"
import { writeBotModelSnapshot } from "../src/main/bots/model-config"
import { DEFAULT_MOD_POLICY } from "../src/main/mods/policy-core"
import { isBotPluginPresentationAction } from "../src/shared/bot-plugin-panes"
import { BotSharedWorkspace } from "../src/main/bots/shared-workspace"
/** Real React UI + real domain API/Host; the model is a deterministic fixture. No personal data or credentials. */
import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { chromium, type Locator, type Page } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { BotHostLock } from "../src/main/bots/host-lock"
import { createBotPeerDispatchAdmission } from "../src/main/bots/peer-dispatch-admission"
import { ownedShellMaintenanceOwner } from "../src/main/bots/owned-shell-maintenance-fence"
import { BotArtifacts } from "../src/main/bots/artifacts"
import { BotDocumentReader } from "../src/main/bots/document-reader"
import { wordDocument } from "../src/main/bots/document-fixtures"
import { LocalBotComputerProvider } from "../src/main/bots/computer-provider"
import { botBrowserFileReceiver } from "../src/main/bots/browser-files"
import { botDownloadTool } from "../src/main/bots/download-tool"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotTeachService } from "../src/main/bots/teach-service"
import { BotSecretRequests } from "../src/main/bots/secret-requests"
import { setTimeout as delay } from "node:timers/promises"
import { botMessageLink } from "../src/shared/bot-deep-link"
import { waitForBotComputer } from "../src/main/bots/computer-wait"
import { botProfileTools } from "../src/main/bots/profile-tools"
import { botRoutineTools } from "../src/main/bots/routine-tools"
import { sendReviewedBotPeer } from "../src/main/bots/peer-approval"
import { BotStorageMonitor } from "../src/main/bots/storage-monitor"
import { GIB, type DiskVolumeSample } from "../src/main/bots/upstream/grok-disk-pressure"

async function clearPrompt(input: Locator) {
  await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a")
  await input.press("Backspace")
}

/** Unified search keeps the original domain content search and its assertions. */
async function openWorkspaceContentSearch(page: Page): Promise<void> {
  await page.getByRole("button", { name: "搜索工作区", exact: true }).click()
  const palette = page.getByRole("dialog", { name: "快速查找与操作", exact: true })
  await palette.getByRole("combobox").fill("搜索全部内容")
  await palette.getByRole("option").filter({ hasText: "搜索全部内容" }).click()
}
async function openSidebarFilter(page: Page): Promise<void> {
  if (await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).isVisible()) return
  await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
  await page.getByRole("menuitem", { name: "筛选 Bot 列表", exact: true }).click()
}

/** New opens a local chooser; an explicit option owns the original create request. */
async function createNewBotFromChooser(page: Page): Promise<void> {
  await page.getByRole("button", { name: "新建聊天", exact: true }).click()
  await page
    .getByRole("region", { name: "新建聊天", exact: true })
    .getByRole("option")
    .filter({ hasText: "创建新 Bot" })
    .click()
  // This scripted journey exercises manual approvals. Confirm the real creation
  // choice; an unresolved nonce replay returns its original request instead.
  const review = page.getByRole("dialog", { name: "创建 Bot", exact: true })
  if (await review.getByRole("button", { name: "创建 Bot", exact: true }).count()) {
    await review.getByRole("radio", { name: /^逐项确认/ }).check()
    await review.getByRole("button", { name: "创建 Bot", exact: true }).click()
  }
}

/** Read existing renderer state and DOM only; never initiate a refresh or navigation. */
async function inspectBranchSummaryBoundary(page: Page, conversationId: string, rootId: string) {
  return page.evaluate(
    ({ conversationId, rootId }) => {
      const state = (
        window as unknown as {
          fixtureWorkspace: Pick<
            typeof import("../src/renderer/src/lib/bot-workspace-store").useBotWorkspaceStore,
            "getState"
          >
        }
      ).fixtureWorkspace.getState()
      const threadViewId = `${conversationId}/thread/${rootId}`
      const root = state.messages[conversationId]?.find((message) => message.id === rootId)
      const thread = state.threads[threadViewId]
      const conversation = state.snapshot?.conversations.find((item) => item.id === conversationId)
      const describeElement = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          tag: node.tagName,
          role: node.getAttribute("role"),
          ariaLabel: node.getAttribute("aria-label"),
          ariaHidden: node.getAttribute("aria-hidden"),
          hidden: node.hidden,
          inert: node.inert,
          disabled: node instanceof HTMLButtonElement ? node.disabled : null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          style: {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            contentVisibility: style.contentVisibility,
            pointerEvents: style.pointerEvents
          }
        }
      }
      const rows = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].filter(
        (row) => row.dataset.messageId === rootId
      )
      const transcript = document.querySelector<HTMLElement>(".bot-transcript")
      return {
        capturedAt: Date.now(),
        performanceNow: performance.now(),
        visibilityState: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight },
        selected: state.selected,
        expectedMain: conversationId,
        expectedThread: threadViewId,
        snapshotCursor: state.snapshot?.cursor ?? null,
        dataEpoch: state.snapshot?.dataEpoch ?? null,
        hostId: state.host?.hostId ?? null,
        hostCapabilities: state.host?.capabilities ?? [],
        opening: { ...state.opening },
        viewportRestore: state.viewportRestore,
        viewportLease: state.viewportLease,
        hasNewer: { ...state.hasNewer },
        hasOlder: { ...state.hasOlder },
        historyFollowTail: { ...state.historyFollowTail },
        historyAnchorIds: { ...state.historyAnchorIds },
        transcriptError: state.transcriptError
          ? { viewId: state.transcriptError.viewId, code: state.transcriptError.code }
          : null,
        mainMessageCount: state.messages[conversationId]?.length ?? 0,
        mainRootSequence: root?.sequence ?? null,
        mainRootSummary: root?.threadSummary ?? null,
        cachedThread: thread ? { count: thread.count, readState: thread.readState } : null,
        mainReadState: conversation?.readState ?? null,
        mainThreadUnreadCount: conversation?.threadUnreadCount ?? null,
        transcript: transcript
          ? {
              scrollTop: transcript.scrollTop,
              scrollHeight: transcript.scrollHeight,
              clientHeight: transcript.clientHeight
            }
          : null,
        rows: rows.map((row) => {
          const ancestors = []
          for (let node = row.parentElement; node; node = node.parentElement)
            ancestors.push(describeElement(node))
          const item = row.closest<HTMLElement>("[data-known-size]")
          return {
            ...describeElement(row),
            measuredItem: item
              ? { index: item.dataset.index, knownSize: item.dataset.knownSize }
              : null,
            buttons: [...row.querySelectorAll<HTMLButtonElement>("button")].map(describeElement),
            ancestors
          }
        })
      }
    },
    { conversationId, rootId }
  )
}

async function waitResidentHistory(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      (window as unknown as { fixtureHistory(): { count: number } }).fixtureHistory().count ===
      expected,
    count
  )
}

async function waitBotComputerPreview(page: Page, name: string): Promise<void> {
  const preview = page.getByRole("button", {
    name: `展开 ${name} 的电脑画面`,
    exact: true
  })
  await preview.waitFor()
  await page.waitForFunction((botName) => {
    const screen = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (node) => node.getAttribute("aria-label") === `展开 ${botName} 的电脑画面`
    )
    const image = screen?.querySelector("img")
    return (
      screen?.getAttribute("aria-busy") === "false" && image?.complete && image.naturalWidth > 0
    )
  }, name)
  assert.equal(
    await page
      .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
      .count(),
    0,
    "A Bot-controlled preview must expose expansion, not remote input"
  )
}

async function main(directory: string, hostLock: BotHostLock) {
  const project = process.cwd(),
    renderer = join(project, "src/renderer/src")
  const output = resolve("output/bot-workspace")
  await mkdir(output, { recursive: true })
  await mkdir(join(directory, "host"))
  const sharedWorkspace = await BotSharedWorkspace.open(join(directory, "host"))
  const store = new BotStore(
      join(directory, "bots.sqlite"),
      undefined,
      undefined,
      sharedWorkspace.path
    ),
    files = new BotArtifacts(
      join(directory, "objects"),
      store,
      new BotDocumentReader({
        entry: resolve("src/main/bots/document-worker-entry.ts"),
        execArgv: ["--import", "tsx"]
      })
    )
  const exportBrowserEvents: { kind: string; at: number; url?: string; stack?: string }[] = []
  let tracingExport = false
  const tracedBrokers = new WeakSet<object>()
  const traceClose = (owner: { close(): Promise<void> }, kind: string) => {
    const close = owner.close.bind(owner)
    owner.close = () => {
      if (tracingExport)
        exportBrowserEvents.push({ kind, at: Date.now(), stack: new Error(kind).stack })
      return close()
    }
  }
  const createComputer = () => {
    const next = new LocalBotComputerProvider(join(directory, "profile"))
    traceClose(next, "provider-close-request")
    const get = next.get.bind(next)
    next.get = async () => {
      const broker = await get()
      if (!tracedBrokers.has(broker)) {
        tracedBrokers.add(broker)
        traceClose(broker, "broker-close-request")
      }
      return broker
    }
    next.persistence = store
    next.humanDownloadReceiver = (botId, conversationId, threadRootId) =>
      botBrowserFileReceiver({
        botId,
        conversationId: conversationId ?? store.directConversation(botId).id,
        threadRootId,
        store,
        files
      })
    return next
  }
  let computer = createComputer()
  let teach = new BotTeachService(join(directory, "teach"), store, computer)
  let secretRequests = new BotSecretRequests(store, computer)
  const routineReplayRuns: { runId: string; tool: string; callId: string }[] = []
  let releaseWork: (() => void) | undefined
  let deniedHistoryMessageId: string | undefined
  const delayedMessageReads = new Map<
    string,
    { requested: boolean; promise: Promise<unknown>; finish(value: unknown): void }
  >()
  const holdMessage = (id: string) => {
    let finish!: (value: unknown) => void
    const pending = {
      requested: false,
      promise: new Promise<unknown>((resolve) => (finish = resolve)),
      finish: (value: unknown) => finish(value)
    }
    delayedMessageReads.set(id, pending)
    return pending
  }
  const waitMessageRequest = async (pending: { requested: boolean }) => {
    const deadline = performance.now() + 3000
    while (!pending.requested && performance.now() < deadline) await delay(10)
    assert.equal(pending.requested, true, "the exact held message request was submitted")
  }
  let holdNextWork = false
  let firstPluginGrant = true
  let pluginRuntime: CmbBotRuntime | undefined
  let pluginRuntimeLoading: Promise<CmbBotRuntime> | undefined
  const pluginWorkers = await mkdtemp(join(output, ".plugin-workers-"))
  const actualPlugins = () =>
    (pluginRuntimeLoading ??= (async () => {
      const source = join(directory, "plugin")
      await cp(resolve("resources/mods/function-commands"), source, { recursive: true })
      await build({
        entryPoints: {
          "mod-host": "src/main/mods/host-entry.ts",
          "function-mod-host": "src/main/mods/v2/host-entry.ts"
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        outdir: pluginWorkers,
        external: ["quickjs-emscripten"],
        logLevel: "silent"
      })
      const modelFile = join(directory, "host", "models.private")
      await writeBotModelSnapshot(modelFile, {
        version: 1,
        defaultRef: "fixture",
        models: [
          {
            ref: "fixture",
            id: "fixture",
            name: "UI fixture",
            model: "gpt-test",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "test-only",
            maxTokens: 16000
          }
        ],
        mods: {
          enabled: true,
          policy: DEFAULT_MOD_POLICY,
          plugins: [
            viteUrlAssetsFixture(),
            { id: "fixture", name: "工作插件", enabled: true, path: source }
          ]
        }
      })
      pluginRuntime = new CmbBotRuntime(modelFile, computer, {
        files,
        sharedWorkspace,
        modsWorkerDirectory: pluginWorkers
      })
      return pluginRuntime
    })())
  const createHost = () =>
    new BotHost(
      store,
      {
        secretRequests,
        get functionSessions() {
          return pluginRuntime?.functionSessions
        },
        async pluginPanes(input, domain) {
          return (await actualPlugins()).pluginPanes(input, domain)
        },
        async connectors() {
          return [
            { id: "project-notes", name: "项目知识库", source: "connector" as const },
            {
              id: "bot-mod:fixture",
              name: "项目工作插件",
              source: "plugin" as const,
              capability: "mods" as const
            }
          ]
        },
        async execute(request) {
          const { run, lease, signal } = request
          const commandText = request.messages.find((message) => message.id === run.messageId)?.text
          if (
            run.source === "plugin-pane" ||
            commandText === "/plugin claw-board" ||
            commandText === "/plugin claw-client"
          )
            return (await actualPlugins()).execute(request)
          if (commandText === "下载目标审核验证") {
            tracingExport = true
            const broker = await computer.get()
            await broker.ensure(run.botId)
            const human = await broker.takeControl(broker.target(run.botId))
            await broker.teachObserve(run.botId, async (page) => {
              traceClose(page.context(), "context-close-request")
              const browser = page.context().browser()
              if (browser) traceClose(browser, "browser-close-request")
              page.once("close", () =>
                exportBrowserEvents.push({ kind: "page-close", at: Date.now(), url: page.url() })
              )
              page.once("crash", () =>
                exportBrowserEvents.push({ kind: "page-crash", at: Date.now() })
              )
              page
                .context()
                .once("close", () =>
                  exportBrowserEvents.push({ kind: "context-close", at: Date.now() })
                )
              await page.route("http://127.0.0.1:39174/export-review", (route) =>
                route.fulfill({
                  contentType: "text/html; charset=utf-8",
                  body: '<form action="http://127.0.0.1:39174/export-report" method="POST"><button>导出项目报告</button></form>'
                })
              )
              await page.route("http://127.0.0.1:39174/export-report", (route) => {
                assert.equal(route.request().method(), "POST")
                exportBrowserEvents.push({ kind: "export-post", at: Date.now() })
                return route.fulfill({
                  headers: { "Content-Disposition": 'attachment; filename="report.txt"' },
                  body: "审批后的实际项目报告"
                })
              })
              await page.goto("http://127.0.0.1:39174/export-review")
            })
            await broker.releaseControl(human)
            const check = () => store.assertLease(lease)
            const snapshot = await broker.act(broker.target(run.botId), { op: "snapshot" }, check)
            const ref = /ref=(e\d+)/.exec(snapshot.data!)![1]
            await botDownloadTool(
              request,
              computer,
              files,
              check,
              async (id, action, operation, beforeStart) => {
                const approval = store.requestInteraction(lease, {
                  kind: "approval",
                  action,
                  prompt: JSON.stringify(action)
                })
                while (store.getInteraction(approval.id).status === "pending")
                  await delay(25, undefined, { signal })
                if (store.getInteraction(approval.id).answer !== "approve") return "已拒绝"
                const stopped = await beforeStart?.()
                if (stopped) return stopped
                store.beginEffect(lease, { id, action, approvalId: approval.id })
                const result = await operation()
                store.settleEffect(lease, id, "succeeded", result)
                return result
              }
            ).invoke({
              id: "ui-export",
              name: "download_file",
              type: "tool_call",
              args: { ref, element: "导出当前项目的报告", name: "项目报告.txt" }
            })
            const artifact = store
              .artifacts(run.conversationId)
              .find((item) => item.runId === run.id)!
            assert.equal((await files.read(artifact.id)).bytes.toString(), "审批后的实际项目报告")
            return "项目报告已下载到当前对话。"
          }
          if (commandText === "浏览器目标审核验证") {
            const broker = await computer.get()
            await broker.ensure(run.botId)
            const human = await broker.takeControl(broker.target(run.botId))
            await broker.teachObserve(run.botId, async (page) => {
              await page.route("http://127.0.0.1:39174/review", (route) =>
                route.fulfill({
                  contentType: "text/html; charset=utf-8",
                  body: '<form action="http://127.0.0.1:39174/submit"><input aria-label="姓名" id="review-name"></form>'
                })
              )
              await page.goto("http://127.0.0.1:39174/review")
            })
            await broker.releaseControl(human)
            const target = broker.target(run.botId),
              check = () => store.assertLease(lease)
            const snapshot = await broker.act(target, { op: "snapshot" }, check)
            const ref = /ref=(e\d+)/.exec(snapshot.data!)![1]
            const action = { op: "fill", ref, value: "张三", element: "按要求填写申请人姓名" }
            const review = await broker.prepareReview(target, action, check)
            try {
              const approved = {
                browser: action,
                botId: run.botId,
                target,
                browserReview: review.context
              }
              const approval = store.requestInteraction(lease, {
                kind: "approval",
                action: approved,
                prompt: JSON.stringify(approved)
              })
              while (store.getInteraction(approval.id).status === "pending")
                await delay(25, undefined, { signal })
              if (store.getInteraction(approval.id).answer !== "approve") return "网页填写已拒绝。"
              await broker.assertReview(target, action, review, check)
              store.beginEffect(lease, {
                id: `ui-browser-${run.id}`,
                action: approved,
                approvalId: approval.id
              })
              await broker.act(target, action, check, undefined, review)
              store.settleEffect(lease, `ui-browser-${run.id}`, "succeeded", "填写已完成")
              return "网页姓名已填写，未提交表单。"
            } finally {
              await review.dispose()
            }
          }
          if (commandText === "完成审阅并回复结论") return "协作审阅已完成。"
          if (
            commandText === "例程审批验证" ||
            commandText === "协作派发审批验证" ||
            commandText === "例程创建消息验收" ||
            commandText === "例程更新消息验收"
          ) {
            const settings = store.autoReview.read(request.bot.id)
            if (!settings.isEnabled)
              store.autoReview.change({ ...settings, isEnabled: true, nonce: `review-${run.id}` })
            const check = () => store.assertLease(lease)
            const approve: import("../src/main/bots/profile-tools").ApproveLocalBotAction = async (
              id,
              action,
              operation
            ) => {
              const approval = store.requestInteraction(lease, {
                kind: "approval",
                action,
                prompt: JSON.stringify(action)
              })
              while (store.getInteraction(approval.id).status === "pending")
                await delay(25, undefined, { signal })
              if (store.getInteraction(approval.id).answer !== "approve") return "已拒绝"
              return store.approvedToolOnce(
                lease,
                { id, action, approvalId: approval.id },
                operation
              )
            }
            if (commandText === "例程创建消息验收" || commandText === "例程更新消息验收") {
              const updating = commandText === "例程更新消息验收"
              const name = "消息保存链路周检"
              const previous = updating
                ? store.routines(request.bot.id).find((routine) => routine.name === name)!
                : null
              const tool = botRoutineTools(
                request,
                check,
                async () => {
                  throw new Error("unexpected delete")
                },
                approve
              ).find((item) => item.name === (updating ? "update_routine" : "create_routine"))!
              const call = {
                id: updating ? "ui-outcome-update" : "ui-outcome-create",
                name: tool.name,
                type: "tool_call" as const,
                args: updating
                  ? {
                      id: previous!.id,
                      revision: previous!.revision,
                      prompt: "核对每周项目计划，保持暂停。",
                      enabled: false,
                      cron: "0 12 * * 0"
                    }
                  : {
                      name,
                      prompt: "核对保存消息与原详情，不立即执行。",
                      timezone: "Asia/Shanghai",
                      at: 4102444800000
                    }
              }
              const first = await tool.invoke(call)
              const replay = await tool.invoke(call)
              assert.deepEqual(replay.content, first.content)
              assert.equal(typeof first.content, "string")
              const confirmed = JSON.parse(first.content as string)
              assert.equal(confirmed.name, name)
              assert.equal(confirmed.botId, request.bot.id)
              assert.ok(confirmed.id)
              assert.equal(confirmed.revision, updating ? previous!.revision + 1 : 1)
              routineReplayRuns.push({ runId: run.id, tool: tool.name, callId: call.id })
              return updating ? "更新消息验收完整答复。" : "创建消息验收完整答复。"
            }
            if (commandText === "例程审批验证") {
              const tools = botRoutineTools(
                request,
                check,
                async () => {
                  throw new Error("unexpected delete")
                },
                approve
              )
              await tools
                .find((tool) => tool.name === "create_routine")!
                .invoke({
                  id: "ui-routine",
                  name: "create_routine",
                  type: "tool_call",
                  args: {
                    name: "评审日检",
                    prompt: "检查项目文档。\n".repeat(1100) + "末尾检查事项",
                    timezone: "Asia/Shanghai",
                    cron: "0 9 * * 1-5"
                  }
                })
              return "例程审核已处理。"
            }
            const recipient = store.listBots().find((bot) => bot.name === "文档评审助手")!
            const result = await sendReviewedBotPeer(
              request,
              { callId: "ui-peer", recipient: recipient.id, text: "完成审阅并回复结论" },
              check,
              approve
            )
            return result === "已拒绝" ? "本次协作派发已拒绝。" : "协作任务已派发。"
          }
          if (commandText === "双重审批验证") {
            const action = {
              shell: {
                command: "npm test",
                cwd: "C:/projects/payments",
                sandbox: "none",
                timeoutSeconds: 60
              }
            }
            const primary = store.requestInteraction(lease, {
              kind: "approval",
              prompt: JSON.stringify(action),
              action
            })
            await store.hookNotifications.run(
              lease,
              { key: "ui-command", interactionId: primary.id, action },
              async (invocation) => {
                const notification = {
                  hook: {
                    name: "项目通知",
                    event: "Notification",
                    type: "command",
                    invocation,
                    command: "node notify.cjs",
                    cwd: "C:/projects/payments",
                    sandbox: "none",
                    inputPreview: JSON.stringify({
                      tool_name: "execute",
                      notification_type: "permission_prompt"
                    })
                  }
                }
                store.hookNotifications.registerAction(lease, "hook:ui-notification", notification)
                const approval = store.requestInteraction(lease, {
                  kind: "approval",
                  prompt: JSON.stringify(notification),
                  action: notification
                })
                while (store.getInteraction(approval.id).status === "pending")
                  await delay(25, undefined, { signal })
                assert.equal(store.getInteraction(approval.id).answer, "approve")
                store.beginEffect(lease, {
                  id: "hook:ui-notification",
                  action: notification,
                  approvalId: approval.id
                })
                store.settleEffect(lease, "hook:ui-notification", "succeeded", "通知已完成")
              }
            )
            while (store.getInteraction(primary.id).status === "pending")
              await delay(25, undefined, { signal })
            assert.equal(store.getInteraction(primary.id).answer, "approve")
            store.beginEffect(lease, { id: "ui-command", action, approvalId: primary.id })
            store.settleEffect(lease, "ui-command", "succeeded", "原操作已完成")
            return "两项审批分别确认，任务已完成。"
          }
          if (commandText === "审批规则验证") {
            const action = {
              shell: {
                command: "npm test",
                definition: {
                  kind: "package_script",
                  path: "package.json",
                  sha256: "c".repeat(64),
                  definition: "node test.cjs"
                },
                cwd: "C:/projects/payments",
                timeoutSeconds: 60,
                sandbox: "unelevated"
              }
            }
            const approval = store.requestInteraction(lease, {
              kind: "approval",
              action,
              prompt: JSON.stringify(action),
              ruleScope: "a".repeat(64)
            })
            while (store.getInteraction(approval.id).status === "pending")
              await delay(25, undefined, { signal })
            return "审批规则验证已结束"
          }
          if (commandText === "/plugins") return "可用插件命令：/plugin project-note 备注内容"
          if (commandText === "/plugin project-note 审核完成") {
            const action = {
              pluginCommand: {
                name: "project-note",
                plugin: "function:project-tools",
                digest: "b".repeat(64),
                arguments: "审核完成",
                immediate: false
              }
            }
            const approval = store.requestInteraction(lease, {
              kind: "approval",
              action,
              prompt: JSON.stringify(action)
            })
            while (store.getInteraction(approval.id).status === "pending")
              await delay(25, undefined, { signal })
            return store.getInteraction(approval.id).answer === "approve"
              ? "插件命令结果：审核完成"
              : "插件命令已拒绝"
          }
          if (firstPluginGrant) {
            firstPluginGrant = false
            const action = {
              pluginGrant: {
                name: "项目工作插件",
                workspace: "C:/Projects/example",
                digest: "a".repeat(64)
              }
            }
            const approval = store.requestInteraction(lease, {
              kind: "approval",
              action,
              prompt: JSON.stringify(action)
            })
            while (store.getInteraction(approval.id).status === "pending")
              await delay(50, undefined, { signal })
            if (store.getInteraction(approval.id).answer !== "approve")
              throw new Error("Plugin authorization declined")
          }
          if (
            request.messages.some(
              (message) => message.id === run.messageId && message.text === "创建协作助手测试"
            )
          ) {
            const tools = botProfileTools(
              request,
              () => store.assertLease(lease),
              async (id, action, operation) => {
                const approval = store.requestInteraction(lease, {
                  kind: "approval",
                  action,
                  prompt: JSON.stringify(action)
                })
                while (store.getInteraction(approval.id).status === "pending")
                  await delay(50, undefined, { signal })
                if (store.getInteraction(approval.id).answer !== "approve") return "未创建"
                return store.approvedToolOnce(
                  lease,
                  { id, action, approvalId: approval.id },
                  operation
                )
              }
            )
            await tools
              .find((tool) => tool.name === "create_bot")!
              .invoke({
                name: "文档评审助手",
                description: "持续检查项目文档，整理变更并交付评审意见。"
              })
            return "协作助手配置已处理。"
          }
          if (
            request.messages.some(
              (message) => message.id === run.messageId && message.text === "当前任务补充测试"
            )
          ) {
            store.streamOutput(lease, "正在处理可追加要求的任务…")
            await new Promise<void>((resolve) => {
              releaseWork = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            signal.throwIfAborted()
            const additions = await store.steering.queue(lease).take({
              threadId: run.id,
              ownerRunToken: `${lease.owner}:${lease.fence}`,
              appliedIds: [],
              phase: "beforeModel"
            })
            return additions.length ? "已按补充要求调整结果。" : "原任务已完成。"
          }
          if (store.groups.isGroupRun(run.id)) {
            const count = store
              .messages(run.conversationId)
              .filter((message) => message.sender === "bot").length
            store.toolOnce(lease, "group-public", { count }, () =>
              store.groups.post(lease, count < 2 ? `群内公开结果 ${count + 1}` : "(pass)")
            )
            return "PRIVATE_GROUP_SCRATCH"
          }
          if (
            store
              .messages(run.conversationId)
              .some((message) => message.id === run.messageId && message.text === "安全输入测试")
          ) {
            const broker = await computer.get(),
              target = await broker.ensure(run.botId)
            const human = await broker.takeControl(target)
            await broker.teachObserve(run.botId, async (browserPage) => {
              await browserPage.route("http://127.0.0.1:39174/login", (route) =>
                route.fulfill({
                  contentType: "text/html; charset=utf-8",
                  body: '<html><body><input type="password" id="password" aria-label="账户密码"></body></html>'
                })
              )
              await browserPage.goto("http://127.0.0.1:39174/login")
            })
            await broker.releaseControl(human)
            const snapshot = await broker.act(
              broker.target(run.botId),
              { op: "snapshot" },
              () => {}
            )
            const ref = /ref=(e\d+)/.exec(snapshot.data!)![1]
            await secretRequests.request(
              request,
              { label: "测试网站密码", description: "完成你交办的测试网站登录", ref },
              "secret-ui",
              () => store.assertLease(lease)
            )
            return "已安全填入网页密码框，尚未提交表单。"
          }
          if (holdNextWork) {
            holdNextWork = false
            store.streamOutput(lease, "正在整理第一部分…")
            await new Promise<void>((resolve) => {
              releaseWork = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          }
          const userMessage = store
            .messages(run.conversationId)
            .find((message) => message.id === run.messageId)?.text
          if (userMessage === "等待归还浏览器测试") {
            await waitForBotComputer(request, computer)
            return "浏览器已归还，任务可以重新观察后继续。"
          }
          if (userMessage === "结构化输入测试" || userMessage === "取消输入测试") {
            const interaction = store.requestInteraction(lease, {
              kind: "question",
              prompt: JSON.stringify({
                botQuestions: {
                  version: 1,
                  input: {
                    questions: [
                      {
                        id: "target",
                        header: "环境",
                        question: "选择部署环境",
                        options: [
                          { label: "测试环境", description: "先验证功能" },
                          { label: "生产环境", description: "正式发布" }
                        ]
                      },
                      { id: "branch", header: "分支", question: "填写项目分支", options: [] },
                      {
                        id: "checks",
                        header: "验证",
                        question: "需要哪些验证？",
                        multiple: true,
                        options: [
                          { label: "接口测试", description: "检查接口行为" },
                          { label: "代码评审", description: "检查实现质量" }
                        ]
                      }
                    ]
                  }
                }
              })
            })
            while (store.getInteraction(interaction.id).status === "pending")
              await delay(50, undefined, { signal })
            const response = JSON.parse(store.getInteraction(interaction.id).answer!)
            return response.status === "cancelled"
              ? "已取消填写，未默认选择任何答案。"
              : `已确认：${response.answers.target.label} · ${response.answers.branch.text} · ${response.answers.target.additionalText} · ${response.answers.checks.labels.join("、")}`
          }
          await files.publish(
            {
              id: `result:${run.id}`,
              conversationId: run.conversationId,
              runId: run.id,
              name: "交付报告.md",
              mime: "text/markdown"
            },
            Buffer.from("# 验证报告\n\n任务已完成。"),
            lease
          )
          return "## 已完成\n\n- 已整理需求\n- 已生成交付报告\n\n可在**文件与成果**中保存。"
        }
      },
      4,
      computer,
      files,
      teach
    )
  let host = createHost()
  let diskSample: DiskVolumeSample = {
    complete: true,
    snapshots: [
      {
        volume: "Bot 数据所在磁盘",
        deviceId: "fixture",
        totalBytes: 100 * GIB,
        availableBytes: 2 * GIB
      }
    ]
  }
  host.storage = new BotStorageMonitor(
    () => [],
    async () => diskSample
  )
  await host.storage.sample()
  host.bindPeerDispatchAdmission(
    createBotPeerDispatchAdmission(store, directory, ownedShellMaintenanceOwner(hostLock), () =>
      hostLock.assertCurrent()
    )
  )
  let api = createBotAPI(host)
  const routineClickCalls: { method: string; input: unknown }[] = []
  const routineReadDiagnostics: {
    index: number
    method: string
    input: unknown
    provenance: unknown
  }[] = []
  const routinePanelCalls: { method: string; input: unknown }[] = []
  let holdRoutinePanelSave = false
  let releaseRoutinePanelSave: (() => void) | undefined
  let viewerComputerCalls = 0
  const viewerReadCalls: Record<string, number> = {}
  const highlight = await build({
    entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent"
  })
  host.start()
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      contents: `import React,{useSyncExternalStore} from "react"; import {createRoot} from "react-dom/client"; import {BotWorkspace} from "./src/renderer/src/components/bots/BotWorkspace"; import {Toaster} from "sonner"; import {applyThemePreference,setThemePreference,getThemePreference,subscribeThemePreference} from "./src/renderer/src/lib/theme-preference"; import {getThemeDefinition} from "./src/renderer/src/lib/theme-registry"; import {useBotNavigation} from "./src/renderer/src/lib/use-bot-navigation"; import {useBotWorkspaceStore} from "./src/renderer/src/lib/bot-workspace-store";
    window.fixtureHistory=()=>{const state=useBotWorkspaceStore.getState();return {count:state.messages[state.selected]?.length??0,selected:state.selected,hasOlder:!!state.hasOlder[state.selected],hasNewer:!!state.hasNewer[state.selected]}};
    window.fixtureDraftState=(viewId)=>{const state=useBotWorkspaceStore.getState();return {draft:state.drafts[viewId]??null,pending:state.pending[viewId]??null,sending:state.sending[viewId]??false,uploading:state.uploading[viewId]??false,draftRaw:localStorage.getItem("bot-draft:"+viewId),pendingRaw:localStorage.getItem("bot-pending:"+viewId)}};
    window.fixtureWorkspace=useBotWorkspaceStore;
    window.fixtureTheme=setThemePreference; applyThemePreference("codex-light");
    window.api={bots:new Proxy({}, {get:(_,method)=>(input)=>{
      if(method!=="routines")return window.botCall(method,input);
      const current=useBotWorkspaceStore.getState();
      const inspect=(selector)=>Array.from(document.querySelectorAll(selector)).map((node)=>({
        connected:node.isConnected,
        visible:node.getClientRects().length>0&&!node.closest("[hidden],[inert]")&&getComputedStyle(node).visibility!=="hidden",
        hiddenAncestor:Boolean(node.closest("[hidden]")),
        inertAncestor:Boolean(node.closest("[inert]")),
        inspectorTab:node.closest(".bot-inspector-panel")?.getAttribute("data-tab")??null,
        testId:node.getAttribute("data-testid"),
        label:node.getAttribute("aria-label")
      }));
      return window.botCall(method,input,{
        stack:new Error("routine read provenance").stack,
        performanceNow:performance.now(),
        selected:current.selected,
        dataEpoch:current.snapshot?.dataEpoch,
        cursor:current.snapshot?.cursor,
        summaries:inspect('[aria-label="例程"]'),
        details:inspect('[data-testid="bot-routine-detail"]')
      });
    }}),botHost:{restart:(input)=>window.fixtureRestartBotHost(input)},botShellResources:{inspect:async()=>({mode:"exclusive",review:{state:"ready",reason:"none",entries:[],title:"命令现场已核对",hint:"没有未确认关闭的命令现场。"}}),reveal:async()=>{throw new Error("No fixture resource record")},revealDiagnostics:async()=>{throw new Error("No fixture resource directory")}},botNavigation:{onOpen:(callback)=>{window.fixtureOpenBotLink=callback;return ()=>{delete window.fixtureOpenBotLink}},ready:async()=>{}}};
    function Fixture(){useBotNavigation();const theme=useSyncExternalStore(subscribeThemePreference,getThemePreference,getThemePreference);return <div style={{height:"100vh",display:"flex"}}><BotWorkspace/><Toaster position="top-center" richColors duration={2200} theme={getThemeDefinition(theme).colorScheme}/></div>}
    createRoot(document.getElementById("root")).render(<Fixture/>);`,
      resolveDir: project,
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(directory, "workspace.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"test-build"'
    },
    plugins: [
      viteUrlAssetsFixture(),
      {
        name: "fixture-outer-shell",
        setup(builder) {
          builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight-worker",
            namespace: "preview-worker"
          }))
          builder.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker { constructor(options) { const url = URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}], {type:"text/javascript"})); super(url, options); URL.revokeObjectURL(url); } }`
          }))
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) => {
            if (args.path === "./store" && !args.importer.startsWith(join(renderer, "lib")))
              return undefined
            return { path: "app-store", namespace: "fixture" }
          })
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: project,
            contents:
              args.path === "app-store"
                ? 'import {create} from "zustand"; export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:(open)=>{window.fixtureSettingsOpen=open}})); window.fixtureCoverBot=(open)=>useAppStore.setState({showCustomizeView:open});'
                : "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    // Matches upstream Playwright's launch defaults. The installed version lacks
    // this switch; updater children can retain Chrome's inherited stderr on macOS.
    args: ["--disable-updater-scheduler"],
    headless: true
  })
  const errors: string[] = []
  let loseNextMessageReceipt = false
  let loseNextSkillDeletionReceipt = false
  const skillDeletionRequests: unknown[] = []
  let failNextUploadChunk = false
  let failLocalSecondUploadAt: number | null = null
  let failNextInteractionDetail = false
  let blockPendingCardReads = false
  let loseNextRuleChange = false
  let loseNextAutoReviewChange = false
  let loseNextPaneAction = false
  let loseRecoveryReceipt: "before" | "after" | undefined
  const recoveryRequests: string[] = []
  let loseNextNotificationChange = true
  const notificationNonces: string[] = []
  const remoteShortcutKeys: string[] = []
  let delayNextBrowserFrame = false
  let delayedBrowserImage = ""
  let browserInputCalls = 0
  const uploadNonces: string[] = []
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  try {
    page.setDefaultTimeout(10000)
    let restartClicks = 0
    await page.exposeFunction("fixtureRestartBotHost", async (input: { hostId: string }) => {
      assert.equal(input.hostId, host.id)
      restartClicks++
      await delay(200)
      if (restartClicks === 1) throw new Error("仍有任务执行或等待回复")
      return api.status()
    })
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("UI error:", error.message)
    })
    await page.exposeFunction(
      "botCall",
      async (method: string, input: unknown, readProvenance?: unknown) => {
        // This broad UI fixture uses its own deterministic task executor, not
        // the SDK introduction runtime. Retain its legacy quiet-create contract;
        // real introductions have separate Store/SDK and MiniMax acceptance.
        // Modern work paging and primary-Bot capabilities remain enabled here.
        if (method === "status") {
          const status = await api.status()
          return {
            ...status,
            capabilities: status.capabilities?.filter((item) => item !== "bot-introduction-v1")
          }
        }
        if (["routines", "saveRoutine", "runRoutine", "deleteRoutine"].includes(method))
          routineClickCalls.push({ method, input })
        if (method === "routines") {
          routineReadDiagnostics.push({
            index: routineClickCalls.length - 1,
            method,
            input,
            provenance: readProvenance
          })
          if (routineReadDiagnostics.length > 64) routineReadDiagnostics.shift()
        }
        if (
          [
            "routines",
            "skills",
            "availableSkills",
            "skillTrials",
            "skillLibrary",
            "saveRoutine",
            "runRoutine",
            "deleteRoutine",
            "send",
            "computerInput",
            "computerControl"
          ].includes(method)
        )
          routinePanelCalls.push({ method, input })
        if (method === "saveRoutine" && holdRoutinePanelSave) {
          holdRoutinePanelSave = false
          const receipt = await api.saveRoutine(input as Parameters<typeof api.saveRoutine>[0])
          await new Promise<void>((resolve) => {
            releaseRoutinePanelSave = resolve
          })
          return receipt
        }
        if (method === "message") {
          const pending = delayedMessageReads.get((input as { id: string }).id)
          if (pending) {
            delayedMessageReads.delete((input as { id: string }).id)
            pending.requested = true
            return pending.promise
          }
        }
        if (method === "message" && (input as { id: string }).id === deniedHistoryMessageId)
          return {
            botFailure: { code: "forbidden", message: "该消息暂无访问权限，请重新确认后重试。" }
          }
        if (method === "recover") {
          recoveryRequests.push(JSON.stringify(input))
          const lose = loseRecoveryReceipt
          loseRecoveryReceipt = undefined
          if (lose === "before") throw new Error("测试核对请求发送中断")
          const receipt = await api.recover(input as Parameters<typeof api.recover>[0])
          if (lose === "after") throw new Error("测试核对回执丢失")
          return receipt
        }
        if (["snapshot", "status", "computerFrame", "computerOpen", "teachStatus"].includes(method))
          viewerReadCalls[method] = (viewerReadCalls[method] ?? 0) + 1
        if (method === "computerFrame" || method === "computerOpen") viewerComputerCalls++
        if (method === "computerFrame" && delayNextBrowserFrame) {
          delayNextBrowserFrame = false
          // A newer screenshot of the same painted document legitimately keeps
          // its continuous input lease. Exercise the unseen-document boundary
          // by navigating through the real API before withholding its image.
          const previous = await api.computerFrame(input as string)
          await api.computerInput({
            target: previous,
            input: {
              kind: "navigate",
              url: "http://127.0.0.1:39174/login",
              frameSeq: previous.frameSeq,
              navigationEpoch: previous.navigationEpoch
            }
          })
          const frame = await api.computerFrame(input as string)
          assert.notEqual(frame.navigationEpoch, previous.navigationEpoch)
          assert.notEqual(frame.humanInputLease?.id, previous.humanInputLease?.id)
          delayedBrowserImage = frame.image
          return { ...frame, image: "http://127.0.0.1:39175/delayed-frame" }
        }
        if (
          method === "pluginPaneAction" &&
          loseNextPaneAction &&
          !isBotPluginPresentationAction(input as Parameters<typeof api.pluginPaneAction>[0])
        ) {
          loseNextPaneAction = false
          await api.pluginPaneAction(input as Parameters<typeof api.pluginPaneAction>[0])
          throw new Error("测试面板响应丢失")
        }
        if (method === "send" && loseNextMessageReceipt) {
          loseNextMessageReceipt = false
          await api.send(input as Parameters<typeof api.send>[0])
          throw new Error("测试消息回执丢失")
        }
        if (method === "deleteSkill") {
          skillDeletionRequests.push(input)
          const receipt = await api.deleteSkill(input as Parameters<typeof api.deleteSkill>[0])
          if (loseNextSkillDeletionReceipt) {
            loseNextSkillDeletionReceipt = false
            throw new Error("测试技能删除回执丢失")
          }
          return receipt
        }
        if (method === "computerInput") {
          browserInputCalls++
          const value = input as Parameters<typeof api.computerInput>[0]
          if (value.input.kind === "key") remoteShortcutKeys.push(value.input.key)
        }
        if (method === "changeNotifications") {
          const change = input as Parameters<typeof api.changeNotifications>[0]
          notificationNonces.push(change.nonce)
          const result = await api.changeNotifications(change)
          if (loseNextNotificationChange) {
            loseNextNotificationChange = false
            throw new Error("测试通知设置响应丢失")
          }
          return result
        }
        if (method === "changeAutoReview" && loseNextAutoReviewChange) {
          loseNextAutoReviewChange = false
          await api.changeAutoReview(input as Parameters<typeof api.changeAutoReview>[0])
          throw new Error("测试审核设置响应丢失")
        }
        if (method === "changeApprovalRule" && loseNextRuleChange) {
          loseNextRuleChange = false
          await api.changeApprovalRule(input as Parameters<typeof api.changeApprovalRule>[0])
          throw new Error("测试规则响应丢失")
        }
        if (method === "pendingCard" && blockPendingCardReads)
          throw new Error("FIXTURE_PENDING_CARD_RETRY")
        if (method === "interactionDetail" && failNextInteractionDetail) {
          failNextInteractionDetail = false
          throw new Error("FIXTURE_HISTORY_RETRY")
        }
        if (!Object.hasOwn(api, method)) throw new Error("Unknown domain method")
        if (method === "beginUpload") uploadNonces.push((input as { nonce: string }).nonce)
        if (
          method === "uploadChunk" &&
          failLocalSecondUploadAt !== null &&
          uploadNonces.length >= failLocalSecondUploadAt
        ) {
          failLocalSecondUploadAt = null
          throw new Error("测试本地附件第二项中断")
        }
        if (method === "uploadChunk" && failNextUploadChunk) {
          failNextUploadChunk = false
          throw new Error("测试连接中断，请重试上传")
        }
        try {
          return await (api[method as keyof typeof api] as (value: unknown) => Promise<unknown>)(
            input
          )
        } catch (error) {
          // Match the native boundary: Playwright cannot preserve Error subclass fields.
          return botIpcFailure(error)
        }
      }
    )
    // An HTTP origin gives the real draft store localStorage semantics.
    await page.route("http://127.0.0.1:39173/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><head></head><body style="margin:0"><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1:39173/")
    await page.addStyleTag({ content: css.build(scanner.scan()) })
    for (const asset of bundle.outputFiles) {
      if (asset.path.endsWith(".css")) await page.addStyleTag({ content: asset.text })
      else if (asset.path.endsWith(".js")) await page.addScriptTag({ content: asset.text })
    }
    const exercisePluginPanes = async () => {
      const created = store.createBot({
        nonce: "pane-ui",
        name: "开发工作台",
        workspacePath: sharedWorkspace.path,
        connectorIds: ["bot-mod:fixture"]
      })
      const other = store.createBot({ nonce: "pane-ui-other", name: "文档助手" })
      await page.getByRole("button", { name: "开发工作台", exact: true }).click()
      const send = async (text: string) => {
        await page.getByLabel("向 Bot 交办工作").fill(text)
        await page.getByRole("button", { name: "发送", exact: true }).click()
      }
      await send("/plugin claw-board")
      await page.getByText("允许此 Bot 使用插件", { exact: false }).waitFor()
      await page.getByRole("button", { name: "授权此版本", exact: true }).click()
      await page.getByText("运行插件命令 · claw-board", { exact: true }).waitFor()
      await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
      const board = page.locator('[data-function-pane="claw-board"]')
      await board.getByText("点击次数：0", { exact: true }).waitFor()
      await board.getByRole("button", { name: "加一", exact: true }).click()
      await board.getByText("点击次数：1", { exact: true }).waitFor()
      await board.getByLabel("项目备注", { exact: true }).fill("本周发布检查")
      await board.getByRole("button", { name: "保存备注", exact: true }).click()
      await board.getByText("备注：本周发布检查", { exact: false }).waitFor()
      await board.getByLabel("面板视图", { exact: true }).selectOption("build")
      await board.getByText("视图：构建", { exact: false }).waitFor()
      await page.waitForFunction(
        () => !document.querySelector('[data-function-pane="claw-board"] button[disabled]')
      )
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
      )
      await page.screenshot({ animations: "disabled", path: join(output, "plugin-pane-light.png") })
      loseNextPaneAction = true
      await board.getByRole("button", { name: "加一", exact: true }).click()
      await page.getByRole("button", { name: "核对进度", exact: true }).waitFor()
      await board.getByText("点击次数：2", { exact: true }).waitFor()
      await page.getByRole("button", { name: "文档助手", exact: true }).click()
      await page.getByRole("button", { name: "开发工作台", exact: true }).click()
      await page.getByRole("button", { name: "核对进度", exact: true }).click()
      await page.getByRole("button", { name: "核对进度", exact: true }).waitFor({ state: "hidden" })
      assert.equal(await board.getByText("点击次数：2", { exact: true }).count(), 1)
      await send("/plugin claw-client")
      await page.getByText("运行插件命令 · claw-client", { exact: true }).waitFor()
      await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
      const client = page.locator('[data-function-pane="claw-client"]')
      await client.getByRole("button", { name: "本地加一", exact: true }).click()
      await client.getByText("本地计数：1", { exact: false }).waitFor()
      await page.waitForFunction(
        () => !document.querySelector('[data-function-pane="claw-client"] button[disabled]')
      )
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
      )
      await page.screenshot({ animations: "disabled", path: join(output, "plugin-pane-dark.png") })
      await page.setViewportSize({ width: 700, height: 850 })
      await page.screenshot({
        animations: "disabled",
        path: join(output, "plugin-pane-narrow.png")
      })
      assert.equal(
        await client.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        true
      )
      await page.setViewportSize({ width: 1440, height: 960 })
      assert.equal(
        store
          .messages(created.conversationId)
          .filter((message) => message.text === "插件面板已更新。").length,
        0
      )
      assert.notEqual(created.bot.id, other.bot.id)
    }
    if (process.env.CMB_BOT_PLUGIN_UI_ONLY === "1") {
      await exercisePluginPanes()
      assert.deepEqual(errors, [])
      console.log("PASS persistent plugin panes, client controls, response loss and themes")
      return
    }
    if (process.env.CMB_BOT_REVIEWED_EXPORT_UI_ONLY === "1") {
      await createNewBotFromChooser(page)
      await page.getByRole("heading", { name: "新 Bot", exact: true, level: 2 }).waitFor()
      await page.getByLabel("向 Bot 交办工作").fill("下载目标审核验证")
      await page.getByRole("button", { name: "发送", exact: true }).click()
      const approval = page.getByRole("region", { name: "操作审批" })
      await approval.getByText("实际目标：导出项目报告", { exact: true }).waitFor()
      assert((await approval.textContent())?.includes("export-report · POST"))
      await approval.getByRole("button", { name: "批准本次操作", exact: true }).click()
      await page
        .getByRole("main")
        .getByText("项目报告已下载到当前对话。", { exact: true })
        .waitFor()
      assert.deepEqual(errors, [])
      console.log("PASS actual reviewed POST export and immutable download bytes")
      return
    }
    await page
      .getByRole("button", { name: "磁盘空间严重不足，查看容量与清理入口", exact: true })
      .click()
    const storageDialog = page.getByRole("dialog", { name: "磁盘容量", exact: true })
    await storageDialog.getByRole("meter").waitFor()
    assert.equal(await storageDialog.getByRole("meter").getAttribute("aria-valuenow"), "98")
    await page.screenshot({ animations: "disabled", path: join(output, "storage-pressure.png") })
    diskSample = { complete: false, snapshots: [] }
    await host.storage.sample()
    await storageDialog.getByText("部分磁盘信息未能更新", { exact: false }).waitFor()
    assert.equal(await storageDialog.getByRole("meter").getAttribute("aria-valuenow"), "98")
    diskSample = {
      complete: true,
      snapshots: [
        {
          volume: "Bot 数据所在磁盘",
          deviceId: "fixture",
          totalBytes: 100 * GIB,
          availableBytes: 60 * GIB
        }
      ]
    }
    await host.storage.sample()
    await storageDialog.getByText("空间充足", { exact: true }).waitFor()
    await storageDialog.getByRole("button", { name: "Close", exact: true }).click()
    await page
      .getByRole("button", { name: "磁盘空间严重不足，查看容量与清理入口", exact: true })
      .waitFor({ state: "detached" })
    const firstUse = page.getByRole("region", { name: "主 Bot 首次引导", exact: true })
    await firstUse.waitFor()
    await firstUse.getByRole("button", { name: "创建主 Bot", exact: true }).waitFor()
    assert.equal(store.listBots().length, 0, "Rendering the first-use guide must not create a Bot")
    assert.equal(store.primary.read().botId, null)
    await page.getByRole("button", { name: "模型与应用设置", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureSettingsOpen: boolean }).fixtureSettingsOpen
      ),
      true
    )
    await page.screenshot({ animations: "disabled", path: join(output, "first-use.png") })
    const actualCreateBot = api.create
    const createNonces: string[] = []
    let loseBotCreation = true
    api.create = async (input) => {
      createNonces.push(input.nonce)
      const result = await actualCreateBot(input)
      if (loseBotCreation) {
        loseBotCreation = false
        throw new Error("Fixture lost Bot creation response")
      }
      return result
    }
    await createNewBotFromChooser(page)
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "核对原请求", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "bot-create-retry.png") })
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await createNewBotFromChooser(page)
    await dialog.waitFor({ state: "hidden" })
    assert.equal(store.listBots().length, 1)
    assert.equal(createNonces.length, 2)
    assert.equal(createNonces[0], createNonces[1])
    assert.equal(store.messages(store.snapshot().conversations[0].id).length, 0)
    assert.equal(store.snapshot().runs.length, 0)
    api.create = actualCreateBot
    await page.getByRole("heading", { name: "新 Bot", exact: true, level: 2 }).waitFor()
    await page.getByRole("button", { name: "新 Bot的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    await dialog.getByPlaceholder("使用 Bot 共享工作目录").waitFor()
    await dialog.getByText("查看共享目录位置", { exact: true }).click()
    await dialog.getByText(sharedWorkspace.path, { exact: true }).waitFor()
    await dialog.getByText("查看共享目录位置", { exact: true }).click()
    await dialog.getByLabel("名称", { exact: true }).fill("研发协作助手")
    await dialog.getByLabel("描述与职责").fill("整理需求、准备评审材料并交付验证报告。")
    await dialog.getByRole("button", { name: "自定义 Bot 头像" }).click()
    await dialog.getByRole("button", { name: "云朵形状" }).click()
    await dialog.getByRole("button", { name: "紫色头像" }).click()
    await page.screenshot({ animations: "disabled", path: join(output, "persona-editor.png") })
    await dialog.getByLabel("项目知识库", { exact: true }).check()
    await dialog.getByLabel("项目工作插件 · 工作插件", { exact: true }).check()
    const saveBox = (await dialog.getByRole("button", { name: "保存", exact: true }).boundingBox())!
    const dialogBox = (await dialog.boundingBox())!
    assert.ok(saveBox.y + saveBox.height <= dialogBox.y + dialogBox.height)
    await page.screenshot({ animations: "disabled", path: join(output, "connector-editor.png") })
    await dialog.getByRole("button", { name: "保存", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.getByRole("heading", { name: "研发协作助手", exact: true, level: 2 }).waitFor()
    assert.equal(store.listBots()[0].workspacePath, sharedWorkspace.path)
    const firstTask = page.getByRole("region", { name: "交办第一项任务", exact: true })
    await firstTask
      .getByText("已选择 2 个连接器，实际可用性与授权将在使用时检查。", { exact: true })
      .waitFor()
    const initialComposer = page.getByLabel("向 Bot 交办工作", { exact: true })
    await firstTask.getByRole("button", { name: /整理材料/ }).click()
    assert.match(await initialComposer.innerText(), /材料不足时先告诉我/)
    assert.equal(store.messages(store.snapshot().conversations[0].id).length, 0)
    await initialComposer.fill("不要覆盖我写好的草稿")
    await firstTask.getByRole("button", { name: /整理材料/ }).click()
    assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
    await page.screenshot({ animations: "disabled", path: join(output, "first-task.png") })
    await firstTask.getByRole("button", { name: "准备工作浏览器", exact: true }).click()
    await waitBotComputerPreview(page, store.listBots()[0].name)
    assert.equal((await api.computerOpen(store.listBots()[0].id)).control, "bot")
    assert.equal((await api.status()).computer?.state, "ready")
    await page.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
    await page.waitForFunction(
      () => document.activeElement === document.querySelector(".bot-composer-input")
    )
    assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
    if (process.env.CMB_BOT_NEW_CHAT_ENTRY_ONLY === "1") {
      const owner = store.listBots()[0]
      const originalConversation = store.directConversation(owner.id).id
      const colleague = await api.create({ nonce: "new-chat-existing", name: "收件人同事" })
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: colleague.bot.name, exact: true })
        .waitFor()
      const before = await api.computerOpen(owner.id)
      const originalInputs = browserInputCalls
      await page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
      const inspector = page.locator(".bot-inspector-panel")
      await inspector.getByRole("tab", { name: "电脑", exact: true }).click()
      await waitBotComputerPreview(page, owner.name)
      const inspectorNode = await inspector.elementHandle()
      assert.ok(inspectorNode)
      const historyBefore = await page.evaluate(() =>
        (window as unknown as { fixtureHistory(): { selected: string } }).fixtureHistory()
      )
      const countsBefore = {
        bots: store.listBots().length,
        conversations: store.snapshot().conversations.length,
        runs: store.snapshot().runs.length
      }
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      const chooser = page.getByRole("region", { name: "新建聊天", exact: true })
      const recipient = chooser.getByRole("combobox", { name: "选择聊天收件人", exact: true })
      await recipient.waitFor()
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "选择聊天收件人"
      )
      assert.equal(
        await inspector.evaluate((node, original) => node === original, inspectorNode),
        true
      )
      assert.equal(await inspector.isVisible(), false)
      assert.deepEqual(
        {
          bots: store.listBots().length,
          conversations: store.snapshot().conversations.length,
          runs: store.snapshot().runs.length
        },
        countsBefore
      )
      assert.equal(
        await chooser.getByRole("option").filter({ hasText: "创建群聊" }).isEnabled(),
        true
      )
      assert.equal(
        await chooser
          .getByRole("option")
          .filter({ hasText: "创建新 Bot" })
          .getAttribute("aria-selected"),
        "true"
      )
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
      )
      await page
        .getByText("当前已有草稿，请先发送或清空后再选择任务。", { exact: true })
        .waitFor({ state: "hidden" })
      await page.screenshot({ animations: "disabled", path: join(output, "new-chat-dark.png") })
      await page.setViewportSize({ width: 700, height: 850 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
      )
      assert.equal(await chooser.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true)
      await page.screenshot({
        animations: "disabled",
        path: join(output, "new-chat-light-narrow-reduced.png")
      })
      await chooser.getByRole("button", { name: "关闭新建聊天", exact: true }).click()
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
      assert.equal(await inspector.isVisible(), true)
      assert.equal(
        await inspector.evaluate((node, original) => node === original, inspectorNode),
        true
      )
      assert.deepEqual(
        await page.evaluate(() =>
          (window as unknown as { fixtureHistory(): { selected: string } }).fixtureHistory()
        ),
        historyBefore
      )
      const afterClose = await api.computerOpen(owner.id)
      assert.equal(afterClose.generation, before.generation)
      assert.equal(afterClose.controlEpoch, before.controlEpoch)
      assert.equal(afterClose.control, before.control)
      assert.equal(browserInputCalls, originalInputs)
      await page.setViewportSize({ width: 1440, height: 960 })
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
      )
      await initialComposer.press("Control+n")
      await recipient.waitFor()
      await recipient.fill("收件人同事")
      assert.equal(
        await chooser
          .getByRole("option", { name: colleague.bot.name, exact: true })
          .getAttribute("aria-selected"),
        "true"
      )
      await recipient.press("Enter")
      await page.getByRole("heading", { name: colleague.bot.name, level: 2, exact: true }).waitFor()
      assert.equal(store.listBots().length, countsBefore.bots)
      assert.equal(store.snapshot().runs.length, countsBefore.runs)
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: owner.name, exact: true })
        .click()
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
      const retired = await api.create({ nonce: "new-chat-retired-choice", name: "已删除收件人" })
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: retired.bot.name, exact: true })
        .waitFor()
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      await recipient.fill(retired.bot.name)
      const retiredOption = chooser.getByRole("option", { name: retired.bot.name, exact: true })
      assert.equal(await retiredOption.getAttribute("aria-selected"), "true")
      await api.delete({ id: retired.bot.id, revision: retired.bot.revision })
      await retiredOption.waitFor({ state: "hidden" })
      await recipient.press("Enter")
      assert.equal(await chooser.isVisible(), true)
      assert.equal(
        await chooser
          .getByRole("option")
          .filter({ hasText: "创建 已删除收件人" })
          .getAttribute("aria-selected"),
        "false"
      )
      assert.equal(store.listBots().length, countsBefore.bots)
      assert.equal(store.snapshot().conversations.length, countsBefore.conversations)
      assert.equal(store.snapshot().runs.length, countsBefore.runs)
      await chooser.getByRole("button", { name: "关闭新建聊天", exact: true }).click()
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      await chooser.getByRole("option").filter({ hasText: "创建群聊" }).click()
      const groupPane = chooser.getByRole("region", { name: "选择群聊成员", exact: true })
      await groupPane.waitFor()
      await groupPane.getByRole("button", { name: "返回选择 Bot", exact: true }).click()
      await groupPane.waitFor({ state: "hidden" })
      await recipient.waitFor()
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-new-chat-recipient input")
      )
      assert.equal(store.snapshot().conversations.filter((item) => item.kind === "group").length, 0)
      await page.keyboard.press("Escape")
      await chooser.waitFor({ state: "hidden" })
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
      assert.equal(store.directConversation(owner.id).id, originalConversation)
      await createNewBotFromChooser(page)
      await chooser.waitFor({ state: "hidden" })
      await page.getByRole("heading", { name: "新 Bot", level: 2, exact: true }).waitFor()
      assert.equal(store.listBots().length, countsBefore.bots + 1)
      assert.equal(store.snapshot().conversations.length, countsBefore.conversations + 1)
      assert.equal(store.snapshot().runs.length, countsBefore.runs)
      const stableCounts = {
        bots: store.listBots().length,
        conversations: store.snapshot().conversations.length,
        runs: store.snapshot().runs.length
      }
      const uploadStart = uploadNonces.length
      const recordNewChatDraftState = async (name: string) => {
        const ids = store.snapshot().conversations.map((conversation) => conversation.id)
        const actual = await page.evaluate(
          (viewIds) =>
            Object.fromEntries(
              viewIds.map((id) => [
                id,
                (
                  window as unknown as { fixtureDraftState(viewId: string): unknown }
                ).fixtureDraftState(id)
              ])
            ),
          ids
        )
        await writeFile(join(output, name), JSON.stringify(actual, null, 2))
      }
      const preservedRaw = await page.evaluate(
        (id) => localStorage.getItem(`bot-draft:${id}`),
        originalConversation
      )
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      const localEditor = chooser.getByRole("combobox", { name: "新聊天消息", exact: true })
      await localEditor.fill("清空之前的富文本")
      await localEditor.fill("")
      await page.waitForFunction(
        () => document.querySelector('[aria-label="新聊天消息"]')?.textContent === ""
      )
      const clearedEditor = await localEditor.evaluate((element) => {
        const editor = (
          element as HTMLElement & {
            editor: { getJSON(): unknown; getText(): string; isEmpty: boolean }
          }
        ).editor
        return {
          html: element.innerHTML,
          textContent: element.textContent,
          innerText: (element as HTMLElement).innerText,
          document: editor.getJSON(),
          text: editor.getText(),
          isEmpty: editor.isEmpty
        }
      })
      await writeFile(
        join(output, "new-chat-empty-editor.json"),
        JSON.stringify(clearedEditor, null, 2)
      )
      assert.equal(clearedEditor.textContent, "")
      assert.equal(clearedEditor.text, "")
      assert.equal(clearedEditor.isEmpty, true)
      await localEditor.fill("本地转交正文")
      await page.waitForFunction(
        () => document.querySelector(".bot-new-chat-card")?.hasAttribute("hidden") === true
      )
      assert.equal(
        await chooser.getByRole("button", { name: "发送消息", exact: true }).isDisabled(),
        true
      )
      assert.deepEqual(
        {
          bots: store.listBots().length,
          conversations: store.snapshot().conversations.length,
          runs: store.snapshot().runs.length
        },
        stableCounts
      )
      await chooser.locator('input[type="file"]').setInputFiles([
        {
          name: "本地第一项.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("LOCAL_HANDOFF_ONE")
        },
        { name: "本地第二项.txt", mimeType: "text/plain", buffer: Buffer.from("LOCAL_HANDOFF_TWO") }
      ])
      assert.equal(uploadNonces.length, uploadStart)
      await recipient.fill(owner.name)
      await recordNewChatDraftState("new-chat-drafts-before-occupied-recipient.json")
      await chooser.getByRole("option").filter({ hasText: owner.name }).click()
      assert.equal(await chooser.isVisible(), true)
      assert.equal(await localEditor.innerText(), "本地转交正文")
      assert.equal(
        await chooser
          .getByRole("button", { name: "移除附件 本地第一项.txt", exact: true })
          .isVisible(),
        true
      )
      assert.equal(
        await page.evaluate((id) => localStorage.getItem(`bot-draft:${id}`), originalConversation),
        preservedRaw
      )
      assert.equal(uploadNonces.length, uploadStart)
      failLocalSecondUploadAt = uploadStart + 2
      await recipient.fill(colleague.bot.name)
      await recordNewChatDraftState("new-chat-drafts-before-blank-recipient.json")
      await chooser.getByRole("option").filter({ hasText: colleague.bot.name }).click()
      await chooser.waitFor({ state: "hidden" })
      await page.getByRole("heading", { name: colleague.bot.name, level: 2, exact: true }).waitFor()
      const targetEditor = page.getByRole("combobox", { name: "向 Bot 交办工作", exact: true })
      assert.equal(await targetEditor.innerText(), "本地转交正文")
      await page.getByRole("button", { name: "重试上传", exact: true }).waitFor()
      assert.equal(uploadNonces.length, uploadStart + 2)
      const firstUpload = uploadNonces[uploadStart],
        secondUpload = uploadNonces[uploadStart + 1]
      assert.notEqual(firstUpload, secondUpload)
      assert.equal(
        store.artifacts(colleague.conversationId).filter((file) => file.id === firstUpload).length,
        1
      )
      assert.equal(
        store.artifacts(colleague.conversationId).filter((file) => file.id === secondUpload).length,
        0
      )
      assert.equal(store.snapshot().runs.length, stableCounts.runs)
      await targetEditor.press("End")
      await targetEditor.press("!")
      await page.getByRole("button", { name: "重试上传", exact: true }).click()
      await page.getByRole("button", { name: "移除附件 本地第二项.txt", exact: true }).waitFor()
      assert.equal(uploadNonces.at(-1), secondUpload)
      assert.equal(uploadNonces.filter((nonce) => nonce === firstUpload).length, 1)
      assert.equal(uploadNonces.filter((nonce) => nonce === secondUpload).length, 2)
      assert.equal(
        store.artifacts(colleague.conversationId).filter((file) => file.id === firstUpload).length,
        1
      )
      assert.equal(
        store.artifacts(colleague.conversationId).filter((file) => file.id === secondUpload).length,
        1
      )
      assert.equal(await targetEditor.innerText(), "本地转交正文!")
      assert.equal(store.snapshot().runs.length, stableCounts.runs)
      await page.getByRole("button", { name: "发送", exact: true }).click()
      await page.getByText("本地转交正文!", { exact: true }).waitFor()
      assert.equal(store.snapshot().runs.length, stableCounts.runs + 1)
      assert.equal(
        store
          .messages(colleague.conversationId)
          .filter((message) => message.sender === "user" && message.text === "本地转交正文!")
          .length,
        1
      )
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      await recipient.fill("具名新助手")
      assert.equal(
        await chooser.getByRole("option").filter({ hasText: "创建 具名新助手" }).count(),
        1
      )
      assert.equal(await chooser.getByRole("option").filter({ hasText: "创建群聊" }).count(), 0)
      assert.equal(store.listBots().length, stableCounts.bots)
      await chooser.getByRole("option").filter({ hasText: "创建 具名新助手" }).click()
      await chooser.waitFor({ state: "hidden" })
      const namedReview = page.getByRole("dialog", { name: "创建 Bot", exact: true })
      await namedReview.getByRole("button", { name: "创建 Bot", exact: true }).waitFor()
      assert.equal(store.listBots().length, stableCounts.bots)
      await namedReview.getByRole("radio", { name: /^逐项确认/ }).check()
      await namedReview.getByRole("button", { name: "创建 Bot", exact: true }).click()
      await page.getByRole("heading", { name: "具名新助手", level: 2, exact: true }).waitFor()
      assert.equal(store.listBots().length, stableCounts.bots + 1)
      assert.equal(store.snapshot().runs.length, stableCounts.runs + 1)
      // Exercise groupSaved with the same local draft/File owner, not the direct-chat continuation.
      const groupUploadStart = uploadNonces.length
      const groupQueueCursor = store.snapshot().cursor
      const originalSend = api.send
      const groupSubmissions: {
        input: Parameters<typeof api.send>[0]
        receipt: Awaited<ReturnType<typeof api.send>>
      }[] = []
      api.send = async (input) => {
        const receipt = await originalSend(input)
        groupSubmissions.push({ input, receipt })
        return receipt
      }
      const groupRecipient = groupPane.getByRole("combobox", {
        name: "选择群聊收件人",
        exact: true
      })
      const chooseGroupMembers = async () => {
        for (const member of [owner, colleague.bot]) {
          await groupRecipient.fill(member.name)
          assert.equal(
            await groupPane
              .getByRole("option", { name: member.name, exact: true })
              .getAttribute("aria-selected"),
            "true"
          )
          await groupRecipient.press("Enter")
          await groupPane
            .getByRole("button", { name: `移除 ${member.name}`, exact: true })
            .waitFor()
        }
      }
      const originalCreateGroup = api.createGroup
      try {
        // A real accepted request with a lost ACK belongs to its original empty local session.
        const oldGroupCalls: Parameters<typeof api.createGroup>[0][] = []
        let loseOldGroupAck = true
        api.createGroup = async (input) => {
          oldGroupCalls.push(input)
          const result = await originalCreateGroup(input)
          if (loseOldGroupAck) {
            loseOldGroupAck = false
            throw new Error("Fixture lost NewChat group creation response")
          }
          return result
        }
        await page.getByRole("button", { name: "新建聊天", exact: true }).click()
        await chooser.getByRole("option").filter({ hasText: "创建群聊" }).click()
        await chooseGroupMembers()
        await groupPane.getByRole("button", { name: "群聊资料", exact: true }).click()
        await groupPane.getByLabel("群聊名称", { exact: true }).fill("旧待确认协作组")
        await groupPane.getByRole("button", { name: "创建群聊", exact: true }).click()
        await groupPane.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
        const oldGroup = store
          .snapshot()
          .conversations.find((item) => item.name === "旧待确认协作组")!
        assert.equal(oldGroup.kind, "group")
        assert.deepEqual(oldGroup.members, [owner.id, colleague.bot.id])
        assert.equal(oldGroupCalls.length, 1)
        const oldPendingRaw = await page.evaluate(() =>
          localStorage.getItem("bot-group-pending:new")
        )
        assert.ok(oldPendingRaw)
        assert.equal(JSON.parse(oldPendingRaw).input.nonce, oldGroupCalls[0].nonce)
        await groupPane.getByRole("button", { name: "稍后核对", exact: true }).click()
        await chooser.waitFor({ state: "hidden" })
        const oldOrigin = await page.evaluate(
          () =>
            (window as unknown as { fixtureHistory(): { selected: string } }).fixtureHistory()
              .selected
        )
        await page.getByRole("button", { name: "新建聊天", exact: true }).click()
        await chooser.getByRole("option").filter({ hasText: "创建群聊" }).click()
        await groupPane.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
        assert.equal(
          await groupPane.getByLabel("群聊名称", { exact: true }).inputValue(),
          oldGroup.name
        )
        await localEditor.fill("新页面不得带入旧群聊的正文")
        await chooser.locator('input[type="file"]').setInputFiles({
          name: "旧请求不得取得的新附件.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("NEW_INTENT_NOT_OLD_GROUP")
        })
        assert.equal(uploadNonces.length, groupUploadStart)
        assert.equal(groupSubmissions.length, 0)
        assert.equal(
          await page.evaluate(() => localStorage.getItem("bot-group-pending:new")),
          oldPendingRaw
        )
        await groupPane.getByRole("button", { name: "重试核对保存", exact: true }).click()
        await groupPane
          .getByRole("button", { name: "重试核对保存", exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(oldGroupCalls.length, 2)
        assert.deepEqual(oldGroupCalls[1], oldGroupCalls[0])
        assert.equal(await chooser.isVisible(), true)
        assert.equal(await localEditor.innerText(), "新页面不得带入旧群聊的正文")
        assert.equal(
          await chooser
            .getByRole("button", { name: "移除附件 旧请求不得取得的新附件.txt", exact: true })
            .isVisible(),
          true
        )
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { fixtureHistory(): { selected: string } }).fixtureHistory()
                .selected
          ),
          oldOrigin
        )
        assert.equal(
          await page.evaluate((id) => localStorage.getItem(`bot-draft:${id}`), oldGroup.id),
          null
        )
        assert.equal(await page.evaluate(() => localStorage.getItem("bot-group-pending:new")), null)
        assert.equal(store.artifacts(oldGroup.id).length, 0)
        assert.equal(store.messages(oldGroup.id).length, 0)
        assert.equal(uploadNonces.length, groupUploadStart)
        assert.equal(groupSubmissions.length, 0)
        assert.equal(
          store.events(groupQueueCursor, 1000).filter((event) => event.kind === "run.queued")
            .length,
          0
        )
        await groupPane.getByRole("button", { name: "关闭新建聊天", exact: true }).click()
        await chooser.waitFor({ state: "hidden" })
        api.createGroup = originalCreateGroup

        // A fresh two-member request may adopt its own text/Files; creation is never a send.
        const groupsBeforeLocal = store
          .snapshot()
          .conversations.filter((item) => item.kind === "group").length
        await page.getByRole("button", { name: "新建聊天", exact: true }).click()
        await chooser.getByRole("option").filter({ hasText: "创建群聊" }).click()
        await chooseGroupMembers()
        await groupPane.getByRole("button", { name: "群聊资料", exact: true }).click()
        await groupPane.getByLabel("群聊名称", { exact: true }).fill("本地正文附件协作组")
        await localEditor.fill("群聊本地正文保留到明确发送")
        await chooser.locator('input[type="file"]').setInputFiles({
          name: "群聊本地材料.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("LOCAL_GROUP_HANDOFF_FILE")
        })
        await chooser
          .getByRole("button", { name: "移除附件 群聊本地材料.txt", exact: true })
          .waitFor()
        assert.equal(uploadNonces.length, groupUploadStart)
        assert.equal(groupSubmissions.length, 0)
        assert.equal(
          store.snapshot().conversations.filter((item) => item.kind === "group").length,
          groupsBeforeLocal
        )
        assert.equal(
          store.events(groupQueueCursor, 1000).filter((event) => event.kind === "run.queued")
            .length,
          0
        )
        assert.equal(await groupRecipient.inputValue(), "")
        await page.screenshot({
          animations: "disabled",
          path: join(output, "new-chat-group-dark.png")
        })
        await page.setViewportSize({ width: 900, height: 840 })
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
        )
        await page.screenshot({
          animations: "disabled",
          path: join(output, "new-chat-group-light-narrow.png")
        })
        await page.setViewportSize({ width: 1440, height: 960 })
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
        )
        await groupRecipient.press("Enter")
        await chooser.waitFor({ state: "hidden" })
        await page
          .getByRole("heading", { name: "本地正文附件协作组", level: 2, exact: true })
          .waitFor()
        const localGroup = store
          .snapshot()
          .conversations.find((item) => item.name === "本地正文附件协作组")!
        assert.equal(localGroup.kind, "group")
        assert.deepEqual(localGroup.members, [owner.id, colleague.bot.id])
        assert.equal(
          store.snapshot().conversations.filter((item) => item.kind === "group").length,
          groupsBeforeLocal + 1
        )
        const localGroupEditor = page.getByRole("combobox", {
          name: "向 Bot 交办工作",
          exact: true
        })
        assert.equal(await localGroupEditor.innerText(), "群聊本地正文保留到明确发送")
        await page.getByRole("button", { name: "移除附件 群聊本地材料.txt", exact: true }).waitFor()
        assert.equal(uploadNonces.length, groupUploadStart + 1)
        const groupArtifact = store
          .artifacts(localGroup.id)
          .find((file) => file.id === uploadNonces[groupUploadStart])!
        assert.equal(groupArtifact.name, "群聊本地材料.txt")
        assert.equal(groupArtifact.size, Buffer.byteLength("LOCAL_GROUP_HANDOFF_FILE"))
        assert.equal(
          store.artifacts(localGroup.id).filter((file) => file.id === groupArtifact.id).length,
          1
        )
        assert.equal(store.messages(localGroup.id).length, 0)
        assert.equal(groupSubmissions.length, 0)
        assert.equal(
          store.events(groupQueueCursor, 1000).filter((event) => event.kind === "run.queued")
            .length,
          0
        )
        assert.equal(
          await page.getByRole("button", { name: "发送", exact: true }).isEnabled(),
          true
        )
        await page.getByRole("button", { name: "发送", exact: true }).click()
        await page.getByText("群聊本地正文保留到明确发送", { exact: true }).waitFor()
        assert.equal(groupSubmissions.length, 1)
        const submission = groupSubmissions[0]
        assert.equal(submission.input.conversationId, localGroup.id)
        assert.equal(submission.input.text, "群聊本地正文保留到明确发送")
        assert.deepEqual(submission.input.attachments, [groupArtifact.id])
        assert.equal(
          submission.receipt.runIds.length,
          1,
          "one explicit send admits the first group turn"
        )
        const groupUserMessage = store
          .messages(localGroup.id)
          .filter((message) => message.sender === "user")
        assert.equal(groupUserMessage.length, 1)
        assert.equal(groupUserMessage[0].id, submission.receipt.messageId)
        assert.equal(groupUserMessage[0].text, submission.input.text)
        assert.deepEqual(groupUserMessage[0].attachments, [groupArtifact.id])
        const firstGroupRun = store.getRun(submission.receipt.runIds[0])
        assert.equal(firstGroupRun.conversationId, localGroup.id)
        assert.equal(firstGroupRun.messageId, submission.receipt.messageId)
        assert.equal(
          store
            .events(groupQueueCursor, 1000)
            .filter((event) => event.kind === "run.queued" && event.entityId === firstGroupRun.id)
            .length,
          1
        )
      } finally {
        api.createGroup = originalCreateGroup
        api.send = originalSend
      }
      // One existing Bot may participate in a new room without cloning it,
      // moving its direct-chat draft, or admitting work merely by choosing it.
      const singleRoomCursor = store.snapshot().cursor
      const singleRoomBotCount = store.listBots().length
      const canonicalMessages = store.messages(originalConversation)
      await page.getByRole("button", { name: "新建聊天", exact: true }).click()
      await chooser.getByRole("option").filter({ hasText: "创建群聊" }).click()
      const singleRoomSave = groupPane.getByRole("button", { name: "创建群聊", exact: true })
      assert.equal(await singleRoomSave.isEnabled(), false)
      await groupRecipient.fill(owner.name)
      await groupRecipient.press("Enter")
      await groupPane.getByRole("button", { name: `移除 ${owner.name}`, exact: true }).waitFor()
      assert.equal(await singleRoomSave.isEnabled(), true)
      const currentCapabilities = await page.evaluate(
        () =>
          (
            window as unknown as {
              fixtureWorkspace: { getState(): { host: { capabilities: string[] } } }
            }
          ).fixtureWorkspace.getState().host.capabilities
      )
      await page.evaluate(
        (capabilities) => {
          const state = (
            window as unknown as {
              fixtureWorkspace: { getState(): { host: object }; setState(value: object): void }
            }
          ).fixtureWorkspace
          state.setState({ host: { ...state.getState().host, capabilities } })
        },
        currentCapabilities.filter((capability) => capability !== "single-bot-rooms-v1")
      )
      assert.equal(await singleRoomSave.isEnabled(), false, "Older Hosts retain their minimum")
      await page.evaluate((capabilities) => {
        const state = (
          window as unknown as {
            fixtureWorkspace: { getState(): { host: object }; setState(value: object): void }
          }
        ).fixtureWorkspace
        state.setState({ host: { ...state.getState().host, capabilities } })
      }, currentCapabilities)
      await groupPane.getByRole("button", { name: "群聊资料", exact: true }).click()
      await groupPane.getByLabel("群聊名称", { exact: true }).fill("单 Bot 独立会话")
      await singleRoomSave.click()
      await chooser.waitFor({ state: "hidden" })
      await page.getByRole("heading", { name: "单 Bot 独立会话", level: 2, exact: true }).waitFor()
      const singleRoom = store
        .snapshot()
        .conversations.find((item) => item.name === "单 Bot 独立会话")!
      assert.equal(singleRoom.kind, "group")
      assert.deepEqual(singleRoom.members, [owner.id])
      assert.notEqual(singleRoom.id, originalConversation)
      assert.equal(store.listBots().length, singleRoomBotCount)
      assert.deepEqual(store.messages(originalConversation), canonicalMessages)
      assert.equal(store.messages(singleRoom.id).length, 0)
      assert.equal(
        store
          .events(singleRoomCursor, 1000)
          .filter(
            (event) =>
              event.kind === "run.queued" &&
              store.getRun(event.entityId).conversationId === singleRoom.id
          ).length,
        0
      )
      assert.equal(
        await page.evaluate((id) => localStorage.getItem(`bot-draft:${id}`), originalConversation),
        preservedRaw
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, "new-chat-single-bot-room.png")
      })
      assert.deepEqual(errors, [])
      console.log(
        "PASS scoped New chooser/local composer, clear/cancel, real recipient draft and upload retry, original create/group, focus/computer identity and themes"
      )
      return
    }
    if (process.env.CMB_BOT_INSPECTOR_FOCUS_ONLY === "1") {
      const before = await api.computerOpen(store.listBots()[0].id)
      const originalInputs = browserInputCalls
      await page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
      const details = page.getByRole("complementary", {
        name: "研发协作助手 的详情",
        exact: true
      })
      await details.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await details.waitFor({ state: "detached" })
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      await page.keyboard.type("继续键入")
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿继续键入")
      const after = await api.computerOpen(store.listBots()[0].id)
      assert.equal(after.control, before.control)
      assert.equal(after.controlEpoch, before.controlEpoch)
      assert.equal(browserInputCalls, originalInputs)
      assert.equal(store.messages(store.snapshot().conversations[0].id).length, 0)
      assert.deepEqual(errors, [])
      console.log("PASS explicit browser/details close restores composer, draft and local typing")
      return
    }
    if (process.env.CMB_BOT_LOCAL_INSPECTOR_SHORTCUT_ONLY === "1") {
      const owner = store.listBots()[0]
      const before = await api.computerOpen(owner.id)
      const originalInputs = browserInputCalls
      const runs = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
      const messages = JSON.stringify(store.db.exec("SELECT id,text FROM bot_messages"))
      await page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
      const details = page.getByRole("complementary", { name: `${owner.name} 的详情`, exact: true })
      const detailsTab = details.getByRole("tab", { name: "详情", exact: true })
      await detailsTab.focus()
      assert.equal(await detailsTab.evaluate((node) => document.activeElement === node), true)
      await page.keyboard.press("Control+i")
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      assert.equal(await details.count(), 1)
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿")
      await page.keyboard.type("继续键入")
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿继续键入")
      const libraryTab = details.getByRole("tab", { name: "资料库", exact: true })
      await libraryTab.click()
      await page.keyboard.press("Control+i")
      assert.equal(await initialComposer.evaluate((node) => document.activeElement === node), true)
      const computerTab = details.getByRole("tab", { name: "电脑", exact: true })
      await computerTab.click()
      await page.keyboard.press("Control+i")
      const computerPanelTab = page
        .getByRole("complementary", { name: `${owner.name} 的电脑`, exact: true })
        .getByRole("tab", { name: "电脑", exact: true })
      assert.equal(await computerPanelTab.evaluate((node) => document.activeElement === node), true)
      assert.equal(await initialComposer.evaluate((node) => document.activeElement === node), false)
      await page.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
      await initialComposer.focus()
      await page.keyboard.press("Control+i")
      assert.equal(await initialComposer.evaluate((node) => document.activeElement === node), true)
      assert.equal(await initialComposer.innerText(), "不要覆盖我写好的草稿继续键入")
      const colleague = await api.create({ nonce: "shortcut-colleague", name: "快捷键协作同事" })
      const group = await api.createGroup({
        nonce: "local-inspector-shortcut-group",
        expectedDataEpoch: store.dataEpoch(),
        name: "本地详情快捷键协作组",
        members: [owner.id, colleague.bot.id]
      })
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: group.name, exact: true })
        .click()
      await page.getByRole("heading", { name: group.name, level: 2, exact: true }).waitFor()
      const groupComposer = page.getByLabel("向 Bot 交办工作", { exact: true })
      await groupComposer.fill("保留群聊快捷键草稿")
      await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
      const groupDetails = page.getByRole("complementary", {
        name: `${group.name} 的详情`,
        exact: true
      })
      const membersTab = groupDetails.getByRole("tab", { name: "成员", exact: true })
      await membersTab.click()
      await page.keyboard.press("Control+i")
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      assert.equal(await groupComposer.innerText(), "保留群聊快捷键草稿")
      assert.equal(await groupDetails.count(), 1)
      await page.keyboard.type("继续键入")
      assert.equal(await groupComposer.innerText(), "保留群聊快捷键草稿继续键入")
      await groupDetails.getByRole("tab", { name: "详情", exact: true }).click()
      await groupDetails.getByRole("button", { name: "编辑", exact: true }).click()
      const settings = page.getByRole("dialog", { name: "群聊设置", exact: true })
      const groupName = settings.getByLabel("群聊名称", { exact: true })
      await groupName.focus()
      await page.keyboard.press("Control+i")
      assert.equal(await groupName.evaluate((node) => document.activeElement === node), true)
      assert.equal(await groupName.inputValue(), group.name)
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      await settings.getByRole("button", { name: "取消", exact: true }).click()
      await settings.waitFor({ state: "hidden" })
      await groupDetails.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await groupDetails.waitFor({ state: "detached" })
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: owner.name, exact: true })
        .click()
      await page.getByRole("heading", { name: owner.name, level: 2, exact: true }).waitFor()
      assert.equal(
        await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
        "不要覆盖我写好的草稿继续键入"
      )
      const after = await api.computerOpen(owner.id)
      assert.equal(after.control, before.control)
      assert.equal(after.controlEpoch, before.controlEpoch)
      assert.equal(browserInputCalls, originalInputs)
      assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), runs)
      assert.equal(JSON.stringify(store.db.exec("SELECT id,text FROM bot_messages")), messages)
      assert.deepEqual(errors, [])
      console.log(
        "PASS local Bot/group details focus shortcut preserves drafts, remote and modal ownership"
      )
      return
    }
    if (process.env.CMB_BOT_GROUP_INSPECTOR_FOCUS_ONLY === "1") {
      const owner = store.listBots()[0]
      const before = await api.computerOpen(owner.id)
      const originalInputs = browserInputCalls
      const colleague = await api.create({ nonce: "group-focus-colleague", name: "群聊焦点同事" })
      const group = await api.createGroup({
        nonce: "group-inspector-close-focus",
        expectedDataEpoch: store.dataEpoch(),
        name: "焦点恢复协作组",
        description: "只核对已有群聊详情关闭和本地草稿焦点",
        members: [owner.id, colleague.bot.id]
      })
      const runs = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
      const messages = JSON.stringify(store.db.exec("SELECT id,text FROM bot_messages"))
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: group.name, exact: true })
        .click()
      await page.getByRole("heading", { name: group.name, level: 2, exact: true }).waitFor()
      const groupComposer = page.getByLabel("向 Bot 交办工作", { exact: true })
      await groupComposer.fill("保留群聊未发送草稿")
      await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
      const details = page.getByRole("complementary", { name: `${group.name} 的详情`, exact: true })
      await details.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await details.waitFor({ state: "detached" })
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      assert.equal(await groupComposer.innerText(), "保留群聊未发送草稿")
      await page.keyboard.type("继续键入")
      assert.equal(await groupComposer.innerText(), "保留群聊未发送草稿继续键入")
      // Opening settings keeps its own focus; closing it returns to the same
      // retained group panel before the explicit X asks for composer focus.
      await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
      await details.getByRole("button", { name: "编辑", exact: true }).click()
      const settings = page.getByRole("dialog", { name: "群聊设置", exact: true })
      const groupName = settings.getByLabel("群聊名称", { exact: true })
      await groupName.focus()
      assert.equal(await groupName.evaluate((node) => document.activeElement === node), true)
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      await settings.getByRole("button", { name: "取消", exact: true }).click()
      await settings.waitFor({ state: "hidden" })
      await details.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await details.waitFor({ state: "detached" })
      await page.waitForFunction(
        () => document.activeElement === document.querySelector(".bot-composer-input")
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, "group-inspector-close-focus.png")
      })
      await page
        .locator(".bot-sidebar")
        .getByRole("button", { name: owner.name, exact: true })
        .click()
      await page.getByRole("heading", { name: owner.name, level: 2, exact: true }).waitFor()
      assert.equal(
        await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
        "不要覆盖我写好的草稿"
      )
      const after = await api.computerOpen(owner.id)
      assert.equal(after.control, before.control)
      assert.equal(after.controlEpoch, before.controlEpoch)
      assert.equal(browserInputCalls, originalInputs)
      assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), runs)
      assert.equal(JSON.stringify(store.db.exec("SELECT id,text FROM bot_messages")), messages)
      assert.equal(store.messages(group.id).length, 0)
      assert.deepEqual(errors, [])
      console.log(
        "PASS group inspector X restores exact composer/drafts without settings focus theft or remote input"
      )
      return
    }
    await clearPrompt(initialComposer)
    await page.getByRole("button", { name: "查看插件命令", exact: true }).click()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "/plugins")
    await page.getByText("Enter 查看此 Bot 的插件命令", { exact: true }).waitFor()
    await page.getByLabel("向 Bot 交办工作").fill("整理本次迭代需求，并生成交付报告。")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("允许此 Bot 使用插件", { exact: false }).waitFor()
    await page.getByText("本次授权的代码版本", { exact: true }).click()
    await page.getByText("a".repeat(64), { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "plugin-approval.png") })
    await page.getByRole("button", { name: "授权此版本", exact: true }).click()
    await page.getByRole("heading", { name: "已完成", exact: true }).waitFor()
    const resultMessage = page.locator('.bot-message[data-sender="bot"]').first()
    await resultMessage.hover()
    await resultMessage.getByRole("button", { name: "添加表情回应", exact: true }).click()
    await page.getByRole("button", { name: "回应 👍", exact: true }).click()
    await resultMessage.getByRole("button", { name: "移除 👍 回应", exact: true }).waitFor()
    assert.equal(
      store.messages(store.snapshot().conversations[0].id).at(-1)?.reactionState?.reactions[0]
        .emoji,
      "👍"
    )
    await resultMessage.getByRole("button", { name: "添加表情回应", exact: true }).click()
    await page.getByLabel("其他表情", { exact: true }).fill("👩🏽‍💻")
    await page
      .getByRole("dialog", { name: "表情回应" })
      .getByRole("button", { name: "发送", exact: true })
      .click()
    await resultMessage.getByRole("button", { name: "移除 👩🏽‍💻 回应", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "message-reactions.png") })
    await resultMessage.getByRole("button", { name: "移除 👍 回应", exact: true }).click()
    await resultMessage
      .getByRole("button", { name: "移除 👍 回应", exact: true })
      .waitFor({ state: "detached" })
    assert.equal(store.snapshot().bots.length, 1)
    assert.deepEqual(store.snapshot().bots[0].connectorIds, ["bot-mod:fixture", "project-notes"])
    assert.equal(store.snapshot().bots[0].avatarShape, "cloud")
    assert.equal(store.snapshot().bots[0].avatarColor, "violet")
    const shortcutComposer = page.getByLabel("向 Bot 交办工作", { exact: true })
    await shortcutComposer.fill("保留这份草稿")
    await shortcutComposer.evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    assert.equal(await page.getByRole("dialog").count(), 0)
    await shortcutComposer.press("Control+f")
    const shortcutSearch = page.getByRole("dialog", { name: "搜索 Bot 工作区" })
    await shortcutSearch.waitFor()
    assert.equal(await shortcutSearch.getByRole("checkbox").isChecked(), true)
    await shortcutSearch.getByLabel("搜索内容").press("Control+n")
    assert.equal(await page.getByRole("dialog").count(), 1)
    await page.keyboard.press("Escape")
    assert.equal(await shortcutComposer.innerText(), "保留这份草稿")
    await shortcutComposer.press("Control+Shift+f")
    await shortcutSearch.waitFor()
    assert.equal(await shortcutSearch.getByRole("checkbox").isChecked(), false)
    await page.keyboard.press("Escape")
    await shortcutComposer.press("Control+k")
    const palette = page.getByRole("dialog", { name: "快速查找与操作" })
    await palette.waitFor()
    await palette.getByRole("combobox", { name: "快速查找" }).fill("快捷键")
    await palette.getByRole("option").filter({ hasText: "Bot 快捷键" }).waitFor()
    await palette.getByRole("combobox", { name: "快速查找" }).press("Enter")
    await page.getByRole("dialog", { name: "Bot 快捷键", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await shortcutComposer.press("Control+b")
    assert.equal(await page.locator(".bot-sidebar").getAttribute("data-compact"), "true")
    assert.ok((await page.locator(".bot-sidebar").boundingBox())!.width <= 70)
    await page.screenshot({ animations: "disabled", path: join(output, "compact-sidebar.png") })
    await page.getByRole("button", { name: "展开 Bot 列表", exact: true }).click()
    assert.equal(await page.locator(".bot-sidebar").getAttribute("data-compact"), null)
    await shortcutComposer.press("Control+Shift+m")
    await page.getByRole("dialog").waitFor()
    await page.keyboard.press("Escape")
    await openSidebarFilter(page)
    await page.getByLabel("搜索 Bot", { exact: true }).focus()
    await page.keyboard.press("Control+,")
    await page.getByRole("dialog").getByLabel("名称", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
    await page.getByRole("menuitem", { name: "Bot 快捷键", exact: true }).click()
    await page.getByRole("dialog", { name: "Bot 快捷键", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "keyboard-help.png") })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Bot 帮助", exact: true }).click()
    const help = page.getByRole("dialog", { name: "Bot 帮助与信息", exact: true })
    await help.getByText("如何开始？", { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "help-guide.png") })
    await help.getByRole("tab", { name: "关于与反馈", exact: true }).click()
    await help.getByText("test-build", { exact: true }).waitFor()
    await help.getByRole("button", { name: "重启后台", exact: true }).click()
    const restartNotice = help.locator('section[aria-label="后台维护"]').getByRole("alert")
    await restartNotice.waitFor()
    assert.match(await restartNotice.innerText(), /仍有任务/)
    await help.getByRole("button", { name: "重启后台", exact: true }).click()
    await help.getByText("后台已重新连接。", { exact: true }).waitFor()
    assert.equal(restartClicks, 2)
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:39173" })
    await help.getByRole("button", { name: "复制版本信息", exact: true }).click()
    await help.getByRole("button", { name: "已复制", exact: true }).waitFor()
    const copiedDiagnostic = await page.evaluate(() => navigator.clipboard.readText())
    assert.match(copiedDiagnostic, /应用版本: test-build/)
    assert.doesNotMatch(copiedDiagnostic, /hostId|credentials|token|projectPath|\/Users\//)
    const diagnosticDownload = page.waitForEvent("download")
    await help.getByRole("button", { name: "下载诊断信息", exact: true }).click()
    const diagnosticFile = await diagnosticDownload
    assert.equal(diagnosticFile.suggestedFilename(), "cmbdevclaw-bot-diagnostics.json")
    await diagnosticFile.saveAs(join(directory, "diagnostics.json"))
    const diagnosticInfo = JSON.parse(await readFile(join(directory, "diagnostics.json"), "utf8"))
    assert.equal(diagnosticInfo.应用版本, "test-build")
    assert.equal(diagnosticInfo.后台连接, "已连接")
    await help.getByRole("button", { name: "复制反馈模板", exact: true }).click()
    await help.getByRole("button", { name: "已复制反馈模板", exact: true }).waitFor()
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /^问题描述：\n复现步骤：/
    )
    for (const theme of ["codex-light", "codex-dark"]) {
      await page.evaluate(
        (theme) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(theme),
        theme
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, `help-about-${theme}.png`)
      })
    }
    await page.setViewportSize({ width: 700, height: 600 })
    await page.screenshot({ animations: "disabled", path: join(output, "help-about-narrow.png") })
    const helpTitle = help.getByRole("heading", { name: "Bot 帮助与信息", exact: true })
    const helpDownload = help.getByRole("button", { name: "下载诊断信息", exact: true })
    const titleBefore = (await helpTitle.boundingBox())!,
      downloadBefore = (await helpDownload.boundingBox())!
    assert.ok(
      titleBefore.y > 0 && downloadBefore.y + downloadBefore.height < 600,
      JSON.stringify({ titleBefore, downloadBefore })
    )
    const diagnosticRegion = help.getByRole("region", { name: "运行诊断信息", exact: true })
    assert.ok(
      await diagnosticRegion.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    await diagnosticRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    assert.equal((await helpTitle.boundingBox())!.y, titleBefore.y)
    assert.equal((await helpDownload.boundingBox())!.y, downloadBefore.y)
    assert.equal(
      await help
        .getByRole("tab", { name: "关于与反馈", exact: true })
        .getAttribute("aria-selected"),
      "true"
    )
    assert.ok(await help.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
    await page.screenshot({ animations: "disabled", path: join(output, "help-about-narrow.png") })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await help.getByRole("tab", { name: "使用指南", exact: true }).click()
    await help.getByRole("button", { name: "查看快捷键", exact: true }).click()
    await page.getByRole("dialog", { name: "Bot 快捷键", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Bot 帮助", exact: true }).click()
    await help.getByRole("button", { name: "打开应用设置", exact: true }).click()
    await help.waitFor({ state: "detached" })
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureSettingsOpen: boolean }).fixtureSettingsOpen
      ),
      true
    )
    assert.equal(await shortcutComposer.innerText(), "保留这份草稿")
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).focus()
    await page.keyboard.press("Control+i")
    assert.equal(await shortcutComposer.evaluate((node) => document.activeElement === node), true)
    await clearPrompt(shortcutComposer)
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "关闭 Bot 通知", exact: true }).click()
    await page.getByRole("menuitem", { name: "重试通知设置", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "重试通知设置", exact: true }).click()
    await page.getByRole("menuitem", { name: "开启 Bot 通知", exact: true }).waitFor()
    assert.equal(notificationNonces[0], notificationNonces[1])
    assert.equal(store.snapshot().notificationSettings?.[0].revision, 1)
    await page.screenshot({ animations: "disabled", path: join(output, "notification-menu.png") })
    await page.getByRole("menuitem", { name: "开启 Bot 通知", exact: true }).click()
    await page.getByRole("menuitem", { name: "关闭 Bot 通知", exact: true }).waitFor()
    assert.equal(store.snapshot().notificationSettings?.[0].revision, 2)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "头像图片", exact: true }).click()
    await page.getByRole("dialog", { name: "头像图片 · 研发协作助手" }).waitFor()
    await page.getByRole("button", { name: "上传图片", exact: true }).waitFor()
    await page.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(
      await page
        .locator('.bot-header [data-avatar-shape="cloud"][data-avatar-color="violet"]')
        .count(),
      1
    )
    assert.equal(store.artifacts(store.snapshot().conversations[0].id).length, 1)
    await page.screenshot({ animations: "disabled", path: join(output, "conversation.png") })
    await page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
    const inspector = page.getByRole("complementary", { name: "研发协作助手 的详情", exact: true })
    await inspector.getByRole("tab", { name: "详情", exact: true }).waitFor()
    assert.equal(await inspector.locator(".bot-computer-content").count(), 0)
    await page.screenshot({ animations: "disabled", path: join(output, "inspector-details.png") })
    await inspector.getByRole("tab", { name: "资料库", exact: true }).click()
    await inspector.getByRole("button", { name: "预览 交付报告.md", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "inspector-library.png") })
    await inspector.getByRole("button", { name: "预览 交付报告.md", exact: true }).click()
    await page.getByRole("button", { name: "复制本页文本" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    await inspector.getByRole("tab", { name: "资料库", exact: true }).focus()
    await page.keyboard.press("ArrowLeft")
    await inspector.getByRole("button", { name: "编辑", exact: true }).click()
    const profileDialog = page.getByRole("dialog", { name: "Bot 设置", exact: true })
    await profileDialog.waitFor()
    const profileId = store.listBots()[0].id
    const originalInstructions = store.getBot(profileId).instructions
    await profileDialog.getByLabel("描述与职责").fill("保留我的职责草稿")
    await api.update({
      id: profileId,
      revision: store.getBot(profileId).revision,
      instructions: "另一处更新的职责"
    })
    await profileDialog
      .getByText("Bot 已更新，当前草稿已保留。载入最新版本后再修改。", { exact: true })
      .waitFor()
    assert.equal(await profileDialog.getByLabel("描述与职责").inputValue(), "保留我的职责草稿")
    assert.equal(
      await profileDialog.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "bot-profile-conflict.png")
    })
    await profileDialog.getByRole("button", { name: "载入最新版本，替换草稿", exact: true }).click()
    assert.equal(await profileDialog.getByLabel("描述与职责").inputValue(), "另一处更新的职责")
    await profileDialog.getByLabel("描述与职责").fill(originalInstructions)
    const actualUpdateBot = api.update
    const updateNonces: (string | undefined)[] = []
    let loseBotUpdate = true
    api.update = async (input) => {
      updateNonces.push(input.nonce)
      const result = await actualUpdateBot(input)
      if (loseBotUpdate) {
        loseBotUpdate = false
        throw new Error("Fixture lost Bot update response")
      }
      return result
    }
    await profileDialog.getByRole("button", { name: "保存", exact: true }).click()
    await profileDialog.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    const savedProfileRevision = store.getBot(profileId).revision
    assert.equal(await profileDialog.getByLabel("描述与职责").isDisabled(), true)
    await profileDialog.getByRole("button", { name: "稍后核对", exact: true }).click()
    await inspector.getByRole("button", { name: "编辑", exact: true }).click()
    await profileDialog.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await profileDialog.waitFor({ state: "hidden" })
    assert.equal(store.getBot(profileId).revision, savedProfileRevision)
    assert.equal(store.getBot(profileId).instructions, originalInstructions)
    assert.equal(updateNonces.length, 2)
    assert.ok(updateNonces[0])
    assert.equal(updateNonces[0], updateNonces[1])
    api.update = actualUpdateBot
    assert.equal(await inspector.count(), 1)
    await inspector.getByRole("button", { name: "关闭详情面板", exact: true }).click()
    await inspector.waitFor({ state: "detached" })
    await page.waitForFunction(
      () => document.activeElement === document.querySelector(".bot-composer-input")
    )
    await page.getByRole("button", { name: "文件与成果", exact: true }).click()
    await page.getByText("交付报告.md", { exact: true }).waitFor()
    await page.getByRole("button", { name: "预览 交付报告.md", exact: true }).click()
    await page.getByRole("button", { name: "复制本页文本" }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "file-preview-markdown.png")
    })
    await page.keyboard.press("Escape")
    const previewConversation = store.snapshot().conversations[0].id
    const html = `<html><head><title>成果图表</title></head><body><h1>隔离的 HTML 成果</h1><div id="result"></div><script>try { parent.document.body.dataset.previewEscape = "yes"; document.getElementById("result").textContent="ESCAPED"; } catch { document.getElementById("result").textContent="HOST_ISOLATED"; } fetch("http://127.0.0.1:39173/exfil").catch(()=>{});</script></body></html>`
    await files.publish(
      {
        id: "preview-html",
        conversationId: previewConversation,
        runId: null,
        name: "成果.html",
        mime: "text/html"
      },
      Buffer.from(html)
    )
    await files.publish(
      {
        id: "preview-word",
        conversationId: previewConversation,
        runId: null,
        name: "方案.docx",
        mime: "application/octet-stream"
      },
      wordDocument("开头" + "a".repeat(32_000) + "末页核验")
    )
    // The open file list follows newly published artifacts without reopening the dialog.
    let escapedRequests = 0
    await page.route("http://127.0.0.1:39173/exfil", (route) => {
      escapedRequests++
      return route.abort()
    })
    await page.getByRole("button", { name: "预览 成果.html", exact: true }).click()
    await page
      .frameLocator('iframe[title="成果.html"]')
      .getByText("HOST_ISOLATED", { exact: true })
      .waitFor()
    assert.equal(await page.locator("body").getAttribute("data-preview-escape"), null)
    assert.equal(escapedRequests, 0)
    await page.screenshot({ animations: "disabled", path: join(output, "file-preview-html.png") })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "预览 方案.docx", exact: true }).click()
    await page.getByRole("button", { name: "下一页文本" }).click()
    await page.getByText("末页核验", { exact: false }).waitFor()
    await page.getByRole("button", { name: "上一页文本" }).click()
    await page.getByText("开头", { exact: false }).last().waitFor()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    const sharedFileBytes = Buffer.from("Shared artifact content")
    const deleteCandidate = await files.publish(
      {
        id: "file-to-delete",
        conversationId: previewConversation,
        runId: null,
        name: "待清理.txt",
        mime: "text/plain",
        origin: "browser"
      },
      sharedFileBytes
    )
    await files.publish(
      {
        id: "file-to-keep",
        conversationId: previewConversation,
        runId: null,
        name: "保留副本.txt",
        mime: "text/plain",
        origin: "project"
      },
      sharedFileBytes
    )
    await page.getByRole("button", { name: "文件与成果", exact: true }).click()
    await page.getByRole("button", { name: "删除文件 待清理.txt", exact: true }).click()
    await page
      .getByText("删除后，本对话将无法再打开此文件。其他对话的文件和项目原文件会保留。", {
        exact: true
      })
      .waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "file-delete-confirmation.png")
    })
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(store.getArtifact(deleteCandidate.id).origin, "browser")
    await page.getByRole("button", { name: "删除文件 待清理.txt", exact: true }).click()
    await page.getByRole("button", { name: "确认删除文件", exact: true }).click()
    await page
      .getByRole("button", { name: "删除文件 待清理.txt", exact: true })
      .waitFor({ state: "detached" })
    await page.getByRole("button", { name: "预览 保留副本.txt", exact: true }).click()
    await page.getByText("Shared artifact content", { exact: false }).waitFor()
    assert.throws(() => store.getArtifact(deleteCandidate.id), /已删除/)
    assert.equal((await files.read("file-to-keep")).bytes.toString(), "Shared artifact content")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    // Clipboard and drop use the real upload API and the same draft owner as the picker.
    const beforeComposerFiles = store.artifacts(previewConversation).length
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(["DROP_ATTACHMENT_CONTENT"], "拖入资料.txt", { type: "text/plain" }))
      return data
    })
    await page.locator(".bot-composer").dispatchEvent("dragenter", { dataTransfer: dropped })
    await page.getByText("松开以添加附件", { exact: true }).waitFor()
    await page.getByLabel("向 Bot 交办工作").dispatchEvent("dragenter", { dataTransfer: dropped })
    await page.getByLabel("向 Bot 交办工作").dispatchEvent("dragleave", { dataTransfer: dropped })
    assert.equal(await page.getByText("松开以添加附件", { exact: true }).isVisible(), true)
    await page.screenshot({ animations: "disabled", path: join(output, "composer-file-drop.png") })
    await page.locator(".bot-composer").dispatchEvent("drop", { dataTransfer: dropped })
    await dropped.dispose()
    await page.getByText("拖入资料.txt", { exact: true }).waitFor()
    assert.equal(await page.getByText("松开以添加附件", { exact: true }).count(), 0)
    await page.getByLabel("向 Bot 交办工作").fill("保留原来的任务说明")
    const pasteHandled = await page.getByLabel("向 Bot 交办工作").evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(["PASTE_ATTACHMENT_CONTENT"], "粘贴资料.txt", { type: "text/plain" }))
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(pasteHandled, true)
    await page.getByText("粘贴资料.txt", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "保留原来的任务说明")
    const plainPasteHandled = await page.getByLabel("向 Bot 交办工作").evaluate((element) => {
      const data = new DataTransfer()
      data.setData("text/plain", "普通文字")
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    // ProseMirror owns text paste so it can preserve selection and undo. It must
    // insert the text, never route it through attachment upload.
    assert.equal(plainPasteHandled, true)
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "保留原来的任务说明普通文字")
    await page
      .getByLabel("向 Bot 交办工作")
      .press(process.platform === "darwin" ? "Meta+z" : "Control+z")
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "保留原来的任务说明")
    assert.equal(store.artifacts(previewConversation).length, beforeComposerFiles + 2)
    const pasted = store
      .artifacts(previewConversation)
      .find((file) => file.name === "粘贴资料.txt")!
    assert.equal((await files.read(pasted.id)).bytes.toString(), "PASTE_ATTACHMENT_CONTENT")
    const excessive = await page.evaluateHandle(() => {
      const data = new DataTransfer()
      for (let i = 0; i < 7; i++)
        data.items.add(new File(["x"], `超额-${i}.txt`, { type: "text/plain" }))
      return data
    })
    await page.locator(".bot-composer").dispatchEvent("drop", { dataTransfer: excessive })
    await excessive.dispose()
    assert.equal(store.artifacts(previewConversation).length, beforeComposerFiles + 2)
    assert.equal(await page.getByRole("button", { name: /^移除附件 / }).count(), 2)
    const outsideDrop = await page.locator("body").evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(["x"], "不得导航.txt", { type: "text/plain" }))
      const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(outsideDrop, true)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "composer-added-files.png")
    })
    await page.getByRole("button", { name: "移除附件 拖入资料.txt", exact: true }).click()
    await page.getByRole("button", { name: "移除附件 粘贴资料.txt", exact: true }).click()
    await clearPrompt(page.getByLabel("向 Bot 交办工作"))
    failNextUploadChunk = true
    await page.locator('input[type="file"]').setInputFiles({
      name: "断点附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("RETRY_SAME_UPLOAD")
    })
    await page.getByRole("button", { name: "重试上传", exact: true }).waitFor()
    const interruptedNonce = uploadNonces.at(-1)!
    await page.getByLabel("向 Bot 交办工作").evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(
        new File(["must not replace retry"], "不得覆盖重试.txt", { type: "text/plain" })
      )
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      )
    })
    await page.getByText("请先重试或移除未完成的附件", { exact: true }).waitFor()
    assert.equal(uploadNonces.at(-1), interruptedNonce)
    await page.getByRole("button", { name: "重试上传", exact: true }).click()
    await page.getByText("断点附件.txt", { exact: true }).waitFor()
    assert.equal(uploadNonces.filter((nonce) => nonce === interruptedNonce).length, 2)
    assert.equal(
      store.artifacts(previewConversation).filter((file) => file.id === interruptedNonce).length,
      1
    )
    assert.equal((await files.read(interruptedNonce)).bytes.toString(), "RETRY_SAME_UPLOAD")
    assert.equal(
      store.artifacts(previewConversation).some((file) => file.name === "不得覆盖重试.txt"),
      false
    )
    await page.getByRole("button", { name: "移除附件 断点附件.txt", exact: true }).click()
    await page.locator('input[type="file"]').setInputFiles({
      name: "需求.md",
      mimeType: "text/markdown",
      buffer: Buffer.concat([Buffer.from("# 需求\n新增接口\n"), Buffer.alloc(9 * 1024 * 1024, 65)])
    })
    await page.getByText("需求.md", { exact: true }).waitFor()
    assert.ok(
      store
        .artifacts(store.snapshot().conversations[0].id)
        .some((file) => file.name === "需求.md" && file.size > 9 * 1024 * 1024)
    )
    await page.getByLabel("向 Bot 交办工作").fill("阅读附件")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByRole("button", { name: "查看附件 需求.md", exact: true }).waitFor()
    await page.getByRole("button", { name: "查看附件 需求.md", exact: true }).click()
    await page.getByRole("button", { name: "下一页文本" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByLabel("向 Bot 交办工作").fill("安全输入测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByPlaceholder("输入或粘贴密码", { exact: true }).fill("UI_PRIVATE_PASSWORD_7043")
    assert.equal(
      await page.getByPlaceholder("输入或粘贴密码", { exact: true }).getAttribute("type"),
      "password"
    )
    await page.screenshot({ animations: "disabled", path: join(output, "secret-input-card.png") })
    await page.getByRole("button", { name: "安全填入", exact: true }).click()
    await page.getByText("已安全填入网页密码框，尚未提交表单。", { exact: true }).last().waitFor()
    assert.ok(!(await page.content()).includes("UI_PRIVATE_PASSWORD_7043"))
    assert.ok(!JSON.stringify(store.snapshot()).includes("UI_PRIVATE_PASSWORD_7043"))
    assert.ok(
      !(await page.evaluate(() => JSON.stringify(localStorage))).includes(
        "UI_PRIVATE_PASSWORD_7043"
      )
    )
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "凭据管理", exact: true }).click()
    await page.getByRole("button", { name: "添加凭据", exact: true }).click()
    await page.getByLabel("凭据名称", { exact: true }).fill("研发平台")
    await page.getByLabel("允许使用的网站", { exact: true }).fill("https://dev.example.com")
    await page.getByLabel("密码", { exact: true }).fill("UI_SAVED_PRIVATE_VALUE_2014")
    await page.getByRole("button", { name: "保存凭据", exact: true }).click()
    await page.getByRole("button", { name: "替换 研发平台", exact: true }).click()
    assert.equal(await page.getByLabel("新密码", { exact: true }).inputValue(), "")
    await page.getByLabel("新密码", { exact: true }).fill("UI_REPLACED_PRIVATE_VALUE_5031")
    await page.getByRole("button", { name: "保存替换", exact: true }).click()
    await page.getByRole("button", { name: "替换 研发平台", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "saved-credentials.png") })
    const savedCatalog = await api.secrets(store.listBots()[0].id)
    assert.equal(savedCatalog.items[0].revision, 2)
    assert.ok(!JSON.stringify(savedCatalog).includes("PRIVATE_VALUE"))
    assert.ok(!(await page.content()).includes("PRIVATE_VALUE"))
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes("PRIVATE_VALUE"))
    await page.getByRole("button", { name: "删除凭据 研发平台", exact: true }).click()
    await page.getByRole("button", { name: "确认删除凭据", exact: true }).click()
    await page.getByText("还没有保存凭据", { exact: true }).waitFor()
    assert.equal((await api.secrets(store.listBots()[0].id)).items.length, 0)
    await page.keyboard.press("Escape")
    await page.getByLabel("向 Bot 交办工作").fill("结构化输入测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const questions = page.getByRole("region", { name: "待补充信息", exact: true })
    await questions.getByRole("radio", { name: "测试环境 先验证功能" }).waitFor()
    assert.equal(
      await questions.getByRole("button", { name: "提交", exact: true }).isDisabled(),
      true
    )
    assert.equal(
      await questions
        .getByRole("radio", { name: "测试环境 先验证功能" })
        .getAttribute("aria-checked"),
      "false"
    )
    await questions.getByRole("radio", { name: "测试环境 先验证功能" }).click()
    await questions.getByLabel("回答 分支", { exact: true }).fill("main")
    await questions.getByRole("button", { name: "切换到第 3 题：验证", exact: true }).click()
    await questions.getByRole("checkbox", { name: "接口测试 检查接口行为" }).click()
    await questions.getByRole("checkbox", { name: "代码评审 检查实现质量" }).click()
    assert.equal(
      await questions
        .getByRole("checkbox", { name: "接口测试 检查接口行为" })
        .getAttribute("aria-checked"),
      "true"
    )
    assert.equal(
      await questions
        .getByRole("checkbox", { name: "代码评审 检查实现质量" })
        .getAttribute("aria-checked"),
      "true"
    )
    await page.screenshot({ animations: "disabled", path: join(output, "multiple-choice.png") })
    await questions.getByRole("button", { name: "切换到第 1 题：环境", exact: true }).click()
    await questions.getByRole("button", { name: "为测试环境添加补充说明", exact: true }).click()
    await questions.getByLabel("测试环境的补充说明", { exact: true }).fill("先验证接口")
    await questions.getByRole("button", { name: "提交", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "structured-questions.png")
    })
    await questions.getByRole("button", { name: "提交", exact: true }).click()
    await page
      .getByRole("main")
      .getByText("已确认：测试环境 · main · 先验证接口 · 接口测试、代码评审", { exact: true })
      .waitFor()
    await page.getByLabel("向 Bot 交办工作").fill("双重审批验证")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const notificationCard = page
      .getByRole("region", { name: "操作审批", exact: true })
      .filter({ hasText: "发送审批通知" })
    await notificationCard
      .getByText("此授权仅用于通知脚本，原操作需单独确认。", { exact: true })
      .waitFor()
    assert.equal(await page.getByRole("region", { name: "操作审批", exact: true }).count(), 2)
    const notificationRun = store
      .snapshot()
      .runs.find(
        (run) =>
          store.message({ conversationId: run.conversationId, id: run.messageId }).text ===
          "双重审批验证"
      )!
    assert.equal(store.effects(notificationRun.id).length, 0)
    await notificationCard.scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "notification-approval.png")
    })
    await notificationCard.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await notificationCard.waitFor({ state: "hidden" })
    const primaryCard = page.getByRole("region", { name: "操作审批", exact: true })
    await primaryCard.getByText("npm test", { exact: true }).waitFor()
    assert.equal(store.getRun(notificationRun.id).status, "waiting_input")
    assert.equal(
      store.effects(notificationRun.id).some((effect) => effect.id === "ui-command"),
      false
    )
    await primaryCard.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page
      .getByRole("main")
      .getByText("两项审批分别确认，任务已完成。", { exact: true })
      .waitFor()
    assert.equal(store.effects(notificationRun.id).length, 2)
    await page.getByLabel("向 Bot 交办工作").fill("取消输入测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await questions.getByRole("button", { name: "取消回答", exact: true }).waitFor()
    assert.equal(
      await questions.getByRole("button", { name: "提交", exact: true }).isDisabled(),
      true
    )
    await questions.getByRole("button", { name: "取消回答", exact: true }).click()
    await page
      .getByRole("main")
      .getByText("已取消填写，未默认选择任何答案。", { exact: true })
      .waitFor()
    await page.getByRole("button", { name: "查看 Bot 浏览器" }).click()
    await page.getByRole("button", { name: "接管操作", exact: true }).click()
    await page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    const panel = page.locator(".bot-computer-panel")
    let releaseFrame!: () => void
    const heldFrame = new Promise<void>((resolve) => {
      releaseFrame = resolve
    })
    await page.route("http://127.0.0.1:39175/delayed-frame", async (route) => {
      await heldFrame
      await route.fulfill({
        contentType: "image/jpeg",
        body: Buffer.from(delayedBrowserImage.split(",")[1], "base64")
      })
    })
    const viewerImage = panel.locator(".bot-computer-screen img")
    try {
      delayNextBrowserFrame = true
      await panel.getByRole("button", { name: "刷新画面", exact: true }).click()
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>(".bot-computer-screen img")
          ?.src.endsWith("/delayed-frame")
      )
      const beforeImageLoaded = browserInputCalls
      // Dispatch at the real React handlers while the new screenshot is unavailable.
      await viewerImage.dispatchEvent("click", { clientX: 20, clientY: 20 })
      await panel.locator(".bot-computer-screen").dispatchEvent("keydown", { key: "Tab" })
      assert.equal(browserInputCalls, beforeImageLoaded, "Unseen frames cannot authorize input")
      assert.equal(
        await panel.getByRole("button", { name: "新建浏览器标签页", exact: true }).isDisabled(),
        true
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, "browser-frame-loading.png")
      })
    } finally {
      releaseFrame()
    }
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".bot-computer-screen img")
      return image?.complete && image.naturalWidth > 0
    })
    await panel.getByRole("button", { name: "刷新画面", exact: true }).click()
    const otherControl = new AbortController()
    const otherClient = createBotAPI(host, otherControl.signal)
    const controlBot = store.listBots()[0].id
    const retainedControl = await api.computerOpen(controlBot)
    await panel.getByLabel("向浏览器输入文本", { exact: true }).fill("保留尚未发送的网页输入")
    await panel.getByRole("tab", { name: "资料库", exact: true }).click()
    assert.equal(await panel.count(), 1)
    // Earlier tasks publish distinct artifacts with the same display name.
    await panel.getByRole("button", { name: "预览 交付报告.md", exact: true }).first().waitFor()
    const hiddenComputerCalls = viewerComputerCalls
    const hiddenTeachCalls = viewerReadCalls.teachStatus
    // Two polling periods: an inactive inspector must not keep capturing browser images.
    await delay(3200)
    assert.equal(viewerComputerCalls, hiddenComputerCalls, "Hidden computer must stop polling")
    assert.equal(
      viewerReadCalls.teachStatus,
      hiddenTeachCalls,
      "Hidden computer must stop Teach status reads"
    )
    assert.equal((await api.computerOpen(controlBot)).controlOwner, "self")
    await panel.getByRole("tab", { name: "电脑", exact: true }).click()
    await panel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    assert.equal(
      await panel.getByLabel("向浏览器输入文本", { exact: true }).inputValue(),
      "保留尚未发送的网页输入"
    )
    await panel.getByLabel("向浏览器输入文本", { exact: true }).fill("")
    const resumedControl = await api.computerOpen(controlBot)
    assert.equal(resumedControl.generation, retainedControl.generation)
    assert.equal(resumedControl.controlEpoch, retainedControl.controlEpoch)
    await panel.getByLabel("向浏览器输入文本", { exact: true }).fill("设置遮挡后保留的输入")
    await page.evaluate(() =>
      (window as unknown as { fixtureCoverBot(open: boolean): void }).fixtureCoverBot(true)
    )
    await delay(500)
    const coveredReads = { ...viewerReadCalls }
    await delay(3200)
    assert.deepEqual(
      viewerReadCalls,
      coveredReads,
      "Settings-covered viewers must suspend all polling"
    )
    await page.evaluate(() =>
      (window as unknown as { fixtureCoverBot(open: boolean): void }).fixtureCoverBot(false)
    )
    await panel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    assert.equal(
      await panel.getByLabel("向浏览器输入文本", { exact: true }).inputValue(),
      "设置遮挡后保留的输入"
    )
    assert.equal((await api.computerOpen(controlBot)).controlEpoch, retainedControl.controlEpoch)
    await panel.getByLabel("向浏览器输入文本", { exact: true }).fill("")
    if (
      process.env.CMB_BOT_INSPECTOR_UI_ONLY === "1" ||
      process.env.CMB_BOT_INSPECTOR_RESOURCES === "1"
    ) {
      // Drive the document lifecycle deterministically; native window visibility
      // is verified separately by desktop/platform acceptance.
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true })
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden"
        })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await delay(500)
      const backgroundReads = { ...viewerReadCalls }
      const hiddenBot = await api.create({ nonce: "hidden-window-bot", name: "后台创建验证" })
      await delay(3200)
      assert.deepEqual(viewerReadCalls, backgroundReads, "Hidden window must suspend viewer reads")
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "hidden")
        Reflect.deleteProperty(document, "visibilityState")
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await page.getByRole("button", { name: "后台创建验证", exact: true }).waitFor()
      await api.delete({ id: hiddenBot.bot.id, revision: hiddenBot.bot.revision })
      await page
        .getByRole("button", { name: "后台创建验证", exact: true })
        .waitFor({ state: "hidden" })
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
      )
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Performance.enable")
      await cdp.send("HeapProfiler.collectGarbage")
      const before = await cdp.send("Performance.getMetrics")
      for (let cycle = 0; cycle < 20; cycle++) {
        await panel.getByRole("tab", { name: "详情", exact: true }).click()
        await panel.getByRole("tab", { name: "电脑", exact: true }).click()
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
        )
        assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
        assert.equal(await page.locator(".bot-computer-content").count(), 1)
      }
      await cdp.send("HeapProfiler.collectGarbage")
      const after = await cdp.send("Performance.getMetrics")
      await panel.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
      await panel.waitFor({ state: "detached" })
      const closedCalls = viewerComputerCalls
      await delay(3200)
      assert.equal(viewerComputerCalls, closedCalls, "Unmounted computer must stop polling")
      const value = (metrics: typeof before.metrics, name: string) =>
        metrics.find((entry) => entry.name === name)?.value ?? null
      const report = {
        cycles: 20,
        hiddenPollingCalls: 0,
        hiddenTeachStatusCalls: 0,
        hiddenWindowViewerReads: 0,
        closedPollingCalls: viewerComputerCalls - closedCalls,
        singlePanelAndComputer: true,
        before: Object.fromEntries(
          ["JSHeapUsedSize", "Nodes", "JSEventListeners", "TaskDuration"].map((key) => [
            key,
            value(before.metrics, key)
          ])
        ),
        after: Object.fromEntries(
          ["JSHeapUsedSize", "Nodes", "JSEventListeners", "TaskDuration"].map((key) => [
            key,
            value(after.metrics, key)
          ])
        )
      }
      await writeFile(
        join(output, "inspector-resource-results.json"),
        JSON.stringify(report, null, 2)
      )
      await cdp.detach()
      assert.deepEqual(errors, [])
      console.log("PASS inspector state, polling cleanup and 20 tab cycles", JSON.stringify(report))
      if (process.env.CMB_BOT_INSPECTOR_UI_ONLY === "1") return
      await page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
      await panel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    }
    await otherClient.computerTake({
      ...(await otherClient.computerFrame(controlBot)),
      replaceHuman: true
    })
    await panel.getByText("另一客户端正在操作", { exact: true }).waitFor()
    assert.equal(await panel.getByLabel("浏览器网址").isDisabled(), true)
    assert.equal(
      await panel.getByRole("button", { name: "示范给 Bot", exact: true }).isDisabled(),
      true
    )
    await panel.getByRole("button", { name: "转移控制权", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
    assert.equal((await otherClient.computerFrame(controlBot)).controlOwner, "self")
    otherControl.abort()
    await panel.getByText("控制端已断开，Bot 保持暂停", { exact: true }).waitFor()
    await panel.getByRole("button", { name: "转移控制权", exact: true }).click()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "computer-control-transfer.png")
    })
    await page.getByRole("dialog").getByRole("button", { name: "确认转移", exact: true }).click()
    await panel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    assert.equal((await api.computerOpen(controlBot)).controlOwner, "self")
    const resize = page.getByRole("separator", { name: "调整详情面板大小" })
    const previousWidth = (await panel.boundingBox())!.width
    const handle = (await resize.boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 250)
    await page.mouse.down()
    await page.mouse.move(handle.x - 76, handle.y + 250, { steps: 8 })
    await page.mouse.up()
    assert.ok((await panel.boundingBox())!.width > previousWidth + 50)
    const enlargedWidth = (await panel.boundingBox())!.width
    await resize.focus()
    await page.keyboard.press("ArrowRight")
    assert.equal(Math.round((await panel.boundingBox())!.width), Math.round(enlargedWidth - 24))
    await page.getByRole("button", { name: "展开电脑面板", exact: true }).click()
    assert.equal(Math.round((await panel.boundingBox())!.width), 1440)
    await page.keyboard.press("Escape")
    assert.equal(Math.round((await panel.boundingBox())!.width), Math.round(enlargedWidth - 24))
    await page.getByRole("button", { name: "新建浏览器标签页", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".bot-browser-tab").length === 2)
    await page
      .getByRole("button", { name: /关闭标签页/ })
      .last()
      .click()
    await page.waitForFunction(() => document.querySelectorAll(".bot-browser-tab").length === 1)
    // Exercise manual pause on a work page. A login page correctly auto-pauses
    // before the UI is guaranteed to render the transient recording state.
    await (
      await computer.get()
    ).teachObserve(controlBot, async (browserPage) => {
      await browserPage.goto("about:blank")
      await browserPage.setContent("<html><body><h1>示范工作页</h1></body></html>")
    })
    await page.getByRole("button", { name: "示范给 Bot", exact: true }).click()
    await page.getByText("正在录制示范", { exact: false }).waitFor()
    await page.getByRole("button", { name: "暂停录制", exact: true }).click()
    await page.getByText("录制已暂停", { exact: false }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "teach-paused.png") })
    await page.getByRole("button", { name: "继续录制", exact: true }).click()
    await page.getByRole("button", { name: "丢弃录制", exact: true }).click()
    await page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
    await (
      await computer.get()
    ).teachObserve(controlBot, async (browserPage) => {
      await browserPage.goto("http://127.0.0.1:39174/login")
    })
    await page.getByRole("button", { name: "示范给 Bot", exact: true }).click()
    await page.getByText("检测到敏感输入或无法安全核对", { exact: false }).waitFor()
    await page.getByText("录制已暂停", { exact: false }).waitFor()
    assert.equal(teach.repository.list(store.listBots()[0].id)[0].frameCount, 0)
    // Login fields suspend capture. Continue on a work page without removing that protection.
    await (
      await computer.get()
    ).teachObserve(store.listBots()[0].id, async (browserPage) => {
      await browserPage.goto("about:blank")
      await browserPage.setContent(
        "<html><body><h1>示范工作页</h1><button>整理报告</button></body></html>"
      )
    })
    await page.getByRole("button", { name: "继续录制", exact: true }).click()
    // Wait for a real captured frame; a paused or failed recorder must fail this test.
    const captureDeadline = Date.now() + 10000
    while (!teach.repository.list(store.listBots()[0].id)[0].frameCount) {
      assert.ok(Date.now() < captureDeadline, "Teach did not capture a browser frame")
      await new Promise((done) => setTimeout(done, 50))
    }
    await page.getByRole("button", { name: "保存并学习", exact: true }).click()
    await page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
    await page.getByRole("button", { name: "查看示范记录", exact: true }).click()
    const history = page.getByRole("dialog")
    await history.getByRole("button", { name: "回看", exact: true }).first().click()
    await page.waitForFunction(
      () =>
        (document.querySelector('video[aria-label="示范录像"]') as HTMLVideoElement)?.readyState >=
        2
    )
    const download = page.waitForEvent("download")
    await history.getByRole("link", { name: "导出录像", exact: true }).click()
    const exported = await download
    assert.ok(exported.suggestedFilename().endsWith(".webm"))
    await exported.saveAs(join(directory, "exported-teach.webm"))
    assert.ok((await readFile(join(directory, "exported-teach.webm"))).length > 100)
    await page.screenshot({ animations: "disabled", path: join(output, "teach-history.png") })
    await history
      .getByRole("button", { name: /删除示范/ })
      .first()
      .click()
    await history.getByRole("button", { name: "确认删除", exact: true }).click()
    await history.getByText("暂无示范记录", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    const downloadBrowser = await computer.get()
    const remoteShortcutSurface = page.getByRole("application", {
      name: "浏览器画面，接管后点击或按键操作"
    })
    await remoteShortcutSurface.focus()
    await remoteShortcutSurface.press("Control+f")
    for (let attempt = 0; attempt < 40 && !remoteShortcutKeys.includes("Control+f"); attempt++)
      await delay(50)
    assert.ok(remoteShortcutKeys.includes("Control+f"))
    assert.equal(await page.getByRole("dialog", { name: "搜索 Bot 工作区" }).count(), 0)
    const downloadBot = store.listBots()[0].id
    await downloadBrowser.teachObserve(downloadBot, async (browserPage) => {
      await browserPage.route("http://127.0.0.1:39174/download-ui", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<html><body><button style="width:200px;height:60px" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['Browser export verified']));a.download='browser-export.txt';a.click()">Download</button></body></html>`
        })
      )
      await browserPage.goto("http://127.0.0.1:39174/download-ui")
    })
    const downloadFrame = await api.computerFrame(downloadBot)
    await api.computerInput({
      target: downloadFrame,
      input: {
        kind: "click",
        frameSeq: downloadFrame.frameSeq,
        x: 70,
        y: 30
      }
    })
    const downloadNotice = page
      .locator(".bot-message")
      .filter({ hasText: "已下载：browser-export.txt" })
    await downloadNotice.waitFor()
    await downloadNotice
      .getByRole("button", { name: "查看附件 browser-export.txt", exact: true })
      .click()
    await page.getByRole("dialog").getByText("Browser export verified", { exact: false }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "browser-download-preview.png")
    })
    await page.keyboard.press("Escape")
    await page.screenshot({ animations: "disabled", path: join(output, "computer.png") })
    await page.getByLabel("向 Bot 交办工作").fill("等待归还浏览器测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByRole("status").filter({ hasText: "等待你归还浏览器控制权" }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "computer-task-waiting.png")
    })
    await page.getByRole("button", { name: "归还 Bot", exact: true }).click()
    await page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
    await page
      .getByRole("main")
      .getByText("浏览器已归还，任务可以重新观察后继续。", { exact: true })
      .waitFor()
    await page.getByRole("button", { name: "关闭电脑面板" }).click()

    // Only newly mounted rows enter; polling must preserve message DOM identities.
    const message = page.locator("[data-message-id]").last()
    const messageId = await message.getAttribute("data-message-id")
    const original = await message.elementHandle()
    holdNextWork = true
    await page.getByLabel("向 Bot 交办工作").fill("继续整理评审材料")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.locator('.bot-work-state svg[data-grok-state="working"]').waitFor()
    await page.getByText("正在整理第一部分…", { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const viewport = document.querySelector(".bot-transcript")!.getBoundingClientRect()
      const activity = document.querySelector(".bot-work-state")!.getBoundingClientRect()
      return activity.top >= viewport.top && activity.bottom <= viewport.bottom + 1
    })
    const animated = page.locator(".bot-work-state svg > g").first()
    const transform = await animated.getAttribute("transform")
    await page.waitForFunction(
      (previous) =>
        document.querySelector(".bot-work-state svg > g")?.getAttribute("transform") !== previous,
      transform
    )
    assert.equal(
      await original!.evaluate(
        (node, id) => node === document.querySelector(`[data-message-id="${id}"]`),
        messageId
      ),
      true
    )
    await page.screenshot({ animations: "disabled", path: join(output, "working.png") })

    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() =>
      [...document.querySelectorAll("svg[data-grok-state]")].every(
        (node) => node.getAttribute("data-reduced-motion") === "true"
      )
    )
    assert.equal(await animated.getAttribute("transform"), "translate(0 0)")
    assert.equal(
      await page
        .locator(".bot-work-state")
        .evaluate((node) => getComputedStyle(node).animationName),
      "none"
    )
    await page.emulateMedia({ reducedMotion: "no-preference" })
    releaseWork?.()
    await page.locator(".bot-work-state").waitFor({ state: "detached" })

    await page.getByRole("button", { name: "更多 Bot 操作" }).click()
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click()
    await page.getByRole("button", { name: "更多 Bot 操作" }).click()
    await page.getByRole("menuitem", { name: "取消置顶", exact: true }).waitFor()
    await page.keyboard.press("Escape")

    await page.getByRole("button", { name: "更多 Bot 操作" }).click()
    await page.getByRole("menuitem", { name: "后台任务", exact: true }).click()
    await page.getByRole("dialog").getByText("当前没有后台任务", { exact: true }).waitFor()
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()

    await page.getByRole("button", { name: "更多 Bot 操作" }).click()
    await page.getByRole("menuitem", { name: "技能", exact: true }).click()
    const skillsDialog = page.getByRole("dialog")
    await skillsDialog.getByLabel("名称", { exact: true }).fill("整理评审报告")
    await skillsDialog
      .getByLabel("内容", { exact: true })
      .fill("按用户给出的迭代编号整理报告，核对交付文件内容。")
    await skillsDialog.getByRole("button", { name: "保存", exact: true }).click()
    await skillsDialog.getByRole("heading", { name: "整理评审报告", exact: true }).waitFor()
    await skillsDialog.getByRole("button", { name: "试跑", exact: true }).click()
    await skillsDialog.getByLabel("本次输入", { exact: true }).fill("迭代 2026-09-B")
    await skillsDialog
      .getByLabel("验收条件", { exact: true })
      .fill("交付可下载的评审报告，核对迭代编号。")
    await skillsDialog.getByRole("button", { name: "开始试跑", exact: true }).click()
    await skillsDialog.getByText("试跑记录 · 1", { exact: true }).click()
    await skillsDialog.getByText("版本 1 · 等待验收", { exact: true }).click()
    await skillsDialog.getByLabel("试跑验收依据", { exact: true }).fill("已核对交付报告与本次输入")
    await skillsDialog.getByRole("button", { name: "通过", exact: true }).click()
    await skillsDialog.getByText("版本 1 · 有通过的试跑记录", { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "skill-trial.png") })
    await skillsDialog.getByText("管理技能", { exact: true }).click()
    await skillsDialog.getByRole("button", { name: "设为例程", exact: true }).click()
    const skillRoutineDialog = page.getByRole("dialog", { name: "将技能设为例程", exact: true })
    await skillRoutineDialog.getByLabel("名称", { exact: true }).fill("已验收评审例程")
    await skillRoutineDialog
      .getByLabel("内容", { exact: true })
      .fill("按事件中的迭代编号生成报告并核对证据")
    await skillRoutineDialog.getByLabel("执行频率", { exact: true }).click()
    await page.getByRole("option", { name: "事件触发", exact: true }).click()
    await skillRoutineDialog.getByLabel("事件主题", { exact: true }).fill("review.iteration")
    await skillRoutineDialog.getByText("整理评审报告", { exact: false }).first().waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "skill-routine-light.png") })
    await skillRoutineDialog.getByRole("button", { name: "保存", exact: true }).click()
    await skillRoutineDialog.waitFor({ state: "detached" })
    const skillOwner = store
      .snapshot()
      .bots.find((bot) => store.skills(bot.id).some((skill) => skill.name === "整理评审报告"))!
    const linkedRoutine = store
      .routines(skillOwner.id)
      .find((routine) => routine.name === "已验收评审例程")!
    assert.equal(linkedRoutine.skillReferences?.[0].version, 1)
    await skillsDialog.getByRole("button", { name: "修订技能 整理评审报告", exact: true }).click()
    await skillsDialog
      .getByLabel("技能步骤", { exact: true })
      .fill("增加缺失输入检查，再整理报告并核对迭代编号。")
    await skillsDialog.getByRole("button", { name: "保存新版本", exact: true }).click()
    await skillsDialog.getByText("版本 2 · 尚未通过试跑", { exact: true }).waitFor()
    assert.equal(
      await skillsDialog.getByRole("button", { name: "设为例程", exact: true }).count(),
      0
    )
    await page.keyboard.press("Escape")
    await skillsDialog.waitFor({ state: "detached" })
    const trialMessage = page.getByRole("region", { name: "技能试跑", exact: true })
    await trialMessage.getByRole("heading", { name: "试跑 · 整理评审报告", exact: true }).waitFor()
    await trialMessage.getByText("v1", { exact: true }).waitFor()
    await trialMessage.getByText("迭代 2026-09-B", { exact: true }).waitFor()
    await trialMessage.getByText("交付可下载的评审报告，核对迭代编号。", { exact: true }).waitFor()
    const trialInstructions = trialMessage.getByText("Approval boundaries:", { exact: false })
    assert.equal(await trialInstructions.isVisible(), false)
    await trialMessage.scrollIntoViewIfNeeded()
    await page.screenshot({ animations: "disabled", path: join(output, "skill-trial-message.png") })
    await trialMessage.getByText("查看完整执行说明", { exact: true }).click()
    await trialInstructions.waitFor({ state: "visible" })
    assert.match(await trialInstructions.innerText(), /Run taught skill: 整理评审报告/)
    assert.match(await trialInstructions.innerText(), /Failure handling:/)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "skill-trial-message-instructions.png")
    })
    await trialMessage.getByText("查看完整执行说明", { exact: true }).click()
    assert.equal(await trialInstructions.isVisible(), false)
    assert.deepEqual(
      store.emitEvent({
        nonce: "changed-skill-ui",
        topic: "review.iteration",
        payload: "2026-09-C"
      }).runIds,
      []
    )
    assert.equal(store.routine(skillOwner.id, linkedRoutine.id).enabled, false)
    await page.getByRole("button", { name: "例程", exact: true }).click()
    const skillRoutineRow = page.locator(`#bot-routine-${linkedRoutine.id}`)
    await skillRoutineRow.getByText("技能：整理评审报告 · v1", { exact: true }).waitFor()
    await skillRoutineRow.getByText("需要设置", { exact: true }).waitFor()
    await skillRoutineRow.getByRole("button", { name: "编辑", exact: true }).click()
    const linkedEditor = page.getByRole("dialog", { name: "编辑例程", exact: true })
    await linkedEditor.getByText("所选技能版本已变化、停用或未经验收。", { exact: false }).waitFor()
    await linkedEditor.getByLabel("启用自动运行").check()
    assert.equal(
      await linkedEditor.getByRole("button", { name: "保存修改", exact: true }).isDisabled(),
      true
    )
    assert.equal(await linkedEditor.getByLabel("选择已验收技能").isDisabled(), true)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "skill-routine-version-block.png")
    })
    await linkedEditor.getByRole("button", { name: "取消", exact: true }).click()
    await page.keyboard.press("Escape")

    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), "dark")
    assert.notEqual(
      await page
        .locator(".bot-workspace")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      "rgb(255, 255, 255)"
    )
    await writeFile(
      join(output, "theme-styles.json"),
      JSON.stringify(
        await page.evaluate(() =>
          [
            ".bot-workspace",
            ".bot-list-row",
            ".bot-header-actions button",
            ".bot-composer",
            ".bot-computer-panel"
          ].map((selector) => {
            const node = document.querySelector(selector)
            const style = node && getComputedStyle(node)
            return {
              selector,
              color: style?.color,
              background: style?.backgroundColor,
              foreground: style?.getPropertyValue("--foreground"),
              muted: style?.getPropertyValue("--muted-foreground")
            }
          })
        ),
        null,
        2
      )
    )
    await page.screenshot({ animations: "disabled", path: join(output, "conversation-dark.png") })
    await page.setViewportSize({ width: 640, height: 800 })
    await page.getByLabel("向 Bot 交办工作").fill("在窄窗口继续工作\n保留草稿")
    await page.screenshot({ animations: "disabled", path: join(output, "conversation-narrow.png") })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.getByRole("button", { name: "查看 Bot 浏览器" }).click()
    await page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "computer-loading-narrow.png")
    })
    await waitBotComputerPreview(page, store.listBots()[0].name)
    assert.equal((await api.computerOpen(store.listBots()[0].id)).control, "bot")
    assert.equal(await page.locator(".bot-browser-tabs").count(), 0)
    await page.screenshot({ animations: "disabled", path: join(output, "computer-narrow.png") })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.getByRole("button", { name: "关闭电脑面板" }).click()
    assert.deepEqual(await page.getByLabel("向 Bot 交办工作").locator("p").allTextContents(), [
      "在窄窗口继续工作",
      "保留草稿"
    ])
    await page.setViewportSize({ width: 1440, height: 960 })
    const colleague = await api.create({
      nonce: "group-colleague",
      name: "质量验证 Bot",
      avatarColor: "cyan"
    })
    await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
    await page.getByRole("menuitem", { name: "创建协作群聊", exact: true }).click()
    const createGroupPane = page.getByRole("region", { name: "选择群聊成员", exact: true })
    await createGroupPane.getByRole("button", { name: "群聊资料", exact: true }).click()
    await createGroupPane.getByLabel("群聊名称", { exact: true }).fill("研发评审组")
    await createGroupPane.getByLabel("群聊描述", { exact: true }).fill("需求梳理与质量评审")
    for (const member of store.listBots().slice(0, 2)) {
      await createGroupPane
        .getByRole("combobox", { name: "选择群聊收件人", exact: true })
        .fill(member.name)
      await createGroupPane.getByRole("option", { name: member.name, exact: true }).click()
    }
    const actualCreateGroup = api.createGroup
    let loseGroupCreation = true
    api.createGroup = async (input) => {
      const result = await actualCreateGroup(input)
      if (loseGroupCreation) {
        loseGroupCreation = false
        throw new Error("Fixture lost group creation response")
      }
      return result
    }
    await createGroupPane.getByRole("button", { name: "创建群聊", exact: true }).click()
    await createGroupPane.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    assert.equal(await createGroupPane.getByLabel("群聊名称", { exact: true }).isDisabled(), true)
    await createGroupPane.getByRole("button", { name: "稍后核对", exact: true }).click()
    await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
    await page.getByRole("menuitem", { name: "创建协作群聊", exact: true }).click()
    assert.equal(
      await createGroupPane.getByLabel("群聊名称", { exact: true }).inputValue(),
      "研发评审组"
    )
    await createGroupPane.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await createGroupPane
      .getByRole("button", { name: "重试核对保存", exact: true })
      .waitFor({ state: "hidden" })
    await createGroupPane.getByRole("button", { name: "关闭新建聊天", exact: true }).click()
    await createGroupPane.waitFor({ state: "hidden" })
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    assert.equal(store.snapshot().conversations.filter((item) => item.kind === "group").length, 1)
    api.createGroup = actualCreateGroup
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    const groupEventCursor = store.snapshot().cursor
    await page.getByLabel("向 Bot 交办工作").fill("@everyone 讨论本次任务")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("群内公开结果 2", { exact: true }).waitFor()
    const group = store
      .snapshot()
      .conversations.find((conversation) => conversation.kind === "group")!
    const deadline = Date.now() + 10_000
    while (
      !store
        .events(groupEventCursor, 1000)
        .some((event) => event.kind === "group.completed" && event.entityId === group.id)
    ) {
      assert.ok(Date.now() < deadline, "Group round robin did not settle")
      await page.waitForTimeout(100)
    }
    assert.equal(await page.getByText("PRIVATE_GROUP_SCRATCH", { exact: true }).count(), 0)
    // Sender identity follows the persona, and navigating to a peer preserves
    // both conversations' drafts without sending or assigning any work.
    const groupAuthors = page.locator("button.bot-message-author[data-group-author]")
    assert.equal(await groupAuthors.count(), 2)
    const colors = await groupAuthors
      .locator(".bot-message-author-name")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))
    assert.notEqual(colors[0], colors[1])
    await page.getByLabel("向 Bot 交办工作").fill("群聊未发送草稿")
    const groupMessagesBefore = store.messages(group.id).length
    await page.getByRole("button", { name: "打开 质量验证 Bot 的聊天", exact: true }).click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").textContent(), "")
    await page.getByLabel("向 Bot 交办工作").fill("私聊未发送草稿")
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "群聊未发送草稿")
    assert.equal(store.messages(group.id).length, groupMessagesBefore)
    await clearPrompt(page.getByLabel("向 Bot 交办工作"))
    await page.locator(".bot-time-divider").waitFor()
    assert.equal(await page.locator(".bot-time-divider").count(), 1)
    assert.match(
      await page.locator(".bot-time-divider").innerText(),
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    )
    await page.screenshot({ animations: "disabled", path: join(output, "group-conversation.png") })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-conversation-light.png")
    })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
    const groupDetails = page.getByRole("complementary", { name: "研发评审组 的详情", exact: true })
    await groupDetails.getByText("需求梳理与质量评审", { exact: true }).waitFor()
    await groupDetails.getByRole("tab", { name: "资料库", exact: true }).click()
    await groupDetails.getByText("暂无文件", { exact: true }).waitFor()
    // The direct chat's report must not appear in the group's library.
    assert.equal(await groupDetails.getByText("交付报告.md", { exact: true }).count(), 0)
    await groupDetails.getByRole("tab", { name: "成员", exact: true }).click()
    assert.equal(
      await groupDetails
        .getByRole("list", { name: "群聊成员", exact: true })
        .getByRole("button", { name: /^打开 .+ 的聊天$/ })
        .count(),
      2
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-inspector-members.png")
    })
    const memberNavigationRuns = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
    await page.getByLabel("向 Bot 交办工作").fill("成员导航群草稿")
    await groupDetails
      .getByRole("button", { name: "打开 质量验证 Bot 的聊天", exact: true })
      .click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "私聊未发送草稿")
    await groupDetails.waitFor({ state: "detached" })
    // Establish this Bot's explicit preference here; do not inherit an unrelated
    // earlier Bot's fallback. Header reveals alone do not save a tab preference.
    const memberInspector = page.locator(".bot-inspector-panel")
    await memberInspector.waitFor()
    await memberInspector.getByRole("tab", { name: "详情", exact: true }).click()
    await memberInspector.getByRole("tab", { name: "电脑", exact: true }).click()
    await page.getByRole("complementary", { name: "质量验证 Bot 的电脑", exact: true }).waitFor()
    assert.equal(
      JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")),
      memberNavigationRuns
    )
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "成员导航群草稿")
    await clearPrompt(page.getByLabel("向 Bot 交办工作"))
    await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
    await groupDetails.getByRole("tab", { name: "成员", exact: true }).click()
    const quickMember = await api.create({ nonce: "quick-member", name: "成员交接验证 Bot" })
    const originalMemberSave = api.updateGroup
    let loseMemberSave = true
    api.updateGroup = async (input) => {
      const result = await originalMemberSave(input)
      if (loseMemberSave) {
        loseMemberSave = false
        throw new Error("Fixture lost member save response")
      }
      return result
    }
    await groupDetails.getByRole("button", { name: "添加成员", exact: true }).click()
    const memberPicker = page.getByRole("dialog", { name: "添加群聊成员", exact: true })
    const memberSearch = memberPicker.getByRole("textbox", {
      name: "搜索可添加的 Bot",
      exact: true
    })
    await memberSearch.fill("成员交接验证")
    await memberPicker.getByRole("button", { name: "添加 成员交接验证 Bot", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-add-member-dark.png")
    })
    await memberSearch.press("Escape")
    await memberPicker.waitFor({ state: "hidden" })
    assert.deepEqual(store.getConversation(group.id).members, group.members)
    // Radix restores focus on the next task after the closing animation unmounts.
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "添加成员")
    assert.equal(
      await groupDetails
        .getByRole("button", { name: "添加成员", exact: true })
        .evaluate((button) => button === document.activeElement),
      true
    )
    await groupDetails.getByRole("button", { name: "添加成员", exact: true }).press("Enter")
    await memberSearch.fill("成员交接验证")
    await memberPicker.getByRole("button", { name: "添加 成员交接验证 Bot", exact: true }).click()
    await groupDetails.getByRole("button", { name: "核对群聊修改", exact: true }).waitFor()
    const memberRevision = store.getConversation(group.id).revision
    assert.ok(store.getConversation(group.id).members.includes(quickMember.bot.id))
    await groupDetails.getByRole("button", { name: "关闭详情面板", exact: true }).click()
    await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
    await groupDetails.getByRole("tab", { name: "成员", exact: true }).click()
    await groupDetails.getByRole("button", { name: "核对群聊修改", exact: true }).click()
    await groupDetails
      .getByRole("button", { name: "核对群聊修改", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(store.getConversation(group.id).revision, memberRevision)
    api.updateGroup = originalMemberSave
    const removeMember = async (name: string) => {
      await groupDetails.getByRole("button", { name: `打开 ${name} 的聊天`, exact: true }).hover()
      await groupDetails.getByRole("button", { name: `移除 ${name}`, exact: true }).click()
      await page.getByRole("button", { name: "移出群聊", exact: true }).click()
      await groupDetails
        .getByRole("button", { name: `打开 ${name} 的聊天`, exact: true })
        .waitFor({ state: "hidden" })
    }
    await removeMember("成员交接验证 Bot")
    await removeMember("质量验证 Bot")
    assert.equal(store.getConversation(group.id).members.length, 1)
    await page.screenshot({ animations: "disabled", path: join(output, "group-single-member.png") })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await groupDetails.getByRole("button", { name: "添加成员", exact: true }).click()
    await memberSearch.fill("质量验证")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-add-member-light.png")
    })
    await memberPicker.getByRole("button", { name: "添加 质量验证 Bot", exact: true }).click()
    await groupDetails
      .getByRole("button", { name: "打开 质量验证 Bot 的聊天", exact: true })
      .waitFor()
    assert.deepEqual(store.getConversation(group.id).members, group.members)
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    const memberReturnRuns = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
    const memberReturnInputs = browserInputCalls
    const memberReturnGroupMessages = store.messages(group.id).length
    const memberReturnDirectMessages = store.messages(colleague.conversationId).length
    await groupDetails
      .getByRole("button", { name: "打开 质量验证 Bot 的聊天", exact: true })
      .click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "私聊未发送草稿")
    // An already open Inspector follows the new owner, restoring that Bot's
    // saved tab. It must not retain the group or silently close on navigation.
    const returnedMemberInspector = page.getByRole("complementary", {
      name: "质量验证 Bot 的电脑",
      exact: true
    })
    await returnedMemberInspector.waitFor()
    await groupDetails.waitFor({ state: "detached" })
    assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
    assert.equal(await returnedMemberInspector.locator(".bot-computer-content").count(), 1)
    assert.equal(
      await returnedMemberInspector
        .getByRole("tab", { name: "电脑", exact: true })
        .getAttribute("aria-selected"),
      "true"
    )
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { fixtureHistory(): { selected: string } }).fixtureHistory()
            .selected
      ),
      colleague.conversationId
    )
    assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), memberReturnRuns)
    assert.equal(
      browserInputCalls,
      memberReturnInputs,
      "Member navigation cannot send remote input"
    )
    assert.equal(store.messages(group.id).length, memberReturnGroupMessages)
    assert.equal(store.messages(colleague.conversationId).length, memberReturnDirectMessages)
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    // A selected mention is a stable recipient, not a display-name substring.
    const mentionInput = page.getByLabel("向 Bot 交办工作")
    await mentionInput.fill("@质量")
    await page.getByRole("listbox", { name: "引用对象", exact: true }).waitFor()
    const beforeMention = store.messages(group.id).length
    await page.screenshot({ animations: "disabled", path: join(output, "bot-mention-picker.png") })
    await mentionInput.press("Enter")
    assert.equal(store.messages(group.id).length, beforeMention, "Selecting a Bot must not send")
    const recipientButton = page.locator(".bot-recipient-chip").filter({ hasText: "质量验证 Bot" })
    assert.equal(await recipientButton.getAttribute("aria-pressed"), "true")
    const referenceRoutine = store.saveRoutine({
      botId: colleague.bot.id,
      name: "引用核验例程",
      prompt: "PRIVATE_REFERENCE_ROUTINE",
      enabled: false,
      timezone: "Asia/Shanghai",
      schedule: { kind: "event", topic: "reference-only" }
    })
    for (const [category, name] of [
      ["群聊", "研发评审组"],
      ["例程", "引用核验例程"],
      ["连接器", "项目知识库"]
    ]) {
      await mentionInput.pressSequentially(`@${name}`)
      await page
        .getByRole("group", { name: "引用类型", exact: true })
        .getByRole("button", { name: category, exact: true })
        .click()
      await page
        .getByRole("listbox", { name: "引用对象", exact: true })
        .getByRole("option")
        .filter({ hasText: name })
        .click()
    }
    assert.equal(
      await page
        .getByLabel("向 Bot 交办工作", { exact: true })
        .locator('[data-kind="group"], [data-kind="routine"], [data-kind="connector"]')
        .count(),
      3
    )
    assert.equal(store.messages(group.id).length, beforeMention, "References must not send work")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "entity-reference-draft.png")
    })
    await mentionInput.pressSequentially("指定成员检查")
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "质量验证 Bot", exact: true })
      .first()
      .click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    assert.match(await mentionInput.innerText(), /指定成员检查$/)
    assert.equal(await recipientButton.getAttribute("aria-pressed"), "true")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page
      .locator("[data-inline-message]")
      .getByRole("button", { name: "@质量验证 Bot", exact: true })
      .waitFor()
    const directed = store
      .messages(group.id)
      .find((message) => message.sender === "user" && message.text.endsWith("指定成员检查"))!
    assert.deepEqual(directed.recipientReferences, [
      { botId: colleague.bot.id, name: "质量验证 Bot" }
    ])
    assert.deepEqual(
      directed.entityReferences?.map(({ kind, id }) => ({ kind, id })),
      [
        { kind: "group", id: group.id },
        { kind: "routine", id: referenceRoutine.id },
        { kind: "connector", id: "project-notes" }
      ]
    )
    assert.equal(
      store.routineHistory({ botId: colleague.bot.id, routineId: referenceRoutine.id }).items
        .length,
      0
    )
    assert.deepEqual(store.getBot(colleague.bot.id).connectorIds, colleague.bot.connectorIds)
    const referencedRow = page.locator(`[data-message-id="${directed.id}"]`)
    assert.equal(directed.inlineReferences?.length, 4)
    assert.deepEqual(
      directed.inlineReferences?.map((span) => directed.text.slice(span.from, span.to)),
      ["@质量验证 Bot", "@研发评审组", "@引用核验例程", "@项目知识库"]
    )
    assert.equal(await referencedRow.locator(".bot-message-inline-reference").count(), 4)
    assert.equal(await referencedRow.getByLabel("本条消息的接收者", { exact: true }).count(), 0)
    assert.equal(await referencedRow.locator("[data-inline-message]").textContent(), directed.text)
    // The single-line baseline assertion needs the original full-width chat.
    // The Inspector now follows member navigation, so close it explicitly;
    // normal wrapping in the narrower chat is not a baseline misalignment.
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click()
    await page.locator(".bot-inspector-panel").waitFor({ state: "hidden" })
    const inlineBoxes = await referencedRow
      .locator(".bot-message-inline-reference")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top))
    assert.ok(
      Math.max(...inlineBoxes) - Math.min(...inlineBoxes) < 2,
      "Inline references must share the text baseline"
    )
    await page.screenshot({ animations: "disabled", path: join(output, "inline-message-dark.png") })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "inline-message-light.png")
    })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    await referencedRow.getByRole("button", { name: "@质量验证 Bot", exact: true }).click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "研发评审组", exact: true })
      .click()
    await page.getByRole("heading", { name: "研发评审组", level: 2 }).waitFor()
    await referencedRow.hover()
    await referencedRow.getByRole("button", { name: "回复此消息", exact: true }).click()
    const referenceReply = page.getByRole("region", { name: "回复消息", exact: true })
    await referenceReply.getByText(/@引用核验例程/).waitFor()
    await page.getByRole("button", { name: "取消回复", exact: true }).click()
    await openWorkspaceContentSearch(page)
    const referenceSearch = page.getByRole("dialog", { name: "搜索 Bot 工作区" })
    await referenceSearch.getByRole("textbox", { name: "搜索内容" }).fill("引用核验例程")
    await referenceSearch.getByRole("button").filter({ hasText: "指定成员检查" }).waitFor()
    await referenceSearch.getByRole("textbox", { name: "搜索内容" }).press("Escape")
    await page.screenshot({ animations: "disabled", path: join(output, "bot-mention-history.png") })
    const replacement = await api.create({ nonce: "group-replacement", name: "发布检查 Bot" })
    await page.getByRole("button", { name: "群聊设置", exact: true }).click()
    await dialog.getByLabel("群聊名称", { exact: true }).fill("发布评审组")
    await dialog.getByLabel("群聊描述", { exact: true }).fill("检查发布前的准备情况")
    await dialog
      .locator("label")
      .filter({ hasText: "研发协作助手" })
      .getByRole("checkbox")
      .uncheck()
    await dialog.locator("label").filter({ hasText: "发布检查 Bot" }).getByRole("checkbox").check()
    await page.screenshot({ animations: "disabled", path: join(output, "group-settings.png") })
    await page.setViewportSize({ width: 620, height: 540 })
    const groupEditorBounds = await dialog.boundingBox()
    const groupSaveBounds = await dialog
      .getByRole("button", { name: "保存群聊", exact: true })
      .boundingBox()
    assert.ok(
      groupEditorBounds &&
        groupEditorBounds.y >= 0 &&
        groupEditorBounds.y + groupEditorBounds.height <= 540
    )
    assert.ok(
      groupSaveBounds && groupSaveBounds.y >= 0 && groupSaveBounds.y + groupSaveBounds.height <= 540
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-settings-narrow.png")
    })
    await page.setViewportSize({ width: 1440, height: 960 })
    const actualUpdateGroup = api.updateGroup
    let loseGroupUpdate = true
    api.updateGroup = async (input) => {
      const result = await actualUpdateGroup(input)
      if (loseGroupUpdate) {
        loseGroupUpdate = false
        throw new Error("Fixture lost group update response")
      }
      return result
    }
    await dialog.getByRole("button", { name: "保存群聊", exact: true }).click()
    await dialog.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    const savedGroupRevision = store.getConversation(group.id).revision
    assert.equal(await dialog.getByLabel("群聊描述", { exact: true }).isDisabled(), true)
    await dialog.getByRole("button", { name: "稍后核对", exact: true }).click()
    await page.getByRole("heading", { name: "发布评审组", level: 2 }).waitFor()
    await page.getByRole("button", { name: "群聊设置", exact: true }).click()
    await dialog.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(store.getConversation(group.id).revision, savedGroupRevision)
    api.updateGroup = actualUpdateGroup
    assert.deepEqual(
      new Set(store.getConversation(group.id).members),
      new Set([colleague.bot.id, replacement.bot.id])
    )
    assert.equal(store.getConversation(group.id).description, "检查发布前的准备情况")
    await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
    const updatedGroupDetails = page.getByRole("complementary", {
      name: "发布评审组 的详情",
      exact: true
    })
    await updatedGroupDetails.getByRole("tab", { name: "成员", exact: true }).click()
    await updatedGroupDetails
      .getByRole("button", { name: "打开 发布检查 Bot 的聊天", exact: true })
      .waitFor()
    assert.equal(
      await updatedGroupDetails
        .getByRole("button", { name: "打开 研发协作助手 的聊天", exact: true })
        .count(),
      0
    )
    await updatedGroupDetails.getByRole("button", { name: "关闭详情面板", exact: true }).click()
    await page.getByRole("button", { name: "群聊设置", exact: true }).click()
    await dialog.getByLabel("群聊描述", { exact: true }).fill("保留我的编辑草稿")
    await api.updateGroup({
      ...store.getConversation(group.id),
      description: "另一处更新的协作目标"
    })
    await dialog
      .getByText("群聊已更新，当前草稿已保留。载入最新版本后再修改。", { exact: true })
      .waitFor()
    assert.equal(
      await dialog.getByLabel("群聊描述", { exact: true }).inputValue(),
      "保留我的编辑草稿"
    )
    assert.equal(
      await dialog.getByRole("button", { name: "保存群聊", exact: true }).isDisabled(),
      true
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "group-settings-conflict.png")
    })
    await dialog.getByRole("button", { name: "载入最新版本，替换草稿", exact: true }).click()
    assert.equal(
      await dialog.getByLabel("群聊描述", { exact: true }).inputValue(),
      "另一处更新的协作目标"
    )
    await dialog.getByRole("button", { name: "取消", exact: true }).click()

    // Exercise real paged history after a long session, with no extra model calls.
    await host.stop()
    const historical = store.createBot({ nonce: "history-bot", name: "历史记录验证" })
    for (let index = 0; index < 220; index++) {
      const sent = store.send({
        nonce: `history-${index}`,
        conversationId: historical.conversationId,
        text: `历史工作 ${index + 1}`
      })
      store.cancel(sent.runIds[0])
    }
    await page.getByRole("button", { name: "历史记录验证", exact: true }).click()
    await waitResidentHistory(page, 100)
    await page.locator(".bot-transcript").getByText("历史工作 220", { exact: true }).waitFor()
    assert.ok((await page.locator("[data-message-id]").count()) < 60)
    await page.locator(".bot-transcript").hover()
    await page.mouse.wheel(0, -100_000)
    await page.waitForFunction(() => document.querySelector(".bot-transcript")!.scrollTop <= 1)
    await page.locator(".bot-transcript").getByText("历史工作 121", { exact: true }).waitFor()
    const oldest = page.locator("[data-message-id]").first()
    const oldestId = await oldest.getAttribute("data-message-id")
    const oldTop = (await oldest.boundingBox())!.y
    await page.getByRole("button", { name: "加载更早消息", exact: true }).click()
    await waitResidentHistory(page, 200)
    await page.waitForFunction(
      ({ id, top }) => {
        const node = document.querySelector(`[data-message-id="${id}"]`)
        return node && Math.abs(node.getBoundingClientRect().top - top) < 2
      },
      { id: oldestId, top: oldTop }
    )
    await page.waitForTimeout(250)
    const restoredTop = (await page.locator(`[data-message-id="${oldestId}"]`).boundingBox())!.y
    assert.ok(
      Math.abs(restoredTop - oldTop) < 2,
      `History anchor moved by ${restoredTop - oldTop}px`
    )
    await page.locator(".bot-transcript").hover()
    await page.mouse.wheel(0, -100_000)
    await page.waitForFunction(() => document.querySelector(".bot-transcript")!.scrollTop <= 1)
    await page.locator(".bot-transcript").getByText("历史工作 21", { exact: true }).waitFor()
    const secondOldest = page.locator("[data-message-id]").first()
    const secondOldestId = await secondOldest.getAttribute("data-message-id")
    const secondOldTop = (await secondOldest.boundingBox())!.y
    await page.getByRole("button", { name: "加载更早消息", exact: true }).click()
    await waitResidentHistory(page, 220)
    await page.waitForFunction(
      ({ id, top }) => {
        const node = document.querySelector(`[data-message-id="${id}"]`)
        return node && Math.abs(node.getBoundingClientRect().top - top) < 2
      },
      { id: secondOldestId, top: secondOldTop }
    )
    await page.waitForTimeout(250)
    assert.ok(
      Math.abs(
        (await page.locator(`[data-message-id="${secondOldestId}"]`).boundingBox())!.y -
          secondOldTop
      ) < 2,
      "Later virtual measurements must preserve the same reading position"
    )
    await page
      .getByRole("button", { name: "加载更早消息", exact: true })
      .waitFor({ state: "detached" })
    const mountedHistoryIds = await page
      .locator("[data-message-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id")))
    assert.equal(new Set(mountedHistoryIds).size, mountedHistoryIds.length)
    assert.ok(mountedHistoryIds.length < 60)
    const firstHistoricalId = await page.locator(".bot-transcript").evaluate((node) => {
      const top = node.getBoundingClientRect().top
      return [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top
      )!.dataset.messageId!
    })
    const firstHistoricalMessage = page.locator(`[data-message-id="${firstHistoricalId}"]`)
    const oldNode = await firstHistoricalMessage.elementHandle()
    const remotelyUpdated = await api.react({
      conversationId: historical.conversationId,
      messageId: firstHistoricalId,
      emoji: "🎉",
      active: true,
      revision: 0
    })
    await firstHistoricalMessage
      .getByRole("button", { name: "移除 🎉 回应", exact: true })
      .waitFor()
    assert.equal(await oldNode!.evaluate((node) => node.isConnected), true)
    await api.react({
      conversationId: historical.conversationId,
      messageId: firstHistoricalId,
      emoji: "🎉",
      active: false,
      revision: remotelyUpdated.revision
    })
    await firstHistoricalMessage
      .getByRole("button", { name: "移除 🎉 回应", exact: true })
      .waitFor({ state: "detached" })
    await oldNode!.dispose()
    // Returning to another Bot restores its detached reading position, without
    // keeping either conversation's full transcript mounted or dropping drafts.
    await page.getByLabel("向 Bot 交办工作").fill("阅读历史时保留的草稿")
    await page.locator(".bot-transcript").hover()
    const previousReadingTop = await page
      .locator(".bot-transcript")
      .evaluate((node) => node.scrollTop)
    await page.mouse.wheel(0, 347)
    await page.waitForFunction(
      (previous) => document.querySelector(".bot-transcript")!.scrollTop >= previous + 340,
      previousReadingTop
    )
    const rememberedHistory = await page.locator(".bot-transcript").evaluate((container) => {
      const top = container.getBoundingClientRect().top
      const row = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (item) => item.getBoundingClientRect().bottom > top
      )!
      return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top }
    })
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "质量验证 Bot", exact: true })
      .first()
      .click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    await page.getByRole("button", { name: "历史记录验证", exact: true }).click()
    await page.waitForFunction(({ id, offset }) => {
      const container = document.querySelector(".bot-transcript")
      const row = container?.querySelector(`[data-message-id="${id}"]`)
      return (
        container &&
        row &&
        Math.abs(row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset) <
          2
      )
    }, rememberedHistory)
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "阅读历史时保留的草稿")
    assert.ok((await page.locator("[data-message-id]").count()) < 60)
    await page.screenshot({ animations: "disabled", path: join(output, "bot-history-return.png") })
    // A failed saved-position read must not turn into a successful latest-page
    // refresh, erase the error or strand the virtualizer on a missing target.
    await page
      .locator(".bot-sidebar")
      .getByRole("button", { name: "质量验证 Bot", exact: true })
      .first()
      .click()
    await page.getByRole("heading", { name: "质量验证 Bot", level: 2 }).waitFor()
    deniedHistoryMessageId = rememberedHistory.id
    await page.getByRole("button", { name: "历史记录验证", exact: true }).click()
    const historyReadError = page.getByRole("alert", { name: "消息读取失败", exact: true })
    await historyReadError
      .getByText("该消息暂无访问权限，请重新确认后重试。", { exact: true })
      .waitFor()
    await page.waitForTimeout(1700)
    assert.equal(await historyReadError.isVisible(), true)
    assert.equal(await page.getByText("连接中断", { exact: true }).count(), 0)
    await waitResidentHistory(page, 0)
    assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "阅读历史时保留的草稿")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "bot-history-read-error.png")
    })
    deniedHistoryMessageId = undefined
    await historyReadError.getByRole("button", { name: "重试读取消息", exact: true }).click()
    await historyReadError.waitFor({ state: "hidden" })
    await page.waitForFunction(({ id, offset }) => {
      const container = document.querySelector(".bot-transcript")
      const row = container?.querySelector(`[data-message-id="${id}"]`)
      return (
        container &&
        row &&
        Math.abs(row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset) <
          2
      )
    }, rememberedHistory)
    await clearPrompt(page.getByLabel("向 Bot 交办工作"))
    // Open at a persisted unread boundary older than the latest page, then
    // consume forward without jumping over the middle of the conversation.
    const inbox = store.createBot({ nonce: "unread-fixture", name: "未读与复制验证" })
    for (let index = 0; index < 130; index++) {
      store.send({
        nonce: `unread-${index}`,
        conversationId: inbox.conversationId,
        text: `事项 ${index}`
      })
      store.finish(store.claim("unread-fixture")!.lease, "succeeded", `处理结果 ${index}`)
      if (index === 0) {
        const initial = store.getConversation(inbox.conversationId).readState!
        store.setReadState({
          conversationId: inbox.conversationId,
          revision: initial.revision,
          throughSequence: initial.latestSequence,
          unread: false
        })
      }
    }
    const firstUnread = store.getConversation(inbox.conversationId).readState!.firstUnreadSequence
    await page.getByRole("button", { name: "未读与复制验证", exact: true }).click()
    await page.getByRole("separator", { name: "未读消息起点" }).waitFor()
    assert.equal(
      Number(
        await page.locator("[data-message-sequence]").first().getAttribute("data-message-sequence")
      ),
      firstUnread
    )
    const marker = (await page.getByRole("separator", { name: "未读消息起点" }).boundingBox())!
    const transcript = (await page.locator(".bot-transcript").boundingBox())!
    assert.ok(marker.y >= transcript.y && marker.y < transcript.y + 100)
    await page.screenshot({ animations: "disabled", path: join(output, "unread-boundary.png") })
    await page.getByRole("button", { name: "加载后续消息", exact: true }).click()
    await waitResidentHistory(page, 200)
    await page.getByRole("button", { name: "加载后续消息", exact: true }).click()
    await waitResidentHistory(page, 257)
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "标为已读", exact: true }).click()
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "标为未读", exact: true }).click()
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "标为已读", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    await page.waitForTimeout(1700) // The next background refresh must preserve the manual reminder.
    assert.equal(store.getConversation(inbox.conversationId).readState?.manuallyUnread, true)
    await page.getByRole("button", { name: "历史记录验证", exact: true }).click()
    await page.getByRole("button", { name: "未读与复制验证", exact: true }).click()
    await page.getByRole("separator", { name: "未读消息起点" }).waitFor()
    store.saveSkill({
      botId: inbox.bot.id,
      name: "Review",
      instructions: "Read and review",
      enabled: true
    })
    store.saveRoutine({
      botId: inbox.bot.id,
      name: "Daily",
      prompt: "Review",
      schedule: { kind: "interval", anchor: Date.now() + 3600000, everyMs: 3600000 },
      timezone: "UTC",
      enabled: true
    })
    await page.getByRole("button", { name: "更多 Bot 操作" }).click()
    await page.getByRole("menuitem", { name: "复制 Bot", exact: true }).click()
    await page
      .getByRole("heading", { name: "未读与复制验证 copy", exact: true, level: 2 })
      .waitFor()
    const copied = store.snapshot().bots.find((bot) => bot.name === "未读与复制验证 copy")!
    assert.notEqual(copied.id, inbox.bot.id)
    assert.equal(store.skills(copied.id).length, 1)
    assert.equal(store.routines(copied.id)[0].enabled, true)
    const copiedConversation = store
      .snapshot()
      .conversations.find((item) => item.kind === "direct" && item.members.includes(copied.id))!
    assert.equal(store.messages(copiedConversation.id).length, 0)
    await page.screenshot({ animations: "disabled", path: join(output, "copied-bot.png") })
    await openSidebarFilter(page)
    await page.getByLabel("搜索 Bot", { exact: true }).fill("未读与复制验证")
    await page.getByLabel("向 Bot 交办工作", { exact: true }).fill("快捷键切换后保留的草稿")
    await page.keyboard.press("Control+1")
    await page.getByRole("heading", { name: "未读与复制验证", exact: true, level: 2 }).waitFor()
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains("bot-composer-input")
    )
    await page.keyboard.press("Alt+ArrowUp")
    assert.equal(
      await page.getByRole("heading", { name: "未读与复制验证", exact: true, level: 2 }).count(),
      1
    )
    await page.keyboard.press("Alt+ArrowDown")
    await page
      .getByRole("heading", { name: "未读与复制验证 copy", exact: true, level: 2 })
      .waitFor()
    await page.waitForFunction(() =>
      document.activeElement?.classList.contains("bot-composer-input")
    )
    assert.equal(
      await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
      "快捷键切换后保留的草稿"
    )
    await page.keyboard.press("Control+[")
    await page.getByRole("heading", { name: "未读与复制验证", exact: true, level: 2 }).waitFor()
    await page.keyboard.press("Control+]")
    await page
      .getByRole("heading", { name: "未读与复制验证 copy", exact: true, level: 2 })
      .waitFor()
    assert.equal(
      await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
      "快捷键切换后保留的草稿"
    )
    await clearPrompt(page.getByLabel("向 Bot 交办工作", { exact: true }))
    await page.getByLabel("搜索 Bot", { exact: true }).fill("")
    const skillBot = await api.create({ nonce: "skill-picker", name: "技能入口验证" })
    const chosenSkill = await api.saveSkill({
      botId: skillBot.bot.id,
      name: "接口评审",
      instructions: "SELECTED_INSTRUCTIONS_NOT_IN_DRAFT",
      enabled: true
    })
    await api.saveSkill({
      botId: skillBot.bot.id,
      name: "发布检查",
      instructions: "Check release",
      enabled: true
    })
    const disabledSkill = await api.saveSkill({
      botId: skillBot.bot.id,
      name: "停用流程",
      instructions: "Disabled",
      enabled: false
    })
    await page
      .getByRole("button", { name: /技能入口验证/ })
      .first()
      .click()
    const skillPrompt = page.getByLabel("向 Bot 交办工作")
    await skillPrompt.fill("/评审")
    assert.equal(await page.getByRole("listbox", { name: "选择技能" }).count(), 0)
    assert.equal(await skillPrompt.innerText(), "/评审")
    await clearPrompt(skillPrompt)
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    const skillSearch = page.getByRole("textbox", { name: "搜索技能", exact: true })
    await skillSearch.fill("评审")
    await page.getByRole("listbox", { name: "选择技能" }).waitFor()
    await page.getByRole("option", { name: /接口评审/ }).waitFor()
    assert.equal(await page.getByRole("option", { name: /停用流程/ }).count(), 0)
    await page.screenshot({ animations: "disabled", path: join(output, "skill-picker.png") })
    await skillSearch.press("Enter")
    await page.getByRole("button", { name: "移除技能 接口评审", exact: true }).waitFor()
    assert.equal(store.messages(skillBot.conversationId).length, 0)
    const savedDraft = await page.evaluate(
      (id) => localStorage.getItem(`bot-draft:${id}`),
      skillBot.conversationId
    )
    assert.equal(JSON.parse(savedDraft!).skills[0].id, chosenSkill.id)
    assert.ok(!savedDraft!.includes("SELECTED_INSTRUCTIONS_NOT_IN_DRAFT"))
    await page.waitForFunction(
      (id) => document.activeElement?.id === `bot-composer-${id}`,
      skillBot.conversationId
    )
    await skillPrompt.pressSequentially("请评审支付接口")
    loseNextMessageReceipt = true
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByRole("button", { name: "重试发送", exact: true }).waitFor()
    await skillPrompt.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End")
    await skillPrompt.pressSequentially("，下一个接口也按相同技能评审")
    await page.getByRole("button", { name: "重试发送", exact: true }).click()
    await page.getByRole("button", { name: "发送", exact: true }).waitFor()
    assert.match(await skillPrompt.innerText(), /下一个接口也按相同技能评审$/)
    await page.getByRole("button", { name: "移除技能 接口评审", exact: true }).waitFor()
    assert.equal(
      store.messages(skillBot.conversationId).filter((message) => message.sender === "user").length,
      1
    )
    await page.screenshot({ animations: "disabled", path: join(output, "send-retry-draft.png") })
    await page.getByRole("button", { name: "移除技能 接口评审", exact: true }).click()
    await clearPrompt(skillPrompt)
    await page
      .locator(".bot-message[data-sender=user]")
      .filter({ hasText: "请评审支付接口" })
      .waitFor()
    assert.deepEqual(store.messages(skillBot.conversationId)[0].skillReferences, [
      { botId: skillBot.bot.id, id: chosenSkill.id, version: 1, name: "接口评审" }
    ])
    assert.equal(
      await page.getByRole("button", { name: "移除技能 接口评审", exact: true }).count(),
      0
    )
    await skillPrompt.fill("/")
    assert.equal(await page.getByRole("listbox", { name: "选择技能" }).count(), 0)
    await page.getByRole("button", { name: "输入操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "选择技能", exact: true }).click()
    await page.getByRole("option", { name: /发布检查/ }).waitFor()
    await skillSearch.press("Escape")
    assert.equal(await page.getByRole("listbox", { name: "选择技能" }).count(), 0)
    assert.equal(await skillPrompt.innerText(), "/")
    await clearPrompt(skillPrompt)

    const pluginNoticeRun = store.claim("plugin-notice-ui")!
    assert.equal(pluginNoticeRun.run.botId, skillBot.bot.id)
    store.pluginTurn(pluginNoticeRun.lease, { reason: "answer", text: "本轮完成 · 0.3 秒" })
    store.finish(pluginNoticeRun.lease, "succeeded", "接口评审已完成，详细结论见评审记录。")
    await page.getByLabel("插件任务提示").filter({ hasText: "本轮完成" }).waitFor()
    assert.equal(
      store.messages(skillBot.conversationId).at(-1)?.pluginNotice?.text,
      "本轮完成 · 0.3 秒"
    )
    await page.screenshot({ animations: "disabled", path: join(output, "plugin-turn-notice.png") })

    const selectedSkillRow = page.locator(
      `[data-message-id="${store.messages(skillBot.conversationId)[0].id}"]`
    )
    await selectedSkillRow.getByRole("button", { name: "/接口评审", exact: true }).click()
    const skillResource = page.getByRole("dialog", { name: "技能入口验证 · 技能", exact: true })
    await skillResource.getByText("SELECTED_INSTRUCTIONS_NOT_IN_DRAFT", { exact: true }).waitFor()
    await page.waitForFunction(
      (id) => document.activeElement?.id === `bot-skill-${id}`,
      chosenSkill.id
    )
    await skillResource
      .getByRole("status", { name: "消息引用的技能", exact: true })
      .getByText(/消息引用 v1/)
      .waitFor()
    await page.keyboard.press("Escape")
    await skillResource.waitFor({ state: "hidden" })
    await api.saveSkill({ ...chosenSkill, instructions: "修订后的接口评审步骤" })
    await selectedSkillRow.getByRole("button", { name: "/接口评审", exact: true }).click()
    await skillResource.getByText("修订后的接口评审步骤", { exact: true }).waitFor()
    await skillResource
      .getByText("当前版本为 v2，与消息引用的版本不同。", { exact: true })
      .waitFor()
    const resourceBounds = (await skillResource.boundingBox())!
    const resourceTitle = (await skillResource
      .getByRole("heading", { name: "技能入口验证 · 技能", exact: true })
      .boundingBox())!
    const resourceClose = (await skillResource
      .getByRole("button", { name: "Close", exact: true })
      .boundingBox())!
    assert.ok(resourceTitle.y >= resourceBounds.y && resourceTitle.y < resourceBounds.y + 100)
    assert.ok(resourceClose.y >= resourceBounds.y && resourceClose.y < resourceBounds.y + 100)
    assert.equal(store.messages(skillBot.conversationId)[0].skillReferences?.[0].version, 1)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "message-skill-reference-version.png")
    })
    await page.keyboard.press("Escape")
    await skillResource.waitFor({ state: "hidden" })

    await selectedSkillRow.getByRole("button", { name: "/接口评审", exact: true }).click()
    await skillResource
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "停用流程", exact: true }) })
      .getByText("管理技能", { exact: true })
      .click()
    await skillResource.getByRole("button", { name: "删除技能 停用流程", exact: true }).click()
    const deleteSkillDialog = page.getByRole("dialog", {
      name: "删除技能「停用流程」？",
      exact: true
    })
    loseNextSkillDeletionReceipt = true
    await deleteSkillDialog.getByRole("button", { name: "确认删除", exact: true }).click()
    await skillResource.getByLabel("待核对的技能删除", { exact: true }).waitFor()
    assert.equal(
      store.skills(skillBot.bot.id).some((skill) => skill.id === disabledSkill.id),
      false
    )
    assert.equal(skillDeletionRequests.length, 1)
    await page.keyboard.press("Escape")
    await skillResource.waitFor({ state: "hidden" })
    await selectedSkillRow.getByRole("button", { name: "/接口评审", exact: true }).click()
    await skillResource
      .getByLabel("待核对的技能删除", { exact: true })
      .getByRole("button", { name: "核对技能 停用流程 的删除请求", exact: true })
      .click()
    await deleteSkillDialog.getByRole("button", { name: "重试核对", exact: true }).click()
    await skillResource.getByLabel("待核对的技能删除", { exact: true }).waitFor({ state: "hidden" })
    assert.equal(skillDeletionRequests.length, 2)
    assert.deepEqual(skillDeletionRequests[0], skillDeletionRequests[1])
    assert.equal(
      store.db.exec("SELECT count(*) FROM bot_skills WHERE id=?", [disabledSkill.id])[0]
        ?.values[0][0],
      1
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "private-skill-delete-lost-receipt-recovered.png")
    })
    await page.keyboard.press("Escape")
    await skillResource.waitFor({ state: "hidden" })

    // Quote a real message, retain the draft across conversations and resolve an old target.
    const quotedId = store.messages(skillBot.conversationId)[0].id
    const quotedRow = page.locator(`[data-message-id="${quotedId}"]`)
    await quotedRow.hover()
    await quotedRow.getByRole("button", { name: "回复此消息", exact: true }).click()
    await page.getByRole("region", { name: "回复消息", exact: true }).waitFor()
    assert.equal(await skillPrompt.getAttribute("placeholder"), "回复…")
    await skillPrompt.fill("请只评审第二项")
    const otherReplyBot = store.createBot({ nonce: "reply-navigation", name: "引用定位验证" })
    await page.getByRole("button", { name: "引用定位验证", exact: true }).click()
    await page.getByRole("button", { name: "技能入口验证", exact: true }).click()
    assert.equal(await skillPrompt.innerText(), "请只评审第二项")
    await page.getByRole("region", { name: "回复消息", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "reply-composer.png") })
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const sentReply = page
      .locator(".bot-message[data-sender=user]")
      .filter({ hasText: "请只评审第二项" })
    await sentReply.getByRole("button", { name: "定位回复的消息", exact: true }).waitFor()
    assert.equal(store.messages(skillBot.conversationId).at(-1)?.replyTo, quotedId)
    assert.equal(await page.getByRole("region", { name: "回复消息", exact: true }).count(), 0)
    await sentReply.hover()
    await sentReply.getByRole("button", { name: "回复此消息", exact: true }).click()
    await skillPrompt.fill("取消引用仍保留文字")
    await page.getByRole("button", { name: "取消回复", exact: true }).click()
    assert.equal(await skillPrompt.innerText(), "取消引用仍保留文字")
    await clearPrompt(skillPrompt)
    for (let i = 0; i < 220; i++)
      store.send({
        nonce: `reply-filler-${i}`,
        conversationId: skillBot.conversationId,
        text: `引用定位背景消息 ${i}`
      })
    const farReply = store.send({
      nonce: "far-reply",
      conversationId: skillBot.conversationId,
      text: "定位最初评审消息",
      replyTo: quotedId
    })
    await page.getByRole("button", { name: otherReplyBot.bot.name, exact: true }).click()
    await page.getByRole("button", { name: "技能入口验证", exact: true }).click()
    await page.getByRole("button", { name: /^查看全部 \d+ 个任务$/ }).click()
    const conversationTasks = page.getByRole("dialog", { name: "当前会话任务", exact: true })
    const taskRows = conversationTasks
      .getByRole("list", { name: "当前会话任务列表", exact: true })
      .locator("li")
    assert.equal(await taskRows.count(), 20)
    const firstTaskPage = await taskRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-conversation-task-id"))
    )
    await conversationTasks.getByRole("button", { name: "下一页", exact: true }).click()
    assert.equal(await taskRows.count(), 20)
    const secondTaskPage = await taskRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-conversation-task-id"))
    )
    assert.equal(
      secondTaskPage.some((id) => firstTaskPage.includes(id)),
      false
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "conversation-task-queue.png")
    })
    await page.keyboard.press("Escape")
    await conversationTasks.waitFor({ state: "hidden" })
    assert.ok((await page.locator("[data-inline-task-id]").count()) <= 4)
    const farRow = page.locator(`[data-message-id="${farReply.messageId}"]`)
    await farRow.getByRole("button", { name: "定位回复的消息", exact: true }).waitFor()
    assert.equal(await quotedRow.count(), 0)

    // A's delayed failure cannot clear B's in-progress target or report an old
    // error. Exercise the actual component, Store and bridge error envelope.
    const firstOtherMessage = store.send({
      nonce: "other-jump-origin",
      conversationId: otherReplyBot.conversationId,
      text: "新视图的定位目标"
    })
    for (let index = 0; index < 130; index++)
      store.send({
        nonce: `other-jump-history-${index}`,
        conversationId: otherReplyBot.conversationId,
        text: `另一个会话的消息 ${index}`
      })
    const otherFarReply = store.send({
      nonce: "other-jump-reply",
      conversationId: otherReplyBot.conversationId,
      text: "定位新的目标",
      replyTo: firstOtherMessage.messageId
    })
    const oldRead = holdMessage(quotedId)
    const newRead = holdMessage(firstOtherMessage.messageId)
    await farRow.getByRole("button", { name: "定位回复的消息", exact: true }).click()
    await page.waitForFunction(() => !!document.querySelector('[aria-label="正在定位消息"]'))
    await waitMessageRequest(oldRead)
    await page.getByRole("button", { name: otherReplyBot.bot.name, exact: true }).click()
    const otherFarRow = page.locator(`[data-message-id="${otherFarReply.messageId}"]`)
    await otherFarRow.getByRole("button", { name: "定位回复的消息", exact: true }).click()
    const locating = page.getByRole("status", { name: "正在定位消息", exact: true })
    await locating.waitFor()
    await waitMessageRequest(newRead)
    oldRead.finish({ botFailure: { code: "forbidden", message: "过期的 A 定位失败" } })
    await page.waitForTimeout(100)
    assert.equal(await locating.getAttribute("data-message-target"), firstOtherMessage.messageId)
    assert.equal(await page.getByText("过期的 A 定位失败", { exact: true }).count(), 0)
    newRead.finish(
      await api.message({
        conversationId: otherReplyBot.conversationId,
        id: firstOtherMessage.messageId
      })
    )
    const otherTarget = page.locator(`[data-message-id="${firstOtherMessage.messageId}"]`)
    await otherTarget.waitFor()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-message-id="${id}"] [data-reply-highlight]`) !== null,
      firstOtherMessage.messageId
    )
    await locating.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "技能入口验证", exact: true }).click()
    await farRow.getByRole("button", { name: "定位回复的消息", exact: true }).waitFor()
    await farRow.getByRole("button", { name: "定位回复的消息", exact: true }).click()
    await quotedRow.waitFor()
    assert.equal(
      await quotedRow.locator(".bot-message-bubble").getAttribute("data-reply-highlight"),
      "true"
    )
    await page.getByRole("button", { name: "加载后续消息", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "reply-jump.png") })

    // Programmatic message navigation after keyboard input keeps one visible
    // focus treatment on the bubble, including after the transient highlight ends.
    await page.keyboard.press("Tab")
    await quotedRow.focus()
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-message-id="${id}"] [data-reply-highlight]`),
      quotedId
    )
    for (const theme of ["codex-light", "codex-dark"]) {
      await page.evaluate(
        (theme) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(theme),
        theme
      )
      const focus = await quotedRow.evaluate((node) => ({
        active: document.activeElement === node,
        visible: node.matches(":focus-visible"),
        rowOutline: getComputedStyle(node).outlineStyle,
        bubbleShadow: getComputedStyle(node.querySelector(".bot-message-bubble")!).boxShadow
      }))
      assert.equal(focus.active, true)
      assert.equal(focus.visible, true)
      assert.equal(focus.rowOutline, "none")
      assert.notEqual(focus.bubbleShadow, "none")
      await page.screenshot({
        animations: "disabled",
        path: join(output, `reply-focus-${theme}.png`)
      })
    }
    await page.emulateMedia({ forcedColors: "active" })
    assert.equal(
      await quotedRow
        .locator(".bot-message-bubble")
        .evaluate((node) => getComputedStyle(node).outlineStyle),
      "solid"
    )
    await page.emulateMedia({ forcedColors: "none" })

    // A branch is a separate discussion, with its own draft, reads and paged navigation.
    for (const run of store.snapshot().runs) store.cancel(run.id)
    await skillPrompt.fill("主对话草稿保留")
    await quotedRow.hover()
    const rootTop = (await quotedRow.boundingBox())!.y
    await quotedRow.getByRole("button", { name: "开始分支讨论", exact: true }).click()
    const branchHeader = page.getByRole("region", { name: "分支讨论", exact: true })
    await branchHeader.waitFor()
    assert.equal(await skillPrompt.textContent(), "")
    await skillPrompt.fill("分支评审限定内容")
    await page.getByRole("button", { name: "返回主对话", exact: true }).click()

    assert.equal(await skillPrompt.innerText(), "主对话草稿保留")
    assert.ok(
      Math.abs((await quotedRow.boundingBox())!.y - rootTop) < 4,
      "Returning from a branch restores the main transcript position"
    )
    await quotedRow.hover()
    await quotedRow.getByRole("button", { name: "开始分支讨论", exact: true }).click()
    await branchHeader.waitFor()
    assert.equal(await skillPrompt.innerText(), "分支评审限定内容")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.locator(".bot-message").filter({ hasText: "分支评审限定内容" }).waitFor()
    const branchRun = store.claim("branch-ui")!
    assert.equal(branchRun.run.threadRootId, quotedId)
    store.finish(branchRun.lease, "succeeded", "分支定位独立验收结果")
    await page.locator(".bot-message").filter({ hasText: "分支定位独立验收结果" }).waitFor()
    await branchHeader.getByText("2 条回复", { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "message-branch.png") })
    await page.waitForFunction(
      async ({ conversationId, rootId }) => {
        const branch = await window.api.bots.thread({ conversationId, rootId })
        return branch.readState.unreadCount === 0
      },
      { conversationId: skillBot.conversationId, rootId: quotedId }
    )
    await page.getByRole("button", { name: "返回主对话", exact: true }).click()
    assert.equal(await skillPrompt.innerText(), "主对话草稿保留")
    const branchSummaryBefore = await inspectBranchSummaryBoundary(
      page,
      skillBot.conversationId,
      quotedId
    ).catch(() => ({ diagnosticUnavailable: true }))
    try {
      await quotedRow.getByRole("button", { name: "查看分支 2 条回复", exact: true }).waitFor()
    } catch (error) {
      const branchSummaryAfter = await inspectBranchSummaryBoundary(
        page,
        skillBot.conversationId,
        quotedId
      ).catch(() => ({ diagnosticUnavailable: true }))
      const diagnostic = { before: branchSummaryBefore, after: branchSummaryAfter }
      console.error("Bot main branch-summary wait failed:", JSON.stringify(diagnostic))
      await writeFile(
        join(output, "failure-branch-summary.json"),
        JSON.stringify(diagnostic, null, 2)
      ).catch(() => console.error("Bot branch-summary diagnostic file could not be saved"))
      throw error
    }
    assert.equal(
      await page.locator(".bot-message").filter({ hasText: "分支定位独立验收结果" }).count(),
      0
    )
    await clearPrompt(skillPrompt)
    await page.getByRole("button", { name: otherReplyBot.bot.name, exact: true }).click()
    await openWorkspaceContentSearch(page)
    const branchSearch = page.getByRole("dialog", { name: "搜索 Bot 工作区" })
    await branchSearch.getByRole("textbox", { name: "搜索内容" }).fill("分支定位独立验收结果")
    await branchSearch.getByRole("button").filter({ hasText: "分支定位独立验收结果" }).click()
    await branchSearch.waitFor({ state: "hidden" })
    await branchHeader.waitFor()
    const branchResult = page.locator(".bot-message").filter({ hasText: "分支定位独立验收结果" })
    assert.equal(
      await branchResult.locator(".bot-message-bubble").getAttribute("data-reply-highlight"),
      "true"
    )
    await page.getByRole("button", { name: "返回主对话", exact: true }).click()

    // The actual navigation hook resolves the message's branch; URI content never sends work.
    const unreadBranch = store.threads.get({
      conversationId: skillBot.conversationId,
      rootId: quotedId
    })
    store.setReadState({
      conversationId: skillBot.conversationId,
      threadRootId: quotedId,
      revision: unreadBranch.readState.revision,
      throughSequence: unreadBranch.readState.latestSequence,
      unread: true
    })
    await page.getByRole("button", { name: otherReplyBot.bot.name, exact: true }).click()
    await page.getByRole("button", { name: "技能入口验证", exact: true }).click()
    await page.getByRole("button", { name: "查看未读分支", exact: true }).click()
    await branchHeader.waitFor()
    await page.locator(".bot-message").filter({ hasText: "分支定位独立验收结果" }).waitFor()
    await page.getByRole("button", { name: "返回主对话", exact: true }).click()
    const linkedBranch = store
      .messages(skillBot.conversationId, undefined, 100, undefined, quotedId)
      .at(-1)!
    const branchLink = botMessageLink({
      conversationId: skillBot.conversationId,
      messageId: linkedBranch.id
    })
    await page.evaluate((href) => {
      const anchor = document.createElement("a")
      anchor.href = href
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }, branchLink)
    await branchHeader.waitFor()
    const linkedRow = page.locator(`[data-message-id="${linkedBranch.id}"]`)
    await linkedRow.waitFor()
    await linkedRow.hover()
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:39173" })
    await linkedRow.getByRole("button", { name: "复制消息链接", exact: true }).click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), branchLink)
    await page.getByRole("button", { name: "返回主对话", exact: true }).click()

    await api.upload({
      nonce: "search-file",
      conversationId: otherReplyBot.conversationId,
      name: "搜索验收说明.md",
      mime: "text/markdown",
      base64: Buffer.from("# 搜索文件预览\n\n真实文件内容。").toString("base64")
    })
    const searchableRoutine = store.saveRoutine({
      botId: otherReplyBot.bot.id,
      name: "搜索定位日检",
      prompt: "搜索测试用例程",
      enabled: false,
      timezone: "UTC",
      schedule: { kind: "cron", expression: "0 9 * * *" }
    })
    const linked = store.send({
      nonce: "search-link",
      conversationId: otherReplyBot.conversationId,
      text: "参考 https://example.invalid/only-search-target 的说明"
    })
    await page.getByRole("button", { name: otherReplyBot.bot.name, exact: true }).click()
    await openWorkspaceContentSearch(page)
    const searchDialog = page.getByRole("dialog", { name: "搜索 Bot 工作区" })
    await searchDialog.getByRole("textbox", { name: "搜索内容" }).fill("请评审支付接口")
    await searchDialog.getByRole("button").filter({ hasText: "请评审支付接口" }).waitFor()
    await searchDialog.getByRole("checkbox", { name: /仅搜索/ }).check()
    await searchDialog.getByText("没有找到匹配内容", { exact: true }).waitFor()
    await searchDialog.getByRole("checkbox", { name: /仅搜索/ }).uncheck()
    const searchResult = searchDialog.getByRole("button").filter({ hasText: "请评审支付接口" })
    await searchResult.waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "content-search.png") })
    await searchResult.click()
    await searchDialog.waitFor({ state: "hidden" })
    await quotedRow.waitFor()
    assert.equal(
      await quotedRow.locator(".bot-message-bubble").getAttribute("data-reply-highlight"),
      "true"
    )

    await openWorkspaceContentSearch(page)
    await searchDialog.getByRole("button", { name: "文件", exact: true }).click()
    await searchDialog.getByRole("textbox", { name: "搜索内容" }).fill("搜索验收说明")
    await searchDialog.getByRole("button").filter({ hasText: "搜索验收说明.md" }).click()
    await page.getByRole("dialog").getByText("搜索文件预览", { exact: true }).waitFor()
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()

    await openWorkspaceContentSearch(page)
    await searchDialog.getByRole("button", { name: "例程", exact: true }).click()
    await searchDialog.getByRole("textbox", { name: "搜索内容" }).fill("搜索定位日检")
    await searchDialog.getByRole("button").filter({ hasText: "搜索定位日检" }).click()
    const routineRow = page.locator(`#bot-routine-${searchableRoutine.id}`)
    await routineRow.waitFor()
    assert.equal(await routineRow.evaluate((node) => document.activeElement === node), true)
    for (const run of store.snapshot().runs) store.cancel(run.id)
    for (let index = 0; index < 22; index++) {
      store.runRoutine({ id: searchableRoutine.id, nonce: `routine-history-ui-${index}` })
      const claimed = store.claim("history-ui")!
      store.finish(claimed.lease, index % 4 ? "succeeded" : "failed", `日检历史结果 ${index}`)
    }
    store.runRoutine({ id: searchableRoutine.id, nonce: "history-live" })
    const liveHistory = store.claim("history-ui")!
    await routineRow
      .getByRole("button", { name: `例程 ${searchableRoutine.name} 的更多操作`, exact: true })
      .click()
    await page
      .getByRole("menu", { name: `例程 ${searchableRoutine.name} 的操作`, exact: true })
      .getByRole("menuitem", { name: "运行记录", exact: true })
      .click()
    const historyDialog = page.getByRole("dialog", {
      name: `${searchableRoutine.name} · 运行记录`,
      exact: true
    })
    const liveHistoryRow = historyDialog.locator(`[data-run-id="${liveHistory.run.id}"]`)
    await liveHistoryRow.getByText("运行中", { exact: true }).waitFor()
    const usageId = startBotModelUsage(store, {
      botId: liveHistory.run.botId,
      runId: liveHistory.run.id,
      model: { id: "history-fixture", model: "Review model", baseUrl: "http://unused.invalid" },
      purpose: "task",
      reserved: 100
    })
    settleBotModelUsage(store, usageId, {
      doneEvents: 1,
      errorEvents: 0,
      uninspectedEvents: 0,
      inputTokens: 122,
      outputTokens: 13
    } as ModelResponseDiagnostic)
    store.finish(liveHistory.lease, "failed", "流水线检查失败：缺少测试报告")
    await liveHistoryRow.getByText("失败", { exact: true }).waitFor()
    await liveHistoryRow.getByText("流水线检查失败：缺少测试报告", { exact: true }).waitFor()
    assert.equal(await historyDialog.locator("li[data-run-id]").count(), 20)
    await historyDialog.getByRole("button", { name: "下一页", exact: true }).click()
    await historyDialog.getByText("第 2 页", { exact: true }).waitFor()
    await historyDialog.locator("li[data-run-id]").first().waitFor()
    assert.equal(await historyDialog.locator("li[data-run-id]").count(), 3)
    await historyDialog.getByRole("button", { name: "上一页", exact: true }).click()
    await liveHistoryRow.waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "routine-history.png") })
    const historyMessage = store
      .routineHistory({ botId: otherReplyBot.bot.id, routineId: searchableRoutine.id })
      .items.find((run) => run.id === liveHistory.run.id)!.resultMessageId!
    await liveHistoryRow.getByRole("button", { name: "查看对话", exact: true }).click()
    await historyDialog.waitFor({ state: "hidden" })
    await page
      .locator(
        `[data-message-id="${historyMessage}"] .bot-message-bubble[data-reply-highlight="true"]`
      )
      .waitFor()
    await page
      .locator(`[data-message-id="${historyMessage}"]`)
      .getByRole("button", { name: "查看任务记录", exact: true })
      .click()
    const taskHistory = page.getByRole("dialog", { name: "任务记录", exact: true })
    await taskHistory.getByText("任务：失败", { exact: true }).waitFor()
    await taskHistory.locator("summary").filter({ hasText: "模型用量" }).click()
    await taskHistory.getByText(/已报告输入 122、输出 13 tokens/).waitFor()
    await taskHistory.getByText("Review model", { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "task-model-usage.png") })
    await taskHistory.getByRole("button", { name: "Close", exact: true }).click()
    for (const run of store.snapshot().runs) store.cancel(run.id)
    store.send({
      nonce: "recovery-details",
      conversationId: otherReplyBot.conversationId,
      text: "核对项目命令执行结果"
    })
    const interrupted = store.claim("history-ui")!
    for (let i = 0; i < 65; i++) store.activity(interrupted.lease, `准备检查步骤 ${i}`, "file")
    const recoveryAction = {
      shell: {
        command: "node verify-release.cjs",
        cwd: "C:/projects/payments",
        timeoutSeconds: 30,
        sandbox: "windows-restricted-token"
      }
    }
    const rejectedApproval = store.requestInteraction(interrupted.lease, {
      kind: "approval",
      action: recoveryAction,
      prompt: JSON.stringify(recoveryAction)
    })
    store.answerInteraction({
      id: rejectedApproval.id,
      revision: rejectedApproval.revision,
      answer: "reject"
    })
    const historicalQuestion = store.requestInteraction(interrupted.lease, {
      kind: "question",
      prompt: JSON.stringify({
        botQuestions: {
          version: 1,
          input: {
            questions: [
              { id: "branch", header: "分支", question: "本次发布到哪个分支？", options: [] }
            ]
          }
        }
      })
    })
    store.answerInteraction({
      id: historicalQuestion.id,
      revision: historicalQuestion.revision,
      answer: JSON.stringify({
        status: "submitted",
        answers: { branch: { type: "other", questionId: "branch", text: "release/v2" } }
      })
    })
    const recoveryApproval = store.requestInteraction(interrupted.lease, {
      kind: "approval",
      action: recoveryAction,
      prompt: JSON.stringify(recoveryAction)
    })
    store.answerInteraction({
      id: recoveryApproval.id,
      revision: recoveryApproval.revision,
      answer: "approve"
    })
    store.beginEffect(interrupted.lease, {
      id: "ui-review-effect",
      action: recoveryAction,
      approvalId: recoveryApproval.id
    })
    store.settleEffect(
      interrupted.lease,
      "ui-review-effect",
      "unknown",
      "连接中断，需要确认命令是否完成。"
    )
    store.finish(interrupted.lease, "failed", "中断")
    await page.getByRole("button", { name: "核对并恢复", exact: true }).waitFor()
    await page.getByRole("button", { name: "任务记录", exact: true }).click()
    const rejectedRow = taskHistory
      .locator(`[data-interaction-id="${rejectedApproval.id}"]`)
      .first()
    failNextInteractionDetail = true
    await rejectedRow.getByRole("button").click()
    await rejectedRow.getByRole("alert").filter({ hasText: "FIXTURE_HISTORY_RETRY" }).waitFor()
    await rejectedRow.getByRole("button", { name: "重试", exact: true }).click()
    await rejectedRow.getByText("已拒绝", { exact: true }).waitFor()
    await rejectedRow.getByText("此请求未获批准，没有对应的操作回执。", { exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "request-history-rejected.png")
    })
    const questionRow = taskHistory
      .locator(`[data-interaction-id="${historicalQuestion.id}"]`)
      .first()
    await questionRow.getByRole("button").click()
    await questionRow.getByText("用户回复", { exact: true }).waitFor()
    await questionRow.locator("pre").filter({ hasText: "release/v2" }).waitFor()
    const approvedRow = taskHistory
      .locator(`[data-interaction-id="${recoveryApproval.id}"]`)
      .first()
    await approvedRow.getByRole("button").click()
    await approvedRow.getByText("已批准", { exact: true }).waitFor()
    await approvedRow.getByRole("button", { name: "查看对应操作结果", exact: true }).click()
    await approvedRow.getByText("结果待核对", { exact: true }).waitFor()
    assert.equal(store.getInteraction(rejectedApproval.id).revision, 2)
    assert.equal(store.getInteraction(recoveryApproval.id).revision, 2)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "request-history-approved.png")
    })
    await taskHistory.getByRole("button", { name: "操作：结果待核对", exact: true }).click()
    await taskHistory.getByText("node verify-release.cjs", { exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "task-run-history.png") })
    await taskHistory.getByRole("button", { name: "更早记录", exact: true }).click()
    await taskHistory.getByText("第 2 页", { exact: true }).waitFor()
    await taskHistory.getByRole("button", { name: "上一页", exact: true }).click()
    await taskHistory.getByText("任务：待核对", { exact: true }).waitFor()
    await taskHistory.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "核对并恢复", exact: true }).click()
    const recoveryDialog = page.getByRole("dialog", { name: "核对中断的任务", exact: true })
    await recoveryDialog.getByRole("button", { name: "查看操作与审批", exact: true }).click()
    await recoveryDialog.getByText("node verify-release.cjs", { exact: true }).waitFor()
    assert.equal(
      await recoveryDialog.getByRole("button", { name: "继续任务", exact: true }).isDisabled(),
      true
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "task-recovery-details.png")
    })
    await recoveryDialog.getByRole("combobox").click()
    await page.getByRole("option", { name: "已完成，禁止重复", exact: true }).click()
    await recoveryDialog
      .getByLabel("操作核对依据", { exact: true })
      .fill("已在项目目录确认报告生成，退出码为 0。")
    await recoveryDialog
      .getByLabel("任务核对说明", { exact: true })
      .fill("核对后结束本次任务，保留结果。")
    const beforeRecoveryCursor = store.snapshot().cursor
    loseRecoveryReceipt = "before"
    await recoveryDialog.getByRole("button", { name: "结束任务", exact: true }).click()
    await recoveryDialog.getByText("测试核对请求发送中断", { exact: true }).waitFor()
    assert.equal(store.getRun(interrupted.run.id).status, "needs_review")
    assert.equal(
      await recoveryDialog.getByLabel("任务核对说明", { exact: true }).isDisabled(),
      true
    )
    await recoveryDialog.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "核对并恢复", exact: true }).click()
    assert.equal(
      await recoveryDialog.getByLabel("任务核对说明", { exact: true }).inputValue(),
      "核对后结束本次任务，保留结果。"
    )
    assert.equal(
      await recoveryDialog.getByLabel("操作核对依据", { exact: true }).inputValue(),
      "已在项目目录确认报告生成，退出码为 0。"
    )
    loseRecoveryReceipt = "after"
    await recoveryDialog.getByRole("button", { name: "确认上次提交", exact: true }).click()
    await recoveryDialog.getByText("测试核对回执丢失", { exact: true }).waitFor()
    assert.equal(store.getRun(interrupted.run.id).status, "cancelled")
    const afterRecovery = store
      .events(beforeRecoveryCursor, 1000)
      .filter((event) => event.kind === "run.reviewed" && event.entityId === interrupted.run.id)
    assert.equal(afterRecovery.length, 1)
    const recoveryTheme = await page.evaluate(() => {
      const theme = document.documentElement.dataset.theme!
      ;(window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
      return theme
    })
    const recoveryLightBackground = await recoveryDialog.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "task-recovery-pending-light.png")
    })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    assert.notEqual(
      await recoveryDialog.evaluate((element) => getComputedStyle(element).backgroundColor),
      recoveryLightBackground
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "task-recovery-pending-dark.png")
    })
    await page.setViewportSize({ width: 580, height: 620 })
    assert.equal(
      await recoveryDialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true
    )
    await recoveryDialog
      .getByRole("button", { name: "确认上次提交", exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "task-recovery-pending-narrow.png")
    })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.evaluate(
      (theme) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(theme),
      recoveryTheme
    )
    await recoveryDialog.getByRole("button", { name: "确认上次提交", exact: true }).click()
    await recoveryDialog.waitFor({ state: "hidden" })
    assert.equal(recoveryRequests.length, 3)
    for (const request of recoveryRequests.slice(1))
      assert.deepEqual(JSON.parse(request), JSON.parse(recoveryRequests[0]))
    assert.deepEqual(
      store
        .events(beforeRecoveryCursor, 1000)
        .filter((event) => event.kind === "run.reviewed" && event.entityId === interrupted.run.id),
      afterRecovery
    )
    assert.equal(store.getRun(interrupted.run.id).status, "cancelled")
    assert.equal(store.effects(interrupted.run.id)[0].status, "succeeded")
    await page.getByRole("button", { name: "例程", exact: true }).click()
    await routineRow.waitFor()
    const routineListTheme = await page.evaluate(
      () => document.documentElement.getAttribute("data-theme") ?? "codex-light"
    )
    const routineListViewport = page.viewportSize()!
    for (const theme of ["codex-light", "codex-dark"]) {
      await page.evaluate(
        (value) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(value),
        theme
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, `routines-list-${theme}.png`)
      })
    }
    await page.setViewportSize({ width: 580, height: 620 })
    assert.equal(
      await page.getByRole("dialog").evaluate((node) => node.scrollWidth <= node.clientWidth),
      true
    )
    await routineRow
      .getByRole("button", { name: `例程 ${searchableRoutine.name} 的更多操作`, exact: true })
      .click()
    await page.getByRole("menuitem", { name: "对话调整", exact: true }).waitFor()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "routines-menu-narrow.png")
    })
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    await page.setViewportSize(routineListViewport)
    await page.evaluate(
      (value) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(value),
      routineListTheme
    )
    await page.getByRole("button", { name: "新建例程", exact: true }).click()
    const routineDraftName = page.getByRole("dialog").getByLabel("名称", { exact: true })
    await routineDraftName.fill("草稿名称不丢失")
    await page.setViewportSize({ width: 580, height: 620 })
    const newRoutineDialog = page.getByRole("dialog", { name: "新建例程", exact: true })
    const newRoutineBounds = (await newRoutineDialog.boundingBox())!
    const newRoutineSave = (await newRoutineDialog
      .getByRole("button", { name: "保存", exact: true })
      .boundingBox())!
    assert.ok(
      newRoutineSave.y + newRoutineSave.height <= newRoutineBounds.y + newRoutineBounds.height
    )
    assert.equal(
      await newRoutineDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
      true
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "routine-create-narrow.png")
    })
    await page.setViewportSize(routineListViewport)
    let changedRoutine = await api.saveRoutine({
      ...searchableRoutine,
      prompt: "例程由其他窗口修改"
    })
    await routineRow.getByText("例程由其他窗口修改", { exact: true }).waitFor({ state: "attached" })
    assert.equal(
      await routineDraftName.evaluate((node) => document.activeElement === node),
      true,
      "Polling must not steal focus back to the search target"
    )
    assert.equal(await routineDraftName.inputValue(), "草稿名称不丢失")
    await page.screenshot({ animations: "disabled", path: join(output, "routines-live.png") })
    await page.getByRole("button", { name: "返回例程列表", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "新建例程")
    await page.getByRole("button", { name: "新建例程", exact: true }).click()
    assert.equal(await routineDraftName.inputValue(), "草稿名称不丢失")
    await page.getByRole("button", { name: "返回例程列表", exact: true }).click()
    await routineRow.getByRole("button", { name: "编辑", exact: true }).click()
    const inlineRoutineEditor = page.getByRole("dialog", { name: "编辑例程", exact: true })
    await inlineRoutineEditor.getByLabel("内容", { exact: true }).fill("本地修改不能被轮询覆盖")
    changedRoutine = await api.saveRoutine({ ...changedRoutine, prompt: "远端更新的巡检要求" })
    await inlineRoutineEditor
      .getByText("例程已更新，当前草稿已保留。载入最新版本后再修改。", { exact: true })
      .waitFor()
    assert.equal(
      await inlineRoutineEditor.getByLabel("内容", { exact: true }).inputValue(),
      "本地修改不能被轮询覆盖"
    )
    assert.equal(
      await inlineRoutineEditor.getByRole("button", { name: "保存修改", exact: true }).isDisabled(),
      true
    )
    await inlineRoutineEditor
      .getByRole("button", { name: "载入最新版本，替换草稿", exact: true })
      .click()
    assert.equal(
      await inlineRoutineEditor.getByLabel("内容", { exact: true }).inputValue(),
      "远端更新的巡检要求"
    )
    await inlineRoutineEditor.getByLabel("内容", { exact: true }).fill("按新规则检查项目并交付报告")
    await inlineRoutineEditor.getByLabel("执行频率", { exact: true }).click()
    await page.getByRole("option", { name: "每周", exact: true }).click()
    await page.getByRole("listbox").waitFor({ state: "hidden" })
    await page.waitForFunction(
      (id) => document.activeElement?.id === id,
      await inlineRoutineEditor.getByLabel("执行频率", { exact: true }).getAttribute("id")
    )
    await inlineRoutineEditor.getByLabel("星期", { exact: true }).focus()
    await page.keyboard.press("Space")
    await page.getByRole("listbox").waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option")
    // Radix moves option focus in a timer. Wait for each key's result before the next key.
    await page.keyboard.press("Home")
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("role") === "option" &&
        document.activeElement.textContent?.trim() === "周日"
    )
    await page.keyboard.press("ArrowDown")
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("role") === "option" &&
        document.activeElement.textContent?.trim() === "周一"
    )
    await page.keyboard.press("Enter")
    assert.equal(await inlineRoutineEditor.getByLabel("星期", { exact: true }).innerText(), "周一")
    await inlineRoutineEditor.getByLabel("执行频率", { exact: true }).click()
    await page.getByRole("option", { name: "自定义日历计划", exact: true }).click()
    await inlineRoutineEditor.getByLabel("Cron 表达式", { exact: true }).fill("15 9,16 * * 1-5")
    await inlineRoutineEditor.getByLabel("时区", { exact: true }).fill("Asia/Shanghai")
    await page.screenshot({ animations: "disabled", path: join(output, "routine-edit-dark.png") })
    const routineViewport = page.viewportSize()!
    await page.setViewportSize({ width: 700, height: 600 })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const routineHeading = inlineRoutineEditor.getByRole("heading", {
      name: "编辑例程",
      exact: true
    })
    const routineSave = inlineRoutineEditor.getByRole("button", { name: "保存修改", exact: true })
    const headingBeforeScroll = (await routineHeading.boundingBox())!
    const saveBeforeScroll = (await routineSave.boundingBox())!
    assert.ok(headingBeforeScroll.y > 0 && saveBeforeScroll.y + saveBeforeScroll.height < 600)
    await inlineRoutineEditor.getByLabel("名称", { exact: true }).scrollIntoViewIfNeeded()
    assert.equal((await routineHeading.boundingBox())!.y, headingBeforeScroll.y)
    assert.equal((await routineSave.boundingBox())!.y, saveBeforeScroll.y)
    await inlineRoutineEditor.getByLabel("执行频率", { exact: true }).click()
    const frequencyMenu = page.getByRole("listbox")
    const frequencyBounds = (await frequencyMenu.boundingBox())!
    assert.ok(frequencyBounds.y >= 0 && frequencyBounds.y + frequencyBounds.height <= 600)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "routine-menu-narrow-dark.png")
    })
    await page.keyboard.press("Escape")
    await frequencyMenu.waitFor({ state: "hidden" })
    const frequencyTriggerId = await inlineRoutineEditor
      .getByLabel("执行频率", { exact: true })
      .getAttribute("id")
    assert.ok(frequencyTriggerId)
    await page.waitForFunction(
      (id) => document.getElementById(id) === document.activeElement,
      frequencyTriggerId
    )
    await inlineRoutineEditor.getByLabel("启用自动运行").scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "routine-edit-narrow-dark.png")
    })
    await page.setViewportSize(routineViewport)
    const actualSaveRoutine = api.saveRoutine
    let loseSaveResponse = true
    api.saveRoutine = async (input) => {
      const result = await actualSaveRoutine(input)
      if (loseSaveResponse) {
        loseSaveResponse = false
        throw new Error("Fixture lost routine save response")
      }
      return result
    }
    await inlineRoutineEditor.getByRole("button", { name: "保存修改", exact: true }).click()
    await inlineRoutineEditor.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    assert.equal(
      await inlineRoutineEditor.getByLabel("执行频率", { exact: true }).isDisabled(),
      true
    )
    assert.equal(await inlineRoutineEditor.getByLabel("启用自动运行").isDisabled(), true)
    const savedRevision = store.routine(otherReplyBot.bot.id, searchableRoutine.id).revision
    await inlineRoutineEditor.getByRole("button", { name: "取消", exact: true }).click()
    await routineRow.getByText("按新规则检查项目并交付报告", { exact: true }).waitFor()
    await routineRow.getByRole("button", { name: "编辑", exact: true }).click()
    await inlineRoutineEditor.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await inlineRoutineEditor.waitFor({ state: "hidden" })
    changedRoutine = store.routine(otherReplyBot.bot.id, searchableRoutine.id)
    assert.equal(changedRoutine.revision, savedRevision)
    assert.deepEqual(changedRoutine.schedule, { kind: "cron", expression: "15 9,16 * * 1-5" })
    // A creation acknowledgement lost across closing the resources panel must not duplicate it.
    await page.getByRole("button", { name: "新建例程", exact: true }).click()
    const creationForm = page.getByRole("form", { name: "添加例程", exact: true })
    await creationForm.getByLabel("名称", { exact: true }).fill("可恢复的间隔例程")
    await creationForm.getByLabel("内容", { exact: true }).fill("持续检查项目资料")
    await creationForm.getByLabel("执行频率", { exact: true }).click()
    await page.getByRole("option", { name: "固定间隔", exact: true }).click()
    await creationForm.getByLabel("执行间隔", { exact: true }).fill("2")
    loseSaveResponse = true
    await creationForm.getByRole("button", { name: "保存", exact: true }).click()
    await creationForm.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    const savedInterval = store
      .routines(otherReplyBot.bot.id)
      .find((item) => item.name === "可恢复的间隔例程")!
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "例程", exact: true }).click()
    await creationForm.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await creationForm.waitFor({ state: "hidden" })
    assert.equal(
      store.routines(otherReplyBot.bot.id).filter((item) => item.name === savedInterval.name)
        .length,
      1
    )
    const intervalRow = page.locator(`#bot-routine-${savedInterval.id}`)
    await intervalRow.getByRole("button", { name: "编辑", exact: true }).click()
    await inlineRoutineEditor.getByLabel("内容", { exact: true }).fill("增加验收说明")
    await inlineRoutineEditor.getByRole("button", { name: "保存修改", exact: true }).click()
    await inlineRoutineEditor.waitFor({ state: "hidden" })
    const editedInterval = store.routine(otherReplyBot.bot.id, savedInterval.id)
    assert.deepEqual(editedInterval.schedule, savedInterval.schedule)
    assert.equal(editedInterval.nextAt, savedInterval.nextAt)
    api.saveRoutine = actualSaveRoutine
    await routineRow
      .getByRole("button", { name: `例程 ${searchableRoutine.name} 的更多操作`, exact: true })
      .click()
    await page.getByRole("menuitem", { name: "对话调整", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    const routineEditInput = page.getByLabel("向 Bot 交办工作")
    assert.ok(
      (await routineEditInput.innerText()).includes(
        `ID: ${searchableRoutine.id}，版本 ${changedRoutine.revision}`
      )
    )
    await page.waitForFunction(
      (id) => document.activeElement?.id === `bot-composer-${id}`,
      otherReplyBot.conversationId
    )
    await page.getByRole("button", { name: "例程", exact: true }).click()
    await routineRow
      .getByRole("button", { name: "例程 搜索定位日检 的更多操作", exact: true })
      .click()
    await page
      .getByRole("menu", { name: "例程 搜索定位日检 的操作", exact: true })
      .getByRole("menuitem", { name: "删除例程", exact: true })
      .click()
    const deletionDialog = page.getByRole("dialog", {
      name: "删除例程「搜索定位日检」？",
      exact: true
    })
    changedRoutine = await api.saveRoutine({ ...changedRoutine, prompt: "删除确认期间发生修改" })
    await deletionDialog
      .getByText("例程已变化，请关闭此窗口后重新确认。", { exact: true })
      .waitFor()
    assert.equal(
      await deletionDialog.getByRole("button", { name: "确认删除", exact: true }).isDisabled(),
      true
    )
    await deletionDialog.getByRole("button", { name: "取消", exact: true }).click()
    const waitingRoutine = await api.runRoutine({
      id: changedRoutine.id,
      nonce: "delete-ui-queued"
    })
    const actualDeleteRoutine = api.deleteRoutine
    let loseDeleteResponse = true
    api.deleteRoutine = async (input) => {
      const result = await actualDeleteRoutine(input)
      if (loseDeleteResponse) {
        loseDeleteResponse = false
        throw new Error("Fixture lost deletion response")
      }
      return result
    }
    await routineRow
      .getByRole("button", { name: "例程 搜索定位日检 的更多操作", exact: true })
      .click()
    await page
      .getByRole("menu", { name: "例程 搜索定位日检 的操作", exact: true })
      .getByRole("menuitem", { name: "删除例程", exact: true })
      .click()
    await page.screenshot({ animations: "disabled", path: join(output, "routine-delete.png") })
    await deletionDialog.getByRole("button", { name: "确认删除", exact: true }).click()
    await deletionDialog.getByRole("button", { name: "重试核对", exact: true }).waitFor()
    assert.equal(store.getRun(waitingRoutine.id).status, "cancelled")
    await deletionDialog.getByRole("button", { name: "重试核对", exact: true }).click()
    await deletionDialog.waitFor({ state: "hidden" })
    api.deleteRoutine = actualDeleteRoutine
    assert.ok(
      !store.routines(otherReplyBot.bot.id).some((routine) => routine.id === searchableRoutine.id)
    )
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()

    await openWorkspaceContentSearch(page)
    await searchDialog.getByRole("button", { name: "链接", exact: true }).click()
    await searchDialog.getByRole("textbox", { name: "搜索内容" }).fill("only-search-target")
    await searchDialog.getByRole("button").filter({ hasText: "only-search-target" }).click()
    await searchDialog.waitFor({ state: "hidden" })
    await page.locator(`[data-message-id="${linked.messageId}"]`).waitFor()
    for (const run of store.snapshot().runs) store.cancel(run.id)
    // Shutdown is irreversible: resume this fixture with a new Host and API,
    // preserving the real Store and reopening owned services, never reviving
    // old leases or rebinding a provider's original supervision guards.
    const storage = host.storage
    await teach.close()
    await computer.close()
    computer = createComputer()
    teach = new BotTeachService(join(directory, "teach"), store, computer)
    secretRequests = new BotSecretRequests(store, computer)
    pluginRuntime = undefined
    pluginRuntimeLoading = undefined
    host = createHost()
    host.storage = storage
    host.bindPeerDispatchAdmission(
      createBotPeerDispatchAdmission(store, directory, ownedShellMaintenanceOwner(hostLock), () =>
        hostLock.assertCurrent()
      )
    )
    api = createBotAPI(host)
    host.start()
    const beforeProfileCount = store.listBots().length
    await page.getByLabel("向 Bot 交办工作").fill("创建协作助手测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("创建新的协作 Bot", { exact: true }).waitFor()
    await page.getByText("持续检查项目文档，整理变更并交付评审意见。", { exact: true }).waitFor()
    assert.equal(store.listBots().length, beforeProfileCount)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "bot-profile-approval.png")
    })
    await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page.getByRole("main").getByText("协作助手配置已处理。", { exact: true }).waitFor()
    assert.equal(store.listBots().length, beforeProfileCount + 1)
    await page.getByLabel("向 Bot 交办工作").fill("/plugin project-note 审核完成")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("运行插件命令 · project-note", { exact: true }).waitFor()
    assert.equal(
      store.snapshot().runs.find((run) => run.status === "waiting_input")?.source,
      "plugin-command"
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "plugin-command-approval.png")
    })
    await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page.getByRole("main").getByText("插件命令结果：审核完成", { exact: true }).waitFor()
    await page.getByLabel("向 Bot 交办工作").fill("审批规则验证")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByRole("button", { name: "始终允许", exact: true }).waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "approval-remember.png") })
    const ruleRequest = store.snapshot().interactions.find((i) => i.review?.canRemember)!
    const ruleBotId = store.getRun(ruleRequest.runId).botId
    await page.getByRole("button", { name: "始终允许", exact: true }).click()
    await page.getByRole("main").getByText("审批规则验证已结束", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(ruleBotId).rules.length, 1)
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "审批规则", exact: true }).click()
    let rulesDialog = page.getByRole("dialog", { name: "审批规则", exact: true })
    await rulesDialog
      .getByRole("group", { name: "命令处理方式" })
      .getByRole("button", { name: "始终允许", exact: true })
      .waitFor()
    await page.screenshot({ animations: "disabled", path: join(output, "approval-rules-dark.png") })
    loseNextRuleChange = true
    await rulesDialog.getByRole("button", { name: "每次询问", exact: true }).click()
    await rulesDialog.getByRole("button", { name: "确认上次操作", exact: true }).waitFor()
    const changedRevision = store.approvalRules.read(ruleBotId).revision
    await rulesDialog.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "审批规则", exact: true }).click()
    rulesDialog = page.getByRole("dialog", { name: "审批规则", exact: true })
    await rulesDialog.getByRole("button", { name: "确认上次操作", exact: true }).click()
    await rulesDialog
      .getByRole("button", { name: "确认上次操作", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(store.approvalRules.read(ruleBotId).revision, changedRevision)
    assert.equal(
      await rulesDialog
        .getByRole("group", { name: "命令处理方式" })
        .getByRole("button", { name: "每次询问", exact: true })
        .getAttribute("aria-pressed"),
      "true"
    )
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), "light")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "approval-rules-light.png")
    })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    await rulesDialog.getByRole("button", { name: "删除规则", exact: true }).click()
    await rulesDialog.getByText("还没有保存的审批规则", { exact: true }).waitFor()
    assert.equal(store.approvalRules.read(ruleBotId).rules.length, 0)
    await rulesDialog.getByRole("button", { name: "自动审核", exact: true }).click()
    await rulesDialog.getByRole("switch", { name: "启用自动审核" }).click()
    await rulesDialog.getByLabel("自动审核允许规则").fill("允许在当前项目修改测试并运行测试。")
    await rulesDialog.getByLabel("自动审核询问规则").fill("发布和推送代码前，必须先确认。")
    loseNextAutoReviewChange = true
    await rulesDialog.getByRole("button", { name: "保存审核设置", exact: true }).click()
    await rulesDialog.getByText("测试审核设置响应丢失", { exact: true }).waitFor()
    const reviewRevision = store.autoReview.read(ruleBotId).revision
    await rulesDialog.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "审批规则", exact: true }).click()
    rulesDialog = page.getByRole("dialog", { name: "审批规则", exact: true })
    await rulesDialog.getByRole("button", { name: "自动审核", exact: true }).click()
    await rulesDialog.getByRole("button", { name: "确认上次保存", exact: true }).click()
    await rulesDialog.getByText("已保存，后续操作按新设置审核。", { exact: true }).waitFor()
    assert.equal(store.autoReview.read(ruleBotId).revision, reviewRevision)
    assert.equal(store.autoReview.read(ruleBotId).isEnabled, true)
    await page.screenshot({ animations: "disabled", path: join(output, "auto-review-dark.png") })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await page.screenshot({ animations: "disabled", path: join(output, "auto-review-light.png") })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    await rulesDialog.getByRole("switch", { name: "启用自动审核" }).click()
    await rulesDialog.getByRole("button", { name: "保存审核设置", exact: true }).click()
    await rulesDialog.getByText("已保存，后续操作按新设置审核。", { exact: true }).waitFor()
    assert.equal(store.autoReview.read(ruleBotId).isEnabled, false)
    await rulesDialog.getByRole("button", { name: "Close", exact: true }).click()
    const beforeRoutineCount = store.routines(ruleBotId).length
    // Modern pending pages contain bounded descriptors only. The current full
    // card is loaded separately; approval stays unavailable if that read fails.
    blockPendingCardReads = true
    await page.getByLabel("向 Bot 交办工作").fill("例程审批验证")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const pendingCardFailure = page
      .getByRole("region", { name: "待处理事项", exact: true })
      .getByRole("alert")
      .filter({ hasText: "FIXTURE_PENDING_CARD_RETRY" })
    await pendingCardFailure.waitFor()
    assert.equal(await page.getByRole("button", { name: "批准本次操作", exact: true }).count(), 0)
    // Run revision updates can legitimately reload this card before the user
    // retries. Hold the transport fault until the explicit retry being tested.
    blockPendingCardReads = false
    await pendingCardFailure.getByRole("button", { name: "重试", exact: true }).click()
    await page.getByText("评审日检", { exact: true }).waitFor()
    await page.getByText("日历计划：0 9 * * 1-5", { exact: true }).waitFor()
    assert(
      (await page.getByRole("region", { name: "操作审批" }).textContent())?.includes("末尾检查事项")
    )
    assert.equal(store.routines(ruleBotId).length, beforeRoutineCount)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "routine-approval-dark.png")
    })
    await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page.getByRole("main").getByText("例程审核已处理。", { exact: true }).waitFor()
    assert.equal(store.routines(ruleBotId).length, beforeRoutineCount + 1)
    for (const answer of ["拒绝本次", "批准本次操作"]) {
      await page.getByLabel("向 Bot 交办工作").fill("协作派发审批验证")
      await page.getByRole("button", { name: "发送", exact: true }).click()
      const approvalCard = page.getByRole("region", { name: "操作审批" })
      await approvalCard.getByText("接收方职责与工作范围", { exact: true }).click()
      await approvalCard
        .getByText("持续检查项目文档，整理变更并交付评审意见。", { exact: true })
        .waitFor()
      const pending = store.snapshot().interactions.find((item) => item.status === "pending")!
      assert.equal(
        store.db.exec("SELECT id FROM bot_runs WHERE parent_run_id=?", [pending.runId])[0]?.values
          .length ?? 0,
        0
      )
      await page.evaluate(() =>
        (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, "peer-approval-light.png")
      })
      await page.getByRole("button", { name: answer, exact: true }).click()
      await page
        .getByRole("main")
        .getByText(answer === "拒绝本次" ? "本次协作派发已拒绝。" : "协作任务已派发。", {
          exact: true
        })
        .waitFor()
      assert.equal(
        store.db.exec("SELECT id FROM bot_runs WHERE parent_run_id=?", [pending.runId])[0]?.values
          .length ?? 0,
        answer === "拒绝本次" ? 0 : 1
      )
    }
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    store.autoReview.change({
      ...store.autoReview.read(ruleBotId),
      isEnabled: false,
      nonce: "ui-review-completed"
    })
    await page.getByLabel("向 Bot 交办工作").fill("浏览器目标审核验证")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const browserApproval = page.getByRole("region", { name: "操作审批" })
    await browserApproval.getByText("当前页面", { exact: true }).waitFor()
    await browserApproval.getByText("http://127.0.0.1:39174/review", { exact: true }).waitFor()
    await browserApproval.getByText("按要求填写申请人姓名", { exact: true }).waitFor()
    assert((await browserApproval.textContent())?.includes("实际目标：姓名"))
    await page.getByRole("button", { name: "批准本次操作", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      animations: "disabled",
      path: join(output, "browser-review-target.png")
    })
    await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page
      .getByRole("main")
      .getByText("网页姓名已填写，未提交表单。", { exact: true })
      .waitFor()
    await page.getByLabel("向 Bot 交办工作").fill("下载目标审核验证")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await browserApproval.getByText("下载文件到当前对话", { exact: true }).waitFor()
    await browserApproval.getByText("实际目标：导出项目报告", { exact: true }).waitFor()
    assert((await browserApproval.textContent())?.includes("export-report · POST"))
    await page.getByRole("button", { name: "批准本次操作", exact: true }).scrollIntoViewIfNeeded()
    for (const theme of ["codex-dark", "codex-light"]) {
      await page.evaluate(
        (theme) => (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(theme),
        theme
      )
      await page.screenshot({
        animations: "disabled",
        path: join(output, `download-review-${theme}.png`)
      })
    }
    await page.getByRole("button", { name: "批准本次操作", exact: true }).click()
    await page.getByRole("main").getByText("项目报告已下载到当前对话。", { exact: true }).waitFor()
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
    )
    await page.getByLabel("向 Bot 交办工作").fill("当前任务补充测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("正在处理可追加要求的任务…", { exact: true }).waitFor()
    await page.getByRole("button", { name: "作为新任务排队", exact: true }).waitFor()
    const steeringRun = store.snapshot().runs.find((run) => run.status === "running")!
    await page.getByLabel("向 Bot 交办工作").fill("补充：结论控制在两条")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    const addition = page.locator("article").filter({ hasText: "补充：结论控制在两条" })
    await addition.getByText("等待采纳", { exact: true }).waitFor()
    assert.equal(store.snapshot().runs.length, 1)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "current-task-instruction-pending.png")
    })
    releaseWork?.()
    releaseWork = undefined
    await page.getByRole("main").getByText("已按补充要求调整结果。", { exact: true }).waitFor()
    await addition.getByText("已采纳", { exact: true }).waitFor()
    assert.equal(store.getRun(steeringRun.id).status, "succeeded")
    await page.screenshot({
      animations: "disabled",
      path: join(output, "current-task-instruction-accepted.png")
    })
    await page.getByLabel("向 Bot 交办工作").fill("当前任务补充测试")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    await page.getByText("正在处理可追加要求的任务…", { exact: true }).waitFor()
    await page.getByRole("button", { name: "作为新任务排队", exact: true }).click()
    await page.getByLabel("向 Bot 交办工作").fill("另开一项任务")
    await page.getByRole("button", { name: "发送", exact: true }).click()
    for (let n = 0; n < 100 && !store.snapshot().runs.some((run) => run.status === "queued"); n++)
      await delay(50)
    assert.equal(store.snapshot().runs.filter((run) => run.status === "queued").length, 1)
    releaseWork?.()
    releaseWork = undefined
    await page.getByRole("main").getByText("原任务已完成。", { exact: true }).waitFor()
    for (let n = 0; n < 100 && store.snapshot().runs.length; n++) await delay(50)
    assert.equal(store.snapshot().runs.length, 0)
    const newProfile = store.listBots().find((bot) => bot.name === "文档评审助手")!
    store.updateBot({ id: newProfile.id, revision: newProfile.revision, pinned: true })
    const pinnedBeforeMove = store.pinnedOrder().ids
    const firstPinned = store.getBot(pinnedBeforeMove[0])
    const newProfileRow = page
      .getByRole("navigation", { name: "Bot 和群聊" })
      .getByRole("button", { name: newProfile.name, exact: true })
    await newProfileRow.waitFor()
    await page.waitForFunction(
      (id) =>
        document.querySelector(`button[aria-label="${id}"]`)?.getAttribute("draggable") === "true",
      newProfile.name
    )
    await newProfileRow.focus()
    await newProfileRow.press("Control+Shift+ArrowUp")
    await page.waitForFunction(
      async (id) => (await window.api.bots.snapshot()).pinnedOrder?.ids[0] === id,
      newProfile.id
    )
    await page.getByText("置顶顺序已保存", { exact: true }).waitFor()
    const firstPinnedRow = page
      .getByRole("navigation", { name: "Bot 和群聊" })
      .getByRole("button", { name: firstPinned.name, exact: true })
    await firstPinnedRow.dragTo(newProfileRow, { targetPosition: { x: 20, y: 3 } })
    await page.waitForFunction(
      async (ids) =>
        JSON.stringify((await window.api.bots.snapshot()).pinnedOrder?.ids) === JSON.stringify(ids),
      pinnedBeforeMove
    )
    await page.screenshot({ animations: "disabled", path: join(output, "pinned-order.png") })
    assert.equal(await firstPinnedRow.getAttribute("data-pinned"), "true")
    await page.getByRole("button", { name: "收起 Bot 列表", exact: true }).click()
    const compactPin = (await firstPinnedRow.boundingBox())!
    assert.ok(compactPin.width < 68 && compactPin.height < 70)
    await page.screenshot({ animations: "disabled", path: join(output, "pinned-compact.png") })
    await page.getByRole("button", { name: "展开 Bot 列表", exact: true }).click()
    await openSidebarFilter(page)
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill(firstPinned.name)
    assert.equal(await firstPinnedRow.getAttribute("data-pinned"), null)
    assert.equal(await firstPinnedRow.locator(".bot-list-row-copy > span").last().isVisible(), true)
    await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).fill("")
    await exercisePluginPanes()
    while (store.listBots().length < store.maxBots) {
      const index = store.listBots().length
      store.createBot({ nonce: `quota-${index}`, name: `数量验证 ${index}` })
    }
    await createNewBotFromChooser(page)
    await dialog
      .getByText(`当前最多可创建 ${store.maxBots} 个 Bot，请先删除不再需要的 Bot`, { exact: true })
      .waitFor()
    assert.equal(store.listBots().length, store.maxBots)
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    // A second client can delete the Bot while this window is reading a branch.
    // Its missing thread must not prevent the authoritative snapshot from applying.
    const remotelyDeleted = store.listBots().find((bot) => bot.name.startsWith("数量验证 "))!
    const deletedConversation = store.directConversation(remotelyDeleted.id).id
    const deletedRoot = store.send({
      nonce: "deleted-branch-ui",
      conversationId: deletedConversation,
      text: "删除分支同步验收"
    })
    for (const id of deletedRoot.runIds) store.cancel(id)
    await page.getByRole("button", { name: remotelyDeleted.name, exact: true }).click()
    const deletedRow = page.locator(`[data-message-id="${deletedRoot.messageId}"]`)
    await deletedRow.hover()
    await deletedRow.getByRole("button", { name: "开始分支讨论", exact: true }).click()
    await branchHeader.getByText("删除分支同步验收", { exact: true }).waitFor()
    store.deleteBot(remotelyDeleted.id, remotelyDeleted.revision)
    await branchHeader.waitFor({ state: "hidden" })
    await page
      .getByRole("button", { name: remotelyDeleted.name, exact: true })
      .waitFor({ state: "hidden" })
    // Trusted outcomes come only from the original tools, approval and SQLite transaction.
    // Client epoch/selected changes below exercise synchronous live click guards, not physical restore.
    const outcomeConversation = store.directConversation(ruleBotId).id
    const outcomeBot = store.getBot(ruleBotId)
    const outcomeReview = store.autoReview.read(ruleBotId)
    const outcomeCursor = store.snapshot().cursor
    const outcomeCount = store.routines(ruleBotId).length
    const outcomeApprovals: { id: string; runId: string; answer: string | undefined }[] = []
    await page
      .getByRole("navigation", { name: "Bot 和群聊" })
      .getByRole("button", { name: outcomeBot.name, exact: true })
      .click()
    const outcomePrompt = page.getByLabel("向 Bot 交办工作", { exact: true })
    const approveRoutineOutcome = async (text: string, finalReply: string) => {
      await clearPrompt(outcomePrompt)
      await outcomePrompt.fill(text)
      await page.getByRole("button", { name: "发送", exact: true }).click()
      const approval = page.getByRole("region", { name: "操作审批", exact: true })
      await approval.waitFor()
      const full = approval.getByRole("button", { name: "查看完整操作", exact: true })
      if (await full.isVisible()) await full.click()
      const pending = store
        .snapshot()
        .interactions.find(
          (item) =>
            item.kind === "approval" &&
            item.status === "pending" &&
            store.getRun(item.runId).botId === ruleBotId
        )!
      assert.ok(pending)
      await approval.getByRole("button", { name: "批准本次操作", exact: true }).click()
      await page.getByRole("main").getByText(finalReply, { exact: true }).waitFor()
      assert.equal(store.getInteraction(pending.id).answer, "approve")
      outcomeApprovals.push({
        id: pending.id,
        runId: pending.runId,
        answer: store.getInteraction(pending.id).answer
      })
    }
    const openOutcomeDetail = async (
      chip: Locator,
      saved: ReturnType<typeof store.routine>,
      weekly = false
    ) => {
      const before = routineClickCalls.length
      const routines = store.routines(ruleBotId)
      const runs = store.snapshot().runs
      assert.equal(await chip.isEnabled(), true)
      if (!weekly) {
        const viewport = page.viewportSize()!
        const theme = (await page.locator("html").getAttribute("data-theme")) ?? "codex-dark"
        try {
          assert.equal(theme, "codex-dark")
          await chip.scrollIntoViewIfNeeded()
          await page.screenshot({
            animations: "disabled",
            path: join(output, "routine-outcome-create-chat-codex-dark.png")
          })
        } finally {
          await page.setViewportSize(viewport)
          await page.evaluate(
            (mode) =>
              (window as unknown as { fixtureTheme(mode: string): void }).fixtureTheme(mode),
            theme
          )
        }
      }
      await chip.click()
      const card = page.locator(`#bot-routine-${saved.id}`)
      await card.waitFor()
      assert.equal(await page.locator(".bot-routine-card").count(), 1)
      assert.equal(await page.locator(".bot-routine-form").count(), 0)
      const detail = page.getByRole("region", { name: "例程详情", exact: true })
      assert.equal(
        await detail.getByRole("heading", { name: saved.name, exact: true }).innerText(),
        saved.name
      )
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.equal(await card.getByText(saved.prompt, { exact: true }).count(), 1)
      assert.equal(await card.getByText("Asia/Shanghai", { exact: true }).count(), 1)
      if (weekly) {
        assert.equal(await card.getByText("已暂停", { exact: true }).count(), 1)
        assert.equal(await card.locator("small").innerText(), "每星期日 12:00\nAsia/Shanghai")
      }
      await writeFile(
        join(output, `routine-outcome-${weekly ? "update" : "create"}-card.html`),
        await card.evaluate((node) => node.outerHTML)
      )
      if (weekly) {
        const viewport = page.viewportSize()!
        const theme = (await page.locator("html").getAttribute("data-theme")) ?? "codex-dark"
        try {
          for (const [index, width] of [1440, 1440, 390].entries()) {
            const mode = index === 0 ? "codex-dark" : "codex-light"
            await page.evaluate(
              (mode) =>
                (window as unknown as { fixtureTheme(mode: string): void }).fixtureTheme(mode),
              mode
            )
            await page.setViewportSize({ width, height: viewport.height })
            await page.waitForFunction((mode) => {
              const dialog = document.querySelector<HTMLElement>(
                '[data-testid="bot-routine-detail"][role=region]'
              )
              const workspace = document.querySelector<HTMLElement>(".bot-workspace")
              return (
                document.documentElement.dataset.theme === mode &&
                dialog &&
                workspace &&
                getComputedStyle(dialog).backgroundColor ===
                  getComputedStyle(workspace).backgroundColor &&
                getComputedStyle(dialog).opacity === "1"
              )
            }, mode)
            const palette = await card.evaluate((element) => {
              const dialog = element.closest<HTMLElement>(
                '[data-testid="bot-routine-detail"][role=region]'
              )!
              const workspace = document.querySelector<HTMLElement>(".bot-workspace")!
              return {
                theme: document.documentElement.dataset.theme,
                background: getComputedStyle(dialog).backgroundColor,
                workspaceBackground: getComputedStyle(workspace).backgroundColor,
                opacity: getComputedStyle(dialog).opacity
              }
            })
            assert.equal(palette.theme, mode)
            assert.equal(palette.background, palette.workspaceBackground)
            assert.equal(palette.opacity, "1")
            assert.equal(await card.locator("small").innerText(), "每星期日 12:00\nAsia/Shanghai")
            await writeFile(
              join(output, `routine-outcome-update-${mode}-${width}-palette.json`),
              JSON.stringify(palette, null, 2)
            )
            await page.screenshot({
              path: join(output, `routine-outcome-update-${mode}-${width}.png`)
            })
          }
        } finally {
          await page.setViewportSize(viewport)
          await page.evaluate(
            (mode) =>
              (window as unknown as { fixtureTheme(mode: string): void }).fixtureTheme(mode),
            theme
          )
        }
      }
      await page.keyboard.press("Escape")
      await detail.waitFor({ state: "hidden" })
      assert.ok(routineClickCalls.slice(before).every(({ method }) => method === "routines"))
      assert.deepEqual(store.routines(ruleBotId), routines)
      assert.deepEqual(store.snapshot().runs, runs)
      return routineClickCalls.slice(before)
    }
    try {
      await approveRoutineOutcome("例程创建消息验收", "创建消息验收完整答复。")
      const saved = store
        .routines(ruleBotId)
        .find((routine) => routine.name === "消息保存链路周检")!
      assert.ok(saved)
      assert.equal(store.routines(ruleBotId).length, outcomeCount + 1)
      assert.deepEqual(saved.schedule, { kind: "once", at: 4102444800000 })
      const createdOutcomes = store
        .messages(outcomeConversation, undefined, 200)
        .filter((message) => message.routineOutcome?.id === saved.id)
      assert.equal(createdOutcomes.length, 1)
      const createdOutcome = createdOutcomes[0]
      assert.deepEqual(createdOutcome.routineOutcome, {
        version: 1,
        operation: "create",
        id: saved.id,
        botId: ruleBotId,
        name: saved.name,
        revision: saved.revision,
        dataEpoch: store.dataEpoch()
      })
      assert.equal(createdOutcome.sender, "system")
      assert.ok(createdOutcome.runId)
      assert.ok(createdOutcome.replyTo)
      assert.deepEqual(store.routineHistory({ botId: ruleBotId, routineId: saved.id, limit: 10 }), {
        items: [],
        next: null
      })
      assert.equal(createdOutcome.threadRootId, undefined)
      assert.equal(createdOutcome.replyTo, store.getRun(createdOutcome.runId!).messageId)
      assert.equal(store.getRun(createdOutcome.runId!).status, "succeeded")
      const createdChip = page
        .locator(`[data-message-id="${createdOutcome.id}"]`)
        .getByRole("button", { name: `查看例程 ${saved.name}`, exact: true })
      assert.equal(
        await page
          .locator(`[data-message-id="${createdOutcome.id}"] [data-bot-routine-outcome-status]`)
          .getByText("已创建例行任务", { exact: true })
          .count(),
        1
      )
      const createReads = await openOutcomeDetail(createdChip, saved)
      const rootRow = page.locator(`[data-message-id="${createdOutcome.replyTo}"]`)
      await rootRow.hover()
      await rootRow.getByRole("button", { name: "开始分支讨论", exact: true }).click()
      await branchHeader.waitFor()
      await approveRoutineOutcome("例程更新消息验收", "更新消息验收完整答复。")
      const updated = store.routine(ruleBotId, saved.id)
      assert.equal(updated.id, saved.id)
      assert.equal(updated.revision, saved.revision + 1)
      assert.equal(updated.enabled, false)
      assert.deepEqual(updated.schedule, { kind: "cron", expression: "0 12 * * 0" })
      assert.equal(store.routines(ruleBotId).length, outcomeCount + 1)
      const updatedOutcomes = store
        .messages(outcomeConversation, undefined, 200, undefined, createdOutcome.replyTo)
        .filter((message) => message.routineOutcome?.id === saved.id)
      assert.equal(updatedOutcomes.length, 1)
      const updatedOutcome = updatedOutcomes[0]
      assert.deepEqual(updatedOutcome.routineOutcome, {
        version: 1,
        operation: "update",
        id: saved.id,
        botId: ruleBotId,
        name: saved.name,
        revision: updated.revision,
        dataEpoch: store.dataEpoch()
      })
      assert.equal(updatedOutcome.sender, "system")
      assert.ok(updatedOutcome.runId)
      assert.ok(updatedOutcome.replyTo)
      assert.equal(updatedOutcome.threadRootId, createdOutcome.replyTo)
      assert.equal(updatedOutcome.replyTo, store.getRun(updatedOutcome.runId!).messageId)
      assert.equal(store.getRun(updatedOutcome.runId!).status, "succeeded")
      const updatedChip = page
        .locator(`[data-message-id="${updatedOutcome.id}"]`)
        .getByRole("button", { name: `查看例程 ${saved.name}`, exact: true })
      assert.equal(
        await page
          .locator(`[data-message-id="${updatedOutcome.id}"] [data-bot-routine-outcome-status]`)
          .getByText("已更新例行任务", { exact: true })
          .count(),
        1
      )
      const updateReads = await openOutcomeDetail(updatedChip, updated, true)
      assert.deepEqual(
        outcomeApprovals.map(({ runId, answer }) => ({ runId, answer })),
        [
          { runId: createdOutcome.runId, answer: "approve" },
          { runId: updatedOutcome.runId, answer: "approve" }
        ]
      )
      assert.deepEqual(routineReplayRuns, [
        { runId: createdOutcome.runId, tool: "create_routine", callId: "ui-outcome-create" },
        { runId: updatedOutcome.runId, tool: "update_routine", callId: "ui-outcome-update" }
      ])
      const confirmationEvents = store
        .events(outcomeCursor, 200)
        .filter(
          (event) =>
            event.kind === "message.routine_saved" &&
            [createdOutcome.id, updatedOutcome.id].includes(event.entityId)
        )
      assert.equal(confirmationEvents.length, 2)
      await page.getByRole("button", { name: "返回主对话", exact: true }).click()
      await branchHeader.waitFor({ state: "hidden" })
      assert.equal(await updatedChip.count(), 0)
      await createdChip.waitFor()
      // Retire the visible Details summary before measuring rejected outcome clicks.
      const boundaryInspector = page.locator(".bot-inspector-panel")
      await boundaryInspector.getByRole("button", { name: "关闭详情面板", exact: true }).click()
      await boundaryInspector.waitFor({ state: "hidden" })
      const boundaryCalls = routineClickCalls.length
      const epoch = store.dataEpoch()
      const epochBoundary = await createdChip.evaluate((node, epoch) => {
        const fixture = (
          window as unknown as {
            fixtureWorkspace: {
              getState(): { selected: string; snapshot: { dataEpoch?: string } }
              setState(value: { snapshot: { dataEpoch?: string } }): void
            }
          }
        ).fixtureWorkspace
        const snapshot = fixture.getState().snapshot
        if (!node.isConnected || (node as HTMLButtonElement).disabled)
          throw new Error("The old-epoch chip must still be mounted and enabled")
        try {
          fixture.setState({ snapshot: { ...snapshot, dataEpoch: epoch } })
          node.click()
          return {
            selected: fixture.getState().selected,
            epoch: fixture.getState().snapshot.dataEpoch,
            connected: node.isConnected
          }
        } finally {
          fixture.setState({ snapshot })
        }
      }, `${epoch}:controlled-client-boundary`)
      assert.deepEqual(epochBoundary, {
        selected: outcomeConversation,
        epoch: `${epoch}:controlled-client-boundary`,
        connected: true
      })
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.equal(await page.getByRole("region", { name: "例程详情", exact: true }).count(), 0)
      assert.equal(store.dataEpoch(), epoch)
      assert.deepEqual(
        store.message({ conversationId: outcomeConversation, id: createdOutcome.id }),
        createdOutcome
      )
      await rootRow.getByRole("button", { name: /^查看分支 \d+ 条回复$/ }).click()
      await branchHeader.waitFor()
      await updatedChip.waitFor()
      const selectedBoundary = await updatedChip.evaluate((node, mainId) => {
        const fixture = (
          window as unknown as {
            fixtureWorkspace: { getState(): { selected: string; select(id: string): void } }
          }
        ).fixtureWorkspace
        const before = fixture.getState().selected
        fixture.getState().select(mainId)
        if (!node.isConnected || (node as HTMLButtonElement).disabled)
          throw new Error("The retired branch chip must still be mounted and enabled")
        node.click()
        return { before, selected: fixture.getState().selected, connected: node.isConnected }
      }, outcomeConversation)
      assert.notEqual(selectedBoundary.before, outcomeConversation)
      assert.deepEqual(
        { selected: selectedBoundary.selected, connected: selectedBoundary.connected },
        { selected: outcomeConversation, connected: true }
      )
      await branchHeader.waitFor({ state: "hidden" })
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.equal(await page.getByRole("region", { name: "例程详情", exact: true }).count(), 0)
      try {
        assert.equal(routineClickCalls.length, boundaryCalls)
      } catch (error) {
        try {
          await writeFile(
            join(output, "routine-boundary-read-diagnostics.json"),
            JSON.stringify(
              {
                boundaryCalls,
                totalCalls: routineClickCalls.length,
                callsSinceBoundary: routineClickCalls.slice(boundaryCalls),
                lastCalls: routineClickCalls.slice(-12),
                routineReads: routineReadDiagnostics
              },
              null,
              2
            )
          )
        } catch {
          // Diagnostics must preserve the original assertion failure.
        }
        throw error
      }
      assert.deepEqual(store.routine(ruleBotId, saved.id), updated)
      assert.deepEqual(store.routineHistory({ botId: ruleBotId, routineId: saved.id, limit: 10 }), {
        items: [],
        next: null
      })
      assert.deepEqual(
        store.message({ conversationId: outcomeConversation, id: updatedOutcome.id }),
        updatedOutcome
      )
      await writeFile(
        join(output, "routine-outcome-proof.json"),
        JSON.stringify(
          {
            createdOutcome,
            updatedOutcome,
            saved,
            updated,
            approvals: outcomeApprovals,
            replays: routineReplayRuns,
            confirmationEvents,
            createReads,
            updateReads,
            epochBoundary,
            selectedBoundary,
            physicalRestoreExercised: false
          },
          null,
          2
        )
      )
      // These interactions use the mounted Workspace's original routing and Resources owner.
      // Element handles retain real nodes; the lease is read from the actual computer broker.
      await clearPrompt(outcomePrompt)
      await outcomePrompt.fill("右侧例程验收：保留未发送的会话草稿")
      await page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
      const retainedPanel = page.locator(".bot-inspector-panel")
      const retainedComputer = page.locator(".bot-computer-content")
      await retainedComputer.waitFor()
      if (await retainedPanel.getByRole("button", { name: "接管操作", exact: true }).isVisible())
        await retainedPanel.getByRole("button", { name: "接管操作", exact: true }).click()
      await retainedPanel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      const panelNode = await retainedPanel.elementHandle()
      const computerNode = await retainedComputer.elementHandle()
      assert.ok(panelNode && computerNode)
      const originalLease = await api.computerOpen(ruleBotId)
      assert.equal(originalLease.controlOwner, "self")
      await retainedComputer
        .getByLabel("向浏览器输入文本", { exact: true })
        .fill("右侧例程验收：保留未发送的网页输入")
      const originalDraft = await page.evaluate(
        (id) =>
          (
            window as unknown as {
              fixtureDraftState(viewId: string): unknown
            }
          ).fixtureDraftState(id),
        outcomeConversation
      )
      const ownerCalls = routinePanelCalls.length
      const panelDetail = page.getByRole("region", { name: "例程详情", exact: true })
      await createdChip.click()
      await panelDetail.getByRole("heading", { name: updated.name, exact: true }).waitFor()
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      assert.equal(await page.locator(".bot-computer-content").count(), 1)
      assert.equal(await page.locator(".bot-routine-card").count(), 1)
      assert.equal(await page.locator(".bot-routine-form").count(), 0)
      assert.equal(await retainedPanel.getAttribute("data-tab"), "routine")
      assert.equal(await page.locator(".bot-inspector-base[hidden][inert]").count(), 1)
      assert.equal(
        await panelNode.evaluate((node) => node === document.querySelector(".bot-inspector-panel")),
        true
      )
      assert.equal(
        await computerNode.evaluate(
          (node) => node === document.querySelector(".bot-computer-content")
        ),
        true
      )
      await delay(200)
      const hiddenViewerReads = {
        computer: viewerComputerCalls,
        teach: viewerReadCalls.teachStatus ?? 0
      }
      const panelPollReads = routinePanelCalls.filter(({ method }) => method === "routines").length
      await delay(4500)
      assert.deepEqual(
        { computer: viewerComputerCalls, teach: viewerReadCalls.teachStatus ?? 0 },
        hiddenViewerReads,
        "The retained computer and Teach readers must stop while the routine view is active"
      )
      const viewCalls = routinePanelCalls.slice(ownerCalls)
      assert.ok(
        viewCalls.every(({ method }) => method === "routines"),
        JSON.stringify(viewCalls)
      )
      assert.ok(
        routinePanelCalls.filter(({ method }) => method === "routines").length - panelPollReads >=
          2,
        "The exact view must keep its original Resources reader live"
      )
      const hiddenLease = await api.computerOpen(ruleBotId)
      assert.equal(hiddenLease.controlOwner, "self")
      assert.equal(hiddenLease.generation, originalLease.generation)
      assert.equal(hiddenLease.controlEpoch, originalLease.controlEpoch)
      assert.deepEqual(
        await page.evaluate(
          (id) =>
            (window as unknown as { fixtureDraftState(viewId: string): unknown }).fixtureDraftState(
              id
            ),
          outcomeConversation
        ),
        originalDraft
      )
      await page.keyboard.press("Escape")
      await panelDetail.waitFor({ state: "hidden" })
      await retainedPanel.getByRole("tab", { name: "详情", exact: true }).waitFor()
      assert.equal(
        await panelNode.evaluate((node) => node === document.querySelector(".bot-inspector-panel")),
        true
      )
      assert.equal(
        await computerNode.evaluate(
          (node) => node === document.querySelector(".bot-computer-content")
        ),
        true
      )
      await retainedPanel.getByRole("tab", { name: "电脑", exact: true }).click()
      await retainedPanel.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      assert.equal(
        await retainedComputer.getByLabel("向浏览器输入文本", { exact: true }).inputValue(),
        "右侧例程验收：保留未发送的网页输入"
      )
      assert.deepEqual(
        await page.evaluate(
          (id) =>
            (window as unknown as { fixtureDraftState(viewId: string): unknown }).fixtureDraftState(
              id
            ),
          outcomeConversation
        ),
        originalDraft
      )
      await retainedPanel.getByRole("tab", { name: "详情", exact: true }).click()
      await retainedPanel
        .getByRole("button", { name: `查看例程 ${updated.name}`, exact: true })
        .click()
      await panelDetail.waitFor()
      const catalogueCount = () =>
        routinePanelCalls.filter(({ method }) =>
          ["skills", "availableSkills", "skillTrials", "skillLibrary"].includes(method)
        ).length
      const beforeCatalogue = catalogueCount()
      await panelDetail
        .getByRole("button", { name: `例程 ${updated.name} 的更多操作`, exact: true })
        .click()
      await page.getByRole("menu").waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("menu").waitFor({ state: "hidden" })
      assert.equal(
        await panelDetail.isVisible(),
        true,
        "Escape must dismiss the menu before the detail view"
      )
      await panelDetail
        .getByRole("button", { name: `例程 ${updated.name} 的更多操作`, exact: true })
        .click()
      await page.getByRole("menuitem", { name: "编辑设置", exact: true }).click()
      const panelEditor = page.getByRole("dialog", { name: "编辑例程", exact: true })
      await panelEditor.getByLabel("内容", { exact: true }).waitFor()
      assert.equal(
        catalogueCount() - beforeCatalogue,
        1,
        "A real editor loads its skill catalogue once"
      )
      assert.equal(await page.locator(".bot-routine-form").count(), 1)
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      await panelEditor.getByLabel("内容", { exact: true }).fill("右侧结构化设置：保留本地修改")
      const beforeEditorReads = routinePanelCalls.filter(
        ({ method }) => method === "routines"
      ).length
      const externallyUpdated = await api.saveRoutine({
        ...store.routine(ruleBotId, updated.id),
        name: "右侧例程：其他窗口更新标题",
        prompt: "右侧结构化设置：其他窗口更新",
        expectedDataEpoch: store.dataEpoch()
      })
      await panelEditor
        .getByText("例程已更新，当前草稿已保留。载入最新版本后再修改。", { exact: true })
        .waitFor()
      assert.ok(
        routinePanelCalls.filter(({ method }) => method === "routines").length > beforeEditorReads
      )
      assert.equal(
        await panelEditor.getByLabel("内容", { exact: true }).inputValue(),
        "右侧结构化设置：保留本地修改"
      )
      assert.equal(
        await panelEditor.getByRole("button", { name: "保存修改", exact: true }).isDisabled(),
        true
      )
      assert.equal(
        catalogueCount() - beforeCatalogue,
        1,
        "Routine polling must not repeat the catalogue read"
      )
      await panelEditor.getByLabel("执行频率", { exact: true }).click()
      await page.getByRole("listbox").waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("listbox").waitFor({ state: "hidden" })
      assert.equal(
        await panelEditor.isVisible(),
        true,
        "Escape must dismiss the select before its editor"
      )
      assert.equal(await page.locator('[data-testid="bot-routine-detail"]').isVisible(), true)
      await page.keyboard.press("Escape")
      await panelEditor.waitFor({ state: "hidden" })
      assert.equal(
        await panelDetail.isVisible(),
        true,
        "Closing the editor must retain the exact routine view"
      )
      assert.equal(await page.locator(".bot-routine-form").count(), 0)
      assert.equal(
        await panelDetail
          .getByRole("heading", { name: externallyUpdated.name, exact: true })
          .innerText(),
        externallyUpdated.name
      )
      const beforeChatEdit = routinePanelCalls.length
      await panelDetail.getByRole("button", { name: "编辑", exact: true }).click()
      await panelDetail.waitFor({ state: "hidden" })
      assert.match(await outcomePrompt.innerText(), /保留未发送的会话草稿/)
      assert.ok(
        (await outcomePrompt.innerText()).includes(
          `ID: ${externallyUpdated.id}，版本 ${externallyUpdated.revision}`
        )
      )
      assert.ok(
        (await outcomePrompt.innerText()).includes(`请修改例程「${externallyUpdated.name}」`)
      )
      assert.equal(await outcomePrompt.evaluate((node) => document.activeElement === node), true)
      assert.ok(
        routinePanelCalls.slice(beforeChatEdit).every(({ method }) => method === "routines")
      )
      assert.equal(
        await computerNode.evaluate(
          (node) => node === document.querySelector(".bot-computer-content")
        ),
        true
      )
      assert.equal(
        await retainedComputer.getByLabel("向浏览器输入文本", { exact: true }).inputValue(),
        "右侧例程验收：保留未发送的网页输入"
      )
      await createdChip.click()
      await panelDetail
        .getByRole("button", { name: `例程 ${externallyUpdated.name} 的更多操作`, exact: true })
        .waitFor()
      assert.equal(
        await panelDetail
          .getByRole("heading", { name: externallyUpdated.name, exact: true })
          .innerText(),
        externallyUpdated.name,
        "The original saved-outcome chip must resolve the current routine name instead of its saved metadata"
      )
      holdRoutinePanelSave = true
      const beforeBusy = routinePanelCalls.length
      await panelDetail
        .getByRole("button", { name: `例程 ${externallyUpdated.name} 的更多操作`, exact: true })
        .click()
      await page.getByRole("menuitem", { name: "启用", exact: true }).click()
      for (let n = 0; !releaseRoutinePanelSave && n < 100; n++) await delay(50)
      assert.ok(releaseRoutinePanelSave, "The original Resources save ACK must actually be held")
      const busyRequest = routinePanelCalls
        .slice(beforeBusy)
        .find(({ method }) => method === "saveRoutine")!.input as Parameters<
        typeof api.saveRoutine
      >[0]
      assert.equal(busyRequest.id, externallyUpdated.id)
      assert.equal(busyRequest.revision, externallyUpdated.revision)
      assert.equal(busyRequest.enabled, true)
      assert.ok(busyRequest.nonce)
      assert.deepEqual(busyRequest.schedule, externallyUpdated.schedule)
      const backButton = panelDetail.getByRole("button", { name: "返回 Bot 详情", exact: true })
      const closeButton = panelDetail.getByRole("button", { name: "关闭例程详情面板", exact: true })
      assert.equal(await backButton.isDisabled(), true)
      assert.equal(await closeButton.isDisabled(), true)
      await backButton.dispatchEvent("click")
      await closeButton.dispatchEvent("click")
      await page.keyboard.press("Escape")
      assert.equal(await createdChip.isDisabled(), true)
      await createdChip.dispatchEvent("click")
      assert.equal(await panelDetail.isVisible(), true)
      assert.equal(await page.locator(".bot-inspector-panel").count(), 1)
      assert.equal(await page.locator(".bot-routine-card").count(), 1)
      assert.equal(
        routinePanelCalls.slice(beforeBusy).filter(({ method }) => method === "saveRoutine").length,
        1
      )
      releaseRoutinePanelSave()
      releaseRoutinePanelSave = undefined
      await panelDetail.getByRole("button", { name: "暂停", exact: true }).waitFor()
      const acceptedPanelSave = store.routine(ruleBotId, externallyUpdated.id)
      assert.equal(acceptedPanelSave.revision, externallyUpdated.revision + 1)
      assert.equal(acceptedPanelSave.enabled, true)
      const beforeMissing = routinePanelCalls.length
      await api.deleteRoutine({
        botId: ruleBotId,
        id: acceptedPanelSave.id,
        revision: acceptedPanelSave.revision,
        nonce: "ui-panel-exact-original-removed",
        expectedDataEpoch: store.dataEpoch()
      })
      await panelDetail.getByText("例程已删除或不再可用。", { exact: true }).waitFor()
      assert.equal(await page.locator(".bot-routine-card").count(), 0)
      assert.equal(await page.locator(".bot-routine-form").count(), 0)
      assert.equal(
        await panelDetail.getByRole("button", { name: "新建例程", exact: true }).count(),
        0
      )
      assert.equal(
        await panelDetail.getByRole("heading", { name: "例程详情", exact: true }).count(),
        1
      )
      assert.ok(routinePanelCalls.slice(beforeMissing).every(({ method }) => method === "routines"))
      const finalLease = await api.computerOpen(ruleBotId)
      assert.equal(finalLease.controlOwner, "self")
      assert.equal(finalLease.generation, originalLease.generation)
      assert.equal(finalLease.controlEpoch, originalLease.controlEpoch)
      await page.keyboard.press("Escape")
      await panelDetail.waitFor({ state: "hidden" })
      assert.equal(
        await panelNode.evaluate((node) => node === document.querySelector(".bot-inspector-panel")),
        true
      )
      assert.equal(
        await computerNode.evaluate(
          (node) => node === document.querySelector(".bot-computer-content")
        ),
        true
      )
      await writeFile(
        join(output, "routine-panel-owner-proof.json"),
        JSON.stringify(
          {
            originalLease,
            hiddenLease,
            finalLease,
            originalDraft,
            exactViewCalls: viewCalls,
            catalogueReads: catalogueCount() - beforeCatalogue,
            externallyUpdated,
            busyRequest,
            acceptedPanelSave,
            missingViewCalls: routinePanelCalls.slice(beforeMissing),
            actualPanelAndComputerNodesRetained: true,
            physicalRestoreExercised: false
          },
          null,
          2
        )
      )
      await clearPrompt(outcomePrompt)
      await retainedPanel.getByRole("tab", { name: "电脑", exact: true }).click()
      await retainedComputer.getByLabel("向浏览器输入文本", { exact: true }).fill("")
      await retainedPanel.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
      await retainedPanel.waitFor({ state: "detached" })
      await panelNode.dispose()
      await computerNode.dispose()
    } finally {
      releaseRoutinePanelSave?.()
      releaseRoutinePanelSave = undefined
      const current = store.autoReview.read(ruleBotId)
      if (current.isEnabled !== outcomeReview.isEnabled)
        store.autoReview.change({
          ...current,
          isEnabled: outcomeReview.isEnabled,
          nonce: "ui-routine-outcome-review-restored"
        })
    }
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          passed: [
            "create",
            "deleted-branch-snapshot-recovery",
            "trusted-routine-save-outcome-original-detail-replay-and-live-guards",
            "routine-panel-original-owner-nodes-lease-drafts-catalogue-CAS-Escape-busy-and-missing",
            "bot-profile-approval-and-creation-limit",
            "persistent-pinned-keyboard-and-drag-order",
            "inspector-details-library-preview-and-retained-computer-control",
            "routine-history-pagination-live-state-and-result-navigation",
            "task-history-pagination-and-exact-approval-recovery",
            "recovery-receipt-reopen-and-lost-acknowledgement",
            "durable-group-rounds",
            "stable-bot-mentions-and-drafts",
            "typed-group-routine-connector-references-and-no-implicit-execution",
            "routine-edit-live-updates-and-idempotent-delete",
            "routine-inline-editor-conflicts-and-persistent-save-retries",
            "verified-skill-to-routine-and-explicit-version-confirmation",
            "plugin-notice-separate-from-answer",
            "group-settings-and-members",
            "group-save-response-loss-reopen-and-version-conflict",
            "group-inspector-library-scope-and-current-members",
            "persona-persistence",
            "send",
            "markdown",
            "artifacts",
            "attachment",
            "computer-takeover",
            "computer-input-waits-for-visible-frame",
            "computer-release",
            "computer-resize-and-expand",
            "streaming-output",
            "live-avatar-motion",
            "reduced-motion",
            "stable-message-dom",
            "pin-action",
            "dark-theme",
            "narrow-panel-and-draft",
            "paged-history-scroll-anchor",
            "cross-bot-reading-position-and-draft",
            "saved-history-error-and-explicit-same-target-retry",
            "message-skill-reference-open-and-explicit-version-difference",
            "private-skill-delete-lost-receipt-reopen-and-exact-retry",
            "bounded-conversation-task-queue-and-paged-actions",
            "superseded-message-navigation-cannot-clear-new-target",
            "unread-boundary-and-forward-pages",
            "manual-unread-survives-poll",
            "clone-configuration-and-routines",
            "storage-pressure-partial-sample-recovery"
          ],
          errors
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error("Bot UI assertion failed:", error)
    await writeFile(
      join(output, "failure-export-events.json"),
      JSON.stringify(exportBrowserEvents, null, 2)
    )
    await writeFile(join(output, "failure-errors.json"), JSON.stringify(errors, null, 2))
    await writeFile(
      join(output, "failure-drafts.json"),
      JSON.stringify(
        await page.evaluate(
          (ids) =>
            Object.fromEntries(
              ids.map((id) => [
                id,
                (
                  window as unknown as { fixtureDraftState(viewId: string): unknown }
                ).fixtureDraftState(id)
              ])
            ),
          store.snapshot().conversations.map((conversation) => conversation.id)
        ),
        null,
        2
      )
    )
    await writeFile(
      join(output, "failure-state.json"),
      JSON.stringify(
        {
          snapshot: store.snapshot(),
          recentEvents: store.events(Math.max(0, store.snapshot().cursor - 200), 200)
        },
        null,
        2
      )
    )
    await writeFile(
      join(output, "failure-transcript.json"),
      JSON.stringify(
        await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>(".bot-transcript")
          return node
            ? {
                scrollTop: node.scrollTop,
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
                history: (
                  window as unknown as { fixtureHistory(): { count: number; selected: string } }
                ).fixtureHistory(),
                rows: [...node.querySelectorAll<HTMLElement>("[data-message-id]")].map((row) => ({
                  id: row.dataset.messageId,
                  top: row.getBoundingClientRect().top,
                  bottom: row.getBoundingClientRect().bottom
                }))
              }
            : null
        }),
        null,
        2
      )
    )
    await page.screenshot({ animations: "disabled", path: join(output, "failure.png") })
    await writeFile(join(output, "failure.html"), await page.content())
    throw error
  } finally {
    let cleanupStage = "renderer context"
    const deadline = setTimeout(() => {
      console.error(`Bot UI fixture cleanup exceeded 20 seconds at ${cleanupStage}`)
      process.exit(1)
    }, 20_000)
    await page.context().close()
    cleanupStage = "renderer browser"
    await browser.close()
    cleanupStage = "Teach"
    await teach.close()
    cleanupStage = "Host"
    host.storage.close()
    await host.stop()
    cleanupStage = "Bot browser"
    await computer.close()
    cleanupStage = "files"
    await files.close()
    cleanupStage = "database"
    store.close()
    hostLock.release()
    cleanupStage = "temporary files"
    await rm(pluginWorkers, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
    clearTimeout(deadline)
  }
  console.log("PASS Bot workspace and fixture cleanup")
}
async function runOwnedFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-bot-ui-")))
  const hostLock = BotHostLock.acquire(directory)
  try {
    assert.ok(hostLock, "The embedded Host requires its actual private lifetime lock")
    await main(directory, hostLock)
  } finally {
    // Also cover startup failures before the original UI cleanup is installed.
    // Normal cleanup already releases this idempotent lock after draining Host.
    hostLock?.release()
  }
}
void runOwnedFixture().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
