import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import type { HookConfig, HookInjectUserContext, HookOnBlockConfig } from "../hooks/types"
import { isSupportedHookEvent } from "../hooks/types"
import { parseSkillFrontmatter, parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"
import {
  getDiscoveredSkillId,
  resolveDisabledSkillIds
} from "../skills/ids"
import type { DiscoveredSkill } from "../skills/discovery"
import type {
  HookCatalogPage,
  HookCatalogPageInput,
  HookCatalogPageStats,
  PluginHookMetadata,
  PluginMetadata,
  SkillHookMetadata
} from "../types"
import {
  HOOK_CATALOG_CANCELLED,
  HOOK_CATALOG_DEFAULT_PAGE_SIZE,
  HOOK_CATALOG_MAX_DIRECTORIES,
  HOOK_CATALOG_MAX_ENTRIES,
  HOOK_CATALOG_MAX_FILE_BYTES,
  HOOK_CATALOG_MAX_FILES,
  HOOK_CATALOG_MAX_PAGE_SIZE,
  HOOK_CATALOG_MAX_RESPONSE_BYTES,
  HOOK_CATALOG_MAX_SNAPSHOT_BYTES,
  HOOK_CATALOG_MAX_SKILLS,
  HOOK_CATALOG_MAX_SKILL_MD_BYTES,
  HOOK_CATALOG_MAX_STORE_BYTES,
  HOOK_CATALOG_MAX_TOTAL_READ_BYTES,
  HOOK_CATALOG_MAX_WORKSPACE_SNAPSHOT_BYTES,
  type HookCatalogSourceConfig
} from "./protocol"

const DEFAULT_PLUGIN_HOOKS_PATH = "hooks/hooks.json"
const SKILL_HOOK_FILES = ["hooks.json", "hooks/hooks.json"] as const
const WORKSPACE_HOOKS_DIR = ".cmbdevclaw/hooks"
const MAX_HOOK_TEXT = 8_192
const MAX_PATH_TEXT = 4_096
const MAX_ID_TEXT = 4_096
const MAX_HOOKS_PER_FILE = 512
const MAX_PLUGINS = 10_000
const MAX_PLUGIN_SKILL_SOURCES = 64
const MAX_PLUGIN_SKILL_SOURCE_PROBES = 10_000
const SNAPSHOT_TTL_MS = 2 * 60_000
// Production has one stable global source key. Three slots still tolerate
// alternate/test roots while leaving headroom for V8 expansion and scans.
const MAX_SNAPSHOTS = 3
// Workspace overlays are smaller but can vary on every thread switch. Bound
// their cross-workspace LRU to 3 (3 * 2 MiB) rather than retaining 4 roots.
const MAX_WORKSPACE_SNAPSHOTS = 3
const MAX_WORKSPACE_ENTRIES = 1_024

type Entry =
  | { source: "global"; hook: HookConfig }
  | { source: "workspace"; hook: HookConfig }
  | { source: "plugin"; hook: PluginHookMetadata }
  | { source: "skill"; hook: SkillHookMetadata }

interface MutableStats {
  scannedDirectories: number
  scannedFiles: number
  discoveredSkills: number
  readBytes: number
}

interface BuildContext {
  cancelFlag?: Int32Array
  stats: MutableStats
  truncatedReasons: Set<string>
  entries: Entry[]
  entryLimit: number
  snapshotBytes: number
  snapshotByteLimit: number
  retentionExhausted: boolean
  pluginSkillSourceProbes: number
}

interface GlobalCatalogSnapshot {
  id: string
  key: string
  sourceKey: string
  entries: Entry[]
  globalHookEntries: number
  enabledEntries: number
  relatedSummary: HookCatalogPage["relatedSummary"]
  truncated: boolean
  truncatedReasons: string[]
  stats: Omit<HookCatalogPageStats, "durationMs" | "responseBytes" | "globalScanReused" | "workspaceScanReused">
  expiresAt: number
}

interface WorkspaceCatalogSnapshot {
  id: string
  key: string
  sourceKey: string
  entries: Entry[]
  enabledEntries: number
  truncated: boolean
  truncatedReasons: string[]
  stats: Omit<HookCatalogPageStats, "durationMs" | "responseBytes" | "globalScanReused" | "workspaceScanReused">
  expiresAt: number
}

interface CatalogSnapshotBuild<T> {
  snapshot: T
  reused: boolean
  durationMs: number
}

interface CatalogDiscoveredSkill extends DiscoveredSkill {
  content: string
}

interface SkillSource {
  sourceDir: string
  maxDepth?: number
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
  respectDisabled: boolean
}

const globalSnapshots = new Map<string, GlobalCatalogSnapshot>()
const globalSnapshotIdByKey = new Map<string, string>()
const latestGlobalSnapshotIdBySource = new Map<string, string>()
const workspaceSnapshots = new Map<string, WorkspaceCatalogSnapshot>()
const workspaceSnapshotIdByKey = new Map<string, string>()
const latestWorkspaceSnapshotIdBySource = new Map<string, string>()
let nextSnapshotId = 1

export class HookCatalogCancelledError extends Error {
  readonly code = HOOK_CATALOG_CANCELLED

  constructor() {
    super("Hook catalog request was superseded")
    this.name = "HookCatalogCancelledError"
  }
}

export class HookCatalogCursorExpiredError extends Error {
  readonly code = "HOOK_CATALOG_CURSOR_EXPIRED"

  constructor() {
    super("Hook catalog cursor expired; restart from the first page")
    this.name = "HookCatalogCursorExpiredError"
  }
}

function checkCancelled(context: Pick<BuildContext, "cancelFlag">): void {
  if (context.cancelFlag && Atomics.load(context.cancelFlag, 0) !== 0) {
    throw new HookCatalogCancelledError()
  }
}

function markTruncated(context: BuildContext, reason: string): void {
  context.truncatedReasons.add(reason)
}

function deleteGlobalSnapshot(id: string): void {
  const snapshot = globalSnapshots.get(id)
  if (snapshot && globalSnapshotIdByKey.get(snapshot.key) === id) {
    globalSnapshotIdByKey.delete(snapshot.key)
  }
  if (snapshot && latestGlobalSnapshotIdBySource.get(snapshot.sourceKey) === id) {
    latestGlobalSnapshotIdBySource.delete(snapshot.sourceKey)
  }
  globalSnapshots.delete(id)
}

function deleteWorkspaceSnapshot(id: string): void {
  const snapshot = workspaceSnapshots.get(id)
  if (snapshot && workspaceSnapshotIdByKey.get(snapshot.key) === id) {
    workspaceSnapshotIdByKey.delete(snapshot.key)
  }
  if (snapshot && latestWorkspaceSnapshotIdBySource.get(snapshot.sourceKey) === id) {
    latestWorkspaceSnapshotIdBySource.delete(snapshot.sourceKey)
  }
  workspaceSnapshots.delete(id)
}

function trimExpiredSnapshots(): void {
  const now = Date.now()
  for (const [id, snapshot] of globalSnapshots) {
    if (snapshot.expiresAt <= now) deleteGlobalSnapshot(id)
  }
  for (const [id, snapshot] of workspaceSnapshots) {
    if (snapshot.expiresAt <= now) deleteWorkspaceSnapshot(id)
  }
  while (globalSnapshots.size > MAX_SNAPSHOTS) {
    const oldest = globalSnapshots.keys().next().value as string | undefined
    if (!oldest) break
    deleteGlobalSnapshot(oldest)
  }
  while (workspaceSnapshots.size > MAX_WORKSPACE_SNAPSHOTS) {
    const oldest = workspaceSnapshots.keys().next().value as string | undefined
    if (!oldest) break
    deleteWorkspaceSnapshot(oldest)
  }
}

function reserveGlobalSnapshotSlot(): void {
  while (globalSnapshots.size >= MAX_SNAPSHOTS) {
    const oldest = globalSnapshots.keys().next().value as string | undefined
    if (!oldest) break
    deleteGlobalSnapshot(oldest)
  }
}

function reserveWorkspaceSnapshotSlot(): void {
  while (workspaceSnapshots.size >= MAX_WORKSPACE_SNAPSHOTS) {
    const oldest = workspaceSnapshots.keys().next().value as string | undefined
    if (!oldest) break
    deleteWorkspaceSnapshot(oldest)
  }
}

function safeSlice(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function fileHookDates(path: string): Pick<HookConfig, "createdAt" | "updatedAt"> {
  try {
    const stats = statSync(path)
    const birthtime = stats.birthtime.getTime() > 0 ? stats.birthtime : stats.ctime
    return {
      createdAt: Number.isFinite(birthtime.getTime()) ? birthtime.toISOString() : "",
      updatedAt: Number.isFinite(stats.mtime.getTime()) ? stats.mtime.toISOString() : ""
    }
  } catch {
    // The file may disappear between reading and stat. An empty value renders
    // as unavailable instead of fabricating a fresh timestamp on every scan.
    return { createdAt: "", updatedAt: "" }
  }
}

function boundedString(
  context: BuildContext,
  value: unknown,
  max = MAX_HOOK_TEXT
): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length > max) markTruncated(context, "hook-field-bytes")
  return safeSlice(value, max)
}

