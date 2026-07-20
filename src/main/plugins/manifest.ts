import { existsSync, readFileSync } from "fs"
import { isAbsolute, join, relative, resolve } from "path"
import type { PluginManifest } from "../types"

export const DEFAULT_PLUGIN_HOOKS_PATH = "hooks/hooks.json"

const PLUGIN_MANIFEST_REL_PATHS = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json"
] as const

export interface ReadPluginManifestResult {
  manifest: PluginManifest
  path: string
  relPath: string
}

export interface PluginSkillSearchSource {
  sourceDir: string
  relPath: string
  maxDepth?: number
}

/** Validate and parse a raw JSON object as PluginManifest. Returns null if invalid. */
export function validatePluginManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== "string" || !obj.name.trim()) return null
  return {
    name: obj.name,
    version: typeof obj.version === "string" ? obj.version : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    useScenario: typeof obj.useScenario === "string" ? obj.useScenario : undefined,
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

export function readPluginManifest(dirPath: string): ReadPluginManifestResult | null {
  for (const relPath of PLUGIN_MANIFEST_REL_PATHS) {
    const manifestPath = join(dirPath, relPath)
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = validatePluginManifest(JSON.parse(readFileSync(manifestPath, "utf-8")))
      if (manifest) return { manifest, path: manifestPath, relPath }
    } catch {
      console.warn("[Plugins] Failed to parse plugin.json at", manifestPath)
    }
  }
  return null
}

export function normalizePluginRelativePath(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) return null

  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
  if (!normalized || normalized === ".") return "."

  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null
  return normalized
}

export function getPluginManifestSkillPaths(manifest: PluginManifest | null | undefined): string[] {
  const raw = manifest?.skills
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizePluginRelativePath(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function resolveInsidePlugin(pluginRoot: string, relPath: string): string | null {
  const root = resolve(pluginRoot)
  const target = resolve(root, relPath === "." ? "." : relPath)
  const targetRel = relative(root, target)
  if (targetRel.startsWith("..") || isAbsolute(targetRel)) return null
  return target
}

export function getPluginSkillSearchSources(
  pluginRoot: string,
  manifest: PluginManifest | null | undefined
): PluginSkillSearchSource[] {
  const result: PluginSkillSearchSource[] = []
  const seen = new Set<string>()
  const add = (relPath: string, maxDepth?: number): void => {
    const normalizedRelPath = normalizePluginRelativePath(relPath)
    if (!normalizedRelPath) return
    const sourceDir = resolveInsidePlugin(pluginRoot, normalizedRelPath)
    if (!sourceDir || !existsSync(sourceDir)) return
    const key = sourceDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    result.push({ sourceDir, relPath: normalizedRelPath, maxDepth })
  }

  const manifestSkillPaths = getPluginManifestSkillPaths(manifest)
  if (manifestSkillPaths.length > 0) {
    for (const relPath of manifestSkillPaths) add(relPath)
    // Plugin manifest paths supplement convention-based discovery. Some
    // market packages declare a custom path while still shipping root
    // SKILL.md or skills/ entries; returning early here made those skills
    // invisible after install/reinstall even though they were present on disk.
    if (result.length === 0) {
      console.warn(
        `[Plugins] manifest.skills paths did not resolve for plugin at "${pluginRoot}" ` +
          `(declared: ${JSON.stringify(manifestSkillPaths)}). ` +
          `Falling back to convention-based search (root SKILL.md / "skills/"). ` +
          `If this plugin's skills are missing from the slash popover, the manifest's ` +
          `"skills" field likely points at a path that didn't survive packaging.`
      )
    }
  }

  const rootSkillMd = join(pluginRoot, "SKILL.md")
  const skillsDir = join(pluginRoot, "skills")
  const hasRootSkill = existsSync(rootSkillMd)
  const hasSkillsDir = existsSync(skillsDir)

  if (hasRootSkill) {
    // If a conventional skills/ folder is present too, keep the root scan
    // root-only to avoid discovering the same children twice. Simple plugins
    // without skills/ may nest child skills under the root, so let those scan.
    add(".", hasSkillsDir ? 0 : undefined)
  }
  if (hasSkillsDir) add("skills")

  return result
}
