/**
 * Command safety policy engine.
 *
 * Classifies shell commands into safe / needs_approval / forbidden categories
 * based on pattern matching. Modelled after codex-rs is_known_safe_command()
 * and command_might_be_dangerous().
 */

import { realpathSync } from "node:fs"
import path from "node:path"
import type { ExecSafetyLevel } from "../types"
import { isGitRepositoryOverrideEnvironmentVariable } from "../services/git-environment"
import type { WorkflowWorktreeIsolationBoundary } from "./workflow/types"
import {
  isKnownSafeWindowsCommand,
  isReadOnlyWindowsCommand,
  type WindowsShellKind
} from "./windows-safe-commands"
import {
  BUILD_TOOL_EXECUTABLES,
  isReadOnlyBuildToolInvocation,
  hasUnsafeWriteFlag
} from "./read-only-build-tool"

export interface SafetyAssessment {
  level: ExecSafetyLevel
  reason?: string
}

export type CommandConcurrencyClassification = "parallel_safe" | "exclusive"

const APPROVAL_PREFIX_RULE_PREFIX = "prefix:"
const WORKTREE_NESTED_REPOSITORY_READ_ONLY = "nested repositories are read-only"

const SAFE_EXECUTABLES = new Set([
  "base64",
  "cat",
  "cd",
  "cut",
  "dir",
  "echo",
  "expr",
  "false",
  "file",
  "grep",
  "head",
  "hostname",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "printf",
  "rev",
  "seq",
  "sort",
  "stat",
  "tail",
  "tr",
  "tree",
  "true",
  "uname",
  "uniq",
  "wc",
  "where",
  "which",
  "whoami",
  "type",
  "comm",
  "date",
  "diff",
  "printenv",
  // Windows diagnostic commands (read-only)
  "ipconfig",
  "netstat",
  "netsh",
  "systeminfo",
  "tasklist",
  "findstr",
  "nslookup",
  "ping",
  "tracert",
  "pathping",
  "route",
  "arp",
  "getmac",
  "ver"
])

const PARALLEL_SAFE_EXECUTABLES = new Set([
  "cat",
  "comm",
  "cut",
  "df",
  "diff",
  "dir",
  "du",
  "echo",
  "expr",
  "false",
  "file",
  "findstr",
  "getmac",
  "grep",
  "head",
  "id",
  "ls",
  "netstat",
  "nl",
  "paste",
  "pathping",
  "ping",
  "printenv",
  "printf",
  "pwd",
  "rev",
  "seq",
  "stat",
  "systeminfo",
  "tail",
  "tasklist",
  "tr",
  "tracert",
  "tree",
  "true",
  "type",
  "uname",
  "uniq",
  "ver",
  "wc",
  "where",
  "which",
  "whoami",
  // Common read-only PowerShell cmdlets and aliases.
  "compare-object",
  "fl",
  "format-list",
  "format-table",
  "ft",
  "gc",
  "gci",
  "get-childitem",
  "get-command",
  "get-content",
  "get-date",
  "get-item",
  "get-location",
  "get-process",
  "get-service",
  "gl",
  "gps",
  "measure-object",
  "select-string",
  "sort-object",
  "where-object"
])

const UNSAFE_FIND_OPTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf"
])

const UNSAFE_RIPGREP_FLAGS = new Set(["--search-zip", "-z"])
const UNSAFE_RIPGREP_FLAGS_WITH_VALUES = ["--pre", "--hostname-bin"]
const UNSAFE_GIT_FLAGS = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"])
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree"
])

const SIDE_EFFECTING_POWERSHELL_CMDLETS = new Set([
  "set-content",
  "add-content",
  "out-file",
  "new-item",
  "remove-item",
  "move-item",
  "copy-item",
  "rename-item",
  "start-process",
  "stop-process"
])

const BANNED_PERSISTENT_PREFIXES: string[][] = [
  ["python3"],
  ["python3", "-"],
  ["python3", "-c"],
  ["python"],
  ["python", "-"],
  ["python", "-c"],
  ["py"],
  ["py", "-3"],
  ["pythonw"],
  ["pyw"],
  ["pypy"],
  ["pypy3"],
  ["git"],
  ["bash"],
  ["bash", "-lc"],
  ["sh"],
  ["sh", "-c"],
  ["sh", "-lc"],
  ["zsh"],
  ["zsh", "-lc"],
  ["pwsh"],
  ["pwsh", "-command"],
  ["pwsh", "-c"],
  ["powershell"],
  ["powershell", "-command"],
  ["powershell", "-c"],
  ["powershell.exe"],
  ["powershell.exe", "-command"],
  ["powershell.exe", "-c"],
  ["env"],
  ["sudo"],
  ["node"],
  ["node", "-e"],
  ["perl"],
  ["perl", "-e"],
  ["ruby"],
  ["ruby", "-e"],
  ["php"],
  ["php", "-r"],
  ["lua"],
  ["lua", "-e"]
]

const PERSISTABLE_EXECUTABLES = new Set([
  // Build tools & package managers
  "bun",
  "cargo",
  "cmake",
  "go",
  "gradle",
  "gradlew",
  "java",
  "javac",
  "make",
  "mvn",
  "npm",
  "npx",
  "pnpm",
  "poetry",
  "pip",
  "pip3",
  "pytest",
  "uv",
  "yarn",
  "dotnet",
  "msbuild",
  "ant",
  // Version control
  "git",
  "svn",
  // Common dev tools
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "rustc",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "docker",
  "docker-compose",
  "kubectl",
  "curl",
  "wget",
  // Shell utilities (read-only / safe)
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "find",
  "grep",
  "rg",
  "awk",
  "sed",
  "wc",
  "sort",
  "uniq",
  "diff",
  "tree",
  "file",
  "which",
  "where",
  "echo",
  "pwd",
  "env",
  "printenv",
  "whoami",
  "hostname",
  "date",
  "df",
  "du",
  // Windows-specific
  "type",
  "findstr",
  "icacls",
  "net",
  "sc",
  "tasklist",
  "systeminfo"
])

// ── Forbidden patterns ───────────────────────────────────────────────────────
// These are extremely dangerous and should never be auto-approved.

interface ForbiddenPattern {
  pattern: RegExp
  reason: string
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  // NOTE: git commit/push/merge are intentionally NOT forbidden. The agent may run
  // them; `git commit` is intercepted by ToolOrchestrator (see isGitCommitCommand)
  // and routed through the task-card commit dialog, while push/merge fall through to
  // the normal needs_approval flow. Force-push remains gated via DANGEROUS_INDICATORS.
  // Unix
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, reason: "rm -rf / is extremely dangerous" },
  { pattern: /\bmkfs\b/, reason: "mkfs formats disk partitions" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "dd to device can destroy data" },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: "format erases disk" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system power control" },
  { pattern: /\bdel\s+\/s\s+\/q\s+[a-zA-Z]:\\/, reason: "recursive delete on drive root" },
  { pattern: /\brmdir\s+\/s\s+\/q\s+[a-zA-Z]:\\/, reason: "recursive rmdir on drive root" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: "piping remote script to shell" },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh\b/, reason: "piping remote script to shell" },
  { pattern: /\b:(){ :\|:& };:/, reason: "fork bomb" },
  // PowerShell — drive root destruction
  {
    pattern: /\bRemove-Item\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i,
    reason: "PowerShell recursive delete on drive root"
  },
  {
    pattern: /\bRemove-Item\s+.*[a-zA-Z]:\\\*?.*-Recurse\b/i,
    reason: "PowerShell recursive delete on drive root"
  },
  {
    pattern: /\bri\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i,
    reason: "PowerShell recursive delete on drive root (alias)"
  },
  {
    pattern: /\bdel\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i,
    reason: "PowerShell recursive delete on drive root (alias)"
  },
  // PowerShell — disk format
  { pattern: /\bFormat-Volume\b/i, reason: "PowerShell formats disk volume" },
  { pattern: /\bClear-Disk\b/i, reason: "PowerShell clears disk" },
  // PowerShell — remote script execution
  {
    pattern: /\bInvoke-Expression\b.*\bInvoke-WebRequest\b/i,
    reason: "PowerShell downloads and executes remote script"
  },
  {
    pattern: /\biex\b.*\biwr\b/i,
    reason: "PowerShell downloads and executes remote script (alias)"
  },
  {
    pattern: /\bInvoke-Expression\b.*\bInvoke-RestMethod\b/i,
    reason: "PowerShell downloads and executes remote script"
  },
  {
    pattern: /\biex\b.*\birm\b/i,
    reason: "PowerShell downloads and executes remote script (alias)"
  },
  // PowerShell — system control
  { pattern: /\bStop-Computer\b/i, reason: "PowerShell shuts down computer" },
  { pattern: /\bRestart-Computer\b/i, reason: "PowerShell restarts computer" }
]

// ── Dangerous indicators ─────────────────────────────────────────────────────
// These patterns are not outright forbidden but warrant user review.

interface DangerousIndicator {
  pattern: RegExp
  reason: string
}

const DANGEROUS_INDICATORS: DangerousIndicator[] = [
  // Unix
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: "recursive file deletion" },
  { pattern: /\brm\s+-[a-zA-Z]*f/, reason: "forced file deletion" },
  { pattern: /\bgit\s+push\s+--force/, reason: "force push can rewrite history" },
  { pattern: /\bgit\s+push\s+-f\b/, reason: "force push can rewrite history" },
  { pattern: /\bgit\s+reset\s+--hard/, reason: "hard reset discards uncommitted changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "git clean removes untracked files" },
  { pattern: /\bnpm\s+publish\b/, reason: "publishes package to registry" },
  { pattern: /\bcurl\s+.*-X\s*(DELETE|PUT|POST)/, reason: "mutating HTTP request" },
  { pattern: /\bchmod\s+777\b/, reason: "overly permissive file permissions" },
  { pattern: /\bchown\b/, reason: "changes file ownership" },
  { pattern: /\bnet\s+user\b/, reason: "Windows user management" },
  { pattern: /\breg\s+(add|delete)\b/i, reason: "Windows registry modification" },
  { pattern: /\bicacls\b.*\/grant/, reason: "modifies file ACLs" },
  { pattern: /\btakeown\b/, reason: "takes ownership of files" },
  { pattern: /\bsudo\b/, reason: "elevated privilege execution" },
  { pattern: /\bkill\s+-9\b/, reason: "force-kills a process" },
  { pattern: /\bdocker\s+rm\b/, reason: "removes Docker container" },
  { pattern: /\bdocker\s+rmi\b/, reason: "removes Docker image" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "writes directly to block device" },
  { pattern: /\bdrop\s+(table|database)\b/i, reason: "SQL destructive operation" },
  // PowerShell — destructive
  { pattern: /\bRemove-Item\b.*-Recurse\b/i, reason: "PowerShell recursive deletion" },
  { pattern: /\bRemove-Item\b.*-Force\b/i, reason: "PowerShell forced deletion" },
  { pattern: /\bri\s+.*-Recurse\b/i, reason: "PowerShell recursive deletion (alias)" },
  { pattern: /\bStop-Process\b.*-Force\b/i, reason: "PowerShell force-kills process" },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: "changes PowerShell script execution policy" },
  // PowerShell — user/ACL management
  { pattern: /\bNew-LocalUser\b/i, reason: "PowerShell creates local user" },
  { pattern: /\bRemove-LocalUser\b/i, reason: "PowerShell removes local user" },
  { pattern: /\bSet-Acl\b/i, reason: "PowerShell modifies file ACLs" },
  // PowerShell — network/remote
  {
    pattern: /\bInvoke-WebRequest\b.*-Method\s+(Post|Put|Delete)\b/i,
    reason: "PowerShell mutating HTTP request"
  },
  {
    pattern: /\bInvoke-RestMethod\b.*-Method\s+(Post|Put|Delete)\b/i,
    reason: "PowerShell mutating HTTP request"
  },
  { pattern: /\bInvoke-Expression\b/i, reason: "PowerShell dynamic code execution" },
  { pattern: /\biex\b/i, reason: "PowerShell dynamic code execution (alias)" },
  // Script execution — can contain arbitrary dangerous code
  { pattern: /\bnode\s+-e\b/, reason: "Node.js inline code execution" },
  { pattern: /\bnode\s+--eval\b/, reason: "Node.js inline code execution" },
  { pattern: /\bpython[3]?\s+-c\b/, reason: "Python inline code execution" }
]

/**
 * Assess whether a command is safe, needs approval, or is forbidden.
 *
 * Order of checks:
 *   1. Forbidden patterns (full string) — always checked first
 *   2. Dangerous indicators (full string) — checked before safe to prevent
 *      chained-command bypass (e.g. "echo ok && git push --force")
 *   3. Provably read-only command — only if no control operators or redirection
 *      are present, to prevent "safe-command && dangerous-command" bypass
 *   4. Default: needs_approval
 */
