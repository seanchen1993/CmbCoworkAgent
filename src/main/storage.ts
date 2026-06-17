import { homedir } from "os"
import { basename, isAbsolute, join, relative, resolve } from "path"
import { createHash } from "crypto"
import { v4 as uuid } from "uuid"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  readdirSync
} from "fs"
import {
  isSupportedHookEvent,
  type HookConfig,
  type HookInjectUserContext,
  type HookUserContextField,
  type HookOnBlockConfig,
  type HookSourceType,
  type HookUpsert
} from "./hooks/types"
import type { AgentAutoCommitSettings, AgentAutoCommitWorkspaceCard } from "./types"
import { normalizeWorkspacePathKey } from "../shared/workspace-path"
import { readdir, rm, mkdir } from "fs/promises"
import { app } from "electron"
import { resolveMcpConnectorKind } from "./mcp/connector-kind"
import type {
  PluginHookMetadata,
  PluginMetadata,
  PluginMcpServerConfig,
  SkillHookMetadata
} from "./types"
import { copyDirRecursive } from "./utils/fs"
import {
  discoverSkills,
  discoverSkillsSync,
  expandSkillMiddlewareSourceDirs,
  makeFlattenedSkillDirName,
  type DiscoveredSkill
} from "./skills/discovery"
import { parseSkillFrontmatter } from "./skills/frontmatter"
import {
  getDiscoveredSkillId,
  isDiscoveredSkillDisabled,
  normalizeSkillId,
  removeDisabledSkillEntriesForSkills,
  resolveDisabledSkillIds
} from "./skills/ids"
import {
  DEFAULT_PLUGIN_HOOKS_PATH,
  getPluginSkillSearchSources,
  readPluginManifest
} from "./plugins/manifest"
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

export function deleteThreadWorkerCheckpoints(parentThreadId: string): number {
  if (!SAFE_ID_RE.test(parentThreadId)) {
    throw new Error(`Invalid threadId: ${parentThreadId}`)
  }
  if (parentThreadId.includes("__worker__")) {
    throw new Error(
      `Invalid coordinator parent threadId: ${parentThreadId}. Parent thread ids may not contain the reserved __worker__ delimiter.`
    )
  }

  const dir = getThreadCheckpointDir()
  const prefix = `${parentThreadId}__worker__`
  let deleted = 0

  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".sqlite")) continue
    const checkpointThreadId = filename.slice(0, -".sqlite".length)
    if (!checkpointThreadId.startsWith(prefix)) continue
    if (!SAFE_ID_RE.test(checkpointThreadId)) continue
    unlinkSync(join(dir, filename))
    deleted += 1
  }

  return deleted
}

/** Delete leftover workflow-subagent checkpoints for a thread. Workflow subagents
 * use a `<parent>__wf_<run>_a<index>` checkpoint thread (subagent.ts), exactly like
 * coordinator workers use `__worker__`. They self-clean in the subagent's `finally`
 * (deleteThreadCheckpoint), so this only sweeps the rare leftovers a crash or a
 * failed cleanup left behind — the symmetric counterpart to
 * deleteThreadWorkerCheckpoints, which only covers `__worker__`. (#3) */
export function deleteThreadWorkflowCheckpoints(parentThreadId: string): number {
  if (!SAFE_ID_RE.test(parentThreadId)) {
    throw new Error(`Invalid threadId: ${parentThreadId}`)
  }
  if (parentThreadId.includes("__wf_")) {
    throw new Error(
      `Invalid workflow parent threadId: ${parentThreadId}. Parent thread ids may not contain the reserved __wf_ delimiter.`
    )
  }

  const dir = getThreadCheckpointDir()
  const prefix = `${parentThreadId}__wf_`
  let deleted = 0

  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".sqlite")) continue
    const checkpointThreadId = filename.slice(0, -".sqlite".length)
    if (!checkpointThreadId.startsWith(prefix)) continue
    if (!SAFE_ID_RE.test(checkpointThreadId)) continue
    unlinkSync(join(dir, filename))
    deleted += 1
  }

  return deleted
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
    const asarOutSkills = join(app.getAppPath(), "out", "skills")
    if (existsSync(asarOutSkills)) return asarOutSkills

    // 有些打包方式会把 out 放在 Resources 目录下（非 asar）
    const resourcesOutSkills = join(process.resourcesPath, "out", "skills")
    if (existsSync(resourcesOutSkills)) return resourcesOutSkills

    // 如果你未来改成 extraResources: Resources/skills
    const resourcesSkills = join(process.resourcesPath, "skills")
    if (existsSync(resourcesSkills)) return resourcesSkills
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
    return JSON.parse(
      readFileSync(SKILL_EVOLUTION_SETTINGS_FILE, "utf-8")
    ) as SkillEvolutionSettings
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
  if (
    Number.isInteger(value) &&
    value >= SKILL_EVOLUTION_THRESHOLD_MIN &&
    value <= SKILL_EVOLUTION_THRESHOLD_MAX
  ) {
    return value
  }
  return SKILL_EVOLUTION_THRESHOLD_DEFAULT
}

export function setSkillEvolutionThreshold(value: number): void {
  const clamped = Math.max(
    SKILL_EVOLUTION_THRESHOLD_MIN,
    Math.min(SKILL_EVOLUTION_THRESHOLD_MAX, Math.round(value))
  )
  const current = readSkillEvolutionSettings()
  writeSkillEvolutionSettings({
    onlineEnabled: current.onlineEnabled === true,
    autoPropose: current.autoPropose === true,
    threshold: clamped
  })
}

// ── Memory settings ──

const MEMORY_SETTINGS_FILE = join(OPENWORK_DIR, "memory-settings.json")

interface MemorySettings {
  enabled?: boolean
  dreamEnabled?: boolean
}

function readMemorySettings(): MemorySettings {
  if (!existsSync(MEMORY_SETTINGS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(MEMORY_SETTINGS_FILE, "utf-8")) as MemorySettings
  } catch {
    return {}
  }
}

function writeMemorySettings(settings: MemorySettings): void {
  getOpenworkDir()
  writeFileSync(MEMORY_SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

export function isMemoryEnabled(): boolean {
  return readMemorySettings().enabled !== false
}

export function setMemoryEnabled(enabled: boolean): void {
  const current = readMemorySettings()
  writeMemorySettings({
    enabled,
    dreamEnabled: enabled ? current.dreamEnabled !== false : false
  })
}

export function isDreamEnabled(): boolean {
  const current = readMemorySettings()
  return current.enabled !== false && current.dreamEnabled !== false
}

export function setDreamEnabled(enabled: boolean): void {
  const current = readMemorySettings()
  const memoryEnabled = current.enabled !== false
  writeMemorySettings({
    enabled: memoryEnabled,
    dreamEnabled: memoryEnabled && enabled
  })
}

// ── Agent auto-commit settings ───────────────────────────────────────────────

const AGENT_AUTO_COMMIT_SETTINGS_FILE = join(OPENWORK_DIR, "agent-auto-commit-settings.json")
const AGENT_AUTO_COMMIT_WORKSPACE_CARDS_FILE = join(
  OPENWORK_DIR,
  "agent-auto-commit-workspace-cards.json"
)

const DEFAULT_AGENT_AUTO_COMMIT_SETTINGS: AgentAutoCommitSettings = {
  mode: "off",
  push: false,
  messageStrategy: "prompt"
}

function normalizeAgentAutoCommitSettings(input: unknown): AgentAutoCommitSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_AGENT_AUTO_COMMIT_SETTINGS }
  }
  const raw = input as Record<string, unknown>
  const mode = raw.mode === "ask" || raw.mode === "always" || raw.mode === "off" ? raw.mode : "off"
  const messageStrategy =
    raw.messageStrategy === "template" ||
    raw.messageStrategy === "prompt" ||
    raw.messageStrategy === "diff"
      ? raw.messageStrategy
      : raw.messageStrategy === "business"
        ? "prompt"
        : "prompt"
  const cardNumber =
    typeof raw.cardNumber === "string" && raw.cardNumber.trim() ? raw.cardNumber.trim() : undefined
  const template =
    typeof raw.template === "string" && raw.template.trim() ? raw.template.trim() : undefined

  return {
    mode,
    push: raw.push === true,
    messageStrategy,
    ...(cardNumber ? { cardNumber } : {}),
    ...(template ? { template } : {})
  }
}

function normalizeWorkspaceCardEntry(
  value: unknown,
  fallbackPath: string
): AgentAutoCommitWorkspaceCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const workspacePath =
    typeof raw.workspacePath === "string" && raw.workspacePath.trim()
      ? raw.workspacePath.trim()
      : fallbackPath
  const cardNumber =
    typeof raw.cardNumber === "string" && raw.cardNumber.trim() ? raw.cardNumber.trim() : undefined
  const updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt.trim() : undefined
  return {
    workspacePath,
    ...(cardNumber ? { cardNumber } : {}),
    ...(updatedAt ? { updatedAt } : {})
  }
}

function readAgentAutoCommitWorkspaceCards(): Record<string, AgentAutoCommitWorkspaceCard> {
  getOpenworkDir()
  if (!existsSync(AGENT_AUTO_COMMIT_WORKSPACE_CARDS_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(AGENT_AUTO_COMMIT_WORKSPACE_CARDS_FILE, "utf-8")) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const entries = raw as Record<string, unknown>
    const cards: Record<string, AgentAutoCommitWorkspaceCard> = {}
    for (const [key, value] of Object.entries(entries)) {
      const card = normalizeWorkspaceCardEntry(value, key)
      if (!card?.workspacePath) continue
      cards[normalizeWorkspacePathKey(card.workspacePath)] = card
    }
    return cards
  } catch {
    return {}
  }
}

function writeAgentAutoCommitWorkspaceCards(
  cards: Record<string, AgentAutoCommitWorkspaceCard>
): void {
  getOpenworkDir()
  writeFileSync(AGENT_AUTO_COMMIT_WORKSPACE_CARDS_FILE, JSON.stringify(cards, null, 2))
}

function getLegacyAgentAutoCommitCardNumber(): string | undefined {
  return getAgentAutoCommitSettings().cardNumber?.trim()
}

export function getAgentAutoCommitSettings(): AgentAutoCommitSettings {
  getOpenworkDir()
  if (!existsSync(AGENT_AUTO_COMMIT_SETTINGS_FILE)) {
    return { ...DEFAULT_AGENT_AUTO_COMMIT_SETTINGS }
  }
  try {
    return normalizeAgentAutoCommitSettings(
      JSON.parse(readFileSync(AGENT_AUTO_COMMIT_SETTINGS_FILE, "utf-8"))
    )
  } catch {
    return { ...DEFAULT_AGENT_AUTO_COMMIT_SETTINGS }
  }
}

export function saveAgentAutoCommitSettings(
  updates: Partial<AgentAutoCommitSettings>
): AgentAutoCommitSettings {
  getOpenworkDir()
  const next = normalizeAgentAutoCommitSettings({
    ...getAgentAutoCommitSettings(),
    ...updates
  })
  const persisted: AgentAutoCommitSettings = {
    mode: next.mode,
    push: next.push,
    messageStrategy: next.messageStrategy,
    // Preserve the legacy global cardNumber so it stays available as the migration
    // fallback for workspaces that have not been configured yet (see
    // getAgentAutoCommitWorkspaceCard). Renderer saves never set this field.
    ...(next.cardNumber ? { cardNumber: next.cardNumber } : {}),
    ...(next.template ? { template: next.template } : {})
  }
  writeFileSync(AGENT_AUTO_COMMIT_SETTINGS_FILE, JSON.stringify(persisted, null, 2))
  return persisted
}

