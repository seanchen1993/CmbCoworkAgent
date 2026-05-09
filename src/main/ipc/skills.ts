import AdmZip from "adm-zip"
import { IpcMain } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import {
  getCustomSkillsDir,
  getDisabledSkills,
  getEnabledPluginSkillSourceMetadata,
  getSkillsDir,
  clearDisabledSkillsForSkillDir,
  invalidateEnabledSkillsCache,
  prepareDisabledSkillsCleanupForSkillDir,
  setDisabledSkills
} from "../storage"
import type { SkillMetadata } from "../types"
import { notifyHooksChanged } from "../hooks/notifications"
import {
  discoverSkills,
  makeFlattenedSkillDirName,
  normalizeSkillRelativePath
} from "../skills/discovery"
import { getDiscoveredSkillId, normalizeSkillId } from "../skills/ids"
import {
  decodeArchiveEntryName,
  normalizeArchiveEntryName,
  selectRootSkillMarkdownEntry
} from "../skills/archive"
import { parseYamlFrontmatter } from "../utils/skill-identifiers"

interface ZipEntryLike {
  entryName: string
  rawEntryName?: Buffer
  header?: {
    flags_efs?: boolean
  }
}

interface ZipEntryDataLike extends ZipEntryLike {
  isDirectory: boolean
  getData(): Buffer
}

interface DecodedZipEntry {
  entry: ZipEntryDataLike
  decodedName: string
}

function sanitizeSkillName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) ||
    name ||
    "skill"
  )
}

/**
 * 为路径比较做统一归一化：
 * 1) 先 resolve + normalize，消除 `.` / `..` 与分隔符差异；
 * 2) Windows 文件系统通常大小写不敏感，比较前统一转小写，避免仅大小写差异导致误判。
 */
function normalizePathForComparison(inputPath: string): string {
  const normalized = path.normalize(path.resolve(inputPath))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isPathUnderDir(targetPath: string, dirPath: string): boolean {
  const resolvedTarget = normalizePathForComparison(targetPath)
  const resolvedDir = normalizePathForComparison(dirPath)
  const rel = path.relative(resolvedDir, resolvedTarget)
  // `rel === ""` 代表 target 与 dir 完全相同，也视为在目录内。
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function isPathUnderAllowedDirs(filePath: string): boolean {
  return isPathUnderDir(filePath, getSkillsDir()) || isPathUnderDir(filePath, getCustomSkillsDir())
}

function getMimeTypeByPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".pdf":
      return "application/pdf"
    default:
      return "application/octet-stream"
  }
}

const CHARDET_CONFIDENCE_THRESHOLD = 0.6

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function decodeSkillTextFile(content: Buffer, filePath: string): string {
  if (content.length === 0) return ""

  // UTF BOM 明确优先，避免误判。
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    return content.toString("utf-8")
  }
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return iconv.decode(content, "utf-16le")
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return iconv.decode(content, "utf-16be")
  }

  const detected = chardet.detect(content)
  const detectedEncoding = typeof detected === "string" ? detected : detected?.encoding
  const confidence = typeof detected === "object" ? detected.confidence || 0 : 1
  const normalizedEncoding = String(detectedEncoding || "")
    .trim()
    .toLowerCase()

  if (isValidUtf8(content)) {
    return content.toString("utf-8")
  }

  if (
    normalizedEncoding &&
    normalizedEncoding !== "ascii" &&
    iconv.encodingExists(normalizedEncoding)
  ) {
    if (confidence >= CHARDET_CONFIDENCE_THRESHOLD || process.platform !== "win32") {
      try {
        return iconv.decode(content, normalizedEncoding)
      } catch {
        // fallback below
      }
    }
  }

  // Windows 下 CSV 常见 ANSI(GBK/GB18030)；当 UTF-8 无效时优先做兼容回退。
  if (process.platform === "win32" && path.extname(filePath).toLowerCase() === ".csv") {
    try {
      return iconv.decode(content, "gb18030")
    } catch {
      // fallback below
    }
  }

  if (
    normalizedEncoding &&
    normalizedEncoding !== "ascii" &&
    iconv.encodingExists(normalizedEncoding)
  ) {
    try {
      return iconv.decode(content, normalizedEncoding)
    } catch {
      // fallback below
    }
  }

  return content.toString("utf-8")
}

