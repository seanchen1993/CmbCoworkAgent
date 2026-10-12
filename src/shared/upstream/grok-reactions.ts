// Extracted original Grok reaction identifiers, quick palette and projection helpers. See PROVENANCE.
export const SAND_REACTION_SELF = "me" as const

export const QUICK_REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const

export interface TranscriptReaction {
  readonly emoji: string
  readonly by: string
}

export interface TranscriptReactionProjection {
  readonly reactions: readonly TranscriptReaction[]
  readonly myReactions: ReadonlySet<string>
}

export function projectTranscriptReactions(value: unknown): TranscriptReactionProjection {
  if (!Array.isArray(value)) return { reactions: [], myReactions: new Set() }
  const reactions: TranscriptReaction[] = []
  const myReactions = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate == null || Array.isArray(candidate)) continue
    const reaction = candidate as { emoji?: unknown; by?: unknown }
    if (
      typeof reaction.emoji !== "string" ||
      reaction.emoji.length === 0 ||
      typeof reaction.by !== "string" ||
      reaction.by.length === 0
    )
      continue
    const projected = { emoji: reaction.emoji, by: reaction.by }
    reactions.push(projected)
    if (reaction.by === SAND_REACTION_SELF) myReactions.add(reaction.emoji)
  }
  return { reactions, myReactions }
}

export interface ReactionCountProjection {
  readonly emoji: string
  readonly count: number
  readonly isMine: boolean
  readonly reactors: readonly string[]
}

/** Mirrors the immutable DTe first-seen emoji grouping and reactor dedupe. */
export function projectReactionCounts(
  reactions: readonly TranscriptReaction[] = []
): ReactionCountProjection[] {
  const order: string[] = []
  const grouped = new Map<string, { count: number; isMine: boolean; reactors: string[] }>()
  for (const reaction of reactions) {
    if (
      typeof reaction.emoji !== "string" ||
      reaction.emoji.length === 0 ||
      typeof reaction.by !== "string" ||
      reaction.by.length === 0
    )
      continue
    const current = grouped.get(reaction.emoji)
    if (current == null) {
      order.push(reaction.emoji)
      grouped.set(reaction.emoji, {
        count: 1,
        isMine: reaction.by === SAND_REACTION_SELF,
        reactors: [reaction.by]
      })
      continue
    }
    current.count += 1
    current.isMine = current.isMine || reaction.by === SAND_REACTION_SELF
    if (!current.reactors.includes(reaction.by)) current.reactors.push(reaction.by)
  }
  return order.map((emoji) => {
    const value = grouped.get(emoji)
    return {
      emoji,
      count: value?.count ?? 0,
      isMine: value?.isMine ?? false,
      reactors: value?.reactors ?? []
    }
  })
}
