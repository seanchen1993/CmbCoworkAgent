import { type IpcMain, dialog, shell } from "electron"
import * as fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import mammoth from "mammoth"
import { getOpenworkDir } from "../storage"

type RequirementSourceType = "file" | "text" | "link"
type NeedDesignChoice = "" | "0" | "1"

export type RequirementSource = {
  type: RequirementSourceType
  fileName: string
  attachmentNames?: string[]
  url?: string | null
  initialDescription?: string
}

export type RequirementIndexItem = {
  reqId: string
  threadIds: string[]
  systemId: string
  title: string
  requirementPath?: string
  source: RequirementSource
  createdAt: string
  updatedAt: string
  prdManifest?: IndexedPrdManifest
  needDesign?: NeedDesignChoice
}

export type IndexedPrdManifest = {
  prd: {
    name: string
    status: "" | "init" | "draft" | "generated" | "published"
    description: string
    file: string
    prDetailUrl?: string
    currentStep: number
    needDesign: NeedDesignChoice
  }
  functions: Array<{
    id?: string
    fr: string
    name: string
    description: string
    file: string
    keywords: string[]
    htmlFile: string
    htmlId: string
    needDesign: NeedDesignChoice
  }>
}

export type RequirementRuntimeItem = RequirementIndexItem & {
  requirementPath: string
  workspaceMissing: boolean
  coreFilesMissing: boolean
  coreFilesMissingReason: string | null
  prdManifest: IndexedPrdManifest
}

type RequirementSourcePayload = {
  filename: string
  sourcePath?: string
  content?: string
}

type RequirementPrdPayload = {
  filename: string
  content: string
}

type SaveRequirementFilesPayload = {
  workspacePath: string
  requirementId: string
  source?: RequirementSourcePayload
  prd?: RequirementPrdPayload
}

type CreateRequirementPayload = {
  systemId: string
  title: string
  workDir: string
  source: {
    type: RequirementSourceType
    fileName: string
    sourcePath?: string
    url?: string
    content?: string
    bytes?: ArrayBuffer
    initialDescription?: string
    attachments?: Array<{ fileName: string; bytes: ArrayBuffer }>
  }
}

type SavePrdPayload = {
  reqId: string
  version: string
  modules: Array<{
    moduleId: string
    name: string
    content: string
    description?: string
    keywords?: string[]
  }>
}

type GeneratedRequirementModule = {
  moduleId: string
  name: string
  filePath: string
  description: string
  keywords: string[]
}

type MammothMarkdownConverter = typeof mammoth & {
  convertToMarkdown: (input: { path: string }) => Promise<{
    value: string
    messages: Array<{ type: string; message: string }>
  }>
}

const MAX_TEXT_BYTES = 5 * 1024 * 1024
const UNSAFE_FILENAME_CHARACTER = /[<>:"/\\|?*]/
const REQUIREMENTS_DIRNAME = "requirements"
const REQUIREMENTS_INDEX_FILENAME = "index.json"
const PRD_DIRNAME = "prd"
const PRD_MANIFEST_FILENAME = "prd-manifest.json"
const SOURCE_PREVIEW_FILENAME = "source-preview.md"
const REQUIREMENT_SETTINGS_FILENAME = "settings.json"

type RequirementsIndexFile = {
  list?: Array<
    RequirementIndexItem & {
      workDir?: string
      prdVersion?: string | null
      prdPublished?: boolean
      prdManifestSynced?: boolean
    }
  >
  token?: string
  lastWorkDir?: string
}

function getRequirementThreadIds(item: { threadIds?: unknown; threadId?: unknown }): string[] {
  const persistedThreadIds = Array.isArray(item.threadIds) ? item.threadIds : []
  const legacyThreadId = typeof item.threadId === "string" ? [item.threadId] : []
  return [
    ...new Set(
      [...persistedThreadIds, ...legacyThreadId]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ]
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = Array.from(value.trim())
    .map((character) =>
      UNSAFE_FILENAME_CHARACTER.test(character) || character.charCodeAt(0) < 32 ? "_" : character
    )
    .join("")
  return (cleaned || fallback).slice(0, 120)
}

function validateTextContent(content: string, label: string): void {
  if (Buffer.byteLength(content, "utf-8") > MAX_TEXT_BYTES) {
    throw new Error(`${label}超过 5MB 限制`)
  }
}

function getRequirementsRoot(): string {
  return path.join(getOpenworkDir(), REQUIREMENTS_DIRNAME)
}

function getDefaultRequirementRoot(reqId: string): string {
  return path.join(getRequirementsRoot(), safeSegment(reqId, "requirement"))
}

function getRequirementRoot(item: RequirementIndexItem): string {
  return item.requirementPath?.trim()
    ? path.resolve(item.requirementPath)
    : getDefaultRequirementRoot(item.reqId)
}

function getRequirementWorkspacePath(workDir: string, reqId: string, title: string): string {
  return path.join(workDir, REQUIREMENTS_DIRNAME, safeSegment(`${reqId}-${title}`, "requirement"))
}

function getRequirementSourcePath(item: RequirementIndexItem): string {
  return path.join(getRequirementRoot(item), "source", safeSegment(item.source.fileName, "source"))
}

function getRequirementSourcePreviewPath(item: RequirementIndexItem): string {
  return path.join(getRequirementRoot(item), SOURCE_PREVIEW_FILENAME)
}

function getRequirementPrdPath(item: RequirementIndexItem): string {
  return path.join(getRequirementRoot(item), PRD_DIRNAME, PRD_MANIFEST_FILENAME)
}

function getRequirementPrdDir(item: RequirementIndexItem): string {
  return path.join(getRequirementRoot(item), PRD_DIRNAME)
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function migrateLegacyRequirementData(): Promise<void> {
  const requirementsRoot = getRequirementsRoot()
  const legacyRoot = path.join(getOpenworkDir(), "designworkbench", REQUIREMENTS_DIRNAME)
  const legacySettingsPath = path.join(
    getOpenworkDir(),
    "designworkbench",
    REQUIREMENT_SETTINGS_FILENAME
  )

  try {
    await fs.stat(requirementsRoot)
  } catch {
    try {
      await fs.rename(legacyRoot, requirementsRoot)
    } catch {
      // There may be no legacy directory, or it may already have been migrated.
    }
  }

  const indexPath = path.join(requirementsRoot, REQUIREMENTS_INDEX_FILENAME)
  const currentSettingsPath = path.join(requirementsRoot, REQUIREMENT_SETTINGS_FILENAME)
  const existingIndex = await readJson<RequirementsIndexFile>(indexPath, {})
  const settingsPaths = [currentSettingsPath, legacySettingsPath]

  for (const settingsPath of settingsPaths) {
    let settings: { lastWorkDir?: unknown }
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8")) as { lastWorkDir?: unknown }
    } catch {
      continue
    }

    const lastWorkDir = typeof settings.lastWorkDir === "string" ? settings.lastWorkDir.trim() : ""
    if (!lastWorkDir || existingIndex.lastWorkDir) {
      await fs.rm(settingsPath, { force: true })
      continue
    }

    await writeJson(indexPath, { ...existingIndex, lastWorkDir, list: existingIndex.list ?? [] })
    existingIndex.lastWorkDir = lastWorkDir
    await fs.rm(settingsPath, { force: true })
  }
}

async function ensureRequirementDirs(): Promise<void> {
  await migrateLegacyRequirementData()
  await fs.mkdir(getRequirementsRoot(), { recursive: true })
}

async function readRequirementIndex(): Promise<RequirementIndexItem[]> {
  await ensureRequirementDirs()
  const data = await readJson<RequirementsIndexFile>(
    path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME),
    { list: [] }
  )
  const list = Array.isArray(data.list) ? data.list : []
  const normalized = list.map((rawItem) => {
    const { threadId: _legacyThreadId, ...item } = rawItem as typeof rawItem & {
      threadId?: unknown
      crrentStep?: unknown
      status?: unknown
      prdGenerated?: unknown
    }
    const normalizedThreadIds = getRequirementThreadIds({
      threadIds: item.threadIds,
      threadId: _legacyThreadId
    })
    delete item.workDir
    delete item.prdVersion
    delete item.prdPublished
    delete item.prdManifestSynced
    delete item.status
    delete item.prdGenerated
    delete item.crrentStep
    const rawSourceType = (item.source as { type?: unknown } | undefined)?.type
    const sourceType: RequirementSourceType =
      rawSourceType === "file" || rawSourceType === "link" || rawSourceType === "text"
        ? rawSourceType
        : rawSourceType === "blank"
          ? "text"
          : "text"
    const normalizedManifest = normalizePrdManifest(item.prdManifest)
    return {
      ...item,
      threadIds: normalizedThreadIds,
      needDesign: normalizeNeedDesign(item.needDesign),
      source: {
        ...item.source,
        type: sourceType
      },
      prdManifest: normalizedManifest
    }
  })
  if (normalized.some((item, index) => JSON.stringify(item) !== JSON.stringify(list[index]))) {
    await writeRequirementIndex(normalized)
  }
  return normalized
}

async function writeRequirementIndex(list: RequirementIndexItem[]): Promise<void> {
  const indexPath = path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME)
  const existing = await readJson<RequirementsIndexFile>(indexPath, {})
  await writeJson(indexPath, {
    ...(existing.token ? { token: existing.token } : {}),
    ...(existing.lastWorkDir ? { lastWorkDir: existing.lastWorkDir } : {}),
    list
  })
}

