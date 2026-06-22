import { app, BrowserWindow, ipcMain, nativeImage, powerSaveBlocker, shell } from "electron"

// Fix Linux sandbox error: "The setuid sandbox is not running as root"
// On Linux the chrome-sandbox binary often lacks setuid permissions in packaged apps.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox")
}

import { join } from "path"
import { existsSync, rmSync } from "fs"
import { writeMainLog, writeRendererLog } from "./logging"
import { registerPathOpenersHandlers } from "./ipc/path-openers"

const MAIN_LOG_EVENT_CHANNEL = "debug:main-console-log"
const MAIN_LOG_TOGGLE_CHANNEL = "debug:set-main-console-forwarding"
let mainLogForwardingEnabled = false

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
        if (typeof nestedValue === "function") return `[Function ${nestedValue.name || "anonymous"}]`
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
    writeMainLog(level, args)
    forwardMainLogToRenderer(level, args)
    fn(...args)
  }) as T
}

// Guard console writes so broken stdout/stderr pipes don't crash main process.
console.log = withEpipeGuard(withMainFileLogging("INFO", console.log.bind(console)))
console.info = withEpipeGuard(withMainFileLogging("INFO", console.info.bind(console)))
console.warn = withEpipeGuard(withMainFileLogging("WARN", console.warn.bind(console)))
console.error = withEpipeGuard(withMainFileLogging("ERROR", console.error.bind(console)))
console.debug = withEpipeGuard(withMainFileLogging("DEBUG", console.debug.bind(console)))

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
})
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection:", reason)
})
import { disposeAllAgentThreadStates, registerAgentHandlers } from "./ipc/agent"
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
import { registerTaskCardHandlers } from "./ipc/task-cards"
import { stopAllHarnessWatchRefs } from "./harness-board/watch-ref-watcher"
import { registerUserInputHandlers } from "./ipc/user-input"
import { stopAllLsp } from "./lsp"
import { setTraceReporter } from "./agent/trace/collector"
import { CloudTraceReporter } from "./agent/trace/cloud-reporter"
import { setEventReporter, HttpEventReporter } from "./services/event-reporter"
import { startHarnessStatusReporter } from "./services/harness-status-reporter"
import { initializeAdoptionTracker, shutdownAdoptionTracker } from "./services/adoption-tracker"
import {
  startRegisteredGitHookEventSync,
  stopRegisteredGitHookEventSync
} from "./services/git-hook-service"
import { getAllThreads, initializeDatabase, flush } from "./db"
import { startScheduler, stopScheduler } from "./services/scheduler"
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat"
import { startChatX, stopChatX } from "./services/chatx"
import { startHookConfigWatcher, stopHookConfigWatcher } from "./services/hook-config-watcher"
import { LocalSandbox } from "./agent/local-sandbox"
import { closeRuntime } from "./agent/runtime"
import { makeBroadcastHookResultCallback } from "./hooks/result-callback"
import { fireSessionEndAll, hasActiveSessions } from "./hooks/session-lifecycle"
import { registerUpdaterHandlers, startUpdateChecker, stopUpdateChecker } from "./updater"
import { markFullBackupCleanupReady, runStartupSelfCheck } from "./updater/rollback"
import { startFeatureGatePrefetch, stopFeatureGatePrefetch } from "./feature-gates"
import { getOpenworkDir, isKeepAwakeEnabled, setKeepAwakeEnabled } from "./storage"
import { getLocalIP } from "./net-utils"
import { trackEvent } from "./services/event-reporter"
import {
  configurePetWindow,
  createPetWindow,
  getPetWindowDebugInfo,
  registerPetHandlers
} from "./pet"

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
const STARTUP_SANDBOX_PREWARM_WORKSPACE_LIMIT = 5

