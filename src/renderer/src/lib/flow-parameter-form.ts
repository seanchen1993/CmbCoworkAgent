import type { ModObject, ModJson } from "../../../shared/mods/types"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { FlowStep, FlowMcpToolDescriptor } from "../../../shared/mods/flows/types"

export interface ParameterDraft {
  mode?: "form" | "json"
  json?: string
  numbers?: Record<string, string>
  numberErrors?: Record<string, string>
  dirty?: boolean
}

export interface ParameterField {
  key: string
  title: string
  description?: string
  type: "string" | "number" | "integer" | "boolean"
  required: boolean
  enum?: (string | number | boolean)[]
  schema: ModObject
}

const object = (value: unknown): value is ModObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function parseParameterObject(text: string): ModObject | undefined {
  try {
    if (new TextEncoder().encode(text).length > 28_000) return undefined
    const value: unknown = JSON.parse(text)
    let nodes = 0
    const valid = (item: unknown, depth = 0): boolean => {
      if (++nodes > 10000 || depth > 32) return false
      if (typeof item === "number") return Number.isFinite(item)
      if (item === null || typeof item !== "object") return true
      return Object.values(item).every((child) => valid(child, depth + 1))
    }
    return object(value) && valid(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function parameterFields(schema?: ModObject): ParameterField[] {
  if (
    !schema ||
    schema.type !== "object" ||
    ["$ref", "allOf", "anyOf", "oneOf", "not"].some((key) => schema[key] !== undefined) ||
    !object(schema.properties)
  )
    return []
  const required = Array.isArray(schema.required) ? schema.required : []
  return Object.entries(schema.properties).flatMap(([key, child]) => {
    if (
      !object(child) ||
      !["string", "number", "integer", "boolean"].includes(String(child.type)) ||
      ["$ref", "allOf", "anyOf", "oneOf", "not", "const"].some((name) => child[name] !== undefined)
    )
      return []
    const type = child.type as ParameterField["type"]
    const values = child.enum
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        !values.length ||
        values.some((value) =>
          type === "integer"
            ? typeof value !== "number" || !Number.isSafeInteger(value)
            : typeof value !== type
        ))
    )
      return []
    return [
      {
        key,
        title: typeof child.title === "string" ? child.title : key,
        ...(typeof child.description === "string" ? { description: child.description } : {}),
        type,
        required: required.includes(key),
        schema: child,
        ...(Array.isArray(values) ? { enum: values as (string | number | boolean)[] } : {})
      }
    ]
  })
}

export function parameterNumber(text: string, integer: boolean): number | undefined {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) ? value : undefined
}

export function parameterError(
  value: ModObject,
  schema: ModObject | undefined,
  draft: ParameterDraft | undefined,
  allowMissing: boolean | string[] = false,
  validateSchema = true
): string | undefined {
  if (draft?.json !== undefined && !parseParameterObject(draft.json))
    return "请输入有效的 JSON 对象（最多 28 KB），修正前不能保存或运行。"
  const unfinishedNumber = Object.values(draft?.numberErrors ?? {})[0]
  if (unfinishedNumber) return unfinishedNumber
  const fields = parameterFields(schema)
  for (const [key, raw] of Object.entries(draft?.numbers ?? {})) {
    const field = fields.find((item) => item.key === key)
    if (parameterNumber(raw, field?.type === "integer") === undefined)
      return `${field?.title ?? key}：请输入完整的${field?.type === "integer" ? "安全整数" : "有限数字"}。`
  }
  // Disabled steps do not execute, but their unparsed drafts must still never be discarded.
  if (!validateSchema) return undefined
  for (const field of fields) {
    if (!Object.hasOwn(value, field.key)) {
      if (
        field.required &&
        !(
          allowMissing === true ||
          (Array.isArray(allowMissing) && allowMissing.includes(field.key))
        )
      )
        return `${field.title}：此参数必填。`
      continue
    }
    const actual = value[field.key]
    if (
      field.type === "integer"
        ? typeof actual !== "number" || !Number.isSafeInteger(actual)
        : typeof actual !== field.type
    )
      return `${field.title}：原值类型与声明不符，请修改或在 JSON 中修正。`
    if (field.enum && !field.enum.some((item) => item === actual))
      return `${field.title}：请选择声明中的值。`
    if (typeof actual === "string") {
      const length = Array.from(actual).length
      if (typeof field.schema.minLength === "number" && length < field.schema.minLength)
        return `${field.title}：至少 ${field.schema.minLength} 个字符。`
      if (typeof field.schema.maxLength === "number" && length > field.schema.maxLength)
        return `${field.title}：最多 ${field.schema.maxLength} 个字符。`
    }
    if (typeof actual === "number") {
      if (!Number.isFinite(actual)) return `${field.title}：请输入有限数字。`
      for (const [key, failed] of [
        ["minimum", actual < Number(field.schema.minimum)],
        ["maximum", actual > Number(field.schema.maximum)],
        ["exclusiveMinimum", actual <= Number(field.schema.exclusiveMinimum)],
        ["exclusiveMaximum", actual >= Number(field.schema.exclusiveMaximum)]
      ] as const)
        if (typeof field.schema[key] === "number" && failed)
          return `${field.title}：数值不符合 ${key} ${field.schema[key]}。`
    }
  }
  // Unsupported constraints stay host-owned; never delete unrecognised values to make a form valid.
  return undefined
}

export function actionForStep(
  step: FlowStep,
  actions?: ClawActionDescriptor[]
): ClawActionDescriptor | undefined {
  return step.kind === "plugin-action"
    ? actions?.find(
        (action) =>
          action.pluginId === step.pluginId &&
          action.plugin === step.plugin &&
          action.actionId === step.actionId &&
          action.digest === step.digest
      )
    : undefined
}

export function toolForStep(
  step: FlowStep,
  tools?: FlowMcpToolDescriptor[]
): FlowMcpToolDescriptor | undefined {
  return step.kind === "mcp-tool"
    ? tools?.find(
        (tool) =>
          !tool.unavailableReason &&
          tool.provider.id === step.provider.id &&
          tool.provider.name === step.provider.name &&
          tool.provider.digest === step.provider.digest &&
          tool.toolName === step.toolName &&
          tool.schemaDigest === step.schemaDigest
      )
    : undefined
}

export function objectOutputPaths(schema?: ModObject): { path: string; label: string }[] {
  const paths: { path: string; label: string }[] = []
  const visit = (node: ModJson | undefined, path: string, depth: number) => {
    if (
      !object(node) ||
      node.type !== "object" ||
      depth > 8 ||
      paths.length >= 64 ||
      ["$ref", "allOf", "anyOf", "oneOf", "not"].some((key) => node[key] !== undefined)
    )
      return
    if (path)
      paths.push({ path, label: typeof node.title === "string" ? `${node.title} · ${path}` : path })
    if (object(node.properties))
      for (const [key, child] of Object.entries(node.properties)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) continue
        visit(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1)
      }
  }
  visit(schema, "", 0)
  return paths
}