type RequirementFunctionHtmlPayload = {
  reqId?: string
  workspacePath: string
  requirementFilePath: string
  htmlFile?: string
  htmlId?: string
}

function normalizeManifestFilePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "")
}

function resolveRequirementFunction(
  manifest: IndexedPrdManifest,
  workspacePath: string,
  requirementFilePath: string
): { index: number; relativePath: string } {
  const workspace = path.resolve(workspacePath)
  const requirementFile = path.resolve(requirementFilePath)
  const relative = path.relative(workspace, requirementFile)
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("需求文件不在指定工作区内")
  }
  const relativePath = normalizeManifestFilePath(relative)
  let matches = manifest.functions
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => normalizeManifestFilePath(item.file) === relativePath)
  if (matches.length === 0) {
    const filename = path.basename(requirementFile)
    matches = manifest.functions
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => path.basename(normalizeManifestFilePath(item.file)) === filename)
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "未找到对应的功能" : "存在多个同名功能，无法安全更新")
  }
  return { index: matches[0].index, relativePath }
}

async function findRequirementByWorkspace(workspacePath: string): Promise<{
  list: RequirementIndexItem[]
  index: number
  item: RequirementIndexItem
}> {
  const list = await readRequirementIndex()
  const workspace = path.resolve(workspacePath)
  const matches = list
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => getRequirementRoot(item) === workspace)
  if (matches.length !== 1) throw new Error("无法唯一定位需求工作区")
  return { list, ...matches[0] }
}

async function getRequirementFunctionHtml(payload: RequirementFunctionHtmlPayload): Promise<{
  htmlFile: string
  htmlId: string
}> {
  const { item } = await findRequirementByWorkspace(payload.workspacePath)
  const manifestResult = await readWorkspaceManifest(item)
  if (manifestResult.status !== "ok") throw new Error("无法读取需求 Manifest")
  const match = resolveRequirementFunction(
    manifestResult.manifest,
    payload.workspacePath,
    payload.requirementFilePath
  )
  const functionInfo = manifestResult.manifest.functions[match.index]
  return { htmlFile: functionInfo.htmlFile, htmlId: functionInfo.htmlId }
}

