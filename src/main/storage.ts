import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { v4 as uuid } from "uuid"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "fs"
import type { HookConfig, HookUpsert } from "./hooks/types"
import { readdir, readFile, rm, mkdir, stat as fsStat } from "fs/promises"
import { app } from "electron"
import type { PluginMetadata, PluginMcpServerConfig } from "./types"
import { copyDirRecursive } from "./utils/fs"
const OPENWORK_DIR = join(homedir(), ".cmbcoworkagent")
const ENV_FILE = join(OPENWORK_DIR, ".env")

const CUSTOM_API_KEY_PREFIX = "CUSTOM_API_KEY__"

export function getOpenworkDir(): string {
  if (!existsSync(OPENWORK_DIR)) {
    mkdirSync(OPENWORK_DIR, { recursive: true })
  }
  return OPENWORK_DIR
}

export function getDbPath(): string {
  return join(getOpenworkDir(), "cmbcoworkagent.sqlite")
}

export function getCheckpointDbPath(): string {
  return join(getOpenworkDir(), "langgraph.sqlite")
}

export function getLogsDir(): string {
  const dir = join(getOpenworkDir(), "logs")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function getMainLogPath(): string {
  return join(getLogsDir(), "main.log")
}

export function getRendererLogPath(): string {
  return join(getLogsDir(), "renderer.log")
}

export function getOptimizerCandidatesPath(): string {
  return join(getOpenworkDir(), "optimizer-candidates.json")
}

export function getThreadCheckpointDir(): string {
  const dir = join(getOpenworkDir(), "threads")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/

export function getThreadCheckpointPath(threadId: string): string {
  if (!SAFE_ID_RE.test(threadId)) {
    throw new Error(`Invalid threadId: ${threadId}`)
  }
  return join(getThreadCheckpointDir(), `${threadId}.sqlite`)
}

export function deleteThreadCheckpoint(threadId: string): void {
  const path = getThreadCheckpointPath(threadId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

export function getEnvFilePath(): string {
  return ENV_FILE
}

// Read .env file and parse into object
function parseEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath()
  if (!existsSync(envPath)) return {}

  const content = readFileSync(envPath, "utf-8")
  const result: Record<string, string> = {}

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIndex = trimmed.indexOf("=")
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      result[key] = value
    }
  }
  return result
}

// Write object back to .env file
function writeEnvFile(env: Record<string, string>): void {
  getOpenworkDir() // ensure dir exists
  const lines = Object.entries(env)
    .filter((entry) => entry[1])
    .map(([k, v]) => `${k}=${v}`)
  writeFileSync(getEnvFilePath(), lines.join("\n") + "\n")
}

// Skills directory — bundled with the app at project root /skills/
export function getSkillsDir(): string {

  // 1) Packaged: skills 在 app.asar 的 /out/skills（你已经验证过）
  if (app?.isPackaged) {
    // app.getAppPath() => .../Contents/Resources/app.asar
    const asarOutSkills = join(app.getAppPath(), "out", "skills");
    if (existsSync(asarOutSkills)) return asarOutSkills;

    // 有些打包方式会把 out 放在 Resources 目录下（非 asar）
    const resourcesOutSkills = join(process.resourcesPath, "out", "skills");
    if (existsSync(resourcesOutSkills)) return resourcesOutSkills;

    // 如果你未来改成 extraResources: Resources/skills
    const resourcesSkills = join(process.resourcesPath, "skills");
    if (existsSync(resourcesSkills)) return resourcesSkills;
  }

  // Prefer workspace root /skills in development (cwd is project root in electron-vite dev).
  const workspaceSkillsDir = join(process.cwd(), "skills")
  if (existsSync(workspaceSkillsDir)) return workspaceSkillsDir

  // Fallbacks for packaged/bundled layouts.
  const bundledDir = join(__dirname, "..", "..", "skills")
  if (existsSync(bundledDir)) return bundledDir

  const resourcesDir = join(__dirname, "..", "..", "..", "skills")
  if (existsSync(resourcesDir)) return resourcesDir

  return workspaceSkillsDir
}

const CUSTOM_SKILLS_DIR = join(OPENWORK_DIR, "skills")

export function getCustomSkillsDir(): string {
  getOpenworkDir()
  return CUSTOM_SKILLS_DIR
}

export function getSkillsSources(): string[] {
  const builtin = getSkillsDir()
  const custom = getCustomSkillsDir()
  const sources: string[] = []
  if (existsSync(builtin)) sources.push(builtin)
  if (existsSync(custom)) sources.push(custom)
  return sources
}

// ── Skill auto-propose setting ──

const SKILL_EVOLUTION_SETTINGS_FILE = join(OPENWORK_DIR, "skill-evolution-settings.json")

interface SkillEvolutionSettings {
  onlineEnabled?: boolean
  autoPropose?: boolean
  threshold?: number
}

function readSkillEvolutionSettings(): SkillEvolutionSettings {
  if (!existsSync(SKILL_EVOLUTION_SETTINGS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(SKILL_EVOLUTION_SETTINGS_FILE, "utf-8")) as SkillEvolutionSettings
  } catch {
    return {}
  }
}

function writeSkillEvolutionSettings(settings: SkillEvolutionSettings): void {
  getOpenworkDir()
  writeFileSync(SKILL_EVOLUTION_SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

/**
 * Controls whether the online skill-evolution feature is enabled at all.
 * When false, no automatic proposal flow runs during a live conversation.
 */
export function isOnlineSkillEvolutionEnabled(): boolean {
  return readSkillEvolutionSettings().onlineEnabled === true
}

export function setOnlineSkillEvolutionEnabled(enabled: boolean): void {
  const current = readSkillEvolutionSettings()
  writeSkillEvolutionSettings({
    onlineEnabled: enabled,
    autoPropose: current.autoPropose === true,
    threshold: getSkillEvolutionThreshold()
  })
}

/**
 * Online skill-evolution mode selector:
 * - true  => direct trigger after threshold (Mode A / 直接触发)
 * - false => ask worthiness LLM first     (Mode B / 模型判断)
 */
export function isSkillAutoProposeEnabled(): boolean {
  return readSkillEvolutionSettings().autoPropose === true
}

export function setSkillAutoProposeEnabled(enabled: boolean): void {
  const current = readSkillEvolutionSettings()
  writeSkillEvolutionSettings({
    onlineEnabled: current.onlineEnabled === true,
    autoPropose: enabled,
    threshold: getSkillEvolutionThreshold()
  })
}

const SKILL_EVOLUTION_THRESHOLD_DEFAULT = 10
const SKILL_EVOLUTION_THRESHOLD_MIN = 1
const SKILL_EVOLUTION_THRESHOLD_MAX = 99

export function getSkillEvolutionThreshold(): number {
  const value = Number(readSkillEvolutionSettings().threshold)
  if (Number.isInteger(value) && value >= SKILL_EVOLUTION_THRESHOLD_MIN && value <= SKILL_EVOLUTION_THRESHOLD_MAX) {
    return value
  }
  return SKILL_EVOLUTION_THRESHOLD_DEFAULT
}

export function setSkillEvolutionThreshold(value: number): void {
  const clamped = Math.max(SKILL_EVOLUTION_THRESHOLD_MIN, Math.min(SKILL_EVOLUTION_THRESHOLD_MAX, Math.round(value)))
  const current = readSkillEvolutionSettings()
  writeSkillEvolutionSettings({
    onlineEnabled: current.onlineEnabled === true,
    autoPropose: current.autoPropose === true,
    threshold: clamped
  })
}

// ── Memory settings ──

const MEMORY_SETTINGS_FILE = join(OPENWORK_DIR, "memory-settings.json")

export function isMemoryEnabled(): boolean {
  if (!existsSync(MEMORY_SETTINGS_FILE)) return true
  try {
    const parsed = JSON.parse(readFileSync(MEMORY_SETTINGS_FILE, "utf-8"))
    return parsed.enabled !== false
  } catch {
    return true
  }
}

export function setMemoryEnabled(enabled: boolean): void {
  getOpenworkDir()
  writeFileSync(MEMORY_SETTINGS_FILE, JSON.stringify({ enabled }, null, 2))
}

// ── Skills ──

const DISABLED_SKILLS_FILE = join(OPENWORK_DIR, "disabled-skills.json")

export function getDisabledSkills(): string[] {
  getOpenworkDir()
  if (!existsSync(DISABLED_SKILLS_FILE)) return []
  try {
    const content = readFileSync(DISABLED_SKILLS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
  } catch {
    return []
  }
}

export function setDisabledSkills(skillNames: string[]): void {
  getOpenworkDir()
  writeFileSync(DISABLED_SKILLS_FILE, JSON.stringify(skillNames, null, 2))
  invalidateEnabledSkillsCache()
}

function parseSkillNameFromFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === "name") {
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

const ENABLED_SKILLS_DIR = join(OPENWORK_DIR, "enabled-skills")
const ENABLED_SKILLS_BUILTIN_DIR = join(OPENWORK_DIR, "enabled-skills-builtin")
const ENABLED_SKILLS_CUSTOM_DIR = join(OPENWORK_DIR, "enabled-skills-custom")

// Fingerprints for separate builtin and custom enabled skills
let _enabledSkillsBuiltinFingerprint: string | null = null
let _enabledSkillsCustomFingerprint: string | null = null

async function computeEnabledSkillsFingerprint(disabledList: string[], sourceDirs: string[]): Promise<string> {
  const parts = [disabledList.sort().join(","), sourceDirs.join("|")]
  for (const dir of sourceDirs) {
    if (!existsSync(dir)) continue
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const dirNames: string[] = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        dirNames.push(e.name)
        const skillMdPath = join(dir, e.name, "SKILL.md")
        try {
          const st = await fsStat(skillMdPath)
          dirNames.push(String(st.mtimeMs))
        } catch { /* no SKILL.md or unreadable */ }
      }
      parts.push(dirNames.sort().join(","))
    } catch { /* ignore */ }
  }
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16)
}

async function copyEnabledSkillsFromSourceAsync(sourceDir: string, disabled: Set<string>, destDir?: string): Promise<number> {
  let count = 0
  const entries = await readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillMdPath = join(sourceDir, entry.name, "SKILL.md")
    if (!existsSync(skillMdPath)) continue

    try {
      const content = await readFile(skillMdPath, "utf-8")
      const name = parseSkillNameFromFrontmatter(content) || entry.name
      if (disabled.has(name.trim().toLowerCase())) continue
    } catch {
      continue
    }

    const srcSkillDir = join(sourceDir, entry.name)
    const destPath = destDir ? join(destDir, entry.name) : join(ENABLED_SKILLS_DIR, entry.name)
    try {
      await copyDirRecursive(srcSkillDir, destPath)
      count++
    } catch (e) {
      console.warn(`[Storage] Failed to copy skill ${entry.name}:`, e)
      // Clean up partial directory so it doesn't look like a valid skill
      try { await rm(destPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  return count
}

let _enabledSkillsBuildLock: Promise<string[]> | null = null

/**
 * Ensures separate enabled-skills directories exist for builtin and custom skills.
 * Uses async I/O to avoid blocking the main process event loop.
 * Skips rebuild if the disabled list and source dirs haven't changed.
 * Serialized via a Promise lock to prevent concurrent rm/mkdir/copyFile races.
 */
async function ensureEnabledSkillsDirsAsync(): Promise<string[]> {
  if (_enabledSkillsBuildLock) return _enabledSkillsBuildLock
  _enabledSkillsBuildLock = _ensureEnabledSkillsDirsImpl()
  try {
    return await _enabledSkillsBuildLock
  } finally {
    _enabledSkillsBuildLock = null
  }
}

async function _ensureEnabledSkillsDirsImpl(): Promise<string[]> {
  getOpenworkDir()
  const builtinDir = getSkillsDir()
  const customDir = getCustomSkillsDir()
  const disabled = getDisabledSkills()
  const disabledSet = new Set(disabled.map((s) => s.trim().toLowerCase()))

  const results: string[] = []

  // Handle builtin skills
  if (existsSync(builtinDir)) {
    const builtinFingerprint = await computeEnabledSkillsFingerprint(disabled, [builtinDir])
    if (_enabledSkillsBuiltinFingerprint !== builtinFingerprint || !existsSync(ENABLED_SKILLS_BUILTIN_DIR)) {
      if (existsSync(ENABLED_SKILLS_BUILTIN_DIR)) {
        await rm(ENABLED_SKILLS_BUILTIN_DIR, { recursive: true })
      }
      await mkdir(ENABLED_SKILLS_BUILTIN_DIR, { recursive: true })

      const count = await copyEnabledSkillsFromSourceAsync(builtinDir, disabledSet, ENABLED_SKILLS_BUILTIN_DIR)
      console.log(`[Storage] Copied ${count} enabled builtin skills to ${ENABLED_SKILLS_BUILTIN_DIR}`)
      _enabledSkillsBuiltinFingerprint = builtinFingerprint
    }
    if (existsSync(ENABLED_SKILLS_BUILTIN_DIR)) {
      results.push(ENABLED_SKILLS_BUILTIN_DIR)
    }
  }

  // Handle custom skills
  if (existsSync(customDir)) {
    const customFingerprint = await computeEnabledSkillsFingerprint(disabled, [customDir])
    if (_enabledSkillsCustomFingerprint !== customFingerprint || !existsSync(ENABLED_SKILLS_CUSTOM_DIR)) {
      if (existsSync(ENABLED_SKILLS_CUSTOM_DIR)) {
        await rm(ENABLED_SKILLS_CUSTOM_DIR, { recursive: true })
      }
      await mkdir(ENABLED_SKILLS_CUSTOM_DIR, { recursive: true })

      const count = await copyEnabledSkillsFromSourceAsync(customDir, disabledSet, ENABLED_SKILLS_CUSTOM_DIR)
      console.log(`[Storage] Copied ${count} enabled custom skills to ${ENABLED_SKILLS_CUSTOM_DIR}`)
      _enabledSkillsCustomFingerprint = customFingerprint
    }
    if (existsSync(ENABLED_SKILLS_CUSTOM_DIR)) {
      results.push(ENABLED_SKILLS_CUSTOM_DIR)
    }
  }

  return results
}

/**
 * Invalidate the enabled-skills cache so the next call rebuilds.
 * Should be called when disabled skills list changes.
 */
export function invalidateEnabledSkillsCache(): void {
  _enabledSkillsBuiltinFingerprint = null
  _enabledSkillsCustomFingerprint = null
  _pluginSkillsCache = null
  _pluginMcpCache = null
}

/**
 * Returns skills sources for the agent: either the filtered enabled-skills dirs
 * or the full skills dirs if no skills are disabled.
 */
export async function getEnabledSkillsSources(): Promise<string[]> {
  const disabled = getDisabledSkills()
  if (disabled.length === 0) return getSkillsSources()

  // When skills are disabled, create separate filtered directories for builtin and custom skills
  const enabledDirs = await ensureEnabledSkillsDirsAsync()
  return enabledDirs.filter(dir => existsSync(dir))
}

// Custom model configurations stored as JSON in ~/.cmbcoworkagent/custom-models.json
export interface CustomModelConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  maxTokens?: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

export interface UserInfoConfig {
  sapId?: string//8
  ystId?: string//6
  userName?: string
  originOrgId?: string
  orgName?: string
  ystRefreshToken?: string
  ystCode?: string
  ystAccessToken?: string
}

export const DEFAULT_MAX_TOKENS = 128_000
export const MIN_MAX_TOKENS = 32_000
export const MAX_MAX_TOKENS = 128_000

export interface CustomModelPublicConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

interface StoredCustomModelRecord {
  id: string
  name: string
  baseUrl: string
  model: string
  maxTokens?: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

const CUSTOM_MODEL_FILE = join(OPENWORK_DIR, "custom-model.json")
const CUSTOM_MODELS_FILE = join(OPENWORK_DIR, "custom-models.json")
const USERINFO_MODELS_FILE = join(OPENWORK_DIR, "userinfo-models.json")

function normalizeMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKENS
  }

  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)))
}

