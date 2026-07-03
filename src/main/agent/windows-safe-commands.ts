import path from "node:path"
import {
  BUILD_TOOL_EXECUTABLES,
  isReadOnlyBuildToolInvocation,
  normalizeBuildToolExecutable,
  hasUnsafeWriteFlag
} from "./read-only-build-tool"

export type WindowsShellKind = "powershell" | "cmd" | "bash" | "unknown"

const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "show", "diff", "cat-file", "branch"])
const SAFE_POWERSHELL_COMMANDS = new Set([
  "echo", "write-output", "write-host",
  "dir", "ls", "get-childitem", "gci",
  "cat", "type", "gc", "get-content",
  "select-string", "sls", "findstr",
  "measure-object", "measure",
  "get-location", "gl", "pwd",
  "set-location", "sl", "cd", "chdir",
  "push-location", "pushd",
  "pop-location", "popd",
  "test-path", "tp",
  "resolve-path", "rvpa",
  "select-object", "select",
  "where-object", "where", "?",
  "foreach-object", "foreach", "%",
  "format-table", "ft",
  "format-list", "fl",
  "sort-object", "sort",
  "group-object", "group",
  "out-string", "oss",
  "out-null",
  "get-item", "gi",
  "get-itemproperty", "gp",
  "get-member", "gm",
  "get-process", "gps", "ps",
  "get-command", "gcm",
  "get-help", "help", "man",
  "get-alias", "gal",
  "get-variable", "gv",
  // Windows diagnostic commands (read-only)
  "ipconfig", "netstat", "netsh", "systeminfo", "tasklist", "nslookup",
  "ping", "tracert", "pathping", "route", "arp", "getmac",
  "hostname", "whoami", "ver", "get-netadapter", "get-netipaddress",
  "get-netipinterface", "get-nettcpconnection"
])
const SIDE_EFFECTING_POWERSHELL_CMDLETS = new Set([
  "set-content", "add-content", "out-file", "new-item", "remove-item", "move-item",
  "copy-item", "rename-item", "start-process", "stop-process"
])
// Cmdlets (and aliases) that read an item/content BY PATH. For these, an `Env:`-prefixed
// argument resolves the environment-variable PSDrive and would print secrets to stdout
// (`Get-Content Env:KEY`, `Get-ChildItem Env:`). A Windows filename can't contain `:`,
// so an `env:`-prefixed arg to one of these is unambiguously the provider, not a file.
// Used to SCOPE the env-provider check so a literal `env:` in a search pattern / output
// string (Select-String, Write-Output) is not false-killed.
const ENV_PATH_READING_CMDLETS = new Set([
  "get-content", "gc", "cat", "type",
  "get-item", "gi",
  "get-childitem", "gci", "dir", "ls",
  "get-itemproperty", "gp",
  "get-itempropertyvalue", "gpv",
  "test-path", "tp",
  "resolve-path", "rvpa"
])
// Pure-output cmdlets: their arguments are literal text to PRINT, not a path to read.
// So a (quoted) arg that merely LOOKS like `-Path:Env:` or `Env:` is output, not a
// provider read — the env-provider PATH checks must be skipped for them to avoid a
// false-kill. (`$env:` variable expansion in their args is still caught earlier, before
// tokenization drops the quote context.)
const OUTPUT_CMDLETS = new Set(["echo", "write-output", "write-host"])
const UNSAFE_RIPGREP_FLAGS = new Set(["--search-zip", "-z"])
const UNSAFE_RIPGREP_FLAGS_WITH_VALUES = ["--pre", "--hostname-bin"]
const UNSAFE_GIT_FLAGS = new Set(["--output", "--ext-diff", "--textconv", "--exec", "--paginate"])
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"
])
const SAFE_POWERSHELL_VARIABLES = new Set([
  "$null",
  "$true",
  "$false",
  "$_",
  "$psitem",
  "$pwd",
  "$home",
  "$psscriptroot",
  "$lastexitcode"
])

