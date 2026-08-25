import {
  closeSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { getDiscoveredSkillAliases, getDiscoveredSkillId, normalizeSkillId } from "../skills/ids"
import { parseYamlFrontmatter } from "../utils/skill-identifiers"
import type {
  PluginMetadata,
  SkillMetadata,
  SkillPluginCatalogKind,
  SkillPluginCatalogPage,
  SkillPluginCatalogPageInput,
  SkillPluginCatalogPageStats
} from "../types"
import type { SkillPreviewGrantRequest } from "../../shared/skill-preview"
import {
  SKILL_PLUGIN_CATALOG_CANCELLED,
  SKILL_PLUGIN_CATALOG_CURSOR_EXPIRED,
  SKILL_PLUGIN_CATALOG_DEFAULT_PAGE_SIZE,
  SKILL_PLUGIN_CATALOG_MAX_DIRECTORIES,
  SKILL_PLUGIN_CATALOG_MAX_DISABLED_STORE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_ENTRIES,
  SKILL_PLUGIN_CATALOG_MAX_FILES,
  SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE,
  SKILL_PLUGIN_CATALOG_MAX_PLUGINS,
  SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_SKILLS,
  SKILL_PLUGIN_CATALOG_MAX_SKILL_MD_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_STORE_BYTES,
  SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES,
  type SkillPluginCatalogSourceConfig
} from "./protocol"

const MAX_TEXT = 8_192
const MAX_PATH = 4_096
const MAX_METADATA_FIELDS = 128
const MAX_ALLOWED_TOOLS = 256
const MAX_PLUGIN_SKILL_SOURCES = 64
const SNAPSHOT_TTL_MS = 2 * 60_000
const MAX_SNAPSHOTS = 4

interface MutableStats extends SkillPluginCatalogPageStats {}

interface BuildContext {
  cancelFlag?: Int32Array
  stats: MutableStats
  truncatedReasons: Set<string>
}

interface DiscoveredCatalogSkill {
  name: string
  sourceDir: string
  rootDir: string
  skillMdPath: string
  relativePath: string
  depth: number
  content: string
}

interface SkillSource {
  sourceDir: string
  source: "project" | "user"
  maxDepth?: number
  pluginId?: string
  pluginName?: string
}

interface SkillPreviewCandidate {
  filePath: string
  name: string
}

interface CatalogSnapshot {
  id: string
  key: string
  skills: SkillMetadata[]
  plugins: PluginMetadata[]
  disabledSkillIds: string[]
  truncated: boolean
  truncatedReasons: string[]
  stats: SkillPluginCatalogPageStats
  expiresAt: number
}

const snapshotsById = new Map<string, CatalogSnapshot>()
const snapshotIdByKey = new Map<string, string>()
let nextSnapshotId = 1

export class SkillPluginCatalogCancelledError extends Error {
  readonly code = SKILL_PLUGIN_CATALOG_CANCELLED

  constructor() {
    super("Skill/plugin catalog request was superseded")
    this.name = "SkillPluginCatalogCancelledError"
  }
}

export class SkillPluginCatalogCursorExpiredError extends Error {
  readonly code = SKILL_PLUGIN_CATALOG_CURSOR_EXPIRED

  constructor() {
    super("Skill/plugin catalog cursor expired; restart from the first page")
    this.name = "SkillPluginCatalogCursorExpiredError"
  }
}

function checkCancelled(context: Pick<BuildContext, "cancelFlag">): void {
  if (context.cancelFlag && Atomics.load(context.cancelFlag, 0) !== 0) {
    throw new SkillPluginCatalogCancelledError()
  }
}

function markTruncated(context: BuildContext, reason: string): void {
  context.truncatedReasons.add(reason)
}

function consumeFileBudget(context: BuildContext): boolean {
  if (context.stats.scannedFiles >= SKILL_PLUGIN_CATALOG_MAX_FILES) {
    markTruncated(context, "file-count")
    return false
  }
  context.stats.scannedFiles += 1
  return true
}

function safeSlice(value: string, max: number): string {
  if (value.length <= max) return value
  let end = max
  const lastCode = value.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function boundedString(
  context: BuildContext,
  value: unknown,
  max = MAX_TEXT,
  reason = "field-bytes"
): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length > max) markTruncated(context, reason)
  return safeSlice(value, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readBoundedText(
  filePath: string,
  maxBytes: number,
  context: BuildContext,
  options: { allowPrefix: boolean; reason: string }
): string | null {
  checkCancelled(context)
  if (!consumeFileBudget(context)) return null
  let size: number
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    size = stat.size
  } catch {
    return null
  }
  if (!options.allowPrefix && size > maxBytes) {
    markTruncated(context, options.reason)
    return null
  }
  const remaining = SKILL_PLUGIN_CATALOG_MAX_TOTAL_READ_BYTES - context.stats.readBytes
  if (remaining <= 0) {
    markTruncated(context, "total-read-bytes")
    return null
  }
  const byteLength = Math.min(size, maxBytes, remaining)
  if (size > byteLength) {
    markTruncated(
      context,
      remaining < Math.min(size, maxBytes) ? "total-read-bytes" : options.reason
    )
  }
  const buffer = Buffer.allocUnsafe(byteLength)
  let descriptor: number | null = null
  try {
    descriptor = openSync(filePath, "r")
    let offset = 0
    while (offset < byteLength) {
      checkCancelled(context)
      const read = readSync(descriptor, buffer, offset, byteLength - offset, offset)
      if (read <= 0) break
      offset += read
    }
    context.stats.readBytes += offset
    return buffer.subarray(0, offset).toString("utf-8")
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // The descriptor may already be invalid after a failed read.
      }
    }
  }
}

