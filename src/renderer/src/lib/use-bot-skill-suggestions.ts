import { botApi } from "@/lib/bot-api"
import { useEffect, useMemo, useState } from "react"
import type { BotSkillCandidate, BotSkillReference } from "../../../shared/bot-skill-references"
import { useBotComposerSuggestions } from "./use-bot-composer-suggestions"
import { botViewAddress } from "./bot-thread-view"

export function useBotSkillSuggestions(input: {
  conversationId: string
  recipients: string[]
  prompt: string
  caret: number
  enabled: boolean
  dataEpoch?: string
  hostId?: string
  activation: { id: number; query: string; position: number } | null
  dismiss(): void
  choose(reference: BotSkillReference, from: number, to: number): void
}) {
  const scope = JSON.stringify([
    input.conversationId,
    input.dataEpoch,
    input.hostId,
    [...input.recipients].sort()
  ])
  const requestKey = JSON.stringify([scope, input.activation?.id])
  const [catalog, setCatalog] = useState<{
    requestKey: string
    items: BotSkillCandidate[]
    error?: string
  } | null>(null)
  const candidates = useMemo(
    () =>
      (catalog?.requestKey === requestKey ? catalog.items : []).map((skill) => ({
        id: `${skill.botId}:${skill.id}`,
        category: "skills",
        label: skill.name,
        subtitle: `${skill.scope === "desktop" ? `${skill.sourceName} · ` : skill.scope === "user" ? "共享技能 · " : ""}${skill.botName} · v${skill.version}`,
        keywords: [skill.botName]
      })),
    [catalog, requestKey]
  )
  const picker = useBotComposerSuggestions({
    ...input,
    scope,
    char: "/",
    entries: candidates,
    choose(entry, from, to) {
      const skill =
        catalog?.requestKey === requestKey
          ? catalog.items.find((skill) => `${skill.botId}:${skill.id}` === entry.id)
          : undefined
      if (skill)
        input.choose(
          { botId: skill.botId, id: skill.id, version: skill.version, name: skill.name },
          from,
          to
        )
    }
  })
  useEffect(() => {
    if (!picker.open) return
    let cancelled = false
    const [conversationId, , , recipients] = JSON.parse(scope) as [
      string,
      string | null,
      string | null,
      string[]
    ]
    void botApi
      .skillCandidates({
        conversationId: botViewAddress(conversationId).conversationId,
        recipients
      })
      .then(
        (items) => {
          if (!cancelled) setCatalog({ requestKey, items })
        },
        (error) => {
          if (!cancelled)
            setCatalog({
              requestKey,
              items: [],
              error: error instanceof Error ? error.message : "技能加载失败"
            })
        }
      )
    return () => {
      cancelled = true
    }
  }, [picker.open, scope, requestKey])
  return {
    ...picker,
    loading: catalog?.requestKey !== requestKey,
    error: catalog?.requestKey === requestKey ? catalog.error : undefined
  }
}
