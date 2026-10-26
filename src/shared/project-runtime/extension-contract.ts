/** Required semantics are negotiated at the existing project execution entry. No alternate runner. */
export const PROJECT_RUNTIME_V2_API_VERSION = "devclaw.project-runtime/v2" as const
/** Fixed negotiated board protocol; never accept an arbitrary current-version + 1. */
export const EXTENSION_BOARD_API_VERSION = 2 as const
export const EXTENSION_CONTRACT_API_VERSION = "devclaw.extension-contract/v1" as const
export const REQUIRED_BUSINESS_CHECKS_PROTOCOL = "devclaw.required-business-checks/v1" as const
export const CONTEXT_HANDOFF_PROTOCOL = "devclaw.context-handoff/v1" as const
export const DECLARED_CONTEXT_FILES_PROTOCOL = "devclaw.declared-context-files/v1" as const
export const CONTEXT_MATERIALS_PROTOCOL = "devclaw.context-materials/v1" as const
export const EXECUTION_RESOURCES_PROTOCOL = "devclaw.execution-resources/v1" as const
/** Explicit checked artifact selection, currently consumed by the reviewed legacy adapter. */
export const VERIFIED_ARTIFACTS_PROTOCOL = "devclaw.verified-artifacts/v1" as const
export const SUPPORTED_EXTENSION_PROTOCOLS: readonly string[] = [
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  CONTEXT_HANDOFF_PROTOCOL,
  DECLARED_CONTEXT_FILES_PROTOCOL,
  CONTEXT_MATERIALS_PROTOCOL,
  EXECUTION_RESOURCES_PROTOCOL,
  VERIFIED_ARTIFACTS_PROTOCOL
]

export interface ExtensionContextContract {
  sourceAccess: "read-only"
  mutableData: "host"
  configuration: "host-resolved"
  knowledge: { required: boolean; binding?: string }
  provider?:
    | { entry: string; actionId?: never; files?: never; materials?: never; operations: Array<"session-context" | "sync-knowledge"> }
    | { actionId: string; entry?: never; files?: never; materials?: ContextMaterials; operations: Array<"session-context"> }
    | { entry?: never; actionId?: never; files: DeclaredContextFile[]; materials?: never; operations: Array<"session-context"> }
}

export interface ContextMaterials {
  roots: Array<{ id: string; source: "package" | "knowledge"; path?: string }>
  configuration: string[]
}

export interface DeclaredContextFile {
  source: "package" | "knowledge"
  path: string
  stages?: string[]
}

export interface ExtensionContract {
  apiVersion: typeof EXTENSION_CONTRACT_API_VERSION
  requires: string[]
  context?: ExtensionContextContract
  verifiedArtifacts?: { artifactIds: string[] }
  executionResources?: ExecutionResourcesContract
}