function normalizeOptionalHookString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseForcedOutcome(value: unknown): "always-revise" | "always-halt" | undefined {
  return value === "always-revise" || value === "always-halt" ? value : undefined
}

function parseOptionalHookBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

const HOOK_USER_CONTEXT_FIELDS = new Set([
  "sap_id",
  "yst_id",
  "name",
  "origin_org_id",
  "org_name",
  "path_name",
  "origin_path_id",
  "yst_id_token"
])

function parseHookInjectUserContext(raw: unknown): HookInjectUserContext | undefined {
  if (typeof raw === "boolean") return raw
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const include = Array.isArray(record.include)
    ? record.include.filter(
        (item): item is "sap_id" | "yst_id" | "name" | "origin_org_id" | "org_name" |
          "path_name" | "origin_path_id" | "yst_id_token" =>
          typeof item === "string" && HOOK_USER_CONTEXT_FIELDS.has(item)
      )
    : undefined
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    ...(include && include.length > 0 ? { include } : {})
  }
}

function parseNativeHookTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseClaudeHookTimeoutMs(raw: Record<string, unknown>): number | undefined {
  const timeoutMs = parseNativeHookTimeout(raw.timeoutMs)
  if (timeoutMs !== undefined) return Math.round(timeoutMs)
  const timeoutSeconds = parseNativeHookTimeout(raw.timeout)
  return timeoutSeconds !== undefined ? Math.round(timeoutSeconds * 1000) : undefined
}

function parseHookShell(value: unknown): "bash" | "powershell" | "sh" | undefined {
  return value === "bash" || value === "powershell" || value === "sh" ? value : undefined
}

function parseHookType(value: unknown): "command" | "prompt" | "http" {
  return value === "prompt" || value === "http" ? value : "command"
}

function parseHookHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseHookStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === "string")
  return out.length > 0 ? out : undefined
}

function parseHookOnBlock(raw: unknown): HookOnBlockConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const value: HookOnBlockConfig = {
    reason: normalizeOptionalHookString(record.reason),
    systemMessage: normalizeOptionalHookString(record.systemMessage),
    additionalContext: normalizeOptionalHookString(record.additionalContext),
    requiredSkill: normalizeOptionalHookString(record.requiredSkill)
  }
  return value.reason || value.systemMessage || value.additionalContext || value.requiredSkill
    ? value
    : undefined
}

const CC_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PreSkillUse",
  "PostSkillUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "CwdChanged",
  "FileChanged"
])

type HooksFileFormat = "flat" | "cc_settings" | "cc_plugin" | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isCcSettingsObj(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => CC_HOOK_EVENTS.has(key) && Array.isArray(value[key]))
}

function detectHooksFileFormat(parsed: unknown): HooksFileFormat {
  if (Array.isArray(parsed)) return "flat"
  if (!isRecord(parsed)) return null
  if (isRecord(parsed.hooks) && isCcSettingsObj(parsed.hooks)) return "cc_plugin"
  return isCcSettingsObj(parsed) ? "cc_settings" : null
}

function nativeHook(
  raw: Record<string, unknown>,
  id: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string },
  options: {
    defaultSkillMatcher?: string
    fallbackForCommand?: boolean
    preserveRawDates?: boolean
  } = {}
): HookConfig | null {
  if (!isSupportedHookEvent(raw.event)) return null
  const type = parseHookType(raw.type)
  if (type === "command" && typeof raw.command !== "string") return null
  if (type === "prompt" && typeof raw.prompt !== "string") return null
  if (type === "http" && typeof raw.url !== "string") return null
  return {
    id,
    event: raw.event,
    matcher:
      typeof raw.matcher === "string"
        ? raw.matcher
        : raw.event === "PreSkillUse" || raw.event === "PostSkillUse"
          ? options.defaultSkillMatcher
          : undefined,
    if: normalizeOptionalHookString(raw.if),
    type,
    command: typeof raw.command === "string" ? raw.command : undefined,
    shell: parseHookShell(raw.shell),
    url: typeof raw.url === "string" ? raw.url : undefined,
    headers: parseHookHeaders(raw.headers),
    allowedEnvVars: parseHookStringArray(raw.allowedEnvVars),
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    model:
      typeof raw.model === "string"
        ? raw.model
        : typeof raw.modelId === "string"
          ? raw.modelId
          : undefined,
    fallback:
      options.fallbackForCommand || type === "prompt" || type === "http"
        ? raw.fallback === "block"
          ? "block"
          : "allow"
        : undefined,
    statusMessage: normalizeOptionalHookString(raw.statusMessage),
    onBlock: parseHookOnBlock(raw.onBlock),
    forcedOutcome: parseForcedOutcome(raw.forcedOutcome),
    forcedReason: normalizeOptionalHookString(raw.forcedReason),
    once: parseOptionalHookBoolean(raw.once),
    persistAfterInterrupt: parseOptionalHookBoolean(raw.persistAfterInterrupt),
    injectUserContext: parseHookInjectUserContext(raw.injectUserContext),
    timeout: parseNativeHookTimeout(raw.timeoutMs) ?? parseNativeHookTimeout(raw.timeout),
    async: raw.async === true ? true : undefined,
    enabled: raw.enabled !== false && meta.enabled,
    createdAt:
      options.preserveRawDates !== false && typeof raw.createdAt === "string"
        ? raw.createdAt
        : meta.createdAt,
    updatedAt:
      options.preserveRawDates !== false && typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : meta.updatedAt
  }
}

