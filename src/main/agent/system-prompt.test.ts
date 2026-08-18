import { describe, expect, it } from "vitest"
import { GIT_MASTER_PROFILE } from "./library/git-master"
import { BASE_SYSTEM_PROMPT } from "./system-prompt"

describe("Agent Git commit guidance", () => {
  it("uses Git-reported paths and leaves staging to the task-card dialog", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("`git status --short`")
    expect(BASE_SYSTEM_PROMPT).toContain(
      "For ordinary new commits, do not run `git add` separately"
    )
    expect(BASE_SYSTEM_PROMPT).toContain("ignored untracked files")
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
    expect(GIT_MASTER_PROFILE.systemPrompt).toContain(
      "During rebase/merge conflict resolution, still use `git add`"
    )
  })
})
