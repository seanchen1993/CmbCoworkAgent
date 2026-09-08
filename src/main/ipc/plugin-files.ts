import { IpcMain, BrowserWindow } from "electron"
import * as fs from "fs/promises"
import * as path from "path"
import { existsSync } from "fs"
import { getPlugins, invalidateEnabledSkillsCache } from "../storage"
import type { PluginMetadata } from "../types"
import {
  isBinaryExtension,
  isEditableExtension,
  isPathInsideDir,
  isPluginEditable
} from "./plugin-file-gates"
import { bumpHookCatalogGlobalRevision } from "../hook-catalog/revision"

/**
 * Plugin file-editing IPC.
 *
 * Surface area is intentionally minimal and read-mostly: users can list and
 * view every file inside their own plugins, but write is gated by three
 * orthogonal checks:
 *
 *   1. Plugin origin must be "local" (user-uploaded). Market downloads are
 *      read-only — we never diverge silently from an upstream.
 *   2. Resolved (realpath) target must stay inside the plugin root. Defends
 *      against symlink escapes and "../" traversal in the requested path.
 *   3. File extension must be in the editable allowlist — broad text policy
 *      covering markdown, configs (json/yaml/toml/ini), shell + script files,
 *      and web templates. Native binaries / images / archives / fonts are
 *      excluded *at walk time* so they never appear in the listing at all.
 *      A bad edit to a JSON manifest or script only breaks the user's own
 *      plugin (same risk as zipping a different version and re-uploading),
 *      which they'll catch when the plugin refuses to enable.
 *
 * Anything that fails a gate returns a structured `{ success: false, error }`
 * instead of throwing, matching the surrounding skills:* / plugins:* IPC
 * conventions.
 */

interface FileEntry {
  /** Absolute path on disk — feed back into `plugins:read` / `plugins:write`. */
  path: string
  /** Path relative to the plugin root, slash-normalised, for UI display. */
  relativePath: string
  /** True iff `plugins:write` will accept this path (extension allowlist). */
  editable: boolean
}

/**
 * Files larger than this are refused by the read endpoint. The dialog renders
 * everything into a single textarea / pre block, so a multi-MB log file would
 * stall the renderer; refusing on the main side gives a clear error instead
 * of a UI freeze. 1MB is a generous ceiling for SKILL.md / README / notes.
 */
const MAX_READABLE_BYTES = 1 * 1024 * 1024

/**
 * Only frontmatter changes to a SKILL.md actually shift the surfaced skill
 * list (name, description, allowed-tools). Plain README / notes edits don't,
 * so we only invalidate the enabled-skills cache and broadcast the refresh
 * event when a SKILL.md was touched — keeps unrelated downstream surfaces
 * (slash popover, right panel) from re-pulling on every keystroke save.
 */
function isSkillManifestFile(absPath: string): boolean {
  return path.basename(absPath).toUpperCase() === "SKILL.MD"
}

interface ResolvedPlugin {
  plugin: PluginMetadata
  root: string
}

async function resolvePluginRoot(pluginId: string): Promise<ResolvedPlugin | null> {
  if (!pluginId || typeof pluginId !== "string") return null
  const plugin = getPlugins().find((p) => p.id === pluginId)
  if (!plugin) return null
  if (!plugin.path || !existsSync(plugin.path)) return null
  try {
    const root = await fs.realpath(plugin.path)
    return { plugin, root }
  } catch {
    return null
  }
}

/**
 * Resolve the requested file via `fs.realpath` and confirm it still sits
 * inside the plugin root. Returns null if the file doesn't exist, the realpath
 * call fails, or the resolved path escapes the plugin sandbox.
 */
async function resolveInsidePlugin(root: string, requested: string): Promise<string | null> {
  if (!requested || typeof requested !== "string") return null
  let resolved: string
  try {
    resolved = await fs.realpath(requested)
  } catch {
    return null
  }
  if (!isPathInsideDir(resolved, root)) return null
  return resolved
}

/**
 * Directory names we never descend into when listing a plugin's files. A
 * plugin author who zipped their working directory might leave node_modules,
 * .git, or dist behind — those blow up the listFiles response (slow, huge
 * tree) without offering anything a user can usefully edit.
 */
const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".cache",
  ".turbo",
  ".next"
])

/**
 * File names we never include in the listing. Mostly OS / editor turds that
 * the user has no reason to see, and they're harmless to drop.
 */
const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db"])