function readJson(
  filePath: string,
  maxBytes: number,
  context: BuildContext,
  reason: string
): unknown {
  const text = readBoundedText(filePath, maxBytes, context, { allowPrefix: false, reason })
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function normalizeMetadata(
  context: BuildContext,
  frontmatter: Record<string, string>
): Record<string, string> {
  const metadata: Record<string, string> = {}
  const entries = Object.entries(frontmatter)
  if (entries.length > MAX_METADATA_FIELDS) markTruncated(context, "skill-metadata-fields")
  for (const [rawKey, rawValue] of entries.slice(0, MAX_METADATA_FIELDS)) {
    const key = boundedString(context, rawKey, 256, "skill-metadata-key-bytes")
    const value = boundedString(context, rawValue, MAX_TEXT, "skill-metadata-value-bytes")
    if (key && value !== undefined) metadata[key] = value
  }
  return metadata
}

function normalizePlugin(row: unknown, context: BuildContext): PluginMetadata | null {
  if (!isRecord(row)) return null
  const id = boundedString(context, row.id, 1_024, "plugin-id-bytes")
  const name = boundedString(context, row.name, 1_024, "plugin-name-bytes")
  const path = boundedString(context, row.path, MAX_PATH, "plugin-path-bytes")
  if (!id || !name || !path) return null
  const normalizeCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  const origin = row.origin === "market" || row.origin === "local" ? row.origin : undefined
  return {
    id,
    name,
    version: boundedString(context, row.version, 256) ?? "",
    description: boundedString(context, row.description) ?? "",
    ...(boundedString(context, row.useScenario) ? { useScenario: boundedString(context, row.useScenario) } : {}),
    author: boundedString(context, row.author, 1_024) ?? "",
    path,
    enabled: row.enabled !== false,
    skillCount: normalizeCount(row.skillCount),
    mcpServerCount: normalizeCount(row.mcpServerCount),
    ...(typeof row.hookCount === "number" ? { hookCount: normalizeCount(row.hookCount) } : {}),
    ...(boundedString(context, row.hookPath, MAX_PATH) ? { hookPath: boundedString(context, row.hookPath, MAX_PATH) } : {}),
    ...(origin ? { origin } : {}),
    createdAt: boundedString(context, row.createdAt, 256) ?? "",
    updatedAt: boundedString(context, row.updatedAt, 256) ?? ""
  }
}

function parsePlugins(source: SkillPluginCatalogSourceConfig, context: BuildContext): PluginMetadata[] {
  const parsed = readJson(
    source.pluginsStorePath,
    SKILL_PLUGIN_CATALOG_MAX_STORE_BYTES,
    context,
    "plugins-store-bytes"
  )
  if (!Array.isArray(parsed)) return []
  if (parsed.length > SKILL_PLUGIN_CATALOG_MAX_PLUGINS) markTruncated(context, "plugin-count")
  const plugins: PluginMetadata[] = []
  for (const row of parsed.slice(0, SKILL_PLUGIN_CATALOG_MAX_PLUGINS)) {
    checkCancelled(context)
    const plugin = normalizePlugin(row, context)
    if (plugin) plugins.push(plugin)
  }
  return plugins
}

function safePluginPath(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) return null
  const target = resolve(root, relativePath)
  const rel = relative(resolve(root), target)
  return rel.startsWith("..") || isAbsolute(rel) ? null : target
}

function normalizePluginRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "")
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized)) return null
  if (normalized === ".") return "."
  return normalized.split("/").some((part) => !part || part === "." || part === "..")
    ? null
    : normalized
}

function readPluginManifest(pluginRoot: string, context: BuildContext): Record<string, unknown> | null {
  for (const relativePath of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
    const parsed = readJson(
      join(pluginRoot, relativePath),
      SKILL_PLUGIN_CATALOG_MAX_SKILL_MD_BYTES,
      context,
      "plugin-manifest-bytes"
    )
    if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim()) return parsed
  }
  return null
}

function pluginSkillSources(plugin: PluginMetadata, context: BuildContext): SkillSource[] {
  if (!plugin.enabled) return []
  const sources: SkillSource[] = []
  const seen = new Set<string>()
  const add = (relativePath: string, maxDepth?: number): void => {
    if (sources.length >= MAX_PLUGIN_SKILL_SOURCES) {
      markTruncated(context, "plugin-skill-source-count")
      return
    }
    const normalized = normalizePluginRelativePath(relativePath)
    if (!normalized) return
    const sourceDir = safePluginPath(plugin.path, normalized)
    if (!sourceDir) return
    const key = process.platform === "win32" ? sourceDir.toLowerCase() : sourceDir
    if (seen.has(key)) return
    if (!consumeFileBudget(context)) return
    try {
      if (!statSync(sourceDir).isDirectory()) return
    } catch {
      return
    }
    seen.add(key)
    sources.push({
      sourceDir,
      source: "user",
      maxDepth,
      pluginId: plugin.id,
      pluginName: plugin.name
    })
  }
  const manifest = readPluginManifest(plugin.path, context)
  const rawSkills = manifest?.skills
  const declared = typeof rawSkills === "string" ? [rawSkills] : Array.isArray(rawSkills) ? rawSkills : []
  for (const value of declared.slice(0, MAX_PLUGIN_SKILL_SOURCES)) {
    if (typeof value === "string") add(value)
  }
  let hasRootSkill = false
  let hasSkillsDir = false
  if (!consumeFileBudget(context)) return sources
  try {
    hasRootSkill = statSync(join(plugin.path, "SKILL.md")).isFile()
  } catch {
    // Optional conventional source.
  }
  if (!consumeFileBudget(context)) return sources
  try {
    hasSkillsDir = statSync(join(plugin.path, "skills")).isDirectory()
  } catch {
    // Optional conventional source.
  }
  if (hasRootSkill) add(".", hasSkillsDir ? 0 : undefined)
  if (hasSkillsDir) add("skills")
  return sources
}

