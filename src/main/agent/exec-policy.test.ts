import { describe, expect, it } from "vitest"
import {
  assessCommandSafety,
  extractGitCommitMessage,
  isChainedShellCommand,
  isForcePushCommand,
  isGitCommitCommand
} from "./exec-policy"

const CWD = "C:/repo"

describe("git submit commands are no longer forbidden", () => {
  it("git commit is not forbidden (handled by the task-card dialog instead)", () => {
    const result = assessCommandSafety('git commit -m "msg"', CWD)
    expect(result.level).not.toBe("forbidden")
  })

  it("git push is allowed through the normal approval flow", () => {
    expect(assessCommandSafety("git push", CWD).level).not.toBe("forbidden")
  })

  it("git merge is allowed through the normal approval flow", () => {
    expect(assessCommandSafety("git merge feature", CWD).level).not.toBe("forbidden")
  })

  it("force push remains gated as needs_approval (dangerous indicator)", () => {
    expect(assessCommandSafety("git push --force", CWD).level).toBe("needs_approval")
  })
})

describe("isGitCommitCommand", () => {
  it("detects a plain commit", () => {
    expect(isGitCommitCommand('git commit -m "x"')).toBe(true)
  })

  it("detects a commit with leading global options", () => {
    expect(isGitCommitCommand('git -C C:/repo commit -m "x"')).toBe(true)
    expect(isGitCommitCommand("git -c user.name=bot commit")).toBe(true)
  })

  it("does not match non-commit git commands", () => {
    expect(isGitCommitCommand("git status")).toBe(false)
    expect(isGitCommitCommand("git log --oneline")).toBe(false)
    expect(isGitCommitCommand("git push")).toBe(false)
  })

  it("does not match look-alikes or quoted occurrences", () => {
    expect(isGitCommitCommand("git commit-tree abc123")).toBe(false)
    expect(isGitCommitCommand('echo "remember to git commit"')).toBe(false)
    expect(isGitCommitCommand("git log --grep=commit")).toBe(false)
  })

  it("still detects a commit chained with other commands (so it can be refused)", () => {
    expect(isGitCommitCommand('git add -A && git commit -m "x"')).toBe(true)
  })
})

describe("isChainedShellCommand", () => {
  it("detects shell chaining outside quotes", () => {
    expect(isChainedShellCommand('git commit -m "x" && git push')).toBe(true)
    expect(isChainedShellCommand("git add -A; git commit")).toBe(true)
    expect(isChainedShellCommand("git status | grep foo")).toBe(true)
  })

  it("does not treat operators inside a quoted message as chaining", () => {
    expect(isChainedShellCommand('git commit -m "fix a && b"')).toBe(false)
    expect(isChainedShellCommand('git commit -m "x"')).toBe(false)
  })
})

describe("isForcePushCommand", () => {
  it("detects force pushes in any flag position", () => {
    expect(isForcePushCommand("git push --force")).toBe(true)
    expect(isForcePushCommand("git push origin main --force")).toBe(true)
    expect(isForcePushCommand("git push -f origin main")).toBe(true)
    expect(isForcePushCommand("git push --force-with-lease")).toBe(true)
  })

  it("does not flag a normal push or a commit mentioning force", () => {
    expect(isForcePushCommand("git push")).toBe(false)
    expect(isForcePushCommand("git push origin main")).toBe(false)
    expect(isForcePushCommand('git commit -m "push --force later"')).toBe(false)
  })
})

describe("extractGitCommitMessage", () => {
  it("reads -m with a quoted message", () => {
    expect(extractGitCommitMessage('git commit -m "fix the bug"')).toBe("fix the bug")
  })

  it("reads --message=value form", () => {
    expect(extractGitCommitMessage("git commit --message=quickfix")).toBe("quickfix")
  })

  it("reads the -mvalue attached form", () => {
    expect(extractGitCommitMessage("git commit -mquickfix")).toBe("quickfix")
  })

  it("returns undefined when no message arg is present", () => {
    expect(extractGitCommitMessage("git commit")).toBeUndefined()
  })
})