function ccHook(
  event: HookConfig["event"],
  matcher: string | undefined,
  raw: Record<string, unknown>,
  id: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string }
): HookConfig | null {
  const type =
    typeof raw.type === "string"
      ? raw.type
      : typeof raw.prompt === "string"
        ? "prompt"
        : "command"
  if (type !== "command" && type !== "prompt" && type !== "http") return null
  if (type === "command" && typeof raw.command !== "string") return null
  if (type === "prompt" && typeof raw.prompt !== "string") return null
  if (type === "http" && typeof raw.url !== "string") return null
  return {
    id,
    event,
    matcher,
    if: normalizeOptionalHookString(raw.if),
    type,
    command: typeof raw.command === "string" ? raw.command : undefined,
    shell: parseHookShell(raw.shell),
    url: typeof raw.url === "string" ? raw.url : undefined,
    headers: parseHookHeaders(raw.headers),
    allowedEnvVars: parseHookStringArray(raw.allowedEnvVars),
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    model:
      typeof raw.model === "string"
        ? raw.model
        : typeof raw.modelId === "string"
          ? raw.modelId
          : undefined,
    fallback: type === "prompt" || type === "http" ? (raw.fallback === "block" ? "block" : "allow") : undefined,
    statusMessage: normalizeOptionalHookString(raw.statusMessage),
    onBlock: parseHookOnBlock(raw.onBlock),
    forcedOutcome: parseForcedOutcome(raw.forcedOutcome),
    forcedReason: normalizeOptionalHookString(raw.forcedReason),
    once: parseOptionalHookBoolean(raw.once),
    persistAfterInterrupt: parseOptionalHookBoolean(raw.persistAfterInterrupt),
    injectUserContext: parseHookInjectUserContext(raw.injectUserContext),
    timeout: parseClaudeHookTimeoutMs(raw),
    async: raw.async === true ? true : undefined,
    enabled: raw.enabled !== false && meta.enabled,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt
  }
}

function expandCcHooks(
  settings: Record<string, unknown>,
  idPrefix: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string },
  defaultSkillMatcher?: string
): HookConfig[] {
  const result: HookConfig[] = []
  for (const [eventKey, matcherRows] of Object.entries(settings)) {
    if (!CC_HOOK_EVENTS.has(eventKey) || !Array.isArray(matcherRows) || !isSupportedHookEvent(eventKey)) {
      continue
    }
    for (let matcherIndex = 0; matcherIndex < matcherRows.length; matcherIndex += 1) {
      const matcherRow = matcherRows[matcherIndex]
      if (!isRecord(matcherRow)) continue
      const matcher =
        typeof matcherRow.matcher === "string"
          ? matcherRow.matcher
          : eventKey === "PreSkillUse" || eventKey === "PostSkillUse"
            ? defaultSkillMatcher
            : undefined
      const hooks = Array.isArray(matcherRow.hooks) ? matcherRow.hooks : []
      for (let hookIndex = 0; hookIndex < hooks.length && hookIndex < MAX_HOOKS_PER_FILE; hookIndex += 1) {
        const raw = hooks[hookIndex]
        if (!isRecord(raw)) continue
        const rawId = normalizeOptionalHookString(raw.id)
        const hook = ccHook(
          eventKey,
          matcher,
          raw,
          rawId
            ? `${idPrefix}/${eventKey}:${rawId}`
            : `${idPrefix}/${eventKey}:${matcherIndex}:${hookIndex}`,
          meta
        )
        if (hook) result.push(hook)
      }
    }
  }
  return result
}

function parseHookDocument(
  parsed: unknown,
  idPrefix: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string },
  options: {
    requireNativeId?: boolean
    nativeId?: (raw: Record<string, unknown>, index: number) => string
    defaultSkillMatcher?: string
    nativeFallbackForCommand?: boolean
    preserveNativeDates?: boolean
  } = {}
): HookConfig[] {
  const format = detectHooksFileFormat(parsed)
  if (format === "cc_plugin") {
    return expandCcHooks(
      (parsed as Record<string, unknown>).hooks as Record<string, unknown>,
      idPrefix,
      meta,
      options.defaultSkillMatcher
    )
  }
  if (format === "cc_settings") {
    return expandCcHooks(
      parsed as Record<string, unknown>,
      idPrefix,
      meta,
      options.defaultSkillMatcher
    )
  }
  if (format !== "flat") return []
  const result: HookConfig[] = []
  const rows = parsed as unknown[]
  for (let index = 0; index < rows.length && index < MAX_HOOKS_PER_FILE; index += 1) {
    const raw = rows[index]
    if (!isRecord(raw)) continue
    if (options.requireNativeId && typeof raw.id !== "string") continue
    const id = options.nativeId?.(raw, index) ?? (typeof raw.id === "string" ? raw.id : `${idPrefix}/${index}`)
    const hook = nativeHook(raw, id, meta, {
      defaultSkillMatcher: options.defaultSkillMatcher,
      fallbackForCommand: options.nativeFallbackForCommand,
      preserveRawDates: options.preserveNativeDates
    })
    if (hook) result.push(hook)
  }
  return result
}

