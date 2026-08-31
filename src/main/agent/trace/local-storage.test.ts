import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getTraceLocalStorage,
  getTraceStorageCacheDiagnostics,
  resolveTraceStorageMode,
  TraceLocalStorage,
  type TraceKeyProtector
} from "./local-storage"

class TestKeyProtector implements TraceKeyProtector {
  constructor(
    private readonly available = true,
    private readonly backend = "kwallet6"
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plaintext: string): Buffer {
    return this.transform(Buffer.from(plaintext, "utf8"))
  }

  decryptString(encrypted: Buffer): string {
    return this.transform(encrypted).toString("utf8")
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  private transform(value: Buffer): Buffer {
    return Buffer.from(value.map((byte) => byte ^ 0xa5))
  }
}

const tempRoots: string[] = []
const MIGRATION_MARKER_FILE_NAME = ".trace-migration-v1.complete"
const MIGRATION_IN_PROGRESS_FILE_NAME = ".trace-migration-v1.in-progress"

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("encrypted local trace storage", () => {
  it("keeps sensitive trace content out of both JSONL and the wrapped key file", async () => {
    const root = makeRoot("trace-storage-encrypted-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const initialized = await storage.initialize()
    const traceFile = join(root, "thread-1", "trace-1.jsonl")
    const plaintext = JSON.stringify({
      traceId: "trace-1",
      userMessage: "password=InternalSecret123!"
    })

    expect(initialized.ready).toBe(true)
    expect(await storage.appendJsonLine(traceFile, plaintext)).toBe(true)

    const storedLine = readFileSync(traceFile, "utf8").trim()
    const wrappedKey = readFileSync(join(root, ".trace-key-v1.json"), "utf8")
    expect(storedLine).not.toContain("InternalSecret123")
    expect(wrappedKey).not.toContain("InternalSecret123")
    expect(JSON.parse(storedLine)).toMatchObject({
      format: "cmbcowork.trace",
      version: 1,
      algorithm: "aes-256-gcm"
    })
    expect(storage.decodeStoredLine(storedLine)).toBe(plaintext)

    // A fresh codec instance must be able to unwrap the persisted data key.
    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(restarted.decodeStoredLine(storedLine)).toBe(plaintext)
  })

  it("authenticates ciphertext and rejects modified trace envelopes", async () => {
    const root = makeRoot("trace-storage-tamper-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")
    await storage.appendJsonLine(traceFile, JSON.stringify({ secret: "do-not-leak" }))
    const envelope = JSON.parse(readFileSync(traceFile, "utf8")) as { ciphertext: string }
    const ciphertext = Buffer.from(envelope.ciphertext, "base64")
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1
    envelope.ciphertext = ciphertext.toString("base64")

    expect(() => storage.decodeStoredLine(JSON.stringify(envelope))).toThrow()
  })

  it("migrates every legacy plaintext line and tightens filesystem permissions", async () => {
    const root = makeRoot("trace-storage-migrate-")
    const threadDir = join(root, "thread-legacy")
    const traceFile = join(threadDir, "legacy.jsonl")
    mkdirSync(threadDir, { recursive: true })
    writeFileSync(
      traceFile,
      `${JSON.stringify({ traceId: "legacy-1", userMessage: "敏感账号 62220000" })}\n${JSON.stringify({ traceId: "legacy-2", result: "token=secret-token" })}\n`,
      "utf8"
    )
    const legacyMtime = new Date("2025-01-02T03:04:05.000Z")
    utimesSync(traceFile, legacyMtime, legacyMtime)
    if (process.platform !== "win32") {
      chmodSync(root, 0o755)
      chmodSync(threadDir, 0o755)
      chmodSync(traceFile, 0o644)
    }

    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const result = await storage.initialize()
    const migrated = readFileSync(traceFile, "utf8")
    const lines = migrated.trim().split("\n")

    expect(result).toMatchObject({ ready: true, migratedFiles: 1, failedFiles: 0 })
    expect(migrated).not.toContain("62220000")
    expect(migrated).not.toContain("secret-token")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(storage.decodeStoredLine(lines[0] ?? ""))).toMatchObject({
      traceId: "legacy-1"
    })
    expect(JSON.parse(storage.decodeStoredLine(lines[1] ?? ""))).toMatchObject({
      traceId: "legacy-2"
    })
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(threadDir).mode & 0o777).toBe(0o700)
      expect(statSync(traceFile).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, ".trace-key-v1.json")).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, MIGRATION_MARKER_FILE_NAME)).mode & 0o777).toBe(0o600)
    }
    expect(Math.abs(statSync(traceFile).mtime.getTime() - legacyMtime.getTime())).toBeLessThan(1000)
  })

  it("skips unchanged trace contents after a successful migration", async () => {
    const root = makeRoot("trace-storage-migration-marker-")
    const threadDir = join(root, "thread-legacy")
    const traceFile = join(threadDir, "legacy.jsonl")
    mkdirSync(threadDir, { recursive: true })
    writeFileSync(traceFile, '{"secret":"legacy-value"}\n', "utf8")

    const first = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await first.initialize()).toMatchObject({
      ready: true,
      migratedFiles: 1,
      migrationSkipped: false
    })
    const migratedContent = readFileSync(traceFile, "utf8")
    const markerPath = join(root, MIGRATION_MARKER_FILE_NAME)
    const markerContent = readFileSync(markerPath, "utf8")

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      ready: true,
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: true
    })
    expect(readFileSync(traceFile, "utf8")).toBe(migratedContent)
    expect(readFileSync(markerPath, "utf8")).toBe(markerContent)
  })

  it("rechecks only trace directories changed after the migration marker", async () => {
    const root = makeRoot("trace-storage-incremental-migration-")
    const changedDir = join(root, "thread-changed")
    const unchangedDir = join(root, "thread-unchanged")
    const changedExistingFile = join(changedDir, "existing.jsonl")
    const unchangedFile = join(unchangedDir, "existing.jsonl")
    mkdirSync(changedDir, { recursive: true })
    mkdirSync(unchangedDir, { recursive: true })
    writeFileSync(changedExistingFile, '{"secret":"changed-existing"}\n', "utf8")
    writeFileSync(unchangedFile, '{"secret":"unchanged-existing"}\n', "utf8")

    const first = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await first.initialize()).toMatchObject({ migratedFiles: 2, failedFiles: 0 })
    const unchangedEncryptedContent = readFileSync(unchangedFile, "utf8")

    const newLegacyFile = join(changedDir, "restored-legacy.jsonl")
    writeFileSync(newLegacyFile, '{"secret":"restored-after-migration"}\n', "utf8")
    const changedDirectoryTime = new Date(Date.now() + 5_000)
    utimesSync(changedDir, changedDirectoryTime, changedDirectoryTime)

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      ready: true,
      migratedFiles: 1,
      protectedFiles: 1,
      failedFiles: 0,
      migrationSkipped: false
    })
    expect(readFileSync(newLegacyFile, "utf8")).not.toContain("restored-after-migration")
    expect(readFileSync(unchangedFile, "utf8")).toBe(unchangedEncryptedContent)

    const verified = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await verified.initialize()).toMatchObject({ migrationSkipped: true, failedFiles: 0 })
  })

  it("fails closed when secure key protection is unavailable", async () => {
    const root = makeRoot("trace-storage-unavailable-")
    const legacyFile = join(root, "thread-legacy", "legacy.jsonl")
    mkdirSync(dirname(legacyFile), { recursive: true })
    writeFileSync(legacyFile, '{"secret":"retry-after-key-recovery"}\n', "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector(false)
    })
    const result = await storage.initialize()
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(result.ready).toBe(false)
    expect(result.reason).toContain("unavailable")
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(false)
    await expect(storage.appendJsonLine(traceFile, '{"secret":"value"}')).rejects.toThrow()
    expect(existsSync(traceFile)).toBe(false)
    expect(readFileSync(legacyFile, "utf8")).toContain("retry-after-key-recovery")

    const recovered = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await recovered.initialize()).toMatchObject({
      ready: true,
      migratedFiles: 1,
      failedFiles: 0
    })
    expect(readFileSync(legacyFile, "utf8")).not.toContain("retry-after-key-recovery")
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(true)
  })

  it("rejects Electron's Linux basic_text backend", async () => {
    const root = makeRoot("trace-storage-basic-text-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector(true, "basic_text"),
      platform: "linux"
    })

    expect(await storage.initialize()).toMatchObject({
      ready: false,
      reason: expect.stringContaining("basic_text")
    })
  })

  it("keeps concurrent appends encrypted and responsive during migration", async () => {
    const root = makeRoot("trace-storage-migration-append-race-")
    const traceFile = join(root, "thread-race", "trace-race.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    writeFileSync(traceFile, '{"secret":"legacy-secret"}\n'.repeat(2_000), "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    const initialization = storage.initialize()
    const appended = storage.appendJsonLine(traceFile, '{"marker":"new-encrypted-record"}')
    const [result, written] = await Promise.all([initialization, appended])
    clearInterval(ticker)

    const persisted = readFileSync(traceFile, "utf8")
    const decoded = persisted
      .trim()
      .split("\n")
      .map((line) => storage.decodeStoredLine(line))
    expect(result).toMatchObject({ ready: true, failedFiles: 0 })
    expect(written).toBe(true)
    expect(ticks).toBeGreaterThan(0)
    expect(persisted).not.toContain("legacy-secret")
    expect(persisted).not.toContain("new-encrypted-record")
    expect(decoded).toContain('{"marker":"new-encrypted-record"}')
  })

  it("restarts a migration left with a durable in-progress marker", async () => {
    const root = makeRoot("trace-storage-migration-resume-")
    const threadDir = join(root, "thread-resume")
    const traceFile = join(threadDir, "trace-resume.jsonl")
    mkdirSync(threadDir, { recursive: true })
    writeFileSync(traceFile, '{"secret":"first-pass"}\n', "utf8")
    const first = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await first.initialize()).toMatchObject({ migratedFiles: 1, failedFiles: 0 })

    writeFileSync(traceFile, '{"secret":"interrupted-plaintext"}\n', "utf8")
    const markerPath = join(root, MIGRATION_MARKER_FILE_NAME)
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      snapshot: { directories: Record<string, number> }
    }
    marker.snapshot.directories["thread-resume"] = statSync(threadDir).mtimeMs
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, "utf8")
    writeFileSync(
      join(root, MIGRATION_IN_PROGRESS_FILE_NAME),
      '{"version":1,"startedAt":"interrupted"}\n',
      "utf8"
    )

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({ migratedFiles: 1, failedFiles: 0 })
    expect(readFileSync(traceFile, "utf8")).not.toContain("interrupted-plaintext")
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(false)
  })

  it("drops an oversized append before encryption or filesystem work", async () => {
    const root = makeRoot("trace-storage-append-budget-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const traceFile = join(root, "thread", "oversized.jsonl")

    expect(await storage.appendJsonLine(traceFile, "x".repeat(1024 * 1024 + 1))).toBe(false)
    expect(existsSync(traceFile)).toBe(false)
  })

  it("replaces one oversized legacy line without processing it as a giant JSON payload", async () => {
    const root = makeRoot("trace-storage-oversized-legacy-")
    const traceFile = join(root, "thread", "oversized-legacy.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    writeFileSync(traceFile, `{"secret":"${"s".repeat(2 * 1024 * 1024)}"}\n`, "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })

    expect(await storage.initialize()).toMatchObject({ migratedFiles: 1, failedFiles: 0 })
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(storedLine).not.toContain("s".repeat(1024))
    expect(storage.decodeStoredLine(storedLine)).toContain("oversized legacy trace omitted")
  })
})

