/**
 * Command safety policy engine.
 *
 * Classifies shell commands into safe / needs_approval / forbidden categories
 * based on pattern matching. Modelled after codex-rs is_known_safe_command()
 * and command_might_be_dangerous().
 */

import path from "node:path"
import type { ExecSafetyLevel } from "../types"
import {
  isKnownSafeWindowsCommand,
  isReadOnlyWindowsCommand,
  type WindowsShellKind
} from "./windows-safe-commands"
import { BUILD_TOOL_EXECUTABLES, isReadOnlyBuildToolInvocation, hasUnsafeWriteFlag } from "./read-only-build-tool"

export interface SafetyAssessment {
  level: ExecSafetyLevel
  reason?: string
}

export type CommandConcurrencyClassification = "parallel_safe" | "exclusive"

const APPROVAL_PREFIX_RULE_PREFIX = "prefix:"

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
  options?: { windowsShell?: WindowsShellKind; enforceGitWorkflowCommitOnly?: boolean }
): SafetyAssessment {
  const trimmed = command.trim()
  if (!trimmed) {
    return { level: "safe" }
  }

  if (options?.enforceGitWorkflowCommitOnly && containsDirectGitSubmitCommand(trimmed)) {
    return {
      level: "forbidden",
      reason:
        "git_workflow tool is available — use git_workflow instead of direct git add/commit/push"
    }
  }

  if (containsWrappedGitCommitCommand(trimmed)) {
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
function stripQuotedSpans(command: string): string {
  // Double-quoted spans honour backslash escapes (`"a\" && b"` is one argument), so an
  // escaped quote can't prematurely end the span and leak a `&&` into chain detection.
  // POSIX single-quoted spans take no escapes, so a plain `'[^']*'` is exact there.
  return command
    .replace(/"(?:\\.|[^"\\])*"/g, " __quoted_arg__ ")
    .replace(/'[^']*'/g, " __quoted_arg__ ")
}

const GIT_SUBMIT_SUBCOMMANDS = new Set(["add", "commit", "push", "merge"])
const POSIX_SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"])
const POWERSHELL_WRAPPERS = new Set(["pwsh", "powershell"])
const CMD_WRAPPERS = new Set(["cmd"])

function containsDirectGitSubmitCommand(command: string): boolean {
  return commandHasGitSubcommand(command, GIT_SUBMIT_SUBCOMMANDS)
}

function splitShellCommandSegments(command: string): string[] {
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
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\" && quote !== "'") {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === "'" || ch === "\"") {
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

function backslashEscapesNextChar(next: string | undefined, quote: "'" | '"' | null): boolean {
  if (!next) return false
  if (/\s/.test(next)) return true
  if (quote === "\"") return next === "\"" || next === "\\" || next === "$" || next === "`"
  return next === "'" || next === "\"" || next === "\\" || "$`;&|<>".includes(next)
}

function getGitInvocationTokens(tokens: string[]): string[] | null {
  const invocation = getExecutableInvocationTokens(tokens)
  return normalizeExecutable(invocation[0] || "") === "git" ? invocation : null
}

function getExecutableInvocationTokens(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && isShellEnvAssignment(tokens[index])) index += 1

  if (normalizeExecutable(tokens[index] || "") === "command") {
    index += 1
  }

  if (normalizeExecutable(tokens[index] || "") === "env") {
    index += 1
    while (index < tokens.length) {
      const token = tokens[index]
      const lower = token.toLowerCase()
      if (isShellEnvAssignment(token)) {
        index += 1
        continue
      }
      if (lower === "--") {
        index += 1
        break
      }
      if (lower === "-u" || lower === "--unset" || lower === "-s" || lower === "-S") {
        index += 2
        continue
      }
      if (
        lower === "-i" ||
        lower === "-" ||
        lower.startsWith("-u") ||
        lower.startsWith("--unset=") ||
        lower.startsWith("--ignore-environment")
      ) {
        index += 1
        continue
      }
      break
    }
  }

  return tokens.slice(index)
}

function getWrappedShellScript(tokens: string[]): string | null {
  const invocation = getExecutableInvocationTokens(tokens)
  const executable = normalizeExecutable(invocation[0] || "")

  if (POSIX_SHELL_WRAPPERS.has(executable)) {
    for (let i = 1; i < invocation.length; i++) {
      const token = invocation[i]
      if (!token.startsWith("-")) break
      if (token === "--") break
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
      if (lower === "-c" || lower === "-command") return invocation[i + 1] || null
    }
    return null
  }

  if (CMD_WRAPPERS.has(executable)) {
    for (let i = 1; i < invocation.length; i++) {
      const lower = invocation[i].toLowerCase()
      if (lower === "/c" || lower === "/k") return invocation.slice(i + 1).join(" ") || null
    }
  }

  return null
}

function containsWrappedGitCommitCommand(command: string, depth = 0): boolean {
  if (depth > 3) return false
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeCommand(segment)
    if (!tokens) continue
    const script = getWrappedShellScript(tokens)
    if (!script) continue
    if (isGitCommitCommand(script) || containsWrappedGitCommitCommand(script, depth + 1)) {
      return true
    }
  }
  return false
}