function readBoundedText(
  path: string,
  maxBytes: number,
  context: BuildContext,
  options: { allowPrefix?: boolean; reason: string }
): string | null {
  checkCancelled(context)
  if (!existsSync(path)) return null
  if (context.stats.scannedFiles >= HOOK_CATALOG_MAX_FILES) {
    markTruncated(context, "file-count")
    return null
  }
  context.stats.scannedFiles += 1
  let size: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    size = stats.size
  } catch {
    return null
  }
  if (context.stats.readBytes >= HOOK_CATALOG_MAX_TOTAL_READ_BYTES) {
    markTruncated(context, "total-read-bytes")
    return null
  }
  if (size > maxBytes) {
    markTruncated(context, options.reason)
    if (!options.allowPrefix) return null
  }
  const remainingReadBytes = HOOK_CATALOG_MAX_TOTAL_READ_BYTES - context.stats.readBytes
  const allowed = Math.min(
    size,
    maxBytes,
    remainingReadBytes
  )
  if (remainingReadBytes < Math.min(size, maxBytes)) {
    markTruncated(context, "total-read-bytes")
  }
  if (allowed <= 0) return null
  const buffer = Buffer.allocUnsafe(allowed)
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, "r")
    const bytesRead = readSync(descriptor, buffer, 0, allowed, 0)
    context.stats.readBytes += bytesRead
    return buffer.subarray(0, bytesRead).toString("utf8")
  } catch {
    return null
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function readJson(
  path: string,
  maxBytes: number,
  context: BuildContext,
  reason: string
): unknown {
  const text = readBoundedText(path, maxBytes, context, { reason })
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function boundedHeaders(
  context: BuildContext,
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!value) return undefined
  const result: Record<string, string> = {}
  const rows = Object.entries(value)
  if (rows.length > 32) markTruncated(context, "hook-field-bytes")
  for (const [key, entry] of rows.slice(0, 32)) {
    result[safeSlice(key, 256)] = safeSlice(entry, 2_048)
    if (key.length > 256 || entry.length > 2_048) markTruncated(context, "hook-field-bytes")
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function projectHook(context: BuildContext, hook: HookConfig): HookConfig | null {
  if (hook.id.length > MAX_ID_TEXT) {
    markTruncated(context, "oversized-hook-id")
    return null
  }
  const array = hook.allowedEnvVars
  if (array && array.length > 64) markTruncated(context, "hook-field-bytes")
  const onBlock = hook.onBlock
    ? {
        reason: boundedString(context, hook.onBlock.reason, 2_048),
        systemMessage: boundedString(context, hook.onBlock.systemMessage, 2_048),
        additionalContext: boundedString(context, hook.onBlock.additionalContext, 2_048),
        requiredSkill: boundedString(context, hook.onBlock.requiredSkill, 1_024)
      }
    : undefined
  return {
    ...hook,
    id: hook.id,
    matcher: boundedString(context, hook.matcher, 2_048),
    if: boundedString(context, hook.if, 2_048),
    command: boundedString(context, hook.command),
    url: boundedString(context, hook.url),
    headers: boundedHeaders(context, hook.headers),
    allowedEnvVars: array?.slice(0, 64).map((entry) => safeSlice(entry, 256)),
    prompt: boundedString(context, hook.prompt),
    model: boundedString(context, hook.model, 512),
    modelId: boundedString(context, hook.modelId, 512),
    statusMessage: boundedString(context, hook.statusMessage, 2_048),
    onBlock,
    forcedReason: boundedString(context, hook.forcedReason, 2_048),
    createdAt: safeSlice(hook.createdAt, 128),
    updatedAt: safeSlice(hook.updatedAt, 128),
    hookSourceRoot: boundedString(context, hook.hookSourceRoot, MAX_PATH_TEXT),
    hookSourcePath: boundedString(context, hook.hookSourcePath, MAX_PATH_TEXT),
    pluginRoot: boundedString(context, hook.pluginRoot, MAX_PATH_TEXT)
  }
}

function pushEntry(context: BuildContext, entry: Entry): void {
  checkCancelled(context)
  if (context.retentionExhausted) return
  if (context.entries.length >= context.entryLimit) {
    markTruncated(context, "entry-count")
    context.retentionExhausted = true
    return
  }
  const projected = projectHook(context, entry.hook)
  if (!projected) return
  let projectedEntry: Entry
  if (entry.source === "global" || entry.source === "workspace") {
    projectedEntry =
      entry.source === "global"
        ? { source: "global", hook: projected }
        : { source: "workspace", hook: projected }
  } else if (entry.source === "plugin") {
    const hook = entry.hook
    projectedEntry = {
      source: "plugin",
      hook: {
        ...projected,
        pluginId: safeSlice(hook.pluginId, 1_024),
        pluginName: safeSlice(hook.pluginName, 1_024),
        pluginRoot: safeSlice(hook.pluginRoot, MAX_PATH_TEXT),
        pluginEnabled: hook.pluginEnabled,
        hookPath: safeSlice(hook.hookPath, MAX_PATH_TEXT)
      }
    }
  } else {
    const hook = entry.hook
    projectedEntry = {
      source: "skill",
      hook: {
        ...projected,
        skillName: safeSlice(hook.skillName, 1_024),
        skillPath: safeSlice(hook.skillPath, MAX_PATH_TEXT),
        skillRoot: safeSlice(hook.skillRoot, MAX_PATH_TEXT),
        hookPath: safeSlice(hook.hookPath, MAX_PATH_TEXT),
        ...(hook.pluginId ? { pluginId: safeSlice(hook.pluginId, 1_024) } : {}),
        ...(hook.pluginName ? { pluginName: safeSlice(hook.pluginName, 1_024) } : {}),
        ...(hook.pluginRoot ? { pluginRoot: safeSlice(hook.pluginRoot, MAX_PATH_TEXT) } : {})
      }
    }
  }
  const projectedBytes = Buffer.byteLength(JSON.stringify(projectedEntry), "utf8") + 16
  if (context.snapshotBytes + projectedBytes > context.snapshotByteLimit) {
    markTruncated(context, "snapshot-bytes")
    context.retentionExhausted = true
    return
  }
  context.entries.push(projectedEntry)
  context.snapshotBytes += projectedBytes
}

function parsePlugins(source: HookCatalogSourceConfig, context: BuildContext): PluginMetadata[] {
  const parsed = readJson(source.pluginsStorePath, HOOK_CATALOG_MAX_STORE_BYTES, context, "plugins-store-bytes")
  if (!Array.isArray(parsed)) return []
  if (parsed.length > MAX_PLUGINS) markTruncated(context, "plugin-count")
  return parsed.slice(0, MAX_PLUGINS).filter(
    (row): row is PluginMetadata =>
      isRecord(row) &&
      typeof row.id === "string" &&
      typeof row.name === "string" &&
      typeof row.path === "string"
  )
}

function parseGlobalHooks(source: HookCatalogSourceConfig, context: BuildContext): void {
  const parsed = readJson(source.globalHooksPath, HOOK_CATALOG_MAX_FILE_BYTES, context, "global-hook-file-bytes")
  if (parsed === null) return
  for (const hook of parseHookDocument(parsed, "global", {
    enabled: true,
    ...fileHookDates(source.globalHooksPath)
  }, {
    requireNativeId: true
  })) {
    pushEntry(context, { source: "global", hook })
  }
}

function safePluginPath(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) return null
  const target = resolve(root, relativePath)
  const rel = relative(resolve(root), target)
  return rel.startsWith("..") || isAbsolute(rel) ? null : target
}

function parsePluginHooks(plugins: PluginMetadata[], context: BuildContext): void {
  for (const plugin of plugins) {
    checkCancelled(context)
    if (context.retentionExhausted) break
    if (!plugin.enabled || (plugin.hookCount ?? 0) <= 0) continue
    const relativePath = plugin.hookPath ?? DEFAULT_PLUGIN_HOOKS_PATH
    const path = safePluginPath(plugin.path, relativePath)
    if (!path) {
      markTruncated(context, "invalid-plugin-hook-path")
      continue
    }
    const parsed = readJson(path, HOOK_CATALOG_MAX_FILE_BYTES, context, "plugin-hook-file-bytes")
    if (parsed === null) continue
    const meta = { enabled: plugin.enabled, ...fileHookDates(path) }
    for (const hook of parseHookDocument(parsed, `plugin:${plugin.id}`, meta, {
      nativeId: (raw, index) => `plugin:${plugin.id}/${typeof raw.id === "string" ? raw.id : index}`,
      nativeFallbackForCommand: true,
      preserveNativeDates: false
    })) {
      pushEntry(context, {
        source: "plugin",
        hook: {
          ...hook,
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginRoot: plugin.path,
          pluginEnabled: plugin.enabled,
          hookPath: relativePath,
          hookSourceType: "plugin",
          hookSourceRoot: plugin.path,
          hookSourcePath: path
        }
      })
    }
  }
}

function readPluginManifest(pluginRoot: string, context: BuildContext): Record<string, unknown> | null {
  for (const relPath of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
    const parsed = readJson(join(pluginRoot, relPath), HOOK_CATALOG_MAX_FILE_BYTES, context, "plugin-manifest-bytes")
    if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim()) return parsed
  }
  return null
}

function normalizePluginRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) return null
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "")
  if (!normalized || normalized === ".") return "."
  return normalized.split("/").some((part) => !part || part === "." || part === "..")
    ? null
    : normalized
}

