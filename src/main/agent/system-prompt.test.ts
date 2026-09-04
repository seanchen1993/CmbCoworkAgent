import { describe, expect, it } from "vitest"
import { GIT_MASTER_PROFILE } from "./library/git-master"
import {
  appendTaskCompletionAndRepetitionPrompt,
  BASE_SYSTEM_PROMPT,
  TASK_COMPLETION_AND_REPETITION_PROMPT
} from "./system-prompt"

describe("Agent completion and repetition guidance", () => {
  it("defines one shared contract for completion, text repetition, and identical tool calls", () => {
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain("within your role and access limits")
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "responsible and permitted to implement"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "handoff explicitly required by the current mode or tool"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).not.toContain("For action tasks")
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain("when it adds no value")
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "provide self-contained final answers, concise result reports"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "Reuse a useful, still-applicable result"
    )
    const deniedCallRule =
      "Never repeat a user-denied call unless the user explicitly requests it again"
    const otherRetryRule = "For other calls, retry the same tool with identical arguments only when"
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(deniedCallRule)
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(otherRetryRule)
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT.indexOf(deniedCallRule)).toBeLessThan(
      TASK_COMPLETION_AND_REPETITION_PROMPT.indexOf(otherRetryRule)
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "inspect the current state before deciding whether a retry is still needed"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).toContain(
      "a confirmed relevant state change, including workspace edits"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).not.toContain(
      "Never repeat a user-denied call without a new explicit request"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).not.toContain(
      "Do not restate the request, plan, conclusion, or progress update"
    )
    expect(TASK_COMPLETION_AND_REPETITION_PROMPT).not.toContain("instead of retrying it unchanged")
    expect(BASE_SYSTEM_PROMPT).toContain(TASK_COMPLETION_AND_REPETITION_PROMPT)
    expect(BASE_SYSTEM_PROMPT).not.toContain("After working on a file, just stop")
    expect(BASE_SYSTEM_PROMPT).toContain("continue with the first actionable item in the same turn")
    expect(BASE_SYSTEM_PROMPT).not.toContain("ALWAYS ask the user if the plan looks good")
    expect(BASE_SYSTEM_PROMPT).not.toContain(
      "Wait for the user's response before marking the first todo"
    )
  })

  it("does not append the shared contract twice", () => {
    const once = appendTaskCompletionAndRepetitionPrompt("role prompt")
    expect(appendTaskCompletionAndRepetitionPrompt(once)).toBe(once)
  })
})

describe("Agent Git commit guidance", () => {
  it("uses Git-reported paths and leaves staging to the task-card dialog", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("only when the user explicitly requests it")
    expect(BASE_SYSTEM_PROMPT).toContain("`git status --short`")
    expect(BASE_SYSTEM_PROMPT).toContain(
      "For ordinary new commits, do not run `git add` separately"
    )
    expect(BASE_SYSTEM_PROMPT).toContain("ignored untracked files")
    expect(BASE_SYSTEM_PROMPT).toContain("Never bypass")
    expect(BASE_SYSTEM_PROMPT).toContain("do not select unrelated files")
    expect(BASE_SYSTEM_PROMPT).toMatch(
      /During\s+rebase\/merge conflict resolution, still use `git add`/
    )
  })

  it("gives the Git specialist the same staging guidance", () => {
    expect(GIT_MASTER_PROFILE.systemPrompt).toContain(
      "exact relevant paths reported by `git status`"
    )
    expect(GIT_MASTER_PROFILE.systemPrompt).toContain(
      "for ordinary new commits, do not run `git add` separately"
    )
    expect(GIT_MASTER_PROFILE.systemPrompt).toContain("Never bypass Git ignore rules")
    expect(GIT_MASTER_PROFILE.systemPrompt).toContain("do not select unrelated files or retry")
    expect(GIT_MASTER_PROFILE.systemPrompt).toMatch(
      /During rebase\/merge conflict resolution,\s+still use `git add`/
    )
  })
})
