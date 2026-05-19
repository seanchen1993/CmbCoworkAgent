import { app, BrowserWindow, dialog, type IpcMain, screen } from "electron"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { mkdir, rm } from "fs/promises"
import { basename, join, relative } from "path"
import { pathToFileURL } from "url"
import { getOpenworkDir } from "./storage"
import { copyDirRecursive } from "./utils/fs"

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
  source: PetSource
  key: string
  canDelete: boolean
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

type PetWindowOptions = {
  ensureMainWindowVisible: () => BrowserWindow | null
  applyMacDockIcon: () => void
}

type PetSource = "builtin" | "custom"

type PetSettings = {
  enabled: boolean
  selectedPetKey: string | null
}

const PET_STATES: PetState[] = [
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
]

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

let petWindow: BrowserWindow | null = null
let petBubbleWindow: BrowserWindow | null = null
let currentPetState: PetState = "idle"
let petMoveLastX: number | null = null
let petDragOffset: { x: number; y: number } | null = null
let petHoverPollTimer: NodeJS.Timeout | null = null
let petHovering = false
let petWindowOptions: PetWindowOptions | null = null
const completedTaskNotices: Array<{ id: string; threadId: string; title: string }> = []
let petBubbleHideTimer: NodeJS.Timeout | null = null
let suppressPetClickUntil = 0

const PET_SETTINGS_FILE = join(getOpenworkDir(), "pet-settings.json")
const PET_BUBBLE_AUTO_HIDE_MS = 4200
const PET_ALWAYS_ON_TOP_LEVEL = "screen-saver"
const PET_HOVER_MESSAGES = [
  "我会永远陪着你",
  "主人敲代码的样子会发光！",
  "今天也要和 bug 温柔过招～",
  "你负责创造世界，我负责给你加油！",
  "编译慢慢来，主人已经很棒啦",
  "灵感在路上，我先抱住它！",
  "主人一出手，需求都乖乖排队～",
  "你的每一行代码都有魔法",
  "累了就摸摸我，能量补满！",
  "我在旁边守着你的终端哦",
  "小小宠物，大大偏爱主人",
  "主人的脑袋瓜今天也超会想！",
  "别怕报错，我陪你一起看",
  "代码会跑起来，星星也会亮起来",
  "主人是最可靠的 developer！",
  "我把好运都蹭到你的分支上啦",
  "饿龙咆哮～"
]
const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  selectedPetKey: null
}

export function configurePetWindow(options: PetWindowOptions): void {
  petWindowOptions = options
}

/**
 * 透明宠物窗口不在 renderer DOM 里，z-index 不参与排序；这里统一刷新原生窗口层级。
 *
 * macOS 上 hidden -> showInactive、主窗口重新 focus、气泡窗口重建时，floating 层级偶发会被后续窗口压住。
 * screen-saver 是 Electron 暴露的更高层级，配合 moveTop() 可以把宠物稳定留在最上层。
 */
function keepPetWindowOnTop(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setAlwaysOnTop(true, PET_ALWAYS_ON_TOP_LEVEL)
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.moveTop()
}

/**
 * 通过宠物交互唤起主窗口。
 *
 * 具体的窗口创建/恢复能力由主进程入口传入，宠物模块只负责在需要时触发该能力。
 */
function showMainWindowFromPet(): BrowserWindow | null {
  const mainWindow = petWindowOptions?.ensureMainWindowVisible() ?? null
  clearPetCompletedTaskNotices()
  keepPetWindowOnTop(petWindow)
  keepPetWindowOnTop(petBubbleWindow)
  return mainWindow
}