export function isKnownSafeWindowsCommand(command: string, shellKind: WindowsShellKind): boolean {
  if (process.platform !== "win32") return false

  const trimmed = command.trim()
  if (!trimmed) return false

  if (shellKind === "powershell") {
    const commands = parsePowerShellScript(trimmed)
    if (commands && commands.every((cmd) => isSafePowerShellCommand(cmd))) {
      return true
    }
  }

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) return false

  const commands = tryParsePowerShellCommandSequence(tokens)
  if (!commands) return false

  return commands.every((cmd) => isSafePowerShellCommand(cmd))
}

/**
 * Read-only counterpart of isKnownSafeWindowsCommand. Same parsing, but each
 * parsed command must be pure inspection: this is what re-validates a
 * `powershell -Command "<x>"` wrapper for a READ-ONLY agent. The wrapper is
 * already auto-"safe" (isKnownSafeWindowsCommand accepted it), but "safe" lets
 * build tools through — here `npm install` / `cargo build` are rejected while
 * `Get-Content x` / `npm ls` / `mvn dependency:tree` stay allowed.
 */
export function isReadOnlyWindowsCommand(command: string, shellKind: WindowsShellKind): boolean {
  if (process.platform !== "win32") return false

  const trimmed = command.trim()
  if (!trimmed) return false

  if (shellKind === "powershell") {
    const commands = parsePowerShellScript(trimmed)
    if (commands && commands.every((cmd) => isReadOnlyPowerShellCommand(cmd))) {
      return true
    }
  }

  const tokens = tokenizeCommand(trimmed)
  if (!tokens || tokens.length === 0) return false

  const commands = tryParsePowerShellCommandSequence(tokens)
  if (!commands) return false

  return commands.every((cmd) => isReadOnlyPowerShellCommand(cmd))
}

/**
 * Read-only counterpart of isSafePowerShellCommand: read-only cmdlets/diagnostics
 * stay allowed (the SAFE_POWERSHELL_COMMANDS set is already read-only), git/rg
 * use their existing read-only checks, and EVERY build/package/codegen tool is
 * restricted to its inspection subcommands via the shared
 * isReadOnlyBuildToolInvocation (so make/cmake/java/javac — blanket-safe for a
 * normal agent — are now version/help only).
 */
