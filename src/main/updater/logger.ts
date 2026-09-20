import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs"
import { dirname, join } from "path"
import { types } from "util"
import { redactLogValues } from "../log-redaction"
import { getOpenworkDir } from "../storage"

const MAX_LOG_BYTES = 5 * 1024 * 1024
type LogLevel = "log" | "warn" | "error"

/** Synchronous writes survive app.quit() and startup rollback. Logging never blocks an update. */
export function appendUpdateLog(logPath: string, level: LogLevel, args: unknown[]): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    try {
      if (existsSync(logPath) && statSync(logPath).size >= MAX_LOG_BYTES) {
        rmSync(`${logPath}.1`, { force: true })
        renameSync(logPath, `${logPath}.1`)
      }
    } catch {
      // A locked backup must not discard the current diagnostic if append still works.
    }
    const entry = {
      time: new Date().toISOString(),
      pid: process.pid,
      level,
      // Error.message/stack are non-enumerable; snapshot them before JSON serialization.
      details: redactLogValues(
        args.map((value) =>
          types.isNativeError(value)
            ? { name: value.name, message: value.message, stack: value.stack }
            : value
        )
      )
    }
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 })
  } catch {
    // A read-only/full disk must not change installation or rollback decisions.
  }
}

function write(level: LogLevel, args: unknown[]): void {
  try {
    appendUpdateLog(join(getOpenworkDir(), "updates", "updater.log"), level, args)
  } catch {
    // The data directory may itself be unavailable during startup.
  }
  try {
    console[level](...args)
  } catch {
    // A closed console pipe must not interrupt installation or rollback.
  }
}

export const updaterLog = {
  log: (...args: unknown[]): void => write("log", args),
  warn: (...args: unknown[]): void => write("warn", args),
  error: (...args: unknown[]): void => write("error", args)
}
