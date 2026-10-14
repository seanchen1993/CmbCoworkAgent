import { clawActionObject } from "../../../shared/mods/claw-actions"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { validateRegisteredToolInput } from "./tool-schema"

/** Validate the approved declaration without filling defaults or coercing values. */
export function validateClawActionConfig(value: unknown, schema?: ModObject): ModObject {
  try {
    const config = clawActionObject(value)
    if (schema !== undefined) validateRegisteredToolInput(schema, config)
    return config
  } catch {
    // Avoid exposing configuration values, which may contain user-supplied secrets.
    throw new ModFunctionError("CLAW_ACTION_CONFIG_INVALID", "动作配置不符合声明，请检查配置字段")
  }
}
