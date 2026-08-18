import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  assessCommandSafety,
  extractGitCommitMessage,
  extractGitCommitPathspecs,
  getWorktreeShellIsolationViolation,
  isAmendOrFixupCommit,
  isChainedShellCommand,
  isForcePushCommand,
  isGitCommitCommand,
  isSimpleIsolatedGitCommitCommand,
  isWholeScopeGitAddCommand,
  normalizeCdPrefixedGitCommitCommand,
  normalizeGitAddPrefixedGitCommitCommand,
  resolveGitCommandCwd,
  resolveGitPushCommandCwd
} from "./exec-policy"
import type { WorkflowWorktreeIsolationBoundary } from "./workflow/types"

const CWD = "C:/repo"

const WORKTREE_ROOT = path.resolve("/managed/repo/agent-a")
const SOURCE_ROOT = path.resolve("/source")
const WORKTREE_BOUNDARY: WorkflowWorktreeIsolationBoundary = {
  workspaceRoot: WORKTREE_ROOT,
  worktreeRoot: WORKTREE_ROOT,
  commonDir: path.resolve("/source/.git"),
  branch: "cmbcowork/wf/run/agent-a"
}

describe("isolated Git broker grammar", () => {
  it("accepts only whole-scope staging forms", () => {
    for (const command of ["git add -A", "git add --all"]) {
      expect(isWholeScopeGitAddCommand(command)).toBe(true)
    }
    for (const command of [
      "git add .",
      "git add -- .",
      "git add src/a.ts",
      "git add -u",
      "git -C src add -A"
    ]) {
      expect(isWholeScopeGitAddCommand(command)).toBe(false)
    }
  })

  it("accepts one explicit message and rejects semantic rewrites", () => {
    for (const command of [
      'git commit -m "isolated work"',
      "git commit --message=isolated",
      "git commit -misolated"
    ]) {
      expect(isSimpleIsolatedGitCommitCommand(command)).toBe(true)
    }
    for (const command of [
      "git commit --amend -m x",
      "git commit --fixup HEAD -m x",
      "git commit -m x -- src/a.ts",
      "git commit -am x",
      "git commit -m one -m two",
      "git -C src commit -m x",
      "git commit -m x && git status"
    ]) {
      expect(isSimpleIsolatedGitCommitCommand(command)).toBe(false)
    }
  })
})