export function getAgentAutoCommitWorkspaceCard(
  workspacePath: string
): AgentAutoCommitWorkspaceCard {
  const trimmedPath = workspacePath.trim()
  if (!trimmedPath) {
    return { workspacePath: "" }
  }
  const key = normalizeWorkspacePathKey(trimmedPath)
  const cards = readAgentAutoCommitWorkspaceCards()
  const existing = cards[key]
  // Any explicit record for this workspace wins — including a "cleared" record
  // with no cardNumber. This is what lets the user clear a workspace card and have
  // it stay cleared instead of leaking the legacy global card back in on reload.
  if (existing) return existing

  // Read-only legacy fallback: only when the workspace has never been configured.
  // Surface the old global card as a soft default without persisting; it becomes a
  // real per-workspace entry once a card is explicitly saved or committed. This
  // keeps the getter side-effect-free and avoids stamping the legacy card onto every
  // workspace the user happens to open.
  const legacyCardNumber = getLegacyAgentAutoCommitCardNumber()
  if (legacyCardNumber) {
    return { workspacePath: trimmedPath, cardNumber: legacyCardNumber }
  }
  return { workspacePath: trimmedPath }
}

export function saveAgentAutoCommitWorkspaceCard(
  workspacePath: string,
  cardNumber: string | undefined
): AgentAutoCommitWorkspaceCard {
  const trimmedPath = workspacePath.trim()
  if (!trimmedPath) {
    throw new Error("缺少工作区路径，无法保存任务卡片")
  }
  const key = normalizeWorkspacePathKey(trimmedPath)
  const cards = readAgentAutoCommitWorkspaceCards()
  const trimmedCard = cardNumber?.trim()
  if (!trimmedCard) {
    // Persist an explicit "cleared" record (no cardNumber) rather than deleting the
    // entry, so getAgentAutoCommitWorkspaceCard does not fall back to the legacy
    // global card for a workspace the user deliberately emptied.
    const cleared: AgentAutoCommitWorkspaceCard = {
      workspacePath: trimmedPath,
      updatedAt: new Date().toISOString()
    }
    cards[key] = cleared
    writeAgentAutoCommitWorkspaceCards(cards)
    return cleared
  }

  const next: AgentAutoCommitWorkspaceCard = {
    workspacePath: trimmedPath,
    cardNumber: trimmedCard,
    updatedAt: new Date().toISOString()
  }
  cards[key] = next
  writeAgentAutoCommitWorkspaceCards(cards)
  return next
}

export function getAgentAutoCommitCardNumberForWorkspace(
  workspacePath: string | undefined
): string | undefined {
  if (!workspacePath?.trim()) return undefined
  return getAgentAutoCommitWorkspaceCard(workspacePath).cardNumber
}

// ── Code exec settings ──

const CODE_EXEC_SETTINGS_FILE = join(OPENWORK_DIR, "code-exec-settings.json")

interface CodeExecSettings {
  enabled?: boolean
}

function readCodeExecSettings(): CodeExecSettings {
  if (!existsSync(CODE_EXEC_SETTINGS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CODE_EXEC_SETTINGS_FILE, "utf-8")) as CodeExecSettings
  } catch {
    return {}
  }
}

export function isCodeExecEnabled(): boolean {
  return readCodeExecSettings().enabled === true
}

export function setCodeExecEnabled(enabled: boolean): void {
  getOpenworkDir()
  writeFileSync(CODE_EXEC_SETTINGS_FILE, JSON.stringify({ enabled }, null, 2))
}

// ── Skills ──

const DISABLED_SKILLS_FILE = join(OPENWORK_DIR, "disabled-skills.json")

function readDisabledSkillEntries(): string[] {
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

function writeDisabledSkillEntries(disabledEntries: string[]): void {
  getOpenworkDir()
  writeFileSync(DISABLED_SKILLS_FILE, JSON.stringify(disabledEntries, null, 2))
  invalidateEnabledSkillsCache()
}

function resolveDisabledSkillEntries(
  disabledEntries: string[],
  sourceDirs = getSkillsSources()
): string[] {
  const skills = sourceDirs.flatMap((sourceDir) => {
    try {
      return discoverSkillsSync(sourceDir)
    } catch {
      return []
    }
  })
  return resolveDisabledSkillIds(disabledEntries, skills)
}

export function getDisabledSkills(): string[] {
  return resolveDisabledSkillEntries(readDisabledSkillEntries())
}

let _disabledSkillDirsCache: string[] | null = null

export function getDisabledSkillDirs(): string[] {
  if (_disabledSkillDirsCache) return _disabledSkillDirsCache
  const disabled = new Set(getDisabledSkills().map((name) => name.trim().toLowerCase()))
  const result =
    disabled.size === 0
      ? []
      : discoverSkillsFromSourcesSync()
          .filter((skill) => isDiscoveredSkillDisabled(skill, disabled))
          .map((skill) => skill.rootDir)
  _disabledSkillDirsCache = result
  return result
}

export function setDisabledSkills(skillIds: string[]): void {
  writeDisabledSkillEntries(resolveDisabledSkillEntries(skillIds))
}

function normalizeSkillDirPath(input: string): string {
  const normalized = resolve(input)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isSameOrChildPath(targetPath: string, parentPath: string): boolean {
  const relPath = relative(normalizeSkillDirPath(parentPath), normalizeSkillDirPath(targetPath))
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath))
}

function discoverSkillsFromSourcesSync(sourceDirs = getSkillsSources()): DiscoveredSkill[] {
  return sourceDirs.flatMap((sourceDir) => {
    try {
      return discoverSkillsSync(sourceDir)
    } catch {
      return []
    }
  })
}

export function findExistingSkillById(skillId: string): DiscoveredSkill | null {
  const normalized = normalizeSkillId(skillId)
  if (!normalized) return null
  return (
    discoverSkillsFromSourcesSync().find((skill) => getDiscoveredSkillId(skill) === normalized) ??
    null
  )
}

function computeDisabledSkillEntriesWithoutSkillDir(skillDir: string): string[] | null {
  const allSkills = discoverSkillsFromSourcesSync()
  const skillsToRemove = allSkills.filter((skill) => isSameOrChildPath(skill.rootDir, skillDir))
  if (skillsToRemove.length === 0) return null

  const remainingSkills = allSkills.filter((skill) => !isSameOrChildPath(skill.rootDir, skillDir))
  const currentEntries = readDisabledSkillEntries()
  const nextEntries = removeDisabledSkillEntriesForSkills(
    currentEntries,
    skillsToRemove,
    remainingSkills
  )
  const unchanged =
    currentEntries.length === nextEntries.length &&
    currentEntries.every((entry, index) => entry === nextEntries[index])
  return unchanged ? null : nextEntries
}

export function clearDisabledSkillsForSkillDir(skillDir: string): void {
  const nextEntries = computeDisabledSkillEntriesWithoutSkillDir(skillDir)
  if (nextEntries) writeDisabledSkillEntries(nextEntries)
}

export function prepareDisabledSkillsCleanupForSkillDir(skillDir: string): () => void {
  const nextEntries = computeDisabledSkillEntriesWithoutSkillDir(skillDir)
  return () => {
    if (nextEntries) writeDisabledSkillEntries(nextEntries)
  }
}

const LEGACY_ENABLED_SKILLS_DIRS = [
  join(OPENWORK_DIR, "enabled-skills"),
  join(OPENWORK_DIR, "enabled-skills-builtin"),
  join(OPENWORK_DIR, "enabled-skills-custom")
]

let _legacyEnabledSkillsCleanup: Promise<void> | null = null

async function cleanupLegacyEnabledSkillsDirsAsync(): Promise<void> {
  if (_legacyEnabledSkillsCleanup) return _legacyEnabledSkillsCleanup
  _legacyEnabledSkillsCleanup = Promise.all(
    LEGACY_ENABLED_SKILLS_DIRS.map(async (dir) => {
      if (!existsSync(dir)) return
      try {
        await rm(dir, { recursive: true, force: true })
        console.log(`[Storage] Removed legacy enabled skills cache: ${dir}`)
      } catch (e) {
        console.warn(`[Storage] Failed to remove legacy enabled skills cache ${dir}:`, e)
      }
    })
  ).then(() => undefined)
  return _legacyEnabledSkillsCleanup
}

/**
 * Invalidate skill-derived caches after skill enablement or plugin changes.
 */
export function invalidateEnabledSkillsCache(): void {
  _pluginSkillsCache = null
  _pluginSkillSourcesCache = null
  _pluginMcpCache = null
  _pluginHooksCache = null
  _skillHooksCache = null
  _skillHookMetadataCache = null
  _disabledSkillDirsCache = null
}

/**
 * Returns original skills sources for the agent. Disabled skills are filtered
 * by the runtime filesystem view instead of copying enabled-only directories.
 */
export async function getEnabledSkillsSources(): Promise<string[]> {
  await cleanupLegacyEnabledSkillsDirsAsync()
  return getSkillsSources()
}

/**
 * Sources passed to deepagents SkillsMiddleware. The middleware discovers only
 * one directory level, so include parent directories for nested skills too.
 */
export async function getEnabledSkillMiddlewareSources(): Promise<string[]> {
  return expandSkillMiddlewareSourceDirs(await getEnabledSkillsSources())
}

const CMB_SKILL_PREFIX = "_cmb_"

/**
 * Remove all _cmb_ prefixed skill directories from {workDir}/.claude/skills/.
 */