function discoverSkills(source: SkillSource, context: BuildContext): DiscoveredCatalogSkill[] {
  const result: DiscoveredCatalogSkill[] = []
  const maxDepth = source.maxDepth ?? 3
  const stack: Array<{ path: string; depth: number }> = [{ path: source.sourceDir, depth: 0 }]
  while (stack.length > 0) {
    checkCancelled(context)
    if (context.stats.scannedDirectories >= SKILL_PLUGIN_CATALOG_MAX_DIRECTORIES) {
      markTruncated(context, "directory-count")
      break
    }
    if (context.stats.scannedFiles >= SKILL_PLUGIN_CATALOG_MAX_FILES) {
      markTruncated(context, "file-count")
      break
    }
    if (context.stats.discoveredSkills >= SKILL_PLUGIN_CATALOG_MAX_SKILLS) {
      markTruncated(context, "skill-count")
      break
    }
    const current = stack.pop()!
    context.stats.scannedDirectories += 1
    const skillMdPath = join(current.path, "SKILL.md")
    const content = readBoundedText(skillMdPath, SKILL_PLUGIN_CATALOG_MAX_SKILL_MD_BYTES, context, {
      allowPrefix: true,
      reason: "skill-md-bytes"
    })
    if (content !== null) {
      const frontmatter = parseYamlFrontmatter(content)
      result.push({
        name: frontmatter.name?.trim() || basename(current.path),
        sourceDir: source.sourceDir,
        rootDir: current.path,
        skillMdPath,
        relativePath: relative(source.sourceDir, current.path).replace(/\\/g, "/"),
        depth: current.depth,
        content
      })
      context.stats.discoveredSkills += 1
    }
    if (current.depth >= maxDepth) continue
    const directories: string[] = []
    let directory: ReturnType<typeof opendirSync> | null = null
    try {
      directory = opendirSync(current.path)
      let entry = directory.readSync()
      while (entry) {
        checkCancelled(context)
        if (!consumeFileBudget(context)) break
        if (entry.isDirectory()) {
          if (
            context.stats.scannedDirectories + stack.length + directories.length >=
            SKILL_PLUGIN_CATALOG_MAX_DIRECTORIES
          ) {
            markTruncated(context, "directory-count")
            break
          }
          directories.push(entry.name)
        }
        entry = directory.readSync()
      }
    } catch {
      continue
    } finally {
      try {
        directory?.closeSync()
      } catch {
        // Directory may already have been closed after an iteration failure.
      }
    }
    directories.sort((a, b) => a.localeCompare(b))
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      stack.push({ path: join(current.path, directories[index]), depth: current.depth + 1 })
    }
  }
  return result
}

function toSkillMetadata(
  skill: DiscoveredCatalogSkill,
  source: SkillSource,
  context: BuildContext
): SkillMetadata {
  const frontmatter = normalizeMetadata(context, parseYamlFrontmatter(skill.content))
  const id = getDiscoveredSkillId(skill)
  const allowedTools = frontmatter["allowed-tools"]
    ?.split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_ALLOWED_TOOLS)
  return {
    id: source.pluginId ? `plugin:${source.pluginId}/${id}` : id,
    relativePath: boundedString(context, skill.relativePath, MAX_PATH, "skill-relative-path-bytes"),
    name: boundedString(context, frontmatter.name || skill.name, 1_024, "skill-name-bytes") || skill.name,
    description: boundedString(context, frontmatter.description, MAX_TEXT, "skill-description-bytes") ?? "",
    path: boundedString(context, skill.skillMdPath, MAX_PATH, "skill-path-bytes") || skill.skillMdPath,
    source: source.source,
    version: boundedString(context, frontmatter.version, 256, "skill-version-bytes") || "v1.0.0",
    license: boundedString(context, frontmatter.license, 1_024, "skill-license-bytes") ?? null,
    compatibility: boundedString(context, frontmatter.compatibility, MAX_TEXT, "skill-compatibility-bytes") ?? null,
    metadata: frontmatter,
    ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(source.pluginId ? { pluginId: source.pluginId } : {}),
    ...(source.pluginName ? { pluginName: source.pluginName } : {})
  }
}

function resolveDisabledIds(
  source: SkillPluginCatalogSourceConfig,
  globalSkills: DiscoveredCatalogSkill[],
  context: BuildContext
): string[] {
  const parsed = readJson(
    source.disabledSkillsPath,
    SKILL_PLUGIN_CATALOG_MAX_DISABLED_STORE_BYTES,
    context,
    "disabled-skills-bytes"
  )
  const rawEntries = Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : []
  const byId = new Set<string>()
  const aliases = new Map<string, Set<string>>()
  for (const skill of globalSkills) {
    const id = getDiscoveredSkillId(skill)
    if (!id) continue
    byId.add(id)
    for (const alias of getDiscoveredSkillAliases(skill)) {
      let values = aliases.get(alias)
      if (!values) {
        values = new Set()
        aliases.set(alias, values)
      }
      values.add(id)
    }
  }
  const resolved = new Set<string>()
  for (const raw of rawEntries.slice(0, SKILL_PLUGIN_CATALOG_MAX_SKILLS)) {
    const normalized = normalizeSkillId(raw)
    if (!normalized) continue
    if (byId.has(normalized)) {
      resolved.add(normalized)
      continue
    }
    const matches = aliases.get(normalized)
    if (matches) {
      for (const id of matches) resolved.add(id)
    } else {
      resolved.add(normalized)
    }
  }
  if (rawEntries.length > SKILL_PLUGIN_CATALOG_MAX_SKILLS) {
    markTruncated(context, "disabled-skill-count")
  }
  return [...resolved]
}

