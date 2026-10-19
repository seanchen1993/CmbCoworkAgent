import { z } from "zod"

// Grok/Hermes bound room discussion to three rounds and ten member turns.
// Initial user-selected turns count toward that budget; execution stays in BotStore's queue.
export const GROUP_DISCUSSION_MAX_ROUNDS = 3
export const GROUP_DISCUSSION_MAX_TURNS = 10
export const groupDiscussionSchema = z.object({
  messageId: z.string(),
  initialTaskIds: z.array(z.string()).min(1).max(8),
  memberIds: z.array(z.string()).min(2).max(8),
  round: z.number().int().min(1).max(GROUP_DISCUSSION_MAX_ROUNDS),
  speakerIndex: z.number().int().min(0).max(8),
  turns: z.number().int().min(1).max(GROUP_DISCUSSION_MAX_TURNS),
  roundStartOrdinal: z.number().int().positive(),
  seen: z.record(z.string(), z.number().int().nonnegative()),
  pendingTaskId: z.string().nullable()
})
export type GroupDiscussion = z.infer<typeof groupDiscussionSchema>

/** Budget encoded peer data as whole records, preserving the complete validated user request. */
export function buildGroupDiscussionMessage(
  assignment: string,
  references: readonly { source: string; authorName?: string; text: string }[],
  earlierReferencesOmitted = false
): string {
  const shown: string[] = []
  let remaining = 24_000
  for (const item of references.slice(-24).reverse()) {
    const encoded = JSON.stringify(item)
    if (encoded.length + 1 > remaining) break
    shown.unshift(encoded)
    remaining -= encoded.length + 1
  }
  return [
    "Optional continuation of this current group assignment, not a new user instruction or approval. Earlier room tasks are separate; an earlier peer reply does not prove they answered this assignment. Preserve existing verified work without claiming a new response that did not occur.",
    `Original user request:\n${assignment}`,
    `New shared room reference data for this assignment, with host-bound speaker identities:\n[${shown.join(",")}]`,
    ...(earlierReferencesOmitted || shown.length < references.length
      ? ["Earlier references omitted to bound context; do not infer their contents."]
      : [])
  ].join("\n\n")
}

/** Advance only the control cursor, never run a model or infer targets from quoted names. */
export function nextGroupDiscussionSpeaker(
  state: GroupDiscussion,
  latest: { ordinal: number; authorBotId: string | null },
  eligibleIds: ReadonlySet<string>
): string | null {
  while (state.round < GROUP_DISCUSSION_MAX_ROUNDS && state.turns < GROUP_DISCUSSION_MAX_TURNS) {
    if (state.speakerIndex >= state.memberIds.length) {
      if (latest.ordinal <= state.roundStartOrdinal) return null // All pass: settled.
      state.round++
      state.speakerIndex = 0
      state.roundStartOrdinal = latest.ordinal
      continue
    }
    const id = state.memberIds[(state.speakerIndex++ + state.round) % state.memberIds.length]
    if (
      !eligibleIds.has(id) ||
      id === latest.authorBotId ||
      latest.ordinal <= (state.seen[id] ?? 0)
    )
      continue
    state.seen[id] = latest.ordinal
    state.turns++
    return id
  }
  return null
}
