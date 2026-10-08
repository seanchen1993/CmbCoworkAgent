import path from "node:path"
import { readFile, stat } from "node:fs/promises"

export type ShellWriteKind = "model" | "generated" | "transfer"
export interface ShellWriteEffect {
  kind: ShellWriteKind
  paths: string[]
}
export interface ShellCommandProfile {
  effects: ShellWriteEffect[]
  namedPaths: string[]
  readPaths: string[]
  canWrite: boolean
  hasLongRunning: boolean
  background: boolean
}

interface Token {
  value: string
  operator?: boolean
}
interface Segment {
  tokens: Token[]
  pipeline: boolean
  heredoc: boolean
  background: boolean
}
const READERS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "wc",
  "grep",
  "rg",
  "findstr",
  "sed",
  "awk",
  "jq",
  "cut",
  "sort",
  "uniq",
  "tr",
  "diff",
  "cmp"
])
const OBSERVERS = new Set([
  "pwd",
  "cd",
  "pushd",
  "popd",
  "ls",
  "dir",
  "find",
  "where",
  "which",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "stat",
  "file",
  "whoami",
  "uname",
  "hostname",
  "sleep"
])
const BUILDERS = new Set([
  "make",
  "cmake",
  "ninja",
  "mvn",
  "gradle",
  "javac",
  "tsc",
  "webpack",
  "vite",
  "vitest",
  "jest",
  "pytest",
  "mocha",
  "ctest"
])
const FORMATTERS = new Set([
  "prettier",
  "black",
  "ruff",
  "eslint",
  "stylelint",
  "gofmt",
  "goimports",
  "clang-format",
  "rustfmt",
  "shfmt",
  "biome",
  "pre-commit"
])
const TRANSFERS = new Set([
  "cp",
  "mv",
  "copy",
  "move",
  "copy-item",
  "move-item",
  "robocopy",
  "xcopy",
  "install",
  "curl",
  "wget"
])
const GENERATED_SCRIPT =
  /(?:^|[-_:/.])(fmt|format|lint|fix|codegen|generate|scaffold|snapshot|prettier|pre-commit)(?:$|[-_:/.])/i
const BUILD_SCRIPT =
  /(?:^|[-_:/.])(test|build|check|typecheck|install|ci|dev|serve|start)(?:$|[-_:/.])/i

function pathApi(cwd: string): typeof path {
  // Interpret the command's path syntax, not the host running the parser.
  return /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path.posix
}

