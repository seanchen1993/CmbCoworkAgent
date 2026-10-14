import { isAbsolute, relative } from "node:path"

export interface AuthoringCompileDiagnostic {
  code: "compile"
  message: string
  file?: string
  line?: number
  column?: number
}

/** Only compiler diagnostics about the bounded author source cross the Worker boundary. */
export function authoringCompileDiagnostics(
  error: unknown,
  directory: string
): AuthoringCompileDiagnostic[] {
  const result: AuthoringCompileDiagnostic[] = []
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || result.length >= 20 || !value || typeof value !== "object" || seen.has(value))
      return
    seen.add(value)
    if (!("errors" in value) || !Array.isArray(value.errors)) return
    for (const item of value.errors.slice(0, 20)) {
      if (result.length >= 20) break
      const before = result.length
      visit(item?.detail, depth + 1)
      if (
        result.length > before ||
        !item ||
        typeof item.text !== "string" ||
        !item.location ||
        typeof item.location.file !== "string"
      )
        continue
      const file = (
        isAbsolute(item.location.file)
          ? relative(directory, item.location.file)
          : item.location.file
      ).replace(/\\/g, "/")
      result.push(
        ...readAuthoringCompileDiagnostics([
          {
            code: "compile",
            message: item.text,
            file,
            line: item.location.line,
            column: item.location.column + 1
          }
        ])
      )
    }
  }
  visit(error, 0)
  return result
}

export function readAuthoringCompileDiagnostics(value: unknown): AuthoringCompileDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).flatMap((item) => {
    if (
      !item ||
      item.code !== "compile" ||
      typeof item.message !== "string" ||
      typeof item.file !== "string" ||
      item.file.length > 240 ||
      isAbsolute(item.file) ||
      /[\\:]/.test(item.file) ||
      [...item.file].some((char) => char.charCodeAt(0) < 32) ||
      item.file.split("/").includes("..") ||
      !/\.(?:[cm]?tsx?|jsx?)$/.test(item.file)
    )
      return []
    const position = (n: unknown): n is number =>
      Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 10_000_000
    return [
      {
        code: "compile" as const,
        message: item.message.slice(0, 500),
        file: item.file,
        ...(position(item.line) ? { line: item.line } : {}),
        ...(position(item.column) ? { column: item.column } : {})
      }
    ]
  })
}

export class AuthoringCompileError extends Error {
  constructor(readonly diagnostics: AuthoringCompileDiagnostic[]) {
    super("AUTHORING_COMPILE_FAILED")
  }
}
