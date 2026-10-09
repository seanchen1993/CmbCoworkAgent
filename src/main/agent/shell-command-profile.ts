import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import type { CommandShellSyntax } from "./exec-policy"
import { telemetryShellSegments, type TelemetryShellToken } from "./telemetry-shell-syntax"

// Exclusion is a content provenance too: tee/wrappers must not turn test logs
// back into model-generated code merely because they write them to disk.
export type ShellWriteKind = "model" | "generated" | "transfer" | "excluded"
export interface ShellWriteEffect {
  kind: ShellWriteKind
  paths: string[]
  /** Unresolved target, not a tool that intentionally writes workspace-wide. */
  scope?: "unknown"
}
export interface ShellCommandProfile {
  effects: ShellWriteEffect[]
  namedPaths: string[]
  readPaths: string[]
  canWrite: boolean
  hasLongRunning: boolean
  background: boolean
  /** stdout provenance survives wrappers/pipelines even without a file write. */
  stdoutKind?: ShellWriteKind
  unknownPaths?: boolean
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

function resolvePath(
  value: string,
  cwd: string,
  syntax: CommandShellSyntax = "posix"
): string | null {
  if (!value || value.startsWith("-") || /^[\d]+$/.test(value) || /[\r\n\0$`]/.test(value))
    return null
  if ([".", ".."].includes(value)) return cwd ? pathApi(cwd).resolve(cwd, value) : value
  if (value === "/dev/null" || /^nul$/i.test(value) || /^https?:\/\//i.test(value)) return null
  if (/^[A-Za-z]:[\\/]/.test(value)) return path.win32.normalize(value)
  if (syntax === "posix" && pathApi(cwd) === path.win32) {
    const msys = value.match(/^\/(?:cygdrive\/)?([a-z])(?:\/(.*))?$/i)
    if (msys) return path.win32.normalize(`${msys[1]}:/${msys[2] ?? ""}`)
  }
  const api = pathApi(cwd)
  const resolved = cwd ? api.resolve(cwd, value) : api.normalize(value)
  if (resolved === api.parse(resolved).root) return null
  return resolved
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

function inlinePaths(
  script: string,
  cwd: string,
  reading: boolean,
  syntax: CommandShellSyntax
): string[] {
  const out: string[] = []
  const method = reading
    ? /(?:readFile(?:Sync)?|open|Path|read_text|read_bytes)\s*\(\s*['"]([^'"\r\n]+)['"]/g
    : /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|open|Path)\s*\(\s*['"]([^'"\r\n]+)['"]/g
  for (const m of script.matchAll(method)) {
    const p = resolvePath(m[1], cwd, syntax)
    if (p) out.push(p)
  }
  return out
}

interface PackageScripts {
  cwd: string
  scripts: Map<string, string>
}

// null means unknown, not an empty/unset variable. Candidate sets are bounded
// and immutable: conditional branches cannot pretend their last lexical
// assignment is necessarily the branch that ran.
type VariableValues = ReadonlySet<string> | null
interface ShellEnvironment {
  cwd: string
  cwdKnown: boolean
  cwdValues: VariableValues
  variables: Map<string, VariableValues>
}

/** Yield only package lookups: the async driver can read metadata at the exact
 * effective cwd, while the sync read-path driver reuses the same parser without
 * I/O. No Shell expansion, script execution or duplicate command parser. */
function* classify(
  command: string,
  cwd: string,
  depth = 0,
  syntax: CommandShellSyntax = "posix",
  cwdKnown = true,
  stdinKind?: ShellWriteKind
): Generator<string, ShellCommandProfile, PackageScripts | undefined> {
  const profile: ShellCommandProfile = {
    effects: [],
    namedPaths: [],
    readPaths: [],
    canWrite: false,
    hasLongRunning: false,
    background: false
  }
  const scopes: {
    cwd: string
    cwdKnown: boolean
    paths: string[]
    kind?: ShellWriteKind
    subshell: boolean
    conditional: boolean
    stdinKind?: ShellWriteKind
    variables: Map<string, VariableValues>
    assignments: Map<string, VariableValues>
    cwdValues: VariableValues
    endCwdValues: VariableValues
    group: string
    branchEntry?: ShellEnvironment
  }[] = []
  let variables = new Map<string, VariableValues>()
  const writtenScripts = new Set<string>()
  let currentCwd = cwd
  let currentCwds: VariableValues = cwdKnown ? new Set([cwd]) : null
  let pipelineReads: string[] = []
  let pipelineKind: ShellWriteKind | undefined
  const addEffect = (kind: ShellWriteKind, paths: string[], unknown = false): void => {
    if (paths.length || !unknown) profile.effects.push({ kind, paths })
    if (unknown) profile.effects.push({ kind, paths: [], scope: "unknown" })
  }
  const mergeKind = (a: ShellWriteKind | undefined, b: ShellWriteKind): ShellWriteKind =>
    a === "excluded" || b === "excluded"
      ? "excluded"
      : a === "generated" || b === "generated"
        ? "generated"
        : a === "transfer" || b === "transfer"
          ? "transfer"
          : "model"
  const mergeValues = (a: VariableValues, b: VariableValues): VariableValues => {
    if (a === null || b === null) return null
    const values = new Set([...a, ...b])
    return values.size <= 32 ? values : null
  }
  const expandWord = (token: TelemetryShellToken): string[] => {
    if (!token.dynamic) return [token.value]
    let expanded = [""]
    let cursor = 0
    for (const match of token.value.matchAll(/\$(?:\{(\w+)\}|(\w+))/g)) {
      const key = match[1] ?? match[2]
      const values = key === "PWD" ? currentCwds : variables.get(key)
      if (!values || expanded.length * values.size > 32) return []
      expanded = expanded.flatMap((prefix) =>
        [...values].map((value) => prefix + token.value.slice(cursor, match.index) + value)
      )
      cursor = match.index! + match[0].length
    }
    return expanded.map((prefix) => prefix + token.value.slice(cursor))
  }
  const resolveWords = (token: TelemetryShellToken, directories = currentCwds): string[] => [
    ...new Set(
      expandWord(token).flatMap((value) => {
        const absolute = pathApi(currentCwd).isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
        const bases = absolute ? [currentCwd] : [...(directories ?? [])]
        return bases.flatMap((base) => {
          const resolved = resolvePath(value, base, syntax)
          return resolved ? [resolved] : []
        })
      })
    )
  ]
  const resolveWord = (token: TelemetryShellToken): string | null => {
    const values = resolveWords(token)
    return values.length === 1 ? values[0] : null
  }
  const resolveArgument = (value: string): string[] =>
    resolveWords({ value, dynamic: /[$`]/.test(value) })
  const setCwds = (values: VariableValues): void => {
    currentCwds = values
    cwdKnown = !!values && values.size === 1
    if (values?.size) currentCwd = values.values().next().value!
  }
  const environment = (): ShellEnvironment => ({
    cwd: currentCwd,
    cwdKnown,
    cwdValues: currentCwds,
    variables: new Map(variables)
  })
  const restoreEnvironment = (saved: ShellEnvironment): void => {
    currentCwd = saved.cwd
    cwdKnown = saved.cwdKnown
    currentCwds = saved.cwdValues
    variables = new Map(saved.variables)
  }
  const assignVariable = (token: TelemetryShellToken, conditional = false): void => {
    const assignment = token.value.match(/^(\w+)=(.*)$/s)!
    const expanded = expandWord({ ...token, value: assignment[2] })
    const assigned = expanded.length ? new Set(expanded) : null
    const values = conditional
      ? mergeValues(variables.get(assignment[1]) ?? null, assigned)
      : assigned
    variables.set(assignment[1], values)
    for (const scope of [...scopes].reverse()) {
      if (scope.conditional) {
        const prior = scope.assignments.get(assignment[1])
        scope.assignments.set(
          assignment[1],
          prior === undefined ? values : mergeValues(prior, values)
        )
      }
      if (scope.subshell) break
    }
  }
  const observeStdout = (kind: ShellWriteKind, redirected = false, piped = false): void => {
    pipelineKind = kind
    if (!redirected && !piped) {
      if (!scopes.length) profile.stdoutKind = mergeKind(profile.stdoutKind, kind)
      for (const scope of scopes) scope.kind = mergeKind(scope.kind, kind)
    }
  }
  for (const segment of telemetryShellSegments(command, syntax)) {
    profile.background ||= segment.background
    if (!segment.pipeline) {
      pipelineReads = []
      pipelineKind = scopes.at(-1)?.stdinKind ?? stdinKind
    }
    const tokens = [...segment.tokens]
    const first = tokens[0]?.value
    const branch = [...scopes].reverse().find((scope) => scope.group === "if")
    if (branch && first === "then" && !branch.branchEntry) {
      branch.branchEntry = environment()
      branch.endCwdValues = currentCwds
    } else if (branch && ["else", "elif"].includes(first)) {
      // Mutually exclusive arms start from the predicate's entry environment,
      // not the assignments/cd of a then arm that may never have executed.
      restoreEnvironment(branch.branchEntry ?? branch)
    }
    if (["for", "while", "until", "if", "case", "{", "("].includes(first)) {
      const scope = {
        ...environment(),
        paths: [] as string[],
        kind: undefined as ShellWriteKind | undefined,
        subshell: first === "(" || (syntax === "posix" && segment.pipeline),
        conditional: segment.conditional || ["for", "while", "until", "if", "case"].includes(first),
        stdinKind: pipelineKind,
        assignments: new Map<string, VariableValues>(),
        endCwdValues: currentCwds,
        group: first,
        branchEntry: undefined as ShellEnvironment | undefined
      }
      scopes.push(scope)
      if (first === "for") {
        const start = tokens.findIndex((t) => t.value === "in")
        if (start > 0)
          for (const t of tokens.slice(start + 1)) {
            const p = resolveWord(t)
            if (p) scope.paths.push(p)
          }
        continue
      }
      tokens.shift()
    }
    const closing = ["done", "fi", "esac", "}", ")"].includes(first) ? scopes.pop() : undefined
    if (closing) {
      tokens.shift()
      if (closing.subshell || (syntax === "posix" && segment.piped)) {
        restoreEnvironment(closing)
      } else if (closing.conditional) {
        for (const [key, assigned] of closing.assignments)
          variables.set(
            key,
            mergeValues((closing.branchEntry ?? closing).variables.get(key) ?? null, assigned)
          )
        setCwds(closing.endCwdValues)
        profile.unknownPaths ||= currentCwds === null
      }
    }
    const assignments: TelemetryShellToken[] = []
    while (
      tokens[0] &&
      (/^\w+=/.test(tokens[0].value) ||
        ["do", "then", "else", "elif", "if", "command", "env", "sudo"].includes(tokens[0].value))
    ) {
      if (/^\w+=/.test(tokens[0].value)) assignments.push(tokens[0])
      tokens.shift()
    }
    if (!tokens.length) {
      // Leading assignments on a command are temporary environment entries;
      // only assignment-only statements mutate the enclosing Shell variables.
      if (!(syntax === "posix" && (segment.pipeline || segment.piped)))
        for (const token of assignments) assignVariable(token, segment.conditional)
      if (closing?.kind) observeStdout(closing.kind, false, segment.piped)
      continue
    }
    const name = closing ? "compound" : executable(tokens[0].value)
    const words: string[] = []
    const outputs: string[] = []
    const inputs: string[] = []
    const programs: string[] = []
    // A known null device is not a file target; an unresolved target IS a
    // potential write and must keep the observation window open.
    let hasOutput = false
    let stdoutRedirected = false
    let unknownOutput = false
    let heredoc = false
    for (let i = closing ? 0 : 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.operator && /^(?:\d+)?(?:>|>>|<|<<-?|<<<|<>|>&|<&)$|^&>>?$/.test(t.value)) {
        const target = tokens[++i]
        const operator = t.value.replace(/^\d+/, "")
        if (["<<", "<<-", "<<<"].includes(operator)) {
          heredoc = true
          if (t.heredocBody) programs.push(t.heredocBody)
          continue
        }
        if ([">&", "<&"].includes(operator) && /^\d+$|^-$/.test(target?.value ?? "")) continue
        const targets = target
          ? resolveWords(target, closing ? closing.cwdValues : currentCwds)
          : []
        if ([">", ">>", "&>", "&>>", ">&", "<>"].includes(operator)) {
          stdoutRedirected ||= !/^\d/.test(t.value) || /^[01]/.test(t.value)
          const nullDevice = !!target && /^(?:\/dev\/null|nul)$/i.test(target.value)
          hasOutput ||= !nullDevice
          if (targets.length) outputs.push(...targets)
          else if (!nullDevice) unknownOutput = true
        }
        if (operator === "<") inputs.push(...targets)
      } else if (!t.operator) words.push(t.value)
    }
    if (["cd", "pushd", "set-location"].includes(name)) {
      const target = tokens.find(
        (token, index) => index > 0 && !token.operator && token.value !== "/d"
      )
      const targets = target ? resolveWords(target) : []
      const next = targets.length ? new Set(targets) : null
      // Each pipeline command has its own environment in the POSIX path.
      if (syntax === "posix" && (segment.pipeline || segment.piped)) continue
      setCwds(segment.conditional ? mergeValues(currentCwds, next) : next)
      for (const scope of [...scopes].reverse()) {
        if (scope.conditional) scope.endCwdValues = mergeValues(scope.endCwdValues, currentCwds)
        if (scope.subshell) break
      }
      if (!currentCwds) profile.unknownPaths = true
      continue
    }
    if (["sh", "bash", "zsh", "cmd", "powershell", "pwsh"].includes(name) && depth < 3) {
      const index = words.findIndex((x) => /^-(?:c|lc|command)$/i.test(x) || x === "/c")
      if (index >= 0 && words[index + 1]) {
        const nestedSyntax = ["sh", "bash", "zsh"].includes(name)
          ? "posix"
          : name === "cmd"
            ? "cmd"
            : "powershell"
        const nested = yield* classify(
          words[index + 1],
          currentCwd,
          depth + 1,
          nestedSyntax,
          cwdKnown,
          heredoc || inputs.length ? undefined : pipelineKind
        )
        profile.effects.push(...nested.effects)
        profile.readPaths.push(...nested.readPaths)
        profile.hasLongRunning ||= nested.hasLongRunning
        profile.background ||= nested.background
        profile.unknownPaths ||= nested.unknownPaths
        const source = nested.stdoutKind ?? "model"
        if (hasOutput) addEffect(source, outputs, unknownOutput)
        profile.unknownPaths ||= unknownOutput
        observeStdout(source, stdoutRedirected, segment.piped)
        continue
      }
    }
    let paths = positional(words, name, false).flatMap(resolveArgument)
    const reads = [...inputs]
    if (READERS.has(name)) reads.push(...positional(words, name, true).flatMap(resolveArgument))
    if (name === "git" && words.includes("show"))
      reads.push(
        ...words.filter((x) => /^HEAD:/.test(x)).flatMap((x) => resolveArgument(x.slice(5)))
      )
    if (["python", "python3", "node", "ruby", "perl"].includes(name)) {
      const program = [words.join(" "), ...programs].join("\n")
      reads.push(
        ...[...(currentCwds ?? [])].flatMap((dir) => inlinePaths(program, dir, true, syntax))
      )
      if (name !== "perl" || !words.some((x) => /^-[pi]+$/.test(x)))
        paths = [...(currentCwds ?? [])].flatMap((dir) => inlinePaths(program, dir, false, syntax))
    }
    profile.readPaths.push(...reads)
    pipelineReads.push(...reads)
    let kind: ShellWriteKind = closing?.kind ?? "model"
    let writes = true
    const isFix = words.some(
      (x) => /^--(?:fix|write|update(?:Snapshot)?)$/.test(x) || ["-u", "-U", "-w", "-i"].includes(x)
    )
    if (["npm", "pnpm", "yarn", "bun", "npx"].includes(name)) {
      const args: string[] = []
      let packageDir = currentCwd,
        packageKnown = cwdKnown
      const directoryFlags =
        name === "npm" ? ["--prefix"] : name === "pnpm" ? ["-C", "--dir"] : ["--cwd"]
      for (let index = 0; index < words.length; index++) {
        const arg = words[index]
        const flag = directoryFlags.find((flag) => arg === flag || arg.startsWith(flag + "="))
        if (flag) {
          const target = arg === flag ? words[++index] : arg.slice(flag.length + 1)
          const resolved = resolvePath(target ?? "", currentCwd, syntax)
          if (resolved) packageDir = resolved
          else packageKnown = false
        } else args.push(arg)
      }
      const index = args.findIndex((x) => ["run", "run-script", "exec", "dlx"].includes(x))
      const scriptIndex = index >= 0 ? index + 1 : args.findIndex((x) => !x.startsWith("-"))
      const scriptName = args[scriptIndex]
      const packageInfo = name !== "npx" && packageKnown ? yield packageDir : undefined
      const body = scriptName ? packageInfo?.scripts.get(scriptName) : undefined
      const generated =
        !!scriptName && (GENERATED_SCRIPT.test(scriptName) || FORMATTERS.has(scriptName) || isFix)
      const build =
        !!scriptName &&
        (BUILD_SCRIPT.test(scriptName) ||
          ["install", "i", "ci", "add", "test", "t", "audit", "list", "ls"].includes(scriptName))
      if (body && depth < 3) {
        // Requote argv without executing it. Script arguments can contain
        // separators/literals and must not become additional Shell commands.
        const forwardedArgs = args.slice(scriptIndex + 1)
        if (forwardedArgs[0] === "--") forwardedArgs.shift()
        const forwarded = forwardedArgs
          .map((arg) =>
            syntax === "posix" ? "'" + arg.replace(/'/g, "'\\''") + "'" : JSON.stringify(arg)
          )
          .join(" ")
        const nested = yield* classify(
          body + (forwarded ? " " + forwarded : ""),
          packageInfo!.cwd,
          depth + 1,
          syntax,
          true,
          heredoc || inputs.length ? undefined : pipelineKind
        )
        if (generated) {
          addEffect("generated", hasOutput ? outputs : nested.namedPaths, unknownOutput)
        } else if (build) {
          profile.hasLongRunning = true
          if (hasOutput) addEffect("excluded", outputs, unknownOutput)
        } else {
          profile.effects.push(...nested.effects)
          if (hasOutput) addEffect(nested.stdoutKind ?? "model", outputs, unknownOutput)
          profile.hasLongRunning ||= nested.hasLongRunning
        }
        profile.readPaths.push(...nested.readPaths)
        profile.background ||= nested.background
        profile.unknownPaths ||= nested.unknownPaths || unknownOutput
        observeStdout(
          generated ? "generated" : build ? "excluded" : (nested.stdoutKind ?? "model"),
          stdoutRedirected,
          segment.piped
        )
        continue
      }
      if (generated) kind = "generated"
      else if (build) {
        writes = false
        kind = "excluded"
        profile.hasLongRunning = true
      }
    } else if (FORMATTERS.has(name)) {
      kind = "generated"
      writes =
        hasOutput ||
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
      // Download stdout is a transfer producer, not an unscoped disk write.
      // Otherwise `curl ... && printf > a.ts` would suppress the latter's A
      // attribution simply because an unrelated download appeared first.
      if (name === "curl") {
        const outputIndex = words.findIndex((x) => x === "-o" || x === "--output")
        const output =
          outputIndex >= 0 ? resolvePath(words[outputIndex + 1] ?? "", currentCwd, syntax) : null
        paths = output ? [output] : []
        writes =
          hasOutput ||
          outputIndex >= 0 ||
          words.some((x) => x === "-O" || x === "--remote-name" || /^--output=|^-o./.test(x))
      }
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
        ) || hasOutput
      paths = words.filter((x) => /[/.\\]/.test(x) && !x.startsWith("-")).flatMap(resolveArgument)
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
        kind = "excluded"
        profile.hasLongRunning = true
      }
    } else if (READERS.has(name) || OBSERVERS.has(name)) {
      writes = hasOutput || (name === "sed" && words.some((x) => /^-i/.test(x)))
      if (["cat", "type", "get-content", "gc", "head", "tail"].includes(name) && !heredoc)
        kind = reads.length ? "transfer" : (pipelineKind ?? "transfer")
    } else if (name === "tee") {
      kind = pipelineKind ?? "model"
    } else if (
      /\.(?:sh|bash|cmd|bat|ps1)$/i.test(tokens[0].value) ||
      (["sh", "bash", "zsh"].includes(name) && words[0])
    ) {
      const script = resolvePath(
        /[/.\\]/.test(tokens[0].value) ? tokens[0].value : words[0],
        currentCwd,
        syntax
      )
      const temporary = script && /(?:^|[\\/])(?:tmp|temp|T)(?:[\\/]|$)/i.test(script)
      if (!temporary && script && !writtenScripts.has(script)) {
        if (GENERATED_SCRIPT.test(script)) {
          kind = "generated"
          paths = []
        } else if (BUILD_SCRIPT.test(script)) {
          writes = false
          kind = "excluded"
          profile.hasLongRunning = true
        }
      }
    }
    if (/^(?:set-content|add-content|out-file|sc|ac)$/.test(name))
      paths = words.filter((x) => /[.\\/]/.test(x)).flatMap(resolveArgument)
    // Only stdin consumers inherit excluded input; e.g. printf ignores stdin
    // and must remain A even after a test pipeline. Recursion receives the
    // same provenance instead of losing it at a wrapper's early return.
    const incoming = heredoc || inputs.length ? undefined : pipelineKind
    const consumesStdin =
      name === "tee" ||
      (READERS.has(name) && reads.length === 0) ||
      (FORMATTERS.has(name) && paths.length === 0) ||
      (!OBSERVERS.has(name) &&
        !READERS.has(name) &&
        !FORMATTERS.has(name) &&
        !TRANSFERS.has(name) &&
        name !== "git" &&
        !closing)
    const stdoutSource = incoming === "excluded" && consumesStdin ? "excluded" : kind
    observeStdout(stdoutSource, stdoutRedirected, segment.piped)
    if (hasOutput || name === "tee") kind = stdoutSource
    if (closing) writes = hasOutput
    if (writes || (kind === "excluded" && hasOutput)) {
      const targets = [
        ...new Set([
          ...outputs,
          ...(hasOutput ? [] : paths),
          ...scopes.flatMap((scope) => scope.paths),
          ...(segment.pipeline && outputs.length === 0 ? pipelineReads : [])
        ])
      ]
      addEffect(kind, targets, unknownOutput)
      profile.unknownPaths ||= unknownOutput
      if (kind === "model") for (const target of targets) writtenScripts.add(target)
    }
  }
  profile.namedPaths = [...new Set(profile.effects.flatMap((e) => e.paths))]
  profile.readPaths = [...new Set(profile.readPaths)]
  profile.canWrite =
    profile.effects.some((effect) => effect.kind !== "excluded") && !profile.background
  return profile
}

