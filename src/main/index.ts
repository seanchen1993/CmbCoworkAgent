import { app, shell, BrowserWindow, ipcMain, nativeImage, powerSaveBlocker, screen } from "electron"

// Fix Linux sandbox error: "The setuid sandbox is not running as root"
// On Linux the chrome-sandbox binary often lacks setuid permissions in packaged apps.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox")
}

import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { writeMainLog, writeRendererLog } from "./logging"

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
import { registerAutoCommitHandlers } from "./ipc/auto-commit"
import { stopAllLsp } from "./lsp"
import { setTraceReporter } from "./agent/trace/collector"
import { CloudTraceReporter } from "./agent/trace/cloud-reporter"
import { setEventReporter, HttpEventReporter } from "./services/event-reporter"
import { initializeAdoptionTracker, shutdownAdoptionTracker } from "./services/adoption-tracker"
import { initializeDatabase, flush } from "./db"
import { startScheduler, stopScheduler } from "./services/scheduler"
import { startHeartbeat, stopHeartbeat } from "./services/heartbeat"
import { startChatX, stopChatX } from "./services/chatx"
import { startHookConfigWatcher, stopHookConfigWatcher } from "./services/hook-config-watcher"
import { LocalSandbox } from "./agent/local-sandbox"
import { closeRuntime } from "./agent/runtime"
import { makeBroadcastHookResultCallback } from "./hooks/result-callback"
import { fireSessionEndAll, hasActiveSessions } from "./hooks/session-lifecycle"
import { registerUpdaterHandlers, startUpdateChecker, stopUpdateChecker } from "./updater"
import { runStartupSelfCheck } from "./updater/rollback"
import { isKeepAwakeEnabled, setKeepAwakeEnabled } from "./storage"
import { getLocalIP } from "./net-utils"
import { trackEvent } from "./services/event-reporter"

let mainWindow: BrowserWindow | null = null
let loginWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let petGreetingWindow: BrowserWindow | null = null
let currentPetState: PetState = "idle"
let petMoveLastX: number | null = null
let petDragOffset: { x: number; y: number } | null = null
let petHoverPollTimer: NodeJS.Timeout | null = null
let petHovering = false

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

type PetManifest = {
  id: string
  name?: string
  displayName?: string
  description?: string
  spritesheetPath?: string
  frameWidth?: number
  frameHeight?: number
  columns?: number
  rows?: number
  states?: Record<string, { y: number; frames: number; fps?: number }>
}

type PetListItem = PetManifest & {
  directoryId: string
  spritesheetPath: string
}

// 宠物状态协议：系统态由 renderer 同步，交互态由宠物窗口自身或主进程临时覆盖。
type PetState =
  | "idle"
  | "busy"
  | "waiting"
  | "done"
  | "error"
  | "crying"
  | "prompt"
  | "running"
  | "interaction"
  | "hover"

const DEFAULT_PET_STATES: Record<PetState, { y: number; frames: number; fps: number }> = {
  // y 使用 spritesheet 的 0-based 行号；例如第 7 行对应 y: 6。
  idle: { y: 0, frames: 8, fps: 4 },
  busy: { y: 6, frames: 8, fps: 4 },
  waiting: { y: 0, frames: 8, fps: 4 },
  done: { y: 2, frames: 8, fps: 4 },
  error: { y: 3, frames: 8, fps: 4 },
  crying: { y: 5, frames: 8, fps: 4 },
  prompt: { y: 3, frames: 8, fps: 4 },
  running: { y: 1, frames: 8, fps: 10 },
  interaction: { y: 0, frames: 8, fps: 4 },
  hover: { y: 7, frames: 8, fps: 4 }
}

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

function getPetsRootPath(): string | undefined {
  // 开发态优先读仓库 pets/；打包后从 resourcesPath/pets 读取 extraResources。
  return getFirstExistingPath([
    join(process.cwd(), "pets"),
    join(process.resourcesPath, "pets"),
    join(app.getAppPath(), "pets"),
    join(__dirname, "../../pets"),
    join(__dirname, "../pets")
  ])
}

function getMimeType(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  return "image/png"
}

