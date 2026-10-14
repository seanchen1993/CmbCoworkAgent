import type { ClawProfile } from "../../../shared/mods/claw"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { FlowDefinition, SavedFlow } from "../../../shared/mods/flows/types"
import type { ModObject } from "../../../shared/mods/types"
import { objectOutputPaths, parameterFields } from "./flow-parameter-form"

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
    "maximum"
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
  for (const key of ["minLength", "minimum"])
    if (
      typeof input[key] === "number" &&
      (typeof output[key] !== "number" || output[key] < input[key])
    )
      return false
  for (const key of ["maxLength", "maximum"])
    if (
      typeof input[key] === "number" &&
      (typeof output[key] !== "number" || output[key] > input[key])
    )
      return false
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

export function simpleProfileSupported(profile: ClawProfile): boolean {
  // Existing flows can carry routing, deadlines and bindings beyond this two-card projection.
  // Keep them intact in the retained editor, instead of silently reserializing those fields.
  return profile.capabilities.length <= 2 && !profile.flow
}

export function buildSimpleFlow(args: {
  id: string
  name: string
  actions: [ClawActionDescriptor, ClawActionDescriptor]
  inputs: [ModObject, ModObject]
  configs: [ModObject, ModObject]
  connection: string
}): FlowDefinition {
  const [first, second] = args.actions
  if (
    !simpleConnections(first.outputSchema, second.inputSchema).some(
      (entry) => entry.path === args.connection
    )
  )
    throw Error("这两个动作的输入输出不能直接连接，请选择兼容动作或使用高级编辑。")
  return {
    schemaVersion: 2,
    execution: { kind: "host" },
    id: args.id,
    name: args.name,
    goal: "读取真实输入并完成独立检视",
    timeoutMs: 600000,
    maxExecutions: 2,
    steps: args.actions.map((action, index) => ({
      id: `step-${index + 1}`,
      name: action.name,
      enabled: true,
      kind: "plugin-action" as const,
      pluginId: action.pluginId,
      plugin: action.plugin,
      digest: action.digest,
      actionId: action.actionId,
      input: args.inputs[index],
      ...(Object.keys(args.configs[index]).length ? { config: args.configs[index] } : {}),
      ...(index === 1 ? { inputFrom: { stepId: "step-1", path: args.connection } } : {})
    }))
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
