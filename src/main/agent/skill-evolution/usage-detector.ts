import { readFileSync } from "fs"
import { posix as pathPosix } from "path"
import {
  getEnabledPluginSkillSourceMetadata,
  type PluginSkillSourceMetadata
} from "../../storage"
import {
  ensureVersionedSkillIdentifier,
  parseYamlFrontmatter
} from "../../utils/skill-identifiers"
import { makePluginSkillSourceRef } from "../../utils/skill-source"

const CLOUD_EVOLVER_NAME = "CMBDevClaw Trace Evolver"

export interface SkillMetadataLite {
  name?: string
  path?: string
  version?: string
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
}

function isSameOrChildPath(targetPath: string, parentPath: string): boolean {
  const target = normalizePath(targetPath)
  const parent = normalizePath(parentPath)
  return target === parent || target.startsWith(`${parent}/`)
}

function findPluginSkillSource(normalizedPath: string): PluginSkillSourceMetadata | null {
  try {
    return (
      getEnabledPluginSkillSourceMetadata().find((source) => {
        const sourceDir = normalizePath(source.sourceDir)
        const pluginRoot = normalizePath(source.pluginRoot)
        return (
          isSameOrChildPath(normalizedPath, sourceDir) ||
          isSameOrChildPath(normalizedPath, pluginRoot)
        )
      }) ?? null
    )
  } catch {
    return null
  }
}

function getSkillPathAliases(skillPath: string): string[] {
  const aliases = new Set<string>([skillPath])
  const enabledCustomSegment = "/enabled-skills-custom/"
  const customSegmentIndex = skillPath.indexOf(enabledCustomSegment)
  if (customSegmentIndex >= 0) {
    aliases.add(
      `${skillPath.slice(0, customSegmentIndex)}/skills/${skillPath.slice(customSegmentIndex + enabledCustomSegment.length)}`
    )
  }
  return Array.from(aliases)
}

function readSkillFrontmatter(skillDocPath: string): Record<string, string> | null {
  try {
    return parseYamlFrontmatter(readFileSync(skillDocPath, "utf8"))
  } catch {
    return null
  }
}

function isCloudEvolvedSkill(frontmatter: Record<string, string> | null): boolean {
  return frontmatter?.["evolved-by"]?.trim() === CLOUD_EVOLVER_NAME
}

function resolveSkillInfo(
  fallbackName: string,
  version: string | undefined,
  skillDocPath: string,
  options: { fallbackWhenUnreadable: boolean } = { fallbackWhenUnreadable: true }
): { identifier: string; evolved: boolean } {
  const frontmatter = readSkillFrontmatter(skillDocPath)

  if (version?.trim()) {
    const name = (frontmatter?.name || fallbackName).trim()
    return {
      identifier: ensureVersionedSkillIdentifier(name, version),
      evolved: isCloudEvolvedSkill(frontmatter)
    }
  }

  if (!frontmatter && !options.fallbackWhenUnreadable) {
    return { identifier: "", evolved: false }
  }

  const skillName = (frontmatter?.name || fallbackName).trim()
  return {
    identifier: ensureVersionedSkillIdentifier(skillName, frontmatter?.version),
    evolved: isCloudEvolvedSkill(frontmatter)
  }
}

function getLocalSkillRootDir(normalizedPath: string): string | null {
  const segments = normalizedPath.split("/").filter(Boolean)
  const cowAgentIndex = segments.indexOf(".cmbcoworkagent")
  if (cowAgentIndex < 0) return null

  const sourceDir = segments[cowAgentIndex + 1]
  if (
    sourceDir !== "skills" &&
    sourceDir !== "enabled-skills" &&
    sourceDir !== "enabled-skills-builtin" &&
    sourceDir !== "enabled-skills-custom"
  ) {
    return null
  }

  const skillDir = segments[cowAgentIndex + 2]?.trim()
  if (!skillDir) return null

  const rootSegments = segments.slice(0, cowAgentIndex + 3)
  const prefix = normalizedPath.startsWith("/") ? "/" : ""
  return normalizePath(`${prefix}${rootSegments.join("/")}`)
}

export class SkillUsageDetector {
  private readonly loadedSkillsByDocPath = new Map<string, string>()
  private readonly loadedSkillsByRootDir = new Map<string, string>()
  private readonly evolvedSkillIdentifiers = new Set<string>()
  private readonly localSkillLookupCache = new Map<string, string | null>()
  private readonly usedSkillNames = new Set<string>()
  private readonly usedEvolvedSkillNames = new Set<string>()
  private readonly skillSourceByIdentifier = new Map<string, string>()
  private readonly usedSkillSourceRefs = new Set<string>()

