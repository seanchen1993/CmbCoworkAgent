import { createHash } from "crypto"

export type DashboardEsIndexAlias = "event" | "trace"
export type DashboardEsQueryOperation = "search" | "msearch" | "count" | "mapping" | "field_caps"

export interface DashboardEsQueryContext {
  scope?: "platform" | "project"
  upperOrgLv1?: string | string[] | null
  projectId?: string | null
  featureSlug?: string | null
}

export interface DashboardEsQueryInput {
  indexAlias: DashboardEsIndexAlias
  operation: DashboardEsQueryOperation
  body?: unknown
  context?: DashboardEsQueryContext
}

export interface DashboardEsQueryAccess {
  sapId?: string
  ystId?: string
  unrestricted?: boolean
}

export interface DashboardEsQueryExecutionOptions {
  nodes: string[]
  auth?: { username: string; password: string } | null
  indexByAlias: Record<DashboardEsIndexAlias, string>
  injectedFilters?: Record<string, unknown>[]
  access?: DashboardEsQueryAccess
  timeoutMs?: number
}

export interface PreparedDashboardEsQuery {
  method: "GET" | "POST"
  path: string
  bodyText?: string
  contentType: "application/json" | "application/x-ndjson"
  warnings: string[]
  audit: DashboardEsQueryAuditRecord
}

export interface DashboardEsQueryAuditRecord {
  indexAlias: DashboardEsIndexAlias
  index: string
  operation: DashboardEsQueryOperation
  bodyHash: string
  bodyBytes: number
  injectedFilterCount: number
  warnings: string[]
  sapId?: string
  ystId?: string
}

export interface DashboardEsQueryResult {
  data: unknown
  meta: DashboardEsQueryAuditRecord & {
    elapsedMs: number
    node: string
  }
}

const DEFAULT_RESULT_SIZE = 100
const MAX_RESULT_SIZE = 1000
const MAX_BUCKET_SIZE = 5000
const DEFAULT_BUCKET_SIZE = 1000
const MAX_FROM = 10_000
const MAX_TERMS_VALUES = 10_000
const MAX_BODY_BYTES = 1_000_000
const DEFAULT_TIMEOUT_MS = 15_000

const ALLOWED_OPERATIONS = new Set<DashboardEsQueryOperation>([
  "search",
  "msearch",
  "count",
  "mapping",
  "field_caps"
])

const SENSITIVE_SOURCE_FIELDS = [
  "_raw",
  "raw",
  "userMessage",
  "messages",
  "inputMessages",
  "outputMessage",
  "pathName",
  "properties.filePath",
  "properties.repoPath",
  "properties.content",
  "properties.generatedContent",
  "properties.fingerprint",
  "properties.lineHashes"
]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function cloneJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === undefined || value === null) return { ...fallback }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ES query body must be a JSON object")
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function hashBody(bodyText: string): string {
  return createHash("sha256").update(bodyText).digest("hex")
}

function encodeIndexPath(index: string): string {
  return index
    .split(",")
    .map((part) => encodeURIComponent(part.trim()))
    .filter(Boolean)
    .join(",")
}

function ensureKnownOperation(operation: string): asserts operation is DashboardEsQueryOperation {
  if (!ALLOWED_OPERATIONS.has(operation as DashboardEsQueryOperation)) {
    throw new Error(`Unsupported dashboard ES operation: ${operation}`)
  }
}

function sanitizeSource(body: Record<string, unknown>, warnings: string[]): void {
  const source = body._source
  if (source === false) return

  if (Array.isArray(source)) {
    const includes = source.filter((field) => {
      const keep = typeof field === "string" && !SENSITIVE_SOURCE_FIELDS.includes(field)
      if (!keep) warnings.push(`Removed sensitive _source field: ${String(field)}`)
      return keep
    })
    body._source = { includes, excludes: SENSITIVE_SOURCE_FIELDS }
    return
  }

  if (source && typeof source === "object") {
    const sourceRecord = source as Record<string, unknown>
    if (Array.isArray(sourceRecord.includes)) {
      sourceRecord.includes = sourceRecord.includes.filter((field) => {
        const keep = typeof field === "string" && !SENSITIVE_SOURCE_FIELDS.includes(field)
        if (!keep) warnings.push(`Removed sensitive _source include: ${String(field)}`)
        return keep
      })
    }
    const excludes = Array.isArray(sourceRecord.excludes)
      ? sourceRecord.excludes.filter((field) => typeof field === "string")
      : []
    sourceRecord.excludes = Array.from(new Set([...excludes, ...SENSITIVE_SOURCE_FIELDS]))
    return
  }

  body._source = { excludes: SENSITIVE_SOURCE_FIELDS }
}

