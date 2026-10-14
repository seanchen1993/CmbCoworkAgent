import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

function ownData(value: ModObject, key: string, code: string): ModJson | undefined {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field) return undefined
  if (!("value" in field)) throw new ModFunctionError(code)
  return field.value
}

export function functionToolCheckInput(value: ModJson, realCall = false): ModObject {
  value = parseModJson(encodeModJson(value)) as ModJson
  if (!isModObject(value)) throw new ModFunctionError("MODS_TOOL_CHECK_ARGUMENTS")
  const code = "MODS_TOOL_CHECK_ARGUMENTS"
  const tool = ownData(value, "tool", code)
  const id = ownData(value, "tool_use_id", code)
  const agentId = ownData(value, "agentId", code)
  const ceiling = ownData(value, "ceiling", code)
  if (
    typeof tool !== "string" ||
    !tool ||
    tool.length > 256 ||
    !Object.hasOwn(value, "input") ||
    Object.keys(value).some(
      (key) => !["tool", "input", "tool_use_id", "agentId", "ceiling"].includes(key)
    ) ||
    (realCall && id !== undefined && (typeof id !== "string" || !id)) ||
    (realCall && agentId !== undefined && (typeof agentId !== "string" || !agentId)) ||
    (realCall && ceiling !== undefined &&
      ceiling !== "allow" && ceiling !== "ask" && ceiling !== "deny")
  )
    throw new ModFunctionError("MODS_TOOL_CHECK_ARGUMENTS")
  if (!realCall) {
    delete value.tool_use_id
    delete value.agentId
    delete value.ceiling
  }
  return value
}

export function validateToolCheckResult(value: ModJson): asserts value is ToolPermissionResult {
  if (!isModObject(value)) throw new ModFunctionError("MODS_TOOL_CHECK_RESULT")
  const code = "MODS_TOOL_CHECK_RESULT"
  const decision = ownData(value, "decision", code)
  const reason = ownData(value, "reason", code)
  const rule = ownData(value, "rule", code)
  const hook = ownData(value, "hook", code)
  const ceiling = ownData(value, "ceiling", code)
  if (
    (decision !== "allow" && decision !== "ask" && decision !== "deny") ||
    Object.keys(value).some((key) => !["decision", "reason", "rule", "hook", "ceiling"].includes(key)) ||
    [reason, rule, hook].some(
      (text) => text !== undefined && (typeof text !== "string" || text.length > 8000)
    ) ||
    (ceiling !== undefined && ceiling !== "allow" && ceiling !== "ask" && ceiling !== "deny")
  )
    throw new ModFunctionError("MODS_TOOL_CHECK_RESULT")
}

/** Bind result metadata to one original question before any hook or host callback. */
export function createToolCheckResultParser(question: ModObject):
  (value: ModJson) => ToolPermissionResult {
  const original = functionToolCheckInput(question, true)
  const ceiling = ownData(original, "ceiling", "MODS_TOOL_CHECK_ARGUMENTS")
  return value => {
    const result = parseModJson(encodeModJson(value)) as ModJson
    if (!isModObject(result)) throw new ModFunctionError("MODS_TOOL_CHECK_RESULT")
    // 290 discards even a malformed hook ceiling before validating the verdict.
    delete result.ceiling
    if (ceiling !== undefined) Object.defineProperty(result, "ceiling", {
      value: ceiling, writable: true, enumerable: true, configurable: true
    })
    validateToolCheckResult(result)
    return result
  }
}