function resolvePath(value: string, cwd: string): string | null {
  if (!value || value.startsWith("-") || /^[\d]+$/.test(value) || /[\r\n\0$`]/.test(value))
    return null
  if ([".", ".."].includes(value)) return cwd ? pathApi(cwd).resolve(cwd, value) : value
  if (value === "/dev/null" || /^nul$/i.test(value) || /^https?:\/\//i.test(value)) return null
  if (/^[A-Za-z]:[\\/]/.test(value)) return path.win32.normalize(value)
  const api = pathApi(cwd)
  const resolved = cwd ? api.resolve(cwd, value) : api.normalize(value)
  if (resolved === api.parse(resolved).root) return null
  return resolved
}

/** Telemetry only: does not execute, expand variables or authorize commands. */
function tokenize(command: string): Token[] {
  const result: Token[] = []
  let word = ""
  let active = false
  let quote = ""
  const flush = (): void => {
    if (active) result.push({ value: word })
    word = ""
    active = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) {
        quote = ""
        continue
      }
      if (c === "\\" && quote === '"' && ['"', "\\"].includes(command[i + 1])) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      active = true
      quote = c
      continue
    }
    if (c === "#" && !active) {
      while (i < command.length && command[i] !== "\n") i++
      i--
      continue
    }
    if (c === "\\" && /[\s'";|&<>]/.test(command[i + 1] ?? "")) {
      active = true
      word += command[++i]
      continue
    }
    if (c === "\n" || ";|&<>".includes(c)) {
      let op = c
      if ((c === "<" || c === ">") && /^\d$/.test(word)) {
        op = word + op
        word = ""
        active = false
      }
      flush()
      if (command[i + 1] === c && c !== ";" && c !== "\n") op += command[++i]
      result.push({ value: op, operator: true })
    } else if (/\s/.test(c)) flush()
    else {
      active = true
      word += c
    }
  }
  flush()
  return result
}

function segments(command: string): Segment[] {
  // Remove heredoc bodies: source-code words and fake commands are not shell.
  const lines = command.split("\n")
  const kept: string[] = []
  const delimiters: { name: string; tabs: boolean }[] = []
  for (const line of lines) {
    if (delimiters.length) {
      const d = delimiters[0]
      if ((d.tabs ? line.replace(/^\t+/, "") : line) === d.name) delimiters.shift()
      continue
    }
    kept.push(line)
    for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w]*)\2/g))
      delimiters.push({ name: m[3], tabs: m[1] === "-" })
  }
  const out: Segment[] = []
  let tokens: Token[] = []
  let pipeline = false
  const flush = (separator = ""): void => {
    if (tokens.length)
      out.push({
        tokens,
        pipeline,
        heredoc: tokens.some((t) => t.operator && t.value === "<<"),
        background: separator === "&"
      })
    tokens = []
  }
  for (const t of tokenize(kept.join("\n"))) {
    if (t.operator && [";", "&&", "||", "\n", "|", "&"].includes(t.value)) {
      flush(t.value)
      pipeline = t.value === "|"
    } else tokens.push(t)
  }
  flush()
  return out
}

function executable(value: string): string {
  return path.win32
    .basename(value.replace(/\//g, "\\"))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "")
}

function positional(args: string[], name: string, reading: boolean): string[] {
  const paths: string[] = []
  const takesValue = new Set([
    "-e",
    "--expression",
    "-g",
    "--glob",
    "--include",
    "--exclude",
    "-F",
    "--field-separator",
    "-f",
    "--file",
    "--encoding",
    "--color",
    "--max-count",
    "-m",
    "--line-range"
  ])
  let patternSeen =
    !["grep", "rg", "findstr", "sed", "awk", "jq", "tr"].includes(name) ||
    (name === "rg" && args.includes("--files"))
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const value = args[i]
    if (value === "--") {
      literal = true
      continue
    }
    if (!literal && takesValue.has(value)) {
      if (value === "-e" || value === "--expression") patternSeen = true
      i++
      continue
    }
    if (!literal && value.startsWith("-")) continue
    if (!patternSeen) {
      patternSeen = true
      continue
    }
    if (name === "tr" || (name === "cut" && /^\d/.test(value))) continue
    if (reading && /^(?:s\/|[/.^].*\/$)/.test(value)) continue
    paths.push(value)
  }
  return paths
}

function inlinePaths(script: string, cwd: string, reading: boolean): string[] {
  const out: string[] = []
  const method = reading
    ? /(?:readFile(?:Sync)?|open|Path|read_text|read_bytes)\s*\(\s*['"]([^'"\r\n]+)['"]/g
    : /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|open|Path)\s*\(\s*['"]([^'"\r\n]+)['"]/g
  for (const m of script.matchAll(method)) {
    const p = resolvePath(m[1], cwd)
    if (p) out.push(p)
  }
  return out
}

function classify(
  command: string,
  cwd: string,
  scriptBodies?: Map<string, string>,
  depth = 0
): ShellCommandProfile {
  const profile: ShellCommandProfile = {
    effects: [],
    namedPaths: [],
    readPaths: [],
    canWrite: false,
    hasLongRunning: false,
    background: false
  }
  const loopPaths: string[] = []
  const writtenScripts = new Set<string>()
  let currentCwd = cwd
  let pipelineReads: string[] = []
  for (const segment of segments(command)) {
    profile.background ||= segment.background
    if (!segment.pipeline) pipelineReads = []
    const tokens = [...segment.tokens]
    while (
      tokens[0] &&
      (/^\w+=/.test(tokens[0].value) ||
        ["do", "then", "else", "if", "command", "env", "sudo"].includes(tokens[0].value))
    )
      tokens.shift()
    if (!tokens.length || ["done", "fi"].includes(tokens[0].value)) continue
    if (tokens[0].value === "for") {
      const start = tokens.findIndex((t) => t.value === "in")
      if (start > 0)
        for (const t of tokens.slice(start + 1)) {
          const p = resolvePath(t.value, currentCwd)
          if (p) loopPaths.push(p)
        }
      continue
    }
    const name = executable(tokens[0].value)
    const words: string[] = []
    const outputs: string[] = []
    const inputs: string[] = []
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.operator && /^(?:\d)?(?:>|>>|<|<<)$/.test(t.value)) {
        const target = tokens[++i]?.value ?? ""
        const p = resolvePath(target, currentCwd)
        if (p && [">", ">>", "1>", "1>>"].includes(t.value)) outputs.push(p)
        if (p && t.value === "<") inputs.push(p)
      } else if (!t.operator) words.push(t.value)
    }
    if (["cd", "pushd", "set-location"].includes(name)) {
      const p = resolvePath(words.find((x) => x !== "/d") ?? "", currentCwd)
      if (p) currentCwd = p
      continue
    }
    if (["sh", "bash", "zsh", "cmd", "powershell", "pwsh"].includes(name) && depth < 3) {
      const index = words.findIndex((x) => /^-(?:c|lc|command)$/i.test(x) || x === "/c")
      if (index >= 0 && words[index + 1]) {
        const nested = classify(words[index + 1], currentCwd, scriptBodies, depth + 1)
        profile.effects.push(...nested.effects)
        profile.readPaths.push(...nested.readPaths)
        profile.hasLongRunning ||= nested.hasLongRunning
        profile.background ||= nested.background
        continue
      }
    }
    let paths = positional(words, name, false)
      .map((x) => resolvePath(x, currentCwd))
      .filter((x): x is string => !!x)
    const reads = [...inputs]
    if (READERS.has(name))
      reads.push(
        ...positional(words, name, true)
          .map((x) => resolvePath(x, currentCwd))
          .filter((x): x is string => !!x)
      )
    if (name === "git" && words.includes("show"))
      reads.push(
        ...words
          .filter((x) => /^HEAD:/.test(x))
          .map((x) => resolvePath(x.slice(5), currentCwd))
          .filter((x): x is string => !!x)
      )
    if (["python", "python3", "node", "ruby", "perl"].includes(name)) {
      reads.push(...inlinePaths(words.join(" "), currentCwd, true))
      if (name !== "perl" || !words.some((x) => /^-[pi]+$/.test(x)))
        paths = inlinePaths(words.join(" "), currentCwd, false)
    }
    profile.readPaths.push(...reads)
    pipelineReads.push(...reads)
    let kind: ShellWriteKind = "model"
    let writes = true
    const isFix = words.some(
      (x) => /^--(?:fix|write|update(?:Snapshot)?)$/.test(x) || ["-u", "-U", "-w", "-i"].includes(x)
    )
    if (["npm", "pnpm", "yarn", "bun", "npx"].includes(name)) {
      const index = words.findIndex((x) => ["run", "run-script", "exec", "dlx"].includes(x))
      const scriptName = index >= 0 ? words[index + 1] : words.find((x) => !x.startsWith("-"))
      const body = scriptName ? scriptBodies?.get(scriptName) : undefined
      if (body && depth < 3) {
        const nested = classify(body + (isFix ? " --fix" : ""), currentCwd, scriptBodies, depth + 1)
        profile.effects.push(...nested.effects)
        profile.hasLongRunning ||= nested.hasLongRunning
        profile.readPaths.push(...nested.readPaths)
        profile.background ||= nested.background
        continue
      }
      if (scriptName && (GENERATED_SCRIPT.test(scriptName) || FORMATTERS.has(scriptName) || isFix))
        kind = "generated"
      else if (
        scriptName &&
        (BUILD_SCRIPT.test(scriptName) ||
          ["install", "i", "ci", "add", "test", "t", "audit", "list", "ls"].includes(scriptName))
      ) {
        writes = false
        profile.hasLongRunning = true
      }
    } else if (FORMATTERS.has(name)) {
      kind = "generated"
      writes =
        !["prettier", "eslint", "stylelint", "ruff", "biome", "shfmt", "clang-format"].includes(
          name
        ) ||
        isFix ||
        words.includes("format")
    } else if (TRANSFERS.has(name)) {
      // A temp file authored earlier in this same command remains model code
      // when it is moved/copied into place; existing templates are transfers.
      kind =
        ["cp", "mv", "copy", "move"].includes(name) &&
        paths.slice(0, -1).some((p) => writtenScripts.has(p))
          ? "model"
          : "transfer"
    } else if (name === "git") {
      kind = "transfer"
      writes =
        words.some((x) =>
          [
            "checkout",
            "restore",
            "reset",
            "stash",
            "merge",
            "pull",
            "apply",
            "am",
            "cherry-pick",
            "rebase"
          ].includes(x)
        ) || outputs.length > 0
      paths = words
        .filter((x) => /[/.\\]/.test(x) && !x.startsWith("-"))
        .map((x) => resolvePath(x, currentCwd))
        .filter((x): x is string => !!x)
    } else if (
      BUILDERS.has(name) ||
      (["cargo", "go", "dotnet", "pip", "pip3", "uv", "poetry"].includes(name) &&
        words.some((x) =>
          ["test", "build", "check", "install", "sync", "restore", "run"].includes(x)
        ))
    ) {
      if (isFix || words.some((x) => /^(fmt|format|codegen|generate)$/.test(x))) kind = "generated"
      else {
        writes = false
        profile.hasLongRunning = true
      }
    } else if (READERS.has(name) || OBSERVERS.has(name)) {
      writes = outputs.length > 0 || (name === "sed" && words.some((x) => /^-i/.test(x)))
      if (outputs.length > 0 && ["cat", "type", "get-content"].includes(name) && !segment.heredoc)
        kind = "transfer"
    } else if (
      /\.(?:sh|bash|cmd|bat|ps1)$/i.test(tokens[0].value) ||
      (["sh", "bash", "zsh"].includes(name) && words[0])
    ) {
      const script = resolvePath(
        /[/.\\]/.test(tokens[0].value) ? tokens[0].value : words[0],
        currentCwd
      )
      const temporary = script && /(?:^|[\\/])(?:tmp|temp|T)(?:[\\/]|$)/i.test(script)
      if (!temporary && script && !writtenScripts.has(script)) {
        if (GENERATED_SCRIPT.test(script)) {
          kind = "generated"
          paths = []
        } else if (BUILD_SCRIPT.test(script)) {
          writes = false
          profile.hasLongRunning = true
        }
      }
    }
    if (/^(?:set-content|add-content|out-file|sc|ac)$/.test(name))
      paths = words
        .filter((x) => /[.\\/]/.test(x))
        .map((x) => resolvePath(x, currentCwd))
        .filter((x): x is string => !!x)
    if (writes) {
      const targets = [
        ...new Set([
          ...outputs,
          ...(outputs.length ? [] : paths),
          ...loopPaths,
          ...(segment.pipeline && outputs.length === 0 ? pipelineReads : [])
        ])
      ]
      profile.effects.push({ kind, paths: targets })
      if (kind === "model") for (const target of targets) writtenScripts.add(target)
    }
  }
  profile.background ||= /(?:^|[^&])&\s*$/.test(command)
  profile.namedPaths = [...new Set(profile.effects.flatMap((e) => e.paths))]
  profile.readPaths = [...new Set(profile.readPaths)]
  profile.canWrite = profile.effects.length > 0 && !profile.background
  return profile
}

const packageCache = new Map<string, { key: string; scripts: Map<string, string> }>()

export async function profileShellCommand(
  command: string,
  cwd: string
): Promise<ShellCommandProfile> {
  let scripts: Map<string, string> | undefined
  if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command)) {
    let dir = cwd
    for (let depth = 0; dir && depth < 8; depth++) {
      const file = path.join(dir, "package.json")
      try {
        const info = await stat(file)
        if (info.size > 256 * 1024) break
        const key = `${info.mtimeMs}:${info.size}`
        const cached = packageCache.get(file)
        if (cached?.key === key) scripts = cached.scripts
        else {
          const json = JSON.parse(await readFile(file, "utf8")) as {
            scripts?: Record<string, unknown>
          }
          scripts = new Map(
            Object.entries(json.scripts ?? {}).filter(
              (e): e is [string, string] => typeof e[1] === "string"
            )
          )
          if (packageCache.size >= 128) packageCache.delete(packageCache.keys().next().value!)
          packageCache.set(file, { key, scripts })
        }
        break
      } catch {
        /* No package scripts available; classify names instead. */
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return classify(command, cwd, scripts)
}

export function extractShellCommandReadPaths(command: string, cwd = ""): string[] {
  return classify(command, cwd).readPaths
}

/** Directory and glob scopes are matched only for attribution, never expanded/executed. */
export function shellPathMatches(scope: string, file: string): boolean {
  const normalize = (x: string): string => {
    const value = x.replace(/\\/g, "/").replace(/\/$/, "")
    return process.platform === "win32" || /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
  }
  const s = normalize(scope),
    f = normalize(file)
  if (!/[?*]/.test(s)) return f === s || f.startsWith(s + "/")
  const escaped = s
    .split(/(\*\*|\*|\?)/)
    .map((part) =>
      part === "**"
        ? ".*"
        : part === "*"
          ? "[^/]*"
          : part === "?"
            ? "[^/]"
            : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    )
    .join("")
  return new RegExp("^" + escaped + "(?:/.*)?$").test(f)
}
