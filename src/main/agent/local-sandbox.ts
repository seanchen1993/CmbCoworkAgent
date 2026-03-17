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
import type { HookConfig } from "../hooks/types"
import { runHooks } from "../hooks/runner"

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
  /** Windows sandbox mode: 'unelevated' uses Codex restricted-token sandbox, 'readonly' uses Codex read-only sandbox, 'none' runs directly (default: 'none') */
  windowsSandbox?: "none" | "unelevated" | "readonly"
  /** Full path to codex.exe for Windows sandbox. Falls back to 'codex' on PATH if not provided. */
  codexExePath?: string
  /** Hook configurations for PreToolUse/PostToolUse lifecycle events */
  hooks?: HookConfig[]
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

  private readonly timeout: number
  private readonly maxOutputBytes: number
  private readonly env: Record<string, string>
  private readonly workingDir: string
  private readonly windowsSandbox: "none" | "unelevated" | "readonly"
  private readonly codexExePath: string
  private readonly hooks: HookConfig[]
  /** Cached from parent's private fields to avoid (this as any) scattered everywhere */
  private readonly _resolvePath: (key: string) => string
  private readonly _virtualMode: boolean
  private readonly _cwd: string
  private readonly _maxFileSizeBytes: number

  constructor(options: LocalSandboxOptions = {}) {
    super({
      rootDir: options.rootDir,
      virtualMode: options.virtualMode,
      maxFileSizeMb: options.maxFileSizeMb
    })

    this.id = `local-sandbox-${randomUUID().slice(0, 8)}`
    this.timeout = options.timeout ?? 120_000 // 2 minutes default
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
    this.hooks = options.hooks ?? []

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
    const infos = await super.globInfo(pattern, path)
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
    const infos = await super.lsInfo(path)
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
    try {
      const { buffer, resolvedPath } = await this.readFileBuffer(filePath)

      const ext = path.extname(resolvedPath).toLowerCase()
      const encoding = this.detectEncoding(buffer, ext)
      const content = iconv.decode(buffer, encoding)

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
    if (this.isWriteBlocked(filePath)) {
      return { error: this.readonlyBlockedError(filePath, "写入") }
    }
    // PreToolUse hook
    const preResult = await runHooks(this.hooks, "PreToolUse", {
      toolName: "write_file",
      toolArgs: { filePath, content },
      workspacePath: this.workingDir
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "write_file was blocked by a hook"}` }
    }
    const result = await super.write(filePath, content)
    // PostToolUse hook (fire-and-forget for write)
    runHooks(this.hooks, "PostToolUse", {
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
    if (this.windowsSandbox !== "readonly") return super.uploadFiles(files)

    // Separate blocked files from allowed files, preserving original order
    const indexed = files.map(([filePath, content], i) => ({ filePath, content, i, blocked: this.isWriteBlocked(filePath) }))
    const allowed = indexed.filter((e) => !e.blocked)

    // Batch-delegate all allowed files in one call
    const allowedResults = allowed.length > 0
      ? await super.uploadFiles(allowed.map((e) => [e.filePath, e.content] as [string, string | Buffer]))
      : []

    // Merge results back in original order
    const results: { path: string; error: string | null }[] = new Array(files.length)
    let ai = 0
    for (const entry of indexed) {
      results[entry.i] = entry.blocked
        ? { path: entry.filePath, error: this.readonlyBlockedError(entry.filePath, "写入") }
        : allowedResults[ai++]
    }
    return results
  }

  /**
   * Override edit to:
   * 1. Auto-detect file encoding (GBK, Shift_JIS, etc.) — same as read()
   * 2. Use OpenCode's 9-layer progressive string replacement for better
   *    tolerance of LLM-generated oldString variations (whitespace, indent, escapes)
   * 3. Write back in the original encoding to avoid corrupting non-UTF-8 files
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    if (this.isWriteBlocked(filePath)) {
      return { error: this.readonlyBlockedError(filePath, "编辑") }
    }
    // PreToolUse hook
    const preResult = await runHooks(this.hooks, "PreToolUse", {
      toolName: "edit_file",
      toolArgs: { filePath, oldString, newString, replaceAll },
      workspacePath: this.workingDir
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "edit_file was blocked by a hook"}` }
    }
    try {
      const { buffer, resolvedPath } = await this.readFileBuffer(filePath)
      const ext = path.extname(resolvedPath).toLowerCase()
      const encoding = this.detectEncoding(buffer, ext)
      const content = iconv.decode(buffer, encoding)

      if (content === "" && oldString === "") {
        await this.writeFileEncoded(resolvedPath, newString, encoding)
        const result: EditResult = { path: filePath, filesUpdate: null, occurrences: 0 }
        // PostToolUse hook (fire-and-forget for edit)
        runHooks(this.hooks, "PostToolUse", {
          toolName: "edit_file",
          toolArgs: { filePath, oldString, newString, replaceAll },
          toolResult: JSON.stringify(result),
          workspacePath: this.workingDir
        }).catch((e) => console.warn("[Hooks] PostToolUse edit error:", e))
        return result
      }

      const { newContent, occurrences } = replace(content, oldString, newString, replaceAll)

      await this.writeFileEncoded(resolvedPath, newContent, encoding)

      const result: EditResult = { path: filePath, filesUpdate: null, occurrences }
      // PostToolUse hook (fire-and-forget for edit)
      runHooks(this.hooks, "PostToolUse", {
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
  private static resolveWindowsSandboxShell(): { shell: string; flags: string[] } {
    for (const ps of ["pwsh", "powershell"]) {
      const fullPath = LocalSandbox.whichSync(ps)
      if (fullPath) {
        // -NoProfile: skip user profile scripts to avoid side-effects in output
        // -Command: accept command string (consistent with Codex SDK behavior)
        return { shell: fullPath, flags: ["-NoProfile", "-Command"] }
      }
    }
    return { shell: process.env.COMSPEC || "cmd.exe", flags: ["/c"] }
  }

  /** Public accessor for the Windows sandbox shell (PowerShell or cmd.exe). */
  static resolvedWindowsSandboxShell(): string {
    return LocalSandbox.resolveWindowsSandboxShell().shell
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

  /** Check if the current process is running with administrator privileges (Windows only). Cached after first call. */
  static isElevated(): boolean {
    if (LocalSandbox._isElevated !== null) return LocalSandbox._isElevated
    if (process.platform !== "win32") {
      LocalSandbox._isElevated = false
      return false
    }
    try {
      execSync("net session", { stdio: "ignore" })
      LocalSandbox._isElevated = true
    } catch {
      LocalSandbox._isElevated = false
    }
    return LocalSandbox._isElevated
  }

  /** Grant Everyone Modify on dir (for sandbox restricted token). Returns when done. */
  private static grantSandboxWriteAcl(dir: string): Promise<void> {
    // (OI)(CI) = inherit to files & subdirs so the restricted token can
    // read/write/delete at any depth. Uses async spawn to avoid blocking
    // the event loop on large repos (NTFS propagates inherited ACEs to
    // all existing descendants, which can take tens of seconds).
    return new Promise<void>((resolve) => {
      const proc = spawn("icacls", [dir, "/grant", `${LocalSandbox.EVERYONE_SID}:(OI)(CI)(M)`], { stdio: "ignore" })
      proc.on("exit", (code) => {
        if (code !== 0) console.warn(`[LocalSandbox] icacls grant exited ${code} on ${dir}`)
        resolve()
      })
      proc.on("error", (err) => {
        console.warn(`[LocalSandbox] icacls grant error on ${dir}:`, err.message)
        resolve()
      })
    })
  }

  /** Remove the Everyone ACE added by grantSandboxWriteAcl. Returns when done. */
  private static revokeSandboxWriteAcl(dir: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = spawn("icacls", [dir, "/remove:g", LocalSandbox.EVERYONE_SID], { stdio: "ignore" })
      proc.on("exit", (code) => {
        if (code !== 0) console.warn(`[LocalSandbox] icacls revoke exited ${code} on ${dir}`)
        resolve()
      })
      proc.on("error", (err) => {
        console.warn(`[LocalSandbox] icacls revoke error on ${dir}:`, err.message)
        resolve()
      })
    })
  }

  private static readonly SIGKILL_TIMEOUT_MS = 200

  /**
   * Kill a process tree in a platform-aware manner.
   * Windows: taskkill /T /F (tree kill), awaits completion.
   * Unix: SIGTERM the process group, escalate to SIGKILL after 200ms.
   */
  private static async killTree(proc: ChildProcess, exited: () => boolean): Promise<void> {
    const pid = proc.pid
    if (!pid || exited()) return

    if (process.platform === "win32") {
      await new Promise<void>((res) => {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" })
        killer.once("exit", () => res())
        killer.once("error", () => res())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      try { proc.kill("SIGTERM") } catch { /* already exited */ }
    }
    await new Promise<void>((res) => setTimeout(res, LocalSandbox.SIGKILL_TIMEOUT_MS))
    if (!exited()) {
      try { process.kill(-pid, "SIGKILL") } catch {
        try { proc.kill("SIGKILL") } catch { /* already exited */ }
      }
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

  async execute(command: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Shell tool expects a non-empty command string.",
        exitCode: 1,
        truncated: false
      }
    }

    // PreToolUse hook
    const preResult = await runHooks(this.hooks, "PreToolUse", {
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

    let result: ExecuteResponse

    if (process.platform === "win32" && this.windowsSandbox !== "none") {
      result = await this.executeInWindowsSandbox(command)
    } else {
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
      let found = false
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptResult = await this.executeOnce(effectiveCommand, shell, isWindows)
        const isSpawnEperm =
          attemptResult.exitCode === 1
          && attemptResult.output.startsWith("Error: Failed to execute command:")
          && attemptResult.output.includes("EPERM")
        if (isSpawnEperm && attempt < maxAttempts) {
          console.warn(
            `[LocalSandbox] spawn EPERM on attempt ${attempt}/${maxAttempts}, retrying in ${LocalSandbox.SPAWN_RETRY_DELAY_MS}ms…`
          )
          await new Promise<void>((r) => setTimeout(r, LocalSandbox.SPAWN_RETRY_DELAY_MS))
          continue
        }
        result = attemptResult
        found = true
        break
      }
      if (!found) {
        result = { output: "Error: Unexpected retry loop exit.", exitCode: 1, truncated: false }
      }
    }

    // PostToolUse hook
    const postResult = await runHooks(this.hooks, "PostToolUse", {
      toolName: "execute",
      toolArgs: { command },
      toolResult: result.output,
      workspacePath: this.workingDir
    })
    if (postResult?.stdout) {
      result = { ...result, output: result.output + "\n\n[Hook output]\n" + postResult.stdout }
    }
    return result
  }

  /**
   * Execute a command inside the Codex Windows sandbox.
   * - unelevated: restricted token + NTFS ACL (workdir writable, network blocked)
   * - readonly: read-only for normal users; admin allows cwd write
   * Retries on EPERM (antivirus transient lock); reports error on other failures.
   */
  private async executeInWindowsSandbox(command: string, attempt = 1): Promise<ExecuteResponse> {
    // Git Bash (MSYS2) crashes under restricted tokens — always use PowerShell/cmd
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

    const isReadonly = this.windowsSandbox === "readonly"
    const elevated = isReadonly && LocalSandbox.isElevated()

    // readonly + admin: grant full read + cwd write so admin can work in workspace
    // readonly + non-admin: read only, all writes blocked
    // unelevated: workdir writable via --full-auto + ACL
    const sandboxArgs = isReadonly
      ? elevated
        ? [
            "sandbox", "windows",
            "-c", 'sandbox_permissions=["disk-full-read-access","disk-write-cwd"]',
            "--",
            shell, ...shellFlags, effectiveCommand
          ]
        : [
            "sandbox", "windows",
            "-c", 'sandbox_permissions=["disk-full-read-access"]',
            "--",
            shell, ...shellFlags, effectiveCommand
          ]
      : [
          "sandbox", "windows",
          "--full-auto",
          "--",
          shell, ...shellFlags, effectiveCommand
        ]

    // ACL grant/revoke needed for unelevated mode and readonly+admin (restricted token still needs NTFS permission).
    // Readonly non-admin also needs TEMP writable so commands (git, python, etc.) that write temp files don't fail.
    const aclDirs: string[] = []
    if (!isReadonly || elevated) {
      aclDirs.push(this.workingDir)
    }
    // Always grant TEMP write for all sandbox modes — even readonly non-admin
    // needs it for commands that create temp files.
    const tmpDir = process.env.TEMP || process.env.TMP
    if (tmpDir && !aclDirs.includes(tmpDir)) {
      aclDirs.push(tmpDir)
    }
    await Promise.all(aclDirs.map((dir) => LocalSandbox.grantSandboxWriteAcl(dir)))

    try {
    return await new Promise<ExecuteResponse>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let resolved = false
      let exited = false

      // spawn() reports ENOENT asynchronously via the "error" event, not by throwing
      const proc = spawn(this.codexExePath, sandboxArgs, {
        cwd: this.workingDir,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"]
      })

      LocalSandbox.activeProcesses.add(proc)

      let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null

      const killProc = (): void => {
        void LocalSandbox.killTree(proc, () => exited)
      }

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          LocalSandbox.activeProcesses.delete(proc)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          killProc()
          resolve({
            output: `Error: Command timed out after ${(this.timeout / 1000).toFixed(1)} seconds.`,
            exitCode: null,
            truncated: false
          })
        }
      }, this.timeout)

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (totalBytes < this.maxOutputBytes) {
          stdoutChunks.push(chunk)
          totalBytes += chunk.length
        }
      })

      proc.stderr?.on("data", (chunk: Buffer) => {
        if (totalBytes < this.maxOutputBytes) {
          stderrChunks.push(chunk)
          totalBytes += chunk.length
        }
      })

      const collectAndResolve = (code: number | null, signal: string | null): void => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)

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

        resolve({ output, exitCode: signal ? null : code, truncated })
      }

      proc.on("exit", (code, signal) => {
        exited = true
        windowsExitTimerId = setTimeout(() => {
          collectAndResolve(code, signal as string | null)
        }, 500)
      })

      proc.on("close", (code, signal) => {
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)

        const errno = err as NodeJS.ErrnoException
        if (errno.code === "EPERM" && attempt <= LocalSandbox.SPAWN_RETRY_COUNT) {
          console.warn(
            `[LocalSandbox] codex.exe EPERM attempt ${attempt}/${LocalSandbox.SPAWN_RETRY_COUNT + 1}, retrying in ${LocalSandbox.SPAWN_RETRY_DELAY_MS}ms…`
          )
          setTimeout(() => {
            resolve(this.executeInWindowsSandbox(command, attempt + 1))
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
    } finally {
      if (aclDirs.length > 0) {
        await Promise.all(aclDirs.map((dir) => LocalSandbox.revokeSandboxWriteAcl(dir)))
      }
    }
  }

  private executeOnce(
    command: string,
    shell: string,
    isWindows: boolean
  ): Promise<ExecuteResponse> {
    return new Promise<ExecuteResponse>((resolve) => {
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalBytes = 0
      let byteCapReached = false
      let resolved = false
      let exited = false

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

      LocalSandbox.activeProcesses.add(proc)

      let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null

      // Intentionally fire-and-forget: timeout/error already resolved,
      // kill is best-effort cleanup (same pattern as OpenCode's abort handler).
      const killProc = (): void => {
        void LocalSandbox.killTree(proc, () => exited)
      }

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true
          LocalSandbox.activeProcesses.delete(proc)
          if (windowsExitTimerId) clearTimeout(windowsExitTimerId)
          killProc()
          resolve({
            output: `Error: Command timed out after ${(this.timeout / 1000).toFixed(1)} seconds.`,
            exitCode: null,
            truncated: false
          })
        }
      }, this.timeout)

      proc.stdout.on("data", (chunk: Buffer) => {
        if (byteCapReached) return
        stdoutChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        if (byteCapReached) return
        stderrChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      const collectAndResolve = (code: number | null, signal: string | null): void => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        if (windowsExitTimerId) clearTimeout(windowsExitTimerId)

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

        resolve({ output, exitCode: signal ? null : code, truncated })
      }

      // On Windows, .bat files may spawn child processes that inherit pipe handles.
      // The 'close' event waits for all handles to close (including orphaned children),
      // which can block indefinitely. Listen for 'exit' and resolve after a grace period.
      if (isWindows) {
        proc.on("exit", (code, signal) => {
          exited = true
          windowsExitTimerId = setTimeout(() => {
            collectAndResolve(code, signal as string | null)
          }, 500)
        })
      }

      proc.on("close", (code, signal) => {
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        if (resolved) return
        resolved = true
        exited = true
        LocalSandbox.activeProcesses.delete(proc)
        clearTimeout(timeoutId)
        resolve({
          output: `Error: Failed to execute command: ${err.message}`,
          exitCode: 1,
          truncated: false
        })
      })
    })
  }
}
