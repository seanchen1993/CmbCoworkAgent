import { resolve } from "path"
import type { SkillLifecycleMatch } from "./registry"

export type SkillActivationTrigger = "explicit" | "read_file"

export interface SkillUseRecord extends SkillLifecycleMatch {
  key: string
  trigger: SkillActivationTrigger
  triggerToolName: string
}

export interface SkillUseTracker {
  recordSkillUse(
    skill: SkillLifecycleMatch,
    options: {
      trigger: SkillActivationTrigger
      triggerToolName: string
    }
  ): void
  getPendingPostSkillUses(): SkillUseRecord[]
  markPostSkillUseFired(key: string): void
  getUsedSkillNames(): string[]
  /**
   * Drop records whose `shouldKeep` predicate returns false. Called at
   * HITL interrupt boundaries so non-persistent skills' pending PostSkillUse
   * are not retained across the boundary. Also clears the corresponding
   * `markPostSkillUseFired` entries so a re-activated skill can fire Post
   * again at terminal completion.
   */
  pruneRecords(shouldKeep: (record: SkillUseRecord) => boolean): void
}

function normalizePathKey(input: string): string {
  const normalized = resolve(input).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function getSkillUseKey(skill: SkillLifecycleMatch): string {
  return normalizePathKey(skill.rootDir)
}

export function createSkillUseTracker(): SkillUseTracker {
  const records = new Map<string, SkillUseRecord>()
  const postSkillUseFired = new Set<string>()

  return {
    recordSkillUse(skill, options) {
      const key = getSkillUseKey(skill)
      if (records.has(key)) return
      records.set(key, {
        ...skill,
        key,
        trigger: options.trigger,
        triggerToolName: options.triggerToolName
      })
    },
    getPendingPostSkillUses() {
      return [...records.values()].filter((record) => !postSkillUseFired.has(record.key))
    },
    markPostSkillUseFired(key) {
      postSkillUseFired.add(key)
    },
    getUsedSkillNames() {
      const names: string[] = []
      const seen = new Set<string>()
      for (const record of records.values()) {
        const normalized = record.name.trim().toLowerCase()
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        names.push(record.name)
      }
      return names
    },
    pruneRecords(shouldKeep) {
      for (const [key, record] of [...records.entries()]) {
        if (!shouldKeep(record)) {
          records.delete(key)
          postSkillUseFired.delete(key)
        }
      }
    }
  }
}
