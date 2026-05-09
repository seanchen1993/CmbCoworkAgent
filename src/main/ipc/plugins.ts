import AdmZip from "adm-zip"
import { IpcMain, dialog } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import { v4 as uuid } from "uuid"
import {
  getPluginsDir,
  getPlugins,
  getPluginHooks,
  getEnabledPluginHookMetadata,
  upsertPlugin,
  deletePlugin as deletePluginStorage,
  setPluginEnabled,
  setPluginHookEnabled,
  invalidateEnabledSkillsCache,
  parseMcpJsonFile
} from "../storage"
import { copyDirRecursive, createAsyncMutex } from "../utils/fs"
import type {
  PluginHookMetadata,
  PluginManifest,
  PluginMetadata,
  PluginMcpServerConfig
} from "../types"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"

const DEFAULT_PLUGIN_HOOKS_PATH = "hooks/hooks.json"

interface ParsedPlugin {
  manifest: PluginManifest | null
  skillDirs: string[]
  mcpConfigs: Record<string, PluginMcpServerConfig>
  hookCount: number
  hookPath: string
  name: string
}

function sanitizePluginName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9-_.\u4e00-\u9fff]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "plugin"
  )
}

function makeSafeZipFileName(rawName: string): string {
  const sanitized = rawName
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return `${sanitized || "plugin"}.zip`
}

async function addDirToZip(zip: AdmZip, dirPath: string, rootDir: string): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await addDirToZip(zip, fullPath, rootDir)
      continue
    }
    if (!entry.isFile()) continue

    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/")
    if (!relativePath || relativePath.startsWith("..")) continue
    zip.addFile(relativePath, await fs.readFile(fullPath))
  }
}

/** Validate and parse a raw JSON object as PluginManifest. Returns null if invalid. */
function validatePluginManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== "string" || !obj.name.trim()) return null
  return {
    name: obj.name,
    version: typeof obj.version === "string" ? obj.version : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    author:
      typeof obj.author === "string"
        ? obj.author
        : obj.author && typeof obj.author === "object" && !Array.isArray(obj.author)
          ? (obj.author as PluginManifest["author"])
          : undefined,
    license: typeof obj.license === "string" ? obj.license : undefined,
    keywords: Array.isArray(obj.keywords)
      ? obj.keywords.filter((k): k is string => typeof k === "string")
      : undefined,
    skills:
      typeof obj.skills === "string"
        ? obj.skills
        : Array.isArray(obj.skills)
          ? obj.skills.filter((s): s is string => typeof s === "string")
          : undefined,
    mcpServers: typeof obj.mcpServers === "string" ? obj.mcpServers : undefined,
    hooks: typeof obj.hooks === "string" ? obj.hooks : undefined
  }
}

