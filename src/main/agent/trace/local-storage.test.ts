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
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveTraceStorageMode, TraceLocalStorage, type TraceKeyProtector } from "./local-storage"

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
  it("keeps sensitive trace content out of both JSONL and the wrapped key file", () => {
    const root = makeRoot("trace-storage-encrypted-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const initialized = storage.initialize()
    const traceFile = join(root, "thread-1", "trace-1.jsonl")
    const plaintext = JSON.stringify({
      traceId: "trace-1",
      userMessage: "password=InternalSecret123!"
    })

    expect(initialized.ready).toBe(true)
    expect(storage.appendJsonLine(traceFile, plaintext)).toBe(true)

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

  it("authenticates ciphertext and rejects modified trace envelopes", () => {
    const root = makeRoot("trace-storage-tamper-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector()
    })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")
    storage.appendJsonLine(traceFile, JSON.stringify({ secret: "do-not-leak" }))
    const envelope = JSON.parse(readFileSync(traceFile, "utf8")) as { ciphertext: string }
    const ciphertext = Buffer.from(envelope.ciphertext, "base64")
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1
    envelope.ciphertext = ciphertext.toString("base64")

    expect(() => storage.decodeStoredLine(JSON.stringify(envelope))).toThrow()
  })

  it("migrates every legacy plaintext line and tightens filesystem permissions", () => {
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
    const result = storage.initialize()
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
    }
    expect(Math.abs(statSync(traceFile).mtime.getTime() - legacyMtime.getTime())).toBeLessThan(1000)
  })

  it("fails closed when secure key protection is unavailable", () => {
    const root = makeRoot("trace-storage-unavailable-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector(false)
    })
    const result = storage.initialize()
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(result.ready).toBe(false)
    expect(result.reason).toContain("unavailable")
    expect(() => storage.appendJsonLine(traceFile, '{"secret":"value"}')).toThrow()
    expect(existsSync(traceFile)).toBe(false)
  })

  it("rejects Electron's Linux basic_text backend", () => {
    const root = makeRoot("trace-storage-basic-text-")
    const storage = new TraceLocalStorage(root, {
      mode: "encrypted",
      protector: new TestKeyProtector(true, "basic_text"),
      platform: "linux"
    })

    expect(storage.initialize()).toMatchObject({
      ready: false,
      reason: expect.stringContaining("basic_text")
    })
  })
})

describe("trace storage modes", () => {
  it("uses encrypted as the default and for unknown values", () => {
    expect(resolveTraceStorageMode(undefined)).toBe("encrypted")
    expect(resolveTraceStorageMode("typo")).toBe("encrypted")
    expect(resolveTraceStorageMode("off")).toBe("off")
    expect(resolveTraceStorageMode("plaintext")).toBe("plaintext")
  })

  it("only writes plaintext when explicitly requested", () => {
    const root = makeRoot("trace-storage-plaintext-")
    const storage = new TraceLocalStorage(root, { mode: "plaintext" })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(storage.appendJsonLine(traceFile, '{"fixture":"plain"}')).toBe(true)
    expect(readFileSync(traceFile, "utf8")).toContain('"fixture":"plain"')
  })

  it("does not create a trace file when storage is off", () => {
    const root = makeRoot("trace-storage-off-")
    const storage = new TraceLocalStorage(root, { mode: "off" })
    const traceFile = join(root, "thread-1", "trace-1.jsonl")

    expect(storage.appendJsonLine(traceFile, '{"secret":"value"}')).toBe(false)
    expect(existsSync(traceFile)).toBe(false)
  })

  it("protects legacy files while preventing new writes in off mode", () => {
    const root = makeRoot("trace-storage-off-migration-")
    const traceFile = join(root, "thread-legacy", "legacy.jsonl")
    mkdirSync(join(root, "thread-legacy"), { recursive: true })
    writeFileSync(traceFile, '{"secret":"legacy-sensitive-value"}\n', "utf8")
    const storage = new TraceLocalStorage(root, {
      mode: "off",
      protector: new TestKeyProtector()
    })

    expect(storage.initialize()).toMatchObject({ ready: true, migratedFiles: 1 })
    expect(readFileSync(traceFile, "utf8")).not.toContain("legacy-sensitive-value")
    expect(storage.appendJsonLine(join(root, "thread-new", "new.jsonl"), '{"secret":"new"}')).toBe(
      false
    )
  })
})
