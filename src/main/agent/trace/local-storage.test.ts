import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync
} from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getTraceLocalStorage,
  getTraceStorageCacheDiagnostics,
  resolveTraceStorageMode,
  TRACE_INVENTORY_MAX_DIRECTORIES,
  TRACE_INVENTORY_MAX_ENTRIES,
  TRACE_INVENTORY_MAX_FILES,
  TraceLocalStorage,
  type TraceKeyProtector,
  type TraceStorageInitializationResult
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

function readFilePrefix(filePath: string, length: number): string {
  const descriptor = openSync(filePath, "r")
  const prefix = Buffer.alloc(length)
  try {
    const bytesRead = readSync(descriptor, prefix, 0, length, 0)
    return prefix.subarray(0, bytesRead).toString("utf8")
  } finally {
    closeSync(descriptor)
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("encrypted local trace storage", () => {
  it("keeps bounded inventory capacity above observed long-lived stores", () => {
    expect(TRACE_INVENTORY_MAX_DIRECTORIES).toBeGreaterThanOrEqual(8_192)
    expect(TRACE_INVENTORY_MAX_FILES).toBeGreaterThanOrEqual(16_384)
    expect(TRACE_INVENTORY_MAX_ENTRIES).toBeGreaterThanOrEqual(
      TRACE_INVENTORY_MAX_DIRECTORIES + TRACE_INVENTORY_MAX_FILES
    )
  })

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

  it("resumes a byte-budgeted migration without rereading verified files", async () => {
    const root = makeRoot("trace-storage-budget-resume-")
    const legacyFiles = Array.from({ length: 3 }, (_, index) => {
      const traceFile = join(root, `thread-${index}`, `trace-${index}.jsonl`)
      mkdirSync(dirname(traceFile), { recursive: true })
      writeFileSync(
        traceFile,
        `${JSON.stringify({ secret: `legacy-${index}-${"x".repeat(80)}` })}\n`
      )
      return traceFile
    })

    const migrationResults: TraceStorageInitializationResult[] = []
    for (let launch = 0; launch < legacyFiles.length; launch += 1) {
      const storage = new TraceLocalStorage(root, {
        mode: "encrypted",
        protector: new TestKeyProtector(),
        migrationMaxTotalBytes: 64
      })
      migrationResults.push(await storage.initialize())
    }

    expect(migrationResults.map((result) => result.migratedFiles)).toEqual([1, 1, 1])
    expect(migrationResults.every((result) => result.failedFiles === 0)).toBe(true)
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(false)
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(true)
    for (const traceFile of legacyFiles) {
      expect(readFileSync(traceFile, "utf8")).not.toContain("legacy-")
    }

    const verified = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector(),
      migrationMaxTotalBytes: 64
    })
    expect(await verified.initialize()).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: true
    })
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

  it("streams legacy files above the in-memory migration limit", async () => {
    const root = makeRoot("trace-storage-large-legacy-file-")
    const traceFile = join(root, "thread", "large-legacy.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    writeFileSync(traceFile, `{"secret":"${"s".repeat(8 * 1024 * 1024)}"}\n`, "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })

    expect(await storage.initialize()).toMatchObject({ migratedFiles: 1, failedFiles: 0 })
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(storedLine).not.toContain("s".repeat(1024))
    expect(storage.decodeStoredLine(storedLine)).toContain("oversized legacy trace omitted")
  })

  it("preserves large encrypted envelopes during a later streaming verification", async () => {
    const root = makeRoot("trace-storage-large-envelope-recheck-")
    const traceFile = join(root, "thread", "large-envelopes.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    const legacyLine = JSON.stringify({ payload: "v".repeat(1400 * 1024) })
    writeFileSync(traceFile, `${legacyLine}\n`.repeat(6), "utf8")
    const first = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await first.initialize()).toMatchObject({ migratedFiles: 1, failedFiles: 0 })
    const encryptedContent = readFileSync(traceFile, "utf8")
    expect(encryptedContent).not.toContain("v".repeat(1024))
    rmSync(join(root, MIGRATION_MARKER_FILE_NAME))

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 1,
      failedFiles: 0
    })
    expect(readFileSync(traceFile, "utf8")).toBe(encryptedContent)
  })

  it("defers a valid encrypted file above the single-launch budget without changing it", async () => {
    const root = makeRoot("trace-storage-valid-oversized-encrypted-")
    const traceFile = join(root, "valid-encrypted.jsonl")
    const writer = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    await writer.initialize()
    await writer.appendJsonLine(traceFile, JSON.stringify({ payload: "v".repeat(900 * 1024) }))
    const encryptedLine = readFileSync(traceFile)
    for (let index = 1; index < 56; index += 1) appendFileSync(traceFile, encryptedLine)
    const originalStat = statSync(traceFile)
    expect(originalStat.size).toBeGreaterThan(64 * 1024 * 1024)

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const deferred = await restarted.initialize()
    expect(deferred).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    expect(deferred.reason).toContain("deferred 1 file")
    expect(statSync(traceFile).size).toBe(originalStat.size)
    const descriptor = openSync(traceFile, "r")
    const retainedPrefix = Buffer.alloc(encryptedLine.length)
    try {
      expect(readSync(descriptor, retainedPrefix, 0, retainedPrefix.length, 0)).toBe(
        encryptedLine.length
      )
    } finally {
      closeSync(descriptor)
    }
    expect(retainedPrefix).toEqual(encryptedLine)
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(true)

    const changedDescriptor = openSync(traceFile, "r+")
    try {
      const plaintextPrefix = Buffer.from('{"secret":"changed-before-probe-offset"}\n', "utf8")
      expect(writeSync(changedDescriptor, plaintextPrefix, 0, plaintextPrefix.length, 0)).toBe(
        plaintextPrefix.length
      )
    } finally {
      closeSync(changedDescriptor)
    }
    const changedRestart = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await changedRestart.initialize()).toMatchObject({
      migratedFiles: 1,
      protectedFiles: 0,
      failedFiles: 0
    })
    const replacement = readFileSync(traceFile, "utf8").trim()
    expect(replacement).not.toContain("changed-before-probe-offset")
    expect(JSON.parse(changedRestart.decodeStoredLine(replacement))).toMatchObject({
      traceStorageNotice: "oversized legacy trace file omitted during migration",
      originalBytes: originalStat.size
    })
  }, 20_000)

  it("resumes oversized probes until plaintext after an encrypted prefix is secured", async () => {
    const root = makeRoot("trace-storage-oversized-mixed-tail-")
    const traceFile = join(root, "mixed-tail.jsonl")
    const writer = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    await writer.initialize()
    await writer.appendJsonLine(traceFile, JSON.stringify({ payload: "v".repeat(900 * 1024) }))
    const encryptedLine = readFileSync(traceFile)
    for (let index = 1; index < 8; index += 1) appendFileSync(traceFile, encryptedLine)
    const plaintextOffset = statSync(traceFile).size
    appendFileSync(traceFile, '{"secret":"plaintext-after-encrypted-prefix"}\n', "utf8")
    expect(plaintextOffset).toBeGreaterThan(8 * 1024 * 1024)
    const originalBytes = 64 * 1024 * 1024 + 1
    truncateSync(traceFile, originalBytes)

    const firstRestart = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await firstRestart.initialize()).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    const progress = JSON.parse(
      readFileSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME), "utf8")
    ) as {
      oversizedProbeOffsets?: Record<string, { offset?: unknown; size?: unknown }>
    }
    expect(progress.oversizedProbeOffsets?.["mixed-tail.jsonl"]).toMatchObject({
      size: originalBytes
    })
    expect(progress.oversizedProbeOffsets?.["mixed-tail.jsonl"]?.offset).toEqual(expect.any(Number))

    const secondRestart = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await secondRestart.initialize()).toMatchObject({
      migratedFiles: 1,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(storedLine).not.toContain("plaintext-after-encrypted-prefix")
    expect(JSON.parse(secondRestart.decodeStoredLine(storedLine))).toMatchObject({
      traceStorageNotice: "oversized legacy trace file omitted during migration",
      originalBytes
    })
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(false)
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(true)
  }, 30_000)

  it("secures a clearly plaintext oversized file without starving later small files", async () => {
    const root = makeRoot("trace-storage-hard-file-budget-")
    const traceFile = join(root, "thread", "unexpectedly-huge.jsonl")
    const smallTraceFile = join(root, "small-legacy.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    writeFileSync(traceFile, '{"secret":"legacy-prefix"}\n', "utf8")
    writeFileSync(smallTraceFile, '{"secret":"small-legacy"}\n', "utf8")
    const originalBytes = 64 * 1024 * 1024 + 1
    truncateSync(traceFile, originalBytes)
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })

    const initialized = await storage.initialize()
    expect(initialized).toMatchObject({
      migratedFiles: 2,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    const smallStoredLine = readFileSync(smallTraceFile, "utf8").trim()
    expect(storage.decodeStoredLine(smallStoredLine)).toBe('{"secret":"small-legacy"}')
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(statSync(traceFile).size).toBeLessThan(1024)
    expect(storedLine).not.toContain("legacy-prefix")
    expect(JSON.parse(storage.decodeStoredLine(storedLine))).toMatchObject({
      traceStorageNotice: "oversized legacy trace file omitted during migration",
      originalBytes,
      migrationLimitBytes: 64 * 1024 * 1024
    })
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(false)
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(true)
  }, 20_000)

  it("secures an oversized file whose first encrypted envelope is corrupt", async () => {
    const root = makeRoot("trace-storage-corrupt-oversized-envelope-")
    const traceFile = join(root, "corrupt-envelope.jsonl")
    const writer = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    await writer.initialize()
    await writer.appendJsonLine(traceFile, '{"secret":"damaged-envelope"}')
    const envelope = JSON.parse(readFileSync(traceFile, "utf8")) as Record<string, unknown>
    envelope.authTag = Buffer.alloc(16).toString("base64")
    writeFileSync(traceFile, `${JSON.stringify(envelope)}\n`, "utf8")
    const originalBytes = 64 * 1024 * 1024 + 1
    truncateSync(traceFile, originalBytes)

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      migratedFiles: 1,
      protectedFiles: 0,
      failedFiles: 0
    })
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(JSON.parse(restarted.decodeStoredLine(storedLine))).toMatchObject({
      traceStorageNotice: "oversized legacy trace file omitted during migration",
      originalBytes
    })
  })

  it("secures a valid oversized legacy record once and skips it on the next launch", async () => {
    const root = makeRoot("trace-storage-unterminated-oversized-")
    const traceFile = join(root, "thread", "large-valid-legacy.jsonl")
    mkdirSync(dirname(traceFile), { recursive: true })
    writeFileSync(traceFile, '{"secret":"', "utf8")
    const payloadChunk = "S".repeat(1024 * 1024)
    for (let index = 0; index < 65; index += 1) appendFileSync(traceFile, payloadChunk)
    appendFileSync(traceFile, '"}\n', "utf8")
    const originalBytes = statSync(traceFile).size
    expect(originalBytes).toBeGreaterThan(64 * 1024 * 1024)

    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const initialized = await storage.initialize()
    expect(initialized).toMatchObject({
      migratedFiles: 1,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    const storedLine = readFileSync(traceFile, "utf8").trim()
    expect(statSync(traceFile).size).toBeLessThan(1024)
    expect(JSON.parse(storedLine)).toMatchObject({
      format: "cmbcowork.trace",
      version: 1,
      algorithm: "aes-256-gcm"
    })
    expect(JSON.parse(storage.decodeStoredLine(storedLine))).toMatchObject({
      traceStorageNotice: "oversized legacy trace file omitted during migration",
      originalBytes
    })
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(false)
    expect(existsSync(join(root, MIGRATION_MARKER_FILE_NAME))).toBe(true)

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: true
    })
  }, 30_000)

  it("preserves bounded prefixes that could still be reordered or truncated envelopes", async () => {
    const root = makeRoot("trace-storage-possible-envelope-prefix-")
    const reorderedFile = join(root, "reordered-envelope.jsonl")
    const truncatedKeyFile = join(root, "truncated-envelope-key.jsonl")
    const originalBytes = 64 * 1024 * 1024 + 1
    writeFileSync(reorderedFile, '{"ciphertext":"possibly-reordered', "utf8")
    const probeBytes = 8 * 1024 * 1024 + 2
    writeFileSync(truncatedKeyFile, `{${" ".repeat(probeBytes - 5)}"for`, "utf8")
    truncateSync(reorderedFile, originalBytes)
    truncateSync(truncatedKeyFile, originalBytes)

    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const deferred = await storage.initialize()
    expect(deferred).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: false
    })
    expect(deferred.reason).toContain("deferred 2 file")
    expect(statSync(reorderedFile).size).toBe(originalBytes)
    expect(statSync(truncatedKeyFile).size).toBe(originalBytes)
    expect(readFilePrefix(reorderedFile, 32)).toContain("ciphertext")
    expect(readFilePrefix(truncatedKeyFile, probeBytes).endsWith('"for')).toBe(true)
    expect(existsSync(join(root, MIGRATION_IN_PROGRESS_FILE_NAME))).toBe(true)
  }, 20_000)

  it("migrates stores beyond the former 2048-directory scan limit and then skips content work", async () => {
    const root = makeRoot("trace-storage-many-directories-")
    const directoryCount = 2_049
    for (let index = 0; index < directoryCount; index += 1) {
      mkdirSync(join(root, `thread-${index}`), { recursive: true })
    }
    const traceFile = join(root, `thread-${directoryCount - 1}`, "legacy.jsonl")
    writeFileSync(traceFile, '{"secret":"beyond-old-directory-limit"}\n', "utf8")

    const first = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await first.initialize()).toMatchObject({
      migratedFiles: 1,
      failedFiles: 0,
      migrationSkipped: false
    })
    expect(readFileSync(traceFile, "utf8")).not.toContain("beyond-old-directory-limit")

    const restarted = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    expect(await restarted.initialize()).toMatchObject({
      migratedFiles: 0,
      protectedFiles: 0,
      failedFiles: 0,
      migrationSkipped: true
    })
  }, 30_000)
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
    expect(await plaintext.appendJsonLine(traceFile, '{"secret":"plaintext-after-marker"}')).toBe(
      true
    )

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
