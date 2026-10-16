import { parseClawCompletionRules, type ClawCompletionRule } from "./claw-completion"
import type { FunctionPluginStatus } from "./v2/commands"
import type { SavedFlow } from "./flows/types"
import { parseFlowDefinition } from "./flows/schema"
import { parseClawComponentSelection, type ClawComponentSelection } from "./claw-components"
export type { ClawComponentSelection } from "./claw-components"

export interface ClawCapability {
  pluginId: string
  name: string
  digest: string
  components?: ClawComponentSelection
}
export interface ClawSourceReference {
  id: string
  name: string
  digest: string
}
export interface ClawSourceSelection {
  mode: "all" | "selected"
  items: ClawSourceReference[]
}
export interface ClawSourceEntry extends ClawSourceReference {
  owner?: string
  description?: string
}
export interface ClawSourceCatalog {
  skills: ClawSourceEntry[]
  mcp: ClawSourceEntry[]
}
export interface ClawProfile {
  id: string
  name: string
  capabilities: ClawCapability[]
  /** Host-owned modules are opt-in in each saved/applied Claw snapshot. */
  builtins?: { contextMeter: boolean }
  skills?: ClawSourceSelection
  mcp?: ClawSourceSelection
  models?: { default?: string; roles: Record<string, string> }
  completionRules?: ClawCompletionRule[]
  /** Copy of the saved definition, not a live link to an editable flow template. */
  flow?: SavedFlow
}
export interface ClawState {
  revision: number
  profiles: ClawProfile[]
  /** Frozen selection; editing a saved profile does not silently apply it. */
  active: ClawProfile | null
}
export interface ClawView extends ClawState {
  /** Host-derived usage context; absent in older hosts. */
  usageContext?: import("./capability-usage").CapabilityUsageContext
  bindingRevision: number
  workspace: string
  enabled: boolean
  applicable: boolean
  capabilities: FunctionPluginStatus[]
  issues: string[]
}
export type ClawMutation =
  | { kind: "save"; profile: ClawProfile; revision: number; workspace: string }
  | {
      kind: "apply"
      id: string | null
      revision: number
      workspace: string
      bindingRevision?: number
    }
export interface ClawApi {
  clawView(threadId: string): Promise<ClawView>
  clawSources(threadId: string): Promise<ClawSourceCatalog>
  clawChange(threadId: string, mutation: ClawMutation): Promise<ClawView>
  clawStart(
    threadId: string,
    expectedRevision: number,
    goal: string
  ): Promise<import("./flows/types").FlowRun>
}

export function parseClawSourceSelection(input: unknown): ClawSourceSelection {
  const value = input as ClawSourceSelection | null
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["all", "selected"].includes(value.mode) ||
    !Array.isArray(value.items) ||
    value.items.length > 512
  )
    throw Error("Claw 来源选择无效，单类最多选择 512 个来源。")
  const seen = new Set<string>()
  const items = value.items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 1024 ||
      // eslint-disable-next-line no-control-regex -- Reject controls in untrusted source IDs.
      /[\u0000-\u001f]/.test(item.id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 256 ||
      typeof item.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.digest) ||
      seen.has(item.id)
    )
      throw Error("Claw 来源身份无效或重复。")
    seen.add(item.id)
    return { id: item.id, name: item.name, digest: item.digest }
  })
  return { mode: value.mode, items: value.mode === "all" ? [] : items }
}

export function clawSourceIssues(
  selection: ClawSourceSelection | undefined,
  available: ClawSourceEntry[],
  label: string
): string[] {
  if (selection?.mode !== "selected") return []
  return selection.items.flatMap((item) =>
    available.some(
      (entry) => entry.id === item.id && entry.digest === item.digest && entry.name === item.name
    )
      ? []
      : [`${label} ${item.name} 已更改、禁用或移除，请重新核对组合。`]
  )
}