function normalizeZipEntryName(name: string): string {
  return normalizeArchiveEntryName(name)
}

function decodeZipEntryName(entry: ZipEntryLike): string {
  return decodeArchiveEntryName(entry)
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

function isSafePathSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false
  if (/[\\/:*?"<>|]/.test(name)) return false
  // Windows 文件名不允许以空格或点结尾
  if (/[. ]$/.test(name)) return false
  return true
}

function scoreDecodedName(name: string): number {
  let score = 0
  for (const ch of name) {
    if (/[\u3400-\u9fff]/.test(ch)) score += 4
    else if (/[A-Za-z0-9._\- ()[\]]/.test(ch)) score += 1
    else if (/[\u2500-\u259f]/.test(ch))
      // box drawing / block
      score -= 3
    else if (ch === "\uFFFD") score -= 4
  }
  return score
}

/**
 * 修复历史上可能出现的“zip 文件名被 cp437 误解码”导致的乱码名。
 * 只在“原名不含 CJK、候选名包含 CJK”时触发，尽量保守避免误改。
 */
function recoverMojibakePathSegment(name: string): string | null {
  if (!name || containsCjk(name) || !iconv.encodingExists("cp437")) return null
  try {
    const cp437Bytes = iconv.encode(name, "cp437")
    const candidates = [
      normalizeZipEntryName(iconv.decode(cp437Bytes, "utf-8")),
      normalizeZipEntryName(iconv.decode(cp437Bytes, "gb18030"))
    ]
    const valid = candidates.filter((candidate) => {
      if (!candidate || candidate === name) return false
      if (!containsCjk(candidate)) return false
      return isSafePathSegment(candidate)
    })
    if (valid.length === 0) return null

    let best = valid[0]
    let bestScore = scoreDecodedName(best)
    for (const candidate of valid.slice(1)) {
      const score = scoreDecodedName(candidate)
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    return best
  } catch {
    return null
  }
}

async function repairMojibakeNamesInSkillDir(skillDirPath: string): Promise<void> {
  if (process.platform !== "win32" || !iconv.encodingExists("cp437")) return

  const dirQueue: string[] = [skillDirPath]
  for (let i = 0; i < dirQueue.length; i++) {
    const currentDir = dirQueue[i]
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        dirQueue.push(path.join(currentDir, entry.name))
      }
    } catch {
      continue
    }
  }

  // 深层目录优先重命名，避免父目录先改名后子路径失效。
  dirQueue.sort((a, b) => b.length - a.length)

  for (const dirPath of dirQueue) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const recovered = recoverMojibakePathSegment(entry.name)
        if (!recovered || recovered === entry.name) continue
        const fromPath = path.join(dirPath, entry.name)
        const toPath = path.join(dirPath, recovered)
        if (existsSync(toPath)) continue
        try {
          await fs.rename(fromPath, toPath)
        } catch (renameError) {
          console.warn(`[Skills] Failed to repair mojibake filename "${entry.name}":`, renameError)
        }
      }
    } catch {
      continue
    }
  }
}

const MARKETPLACE_SKILL_METADATA_PATH = ".cmbcoworkagent/marketplace-skill.json"

interface MarketplaceSkillMetadata {
  nestedSkills?: Array<{ relativePath?: string; name?: string }>
}

interface SkillUploadOptions {
  allowNestedNameDuplicates?: boolean
}

interface SkillUploadNameConflict {
  name: string
  relativePath: string
}

interface SkillUploadResult {
  success: boolean
  skillName?: string
  error?: string
  nestedNameConflicts?: SkillUploadNameConflict[]
}

interface ExportForMarketOptions {
  includeNestedSkills?: boolean
}

function makeSafeZipFileName(rawName: string, relativePath?: string): string {
  const sanitized = rawName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  const normalizedRelativePath = normalizeSkillRelativePath(relativePath ?? "")
  const disambiguator = normalizedRelativePath.includes("/")
    ? makeFlattenedSkillDirName(normalizedRelativePath)
    : ""
  return `${sanitized || "skill"}${disambiguator ? `--${disambiguator}` : ""}.zip`
}

function normalizeSkillNameForComparison(name: string): string {
  return name.trim().toLowerCase()
}