async function updateRequirementFunctionHtml(
  payload: RequirementFunctionHtmlPayload,
  requirement: Awaited<ReturnType<typeof findRequirementByWorkspace>>
): Promise<{
  htmlFile: string
  htmlId: string
}> {
  const htmlId = payload.htmlId?.trim() || ""
  if (!htmlId) throw new Error("设计会话无效")
  const { list, index, item } = requirement
  const manifestResult = await readWorkspaceManifest(item)
  if (manifestResult.status !== "ok") throw new Error("无法读取需求 Manifest")
  const match = resolveRequirementFunction(
    manifestResult.manifest,
    payload.workspacePath,
    payload.requirementFilePath
  )
  const rawFunctions = manifestResult.raw.functions as unknown[]
  const rawFunction: Record<string, unknown> = isRecord(rawFunctions[match.index])
    ? (rawFunctions[match.index] as Record<string, unknown>)
    : {}
  const existingHtmlFile = manifestResult.manifest.functions[match.index].htmlFile
  const htmlFile = payload.htmlFile?.trim() ? path.resolve(payload.htmlFile) : existingHtmlFile
  if (payload.htmlFile?.trim()) {
    try {
      if (!(await fs.stat(htmlFile)).isFile()) throw new Error("HTML 文件无效")
    } catch (error) {
      if (error instanceof Error && error.message === "HTML 文件无效") throw error
      throw new Error("HTML 文件不存在或无法访问")
    }
  }
  const updatedRaw = {
    ...manifestResult.raw,
    functions: rawFunctions.map((entry, entryIndex) =>
      entryIndex === match.index ? { ...rawFunction, htmlFile, htmlId, needDesign: "1" } : entry
    )
  }
  const updatedManifest = normalizePrdManifest(updatedRaw)
  const manifestPath = getRequirementPrdPath(item)
  try {
    await writeJsonAtomic(manifestPath, updatedRaw)
    list[index] = { ...item, prdManifest: updatedManifest, updatedAt: new Date().toISOString() }
    await writeRequirementIndex(list)
  } catch (error) {
    // Roll back only our own write. Never overwrite a newer external manifest edit.
    const current = await readJson<unknown>(manifestPath, null)
    if (JSON.stringify(current) === JSON.stringify(updatedRaw)) {
      await writeJsonAtomic(manifestPath, manifestResult.raw).catch(() => undefined)
    }
    throw error
  }
  return { htmlFile, htmlId }
}

async function readRequirementToken(): Promise<string> {
  await ensureRequirementDirs()
  const data = await readJson<RequirementsIndexFile>(
    path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME),
    {}
  )
  return typeof data.token === "string" ? data.token.trim() : ""
}

async function saveRequirementToken(token: string): Promise<void> {
  const normalized = token.trim()
  if (!normalized) throw new Error("Token 不能为空")
  await ensureRequirementDirs()
  const indexPath = path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME)
  const existing = await readJson<RequirementsIndexFile>(indexPath, {})
  await writeJson(indexPath, { ...existing, token: normalized, list: existing.list ?? [] })
}

async function getLastRequirementWorkDir(): Promise<string | null> {
  await ensureRequirementDirs()
  const index = await readJson<RequirementsIndexFile>(
    path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME),
    {}
  )
  const workDir = index.lastWorkDir?.trim()
  if (!workDir) return null
  try {
    const resolvedPath = path.resolve(workDir)
    if (!(await fs.stat(resolvedPath)).isDirectory()) return null
    return resolvedPath
  } catch {
    return null
  }
}

async function saveLastRequirementWorkDir(workDir: string): Promise<void> {
  await ensureRequirementDirs()
  const indexPath = path.join(getRequirementsRoot(), REQUIREMENTS_INDEX_FILENAME)
  const existing = await readJson<RequirementsIndexFile>(indexPath, {})
  await writeJson(indexPath, {
    ...existing,
    lastWorkDir: workDir,
    list: existing.list ?? []
  })
}

async function resolveRequirementWorkDir(workDir: unknown): Promise<string> {
  if (typeof workDir !== "string" || !workDir.trim()) {
    throw new Error("请选择需求工作目录")
  }
  const resolvedPath = path.resolve(workDir.trim())
  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(resolvedPath)
  } catch {
    throw new Error("所选需求工作目录不可用")
  }
  if (!stats.isDirectory()) {
    throw new Error("所选需求工作目录不是文件夹")
  }
  return resolvedPath
}

async function selectRequirementWorkDir(): Promise<string | null> {
  const lastWorkDir = await getLastRequirementWorkDir()
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "选择需求工作目录",
    message: "每个需求会在此目录的 requirements 文件夹中独立归档",
    ...(lastWorkDir ? { defaultPath: lastWorkDir } : {})
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const workDir = await resolveRequirementWorkDir(result.filePaths[0])
  await saveLastRequirementWorkDir(workDir)
  return workDir
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function createEmptyPrdManifest(): IndexedPrdManifest {
  return {
    prd: {
      name: "",
      status: "",
      description: "",
      file: "",
      currentStep: 1,
      needDesign: ""
    },
    functions: []
  }
}

function readManifestString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : ""
}

function normalizeNeedDesign(value: unknown): NeedDesignChoice {
  if (value === "1" || value === "0") return value
  return ""
}

function normalizePrdManifest(value: unknown): IndexedPrdManifest {
  const source = isRecord(value) ? value : {}
  const prd = isRecord(source.prd) ? source.prd : {}
  const normalized = createEmptyPrdManifest()
  const status = readManifestString(prd, "status").trim().toLowerCase()
  const prDetailUrl = readManifestString(prd, "prDetailUrl")
  const normalizedStatus =
    status === "init" || status === "draft" || status === "generated" || status === "published"
      ? status
      : ""
  const fallbackStep =
    normalizedStatus === "published"
      ? 5
      : normalizedStatus === "generated"
        ? 3
        : normalizedStatus === "init" || normalizedStatus === "draft"
          ? 2
          : 1
  normalized.prd = {
    name: readManifestString(prd, "name"),
    status: normalizedStatus,
    description: readManifestString(prd, "description"),
    file: readManifestString(prd, "file"),
    currentStep:
      typeof prd.currentStep === "number" && Number.isFinite(prd.currentStep)
        ? Math.max(1, Math.min(5, Math.trunc(prd.currentStep)))
        : fallbackStep,
    needDesign: normalizeNeedDesign(prd.needDesign),
    ...(prDetailUrl ? { prDetailUrl } : {})
  }

  if (Array.isArray(source.functions)) {
    for (const entry of source.functions) {
      const functionInfo = isRecord(entry) ? entry : {}
      const id = readManifestString(functionInfo, "id")
      const keywords =
        Array.isArray(functionInfo.keywords) &&
        functionInfo.keywords.every((keyword) => typeof keyword === "string")
          ? [...functionInfo.keywords]
          : []
      normalized.functions.push({
        ...(id ? { id } : {}),
        fr: readManifestString(functionInfo, "fr"),
        name: readManifestString(functionInfo, "name"),
        description: readManifestString(functionInfo, "description"),
        file: readManifestString(functionInfo, "file"),
        keywords,
        htmlFile: readManifestString(functionInfo, "htmlFile"),
        htmlId: readManifestString(functionInfo, "htmlId"),
        needDesign: normalizeNeedDesign(functionInfo.needDesign)
      })
    }
  }

  return normalized
}