export async function cleanCmbSkillsFromClaudeDir(workDir: string): Promise<void> {
  const claudeSkillsDir = join(workDir, ".claude", "skills")
  try {
    const existing = await readdir(claudeSkillsDir, { withFileTypes: true })
    for (const entry of existing) {
      if (entry.isDirectory() && entry.name.startsWith(CMB_SKILL_PREFIX)) {
        await rm(join(claudeSkillsDir, entry.name), { recursive: true, force: true })
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

/**
 * Sync CmbCowork enabled skills to {workDir}/.claude/skills/ so that
 * Claude Code can discover them natively. Only manages _cmb_ prefixed
 * directories — leaves other skills untouched.
 */
export async function syncSkillsToClaudeDir(workDir: string): Promise<void> {
  const claudeSkillsDir = join(workDir, ".claude", "skills")
  await mkdir(claudeSkillsDir, { recursive: true })

  // Clean up old _cmb_ skills
  await cleanCmbSkillsFromClaudeDir(workDir)

  // Copy enabled skills
  const sourceDirs = await getEnabledSkillsSources()
  const disabled = new Set(getDisabledSkills().map((name) => name.trim().toLowerCase()))
  let count = 0
  const usedDestNames = new Map<string, string>()
  for (const sourceDir of sourceDirs) {
    if (!existsSync(sourceDir)) continue
    const skills = await discoverSkills(sourceDir)
    for (const skill of skills) {
      if (isDiscoveredSkillDisabled(skill, disabled)) continue
      const relativeName = skill.relativePath || basename(skill.rootDir)
      let destName = CMB_SKILL_PREFIX + makeFlattenedSkillDirName(relativeName)
      const existingRelativeName = usedDestNames.get(destName)
      if (existingRelativeName && existingRelativeName !== relativeName) {
        const hash = createHash("sha256").update(relativeName).digest("hex").slice(0, 8)
        destName = `${destName}-${hash}`
      }
      usedDestNames.set(destName, relativeName)
      const dest = join(claudeSkillsDir, destName)
      try {
        // Remove existing dest to avoid merge with prior copy (e.g. builtin vs custom same name)
        if (existsSync(dest)) await rm(dest, { recursive: true, force: true })
        await copyDirRecursive(skill.rootDir, dest)
        count++
      } catch (e) {
        console.warn(`[Storage] Failed to sync skill ${skill.name} to Claude dir:`, e)
        try {
          await rm(dest, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
  console.log(`[Storage] Synced ${count} skills to ${claudeSkillsDir}`)
}

// Custom model configurations stored as JSON in ~/.cmbcoworkagent/custom-models.json
export interface CustomModelConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  maxTokens?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

export interface UserInfoConfig {
  sapId?: string //8
  ystId?: string //6
  userName?: string
  originOrgId?: string
  orgName?: string
  pathName?: string
  originPathId?: string
  ystRefreshToken?: string
  ystIdToken?: string
  ystCode?: string
  ystAccessToken?: string
}

export const DEFAULT_MAX_TOKENS = 128_000
export const MIN_MAX_TOKENS = 32_000
export const MAX_MAX_TOKENS = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192
export const MIN_MAX_OUTPUT_TOKENS = 1
export const MAX_MAX_OUTPUT_TOKENS = 100_000
export const DEFAULT_TEMPERATURE = 0.1
export const MIN_TEMPERATURE = 0
export const MAX_TEMPERATURE = 2
export const DEFAULT_TOP_P = 0.95
export const MIN_TOP_P = 0
export const MAX_TOP_P = 1
export const DEFAULT_TOP_K = 40
export const MIN_TOP_K = 0
export const MAX_TOP_K = 1_000

export interface CustomModelPublicConfig {
  id: string
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  maxTokens: number
  maxOutputTokens: number
  temperature: number
  topP: number
  topK: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

interface StoredCustomModelRecord {
  id: string
  name: string
  baseUrl: string
  model: string
  maxTokens?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  interleavedThinking?: boolean
  tier?: "premium" | "economy"
}

const CUSTOM_MODEL_FILE = join(OPENWORK_DIR, "custom-model.json")
const CUSTOM_MODELS_FILE = join(OPENWORK_DIR, "custom-models.json")
const USERINFO_MODELS_FILE = join(OPENWORK_DIR, "userinfo-models.json")
const GOAL_SETTINGS_FILE = join(OPENWORK_DIR, "goal-settings.json")

export interface GoalSettings {
  /**
   * Optional model used by the goal evaluator.
   * Empty / undefined means "use the current effective chat model".
   */
  evaluatorModelId?: string
}

export function getGoalSettings(): GoalSettings {
  getOpenworkDir()
  if (!existsSync(GOAL_SETTINGS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(GOAL_SETTINGS_FILE, "utf-8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const evaluatorModelId = (parsed as { evaluatorModelId?: unknown }).evaluatorModelId
    return typeof evaluatorModelId === "string" && evaluatorModelId.trim()
      ? { evaluatorModelId: evaluatorModelId.trim() }
      : {}
  } catch {
    return {}
  }
}

export function setGoalSettings(settings: GoalSettings): void {
  getOpenworkDir()
  const evaluatorModelId = settings.evaluatorModelId?.trim()
  writeFileSync(
    GOAL_SETTINGS_FILE,
    JSON.stringify(evaluatorModelId ? { evaluatorModelId } : {}, null, 2)
  )
}

function normalizeMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKENS
  }

  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.floor(value)))
}

function normalizeMaxOutputTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_OUTPUT_TOKENS
  }

  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(value)))
}

function normalizeTemperature(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TEMPERATURE
  }

  if (value <= MIN_TEMPERATURE) return DEFAULT_TEMPERATURE
  return Math.min(MAX_TEMPERATURE, value)
}

function normalizeTopP(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOP_P
  }

  if (value <= MIN_TOP_P) return DEFAULT_TOP_P
  return Math.min(MAX_TOP_P, value)
}

function normalizeTopK(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOP_K
  }

  return Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, Math.floor(value)))
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

function assertValidMaxOutputTokens(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_OUTPUT_TOKENS
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `maxOutputTokens 必须是数字，范围为 ${MIN_MAX_OUTPUT_TOKENS} 到 ${MAX_MAX_OUTPUT_TOKENS}`
    )
  }

  const parsed = Math.floor(value)
  if (parsed < MIN_MAX_OUTPUT_TOKENS || parsed > MAX_MAX_OUTPUT_TOKENS) {
    throw new Error(
      `maxOutputTokens 超出范围，必须在 ${MIN_MAX_OUTPUT_TOKENS} 到 ${MAX_MAX_OUTPUT_TOKENS} 之间`
    )
  }

  return parsed
}

function assertValidTemperature(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_TEMPERATURE
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`temperature 必须是数字，范围为 (${MIN_TEMPERATURE}, ${MAX_TEMPERATURE}]`)
  }

  if (value <= MIN_TEMPERATURE || value > MAX_TEMPERATURE) {
    throw new Error(`temperature 超出范围，必须在 (${MIN_TEMPERATURE}, ${MAX_TEMPERATURE}] 之间`)
  }

  return value
}

function assertValidTopP(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_TOP_P
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`top_p 必须是数字，范围为 (${MIN_TOP_P}, ${MAX_TOP_P}]`)
  }

  if (value <= MIN_TOP_P || value > MAX_TOP_P) {
    throw new Error(`top_p 超出范围，必须在 (${MIN_TOP_P}, ${MAX_TOP_P}] 之间`)
  }

  return value
}

function assertValidTopK(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_TOP_K
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`top_k 必须是整数，范围为 ${MIN_TOP_K} 到 ${MAX_TOP_K}`)
  }

  const parsed = Math.floor(value)
  if (parsed < MIN_TOP_K || parsed > MAX_TOP_K) {
    throw new Error(`top_k 超出范围，必须在 ${MIN_TOP_K} 到 ${MAX_TOP_K} 之间`)
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
      maxTokens: normalizeMaxTokens(legacy.maxTokens),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      topP: DEFAULT_TOP_P,
      topK: DEFAULT_TOP_K
    }
    writeCustomModelsRaw([migrated])
  } catch {
    // Ignore migration failures and keep legacy behavior.
  }
}

