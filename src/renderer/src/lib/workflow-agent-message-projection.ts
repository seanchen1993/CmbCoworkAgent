import type { Message } from "../types"
import { areMessageRenderFieldsEqual } from "./message-render-stability"

function sameWorkflowMessage(left: Message, right: Message): boolean {
  return (
    areMessageRenderFieldsEqual(left, right) &&
    left.provider_source_id === right.provider_source_id &&
    left.provider_occurrence === right.provider_occurrence &&
    left.tool_call_id === right.tool_call_id &&
    left.name === right.name &&
    left.status === right.status &&
    left.is_error === right.is_error
  )
}

/**
 * Workflow frames are complete, bounded snapshots (400 messages / 1M characters),
 * not token deltas with a proven unchanged prefix. Inspect every slot so an older
 * correction, replacement or reorder cannot leave stale text on screen.
 *
 * The workflow converter synthesizes created_at on each conversion. Ignore that
 * receipt time when reusing otherwise unchanged rows so identical frames and
 * unchanged history stop at the memo boundary. Scope reuse to the focused agent.
 */
export function createWorkflowAgentMessageProjector(): (
  incoming: readonly Message[],
  scope: string
) => Message[] {
  let previousScope: string | undefined
  let previous: Message[] = []

  return (incoming, scope) => {
    if (scope !== previousScope) {
      previousScope = scope
      previous = incoming.slice()
      return previous
    }

    let next: Message[] | undefined
    for (let index = 0; index < incoming.length; index += 1) {
      const message = incoming[index]
      const existing = previous[index]
      if (existing && sameWorkflowMessage(existing, message)) continue
      next ??= previous.slice(0, incoming.length)
      next[index] = message
    }
    if (!next && incoming.length === previous.length) return previous

    // A shorter snapshot can consist entirely of unchanged rows. Preserve those
    // objects, but never mutate a previously published array during replacement.
    previous = next ?? previous.slice(0, incoming.length)
    return previous
  }
}
