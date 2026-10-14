import {
  clawActionObject,
  parseClawActionIdentity,
  parseClawOutputPointer,
  type ClawActionIdentity
} from "../mods/claw-actions"
import { encodeModJson } from "../mods/validation"
import type { ModObject } from "../mods/types"

export const PROJECT_ACTION_LOCK_PATH = "devclaw.project-actions.lock.json"
export const PROJECT_ACTION_LOCK_MAX_BYTES = 128 * 1024
export interface ProjectActionBinding {
  id: string
  ref: ClawActionIdentity
  command: string
  input: ModObject
  config: ModObject
  inputFrom?:
    | { kind: "artifact"; artifactId: string; pointer: string }
    | { kind: "action"; actionId: string; pointer: string }
  inputSchema: ModObject
  configSchema: ModObject | null
  outputSchema: ModObject | null
}
export interface ProjectActionLock {
  apiVersion: "devclaw.project-actions-lock/v1"
  bindings: ProjectActionBinding[]
}
function record(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("PROJECT_ACTION_LOCK_INVALID")
  const raw = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw Error("PROJECT_ACTION_LOCK_INVALID")
  return raw
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(value))
    throw Error("PROJECT_ACTION_ID_INVALID")
  return value
}
/** A lock is data, not a grant. The main process must match it against a live public catalogue. */
export function parseProjectActionLock(value: unknown): ProjectActionLock {
  if (new TextEncoder().encode(encodeModJson(value)).byteLength > PROJECT_ACTION_LOCK_MAX_BYTES)
    throw Error("PROJECT_ACTION_LOCK_LIMIT")
  const raw = record(value, ["apiVersion", "bindings"])
  if (
    raw.apiVersion !== "devclaw.project-actions-lock/v1" ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > 16
  )
    throw Error("PROJECT_ACTION_LOCK_INVALID")
  const bindings = raw.bindings.map((value) => {
    const item = record(
      value,
      ["id", "ref", "command", "input", "inputSchema", "outputSchema"],
      ["config", "configSchema", "inputFrom"]
    )
    record(item.ref, ["pluginId", "plugin", "digest", "actionId"])
    if (typeof item.command !== "string" || !/^[a-zA-Z0-9][\w:-]{0,99}$/.test(item.command))
      throw Error("PROJECT_ACTION_COMMAND_INVALID")
    let inputFrom: ProjectActionBinding["inputFrom"]
    if (item.inputFrom !== undefined) {
      const source = record(item.inputFrom, ["kind", "pointer"], ["artifactId", "actionId"])
      const pointer = parseClawOutputPointer(source.pointer)
      if (source.kind === "artifact" && source.actionId === undefined)
        inputFrom = { kind: "artifact", artifactId: id(source.artifactId), pointer }
      else if (source.kind === "action" && source.artifactId === undefined)
        inputFrom = { kind: "action", actionId: id(source.actionId), pointer }
      else throw Error("PROJECT_ACTION_SOURCE_INVALID")
    }
    const bindingId = id(item.id)
    if (bindingId.length > 64) throw Error("PROJECT_ACTION_ID_INVALID")
    return {
      id: bindingId,
      ref: parseClawActionIdentity(item.ref),
      command: item.command,
      input: clawActionObject(item.input),
      config: clawActionObject(item.config ?? {}),
      ...(inputFrom ? { inputFrom } : {}),
      inputSchema: clawActionObject(item.inputSchema),
      configSchema: item.configSchema == null ? null : clawActionObject(item.configSchema),
      outputSchema: item.outputSchema === null ? null : clawActionObject(item.outputSchema)
    }
  })
  if (new Set(bindings.map((item) => item.id)).size !== bindings.length)
    throw Error("PROJECT_ACTION_DUPLICATE")
  return { apiVersion: "devclaw.project-actions-lock/v1", bindings }
}