describe("dynamic-workflow worktree shell isolation", () => {
  it("allows normal checkout-local development and Git operations", () => {
    for (const command of [
      "npm test",
      "git status --short",
      "git add src/app.ts",
      'git commit -m "work"',
      "git -C src status",
      "git -c core.fsmonitor=false status",
      "git config --get user.name",
      "git checkout HEAD -- src/app.ts",
      "git checkout .",
      "git checkout ./src/app.ts",
      "echo $(git rev-parse --short HEAD)",
      "pushd src && popd",
      "git tag --list 'v*'",
      "git tag --contains HEAD",
      "git tag --merged HEAD",
      "git tag --points-at HEAD",
      "git tag --format '%(refname:short)' --list",
      "git tag --list --sort version:refname",
      "git reflog",
      "git stash list",
      "git submodule status",
      "git lfs ls-files",
      "git worktree list",
      "git -c color.ui=false status",
      "git apply change.patch",
      "git fetch origin",
      "git pull --ff-only",
      "git merge --abort",
      "git merge --continue",
      "git merge --quit",
      "git rebase --abort",
      "git rebase --continue",
      "git rebase --quit",
      "git rebase --skip",
      "git rebase --edit-todo",
      "git rebase --show-current-patch",
      "git cherry-pick --continue",
      "git revert --continue",
      "git update-index --refresh",
      "git hash-object -w src/app.ts",
      "git branch scratch",
      "git tag new-tag",
      "git branch --list 'feature/*'",
      "git branch --contains HEAD",
      "git branch --merged HEAD",
      "git branch --format '%(refname:short)' --list",
      "git symbolic-ref --short HEAD",
      "git symbolic-ref --no-recurse HEAD",
      "git hash-object README.md",
      "git notes show",
      "git notes --ref=commits show HEAD",
      "git bisect log",
      "git rerere status",
      "git commit-graph verify",
      "git commit-graph --object-dir .git/objects verify",
      "git multi-pack-index verify",
      "git multi-pack-index --object-dir=.git/objects verify",
      "git replace -l",
      "git replace -l 'refs/*'",
      "git config --get user.name",
      "git config --local user.name",
      "git config list",
      "git remote",
      "git remote -v",
      "git remote get-url origin",
      "git remote show origin",
      "echo GIT_DIR=/example",
      "rg GIT_WORK_TREE= src",
      `node -e "console.log('GIT_CONFIG_COUNT=2')"`,
      "printf %s GIT_INDEX_FILE=/docs/example",
      "env -u GIT_DIR git status",
      "test -f .git",
      `cat ${path.join(SOURCE_ROOT, "README.md")}`
    ]) {
      expect(
        getWorktreeShellIsolationViolation(command, WORKTREE_ROOT, WORKTREE_BOUNDARY)
      ).toBeNull()
    }
  })

  it("blocks cwd escapes, Git redirection, branch switching, and shared metadata writes", () => {
    const blocked = [
      "cd ../agent-b && touch escaped.txt",
      "git -C ../agent-b status",
      "git --git-dir=/source/.git status",
      "git -c core.worktree=/source status",
      "GIT_DIR=/source/.git GIT_WORK_TREE=/source git branch sneaky-source-branch",
      "GIT_COMMON_DIR=/source/.git git branch sneaky-source-branch",
      "env GIT_DIR=/source/.git git status",
      "export GIT_DIR=/source/.git && git status",
      "GIT_WORK_TREE=/source && git status",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=/source git status",
      "git branch -f another HEAD",
      "git branch -D another",
      "git tag -f existing-tag HEAD",
      "git tag -d existing-tag",
      "git switch main",
      "git checkout main",
      "git update-ref refs/heads/main HEAD",
      "git reflog expire --expire=now --all",
      "git reflog --all expire --expire=now",
      "git reflog delete HEAD@{0}",
      "git gc --prune=now",
      "git pack-refs --all --prune",
      "git maintenance run --auto",
      "git merge --no-ff dependency",
      "git rebase main",
      "git merge --autostash main",
      "git rebase --update-refs main",
      "git stash push",
      "git config user.name evil",
      "git config --local user.name evil",
      "git config set user.name evil",
      "git remote add x https://example.invalid/repo.git",
      "git remote -v add x https://example.invalid/repo.git",
      "git remote set-url origin https://example.invalid/repo.git",
      "git remote --verbose set-url origin https://example.invalid/repo.git",
      "git remote remove origin"
    ]
    for (const command of blocked) {
      expect(
        getWorktreeShellIsolationViolation(command, WORKTREE_ROOT, WORKTREE_BOUNDARY),
        command
      ).not.toBeNull()
    }
  })

  it("allows ordinary absolute-path reads because worktree mode is not a security sandbox", () => {
    expect(
      getWorktreeShellIsolationViolation(
        `cat ${path.join(SOURCE_ROOT, "README.md")}`,
        WORKTREE_ROOT,
        WORKTREE_BOUNDARY
      )
    ).toBeNull()
  })

  it("keeps a monorepo-scoped agent inside its assigned repository subdirectory", () => {
    const scopedRoot = path.join(WORKTREE_ROOT, "packages", "assigned")
    const scopedBoundary = { ...WORKTREE_BOUNDARY, workspaceRoot: scopedRoot }
    expect(
      getWorktreeShellIsolationViolation("touch local.ts", scopedRoot, scopedBoundary)
    ).toBeNull()
    expect(
      getWorktreeShellIsolationViolation(
        "cd ../sibling && touch escaped.ts",
        scopedRoot,
        scopedBoundary
      )
    ).toMatch(/outside the assigned workspace/i)
  })

  it("rejects symlinked cd and git -C escapes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cmb-worktree-guard-"))
    try {
      const worktree = path.join(root, "worktree")
      const outside = path.join(root, "outside")
      mkdirSync(worktree)
      mkdirSync(outside)
      symlinkSync(outside, path.join(worktree, "escape"), "dir")
      const boundary = { ...WORKTREE_BOUNDARY, workspaceRoot: worktree, worktreeRoot: worktree }

      expect(getWorktreeShellIsolationViolation("cd escape && pwd", worktree, boundary)).toMatch(
        /outside the assigned workspace/i
      )
      expect(
        getWorktreeShellIsolationViolation("git -C escape rev-parse --show-toplevel", worktree, boundary)
      ).toMatch(/outside the assigned workspace/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("allows an enabled skill cwd without weakening source-checkout protection", () => {
    const skillRoot = path.join(path.dirname(WORKTREE_ROOT), "enabled-skills", "demo")
    expect(
      getWorktreeShellIsolationViolation("node scripts/run.js", skillRoot, WORKTREE_BOUNDARY, [
        skillRoot
      ])
    ).toBeNull()
    expect(
      getWorktreeShellIsolationViolation("git -C . status", skillRoot, WORKTREE_BOUNDARY, [
        skillRoot
      ])
    ).toBeNull()
    expect(
      getWorktreeShellIsolationViolation(
        `cd ${SOURCE_ROOT} && touch escaped.txt`,
        skillRoot,
        WORKTREE_BOUNDARY,
        [skillRoot]
      )
    ).toMatch(/outside the assigned workspace or enabled skill/i)
    expect(
      getWorktreeShellIsolationViolation(
        `git -C ${SOURCE_ROOT} status`,
        skillRoot,
        WORKTREE_BOUNDARY,
        [skillRoot]
      )
    ).toMatch(/outside the assigned workspace or enabled skill/i)
  })

  it("does not confuse a legal ..-prefixed name with a parent-directory escape", () => {
    expect(
      getWorktreeShellIsolationViolation(
        "npm test",
        path.join(WORKTREE_ROOT, "..local"),
        WORKTREE_BOUNDARY
      )
    ).toBeNull()
  })
})

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

  it("forbids wrapped git commits because they cannot use the task-card dialog", () => {
    expect(assessCommandSafety("bash -c 'git commit -m x'", CWD).level).toBe("forbidden")
    expect(assessCommandSafety("sh -c 'cd src && git commit -m x'", CWD).level).toBe("forbidden")
    expect(assessCommandSafety("pwsh -c 'git commit -m x'", CWD).level).toBe("forbidden")
    expect(assessCommandSafety("powershell -Command 'git commit -m x'", CWD).level).toBe(
      "forbidden"
    )
    expect(assessCommandSafety("cmd /c git commit -m x", CWD).level).toBe("forbidden")
  })

  it("does not forbid wrapped text that only mentions git commit", () => {
    expect(assessCommandSafety("bash -c 'echo git commit'", CWD).level).not.toBe("forbidden")
  })

  it("still forbids short-option clusters carrying -c", () => {
    expect(assessCommandSafety("bash -lc 'git commit -m x'", CWD).level).toBe("forbidden")
    expect(assessCommandSafety("bash -xc 'git commit -m x'", CWD).level).toBe("forbidden")
  })

  it("does not treat a long option merely containing the letter c as -c", () => {
    // `--check` / `--norc` are not `-c`; the script-bearing arg is absent, so nothing wrapped.
    expect(assessCommandSafety("bash --check 'git commit -m x'", CWD).level).not.toBe("forbidden")
    expect(assessCommandSafety("bash --norc 'git status'", CWD).level).not.toBe("forbidden")
  })
})

