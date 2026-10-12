import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingApprovalRule,
  readPendingApprovalRule,
  rememberPendingApprovalRule
} from "./bot-approval-pending"
afterEach(() => vi.unstubAllGlobals())
it("retains the exact change after response loss and rejects foreign Bot, restored epoch and invalid fields", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, v),
    removeItem: (k: string) => items.delete(k)
  })
  const value = {
    botId: "bot",
    ruleId: "rule",
    revision: 1,
    dataEpoch: "initial",
    nonce: "first",
    behavior: "ask" as const
  }
  rememberPendingApprovalRule(value)
  expect(readPendingApprovalRule("bot", "initial")).toEqual(value)
  expect(readPendingApprovalRule("other", "initial")).toBeNull()
  expect(readPendingApprovalRule("bot", "restored")).toBeNull()
  const next = { ...value, nonce: "second", revision: 2 }
  expect(() => rememberPendingApprovalRule(next)).toThrow("尚未确认")
  items.set([...items.keys()][0], JSON.stringify(next))
  acknowledgePendingApprovalRule(value)
  expect(readPendingApprovalRule("bot", "initial")).toEqual(next)
  items.set([...items.keys()][0], JSON.stringify({ ...next, scope: "forged" }))
  expect(readPendingApprovalRule("bot", "initial")).toBeNull()
  expect(() => rememberPendingApprovalRule(next)).toThrow("无法核对")
  items.set([...items.keys()][0], JSON.stringify(next))
  acknowledgePendingApprovalRule(next)
  expect(items.size).toBe(0)
})
it("does not submit a change when its recovery identity cannot be saved", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {
      throw new Error("quota")
    }
  })
  expect(() =>
    rememberPendingApprovalRule({
      botId: "bot",
      ruleId: "rule",
      revision: 1,
      dataEpoch: "initial",
      nonce: "change",
      behavior: null
    })
  ).toThrow("尚未修改")
})