export function registerPetHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("pet:list", async () => {
    return listPets()
  })

  ipcMain.handle(
    "pet:getSpriteDataUrl",
    async (_event, directoryId: string, source?: PetSource) => {
      const pet = readPetManifest(directoryId, source ?? "builtin")
      if (!pet) {
        return { success: false, error: "Pet not found" }
      }
      const dataUrl = readPetSpriteDataUrl(pet)
      if (!dataUrl) return { success: false, error: "Failed to load pet sprite" }
      return { success: true, dataUrl }
    }
  )

  ipcMain.on("pet:setState", (_event, state: unknown) => {
    if (!isPetState(state)) return
    updatePetWindowState(state)
  })

  ipcMain.on("pet:clearCompletedTasks", () => {
    clearPetCompletedTaskNotices()
  })

  ipcMain.handle("pet:getSettings", async () => {
    return readPetSettings()
  })

  ipcMain.handle("pet:updateSettings", async (_event, settings: Partial<PetSettings>) => {
    const updated = writePetSettings(settings)
    refreshPetWindowForSettings()
    return updated
  })

  ipcMain.handle("pet:uploadCustomFolder", async () => {
    return uploadCustomPetFolder()
  })

  ipcMain.handle("pet:deleteCustom", async (_event, directoryId: string) => {
    return deleteCustomPet(directoryId)
  })
}

function isPetState(state: unknown): state is PetState {
  return typeof state === "string" && PET_STATES.includes(state as PetState)
}

function getFirstExistingPath(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path))
}

function getBuiltinPetsRootPath(): string | undefined {
  // 开发态优先读仓库 pets/；打包后从 resourcesPath/pets 读取 extraResources。
  return getFirstExistingPath([
    join(process.cwd(), "pets"),
    join(process.resourcesPath, "pets"),
    join(app.getAppPath(), "pets"),
    join(__dirname, "../../pets"),
    join(__dirname, "../pets")
  ])
}

function getCustomPetsRootPath(): string {
  return join(getOpenworkDir(), "pets")
}

function getPetsRootPath(source: PetSource): string | undefined {
  if (source === "custom") return getCustomPetsRootPath()
  return getBuiltinPetsRootPath()
}

function makePetKey(source: PetSource, directoryId: string): string {
  return `${source}:${directoryId}`
}

function getMimeType(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  return "image/png"
}

function readPetSettings(): PetSettings {
  try {
    if (!existsSync(PET_SETTINGS_FILE)) return { ...DEFAULT_PET_SETTINGS }
    const parsed = JSON.parse(readFileSync(PET_SETTINGS_FILE, "utf8")) as Partial<PetSettings>
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PET_SETTINGS.enabled,
      selectedPetKey:
        typeof parsed.selectedPetKey === "string" && parsed.selectedPetKey
          ? parsed.selectedPetKey
          : null
    }
  } catch (error) {
    console.warn("[Pets] Failed to read pet settings:", error)
    return { ...DEFAULT_PET_SETTINGS }
  }
}

function writePetSettings(settings: Partial<PetSettings>): PetSettings {
  const current = readPetSettings()
  const next: PetSettings = {
    enabled: typeof settings.enabled === "boolean" ? settings.enabled : current.enabled,
    selectedPetKey:
      settings.selectedPetKey === null || typeof settings.selectedPetKey === "string"
        ? settings.selectedPetKey
        : current.selectedPetKey
  }
  writeFileSync(PET_SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8")
  return next
}

function readPetManifest(directoryId: string, source: PetSource): PetListItem | null {
  const petsRoot = getPetsRootPath(source)
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
      spritesheetPath,
      source,
      key: makePetKey(source, directoryId),
      canDelete: source === "custom"
    }
  } catch (error) {
    console.warn(`[Pets] Failed to read pet ${directoryId}:`, error)
    return null
  }
}

function listPetsFromSource(source: PetSource): PetListItem[] {
  const petsRoot = getPetsRootPath(source)
  if (!petsRoot) return []
  if (!existsSync(petsRoot)) return []
  try {
    // 只展示第一个宠物；排序保证不同文件系统下“第一个”稳定。
    return readdirSync(petsRoot)
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => readPetManifest(entry, source))
      .filter((pet): pet is PetListItem => Boolean(pet))
  } catch (error) {
    console.warn(`[Pets] Failed to list ${source} pets:`, error)
    return []
  }
}

