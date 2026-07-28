import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const tempRoots: string[] = []

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("logging redaction integration", () => {
  it("migrates historical logs and redacts new main and renderer writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-redaction-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    const hookLog = join(hooksDir, "hooks.2026-07-27.jsonl")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(mainLog, "idCard=11010119900307123X\n", "utf8")
    writeFileSync(rendererLog, "phone=13800138000\n", "utf8")
    writeFileSync(hookLog, '{"password":"historical-secret"}\n', "utf8")

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, initializeLogRedaction, writeMainLog, writeRendererLog } =
      await import("./logging")
    const initialized = initializeLogRedaction()

    expect(initialized).toMatchObject({
      alreadyComplete: false,
      scannedFiles: 3,
      redactedFiles: 3,
      failedFiles: 0
    })
    expect(readFileSync(mainLog, "utf8")).toContain("110101********123X")
    expect(readFileSync(rendererLog, "utf8")).toContain("138****8000")
    expect(readFileSync(hookLog, "utf8")).not.toContain("historical-secret")

    const terminalArgs = writeMainLog("INFO", [
      {
        contactPhone: "13900139000",
        password: "new-secret",
        note: "身份证 110101198805061234"
      }
    ])
    writeRendererLog("INFO", "用户手机 13700001234")
    await flushLogs()

    expect(terminalArgs).toEqual([
      {
        contactPhone: "139****9000",
        password: "[REDACTED]",
        note: "身份证 110101********1234"
      }
    ])
    expect(readFileSync(mainLog, "utf8")).not.toContain("13900139000")
    expect(readFileSync(mainLog, "utf8")).not.toContain("new-secret")
    expect(readFileSync(rendererLog, "utf8")).not.toContain("13700001234")
    expect(readFileSync(join(logsDir, ".redaction-v1"), "utf8")).toBe("version=1\n")

    if (process.platform !== "win32") {
      expect(statSync(mainLog).mode & 0o777).toBe(0o600)
      expect(statSync(logsDir).mode & 0o777).toBe(0o700)
      expect(statSync(hooksDir).mode & 0o777).toBe(0o700)
    }
  })
})
