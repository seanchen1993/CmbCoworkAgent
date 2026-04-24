/**
 * Per-thread active slash context.
 *
 * The problem: HITL/interrupt/resume flows re-enter the agent without a fresh
 * user message. When the renderer calls agent:resume, there is no `message` or
 * `slashInvocation` on the wire — but the model is still mid-turn on a skill
 * invocation, and the middleware needs the rendered SKILL.md context for every
 * model call inside the tool loop.
 *
 * The solution:
 *   1. In-memory `activeContexts` keyed by threadId. set() on fresh invoke
 *      after resolve succeeds; clear() when the turn terminates.
 *   2. If the process restarts mid-turn (memory lost), rehydrate from the
 *      checkpoint: scan the last HumanMessage for `additional_kwargs.cmb_skill_ref`
 *      and re-run the registry/dispatch path to reload SKILL.md from disk.
 *      If the skill has since been disabled/deleted, rehydrate returns null and
 *      the resume continues without the skill (caller emits a hook notice).
 *
 * Body is never stored here across turns — we only hold it for the duration of
 * one streaming run, and even that holds only per-thread.
 */
import { resolveSlashInvocation } from "./dispatch"
import type { SlashInvocation, SlashSkillRef, TransientSlashModelContext } from "./types"

const activeContexts = new Map<string, TransientSlashModelContext>()

export function setActiveSlashContext(threadId: string, context: TransientSlashModelContext): void {
  activeContexts.set(threadId, context)
}

export function getActiveSlashContext(threadId: string): TransientSlashModelContext | undefined {
  return activeContexts.get(threadId)
}

export function clearActiveSlashContext(threadId: string): void {
  activeContexts.delete(threadId)
}

/**
 * Find a saved `cmb_skill_ref` in the checkpoint's message history.
 *
 * We look at ALL human messages in reverse order (most recent first) because a
 * resume can target mid-turn state where the latest message in state.messages
 * could be an AI response or tool result — the user message carrying the skill
 * ref may be a few positions back. We stop at the first human message that has
 * the field, which by convention is the current turn's original prompt.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSkillRefInMessages(messages: any[]): SlashSkillRef | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const kwargs = msg?.kwargs ?? msg ?? {}
    const classId = Array.isArray(msg?.id) ? msg.id : []
    const className = classId[classId.length - 1] || ""
    const looksHuman =
      className.includes("Human") || msg?.type === "human" || kwargs?.type === "human"
    if (!looksHuman) continue

    const additional = kwargs?.additional_kwargs as Record<string, unknown> | undefined
    const meta = additional?.cmb_meta
    // Skip transient skill-context messages — those also carry cmb_skill_ref
    // but represent the injected block, not the user prompt. We want the
    // prompt's ref, which is what survives across checkpoints.
    if (meta === "transient_skill_context") continue

    const ref = additional?.cmb_skill_ref as SlashSkillRef | undefined
    if (ref && typeof ref === "object" && (ref as { kind?: string }).kind === "skill") {
      return ref
    }
  }
  return null
}

/**
 * Rehydrate a transient context from the checkpoint. Returns null if:
 *   - no prior human message carried a cmb_skill_ref,
 *   - the ref's skill was disabled/deleted since last turn,
 *   - reading SKILL.md failed on disk.
 */
export async function rehydrateActiveSlashContextFromCheckpoint(
  threadId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpointMessages: any[]
): Promise<TransientSlashModelContext | null> {
  const existing = activeContexts.get(threadId)
  if (existing) return existing

  const ref = findSkillRefInMessages(checkpointMessages)
  if (!ref) return null

  const invocation: SlashInvocation = { kind: "skill", id: ref.id }
  const resolved = await resolveSlashInvocation(invocation)
  if (!resolved) return null

  const context: TransientSlashModelContext = { skill: resolved }
  activeContexts.set(threadId, context)
  return context
}