function readPetManifest(directoryId: string): PetListItem | null {
  const petsRoot = getPetsRootPath()
  if (!petsRoot) return null
  const petDir = join(petsRoot, directoryId)
  const manifestPath = join(petDir, "pet.json")
  try {
    const stats = statSync(petDir)
    if (!stats.isDirectory() || !existsSync(manifestPath)) return null
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as PetManifest
    const spritesheetPath = parsed.spritesheetPath || "spritesheet.webp"
    const spriteFullPath = join(petDir, spritesheetPath)
    if (!existsSync(spriteFullPath)) return null
    return {
      ...parsed,
      id: parsed.id || directoryId,
      directoryId,
      spritesheetPath
    }
  } catch (error) {
    console.warn(`[Pets] Failed to read pet ${directoryId}:`, error)
    return null
  }
}

function listPets(): PetListItem[] {
  const petsRoot = getPetsRootPath()
  if (!petsRoot) return []
  try {
    // 只展示第一个宠物；排序保证不同文件系统下“第一个”稳定。
    return readdirSync(petsRoot)
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => readPetManifest(entry))
      .filter((pet): pet is PetListItem => Boolean(pet))
  } catch (error) {
    console.warn("[Pets] Failed to list pets:", error)
    return []
  }
}

function readPetSpriteDataUrl(pet: PetListItem): string | null {
  const petsRoot = getPetsRootPath()
  if (!petsRoot) return null
  try {
    const spritePath = join(petsRoot, pet.directoryId, pet.spritesheetPath)
    const buffer = readFileSync(spritePath)
    // 宠物窗口使用 data URL 加载本地图片，避免在 sandbox 页面里暴露文件系统路径。
    return `data:${getMimeType(spritePath)};base64,${buffer.toString("base64")}`
  } catch (error) {
    console.warn(`[Pets] Failed to read sprite for ${pet.directoryId}:`, error)
    return null
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

  mainWindow.on("closed", () => {
    mainWindow = null
    if (process.platform !== "darwin") {
      app.quit()
    }
  })
}

function showMainWindowFromPet(): void {
  // 点击宠物时唤起主窗口：覆盖最小化、隐藏和主窗口被销毁后重建三种情况。
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  mainWindow.focus()
}

function createPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) return

  // 当前需求只展示第一个宠物；后续如果恢复切换，可在这里接入选择逻辑。
  const pet = listPets()[0]
  if (!pet) {
    console.warn("[Pets] No pet manifest found; pet window disabled")
    return
  }

  const spriteDataUrl = readPetSpriteDataUrl(pet)
  if (!spriteDataUrl) return

  // 宠物窗口只覆盖宠物本体大小，避免透明区域过大影响 hover/拖拽命中。
  const petWindowWidth = 112
  const petWindowHeight = 124
  const petWindowMargin = 100
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const initialX = Math.round(workArea.x + workArea.width - petWindowWidth - petWindowMargin)
  const initialY = Math.round(workArea.y + workArea.height - petWindowHeight - petWindowMargin)

  petWindow = new BrowserWindow({
    x: initialX,
    y: initialY,
    width: petWindowWidth,
    height: petWindowHeight,
    minWidth: 96,
    minHeight: 104,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    // macOS 下不要 skipTaskbar，否则开发态 Dock 图标可能被隐藏或重置。
    skipTaskbar: process.platform !== "darwin",
    show: false,
    // 隐藏状态下也允许首帧绘制，等 pet-ready 后再显示，避免透明窗口初始闪屏。
    paintWhenInitiallyHidden: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 宠物是独立桌面反馈窗口，即使主窗口后台/最小化也要保持动画刷新。
      backgroundThrottling: false
    }
  })

  petWindow.setBackgroundColor("#00000000")
  petWindow.setAlwaysOnTop(true, "floating")
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  applyMacDockIcon()

  const manifest = {
    ...pet,
    states: {
      // 资源 pet.json 可以覆盖默认帧配置；未声明的状态使用内置映射兜底。
      ...DEFAULT_PET_STATES,
      ...(pet.states ?? {})
    }
  }
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: rgba(0, 0, 0, 0);
      /* 手动拖拽替代 -webkit-app-region: drag，确保 click/hover/pointer 事件可用。 */
      cursor: grab;
      user-select: none;
    }
    body.dragging {
      cursor: grabbing;
    }
    body {
      display: grid;
      place-items: center;
      box-sizing: border-box;
    }
    canvas {
      width: 96px;
      height: 104px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0);
      image-rendering: pixelated;
      contain: strict;
      /* 根据拖拽方向翻转宠物，向左拖时朝左跑。 */
      transform: scaleX(var(--pet-facing, 1)) translateZ(0);
      backface-visibility: hidden;
    }
  </style>