describe("isGitCommitCommand", () => {
  it("detects a plain commit", () => {
    expect(isGitCommitCommand('git commit -m "x"')).toBe(true)
  })

  it("detects a commit with leading global options", () => {
    expect(isGitCommitCommand('git -C C:/repo commit -m "x"')).toBe(true)
    expect(isGitCommitCommand('git -C "C:/repo with spaces" commit -m "x"')).toBe(true)
    expect(isGitCommitCommand("git -c user.name=bot commit")).toBe(true)
  })

  it("detects commits wrapped by environment prefixes", () => {
    expect(isGitCommitCommand('GIT_AUTHOR_NAME=bot git commit -m "x"')).toBe(true)
    expect(isGitCommitCommand('env GIT_AUTHOR_NAME=bot git commit -m "x"')).toBe(true)
    expect(isGitCommitCommand('env -- git commit -m "x"')).toBe(true)
    expect(isGitCommitCommand('command git commit -m "x"')).toBe(true)
  })

  it("does not match non-commit git commands", () => {
    expect(isGitCommitCommand("git status")).toBe(false)
    expect(isGitCommitCommand("git log --oneline")).toBe(false)
    expect(isGitCommitCommand("git push")).toBe(false)
  })

  it("does not match look-alikes or quoted occurrences", () => {
    expect(isGitCommitCommand("git commit-tree abc123")).toBe(false)
    expect(isGitCommitCommand('echo "remember to git commit"')).toBe(false)
    expect(isGitCommitCommand("echo git commit")).toBe(false)
    expect(isGitCommitCommand("printf git commit")).toBe(false)
    expect(isGitCommitCommand("bash -c 'git commit -m x'")).toBe(false)
    expect(isGitCommitCommand("git log --grep=commit")).toBe(false)
  })

  it("still detects a commit chained with other commands (so it can be refused)", () => {
    expect(isGitCommitCommand('git add -A && git commit -m "x"')).toBe(true)
  })
})

