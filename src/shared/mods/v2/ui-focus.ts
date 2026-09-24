import type { FunctionFocusTarget } from "./ui"
import { isModObject, ModFunctionError } from "./contracts"

export interface FunctionFocusAddress extends FunctionFocusTarget {
  pane: string
  generation: string
  /** Host-selected control identity, required only for independently redrawn Clients. */
  clientHandle?: number
}
export interface FunctionFocusRequest extends FunctionFocusAddress {
  id: string
  phase: "probe" | "apply"
}
export interface FunctionFocusAck extends FunctionFocusRequest {
  allowed: boolean
}
export interface FunctionFocusOutcome {
  deny?: string
}

export function functionFocusInput(value: unknown): { requestId: string; key: string } {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["requestId", "key"].includes(key)) ||
    ![value.requestId, value.key].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256
    )
  )
    throw new ModFunctionError("MODS_UI_FOCUS_ARGUMENTS")
  return value as { requestId: string; key: string }
}
