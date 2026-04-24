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
  // Explicit invocations parsed from the user message arrive *before* skills metadata is
  // pushed by the runtime (see ipc/agent.ts ordering). Buffer them and flush when metadata
  // lands so the validation gate doesn't reject legitimate slash invocations just because
  // the metadata hasn't streamed in yet.
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
    // Flush any explicit invocations that arrived before metadata was available.
    for (let i = this.pendingExplicitNames.length - 1; i >= 0; i--) {
      const name = this.pendingExplicitNames[i]
      if (this.knownSkillNames.has(name)) {
        this.usedSkillNames.add(name)
        this.pendingExplicitNames.splice(i, 1)
      }
    }
  }

  /**
   * Record a skill used via an explicit UI invocation (e.g. slash-command skill selection).
   * Unlike onReadFilePath, this path doesn't rely on the model issuing a read_file call,
   * because the SKILL.md body is inlined into the user message upfront.
   *
   * Validates the name against the loaded skills set. We intentionally only match on name,
   * not on path: when the user has disabled one or more skills, the runtime loads the
   * enabled subset from a *copied* enabled-skills directory, so the path the renderer
   * sends (the original skills/ or custom/ location) won't equal any loaded path. A strict
   * path check therefore silently drops every legitimate invocation once any skill is
   * disabled. Missing path correlation is an acceptable trade: a spoofed message with a
   * real skill name can bump that skill's own usage counter by one per send — the only
   * damage is a user "self-inflating" their own stats, no privilege escalation.
   * If metadata hasn't arrived yet, the name is buffered and re-checked on the next
   * onSkillsMetadata call.
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
