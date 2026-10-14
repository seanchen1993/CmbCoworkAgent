import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"

export type FunctionUserConfigDraft = string | boolean | string[]
type Field = FunctionUserConfigView["fields"][number]

/** A scalar legacy list is displayed as one item without changing the actual stored value. */
export function functionUserConfigDraft(field: Field): FunctionUserConfigDraft {
  if (field.sensitive) return field.multiple ? [] : ""
  if (field.multiple) {
    if (Array.isArray(field.value)) return [...field.value]
    return typeof field.value === "string" && field.value !== "" ? [field.value] : []
  }
  return typeof field.value === "boolean" ? field.value : String(field.value ?? "")
}

export function equalFunctionUserConfigDraft(
  a: FunctionUserConfigDraft | undefined,
  b: FunctionUserConfigDraft | undefined
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
