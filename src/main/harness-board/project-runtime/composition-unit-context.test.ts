import { expect, it } from "vitest"
import { assertCompositionUnitContextSelection } from "./composition-unit-context"
import { parseCompositionUnitContext } from "../../../shared/project-runtime/composition-api"

const options = { supported: true, required: true, candidates: ["UNIT.ONE", "UNIT.TWO"], selected: [], contextFingerprint: "a".repeat(64) }
it("requires explicit original candidate confirmation and rejects changed knowledge or invented inputs", () => {
  expect(() => assertCompositionUnitContextSelection(options, undefined)).toThrow("CONTEXT_REQUIRED")
  expect(() => assertCompositionUnitContextSelection(options, { deployUnitIds: [], contextFingerprint: options.contextFingerprint })).toThrow("CONTEXT_REQUIRED")
  expect(() => assertCompositionUnitContextSelection(options, { deployUnitIds: ["UNDECLARED"], contextFingerprint: options.contextFingerprint })).toThrow("CONTEXT_CHANGED")
  expect(() => assertCompositionUnitContextSelection(options, { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "b".repeat(64) })).toThrow("CONTEXT_CHANGED")
  expect(() => assertCompositionUnitContextSelection(options, { deployUnitIds: ["UNIT.ONE"], contextFingerprint: options.contextFingerprint })).not.toThrow()
  expect(() => assertCompositionUnitContextSelection({ ...options, supported: false }, { deployUnitIds: ["UNIT.ONE"], contextFingerprint: options.contextFingerprint })).toThrow("UNSUPPORTED")
})
it.each([
  { deployUnitIds: ["UNIT.ONE", "UNIT.ONE"], contextFingerprint: "a".repeat(64) },
  { deployUnitIds: [" UNIT.ONE"], contextFingerprint: "a".repeat(64) },
  { deployUnitIds: ["UNIT\nONE"], contextFingerprint: "a".repeat(64) },
  { deployUnitIds: Array.from({ length: 129 }, (_, id) => String(id)), contextFingerprint: "a".repeat(64) },
  { deployUnitIds: ["UNIT.ONE"], contextFingerprint: "a".repeat(64), sourceRoot: "C:/untrusted" }
])("bounds the persisted native selection %j", selection => {
  expect(() => parseCompositionUnitContext(selection)).toThrow("CONTEXT_INVALID")
})
