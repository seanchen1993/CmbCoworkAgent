import type { FunctionSession } from "./session"
import type { FunctionSessionActivity } from "./session-activity"

const asynchronous = new Set<keyof FunctionSession>([
  "start",
  "end",
  "commands",
  "turnStart",
  "checkCompletion",
  "measure",
  "turnComplete",
  "turnStep",
  "run",
  "interceptTool",
  "runAction",
  "offerAgent",
  "presentationEvent",
  "promptComposition",
  "startupPromptComposition",
  "promptSubmission",
  "promptMention",
  "promptEditing",
  "classicEvent",
  "registeredTools",
  "checkTool",
  "feedbackSnapshot",
  "logSnapshot",
  "receivePeer",
  "withConfigurationGuard",
  "nativeMarkdownCallback",
  "appendConversation"
])

/** Preserve sync metadata and async/stream returns while tracking public host work. */
export function trackFunctionSession(
  session: FunctionSession,
  activity: FunctionSessionActivity
): FunctionSession {
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(session, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "close" || property === "assertRetirementHealthy" || property === "assertRetirementComplete") return value.bind(target)
      if (!methods.has(property))
        methods.set(property, (...args: unknown[]) =>
          asynchronous.has(property as keyof FunctionSession)
            ? activity.run(() => value.apply(target, args))
            : activity.sync(() => value.apply(target, args))
        )
      return methods.get(property)
    }
  })
}
