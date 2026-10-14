import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"

export type FunctionUserConfigPathKind = "file" | "directory"

/** Native control only: selecting a path neither saves it nor grants file access. */
export async function pickFunctionUserConfigPath(
  expected: { workspace: string; pluginId: string; digest: string; revision: number; key: string },
  host: {
    read(): Promise<FunctionUserConfigView>
    assertLive(): void
    choose(kind: FunctionUserConfigPathKind): Promise<string | undefined>
    publish(value: ModJson): Promise<ModJson>
  }
): Promise<string | undefined> {
  const check = async (kind?: FunctionUserConfigPathKind) => {
    host.assertLive()
    const view = await host.read()
    host.assertLive()
    if (
      view.workspace !== expected.workspace ||
      view.pluginId !== expected.pluginId ||
      view.digest !== expected.digest ||
      view.savedRevision !== expected.revision
    )
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const field = view.fields.find((item) => item.key === expected.key)
    if (
      !field?.supported ||
      field.sensitive ||
      field.multiple ||
      (field.type !== "file" && field.type !== "directory") ||
      (kind && field.type !== kind)
    )
      throw new ModFunctionError("MODS_CONFIG_PATH_FIELD")
    return field.type
  }
  const kind = await check()
  host.assertLive()
  const selected = await host.choose(kind)
  await check(kind)
  host.assertLive()
  if (selected === undefined) return undefined
  if (typeof selected !== "string" || !selected || selected.length > 32768)
    throw new ModFunctionError("MODS_CONFIG_PATH_RESULT")
  const safe = await host.publish({ value: selected })
  await check(kind)
  host.assertLive()
  if (
    !isModObject(safe) ||
    typeof safe.value !== "string" ||
    !safe.value ||
    safe.value.length > 32768
  )
    throw new ModFunctionError("MODS_CONFIG_PATH_RESULT")
  return safe.value
}
