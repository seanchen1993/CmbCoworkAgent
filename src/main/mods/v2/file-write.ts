import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionToolTarget, validateFunctionToolResult } from "./tool-sdk"

export function validateFunctionFileWriteInput(input: ModObject): void {
  if (
    typeof input.path !== "string" ||
    !input.path ||
    typeof input.text !== "string" ||
    Object.keys(input).some((key) => key !== "path" && key !== "text")
  )
    throw new ModFunctionError("MODS_FS_WRITE_ARGUMENTS")
  // Keep the existing native parameter budget and validation before any hook runs.
  functionToolTarget({ tool: "write_file", file_path: input.path, content: input.text })
}

export function functionFileWriteInput(args: ModJson[]): ModObject {
  if (args.length !== 2) throw new ModFunctionError("MODS_FS_WRITE_ARGUMENTS")
  const input = { path: args[0], text: args[1] }
  validateFunctionFileWriteInput(input)
  return input
}

export function assertFunctionFileWriteResult(value: ModJson): void {
  validateFunctionToolResult(value)
  if (!isModObject(value)) throw new ModFunctionError("MODS_FS_WRITE_FAILED")
  if (typeof value.deny === "string")
    throw new ModFunctionError("MODS_OPERATION_DENIED", value.deny, true)
  if (value.isError === true)
    throw new ModFunctionError(
      "MODS_FS_WRITE_FAILED",
      typeof value.text === "string" ? value.text.slice(0, 2048) : "MODS_FS_WRITE_FAILED",
      true
    )
}
