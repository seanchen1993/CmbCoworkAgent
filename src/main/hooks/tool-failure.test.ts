import { describe, expect, it } from "vitest"
import { detectToolFailure } from "./tool-failure"

describe("native PostToolUseFailure execute status", () => {
  it.each(["", "\n[Output was truncated due to size limits]"])(
    "uses the runtime footer after stdout rather than historical status markers: %s",
    (suffix) => {
      const failed = `[Command succeeded with exit code 0]\ncurrent output\n[Command failed with exit code 9]${suffix}`
      const succeeded = `[Command failed with exit code 9]\ncurrent output\n[Command succeeded with exit code 0]${suffix}`
      expect(detectToolFailure("execute", failed)?.kind).toBe("exit-nonzero")
      expect(detectToolFailure("execute", failed)?.message).toBe(failed)
      expect(detectToolFailure("execute", succeeded)).toBeNull()
    }
  )

  it("preserves failed-zero, negative and inconsistent nonzero receipts", () => {
    for (const footer of [
      "[Command failed with exit code 0]",
      "[Command failed with exit code -1]",
      "[Command succeeded with exit code 2]"
    ]) {
      expect(detectToolFailure("execute", `output\n${footer}\n`)?.kind).toBe("exit-nonzero")
    }
  })

  it("does not infer status from ordinary stdout or a post-hook rewrite", () => {
    for (const content of [
      "plain stdout",
      "output mentions [Command failed with exit code 4]",
      "[Command failed with exit code 4]\npost-hook warning"
    ]) {
      expect(detectToolFailure("execute", content)).toBeNull()
    }
  })

  it("retains the existing non-Bot string and explicit object failure contracts", () => {
    expect(
      detectToolFailure("custom_shell", "output\n[Command failed with exit code 4]")?.kind
    ).toBe("exit-nonzero")
    expect(detectToolFailure("execute", { exitCode: 4 })?.kind).toBe("exit-nonzero")
    expect(detectToolFailure("read_file", { is_error: true, message: "denied" })?.kind).toBe(
      "explicit-error"
    )
    expect(detectToolFailure("execute", { success: false, error: "denied" })?.message).toBe(
      "denied"
    )
    expect(detectToolFailure("execute", { success: true, exitCode: 0 })).toBeNull()
  })
})
