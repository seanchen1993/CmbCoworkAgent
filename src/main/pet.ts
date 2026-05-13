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
  onShowMainWindow: () => void
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
let petGreetingWindow: BrowserWindow | null = null
let currentPetState: PetState = "idle"
let petMoveLastX: number | null = null
let petDragOffset: { x: number; y: number } | null = null
let petHoverPollTimer: NodeJS.Timeout | null = null
let petHovering = false
let petWindowOptions: PetWindowOptions | null = null

const PET_SETTINGS_FILE = join(getOpenworkDir(), "pet-settings.json")
const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  selectedPetKey: null
}

export function configurePetWindow(options: PetWindowOptions): void {
  petWindowOptions = options
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
  closePetGreeting()
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
  petWindow.setAlwaysOnTop(true, "floating")
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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
    const spriteUrl = ${JSON.stringify(pathToFileURL(spritePath).toString())};
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
    if (currentWindow && !currentWindow.isDestroyed() && !currentWindow.isVisible()) {
      currentWindow.showInactive()
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
      showPetGreeting()
    } else if (title.startsWith("pet-click:")) {
      petWindowOptions?.onShowMainWindow()
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
  })
  startPetHoverPolling()
  currentWindow.on("closed", () => {
    if (petWindow !== currentWindow) return
    stopPetHoverPolling()
    closePetGreeting()
    petWindow = null
    petMoveLastX = null
    petDragOffset = null
    petHovering = false
    petWindowOptions?.applyMacDockIcon()
  })
}

function showPetGreeting(): void {
  closePetGreeting()
  if (!petWindow || petWindow.isDestroyed()) return

  const pet = getSelectedPet()
  // 问候文案中的名称来自宠物配置，避免写死“皮皮”。
  const petName = escapeHtml(pet?.displayName || pet?.name || pet?.id || "皮皮")
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
    skipTaskbar: true,
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
