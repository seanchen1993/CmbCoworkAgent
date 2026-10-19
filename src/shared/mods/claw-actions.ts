import type { ModObject } from "./types"
import { encodeModJson } from "./validation"
import { isModObject } from "./v2/contracts"

export interface ClawActionPlatformBinding {
  id: string
  version: string
  action: string
}

export type ClawActionBinding =
  | { command: string; platform?: never }
  | { command?: never; platform: ClawActionPlatformBinding }

interface ClawActionDetails {
  name: string
  description?: string
  inputSchema: ModObject
  configSchema?: ModObject
  outputSchema?: ModObject
}

export type ClawActionExport = ClawActionDetails & { id: string } & ClawActionBinding

export interface ClawActionIdentity {
  pluginId: string
  plugin: string
  digest: string
  actionId: string
}

export type ClawActionDescriptor = ClawActionDetails & ClawActionIdentity & ClawActionBinding

export interface ClawActionEnvelope {
  version: 1
  input: ModObject
  config: ModObject
  task: string
  runId: string
  stepId: string
  executionId: string
}

/** Exported platform actions acknowledge completed work, never just background submission. */
export interface ClawPlatformActionResult {
  status: "succeeded" | "failed" | "cancelled"
  text?: string
  output?: ModObject
}

export function parseClawPlatformActionResult(value: unknown): ClawPlatformActionResult {
  const raw = clawActionObject(value)
  if (raw.status === "running" || raw.status === "unknown") throw Error("CLAW_ACTION_NOT_TERMINAL")
  if (
    !["succeeded", "failed", "cancelled"].includes(String(raw.status)) ||
    Object.keys(raw).some((key) => !["status", "text", "output"].includes(key)) ||
    (raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > 8000))
  )
    throw Error("CLAW_ACTION_PLATFORM_RESULT_INVALID")
  return {
    status: raw.status as ClawPlatformActionResult["status"],
    ...(raw.text === undefined ? {} : { text: raw.text as string }),
    ...(raw.output === undefined ? {} : { output: clawActionObject(raw.output) })
  }
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

/** A platform binding always refers to this exported package, never a renderer-selected peer. */
export function parseClawActionPlatform(value: unknown): ClawActionPlatformBinding {
  const raw = clawActionObject(value)
  if (
    Object.keys(raw).some((key) => !["id", "version", "action"].includes(key)) ||
    typeof raw.id !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(raw.id) ||
    typeof raw.action !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(raw.action) ||
    typeof raw.version !== "string" ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(raw.version)
  )
    throw Error("CLAW_ACTION_PLATFORM_INVALID")
  return { id: raw.id, version: raw.version, action: raw.action }
}

export function parseClawActionBinding(value: unknown): ClawActionBinding {
  const raw = clawActionObject(value)
  if ((raw.command !== undefined) === (raw.platform !== undefined))
    throw Error("CLAW_ACTION_BINDING_INVALID")
  if (raw.platform !== undefined) return { platform: parseClawActionPlatform(raw.platform) }
  if (typeof raw.command !== "string" || !/^[a-zA-Z0-9][\w:-]{0,99}$/.test(raw.command))
    throw Error("CLAW_ACTION_BINDING_INVALID")
  return { command: raw.command }
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
      (entry.description !== undefined &&
        (typeof entry.description !== "string" || entry.description.length > 2000))
    )
      throw Error("CLAW_ACTION_EXPORT_INVALID")
    seen.add(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      ...parseClawActionBinding(entry),
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
