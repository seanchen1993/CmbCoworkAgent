import { types as nodeUtilTypes } from "node:util"

const REDACTED = "[REDACTED]"
const DEPTH_LIMIT_PLACEHOLDER = "[Truncated: depth limit]"
const ENTRY_LIMIT_PLACEHOLDER = "[Truncated: entry limit]"
const NODE_LIMIT_PLACEHOLDER = "[Truncated: node limit]"
const TEXT_LIMIT_PLACEHOLDER = "[Truncated: text limit]"
const TEXT_BUDGET_PLACEHOLDER = "[Truncated: text budget]"
const UNSERIALIZABLE_OBJECT_PLACEHOLDER = "[Unserializable Object]"
const UNSERIALIZABLE_PROPERTY_PLACEHOLDER = "[Unserializable Property]"
const GETTER_PLACEHOLDER = "[Getter]"

const MAX_REDACTION_DEPTH = 16
const MAX_REDACTION_ENTRIES = 64
const MAX_REDACTION_NODES = 4_096
const MAX_REDACTION_PROPERTY_SCANS = 256
const MAX_REDACTION_TOTAL_PROPERTY_SCANS = 4_096
const MAX_REDACTION_STRING_CHARS = 64 * 1024
const MAX_REDACTION_TOTAL_STRING_CHARS = 256 * 1024
const MAX_REDACTION_FIELD_NAME_CHARS = 256
const NO_EXCLUDED_KEYS: ReadonlySet<string> = new Set()
const IntrinsicError = Error
const NATIVE_ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(
  new IntrinsicError(),
  "stack"
)?.get
const DEFAULT_PREPARE_STACK_TRACE = Object.getOwnPropertyDescriptor(
  IntrinsicError,
  "prepareStackTrace"
)
const DEFAULT_PREPARE_STACK_TRACE_IS_NODE_INTERNAL = (() => {
  if (!DEFAULT_PREPARE_STACK_TRACE || !("value" in DEFAULT_PREPARE_STACK_TRACE)) return false
  const formatter = DEFAULT_PREPARE_STACK_TRACE.value
  if (typeof formatter !== "function" || nodeUtilTypes.isProxy(formatter)) return false
  const name = Object.getOwnPropertyDescriptor(formatter, "name")
  if (!name || !("value" in name) || name.value !== "ErrorPrepareStackTrace") return false
  try {
    return Function.prototype.toString.call(formatter).includes("internalPrepareStackTrace")
  } catch {
    return false
  }
})()

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
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g
const URL_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//gi
const LEGACY_TRUNCATION_MARKER_PATTERN = /^…\[truncated \d+ chars\]$/
const AUTHORIZATION_ASSIGNMENT_PATTERN =
  /((?:"|')?(?:authorization|proxy[-_ ]?authorization)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)/gi
const COOKIE_ASSIGNMENT_PATTERN =
  /((?:"|')?(?:cookie|set[-_ ]?cookie)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n}]+)/gi
const SESSION_ID_ASSIGNMENT_PATTERN =
  /(^|[^a-z0-9_.-])((?:"|')?session[-_ ]id(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}&\]]+)/gim
const AUTH_CODE_ASSIGNMENT_PATTERN =
  /(^|[^a-z0-9_.-])((?:"|')?(?:authorization|oauth|yst)[-_ ]code(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}&\]]+)/gim
const OVERSIZED_ASSIGNMENT_KEY_PATTERN =
  /(^|[^a-z0-9_.-])((?:"|')?[a-z0-9_.-]{257,}(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\r\n,;}&\]]+)/gim
const SECRET_ASSIGNMENT_CANDIDATE_PATTERN =
  /(^|[^a-z0-9_.-])((?:"|')?([a-z0-9_.-]{0,256}(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|credential|signature)|session|sessionid|sig|authorization[-_]?code|oauth[-_]?code|yst[-_]?code|密码|口令|令牌|密钥)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\r\n,;}&\]]+)/gim
const BEARER_OR_BASIC_PATTERN = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{4,}/gi
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PREFIXED_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g
const CHINESE_ID_18_PATTERN = /(^|[^\d])([1-9]\d{16}[\dXx])(?=$|[^\d])/g
const CHINESE_ID_15_PATTERN = /(^|[^\d])([1-9]\d{14})(?=$|[^\d])/g
const CHINA_MOBILE_PATTERN = /(^|[^\d])((?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8})(?=$|[^\d])/g
const BANK_CARD_CANDIDATE_PATTERN = /(^|[^\d])((?:\d[ -]?){15,18}\d)(?=$|[^\d])/g

function normalizeFieldName(fieldName: string): string {
  return fieldName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "")
}

function classifyField(fieldName: string | undefined): SensitiveFieldKind | undefined {
  if (!fieldName) return undefined
  // Diagnostic keys are user-controlled. Do not scan an attacker-sized key;
  // fail closed because a useful field classification is no longer possible.
  if (fieldName.length > MAX_REDACTION_FIELD_NAME_CHARS) return "secret"
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

function redactKnownField(
  value: unknown,
  kind: SensitiveFieldKind,
  context: RedactionContext
): unknown {
  if (value === null || value === undefined || typeof value === "boolean") return value
  if (kind === "secret") return REDACTED
  if (typeof value === "object" || typeof value === "function") return REDACTED

  const text = String(value)
  if (context.remainingStringChars <= 0) return TEXT_BUDGET_PLACEHOLDER
  const limit = Math.min(MAX_REDACTION_STRING_CHARS, context.remainingStringChars)
  const boundedText = text.length > limit ? text.slice(0, limit) : text
  context.remainingStringChars = Math.max(
    0,
    context.remainingStringChars - Math.min(text.length, limit)
  )

  // A typed PII field is sensitive even when its value is too large or
  // malformed for the type-specific matcher. Mask the bounded prefix directly
  // and omit the tail instead of scanning or copying attacker-sized input.
  if (text.length > limit) {
    const visibleStart = kind === "id-card" || kind === "bank-card" ? 6 : kind === "phone" ? 3 : 1
    const visibleEnd = kind === "email" ? 3 : 4
    return `${maskKeepingEdges(boundedText, visibleStart, visibleEnd)}${TEXT_LIMIT_PLACEHOLDER}`
  }

  if (kind === "id-card") return maskKeepingEdges(boundedText, 6, 4)
  if (kind === "phone") {
    const redacted = redactMobilePhones(boundedText)
    return redacted === boundedText ? maskKeepingEdges(boundedText, 3, 4) : redacted
  }
  if (kind === "email") {
    const redacted = redactEmails(boundedText)
    return redacted === boundedText ? maskKeepingEdges(boundedText, 1, 3) : redacted
  }
  const redacted = redactBankCards(boundedText)
  return redacted === boundedText ? maskKeepingEdges(boundedText, 6, 4) : redacted
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

function isEmailLocalChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "." ||
    char === "_" ||
    char === "%" ||
    char === "+" ||
    char === "-"
  )
}

function isEmailDomainChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "." ||
    char === "-"
  )
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function hasAsciiLetterTld(domain: string, lastDot: number): boolean {
  for (let index = lastDot + 1; index < domain.length; index += 1) {
    if (!isAsciiLetter(domain[index])) return false
  }
  return true
}

function redactEmails(text: string): string {
  let searchFrom = 0
  let copiedThrough = 0
  let output = ""
  while (searchFrom < text.length) {
    const atIndex = text.indexOf("@", searchFrom)
    if (atIndex < 0) break

    let localStart = atIndex
    while (localStart > copiedThrough && isEmailLocalChar(text[localStart - 1])) {
      localStart -= 1
    }
    let domainEnd = atIndex + 1
    while (domainEnd < text.length && isEmailDomainChar(text[domainEnd])) {
      domainEnd += 1
    }
    const domain = text.slice(atIndex + 1, domainEnd)
    const lastDot = domain.lastIndexOf(".")
    const validDomain =
      localStart < atIndex &&
      lastDot > 0 &&
      lastDot <= domain.length - 3 &&
      hasAsciiLetterTld(domain, lastDot)

    if (!validDomain) {
      searchFrom = atIndex + 1
      continue
    }

    output += text.slice(copiedThrough, localStart)
    output += maskEmail(text.slice(localStart, atIndex), domain)
    copiedThrough = domainEnd
    searchFrom = domainEnd
  }
  return copiedThrough === 0 ? text : `${output}${text.slice(copiedThrough)}`
}

interface UrlAuthorityScan {
  authorityEnd: number
  firstColon: number
  lastAt: number
}

function scanUrlAuthority(text: string, authorityStart: number): UrlAuthorityScan {
  let cursor = authorityStart
  let firstColon = -1
  let lastAt = -1
  while (cursor < text.length && !/[/?#\s]/.test(text[cursor])) {
    if (text[cursor] === ":" && firstColon < 0) firstColon = cursor
    if (text[cursor] === "@") lastAt = cursor
    cursor += 1
  }
  return { authorityEnd: cursor, firstColon, lastAt }
}

function redactUrlCredentials(text: string): string {
  URL_SCHEME_PATTERN.lastIndex = 0
  let copiedThrough = 0
  let output = ""
  for (let match = URL_SCHEME_PATTERN.exec(text); match; match = URL_SCHEME_PATTERN.exec(text)) {
    const authorityStart = URL_SCHEME_PATTERN.lastIndex
    const { authorityEnd, lastAt } = scanUrlAuthority(text, authorityStart)
    URL_SCHEME_PATTERN.lastIndex = Math.max(URL_SCHEME_PATTERN.lastIndex, authorityEnd)
    if (lastAt < authorityStart) continue

    output += text.slice(copiedThrough, authorityStart)
    output += `${REDACTED}@${text.slice(lastAt + 1, authorityEnd)}`
    copiedThrough = authorityEnd
  }
  URL_SCHEME_PATTERN.lastIndex = 0
  return copiedThrough === 0 ? text : `${output}${text.slice(copiedThrough)}`
}

function redactIncompleteUrlCredentialSuffix(text: string): string {
  URL_SCHEME_PATTERN.lastIndex = 0
  let lastAuthorityStart = -1
  let lastAuthorityEnd = -1
  let lastColon = -1
  let lastAt = -1
  for (let match = URL_SCHEME_PATTERN.exec(text); match; match = URL_SCHEME_PATTERN.exec(text)) {
    lastAuthorityStart = URL_SCHEME_PATTERN.lastIndex
    const authority = scanUrlAuthority(text, lastAuthorityStart)
    lastAuthorityEnd = authority.authorityEnd
    lastColon = authority.firstColon
    lastAt = authority.lastAt
    URL_SCHEME_PATTERN.lastIndex = Math.max(URL_SCHEME_PATTERN.lastIndex, lastAuthorityEnd)
  }
  URL_SCHEME_PATTERN.lastIndex = 0
  if (lastAuthorityStart < 0 || lastAuthorityEnd !== text.length) return text
  if (lastAt >= lastAuthorityStart) return text
  return lastColon >= lastAuthorityStart ? `${text.slice(0, lastAuthorityStart)}${REDACTED}` : text
}

function redactLegacyTruncatedUrlCredential(text: string): string {
  const markerStart = text.lastIndexOf("…[truncated ")
  if (markerStart < 0) return text
  const marker = text.slice(markerStart)
  if (!LEGACY_TRUNCATION_MARKER_PATTERN.test(marker)) return text
  return `${redactTruncatedPiiSuffix(
    redactTruncatedSensitiveSuffix(redactIncompleteUrlCredentialSuffix(text.slice(0, markerStart)))
  )}${marker}`
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
function redactSensitiveTextWithinLimit(text: string): string {
  let credentialSafeText = text.replace(
    PRIVATE_KEY_PATTERN,
    "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----"
  )
  credentialSafeText = redactUrlCredentials(credentialSafeText)
  credentialSafeText = redactLegacyTruncatedUrlCredential(credentialSafeText)
  return redactBankCards(
    redactEmails(
      redactMobilePhones(
        redactChineseIdCards(
          credentialSafeText
            .replace(
              AUTHORIZATION_ASSIGNMENT_PATTERN,
              (_match, prefix: string, value: string) => `${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              COOKIE_ASSIGNMENT_PATTERN,
              (_match, prefix: string, value: string) => `${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              SESSION_ID_ASSIGNMENT_PATTERN,
              (_match, boundary: string, prefix: string, value: string) =>
                `${boundary}${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              AUTH_CODE_ASSIGNMENT_PATTERN,
              (_match, boundary: string, prefix: string, value: string) =>
                `${boundary}${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              OVERSIZED_ASSIGNMENT_KEY_PATTERN,
              (_match, boundary: string, prefix: string, value: string) =>
                `${boundary}${prefix}${preserveValueQuotes(value)}`
            )
            .replace(
              SECRET_ASSIGNMENT_CANDIDATE_PATTERN,
              (match, boundary: string, prefix: string, fieldName: string, value: string) => {
                return classifyField(fieldName) === "secret"
                  ? `${boundary}${prefix}${preserveValueQuotes(value)}`
                  : match
              }
            )
            .replace(BEARER_OR_BASIC_PATTERN, "$1[REDACTED]")
            .replace(JWT_PATTERN, REDACTED)
            .replace(PREFIXED_TOKEN_PATTERN, REDACTED)
        )
      )
    )
  )
}

function redactTruncatedSensitiveSuffix(text: string): string {
  return redactIncompleteUrlCredentialSuffix(text)
    .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]*$/i, "$1[REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|AKIA[0-9A-Z]*)$/i,
      REDACTED
    )
    .replace(/\beyJ[A-Za-z0-9_.-]*$/i, REDACTED)
}

function redactTruncatedPiiSuffix(text: string): string {
  return text
    .replace(/(^|[^\d])([1-9]\d{13,16})$/, "$1[REDACTED]")
    .replace(/(^|[^\d+])((?:\+?86[- ]?)?1[3-9](?:[- ]?\d){6,8})$/, "$1[REDACTED]")
    .replace(/(^|[^\d])(1[3-9]\d{6,9})$/, "$1[REDACTED]")
    .replace(/(^|[^A-Z0-9._%+-])([A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{0,253})$/i, "$1[REDACTED]")
}

export type SensitiveTextTruncationMarker = string | ((omittedChars: number) => string)

/**
 * Redact a bounded prefix and omit the tail. Incomplete credentials at the
 * truncation boundary are masked before the caller-specific marker is added.
 */
export function redactAndTruncateSensitiveText(
  text: string,
  maxChars: number,
  marker: SensitiveTextTruncationMarker = TEXT_LIMIT_PLACEHOLDER
): string {
  const limit = Math.max(0, Math.min(MAX_REDACTION_STRING_CHARS, Math.floor(maxChars)))
  if (text.length <= limit) {
    const redacted = redactSensitiveTextWithinLimit(text)
    return redacted.length <= limit
      ? redacted
      : `${redacted.slice(0, limit)}${TEXT_LIMIT_PLACEHOLDER}`
  }

  const omittedChars = text.length - limit
  const redactedPrefix = redactTruncatedPiiSuffix(
    redactTruncatedSensitiveSuffix(redactSensitiveTextWithinLimit(text.slice(0, limit)))
  )
  const markerText = (typeof marker === "function" ? marker(omittedChars) : marker).slice(0, 512)
  return `${redactedPrefix.slice(0, limit)}${markerText}`
}

/**
 * Redact credentials and common Chinese PII from already-formatted log text.
 * Partial masks keep records correlatable without retaining the complete value.
 * The hard input bound prevents a diagnostic string from monopolizing main.
 */
export function redactSensitiveText(text: string): string {
  return redactAndTruncateSensitiveText(text, MAX_REDACTION_STRING_CHARS)
}

/**
 * Redact text that may already have been truncated by an upstream collection
 * budget. This fails closed for an incomplete URL credential at EOF without
 * relying on a particular truncation marker.
 */
export function redactPossiblyTruncatedSensitiveText(text: string): string {
  return redactTruncatedPiiSuffix(redactTruncatedSensitiveSuffix(redactSensitiveText(text)))
}

interface RedactionContext {
  remainingNodes: number
  remainingPropertyScans: number
  remainingStringChars: number
  readonly seen: WeakMap<object, unknown>
}

type PropertyReadResult =
  | { enumerable: false; kind: "missing" }
  | { enumerable: boolean; kind: "getter" }
  | { enumerable: boolean; kind: "value"; value: unknown }
  | { enumerable: false; kind: "error" }

function createRedactionContext(): RedactionContext {
  return {
    remainingNodes: MAX_REDACTION_NODES,
    remainingPropertyScans: MAX_REDACTION_TOTAL_PROPERTY_SCANS,
    remainingStringChars: MAX_REDACTION_TOTAL_STRING_CHARS,
    seen: new WeakMap<object, unknown>()
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

function hasSafePrototypeChain(value: object): boolean {
  let current: object | null = value
  for (let depth = 0; depth < MAX_REDACTION_DEPTH * 2; depth += 1) {
    try {
      if (nodeUtilTypes.isProxy(current)) return false
      current = Object.getPrototypeOf(current)
    } catch {
      return false
    }
    if (current === null) return true
  }
  return false
}

function safeInstanceOf(value: object, constructor: object): boolean {
  try {
    return Function.prototype[Symbol.hasInstance].call(constructor, value)
  } catch {
    return false
  }
}

function readOwnProperty(value: object, key: PropertyKey): PropertyReadResult {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return { enumerable: false, kind: "missing" }
    if (!("value" in descriptor)) {
      return { enumerable: descriptor.enumerable === true, kind: "getter" }
    }
    return {
      enumerable: descriptor.enumerable === true,
      kind: "value",
      value: descriptor.value
    }
  } catch {
    return { enumerable: false, kind: "error" }
  }
}

function readPrototypeDataString(value: object, key: PropertyKey): string | undefined {
  let current: object | null = value
  for (let depth = 0; current && depth < MAX_REDACTION_DEPTH * 2; depth += 1) {
    if (nodeUtilTypes.isProxy(current)) return undefined
    const property = readOwnProperty(current, key)
    if (property.kind === "getter" || property.kind === "error") return undefined
    if (property.kind === "value") {
      return typeof property.value === "string" ? property.value : undefined
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function hasUnchangedPrepareStackTrace(): boolean {
  if (DEFAULT_PREPARE_STACK_TRACE && !DEFAULT_PREPARE_STACK_TRACE_IS_NODE_INTERNAL) return false
  let current: object | null = IntrinsicError
  for (let depth = 0; current && depth < MAX_REDACTION_DEPTH; depth += 1) {
    if (nodeUtilTypes.isProxy(current)) return false
    const descriptor = Object.getOwnPropertyDescriptor(current, "prepareStackTrace")
    if (current === IntrinsicError) {
      const captured = DEFAULT_PREPARE_STACK_TRACE
      if (!descriptor && !captured) {
        current = Object.getPrototypeOf(current)
        continue
      }
      if (
        !descriptor ||
        !captured ||
        !("value" in descriptor) ||
        !("value" in captured) ||
        descriptor.value !== captured.value
      ) {
        return false
      }
    } else if (descriptor) {
      return false
    }
    current = Object.getPrototypeOf(current)
  }
  return current === null
}

function defineOutputProperty(
  output: object,
  key: string,
  value: unknown,
  enumerable = true
): void {
  Object.defineProperty(output, key, {
    configurable: true,
    enumerable,
    value,
    writable: true
  })
}

function safeFieldName(key: PropertyKey, context: RedactionContext): string {
  try {
    return redactStringValue(
      typeof key === "string" ? key : key.toString(),
      context,
      MAX_REDACTION_FIELD_NAME_CHARS
    )
  } catch {
    return "[Unserializable Key]"
  }
}

function safeFunctionName(value: unknown, fallback: string, context: RedactionContext): string {
  if (typeof value !== "function") return fallback
  const nameProperty = readOwnProperty(value, "name")
  return nameProperty.kind === "value" && typeof nameProperty.value === "string"
    ? redactStringValue(nameProperty.value, context, MAX_REDACTION_FIELD_NAME_CHARS)
    : fallback
}

function redactStringValue(
  value: string,
  context: RedactionContext,
  maxChars = MAX_REDACTION_STRING_CHARS
): string {
  if (context.remainingStringChars <= 0) return TEXT_BUDGET_PLACEHOLDER
  const limit = Math.min(maxChars, context.remainingStringChars)
  context.remainingStringChars = Math.max(
    0,
    context.remainingStringChars - Math.min(value.length, limit)
  )
  return redactAndTruncateSensitiveText(value, limit)
}

function setSeenFallback(value: unknown, context: RedactionContext, fallback: unknown): void {
  if (!isObjectLike(value)) return
  try {
    context.seen.set(value, fallback)
  } catch {
    // A logging safeguard must never surface failures from diagnostic values.
  }
}

function copyEnumerableProperties(
  source: object,
  output: object,
  context: RedactionContext,
  depth: number,
  excludedKeys: ReadonlySet<string> = NO_EXCLUDED_KEYS
): void {
  let emittedEntries = 0
  let scannedProperties = 0
  try {
    for (const key in source) {
      if (
        scannedProperties >= MAX_REDACTION_PROPERTY_SCANS ||
        context.remainingPropertyScans <= 0
      ) {
        defineOutputProperty(output, ENTRY_LIMIT_PLACEHOLDER, ENTRY_LIMIT_PLACEHOLDER)
        break
      }
      scannedProperties += 1
      context.remainingPropertyScans -= 1
      if (!Object.prototype.hasOwnProperty.call(source, key) || excludedKeys.has(key)) continue
      if (emittedEntries >= MAX_REDACTION_ENTRIES) {
        defineOutputProperty(output, ENTRY_LIMIT_PLACEHOLDER, ENTRY_LIMIT_PLACEHOLDER)
        break
      }

      const property = readOwnProperty(source, key)
      if (property.kind === "missing" || !property.enumerable) continue
      const nested =
        property.kind === "value"
          ? redactValue(property.value, key, context, depth + 1)
          : property.kind === "getter"
            ? GETTER_PLACEHOLDER
            : UNSERIALIZABLE_PROPERTY_PLACEHOLDER
      defineOutputProperty(output, safeFieldName(key, context), nested)
      emittedEntries += 1
    }
  } catch {
    defineOutputProperty(output, "redaction", UNSERIALIZABLE_OBJECT_PLACEHOLDER)
  }
}

function redactValue(
  value: unknown,
  fieldName: string | undefined,
  context: RedactionContext,
  depth: number
): unknown {
  try {
    return redactValueUnsafe(value, fieldName, context, depth)
  } catch {
    setSeenFallback(value, context, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
    return UNSERIALIZABLE_OBJECT_PLACEHOLDER
  }
}

function redactValueUnsafe(
  value: unknown,
  fieldName: string | undefined,
  context: RedactionContext,
  depth: number
): unknown {
  const fieldKind = classifyField(fieldName)
  if (fieldKind) return redactKnownField(value, fieldKind, context)

  if (isObjectLike(value) && !hasSafePrototypeChain(value)) {
    setSeenFallback(value, context, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
    return UNSERIALIZABLE_OBJECT_PLACEHOLDER
  }
  if (isObjectLike(value) && context.seen.has(value)) {
    return context.seen.get(value)
  }
  if (context.remainingNodes <= 0) {
    setSeenFallback(value, context, NODE_LIMIT_PLACEHOLDER)
    return NODE_LIMIT_PLACEHOLDER
  }
  context.remainingNodes -= 1

  if (typeof value === "string") return redactStringValue(value, context)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value
    const text = String(value)
    const redacted = redactSensitiveText(text)
    return redacted === text ? value : redacted
  }
  if (typeof value === "bigint") {
    const text = value.toString()
    const redacted = redactStringValue(text, context)
    return redacted === text ? value : redacted
  }
  if (typeof value === "symbol") return redactStringValue(value.toString(), context)
  if (typeof value === "function") {
    return `[Function ${safeFunctionName(value, "anonymous", context)}]`
  }
  if (value === null || value === undefined || typeof value === "boolean") return value

  if (depth >= MAX_REDACTION_DEPTH) {
    context.seen.set(value, DEPTH_LIMIT_PLACEHOLDER)
    return DEPTH_LIMIT_PLACEHOLDER
  }

  if (safeInstanceOf(value, IntrinsicError)) {
    const messageProperty = readOwnProperty(value, "message")
    const message =
      messageProperty.kind === "value" && typeof messageProperty.value === "string"
        ? redactStringValue(messageProperty.value, context)
        : ""
    const output = new IntrinsicError(message)
    context.seen.set(value, output)

    const safeName = readPrototypeDataString(value, "name")
    output.name = safeName
      ? redactStringValue(safeName, context, MAX_REDACTION_FIELD_NAME_CHARS)
      : "Error"

    const stackProperty = readOwnProperty(value, "stack")
    if (stackProperty.kind === "value" && typeof stackProperty.value === "string") {
      output.stack = redactStringValue(stackProperty.value, context)
    } else if (stackProperty.kind === "getter") {
      const nativeStackIsSafe =
        Object.getOwnPropertyDescriptor(value, "stack")?.get === NATIVE_ERROR_STACK_GETTER &&
        typeof readPrototypeDataString(value, "name") === "string" &&
        typeof readPrototypeDataString(value, "message") === "string" &&
        hasUnchangedPrepareStackTrace()
      if (nativeStackIsSafe && NATIVE_ERROR_STACK_GETTER) {
        try {
          const nativeStack = NATIVE_ERROR_STACK_GETTER.call(value)
          output.stack =
            typeof nativeStack === "string"
              ? redactStringValue(nativeStack, context)
              : GETTER_PLACEHOLDER
        } catch {
          output.stack = GETTER_PLACEHOLDER
        }
      } else {
        output.stack = GETTER_PLACEHOLDER
      }
    } else if (stackProperty.kind === "error") {
      output.stack = UNSERIALIZABLE_PROPERTY_PLACEHOLDER
    }

    const causeProperty = readOwnProperty(value, "cause")
    if (causeProperty.kind !== "missing") {
      const cause =
        causeProperty.kind === "value"
          ? redactValue(causeProperty.value, "cause", context, depth + 1)
          : causeProperty.kind === "getter"
            ? GETTER_PLACEHOLDER
            : UNSERIALIZABLE_PROPERTY_PLACEHOLDER
      Object.defineProperty(output, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true
      })
    }

    copyEnumerableProperties(
      value,
      output,
      context,
      depth,
      new Set(["name", "message", "stack", "cause"])
    )
    return output
  }

  let isArray = false
  try {
    isArray = Array.isArray(value)
  } catch {
    context.seen.set(value, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
    return UNSERIALIZABLE_OBJECT_PLACEHOLDER
  }
  if (isArray) {
    const output: unknown[] = []
    context.seen.set(value, output)
    const lengthProperty = readOwnProperty(value, "length")
    if (lengthProperty.kind !== "value" || typeof lengthProperty.value !== "number") {
      context.seen.set(value, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
      return UNSERIALIZABLE_OBJECT_PLACEHOLDER
    }
    const length = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, lengthProperty.value))
    const entryCount = Math.min(length, MAX_REDACTION_ENTRIES)
    for (let index = 0; index < entryCount; index += 1) {
      const property = readOwnProperty(value, String(index))
      output.push(
        property.kind === "value"
          ? redactValue(property.value, undefined, context, depth + 1)
          : property.kind === "getter"
            ? GETTER_PLACEHOLDER
            : property.kind === "error"
              ? UNSERIALIZABLE_PROPERTY_PLACEHOLDER
              : undefined
      )
    }
    if (length > MAX_REDACTION_ENTRIES) output.push(ENTRY_LIMIT_PLACEHOLDER)
    return output
  }

  if (safeInstanceOf(value, Date)) {
    return new Date(Date.prototype.getTime.call(value))
  }
  if (safeInstanceOf(value, RegExp)) {
    try {
      const sourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get
      const flagNames = [
        ["hasIndices", "d"],
        ["global", "g"],
        ["ignoreCase", "i"],
        ["multiline", "m"],
        ["dotAll", "s"],
        ["unicode", "u"],
        ["unicodeSets", "v"],
        ["sticky", "y"]
      ] as const
      const source = sourceGetter?.call(value)
      if (typeof source !== "string") return "[RegExp]"
      let flags = ""
      for (const [property, flag] of flagNames) {
        const getter = Object.getOwnPropertyDescriptor(RegExp.prototype, property)?.get
        if (getter?.call(value)) flags += flag
      }
      return redactStringValue(`/${source}/${flags}`, context)
    } catch {
      return "[RegExp]"
    }
  }
  if (safeInstanceOf(value, URL)) {
    return redactStringValue(URL.prototype.toString.call(value), context)
  }
  if (safeInstanceOf(value, ArrayBuffer)) {
    const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
    return `[ArrayBuffer ${byteLength?.call(value) ?? 0} bytes]`
  }
  let isArrayBufferView = false
  try {
    isArrayBufferView = ArrayBuffer.isView(value)
  } catch {
    isArrayBufferView = false
  }
  if (isArrayBufferView) {
    let byteLength: number
    let typeName = "ArrayBufferView"
    try {
      const dataViewByteLength = Object.getOwnPropertyDescriptor(
        DataView.prototype,
        "byteLength"
      )?.get
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
      const typedArrayByteLength = Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        "byteLength"
      )?.get
      try {
        byteLength = dataViewByteLength?.call(value) ?? 0
        typeName = "DataView"
      } catch {
        byteLength = typedArrayByteLength?.call(value) ?? 0
        const tagGetter = Object.getOwnPropertyDescriptor(
          typedArrayPrototype,
          Symbol.toStringTag
        )?.get
        const nativeTag = tagGetter?.call(value)
        typeName = typeof nativeTag === "string" ? nativeTag : "TypedArray"
      }
    } catch {
      return UNSERIALIZABLE_OBJECT_PLACEHOLDER
    }
    return `[${typeName} ${byteLength} bytes]`
  }

  if (safeInstanceOf(value, Map)) {
    const output = new Map<unknown, unknown>()
    context.seen.set(value, output)
    let iterator: IterableIterator<[unknown, unknown]>
    try {
      iterator = Map.prototype.entries.call(value)
    } catch {
      context.seen.set(value, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
      return UNSERIALIZABLE_OBJECT_PLACEHOLDER
    }
    for (let index = 0; index <= MAX_REDACTION_ENTRIES; index += 1) {
      let step: IteratorResult<[unknown, unknown]>
      try {
        step = iterator.next()
      } catch {
        output.set(UNSERIALIZABLE_OBJECT_PLACEHOLDER, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
        break
      }
      if (step.done) break
      if (index === MAX_REDACTION_ENTRIES) {
        output.set(ENTRY_LIMIT_PLACEHOLDER, ENTRY_LIMIT_PLACEHOLDER)
        break
      }
      const [key, nested] = step.value
      const field = typeof key === "string" ? key : undefined
      output.set(
        redactValue(key, undefined, context, depth + 1),
        redactValue(nested, field, context, depth + 1)
      )
    }
    return output
  }

  if (safeInstanceOf(value, Set)) {
    const output = new Set<unknown>()
    context.seen.set(value, output)
    let iterator: IterableIterator<unknown>
    try {
      iterator = Set.prototype.values.call(value)
    } catch {
      context.seen.set(value, UNSERIALIZABLE_OBJECT_PLACEHOLDER)
      return UNSERIALIZABLE_OBJECT_PLACEHOLDER
    }
    for (let index = 0; index <= MAX_REDACTION_ENTRIES; index += 1) {
      let step: IteratorResult<unknown>
      try {
        step = iterator.next()
      } catch {
        output.add(UNSERIALIZABLE_OBJECT_PLACEHOLDER)
        break
      }
      if (step.done) break
      if (index === MAX_REDACTION_ENTRIES) {
        output.add(ENTRY_LIMIT_PLACEHOLDER)
        break
      }
      output.add(redactValue(step.value, undefined, context, depth + 1))
    }
    return output
  }

  const output: Record<string, unknown> = {}
  context.seen.set(value, output)
  copyEnumerableProperties(value, output, context, depth)
  return output
}

/** Return a detached, recursively redacted value suitable for any log sink. */
export function redactLogValue(value: unknown): unknown {
  return redactValue(value, undefined, createRedactionContext(), 0)
}

/** Redact a console argument list while preserving argument boundaries. */
export function redactLogValues(values: readonly unknown[]): unknown[] {
  const context = createRedactionContext()
  return values.map((value) => redactValue(value, undefined, context, 0))
}
