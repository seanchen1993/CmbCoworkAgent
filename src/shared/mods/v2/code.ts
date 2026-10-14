import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"
import { functionUiTextProjection } from "./ui-text"

export const FUNCTION_CODE_MAX_DRAW_CHARS = 100000

export interface FunctionCodeRow {
  kind: "source" | "header" | "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}

const invalid = (): never => {
  throw new ModFunctionError("MODS_UI_CODE_INVALID")
}

export interface FunctionCodeView {
  source: string
  rows: FunctionCodeRow[]
  diff: boolean
  diffFallback: boolean
}

/** Full data is validated before only its display copy is bounded. No filesystem access. */
export function functionCodeSource(original: unknown): string {
  if (typeof original !== "string") return invalid()
  for (let index = 0; index < original.length; index++) {
    const code = original.charCodeAt(index)
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) return invalid()
  }
  return functionUiTextProjection(original, FUNCTION_CODE_MAX_DRAW_CHARS)
}

export function functionCodeView(props: ModObject): FunctionCodeView {
  const source = functionCodeSource(props.source)
  const lines = source.split("\n")
  const diff = props.format === "diff" ? unifiedRows([...lines]) : undefined
  if (diff) return { source, rows: diff, diff: true, diffFallback: false }
  return {
    source,
    diff: false,
    diffFallback: props.format === "diff",
    rows: lines.map((text, index) => ({
      kind: "source",
      text,
      ...(props.format !== "diff" && typeof props.startLine === "number"
        ? { newLine: props.startLine + index }
        : {})
    }))
  }
}

export function functionCodeRows(props: ModObject): FunctionCodeRow[] {
  return functionCodeView(props).rows
}

function unifiedRows(lines: string[]): FunctionCodeRow[] | undefined {
  if (lines.at(-1) === "") lines.pop()
  let cursor = 0
  if (lines[0]?.startsWith("--- ")) {
    if (!lines[1]?.startsWith("+++ ")) return undefined
    cursor = 2
  }
  const result: FunctionCodeRow[] = []
  while (cursor < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[cursor])
    if (!header) return undefined
    let oldLine = Number(header[1]),
      newLine = Number(header[3])
    let oldLeft = Number(header[2] ?? 1),
      newLeft = Number(header[4] ?? 1)
    if (
      [oldLine, newLine, oldLeft, newLeft].some(
        (n) => !Number.isSafeInteger(n) || n > 1000000000
      ) ||
      oldLeft + newLeft === 0 ||
      (oldLeft > 0 && oldLine === 0) ||
      (newLeft > 0 && newLine === 0)
    )
      return undefined
    result.push({ kind: "header", text: lines[cursor++] })
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[cursor++]
      if (line === undefined) return undefined
      const text = line.slice(1)
      if (line[0] === " " && oldLeft > 0 && newLeft > 0) {
        result.push({ kind: "context", text, oldLine: oldLine++, newLine: newLine++ })
        oldLeft--
        newLeft--
      } else if (line[0] === "-" && oldLeft > 0) {
        result.push({ kind: "remove", text, oldLine: oldLine++ })
        oldLeft--
      } else if (line[0] === "+" && newLeft > 0) {
        result.push({ kind: "add", text, newLine: newLine++ })
        newLeft--
      } else return undefined
      if (lines[cursor] === "\\ No newline at end of file") cursor++
    }
  }
  if (!result.length) return undefined
  return result
}

const languages: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  python: "python",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql"
}

/** Limited to grammars already shipped by the application's highlight worker. */
export function functionCodeLanguage(props: ModObject): string | null {
  const known = (name: string) => (Object.hasOwn(languages, name) ? languages[name] : null)
  if (typeof props.language === "string") return known(props.language.toLowerCase())
  const name = typeof props.path === "string" ? props.path.split(/[\\/]/).at(-1)?.toLowerCase() : ""
  const extension = name?.includes(".") ? name.split(".").at(-1) : name
  if (extension && known(extension)) return known(extension)
  const first = typeof props.source === "string" ? props.source.split("\n", 1)[0] : ""
  if (/^#!.*\bpython[\d.]*\b/.test(first)) return "python"
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(first)) return "bash"
  if (/^#!.*\bnode\b/.test(first)) return "javascript"
  return null
}
