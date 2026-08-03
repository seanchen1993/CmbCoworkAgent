import { app, BrowserWindow, dialog, type IpcMain, screen } from "electron"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { mkdir, readFile, rm } from "fs/promises"
import { basename, join, relative } from "path"
import { pathToFileURL } from "url"
import { getOpenworkDir } from "./storage"
import { copyDirRecursive } from "./utils/fs"
import {
  getPetWindowPlatformPolicy,
  getPetWindowRefreshAction,
  resizeWindowAroundPetBody,
  shouldIgnorePetWindowMouseEvents
} from "./pet-window-policy"

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

type PetWindowLayout = {
  petLeft: number
  petTop: number
  bubbleLeft: number
  bubbleTop: number
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
let petStartupReady = false
let currentPetState: PetState = "idle"
let petMoveLastX: number | null = null
let petDragOffset: { x: number; y: number } | null = null
let petHoverPollTimer: NodeJS.Timeout | null = null
let petHovering = false
let petWindowOptions: PetWindowOptions | null = null
let completedTaskNoticeCount = 0
let petBubbleHideTimer: NodeJS.Timeout | null = null
let petBubbleVisible = false
let petWindowLayout: PetWindowLayout = {
  petLeft: 0,
  petTop: 0,
  bubbleLeft: 0,
  bubbleTop: 0
}
let petWindowIgnoringMouseEvents = false
let petWindowLayoutChangeUntil = 0
let petMouseInputPinnedUntil = 0
let suppressPetClickUntil = 0
// 拖动窗口会触发高频 move 事件，这个时间戳用于节流状态同步，避免主进程连续 executeJavaScript。
let lastPetMoveStateAt = 0
// settings/list 是低频变更资源，缓存在主进程内，减少同步 IO。
let cachedPetSettings: PetSettings | null = null
let cachedPetList: PetListItem[] | null = null

const PET_SETTINGS_FILE = join(getOpenworkDir(), "pet-settings.json")
const PET_SETTINGS_CHANGED_CHANNEL = "pet:settingsChanged"
const PET_BUBBLE_AUTO_HIDE_MS = 4200
const MAX_COMPLETED_TASK_NOTICE_COUNT = 9999
const PET_PLATFORM_POLICY = getPetWindowPlatformPolicy(process.platform)
const PET_BODY_WIDTH = 112
const PET_BODY_HEIGHT = 124
const PET_CANVAS_WIDTH = 96
const PET_CANVAS_HEIGHT = 104
const PET_BUBBLE_WIDTH = 250
const PET_BUBBLE_HEIGHT = 48
const PET_BUBBLE_GAP = 2
const PET_BUBBLE_VISUAL_OVERLAP = 10
const PET_WINDOW_RESERVED_LAYOUT: PetWindowLayout = {
  petLeft: Math.round((PET_BUBBLE_WIDTH - PET_BODY_WIDTH) / 2),
  petTop: PET_BUBBLE_HEIGHT + PET_BUBBLE_GAP - PET_BUBBLE_VISUAL_OVERLAP,
  bubbleLeft: 0,
  bubbleTop: 0
}
const PET_WINDOW_RESERVED_WIDTH = PET_BUBBLE_WIDTH
const PET_WINDOW_RESERVED_HEIGHT = PET_WINDOW_RESERVED_LAYOUT.petTop + PET_BODY_HEIGHT
const PET_WINDOW_COMPACT_LAYOUT: PetWindowLayout = {
  petLeft: 0,
  petTop: 0,
  bubbleLeft: 0,
  bubbleTop: 0
}
// 设置页预览通过 IPC 临时读取二进制，限制单图大小，防止异常资源造成跨进程内存尖峰。
const MAX_PREVIEW_SPRITE_BYTES = 8 * 1024 * 1024
const MAX_RUNTIME_SPRITE_BYTES = 16 * 1024 * 1024
const DEFAULT_PET_COLUMNS = 8
const DEFAULT_PET_ROWS = 9
// 运行时 canvas 直接按帧尺寸分配内存，必须限制异常 pet.json 或超大解码图。
const MAX_PET_FRAME_SIZE = 1024
const MAX_PET_SPRITE_PIXELS = 16 * 1024 * 1024
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

export function markPetStartupReady(): void {
  if (petStartupReady) return
  petStartupReady = true
  createPetWindow()
}

/**
 * 透明宠物窗口不在 renderer DOM 里，z-index 不参与排序；这里统一刷新原生窗口层级。
 *
 * macOS 上 hidden -> showInactive、主窗口重新 focus 时，floating 层级偶发会被后续窗口压住，
 * 因此非 Windows 保留 screen-saver；Windows 使用较低的 floating，减少高层透明窗口的合成压力。
 * Windows 的 hover 气泡不再调用 moveTop()，避免频繁重排窗口栈触发额外合成。
 */
function configurePetWindowLayer(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setAlwaysOnTop(true, PET_PLATFORM_POLICY.alwaysOnTopLevel)
  if (PET_PLATFORM_POLICY.visibleOnAllWorkspaces) {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
}

function keepPetWindowOnTop(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return
  configurePetWindowLayer(window)
  if (!window.isVisible()) return
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
  return mainWindow
}

export function registerPetHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("pet:list", async () => {
    return listPets()
  })

  ipcMain.handle("pet:getSpriteBytes", async (_event, directoryId: string, source?: PetSource) => {
    const pet = readPetManifest(directoryId, source ?? "builtin")
    if (!pet) {
      return { success: false, error: "Pet not found" }
    }
    const sprite = await readPetSpriteBytes(pet)
    if (!sprite) return { success: false, error: "Failed to load pet sprite" }
    return { success: true, ...sprite }
  })

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

  ipcMain.handle("pet:updateSettings", async (event, settings: Partial<PetSettings>) => {
    const previous = readPetSettings()
    const updated = writePetSettings(settings)
    if (!arePetSettingsEqual(previous, updated)) {
      refreshPetWindowForSettings(previous, updated)
      event.sender.send(PET_SETTINGS_CHANGED_CHANNEL, updated)
    }
    return updated
  })

  ipcMain.handle("pet:uploadCustomFolder", async () => {
    return uploadCustomPetFolder()
  })

  ipcMain.handle("pet:deleteCustom", async (event, directoryId: string) => {
    const result = await deleteCustomPet(directoryId)
    if (result.success) {
      event.sender.send(PET_SETTINGS_CHANGED_CHANNEL, readPetSettings())
    }
    return result
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

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * 归一化单个动画状态配置。
 *
 * 自定义 pet.json 可能写入 0、负数、超高 fps 或很大的帧数；这里统一夹到安全范围，
 * 避免出现 0ms 定时器、过密动画循环或查找透明帧时扫描过多格子。
 */
function normalizeStateConfig(
  state: { y?: number; frames?: number; fps?: number },
  fallback: { y: number; frames: number; fps: number }
): { y: number; frames: number; fps: number } {
  return {
    y: normalizePositiveInt(state.y, fallback.y, 0, 64),
    frames: normalizePositiveInt(state.frames, fallback.frames, 1, 64),
    fps: normalizePositiveInt(state.fps, fallback.fps, 1, 24)
  }
}

/**
 * 合并内置状态默认值与自定义状态，并对每个状态做安全归一化。
 */
function normalizePetStates(
  states?: Record<string, { y: number; frames: number; fps?: number }>
): Record<PetState, { y: number; frames: number; fps: number }> {
  const normalized: Record<PetState, { y: number; frames: number; fps: number }> = {
    ...DEFAULT_PET_STATES
  }

  for (const state of PET_STATES) {
    normalized[state] = normalizeStateConfig(states?.[state] ?? {}, DEFAULT_PET_STATES[state])
  }

  return normalized
}

/**
 * 生成注入宠物窗口的 manifest。
 *
 * 这里不直接信任磁盘上的 pet.json，所有会影响 canvas 分配、动画频率和帧扫描范围的字段
 * 都先夹到可控区间，防止异常资源导致宠物窗口或整个 App 卡死。
 */
function normalizePetManifestForWindow(
  pet: PetListItem
): PetListItem & { states: Record<PetState, { y: number; frames: number; fps: number }> } {
  return {
    ...pet,
    frameWidth:
      pet.frameWidth === undefined
        ? undefined
        : normalizePositiveInt(pet.frameWidth, 1, 1, MAX_PET_FRAME_SIZE),
    frameHeight:
      pet.frameHeight === undefined
        ? undefined
        : normalizePositiveInt(pet.frameHeight, 1, 1, MAX_PET_FRAME_SIZE),
    columns: normalizePositiveInt(pet.columns, DEFAULT_PET_COLUMNS, 1, 64),
    rows: normalizePositiveInt(pet.rows, DEFAULT_PET_ROWS, 1, 64),
    states: normalizePetStates(pet.states)
  }
}

/**
 * 检查 spritesheet 文件是否可用于当前场景。
 *
 * 预览和运行时使用不同上限：预览需要跨 IPC 传输二进制，所以更严格；运行时直接 file URL 加载，
 * 但仍要防止用户上传极大文件导致解码和绘制成本不可控。
 */
function isSpriteFileUsable(spritePath: string, maxBytes: number): boolean {
  try {
    const stats = statSync(spritePath)
    return stats.isFile() && stats.size <= maxBytes
  } catch {
    return false
  }
}

function readPetSettings(): PetSettings {
  if (cachedPetSettings) return { ...cachedPetSettings }
  try {
    if (!existsSync(PET_SETTINGS_FILE)) {
      cachedPetSettings = { ...DEFAULT_PET_SETTINGS }
      return { ...cachedPetSettings }
    }
    const parsed = JSON.parse(readFileSync(PET_SETTINGS_FILE, "utf8")) as Partial<PetSettings>
    cachedPetSettings = {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PET_SETTINGS.enabled,
      selectedPetKey:
        typeof parsed.selectedPetKey === "string" && parsed.selectedPetKey
          ? parsed.selectedPetKey
          : null
    }
    return { ...cachedPetSettings }
  } catch (error) {
    console.warn("[Pets] Failed to read pet settings:", error)
    cachedPetSettings = { ...DEFAULT_PET_SETTINGS }
    return { ...cachedPetSettings }
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
  if (arePetSettingsEqual(current, next)) return current
  writeFileSync(PET_SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8")
  cachedPetSettings = next
  return { ...next }
}

function arePetSettingsEqual(left: PetSettings, right: PetSettings): boolean {
  return left.enabled === right.enabled && left.selectedPetKey === right.selectedPetKey
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
  if (!cachedPetList) {
    cachedPetList = [...listPetsFromSource("builtin"), ...listPetsFromSource("custom")]
  }
  return cachedPetList.map((pet) => ({ ...pet }))
}

async function readPetSpriteBytes(
  pet: PetListItem
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const spritePath = getPetSpritePath(pet)
  if (!spritePath) return null
  try {
    if (!isSpriteFileUsable(spritePath, MAX_PREVIEW_SPRITE_BYTES)) {
      console.warn(`[Pets] Sprite preview skipped for ${pet.directoryId}: file is too large`)
      return null
    }
    const buffer = await readFile(spritePath)
    // Uint8Array 避免 base64 的体积膨胀；设置页绘制首帧后会立即释放 Blob URL。
    return {
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      mimeType: getMimeType(spritePath)
    }
  } catch (error) {
    console.warn(`[Pets] Failed to read sprite for ${pet.directoryId}:`, error)
    return null
  }
}

function invalidatePetResourceCache(): void {
  // 上传/删除自定义宠物后，列表缓存可能过期。
  cachedPetList = null
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
  hidePetBubble("pet-window-close")
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  petWindowOptions?.applyMacDockIcon()
  petWindow = null
  petMoveLastX = null
  petDragOffset = null
  petHovering = false
  petBubbleVisible = false
  petWindowLayout = { ...PET_WINDOW_RESERVED_LAYOUT }
  petWindowIgnoringMouseEvents = false
  petWindowLayoutChangeUntil = 0
  petMouseInputPinnedUntil = 0
  lastPetMoveStateAt = 0
}

export function getPetWindowDebugInfo(): Record<string, unknown> {
  const cursor = screen.getCursorScreenPoint()
  return {
    cursor,
    petWindow:
      petWindow && !petWindow.isDestroyed()
        ? { id: petWindow.id, visible: petWindow.isVisible(), bounds: petWindow.getBounds() }
        : null,
    petBubbleVisible,
    petStartupReady,
    petWindowLayout,
    petWindowIgnoringMouseEvents,
    petWindowPlatformPolicy: PET_PLATFORM_POLICY,
    petBodyBounds: getPetBodyScreenBounds()
  }
}

function logPetWindowDebug(message: string): void {
  if (app.isPackaged && process.env.CMB_PET_DEBUG !== "1") return
  console.debug(message)
}

function logPetWindowEvent(message: string): void {
  if (app.isPackaged && process.env.CMB_PET_DEBUG !== "1") return
  console.debug(message)
}

function refreshPetWindowForSettings(previous: PetSettings, next: PetSettings): void {
  const action = getPetWindowRefreshAction(previous, next)
  if (action === "none") return
  if (action === "close") {
    closePetWindow()
    return
  }
  if (action === "recreate") closePetWindow()
  setImmediate(() => {
    createPetWindow()
    petWindowOptions?.applyMacDockIcon()
  })
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
    invalidatePetResourceCache()
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
    invalidatePetResourceCache()
    const settings = readPetSettings()
    if (settings.selectedPetKey === makePetKey("custom", directoryId)) {
      const updated = writePetSettings({ selectedPetKey: null })
      refreshPetWindowForSettings(settings, updated)
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "删除失败"
    }
  }
}

/**
 * 将待处理任务数量同步到宠物窗口右上角数字 tag。
 *
 * tag 在宠物窗口内部渲染，任务数为 0 时隐藏，避免额外创建独立悬浮窗。
 */
function updatePetTaskTag(): void {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
  petWindow.webContents
    .executeJavaScript(`window.setPetTaskCount(${completedTaskNoticeCount})`)
    .catch((error) => console.warn("[Pets] Failed to update task tag:", error))
}

/**
 * 清空所有已完成任务提醒。
 *
 * 用户打开主应用后，不再逐个按线程扣减，而是直接认为完成提醒已被查看并清空计数。
 */
function clearPetCompletedTaskNotices(): void {
  if (completedTaskNoticeCount === 0) return
  completedTaskNoticeCount = 0
  updatePetTaskTag()
  hidePetBubble("clear-completed-tasks")
}

/**
 * 记录一个后台完成的任务，并让宠物右上角展示完成数量 tag。
 *
 * 仅在应用窗口不处于焦点、且宠物窗口已经存在时生效；不会为了完成提醒主动创建宠物窗口。
 */
export function showPetCompletedTaskNotice(threadId: string, title: string): void {
  void threadId
  void title
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (focusedWindow?.isFocused()) return
  if (!petWindow || petWindow.isDestroyed()) return
  if (!readPetSettings().enabled) return

  completedTaskNoticeCount = Math.min(completedTaskNoticeCount + 1, MAX_COMPLETED_TASK_NOTICE_COUNT)

  updatePetTaskTag()
  showPetTaskBubble()
}

export function createPetWindow(): void {
  if (!petStartupReady) return
  if (!readPetSettings().enabled) return
  if (petWindow && !petWindow.isDestroyed()) return

  const pet = getSelectedPet()
  if (!pet) {
    console.warn("[Pets] No pet manifest found; pet window disabled")
    return
  }

  const spritePath = getPetSpritePath(pet)
  if (!spritePath) return
  if (!isSpriteFileUsable(spritePath, MAX_RUNTIME_SPRITE_BYTES)) {
    console.warn(`[Pets] Sprite skipped for ${pet.directoryId}: file is too large`)
    return
  }

  // 窗口始终预留气泡尺寸，避免 Windows 在气泡显示/隐藏时 resize 导致透明窗口闪烁。
  const petWindowWidth = PET_WINDOW_RESERVED_WIDTH
  const petWindowHeight = PET_WINDOW_RESERVED_HEIGHT
  const petWindowMargin = 150
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const initialPetX = Math.round(workArea.x + workArea.width - PET_BODY_WIDTH - petWindowMargin)
  const initialPetY = Math.round(workArea.y + workArea.height - PET_BODY_HEIGHT - petWindowMargin)
  const initialX = initialPetX - PET_WINDOW_RESERVED_LAYOUT.petLeft
  const initialY = initialPetY - PET_WINDOW_RESERVED_LAYOUT.petTop

  petWindowLayout = { ...PET_WINDOW_RESERVED_LAYOUT }
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
      // Windows 允许 Chromium 节流后台计时器，降低透明置顶窗口的持续合成压力。
      backgroundThrottling: PET_PLATFORM_POLICY.backgroundThrottling
    }
  })

  petWindow.setBackgroundColor("#00000000")
  configurePetWindowLayer(petWindow)
  petWindowOptions?.applyMacDockIcon()

  const manifest = normalizePetManifestForWindow(pet)
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
      cursor: default;
      user-select: none;
    }
    body.dragging #petLayer {
      cursor: grabbing;
    }
    body {
      box-sizing: border-box;
      position: relative;
    }
    #stage {
      position: relative;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0);
    }
    #petLayer {
      position: absolute;
      left: ${PET_WINDOW_RESERVED_LAYOUT.petLeft}px;
      top: ${PET_WINDOW_RESERVED_LAYOUT.petTop}px;
      width: ${PET_BODY_WIDTH}px;
      height: ${PET_BODY_HEIGHT}px;
      display: grid;
      place-items: center;
      cursor: grab;
    }
    @media (max-width: ${PET_BODY_WIDTH}px) {
      #petLayer {
        left: 0;
        top: 0;
      }
      #bubbleLayer {
        display: none !important;
      }
    }
    canvas {
      width: ${PET_CANVAS_WIDTH}px;
      height: ${PET_CANVAS_HEIGHT}px;
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
    #bubbleLayer {
      position: absolute;
      left: 0;
      top: 0;
      display: none;
      width: 236px;
      box-sizing: border-box;
      padding: 3px 7px 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: default;
    }
    #bubbleLayer.show {
      display: block;
    }
    .bubble {
      position: relative;
      box-sizing: border-box;
      width: 200px;
      min-height: 32px;
      padding: 5px 10px 4px;
      border: 1px solid rgba(196, 149, 106, 0.5);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.97);
      color: #292524;
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
    .bubbleContent {
      margin: 0;
      font: 600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div id="stage">
    <div id="bubbleLayer">
      <div class="bubble">
        <div id="bubbleContent" class="bubbleContent"></div>
      </div>
    </div>
    <div id="petLayer">
      <div id="taskTag"></div>
      <canvas id="pet"></canvas>
    </div>
  </div>
  <script>
    const pet = ${JSON.stringify(manifest)};
    const spriteUrl = ${JSON.stringify(pathToFileURL(spritePath).toString())};
    const petLayer = document.getElementById("petLayer");
    const bubbleLayer = document.getElementById("bubbleLayer");
    const bubbleContent = document.getElementById("bubbleContent");
    const canvas = document.getElementById("pet");
    const taskTag = document.getElementById("taskTag");
    const ctx = canvas.getContext("2d");
    const renderBuffer = document.createElement("canvas");
    const renderBufferCtx = renderBuffer.getContext("2d");
    const frameScanBuffer = document.createElement("canvas");
    const frameScanCtx = frameScanBuffer.getContext("2d", { willReadFrequently: true });
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
    let frameScanReleased = false;
    let firstFramePainted = false;
    let pointerDown = false;
    let pointerMoved = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let pendingDragX = 0;
    let pendingDragY = 0;
    let dragTitleFrame = 0;
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

    window.setPetBubble = function setPetBubble(message) {
      bubbleContent.textContent = String(message || "");
      bubbleLayer.classList.add("show");
    };

    window.clearPetBubble = function clearPetBubble() {
      bubbleLayer.classList.remove("show");
      bubbleContent.textContent = "";
    };

    for (const eventName of ["pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu"]) {
      bubbleLayer.addEventListener(eventName, function onBubblePointerEvent(event) {
        event.preventDefault();
        event.stopPropagation();
      });
    }

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

    petLayer.addEventListener("pointerenter", function onPointerEnter() {
      if (transientState === "running" || transientState === "interaction") return;
      setTransientState("hover", 0);
    });
    petLayer.addEventListener("pointerleave", function onPointerLeave() {
      clearTransientState("hover");
    });
    petLayer.addEventListener("pointerdown", function onPointerDown(event) {
      pointerDown = true;
      pointerMoved = false;
      dragStartX = event.screenX;
      dragStartY = event.screenY;
      document.body.classList.add("dragging");
      // 使用 document.title 作为 sandbox 页面到主进程的轻量事件通道。
      document.title = "pet-pointer-down:" + event.screenX + ":" + event.screenY + ":" + Date.now();
      try {
        petLayer.setPointerCapture(event.pointerId);
      } catch {
        // Best effort only.
      }
      setTransientState("running", 0);
    });
    petLayer.addEventListener("pointermove", function onPointerMove(event) {
      // 防御：pointerDown 为 true 但实际未按下任何按键，说明 pointerup 丢失（快速拖拽时
      // 鼠标移出窗口导致 setIgnoreMouseEvents 拦截了 pointerup），重置拖拽状态。
      if (pointerDown && event.buttons === 0) {
        pointerDown = false;
        pointerMoved = false;
        document.body.classList.remove("dragging");
        document.title = "pet-pointer-up:" + Date.now();
        if (dragTitleFrame) {
          window.cancelAnimationFrame(dragTitleFrame);
          dragTitleFrame = 0;
        }
        clearTransientState("running");
        return;
      }
      if (!pointerDown) return;
      const dx = event.screenX - dragStartX;
      const dy = event.screenY - dragStartY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        pointerMoved = true;
        pendingDragX = event.screenX;
        pendingDragY = event.screenY;
        // pointermove 可能远高于屏幕刷新率；合并到下一帧再通过 title 通知主进程，
        // 避免拖拽时短时间触发大量 setPosition。
        if (!dragTitleFrame) {
          dragTitleFrame = window.requestAnimationFrame(function flushDragTitle() {
            dragTitleFrame = 0;
            document.title = "pet-drag:" + pendingDragX + ":" + pendingDragY + ":" + Date.now();
          });
        }
      }
    });
    petLayer.addEventListener("pointerup", function onPointerUp(event) {
      pointerDown = false;
      document.body.classList.remove("dragging");
      document.title = "pet-pointer-up:" + Date.now();
      if (dragTitleFrame) {
        window.cancelAnimationFrame(dragTitleFrame);
        dragTitleFrame = 0;
      }
      clearTransientState("running");
      if (!pointerMoved) {
        setTransientState("interaction", 900);
        document.title = "pet-click:" + Date.now();
      }
    });

    sprite.onload = function onSpriteLoad() {
      naturalWidth = sprite.naturalWidth;
      naturalHeight = sprite.naturalHeight;
      const columns = pet.columns || ${DEFAULT_PET_COLUMNS};
      const rows = pet.rows || ${DEFAULT_PET_ROWS};
      // 图片压缩后文件可能不大，但解码后像素极多；这里在分配 canvas 前挡住异常资源。
      if (
        naturalWidth < 1 ||
        naturalHeight < 1 ||
        naturalWidth * naturalHeight > ${MAX_PET_SPRITE_PIXELS}
      ) {
        document.title = "pet-load-error:invalid-size";
        return;
      }
      frameWidth = pet.frameWidth || Math.floor(naturalWidth / columns);
      frameHeight = pet.frameHeight || Math.floor(naturalHeight / rows);
      // 帧尺寸来自 pet.json 或整图推导，过大会让 canvas/getImageData 占用大量内存。
      if (
        frameWidth < 1 ||
        frameHeight < 1 ||
        frameWidth > ${MAX_PET_FRAME_SIZE} ||
        frameHeight > ${MAX_PET_FRAME_SIZE}
      ) {
        document.title = "pet-load-error:invalid-frame";
        return;
      }
      canvas.width = ${PET_CANVAS_WIDTH};
      canvas.height = ${PET_CANVAS_HEIGHT};
      renderBuffer.width = ${PET_CANVAS_WIDTH};
      renderBuffer.height = ${PET_CANVAS_HEIGHT};
      frameScanBuffer.width = Math.min(frameWidth, ${PET_CANVAS_WIDTH});
      frameScanBuffer.height = Math.min(frameHeight, ${PET_CANVAS_HEIGHT});
      ctx.imageSmoothingEnabled = false;
      renderBufferCtx.imageSmoothingEnabled = false;
      frameScanCtx.imageSmoothingEnabled = false;
      // 首帧只按需扫描到第一个可见帧；其余帧在宠物显示后按空闲时间分批补齐。
      frame = findVisibleFrame(pet.states[currentState] || pet.states.idle, 0);
      renderFrame();
      scheduleNextFrame();
      scheduleRemainingFrameScans();
    };
    sprite.src = spriteUrl;

    function getFrameCacheKey(state, frameIndex) {
      return state.y + ":" + frameIndex;
    }

    function releaseFrameScanBuffer() {
      if (frameScanReleased) return;
      frameScanReleased = true;
      frameScanBuffer.width = 1;
      frameScanBuffer.height = 1;
    }

    function scheduleRemainingFrameScans() {
      const pendingFrames = [];
      const queuedKeys = new Set();
      for (const state of Object.values(pet.states)) {
        const totalFrames = Math.max(
          1,
          Math.min(state.frames || 1, pet.columns || ${DEFAULT_PET_COLUMNS})
        );
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
          const cacheKey = getFrameCacheKey(state, frameIndex);
          if (visibleFrameCache.has(cacheKey) || queuedKeys.has(cacheKey)) continue;
          queuedKeys.add(cacheKey);
          pendingFrames.push({ state, frameIndex });
        }
      }

      let pendingIndex = 0;
      function scheduleNextBatch() {
        if (pendingIndex >= pendingFrames.length) {
          releaseFrameScanBuffer();
          return;
        }
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(scanBatch, { timeout: 1000 });
        } else {
          window.setTimeout(function scanFrameFallback() {
            scanBatch(null);
          }, 16);
        }
      }

      function scanBatch(deadline) {
        let processed = 0;
        while (pendingIndex < pendingFrames.length && processed < 2) {
          if (
            processed > 0 &&
            deadline &&
            !deadline.didTimeout &&
            deadline.timeRemaining() < 2
          ) {
            break;
          }
          const pending = pendingFrames[pendingIndex];
          pendingIndex += 1;
          processed += 1;
          frameHasPixels(pending.state, pending.frameIndex);
        }
        scheduleNextBatch();
      }

      scheduleNextBatch();
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
      // 已释放扫描缓冲后，未知项按可见处理，避免运行时重新分配大画布。
      if (frameScanReleased) return true;

      // 扫描阶段读取 alpha，提前标记透明占位帧，状态切换时尽量不再同步读取像素。
      const scanWidth = frameScanBuffer.width;
      const scanHeight = frameScanBuffer.height;
      frameScanCtx.clearRect(0, 0, scanWidth, scanHeight);
      frameScanCtx.drawImage(
        sprite,
        sx,
        sy,
        frameWidth,
        frameHeight,
        0,
        0,
        scanWidth,
        scanHeight
      );
      const data = frameScanCtx.getImageData(0, 0, scanWidth, scanHeight).data;
      let visiblePixels = 0;
      for (let i = 3; i < data.length; i += 4) {
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
      const totalFrames = Math.max(1, Math.min(state.frames || 1, pet.columns || ${DEFAULT_PET_COLUMNS}));
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
      // 直接缩放到实际显示尺寸，避免每帧处理比 96x104 更大的原始帧。
      renderBufferCtx.clearRect(0, 0, ${PET_CANVAS_WIDTH}, ${PET_CANVAS_HEIGHT});
      renderBufferCtx.drawImage(
        sprite,
        frame * frameWidth,
        state.y * frameHeight,
        frameWidth,
        frameHeight,
        0,
        0,
        ${PET_CANVAS_WIDTH},
        ${PET_CANVAS_HEIGHT}
      );
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(renderBuffer, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (!firstFramePainted) {
        firstFramePainted = true;
        // 第一帧实际绘制完成后再通知主进程显示窗口。
        document.title = "pet-ready";
      }
    }

    function scheduleNextFrame() {
      const state = pet.states[currentState] || pet.states.idle;
      const configuredFps = state.fps || 8;
      const idleFpsCap = ${JSON.stringify(PET_PLATFORM_POLICY.idleFpsCap)};
      const fps =
        currentState === "idle" && idleFpsCap !== null
          ? Math.min(configuredFps, idleFpsCap)
          : configuredFps;
      const frameDuration = 1000 / fps;
      // 按状态 fps 调度，避免 requestAnimationFrame 在 idle 状态下 60fps 空转。
      window.setTimeout(draw, frameDuration);
    }

    function draw() {
      const state = pet.states[currentState] || pet.states.idle;
      renderFrame();
      frame = findVisibleFrame(state, frame + 1);
      lastFrameAt = performance.now();
      scheduleNextFrame();
    }
  </script>
</body>
</html>`

  const showPetWindow = (): void => {
    if (currentWindow && !currentWindow.isDestroyed() && !currentWindow.isVisible()) {
      currentWindow.showInactive()
      keepPetWindowOnTop(currentWindow)
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
    } else if (title.startsWith("pet-load-error:")) {
      console.warn("[Pets] Pet window failed to load sprite:", title)
      closePetWindow()
    } else if (title.startsWith("pet-click:")) {
      petDragOffset = null
      petMouseInputPinnedUntil = Date.now() + 300
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
        if (petBubbleVisible) {
          hidePetBubble("pet-drag-start")
          const bounds = currentWindow.getBounds()
          petDragOffset = { x: pointerX - bounds.x, y: pointerY - bounds.y }
        }
        currentWindow.setPosition(
          Math.round(pointerX - petDragOffset.x),
          Math.round(pointerY - petDragOffset.y),
          false
        )
      }
    } else if (title.startsWith("pet-pointer-up:")) {
      petDragOffset = null
      // 等 Windows 完成拖拽后的 DWM 合成，再恢复透明区域点击穿透。
      petMouseInputPinnedUntil = Date.now() + 300
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
    const petBodyBounds = getPetBodyScreenBounds()
    const petX = petBodyBounds?.x ?? currentWindow.getBounds().x
    const direction = petMoveLastX === null || petX >= petMoveLastX ? "right" : "left"
    petMoveLastX = petX
    const now = Date.now()
    if (now < petWindowLayoutChangeUntil) return
    // move 事件在拖拽中非常密集；气泡位置需要实时跟随，但动画状态不需要每次都注入 JS。
    if (now - lastPetMoveStateAt < 120) {
      return
    }
    lastPetMoveStateAt = now
    // 真实窗口移动时触发奔跑动画，覆盖系统原生/手动拖拽两种移动来源。
    currentWindow.webContents
      .executeJavaScript(
        `window.setPetTransientState("running", 350, ${JSON.stringify(direction)})`
      )
      .catch((error) => console.warn("[Pets] Failed to update drag state:", error))
  })
  startPetHoverPolling()
  currentWindow.on("closed", () => {
    if (petWindow !== currentWindow) return
    stopPetHoverPolling()
    hidePetBubble("pet-window-closed")
    petWindow = null
    petMoveLastX = null
    petDragOffset = null
    petHovering = false
    petBubbleVisible = false
    petWindowLayout = { ...PET_WINDOW_RESERVED_LAYOUT }
    petWindowIgnoringMouseEvents = false
    petWindowLayoutChangeUntil = 0
    petMouseInputPinnedUntil = 0
    lastPetMoveStateAt = 0
    petWindowOptions?.applyMacDockIcon()
  })
}

function setPetWindowMouseEventsIgnored(ignored: boolean): void {
  if (petWindowIgnoringMouseEvents === ignored) return
  petWindowIgnoringMouseEvents = ignored
  if (!petWindow || petWindow.isDestroyed()) return
  if (ignored && PET_PLATFORM_POLICY.forwardIgnoredMouseMoves) {
    petWindow.setIgnoreMouseEvents(true, { forward: true })
  } else {
    petWindow.setIgnoreMouseEvents(ignored)
  }
}

function isPointInBounds(point: Electron.Point, bounds: Electron.Rectangle): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

function getPetBodyScreenBounds(): Electron.Rectangle | null {
  if (!petWindow || petWindow.isDestroyed()) return null
  const bounds = petWindow.getBounds()
  return {
    x: bounds.x + petWindowLayout.petLeft,
    y: bounds.y + petWindowLayout.petTop,
    width: PET_BODY_WIDTH,
    height: PET_BODY_HEIGHT
  }
}

function getPetBubbleScreenBounds(): Electron.Rectangle | null {
  if (!petWindow || petWindow.isDestroyed()) return null
  const bounds = petWindow.getBounds()
  return {
    x: bounds.x + petWindowLayout.bubbleLeft,
    y: bounds.y + petWindowLayout.bubbleTop,
    width: PET_BUBBLE_WIDTH,
    height: PET_BUBBLE_HEIGHT
  }
}

function setPetWindowBubbleExpanded(expanded: boolean): void {
  if (!PET_PLATFORM_POLICY.compactWhenBubbleHidden) return
  if (!petWindow || petWindow.isDestroyed()) return

  const nextLayout = expanded ? PET_WINDOW_RESERVED_LAYOUT : PET_WINDOW_COMPACT_LAYOUT
  const nextSize = expanded
    ? { width: PET_WINDOW_RESERVED_WIDTH, height: PET_WINDOW_RESERVED_HEIGHT }
    : { width: PET_BODY_WIDTH, height: PET_BODY_HEIGHT }
  const currentBounds = petWindow.getBounds()
  if (
    petWindowLayout.petLeft === nextLayout.petLeft &&
    petWindowLayout.petTop === nextLayout.petTop &&
    currentBounds.width === nextSize.width &&
    currentBounds.height === nextSize.height
  ) {
    return
  }

  const nextBounds = resizeWindowAroundPetBody(currentBounds, petWindowLayout, nextLayout, nextSize)
  petWindowLayout = { ...nextLayout }
  // setBounds 会产生 move；短暂抑制由窗口扩缩误触发的 running 动画。
  petWindowLayoutChangeUntil = Date.now() + 120
  petWindow.setBounds(nextBounds, false)
}

function runPetWindowScript(script: string, action: string): void {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
  petWindow.webContents
    .executeJavaScript(script)
    .catch((error) => console.warn(`[Pets] Failed to ${action}:`, error))
}

/**
 * 取消气泡的延迟隐藏。
 *
 * 任务 tag hover 会安排一个短延迟收起；重新展示气泡时先清掉旧定时器。
 */
function cancelPetBubbleHide(): void {
  if (!petBubbleHideTimer) return
  clearTimeout(petBubbleHideTimer)
  petBubbleHideTimer = null
}

/**
 * 延迟隐藏气泡。
 *
 * 鼠标离开任务 tag 后稍等一下再收起，避免边缘抖动导致气泡闪烁。
 */
function schedulePetBubbleHide(): void {
  cancelPetBubbleHide()
  petBubbleHideTimer = setTimeout(() => {
    petBubbleHideTimer = null
    hidePetBubble("task-tag-leave-delay")
  }, 260)
}

/**
 * 临时屏蔽宠物本体点击。
 *
 * 任务 tag 和气泡都在同一个透明窗口内；这里用短时间窗口防止边缘交互被误判成宠物点击。
 */
function suppressPetClick(durationMs = 700): void {
  suppressPetClickUntil = Date.now() + durationMs
}

/**
 * 展示统一宠物气泡。
 *
 * pet ready 的问候、hover 文案和任务完成提醒都复用 pet 窗口内部的 bubbleLayer。
 */
function showPetBubble(message: string, autoHideMs = PET_BUBBLE_AUTO_HIDE_MS): void {
  cancelPetBubbleHide()
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return

  petBubbleVisible = true
  setPetWindowBubbleExpanded(true)
  setPetWindowMouseEventsIgnored(false)
  runPetWindowScript(
    `if (window.setPetBubble) window.setPetBubble(${JSON.stringify(message)});`,
    "show pet bubble"
  )
  if (PET_PLATFORM_POLICY.raiseOnBubbleShow) {
    keepPetWindowOnTop(petWindow)
  }
  logPetWindowEvent(
    `[Pets] Bubble shown: autoHide=${autoHideMs}ms, window=${petWindow.id}, visible=${petWindow.isVisible()}`
  )

  if (autoHideMs > 0) {
    petBubbleHideTimer = setTimeout(() => {
      petBubbleHideTimer = null
      logPetWindowDebug("[Pets] Bubble auto-hide timer fired")
      hidePetBubble("bubble-auto-hide")
    }, autoHideMs)
  }
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
  if (completedTaskNoticeCount === 0) {
    hidePetBubble("task-bubble-empty")
    return
  }
  showPetBubble(`主人，有 ${completedTaskNoticeCount} 个任务已完成～`)
}

/**
 * 展示 hover 时的随机宠物语。
 *
 * 只在当前没有气泡时展示，避免覆盖问候、任务完成等更明确的消息。
 */
function showPetHoverBubbleIfIdle(): void {
  if (petDragOffset) return
  if (petBubbleVisible) return
  const message = PET_HOVER_MESSAGES[Math.floor(Math.random() * PET_HOVER_MESSAGES.length)]
  showPetBubble(message)
}

/**
 * 隐藏当前统一宠物气泡，并恢复平台对应的透明区域命中策略。
 */
function hidePetBubble(reason = "unknown"): void {
  cancelPetBubbleHide()
  logPetWindowDebug(
    `[Pets] hidePetBubble invoked, reason=${reason}, currentVisible=${petBubbleVisible}`
  )

  petBubbleVisible = false
  const point = screen.getCursorScreenPoint()
  const petBounds = getPetBodyScreenBounds()
  const hoveringPet = petBounds ? isPointInBounds(point, petBounds) : false
  petHovering = hoveringPet
  setPetWindowMouseEventsIgnored(
    shouldIgnorePetWindowMouseEvents({
      dragging: Boolean(petDragOffset) || Date.now() < petMouseInputPinnedUntil,
      hoveringPet,
      hoveringBubble: false
    })
  )
  runPetWindowScript(`if (window.clearPetBubble) window.clearPetBubble();`, "hide pet bubble")
  setPetWindowBubbleExpanded(false)
}

function startPetHoverPolling(): void {
  stopPetHoverPolling()
  // 透明窗口的 pointer 事件在部分平台上不稳定，保留轻量轮询兜底；Windows 需要靠轮询
  // 从点击穿透状态恢复，因此使用 100ms，其他平台保持低频的 250ms。
  petHoverPollTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const petBounds = getPetBodyScreenBounds()
    if (!petBounds) return
    const bubbleBounds = petBubbleVisible ? getPetBubbleScreenBounds() : null
    // hover 始终只以宠物本体区域为准，不把已经展示的气泡算作宠物 hover。
    const isHovering = isPointInBounds(point, petBounds)
    const isOnBubble = bubbleBounds ? isPointInBounds(point, bubbleBounds) : false
    setPetWindowMouseEventsIgnored(
      shouldIgnorePetWindowMouseEvents({
        dragging: Boolean(petDragOffset) || Date.now() < petMouseInputPinnedUntil,
        hoveringPet: isHovering,
        hoveringBubble: isOnBubble
      })
    )

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
  }, PET_PLATFORM_POLICY.hoverPollIntervalMs)
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
