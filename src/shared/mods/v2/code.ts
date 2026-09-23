import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"

export interface FunctionCodeRow {
  kind: "source" | "header" | "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}

const invalid = (): never => {
  throw new ModFunctionError("MODS_UI_CODE_INVALID")
}

/** Bounded unified hunks only. Paths are metadata, never filesystem access. */
export function functionCodeRows(props: ModObject): FunctionCodeRow[] {
  const source = props.source
  if (typeof source !== "string" || source.length > 10000) return invalid()
  const lines = source.split("\n")
  if (props.format !== "diff")
    return lines.map((text, index) => ({
      kind: "source",
      text,
      ...(typeof props.startLine === "number" ? { newLine: props.startLine + index } : {})
    }))
  if (lines.at(-1) === "") lines.pop()
  let cursor = 0
  if (lines[0]?.startsWith("--- ")) {
    if (!lines[1]?.startsWith("+++ ")) return invalid()
    cursor = 2
  }
  const result: FunctionCodeRow[] = []
  while (cursor < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[cursor])
    if (!header) return invalid()
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
      return invalid()
    result.push({ kind: "header", text: lines[cursor++] })
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[cursor++]
      if (line === undefined) return invalid()
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
      } else return invalid()
      if (lines[cursor] === "\\ No newline at end of file") cursor++
    }
  }
  if (!result.length) return invalid()
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