export function assessCommandSafety(
  command: string,
  _cwd: string,
  options?: {
    windowsShell?: WindowsShellKind
    enforceGitWorkflowCommitOnly?: boolean
    /** Isolated worktrees use native Git rather than the ordinary task-card
     * commit router. Keep the general safety policy, but do not reject standard
     * Git syntax merely because that router cannot reproduce it. */
    nativeGitWorktree?: boolean
    shellSyntax?: CommandShellSyntax
  }
): SafetyAssessment {
  const trimmed = command.trim()
  const shellSyntax = options?.shellSyntax ?? hostShellSyntax()
  if (!trimmed) {
    return { level: "safe" }
  }

  if (
    !options?.nativeGitWorktree &&
    options?.enforceGitWorkflowCommitOnly &&
    containsDirectGitSubmitCommand(trimmed, shellSyntax)
  ) {
    return {
      level: "forbidden",
      reason:
        "git_workflow tool is available — use git_workflow instead of direct git add/commit/push"
    }
  }

  if (!options?.nativeGitWorktree && containsEnvSplitStringOption(trimmed, shellSyntax)) {
    return {
      level: "forbidden",
      reason: "env split-string execution is not supported because it can hide a git commit"
    }
  }

  if (!options?.nativeGitWorktree && containsForceGitAddCommand(trimmed, 0, shellSyntax)) {
    return {
      level: "forbidden",
      reason:
        "forced git add can override .gitignore — use git commit with explicit Git-reported paths"
    }
  }

  if (!options?.nativeGitWorktree && containsDirectGitIndexPlumbing(trimmed, shellSyntax)) {
    return {
      level: "forbidden",
      reason:
        "direct Git index/ref plumbing can bypass .gitignore and the task-card commit workflow"
    }
  }

  if (!options?.nativeGitWorktree && containsPotentialGitAliasInvocation(trimmed, shellSyntax)) {
    return {
      level: "forbidden",
      reason:
        "Git aliases cannot be inspected safely and may hide a commit — use an explicit built-in git command"
    }
  }

  if (!options?.nativeGitWorktree && containsWrappedGitCommitCommand(trimmed, 0, shellSyntax)) {
    return {
      level: "forbidden",
      reason:
        "wrapped git commit commands are not supported — run git commit directly so the task-card dialog can enforce CMB formatting"
    }
  }

  // 1. Check forbidden patterns first
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: "forbidden", reason }
    }
  }

  // 2. Check for dangerous indicators BEFORE safe prefix
  //    (prevents "safe-prefix && dangerous-command" bypass)
  for (const { pattern, reason } of DANGEROUS_INDICATORS) {
    if (pattern.test(trimmed)) {
      return { level: "needs_approval", reason }
    }
  }

  const windowsSafe =
    process.platform === "win32" &&
    isKnownSafeWindowsCommand(trimmed, options?.windowsShell ?? "unknown")
  if (windowsSafe) {
    return { level: "safe" }
  }

  // 3. Check if command is provably read-only. Anything involving shell
  //    control operators or redirection is reviewed instead of auto-approved.
  const hasShellMetacharacters = /&&|\|\||[|;&`<>]|\$\(|\n/.test(trimmed)
  if (!hasShellMetacharacters && isKnownSafeCommand(trimmed)) {
    return { level: "safe" }
  }

  // 4. Default: needs approval (unknown commands are not auto-approved)
  return {
    level: "needs_approval",
    reason: hasShellMetacharacters
      ? "complex shell expression — requires review"
      : "unknown command — requires review"
  }
}

export function classifyCommandConcurrency(command: string): CommandConcurrencyClassification {
  const trimmed = command.trim()
  if (!trimmed) {
    return "parallel_safe"
  }

  if (FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(trimmed))) {
    return "exclusive"
  }
  if (DANGEROUS_INDICATORS.some(({ pattern }) => pattern.test(trimmed))) {
    return "exclusive"
  }

  // Only single, parseable read-only commands are allowed to overlap. Shell
  // composition and redirection make resource usage too hard to reason about.
  if (/&&|\|\||[|;&`<>]|\$\(|\n/.test(trimmed)) {
    return "exclusive"
  }

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) {
    return "exclusive"
  }

  if (
    tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))
  ) {
    return "exclusive"
  }

  for (const token of tokens) {
    const normalized = token
      .trim()
      .replace(/^[('"]+|[)'"]+$/g, "")
      .replace(/^-+/, "")
      .toLowerCase()
    if (SIDE_EFFECTING_POWERSHELL_CMDLETS.has(normalized)) {
      return "exclusive"
    }
  }

  const executable = normalizeExecutable(tokens[0])
  if (!executable) {
    return "exclusive"
  }

  // A write/system-change flag (tree -o, diff --output, sort -o, date -s, route
  // add, arp -d, netsh … set, ipconfig /flushdns …) mutates state, so the command
  // must run EXCLUSIVELY — it can't overlap other shared ops even though its
  // executable is otherwise in PARALLEL_SAFE_EXECUTABLES. Mirrors the same check in
  // the auto-approve gate (isKnownSafeCommand) so concurrency and approval agree.
  if (hasUnsafeWriteFlag(executable, tokens)) return "exclusive"

  if (PARALLEL_SAFE_EXECUTABLES.has(executable)) return "parallel_safe"
  if (isSafeBase64(tokens)) return "parallel_safe"
  if (isSafeFind(tokens)) return "parallel_safe"
  if (isSafeRipgrep(tokens)) return "parallel_safe"
  if (isSafeGit(tokens)) return "parallel_safe"
  if (isSafeSed(tokens)) return "parallel_safe"

  return "exclusive"
}

/**
 * Replace single/double-quoted spans with a placeholder so that shell operators or the
 * literal text "git commit" appearing *inside* a string argument (e.g. a commit
 * message or an `echo` payload) are not mistaken for real commands / chaining,
 * while quoted option values such as `git -C "C:/repo path" commit` still count
 * as a value-bearing argument.
 */
export type CommandShellSyntax = "posix" | "powershell" | "cmd"

function hostShellSyntax(): CommandShellSyntax {
  return process.platform === "win32" ? "powershell" : "posix"
}

function isShellQuote(char: string, shellSyntax: CommandShellSyntax): char is "'" | '"' {
  return char === '"' || (char === "'" && shellSyntax !== "cmd")
}

function shellEscapeConsumesNext(
  char: string,
  next: string | undefined,
  quote: "'" | '"' | null,
  shellSyntax: CommandShellSyntax
): boolean {
  if (!next || quote === "'") return false
  if (shellSyntax === "powershell") return char === "`"
  if (shellSyntax === "cmd") return char === "^" && quote === null
  return char === "\\" && backslashEscapesNextChar(next, quote, shellSyntax)
}

function stripQuotedSpans(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string {
  let result = ""
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const next = command[index + 1]
    if (quote) {
      if (shellEscapeConsumesNext(char, next, quote, shellSyntax)) {
        index += next === "\r" && command[index + 2] === "\n" ? 2 : 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (isShellQuote(char, shellSyntax)) {
      quote = char
      result += " __quoted_arg__ "
      continue
    }
    if (shellEscapeConsumesNext(char, next, null, shellSyntax)) {
      if (next === "\r" || next === "\n") {
        index += next === "\r" && command[index + 2] === "\n" ? 2 : 1
        continue
      }
      result += " __escaped_char__ "
      index += 1
      continue
    }
    result += char
  }
  return result
}

const GIT_SUBMIT_SUBCOMMANDS = new Set(["add", "commit", "push", "merge"])
const POSIX_SHELL_WRAPPERS = new Set([
  "ash",
  "bash",
  "csh",
  "dash",
  "fish",
  "ksh",
  "mksh",
  "sh",
  "tcsh",
  "zsh"
])
const POWERSHELL_WRAPPERS = new Set(["pwsh", "powershell"])
const CMD_WRAPPERS = new Set(["cmd"])

function containsDirectGitSubmitCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return commandHasGitSubcommand(command, GIT_SUBMIT_SUBCOMMANDS, shellSyntax)
}

function splitShellCommandSegments(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string[] {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  const pushCurrent = (): void => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ""
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (escaped) {
      if (ch === "\r" || ch === "\n") {
        current = current.slice(0, -1)
        if (ch === "\r" && command[i + 1] === "\n") i += 1
        escaped = false
        continue
      }
      current += ch
      escaped = false
      continue
    }

    if (shellEscapeConsumesNext(ch, command[i + 1], quote, shellSyntax)) {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }

    if (isShellQuote(ch, shellSyntax)) {
      current += ch
      quote = ch
      continue
    }

    if (ch === "\r" || ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      pushCurrent()
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i += 1
      continue
    }

    current += ch
  }

  pushCurrent()
  return segments
}

function isShellEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)
}

function backslashEscapesNextChar(
  next: string | undefined,
  quote: "'" | '"' | null,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  if (!next) return false
  if (shellSyntax !== "posix") return false
  if (quote === null) return true
  if (quote === '"') {
    return (
      next === '"' ||
      next === "\\" ||
      next === "$" ||
      next === "`" ||
      next === "\r" ||
      next === "\n"
    )
  }
  return next === "'" || next === '"' || next === "\\" || "$`;&|<>".includes(next)
}

function getGitInvocationTokens(tokens: string[]): string[] | null {
  const invocation = getExecutableInvocationTokens(tokens)
  return normalizeExecutable(invocation[0] || "") === "git" ? invocation : null
}

function getExecutableInvocationTokens(tokens: string[], depth = 0): string[] {
  let index = 0
  while (index < tokens.length && isShellEnvAssignment(tokens[index])) index += 1

  if (normalizeExecutable(tokens[index] || "") === "command") {
    index += 1
    if (tokens[index] === "-p") index += 1
    if (tokens[index] === "--") index += 1
  }

  if (normalizeExecutable(tokens[index] || "") === "env") {
    index += 1
    let optionsEnded = false
    while (index < tokens.length) {
      const token = tokens[index]
      const lower = token.toLowerCase()
      if (isShellEnvAssignment(token)) {
        index += 1
        continue
      }
      if (!optionsEnded && lower === "--") {
        index += 1
        optionsEnded = true
        continue
      }
      if (optionsEnded) break
      if (
        token === "-C" ||
        token === "-a" ||
        lower === "-u" ||
        lower === "--argv0" ||
        lower === "--chdir" ||
        lower === "--unset" ||
        token === "-S" ||
        lower === "--split-string"
      ) {
        index += 2
        continue
      }
      if (
        lower === "-i" ||
        lower === "-" ||
        lower === "-0" ||
        lower === "--debug" ||
        lower === "--null" ||
        token.startsWith("-C") ||
        token.startsWith("-a") ||
        lower.startsWith("-u") ||
        lower.startsWith("--argv0=") ||
        lower.startsWith("--chdir=") ||
        lower.startsWith("--split-string=") ||
        lower.startsWith("--unset=") ||
        lower.startsWith("--ignore-environment")
      ) {
        index += 1
        continue
      }
      // Unknown inline env options must not hide a following Git invocation from
      // the task-card router. Recognize the executable, then fail closed there.
      if (token.startsWith("-") && token.includes("=")) {
        index += 1
        continue
      }
      break
    }
  }

  const invocation = tokens.slice(index)
  const executable = normalizeExecutable(invocation[0] || "")
  if (
    depth < 8 &&
    invocation.length < tokens.length &&
    (executable === "command" || executable === "env")
  ) {
    return getExecutableInvocationTokens(invocation, depth + 1)
  }
  return invocation
}

function getEnvSplitStringScript(tokens: string[]): string | null {
  let index = 0
  while (index < tokens.length && isShellEnvAssignment(tokens[index])) index += 1
  if (normalizeExecutable(tokens[index] || "") === "command") {
    index += 1
    if (tokens[index] === "-p") index += 1
    if (tokens[index] === "--") index += 1
  }
  if (normalizeExecutable(tokens[index] || "") !== "env") return null

  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()
    if (token === "--") return null
    if (token === "-S" || lower === "--split-string") {
      const value = tokens[i + 1]
      if (value === undefined) return null
      return [value, ...tokens.slice(i + 2)].join(" ")
    }
    if (token.startsWith("-S") && token.length > 2) {
      return [token.slice(2), ...tokens.slice(i + 1)].join(" ")
    }
    if (lower.startsWith("--split-string=")) {
      return [token.slice(token.indexOf("=") + 1), ...tokens.slice(i + 1)].join(" ")
    }
  }
  return null
}

function containsEnvSplitStringOption(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    for (let envIndex = 0; envIndex < tokens.length; envIndex++) {
      if (normalizeExecutable(tokens[envIndex] || "") !== "env") continue
      for (const token of tokens.slice(envIndex + 1)) {
        if (token === "--") break
        if (/^-[^-]*S/.test(token)) return true
        if (token.startsWith("--")) {
          const optionName = token.split("=", 1)[0].toLowerCase()
          if (optionName.length > 2 && "--split-string".startsWith(optionName)) return true
        }
      }
    }
  }
  return false
}

function getWrappedShellScript(tokens: string[]): string | null {
  const envSplitStringScript = getEnvSplitStringScript(tokens)
  if (envSplitStringScript !== null) return envSplitStringScript

  const invocation = getExecutableInvocationTokens(tokens)
  const executable = normalizeExecutable(invocation[0] || "")

  if (
    executable === "busybox" &&
    POSIX_SHELL_WRAPPERS.has(normalizeExecutable(invocation[1] || ""))
  ) {
    return getWrappedShellScript(invocation.slice(1))
  }

  if (POSIX_SHELL_WRAPPERS.has(executable)) {
    for (let i = 1; i < invocation.length; i++) {
      const token = invocation[i]
      // Only a short-option cluster carrying `-c` reads the next arg as the script
      // (e.g. `-c`, `-lc`, `-xc`). A long option that merely contains the letter c
      // (e.g. `--check`, `--norc`) must NOT be mistaken for `-c`, otherwise a benign
      // `bash --check '…'` would be wrongly forbidden.
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return invocation[i + 1] || null
    }
    return null
  }

  if (POWERSHELL_WRAPPERS.has(executable)) {
    for (let i = 1; i < invocation.length; i++) {
      const lower = invocation[i].toLowerCase()
      if (!lower.startsWith("-") && !lower.startsWith("/")) continue
      const option = lower.slice(1)
      if (
        option &&
        ("command".startsWith(option) || "commandwithargs".startsWith(option) || option === "cwa")
      ) {
        return invocation.slice(i + 1).join(" ") || null
      }
    }
    return null
  }

  if (CMD_WRAPPERS.has(executable)) {
    for (let i = 1; i < invocation.length; i++) {
      const lower = invocation[i].toLowerCase()
      const switchMatch = lower.match(/(?:^|\/)[ck](.*)$/)
      if (!switchMatch) continue
      const attached = invocation[i].slice(invocation[i].length - switchMatch[1].length)
      return [attached, ...invocation.slice(i + 1)].filter(Boolean).join(" ") || null
    }
  }

  return null
}

function getWrappedShellSyntax(tokens: string[]): CommandShellSyntax | null {
  const invocation = getExecutableInvocationTokens(tokens)
  const executable = normalizeExecutable(invocation[0] || "")
  if (
    executable === "busybox" &&
    POSIX_SHELL_WRAPPERS.has(normalizeExecutable(invocation[1] || ""))
  ) {
    return "posix"
  }
  if (POSIX_SHELL_WRAPPERS.has(executable)) return "posix"
  if (POWERSHELL_WRAPPERS.has(executable)) return "powershell"
  if (CMD_WRAPPERS.has(executable)) return "cmd"
  return null
}

function interpolatingShellText(command: string, shellSyntax: CommandShellSyntax): string {
  let result = ""
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const next = command[index + 1]
    if (quote === "'") {
      if (shellSyntax === "powershell" && char === "'" && next === "'") {
        index += 1
        continue
      }
      if (char === "'") quote = null
      continue
    }
    if (shellEscapeConsumesNext(char, next, quote, shellSyntax)) {
      index += next === "\r" && command[index + 2] === "\n" ? 2 : 1
      result += " __escaped__ "
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if ((char === "(" && command[index - 1] === "$") || !"(){}*?[".includes(char)) {
        result += char
      } else {
        result += " "
      }
      continue
    }
    if (char === "'" && shellSyntax !== "cmd") {
      quote = "'"
      result += " __literal__ "
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }
    result += char
  }
  return result
}

