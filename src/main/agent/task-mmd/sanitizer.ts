const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|session|credential|private[_-]?key)/i

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/(Authorization\s*:\s*)(Bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi, "$1$2[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)[^\s'",;]+/gi, "$1[REDACTED]"],
  [/(token\s*[:=]\s*)[^\s'",;]+/gi, "$1[REDACTED]"],
  [/(password\s*[:=]\s*)[^\s'",;]+/gi, "$1[REDACTED]"],
  [/(secret\s*[:=]\s*)[^\s'",;]+/gi, "$1[REDACTED]"],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1\n[REDACTED]\n$2"]
]

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function redactText(text: string): string {
  let next = text
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    next = next.replace(pattern, replacement)
  }
  next = next.replace(/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=).+$/gim, "$1[REDACTED]")
  return next
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value
  if (typeof value === "string") return redactText(value)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value !== "object") return String(value)

  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]"
    } else {
      output[key] = sanitizeValue(nested, seen)
    }
  }
  return output
}

export function sanitizePreview(value: unknown, maxChars: number): string {
  let text: string
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(sanitizeValue(value), null, 2)
    } catch {
      text = String(value)
    }
  }
  return truncate(redactText(text), maxChars)
}

export function sanitizePlainText(text: string, maxChars: number): string {
  return truncate(redactText(text), maxChars)
}