function pluginSkillSources(plugin: PluginMetadata, context: BuildContext): SkillSource[] {
  if (!plugin.enabled) return []
  const result: SkillSource[] = []
  const seen = new Set<string>()
  const add = (relativePath: string, maxDepth?: number): void => {
    if (context.pluginSkillSourceProbes >= MAX_PLUGIN_SKILL_SOURCE_PROBES) {
      markTruncated(context, "plugin-skill-source-count")
      return
    }
    context.pluginSkillSourceProbes += 1
    if (result.length >= MAX_PLUGIN_SKILL_SOURCES) {
      markTruncated(context, "plugin-skill-source-count")
      return
    }
    const normalized = normalizePluginRelativePath(relativePath)
    if (!normalized) return
    const path = safePluginPath(plugin.path, normalized)
    if (!path || !existsSync(path)) return
    const key = process.platform === "win32" ? path.toLowerCase() : path
    if (seen.has(key)) return
    seen.add(key)
    result.push({
      sourceDir: path,
      maxDepth,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginRoot: plugin.path,
      respectDisabled: false
    })
  }
  const manifest = readPluginManifest(plugin.path, context)
  const rawSkills = manifest?.skills
  const declared = typeof rawSkills === "string" ? [rawSkills] : Array.isArray(rawSkills) ? rawSkills : []
  if (declared.length > MAX_PLUGIN_SKILL_SOURCES) {
    markTruncated(context, "plugin-skill-source-count")
  }
  for (const value of declared.slice(0, MAX_PLUGIN_SKILL_SOURCES)) {
    if (typeof value === "string") add(value)
  }
  const hasRootSkill = existsSync(join(plugin.path, "SKILL.md"))
  const hasSkillsDir = existsSync(join(plugin.path, "skills"))
  if (hasRootSkill) add(".", hasSkillsDir ? 0 : undefined)
  if (hasSkillsDir) add("skills")
  return result
}

function sortedDirectories(entries: Dirent[]): Dirent[] {
  return entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
}

function discoverSkills(source: SkillSource, context: BuildContext): CatalogDiscoveredSkill[] {
  const result: CatalogDiscoveredSkill[] = []
  const maxDepth = source.maxDepth ?? 3
  const stack: Array<{ path: string; depth: number }> = [{ path: source.sourceDir, depth: 0 }]
  while (stack.length > 0) {
    checkCancelled(context)
    if (context.stats.scannedDirectories >= HOOK_CATALOG_MAX_DIRECTORIES) {
      markTruncated(context, "directory-count")
      break
    }
    if (context.stats.discoveredSkills >= HOOK_CATALOG_MAX_SKILLS) {
      markTruncated(context, "skill-count")
      break
    }
    const current = stack.pop()!
    context.stats.scannedDirectories += 1
    const skillMdPath = join(current.path, "SKILL.md")
    const content = readBoundedText(skillMdPath, HOOK_CATALOG_MAX_SKILL_MD_BYTES, context, {
      allowPrefix: true,
      reason: "skill-md-bytes"
    })
    if (content !== null) {
      const relativePath = relative(source.sourceDir, current.path).replace(/\\/g, "/")
      result.push({
        name: parseSkillNameFromFrontmatterYaml(content) || basename(current.path),
        sourceDir: source.sourceDir,
        rootDir: current.path,
        skillMdPath,
        relativePath,
        depth: current.depth,
        content
      })
      context.stats.discoveredSkills += 1
    }
    if (current.depth >= maxDepth) continue
    let entries: Dirent[]
    try {
      entries = sortedDirectories(readdirSync(current.path, { withFileTypes: true }))
    } catch {
      continue
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push({ path: join(current.path, entries[index].name), depth: current.depth + 1 })
    }
  }
  return result
}

function disabledSkillIds(
  source: HookCatalogSourceConfig,
  globalSkills: CatalogDiscoveredSkill[],
  context: BuildContext
): Set<string> {
  const parsed = readJson(source.disabledSkillsPath, HOOK_CATALOG_MAX_FILE_BYTES, context, "disabled-skills-bytes")
  const entries = Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : []
  return new Set(resolveDisabledSkillIds(entries, globalSkills))
}

function isDiscoveredSkillIdDisabled(
  skill: CatalogDiscoveredSkill,
  disabledIds: ReadonlySet<string>
): boolean {
  const id = getDiscoveredSkillId(skill)
  if (!id) return false
  let separator = id.indexOf("/")
  while (separator >= 0) {
    if (disabledIds.has(id.slice(0, separator))) return true
    separator = id.indexOf("/", separator + 1)
  }
  return disabledIds.has(id)
}

function skillFrontmatterHooks(
  skill: CatalogDiscoveredSkill,
  content: string,
  dates: Pick<HookConfig, "createdAt" | "updatedAt">
): HookConfig[] {
  const hooksRaw = parseSkillFrontmatter(content).frontmatter.hooks
  if (!isRecord(hooksRaw)) return []
  const format = detectHooksFileFormat(hooksRaw)
  if (format !== "cc_plugin" && format !== "cc_settings") return []
  return parseHookDocument(
    hooksRaw,
    `skill:${skill.name}/SKILL.md`,
    { enabled: true, ...dates },
    { defaultSkillMatcher: skill.name }
  )
}