function isMarketplaceSkillMetadataPath(relativePath: string): boolean {
  const normalized = normalizeSkillRelativePath(relativePath).toLowerCase()
  const metadataPath = MARKETPLACE_SKILL_METADATA_PATH.toLowerCase()
  return normalized === metadataPath || normalized.endsWith(`/${metadataPath}`)
}

function readMarketplaceSkillMetadataFromZip(
  decodedEntries: DecodedZipEntry[],
  basePrefix: string
): MarketplaceSkillMetadata | null {
  const metadataEntry = decodedEntries.find((item) => {
    if (item.entry.isDirectory || !item.decodedName.startsWith(basePrefix)) return false
    const relativePath = item.decodedName.slice(basePrefix.length)
    return (
      normalizeSkillRelativePath(relativePath).toLowerCase() ===
      MARKETPLACE_SKILL_METADATA_PATH.toLowerCase()
    )
  })
  if (!metadataEntry) return null

  try {
    const parsed = JSON.parse(metadataEntry.entry.getData().toString("utf-8"))
    if (!parsed || typeof parsed !== "object") return null
    return parsed as MarketplaceSkillMetadata
  } catch {
    return null
  }
}

function getNestedSkillNameCandidates(
  decodedEntries: DecodedZipEntry[],
  basePrefix: string,
  metadata: MarketplaceSkillMetadata | null
): Array<{ name: string; relativePath: string }> {
  const metadataNames = new Map<string, string>()
  for (const item of metadata?.nestedSkills || []) {
    const relativePath = normalizeSkillRelativePath(String(item?.relativePath || ""))
    const name = typeof item?.name === "string" ? item.name.trim() : ""
    if (relativePath && name) {
      metadataNames.set(relativePath, name)
    }
  }

  const candidates: Array<{ name: string; relativePath: string }> = []
  const seenRoots = new Set<string>()
  for (const item of decodedEntries) {
    if (item.entry.isDirectory || !item.decodedName.startsWith(basePrefix)) continue
    const relativePath = normalizeSkillRelativePath(item.decodedName.slice(basePrefix.length))
    if (!/(^|\/)SKILL\.md$/i.test(relativePath)) continue
    if (relativePath.toUpperCase() === "SKILL.MD") continue

    const root = normalizeSkillRelativePath(relativePath.replace(/\/SKILL\.md$/i, ""))
    if (!root || seenRoots.has(root)) continue
    seenRoots.add(root)

    let name = metadataNames.get(root) || ""
    if (!name) {
      try {
        const content = decodeSkillTextFile(item.entry.getData(), item.decodedName)
        name = parseYamlFrontmatter(content).name?.trim() || ""
      } catch {
        name = ""
      }
    }
    if (!name) {
      name = root.split("/").filter(Boolean).pop() || root
    }
    candidates.push({ name, relativePath: root })
  }

  return candidates
}

function findNestedSkillNameConflicts(
  nestedSkills: Array<{ name: string; relativePath: string }>,
  existingNames: Set<string>
): SkillUploadNameConflict[] {
  const conflicts: SkillUploadNameConflict[] = []
  const seen = new Set<string>()
  for (const skill of nestedSkills) {
    const normalizedName = normalizeSkillNameForComparison(skill.name)
    if (!normalizedName || !existingNames.has(normalizedName) || seen.has(normalizedName)) continue
    seen.add(normalizedName)
    conflicts.push({ name: skill.name, relativePath: skill.relativePath })
  }
  return conflicts
}

function getExportSkillRelativePath(skillDir: string): string {
  const resolvedSkillDir = path.resolve(skillDir)
  for (const sourceDir of [getCustomSkillsDir(), getSkillsDir()]) {
    const resolvedSource = path.resolve(sourceDir)
    if (!isPathUnderDir(resolvedSkillDir, resolvedSource)) continue
    const relativePath = normalizeSkillRelativePath(path.relative(resolvedSource, resolvedSkillDir))
    if (relativePath) return relativePath
  }
  return path.basename(skillDir)
}

function getNestedSkillRoots(relativeFilePaths: string[]): string[] {
  const roots = new Set<string>()
  for (const relativePath of relativeFilePaths) {
    const normalized = normalizeSkillRelativePath(relativePath)
    if (!/(^|\/)SKILL\.md$/i.test(normalized)) continue
    if (normalized.toUpperCase() === "SKILL.MD") continue
    const root = normalizeSkillRelativePath(normalized.replace(/\/SKILL\.md$/i, ""))
    if (root) roots.add(root)
  }
  return [...roots].sort((a, b) => a.localeCompare(b))
}