function sourceKey(
  source: SkillPluginCatalogSourceConfig,
  revision: string | undefined,
  projection: "plugins-only" | "skills-and-disabled"
): string {
  return JSON.stringify([
    revision ?? "0",
    projection,
    source.builtinSkillsDir,
    source.customSkillsDir,
    source.pluginsStorePath,
    source.disabledSkillsPath
  ])
}

function deleteSnapshot(snapshot: CatalogSnapshot): void {
  snapshotsById.delete(snapshot.id)
  if (snapshotIdByKey.get(snapshot.key) === snapshot.id) snapshotIdByKey.delete(snapshot.key)
}

function trimSnapshots(): void {
  const now = Date.now()
  for (const snapshot of snapshotsById.values()) {
    if (snapshot.expiresAt <= now) deleteSnapshot(snapshot)
  }
  while (snapshotsById.size >= MAX_SNAPSHOTS) {
    const oldestId = snapshotsById.keys().next().value as string | undefined
    if (!oldestId) break
    const oldest = snapshotsById.get(oldestId)
    if (oldest) deleteSnapshot(oldest)
  }
}

function buildSnapshot(
  source: SkillPluginCatalogSourceConfig,
  input: SkillPluginCatalogPageInput,
  cancelFlag?: Int32Array
): CatalogSnapshot {
  const projection = input.kind === "plugins" ? "plugins-only" : "skills-and-disabled"
  const key = sourceKey(source, input.revision, projection)
  trimSnapshots()
  const cachedId = snapshotIdByKey.get(key)
  const cached = cachedId ? snapshotsById.get(cachedId) : undefined
  if (cached && cached.expiresAt > Date.now()) return cached

  const context: BuildContext = {
    cancelFlag,
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 },
    truncatedReasons: new Set()
  }
  const plugins = parsePlugins(source, context)
  if (projection === "plugins-only") {
    checkCancelled(context)
    const snapshot: CatalogSnapshot = {
      id: `spc-${nextSnapshotId++}`,
      key,
      skills: [],
      plugins,
      disabledSkillIds: [],
      truncated: context.truncatedReasons.size > 0,
      truncatedReasons: [...context.truncatedReasons],
      stats: { ...context.stats },
      expiresAt: Date.now() + SNAPSHOT_TTL_MS
    }
    snapshotsById.set(snapshot.id, snapshot)
    snapshotIdByKey.set(key, snapshot.id)
    return snapshot
  }
  const localSources: SkillSource[] = [
    { sourceDir: source.builtinSkillsDir, source: "project" },
    { sourceDir: source.customSkillsDir, source: "user" }
  ]
  const globalDiscovered: Array<{ skill: DiscoveredCatalogSkill; source: SkillSource }> = []
  for (const localSource of localSources) {
    for (const skill of discoverSkills(localSource, context)) {
      globalDiscovered.push({ skill, source: localSource })
    }
  }
  const localById = new Map<string, SkillMetadata>()
  for (const { skill, source: localSource } of globalDiscovered) {
    const metadata = toSkillMetadata(skill, localSource, context)
    localById.set(normalizeSkillId(metadata.id || metadata.name), metadata)
  }
  const pluginSkills = new Map<string, SkillMetadata>()
  for (const plugin of plugins) {
    for (const pluginSource of pluginSkillSources(plugin, context)) {
      for (const skill of discoverSkills(pluginSource, context)) {
        const metadata = toSkillMetadata(skill, pluginSource, context)
        pluginSkills.set(
          `${plugin.id}:${normalizeSkillId(metadata.id || metadata.name)}`,
          metadata
        )
      }
    }
  }
  let skills = [...localById.values(), ...pluginSkills.values()]
  if (skills.length + plugins.length > SKILL_PLUGIN_CATALOG_MAX_ENTRIES) {
    markTruncated(context, "entry-count")
    skills = skills.slice(0, Math.max(0, SKILL_PLUGIN_CATALOG_MAX_ENTRIES - plugins.length))
  }
  const disabledSkillIds = resolveDisabledIds(
    source,
    globalDiscovered.map(({ skill }) => skill),
    context
  )
  checkCancelled(context)
  const snapshot: CatalogSnapshot = {
    id: `spc-${nextSnapshotId++}`,
    key,
    skills,
    plugins,
    disabledSkillIds,
    truncated: context.truncatedReasons.size > 0,
    truncatedReasons: [...context.truncatedReasons],
    stats: { ...context.stats },
    expiresAt: Date.now() + SNAPSHOT_TTL_MS
  }
  snapshotsById.set(snapshot.id, snapshot)
  snapshotIdByKey.set(key, snapshot.id)
  return snapshot
}

