import { execFile } from "child_process"
import { createDecipheriv, createHash, pbkdf2Sync } from "crypto"
import { access, copyFile, mkdtemp, readFile, readdir, rm, stat } from "fs/promises"
import { homedir, tmpdir } from "os"
import { join, resolve } from "path"
import { promisify } from "util"
import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import type {
  BrowserProfileImportOptions,
  BrowserProfileImportPreview,
  BrowserProfileImportProfile,
  BrowserProfileImportSkipReason,
  BrowserProfileImportSkippedWebsite
} from "../../../shared/browser-types"
import type { BrowserSessionCookie, BrowserSessionData } from "../core/browser-session-data"

const execFileAsync = promisify(execFile)

const CHROME_LOCAL_STATE = "Local State"
const CHROME_PREFERENCES = "Preferences"
const CHROME_COOKIE_STORE_CANDIDATES = [join("Network", "Cookies"), "Cookies"]
const CHROME_SAFE_STORAGE_SERVICES = ["Chrome Safe Storage", "Chromium Safe Storage"]
const MAX_PROFILE_IMPORT_COOKIES = 10_000
const MAX_COOKIE_NAME_CHARS = 4_096
const MAX_COOKIE_DOMAIN_CHARS = 4_096
const MAX_COOKIE_PATH_CHARS = 4_096
const MAX_COOKIE_VALUE_CHARS = 200_000
const DEFAULT_DECRYPTION_TIMEOUT_MS = 5_000
const WINDOWS_EPOCH_TO_UNIX_SECONDS = 11_644_473_600
const LEGACY_SALT = "saltysalt"
const LEGACY_IV = Buffer.alloc(16, 0x20)
const MACOS_LEGACY_ITERATIONS = 1003
const LINUX_LEGACY_ITERATIONS = 1
const LINUX_LEGACY_PASSWORD = "peanuts"

type SqlValue = string | number | Uint8Array | null

interface ChromeCookieQueryRow {
  encrypted_value: SqlValue
  expires_utc: SqlValue
  host_key: SqlValue
  is_httponly: SqlValue
  is_partitioned: SqlValue
  is_secure: SqlValue
  name: SqlValue
  path: SqlValue
  samesite: SqlValue
  top_frame_site_key: SqlValue
  value: SqlValue
}

interface ChromeCookieReadResult {
  cookies: BrowserSessionCookie[]
  skippedCookies: number
  skippedWebsites: BrowserProfileImportSkippedWebsite[]
}

interface BrowserProfileImportReadOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
  timeoutMs?: number
}

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null

function loadSqlJs(): ReturnType<typeof initSqlJs> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs()
  return sqlJsPromise
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

function normalizeEnvPath(value: string | undefined, homeDir: string): string | null {
  const trimmed = value?.trim().replace(/^"(.*)"$/, "$1")
  if (!trimmed) return null
  if (trimmed === "~") return homeDir
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homeDir, trimmed.slice(2))
  }
  return resolve(trimmed)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function getChromeUserDataDirectoryCandidates(
  options: BrowserProfileImportReadOptions
): string[] {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const explicit = [
    normalizeEnvPath(env.CODEX_CHROME_USER_DATA_DIR, home),
    normalizeEnvPath(env.CHROME_USER_DATA_DIR, home)
  ].filter((value): value is string => Boolean(value))

  if (platform === "darwin") {
    return unique([
      ...explicit,
      join(home, "Library", "Application Support", "Google", "Chrome"),
      join(home, "Library", "Application Support", "Chromium")
    ])
  }

  if (platform === "win32") {
    const localAppData =
      (env.LOCALAPPDATA ? normalizeEnvPath(env.LOCALAPPDATA, home) : null) ??
      join(home, "AppData", "Local")
    return unique([
      ...explicit,
      join(localAppData, "Google", "Chrome", "User Data"),
      join(localAppData, "Chromium", "User Data")
    ])
  }

  const configHome =
    (env.XDG_CONFIG_HOME ? normalizeEnvPath(env.XDG_CONFIG_HOME, home) : null) ??
    join(home, ".config")
  return unique([...explicit, join(configHome, "google-chrome"), join(configHome, "chromium")])
}

