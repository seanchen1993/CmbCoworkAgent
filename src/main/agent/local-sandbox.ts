/**
 * LocalSandbox: Execute shell commands locally on the host machine.
 *
 * Extends FilesystemBackend with command execution capability.
 * Commands run in the workspace directory with configurable timeout and output limits.
 *
 * Security note: This has NO built-in safeguards except for the human-in-the-loop
 * middleware provided by the agent framework. All command approval should be
 * handled via HITL configuration.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants as fsConstants, existsSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  FilesystemBackend,
  type EditResult,
  type WriteResult,
  type ExecuteResponse,
  type SandboxBackendProtocol,
  type GrepMatch,
  type FileInfo
} from "deepagents"
import fg from "fast-glob"
import * as iconv from "iconv-lite"
import * as chardet from "jschardet"
import micromatch from "micromatch"
import { replace } from "./replace"
import type { ToolOrchestrator } from "./tool-orchestrator"
import { assessCommandSafety } from "./exec-policy"
import {
  isWorkspaceElevatedSetupDone,
  isElevatedSetupComplete,
  runElevatedSetupForPaths,
  markWorkspaceElevatedSetupDone,
  normalizeDirKey
} from "../ipc/sandbox"
import { homedir, tmpdir } from "node:os"
import type { HookConfig } from "../hooks/types"
import { runHooks } from "../hooks/runner"

/**
 * Sensitive directories under user profile that sandbox tools should not access.
 * Matches codex's USERPROFILE_READ_ROOT_EXCLUSIONS.
 */
const SENSITIVE_DIR_NAMES = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube",
  ".docker", ".config", ".npm", ".pki", ".terraform.d"
])

const WINDOWS_SANDBOX_OFFLINE_USERNAME = "CodexSandboxOffline"
const WINDOWS_SANDBOX_ONLINE_USERNAME = "CodexSandboxOnline"

/**
 * Check if a path falls within a sensitive directory that should be blocked
 * when sandbox mode is elevated.
 */
