import type { ClawProfile } from "../../../shared/mods/claw"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { FlowDefinition, SavedFlow } from "../../../shared/mods/flows/types"
import type { ModObject } from "../../../shared/mods/types"
import { objectOutputPaths, parameterFields, type ParameterDraft } from "./flow-parameter-form"

const object = (value: unknown): value is ModObject =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Only suggestions proven from bounded structural declarations; runtime still validates values. */
export function simpleSchemaCompatible(output: ModObject, input: ModObject, depth = 0): boolean {
  if (depth > 8 || output.type !== input.type || !output.type) return false
  const annotations = new Set(["title", "description", "default", "examples", "$schema"])
  const known = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "minLength",
    "maxLength",
    "minimum",
    "maximum", "items", "minItems", "maxItems", "uniqueItems"
  ])
  if (
    [...Object.keys(output), ...Object.keys(input)].some(
      (key) => !annotations.has(key) && !known.has(key)
    )
  )
    return false
  const acceptedEnum = input.enum
  if (
    Array.isArray(acceptedEnum) &&
    (!Array.isArray(output.enum) || !output.enum.every((value) => acceptedEnum.includes(value)))
  )
    return false
  for (const key of ["minLength", "minimum", "minItems"])
    if (
      typeof input[key] === "number" &&
      (typeof output[key] !== "number" || output[key] < input[key])
    )
      return false
  for (const key of ["maxLength", "maximum", "maxItems"])
    if (
      typeof input[key] === "number" &&
      (typeof output[key] !== "number" || output[key] > input[key])
    )
      return false
  if (input.type === "array") {
    if (input.enum !== undefined || output.enum !== undefined ||
      (input.uniqueItems === true && output.uniqueItems !== true)) return false
    return object(input.items) && object(output.items) &&
      simpleSchemaCompatible(output.items, input.items, depth + 1)
  }
  if (input.type !== "object")
    return ["string", "number", "integer", "boolean"].includes(String(input.type))
  if (!object(output.properties) || !object(input.properties)) return false
  const produced = output.properties
  const accepted = input.properties
  const required = Array.isArray(input.required) ? input.required : []
  if (
    required.some(
      (key) =>
        typeof key !== "string" ||
        !Array.isArray(output.required) ||
        !output.required.includes(key) ||
        !produced[key]
    )
  )
    return false
  if (
    input.additionalProperties === false &&
    (output.additionalProperties !== false || Object.keys(produced).some((key) => !accepted[key]))
  )
    return false
  return Object.entries(accepted).every(
    ([key, schema]) =>
      (!produced[key] && output.additionalProperties === false) ||
      (object(schema) &&
        object(produced[key]) &&
        simpleSchemaCompatible(produced[key], schema, depth + 1))
  )
}

export function simpleConnections(output?: ModObject, input?: ModObject) {
  if (!output || !input) return []
  return [{ path: "", label: "完整输出" }, ...objectOutputPaths(output)].filter(({ path }) => {
    let node: unknown = output
    for (const segment of path.split("/").slice(1)) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~")
      if (
        !object(node) ||
        !Array.isArray(node.required) ||
        !node.required.includes(key) ||
        !object(node.properties)
      )
        return false
      node = node.properties[key]
    }
    return object(node) && simpleSchemaCompatible(node, input)
  })
}

export function simpleFormSupported(schema?: ModObject): boolean {
  if (!schema) return true
  if (
    schema.type !== "object" ||
    ["$ref", "allOf", "anyOf", "oneOf", "not"].some((key) => schema[key] !== undefined)
  )
    return false
  const properties = object(schema.properties) ? schema.properties : {}
  return parameterFields(schema).length === Object.keys(properties).length
}

export interface SimpleSequenceStep {
  id: string
  action: string
  digest?: string
  plugin?: string
  input: ModObject
  config: ModObject
  inputFrom?: { stepId: string; path: string }
}

