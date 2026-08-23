import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, shell } from "electron"

// Fix Linux sandbox error: "The setuid sandbox is not running as root"
// On Linux the chrome-sandbox binary often lacks setuid permissions in packaged apps.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox")
}

import { join } from "path"
import { existsSync, rmSync } from "fs"
import {
  writeMainLog,
  writeRendererLog,
  flushLogs,
  flushLogsSync,
  initializeLogRedaction
} from "./logging"
import { registerPathOpenersHandlers } from "./ipc/path-openers"
import { scheduleHardDeadline, waitBestEffort } from "./shutdown-deadline"
import {
  clearAppAttention,
  disposeAppTray,
  initializeAppTray,
  isAppQuitting,
  isAppTrayAvailable,
  requestAppAttention,
  setAppQuitting,
  showPendingAppAttention
} from "./app-tray"
import { setAppAttentionHandler } from "./app-attention-events"
import { APP_ATTENTION_CHANNEL, isRendererAppAttentionPayload } from "../shared/app-attention"
import {
  closePromptActionToBehavior,
  isCloseToTrayPromptResponse,
  isWindowCloseBehavior,
  resolveWindowCloseRequest,
  type CloseToTrayPromptReason,
  type CloseToTrayPromptEvent,
  type WindowCloseBehavior
} from "../shared/close-to-tray"
import {
  configureAgentGraphRecursionLimit,
  configureWorkflowWorktreeRemoveTimeoutMinutes,
  configureWorkflowWorktreeTimeoutMinutes,
  getAgentGraphRecursionLimit,
  getWorkflowWorktreeRemoveTimeoutMinutes,
  getWorkflowWorktreeTimeoutMinutes,
  isAgentGraphRecursionLimit,
  isWorkflowWorktreeRemoveTimeoutMinutes,
  isWorkflowWorktreeTimeoutMinutes,
  type AgentRuntimeSettings
} from "../shared/agent-runtime-limits"

const MAIN_LOG_EVENT_CHANNEL = "debug:main-console-log"
const MAIN_LOG_TOGGLE_CHANNEL = "debug:set-main-console-forwarding"
const CLOSE_TO_TRAY_PROMPT_CHANNEL = "app:close-to-tray-prompt"
const CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL = "app:close-to-tray-prompt-response"
const WINDOW_CLOSE_BEHAVIOR_GET_CHANNEL = "app:get-window-close-behavior"
const WINDOW_CLOSE_BEHAVIOR_SET_CHANNEL = "app:set-window-close-behavior"
const WINDOW_CLOSE_BEHAVIOR_CHANGED_CHANNEL = "app:window-close-behavior-changed"
const CHAT_SCROLL_SETTINGS_GET_CHANNEL = "app:get-chat-scroll-settings"
const CHAT_SCROLL_SETTINGS_SET_CHANNEL = "app:set-chat-scroll-settings"
const CHAT_SCROLL_SETTINGS_CHANGED_CHANNEL = "app:chat-scroll-settings-changed"
const AGENT_RUNTIME_SETTINGS_GET_CHANNEL = "app:get-agent-runtime-settings"
const AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL = "app:set-agent-runtime-recursion-limit"
const WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL = "app:set-workflow-worktree-timeout"
const WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL = "app:set-workflow-worktree-remove-timeout"
const CLOSE_TO_TRAY_PROMPT_TIMEOUT_MS = 15_000
let mainLogForwardingEnabled = false
const EVENT_CATEGORIES = new Set<EventCategory>([
  "skill",
  "git",
  "code_adoption",
  "harness",
  "heartbeat",
  "memory",
  "hook",
  "chatx",
  "workspace"
])

function isTrackEventPayload(payload: unknown): payload is {
  eventName: string
  eventCategory: EventCategory
  properties?: Record<string, unknown>
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (
    typeof record.eventName !== "string" ||
    !record.eventName.trim() ||
    typeof record.eventCategory !== "string" ||
    !EVENT_CATEGORIES.has(record.eventCategory as EventCategory)
  ) {
    return false
  }
  return (
    record.properties === undefined ||
    (!!record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties))
  )
}

function getConsoleLevelName(level: number): string {
  switch (level) {
    case 0:
      return "INFO"
    case 1:
      return "WARN"
    case 2:
      return "ERROR"
    case 3:
      return "DEBUG"
    default:
      return "LOG"
  }
}

function safeFormatLogValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  if (typeof value === "bigint") return `${value.toString()}n`
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value !== "object") return String(value)

  try {
    return JSON.stringify(
      value,
      (_key, nestedValue) => {
        if (typeof nestedValue === "bigint") return `${nestedValue.toString()}n`
        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack
          }
        }
        if (typeof nestedValue === "symbol") return nestedValue.toString()
        if (typeof nestedValue === "function")
          return `[Function ${nestedValue.name || "anonymous"}]`
        if (nestedValue && typeof nestedValue === "object") {
          if (seen.has(nestedValue)) return "[Circular]"
          seen.add(nestedValue)
        }
        return nestedValue
      },
      2
    )
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function forwardMainLogToRenderer(level: string, args: unknown[]): void {
  if (!mainLogForwardingEnabled) return
  const message = args.map((arg) => safeFormatLogValue(arg)).join(" ")
  const windows = BrowserWindow.getAllWindows()
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(MAIN_LOG_EVENT_CHANNEL, { level, message })
  }
}

function withEpipeGuard<T extends (...args: unknown[]) => void>(fn: T): T {
  return ((...args: Parameters<T>) => {
    try {
      fn(...args)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EPIPE") return
      throw err
    }
  }) as T
}

function withMainFileLogging<T extends (...args: unknown[]) => void>(level: string, fn: T): T {
  return ((...args: Parameters<T>) => {
    const redactedArgs = writeMainLog(level, args)
    forwardMainLogToRenderer(level, redactedArgs)
    fn(...(redactedArgs as Parameters<T>))
  }) as T
}

