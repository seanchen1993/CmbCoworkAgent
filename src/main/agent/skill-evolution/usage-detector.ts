import { posix as pathPosix } from "path"

export interface SkillMetadataLite {
  name?: string
  path?: string
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
}

export class SkillUsageDetector {
  private readonly loadedSkillsByDocPath = new Map<string, string>()
  private readonly loadedSkillsByRootDir = new Map<string, string>()
  private readonly knownSkillNames = new Set<string>()
  private readonly usedSkillNames = new Set<string>()
  /**
   * Explicit slash invocations recorded before a matching onSkillsMetadata
   * event has populated the known-skill set. We flush them the first time
   * metadata does arrive. Without this buffer the validation gate would
   * silently drop an explicit invocation that raced the graph's `values`
   * stream event.
   */
  private readonly pendingExplicitNames: string[] = []

  onSkillsMetadata(skills: SkillMetadataLite[]): void {
    for (const skill of skills) {
      const skillName = typeof skill.name === "string" ? skill.name.trim() : ""
      const skillPath = typeof skill.path === "string" ? normalizePath(skill.path.trim()) : ""
      if (!skillName || !skillPath) continue

      this.loadedSkillsByDocPath.set(skillPath, skillName)
      this.knownSkillNames.add(skillName)
      const rootDir = normalizePath(pathPosix.dirname(skillPath))
      if (rootDir && rootDir !== ".") {
        this.loadedSkillsByRootDir.set(rootDir, skillName)
      }
    }
    // Flush explicit invocations that arrived before their metadata did.
    for (let i = this.pendingExplicitNames.length - 1; i >= 0; i--) {
      const name = this.pendingExplicitNames[i]
      if (this.knownSkillNames.has(name)) {
        this.usedSkillNames.add(name)
        this.pendingExplicitNames.splice(i, 1)
      }
    }
  }

  /**
   * Register a skill name as "known" without seeding a path index.
   * Used by the slash-command flow: we have an authenticated name but no
   * reason to pollute the rootDir / docPath maps (those are only useful for
   * detecting implicit usage via `read_file`; explicit invocations bypass
   * that detection path).
   */
  seedKnownSkill(skillName: string): void {
    const trimmed = skillName.trim()
    if (trimmed) this.knownSkillNames.add(trimmed)
  }

  /**
   * Record a skill used via an explicit UI invocation (slash command).
   * Name-only match — no path cross-check — because with disabled skills the
   * runtime loads from a copied enabled-skills directory, so the renderer's
   * source path won't equal any loaded path. A strict path check would
   * silently drop every legitimate slash invocation once any skill is off.
   * Worst case of name-only: a spoofed renderer bumps one skill's own usage
   * counter; no privilege escalation, just self-inflated stats.
   */
  onExplicitInvocation(skillName: string): void {
    const trimmed = skillName.trim()
    if (!trimmed) return
    if (this.knownSkillNames.has(trimmed)) {
      this.usedSkillNames.add(trimmed)
      return
    }
    this.pendingExplicitNames.push(trimmed)
  }

  onReadFilePath(rawPath: string): void {
    const normalized = normalizePath(rawPath.trim())
    if (!normalized) return

    const exactMatch = this.loadedSkillsByDocPath.get(normalized)
    if (exactMatch) {
      this.usedSkillNames.add(exactMatch)
      return
    }

    for (const [rootDir, skillName] of this.loadedSkillsByRootDir.entries()) {
      if (normalized === rootDir || normalized.startsWith(`${rootDir}/`)) {
        this.usedSkillNames.add(skillName)
      }
    }
  }

  getUsedSkillNames(): string[] {
    return Array.from(this.usedSkillNames)
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