async function findChromeUserDataDirectory(
  options: BrowserProfileImportReadOptions
): Promise<string | null> {
  for (const candidate of getChromeUserDataDirectoryCandidates(options)) {
    if (await isDirectory(candidate)) return candidate
  }
  return null
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown, maxChars = 100_000): string | undefined {
  return typeof value === "string" && value.length <= maxChars ? value : undefined
}

function getNestedRecord(
  value: Record<string, unknown> | null,
  ...keys: string[]
): Record<string, unknown> {
  let current: unknown = value
  for (const key of keys) {
    current = recordValue(current)[key]
  }
  return recordValue(current)
}

function getNestedString(
  value: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  let current: unknown = value
  for (const key of keys) {
    current = recordValue(current)[key]
  }
  return stringValue(current, 4_096)
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
}

async function resolveChromeCookieStorePath(profilePath: string): Promise<string | null> {
  for (const relative of CHROME_COOKIE_STORE_CANDIDATES) {
    const candidate = join(profilePath, relative)
    if (await isFile(candidate)) return candidate
  }
  return null
}

function compareProfileDirectories(left: string, right: string): number {
  if (left === "Default") return right === "Default" ? 0 : -1
  if (right === "Default") return 1
  const leftProfile = /^Profile (\d+)$/i.exec(left)
  const rightProfile = /^Profile (\d+)$/i.exec(right)
  if (leftProfile && rightProfile) {
    return Number(leftProfile[1]) - Number(rightProfile[1])
  }
  if (leftProfile) return -1
  if (rightProfile) return 1
  return left.localeCompare(right)
}

function getProfileName(preferences: Record<string, unknown> | null): string | undefined {
  const profileName = getNestedString(preferences, "profile", "name")
  if (profileName) return profileName
  const accountInfo = recordValue(preferences).account_info
  if (Array.isArray(accountInfo)) {
    for (const entry of accountInfo) {
      const record = recordValue(entry)
      const fullName = stringValue(record.full_name, 4_096)
      if (fullName) return fullName
      const email = stringValue(record.email, 4_096)
      if (email) return email
    }
  }
  return undefined
}

function chooseSelectedProfile(
  profiles: BrowserProfileImportProfile[],
  localState: Record<string, unknown> | null
): string | undefined {
  const profileState = getNestedRecord(localState, "profile")
  const lastUsed = stringValue(profileState.last_used, 4_096)
  const activeProfiles = getStringArray(profileState.last_active_profiles)
  const profileNames = new Set(profiles.map((profile) => profile.profileDirectory))
  for (const candidate of [lastUsed, ...activeProfiles]) {
    if (candidate && profileNames.has(candidate)) return candidate
  }
  return profiles[0]?.profileDirectory
}

async function discoverChromeProfiles(
  userDataDirectory: string
): Promise<BrowserProfileImportProfile[]> {
  const localState = await readJsonFile(join(userDataDirectory, CHROME_LOCAL_STATE))
  const profileDirectories = new Set<string>()
  const infoCache = getNestedRecord(localState, "profile", "info_cache")
  for (const name of Object.keys(infoCache)) {
    profileDirectories.add(name)
  }

  const entries = await readdir(userDataDirectory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === "Default" || /^Profile \d+$/i.test(entry.name)) {
      profileDirectories.add(entry.name)
      continue
    }
    if (await pathExists(join(userDataDirectory, entry.name, CHROME_PREFERENCES))) {
      profileDirectories.add(entry.name)
    }
  }

  const profiles: BrowserProfileImportProfile[] = []
  for (const profileDirectory of Array.from(profileDirectories).sort(compareProfileDirectories)) {
    const profilePath = join(userDataDirectory, profileDirectory)
    if (!(await isDirectory(profilePath))) continue
    const preferences = await readJsonFile(join(profilePath, CHROME_PREFERENCES))
    profiles.push({
      cookieStoreExists: Boolean(await resolveChromeCookieStorePath(profilePath)),
      profileDirectory,
      profileName: getProfileName(preferences),
      selected: false
    })
  }

  const selectedProfile = chooseSelectedProfile(profiles, localState)
  return profiles.map((profile) => ({
    ...profile,
    selected: profile.profileDirectory === selectedProfile
  }))
}

