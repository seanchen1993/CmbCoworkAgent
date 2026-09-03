import { type IpcMain, dialog, shell } from "electron"
import * as fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import mammoth from "mammoth"
import { getOpenworkDir } from "../storage"

type RequirementSourceType = "file" | "text" | "link"
type RequirementStatus = "draft" | "normalized" | "delivered"

export type RequirementSource = {
  type: RequirementSourceType
  fileName: string
  url?: string | null
  initialDescription?: string
}

export type RequirementIndexItem = {
  reqId: string
  threadId: string | null
  /** All conversations belonging to this requirement. threadId remains for legacy readers. */
  threadIds?: string[]
  systemId: string
  title: string
  requirementPath?: string
  source: RequirementSource
  status: RequirementStatus
  createdAt: string
  updatedAt: string
  prdGenerated?: boolean
  prdManifest?: IndexedPrdManifest
}

export type IndexedPrdManifest = {
  prd: {
    name: string
    status: "" | "init" | "draft" | "generated" | "published"
    description: string
    file: string
    prDetailUrl?: string
  }
  functions: Array<{
    fr: string
    name: string
    description: string
    file: string
    keywords: string[]
  }>
}

export type RequirementRuntimeItem = RequirementIndexItem & {
  requirementPath: string
  workspaceMissing: boolean
  coreFilesMissing: boolean
  coreFilesMissingReason: string | null
  prdGenerated: boolean
  prdManifest: IndexedPrdManifest
}

