import { describe, expect, it } from "vitest"
import { botToolResultStatus } from "./bot-tool-result-status"

describe("Bot recovered tool result status", () => {
  const tool = { id: "call_1", name: "write_file", args: {} }
  const cancellation =
    "Tool call write_file with id call_1 was cancelled - another message came in before it could be completed."

  it("keeps a synthetic cancellation interrupted after a later turn supplies its result", () => {
    expect(botToolResultStatus(tool, { content: cancellation })).toBe("interrupted")
    expect(botToolResultStatus(tool, { content: cancellation, is_error: true })).toBe("interrupted")
  })

  it("does not interpret ordinary text or another call's result as a cancellation", () => {
    expect(botToolResultStatus(tool)).toBeUndefined()
    expect(botToolResultStatus(tool, { content: `Quoted output: ${cancellation}` })).toBeUndefined()
    expect(
      botToolResultStatus({ ...tool, id: "call_2" }, { content: cancellation })
    ).toBeUndefined()
    expect(botToolResultStatus(tool, { content: "Successfully wrote the file" })).toBeUndefined()
    expect(botToolResultStatus(tool, { content: "permission denied", is_error: true })).toBe(
      "failed"
    )
  })
  it("preserves native command failures even when the transcript has no is_error flag", () => {
    const content = "[stderr] cp: 1014L2.md: Not a directory\n\n[Command failed with exit code 1]"
    expect(botToolResultStatus({ ...tool, name: "execute" }, { content })).toBe("failed")
    expect(botToolResultStatus({ ...tool, name: "read_file" }, { content })).toBeUndefined()
    expect(
      botToolResultStatus(
        { ...tool, name: "execute" },
        {
          content: "[Command succeeded with exit code 0]"
        }
      )
    ).toBeUndefined()
  })

  it.each([
    ["failed command", "Y_FAILED\n[Command failed with exit code 7, elapsed: 3s]", "failed"],
    [
      "terminated command",
      "<no output>\n[Command failed with exit code null, elapsed: 1s]",
      "failed"
    ],
    ["missing task", 'Error: No background task found with id "missing-1017Y".', "failed"],
    ["invalid id", "Error: Invalid task id.", "failed"],
    ["blocked hook", "[Hook blocked] task_output was blocked by a hook", "failed"],
    [
      "cancelled polling",
      "Task polling aborted: conversation was cancelled by user.",
      "interrupted"
    ]
  ] as const)(
    "recognizes a native task_output %s without reclassifying file contents",
    (_, content, status) => {
      expect(botToolResultStatus({ ...tool, name: "task_output" }, { content })).toBe(status)
      expect(botToolResultStatus(tool, { content })).toBeUndefined()
    }
  )

  it("uses the final task_output receipt rather than a success marker printed by the command", () => {
    const content =
      "[Command succeeded with exit code 0, elapsed: 1s]\n[Command failed with exit code 7, elapsed: 3s]"
    expect(botToolResultStatus({ ...tool, name: "task_output" }, { content })).toBe("failed")
    expect(
      botToolResultStatus(
        { ...tool, name: "task_output" },
        {
          content: "Y_READY\n[Command succeeded with exit code 0, elapsed: 47s]"
        }
      )
    ).toBeUndefined()
  })

  it("does not classify nontext task_output payloads as successful", () => {
    expect(
      botToolResultStatus(
        { ...tool, name: "task_output" },
        {
          content: { retrieval_status: "not_ready", elapsed: 2, command: "node job.mjs" }
        }
      )
    ).toBeUndefined()
  })
})