async function getBrowserProfileImportPreview(
  options: BrowserProfileImportReadOptions = {}
): Promise<BrowserProfileImportPreview> {
  try {
    const userDataDirectory = await findChromeUserDataDirectory(options)
    if (!userDataDirectory) {
      return {
        sourceBrowser: "chrome",
        profiles: [],
        error: "未找到 Chrome User Data 目录"
      }
    }

    const profiles = await discoverChromeProfiles(userDataDirectory)
    return {
      sourceBrowser: "chrome",
      sourceUserDataDirectory: userDataDirectory,
      profiles,
      error: profiles.length === 0 ? "未找到可导入的 Chrome profile" : undefined
    }
  } catch (error) {
    return {
      sourceBrowser: "chrome",
      profiles: [],
      error: `Chrome profile 扫描失败：${formatError(error)}`
    }
  }
}

function sanitizeProfileDirectory(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error("Chrome profile 目录无效")
  }
  return trimmed
}

function chooseImportProfile(
  preview: BrowserProfileImportPreview,
  requestedProfileDirectory: string | undefined
): BrowserProfileImportProfile | undefined {
  if (requestedProfileDirectory) {
    return preview.profiles.find(
      (profile) => profile.profileDirectory === requestedProfileDirectory
    )
  }
  return (
    preview.profiles.find((profile) => profile.selected && profile.cookieStoreExists) ??
    preview.profiles.find((profile) => profile.cookieStoreExists) ??
    preview.profiles.find((profile) => profile.selected) ??
    preview.profiles[0]
  )
}

