type Part = string | { variable: string } | { substitution: Token[] }
type Word = { kind: "word"; parts: Part[]; plain: boolean }
type Token = Word | { kind: "operator"; value: string }
type Scope = ReadonlyMap<string, string>

// This is deliberately a bounded subset, not a general shell evaluator. Any
// unsupported syntax falls back to the ordinary conservative Git safety checks.
class Lexer {
  private index = 0

  constructor(private readonly source: string) {}

  read(depth = 0): Token[] {
    if (depth > 4) throw new Error("substitution nesting")
    const tokens: Token[] = []
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      if (char === ")" && depth > 0) {
        this.index++
        return tokens
      }
      if (char === " " || char === "\t") {
        this.index++
      } else if (char === "#") {
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index++
      } else if (char === ";" || char === "\n") {
        tokens.push({ kind: "operator", value: ";" })
        this.index++
      } else if (char === "|" || char === "&") {
        const pair = this.source.slice(this.index, this.index + 2)
        const value = pair === "||" || pair === "&&" ? pair : char
        if (value === "&") throw new Error("background execution")
        tokens.push({ kind: "operator", value })
        this.index += value.length
      } else if (/^2>&1(?=$|[\s;|&])/.test(this.source.slice(this.index))) {
        tokens.push({ kind: "operator", value: "2>&1" })
        this.index += 4
      } else {
        tokens.push(this.word(depth))
      }
      if (tokens.length > 2048) throw new Error("token budget")
    }
    if (depth > 0) throw new Error("unclosed substitution")
    return tokens
  }

  private word(depth: number): Word {
    const word: Word = { kind: "word", parts: [], plain: true }
    let text = ""
    let quote = ""
    let started = false
    const flush = (): void => {
      if (text) word.parts.push(text)
      text = ""
    }
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      if (!quote && /[\s;|&)]/.test(char)) break
      started = true
      if (quote === "'") {
        if (char === "'") quote = ""
        else text += char
        this.index++
      } else if (char === quote && quote) {
        quote = ""
        this.index++
      } else if (!quote && (char === "'" || char === '"')) {
        quote = char
        word.plain = false
        this.index++
      } else if (char === "\\") {
        word.plain = false
        const next = this.source[++this.index]
        if (next === undefined) throw new Error("unfinished escape")
        if (quote === '"' && !'"\\$`\n'.includes(next)) text += "\\"
        if (next !== "\n") text += next
        this.index++
      } else if (char === "$") {
        word.plain = false
        flush()
        this.index++
        if (this.source[this.index] === "(") {
          this.index++
          word.parts.push({ substitution: this.read(depth + 1) })
        } else {
          const rest = this.source.slice(this.index)
          const match = rest.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}|^([A-Za-z_][A-Za-z0-9_]*)/)
          if (!match) throw new Error("unsupported expansion")
          word.parts.push({ variable: match[1] ?? match[2] })
          this.index += match[0].length
        }
      } else {
        if (
          char === "`" ||
          (!quote && ("<>(){}*?[]".includes(char) || (char === "~" && !text && !word.parts.length)))
        ) {
          throw new Error("unsupported shell syntax")
        }
        text += char
        this.index++
      }
    }
    if (!started || quote) throw new Error("invalid word")
    flush()
    return word
  }
}

function literal(word: Word | undefined): string | null {
  return word && word.parts.every((part) => typeof part === "string") ? word.parts.join("") : null
}

function resolveWord(word: Word, scope: Scope, allowSubstitution = false): string {
  return word.parts
    .map((part) => {
      if (typeof part === "string") return part
      if ("variable" in part) {
        const value = scope.get(part.variable)
        if (value === undefined) throw new Error("unbound variable")
        return value
      }
      if (!allowSubstitution || !new Parser(part.substitution, scope).parse(false)) {
        throw new Error("unverified command substitution")
      }
      return "query_output"
    })
    .join("")
}

const QUERY_FLAGS = new Set([
  "--oneline",
  "--stat",
  "--shortstat",
  "--numstat",
  "--name-only",
  "--name-status",
  "--no-patch",
  "--no-decorate",
  "--decorate",
  "--no-color",
  "--color=never",
  "--no-ext-diff",
  "--no-textconv",
  "--abbrev-commit",
  "--all",
  "--no-merges",
  "--merges",
  "--first-parent",
  "--reverse",
  "--topo-order",
  "--short",
  "--branch",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--check",
  "--cached",
  "--staged",
  "-s"
])
const QUERY_VALUE_FLAGS = new Set(["--max-count", "-n"])

