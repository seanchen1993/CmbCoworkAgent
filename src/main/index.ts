import { app, shell, BrowserWindow, ipcMain, nativeImage } from "electron"
import { join } from "path"
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
import { registerHooksHandlers } from "./ipc/hooks"
import { initializeDatabase, flush } from "./db"
import { startScheduler, stopScheduler } from "./services/scheduler"
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat"
import { LocalSandbox } from "./agent/local-sandbox"
import { closeRuntime } from "./agent/runtime"

let mainWindow: BrowserWindow | null = null

// Simple dev check - replaces @electron-toolkit/utils is.dev
const isDev = !app.isPackaged

function createWindow(): void {
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
    autoHideMenuBar: true // 自动隐藏菜单栏
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: "deny" }
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
      const iconPath = join(__dirname, "../../resources/icon.png")
      try {
        const icon = nativeImage.createFromPath(iconPath)
        if (!icon.isEmpty()) {
          app.dock.setIcon(icon)
        }
      } catch {
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
    registerHooksHandlers(ipcMain)

    // Register file system handlers
    ipcMain.handle("get-platform", async () => {
      return process.platform
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

    createWindow()

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()

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
    closeRuntime().catch((e) => console.warn("[Main] closeRuntime error:", e))
    flush()
  })
}