export async function readBrowserProfileImportData(
  input: BrowserProfileImportOptions,
  options: BrowserProfileImportReadOptions = {}
): Promise<{
  data: BrowserSessionData
  profileDirectory: string
  skippedCookies: number
  skippedWebsites: BrowserProfileImportSkippedWebsite[]
}> {
  if (input.sourceBrowser !== "chrome") {
    throw new Error("不支持的浏览器数据导入来源")
  }

  const profileDirectory = sanitizeProfileDirectory(input.profileDirectory)
  const preview = await getBrowserProfileImportPreview(options)
  if (!preview.sourceUserDataDirectory) {
    throw new Error(preview.error || "未找到 Chrome User Data 目录")
  }

  const profile = chooseImportProfile(preview, profileDirectory)
  if (!profile) {
    throw new Error("未找到可导入的 Chrome profile")
  }
  if (profileDirectory && profile.profileDirectory !== profileDirectory) {
    throw new Error("指定的 Chrome profile 不存在")
  }
  if (!profile.cookieStoreExists) {
    throw new Error("指定的 Chrome profile 没有可导入的 Cookie 数据库")
  }

  if (input.importCookies === false) {
    return {
      data: { cookies: [], localStorage: [] },
      profileDirectory: profile.profileDirectory,
      skippedCookies: 0,
      skippedWebsites: []
    }
  }

  const profilePath = join(preview.sourceUserDataDirectory, profile.profileDirectory)
  const cookieStorePath = await resolveChromeCookieStorePath(profilePath)
  if (!cookieStorePath) {
    throw new Error("指定的 Chrome profile 没有可导入的 Cookie 数据库")
  }

  const localState = await readJsonFile(join(preview.sourceUserDataDirectory, CHROME_LOCAL_STATE))
  const result = await readChromeCookies(cookieStorePath, localState, options)
  console.info(
    `[BrowserProfileImport] Chrome profile data read profile=${profile.profileDirectory} cookies=${result.cookies.length} skipped=${result.skippedCookies}.`
  )
  return {
    data: { cookies: result.cookies, localStorage: [] },
    profileDirectory: profile.profileDirectory,
    skippedCookies: result.skippedCookies,
    skippedWebsites: result.skippedWebsites
  }
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`
}

function getCookieColumns(database: SqlJsDatabase): Set<string> {
  const result = database.exec("PRAGMA table_info(cookies)")
  const columns = new Set<string>()
  for (const row of result[0]?.values ?? []) {
    const name = row[1]
    if (typeof name === "string") columns.add(name)
  }
  return columns
}

function sqliteRows(result: { columns: string[]; values: SqlValue[][] } | undefined): ChromeCookieQueryRow[] {
  if (!result) return []
  return result.values.map((values) => {
    const row: Record<string, SqlValue> = {}
    for (let index = 0; index < result.columns.length; index += 1) {
      row[result.columns[index]] = values[index] ?? null
    }
    return {
      encrypted_value: row.encrypted_value ?? null,
      expires_utc: row.expires_utc ?? null,
      host_key: row.host_key ?? null,
      is_httponly: row.is_httponly ?? null,
      is_partitioned: row.is_partitioned ?? null,
      is_secure: row.is_secure ?? null,
      name: row.name ?? null,
      path: row.path ?? null,
      samesite: row.samesite ?? null,
      top_frame_site_key: row.top_frame_site_key ?? null,
      value: row.value ?? null
    }
  })
}

async function readChromeCookies(
  cookieStorePath: string,
  localState: Record<string, unknown> | null,
  options: BrowserProfileImportReadOptions
): Promise<ChromeCookieReadResult> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "cmb-browser-profile-import-"))
  try {
    const copiedStorePath = join(tempDirectory, "Cookies")
    await copyFile(cookieStorePath, copiedStorePath)
    const databaseBytes = await readFile(copiedStorePath)
    const SQL = await loadSqlJs()
    const database = new SQL.Database(databaseBytes)
    try {
      return await readChromeCookiesFromDatabase(database, localState, options)
    } finally {
      database.close()
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

async function readChromeCookiesFromDatabase(
  database: SqlJsDatabase,
  localState: Record<string, unknown> | null,
  options: BrowserProfileImportReadOptions
): Promise<ChromeCookieReadResult> {
  const availableColumns = getCookieColumns(database)
  const wantedColumns = [
    "host_key",
    "name",
    "value",
    "encrypted_value",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
    "samesite",
    "top_frame_site_key",
    "is_partitioned"
  ]
  const selectColumns = wantedColumns.map((column) =>
    availableColumns.has(column)
      ? `${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(column)}`
      : `NULL AS ${quoteSqlIdentifier(column)}`
  )
  const result = database.exec(
    `SELECT ${selectColumns.join(", ")} FROM cookies LIMIT ${MAX_PROFILE_IMPORT_COOKIES}`
  )
  const decrypter = new ChromeCookieDecrypter({
    localState,
    platform: options.platform ?? process.platform,
    timeoutMs: options.timeoutMs ?? DEFAULT_DECRYPTION_TIMEOUT_MS
  })
  const cookies: BrowserSessionCookie[] = []
  const skippedWebsites = new Map<string, BrowserProfileImportSkippedWebsite>()
  let skippedCookies = 0

  for (const row of sqliteRows(result[0])) {
    const result = await chromeCookieRowToBrowserCookie(row, decrypter)
    if (result.cookie) {
      cookies.push(result.cookie)
    } else {
      skippedCookies += 1
      addSkippedWebsiteForCookieRow(skippedWebsites, row, result.reason ?? "invalid")
    }
  }

  return { cookies, skippedCookies, skippedWebsites: sortedSkippedWebsites(skippedWebsites) }
}

async function chromeCookieRowToBrowserCookie(
  row: ChromeCookieQueryRow,
  decrypter: ChromeCookieDecrypter
): Promise<{ cookie?: BrowserSessionCookie; reason?: BrowserProfileImportSkipReason }> {
  if (booleanFromSqlValue(row.is_partitioned)) return { reason: "partitioned" }
  if (stringFromSqlValue(row.top_frame_site_key, 4_096)) return { reason: "partitioned" }

  const domain = stringFromSqlValue(row.host_key, MAX_COOKIE_DOMAIN_CHARS)
  const name = stringFromSqlValue(row.name, MAX_COOKIE_NAME_CHARS)
  const path = stringFromSqlValue(row.path, MAX_COOKIE_PATH_CHARS) || "/"
  if (!domain || !name) return { reason: "invalid" }

  const encryptedValue = bufferFromSqlValue(row.encrypted_value)
  if (typeof row.value === "string" && row.value.length > MAX_COOKIE_VALUE_CHARS) {
    return { reason: "too_large" }
  }
  let value = stringFromSqlValue(row.value, MAX_COOKIE_VALUE_CHARS) ?? ""
  if (value.length === 0 && encryptedValue.length > 0) {
    const decrypted = await decrypter.decrypt(encryptedValue, domain)
    if (decrypted === null) return { reason: "encrypted" }
    if (decrypted.length > MAX_COOKIE_VALUE_CHARS) return { reason: "too_large" }
    value = decrypted
  }

  return {
    cookie: {
      domain,
      expires: chromeTimeToUnixSeconds(numberFromSqlValue(row.expires_utc)),
      httpOnly: booleanFromSqlValue(row.is_httponly),
      name,
      path,
      sameSite: sameSiteFromChrome(numberFromSqlValue(row.samesite)),
      secure: booleanFromSqlValue(row.is_secure),
      value
    }
  }
}

function addSkippedWebsiteForCookieRow(
  skippedWebsites: Map<string, BrowserProfileImportSkippedWebsite>,
  row: ChromeCookieQueryRow,
  reason: BrowserProfileImportSkipReason
): void {
  const domain = stringFromSqlValue(row.host_key, MAX_COOKIE_DOMAIN_CHARS)
  addSkippedWebsite(skippedWebsites, domain, booleanFromSqlValue(row.is_secure), reason)
}

function addSkippedWebsite(
  skippedWebsites: Map<string, BrowserProfileImportSkippedWebsite>,
  domain: string | undefined,
  secure: boolean,
  reason: BrowserProfileImportSkipReason
): void {
  const normalizedDomain = normalizeCookieDomain(domain)
  const url = normalizedDomain === "(unknown)"
    ? ""
    : `${secure ? "https" : "http"}://${normalizedDomain}/`
  const key = normalizedDomain
  const current =
    skippedWebsites.get(key) ??
    ({
      domain: normalizedDomain,
      reasons: [],
      skippedCookies: 0,
      url
    } satisfies BrowserProfileImportSkippedWebsite)
  current.skippedCookies += 1
  if (!current.reasons.includes(reason)) current.reasons.push(reason)
  skippedWebsites.set(key, current)
}