// Guard console writes so broken stdout/stderr pipes don't crash main process.
console.log = withEpipeGuard(withMainFileLogging("INFO", console.log.bind(console)))
console.info = withEpipeGuard(withMainFileLogging("INFO", console.info.bind(console)))
console.warn = withEpipeGuard(withMainFileLogging("WARN", console.warn.bind(console)))
console.error = withEpipeGuard(withMainFileLogging("ERROR", console.error.bind(console)))
console.debug = withEpipeGuard(withMainFileLogging("DEBUG", console.debug.bind(console)))
console.trace = withEpipeGuard(withMainFileLogging("DEBUG", console.trace.bind(console)))

// Suppress EPIPE errors that occur when stdout/stderr pipe closes (e.g. during dev mode
// or when the renderer window is destroyed while the main process is still logging).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") return
  console.error("[Main] stdout error:", err)
})
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") return
  // Don't re-log to stderr here to avoid infinite loop
})
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") return // silently ignore broken pipe
  console.error("[Main] Uncaught exception:", err)
  // Persist the buffered tail (incl. this error) in case the process dies next.
  flushLogsSync()
})
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection:", reason)
})

// Signal-based termination (e.g. Ctrl+C in dev, or SIGTERM from a supervisor)
// does not fire Node's `exit` event, so flush the log tail before quitting.
// `once` lets a second signal fall through to default force-kill if quit hangs.
const flushAndQuitOnSignal = (signal: NodeJS.Signals): void => {
  console.warn(`[Main] received ${signal}, flushing logs and quitting`)
  flushLogsSync()
  app.quit()
}
process.once("SIGINT", () => flushAndQuitOnSignal("SIGINT"))
process.once("SIGTERM", () => flushAndQuitOnSignal("SIGTERM"))
import {
  disposeAllAgentThreadStates,
  hasAnyActiveAgentTasks,
  registerAgentHandlers,
  shutdownAllAgentTasks
} from "./ipc/agent"
import { registerWorkflowHandlers } from "./ipc/workflows"
import { registerThreadHandlers } from "./ipc/threads"
import { registerModelHandlers } from "./ipc/models"
import { registerSkillsHandlers } from "./ipc/skills"
import { registerMcpHandlers } from "./ipc/mcp"
import { registerScheduledTaskHandlers } from "./ipc/scheduled-tasks"
import { registerHeartbeatHandlers } from "./ipc/heartbeat"
import { registerMemoryHandlers } from "./ipc/memory"
import { registerTaskMmdHandlers } from "./ipc/task-mmd"
import { registerGitHandlers } from "./ipc/git"
import { registerPluginHandlers } from "./ipc/plugins"
import { registerPluginFileHandlers } from "./ipc/plugin-files"
import { registerSandboxHandlers } from "./ipc/sandbox"
import { registerOptimizerHandlers } from "./ipc/optimizer"
import { registerChatXHandlers } from "./ipc/chatx"
import { registerHooksHandlers } from "./ipc/hooks"
import { flushHookLogs, pruneOldHookLogs } from "./hooks/persistence"
import { registerTerminalHandlers, disposeAllTerminals } from "./ipc/terminal"
import { registerCodeExecToolsHandlers } from "./ipc/code-exec-tools"
import { registerRoutingHandlers } from "./ipc/routing"
import { registerDashboardHandlers } from "./ipc/dashboard"
import { registerAdoptionTraceHandlers } from "./ipc/adoption-trace"
import { registerFeatureGateHandlers } from "./ipc/feature-gates"
import { registerHarnessBoardHandlers } from "./ipc/harness-board"
import { registerLspHandlers } from "./ipc/lsp"
import { registerAutoCommitHandlers } from "./ipc/auto-commit"
import { registerExpertAgentsHandlers } from "./ipc/expert-agents"
import { registerTaskCardHandlers } from "./ipc/task-cards"
import { registerManagedLinkHandlers } from "./ipc/managed-links"
import { stopAllHarnessWatchRefs } from "./harness-board/watch-ref-watcher"
import { registerUserInputHandlers } from "./ipc/user-input"
import { stopAllLsp } from "./lsp"
import { initializeTraceStorageSecurity, setTraceReporter } from "./agent/trace/collector"
import { CloudTraceReporter } from "./agent/trace/cloud-reporter"
import { setEventReporter, HttpEventReporter } from "./services/event-reporter"
import { startHarnessStatusReporter } from "./services/harness-status-reporter"
import { initializeAdoptionTracker, shutdownAdoptionTracker } from "./services/adoption-tracker"
import {
  startRegisteredGitHookEventSync,
  stopRegisteredGitHookEventSync
} from "./services/git-hook-service"
import { getAllThreads, initializeDatabase, flush } from "./db"
import {
  hasActiveScheduledTaskRuns,
  startScheduler,
  stopScheduler,
  stopSchedulerAndWait
} from "./services/scheduler"
import {
  isHeartbeatRunning,
  startHeartbeat,
  stopHeartbeat,
  stopHeartbeatAndWait
} from "./services/heartbeat"
import { hasActiveChatXRuns, startChatX, stopChatX, stopChatXAndWait } from "./services/chatx"
import { startHookConfigWatcher, stopHookConfigWatcher } from "./services/hook-config-watcher"
import { LocalSandbox } from "./agent/local-sandbox"
import { closeRuntime } from "./agent/runtime"
import { makeBroadcastHookResultCallback } from "./hooks/result-callback"
import { fireSessionEndAll, hasActiveSessions } from "./hooks/session-lifecycle"
import { registerUpdaterHandlers, startUpdateChecker, stopUpdateChecker } from "./updater"
import { startBuiltinModelCatalogRefresh, stopBuiltinModelCatalogRefresh } from "./models/registry"
import { markFullBackupCleanupReady, runStartupSelfCheck } from "./updater/rollback"
import {
  getChatScrollSettings,
  getOpenworkDir,
  getStoredAgentGraphRecursionLimit,
  getStoredWorkflowWorktreeRemoveTimeoutMinutes,
  getStoredWorkflowWorktreeTimeoutMinutes,
  getWindowCloseBehavior,
  isKeepAwakeEnabled,
  setChatScrollSettings,
  setStoredAgentGraphRecursionLimit,
  setStoredWorkflowWorktreeRemoveTimeoutMinutes,
  setStoredWorkflowWorktreeTimeoutMinutes,
  setKeepAwakeEnabled,
  setWindowCloseBehavior
} from "./storage"
import { getLocalIP } from "./net-utils"
import { trackEvent } from "./services/event-reporter"
import type { EventCategory } from "./services/event-reporter"
import {
  configurePetWindow,
  createPetWindow,
  getPetWindowDebugInfo,
  markPetStartupReady,
  registerPetHandlers
} from "./pet"

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
let closeToTrayPromptOpen = false
let closeToTrayPromptRequestId = 0
let closeToTrayPromptTimer: NodeJS.Timeout | null = null
let closeToTrayPromptReason: CloseToTrayPromptReason | null = null
let closeToTrayPromptRememberChoiceAllowed = false
const STARTUP_SANDBOX_PREWARM_WORKSPACE_LIMIT = 5
const PET_STARTUP_DELAY_MS = 750
let petStartupTimer: NodeJS.Timeout | null = null