function parseSkillHooks(
  skill: CatalogDiscoveredSkill,
  source: SkillSource,
  context: BuildContext
): void {
  const add = (hookPath: string, hooks: HookConfig[]): void => {
    for (const hook of hooks) {
      pushEntry(context, {
        source: "skill",
        hook: {
          ...hook,
          skillName: skill.name,
          skillPath: skill.rootDir,
          skillRoot: skill.rootDir,
          hookPath,
          ...(source.pluginId ? { pluginId: source.pluginId } : {}),
          ...(source.pluginName ? { pluginName: source.pluginName } : {}),
          ...(source.pluginRoot ? { pluginRoot: source.pluginRoot } : {}),
          hookSourceType: "skill",
          hookSourceRoot: skill.rootDir,
          hookSourcePath: hookPath
        }
      })
    }
  }
  add(
    skill.skillMdPath,
    skillFrontmatterHooks(skill, skill.content, fileHookDates(skill.skillMdPath))
  )

  for (const relativePath of SKILL_HOOK_FILES) {
    const path = join(skill.rootDir, relativePath)
    const parsed = readJson(path, HOOK_CATALOG_MAX_FILE_BYTES, context, "skill-hook-file-bytes")
    if (parsed === null) continue
    const idPrefix = relativePath === "hooks.json"
      ? `skill:${skill.name}`
      : `skill:${skill.name}/${relativePath}`
    add(
      path,
      parseHookDocument(parsed, idPrefix, { enabled: true, ...fileHookDates(path) }, {
        defaultSkillMatcher: skill.name,
        nativeFallbackForCommand: true,
        preserveNativeDates: false,
        nativeId: (raw, index) => {
          const id = typeof raw.id === "string" ? raw.id : String(index)
          const prefix = relativePath === "hooks.json" ? "" : `${relativePath}:`
          return `skill:${skill.name}/${prefix}${id}`
        }
      })
    )
  }
}

function parseAllSkillHooks(
  source: HookCatalogSourceConfig,
  plugins: PluginMetadata[],
  context: BuildContext
): Pick<HookCatalogPage["relatedSummary"], "skillEntries" | "enabledSkillEntries"> {
  const globalSources: SkillSource[] = source.skillSourceDirs.slice(0, 16).map((sourceDir) => ({
    sourceDir,
    respectDisabled: true
  }))
  if (source.skillSourceDirs.length > globalSources.length) markTruncated(context, "skill-source-count")
  const globalDiscovered = globalSources.map((skillSource) => ({
    source: skillSource,
    skills: discoverSkills(skillSource, context)
  }))
  const disabled = disabledSkillIds(
    source,
    globalDiscovered.flatMap((entry) => entry.skills),
    context
  )
  const localSkillsById = new Map<string, CatalogDiscoveredSkill>()
  for (const { skills } of globalDiscovered) {
    for (const skill of skills) {
      const id = getDiscoveredSkillId(skill)
      if (id) localSkillsById.set(id, skill)
    }
  }
  const pluginSkillIds = new Set<string>()
  const seen = new Set<string>()
  for (const { source: skillSource, skills } of globalDiscovered) {
    for (const skill of skills) {
      checkCancelled(context)
      if (isDiscoveredSkillIdDisabled(skill, disabled)) continue
      const key = process.platform === "win32" ? skill.rootDir.toLowerCase() : skill.rootDir
      if (seen.has(key)) continue
      seen.add(key)
      if (!context.retentionExhausted) parseSkillHooks(skill, skillSource, context)
    }
  }
  // Process plugin sources one plugin at a time. Materializing every declared
  // source first can create hundreds of thousands of objects before the
  // directory/file limits have a chance to stop a hostile catalog.
  for (const plugin of plugins) {
    if (context.pluginSkillSourceProbes >= MAX_PLUGIN_SKILL_SOURCE_PROBES) {
      markTruncated(context, "plugin-skill-source-count")
      break
    }
    for (const skillSource of pluginSkillSources(plugin, context)) {
      for (const skill of discoverSkills(skillSource, context)) {
        checkCancelled(context)
        const id = getDiscoveredSkillId(skill)
        if (id && skillSource.pluginId) {
          pluginSkillIds.add(`${skillSource.pluginId}:${id}`)
        }
        const key = process.platform === "win32" ? skill.rootDir.toLowerCase() : skill.rootDir
        if (seen.has(key)) continue
        seen.add(key)
        if (!context.retentionExhausted) parseSkillHooks(skill, skillSource, context)
      }
    }
  }
  const enabledLocalSkills = [...localSkillsById.values()].reduce(
    (count, skill) => count + Number(!isDiscoveredSkillIdDisabled(skill, disabled)),
    0
  )
  return {
    skillEntries: localSkillsById.size + pluginSkillIds.size,
    // Disabled standalone ids never suppress a plugin-owned same-name skill.
    enabledSkillEntries: enabledLocalSkills + pluginSkillIds.size
  }
}

function parseWorkspaceHooks(source: HookCatalogSourceConfig, context: BuildContext): void {
  if (!source.workspacePath) return
  const directory = join(source.workspacePath, WORKSPACE_HOOKS_DIR)
  let files: string[]
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
  } catch {
    return
  }
  for (const file of files) {
    checkCancelled(context)
    if (context.retentionExhausted) break
    const path = join(directory, file)
    const parsed = readJson(path, HOOK_CATALOG_MAX_FILE_BYTES, context, "workspace-hook-file-bytes")
    if (parsed === null) continue
    const base = file.replace(/\.json$/, "")
    const dates = fileHookDates(path)
    const format = detectHooksFileFormat(parsed)
    let hooks: HookConfig[] = []
    if (format === "cc_plugin" || format === "cc_settings") {
      hooks = parseHookDocument(parsed, `ws:${base}`, {
        enabled: true,
        ...dates
      })
    } else if (isRecord(parsed) && isSupportedHookEvent(parsed.event)) {
      const type =
        parsed.type === "prompt" || parsed.type === "command" || parsed.type === "http"
          ? parsed.type
          : typeof parsed.url === "string"
            ? "http"
            : typeof parsed.prompt === "string"
              ? "prompt"
              : typeof parsed.command === "string"
                ? "command"
                : null
      if (type && parsed.enabled !== false) {
        const hook = nativeHook(
          { ...parsed, type },
          `ws:${base}`,
          { enabled: true, ...dates },
          { fallbackForCommand: true, preserveRawDates: false }
        )
        if (hook) hooks = [hook]
      }
    }
    for (const hook of hooks) {
      pushEntry(context, {
        source: "workspace",
        hook: {
          ...hook,
          hookSourceType: "workspace",
          hookSourceRoot: source.workspacePath,
          hookSourcePath: path
        }
      })
    }
  }
}

function normalizedCachePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function globalSnapshotSourceKey(source: HookCatalogSourceConfig): string {
  return JSON.stringify([
    normalizedCachePath(source.openworkDir),
    normalizedCachePath(source.globalHooksPath),
    normalizedCachePath(source.pluginsStorePath),
    normalizedCachePath(source.disabledSkillsPath),
    source.skillSourceDirs.map(normalizedCachePath)
  ])
}

const SKILL_SUMMARY_TRUNCATION_REASONS = new Set([
  "directory-count",
  "disabled-skill-count",
  "disabled-skills-bytes",
  "file-count",
  "plugin-count",
  "plugin-manifest-bytes",
  "plugin-skill-source-count",
  "plugins-store-bytes",
  "skill-count",
  "skill-md-bytes",
  "skill-source-count",
  "total-read-bytes"
])
const PLUGIN_SUMMARY_TRUNCATION_REASONS = new Set([
  "file-count",
  "plugin-count",
  "plugins-store-bytes",
  "total-read-bytes"
])