/** One editing document. A definition here is never a SavedFlow execution receipt. */
export interface SimpleClawDraft {
  profile: ClawProfile
  mode: "together" | "sequence"
  flowId: string
  steps: SimpleSequenceStep[]
  baseDefinition?: FlowDefinition
  /** Last actual host receipt, retained even while the profile temporarily uses no flow. */
  savedFlow?: SavedFlow
  parameterDrafts: Record<string, ParameterDraft>
  componentDrafts: Record<string, Record<string, ParameterDraft>>
  flowText?: string
  flowTextError?: string
  checkpoint?: SimpleSaveCheckpoint
}

export function markSimpleDraftSaved(
  draft: SimpleClawDraft,
  profile: ClawProfile
): SimpleClawDraft {
  const clean = (values: Record<string, ParameterDraft>) =>
    Object.fromEntries(
      Object.entries(values).map(([id, value]) => [id, { ...value, dirty: false }])
    )
  return {
    ...draft,
    profile,
    parameterDrafts: clean(draft.parameterDrafts),
    componentDrafts: Object.fromEntries(
      Object.entries(draft.componentDrafts).map(([id, values]) => [id, clean(values)])
    )
  }
}

export const simpleActionKey = (action: ClawActionDescriptor): string =>
  `${action.pluginId}:${action.actionId}`

export function simpleFlowSupported(definition?: FlowDefinition): boolean {
  if (!definition) return true
  return (
    definition.schemaVersion === 2 &&
    definition.execution?.kind === "host" &&
    !definition.execution.profile &&
    definition.steps.length > 0 && definition.steps.length <= 32 &&
    definition.steps.every(
      (step) =>
        step.kind === "plugin-action" &&
        step.enabled &&
        !step.when &&
        !step.onSuccess &&
        !step.onFailure &&
        !step.evidenceInput
    )
  )
}

export function simpleProfileSupported(profile: ClawProfile): boolean {
  return simpleFlowSupported(profile.flow?.definition)
}

export function createSimpleClawDraft(profile: ClawProfile, flowId: string): SimpleClawDraft {
  const definition = profile.flow?.definition
  return {
    profile: structuredClone(profile),
    mode: definition ? "sequence" : "together",
    flowId: definition?.id ?? flowId,
    ...(definition ? { baseDefinition: structuredClone(definition), savedFlow: profile.flow } : {}),
    steps: definition?.steps.map((step) => ({
      id: step.id,
      action: step.kind === "plugin-action" ? `${step.pluginId}:${step.actionId}` : "",
      ...(step.kind === "plugin-action" ? { digest: step.digest, plugin: step.plugin } : {}),
      input: step.kind === "plugin-action" ? structuredClone(step.input) : {},
      config: step.kind === "plugin-action" ? structuredClone(step.config ?? {}) : {},
      ...(step.kind === "plugin-action" && step.inputFrom
        ? { inputFrom: { stepId: step.inputFrom.stepId, path: step.inputFrom.path ?? "" } }
        : {})
    })) ?? [{ id: "step-1", action: "", input: {}, config: {} }],
    parameterDrafts: {},
    componentDrafts: {}
  }
}

/** Profile-only changes retain the same pending steps and incomplete form text. */
export function updateSimpleClawProfile(
  draft: SimpleClawDraft,
  profile: ClawProfile
): SimpleClawDraft {
  return profile.id !== draft.profile.id ||
    JSON.stringify(profile.flow) !== JSON.stringify(draft.profile.flow)
    ? createSimpleClawDraft(profile, draft.flowId)
    : { ...draft, profile }
}

export function removeSimpleStep(draft: SimpleClawDraft, id: string): SimpleClawDraft {
  return {
    ...draft,
    steps: draft.steps
      .filter((step) => step.id !== id)
      .map((step) => (step.inputFrom?.stepId === id ? { ...step, inputFrom: undefined } : step)),
    parameterDrafts: Object.fromEntries(
      Object.entries(draft.parameterDrafts).filter(([key]) => !key.startsWith(`${id}:`))
    )
  }
}

