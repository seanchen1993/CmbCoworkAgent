import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from "electron"
import { existsSync } from "fs"
import { join } from "path"
import {
  AppAttentionStore,
  isPersistentAppAttention,
  type AppAttentionKind,
  type AppAttentionPayload
} from "../shared/app-attention"

const BLINK_INTERVAL_MS = 500
const DEFAULT_TOOLTIP = "CMBDevClaw"

interface AppTrayOptions {
  getMainWindow: () => BrowserWindow | null
  showMainWindow: () => void
}

let tray: Tray | null = null
let normalIcon: NativeImage | null = null
let dimmedIcon: NativeImage | null = null
let blinkTimer: NodeJS.Timeout | null = null
let blinkDimmed = false
let attentionVisible = false
let appIsQuitting = false
let trayOptions: AppTrayOptions | null = null
const attentionStore = new AppAttentionStore()

export function getTrayIconFileName(platform: NodeJS.Platform): "icon.ico" | "icon.png" {
  return platform === "win32" ? "icon.ico" : "icon.png"
}

export function getTrayIconSize(platform: NodeJS.Platform): number {
  if (platform === "darwin") return 22
  if (platform === "win32") return 16
  return 24
}

export function shouldFlashTaskbar(platform: NodeJS.Platform): boolean {
  // macOS hides the Dock icon when the main window is closed to the menu bar.
  // Flashing the Dock there would undermine that behavior; the menu-bar icon
  // itself continues blinking on macOS.
  return platform !== "darwin"
}

export function shouldHideMainWindowOnClose(quitting: boolean, trayAvailable: boolean): boolean {
  return !quitting && trayAvailable
}

function getAttentionLabel(kind: AppAttentionKind): string {
  switch (kind) {
    case "approval":
      return "有操作等待审批"
    case "user-input":
      return "任务等待你的输入"
    case "task-complete":
      return "任务已完成"
    case "task-error":
      return "任务执行失败，等待处理"
    default:
      return "有新的交互等待处理"
  }
}

function getTrayIconPaths(): string[] {
  const fileName = getTrayIconFileName(process.platform)
  return [
    join(process.resourcesPath, "icons", fileName),
    join(app.getAppPath(), "build", fileName),
    join(process.cwd(), "build", fileName),
    join(__dirname, "../../build", fileName),
    join(__dirname, `../../resources/${fileName}`)
  ]
}

function normalizeTrayIcon(image: NativeImage): NativeImage {
  const size = getTrayIconSize(process.platform)
  const normalized = image.resize({ width: size, height: size, quality: "best" })
  if (process.platform === "darwin") {
    normalized.setTemplateImage(true)
  }
  return normalized
}

async function loadTrayIcon(): Promise<NativeImage> {
  for (const iconPath of getTrayIconPaths()) {
    if (!existsSync(iconPath)) continue
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) return normalizeTrayIcon(image)
  }

  try {
    const executableIcon = await app.getFileIcon(process.execPath, { size: "small" })
    if (!executableIcon.isEmpty()) return normalizeTrayIcon(executableIcon)
  } catch (error) {
    console.warn("[Tray] Failed to load executable icon:", error)
  }

  return nativeImage.createEmpty()
}

function createDimmedIcon(image: NativeImage): NativeImage {
  if (image.isEmpty()) return image
  const { width, height } = image.getSize()
  const bitmap = Buffer.from(image.toBitmap())
  for (let index = 3; index < bitmap.length; index += 4) {
    bitmap[index] = Math.min(bitmap[index], 40)
  }
  const dimmed = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })
  if (process.platform === "darwin") {
    dimmed.setTemplateImage(true)
  }
  return dimmed
}

function stopBlinking(): void {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = null
  }
  blinkDimmed = false
  if (tray && normalIcon && !normalIcon.isEmpty()) {
    tray.setImage(normalIcon)
  }
}