function relatedTruncationReasons(
  reasons: ReadonlySet<string>,
  allowed: ReadonlySet<string>
): string[] {
  return [...reasons].filter((reason) => allowed.has(reason))
}

function buildGlobalSnapshot(
  source: HookCatalogSourceConfig,
  cancelFlag?: Int32Array
): CatalogSnapshotBuild<GlobalCatalogSnapshot> {
  trimExpiredSnapshots()
  const sourceKey = globalSnapshotSourceKey(source)
  const key = JSON.stringify([sourceKey, source.globalRevision])
  const cachedId = globalSnapshotIdByKey.get(key)
  const cached = cachedId ? globalSnapshots.get(cachedId) : undefined
  if (cached && cached.expiresAt > Date.now()) {
    return { snapshot: cached, reused: true, durationMs: 0 }
  }
  const previousId = latestGlobalSnapshotIdBySource.get(sourceKey)
  if (previousId) deleteGlobalSnapshot(previousId)
  reserveGlobalSnapshotSlot()

  const startedAt = performance.now()
  const context: BuildContext = {
    cancelFlag,
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 },
    truncatedReasons: new Set<string>(),
    entries: [],
    entryLimit: HOOK_CATALOG_MAX_ENTRIES,
    snapshotBytes: 0,
    snapshotByteLimit: HOOK_CATALOG_MAX_SNAPSHOT_BYTES,
    retentionExhausted: false,
    pluginSkillSourceProbes: 0
  }
  parseGlobalHooks(source, context)
  const globalHookEntries = context.entries.length
  const plugins = parsePlugins(source, context)
  parsePluginHooks(plugins, context)
  const skillSummary = parseAllSkillHooks(source, plugins, context)
  checkCancelled(context)
  const skillTruncatedReasons = relatedTruncationReasons(
    context.truncatedReasons,
    SKILL_SUMMARY_TRUNCATION_REASONS
  )
  const pluginTruncatedReasons = relatedTruncationReasons(
    context.truncatedReasons,
    PLUGIN_SUMMARY_TRUNCATION_REASONS
  )
  const snapshot: GlobalCatalogSnapshot = {
    id: `g-${nextSnapshotId++}`,
    key,
    sourceKey,
    entries: context.entries,
    globalHookEntries,
    enabledEntries: context.entries.reduce(
      (count, entry) => count + Number(entry.hook.enabled),
      0
    ),
    relatedSummary: {
      ...skillSummary,
      skillTruncated: skillTruncatedReasons.length > 0,
      skillTruncatedReasons,
      pluginEntries: plugins.length,
      pluginTruncated: pluginTruncatedReasons.length > 0,
      pluginTruncatedReasons
    },
    truncated: context.truncatedReasons.size > 0,
    truncatedReasons: [...context.truncatedReasons],
    stats: { ...context.stats },
    expiresAt: Date.now() + SNAPSHOT_TTL_MS
  }
  globalSnapshots.set(snapshot.id, snapshot)
  globalSnapshotIdByKey.set(key, snapshot.id)
  latestGlobalSnapshotIdBySource.set(sourceKey, snapshot.id)
  return { snapshot, reused: false, durationMs: performance.now() - startedAt }
}

function workspaceSnapshotSourceKey(source: HookCatalogSourceConfig): string | null {
  return source.workspacePath ? normalizedCachePath(source.workspacePath) : null
}

function buildWorkspaceSnapshot(
  source: HookCatalogSourceConfig,
  cancelFlag?: Int32Array
): CatalogSnapshotBuild<WorkspaceCatalogSnapshot | null> {
  const sourceKey = workspaceSnapshotSourceKey(source)
  if (!sourceKey) return { snapshot: null, reused: true, durationMs: 0 }
  trimExpiredSnapshots()
  const key = JSON.stringify([sourceKey, source.workspaceRevision])
  const cachedId = workspaceSnapshotIdByKey.get(key)
  const cached = cachedId ? workspaceSnapshots.get(cachedId) : undefined
  if (cached && cached.expiresAt > Date.now()) {
    return { snapshot: cached, reused: true, durationMs: 0 }
  }
  const previousId = latestWorkspaceSnapshotIdBySource.get(sourceKey)
  if (previousId) deleteWorkspaceSnapshot(previousId)
  reserveWorkspaceSnapshotSlot()

  const startedAt = performance.now()
  const context: BuildContext = {
    cancelFlag,
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 },
    truncatedReasons: new Set<string>(),
    entries: [],
    entryLimit: MAX_WORKSPACE_ENTRIES,
    snapshotBytes: 0,
    snapshotByteLimit: HOOK_CATALOG_MAX_WORKSPACE_SNAPSHOT_BYTES,
    retentionExhausted: false,
    pluginSkillSourceProbes: 0
  }
  parseWorkspaceHooks(source, context)
  checkCancelled(context)
  const snapshot: WorkspaceCatalogSnapshot = {
    id: `w-${nextSnapshotId++}`,
    key,
    sourceKey,
    entries: context.entries,
    enabledEntries: context.entries.reduce(
      (count, entry) => count + Number(entry.hook.enabled),
      0
    ),
    truncated: context.truncatedReasons.size > 0,
    truncatedReasons: [...context.truncatedReasons],
    stats: { ...context.stats },
    expiresAt: Date.now() + SNAPSHOT_TTL_MS
  }
  workspaceSnapshots.set(snapshot.id, snapshot)
  workspaceSnapshotIdByKey.set(key, snapshot.id)
  latestWorkspaceSnapshotIdBySource.set(sourceKey, snapshot.id)
  return { snapshot, reused: false, durationMs: performance.now() - startedAt }
}

interface ParsedCursor {
  globalSnapshotId: string
  workspaceSnapshotId: string | null
  offset: number
}

function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null
  const separator = cursor.lastIndexOf(":")
  if (separator <= 0) throw new HookCatalogCursorExpiredError()
  const ids = cursor.slice(0, separator).split(".")
  if (ids.length !== 2 || !ids[0].startsWith("g-")) {
    throw new HookCatalogCursorExpiredError()
  }
  const offset = Number(cursor.slice(separator + 1))
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HookCatalogCursorExpiredError()
  return {
    globalSnapshotId: ids[0],
    workspaceSnapshotId: ids[1] === "none" ? null : ids[1],
    offset
  }
}

function cursorValue(
  globalSnapshot: GlobalCatalogSnapshot,
  workspaceSnapshot: WorkspaceCatalogSnapshot | null,
  offset: number
): string {
  return `${globalSnapshot.id}.${workspaceSnapshot?.id ?? "none"}:${offset}`
}

function virtualEntryAt(
  globalSnapshot: GlobalCatalogSnapshot,
  workspaceSnapshot: WorkspaceCatalogSnapshot | null,
  index: number
): Entry | undefined {
  if (index < globalSnapshot.globalHookEntries) return globalSnapshot.entries[index]
  const workspaceOffset = index - globalSnapshot.globalHookEntries
  const workspaceEntries = workspaceSnapshot?.entries ?? []
  if (workspaceOffset < workspaceEntries.length) return workspaceEntries[workspaceOffset]
  return globalSnapshot.entries[index - workspaceEntries.length]
}