function normalizeSize(value: unknown, max: number, fallback: number, label: string, warnings: string[]): number {
  if (value === undefined) return fallback
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  if (numeric < 0) {
    warnings.push(`${label} was negative and was reset to 0`)
    return 0
  }
  if (numeric > max) {
    warnings.push(`${label} was clamped from ${numeric} to ${max}`)
    return max
  }
  return numeric
}

function rejectDeepPagination(body: Record<string, unknown>): void {
  const from = body.from
  if (typeof from === "number" && Number.isFinite(from) && from > MAX_FROM) {
    throw new Error(`ES query from=${from} exceeds the dashboard safety limit ${MAX_FROM}`)
  }
}

function enforceTermsLimit(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    if (value.length > MAX_TERMS_VALUES) {
      throw new Error(`${path.join(".")} has ${value.length} values, exceeding ${MAX_TERMS_VALUES}`)
    }
    for (let i = 0; i < value.length; i++) enforceTermsLimit(value[i], [...path, String(i)])
    return
  }
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (key === "terms" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const [field, termsValue] of Object.entries(child as Record<string, unknown>)) {
        if (Array.isArray(termsValue) && termsValue.length > MAX_TERMS_VALUES) {
          throw new Error(
            `${[...path, key, field].join(".")} has ${termsValue.length} values, exceeding ${MAX_TERMS_VALUES}`
          )
        }
      }
    }
    enforceTermsLimit(child, [...path, key])
  }
}

function clampAggSizes(value: unknown, warnings: string[], path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => clampAggSizes(child, warnings, [...path, String(index)]))
    return
  }
  if (!value || typeof value !== "object") return

  const record = value as Record<string, unknown>
  if (typeof record.size === "number" && Number.isFinite(record.size)) {
    const isRoot = path.length === 0
    const max = isRoot ? MAX_RESULT_SIZE : MAX_BUCKET_SIZE
    const fallback = isRoot ? DEFAULT_RESULT_SIZE : DEFAULT_BUCKET_SIZE
    record.size = normalizeSize(record.size, max, fallback, `${path.join(".") || "body"}.size`, warnings)
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "from" && typeof child === "number" && Number.isFinite(child) && child > MAX_FROM) {
      throw new Error(`${[...path, key].join(".")} exceeds the dashboard safety limit ${MAX_FROM}`)
    }
    clampAggSizes(child, warnings, [...path, key])
  }
}

function appendFilters(body: Record<string, unknown>, injectedFilters: Record<string, unknown>[]): void {
  if (injectedFilters.length === 0) return
  const existingQuery = body.query ?? { match_all: {} }
  body.query = {
    bool: {
      must: [existingQuery],
      filter: injectedFilters
    }
  }
}

function sanitizeSearchBody(
  rawBody: unknown,
  injectedFilters: Record<string, unknown>[],
  warnings: string[]
): Record<string, unknown> {
  const body = cloneJsonObject(rawBody)
  body.size = normalizeSize(body.size, MAX_RESULT_SIZE, DEFAULT_RESULT_SIZE, "body.size", warnings)
  if (body.track_total_hits === undefined) body.track_total_hits = false
  rejectDeepPagination(body)
  enforceTermsLimit(body, ["body"])
  clampAggSizes(body, warnings)
  appendFilters(body, injectedFilters)
  sanitizeSource(body, warnings)
  return body
}

function sanitizeCountBody(rawBody: unknown, injectedFilters: Record<string, unknown>[]): Record<string, unknown> {
  const body = cloneJsonObject(rawBody)
  enforceTermsLimit(body, ["body"])
  appendFilters(body, injectedFilters)
  return body
}

function sanitizeFieldCapsBody(rawBody: unknown): Record<string, unknown> {
  const body = cloneJsonObject(rawBody, { fields: ["*"] })
  enforceTermsLimit(body, ["body"])
  return body
}