  onSkillsMetadata(skills: SkillMetadataLite[]): void {
    for (const skill of skills) {
      const skillName = typeof skill.name === "string" ? skill.name.trim() : ""
      const skillPath = typeof skill.path === "string" ? normalizePath(skill.path.trim()) : ""
      const { identifier: skillIdentifier, evolved } = resolveSkillInfo(skillName, skill.version, skillPath)
      if (!skillName || !skillPath || !skillIdentifier) continue

      const pluginSource = findPluginSkillSource(skillPath)
      const skillSourceRef = pluginSource
        ? makePluginSkillSourceRef(pluginSource.pluginId, skillIdentifier, pluginSource.pluginName)
        : ""
      for (const candidatePath of getSkillPathAliases(skillPath)) {
        this.registerSkillPath(candidatePath, skillIdentifier, evolved, skillSourceRef)
      }
    }
  }

  private registerSkillPath(
    skillPath: string,
    skillIdentifier: string,
    evolved = false,
    skillSourceRef = ""
  ): void {
    const normalizedSkillPath = normalizePath(skillPath)
    if (!normalizedSkillPath || !skillIdentifier) return

    this.loadedSkillsByDocPath.set(normalizedSkillPath, skillIdentifier)
    if (evolved) this.evolvedSkillIdentifiers.add(skillIdentifier)
    const resolvedSkillSourceRef =
      skillSourceRef ||
      (() => {
        const pluginSource = findPluginSkillSource(normalizedSkillPath)
        return pluginSource
          ? makePluginSkillSourceRef(pluginSource.pluginId, skillIdentifier, pluginSource.pluginName)
          : ""
      })()
    if (resolvedSkillSourceRef) {
      this.skillSourceByIdentifier.set(skillIdentifier, resolvedSkillSourceRef)
    }
    const rootDir = normalizePath(pathPosix.dirname(normalizedSkillPath))
    if (rootDir && rootDir !== ".") {
      this.loadedSkillsByRootDir.set(rootDir, skillIdentifier)
    }
  }

  private resolveLocalSkillIdentifier(normalizedPath: string): string | null {
    const rootDir = getLocalSkillRootDir(normalizedPath)
    if (!rootDir) return null
    if (this.localSkillLookupCache.has(rootDir)) {
      return this.localSkillLookupCache.get(rootDir) ?? null
    }

    const skillDocPath = `${rootDir}/SKILL.md`
    const fallbackName = rootDir.split("/").filter(Boolean).at(-1) ?? ""
    const { identifier: skillIdentifier, evolved } = resolveSkillInfo(fallbackName, undefined, skillDocPath, {
      fallbackWhenUnreadable: false
    })
    if (!skillIdentifier) {
      this.localSkillLookupCache.set(rootDir, null)
      return null
    }

    this.registerSkillPath(skillDocPath, skillIdentifier, evolved)
    this.localSkillLookupCache.set(rootDir, skillIdentifier)
    return skillIdentifier
  }

  private markSkillUsed(skillIdentifier: string): void {
    this.usedSkillNames.add(skillIdentifier)
    if (this.evolvedSkillIdentifiers.has(skillIdentifier)) {
      this.usedEvolvedSkillNames.add(skillIdentifier)
    }
    const skillSourceRef = this.skillSourceByIdentifier.get(skillIdentifier)
    if (skillSourceRef) this.usedSkillSourceRefs.add(skillSourceRef)
  }

  /**
   * Record a read_file path and check whether it matches any loaded skill.
   * Returns `true` when at least one new skill name was added to the set
   * (callers can use this to immediately refresh downstream state, e.g.
   * tracer.setUsedSkills / adoption context, so that subsequent code_gen
   * events in the same turn carry the skill attribution).
   */
  onReadFilePath(rawPath: string): boolean {
    const normalized = normalizePath(rawPath.trim())
    if (!normalized) return false

    const priorSize = this.usedSkillNames.size

    const localSkillIdentifier = this.resolveLocalSkillIdentifier(normalized)
    if (localSkillIdentifier) {
      this.markSkillUsed(localSkillIdentifier)
      return this.usedSkillNames.size > priorSize
    }

    const exactMatch = this.loadedSkillsByDocPath.get(normalized)
    if (exactMatch) {
      this.markSkillUsed(exactMatch)
      return this.usedSkillNames.size > priorSize
    }

    for (const [rootDir, skillName] of this.loadedSkillsByRootDir.entries()) {
      if (normalized === rootDir || normalized.startsWith(`${rootDir}/`)) {
        this.markSkillUsed(skillName)
      }
    }
    if (this.usedSkillNames.size > priorSize) return true

    return this.usedSkillNames.size > priorSize
  }

  getUsedSkillNames(): string[] {
    return Array.from(this.usedSkillNames)
  }

  getUsedEvolvedSkillNames(): string[] {
    return Array.from(this.usedEvolvedSkillNames)
  }

  getUsedSkillSourceRefs(): string[] {
    return Array.from(this.usedSkillSourceRefs)
  }

  hasUsedSkills(): boolean {
    return this.usedSkillNames.size > 0
  }
}

/**
 * The popup should display the same count that crossed the threshold.
 */
export function getAutoProposeToolCallCount(turnToolCallCount: number): number {
  return turnToolCallCount
}
