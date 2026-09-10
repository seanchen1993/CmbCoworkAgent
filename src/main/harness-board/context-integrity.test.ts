import { describe, expect, it } from "vitest"
import {
  HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED,
  HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES,
  HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES,
  HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED,
  HARNESS_SESSION_CONTEXT_MAX_CHARS,
  HarnessSessionContextLimitError,
  requireCompleteHarnessDeployUnitContext,
  requireCompleteHarnessSessionContext
} from "./context-integrity"

describe("Harness context integrity", () => {
  it("preserves a complete session context at the configured safety boundary", () => {
    const context = "x".repeat(HARNESS_SESSION_CONTEXT_MAX_CHARS)

    expect(requireCompleteHarnessSessionContext(context)).toBe(context)
  })

  it("fails closed instead of silently truncating an oversized session context", () => {
    const oversized = "x".repeat(HARNESS_SESSION_CONTEXT_MAX_CHARS + 1)

    expect(() => requireCompleteHarnessSessionContext(oversized)).toThrowError(
      expect.objectContaining({
        name: HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED,
        code: HARNESS_SESSION_CONTEXT_LIMIT_EXCEEDED,
        actualCharacters: HARNESS_SESSION_CONTEXT_MAX_CHARS + 1,
        maximumCharacters: HARNESS_SESSION_CONTEXT_MAX_CHARS
      }) as HarnessSessionContextLimitError
    )
  })

  it("keeps plugin and framework deploy-unit limits explicit", () => {
    expect(() =>
      requireCompleteHarnessDeployUnitContext(
        HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES,
        "plugin"
      )
    ).not.toThrow()
    expect(() =>
      requireCompleteHarnessDeployUnitContext(
        HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES + 1,
        "cmbdevclaw"
      )
    ).toThrowError(
      expect.objectContaining({
        code: HARNESS_DEPLOY_UNIT_CONTEXT_LIMIT_EXCEEDED,
        actualEntries: HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES + 1,
        maximumEntries: HARNESS_FRAMEWORK_DEPLOY_UNIT_CONTEXT_MAX_ENTRIES
      }) as Error
    )
  })
})
