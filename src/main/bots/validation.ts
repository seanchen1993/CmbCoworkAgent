import { BotDomainError } from "../../shared/bot-types"

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotDomainError("invalid_input", "请求必须是对象")
  }
  return value as Record<string, unknown>
}

export function text(value: unknown, label: string, max = 64_000, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new BotDomainError("invalid_input", `${label}格式不正确（最多 ${max} 字符）`)
  }
  return value
}

export function identifier(value: unknown): string {
  const result = text(value, "标识", 160)
  if (!/^[\w:.-]+$/.test(result)) throw new BotDomainError("invalid_input", "标识格式不正确")
  return result
}

export function integer(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BotDomainError("invalid_input", `${label}必须是 ${min}～${max} 的整数`)
  }
  return value
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new BotDomainError("invalid_input", `${label}必须为布尔值`)
  return value
}

export function optionalText(value: unknown, label: string, max: number): string | null {
  return value == null ? null : text(value, label, max)
}

export function optionalChoice<T extends string>(
  value: unknown,
  label: string,
  choices: readonly T[]
): T | null {
  if (value == null) return null
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new BotDomainError("invalid_input", `${label}不受支持`)
  return value as T
}

export function uniqueIds(value: unknown, min = 1, max = 6): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new BotDomainError("invalid_input", `需要 ${min}～${max} 个成员`)
  }
  const ids = value.map(identifier)
  if (new Set(ids).size !== ids.length) throw new BotDomainError("invalid_input", "成员不能重复")
  return ids
}

/** Canonical JSON is used for idempotency and action-bound approvals. No credentials belong here. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  throw new BotDomainError("invalid_input", "请求必须包含可序列化的 JSON 值")
}

export function connectorIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new BotDomainError("invalid_input", "连接器列表格式不正确（最多 64 个）")
  const keys = value.map((key) => text(key, "连接器标识", 512))
  if (new Set(keys).size !== keys.length)
    throw new BotDomainError("invalid_input", "连接器不能重复")
  return keys.sort()
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32)
}