function cleanupLegacySkillEvalRecords(): void {
  const roots = new Set(
    [getOpenworkDir(), process.env.CMB_COWORK_AGENT_HOME?.trim()].filter(
      (value): value is string => Boolean(value)
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
    autoHideMenuBar: !['.166','.147','.216','.215','.225', '201.99'].some(ip => getLocalIP().includes(ip)) // 自动隐藏菜单栏
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
    applyMacDockIcon()
  })

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

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeRendererLog(getConsoleLevelName(level), message, { sourceId, line })
  })

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[Main] Renderer failed to load:", {
      errorCode,
      errorDescription,
      validatedURL
    })
  })

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Main] Renderer process gone:", details)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const version = app.getVersion()
    console.log('version---------------', version)
    console.log('getLocalIP', getLocalIP())
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('version', version)
      mainWindow.webContents.send('ip', getLocalIP())
    }
  })

  // HMR for renderer based on electron-vite cli
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    console.log('local render')
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
  } else {
    console.log('url render')
    // mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
    const renderUrl = import.meta.env.VITE_RENDER_URL
    if (!renderUrl) {
      mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
    }else{
      mainWindow.loadURL(renderUrl)
    }
  }

  mainWindow.on("close", () => {
    console.warn("[Main] Main window close requested", {
      pet: getPetWindowDebugInfo()
    })
  })

  mainWindow.on("closed", () => {
    console.warn("[Main] Main window closed", {
      platform: process.platform,
      pet: getPetWindowDebugInfo()
    })
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
      const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath.trim() : ""
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
    registerTaskCardHandlers(ipcMain)
    registerPetHandlers(ipcMain)
    registerUserInputHandlers(ipcMain)

    ipcMain.on(MAIN_LOG_TOGGLE_CHANNEL, (_event, enabled: unknown) => {
      mainLogForwardingEnabled = Boolean(enabled)
    })

    // Track event handler for client-side telemetry
    ipcMain.handle("track-event", async (_event, payload: any) => {
      try {
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

    createWindow()
    createPetWindow()

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()
    startChatX()
    startHookConfigWatcher()
    startUpdateChecker()
    startFeatureGatePrefetch(3000)
    markFullBackupCleanupReady(selfCheckResult)

    // ── Keep Awake ──
    applyKeepAwake(isKeepAwakeEnabled())

    ipcMain.handle("keepAwake:get", () => isKeepAwakeEnabled())
    ipcMain.handle("keepAwake:set", (_event, enabled: boolean) => {
      applyKeepAwake(enabled)
      setKeepAwakeEnabled(enabled)
    })

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
      }
      createPetWindow()
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
  app.on("before-quit", (event) => {
    console.warn("[Main] before-quit", {
      sessionEndDone,
      hasActiveSessions: hasActiveSessions(),
      pet: getPetWindowDebugInfo()
    })
    if (sessionEndDone) return
    if (!hasActiveSessions()) {
      sessionEndDone = true
      return
    }
    event.preventDefault()
    fireSessionEndAll(5000, (threadId) => makeBroadcastHookResultCallback(`agent:stream:${threadId}`))
      .catch((e) => console.warn("[Main] SessionEnd hooks error:", e))
      .finally(() => disposeAllAgentThreadStates())
      .finally(() => {
        sessionEndDone = true
        app.quit()
      })
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
    applyKeepAwake(false)
    disposeAllTerminals()
    LocalSandbox.killAll()
    stopScheduler()
    stopHeartbeat()
    stopChatX()
    stopAllHarnessWatchRefs()
    stopHookConfigWatcher()
    stopRegisteredGitHookEventSync()
    stopUpdateChecker()
    stopFeatureGatePrefetch()
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

    // Single-fire exit guard so timeout + finally don't both call app.exit
    let exited = false
    const doExit = (): void => {
      if (exited) return
      exited = true
      flush()
      app.exit(0)
    }

    // Give async cleanup up to 10s, then force quit
    const forceTimer = setTimeout(() => {
      console.warn("[Main] Cleanup timeout, force quitting")
      doExit()
    }, 10_000)

    cleanup.finally(() => {
      clearTimeout(forceTimer)
      doExit()
    })
  })
}
