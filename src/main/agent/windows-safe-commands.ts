import path from "node:path"

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

function isSafePowerShellCommand(words: string[]): boolean {
  if (words.length === 0) return false

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
    return true
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