function toPublicConfig(
  config: StoredCustomModelRecord,
  env?: Record<string, string>
): CustomModelPublicConfig {
  return {
    id: config.id,
    name: config.name || config.model,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!getCustomModelApiKey(config.id, env),
    maxTokens: normalizeMaxTokens(config.maxTokens),
    maxOutputTokens: normalizeMaxOutputTokens(config.maxOutputTokens),
    temperature: normalizeTemperature(config.temperature),
    topP: normalizeTopP(config.topP),
    topK: normalizeTopK(config.topK),
    interleavedThinking: resolveInterleavedThinkingSetting(
      config.model,
      config.interleavedThinking
    ),
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
    maxOutputTokens: normalizeMaxOutputTokens(item.maxOutputTokens),
    temperature: normalizeTemperature(item.temperature),
    topP: normalizeTopP(item.topP),
    topK: normalizeTopK(item.topK),
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
    maxOutputTokens: normalizeMaxOutputTokens(record.maxOutputTokens),
    temperature: normalizeTemperature(record.temperature),
    topP: normalizeTopP(record.topP),
    topK: normalizeTopK(record.topK),
    interleavedThinking: resolveInterleavedThinkingSetting(
      record.model,
      record.interleavedThinking
    ),
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
  const validatedMaxOutputTokens = assertValidMaxOutputTokens(config.maxOutputTokens)
  const validatedTemperature = assertValidTemperature(config.temperature)
  const validatedTopP = assertValidTopP(config.topP)
  const validatedTopK = assertValidTopK(config.topK)
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
    maxOutputTokens: validatedMaxOutputTokens,
    temperature: validatedTemperature,
    topP: validatedTopP,
    topK: validatedTopK,
    interleavedThinking: resolveInterleavedThinkingSetting(
      normalizedModel,
      config.interleavedThinking
    ),
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

export function upsertUserInfoConfig(config: Omit<UserInfoConfig, "id"> & { id?: string }): string {
  writeUserInfoModelsRaw(config)
  return config.userName || ""
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

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === "string") {
      result[key] = entryValue
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeMcpConnector(value: unknown): import("./types").McpConnectorConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const entry = value as Record<string, unknown>
  if (typeof entry.id !== "string" || typeof entry.name !== "string") {
    return null
  }

  const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0
  const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0
  if (entry.kind !== "stdio" && entry.kind !== "remote" && !hasUrl && !hasCommand) {
    return null
  }
  const kind = resolveMcpConnectorKind({
    kind: entry.kind === "stdio" || entry.kind === "remote" ? entry.kind : undefined,
    url: hasUrl ? String(entry.url) : undefined,
    command: hasCommand ? String(entry.command) : undefined
  })

  const advanced =
    entry.advanced && typeof entry.advanced === "object" && !Array.isArray(entry.advanced)
      ? (() => {
          const advancedEntry = entry.advanced as Record<string, unknown>
          const reconnect =
            advancedEntry.reconnect &&
            typeof advancedEntry.reconnect === "object" &&
            !Array.isArray(advancedEntry.reconnect)
              ? {
                  enabled:
                    typeof (advancedEntry.reconnect as Record<string, unknown>).enabled ===
                    "boolean"
                      ? ((advancedEntry.reconnect as Record<string, unknown>).enabled as boolean)
                      : undefined,
                  maxAttempts:
                    typeof (advancedEntry.reconnect as Record<string, unknown>).maxAttempts ===
                    "number"
                      ? ((advancedEntry.reconnect as Record<string, unknown>).maxAttempts as number)
                      : undefined,
                  delayMs:
                    typeof (advancedEntry.reconnect as Record<string, unknown>).delayMs === "number"
                      ? ((advancedEntry.reconnect as Record<string, unknown>).delayMs as number)
                      : undefined
                }
              : undefined
          const transport: import("./types").McpConnectorAdvanced["transport"] =
            advancedEntry.transport === "sse" || advancedEntry.transport === "streamable-http"
              ? advancedEntry.transport
              : undefined

          const normalizedAdvanced: import("./types").McpConnectorAdvanced = {
            headers: normalizeStringRecord(advancedEntry.headers),
            transport,
            reconnect:
              reconnect && Object.values(reconnect).some((field) => field !== undefined)
                ? reconnect
                : undefined
          }
          return normalizedAdvanced
        })()
      : undefined

  const connector: import("./types").McpConnectorConfig = {
    id: entry.id,
    name: entry.name,
    kind,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    lazyLoad: typeof entry.lazyLoad === "boolean" ? entry.lazyLoad : false,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString()
  }

  if (kind === "remote" && hasUrl) {
    connector.url = String(entry.url).trim()
    if (advanced && Object.values(advanced).some((field) => field !== undefined)) {
      connector.advanced = advanced
    }
  }

  if (kind === "stdio" && hasCommand) {
    connector.command = String(entry.command).trim()
    connector.args =
      Array.isArray(entry.args) && entry.args.every((arg): arg is string => typeof arg === "string")
        ? entry.args
        : []
    const env = normalizeStringRecord(entry.env)
    if (env) {
      connector.env = env
    }
  }

  return connector
}

export function getMcpConnectors(): import("./types").McpConnectorConfig[] {
  getOpenworkDir()
  if (!existsSync(MCP_CONNECTORS_FILE)) return []
  try {
    const content = readFileSync(MCP_CONNECTORS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => normalizeMcpConnector(item))
      .filter((item): item is import("./types").McpConnectorConfig => item !== null)
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
  const kind = resolveMcpConnectorKind(config)
  const next: import("./types").McpConnectorConfig = {
    id,
    name: config.name.trim(),
    kind,
    enabled: config.enabled ?? true,
    lazyLoad: config.lazyLoad ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  if (kind === "remote") {
    next.url = config.url?.trim()
    next.advanced = config.advanced
  } else {
    next.command = config.command?.trim()
    next.args = config.args ?? []
    next.env = config.env
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
  const next = items.map((i) =>
    i.id === id ? { ...i, enabled, updatedAt: new Date().toISOString() } : i
  )
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
        updated.nextRunAt = computeNextRunAt(
          i.frequency,
          now,
          i.runAtTime,
          i.weekday,
          i.runAt,
          i.intervalMinutes
        )
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
          nextRunAt:
            i.frequency === "once"
              ? null
              : computeNextRunAt(
                  i.frequency,
                  now,
                  i.runAtTime,
                  i.weekday,
                  i.runAt,
                  i.intervalMinutes
                ),
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
  const trimmed = runs
    .filter((r) => {
      const n = (counts.get(r.taskId) ?? 0) + 1
      counts.set(r.taskId, n)
      return n <= MAX_RUNS_PER_TASK
    })
    .slice(0, MAX_TOTAL_RUNS)
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
      intervalMinutes:
        typeof parsed.intervalMinutes === "number"
          ? parsed.intervalMinutes
          : defaults.intervalMinutes,
      prompt:
        typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt : defaults.prompt,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : defaults.modelId,
      workDir: typeof parsed.workDir === "string" ? parsed.workDir : defaults.workDir,
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : defaults.lastRunAt,
      lastRunStatus:
        parsed.lastRunStatus === "ok" ||
        parsed.lastRunStatus === "ok_silent" ||
        parsed.lastRunStatus === "skipped" ||
        parsed.lastRunStatus === "error"
          ? parsed.lastRunStatus
          : defaults.lastRunStatus,
      lastRunError:
        typeof parsed.lastRunError === "string" ? parsed.lastRunError : defaults.lastRunError
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

// ── LSP Config ──

const LSP_CONFIG_FILE = join(OPENWORK_DIR, "lsp-config.json")
const LSP_RUNTIME_NAMES = ["JavaSE-1.8", "JavaSE-11", "JavaSE-17", "JavaSE-21"] as const

function defaultLspConfig(): import("./types").LspConfig {
  return {
    enabled: false,
    maxHeapMb: 1024,
    lastError: null,
    manualJavaHome: null
  }
}

export function getLspConfig(): import("./types").LspConfig {
  getOpenworkDir()
  if (!existsSync(LSP_CONFIG_FILE)) return defaultLspConfig()
  try {
    const content = readFileSync(LSP_CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    const defaults = defaultLspConfig()
    let manualJavaHome =
      typeof parsed.manualJavaHome === "string" && parsed.manualJavaHome.trim()
        ? parsed.manualJavaHome.trim()
        : defaults.manualJavaHome

    // Backward compatibility: migrate the first legacy per-version path into the single manual override.
    if (!manualJavaHome && parsed.javaRuntimePaths && typeof parsed.javaRuntimePaths === "object") {
      for (const name of LSP_RUNTIME_NAMES) {
        const value = (parsed.javaRuntimePaths as Record<string, unknown>)[name]
        if (typeof value === "string" && value.trim()) {
          manualJavaHome = value.trim()
          break
        }
      }
    }

    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      maxHeapMb: typeof parsed.maxHeapMb === "number" ? parsed.maxHeapMb : defaults.maxHeapMb,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : defaults.lastError,
      manualJavaHome
    }
  } catch {
    return defaultLspConfig()
  }
}

export function saveLspConfig(updates: Partial<import("./types").LspConfig>): void {
  getOpenworkDir()
  const current = getLspConfig()
  const merged = { ...current, ...updates }
  writeFileSync(LSP_CONFIG_FILE, JSON.stringify(merged, null, 2))
}

export function resetLspConfig(): import("./types").LspConfig {
  getOpenworkDir()
  const defaults = defaultLspConfig()
  writeFileSync(LSP_CONFIG_FILE, JSON.stringify(defaults, null, 2))
  return defaults
}

// ── Plugins ──

const PLUGINS_DIR = join(OPENWORK_DIR, "plugins")
const PLUGINS_FILE = join(OPENWORK_DIR, "plugins.json")
const SKILL_HOOKS_FILE = "hooks.json"
const SKILL_HOOKS_FOLDER_FILE = "hooks/hooks.json"
const SKILL_HOOKS_FILES = [SKILL_HOOKS_FILE, SKILL_HOOKS_FOLDER_FILE] as const
let _pluginSkillsCache: string[] | null = null
let _pluginSkillSourcesCache: PluginSkillSourceMetadata[] | null = null
let _pluginMcpCache: Record<string, PluginMcpServerConfig> | null = null
let _pluginHooksCache: PluginHookMetadata[] | null = null
let _skillHooksCache: HookConfig[] | null = null
let _skillHookMetadataCache: SkillHookMetadata[] | null = null

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
  // Plugin enable/disable changes the set of skills that listPluginSkills()
  // and the hook system surface. Invalidate the cache here so the next read
  // rebuilds — otherwise users see stale plugin entries in the slash popover
  // immediately after toggling a plugin in MarketPanel.
  invalidateEnabledSkillsCache()
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

/**
 * Backfill origin for plugins installed before the field existed.
 *
 * Used by the renderer's one-shot legacy migration. Writes plugins.json once
 * for the whole batch so users with many legacy plugins avoid N IPC calls and
 * N file writes.
 *
 * Callers must hold `pluginMutex`.
 */
export function setPluginOriginsBatch(
  updates: ReadonlyArray<{ id: string; origin: "market" | "local" }>
): void {
  const byId = new Map<string, "market" | "local">()
  for (const update of updates) {
    if (
      update &&
      typeof update.id === "string" &&
      (update.origin === "market" || update.origin === "local")
    ) {
      byId.set(update.id, update.origin)
    }
  }
  if (byId.size === 0) return

  const items = getPlugins()
  let changed = false
  const next = items.map((item) => {
    const desired = byId.get(item.id)
    if (!desired || item.origin === desired) return item
    changed = true
    return { ...item, origin: desired }
  })
  if (changed) writePlugins(next)
}

export function getEnabledPluginSkillsSources(): string[] {
  if (_pluginSkillsCache) return _pluginSkillsCache
  _pluginSkillsCache = getEnabledPluginSkillSourceMetadata().map((source) => source.sourceDir)
  return _pluginSkillsCache
}

export async function getEnabledPluginSkillMiddlewareSources(): Promise<string[]> {
  const rootOnlySources: string[] = []
  const nestedSources: string[] = []
  for (const source of getEnabledPluginSkillSourceMetadata()) {
    if (source.maxDepth === 0) rootOnlySources.push(source.sourceDir)
    else nestedSources.push(source.sourceDir)
  }
  return [...rootOnlySources, ...(await expandSkillMiddlewareSourceDirs(nestedSources))]
}

export interface PluginSkillSourceMetadata {
  sourceDir: string
  pluginId: string
  pluginName: string
  pluginRoot: string
  maxDepth?: number
}

export function getEnabledPluginSkillSourceMetadata(): PluginSkillSourceMetadata[] {
  if (_pluginSkillSourcesCache) return _pluginSkillSourcesCache
  // Don't gate on the stored `skillCount` — that value is computed once at
  // install time and stays stale if the in-tree layout shifts (or was wrong
  // to begin with). The downstream discovery walks the filesystem live, so
  // an over-broad enabled-only filter is harmless and catches plugins whose
  // install-time count was 0 due to manifest/layout mismatch.
  const plugins = getPlugins().filter((p) => p.enabled)
  const sources: PluginSkillSourceMetadata[] = []
  for (const plugin of plugins) {
    const manifest = readPluginManifest(plugin.path)?.manifest ?? null
    for (const source of getPluginSkillSearchSources(plugin.path, manifest)) {
      sources.push({
        sourceDir: source.sourceDir,
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginRoot: plugin.path,
        maxDepth: source.maxDepth
      })
    }
  }
  _pluginSkillSourcesCache = sources
  return sources
}

export function getEnabledPluginMcpConfigs(): Record<string, PluginMcpServerConfig> {
  if (_pluginMcpCache) return _pluginMcpCache
  // Same rationale as getEnabledPluginSkillSourceMetadata: don't gate on the
  // stored mcpServerCount. The path here (.mcp.json at plugin root) is fixed
  // so the manifest-mismatch failure mode that bites skills doesn't apply,
  // but the file can also appear or change after install — keeping this
  // count-free means a plugin that didn't ship MCP at install time can grow
  // one without needing to be re-registered. parseMcpJsonFile fast-fails on
  // missing/invalid files so the extra reads cost effectively nothing.
  const plugins = getPlugins().filter((p) => p.enabled)
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
      if (
        Array.isArray(entry.args) &&
        entry.args.every((a): a is string => typeof a === "string")
      ) {
        validated.args = entry.args
      }
      if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
        const env: Record<string, string> = {}
        for (const [ek, ev] of Object.entries(entry.env as Record<string, unknown>)) {
          if (typeof ev === "string") env[ek] = ev
        }
        if (Object.keys(env).length > 0) validated.env = env
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
      if (typeof entry.injectUserHeaders === "boolean") {
        validated.injectUserHeaders = entry.injectUserHeaders
      }
      if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) {
        validated.priority = Math.max(0, Math.min(100, entry.priority))
      }
      if (entry.scope === "plugin-active" || entry.scope === "plugin-installed") {
        validated.scope = entry.scope
      }
      if (entry.fallback && typeof entry.fallback === "object" && !Array.isArray(entry.fallback)) {
        const rawFallback = entry.fallback as Record<string, unknown>
        validated.fallback = {
          enabled: typeof rawFallback.enabled === "boolean" ? rawFallback.enabled : false,
          to: rawFallback.to === "global" ? "global" : undefined,
          match:
            rawFallback.match === "toolName" || rawFallback.match === "toolNameAndSchema"
              ? rawFallback.match
              : undefined,
          safeToRetry:
            typeof rawFallback.safeToRetry === "boolean" ? rawFallback.safeToRetry : false
        }
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

// ── Hook Logging ──────────────────────────────────────────────────────────────
//
// Both flags default to false: no chat UI footprint, no IPC overhead, no disk
// writes unless the user opts in. See HookLoggingConfig in types.ts for the
// behavioral split.

const HOOK_LOGGING_CONFIG_FILE = join(OPENWORK_DIR, "hook-logging.json")

// Read once and cache — checked on every hook execution, doesn't need to hit
// the disk each time. The setter invalidates by overwriting.
let _hookLoggingCache: import("./types").HookLoggingConfig | null = null

function defaultHookLoggingConfig(): import("./types").HookLoggingConfig {
  return { enabled: false, diagnostic: false }
}

export function getHookLoggingConfig(): import("./types").HookLoggingConfig {
  if (_hookLoggingCache) return _hookLoggingCache
  getOpenworkDir()
  if (!existsSync(HOOK_LOGGING_CONFIG_FILE)) {
    _hookLoggingCache = defaultHookLoggingConfig()
    return _hookLoggingCache
  }
  try {
    const parsed = JSON.parse(readFileSync(HOOK_LOGGING_CONFIG_FILE, "utf-8")) as Record<
      string,
      unknown
    >
    const defaults = defaultHookLoggingConfig()
    _hookLoggingCache = {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      diagnostic: typeof parsed.diagnostic === "boolean" ? parsed.diagnostic : defaults.diagnostic
    }
    // Diagnostic requires enabled — clamp here so callers don't need to repeat.
    if (!_hookLoggingCache.enabled) _hookLoggingCache.diagnostic = false
    return _hookLoggingCache
  } catch {
    _hookLoggingCache = defaultHookLoggingConfig()
    return _hookLoggingCache
  }
}

export function saveHookLoggingConfig(
  updates: Partial<import("./types").HookLoggingConfig>
): import("./types").HookLoggingConfig {
  getOpenworkDir()
  const current = getHookLoggingConfig()
  const next: import("./types").HookLoggingConfig = {
    enabled: typeof updates.enabled === "boolean" ? updates.enabled : current.enabled,
    diagnostic: typeof updates.diagnostic === "boolean" ? updates.diagnostic : current.diagnostic
  }
  if (!next.enabled) next.diagnostic = false
  writeFileSync(HOOK_LOGGING_CONFIG_FILE, JSON.stringify(next, null, 2))
  _hookLoggingCache = next
  return next
}

/**
 * Path-only resolver for the log directory — never creates anything. Use this
 * from read-only paths (e.g. startup prune) so disabling Hook logging really
 * means "no disk footprint".
 */
export function resolveHookLogDir(): string {
  return join(OPENWORK_DIR, "hooks", "log")
}

/**
 * Directory holding the rolling jsonl files. Lives at
 * `<openworkDir>/hooks/log/` so the daily files don't pollute the top-level
 * config folder and the "open folder" button can drop the user straight into
 * the right place. Created on demand — only call this when about to write.
 */
export function getHookLogDir(): string {
  getOpenworkDir()
  const dir = resolveHookLogDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Absolute path to the jsonl log file for a given local date. */
export function getHookLogFilePath(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return join(getHookLogDir(), `hooks.${y}-${m}-${d}.jsonl`)
}

// ── Sandbox Settings ──────────────────────────────────────────────────────────

const SANDBOX_SETTINGS_FILE = join(OPENWORK_DIR, "sandbox-settings.json")

const SANDBOX_MODES = new Set<"none" | "unelevated" | "readonly" | "elevated">([
  "none",
  "unelevated",
  "readonly",
  "elevated"
])
type SandboxMode = "none" | "unelevated" | "readonly" | "elevated"

function readSandboxSettings(): { mode: SandboxMode; yolo: boolean; nuxCompleted: boolean } {
  if (!existsSync(SANDBOX_SETTINGS_FILE)) return { mode: "none", yolo: false, nuxCompleted: true }
  try {
    const parsed = JSON.parse(readFileSync(SANDBOX_SETTINGS_FILE, "utf-8"))
    return {
      mode: SANDBOX_MODES.has(parsed.mode) ? parsed.mode : "none",
      yolo: parsed.yolo === true,
      nuxCompleted: parsed.nuxCompleted !== false
    }
  } catch (err) {
    console.warn("[Storage] Failed to load sandbox settings:", err)
    return { mode: "none", yolo: false, nuxCompleted: true }
  }
}

function updateSandboxSettings(
  patch: Partial<{ mode: SandboxMode; yolo: boolean; nuxCompleted: boolean }>
): void {
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
  } catch {
    return false
  }
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

const HOOK_USER_CONTEXT_FIELDS = new Set<HookUserContextField>([
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
    ? record.include.filter((item): item is HookUserContextField =>
        typeof item === "string" && HOOK_USER_CONTEXT_FIELDS.has(item as HookUserContextField)
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
  if (value === "bash" || value === "powershell" || value === "sh") return value
  return undefined
}

/** PR-14 — narrow an unknown JSON object to a HookType, defaulting to
 *  "command". Only the persistable types pass; future-only types fall back to
 *  command so an old binary can still read records written by a newer one
 *  without crashing (graceful forward-compat in the dropped direction). */
function parseHookType(value: unknown): "command" | "prompt" | "http" {
  if (value === "prompt" || value === "http") return value
  return "command"
}

/** PR-14 — headers map; tolerates absent / malformed input. */
function parseHookHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  let any = false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string") {
      out[k] = v
      any = true
    }
  }
  return any ? out : undefined
}

function parseHookStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === "string")
  return out.length > 0 ? out : undefined
}

function parseHookOnBlock(raw: unknown): HookOnBlockConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined

  const onBlockRaw = raw as Record<string, unknown>
  const onBlock: HookOnBlockConfig = {
    reason: normalizeOptionalHookString(onBlockRaw.reason),
    systemMessage: normalizeOptionalHookString(onBlockRaw.systemMessage),
    additionalContext: normalizeOptionalHookString(onBlockRaw.additionalContext),
    requiredSkill: normalizeOptionalHookString(onBlockRaw.requiredSkill)
  }

  if (
    !onBlock.reason &&
    !onBlock.systemMessage &&
    !onBlock.additionalContext &&
    !onBlock.requiredSkill
  ) {
    return undefined
  }

  return onBlock
}

function withHookSource<T extends HookConfig>(
  hook: T,
  hookSourceType: HookSourceType,
  hookSourceRoot: string,
  hookSourcePath: string
): T {
  return {
    ...hook,
    hookSourceType,
    hookSourceRoot,
    hookSourcePath
  }
}

// ── Claude Code format compatibility ─────────────────────────────────────────
// CC hooks.json uses a different structure from our flat array:
//   Global/settings: { EventName: [{ matcher?, hooks: [...] }] }
//   Plugin wrapper:  { description?, hooks: <settings above> }
// CC timeout is in seconds; our HookConfig.timeout is in milliseconds.

const CC_HOOK_EVENTS: ReadonlySet<string> = new Set([
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

function isCcSettingsObj(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => CC_HOOK_EVENTS.has(k) && Array.isArray(obj[k]))
}

type HooksFileFormat = "flat" | "cc_settings" | "cc_plugin" | null

function detectHooksFileFormat(parsed: unknown): HooksFileFormat {
  if (Array.isArray(parsed)) return "flat"
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  // CC plugin wrapper: { description?, hooks: { EventName: [...] } }
  if (
    typeof obj.hooks === "object" &&
    obj.hooks !== null &&
    !Array.isArray(obj.hooks) &&
    isCcSettingsObj(obj.hooks as Record<string, unknown>)
  ) {
    return "cc_plugin"
  }
  if (isCcSettingsObj(obj)) return "cc_settings"
  return null
}

/**
 * Convert a single CC hook command (command | prompt) to a HookConfig.
 * CC timeout is seconds → convert to ms. Returns null for unsupported types (agent, http).
 */
function ccCommandToHookConfig(
  event: HookConfig["event"],
  matcher: string | undefined,
  h: Record<string, unknown>,
  id: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string }
): HookConfig | null {
  // inherit per-hook enabled extension field if present
  const enabled = h.enabled !== false && meta.enabled
  const timeout = parseClaudeHookTimeoutMs(h)
  const once = parseOptionalHookBoolean(h.once)
  const persistAfterInterrupt = parseOptionalHookBoolean(h.persistAfterInterrupt)
  // PR-13b: CC writes `model`; legacy snapshots may still carry `modelId`.
  // Canonicalise to `model` in the in-memory HookConfig.
  const model =
    typeof h.model === "string" ? h.model : typeof h.modelId === "string" ? h.modelId : undefined
  const statusMessage = normalizeOptionalHookString(h.statusMessage)
  const shell = parseHookShell(h.shell)
  // PR-15: accept CC's `async: true` config-layer field.
  const asyncFlag = h.async === true ? true : undefined
  // PR-15: warn-and-drop fields we explicitly don't implement in phase 2.
  if (h.asyncRewake === true) {
    console.warn(
      "[Hooks/CC import] `asyncRewake: true` field ignored (this runtime does not yet support reverse-injection); downgraded to plain async."
    )
  }
  if (h.asyncTimeout !== undefined) {
    console.warn(
      "[Hooks/CC import] `asyncTimeout` field ignored (stdout async protocol not implemented in phase 2; uses hook timeout instead)."
    )
  }
  const hookType =
    typeof h.type === "string" ? h.type : typeof h.prompt === "string" ? "prompt" : "command"

  if (hookType === "command") {
    if (typeof h.command !== "string") return null
    return {
      id,
      event,
      matcher,
      if: normalizeOptionalHookString(h.if),
      type: "command",
      command: h.command,
      shell,
      statusMessage,
      onBlock: parseHookOnBlock(h.onBlock),
      forcedOutcome: parseForcedOutcome(h.forcedOutcome),
      forcedReason: normalizeOptionalHookString(h.forcedReason),
      once,
      persistAfterInterrupt,
      injectUserContext: parseHookInjectUserContext(h.injectUserContext),
      timeout,
      async: asyncFlag,
      enabled,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    }
  }
  if (hookType === "prompt") {
    if (typeof h.prompt !== "string") return null
    return {
      id,
      event,
      matcher,
      if: normalizeOptionalHookString(h.if),
      type: "prompt",
      prompt: h.prompt,
      model,
      fallback: h.fallback === "block" ? "block" : "allow",
      statusMessage,
      onBlock: parseHookOnBlock(h.onBlock),
      forcedOutcome: parseForcedOutcome(h.forcedOutcome),
      forcedReason: normalizeOptionalHookString(h.forcedReason),
      once,
      persistAfterInterrupt,
      injectUserContext: parseHookInjectUserContext(h.injectUserContext),
      timeout,
      async: asyncFlag,
      enabled,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    }
  }
  // PR-14 follow-up — also import CC settings of type:"http" so OMC/
  // oh-my-claudecode bridge configs survive a round trip. We deliberately
  // do NOT honour CC's `if` permission-rule beyond what our runner accepts
  // (the runner's matcher is permissive on unknown syntax). Agent hook type
  // remains unsupported.
  if (hookType === "http") {
    if (typeof h.url !== "string") return null
    return {
      id,
      event,
      matcher,
      if: normalizeOptionalHookString(h.if),
      type: "http",
      url: h.url,
      headers: parseHookHeaders(h.headers),
      allowedEnvVars: parseHookStringArray(h.allowedEnvVars),
      fallback: h.fallback === "block" ? "block" : "allow",
      statusMessage,
      onBlock: parseHookOnBlock(h.onBlock),
      forcedOutcome: parseForcedOutcome(h.forcedOutcome),
      forcedReason: normalizeOptionalHookString(h.forcedReason),
      once,
      persistAfterInterrupt,
      timeout,
      async: asyncFlag,
      enabled,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    }
  }
  // agent: not supported in this runtime — skip silently
  return null
}

/**
 * Expand a CC HooksSettings object { EventName: [{ matcher?, hooks:[...] }] }
 * into a flat HookConfig[]. idPrefix is prepended to each generated id.
 */
function expandCcHooksSettings(
  obj: Record<string, unknown>,
  idPrefix: string,
  meta: { enabled: boolean; createdAt: string; updatedAt: string },
  defaultSkillMatcher?: string
): HookConfig[] {
  const result: HookConfig[] = []
  for (const [eventKey, matchersRaw] of Object.entries(obj)) {
    if (
      !CC_HOOK_EVENTS.has(eventKey) ||
      !Array.isArray(matchersRaw) ||
      !isSupportedHookEvent(eventKey)
    )
      continue
    const event = eventKey
    matchersRaw.forEach((matcherEntry: unknown, mi: number) => {
      if (!matcherEntry || typeof matcherEntry !== "object" || Array.isArray(matcherEntry)) return
      const me = matcherEntry as Record<string, unknown>
      const matcher =
        typeof me.matcher === "string"
          ? me.matcher
          : event === "PreSkillUse" || event === "PostSkillUse"
            ? defaultSkillMatcher
            : undefined
      const hooksArr = Array.isArray(me.hooks) ? me.hooks : []
      hooksArr.forEach((rawHook: unknown, hi: number) => {
        if (!rawHook || typeof rawHook !== "object" || Array.isArray(rawHook)) return
        const rawHookObj = rawHook as Record<string, unknown>
        const rawHookId = normalizeOptionalHookString(rawHookObj.id)
        const cfg = ccCommandToHookConfig(
          event,
          matcher,
          rawHookObj,
          rawHookId ? `${idPrefix}/${event}:${rawHookId}` : `${idPrefix}/${event}:${mi}:${hi}`,
          meta
        )
        if (cfg) result.push(cfg)
      })
    })
  }
  return result
}

// ── end CC format compatibility ───────────────────────────────────────────────

export function getHooks(): HookConfig[] {
  getOpenworkDir()
  if (!existsSync(HOOKS_FILE)) return []
  try {
    const content = readFileSync(HOOKS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    const now = new Date().toISOString()
    const fmt = detectHooksFileFormat(parsed)

    if (fmt === "cc_settings") {
      return expandCcHooksSettings(parsed as Record<string, unknown>, "global", {
        enabled: true,
        createdAt: now,
        updatedAt: now
      })
    }

    // flat (our native format) or unrecognized
    if (fmt !== "flat") return []
    return (parsed as unknown[]).flatMap((item): HookConfig[] => {
      if (item == null || typeof item !== "object") return []
      const h = item as Record<string, unknown>
      if (typeof h.id !== "string" || typeof h.event !== "string") return []
      if (!isSupportedHookEvent(h.event)) return []
      const hookType = parseHookType(h.type)
      if (hookType === "prompt" && typeof h.prompt !== "string") return []
      if (hookType === "command" && typeof h.command !== "string") return []
      if (hookType === "http" && typeof h.url !== "string") return []

      return [
        {
          id: h.id,
          event: h.event as HookConfig["event"],
          matcher: typeof h.matcher === "string" ? h.matcher : undefined,
          if: normalizeOptionalHookString(h.if),
          type: hookType,
          command: typeof h.command === "string" ? h.command : undefined,
          shell: parseHookShell(h.shell),
          // PR-14 — http fields
          url: typeof h.url === "string" ? h.url : undefined,
          headers: parseHookHeaders(h.headers),
          allowedEnvVars: parseHookStringArray(h.allowedEnvVars),
          prompt: typeof h.prompt === "string" ? h.prompt : undefined,
          // PR-13b — prefer CC-aligned `model`, fall back to legacy `modelId`.
          // Canonicalises to `model` in the in-memory HookConfig. Records that
          // only carry `modelId` keep working; they migrate to `model` next
          // time they round-trip through `upsertHook`.
          model:
            typeof h.model === "string"
              ? h.model
              : typeof h.modelId === "string"
                ? h.modelId
                : undefined,
          fallback:
            hookType === "prompt" || hookType === "http"
              ? h.fallback === "block"
                ? "block"
                : "allow"
              : undefined,
          statusMessage: normalizeOptionalHookString(h.statusMessage),
          onBlock: parseHookOnBlock(h.onBlock),
          forcedOutcome: parseForcedOutcome(h.forcedOutcome),
          forcedReason: normalizeOptionalHookString(h.forcedReason),
          once: parseOptionalHookBoolean(h.once),
          persistAfterInterrupt: parseOptionalHookBoolean(h.persistAfterInterrupt),
          injectUserContext: parseHookInjectUserContext(h.injectUserContext),
          timeout: parseNativeHookTimeout(h.timeoutMs) ?? parseNativeHookTimeout(h.timeout),
          async: h.async === true ? true : undefined,
          enabled: h.enabled !== false,
          createdAt: typeof h.createdAt === "string" ? h.createdAt : now,
          updatedAt: typeof h.updatedAt === "string" ? h.updatedAt : now
        }
      ]
    })
  } catch {
    return []
  }
}

/**
 * Load hooks contributed by enabled plugins.
 * Each plugin may have a hooks file (default: hooks/hooks.json) containing an array of HookConfig-like objects.
 */
function buildPluginHookId(pluginId: string, rawId: unknown, index: number): string {
  return `plugin:${pluginId}/${typeof rawId === "string" ? rawId : String(index)}`
}

function parsePluginHooks(plugin: PluginMetadata): PluginHookMetadata[] {
  const hooksRelPath = plugin.hookPath ?? DEFAULT_PLUGIN_HOOKS_PATH
  const hooksFilePath = join(plugin.path, hooksRelPath)
  if (!existsSync(hooksFilePath)) return []

  const addPluginMeta = (configs: HookConfig[]): PluginHookMetadata[] =>
    configs.map((c) => ({
      ...c,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginRoot: plugin.path,
      pluginEnabled: plugin.enabled,
      hookPath: hooksRelPath,
      hookSourceType: "plugin",
      hookSourceRoot: plugin.path,
      hookSourcePath: hooksFilePath
    })) as PluginHookMetadata[]

  try {
    const parsed = JSON.parse(readFileSync(hooksFilePath, "utf-8"))
    const meta = {
      enabled: plugin.enabled,
      createdAt: plugin.createdAt,
      updatedAt: plugin.updatedAt
    }
    const idPrefix = `plugin:${plugin.id}`
    const fmt = detectHooksFileFormat(parsed)

    // ── CC plugin wrapper: { description?, hooks: { EventName: [...] } } ──
    if (fmt === "cc_plugin") {
      const settingsObj = (parsed as Record<string, unknown>).hooks as Record<string, unknown>
      return addPluginMeta(expandCcHooksSettings(settingsObj, idPrefix, meta))
    }

    // ── CC HooksSettings at top level: { EventName: [...] } ──
    if (fmt === "cc_settings") {
      return addPluginMeta(expandCcHooksSettings(parsed as Record<string, unknown>, idPrefix, meta))
    }

    // ── Our flat array format ──
    if (fmt !== "flat") return []
    return addPluginMeta(
      (parsed as unknown[]).flatMap((raw, index): HookConfig[] => {
        if (!raw || typeof raw !== "object") return []
        const h = raw as Record<string, unknown>
        if (typeof h.event !== "string") return []
        if (!isSupportedHookEvent(h.event)) return []

        const hookType = parseHookType(h.type)
        if (hookType === "prompt" && typeof h.prompt !== "string") return []
        if (hookType === "command" && typeof h.command !== "string") return []
        if (hookType === "http" && typeof h.url !== "string") return []

        return [
          {
            id: buildPluginHookId(plugin.id, h.id, index),
            event: h.event as HookConfig["event"],
            matcher: typeof h.matcher === "string" ? h.matcher : undefined,
            if: normalizeOptionalHookString(h.if),
            type: hookType,
            command: typeof h.command === "string" ? h.command : undefined,
            shell: parseHookShell(h.shell),
            url: typeof h.url === "string" ? h.url : undefined,
            headers: parseHookHeaders(h.headers),
            allowedEnvVars: parseHookStringArray(h.allowedEnvVars),
            prompt: typeof h.prompt === "string" ? h.prompt : undefined,
            model:
              typeof h.model === "string"
                ? h.model
                : typeof h.modelId === "string"
                  ? h.modelId
                  : undefined,
            fallback: h.fallback === "block" ? "block" : "allow",
            statusMessage: normalizeOptionalHookString(h.statusMessage),
            onBlock: parseHookOnBlock(h.onBlock),
            forcedOutcome: parseForcedOutcome(h.forcedOutcome),
            forcedReason: normalizeOptionalHookString(h.forcedReason),
            once: parseOptionalHookBoolean(h.once),
            persistAfterInterrupt: parseOptionalHookBoolean(h.persistAfterInterrupt),
            injectUserContext: parseHookInjectUserContext(h.injectUserContext),
            timeout: parseNativeHookTimeout(h.timeoutMs) ?? parseNativeHookTimeout(h.timeout),
            async: h.async === true ? true : undefined,
            enabled: h.enabled !== false,
            createdAt: plugin.createdAt,
            updatedAt: plugin.updatedAt
          }
        ]
      })
    )
  } catch {
    console.warn(`[Plugins] Failed to parse hooks file for plugin ${plugin.name}`)
    return []
  }
}

export function invalidatePluginHooksCache(): void {
  _pluginHooksCache = null
}

export function getEnabledPluginHooks(): HookConfig[] {
  if (_pluginHooksCache) return _pluginHooksCache
  const plugins = getPlugins().filter((p) => p.enabled && (p.hookCount ?? 0) > 0)
  _pluginHooksCache = plugins.flatMap((plugin) => parsePluginHooks(plugin))
  return _pluginHooksCache
}

export function getEnabledPluginHookMetadata(): PluginHookMetadata[] {
  if (_pluginHooksCache) return _pluginHooksCache
  void getEnabledPluginHooks()
  return _pluginHooksCache ?? []
}

export function getPluginHooks(pluginId: string): PluginHookMetadata[] {
  const plugin = getPlugins().find((item) => item.id === pluginId)
  if (!plugin) return []
  return parsePluginHooks(plugin)
}

// ── Skill Hooks ───────────────────────────────────────────────────────────────

function buildSkillHookId(
  skillName: string,
  hooksRelPath: string,
  rawId: unknown,
  index: number
): string {
  const hookId = typeof rawId === "string" ? rawId : String(index)
  const filePrefix = hooksRelPath === SKILL_HOOKS_FILE ? "" : `${hooksRelPath}:`
  return `skill:${skillName}/${filePrefix}${hookId}`
}

function readSkillFrontmatterHooksSettings(skillMdPath: string): Record<string, unknown> | null {
  if (!existsSync(skillMdPath)) return null
  try {
    const { frontmatter } = parseSkillFrontmatter(readFileSync(skillMdPath, "utf-8"))
    const hooksRaw = frontmatter.hooks
    if (!hooksRaw || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) return null

    const hooksObj = hooksRaw as Record<string, unknown>
    const fmt = detectHooksFileFormat(hooksObj)
    if (fmt === "cc_plugin") {
      return hooksObj.hooks as Record<string, unknown>
    }
    if (fmt === "cc_settings") {
      return hooksObj
    }
    return null
  } catch {
    return null
  }
}

export function parseSkillFrontmatterHooks(skillDir: string, skillName: string): HookConfig[] {
  const skillMdPath = join(skillDir, "SKILL.md")
  const settingsObj = readSkillFrontmatterHooksSettings(skillMdPath)
  if (!settingsObj) return []

  const now = new Date().toISOString()
  return expandCcHooksSettings(
    settingsObj,
    `skill:${skillName}/SKILL.md`,
    { enabled: true, createdAt: now, updatedAt: now },
    skillName
  )
}

interface SkillHookSource {
  skillDir: string
  skillName: string
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
}

function collectSkillHookSourcesFromDir(
  sourceDir: string,
  disabledSkills: Set<string>,
  respectDisabledList: boolean,
  seenDirs: Set<string>,
  pluginMeta?: { pluginId: string; pluginName: string; pluginRoot: string },
  maxDepth?: number
): SkillHookSource[] {
  const result: SkillHookSource[] = []
  if (!existsSync(sourceDir)) return result

  const pushSkill = (skill: ReturnType<typeof discoverSkillsSync>[number]): void => {
    if (respectDisabledList && isDiscoveredSkillDisabled(skill, disabledSkills)) return
    const skillDir = skill.rootDir
    if (seenDirs.has(skillDir)) return
    seenDirs.add(skillDir)
    result.push({ skillDir, skillName: skill.name, ...pluginMeta })
  }

  try {
    for (const skill of discoverSkillsSync(sourceDir, maxDepth)) {
      pushSkill(skill)
    }
  } catch {
    console.warn(`[Hooks] Failed to scan skill hooks in ${sourceDir}`)
  }

  return result
}

function getEnabledSkillHookSources(): SkillHookSource[] {
  const disabledSkills = new Set(getDisabledSkills().map((name) => name.trim().toLowerCase()))
  const seenDirs = new Set<string>()
  const sources: SkillHookSource[] = []

  for (const sourceDir of getSkillsSources()) {
    sources.push(...collectSkillHookSourcesFromDir(sourceDir, disabledSkills, true, seenDirs))
  }

  for (const source of getEnabledPluginSkillSourceMetadata()) {
    sources.push(
      ...collectSkillHookSourcesFromDir(
        source.sourceDir,
        disabledSkills,
        false,
        seenDirs,
        { pluginId: source.pluginId, pluginName: source.pluginName, pluginRoot: source.pluginRoot },
        source.maxDepth
      )
    )
  }

  return sources
}

function parseSkillHooks(skillDir: string, skillName: string, hooksRelPath: string): HookConfig[] {
  const hooksFilePath = join(skillDir, hooksRelPath)
  if (!existsSync(hooksFilePath)) return []

  try {
    const parsed = JSON.parse(readFileSync(hooksFilePath, "utf-8"))
    const now = new Date().toISOString()
    const meta = { enabled: true, createdAt: now, updatedAt: now }
    const idPrefix =
      hooksRelPath === SKILL_HOOKS_FILE
        ? `skill:${skillName}`
        : `skill:${skillName}/${hooksRelPath}`
    const fmt = detectHooksFileFormat(parsed)

    if (fmt === "cc_plugin") {
      const settingsObj = (parsed as Record<string, unknown>).hooks as Record<string, unknown>
      return expandCcHooksSettings(settingsObj, idPrefix, meta, skillName)
    }
    if (fmt === "cc_settings") {
      return expandCcHooksSettings(parsed as Record<string, unknown>, idPrefix, meta, skillName)
    }
    if (fmt !== "flat") return []

    return (parsed as unknown[]).flatMap((raw, index): HookConfig[] => {
      if (!raw || typeof raw !== "object") return []
      const h = raw as Record<string, unknown>
      if (typeof h.event !== "string") return []
      if (!isSupportedHookEvent(h.event)) return []
      const hookType = parseHookType(h.type)
      if (hookType === "prompt" && typeof h.prompt !== "string") return []
      if (hookType === "command" && typeof h.command !== "string") return []
      if (hookType === "http" && typeof h.url !== "string") return []
      return [
        {
          id: buildSkillHookId(skillName, hooksRelPath, h.id, index),
          event: h.event as HookConfig["event"],
          matcher:
            typeof h.matcher === "string"
              ? h.matcher
              : h.event === "PreSkillUse" || h.event === "PostSkillUse"
                ? skillName
                : undefined,
          if: normalizeOptionalHookString(h.if),
          type: hookType,
          command: typeof h.command === "string" ? h.command : undefined,
          shell: parseHookShell(h.shell),
          url: typeof h.url === "string" ? h.url : undefined,
          headers: parseHookHeaders(h.headers),
          allowedEnvVars: parseHookStringArray(h.allowedEnvVars),
          prompt: typeof h.prompt === "string" ? h.prompt : undefined,
          model:
            typeof h.model === "string"
              ? h.model
              : typeof h.modelId === "string"
                ? h.modelId
                : undefined,
          fallback: h.fallback === "block" ? "block" : "allow",
          statusMessage: normalizeOptionalHookString(h.statusMessage),
          onBlock: parseHookOnBlock(h.onBlock),
          forcedOutcome: parseForcedOutcome(h.forcedOutcome),
          forcedReason: normalizeOptionalHookString(h.forcedReason),
          once: parseOptionalHookBoolean(h.once),
          persistAfterInterrupt: parseOptionalHookBoolean(h.persistAfterInterrupt),
          injectUserContext: parseHookInjectUserContext(h.injectUserContext),
          timeout: parseNativeHookTimeout(h.timeoutMs) ?? parseNativeHookTimeout(h.timeout),
          async: h.async === true ? true : undefined,
          enabled: h.enabled !== false,
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  } catch {
    console.warn(`[Hooks] Failed to parse skill hooks for "${skillName}"`)
    return []
  }
}

function buildEnabledSkillHookMetadata(): SkillHookMetadata[] {
  return getEnabledSkillHookSources().flatMap(
    ({ skillDir, skillName, pluginId, pluginName, pluginRoot }): SkillHookMetadata[] => {
      const skillMdPath = join(skillDir, "SKILL.md")
      const addSkillMeta = (hookPath: string, hooks: HookConfig[]): SkillHookMetadata[] =>
        hooks.map((hook) => ({
          ...hook,
          skillName,
          skillPath: skillDir,
          skillRoot: skillDir,
          hookPath,
          pluginId,
          pluginName,
          pluginRoot,
          hookSourceType: "skill",
          hookSourceRoot: skillDir,
          hookSourcePath: hookPath
        }))

      const frontmatterHooks = addSkillMeta(
        skillMdPath,
        parseSkillFrontmatterHooks(skillDir, skillName)
      )
      const fileHooks = SKILL_HOOKS_FILES.flatMap((hooksRelPath): SkillHookMetadata[] => {
        const hookPath = join(skillDir, hooksRelPath)
        return addSkillMeta(hookPath, parseSkillHooks(skillDir, skillName, hooksRelPath))
      })
      return [...frontmatterHooks, ...fileHooks]
    }
  )
}

export function getEnabledSkillHookMetadata(): SkillHookMetadata[] {
  if (_skillHookMetadataCache) return _skillHookMetadataCache
  _skillHookMetadataCache = buildEnabledSkillHookMetadata()
  _skillHooksCache = _skillHookMetadataCache
  return _skillHookMetadataCache
}

export function getEnabledSkillHooks(): HookConfig[] {
  if (_skillHooksCache) return _skillHooksCache
  _skillHooksCache = getEnabledSkillHookMetadata()
  return _skillHooksCache
}

export function setPluginHookEnabled(pluginId: string, hookId: string, enabled: boolean): void {
  const plugin = getPlugins().find((item) => item.id === pluginId)
  if (!plugin) {
    throw new Error("Plugin 不存在")
  }

  const hooksRelPath = plugin.hookPath ?? DEFAULT_PLUGIN_HOOKS_PATH
  const hooksFilePath = join(plugin.path, hooksRelPath)
  if (!existsSync(hooksFilePath)) {
    throw new Error("插件 hooks 配置文件不存在")
  }

  const parsed = JSON.parse(readFileSync(hooksFilePath, "utf-8"))
  const fmt = detectHooksFileFormat(parsed)

  if (fmt === "flat") {
    // ── Our flat array format ──
    let found = false
    const next = (parsed as unknown[]).map((raw, index) => {
      if (!raw || typeof raw !== "object") return raw
      const record = raw as Record<string, unknown>
      const currentId = buildPluginHookId(plugin.id, record.id, index)
      if (currentId !== hookId) return raw
      found = true
      return { ...record, enabled }
    })
    if (!found) throw new Error("插件 Hook 不存在")
    writeFileSync(hooksFilePath, JSON.stringify(next, null, 2), "utf-8")
  } else if (fmt === "cc_plugin" || fmt === "cc_settings") {
    // ── CC format: ID = plugin:pluginId/EventName:matcherIdx:hookIdx ──
    // We inject `enabled` into the individual hook object (extension field, non-destructive).
    const idPrefix = `plugin:${plugin.id}`
    const suffix = hookId.startsWith(idPrefix + "/") ? hookId.slice(idPrefix.length + 1) : null
    if (!suffix) throw new Error("插件 Hook 不存在")

    // suffix = "EventName:matcherIdx:hookIdx"
    const lastColon = suffix.lastIndexOf(":")
    const secondLastColon = suffix.lastIndexOf(":", lastColon - 1)
    if (lastColon === -1 || secondLastColon === -1) throw new Error("插件 Hook ID 格式无效")
    const eventName = suffix.slice(0, secondLastColon)
    const matcherIdx = parseInt(suffix.slice(secondLastColon + 1, lastColon), 10)
    const hookIdx = parseInt(suffix.slice(lastColon + 1), 10)

    const root = parsed as Record<string, unknown>
    const settingsObj: Record<string, unknown> =
      fmt === "cc_plugin" ? (root.hooks as Record<string, unknown>) : root

    const matchers = settingsObj[eventName]
    if (!Array.isArray(matchers) || !matchers[matcherIdx]) throw new Error("插件 Hook 不存在")
    const matcherEntry = matchers[matcherIdx] as Record<string, unknown>
    const hooksArr = Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : []
    if (!hooksArr[hookIdx]) throw new Error("插件 Hook 不存在")
    hooksArr[hookIdx] = { ...(hooksArr[hookIdx] as Record<string, unknown>), enabled }
    matcherEntry.hooks = hooksArr
    matchers[matcherIdx] = matcherEntry
    settingsObj[eventName] = matchers
    if (fmt === "cc_plugin") root.hooks = settingsObj

    writeFileSync(hooksFilePath, JSON.stringify(root, null, 2), "utf-8")
  } else {
    throw new Error("插件 hooks 配置格式无效")
  }

  invalidatePluginHooksCache()
}

// ── Workspace Hooks ──────────────────────────────────────────────────────────

const WORKSPACE_HOOKS_DIR = ".cmbdevclaw/hooks"
const TRUSTED_WS_HOOKS_FILE = join(OPENWORK_DIR, "trusted-workspace-hooks.json")

interface TrustedWorkspaceEntry {
  fileHashes: Record<string, string> // filename → sha256
  trustedAt: string
}

function loadTrustedWorkspaceHooks(): Record<string, TrustedWorkspaceEntry> {
  if (!existsSync(TRUSTED_WS_HOOKS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(TRUSTED_WS_HOOKS_FILE, "utf-8")) as Record<
      string,
      TrustedWorkspaceEntry
    >
  } catch {
    return {}
  }
}

function saveTrustedWorkspaceHooks(data: Record<string, TrustedWorkspaceEntry>): void {
  getOpenworkDir()
  const tmp = TRUSTED_WS_HOOKS_FILE + ".tmp"
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, TRUSTED_WS_HOOKS_FILE)
}

function fileContentHash(filePath: string): string {
  const content = readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex")
}

export function isWorkspaceHookTrusted(
  workspacePath: string,
  fileName: string,
  filePath: string
): boolean {
  const trusted = loadTrustedWorkspaceHooks()
  const entry = trusted[workspacePath]
  if (!entry || !entry.fileHashes[fileName]) return false
  return entry.fileHashes[fileName] === fileContentHash(filePath)
}

export function trustWorkspaceHookFile(
  workspacePath: string,
  fileName: string,
  filePath: string
): void {
  const trusted = loadTrustedWorkspaceHooks()
  if (!trusted[workspacePath]) {
    trusted[workspacePath] = { fileHashes: {}, trustedAt: new Date().toISOString() }
  }
  trusted[workspacePath].fileHashes[fileName] = fileContentHash(filePath)
  trusted[workspacePath].trustedAt = new Date().toISOString()
  saveTrustedWorkspaceHooks(trusted)
}

export function trustAllWorkspaceHooks(workspacePath: string): void {
  const hooksDir = join(workspacePath, WORKSPACE_HOOKS_DIR)
  if (!existsSync(hooksDir)) return
  try {
    const files = readdirSync(hooksDir).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      trustWorkspaceHookFile(workspacePath, file, join(hooksDir, file))
    }
  } catch {
    /* ignore */
  }
}

export interface UntrustedWorkspaceHook {
  fileName: string
  filePath: string
  event: string
  command: string
}

export function getUntrustedWorkspaceCommandHooks(workspacePath: string): UntrustedWorkspaceHook[] {
  const hooksDir = join(workspacePath, WORKSPACE_HOOKS_DIR)
  if (!existsSync(hooksDir)) return []
  const result: UntrustedWorkspaceHook[] = []
  try {
    const files = readdirSync(hooksDir).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      const filePath = join(hooksDir, file)
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
        const hookType = resolveWorkspaceHookType(raw)
        if (hookType !== "command") continue
        if (typeof raw.command !== "string") continue
        if (raw.enabled === false) continue
        if (isWorkspaceHookTrusted(workspacePath, file, filePath)) continue
        result.push({
          fileName: file,
          filePath,
          event: typeof raw.event === "string" ? raw.event : "unknown",
          command: raw.command
        })
      } catch {
        /* skip invalid files */
      }
    }
  } catch {
    /* dir read error */
  }
  return result
}

function resolveWorkspaceHookType(raw: Record<string, unknown>): HookConfig["type"] | null {
  if (raw.type === "prompt" || raw.type === "command" || raw.type === "http") return raw.type
  if (typeof raw.url === "string") return "http"
  if (typeof raw.prompt === "string") return "prompt"
  if (typeof raw.command === "string") return "command"
  return null
}

export function getWorkspaceHooks(workspacePath: string): HookConfig[] {
  const hooksDir = join(workspacePath, WORKSPACE_HOOKS_DIR)
  if (!existsSync(hooksDir)) return []
  const result: HookConfig[] = []
  const now = new Date().toISOString()
  try {
    const files = readdirSync(hooksDir).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      const filePath = join(hooksDir, file)
      const baseName = file.replace(/\.json$/, "")
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"))
        const fmt = detectHooksFileFormat(parsed)

        // ── CC multi-hook file (cc_plugin or cc_settings) ──
        if (fmt === "cc_plugin" || fmt === "cc_settings") {
          const settingsObj =
            fmt === "cc_plugin"
              ? ((parsed as Record<string, unknown>).hooks as Record<string, unknown>)
              : (parsed as Record<string, unknown>)
          const hooks = expandCcHooksSettings(settingsObj, `ws:${baseName}`, {
            enabled: true,
            createdAt: now,
            updatedAt: now
          })
          result.push(
            ...hooks.map((hook) => withHookSource(hook, "workspace", workspacePath, filePath))
          )
          continue
        }

        // ── Our single-hook flat object (not an array) ──
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
        const raw = parsed as Record<string, unknown>
        if (typeof raw.event !== "string") continue
        if (!isSupportedHookEvent(raw.event)) continue
        const hookType = resolveWorkspaceHookType(raw)
        if (!hookType) continue
        if (hookType === "prompt" && typeof raw.prompt !== "string") continue
        if (hookType === "command" && typeof raw.command !== "string") continue
        if (hookType === "http" && typeof raw.url !== "string") continue
        if (raw.enabled === false) continue
        result.push(
          withHookSource(
            {
              id: `ws:${baseName}`,
              event: raw.event as HookConfig["event"],
              matcher: typeof raw.matcher === "string" ? raw.matcher : undefined,
              if: normalizeOptionalHookString(raw.if),
              type: hookType,
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
              fallback: raw.fallback === "block" ? "block" : "allow",
              statusMessage: normalizeOptionalHookString(raw.statusMessage),
              onBlock: parseHookOnBlock(raw.onBlock),
              forcedOutcome: parseForcedOutcome(raw.forcedOutcome),
              forcedReason: normalizeOptionalHookString(raw.forcedReason),
              once: parseOptionalHookBoolean(raw.once),
              persistAfterInterrupt: parseOptionalHookBoolean(raw.persistAfterInterrupt),
              injectUserContext: parseHookInjectUserContext(raw.injectUserContext),
              timeout: parseNativeHookTimeout(raw.timeoutMs) ?? parseNativeHookTimeout(raw.timeout),
              async: raw.async === true ? true : undefined,
              enabled: true,
              createdAt: now,
              updatedAt: now
            },
            "workspace",
            workspacePath,
            filePath
          )
        )
      } catch {
        console.warn(`[Hooks] Failed to parse workspace hook file: ${file}`)
      }
    }
  } catch {
    console.warn(`[Hooks] Failed to read workspace hooks dir: ${hooksDir}`)
  }
  return result
}

export function getEnabledHooks(workspacePath?: string): HookConfig[] {
  // Runtime base hooks only. Plugin/skill hooks are added by the run-scoped
  // resolver after the corresponding plugin or skill is actually used.
  const globalHooks = getHooks()
    .filter((h) => h.enabled)
    .map((hook) => withHookSource(hook, "global", getOpenworkDir(), HOOKS_FILE))
  const workspaceHooks = workspacePath ? getWorkspaceHooks(workspacePath) : []
  return [...globalHooks, ...workspaceHooks]
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
    if: normalizeOptionalHookString(config.if),
    type: hookType,
    command: hookType === "command" ? (config.command ?? "").trim() : undefined,
    shell: hookType === "command" ? config.shell : undefined,
    // PR-14 — http hook fields. Stored only when hookType === "http"; we
    // intentionally drop them otherwise so a previously-saved http hook that
    // later gets switched to command/prompt doesn't carry stale fields.
    url: hookType === "http" ? config.url?.trim() : undefined,
    headers: hookType === "http" ? config.headers : undefined,
    allowedEnvVars: hookType === "http" ? config.allowedEnvVars : undefined,
    prompt: hookType === "prompt" ? config.prompt?.trim() : undefined,
    // PR-13b — write `model` only; keep `modelId` absent in new records. The
    // upsert call coming from existing UI may carry either field; prefer the
    // CC-aligned `model`. Loaded records that still have `modelId` are read by
    // `getHookModelRef` at runtime and migrate to `model` next time they're
    // re-saved through this path.
    model: hookType === "prompt" ? (config.model ?? config.modelId) : undefined,
    // PR-14 follow-up — http hooks have the same fallback semantics as prompt
    // (LLM/network failure → user-configured allow/block). Persist for both;
    // command hooks ignore it (exit code 2 is the canonical block signal).
    fallback:
      hookType === "prompt" || hookType === "http" ? (config.fallback ?? "allow") : undefined,
    statusMessage: normalizeOptionalHookString(config.statusMessage),
    onBlock: parseHookOnBlock(config.onBlock),
    forcedOutcome: parseForcedOutcome(config.forcedOutcome),
    forcedReason: normalizeOptionalHookString(config.forcedReason),
    once: config.once,
    persistAfterInterrupt: config.persistAfterInterrupt,
    injectUserContext: parseHookInjectUserContext(config.injectUserContext),
    timeout: config.timeout,
    async: config.async === true ? true : undefined,
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

// ─── Preferred IDE ──────────────────────────────────────────────────────────

const IDE_SETTINGS_FILE = join(OPENWORK_DIR, "ide-settings.json")

type IdeSettings = import("./types").IdeSettings
type PreferredIde = import("./types").PreferredIde
type SupportedIde = import("./types").SupportedIde

function isSupportedIde(value: unknown): value is Exclude<PreferredIde, null> {
  return value === "idea" || value === "vscode" || value === "webstorm"
}

function normalizeExecutablePaths(value: unknown): Partial<Record<SupportedIde, string>> {
  if (!value || typeof value !== "object") return {}
  const normalized: Partial<Record<SupportedIde, string>> = {}

  for (const [key, pathValue] of Object.entries(value as Record<string, unknown>)) {
    if (!isSupportedIde(key) || typeof pathValue !== "string") continue
    const trimmed = pathValue.trim()
    if (trimmed) {
      normalized[key] = trimmed
    }
  }

  return normalized
}

function readIdeSettings(): IdeSettings {
  if (!existsSync(IDE_SETTINGS_FILE)) return { preferredIde: null, executablePaths: {} }
  try {
    const content = readFileSync(IDE_SETTINGS_FILE, "utf-8")
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>
      const preferredIde = record.preferredIde
      return {
        preferredIde: isSupportedIde(preferredIde) ? preferredIde : null,
        executablePaths: normalizeExecutablePaths(record.executablePaths)
      }
    }
  } catch {
    // ignore parse errors, fall back to default
  }
  return { preferredIde: null, executablePaths: {} }
}

function writeIdeSettings(settings: IdeSettings): IdeSettings {
  getOpenworkDir()
  const next: IdeSettings = {
    preferredIde: isSupportedIde(settings.preferredIde) ? settings.preferredIde : null,
    executablePaths: normalizeExecutablePaths(settings.executablePaths)
  }
  writeFileSync(IDE_SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8")
  return next
}

export function getIdeSettings(): IdeSettings {
  return readIdeSettings()
}

export function getPreferredIde(): PreferredIde {
  return readIdeSettings().preferredIde
}

export function setPreferredIde(preferredIde: PreferredIde): PreferredIde {
  return saveIdeSettings({ preferredIde }).preferredIde
}

export function saveIdeSettings(
  partial: Partial<IdeSettings> & {
    executablePaths?: Partial<Record<SupportedIde, string | null | undefined>>
  }
): IdeSettings {
  const current = readIdeSettings()
  const mergedExecutablePaths = { ...current.executablePaths }

  if (partial.executablePaths) {
    for (const [key, pathValue] of Object.entries(partial.executablePaths)) {
      if (!isSupportedIde(key)) continue
      const trimmed = typeof pathValue === "string" ? pathValue.trim() : ""
      if (trimmed) {
        mergedExecutablePaths[key] = trimmed
      } else {
        delete mergedExecutablePaths[key]
      }
    }
  }

  return writeIdeSettings({
    preferredIde:
      partial.preferredIde === undefined
        ? current.preferredIde
        : isSupportedIde(partial.preferredIde)
          ? partial.preferredIde
          : null,
    executablePaths: mergedExecutablePaths
  })
}

export function getConfiguredIdeExecutablePath(ide: SupportedIde): string | null {
  const path = readIdeSettings().executablePaths[ide]
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null
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