function isUnderAnyRelativeDir(relativePath: string, roots: string[]): boolean {
  const normalized = normalizeSkillRelativePath(relativePath)
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

async function buildNestedSkillMetadata(
  skillDir: string,
  nestedRoots: string[]
): Promise<Array<{ relativePath: string; name?: string }>> {
  const nested: Array<{ relativePath: string; name?: string }> = []
  for (const relativePath of nestedRoots) {
    const skillMdPath = path.join(skillDir, relativePath, "SKILL.md")
    try {
      const content = await fs.readFile(skillMdPath, "utf-8")
      const frontmatter = parseYamlFrontmatter(content)
      nested.push({ relativePath, name: frontmatter.name?.trim() || undefined })
    } catch {
      nested.push({ relativePath })
    }
  }
  return nested
}

async function loadSkills(
  dirPath: string,
  source: "project" | "user" = "project",
  options: { maxDepth?: number; idPrefix?: string; pluginId?: string; pluginName?: string } = {}
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []

  if (!existsSync(dirPath)) return skills

  try {
    for (const skill of await discoverSkills(dirPath, options.maxDepth)) {
      try {
        const content = await fs.readFile(skill.skillMdPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(content)
        const id = getDiscoveredSkillId(skill)

        skills.push({
          id: options.idPrefix ? `${options.idPrefix}${id}` : id,
          relativePath: skill.relativePath,
          name: frontmatter.name || skill.name,
          description: frontmatter.description || "",
          path: skill.skillMdPath,
          source,
          version: frontmatter.version || "v1.0.0",
          license: frontmatter.license || null,
          compatibility: frontmatter.compatibility || null,
          metadata: frontmatter,
          allowedTools: frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/\s+/)
            : undefined,
          pluginId: options.pluginId,
          pluginName: options.pluginName
        })
      } catch (e) {
        console.warn(`[Skills] Failed to parse skill at ${skill.skillMdPath}:`, e)
      }
    }
  } catch (e) {
    console.warn(`[Skills] Failed to read skills directory ${dirPath}:`, e)
  }

  return skills
}

async function listSkillFiles(skillDirPath: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        files.push(fullPath)
      }
    }
  }

  if (!existsSync(skillDirPath)) return files
  await walk(skillDirPath)
  files.sort((a, b) => a.localeCompare(b))
  return files
}

/** List all skills (built-in + custom), de-duplicated by path id (custom wins). */
export async function listAllSkills(): Promise<SkillMetadata[]> {
  const [builtin, custom] = await Promise.all([
    loadSkills(getSkillsDir(), "project"),
    loadSkills(getCustomSkillsDir(), "user")
  ])
  const byId = new Map<string, SkillMetadata>()
  for (const s of builtin) byId.set(normalizeSkillId(s.id || s.name), s)
  for (const s of custom) byId.set(normalizeSkillId(s.id || s.name), s)
  return Array.from(byId.values())
}

/**
 * List skills shipped by enabled plugins.
 *
 * Kept separate from listAllSkills() on purpose: plugin skills follow a
 * different lifecycle (managed by plugin enable/disable, not the disabled-
 * skills list), and the existing skills-management UIs (SkillsPanel,
 * MarketPanel, EvolutionPanel) intentionally show only built-in/user skills
 * to avoid letting users delete/disable plugin-owned files. This endpoint is
 * for callers that want a complete picture (e.g. the slash-command popover).
 *
 * Marked with `source: "user"` because SkillMetadata's source is a closed
 * enum {project, user} — pragmatically the closest fit, since plugin skills
 * are user-installed rather than project-bundled.
 */
