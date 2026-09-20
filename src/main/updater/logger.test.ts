import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const state = vi.hoisted(() => ({ root: "" }))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))

import { appendUpdateLog, updaterLog } from "./logger"

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "cmb-update-log-"))
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("update diagnostics", () => {
  it("flushes immediately, preserves previous events and redacts error details", () => {
    updaterLog.log("install requested", { version: "1.5.0", targetVersion: "1.5.1" })
    updaterLog.error("startup failed", new Error("Authorization: Bearer private-test-token"))
    const text = readFileSync(join(state.root, "updates", "updater.log"), "utf-8")
    const entries = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ pid: process.pid, level: "log" })
    expect(entries[0].details[1]).toMatchObject({ version: "1.5.0", targetVersion: "1.5.1" })
    expect(text).toContain("startup failed")
    expect(text).toContain("[REDACTED]")
    expect(text).not.toContain("private-test-token")
  })

  it("rotates a full log while retaining the previous attempt", () => {
    const logPath = join(state.root, "updater.log")
    writeFileSync(logPath, "x".repeat(5 * 1024 * 1024))
    appendUpdateLog(logPath, "log", ["next attempt"])
    expect(readFileSync(`${logPath}.1`, "utf-8")).toHaveLength(5 * 1024 * 1024)
    expect(readFileSync(logPath, "utf-8")).toContain("next attempt")
  })

  it("does not prevent updating when its log directory is unavailable", () => {
    const blockedPath = join(state.root, "not-a-directory")
    writeFileSync(blockedPath, "blocked")
    expect(() =>
      appendUpdateLog(join(blockedPath, "updater.log"), "error", ["failure"])
    ).not.toThrow()
  })

  it("retains the failure record when the previous rotated log cannot be replaced", () => {
    const logPath = join(state.root, "updater.log")
    writeFileSync(logPath, "x".repeat(5 * 1024 * 1024))
    mkdirSync(`${logPath}.1`)
    appendUpdateLog(logPath, "error", ["rollback failed during rotation"])
    expect(readFileSync(logPath, "utf-8").slice(-500)).toContain("rollback failed during rotation")
  })

  it("persists diagnostics without throwing when the console sink is broken", () => {
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("EPIPE: console closed")
    })
    expect(() => updaterLog.error("startup version mismatch")).not.toThrow()
    expect(readFileSync(join(state.root, "updates", "updater.log"), "utf-8")).toContain(
      "startup version mismatch"
    )
  })
})