function sanitizeMsearchBody(
  rawBody: unknown,
  injectedFilters: Record<string, unknown>[],
  warnings: string[]
): string {
  const record = cloneJsonObject(rawBody)
  const searches = record.searches
  if (!Array.isArray(searches)) {
    throw new Error("msearch body must be { searches: [{ header?, body }] }")
  }
  if (searches.length > 20) {
    throw new Error(`msearch contains ${searches.length} searches, exceeding 20`)
  }

  const lines: string[] = []
  for (const [index, item] of searches.entries()) {
    const entry = asRecord(item)
    const header = cloneJsonObject(entry.header ?? {})
    if ("index" in header) {
      delete header.index
      warnings.push(`Removed msearch header index override at searches[${index}]`)
    }
    const body = sanitizeSearchBody(entry.body ?? {}, injectedFilters, warnings)
    lines.push(JSON.stringify(header), JSON.stringify(body))
  }
  return `${lines.join("\n")}\n`
}

function assertBodySize(bodyText: string): void {
  const bytes = byteLength(bodyText)
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(`ES query body is ${bytes} bytes, exceeding ${MAX_BODY_BYTES}`)
  }
}

export function prepareDashboardEsQuery(
  input: DashboardEsQueryInput,
  options: Pick<DashboardEsQueryExecutionOptions, "indexByAlias" | "injectedFilters" | "access">
): PreparedDashboardEsQuery {
  ensureKnownOperation(input.operation)
  const index = options.indexByAlias[input.indexAlias]
  if (!index) throw new Error(`Dashboard ES index alias is not allowed: ${input.indexAlias}`)

  const warnings: string[] = []
  const injectedFilters = options.injectedFilters ?? []
  const encodedIndex = encodeIndexPath(index)
  let method: "GET" | "POST" = "POST"
  let path = ""
  let bodyText: string | undefined
  let contentType: "application/json" | "application/x-ndjson" = "application/json"

  if (input.operation === "mapping") {
    method = "GET"
    path = `/${encodedIndex}/_mapping`
  } else if (input.operation === "field_caps") {
    path = `/${encodedIndex}/_field_caps`
    bodyText = JSON.stringify(sanitizeFieldCapsBody(input.body))
  } else if (input.operation === "count") {
    path = `/${encodedIndex}/_count`
    bodyText = JSON.stringify(sanitizeCountBody(input.body, injectedFilters))
  } else if (input.operation === "msearch") {
    contentType = "application/x-ndjson"
    path = `/${encodedIndex}/_msearch?timeout=10s`
    bodyText = sanitizeMsearchBody(input.body, injectedFilters, warnings)
  } else {
    path = `/${encodedIndex}/_search?timeout=10s`
    bodyText = JSON.stringify(sanitizeSearchBody(input.body, injectedFilters, warnings))
  }

  const auditBody = bodyText ?? ""
  assertBodySize(auditBody)
  return {
    method,
    path,
    bodyText,
    contentType,
    warnings,
    audit: {
      indexAlias: input.indexAlias,
      index,
      operation: input.operation,
      bodyHash: hashBody(auditBody),
      bodyBytes: byteLength(auditBody),
      injectedFilterCount: injectedFilters.length,
      warnings: [...warnings],
      sapId: options.access?.sapId,
      ystId: options.access?.ystId
    }
  }
}

export async function executeDashboardEsQuery(
  input: DashboardEsQueryInput,
  options: DashboardEsQueryExecutionOptions
): Promise<DashboardEsQueryResult> {
  if (options.nodes.length === 0) throw new Error("ES_NODES not configured")

  const prepared = prepareDashboardEsQuery(input, options)
  const headers: Record<string, string> = { "Content-Type": prepared.contentType }
  if (options.auth) {
    headers.Authorization =
      "Basic " + Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64")
  }

  const startedAt = Date.now()
  let lastError: Error | null = null
  for (const node of options.nodes) {
    const url = `${node.replace(/\/+$/, "")}${prepared.path}`
    try {
      const resp = await fetch(url, {
        method: prepared.method,
        headers,
        body: prepared.method === "GET" ? undefined : prepared.bodyText,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      const data = await resp.json()
      const elapsedMs = Date.now() - startedAt
      const meta = { ...prepared.audit, elapsedMs, node }
      console.log("[DashboardESQuery]", JSON.stringify(meta))
      return { data, meta }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[DashboardESQuery] node failed: ${node}`, lastError.message)
    }
  }

  throw lastError ?? new Error("All ES nodes failed")
}