function defaultInterleavedThinkingForModel(model: string): boolean {
  return /minimax/i.test(model)
}

function resolveInterleavedThinkingSetting(model: string, value: unknown): boolean {
  return typeof value === "boolean" ? value : defaultInterleavedThinkingForModel(model)
}

function getCustomApiKeyEnvName(id: string): string {
  const hash = createHash("sha256").update(id.trim()).digest("hex").slice(0, 12)
  return `${CUSTOM_API_KEY_PREFIX}${hash}`
}

function getCustomModelApiKey(id: string, env?: Record<string, string>): string | undefined {
  const resolved = env ?? parseEnvFile()
  const keyName = getCustomApiKeyEnvName(id)
  if (resolved[keyName]) return resolved[keyName]
  return process.env[keyName]
}

function setCustomModelApiKey(id: string, apiKey: string): void {
  const keyName = getCustomApiKeyEnvName(id)
  const env = parseEnvFile()
  env[keyName] = apiKey
  writeEnvFile(env)
  process.env[keyName] = apiKey
}

function deleteCustomModelApiKey(id: string): void {
  const keyName = getCustomApiKeyEnvName(id)
  const env = parseEnvFile()
  delete env[keyName]
  writeEnvFile(env)
  delete process.env[keyName]
}

function deleteAllCustomModelApiKeys(): void {
  const env = parseEnvFile()
  for (const key of Object.keys(env)) {
    if (key.startsWith(CUSTOM_API_KEY_PREFIX)) {
      delete env[key]
    }
  }
  writeEnvFile(env)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(CUSTOM_API_KEY_PREFIX)) {
      delete process.env[key]
    }
  }
}

