import {
  clawActionObject,
  parseClawActionBinding,
  parseClawActionIdentity,
  parseClawOutputPointer,
  type ClawActionBinding,
  type ClawActionIdentity
} from "../mods/claw-actions"
import { encodeModJson } from "../mods/validation"
import type { ModObject } from "../mods/types"
import {
  PROJECT_ARTIFACT_REFERENCE_FORMAT,
  PROJECT_ARTIFACT_REFERENCE_MAX_BYTES
} from "./artifact-reference"

export const PROJECT_ACTION_LOCK_PATH = "devclaw.project-actions.lock.json"
export const PROJECT_ACTION_LOCK_MAX_BYTES = 128 * 1024
export type ProjectActionBinding = ClawActionBinding & {
  id: string
  ref: ClawActionIdentity
  input: ModObject
  config: ModObject
  inputFrom?:
    | { kind: "artifact"; artifactId: string; pointer: string; format?: "json" | "text" }
    | {
        kind: "artifact"
        artifactId: string
        pointer: ""
        format: typeof PROJECT_ARTIFACT_REFERENCE_FORMAT
        maxBytes: number
      }
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
/** Validate only the target so independent input/config size budgets remain unchanged. */
export function projectActionTarget(value: { command?: unknown; platform?: unknown }): ClawActionBinding {
  return parseClawActionBinding({
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.platform === undefined ? {} : { platform: value.platform })
  })
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
      ["id", "ref", "input", "inputSchema", "outputSchema"],
      ["command", "platform", "config", "configSchema", "inputFrom"]
    )
    record(item.ref, ["pluginId", "plugin", "digest", "actionId"])
    const target = projectActionTarget({ command: item.command, platform: item.platform })
    let inputFrom: ProjectActionBinding["inputFrom"]
    if (item.inputFrom !== undefined) {
      const source = record(item.inputFrom, ["kind", "pointer"], ["artifactId", "actionId", "format", "maxBytes"])
      const pointer = parseClawOutputPointer(source.pointer)
      if (source.kind === "artifact" && source.actionId === undefined) {
        if (source.format === PROJECT_ARTIFACT_REFERENCE_FORMAT) {
          if (
            pointer !== "" ||
            !target.platform ||
            !Number.isSafeInteger(source.maxBytes) ||
            (source.maxBytes as number) < 1 ||
            (source.maxBytes as number) > PROJECT_ARTIFACT_REFERENCE_MAX_BYTES
          )
            throw Error("PROJECT_ACTION_SOURCE_INVALID")
          inputFrom = {
            kind: "artifact",
            artifactId: id(source.artifactId),
            pointer: "",
            format: PROJECT_ARTIFACT_REFERENCE_FORMAT,
            maxBytes: source.maxBytes as number
          }
        } else {
          if (
            source.maxBytes !== undefined ||
            (source.format !== undefined && source.format !== "json" && source.format !== "text")
          )
            throw Error("PROJECT_ACTION_SOURCE_INVALID")
          if (source.format === "text" && pointer !== "")
            throw Error("PROJECT_ACTION_SOURCE_INVALID")
          inputFrom = { kind: "artifact", artifactId: id(source.artifactId), pointer,
            ...(source.format ? { format: source.format as "json" | "text" } : {}) }
        }
      } else if (source.kind === "action" && source.artifactId === undefined && source.format === undefined && source.maxBytes === undefined)
        inputFrom = { kind: "action", actionId: id(source.actionId), pointer }
      else throw Error("PROJECT_ACTION_SOURCE_INVALID")
    }
    const bindingId = id(item.id)
    if (bindingId.length > 64) throw Error("PROJECT_ACTION_ID_INVALID")
    return {
      id: bindingId,
      ref: parseClawActionIdentity(item.ref),
      ...target,
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