</head>
<body>
  <canvas id="pet"></canvas>
  <script>
    const pet = ${JSON.stringify(manifest)};
    const spriteUrl = ${JSON.stringify(spriteDataUrl)};
    const canvas = document.getElementById("pet");
    const ctx = canvas.getContext("2d");
    const buffer = document.createElement("canvas");
    const bufferCtx = buffer.getContext("2d");
    const sprite = new Image();
    let currentState = ${JSON.stringify(currentPetState)};
    let systemState = currentState;
    let transientState = null;
    let transientTimer = 0;
    let frame = 0;
    let lastFrameAt = 0;
    let naturalWidth = 0;
    let naturalHeight = 0;
    let frameWidth = 0;
    let frameHeight = 0;
    let firstFramePainted = false;
    let pointerDown = false;
    let pointerMoved = false;
    let dragStartX = 0;
    let dragStartY = 0;
    // 记录每个精灵帧是否有有效像素，用于跳过透明占位帧，避免动画中途消失。
    const visibleFrameCache = new Map();

    window.setPetState = function setPetState(state) {
      if (!pet.states[state]) state = "idle";
      // systemState 表示业务系统态；hover/drag/click 等 transientState 结束后会回到它。
      systemState = state;
      if (transientState) return;
      applyState(state);
    };

    window.setPetTransientState = function setPetTransientState(state, durationMs, direction) {
      setFacing(direction);
      setTransientState(state, durationMs || 0);
    };

    window.clearPetTransientState = function clearPetTransientState(state) {
      clearTransientState(state);
    };

    function setFacing(direction) {
      if (direction === "left") {
        canvas.style.setProperty("--pet-facing", "-1");
      } else if (direction === "right") {
        canvas.style.setProperty("--pet-facing", "1");
      }
    }

    function setTransientState(state, durationMs) {
      if (!pet.states[state]) state = "idle";
      if (transientTimer) window.clearTimeout(transientTimer);
      // 临时交互态优先级高于系统态，例如拖拽时临时播放 running。
      transientState = state;
      applyState(state);
      if (durationMs > 0) {
        transientTimer = window.setTimeout(function clearTransientState() {
          transientState = null;
          transientTimer = 0;
          applyState(systemState);
        }, durationMs);
      }
    }

    function clearTransientState(state) {
      if (state && transientState !== state) return;
      if (transientTimer) window.clearTimeout(transientTimer);
      transientState = null;
      transientTimer = 0;
      applyState(systemState);
    }

    function applyState(state) {
      if (!pet.states[state]) state = "idle";
      if (currentState === state) return;
      // 切换状态时直接落到可见帧，避免状态首帧是透明占位导致闪空。
      currentState = state;
      frame = findVisibleFrame(pet.states[currentState] || pet.states.idle, frame);
      lastFrameAt = 0;
      renderFrame();
    }

    window.addEventListener("pointerenter", function onPointerEnter() {
      if (transientState === "running" || transientState === "interaction") return;
      setTransientState("hover", 0);
    });
    window.addEventListener("pointerleave", function onPointerLeave() {
      clearTransientState("hover");
    });
    window.addEventListener("pointerdown", function onPointerDown(event) {
      pointerDown = true;
      pointerMoved = false;
      dragStartX = event.screenX;
      dragStartY = event.screenY;
      document.body.classList.add("dragging");
      // 使用 document.title 作为 sandbox 页面到主进程的轻量事件通道。
      document.title = "pet-pointer-down:" + event.screenX + ":" + event.screenY + ":" + Date.now();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Best effort only.
      }
      setTransientState("running", 0);
    });
    window.addEventListener("pointermove", function onPointerMove(event) {
      if (!pointerDown) return;
      const dx = event.screenX - dragStartX;
      const dy = event.screenY - dragStartY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        pointerMoved = true;
        document.title = "pet-drag:" + event.screenX + ":" + event.screenY + ":" + Date.now();
      }
    });
    window.addEventListener("pointerup", function onPointerUp(event) {
      pointerDown = false;
      document.body.classList.remove("dragging");
      document.title = "pet-pointer-up:" + Date.now();
      clearTransientState("running");
      if (!pointerMoved) {
        setTransientState("interaction", 900);
        document.title = "pet-click:" + Date.now();
      }
    });

    sprite.onload = function onSpriteLoad() {
      naturalWidth = sprite.naturalWidth;
      naturalHeight = sprite.naturalHeight;
      const columns = pet.columns || 8;
      const rows = pet.rows || 9;
      frameWidth = pet.frameWidth || Math.floor(naturalWidth / columns);
      frameHeight = pet.frameHeight || Math.floor(naturalHeight / rows);
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      buffer.width = frameWidth;
      buffer.height = frameHeight;
      ctx.imageSmoothingEnabled = false;
      bufferCtx.imageSmoothingEnabled = false;
      frame = findVisibleFrame(pet.states[currentState] || pet.states.idle, 0);
      renderFrame();
      requestAnimationFrame(draw);
    };
    sprite.src = spriteUrl;

    function getFrameCacheKey(state, frameIndex) {
      return state.y + ":" + frameIndex;
    }

    function frameHasPixels(state, frameIndex) {
      if (!frameWidth || !frameHeight) return false;
      const sx = frameIndex * frameWidth;
      const sy = state.y * frameHeight;
      if (sx < 0 || sy < 0 || sx + frameWidth > naturalWidth || sy + frameHeight > naturalHeight) {
        return false;
      }

      const cacheKey = getFrameCacheKey(state, frameIndex);
      if (visibleFrameCache.has(cacheKey)) return visibleFrameCache.get(cacheKey);

      // 用离屏 buffer 读取 alpha，判断当前精灵格是否是透明占位帧。
      bufferCtx.clearRect(0, 0, frameWidth, frameHeight);
      bufferCtx.drawImage(sprite, sx, sy, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
      const data = bufferCtx.getImageData(0, 0, frameWidth, frameHeight).data;
      let visiblePixels = 0;
      for (let i = 3; i < data.length; i += 16) {
        if (data[i] > 8) {
          visiblePixels += 1;
          if (visiblePixels > 16) {
            visibleFrameCache.set(cacheKey, true);
            return true;
          }
        }
      }
      visibleFrameCache.set(cacheKey, false);
      return false;
    }

    function findVisibleFrame(state, startFrame) {
      const totalFrames = Math.max(1, Math.min(state.frames || 1, pet.columns || 8));
      for (let offset = 0; offset < totalFrames; offset += 1) {
        const candidate = (startFrame + offset) % totalFrames;
        if (frameHasPixels(state, candidate)) return candidate;
      }
      return startFrame % totalFrames;
    }

    function renderFrame() {
      const state = pet.states[currentState] || pet.states.idle;
      frame = findVisibleFrame(state, frame);
      if (!frameHasPixels(state, frame)) return;
      // 先绘制到离屏 buffer，再用 copy 一次性提交到可见 canvas，减少透明窗口闪屏。
      bufferCtx.clearRect(0, 0, frameWidth, frameHeight);
      bufferCtx.drawImage(
        sprite,
        frame * frameWidth,
        state.y * frameHeight,
        frameWidth,
        frameHeight,
        0,
        0,
        frameWidth,
        frameHeight
      );
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(buffer, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (!firstFramePainted) {
        firstFramePainted = true;
        // 第一帧实际绘制完成后再通知主进程显示窗口。
        document.title = "pet-ready";
      }
    }

    function draw(timestamp) {
      const state = pet.states[currentState] || pet.states.idle;
      const fps = state.fps || 8;
      const frameDuration = 1000 / fps;
      if (!lastFrameAt || timestamp - lastFrameAt >= frameDuration) {
        renderFrame();
        frame = findVisibleFrame(state, frame + 1);
        lastFrameAt = timestamp;
      }
      requestAnimationFrame(draw);
    }
  </script>
</body>
</html>`

  const showPetWindow = (): void => {
    if (petWindow && !petWindow.isDestroyed() && !petWindow.isVisible()) {
      petWindow.showInactive()
    }
  }
  petWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  petWindow.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault()
    // 宠物窗口启用 sandbox，不能直接访问 Electron API；统一通过 title 事件转发交互。
    if (title === "pet-ready") {
      showPetWindow()
      showPetGreeting()
    } else if (title.startsWith("pet-click:")) {
      showMainWindowFromPet()
    } else if (title.startsWith("pet-pointer-down:")) {
      const [, rawX, rawY] = title.split(":")
      const pointerX = Number(rawX)
      const pointerY = Number(rawY)
      if (petWindow && Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
        const bounds = petWindow.getBounds()
        // 记录鼠标在宠物窗口内的偏移，后续拖拽时保持鼠标抓取点不跳动。
        petDragOffset = { x: pointerX - bounds.x, y: pointerY - bounds.y }
      }
    } else if (title.startsWith("pet-drag:")) {
      const [, rawX, rawY] = title.split(":")
      const pointerX = Number(rawX)
      const pointerY = Number(rawY)
      if (petWindow && petDragOffset && Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
        petWindow.setPosition(
          Math.round(pointerX - petDragOffset.x),
          Math.round(pointerY - petDragOffset.y),
          false
        )
      }
    } else if (title.startsWith("pet-pointer-up:")) {
      petDragOffset = null
    }
  })
  petWindow.on("move", () => {
    if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
    const [x] = petWindow.getPosition()
    const direction = petMoveLastX === null || x >= petMoveLastX ? "right" : "left"
    petMoveLastX = x
    // 真实窗口移动时触发奔跑动画，覆盖系统原生/手动拖拽两种移动来源。
    petWindow.webContents
      .executeJavaScript(
        `window.setPetTransientState("running", 350, ${JSON.stringify(direction)})`
      )
      .catch((error) => console.warn("[Pets] Failed to update drag state:", error))
  })
  startPetHoverPolling()
  petWindow.on("closed", () => {
    stopPetHoverPolling()
    closePetGreeting()
    petWindow = null
    petMoveLastX = null
    petDragOffset = null
    petHovering = false
  })
}

function showPetGreeting(): void {
  closePetGreeting()
  if (!petWindow || petWindow.isDestroyed()) return

  const pet = listPets()[0]
  // 问候文案中的名称来自宠物配置，避免写死“皮皮”。
  const petName = pet?.displayName || pet?.name || pet?.id || "皮皮"
  const petBounds = petWindow.getBounds()
  const greetingWidth = 238
  const greetingHeight = 72
  const gap = 10
  const x = Math.max(0, petBounds.x - greetingWidth + 10)
  const y = Math.max(0, petBounds.y + 16)

  petGreetingWindow = new BrowserWindow({
    x,
    y,
    width: greetingWidth,
    height: greetingHeight,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    // 气泡是提示窗口，不应抢占焦点或出现在任务栏/Dock 中。
    skipTaskbar: process.platform !== "darwin",
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 问候气泡不参与交互，鼠标事件继续落到宠物窗口或桌面。
  petGreetingWindow.setIgnoreMouseEvents(true)
  petGreetingWindow.setBackgroundColor("#00000000")
  petGreetingWindow.setAlwaysOnTop(true, "floating")
  petGreetingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: rgba(0, 0, 0, 0);
      user-select: none;
    }
    body {
      box-sizing: border-box;
      padding: 8px ${gap}px 8px 8px;
    }
    .bubble {
      position: relative;
      box-sizing: border-box;
      display: inline-block;
      max-width: 210px;
      padding: 8px 10px;
      border: 1px solid rgba(196, 149, 106, 0.45);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      color: #292524;
      font: 500 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 10px 24px rgba(41, 37, 36, 0.15);
      opacity: 0;
      transform: translateY(4px) scale(0.98);
      transition: opacity 220ms ease, transform 220ms ease;
    }
    .bubble::after {
      content: "";
      position: absolute;
      right: -6px;
      bottom: 12px;
      width: 10px;
      height: 10px;
      border-right: 1px solid rgba(196, 149, 106, 0.45);
      border-bottom: 1px solid rgba(196, 149, 106, 0.45);
      background: rgba(255, 255, 255, 0.96);
      transform: rotate(-45deg);
    }
    .bubble.show {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  </style>
</head>
<body>
  <div id="bubble" class="bubble">Hi～我是你的Claw宠物，我叫${petName}～</div>
  <script>
    const bubble = document.getElementById("bubble");
    requestAnimationFrame(function show() {
      bubble.classList.add("show");
      window.setTimeout(function hide() {
        bubble.classList.remove("show");
        window.setTimeout(function closeBubble() {
          // 通知主进程关闭独立气泡窗口。
          document.title = "greeting-done";
        }, 260);
      }, 4200);
    });
  </script>
</body>
</html>`

  petGreetingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  petGreetingWindow.once("ready-to-show", () => {
    petGreetingWindow?.showInactive()
  })
  petGreetingWindow.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault()
    if (title === "greeting-done") closePetGreeting()
  })
  petGreetingWindow.on("closed", () => {
    petGreetingWindow = null
  })
}