type WorkspaceManifestReadResult =
  | { status: "ok"; raw: Record<string, unknown>; manifest: IndexedPrdManifest }
  | { status: "missing" }
  | { status: "invalid"; error: string }

async function readWorkspaceManifest(
  item: RequirementIndexItem
): Promise<WorkspaceManifestReadResult> {
  const manifestPath = getRequirementPrdPath(item)
  let content: string
  try {
    content = await fs.readFile(manifestPath, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : "读取 Manifest 失败"
    }
  }
  try {
    const raw: unknown = JSON.parse(content)
    if (!isRecord(raw) || !isRecord(raw.prd) || !Array.isArray(raw.functions)) {
      return { status: "invalid", error: "Manifest 的 prd 或 functions 字段格式不正确" }
    }
    return { status: "ok", raw, manifest: normalizePrdManifest(raw) }
  } catch (error) {
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : "Manifest JSON 无效"
    }
  }
}

function mergeManifestState(
  raw: Record<string, unknown>,
  state: {
    needDesign: NeedDesignChoice
    currentStep: number
    functions: Array<{ fr: string; file: string; htmlFile: string; needDesign: NeedDesignChoice }>
  }
): Record<string, unknown> {
  const rawPrd = isRecord(raw.prd) ? raw.prd : {}
  const rawFunctions = Array.isArray(raw.functions) ? raw.functions : []
  return {
    ...raw,
    prd: { ...rawPrd, currentStep: state.currentStep, needDesign: state.needDesign },
    functions: rawFunctions.map((entry) => {
      const functionInfo = isRecord(entry) ? entry : {}
      const saved = state.functions.find(
        (item) =>
          item.fr === readManifestString(functionInfo, "fr") &&
          item.file === readManifestString(functionInfo, "file")
      )
      return saved
        ? { ...functionInfo, htmlFile: saved.htmlFile, needDesign: saved.needDesign }
        : functionInfo
    })
  }
}

async function convertRequirementSourceToMarkdown(sourcePath: string): Promise<string> {
  if (path.extname(sourcePath).toLocaleLowerCase() !== ".docx") {
    const preview = (await fs.readFile(sourcePath, "utf-8")).trim()
    validateTextContent(preview, "需求预览内容")
    return preview
  }

  const result = await (mammoth as MammothMarkdownConverter).convertToMarkdown({ path: sourcePath })
  const errors = result.messages.filter((message) => message.type === "error")
  if (errors.length > 0) {
    throw new Error(errors.map((message) => message.message).join("；"))
  }
  const preview = result.value.trim()
  validateTextContent(preview, "需求预览内容")
  return preview
}

async function readRequirementSourcePreview(item: RequirementIndexItem): Promise<string> {
  if (item.source.type === "text") {
    return item.source.initialDescription?.trim() || "暂无原始需求文件。"
  }
  const previewPath = getRequirementSourcePreviewPath(item)

  try {
    return (await fs.readFile(previewPath, "utf-8")).trim()
  } catch {
    const preview = await convertRequirementSourceToMarkdown(getRequirementSourcePath(item))
    await fs.writeFile(previewPath, `${preview}\n`, "utf-8")
    return preview
  }
}

async function isRequirementWorkspaceMissing(item: RequirementIndexItem): Promise<boolean> {
  try {
    return !(await fs.stat(getRequirementRoot(item))).isDirectory()
  } catch {
    return true
  }
}

async function getRequirementCoreFileStatus(
  item: RequirementIndexItem,
  workspaceMissing: boolean
): Promise<{ missing: boolean; reason: string | null }> {
  if (workspaceMissing) {
    return { missing: true, reason: "需求归档目录已被删除或不可用" }
  }
  if (item.source.type === "text") return { missing: false, reason: null }

  try {
    const sourceStats = await fs.stat(getRequirementSourcePath(item))
    if (!sourceStats.isFile()) {
      return { missing: true, reason: "原始需求文件已被删除或不可用" }
    }
  } catch {
    return { missing: true, reason: "原始需求文件已被删除或不可用" }
  }

  try {
    const prdStats = await fs.stat(getRequirementPrdDir(item))
    if (!prdStats.isDirectory()) {
      return { missing: true, reason: "PRD 文件夹已被删除或不可用" }
    }
  } catch {
    return { missing: true, reason: "PRD 文件夹已被删除或不可用" }
  }

  return { missing: false, reason: null }
}

async function toRuntimeRequirement(item: RequirementIndexItem): Promise<RequirementRuntimeItem> {
  const workspaceMissing = await isRequirementWorkspaceMissing(item)
  const coreFileStatus = await getRequirementCoreFileStatus(item, workspaceMissing)
  const prdManifest = normalizePrdManifest(item.prdManifest)
  return {
    ...item,
    requirementPath: getRequirementRoot(item),
    workspaceMissing,
    coreFilesMissing: coreFileStatus.missing,
    coreFilesMissingReason: coreFileStatus.reason,
    prdManifest
  }
}