export interface ExecutionResourcesContract {
  profiles: string[]
  workspaces: Array<{ id: string; binding: string }>
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
  const raw = object(value, ["apiVersion", "requires"], ["context", "verifiedArtifacts", "executionResources"])
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
      const provider = object(input.provider, ["operations"], ["entry", "actionId", "files", "materials"])
      let materials: ContextMaterials | undefined
      if (provider.materials !== undefined) {
        if (!raw.requires.includes(CONTEXT_MATERIALS_PROTOCOL) || !provider.actionId ||
          provider.entry !== undefined || provider.files !== undefined)
          return invalid("MATERIALS_PROTOCOL_REQUIRED")
        const selection = object(provider.materials, ["roots", "configuration"])
        if (!Array.isArray(selection.roots) || selection.roots.length > 8 ||
          !Array.isArray(selection.configuration) || selection.configuration.length > 16 ||
          (!selection.roots.length && !selection.configuration.length) ||
          new Set(selection.configuration).size !== selection.configuration.length ||
          selection.configuration.some(key => typeof key !== "string" || !/^[a-zA-Z][\w.-]{0,79}$/.test(key)))
          return invalid("MATERIALS_INVALID")
        const roots = selection.roots.map((value): ContextMaterials["roots"][number] => {
          const root = object(value, ["id", "source"], ["path"])
          if (typeof root.id !== "string" || !/^[a-zA-Z][\w.-]{0,63}$/.test(root.id) ||
            (root.source !== "package" && root.source !== "knowledge") ||
            (root.source === "knowledge" && !context!.knowledge.binding))
            return invalid("MATERIALS_INVALID")
          return { id: root.id, source: root.source,
            ...(root.path === undefined ? {} : { path: relativeEntry(root.path) }) }
        })
        if (new Set(roots.map(root => root.id)).size !== roots.length)
          return invalid("MATERIALS_INVALID")
        materials = { roots, configuration: [...selection.configuration] as string[] }
      }
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
      if (provider.files !== undefined) {
        if (!raw.requires.includes(DECLARED_CONTEXT_FILES_PROTOCOL) ||
          provider.entry !== undefined || provider.actionId !== undefined ||
          !Array.isArray(provider.files) || !provider.files.length || provider.files.length > 32 ||
          provider.operations.length !== 1 || provider.operations[0] !== "session-context")
          return invalid("DECLARED_FILES_INVALID")
        const files = provider.files.map((value): DeclaredContextFile => {
          const file = object(value, ["source", "path"], ["stages"])
          if (file.source !== "package" && file.source !== "knowledge") return invalid()
          if (file.source === "knowledge" && !context!.knowledge.binding)
            return invalid("KNOWLEDGE_BINDING_REQUIRED")
          if (file.stages !== undefined && (!Array.isArray(file.stages) || !file.stages.length ||
            file.stages.length > 32 || new Set(file.stages).size !== file.stages.length ||
            file.stages.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(id))))
            return invalid()
          return { source: file.source, path: relativeEntry(file.path),
            ...(file.stages === undefined ? {} : { stages: [...file.stages] as string[] }) }
        })
        if (new Set(files.map(file => `${file.source}:${file.path.toLowerCase()}`)).size !== files.length)
          return invalid("DECLARED_FILES_DUPLICATE")
        context.provider = { files, operations: ["session-context"] }
      } else if (provider.actionId !== undefined) {
        if (provider.entry !== undefined || typeof provider.actionId !== "string" ||
          !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(provider.actionId) ||
          provider.operations.length !== 1 || provider.operations[0] !== "session-context")
          return invalid()
        context.provider = { actionId: provider.actionId, operations: ["session-context"],
          ...(materials ? { materials } : {}) }
      } else context.provider = {
        entry: relativeEntry(provider.entry),
        operations: [...provider.operations] as Array<"session-context" | "sync-knowledge">
      }
    }
  } else if (raw.requires.includes(CONTEXT_HANDOFF_PROTOCOL)) return invalid("CONTEXT_REQUIRED")
  if (raw.requires.includes(DECLARED_CONTEXT_FILES_PROTOCOL) && !context?.provider?.files)
    return invalid("DECLARED_FILES_REQUIRED")
  if (raw.requires.includes(CONTEXT_MATERIALS_PROTOCOL) && !context?.provider?.materials)
    return invalid("MATERIALS_REQUIRED")
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
  let executionResources: ExecutionResourcesContract | undefined
  if (raw.executionResources !== undefined) {
    if (!raw.requires.includes(EXECUTION_RESOURCES_PROTOCOL))
      return invalid("EXECUTION_RESOURCES_PROTOCOL_REQUIRED")
    const declaration = object(raw.executionResources, ["profiles", "workspaces"])
    if (!Array.isArray(declaration.profiles) || declaration.profiles.length > 16 ||
      !Array.isArray(declaration.workspaces) || declaration.workspaces.length > 8 ||
      (!declaration.profiles.length && !declaration.workspaces.length))
      return invalid("EXECUTION_RESOURCES_INVALID")
    const profiles = declaration.profiles.map(value => {
      const path = relativeEntry(value)
      if (!path.endsWith(".md")) return invalid("EXECUTION_RESOURCE_PROFILE_INVALID")
      return path
    })
    const workspaces = declaration.workspaces.map(value => {
      const workspace = object(value, ["id", "binding"])
      if (typeof workspace.id !== "string" || !/^[a-zA-Z][\w.-]{0,63}$/.test(workspace.id) ||
        typeof workspace.binding !== "string" || !/^[a-zA-Z][\w.-]{0,79}$/.test(workspace.binding))
        return invalid("EXECUTION_RESOURCE_BINDING_INVALID")
      return { id: workspace.id, binding: workspace.binding }
    })
    if (new Set(profiles.map(path => path.toLowerCase())).size !== profiles.length ||
      new Set(workspaces.map(workspace => workspace.id)).size !== workspaces.length)
      return invalid("EXECUTION_RESOURCES_DUPLICATE")
    executionResources = { profiles, workspaces }
  } else if (raw.requires.includes(EXECUTION_RESOURCES_PROTOCOL))
    return invalid("EXECUTION_RESOURCES_REQUIRED")
  return {
    apiVersion: EXTENSION_CONTRACT_API_VERSION,
    requires: [...raw.requires],
    ...(context ? { context } : {}),
    ...(executionResources ? { executionResources } : {}),
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