export async function listPluginSkills(): Promise<SkillMetadata[]> {
  const sources = getEnabledPluginSkillSourceMetadata()
  const byPluginSkill = new Map<string, SkillMetadata>()
  for (const source of sources) {
    const dir = source.sourceDir
    try {
      const skills = await loadSkills(dir, "user", {
        maxDepth: source.maxDepth,
        idPrefix: `plugin:${source.pluginId}/`,
        pluginId: source.pluginId,
        pluginName: source.pluginName
      })
      for (const s of skills) {
        byPluginSkill.set(`${source.pluginId}:${normalizeSkillId(s.id || s.name)}`, s)
      }
    } catch (e) {
      // Per-plugin failures are non-fatal: keep going so a single bad plugin
      // doesn't blank out every other one.
      console.warn(`[Skills] Failed to load plugin skills from ${dir}:`, e)
    }
  }
  return Array.from(byPluginSkill.values())
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  console.log("[Skills] Registering skills handlers...")

  ipcMain.handle("skills:list", async (): Promise<SkillMetadata[]> => {
    return listAllSkills()
  })

  ipcMain.handle("skills:listPlugins", async (): Promise<SkillMetadata[]> => {
    return listPluginSkills()
  })

  ipcMain.handle("skills:getDisabled", async (): Promise<string[]> => {
    return getDisabledSkills()
  })

  ipcMain.handle("skills:setDisabled", async (_event, skillIds: string[]) => {
    if (!Array.isArray(skillIds)) return
    setDisabledSkills(skillIds.filter((s): s is string => typeof s === "string"))
    notifyHooksChanged("skills-disabled-changed")
  })

  ipcMain.handle(
    "skills:delete",
    async (_event, skillPath: string): Promise<{ success: boolean; error?: string }> => {
      if (!skillPath || typeof skillPath !== "string") {
        return { success: false, error: "无效的技能路径" }
      }
      const resolved = path.resolve(skillPath)
      const skillDir = path.dirname(resolved)
      const customResolved = path.resolve(getCustomSkillsDir())
      const rel = path.relative(customResolved, skillDir)
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { success: false, error: "只能删除自定义技能" }
      }
      if (!existsSync(skillDir)) {
        return { success: false, error: "技能不存在" }
      }
      try {
        const cleanupDisabledSkills = prepareDisabledSkillsCleanupForSkillDir(skillDir)
        rmSync(skillDir, { recursive: true })
        cleanupDisabledSkills()
        invalidateEnabledSkillsCache()
        notifyHooksChanged("skill-deleted")
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "删除失败" }
      }
    }
  )

  ipcMain.handle("skills:read", async (_event, skillPath: string) => {
    try {
      const resolvedPath = path.resolve(skillPath)
      if (!isPathUnderAllowedDirs(resolvedPath)) {
        return { success: false, error: "Access denied: skill path outside skills directory" }
      }
      const raw = await fs.readFile(resolvedPath)
      const content = decodeSkillTextFile(raw, resolvedPath)
      return { success: true, content: content.replace(/^\uFEFF/, "") }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
    }
  })

  ipcMain.handle("skills:readBinary", async (_event, skillPath: string) => {
    try {
      const resolvedPath = path.resolve(skillPath)
      if (!isPathUnderAllowedDirs(resolvedPath)) {
        return { success: false, error: "Access denied: skill path outside skills directory" }
      }
      const content = await fs.readFile(resolvedPath)
      return {
        success: true,
        content: content.toString("base64"),
        mimeType: getMimeTypeByPath(resolvedPath)
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
    }
  })

  ipcMain.handle(
    "skills:write",
    async (
      _event,
      payload: { skillPath: string; content: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const { skillPath, content } = payload || {}
      if (!skillPath || typeof skillPath !== "string") {
        return { success: false, error: "无效的技能路径" }
      }
      if (typeof content !== "string") {
        return { success: false, error: "无效的文件内容" }
      }

      try {
        const resolvedPath = path.resolve(skillPath)
        const customDir = getCustomSkillsDir()
        // 使用 realpath 防止“自定义目录内软链接指向目录外”的绕过场景。
        const [realFilePath, realCustomDir] = await Promise.all([
          fs.realpath(resolvedPath),
          fs.realpath(customDir).catch(() => path.resolve(customDir))
        ])
        // 仅允许写入用户自定义技能目录，防止误改内置技能或越权写任意路径。
        if (!isPathUnderDir(realFilePath, realCustomDir)) {
          return { success: false, error: "只能编辑自定义技能文件" }
        }
        const stat = await fs.stat(realFilePath)
        // 明确拒绝目录等非文件对象，避免错误覆盖。
        if (!stat.isFile()) {
          return { success: false, error: "目标不是文件" }
        }
        await fs.writeFile(realFilePath, content, "utf-8")
        const fileName = path.basename(realFilePath)
        if (fileName === "hooks.json" || fileName === "SKILL.md") {
          invalidateEnabledSkillsCache()
          notifyHooksChanged("skill-file-written")
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "保存失败" }
      }
    }
  )

  ipcMain.handle("skills:listFiles", async (_event, skillPath: string) => {
    try {
      const resolvedSkillFilePath = path.resolve(skillPath)
      const skillDirPath = path.dirname(resolvedSkillFilePath)
      if (!isPathUnderAllowedDirs(skillDirPath)) {
        return { success: false, error: "Access denied: skill path outside skills directory" }
      }

      await repairMojibakeNamesInSkillDir(skillDirPath)

      let files = await listSkillFiles(skillDirPath)
      // Fallback: always expose the skill entry file if directory traversal returns empty.
      if (files.length === 0 && existsSync(resolvedSkillFilePath)) {
        files = [resolvedSkillFilePath]
      }
      return { success: true, files }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
    }
  })

  ipcMain.handle(
    "skills:extractMarkdownFromZip",
    async (
      _event,
      payload: { buffer: ArrayBuffer; fileName?: string }
    ): Promise<{ success: boolean; filePath?: string; content?: string; error?: string }> => {
      const { buffer, fileName } = payload || {}
      if (!buffer) {
        return { success: false, error: "Invalid zip buffer" }
      }

      try {
        const zip = new AdmZip(Buffer.from(buffer))
        const entries = zip
          .getEntries()
          .map((entry) => ({ entry, decodedName: decodeZipEntryName(entry) }))
          .filter((item) => !item.entry.isDirectory && /\.md$/i.test(item.decodedName))
          .sort((a, b) => a.decodedName.localeCompare(b.decodedName))

        if (entries.length === 0) {
          return { success: false, error: "Zip 中未找到 .md 文件" }
        }

        const preferred =
          selectRootSkillMarkdownEntry<(typeof entries)[number]>(
            entries,
            (item) => item.entry.isDirectory
          ) || entries[0]
        const content = decodeSkillTextFile(
          preferred.entry.getData(),
          preferred.decodedName || "SKILL.md"
        )

        return {
          success: true,
          filePath: preferred.decodedName || fileName || "SKILL.md",
          content
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Failed to parse zip markdown"
        }
      }
    }
  )

  ipcMain.handle(
    "skills:upload",
    async (
      _event,
      payload: { buffer: ArrayBuffer; fileName: string; options?: SkillUploadOptions }
    ): Promise<SkillUploadResult> => {
      const { buffer, fileName, options = {} } = payload
      if (!buffer || !fileName || typeof fileName !== "string") {
        return { success: false, error: "Invalid buffer or fileName" }
      }

      const ext = path.extname(fileName).toLowerCase()
      const customDir = getCustomSkillsDir()
      mkdirSync(customDir, { recursive: true })

      let existingSkillNamesCache: Set<string> | null = null
      const getExistingSkillNames = async (): Promise<Set<string>> => {
        if (existingSkillNamesCache) return existingSkillNamesCache
        const [builtin, custom] = await Promise.all([
          loadSkills(getSkillsDir(), "project"),
          loadSkills(getCustomSkillsDir(), "user")
        ])
        existingSkillNamesCache = new Set(
          [...builtin, ...custom].map((s) => normalizeSkillNameForComparison(s.name))
        )
        return existingSkillNamesCache
      }

      const checkNameDuplicate = async (nameToCheck: string): Promise<boolean> => {
        return (await getExistingSkillNames()).has(normalizeSkillNameForComparison(nameToCheck))
      }

      const checkDirCollision = (sanitizedName: string): boolean => {
        return (
          existsSync(path.join(customDir, sanitizedName)) ||
          existsSync(path.join(getSkillsDir(), sanitizedName))
        )
      }

      try {
        if (ext === ".md") {
          const content = Buffer.from(buffer).toString("utf-8")
          const frontmatter = parseYamlFrontmatter(content)
          const name = frontmatter.name?.trim()
          if (!name) {
            return { success: false, error: "SKILL.md 必须包含 YAML frontmatter 中的 name 字段" }
          }
          if (await checkNameDuplicate(name)) {
            return { success: false, error: `技能名称「${name}」已存在` }
          }
          const skillName = sanitizeSkillName(name)
          if (checkDirCollision(skillName)) {
            return { success: false, error: `技能目录「${skillName}」已存在，请换一个名称` }
          }
          const skillDir = path.join(customDir, skillName)
          mkdirSync(skillDir, { recursive: true })
          await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8")
          clearDisabledSkillsForSkillDir(skillDir)
          invalidateEnabledSkillsCache()
          notifyHooksChanged("skill-uploaded")
          return { success: true, skillName }
        }

        if (ext === ".zip") {
          const zip = new AdmZip(Buffer.from(buffer))
          const entries = zip.getEntries()
          const decodedEntries: DecodedZipEntry[] = entries.map((entry) => ({
            entry,
            decodedName: decodeZipEntryName(entry)
          }))

          const skillMdEntry = selectRootSkillMarkdownEntry<(typeof decodedEntries)[number]>(
            decodedEntries,
            (item) => item.entry.isDirectory
          )

          if (!skillMdEntry) {
            return { success: false, error: "ZIP 文件必须包含 SKILL.md" }
          }

          const content = decodeSkillTextFile(
            skillMdEntry.entry.getData(),
            skillMdEntry.decodedName
          )
          const frontmatter = parseYamlFrontmatter(content)
          const name = frontmatter.name?.trim()
          if (!name) {
            return { success: false, error: "SKILL.md 必须包含 YAML frontmatter 中的 name 字段" }
          }
          if (await checkNameDuplicate(name)) {
            return { success: false, error: `技能名称「${name}」已存在` }
          }
          const skillName = sanitizeSkillName(name)
          if (checkDirCollision(skillName)) {
            return { success: false, error: `技能目录「${skillName}」已存在，请换一个名称` }
          }

          const basePrefix = skillMdEntry.decodedName.replace(/SKILL\.md$/i, "")
          const metadata = readMarketplaceSkillMetadataFromZip(decodedEntries, basePrefix)
          const nestedNameConflicts = findNestedSkillNameConflicts(
            getNestedSkillNameCandidates(decodedEntries, basePrefix, metadata),
            await getExistingSkillNames()
          )
          if (nestedNameConflicts.length > 0 && !options.allowNestedNameDuplicates) {
            const preview = nestedNameConflicts
              .slice(0, 5)
              .map((item) => `${item.name}（${item.relativePath}）`)
              .join("、")
            const suffix = nestedNameConflicts.length > 5 ? "等" : ""
            return {
              success: false,
              error: `导入会引入 ${nestedNameConflicts.length} 个与现有 skill 同名的子技能：${preview}${suffix}`,
              nestedNameConflicts
            }
          }

          const skillDir = path.join(customDir, skillName)
          mkdirSync(skillDir, { recursive: true })

          for (const item of decodedEntries) {
            const entry = item.entry
            if (entry.isDirectory) continue
            if (!item.decodedName.startsWith(basePrefix)) continue
            const relativePath = item.decodedName.slice(basePrefix.length)
            if (!relativePath) continue
            if (isMarketplaceSkillMetadataPath(relativePath)) continue
            const destPath = path.resolve(skillDir, relativePath)
            if (
              !destPath.startsWith(path.resolve(skillDir) + path.sep) &&
              destPath !== path.resolve(skillDir)
            ) {
              console.warn(
                `[Skills] Skipping ZIP entry with path traversal: ${item.decodedName || entry.entryName}`
              )
              continue
            }
            const destDir = path.dirname(destPath)
            mkdirSync(destDir, { recursive: true })
            await fs.writeFile(destPath, entry.getData())
          }
          clearDisabledSkillsForSkillDir(skillDir)
          invalidateEnabledSkillsCache()
          notifyHooksChanged("skill-uploaded")
          return { success: true, skillName }
        }

        return { success: false, error: "仅支持 .md 或 .zip 文件" }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
      }
    }
  )

  ipcMain.handle(
    "skills:exportForMarket",
    async (
      _event,
      skillPath: string,
      options: ExportForMarketOptions = {}
    ): Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }> => {
      if (!skillPath || typeof skillPath !== "string") {
        return { success: false, error: "无效的技能路径" }
      }

      try {
        const resolvedSkillPath = path.resolve(skillPath)
        if (!isPathUnderAllowedDirs(resolvedSkillPath)) {
          return { success: false, error: "Access denied: skill path outside skills directory" }
        }

        const skillDir = path.dirname(resolvedSkillPath)
        if (!existsSync(skillDir)) {
          return { success: false, error: "技能目录不存在" }
        }

        const files = await listSkillFiles(skillDir)
        if (files.length === 0) {
          return { success: false, error: "技能目录为空，无法导出" }
        }

        const relativeFilePaths = files
          .map((filePath) => path.relative(skillDir, filePath).replace(/\\/g, "/"))
          .filter((relativePath) => relativePath && !relativePath.startsWith(".."))
        const nestedSkillRoots = getNestedSkillRoots(relativeFilePaths)
        const includeNestedSkills = options.includeNestedSkills !== false

        const zip = new AdmZip()
        for (const filePath of files) {
          const relativePath = path.relative(skillDir, filePath).replace(/\\/g, "/")
          if (!relativePath || relativePath.startsWith("..")) {
            continue
          }
          if (isMarketplaceSkillMetadataPath(relativePath)) {
            continue
          }
          if (!includeNestedSkills && isUnderAnyRelativeDir(relativePath, nestedSkillRoots)) {
            continue
          }
          const fileBuffer = await fs.readFile(filePath)
          zip.addFile(relativePath, fileBuffer)
        }

        const skillContent = await fs.readFile(resolvedSkillPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(skillContent)
        const skillName = frontmatter.name?.trim() || path.basename(skillDir)
        const skillRelativePath = getExportSkillRelativePath(skillDir)
        const includedNestedRoots = includeNestedSkills ? nestedSkillRoots : []
        const metadata = {
          schemaVersion: 1,
          type: "cmb.skill.marketplace",
          name: skillName,
          relativePath: skillRelativePath,
          rootDirName: path.basename(skillDir),
          includeNestedSkills,
          nestedSkills: await buildNestedSkillMetadata(skillDir, includedNestedRoots),
          exportedAt: new Date().toISOString()
        }
        zip.addFile(
          MARKETPLACE_SKILL_METADATA_PATH,
          Buffer.from(JSON.stringify(metadata, null, 2), "utf-8")
        )
        const zipBuffer = zip.toBuffer()

        return {
          success: true,
          fileName: makeSafeZipFileName(skillName, skillRelativePath),
          buffer: zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength
          )
        }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "导出技能失败" }
      }
    }
  )

  ipcMain.handle(
    "skills:parseNameFromFile",
    async (
      _event,
      payload: { buffer: ArrayBuffer; fileName: string }
    ): Promise<{ success: boolean; name?: string; error?: string }> => {
      const { buffer, fileName } = payload
      if (!buffer || !fileName) return { success: false, error: "无效参数" }

      const ext = path.extname(fileName).toLowerCase()
      try {
        if (ext === ".md") {
          const content = Buffer.from(buffer).toString("utf-8")
          const frontmatter = parseYamlFrontmatter(content)
          const name = frontmatter.name?.trim()
          if (!name) return { success: false, error: "MD 文件 frontmatter 中未找到 name 字段" }
          return { success: true, name }
        }

        if (ext === ".zip") {
          const zip = new AdmZip(Buffer.from(buffer))
          const entries = zip
            .getEntries()
            .map((entry) => ({ entry, decodedName: decodeZipEntryName(entry) }))
          let mdEntry = selectRootSkillMarkdownEntry<(typeof entries)[number]>(
            entries,
            (item) => item.entry.isDirectory
          )
          if (!mdEntry) {
            // 取任意 .md 文件
            mdEntry =
              entries.find(
                (item) => !item.entry.isDirectory && item.decodedName.toLowerCase().endsWith(".md")
              ) || null
          }
          if (!mdEntry) {
            return { success: false, error: "ZIP 中未找到 MD 文件" }
          }
          const content = decodeSkillTextFile(
            mdEntry.entry.getData(),
            mdEntry.decodedName || "SKILL.md"
          )
          const frontmatter = parseYamlFrontmatter(content)
          const name = frontmatter.name?.trim()
          if (!name) return { success: false, error: "MD 文件 frontmatter 中未找到 name 字段" }
          return { success: true, name }
        }

        return { success: false, error: "仅支持 .md 或 .zip 文件" }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Unknown error" }
      }
    }
  )
}