export function parseClawProfile(input: unknown): ClawProfile {
  const value = input as ClawProfile | null
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 80 ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 8
  )
    throw Error("Claw 配置无效：名称最多 80 字，最多选择 8 个能力。")
  const seen = new Set<string>()
  const capabilities = value.capabilities.map((entry) => {
    if (
      !entry ||
      typeof entry.pluginId !== "string" ||
      !entry.pluginId ||
      entry.pluginId.length > 256 ||
      typeof entry.name !== "string" ||
      !entry.name ||
      entry.name.length > 256 ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      seen.has(entry.pluginId) ||
      seen.has(`name:${entry.name}`)
    )
      throw Error("Claw 能力身份无效或重复。")
    seen.add(entry.pluginId)
    seen.add(`name:${entry.name}`)
    return {
      pluginId: entry.pluginId,
      name: entry.name,
      digest: entry.digest,
      ...(entry.components === undefined
        ? {}
        : { components: parseClawComponentSelection(entry.components) })
    }
  })
  let builtins: ClawProfile["builtins"]
  if (value.builtins !== undefined) {
    if (
      !value.builtins ||
      typeof value.builtins !== "object" ||
      Array.isArray(value.builtins) ||
      typeof value.builtins.contextMeter !== "boolean" ||
      Object.keys(value.builtins).some((key) => key !== "contextMeter")
    )
      throw Error("Claw 内置模组配置无效。")
    builtins = { contextMeter: value.builtins.contextMeter }
  }
  let models: ClawProfile["models"]
  if (value.models !== undefined) {
    const refs = value.models
    if (
      !refs ||
      typeof refs !== "object" ||
      Array.isArray(refs) ||
      !refs.roles ||
      typeof refs.roles !== "object" ||
      Array.isArray(refs.roles) ||
      Object.keys(refs.roles).length > 24
    )
      throw Error("Claw 模型角色配置无效。")
    const modelRef = (ref: unknown): string => {
      if (typeof ref !== "string" || !ref.trim() || ref.length > 256)
        throw Error("Claw 模型引用无效。")
      return ref
    }
    const roles: Record<string, string> = {}
    for (const [role, ref] of Object.entries(refs.roles)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(role) ||
        ["constructor", "prototype", "__proto__"].includes(role)
      )
        throw Error("Claw 模型角色名称无效。")
      roles[role] = modelRef(ref)
    }
    models = { roles, ...(refs.default === undefined ? {} : { default: modelRef(refs.default) }) }
  }
  let flow: SavedFlow | undefined
  if (value.flow !== undefined) {
    const source = value.flow
    if (
      !source ||
      typeof source !== "object" ||
      !Number.isSafeInteger(source.revision) ||
      source.revision < 1 ||
      !Number.isSafeInteger(source.updatedAt) ||
      source.updatedAt < 0 ||
      typeof source.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.digest)
    )
      throw Error("Claw 流程版本无效。")
    flow = {
      definition: parseFlowDefinition(source.definition),
      revision: source.revision,
      digest: source.digest,
      updatedAt: source.updatedAt
    }
  }
  return {
    id: value.id,
    name: value.name.trim(),
    capabilities,
    ...(builtins ? { builtins } : {}),
    ...(value.skills === undefined ? {} : { skills: parseClawSourceSelection(value.skills) }),
    ...(value.mcp === undefined ? {} : { mcp: parseClawSourceSelection(value.mcp) }),
    ...(models ? { models } : {}),
    ...(value.completionRules === undefined
      ? {}
      : { completionRules: parseClawCompletionRules(value.completionRules, capabilities) }),
    ...(flow ? { flow } : {})
  }
}

export function clawIssues(
  profile: ClawProfile | null,
  available: FunctionPluginStatus[]
): string[] {
  if (!profile) return []
  return profile.capabilities.flatMap((item) =>
    available.some(
      (candidate) =>
        candidate.pluginId === item.pluginId &&
        candidate.name === item.name &&
        candidate.digest === item.digest &&
        candidate.state === "ready"
    )
      ? []
      : [`${item.name} 已更改、禁用或未授权，请重新核对并保存组合。`]
  )
}