async function parsePluginDir(dirPath: string): Promise<ParsedPlugin> {
  let manifest: PluginManifest | null = null
  const skillDirs: string[] = []
  let mcpConfigs: Record<string, PluginMcpServerConfig> = {}
  let name = path.basename(dirPath)

  // Try reading .claude-plugin/plugin.json
  const manifestPath = path.join(dirPath, ".claude-plugin", "plugin.json")
  if (existsSync(manifestPath)) {
    try {
      const content = await fs.readFile(manifestPath, "utf-8")
      manifest = validatePluginManifest(JSON.parse(content))
      if (manifest?.name) name = manifest.name
    } catch {
      console.warn("[Plugins] Failed to parse plugin.json at", manifestPath)
    }
  }

  // Also try plugin.json at root level
  if (!manifest) {
    const rootManifestPath = path.join(dirPath, "plugin.json")
    if (existsSync(rootManifestPath)) {
      try {
        const content = await fs.readFile(rootManifestPath, "utf-8")
        manifest = validatePluginManifest(JSON.parse(content))
        if (manifest?.name) name = manifest.name
      } catch {
        console.warn("[Plugins] Failed to parse plugin.json at", rootManifestPath)
      }
    }
  }

  // Scan skills/ directory
  const skillsDir = path.join(dirPath, "skills")
  if (existsSync(skillsDir)) {
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md")
        if (existsSync(skillMdPath)) {
          skillDirs.push(entry.name)
        }
      }
    } catch {
      console.warn("[Plugins] Failed to scan skills/ in", dirPath)
    }
  }

  // Check for single SKILL.md at root (simple plugin structure)
  if (skillDirs.length === 0) {
    const rootSkillMd = path.join(dirPath, "SKILL.md")
    if (existsSync(rootSkillMd)) {
      skillDirs.push(".")
    }
  }

  // Read .mcp.json
  const mcpJsonPath = path.join(dirPath, ".mcp.json")
  mcpConfigs = parseMcpJsonFile(mcpJsonPath) ?? {}

  // Count hooks — supports our flat array and CC formats
  let hookCount = 0
  const hookPath = manifest?.hooks ?? DEFAULT_PLUGIN_HOOKS_PATH
  const hooksFilePath = path.join(dirPath, hookPath)
  if (existsSync(hooksFilePath)) {
    try {
      const raw = JSON.parse(await fs.readFile(hooksFilePath, "utf-8"))
      if (Array.isArray(raw)) {
        hookCount = raw.length
      } else if (raw && typeof raw === "object") {
        // CC plugin wrapper { description?, hooks: {...} } or CC settings { EventName: [...] }
        const settingsObj =
          typeof (raw as Record<string, unknown>).hooks === "object" &&
          !Array.isArray((raw as Record<string, unknown>).hooks)
            ? ((raw as Record<string, unknown>).hooks as Record<string, unknown>)
            : (raw as Record<string, unknown>)
        for (const matchers of Object.values(settingsObj)) {
          if (!Array.isArray(matchers)) continue
          for (const matcher of matchers) {
            if (
              matcher &&
              typeof matcher === "object" &&
              Array.isArray((matcher as Record<string, unknown>).hooks)
            ) {
              hookCount += ((matcher as Record<string, unknown>).hooks as unknown[]).length
            }
          }
        }
      }
    } catch {
      /* ignore invalid hooks file */
    }
  }

  return { manifest, skillDirs, mcpConfigs, hookCount, hookPath, name }
}

function formatAuthor(author: PluginManifest["author"]): string {
  if (!author) return ""
  if (typeof author === "string") return author
  return author.name || ""
}

async function installPluginFromDir(
  dirPath: string
): Promise<{ success: boolean; pluginName?: string; error?: string }> {
  try {
    const parsed = await parsePluginDir(dirPath)
    if (
      parsed.skillDirs.length === 0 &&
      Object.keys(parsed.mcpConfigs).length === 0 &&
      parsed.hookCount === 0
    ) {
      return { success: false, error: "未检测到有效的 skills、MCP 配置或 hooks" }
    }

    const pluginsDir = getPluginsDir()

    // Check for existing plugin with same name AND author (update scenario)
    const newAuthor = formatAuthor(parsed.manifest?.author)
    const existing = getPlugins().find((p) => p.name === parsed.name && p.author === newAuthor)

    // Determine unique directory name — avoid collision with other plugins' directories
    let pluginDirName = sanitizePluginName(parsed.name)
    if (!existing) {
      let suffix = 1
      const maxRetries = 100
      while (existsSync(path.join(pluginsDir, pluginDirName))) {
        suffix++
        if (suffix > maxRetries) {
          return {
            success: false,
            error: `无法为插件 "${parsed.name}" 创建唯一目录名，目录 "${pluginDirName}" 已被占用`
          }
        }
        pluginDirName = `${sanitizePluginName(parsed.name)}-${suffix}`
      }
    } else {
      // Reuse the existing plugin's directory basename
      pluginDirName = path.basename(existing.path)
    }
    const destDir = path.join(pluginsDir, pluginDirName)

    if (existing) {
      // Update existing: backup old directory, then copy new, restore on failure
      const backupDir = existing.path + `_backup_${Date.now()}`
      if (existsSync(existing.path)) {
        await fs.rename(existing.path, backupDir)
      }
      try {
        await copyDirRecursive(dirPath, destDir)
      } catch (copyErr) {
        // Restore from backup
        if (existsSync(backupDir)) {
          if (existsSync(destDir)) {
            rmSync(destDir, { recursive: true, force: true })
          }
          await fs.rename(backupDir, existing.path)
        }
        throw copyErr
      }
      // Copy succeeded, remove backup
      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true })
      }
    } else {
      // Fresh install
      await copyDirRecursive(dirPath, destDir)
    }

    const now = new Date().toISOString()
    const meta: PluginMetadata = {
      id: existing?.id ?? uuid(),
      name: parsed.name,
      version: parsed.manifest?.version ?? "1.0.0",
      description: parsed.manifest?.description ?? "",
      author: formatAuthor(parsed.manifest?.author),
      path: destDir,
      enabled: true,
      skillCount: parsed.skillDirs.length,
      mcpServerCount: Object.keys(parsed.mcpConfigs).length,
      hookCount: parsed.hookCount,
      hookPath: parsed.hookPath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    upsertPlugin(meta)
    invalidateEnabledSkillsCache()
    await invalidateGlobalMcpCapabilityService("plugin:update")

    return { success: true, pluginName: parsed.name }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "安装失败" }
  }
}

