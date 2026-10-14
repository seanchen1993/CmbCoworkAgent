import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

export function functionSettingsRequest(value: unknown): ModObject {
  if (!isModObject(value) || Object.keys(value).some((key) => key !== "source"))
    throw new ModFunctionError("MODS_SETTINGS_ARGUMENTS")
  if (value.source !== undefined) throw new ModFunctionError("MODS_SETTINGS_SOURCE_UNSUPPORTED")
  return {}
}

/** CMB's effective configuration, explicitly namespaced; never fabricate Claude's five sources. */
export async function readFunctionSettings(
  input: unknown,
  context: {
    snapshot(): Promise<ModObject>
    signal: AbortSignal
    assertLive(): void
    publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  }
): Promise<ModObject> {
  functionSettingsRequest(input)
  const check = () => {
    context.signal.throwIfAborted()
    context.assertLive()
  }
  const copy = (value: unknown): ModObject => {
    if (!isModObject(value) || !isModObject(value.cmbdevclaw) || Object.keys(value).length !== 1)
      throw new ModFunctionError("MODS_SETTINGS_RESULT")
    const encoded = encodeModJson(value)
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new ModFunctionError("MODS_SETTINGS_LIMIT")
    return parseModJson(encoded) as ModObject
  }
  check()
  const snapshot = await context.snapshot()
  check()
  const published = await context.publish(copy(snapshot), context.signal)
  check()
  return copy(published)
}
