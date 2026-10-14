import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { redactSensitiveText } from "./log-redaction"

interface Chunk {
  recordId: string
  index: number
  count: number
  plugin: string
  text: string
}
const roots: string[] = []
const loggers: Array<Awaited<ReturnType<typeof load>>> = []
const marker = "[Function Mods chunk] "

async function load(level = "INFO") {
  vi.resetModules()
  vi.stubEnv("CMB_LOG_LEVEL", level)
  const root = mkdtempSync(join(tmpdir(), "cmb-function-log-"))
  roots.push(root)
  const logs = join(root, "logs"),
    hooks = join(root, "hooks")
  mkdirSync(logs)
  mkdirSync(hooks)
  const path = join(logs, "main.log")
  vi.doMock("electron", () => ({ app: { isPackaged: false } }))
  vi.doMock("./storage", () => ({
    getLogsDir: () => logs,
    getMainLogPath: () => path,
    getRendererLogPath: () => join(logs, "renderer.log"),
    resolveHookLogDir: () => hooks
  }))
  return { ...(await import("./logging")), path }
}

function chunks(path: string): Chunk[] {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  return lines
    .filter((line) => line.includes(marker))
    .map((line) => {
      const start = line.indexOf(marker)
      expect(line.slice(start).length).toBeLessThan(16384)
      const value: Chunk = JSON.parse(line.slice(start + marker.length))
      expect(value.text.length).toBeLessThanOrEqual(2000)
      expect(value.count).toBeLessThanOrEqual(6)
      return value
    })
}

function expected(text: string): string {
  return redactSensitiveText(text)
    .slice(0, 10000)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
      part.length === 2 ? part : "\uFFFD"
    )
}

afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.flushLogs()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Invalid test directory")
    rmSync(root, { recursive: true, force: true })
  }
})

describe("bounded Function Mods debug file", () => {
  it("flushes every ordered chunk and reconstructs the complete bounded redacted text", async () => {
    const logger = await load()
    loggers.push(logger)
    const text = "FULL_LOG_START " + "x".repeat(9900) + " FULL_LOG_END"
    logger.writeFunctionModDebugLog("example", text)
    await logger.flushLogs()
    const rows = chunks(logger.path)
    expect(rows.map((row) => row.index)).toEqual(rows.map((_, i) => i + 1))
    expect(rows.every((row) => row.count === rows.length && row.plugin === "example")).toBe(true)
    expect(new Set(rows.map((row) => row.recordId)).size).toBe(1)
    expect(rows.map((row) => row.text).join("")).toBe(expected(text))
    expect(rows.at(-1)?.text.endsWith("FULL_LOG_END")).toBe(true)
  })

  it("redacts a credential crossing a cut point before writing any chunk", async () => {
    const logger = await load()
    loggers.push(logger)
    const token = "sk-actual-fixture-token-123456789"
    const text = "x".repeat(1994) + " " + token + " " + "y".repeat(6500)
    logger.writeFunctionModDebugLog("cross-cut", text)
    await logger.flushLogs()
    const persisted = readFileSync(logger.path, "utf8")
    expect(persisted).not.toContain(token)
    expect(
      chunks(logger.path)
        .map((row) => row.text)
        .join("")
    ).toBe(expected(text))
    expect(
      chunks(logger.path)
        .map((row) => row.text)
        .join("")
    ).toContain("[REDACTED]")
  })

  it("bounds expanding redactions and keeps JSON quoting, controls and surrogate pairs", async () => {
    const logger = await load()
    loggers.push(logger)
    const growing = "secret=x;".repeat(1100)
    const controls = "z".repeat(1999) + "😀" + '"\\\n\r\u0000'.repeat(900) + ":TAIL😀"
    expect(redactSensitiveText(growing).length).toBeGreaterThan(10000)
    logger.writeFunctionModDebugLog("expansion", growing)
    logger.writeFunctionModDebugLog("controls", controls)
    await logger.flushLogs()
    const rows = chunks(logger.path)
    for (const [plugin, input] of [
      ["expansion", growing],
      ["controls", controls]
    ]) {
      const group = rows.filter((row) => row.plugin === plugin)
      expect(group.map((row) => row.text).join("")).toBe(expected(input))
      expect(group.every((row) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(row.text))).toBe(true)
    }
    expect(new Set(rows.map((row) => row.recordId)).size).toBe(2)
  })

  it("keeps the old short console path and the ordinary string projection limit", async () => {
    const logger = await load()
    loggers.push(logger)
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined)
    logger.writeFunctionModDebugLog("short", "old log")
    expect(consoleInfo).toHaveBeenCalledExactlyOnceWith("[Function Mods] [short]", "old log")
    const projected = logger.writeMainLog("INFO", ["ORDINARY:" + "x".repeat(9000)])
    expect(String(projected[0]).length).toBeLessThan(2100)
    await logger.flushLogs()
    expect(readFileSync(logger.path, "utf8")).not.toContain("x".repeat(3000))
    expect(chunks(logger.path)).toEqual([])
  })

  it("does not emit partial records when the original INFO level is disabled", async () => {
    const logger = await load("WARN")
    loggers.push(logger)
    writeFileSync(logger.path, "existing\n")
    logger.writeFunctionModDebugLog("disabled", "x".repeat(10000))
    await logger.flushLogs()
    expect(readFileSync(logger.path, "utf8")).toBe("existing\n")
  })

  it("keeps the original file rotation and flushes the whole new record afterwards", async () => {
    const logger = await load()
    loggers.push(logger)
    writeFileSync(logger.path, "R".repeat(5 * 1024 * 1024))
    const text = "AFTER_ROTATION:" + "x".repeat(6000)
    logger.writeFunctionModDebugLog("rotation", text)
    await logger.flushLogs()
    expect(readFileSync(logger.path + ".1", "utf8").length).toBe(5 * 1024 * 1024)
    expect(
      chunks(logger.path)
        .map((row) => row.text)
        .join("")
    ).toBe(expected(text))
  })

  it("rejects oversized input before writing or printing it", async () => {
    const logger = await load()
    loggers.push(logger)
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined)
    writeFileSync(logger.path, "existing\n")
    expect(() => logger.writeFunctionModDebugLog("ok", "x".repeat(10001))).toThrow(
      "MODS_DEBUG_LOG_ARGUMENTS"
    )
    await logger.flushLogs()
    expect(consoleInfo).not.toHaveBeenCalled()
    expect(readFileSync(logger.path, "utf8")).toBe("existing\n")
  })

  it("accepts existing long plugin names and redacts their truncated diagnostic label", async () => {
    const logger = await load()
    loggers.push(logger)
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const token = "sk-long-label-fixture-token-123456789"
    const name = "p".repeat(110) + " " + token + " existing approved plugin"
    expect(name.length).toBeGreaterThan(128)
    logger.writeFunctionModDebugLog(name, "short")
    expect(consoleInfo).toHaveBeenCalledExactlyOnceWith(`[Function Mods] [${name}]`, "short")
    const text = "LONG_NAME_LOG " + "x".repeat(6000)
    expect(() => logger.writeFunctionModDebugLog(name, text)).not.toThrow()
    await logger.flushLogs()
    const rows = chunks(logger.path)
    expect(rows.every((row) => row.plugin.length <= 128)).toBe(true)
    expect(rows.every((row) => row.plugin.includes("[REDACTED]"))).toBe(true)
    expect(readFileSync(logger.path, "utf8")).not.toContain(token)
    expect(rows.map((row) => row.text).join("")).toBe(expected(text))
  })
})