function hasOpaqueGitMutationSyntax(command: string, shellSyntax: CommandShellSyntax): boolean {
  const visible = interpolatingShellText(command, shellSyntax)
  if (
    !/\bgit\b|\b(?:commit|add|stage|commit-tree|read-tree|update-index|update-ref|write-tree)\b/i.test(
      visible
    )
  ) {
    return false
  }
  if (shellSyntax === "powershell") {
    return /\$\(|@\(|\$[A-Za-z_({]|@[A-Za-z_]|[(){}]/.test(visible)
  }
  if (shellSyntax === "cmd") {
    return /%[^%]+%|![^!]+!/.test(visible)
  }
  return /\$\(|\$\{|\$[A-Za-z_@*?#0-9!-]|`|[<>]\(|[(){}*?]|\[/i.test(visible)
}

function hasOpaqueShellExecution(tokens: string[], shellSyntax: CommandShellSyntax): boolean {
  const invocation = getExecutableInvocationTokens(tokens)
  const executable = normalizeExecutable(invocation[0] || "")
  if (POWERSHELL_WRAPPERS.has(executable)) {
    const encoded = invocation.slice(1).some((token) => {
      if (!token.startsWith("-") && !token.startsWith("/")) return false
      const option = token.slice(1).split("=", 1)[0].toLowerCase()
      return (
        (option.length > 0 && "encodedcommand".startsWith(option)) ||
        (option.length > 0 && "encodedarguments".startsWith(option))
      )
    })
    if (encoded) return true
  }

  const mentionsGitMutation =
    /\bgit\b|\b(?:commit|add|stage|commit-tree|read-tree|update-index|update-ref|write-tree)\b/i.test(
      tokens.join(" ")
    )
  if (!mentionsGitMutation) return false
  if (
    executable === "rg" &&
    !isSafeRipgrep(invocation) &&
    /\bgit(?:-[A-Za-z0-9-]+)?\b/i.test(invocation.join(" "))
  ) {
    return true
  }
  if (
    /^git-(?:add|apply|commit|commit-tree|read-tree|stage|update-index|update-ref|write-tree)$/.test(
      executable
    )
  ) {
    return true
  }
  const controlKeywords = new Set([
    "alias",
    "and",
    "for",
    "foreach",
    "if",
    "nal",
    "new-alias",
    "or",
    "case",
    "coproc",
    "function",
    "select",
    "sal",
    "set-alias",
    "switch",
    "trap",
    "try",
    "until",
    "while"
  ])
  if (controlKeywords.has(executable)) return true
  if (
    executable === "fish" &&
    invocation
      .slice(1)
      .some((token) => /^(?:-C|--command(?:=|$)|--init-command(?:=|$))/.test(token))
  ) {
    return true
  }
  if (
    shellSyntax === "powershell" &&
    invocation.some((token) => /^alias:[\\/]/i.test(token) || /^alias:[^=]*$/i.test(token))
  ) {
    return true
  }
  if (shellSyntax === "powershell") {
    return (
      tokens.includes("{") ||
      tokens.includes("}") ||
      tokens[0] === "&" ||
      tokens[0] === "." ||
      executable === "iex" ||
      executable === "invoke-command" ||
      executable === "invoke-expression" ||
      executable === "start-process" ||
      /^\$/.test(tokens[0] || "")
    )
  }
  if (shellSyntax === "cmd") {
    return (
      executable === "call" || executable === "start" || /%(?:[^%]+)%|![^!]+!/.test(tokens[0] || "")
    )
  }
  return executable === "eval" || /\$|`|[*?[]|\{[^}]*[,}]/.test(tokens[0] || "")
}

const GIT_COMMIT_EXECUTION_WRAPPERS = new Set([
  "busybox",
  "call",
  "chrt",
  "command",
  "coproc",
  "doas",
  "env",
  "exec",
  "find",
  "ionice",
  "nice",
  "nocorrect",
  "noglob",
  "not",
  "nohup",
  "setsid",
  "start",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "wsl",
  "xargs"
])
const GIT_INDEX_OR_REF_PLUMBING_SUBCOMMANDS = new Set([
  "commit-tree",
  "read-tree",
  "update-index",
  "update-ref",
  "write-tree"
])
const NON_EXECUTING_GIT_TEXT_COMMANDS = new Set([
  "echo",
  "findstr",
  "grep",
  "printf",
  "rg",
  "select-string",
  "write-host",
  "write-output"
])

// Git aliases are expanded only after Git starts, so an unknown subcommand can hide
// `commit`, a shell command, or even `git add -f` from the task-card router. Built-ins
// cannot be overridden by aliases; allow the built-in command set and fail closed for
// every other subcommand issued by the Agent.
const GIT_BUILTIN_SUBCOMMANDS = new Set(
  `add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file
  check-attr check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index
  cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects
  credential credential-cache credential-cache--daemon credential-store describe diagnose diff
  diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack
  fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc
  get-tar-commit-id grep hash-object help hook index-pack init init-db interpret-trailers log
  ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index
  merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree merge-tree
  mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id
  pickaxe prune prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote
  remote-ext remote-fd repack replace replay rerere reset restore rev-list rev-parse revert rm
  send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status
  stripspace submodule--helper survey switch symbolic-ref tag unpack-file unpack-objects update-index
  update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit
  verify-pack verify-tag version whatchanged worktree write-tree`
    .split(/\s+/)
    .filter(Boolean)
)

function collectPotentialGitInvocations(tokens: string[]): string[][] {
  const directInvocation = getGitInvocationTokens(tokens)
  if (directInvocation) return [directInvocation]

  let firstExecutableIndex = 0
  while (
    firstExecutableIndex < tokens.length &&
    isShellEnvAssignment(tokens[firstExecutableIndex])
  ) {
    firstExecutableIndex += 1
  }
  const invocations: string[][] = []
  const shellPrefixes = new Set([
    "&",
    "!",
    "{",
    "(",
    "do",
    "elif",
    "if",
    "case",
    "select",
    "trap",
    "try",
    "then",
    "until",
    "while"
  ])
  for (let index = 0; index < tokens.length; index += 1) {
    const stripped = tokens[index].replace(/^[({]+/, "")
    if (normalizeExecutable(stripped) !== "git") continue
    const prefixes = tokens.slice(0, index).map((token) => token.toLowerCase())
    if (prefixes.every((token) => shellPrefixes.has(token))) {
      invocations.push([stripped, ...tokens.slice(index + 1)])
    }
  }
  const firstExecutable = normalizeExecutable(tokens[firstExecutableIndex] || "")
  if (!NON_EXECUTING_GIT_TEXT_COMMANDS.has(firstExecutable)) {
    for (let index = firstExecutableIndex + 1; index < tokens.length; index += 1) {
      if (normalizeExecutable(tokens[index]) === "git") {
        invocations.push(tokens.slice(index))
      }
    }
  }
  if (!GIT_COMMIT_EXECUTION_WRAPPERS.has(firstExecutable)) return invocations
  for (let index = firstExecutableIndex + 1; index < tokens.length; index += 1) {
    if (normalizeExecutable(tokens[index]) === "git") {
      invocations.push(tokens.slice(index))
    }
  }
  return invocations
}

function getExecutionWrapperSuffixTokens(tokens: string[]): string[][] {
  let firstExecutableIndex = 0
  while (
    firstExecutableIndex < tokens.length &&
    isShellEnvAssignment(tokens[firstExecutableIndex])
  ) {
    firstExecutableIndex += 1
  }
  const executable = normalizeExecutable(tokens[firstExecutableIndex] || "")
  if (!GIT_COMMIT_EXECUTION_WRAPPERS.has(executable)) return []
  return tokens
    .slice(firstExecutableIndex + 1)
    .map((_, offset) => tokens.slice(firstExecutableIndex + 1 + offset))
    .filter((suffix) => suffix.length > 0)
}

function containsDirectGitIndexPlumbing(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax(),
  depth = 0
): boolean {
  if (depth > 3) return true
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    if (hasOpaqueGitMutationSyntax(segment, shellSyntax)) return true
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    if (hasOpaqueShellExecution(tokens, shellSyntax)) return true
    for (const invocation of collectPotentialGitInvocations(tokens)) {
      const subcommand = findGitSubcommand(invocation)
      if (subcommand && GIT_INDEX_OR_REF_PLUMBING_SUBCOMMANDS.has(subcommand.subcommand)) {
        return true
      }
      if (subcommand?.subcommand === "apply") {
        for (const token of invocation.slice(subcommand.index + 1)) {
          if (token === "--") break
          if (/^-[^-]*[3N]/.test(token)) return true
          if (!token.startsWith("--")) continue
          const optionName = token.split("=", 1)[0].toLowerCase()
          if (
            optionName.length > 2 &&
            ("--cached".startsWith(optionName) ||
              "--index".startsWith(optionName) ||
              "--intent-to-add".startsWith(optionName) ||
              "--3way".startsWith(optionName))
          ) {
            return true
          }
        }
      }
    }
    const script = getWrappedShellScript(tokens)
    const childSyntax = getWrappedShellSyntax(tokens) ?? shellSyntax
    if (script && containsDirectGitIndexPlumbing(script, childSyntax, depth + 1)) return true
    for (const nestedTokens of getExecutionWrapperSuffixTokens(tokens)) {
      const nestedScript = getWrappedShellScript(nestedTokens)
      const nestedSyntax = getWrappedShellSyntax(nestedTokens) ?? shellSyntax
      if (nestedScript && containsDirectGitIndexPlumbing(nestedScript, nestedSyntax, depth + 1)) {
        return true
      }
      if (containsDirectGitIndexPlumbing(nestedTokens.join(" "), nestedSyntax, depth + 1)) {
        return true
      }
    }
  }
  return false
}

function containsForceGitAddCommand(
  command: string,
  depth = 0,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  if (depth > 3) return true
  if (
    shellSyntax === "powershell" &&
    /^\s*&\s*(?:\(|\$)/.test(command) &&
    /\b(?:add|stage)\b[^\r\n]*(?:-[^-\s]*f|--for(?:ce)?\b)/i.test(command)
  ) {
    return true
  }
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    if (hasOpaqueGitMutationSyntax(segment, shellSyntax)) return true
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    if (hasOpaqueShellExecution(tokens, shellSyntax)) return true
    for (const invocation of collectPotentialGitInvocations(tokens)) {
      const subcommand = findGitSubcommand(invocation)
      if (!subcommand || (subcommand.subcommand !== "add" && subcommand.subcommand !== "stage")) {
        continue
      }
      for (const token of invocation.slice(subcommand.index + 1)) {
        if (token === "--") break
        if (/^-[^-]*f/.test(token)) return true
        if (token.startsWith("--")) {
          const optionName = token.split("=", 1)[0].toLowerCase()
          if (optionName.length > 2 && "--force".startsWith(optionName)) return true
        }
      }
    }
    const script = getWrappedShellScript(tokens)
    const childSyntax = getWrappedShellSyntax(tokens) ?? shellSyntax
    if (script && containsForceGitAddCommand(script, depth + 1, childSyntax)) return true
    for (const nestedTokens of getExecutionWrapperSuffixTokens(tokens)) {
      const nestedScript = getWrappedShellScript(nestedTokens)
      const nestedSyntax = getWrappedShellSyntax(nestedTokens) ?? shellSyntax
      if (nestedScript && containsForceGitAddCommand(nestedScript, depth + 1, nestedSyntax)) {
        return true
      }
      if (containsForceGitAddCommand(nestedTokens.join(" "), depth + 1, nestedSyntax)) return true
    }
  }
  return false
}

function containsPotentialGitAliasInvocation(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax(),
  depth = 0
): boolean {
  if (depth > 3) return true
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    if (hasOpaqueGitMutationSyntax(segment, shellSyntax)) return true
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    for (const invocation of collectPotentialGitInvocations(tokens)) {
      const subcommand = findGitSubcommand(invocation)
      if (
        subcommand &&
        (invocation[subcommand.index] !== subcommand.subcommand ||
          !GIT_BUILTIN_SUBCOMMANDS.has(subcommand.subcommand))
      ) {
        return true
      }
    }
    const script = getWrappedShellScript(tokens)
    const childSyntax = getWrappedShellSyntax(tokens) ?? shellSyntax
    if (script && containsPotentialGitAliasInvocation(script, childSyntax, depth + 1)) return true
    for (const nestedTokens of getExecutionWrapperSuffixTokens(tokens)) {
      const nestedScript = getWrappedShellScript(nestedTokens)
      const nestedSyntax = getWrappedShellSyntax(nestedTokens) ?? shellSyntax
      if (
        nestedScript &&
        containsPotentialGitAliasInvocation(nestedScript, nestedSyntax, depth + 1)
      ) {
        return true
      }
      if (containsPotentialGitAliasInvocation(nestedTokens.join(" "), nestedSyntax, depth + 1)) {
        return true
      }
    }
  }
  return false
}

function containsPotentialWrapperGitCommit(tokens: string[]): boolean {
  if (getGitInvocationTokens(tokens)) return false
  let firstExecutableIndex = 0
  while (
    firstExecutableIndex < tokens.length &&
    isShellEnvAssignment(tokens[firstExecutableIndex])
  ) {
    firstExecutableIndex += 1
  }
  const firstExecutable = normalizeExecutable(tokens[firstExecutableIndex] || "")
  if (!GIT_COMMIT_EXECUTION_WRAPPERS.has(firstExecutable)) return false
  if (tokens.slice(firstExecutableIndex + 1).some((token) => /\bgit\s+commit\b/i.test(token))) {
    return true
  }

  for (let i = firstExecutableIndex + 1; i < tokens.length; i++) {
    if (normalizeExecutable(tokens[i]) !== "git") continue
    const subcommand = findGitSubcommand(tokens.slice(i))
    if (subcommand?.subcommand === "commit") return true
  }
  return false
}

function containsWrappedGitCommitCommand(
  command: string,
  depth = 0,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  if (depth > 3) return true
  if (
    shellSyntax === "powershell" &&
    /^\s*&\s*(?:\(|\$)/.test(command) &&
    /\bcommit\b/i.test(command)
  ) {
    return true
  }
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    if (hasOpaqueGitMutationSyntax(segment, shellSyntax)) return true
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    if (hasOpaqueShellExecution(tokens, shellSyntax)) return true
    if (
      !getGitInvocationTokens(tokens) &&
      collectPotentialGitInvocations(tokens).some((invocation) => {
        const subcommand = findGitSubcommand(invocation)
        return subcommand?.subcommand === "commit"
      })
    ) {
      return true
    }
    if (containsPotentialWrapperGitCommit(tokens)) return true
    const script = getWrappedShellScript(tokens)
    const childSyntax = getWrappedShellSyntax(tokens) ?? shellSyntax
    if (
      script &&
      (containsPotentialGitAliasInvocation(script, childSyntax) ||
        commandHasGitSubcommand(script, new Set(["commit"]), childSyntax) ||
        containsWrappedGitCommitCommand(script, depth + 1, childSyntax))
    ) {
      return true
    }
    for (const nestedTokens of getExecutionWrapperSuffixTokens(tokens)) {
      const nestedScript = getWrappedShellScript(nestedTokens)
      const nestedSyntax = getWrappedShellSyntax(nestedTokens) ?? shellSyntax
      if (
        nestedScript &&
        (commandHasGitSubcommand(nestedScript, new Set(["commit"]), nestedSyntax) ||
          containsWrappedGitCommitCommand(nestedScript, depth + 1, nestedSyntax))
      ) {
        return true
      }
      if (containsWrappedGitCommitCommand(nestedTokens.join(" "), depth + 1, nestedSyntax)) {
        return true
      }
    }
  }
  return false
}

function commandHasGitSubcommand(
  command: string,
  subcommands: Set<string>,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    for (const gitTokens of collectPotentialGitInvocations(tokens)) {
      const subcommand = findGitSubcommand(gitTokens)
      if (subcommand && subcommands.has(subcommand.subcommand)) return true
    }
  }
  return false
}

function inlineGitAliasInvokesPush(
  gitTokens: string[],
  memo: Map<string, boolean>
): boolean {
  const subcommand = findGitSubcommand(gitTokens)
  if (!subcommand) return false

  const aliases = new Map<string, string>()
  for (let index = 1; index < subcommand.index; index += 1) {
    const token = gitTokens[index]
    let config: string | undefined
    if (token.toLowerCase() === "-c") {
      config = gitTokens[++index]
    } else if (token.toLowerCase().startsWith("-c") && token.length > 2) {
      config = token.slice(2)
    }
    if (!config) continue
    const separator = config.indexOf("=")
    if (separator <= 0) continue
    const key = config.slice(0, separator).toLowerCase()
    if (!key.startsWith("alias.")) continue
    aliases.set(key.slice("alias.".length), config.slice(separator + 1))
  }

  let aliasName = subcommand.subcommand
  for (let depth = 0; depth < 4; depth += 1) {
    const value = aliases.get(aliasName)
    if (value === undefined) return false
    if (value.startsWith("!")) {
      const script = value.slice(1)
      return (
        commandHasGitSubcommand(script, new Set(["push"]), "posix") ||
        containsIndirectGitPushCommand(script, "posix", depth + 1, memo)
      )
    }
    const expanded = tokenizeCommand(`git ${value}`, "posix")
    if (!expanded) return false
    const expandedSubcommand = findGitSubcommand(expanded)
    if (!expandedSubcommand) return false
    if (expandedSubcommand.subcommand === "push") return true
    aliasName = expandedSubcommand.subcommand
  }
  return false
}

function containsIndirectGitPushCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax(),
  depth = 0,
  memo = new Map<string, boolean>(),
  scanState: { unverifiable: boolean } = { unverifiable: false }
): boolean {
  // Once the visible wrapper nesting exceeds the bounded parser, the command
  // can no longer be verified. Keep that distinct from actually finding a
  // hidden push so callers can fail closed without misclassifying the command.
  if (depth > 4) {
    scanState.unverifiable = true
    return false
  }
  const memoKey = `${shellSyntax}\0${depth}\0${command}`
  if (memo.has(memoKey)) return memo.get(memoKey) === true
  // Mark the state before descending so malformed/self-referential wrapper
  // spellings cannot cycle. The value is replaced if a push is found.
  memo.set(memoKey, false)
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    let firstExecutableIndex = 0
    while (
      firstExecutableIndex < tokens.length &&
      isShellEnvAssignment(tokens[firstExecutableIndex])
    ) {
      firstExecutableIndex += 1
    }
    const firstExecutable = normalizeExecutable(tokens[firstExecutableIndex] || "")
    const directGit = firstExecutable === "git"
    for (const gitTokens of collectPotentialGitInvocations(tokens)) {
      const subcommand = findGitSubcommand(gitTokens)
      if (!directGit && subcommand?.subcommand === "push") {
        memo.set(memoKey, true)
        return true
      }
      if (inlineGitAliasInvokesPush(gitTokens, memo)) {
        memo.set(memoKey, true)
        return true
      }
    }

    const script = getWrappedShellScript(tokens)
    const childSyntax = getWrappedShellSyntax(tokens) ?? shellSyntax
    if (
      script &&
      (commandHasGitSubcommand(script, new Set(["push"]), childSyntax) ||
        containsIndirectGitPushCommand(script, childSyntax, depth + 1, memo, scanState))
    ) {
      memo.set(memoKey, true)
      return true
    }

    // Wrapper suffix enumeration grows rapidly for inputs such as
    // `env env ...`. Git invocations above are already found in one pass; only
    // explicit nested shell executors still need their script parsed.
    if (!GIT_COMMIT_EXECUTION_WRAPPERS.has(firstExecutable)) continue
    const hasEnvSplitString = tokens.some((token) => {
      const lower = token.toLowerCase()
      return (
        token === "-S" ||
        lower === "--split-string" ||
        (token.startsWith("-S") && token.length > 2) ||
        lower.startsWith("--split-string=")
      )
    })
    const nestedWrapperIndexes: number[] = []
    for (let index = firstExecutableIndex + 1; index < tokens.length; index += 1) {
      const executable = normalizeExecutable(tokens[index])
      if (
        POSIX_SHELL_WRAPPERS.has(executable) ||
        POWERSHELL_WRAPPERS.has(executable) ||
        CMD_WRAPPERS.has(executable) ||
        executable === "busybox" ||
        (hasEnvSplitString && executable === "env")
      ) {
        nestedWrapperIndexes.push(index)
        if (nestedWrapperIndexes.length > 16) {
          scanState.unverifiable = true
          continue
        }
      }
    }
    for (const index of nestedWrapperIndexes) {
      const nestedTokens = tokens.slice(index)
      const nestedScript = getWrappedShellScript(nestedTokens)
      const nestedSyntax = getWrappedShellSyntax(nestedTokens) ?? shellSyntax
      if (
        nestedScript &&
        (commandHasGitSubcommand(nestedScript, new Set(["push"]), nestedSyntax) ||
          containsIndirectGitPushCommand(
            nestedScript,
            nestedSyntax,
            depth + 1,
            memo,
            scanState
          ))
      ) {
        memo.set(memoKey, true)
        return true
      }
    }
  }
  return false
}

function inspectIndirectGitPush(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): { containsPush: boolean; unverifiable: boolean } {
  const scanState = { unverifiable: false }
  const containsPush = containsIndirectGitPushCommand(
    command.trim(),
    shellSyntax,
    0,
    new Map<string, boolean>(),
    scanState
  )
  return { containsPush, unverifiable: scanState.unverifiable }
}

/** True when the command is (or contains) a real `git commit` invocation. */
export function isGitCommitCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["commit"]), shellSyntax)
}

/** True when the command is (or contains) a real `git push` invocation. */
export function isGitPushCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["push"]), shellSyntax)
}

/**
 * True only when a push is visibly hidden behind a shell wrapper or an inline
 * `git -c alias.*=...` definition. Isolated worktrees reject this narrow case so
 * the agent can retry a direct push that enters the explicit approval flow.
 */
export function containsIndirectGitPush(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return inspectIndirectGitPush(command, shellSyntax).containsPush
}

/** True when the command is (or contains) a real `git merge` invocation. */
export function isGitMergeCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["merge"]), shellSyntax)
}

/**
 * True when the command chains multiple shell statements (`&&`, `||`, `;`, `|`, `&`)
 * outside of quoted spans. Used to refuse intercepting a `git commit` that is glued to
 * other commands — the commit dialog only performs the commit, so the rest of the chain
 * would otherwise be silently dropped.
 */
export function isChainedShellCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  return /\|\||&&|[;&|]|\r|\n/.test(stripQuotedSpans(command, shellSyntax))
}

function normalizeMsysPathForWindows(rawPath: string): string {
  if (process.platform !== "win32") return rawPath
  const normalized = rawPath.replace(/\\/g, "/")
  const match = normalized.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  if (!match) return rawPath
  return `${match[1].toUpperCase()}:/${match[2] ?? ""}`
}

function resolveShellCdTarget(currentCwd: string, segment: string): string | null {
  const tokens = tokenizeCommand(segment)
  if (!tokens || tokens.length < 2 || tokens.length > 3) return null
  if (tokens[0].toLowerCase() !== "cd") return null
  let targetIndex = 1
  if (tokens[1] === "--") targetIndex = 2
  const target = tokens[targetIndex]
  if (!target || target === "-") return null
  if (tokens.length > targetIndex + 1) return null
  return path.resolve(currentCwd, normalizeMsysPathForWindows(target))
}

/** Common, direct operations that violate this product's transient-branch
 * contract. This is intentionally an accident guard, not an exhaustive model
 * of every Git plumbing command (matching MiMo Code's worktree guard). */
const WORKTREE_ALWAYS_BLOCKED_GIT_COMMANDS = new Set(["update-ref", "gc", "pack-refs"])

function firstGitPositionalArgument(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"))?.toLowerCase()
}

/** Recovery-only forms operate on an already in-progress merge/rebase in this
 * worktree. They do not start cross-branch integration, and leaving them
 * blocked would strand an agent after an otherwise permitted `git pull`. */
const WORKTREE_GIT_IN_PROGRESS_RECOVERY_OPTIONS = new Set([
  "--abort",
  "--continue",
  "--quit",
  "--skip",
  "--edit-todo",
  "--show-current-patch"
])

const WORKTREE_GIT_CONFIG_WRITE_OPTIONS = new Set([
  "--add",
  "--replace-all",
  "--unset",
  "--unset-all",
  "--rename-section",
  "--remove-section",
  "--edit"
])

const WORKTREE_GIT_CONFIG_READ_OPTIONS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l"
])

/** `git config` writes its default local config into the repository's shared
 * common directory, even when invoked from a linked worktree. Permit only the
 * ordinary query forms; all mutations, including `--worktree`, are outside an
 * isolated agent's transient-branch contract. */
function isReadOnlyGitConfigInvocation(args: string[]): boolean {
  if (args.some((arg) => WORKTREE_GIT_CONFIG_WRITE_OPTIONS.has(arg.toLowerCase()))) {
    return false
  }
  const first = args[0]?.toLowerCase()
  if (first === "get" || first === "list" || first === "get-regexp" || first === "get-urlmatch") {
    return true
  }
  if (first === "set" || first === "add" || first === "unset" || first === "rename-section") {
    return false
  }
  if (args.some((arg) => WORKTREE_GIT_CONFIG_READ_OPTIONS.has(arg.toLowerCase()))) {
    return true
  }

  // Legacy `git config <name>` is a read; a second positional value changes
  // the shared config. Skip the small set of global options that consume a
  // value before counting positional arguments.
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (["--file", "-f", "--blob", "--type", "--default"].includes(arg.toLowerCase())) {
      index += 1
      continue
    }
    if (
      arg.startsWith("--file=") ||
      arg.startsWith("--blob=") ||
      arg.startsWith("--type=") ||
      arg.startsWith("--default=")
    ) {
      continue
    }
    if (!arg.startsWith("-")) positionals.push(arg)
  }
  return positionals.length <= 1
}

/** Remote names and URLs live in the shared repository config. Keep list/show
 * queries usable while rejecting every form that can mutate that shared state. */
function isReadOnlyGitRemoteInvocation(args: string[]): boolean {
  let index = 0
  while (args[index] === "-v" || args[index]?.toLowerCase() === "--verbose") index += 1
  if (index === args.length) return true
  const subcommand = args[index].toLowerCase()
  return subcommand === "get-url" || subcommand === "show"
}

/** Whether a command contains a real `git add`, including a shell chain. Used
 * to keep native index mutation attached to its foreground tool call so the
 * worktree lifecycle cannot settle while staging is still running. */
export function containsGitAddCommand(command: string): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["add"]))
}

function realpathIfExisting(input: string): string | null {
  try {
    return typeof realpathSync.native === "function"
      ? realpathSync.native(input)
      : realpathSync(input)
  } catch {
    return null
  }
}

function normalizeWorktreeBoundaryPath(input: string): string {
  const canonical = realpathIfExisting(input)
  const resolved =
    (canonical ?? path.resolve(input)).replace(/[\\/]+$/, "") ||
    path.parse(canonical ?? path.resolve(input)).root
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isInsideWorktreeBoundary(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeWorktreeBoundaryPath(candidate)
  const normalizedRoot = normalizeWorktreeBoundaryPath(root)
  const relative = path.relative(normalizedRoot, normalizedCandidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/** Resolve the closest repository that Git would select from an existing cwd.
 * Linked worktrees expose `.git` as a file while ordinary/nested repositories
 * expose it as a directory, so existence is the only distinction needed here.
 * Returning null leaves malformed/non-repository cwd handling to Git itself. */
function findContainingGitRepositoryRoot(directory: string): string | null {
  let current = realpathIfExisting(directory) ?? path.resolve(directory)
  while (true) {
    if (realpathIfExisting(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Resolve a `cd` / `git -C` target without collapsing `..` before the
 * filesystem sees an intervening symlink. The fallback is lexical only for a
 * non-existent target, which the shell/Git will reject itself. */
function resolveWorktreeCommandDirectory(cwd: string, target: string): string {
  const normalizedTarget = normalizeMsysPathForWindows(target)
  const rawCandidate = path.isAbsolute(normalizedTarget)
    ? normalizedTarget
    : `${cwd}${path.sep}${normalizedTarget}`
  return realpathIfExisting(rawCandidate) ?? path.resolve(cwd, normalizedTarget)
}

function isWorktreeRedirectingGitConfig(config: string): boolean {
  const key = config.split("=", 1)[0]?.trim().toLowerCase()
  return (
    key === "core.worktree" ||
    key === "core.bare" ||
    key === "core.repositoryformatversion" ||
    key === "extensions.worktreeconfig" ||
    key === "commondir"
  )
}

function worktreeGitEnvironmentViolation(tokens: string[]): string | null {
  const gitIndex = tokens.findIndex((token) => normalizeExecutable(token) === "git")
  for (const token of tokens.slice(0, gitIndex)) {
    if (!isShellEnvAssignment(token)) continue
    const name = token.slice(0, token.indexOf("=")).toUpperCase()
    if (isGitRepositoryOverrideEnvironmentVariable(name)) {
      return `worktree isolation blocks Git environment redirection ${name}`
    }
  }
  return null
}

/** Shell assignments persist across later segments. Block the explicit forms
 * that can redirect a subsequent Git invocation without trying to model the
 * shell's general environment semantics. */
function worktreeGitEnvironmentMutationViolation(
  tokens: string[],
  shellSyntax: CommandShellSyntax
): string | null {
  if (shellSyntax === "powershell") {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      const match = token.match(/^\$(?:env:([^=\s]+)|\{env:([^}]+)\})(?:=|$)/i)
      const name = match?.[1] ?? match?.[2]
      const assignsValue = token.includes("=") || tokens[index + 1] === "="
      if (name && assignsValue && isGitRepositoryOverrideEnvironmentVariable(name)) {
        return `worktree isolation blocks Git environment redirection ${name.toUpperCase()}`
      }
    }
  }
  const invocation = getExecutableInvocationTokens(tokens)
  if (invocation.length === 0) {
    for (const token of tokens) {
      if (!isShellEnvAssignment(token)) continue
      const name = token.slice(0, token.indexOf("="))
      if (isGitRepositoryOverrideEnvironmentVariable(name)) {
        return `worktree isolation blocks Git environment redirection ${name.toUpperCase()}`
      }
    }
    return null
  }
  if (normalizeExecutable(invocation[0]) !== "export") return null
  for (const token of invocation.slice(1)) {
    if (token.startsWith("-")) continue
    const name = token.split("=", 1)[0]
    if (name && isGitRepositoryOverrideEnvironmentVariable(name)) {
      return `worktree isolation blocks Git environment redirection ${name.toUpperCase()}`
    }
  }
  return null
}

function inspectWorktreeGitInvocation(
  gitTokens: string[],
  cwd: string,
  executionRoots: readonly string[],
  assignedWorkspaceRoot: string,
  assignedWorktreeRoot: string,
  assignedBranch: string
): string | null {
  let gitCwd = cwd
  let subcommandIndex = -1

  for (let i = 1; i < gitTokens.length; i++) {
    const token = gitTokens[i]
    const lower = token.toLowerCase()
    if (token === "-C") {
      const target = gitTokens[++i]
      if (!target) return "worktree isolation blocks Git -C without a target"
      gitCwd = resolveWorktreeCommandDirectory(gitCwd, target)
      if (!executionRoots.some((root) => isInsideWorktreeBoundary(gitCwd, root))) {
        return "worktree isolation blocks git -C outside the assigned workspace or enabled skill"
      }
      continue
    }
    if (token.startsWith("-C") && token.length > 2) {
      gitCwd = resolveWorktreeCommandDirectory(gitCwd, token.slice(2))
      if (!executionRoots.some((root) => isInsideWorktreeBoundary(gitCwd, root))) {
        return "worktree isolation blocks git -C outside the assigned workspace or enabled skill"
      }
      continue
    }
    if (lower === "-c") {
      const config = gitTokens[++i]
      if (!config) return "worktree isolation blocks Git -c without a config value"
      if (isWorktreeRedirectingGitConfig(config)) {
        return `worktree isolation blocks repository-redirection config ${config}`
      }
      continue
    }
    if (token.startsWith("-c") && token.length > 2) {
      const config = token.slice(2)
      if (isWorktreeRedirectingGitConfig(config)) {
        return `worktree isolation blocks repository-redirection config ${config}`
      }
      continue
    }
    if (
      lower === "--config-env" ||
      lower === "--git-dir" ||
      lower === "--work-tree" ||
      lower === "--namespace"
    ) {
      return `worktree isolation blocks Git redirection/config option ${token}`
    }
    if (
      lower.startsWith("--config-env=") ||
      lower.startsWith("--git-dir=") ||
      lower.startsWith("--work-tree=") ||
      lower.startsWith("--namespace=")
    ) {
      return `worktree isolation blocks Git redirection/config option ${token}`
    }
    if (token === "--" || token.startsWith("-")) continue
    subcommandIndex = i
    break
  }

  if (subcommandIndex < 0) return null
  const subcommand = gitTokens[subcommandIndex].toLowerCase()
  const args = gitTokens.slice(subcommandIndex + 1)
  if (
    ["add", "commit", "push"].includes(subcommand) &&
    !isInsideWorktreeBoundary(gitCwd, assignedWorkspaceRoot)
  ) {
    return `worktree isolation only allows git ${subcommand} inside the assigned worktree workspace`
  }
  if (["add", "commit", "push"].includes(subcommand)) {
    const operationRoot = findContainingGitRepositoryRoot(gitCwd)
    if (
      operationRoot &&
      normalizeWorktreeBoundaryPath(operationRoot) !==
        normalizeWorktreeBoundaryPath(assignedWorktreeRoot)
    ) {
      return `worktree isolation only allows git ${subcommand} in the assigned workflow worktree repository; ${WORKTREE_NESTED_REPOSITORY_READ_ONLY}`
    }
  }
  if (args.some((arg) => arg.toLowerCase() === "--autostash")) {
    return "worktree isolation blocks --autostash because refs/stash is shared"
  }
  if (args.some((arg) => arg.toLowerCase() === "--update-refs")) {
    return "worktree isolation blocks --update-refs because it can move sibling branches"
  }
  if (WORKTREE_ALWAYS_BLOCKED_GIT_COMMANDS.has(subcommand)) {
    return `worktree isolation blocks Git command that can modify shared metadata: git ${subcommand}`
  }
  if (
    subcommand === "reflog" &&
    ["expire", "delete"].includes(firstGitPositionalArgument(args) ?? "")
  ) {
    return "worktree isolation blocks rewriting shared reflogs"
  }
  if (subcommand === "maintenance" && firstGitPositionalArgument(args) === "run") {
    return "worktree isolation blocks shared repository maintenance"
  }
  if (subcommand === "config" && !isReadOnlyGitConfigInvocation(args)) {
    return "worktree isolation blocks modifying shared Git configuration"
  }
  if (subcommand === "remote" && !isReadOnlyGitRemoteInvocation(args)) {
    return "worktree isolation blocks modifying shared Git remotes"
  }
  if (subcommand === "push") {
    const lowerArgs = args.map((arg) => arg.toLowerCase())
    if (
      lowerArgs.some(
        (arg) =>
          arg === "-f" ||
          arg === "--force" ||
          arg.startsWith("--force=") ||
          arg.startsWith("--force-with-lease") ||
          arg.startsWith("--force-if-includes") ||
          arg === "-d" ||
          arg === "--delete" ||
          arg === "--mirror" ||
          arg === "--all" ||
          arg === "--tags" ||
          arg === "--prune" ||
          arg === "-u" ||
          arg === "--set-upstream"
      )
    ) {
      return "worktree isolation blocks force/delete/bulk/upstream pushes from a transient branch"
    }

    // Keep push deliberately explicit. A bare push can follow stale upstream or
    // push.default configuration into another remote ref. The accepted forms all
    // name exactly one remote and the assigned transient branch.
    if (args.some((arg) => arg.startsWith("-"))) {
      return "worktree isolation requires an explicit plain push of the assigned transient branch"
    }
    if (args.length !== 2) {
      return "worktree isolation requires `git push <remote> HEAD` for the assigned transient branch"
    }
    const refspec = args[1]
    const shortBranch = assignedBranch.replace(/^refs\/heads\//, "")
    const fullBranch = `refs/heads/${shortBranch}`
    const allowedRefspecs = new Set([
      "HEAD",
      shortBranch,
      fullBranch,
      `HEAD:${shortBranch}`,
      `HEAD:${fullBranch}`,
      `${shortBranch}:${shortBranch}`,
      `${shortBranch}:${fullBranch}`,
      `${fullBranch}:${shortBranch}`,
      `${fullBranch}:${fullBranch}`
    ])
    if (!allowedRefspecs.has(refspec)) {
      return "worktree isolation only allows pushing the assigned transient branch to the same remote branch"
    }
  }
  if (
    (subcommand === "merge" || subcommand === "rebase") &&
    !args.some((arg) => WORKTREE_GIT_IN_PROGRESS_RECOVERY_OPTIONS.has(arg.toLowerCase()))
  ) {
    return `worktree isolation leaves cross-branch integration to the workflow owner: git ${subcommand}`
  }
  if (subcommand === "switch") {
    return "worktree isolation keeps the checkout on its assigned transient branch"
  }
  if (subcommand === "symbolic-ref") {
    const positional = args.filter((arg) => !arg.startsWith("-"))
    const hasWriteFlag = args.some((arg) => arg === "-d" || arg === "--delete")
    const validFlags = args.every(
      (arg) => !arg.startsWith("-") || ["-q", "--quiet", "--short", "--no-recurse"].includes(arg)
    )
    if (hasWriteFlag || !validFlags || positional.length !== 1) {
      return "worktree isolation blocks modifying symbolic refs"
    }
  }
  if (
    subcommand === "stash" &&
    (args.length === 0 || !["list", "show"].includes(args[0].toLowerCase()))
  ) {
    return "worktree isolation blocks modifying the shared stash"
  }
  if (subcommand === "worktree" && (args.length === 0 || args[0].toLowerCase() !== "list")) {
    return "worktree isolation blocks creating, moving, or removing Git worktrees"
  }
  if (subcommand === "checkout") {
    const separator = args.indexOf("--")
    const branchFlags = new Set(["-b", "-B", "--detach", "--orphan", "--track"])
    const positionals = args.filter((arg) => !arg.startsWith("-"))
    const unambiguousCurrentTreePath =
      separator < 0 &&
      positionals.length === 1 &&
      (positionals[0] === "." ||
        positionals[0].startsWith("./") ||
        positionals[0].startsWith(".\\"))
    if (
      (separator < 0 && !unambiguousCurrentTreePath) ||
      separator === args.length - 1 ||
      args.slice(0, separator).some((arg) => branchFlags.has(arg))
    ) {
      return "worktree isolation blocks switching or creating branches with git checkout"
    }
  }
  if (
    subcommand === "branch" &&
    args.some((arg) =>
      ["-d", "-D", "--delete", "-f", "--force", "-m", "-M", "--move"].includes(arg)
    )
  ) {
    return "worktree isolation blocks deleting, force-moving, or renaming shared branches"
  }
  if (
    subcommand === "tag" &&
    args.some((arg) => ["-d", "--delete", "-f", "--force"].includes(arg))
  ) {
    return "worktree isolation blocks deleting or force-moving shared tags"
  }
  return null
}

/**
 * Best-effort, platform-independent guard for common worktree mistakes. Like
 * MiMo Code's isolated-git guard, this is not a shell security boundary: aliases,
 * wrapper scripts, complex environment mutations and obscure plumbing can evade
 * string-level inspection. It rejects direct cwd/Git metadata escapes with
 * actionable diagnostics, while a
 * configured OS sandbox remains optional defense in depth.
 */
export function getWorktreeShellIsolationViolation(
  command: string,
  cwd: string,
  boundary: WorkflowWorktreeIsolationBoundary,
  additionalExecutionRoots: readonly string[] = [],
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string | null {
  const executionRoots = [boundary.workspaceRoot, ...additionalExecutionRoots]
  if (!executionRoots.some((root) => isInsideWorktreeBoundary(cwd, root))) {
    return "worktree isolation blocks shell execution outside the assigned workspace or enabled skill"
  }
  const indirectPushInspection = inspectIndirectGitPush(command, shellSyntax)
  if (indirectPushInspection.containsPush) {
    return "worktree isolation push must be issued directly as `git push <remote> HEAD` for explicit approval"
  }
  if (indirectPushInspection.unverifiable) {
    return "worktree isolation blocks shell wrapper nesting that is too deep to verify"
  }
  let effectiveCwd = cwd
  const directoryStack: string[] = []
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    if (!tokens) continue
    const environmentMutationViolation = worktreeGitEnvironmentMutationViolation(
      tokens,
      shellSyntax
    )
    if (environmentMutationViolation) return environmentMutationViolation
    const wrappedScript = getWrappedShellScript(tokens)
    if (wrappedScript !== null) {
      // Native add/commit wrappers remain supported, but wrapping must not hide
      // an operation that the same script would be forbidden from running
      // directly (cwd escape, shared Git mutation, nested-repo write, etc.).
      const wrappedViolation = getWorktreeShellIsolationViolation(
        wrappedScript,
        effectiveCwd,
        boundary,
        additionalExecutionRoots,
        getWrappedShellSyntax(tokens) ?? shellSyntax
      )
      if (wrappedViolation) return wrappedViolation
    }
    const invocation = getExecutableInvocationTokens(tokens)
    const executable = normalizeExecutable(invocation[0] || "")
    if (executable === "popd") {
      if (invocation.length !== 1 || directoryStack.length === 0) {
        return "worktree isolation blocks an unverifiable popd"
      }
      effectiveCwd = directoryStack.pop()!
      continue
    }
    if (executable === "cd" || executable === "pushd") {
      const target = invocation[1] === "--" ? invocation[2] : invocation[1]
      if (!target || target === "-") {
        return "worktree isolation blocks an unverifiable shell directory change"
      }
      const nextCwd = resolveWorktreeCommandDirectory(effectiveCwd, target)
      if (!executionRoots.some((root) => isInsideWorktreeBoundary(nextCwd, root))) {
        return "worktree isolation blocks cd/pushd outside the assigned workspace or enabled skill"
      }
      if (executable === "pushd") directoryStack.push(effectiveCwd)
      effectiveCwd = nextCwd
      continue
    }

    const gitTokens = getGitInvocationTokens(tokens)
    if (gitTokens) {
      // getGitInvocationTokens deliberately removes shell/env prefixes to find
      // the executable, so inspect redirection before that information is lost.
      const environmentViolation = worktreeGitEnvironmentViolation(tokens)
      if (environmentViolation) return environmentViolation
      const gitViolation = inspectWorktreeGitInvocation(
        gitTokens,
        effectiveCwd,
        executionRoots,
        boundary.workspaceRoot,
        boundary.worktreeRoot,
        boundary.branch
      )
      if (gitViolation) return gitViolation
    }
  }
  return null
}

export function normalizeCdPrefixedGitCommitCommand(
  command: string,
  cwd: string
): { command: string; cwd: string } | null {
  if (!isChainedShellCommand(command)) return null
  const segments = splitShellCommandSegments(command)
  if (segments.length < 2) return null

  let effectiveCwd = cwd
  for (let i = 0; i < segments.length - 1; i++) {
    const nextCwd = resolveShellCdTarget(effectiveCwd, segments[i])
    if (!nextCwd) return null
    effectiveCwd = nextCwd
  }

  const commitCommand = segments[segments.length - 1]
  if (!isGitCommitCommand(commitCommand) || isChainedShellCommand(commitCommand)) return null
  return { command: commitCommand, cwd: effectiveCwd }
}

function hasUnsupportedGitRoutingContext(
  tokens: string[],
  gitTokens: string[],
  subcommandIndex: number
): boolean {
  const invocationPrefix = tokens.slice(0, tokens.length - gitTokens.length)
  if (invocationPrefix.some(isShellEnvAssignment)) {
    return true
  }
  const envIndex = invocationPrefix.findIndex((token) => normalizeExecutable(token) === "env")
  if (
    envIndex >= 0 &&
    invocationPrefix.slice(envIndex + 1).some((token) => token.startsWith("-") && token !== "--")
  ) {
    return true
  }

  const globalArgs = gitTokens.slice(1, subcommandIndex)
  let cwdOptionCount = 0
  for (let i = 0; i < globalArgs.length; i++) {
    const token = globalArgs[i]
    if (token === "-C") {
      const cwdValue = globalArgs[i + 1]
      if (!cwdValue) return true
      cwdOptionCount += 1
      if (cwdOptionCount > 1 || cwdValue.split(/[\\/]+/).includes("..")) return true
      i += 1
      continue
    }
    if (token.startsWith("-C") && token.length > 2) {
      const cwdValue = token.slice(2)
      cwdOptionCount += 1
      if (cwdOptionCount > 1 || cwdValue.split(/[\\/]+/).includes("..")) return true
      continue
    }
    return true
  }
  return false
}

function extractGitAddPathspecs(command: string): string[] | null {
  const tokens = tokenizeCommand(command)
  const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
  if (!tokens || !gitTokens) return null
  const subcommand = findGitSubcommand(gitTokens)
  if (!subcommand || subcommand.subcommand !== "add") return null
  if (hasUnsupportedGitRoutingContext(tokens, gitTokens, subcommand.index)) return null

  const pathspecs: string[] = []
  const args = gitTokens.slice(subcommand.index + 1)
  let pathspecMode = false
  for (const token of args) {
    if (pathspecMode) {
      if (!token) return null
      pathspecs.push(token)
      continue
    }
    if (token === "--") {
      pathspecMode = true
      continue
    }
    if (!token || token.startsWith("-")) return null
    pathspecs.push(token)
  }
  return Array.from(new Set(pathspecs))
}

export function normalizeGitAddPrefixedGitCommitCommand(
  command: string,
  cwd: string
): { command: string; cwd: string; filePaths: string[] } | null {
  if (!isChainedShellCommand(command)) return null
  const segments = splitShellCommandSegments(command)
  if (segments.length < 2) return null

  let shellCwd = cwd
  // Each add's pathspecs are recorded together with the cwd they were issued from, so we can
  // reject a chain whose adds span different directories (those pathspecs are relative to
  // different bases and cannot be represented by the single basePath the dialog receives).
  const collected: Array<{ cwd: string; pathspecs: string[] }> = []
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const nextCwd = resolveShellCdTarget(shellCwd, segment)
    if (nextCwd) {
      shellCwd = nextCwd
      continue
    }

    const addCwd = resolveGitCommandCwdForSubcommand(segment, shellCwd, "add")
    if (!addCwd) return null
    const addPathspecs = extractGitAddPathspecs(segment)
    if (!addPathspecs || addPathspecs.length === 0) return null
    collected.push({ cwd: addCwd, pathspecs: addPathspecs })
  }

  const commitCommand = segments[segments.length - 1]
  if (!isGitCommitCommand(commitCommand) || isChainedShellCommand(commitCommand)) return null
  const commitCwd = resolveGitCommandCwdForSubcommand(commitCommand, shellCwd, "commit")
  if (!commitCwd) return null
  // All adds must run at the same directory as the commit; otherwise the pathspecs would be
  // resolved against the wrong base. Refuse so the orchestrator tells the agent to split it.
  const resolvedCommitCwd = path.resolve(commitCwd)
  if (collected.some((entry) => path.resolve(entry.cwd) !== resolvedCommitCwd)) return null
  const filePaths = Array.from(new Set(collected.flatMap((entry) => entry.pathspecs)))
  return { command: commitCommand, cwd: commitCwd, filePaths }
}

/**
 * True for a history-rewriting force push. These stay gated behind an approval prompt
 * even in YOLO mode, since an unattended `git push --force` can destroy remote history.
 */
export function isForcePushCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
    if (!gitTokens) continue
    const subcommand = findGitSubcommand(gitTokens)
    if (!subcommand || subcommand.subcommand !== "push") continue
    const args = gitTokens.slice(subcommand.index + 1)
    if (args.some((arg) => /^(--force(?:-with-lease|-if-includes)?(?:=.*)?|-f)$/i.test(arg))) {
      return true
    }
  }
  return false
}

function resolveGitCommandCwdForSubcommand(
  command: string,
  cwd: string,
  targetSubcommand: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string | null {
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
    if (!gitTokens) continue
    const subcommand = findGitSubcommand(gitTokens)
    if (!subcommand || subcommand.subcommand !== targetSubcommand) continue

    let effectiveCwd = cwd
    for (let i = 1; i < subcommand.index; i++) {
      const token = gitTokens[i]
      const lower = token.toLowerCase()
      if (token === "-C") {
        const next = gitTokens[i + 1]
        if (next) {
          effectiveCwd = path.resolve(effectiveCwd, normalizeMsysPathForWindows(next))
          i += 1
        }
        continue
      }
      if (token.startsWith("-C") && token.length > 2) {
        effectiveCwd = path.resolve(effectiveCwd, normalizeMsysPathForWindows(token.slice(2)))
        continue
      }
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(lower)) {
        i += 1
      }
    }
    return effectiveCwd
  }
  return null
}

export function resolveGitCommandCwd(
  command: string,
  cwd: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string {
  return resolveGitCommandCwdForSubcommand(command, cwd, "commit", shellSyntax) ?? cwd
}

export function resolveGitPushCommandCwd(
  command: string,
  cwd: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string {
  return resolveGitCommandCwdForSubcommand(command, cwd, "push", shellSyntax) ?? cwd
}

/**
 * Best-effort extraction of the commit message the agent passed via `-m`/`--message`.
 * Used to pre-fill the task-card commit dialog. Returns undefined when no message arg
 * is present (e.g. `git commit` with an editor) or the command can't be tokenized.
 */
export function extractGitCommitMessage(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string | undefined {
  const tokens = tokenizeCommand(command, shellSyntax)
  if (!tokens) return undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--message") {
      const next = tokens[i + 1]
      if (typeof next === "string" && next) return next
      continue
    }
    if (token.startsWith("--message=")) return token.slice("--message=".length) || undefined
    // Short-option form. `-m` is the only message-bearing short flag for `git commit`,
    // so any non-`--` cluster containing `m` (e.g. `-m`, `-mMSG`, `-am`, `-am MSG`)
    // carries the message: text after `m` is the attached value, otherwise it's the
    // next token.
    if (token.startsWith("-") && !token.startsWith("--")) {
      const mIdx = token.indexOf("m", 1)
      if (mIdx > 0) {
        const attached = token.slice(mIdx + 1)
        if (attached) return attached
        const next = tokens[i + 1]
        if (typeof next === "string" && next) return next
      }
    }
  }
  return undefined
}

const GIT_COMMIT_LONG_OPTIONS_WITH_VALUE = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--message",
  "--pathspec-from-file",
  "--reuse-message",
  "--reedit-message",
  "--template",
  "--trailer"
])
const GIT_COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(["-c", "-C", "-F", "-m", "-t"])

function shortCommitValueFlagIndex(token: string): number {
  if (!token.startsWith("-") || token.startsWith("--")) return -1
  for (let i = 1; i < token.length; i++) {
    if (
      token[i] === "c" ||
      token[i] === "m" ||
      token[i] === "F" ||
      token[i] === "C" ||
      token[i] === "t"
    ) {
      return i
    }
  }
  return -1
}

function isGitCommitOptionWithInlineValue(token: string): boolean {
  const lower = token.toLowerCase()
  const shortValueFlagIndex = shortCommitValueFlagIndex(token)
  return (
    lower.startsWith("--author=") ||
    lower.startsWith("--cleanup=") ||
    lower.startsWith("--date=") ||
    lower.startsWith("--file=") ||
    lower.startsWith("--message=") ||
    lower.startsWith("--pathspec-from-file=") ||
    lower.startsWith("--reuse-message=") ||
    lower.startsWith("--reedit-message=") ||
    lower.startsWith("--template=") ||
    lower.startsWith("--trailer=") ||
    (shortValueFlagIndex > 0 && token.slice(shortValueFlagIndex + 1).length > 0)
  )
}

/**
 * Best-effort extraction of pathspecs from `git commit ... [--] <pathspec>...`.
 * The task-card dialog uses these as the agent's intended file selection. An empty
 * list is rejected by the orchestrator because restaging an indexed file could widen
 * a bare commit from its staged hunks to its complete working-tree contents.
 */
export function extractGitCommitPathspecs(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string[] {
  if (isChainedShellCommand(command, shellSyntax)) return []
  const tokens = tokenizeCommand(command, shellSyntax)
  const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
  if (!gitTokens) return []
  const subcommand = findGitSubcommand(gitTokens)
  if (!subcommand || subcommand.subcommand !== "commit") return []

  const pathspecs: string[] = []
  const args = gitTokens.slice(subcommand.index + 1)
  let pathspecMode = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    const lower = token.toLowerCase()

    if (pathspecMode) {
      if (token) pathspecs.push(token)
      continue
    }

    if (token === "--") {
      pathspecMode = true
      continue
    }

    const shortValueFlagIndex = shortCommitValueFlagIndex(token)
    if (
      GIT_COMMIT_LONG_OPTIONS_WITH_VALUE.has(lower) ||
      GIT_COMMIT_SHORT_OPTIONS_WITH_VALUE.has(token) ||
      (shortValueFlagIndex > 0 && token.slice(shortValueFlagIndex + 1).length === 0)
    ) {
      i += 1
      continue
    }

    if (isGitCommitOptionWithInlineValue(token)) {
      continue
    }

    if (token.startsWith("-")) {
      continue
    }

    pathspecs.push(token)
  }

  return Array.from(new Set(pathspecs.filter(Boolean)))
}

/**
 * True when a commit invocation contains options or repository coordinates the task-card
 * dialog cannot faithfully reproduce. Commit interception deliberately supports only
 * `-m`/`--message`, `-C`, and literal path arguments; everything else fails closed so a
 * Git dry-run, alternate index, abbreviated option, or malformed command can never turn
 * into a real commit with a broader file scope.
 */
export function hasUnsupportedGitCommitScope(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  if (hasUnsupportedCommitShellSyntax(command, shellSyntax)) return true
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
    if (!tokens || !gitTokens) continue
    const subcommand = findGitSubcommand(gitTokens)
    if (!subcommand || subcommand.subcommand !== "commit") continue

    if (hasUnsupportedGitRoutingContext(tokens, gitTokens, subcommand.index)) return true

    const args = gitTokens.slice(subcommand.index + 1)
    let pathspecMode = false
    for (let i = 0; i < args.length; i++) {
      const token = args[i]
      if (pathspecMode) {
        if (!token) return true
        continue
      }
      if (token === "--") {
        pathspecMode = true
        continue
      }
      if (!token) return true
      if (token === "--message" || token === "-m") {
        if (i + 1 >= args.length) return true
        i += 1
        continue
      }
      if (token.startsWith("--message=") || (token.startsWith("-m") && token.length > 2)) {
        continue
      }
      if (token.startsWith("-")) return true
    }
  }
  return false
}

function hasUnsupportedCommitShellSyntax(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  let quote: "'" | '"' | null = null
  let atWordStart = true
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    const next = command[index + 1]

    if (shellEscapeConsumesNext(char, next, quote, shellSyntax)) {
      index += 1
      atWordStart = false
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (quote === '"' && (char === "$" || char === "`")) {
        return true
      }
      continue
    }
    if (isShellQuote(char, shellSyntax)) {
      quote = char
      atWordStart = false
      continue
    }
    if (/\s/.test(char)) {
      atWordStart = true
      continue
    }
    if (char === "#" && atWordStart) return true
    if (char === "<" || char === ">" || char === "$" || char === "`") return true
    if (char === "(" || char === ")") return true
    if (shellSyntax === "posix" && char === "{") return true
    if (atWordStart && char === "~") return true
    if (shellSyntax === "powershell" || shellSyntax === "cmd") {
      if (char === "^" || (char === "%" && command.indexOf("%", index + 1) > index + 1)) {
        return true
      }
      if (atWordStart && char === "@") return true
    }
    atWordStart = false
  }
  return false
}

/**
 * True when a `git commit` invocation rewrites or amends an existing commit
 * (`--amend`, `--fixup`, `--squash`). The task-card commit dialog only ever creates a
 * fresh commit, so these must not be silently turned into a new commit.
 */
export function isAmendOrFixupCommit(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): boolean {
  for (const segment of splitShellCommandSegments(command, shellSyntax)) {
    const tokens = tokenizeCommand(segment, shellSyntax)
    const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
    if (!gitTokens) continue
    const subcommand = findGitSubcommand(gitTokens)
    if (!subcommand || subcommand.subcommand !== "commit") continue

    const args = gitTokens.slice(subcommand.index + 1)
    let pathspecMode = false
    for (let i = 0; i < args.length; i++) {
      const token = args[i]
      const lower = token.toLowerCase()
      if (pathspecMode) continue
      if (token === "--") {
        pathspecMode = true
        continue
      }
      // Real option (not the *value* of a preceding -m/-F/--message/...). Matching here
      // keeps `git commit -m --amend` (where `--amend` is the message) from being misread
      // as an amend.
      if (/^--(amend|fixup|squash)(=.*)?$/.test(lower)) return true
      // Skip value-bearing options so their value isn't scanned as an option.
      const shortValueFlagIndex = shortCommitValueFlagIndex(token)
      if (
        GIT_COMMIT_LONG_OPTIONS_WITH_VALUE.has(lower) ||
        GIT_COMMIT_SHORT_OPTIONS_WITH_VALUE.has(token) ||
        (shortValueFlagIndex > 0 && token.slice(shortValueFlagIndex + 1).length === 0)
      ) {
        i += 1
      }
    }
  }
  return false
}

export function derivePermanentApprovalPattern(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (/&&|\|\||[|;&`<>]|\$\(|\n/.test(trimmed)) return null
  if (FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(trimmed))) return null
  if (DANGEROUS_INDICATORS.some(({ pattern }) => pattern.test(trimmed))) return null

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) return null
  if (
    tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))
  ) {
    return null
  }
  if (!PERSISTABLE_EXECUTABLES.has(normalizeExecutable(tokens[0]))) return null
  if (isBannedPersistentPrefix(tokens)) return null

  return `${APPROVAL_PREFIX_RULE_PREFIX}${JSON.stringify(tokens)}`
}

export function matchesApprovalPattern(pattern: string, command: string): boolean {
  // File operation pattern matching: "file:write_file:/dir/*" or "file:edit_file:/dir/*"
  if (pattern.startsWith("file:")) {
    if (!command.startsWith("file:")) return false
    // pattern = "file:write_file:/some/dir/*", command = "file:write_file:/some/dir/foo.ts"
    const patternParts = pattern.split(":") // ["file", "write_file", "/some/dir/*"]
    const commandParts = command.split(":") // ["file", "write_file", "/some/dir/foo.ts"]
    if (patternParts.length < 3 || commandParts.length < 3) return false
    if (patternParts[1] !== commandParts[1]) return false // operation must match
    const patternPath = patternParts.slice(2).join(":").replace(/\\/g, "/")
    const commandPath = commandParts.slice(2).join(":").replace(/\\/g, "/")
    // "dir/*" → check if commandPath starts with "dir/"
    if (patternPath.endsWith("/*")) {
      const dirPrefix = patternPath.slice(0, -1) // "dir/"
      return commandPath.startsWith(dirPrefix) || commandPath === dirPrefix.slice(0, -1)
    }
    return patternPath === commandPath
  }

  if (pattern.startsWith(APPROVAL_PREFIX_RULE_PREFIX)) {
    const prefixTokens = parseApprovalPattern(pattern)
    const commandTokens = tokenizeCommand(command.trim())
    if (!prefixTokens || !commandTokens || commandTokens.length < prefixTokens.length) {
      return false
    }
    return prefixTokens.every((token, index) => commandTokens[index] === token)
  }

  return pattern === command.trim()
}

function isKnownSafeCommand(command: string): boolean {
  const tokens = tokenizeCommand(command)
  if (!tokens || tokens.length === 0) return false

  if (
    tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))
  ) {
    return false
  }

  for (const token of tokens) {
    const normalized = token
      .trim()
      .replace(/^[('"]+|[)'"]+$/g, "")
      .replace(/^-+/, "")
      .toLowerCase()
    if (SIDE_EFFECTING_POWERSHELL_CMDLETS.has(normalized)) {
      return false
    }
  }

  const executable = normalizeExecutable(tokens[0])
  if (!executable) return false

  // `env` and `awk` are NOT unconditionally safe: `env CMD` runs CMD, and awk can
  // shell out / write files. Evaluate them specially (see helpers) instead of
  // treating the executable name alone as read-only.
  if (executable === "env") return isSafeEnvPrefix(tokens)
  if (executable === "awk") return isSafeAwk(tokens)

  // Several otherwise-safe executables have a WRITE / system-change flag the plain
  // SAFE_EXECUTABLES membership check would wave through: `sort -o`/`tree -o`/
  // `base64 -o` write a file, `date -s` sets the clock, and the network tools
  // arp/route/netsh/ipconfig have mutate verbs (arp -d, route add, netsh … set,
  // ipconfig /flushdns). Reject the offending flag/verb PER COMMAND (shared with
  // the Windows gate); read-only forms (no such flag) stay safe.
  if (hasUnsafeWriteFlag(executable, tokens)) return false

  if (isSafeBase64(tokens)) return true
  if (SAFE_EXECUTABLES.has(executable)) return true
  if (isSafeFind(tokens)) return true
  if (isSafeRipgrep(tokens)) return true
  if (isSafeGit(tokens)) return true
  if (isSafeSed(tokens)) return true
  if (isSafeBuildTool(executable, tokens)) return true

  return false
}

/**
 * `env` is a transparent prefix: `env [NAME=val...] CMD ...` runs CMD. It is safe
 * only if the wrapped command is itself safe AND no env-var assignments are
 * applied to it. Plain `env` or `env VAR=val` (no command) just set/list the
 * environment → safe. But `env VAR=val CMD` runs CMD with VAR set, and an
 * assignment can redirect/inject code (PATH=/tmp/evil, LD_PRELOAD=…, NODE_OPTIONS=…,
 * PYTHONPATH=…) into an otherwise-safe binary — `env LD_PRELOAD=x.so cat f` then
 * runs attacker code. "safe" means "no user approval needed", so an
 * assignment-carrying command must NOT be auto-approved (require review). Flags
 * before the command (-i/-u/-S/-C…) can change behaviour too → review.
 */
function isSafeEnvPrefix(tokens: string[]): boolean {
  const rest = tokens.slice(1)
  let i = 0
  while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])) i++
  if (i >= rest.length) return true // `env` / `env VAR=val` only — no command run
  if (i > 0) return false // assignment(s) + a command → could inject (PATH/LD_PRELOAD/…) → review
  if (rest[i].startsWith("-")) return false // env flags wrapping a command → review
  return isKnownSafeCommand(rest.slice(i).join(" ")) // wrapped command (no assignments) must be safe
}

/**
 * awk can execute commands (`system()`, `getline cmd`, `| "cmd"`) and write files
 * (`print > "file"`), so it is not unconditionally read-only. Plain
 * field-processing awk stays safe; reject the dangerous constructs and external
 * program files (`-f script.awk`, whose contents can't be inspected here).
 */
function isSafeAwk(tokens: string[]): boolean {
  // Reject flags that load EXTERNAL/uninspectable code or WRITE files — these
  // defeat the inline-program scan below:
  //   -f/--file, -E/--exec       load a program file (can system()/write)
  //   -i/--include               gawk include lib (`-i inplace` edits in place)
  //   -l/--load                  gawk shared-lib load (arbitrary native code)
  //   -o/--pretty-print, -p/--profile   write files
  //   -d/--dump-variables, -D/--debug   write a variables dump file / debugger
  // Short forms may attach a value (-fscript, -iinplace, -dvars.out). Safe flags
  // like -F (field sep), -v (assign), -b/-n stay allowed (program still scanned).
  for (const t of tokens.slice(1)) {
    if (/^-[fEilopdD]/.test(t)) return false
    if (/^--(file|exec|include|load|pretty-print|profile|debug|dump-variables)(=|$)/.test(t))
      return false
  }
  const joined = tokens.join(" ")
  return !/system\s*\(|getline|>\s*"|>>\s*"|\|\s*"|"\s*\|/.test(joined)
}

// ── Safe build tool checks (mirrors windows-safe-commands.ts) ───────────────

const UNSAFE_MVN_GOALS = new Set(["deploy", "site-deploy"])
const UNSAFE_MVN_GOAL_PREFIXES = ["exec:", "release:", "deploy:", "wagon:", "scm:"]
const UNSAFE_GRADLE_TASKS = new Set(["publish", "publishtomavenlocal", "uploadarchives"])
const UNSAFE_NPM_SUBCOMMANDS = new Set([
  "publish",
  "unpublish",
  "deprecate",
  "dist-tag",
  "access",
  "exec",
  "x"
])
const UNSAFE_CARGO_SUBCOMMANDS = new Set(["publish", "yank", "login", "logout"])
const SAFE_GO_SUBCOMMANDS = new Set([
  "build",
  "clean",
  "doc",
  "env",
  "fmt",
  "generate",
  "get",
  "install",
  "list",
  "mod",
  "run",
  "test",
  "tool",
  "version",
  "vet"
])
const UNSAFE_DOTNET_SUBCOMMANDS = new Set(["nuget", "publish"])

function isSafeBuildTool(executable: string, tokens: string[]): boolean {
  switch (executable) {
    case "mvn":
    case "mvnw":
      return isSafeMvn(tokens)
    case "gradle":
    case "gradlew":
      return isSafeGradle(tokens)
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return tokens.length >= 2 && !UNSAFE_NPM_SUBCOMMANDS.has(tokens[1].toLowerCase())
    case "cargo":
      return tokens.length >= 2 && !UNSAFE_CARGO_SUBCOMMANDS.has(tokens[1].toLowerCase())
    case "go":
      return tokens.length >= 2 && SAFE_GO_SUBCOMMANDS.has(tokens[1].toLowerCase())
    case "dotnet":
      return tokens.length >= 2 && !UNSAFE_DOTNET_SUBCOMMANDS.has(tokens[1].toLowerCase())
    case "make":
    case "cmake":
    case "java":
    case "javac":
      return true
    default:
      return false
  }
}

function isSafeMvn(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i]
    if (arg.startsWith("-")) continue
    const lower = arg.toLowerCase()
    if (UNSAFE_MVN_GOALS.has(lower)) return false
    if (UNSAFE_MVN_GOAL_PREFIXES.some((p) => lower.startsWith(p))) return false
  }
  return true
}

function isSafeGradle(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i]
    if (arg.startsWith("-")) continue
    if (UNSAFE_GRADLE_TASKS.has(arg.toLowerCase())) return false
  }
  return true
}

// ── Read-only shell gate (stricter than "safe") ─────────────────────────────
//
// assessCommandSafety's "safe" tier means "auto-approve" (no user prompt) — NOT
// "no side effects". It deliberately auto-approves build/package/codegen tools
// (npm install, cargo build, make, go run, javac …) because for a normal
// write-capable agent those are routine. A READ-ONLY agent/worker must NOT run
// them: they write node_modules/target/build artifacts/lockfiles or execute
// arbitrary project code (test suites, run scripts, go run, java). isReadOnly-
// ShellCommand below keeps every genuinely read-only "safe" command (ls / cat /
// grep / find / rg / git log|diff|status / sed-read / base64-decode … — none of
// which is a build tool) and additionally blocks build-tool invocations that
// aren't pure inspection. The tools' READ-ONLY subcommands (npm ls, go list,
// cargo tree, mvn dependency:tree, gradle dependencies …) stay allowed so
// inspection isn't false-killed. The build-tool read/write classification lives
// in read-only-build-tool.ts so this gate and the Windows/PowerShell gate
// (windows-safe-commands.ts) agree.

// Nested shell interpreters OTHER than PowerShell: these run an ARBITRARY inner
// command this per-command gate can't introspect (e.g. `bash -c "npm install"`,
// `cmd /c …`, `powershell -Command "npm install"`). They are blocked in the strict
// path below. NOTE: a Windows-PowerShell command (a bare cmdlet OR a
// `powershell -Command "<x>"` wrapper) is validated FIRST by isReadOnlyWindowsCommand
// (which re-checks every parsed sub-command is read-only); only if that rejects it
// does it reach here and get blocked. So `powershell -Command "Get-Content x"` /
// "npm ls" stay allowed while "npm install" / a non-read inner are blocked.
const SHELL_INTERPRETER_EXECUTABLES = new Set([
  "cmd",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "wsl",
  "powershell",
  "pwsh"
])

/**
 * Stricter than assessCommandSafety's "safe": a command is read-only-shell-safe
 * iff it is auto-approve "safe" AND, when it invokes a build/package/codegen
 * tool, that invocation is pure inspection. Used to gate the execute tool for
 * read-only agents/workers.
 *
 * `windowsShell` tells the gate which shell the command runs in. On Windows
 * PowerShell, bare read-only cmdlets (Get-Content, Select-String …) aren't in the
 * cross-platform "safe" set, so they'd be false-blocked unless we know the shell.
 * Callers that know the runtime shell pass it (the runtime derives it from the
 * sandbox); it defaults to "unknown" (the strict cross-platform behavior).
 *
 * NOTE: the strict path's "safe" requires a SINGLE command with no shell
 * metacharacters (&&, ||, |, …), so compound/redirected commands are rejected
 * there. The Windows path uses isReadOnlyWindowsCommand, which validates EVERY
 * parsed sub-command is read-only — so a compound only passes if both halves are
 * read-only (it can't be used to tunnel a build/write).
 */
export function isReadOnlyShellCommand(
  command: string,
  cwd: string,
  windowsShell: WindowsShellKind = "unknown"
): boolean {
  // Windows-PowerShell path FIRST: recognizes bare read-only cmdlets AND a
  // `powershell -Command "<x>"` wrapper, re-validating every parsed sub-command is
  // read-only. Returns false off win32 (process.platform guard), so the strict
  // cross-platform path below is unchanged on macOS/Linux. We do NOT pass
  // windowsShell to assessCommandSafety: its PowerShell parser would treat some
  // compound forms as "safe", which the single-command refinement can't vet.
  if (isReadOnlyWindowsCommand(command, windowsShell)) return true
  // Cross-platform strict path.
  if (assessCommandSafety(command, cwd).level !== "safe") return false
  const tokens = tokenizeCommand(command.trim())
  if (!tokens || tokens.length === 0) return true
  // A PATH-QUALIFIED executable (./ls, /usr/bin/cat, /tmp/x/ls, ./gradlew) is NOT
  // the known system command — assessCommandSafety identifies commands by
  // path.basename(), so a repo-local `./ls` (or any binary whose basename matches
  // a safe name) would be auto-"safe" yet run arbitrary code. A read-only agent
  // can't assume its content is read-only, so require a BARE name resolved via
  // PATH to the known binary. (Also blocks project scripts like ./gradlew.)
  if (isPathQualifiedExecutable(tokens[0])) return false
  // powershell/pwsh that reached here weren't accepted as read-only by
  // isReadOnlyWindowsCommand above (non-read inner, or off-win32) → block them
  // (they're in SHELL_INTERPRETER_EXECUTABLES, handled by isReadOnlyTokenizedCommand).
  return isReadOnlyTokenizedCommand(tokens)
}

/** True when the executable token is path-qualified (contains a `/` or `\`),
 * e.g. `./ls`, `/usr/bin/cat`, `/tmp/x/ls`, `./gradlew`. Such a binary's identity
 * is not the known system command, so it must not pass the read-only gate. */
function isPathQualifiedExecutable(token: string): boolean {
  return /[\\/]/.test(token)
}

/** Read-only dispatch over an already-tokenized SINGLE command (no shell
 * metacharacters — guaranteed by the "safe" check upstream). Split out so the
 * `env` transparent prefix can recurse on the wrapped command. */
function isReadOnlyTokenizedCommand(tokens: string[]): boolean {
  // Re-apply the path-qualified guard on each (possibly env-unwrapped) command so
  // `env /tmp/x/ls` / `/usr/bin/env …` can't tunnel a path-qualified binary.
  if (isPathQualifiedExecutable(tokens[0])) return false
  const executable = normalizeExecutable(tokens[0])
  // `printenv [KEY]` prints environment variables (secrets) to stdout — never
  // read-only-safe for an untrusted read-only agent, with or without an arg.
  // (`env` is handled as a transparent prefix just below.)
  if (executable === "printenv") return false
  // echo / printf write their arguments straight to stdout, so a `$VAR` argument
  // prints the EXPANDED value — `echo $OPENAI_API_KEY` / `printf %s $TOKEN` leak a
  // secret this gate can't vet: there is no resolved file PATH to check (unlike
  // `cat $VAR`, which the sensitive-path gate handles). Refuse `$` in their tokens.
  // Over-blocks a literal single-quoted `echo '$x'` too — a safe trade for an agent
  // that virtually never needs it. cat/grep/ls keep `$` expansion (path-vetted).
  if ((executable === "echo" || executable === "printf") && tokens.some((t) => t.includes("$"))) {
    return false
  }
  // `env [VAR=val...] CMD …` is a TRANSPARENT PREFIX that runs CMD —
  // assessCommandSafety already verified the wrapped command is safe and that
  // there are no env flags (which would make it non-safe). Without unwrapping,
  // `env npm install` slips through here because `env` isn't a build tool.
  if (executable === "env") {
    const rest = tokens.slice(1)
    // REJECT any env-var ASSIGNMENT: `env PATH=/tmp/evil ls` redirects a bare name
    // to another binary, and `env LD_PRELOAD=… / NODE_OPTIONS=… / PYTHONPATH=… cmd`
    // injects code into an otherwise-safe binary. A read-only agent can't vet
    // these, so allow only bare `env` (lists the environment) or `env CMD` with no
    // assignments; the inner CMD is still checked by the recursion.
    if (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) return false
    // bare `env` dumps ALL environment variables (incl. secrets) to stdout — refuse
    // it for a read-only agent (env-secret exfil). `env CMD …` is still a transparent
    // prefix and recurses below; the inner CMD is what gets vetted.
    if (rest.length === 0) return false
    return isReadOnlyTokenizedCommand(rest)
  }
  // Other nested shells (bash -c, cmd /c, …) can't be introspected here and are
  // not auto-"safe" anyway — block as belt-and-suspenders.
  if (SHELL_INTERPRETER_EXECUTABLES.has(executable)) return false
  // Every "safe" command that isn't a build tool is genuinely read-only (ls /
  // cat / grep / find / rg / git log|diff|status / sed-read / base64-decode …).
  if (!BUILD_TOOL_EXECUTABLES.has(executable)) return true
  return isReadOnlyBuildToolInvocation(executable, tokens)
}

function tokenizeCommand(
  command: string,
  shellSyntax: CommandShellSyntax = hostShellSyntax()
): string[] | null {
  const tokens: string[] = []
  let current = ""
  let tokenStarted = false
  let quote: "'" | '"' | null = null
  let escaped = false

  const pushCurrent = (): void => {
    if (shellSyntax === "cmd" && tokens.length === 0 && /^@+$/.test(current)) {
      current = ""
      tokenStarted = false
      return
    }
    const token =
      shellSyntax === "cmd" && tokens.length === 0 ? current.replace(/^@+/, "") : current
    tokens.push(token)
    current = ""
    tokenStarted = false
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (escaped) {
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && command[i + 1] === "\n") i += 1
        escaped = false
        continue
      }
      current += ch
      tokenStarted = true
      escaped = false
      continue
    }

    if (shellEscapeConsumesNext(ch, command[i + 1], quote, shellSyntax)) {
      escaped = true
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (isShellQuote(ch, shellSyntax)) {
      quote = ch
      tokenStarted = true
      continue
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        pushCurrent()
      }
      continue
    }

    current += ch
    tokenStarted = true
  }

  if (escaped || quote) return null
  if (tokenStarted) pushCurrent()
  return tokens
}

/** A file-relocating / file-deleting operation parsed out of a shell command. */
export interface ShellFileOp {
  op: "rm" | "mv"
  /**
   * Raw (unresolved) source path operands. For `rm` these are the delete
   * targets; for `mv` they are every operand except the last. Callers resolve
   * them against the command's cwd.
   */
  paths: string[]
  /** Raw `mv` destination (last operand); undefined for `rm`. */
  dest?: string
}

const SHELL_SEGMENT_SEPARATORS = new Set(["&&", "||", ";", "|", "&"])

/**
 * Best-effort extraction of `rm` / `mv` (incl. `git rm` / `git mv`) operations
 * from a shell command, so the adoption tracker can react to an agent deleting
 * or relocating a generated file BEFORE it is committed (path-keyed attribution
 * would otherwise orphan the pending generation).
 *
 * Conservative by design — a missed op merely degrades to existing behaviour,
 * whereas a wrong op corrupts adoption data, so we err toward parsing nothing:
 *   - malformed quoting (tokeniser returns null) → no ops;
 *   - command separators (`;` `&&` `||` `|` `&`) are split into segments even
 *     when glued (`rm a.ts;mv b c`), and each segment is parsed independently;
 *   - a segment with an unresolvable construct (command substitution, redirect,
 *     subshell) is skipped rather than guessed;
 *   - flags are skipped; `--` ends option parsing;
 *   - the `mv -t DIR` / `--target-directory` form (which inverts operand order)
 *     is skipped rather than mis-parsed.
 * Glob operands are returned as-is; the caller skips ones it cannot resolve.
 */
export function extractShellFileOps(command: string): ShellFileOp[] {
  if (!command || typeof command !== "string") return []
  const tokens = tokenizeFileOpCommand(command)
  if (!tokens || tokens.length === 0) return []

  const ops: ShellFileOp[] = []
  let segment: string[] = []
  const flush = (): void => {
    if (segment.length > 0) {
      const op = parseFileOpSegment(segment)
      if (op) ops.push(op)
    }
    segment = []
  }
  for (const tok of tokens) {
    if (SHELL_SEGMENT_SEPARATORS.has(tok)) flush()
    else segment.push(tok)
  }
  flush()
  return ops
}

/**
 * Tokenise a command for file-op extraction. Differs from the safety tokeniser
 * in one way that matters for Windows: inside double quotes a backslash is
 * literal UNLESS it escapes a shell-special char (`$ \` " \\` or newline), so a
 * path like `"D:\proj\src"` survives intact instead of collapsing to
 * `D:projsrc`. (bash's double-quote rule; the safety tokeniser eats every `\`.)
 * Returns null on unbalanced quoting/escape so callers parse nothing.
 */
function tokenizeFileOpCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = command[i + 1]
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          escaped = true
        } else {
          current += ch // literal backslash (e.g. a Windows path separator)
        }
        continue
      }
      if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    // Command separators become standalone tokens even when glued to a path
    // (`rm a.ts;mv b c`, `a&&b`) so a compound command segments correctly
    // instead of being dropped — LLMs routinely write `;` with no leading space.
    if (ch === ";" || ch === "&" || ch === "|") {
      if (current) {
        tokens.push(current)
        current = ""
      }
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        tokens.push(ch + ch)
        i++
      } else {
        tokens.push(ch)
      }
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }

  if (escaped || quote) return null
  if (current) tokens.push(current)
  return tokens
}

function parseFileOpSegment(tokens: string[]): ShellFileOp | null {
  // Command separators are already split into their own tokens by the tokeniser
  // (even when glued), so a control metacharacter still present inside a token
  // means something we cannot resolve to a concrete path: command substitution
  // (`$(...)` / backticks), redirects (`>` `<`), a subshell (`( )`), or a rare
  // quoted-operator filename. Parse nothing for that segment — a miss only
  // degrades to existing behaviour, whereas guessing would void/transfer an
  // unrelated generation and corrupt adoption data.
  for (const tok of tokens) {
    if (/[;&|`$<>()]/.test(tok)) return null
  }

  let idx = 0
  // Skip a leading env-assignment prefix (e.g. `FOO=bar rm x`).
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++
  if (idx >= tokens.length) return null

  let exe = normalizeExecutable(tokens[idx])
  idx++
  if (exe === "git") {
    if (idx >= tokens.length) return null
    const sub = tokens[idx].toLowerCase()
    if (sub !== "rm" && sub !== "mv") return null
    exe = sub
    idx++
  }
  if (exe !== "rm" && exe !== "mv") return null

  const operands: string[] = []
  let endOfOptions = false
  let hasTargetDirFlag = false
  for (; idx < tokens.length; idx++) {
    const tok = tokens[idx]
    if (!endOfOptions && tok === "--") {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && tok.length > 1 && tok.startsWith("-")) {
      if (tok === "-t" || tok === "--target-directory" || tok.startsWith("--target-directory=")) {
        hasTargetDirFlag = true
      }
      continue
    }
    operands.push(tok)
  }
  if (hasTargetDirFlag) return null

  if (exe === "rm") {
    return operands.length > 0 ? { op: "rm", paths: operands } : null
  }
  // mv needs at least one source + a destination.
  if (operands.length < 2) return null
  return { op: "mv", paths: operands.slice(0, -1), dest: operands[operands.length - 1] }
}

function parseApprovalPattern(pattern: string): string[] | null {
  if (!pattern.startsWith(APPROVAL_PREFIX_RULE_PREFIX)) return null
  try {
    const parsed = JSON.parse(pattern.slice(APPROVAL_PREFIX_RULE_PREFIX.length)) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((item) => typeof item !== "string")
    ) {
      return null
    }
    return parsed as string[]
  } catch {
    return null
  }
}

function isBannedPersistentPrefix(tokens: string[]): boolean {
  const normalized = tokens.map((token, index) => {
    if (index === 0) return normalizeExecutable(token)
    return token.toLowerCase()
  })

  return BANNED_PERSISTENT_PREFIXES.some(
    (banned) =>
      banned.length <= normalized.length &&
      banned.every((token, index) => normalized[index] === token)
  )
}

function normalizeExecutable(raw: string): string {
  const base = path.basename(raw).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|com)$/i, "")
}

function isSafeFind(tokens: string[]): boolean {
  if (normalizeExecutable(tokens[0]) !== "find") return false
  return !tokens.some((token) => UNSAFE_FIND_OPTIONS.has(token.toLowerCase()))
}

function isSafeRipgrep(tokens: string[]): boolean {
  if (normalizeExecutable(tokens[0]) !== "rg") return false
  return !tokens.some((token) => {
    const lower = token.toLowerCase()
    return (
      UNSAFE_RIPGREP_FLAGS.has(lower) ||
      UNSAFE_RIPGREP_FLAGS_WITH_VALUES.some(
        (flag) => lower === flag || lower.startsWith(flag + "=")
      )
    )
  })
}

function isSafeGit(tokens: string[]): boolean {
  if (normalizeExecutable(tokens[0]) !== "git") return false
  if (hasGitConfigOverride(tokens)) return false

  const subcommandInfo = findGitSubcommand(tokens)
  if (!subcommandInfo) return false

  const { index, subcommand } = subcommandInfo
  const args = tokens.slice(index + 1)
  if (!gitArgsAreReadOnly(args)) return false

  switch (subcommand) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "cat-file":
      return true
    case "branch":
      return gitBranchIsReadOnly(args)
    default:
      return false
  }
}

function hasGitConfigOverride(tokens: string[]): boolean {
  return tokens.some((token) => {
    const lower = token.toLowerCase()
    return (
      lower === "-c" ||
      lower === "--config-env" ||
      lower.startsWith("-c") ||
      lower.startsWith("--config-env=")
    )
  })
}

function findGitSubcommand(tokens: string[]): { index: number; subcommand: string } | null {
  let skipNext = false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    const lower = token.toLowerCase()

    if (skipNext) {
      skipNext = false
      continue
    }

    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(lower)) {
      skipNext = true
      continue
    }

    if (
      lower.startsWith("--config-env=") ||
      lower.startsWith("--exec-path=") ||
      lower.startsWith("--git-dir=") ||
      lower.startsWith("--namespace=") ||
      lower.startsWith("--super-prefix=") ||
      lower.startsWith("--work-tree=") ||
      (lower.startsWith("-c") && lower.length > 2)
    ) {
      continue
    }

    if (token === "--" || token.startsWith("-")) continue

    return { index: i, subcommand: lower }
  }

  return null
}

function gitArgsAreReadOnly(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return (
      UNSAFE_GIT_FLAGS.has(lower) || lower.startsWith("--output=") || lower.startsWith("--exec=")
    )
  })
}

function gitBranchIsReadOnly(args: string[]): boolean {
  if (args.length === 0) return true

  let sawReadOnlyFlag = false
  for (const arg of args) {
    const lower = arg.toLowerCase()
    switch (lower) {
      case "--list":
      case "-l":
      case "--show-current":
      case "-a":
      case "--all":
      case "-r":
      case "--remotes":
      case "-v":
      case "-vv":
      case "--verbose":
        sawReadOnlyFlag = true
        break
      default:
        if (lower.startsWith("--format=")) {
          sawReadOnlyFlag = true
          break
        }
        return false
    }
  }

  return sawReadOnlyFlag
}

function isSafeSed(tokens: string[]): boolean {
  if (normalizeExecutable(tokens[0]) !== "sed") return false
  if (tokens.length < 3 || tokens.length > 4) return false
  if (tokens[1] !== "-n") return false
  return /^(\d+,)?\d+p$/.test(tokens[2])
}

function isSafeBase64(tokens: string[]): boolean {
  if (normalizeExecutable(tokens[0]) !== "base64") return false
  return !tokens.slice(1).some((token) => {
    const lower = token.toLowerCase()
    return (
      lower === "-o" ||
      lower === "--output" ||
      lower.startsWith("--output=") ||
      (lower.startsWith("-o") && lower !== "-o")
    )
  })
}