async function createRequirement(
  payload: CreateRequirementPayload
): Promise<RequirementRuntimeItem> {
  const systemId = payload?.systemId?.trim()
  const title = payload?.title?.trim()
  const source = payload?.source
  if (!systemId || !title || !source?.type || (source.type !== "text" && !source.fileName)) {
    throw new Error("需求标题和需求来源不能为空")
  }
  const workDir = await resolveRequirementWorkDir(payload?.workDir)
  const primarySourceFileName = source.type === "text" ? "" : safeSegment(source.fileName, "source")
  const usedSourceFileNames = new Set(primarySourceFileName ? [primarySourceFileName] : [])
  const attachmentNames = (source.attachments ?? []).map((attachment, index) => {
    const safeName = safeSegment(attachment.fileName, `attachment-${index + 1}`)
    const extension = path.extname(safeName)
    const stem = extension ? safeName.slice(0, -extension.length) : safeName
    let uniqueName = safeName
    let suffix = 2
    while (usedSourceFileNames.has(uniqueName)) {
      uniqueName = `${stem}-${suffix}${extension}`
      suffix += 1
    }
    usedSourceFileNames.add(uniqueName)
    return uniqueName
  })

  const now = new Date().toISOString()
  const reqId = `req-${Date.now()}-${randomUUID().slice(0, 8)}`
  const item: RequirementIndexItem = {
    reqId,
    threadIds: [],
    systemId,
    title,
    requirementPath: getRequirementWorkspacePath(workDir, reqId, title),
    source: {
      type: source.type,
      fileName: primarySourceFileName,
      ...(attachmentNames.length ? { attachmentNames } : {}),
      ...(source.type === "link" ? { url: source.url?.trim() || null } : {}),
      ...(source.type === "text"
        ? { initialDescription: source.initialDescription?.trim() || "" }
        : {})
    },
    createdAt: now,
    updatedAt: now,
    prdManifest: createEmptyPrdManifest()
  }
  if (source.type !== "text") {
    const sourcePath = getRequirementSourcePath(item)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    if (typeof source.content === "string") {
      validateTextContent(source.content, "需求内容")
      await fs.writeFile(sourcePath, source.content, "utf-8")
    } else if (source.bytes) {
      const buffer = Buffer.from(source.bytes)
      if (buffer.byteLength === 0) throw new Error("选择的需求草稿内容为空")
      if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error("需求草稿超过 5MB 限制")
      await fs.writeFile(sourcePath, buffer)
    } else if (source.sourcePath?.trim()) {
      const sourceStat = await fs.stat(source.sourcePath)
      if (!sourceStat.isFile()) throw new Error("选择的需求草稿不是文件")
      await fs.copyFile(source.sourcePath, sourcePath)
    } else {
      throw new Error("缺少需要保存的需求内容")
    }

    const sourcePreview = await convertRequirementSourceToMarkdown(sourcePath)
    await fs.writeFile(getRequirementSourcePreviewPath(item), `${sourcePreview}\n`, "utf-8")
  }
  if (source.attachments?.length) {
    const sourceDirectory = path.join(getRequirementRoot(item), "source")
    await fs.mkdir(sourceDirectory, { recursive: true })
    for (const [index, attachment] of source.attachments.entries()) {
      const buffer = Buffer.from(attachment.bytes)
      if (buffer.byteLength === 0) throw new Error(`补充文件 ${index + 1} 内容为空`)
      if (buffer.byteLength > MAX_TEXT_BYTES)
        throw new Error(`补充文件 ${attachment.fileName} 超过 5MB 限制`)
      const fileName = attachmentNames[index]
      await fs.writeFile(path.join(sourceDirectory, fileName), buffer)
    }
  }
  await fs.mkdir(getRequirementPrdDir(item), { recursive: true })
  await saveLastRequirementWorkDir(workDir)
  const list = await readRequirementIndex()
  await writeRequirementIndex([item, ...list.filter((entry) => entry.reqId !== reqId)])
  return toRuntimeRequirement(item)
}

async function attachRequirementThread(
  reqId: string,
  threadId: string
): Promise<RequirementRuntimeItem> {
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === reqId)
  if (index < 0) throw new Error(`需求不存在：${reqId}`)
  const normalizedThreadId = threadId.trim()
  const currentThreadIds = getRequirementThreadIds(list[index])
  const next = {
    ...list[index],
    // Binding a thread only enables conversation. It is not a requirement content update.
    threadIds: normalizedThreadId
      ? Array.from(new Set([...currentThreadIds, normalizedThreadId]))
      : currentThreadIds
  }
  list[index] = next
  await writeRequirementIndex(list)
  return toRuntimeRequirement(next)
}

async function detachRequirementThread(
  reqId: string,
  threadId: string
): Promise<RequirementRuntimeItem> {
  const normalizedReqId = reqId?.trim()
  const normalizedThreadId = threadId?.trim()
  if (!normalizedReqId || !normalizedThreadId) throw new Error("需求编号和会话编号不能为空")
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === normalizedReqId)
  if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)
  const currentThreadIds = getRequirementThreadIds(list[index])
  const threadIds = currentThreadIds.filter((value) => value !== normalizedThreadId)
  const next = { ...list[index], threadIds }
  list[index] = next
  await writeRequirementIndex(list)
  return toRuntimeRequirement(next)
}

async function renameRequirement(reqId: string, title: string): Promise<RequirementRuntimeItem> {
  const normalizedReqId = reqId?.trim()
  const normalizedTitle = title?.trim()
  if (!normalizedReqId || !normalizedTitle) throw new Error("需求编号和名称不能为空")
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === normalizedReqId)
  if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)
  const next = { ...list[index], title: normalizedTitle, updatedAt: new Date().toISOString() }
  list[index] = next
  await writeRequirementIndex(list)
  return toRuntimeRequirement(next)
}