export type RequirementPrdPreview = {
  generated: boolean
  filePath: string | null
  fileName: string | null
  content: string
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
    initialDescription?: string
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
const PRD_PREVIEW_FILENAME = "full-prd.md"
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

function getRequirementThreadIds(
  item: Pick<RequirementIndexItem, "threadId" | "threadIds">
): string[] {
  return [
    ...new Set(
      [...(item.threadId ? [item.threadId] : []), ...(item.threadIds ?? [])]
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
    const item = { ...rawItem }
    const normalizedThreadIds = getRequirementThreadIds(item)
    delete item.workDir
    delete item.prdVersion
    delete item.prdPublished
    delete item.prdManifestSynced
    const rawSourceType = (item.source as { type?: unknown } | undefined)?.type
    const sourceType: RequirementSourceType =
      rawSourceType === "file" || rawSourceType === "link" || rawSourceType === "text"
        ? rawSourceType
        : rawSourceType === "blank"
          ? "text"
          : "text"
    return {
      ...item,
      threadId: normalizedThreadIds[0] ?? null,
      threadIds: normalizedThreadIds,
      source: {
        ...item.source,
        type: sourceType
      },
      prdGenerated: item.prdGenerated === true,
      prdManifest: normalizePrdManifest(item.prdManifest)
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
      file: ""
    },
    functions: []
  }
}

function readManifestString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : ""
}

function normalizePrdManifest(value: unknown): IndexedPrdManifest {
  const source = isRecord(value) ? value : {}
  const prd = isRecord(source.prd) ? source.prd : {}
  const normalized = createEmptyPrdManifest()
  const status = readManifestString(prd, "status").trim().toLowerCase()
  const prDetailUrl = readManifestString(prd, "prDetailUrl")
  normalized.prd = {
    name: readManifestString(prd, "name"),
    status:
      status === "init" || status === "draft" || status === "generated" || status === "published"
        ? status
        : "",
    description: readManifestString(prd, "description"),
    file: readManifestString(prd, "file"),
    ...(prDetailUrl ? { prDetailUrl } : {})
  }

  if (Array.isArray(source.functions)) {
    for (const entry of source.functions) {
      const functionInfo = isRecord(entry) ? entry : {}
      const keywords =
        Array.isArray(functionInfo.keywords) &&
        functionInfo.keywords.every((keyword) => typeof keyword === "string")
          ? [...functionInfo.keywords]
          : []
      normalized.functions.push({
        fr: readManifestString(functionInfo, "fr"),
        name: readManifestString(functionInfo, "name"),
        description: readManifestString(functionInfo, "description"),
        file: readManifestString(functionInfo, "file"),
        keywords
      })
    }
  }

  return normalized
}

function isPrdGenerated(manifest: IndexedPrdManifest): boolean {
  return manifest.prd.status === "generated"
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

async function readRequirementPrdPreview(
  item: RequirementIndexItem
): Promise<RequirementPrdPreview> {
  try {
    const filePath = path.join(getRequirementPrdDir(item), PRD_PREVIEW_FILENAME)
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) {
      return { generated: false, filePath: null, fileName: null, content: "" }
    }
    const content = (await fs.readFile(filePath, "utf-8")).trim()
    validateTextContent(content, "规范 PRD 预览内容")
    return { generated: true, filePath, fileName: PRD_PREVIEW_FILENAME, content }
  } catch {
    return { generated: false, filePath: null, fileName: null, content: "" }
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
    prdGenerated: isPrdGenerated(prdManifest),
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

  const now = new Date().toISOString()
  const reqId = `req-${Date.now()}-${randomUUID().slice(0, 8)}`
  const item: RequirementIndexItem = {
    reqId,
    threadId: null,
    threadIds: [],
    systemId,
    title,
    requirementPath: getRequirementWorkspacePath(workDir, reqId, title),
    source: {
      type: source.type,
      fileName: source.type === "text" ? "" : safeSegment(source.fileName, "source"),
      ...(source.type === "link" ? { url: source.url?.trim() || null } : {}),
      ...(source.type === "text"
        ? { initialDescription: source.initialDescription?.trim() || "" }
        : {})
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
    prdGenerated: false,
    prdManifest: createEmptyPrdManifest()
  }
  if (source.type !== "text") {
    const sourcePath = getRequirementSourcePath(item)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    if (typeof source.content === "string") {
      validateTextContent(source.content, "需求内容")
      await fs.writeFile(sourcePath, source.content, "utf-8")
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
    threadId: currentThreadIds[0] ?? (normalizedThreadId || null),
    threadIds: normalizedThreadId
      ? Array.from(new Set([...currentThreadIds, normalizedThreadId]))
      : currentThreadIds
  }
  list[index] = next
  await writeRequirementIndex(list)
  return toRuntimeRequirement(next)
}

async function detachRequirementThread(reqId: string, threadId: string): Promise<RequirementRuntimeItem> {
  const normalizedReqId = reqId?.trim()
  const normalizedThreadId = threadId?.trim()
  if (!normalizedReqId || !normalizedThreadId) throw new Error("需求编号和会话编号不能为空")
  const list = await readRequirementIndex()
  const index = list.findIndex((item) => item.reqId === normalizedReqId)
  if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)
  const currentThreadIds = getRequirementThreadIds(list[index])
  const threadIds = currentThreadIds.filter((value) => value !== normalizedThreadId)
  const next = { ...list[index], threadId: threadIds[0] ?? null, threadIds }
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
      file: PRD_PREVIEW_FILENAME
    },
    functions: modules.map((module) => ({
      fr: module.moduleId,
      name: module.name,
      description: module.description,
      file: module.filePath,
      keywords: module.keywords
    }))
  }
  await writeJson(getRequirementPrdPath(item), prdManifest)
  const prdPreview = [
    `# ${item.title} PRD`,
    "",
    `> 版本 ${payload.version.trim()} · 由 PRD Agent 生成`,
    "",
    ...modules.flatMap((module) => [
      `## ${module.name}`,
      "",
      payload.modules.find((entry) => safeSegment(entry.moduleId, "module") === module.moduleId)
        ?.content ?? ""
    ])
  ].join("\n")
  validateTextContent(prdPreview, "规范 PRD 内容")
  await fs.writeFile(
    path.join(getRequirementPrdDir(item), PRD_PREVIEW_FILENAME),
    `${prdPreview}\n`,
    "utf-8"
  )

  const next: RequirementIndexItem = {
    ...item,
    status: "normalized",
    updatedAt: new Date().toISOString(),
    prdGenerated: true,
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
}

async function syncRequirementManifest(
  payload: SyncRequirementManifestPayload
): Promise<RequirementRuntimeItem> {
  const normalizedReqId = payload?.reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")
  const list = await readRequirementIndex()
  const index = list.findIndex((entry) => entry.reqId === normalizedReqId)
  if (index < 0) throw new Error(`需求不存在：${normalizedReqId}`)

  const manifest = normalizePrdManifest(payload.manifest)
  list[index] = {
    ...list[index],
    prdGenerated: isPrdGenerated(manifest),
    prdManifest: manifest
  }
  await writeRequirementIndex(list)
  return toRuntimeRequirement(list[index])
}

async function getRequirementPrdPreview(reqId: string): Promise<RequirementPrdPreview> {
  const normalizedReqId = reqId?.trim()
  if (!normalizedReqId) throw new Error("需求编号不能为空")

  const item = (await readRequirementIndex()).find((entry) => entry.reqId === normalizedReqId)
  if (!item) throw new Error(`需求不存在：${normalizedReqId}`)
  return readRequirementPrdPreview(item)
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
  ipcMain.handle("requirements:get-prd-preview", async (_event, reqId: string) => {
    try {
      return { success: true, preview: await getRequirementPrdPreview(reqId) }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "读取规范 PRD 预览失败"
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
  ipcMain.handle("requirements:save-prd", async (_event, payload: SavePrdPayload) => {
    try {
      return { success: true, requirement: await saveRequirementPrd(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "保存 PRD 失败" }
    }
  })
  ipcMain.handle(
    "requirements:sync-manifest",
    async (_event, payload: SyncRequirementManifestPayload) => {
      try {
        return {
          success: true,
          requirement: await syncRequirementManifest(payload)
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
