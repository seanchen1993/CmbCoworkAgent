import { z } from "zod"
import {
  botSkillReference,
  botSkillSelections,
  type BotSkillReference
} from "../../shared/bot-skill-references"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { canonicalJson } from "./validation"

/** Reuses message skill references and execution fences; a schedule grants no new authority. */
export class BotRoutineSkills {
  constructor(private readonly store: BotStore) {}

  read(id: string): BotSkillReference[] {
    const row = this.store.db.exec("SELECT refs FROM bot_routine_skills WHERE routine_id=?", [
      id
    ])[0]?.values[0]
    return row
      ? z
          .array(botSkillReference)
          .max(6)
          .parse(JSON.parse(String(row[0])))
      : []
  }

  resolve(botId: string, input: unknown, previous: BotSkillReference[]): BotSkillReference[] {
    if (input === undefined) return previous
    const parsed = botSkillSelections.safeParse(input)
    if (!parsed.success) throw new BotDomainError("invalid_input", "例程技能选择无效")
    return parsed.data.map((selection) => {
      if (selection.botId !== botId)
        throw new BotDomainError("skill_scope", "例程只能使用所属 Bot 的技能")
      const existing = previous.find(
        (item) => item.id === selection.id && item.version === selection.version
      )
      // A paused routine can retain its old binding while the user edits or removes it.
      if (existing) return existing
      const reference = this.store.skillReferences.resolve([selection], [botId])[0]
      this.assert([reference])
      return reference
    })
  }

  assert(references: BotSkillReference[]): void {
    for (const reference of references) {
      const skill = this.store.skillLibrary.current(
        reference.botId,
        reference.id,
        reference.version
      )
      if (!skill.verified)
        throw new BotDomainError(
          "skill_unverified",
          `技能「${reference.name}」版本 ${reference.version} 尚未通过试跑验收`
        )
    }
  }

  issue(references: BotSkillReference[]): { message: string; code: string } | undefined {
    try {
      this.assert(references)
      return undefined
    } catch (error) {
      if (
        error instanceof BotDomainError &&
        [
          "skill_changed",
          "skill_unavailable",
          "skill_unverified",
          "skill_catalog_unavailable"
        ].includes(error.code)
      )
        return { message: error.message, code: error.code }
      throw error
    }
  }

  save(id: string, references: BotSkillReference[]): void {
    if (!references.length)
      this.store.db.run("DELETE FROM bot_routine_skills WHERE routine_id=?", [id])
    else
      this.store.db.run(
        "INSERT INTO bot_routine_skills VALUES(?,?) ON CONFLICT(routine_id) DO UPDATE SET refs=excluded.refs",
        [id, canonicalJson(references)]
      )
  }
}
