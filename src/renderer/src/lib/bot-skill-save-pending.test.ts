import { afterEach, expect, it, vi } from "vitest"
import {
  createPendingSkillSaveStore,
  isDefinitiveSkillSaveError,
  pendingSkillSaveIds
} from "./bot-skill-save-pending"
import type { BotPendingSkillSave } from "../../../shared/bot-skill-save"

const input: BotPendingSkillSave = {
  nonce: "save",
  expectedDataEpoch: "epoch",
  botId: "owner",
  name: "核对",
  instructions: "读取证据",
  enabled: true
}
function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  return {
    values,
    storage,
    pending: createPendingSkillSaveStore(() => storage)
  }
}
afterEach(() => vi.unstubAllGlobals())
it("recovers exact creation and toggle input after reopening, without overwriting unknown saves", () => {
  const { pending, storage, values } = fixture()
  pending.remember(input, "epoch")
  const reopened = createPendingSkillSaveStore(() => storage)
  expect(reopened.read("owner", undefined, "epoch")).toEqual(input)
  expect(() => reopened.remember({ ...input, nonce: "replacement" }, "epoch")).toThrow("尚未确认")
  const update = {
    ...input,
    id: "skill",
    version: 7,
    nonce: "toggle",
    enabled: false
  }
  pending.remember(update, "epoch")
  expect(reopened.read("owner", "skill", "epoch")).toEqual(update)
  expect(reopened.read("other", "skill", "epoch")).toBeNull()
  expect(reopened.acknowledge({ ...update, nonce: "late-other" }, "epoch")).toBe(false)
  expect(values.size).toBe(2)
  expect(reopened.acknowledge(update, "epoch")).toBe(true)
})
it("keeps retired/corrupt records until exact reviewed discard, and blocks storage access failures", () => {
  const { pending, values, storage } = fixture()
  pending.remember(input, "epoch")
  const retired = pending.inspect("owner", undefined, "restored")
  expect(retired.kind).toBe("obsolete")
  expect(() => pending.remember({ ...input, expectedDataEpoch: "restored" }, "restored")).toThrow(
    "恢复前"
  )
  expect(() => pending.remember(input, "wrong")).toThrow()
  expect(pending.discard("owner", undefined, "restored", "stale raw")).toBe(false)
  const key = [...values.keys()][0]
  values.set(key, "broken")
  expect(() => pending.remember(input, "epoch")).toThrow("无法核对")
  expect(pending.discard("owner", undefined, "epoch", "broken")).toBe(true)
  const unavailable = createPendingSkillSaveStore(() => ({
    ...storage,
    getItem: () => {
      throw new Error("denied")
    }
  }))
  expect(unavailable.inspect("owner", undefined, "epoch").kind).toBe("unreadable")
  expect(() => unavailable.remember(input, "epoch")).toThrow("无法核对")
  const noWrite = createPendingSkillSaveStore(() => ({
    ...storage,
    setItem: () => {
      throw new Error("quota")
    }
  }))
  expect(() => noWrite.remember(input, "epoch")).toThrow("尚未提交")
})
it("does not let an old completion remove newer intent and exposes accepted-but-cleanup-failed recovery", () => {
  const { pending, values, storage } = fixture()
  pending.remember(input, "epoch")
  const key = [...values.keys()][0],
    next = { ...input, nonce: "newer" }
  values.set(key, JSON.stringify({ dataEpoch: "epoch", input: next }))
  expect(pending.acknowledge(input, "epoch")).toBe(false)
  expect(pending.read("owner", undefined, "epoch")).toEqual(next)
  const noRemove = createPendingSkillSaveStore(() => ({
    ...storage,
    removeItem: () => {
      throw new Error("quota")
    }
  }))
  expect(noRemove.acknowledge(next, "epoch")).toBe(false)
  expect(noRemove.read("owner", undefined, "epoch")).toEqual(next)
})
it("indexes disappeared skill identities only, bounded and scoped, and never guesses a definitive failure from text", () => {
  const { pending, storage, values } = fixture()
  vi.stubGlobal("localStorage", {
    ...storage,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    }
  })
  pending.remember(input, "epoch")
  pending.remember({ ...input, id: "skill", version: 1 }, "epoch")
  expect(pendingSkillSaveIds("owner")).toEqual(["skill"])
  expect(pendingSkillSaveIds("other")).toEqual([])
  expect(isDefinitiveSkillSaveError(new Error("revision_conflict"))).toBe(false)
  expect(isDefinitiveSkillSaveError({ code: "workspace_replaced" })).toBe(false)
  expect(isDefinitiveSkillSaveError({ code: "data_epoch" })).toBe(false)
  expect(isDefinitiveSkillSaveError({ code: "invalid_input" })).toBe(true)
  expect(isDefinitiveSkillSaveError({ code: "connection_closed" })).toBe(false)
})