const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024 // 50 MB
const MAX_ENTRY_COUNT = 1000

async function installPluginFromZip(
  buffer: ArrayBuffer
): Promise<{ success: boolean; pluginName?: string; error?: string }> {
  try {
    const zip = new AdmZip(Buffer.from(buffer))
    const entries = zip.getEntries()

    // Check total uncompressed size and entry count before extracting
    let totalSize = 0
    let fileCount = 0
    for (const entry of entries) {
      if (!entry.isDirectory) {
        fileCount++
        if (fileCount > MAX_ENTRY_COUNT) {
          return { success: false, error: `ZIP 包含文件数量超过 ${MAX_ENTRY_COUNT} 个限制` }
        }
        totalSize += entry.header.size
        if (totalSize > MAX_EXTRACTED_SIZE) {
          return {
            success: false,
            error: `ZIP 解压后大小超过 ${MAX_EXTRACTED_SIZE / 1024 / 1024}MB 限制`
          }
        }
      }
    }

    // Check available disk space before extracting
    try {
      const pluginsDir = getPluginsDir()
      const { statfs } = await import("fs/promises")
      const fsInfo = await statfs(pluginsDir)
      const availableBytes = fsInfo.bavail * fsInfo.bsize
      // Require at least 2x the total uncompressed size (temp + final copy)
      if (availableBytes < totalSize * 2) {
        return {
          success: false,
          error: `磁盘可用空间不足，需要至少 ${Math.ceil((totalSize * 2) / 1024 / 1024)}MB`
        }
      }
    } catch {
      // statfs may not be available on all platforms — continue without check
    }

    // Determine root prefix — the zip may have a single root directory
    let rootPrefix = ""
    const firstEntry = entries.find((e) => !e.isDirectory)
    if (firstEntry) {
      const parts = firstEntry.entryName.split("/")
      if (parts.length > 1) {
        // Check if all entries share the same root directory
        const candidate = parts[0] + "/"
        const allMatch = entries.every(
          (e) => e.entryName.startsWith(candidate) || e.entryName === candidate.slice(0, -1)
        )
        if (allMatch) rootPrefix = candidate
      }
    }

    // Extract to temp directory
    const pluginsDir = getPluginsDir()
    const tempName = `_temp_${Date.now()}`
    const tempDir = path.join(pluginsDir, tempName)
    mkdirSync(tempDir, { recursive: true })

    try {
      for (const entry of entries) {
        if (entry.isDirectory) continue
        let relativePath = entry.entryName
        if (rootPrefix && relativePath.startsWith(rootPrefix)) {
          relativePath = relativePath.slice(rootPrefix.length)
        }
        if (!relativePath) continue

        const destPath = path.resolve(tempDir, relativePath)
        // Path traversal check — normalize both sides so separator style is consistent
        const normalDest = path.normalize(destPath)
        const normalBase = path.normalize(path.resolve(tempDir))
        if (!normalDest.startsWith(normalBase + path.sep) && normalDest !== normalBase) {
          throw new Error(`ZIP 包含路径穿越条目: ${entry.entryName}`)
        }
        const destDirPath = path.dirname(destPath)
        mkdirSync(destDirPath, { recursive: true })
        await fs.writeFile(destPath, entry.getData())
      }

      // Parse and install
      const result = await installPluginFromDir(tempDir)

      // Clean up temp directory (the real copy is at destDir)
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }

      return result
    } catch (e) {
      // Clean up temp on error
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
      throw e
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "解压失败" }
  }
}

