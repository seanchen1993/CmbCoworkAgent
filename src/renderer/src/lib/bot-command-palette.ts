import type { BotSearchKind, BotSearchMatch } from "../../../shared/bot-search"
import {
  fuzzyPaletteScore,
  normalizePaletteSearch,
  paletteSearchTokens
} from "../components/bots/upstream/grok-palette-primitives"

export type BotPaletteTab = "all" | BotSearchKind | "action"
export interface BotPaletteCommand {
  id: string
  label: string
  keywords: string[]
  detail?: string
  children?: BotPaletteCommand[]
  run(): void
}
export interface BotPaletteConversation {
  id: string
  name: string
  detail: string
  group: boolean
  hidden: boolean
  /** Original roster identities, only for the existing avatar renderer. */
  memberIds?: readonly string[]
}
export interface BotPaletteRow {
  id: string
  label: string
  detail: string
  kind: BotSearchKind | "action"
  hidden?: boolean
  command?: BotPaletteCommand
  conversationId?: string
  memberIds?: readonly string[]
  match?: BotSearchMatch
}

/** Grok's token scoring and hidden-agent ordering, projected onto Cmb identities. */
export function botPaletteRows(
  conversations: BotPaletteConversation[],
  commands: BotPaletteCommand[],
  matches: BotSearchMatch[],
  query: string,
  tab: BotPaletteTab
): BotPaletteRow[] {
  const tokens = paletteSearchTokens(query),
    normalizedQuery = tokens.join(" ")
  const ranked: { row: BotPaletteRow; score: number }[] = []
  const add = (row: BotPaletteRow, keywords: string[]) => {
    if (tab !== "all" && row.kind !== tab) return
    if (row.hidden && !tokens.length) return
    const normalizedLabel = normalizePaletteSearch(row.label)
    const candidates = [normalizedLabel, ...keywords.map(normalizePaletteSearch)]
    let score = 0
    for (const token of tokens) {
      const scores = candidates
        .map((value) => fuzzyPaletteScore(value, token))
        .filter((value): value is number => value !== null)
      if (!scores.length) return
      score += Math.max(...scores)
    }
    ranked.push({ row, score: score + (fuzzyPaletteScore(normalizedLabel, normalizedQuery) ?? 0) })
  }
  for (const item of conversations)
    add(
      {
        id: `conversation:${item.id}`,
        label: item.name,
        detail: item.detail,
        kind: item.group ? "group" : "bot",
        hidden: item.hidden,
        conversationId: item.id,
        ...(item.memberIds ? { memberIds: item.memberIds } : {})
      },
      [item.detail]
    )
  for (const command of commands)
    add(
      {
        id: `action:${command.id}`,
        label: command.label,
        detail: command.detail ?? "操作",
        kind: "action",
        command
      },
      command.keywords
    )
  // Domain search owns content matching and paging. Never re-filter snippets:
  // a truncated preview may omit part of the matched original text.
  const remote: { row: BotPaletteRow; score: number }[] = matches
    .filter((match) => tab === "all" || match.kind === tab)
    .map((match) => ({
      row: {
        id: `${match.kind}:${match.id}`,
        label: match.kind === "message" || match.kind === "link" ? match.snippet : match.title,
        detail: match.conversationName,
        kind: match.kind,
        match
      },
      score: 0
    }))
  return [...ranked, ...remote]
    .sort((a, b) => Number(!!a.row.hidden) - Number(!!b.row.hidden) || b.score - a.score)
    .map((value) => value.row)
}
