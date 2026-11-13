import { expect, it, vi } from "vitest"
import { inspectFunctionConversationAdmission, inspectFunctionConversationForkAdmission }
  from "./function-conversation-admission"

const state = { version: 1 as const, logicalSessionId: "session", conversationId: "conversation",
  branchId: "branch", frontier: 0 }
const stamp = { conversationId: "conversation", branchId: "branch", uuid: "original-row", sequence: 1,
  door: "prompt", messageType: "user", origin: { kind: "composer" } }
const ordinary = { id: "legacy", content: "original ordinary history" }
const marked = { id: stamp.uuid, additional_kwargs: { function_row: stamp } }

it("keeps ordinary history independent of feature flags, serializers and recovery callbacks", () => {
  const recover = vi.fn(() => { throw Error("ordinary recovery must not run") })
  const data = { state: undefined, messages: [ordinary] }
  for (const field of ["enabled", "saver", "store", "recover"])
    Object.defineProperty(data, field, { get: recover })
  expect(inspectFunctionConversationAdmission(data, () => {})).toEqual({
    kind: "ordinary", marked: false, invalid: false
  })
  expect(recover).not.toHaveBeenCalled()
})

it("classifies native history without downgrading it when a feature flag is false", () => {
  const input = { state, messages: [ordinary, marked], enabled: false }
  const result = inspectFunctionConversationAdmission(input, () => {})
  expect(result).toEqual({ kind: "native", state, marked: true, invalid: false })
  expect(result.kind === "native" && result.state).not.toBe(state)
  expect(state.frontier).toBe(0)
})

it.each([
  marked,
  { id: "bad", additional_kwargs: { function_row_invalid: false } },
  { kwargs: { additional_kwargs: { function_row: { ...stamp, origin: { kind: "forged" } } } } }
])("preserves orphan or invalid native evidence instead of treating it as legacy", message => {
  expect(inspectFunctionConversationAdmission({ state: undefined, messages: [ordinary, message] },
    () => {}).kind).toBe("unproven-native")
})

it("rejects malformed native state before ordinary enrollment", () => {
  expect(() => inspectFunctionConversationAdmission({ state: { ...state, frontier: -1 },
    messages: [ordinary] }, () => {})).toThrow("MODS_CONVERSATION_STATE_INVALID")
})

it("keeps a native invalid marker visible for the actual membership verifier", () => {
  expect(inspectFunctionConversationAdmission({ state, messages: [
    { additional_kwargs: { function_row_invalid: true } }
  ] }, () => {})).toEqual({ kind: "native", state, marked: false, invalid: true })
})

it("preflights ordinary forks without opening recovery or creating a native target", () => {
  const recover = vi.fn()
  const kind = inspectFunctionConversationForkAdmission([
    { state: undefined, messages: [ordinary] }, { state: undefined, messages: [] }
  ], () => {})
  if (kind === "native") recover()
  expect(kind).toBe("ordinary")
  expect(recover).not.toHaveBeenCalled()
})

it("rejects mixed orphan history before any native fork recovery side effect", () => {
  const recover = vi.fn()
  expect(() => {
    const kind = inspectFunctionConversationForkAdmission([
      { state, messages: [marked] }, { state: undefined, messages: [ordinary, marked] }
    ], () => {})
    if (kind === "native") recover()
  }).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  expect(recover).not.toHaveBeenCalled()
})

it("allows proven and ordinary retained fork checkpoints to use the native import path", () => {
  expect(inspectFunctionConversationForkAdmission([
    { state: undefined, messages: [ordinary] }, { state, messages: [marked] }
  ], () => {})).toBe("native")
})

it("checks revocation while inspecting history and never turns a refusal into ordinary", () => {
  const changed = Error("ORIGINAL_SCOPE_CHANGED")
  let calls = 0
  expect(() => inspectFunctionConversationAdmission({ state: undefined, messages: [ordinary, marked] },
    () => { if (++calls === 3) throw changed })).toThrow(changed)
})