export function registerPluginHandlers(ipcMain: IpcMain): void {
  console.log("[Plugins] Registering plugin handlers...")
  const pluginMutex = createAsyncMutex()

  ipcMain.handle("plugins:list", async (): Promise<PluginMetadata[]> => {
    return getPlugins()
  })

  ipcMain.handle(
    "plugins:exportForMarket",
    async (
      _event,
      id: string
    ): Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }> => {
      if (!id || typeof id !== "string") {
        return { success: false, error: "无效的 Plugin ID" }
      }

      try {
        const plugin = getPlugins().find((item) => item.id === id)
        if (!plugin) {
          return { success: false, error: "Plugin 不存在" }
        }
        if (!existsSync(plugin.path)) {
          return { success: false, error: "Plugin 目录不存在" }
        }

        const zip = new AdmZip()
        await addDirToZip(zip, plugin.path, plugin.path)
        const zipBuffer = zip.toBuffer()

        return {
          success: true,
          fileName: makeSafeZipFileName(plugin.name),
          buffer: zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength
          )
        }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "导出 Plugin 失败" }
      }
    }
  )

  ipcMain.handle(
    "plugins:install",
    async (
      _event,
      payload: { buffer: ArrayBuffer; fileName: string }
    ): Promise<{ success: boolean; pluginName?: string; error?: string }> => {
      const { buffer, fileName } = payload
      if (!buffer || !fileName) {
        return { success: false, error: "无效的文件" }
      }
      await pluginMutex.acquire()
      try {
        return await installPluginFromZip(buffer)
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:installFromDir",
    async (): Promise<{ success: boolean; pluginName?: string; error?: string }> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "选择 Plugin 目录"
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: "已取消" }
      }
      await pluginMutex.acquire()
      try {
        return await installPluginFromDir(result.filePaths[0])
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:delete",
    async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
      if (!id || typeof id !== "string") {
        return { success: false, error: "无效的 Plugin ID" }
      }
      await pluginMutex.acquire()
      try {
        const plugins = getPlugins()
        const plugin = plugins.find((p) => p.id === id)
        if (!plugin) {
          return { success: false, error: "Plugin 不存在" }
        }
        try {
          if (existsSync(plugin.path)) {
            rmSync(plugin.path, { recursive: true, force: true })
          }
          deletePluginStorage(id)
          invalidateEnabledSkillsCache()
          await invalidateGlobalMcpCapabilityService("plugin:delete")
          return { success: true }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : "删除失败" }
        }
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:setEnabled",
    async (
      _event,
      payload: { id: string; enabled: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
      await pluginMutex.acquire()
      try {
        const { id, enabled } = payload
        setPluginEnabled(id, enabled)
        invalidateEnabledSkillsCache()
        await invalidateGlobalMcpCapabilityService("plugin:setEnabled")
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "设置失败" }
      } finally {
        pluginMutex.release()
      }
    }
  )

  ipcMain.handle(
    "plugins:getDetail",
    async (
      _event,
      id: string
    ): Promise<{
      skills: string[]
      mcpServers: string[]
      hookCount: number
      hooks: PluginHookMetadata[]
      manifest: PluginManifest | null
    }> => {
      const plugins = getPlugins()
      const plugin = plugins.find((p) => p.id === id)
      if (!plugin || !existsSync(plugin.path)) {
        return { skills: [], mcpServers: [], hookCount: 0, hooks: [], manifest: null }
      }
      const parsed = await parsePluginDir(plugin.path)
      return {
        skills: parsed.skillDirs,
        mcpServers: Object.keys(parsed.mcpConfigs),
        hookCount: parsed.hookCount,
        hooks: getPluginHooks(plugin.id),
        manifest: parsed.manifest
      }
    }
  )

  ipcMain.handle("plugins:listHooks", async (): Promise<PluginHookMetadata[]> => {
    return getEnabledPluginHookMetadata()
  })

  ipcMain.handle(
    "plugins:setHookEnabled",
    async (
      _event,
      payload: { pluginId: string; hookId: string; enabled: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
      await pluginMutex.acquire()
      try {
        setPluginHookEnabled(payload.pluginId, payload.hookId, payload.enabled)
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "设置失败" }
      } finally {
        pluginMutex.release()
      }
    }
  )
}
