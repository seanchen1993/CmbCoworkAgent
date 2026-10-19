import type { FunctionGuest } from "../../../shared/mods/v2/contracts"
import { matchesEventPattern } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"
import {
  CREATOR_PLANNING_MAX_CHARS,
  CREATOR_PLANNING_SECTION
} from "../../../shared/mods/creator-planning"
import { FunctionDispatcher } from "../v2/dispatcher"

/** A pure optional planning section using the original Function Mod dispatcher and VM.
 * No session startup, SDK, tools, grants or host result receipts are available here.
 */
export async function invokeCreatorPlanningGuest(input: {
  guest: FunctionGuest
  name: string
  root: string
  signal: AbortSignal
  assertCurrent(): void
}): Promise<string> {
  input.assertCurrent()
  if (!input.guest.registrations.some((row) => matchesEventPattern(row.pattern, "prompt.section")))
    throw Error("CREATOR_PLANNING_HANDLER_MISSING")
  let denied = false
  const observedGuest: FunctionGuest = {
    registrations: input.guest.registrations,
    get stats() {
      return input.guest.stats
    },
    matches: (id, event) => input.guest.matches(id, event),
    invoke: (id, event, host, options) =>
      input.guest.invoke(
        id,
        event,
        async (method, ...args) => {
          if (method !== "next") denied = true
          return host(method, ...args)
        },
        options
      ),
    dispose: () => input.guest.dispose(),
    releaseUi: (generation) => input.guest.releaseUi(generation)
  }
  const plugin = {
    name: input.name,
    root: input.root,
    tier: "user" as const,
    capabilities: [],
    guest: observedGuest
  }
  const dispatcher = new FunctionDispatcher([plugin])
  const validate = (_event: string, value: unknown) => {
    input.assertCurrent()
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== "text") ||
      !("text" in value) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > CREATOR_PLANNING_MAX_CHARS
    )
      throw Error("CREATOR_PLANNING_RESULT_INVALID")
  }
  const result = await dispatcher.dispatch(
    "prompt.section",
    {
      name: CREATOR_PLANNING_SECTION,
      text: "先核对需求与真实能力，优先复用已有实现，再组合或创建缺失功能。"
    },
    {
      signal: input.signal,
      timeoutMs: 3000,
      strict: true,
      strictPlugin: input.name,
      validateInput: (_event, value) => {
        input.assertCurrent()
        if (
          value.name !== CREATOR_PLANNING_SECTION ||
          typeof value.text !== "string" ||
          value.text.length > CREATOR_PLANNING_MAX_CHARS ||
          Object.keys(value).some((key) => key !== "name" && key !== "text")
        )
          throw Error("CREATOR_PLANNING_INPUT_INVALID")
      },
      validateResult: validate,
      core: async (_event, value): Promise<ModObject> => ({ text: value.text }),
      capability: async () => {
        denied = true
        throw Error("CREATOR_PLANNING_SDK_DENIED")
      }
    }
  )
  input.assertCurrent()
  input.signal.throwIfAborted()
  if (
    denied ||
    !result.trace.some((row) => row.plugin === input.name && row.outcome === "returned")
  )
    throw Error(denied ? "CREATOR_PLANNING_SDK_DENIED" : "CREATOR_PLANNING_HANDLER_MISSING")
  validate("prompt.section", result.value)
  return String((result.value as ModObject).text)
}