const packageCache = new Map<string, { key: string; scripts: Map<string, string> }>()

async function readPackageScripts(cwd: string): Promise<PackageScripts | undefined> {
  let dir = cwd
  for (let depth = 0; dir && depth < 8; depth++) {
    const file = pathApi(dir).join(dir, "package.json")
    try {
      const info = await stat(file)
      if (info.size > 256 * 1024) return undefined
      const key = `${info.mtimeMs}:${info.size}`
      const cached = packageCache.get(file)
      let scripts: Map<string, string>
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
      return { cwd: dir, scripts }
    } catch {
      /* No package scripts available; classify names instead. */
    }
    const parent = pathApi(dir).dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export async function profileShellCommand(
  command: string,
  cwd: string,
  syntax: CommandShellSyntax = "posix"
): Promise<ShellCommandProfile> {
  const iterator = classify(command, cwd, 0, syntax)
  const packages = new Map<string, PackageScripts | undefined>()
  let step = iterator.next()
  while (!step.done) {
    const directory = step.value
    if (!packages.has(directory)) packages.set(directory, await readPackageScripts(directory))
    step = iterator.next(packages.get(directory))
  }
  return step.value
}

export function extractShellCommandReadPaths(
  command: string,
  cwd = "",
  syntax: CommandShellSyntax = "posix"
): string[] {
  const iterator = classify(command, cwd, 0, syntax)
  let step = iterator.next()
  while (!step.done) step = iterator.next(undefined)
  return step.value.readPaths
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
