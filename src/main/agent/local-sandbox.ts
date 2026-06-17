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

import { AsyncLocalStorage } from "node:async_hooks"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  realpathSync,
  type ReadStream
} from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import {
  FilesystemBackend,
  type EditResult,
  type WriteResult,
  type ExecuteResponse,
  type SandboxBackendProtocol,
  type GrepMatch,
  type FileInfo,
  type FileUploadResponse,
  type FileOperationError
} from "deepagents"
import fg from "fast-glob"
import * as iconv from "iconv-lite"
import * as chardet from "jschardet"
import micromatch from "micromatch"
import { replace } from "./replace"
import type { ToolOrchestrator } from "./tool-orchestrator"
import {
  assessCommandSafety,
  classifyCommandConcurrency,
  isReadOnlyShellCommand
} from "./exec-policy"
import {
  areElevatedRootsPreparedAsync,
  isElevatedSetupComplete,
  markElevatedRootsPrepared,
  runElevatedSetupForPaths,
  normalizeDirKey,
  getElevatedSystemSensitivePathError,
  validateElevatedWorkspaceRoot
} from "../ipc/sandbox"
import { getWindowsSandboxMode } from "../storage"
import { homedir, userInfo } from "node:os"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import type { HookContext, HookResultCallback } from "../hooks/runner"
import { runHooksEnriched } from "../hooks/required-skill"
import {
  detectToolFailure,
  hasFailureFired,
  markFailureFired
} from "../hooks/tool-failure"
import { isHookHaltError, throwIfHookHalt } from "../hooks/halt"
import { mergeUpdatedInput } from "../hooks/updated-input"
import type { HookScopeController } from "../hooks/scope"
import type { SkillLifecycleMatch, SkillLifecycleRegistry } from "./skill-lifecycle/registry"
import { getSkillActivationKey } from "./skill-lifecycle/activation"
import type { SkillUseTracker } from "./skill-lifecycle/tracker"
import type { AgentFileMutationKind } from "../services/agent-auto-commit"
import { recordGen as recordAdoptionGen } from "../services/adoption-tracker"
import {
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  trimReadFileOutputLines
} from "./read-file-output"

const execFileP = promisify(execFile)

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Sensitive directories under user profile that sandbox tools should not access.
 * Matches codex's USERPROFILE_READ_ROOT_EXCLUSIONS.
 */
const SENSITIVE_DIR_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".npm",
  ".pki",
  ".terraform.d"
])

const WINDOWS_SANDBOX_OFFLINE_USERNAME = "CodexSandboxOffline"
const WINDOWS_SANDBOX_ONLINE_USERNAME = "CodexSandboxOnline"

interface PendingSkillHookContext {
  skill: SkillLifecycleMatch
  notes: string[]
}

export interface SkillHookContextProvider {
  drainSkillHookContexts(): string[]
}

export type LocalSandboxHookResolver = (event: HookEvent, context: HookContext) => HookConfig[]

export interface LocalSandboxReadFileOptions {
  maxFormattedContentChars?: number
  // Internal lookahead used to build accurate pagination/truncation hints,
  // especially for long-line continuation chunks and output-line budget edges.
  // Any lookahead content is trimmed before returning output or running PostToolUse hooks.
  includeLookahead?: boolean
}

interface FormattedReadLineState {
  lines: string[]
  charLength: number
  truncatedByOutputBudget: boolean
  truncatedWithinLine: number | null
  truncatedBeforeLine: number | null
  lastVisibleSourceLine: number | null
}

interface ReadRangeFormatResult {
  formattedLines: string[]
  totalLines: number
  hasNonWhitespace: boolean
  resolvedPath: string
  truncatedByOutputBudget: boolean
  truncatedWithinLine: number | null
  truncatedBeforeLine: number | null
  lastVisibleSourceLine: number | null
}

interface EncodingAwareLiteralSearchResult {
  results: Record<string, Array<[number, string]>>
  stoppedEarly: boolean
}

// Python's tempfile uses private 0o700 directories on Windows. Under Codex's
// WRITE_RESTRICTED token those DACLs omit the capability SID, so pip cannot
// reopen its own pip-unpack-* directories. Keep the patch scoped to sandbox TEMP.
const PYTHON_TEMP_ACL_SITE_CUSTOMIZE = `import os

if os.name == "nt" and os.environ.get("CMB_SANDBOX_FIX_PYTHON_TEMP_ACL") == "1":
    _orig_mkdir = os.mkdir
    _roots = []
    for _key in ("TEMP", "TMP"):
        _value = os.environ.get(_key)
        if _value:
            try:
                _roots.append(os.path.normcase(os.path.abspath(_value)))
            except Exception:
                pass

    def _under_temp(path):
        try:
            full = os.path.normcase(os.path.abspath(path))
        except Exception:
            return False
        for root in _roots:
            if full == root or full.startswith(root + os.sep):
                return True
        return False

    class _MkdirInheritAcl:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def __call__(self, path, mode=0o777, *args, **kwargs):
            if mode in (0o600, 0o700) and _under_temp(path):
                mode = 0o777
            return self._wrapped(path, mode, *args, **kwargs)

    os.mkdir = _MkdirInheritAcl(_orig_mkdir)
`

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

function tomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f")
    .replace(/\r/g, "\\r")}"`
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
  windowsSandbox?: WindowsSandboxMode
  /** Full path to codex.exe for Windows sandbox. Falls back to 'codex' on PATH if not provided. */
  codexExePath?: string
  /** Hook configurations for PreToolUse/PostToolUse lifecycle events.
   *  Accepts a getter function so hooks are always read fresh from storage. */
  hooks?: HookConfig[] | (() => HookConfig[])
  /** Run-scoped hook resolver; when omitted, `hooks` is used as a static/global list. */
  hookResolver?: LocalSandboxHookResolver
  /** Run-scoped skill/plugin activation state. */
  hookScope?: HookScopeController
  /** Optional callback invoked after each hook executes — used to emit results to the renderer. */
  onHookResult?: HookResultCallback
  /** Renderer user message id that owns this chat turn, used to group hook logs. */
  hookTurnId?: string
  /** AbortSignal for cancelling running child processes when the user aborts.
   *  When signalled, any in-flight execute() will kill its child process immediately
   *  (SIGTERM → 200ms → SIGKILL), matching OpenCode/Codex abort behaviour. */
  abortSignal?: AbortSignal
  /** Unique run/thread identifier used for ACL ref-counting across concurrent runs. */
  runId?: string
  /** Records successful agent-owned file mutations for post-run automation. */
  onFileMutation?: (filePath: string, kind: AgentFileMutationKind) => void
  /** Detects reads of skill files so skill lifecycle hooks can wrap the load. */
  skillLifecycleRegistry?: SkillLifecycleRegistry
  /** Shared run-scoped set used to avoid firing skill lifecycle hooks twice. */
  skillHookKeys?: Set<string>
  /** Records skills activated this turn so PostSkillUse can run at turn completion. */
  skillUseTracker?: SkillUseTracker
  /** Optional plugin output directory exposed to hook commands as PLUGIN_OUTPUT_DIR. */
  pluginOutputDir?: string
  /** Optional system identifier exposed to child processes and hooks as SYSTEM_ID. */
  systemId?: string
  /** Optional harness plugin root exposed to child processes as PLUGIN_ROOT. */
  pluginRoot?: string
  /** Optional harness plugin identifier exposed to child processes as PLUGIN_ID. */
  pluginId?: string
  /** Optional harness plugin display name exposed to child processes as PLUGIN_NAME. */
  pluginName?: string
  /** Optional harness plugin workspace exposed to child processes as PLUGIN_WORKSPACE. */
  pluginWorkspace?: string
  /** Optional harness feature identifier exposed to child processes as FEATURE_ID. */
  featureId?: string
  /** Optional harness project code exposed to child processes as PROJECT_CODE. */
  projectCode?: string
}

interface ExecuteRawOptions {
  background?: boolean
  cwd?: string
}

type WindowsSandboxMode = "none" | "unelevated" | "readonly" | "elevated"

interface WindowsSandboxExecutionPlan {
  mode: WindowsSandboxMode
  writableRoots: string[]
}

type ExecutionConcurrencyMode = "shared" | "exclusive"

interface ExecutionGate {
  activeShared: number
  exclusiveHeld: boolean
  sharedQueue: Array<() => void>
  exclusiveQueue: Array<() => void>
}

interface WorkspaceSwitchPreparationResult {
  ready: boolean
  prompted: boolean
  reason?: "system-sensitive-path" | "invalid-workspace-path"
  error?: string
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

/**
 * Per-execution read-only enforcement, scoped to one tool call's async context.
 *
 * A Solo read-only registry subagent (Explore/Plan) SHARES the main agent's
 * LocalSandbox, which isn't instance-flagged read-only — so its post-hook gate
 * can't rely on `readOnlyShellEnforced`. Its guard middleware instead runs the
 * execute tool call inside `readOnlyShellExecutionContext.run(true, …)`;
 * execute()/executeBackground() read this store and enforce the read-only policy
 * on the EFFECTIVE command. AsyncLocalStorage scopes the flag to THIS call's
 * async chain, so concurrent calls (e.g. a write-capable sibling subagent on the
 * same shared backend) are NOT affected — avoiding the cross-call false-positives
 * a global backend flag would cause.
 */
export const readOnlyShellExecutionContext = new AsyncLocalStorage<boolean>()

export class LocalSandbox
  extends FilesystemBackend
  implements SandboxBackendProtocol, SkillHookContextProvider
{
  /** Unique identifier for this sandbox instance */
  readonly id: string
  /** Run/thread identifier for ACL ref-counting (falls back to this.id). */
  readonly runId: string

  private readonly timeout: number
  private readonly maxOutputBytes: number
  private readonly env: Record<string, string>
  private readonly workingDir: string
  private readonly windowsSandbox: WindowsSandboxMode
  private readonly pluginOutputDir?: string
  private readonly pluginRoot?: string
  private readonly systemId?: string
  private readonly pluginWorkspace?: string
  private readonly featureId?: string
  private readonly projectCode?: string
  private readonly codexExePath: string
  private readonly getHooks: () => HookConfig[]
  private readonly resolveHooks: LocalSandboxHookResolver
  private readonly _hookScope?: HookScopeController
  private readonly _onHookResult?: HookResultCallback
  private readonly _hookTurnId?: string
  /** App-owned persistent cache root granted as a Codex writable root per workspace. */
  private readonly _sandboxCacheRoot: string
  private readonly _sandboxCacheRootPromise: Promise<string>
  /** Shared download/artifact cache root reused across workspaces. */
  private readonly _sharedSandboxCacheRoot: string
  /** Optional orchestrator for fine-grained approval + sandbox retry */
  private orchestrator?: ToolOrchestrator
  /** When true, block direct git add/commit/push and force git_workflow usage. */
  private enforceGitWorkflowCommitOnly = false
  /** When true, this is a read-only agent/worker: every command actually executed
   * must pass isReadOnlyShellCommand. The runtime's execute tool already gates the
   * agent-issued command, but a PreToolUse hook can rewrite a read-only command
   * into a build/write one — so the EFFECTIVE (post-hook) command is re-checked
   * here, after the merge, for both foreground and background execution. */
  private readOnlyShellEnforced = false
  /** AbortSignal: when signalled, in-flight child processes are killed immediately. */
  private abortSignal?: AbortSignal
  /** Whether the conversation-level abort signal has been triggered. */
  get isAborted(): boolean {
    return this.abortSignal?.aborted ?? false
  }
  /** Cached from parent's private fields to avoid (this as any) scattered everywhere */
  private readonly _resolvePath: (key: string) => string
  private readonly _virtualMode: boolean
  private readonly _cwd: string
  private readonly _maxFileSizeBytes: number
  /** Per-file Promise chain lock to serialize concurrent read-write operations */
  private readonly _fileLocks = new Map<string, Promise<void>>()
  /** mtime recorded after each successful read/write, for external-modification detection */
  private readonly _fileReadTimes = new Map<string, number>()
  private readonly _onFileMutation?: (filePath: string, kind: AgentFileMutationKind) => void
  private _skillLifecycleRegistry?: SkillLifecycleRegistry
  private readonly _skillHooksFired: Set<string>
  private readonly _skillUseTracker?: SkillUseTracker
  private readonly _pendingSkillHookContexts: PendingSkillHookContext[] = []
  private readonly _hiddenSkillDirKeys = new Set<string>()

  /**
   * Apply PostToolUse hook feedback to a file-operation result (write/edit).
   *
   * ⚠️ UPSTREAM CONTRACT — depends on deepagents library internals:
   *   1. write_file / edit_file tool wrappers treat `result.error` as a failed
   *      file operation. Only use that channel for real file failures or explicit
   *      PostToolUse decision=block feedback.
   *   2. FilesystemBackend sets filesUpdate=null on writes (external storage), so
   *      overriding `error` on a successful write does NOT lose any LangGraph state.
   *
   * Non-blocking hook notes are preserved in metadata so they do not turn a
   * successful edit/write into a failed tool call.
   */
  private static applyPostHookContext<
    T extends { error?: string; path?: string; metadata?: Record<string, unknown> }
  >(result: T, postResult: HookResult | null, fileOpLabel: string): T {
    if (!postResult) return result
    throwIfHookHalt("PostToolUse", postResult, `${fileOpLabel} was stopped by a PostToolUse hook`)
    const notes: string[] = []
    if (!postResult.suppressOutput && postResult.stdout) {
      notes.push(`[Hook output]\n${postResult.stdout}`)
    }
    if (postResult.additionalContext) notes.push(`[Hook context] ${postResult.additionalContext}`)
    if (postResult.systemMessage) notes.push(`[Hook notice] ${postResult.systemMessage}`)
    if (postResult.decision === "block" && postResult.reason) {
      notes.push(`[Hook requested review] ${postResult.reason}`)
    }
    if (notes.length === 0) return result

    const originallyFailed = !!result.error
    const shouldSurfaceAsError = originallyFailed || postResult.decision === "block"
    if (!shouldSurfaceAsError) {
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          hookFeedback: notes.join("\n")
        }
      }
    }

