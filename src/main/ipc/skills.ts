import AdmZip from "adm-zip"
import { IpcMain } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { getCustomSkillsDir, getDisabledSkills, getSkillsDir, setDisabledSkills } from "../storage"
import type { SkillMetadata } from "../types"

interface ZipEntryLike {
  entryName: string
  rawEntryName?: Buffer
  header?: {
    flags_efs?: boolean
  }
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
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/\0/g, "")
}

function decodeZipEntryName(entry: ZipEntryLike): string {
  const fallback = normalizeZipEntryName(entry.entryName)
  const raw = Buffer.isBuffer(entry.rawEntryName) ? entry.rawEntryName : null
  if (!raw || raw.length === 0) return fallback

  try {
    const utf8Valid = isValidUtf8(raw)
    const hasUtf8Flag = entry.header?.flags_efs === true
    const utf8Name = utf8Valid ? normalizeZipEntryName(raw.toString("utf-8")) : ""

    // 只有在字节本身是有效 UTF-8 时才按 UTF-8 使用，避免把 GBK 字节误解成 "����"。
    if (hasUtf8Flag && utf8Name) return utf8Name
    if (utf8Name) return utf8Name

    // Windows 上传的 ZIP 常见 ANSI(GBK/GB18030) 文件名。
    if (process.platform === "win32") {
      const gbName = normalizeZipEntryName(iconv.decode(raw, "gb18030"))
      if (gbName) return gbName
    }

    // 按 ZIP 规范的 CP437 做兜底。
    if (iconv.encodingExists("cp437")) {
      const cp437Name = normalizeZipEntryName(iconv.decode(raw, "cp437"))
      if (cp437Name) return cp437Name
    }
  } catch {
    // fall through
  }

  return fallback
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
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      dirQueue.push(path.join(currentDir, entry.name))
    }
  }

  // 深层目录优先重命名，避免父目录先改名后子路径失效。
  dirQueue.sort((a, b) => b.length - a.length)

  for (const dirPath of dirQueue) {
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
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
  }
}

function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      result[key] = value
    }
  }
  return result
}

function makeSafeZipFileName(rawName: string): string {
  const sanitized = rawName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return `${sanitized || "skill"}.zip`
}

async function loadSkills(
  dirPath: string,
  source: "project" | "user" = "project"
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []

  if (!existsSync(dirPath)) return skills

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = path.join(dirPath, entry.name, "SKILL.md")
      if (!existsSync(skillMdPath)) continue

      try {
        const content = await fs.readFile(skillMdPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(content)

        skills.push({
          name: frontmatter.name || entry.name,
          description: frontmatter.description || "",
          path: skillMdPath,
          source,
          version: frontmatter.version || "v1.0.0",
          license: frontmatter.license || null,
          compatibility: frontmatter.compatibility || null,
          metadata: frontmatter,
          allowedTools: frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/\s+/)
            : undefined
        })
      } catch (e) {
        console.warn(`[Skills] Failed to parse skill at ${skillMdPath}:`, e)
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

/** List all skills (built-in + custom), de-duplicated by name (custom wins). */
export async function listAllSkills(): Promise<SkillMetadata[]> {
  const [builtin, custom] = await Promise.all([
    loadSkills(getSkillsDir(), "project"),
    loadSkills(getCustomSkillsDir(), "user")
  ])
  const byName = new Map<string, SkillMetadata>()
  for (const s of builtin) byName.set(s.name, s)
  for (const s of custom) byName.set(s.name, s)
  return Array.from(byName.values())
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  console.log("[Skills] Registering skills handlers...")

  ipcMain.handle("skills:list", async (): Promise<SkillMetadata[]> => {
    return listAllSkills()
  })

  ipcMain.handle("skills:getDisabled", async (): Promise<string[]> => {
    return getDisabledSkills()
  })

  ipcMain.handle("skills:setDisabled", async (_event, skillNames: string[]) => {
    if (!Array.isArray(skillNames)) return
    setDisabledSkills(skillNames.filter((s): s is string => typeof s === "string"))
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
        rmSync(skillDir, { recursive: true })
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
          entries.find((item) => /(^|\/)SKILL\.md$/i.test(item.decodedName)) || entries[0]
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
      payload: { buffer: ArrayBuffer; fileName: string }
    ): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      const { buffer, fileName } = payload
      if (!buffer || !fileName || typeof fileName !== "string") {
        return { success: false, error: "Invalid buffer or fileName" }
      }

      const ext = path.extname(fileName).toLowerCase()
      const customDir = getCustomSkillsDir()
      mkdirSync(customDir, { recursive: true })

      const checkNameDuplicate = async (nameToCheck: string): Promise<boolean> => {
        const [builtin, custom] = await Promise.all([
          loadSkills(getSkillsDir(), "project"),
          loadSkills(getCustomSkillsDir(), "user")
        ])
        const existingNames = new Set(
          [...builtin, ...custom].map((s) => s.name.trim().toLowerCase())
        )
        return existingNames.has(nameToCheck.trim().toLowerCase())
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
          return { success: true, skillName }
        }

        if (ext === ".zip") {
          const zip = new AdmZip(Buffer.from(buffer))
          const entries = zip.getEntries()
          const decodedEntries = entries.map((entry) => ({
            entry,
            decodedName: decodeZipEntryName(entry)
          }))

          const skillMdEntry =
            decodedEntries.find(
              (item) => !item.entry.isDirectory && /(^|\/)SKILL\.md$/i.test(item.decodedName)
            ) || null

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
          const skillDir = path.join(customDir, skillName)
          mkdirSync(skillDir, { recursive: true })

          const basePrefix = skillMdEntry.decodedName.replace(/SKILL\.md$/i, "")
          for (const item of decodedEntries) {
            const entry = item.entry
            if (entry.isDirectory) continue
            if (!item.decodedName.startsWith(basePrefix)) continue
            const relativePath = item.decodedName.slice(basePrefix.length)
            if (!relativePath) continue
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
      skillPath: string
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

        const zip = new AdmZip()
        for (const filePath of files) {
          const relativePath = path.relative(skillDir, filePath).replace(/\\/g, "/")
          if (!relativePath || relativePath.startsWith("..")) {
            continue
          }
          const fileBuffer = await fs.readFile(filePath)
          zip.addFile(relativePath, fileBuffer)
        }

        const skillContent = await fs.readFile(resolvedSkillPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(skillContent)
        const skillName = frontmatter.name?.trim() || path.basename(skillDir)
        const zipBuffer = zip.toBuffer()

        return {
          success: true,
          fileName: makeSafeZipFileName(skillName),
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
          let mdEntry =
            entries.find(
              (item) => !item.entry.isDirectory && /(^|\/)SKILL\.md$/i.test(item.decodedName)
            ) || null
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
