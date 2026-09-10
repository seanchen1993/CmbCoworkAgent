import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs"
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
  it("keeps undefined console arguments from crashing the caller", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-undefined-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, writeMainLog } = await import("./logging")

    expect(() =>
      writeMainLog("INFO", ["[Runtime] Agent created with skills parameter:", undefined])
    ).not.toThrow()
    await flushLogs()

    expect(readFileSync(mainLog, "utf8")).toContain(
      "[Runtime] Agent created with skills parameter: undefined"
    )
  })

  it("redacts a private key whose end marker is beyond the log projection boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-private-key-boundary-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, writeMainLog } = await import("./logging")
    const { createSafeLogMethod, createSafeLogProcessingGuard } =
      await import("./main-log-forwarding")
    const privateMaterial = "boundary-private-key-material-must-not-leak"
    const privateKey = [
      "command output:",
      "-----BEGIN RSA PRIVATE KEY-----",
      `${privateMaterial}${"A".repeat(4_096)}`,
      "-----END RSA PRIVATE KEY-----"
    ].join("\n")
    let returnedArgs: unknown[] = []
    const rawSink = vi.fn()
    const log = createSafeLogMethod({
      level: "ERROR",
      persist: (level, args) => {
        returnedArgs = writeMainLog(level, args)
        return returnedArgs
      },
      processingGuard: createSafeLogProcessingGuard(),
      sink: rawSink
    })

    log(privateKey)
    await flushLogs()

    expect(JSON.stringify(returnedArgs)).not.toContain(privateMaterial)
    expect(JSON.stringify(rawSink.mock.calls)).not.toContain(privateMaterial)
    expect(readFileSync(mainLog, "utf8")).not.toContain(privateMaterial)
    expect(JSON.stringify(returnedArgs)).not.toContain("A".repeat(64))
    expect(JSON.stringify(rawSink.mock.calls)).not.toContain("A".repeat(64))
    expect(readFileSync(mainLog, "utf8")).not.toContain("A".repeat(64))
    expect(JSON.stringify(returnedArgs)).toContain("[REDACTED]")
    expect(JSON.stringify(rawSink.mock.calls)).toContain("[REDACTED]")
    expect(readFileSync(mainLog, "utf8")).toContain("[REDACTED]")
  })

  it("migrates multi-line private keys as one stateful block, including oversized body lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-private-key-migration-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    const privateMaterial = "PRIVATE-BASE64-MATERIAL-MUST-NOT-LEAK"
    writeFileSync(
      mainLog,
      [
        "diagnostic-before-key",
        "-----BEGIN RSA PRIVATE KEY-----",
        privateMaterial,
        "X".repeat(70 * 1024),
        "-----END RSA PRIVATE KEY-----",
        "diagnostic-after-key",
        "request=https://legacy-user:legacy-password-prefix",
        "...[truncated 100 chars]"
      ].join("\n"),
      "utf8"
    )

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { initializeLogRedaction } = await import("./logging")
    const result = await initializeLogRedaction()
    const migrated = readFileSync(mainLog, "utf8")

    expect(result).toMatchObject({ failedFiles: 0, redactedFiles: 1 })
    expect(migrated).toContain("diagnostic-before-key")
    expect(migrated).toContain("diagnostic-after-key")
    expect(migrated).toContain("[REDACTED]")
    expect(migrated).not.toContain(privateMaterial)
    expect(migrated).not.toContain("X".repeat(64))
    expect(migrated).not.toContain("legacy-password-prefix")
    expect(migrated).toContain("https://[REDACTED]")
    expect(readFileSync(join(logsDir, ".redaction-v1"), "utf8")).toBe("version=1\n")

    unlinkSync(join(logsDir, ".redaction-v1"))
    await initializeLogRedaction()
    expect(readFileSync(mainLog, "utf8")).toBe(migrated)
  })

  it("does not grow an already migrated PEM block when another file keeps migration pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-private-key-retry-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      mainLog,
      "before\n-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----\nafter\n",
      "utf8"
    )
    writeFileSync(rendererLog, "X".repeat(8 * 1024 * 1024 + 1), "utf8")

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { initializeLogRedaction } = await import("./logging")
    expect((await initializeLogRedaction()).failedFiles).toBe(1)
    const first = readFileSync(mainLog, "utf8")
    expect((await initializeLogRedaction()).failedFiles).toBe(1)
    expect(readFileSync(mainLog, "utf8")).toBe(first)
    expect(first).toContain("-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----")
  })

  it("checks completion before hook discovery", async () => {
    const completeRoot = mkdtempSync(join(tmpdir(), "logging-complete-precheck-"))
    tempRoots.push(completeRoot)
    const completeLogsDir = join(completeRoot, "logs")
    const completeMainLog = join(completeLogsDir, "main.log")
    mkdirSync(completeLogsDir, { recursive: true })
    writeFileSync(join(completeLogsDir, ".redaction-v1"), "version=1\n", "utf8")
    writeFileSync(completeMainLog, "not-a-directory", "utf8")

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => completeLogsDir,
      getMainLogPath: () => completeMainLog,
      getRendererLogPath: () => join(completeLogsDir, "renderer.log"),
      resolveHookLogDir: () => completeMainLog
    }))

    const completeLogging = await import("./logging")
    await expect(completeLogging.initializeLogRedaction()).resolves.toEqual({
      alreadyComplete: true,
      scannedFiles: 0,
      redactedFiles: 0,
      failedFiles: 0
    })
  })

  it("redacts renderer URL credentials before truncating at the line boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-renderer-boundary-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, writeRendererLog } = await import("./logging")
    const password = "renderer-password-fragment".repeat(1_000)
    writeRendererLog("ERROR", `request=https://build-user:${password}@host/path`, {
      sourceId: `https://source-user:${password}@source-host/bundle.js`,
      line: 42
    })
    await flushLogs()
    const persisted = readFileSync(rendererLog, "utf8")

    expect(persisted).toContain("https://[REDACTED]")
    expect(persisted).not.toContain("renderer-password-fragment")
  })

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
    const initialized = await initializeLogRedaction()

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

  it("bounds a 100k-entry console object and the stalled-disk buffer", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-bounds-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, getLogQueueDiagnosticsForTest, writeMainLog } = await import("./logging")
    const hugeObject: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) {
      hugeObject[`entry-${index}`] = index === 99_999 ? "password=tail-secret" : index
    }

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    const startedAt = Date.now()
    const projected = writeMainLog("INFO", [hugeObject, "x".repeat(2 * 1024 * 1024)])
    const projectionMs = Date.now() - startedAt
    for (let index = 0; index < 50; index += 1) {
      writeMainLog("INFO", ["y".repeat(128 * 1024)])
      if (index % 10 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const diagnostics = getLogQueueDiagnosticsForTest()
    await flushLogs()
    clearInterval(ticker)

    expect(projectionMs).toBeLessThan(250)
    expect(ticks).toBeGreaterThan(0)
    expect(Object.keys(projected[0] as object).length).toBeLessThanOrEqual(65)
    expect(JSON.stringify(projected).length).toBeLessThan(128 * 1024)
    expect(diagnostics.bufferedBytes).toBeLessThanOrEqual(diagnostics.maxBufferedBytesPerFile)
    expect(diagnostics.bufferedLines).toBeLessThanOrEqual(diagnostics.maxBufferedLinesPerFile)
    expect(statSync(mainLog).size).toBeLessThan(6 * 1024 * 1024)
  })

  it("shares one projection budget across a branching object graph and all arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-shared-budget-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { writeMainLog } = await import("./logging")
    const buildBranchingValue = (depth: number): unknown =>
      depth === 0
        ? { password: "deep-secret" }
        : Array.from({ length: 8 }, () => buildBranchingValue(depth - 1))
    const branching = buildBranchingValue(5)
    const startedAt = performance.now()
    const projected = writeMainLog("INFO", [
      branching,
      ...Array.from({ length: 16 }, () => "z".repeat(64 * 1024))
    ])
    const elapsedMs = performance.now() - startedAt
    const serialized = JSON.stringify(projected)

    expect(elapsedMs).toBeLessThan(500)
    expect(serialized.length).toBeLessThan(512 * 1024)
    expect(serialized).not.toContain("deep-secret")
    expect(serialized).toMatch(/node-limit|text-budget|Truncated/)
  })

  it("serializes a concurrent append behind historical migration without plaintext loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "logging-migration-race-"))
    tempRoots.push(root)
    const logsDir = join(root, "logs")
    const hooksDir = join(root, "hooks", "log")
    const mainLog = join(logsDir, "main.log")
    const rendererLog = join(logsDir, "renderer.log")
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(mainLog, "password=historical-secret\n".repeat(2_000), "utf8")

    vi.doMock("electron", () => ({ app: { isPackaged: false } }))
    vi.doMock("./storage", () => ({
      getLogsDir: () => logsDir,
      getMainLogPath: () => mainLog,
      getRendererLogPath: () => rendererLog,
      resolveHookLogDir: () => hooksDir
    }))

    const { flushLogs, initializeLogRedaction, writeMainLog } = await import("./logging")
    const migration = initializeLogRedaction()
    writeMainLog("INFO", ["concurrent-marker", { password: "append-secret" }])
    const result = await migration
    await flushLogs()
    const persisted = readFileSync(mainLog, "utf8")

    expect(result).toMatchObject({ failedFiles: 0, redactedFiles: 1 })
    expect(persisted).toContain("concurrent-marker")
    expect(persisted).not.toContain("historical-secret")
    expect(persisted).not.toContain("append-secret")
  })
})
