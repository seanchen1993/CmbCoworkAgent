import type { ModObject, ModJson } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson } from "../../../shared/mods/validation"

// Names map to host-owned adapters. No plugin-provided executable or adapter is accepted.
const tools: Record<string, { target: string; required: string[]; optional: string[] }> = {
  read_file: { target: "host:read_file", required: ["file_path"], optional: ["offset", "limit"] },
  write_file: { target: "host:write_file", required: ["file_path", "content"], optional: [] },
  edit_file: {
    target: "host:edit_file",
    required: ["file_path", "old_string", "new_string"],
    optional: ["replace_all"]
  },
  ls: { target: "host:ls", required: ["path"], optional: [] },
  glob: { target: "host:glob", required: ["pattern"], optional: ["path"] },
  grep: { target: "host:grep", required: ["pattern"], optional: ["path", "glob"] },
  execute: { target: "host:execute", required: ["command"], optional: ["cwd"] },
  task_output: { target: "host:task_output", required: ["task_id"], optional: [] }
}

export function functionToolTarget(input: ModObject): { target: string; args: ModObject } {
  const spec =
    typeof input.tool === "string" && Object.hasOwn(tools, input.tool)
      ? tools[input.tool]
      : undefined
  if (!spec) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
  const args = { ...input }
  delete args.tool
  delete args.tool_use_id
  delete args.agentId
  if (
    encodeModJson(args).length > 16000 ||
    Object.keys(args).some((k) => !spec.required.includes(k) && !spec.optional.includes(k)) ||
    spec.required.some((k) => typeof args[k] !== "string")
  )
    throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
  for (const [key, value] of Object.entries(args)) {
    if (key === "offset" || key === "limit") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100000)
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
    } else if (key === "replace_all") {
      if (typeof value !== "boolean") throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
    } else if (typeof value !== "string") throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
  }
  return { target: spec.target, args }
}

export function validateFunctionToolResult(result: ModJson): void {
  if (!isModObject(result)) throw new ModFunctionError("MODS_TOOL_RESULT")
  if (typeof result.deny === "string" && !Object.hasOwn(result, "result")) return
  if (
    !Object.hasOwn(result, "result") ||
    result.deny !== undefined ||
    (result.text !== undefined && typeof result.text !== "string") ||
    (result.isError !== undefined && result.isError !== true) ||
    (result.ref !== undefined &&
      (typeof result.ref !== "number" || !Number.isSafeInteger(result.ref) || result.ref < 0)) ||
    (result.context !== undefined &&
      (!Array.isArray(result.context) ||
        result.context.some((v) => typeof v !== "string") ||
        result.context.join("\n").length > 32000))
  )
    throw new ModFunctionError("MODS_TOOL_RESULT")
}

/** Model tool schemas remain owned by their actual host adapters, including MCP tools. */
export function validateModelToolInput(input: ModObject): void {
  if (
    typeof input.tool !== "string" ||
    !input.tool ||
    input.tool.length > 256 ||
    typeof input.tool_use_id !== "string" ||
    !input.tool_use_id ||
    (input.agentId !== undefined && typeof input.agentId !== "string")
  )
    throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
  encodeModJson(input)
}
