/**
 * Transient slash-skill middleware.
 *
 * Inject the resolved SKILL.md body into `request.messages` every time the
 * model is called, but NEVER into `state.messages`. This matters:
 *
 *   - Checkpointer only persists `state.messages`, so the skill body stays out
 *     of the saved thread — even after multiple tool loops within a turn.
 *   - Summarization middleware also reads `state.messages`, so the summariser
 *     never sees (and never compresses) the skill body.
 *   - Every model call within the same turn re-injects, so the model keeps the
 *     instructions in view even after long tool loops.
 *
 * Placement note: this middleware must run BEFORE summarization in the deep-
 * agent middleware array. When summarization rewrites state.messages, our
 * injection is irrelevant to it (we only mutate request.messages downstream),
 * but the ordering also guarantees our injection happens on the already-
 * summarized messages, so the final model prompt is: summarized-history +
 * skill-context + current-turn.
 */
import { HumanMessage } from "@langchain/core/messages"
import type { TransientSlashModelContext } from "./types"

/**
 * Produce a middleware object compatible with deepagents' `createDeepAgent`
 * `middleware` array (which forwards into LangChain's `createAgent`). When
 * `context` is null we return a no-op middleware so callers can unconditionally
 * hand us `context ?? null` without branching at the call site.
 */

export function createTransientSlashContextMiddleware(
  context: TransientSlashModelContext | null
): unknown {
  if (!context) {
    return {
      name: "transientSlashContext:noop",
      wrapModelCall: async (request: unknown, handler: (req: unknown) => Promise<unknown>) =>
        handler(request)
    }
  }

  const skillMsg = new HumanMessage({
    content: context.skill.renderedContext,
    additional_kwargs: {
      // Marker so every consumer can skip this message with a one-line filter.
      // Memory summariser, proposal window, trace collector, and the UI bubble
      // renderer all look at this field.
      cmb_meta: "transient_skill_context",
      cmb_skill_ref: context.skill.ref
    }
  })

  return {
    name: "transientSlashContext",
    wrapModelCall: async (
      request: { messages?: unknown[] } & Record<string, unknown>,
      handler: (req: Record<string, unknown>) => Promise<unknown>
    ) => {
      const messages = Array.isArray(request?.messages) ? request.messages : []
      // Inject just before the final HumanMessage so the skill reads like a
      // system-authored hint preceding the user's turn. If the tail of the
      // array isn't a HumanMessage (e.g. a tool loop re-entry), fall back to
      // appending at the end — the model still sees skill instructions, just
      // positioned after recent tool output.
      let insertAt = messages.length
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as
          | { _getType?: () => string; type?: string; role?: string }
          | undefined
        const msgType =
          // LangChain messages expose role via _getType() or .role; be
          // defensive since shape varies across chunks vs full messages.
          (typeof msg?._getType === "function" && msg._getType()) || msg?.type || msg?.role || ""
        if (msgType === "human") {
          insertAt = i
          break
        }
      }

      const injected = [...messages.slice(0, insertAt), skillMsg, ...messages.slice(insertAt)]

      return handler({ ...request, messages: injected })
    }
  }
}
