const REDACTED = "[REDACTED]"

type SensitiveFieldKind = "secret" | "id-card" | "phone" | "email" | "bank-card"

const SECRET_FIELD_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "token",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "credential",
  "signature"
]

const SECRET_FIELDS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "session",
  "sessionid",
  "signature",
  "sig",
  "clientsecret",
  "authorizationcode",
  "oauthcode",
  "ystcode",
  "密码",
  "口令",
  "令牌",
  "密钥"
])

const ID_CARD_FIELDS = new Set([
  "idcard",
  "idcardno",
  "idcardnumber",
  "identitycard",
  "identityno",
  "identitynumber",
  "idno",
  "idnumber",
  "certno",
  "certnumber",
  "certificateno",
  "certificatenumber",
  "身份证",
  "身份证号",
  "证件号",
  "证件号码"
])

const PHONE_FIELDS = new Set([
  "phone",
  "phonenumber",
  "telephone",
  "tel",
  "mobile",
  "mobilephone",
  "cellphone",
  "手机号",
  "手机号码",
  "联系电话",
  "电话号码"
])

const EMAIL_FIELDS = new Set(["email", "emailaddress", "mail", "邮箱", "电子邮箱"])

const BANK_CARD_FIELDS = new Set([
  "bankcard",
  "bankcardno",
  "bankcardnumber",
  "bankaccount",
  "bankaccountno",
  "cardno",
  "cardnumber",
  "银行卡",
  "银行卡号",
  "银行账号"
])

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/?#\s:@]+:[^/?#\s@]+@/gi
const AUTHORIZATION_ASSIGNMENT_PATTERN =
  /((?:"|')?(?:authorization|proxy[-_ ]?authorization)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)/gi
const COOKIE_ASSIGNMENT_PATTERN =
  /((?:"|')?(?:cookie|set[-_ ]?cookie)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)/gi
const SECRET_ASSIGNMENT_PATTERN =
  /((?:"|')?(?:密码|口令|令牌|密钥|session[-_ ]?id|session|authorization[-_]?code|oauth[-_]?code|yst[-_]?code|sig|[a-z0-9_.-]*(?:api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|token|password|passwd|pwd|secret|signature|credential))(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\r\n,;}&\]]+)/gi
const BEARER_OR_BASIC_PATTERN = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{4,}/gi
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PREFIXED_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g
const CHINESE_ID_18_PATTERN = /(^|[^\d])([1-9]\d{16}[\dXx])(?=$|[^\d])/g
const CHINESE_ID_15_PATTERN = /(^|[^\d])([1-9]\d{14})(?=$|[^\d])/g
const CHINA_MOBILE_PATTERN = /(^|[^\d])((?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8})(?=$|[^\d])/g
const EMAIL_PATTERN = /\b([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi
const BANK_CARD_CANDIDATE_PATTERN = /(^|[^\d])((?:\d[ -]?){15,18}\d)(?=$|[^\d])/g

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "")
}

function classifyField(fieldName: string | undefined): SensitiveFieldKind | undefined {
  if (!fieldName) return undefined
  const normalized = normalizeFieldName(fieldName)
  if (
    SECRET_FIELDS.has(normalized) ||
    SECRET_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    normalized.includes("password") ||
    normalized.startsWith("authorization") ||
    normalized.endsWith("cookie")
  ) {
    return "secret"
  }
  if (ID_CARD_FIELDS.has(normalized)) return "id-card"
  if (
    PHONE_FIELDS.has(normalized) ||
    normalized.endsWith("phone") ||
    normalized.endsWith("mobile")
  ) {
    return "phone"
  }
  if (EMAIL_FIELDS.has(normalized) || normalized.endsWith("email")) return "email"
  if (BANK_CARD_FIELDS.has(normalized)) return "bank-card"
  return undefined
}

function preserveValueQuotes(value: string): string {
  const unquoted =
    value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")
      ? value.slice(1, -1)
      : value
  if (/^\[redacted\]$/i.test(unquoted)) return value
  const quote = value[0]
  return quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED
}

function maskKeepingEdges(value: string, visibleStart: number, visibleEnd: number): string {
  if (value.length < visibleStart + visibleEnd + 4) return REDACTED
  return `${value.slice(0, visibleStart)}${"*".repeat(value.length - visibleStart - visibleEnd)}${value.slice(-visibleEnd)}`
}

function maskPhone(value: string): string {
  const countryPrefix = value.match(/^\+?86[\s-]?/)?.[0] ?? ""
  const local = value.slice(countryPrefix.length)
  let digitIndex = 0
  const masked = local.replace(/\d/g, (digit) => {
    digitIndex += 1
    return digitIndex >= 4 && digitIndex <= 7 ? "*" : digit
  })
  return `${countryPrefix}${masked}`
}

function maskEmail(local: string, domain: string): string {
  const visible = local.slice(0, 1)
  return `${visible}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`
}

function passesLuhn(value: string): boolean {
  let sum = 0
  let doubleDigit = false
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }
  return sum % 10 === 0
}

function maskBankCard(value: string): string {
  const digitCount = (value.match(/\d/g) ?? []).length
  let digitIndex = 0
  return value.replace(/\d/g, (digit) => {
    digitIndex += 1
    return digitIndex > 6 && digitIndex <= digitCount - 4 ? "*" : digit
  })
}

function redactKnownField(value: unknown, kind: SensitiveFieldKind): unknown {
  if (value === null || value === undefined || typeof value === "boolean") return value
  if (kind === "secret") return REDACTED
  if (typeof value === "object" || typeof value === "function") return REDACTED

  const text = String(value)
  if (kind === "id-card") return maskKeepingEdges(text, 6, 4)
  if (kind === "phone") {
    const redacted = redactMobilePhones(text)
    return redacted === text ? maskKeepingEdges(text, 3, 4) : redacted
  }
  if (kind === "email") {
    const redacted = redactEmails(text)
    return redacted === text ? maskKeepingEdges(text, 1, 3) : redacted
  }
  const redacted = redactBankCards(text)
  return redacted === text ? maskKeepingEdges(text, 6, 4) : redacted
}

function redactChineseIdCards(text: string): string {
  return text
    .replace(CHINESE_ID_18_PATTERN, (_match, prefix: string, idCard: string) => {
      return `${prefix}${maskKeepingEdges(idCard, 6, 4)}`
    })
    .replace(CHINESE_ID_15_PATTERN, (_match, prefix: string, idCard: string) => {
      return `${prefix}${maskKeepingEdges(idCard, 6, 4)}`
    })
}

function redactMobilePhones(text: string): string {
  return text.replace(CHINA_MOBILE_PATTERN, (_match, prefix: string, phone: string) => {
    return `${prefix}${maskPhone(phone)}`
  })
}

function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, (_match, local: string, domain: string) => {
    return maskEmail(local, domain)
  })
}

function redactBankCards(text: string): string {
  return text.replace(BANK_CARD_CANDIDATE_PATTERN, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/g, "")
    return passesLuhn(digits) ? `${prefix}${maskBankCard(candidate)}` : match
  })
}

/**
 * Redact credentials and common Chinese PII from already-formatted log text.
 * Partial masks keep records correlatable without retaining the complete value.
 */
export function redactSensitiveText(text: string): string {
  return redactBankCards(
    redactEmails(
      redactMobilePhones(
        redactChineseIdCards(
          text
            .replace(
              PRIVATE_KEY_PATTERN,
              "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----"
            )
            .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
            .replace(
              AUTHORIZATION_ASSIGNMENT_PATTERN,
              (_match, prefix: string, value: string) => `${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              COOKIE_ASSIGNMENT_PATTERN,
              (_match, prefix: string, value: string) => `${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              SECRET_ASSIGNMENT_PATTERN,
              (_match, prefix: string, value: string) => `${prefix}${preserveValueQuotes(value)}`
            )
            .replace(BEARER_OR_BASIC_PATTERN, "$1[REDACTED]")
            .replace(JWT_PATTERN, REDACTED)
            .replace(PREFIXED_TOKEN_PATTERN, REDACTED)
        )
      )
    )
  )
}

function redactValue(
  value: unknown,
  fieldName: string | undefined,
  seen: WeakMap<object, unknown>
): unknown {
  const fieldKind = classifyField(fieldName)
  if (fieldKind) return redactKnownField(value, fieldKind)

  if (typeof value === "string") return redactSensitiveText(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value
    const text = String(value)
    const redacted = redactSensitiveText(text)
    return redacted === text ? value : redacted
  }
  if (typeof value === "bigint") {
    const text = value.toString()
    const redacted = redactSensitiveText(text)
    return redacted === text ? value : redacted
  }
  if (typeof value === "symbol") return redactSensitiveText(value.toString())
  if (typeof value === "function") {
    return `[Function ${redactSensitiveText(value.name || "anonymous")}]`
  }
  if (value === null || value === undefined || typeof value === "boolean") return value

  const prior = seen.get(value)
  if (prior) return prior

  if (value instanceof Error) {
    const output = new Error(redactSensitiveText(value.message))
    seen.set(value, output)
    output.name = redactSensitiveText(value.name)
    if (value.stack) output.stack = redactSensitiveText(value.stack)
    if ("cause" in value) {
      Object.defineProperty(output, "cause", {
        configurable: true,
        enumerable: false,
        value: redactValue(value.cause, "cause", seen),
        writable: true
      })
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") continue
      Object.assign(output, { [redactSensitiveText(key)]: redactValue(nested, key, seen) })
    }
    return output
  }

  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const nested of value) output.push(redactValue(nested, undefined, seen))
    return output
  }

  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return redactSensitiveText(value.toString())
  if (value instanceof URL) return redactSensitiveText(value.toString())
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  }

  if (value instanceof Map) {
    const output = new Map<unknown, unknown>()
    seen.set(value, output)
    for (const [key, nested] of value) {
      const field = typeof key === "string" ? key : undefined
      output.set(redactValue(key, undefined, seen), redactValue(nested, field, seen))
    }
    return output
  }

  if (value instanceof Set) {
    const output = new Set<unknown>()
    seen.set(value, output)
    for (const nested of value) output.add(redactValue(nested, undefined, seen))
    return output
  }

  const output: Record<string, unknown> = {}
  seen.set(value, output)
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) continue
      const field = typeof key === "string" ? key : key.toString()
      const safeField = redactSensitiveText(field)
      output[safeField] =
        "value" in descriptor ? redactValue(descriptor.value, field, seen) : "[Getter]"
    }
  } catch {
    return "[Unserializable Object]"
  }
  return output
}

/** Return a detached, recursively redacted value suitable for any log sink. */
export function redactLogValue(value: unknown): unknown {
  return redactValue(value, undefined, new WeakMap<object, unknown>())
}

/** Redact a console argument list while preserving argument boundaries. */
export function redactLogValues(values: readonly unknown[]): unknown[] {
  const seen = new WeakMap<object, unknown>()
  return values.map((value) => redactValue(value, undefined, seen))
}
