import { matchesEventPattern, type FunctionRegistration } from "./contracts"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "./compatibility-catalog"
/** Static package inspection, deliberately distinct from runtime acceptance. */
export interface FunctionSdkCompatibilitySummary {
  digest: string
  strictCompatible: boolean
  runtimeVerified: false
  diagnostics: Array<{
    code: string
    message: string
    file: string
    line: number
    column: number
  }>
}

export interface FunctionCompatibilityDiagnostic {
  code:
    | "MODS_EVENT_SCHEMA_ONLY"
    | "MODS_EVENT_UNAVAILABLE"
    | "MODS_EVENT_PROVIDER_REQUIRED"
    | "MODS_EVENT_PARTIAL_OBSERVER"
    | "MODS_NO_EVENT_REGISTRATIONS"
  pattern: string
  events: string[]
  level: "warning" | "info"
  impact: string
}

export interface FunctionCompatibilityRegistration extends FunctionRegistration {
  events: string[]
  supportedEvents: string[]
  unavailableEvents: string[]
  unverifiedEvents: string[]
}

export interface FunctionCompatibilityReport {
  scope: "registration-events-only"
  status: "bounded" | "partial" | "unsupported" | "unverified"
  /** A check of event providers only, not SDK, types, permissions or full upstream parity. */
  strictCompatible: boolean
  registrations: FunctionCompatibilityRegistration[]
  diagnostics: FunctionCompatibilityDiagnostic[]
}

/** Describes production providers without rejecting optional wildcard observers. */
export function assessFunctionCompatibility(
  registrations: readonly FunctionRegistration[]
): FunctionCompatibilityReport {
  const diagnostics: FunctionCompatibilityDiagnostic[] = []
  let unsupported = false
  let unverified = false
  const assessed = registrations.map((registration): FunctionCompatibilityRegistration => {
    const { pattern } = registration
    const observer = pattern.startsWith("!") || pattern.includes("*")
    const events = FUNCTION_COMPATIBILITY_EVENT_NAMES.filter((event) =>
      event === "completion.check" ? pattern === event : matchesEventPattern(pattern, event)
    )
    const supportedEvents: string[] = []
    const unavailableEvents: string[] = []
    const unverifiedEvents: string[] = []
    for (const event of events) {
      const support = getFunctionEventSupport(event)
      if (support?.availability === "bounded") supportedEvents.push(event)
      else if (support) unavailableEvents.push(event)
      else unverifiedEvents.push(event)
    }
    if (!events.length || unverifiedEvents.length) {
      unverified = true
      diagnostics.push({
        code: "MODS_EVENT_PROVIDER_REQUIRED",
        pattern,
        events: unverifiedEvents,
        level: "warning",
        impact: "尚未验证此事件的生产提供者；可能需要其他插件，注册成功不代表会触发。"
      })
    }
    if (unavailableEvents.length) {
      const usableObserver = observer && supportedEvents.length > 0
      unsupported ||= !usableObserver
      if (observer) {
        diagnostics.push({
          code: "MODS_EVENT_PARTIAL_OBSERVER",
          pattern,
          events: unavailableEvents,
          level: "warning",
          impact: usableObserver
            ? "此观察器只能收到已接入的事件；列出的事件没有生产提供者，不会因注册而触发。"
            : "此观察器没有匹配到已接入的事件；不能依靠它执行实际业务。"
        })
      } else {
        const support = getFunctionEventSupport(pattern)
        diagnostics.push({
          code:
            support?.availability === "metadata"
              ? "MODS_EVENT_SCHEMA_ONLY"
              : "MODS_EVENT_UNAVAILABLE",
          pattern,
          events: unavailableEvents,
          level: "warning",
          impact: support?.note ?? "此事件尚无生产提供者，不能依靠它执行实际业务。"
        })
      }
    }
    return { ...registration, events, supportedEvents, unavailableEvents, unverifiedEvents }
  })
  if (!registrations.length) {
    unverified = true
    diagnostics.push({
      code: "MODS_NO_EVENT_REGISTRATIONS",
      pattern: "",
      events: [],
      level: "info",
      impact: "没有事件注册可供验证；包检查通过不代表具有可运行的事件能力。"
    })
  }
  return {
    scope: "registration-events-only",
    status: unsupported
      ? "unsupported"
      : unverified
        ? "unverified"
        : diagnostics.length
          ? "partial"
          : "bounded",
    strictCompatible: !unsupported && !unverified,
    registrations: assessed,
    diagnostics
  }
}
