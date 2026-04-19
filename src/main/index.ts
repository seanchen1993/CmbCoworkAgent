import { app, shell, BrowserWindow, ipcMain, nativeImage, powerSaveBlocker } from "electron"

// Fix Linux sandbox error: "The setuid sandbox is not running as root"
// On Linux the chrome-sandbox binary often lacks setuid permissions in packaged apps.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox")
}

import { existsSync } from "fs"
import { join } from "path"
import { writeMainLog, writeRendererLog } from "./logging"

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
import { registerAgentHandlers } from "./ipc/agent"
import { registerThreadHandlers } from "./ipc/threads"
import { registerModelHandlers } from "./ipc/models"
import { registerSkillsHandlers } from "./ipc/skills"
import { registerMcpHandlers } from "./ipc/mcp"
import { registerScheduledTaskHandlers } from "./ipc/scheduled-tasks"
import { registerHeartbeatHandlers } from "./ipc/heartbeat"
import { registerMemoryHandlers } from "./ipc/memory"
import { registerGitHandlers } from "./ipc/git"
import { registerPluginHandlers } from "./ipc/plugins"
import { registerSandboxHandlers } from "./ipc/sandbox"
import { registerOptimizerHandlers } from "./ipc/optimizer"
import { registerChatXHandlers } from "./ipc/chatx"
import { registerHooksHandlers } from "./ipc/hooks"
import { registerTerminalHandlers, disposeAllTerminals } from "./ipc/terminal"
import { registerCodeExecToolsHandlers } from "./ipc/code-exec-tools"
import { registerRoutingHandlers } from "./ipc/routing"
import { registerDashboardHandlers } from "./ipc/dashboard"
import { registerLspHandlers } from "./ipc/lsp"
import { stopAllLsp } from "./lsp"
import { setTraceReporter } from "./agent/trace/collector"
import { CloudTraceReporter } from "./agent/trace/cloud-reporter"
import { setEventReporter, HttpEventReporter } from "./services/event-reporter"
import { initializeDatabase, flush } from "./db"
import { startScheduler, stopScheduler } from "./services/scheduler"
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat"
import { startChatX, stopChatX } from "./services/chatx"
import { LocalSandbox } from "./agent/local-sandbox"
import { closeRuntime } from "./agent/runtime"
import { registerUpdaterHandlers, startUpdateChecker, stopUpdateChecker } from "./updater"
import { runStartupSelfCheck } from "./updater/rollback"
import { isKeepAwakeEnabled, setKeepAwakeEnabled } from "./storage"
import { getLocalIP } from "./net-utils"
import { trackEvent } from "./services/event-reporter"

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null

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

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

// Ensure only a single instance is running (prevents duplicate schedulers on Windows)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // Set app user model id for windows
    if (process.platform === "win32") {
      app.setAppUserModelId("CMBDevClaw")
    }

    // Set dock icon on macOS
    if (process.platform === "darwin" && app.dock) {
      const iconPath = getFirstExistingPath([
        ...(isDev ? [getDevMacDockIconPath()] : []),
        join(__dirname, "../../resources/icon.png"),
        join(app.getAppPath(), "resources/icon.png"),
        join(__dirname, "../resources/icon.png")
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
        // Icon not found, use default
      }
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

    // Register cloud trace reporter if trace base URL is configured
    const traceBaseUrl = import.meta.env.VITE_API_TRACE_BASE_URL as string | undefined
    if (traceBaseUrl) {
      setTraceReporter(new CloudTraceReporter(traceBaseUrl))
      console.log("[Main] CloudTraceReporter registered, uploading traces to:", traceBaseUrl)

      // Operational telemetry events (skill / git) share the same base URL.
      setEventReporter(new HttpEventReporter(traceBaseUrl))
      console.log("[Main] HttpEventReporter registered, sending events to:", traceBaseUrl)
    }

    // Initialize database
    await initializeDatabase()

    // Register IPC handlers
    registerAgentHandlers(ipcMain)
    registerThreadHandlers(ipcMain)
    registerModelHandlers(ipcMain)
    registerSkillsHandlers(ipcMain)
    registerMcpHandlers(ipcMain)
    registerScheduledTaskHandlers(ipcMain)
    registerHeartbeatHandlers(ipcMain)
    registerMemoryHandlers(ipcMain)
    registerGitHandlers()
    registerPluginHandlers(ipcMain)
    registerSandboxHandlers(ipcMain)
    registerOptimizerHandlers(ipcMain)
    registerChatXHandlers(ipcMain)
    registerHooksHandlers(ipcMain)
    registerTerminalHandlers(ipcMain)
    registerCodeExecToolsHandlers(ipcMain)
    registerRoutingHandlers(ipcMain)
    registerDashboardHandlers(ipcMain)
    registerUpdaterHandlers()
    registerLspHandlers(ipcMain)

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

    ipcMain.handle("open-folder", async (_, folderPath: string) => {
      try {
        await shell.openPath(folderPath)
        return { success: true }
      } catch (error) {
        console.error("Failed to open folder:", error)
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    })

    ipcMain.handle("show-item-in-folder", async (_, filePath: string) => {
      try {
        shell.showItemInFolder(filePath)
        return { success: true }
      } catch (error) {
        console.error("Failed to show item in folder:", error)
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    })

    ipcMain.handle("shell-show-item-in-folder", async (_, filePath: string) => {
      try {
        shell.showItemInFolder(filePath)
        return { success: true }
      } catch (error) {
        console.error("Failed to show item in folder:", error)
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
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

    createWindow()

    // Run post-update self-check before anything else
    const selfCheckResult = await runStartupSelfCheck()

    // Expose result to renderer — renderer polls this on mount to show update toast
    ipcMain.handle("update:get-startup-result", () => selfCheckResult)

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()
    startChatX()
    startUpdateChecker()

    // ── Keep Awake ──
    applyKeepAwake(isKeepAwakeEnabled())

    ipcMain.handle("keepAwake:get", () => isKeepAwakeEnabled())
    ipcMain.handle("keepAwake:set", (_event, enabled: boolean) => {
      applyKeepAwake(enabled)
      setKeepAwakeEnabled(enabled)
    })

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  let quitting = false
  app.on("will-quit", (e) => {
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
    stopUpdateChecker()

    const cleanup = Promise.all([
      stopAllLsp().catch((err) => console.warn("[Main] stopAllLsp error:", err)),
      closeRuntime().catch((err) => console.warn("[Main] closeRuntime error:", err))
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