describe("resolveGitPushCommandCwd", () => {
  it("applies git -C to push commands", () => {
    expect(resolveGitPushCommandCwd("git -C child push", CWD)).toBe(path.resolve(CWD, "child"))
  })

  it("does not reuse commit-only cwd parsing for push", () => {
    expect(resolveGitPushCommandCwd("git push", CWD)).toBe(CWD)
  })
})

describe("isChainedShellCommand", () => {
  it("detects shell chaining outside quotes", () => {
    expect(isChainedShellCommand('git commit -m "x" && git push')).toBe(true)
    expect(isChainedShellCommand("git add -A; git commit")).toBe(true)
    expect(isChainedShellCommand('git commit -m "x"\ngit push')).toBe(true)
    expect(isChainedShellCommand("git status | grep foo")).toBe(true)
  })

  it("does not treat operators inside a quoted message as chaining", () => {
    expect(isChainedShellCommand('git commit -m "fix a && b"')).toBe(false)
    expect(isChainedShellCommand('git commit -m "x"')).toBe(false)
  })
})

describe("normalizeCdPrefixedGitCommitCommand", () => {
  it("allows a cd prefix before a standalone git commit", () => {
    expect(normalizeCdPrefixedGitCommitCommand("cd src && git commit -m x", CWD)).toEqual({
      command: "git commit -m x",
      cwd: path.resolve(CWD, "src")
    })
  })

  it("normalizes Git Bash drive paths on Windows", () => {
    const result = normalizeCdPrefixedGitCommitCommand(
      'cd /c/ai/CmbCoworkAgent && git commit -m "x"',
      CWD
    )
    expect(result?.command).toBe('git commit -m "x"')
    expect(result?.cwd).toBe(
      process.platform === "win32"
        ? path.resolve("C:/ai/CmbCoworkAgent")
        : path.resolve("/c/ai/CmbCoworkAgent")
    )
  })

  it("does not allow non-cd commands or trailing commands around the commit", () => {
    expect(normalizeCdPrefixedGitCommitCommand("git add -A && git commit -m x", CWD)).toBeNull()
    expect(normalizeCdPrefixedGitCommitCommand("git commit -m x && git push", CWD)).toBeNull()
    expect(
      normalizeCdPrefixedGitCommitCommand("cd src && git commit -m x && git push", CWD)
    ).toBeNull()
  })
})