function assertValidMaxTokens(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_TOKENS
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`maxTokens 必须是数字，范围为 ${MIN_MAX_TOKENS} 到 ${MAX_MAX_TOKENS}`)
  }

  const parsed = Math.floor(value)
  if (parsed < MIN_MAX_TOKENS || parsed > MAX_MAX_TOKENS) {
    throw new Error(`maxTokens 超出范围，必须在 ${MIN_MAX_TOKENS} 到 ${MAX_MAX_TOKENS} 之间`)
  }

  return parsed
}

function assertValidBaseUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error("接口地址不能为空")
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error("接口地址格式无效，请输入完整 URL（例如 https://api.example.com/v1）")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("接口地址必须以 http:// 或 https:// 开头")
  }

  return normalized
}

export function getCustomModelConfig(): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  return configs[0] ?? null
}

function readCustomModelsRaw(): StoredCustomModelRecord[] {
  getOpenworkDir()
  if (!existsSync(CUSTOM_MODELS_FILE)) return []
  try {
    const content = readFileSync(CUSTOM_MODELS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is StoredCustomModelRecord =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { baseUrl?: unknown }).baseUrl === "string" &&
        typeof (item as { model?: unknown }).model === "string"
    )
  } catch {
    return []
  }
}

function writeCustomModelsRaw(items: StoredCustomModelRecord[]): void {
  writeFileSync(CUSTOM_MODELS_FILE, JSON.stringify(items, null, 2))
}

