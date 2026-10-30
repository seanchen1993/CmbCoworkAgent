import type { CommandShellSyntax } from "./exec-policy"

/** A non-executing structural lexer. Unresolved words remain words, not proof
 * that the command is read-only. This is NEVER an authorization parser. */
export interface TelemetryShellToken {
  value: string
  operator?: boolean
  dynamic?: boolean
  quoted?: boolean
  heredocBody?: string
}
export interface TelemetryShellSegment {
  tokens: TelemetryShellToken[]
  pipeline: boolean
  piped: boolean
  background: boolean
  /** This segment is the conditional right side of an AND/OR list. */
  conditional: boolean
}

export function telemetryShellSegments(
  command: string,
  syntax: CommandShellSyntax
): TelemetryShellSegment[] {
  const tokens: TelemetryShellToken[] = []
  const pending: { op: TelemetryShellToken; delimiter: string; tabs: boolean }[] = []
  let word = ""
  let active = false
  let quoted = false
  let dynamic = false
  let quote = ""
  let awaitingDoc: TelemetryShellToken | undefined
  const flush = (): void => {
    if (!active) return
    const token = { value: word, quoted, dynamic }
    tokens.push(token)
    if (awaitingDoc) {
      pending.push({ op: awaitingDoc, delimiter: word, tabs: awaitingDoc.value.endsWith("<<-") })
      awaitingDoc = undefined
    }
    word = ""
    active = quoted = dynamic = false
  }
  // Keep interpolation opaque, including separators INSIDE $(...). Never run
  // expansions just to obtain telemetry paths.
  const expansionEnd = (start: number): number => {
    const closing = command[start + 1] === "{" ? "}" : ")"
    const opening = command[start + 1]
    let level = 1
    let innerQuote = ""
    for (let i = start + 2; i < command.length; i++) {
      const c = command[i]
      if (c === "\\") {
        i++
        continue
      }
      if (innerQuote) {
        if (c === innerQuote) innerQuote = ""
      } else if (c === "'" || c === '"') innerQuote = c
      else if (c === opening) level++
      else if (c === closing && --level === 0) return i
    }
    return command.length - 1
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "$" && quote !== "'" && ["(", "{"].includes(command[i + 1])) {
      const end = expansionEnd(i)
      word += command.slice(i, end + 1)
      active = dynamic = true
      i = end
      continue
    }
    if (quote) {
      if (c === quote) {
        quote = ""
        continue
      }
      if (c === "\\" && quote === '"' && ['"', "\\", "$", "`"].includes(command[i + 1])) {
        word += command[++i]
      } else {
        if (c === "$" && quote !== "'") dynamic = true
        word += c
      }
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      active = quoted = true
      continue
    }
    if (c === "`") {
      active = dynamic = true
      const end = command.indexOf("`", i + 1)
      word += command.slice(i, end < 0 ? command.length : end + 1)
      i = end < 0 ? command.length : end
      continue
    }
    if (c === "#" && !active && syntax !== "cmd") {
      while (i < command.length && command[i] !== "\n") i++
      i--
      continue
    }
    if (c === "\\" && /[\s'";|&<>]/.test(command[i + 1] ?? "")) {
      if (command[i + 1] === "\n") {
        i++
        continue
      }
      active = true
      word += command[++i]
      continue
    }
    if (c === "\n") {
      flush()
      tokens.push({ value: "\n", operator: true })
      // Only real, unquoted << operators enqueue documents. Preserve their
      // program text as metadata, never tokenize it as shell commands.
      for (const doc of pending.splice(0)) {
        const body: string[] = []
        let found = false
        while (i + 1 < command.length) {
          const start = i + 1
          const end = command.indexOf("\n", start)
          const lineEnd = end < 0 ? command.length : end
          const line = command.slice(start, lineEnd).replace(/\r$/, "")
          i = lineEnd
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            found = true
            break
          }
          body.push(doc.tabs ? line.replace(/^\t+/, "") : line)
        }
        doc.op.heredocBody = body.join("\n")
        if (!found) doc.op.dynamic = true
      }
      continue
    }
    const operator = command.slice(i).match(/^(?:&>>?|\|&|&&|\|\||;;|>>|>&|<&|<<<|<<-?|<>|[;|&<>])/)
    // Parentheses/braces are structural only at word boundaries; ordinary
    // Windows paths and expression arguments keep their punctuation.
    const group = ["(", ")"].includes(c) || (!active && ["{", "}"].includes(c))
    if (operator || group) {
      let value = operator?.[0] ?? c
      if (/^[<>]/.test(value) && /^\d+$/.test(word)) {
        value = word + value
        word = ""
        active = false
      }
      flush()
      const token = { value, operator: true }
      tokens.push(token)
      if (["<<", "<<-"].includes(value.replace(/^\d+/, ""))) awaitingDoc = token
      i += (operator?.[0].length ?? 1) - 1
      continue
    }
    if (/\s/.test(c)) flush()
    else {
      active = true
      dynamic ||= c === "$"
      word += c
    }
  }
  flush()
  const segments: TelemetryShellSegment[] = []
  let words: TelemetryShellToken[] = []
  let pipeline = false
  let conditional = false
  const endSegment = (separator = ""): void => {
    if (words.length)
      segments.push({
        tokens: words,
        pipeline,
        piped: ["|", "|&"].includes(separator),
        background: syntax === "posix" && separator === "&",
        conditional
      })
    words = []
  }
  for (const token of tokens) {
    if (token.operator && [";", ";;", "&&", "||", "\n", "|", "|&", "&"].includes(token.value)) {
      endSegment(token.value)
      pipeline = ["|", "|&"].includes(token.value)
      conditional = ["&&", "||"].includes(token.value)
    } else if (token.operator && ["(", "{"].includes(token.value)) {
      endSegment()
      words.push(token)
      endSegment()
      // The group, not every command inside it, owns the outer pipeline/list.
      pipeline = conditional = false
    } else if (token.operator && [")", "}"].includes(token.value)) {
      endSegment()
      pipeline = conditional = false
      words.push(token)
    } else words.push(token)
  }
  endSegment()
  return segments
}