describe("normalizeGitAddPrefixedGitCommitCommand", () => {
  it("turns explicit git add pathspecs into preselected commit files", () => {
    expect(
      normalizeGitAddPrefixedGitCommitCommand(
        'git -C /c/ai/CmbCoworkAgent add src/main/agent/failover.ts && git -C /c/ai/CmbCoworkAgent commit -m "x"',
        CWD
      )
    ).toEqual({
      command: 'git -C /c/ai/CmbCoworkAgent commit -m "x"',
      cwd:
        process.platform === "win32"
          ? path.resolve("C:/ai/CmbCoworkAgent")
          : path.resolve(CWD, "/c/ai/CmbCoworkAgent"),
      filePaths: ["src/main/agent/failover.ts"]
    })
  })

  it("allows cd before explicit git add and commit", () => {
    expect(
      normalizeGitAddPrefixedGitCommitCommand(
        'cd /c/ai/CmbCoworkAgent && git add -- src/main/agent/failover.ts && git commit -m "x"',
        CWD
      )
    ).toEqual({
      command: 'git commit -m "x"',
      cwd:
        process.platform === "win32"
          ? path.resolve("C:/ai/CmbCoworkAgent")
          : path.resolve("/c/ai/CmbCoworkAgent"),
      filePaths: ["src/main/agent/failover.ts"]
    })
  })

  it("rejects broad git add or trailing commands", () => {
    expect(normalizeGitAddPrefixedGitCommitCommand("git add -A && git commit -m x", CWD)).toBeNull()
    expect(
      normalizeGitAddPrefixedGitCommitCommand(
        "git add src/a.ts && git commit -m x && git push",
        CWD
      )
    ).toBeNull()
  })

  it("rejects an add chain whose pathspecs span different directories", () => {
    // `a.ts` is relative to CWD but `b.ts` to CWD/sub — a single basePath cannot represent
    // both, so the chain must be refused rather than mis-resolving `a.ts` under `sub`.
    expect(
      normalizeGitAddPrefixedGitCommitCommand(
        "git add a.ts && cd sub && git add b.ts && git commit -m x",
        CWD
      )
    ).toBeNull()
  })

  it("still allows a single-directory add chain (adds and commit share one base)", () => {
    expect(
      normalizeGitAddPrefixedGitCommitCommand(
        "git add a.ts && git add b.ts && git commit -m x",
        CWD
      )
    ).toEqual({
      command: "git commit -m x",
      cwd: CWD,
      filePaths: ["a.ts", "b.ts"]
    })
  })
})

describe("isForcePushCommand", () => {
  it("detects force pushes in any flag position", () => {
    expect(isForcePushCommand("git push --force")).toBe(true)
    expect(isForcePushCommand("git push origin main --force")).toBe(true)
    expect(isForcePushCommand("git push -f origin main")).toBe(true)
    expect(isForcePushCommand("git -C C:/repo push --force")).toBe(true)
    expect(isForcePushCommand('git -C "C:/repo with spaces" push --force')).toBe(true)
    expect(isForcePushCommand("env GIT_SSH_COMMAND=ssh git push --force")).toBe(true)
    expect(isForcePushCommand("git push --force-with-lease")).toBe(true)
  })

  it("does not flag a normal push or a commit mentioning force", () => {
    expect(isForcePushCommand("git push")).toBe(false)
    expect(isForcePushCommand("git push origin main")).toBe(false)
    expect(isForcePushCommand('git commit -m "push --force later"')).toBe(false)
    expect(isForcePushCommand("echo git push --force")).toBe(false)
  })

  it("detects force-with-lease values", () => {
    expect(isForcePushCommand("git push --force-with-lease=refs/heads/main")).toBe(true)
  })
})