function writeUserInfoModelsRaw(items: UserInfoConfig): void {
  writeFileSync(USERINFO_MODELS_FILE, JSON.stringify(items, null, 2))
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

let _legacyMigrated = false
function migrateLegacyCustomModel(): void {
  if (_legacyMigrated) return
  _legacyMigrated = true

  getOpenworkDir()
  if (existsSync(CUSTOM_MODELS_FILE) || !existsSync(CUSTOM_MODEL_FILE)) return

  try {
    const content = readFileSync(CUSTOM_MODEL_FILE, "utf-8")
    const legacy = JSON.parse(content) as {
      baseUrl?: string
      model?: string
      maxTokens?: number
    }
    if (!legacy.baseUrl || !legacy.model) return

    const baseId = slugify(`${legacy.model}-${legacy.baseUrl}`) || "custom-model"
    const migrated: StoredCustomModelRecord = {
      id: baseId,
      name: legacy.model,
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      maxTokens: normalizeMaxTokens(legacy.maxTokens)
    }
    writeCustomModelsRaw([migrated])

  } catch {
    // Ignore migration failures and keep legacy behavior.
  }
}

function toPublicConfig(config: StoredCustomModelRecord, env?: Record<string, string>): CustomModelPublicConfig {
  return {
    id: config.id,
    name: config.name || config.model,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!getCustomModelApiKey(config.id, env),
    maxTokens: normalizeMaxTokens(config.maxTokens),
    interleavedThinking: resolveInterleavedThinkingSetting(config.model, config.interleavedThinking),
    ...(config.tier !== undefined && { tier: config.tier })
  }
}

export function getCustomModelConfigs(): CustomModelConfig[] {
  migrateLegacyCustomModel()
  const env = parseEnvFile()
  return readCustomModelsRaw().map((item) => ({
    id: item.id,
    name: item.name || item.model,
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: getCustomModelApiKey(item.id, env),
    maxTokens: normalizeMaxTokens(item.maxTokens),
    interleavedThinking: resolveInterleavedThinkingSetting(item.model, item.interleavedThinking),
    ...(item.tier !== undefined && { tier: item.tier })
  }))
}

export function getCustomModelConfigById(id: string): CustomModelConfig | null {
  migrateLegacyCustomModel()
  const record = readCustomModelsRaw().find((item) => item.id === id)
  if (!record) return null
  return {
    id: record.id,
    name: record.name || record.model,
    baseUrl: record.baseUrl,
    model: record.model,
    apiKey: getCustomModelApiKey(record.id),
    maxTokens: normalizeMaxTokens(record.maxTokens),
    interleavedThinking: resolveInterleavedThinkingSetting(record.model, record.interleavedThinking),
    ...(record.tier !== undefined && { tier: record.tier })
  }
}

export function getUserInfo(): UserInfoConfig | null {
  if (!existsSync(USERINFO_MODELS_FILE)) return null
  const content = readFileSync(USERINFO_MODELS_FILE, "utf-8")
  const userInfo = JSON.parse(content) as UserInfoConfig
  return userInfo
}

export function upsertCustomModelConfig(
  config: Omit<CustomModelConfig, "id"> & { id?: string }
): string {
  getOpenworkDir()
  migrateLegacyCustomModel()

  const validatedMaxTokens = assertValidMaxTokens(config.maxTokens)
  const validatedBaseUrl = assertValidBaseUrl(config.baseUrl)
  const normalizedName = config.name.trim()
  const normalizedModel = config.model.trim()
  if (!normalizedName) {
    throw new Error("显示名称不能为空")
  }
  if (!normalizedModel) {
    throw new Error("模型名称不能为空")
  }
  const items = readCustomModelsRaw()
  let targetId: string

  if (config.id) {
    targetId = config.id
  } else {
    const baseId = slugify(normalizedName || normalizedModel || "custom-model") || "custom-model"
    targetId = baseId
    let suffix = 1
    while (items.some((item) => item.id === targetId)) {
      suffix += 1
      targetId = `${baseId}-${suffix}`
    }
  }

  const duplicate = items.find((item) => item.name === normalizedName && item.id !== targetId)
  if (duplicate) {
    throw new Error("显示名称不能重复，请使用不同的显示名称")
  }

  const nextRecord: StoredCustomModelRecord = {
    id: targetId,
    name: normalizedName,
    baseUrl: validatedBaseUrl,
    model: normalizedModel,
    maxTokens: validatedMaxTokens,
    interleavedThinking: resolveInterleavedThinkingSetting(normalizedModel, config.interleavedThinking),
    ...(config.tier !== undefined && { tier: config.tier })
  }

  const index = items.findIndex((item) => item.id === targetId)
  if (index >= 0) {
    items[index] = nextRecord
  } else {
    items.push(nextRecord)
  }

  writeCustomModelsRaw(items)

  if (config.apiKey?.trim()) {
    setCustomModelApiKey(targetId, config.apiKey.trim())
  }

  return targetId
}

export function upsertUserInfoConfig(
  config: Omit<UserInfoConfig, "id"> & { id?: string }
): string {
  writeUserInfoModelsRaw(config)
  return config.userName || '';
}

export function getCustomModelPublicConfig(): CustomModelPublicConfig | null {
  const configs = getCustomModelPublicConfigs()
  return configs[0] ?? null
}

export function getCustomModelPublicConfigById(id: string): CustomModelPublicConfig | null {
  migrateLegacyCustomModel()
  const target = readCustomModelsRaw().find((item) => item.id === id)
  return target ? toPublicConfig(target) : null
}

export function getCustomModelPublicConfigs(): CustomModelPublicConfig[] {
  migrateLegacyCustomModel()
  const env = parseEnvFile()
  return readCustomModelsRaw().map((item) => toPublicConfig(item, env))
}

export function setCustomModelConfig(config: CustomModelConfig): void {
  upsertCustomModelConfig(config)
}

export function deleteCustomModelConfig(id: string): void {
  migrateLegacyCustomModel()

  const items = readCustomModelsRaw()
  const existed = items.some((item) => item.id === id)
  const next = items.filter((item) => item.id !== id)
  writeCustomModelsRaw(next)
  if (existed) {
    deleteCustomModelApiKey(id)
  }
}

export function deleteAllCustomModelConfigs(): void {
  migrateLegacyCustomModel()
  if (existsSync(CUSTOM_MODELS_FILE)) {
    unlinkSync(CUSTOM_MODELS_FILE)
  }
  if (existsSync(CUSTOM_MODEL_FILE)) {
    unlinkSync(CUSTOM_MODEL_FILE)
  }
  deleteAllCustomModelApiKeys()
}

// MCP Connectors
const MCP_CONNECTORS_FILE = join(OPENWORK_DIR, "mcp-connectors.json")

export function getMcpConnectorsPath(): string {
  getOpenworkDir()
  return MCP_CONNECTORS_FILE
}

export function getMcpConnectors(): import("./types").McpConnectorConfig[] {
  getOpenworkDir()
  if (!existsSync(MCP_CONNECTORS_FILE)) return []
  try {
    const content = readFileSync(MCP_CONNECTORS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is import("./types").McpConnectorConfig =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).url === "string"
    )
  } catch {
    return []
  }
}