async function saveRequirementStepState(
  reqId: string,
  state: {
    needDesign: NeedDesignChoice
    currentStep: number
    functions: Array<{ fr: string; file: string; htmlFile: string; needDesign: NeedDesignChoice }>
  }
): Promise<{
  requirement: RequirementRuntimeItem
  manifestStatus: "updated" | "missing" | "invalid"
  manifest?: IndexedPrdManifest
  manifestError?: string
}> {
  const normalizedReqId = reqId?.trim()
  if (!normalizedReqId || !state) throw new Error("需求编号和步骤状态不能为空")
  if (!Number.isFinite(state.currentStep) || !Array.isArray(state.functions)) {
    throw new Error("步骤状态格式无效")
  }
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === normalizedReqId)
  if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)
  const requestedStep = Math.max(1, Math.min(5, Math.trunc(state.currentStep)))
  const workspaceManifest = await readWorkspaceManifest(list[index])
  const reachedStep = Math.max(
    requestedStep,
    normalizePrdManifest(list[index].prdManifest).prd.currentStep,
    workspaceManifest.status === "ok" ? workspaceManifest.manifest.prd.currentStep : 1
  )
  let indexedManifest = normalizePrdManifest(list[index].prdManifest)
  let manifestStatus: "updated" | "missing" | "invalid" =
    workspaceManifest.status === "ok" ? "updated" : workspaceManifest.status
  let manifestError: string | undefined
  if (workspaceManifest.status === "ok") {
    const mergedRaw = mergeManifestState(workspaceManifest.raw, {
      ...state,
      currentStep: reachedStep
    })
    await writeJsonAtomic(getRequirementPrdPath(list[index]), mergedRaw)
    indexedManifest = normalizePrdManifest(mergedRaw)
    manifestStatus = "updated"
  } else if (workspaceManifest.status === "invalid") {
    manifestError = workspaceManifest.error
    indexedManifest = {
      ...indexedManifest,
      prd: { ...indexedManifest.prd, currentStep: reachedStep, needDesign: state.needDesign },
      functions: indexedManifest.functions.map((functionInfo) => {
        const saved = state.functions.find(
          (item) => item.fr === functionInfo.fr && item.file === functionInfo.file
        )
        return saved
          ? { ...functionInfo, htmlFile: saved.htmlFile, needDesign: saved.needDesign }
          : functionInfo
      })
    }
  } else {
    indexedManifest = {
      ...indexedManifest,
      prd: { ...indexedManifest.prd, currentStep: reachedStep, needDesign: state.needDesign },
      functions: indexedManifest.functions.map((functionInfo) => {
        const saved = state.functions.find(
          (item) => item.fr === functionInfo.fr && item.file === functionInfo.file
        )
        return saved
          ? { ...functionInfo, htmlFile: saved.htmlFile, needDesign: saved.needDesign }
          : functionInfo
      })
    }
  }
  if (state.needDesign === "1" && reachedStep >= 4) {
    await fs.mkdir(path.join(getRequirementPrdDir(list[index]), "原型设计"), { recursive: true })
  }
  const next: RequirementIndexItem = {
    ...list[index],
    updatedAt: new Date().toISOString(),
    needDesign: state.needDesign,
    prdManifest: indexedManifest
  }
  list[index] = next
  await writeRequirementIndex(list)
  return {
    requirement: await toRuntimeRequirement(next),
    manifestStatus,
    ...(manifestStatus === "updated" ? { manifest: indexedManifest } : {}),
    ...(manifestError ? { manifestError } : {})
  }
}

async function saveRequirementPrd(payload: SavePrdPayload): Promise<RequirementRuntimeItem> {
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === payload?.reqId)
  if (index < 0) throw new Error(`需求不存在：${payload?.reqId ?? ""}`)
  if (!payload.version?.trim() || !Array.isArray(payload.modules)) {
    throw new Error("PRD 版本和模块不能为空")
  }

  const item = list[index]
  const prdDir = getRequirementPrdDir(item)
  await fs.mkdir(prdDir, { recursive: true })
  const modules: GeneratedRequirementModule[] = []
  for (const module of payload.modules) {
    const moduleId = safeSegment(module.moduleId, "module")
    const name = module.name?.trim() || moduleId
    validateTextContent(module.content, `模块 ${name}`)
    const fileName = `${moduleId}-${safeSegment(name, "module")}.md`
    await fs.writeFile(path.join(prdDir, fileName), module.content, "utf-8")
    modules.push({
      moduleId,
      name,
      filePath: fileName,
      description: module.description?.trim() ?? "",
      keywords: Array.isArray(module.keywords)
        ? module.keywords.filter((keyword): keyword is string => typeof keyword === "string")
        : []
    })
  }
  const prdManifest: IndexedPrdManifest = {
    prd: {
      name: item.title,
      status: "generated",
      description: "",
      file: modules[0]?.filePath ?? "",
      currentStep: 3,
      needDesign: ""
    },
    functions: modules.map((module) => ({
      fr: module.moduleId,
      name: module.name,
      description: module.description,
      file: module.filePath,
      keywords: module.keywords,
      htmlFile: "",
      htmlId: "",
      needDesign: ""
    }))
  }
  await writeJson(getRequirementPrdPath(item), prdManifest)
  const next: RequirementIndexItem = {
    ...item,
    updatedAt: new Date().toISOString(),
    prdManifest
  }
  list[index] = next
  await writeRequirementIndex(list)
  return toRuntimeRequirement(next)
}

async function listRequirements(): Promise<RequirementRuntimeItem[]> {
  return Promise.all((await readRequirementIndex()).map(toRuntimeRequirement))
}

type SyncRequirementManifestPayload = {
  reqId: string
  manifest: unknown
  threadId?: string
  requestId?: string
}

type BeginRequirementManifestSyncPayload = {
  reqId: string
  threadId: string
  requestId: string
}

const latestManifestRequestByRequirement = new Map<
  string,
  { threadId: string; requestId: string }
>()

const manifestOperationQueues = new Map<string, Promise<void>>()

function enqueueManifestOperation<T>(reqId: string, operation: () => Promise<T>): Promise<T> {
  const previous = manifestOperationQueues.get(reqId) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  const queued = next.then(
    () => {
      if (manifestOperationQueues.get(reqId) === queued) manifestOperationQueues.delete(reqId)
    },
    () => {
      if (manifestOperationQueues.get(reqId) === queued) manifestOperationQueues.delete(reqId)
    }
  )
  manifestOperationQueues.set(reqId, queued)
  return next
}

async function beginRequirementManifestSync(
  payload: BeginRequirementManifestSyncPayload
): Promise<void> {
  const normalizedReqId = payload?.reqId?.trim()
  const normalizedThreadId = payload?.threadId?.trim()
  if (!normalizedReqId || !normalizedThreadId || !payload.requestId?.trim()) {
    throw new Error("manifest 请求参数无效")
  }
  await enqueueManifestOperation(normalizedReqId, async () => {
    const item = (await readRequirementIndex()).find((entry) => entry.reqId === normalizedReqId)
    if (!item) throw new Error(`需求不存在：${normalizedReqId}`)
    if (!getRequirementThreadIds(item).includes(normalizedThreadId)) {
      throw new Error("会话未绑定到该需求")
    }
    latestManifestRequestByRequirement.set(normalizedReqId, {
      threadId: normalizedThreadId,
      requestId: payload.requestId.trim()
    })
  })
}

