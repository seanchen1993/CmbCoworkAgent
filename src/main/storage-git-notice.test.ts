import { beforeEach, expect, it, vi } from "vitest"

const f = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failRead: false,
  failWrite: false,
  discardWrite: false,
  writes: [] as Array<Record<string, unknown>>
}))
vi.mock("electron", () => ({ app: {} }))
vi.mock("electron-store", () => ({
  default: class {
    get(key: string, fallback: unknown) {
      if (f.failRead) throw Error("unreadable")
      return f.values.has(key) ? f.values.get(key) : fallback
    }
    set(value: Record<string, unknown>) {
      f.writes.push(value)
      if (f.failWrite) throw Error("unwritable")
      if (!f.discardWrite)
        for (const [key, entry] of Object.entries(value)) f.values.set(key, entry)
    }
  }
}))
beforeEach(() => {
  f.values.clear()
  f.writes.length = 0
  f.failRead = f.failWrite = f.discardWrite = false
  vi.resetModules()
})

it("keeps the original default and writes the actual value/revision atomically", async () => {
  const s = await import("./storage")
  expect(s.getGitChangeNoticeSetting()).toEqual({ value: true, revision: "0" })
  expect(s.setGitChangeNoticeEnabled(true)).toBe(true)
  expect(f.writes).toHaveLength(0)
  expect(s.setGitChangeNoticeEnabled(false)).toBe(false)
  expect(f.writes).toEqual([{ gitChangeNoticeEnabled: false, gitChangeNoticeRevision: 1 }])
  expect(s.getGitChangeNoticeSetting()).toEqual({ value: false, revision: "1" })
  s.setGitChangeNoticeEnabled(true)
  expect(s.getGitChangeNoticeSetting()).toEqual({ value: true, revision: "2" })
})

it("strict proof reads reject failures and malformed values, while ordinary reads keep fallback", async () => {
  const s = await import("./storage")
  f.values.set("gitChangeNoticeEnabled", "false")
  expect(() => s.getGitChangeNoticeSetting()).toThrow("Invalid stored")
  f.values.set("gitChangeNoticeEnabled", false)
  f.values.set("gitChangeNoticeRevision", -1)
  expect(() => s.getGitChangeNoticeSetting()).toThrow("Invalid stored")
  f.failRead = true
  vi.spyOn(console, "warn").mockImplementation(() => {})
  expect(s.getGitChangeNoticeEnabled()).toBe(true)
  expect(() => s.getGitChangeNoticeSetting()).toThrow("unreadable")
  expect(() => s.setGitChangeNoticeEnabled(false)).toThrow("unreadable")
  expect(f.writes).toHaveLength(0)
})

it("writer failures and absent durable commits never return successful values", async () => {
  const s = await import("./storage")
  f.failWrite = true
  expect(() => s.setGitChangeNoticeEnabled(false)).toThrow("unwritable")
  f.failWrite = false
  f.discardWrite = true
  expect(() => s.setGitChangeNoticeEnabled(false)).toThrow("commit unconfirmed")
  expect(s.getGitChangeNoticeSetting()).toEqual({ value: true, revision: "0" })
})