function isSensitivePath(filePath: string): boolean {
  const home = homedir()
  const normalized = path.resolve(filePath).replace(/\\/g, "/")
  const homeNorm = home.replace(/\\/g, "/")

  // Only restrict paths under user profile
  if (!normalized.toLowerCase().startsWith(homeNorm.toLowerCase() + "/")) {
    return false
  }

  // Get the first path segment relative to home
  const relative = normalized.slice(homeNorm.length + 1)
  const firstSegment = relative.split("/")[0]
  return SENSITIVE_DIR_NAMES.has(firstSegment.toLowerCase())
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function cmdSetLiteral(value: string): string {
  return value.replace(/"/g, '""')
}

/**
 * Options for LocalSandbox configuration.
 */
export interface LocalSandboxOptions {
  /** Root directory for file operations and command execution (default: process.cwd()) */
  rootDir?: string
  /** Enable virtual path mode where "/" maps to rootDir (default: false) */
  virtualMode?: boolean
  /** Maximum file size in MB for file operations (default: 10) */
  maxFileSizeMb?: number
  /** Command timeout in milliseconds (default: 120000 = 2 minutes) */
  timeout?: number
  /** Maximum output bytes before truncation (default: 100000 = ~100KB) */
  maxOutputBytes?: number
  /** Environment variables to pass to commands (default: process.env) */
  env?: Record<string, string>
  /** Windows sandbox mode: 'unelevated' uses Codex restricted-token sandbox, 'readonly' uses Codex read-only sandbox, 'elevated' uses dedicated sandbox user isolation, 'none' runs directly (default: 'none') */
  windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated"
  /** Full path to codex.exe for Windows sandbox. Falls back to 'codex' on PATH if not provided. */
  codexExePath?: string
  /** Hook configurations for PreToolUse/PostToolUse lifecycle events.
   *  Accepts a getter function so hooks are always read fresh from storage. */
  hooks?: HookConfig[] | (() => HookConfig[])
  /** AbortSignal for cancelling running child processes when the user aborts.
   *  When signalled, any in-flight execute() will kill its child process immediately
   *  (SIGTERM → 200ms → SIGKILL), matching OpenCode/Codex abort behaviour. */
  abortSignal?: AbortSignal
  /** Unique run/thread identifier used for ACL ref-counting across concurrent runs. */
  runId?: string
}

/**
 * LocalSandbox backend with shell command execution.
 *
 * Extends FilesystemBackend to inherit all file operations (ls, read, write,
 * edit, glob, grep) and adds execute() for running shell commands locally.
 *
 * @example
 * ```typescript
 * const sandbox = new LocalSandbox({
 *   rootDir: '/path/to/workspace',
 *   virtualMode: true,
 *   timeout: 60_000,
 * });
 *
 * const result = await sandbox.execute('npm test');
 * console.log(result.output);
 * console.log('Exit code:', result.exitCode);
 * ```
 */
export class LocalSandbox extends FilesystemBackend implements SandboxBackendProtocol {
  /** Unique identifier for this sandbox instance */
  readonly id: string
  /** Run/thread identifier for ACL ref-counting (falls back to this.id). */
  readonly runId: string

  private readonly timeout: number
  private readonly maxOutputBytes: number
  private readonly env: Record<string, string>
  private readonly workingDir: string
  private readonly windowsSandbox: "none" | "unelevated" | "readonly" | "elevated"
  private readonly codexExePath: string
  private readonly getHooks: () => HookConfig[]
  /** Host user's TEMP directory — ACL-granted writable by the elevated sandbox user. */
  private readonly _elevatedMavenTempDir: string
  /** Host user's real home directory — for locating ~/.m2/settings.xml etc. */
  private readonly _realUserHome: string
  /** Optional orchestrator for fine-grained approval + sandbox retry */
  private orchestrator?: ToolOrchestrator
  /** When true, block direct git add/commit/push and force git_workflow usage. */
  private enforceGitWorkflowCommitOnly = false
  /** AbortSignal: when signalled, in-flight child processes are killed immediately. */
  private abortSignal?: AbortSignal
  /** Whether the conversation-level abort signal has been triggered. */
  get isAborted(): boolean { return this.abortSignal?.aborted ?? false }
  /** Cached from parent's private fields to avoid (this as any) scattered everywhere */
  private readonly _resolvePath: (key: string) => string
  private readonly _virtualMode: boolean
  private readonly _cwd: string
  private readonly _maxFileSizeBytes: number
  /** Per-file Promise chain lock to serialize concurrent read-write operations */
  private readonly _fileLocks = new Map<string, Promise<void>>()
  /** mtime recorded after each successful read/write, for external-modification detection */
  private readonly _fileReadTimes = new Map<string, number>()

  private static getElevatedSandboxUserProfileRoot(networkEnabled: boolean): string {
    const username = networkEnabled ? WINDOWS_SANDBOX_ONLINE_USERNAME : WINDOWS_SANDBOX_OFFLINE_USERNAME
    const systemDrive = process.env.SystemDrive || "C:"
    return path.win32.join(systemDrive, "Users", username)
  }

  private static buildElevatedSandboxEnvPreamble(shellBase: string, realTempDir: string, realUserHome: string): string {
    const profileRoot = LocalSandbox.getElevatedSandboxUserProfileRoot(true)
    const homeDrive = path.win32.parse(profileRoot).root.replace(/\\$/, "")
    const homePath = profileRoot.slice(homeDrive.length) || "\\"
    const localAppData = path.win32.join(profileRoot, "AppData", "Local")
    const roamingAppData = path.win32.join(profileRoot, "AppData", "Roaming")
    // Use the host user's real TEMP for maven.repo.local — it is ACL-granted writable by
    // the sandbox user (included in write_roots during elevated setup). The sandbox user's
    // own profile TEMP (C:\Users\CodexSandboxOnline\...\Temp) is NOT granted write access
    // by the ACL setup, so we must NOT redirect TEMP/TMP to it.
    const mavenRepoLocal = path.win32.join(realTempDir, "m2-sandbox-repo")
    // JVM user.home override: the sandbox redirects USERPROFILE, which causes JVM
    // tools (Maven, Gradle, sbt, etc.) to look for configs under the sandbox user's
    // empty home. Setting -Duser.home to the real user home lets all JVM tools find
    // their default configs (~/.m2/settings.xml, ~/.gradle/, etc.) without us having
    // to know the exact location of each config file.
    const envOverrides: Array<[string, string]> = [
      ["USERPROFILE", profileRoot],
      ["HOME", profileRoot],
      ["HOMEDRIVE", homeDrive],
      ["HOMEPATH", homePath],
      ["APPDATA", roamingAppData],
      ["LOCALAPPDATA", localAppData],
      // TEMP/TMP intentionally NOT redirected: the sandbox user profile's Temp directory
      // is not ACL-writable, but the host user's TEMP (used for maven.repo.local) is.
      ["USERNAME", WINDOWS_SANDBOX_ONLINE_USERNAME],
      ["LOGNAME", WINDOWS_SANDBOX_ONLINE_USERNAME]
    ]

    if (shellBase === "cmd") {
      const base = envOverrides
        .map(([key, value]) => `set "${key}=${cmdSetLiteral(value)}"`)
        .join(" & ")
      // Redirect maven.repo.local to writable temp dir, and set JVM user.home to the
      // real user home so all JVM tools find their configs automatically.
      const jvmOpts = `set "MAVEN_OPTS=%MAVEN_OPTS% -Dmaven.repo.local=${cmdSetLiteral(mavenRepoLocal)} -Duser.home=${cmdSetLiteral(realUserHome)}"`
      return `${base} & ${jvmOpts}`
    }

    if (shellBase === "pwsh" || shellBase === "powershell") {
      const base = envOverrides
        .map(([key, value]) => `$env:${key}=${powershellSingleQuote(value)}`)
        .join("; ")
      // Redirect maven.repo.local to writable temp dir, and set JVM user.home to the
      // real user home so all JVM tools find their configs automatically.
      const jvmOpts = `$env:MAVEN_OPTS="$($env:MAVEN_OPTS) -Dmaven.repo.local=${mavenRepoLocal.replace(/\\/g, "\\\\")} -Duser.home=${realUserHome.replace(/\\/g, "\\\\")}"`
      return `${base}; ${jvmOpts}`
    }

    return ""
  }

  private static shouldFallbackToUnelevatedForNetworkAuth(output: string): boolean {
    const lower = output.toLowerCase()
    return lower.includes("sec_e_no_credentials")
      || lower.includes("no credentials are available in the security package")
      || output.includes("安全包中没有凭据")
      || (lower.includes("schannel") && lower.includes("credential"))
      || (output.includes("Invoke-WebRequest") && output.includes("认证失败"))
  }

  constructor(options: LocalSandboxOptions = {}) {
    super({
      rootDir: options.rootDir,
      virtualMode: options.virtualMode,
      maxFileSizeMb: options.maxFileSizeMb
    })

    this.id = `local-sandbox-${randomUUID().slice(0, 8)}`
    this.runId = options.runId ?? this.id
    this.timeout = options.timeout ?? 60_000 // 1 minute default
    this.maxOutputBytes = options.maxOutputBytes ?? 100_000 // ~100KB default
    const baseEnv = options.env ?? ({ ...process.env } as Record<string, string>)
    // Ensure UTF-8 locale for spawned shells (Git Bash via pipe defaults to
    // Windows console code page, e.g. GBK, producing garbled CJK output)
    if (process.platform === "win32") {
      baseEnv.LANG ??= "C.UTF-8"
      baseEnv.LC_ALL ??= "C.UTF-8"
    }
    this.env = baseEnv
    this.workingDir = options.rootDir ?? process.cwd()
    this.windowsSandbox = options.windowsSandbox ?? "none"
    this.codexExePath = options.codexExePath ?? "codex"
    const h = options.hooks
    this.getHooks = typeof h === "function" ? h : () => h ?? []
    this._elevatedMavenTempDir = baseEnv.TEMP || baseEnv.TMP || tmpdir()
    this._realUserHome = baseEnv.USERPROFILE || baseEnv.HOME || homedir()
    this.abortSignal = options.abortSignal

    // Eagerly cache the elevation check during construction to avoid blocking
    // the event loop on the first file-write hot path (execSync("net session")).
    if (process.platform === "win32" && this.windowsSandbox === "readonly") {
      LocalSandbox.isElevated()
    }

    // Redirect deepagents' virtual eviction paths (e.g. /large_tool_results/)
    // to workspace-local dirs, since virtualMode=false treats "/" as absolute
    // and writing to system root fails on macOS (SIP) and Windows (permissions).
    // MUST run before caching _resolvePath below, so the cache captures the patched version.
    this.patchResolvePath()

    // Cache parent's private fields once to avoid scattered (this as any) casts
    this._resolvePath = ((this as any).resolvePath as (key: string) => string).bind(this)
    this._virtualMode = ((this as any).virtualMode as boolean) ?? false
    this._cwd = ((this as any).cwd as string) ?? this.workingDir
    this._maxFileSizeBytes = ((this as any).maxFileSizeBytes as number) ?? 10 * 1024 * 1024
    if ((this as any).virtualMode === undefined) {
      console.warn("[LocalSandbox] parent virtualMode not found, defaulting to false")
    }
    if ((this as any).cwd === undefined) {
      console.warn("[LocalSandbox] parent cwd not found, falling back to workingDir")
    }

  }

  /**
   * Check if a path is blocked by sandbox policy.
   * When sandbox is elevated, sensitive directories (e.g. .ssh, .aws) are blocked.
   */
  private isBlockedBySandbox(filePath: string): boolean {
    if (this.windowsSandbox !== "elevated") return false
    try {
      const resolved = this._resolvePath(filePath)
      return isSensitivePath(resolved)
    } catch {
      return isSensitivePath(filePath)
    }
  }

  /** Inject the approval orchestrator (called from runtime.ts). */
  setOrchestrator(orch: ToolOrchestrator): void {
    this.orchestrator = orch
  }

  /** Toggle direct git submit command blocking when git_workflow is available. */
  setGitWorkflowCommitOnly(enabled: boolean): void {
    this.enforceGitWorkflowCommitOnly = enabled
  }

  /** Expose the sandbox mode for the orchestrator. */
  getSandboxMode(): "none" | "unelevated" | "readonly" | "elevated" {
    return this.windowsSandbox
  }

  /** Expose the working dir for the orchestrator. */
  getWorkingDir(): string {
    return this.workingDir
  }

  private patchResolvePath(): void {
    if (typeof (this as any).resolvePath !== "function") {
      console.warn("[LocalSandbox] resolvePath not found on FilesystemBackend — skipping path patch")
      return
    }
    const original = (this as any).resolvePath.bind(this)
    const workingDir = this.workingDir
    const redirects: Record<string, string> = {
      "/large_tool_results/": ".cmbdevclaw/large_tool_results"
    }
    ;(this as any).resolvePath = (key: string): string => {
      for (const [prefix, localDir] of Object.entries(redirects)) {
        if (key.startsWith(prefix)) {
          const redirected = path.join(workingDir, localDir, key.slice(prefix.length))
          console.log("[LocalSandbox] Redirecting path:", key, "→", redirected)
          key = redirected
          break
        }
      }
      return original(key)
    }
  }

  private static readonly MAX_GREP_MATCHES = 200
  private static readonly MAX_GREP_CHARS = 24_000
  private static readonly MAX_GLOB_ENTRIES = 400
  private static readonly MAX_LS_ENTRIES = 300

  /**
   * Override grepRaw to:
   * 1. Filter results when path is a file (defends against parent's literalSearch
   *    bug that expands single-file paths to full directory searches)
   * 2. Fall back to encoding-aware search only when ripgrep is unavailable
   *    (parent's literalSearch is hardcoded UTF-8, misses non-UTF-8 files)
   * 3. Cap results for codebase exploration to avoid pressuring small context windows
   *
   * Defence layers: runtime.ts patches process.env.PATH so ripgrep is found;
   * this method calls ripgrepSearch directly to distinguish "no matches" from
   * "rg unavailable"; encodingAwareLiteralSearch serves as a final fallback.
   */
  async grepRaw(
    pattern: string,
    dirPath?: string,
    glob?: string | null
  ): Promise<GrepMatch[] | string> {
    const resolved = dirPath ?? "/"

    // Block grep on sensitive directories
    if (this.isBlockedBySandbox(resolved)) {
      return []
    }

    // Resolve the base path once for reuse
    let baseFull: string
    try {
      baseFull = this._resolvePath(resolved === "/" ? "." : (resolved || "."))
    } catch {
      return []
    }
    // Early exit if path doesn't exist; cache stat for reuse below
    let baseStat: Awaited<ReturnType<typeof fs.stat>>
    try {
      baseStat = await fs.stat(baseFull)
    } catch {
      return []
    }
    const isFile = baseStat.isFile()

    // Call parent's private ripgrepSearch directly to distinguish
    // "rg found nothing" ({}) from "rg unavailable" (null)
    const ripgrepSearch = (this as any).ripgrepSearch as
      | ((p: string, b: string, g: string | null) => Promise<Record<string, Array<[number, string]>> | null>)
      | undefined

    const t0 = Date.now()
    let rgResult: Record<string, Array<[number, string]>> | null | undefined
    if (typeof ripgrepSearch === "function") {
      rgResult = await ripgrepSearch.call(this, pattern, baseFull, glob ?? null)
    }
    const rgMs = Date.now() - t0
    // undefined = method missing (upstream API changed), treat same as unavailable
    const rgAvailable = rgResult !== null && rgResult !== undefined

    // Convert ripgrep dict → flat array
    let results: GrepMatch[] = []
    if (rgResult) {
      for (const [fpath, items] of Object.entries(rgResult)) {
        for (const [lineNum, lineText] of items) {
          results.push({ path: fpath, line: lineNum, text: lineText })
        }
      }
    }

    // When path points to a specific file, filter results to only include
    // matches from the intended file (ripgrep may return broader results).
    if (results.length > 0 && resolved !== "/" && isFile) {
      let expectedPath: string
      if (this._virtualMode) {
        const relative = path.relative(this._cwd, baseFull)
        expectedPath = "/" + relative.split(path.sep).join("/")
      } else {
        expectedPath = baseFull
      }
      results = results.filter((m) => m.path === expectedPath)
    }

    let source = results.length > 0 ? "ripgrep" : "none"

    // Fall back to encoding-aware literal search when:
    // - ripgrep is unavailable (null/undefined), OR
    // - ripgrep returned empty for a single file (may be non-UTF-8 / binary-detected,
    //   e.g. GBK/Shift-JIS files that ripgrep skips as "binary")
    // For directory-level searches, empty ripgrep results are normal — skip fallback.
    if (!rgAvailable || (results.length === 0 && isFile)) {
      const t1 = Date.now()
      const rawResults = await this.encodingAwareLiteralSearch(pattern, baseFull, glob ?? null)
      const fallbackMs = Date.now() - t1
      for (const [fpath, items] of Object.entries(rawResults)) {
        for (const [lineNum, lineText] of items) {
          results.push({ path: fpath, line: lineNum, text: lineText })
        }
      }
      if (results.length > 0) source = "encoding-aware-fallback"
      console.log(
        `[LocalSandbox] grepRaw fallback: pattern="${pattern}", results=${results.length}, fallbackMs=${fallbackMs}`
      )
    }

    console.log(
      `[LocalSandbox] grepRaw: source=${source}, pattern="${pattern}", results=${results.length}, rgMs=${rgMs}`
    )

    if (results.length === 0) return results

    // Filter out any results from sensitive directories
    if (this.windowsSandbox === "elevated") {
      results = results.filter(m => {
        try {
          const resolved = this._resolvePath(m.path)
          return !isSensitivePath(resolved)
        } catch {
          return !isSensitivePath(m.path)
        }
      })
      if (results.length === 0) return results
    }

    const capped: GrepMatch[] = []
    let charCount = 0

    for (const match of results) {
      if (capped.length >= LocalSandbox.MAX_GREP_MATCHES) break
      // Truncate overly long lines (e.g. minified JS) to avoid blowing the char budget
      const text =
        match.text.length > 1000
          ? match.text.slice(0, 1000) + "...(truncated)"
          : match.text
      const estChars = match.path.length + text.length + 16
      if (charCount + estChars > LocalSandbox.MAX_GREP_CHARS) break
      capped.push(text !== match.text ? { ...match, text } : match)
      charCount += estChars
    }

    if (capped.length < results.length) {
      const omitted = results.length - capped.length
      console.log(
        "[LocalSandbox] grepRaw capped results:",
        `${capped.length}/${results.length}`,
        `(omitted ${omitted}, chars=${charCount})`
      )
      capped.push({
        path: "(truncated)",
        line: 0,
        text: `Found ${results.length} total matches, showing first ${capped.length}. ${omitted} omitted — refine pattern/path/glob.`
      })
    }

    return capped
  }

  /**
   * Cap glob results because repository-wide globs can easily return thousands
   * of files and consume context on small windows.
   */
  async globInfo(pattern: string, path = "/"): Promise<FileInfo[]> {
    if (this.isBlockedBySandbox(path)) {
      return []
    }
    let infos = await super.globInfo(pattern, path)
    // Filter out any results that fall within sensitive directories
    if (this.windowsSandbox === "elevated") {
      infos = infos.filter(f => {
        try {
          const resolved = this._resolvePath(f.path)
          return !isSensitivePath(resolved)
        } catch {
          return true
        }
      })
    }
    if (infos.length <= LocalSandbox.MAX_GLOB_ENTRIES) return infos

    const capped = infos.slice(0, LocalSandbox.MAX_GLOB_ENTRIES)
    const omitted = infos.length - capped.length
    console.log(
      "[LocalSandbox] globInfo capped results:",
      `${capped.length}/${infos.length}`,
      `for pattern=${pattern}`
    )
    capped.push({
      path: `(truncated) Found ${infos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific glob pattern or path.`,
      is_dir: false
    } as FileInfo)
    return capped
  }

  /**
   * Light cap for ls to avoid pathological large directory listings.
   */
  async lsInfo(path: string): Promise<FileInfo[]> {
    if (this.isBlockedBySandbox(path)) {
      return [{ path: "Error: Access denied — this directory is restricted by sandbox policy.", is_dir: false } as FileInfo]
    }
    let infos = await super.lsInfo(path)
    // Filter out any results that fall within sensitive directories
    if (this.windowsSandbox === "elevated") {
      infos = infos.filter(f => {
        try {
          const resolved = this._resolvePath(f.path)
          return !isSensitivePath(resolved)
        } catch {
          return true
        }
      })
    }
    if (infos.length <= LocalSandbox.MAX_LS_ENTRIES) return infos

    const capped = infos.slice(0, LocalSandbox.MAX_LS_ENTRIES)
    const omitted = infos.length - capped.length
    console.log(
      "[LocalSandbox] lsInfo capped results:",
      `${capped.length}/${infos.length}`,
      `for path=${path}`
    )
    capped.push({
      path: `(truncated) Found ${infos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific path.`,
      is_dir: false
    } as FileInfo)
    return capped
  }

  private static readonly LINE_NUMBER_WIDTH = 6
  private static readonly MAX_LINE_LENGTH = 10_000

  private static readonly SUPPORTS_NOFOLLOW =
    typeof fsConstants.O_NOFOLLOW === "number"

  private static readonly KNOWN_BINARY_EXTENSIONS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
    ".mp3", ".mp4", ".wav", ".mov", ".avi", ".mkv",
    ".zip", ".gz", ".tar", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib",
    ".woff", ".woff2", ".ttf", ".otf",
    ".pyc", ".class", ".o", ".obj",
    ".sqlite", ".db",
    ".pdf", ".doc", ".xls", ".ppt",
    ".docx", ".xlsx", ".pptx"
  ])

  /**
   * Detect file encoding from raw buffer (inspired by Cline's detectEncoding,
   * but extended for read+write: Cline only uses it for reading, while we also
   * use the detected encoding to write back, so we upgrade ASCII → UTF-8 to
   * avoid replacing non-ASCII chars with '?').
   * 0. Fast reject known binary extensions before any I/O-heavy detection
   * 1. Try jschardet — if it returns a valid encoding, use it (ASCII → utf-8)
   * 2. If detection fails, check for binary via null-byte sampling
   * 3. Fallback to utf-8 for plain text
   */
  private detectEncoding(buffer: Buffer, ext?: string): string {
    if (ext && LocalSandbox.KNOWN_BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read binary file type: ${ext}`)
    }

    const detected = chardet.detect(buffer)
    if (detected && detected.encoding && iconv.encodingExists(detected.encoding)) {
      // ASCII is a strict subset of UTF-8; upgrade so non-ASCII chars
      // written by the agent (e.g. CJK) are not replaced with '?'.
      if (detected.encoding.toLowerCase() === "ascii") return "utf-8"
      return detected.encoding
    }

    // jschardet could not determine encoding — check if it's binary
    const sampleLen = Math.min(8192, buffer.length)
    for (let i = 0; i < sampleLen; i++) {
      if (buffer[i] === 0) {
        throw new Error(`Cannot read text for file type: ${ext || "unknown"}`)
      }
    }
    return "utf-8"
  }

  /**
   * Format lines with line numbers (compatible with deepagents' format).
   * Long lines are chunked with continuation markers (e.g. 5.1, 5.2).
   */
  private formatLines(lines: string[], startLine: number): string {
    const result: string[] = []
    const w = LocalSandbox.LINE_NUMBER_WIDTH
    const maxLen = LocalSandbox.MAX_LINE_LENGTH

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + startLine
      if (line.length <= maxLen) {
        result.push(`${lineNum.toString().padStart(w)}\t${line}`)
      } else {
        const numChunks = Math.ceil(line.length / maxLen)
        for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
          const start = chunkIdx * maxLen
          const chunk = line.slice(start, start + maxLen)
          if (chunkIdx === 0) {
            result.push(`${lineNum.toString().padStart(w)}\t${chunk}`)
          } else {
            result.push(`${`${lineNum}.${chunkIdx}`.padStart(w)}\t${chunk}`)
          }
        }
      }
    }
    return result.join("\n")
  }

  /**
   * Override read to auto-detect file encoding (GBK, Shift_JIS, etc.)
   * instead of hardcoded UTF-8. Uses jschardet + iconv-lite, same as Cline.
   *
   * Preserves original FilesystemBackend features:
   *  - resolvePath() for virtual mode / security
   *  - O_NOFOLLOW / symlink protection
   *  - offset/limit pagination
   *  - long-line chunking with continuation markers
   *
   * Adds (same as Cline):
   *  - Automatic encoding detection via jschardet
   *  - Multi-encoding decoding via iconv-lite
   *  - Binary file detection as fallback when jschardet fails
   */
  async read(filePath: string, offset = 0, limit = 500): Promise<string> {
    if (this.isBlockedBySandbox(filePath)) {
      return `Error: Access denied — '${filePath}' is restricted by sandbox policy.`
    }
    try {
      const { buffer, resolvedPath } = await this.readFileBuffer(filePath)

      const ext = path.extname(resolvedPath).toLowerCase()
      const encoding = this.detectEncoding(buffer, ext)
      const content = iconv.decode(buffer, encoding)
      await this.recordReadTime(resolvedPath)

      if (!content || content.trim() === "") return "System reminder: File exists but has empty contents"

      const lines = content.split("\n")
      if (offset >= lines.length) {
        return `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`
      }

      const total = lines.length
      const hasMore = offset + limit < total
      const end = Math.min(offset + (hasMore ? limit - 1 : limit), total)
      const formatted = this.formatLines(lines.slice(offset, end), offset + 1)
      if (hasMore) {
        return `[Lines ${offset + 1}-${end} of ${total}. Use offset=${end} to read more.]\n` + formatted
      }
      return formatted
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Error reading file '${filePath}': ${msg}`
    }
  }

  /**
   * Read a file as a raw Buffer with symlink protection.
   * Shared helper for read(), edit(), and other encoding-aware operations.
   */
  private async readFileBuffer(filePath: string): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const resolvedPath: string = this._resolvePath(filePath)

    let buffer: Buffer
    if (LocalSandbox.SUPPORTS_NOFOLLOW) {
      if (!(await fs.lstat(resolvedPath)).isFile()) {
        throw new Error(`File '${filePath}' not found`)
      }
      const fd = await fs.open(
        resolvedPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      )
      try {
        buffer = await fd.readFile()
      } finally {
        await fd.close()
      }
    } else {
      const stat = await fs.lstat(resolvedPath)
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${filePath}`)
      if (!stat.isFile()) throw new Error(`File '${filePath}' not found`)
      buffer = await fs.readFile(resolvedPath)
    }

    return { buffer, resolvedPath }
  }

  // ── File safety helpers ──────────────────────────────────────────────────────

  /**
   * Serialize concurrent operations on the same resolved file path.
   * Different file paths run in parallel; same path is FIFO-queued.
   */
  private async withFileLock<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._fileLocks.get(resolvedPath) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const tail = prev.then(() => gate)
    this._fileLocks.set(resolvedPath, tail)
    try {
      await prev
      return await fn()
    } finally {
      release()
      if (this._fileLocks.get(resolvedPath) === tail) {
        this._fileLocks.delete(resolvedPath)
      }
    }
  }

  /** Record the file's mtime after a successful read or write. */
  private async recordReadTime(resolvedPath: string): Promise<void> {
    const stat = await fs.stat(resolvedPath)
    this._fileReadTimes.set(resolvedPath, stat.mtimeMs)
  }

  /**
   * Assert that a file has not been modified externally since the last read.
   * Compares file mtime against the recorded mtime — same clock source, no drift.
   */
  private async assertNotModifiedSinceRead(resolvedPath: string): Promise<void> {
    const recordedMtime = this._fileReadTimes.get(resolvedPath)
    if (recordedMtime === undefined) return // first edit without a prior read() — allow it
    const stat = await fs.stat(resolvedPath)
    // 50ms tolerance for filesystem timestamp granularity (NTFS async flush, HFS+ 1s resolution)
    if (stat.mtimeMs > recordedMtime + 50) {
      throw new Error(
        `File has been modified externally since last read. Please read the file again before editing.`
      )
    }
  }

  /**
   * Write content back to a file with symlink protection.
   * Encodes the content with the given encoding via iconv-lite.
   */
  private async writeFileEncoded(
    resolvedPath: string,
    content: string,
    encoding: string
  ): Promise<void> {
    const encoded = iconv.encode(content, encoding)
    if (LocalSandbox.SUPPORTS_NOFOLLOW) {
      const flags =
        fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
      const fd = await fs.open(resolvedPath, flags)
      try {
        await fd.writeFile(encoded)
      } finally {
        await fd.close()
      }
    } else {
      await fs.writeFile(resolvedPath, encoded)
    }
  }

  /**
   * Check if a file write should be blocked by the sandbox.
   * - readonly + non-admin: block all writes
   * - readonly + admin: only allow writes within the working directory
   * - unelevated / none: allow all writes (shell sandbox handles restriction)
   *
   * Uses realpathSync to resolve symlinks and toLowerCase for Windows
   * case-insensitive path comparison.
   */
  private isWriteBlocked(filePath: string): boolean {
    if (this.windowsSandbox !== "readonly") return false
    if (!LocalSandbox.isElevated()) return true
    // Admin readonly: restrict to working directory only (matches disk-write-cwd)
    try {
      const resolved = path.resolve(this.workingDir, filePath)
      // Resolve symlinks to prevent traversal via symlinked directories.
      // If the file doesn't exist yet, resolve its parent directory instead.
      let realTarget: string
      try {
        realTarget = realpathSync(resolved)
      } catch {
        // File doesn't exist yet — resolve parent dir + basename
        const parentReal = realpathSync(path.dirname(resolved))
        realTarget = path.join(parentReal, path.basename(resolved))
      }
      const realCwd = realpathSync(this.workingDir)
      // Windows paths are case-insensitive
      const normalizedTarget = realTarget.toLowerCase()
      const normalizedCwd = realCwd.toLowerCase()
      const cwdPrefix = normalizedCwd + path.sep
      return !normalizedTarget.startsWith(cwdPrefix) && normalizedTarget !== normalizedCwd
    } catch {
      return true
    }
  }

  /** Build a readonly-sandbox block error message for the given file and action verb. */
  private readonlyBlockedError(filePath: string, action: string): string {
    return LocalSandbox.isElevated()
      ? `只读沙箱模式下仅允许${action}工作目录内的文件。'${filePath}' 不在工作目录 '${this.workingDir}' 内。`
      : `只读沙箱模式下禁止${action}文件 '${filePath}'。如需${action}请以管理员身份运行或切换沙箱模式。`
  }

  /**
   * Override write to enforce readonly sandbox restrictions.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    if (this.isBlockedBySandbox(filePath)) {
      return { error: `Access denied — '${filePath}' is restricted by sandbox policy.` }
    }
    if (this.isWriteBlocked(filePath)) {
      return { error: this.readonlyBlockedError(filePath, "写入") }
    }
    // Approval gate (skipped when no orchestrator = YOLO mode)
    if (this.orchestrator) {
      const approved = await this.orchestrator.approveFileOp("write_file", filePath, this.workingDir)
      if (!approved) {
        return { error: "文件写入被用户拒绝。" }
      }
    }
    // PreToolUse hook
    const preResult = await runHooks(this.getHooks(), "PreToolUse", {
      toolName: "write_file",
      toolArgs: { filePath, content },
      workspacePath: this.workingDir
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "write_file was blocked by a hook"}` }
    }
    const resolvedPath = this._resolvePath(filePath)
    const result = await this.withFileLock(resolvedPath, async () => {
      const r = await super.write(filePath, content)
      if (!r.error) {
        await this.recordReadTime(resolvedPath)
      }
      return r
    })
    // PostToolUse hook (fire-and-forget)
    runHooks(this.getHooks(), "PostToolUse", {
      toolName: "write_file",
      toolArgs: { filePath, content },
      toolResult: JSON.stringify(result),
      workspacePath: this.workingDir
    }).catch((e) => console.warn("[Hooks] PostToolUse write error:", e))
    return result
  }

  /**
   * Override uploadFiles to enforce readonly sandbox restrictions on each file.
   */
  async uploadFiles(files: [string, string | Buffer][]): Promise<{ path: string; error: string | null }[]> {
    // Check for both sandbox-sensitive and readonly-blocked files
    const indexed = files.map(([filePath, content], i) => ({
      filePath, content, i,
      sandboxBlocked: this.isBlockedBySandbox(filePath),
      writeBlocked: this.isWriteBlocked(filePath)
    }))
    const allowed = indexed.filter((e) => !e.sandboxBlocked && !e.writeBlocked)

    if (allowed.length === files.length) return super.uploadFiles(files)

    // Batch-delegate all allowed files in one call
    const allowedResults = allowed.length > 0
      ? await super.uploadFiles(allowed.map((e) => [e.filePath, e.content] as [string, string | Buffer]))
      : []

    // Merge results back in original order
    const results: { path: string; error: string | null }[] = new Array(files.length)
    let ai = 0
    for (const entry of indexed) {
      if (entry.sandboxBlocked) {
        results[entry.i] = { path: entry.filePath, error: `Access denied — '${entry.filePath}' is restricted by sandbox policy.` }
      } else if (entry.writeBlocked) {
        results[entry.i] = { path: entry.filePath, error: this.readonlyBlockedError(entry.filePath, "写入") }
      } else {
        results[entry.i] = allowedResults[ai++]
      }
    }
    return results
  }

  /**
   * Override edit to:
   * 1. Auto-detect file encoding (GBK, Shift_JIS, etc.) — same as read()
   * 2. Use OpenCode's 9-layer progressive string replacement for better
   *    tolerance of LLM-generated oldString variations (whitespace, indent, escapes)
   * 3. Write back in the original encoding to avoid corrupting non-UTF-8 files
   * 4. File lock to prevent concurrent writes to the same file
   * 5. Timestamp check to detect external modifications since last read
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    if (this.isBlockedBySandbox(filePath)) {
      return { error: `Access denied — '${filePath}' is restricted by sandbox policy.` }
    }
    if (this.isWriteBlocked(filePath)) {
      return { error: this.readonlyBlockedError(filePath, "编辑") }
    }
    // Approval gate (skipped when no orchestrator = YOLO mode)
    if (this.orchestrator) {
      const approved = await this.orchestrator.approveFileOp("edit_file", filePath, this.workingDir)
      if (!approved) {
        return { error: "文件编辑被用户拒绝。" }
      }
    }
    // PreToolUse hook
    const preResult = await runHooks(this.getHooks(), "PreToolUse", {
      toolName: "edit_file",
      toolArgs: { filePath, oldString, newString, replaceAll },
      workspacePath: this.workingDir
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "edit_file was blocked by a hook"}` }
    }
    try {
      const resolvedPath = this._resolvePath(filePath)
      const result = await this.withFileLock(resolvedPath, async () => {
        const { buffer } = await this.readFileBuffer(filePath)
        const ext = path.extname(resolvedPath).toLowerCase()
        const encoding = this.detectEncoding(buffer, ext)
        const content = iconv.decode(buffer, encoding)

        // Check file hasn't been modified externally since last read
        await this.assertNotModifiedSinceRead(resolvedPath)

        let expectedContent: string
        let occurrences: number

        if (content === "" && oldString === "") {
          expectedContent = newString
          occurrences = 0
        } else {
          const r = replace(content, oldString, newString, replaceAll)
          expectedContent = r.newContent
          occurrences = r.occurrences
        }

        await this.writeFileEncoded(resolvedPath, expectedContent, encoding)
        await this.recordReadTime(resolvedPath)
        return { path: filePath, filesUpdate: null, occurrences }
      })
      // PostToolUse hook (fire-and-forget)
      runHooks(this.getHooks(), "PostToolUse", {
        toolName: "edit_file",
        toolArgs: { filePath, oldString, newString, replaceAll },
        toolResult: JSON.stringify(result),
        workspacePath: this.workingDir
      }).catch((e) => console.warn("[Hooks] PostToolUse edit error:", e))
      return result
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `Error editing file '${filePath}': ${msg}` }
    }
  }

  /**
   * Detect encoding for command output on Windows.
   * Git Bash via pipe may output in the system code page (e.g. GBK) despite
   * LANG=C.UTF-8, because MSYS2's character conversion layer uses the Windows
   * ANSI code page for non-pty file descriptors.
   *
   * Two-pronged detection:
   * 1. High-confidence jschardet (>= 0.8) — trust directly.
   * 2. If buffer is NOT valid UTF-8 — accept jschardet at any confidence,
   *    since it's clearly not UTF-8. This handles short CJK output
   *    (e.g. `echo "中文"` → 4 GBK bytes) where jschardet reports low
   *    confidence but the detected encoding (GB2312/GB18030) is correct.
   */
  private static readonly CHARDET_CONFIDENCE_THRESHOLD = 0.8

  private detectCmdEncoding(buf: Buffer): string {
    if (buf.length === 0) return "utf-8"
    const detected = chardet.detect(buf)
    if (!detected) return "utf-8"
    const enc = typeof detected === "string" ? detected : detected.encoding
    const confidence = typeof detected === "object" ? detected.confidence : 1
    if (!enc || enc.toLowerCase() === "ascii" || !iconv.encodingExists(enc)) {
      return "utf-8"
    }
    if (confidence >= LocalSandbox.CHARDET_CONFIDENCE_THRESHOLD) {
      return enc
    }
    // Low confidence but buffer contains invalid UTF-8 — definitely not UTF-8,
    // trust jschardet's best guess (typically GBK/GB2312 on Chinese Windows)
    if (!LocalSandbox.isValidUtf8(buf)) {
      return enc
    }
    return "utf-8"
  }

  /** Quick check whether a buffer is valid UTF-8. */
  private static isValidUtf8(buf: Buffer): boolean {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf)
      return true
    } catch {
      return false
    }
  }

  private static readonly SEARCH_IGNORE = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/__pycache__/**"
  ]

  /**
   * Encoding-aware fallback for grep when ripgrep is unavailable.
   * Called from grepRaw override when parent's search returns no results,
   * to handle non-UTF-8 files via jschardet + iconv-lite.
   */
  private async encodingAwareLiteralSearch(
    pattern: string,
    baseFull: string,
    includeGlob: string | null
  ): Promise<Record<string, Array<[number, string]>>> {
    const results: Record<string, Array<[number, string]>> = {}
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(baseFull)
    } catch {
      return results // path does not exist — return empty
    }
    const isFile = stat.isFile()
    const cwd = isFile ? path.dirname(baseFull) : baseFull
    // If baseFull points to a single file, only search that file
    const files = isFile
      ? [baseFull]
      : await fg("**/*", {
          cwd, absolute: true, onlyFiles: true, dot: true,
          ignore: LocalSandbox.SEARCH_IGNORE
        })
    const maxBytes = this._maxFileSizeBytes
    const cwdDir = this._virtualMode ? this._cwd : ""

    for (const fp of files) {
      try {
        // Single-file mode: skip glob filter — caller already specified the target file
        // matchBase: when glob has no slashes (e.g. "*.ts"), match against
        // basename only — consistent with ripgrep's --glob behavior.
        if (!isFile && includeGlob && !micromatch.isMatch(path.relative(cwd, fp), includeGlob, { matchBase: true })) continue
        if ((await fs.stat(fp)).size > maxBytes) continue

        const buf = await fs.readFile(fp)
        const ext = path.extname(fp).toLowerCase()

        let encoding: string
        try {
          encoding = this.detectEncoding(buf, ext)
        } catch {
          continue
        }

        const content = iconv.decode(buf, encoding)
        const lines = content.split("\n")

        let virtPath: string | null = null
        if (this._virtualMode) {
          try {
            const relative = path.relative(cwdDir, fp)
            if (relative.startsWith("..")) continue
            virtPath = "/" + relative.split(path.sep).join("/")
          } catch {
            continue
          }
        } else {
          virtPath = fp
        }

        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(pattern)) continue
          if (!results[virtPath!]) results[virtPath!] = []
          results[virtPath!].push([i + 1, lines[i]])
        }
      } catch {
        continue
      }
    }
    return results
  }

  private static readonly SHELL_BLACKLIST = new Set(["fish", "nu"])

  /**
   * Resolve the best shell for command execution.
   * All platforms: check $SHELL first (skip non-POSIX shells like fish/nu).
   * Windows fallback: GIT_BASH_PATH env > detect git install > COMSPEC (cmd.exe)
   * macOS fallback: /bin/zsh
   * Linux fallback: /bin/sh
   */
  /** Public accessor for the resolved shell path (used by system prompt). */
  static resolvedShell(): string {
    return LocalSandbox.resolveShell()
  }

  /**
   * Resolve the best shell for Windows sandbox execution.
   * Git Bash (MSYS2) crashes under restricted tokens (NtSetInformationToken fails),
   * so we must skip it and use PowerShell or cmd.exe instead.
   */
  private static _cachedSandboxShell: { shell: string; flags: string[] } | null = null

  private static resolveWindowsSandboxShell(): { shell: string; flags: string[] } {
    if (LocalSandbox._cachedSandboxShell) return LocalSandbox._cachedSandboxShell
    for (const ps of ["pwsh", "powershell"]) {
      const fullPath = LocalSandbox.whichSync(ps)
      if (fullPath) {
        LocalSandbox._cachedSandboxShell = { shell: fullPath, flags: ["-NoProfile", "-Command"] }
        return LocalSandbox._cachedSandboxShell
      }
    }
    LocalSandbox._cachedSandboxShell = { shell: process.env.COMSPEC || "cmd.exe", flags: ["/c"] }
    return LocalSandbox._cachedSandboxShell
  }

  /** Public accessor for the Windows sandbox shell (PowerShell or cmd.exe). */
  static resolvedWindowsSandboxShell(): string {
    return LocalSandbox.resolveWindowsSandboxShell().shell
  }

  /**
   * Build a sandbox-safe copy of env with PATH reordered:
   * System32 and System32\Wbem are moved to the front so native Windows
   * executables (whoami, find, sort, etc.) are found before MSYS2/Git
   * equivalents that crash under restricted tokens (STATUS_DLL_NOT_FOUND).
   */
  private static buildSandboxEnv(env: Record<string, string>): Record<string, string> {
    const result = { ...env }
    const sep = path.delimiter
    const sys32 = (env.SystemRoot || env.windir || "C:\\Windows") + "\\System32"
    const sys32Lower = sys32.toLowerCase()
    const parts = (result.PATH || result.Path || "").split(sep)
    // Partition: system32 paths first, then the rest (filtering out Git usr/bin MSYS2 paths)
    const system: string[] = []
    const rest: string[] = []
    for (const p of parts) {
      const lower = p.toLowerCase()
      if (lower.startsWith(sys32Lower)) {
        system.push(p)
      } else if (lower.includes("\\usr\\bin") && lower.includes("git")) {
        // Skip Git MSYS2 usr/bin — these binaries crash under restricted tokens
      } else {
        rest.push(p)
      }
    }
    // Ensure System32 is present even if not in original PATH
    if (!system.some(s => s.toLowerCase() === sys32Lower)) {
      system.unshift(sys32)
    }
    const pathKey = result.PATH !== undefined ? "PATH" : "Path"
    result[pathKey] = [...system, ...rest].join(sep)
    return result
  }

  private static resolveShell(): string {
    const isWindows = process.platform === "win32"
    const userShell = process.env.SHELL
    if (userShell) {
      const basename = isWindows
        ? path.win32.basename(userShell)
        : path.basename(userShell)
      if (!LocalSandbox.SHELL_BLACKLIST.has(basename)) return userShell
    }

    if (isWindows) {
      const envBash = process.env.GIT_BASH_PATH
      if (envBash) return envBash

      // Derive bash.exe from git.exe install location:
      // git.exe is typically at C:\Program Files\Git\cmd\git.exe
      // bash.exe is at C:\Program Files\Git\bin\bash.exe
      const gitExe = LocalSandbox.whichSync("git")
      if (gitExe) {
        const bash = path.join(gitExe, "..", "..", "bin", "bash.exe")
        try {
          if (existsSync(bash)) return bash
        } catch { /* ignore */ }
      }

      // Fallback: check common install paths
      for (const base of [
        process.env["ProgramFiles"],
        process.env["ProgramFiles(x86)"],
        "C:\\Program Files"
      ]) {
        if (!base) continue
        const bash = path.join(base, "Git", "bin", "bash.exe")
        try {
          if (existsSync(bash)) return bash
        } catch { /* ignore */ }
      }

      return process.env.COMSPEC || "cmd.exe"
    }

    if (process.platform === "darwin") return "/bin/zsh"
    return "/bin/sh"
  }

  /** Synchronous `which` — locate an executable on PATH. */
  private static whichSync(name: string): string | null {
    const isWindows = process.platform === "win32"
    const pathEnv = process.env.PATH || ""
    const sep = isWindows ? ";" : ":"
    const extensions = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue
      for (const ext of extensions) {
        const full = path.join(dir, name + ext)
        try {
          if (existsSync(full)) return full
        } catch { /* ignore */ }
      }
    }
    return null
  }

  /** Track all active child processes for cleanup on app quit. */
  private static readonly activeProcesses = new Set<ChildProcess>()

  /** Kill all active child processes. Call from app 'will-quit' hook. */
  static killAll(): void {
    for (const proc of LocalSandbox.activeProcesses) {
      void LocalSandbox.killTree(proc, () => false)
    }
    LocalSandbox.activeProcesses.clear()
  }

  // Use SID *S-1-1-0 instead of "Everyone" to avoid locale issues on non-English Windows.
  private static readonly EVERYONE_SID = "*S-1-1-0"

  /** Cached result of admin elevation check. */
  private static _isElevated: boolean | null = null

  /**
   * Check if the current process is running with administrator privileges (Windows only).
   * Cached after first call.
   *
   * IMPORTANT: In packaged Electron apps, process.cwd() may point to an
   * invalid or ASAR-internal path, causing execSync to fail even when the
   * process IS elevated. We explicitly set cwd to %SYSTEMROOT% and add
   * windowsHide to prevent spurious failures.
   *
   * Uses two detection methods:
   * 1. `net session` — classic, depends on LanmanServer service
   * 2. `whoami /groups` + High Mandatory Level SID (S-1-16-12288) — most reliable,
   *    queries the process token directly, no service dependency
   *
   * NOTE: Do NOT use `fsutil dirty query` — it succeeds without admin on Windows 11.
   */
  static isElevated(): boolean {
    if (LocalSandbox._isElevated !== null) return LocalSandbox._isElevated
    if (process.platform !== "win32") {
      LocalSandbox._isElevated = false
      return false
    }
    // Use a known-good cwd to avoid failures in packaged Electron apps
    // where process.cwd() may point inside app.asar or a non-existent directory.
    const safeCwd = process.env.SYSTEMROOT || process.env.windir || "C:\\Windows"

    // Method 1: net session (requires admin, depends on LanmanServer service)
    try {
      execSync("net session", { stdio: "ignore", windowsHide: true, cwd: safeCwd })
      LocalSandbox._isElevated = true
      console.log("[LocalSandbox] isElevated=true (net session)")
      return true
    } catch (e) {
      console.log("[LocalSandbox] net session failed:", (e as Error).message?.slice(0, 120))
    }
    // Method 2: whoami /groups — check for High Mandatory Level SID (S-1-16-12288)
    // This queries the process token directly, independent of any service.
    // High = admin elevated, Medium (S-1-16-8192) = normal user or non-elevated admin.
    try {
      const output = execSync("whoami /groups", { encoding: "utf-8", windowsHide: true, cwd: safeCwd })
      if (output.includes("S-1-16-12288")) {
        LocalSandbox._isElevated = true
        console.log("[LocalSandbox] isElevated=true (whoami /groups)")
        return true
      }
      console.log("[LocalSandbox] whoami: no High Mandatory Level SID found")
    } catch (e) {
      console.log("[LocalSandbox] whoami failed:", (e as Error).message?.slice(0, 120))
    }
    LocalSandbox._isElevated = false
    console.log("[LocalSandbox] isElevated=false")
    return false
  }

  /** Directories that currently have the Everyone ACE granted, with reference count.
   *  Key = normalized dir path, value = number of active runs using that grant.
   *  ACL is only revoked when the count drops to 0. */
  private static readonly _grantedAclRefCount = new Map<string, number>()
  /** Per-run tracking: which dirs each runId has granted (for correct decrement on cleanup). */
  private static readonly _runAclDirs = new Map<string, Set<string>>()
  /** Directories that should never be revoked (e.g. TEMP — public dir, safe to leave open). */
  private static readonly _permanentAclDirs = new Set<string>()

  /** Grant Everyone Modify on dir (for sandbox restricted token). Returns when done.
   *  @param runId — identifies the agent run requesting the grant (for ref-counting). */
  private static grantSandboxWriteAcl(dir: string, runId: string): Promise<void> {
    const key = normalizeDirKey(dir)
    // Track this dir for the given run (so cleanup decrements correctly).
    let runDirs = LocalSandbox._runAclDirs.get(runId)
    if (!runDirs) {
      runDirs = new Set()
      LocalSandbox._runAclDirs.set(runId, runDirs)
    }
    // Only increment ref count once per (run, dir) pair — the same run may
    // call grantSandboxWriteAcl multiple times for the same workingDir.
    if (!runDirs.has(key)) {
      runDirs.add(key)
      const prevCount = LocalSandbox._grantedAclRefCount.get(key) ?? 0
      LocalSandbox._grantedAclRefCount.set(key, prevCount + 1)
      // If already granted by another run, skip the icacls call.
      if (prevCount > 0) {
        return Promise.resolve()
      }
    } else {
      // Same run already granted this dir — skip entirely.
      return Promise.resolve()
    }
    // (OI)(CI) = inherit to files & subdirs so the restricted token can
    // read/write/delete at any depth. Uses async spawn to avoid blocking
    // the event loop on large repos (NTFS propagates inherited ACEs to
    // all existing descendants, which can take tens of seconds).
    return new Promise<void>((resolve) => {
      const proc = spawn("icacls", [dir, "/grant", `${LocalSandbox.EVERYONE_SID}:(OI)(CI)(M)`], { stdio: "ignore" })
      const timeoutId = setTimeout(() => {
        console.warn(`[LocalSandbox] icacls grant timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`)
        try { proc.kill() } catch { /* already exited */ }
        resolve()
      }, LocalSandbox.ICACLS_TIMEOUT_MS)
      proc.on("exit", (code) => {
        clearTimeout(timeoutId)
        if (code !== 0) {
          console.warn(`[LocalSandbox] icacls grant exited ${code} on ${dir}`)
        }
        resolve()
      })
      proc.on("error", (err) => {
        clearTimeout(timeoutId)
        console.warn(`[LocalSandbox] icacls grant error on ${dir}:`, err.message)
        resolve()
      })
    })
  }

  /** Remove the Everyone ACE added by grantSandboxWriteAcl. Only actually calls
   *  icacls when the ref count drops to 0 (no other runs using this dir). */
  private static revokeSandboxWriteAcl(dir: string): Promise<void> {
    const key = normalizeDirKey(dir)
    const count = LocalSandbox._grantedAclRefCount.get(key) ?? 0
    // Nothing to revoke if we never granted (or already revoked).
    if (count <= 0) {
      LocalSandbox._grantedAclRefCount.delete(key)
      return Promise.resolve()
    }
    // Still in use by other runs — don't revoke yet.
    if (count > 1) {
      LocalSandbox._grantedAclRefCount.set(key, count - 1)
      return Promise.resolve()
    }
    // count === 1 → last user, actually revoke
    LocalSandbox._grantedAclRefCount.delete(key)
    return new Promise<void>((resolve) => {
      const proc = spawn("icacls", [dir, "/remove:g", LocalSandbox.EVERYONE_SID], { stdio: "ignore" })
      const timeoutId = setTimeout(() => {
        console.warn(`[LocalSandbox] icacls revoke timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`)
        try { proc.kill() } catch { /* already exited */ }
        resolve()
      }, LocalSandbox.ICACLS_TIMEOUT_MS)
      proc.on("exit", (code) => {
        clearTimeout(timeoutId)
        if (code !== 0) console.warn(`[LocalSandbox] icacls revoke exited ${code} on ${dir}`)
        resolve()
      })
      proc.on("error", (err) => {
        clearTimeout(timeoutId)
        console.warn(`[LocalSandbox] icacls revoke error on ${dir}:`, err.message)
        resolve()
      })
    })
  }

  /**
   * Release ACL grants for a specific run. Decrements ref counts and only
   * actually revokes the ACL when no other runs are using the directory.
   * @param runId — the agent run that is ending.
   */
  static async revokeGrantedAclsForRun(runId: string): Promise<void> {
    const runDirs = LocalSandbox._runAclDirs.get(runId)
    if (!runDirs || runDirs.size === 0) {
      LocalSandbox._runAclDirs.delete(runId)
      return
    }
    const dirsToRevoke = [...runDirs].filter(
      (key) => !LocalSandbox._permanentAclDirs.has(key)
    )
    LocalSandbox._runAclDirs.delete(runId)
    if (dirsToRevoke.length === 0) return
    console.log(`[LocalSandbox] revokeGrantedAclsForRun(${runId}): releasing ${dirsToRevoke.length} dirs`)
    await Promise.all(dirsToRevoke.map((dir) => LocalSandbox.revokeSandboxWriteAcl(dir)))
  }

  /** Sandbox user names used by elevated mode. */
  private static readonly ELEVATED_SANDBOX_USERS = ["CodexSandboxOnline", "CodexSandboxOffline"]

  /**
   * Grant elevated sandbox users read+write ACL on a workspace directory via icacls.
   * No UAC needed — the current user owns the directory so they can modify its ACLs.
   */
  /** Timeout for icacls ACL operations (30 seconds). */
  private static readonly ICACLS_TIMEOUT_MS = 30_000

  private static grantElevatedWorkspaceAcl(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Grant both sandbox users Modify permission with inheritance.
      // (OI)(CI) = Object Inherit + Container Inherit — new files/dirs inherit automatically.
      // Intentionally NO /T flag: /T recursively touches every existing file's ACL, which
      // can take minutes on large repos (node_modules alone can have 100k+ files).
      // codex.exe handles existing-file access internally; we only need the top-level grant
      // so the sandbox user can enter the directory and inheritance covers the rest.
      const args: string[] = [dir]
      for (const user of LocalSandbox.ELEVATED_SANDBOX_USERS) {
        args.push("/grant", `${user}:(OI)(CI)(M)`)
      }
      args.push("/Q")
      const proc = spawn("icacls", args, { stdio: "pipe" })
      let stderr = ""
      const timeoutId = setTimeout(() => {
        console.warn(`[LocalSandbox] icacls elevated grant timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`)
        try { proc.kill() } catch { /* already exited */ }
        resolve() // Don't block execution — codex.exe will handle ACL internally
      }, LocalSandbox.ICACLS_TIMEOUT_MS)
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on("exit", (code) => {
        clearTimeout(timeoutId)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`icacls exited ${code}: ${stderr.trim()}`))
        }
      })
      proc.on("error", (err) => {
        clearTimeout(timeoutId)
        reject(err)
      })
    })
  }

  private static readonly SIGKILL_TIMEOUT_MS = 200
  /** Max time (ms) to wait for stdout/stderr to drain after killing a process (matches Codex IO_DRAIN_TIMEOUT_MS). */
  private static readonly IO_DRAIN_TIMEOUT_MS = 2_000

  /**
   * Kill a process tree in a platform-aware manner.
   * Windows: taskkill /T /F (tree kill), awaits completion.
   * Unix: SIGTERM the process group, escalate to SIGKILL after 200ms.
   */
  private static async killTree(proc: ChildProcess, exited: () => boolean): Promise<void> {
    const pid = proc.pid
    if (!pid || exited()) {
      console.log(`[LocalSandbox] killTree: skip (pid=${pid}, exited=${exited()})`)
      return
    }
    console.log(`[LocalSandbox] killTree: killing pid=${pid}, platform=${process.platform}`)

    if (process.platform === "win32") {
      await new Promise<void>((res) => {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" })
        killer.once("exit", () => res())
        killer.once("error", () => res())
      })
      return
    }

    try {
      console.log(`[LocalSandbox] killTree: SIGTERM → pid=${pid}`)
      process.kill(-pid, "SIGTERM")
    } catch {
      try { proc.kill("SIGTERM") } catch { /* already exited */ }
    }
    await new Promise<void>((res) => setTimeout(res, LocalSandbox.SIGKILL_TIMEOUT_MS))
    if (!exited()) {
      console.log(`[LocalSandbox] killTree: SIGKILL → pid=${pid} (not exited after ${LocalSandbox.SIGKILL_TIMEOUT_MS}ms)`)
      try { process.kill(-pid, "SIGKILL") } catch {
        try { proc.kill("SIGKILL") } catch { /* already exited */ }
      }
    } else {
      console.log(`[LocalSandbox] killTree: pid=${pid} exited after SIGTERM, no SIGKILL needed`)
    }
  }

  /**
   * Execute a shell command in the workspace directory.
   *
   * Key design decisions (aligned with OpenCode's bash tool):
   * - Uses spawn(command, { shell }) pattern — Node.js handles platform-specific
   *   shell invocation, so pipes, redirects, and chaining just work.
   * - Smart shell selection: Git Bash on Windows (if available) > cmd.exe,
   *   user's $SHELL on Unix > platform fallback.
   * - detached process group on Unix for clean tree kill via negative PID.
   * - Platform-aware kill tree: taskkill /T on Windows, process group signals on Unix.
   * - Windows encoding auto-detection (GBK/CP936) to prevent garbled Chinese text.
   * - Windows exit-event grace period to handle .bat child process pipe handle leaks.
   */
  private static readonly SPAWN_RETRY_COUNT = 2
  private static readonly SPAWN_RETRY_DELAY_MS = 300
  /** Maximum timeout for background tasks (10 minutes). */
  private static readonly BACKGROUND_TIMEOUT_MS = 600_000

  /** Active background tasks (static — shared across instances so tasks survive re-creation). */
  private static backgroundTasks = new Map<string, {
    id: string
    threadId: string
    command: string
    startedAt: number
    completed: boolean
    outputChunks: string[]
    abortController: AbortController
    result?: ExecuteResponse
  }>()

  /**
   * Execute a command in the background — returns immediately with a task ID.
   * The command runs asynchronously with a long timeout.
   * Use `getTaskOutput(taskId)` to retrieve the result or check progress.
   */
  async executeBackground(command: string): Promise<string> {
    const taskId = randomUUID().slice(0, 8)
    const taskAbortController = new AbortController()
    const task = {
      id: taskId, threadId: this.runId, command, startedAt: Date.now(), completed: false as boolean,
      outputChunks: [] as string[], abortController: taskAbortController,
      result: undefined as ExecuteResponse | undefined
    }
    LocalSandbox.backgroundTasks.set(taskId, task)

    // Fire and forget — don't await. Uses extended timeout for background execution.
    // Background tasks use their own AbortController (not the conversation's abortSignal)
    // so they survive conversation switches but can still be cancelled explicitly.
    this.executeRaw(command, undefined, LocalSandbox.BACKGROUND_TIMEOUT_MS, taskAbortController.signal).then(result => {
      // Guard: if already completed (e.g. cancelled via cancelBackgroundTasks), don't overwrite.
      if (task.completed) return
      task.result = result
      // Append final output to chunks for completeness
      if (result.output) task.outputChunks.push(result.output)
      task.completed = true
      console.log(`[LocalSandbox] background task ${taskId} completed: exitCode=${result.exitCode}`)
      // Auto-cleanup completed tasks after 10 minutes to prevent memory leaks.
      // The agent has plenty of time to poll for the result before it expires.
      setTimeout(() => {
        LocalSandbox.backgroundTasks.delete(taskId)
        console.log(`[LocalSandbox] background task ${taskId} expired, cleaned up`)
      }, 10 * 60 * 1000)
    }).catch(err => {
      // Guard: if already completed (e.g. cancelled via cancelBackgroundTasks), don't overwrite.
      if (task.completed) return
      task.result = { output: `Error: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1, truncated: false }
      task.completed = true
      console.log(`[LocalSandbox] background task ${taskId} errored: ${err}`)
      setTimeout(() => {
        LocalSandbox.backgroundTasks.delete(taskId)
      }, 10 * 60 * 1000)
    })

    return taskId
  }

  /**
   * Retrieve a background task's current status and output.
   * When still running, returns elapsed time and command info so the agent can report progress.
   */
  getTaskOutput(taskId: string): {
    completed: boolean
    output?: string
    exitCode?: number | null
    elapsedSeconds?: number
    command?: string
  } | null {
    const task = LocalSandbox.backgroundTasks.get(taskId)
    if (!task) return null
    const elapsedSeconds = Math.round((Date.now() - task.startedAt) / 1000)
    if (!task.completed) {
      return { completed: false, elapsedSeconds, command: task.command }
    }
    return { completed: true, output: task.result?.output, exitCode: task.result?.exitCode, elapsedSeconds }
  }

  /**
   * Cancel all running background tasks for a given thread (conversation).
   * Called when the user explicitly stops the current conversation.
   */
  static cancelBackgroundTasks(threadId: string): void {
    for (const [taskId, task] of LocalSandbox.backgroundTasks) {
      if (task.threadId === threadId && !task.completed) {
        console.log(`[LocalSandbox] cancelling background task ${taskId} (command: ${task.command}) for thread ${threadId}`)
        task.abortController.abort()
        // Mark as completed immediately to prevent zombie entries if the
        // process kill path doesn't trigger the .then/.catch callbacks.
        task.completed = true
        task.result = task.result ?? {
          output: "Task cancelled by user.",
          exitCode: 130,
          truncated: false
        }
        // Schedule cleanup (mirrors the auto-cleanup in the normal completion path).
        setTimeout(() => {
          LocalSandbox.backgroundTasks.delete(taskId)
          console.log(`[LocalSandbox] cancelled background task ${taskId} expired, cleaned up`)
        }, 10 * 60 * 1000)
      }
    }
  }

  async execute(command: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Shell tool expects a non-empty command string.",
        exitCode: 1,
        truncated: false
      }
    }

    console.log(`[LocalSandbox] execute: hasOrchestrator=${!!this.orchestrator} sandbox=${this.windowsSandbox}`)

    // Always check forbidden commands, even without orchestrator (YOLO mode safety net)
    const safety = assessCommandSafety(command, this.workingDir, {
      windowsShell: process.platform === "win32" && this.windowsSandbox !== "none" ? "powershell" : "unknown",
      enforceGitWorkflowCommitOnly: this.enforceGitWorkflowCommitOnly
    })
    if (safety.level === "forbidden") {
      console.log(`[LocalSandbox] execute: FORBIDDEN — ${safety.reason}`)
      return {
        output: `Command forbidden: ${safety.reason}`,
        exitCode: 1,
        truncated: false
      }
    }

    // PreToolUse hook
    const preResult = await runHooks(this.getHooks(), "PreToolUse", {
      toolName: "execute",
      toolArgs: { command },
      workspacePath: this.workingDir
    })
    if (preResult?.blocked) {
      return {
        output: `[Hook blocked] ${preResult.stdout || "execute was blocked by a hook"}`,
        exitCode: 1,
        truncated: false
      }
    }

    // If an orchestrator is configured, delegate to it for approval + sandbox retry.
    // The orchestrator calls back into executeRaw() for actual execution.
    if (this.orchestrator) {
      const result = await this.orchestrator.execute(command, this.workingDir, this.windowsSandbox)
      // PostToolUse hook
      const postResult = await runHooks(this.getHooks(), "PostToolUse", {
        toolName: "execute",
        toolArgs: { command },
        toolResult: result.output,
        workspacePath: this.workingDir
      })
      if (postResult?.stdout) {
        return { ...result, output: result.output + "\n\n[Hook output]\n" + postResult.stdout }
      }
      return result
    }

    const result = await this.executeRaw(command)
    // PostToolUse hook
    const postResult = await runHooks(this.getHooks(), "PostToolUse", {
      toolName: "execute",
      toolArgs: { command },
      toolResult: result.output,
      workspacePath: this.workingDir
    })
    if (postResult?.stdout) {
      return { ...result, output: result.output + "\n\n[Hook output]\n" + postResult.stdout }
    }
    return result
  }

  /**
   * Raw command execution — no approval logic.
   * Called directly by the orchestrator after approval is granted,
   * or as fallback when no orchestrator is configured.
   */
  async executeRaw(command: string, sandboxModeOverride?: string, timeoutMs?: number, overrideAbortSignal?: AbortSignal): Promise<ExecuteResponse> {
    const effectiveSandboxMode = (sandboxModeOverride ?? this.windowsSandbox) as typeof this.windowsSandbox
    const effectiveTimeout = timeoutMs ?? this.timeout
    console.log(`[LocalSandbox] executeRaw: command="${command}" effectiveMode=${effectiveSandboxMode} override=${sandboxModeOverride} timeout=${effectiveTimeout}ms overrideAbort=${!!overrideAbortSignal}`)

    if (process.platform === "win32" && effectiveSandboxMode !== "none") {
      console.log(`[LocalSandbox] → executeInWindowsSandbox (elevated path)`)
      return this.executeInWindowsSandbox(command, 1, effectiveSandboxMode, effectiveTimeout, overrideAbortSignal)
    }

    const isWindows = process.platform === "win32"
    const shell = LocalSandbox.resolveShell()
    const shellBase = path.basename(shell).replace(/\.exe$/i, "")
    const isBashLikeShell = ["bash", "sh", "zsh"].includes(shellBase)

    // On Windows with cmd.exe, force UTF-8 code page so CJK output isn't garbled.
    // For Git Bash, encoding detection handles the conversion instead (see collectAndResolve).
    const effectiveCommand = isWindows && !isBashLikeShell
      ? `chcp 65001 >nul & ${command}`
      : command

    // On Windows, spawn can transiently fail with EPERM (antivirus file lock, handle
    // contention). Retry up to SPAWN_RETRY_COUNT times with a short delay.
    const maxAttempts = isWindows ? LocalSandbox.SPAWN_RETRY_COUNT + 1 : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.executeOnce(effectiveCommand, shell, isWindows, effectiveTimeout, overrideAbortSignal)
      const isSpawnEperm =
        result.exitCode === 1
        && result.output.startsWith("Error: Failed to execute command:")
        && result.output.includes("EPERM")
      if (isSpawnEperm && attempt < maxAttempts) {
        console.warn(
          `[LocalSandbox] spawn EPERM on attempt ${attempt}/${maxAttempts}, retrying in ${LocalSandbox.SPAWN_RETRY_DELAY_MS}ms…`
        )
        await new Promise<void>((r) => setTimeout(r, LocalSandbox.SPAWN_RETRY_DELAY_MS))
        continue
      }
      return result
    }
    return { output: "Error: Unexpected retry loop exit.", exitCode: 1, truncated: false }
  }

  /**
   * Execute a command inside the Codex Windows sandbox.
   * - unelevated: restricted token + NTFS ACL (workdir writable, network follows host policy)
   * - readonly: read-only filesystem sandbox with outbound network allowed
   * - elevated: dedicated sandbox user + strong ACL isolation; codex.exe manages credentials and ACLs internally
   * Retries on EPERM (antivirus transient lock); reports error on other failures.
   */
  private async executeInWindowsSandbox(command: string, attempt = 1, sandboxModeOverride?: "none" | "unelevated" | "readonly" | "elevated", timeoutMs?: number, overrideAbortSignal?: AbortSignal): Promise<ExecuteResponse> {
    const methodStartMs = Date.now()
    const effectiveMode = sandboxModeOverride ?? this.windowsSandbox
    const isElevatedSandbox = effectiveMode === "elevated"

    // Elevated mode: proactively ensure the workspace has ACL setup before spawning codex.exe.
    // This prevents the command from silently blocking mid-execution when codex.exe returns
    // "setup refresh failed" (which triggers a reactive UAC mid-command).
    // Using persistent cache so workspaces only need setup once, across restarts.
    if (isElevatedSandbox && attempt === 1) {
      console.log(`[LocalSandbox] elevated: checking workspace setup at +${Date.now() - methodStartMs}ms`)
      if (!isWorkspaceElevatedSetupDone(this.workingDir)) {
        if (isElevatedSetupComplete()) {
          // Initial setup already done (sandbox user exists). For new workspaces, just grant
          // ACL access via icacls — no UAC needed since we own the directory.
          console.log(`[LocalSandbox] elevated: granting sandbox user ACL for new workspace (no UAC): ${this.workingDir}`)
          try {
            await LocalSandbox.grantElevatedWorkspaceAcl(this.workingDir)
            markWorkspaceElevatedSetupDone(this.workingDir)
            console.log(`[LocalSandbox] elevated: ACL grant done for ${this.workingDir}`)
          } catch (err) {
            console.warn(`[LocalSandbox] elevated: icacls grant failed, falling back to full setup: ${err}`)
            const setupResult = await runElevatedSetupForPaths([this.workingDir])
            if (setupResult.success) {
              markWorkspaceElevatedSetupDone(this.workingDir)
            }
          }
        } else {
          // Initial setup not done — need full elevated setup (UAC required)
          console.log(`[LocalSandbox] elevated: initial setup required, running with UAC: ${this.workingDir}`)
          const setupResult = await runElevatedSetupForPaths([this.workingDir])
          if (setupResult.success) {
            markWorkspaceElevatedSetupDone(this.workingDir)
            console.log(`[LocalSandbox] elevated: initial setup done for ${this.workingDir}`)
          } else {
            console.warn(`[LocalSandbox] elevated: initial setup failed: ${setupResult.error}`)
            // Continue anyway — codex.exe will handle "setup refresh failed" reactively as fallback
          }
        }
      }
    }

    // Git Bash (MSYS2) crashes under restricted tokens — always use PowerShell/cmd
    console.log(`[LocalSandbox] elevated: pre-setup done at +${Date.now() - methodStartMs}ms, resolving shell...`)
    const { shell, flags: shellFlags } = LocalSandbox.resolveWindowsSandboxShell()

    // Force UTF-8 for all output streams (stdout + stderr).
    const shellBase = path.basename(shell).replace(/\.exe$/i, "").toLowerCase()
    const psUtf8Preamble = [
      "chcp 65001 >$null",
      "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
      "$OutputEncoding=[System.Text.Encoding]::UTF8"
    ].join("; ")
    const effectiveCommand = shellBase === "cmd"
      ? `chcp 65001 >nul & ${command}`
      : shellBase === "pwsh" || shellBase === "powershell"
        ? `${psUtf8Preamble}; ${command}`
        : command
    const sandboxUserEnvPreamble = isElevatedSandbox
      ? LocalSandbox.buildElevatedSandboxEnvPreamble(shellBase, this._elevatedMavenTempDir, this._realUserHome)
      : ""
    const commandWithSandboxEnv = sandboxUserEnvPreamble
      ? shellBase === "cmd"
        ? `${sandboxUserEnvPreamble} & ${effectiveCommand}`
        : `${sandboxUserEnvPreamble}; ${effectiveCommand}`
      : effectiveCommand

    const isReadonly = effectiveMode === "readonly"
    const elevated = isReadonly && LocalSandbox.isElevated()

    // elevated: dedicated sandbox user, codex.exe handles the isolation internally
    // readonly + admin: grant full read + cwd write so admin can work in workspace
    // readonly + non-admin: read only, all writes blocked
    // unelevated: workdir writable via --full-auto + ACL
    let sandboxArgs: string[]
    if (isElevatedSandbox) {
      // -c is a global flag and must come before the "sandbox" subcommand
      sandboxArgs = [
        "-c", 'windows.sandbox="elevated"',
        "-c", "sandbox_workspace_write.network_access=true",
        "sandbox", "windows",
        "--full-auto",
        "--",
        shell, ...shellFlags, commandWithSandboxEnv
      ]
    } else if (isReadonly) {
      sandboxArgs = elevated
        ? [
            "-c", 'sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }',
            "-c", 'sandbox_permissions=["disk-full-read-access","disk-write-cwd"]',
            "sandbox", "windows",
            "--",
            shell, ...shellFlags, commandWithSandboxEnv
          ]
        : [
            "-c", 'sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }',
            "-c", 'sandbox_permissions=["disk-full-read-access"]',
            "sandbox", "windows",
            "--",
            shell, ...shellFlags, commandWithSandboxEnv
          ]
    } else {
      sandboxArgs = [
        "-c", "sandbox_workspace_write.network_access=true",
        "sandbox", "windows",
        "--full-auto",
        "--",
        shell, ...shellFlags, commandWithSandboxEnv
      ]
    }

    // Elevated sandbox manages its own ACLs internally — skip manual icacls grants.
    // For other modes: ACL grant/revoke needed for unelevated and readonly+admin.
    const aclDirs: string[] = []
    if (!isElevatedSandbox) {
      if (!isReadonly || elevated) {
        aclDirs.push(this.workingDir)
      }
      // TEMP is granted once and marked permanent — never revoked because it's a public
      // temp directory. This avoids 2 icacls spawns (grant + revoke) per command.
      const tmpDir = process.env.TEMP || process.env.TMP
      if (tmpDir) {
        const tmpKey = normalizeDirKey(tmpDir)
        if (!LocalSandbox._permanentAclDirs.has(tmpKey)) {
          aclDirs.push(tmpDir)
          LocalSandbox._permanentAclDirs.add(tmpKey)
        }
      }
      const aclGrantStart = Date.now()
      await Promise.all(aclDirs.map((dir) => LocalSandbox.grantSandboxWriteAcl(dir, this.runId)))
      console.log(`[LocalSandbox] ACL grant took ${Date.now() - aclGrantStart}ms for ${aclDirs.length} dirs`)
    }

    const execStartMs = Date.now()
    try {
    const result = await new Promise<ExecuteResponse>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let resolved = false
      let exited = false
      let firstDataAt = 0 // timestamp of first stdout/stderr data

      // Effective abort signal: per-task override (for background tasks) or conversation-level signal.
      const effectiveAbortSignal = overrideAbortSignal ?? this.abortSignal

      // Early return if already aborted — avoid spawning a process just to kill it.
      if (effectiveAbortSignal?.aborted) {
        resolve({ output: "<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n<no output>", exitCode: 130, truncated: false })
        return
      }

      console.log(`[LocalSandbox] spawn: ${this.codexExePath} ${JSON.stringify(sandboxArgs)}`)
      console.log(`[LocalSandbox] cwd: ${this.workingDir}`)

      // Build sandbox-safe env: ensure System32 is before Git usr/bin in PATH.
      // MSYS2 binaries (from Git usr/bin) crash under restricted tokens due to
      // DLL load failures (0xC0000135). Prioritizing System32 ensures native
      // Windows executables (whoami, find, sort, etc.) are found first.
      const sandboxEnv = LocalSandbox.buildSandboxEnv(this.env)

      // spawn() reports ENOENT asynchronously via the "error" event, not by throwing
      const proc = spawn(this.codexExePath, sandboxArgs, {
        cwd: this.workingDir,
        env: sandboxEnv,
        stdio: ["ignore", "pipe", "pipe"]
      })

      console.log(`[LocalSandbox] spawned pid=${proc.pid} at +${Date.now() - execStartMs}ms`)
      if (!proc.pid) {
        console.warn(`[LocalSandbox] WARNING: spawn returned no pid — process may not have started`)
      }
      LocalSandbox.activeProcesses.add(proc)

      let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null
      let timedOut = false
      let aborted = false
      let drainTimerId: ReturnType<typeof setTimeout> | null = null

      const killProc = (): void => {
        void LocalSandbox.killTree(proc, () => exited)
      }

      const cmdTimeout = timeoutMs ?? this.timeout
      const timeoutId = setTimeout(() => {
        if (resolved || timedOut || aborted) return
        console.log(`[LocalSandbox] timeout: pid=${proc.pid}, killing after ${cmdTimeout}ms`)
        timedOut = true
        killProc()
        drainTimerId = setTimeout(() => {
          console.log(`[LocalSandbox] drain timeout: pid=${proc.pid}, force-resolving after ${LocalSandbox.IO_DRAIN_TIMEOUT_MS}ms`)
          collectAndResolve(null, "SIGKILL")
        }, LocalSandbox.IO_DRAIN_TIMEOUT_MS)
      }, cmdTimeout)

      const abortHandler = (): void => {
        if (resolved || timedOut || aborted) return
        console.log(`[LocalSandbox] abort: pid=${proc.pid}, killing immediately`)
        aborted = true
        clearTimeout(timeoutId)
        killProc()
        drainTimerId = setTimeout(() => {
          console.log(`[LocalSandbox] drain timeout: pid=${proc.pid}, force-resolving after ${LocalSandbox.IO_DRAIN_TIMEOUT_MS}ms`)
          collectAndResolve(null, "SIGKILL")
        }, LocalSandbox.IO_DRAIN_TIMEOUT_MS)
      }
      if (effectiveAbortSignal) {
        effectiveAbortSignal.addEventListener("abort", abortHandler, { once: true })
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (!firstDataAt) { firstDataAt = Date.now(); console.log(`[LocalSandbox] first data at +${firstDataAt - execStartMs}ms pid=${proc.pid}`) }
        if (totalBytes < this.maxOutputBytes) {
          stdoutChunks.push(chunk)
          totalBytes += chunk.length
        }
      })

      proc.stderr?.on("data", (chunk: Buffer) => {
        if (!firstDataAt) { firstDataAt = Date.now(); console.log(`[LocalSandbox] first data at +${firstDataAt - execStartMs}ms pid=${proc.pid}`) }
        if (totalBytes < this.maxOutputBytes) {
          stderrChunks.push(chunk)
          totalBytes += chunk.length
        }
      })

      const collectAndResolve = (code: number | null, signal: string | null): void => {
        if (resolved) {
          console.log(`[LocalSandbox] collectAndResolve: skip (already resolved), pid=${proc.pid}`)
          return
        }
        try {
          const elapsed = Date.now() - execStartMs
          const reason = aborted ? "abort" : timedOut ? "timeout" : "normal"
          console.log(`[LocalSandbox] collectAndResolve: pid=${proc.pid}, reason=${reason}, code=${code}, signal=${signal}, elapsed=${elapsed}ms, bytes=${totalBytes}`)
          resolved = true
          exited = true
          LocalSandbox.activeProcesses.delete(proc)
          clearTimeout(timeoutId)
          if (drainTimerId) clearTimeout(drainTimerId)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)

          const stdoutBuf = Buffer.concat(stdoutChunks)
          const stderrBuf = Buffer.concat(stderrChunks)
          const enc = this.detectCmdEncoding(Buffer.concat([stdoutBuf, stderrBuf]))

          let output = ""
          if (stdoutBuf.length > 0) output += iconv.decode(stdoutBuf, enc)
          if (stderrBuf.length > 0) {
            const errText = iconv.decode(stderrBuf, enc)
              .split("\n").filter((l) => l.length > 0)
              .map((l) => `[stderr] ${l}`).join("\n")
            if (errText) output += (output ? "\n" : "") + errText
          }

          let truncated = false
          if (output.length > this.maxOutputBytes) {
            output = output.slice(0, this.maxOutputBytes) + `\n\n... Output truncated at ${this.maxOutputBytes} bytes.`
            truncated = true
          }
          if (!output.trim()) output = "<no output>"

          if (aborted) {
            const metadata = `<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n`
            resolve({ output: metadata + output, exitCode: 130, truncated })
          } else if (timedOut) {
            const metadata = `<execute_metadata>\nexecute tool killed the running process and terminated command after exceeding timeout ${(cmdTimeout / 1000).toFixed(1)}s\n</execute_metadata>\n\n`
            resolve({ output: metadata + output, exitCode: 124, truncated })
          } else {
            resolve({ output, exitCode: signal ? null : code, truncated })
          }
        } catch (err) {
          // Encoding detection or iconv.decode can throw on unusual binary output.
          // Ensure the promise always resolves — a stuck promise means the UI hangs on RUNNING forever.
          console.error(`[LocalSandbox] collectAndResolve error: pid=${proc.pid}`, err)
          resolved = true
          LocalSandbox.activeProcesses.delete(proc)
          clearTimeout(timeoutId)
          if (drainTimerId) clearTimeout(drainTimerId)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)
          resolve({
            output: `Error processing command output: ${err instanceof Error ? err.message : String(err)}`,
            exitCode: code ?? 1,
            truncated: false
          })
        }
      }

      proc.on("exit", (code, signal) => {
        console.log(`[LocalSandbox] event=exit pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - execStartMs}ms resolved=${resolved}`)
        exited = true
        windowsExitTimerId = setTimeout(() => {
          collectAndResolve(code, signal as string | null)
        }, 500)
      })

      proc.on("close", (code, signal) => {
        console.log(`[LocalSandbox] event=close pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - execStartMs}ms resolved=${resolved}`)
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        console.log(`[LocalSandbox] event=error pid=${proc.pid} err=${(err as Error).message} at +${Date.now() - execStartMs}ms resolved=${resolved}`)
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (drainTimerId) clearTimeout(drainTimerId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
        if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)

        const errno = err as NodeJS.ErrnoException
        if (errno.code === "EPERM" && attempt <= LocalSandbox.SPAWN_RETRY_COUNT) {
          console.warn(
            `[LocalSandbox] codex.exe EPERM attempt ${attempt}/${LocalSandbox.SPAWN_RETRY_COUNT + 1}, retrying in ${LocalSandbox.SPAWN_RETRY_DELAY_MS}ms…`
          )
          setTimeout(() => {
            resolve(this.executeInWindowsSandbox(command, attempt + 1, sandboxModeOverride))
          }, LocalSandbox.SPAWN_RETRY_DELAY_MS)
          return
        }

        console.error("[LocalSandbox] Windows sandbox spawn error:", err)
        resolve({
          output: `错误：沙箱启动失败，命令未执行。\n原因：${errno.message ?? String(err)}\n请检查沙箱配置或在设置中关闭沙箱模式后重试。`,
          exitCode: null,
          truncated: false
        })
      })
    })

    // Elevated mode: if "setup refresh failed", run elevated setup for this workspace (one-time UAC) and retry.
    // Only retry once (attempt === 1) to prevent infinite recursion if setup succeeds but codex.exe keeps failing.
    if (isElevatedSandbox && result.exitCode !== 0 && result.output.includes("setup refresh failed") && attempt <= 1) {
      console.log(`[LocalSandbox] elevated: setup refresh failed for ${this.workingDir}, running elevated setup with UAC (attempt=${attempt})...`)
      // runElevatedSetupForPaths / markWorkspaceElevatedSetupDone already imported statically
      const setupResult = await runElevatedSetupForPaths([this.workingDir])
      if (setupResult.success) {
        markWorkspaceElevatedSetupDone(this.workingDir)
        // Retry the command once now that ACLs are in place (increment attempt to prevent further retries)
        return this.executeInWindowsSandbox(command, attempt + 1, sandboxModeOverride, timeoutMs, overrideAbortSignal)
      }
      return {
        output: `沙箱工作目录配置失败: ${setupResult.error || "未知错误"}。\n请在设置中切换沙箱模式或以管理员身份运行应用。`,
        exitCode: 1,
        truncated: false
      }
    }

    if (
      isElevatedSandbox
      && result.exitCode !== 0
      && sandboxModeOverride !== "unelevated"
      && LocalSandbox.shouldFallbackToUnelevatedForNetworkAuth(result.output)
    ) {
      // Auto-fallback to unelevated mode: elevated sandbox user lacks enterprise network
      // credentials (Kerberos/NTLM), so commands accessing corporate repos (Maven, npm, etc.)
      // will fail. Retry with unelevated sandbox which inherits the real user's credentials.
      console.warn("[LocalSandbox] elevated network auth failed; auto-retrying with unelevated sandbox")
      return this.executeInWindowsSandbox(command, 1, "unelevated", timeoutMs)
    }

    console.log(`[LocalSandbox] executeInWindowsSandbox total: ${Date.now() - execStartMs}ms, command="${command.slice(0, 80)}"`)
    return result
    } finally {
      // ACL revoke is deferred — kept granted across commands in the same session
      // to avoid redundant icacls spawns. Cleanup happens in revokeGrantedAclsForRun()
      // which is called when the agent run ends (decrements ref-count per run).
    }
  }

  private executeOnce(
    command: string,
    shell: string,
    isWindows: boolean,
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal
  ): Promise<ExecuteResponse> {
    const onceStartMs = Date.now()
    return new Promise<ExecuteResponse>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let byteCapReached = false
      let resolved = false
      let exited = false
      let firstDataAt = 0

      // Effective abort signal: per-task override (for background tasks) or conversation-level signal.
      const effectiveAbortSignal = overrideAbortSignal ?? this.abortSignal

      // On Windows with bash-like shells (Git Bash / MSYS2), non-ASCII
      // characters in command-line arguments get corrupted: MSYS2's runtime
      // converts the UTF-16 command line to the system ANSI code page (e.g.
      // CP936/GBK) during process startup — before bash or LANG=C.UTF-8
      // take effect. This causes any CJK characters in the command to be
      // garbled, making bash treat the entire string as a filename (exit 127).
      //
      // Fix: pipe the command through stdin as raw UTF-8 bytes, completely
      // bypassing MSYS2's command-line argument parsing. Bash reads from
      // stdin in non-interactive mode and executes the command correctly.
      // Note: stdin was already "ignore" (commands couldn't read stdin anyway),
      // so changing to "pipe" has no practical side effects.

      // Early return if already aborted — avoid spawning a process just to kill it.
      if (effectiveAbortSignal?.aborted) {
        resolve({ output: "<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n<no output>", exitCode: 130, truncated: false })
        return
      }

      const shellBase = path.basename(shell).replace(/\.exe$/i, "")
      const isBashOnWin = isWindows && ["bash", "sh", "zsh"].includes(shellBase)

      const proc = isBashOnWin
        ? spawn(shell, [], {
            cwd: this.workingDir,
            env: this.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: false
          })
        : spawn(command, {
            shell,
            cwd: this.workingDir,
            env: this.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: !isWindows
          })

      if (isBashOnWin && proc.stdin) {
        proc.stdin.on("error", () => { /* swallow: proc 'error'/'close' handles it */ })
        proc.stdin.write(command + "\n")
        proc.stdin.end()
      }

      console.log(`[LocalSandbox] executeOnce: spawned pid=${proc.pid} shell=${shellBase} at +${Date.now() - onceStartMs}ms`)
      if (!proc.pid) {
        console.warn(`[LocalSandbox] WARNING: spawn returned no pid — process may not have started`)
      }
      LocalSandbox.activeProcesses.add(proc)

      let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null
      let timedOut = false
      let aborted = false
      /** After kill, if close doesn't fire within 2s, force-resolve (like Codex IO_DRAIN_TIMEOUT). */
      let drainTimerId: ReturnType<typeof setTimeout> | null = null

      const killProc = (): void => {
        void LocalSandbox.killTree(proc, () => exited)
      }

      const cmdTimeout = timeoutMs ?? this.timeout
      const timeoutId = setTimeout(() => {
        if (resolved || timedOut || aborted) return
        timedOut = true
        killProc()
        // Give close event up to 2s to fire (drain remaining output).
        // If it doesn't come, force-resolve with whatever we have.
        drainTimerId = setTimeout(() => {
          collectAndResolve(null, "SIGKILL")
        }, LocalSandbox.IO_DRAIN_TIMEOUT_MS)
      }, cmdTimeout)

      const abortHandler = (): void => {
        if (resolved || timedOut || aborted) return
        aborted = true
        clearTimeout(timeoutId)
        killProc()
        drainTimerId = setTimeout(() => {
          collectAndResolve(null, "SIGKILL")
        }, LocalSandbox.IO_DRAIN_TIMEOUT_MS)
      }
      if (effectiveAbortSignal) {
        effectiveAbortSignal.addEventListener("abort", abortHandler, { once: true })
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        if (!firstDataAt) { firstDataAt = Date.now(); console.log(`[LocalSandbox] first data at +${firstDataAt - onceStartMs}ms pid=${proc.pid}`) }
        if (byteCapReached) return
        stdoutChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        if (!firstDataAt) { firstDataAt = Date.now(); console.log(`[LocalSandbox] first data at +${firstDataAt - onceStartMs}ms pid=${proc.pid}`) }
        if (byteCapReached) return
        stderrChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      const collectAndResolve = (code: number | null, signal: string | null): void => {
        if (resolved) {
          console.log(`[LocalSandbox] collectAndResolve: skip (already resolved), pid=${proc.pid}`)
          return
        }
        try {
          const elapsed = Date.now() - onceStartMs
          const reason = aborted ? "abort" : timedOut ? "timeout" : "normal"
          console.log(`[LocalSandbox] collectAndResolve: pid=${proc.pid}, reason=${reason}, code=${code}, signal=${signal}, elapsed=${elapsed}ms, bytes=${totalBytes}`)
          resolved = true
          exited = true
          LocalSandbox.activeProcesses.delete(proc)
          clearTimeout(timeoutId)
          if (drainTimerId) clearTimeout(drainTimerId)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)

          const stdoutBuf = Buffer.concat(stdoutChunks)
          const stderrBuf = Buffer.concat(stderrChunks)

          // On Windows, Git Bash via pipe may convert UTF-8 to the system code
          // page (e.g. GBK/CP936) despite LANG=C.UTF-8, because MSYS2's
          // character conversion layer uses the Windows ANSI code page for
          // non-pty file descriptors. Detect the actual encoding from the
          // output buffer so CJK characters are decoded correctly.
          const enc = isWindows
            ? this.detectCmdEncoding(Buffer.concat([stdoutBuf, stderrBuf]))
            : "utf-8"

          let output = ""
          if (stdoutBuf.length > 0) {
            output += iconv.decode(stdoutBuf, enc)
          }
          if (stderrBuf.length > 0) {
            const stderrText = iconv.decode(stderrBuf, enc)
            const prefixed = stderrText
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => `[stderr] ${line}`)
              .join("\n")
            if (prefixed) {
              output += (output ? "\n" : "") + prefixed + (stderrText.endsWith("\n") ? "\n" : "")
            }
          }

          let truncated = false
          if (output.length > this.maxOutputBytes) {
            output = output.slice(0, this.maxOutputBytes)
            output += `\n\n... Output truncated at ${this.maxOutputBytes} bytes.`
            truncated = true
          }
          if (!output.trim()) {
            output = "<no output>"
          }

          // Add metadata prefix for abort/timeout, override exitCode
          if (aborted) {
            const metadata = `<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n`
            resolve({ output: metadata + output, exitCode: 130, truncated })
          } else if (timedOut) {
            const metadata = `<execute_metadata>\nexecute tool killed the running process and terminated command after exceeding timeout ${(cmdTimeout / 1000).toFixed(1)}s\n</execute_metadata>\n\n`
            resolve({ output: metadata + output, exitCode: 124, truncated })
          } else {
            resolve({ output, exitCode: signal ? null : code, truncated })
          }
        } catch (err) {
          // Encoding detection or iconv.decode can throw on unusual binary output.
          // Ensure the promise always resolves — a stuck promise means the UI hangs on RUNNING forever.
          console.error(`[LocalSandbox] collectAndResolve error: pid=${proc.pid}`, err)
          resolved = true
          LocalSandbox.activeProcesses.delete(proc)
          clearTimeout(timeoutId)
          if (drainTimerId) clearTimeout(drainTimerId)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)
          resolve({
            output: `Error processing command output: ${err instanceof Error ? err.message : String(err)}`,
            exitCode: code ?? 1,
            truncated: false
          })
        }
      }

      // On Windows, .bat files may spawn child processes that inherit pipe handles.
      // The 'close' event waits for all handles to close (including orphaned children),
      // which can block indefinitely. Listen for 'exit' and resolve after a grace period.
      if (isWindows) {
        proc.on("exit", (code, signal) => {
          console.log(`[LocalSandbox] event=exit pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - onceStartMs}ms resolved=${resolved}`)
          exited = true
          windowsExitTimerId = setTimeout(() => {
            collectAndResolve(code, signal as string | null)
          }, 500)
        })
      }

      proc.on("close", (code, signal) => {
        console.log(`[LocalSandbox] event=close pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - onceStartMs}ms resolved=${resolved}`)
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        console.log(`[LocalSandbox] event=error pid=${proc.pid} err=${(err as Error).message} at +${Date.now() - onceStartMs}ms resolved=${resolved}`)
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (drainTimerId) clearTimeout(drainTimerId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
        if (effectiveAbortSignal) effectiveAbortSignal.removeEventListener("abort", abortHandler)
        resolve({
          output: `Error: Failed to execute command: ${err.message}`,
          exitCode: 1,
          truncated: false
        })
      })
    })
  }
}
