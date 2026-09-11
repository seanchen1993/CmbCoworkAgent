export interface SkillDisabledIntent {
  version: number
  disabled: boolean
}

/**
 * Keeps optimistic per-skill intents on top of the latest authoritative main-
 * process snapshot. Responses may arrive after a newer click or a catalog
 * refresh; overlaying pending intent prevents either from visibly reverting
 * the newer user choice.
 */
export class SkillDisabledMutationCoordinator {
  private authoritative: Set<string>
  private readonly pending = new Map<string, SkillDisabledIntent>()
  private nextVersion = 1

  constructor(initial: Iterable<string>) {
    this.authoritative = new Set(initial)
  }

  begin(skillId: string, disabled: boolean): { version: number; snapshot: Set<string> } {
    const version = this.nextVersion++
    this.pending.set(skillId, { version, disabled })
    return { version, snapshot: this.snapshot() }
  }

  settle(skillId: string, version: number, authoritative: Iterable<string>): Set<string> {
    this.authoritative = new Set(authoritative)
    if (this.pending.get(skillId)?.version === version) this.pending.delete(skillId)
    return this.snapshot()
  }

  replaceAuthoritative(authoritative: Iterable<string>): Set<string> {
    this.authoritative = new Set(authoritative)
    return this.snapshot()
  }

  abandon(skillId: string, version: number, authoritative?: Iterable<string>): Set<string> {
    if (authoritative) this.authoritative = new Set(authoritative)
    if (this.pending.get(skillId)?.version === version) this.pending.delete(skillId)
    return this.snapshot()
  }

  snapshot(): Set<string> {
    const result = new Set(this.authoritative)
    for (const [skillId, intent] of this.pending) {
      if (intent.disabled) result.add(skillId)
      else result.delete(skillId)
    }
    return result
  }
}