describe("extractGitCommitPathspecs", () => {
  it("reads pathspecs after --", () => {
    expect(extractGitCommitPathspecs('git commit -m "x" -- src/a.ts src/b.ts')).toEqual([
      "src/a.ts",
      "src/b.ts"
    ])
    expect(extractGitCommitPathspecs('GIT_AUTHOR_NAME=bot git commit -m "x" -- src/a.ts')).toEqual([
      "src/a.ts"
    ])
  })

  it("reads pathspecs without -- while skipping message args", () => {
    expect(extractGitCommitPathspecs('git commit src/a.ts -m "x" src/b.ts')).toEqual([
      "src/a.ts",
      "src/b.ts"
    ])
  })

  it("does not treat combined -am messages as file paths", () => {
    expect(extractGitCommitPathspecs('git commit -am "stage and commit"')).toEqual([])
    expect(extractGitCommitPathspecs("git commit -amquickfix")).toEqual([])
  })

  it("does not treat template options as file paths", () => {
    expect(extractGitCommitPathspecs("git commit -t template.txt -m x -- src/a.ts")).toEqual([
      "src/a.ts"
    ])
    expect(
      extractGitCommitPathspecs("git commit --template template.txt -m x -- src/a.ts")
    ).toEqual(["src/a.ts"])
    expect(
      extractGitCommitPathspecs("git commit --template=template.txt -m x -- src/a.ts")
    ).toEqual(["src/a.ts"])
  })

  it("returns an empty selection when no pathspec is present", () => {
    expect(extractGitCommitPathspecs('git commit -m "x"')).toEqual([])
  })
})

describe("resolveGitCommandCwd", () => {
  it("applies git -C before commit pathspecs are interpreted", () => {
    expect(resolveGitCommandCwd("git -C src commit -m x -- a.ts", CWD)).toBe(
      path.resolve(CWD, "src")
    )
    expect(resolveGitCommandCwd("env FOO=bar git -C src commit -m x -- a.ts", CWD)).toBe(
      path.resolve(CWD, "src")
    )
    expect(resolveGitCommandCwd("git -C /c/ai/CmbCoworkAgent commit -m x", CWD)).toBe(
      process.platform === "win32"
        ? path.resolve("C:/ai/CmbCoworkAgent")
        : path.resolve(CWD, "/c/ai/CmbCoworkAgent")
    )
    expect(resolveGitCommandCwd('git -C "repo\\\\with spaces" commit -m x', CWD)).toBe(
      path.resolve(CWD, "repo\\with spaces")
    )
    expect(resolveGitCommandCwd("git -C src -C nested commit -m x -- a.ts", CWD)).toBe(
      path.resolve(CWD, "src", "nested")
    )
  })

  it("leaves commit -C reuse-message alone because it is not a global cwd option", () => {
    expect(resolveGitCommandCwd("git commit -C HEAD -- src/a.ts", CWD)).toBe(CWD)
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

  it("reads the combined -am short cluster", () => {
    expect(extractGitCommitMessage('git commit -am "stage and commit"')).toBe("stage and commit")
    expect(extractGitCommitMessage("git commit -amquickfix")).toBe("quickfix")
  })

  it("returns undefined when no message arg is present", () => {
    expect(extractGitCommitMessage("git commit")).toBeUndefined()
    expect(extractGitCommitMessage("git commit --amend")).toBeUndefined()
  })
})

describe("isAmendOrFixupCommit", () => {
  it("detects amend/fixup/squash commits", () => {
    expect(isAmendOrFixupCommit("git commit --amend")).toBe(true)
    expect(isAmendOrFixupCommit('git commit --amend -m "x"')).toBe(true)
    expect(isAmendOrFixupCommit("git commit --fixup=HEAD~1")).toBe(true)
    expect(isAmendOrFixupCommit("git commit --squash abc123")).toBe(true)
  })

  it("does not flag a normal commit or a quoted mention", () => {
    expect(isAmendOrFixupCommit('git commit -m "x"')).toBe(false)
    expect(isAmendOrFixupCommit('git commit -m "do not --amend here"')).toBe(false)
    expect(isAmendOrFixupCommit("git status")).toBe(false)
  })

  it("does not treat an unquoted --amend that is a value of -m/--message as an amend", () => {
    // `--amend` here is the commit message value, not an option.
    expect(isAmendOrFixupCommit("git commit -m --amend")).toBe(false)
    expect(isAmendOrFixupCommit("git commit --message --amend")).toBe(false)
    expect(isAmendOrFixupCommit("git commit -F --squash")).toBe(false)
  })

  it("still detects amend after value-bearing options", () => {
    expect(isAmendOrFixupCommit('git commit -m "x" --amend')).toBe(true)
    expect(isAmendOrFixupCommit("git -C src commit --amend")).toBe(true)
  })
})
