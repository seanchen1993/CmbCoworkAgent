import { normalize, resolve } from "path"
import { discoverSkillsSync } from "../../skills/discovery"

export interface SkillLifecycleMatch {
  name: string
  path: string
  rootDir: string
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
}

interface SkillLifecycleEntry extends SkillLifecycleMatch {
  normalizedDocPath: string
  normalizedRootDir: string
}

export interface SkillLifecycleSource {
  sourceDir: string
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
  maxDepth?: number
}

function normalizePath(input: string): string {
  const normalized = normalize(input).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function normalizeSkillName(input: string | undefined | null): string {
  return input?.trim().toLowerCase() ?? ""
}

function normalizeSource(source: string | SkillLifecycleSource): SkillLifecycleSource {
  return typeof source === "string" ? { sourceDir: source } : source
}

function collectSkillEntriesFromSource(
  rawSource: string | SkillLifecycleSource
): SkillLifecycleEntry[] {
  const source = normalizeSource(rawSource)
  const sourcePath = resolve(source.sourceDir)
  return discoverSkillsSync(sourcePath, source.maxDepth).map(
    (skill): SkillLifecycleEntry => ({
      name: skill.name,
      path: skill.skillMdPath,
      rootDir: skill.rootDir,
      pluginId: source.pluginId,
      pluginName: source.pluginName,
      pluginRoot: source.pluginRoot,
      normalizedDocPath: normalizePath(skill.skillMdPath),
      normalizedRootDir: normalizePath(skill.rootDir)
    })
  )
}

export class SkillLifecycleRegistry {
  private readonly entries: SkillLifecycleEntry[]

  constructor(sources: Array<string | SkillLifecycleSource>) {
    const seen = new Set<string>()
    const entries: SkillLifecycleEntry[] = []
    for (const source of sources) {
      for (const entry of collectSkillEntriesFromSource(source)) {
        const key = entry.normalizedRootDir
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(entry)
      }
    }
    this.entries = entries.sort((a, b) => b.normalizedRootDir.length - a.normalizedRootDir.length)
  }

  private toMatch(entry: SkillLifecycleEntry): SkillLifecycleMatch {
    return {
      name: entry.name,
      path: entry.path,
      rootDir: entry.rootDir,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      pluginRoot: entry.pluginRoot
    }
  }

  resolveExplicit(input: {
    skillName?: string | null
    skillPath?: string | null
  }): SkillLifecycleMatch | null {
    const pathCandidates = [
      input.skillPath ? normalizePath(resolve(input.skillPath)) : "",
      input.skillPath ? normalizePath(input.skillPath) : ""
    ].filter(Boolean)

    for (const candidate of pathCandidates) {
      for (const entry of this.entries) {
        if (candidate === entry.normalizedDocPath || candidate === entry.normalizedRootDir) {
          return this.toMatch(entry)
        }
      }
    }

    const requestedName = normalizeSkillName(input.skillName)
    if (!requestedName) return null
    for (const entry of this.entries) {
      if (normalizeSkillName(entry.name) === requestedName) return this.toMatch(entry)
    }
    return null
  }

  resolveRead(rawPath: string, resolvedPath?: string): SkillLifecycleMatch | null {
    const candidates = [
      resolvedPath ? normalizePath(resolvedPath) : "",
      rawPath ? normalizePath(resolve(rawPath)) : "",
      rawPath ? normalizePath(rawPath) : ""
    ].filter(Boolean)

    for (const candidate of candidates) {
      for (const entry of this.entries) {
        if (
          candidate === entry.normalizedDocPath ||
          candidate === entry.normalizedRootDir ||
          candidate.startsWith(`${entry.normalizedRootDir}/`)
        ) {
          return this.toMatch(entry)
        }
      }
    }
    return null
  }
}