function cancelDelayedPetStartup(): void {
  if (!petStartupTimer) return
  clearTimeout(petStartupTimer)
  petStartupTimer = null
}

function schedulePetStartupAfterMainLoad(window: BrowserWindow): void {
  cancelDelayedPetStartup()
  petStartupTimer = setTimeout(() => {
    petStartupTimer = null
    if (mainWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) return
    markPetStartupReady()
  }, PET_STARTUP_DELAY_MS)
  petStartupTimer.unref?.()
}

function cleanupLegacySkillEvalRecords(): void {
  const roots = new Set(
    [getOpenworkDir(), process.env.CMB_COWORK_AGENT_HOME?.trim()].filter((value): value is string =>
      Boolean(value)
    )
  )

  for (const root of roots) {
    const legacyDir = join(root, "skill-evals")
    if (!existsSync(legacyDir)) continue
    try {
      rmSync(legacyDir, { recursive: true, force: true })
      console.log("[Main] Removed legacy SkillEval records:", legacyDir)
    } catch (error) {
      console.warn("[Main] Failed to remove legacy SkillEval records:", error)
    }
  }
}

// ── Keep Awake ──
let keepAwakeBlockerId: number | null = null

function applyKeepAwake(enabled: boolean): void {
  if (enabled) {
    if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension")
      console.log("[KeepAwake] Sleep prevention enabled")
    }
  } else {
    if (keepAwakeBlockerId !== null) {
      if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
        powerSaveBlocker.stop(keepAwakeBlockerId)
      }
      keepAwakeBlockerId = null
      console.log("[KeepAwake] Sleep prevention disabled")
    }
  }
}

// Simple dev check - replaces @electron-toolkit/utils is.dev
const isDev = !app.isPackaged

function getFirstExistingPath(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path))
}

function getBuildIconPath(fileName: string): string | undefined {
  return getFirstExistingPath([
    join(app.getAppPath(), `build/${fileName}`),
    join(process.cwd(), `build/${fileName}`),
    join(__dirname, `../../build/${fileName}`)
  ])
}

function getDevWindowsIconPath(): string | undefined {
  return getBuildIconPath("icon.ico")
}

function getDevMacDockIconPath(): string | undefined {
  return getBuildIconPath("icon.png") ?? getBuildIconPath("icon.ico")
}

function applyMacDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return

  // 宠物透明窗口会额外创建 BrowserWindow；macOS 下重复应用 Dock 图标可避免开发态图标被重置。
  app.dock.show()
  const iconPath = getFirstExistingPath([
    ...(isDev ? [getDevMacDockIconPath()] : []),
    join(__dirname, "../../resources/icon.png"),
    join(app.getAppPath(), "resources/icon.png"),
    join(__dirname, "../resources/icon.png"),
    join(app.getAppPath(), "build/icon.png"),
    join(process.cwd(), "build/icon.png")
  ].filter((path): path is string => Boolean(path)))

  if (isDev) {
    console.log(`[icon] mac dock icon path: ${iconPath ?? "not found"}`)
  }

  try {
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : null
    if (icon && !icon.isEmpty()) {
      app.dock.setIcon(icon)
      if (isDev) {
        console.log("[icon] mac dock icon applied")
      }
    } else if (isDev) {
      console.log("[icon] mac dock icon is empty")
    }
  } catch {
    if (isDev) {
      console.log("[icon] mac dock icon apply failed")
    }
  }
}

// getLocalIP moved to ./net-utils — imported above

function hideMainWindowToTray(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.hide()
  showPendingAppAttention()
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide()
  }
}

function clearCloseToTrayPromptState(): void {
  closeToTrayPromptOpen = false
  closeToTrayPromptReason = null
  closeToTrayPromptRememberChoiceAllowed = false
  if (closeToTrayPromptTimer) {
    clearTimeout(closeToTrayPromptTimer)
    closeToTrayPromptTimer = null
  }
}

function hasActiveForegroundRuns(): boolean {
  return (
    hasAnyActiveAgentTasks() ||
    hasActiveChatXRuns() ||
    hasActiveScheduledTaskRuns() ||
    isHeartbeatRunning()
  )
}

function saveWindowCloseBehavior(behavior: WindowCloseBehavior): WindowCloseBehavior {
  const savedBehavior = setWindowCloseBehavior(behavior)
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(WINDOW_CLOSE_BEHAVIOR_CHANGED_CHANNEL, savedBehavior)
  }
  return savedBehavior
}

function saveChatScrollSettings(
  settings: Parameters<typeof setChatScrollSettings>[0]
): ReturnType<typeof setChatScrollSettings> {
  const savedSettings = setChatScrollSettings(settings)
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(CHAT_SCROLL_SETTINGS_CHANGED_CHANNEL, savedSettings)
  }
  return savedSettings
}

