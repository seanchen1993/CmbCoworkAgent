import { app, shell, BrowserWindow, ipcMain, nativeImage } from "electron"
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
import { registerCodeIndexHandlers } from "./ipc/code-index"
import { registerSandboxHandlers } from "./ipc/sandbox"
import { registerOptimizerHandlers } from "./ipc/optimizer"
import { registerChatXHandlers } from "./ipc/chatx"
import { registerHooksHandlers } from "./ipc/hooks"
import { setTraceReporter } from "./agent/trace/collector"
import { S3TraceReporter } from "./agent/trace/s3-reporter"
import { initializeDatabase, flush } from "./db"
import { startScheduler, stopScheduler } from "./services/scheduler"
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat"
import { startChatX, stopChatX } from "./services/chatx"
import { LocalSandbox } from "./agent/local-sandbox"
import { getCodeIndexSettings } from "./storage"
import { startIndexingForRecentWorkspaces } from "./code-index/manager"
import { closeRuntime } from "./agent/runtime"
import  os from "os";

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null

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

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let localIP = '';

  // 遍历所有网卡
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 过滤掉 IPv6、回环地址（127.0.0.1）、内部地址
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        // 如果你有多个网卡（比如同时连WiFi和网线），可以根据需求选择第一个/指定网卡的IP
        break;
      }
    }
    if (localIP) break;
  }

  return localIP || '127.0.0.1';
}

function createWindow(): void {
  const devWindowIcon = process.platform === "win32" && isDev ? getDevWindowsIconPath() : undefined

  mainWindow = new BrowserWindow({
    width: 1440,
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
    autoHideMenuBar: true // 自动隐藏菜单栏
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

    // Register S3 trace reporter if API base URL is configured
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
    if (apiBaseUrl) {
      setTraceReporter(new S3TraceReporter(apiBaseUrl))
      console.log("[Main] S3TraceReporter registered, uploading traces to:", apiBaseUrl)
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
    registerCodeIndexHandlers()
    registerSandboxHandlers(ipcMain)
    registerOptimizerHandlers(ipcMain)
    registerChatXHandlers(ipcMain)
    registerHooksHandlers(ipcMain)

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

    createWindow()

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()
    startChatX()

    // Start code indexing for recently active workspaces in background
    startIndexingForRecentWorkspaces(getCodeIndexSettings())
      .catch((e) => console.warn("[CodeIndex] startup init failed:", e))

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

  app.on("will-quit", () => {
    LocalSandbox.killAll()
    stopScheduler()
    stopHeartbeat()
    stopChatX()
    closeRuntime().catch((e) => console.warn("[Main] closeRuntime error:", e))
    flush()
  })
}