export function buildSimpleFlow(args: {
  id: string
  name: string
  actions: ClawActionDescriptor[]
  inputs: ModObject[]
  configs: ModObject[]
  connection?: string
  bindings?: ({ stepId: string; path: string } | undefined)[]
  stepIds?: string[]
  base?: FlowDefinition
}): FlowDefinition {
  if (!args.actions.length || args.actions.length > 32) throw Error("请配置 1 至 32 个执行步骤。")
  const ids = args.stepIds ?? args.actions.map((_, index) => `step-${index + 1}`)
  if (ids.length !== args.actions.length || new Set(ids).size !== ids.length)
    throw Error("步骤标识不完整或重复，请重新核对。")
  const bindings =
    args.bindings ??
    args.actions.map((_, index) =>
      index === 1 && args.connection !== undefined
        ? { stepId: ids[0], path: args.connection }
        : undefined
    )
  bindings.forEach((binding, index) => {
    if (!binding) return
    const previous = ids.indexOf(binding.stepId)
    if (
      previous < 0 ||
      previous >= index ||
      !simpleConnections(args.actions[previous].outputSchema, args.actions[index].inputSchema).some(
        (entry) => entry.path === binding.path
      )
    )
      throw Error(`步骤 ${index + 1} 只能连接兼容的前置步骤结果，请重新选择。`)
  })
  if (args.base && !simpleFlowSupported(args.base))
    throw Error("当前执行步骤包含高级设置，请在高级编辑中修改，原始定义已保留。")
  const base = args.base?.schemaVersion === 2 ? args.base : undefined
  return {
    ...(base ?? {}),
    schemaVersion: 2,
    execution: { kind: "host" },
    id: args.id,
    name: args.name,
    goal: args.base?.goal ?? "按所选步骤完成本次任务",
    timeoutMs: args.base?.timeoutMs ?? 600000,
    maxExecutions: Math.max(args.base?.maxExecutions ?? 0, args.actions.length),
    steps: args.actions.map((action, index) => ({
      ...args.base?.steps.find((step) => step.id === ids[index]),
      id: ids[index],
      name: args.base?.steps.find((step) => step.id === ids[index])?.name ?? action.name,
      enabled: true,
      kind: "plugin-action" as const,
      pluginId: action.pluginId,
      plugin: action.plugin,
      digest: action.digest,
      actionId: action.actionId,
      input: args.inputs[index],
      config: Object.keys(args.configs[index] ?? {}).length ? args.configs[index] : undefined,
      inputFrom: bindings[index]
    }))
  }
}

export function simpleDraftDefinition(
  draft: SimpleClawDraft,
  actions: ClawActionDescriptor[],
  forUpgrade = false
): FlowDefinition | undefined {
  if (draft.mode === "together") return undefined
  if (draft.flowTextError) throw Error(draft.flowTextError)
  if (draft.flowText !== undefined) return draft.baseDefinition
  if (!simpleFlowSupported(draft.baseDefinition)) return draft.baseDefinition
  const chosen = draft.steps.map((step) => {
    const action = actions.find(
      (entry) =>
        simpleActionKey(entry) === step.action &&
        (forUpgrade ||
          ((!step.digest || entry.digest === step.digest) &&
            (!step.plugin || entry.plugin === step.plugin)))
    )
    // A version proposal keeps the original identity until the pure upgrade planner replaces it.
    return action && forUpgrade
      ? { ...action, digest: step.digest ?? action.digest, plugin: step.plugin ?? action.plugin }
      : action
  })
  if (chosen.some((action) => !action)) throw Error("请选择每一步的操作。")
  return buildSimpleFlow({
    id: draft.flowId,
    name: draft.profile.name,
    actions: chosen as ClawActionDescriptor[],
    inputs: draft.steps.map((step) => step.input),
    configs: draft.steps.map((step) => step.config),
    bindings: draft.steps.map((step) => step.inputFrom),
    stepIds: draft.steps.map((step) => step.id),
    base: draft.baseDefinition
  })
}

