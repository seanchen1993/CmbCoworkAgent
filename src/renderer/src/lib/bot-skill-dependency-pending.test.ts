import { expect, it } from "vitest"
import {
  createPendingSkillDependencyStore,
  isDefinitiveSkillDependencyError
} from "./bot-skill-dependency-pending"

const request = {
  nonce: "original",
  expectedDataEpoch: "epoch",
  skill: { botId: "bot", id: "skill", version: 1 }
}
const receipt = {
  runId: "run",
  messageId: "message",
  skill: { ...request.skill, name: "Skill", scope: "bot" as const, sha256: "a".repeat(64) }
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
  return { values, storage, pending: createPendingSkillDependencyStore(() => storage) }
}
it("keeps unknown ACK exact nonce and selected version across reopening", () => {
  const f = fixture()
  f.pending.remember(request)
  const reopened = createPendingSkillDependencyStore(() => f.storage)
  expect(reopened.inspect("bot", "skill", "epoch")).toMatchObject({
    kind: "valid",
    input: { request }
  })
  expect(() =>
    reopened.remember({ ...request, nonce: "replacement", skill: { ...request.skill, version: 2 } })
  ).toThrow("尚未确认")
  expect(reopened.inspect("other", "skill", "epoch").kind).toBe("empty")
})
it("persists ACK in the same record so successful submit plus failed refresh never resubmits on reopening", () => {
  const f = fixture()
  f.pending.remember(request)
  f.pending.accept(request, receipt)
  const reopened = createPendingSkillDependencyStore(() => f.storage)
  const current = reopened.inspect("bot", "skill", "epoch")
  expect(current).toMatchObject({ kind: "valid", input: { request, receipt } })
  f.pending.accept(request, receipt)
  expect(() => f.pending.accept(request, { ...receipt, runId: "different" })).toThrow("不同")
  expect(f.values.size).toBe(1)
  expect(current.kind === "valid" && reopened.complete(current.input)).toBe(true)
  expect(f.values.size).toBe(0)
})
it("late ACK cannot overwrite newer intent or bind a receipt to another version", () => {
  const f = fixture()
  f.pending.remember(request)
  expect(() =>
    f.pending.accept(request, { ...receipt, skill: { ...receipt.skill, version: 2 } })
  ).toThrow()
  const key = [...f.values.keys()][0]
  const next = { ...request, nonce: "newer" }
  f.values.set(key, JSON.stringify({ dataEpoch: "epoch", input: { request: next } }))
  expect(() => f.pending.accept(request, receipt)).toThrow("已变化")
  expect(f.pending.inspect("bot", "skill", "epoch")).toMatchObject({ input: { request: next } })
})
it("epoch restoration retains original ACK and requires exact exported-record discard", () => {
  const f = fixture()
  f.pending.remember(request)
  f.pending.accept(request, receipt)
  const obsolete = f.pending.inspect("bot", "skill", "restored")
  expect(obsolete).toMatchObject({
    kind: "obsolete",
    dataEpoch: "epoch",
    input: { request, receipt }
  })
  expect(() => f.pending.remember({ ...request, expectedDataEpoch: "restored" })).toThrow("恢复前")
  expect(f.pending.discard("bot", "skill", "restored", "wrong")).toBe(false)
  expect(
    obsolete.kind === "obsolete" && f.pending.discard("bot", "skill", "restored", obsolete.raw)
  ).toBe(true)
})
it("storage failures preserve original requests and acknowledged completion never erases foreign intent", () => {
  const f = fixture()
  f.pending.remember(request)
  const unwritable = createPendingSkillDependencyStore(() => ({
    ...f.storage,
    setItem() {
      throw new Error("quota")
    }
  }))
  expect(() => unwritable.accept(request, receipt)).toThrow("后台已收到")
  expect(f.pending.inspect("bot", "skill", "epoch")).toMatchObject({ input: { request } })
  f.pending.accept(request, receipt)
  const unremovable = createPendingSkillDependencyStore(() => ({
    ...f.storage,
    removeItem() {
      throw new Error("denied")
    }
  }))
  expect(unremovable.complete({ request, receipt })).toBe(false)
  expect(f.pending.inspect("bot", "skill", "epoch")).toMatchObject({ input: { request, receipt } })
  const unreadable = createPendingSkillDependencyStore(() => ({
    ...f.storage,
    getItem() {
      throw new Error("denied")
    }
  }))
  expect(unreadable.inspect("bot", "skill", "epoch").kind).toBe("unreadable")
  const key = [...f.values.keys()][0]
  f.values.set(key, "broken")
  expect(f.pending.inspect("bot", "skill", "epoch").kind).toBe("corrupt")
  expect(() => f.pending.remember(request)).toThrow("无法核对")
})
it("clears only typed transactional rejection, never text, lost ACK, retired epoch or interrupted effect", () => {
  expect(isDefinitiveSkillDependencyError({ code: "skill_changed" })).toBe(true)
  expect(isDefinitiveSkillDependencyError({ code: "skill_dependency_busy" })).toBe(true)
  for (const failure of [
    new Error("invalid_input"),
    { code: "connection_closed" },
    { code: "data_epoch" },
    { code: "skill_dependency_interrupted" },
    { code: "effect_requires_review" },
    null
  ])
    expect(isDefinitiveSkillDependencyError(failure)).toBe(false)
})