function closePetGreeting(): void {
  // 统一关闭入口：宠物销毁、气泡结束、重新显示问候前都会走这里。
  if (petGreetingWindow && !petGreetingWindow.isDestroyed()) {
    petGreetingWindow.close()
  }
  petGreetingWindow = null
}

function startPetHoverPolling(): void {
  stopPetHoverPolling()
  petHoverPollTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const bounds = petWindow.getBounds()
    // 宠物窗口范围已经收窄为本体大小，这里用屏幕坐标判断 hover 更可靠。
    const isHovering =
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height

    if (isHovering === petHovering) return
    petHovering = isHovering
    const script = isHovering
      ? 'window.setPetTransientState("hover", 0)'
      : 'window.clearPetTransientState("hover")'
    petWindow.webContents
      .executeJavaScript(script)
      .catch((error) => console.warn("[Pets] Failed to update hover state:", error))
  }, 120)
}

function stopPetHoverPolling(): void {
  // 防止宠物窗口销毁后定时器继续访问已释放的 webContents。
  if (petHoverPollTimer) {
    clearInterval(petHoverPollTimer)
    petHoverPollTimer = null
  }
}

function updatePetWindowState(state: PetState): void {
  // renderer 只负责发送业务状态；真正动画渲染在独立宠物窗口里执行。
  currentPetState = state
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow()
    return
  }
  petWindow.webContents
    .executeJavaScript(`window.setPetState(${JSON.stringify(state)})`)
    .catch((error) => console.warn("[Pets] Failed to update pet state:", error))
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
    applyMacDockIcon()

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

    // Initialize adoption tracker (side-effect only; never blocks startup)
    try {
      await initializeAdoptionTracker()
    } catch (err) {
      console.warn("[Main] AdoptionTracker init failed (disabled):", err)
    }

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
    registerAutoCommitHandlers(ipcMain)

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

    ipcMain.handle("pet:list", async () => {
      return listPets()
    })

    ipcMain.handle("pet:getSpriteDataUrl", async (_event, directoryId: string) => {
      const pet = readPetManifest(directoryId)
      if (!pet) {
        return { success: false, error: "Pet not found" }
      }
      const dataUrl = readPetSpriteDataUrl(pet)
      if (!dataUrl) return { success: false, error: "Failed to load pet sprite" }
      return { success: true, dataUrl }
    })

    ipcMain.on("pet:setState", (_event, state: PetState) => {
      if (
        ![
          "idle",
          "busy",
          "waiting",
          "done",
          "error",
          "crying",
          "prompt",
          "running",
          "interaction",
          "hover"
        ].includes(state)
      ) {
        return
      }
      updatePetWindowState(state)
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
    createPetWindow()

    // Run post-update self-check before anything else
    const selfCheckResult = await runStartupSelfCheck()

    // Expose result to renderer — renderer polls this on mount to show update toast
    ipcMain.handle("update:get-startup-result", () => selfCheckResult)

    // Start scheduled task scheduler and heartbeat service
    startScheduler()
    startHeartbeat()
    startChatX()
    startHookConfigWatcher()
    startUpdateChecker()

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
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Use before-quit (not will-quit) so we can preventDefault, await SessionEnd hooks,
  // then re-issue app.quit(). will-quit fires during teardown — async hook spawns
  // queued there have no guarantee of completing before the process exits.
  let sessionEndDone = false
  app.on("before-quit", (event) => {
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
    stopHookConfigWatcher()
    stopUpdateChecker()
    try {
      shutdownAdoptionTracker()
    } catch (err) {
      console.warn("[Main] shutdownAdoptionTracker error:", err)
    }

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