export function isReadOnlyPowerShellCommand(words: string[]): boolean {
  if (words.length === 0) return false

  // SECURITY (env-secret exfil), part 1 — `$env:` / `${env:…}` variable expansion
  // leaks the value in ANY command (`Write-Output $env:KEY`, `Format-Table $env:KEY`,
  // double-quoted `"$env:KEY"`), so reject it anywhere. A single-quoted literal
  // `'$env:'` is over-blocked too (a rare, safe trade — tokenization can't tell quote
  // kinds apart, same trade as POSIX echo/printf `$`). The bare `Env:` PROVIDER form
  // is NOT handled here: it only leaks as a read cmdlet's PATH (vetted after `command`
  // below), so a literal `env:` in a search pattern / output string
  // (`Select-String "env:"`, `Write-Output "env: bar"`) is not false-killed.
  if (words.some((word) => /\$\{?env:/i.test(word))) {
    return false
  }

  // SCRIPT BLOCKS: cmdlets like ForEach-Object/% and Where-Object/? accept a
  // `{ … }` block that can contain ARBITRARY code — e.g. `Get-Content x | % { npm
  // install }`, `% { rm y }`, `% { ./tool.exe }`, `% { iex '…' }`. The outer
  // cmdlet (%, where-object …) is itself in the read-only set, so a flat token
  // scan would wrongly accept it. This conservative parser can't safely vet a
  // block body, so DENY any command containing a script-block brace. (Simple
  // non-block forms like `Where-Object Name -eq x` have no braces and stay
  // allowed.)
  if (words.some((word) => word.includes("{") || word.includes("}"))) {
    return false
  }

  // A path-qualified inner executable (./x, C:\tools\x, /tmp/x) is not the known
  // command — parity with the POSIX gate, which rejects path-qualified binaries
  // because their content can't be assumed read-only.
  if (/[\\/]/.test(words[0].replace(/^[('"]+/, ""))) {
    return false
  }

  for (const word of words) {
    const inner = word
      .trim()
      .replace(/^[()]+|[()]+$/g, "")
      .replace(/^-+/, "")
      .toLowerCase()
    if (SIDE_EFFECTING_POWERSHELL_CMDLETS.has(inner)) {
      return false
    }
  }

  const command = words[0]
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .replace(/^-+/, "")
    .toLowerCase()

  // SECURITY (env-secret exfil), part 2 — the `Env:` PSDrive provider leaks secrets
  // when a cmdlet resolves it as a PATH. Three shapes are rejected; a literal `env:`
  // in a SEARCH PATTERN or OUTPUT string is NONE of them and stays allowed
  // (`Select-String "env:" *.txt`, `Write-Output "env: bar"`):
  //   1. colon-bound path parameter on ANY cmdlet — `-Path:Env:KEY`,
  //      `-LiteralPath:Env:`, `-LP:Env:` (PowerShell's documented `-Param:Value`);
  //   2. a bare `Env:` arg to a content/item-reading cmdlet — `Get-Content Env:KEY`,
  //      `Get-ChildItem Env:` (a Windows filename can't contain `:`, so for these an
  //      `env:` arg is unambiguously the provider, not a file);
  //   3. the value of a SPACE-separated path parameter on ANY cmdlet — `-Path Env:KEY`
  //      — so `Select-String -Path Env:KEY "."` can't read a var's value either.
  // `\benv:` matches `Env:` and colon-bound forms but not `env-notes.txt`/`environment`.
  // Pure-output cmdlets print their args verbatim and have no path-reading parameter,
  // so a quoted literal like `Write-Output "-Path:Env:KEY"` is text, not a leak — skip
  // the path checks for them (their `$env:` expansion was already caught above).
  if (!OUTPUT_CMDLETS.has(command)) {
    const isEnvReadCmdlet = ENV_PATH_READING_CMDLETS.has(command)
    const PATH_PARAM_RE = /^-(?:path|literalpath|lp|pspath|filepath)$/i
    for (let i = 1; i < words.length; i++) {
      const arg = words[i]
      if (!/\benv:/i.test(arg)) continue
      if (/^-(?:path|literalpath|lp|pspath|filepath):/i.test(arg)) return false // (1)
      if (isEnvReadCmdlet) return false // (2)
      if (i > 1 && PATH_PARAM_RE.test(words[i - 1])) return false // (3)
    }
  }

  // SAFE_POWERSHELL_COMMANDS are read-only cmdlets + read-only diagnostics, but a
  // few diagnostics (arp/route/netsh/ipconfig) have mutate verbs (arp -d, route
  // add, netsh … set, ipconfig /flushdns) the name-allowlist would wave through —
  // reject those per command (shared with the POSIX gate); read forms stay safe.
  if (SAFE_POWERSHELL_COMMANDS.has(command)) {
    return !hasUnsafeWriteFlag(command, words)
  }

  // Build/package/codegen tools: inspection subcommands only (shared with the
  // POSIX gate so both agree). normalizeBuildToolExecutable handles npm.cmd etc.
  const buildExe = normalizeBuildToolExecutable(words[0])
  if (BUILD_TOOL_EXECUTABLES.has(buildExe)) {
    return isReadOnlyBuildToolInvocation(buildExe, words)
  }

  switch (command) {
    case "git":
      return isSafeGitCommand(words)
    case "rg":
      return isSafeRipgrep(words)
    default:
      return false
  }
}

function tryParsePowerShellCommandSequence(command: string[]): string[][] | null {
  const [exe, ...rest] = command
  if (!isPowerShellExecutable(exe)) return null
  return parsePowerShellInvocation(rest)
}

function parsePowerShellInvocation(args: string[]): string[][] | null {
  if (args.length === 0) return null

  let index = 0
  while (index < args.length) {
    const arg = args[index]
    const lower = arg.toLowerCase()

    switch (true) {
      case lower === "-command":
      case lower === "/command":
      case lower === "-c": {
        const script = args[index + 1]
        if (!script || index + 2 !== args.length) return null
        return parsePowerShellScript(script)
      }
      case lower.startsWith("-command:"):
      case lower.startsWith("/command:"): {
        if (index + 1 !== args.length) return null
        const script = arg.split(/:(.*)/s)[1]
        return script ? parsePowerShellScript(script) : null
      }
      case lower === "-nologo":
      case lower === "-noprofile":
      case lower === "-noninteractive":
      case lower === "-mta":
      case lower === "-sta":
        index += 1
        continue
      case lower === "-encodedcommand":
      case lower === "-ec":
      case lower === "-file":
      case lower === "/file":
      case lower === "-windowstyle":
      case lower === "-executionpolicy":
      case lower === "-workingdirectory":
        return null
      default:
        if (lower.startsWith("-")) return null
        return parsePowerShellScript(joinArgumentsAsScript(args.slice(index)))
    }
  }

  return null
}

function parsePowerShellScript(script: string): string[][] | null {
  return parsePowerShellScriptConservatively(script)
}

export function isSafePowerShellCommand(words: string[]): boolean {
  if (words.length === 0) return false

  // SCRIPT BLOCKS: ForEach-Object/%/Where-Object/? accept a `{ … }` block whose
  // body can be ARBITRARY code (`Get-Content x | % { rm y }`). The outer cmdlet is
  // itself "safe", so a flat token scan would auto-approve the block — running it
  // with no user prompt. This conservative parser can't vet a block body, so deny
  // any command containing a script-block brace (it falls through to needs_approval
  // rather than auto-running). Simple non-block forms (`Where-Object Name -eq x`)
  // have no braces and stay auto-safe.
  if (words.some((word) => word.includes("{") || word.includes("}"))) {
    return false
  }

  for (const word of words) {
    const inner = word
      .trim()
      .replace(/^[()]+|[()]+$/g, "")
      .replace(/^-+/, "")
      .toLowerCase()
    if (SIDE_EFFECTING_POWERSHELL_CMDLETS.has(inner)) {
      return false
    }
  }

  const command = words[0]
    .trim()
    .replace(/^[()]+|[()]+$/g, "")
    .replace(/^-+/, "")
    .toLowerCase()

  if (SAFE_POWERSHELL_COMMANDS.has(command)) {
    return !hasUnsafeWriteFlag(command, words)
  }

  switch (command) {
    case "git":
      return isSafeGitCommand(words)
    case "rg":
      return isSafeRipgrep(words)
    case "mvn":
    case "mvn.cmd":
    case "mvnw":
    case "mvnw.cmd":
      return isSafeMvnCommand(words)
    case "gradle":
    case "gradle.bat":
    case "gradlew":
    case "gradlew.bat":
      return isSafeGradleCommand(words)
    case "npm":
    case "npm.cmd":
    case "pnpm":
    case "pnpm.cmd":
    case "yarn":
    case "yarn.cmd":
    case "bun":
      return isSafeNpmCommand(words)
    case "cargo":
      return isSafeCargoCommand(words)
    case "go":
      return isSafeGoCommand(words)
    case "make":
    case "cmake":
    case "java":
      return true
    case "dotnet":
      return isSafeDotnetCommand(words)
    case "javac":
      return true
    default:
      return false
  }
}

function isSafeRipgrep(words: string[]): boolean {
  return !words.slice(1).some((arg) => {
    const lower = arg.toLowerCase()
    return (
      UNSAFE_RIPGREP_FLAGS.has(lower) ||
      UNSAFE_RIPGREP_FLAGS_WITH_VALUES.some((flag) => lower === flag || lower.startsWith(flag + "="))
    )
  })
}

function isSafeGitCommand(words: string[]): boolean {
  if (hasGitConfigOverride(words)) return false

  const subcommandInfo = findGitSubcommand(words)
  if (!subcommandInfo || !SAFE_GIT_SUBCOMMANDS.has(subcommandInfo.subcommand)) {
    return false
  }

  const args = words.slice(subcommandInfo.index + 1)
  if (!gitArgsAreReadOnly(args)) return false

  if (subcommandInfo.subcommand === "branch") {
    return gitBranchIsReadOnly(args)
  }

  return true
}

function hasGitConfigOverride(words: string[]): boolean {
  return words.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === "-c" || lower === "--config-env" || lower.startsWith("-c") || lower.startsWith("--config-env=")
  })
}

function findGitSubcommand(words: string[]): { index: number; subcommand: string } | null {
  let skipNext = false

  for (let index = 1; index < words.length; index++) {
    const word = words[index]
    const lower = word.toLowerCase()

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

    if (word === "--" || word.startsWith("-")) continue

    return { index, subcommand: lower }
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

// ── Safe build tool checks ──────────────────────────────────────────────────

const UNSAFE_MVN_GOALS = new Set(["deploy", "site-deploy"])
const UNSAFE_MVN_GOAL_PREFIXES = ["exec:", "release:", "deploy:", "wagon:", "scm:"]

function isSafeMvnCommand(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]
    if (arg.startsWith("-")) continue
    const lower = arg.toLowerCase()
    if (UNSAFE_MVN_GOALS.has(lower)) return false
    if (UNSAFE_MVN_GOAL_PREFIXES.some((p) => lower.startsWith(p))) return false
  }
  return true
}

const UNSAFE_GRADLE_TASKS = new Set(["publish", "publishtomavenlocal", "uploadarchives"])

function isSafeGradleCommand(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]
    if (arg.startsWith("-")) continue
    if (UNSAFE_GRADLE_TASKS.has(arg.toLowerCase())) return false
  }
  return true
}

const UNSAFE_NPM_SUBCOMMANDS = new Set(["publish", "unpublish", "deprecate", "dist-tag", "access", "exec", "x"])

function isSafeNpmCommand(words: string[]): boolean {
  if (words.length < 2) return false
  const sub = words[1].toLowerCase()
  return !UNSAFE_NPM_SUBCOMMANDS.has(sub)
}

const UNSAFE_CARGO_SUBCOMMANDS = new Set(["publish", "yank", "login", "logout"])

function isSafeCargoCommand(words: string[]): boolean {
  if (words.length < 2) return false
  const sub = words[1].toLowerCase()
  return !UNSAFE_CARGO_SUBCOMMANDS.has(sub)
}

const SAFE_GO_SUBCOMMANDS = new Set([
  "build", "clean", "doc", "env", "fmt", "generate", "get",
  "install", "list", "mod", "run", "test", "tool", "version", "vet"
])

function isSafeGoCommand(words: string[]): boolean {
  if (words.length < 2) return false
  return SAFE_GO_SUBCOMMANDS.has(words[1].toLowerCase())
}

const UNSAFE_DOTNET_SUBCOMMANDS = new Set(["nuget", "publish"])

function isSafeDotnetCommand(words: string[]): boolean {
  if (words.length < 2) return false
  return !UNSAFE_DOTNET_SUBCOMMANDS.has(words[1].toLowerCase())
}

function isPowerShellExecutable(executable: string): boolean {
  const executableName = path.basename(executable).toLowerCase()
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executableName)
}