function gitQuery(words: Word[], scope: Scope): boolean {
  let index = 1
  if (literal(words[index]) === "--no-pager") index++
  if (!["log", "show", "status", "diff"].includes(literal(words[index]) ?? "")) return false
  let paths = false
  for (index++; index < words.length; index++) {
    const word = words[index]
    const value = resolveWord(word, scope)
    if (paths) continue
    if (value === "--" && literal(word) === "--") {
      paths = true
    } else if (value.startsWith("-")) {
      if (literal(word) === null) return false
      if (QUERY_FLAGS.has(value) || /^-(?:n)?\d{1,6}$/.test(value)) continue
      if (/^--(?:format|pretty|date|max-count)=/.test(value)) continue
      // Optional-value options such as --pretty must use =value. Consuming
      // the next word here could hide a separate --ext-diff/--output option.
      if (!QUERY_VALUE_FLAGS.has(value) || !words[index + 1]) return false
      if (!/^\d{1,6}$/.test(literal(words[++index]) ?? "")) return false
    }
  }
  return true
}

class Parser {
  private index = 0
  private sawLoop = false

  constructor(
    private readonly tokens: Token[],
    private readonly scope: Scope = new Map()
  ) {}

  parse(requireLoop: boolean): boolean {
    this.list(this.scope, requireLoop)
    return this.index === this.tokens.length && (!requireLoop || this.sawLoop)
  }

  private at(value: string): boolean {
    const token = this.tokens[this.index]
    return token?.kind === "operator"
      ? token.value === value
      : token?.plain === true && literal(token) === value
  }

  private take(value: string): void {
    if (!this.at(value)) throw new Error(`expected ${value}`)
    this.index++
  }

  private list(scope: Scope, allowLoop: boolean, inLoop = false): void {
    while (this.at(";")) this.index++
    if (this.index === this.tokens.length || (inLoop && this.at("done"))) {
      throw new Error("empty command list")
    }
    while (true) {
      this.command(scope, allowLoop)
      while (this.at("2>&1")) this.index++
      if (["|", "&&", "||"].some((value) => this.at(value))) {
        this.index++
        while (this.at(";")) this.index++
        continue
      }
      if (this.at(";")) {
        while (this.at(";")) this.index++
        if (this.index === this.tokens.length || (inLoop && this.at("done"))) return
      } else if (this.index === this.tokens.length) {
        return
      } else {
        throw new Error("unexpected syntax")
      }
    }
  }

  private command(scope: Scope, allowLoop: boolean): void {
    if (allowLoop && this.at("for")) {
      this.loop(scope)
      return
    }
    const words: Word[] = []
    while (this.tokens[this.index]?.kind === "word") {
      words.push(this.tokens[this.index++] as Word)
    }
    if (!words.length) throw new Error("missing command")
    const executable = literal(words[0])
    if (executable === "git" && words.length > 1 && gitQuery(words, scope)) return
    if (executable === "echo") {
      words.slice(1).forEach((word) => resolveWord(word, scope, true))
      return
    }
    if (executable === "printf" && words.length > 1) {
      const format = literal(words[1])
      // Bash printf's -v and %n can assign shell variables; numeric conversions
      // can evaluate arithmetic. Only literal %s/%% formats are recognized here.
      if (
        format !== null &&
        !format.startsWith("-") &&
        !format.replace(/%[%s]/g, "").includes("%")
      ) {
        words.slice(2).forEach((word) => resolveWord(word, scope, true))
        return
      }
    }
    if (executable === "head") {
      const args = words.slice(1).map((word) => literal(word))
      if (
        args.length === 0 ||
        (args.length === 1 && /^-\d{1,6}$/.test(args[0] ?? "")) ||
        (args.length === 2 && args[0] === "-n" && /^\d{1,6}$/.test(args[1] ?? ""))
      )
        return
    }
    if (executable === "cd" && allowLoop && scope.size === 0) {
      const args = words.slice(1).map((word) => literal(word))
      if ((args.length === 1 && args[0]) || (args.length === 2 && args[0] === "--" && args[1]))
        return
    }
    throw new Error("command is not a supported read-only operation")
  }

  private loop(scope: Scope): void {
    this.take("for")
    const variable = this.tokens[this.index++]
    const name = variable?.kind === "word" ? literal(variable) : null
    if (
      !name ||
      !/^[a-z][a-z0-9_]*$/.test(name) ||
      /^(?:path|fpath|cdpath|ifs|env|home)$/.test(name)
    ) {
      throw new Error("unsupported loop variable")
    }
    this.take("in")
    const values: string[] = []
    while (this.tokens[this.index]?.kind === "word") {
      const value = literal(this.tokens[this.index++] as Word)
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9._/@~-]*$/.test(value)) {
        throw new Error("nonliteral or option-like loop value")
      }
      values.push(value)
    }
    if (!values.length || values.length > 256) throw new Error("loop value budget")
    this.take(";")
    while (this.at(";")) this.index++
    this.take("do")
    this.sawLoop = true
    const bodyScope = new Map(scope).set(name, values[0])
    this.list(bodyScope, false, true)
    this.take("done")
  }
}

export function isReadOnlyPosixForLoop(command: string): boolean {
  if (command.length > 16_384 || !/\bfor\b/.test(command)) return false
  try {
    return new Parser(new Lexer(command).read()).parse(true)
  } catch {
    return false
  }
}
