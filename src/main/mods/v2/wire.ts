import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionWireError } from "../../../shared/mods/v2/protocol"

export function wireError(error: unknown): FunctionWireError {
  return {
    code: error instanceof ModFunctionError ? error.code : "MODS_HOST_ERROR",
    message: error instanceof Error ? error.message.slice(0, 2048) : "MODS_HOST_ERROR",
    downstream: error instanceof ModFunctionError && error.downstream
  }
}

export function fromWireError(error: FunctionWireError): ModFunctionError {
  return new ModFunctionError(error.code, error.message, error.downstream)
}
