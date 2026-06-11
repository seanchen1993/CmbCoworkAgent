/**
 * Command safety policy engine.
 *
 * Classifies shell commands into safe / needs_approval / forbidden categories
 * based on pattern matching. Modelled after codex-rs is_known_safe_command()
 * and command_might_be_dangerous().
 */

import path from "node:path"
import type { ExecSafetyLevel } from "../types"
import { isKnownSafeWindowsCommand, type WindowsShellKind } from "./windows-safe-commands"

export interface SafetyAssessment {
  level: ExecSafetyLevel
  reason?: string
}

export type CommandConcurrencyClassification = "parallel_safe" | "exclusive"

const APPROVAL_PREFIX_RULE_PREFIX = "prefix:"

const SAFE_EXECUTABLES = new Set([
  "base64", "cat", "cd", "cut", "dir", "echo", "expr", "false", "file", "grep",
  "head", "hostname", "id", "ls", "nl", "paste", "pwd", "printf",
  "rev", "seq", "sort", "stat", "tail", "tr", "tree", "true", "uname",
  "uniq", "wc", "where", "which", "whoami", "type", "awk", "comm",
  "date", "diff", "env", "printenv",
  // Windows diagnostic commands (read-only)
  "ipconfig", "netstat", "netsh", "systeminfo", "tasklist", "findstr", "nslookup",
  "ping", "tracert", "pathping", "route", "arp", "getmac", "ver"
])

const PARALLEL_SAFE_EXECUTABLES = new Set([
  "cat", "comm", "cut", "df", "diff", "dir", "du", "echo", "expr",
  "false", "file", "findstr", "getmac", "grep", "head", "id", "ls",
  "netstat", "nl", "paste", "pathping", "ping", "printenv", "printf",
  "pwd", "rev", "seq", "stat", "systeminfo", "tail", "tasklist", "tr",
  "tracert", "tree", "true", "type", "uname", "uniq", "ver", "wc",
  "where", "which", "whoami",
  // Common read-only PowerShell cmdlets and aliases.
  "compare-object", "fl", "format-list", "format-table", "ft", "gc", "gci",
  "get-childitem", "get-command", "get-content", "get-date", "get-item",
  "get-location", "get-process", "get-service", "gl", "gps", "measure-object",
  "select-string", "sort-object", "where-object"
])

const UNSAFE_FIND_OPTIONS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"
])

const UNSAFE_RIPGREP_FLAGS = new Set(["--search-zip", "-z"])
const UNSAFE_RIPGREP_FLAGS_WITH_VALUES = ["--pre", "--hostname-bin"]
const UNSAFE_GIT_FLAGS = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"])
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"
])