export function getEnabledMcpConnectors(): import("./types").McpConnectorConfig[] {
  return getMcpConnectors().filter((c) => c.enabled)
}

export function upsertMcpConnector(
  config: import("./types").McpConnectorUpsert & { id?: string }
): string {
  getOpenworkDir()
  const items = getMcpConnectors()
  const now = new Date().toISOString()
  const id = config.id ?? uuid()
  const existing = items.find((i) => i.id === id)
  const next: import("./types").McpConnectorConfig = {
    id,
    name: config.name.trim(),
    url: config.url.trim(),
    enabled: config.enabled ?? true,
    advanced: config.advanced,
    lazyLoad: config.lazyLoad ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  const index = items.findIndex((i) => i.id === id)
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(items, null, 2))
  return id
}

export function deleteMcpConnector(id: string): void {
  getOpenworkDir()
  const items = getMcpConnectors().filter((i) => i.id !== id)
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(items, null, 2))
}

export function setMcpConnectorEnabled(id: string, enabled: boolean): void {
  getOpenworkDir()
  const items = getMcpConnectors()
  const target = items.find((i) => i.id === id)
  if (!target) return
  const next = items.map((i) => (i.id === id ? { ...i, enabled, updatedAt: new Date().toISOString() } : i))
  writeFileSync(MCP_CONNECTORS_FILE, JSON.stringify(next, null, 2))
}

// Scheduled Tasks
const SCHEDULED_TASKS_FILE = join(OPENWORK_DIR, "scheduled-tasks.json")

function parseTime(timeStr: string | null | undefined): { hour: number; minute: number } {
  if (!timeStr) return { hour: 9, minute: 0 }
  const [h, m] = timeStr.split(":").map(Number)
  const hour = Number.isFinite(h) && h >= 0 && h <= 23 ? h : 9
  const minute = Number.isFinite(m) && m >= 0 && m <= 59 ? m : 0
  return { hour, minute }
}

export function computeNextRunAt(
  frequency: import("./types").ScheduledTaskFrequency,
  from: Date = new Date(),
  runAtTime?: string | null,
  weekday?: number | null,
  runAt?: string | null,
  intervalMinutes?: number | null
): string | null {
  if (frequency === "manual") return null
  if (frequency === "once") return runAt ?? null
  if (frequency === "interval") {
    const mins = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : 5
    const next = new Date(from)
    next.setMinutes(next.getMinutes() + mins, 0, 0)
    return next.toISOString()
  }
  const { hour, minute } = parseTime(runAtTime)

  if (frequency === "hourly") {
    const next = new Date(from)
    next.setHours(next.getHours() + 1, minute, 0, 0)
    return next.toISOString()
  }

  // Try today's candidate first; only advance if it's already past
  const today = new Date(from)
  today.setHours(hour, minute, 0, 0)

  if (frequency === "daily") {
    if (today >= from) return today.toISOString()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return tomorrow.toISOString()
  }

  if (frequency === "weekdays") {
    const isWeekday = (d: Date): boolean => d.getDay() !== 0 && d.getDay() !== 6
    if (today >= from && isWeekday(today)) return today.toISOString()
    const next = new Date(from)
    do {
      next.setDate(next.getDate() + 1)
    } while (next.getDay() === 0 || next.getDay() === 6)
    next.setHours(hour, minute, 0, 0)
    return next.toISOString()
  }

  if (frequency === "weekly") {
    const raw = weekday ?? from.getDay()
    const targetDay = raw >= 0 && raw <= 6 ? raw : from.getDay()
    if (today >= from && from.getDay() === targetDay) return today.toISOString()
    const next = new Date(from)
    for (let i = 0; i < 7; i++) {
      next.setDate(next.getDate() + 1)
      if (next.getDay() === targetDay) break
    }
    next.setHours(hour, minute, 0, 0)
    return next.toISOString()
  }

  return null
}

export function getScheduledTasks(): import("./types").ScheduledTask[] {
  getOpenworkDir()
  if (!existsSync(SCHEDULED_TASKS_FILE)) return []
  try {
    const content = readFileSync(SCHEDULED_TASKS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is import("./types").ScheduledTask =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).prompt === "string"
    )
  } catch {
    return []
  }
}

export function upsertScheduledTask(
  config: import("./types").ScheduledTaskUpsert & { id?: string }
): string {
  getOpenworkDir()
  const items = getScheduledTasks()
  const now = new Date().toISOString()
  const id = config.id ?? uuid()
  const existing = items.find((i) => i.id === id)
  const next: import("./types").ScheduledTask = {
    id,
    name: config.name.trim(),
    description: config.description.trim(),
    prompt: config.prompt.trim(),
    taskType: config.taskType ?? existing?.taskType ?? "action",
    modelId: config.modelId,
    workDir: config.workDir,
    chatxRobotChatId: config.chatxRobotChatId ?? existing?.chatxRobotChatId ?? null,
    frequency: config.frequency,
    intervalMinutes: config.intervalMinutes ?? existing?.intervalMinutes ?? null,
    runAt: config.runAt ?? existing?.runAt ?? null,
    runAtTime: config.runAtTime ?? existing?.runAtTime ?? null,
    weekday: config.weekday ?? existing?.weekday ?? null,
    enabled: config.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt ?? null,
    lastRunStatus: existing?.lastRunStatus ?? null,
    lastRunError: existing?.lastRunError ?? null,
    nextRunAt: computeNextRunAt(
      config.frequency,
      new Date(),
      config.runAtTime ?? existing?.runAtTime ?? null,
      config.weekday ?? existing?.weekday ?? null,
      config.runAt ?? existing?.runAt ?? null,
      config.intervalMinutes ?? existing?.intervalMinutes ?? null
    )
  }
  const index = items.findIndex((i) => i.id === id)
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
  writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(items, null, 2))
  return id
}

export function deleteScheduledTask(id: string): void {
  getOpenworkDir()
  const items = getScheduledTasks().filter((i) => i.id !== id)
  writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(items, null, 2))
  // Clean up run history for the deleted task
  const runs = readTaskRuns().filter((r) => r.taskId !== id)
  writeFileSync(TASK_RUNS_FILE, JSON.stringify(runs, null, 2))
}

