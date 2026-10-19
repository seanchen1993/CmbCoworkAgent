/** Required semantics are negotiated at the existing project execution entry. No alternate runner. */
export const PROJECT_RUNTIME_V2_API_VERSION = "devclaw.project-runtime/v2" as const
/** Fixed negotiated board protocol; never accept an arbitrary current-version + 1. */
export const EXTENSION_BOARD_API_VERSION = 2 as const
export const EXTENSION_CONTRACT_API_VERSION = "devclaw.extension-contract/v1" as const
export const REQUIRED_BUSINESS_CHECKS_PROTOCOL = "devclaw.required-business-checks/v1" as const
export const CONTEXT_HANDOFF_PROTOCOL = "devclaw.context-handoff/v1" as const
/** Explicit checked artifact selection, currently consumed by the reviewed legacy adapter. */
export const VERIFIED_ARTIFACTS_PROTOCOL = "devclaw.verified-artifacts/v1" as const
export const SUPPORTED_EXTENSION_PROTOCOLS: readonly string[] = [
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  CONTEXT_HANDOFF_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL
]

export interface ExtensionContextContract {
  sourceAccess: "read-only"
  mutableData: "host"
  configuration: "host-resolved"
  knowledge: { required: boolean; binding?: string }
  provider?:
    | { entry: string; actionId?: never; operations: Array<"session-context" | "sync-knowledge"> }
    | { actionId: string; entry?: never; operations: Array<"session-context"> }
}

export interface ExtensionContract {
  apiVersion: typeof EXTENSION_CONTRACT_API_VERSION
  requires: string[]
  context?: ExtensionContextContract
  verifiedArtifacts?: { artifactIds: string[] }
}

function invalid(detail = "INVALID"): never {
  throw Error(`EXTENSION_CONTRACT_${detail}`)
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid()
  const item = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(item, key)) ||
    Object.keys(item).some((key) => ![...required, ...optional].includes(key))
  )
    return invalid()
  return item
}
function relativeEntry(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    // eslint-disable-next-line no-control-regex -- Contracts cannot hide absolute or traversal paths.
    /[\\:%<>"|?*\u0000-\u001f\u007f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.trim() !== part ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    return invalid()
  return value
}

export function parseExtensionContract(
  value: unknown,
  supportedProtocols: readonly string[] = SUPPORTED_EXTENSION_PROTOCOLS
): ExtensionContract {
  const raw = object(value, ["apiVersion", "requires"], ["context", "verifiedArtifacts"])
  if (
    raw.apiVersion !== EXTENSION_CONTRACT_API_VERSION ||
    !Array.isArray(raw.requires) ||
    !raw.requires.length ||
    raw.requires.length > 16 ||
    new Set(raw.requires).size !== raw.requires.length ||
    !Array.from(raw.requires).every(
      (id) =>
        typeof id === "string" && id.length <= 128 && /^[a-z][a-z0-9.-]*\/[a-z0-9.-]+$/.test(id)
    )
  )
    return invalid()
  if (raw.requires.some((id) => !supportedProtocols.includes(id)))
    return invalid("PROTOCOL_UNSUPPORTED")
  let context: ExtensionContextContract | undefined
  if (raw.context !== undefined) {
    if (!raw.requires.includes(CONTEXT_HANDOFF_PROTOCOL))
      return invalid("CONTEXT_PROTOCOL_REQUIRED")
    const input = object(
      raw.context,
      ["sourceAccess", "mutableData", "configuration", "knowledge"],
      ["provider"]
    )
    if (
      input.sourceAccess !== "read-only" ||
      input.mutableData !== "host" ||
      input.configuration !== "host-resolved"
    )
      return invalid()
    const knowledge = object(input.knowledge, ["required"], ["binding"])
    if (
      typeof knowledge.required !== "boolean" ||
      (knowledge.binding !== undefined &&
        (typeof knowledge.binding !== "string" ||
          !/^[a-zA-Z][\w.-]{0,79}$/.test(knowledge.binding)))
    )
      return invalid()
    context = {
      sourceAccess: "read-only",
      mutableData: "host",
      configuration: "host-resolved",
      knowledge: {
        required: knowledge.required,
        ...(knowledge.binding === undefined ? {} : { binding: knowledge.binding as string })
      }
    }
    if (input.provider !== undefined) {
      const provider = object(input.provider, ["operations"], ["entry", "actionId"])
      if (
        !Array.isArray(provider.operations) ||
        !provider.operations.length ||
        provider.operations.length > 2 ||
        new Set(provider.operations).size !== provider.operations.length ||
        !Array.from(provider.operations).every(
          (op) => op === "session-context" || op === "sync-knowledge"
        )
      )
        return invalid()
      if (provider.actionId !== undefined) {
        if (provider.entry !== undefined || typeof provider.actionId !== "string" ||
          !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(provider.actionId) ||
          provider.operations.length !== 1 || provider.operations[0] !== "session-context")
          return invalid()
        context.provider = { actionId: provider.actionId, operations: ["session-context"] }
      } else context.provider = {
        entry: relativeEntry(provider.entry),
        operations: [...provider.operations] as Array<"session-context" | "sync-knowledge">
      }
    }
  } else if (raw.requires.includes(CONTEXT_HANDOFF_PROTOCOL)) return invalid("CONTEXT_REQUIRED")
  let verifiedArtifacts: ExtensionContract["verifiedArtifacts"]
  if (raw.verifiedArtifacts !== undefined) {
    if (!raw.requires.includes(VERIFIED_ARTIFACTS_PROTOCOL))
      return invalid("VERIFIED_ARTIFACTS_PROTOCOL_REQUIRED")
    const selection = object(raw.verifiedArtifacts, ["artifactIds"])
    if (!Array.isArray(selection.artifactIds) || !selection.artifactIds.length ||
      selection.artifactIds.length > 64 ||
      new Set(selection.artifactIds).size !== selection.artifactIds.length ||
      !Array.from(selection.artifactIds).every(id => typeof id === "string" &&
        /^[a-zA-Z0-9][\w.-]{0,79}$/.test(id))) return invalid("VERIFIED_ARTIFACTS_INVALID")
    verifiedArtifacts = { artifactIds: [...selection.artifactIds] }
  } else if (raw.requires.includes(VERIFIED_ARTIFACTS_PROTOCOL))
    return invalid("VERIFIED_ARTIFACTS_REQUIRED")
  return {
    apiVersion: EXTENSION_CONTRACT_API_VERSION,
    requires: [...raw.requires],
    ...(context ? { context } : {}),
    ...(verifiedArtifacts ? { verifiedArtifacts } : {})
  }
}

/** Extract only a negotiated v2 contract. A loose sidecar never upgrades v1 behavior. */
export function projectRuntimeExtensionContract(value: unknown): ExtensionContract | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).apiVersion !== PROJECT_RUNTIME_V2_API_VERSION
  )
    return undefined
  const raw = object(value, ["apiVersion", "runtime", "extensionContract"])
  if (
    !raw.runtime ||
    typeof raw.runtime !== "object" ||
    Array.isArray(raw.runtime) ||
    (raw.runtime as Record<string, unknown>).apiVersion !== "devclaw.project-runtime/v1"
  )
    return invalid()
  return parseExtensionContract(raw.extensionContract)
}