function requestWindowCloseChoice(window: BrowserWindow, reason: CloseToTrayPromptReason): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  if (closeToTrayPromptOpen) {
    window.focus()
    return
  }

  const trayAvailable = isAppTrayAvailable()
  closeToTrayPromptOpen = true
  closeToTrayPromptReason = reason
  closeToTrayPromptRememberChoiceAllowed = reason !== "active-runs"
  closeToTrayPromptRequestId += 1
  const requestId = closeToTrayPromptRequestId
  closeToTrayPromptTimer = setTimeout(() => {
    if (closeToTrayPromptRequestId === requestId) {
      console.warn("[Main] Close-to-tray prompt timed out")
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        const event: CloseToTrayPromptEvent = {
          type: "dismiss",
          requestId,
          reason: "timeout"
        }
        mainWindow.webContents.send(CLOSE_TO_TRAY_PROMPT_CHANNEL, event)
      }
      clearCloseToTrayPromptState()
    }
  }, CLOSE_TO_TRAY_PROMPT_TIMEOUT_MS)
  window.focus()
  const event: CloseToTrayPromptEvent = {
    type: "open",
    requestId,
    trayAreaName: process.platform === "darwin" ? "菜单栏" : "系统托盘",
    reason,
    canMinimizeToTray: trayAvailable,
    rememberChoiceAllowed: closeToTrayPromptRememberChoiceAllowed
  }
  window.webContents.send(CLOSE_TO_TRAY_PROMPT_CHANNEL, event)
}

function createWindow(): void {
  const devWindowIcon = process.platform === "win32" && isDev ? getDevWindowsIconPath() : undefined

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    backgroundColor: "#0D0D0F",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 11 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
    },
    ...(devWindowIcon ? { icon: devWindowIcon } : {}),
    autoHideMenuBar: ![".166", ".147", ".216", ".215", ".225", "201.99"].some((ip) =>
      getLocalIP().includes(ip)
    ) // 自动隐藏菜单栏
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
    applyMacDockIcon()
  })

  mainWindow.on("focus", clearAppAttention)
  mainWindow.on("blur", showPendingAppAttention)

  mainWindow.on("unresponsive", () => {
    console.warn("[Main] BrowserWindow became unresponsive")
  })

  mainWindow.on("responsive", () => {
    console.info("[Main] BrowserWindow recovered responsiveness")
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
  })

  // Electron does not provide an application context menu automatically.
  // Use native edit roles so labels, clipboard behavior, shortcuts, and
  // enabled states follow the OS for editable fields and selected read-only text.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const window = mainWindow
    const hasSelectedText = params.selectionText.trim().length > 0
    if ((!params.isEditable && !hasSelectedText) || !window || window.isDestroyed()) return

    Menu.buildFromTemplate([
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll }
    ]).popup({ window })
  })

  // A renderer reload destroys the in-flight stream consumer while the agent
  // continues in the main process. This application intentionally has no
  // mid-turn reload/reconnect contract, so block browser refresh shortcuts.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isRefreshShortcut =
      input.key === "F5" ||
      ((input.meta || input.control) && input.key.toLowerCase() === "r")
    if (isRefreshShortcut) event.preventDefault()
  })

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeRendererLog(getConsoleLevelName(level), message, { sourceId, line })
  })

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    clearCloseToTrayPromptState()
    console.error("[Main] Renderer failed to load:", {
      errorCode,
      errorDescription,
      validatedURL
    })
  })

  mainWindow.webContents.on("did-start-loading", () => {
    clearCloseToTrayPromptState()
  })

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    clearCloseToTrayPromptState()
    console.error("[Main] Renderer process gone:", details)
  })

  mainWindow.webContents.on("did-finish-load", () => {
    const version = app.getVersion()
    console.log("version---------------", version)
    console.log("getLocalIP", getLocalIP())
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("version", version)
      mainWindow.webContents.send("ip", getLocalIP())
      schedulePetStartupAfterMainLoad(mainWindow)
    }
  })

  // HMR for renderer based on electron-vite cli
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    console.log("local render")
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    console.log("url render")
    // mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
    const renderUrl = import.meta.env.VITE_RENDER_URL
    if (!renderUrl) {
      mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
    }else{
      mainWindow.loadURL(renderUrl)
    }
  }

  mainWindow.on("close", (event) => {
    console.warn("[Main] Main window close requested", {
      pet: getPetWindowDebugInfo()
    })
    const trayAvailable = isAppTrayAvailable()
    const decision = resolveWindowCloseRequest({
      behavior: getWindowCloseBehavior(),
      isAppQuitting: isAppQuitting(),
      trayAvailable,
      hasActiveForegroundRuns: hasActiveForegroundRuns()
    })
    if (decision.action === "allow-close") return

    event.preventDefault()
    if (!mainWindow) return
    if (decision.action === "minimize-to-tray") {
      hideMainWindowToTray(mainWindow)
    } else if (decision.action === "quit") {
      app.quit()
    } else {
      requestWindowCloseChoice(mainWindow, decision.reason)
    }
  })

  mainWindow.on("closed", () => {
    console.warn("[Main] Main window closed", {
      platform: process.platform,
      pet: getPetWindowDebugInfo()
    })
    cancelDelayedPetStartup()
    clearCloseToTrayPromptState()
    mainWindow = null
    if (process.platform !== "darwin") {
      app.quit()
    }
  })
}

/**
 * 确保主窗口可见并获得焦点。
 *
 * 供单实例唤起、宠物窗口交互等入口复用，覆盖主窗口被销毁、最小化和隐藏三种情况。
 */
function ensureMainWindowVisible(): BrowserWindow | null {
  clearAppAttention()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return mainWindow
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  mainWindow.focus()
  return mainWindow
}

