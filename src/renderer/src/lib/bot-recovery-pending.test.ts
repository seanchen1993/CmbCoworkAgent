import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingBotRecovery,
  readPendingBotRecovery,
  rememberPendingBotRecovery
} from "./bot-recovery-pending"

afterEach(() => vi.unstubAllGlobals())
const input = {
  id: "run",
  revision: 4,
  nonce: "review",
  dataEpoch: "initial",
  decision: "resume" as const,
  note: "Verified",
  effects: [{ id: "effect", outcome: "succeeded" as const, note: "Report exists" }]
}
it("retains the exact review across reopening and fences other runs, restores and late acknowledgements", () => {
  const data = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key)
  })
  rememberPendingBotRecovery(input)
  expect(readPendingBotRecovery("run", "initial")).toEqual(input)
  expect(readPendingBotRecovery("other", "initial")).toBeNull()
  expect(readPendingBotRecovery("run", "restored")).toBeNull()
  const newer = { ...input, nonce: "later", revision: 7 }
  expect(() => rememberPendingBotRecovery(newer)).toThrow("尚未确认")
  acknowledgePendingBotRecovery({ ...input, note: "different intent" })
  expect(readPendingBotRecovery("run", "initial")).toEqual(input)
  acknowledgePendingBotRecovery(input)
  rememberPendingBotRecovery(newer)
  expect(readPendingBotRecovery("run", "initial")).toEqual(newer)
  const key = [...data.keys()][0]
  data.set(key, JSON.stringify({ ...newer, id: "other" }))
  expect(readPendingBotRecovery("run", "initial")).toBeNull()
  data.set(
    key,
    JSON.stringify({ ...newer, effects: [{ id: "effect", outcome: "unknown", note: "?" }] })
  )
  expect(readPendingBotRecovery("run", "initial")).toBeNull()
  expect(() => rememberPendingBotRecovery(newer)).toThrow("无法核对")
  data.delete(key)
  rememberPendingBotRecovery(newer)
  acknowledgePendingBotRecovery(newer)
  expect(data.size).toBe(0)
})
it("refuses dispatch when the recovery decision cannot be persisted", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() => rememberPendingBotRecovery(input)).toThrow("尚未提交")
})
