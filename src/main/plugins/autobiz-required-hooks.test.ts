import { expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  reviewedAutobizRequiredHookIds,
  isReviewedAutobizKernelIdentity
} from "./autobiz-required-hooks"
import reviewed from "./autobiz-business-kernel-reviewed.json"

it("classifies every reviewed original business guard while leaving prompts and logging composable", () => {
  const bytes = readFileSync(
    new URL("../../../tests/fixtures/autobiz-reviewed-hooks.json", import.meta.url)
  )
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    reviewed.files.find((file) => file.path === "hooks/hooks.json")!.digest
  )
  const raw = JSON.parse(bytes.toString("utf8"))
  const required = reviewedAutobizRequiredHookIds(raw)
  expect(required).toHaveLength(12)
  expect(required).toEqual([
    "PreToolUse:1:0",
    "PreToolUse:1:1",
    "PreToolUse:1:2",
    "PreToolUse:1:3",
    "PreToolUse:2:0",
    "PreToolUse:3:0",
    "PreToolUse:3:1",
    "PreToolUse:3:2",
    "PreToolUse:3:3",
    "PreToolUse:3:4",
    "PostToolUse:1:0",
    "PostToolUse:2:0"
  ])
  expect(required).not.toContain("PreToolUse:0:0")
  expect(required).not.toContain("PreToolUse:0:1")
  expect(required).not.toContain("PostToolUse:0:0")
  for (const [event, group, hook] of required.map((id) => id.split(":"))) {
    const removed = structuredClone(raw)
    removed[event][Number(group)].hooks.splice(Number(hook), 1)
    expect(() => reviewedAutobizRequiredHookIds(removed)).toThrow("INCOMPLETE")
  }
  expect(isReviewedAutobizKernelIdentity(reviewed)).toBe(true)
  expect(isReviewedAutobizKernelIdentity({ id: "another", version: "1" })).toBe(false)
})