function parseCursor(cursor: string): { snapshotId: string; kind: SkillPluginCatalogKind; offset: number } {
  const match = cursor.match(/^(spc-\d+):(skills|plugins|disabled):(\d+)$/)
  if (!match) throw new SkillPluginCatalogCursorExpiredError()
  return { snapshotId: match[1], kind: match[2] as SkillPluginCatalogKind, offset: Number(match[3]) }
}

function pageItems(snapshot: CatalogSnapshot, kind: SkillPluginCatalogKind): unknown[] {
  if (kind === "skills") return snapshot.skills
  if (kind === "plugins") return snapshot.plugins
  return snapshot.disabledSkillIds
}

export function readSkillPluginCatalogPage(
  source: SkillPluginCatalogSourceConfig,
  input: SkillPluginCatalogPageInput,
  cancelFlag?: Int32Array
): SkillPluginCatalogPage {
  const context = { cancelFlag }
  checkCancelled(context)
  let snapshot: CatalogSnapshot
  let offset = 0
  if (input.cursor) {
    const parsed = parseCursor(input.cursor)
    if (parsed.kind !== input.kind) throw new SkillPluginCatalogCursorExpiredError()
    const existing = snapshotsById.get(parsed.snapshotId)
    if (!existing || existing.expiresAt <= Date.now()) {
      if (existing) deleteSnapshot(existing)
      throw new SkillPluginCatalogCursorExpiredError()
    }
    snapshot = existing
    offset = parsed.offset
  } else {
    snapshot = buildSnapshot(source, input, cancelFlag)
  }
  const items = pageItems(snapshot, input.kind)
  const requestedLimit = Math.max(1, Math.trunc(input.limit ?? SKILL_PLUGIN_CATALOG_DEFAULT_PAGE_SIZE))
  const limit = Math.min(requestedLimit, SKILL_PLUGIN_CATALOG_MAX_PAGE_SIZE)
  const selected: unknown[] = []
  let responseBytes = 256
  let cursor = offset
  while (cursor < items.length && selected.length < limit) {
    checkCancelled(context)
    const item = items[cursor]
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf-8") + 32
    if (selected.length > 0 && responseBytes + itemBytes > SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES) break
    if (itemBytes > SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES - 256) {
      snapshot.truncated = true
      if (!snapshot.truncatedReasons.includes("response-entry-bytes")) {
        snapshot.truncatedReasons.push("response-entry-bytes")
      }
      cursor += 1
      continue
    }
    selected.push(item)
    responseBytes += itemBytes
    cursor += 1
  }
  const createPage = (): SkillPluginCatalogPage => ({
    kind: input.kind,
    skills: input.kind === "skills" ? (selected as SkillMetadata[]) : [],
    plugins: input.kind === "plugins" ? (selected as PluginMetadata[]) : [],
    disabledSkillIds: input.kind === "disabled" ? (selected as string[]) : [],
    cursor: cursor < items.length ? `${snapshot.id}:${input.kind}:${cursor}` : null,
    total: items.length,
    truncated: snapshot.truncated,
    truncatedReasons: [...snapshot.truncatedReasons],
    stats: { ...snapshot.stats }
  })
  let page = createPage()
  while (
    selected.length > 0 &&
    Buffer.byteLength(JSON.stringify(page), "utf-8") > SKILL_PLUGIN_CATALOG_MAX_RESPONSE_BYTES
  ) {
    selected.pop()
    cursor -= 1
    page = createPage()
  }
  return page
}

function previewBuildContext(cancelFlag?: Int32Array): BuildContext {
  return {
    cancelFlag,
    stats: { scannedDirectories: 0, scannedFiles: 0, discoveredSkills: 0, readBytes: 0 },
    truncatedReasons: new Set()
  }
}

