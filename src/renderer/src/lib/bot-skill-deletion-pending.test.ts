import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingSkillDeletion,
  readPendingSkillDeletions,
  rememberPendingSkillDeletion,
  isDefiniteSkillDeletionFailure
} from "./bot-skill-deletion-pending"

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  return items
}
const input = { nonce: "original", botId: "bot", skillId: "skill", version: 3 }
it("retains exact removal after its active card disappears and never replays another restore epoch", () => {
  const items = fixture()
  const first = rememberPendingSkillDeletion(input, "Original skill", "epoch")
  expect(readPendingSkillDeletions("bot", "epoch")).toEqual([first])
  expect(readPendingSkillDeletions("other", "epoch")).toEqual([])
  expect(readPendingSkillDeletions("bot", "restored")).toEqual([])
  expect(rememberPendingSkillDeletion(input, "Original skill", "epoch")).toEqual(first)
  expect(() =>
    rememberPendingSkillDeletion({ ...input, nonce: "other", version: 4 }, "Newer", "epoch")
  ).toThrow()
  acknowledgePendingSkillDeletion({ ...first, input: { ...input, nonce: "wrong" } })
  expect(readPendingSkillDeletions("bot", "epoch")).toEqual([first])
  acknowledgePendingSkillDeletion(first)
  expect(items.size).toBe(0)
})
it("rejects corrupted or unavailable storage before dispatch and distinguishes definitive rejection from lost acknowledgement", () => {
  const items = fixture()
  items.set("bot-skill-deletion-pending:bot", "{".repeat(128_001))
  expect(readPendingSkillDeletions("bot", "epoch")).toEqual([])
  expect(() => rememberPendingSkillDeletion(input, "Skill", "epoch")).toThrow("尚未提交")
  for (const code of [
    "revision_conflict",
    "not_found",
    "skill_unavailable",
    "invalid_input",
    "skill_scope",
    "nonce_conflict"
  ])
    expect(isDefiniteSkillDeletionFailure({ code })).toBe(true)
  for (const code of ["transport_closed", "deletion_ledger_unavailable", "timeout"])
    expect(isDefiniteSkillDeletionFailure({ code })).toBe(false)
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() => rememberPendingSkillDeletion(input, "Skill", "epoch")).toThrow("尚未提交")
})