function joinArgumentsAsScript(args: string[]): string {
  return args.map((arg, index) => {
    if (index === 0) return arg
    return quoteArgument(arg)
  }).join(" ")
}

function quoteArgument(arg: string): string {
  if (!arg) return "''"
  if ([...arg].every((char) => !/\s/.test(char))) return arg
  return `'${arg.replace(/'/g, "''")}'`
}

function parsePowerShellScriptConservatively(script: string): string[][] | null {
  const normalizedScript = stripPowerShellDiscardRedirects(
    normalizePowerShellLineContinuations(script)
  )
  if (!normalizedScript.trim()) return null
  if (normalizedScript.includes("$(") || normalizedScript.includes("${") || normalizedScript.includes("@(") || normalizedScript.includes("`")) {
    return null
  }

  const segments = splitPowerShellScript(normalizedScript)
  if (!segments || segments.length === 0) return null

  const commands: string[][] = []
  for (const segment of segments) {
    const normalizedSegment = unwrapOuterParens(segment.trim())
    if (!normalizedSegment) return null

    const tokens = tokenizeCommand(normalizedSegment)
    if (!tokens || tokens.length === 0) return null
    if (tokens.some((token) => !isAllowedPowerShellToken(token))) {
      return null
    }

    commands.push(tokens)
  }

  return commands
}