function commandHasGitSubcommand(command: string, subcommands: Set<string>): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeCommand(segment)
    const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
    if (!gitTokens) continue
    const subcommand = findGitSubcommand(gitTokens)
    if (subcommand && subcommands.has(subcommand.subcommand)) return true
  }
  return false
}

/** True when the command is (or contains) a real `git commit` invocation. */
export function isGitCommitCommand(command: string): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["commit"]))
}

/** True when the command is (or contains) a real `git push` invocation. */
export function isGitPushCommand(command: string): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["push"]))
}

/** True when the command is (or contains) a real `git merge` invocation. */
export function isGitMergeCommand(command: string): boolean {
  return commandHasGitSubcommand(command.trim(), new Set(["merge"]))
}

/**
 * True when the command chains multiple shell statements (`&&`, `||`, `;`, `|`, `&`)
 * outside of quoted spans. Used to refuse intercepting a `git commit` that is glued to
 * other commands — the commit dialog only performs the commit, so the rest of the chain
 * would otherwise be silently dropped.
 */
export function isChainedShellCommand(command: string): boolean {
  return /\|\||&&|[;&|]|\r|\n/.test(stripQuotedSpans(command))
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

function extractGitAddPathspecs(command: string): string[] {
  const tokens = tokenizeCommand(command)
  const gitTokens = tokens ? getGitInvocationTokens(tokens) : null
  if (!gitTokens) return []
  const subcommand = findGitSubcommand(gitTokens)
  if (!subcommand || subcommand.subcommand !== "add") return []

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
    if (lower === "--pathspec-from-file") {
      i += 1
      continue
    }
    if (lower.startsWith("--pathspec-from-file=")) continue
    if (token.startsWith("-")) continue
    pathspecs.push(token)
  }
  return Array.from(new Set(pathspecs.filter(Boolean)))
}

export function normalizeGitAddPrefixedGitCommitCommand(
  command: string,
  cwd: string
): { command: string; cwd: string; filePaths: string[] } | null {
  if (!isChainedShellCommand(command)) return null
  const segments = splitShellCommandSegments(command)
  if (segments.length < 2) return null

  let effectiveCwd = cwd
  // Each add's pathspecs are recorded together with the cwd they were issued from, so we can
  // reject a chain whose adds span different directories (those pathspecs are relative to
  // different bases and cannot be represented by the single basePath the dialog receives).
  const collected: Array<{ cwd: string; pathspecs: string[] }> = []
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const nextCwd = resolveShellCdTarget(effectiveCwd, segment)
    if (nextCwd) {
      effectiveCwd = nextCwd
      continue
    }

    const addCwd = resolveGitCommandCwdForSubcommand(segment, effectiveCwd, "add")
    if (!addCwd) return null
    const addPathspecs = extractGitAddPathspecs(segment)
    if (addPathspecs.length === 0) return null
    effectiveCwd = addCwd
    collected.push({ cwd: addCwd, pathspecs: addPathspecs })
  }

  const commitCommand = segments[segments.length - 1]
  if (!isGitCommitCommand(commitCommand) || isChainedShellCommand(commitCommand)) return null
  const commitCwd = resolveGitCommandCwdForSubcommand(commitCommand, effectiveCwd, "commit")
  if (!commitCwd) return null
  if (path.resolve(commitCwd) !== path.resolve(effectiveCwd)) return null
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
export function isForcePushCommand(command: string): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeCommand(segment)
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
  targetSubcommand: string
): string | null {
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeCommand(segment)
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

export function resolveGitCommandCwd(command: string, cwd: string): string {
  return resolveGitCommandCwdForSubcommand(command, cwd, "commit") ?? cwd
}

/**
 * Best-effort extraction of the commit message the agent passed via `-m`/`--message`.
 * Used to pre-fill the task-card commit dialog. Returns undefined when no message arg
 * is present (e.g. `git commit` with an editor) or the command can't be tokenized.
 */
export function extractGitCommitMessage(command: string): string | undefined {
  const tokens = tokenizeCommand(command)
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
const GIT_COMMIT_SHORT_OPTIONS_WITH_VALUE = new Set(["-C", "-F", "-m", "-t"])

function shortCommitValueFlagIndex(token: string): number {
  if (!token.startsWith("-") || token.startsWith("--")) return -1
  for (let i = 1; i < token.length; i++) {
    if (token[i] === "m" || token[i] === "F" || token[i] === "C" || token[i] === "t") return i
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
 * The task-card dialog uses these as the agent's intended file selection. Returns an
 * empty list when the command does not name files explicitly (the renderer may then
 * fall back to currently staged files, or all changed files).
 */
export function extractGitCommitPathspecs(command: string): string[] {
  if (isChainedShellCommand(command)) return []
  const tokens = tokenizeCommand(command)
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
 * True when a `git commit` invocation rewrites or amends an existing commit
 * (`--amend`, `--fixup`, `--squash`). The task-card commit dialog only ever creates a
 * fresh commit, so these must not be silently turned into a new commit.
 */
export function isAmendOrFixupCommit(command: string): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    const tokens = tokenizeCommand(segment)
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

function tokenizeCommand(command: string): string[] | null {
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

    if (ch === "\\" && quote !== "'" && backslashEscapesNextChar(command[i + 1], quote)) {
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

    if (ch === "'" || ch === '"') {
      quote = ch
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
