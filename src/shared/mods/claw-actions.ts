import type { ModObject } from "./types"
import { encodeModJson } from "./validation"
import { isModObject } from "./v2/contracts"

export interface ClawActionExport {
  id: string
  name: string
  description?: string
  command: string
  inputSchema: ModObject
  configSchema?: ModObject
  outputSchema?: ModObject
}

export interface ClawActionIdentity {
  pluginId: string
  plugin: string
  digest: string
  actionId: string
}

export interface ClawActionDescriptor extends ClawActionIdentity {
  name: string
  description?: string
  command: string
  inputSchema: ModObject
  configSchema?: ModObject
  outputSchema?: ModObject
}

export interface ClawActionEnvelope {
  version: 1
  input: ModObject
  config: ModObject
  task: string
  runId: string
  stepId: string
  executionId: string
}

export const CLAW_ACTION_MAX_BYTES = 28_000

export function clawActionObject(value: unknown): ModObject {
  if (
    !isModObject(value) ||
    new TextEncoder().encode(encodeModJson(value)).byteLength > CLAW_ACTION_MAX_BYTES
  )
    throw Error("CLAW_ACTION_OBJECT_INVALID")
  return structuredClone(value)
}

export function parseClawActionIdentity(value: unknown): ClawActionIdentity {
  const raw = clawActionObject(value)
  if (
    typeof raw.pluginId !== "string" ||
    !raw.pluginId ||
    raw.pluginId.length > 256 ||
    typeof raw.plugin !== "string" ||
    !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(raw.plugin) ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest) ||
    typeof raw.actionId !== "string" ||
    !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(raw.actionId)
  )
    throw Error("CLAW_ACTION_IDENTITY_INVALID")
  return { pluginId: raw.pluginId, plugin: raw.plugin, digest: raw.digest, actionId: raw.actionId }
}

/** Declarations describe callable commands; they never execute source during discovery. */
export function parseClawActionExports(value: unknown): ClawActionExport[] {
  if (value === undefined) return []
  const raw = clawActionObject(value)
  if (raw.actions === undefined && raw.componentsVersion === 1 && Array.isArray(raw.components))
    return []
  if (!Array.isArray(raw.actions) || raw.actions.length > 32)
    throw Error("CLAW_ACTION_EXPORTS_INVALID")
  const seen = new Set<string>()
  return raw.actions.map((entry) => {
    if (
      !isModObject(entry) ||
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(entry.id) ||
      seen.has(entry.id) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      entry.name.length > 128 ||
      typeof entry.command !== "string" ||
      !/^[a-zA-Z0-9][\w:-]{0,99}$/.test(entry.command) ||
      (entry.description !== undefined &&
        (typeof entry.description !== "string" || entry.description.length > 2000))
    )
      throw Error("CLAW_ACTION_EXPORT_INVALID")
    seen.add(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      command: entry.command,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputSchema: clawActionObject(entry.inputSchema),
      ...(entry.configSchema === undefined
        ? {}
        : { configSchema: clawActionObject(entry.configSchema) }),
      ...(entry.outputSchema === undefined
        ? {}
        : { outputSchema: clawActionObject(entry.outputSchema) })
    }
  })
}

export function parseClawOutputPointer(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || (value !== "" && !value.startsWith("/")))
    throw Error("CLAW_ACTION_POINTER_INVALID")
  if (value.split("/").length > 17) throw Error("CLAW_ACTION_POINTER_INVALID")
  for (const part of value.split("/").slice(1)) {
    if (/~(?![01])/u.test(part)) throw Error("CLAW_ACTION_POINTER_INVALID")
    if (
      ["__proto__", "prototype", "constructor"].includes(
        part.replace(/~1/g, "/").replace(/~0/g, "~")
      )
    )
      throw Error("CLAW_ACTION_POINTER_INVALID")
  }
  return value
}

export function resolveClawActionInput(
  constants: ModObject,
  output: ModObject,
  pointer = ""
): ModObject {
  parseClawOutputPointer(pointer)
  let value: unknown = output
  for (const part of pointer.split("/").slice(1)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !Object.hasOwn(value, key))
        throw Error("CLAW_ACTION_OUTPUT_MISSING")
      value = value[Number(key)]
      continue
    }
    if (!isModObject(value) || !Object.hasOwn(value, key)) throw Error("CLAW_ACTION_OUTPUT_MISSING")
    value = value[key]
  }
  return clawActionObject({ ...clawActionObject(value), ...clawActionObject(constants) })
}
