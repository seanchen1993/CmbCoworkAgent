import type { ModObject } from "../types"
import { encodeModJson, parseModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"

export const PLATFORM_WIDGETS = ["List", "Table", "Tree", "Chart", "Log", "Form"] as const
export type PlatformWidget = (typeof PLATFORM_WIDGETS)[number]
function fail(): never {
  throw new ModFunctionError("MODS_UI_WIDGET_INVALID")
}
const text = (value: unknown, max = 2000): value is string =>
  typeof value === "string" && value.length <= max
const fields = (value: unknown, allowed: string[]): value is ModObject =>
  isModObject(value) && Object.keys(value).every((key) => allowed.includes(key))
export function isPlatformWidget(value: string): value is PlatformWidget {
  return PLATFORM_WIDGETS.includes(value as PlatformWidget)
}
export function validatePlatformWidget(type: PlatformWidget, props: ModObject): void {
  if (encodeModJson(props).length > 131072) fail()
  if (type === "List") {
    if (
      !fields(props, ["label", "items"]) ||
      !Array.isArray(props.items) ||
      props.items.length > 200
    )
      fail()
    for (const row of props.items as unknown[])
      if (
        !fields(row, ["id", "label", "detail"]) ||
        !text(row.id, 160) ||
        !text(row.label) ||
        (row.detail !== undefined && !text(row.detail))
      )
        fail()
  } else if (type === "Table") {
    if (
      !fields(props, ["label", "columns", "rows"]) ||
      !Array.isArray(props.columns) ||
      !props.columns.length ||
      props.columns.length > 12 ||
      !Array.isArray(props.rows) ||
      props.rows.length > 200
    )
      fail()
    const keys = new Set<string>()
    for (const column of props.columns as unknown[]) {
      if (
        !fields(column, ["key", "label"]) ||
        !text(column.key, 80) ||
        !column.key ||
        !text(column.label, 160) ||
        keys.has(column.key)
      )
        fail()
      keys.add(column.key as string)
    }
    for (const row of props.rows as unknown[])
      if (
        !isModObject(row) ||
        Object.keys(row).some((key) => !keys.has(key)) ||
        Object.values(row).some(
          (value) =>
            value !== null &&
            typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value)) &&
            !text(value)
        )
      )
        fail()
  } else if (type === "Tree") {
    if (!fields(props, ["label", "items"])) fail()
    let count = 0
    const walk = (rows: unknown, depth: number) => {
      if (!Array.isArray(rows) || depth > 8 || rows.length > 200) fail()
      for (const row of rows as unknown[]) {
        if (
          ++count > 200 ||
          !fields(row, ["id", "label", "children"]) ||
          !text(row.id, 160) ||
          !text(row.label)
        )
          fail()
        if (row.children !== undefined) walk(row.children, depth + 1)
      }
    }
    walk(props.items, 0)
  } else if (type === "Chart") {
    if (
      !fields(props, ["label", "series"]) ||
      !Array.isArray(props.series) ||
      props.series.length > 100
    )
      fail()
    for (const point of props.series as unknown[])
      if (
        !fields(point, ["label", "value"]) ||
        !text(point.label, 160) ||
        typeof point.value !== "number" ||
        !Number.isFinite(point.value) ||
        Math.abs(point.value) > 1e12
      )
        fail()
  } else if (type === "Log") {
    if (
      !fields(props, ["label", "entries"]) ||
      !Array.isArray(props.entries) ||
      props.entries.length > 200
    )
      fail()
    for (const row of props.entries as unknown[])
      if (
        !fields(row, ["id", "text", "level"]) ||
        !text(row.id, 160) ||
        !text(row.text) ||
        (row.level !== undefined && !["info", "warning", "error"].includes(String(row.level)))
      )
        fail()
  } else {
    if (
      !fields(props, ["key", "label", "fields", "values", "submitLabel"]) ||
      !text(props.key, 256) ||
      !props.key ||
      !Array.isArray(props.fields) ||
      !props.fields.length ||
      props.fields.length > 20 ||
      !isModObject(props.values) ||
      (props.submitLabel !== undefined && !text(props.submitLabel, 160))
    )
      fail()
    const names = new Set<string>()
    for (const field of props.fields as unknown[]) {
      if (
        !fields(field, ["name", "label", "type", "required", "options"]) ||
        !text(field.name, 80) ||
        !/^[a-z][a-z0-9_-]*$/.test(String(field.name)) ||
        names.has(String(field.name)) ||
        !text(field.label, 160) ||
        !["text", "number", "select"].includes(String(field.type)) ||
        (field.required !== undefined && typeof field.required !== "boolean")
      )
        fail()
      names.add(field.name as string)
      if (
        field.type === "select" &&
        (!Array.isArray(field.options) ||
          !field.options.length ||
          field.options.length > 100 ||
          field.options.some((value) => !text(value, 160)))
      )
        fail()
    }
    platformFormValues(props, JSON.stringify(props.values), false)
  }
  if (props.label !== undefined && !text(props.label, 160)) fail()
}

/** Form submission stays on the existing string-valued, receipt-bound ui.input channel. */
export function platformFormValues(
  props: ModObject,
  textValue: string,
  requireFilled = true
): ModObject {
  if (textValue.length > 10000) fail()
  const value = parseModJson(textValue)
  if (!isModObject(value) || !Array.isArray(props.fields)) return fail()
  const fields = props.fields as ModObject[],
    names = new Set(fields.map((field) => String(field.name)))
  if (Object.keys(value).some((key) => !names.has(key))) fail()
  for (const field of fields) {
    const item = value[String(field.name)]
    if (item === undefined || item === "") {
      if (requireFilled && field.required) fail()
      continue
    }
    if (
      field.type === "number"
        ? typeof item !== "number" || !Number.isFinite(item)
        : !text(item, 2000) ||
          (field.type === "select" && !(field.options as string[]).includes(item))
    )
      fail()
  }
  return value
}
