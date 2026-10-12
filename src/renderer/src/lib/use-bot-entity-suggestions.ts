import { findSpaceSuggestionMatch } from "../components/bots/upstream/grok-suggestion-match"
import { useEffect, useState } from "react"
import { botApi } from "./bot-api"
import { botViewAddress } from "./bot-thread-view"
import { useBotComposerSuggestions } from "./use-bot-composer-suggestions"
import {
  botEntityLabels,
  type BotEntityReference,
  type BotEntitySelection
} from "../../../shared/bot-entity-references"
import type { CoworkBot } from "../../../shared/bot-types"

type Category = "all" | BotEntitySelection["kind"]
export function useBotEntitySuggestions(input: {
  conversationId: string
  dataEpoch?: string
  prompt: string
  caret: number
  enabled: boolean
  entitySupport: boolean
  group: boolean
  members: CoworkBot[]
  choose(reference: BotEntityReference | null, from: number, to: number): void
}) {
  const scope = JSON.stringify([input.conversationId, input.dataEpoch])
  const [filter, setFilter] = useState<{ scope: string; category: Category }>({
    scope,
    category: "all"
  })
  const category = filter.scope === scope ? filter.category : "all"
  const [catalog, setCatalog] = useState<{
    key: string
    items: BotEntityReference[]
    error?: string
  } | null>(null)
  // Matching and arrow/Enter/Escape behavior comes from the existing Grok adapter.
  const query = (
    findSpaceSuggestionMatch({
      char: "@",
      $position: {
        pos: input.caret,
        nodeBefore: { isText: true, text: input.prompt.slice(0, input.caret) },
        nodeAfter: { isText: true, text: input.prompt.slice(input.caret) }
      }
    })?.query ?? ""
  ).slice(0, 100)
  const key = JSON.stringify([scope, category, query])
  const items = catalog?.key === key ? catalog.items : []
  const groupBots = input.group
    ? input.members.map((bot) => ({ kind: "bot" as const, id: bot.id, name: bot.name }))
    : []
  const references = [
    ...groupBots,
    ...items.filter((item) => item.kind !== "bot" || !groupBots.some((bot) => bot.id === item.id))
  ].filter((item) => category === "all" || item.kind === category)
  const suggestions = useBotComposerSuggestions({
    scope: `${scope}:${category}`,
    char: "@",
    prompt: input.prompt,
    caret: input.caret,
    enabled: input.enabled,
    entries: [
      ...(input.group && (category === "all" || category === "bot")
        ? [
            {
              id: "all-recipients",
              category: "all",
              label: "全体 Bot",
              subtitle: "由群内成员协作",
              keywords: ["everyone", "all"]
            }
          ]
        : []),
      ...references.map((item) => ({
        id: `${item.kind}:${item.id}`,
        category: item.kind,
        label: item.name,
        subtitle: `${item.kind === "bot" && groupBots.some((bot) => bot.id === item.id) ? "群内成员 · 接收工作" : botEntityLabels[item.kind]}${references.some((other) => other.kind === item.kind && other.id !== item.id && other.name === item.name) ? ` · ${item.id.slice(-8)}` : ""}`,
        keywords: [botEntityLabels[item.kind], item.id]
      }))
    ],
    choose(entry, from, to) {
      if (entry.category === "all") input.choose(null, from, to)
      else {
        const reference = references.find((item) => `${item.kind}:${item.id}` === entry.id)
        if (reference) input.choose(reference, from, to)
      }
    }
  })
  useEffect(() => {
    if (!suggestions.open || !input.entitySupport) return
    let cancelled = false
    const timer = setTimeout(() => {
      void botApi
        .referenceCandidates({
          conversationId: botViewAddress(input.conversationId).conversationId,
          query,
          ...(category === "all" ? {} : { kind: category })
        })
        .then(
          (items) => {
            if (!cancelled) setCatalog({ key, items })
          },
          (error) => {
            if (!cancelled)
              setCatalog({
                key,
                items: [],
                error: error instanceof Error ? error.message : "引用加载失败"
              })
          }
        )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [suggestions.open, input.entitySupport, input.conversationId, query, category, key])
  return {
    ...suggestions,
    category,
    setCategory: (category: Category) => setFilter({ scope, category }),
    loading: input.entitySupport && catalog?.key !== key,
    error: catalog?.key === key ? catalog.error : undefined
  }
}