function normalizeCookieDomain(domain: string | undefined): string {
  const value = domain?.trim().replace(/^\./, "").toLowerCase()
  return value || "(unknown)"
}

function sortedSkippedWebsites(
  skippedWebsites: Map<string, BrowserProfileImportSkippedWebsite>
): BrowserProfileImportSkippedWebsite[] {
  return Array.from(skippedWebsites.values()).sort(
    (left, right) =>
      right.skippedCookies - left.skippedCookies || left.domain.localeCompare(right.domain)
  )
}

function stringFromSqlValue(value: SqlValue, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length > maxChars) return undefined
  return value
}

function numberFromSqlValue(value: SqlValue): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function booleanFromSqlValue(value: SqlValue): boolean {
  const numberValue = numberFromSqlValue(value)
  if (numberValue !== undefined) return numberValue !== 0
  return value === "true"
}

function bufferFromSqlValue(value: SqlValue): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.alloc(0)
}

function chromeTimeToUnixSeconds(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined
  const seconds = Math.floor(value / 1_000_000 - WINDOWS_EPOCH_TO_UNIX_SECONDS)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function sameSiteFromChrome(value: number | undefined): string | undefined {
  switch (value) {
    case 0:
      return "no_restriction"
    case 1:
      return "lax"
    case 2:
      return "strict"
    default:
      return undefined
  }
}

function stripChromeCookieMetadataPrefix(value: Buffer, hostKey: string): Buffer {
  if (value.length <= 32) return value
  const hostHash = createHash("sha256").update(hostKey, "utf8").digest()
  return value.subarray(0, 32).equals(hostHash) ? value.subarray(32) : value
}

function decodeCookiePlaintext(value: Buffer, hostKey: string): string {
  return stripChromeCookieMetadataPrefix(value, hostKey).toString("utf8")
}

function deriveLegacyKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, LEGACY_SALT, iterations, 16, "sha1")
}

function decryptAesCbc(payload: Buffer, key: Buffer, hostKey: string): string | null {
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, LEGACY_IV)
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()])
    return decodeCookiePlaintext(plaintext, hostKey)
  } catch {
    return null
  }
}

function decryptAesGcm(encryptedValue: Buffer, key: Buffer, hostKey: string): string | null {
  if (key.length !== 32) return null
  const payload = encryptedValue.subarray(3)
  if (payload.length <= 28) return null
  try {
    const nonce = payload.subarray(0, 12)
    const ciphertextWithTag = payload.subarray(12)
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16)
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decodeCookiePlaintext(plaintext, hostKey)
  } catch {
    return null
  }
}