function startBlinking(): void {
  if (!tray || !normalIcon || normalIcon.isEmpty() || !dimmedIcon || blinkTimer) return
  blinkTimer = setInterval(() => {
    if (!tray || !normalIcon || !dimmedIcon) return
    blinkDimmed = !blinkDimmed
    tray.setImage(blinkDimmed ? dimmedIcon : normalIcon)
  }, BLINK_INTERVAL_MS)
}

function stopAttentionPresentation(): void {
  attentionVisible = false
  stopBlinking()
  tray?.setToolTip(DEFAULT_TOOLTIP)

  const window = trayOptions?.getMainWindow()
  if (window && !window.isDestroyed() && shouldFlashTaskbar(process.platform)) {
    window.flashFrame(false)
  }
}

function presentHighestPriorityAttention(): void {
  const payload = attentionStore.highestPriority()
  if (!payload) {
    stopAttentionPresentation()
    return
  }

  attentionVisible = true
  tray?.setToolTip(`${DEFAULT_TOOLTIP} - ${getAttentionLabel(payload.kind)}`)
  startBlinking()

  const window = trayOptions?.getMainWindow()
  if (window && !window.isDestroyed() && shouldFlashTaskbar(process.platform)) {
    window.flashFrame(true)
  }
}

export function clearAppAttention(): void {
  attentionStore.acknowledgeVisible()
  stopAttentionPresentation()
}

export function showPendingAppAttention(): void {
  if (appIsQuitting) return
  if (attentionStore.highestPriority()) {
    presentHighestPriorityAttention()
  }
}

export function requestAppAttention(payload: AppAttentionPayload): void {
  if (payload.action === "resolve") {
    if (payload.key) attentionStore.resolve(payload.key)
    if (appIsQuitting) {
      stopAttentionPresentation()
      return
    }
    if (attentionVisible) presentHighestPriorityAttention()
    return
  }

  if (appIsQuitting) return
  const window = trayOptions?.getMainWindow()
  const isForeground = window && !window.isDestroyed() && window.isVisible() && window.isFocused()
  if (isForeground) {
    if (isPersistentAppAttention(payload.kind)) attentionStore.raise(payload)
    return
  }
  attentionStore.raise(payload)
  presentHighestPriorityAttention()
}

export function isAppQuitting(): boolean {
  return appIsQuitting
}

export function isAppTrayAvailable(): boolean {
  return tray !== null
}

export function setAppQuitting(value: boolean): void {
  appIsQuitting = value
}

export async function initializeAppTray(options: AppTrayOptions): Promise<boolean> {
  trayOptions = options
  if (tray) return true

  try {
    normalIcon = await loadTrayIcon()
    if (normalIcon.isEmpty()) {
      console.warn("[Tray] No usable tray icon was found; tray initialization skipped")
      return false
    }
    dimmedIcon = createDimmedIcon(normalIcon)
    tray = new Tray(normalIcon)
    tray.setToolTip(DEFAULT_TOOLTIP)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "显示主窗口",
          click: () => {
            clearAppAttention()
            options.showMainWindow()
          }
        },
        { type: "separator" },
        {
          label: "退出",
          click: () => app.quit()
        }
      ])
    )

    const showWindow = (): void => {
      clearAppAttention()
      options.showMainWindow()
    }
    tray.on("click", showWindow)
    if (process.platform !== "linux") {
      tray.on("double-click", showWindow)
    }

    if (attentionVisible) presentHighestPriorityAttention()
    return true
  } catch (error) {
    console.error("[Tray] Failed to initialize system tray; using normal window close:", error)
    tray?.destroy()
    tray = null
    normalIcon = null
    dimmedIcon = null
    return false
  }
}

export function disposeAppTray(): void {
  stopAttentionPresentation()
  attentionStore.clear()
  tray?.destroy()
  tray = null
  normalIcon = null
  dimmedIcon = null
  trayOptions = null
}