function retainedEntryCount(
  globalSnapshot: GlobalCatalogSnapshot,
  workspaceSnapshot: WorkspaceCatalogSnapshot | null
): number {
  return Math.min(
    HOOK_CATALOG_MAX_ENTRIES,
    globalSnapshot.entries.length + (workspaceSnapshot?.entries.length ?? 0)
  )
}

function retainedEnabledEntryCount(
  globalSnapshot: GlobalCatalogSnapshot,
  workspaceSnapshot: WorkspaceCatalogSnapshot | null,
  totalEntries: number
): number {
  const sourceEntryCount =
    globalSnapshot.entries.length + (workspaceSnapshot?.entries.length ?? 0)
  if (totalEntries === sourceEntryCount) {
    return globalSnapshot.enabledEntries + (workspaceSnapshot?.enabledEntries ?? 0)
  }
  let enabled = 0
  for (let index = 0; index < totalEntries; index += 1) {
    enabled += Number(virtualEntryAt(globalSnapshot, workspaceSnapshot, index)?.hook.enabled)
  }
  return enabled
}

function appendEntry(page: HookCatalogPage, entry: Entry): void {
  if (entry.source === "global") page.globalHooks.push(entry.hook)
  else if (entry.source === "workspace") page.workspaceHooks.push(entry.hook)
  else if (entry.source === "plugin") page.pluginHooks.push(entry.hook)
  else page.skillHooks.push(entry.hook)
}

function responseBytes(page: HookCatalogPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8")
}

export function readHookCatalogPage(
  source: HookCatalogSourceConfig,
  input: HookCatalogPageInput,
  cancelFlag?: Int32Array
): HookCatalogPage {
  const cursor = parseCursor(input.cursor)
  trimExpiredSnapshots()
  let globalBuild: CatalogSnapshotBuild<GlobalCatalogSnapshot>
  let workspaceBuild: CatalogSnapshotBuild<WorkspaceCatalogSnapshot | null>
  if (cursor) {
    const globalSnapshot = globalSnapshots.get(cursor.globalSnapshotId)
    const workspaceSnapshot = cursor.workspaceSnapshotId
      ? workspaceSnapshots.get(cursor.workspaceSnapshotId)
      : null
    if (!globalSnapshot || (cursor.workspaceSnapshotId && !workspaceSnapshot)) {
      throw new HookCatalogCursorExpiredError()
    }
    globalBuild = { snapshot: globalSnapshot, reused: true, durationMs: 0 }
    workspaceBuild = { snapshot: workspaceSnapshot ?? null, reused: true, durationMs: 0 }
  } else {
    globalBuild = buildGlobalSnapshot(source, cancelFlag)
    workspaceBuild = buildWorkspaceSnapshot(source, cancelFlag)
  }
  const globalSnapshot = globalBuild.snapshot
  const workspaceSnapshot = workspaceBuild.snapshot
  const offset = cursor?.offset ?? 0
  const totalEntries = retainedEntryCount(globalSnapshot, workspaceSnapshot)
  if (offset > totalEntries) throw new HookCatalogCursorExpiredError()
  const limit = Number.isFinite(input.limit)
    ? Math.min(HOOK_CATALOG_MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit!)))
    : HOOK_CATALOG_DEFAULT_PAGE_SIZE
  const page: HookCatalogPage = {
    globalHooks: [],
    workspaceHooks: [],
    pluginHooks: [],
    skillHooks: [],
    totalEntries,
    enabledEntries: retainedEnabledEntryCount(globalSnapshot, workspaceSnapshot, totalEntries),
    relatedSummary: { ...globalSnapshot.relatedSummary },
    truncated:
      globalSnapshot.truncated ||
      Boolean(workspaceSnapshot?.truncated) ||
      globalSnapshot.entries.length + (workspaceSnapshot?.entries.length ?? 0) > totalEntries,
    truncatedReasons: [
      ...new Set([
        ...globalSnapshot.truncatedReasons,
        ...(workspaceSnapshot?.truncatedReasons ?? []),
        ...(globalSnapshot.entries.length + (workspaceSnapshot?.entries.length ?? 0) > totalEntries
          ? ["entry-count"]
          : [])
      ])
    ],
    stats: {
      durationMs: globalBuild.durationMs + workspaceBuild.durationMs,
      responseBytes: 0,
      globalScanReused: globalBuild.reused,
      workspaceScanReused: workspaceBuild.reused,
      scannedDirectories:
        globalSnapshot.stats.scannedDirectories +
        (workspaceSnapshot?.stats.scannedDirectories ?? 0),
      scannedFiles:
        globalSnapshot.stats.scannedFiles + (workspaceSnapshot?.stats.scannedFiles ?? 0),
      discoveredSkills: globalSnapshot.stats.discoveredSkills,
      readBytes: globalSnapshot.stats.readBytes + (workspaceSnapshot?.stats.readBytes ?? 0)
    }
  }
  let consumed = 0
  for (let index = offset; index < totalEntries && consumed < limit; index += 1) {
    if (cancelFlag && Atomics.load(cancelFlag, 0) !== 0) throw new HookCatalogCancelledError()
    const entry = virtualEntryAt(globalSnapshot, workspaceSnapshot, index)
    if (!entry) throw new HookCatalogCursorExpiredError()
    appendEntry(page, entry)
    consumed += 1
    const nextOffset = offset + consumed
    page.nextCursor = nextOffset < totalEntries
      ? cursorValue(globalSnapshot, workspaceSnapshot, nextOffset)
      : undefined
    if (responseBytes(page) > HOOK_CATALOG_MAX_RESPONSE_BYTES - 1_024) {
      if (entry.source === "global") page.globalHooks.pop()
      else if (entry.source === "workspace") page.workspaceHooks.pop()
      else if (entry.source === "plugin") page.pluginHooks.pop()
      else page.skillHooks.pop()
      consumed -= 1
      page.nextCursor = cursorValue(globalSnapshot, workspaceSnapshot, offset + consumed)
      break
    }
  }
  const nextOffset = offset + consumed
  page.nextCursor = nextOffset < totalEntries
    ? cursorValue(globalSnapshot, workspaceSnapshot, nextOffset)
    : undefined
  page.stats.responseBytes = responseBytes(page)
  page.stats.responseBytes = responseBytes(page)
  if (responseBytes(page) > HOOK_CATALOG_MAX_RESPONSE_BYTES) {
    throw new Error("Hook catalog response exceeded its hard byte limit")
  }
  return page
}

export function clearHookCatalogSnapshotsForTests(): void {
  globalSnapshots.clear()
  globalSnapshotIdByKey.clear()
  latestGlobalSnapshotIdBySource.clear()
  workspaceSnapshots.clear()
  workspaceSnapshotIdByKey.clear()
  latestWorkspaceSnapshotIdBySource.clear()
  nextSnapshotId = 1
}
