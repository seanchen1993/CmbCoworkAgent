import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assessCommandSafety, isGitCommitCommand, isGitPushCommand } from "./exec-policy"
import { isReadOnlyPosixForLoop } from "./posix-read-only-loop"

const originalCommand =
  "cd /Users/chenqiang/Desktop/projects/CmbCoworkAgent && " +
  "for c in bfcc10f71 00c5d1042 80dcf9aea f9b53558b 0fc983576 df2ed1ee3 " +
  "8dd7677e2 7e08e47a0 91554cbc7 b22bff091 7d97a7fdf 650c6ba30 c0a995254; " +
  'do echo "##### $c $(git log -1 --format=%s $c)"; ' +
  'git show --stat --format="  author=%an date=%ad" $c | head -60; ' +
  "echo; done 2>&1 | head -400"

const review = (command: string) =>
  assessCommandSafety(command, "C:/repo", { shellSyntax: "posix" })

describe("bounded read-only POSIX for loops", () => {
  it.each([
    originalCommand,
    "for c in HEAD main; do git show --stat $c; done",
    'for commit in HEAD HEAD~1; do git --no-pager log -n 1 --format="%h %s" "$commit"; done',
    'for rev in HEAD; do printf "%s\\n" "${rev}: $(git show -s --format=%s "$rev")"; done',
    'for c in HEAD; do echo "$(echo "$(git log -1 --format=%s "$c")")"; done',
    'for c in HEAD; do git diff -- "$c" | head -n 20; done',
    'for c in HEAD; do echo "git commit -m sample; git add -f .env; git push"; done',
    "for c in HEAD\ndo\n# Git mutation text in a comment: git add -f .env\ngit show $c\ndone",
    "for c in HEAD; do gi\\\nt show $c; done",
    "for c in HEAD; do g'it' show $c; done",
    "for c in HEAD; do printf \"%s\\n\" 'a[$(git add -f .env)]'; done",
    "for c in HEAD; do git show $c; done; echo completed",
    "for c in HEAD; do git status --short; done && for rev in main; do git show $rev; done"
  ])("reviews the complete read-only script: %s", (command) => {
    expect(isReadOnlyPosixForLoop(command)).toBe(true)
    expect(review(command)).toMatchObject({
      level: "needs_approval",
      reason: "read-only POSIX loop — requires review"
    })
    expect(isGitCommitCommand(command, "posix")).toBe(false)
    expect(isGitPushCommand(command, "posix")).toBe(false)
    expect(
      assessCommandSafety(command, "C:/repo", {
        shellSyntax: "posix",
        enforceGitWorkflowCommitOnly: true
      }).level
    ).toBe("needs_approval")
  })

  it.each([
    "for c in HEAD; do git add -f .env; done",
    "for c in HEAD; do git stage --force .env; done",
    "for c in HEAD; do git add -Af .env; done",
    'for c in HEAD; do echo "$(git add -f .env)"; done',
    'for c in HEAD; do echo "$(git log -1 $c; git add -f .env)"; done',
    'for c in HEAD; do echo "$(git log -1 $c && git stage --force .env)"; done',
    'for c in HEAD; do echo "$(echo "$(git add -f .env)")"; done',
    "for c in $(git add -f .env); do git show $c; done",
    'for ((c=0; c<1; c++)); do bash -c "git add -f .env"; done',
    'if true; then for c in HEAD; do bash -c "git add -f .env"; done; fi',
    'f(){ for c in HEAD; do bash -c "git add -f .env"; done; }; f',
    'for c; do bash -c "git add -f .env"; done',
    "for c in add; do git $c -f .env; done",
    "for c in HEAD; do $BIN add -f .env; done",
    "git add -f .env; for c in HEAD; do git show $c; done",
    "for c in HEAD; do git show $c; done; git add -f .env",
    "for c in HEAD; do git show $c; done | git add -f .env",
    "for c in HEAD; do git update-index --add .env; done",
    "for c in HEAD; do git commit -m example -- a.ts; done",
    'for c in HEAD; do bash -c "git add -f .env"; done',
    "sh -c 'for c in HEAD; do bash -c \"git add -f .env\"; done'",
    "for c in HEAD; do echo `git add -f .env`; done",
    'for c in HEAD; do echo "${c:-$(git add -f .env)}"; done',
    "for c in HEAD; do printf -v c -- --ext-diff; git show $c; done",
    "for c in HEAD; do git show --ext-diff $c; done",
    "for c in HEAD; do git show --pretty --ext-diff $c; done",
    "for c in HEAD; do git log --format --output=output.txt $c; done",
    "for c in HEAD; do git show --date --textconv $c; done",
    "for c in HEAD; do git log -n --output=output.txt $c; done",
    "for c in HEAD; do git log --output=output.txt $c; done",
    "for c in HEAD; do git show --textconv $c; done",
    'for c in HEAD; do git -c core.pager="git add -f .env" log $c; done',
    'for c in HEAD; do echo "$(git log -1 $c)"; done; eval "$RUN" add -f .env',
    "for c in HEAD; do git show $c; # comment\n git add -f .env; done"
  ])("preserves rejection of mutations and opaque Git execution: %s", (command) => {
    expect(isReadOnlyPosixForLoop(command)).toBe(false)
    expect(review(command).level).toBe("forbidden")
  })

  it.each([
    "git add -f .env",
    "git stage --force .env",
    "git update-index --add .env",
    "git log -1 HEAD; git add -f .env"
  ])("does not trust a mutation substituted into the original query: %s", (mutation) => {
    const command = originalCommand.replace("git log -1 --format=%s $c", mutation)
    expect(isReadOnlyPosixForLoop(command)).toBe(false)
    expect(review(command).level).toBe("forbidden")
  })

  it.each([
    "git log -1 HEAD",
    "for c in HEAD; do git\r log $c; done",
    "for c in HEAD; do touch output.txt; done",
    "for c in HEAD; do git show $c > output.txt; done",
    "for c in HEAD; do git show $c & done",
    "for c in HEAD; do git show $c; done >output.txt",
    "for PATH in tmp; do git show HEAD; done",
    "for IFS in x; do git show HEAD; done",
    "for path in tmp; do git show HEAD; done",
    "for c in --ext-diff; do git show $c; done",
    "for c in $COMMITS; do git show $c; done",
    "for c in *; do git show $c; done",
    "for c in HEAD; do git show $other; done",
    "for c in HEAD; do git show $c; done; git show $c",
    "for c in HEAD; do for rev in main; do git show $rev; done; done",
    'for c in HEAD; do printf "%n" PATH; done',
    'for c in HEAD; do printf "%d" "a[$(git add -f .env)]"; done',
    "for c in HEAD; do git status $(git log -1 $c); done",
    'for c in HEAD; do echo "$(git log -1 $c)"; done; sh fixture.sh',
    "for c in; do git show $c; done",
    "for c in HEAD; do done",
    "for c in HEAD; do git show $c",
    'for c in HEAD; do echo "$(git show $c"; done',
    'for c in HEAD; do echo "$(git show $c)"; done )',
    `for c in ${"HEAD ".repeat(257)}; do git show $c; done`,
    `for c in HEAD; do echo '${"x".repeat(16_384)}'; done`
  ])("does not broaden the recognized grammar: %s", (command) => {
    expect(isReadOnlyPosixForLoop(command)).toBe(false)
  })

  it.each(["powershell", "cmd"] as const)("does not apply POSIX parsing to %s", (shellSyntax) => {
    expect(assessCommandSafety(originalCommand, "C:/repo", { shellSyntax }).level).toBe("forbidden")
  })

  it("executes the recognized query structure against real Git without staging ignored files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "readonly-for-loop-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    try {
      git("init", "-q")
      git("config", "user.name", "Read-only fixture")
      git("config", "user.email", "readonly@example.invalid")
      writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n")
      writeFileSync(path.join(root, "sample.txt"), "fixture\n")
      git("add", "--", ".gitignore", "sample.txt")
      git("commit", "-qm", "Read-only fixture")
      writeFileSync(path.join(root, "ignored.txt"), "not a credential\n")
      const command = originalCommand.replace(/^cd .*? && for c in .*?;/, "for c in HEAD HEAD;")
      expect(review(command).level).toBe("needs_approval")
      const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash"
      const output = execFileSync(bash, ["--noprofile", "--norc", "-c", command], {
        cwd: root,
        encoding: "utf8"
      })
      expect(output).toContain("Read-only fixture")
      expect(output).toContain("author=Read-only fixture")
      expect(git("status", "--porcelain")).toBe("")
      expect(git("ls-files", "--", "ignored.txt")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