    const statusLine = originallyFailed
      ? result.error
      : `${fileOpLabel} '${result.path ?? ""}' succeeded. File is persisted on disk — do not retry; address the hook feedback below in your next turn.`
    return { ...result, error: `${statusLine}\n${notes.join("\n")}` }
  }

  /**
   * Apply PostToolUse hook feedback to an ExecuteResponse.
   * additionalContext / decision=block reason are appended to `output` so the
   * LLM sees them alongside the command's actual output.
   */
  private static applyPostHookToExecResult(
    result: ExecuteResponse,
    postResult: HookResult | null
  ): ExecuteResponse {
    if (!postResult) return result
    throwIfHookHalt("PostToolUse", postResult, "execute was stopped by a PostToolUse hook")
    const parts: string[] = []
    if (!postResult.suppressOutput && postResult.stdout) {
      parts.push(`[Hook output]\n${postResult.stdout}`)
    }
    if (postResult.additionalContext) parts.push(`[Hook context]\n${postResult.additionalContext}`)
    if (postResult.systemMessage) parts.push(`[Hook notice]\n${postResult.systemMessage}`)
    if (postResult.decision === "block" && postResult.reason) {
      parts.push(`[Hook requested review] ${postResult.reason}`)
    }
    if (parts.length === 0) return result
    return { ...result, output: result.output + "\n\n" + parts.join("\n\n") }
  }

  private static formatPostHookTextFeedback(postResult: HookResult | null): string | null {
    if (!postResult) return null
    const parts: string[] = []
    if (!postResult.suppressOutput && postResult.stdout) {
      parts.push(`[Hook output]\n${postResult.stdout}`)
    }
    if (postResult.additionalContext) parts.push(`[Hook context]\n${postResult.additionalContext}`)
    if (postResult.systemMessage) parts.push(`[Hook notice]\n${postResult.systemMessage}`)
    if (postResult.decision === "block" && postResult.reason) {
      parts.push(`[Hook requested review] ${postResult.reason}`)
    }
    return parts.length > 0 ? parts.join("\n\n") : null
  }

  private static getElevatedSandboxUserProfileRoot(networkEnabled: boolean): string {
    const username = networkEnabled
      ? WINDOWS_SANDBOX_ONLINE_USERNAME
      : WINDOWS_SANDBOX_OFFLINE_USERNAME
    const systemDrive = process.env.SystemDrive || "C:"
    return path.win32.join(systemDrive, "Users", username)
  }

  private static buildSandboxCacheBase(env: Record<string, string>): string {
    const localAppData =
      env.LOCALAPPDATA || process.env.LOCALAPPDATA || path.win32.join(homedir(), "AppData", "Local")
    return path.win32.join(localAppData, "CmbCoworkAgent", "SandboxCaches")
  }

  private static buildSharedSandboxCacheRoot(env: Record<string, string>): string {
    return path.win32.join(LocalSandbox.buildSandboxCacheBase(env), "shared")
  }

  private static buildSandboxCacheRootFromCanonical(env: Record<string, string>, canonicalWorkingDir: string): string {
    const key = canonicalWorkingDir.replace(/\//g, "\\").toLowerCase()
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16)
    const name =
      path.win32
        .basename(canonicalWorkingDir)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .slice(0, 40) || "workspace"
    return path.win32.join(LocalSandbox.buildSandboxCacheBase(env), `${name}-${hash}`)
  }

  private static async buildSandboxCacheRoot(env: Record<string, string>, workingDir: string): Promise<string> {
    let canonicalWorkingDir = path.resolve(workingDir)
    try {
      canonicalWorkingDir = await fs.realpath(workingDir)
    } catch {
      // Missing or inaccessible workspaces still need a stable fallback cache key.
    }
    return LocalSandbox.buildSandboxCacheRootFromCanonical(env, canonicalWorkingDir)
  }

  private static getSandboxToolCacheDirs(cacheRoot: string, sharedCacheRoot = cacheRoot) {
    const pythonUserBase = path.win32.join(cacheRoot, "python-userbase")
    const pythonSiteCustomize = path.win32.join(cacheRoot, "python-sitecustomize")
    const pythonScriptDirs = [path.win32.join(pythonUserBase, "Scripts")]
    for (let minor = 8; minor <= 14; minor++) {
      pythonScriptDirs.push(path.win32.join(pythonUserBase, `Python3${minor}`, "Scripts"))
    }

    return {
      root: cacheRoot,
      sharedRoot: sharedCacheRoot,
      npmCache: path.win32.join(sharedCacheRoot, "npm-cache"),
      npmPrefix: path.win32.join(cacheRoot, "npm-prefix"),
      yarnCache: path.win32.join(sharedCacheRoot, "yarn-cache"),
      yarnGlobal: path.win32.join(cacheRoot, "yarn-global"),
      pnpmHome: path.win32.join(cacheRoot, "pnpm-home"),
      pnpmStore: path.win32.join(sharedCacheRoot, "pnpm-store"),
      corepackHome: path.win32.join(sharedCacheRoot, "corepack-home"),
      nodeGypCache: path.win32.join(sharedCacheRoot, "node-gyp-cache"),
      playwrightBrowsers: path.win32.join(sharedCacheRoot, "playwright-browsers"),
      puppeteerCache: path.win32.join(sharedCacheRoot, "puppeteer-cache"),
      cypressCache: path.win32.join(sharedCacheRoot, "cypress-cache"),
      electronCache: path.win32.join(sharedCacheRoot, "electron-cache"),
      electronBuilderCache: path.win32.join(sharedCacheRoot, "electron-builder-cache"),
      goPath: path.win32.join(cacheRoot, "go"),
      goModCache: path.win32.join(sharedCacheRoot, "go-mod-cache"),
      goBin: path.win32.join(cacheRoot, "go", "bin"),
      goBuildCache: path.win32.join(sharedCacheRoot, "go-build-cache"),
      cargoHome: path.win32.join(cacheRoot, "cargo-home"),
      rustupHome: path.win32.join(cacheRoot, "rustup-home"),
      nugetPackages: path.win32.join(sharedCacheRoot, "nuget-packages"),
      nugetHttpCache: path.win32.join(sharedCacheRoot, "nuget-http-cache"),
      nugetScratch: path.win32.join(cacheRoot, "nuget-scratch"),
      dotnetHome: path.win32.join(cacheRoot, "dotnet-home"),
      gemHome: path.win32.join(cacheRoot, "gem-home"),
      bundleHome: path.win32.join(cacheRoot, "bundle-home"),
      pythonUserBase,
      pythonSiteCustomize,
      pythonScriptDirs,
      pipCache: path.win32.join(sharedCacheRoot, "pip-cache"),
      uvCache: path.win32.join(sharedCacheRoot, "uv-cache"),
      pipxHome: path.win32.join(cacheRoot, "pipx-home"),
      pipxBin: path.win32.join(cacheRoot, "pipx-bin"),
      poetryCache: path.win32.join(sharedCacheRoot, "poetry-cache"),
      poetryConfig: path.win32.join(cacheRoot, "poetry-config"),
      poetryData: path.win32.join(cacheRoot, "poetry-data"),
      condaPkgs: path.win32.join(sharedCacheRoot, "conda-pkgs"),
      gradleHome: path.win32.join(cacheRoot, "gradle-home"),
      mavenRepo: path.win32.join(sharedCacheRoot, "m2-repository"),
      sbtBase: path.win32.join(cacheRoot, "sbt"),
      ivyHome: path.win32.join(cacheRoot, "ivy2"),
      coursierCache: path.win32.join(sharedCacheRoot, "coursier-cache"),
      vcpkgCache: path.win32.join(sharedCacheRoot, "vcpkg-cache"),
      tempDir: path.win32.join(cacheRoot, "tmp"),
      xdgCache: path.win32.join(cacheRoot, "xdg-cache")
    }
  }

  private static buildSandboxToolEnv(
    cacheRoot: string,
    sharedCacheRoot = cacheRoot
  ): { env: Array<[string, string]>; pathEntries: string[] } {
    const dirs = LocalSandbox.getSandboxToolCacheDirs(cacheRoot, sharedCacheRoot)
    return {
      env: [
        ["NPM_CONFIG_CACHE", dirs.npmCache],
        ["NPM_CONFIG_PREFIX", dirs.npmPrefix],
        ["YARN_CACHE_FOLDER", dirs.yarnCache],
        ["YARN_GLOBAL_FOLDER", dirs.yarnGlobal],
        ["PNPM_HOME", dirs.pnpmHome],
        ["PNPM_STORE_DIR", dirs.pnpmStore],
        ["COREPACK_HOME", dirs.corepackHome],
        ["NPM_CONFIG_DEVDIR", dirs.nodeGypCache],
        ["PLAYWRIGHT_BROWSERS_PATH", dirs.playwrightBrowsers],
        ["PUPPETEER_CACHE_DIR", dirs.puppeteerCache],
        ["CYPRESS_CACHE_FOLDER", dirs.cypressCache],
        ["ELECTRON_CACHE", dirs.electronCache],
        ["ELECTRON_BUILDER_CACHE", dirs.electronBuilderCache],
        ["GOPATH", dirs.goPath],
        ["GOMODCACHE", dirs.goModCache],
        ["GOBIN", dirs.goBin],
        ["GOCACHE", dirs.goBuildCache],
        ["CARGO_HOME", dirs.cargoHome],
        ["RUSTUP_HOME", dirs.rustupHome],
        ["CARGO_GIT_FETCH_WITH_CLI", "true"],
        ["CURL_SSL_BACKEND", "openssl"],
        ["NUGET_PACKAGES", dirs.nugetPackages],
        ["NUGET_HTTP_CACHE_PATH", dirs.nugetHttpCache],
        ["NUGET_SCRATCH", dirs.nugetScratch],
        ["DOTNET_CLI_HOME", dirs.dotnetHome],
        ["GEM_HOME", dirs.gemHome],
        ["BUNDLE_PATH", dirs.gemHome],
        ["BUNDLE_USER_HOME", dirs.bundleHome],
        ["PYTHONUSERBASE", dirs.pythonUserBase],
        ["CMB_SANDBOX_FIX_PYTHON_TEMP_ACL", "1"],
        ["PIP_CACHE_DIR", dirs.pipCache],
        ["UV_CACHE_DIR", dirs.uvCache],
        ["PIPX_HOME", dirs.pipxHome],
        ["PIPX_BIN_DIR", dirs.pipxBin],
        ["POETRY_CACHE_DIR", dirs.poetryCache],
        ["POETRY_CONFIG_DIR", dirs.poetryConfig],
        ["POETRY_DATA_DIR", dirs.poetryData],
        ["CONDA_PKGS_DIRS", dirs.condaPkgs],
        ["GRADLE_USER_HOME", dirs.gradleHome],
        ["COURSIER_CACHE", dirs.coursierCache],
        ["VCPKG_DEFAULT_BINARY_CACHE", dirs.vcpkgCache],
        ["TEMP", dirs.tempDir],
        ["TMP", dirs.tempDir],
        ["TMPDIR", dirs.tempDir],
        ["XDG_CACHE_HOME", dirs.xdgCache]
      ],
      pathEntries: [
        dirs.npmPrefix,
        dirs.pnpmHome,
        dirs.goBin,
        path.win32.join(dirs.cargoHome, "bin"),
        path.win32.join(dirs.dotnetHome, ".dotnet", "tools"),
        path.win32.join(dirs.gemHome, "bin"),
        dirs.pipxBin,
        ...dirs.pythonScriptDirs
      ]
    }
  }

  private static readonly _preparedSandboxCacheDirs = new Map<string, string[]>()
  private static readonly _sandboxCachePreparePromises = new Map<string, Promise<string[]>>()
  private static readonly _elevatedRootPreparePromises = new Map<string, Promise<boolean>>()
  private static readonly _elevatedWorkspacePreparePromises = new Map<string, Promise<boolean>>()
  private static readonly _elevatedWorkspaceSetupPromises =
    new Map<string, Promise<{ ready: boolean; error?: string }>>()
  private static readonly _executionGates = new Map<string, ExecutionGate>()
  private static readonly PARALLEL_SAFE_EXECUTION_LIMIT = 2
  // Keep command-time prewarm opportunistic. The Codex sandbox backend still
  // performs its own refresh; this tiny grace only lets an already-fast ACL
  // prewarm finish without making shell execution wait on setup work.
  private static readonly ELEVATED_COMMAND_PREPARE_GRACE_MS = 500
  // After an explicit UAC-approved setup completes, codex.exe can briefly
  // observe stale sandbox state across session switches.
  private static readonly ELEVATED_EXPLICIT_SETUP_SETTLE_MS = 1_500
  private static readonly SANDBOX_CACHE_PREPARE_CONCURRENCY = 8
  private static readonly ACL_OPERATION_CONCURRENCY = 2

  private static describeSandboxCacheDirs(cacheRoot: string, sharedCacheRoot = cacheRoot): {
    cacheKey: string
    uniqueDirs: string[]
    siteCustomizePath: string
  } {
    const dirs = LocalSandbox.getSandboxToolCacheDirs(cacheRoot, sharedCacheRoot)
    const cacheKey = `${normalizeDirKey(cacheRoot)}|${normalizeDirKey(sharedCacheRoot)}`
    const siteCustomizePath = path.win32.join(dirs.pythonSiteCustomize, "sitecustomize.py")
    const { pathEntries } = LocalSandbox.buildSandboxToolEnv(cacheRoot, sharedCacheRoot)
    const allDirs = [
      dirs.root,
      dirs.sharedRoot,
      dirs.npmCache,
      dirs.npmPrefix,
      dirs.yarnCache,
      dirs.yarnGlobal,
      dirs.pnpmHome,
      dirs.pnpmStore,
      dirs.corepackHome,
      dirs.nodeGypCache,
      dirs.playwrightBrowsers,
      dirs.puppeteerCache,
      dirs.cypressCache,
      dirs.electronCache,
      dirs.electronBuilderCache,
      dirs.goPath,
      dirs.goModCache,
      dirs.goBin,
      dirs.goBuildCache,
      dirs.cargoHome,
      dirs.rustupHome,
      dirs.nugetPackages,
      dirs.nugetHttpCache,
      dirs.nugetScratch,
      dirs.dotnetHome,
      dirs.gemHome,
      dirs.bundleHome,
      dirs.pythonUserBase,
      dirs.pythonSiteCustomize,
      ...dirs.pythonScriptDirs,
      dirs.pipCache,
      dirs.uvCache,
      dirs.pipxHome,
      dirs.pipxBin,
      dirs.poetryCache,
      dirs.poetryConfig,
      dirs.poetryData,
      dirs.condaPkgs,
      dirs.gradleHome,
      dirs.mavenRepo,
      dirs.sbtBase,
      dirs.ivyHome,
      dirs.coursierCache,
      dirs.vcpkgCache,
      dirs.tempDir,
      dirs.xdgCache,
      ...pathEntries
    ]
    const uniqueDirs = Array.from(new Set(allDirs.map((dir) => path.win32.normalize(dir))))
    return { cacheKey, uniqueDirs, siteCustomizePath }
  }

  private static async prepareSandboxCacheDirs(cacheRoot: string, sharedCacheRoot = cacheRoot): Promise<string[]> {
    const { cacheKey, uniqueDirs, siteCustomizePath } = LocalSandbox.describeSandboxCacheDirs(cacheRoot, sharedCacheRoot)
    const cachedDirs = LocalSandbox._preparedSandboxCacheDirs.get(cacheKey)
    if (cachedDirs) {
      if (await pathExists(siteCustomizePath)) {
        return cachedDirs
      }
      LocalSandbox._preparedSandboxCacheDirs.delete(cacheKey)
    }
    const existing = LocalSandbox._sandboxCachePreparePromises.get(cacheKey)
    if (existing) return existing

    const task = (async (): Promise<string[]> => {
      let prepared = true
      await mapLimit(uniqueDirs, LocalSandbox.SANDBOX_CACHE_PREPARE_CONCURRENCY, async (dir) => {
        try {
          await fs.mkdir(dir, { recursive: true })
        } catch (err) {
          prepared = false
          console.warn(`[LocalSandbox] failed to prepare sandbox cache dir ${dir}: ${err}`)
        }
      })
      try {
        await fs.writeFile(siteCustomizePath, PYTHON_TEMP_ACL_SITE_CUSTOMIZE, "utf8")
      } catch (err) {
        prepared = false
        console.warn(`[LocalSandbox] failed to prepare Python sandbox sitecustomize: ${err}`)
      }
      if (prepared) {
        LocalSandbox._preparedSandboxCacheDirs.set(cacheKey, uniqueDirs)
      }
      return uniqueDirs
    })()

    LocalSandbox._sandboxCachePreparePromises.set(cacheKey, task)
    task.finally(() => {
      if (LocalSandbox._sandboxCachePreparePromises.get(cacheKey) === task) {
        LocalSandbox._sandboxCachePreparePromises.delete(cacheKey)
      }
    }).catch(() => { /* handled by caller */ })
    return task
  }

  private static buildWritableRootsOverride(roots: string[]): string | undefined {
    if (roots.length === 0) return undefined
    return `sandbox_workspace_write.writable_roots=[${roots.map(tomlBasicString).join(",")}]`
  }

  private static createBaseWindowsSandboxExecutionPlan(mode: WindowsSandboxMode): WindowsSandboxExecutionPlan {
    return {
      mode,
      writableRoots: []
    }
  }

  private static buildWindowsSandboxExecutionPlan(
    _command: string,
    mode: WindowsSandboxMode,
    sandboxCacheRoots: string[]
  ): WindowsSandboxExecutionPlan {
    const plan = LocalSandbox.createBaseWindowsSandboxExecutionPlan(mode)
    if (mode === "elevated" || mode === "unelevated") {
      plan.writableRoots.push(...sandboxCacheRoots)
    }
    return plan
  }

  private static buildSerializedExecutionKey(
    runId: string,
    workingDir: string,
    sandboxMode: WindowsSandboxMode
  ): string {
    return `${runId}|${normalizeDirKey(workingDir)}|${sandboxMode}`
  }

  private static getExecutionGate(key: string): ExecutionGate {
    let gate = LocalSandbox._executionGates.get(key)
    if (!gate) {
      gate = {
        activeShared: 0,
        exclusiveHeld: false,
        sharedQueue: [],
        exclusiveQueue: []
      }
      LocalSandbox._executionGates.set(key, gate)
    }
    return gate
  }

  private static drainExecutionGate(gate: ExecutionGate, sharedLimit: number): void {
    if (gate.exclusiveHeld) return

    if (gate.activeShared === 0 && gate.exclusiveQueue.length > 0) {
      const nextExclusive = gate.exclusiveQueue.shift()
      if (nextExclusive) {
        gate.exclusiveHeld = true
        nextExclusive()
      }
      return
    }

    if (gate.exclusiveQueue.length > 0) return

    while (gate.activeShared < sharedLimit && gate.sharedQueue.length > 0) {
      const nextShared = gate.sharedQueue.shift()
      if (!nextShared) break
      gate.activeShared += 1
      nextShared()
    }
  }

  private static releaseExecutionGate(
    key: string,
    gate: ExecutionGate,
    mode: ExecutionConcurrencyMode,
    sharedLimit: number
  ): void {
    if (mode === "exclusive") {
      gate.exclusiveHeld = false
    } else {
      gate.activeShared = Math.max(0, gate.activeShared - 1)
    }

    LocalSandbox.drainExecutionGate(gate, sharedLimit)
    if (
      !gate.exclusiveHeld &&
      gate.activeShared === 0 &&
      gate.exclusiveQueue.length === 0 &&
      gate.sharedQueue.length === 0
    ) {
      LocalSandbox._executionGates.delete(key)
    }
  }

  private static async acquireExecutionGate(
    key: string,
    mode: ExecutionConcurrencyMode,
    sharedLimit: number
  ): Promise<() => void> {
    const gate = LocalSandbox.getExecutionGate(key)
    return new Promise<() => void>((resolve) => {
      const grant = () => {
        resolve(() => LocalSandbox.releaseExecutionGate(key, gate, mode, sharedLimit))
      }
      if (mode === "exclusive") {
        gate.exclusiveQueue.push(grant)
      } else {
        gate.sharedQueue.push(grant)
      }
      LocalSandbox.drainExecutionGate(gate, sharedLimit)
    })
  }

  private static async runExecutionWithConcurrency<T>(
    key: string,
    mode: ExecutionConcurrencyMode,
    task: () => Promise<T>
  ): Promise<T> {
    const waitStart = Date.now()
    const release = await LocalSandbox.acquireExecutionGate(
      key,
      mode,
      LocalSandbox.PARALLEL_SAFE_EXECUTION_LIMIT
    )
    const waited = Date.now() - waitStart
    if (waited > 50) {
      console.log(`[LocalSandbox] ${mode} command gate acquired ${key} after ${waited}ms`)
    }
    try {
      return await task()
    } finally {
      release()
    }
  }

  private static async runSerializedExecution<T>(key: string, task: () => Promise<T>): Promise<T> {
    return LocalSandbox.runExecutionWithConcurrency(key, "exclusive", task)
  }

  private static async runParallelSafeExecution<T>(key: string, task: () => Promise<T>): Promise<T> {
    return LocalSandbox.runExecutionWithConcurrency(key, "shared", task)
  }

  static prewarmForWorkspace(
    workspacePath: string,
    windowsSandbox: WindowsSandboxMode = getWindowsSandboxMode(),
    env?: Record<string, string>
  ): void {
    if (process.platform !== "win32" || windowsSandbox === "none") return

    if (windowsSandbox === "readonly") {
      void LocalSandbox.getElevationState().catch((err) => {
        console.warn("[LocalSandbox] failed to prewarm elevation state:", err)
      })
    }

    void LocalSandbox.resolveWindowsSandboxShell().catch((err) => {
      console.warn("[LocalSandbox] failed to prewarm sandbox shell:", err)
    })

    void LocalSandbox.resolvePythonDir().catch((err) => {
      console.warn("[LocalSandbox] failed to prewarm Python dir:", err)
    })

    if (!workspacePath) return

    void (async () => {
      const workspaceValidation = windowsSandbox === "elevated"
        ? await validateElevatedWorkspaceRoot(workspacePath)
        : null
      if (workspaceValidation && (!workspaceValidation.ok || !workspaceValidation.resolved)) return

      const resolvedWorkspace = workspaceValidation?.resolved ?? path.resolve(workspacePath)
      const baseEnv = env ?? ({ ...process.env } as Record<string, string>)
      const cacheRoot = await LocalSandbox.buildSandboxCacheRoot(baseEnv, resolvedWorkspace)
      const sharedCacheRoot = LocalSandbox.buildSharedSandboxCacheRoot(baseEnv)

      void LocalSandbox.prepareSandboxCacheDirs(cacheRoot, sharedCacheRoot).catch((err) => {
        console.warn("[LocalSandbox] failed to prewarm sandbox cache dirs:", err)
      })

      if (windowsSandbox === "elevated") {
        const cacheRoots = Array.from(new Set([
          cacheRoot,
          sharedCacheRoot
        ].map((dir) => path.win32.normalize(dir))))
        void LocalSandbox.prewarmElevatedWorkspaceRoots(resolvedWorkspace, cacheRoots).catch((err) => {
          console.warn("[LocalSandbox] failed to prewarm elevated workspace roots:", err)
        })
      }
    })().catch((err) => {
      console.warn("[LocalSandbox] failed to schedule sandbox prewarm:", err)
    })
  }

  static prewarmForWorkspaces(
    workspacePaths: string[],
    windowsSandbox: WindowsSandboxMode = getWindowsSandboxMode(),
    env?: Record<string, string>
  ): void {
    for (const workspacePath of workspacePaths) {
      if (!workspacePath || typeof workspacePath !== "string") continue
      LocalSandbox.prewarmForWorkspace(workspacePath, windowsSandbox, env)
    }
  }

  private static async buildElevatedWorkspaceCacheRoots(
    workspacePath: string,
    env?: Record<string, string>
  ): Promise<{ resolvedWorkspace: string; cacheRoots: string[] }> {
    const resolvedWorkspace = path.resolve(workspacePath)
    const baseEnv = env ?? ({ ...process.env } as Record<string, string>)
    const cacheRoot = await LocalSandbox.buildSandboxCacheRoot(baseEnv, resolvedWorkspace)
    const sharedCacheRoot = LocalSandbox.buildSharedSandboxCacheRoot(baseEnv)
    const cacheRoots = Array.from(new Set([
      cacheRoot,
      sharedCacheRoot
    ].map((dir) => path.win32.normalize(dir))))
    return { resolvedWorkspace, cacheRoots }
  }

  private static async areElevatedWorkspaceRootsPrepared(workingDir: string, cacheRoots: string[]): Promise<boolean> {
    return areElevatedRootsPreparedAsync(LocalSandbox.getElevatedPrepareRoots(workingDir, cacheRoots))
  }

  private static shouldPromptForWorkspaceSwitchSetup(error?: string): boolean {
    if (!error) return false
    if (error === "initial elevated setup pending") return true
    const lower = error.toLowerCase()
    return lower.includes("icacls exited 5")
      || lower.includes("access is denied")
      || lower.includes("access denied")
      || lower.includes("permission denied")
      || error.includes("拒绝访问")
  }

  static async prepareWorkspaceForSelection(
    workspacePath: string,
    windowsSandbox: WindowsSandboxMode = getWindowsSandboxMode(),
    env?: Record<string, string>
  ): Promise<WorkspaceSwitchPreparationResult> {
    if (process.platform !== "win32" || !workspacePath || windowsSandbox !== "elevated") {
      return { ready: true, prompted: false }
    }

    const workspaceValidation = await validateElevatedWorkspaceRoot(workspacePath)
    if (!workspaceValidation.ok || !workspaceValidation.resolved) {
      return {
        ready: false,
        prompted: false,
        reason: workspaceValidation.reason === "system-sensitive-path"
          ? "system-sensitive-path"
          : "invalid-workspace-path",
        error: workspaceValidation.error || "Elevated 工作区路径无效。"
      }
    }

    const { resolvedWorkspace, cacheRoots } = await LocalSandbox.buildElevatedWorkspaceCacheRoots(workspaceValidation.resolved, env)
    if (await LocalSandbox.areElevatedWorkspaceRootsPrepared(resolvedWorkspace, cacheRoots)) {
      return { ready: true, prompted: false }
    }

    const preflight = await LocalSandbox.ensureElevatedWorkspaceSetup(
      resolvedWorkspace,
      cacheRoots,
      false
    )
    if (preflight.ready) {
      return { ready: true, prompted: false }
    }

    const preflightError = preflight.error || "未知错误"
    if (!LocalSandbox.shouldPromptForWorkspaceSwitchSetup(preflightError)) {
      return { ready: false, prompted: false, error: preflightError }
    }

    const promptedSetup = await LocalSandbox.ensureElevatedWorkspaceSetup(
      resolvedWorkspace,
      cacheRoots,
      true
    )
    if (!promptedSetup.ready) {
      return {
        ready: false,
        prompted: true,
        error: promptedSetup.error || preflightError
      }
    }

    return { ready: true, prompted: true }
  }

  private static buildElevatedSandboxEnvPreamble(
    shellBase: string,
    cacheRoot: string,
    sharedCacheRoot = cacheRoot,
    hostEnv?: Record<string, string>
  ): string {
    const profileRoot = LocalSandbox.getElevatedSandboxUserProfileRoot(true)
    const homeDrive = path.win32.parse(profileRoot).root.replace(/\\$/, "")
    const homePath = profileRoot.slice(homeDrive.length) || "\\"
    const localAppData = path.win32.join(profileRoot, "AppData", "Local")
    const roamingAppData = path.win32.join(profileRoot, "AppData", "Roaming")
    const toolEnv = LocalSandbox.buildSandboxToolEnv(cacheRoot, sharedCacheRoot)
    const toolDirs = LocalSandbox.getSandboxToolCacheDirs(cacheRoot, sharedCacheRoot)
    const pathPrefix = Array.from(new Set(toolEnv.pathEntries)).join(";")
    // Redirect standard Windows profile env vars to the sandbox user's persistent profile.
    // The sandbox user (CodexSandboxOnline) has full control over its own profile, so all
    // non-overridden tools can read/write their default cache locations under
    // USERPROFILE/APPDATA/LOCALAPPDATA. Tool installs/caches that need to survive across
    // elevated/unelevated commands are redirected to the app-owned persistent cache root,
    // which is passed to Codex as a writable_root so setup grants the capability SID.
    const envOverrides: Array<[string, string]> = [
      ["USERPROFILE", profileRoot],
      ["HOME", profileRoot],
      ["HOMEDRIVE", homeDrive],
      ["HOMEPATH", homePath],
      ["APPDATA", roamingAppData],
      ["LOCALAPPDATA", localAppData],
      ["USERNAME", WINDOWS_SANDBOX_ONLINE_USERNAME],
      ["LOGNAME", WINDOWS_SANDBOX_ONLINE_USERNAME],
      ...toolEnv.env
    ]

    // Preserve host user's JAVA_HOME so the sandbox user can locate the JDK.
    // The sandbox user's own profile has no JDK; without this, tools that depend
    // on JAVA_HOME (javac, mvn, gradle, etc.) fail with "JAVA_HOME not found".
    const hostJavaHome = process.env.JAVA_HOME
    if (hostJavaHome) {
      envOverrides.push(["JAVA_HOME", hostJavaHome])
    }

    // Maven-specific JVM strategy:
    //   JAVA_TOOL_OPTIONS → encoding only; do not set user.home globally.
    //   MAVEN_OPTS        → maven.repo.local under the app-owned writable cache root.
    // This avoids conflicting -Duser.home values while keeping Maven writes inside the
    // same writable-root mechanism Codex grants for elevated workspace-write.
    // Maven commands are routed to unelevated mode before this path, so the real user's
    // ~/.m2/settings.xml remains available without exposing the host profile in elevated mode.
    // Force UTF-8 encoding for all JVM output to match our chcp 65001 / [Console]::OutputEncoding=UTF8 preamble.
    // Without this, Java defaults to system encoding (GBK on Chinese Windows) → garbled output in PowerShell.
    const javaUtf8Flags =
      "-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8"
    const javaToolFlags = javaUtf8Flags
    const mavenFlags = `${javaUtf8Flags} -Dmaven.repo.local=${toolDirs.mavenRepo}`
    // sbt/ivy: keep writable state out of the host user's real ~/.sbt / ~/.ivy2.
    const sbtFlags = `-Dsbt.global.base=${toolDirs.sbtBase} -Divy.home=${toolDirs.ivyHome}`

    // Inject git config for the sandbox user via GIT_CONFIG_COUNT/KEY/VALUE (git ≥ 2.31):
    //   * http.sslBackend=openssl — sandbox user lacks access to the Windows LSA so SChannel
    //     credential init fails; OpenSSL works under restricted tokens.
    //   * safe.directory=*       — the elevated sandbox runs as CodexSandboxOnline but the
    //     repo is owned by the host user, which trips git's "dubious ownership" check on every
    //     command. Trusting all paths inside the sandbox shell is safe — Codex's sandbox token
    //     already restricts what the user can read/write at the OS level.
    const gitSslCmd = 'set "GIT_CONFIG_COUNT=2" & set "GIT_CONFIG_KEY_0=http.sslBackend" & set "GIT_CONFIG_VALUE_0=openssl" & set "GIT_CONFIG_KEY_1=safe.directory" & set "GIT_CONFIG_VALUE_1=*"'
    const gitSslPs  = "$env:GIT_CONFIG_COUNT='2'; $env:GIT_CONFIG_KEY_0='http.sslBackend'; $env:GIT_CONFIG_VALUE_0='openssl'; $env:GIT_CONFIG_KEY_1='safe.directory'; $env:GIT_CONFIG_VALUE_1='*'"

    // The elevated sandbox runs as CodexSandboxOnline whose registry PATH only has System32.
    // codex.exe's CreateProcessAsUser loads that minimal PATH — the main-process PATH (with
    // Maven, Gradle, custom tools, etc.) is NOT inherited. Inject the host PATH here so the
    // command shell sees the full toolchain.  Strip MSYS2 usr/bin paths first — those binaries
    // crash under restricted tokens (DLL 0xC0000135).
    const rawHostPath = hostEnv?.PATH ?? hostEnv?.Path ?? process.env.PATH ?? ""
    const filteredHostPath = rawHostPath
      .split(";")
      .filter((p) => {
        const lower = p.toLowerCase()
        return !(lower.includes("\\usr\\bin") && lower.includes("git"))
      })
      .join(";")

    if (shellBase === "cmd") {
      const base = envOverrides
        .map(([key, value]) => `set "${key}=${cmdSetLiteral(value)}"`)
        .join(" & ")
      const fullPrefix = [pathPrefix, filteredHostPath].filter(Boolean).join(";")
      const pathPreamble = fullPrefix ? `set "PATH=${cmdSetLiteral(fullPrefix)};%PATH%"` : ""
      const pythonPathPreamble = `set "PYTHONPATH=${cmdSetLiteral(toolDirs.pythonSiteCustomize)};%PYTHONPATH%"`
      const jvmOpts = `set "JAVA_TOOL_OPTIONS=%JAVA_TOOL_OPTIONS% ${cmdSetLiteral(javaToolFlags)}" & set "MAVEN_OPTS=%MAVEN_OPTS% ${cmdSetLiteral(mavenFlags)}" & set "SBT_OPTS=%SBT_OPTS% ${cmdSetLiteral(sbtFlags)}"`
      const nodeOptions = 'set "NODE_OPTIONS="'
      return [base, pathPreamble, pythonPathPreamble, jvmOpts, nodeOptions, gitSslCmd].filter(Boolean).join(" & ")
    }

    if (shellBase === "pwsh" || shellBase === "powershell") {
      const base = envOverrides
        .map(([key, value]) => `$env:${key}=${powershellSingleQuote(value)}`)
        .join("; ")
      const fullPrefix = [pathPrefix, filteredHostPath].filter(Boolean).join(";")
      const pathPreamble = fullPrefix
        ? `$env:PATH=${powershellSingleQuote(fullPrefix)} + ';' + $env:PATH`
        : ""
      const pythonPathPreamble = `$env:PYTHONPATH=${powershellSingleQuote(toolDirs.pythonSiteCustomize)} + $(if ($env:PYTHONPATH) { ';' + $env:PYTHONPATH } else { '' })`
      const javaToolFlagsEscaped = javaToolFlags.replace(/\\/g, "\\\\")
      const mavenFlagsEscaped = mavenFlags.replace(/\\/g, "\\\\")
      const sbtFlagsEscaped = sbtFlags.replace(/\\/g, "\\\\")
      const jvmOpts = `$env:JAVA_TOOL_OPTIONS="$($env:JAVA_TOOL_OPTIONS) ${javaToolFlagsEscaped}"; $env:MAVEN_OPTS="$($env:MAVEN_OPTS) ${mavenFlagsEscaped}"; $env:SBT_OPTS="$($env:SBT_OPTS) ${sbtFlagsEscaped}"`
      const nodeOptions = "$env:NODE_OPTIONS=$null"
      return [base, pathPreamble, pythonPathPreamble, jvmOpts, nodeOptions, gitSslPs].filter(Boolean).join("; ")
    }

    return ""
  }

  /**
   * Build JVM + Python environment preamble for unelevated sandbox mode.
   * Unelevated mode runs as the same user but with a restricted token that only allows
   * writing to the workspace dir and configured writable_roots. Tool caches/user installs
   * are redirected to the same app-owned persistent cache root used by elevated mode.
   * No user.home redirect needed — keep JVM home behavior aligned with Codex.
   */
  private static buildUnelevatedEnvPreamble(
    shellBase: string,
    cacheRoot: string,
    sharedCacheRoot = cacheRoot
  ): string {
    const toolEnv = LocalSandbox.buildSandboxToolEnv(cacheRoot, sharedCacheRoot)
    const toolDirs = LocalSandbox.getSandboxToolCacheDirs(cacheRoot, sharedCacheRoot)
    const pathPrefix = Array.from(new Set(toolEnv.pathEntries)).join(";")

    // ── JVM flags ──
    const javaUtf8Flags =
      "-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8"
    const javaToolFlags = javaUtf8Flags
    const mavenFlags = `${javaUtf8Flags} -Dmaven.repo.local=${toolDirs.mavenRepo}`
    // sbt/ivy
    const sbtFlags = `-Dsbt.global.base=${toolDirs.sbtBase} -Divy.home=${toolDirs.ivyHome}`

    if (shellBase === "cmd") {
      const toolCache = toolEnv.env
        .map(([key, value]) => `set "${key}=${cmdSetLiteral(value)}"`)
        .join(" & ")
      const pathPreamble = pathPrefix ? `set "PATH=${cmdSetLiteral(pathPrefix)};%PATH%"` : ""
      const pythonPathPreamble = `set "PYTHONPATH=${cmdSetLiteral(toolDirs.pythonSiteCustomize)};%PYTHONPATH%"`
      const jvmOpts = `set "JAVA_TOOL_OPTIONS=%JAVA_TOOL_OPTIONS% ${cmdSetLiteral(javaToolFlags)}" & set "MAVEN_OPTS=%MAVEN_OPTS% ${cmdSetLiteral(mavenFlags)}" & set "SBT_OPTS=%SBT_OPTS% ${cmdSetLiteral(sbtFlags)}"`
      const nodeOptions = 'set "NODE_OPTIONS="'
      return [toolCache, pathPreamble, pythonPathPreamble, jvmOpts, nodeOptions].filter(Boolean).join(" & ")
    }

    if (shellBase === "pwsh" || shellBase === "powershell") {
      const toolCache = toolEnv.env
        .map(([key, value]) => `$env:${key}=${powershellSingleQuote(value)}`)
        .join("; ")
      const pathPreamble = pathPrefix
        ? `$env:PATH=${powershellSingleQuote(pathPrefix)} + ';' + $env:PATH`
        : ""
      const pythonPathPreamble = `$env:PYTHONPATH=${powershellSingleQuote(toolDirs.pythonSiteCustomize)} + $(if ($env:PYTHONPATH) { ';' + $env:PYTHONPATH } else { '' })`
      const javaToolFlagsEscaped = javaToolFlags.replace(/\\/g, "\\\\")
      const mavenFlagsEscaped = mavenFlags.replace(/\\/g, "\\\\")
      const sbtFlagsEscaped = sbtFlags.replace(/\\/g, "\\\\")
      const jvmOpts = `$env:JAVA_TOOL_OPTIONS="$($env:JAVA_TOOL_OPTIONS) ${javaToolFlagsEscaped}"; $env:MAVEN_OPTS="$($env:MAVEN_OPTS) ${mavenFlagsEscaped}"; $env:SBT_OPTS="$($env:SBT_OPTS) ${sbtFlagsEscaped}"`
      const nodeOptions = "$env:NODE_OPTIONS=$null"
      return [toolCache, pathPreamble, pythonPathPreamble, jvmOpts, nodeOptions].filter(Boolean).join("; ")
    }

    return ""
  }

  private static shouldFallbackToUnelevatedForNetworkAuth(output: string): boolean {
    const lower = output.toLowerCase()
    return (
      lower.includes("sec_e_no_credentials") ||
      lower.includes("no credentials are available in the security package") ||
      output.includes("安全包中没有凭据") ||
      (lower.includes("schannel") && lower.includes("credential")) ||
      (output.includes("Invoke-WebRequest") && output.includes("认证失败")) ||
      // SSL certificate errors: elevated sandbox user's certificate store is empty,
      // missing corporate CA root certs needed for HTTPS inspection/proxy
      lower.includes("certificate_verify_failed") ||
      lower.includes("unable to get local issuer certificate") ||
      (lower.includes("ssl") && lower.includes("certificate") && lower.includes("verify")) ||
      // SSH authentication failures: elevated sandbox user's USERPROFILE points to the
      // sandbox account's home dir (~/.ssh is empty), so SSH key auth always fails.
      lower.includes("permission denied (publickey") ||
      lower.includes("no supported authentication methods available") ||
      lower.includes("could not read from remote repository") ||
      // Permission errors: elevated sandbox user may lack write access to TEMP,
      // site-packages, or other directories that pip/npm/cargo need
      (lower.includes("permission denied") && lower.includes("errno 13")) ||
      (lower.includes("oserror") && lower.includes("permission denied")) ||
      lower.includes("accessdeniedexception") ||
      lower.includes("access is denied")
    )
  }

  /**
   * Decide whether a non-zero exit was *likely* caused by the sandbox restricting the
   * command — i.e. running the same command outside the sandbox might succeed. Models
   * Codex's `is_likely_sandbox_denied` (codex-rs/core/src/exec.rs):
   *
   *   1. Skip if the command succeeded.
   *   2. If the output contains any sandbox-denial keyword, return true.
   *   3. Otherwise return false.
   *
   * We extend Codex's Linux/macOS-first keyword list with Windows-specific signals
   * (Access is denied, WinError 5/1314, dubious ownership, spawn EPERM, …) because
   * Codex's wall of "permission denied" is mostly POSIX phrasing.
   */
  static isLikelySandboxDenied(exitCode: number | null, output: string, command?: string): boolean {
    if (exitCode === 0 || !output) return false
    const lower = output.toLowerCase()
    if (LocalSandbox.SANDBOX_DENIED_KEYWORDS.some((needle) => lower.includes(needle))) {
      return true
    }
    return Boolean(command && LocalSandbox.isCommandSpecificSandboxRetryCandidate(exitCode, command, lower))
  }

  private static isCommandSpecificSandboxRetryCandidate(
    exitCode: number | null,
    command: string,
    lowerOutput: string
  ): boolean {
    if (
      LocalSandbox.isGitInteractiveAuthCommand(command)
      && (
        LocalSandbox.isGitAuthPromptFailure(lowerOutput)
        || LocalSandbox.shouldFallbackToUnelevatedForNetworkAuth(lowerOutput)
      )
    ) {
      return true
    }
    return (
      exitCode === 124
      && LocalSandbox.isSparseSandboxTimeoutOutput(lowerOutput)
      && LocalSandbox.isLikelyInteractiveNetworkCommand(command)
    )
  }

  private static isGitAuthPromptFailure(lowerOutput: string): boolean {
    return (
      lowerOutput.includes("terminal prompts disabled")
      || lowerOutput.includes("could not read username")
      || lowerOutput.includes("could not read password")
    )
  }

  private static isSparseSandboxTimeoutOutput(lowerOutput: string): boolean {
    if (
      !lowerOutput.includes(LocalSandbox.TIMEOUT_METADATA_SENTINEL)
      || !lowerOutput.includes(LocalSandbox.TIMEOUT_METADATA_REASON)
    ) {
      return false
    }
    const substantiveOutput = lowerOutput
      .replace(/<execute_metadata>[\s\S]*?<\/execute_metadata>/g, "")
      .replace(/\[stderr\]/g, "")
      .replace(/<no output>/g, "")
      .trim()
    return substantiveOutput.length <= LocalSandbox.SPARSE_TIMEOUT_OUTPUT_MAX_CHARS
  }

  private static isLikelyInteractiveNetworkCommand(command: string): boolean {
    const cmd = command.trim().toLowerCase()
    return (
      LocalSandbox.isGitInteractiveAuthCommand(command)
      || /\b(?:ssh|scp|sftp|rsync)(?:\.exe)?\b/.test(cmd)
      || /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?\b/.test(cmd)
      || /\bpip(?:3(?:\.\d+)?)?(?:\.exe|\.cmd|\.bat)?\s+(?:install|download|wheel)\b/.test(cmd)
      || /\b(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+pip\s+(?:install|download|wheel)\b/.test(cmd)
      || /\buv(?:\.exe|\.cmd|\.bat)?\s+(?:pip\s+(?:install|sync)|sync|add|remove|lock|tool\s+install)\b/.test(cmd)
      || /\bpipx(?:\.exe|\.cmd|\.bat)?\s+(?:install|run|runpip|upgrade|upgrade-all)\b/.test(cmd)
      || /\bpoetry\s+(?:install|add|update)\b/.test(cmd)
      || /\bconda\s+(?:install|create|update)\b/.test(cmd)
      || /\bnpm\s+(?:install|i|ci|update)\b/.test(cmd)
      || /\bnpx\s/.test(cmd)
      || /\byarn\s+(?:add|install|upgrade)\b/.test(cmd)
      || /\bpnpm\s+(?:add|install|i|update)\b/.test(cmd)
      || /\bcargo\s+(?:fetch|install)\b/.test(cmd)
      || /\bgo\s+(?:get|install|mod\s+download)\b/.test(cmd)
      || /\bdotnet\s+restore\b/.test(cmd)
    )
  }

  /**
   * Keywords whose presence in a command's output strongly suggests a sandbox-induced
   * failure. Lowercase comparisons only.
   *
   * Codex's original 7 (LF-family) + Windows-specific additions for elevated/unelevated
   * Codex Windows sandbox modes that Codex itself doesn't ship signals for.
   */
  static readonly SANDBOX_DENIED_KEYWORDS: readonly string[] = [
    // Codex's Linux/macOS-flavored set:
    "operation not permitted",
    "permission denied",
    "read-only file system",
    "seccomp",
    "sandbox",
    "landlock",
    "failed to write file",
    // Windows additions:
    "access is denied",            // cmd.exe / icacls / Win32 ERROR_ACCESS_DENIED
    "拒绝访问",                     // Chinese Windows variant of the above
    "winerror 5",                  // Python OSError on Win ERROR_ACCESS_DENIED
    "winerror 1314",               // Python OSError on Win SeAssignPrimaryToken etc.
    "dubious ownership",           // git when host user owns the repo, sandbox runs as different user
    "spawn eperm",                 // libuv named pipe creation under WRITE_RESTRICTED token
    "eacces: permission",          // Node fs syscall errors
    "eperm: operation",            // Node fs syscall errors
    "permissionerror: [errno 13",  // Python explicit
    "createprocesswithlogonw failed", // elevated mode: domain GPO blocking SeInteractiveLogonRight
  ]

  /**
   * For known failure patterns whose recovery is *not* "retry this one command outside the
   * sandbox" but rather "change a setting / talk to IT", return a tailored guidance string
   * for the approval prompt. Returning null falls back to the generic "command failed,
   * retry without sandbox?" message.
   *
   * Currently special-cases:
   *   - Win32 error 1385 from CreateProcessWithLogonW (elevated sandbox): this means the
   *     domain or local security policy denies SeInteractiveLogonRight to the dedicated
   *     sandbox user, and *every* subsequent elevated command will hit the same wall.
   *     Telling the user to switch sandbox mode is more useful than a per-command bypass.
   */
  static getSandboxBypassGuidance(output: string): string | null {
    if (!output) return null
    const lower = output.toLowerCase()
    if (
      lower.includes("createprocesswithlogonw failed: 1385")
      || (lower.includes("windows sandbox failed") && lower.includes("1385"))
    ) {
      return [
        "Elevated 沙箱无法在这台电脑上启动子进程。",
        "原因：Windows 域/本地安全策略不允许沙箱用户（CodexSandboxOnline）进行本地登录（错误 1385 / SeInteractiveLogonRight 缺失）。",
        "建议：到「设置 → 沙箱模式」切换为 Unelevated；或先允许这次在沙箱外运行该命令（之后每条命令都会再问，不便建议直接换模式）。"
      ].join("\n")
    }
    return null
  }

  /**
   * Detect commands that are known to fail in elevated mode due to permission/cert issues.
   * These are routed directly to unelevated mode to avoid wasted elevated attempt.
   */
  /**
   * Cache for isPythonCliTool results to avoid repeated filesystem lookups.
   * Key: executable name (lowercase), Value: whether it lives in a Python Scripts dir.
   */
  private static _pythonCliCache = new Map<string, boolean>()

  /**
   * True when the resolved Python install lives under the real user's profile
   * (e.g. per-user install at %LOCALAPPDATA%\Programs\Python\... or the MS Store
   * alias under %LOCALAPPDATA%\Microsoft\WindowsApps). The elevated sandbox user
   * (CodexSandboxOnline) cannot read the real user's profile, so PATH lookups for
   * python/py resolve to unreadable paths and fail with CommandNotFoundException.
   * Bare python/py invocations must route to unelevated mode to keep real-user identity.
   */
  private static isPythonUnderUserProfile(): boolean {
    // Uses the prewarmed cache populated by resolvePythonDir() in the constructor.
    // If the async lookup hasn't completed yet, return false (no routing) — elevated
    // will attempt normally; worst case one failed attempt before cache fills.
    const pyDir = LocalSandbox._pythonDir
    const userProfile = process.env.USERPROFILE
    if (!pyDir || !userProfile) return false
    const normProfile = userProfile.toLowerCase().replace(/[\\/]+$/, "")
    const normPy = pyDir.toLowerCase()
    return normPy === normProfile || normPy.startsWith(normProfile + "\\") || normPy.startsWith(normProfile + "/")
  }

  /**
   * Returns true if the command's executable is located in a Python Scripts
   * directory on PATH. Detects any pip-installed CLI tool automatically without
   * requiring a hardcoded allowlist.
   *
   * These tools rely on USERPROFILE/HOME/APPDATA to find their config and cache.
   * In elevated mode those env vars point to the sandbox user's profile (which
   * may not exist), causing empty-string path resolution → EPERM lstat ''.
   * Running them in unelevated mode keeps the real user identity, fixing the issue.
   */
  private static async isPythonCliTool(command: string): Promise<boolean> {
    if (process.platform !== "win32") return false
    // Extract just the executable token (skip shell built-ins or paths with separators)
    const firstToken = command.trim().split(/\s+/)[0]
    if (!firstToken || firstToken.includes("/") || firstToken.includes("\\")) return false
    const exeName = firstToken.toLowerCase().replace(/\.exe$/i, "")
    if (LocalSandbox._pythonCliCache.has(exeName)) {
      return LocalSandbox._pythonCliCache.get(exeName)!
    }
    // Scan PATH for Python Scripts directories and check if the exe lives there
    const pathDirs = (process.env.PATH || "").split(";")
    for (const dir of pathDirs) {
      if (!dir) continue
      const ldir = dir.toLowerCase()
      // Python Scripts dirs always contain both "python" and "script" in the path
      if (!ldir.includes("python") || !ldir.includes("script")) continue
      if (await pathExists(path.join(dir, exeName + ".exe")) || await pathExists(path.join(dir, exeName))) {
        LocalSandbox._pythonCliCache.set(exeName, true)
        return true
      }
    }
    LocalSandbox._pythonCliCache.set(exeName, false)
    return false
  }

  private static async shouldPreferUnelevated(command: string): Promise<boolean> {
    const cmd = command.trim().toLowerCase()
    if (
      // Python package managers
      /\bpip(?:3(?:\.\d+)?)?(?:\.exe|\.cmd|\.bat)?\s+(install|download|wheel)\b/.test(cmd) ||
      /\b(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?(?:\s+-\d+(?:\.\d+)?)?\s+-m\s+pip\s+(install|download|wheel)\b/.test(
        cmd
      ) ||
      /\buv(?:\.exe|\.cmd|\.bat)?\s+(pip\s+(install|sync)|sync|add|remove|lock|run|tool\s+install)\b/.test(
        cmd
      ) ||
      /\bpipx(?:\.exe|\.cmd|\.bat)?\s+(install|run|runpip|upgrade|upgrade-all)\b/.test(cmd) ||
      /\bpoetry\s+(install|add|update)\b/.test(cmd) ||
      /\bconda\s+(install|create|update)\b/.test(cmd) ||
      // Node.js
      /\bnpm\s+install\b/.test(cmd) ||
      /\bnpm\s+i\b/.test(cmd) ||
      /\bnpm\s+ci\b/.test(cmd) ||
      /\bnpm\s+update\b/.test(cmd) ||
      /\byarn\s+(add|install|upgrade)\b/.test(cmd) ||
      /\bpnpm\s+(add|install|i|update)\b/.test(cmd) ||
      /\bnpx\s/.test(cmd) ||
      // Rust
      /\bcargo\s+(install|build|test|run|fetch)\b/.test(cmd) ||
      /\brustup\s+(update|install|default)\b/.test(cmd) ||
      // Go — build/test/run auto-download modules when not cached
      /\bgo\s+(build|test|run|get|install|mod\s+download)\b/.test(cmd) ||
      // JVM
      /\bmvnw?(?:\.cmd|\.bat)?\b/.test(cmd) ||
      /\bgradle\b/.test(cmd) ||
      /\bgradlew\b/.test(cmd) ||
      /\bsbt\b/.test(cmd) ||
      // .NET
      /\bdotnet\s+(restore|build|test|run|publish)\b/.test(cmd) ||
      // Ruby
      /\bgem\s+install\b/.test(cmd) ||
      /\bbundle\s+(install|update|add)\b/.test(cmd) ||
      // C/C++
      /\bvcpkg\s+install\b/.test(cmd)
    ) {
      return true
    }

    const isBarePythonCommand = /^\s*(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?(?:\s|$)/i.test(command)
    if (isBarePythonCommand) {
      await LocalSandbox.resolvePythonDir().catch(() => null)
      if (LocalSandbox.isPythonUnderUserProfile()) {
        return true
      }
    }

    // Any pip-installed CLI tool detected via PATH scan (auto, no hardcoded list needed).
    return LocalSandbox.isPythonCliTool(command)
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
    baseEnv.SESSION_ID = this.runId
    const systemId = options.systemId?.trim()
    if (systemId) baseEnv.SYSTEM_ID = systemId
    const pluginRoot = options.pluginRoot?.trim()
    if (pluginRoot) baseEnv.PLUGIN_ROOT = pluginRoot
    const pluginId = options.pluginId?.trim()
    if (pluginId) baseEnv.PLUGIN_ID = pluginId
    const pluginName = options.pluginName?.trim()
    if (pluginName) baseEnv.PLUGIN_NAME = pluginName
    const pluginWorkspace = options.pluginWorkspace?.trim()
    if (pluginWorkspace) baseEnv.PLUGIN_WORKSPACE = pluginWorkspace
    const featureId = options.featureId?.trim()
    if (featureId) baseEnv.FEATURE_ID = featureId
    const projectCode = options.projectCode?.trim()
    if (projectCode) baseEnv.PROJECT_CODE = projectCode
    // Ensure UTF-8 locale for spawned shells (Git Bash via pipe defaults to
    // Windows console code page, e.g. GBK, producing garbled CJK output)
    if (process.platform === "win32") {
      baseEnv.LANG ??= "C.UTF-8"
      baseEnv.LC_ALL ??= "C.UTF-8"
    }
    this.env = baseEnv
    this.workingDir = options.rootDir ?? process.cwd()
    this.windowsSandbox = options.windowsSandbox ?? "none"
    this.pluginOutputDir = options.pluginOutputDir
    this.pluginRoot = pluginRoot || undefined
    this.systemId = systemId || undefined
    this.pluginWorkspace = pluginWorkspace || undefined
    this.featureId = featureId || undefined
    this.projectCode = projectCode || undefined
    this.codexExePath = options.codexExePath ?? "codex"
    const h = options.hooks
    this.getHooks = typeof h === "function" ? h : () => h ?? []
    this.resolveHooks = options.hookResolver ?? (() => this.getHooks())
    this._hookScope = options.hookScope
    this._onHookResult = options.onHookResult
    this._hookTurnId = options.hookTurnId
    this._onFileMutation = options.onFileMutation
    this._skillLifecycleRegistry = options.skillLifecycleRegistry
    this._skillHooksFired = options.skillHookKeys ?? new Set<string>()
    this._skillUseTracker = options.skillUseTracker
    this._sandboxCacheRoot = LocalSandbox.buildSandboxCacheRootFromCanonical(baseEnv, path.resolve(this.workingDir))
    this._sandboxCacheRootPromise = LocalSandbox.buildSandboxCacheRoot(baseEnv, this.workingDir).catch((err) => {
      console.warn("[LocalSandbox] failed to canonicalize sandbox cache root:", err)
      return this._sandboxCacheRoot
    })
    this._sharedSandboxCacheRoot = LocalSandbox.buildSharedSandboxCacheRoot(baseEnv)
    this.abortSignal = options.abortSignal

    // Prewarm sandbox state during construction so command execution avoids
    // kicking off expensive setup work on the hot path.
    LocalSandbox.prewarmForWorkspace(this.workingDir, this.windowsSandbox, baseEnv)

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
  private isBlockedBySandbox(
    filePath: string,
    realpathCache: Map<string, string | null> = new Map()
  ): boolean {
    if (this.windowsSandbox !== "elevated") return false
    const candidates = new Set<string>([filePath])
    try {
      const resolved = this._resolvePath(filePath)
      candidates.add(resolved)
      const realResolved = this.realpathDeepestExistingCached(resolved, realpathCache)
      if (realResolved) candidates.add(realResolved)
    } catch {
      const realInput = this.realpathDeepestExistingCached(filePath, realpathCache)
      if (realInput) candidates.add(realInput)
    }
    return Array.from(candidates).some((candidate) => isSensitivePath(candidate))
  }

  private isSensitiveSandboxPath(
    filePath: string,
    realpathCache: Map<string, string | null> = new Map()
  ): boolean {
    return this.windowsSandbox === "elevated" && this.isBlockedBySandbox(filePath, realpathCache)
  }

  private realpathDeepestExistingCached(
    filePath: string,
    realpathCache: Map<string, string | null>
  ): string | null {
    const resolved = path.resolve(filePath)
    if (realpathCache.has(resolved)) {
      return realpathCache.get(resolved) ?? null
    }

    const result = this.realpathDeepestExisting(resolved, realpathCache)
    realpathCache.set(resolved, result)
    return result
  }

  private realpathExistingCached(
    existingPath: string,
    realpathCache: Map<string, string | null>
  ): string | null {
    const resolved = path.resolve(existingPath)
    if (realpathCache.has(resolved)) {
      return realpathCache.get(resolved) ?? null
    }

    try {
      const realPath = realpathSync(resolved)
      realpathCache.set(resolved, realPath)
      return realPath
    } catch {
      realpathCache.set(resolved, null)
      return null
    }
  }

  private realpathDeepestExisting(
    filePath: string,
    realpathCache: Map<string, string | null>
  ): string | null {
    const missingSegments: string[] = []
    let current = path.resolve(filePath)

    while (!existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) return null
      missingSegments.unshift(path.basename(current))
      current = parent
    }

    try {
      const stat = lstatSync(current)
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        const realPath = this.realpathExistingCached(current, realpathCache)
        return realPath ? path.join(realPath, ...missingSegments) : null
      }

      const parentRealPath = this.realpathExistingCached(path.dirname(current), realpathCache)
      return parentRealPath
        ? path.join(parentRealPath, path.basename(current), ...missingSegments)
        : null
    } catch {
      return null
    }
  }

  /** Inject the approval orchestrator (called from runtime.ts). */
  setOrchestrator(orch: ToolOrchestrator): void {
    this.orchestrator = orch
  }

  /** Mark this sandbox as serving a read-only agent/worker (called from runtime.ts
   * for shellAccess/workload "read_only" runtimes). Enforced on the EFFECTIVE
   * post-hook command in execute()/executeBackground(). */
  setReadOnlyShellEnforced(enabled: boolean): void {
    this.readOnlyShellEnforced = enabled
  }

  /** Expand a command into shell-ish WORDS the way spawn({shell}) would before it
   * opens files, so a literal scan sees the REAL targets:
   *  - join adjacent quoted/unquoted parts into one word + remove quotes;
   *  - process POSIX backslash escapes (`\.` → `.`, `~/\.ssh` → `~/.ssh`);
   *  - expand $VAR / ${VAR} from the SAME env the shell runs with (this.env), so
   *    $HOME, $USER, $KUBECONFIG, $AWS_SHARED_CREDENTIALS_FILE, $DOCKER_CONFIG …
   *    all resolve to their real paths (an undefined var → "", like the shell);
   *  - single quotes suppress expansion (so `'$HOME/x'` stays literal — this also
   *    avoids over-blocking a genuinely literal path).
   * Tilde and globbing are handled by the caller. Best-effort: a determined
   * command can still evade a static scan — the only hard boundary is OS-level
   * sandboxing, which the chosen "block sensitive dirs" policy does not use. */
  private expandShellWords(command: string): string[] {
    const posix = process.platform !== "win32"
    const env = this.env
    const lookup = (name: string): string => {
      if (env[name] != null) return String(env[name])
      // Windows env vars are case-insensitive (and PowerShell's $home).
      if (!posix) {
        const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
        if (hit != null) return String(env[hit])
      }
      if (name === "HOME" || (!posix && name.toLowerCase() === "home")) return homedir()
      return ""
    }
    const n = command.length
    let i = 0
    // Decode a POSIX ANSI-C quoted body ($'...'): \xHH hex, \nnn octal, \uHHHH,
    // and \n \t … escapes. Unknown escapes drop the backslash (\. → .) — the safe
    // over-approx direction for a security scan (matches how shells reveal the path).
    const decodeAnsiC = (s: string): string => {
      let out = ""
      for (let k = 0; k < s.length; k++) {
        if (s[k] !== "\\") {
          out += s[k]
          continue
        }
        const c = s[++k]
        if (c === undefined) {
          out += "\\"
          break
        }
        if (c === "x") {
          let hex = ""
          while (hex.length < 2 && /[0-9a-fA-F]/.test(s[k + 1] ?? "")) hex += s[++k]
          out += hex ? String.fromCharCode(parseInt(hex, 16)) : "x"
        } else if (c === "u" || c === "U") {
          const max = c === "u" ? 4 : 8
          let hex = ""
          while (hex.length < max && /[0-9a-fA-F]/.test(s[k + 1] ?? "")) hex += s[++k]
          out += hex ? String.fromCodePoint(parseInt(hex, 16)) : c
        } else if (/[0-7]/.test(c)) {
          let oct = c
          while (oct.length < 3 && /[0-7]/.test(s[k + 1] ?? "")) oct += s[++k]
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
        } else {
          const simple: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            a: "\x07",
            b: "\b",
            f: "\f",
            v: "\v",
            e: "\x1b",
            E: "\x1b"
          }
          out += simple[c] ?? c // \\ \' \" and unknown → the char itself
        }
      }
      return out
    }
    // Read $'...' (ANSI-C quote): scan the raw body honoring \' and \\, then decode.
    const readAnsiC = (): string => {
      i += 2 // consume $'
      let raw = ""
      while (i < n && command[i] !== "'") {
        if (command[i] === "\\" && i + 1 < n) {
          raw += command[i] + command[i + 1]
          i += 2
        } else {
          raw += command[i++]
        }
      }
      if (i < n) i++ // consume closing '
      return decodeAnsiC(raw)
    }
    const readVar = (): string => {
      i++ // consume $
      if (command[i] === "{") {
        i++
        let name = ""
        while (i < n && command[i] !== "}") name += command[i++]
        if (i < n) i++ // consume }
        return lookup(name)
      }
      let name = ""
      while (i < n && /[A-Za-z0-9_]/.test(command[i])) name += command[i++]
      return name ? lookup(name) : "$"
    }
    const words: string[] = []
    let cur = ""
    let inWord = false
    let quote: '"' | "'" | null = null
    while (i < n) {
      const ch = command[i]
      if (quote === "'") {
        if (ch === "'") quote = null
        else cur += ch
        i++
        continue
      }
      if (quote === '"') {
        if (ch === '"') {
          quote = null
          i++
        } else if (ch === "$") {
          cur += readVar()
          inWord = true
        } else if (posix && ch === "\\" && i + 1 < n && /["\\$`]/.test(command[i + 1])) {
          cur += command[i + 1]
          i += 2
        } else {
          cur += ch
          i++
        }
        continue
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        if (inWord) words.push(cur)
        cur = ""
        inWord = false
        i++
      } else if (ch === "'" || ch === '"') {
        quote = ch
        inWord = true
        i++
      } else if (ch === "$" && command[i + 1] === "'") {
        // POSIX ANSI-C quoting $'...' (unquoted only — inside "" it is literal).
        cur += readAnsiC()
        inWord = true
      } else if (ch === "$") {
        cur += readVar()
        inWord = true
      } else if (posix && ch === "\\" && i + 1 < n) {
        cur += command[i + 1]
        i += 2
        inWord = true
      } else {
        cur += ch
        i++
        inWord = true
      }
    }
    if (inWord) words.push(cur)
    return words
  }

  /** Split on commas at brace-nesting depth 0 (so `a,{b,c}` → ["a", "{b,c}"]). */
  private static splitTopLevelCommas(s: string): string[] {
    const parts: string[] = []
    let depth = 0
    let cur = ""
    for (const c of s) {
      if (c === "{") depth++
      else if (c === "}") depth = Math.max(0, depth - 1)
      if (c === "," && depth === 0) {
        parts.push(cur)
        cur = ""
      } else {
        cur += c
      }
    }
    parts.push(cur)
    return parts
  }

  /** Locate the FIRST balanced `{…}` that has a top-level comma (an expandable
   * brace group); `{x}`/`{1..3}` with no top-level comma are left literal. */
  private static findExpandableBrace(
    s: string
  ): { pre: string; options: string[]; post: string } | null {
    for (let start = 0; start < s.length; start++) {
      if (s[start] !== "{") continue
      let depth = 0
      let hasComma = false
      for (let k = start; k < s.length; k++) {
        const c = s[k]
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) {
            if (!hasComma) break // not expandable — try the next `{`
            return {
              pre: s.slice(0, start),
              options: LocalSandbox.splitTopLevelCommas(s.slice(start + 1, k)),
              post: s.slice(k + 1)
            }
          }
        } else if (c === "," && depth === 1) {
          hasComma = true
        }
      }
    }
    return null
  }

  /** Brace expansion `a{b,c}d` → ["abd","acd"] (recursive, nested, cartesian),
   * mirroring the shell's FIRST expansion step so `~/{.ssh,x}` is seen as `~/.ssh`.
   * Quoting is intentionally ignored (over-approx: a quoted `{…}` won't expand in
   * the shell, but blocking the rare literal case is the safe direction).
   *
   * `truncated` = the expansion exceeded CAP, so `words` is INCOMPLETE. The caller
   * must FAIL CLOSED (treat as sensitive): otherwise `cat ~/{s0,…,s1023,.ssh}/x`
   * could hide `.ssh` past the cap while the real shell still expands it. CAP is
   * generous so real read commands enumerate fully; only pathological inputs hit it. */
  private static braceExpand(input: string): { words: string[]; truncated: boolean } {
    const out: string[] = []
    const CAP = 1024
    let truncated = false
    const recur = (s: string): void => {
      if (truncated) return
      if (out.length >= CAP) {
        truncated = true
        return
      }
      const found = LocalSandbox.findExpandableBrace(s)
      if (!found) {
        out.push(s)
        return
      }
      for (const opt of found.options) {
        if (truncated) return
        recur(found.pre + opt + found.post)
      }
    }
    recur(input)
    return { words: out.length ? out : [input], truncated }
  }

  /** POSIX bracket character classes → JS char-class bodies, so a glob like
   * `.[[:lower:]][[:lower:]]h` (which the shell matches against `.ssh`) is handled
   * instead of mis-parsed. An unknown class falls back to a broad set (safe over-
   * approx). */
  private static readonly POSIX_CHAR_CLASSES: Record<string, string> = {
    alpha: "a-zA-Z",
    upper: "A-Z",
    lower: "a-z",
    digit: "0-9",
    alnum: "a-zA-Z0-9",
    xdigit: "0-9a-fA-F",
    word: "a-zA-Z0-9_",
    blank: " \\t",
    space: " \\t\\r\\n\\f\\v",
    punct: "!-/:-@\\[-`{-~",
    graph: "!-~",
    print: " -~",
    cntrl: "\\x00-\\x1f\\x7f"
  }

  /** Translate a shell glob SEGMENT to a JS regex source. Handles `*` → `[^/]*`,
   * `?` → `[^/]`, and bracket expressions PROPERLY: shell negation `[!…]`/`[^…]`
   * → JS `[^…]`, a leading `]` as literal, POSIX classes `[[:lower:]]` → `[a-z]`,
   * collating/equivalence `[.x.]`/`[=x=]` → the char, and JS-special chars escaped
   * inside the class. Getting negation right is the point: `[!.]`/`[^.]` match a
   * non-dot char, which a naive `.replace()` mis-reads (so `.[!.]sh` slipped past). */
  private static globToRegexSource(seg: string): string {
    let out = ""
    const n = seg.length
    let i = 0
    while (i < n) {
      const c = seg[i]
      if (c === "*") {
        out += "[^/]*"
        i++
      } else if (c === "?") {
        out += "[^/]"
        i++
      } else if (c === "[") {
        let j = i + 1
        let cls = "["
        if (seg[j] === "!" || seg[j] === "^") {
          cls += "^"
          j++
        }
        if (seg[j] === "]") {
          cls += "\\]" // a ] right after [ (or [!/[^) is a LITERAL ]
          j++
        }
        let closed = false
        while (j < n) {
          const d = seg[j]
          if (d === "]") {
            closed = true
            j++
            break
          }
          if (d === "[" && (seg[j + 1] === ":" || seg[j + 1] === "." || seg[j + 1] === "=")) {
            const kind = seg[j + 1]
            const end = seg.indexOf(kind + "]", j + 2)
            if (end !== -1) {
              const name = seg.slice(j + 2, end)
              cls +=
                kind === ":"
                  ? (LocalSandbox.POSIX_CHAR_CLASSES[name] ?? "a-zA-Z0-9")
                  : name.replace(/[\\\]^-]/g, "\\$&") // [.x.]/[=x=] → the literal char
              j = end + 2
              continue
            }
          }
          cls += /[\\\]^]/.test(d) ? "\\" + d : d
          j++
        }
        if (closed) {
          out += cls + "]"
          i = j
        } else {
          out += "\\[" // unterminated [ → literal
          i++
        }
      } else {
        out += /[.*+?^${}()|[\]\\/]/.test(c) ? "\\" + c : c
        i++
      }
    }
    return out
  }

  /** A glob path SEGMENT (contains `*`/`?`/`[]`) that could expand to a sensitive
   * credential-dir name. Mirrors default shell globbing where dotglob is OFF — a
   * leading `*`/`?` does NOT match a name beginning with `.`, and every sensitive
   * name does, so only a segment starting with a literal `.` (or a `[` class) can
   * match. fnmatch the segment against SENSITIVE_DIR_NAMES. */
  private globSegmentMatchesSensitive(seg: string): boolean {
    if (!/[*?[\]]/.test(seg)) return false
    if (!seg.startsWith(".") && !seg.startsWith("[")) return false
    let re: RegExp
    try {
      re = new RegExp("^" + LocalSandbox.globToRegexSource(seg) + "$")
    } catch {
      return true // unparseable glob → fail safe
    }
    for (const name of SENSITIVE_DIR_NAMES) if (re.test(name)) return true
    return false
  }

  /** A read-only agent now has `execute`, which can read anything the user can —
   * e.g. `cat ~/.ssh/id_rsa`. On top of the read-only command check, reject a
   * read-only command that references a sensitive credential directory (~/.ssh,
   * ~/.aws, ~/.kube, …) so shell can't exfiltrate secrets. Scope = credential
   * dirs (isSensitivePath), not full workspace confinement.
   *
   * expandShellWords() already mirrored quote removal, POSIX backslash escapes,
   * and $VAR/${VAR} expansion (so $HOME, $KUBECONFIG, $AWS_SHARED_CREDENTIALS_FILE
   * … are real paths by now). Each word is then brace-expanded (`~/{.ssh,x}` →
   * `~/.ssh`, `~/x`), and we add tilde (~ / ~user) and globbing, then resolve each
   * variant against the effective cwd (so `cat ../../.ssh/id_rsa` is caught too)
   * and test isSensitivePath. */
  private commandReadsSensitivePath(command: string, cwd: string): boolean {
    const home = homedir()
    const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "")
    let currentUser = ""
    try {
      currentUser = userInfo().username
    } catch {
      /* userInfo can throw on some container/CI setups — treat as no known user */
    }

    const expandedWords: string[] = []
    for (const word of this.expandShellWords(command)) {
      const { words: variants, truncated } = LocalSandbox.braceExpand(word)
      // FAIL CLOSED: if a word has too many brace alternatives to fully enumerate,
      // a sensitive branch could hide past the cap while the shell still expands it.
      if (truncated) return true
      expandedWords.push(...variants)
    }
    for (let token of expandedWords) {
      if (!token) continue
      // Tilde expansion: ~ / ~/ → home; ~<current-user> → home; ~<other-user>/dir
      // can't be resolved here, but if the next segment is a sensitive name treat
      // it as sensitive anyway.
      if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
        token = home + token.slice(1)
      } else if (
        currentUser &&
        (token === "~" + currentUser ||
          token.startsWith("~" + currentUser + "/") ||
          token.startsWith("~" + currentUser + "\\"))
      ) {
        token = home + token.slice(1 + currentUser.length)
      } else if (/^~[^/\\]+[/\\]/.test(token)) {
        const seg = token.replace(/^~[^/\\]+[/\\]/, "").split(/[/\\]/)[0]
        if (SENSITIVE_DIR_NAMES.has(seg.toLowerCase()) || this.globSegmentMatchesSensitive(seg)) {
          return true
        }
      }

      const resolved = path.resolve(cwd, token)
      if (isSensitivePath(resolved)) return true
      // A glob in the FIRST home-relative segment (~/.ss?/id, ~/.c*/x) escapes
      // isSensitivePath's literal compare — fnmatch it against the set.
      const resNorm = resolved.replace(/\\/g, "/")
      if (resNorm.toLowerCase().startsWith(homeNorm.toLowerCase() + "/")) {
        const firstSeg = resNorm.slice(homeNorm.length + 1).split("/")[0]
        if (this.globSegmentMatchesSensitive(firstSeg)) return true
      }
    }
    return false
  }

  private resolveExecutionCwd(cwd?: string): string {
    const trimmed = cwd?.trim()
    return trimmed ? path.resolve(this.workingDir, trimmed) : this.workingDir
  }

  private static normalizeDirBoundaryKey(dir: string): string {
    const resolved = path.resolve(dir)
    if (process.platform === "win32") {
      return resolved.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase()
    }
    return resolved.replace(/\/+$/, "") || "/"
  }

  private static isPathInsideDir(targetPath: string, dirPath: string): boolean {
    const target = LocalSandbox.normalizeDirBoundaryKey(targetPath)
    const dir = LocalSandbox.normalizeDirBoundaryKey(dirPath)
    const separator = process.platform === "win32" ? "\\" : "/"
    if (dir === separator) return target === dir || target.startsWith(separator)
    return target === dir || target.startsWith(`${dir}${separator}`)
  }

  private isRealExecutionCwdInsideBoundary(
    cwd: string,
    boundaryDir: string,
    realpathCache: Map<string, string | null>
  ): boolean {
    const realCwd = this.realpathDeepestExistingCached(cwd, realpathCache)
    const realBoundary = this.realpathDeepestExistingCached(boundaryDir, realpathCache)
    return Boolean(
      realCwd &&
      realBoundary &&
      LocalSandbox.isPathInsideDir(realCwd, realBoundary)
    )
  }

  private validateExecutionCwd(cwd: string): string | null {
    const realpathCache = new Map<string, string | null>()
    if (LocalSandbox.isPathInsideDir(cwd, this.workingDir)) {
      return this.isRealExecutionCwdInsideBoundary(cwd, this.workingDir, realpathCache)
        ? null
        : `Invalid cwd: '${cwd}' resolves outside the workspace.`
    }
    if (this.isHiddenSkillPath(cwd, realpathCache)) {
      return `Invalid cwd: '${cwd}' is inside a disabled skill.`
    }
    const skillMatch = this._skillLifecycleRegistry?.resolveRead(cwd, cwd)
    if (skillMatch) {
      return this.isRealExecutionCwdInsideBoundary(cwd, skillMatch.rootDir, realpathCache)
        ? null
        : `Invalid cwd: '${cwd}' resolves outside enabled skill '${skillMatch.name}'.`
    }
    return `Invalid cwd: '${cwd}' is outside the workspace and is not a known enabled skill directory.`
  }

  /** Toggle direct git submit command blocking when git_workflow is available. */
  setGitWorkflowCommitOnly(enabled: boolean): void {
    this.enforceGitWorkflowCommitOnly = enabled
  }

  setSkillLifecycleRegistry(registry: SkillLifecycleRegistry | undefined): void {
    this._skillLifecycleRegistry = registry
  }

  setHiddenSkillDirs(skillDirs: string[]): void {
    this._hiddenSkillDirKeys.clear()
    const realpathCache = new Map<string, string | null>()
    for (const dir of skillDirs) {
      const key = this.normalizeResolvedPathKey(dir)
      if (key) this._hiddenSkillDirKeys.add(key)
      const realKey = this.normalizeResolvedPathKey(
        this.realpathDeepestExistingCached(dir, realpathCache)
      )
      if (realKey) this._hiddenSkillDirKeys.add(realKey)
    }
  }

  private normalizeResolvedPathKey(filePath: string | undefined | null): string {
    if (!filePath) return ""
    const normalized = path.resolve(filePath).replace(/\\/g, "/").replace(/\/+$/, "")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }

  private isHiddenSkillPath(
    filePath: string,
    realpathCache: Map<string, string | null> = new Map()
  ): boolean {
    if (this._hiddenSkillDirKeys.size === 0) return false
    const candidates = new Set<string>()
    let resolved: string
    try {
      resolved = this._resolvePath(filePath)
    } catch {
      resolved = filePath
    }
    candidates.add(resolved)
    const realResolved = this.realpathDeepestExistingCached(resolved, realpathCache)
    if (realResolved) candidates.add(realResolved)

    for (const candidate of candidates) {
      const key = this.normalizeResolvedPathKey(candidate)
      if (!key) continue
      for (const hidden of this._hiddenSkillDirKeys) {
        if (key === hidden || key.startsWith(`${hidden}/`)) return true
      }
    }
    return false
  }

  private async runHooks(event: HookEvent, context: HookContext): Promise<HookResult | null> {
    const hookContext: HookContext = {
      ...context,
      ...(this.pluginOutputDir && !context.pluginOutputDir
        ? { pluginOutputDir: this.pluginOutputDir }
        : {}),
      ...(this.systemId && !context.systemId ? { systemId: this.systemId } : {}),
      ...(this.pluginWorkspace && !context.pluginWorkspace
        ? { pluginWorkspace: this.pluginWorkspace }
        : {}),
      ...(this.featureId && !context.featureId ? { featureId: this.featureId } : {}),
      ...(this.projectCode && !context.projectCode ? { projectCode: this.projectCode } : {}),
      turnId: context.turnId ?? this._hookTurnId
    }

    const hooks = this.resolveHooks(event, hookContext)
    const result = await runHooksEnriched(hooks, event, hookContext, this._onHookResult)
    if (result) {
      this._hookScope?.activatePersistentHooks(hooks)
    }
    // PR-12 — after PostToolUse, inspect the tool result for explicit failure
    // shapes (success:false, is_error:true, error:"...", non-zero exitCode).
    // Fires fire-and-forget PostToolUseFailure with dedupe via tool_use_id so
    // a throw-path failure already caught by toolErrorMiddleware does not
    // re-trigger here.
    if (event === "PostToolUse" && context.toolResult) {
      this.maybeFirePostToolUseFailureFromResult(hookContext)
    }
    return result
  }

  private maybeFirePostToolUseFailureFromResult(context: HookContext): void {
    let parsed: unknown = context.toolResult
    if (typeof context.toolResult === "string") {
      try {
        parsed = JSON.parse(context.toolResult)
      } catch {
        // Not JSON — pass the raw string to detectToolFailure so it can
        // pattern-match plain-text failure markers (the execute tool from
        // deepagents returns "<output>\n[Command failed with exit code N]"
        // rather than a structured object). Without this, every execute
        // failure slipped past PostToolUseFailure entirely.
        parsed = context.toolResult
      }
    }
    const signal = detectToolFailure(context.toolName ?? "", parsed)
    if (!signal) return
    const toolCallId = (context.toolArgs?.tool_call_id ??
      context.toolArgs?.tool_use_id ??
      "") as string
    if (typeof toolCallId === "string" && toolCallId && hasFailureFired(toolCallId)) return
    if (typeof toolCallId === "string" && toolCallId) markFailureFired(toolCallId)

    const failureContext: HookContext = {
      ...context,
      toolResult: JSON.stringify({
        error: signal.message,
        error_type: signal.errorType,
        failure_kind: signal.kind,
        is_interrupt: signal.isInterrupt,
        is_timeout: signal.isTimeout,
        tool_use_id: toolCallId
      })
    }
    const hooks = this.resolveHooks("PostToolUseFailure", failureContext)
    runHooksEnriched(hooks, "PostToolUseFailure", failureContext, this._onHookResult).catch(
      (e) => console.warn("[Hooks] PostToolUseFailure(detect) hook error:", e)
    )
  }

  private static mergeUpdatedInput<T extends Record<string, unknown>>(
    base: T,
    updatedInput?: Record<string, unknown>
  ): T {
    return mergeUpdatedInput(base, updatedInput)
  }

  private static readFileHookArgs(
    filePath: string,
    offset: number,
    limit: number
  ): Record<string, unknown> {
    return { file_path: filePath, filePath, offset, limit }
  }

  private static readFilePathFromHookArgs(
    args: Record<string, unknown>,
    updatedInput: Record<string, unknown> | undefined,
    fallback: string
  ): string {
    if (typeof updatedInput?.file_path === "string" && updatedInput.file_path) {
      return updatedInput.file_path
    }
    if (typeof updatedInput?.filePath === "string" && updatedInput.filePath) {
      return updatedInput.filePath
    }
    if (typeof args.file_path === "string" && args.file_path) return args.file_path
    if (typeof args.filePath === "string" && args.filePath) return args.filePath
    return fallback
  }

  private async runPreToolUseHook(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<HookResult | null> {
    const context: HookContext = {
      toolName,
      toolArgs,
      workspacePath: this.workingDir,
      sessionId: this.runId
    }
    const preResult = await this.runHooks("PreToolUse", context)
    throwIfHookHalt("PreToolUse", preResult, `${toolName} was stopped by a PreToolUse hook`)
    return preResult
  }

  async runPreToolUseHookForTool(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<HookResult | null> {
    return this.runPreToolUseHook(toolName, toolArgs)
  }

  async applyPostToolUseHookToText(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolResult: string
  ): Promise<string> {
    const postResult = await this.runHooks("PostToolUse", {
      toolName,
      toolArgs,
      toolResult,
      workspacePath: this.workingDir,
      sessionId: this.runId
    })
    throwIfHookHalt("PostToolUse", postResult, `${toolName} was stopped by a PostToolUse hook`)
    const feedback = LocalSandbox.formatPostHookTextFeedback(postResult)
    return feedback ? `${toolResult}\n\n${feedback}` : toolResult
  }

  private getSkillHookKey(skill: SkillLifecycleMatch): string {
    return getSkillActivationKey(skill)
  }

  private enqueueSkillHookContext(skill: SkillLifecycleMatch, notes: string[]): void {
    const cleanNotes = notes.map((note) => note.trim()).filter(Boolean)
    if (cleanNotes.length === 0) return
    this._pendingSkillHookContexts.push({ skill, notes: cleanNotes })
  }

  drainSkillHookContexts(): string[] {
    const items = this._pendingSkillHookContexts.splice(0)
    return items.map(({ skill, notes }) =>
      [`Skill: ${skill.name}`, `Skill path: ${skill.path}`, ...notes].join("\n")
    )
  }

  /** Expose the sandbox mode for the orchestrator. */
  getSandboxMode(): WindowsSandboxMode {
    return this.windowsSandbox
  }

  /** Expose the working dir for the orchestrator. */
  getWorkingDir(): string {
    return this.workingDir
  }

  private patchResolvePath(): void {
    if (typeof (this as any).resolvePath !== "function") {
      console.warn(
        "[LocalSandbox] resolvePath not found on FilesystemBackend — skipping path patch"
      )
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
  private static readonly MAX_GREP_LINE_CHARS = 1_000
  private static readonly GREP_LINE_TRUNCATION_SUFFIX = "...(truncated)"
  private static readonly MAX_GREP_FALLBACK_SCANNED_FILES = 1_000
  private static readonly MAX_GLOB_ENTRIES = 400
  private static readonly MAX_LS_ENTRIES = 300

  private static truncateGrepLine(lineText: string): string {
    if (lineText.length <= LocalSandbox.MAX_GREP_LINE_CHARS) return lineText
    return (
      lineText.slice(0, LocalSandbox.MAX_GREP_LINE_CHARS) +
      LocalSandbox.GREP_LINE_TRUNCATION_SUFFIX
    )
  }

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
    const realpathCache = new Map<string, string | null>()
    const resolved = dirPath ?? "/"
    let effectivePattern = pattern
    let effectivePath = resolved
    let effectiveGlob = glob

    // Block grep on sensitive directories
    if (this.isBlockedBySandbox(resolved, realpathCache)) {
      return []
    }
    const preResult = await this.runPreToolUseHook("grep", { pattern, path: resolved, glob })
    if (preResult?.blocked || preResult?.decision === "block") {
      return `[Hook blocked] ${
        preResult.stdout || preResult.reason || "grep was blocked by a hook"
      }`
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput(
      { pattern, path: resolved, glob: glob ?? undefined },
      preResult?.updatedInput
    )
    if (typeof updatedArgs.pattern === "string" && updatedArgs.pattern) {
      effectivePattern = updatedArgs.pattern
    }
    if (typeof updatedArgs.path === "string" && updatedArgs.path) {
      effectivePath = updatedArgs.path
    }
    if (typeof updatedArgs.glob === "string" || updatedArgs.glob === null) {
      effectiveGlob = updatedArgs.glob as string | null
    }

    if (this.isBlockedBySandbox(effectivePath, realpathCache)) {
      return []
    }
    if (this.isHiddenSkillPath(effectivePath, realpathCache)) {
      return []
    }

    // Resolve the base path once for reuse
    let baseFull: string
    try {
      baseFull = this._resolvePath(effectivePath === "/" ? "." : effectivePath || ".")
    } catch {
      return []
    }
    // Early exit if path doesn't exist; cache stat for reuse below
    let baseStat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      baseStat = await fs.lstat(baseFull)
    } catch {
      return []
    }
    if (baseStat.isSymbolicLink()) return []
    if (this.isHiddenSkillPath(baseFull, realpathCache)) {
      return []
    }
    const isFile = baseStat.isFile()

    // Call parent's private ripgrepSearch directly to distinguish
    // "rg found nothing" ({}) from "rg unavailable" (null)
    const ripgrepSearch = (this as any).ripgrepSearch as
      | ((
          p: string,
          b: string,
          g: string | null
        ) => Promise<Record<string, Array<[number, string]>> | null>)
      | undefined

    const t0 = Date.now()
    let rgResult: Record<string, Array<[number, string]>> | null | undefined
    if (typeof ripgrepSearch === "function") {
      try {
        rgResult = await ripgrepSearch.call(this, effectivePattern, baseFull, effectiveGlob ?? null)
      } catch (error) {
        console.warn("[LocalSandbox] ripgrepSearch failed, falling back:", error)
        rgResult = undefined
      }
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
    if (results.length > 0 && effectivePath !== "/" && isFile) {
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
    // For directory-level searches, empty ripgrep results are normal — skip fallback
    // to keep grep performance aligned with rg-first tools like Claude Code.
    let fallbackStoppedEarly = false
    if (!rgAvailable || (results.length === 0 && isFile)) {
      const t1 = Date.now()
      const fallbackResult = await this.encodingAwareLiteralSearch(
        effectivePattern,
        baseFull,
        effectiveGlob ?? null,
        realpathCache
      )
      fallbackStoppedEarly = fallbackResult.stoppedEarly
      const fallbackMs = Date.now() - t1
      for (const [fpath, items] of Object.entries(fallbackResult.results)) {
        for (const [lineNum, lineText] of items) {
          results.push({ path: fpath, line: lineNum, text: lineText })
        }
      }
      if (results.length > 0) source = "encoding-aware-fallback"
      console.log(
        `[LocalSandbox] grepRaw fallback: pattern="${effectivePattern}", results=${results.length}, fallbackMs=${fallbackMs}`
      )
    }

    console.log(
      `[LocalSandbox] grepRaw: source=${source}, pattern="${effectivePattern}", results=${results.length}, rgMs=${rgMs}`
    )

    // Filter out matches inside disabled skills so their content cannot leak via grep.
    if (this._hiddenSkillDirKeys.size > 0) {
      results = results.filter((m) => !this.isHiddenSkillPath(m.path, realpathCache))
    }

    // Filter out any results from sensitive directories
    if (this.windowsSandbox === "elevated") {
      results = results.filter((m) => {
        return !this.isSensitiveSandboxPath(m.path, realpathCache)
      })
    }

    const capped: GrepMatch[] = []
    let charCount = 0

    for (const match of results) {
      if (capped.length >= LocalSandbox.MAX_GREP_MATCHES) break
      // Truncate overly long lines (e.g. minified JS) to avoid blowing the char budget
      const text = LocalSandbox.truncateGrepLine(match.text)
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
    } else if (fallbackStoppedEarly) {
      capped.push({
        path: "(truncated)",
        line: 0,
        text: `Fallback search stopped after reaching scan/output limits. Showing first ${capped.length} matches — refine pattern/path/glob.`
      })
    }

    const postResult = await this.runHooks("PostToolUse", {
      toolName: "grep",
      toolArgs: { pattern: effectivePattern, path: effectivePath, glob: effectiveGlob },
      toolResult: JSON.stringify(capped),
      workspacePath: this.workingDir,
      sessionId: this.runId
    })
    throwIfHookHalt("PostToolUse", postResult, "grep was stopped by a PostToolUse hook")
    const postFeedback = LocalSandbox.formatPostHookTextFeedback(postResult)
    if (postFeedback) {
      capped.push({
        path: `[Hook feedback] ${postFeedback}`,
        line: 0,
        text: ""
      })
    }

    return capped
  }

  /**
   * Cap glob results because repository-wide globs can easily return thousands
   * of files and consume context on small windows.
   */
  async globInfo(pattern: string, path = "/"): Promise<FileInfo[]> {
    const realpathCache = new Map<string, string | null>()
    if (this.isBlockedBySandbox(path, realpathCache)) {
      return []
    }
    if (this.isHiddenSkillPath(path, realpathCache)) {
      return []
    }
    let effectivePattern = pattern
    let effectivePath = path
    const preResult = await this.runPreToolUseHook("glob", { pattern, path })
    if (preResult?.blocked || preResult?.decision === "block") {
      const reason = preResult.stdout || preResult.reason || "glob was blocked by a hook"
      return [{ path: `[Hook blocked] ${reason}`, is_dir: false } as FileInfo]
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput({ pattern, path }, preResult?.updatedInput)
    if (typeof updatedArgs.pattern === "string" && updatedArgs.pattern) {
      effectivePattern = updatedArgs.pattern
    }
    if (typeof updatedArgs.path === "string" && updatedArgs.path) {
      effectivePath = updatedArgs.path
    }
    if (this.isHiddenSkillPath(effectivePath, realpathCache)) {
      return []
    }
    if (this.isBlockedBySandbox(effectivePath, realpathCache)) {
      return []
    }
    let infos = await super.globInfo(effectivePattern, effectivePath)
    // Hide files that fall inside any disabled skill so the agent cannot list them.
    if (this._hiddenSkillDirKeys.size > 0) {
      infos = infos.filter((f) => !this.isHiddenSkillPath(f.path, realpathCache))
    }
    // Filter out any results that fall within sensitive directories
    if (this.windowsSandbox === "elevated") {
      infos = infos.filter((f) => {
        return !this.isSensitiveSandboxPath(f.path, realpathCache)
      })
    }
    let finalInfos = infos
    if (finalInfos.length > LocalSandbox.MAX_GLOB_ENTRIES) {
      const capped = finalInfos.slice(0, LocalSandbox.MAX_GLOB_ENTRIES)
      const omitted = finalInfos.length - capped.length
      console.log(
        "[LocalSandbox] globInfo capped results:",
        `${capped.length}/${finalInfos.length}`,
        `for pattern=${effectivePattern}`
      )
      capped.push({
        path: `(truncated) Found ${finalInfos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific glob pattern or path.`,
        is_dir: false
      } as FileInfo)
      finalInfos = capped
    }

    const postResult = await this.runHooks("PostToolUse", {
      toolName: "glob",
      toolArgs: { pattern: effectivePattern, path: effectivePath },
      toolResult: JSON.stringify(finalInfos),
      workspacePath: this.workingDir,
      sessionId: this.runId
    })
    throwIfHookHalt("PostToolUse", postResult, "glob was stopped by a PostToolUse hook")
    const postFeedback = LocalSandbox.formatPostHookTextFeedback(postResult)
    if (postFeedback) {
      finalInfos = [
        ...finalInfos,
        { path: `[Hook feedback] ${postFeedback}`, is_dir: false } as FileInfo
      ]
    }
    return finalInfos
  }

  /**
   * Light cap for ls to avoid pathological large directory listings.
   */
  async lsInfo(path: string): Promise<FileInfo[]> {
    const realpathCache = new Map<string, string | null>()
    if (this.isHiddenSkillPath(path, realpathCache)) {
      return [
        {
          path: `Error listing '${path}': skill is disabled`,
          is_dir: false
        } as FileInfo
      ]
    }
    if (this.isBlockedBySandbox(path, realpathCache)) {
      return [
        {
          path: "Error: Access denied — this directory is restricted by sandbox policy.",
          is_dir: false
        } as FileInfo
      ]
    }
    let effectivePath = path
    const preResult = await this.runPreToolUseHook("ls", { path })
    if (preResult?.blocked || preResult?.decision === "block") {
      const reason = preResult.stdout || preResult.reason || "ls was blocked by a hook"
      return [{ path: `[Hook blocked] ${reason}`, is_dir: false } as FileInfo]
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput({ path }, preResult?.updatedInput)
    if (typeof updatedArgs.path === "string" && updatedArgs.path) {
      effectivePath = updatedArgs.path
    }
    if (this.isHiddenSkillPath(effectivePath, realpathCache)) {
      return [
        {
          path: `Error listing '${effectivePath}': skill is disabled`,
          is_dir: false
        } as FileInfo
      ]
    }
    if (this.isBlockedBySandbox(effectivePath, realpathCache)) {
      return [
        {
          path: "Error: Access denied — this directory is restricted by sandbox policy.",
          is_dir: false
        } as FileInfo
      ]
    }
    let infos = await super.lsInfo(effectivePath)
    infos = infos.filter((f) => !this.isHiddenSkillPath(f.path, realpathCache))
    // Filter out any results that fall within sensitive directories
    if (this.windowsSandbox === "elevated") {
      infos = infos.filter((f) => {
        return !this.isSensitiveSandboxPath(f.path, realpathCache)
      })
    }
    let finalInfos = infos
    if (finalInfos.length > LocalSandbox.MAX_LS_ENTRIES) {
      const capped = finalInfos.slice(0, LocalSandbox.MAX_LS_ENTRIES)
      const omitted = finalInfos.length - capped.length
      console.log(
        "[LocalSandbox] lsInfo capped results:",
        `${capped.length}/${finalInfos.length}`,
        `for path=${effectivePath}`
      )
      capped.push({
        path: `(truncated) Found ${finalInfos.length} total, showing first ${capped.length}. ${omitted} omitted — use a more specific path.`,
        is_dir: false
      } as FileInfo)
      finalInfos = capped
    }

    const postResult = await this.runHooks("PostToolUse", {
      toolName: "ls",
      toolArgs: { path: effectivePath },
      toolResult: JSON.stringify(finalInfos),
      workspacePath: this.workingDir,
      sessionId: this.runId
    })
    throwIfHookHalt("PostToolUse", postResult, "ls was stopped by a PostToolUse hook")
    const postFeedback = LocalSandbox.formatPostHookTextFeedback(postResult)
    if (postFeedback) {
      finalInfos = [...finalInfos, { path: `[Hook feedback] ${postFeedback}`, is_dir: false } as FileInfo]
    }
    return finalInfos
  }

  private static readonly LINE_NUMBER_WIDTH = 6
  private static readonly MAX_LINE_LENGTH = 10_000
  private static readonly MAX_READ_LIMIT = READ_FILE_MAX_LIMIT
  private static readonly READ_FAST_PATH_MAX_SIZE = 10 * 1024 * 1024
  private static readonly READ_ENCODING_SAMPLE_BYTES = 8192
  private static readonly READ_ENCODING_SAMPLE_SEGMENTS = 3
  private static readonly READ_TARGET_ENCODING_SAMPLE_BYTES = 64 * 1024

  private static readonly SUPPORTS_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number"

  private static readonly KNOWN_BINARY_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".mp3",
    ".mp4",
    ".wav",
    ".mov",
    ".avi",
    ".mkv",
    ".zip",
    ".gz",
    ".tar",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".pyc",
    ".class",
    ".o",
    ".obj",
    ".sqlite",
    ".db",
    ".pdf",
    ".doc",
    ".xls",
    ".ppt",
    ".docx",
    ".xlsx",
    ".pptx"
  ])

  /**
   * Detect file encoding from raw buffer (inspired by Cline's detectEncoding,
   * but extended for read+write: Cline only uses it for reading, while we also
   * use the detected encoding to write back, so we upgrade ASCII → UTF-8 to
   * avoid replacing non-ASCII chars with '?').
   * 0. Fast reject known binary extensions before any I/O-heavy detection
   * 1. Check for binary via null/control-byte sampling before accepting text guesses
   * 2. Try jschardet — if it returns a valid encoding, use it (ASCII → utf-8)
   * 3. Fallback to utf-8 for plain text
   */
  private detectEncoding(buffer: Buffer, ext?: string): string {
    if (ext && LocalSandbox.KNOWN_BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read binary file type: ${ext}`)
    }

    const detected = chardet.detect(buffer)
    const detectedEncoding =
      detected && detected.encoding && iconv.encodingExists(detected.encoding)
        ? detected.encoding
        : null
    if (
      LocalSandbox.hasBinaryControlBytes(buffer) &&
      !LocalSandbox.isKnownTextEncodingWithNullBytes(detectedEncoding)
    ) {
      throw new Error(`Cannot read text for file type: ${ext || "unknown"}`)
    }

    if (detectedEncoding) {
      // ASCII is a strict subset of UTF-8; upgrade so non-ASCII chars
      // written by the agent (e.g. CJK) are not replaced with '?'.
      if (detectedEncoding.toLowerCase() === "ascii") return "utf-8"
      return detectedEncoding
    }

    return "utf-8"
  }

  private static hasBinaryControlBytes(buffer: Buffer): boolean {
    const sampleLen = buffer.length
    if (sampleLen === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < sampleLen; i++) {
      const byte = buffer[i]
      if (byte === 0) return true
      if (byte < 9 || (byte > 13 && byte < 32)) {
        nonPrintableCount++
      }
    }
    return nonPrintableCount / sampleLen > 0.3
  }

  private static isKnownTextEncodingWithNullBytes(encoding: string | null): boolean {
    if (!encoding) return false
    const normalized = LocalSandbox.normalizeEncodingName(encoding)
    return normalized.startsWith("utf16") || normalized.startsWith("utf32")
  }

  private async readEncodingSample(resolvedPath: string, fileSize: number): Promise<Buffer> {
    const sampleSize = Math.min(LocalSandbox.READ_ENCODING_SAMPLE_BYTES, fileSize)
    if (sampleSize <= 0) return Buffer.alloc(0)

    const maxOffset = Math.max(0, fileSize - sampleSize)
    const segmentCount: number = LocalSandbox.READ_ENCODING_SAMPLE_SEGMENTS
    const offsets = Array.from(
      new Set(
        Array.from({ length: segmentCount }, (_, index) => {
          return Math.round((maxOffset * index) / Math.max(1, segmentCount - 1))
        })
      )
    ).sort((a, b) => a - b)

    const openFlags = LocalSandbox.SUPPORTS_NOFOLLOW
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      : fsConstants.O_RDONLY
    const fd = await fs.open(resolvedPath, openFlags)
    const samples: Buffer[] = []
    try {
      for (const offset of offsets) {
        const sampleBuffer = Buffer.alloc(sampleSize)
        const { bytesRead } = await fd.read(sampleBuffer, 0, sampleSize, offset)
        if (bytesRead > 0) samples.push(sampleBuffer.subarray(0, bytesRead))
      }
    } finally {
      await fd.close()
    }
    return Buffer.concat(samples)
  }

  private async readTargetEncodingSample(
    resolvedPath: string,
    offset: number,
    limit: number
  ): Promise<Buffer> {
    const samples: Buffer[] = []
    const endLine = offset + limit
    let sampledBytes = 0
    let lineIndex = 0
    let stream: ReadStream | null = null

    const appendSample = (chunk: Buffer): void => {
      if (sampledBytes >= LocalSandbox.READ_TARGET_ENCODING_SAMPLE_BYTES) return
      const remaining = LocalSandbox.READ_TARGET_ENCODING_SAMPLE_BYTES - sampledBytes
      const sample = chunk.subarray(0, Math.min(remaining, chunk.length))
      if (sample.length > 0) {
        samples.push(sample)
        sampledBytes += sample.length
      }
    }

    const openFlags = LocalSandbox.SUPPORTS_NOFOLLOW
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      : fsConstants.O_RDONLY
    const fd = await fs.open(resolvedPath, openFlags)
    try {
      stream = fd.createReadStream({ start: 0, autoClose: false })
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0
        let newline = chunk.indexOf(0x0a, start)
        while (newline !== -1) {
          if (lineIndex >= offset && lineIndex < endLine) {
            appendSample(chunk.subarray(start, newline))
          }
          lineIndex++
          if (lineIndex >= endLine && sampledBytes > 0) {
            stream.destroy()
            return Buffer.concat(samples)
          }
          start = newline + 1
          newline = chunk.indexOf(0x0a, start)
        }

        if (start < chunk.length && lineIndex >= offset && lineIndex < endLine) {
          appendSample(chunk.subarray(start))
          if (sampledBytes >= LocalSandbox.READ_TARGET_ENCODING_SAMPLE_BYTES) {
            stream.destroy()
            return Buffer.concat(samples)
          }
        }
      }
    } finally {
      stream?.destroy()
      await fd.close()
    }

    return Buffer.concat(samples)
  }

  private static containsReplacementCharacter(lines: string[]): boolean {
    return lines.some((line) => line.includes("\uFFFD"))
  }

  private static normalizeEncodingName(encoding: string): string {
    return encoding.toLowerCase().replace(/[-_\s]/g, "")
  }

  private createFormattedReadLineState(): FormattedReadLineState {
    return {
      lines: [],
      charLength: 0,
      truncatedByOutputBudget: false,
      truncatedWithinLine: null,
      truncatedBeforeLine: null,
      lastVisibleSourceLine: null
    }
  }

  private markReadLineBudgetExceeded(
    state: FormattedReadLineState,
    lineNum: number,
    chunkIdx: number
  ): void {
    state.truncatedByOutputBudget = true
    if (state.lastVisibleSourceLine === lineNum || chunkIdx > 0) {
      state.truncatedWithinLine = lineNum
    } else {
      state.truncatedBeforeLine = lineNum
    }
  }

  private appendFormattedReadLine(
    state: FormattedReadLineState,
    lineNum: number,
    chunkIdx: number,
    text: string,
    maxOutputLines: number,
    maxOutputChars?: number
  ): boolean {
    const w = LocalSandbox.LINE_NUMBER_WIDTH
    const label =
      chunkIdx === 0 ? lineNum.toString().padStart(w) : `${lineNum}.${chunkIdx}`.padStart(w)
    const formattedLine = `${label}\t${text}`

    if (state.lines.length >= maxOutputLines) {
      this.markReadLineBudgetExceeded(state, lineNum, chunkIdx)
      return false
    }
    if (maxOutputChars != null) {
      const nextLength = state.charLength + (state.lines.length > 0 ? 1 : 0) + formattedLine.length
      if (nextLength > maxOutputChars) {
        this.markReadLineBudgetExceeded(state, lineNum, chunkIdx)
        return false
      }
      state.charLength = nextLength
    } else {
      state.charLength += (state.lines.length > 0 ? 1 : 0) + formattedLine.length
    }

    state.lines.push(formattedLine)
    state.lastVisibleSourceLine = lineNum
    return true
  }

  /**
   * Format lines with line numbers (compatible with deepagents' format).
   * Long lines are chunked with continuation markers (e.g. 5.1, 5.2).
   */
  private formatLines(
    lines: string[],
    startLine: number,
    maxOutputLines: number,
    maxOutputChars?: number
  ): FormattedReadLineState {
    const state = this.createFormattedReadLineState()
    const maxLen = LocalSandbox.MAX_LINE_LENGTH

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + startLine
      if (line.length <= maxLen) {
        if (
          !this.appendFormattedReadLine(state, lineNum, 0, line, maxOutputLines, maxOutputChars)
        ) {
          break
        }
      } else {
        const numChunks = Math.ceil(line.length / maxLen)
        for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
          const start = chunkIdx * maxLen
          const chunk = line.slice(start, start + maxLen)
          if (
            !this.appendFormattedReadLine(
              state,
              lineNum,
              chunkIdx,
              chunk,
              maxOutputLines,
              maxOutputChars
            )
          ) {
            break
          }
        }
      }

      if (state.truncatedByOutputBudget) break
    }

    return state
  }

  private static validateReadRange(offset: number, limit: number): string | null {
    if (!Number.isInteger(offset) || offset < 0) {
      return "Error: offset must be a non-negative integer"
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      return "Error: limit must be a positive integer"
    }
    if (limit > LocalSandbox.MAX_READ_LIMIT) {
      return `Error: limit must be less than or equal to ${LocalSandbox.MAX_READ_LIMIT}`
    }
    return null
  }

  private formatReadRangeFromContent(
    content: string,
    offset: number,
    limit: number,
    resolvedPath: string,
    options: LocalSandboxReadFileOptions
  ): ReadRangeFormatResult {
    const lines = LocalSandbox.splitFileLines(content)
    const end = Math.min(offset + limit, lines.length)
    const selected = lines.slice(offset, end)
    const maxOutputLines = options.includeLookahead === true ? limit + 1 : limit
    const formatted = this.formatLines(
      selected,
      offset + 1,
      maxOutputLines,
      options.maxFormattedContentChars
    )
    return {
      formattedLines: formatted.lines,
      totalLines: lines.length,
      hasNonWhitespace: content.trim() !== "",
      resolvedPath,
      truncatedByOutputBudget: formatted.truncatedByOutputBudget,
      truncatedWithinLine: formatted.truncatedWithinLine,
      truncatedBeforeLine: formatted.truncatedBeforeLine,
      lastVisibleSourceLine: formatted.lastVisibleSourceLine
    }
  }

  private static splitFileLines(content: string): string[] {
    const lines = content.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") return lines.slice(0, -1)
    return lines
  }

  private async formatReadRangeFromStream(
    resolvedPath: string,
    encoding: string,
    offset: number,
    limit: number,
    options: LocalSandboxReadFileOptions
  ): Promise<ReadRangeFormatResult> {
    const formatted = this.createFormattedReadLineState()
    const endLine = offset + limit
    const maxOutputLines = options.includeLookahead === true ? limit + 1 : limit
    const maxLen = LocalSandbox.MAX_LINE_LENGTH
    let lineIndex = 0
    let currentChunk = ""
    let currentChunkIdx = 0
    let hasNonWhitespace = false
    let endedAfterNewline = false

    const isSelectedLine = () => lineIndex >= offset && lineIndex < endLine

    const appendSegment = (segment: string): void => {
      if (segment.trim() !== "") hasNonWhitespace = true
      if (formatted.truncatedByOutputBudget) return
      if (!isSelectedLine()) return
      if (formatted.lines.length >= maxOutputLines) {
        this.markReadLineBudgetExceeded(formatted, lineIndex + 1, currentChunkIdx)
        return
      }

      let remaining = segment
      while (remaining.length > 0 && formatted.lines.length < maxOutputLines) {
        const available = maxLen - currentChunk.length
        currentChunk += remaining.slice(0, available)
        remaining = remaining.slice(available)
        if (currentChunk.length === maxLen) {
          const appended = this.appendFormattedReadLine(
            formatted,
            lineIndex + 1,
            currentChunkIdx,
            currentChunk,
            maxOutputLines,
            options.maxFormattedContentChars
          )
          if (!appended) return
          currentChunk = ""
          currentChunkIdx++
        }
      }
      if (remaining.length > 0) {
        this.markReadLineBudgetExceeded(formatted, lineIndex + 1, currentChunkIdx)
      }
    }

    const finishLine = (): void => {
      if (isSelectedLine() && !formatted.truncatedByOutputBudget) {
        if (currentChunk.endsWith("\r")) currentChunk = currentChunk.slice(0, -1)
        if (currentChunk.length > 0 || currentChunkIdx === 0) {
          this.appendFormattedReadLine(
            formatted,
            lineIndex + 1,
            currentChunkIdx,
            currentChunk,
            maxOutputLines,
            options.maxFormattedContentChars
          )
        }
      }
      lineIndex++
      currentChunk = ""
      currentChunkIdx = 0
      endedAfterNewline = true
    }

    const openFlags = LocalSandbox.SUPPORTS_NOFOLLOW
      ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      : fsConstants.O_RDONLY
    const fd = await fs.open(resolvedPath, openFlags)
    try {
      const stream = fd.createReadStream({ start: 0, autoClose: false })
      const decoded = stream.pipe(iconv.decodeStream(encoding)) as unknown as AsyncIterable<string>
      for await (const chunk of decoded) {
        let start = 0
        let newline = chunk.indexOf("\n", start)
        while (newline !== -1) {
          appendSegment(chunk.slice(start, newline))
          finishLine()
          start = newline + 1
          newline = chunk.indexOf("\n", start)
        }
        if (start < chunk.length) {
          endedAfterNewline = false
          appendSegment(chunk.slice(start))
        }
      }
      if (!endedAfterNewline || currentChunk.length > 0 || currentChunkIdx > 0) {
        finishLine()
      }
    } finally {
      await fd.close()
    }

    return {
      formattedLines: formatted.lines,
      totalLines: lineIndex,
      hasNonWhitespace,
      resolvedPath,
      truncatedByOutputBudget: formatted.truncatedByOutputBudget,
      truncatedWithinLine: formatted.truncatedWithinLine,
      truncatedBeforeLine: formatted.truncatedBeforeLine,
      lastVisibleSourceLine: formatted.lastVisibleSourceLine
    }
  }

  private async formatReadRange(
    filePath: string,
    offset: number,
    limit: number,
    options: LocalSandboxReadFileOptions
  ): Promise<ReadRangeFormatResult> {
    const resolvedPath = this._resolvePath(filePath)
    const stat = await fs.lstat(resolvedPath)
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${filePath}`)
    if (!stat.isFile()) throw new Error(`File '${filePath}' not found`)

    const ext = path.extname(resolvedPath).toLowerCase()
    if (LocalSandbox.KNOWN_BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read binary file type: ${ext}`)
    }

    if (stat.size < LocalSandbox.READ_FAST_PATH_MAX_SIZE) {
      const { buffer, resolvedPath: fastPathResolved } = await this.readFileBuffer(
        filePath,
        LocalSandbox.READ_FAST_PATH_MAX_SIZE
      )
      const encoding = this.detectEncoding(buffer, path.extname(fastPathResolved).toLowerCase())
      const content = iconv.decode(buffer, encoding)
      return this.formatReadRangeFromContent(content, offset, limit, fastPathResolved, options)
    }

    const sample = await this.readEncodingSample(resolvedPath, stat.size)
    const encoding = this.detectEncoding(sample, ext)
    const result = await this.formatReadRangeFromStream(
      resolvedPath,
      encoding,
      offset,
      limit,
      options
    )
    if (!LocalSandbox.containsReplacementCharacter(result.formattedLines)) {
      return result
    }

    const targetSample = await this.readTargetEncodingSample(resolvedPath, offset, limit)
    if (targetSample.length === 0) return result

    const targetEncoding = this.detectEncoding(targetSample, ext)
    if (
      LocalSandbox.normalizeEncodingName(targetEncoding) ===
      LocalSandbox.normalizeEncodingName(encoding)
    ) {
      return result
    }

    return await this.formatReadRangeFromStream(
      resolvedPath,
      targetEncoding,
      offset,
      limit,
      options
    )
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
  async read(
    filePath: string,
    offset = 0,
    limit = READ_FILE_DEFAULT_LIMIT,
    options: LocalSandboxReadFileOptions = {}
  ): Promise<string> {
    if (this.isHiddenSkillPath(filePath)) {
      return `Error reading file '${filePath}': skill is disabled`
    }
    if (this.isBlockedBySandbox(filePath)) {
      return `Error: Access denied — '${filePath}' is restricted by sandbox policy.`
    }
    let effectiveFilePath = filePath
    let effectiveOffset = offset
    let effectiveLimit = limit
    try {
      const preHookArgs = LocalSandbox.readFileHookArgs(filePath, offset, limit)
      const preResult = await this.runPreToolUseHook("read_file", preHookArgs)
      if (preResult?.blocked || preResult?.decision === "block") {
        const reason = preResult.stdout || preResult.reason || "read_file was blocked by a hook"
        return `Error reading file '${filePath}': [Hook blocked] ${reason}`
      }
      const updatedArgs = LocalSandbox.mergeUpdatedInput(preHookArgs, preResult?.updatedInput)
      effectiveFilePath = LocalSandbox.readFilePathFromHookArgs(
        updatedArgs,
        preResult?.updatedInput,
        filePath
      )
      effectiveOffset =
        typeof updatedArgs.offset === "number" && Number.isFinite(updatedArgs.offset)
          ? updatedArgs.offset
          : offset
      effectiveLimit =
        typeof updatedArgs.limit === "number" && Number.isFinite(updatedArgs.limit)
          ? updatedArgs.limit
          : limit
    } catch (error) {
      if (isHookHaltError(error)) throw error
      throw error
    }
    if (this.isHiddenSkillPath(effectiveFilePath)) {
      return `Error reading file '${effectiveFilePath}': skill is disabled`
    }
    if (this.isBlockedBySandbox(effectiveFilePath)) {
      return `Error: Access denied — '${effectiveFilePath}' is restricted by sandbox policy.`
    }
    const rangeError = LocalSandbox.validateReadRange(effectiveOffset, effectiveLimit)
    if (rangeError) {
      return await this.applyPostToolUseHookToText(
        "read_file",
        LocalSandbox.readFileHookArgs(effectiveFilePath, effectiveOffset, effectiveLimit),
        rangeError
      )
    }
    let skillMatch: SkillLifecycleMatch | null = null
    let fireSkillHooks = false
    const skillHookNotes: string[] = []
    try {
      try {
        const resolvedForSkill = this._resolvePath(effectiveFilePath)
        skillMatch =
          this._skillLifecycleRegistry?.resolveRead(effectiveFilePath, resolvedForSkill) ?? null
        const skillHookKey = skillMatch ? this.getSkillHookKey(skillMatch) : ""
        if (skillMatch && !this._skillHooksFired.has(skillHookKey)) {
          fireSkillHooks = true
          const preContext: HookContext = {
            toolName: "read_file",
            toolArgs: LocalSandbox.readFileHookArgs(
              effectiveFilePath,
              effectiveOffset,
              effectiveLimit
            ),
            workspacePath: this.workingDir,
            sessionId: this.runId,
            skillName: skillMatch.name,
            skillPath: skillMatch.path,
            skillRoot: skillMatch.rootDir,
            pluginId: skillMatch.pluginId,
            pluginName: skillMatch.pluginName,
            pluginRoot: skillMatch.pluginRoot,
            skillTriggerToolName: "read_file"
          }
          const preResult = await this.runHooks("PreSkillUse", preContext)
          throwIfHookHalt(
            "PreSkillUse",
            preResult,
            `Skill ${skillMatch.name} was stopped by a hook`
          )
          if (preResult?.blocked || preResult?.decision === "block") {
            const reason =
              preResult.reason ||
              preResult.stopReason ||
              preResult.stdout ||
              preResult.stderr ||
              `Skill ${skillMatch.name} was blocked by a hook`
            return `Error reading skill '${skillMatch.name}': [Hook blocked] ${reason}`
          }
          skillHookNotes.push(
            ...[
              preResult?.suppressOutput === true ? undefined : preResult?.stdout,
              preResult?.additionalContext,
              preResult?.systemMessage
            ].filter((item): item is string => Boolean(item))
          )
          this._skillHooksFired.add(skillHookKey)
        }
      } catch (hookError) {
        if (isHookHaltError(hookError)) throw hookError
        console.warn("[Hooks] PreSkillUse error:", hookError)
      }

      const {
        formattedLines,
        totalLines,
        hasNonWhitespace,
        resolvedPath,
        truncatedByOutputBudget,
        truncatedWithinLine,
        truncatedBeforeLine,
        lastVisibleSourceLine
      } = await this.formatReadRange(effectiveFilePath, effectiveOffset, effectiveLimit, options)
      await this.recordReadTime(resolvedPath)

      if (!hasNonWhitespace) {
        return await this.applyPostToolUseHookToText(
          "read_file",
          LocalSandbox.readFileHookArgs(effectiveFilePath, effectiveOffset, effectiveLimit),
          "System reminder: File exists but has empty contents"
        )
      }

      if (effectiveOffset >= totalLines) {
        return await this.applyPostToolUseHookToText(
          "read_file",
          LocalSandbox.readFileHookArgs(effectiveFilePath, effectiveOffset, effectiveLimit),
          `Error: Line offset ${effectiveOffset} exceeds file length (${totalLines} lines)`
        )
      }

      const total = totalLines
      const hasMore = effectiveOffset + effectiveLimit < total
      const end = Math.min(effectiveOffset + effectiveLimit, total)
      const formatted = formattedLines.join("\n")
      let result = formatted
      if (truncatedByOutputBudget) {
        const visibleEnd = lastVisibleSourceLine ?? end
        const header =
          truncatedWithinLine != null
            ? `[Lines ${effectiveOffset + 1}-${visibleEnd} of ${total}. Output was truncated within line ${truncatedWithinLine}; reformat long lines or use a more specific command before continuing.]`
            : truncatedBeforeLine != null && lastVisibleSourceLine != null
              ? `[Lines ${effectiveOffset + 1}-${visibleEnd} of ${total}. Output was truncated before line ${truncatedBeforeLine}; use offset=${visibleEnd} to read more.]`
              : lastVisibleSourceLine != null
                ? `[Lines ${effectiveOffset + 1}-${visibleEnd} of ${total}. Use offset=${visibleEnd} to read more.]`
                : `[Lines ${effectiveOffset + 1}-${end} of ${total}. Output was truncated before file content; retry with a smaller limit.]`
        result = formatted ? `${header}\n${formatted}` : header
      } else if (hasMore) {
        result =
          `[Lines ${effectiveOffset + 1}-${end} of ${total}. Use offset=${end} to read more.]\n` +
          formatted
      }

      if (fireSkillHooks && skillMatch) {
        this._hookScope?.activateSkill(skillMatch.name, skillMatch.pluginId, skillMatch.rootDir)
        this._hookScope?.activatePersistentHooks(
          this.resolveHooks("PreToolUse", {
            toolName: "read_file",
            toolArgs: LocalSandbox.readFileHookArgs(
              effectiveFilePath,
              effectiveOffset,
              effectiveLimit
            ),
            workspacePath: this.workingDir,
            sessionId: this.runId,
            skillName: skillMatch.name,
            skillPath: skillMatch.path,
            skillRoot: skillMatch.rootDir,
            pluginId: skillMatch.pluginId,
            pluginName: skillMatch.pluginName,
            pluginRoot: skillMatch.pluginRoot,
            skillTriggerToolName: "read_file"
          })
        )
        this._skillUseTracker?.recordSkillUse(skillMatch, {
          trigger: "read_file",
          triggerToolName: "read_file"
        })
        this.enqueueSkillHookContext(skillMatch, skillHookNotes)
      }

      const hookVisibleResult =
        options.includeLookahead === true
          ? trimReadFileOutputLines(result, effectiveLimit)
          : result
      return await this.applyPostToolUseHookToText(
        "read_file",
        LocalSandbox.readFileHookArgs(effectiveFilePath, effectiveOffset, effectiveLimit),
        hookVisibleResult
      )
    } catch (e: unknown) {
      if (isHookHaltError(e)) throw e
      const msg = e instanceof Error ? e.message : String(e)
      return await this.applyPostToolUseHookToText(
        "read_file",
        LocalSandbox.readFileHookArgs(effectiveFilePath, effectiveOffset, effectiveLimit),
        `Error reading file '${effectiveFilePath}': ${msg}`
      )
    }
  }

  /**
   * Read a file as a raw Buffer with symlink protection.
   * Shared helper for read(), edit(), and other encoding-aware operations.
   */
  private async readFileBuffer(
    filePath: string,
    maxBytes?: number
  ): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const resolvedPath: string = this._resolvePath(filePath)
    return await this.readResolvedFileBuffer(resolvedPath, filePath, maxBytes)
  }

  private async readResolvedFileBuffer(
    resolvedPath: string,
    displayPath: string,
    maxBytes?: number
  ): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const assertReadableRegularFile = (stat: { isFile(): boolean; size: number }): void => {
      if (!stat.isFile()) {
        throw new Error(`File '${displayPath}' not found`)
      }
      if (maxBytes !== undefined && stat.size > maxBytes) {
        throw new Error(`File '${displayPath}' exceeds maximum readable size`)
      }
    }

    let buffer: Buffer
    if (LocalSandbox.SUPPORTS_NOFOLLOW) {
      assertReadableRegularFile(await fs.lstat(resolvedPath))
      const fd = await fs.open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        assertReadableRegularFile(await fd.stat())
        buffer = await LocalSandbox.readFileHandleBuffer(fd, displayPath, maxBytes)
      } finally {
        await fd.close()
      }
    } else {
      const stat = await fs.lstat(resolvedPath)
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${displayPath}`)
      assertReadableRegularFile(stat)
      const fd = await fs.open(resolvedPath, fsConstants.O_RDONLY)
      try {
        assertReadableRegularFile(await fd.stat())
        buffer = await LocalSandbox.readFileHandleBuffer(fd, displayPath, maxBytes)
      } finally {
        await fd.close()
      }
    }

    return { buffer, resolvedPath }
  }

  private static async readFileHandleBuffer(
    fd: Awaited<ReturnType<typeof fs.open>>,
    filePath: string,
    maxBytes?: number
  ): Promise<Buffer> {
    if (maxBytes === undefined) {
      return await fd.readFile()
    }

    const chunks: Buffer[] = []
    let total = 0
    const stream = fd.createReadStream({ start: 0, end: maxBytes, autoClose: false })
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.length
        if (total > maxBytes) {
          throw new Error(`File '${filePath}' exceeds maximum readable size`)
        }
        chunks.push(buffer)
      }
    } finally {
      stream.destroy()
    }
    return Buffer.concat(chunks, total)
  }

  // ── File safety helpers ──────────────────────────────────────────────────────

  /**
   * Serialize concurrent operations on the same resolved file path.
   * Different file paths run in parallel; same path is FIFO-queued.
   */
  private async withFileLock<T>(resolvedPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._fileLocks.get(resolvedPath) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
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
      const flags = fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
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
   * Uses realpath to resolve symlinks and toLowerCase for Windows
   * case-insensitive path comparison.
   */
  private async isWriteBlocked(filePath: string): Promise<boolean> {
    if (this.windowsSandbox !== "readonly") return false
    if (!(await LocalSandbox.getElevationState())) return true
    // Admin readonly: restrict to working directory only (matches disk-write-cwd)
    try {
      const resolved = path.resolve(this.workingDir, filePath)
      // Resolve symlinks to prevent traversal via symlinked directories.
      // If the file doesn't exist yet, resolve its parent directory instead.
      let realTarget: string
      try {
        realTarget = await fs.realpath(resolved)
      } catch {
        // File doesn't exist yet — resolve parent dir + basename
        const parentReal = await fs.realpath(path.dirname(resolved))
        realTarget = path.join(parentReal, path.basename(resolved))
      }
      const realCwd = await fs.realpath(this.workingDir)
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
  private async readonlyBlockedError(filePath: string, action: string): Promise<string> {
    return (await LocalSandbox.getElevationState())
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
    if (await this.isWriteBlocked(filePath)) {
      return { error: await this.readonlyBlockedError(filePath, "写入") }
    }
    // PreToolUse hook
    const preResult = await this.runPreToolUseHook("write_file", {
      filePath,
      content
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "write_file was blocked by a hook"}` }
    }
    if (this.isAborted) {
      return { error: "文件写入已取消。" }
    }
    if (preResult?.decision === "block") {
      return { error: `[Hook blocked] ${preResult.stdout || "write_file was blocked by a hook"}` }
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput(
      { filePath, content },
      preResult?.updatedInput
    )
    const effectiveFilePath =
      typeof updatedArgs.filePath === "string" && updatedArgs.filePath
        ? updatedArgs.filePath
        : filePath
    const effectiveContent = typeof updatedArgs.content === "string" ? updatedArgs.content : content
    if (this.isBlockedBySandbox(effectiveFilePath)) {
      return {
        error: `Access denied — '${effectiveFilePath}' is restricted by sandbox policy.`
      }
    }
    if (await this.isWriteBlocked(effectiveFilePath)) {
      return { error: await this.readonlyBlockedError(effectiveFilePath, "写入") }
    }
    // Approval gate (skipped when no orchestrator = YOLO mode)
    if (this.orchestrator) {
      const approved = await this.orchestrator.approveFileOp(
        "write_file",
        effectiveFilePath,
        this.workingDir
      )
      if (!approved) {
        return { error: "文件写入被用户拒绝。" }
      }
    }
    if (this.isAborted) {
      return { error: "文件写入已取消。" }
    }
    const resolvedPath = this._resolvePath(effectiveFilePath)
    // deepagents' FilesystemBackend.write() refuses to overwrite: if the
    // target exists it returns an "already exists" error and does NOT touch
    // the file. Therefore every successful super.write() is a brand-new
    // file ⇒ prior content is empty and deletedLineCount = 0. We skip the
    // old pre-read entirely (it was wasted I/O on success and would also
    // bypass isCodeFile / size guards on failure).
    const result = await this.withFileLock(resolvedPath, async () => {
      if (this.isAborted) {
        return { error: "文件写入已取消。" }
      }
      const r = await super.write(effectiveFilePath, effectiveContent)
      if (!r.error) {
        await this.recordReadTime(resolvedPath)
      }
      return r
    })
    if (!result.error) {
      this._onFileMutation?.(effectiveFilePath, "write")
      // Adoption tracking (side-effect only, never throws)
      try {
        recordAdoptionGen({
          threadId: this.runId,
          tool: "write_file",
          filePath: effectiveFilePath,
          generatedContent: effectiveContent,
          workspacePath: this.workingDir,
          // write_file only succeeds when creating a new file (see above) —
          // no prior lines could have been deleted.
          deletedLineCount: 0
        })
      } catch {
        // tracker must not affect tool result
      }
    }
    // PostToolUse hook
    try {
      const postResult = await this.runHooks("PostToolUse", {
        toolName: "write_file",
        toolArgs: { filePath: effectiveFilePath, content: effectiveContent },
        toolResult: JSON.stringify(result),
        workspacePath: this.workingDir,
        sessionId: this.runId
      })
      return LocalSandbox.applyPostHookContext(result, postResult, "write_file")
    } catch (e) {
      if (isHookHaltError(e)) throw e
      console.warn("[Hooks] PostToolUse write error:", e)
      return result
    }
  }

  /**
   * Override uploadFiles to enforce readonly sandbox restrictions on each file.
   */
  async uploadFiles(files: [string, Uint8Array][]): Promise<FileUploadResponse[]> {
    // Check for both sandbox-sensitive and readonly-blocked files
    const indexed = await Promise.all(files.map(async ([filePath, content], i) => ({
      filePath, content, i,
      sandboxBlocked: this.isBlockedBySandbox(filePath),
      writeBlocked: await this.isWriteBlocked(filePath)
    })))
    const allowed = indexed.filter((e) => !e.sandboxBlocked && !e.writeBlocked)

    if (allowed.length === files.length) {
      const results = await super.uploadFiles(files)
      results.forEach((result, index) => {
        if (!result.error) this._onFileMutation?.(files[index][0], "upload")
      })
      return results
    }

    // Batch-delegate all allowed files in one call
    const allowedResults =
      allowed.length > 0
        ? await super.uploadFiles(
            allowed.map((e) => [e.filePath, e.content] as [string, Uint8Array])
          )
        : []

    // Merge results back in original order
    const results: FileUploadResponse[] = new Array(files.length)
    const denied: FileOperationError = "permission_denied"
    let ai = 0
    for (const entry of indexed) {
      if (entry.sandboxBlocked || entry.writeBlocked) {
        results[entry.i] = { path: entry.filePath, error: denied }
      } else {
        const result = allowedResults[ai++]
        results[entry.i] = result
        if (!result.error) this._onFileMutation?.(entry.filePath, "upload")
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
    if (await this.isWriteBlocked(filePath)) {
      return { error: await this.readonlyBlockedError(filePath, "编辑") }
    }
    // PreToolUse hook
    const preResult = await this.runPreToolUseHook("edit_file", {
      filePath,
      oldString,
      newString,
      replaceAll
    })
    if (preResult?.blocked) {
      return { error: `[Hook blocked] ${preResult.stdout || "edit_file was blocked by a hook"}` }
    }
    if (this.isAborted) {
      return { error: "文件编辑已取消。" }
    }
    if (preResult?.decision === "block") {
      return { error: `[Hook blocked] ${preResult.stdout || "edit_file was blocked by a hook"}` }
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput(
      { filePath, oldString, newString, replaceAll },
      preResult?.updatedInput
    )
    const effectiveFilePath =
      typeof updatedArgs.filePath === "string" && updatedArgs.filePath
        ? updatedArgs.filePath
        : filePath
    const effectiveOldString =
      typeof updatedArgs.oldString === "string" ? updatedArgs.oldString : oldString
    const effectiveNewString =
      typeof updatedArgs.newString === "string" ? updatedArgs.newString : newString
    const effectiveReplaceAll =
      typeof updatedArgs.replaceAll === "boolean" ? updatedArgs.replaceAll : replaceAll
    if (this.isBlockedBySandbox(effectiveFilePath)) {
      return {
        error: `Access denied — '${effectiveFilePath}' is restricted by sandbox policy.`
      }
    }
    if (await this.isWriteBlocked(effectiveFilePath)) {
      return { error: await this.readonlyBlockedError(effectiveFilePath, "编辑") }
    }
    // Approval gate (skipped when no orchestrator = YOLO mode)
    if (this.orchestrator) {
      const approved = await this.orchestrator.approveFileOp(
        "edit_file",
        effectiveFilePath,
        this.workingDir
      )
      if (!approved) {
        return { error: "文件编辑被用户拒绝。" }
      }
    }
    if (this.isAborted) {
      return { error: "文件编辑已取消。" }
    }
    try {
      const resolvedPath = this._resolvePath(effectiveFilePath)
      const result = await this.withFileLock(resolvedPath, async () => {
        if (this.isAborted) {
          return { error: "文件编辑已取消。" }
        }
        const { buffer } = await this.readFileBuffer(effectiveFilePath)
        const ext = path.extname(resolvedPath).toLowerCase()
        const encoding = this.detectEncoding(buffer, ext)
        const content = iconv.decode(buffer, encoding)

        // Check file hasn't been modified externally since last read
        await this.assertNotModifiedSinceRead(resolvedPath)

        let expectedContent: string
        let occurrences: number

        if (content === "" && effectiveOldString === "") {
          expectedContent = effectiveNewString
          occurrences = 0
        } else {
          const r = replace(content, effectiveOldString, effectiveNewString, effectiveReplaceAll)
          expectedContent = r.newContent
          occurrences = r.occurrences
        }

        if (this.isAborted) {
          return { error: "文件编辑已取消。" }
        }
        await this.writeFileEncoded(resolvedPath, expectedContent, encoding)
        await this.recordReadTime(resolvedPath)
        return { path: effectiveFilePath, filesUpdate: null, occurrences }
      })
      if (!result.error) {
        this._onFileMutation?.(effectiveFilePath, "edit")
        // Adoption tracking (side-effect only, never throws).
        // Only successful edits should be counted as generated code adoption.
        try {
          recordAdoptionGen({
            threadId: this.runId,
            tool: "edit_file",
            filePath: effectiveFilePath,
            // For edits, the local generated fragment is new_string; the tracker
            // expands its line hashes by occurrences for replaceAll.
            generatedContent: effectiveNewString,
            workspacePath: this.workingDir,
            // Pass the edit fragments only — no full-file references. Tracker
            // derives deletedLineCount in a microtask via
            // max(0, countNonBlankLines(oldString) - countNonBlankLines(newString)) * occurrences,
            // avoiding any full-file scan or retention of editor buffers.
            oldString: effectiveOldString,
            newString: effectiveNewString,
            occurrences: result.occurrences
          })
        } catch {
          // tracker must not affect tool result
        }
      }
      // PostToolUse hook
      try {
        const postResult = await this.runHooks("PostToolUse", {
          toolName: "edit_file",
          toolArgs: {
            filePath: effectiveFilePath,
            oldString: effectiveOldString,
            newString: effectiveNewString,
            replaceAll: effectiveReplaceAll
          },
          toolResult: JSON.stringify(result),
          workspacePath: this.workingDir,
          sessionId: this.runId
        })
        return LocalSandbox.applyPostHookContext(result, postResult, "edit_file")
      } catch (e) {
        if (isHookHaltError(e)) throw e
        console.warn("[Hooks] PostToolUse edit error:", e)
        return result
      }
    } catch (e: unknown) {
      if (isHookHaltError(e)) throw e
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `Error editing file '${effectiveFilePath}': ${msg}` }
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

  /**
   * Encoding detection runs on the main process for every shell command, so we keep
   * the working set small. chardet is pure JS and walks the whole buffer; for our
   * use case (telling UTF-8 from GBK/CP936 on Chinese Windows) the first ~8KB is more
   * than enough. Avoids spending 5–15ms per maxOutputBytes-capped command.
   */
  private static readonly ENCODING_DETECT_HEAD_BYTES = 8 * 1024

  private detectCmdEncoding(buf: Buffer): string {
    if (buf.length === 0) return "utf-8"
    const sample = buf.length > LocalSandbox.ENCODING_DETECT_HEAD_BYTES
      ? buf.subarray(0, LocalSandbox.ENCODING_DETECT_HEAD_BYTES)
      : buf
    const detected = chardet.detect(sample)
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
    if (!LocalSandbox.isValidUtf8(sample)) {
      return enc
    }
    return "utf-8"
  }

  /**
   * Pick the buffer to feed encoding detection. Prefer stdout (more representative of
   * the program's text output), fall back to stderr. Avoid the third Buffer.concat
   * the previous implementation paid for on every command — only stdoutBuf and stderrBuf
   * are already-allocated slices we can reuse directly.
   */
  private static encodingDetectionBuffer(stdoutBuf: Buffer, stderrBuf: Buffer): Buffer {
    return stdoutBuf.length > 0 ? stdoutBuf : stderrBuf
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
    includeGlob: string | null,
    realpathCache: Map<string, string | null>
  ): Promise<EncodingAwareLiteralSearchResult> {
    const results: Record<string, Array<[number, string]>> = {}
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(baseFull)
    } catch {
      return { results, stoppedEarly: false } // path does not exist — return empty
    }
    const isFile = stat.isFile()
    const cwd = isFile ? path.dirname(baseFull) : baseFull
    // If baseFull points to a single file, only search that file.
    const files: AsyncIterable<string | Buffer> | string[] = isFile
      ? [baseFull]
      : (fg.stream("**/*", {
          cwd,
          absolute: true,
          onlyFiles: true,
          dot: true,
          followSymbolicLinks: false,
          ignore: LocalSandbox.SEARCH_IGNORE
        }) as AsyncIterable<string | Buffer>)
    const maxBytes = this._maxFileSizeBytes
    const cwdDir = this._virtualMode ? this._cwd : ""
    let matchCount = 0
    let charCount = 0
    let scannedFiles = 0
    let stoppedEarly = false

    const tryAppendMatch = (virtPath: string, lineNum: number, lineText: string): boolean => {
      const text = LocalSandbox.truncateGrepLine(lineText)
      const estChars = virtPath.length + text.length + 16
      if (
        matchCount >= LocalSandbox.MAX_GREP_MATCHES ||
        charCount + estChars > LocalSandbox.MAX_GREP_CHARS
      ) {
        stoppedEarly = true
        return false
      }
      if (!results[virtPath]) results[virtPath] = []
      results[virtPath].push([lineNum, text])
      matchCount++
      charCount += estChars
      return true
    }

    searchFiles: for await (const fileEntry of files) {
      const fp = String(fileEntry)
      try {
        // matchBase: when glob has no slashes (e.g. "*.ts"), match against
        // basename only — consistent with our grep glob filtering behavior.
        const includeGlobUsesPath = includeGlob?.includes("/") || includeGlob?.includes("\\")
        const globPath = (isFile ? path.relative(this._cwd, fp) : path.relative(cwd, fp))
          .split(path.sep)
          .join("/")
        if (
          includeGlob &&
          !micromatch.isMatch(globPath, includeGlob, { matchBase: !includeGlobUsesPath })
        )
          continue
        if (this._hiddenSkillDirKeys.size > 0 && this.isHiddenSkillPath(fp, realpathCache)) {
          continue
        }
        if (this.windowsSandbox === "elevated" && this.isSensitiveSandboxPath(fp, realpathCache)) {
          continue
        }
        const fpStat = await fs.lstat(fp)
        if (fpStat.isSymbolicLink() || !fpStat.isFile() || fpStat.size > maxBytes) continue
        if (!isFile && scannedFiles >= LocalSandbox.MAX_GREP_FALLBACK_SCANNED_FILES) {
          stoppedEarly = true
          break searchFiles
        }
        scannedFiles++

        const { buffer: buf } = await this.readResolvedFileBuffer(fp, fp, maxBytes)
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
          if (!tryAppendMatch(virtPath!, i + 1, lines[i])) {
            break searchFiles
          }
        }
      } catch {
        continue
      }
    }
    return { results, stoppedEarly }
  }

  private static readonly SHELL_BLACKLIST = new Set(["fish", "nu"])

  /**
   * Resolve the best shell for command execution.
   * All platforms: check $SHELL first (skip non-POSIX shells like fish/nu).
   * Windows fallback: GIT_BASH_PATH env > detect git install > COMSPEC (cmd.exe)
   * macOS fallback: /bin/zsh
   * Linux fallback: /bin/sh
   */
  private static _cachedResolvedShell: string | null = null
  private static _resolvedShellPromise: Promise<string> | null = null

  /** Public accessor for the resolved shell path (used by system prompt). */
  static resolvedShell(): string {
    if (LocalSandbox._cachedResolvedShell) return LocalSandbox._cachedResolvedShell
    void LocalSandbox.resolveShell().catch((err) => {
      console.warn("[LocalSandbox] failed to resolve shell:", err)
    })

    const isWindows = process.platform === "win32"
    const userShell = process.env.SHELL
    if (userShell) {
      const basename = isWindows
        ? path.win32.basename(userShell)
        : path.basename(userShell)
      if (!LocalSandbox.SHELL_BLACKLIST.has(basename)) return userShell
    }
    if (isWindows) return process.env.GIT_BASH_PATH || process.env.COMSPEC || "cmd.exe"
    if (process.platform === "darwin") return "/bin/zsh"
    return "/bin/sh"
  }

  /**
   * Resolve the best shell for Windows sandbox execution.
   * Git Bash (MSYS2) crashes under restricted tokens (NtSetInformationToken fails),
   * so we must skip it and use PowerShell or cmd.exe instead.
   */
  private static _cachedSandboxShell: { shell: string; flags: string[] } | null = null
  private static _sandboxShellPromise: Promise<{ shell: string; flags: string[] }> | null = null

  private static async resolveWindowsSandboxShell(): Promise<{ shell: string; flags: string[] }> {
    if (LocalSandbox._cachedSandboxShell) return LocalSandbox._cachedSandboxShell
    if (LocalSandbox._sandboxShellPromise) return LocalSandbox._sandboxShellPromise

    const lookup = (async () => {
      for (const ps of ["pwsh", "powershell"]) {
        const fullPath = await LocalSandbox.which(ps)
        if (fullPath) {
          LocalSandbox._cachedSandboxShell = { shell: fullPath, flags: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"] }
          return LocalSandbox._cachedSandboxShell
        }
      }
      LocalSandbox._cachedSandboxShell = { shell: process.env.COMSPEC || "cmd.exe", flags: ["/c"] }
      return LocalSandbox._cachedSandboxShell
    })()

    LocalSandbox._sandboxShellPromise = lookup
    try {
      return await lookup
    } finally {
      if (LocalSandbox._sandboxShellPromise === lookup) {
        LocalSandbox._sandboxShellPromise = null
      }
    }
  }

  /** Public accessor for the Windows sandbox shell (PowerShell or cmd.exe). */
  static resolvedWindowsSandboxShell(): string {
    void LocalSandbox.resolveWindowsSandboxShell().catch((err) => {
      console.warn("[LocalSandbox] failed to resolve Windows sandbox shell:", err)
    })
    return LocalSandbox._cachedSandboxShell?.shell ?? process.env.COMSPEC ?? "cmd.exe"
  }

  /**
   * Build a sandbox-safe copy of env with PATH reordered:
   * System32 and System32\Wbem are moved to the front so native Windows
   * executables (whoami, find, sort, etc.) are found before MSYS2/Git
   * equivalents that crash under restricted tokens (STATUS_DLL_NOT_FOUND).
   */
  /**
   * Cached Python installation directory discovered via `py -0p` or `where python`.
   * The py launcher uses registry, which sandbox users can't access — so we resolve
   * the real Python path from the main process and inject it into the sandbox PATH.
   */
  private static _pythonDir: string | null | undefined = undefined // undefined = not yet checked
  private static _pythonDirPromise: Promise<string | null> | null = null

  private static async resolvePythonDir(): Promise<string | null> {
    if (LocalSandbox._pythonDir !== undefined) return LocalSandbox._pythonDir
    if (LocalSandbox._pythonDirPromise) return LocalSandbox._pythonDirPromise

    const lookup = (async () => {
      try {
        // Try py launcher first (reads registry, works even when python not in PATH)
        const { stdout } = await execFileP("py", ["-c", "import sys; print(sys.executable)"], {
          timeout: 5000,
          encoding: "utf-8",
          windowsHide: true
        })
        const pyOutput = String(stdout).trim()
        if (pyOutput && await pathExists(pyOutput)) {
          LocalSandbox._pythonDir = path.dirname(pyOutput)
          console.log(`[LocalSandbox] resolved Python dir via py launcher: ${LocalSandbox._pythonDir}`)
          return LocalSandbox._pythonDir
        }
      } catch { /* py launcher not available */ }
      try {
        // Fallback: where python
        const { stdout } = await execFileP("where", ["python"], {
          timeout: 5000,
          encoding: "utf-8",
          windowsHide: true
        })
        const whereOutput = String(stdout).trim().split(/\r?\n/)[0]
        if (whereOutput && await pathExists(whereOutput)) {
          LocalSandbox._pythonDir = path.dirname(whereOutput)
          console.log(`[LocalSandbox] resolved Python dir via where: ${LocalSandbox._pythonDir}`)
          return LocalSandbox._pythonDir
        }
      } catch { /* python not found */ }
      LocalSandbox._pythonDir = null
      return null
    })()

    LocalSandbox._pythonDirPromise = lookup
    try {
      return await lookup
    } finally {
      if (LocalSandbox._pythonDirPromise === lookup) {
        LocalSandbox._pythonDirPromise = null
      }
    }
  }

  private static async buildSandboxEnv(env: Record<string, string>): Promise<Record<string, string>> {
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
    if (!system.some((s) => s.toLowerCase() === sys32Lower)) {
      system.unshift(sys32)
    }
    // Inject Python only when the background prewarm has already resolved it.
    // Direct python/py commands wait in shouldPreferUnelevated; ordinary commands
    // should not be delayed by py/where python probes while building the sandbox env.
    const pythonDir = LocalSandbox._pythonDir ?? null
    if (pythonDir) {
      const pythonLower = pythonDir.toLowerCase()
      if (
        !system.some((s) => s.toLowerCase() === pythonLower) &&
        !rest.some((s) => s.toLowerCase() === pythonLower)
      ) {
        rest.push(pythonDir)
        // Also add Scripts subdir (where pip.exe lives)
        const scriptsDir = path.join(pythonDir, "Scripts")
        if (await pathExists(scriptsDir)) {
          rest.push(scriptsDir)
        }
      }
    }
    const pathKey = result.PATH !== undefined ? "PATH" : "Path"
    result[pathKey] = [...system, ...rest].join(sep)
    return result
  }

  private static async resolveShell(): Promise<string> {
    if (LocalSandbox._cachedResolvedShell) return LocalSandbox._cachedResolvedShell
    if (LocalSandbox._resolvedShellPromise) return LocalSandbox._resolvedShellPromise

    const lookup = (async () => {
      const isWindows = process.platform === "win32"
      const userShell = process.env.SHELL
      if (userShell) {
        const basename = isWindows
          ? path.win32.basename(userShell)
          : path.basename(userShell)
        if (!LocalSandbox.SHELL_BLACKLIST.has(basename)) {
          LocalSandbox._cachedResolvedShell = userShell
          return userShell
        }
      }

      if (isWindows) {
        const envBash = process.env.GIT_BASH_PATH
        if (envBash) {
          LocalSandbox._cachedResolvedShell = envBash
          return envBash
        }

        // Derive bash.exe from git.exe install location:
        // git.exe is typically at C:\Program Files\Git\cmd\git.exe
        // bash.exe is at C:\Program Files\Git\bin\bash.exe
        const gitExe = await LocalSandbox.which("git")
        if (gitExe) {
          const bash = path.join(gitExe, "..", "..", "bin", "bash.exe")
          try {
            if (await pathExists(bash)) {
              LocalSandbox._cachedResolvedShell = bash
              return bash
            }
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
            if (await pathExists(bash)) {
              LocalSandbox._cachedResolvedShell = bash
              return bash
            }
          } catch { /* ignore */ }
        }

        LocalSandbox._cachedResolvedShell = process.env.COMSPEC || "cmd.exe"
        return LocalSandbox._cachedResolvedShell
      }

      LocalSandbox._cachedResolvedShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"
      return LocalSandbox._cachedResolvedShell
    })()

    LocalSandbox._resolvedShellPromise = lookup
    try {
      return await lookup
    } finally {
      if (LocalSandbox._resolvedShellPromise === lookup) {
        LocalSandbox._resolvedShellPromise = null
      }
    }
  }

  /** Asynchronous `which` — locate an executable on PATH without blocking the main process. */
  private static async which(name: string): Promise<string | null> {
    const isWindows = process.platform === "win32"
    const pathEnv = process.env.PATH || ""
    const sep = isWindows ? ";" : ":"
    const extensions = isWindows ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""]
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue
      for (const ext of extensions) {
        const full = path.join(dir, name + ext)
        try {
          if (await pathExists(full)) return full
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
  private static _isElevatedPromise: Promise<boolean> | null = null

  /**
   * Check if the current process is running with administrator privileges (Windows only).
   * Cached after first call.
   *
   * Uses `whoami /groups` + High Mandatory Level SID (S-1-16-12288) — the only
   * reliable method. Queries the process token directly, no service dependency.
   *
   * Do NOT use `net session`: in corporate domain environments it can succeed
   * for non-admin users due to group policy, producing a false positive that
   * causes the UAC prompt to be skipped entirely.
   *
   * Do NOT use `fsutil dirty query` — it succeeds without admin on Windows 11.
   *
   * IMPORTANT: In packaged Electron apps, process.cwd() may point to an
   * invalid or ASAR-internal path, causing execSync to fail. We explicitly
   * set cwd to %SYSTEMROOT% and add windowsHide to prevent spurious failures.
   */
  private static async getElevationState(): Promise<boolean> {
    if (LocalSandbox._isElevated !== null) return LocalSandbox._isElevated
    if (LocalSandbox._isElevatedPromise) return LocalSandbox._isElevatedPromise
    if (process.platform !== "win32") {
      LocalSandbox._isElevated = false
      return false
    }
    const safeCwd = process.env.SYSTEMROOT || process.env.windir || "C:\\Windows"
    const lookup = execFileP("whoami", ["/groups"], {
      encoding: "utf-8",
      windowsHide: true,
      cwd: safeCwd,
      timeout: 5000
    }).then(({ stdout }) => {
      LocalSandbox._isElevated = String(stdout).includes("S-1-16-12288")
      console.log(`[LocalSandbox] isElevated=${LocalSandbox._isElevated} (whoami /groups)`)
      return LocalSandbox._isElevated as boolean
    }).catch((e) => {
      // Transient probe failures (AV interception, PATH glitch, 5s timeout) must
      // NOT pollute the cache — leaving _isElevated null lets the next call retry.
      // Callers conservatively treat the rejected probe as non-admin for safety,
      // but a single bad whoami call won't pin the whole process to false.
      console.log("[LocalSandbox] whoami failed (cache untouched, will retry):", (e as Error).message?.slice(0, 120))
      return false
    }).finally(() => {
      if (LocalSandbox._isElevatedPromise === lookup) {
        LocalSandbox._isElevatedPromise = null
      }
    })
    LocalSandbox._isElevatedPromise = lookup
    return lookup
  }

  /** Directories that currently have the Everyone ACE granted, with reference count.
   *  Key = normalized dir path, value = number of active runs using that grant.
   *  ACL is only revoked when the count drops to 0. */
  private static readonly _grantedAclRefCount = new Map<string, number>()
  /** Per-run tracking: which dirs each runId has granted (for correct decrement on cleanup). */
  private static readonly _runAclDirs = new Map<string, Set<string>>()
  /** Directories that should never be revoked (e.g. TEMP — public dir, safe to leave open). */
  private static readonly _permanentAclDirs = new Set<string>()

  /** Grant Everyone access on a sandbox path (for WRITE_RESTRICTED tokens). Returns when done.
   *  @param runId — identifies the agent run requesting the grant (for ref-counting). */
  private static async grantSandboxWriteAcl(dir: string, runId: string): Promise<void> {
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
        return
      }
    } else {
      // Same run already granted this dir — skip entirely.
      return
    }
    let isDirectory = true
    try {
      isDirectory = (await fs.stat(dir)).isDirectory()
    } catch {
      isDirectory = true
    }
    // (OI)(CI) = inherit to files & subdirs so the restricted token can
    // read/write/delete at any depth. Uses async spawn to avoid blocking
    // the event loop on large repos (NTFS propagates inherited ACEs to
    // all existing descendants, which can take tens of seconds).
    return new Promise<void>((resolve) => {
      const grant = isDirectory
        ? `${LocalSandbox.EVERYONE_SID}:(OI)(CI)(M)`
        : `${LocalSandbox.EVERYONE_SID}:RX`
      const proc = spawn("icacls", [dir, "/grant", grant], {
        stdio: "ignore",
        windowsHide: true
      })
      const timeoutId = setTimeout(() => {
        console.warn(
          `[LocalSandbox] icacls grant timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`
        )
        try {
          proc.kill()
        } catch {
          /* already exited */
        }
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
      const proc = spawn("icacls", [dir, "/remove:g", LocalSandbox.EVERYONE_SID], {
        stdio: "ignore",
        windowsHide: true
      })
      const timeoutId = setTimeout(() => {
        console.warn(
          `[LocalSandbox] icacls revoke timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`
        )
        try {
          proc.kill()
        } catch {
          /* already exited */
        }
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
    const dirsToRevoke = [...runDirs].filter((key) => !LocalSandbox._permanentAclDirs.has(key))
    LocalSandbox._runAclDirs.delete(runId)
    if (dirsToRevoke.length === 0) return
    console.log(`[LocalSandbox] revokeGrantedAclsForRun(${runId}): releasing ${dirsToRevoke.length} dirs`)
    await mapLimit(
      dirsToRevoke,
      LocalSandbox.ACL_OPERATION_CONCURRENCY,
      (dir) => LocalSandbox.revokeSandboxWriteAcl(dir)
    )
  }

  /** Sandbox user names used by elevated mode. */
  private static readonly ELEVATED_SANDBOX_USERS = ["CodexSandboxOnline", "CodexSandboxOffline"]

  /**
   * Grant elevated sandbox users read+write ACL on a workspace directory via icacls.
   * No UAC needed — the current user owns the directory so they can modify its ACLs.
   */
  /** Timeout for icacls ACL operations (30 seconds). */
  private static readonly ICACLS_TIMEOUT_MS = 30_000

  private static async grantElevatedWorkspaceAcl(dir: string, abortSignal?: AbortSignal): Promise<void> {
    LocalSandbox.throwIfAborted(abortSignal)
    let isDirectory = true
    try {
      isDirectory = (await fs.stat(dir)).isDirectory()
    } catch {
      isDirectory = true
    }
    return new Promise<void>((resolve, reject) => {
      // Grant both sandbox users Modify permission with inheritance.
      // (OI)(CI) = Object Inherit + Container Inherit — new files/dirs inherit automatically.
      // Intentionally NO /T flag: /T recursively touches every existing file's ACL, which
      // can take minutes on large repos (node_modules alone can have 100k+ files).
      // codex.exe handles existing-file access internally; we only need the top-level grant
      // so the sandbox user can enter the directory and inheritance covers the rest.
      const args: string[] = [dir]
      const grantSuffix = isDirectory ? "(OI)(CI)(M)" : "RX"
      for (const user of LocalSandbox.ELEVATED_SANDBOX_USERS) {
        args.push("/grant", `${user}:${grantSuffix}`)
      }
      args.push("/Q")
      const proc = spawn("icacls", args, {
        stdio: "pipe",
        windowsHide: true
      })
      let stderr = ""
      const onAbort = () => {
        clearTimeout(timeoutId)
        try { proc.kill() } catch { /* already exited */ }
        reject(LocalSandbox.createAbortError())
      }
      const timeoutId = setTimeout(() => {
        console.warn(
          `[LocalSandbox] icacls elevated grant timed out after ${LocalSandbox.ICACLS_TIMEOUT_MS}ms on ${dir}, killing`
        )
        try {
          proc.kill()
        } catch {
          /* already exited */
        }
        resolve() // Don't block execution — codex.exe will handle ACL internally
      }, LocalSandbox.ICACLS_TIMEOUT_MS)
      abortSignal?.addEventListener("abort", onAbort, { once: true })
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on("exit", (code) => {
        clearTimeout(timeoutId)
        abortSignal?.removeEventListener("abort", onAbort)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`icacls exited ${code}: ${stderr.trim()}`))
        }
      })
      proc.on("error", (err) => {
        clearTimeout(timeoutId)
        abortSignal?.removeEventListener("abort", onAbort)
        reject(err)
      })
    })
  }

  private static getElevatedPrepareRoots(workingDir: string, cacheRoots: string[]): string[] {
    return Array.from(new Set([workingDir, ...cacheRoots].map((dir) => path.win32.normalize(dir))))
  }

  private static async isCacheableElevatedPreparedRoot(root: string): Promise<boolean> {
    try {
      return (await fs.stat(root)).isDirectory()
    } catch {
      return false
    }
  }

  private static async getCacheableElevatedPreparedRoots(roots: string[]): Promise<string[]> {
    const checked = await mapLimit(roots, LocalSandbox.ACL_OPERATION_CONCURRENCY, async (root) => ({
      root,
      cacheable: await LocalSandbox.isCacheableElevatedPreparedRoot(root)
    }))
    return checked.filter((entry) => entry.cacheable).map((entry) => entry.root)
  }

  private static async areCacheableElevatedRootsPrepared(roots: string[]): Promise<boolean> {
    const cacheableRoots = await LocalSandbox.getCacheableElevatedPreparedRoots(roots)
    return cacheableRoots.length === 0 || await areElevatedRootsPreparedAsync(cacheableRoots)
  }

  private static async prepareElevatedRoot(root: string): Promise<boolean> {
    const key = normalizeDirKey(root)
    if (!(await isElevatedSetupComplete())) return Promise.resolve(false)
    const cachePreparedRoot = await LocalSandbox.isCacheableElevatedPreparedRoot(root)
    if (cachePreparedRoot && await areElevatedRootsPreparedAsync([root])) return Promise.resolve(true)
    const existing = LocalSandbox._elevatedRootPreparePromises.get(key)
    if (existing) return existing

    const task = LocalSandbox.grantElevatedWorkspaceAcl(root)
      .then(() => {
        if (cachePreparedRoot) {
          markElevatedRootsPrepared([root])
        }
        return true
      })
      .catch((err) => {
        console.warn(`[LocalSandbox] elevated root prewarm failed for ${root}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      })

    LocalSandbox._elevatedRootPreparePromises.set(key, task)
    task.finally(() => {
      if (LocalSandbox._elevatedRootPreparePromises.get(key) === task) {
        LocalSandbox._elevatedRootPreparePromises.delete(key)
      }
    }).catch(() => { /* handled by caller */ })
    return task
  }

  private static buildElevatedWorkspacePrepareKey(roots: string[]): string {
    return roots.map((dir) => normalizeDirKey(dir)).join("|")
  }

  private static async prewarmElevatedWorkspaceRoots(workingDir: string, cacheRoots: string[]): Promise<boolean> {
    if (!(await isElevatedSetupComplete())) return Promise.resolve(false)

    const roots = LocalSandbox.getElevatedPrepareRoots(workingDir, cacheRoots)
    const cacheableRoots = await LocalSandbox.getCacheableElevatedPreparedRoots(roots)
    if (cacheableRoots.length === roots.length && await areElevatedRootsPreparedAsync(cacheableRoots)) return Promise.resolve(true)

    const key = LocalSandbox.buildElevatedWorkspacePrepareKey(roots)
    const existing = LocalSandbox._elevatedWorkspacePreparePromises.get(key)
    if (existing) return existing

    // Cache roots must physically exist before icacls runs; otherwise grant fails
    // and the failure isn't recoverable without redoing the whole chain. Await the
    // shared in-flight prepare promise so concurrent callers reuse the same mkdir.
    const task = LocalSandbox.prepareSandboxCacheDirs(cacheRoots[0], cacheRoots[1])
      .catch((err) => {
        console.warn(
          `[LocalSandbox] elevated prewarm: cache dir prep failed for ${workingDir}: ${err instanceof Error ? err.message : String(err)}`
        )
        return [] as string[]
      })
      .then(() => mapLimit(
        roots,
        LocalSandbox.ACL_OPERATION_CONCURRENCY,
        (root) => LocalSandbox.prepareElevatedRoot(root)
      ))
      .then(async (results) => results.every(Boolean) && await LocalSandbox.areCacheableElevatedRootsPrepared(roots))
      .catch((err) => {
        console.warn(
          `[LocalSandbox] elevated workspace prewarm failed for ${workingDir}: ${err instanceof Error ? err.message : String(err)}`
        )
        return false
      })

    LocalSandbox._elevatedWorkspacePreparePromises.set(key, task)
    task.finally(() => {
      if (LocalSandbox._elevatedWorkspacePreparePromises.get(key) === task) {
        LocalSandbox._elevatedWorkspacePreparePromises.delete(key)
      }
    }).catch(() => { /* handled by caller */ })
    return task
  }

  private static async waitForElevatedRootsPrepared(
    workingDir: string,
    cacheRoots: string[],
    waitMs = LocalSandbox.ELEVATED_COMMAND_PREPARE_GRACE_MS,
    abortSignal?: AbortSignal
  ): Promise<boolean> {
    const roots = LocalSandbox.getElevatedPrepareRoots(workingDir, cacheRoots)
    const cacheableRoots = await LocalSandbox.getCacheableElevatedPreparedRoots(roots)
    if (cacheableRoots.length === roots.length && await areElevatedRootsPreparedAsync(cacheableRoots)) return true

    const preparePromise = LocalSandbox.prewarmElevatedWorkspaceRoots(workingDir, cacheRoots)
    if (waitMs <= 0) return false

    const timedResult = await LocalSandbox.raceWithAbort(
      Promise.race<boolean>([
        preparePromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs))
      ]),
      abortSignal
    ).catch((err) => {
      if (LocalSandbox.isAbortError(err)) throw err
      return false
    })

    return timedResult && await LocalSandbox.areCacheableElevatedRootsPrepared(roots)
  }

  private static async ensureElevatedWorkspaceSetup(
    workingDir: string,
    cacheRoots: string[],
    allowSetupPrompt: boolean,
    abortSignal?: AbortSignal
  ): Promise<{ ready: boolean; error?: string }> {
    LocalSandbox.throwIfAborted(abortSignal)
    if (await LocalSandbox.areElevatedWorkspaceRootsPrepared(workingDir, cacheRoots)) return { ready: true }

    const workspaceKey = normalizeDirKey(workingDir)
    const existing = LocalSandbox._elevatedWorkspaceSetupPromises.get(workspaceKey)
    if (existing) return LocalSandbox.raceWithAbort(existing, abortSignal)

    const task = (async (): Promise<{ ready: boolean; error?: string }> => {
      LocalSandbox.throwIfAborted(abortSignal)
      if (await LocalSandbox.areElevatedWorkspaceRootsPrepared(workingDir, cacheRoots)) return { ready: true }

      // Cache roots have to exist physically before either icacls (preflight) or
      // runElevatedSetupForPaths (which filters non-existent paths during validation).
      // Skip this if it fails — we still try the ACL path below in case the dir
      // already exists from a prior run.
      await LocalSandbox.prepareSandboxCacheDirs(cacheRoots[0], cacheRoots[1]).catch((err) => {
        console.warn(
          `[LocalSandbox] elevated setup: cache dir prep failed for ${workingDir}: ${err instanceof Error ? err.message : String(err)}`
        )
        return [] as string[]
      })
      LocalSandbox.throwIfAborted(abortSignal)

      if (await isElevatedSetupComplete()) {
        try {
          await LocalSandbox.grantElevatedWorkspaceAcl(workingDir, abortSignal)
          await mapLimit(
            cacheRoots,
            LocalSandbox.ACL_OPERATION_CONCURRENCY,
            (dir) => LocalSandbox.grantElevatedWorkspaceAcl(dir, abortSignal)
          )
          markElevatedRootsPrepared([workingDir, ...cacheRoots])
          return { ready: true }
        } catch (err) {
          if (LocalSandbox.isAbortError(err)) throw err
          const message = err instanceof Error ? err.message : String(err)
          console.warn(`[LocalSandbox] elevated workspace ACL preflight failed for ${workingDir}: ${message}`)
          if (!allowSetupPrompt) return { ready: false, error: message }
        }
      } else if (!allowSetupPrompt) {
        return { ready: false, error: "initial elevated setup pending" }
      }

      const setupResult = await runElevatedSetupForPaths([workingDir, ...cacheRoots], abortSignal)
      if (setupResult.success) {
        if (allowSetupPrompt) {
          await LocalSandbox.delayWithAbort(LocalSandbox.ELEVATED_EXPLICIT_SETUP_SETTLE_MS, abortSignal)
        }
        markElevatedRootsPrepared([workingDir, ...cacheRoots])
        if (await LocalSandbox.areElevatedWorkspaceRootsPrepared(workingDir, cacheRoots)) {
          return { ready: true }
        }
        return { ready: false, error: "Elevated 工作区权限没有完全准备好，请重试。" }
      }
      return { ready: false, error: setupResult.error || "未知错误" }
    })()

    LocalSandbox._elevatedWorkspaceSetupPromises.set(workspaceKey, task)
    task.finally(() => {
      if (LocalSandbox._elevatedWorkspaceSetupPromises.get(workspaceKey) === task) {
        LocalSandbox._elevatedWorkspaceSetupPromises.delete(workspaceKey)
      }
    }).catch(() => { /* handled by caller */ })
    return task
  }

  private static createAbortError(): Error {
    const error = new Error("Operation aborted")
    error.name = "AbortError"
    return error
  }

  private static isAbortError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.name === "AbortError" || /abort/i.test(err.message)
    }
    return typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError"
  }

  private static throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw LocalSandbox.createAbortError()
    }
  }

  private static raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(LocalSandbox.createAbortError())

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        reject(LocalSandbox.createAbortError())
      }

      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (err) => {
          signal.removeEventListener("abort", onAbort)
          reject(err)
        }
      )
    })
  }

  private static delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return LocalSandbox.raceWithAbort(
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
      signal
    )
  }

  private static createAbortedExecuteResponse(): ExecuteResponse {
    return {
      output: "<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n<no output>",
      exitCode: 130,
      truncated: false
    }
  }

  private static readonly SIGKILL_TIMEOUT_MS = 200
  /** Max time (ms) to wait for stdout/stderr to drain after killing a process (matches Codex IO_DRAIN_TIMEOUT_MS). */
  private static readonly IO_DRAIN_TIMEOUT_MS = 2_000
  private static readonly TIMEOUT_METADATA_SENTINEL = "execute tool killed"
  private static readonly TIMEOUT_METADATA_REASON = "exceeding timeout"
  // 40 chars is roughly one short output line; meaningful command logs should exceed this.
  private static readonly SPARSE_TIMEOUT_OUTPUT_MAX_CHARS = 40

  private static createTimeoutMetadata(timeoutMs: number): string {
    return [
      "<execute_metadata>",
      `${LocalSandbox.TIMEOUT_METADATA_SENTINEL} the running process and terminated command after ${LocalSandbox.TIMEOUT_METADATA_REASON} ${(timeoutMs / 1000).toFixed(1)}s`,
      "</execute_metadata>",
      "",
      ""
    ].join("\n")
  }

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
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true
        })
        killer.once("exit", () => res())
        killer.once("error", () => res())
      })
      return
    }

    try {
      console.log(`[LocalSandbox] killTree: SIGTERM → pid=${pid}`)
      process.kill(-pid, "SIGTERM")
    } catch {
      try {
        proc.kill("SIGTERM")
      } catch {
        /* already exited */
      }
    }
    await new Promise<void>((res) => setTimeout(res, LocalSandbox.SIGKILL_TIMEOUT_MS))
    if (!exited()) {
      console.log(
        `[LocalSandbox] killTree: SIGKILL → pid=${pid} (not exited after ${LocalSandbox.SIGKILL_TIMEOUT_MS}ms)`
      )
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          proc.kill("SIGKILL")
        } catch {
          /* already exited */
        }
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
  private static backgroundTasks = new Map<
    string,
    {
      id: string
      threadId: string
      command: string
      cwd: string
      startedAt: number
      completed: boolean
      outputChunks: string[]
      abortController: AbortController
      result?: ExecuteResponse
    }
  >()

  /**
   * Execute a command in the background — returns immediately with the task-output prompt.
   * The command runs asynchronously with a long timeout.
   * Use `getTaskOutput(taskId)` to retrieve the result or check progress.
   */
  async executeBackground(command: string, cwd?: string): Promise<string> {
    const requestedCwd = this.resolveExecutionCwd(cwd)
    const toolArgs = { command, run_in_background: true, cwd: requestedCwd }
    const preResult = await this.runPreToolUseHookForTool("execute", toolArgs)
    if (preResult?.blocked || preResult?.decision === "block") {
      return `[Hook blocked] ${preResult.stdout || preResult.reason || "execute was blocked by a hook"}`
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput(toolArgs, preResult?.updatedInput)
    const effectiveCommand =
      typeof updatedArgs.command === "string" && updatedArgs.command.trim()
        ? updatedArgs.command
        : command
    const effectiveCwd =
      typeof updatedArgs.cwd === "string" && updatedArgs.cwd.trim()
        ? this.resolveExecutionCwd(updatedArgs.cwd)
        : requestedCwd
    const cwdError = this.validateExecutionCwd(effectiveCwd)
    if (cwdError) {
      return `Error: ${cwdError}`
    }
    const safety = assessCommandSafety(effectiveCommand, effectiveCwd, {
      windowsShell:
        process.platform === "win32" && this.windowsSandbox !== "none" ? "powershell" : "unknown",
      enforceGitWorkflowCommitOnly: this.enforceGitWorkflowCommitOnly
    })
    if (safety.level === "forbidden") {
      return `Command forbidden: ${safety.reason}`
    }
    // Read-only enforcement on the EFFECTIVE (post-hook) command: a PreToolUse
    // hook may have rewritten a read-only command into a build/write one.
    if (
      (this.readOnlyShellEnforced || readOnlyShellExecutionContext.getStore() === true) &&
      !isReadOnlyShellCommand(
        effectiveCommand,
        effectiveCwd,
        process.platform === "win32" && this.windowsSandbox !== "none" ? "powershell" : "unknown"
      )
    ) {
      return "execute blocked: this is a read-only agent — only provably read-only commands are allowed (no writes, redirects, mutating commands, or builds/installs). A hook may have rewritten the command into a non-read-only one."
    }
    if (
      (this.readOnlyShellEnforced || readOnlyShellExecutionContext.getStore() === true) &&
      this.commandReadsSensitivePath(effectiveCommand, effectiveCwd)
    ) {
      return "execute blocked: this is a read-only agent — reading sensitive credential directories (~/.ssh, ~/.aws, ~/.kube, ~/.gnupg, …) is not allowed."
    }

    const taskId = randomUUID().slice(0, 8)
    const taskAbortController = new AbortController()
    const task = {
      id: taskId,
      threadId: this.runId,
      command: effectiveCommand,
      cwd: effectiveCwd,
      startedAt: Date.now(),
      completed: false as boolean,
      outputChunks: [] as string[],
      abortController: taskAbortController,
      result: undefined as ExecuteResponse | undefined
    }
    LocalSandbox.backgroundTasks.set(taskId, task)

    // Fire and forget — don't await. Uses extended timeout for background execution.
    // Background tasks use their own AbortController (not the conversation's abortSignal)
    // so they survive conversation switches but can still be cancelled explicitly.
    this.executeRaw(
      effectiveCommand,
      undefined,
      LocalSandbox.BACKGROUND_TIMEOUT_MS,
      taskAbortController.signal,
      { background: true, cwd: effectiveCwd }
    ).then(async rawResult => {
      // Guard: if already completed (e.g. cancelled via cancelBackgroundTasks), don't overwrite.
      if (task.completed) return
      // Background tasks bypass the foreground orchestrator path, but failures that need
      // a sandbox-escape (git metadata writes, piped sub-spawns) still need the user's
      // approval. Route the result back through the orchestrator's bypass check so the
      // approval prompt renders for backgrounded `npm run build` etc. before the task
      // is marked complete and task_output() returns to the agent.
      const result = this.orchestrator
        ? await this.orchestrator.maybeRetryOutsideSandbox(effectiveCommand, effectiveCwd, this.windowsSandbox, rawResult).catch((err) => {
            console.warn(`[LocalSandbox] background bypass check failed for task ${taskId}:`, err)
            return rawResult
          })
        : rawResult
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

    const startedMessage = `Background task started (id: ${taskId}). Use task_output tool with this id to check results later.`
    try {
      return await this.applyPostToolUseHookToText(
        "execute",
        { command: effectiveCommand, run_in_background: true, cwd: effectiveCwd },
        startedMessage
      )
    } catch (error) {
      if (isHookHaltError(error)) {
        taskAbortController.abort()
        task.completed = true
        task.result = {
          output: `Background task ${taskId} cancelled because PostToolUse halted the turn.`,
          exitCode: 130,
          truncated: false
        }
      }
      throw error
    }
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
    cwd?: string
  } | null {
    const task = LocalSandbox.backgroundTasks.get(taskId)
    if (!task) return null
    const elapsedSeconds = Math.round((Date.now() - task.startedAt) / 1000)
    if (!task.completed) {
      return { completed: false, elapsedSeconds, command: task.command, cwd: task.cwd }
    }
    return {
      completed: true,
      output: task.result?.output,
      exitCode: task.result?.exitCode,
      elapsedSeconds
    }
  }

  /**
   * Cancel all running background tasks for a given thread (conversation).
   * Called when the user explicitly stops the current conversation.
   */
  static cancelBackgroundTasks(threadId: string): void {
    for (const [taskId, task] of LocalSandbox.backgroundTasks) {
      if (task.threadId === threadId && !task.completed) {
        console.log(
          `[LocalSandbox] cancelling background task ${taskId} (command: ${task.command}) for thread ${threadId}`
        )
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
        setTimeout(
          () => {
            LocalSandbox.backgroundTasks.delete(taskId)
            console.log(`[LocalSandbox] cancelled background task ${taskId} expired, cleaned up`)
          },
          10 * 60 * 1000
        )
      }
    }
  }

  async execute(command: string, cwd?: string): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return {
        output: "Error: Shell tool expects a non-empty command string.",
        exitCode: 1,
        truncated: false
      }
    }

    console.log(
      `[LocalSandbox] execute: hasOrchestrator=${!!this.orchestrator} sandbox=${this.windowsSandbox}`
    )

    // PreToolUse hook
    const requestedCwd = this.resolveExecutionCwd(cwd)
    const requestedArgs = { command, cwd: requestedCwd }
    const preResult = await this.runPreToolUseHook("execute", requestedArgs)
    if (preResult?.blocked || preResult?.decision === "block") {
      return {
        output: `[Hook blocked] ${preResult.stdout || "execute was blocked by a hook"}`,
        exitCode: 1,
        truncated: false
      }
    }
    const updatedArgs = LocalSandbox.mergeUpdatedInput(requestedArgs, preResult?.updatedInput)
    const effectiveCommand =
      typeof updatedArgs.command === "string" && updatedArgs.command.trim()
        ? updatedArgs.command
        : command
    const effectiveCwd =
      typeof updatedArgs.cwd === "string" && updatedArgs.cwd.trim()
        ? this.resolveExecutionCwd(updatedArgs.cwd)
        : requestedCwd
    const cwdError = this.validateExecutionCwd(effectiveCwd)
    if (cwdError) {
      return {
        output: `Error: ${cwdError}`,
        exitCode: 1,
        truncated: false
      }
    }

    // Always check forbidden commands, even without orchestrator (YOLO mode safety net)
    const safety = assessCommandSafety(effectiveCommand, effectiveCwd, {
      windowsShell:
        process.platform === "win32" && this.windowsSandbox !== "none" ? "powershell" : "unknown",
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
    // Read-only enforcement on the EFFECTIVE (post-hook) command: a PreToolUse
    // hook may have rewritten a read-only command into a build/write one. The
    // runtime's execute tool already gated the agent-issued command, but the
    // rewrite happens here, so re-check after the merge.
    if (
      (this.readOnlyShellEnforced || readOnlyShellExecutionContext.getStore() === true) &&
      !isReadOnlyShellCommand(
        effectiveCommand,
        effectiveCwd,
        process.platform === "win32" && this.windowsSandbox !== "none" ? "powershell" : "unknown"
      )
    ) {
      console.log(`[LocalSandbox] execute: READ-ONLY BLOCKED — ${effectiveCommand}`)
      return {
        output:
          "execute blocked: this is a read-only agent — only provably read-only commands are allowed (no writes, redirects, mutating commands, or builds/installs). A hook may have rewritten the command into a non-read-only one.",
        exitCode: 1,
        truncated: false
      }
    }
    if (
      (this.readOnlyShellEnforced || readOnlyShellExecutionContext.getStore() === true) &&
      this.commandReadsSensitivePath(effectiveCommand, effectiveCwd)
    ) {
      console.log(`[LocalSandbox] execute: SENSITIVE-PATH BLOCKED — ${effectiveCommand}`)
      return {
        output:
          "execute blocked: this is a read-only agent — reading sensitive credential directories (~/.ssh, ~/.aws, ~/.kube, ~/.gnupg, …) is not allowed.",
        exitCode: 1,
        truncated: false
      }
    }

    // If an orchestrator is configured, delegate to it for approval + sandbox retry.
    // The orchestrator calls back into executeRaw() for actual execution.
    if (this.orchestrator) {
      const result = await this.orchestrator.execute(
        effectiveCommand,
        effectiveCwd,
        this.windowsSandbox
      )
      const postResult = await this.runHooks("PostToolUse", {
        toolName: "execute",
        toolArgs: { command: effectiveCommand, cwd: effectiveCwd },
        toolResult: LocalSandbox.formatExecuteResultForHook(result),
        workspacePath: this.workingDir,
        sessionId: this.runId
      })
      return LocalSandbox.applyPostHookToExecResult(result, postResult)
    }

    const result = await this.executeRaw(effectiveCommand, undefined, undefined, undefined, {
      cwd: effectiveCwd
    })
    const postResult = await this.runHooks("PostToolUse", {
      toolName: "execute",
      toolArgs: { command: effectiveCommand, cwd: effectiveCwd },
      toolResult: LocalSandbox.formatExecuteResultForHook(result),
      workspacePath: this.workingDir,
      sessionId: this.runId
    })
    return LocalSandbox.applyPostHookToExecResult(result, postResult)
  }

  /**
   * Render an ExecuteResponse into the same `<output>\n[Command (succeeded|
   * failed) with exit code N]` string deepagents shows the LLM. Two reasons
   * we do this on the hook path:
   *   1. PostToolUse hook commands receive the exit status via
   *      `CLAUDE_TOOL_RESULT` — without the marker they were blind to
   *      success/failure.
   *   2. `detectToolFailure` (PR-12) pattern-matches the marker to fire
   *      `PostToolUseFailure`. Passing just `result.output` slipped every
   *      execute non-zero exit past it. Discovered by hook E2E.
   */
  private static formatExecuteResultForHook(result: ExecuteResponse): string {
    const parts: string[] = [result.output]
    if (result.exitCode !== null) {
      const status = result.exitCode === 0 ? "succeeded" : "failed"
      parts.push(`\n[Command ${status} with exit code ${result.exitCode}]`)
    }
    if (result.truncated) parts.push("\n[Output was truncated due to size limits]")
    return parts.join("")
  }

  /**
   * Raw command execution — no approval logic.
   * Called directly by the orchestrator after approval is granted,
   * or as fallback when no orchestrator is configured.
   */
  private static isBackgroundExecution(
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal,
    options?: ExecuteRawOptions
  ): boolean {
    return options?.background === true
      || (timeoutMs === LocalSandbox.BACKGROUND_TIMEOUT_MS && overrideAbortSignal !== undefined)
  }

  /**
   * Git network operations may invoke Git Credential Manager. In the unsandboxed
   * retry path this must be allowed to show its GUI prompt; otherwise a stale or
   * missing credential can fail without giving the user a chance to re-authenticate.
   */
  private static isGitInteractiveAuthCommand(command: string): boolean {
    return /\bgit(?:\.exe|\.cmd|\.bat)?\s+(?:pull|fetch|push|clone|submodule|lfs)\b/i.test(command)
  }

  private static buildInteractiveGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...env,
      GCM_INTERACTIVE: "auto",
      GCM_GUI_PROMPT: "1",
      GIT_TERMINAL_PROMPT: "1"
    }
  }

  private static windowsPowerShellUtf8Preamble(): string {
    return [
      "chcp 65001 >$null",
      "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
      "$OutputEncoding=[System.Text.Encoding]::UTF8",
      // Prevent PowerShell from treating native stderr as an error record that
      // can mask the native process exit code.
      "$ErrorActionPreference='Continue'",
      "$global:LASTEXITCODE=0"
    ].join("; ")
  }

  private static windowsPowerShellExitCodePostamble(): string {
    return [
      "$__cmbLastSuccess=$?",
      "$__cmbLastExitCode=$LASTEXITCODE",
      "if (-not $__cmbLastSuccess) { if ($__cmbLastExitCode -is [int] -and $__cmbLastExitCode -ne 0) { exit $__cmbLastExitCode }; exit 1 }"
    ].join("; ")
  }

  private static withWindowsShellUtf8Preamble(command: string, shellBase: string): string {
    if (shellBase === "cmd") return `chcp 65001 >nul & ${command}`
    if (shellBase === "pwsh" || shellBase === "powershell") {
      return `${LocalSandbox.windowsPowerShellUtf8Preamble()}; ${command}; ${LocalSandbox.windowsPowerShellExitCodePostamble()}`
    }
    return command
  }

  private static withWindowsExecutionCwdPreamble(
    command: string,
    shellBase: string,
    executionCwd: string,
    sandboxWorkspaceRoot: string
  ): string {
    if (normalizeDirKey(executionCwd) === normalizeDirKey(sandboxWorkspaceRoot)) return command
    if (shellBase === "cmd") {
      return `cd /d "${cmdSetLiteral(executionCwd)}" && (${command})`
    }
    if (shellBase === "pwsh" || shellBase === "powershell") {
      return `Set-Location -LiteralPath ${powershellSingleQuote(executionCwd)} -ErrorAction Stop; ${command}`
    }
    return command
  }

  private isProjectPluginHookCommand(command: string): boolean {
    if (!this.pluginRoot) return false

    const hooksRoot = path.win32
      .normalize(path.win32.join(this.pluginRoot, "hooks"))
      .replace(/\\+$/, "")
      .replace(/\\+/g, "\\")
      .toLowerCase()
    const normalizedCommand = command.replace(/\//g, "\\").replace(/\\+/g, "\\").toLowerCase()
    return normalizedCommand.includes(`${hooksRoot}\\`)
  }

  private async executeRawUnserialized(
    command: string,
    sandboxModeOverride?: string,
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal,
    cwd?: string
  ): Promise<ExecuteResponse> {
    const effectiveSandboxMode = (sandboxModeOverride ?? this.windowsSandbox) as WindowsSandboxMode
    const effectiveTimeout = timeoutMs ?? this.timeout
    const effectiveCwd = this.resolveExecutionCwd(cwd)
    console.log(
      `[LocalSandbox] executeRaw: command="${command}" cwd="${effectiveCwd}" effectiveMode=${effectiveSandboxMode} override=${sandboxModeOverride} timeout=${effectiveTimeout}ms overrideAbort=${!!overrideAbortSignal}`
    )

    if (process.platform === "win32" && effectiveSandboxMode !== "none") {
      const shouldBypassSandboxForProjectPluginHook = this.isProjectPluginHookCommand(command)
      if (this.pluginRoot) {
        console.log(
          `[HarnessMode][LocalSandbox] project plugin hook sandbox bypass check: allowed=${shouldBypassSandboxForProjectPluginHook} mode=${effectiveSandboxMode} pluginRoot="${this.pluginRoot}"`
        )
      }
      if (shouldBypassSandboxForProjectPluginHook) {
        return this.executeRawUnserialized(command, "none", timeoutMs, overrideAbortSignal, effectiveCwd)
      }

      // Commands that need to escape the Windows sandbox (e.g. `git pull` writing .git,
      // `npm run build` spawning esbuild via piped stdio) are no longer auto-routed here.
      // The orchestrator inspects the post-run output, asks the user for permission, and
      // retries with `mode="none"` only after explicit approval — same UX as Codex CLI.
      console.log("[LocalSandbox] -> executeInWindowsSandbox")
      return this.executeInWindowsSandbox(
        command,
        1,
        effectiveSandboxMode,
        effectiveTimeout,
        overrideAbortSignal,
        effectiveCwd
      )
    }

    const isWindows = process.platform === "win32"
    const shell = await LocalSandbox.resolveShell()
    const shellBase = path.basename(shell).replace(/\.exe$/i, "").toLowerCase()
    const isBashLikeShell = ["bash", "sh", "zsh"].includes(shellBase)

    // On Windows, force UTF-8 output using syntax that matches the selected shell.
    // Git Bash output is decoded by collectAndResolve, so leave its command untouched.
    const effectiveCommand = !isWindows || isBashLikeShell
      ? command
      : LocalSandbox.withWindowsShellUtf8Preamble(command, shellBase)

    // On Windows, spawn can transiently fail with EPERM (antivirus file lock, handle
    // contention). Retry up to SPAWN_RETRY_COUNT times with a short delay.
    const maxAttempts = isWindows ? LocalSandbox.SPAWN_RETRY_COUNT + 1 : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.executeOnce(
        effectiveCommand,
        shell,
        isWindows,
        effectiveTimeout,
        overrideAbortSignal,
        effectiveCwd
      )
      const isSpawnEperm =
        result.exitCode === 1 &&
        result.output.startsWith("Error: Failed to execute command:") &&
        result.output.includes("EPERM")
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

  async executeRaw(
    command: string,
    sandboxModeOverride?: string,
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal,
    options?: ExecuteRawOptions
  ): Promise<ExecuteResponse> {
    const effectiveSandboxMode = (sandboxModeOverride ?? this.windowsSandbox) as typeof this.windowsSandbox
    const backgroundExecution = LocalSandbox.isBackgroundExecution(timeoutMs, overrideAbortSignal, options)
    const effectiveCwd = this.resolveExecutionCwd(options?.cwd)
    const cwdError = this.validateExecutionCwd(effectiveCwd)
    if (cwdError) {
      return {
        output: `Error: ${cwdError}`,
        exitCode: 1,
        truncated: false
      }
    }

    if (process.platform !== "win32" || effectiveSandboxMode === "none" || backgroundExecution) {
      return this.executeRawUnserialized(
        command,
        sandboxModeOverride,
        timeoutMs,
        overrideAbortSignal,
        effectiveCwd
      )
    }

    const sandboxWorkspaceRoot = path.resolve(this.workingDir)
    const queueKey = LocalSandbox.buildSerializedExecutionKey(this.runId, sandboxWorkspaceRoot, effectiveSandboxMode)
    const commandConcurrency = classifyCommandConcurrency(command)
    if (commandConcurrency === "parallel_safe") {
      return LocalSandbox.runParallelSafeExecution(queueKey, () =>
        this.executeRawUnserialized(
          command,
          sandboxModeOverride,
          timeoutMs,
          overrideAbortSignal,
          effectiveCwd
        )
      )
    }

    return LocalSandbox.runSerializedExecution(queueKey, () =>
      this.executeRawUnserialized(
        command,
        sandboxModeOverride,
        timeoutMs,
        overrideAbortSignal,
        effectiveCwd
      )
    )
  }

  /**
   * Execute a command inside the Codex Windows sandbox.
   * - unelevated: restricted token + NTFS ACL (workdir writable, network follows host policy)
   * - readonly: read-only filesystem sandbox with outbound network allowed
   * - elevated: dedicated sandbox user + strong ACL isolation; codex.exe manages credentials and ACLs internally
   * Retries on EPERM (antivirus transient lock); reports error on other failures.
   */
  private async executeInWindowsSandbox(
    command: string,
    attempt = 1,
    sandboxModeOverride?: WindowsSandboxMode,
    timeoutMs?: number,
    overrideAbortSignal?: AbortSignal,
    cwd?: string
  ): Promise<ExecuteResponse> {
    const methodStartMs = Date.now()
    const effectiveMode = sandboxModeOverride ?? this.windowsSandbox
    const effectiveAbortSignal = overrideAbortSignal ?? this.abortSignal
    const executionCwd = this.resolveExecutionCwd(cwd)
    const sandboxWorkspaceRoot = path.resolve(this.workingDir)
    // Package install commands (pip, npm, cargo, etc.) often fail in elevated mode due to
    // permission issues with TEMP, site-packages, or certificate stores. Route them directly
    // to unelevated mode to avoid the wasted elevated attempt + fallback retry overhead.
    // Keep Python-dir probing in the background for ordinary commands. shouldPreferUnelevated
    // waits for it only when the command is a direct python/py invocation.
    if (effectiveMode === "elevated" && sandboxModeOverride !== "unelevated") {
      if (await LocalSandbox.shouldPreferUnelevated(command)) {
        console.log("[LocalSandbox] elevated command prefers unelevated sandbox; routing directly to unelevated")
        return this.executeInWindowsSandbox(
          command,
          attempt,
          "unelevated",
          timeoutMs,
          overrideAbortSignal,
          executionCwd
        )
      }
    }

    const isElevatedSandbox = effectiveMode === "elevated"
    const sandboxCacheRoot = await LocalSandbox.raceWithAbort(this._sandboxCacheRootPromise, effectiveAbortSignal)
      .catch((err) => {
        if (LocalSandbox.isAbortError(err)) throw err
        console.warn("[LocalSandbox] failed to resolve canonical sandbox cache root during execute:", err)
        return this._sandboxCacheRoot
      })
    const sandboxCacheRoots = Array.from(new Set([
      sandboxCacheRoot,
      this._sharedSandboxCacheRoot
    ].map((dir) => path.win32.normalize(dir))))
    const executionPlan = LocalSandbox.buildWindowsSandboxExecutionPlan(command, effectiveMode, sandboxCacheRoots)
    executionPlan.writableRoots = Array.from(new Set(executionPlan.writableRoots.map((dir) => path.win32.normalize(dir))))
    const sandboxWritableRoots = Array.from(
      new Set([...executionPlan.writableRoots, executionCwd].map((dir) => path.win32.normalize(dir)))
    )
    const sandboxCacheWritableRootsOverride = sandboxWritableRoots.length > 0
      ? LocalSandbox.buildWritableRootsOverride(sandboxWritableRoots)
      : undefined

    if (isElevatedSandbox) {
      try {
        const sensitivePathError =
          getElevatedSystemSensitivePathError(sandboxWorkspaceRoot) ??
          getElevatedSystemSensitivePathError(executionCwd)
        if (sensitivePathError) {
          return {
            output: sensitivePathError,
            exitCode: 1,
            truncated: false
          }
        }
        if (!(await isElevatedSetupComplete())) {
          return {
            output: "Elevated 沙箱尚未完成初始化。请在设置中手动完成 elevated 配置，或切换到 unelevated/none 后重试。",
            exitCode: 1,
            truncated: false
          }
        }
        void LocalSandbox.prewarmElevatedWorkspaceRoots(sandboxWorkspaceRoot, sandboxWritableRoots).catch((err) => {
          console.warn("[LocalSandbox] elevated background prewarm failed:", err)
        })
        await LocalSandbox.waitForElevatedRootsPrepared(
          sandboxWorkspaceRoot,
          sandboxWritableRoots,
          LocalSandbox.ELEVATED_COMMAND_PREPARE_GRACE_MS,
          effectiveAbortSignal
        )
      } catch (err) {
        if (LocalSandbox.isAbortError(err) || effectiveAbortSignal?.aborted) {
          return LocalSandbox.createAbortedExecuteResponse()
        }
        throw err
      }
    }

    let sandboxCacheDirs: string[] = []
    try {
      sandboxCacheDirs = await LocalSandbox.raceWithAbort(
        LocalSandbox.prepareSandboxCacheDirs(sandboxCacheRoot, this._sharedSandboxCacheRoot),
        effectiveAbortSignal
      )
    } catch (err) {
      if (LocalSandbox.isAbortError(err) || effectiveAbortSignal?.aborted) {
        return LocalSandbox.createAbortedExecuteResponse()
      }
      console.warn("[LocalSandbox] sandbox cache dir prepare failed during execute:", err)
    }

    // Git Bash (MSYS2) crashes under restricted tokens — always use PowerShell/cmd
    console.log(`[LocalSandbox] elevated: pre-setup done at +${Date.now() - methodStartMs}ms, resolving shell...`)
    const { shell, flags: shellFlags } = await LocalSandbox.resolveWindowsSandboxShell()

    // Force UTF-8 for all output streams (stdout + stderr).
    const shellBase = path
      .basename(shell)
      .replace(/\.exe$/i, "")
      .toLowerCase()
    const effectiveCommand = LocalSandbox.withWindowsShellUtf8Preamble(command, shellBase)
    // Unelevated sandbox: codex.exe may inject HTTP_PROXY=127.0.0.1:9 via apply_no_network_to_env
    // when the policy's network_access is false (default). Clear proxy vars in the command preamble
    // so the sandboxed process can access the network normally.
    //
    // Also force git to use the OpenSSL SSL backend instead of the default SChannel (Windows).
    // WRITE_RESTRICTED tokens (used by unelevated sandbox) cannot access the Windows LSA for
    // credential initialization, causing SChannel's AcquireCredentialsHandle to fail with
    // SEC_E_NO_CREDENTIALS even for public HTTPS repos. OpenSSL does not use the Windows
    // Security API and works correctly under restricted tokens.
    // GIT_CONFIG_COUNT/KEY/VALUE injects git config for this invocation only (git ≥ 2.31).
    const clearProxyPreamble = !isElevatedSandbox && effectiveMode !== "none"
      ? (shellBase === "cmd"
          ? 'set "HTTP_PROXY=" & set "HTTPS_PROXY=" & set "ALL_PROXY=" & set "GIT_HTTP_PROXY=" & set "GIT_HTTPS_PROXY=" & set "GIT_SSH_COMMAND=" & set "GIT_ALLOW_PROTOCOLS=" & set "PIP_NO_INDEX=" & set "NPM_CONFIG_OFFLINE=" & set "CARGO_NET_OFFLINE=" & set "SBX_NONET_ACTIVE=" & set "GIT_CONFIG_COUNT=2" & set "GIT_CONFIG_KEY_0=http.sslBackend" & set "GIT_CONFIG_VALUE_0=openssl" & set "GIT_CONFIG_KEY_1=safe.directory" & set "GIT_CONFIG_VALUE_1=*"'
          : '$env:HTTP_PROXY=$null; $env:HTTPS_PROXY=$null; $env:ALL_PROXY=$null; $env:GIT_HTTP_PROXY=$null; $env:GIT_HTTPS_PROXY=$null; $env:GIT_SSH_COMMAND=$null; $env:GIT_ALLOW_PROTOCOLS=$null; $env:PIP_NO_INDEX=$null; $env:NPM_CONFIG_OFFLINE=$null; $env:CARGO_NET_OFFLINE=$null; $env:SBX_NONET_ACTIVE=$null; $env:GIT_CONFIG_COUNT=\'2\'; $env:GIT_CONFIG_KEY_0=\'http.sslBackend\'; $env:GIT_CONFIG_VALUE_0=\'openssl\'; $env:GIT_CONFIG_KEY_1=\'safe.directory\'; $env:GIT_CONFIG_VALUE_1=\'*\'')
      : ""
    // Unelevated sandbox: set shared tool env vars to the persistent writable cache root.
    const unelevatedJvmPreamble = !isElevatedSandbox && effectiveMode !== "none"
      ? LocalSandbox.buildUnelevatedEnvPreamble(shellBase, sandboxCacheRoot, this._sharedSandboxCacheRoot)
      : ""
    const unelevatedPreamble = [clearProxyPreamble, unelevatedJvmPreamble].filter(Boolean).join(shellBase === "cmd" ? " & " : "; ")
    const sandboxUserEnvPreamble = isElevatedSandbox
      ? LocalSandbox.buildElevatedSandboxEnvPreamble(shellBase, sandboxCacheRoot, this._sharedSandboxCacheRoot, this.env)
      : unelevatedPreamble
    const commandWithSandboxEnv = sandboxUserEnvPreamble
      ? shellBase === "cmd"
        ? `${sandboxUserEnvPreamble} & ${effectiveCommand}`
        : `${sandboxUserEnvPreamble}; ${effectiveCommand}`
      : effectiveCommand
    const commandWithExecutionCwd = LocalSandbox.withWindowsExecutionCwdPreamble(
      commandWithSandboxEnv,
      shellBase,
      executionCwd,
      sandboxWorkspaceRoot
    )

    const isReadonly = effectiveMode === "readonly"
    const elevated = isReadonly ? await LocalSandbox.getElevationState() : false

    // elevated: dedicated sandbox user, codex.exe handles the isolation internally
    // readonly + admin: grant full read + cwd write so admin can work in workspace
    // readonly + non-admin: read only, all writes blocked
    // unelevated/elevated: workdir/cache writes are controlled by explicit
    // windows.sandbox + sandbox_workspace_write config and ACLs. Do not pass
    // --full-auto here: Node spawn resolves the packaged codex.exe directly,
    // where that alias is rejected in this argument layout on Windows.
    let sandboxArgs: string[]
    if (isElevatedSandbox) {
      // -c is a global flag and must come before the "sandbox" subcommand
      sandboxArgs = [
        "-c",
        'windows.sandbox="elevated"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(sandboxCacheWritableRootsOverride ? ["-c", sandboxCacheWritableRootsOverride] : []),
        "sandbox",
        "windows",
        "--",
        shell,
        ...shellFlags,
        commandWithExecutionCwd
      ]
    } else if (isReadonly) {
      sandboxArgs = elevated
        ? [
            "-c",
            'sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }',
            "-c",
            'sandbox_permissions=["disk-full-read-access","disk-write-cwd"]',
            "sandbox",
            "windows",
            "--",
            shell,
            ...shellFlags,
            commandWithExecutionCwd
          ]
        : [
            "-c",
            'sandbox_policy={ type = "read-only", access = { type = "full-access" }, network_access = true }',
            "-c",
            'sandbox_permissions=["disk-full-read-access"]',
            "sandbox",
            "windows",
            "--",
            shell,
            ...shellFlags,
            commandWithExecutionCwd
          ]
    } else {
      sandboxArgs = [
        "-c",
        'windows.sandbox="unelevated"',
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(sandboxCacheWritableRootsOverride ? ["-c", sandboxCacheWritableRootsOverride] : []),
        "sandbox",
        "windows",
        "--",
        shell,
        ...shellFlags,
        commandWithExecutionCwd
      ]
    }

    // Elevated sandbox manages its own ACLs internally — skip manual icacls grants.
    // For other modes: ACL grant/revoke needed for unelevated and readonly+admin.
    const aclDirs: string[] = []
    if (!isElevatedSandbox) {
      if (!isReadonly || elevated) {
        aclDirs.push(sandboxWorkspaceRoot, executionCwd)
      }
      // TEMP is granted once and marked permanent — never revoked because it's a public
      // temp directory. This avoids 2 icacls spawns (grant + revoke) per command.
      // Also pre-create sandbox subdirectories and ACL them explicitly — the restricted
      // token's default DACL for newly created objects may not include write permission,
      // causing pip/Maven/etc. to fail with PermissionError even though the parent TEMP
      // has inheritable (OI)(CI)(M). By creating and ACL-ing these dirs from the main
      // process (full token), we guarantee the restricted token can write inside them.
      const tmpDir = process.env.TEMP || process.env.TMP
      if (tmpDir) {
        const tmpKey = normalizeDirKey(tmpDir)
        if (!LocalSandbox._permanentAclDirs.has(tmpKey)) {
          aclDirs.push(tmpDir)
          LocalSandbox._permanentAclDirs.add(tmpKey)
        }
      }
      // Pre-create app-owned persistent cache subdirectories from the main process
      // (full permissions) so package managers can write caches/user installs there.
      for (const cachePath of Array.from(new Set([...sandboxCacheDirs, ...executionPlan.writableRoots]))) {
        const cacheKey = normalizeDirKey(cachePath)
        let permanentAcl = true
        try {
          permanentAcl = (await fs.stat(cachePath)).isDirectory()
        } catch {
          permanentAcl = true
        }
        if (!permanentAcl || !LocalSandbox._permanentAclDirs.has(cacheKey)) {
          aclDirs.push(cachePath)
          if (permanentAcl) {
            LocalSandbox._permanentAclDirs.add(cacheKey)
          }
        }
      }
      const aclGrantStart = Date.now()
      await mapLimit(
        aclDirs,
        LocalSandbox.ACL_OPERATION_CONCURRENCY,
        (dir) => LocalSandbox.grantSandboxWriteAcl(dir, this.runId)
      )
      console.log(`[LocalSandbox] ACL grant took ${Date.now() - aclGrantStart}ms for ${aclDirs.length} dirs`)
    }

    const execStartMs = Date.now()
    try {
      // Early return if already aborted — avoid a potentially slow buildSandboxEnv
      // just to immediately discard the result.
      if (effectiveAbortSignal?.aborted) {
        return LocalSandbox.createAbortedExecuteResponse()
      }
      const sandboxEnv = await LocalSandbox.buildSandboxEnv(this.env)
      const result = await new Promise<ExecuteResponse>((resolve) => {
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let totalBytes = 0
        let resolved = false
        let exited = false
        let firstDataAt = 0
        let windowsExitTimerId: ReturnType<typeof setTimeout> | null = null
        let timedOut = false
        let aborted = false
        let drainTimerId: ReturnType<typeof setTimeout> | null = null

        if (effectiveAbortSignal?.aborted) {
          resolve(LocalSandbox.createAbortedExecuteResponse())
          return
        }

        console.log(`[LocalSandbox] spawn: ${this.codexExePath} ${JSON.stringify(sandboxArgs)}`)
        console.log(`[LocalSandbox] sandbox cwd: ${sandboxWorkspaceRoot}`)
        console.log(`[LocalSandbox] command cwd: ${executionCwd}`)

        const proc = spawn(this.codexExePath, sandboxArgs, {
          cwd: sandboxWorkspaceRoot,
          env: sandboxEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        })

        console.log(`[LocalSandbox] spawned pid=${proc.pid} at +${Date.now() - execStartMs}ms`)
        if (!proc.pid) {
          console.warn(`[LocalSandbox] WARNING: spawn returned no pid — process may not have started`)
        }
        LocalSandbox.activeProcesses.add(proc)

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
          if (!firstDataAt) {
            firstDataAt = Date.now()
            console.log(`[LocalSandbox] first data at +${firstDataAt - execStartMs}ms pid=${proc.pid}`)
          }
          if (totalBytes < this.maxOutputBytes) {
            stdoutChunks.push(chunk)
            totalBytes += chunk.length
          }
        })

        proc.stderr?.on("data", (chunk: Buffer) => {
          if (!firstDataAt) {
            firstDataAt = Date.now()
            console.log(`[LocalSandbox] first data at +${firstDataAt - execStartMs}ms pid=${proc.pid}`)
          }
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
            const enc = this.detectCmdEncoding(LocalSandbox.encodingDetectionBuffer(stdoutBuf, stderrBuf))

            let output = ""
            if (stdoutBuf.length > 0) output += iconv.decode(stdoutBuf, enc)
            if (stderrBuf.length > 0) {
              const errText = iconv.decode(stderrBuf, enc)
                .split("\n")
                .filter((line) => line.length > 0)
                .map((line) => `[stderr] ${line}`)
                .join("\n")
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
              const metadata = LocalSandbox.createTimeoutMetadata(cmdTimeout)
              resolve({ output: metadata + output, exitCode: 124, truncated })
            } else {
              resolve({ output, exitCode: signal ? null : code, truncated })
            }
          } catch (err) {
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
              `[LocalSandbox] codex.exe EPERM attempt ${attempt}/${LocalSandbox.SPAWN_RETRY_COUNT + 1}, retrying in ${LocalSandbox.SPAWN_RETRY_DELAY_MS}ms...`
            )
            setTimeout(() => {
              resolve(
                this.executeInWindowsSandbox(
                  command,
                  attempt + 1,
                  sandboxModeOverride,
                  timeoutMs,
                  overrideAbortSignal,
                  executionCwd
                )
              )
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

    if (isElevatedSandbox && result.exitCode !== 0 && result.output.includes("setup refresh failed")) {
      console.warn(`[LocalSandbox] elevated: setup refresh failed for ${sandboxWorkspaceRoot}, scheduling background prewarm`)
      void LocalSandbox.prewarmElevatedWorkspaceRoots(sandboxWorkspaceRoot, sandboxWritableRoots).catch((err) => {
        console.warn("[LocalSandbox] elevated background prewarm after refresh failure failed:", err)
      })
      return {
        output: `${result.output}\n\n[Sandbox] 命令执行不会自动弹出 UAC 授权重建沙箱权限。后台已尝试预热当前工作区；如仍失败，请在设置中手动完成 elevated 配置，或切换到 unelevated/none 后重试。`,
        exitCode: result.exitCode ?? 1,
        truncated: result.truncated
      }
    }

    // Git metadata sandbox-failure no longer auto-retries here — the orchestrator owns
    // the fail → prompt-user → retry-outside loop so the user can grant permission per-call.

    if (
      isElevatedSandbox
      && result.exitCode !== 0
      && sandboxModeOverride !== "unelevated"
      && !LocalSandbox.isGitInteractiveAuthCommand(command)
      && LocalSandbox.shouldFallbackToUnelevatedForNetworkAuth(result.output)
    ) {
      // Auto-fallback to unelevated mode: elevated sandbox user lacks enterprise network
      // credentials (Kerberos/NTLM), so commands accessing corporate repos (Maven, npm, etc.)
      // will fail. Retry with unelevated sandbox which inherits the real user's credentials.
      console.warn("[LocalSandbox] elevated network auth failed; auto-retrying with unelevated sandbox")
      return this.executeInWindowsSandbox(
        command,
        1,
        "unelevated",
        timeoutMs,
        overrideAbortSignal,
        executionCwd
      )
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
    overrideAbortSignal?: AbortSignal,
    cwd?: string
  ): Promise<ExecuteResponse> {
    const onceStartMs = Date.now()
    const effectiveCwd = this.resolveExecutionCwd(cwd)
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
        resolve({
          output:
            "<execute_metadata>\nUser aborted the command, process has been killed\n</execute_metadata>\n\n<no output>",
          exitCode: 130,
          truncated: false
        })
        return
      }

      const shellBase = path.basename(shell).replace(/\.exe$/i, "")
      const isBashOnWin = isWindows && ["bash", "sh", "zsh"].includes(shellBase)
      const allowInteractiveGitAuth =
        isWindows && LocalSandbox.isGitInteractiveAuthCommand(command)
      const spawnEnv = allowInteractiveGitAuth
        ? LocalSandbox.buildInteractiveGitEnv(this.env)
        : this.env

      const proc = isBashOnWin
        ? spawn(shell, [], {
            cwd: effectiveCwd,
            env: spawnEnv,
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
            windowsHide: !allowInteractiveGitAuth
          })
        : spawn(command, {
            shell,
            cwd: effectiveCwd,
            env: spawnEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: !isWindows,
            windowsHide: !allowInteractiveGitAuth
          })

      if (isBashOnWin && proc.stdin) {
        proc.stdin.on("error", () => {
          /* swallow: proc 'error'/'close' handles it */
        })
        proc.stdin.write(command + "\n")
        proc.stdin.end()
      }

      console.log(
        `[LocalSandbox] executeOnce: spawned pid=${proc.pid} shell=${shellBase} at +${Date.now() - onceStartMs}ms`
      )
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
        if (!firstDataAt) {
          firstDataAt = Date.now()
          console.log(
            `[LocalSandbox] first data at +${firstDataAt - onceStartMs}ms pid=${proc.pid}`
          )
        }
        if (byteCapReached) return
        stdoutChunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= this.maxOutputBytes) byteCapReached = true
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        if (!firstDataAt) {
          firstDataAt = Date.now()
          console.log(
            `[LocalSandbox] first data at +${firstDataAt - onceStartMs}ms pid=${proc.pid}`
          )
        }
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
          console.log(
            `[LocalSandbox] collectAndResolve: pid=${proc.pid}, reason=${reason}, code=${code}, signal=${signal}, elapsed=${elapsed}ms, bytes=${totalBytes}`
          )
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
            ? this.detectCmdEncoding(LocalSandbox.encodingDetectionBuffer(stdoutBuf, stderrBuf))
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
            const metadata = LocalSandbox.createTimeoutMetadata(cmdTimeout)
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
          console.log(
            `[LocalSandbox] event=exit pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - onceStartMs}ms resolved=${resolved}`
          )
          exited = true
          windowsExitTimerId = setTimeout(() => {
            collectAndResolve(code, signal as string | null)
          }, 500)
        })
      }

      proc.on("close", (code, signal) => {
        console.log(
          `[LocalSandbox] event=close pid=${proc.pid} code=${code} signal=${signal} at +${Date.now() - onceStartMs}ms resolved=${resolved}`
        )
        exited = true
        collectAndResolve(code, signal as string | null)
      })

      proc.on("error", (err) => {
        console.log(
          `[LocalSandbox] event=error pid=${proc.pid} err=${(err as Error).message} at +${Date.now() - onceStartMs}ms resolved=${resolved}`
        )
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