function listPets(): PetListItem[] {
  return [...listPetsFromSource("builtin"), ...listPetsFromSource("custom")]
}

function readPetSpriteDataUrl(pet: PetListItem): string | null {
  const spritePath = getPetSpritePath(pet)
  if (!spritePath) return null
  try {
    const buffer = readFileSync(spritePath)
    // 宠物窗口使用 data URL 加载本地图片，避免在 sandbox 页面里暴露文件系统路径。
    return `data:${getMimeType(spritePath)};base64,${buffer.toString("base64")}`
  } catch (error) {
    console.warn(`[Pets] Failed to read sprite for ${pet.directoryId}:`, error)
    return null
  }
}

function getPetSpritePath(pet: PetListItem): string | null {
  const petsRoot = getPetsRootPath(pet.source)
  if (!petsRoot) return null
  return join(petsRoot, pet.directoryId, pet.spritesheetPath)
}

function getPetWindowHtmlPath(): string {
  return join(app.getPath("temp"), "cmbcoworkagent-pet-window.html")
}

function getSelectedPet(): PetListItem | null {
  const pets = listPets()
  const settings = readPetSettings()
  const selectedPet = settings.selectedPetKey
    ? pets.find((pet) => pet.key === settings.selectedPetKey)
    : null
  return selectedPet ?? pets[0] ?? null
}

function closePetWindow(): void {
  stopPetHoverPolling()
  closePetBubble()
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  petWindowOptions?.applyMacDockIcon()
  petWindow = null
  petMoveLastX = null
  petDragOffset = null
  petHovering = false
}

function refreshPetWindowForSettings(): void {
  closePetWindow()
  if (readPetSettings().enabled) {
    setImmediate(() => {
      createPetWindow()
      petWindowOptions?.applyMacDockIcon()
    })
  }
}

function getSafeCustomPetPath(directoryId: string): string | null {
  if (!directoryId || directoryId.includes("/") || directoryId.includes("\\")) return null
  const customRoot = getCustomPetsRootPath()
  const petPath = join(customRoot, directoryId)
  const rel = relative(customRoot, petPath)
  if (rel.startsWith("..") || rel === "" || rel.includes("..")) return null
  return petPath
}

function uniqueDirectoryId(root: string, preferredName: string): string {
  const baseName = preferredName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "pet"
  let candidate = baseName
  let index = 2
  while (existsSync(join(root, candidate))) {
    candidate = `${baseName}-${index}`
    index += 1
  }
  return candidate
}

async function uploadCustomPetFolder(): Promise<{
  success: boolean
  pet?: PetListItem
  error?: string
}> {
  const result = await dialog.showOpenDialog({
    title: "选择宠物文件夹",
    properties: ["openDirectory"]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: "已取消选择" }
  }

  const sourceDir = result.filePaths[0]
  const manifestPath = join(sourceDir, "pet.json")
  if (!existsSync(manifestPath)) {
    return { success: false, error: "所选文件夹中未找到 pet.json" }
  }

  const customRoot = getCustomPetsRootPath()
  await mkdir(customRoot, { recursive: true })
  const directoryId = uniqueDirectoryId(customRoot, basename(sourceDir))
  const destination = join(customRoot, directoryId)

  try {
    await copyDirRecursive(sourceDir, destination)
    const pet = readPetManifest(directoryId, "custom")
    if (!pet) {
      await rm(destination, { recursive: true, force: true })
      return { success: false, error: "宠物资源不完整，请参考内置 pets 目录结构" }
    }
    return { success: true, pet }
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    return {
      success: false,
      error: error instanceof Error ? error.message : "上传失败"
    }
  }
}

