import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

export function functionToolCheckInput(value: ModJson, realCall = false): ModObject {
  if (
    !isModObject(value) ||
    typeof value.tool !== "string" ||
    !value.tool ||
    value.tool.length > 256 ||
    !Object.hasOwn(value, "input") ||
    Object.keys(value).some(
      (key) => !["tool", "input", ...(realCall ? ["tool_use_id"] : [])].includes(key)
    ) ||
    (value.tool_use_id !== undefined &&
      (typeof value.tool_use_id !== "string" || !value.tool_use_id))
  )
    throw new ModFunctionError("MODS_TOOL_CHECK_ARGUMENTS")
  return parseModJson(encodeModJson(value)) as ModObject
}

export function validateToolCheckResult(value: ModJson): asserts value is ToolPermissionResult {
  if (
    !isModObject(value) ||
    !["allow", "ask", "deny"].includes(String(value.decision)) ||
    Object.keys(value).some((key) => !["decision", "reason", "rule"].includes(key)) ||
    [value.reason, value.rule].some(
      (text) => text !== undefined && (typeof text !== "string" || text.length > 8000)
    )
  )
    throw new ModFunctionError("MODS_TOOL_CHECK_RESULT")
}