async function walkPluginFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue // never follow symlinks during listing
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (IGNORED_FILE_NAMES.has(entry.name)) continue
      // Drop known binaries from the tree entirely — reading them as utf-8
      // produces noise, and the user has no actionable edit for them anyway.
      if (isBinaryExtension(entry.name)) continue
      files.push(full)
    }
  }
  if (!existsSync(rootDir)) return files
  await walk(rootDir)
  files.sort((a, b) => a.localeCompare(b))
  return files
}

function notifySkillsChanged(reason: string): void {
  // Plugin SKILL.md edits can shift the slash-popover / right-panel skills
  // list (name, description, allowed-tools). Broadcast the same event main
  // already emits for skill-evolution writes so any future renderer
  // subscription gets a uniform refresh signal.
  const payload = { reason }
  bumpHookCatalogGlobalRevision()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send("skills:changed", payload)
  }
}

export function registerPluginFileHandlers(ipcMain: IpcMain): void {
  console.log("[Plugins] Registering plugin file handlers...")

  ipcMain.handle(
    "plugins:listFiles",
    async (
      _event,
      pluginId: string
    ): Promise<{
      success: boolean
      files?: FileEntry[]
      root?: string
      /**
       * Mirrors the write-gate's origin check so the renderer can render an
       * "整个插件只读" state up-front instead of letting the user type into a
       * textarea and then erroring on save. Two surfaces consume this:
       * the read-only banner in the editor header, and the textarea -> <pre>
       * downgrade for every file in a non-local plugin.
       */
      pluginEditable?: boolean
      error?: string
    }> => {
      const resolved = await resolvePluginRoot(pluginId)
      if (!resolved) return { success: false, error: "插件不存在" }

      const all = await walkPluginFiles(resolved.root)
      const entries: FileEntry[] = all.map((abs) => ({
        path: abs,
        relativePath: path
          .relative(resolved.root, abs)
          .replace(/\\/g, "/"),
        editable: isEditableExtension(abs)
      }))
      return {
        success: true,
        files: entries,
        root: resolved.root,
        pluginEditable: isPluginEditable(resolved.plugin)
      }
    }
  )

  ipcMain.handle(
    "plugins:read",
    async (
      _event,
      payload: { pluginId: string; filePath: string }
    ): Promise<{ success: boolean; content?: string; editable?: boolean; error?: string }> => {
      const { pluginId, filePath } = payload || {}
      const resolved = await resolvePluginRoot(pluginId)
      if (!resolved) return { success: false, error: "插件不存在" }

      const realFile = await resolveInsidePlugin(resolved.root, filePath)
      if (!realFile) return { success: false, error: "文件路径越界" }

      try {
        // Size-gate before the read so we never pull a multi-MB blob into
        // memory or ship it across the IPC boundary just to bounce it.
        const stat = await fs.stat(realFile)
        if (stat.size > MAX_READABLE_BYTES) {
          return {
            success: false,
            error: `文件过大（${Math.round(stat.size / 1024)}KB > ${MAX_READABLE_BYTES / 1024}KB），无法在编辑器中打开`
          }
        }

        const buf = await fs.readFile(realFile)
        // Strip BOM and assume utf-8: plugin authors writing SKILL.md /
        // README locally on the same machine almost always use utf-8. The
        // skills.ts decoder handles legacy GBK files but those don't show
        // up inside our local-uploaded plugins.
        const content = buf.toString("utf-8").replace(/^\uFEFF/, "")
        return { success: true, content, editable: isEditableExtension(realFile) }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "读取失败" }
      }
    }
  )

  ipcMain.handle(
    "plugins:write",
    async (
      _event,
      payload: { pluginId: string; filePath: string; content: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const { pluginId, filePath, content } = payload || {}
      if (typeof content !== "string") {
        return { success: false, error: "无效的文件内容" }
      }

      const resolved = await resolvePluginRoot(pluginId)
      if (!resolved) return { success: false, error: "插件不存在" }

      // Gate 1 — origin
      if (!isPluginEditable(resolved.plugin)) {
        return { success: false, error: "仅本地上传的插件可编辑" }
      }

      // Gate 2 — path containment
      const realFile = await resolveInsidePlugin(resolved.root, filePath)
      if (!realFile) return { success: false, error: "文件路径越界" }

      // Gate 3 — extension allowlist
      if (!isEditableExtension(realFile)) {
        return { success: false, error: "该文件类型不可编辑" }
      }

      try {
        await fs.writeFile(realFile, content, "utf-8")
        // Only SKILL.md edits can shift the enabled-skills list. Skip the
        // invalidate/broadcast for README/.txt to avoid spurious refresh
        // churn in the slash popover and right panel.
        if (isSkillManifestFile(realFile)) {
          invalidateEnabledSkillsCache()
          notifySkillsChanged("plugin-skill-md-written")
        }
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "保存失败" }
      }
    }
  )
}