async function deleteCustomPet(directoryId: string): Promise<{ success: boolean; error?: string }> {
  const petPath = getSafeCustomPetPath(directoryId)
  if (!petPath) return { success: false, error: "Invalid pet directory" }

  try {
    await rm(petPath, { recursive: true, force: true })
    const settings = readPetSettings()
    if (settings.selectedPetKey === makePetKey("custom", directoryId)) {
      writePetSettings({ selectedPetKey: null })
      refreshPetWindowForSettings()
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "删除失败"
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * 规范化完成任务气泡中的任务标题。
 *
 * 气泡空间有限，这里会去掉多余空白，并把过长标题截断，避免桌面悬浮窗文本溢出。
 */
function trimTaskTitle(title: string): string {
  const text = title.replace(/\s+/g, " ").trim()
  if (!text) return "任务"
  return text.length > 18 ? `${text.slice(0, 18)}...` : text
}

/**
 * 将待处理任务数量同步到宠物窗口右上角数字 tag。
 *
 * tag 在宠物窗口内部渲染，任务数为 0 时隐藏，避免额外创建独立悬浮窗。
 */
function updatePetTaskTag(): void {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
  petWindow.webContents
    .executeJavaScript(`window.setPetTaskCount(${completedTaskNotices.length})`)
    .catch((error) => console.warn("[Pets] Failed to update task tag:", error))
}

/**
 * 清空所有已完成任务提醒。
 *
 * 用户打开主应用后，不再逐个按线程扣减，而是直接认为完成提醒已被查看并清空气泡队列。
 */
function clearPetCompletedTaskNotices(): void {
  if (completedTaskNotices.length === 0) return
  completedTaskNotices.splice(0, completedTaskNotices.length)
  updatePetTaskTag()
  closePetBubble()
}

/**
 * 记录一个后台完成的任务，并让宠物右上角展示完成数量 tag。
 *
 * 仅在应用窗口不处于焦点、且宠物窗口已经存在时生效；不会为了完成提醒主动创建宠物窗口。
 */
export function showPetCompletedTaskNotice(threadId: string, title: string): void {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (focusedWindow?.isFocused()) return
  if (!petWindow || petWindow.isDestroyed()) return
  if (!readPetSettings().enabled) return

  const taskTitle = trimTaskTitle(title)
  completedTaskNotices.push({
    id: `${threadId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    threadId,
    title: taskTitle
  })

  updatePetTaskTag()
  showPetTaskBubble()
}

export function createPetWindow(): void {
  if (!readPetSettings().enabled) return
  if (petWindow && !petWindow.isDestroyed()) return

  const pet = getSelectedPet()
  if (!pet) {
    console.warn("[Pets] No pet manifest found; pet window disabled")
    return
  }

  const spritePath = getPetSpritePath(pet)
  if (!spritePath) return

  // 宠物窗口只覆盖宠物本体大小，避免透明区域过大影响 hover/拖拽命中。
  const petWindowWidth = 112
  const petWindowHeight = 124
  const petWindowMargin = 150
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
    // 宠物是辅助窗口，不参与任务栏/Dock；主应用 Dock 图标由 applyMacDockIcon 维护。
    skipTaskbar: true,
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
  keepPetWindowOnTop(petWindow)
  petWindowOptions?.applyMacDockIcon()

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
      position: relative;
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
    #taskTag {
      position: absolute;
      right: 8px;
      top: 6px;
      z-index: 2;
      display: none;
      min-width: 20px;
      height: 20px;
      box-sizing: border-box;
      padding: 0 6px;
      border: 1px solid rgba(239, 68, 68, 0.28);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.96);
      color: #dc2626;
      font: 700 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
      cursor: pointer;
      box-shadow: 0 5px 12px rgba(41, 37, 36, 0.18);
    }
    #taskTag.show {
      display: block;
    }
  </style>
</head>
<body>
  <div id="taskTag"></div>
  <canvas id="pet"></canvas>
  <script>
    const pet = ${JSON.stringify(manifest)};
    const spriteUrl = ${JSON.stringify(pathToFileURL(spritePath).toString())};
    const canvas = document.getElementById("pet");
    const taskTag = document.getElementById("taskTag");
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

    window.setPetTaskCount = function setPetTaskCount(count) {
      const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      taskTag.textContent = String(safeCount);
      taskTag.classList.toggle("show", safeCount > 0);
    };

    taskTag.addEventListener("pointerenter", function onTaskTagEnter(event) {
      event.stopPropagation();
      document.title = "pet-task-tag-enter:" + Date.now();
    });
    taskTag.addEventListener("pointerleave", function onTaskTagLeave(event) {
      event.stopPropagation();
      document.title = "pet-task-tag-leave:" + Date.now();
    });
    taskTag.addEventListener("pointerdown", function onTaskTagPointerDown(event) {
      event.stopPropagation();
    });
    taskTag.addEventListener("pointerup", function onTaskTagPointerUp(event) {
      event.stopPropagation();
    });

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
    if (currentWindow && !currentWindow.isDestroyed() && !currentWindow.isVisible()) {
      currentWindow.showInactive()
      keepPetWindowOnTop(currentWindow)
      keepPetWindowOnTop(petBubbleWindow)
    }
  }
  const currentWindow = petWindow
  const htmlPath = getPetWindowHtmlPath()
  writeFileSync(htmlPath, html, "utf8")
  currentWindow.loadFile(htmlPath)
  currentWindow.webContents.on("page-title-updated", (event, title) => {
    if (petWindow !== currentWindow) return
    event.preventDefault()
    // 宠物窗口启用 sandbox，不能直接访问 Electron API；统一通过 title 事件转发交互。
    if (title === "pet-ready") {
      showPetWindow()
      updatePetTaskTag()
      showPetGreetingBubble()
    } else if (title.startsWith("pet-click:")) {
      if (Date.now() < suppressPetClickUntil) return
      showMainWindowFromPet()
    } else if (title.startsWith("pet-task-tag-enter:")) {
      suppressPetClick()
      showPetTaskBubble()
    } else if (title.startsWith("pet-task-tag-leave:")) {
      schedulePetBubbleHide()
    } else if (title.startsWith("pet-pointer-down:")) {
      const [, rawX, rawY] = title.split(":")
      const pointerX = Number(rawX)
      const pointerY = Number(rawY)
      if (Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
        const bounds = currentWindow.getBounds()
        // 记录鼠标在宠物窗口内的偏移，后续拖拽时保持鼠标抓取点不跳动。
        petDragOffset = { x: pointerX - bounds.x, y: pointerY - bounds.y }
      }
    } else if (title.startsWith("pet-drag:")) {
      const [, rawX, rawY] = title.split(":")
      const pointerX = Number(rawX)
      const pointerY = Number(rawY)
      if (petDragOffset && Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
        currentWindow.setPosition(
          Math.round(pointerX - petDragOffset.x),
          Math.round(pointerY - petDragOffset.y),
          false
        )
        keepPetWindowOnTop(currentWindow)
        keepPetWindowOnTop(petBubbleWindow)
        updatePetBubblePosition()
      }
    } else if (title.startsWith("pet-pointer-up:")) {
      petDragOffset = null
    }
  })
  currentWindow.on("move", () => {
    if (
      petWindow !== currentWindow ||
      currentWindow.isDestroyed() ||
      currentWindow.webContents.isDestroyed()
    ) {
      return
    }
    const [x] = currentWindow.getPosition()
    const direction = petMoveLastX === null || x >= petMoveLastX ? "right" : "left"
    petMoveLastX = x
    // 真实窗口移动时触发奔跑动画，覆盖系统原生/手动拖拽两种移动来源。
    currentWindow.webContents
      .executeJavaScript(
        `window.setPetTransientState("running", 350, ${JSON.stringify(direction)})`
      )
      .catch((error) => console.warn("[Pets] Failed to update drag state:", error))
    updatePetBubblePosition()
  })
  startPetHoverPolling()
  currentWindow.on("closed", () => {
    if (petWindow !== currentWindow) return
    stopPetHoverPolling()
    closePetBubble()
    petWindow = null
    petMoveLastX = null
    petDragOffset = null
    petHovering = false
    petWindowOptions?.applyMacDockIcon()
  })
}

/**
 * 根据宠物当前位置计算气泡窗口的位置。
 *
 * 气泡优先显示在宠物上方，同时会被限制在当前屏幕工作区内，避免被屏幕边缘裁掉。
 */
function getBubbleBounds(width: number, height: number): Electron.Rectangle | null {
  if (!petWindow || petWindow.isDestroyed()) return null
  const petBounds = petWindow.getBounds()
  const display = screen.getDisplayMatching(petBounds)
  const workArea = display.workArea
  const preferredX = petBounds.x + Math.round((petBounds.width - width) / 2)
  const x = Math.min(Math.max(workArea.x, preferredX), workArea.x + workArea.width - width)
  const preferredY = petBounds.y - height - 8
  const fallbackY = petBounds.y + petBounds.height + 8
  const y =
    preferredY >= workArea.y
      ? preferredY
      : Math.min(Math.max(workArea.y, fallbackY), workArea.y + workArea.height - height)
  return { x: Math.round(x), y: Math.round(y), width, height }
}

/**
 * 取消气泡的延迟隐藏。
 *
 * 鼠标从数字 tag 移向气泡窗口时会短暂离开 tag，这里用于保留气泡，避免闪烁。
 */
function cancelPetBubbleHide(): void {
  if (!petBubbleHideTimer) return
  clearTimeout(petBubbleHideTimer)
  petBubbleHideTimer = null
}

/**
 * 延迟隐藏气泡。
 *
 * 给鼠标从 tag 移动到气泡窗口留出缓冲时间，提升 hover 交互的稳定性。
 */
function schedulePetBubbleHide(): void {
  cancelPetBubbleHide()
  petBubbleHideTimer = setTimeout(() => {
    petBubbleHideTimer = null
    closePetBubble()
  }, 260)
}

/**
 * 临时屏蔽宠物本体点击。
 *
 * 任务气泡是独立透明窗口，部分平台在气泡关闭或失焦时可能把鼠标释放事件传给后面的宠物窗口；
 * 这里用短时间窗口防止这类穿透点击误打开主应用。
 */
function suppressPetClick(durationMs = 700): void {
  suppressPetClickUntil = Date.now() + durationMs
}

/**
 * 宠物拖动或移动时，同步更新气泡的位置。
 *
 * 气泡是独立 BrowserWindow，因此需要在主进程里跟随宠物窗口手动重定位。
 */
function updatePetBubblePosition(): void {
  if (!petBubbleWindow || petBubbleWindow.isDestroyed()) return
  const bounds = petBubbleWindow.getBounds()
  const nextBounds = getBubbleBounds(bounds.width, bounds.height)
  if (!nextBounds) return
  petBubbleWindow.setBounds(nextBounds, false)
}

/**
 * 展示统一宠物气泡。
 *
 * pet ready 的问候和任务完成提醒都复用这一个顶部气泡窗口。
 */
function showPetBubble(message: string, autoHideMs = PET_BUBBLE_AUTO_HIDE_MS): void {
  cancelPetBubbleHide()
  if (!petWindow || petWindow.isDestroyed()) return
  const escapedMessage = escapeHtml(message)
  const bubbleWidth = 250
  const bubbleHeight = 60
  const bounds = getBubbleBounds(bubbleWidth, bubbleHeight)
  if (!bounds) return

  if (!petBubbleWindow || petBubbleWindow.isDestroyed()) {
    petBubbleWindow = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    petBubbleWindow.setBackgroundColor("#00000000")
    keepPetWindowOnTop(petBubbleWindow)
    petWindowOptions?.applyMacDockIcon()
    petBubbleWindow.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault()
      if (title.startsWith("pet-bubble-enter:")) {
        suppressPetClick()
        cancelPetBubbleHide()
        return
      }
      if (title.startsWith("pet-bubble-leave:")) {
        if (autoHideMs === 0) schedulePetBubbleHide()
        return
      }
      if (title.startsWith("pet-bubble-done:")) {
        closePetBubble()
        return
      }
    })
    petBubbleWindow.on("closed", () => {
      petBubbleWindow = null
      petWindowOptions?.applyMacDockIcon()
    })
  } else {
    petBubbleWindow.setBounds(bounds, false)
    keepPetWindowOnTop(petBubbleWindow)
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
      user-select: none;
      cursor: default;
    }
    body {
      box-sizing: border-box;
      padding: 5px 7px 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      position: relative;
      width: 236px;
    }
    .bubble {
      position: relative;
      box-sizing: border-box;
      width: 200px;
      min-height: 40px;
      padding: 7px 10px 6px;
      border: 1px solid rgba(196, 149, 106, 0.5);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.97);
      color: #292524;
      /*box-shadow: 0 10px 24px rgba(41, 37, 36, 0.16);*/
    }
    .bubble::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -5px;
      width: 10px;
      height: 10px;
      border-bottom: 1px solid rgba(196, 149, 106, 0.5);
      border-right: 1px solid rgba(196, 149, 106, 0.5);
      background: rgba(255, 255, 255, 0.97);
      transform: translateX(-50%) rotate(45deg);
    }
    .content {
      margin: 0;
      font: 600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="bubble">
      <div class="content">${escapedMessage}</div>
    </div>
  </div>
  <script>
    document.body.addEventListener("pointerenter", function onEnter() {
      document.title = "pet-bubble-enter:" + Date.now();
    });
    document.body.addEventListener("pointerleave", function onLeave() {
      document.title = "pet-bubble-leave:" + Date.now();
    });
    ${autoHideMs > 0 ? `window.setTimeout(function done() { document.title = "pet-bubble-done:" + Date.now(); }, ${autoHideMs});` : ""}
  </script>
</body>
</html>`

  petBubbleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  petBubbleWindow.once("ready-to-show", () => {
    petBubbleWindow?.showInactive()
    keepPetWindowOnTop(petWindow)
    keepPetWindowOnTop(petBubbleWindow)
    petWindowOptions?.applyMacDockIcon()
  })
}

/**
 * 展示 pet ready 后的问候气泡。
 */
function showPetGreetingBubble(): void {
  const pet = getSelectedPet()
  const petName = pet?.displayName || pet?.name || pet?.id || "皮皮"
  showPetBubble(`Hi～我是你的Claw宠物，我叫${petName}～`)
}

/**
 * 展示后台任务完成气泡。
 *
 * 任务完成时只展示数量汇总，不再展示具体任务内容。
 */
function showPetTaskBubble(): void {
  if (completedTaskNotices.length === 0) {
    closePetBubble()
    return
  }
  showPetBubble(`主人，有 ${completedTaskNotices.length} 个任务已完成～`)
}

/**
 * 展示 hover 时的随机宠物语。
 *
 * 只在当前没有气泡时展示，避免覆盖问候、任务完成等更明确的消息。
 */
function showPetHoverBubbleIfIdle(): void {
  if (petBubbleWindow && !petBubbleWindow.isDestroyed()) return
  const message = PET_HOVER_MESSAGES[Math.floor(Math.random() * PET_HOVER_MESSAGES.length)]
  showPetBubble(message)
}

/**
 * 关闭当前统一宠物气泡窗口。
 */
function closePetBubble(): void {
  cancelPetBubbleHide()
  if (petBubbleWindow && !petBubbleWindow.isDestroyed()) {
    petBubbleWindow.close()
  }
  petBubbleWindow = null
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
    if (isHovering) {
      showPetHoverBubbleIfIdle()
    }
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