export function setScheduledTaskEnabled(id: string, enabled: boolean): void {
  getOpenworkDir()
  const items = getScheduledTasks()
  const target = items.find((i) => i.id === id)
  if (!target) return
  const now = new Date()
  const next = items.map((i) => {
    if (i.id !== id) return i
    const updated = { ...i, enabled, updatedAt: now.toISOString() }
    if (enabled && i.frequency !== "manual") {
      if (i.frequency === "once") {
        // Don't re-arm a once task whose runAt has already passed
        const runAtDate = i.runAt ? new Date(i.runAt) : null
        updated.nextRunAt = runAtDate && runAtDate > now ? i.runAt : null
      } else {
        updated.nextRunAt = computeNextRunAt(i.frequency, now, i.runAtTime, i.weekday, i.runAt, i.intervalMinutes)
      }
    }
    return updated
  })
  writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(next, null, 2))
}

export function updateScheduledTaskRunResult(
  id: string,
  status: "ok" | "error",
  error: string | null
): void {
  getOpenworkDir()
  const items = getScheduledTasks()
  const target = items.find((i) => i.id === id)
  if (!target) return
  const now = new Date()
  const next = items.map((i) =>
    i.id === id
      ? {
          ...i,
          lastRunAt: now.toISOString(),
          lastRunStatus: status,
          lastRunError: error,
          nextRunAt: i.frequency === "once" ? null : computeNextRunAt(i.frequency, now, i.runAtTime, i.weekday, i.runAt, i.intervalMinutes),
          updatedAt: now.toISOString()
        }
      : i
  )
  writeFileSync(SCHEDULED_TASKS_FILE, JSON.stringify(next, null, 2))
}

// Task Run History
const TASK_RUNS_FILE = join(OPENWORK_DIR, "task-runs.json")
const MAX_RUNS_PER_TASK = 20
const MAX_TOTAL_RUNS = 200

function readTaskRuns(): import("./types").TaskRunRecord[] {
  getOpenworkDir()
  if (!existsSync(TASK_RUNS_FILE)) return []
  try {
    const content = readFileSync(TASK_RUNS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is import("./types").TaskRunRecord =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).taskId === "string"
    )
  } catch {
    return []
  }
}

export function addTaskRunRecord(record: import("./types").TaskRunRecord): void {
  getOpenworkDir()
  const runs = readTaskRuns()
  runs.unshift(record)
  // Trim: keep at most MAX_TOTAL_RUNS overall, MAX_RUNS_PER_TASK per task
  const counts = new Map<string, number>()
  const trimmed = runs.filter((r) => {
    const n = (counts.get(r.taskId) ?? 0) + 1
    counts.set(r.taskId, n)
    return n <= MAX_RUNS_PER_TASK
  }).slice(0, MAX_TOTAL_RUNS)
  writeFileSync(TASK_RUNS_FILE, JSON.stringify(trimmed, null, 2))
}

export function getTaskRunHistory(taskId: string, limit = 10): import("./types").TaskRunRecord[] {
  return readTaskRuns()
    .filter((r) => r.taskId === taskId)
    .slice(0, limit)
}

// Heartbeat
const HEARTBEAT_CONFIG_FILE = join(OPENWORK_DIR, "heartbeat-config.json")
const HEARTBEAT_MD_FILE = join(OPENWORK_DIR, "HEARTBEAT.md")

const DEFAULT_HEARTBEAT_PROMPT =
  "Review the HEARTBEAT.md content provided in your system prompt (Project Context section). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."

function defaultHeartbeatConfig(): import("./types").HeartbeatConfig {
  return {
    enabled: false,
    intervalMinutes: 30,
    prompt: DEFAULT_HEARTBEAT_PROMPT,
    modelId: null,
    workDir: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null
  }
}

export function getHeartbeatConfig(): import("./types").HeartbeatConfig {
  getOpenworkDir()
  if (!existsSync(HEARTBEAT_CONFIG_FILE)) return defaultHeartbeatConfig()
  try {
    const content = readFileSync(HEARTBEAT_CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    const defaults = defaultHeartbeatConfig()
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      intervalMinutes: typeof parsed.intervalMinutes === "number" ? parsed.intervalMinutes : defaults.intervalMinutes,
      prompt: typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt : defaults.prompt,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : defaults.modelId,
      workDir: typeof parsed.workDir === "string" ? parsed.workDir : defaults.workDir,
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : defaults.lastRunAt,
      lastRunStatus: parsed.lastRunStatus === "ok" || parsed.lastRunStatus === "ok_silent" || parsed.lastRunStatus === "skipped" || parsed.lastRunStatus === "error" ? parsed.lastRunStatus : defaults.lastRunStatus,
      lastRunError: typeof parsed.lastRunError === "string" ? parsed.lastRunError : defaults.lastRunError
    }
  } catch {
    return defaultHeartbeatConfig()
  }
}

export function saveHeartbeatConfig(updates: Partial<import("./types").HeartbeatConfig>): void {
  getOpenworkDir()
  const current = getHeartbeatConfig()
  const merged = { ...current, ...updates }
  writeFileSync(HEARTBEAT_CONFIG_FILE, JSON.stringify(merged, null, 2))
}

export function resetHeartbeatConfig(): import("./types").HeartbeatConfig {
  getOpenworkDir()
  const defaults = defaultHeartbeatConfig()
  writeFileSync(HEARTBEAT_CONFIG_FILE, JSON.stringify(defaults, null, 2))
  return defaults
}

export function getHeartbeatContent(): string {
  getOpenworkDir()
  if (!existsSync(HEARTBEAT_MD_FILE)) return ""
  try {
    return readFileSync(HEARTBEAT_MD_FILE, "utf-8")
  } catch {
    return ""
  }
}

export function saveHeartbeatContent(content: string): void {
  getOpenworkDir()
  writeFileSync(HEARTBEAT_MD_FILE, content)
}

// ── Plugins ──

const PLUGINS_DIR = join(OPENWORK_DIR, "plugins")
const PLUGINS_FILE = join(OPENWORK_DIR, "plugins.json")
let _pluginSkillsCache: string[] | null = null
let _pluginMcpCache: Record<string, PluginMcpServerConfig> | null = null

export function getPluginsDir(): string {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true })
  }
  return PLUGINS_DIR
}

export function getPlugins(): PluginMetadata[] {
  getOpenworkDir()
  if (!existsSync(PLUGINS_FILE)) return []
  try {
    const content = readFileSync(PLUGINS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is PluginMetadata =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).path === "string"
    )
  } catch {
    return []
  }
}

