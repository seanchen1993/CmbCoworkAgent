import { AsyncLocalStorage } from "node:async_hooks"
import { isAIMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { ModelRefusalError, readModelRefusal } from "./model-refusal"

const outcomes = new AsyncLocalStorage<{ active: boolean; refused: boolean }>()

/** Native task outcome, independent of Mods. Nested tasks receive distinct invocation scopes. */
export async function withTaskModelOutcome<T>(
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const outcome = { active: true, refused: false }
  return outcomes.run(outcome, async () => {
    try {
      signal?.throwIfAborted()
      const result = await run()
      signal?.throwIfAborted()
      if (outcome.refused) throw new ModelRefusalError()
      return result
    } catch (error) {
      signal?.throwIfAborted()
      throw error
    } finally {
      outcome.active = false
    }
  })
}

export function createTaskModelOutcomeMiddleware() {
  return createMiddleware({
    name: "taskModelOutcome",
    afterModel: {
      canJumpTo: ["end"],
      hook: (state) => {
        const outcome = outcomes.getStore()
        const message = state.messages.at(-1)
        if (!outcome?.active || !message || !isAIMessage(message) || !readModelRefusal(message))
          return
        outcome.refused = true
        return { jumpTo: "end" }
      }
    }
  })
}
