import { z } from "zod"
import {
  botSkillReference,
  type BotSkillSelection,
  type BotSkillReference,
  type BotSkillCandidate
} from "../../shared/bot-skill-references"
import { BotDomainError, type BotSkill } from "../../shared/bot-types"
import type { BotStore } from "./store"
import * as v from "./validation"

/** Explicit user selections are stored as stable identities and exact accepted versions.
 * They never grant connector, shell or browser permissions. */
export class BotSkillReferences {
  constructor(private readonly store: BotStore) {}

  private rows(sql: string, values: string[]): Record<string, unknown>[] {
    const query = this.store.db.prepare(sql, values)
    try {
      const rows: Record<string, unknown>[] = []
      while (query.step()) rows.push(query.getAsObject())
      return rows
    } finally {
      query.free()
    }
  }

  private one(sql: string, values: string[]): Record<string, unknown> | undefined {
    return this.rows(sql, values)[0]
  }

  catalog(input: { conversationId: string; recipients?: string[] }): BotSkillCandidate[] {
    v.record(input)
    const conversation = this.store.getConversation(v.identifier(input.conversationId))
    const specified = input.recipients === undefined ? [] : v.uniqueIds(input.recipients, 0, 6)
    const recipients = specified.length ? specified : conversation.members
    const result: BotSkillCandidate[] = []
    for (const botId of recipients) {
      if (!conversation.members.includes(botId))
        throw new BotDomainError("skill_scope", "只能选择当前对话成员的技能")
      const bot = this.store.getBot(botId, true)
      if (bot.deletedAt !== null) continue
      for (const skill of this.store.skillLibrary.available(botId).filter((item) => item.enabled))
        result.push({
          ...botSkillReference.parse({
            botId,
            id: skill.id,
            name: skill.name,
            version: skill.version
          }),
          botName: bot.name,
          verified: skill.verified,
          ...(skill.sourceName ? { sourceName: skill.sourceName } : {}),
          scope: skill.scope ?? "bot"
        })
    }
    return result
  }

  resolve(selections: BotSkillSelection[], recipients: string[]): BotSkillReference[] {
    return selections.map((selection) => {
      if (!recipients.includes(selection.botId))
        throw new BotDomainError("skill_scope", "技能所属 Bot 不在本次接收者中")
      const skill = this.current(selection)
      return { ...selection, name: skill.name }
    })
  }

  private current(selection: BotSkillSelection): Pick<BotSkill, "name" | "version"> {
    return this.store.skillLibrary.current(selection.botId, selection.id, selection.version)
  }

  save(messageId: string, references: BotSkillReference[]): void {
    if (references.length)
      this.store.db.run("INSERT INTO bot_message_skills VALUES(?,?)", [
        messageId,
        JSON.stringify(references)
      ])
  }

  forMessage(messageId: string): BotSkillReference[] {
    const row = this.one("SELECT refs FROM bot_message_skills WHERE message_id=?", [messageId])
    return row
      ? z
          .array(botSkillReference)
          .max(6)
          .parse(JSON.parse(String(row.refs)))
      : []
  }

  forRun(runId: string): BotSkillReference[] {
    const run = this.store.getRun(runId)
    const origin =
      run.source === "group-member" ? this.store.groups.assignmentMessageId(runId) : null
    const references = [
      ...(origin ? [origin] : []),
      run.messageId,
      ...this.store.steering.acceptedMessageIds(runId)
    ]
      .flatMap((id) => this.forMessage(id))
      .filter((reference) => reference.botId === run.botId)
    return [...new Map(references.map((reference) => [reference.id, reference])).values()]
  }

  assertCurrent(references: BotSkillReference[]): void {
    for (const reference of references) this.current(reference)
  }
}