function writePlugins(items: PluginMetadata[]): void {
  getOpenworkDir()
  writeFileSync(PLUGINS_FILE, JSON.stringify(items, null, 2))
}

export function upsertPlugin(meta: PluginMetadata): void {
  const items = getPlugins()
  const index = items.findIndex((i) => i.id === meta.id)
  if (index >= 0) {
    items[index] = meta
  } else {
    items.push(meta)
  }
  writePlugins(items)
}

export function deletePlugin(id: string): void {
  const items = getPlugins().filter((i) => i.id !== id)
  writePlugins(items)
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const items = getPlugins()
  if (!items.some((i) => i.id === id)) return
  const next = items.map((i) =>
    i.id === id ? { ...i, enabled, updatedAt: new Date().toISOString() } : i
  )
  writePlugins(next)
}

export function getEnabledPluginSkillsSources(): string[] {
  if (_pluginSkillsCache) return _pluginSkillsCache
  const plugins = getPlugins().filter((p) => p.enabled && p.skillCount > 0)
  const sources: string[] = []
  for (const plugin of plugins) {
    const skillsDir = join(plugin.path, "skills")
    if (existsSync(skillsDir)) {
      sources.push(skillsDir)
    } else {
      const rootSkillMd = join(plugin.path, "SKILL.md")
      if (existsSync(rootSkillMd)) {
        sources.push(plugin.path)
      }
    }
  }
  _pluginSkillsCache = sources
  return sources
}

export function getEnabledPluginMcpConfigs(): Record<string, PluginMcpServerConfig> {
  if (_pluginMcpCache) return _pluginMcpCache
  const plugins = getPlugins().filter((p) => p.enabled && p.mcpServerCount > 0)
  const configs: Record<string, PluginMcpServerConfig> = {}
  for (const plugin of plugins) {
    const mcpJsonPath = join(plugin.path, ".mcp.json")
    const servers = parseMcpJsonFile(mcpJsonPath)
    if (!servers) continue
    for (const [name, cfg] of Object.entries(servers)) {
      configs[`plugin:${plugin.id}/${name}`] = cfg
    }
  }
  _pluginMcpCache = configs
  return configs
}

export function parseMcpJsonFile(filePath: string): Record<string, PluginMcpServerConfig> | null {
  if (!existsSync(filePath)) return null
  try {
    const content = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const servers = (obj.mcpServers ?? obj) as unknown
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return null
    const result: Record<string, PluginMcpServerConfig> = {}
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== "object") continue
      const entry = cfg as Record<string, unknown>
      // Must have at least a "command" or "url" field to be a valid MCP server config
      if (typeof entry.command !== "string" && typeof entry.url !== "string") continue
      // Validate known fields to prevent unexpected data injection
      const validated: PluginMcpServerConfig = {}
      if (typeof entry.command === "string") validated.command = entry.command
      if (Array.isArray(entry.args) && entry.args.every((a): a is string => typeof a === "string")) {
        validated.args = entry.args
      }
      if (typeof entry.url === "string") validated.url = entry.url
      if (entry.transport === "sse" || entry.transport === "streamable-http") {
        validated.transport = entry.transport
      }
      if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
        const headers: Record<string, string> = {}
        for (const [hk, hv] of Object.entries(entry.headers as Record<string, unknown>)) {
          if (typeof hv === "string") headers[hk] = hv
        }
        if (Object.keys(headers).length > 0) validated.headers = headers
      }
      result[name] = validated
    }
    return Object.keys(result).length > 0 ? result : null
  } catch {
    console.warn(`[Plugins] Failed to parse .mcp.json at ${filePath}`)
    return null
  }
}

// ── ChatX ──────────────────────────────────────────────────────────────────────

const CHATX_CONFIG_FILE = join(OPENWORK_DIR, "chatx-config.json")

function defaultChatXConfig(): import("./types").ChatXConfig {
  return {
    enabled: false,
    wsUrl: "",
    userIp: "",
    robots: []
  }
}

export function getChatXConfig(): import("./types").ChatXConfig {
  getOpenworkDir()
  if (!existsSync(CHATX_CONFIG_FILE)) return defaultChatXConfig()
  try {
    const content = readFileSync(CHATX_CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    const defaults = defaultChatXConfig()
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl : defaults.wsUrl,
      userIp: typeof parsed.userIp === "string" ? parsed.userIp : defaults.userIp,
      robots: Array.isArray(parsed.robots)
        ? (parsed.robots as unknown[]).filter(
            (item): item is import("./types").ChatXRobotConfig =>
              item != null &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).chatId === "string" &&
              typeof (item as Record<string, unknown>).fromId === "string" &&
              typeof (item as Record<string, unknown>).clientId === "string" &&
              typeof (item as Record<string, unknown>).clientSecret === "string" &&
              Array.isArray((item as Record<string, unknown>).toUserList)
          )
        : defaults.robots
    }
  } catch {
    return defaultChatXConfig()
  }
}

export function saveChatXConfig(updates: Partial<import("./types").ChatXConfig>): void {
  getOpenworkDir()
  const current = getChatXConfig()
  const merged = { ...current, ...updates }
  writeFileSync(CHATX_CONFIG_FILE, JSON.stringify(merged, null, 2))
}

// ── Sandbox Settings ──────────────────────────────────────────────────────────

const SANDBOX_SETTINGS_FILE = join(OPENWORK_DIR, "sandbox-settings.json")

const SANDBOX_MODES = new Set<"none" | "unelevated" | "readonly" | "elevated">(["none", "unelevated", "readonly", "elevated"])
type SandboxMode = "none" | "unelevated" | "readonly" | "elevated"

function readSandboxSettings(): { mode: SandboxMode; yolo: boolean; nuxCompleted: boolean } {
  if (!existsSync(SANDBOX_SETTINGS_FILE)) return { mode: "unelevated", yolo: false, nuxCompleted: false }
  try {
    const parsed = JSON.parse(readFileSync(SANDBOX_SETTINGS_FILE, "utf-8"))
    return {
      mode: SANDBOX_MODES.has(parsed.mode) ? parsed.mode : "unelevated",
      yolo: parsed.yolo === true,
      nuxCompleted: parsed.nuxCompleted === true
    }
  } catch (err) {
    console.warn("[Storage] Failed to load sandbox settings:", err)
    return { mode: "unelevated", yolo: false, nuxCompleted: false }
  }
}