function containedRealFile(sourceDir: string, candidate: string): string | null {
  try {
    const realSource = realpathSync(sourceDir)
    const realCandidate = realpathSync(candidate)
    const rel = relative(realSource, realCandidate)
    if (rel.startsWith("..") || isAbsolute(rel)) return null
    return statSync(realCandidate).isFile() ? realCandidate : null
  } catch {
    return null
  }
}

function resolvePreviewFromSource(
  source: SkillSource,
  request: SkillPreviewGrantRequest,
  relativeId: string,
  context: BuildContext
): SkillPreviewCandidate | null {
  const normalizedRelativeId = normalizeSkillId(relativeId)
  if (!normalizedRelativeId || normalizedRelativeId.includes("\0")) return null
  const segments = normalizedRelativeId.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null

  const candidates: string[] = []
  // A skill rooted directly at its source directory has an id derived from its
  // frontmatter name rather than a relative path.
  candidates.push(join(source.sourceDir, "SKILL.md"))
  if (segments.length <= (source.maxDepth ?? 3)) {
    candidates.push(join(source.sourceDir, normalizedRelativeId, "SKILL.md"))
  }

  let matched: SkillPreviewCandidate | null = null
  for (const candidate of candidates) {
    checkCancelled(context)
    const realCandidate = containedRealFile(source.sourceDir, candidate)
    if (!realCandidate) continue
    const content = readBoundedText(
      realCandidate,
      SKILL_PLUGIN_CATALOG_MAX_SKILL_MD_BYTES,
      context,
      { allowPrefix: true, reason: "skill-md-bytes" }
    )
    if (content === null) continue
    const frontmatter = parseYamlFrontmatter(content)
    const skillRoot = resolve(realCandidate, "..")
    const relativePath = relative(realpathSync(source.sourceDir), skillRoot).replace(/\\/g, "/")
    const discoveredId = getDiscoveredSkillId({
      name: frontmatter.name?.trim() || basename(skillRoot),
      relativePath,
      rootDir: skillRoot
    })
    const fullId = source.pluginId ? `plugin:${source.pluginId}/${discoveredId}` : discoveredId
    if (
      fullId === request.id &&
      source.source === request.source &&
      source.pluginId === request.pluginId
    ) {
      matched = {
        filePath: realCandidate,
        name: frontmatter.name?.trim() || basename(skillRoot)
      }
    }
  }
  return matched
}

/**
 * Resolve one renderer-supplied skill identity without constructing the full
 * catalog. The id maps to at most two files per trusted source; plugin lookup
 * parses only the bounded plugin store and inspects sources for that exact id.
 */
export function resolveSkillPreview(
  config: SkillPluginCatalogSourceConfig,
  request: SkillPreviewGrantRequest,
  cancelFlag?: Int32Array
): { filePath: string } | null {
  const context = previewBuildContext(cancelFlag)
  checkCancelled(context)

  if (request.pluginId) {
    const prefix = `plugin:${request.pluginId}/`
    if (!request.id.startsWith(prefix)) return null
    const plugin = parsePlugins(config, context).find(
      (candidate) => candidate.enabled && candidate.id === request.pluginId
    )
    if (!plugin) return null
    const relativeId = request.id.slice(prefix.length)
    let matched: SkillPreviewCandidate | null = null
    for (const source of pluginSkillSources(plugin, context)) {
      const candidate = resolvePreviewFromSource(source, request, relativeId, context)
      if (candidate) matched = candidate
    }
    return matched?.name === request.name ? { filePath: matched.filePath } : null
  }

  if (request.id.startsWith("plugin:")) return null
  if (request.source === "project") {
    const customShadow = resolvePreviewFromSource(
      { sourceDir: config.customSkillsDir, source: "user" },
      { ...request, source: "user" },
      request.id,
      context
    )
    if (customShadow) return null
  }
  const source: SkillSource = {
    sourceDir: request.source === "project" ? config.builtinSkillsDir : config.customSkillsDir,
    source: request.source
  }
  const matched = resolvePreviewFromSource(source, request, request.id, context)
  return matched?.name === request.name ? { filePath: matched.filePath } : null
}

export function resetSkillPluginCatalogSnapshotsForTests(): void {
  snapshotsById.clear()
  snapshotIdByKey.clear()
  nextSnapshotId = 1
}