/** Advanced edits replace only the definition draft; the old host receipt remains unchanged. */
export function editSimpleFlowText(draft: SimpleClawDraft, text: string): SimpleClawDraft {
  try {
    if (new TextEncoder().encode(text).length > 256000)
      throw Error("执行步骤草稿超过 256 KB，请精简后再保存。")
    const value = JSON.parse(text)
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Array.isArray(value.steps) ||
      ![1, 2].includes(value.schemaVersion) ||
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.name !== "string"
    )
      throw Error("请填写完整的执行步骤定义；保存时仍由原流程校验器检查。")
    if (
      !value.steps.every(
        (step: unknown) =>
          object(step) &&
          typeof step.id === "string" &&
          typeof step.name === "string" &&
          typeof step.kind === "string" &&
          typeof step.enabled === "boolean" &&
          (step.kind !== "plugin-action" ||
            (object(step.input) &&
              (step.config === undefined || object(step.config)) &&
              typeof step.pluginId === "string" &&
              typeof step.plugin === "string" &&
              typeof step.digest === "string" &&
              typeof step.actionId === "string"))
      )
    )
      throw Error("步骤结构尚未完成，已保留原定义。请修正后再保存。")
    // No receipt is minted here. The native flowSave validates every field before publishing.
    const definition = value as FlowDefinition
    const next = createSimpleClawDraft({ ...draft.profile, flow: undefined }, definition.id)
    next.baseDefinition = definition
    next.mode = "sequence"
    next.steps = definition.steps.map((step) => ({
      id: step.id,
      action: step.kind === "plugin-action" ? `${step.pluginId}:${step.actionId}` : "",
      ...(step.kind === "plugin-action" ? { digest: step.digest, plugin: step.plugin } : {}),
      input: step.kind === "plugin-action" ? step.input : {},
      config: step.kind === "plugin-action" ? (step.config ?? {}) : {},
      ...(step.kind === "plugin-action" && step.inputFrom
        ? { inputFrom: { stepId: step.inputFrom.stepId, path: step.inputFrom.path ?? "" } }
        : {})
    }))
    return {
      ...next,
      profile: draft.profile,
      savedFlow: draft.savedFlow,
      componentDrafts: draft.componentDrafts,
      checkpoint: draft.checkpoint,
      flowText: text
    }
  } catch (cause) {
    return {
      ...draft,
      flowText: text,
      flowTextError: cause instanceof Error ? cause.message : String(cause)
    }
  }
}

export interface SimpleSaveCheckpoint {
  fingerprint: string
  flow?: SavedFlow
  profileSaved?: boolean
}

/** Checkpoints survive a failed later phase. Reusing an id never silently creates another object. */
export async function saveSimpleCombination(args: {
  profile: ClawProfile
  definition?: FlowDefinition
  checkpoint?: SimpleSaveCheckpoint
  assertCurrent(): void
  onCheckpoint(value: SimpleSaveCheckpoint): void
  saveFlow(value: FlowDefinition): Promise<SavedFlow>
  saveProfile(value: ClawProfile): Promise<void>
}): Promise<ClawProfile> {
  const fingerprint = JSON.stringify([args.profile, args.definition])
  let checkpoint = args.checkpoint?.fingerprint === fingerprint ? args.checkpoint : { fingerprint }
  args.assertCurrent()
  if (args.definition && !checkpoint.flow) {
    const flow = await args.saveFlow(args.definition)
    checkpoint = { ...checkpoint, flow }
    args.onCheckpoint(checkpoint)
    args.assertCurrent()
  }
  const profile = checkpoint.flow ? { ...args.profile, flow: checkpoint.flow } : args.profile
  if (!checkpoint.profileSaved) {
    await args.saveProfile(profile)
    checkpoint = { ...checkpoint, profileSaved: true }
    args.onCheckpoint(checkpoint)
    args.assertCurrent()
  }
  return profile
}