function normalizePowerShellLineContinuations(script: string): string {
  return script.replace(/`\r?\n/g, " ")
}

function stripPowerShellDiscardRedirects(script: string): string {
  return script.replace(/(^|[\s;|&])(?:\d+|\*)?>\s*\$null\b/gi, "$1")
}

function isAllowedPowerShellToken(token: string): boolean {
  if (token.includes("`") || token.includes("@(") || token.includes("$(") || token.includes("${")) {
    return false
  }
  const variableMatches = token.match(/\$[A-Za-z_][A-Za-z0-9_]*|\$_/g) ?? []
  for (const match of variableMatches) {
    if (!SAFE_POWERSHELL_VARIABLES.has(match.toLowerCase())) {
      return false
    }
  }
  return true
}

function splitPowerShellScript(script: string): string[] | null {
  const segments: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let depth = 0

  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    const next = script[index + 1] ?? ""

    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "'" || char === "\"") {
      quote = char
      current += char
      continue
    }

    if (char === "(") {
      depth += 1
      current += char
      continue
    }

    if (char === ")") {
      depth -= 1
      if (depth < 0) return null
      current += char
      continue
    }

    if (depth === 0) {
      if (char === "<") return null
      // Allow stream-merge redirections like 2>&1; reject file redirections
      if (char === ">") {
        const prev = index > 0 ? script[index - 1] : ""
        if ((/\d/.test(prev) || prev === "*") && next === "&") {
          const afterAmp = script[index + 2] ?? ""
          if (/\d/.test(afterAmp)) {
            // N>&M / *>&M pattern (e.g. 2>&1 or *>&1) — safe stream merge, skip it
            current += char + next + afterAmp
            index += 2
            continue
          }
        }
        return null
      }
      // Allow & only as part of && operator or inside N>&M (already consumed above)
      if (char === "&" && next !== "&") return null

      const doubleOperator = char + next
      if (doubleOperator === "&&" || doubleOperator === "||") {
        if (!pushPowerShellSegment(segments, current)) return null
        current = ""
        index += 1
        continue
      }

      if (char === "|" || char === ";") {
        if (!pushPowerShellSegment(segments, current)) return null
        current = ""
        continue
      }
    }

    current += char
  }

  if (quote || depth !== 0) return null
  if (!pushPowerShellSegment(segments, current)) return null
  return segments
}

function pushPowerShellSegment(segments: string[], segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed) return false
  segments.push(trimmed)
  return true
}

function unwrapOuterParens(segment: string): string | null {
  let current = segment.trim()
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0
    let wrapsWholeSegment = true
    let quote: "'" | "\"" | null = null

    for (let index = 0; index < current.length; index++) {
      const char = current[index]
      if (quote) {
        if (char === quote) quote = null
        continue
      }

      if (char === "'" || char === "\"") {
        quote = char
        continue
      }

      if (char === "(") depth += 1
      if (char === ")") depth -= 1

      if (depth === 0 && index < current.length - 1) {
        wrapsWholeSegment = false
        break
      }
    }

    if (!wrapsWholeSegment || depth !== 0 || quote) {
      break
    }

    current = current.slice(1, -1).trim()
  }

  return current || null
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let escaped = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === "\"") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (escaped || quote) return null
  if (current) tokens.push(current)
  return tokens
}
