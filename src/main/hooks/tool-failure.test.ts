import { describe, expect, it } from "vitest"
import { detectToolFailure } from "./tool-failure"

describe.each(["monitor", "task_output"])("%s failure detection", (toolName) => {
  it.each([7, -3, "null"])("detects a terminal failure with exit code %s", (exitCode) => {
    const result = [
      "[Command succeeded with exit code 0]",
      "shell output",
      `[Command failed with exit code ${exitCode}, elapsed: 3s]`
    ].join("\n")

    expect(detectToolFailure(toolName, result)).toMatchObject({ kind: "exit-nonzero" })
  })

  it("uses the final success status instead of earlier output markers", () => {
    const result = [
      "[Command failed with exit code 7]",
      "[Command failed with exit code 9, elapsed: 2s]",
      "[Command succeeded with exit code 0, elapsed: 3s]"
    ].join("\n")

    expect(detectToolFailure(toolName, result)).toBeNull()
  })

  it("requires a complete terminal status line", () => {
    const marker = "[Command failed with exit code 7, elapsed: 3s]"

    expect(detectToolFailure(toolName, `${marker}\nshell output`)).toBeNull()
    expect(detectToolFailure(toolName, `shell output ${marker}`)).toBeNull()
    expect(detectToolFailure(toolName, JSON.stringify({ partialOutput: marker }))).toBeNull()
  })
})

it("preserves ordinary shell failure detection before the truncation marker", () => {
  const result = "shell output\n[Command failed with exit code 7]\n[Output was truncated]"

  expect(detectToolFailure("execute", result)).toMatchObject({ kind: "exit-nonzero" })
  expect(detectToolFailure("execute", "[Command succeeded with exit code 0]")).toBeNull()
})
