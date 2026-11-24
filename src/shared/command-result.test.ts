import { describe, expect, it } from "vitest"
import { hasFailedCommandResult } from "./command-result"

describe("execute terminal status receipt", () => {
  it.each([
    "[Command failed with exit code 1]",
    "output\n[Command failed with exit code -1]",
    "output\n[Command failed with exit code 0]",
    "output\n[Command succeeded with exit code 2]",
    "[Command succeeded with exit code 0]\noutput\n[Command failed with exit code 7]",
    "[Command succeeded with exit code 0]\n[Command failed with exit code 7]\n[Output was truncated due to size limits]",
    "output\r\n[Command failed with exit code 3]\r\n",
    "output\n[Command failed with exit code 3]\n\n"
  ])("recognizes only the final failure receipt: %s", (content) => {
    expect(hasFailedCommandResult(content)).toBe(true)
  })

  it.each([
    "[Command succeeded with exit code 0]",
    "[Command failed with exit code 7]\noutput\n[Command succeeded with exit code 0]",
    "[Command failed with exit code 7]\n[Command succeeded with exit code 0]\n[Output was truncated due to size limits]",
    "output\r\n[Command succeeded with exit code 0]\r\n"
  ])("ignores historical stdout failures when this execution succeeded: %s", (content) => {
    expect(hasFailedCommandResult(content)).toBe(false)
  })

  it.each([
    undefined,
    null,
    { exitCode: 1 },
    "plain stdout",
    "prefix [Command failed with exit code 1]",
    "[Command failed with exit code 1] suffix",
    "[Command failed with exit code 1]\nmore stdout",
    "[Command failed with exit code 1]\npost-hook warning",
    "[Command failed with exit code 1]\n[Output was truncated due to size limits]\npost-hook replacement",
    "[Command failed with exit code null]",
    "[Command failed with exit code 1, elapsed: 2s]",
    "[Output was truncated due to size limits]"
  ])("does not infer a command failure from unrecognized or rewritten output: %s", (content) => {
    expect(hasFailedCommandResult(content)).toBe(false)
  })
})