function updateSandboxSettings(patch: Partial<{ mode: SandboxMode; yolo: boolean; nuxCompleted: boolean }>): void {
  getOpenworkDir()
  const current = readSandboxSettings()
  writeFileSync(SANDBOX_SETTINGS_FILE, JSON.stringify({ ...current, ...patch }, null, 2))
}

export function getWindowsSandboxMode(): SandboxMode {
  return readSandboxSettings().mode
}

export function setWindowsSandboxMode(mode: SandboxMode): void {
  updateSandboxSettings({ mode })
}

export function getYoloMode(): boolean {
  return readSandboxSettings().yolo
}

export function setYoloMode(yolo: boolean): void {
  updateSandboxSettings({ yolo })
}

// ── Sandbox NUX (first-run setup) ────────────────────────────────────────────

export function isSandboxNuxCompleted(): boolean {
  return readSandboxSettings().nuxCompleted
}

export function setSandboxNuxCompleted(): void {
  updateSandboxSettings({ nuxCompleted: true })
}

// ── Keep Awake ───────────────────────────────────────────────────────────────

const KEEP_AWAKE_FILE = join(OPENWORK_DIR, "keep-awake.json")

export function isKeepAwakeEnabled(): boolean {
  if (!existsSync(KEEP_AWAKE_FILE)) return false
  try {
    return JSON.parse(readFileSync(KEEP_AWAKE_FILE, "utf-8")).enabled === true
  } catch { return false }
}

export function setKeepAwakeEnabled(enabled: boolean): void {
  getOpenworkDir()
  writeFileSync(KEEP_AWAKE_FILE, JSON.stringify({ enabled }, null, 2))
}

// ── Approval Rules (persistent) ──────────────────────────────────────────────

const APPROVAL_RULES_FILE = join(OPENWORK_DIR, "approval-rules.json")

interface ApprovalRuleRecord {
  pattern: string
  decision: string
}

export function getApprovalRules(): ApprovalRuleRecord[] {
  getOpenworkDir()
  if (!existsSync(APPROVAL_RULES_FILE)) return []
  try {
    const content = readFileSync(APPROVAL_RULES_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ApprovalRuleRecord =>
        item != null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).pattern === "string" &&
        typeof (item as Record<string, unknown>).decision === "string"
    )
  } catch {
    return []
  }
}

export function addApprovalRule(pattern: string, decision: string): void {
  getOpenworkDir()
  const rules = getApprovalRules()
  const existing = rules.findIndex((r) => r.pattern === pattern)
  if (existing >= 0) {
    rules[existing] = { pattern, decision }
  } else {
    rules.push({ pattern, decision })
  }
  writeFileSync(APPROVAL_RULES_FILE, JSON.stringify(rules, null, 2))
}

export function removeApprovalRule(pattern: string): void {
  getOpenworkDir()
  const rules = getApprovalRules().filter((r) => r.pattern !== pattern)
  writeFileSync(APPROVAL_RULES_FILE, JSON.stringify(rules, null, 2))
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

const HOOKS_FILE = join(OPENWORK_DIR, "hooks.json")

export function getHooks(): HookConfig[] {
  getOpenworkDir()
  if (!existsSync(HOOKS_FILE)) return []
  try {
    const content = readFileSync(HOOKS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is HookConfig => {
        if (item == null || typeof item !== "object") return false
        const h = item as Record<string, unknown>
        if (typeof h.id !== "string" || typeof h.event !== "string") return false
        const hookType = h.type ?? "command"
        if (hookType === "prompt") return typeof h.prompt === "string"
        return typeof h.command === "string"
      }
    )
  } catch {
    return []
  }
}

export function getEnabledHooks(): HookConfig[] {
  return getHooks().filter((h) => h.enabled)
}

function writeHooksAtomic(items: HookConfig[]): void {
  const tmp = HOOKS_FILE + ".tmp"
  writeFileSync(tmp, JSON.stringify(items, null, 2))
  renameSync(tmp, HOOKS_FILE)
}

export function upsertHook(config: HookUpsert & { id?: string }): string {
  getOpenworkDir()
  const items = getHooks()
  const now = new Date().toISOString()
  const id = config.id ?? uuid()
  const existing = items.find((i) => i.id === id)
  const hookType = config.type ?? "command"
  const next: HookConfig = {
    id,
    event: config.event,
    matcher: config.matcher,
    type: hookType,
    command: hookType === "command" ? (config.command ?? "").trim() : undefined,
    prompt: hookType === "prompt" ? config.prompt?.trim() : undefined,
    modelId: hookType === "prompt" ? config.modelId : undefined,
    fallback: hookType === "prompt" ? (config.fallback ?? "allow") : undefined,
    timeout: config.timeout,
    enabled: config.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  const index = items.findIndex((i) => i.id === id)
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
  writeHooksAtomic(items)
  return id
}

export function deleteHook(id: string): void {
  getOpenworkDir()
  const items = getHooks().filter((i) => i.id !== id)
  writeHooksAtomic(items)
}

export function setHookEnabled(id: string, enabled: boolean): void {
  getOpenworkDir()
  const items = getHooks()
  if (!items.some((i) => i.id === id)) return
  const next = items.map((i) =>
    i.id === id ? { ...i, enabled, updatedAt: new Date().toISOString() } : i
  )
  writeHooksAtomic(next)
}

// ─── Smart Model Routing ─────────────────────────────────────────────────────

const ROUTING_SETTINGS_FILE = join(OPENWORK_DIR, "routing-settings.json")

interface RoutingSettings {
  mode: "auto" | "pinned"
}

function readRoutingSettings(): RoutingSettings {
  if (!existsSync(ROUTING_SETTINGS_FILE)) return { mode: "pinned" }
  try {
    const content = readFileSync(ROUTING_SETTINGS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      const m = (parsed as Record<string, unknown>).mode
      if (m === "auto" || m === "pinned") return { mode: m }
    }
  } catch {
    // ignore parse errors, fall back to default
  }
  return { mode: "pinned" }
}

export function getGlobalRoutingMode(): "auto" | "pinned" {
  return readRoutingSettings().mode
}

export function setGlobalRoutingMode(mode: "auto" | "pinned"): void {
  getOpenworkDir()
  writeFileSync(ROUTING_SETTINGS_FILE, JSON.stringify({ mode }, null, 2), "utf-8")
}

/**
 * Get the best model config for a given tier.
 * Priority: exact tier match → fallback tier → configs[0]
 */
export function getModelByTier(tier: "premium" | "economy"): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  if (configs.length === 0) return null
  // treat untagged models as premium
  const exact = configs.find((c) => (c.tier ?? "premium") === tier)
  if (exact) return exact
  // fallback to any available config
  return configs[0]
}