describe("trace storage modes", () => {
  it("uses encrypted as the default and for unknown values", () => {
    expect(resolveTraceStorageMode(undefined)).toBe("encrypted")
    expect(resolveTraceStorageMode("typo")).toBe("encrypted")
    expect(resolveTraceStorageMode("off")).toBe("off")
    expect(resolveTraceStorageMode("plaintext")).toBe("plaintext")
  })

  it("only writes plaintext when explicitly requested", async () => {
    const root = makeRoot("trace-storage-plaintext-")
    const storage = new TraceLocalStorage(root, { mode: "plaintext" })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(await storage.appendJsonLine(traceFile, '{"fixture":"plain"}')).toBe(true)
    expect(readFileSync(traceFile, "utf8")).toContain('"fixture":"plain"')
  })

  it("invalidates the migration marker before plaintext mode can add traces", async () => {
    const root = makeRoot("trace-storage-plaintext-invalidates-marker-")
    const markerPath = join(root, MIGRATION_MARKER_FILE_NAME)
    const encrypted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await encrypted.initialize()).toMatchObject({ ready: true, failedFiles: 0 })
    expect(existsSync(markerPath)).toBe(true)

    const plaintext = new TraceLocalStorage(root, { mode: "plaintext" })
    expect(await plaintext.initialize()).toMatchObject({ ready: true })
    expect(existsSync(markerPath)).toBe(false)
    const traceFile = join(root, "thread-legacy", "legacy.jsonl")
    expect(
      await plaintext.appendJsonLine(traceFile, '{"secret":"plaintext-after-marker"}')
    ).toBe(true)

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      ready: true,
      migratedFiles: 1,
      failedFiles: 0,
      migrationSkipped: false
    })
    expect(readFileSync(traceFile, "utf8")).not.toContain("plaintext-after-marker")
    expect(existsSync(markerPath)).toBe(true)
  })

  it("does not create a trace file when storage is off", async () => {
    const root = makeRoot("trace-storage-off-")
    const storage = new TraceLocalStorage(root, { mode: "off" })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(await storage.appendJsonLine(traceFile, '{"secret":"value"}')).toBe(false)
    expect(existsSync(traceFile)).toBe(false)
  })

  it("protects legacy files while preventing new writes in off mode", async () => {
    const root = makeRoot("trace-storage-off-migration-")
    const traceFile = join(root, "thread-legacy", "legacy.jsonl")
    mkdirSync(join(root, "thread-legacy"), { recursive: true })
    writeFileSync(traceFile, '{"secret":"legacy-sensitive-value"}\n', "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "off",
      protector: new TestKeyProtector()
    })

    expect(await storage.initialize()).toMatchObject({ ready: true, migratedFiles: 1 })
    expect(readFileSync(traceFile, "utf8")).not.toContain("legacy-sensitive-value")
    expect(
      await storage.appendJsonLine(join(root, "thread-new", "new.jsonl"), '{"secret":"new"}')
    ).toBe(false)
  })

  it("keeps the per-root storage cache within its LRU cap", () => {
    for (let index = 0; index < 100; index += 1) {
      getTraceLocalStorage(`cache-root-${index}`)
    }
    const diagnostics = getTraceStorageCacheDiagnostics()
    expect(diagnostics.size).toBeLessThanOrEqual(diagnostics.maxEntries)
    expect(diagnostics.maxEntries).toBe(32)
  })
})