async function readMacSafeStoragePassword(timeoutMs: number): Promise<string | null> {
  for (const service of CHROME_SAFE_STORAGE_SERVICES) {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-s", service],
        { encoding: "utf8", timeout: timeoutMs }
      )
      const password = String(stdout).trim()
      if (password) return password
    } catch {
      // Try the next Chromium-family service name.
    }
  }
  return null
}

async function decryptWindowsDpapiPayload(payload: Buffer, timeoutMs: number): Promise<Buffer | null> {
  const normalized = payload.subarray(0, 5).toString("utf8") === "DPAPI" ? payload.subarray(5) : payload
  const base64Payload = normalized.toString("base64").replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('${base64Payload}')
$u = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($u)
`
  for (const binary of ["powershell.exe", "pwsh.exe"]) {
    try {
      const { stdout } = await execFileAsync(
        binary,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
      )
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop()
      if (line) return Buffer.from(line, "base64")
    } catch {
      // Try the next PowerShell binary.
    }
  }
  return null
}

class ChromeCookieDecrypter {
  private readonly localState: Record<string, unknown> | null
  private readonly platform: NodeJS.Platform
  private readonly timeoutMs: number
  private aesGcmKeyPromise: Promise<Buffer | null> | null = null
  private macLegacyKeyPromise: Promise<Buffer | null> | null = null

  constructor(options: {
    localState: Record<string, unknown> | null
    platform: NodeJS.Platform
    timeoutMs: number
  }) {
    this.localState = options.localState
    this.platform = options.platform
    this.timeoutMs = options.timeoutMs
  }

  async decrypt(encryptedValue: Buffer, hostKey: string): Promise<string | null> {
    const prefix = encryptedValue.subarray(0, 3).toString("utf8")
    if (prefix === "v10" || prefix === "v11" || prefix === "v20") {
      const key = await this.getAesGcmKey()
      if (key) {
        const gcmValue = decryptAesGcm(encryptedValue, key, hostKey)
        if (gcmValue !== null) return gcmValue
      }

      if (prefix !== "v20") {
        const legacyKey = await this.getLegacyCbcKey()
        if (legacyKey) {
          return decryptAesCbc(encryptedValue.subarray(3), legacyKey, hostKey)
        }
      }
      return null
    }

    if (this.platform === "win32") {
      const decrypted = await decryptWindowsDpapiPayload(encryptedValue, this.timeoutMs)
      return decrypted ? decodeCookiePlaintext(decrypted, hostKey) : null
    }
    return null
  }

  private getAesGcmKey(): Promise<Buffer | null> {
    if (!this.aesGcmKeyPromise) {
      this.aesGcmKeyPromise = this.loadAesGcmKey()
    }
    return this.aesGcmKeyPromise
  }

  private async loadAesGcmKey(): Promise<Buffer | null> {
    const encryptedKey = getNestedString(this.localState, "os_crypt", "encrypted_key")
    if (!encryptedKey) return null
    let decoded: Buffer
    try {
      decoded = Buffer.from(encryptedKey, "base64")
    } catch {
      return null
    }
    if (decoded.length === 0) return null

    if (this.platform === "win32") {
      const decrypted = await decryptWindowsDpapiPayload(decoded, this.timeoutMs)
      return decrypted && decrypted.length === 32 ? decrypted : null
    }

    if (decoded.subarray(0, 5).toString("utf8") === "DPAPI") return null
    return decoded.length === 32 ? decoded : null
  }

  private getLegacyCbcKey(): Promise<Buffer | null> {
    if (!this.macLegacyKeyPromise) {
      this.macLegacyKeyPromise = this.loadLegacyCbcKey()
    }
    return this.macLegacyKeyPromise
  }

  private async loadLegacyCbcKey(): Promise<Buffer | null> {
    if (this.platform === "darwin") {
      const password = await readMacSafeStoragePassword(this.timeoutMs)
      return password ? deriveLegacyKey(password, MACOS_LEGACY_ITERATIONS) : null
    }
    if (this.platform === "linux") {
      return deriveLegacyKey(LINUX_LEGACY_PASSWORD, LINUX_LEGACY_ITERATIONS)
    }
    return null
  }
}