function collectRecentWorkspacePathsForSandboxPrewarm(): string[] {
  const workspaces: string[] = []
  const seen = new Set<string>()

  for (const thread of getAllThreads().slice(0, STARTUP_SANDBOX_PREWARM_WORKSPACE_LIMIT)) {
    if (!thread.metadata) continue
    try {
      const metadata = JSON.parse(thread.metadata)
      const workspacePath =
        typeof metadata.workspacePath === "string" ? metadata.workspacePath.trim() : ""
      if (!workspacePath) continue
      const key = workspacePath.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      workspaces.push(workspacePath)
    } catch {
      // Ignore malformed metadata and keep scanning recent threads.
    }
  }

  return workspaces
}

function prewarmRecentSandboxWorkspaces(): void {
  if (process.platform !== "win32") return
  const workspaces = collectRecentWorkspacePathsForSandboxPrewarm()
  if (workspaces.length === 0) return
  console.log(`[Main] Prewarming sandbox for ${workspaces.length} recent workspace(s)`)
  LocalSandbox.prewarmForWorkspaces(workspaces)
}

// Ensure only a single instance is running (prevents duplicate schedulers on Windows)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    ensureMainWindowVisible()
  })

  app.whenReady().then(async () => {
    configureAgentGraphRecursionLimit(getStoredAgentGraphRecursionLimit())
    configureWorkflowWorktreeTimeoutMinutes(getStoredWorkflowWorktreeTimeoutMinutes())
    configureWorkflowWorktreeRemoveTimeoutMinutes(
      getStoredWorkflowWorktreeRemoveTimeoutMinutes()
    )

    // Set app user model id for windows
    if (process.platform === "win32") {
      app.setAppUserModelId("CMBDevClaw")
    }

    // Set dock icon on macOS
    applyMacDockIcon()
    configurePetWindow({
      ensureMainWindowVisible,
      applyMacDockIcon
    })

    try {
      await flushLogs()
      const logRedaction = initializeLogRedaction()
      if (logRedaction.failedFiles > 0) {
        console.warn(
          `[Main] Historical log redaction incomplete: scanned=${logRedaction.scannedFiles}, redacted=${logRedaction.redactedFiles}, failed=${logRedaction.failedFiles}`
        )
      } else if (!logRedaction.alreadyComplete && logRedaction.redactedFiles > 0) {
        console.log(
          `[Main] Historical log redaction complete: scanned=${logRedaction.scannedFiles}, redacted=${logRedaction.redactedFiles}`
        )
      }
    } catch (error) {
      console.warn(
        `[Main] Historical log redaction failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    try {
      const traceStorage = initializeTraceStorageSecurity()
      if (!traceStorage.ready) {
        console.warn(
          `[Main] Encrypted trace storage unavailable; local trace writes will fail closed: ${traceStorage.reason ?? "unknown reason"}`
        )
      } else if (traceStorage.mode === "plaintext") {
        console.warn(
          "[Main] Trace storage is explicitly configured as plaintext; do not use this mode with sensitive data"
        )
      } else if (traceStorage.migrationSkipped) {
        console.log(
          `[Main] Trace storage mode=${traceStorage.mode}, migration=already-complete, failed=0`
        )
      } else if (traceStorage.failedFiles > 0 || traceStorage.reason) {
        console.warn(
          `[Main] Trace storage mode=${traceStorage.mode}, migrated=${traceStorage.migratedFiles}, alreadyProtected=${traceStorage.protectedFiles}, failed=${traceStorage.failedFiles}: ${traceStorage.reason ?? "some legacy files could not be protected"}`
        )
      } else {
        console.log(
          `[Main] Trace storage mode=${traceStorage.mode}, migrated=${traceStorage.migratedFiles}, alreadyProtected=${traceStorage.protectedFiles}, failed=0`
        )
      }
    } catch (error) {
      console.warn(
        `[Main] Trace storage initialization failed; local trace writes will fail closed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Default open or close DevTools by F12 in development
    if (isDev) {
      app.on("browser-window-created", (_, window) => {
        window.webContents.on("before-input-event", (event, input) => {
          if (input.key === "F12") {
            window.webContents.toggleDevTools()
            event.preventDefault()
          }
        })
      })
    }

    const traceBaseUrl = import.meta.env.VITE_API_TRACE_BASE_URL as string | undefined
    if (traceBaseUrl) {
      setTraceReporter(new CloudTraceReporter(traceBaseUrl))
      console.log("[Main] CloudTraceReporter registered, uploading traces to:", traceBaseUrl)

      // Operational telemetry events (skill / git) share the same base URL.
      setEventReporter(new HttpEventReporter(traceBaseUrl))
      console.log("[Main] HttpEventReporter registered, sending events to:", traceBaseUrl)
    }

    // Periodically upsert Harness Board project/feature status into the event
    // index. Prefers the backend event service (VITE_API_TRACE_BASE_URL) and
    // falls back to writing ES directly (VITE_ES_NODES); no-ops when neither is
    // configured.
    startHarnessStatusReporter()

    // Initialize database
    await initializeDatabase()
    cleanupLegacySkillEvalRecords()

    // Initialize adoption tracker (side-effect only; never blocks startup)
    try {
      await initializeAdoptionTracker()
    } catch (err) {
      console.warn("[Main] AdoptionTracker init failed (disabled):", err)
    }
    startRegisteredGitHookEventSync()

    // Register IPC handlers
    registerAgentHandlers(ipcMain)
    registerWorkflowHandlers(ipcMain)
    registerThreadHandlers(ipcMain)
    registerModelHandlers(ipcMain)
    registerSkillsHandlers(ipcMain)
    registerMcpHandlers(ipcMain)
    registerScheduledTaskHandlers(ipcMain)
    registerHeartbeatHandlers(ipcMain)
    registerMemoryHandlers(ipcMain)
    registerTaskMmdHandlers(ipcMain)
    registerGitHandlers()
    registerPluginHandlers(ipcMain)
    registerPluginFileHandlers(ipcMain)
    registerSandboxHandlers(ipcMain)
    registerOptimizerHandlers(ipcMain)
    registerChatXHandlers(ipcMain)
    registerHooksHandlers(ipcMain)
    // Best-effort cleanup of stale hook-log jsonl files. Doesn't block startup.
    void pruneOldHookLogs().catch((e) => console.warn("[Main] pruneOldHookLogs error:", e))
    registerTerminalHandlers(ipcMain)
    registerCodeExecToolsHandlers(ipcMain)
    registerRoutingHandlers(ipcMain)
    registerDashboardHandlers(ipcMain)
    registerAdoptionTraceHandlers(ipcMain)
    registerFeatureGateHandlers(ipcMain)
    registerHarnessBoardHandlers(ipcMain)
    registerUpdaterHandlers()
    registerLspHandlers(ipcMain)
    registerPathOpenersHandlers(ipcMain)
    prewarmRecentSandboxWorkspaces()
    registerAutoCommitHandlers(ipcMain)
    registerExpertAgentsHandlers(ipcMain)
    registerTaskCardHandlers(ipcMain)
    registerManagedLinkHandlers(ipcMain)
    registerPetHandlers(ipcMain)
    registerUserInputHandlers(ipcMain)

    ipcMain.on(APP_ATTENTION_CHANNEL, (event, payload: unknown) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (event.sender.id !== mainWindow.webContents.id || !isRendererAppAttentionPayload(payload))
        return
      // Main-process sources own persistent state and keys. Strip renderer keys so
      // a compromised renderer cannot overwrite or resolve an approval/input entry.
      requestAppAttention({ kind: payload.kind, threadId: payload.threadId })
    })

    ipcMain.handle(WINDOW_CLOSE_BEHAVIOR_GET_CHANNEL, (event) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        throw new Error("Window close settings are only available to the main window")
      }
      return getWindowCloseBehavior()
    })

    ipcMain.handle(WINDOW_CLOSE_BEHAVIOR_SET_CHANNEL, (event, behavior: unknown) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        throw new Error("Window close settings are only available to the main window")
      }
      if (!isWindowCloseBehavior(behavior)) {
        throw new Error("Invalid window close behavior")
      }
      return saveWindowCloseBehavior(behavior)
    })

    ipcMain.handle(CHAT_SCROLL_SETTINGS_GET_CHANNEL, (event) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        throw new Error("Chat scroll settings are only available to the main window")
      }
      return getChatScrollSettings()
    })

    ipcMain.handle(CHAT_SCROLL_SETTINGS_SET_CHANNEL, (event, settings: unknown) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        throw new Error("Chat scroll settings are only available to the main window")
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error("Invalid chat scroll settings")
      }
      return saveChatScrollSettings(settings as Parameters<typeof setChatScrollSettings>[0])
    })

    ipcMain.handle(AGENT_RUNTIME_SETTINGS_GET_CHANNEL, (event): AgentRuntimeSettings => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        throw new Error("Agent runtime settings are only available to the main window")
      }
      return {
        recursionLimit: getAgentGraphRecursionLimit(),
        workflowWorktreeTimeoutMinutes: getWorkflowWorktreeTimeoutMinutes(),
        workflowWorktreeRemoveTimeoutMinutes: getWorkflowWorktreeRemoveTimeoutMinutes()
      }
    })

    ipcMain.handle(
      AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL,
      (event, value: unknown): AgentRuntimeSettings => {
        if (
          !mainWindow ||
          mainWindow.isDestroyed() ||
          event.sender.id !== mainWindow.webContents.id
        ) {
          throw new Error("Agent runtime settings are only available to the main window")
        }
        if (!isAgentGraphRecursionLimit(value)) {
          throw new Error("Agent graph recursion limit must be an integer between 25 and 100000")
        }
        const persisted = setStoredAgentGraphRecursionLimit(value)
        return {
          recursionLimit: configureAgentGraphRecursionLimit(persisted),
          workflowWorktreeTimeoutMinutes: getWorkflowWorktreeTimeoutMinutes(),
          workflowWorktreeRemoveTimeoutMinutes: getWorkflowWorktreeRemoveTimeoutMinutes()
        }
      }
    )

    ipcMain.handle(
      WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL,
      (event, value: unknown): AgentRuntimeSettings => {
        if (
          !mainWindow ||
          mainWindow.isDestroyed() ||
          event.sender.id !== mainWindow.webContents.id
        ) {
          throw new Error("Agent runtime settings are only available to the main window")
        }
        if (!isWorkflowWorktreeTimeoutMinutes(value)) {
          throw new Error("Workflow worktree timeout must be an integer between 1 and 120 minutes")
        }
        const persisted = setStoredWorkflowWorktreeTimeoutMinutes(value)
        return {
          recursionLimit: getAgentGraphRecursionLimit(),
          workflowWorktreeTimeoutMinutes: configureWorkflowWorktreeTimeoutMinutes(persisted),
          workflowWorktreeRemoveTimeoutMinutes: getWorkflowWorktreeRemoveTimeoutMinutes()
        }
      }
    )

    ipcMain.handle(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL,
      (event, value: unknown): AgentRuntimeSettings => {
        if (
          !mainWindow ||
          mainWindow.isDestroyed() ||
          event.sender.id !== mainWindow.webContents.id
        ) {
          throw new Error("Agent runtime settings are only available to the main window")
        }
        if (!isWorkflowWorktreeRemoveTimeoutMinutes(value)) {
          throw new Error(
            "Workflow worktree removal timeout must be an integer between 1 and 10 minutes"
          )
        }
        const persisted = setStoredWorkflowWorktreeRemoveTimeoutMinutes(value)
        return {
          recursionLimit: getAgentGraphRecursionLimit(),
          workflowWorktreeTimeoutMinutes: getWorkflowWorktreeTimeoutMinutes(),
          workflowWorktreeRemoveTimeoutMinutes:
            configureWorkflowWorktreeRemoveTimeoutMinutes(persisted)
        }
      }
    )

    ipcMain.on(CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL, (event, payload: unknown) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (event.sender.id !== mainWindow.webContents.id) return
      if (!isCloseToTrayPromptResponse(payload)) return
      if (!closeToTrayPromptOpen || payload.requestId !== closeToTrayPromptRequestId) return

      const promptWindow = mainWindow
      const promptReason = closeToTrayPromptReason
      const rememberChoiceAllowed = closeToTrayPromptRememberChoiceAllowed
      const needsActiveRunConfirmation = (): boolean =>
        payload.action === "direct-close" &&
        promptReason !== "active-runs" &&
        hasActiveForegroundRuns()

      if (payload.action === "minimize-to-tray" && !isAppTrayAvailable()) {
        clearCloseToTrayPromptState()
        requestWindowCloseChoice(promptWindow, "tray-unavailable")
        return
      }

      // A background ChatX message can start while the ordinary close prompt is
      // open. Upgrade to the non-suppressible safety prompt before quitting.
      if (needsActiveRunConfirmation()) {
        clearCloseToTrayPromptState()
        requestWindowCloseChoice(promptWindow, "active-runs")
        return
      }

      let rememberError: unknown = null
      const rememberedBehavior = closePromptActionToBehavior(payload.action)
      if (rememberChoiceAllowed && payload.rememberChoice && rememberedBehavior) {
        try {
          saveWindowCloseBehavior(rememberedBehavior)
        } catch (error) {
          console.warn("[Main] Failed to remember window close behavior:", error)
          rememberError = error
        }
      }

      clearCloseToTrayPromptState()

      const performAction = (): void => {
        if (payload.action === "minimize-to-tray") {
          // The native save-failure warning may outlive the tray. Never hide
          // the only main window after its recovery entry point disappeared.
          if (!isAppTrayAvailable() && !promptWindow.isDestroyed()) {
            requestWindowCloseChoice(promptWindow, "tray-unavailable")
            return
          }
          if (!promptWindow.isDestroyed()) hideMainWindowToTray(promptWindow)
        } else if (payload.action === "direct-close") {
          // The save-failure warning is asynchronous. A task can start while it
          // is open, so repeat the safety check immediately before the real quit.
          if (needsActiveRunConfirmation() && !promptWindow.isDestroyed()) {
            requestWindowCloseChoice(promptWindow, "active-runs")
            return
          }
          // app.quit() 会触发 before-quit → will-quit 事件链，
          // 其中会先中断并等待活跃任务，再执行 fireSessionEndAll，
          // flush()（持久化待写入数据）等清理操作，确保数据安全退出。
          app.quit()
        }
      }

      if (rememberError && !promptWindow.isDestroyed()) {
        void dialog
          .showMessageBox(promptWindow, {
            type: "warning",
            title: "设置未保存",
            message: "无法记住本次关闭窗口的选择",
            detail: "本次操作仍会执行，原关闭窗口设置保持不变。",
            buttons: ["知道了"],
            defaultId: 0,
            noLink: true
          })
          .catch((error) => console.warn("[Main] Failed to show close setting warning:", error))
          .finally(performAction)
        return
      }

      performAction()
    })

    ipcMain.on(MAIN_LOG_TOGGLE_CHANNEL, (_event, enabled: unknown) => {
      mainLogForwardingEnabled = Boolean(enabled)
    })

    // Track event handler for client-side telemetry
    ipcMain.handle("track-event", async (_event, payload: unknown) => {
      try {
        if (!isTrackEventPayload(payload)) {
          return { success: false }
        }
        const { eventName, eventCategory, properties } = payload
        trackEvent(eventName, eventCategory, properties)
        return { success: true }
      } catch (error) {
        console.error("[IPC] Failed to track event:", error)
        return { success: false }
      }
    })

    // Register file system handlers
    ipcMain.handle("get-platform", async () => {
      return process.platform
    })

    ipcMain.handle("get-local-ip", async () => {
      return getLocalIP()
    })

    ipcMain.handle("get-version", async () => {
      return app.getVersion()
    })

    ipcMain.handle("open-login-window", async () => {
      if (!loginWindow) {
        loginWindow = new BrowserWindow({
          width: 1280,
          height: 800,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
            preload: join(__dirname, "../preload/index.js"),
          },
        })
      }
      loginWindow.loadURL(`https://oa-auth.paas.${import.meta.env.VITE_LOGIN_PT}.com/auth/sso-login` +
        "?client_id=5221ab160e0145d9b0736c2f8fb84229" +
        "&redirect_uri=" + encodeURIComponent(`https://cmbdevclawweb.paas.${import.meta.env.VITE_LOGIN_PT}.cn/login.html`) +
        "&response_type=code")
    })

    ipcMain.handle("close-login-window", async () => {
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close()
        loginWindow = null
      }
      if(mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("notify-login-msg",'login')
      }
    })

    ipcMain.handle("open-login-page", async () => {
      if(mainWindow && !mainWindow.isDestroyed() && !isDev) {
        mainWindow.loadURL(`https://oa-auth.paas.${import.meta.env.VITE_LOGIN_PT}.com/auth/sso-login` +
          "?client_id=5221ab160e0145d9b0736c2f8fb84229" +
          "&redirect_uri=" + encodeURIComponent(`https://cmbdevclawweb.paas.${import.meta.env.VITE_LOGIN_PT}.cn/login.html`) +
          "&response_type=code")
      }
    })

    ipcMain.handle("close-login-page", async () => {
      if(mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
      }
    })

    // Run post-update self-check before creating windows or starting services.
    // This keeps backup cleanup ahead of renderer startup and lazy child process
    // creation, reducing the chance that fresh app activity races .bak removal.
    const selfCheckResult = await runStartupSelfCheck()

    // Expose result to renderer — renderer polls this on mount to show update toast
    ipcMain.handle("update:get-startup-result", () => selfCheckResult)

    const initialModelCatalogLoad = startBuiltinModelCatalogRefresh()
    createWindow()
    setAppAttentionHandler(requestAppAttention)
    await initializeAppTray({
      getMainWindow: () => mainWindow,
      showMainWindow: () => {
        ensureMainWindowVisible()
        applyMacDockIcon()
      }
    })
    // Background services can execute immediately on startup. Wait for the
    // initial catalog request so due work never runs against a temporary
    // fallback merely because the remote manifest was still loading.
    await initialModelCatalogLoad

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()
    startChatX()
    startHookConfigWatcher()
    startUpdateChecker()
    markFullBackupCleanupReady(selfCheckResult)

    // ── Keep Awake ──
    applyKeepAwake(isKeepAwakeEnabled())

    ipcMain.handle("keepAwake:get", () => isKeepAwakeEnabled())
    ipcMain.handle("keepAwake:set", (_event, enabled: boolean) => {
      applyKeepAwake(enabled)
      setKeepAwakeEnabled(enabled)
    })

    app.on("activate", () => {
      const activatedWindow = ensureMainWindowVisible()
      applyMacDockIcon()
      if (activatedWindow && !activatedWindow.webContents.isLoadingMainFrame()) {
        createPetWindow()
      }
    })
  })

  app.on("window-all-closed", () => {
    console.warn("[Main] window-all-closed", {
      platform: process.platform,
      pet: getPetWindowDebugInfo()
    })
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Use before-quit (not will-quit) so we can preventDefault, await SessionEnd hooks,
  // then re-issue app.quit(). will-quit fires during teardown — async hook spawns
  // queued there have no guarantee of completing before the process exits.
  let sessionEndDone = false
  let sessionEndInProgress = false
  app.on("before-quit", (event) => {
    const activeSessions = hasActiveSessions()
    const activeTasks = hasActiveForegroundRuns()
    console.warn("[Main] before-quit", {
      sessionEndDone,
      sessionEndInProgress,
      hasActiveSessions: activeSessions,
      hasActiveTasks: activeTasks,
      pet: getPetWindowDebugInfo()
    })
    if (sessionEndDone) {
      setAppQuitting(true)
      return
    }
    if (sessionEndInProgress) {
      // fireSessionEndAll clears its session map before awaiting hooks. A second
      // quit request must not observe the empty map and bypass the in-flight drain.
      event.preventDefault()
      return
    }
    if (!activeSessions && !activeTasks) {
      sessionEndDone = true
      setAppQuitting(true)
      return
    }
    event.preventDefault()
    sessionEndInProgress = true
    void (async () => {
      try {
        const shutdownResults = await Promise.allSettled([
          shutdownAllAgentTasks(5_000),
          stopChatXAndWait(5_000),
          stopSchedulerAndWait(5_000),
          stopHeartbeatAndWait(5_000)
        ])
        for (const result of shutdownResults) {
          if (result.status === "rejected") {
            console.warn("[Main] Active task shutdown error:", result.reason)
          }
        }
        await fireSessionEndAll(5_000, (threadId) =>
          makeBroadcastHookResultCallback(`agent:stream:${threadId}`)
        )
      } catch (error) {
        console.warn("[Main] SessionEnd hooks error:", error)
      } finally {
        disposeAllAgentThreadStates()
        sessionEndDone = true
        sessionEndInProgress = false
        setAppQuitting(true)
        app.quit()
      }
    })()
  })

  let quitting = false
  app.on("will-quit", (e) => {
    console.warn("[Main] will-quit", {
      quitting,
      pet: getPetWindowDebugInfo()
    })
    if (quitting) {
      // Re-entry: user pressed Cmd+Q again while cleanup is running. Just block.
      e.preventDefault()
      return
    }
    quitting = true
    e.preventDefault()
    setAppAttentionHandler(null)
    disposeAppTray()
    applyKeepAwake(false)
    disposeAllTerminals()
    LocalSandbox.killAll()
    stopScheduler()
    stopHeartbeat()
    stopChatX()
    stopAllHarnessWatchRefs()
    stopHookConfigWatcher()
    stopRegisteredGitHookEventSync()
    stopBuiltinModelCatalogRefresh()
    stopUpdateChecker()
    try {
      shutdownAdoptionTracker()
    } catch (err) {
      console.warn("[Main] shutdownAdoptionTracker error:", err)
    }

    const cleanup = Promise.all([
      stopAllLsp().catch((err) => console.warn("[Main] stopAllLsp error:", err)),
      closeRuntime().catch((err) => console.warn("[Main] closeRuntime error:", err)),
      flushHookLogs().catch((err) => console.warn("[Main] flushHookLogs error:", err))
    ])

    const CLEANUP_TIMEOUT_MS = 10_000
    const FORCE_FLUSH_GRACE_MS = 2_000
    const HARD_EXIT_TIMEOUT_MS = CLEANUP_TIMEOUT_MS + FORCE_FLUSH_GRACE_MS + 500

    let exitStarted = false
    let cancelHardExit: (() => void) | null = null

    const exitImmediately = (): void => {
      if (cancelHardExit) {
        cancelHardExit()
        cancelHardExit = null
      }
      app.exit(0)
    }

    const doExit = async (force: boolean): Promise<void> => {
      if (exitStarted) return
      exitStarted = true

      if (force) {
        // Cleanup already exceeded its budget. Give persistence a short bounded
        // grace period, but never let a stalled disk keep the process alive.
        await Promise.all([
          waitBestEffort(flush(), FORCE_FLUSH_GRACE_MS),
          waitBestEffort(flushLogs(), FORCE_FLUSH_GRACE_MS)
        ])
      } else {
        await flush()
        await flushLogs()
      }
      exitImmediately()
    }

    // Independent hard deadline: even if cleanup finishes just before its timer
    // and the normal async flush then stalls, the process still exits.
    cancelHardExit = scheduleHardDeadline(() => {
      console.error("[Main] Hard exit deadline reached")
      flushLogsSync()
      exitImmediately()
    }, HARD_EXIT_TIMEOUT_MS)

    // Give async cleanup up to 10s, then switch to bounded best-effort flushes.
    const forceTimer = setTimeout(() => {
      console.warn("[Main] Cleanup timeout, force quitting")
      void doExit(true)
    }, CLEANUP_TIMEOUT_MS)

    cleanup.finally(() => {
      clearTimeout(forceTimer)
      void doExit(false)
    })
  })
}