async function syncRequirementManifest(
  payload: SyncRequirementManifestPayload
): Promise<RequirementRuntimeItem> {
  const normalizedReqId = payload?.reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")
  return enqueueManifestOperation(normalizedReqId, async () => {
    const list = await readRequirementIndex()
    const index = list.findIndex((entry) => entry.reqId === normalizedReqId)
    if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)
    const normalizedThreadId = payload.threadId?.trim()
    if (normalizedThreadId) {
      if (!getRequirementThreadIds(list[index]).includes(normalizedThreadId)) {
        throw new Error("会话未绑定到该需求")
      }
      if (
        !payload.requestId?.trim() ||
        latestManifestRequestByRequirement.get(normalizedReqId)?.threadId !== normalizedThreadId ||
        latestManifestRequestByRequirement.get(normalizedReqId)?.requestId !==
          payload.requestId.trim()
      ) {
        throw new Error("manifest 请求已过期")
      }
    }

    // Loading a conversation is a read-only operation for the workspace manifest.
    // Normalize the file contents for the UI/index mirror, but never merge stale index
    // values back into the file or write the file from this query path.
    const manifest = normalizePrdManifest(payload.manifest)
    const next = {
      ...list[index],
      needDesign: manifest.prd.needDesign,
      prdManifest: manifest
    }
    if (JSON.stringify(next) !== JSON.stringify(list[index])) {
      list[index] = next
      await writeRequirementIndex(list)
    }
    return toRuntimeRequirement(next)
  })
}

async function getRequirementSourcePreview(reqId: string): Promise<string> {
  const normalizedReqId = reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")

  const item = (await readRequirementIndex()).find((entry) => entry.reqId === normalizedReqId)
  if (!item) throw new Error(`需求不存在：${normalizedReqId}`)
  return readRequirementSourcePreview(item)
}

function getRequirementDeletionRoot(item: RequirementIndexItem): string {
  const requirementRoot = getRequirementRoot(item)
  const requirementsRoot = item.requirementPath?.trim()
    ? path.dirname(requirementRoot)
    : getRequirementsRoot()
  const safeRoot = ensureWorkspaceChild(requirementsRoot, requirementRoot)
  if (safeRoot === path.resolve(requirementsRoot)) {
    throw new Error("需求目录映射无效，拒绝删除工作目录")
  }
  return safeRoot
}

async function deleteRequirement(reqId: string): Promise<void> {
  const normalizedReqId = reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")

  const list = await readRequirementIndex()
  const item = list.find((entry) => entry.reqId === normalizedReqId)
  if (!item) throw new Error(`需求不存在：${normalizedReqId}`)

  // Keep the mapping until its files are gone so a failed deletion can be retried safely.
  await fs.rm(getRequirementDeletionRoot(item), { recursive: true, force: true, maxRetries: 2 })
  await writeRequirementIndex(list.filter((entry) => entry.reqId !== normalizedReqId))
}

async function openRequirementWorkDir(reqId: string): Promise<void> {
  const normalizedReqId = reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")

  const item = (await readRequirementIndex()).find((entry) => entry.reqId === normalizedReqId)
  if (!item) throw new Error(`需求不存在：${normalizedReqId}`)

  const requirementRoot = getRequirementDeletionRoot(item)
  if (await isRequirementWorkspaceMissing(item)) {
    throw new Error("需求工作目录已被删除或不可用")
  }
  const error = await shell.openPath(requirementRoot)
  if (error) throw new Error(error)
}

function ensureWorkspaceChild(workspacePath: string, childPath: string): string {
  const workspaceRoot = path.resolve(workspacePath)
  const resolvedChild = path.resolve(childPath)
  const relative = path.relative(workspaceRoot, resolvedChild)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("需求文件保存路径超出工作目录")
  }
  return resolvedChild
}

