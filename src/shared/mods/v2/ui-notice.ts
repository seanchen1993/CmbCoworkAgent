import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"

export function validateFunctionNotice(input: ModObject): void {
  if (
    Object.keys(input).some((key) => !["tool_use_id", "text"].includes(key)) ||
    typeof input.tool_use_id !== "string" ||
    !input.tool_use_id ||
    input.tool_use_id.length > 256 ||
    (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 10000))
  )
    throw new ModFunctionError("MODS_UI_NOTICE_ARGUMENTS")
}
