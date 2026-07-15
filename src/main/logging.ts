import { appendFileSync, existsSync, renameSync, statSync } from "fs"
import { getMainLogPath, getRendererLogPath } from "./storage"

const MAX_LOG_BYTES = 5 * 1024 * 1024

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size < MAX_LOG_BYTES) return

    const rotatedPath = `${filePath}.1`
    try {
      renameSync(filePath, rotatedPath)
    } catch {
      // Best effort rotation; if rename fails, keep appending to current file.
    }
  } catch {
    // Ignore logging failures to avoid impacting app behavior.
  }
}

function safeStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`
  }
  if (typeof value === "string") {
    return value
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value)
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`
  }
  if (typeof value === "symbol") {
    return value.toString()
  }
  if (typeof value !== "object") {
    return String(value)
  }

  try {
    return JSON.stringify(
      value,
      (_key, nestedValue) => {
        if (typeof nestedValue === "bigint") return `${nestedValue.toString()}n`
        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack
          }
        }
        if (typeof nestedValue === "function") {
          return `[Function ${nestedValue.name || "anonymous"}]`
        }
        if (typeof nestedValue === "symbol") {
          return nestedValue.toString()
        }
        if (nestedValue && typeof nestedValue === "object") {
          if (seen.has(nestedValue)) return "[Circular]"
          seen.add(nestedValue)
        }
        return nestedValue
      },
      2
    )
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function joinArgs(args: unknown[]): string {
  return args.map((arg) => safeStringify(arg)).join(" ")
}

function writeLine(filePath: string, level: string, message: string): void {
  try {
    rotateIfNeeded(filePath)
    const timestamp = new Date().toISOString()
    appendFileSync(filePath, `[${timestamp}] [${level}] ${message}\n`, "utf-8")
  } catch {
    // Never let file logging crash the app.
  }
}

export function writeMainLog(level: string, args: unknown[]): void {
  writeLine(getMainLogPath(), level, joinArgs(args))
}

export function writeRendererLog(
  level: string,
  message: string,
  meta?: { sourceId?: string; line?: number }
): void {
  const suffix = meta?.sourceId || typeof meta?.line === "number"
    ? ` (${meta?.sourceId || "unknown"}:${meta?.line ?? 0})`
    : ""
  writeLine(getRendererLogPath(), level, `${message}${suffix}`)
}