const SIDE_EFFECTING_POWERSHELL_CMDLETS = new Set([
  "set-content", "add-content", "out-file", "new-item", "remove-item", "move-item",
  "copy-item", "rename-item", "start-process", "stop-process"
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
  "bun", "cargo", "cmake", "go", "gradle", "gradlew", "java", "javac", "make",
  "mvn", "npm", "npx", "pnpm", "poetry", "pip", "pip3", "pytest", "uv", "yarn",
  "dotnet", "msbuild", "ant",
  // Version control
  "git", "svn",
  // Common dev tools
  "node", "python", "python3", "ruby", "perl", "php",
  "rustc", "gcc", "g++", "clang", "clang++",
  "docker", "docker-compose", "kubectl",
  "curl", "wget",
  // Shell utilities (read-only / safe)
  "ls", "dir", "cat", "head", "tail", "find", "grep", "rg", "awk", "sed",
  "wc", "sort", "uniq", "diff", "tree", "file", "which", "where", "echo",
  "pwd", "env", "printenv", "whoami", "hostname", "date", "df", "du",
  // Windows-specific
  "type", "findstr", "icacls", "net", "sc", "tasklist", "systeminfo"
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
  { pattern: /\bRemove-Item\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root" },
  { pattern: /\bRemove-Item\s+.*[a-zA-Z]:\\\*?.*-Recurse\b/i, reason: "PowerShell recursive delete on drive root" },
  { pattern: /\bri\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root (alias)" },
  { pattern: /\bdel\s+.*-Recurse\b.*[a-zA-Z]:\\\*?/i, reason: "PowerShell recursive delete on drive root (alias)" },
  // PowerShell — disk format
  { pattern: /\bFormat-Volume\b/i, reason: "PowerShell formats disk volume" },
  { pattern: /\bClear-Disk\b/i, reason: "PowerShell clears disk" },
  // PowerShell — remote script execution
  { pattern: /\bInvoke-Expression\b.*\bInvoke-WebRequest\b/i, reason: "PowerShell downloads and executes remote script" },
  { pattern: /\biex\b.*\biwr\b/i, reason: "PowerShell downloads and executes remote script (alias)" },
  { pattern: /\bInvoke-Expression\b.*\bInvoke-RestMethod\b/i, reason: "PowerShell downloads and executes remote script" },
  { pattern: /\biex\b.*\birm\b/i, reason: "PowerShell downloads and executes remote script (alias)" },
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
  { pattern: /\bInvoke-WebRequest\b.*-Method\s+(Post|Put|Delete)\b/i, reason: "PowerShell mutating HTTP request" },
  { pattern: /\bInvoke-RestMethod\b.*-Method\s+(Post|Put|Delete)\b/i, reason: "PowerShell mutating HTTP request" },
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
      reason: "git_workflow tool is available — use git_workflow instead of direct git add/commit/push"
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

  const windowsSafe = process.platform === "win32"
    && isKnownSafeWindowsCommand(trimmed, options?.windowsShell ?? "unknown")
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
    reason: hasShellMetacharacters ? "complex shell expression — requires review" : "unknown command — requires review"
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

  if (tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))) {
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
  return command.replace(/"[^"]*"/g, " __quoted_arg__ ").replace(/'[^']*'/g, " __quoted_arg__ ")
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
      if (token.includes("c")) return invocation[i + 1] || null
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
  const filePaths: string[] = []
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
    filePaths.push(...addPathspecs)
  }

  const commitCommand = segments[segments.length - 1]
  if (!isGitCommitCommand(commitCommand) || isChainedShellCommand(commitCommand)) return null
  const commitCwd = resolveGitCommandCwdForSubcommand(commitCommand, effectiveCwd, "commit")
  if (!commitCwd) return null
  if (path.resolve(commitCwd) !== path.resolve(effectiveCwd)) return null
  return { command: commitCommand, cwd: commitCwd, filePaths: Array.from(new Set(filePaths)) }
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
  if (!isGitCommitCommand(command)) return false
  return /(?:^|\s)--(amend|fixup|squash)\b/i.test(stripQuotedSpans(command))
}

export function derivePermanentApprovalPattern(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (/&&|\|\||[|;&`<>]|\$\(|\n/.test(trimmed)) return null
  if (FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(trimmed))) return null
  if (DANGEROUS_INDICATORS.some(({ pattern }) => pattern.test(trimmed))) return null

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) return null
  if (tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))) {
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
    const patternParts = pattern.split(":")  // ["file", "write_file", "/some/dir/*"]
    const commandParts = command.split(":")  // ["file", "write_file", "/some/dir/foo.ts"]
    if (patternParts.length < 3 || commandParts.length < 3) return false
    if (patternParts[1] !== commandParts[1]) return false  // operation must match
    const patternPath = patternParts.slice(2).join(":").replace(/\\/g, "/")
    const commandPath = commandParts.slice(2).join(":").replace(/\\/g, "/")
    // "dir/*" → check if commandPath starts with "dir/"
    if (patternPath.endsWith("/*")) {
      const dirPrefix = patternPath.slice(0, -1)  // "dir/"
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

  if (tokens.some((token) => token.includes("$(") || token.includes("${") || token.includes("@("))) {
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

  if (isSafeBase64(tokens)) return true
  if (SAFE_EXECUTABLES.has(executable)) return true
  if (isSafeFind(tokens)) return true
  if (isSafeRipgrep(tokens)) return true
  if (isSafeGit(tokens)) return true
  if (isSafeSed(tokens)) return true
  if (isSafeBuildTool(executable, tokens)) return true

  return false
}

// ── Safe build tool checks (mirrors windows-safe-commands.ts) ───────────────

const UNSAFE_MVN_GOALS = new Set(["deploy", "site-deploy"])
const UNSAFE_MVN_GOAL_PREFIXES = ["exec:", "release:", "deploy:", "wagon:", "scm:"]
const UNSAFE_GRADLE_TASKS = new Set(["publish", "publishtomavenlocal", "uploadarchives"])
const UNSAFE_NPM_SUBCOMMANDS = new Set(["publish", "unpublish", "deprecate", "dist-tag", "access", "exec", "x"])
const UNSAFE_CARGO_SUBCOMMANDS = new Set(["publish", "yank", "login", "logout"])
const SAFE_GO_SUBCOMMANDS = new Set([
  "build", "clean", "doc", "env", "fmt", "generate", "get",
  "install", "list", "mod", "run", "test", "tool", "version", "vet"
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

    if (ch === "'" || ch === "\"") {
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

function parseApprovalPattern(pattern: string): string[] | null {
  if (!pattern.startsWith(APPROVAL_PREFIX_RULE_PREFIX)) return null
  try {
    const parsed = JSON.parse(pattern.slice(APPROVAL_PREFIX_RULE_PREFIX.length)) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
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

  return BANNED_PERSISTENT_PREFIXES.some((banned) => (
    banned.length <= normalized.length &&
    banned.every((token, index) => normalized[index] === token)
  ))
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
      UNSAFE_RIPGREP_FLAGS_WITH_VALUES.some((flag) => lower === flag || lower.startsWith(flag + "="))
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
    return lower === "-c" || lower === "--config-env" || lower.startsWith("-c") || lower.startsWith("--config-env=")
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

    if (
      GIT_GLOBAL_OPTIONS_WITH_VALUE.has(lower)
    ) {
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
    return UNSAFE_GIT_FLAGS.has(lower) || lower.startsWith("--output=") || lower.startsWith("--exec=")
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
    return lower === "-o" || lower === "--output" || lower.startsWith("--output=") || (lower.startsWith("-o") && lower !== "-o")
  })
}
