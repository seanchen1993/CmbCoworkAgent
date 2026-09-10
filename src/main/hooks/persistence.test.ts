import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let tempHome: string
let storage: typeof import("../storage")
let persistence: typeof import("./persistence")
const originalAgentHome = process.env.CMB_COWORK_AGENT_HOME
const originalTimeZone = process.env.TZ

beforeAll(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hook-beijing-time-"))
  process.env.CMB_COWORK_AGENT_HOME = tempHome
  process.env.TZ = "America/New_York"
  vi.resetModules()
  storage = await import("../storage")
  persistence = await import("./persistence")
  storage.saveHookLoggingConfig({ enabled: true, diagnostic: true })
})

afterAll(async () => {
  try {
    await persistence.flushHookLogs()
  } finally {
    if (originalAgentHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = originalAgentHome
    if (originalTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimeZone
    vi.resetModules()
    await rm(tempHome, { recursive: true, force: true })
  }
})

describe("Hook log Beijing-date persistence", () => {
  it("writes one buffered flush across Beijing midnight into separate daily files", async () => {
    persistence.persistHookExecutionRecord({
      id: "before-midnight",
      timestamp: "2026-08-25T15:59:59.999Z"
    })
    persistence.persistHookExecutionRecord({
      id: "after-midnight",
      timestamp: "2026-08-25T16:00:00.000Z"
    })

    await persistence.flushHookLogs()

    const logDir = join(tempHome, "hooks", "log")
    const before = await readFile(join(logDir, "hooks.2026-08-25.jsonl"), "utf-8")
    const after = await readFile(join(logDir, "hooks.2026-08-26.jsonl"), "utf-8")

    expect(before).toContain('"id":"before-midnight"')
    expect(before).not.toContain('"id":"after-midnight"')
    expect(after).toContain('"id":"after-midnight"')
    expect(after).not.toContain('"id":"before-midnight"')
    expect(before).toContain('"timestamp":"2026-08-25T15:59:59.999Z"')
    expect(after).toContain('"timestamp":"2026-08-25T16:00:00.000Z"')
  })

  it("resolves explicit log paths by Beijing date instead of the host timezone", () => {
    expect(storage.getHookLogFilePath(new Date("2026-08-25T16:00:00.000Z"))).toBe(
      join(tempHome, "hooks", "log", "hooks.2026-08-26.jsonl")
    )
  })

  it("uses the enqueue instant for records with an invalid timestamp", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-26T16:00:00.000Z"))
    try {
      persistence.persistHookExecutionRecord({ id: "invalid-timestamp", timestamp: "invalid" })
      await persistence.flushHookLogs()
    } finally {
      vi.useRealTimers()
    }

    const content = await readFile(
      join(tempHome, "hooks", "log", "hooks.2026-08-27.jsonl"),
      "utf-8"
    )
    expect(content).toContain('"id":"invalid-timestamp"')
  })

  it("prunes retention dates against the Beijing calendar", async () => {
    const logDir = join(tempHome, "hooks", "log")
    const expiredPath = join(logDir, "hooks.2026-08-19.jsonl")
    const retainedPath = join(logDir, "hooks.2026-08-20.jsonl")
    await writeFile(expiredPath, "expired\n", "utf-8")
    await writeFile(retainedPath, "retained\n", "utf-8")

    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-26T16:00:00.000Z"))
    try {
      await persistence.pruneOldHookLogs()
    } finally {
      vi.useRealTimers()
    }

    expect(existsSync(expiredPath)).toBe(false)
    expect(existsSync(retainedPath)).toBe(true)
  })
})