export function registerRequirementHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("requirements:list", async () => listRequirements())
  ipcMain.handle("requirements:get-token", async () => {
    try {
      return { success: true, token: await readRequirementToken() }
    } catch (error) {
      return {
        success: false,
        token: "",
        error: error instanceof Error ? error.message : "读取 Token 失败"
      }
    }
  })
  ipcMain.handle("requirements:save-token", async (_event, token: string) => {
    try {
      await saveRequirementToken(token)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "保存 Token 失败" }
    }
  })
  ipcMain.handle("requirements:get-work-dir", async () => getLastRequirementWorkDir())
  ipcMain.handle("requirements:select-work-dir", async () => {
    try {
      return { success: true, workDir: await selectRequirementWorkDir() }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "选择需求工作目录失败"
      }
    }
  })
  ipcMain.handle("requirements:create", async (_event, payload: CreateRequirementPayload) => {
    try {
      return { success: true, requirement: await createRequirement(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "创建需求失败" }
    }
  })
  ipcMain.handle("requirements:delete", async (_event, reqId: string) => {
    try {
      await deleteRequirement(reqId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "删除需求失败" }
    }
  })
  ipcMain.handle("requirements:open-work-dir", async (_event, reqId: string) => {
    try {
      await openRequirementWorkDir(reqId)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "打开需求工作目录失败"
      }
    }
  })
  ipcMain.handle("requirements:get-source-preview", async (_event, reqId: string) => {
    try {
      return { success: true, content: await getRequirementSourcePreview(reqId) }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "读取原始需求预览失败"
      }
    }
  })
  ipcMain.handle(
    "requirements:attach-thread",
    async (_event, { reqId, threadId }: { reqId: string; threadId: string }) => {
      try {
        return { success: true, requirement: await attachRequirementThread(reqId, threadId) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "保存需求会话失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:detach-thread",
    async (_event, { reqId, threadId }: { reqId: string; threadId: string }) => {
      try {
        return { success: true, requirement: await detachRequirementThread(reqId, threadId) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "删除需求会话绑定失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:rename",
    async (_event, { reqId, title }: { reqId: string; title: string }) => {
      try {
        return { success: true, requirement: await renameRequirement(reqId, title) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "重命名需求失败" }
      }
    }
  )
  ipcMain.handle(
    "requirements:save-step-state",
    async (
      _event,
      payload: {
        reqId: string
        needDesign: NeedDesignChoice
        currentStep: number
        functions: Array<{
          fr: string
          file: string
          htmlFile: string
          needDesign: NeedDesignChoice
        }>
      }
    ) => {
      try {
        const saved = await enqueueManifestOperation(payload.reqId, () =>
          saveRequirementStepState(payload.reqId, payload)
        )
        return {
          success: true,
          ...saved
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "保存原型流程状态失败"
        }
      }
    }
  )
  ipcMain.handle("requirements:save-prd", async (_event, payload: SavePrdPayload) => {
    try {
      return { success: true, requirement: await saveRequirementPrd(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "保存 PRD 失败" }
    }
  })
  ipcMain.handle(
    "requirements:save-prd-file",
    async (_event, payload: { reqId: string; filePath: string; content: string }) => {
      try {
        const reqId = payload?.reqId?.trim()
        const filePath = payload?.filePath?.trim().replace(/\\/g, "/")
        if (!reqId || !filePath || typeof payload.content !== "string") {
          return { success: false, error: "需求编号、文件路径和内容不能为空" }
        }
        if (!filePath.toLowerCase().endsWith(".md")) {
          return { success: false, error: "仅支持编辑 Markdown 文件" }
        }
        validateTextContent(payload.content, "PRD 内容")
        const item = (await readRequirementIndex()).find((entry) => entry.reqId === reqId)
        if (!item) return { success: false, error: `需求不存在：${reqId}` }

        const prdRoot = await fs.realpath(getRequirementPrdDir(item))
        const relativePath = filePath.replace(/^\/+/, "").replace(/^prd\//i, "")
        const requestedPath = path.resolve(prdRoot, relativePath)
        const targetPath = await fs.realpath(requestedPath)
        if (targetPath !== prdRoot && !targetPath.startsWith(`${prdRoot}${path.sep}`)) {
          return { success: false, error: "文件路径超出当前需求的 PRD 目录" }
        }
        await fs.writeFile(targetPath, payload.content, "utf-8")
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "保存 PRD 文件失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:get-function-html",
    async (_event, payload: RequirementFunctionHtmlPayload) => {
      try {
        return { success: true, ...(await getRequirementFunctionHtml(payload)) }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "读取原型绑定失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:update-function-html",
    async (_event, payload: RequirementFunctionHtmlPayload) => {
      try {
        const reqId = payload.reqId?.trim()
        if (!reqId) throw new Error("需求 ID 无效")
        const updated = await enqueueManifestOperation(reqId, async () => {
          const requirement = await findRequirementByWorkspace(payload.workspacePath)
          if (requirement.item.reqId !== reqId) throw new Error("需求工作区与需求 ID 不匹配")
          return updateRequirementFunctionHtml(payload, requirement)
        })
        return { success: true, ...updated }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "更新原型绑定失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:begin-manifest-sync",
    async (_event, payload: BeginRequirementManifestSyncPayload) => {
      try {
        await beginRequirementManifestSync(payload)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "开始同步 PRD manifest 失败"
        }
      }
    }
  )
  ipcMain.handle(
    "requirements:sync-manifest",
    async (_event, payload: SyncRequirementManifestPayload) => {
      try {
        const requirement = await syncRequirementManifest(payload)
        return {
          success: true,
          requirement,
          manifest: normalizePrdManifest(payload.manifest)
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "同步 PRD manifest 失败"
        }
      }
    }
  )

  // Kept for callers from the first filesystem implementation.
  ipcMain.handle(
    "requirements:save-files",
    async (
      _event,
      payload: SaveRequirementFilesPayload
    ): Promise<{
      success: boolean
      sourcePath?: string
      prdPath?: string
      error?: string
    }> => {
      try {
        const workspacePath =
          typeof payload?.workspacePath === "string" ? payload.workspacePath.trim() : ""
        const requirementId =
          typeof payload?.requirementId === "string" ? payload.requirementId.trim() : ""
        if (!workspacePath || !requirementId) {
          return { success: false, error: "工作目录和需求编号不能为空" }
        }
        const workspaceRoot = path.resolve(workspacePath)
        const workspaceStat = await fs.stat(workspaceRoot)
        if (!workspaceStat.isDirectory()) {
          return { success: false, error: "所选工作目录不可用" }
        }
        const requirementDir = ensureWorkspaceChild(
          workspaceRoot,
          path.join(workspaceRoot, "requirements", safeSegment(requirementId, "requirement"))
        )
        await fs.mkdir(requirementDir, { recursive: true })

        let sourcePath: string | undefined
        if (payload.source) {
          const filename = safeSegment(payload.source.filename, "原始需求.md")
          sourcePath = ensureWorkspaceChild(workspaceRoot, path.join(requirementDir, filename))
          if (typeof payload.source.content === "string") {
            validateTextContent(payload.source.content, "需求内容")
            await fs.writeFile(sourcePath, payload.source.content, "utf-8")
          } else if (payload.source.sourcePath?.trim()) {
            const sourceStat = await fs.stat(payload.source.sourcePath)
            if (!sourceStat.isFile()) {
              return { success: false, error: "选择的需求草稿不是文件" }
            }
            await fs.copyFile(payload.source.sourcePath, sourcePath)
          } else {
            return { success: false, error: "缺少需要保存的需求内容" }
          }
        }

        let prdPath: string | undefined
        if (payload.prd) {
          const filename = safeSegment(payload.prd.filename, "规范PRD.md")
          prdPath = ensureWorkspaceChild(workspaceRoot, path.join(requirementDir, filename))
          validateTextContent(payload.prd.content, "PRD 内容")
          await fs.writeFile(prdPath, payload.prd.content, "utf-8")
        }
        return { success: true, sourcePath, prdPath }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "保存需求文件失败"
        }
      }
    }
  )
}
