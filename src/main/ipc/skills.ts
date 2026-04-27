import AdmZip from "adm-zip"
import { IpcMain } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import {
  getCustomSkillsDir,
  getDisabledSkills,
  getEnabledPluginSkillsSources,
  getSkillsDir,
  getWorkspaceSkillsDir,
  setDisabledSkills
} from "../storage"
import type { SkillMetadata } from "../types"

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

function isPathUnderAllowedDirs(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const builtin = path.resolve(getSkillsDir())
  const custom = path.resolve(getCustomSkillsDir())
  for (const dir of [builtin, custom]) {
    const rel = path.relative(dir, resolved)
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true
  }
  return false
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
export async function listAllSkills(workspacePath?: string): Promise<SkillMetadata[]> {
  const workspace = workspacePath ? getWorkspaceSkillsDir(workspacePath) : null
  const [builtin, custom, workspaceSkills] = await Promise.all([
    loadSkills(getSkillsDir(), "project"),
    loadSkills(getCustomSkillsDir(), "user"),
    workspace ? loadSkills(workspace, "user") : Promise.resolve([])
  ])
  // Workspace skills have highest priority (override builtin and custom)
  const byName = new Map<string, SkillMetadata>()
  for (const s of builtin) byName.set(s.name, s)
  for (const s of custom) byName.set(s.name, s)
  for (const s of workspaceSkills) byName.set(s.name, s)
  return Array.from(byName.values())
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
  const sources = getEnabledPluginSkillsSources()
  // Dedupe by skill name across plugins. When two enabled plugins ship a skill
  // with the same name, a later one wins — there's no principled way to pick,
  // and exposing duplicates would let the slash popover show two entries that
  // recover to different paths after edit-resend.
  const byName = new Map<string, SkillMetadata>()
  for (const dir of sources) {
    try {
      // Two valid plugin shapes per getEnabledPluginSkillsSources():
      //   1. plugin/skills/  — directory of sub-folders, each with a SKILL.md
      //   2. plugin/         — the plugin root itself contains a single SKILL.md
      // loadSkills() only walks shape 1; shape 2 needs a direct read.
      // The two shapes are mutually exclusive at the source-list level:
      // getEnabledPluginSkillsSources() picks `plugin/skills/` if it exists,
      // otherwise `plugin/`. So we never see both for the same plugin here.
      // If that storage strategy ever changes (mixed-shape plugins), revisit
      // the if/else below — it would silently take only the root SKILL.md.
      const rootSkillMd = path.join(dir, "SKILL.md")
      if (existsSync(rootSkillMd)) {
        const content = await fs.readFile(rootSkillMd, "utf-8")
        const frontmatter = parseYamlFrontmatter(content)
        // Fallback to the plugin directory's basename when frontmatter.name is
        // missing — mirrors loadSkills() behaviour above. Without this, a
        // plugin shipping a root SKILL.md without `name:` would silently
        // disappear from the popover while still being loaded by hook system.
        const name = frontmatter.name?.trim() || path.basename(dir)
        byName.set(name, {
          name,
          description: frontmatter.description || "",
          path: rootSkillMd,
          source: "user",
          version: frontmatter.version || "v1.0.0",
          license: frontmatter.license || null,
          compatibility: frontmatter.compatibility || null,
          allowedTools: frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/\s+/)
            : undefined
        })
      } else {
        const skills = await loadSkills(dir, "user")
        for (const s of skills) byName.set(s.name, s)
      }
    } catch (e) {
      // Per-plugin failures are non-fatal: keep going so a single bad plugin
      // doesn't blank out every other one.
      console.warn(`[Skills] Failed to load plugin skills from ${dir}:`, e)
    }
  }
  return Array.from(byName.values())
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  console.log("[Skills] Registering skills handlers...")

  ipcMain.handle("skills:list", async (_event, workspacePath?: string): Promise<SkillMetadata[]> => {
    return listAllSkills(workspacePath)
  })

  ipcMain.handle("skills:listPlugins", async (): Promise<SkillMetadata[]> => {
    return listPluginSkills()
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
      const content = await fs.readFile(resolvedPath, "utf-8")
      return { success: true, content }
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

  ipcMain.handle("skills:listFiles", async (_event, skillPath: string) => {
    try {
      const resolvedSkillFilePath = path.resolve(skillPath)
      const skillDirPath = path.dirname(resolvedSkillFilePath)
      if (!isPathUnderAllowedDirs(skillDirPath)) {
        return { success: false, error: "Access denied: skill path outside skills directory" }
      }

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
          .filter((entry) => !entry.isDirectory && /\.md$/i.test(entry.entryName))
          .sort((a, b) => a.entryName.localeCompare(b.entryName))

        if (entries.length === 0) {
          return { success: false, error: "Zip 中未找到 .md 文件" }
        }

        const preferred =
          entries.find((entry) => /(^|\/)SKILL\.md$/i.test(entry.entryName)) || entries[0]
        const content = preferred.getData().toString("utf-8")

        return {
          success: true,
          filePath: preferred.entryName || fileName || "SKILL.md",
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

          let skillMdEntry = entries.find((e) => !e.isDirectory && e.entryName === "SKILL.md")
          if (!skillMdEntry) {
            const firstDir = entries.find((e) => e.isDirectory && !e.entryName.includes("/"))
            if (firstDir) {
              const prefix = firstDir.entryName
              skillMdEntry = entries.find(
                (e) => !e.isDirectory && e.entryName === `${prefix}SKILL.md`
              )
            }
          }

          if (!skillMdEntry) {
            return { success: false, error: "ZIP 文件必须包含 SKILL.md" }
          }

          const content = skillMdEntry.getData().toString("utf-8")
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

          const basePrefix = skillMdEntry.entryName.replace("SKILL.md", "")
          for (const entry of entries) {
            if (entry.isDirectory) continue
            if (!entry.entryName.startsWith(basePrefix)) continue
            const relativePath = entry.entryName.slice(basePrefix.length)
            if (!relativePath) continue
            const destPath = path.resolve(skillDir, relativePath)
            if (
              !destPath.startsWith(path.resolve(skillDir) + path.sep) &&
              destPath !== path.resolve(skillDir)
            ) {
              console.warn(`[Skills] Skipping ZIP entry with path traversal: ${entry.entryName}`)
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
          const entries = zip.getEntries()
          let mdEntry = entries.find((e) => !e.isDirectory && e.entryName === "SKILL.md")
          if (!mdEntry) {
            mdEntry = entries.find((e) => !e.isDirectory && e.entryName.endsWith("/SKILL.md"))
          }
          if (!mdEntry) {
            // 取任意 .md 文件
            mdEntry = entries.find(
              (e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(".md")
            )
          }
          if (!mdEntry) return { success: false, error: "ZIP 中未找到 MD 文件" }
          const content = mdEntry.getData().toString("utf-8")
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
