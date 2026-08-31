import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const writeState = vi.hoisted(() => ({
  appendFile: vi.fn(),
  attemptsByPath: new Map<string, number>(),
  failuresBeforeSuccessByPath: new Map<string, number>(),
  pathAttemptsByDate: new Map<string, number>(),
  pathFailuresBeforeSuccessByDate: new Map<string, number>()
}))

vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  appendFile: writeState.appendFile
}))

vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ enabled: true, diagnostic: true }),
  getHookLogFilePath: (date: Date) => {
    const dateKey = date.toISOString().slice(0, 10)
    const attempts = (writeState.pathAttemptsByDate.get(dateKey) ?? 0) + 1
    writeState.pathAttemptsByDate.set(dateKey, attempts)
    const failuresBeforeSuccess = writeState.pathFailuresBeforeSuccessByDate.get(dateKey) ?? 0
    if (attempts <= failuresBeforeSuccess) throw new Error(`${dateKey} path unavailable`)
    return dateKey
  },
  resolveHookLogDir: () => "unused"
}))

let persistence: typeof import("./persistence")
let warnSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  vi.useFakeTimers()
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  writeState.appendFile.mockImplementation(async (path: string) => {
    const attempts = (writeState.attemptsByPath.get(path) ?? 0) + 1
    writeState.attemptsByPath.set(path, attempts)
    const failuresBeforeSuccess = writeState.failuresBeforeSuccessByPath.get(path) ?? 0
    if (attempts <= failuresBeforeSuccess) throw new Error(`${path} unavailable`)
  })
  persistence = await import("./persistence")
})

beforeEach(() => {
  writeState.appendFile.mockClear()
  writeState.attemptsByPath.clear()
  writeState.failuresBeforeSuccessByPath.clear()
  writeState.pathAttemptsByDate.clear()
  writeState.pathFailuresBeforeSuccessByDate.clear()
})

afterAll(async () => {
  await persistence.flushHookLogs()
  warnSpy.mockRestore()
  vi.useRealTimers()
})

describe("Hook log retry isolation", () => {
  it("keeps the normal same-date path as one buffered append", async () => {
    persistence.persistHookExecutionRecord({
      id: "normal-first",
      timestamp: "2026-08-24T12:00:00.000Z"
    })
    persistence.persistHookExecutionRecord({
      id: "normal-second",
      timestamp: "2026-08-24T13:00:00.000Z"
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.attemptsByPath.get("2026-08-24")).toBe(1)
    const write = writeState.appendFile.mock.calls[0]
    expect(String(write?.[1])).toContain('"id":"normal-first"')
    expect(String(write?.[1])).toContain('"id":"normal-second"')
  })

  it("does not transfer one Beijing date's exhausted retry count to another date", async () => {
    writeState.failuresBeforeSuccessByPath.set("2026-08-25", 3)
    writeState.failuresBeforeSuccessByPath.set("2026-08-26", 1)
    persistence.persistHookExecutionRecord({
      id: "first-date",
      timestamp: "2026-08-25T12:00:00.000Z"
    })

    // Leave the first date queued after its initial write plus two retries.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(writeState.attemptsByPath.get("2026-08-25")).toBe(3)

    persistence.persistHookExecutionRecord({
      id: "second-date",
      timestamp: "2026-08-26T12:00:00.000Z"
    })

    // The first date now succeeds while the second date fails for the first time.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.attemptsByPath.get("2026-08-25")).toBe(4)
    expect(writeState.attemptsByPath.get("2026-08-26")).toBe(1)

    // The second date must retain its own retry budget and be attempted again.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.attemptsByPath.get("2026-08-26")).toBe(2)
  })

  it("gives new same-date records a fresh retry budget behind an exhausted batch", async () => {
    writeState.failuresBeforeSuccessByPath.set("2026-08-27", 4)
    persistence.persistHookExecutionRecord({
      id: "exhausted-batch",
      timestamp: "2026-08-27T12:00:00.000Z"
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(writeState.attemptsByPath.get("2026-08-27")).toBe(3)

    persistence.persistHookExecutionRecord({
      id: "fresh-batch",
      timestamp: "2026-08-27T13:00:00.000Z"
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.attemptsByPath.get("2026-08-27")).toBe(4)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.attemptsByPath.get("2026-08-27")).toBe(5)
    const finalWrite = writeState.appendFile.mock.calls.at(-1)
    expect(String(finalWrite?.[1])).toContain('"id":"fresh-batch"')
    expect(String(finalWrite?.[1])).not.toContain('"id":"exhausted-batch"')

    await expect(persistence.flushHookLogs()).rejects.toThrow("2026-08-27 unavailable")
  })

  it("requeues a batch when resolving its log path throws synchronously", async () => {
    writeState.pathFailuresBeforeSuccessByDate.set("2026-08-28", 1)
    persistence.persistHookExecutionRecord({
      id: "path-retry",
      timestamp: "2026-08-28T12:00:00.000Z"
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.pathAttemptsByDate.get("2026-08-28")).toBe(1)
    expect(writeState.attemptsByPath.get("2026-08-28")).toBeUndefined()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(writeState.pathAttemptsByDate.get("2026-08-28")).toBe(2)
    expect(writeState.attemptsByPath.get("2026-08-28")).toBe(1)
  })
})
