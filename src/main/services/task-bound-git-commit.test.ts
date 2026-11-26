import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  captureEligibleTaskCommitPreview,
  captureTaskCommitPreviewTree,
  executeTaskBoundGitCommit,
  recoverTaskBoundCommitIndex,
  type TaskCommitCandidate
} from "./task-bound-git-commit"
import { beginGitCheckoutWrite, prepareGitPanelWrite } from "./git-worktree-write-gate"

const temporary: string[] = []
let root: string
let beforeCommit: string
const file = (name: string): string => path.join(root, name)
const write = (name: string, content: string) => writeFileSync(file(name), content)
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  }).trimEnd()

function commit(
  filePaths: string[],
  overrides?: Partial<Parameters<typeof executeTaskBoundGitCommit>[0]>
) {
  return executeTaskBoundGitCommit({
    worktreePath: root,
    filePaths,
    message: "CARD-1 #comment fix: update #CMBDevClaw",
    revalidate: async () => true,
    ...overrides
  })
}

describe("task-bound Git commit", { timeout: 45_000 }, () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "task-bound-commit-test-")))
    temporary.push(root)
    git("init", "-q")
    git("symbolic-ref", "HEAD", "refs/heads/main")
    git("config", "user.name", "Commit Fixture")
    git("config", "user.email", "commit@example.test")
    git("config", "core.autocrlf", "false")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", ".git/hooks")
    mkdirSync(file("src"))
    write("src/file.txt", "before\n")
    write("other.txt", "original\n")
    write("remove.txt", "remove\n")
    git("add", ".")
    git("commit", "-qm", "initial")
    beforeCommit = git("rev-parse", "HEAD")
  })

  afterEach(() => {
    for (const directory of temporary.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it("publishes exactly the requested files and preserves unrelated partial stages", async () => {
    write("other.txt", "already staged\n")
    git("add", "other.txt")
    write("other.txt", "unrelated later edit\n")
    write("src/file.txt", "modified\n")
    write("new file.txt", "new\n")
    rmSync(file("remove.txt"))
    let recorded: TaskCommitCandidate | undefined
    const result = await commit(["src/file.txt", "new file.txt", "remove.txt"], {
      onPrepared: async (candidate) => {
        recorded = candidate
        expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
      }
    })
    expect(result).toMatchObject({
      status: "committed",
      branch: "refs/heads/main",
      files: ["new file.txt", "remove.txt", "src/file.txt"]
    })
    expect(recorded?.sha).toBe(git("rev-parse", "HEAD"))
    expect(git("show", "HEAD:src/file.txt")).toBe("modified")
    expect(git("show", ":other.txt")).toBe("already staged")
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "new file.txt\nremove.txt\nsrc/file.txt"
    )
    expect(git("status", "--short")).toBe("MM other.txt")
    expect(existsSync(file(".git/index.lock"))).toBe(false)
  })

  it("keeps a repository subdirectory as scope and commits both sides of a rename", async () => {
    git("mv", "src/file.txt", "src/moved.txt")
    const oneSide = await commit(["moved.txt"], { worktreePath: file("src") })
    expect(oneSide).toMatchObject({ status: "review" })
    const both = await commit(["file.txt", "moved.txt"], { worktreePath: file("src") })
    expect(both).toMatchObject({ status: "committed", files: ["src/file.txt", "src/moved.txt"] })
    expect(git("status", "--short")).toBe("")
  })

  it("returns review for partial stages, incomplete matches, directories and ignored files", async () => {
    write("src/file.txt", "staged\n")
    git("add", "src/file.txt")
    write("src/file.txt", "also unstaged\n")
    write(".gitignore", "secret.txt\n")
    write("secret.txt", "ignored\n")
    for (const selection of [
      ["src/file.txt"],
      ["src"],
      ["secret.txt"],
      [".gitignore", "missing"]
    ]) {
      expect(await commit(selection)).toMatchObject({ status: "review" })
    }
    for (const selection of [[], ["../outside"]]) {
      expect(await commit(selection)).toMatchObject({ status: "failed" })
    }
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("show", ":src/file.txt")).toBe("staged")
  })

  it("leaves the index and the branch intact when an editor changes the selected content", async () => {
    write("src/file.txt", "agent version\n")
    const oldIndex = readFileSync(file(".git/index"))
    expect(
      await commit(["src/file.txt"], {
        onPrepared: async () => write("src/file.txt", "human version\n")
      })
    ).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(readFileSync(file(".git/index"))).toEqual(oldIndex)
    expect(readFileSync(file("src/file.txt"), "utf8")).toBe("human version\n")
  })

  it("checks the original SHA and symbolic branch without moving an unexpected branch", async () => {
    write("src/file.txt", "request\n")
    const tree = git("rev-parse", "HEAD^{tree}")
    const competing = git("commit-tree", tree, "-p", beforeCommit, "-m", "concurrent")
    const result = await commit(["src/file.txt"], {
      onPrepared: async () => {
        git("update-ref", "refs/heads/main", competing, beforeCommit)
      }
    })
    expect(result).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(competing)
    git("branch", "elsewhere")
    const rebound = await commit(["src/file.txt"], {
      onPrepared: async () => {
        git("symbolic-ref", "HEAD", "refs/heads/elsewhere")
      }
    })
    expect(rebound).toMatchObject({ status: "review" })
    expect(git("rev-parse", "refs/heads/main")).toBe(competing)
    expect(git("rev-parse", "refs/heads/elsewhere")).toBe(competing)
  })

  it("runs pre/post-commit hooks, rejects a hook that changes the tree and respects signing", async () => {
    const hooks = file(".git/hooks")
    function hook(name: string, script: string) {
      const hookPath = path.join(hooks, name)
      writeFileSync(hookPath, "#!/bin/sh\n" + script + "\n")
      chmodSync(hookPath, 0o755)
    }
    write("src/file.txt", "change\n")
    hook("pre-commit", "echo hook > extra.txt\ngit add extra.txt")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("diff", "--cached", "--name-only")).toBe("")
    hook("pre-commit", "git diff --cached --name-only > pre-ran")
    hook("post-commit", "git rev-parse HEAD > post-ran")
    git("config", "commit.gpgsign", "true")
    git("config", "gpg.program", "missing-task-commit-test-signer")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    git("config", "commit.gpgsign", "false")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "committed" })
    expect(readFileSync(file("pre-ran"), "utf8").trim()).toBe("src/file.txt")
    expect(readFileSync(file("post-ran"), "utf8").trim()).toBe(git("rev-parse", "HEAD"))
  })

  it("rechecks the task binding under the prepared ref transaction", async () => {
    write("src/file.txt", "change\n")
    let valid = true
    const result = await commit(["src/file.txt"], {
      onPrepared: async () => {
        valid = false
      },
      revalidate: async () => valid
    })
    expect(result).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(existsSync(file(".git/HEAD.lock"))).toBe(false)
    expect(existsSync(file(".git/index.lock"))).toBe(false)
  })

  it("preserves another index writer's lock and rejects unsupported native commit states", async () => {
    write("src/file.txt", "agent\n")
    write(".git/index.lock", "other process")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    expect(readFileSync(file(".git/index.lock"), "utf8")).toBe("other process")
    rmSync(file(".git/index.lock"))
    write(".git/MERGE_HEAD", beforeCommit + "\n")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    rmSync(file(".git/MERGE_HEAD"))
    write(".git/hooks/reference-transaction", "#!/bin/sh\nexit 1\n")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
  })

  it("checks revocation synchronously immediately before the prepared Git transaction commits", async () => {
    write("src/file.txt", "agent content\n")
    let checks = 0
    const result = await commit(["src/file.txt"], {
      revalidate: async () => true,
      canPublish: () => {
        checks++
        return false
      }
    })
    expect(result).toMatchObject({
      status: "review",
      reason: expect.stringContaining("授权已变更")
    })
    expect(checks).toBe(1)
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("diff", "--cached", "--name-only")).toBe("")
  })

  it("uses the reviewed full file and native message hook order, preserving the confirmed tree and message", async () => {
    write("src/file.txt", "part already staged\n")
    git("add", "src/file.txt")
    write("src/file.txt", "full file explicitly reviewed\n")
    const hook = (name: string, contents: string) => {
      write(".git/hooks/" + name, "#!/bin/sh\n" + contents + "\n")
      chmodSync(file(".git/hooks/" + name), 0o755)
    }
    hook("pre-commit", "echo pre > .git/order")
    hook(
      "prepare-commit-msg",
      'test "$2" = message && grep -q "#CMBDevClaw" "$1" && echo prepare >> .git/order'
    )
    hook("commit-msg", 'echo changed >> "$1"')
    expect(await commit(["src/file.txt"], { reviewed: true })).toMatchObject({
      status: "review",
      reason: expect.stringContaining("修改了已确认")
    })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("show", ":src/file.txt")).toBe("part already staged")
    hook("commit-msg", 'grep -q "#CMBDevClaw" "$1" && echo validate >> .git/order')
    const preview = await captureTaskCommitPreviewTree(file("src"), ["file.txt"], beforeCommit)
    expect(
      await commit(["src/file.txt"], {
        reviewed: true,
        onPrepared: async (candidate) => {
          expect(candidate.tree).toBe(preview)
        }
      })
    ).toMatchObject({ status: "committed" })
    expect(readFileSync(file(".git/order"), "utf8").trim()).toBe("pre\nprepare\nvalidate")
    expect(git("show", "HEAD:src/file.txt")).toBe("full file explicitly reviewed")
  })

  it("captures the scoped Git preview without affecting the user index or running its hooks", async () => {
    write("src/file.txt", "previewed change\n")
    write("other.txt", "unrelated staged file\n")
    git("add", "other.txt")
    const oldIndex = readFileSync(file(".git/index"))
    const hook = file(".git/hooks/post-index-change")
    writeFileSync(hook, "#!/bin/sh\necho fired > .git/index-hook-fired\n")
    chmodSync(hook, 0o755)
    const tree = await captureTaskCommitPreviewTree(file("src"), ["file.txt"], beforeCommit)
    expect(git("diff-tree", "--name-only", "-r", beforeCommit, tree)).toBe("src/file.txt")
    expect(readFileSync(file(".git/index"))).toEqual(oldIndex)
    expect(existsSync(file(".git/index-hook-fired"))).toBe(false)
    expect(await captureTaskCommitPreviewTree(root, [], beforeCommit)).toBe(
      git("rev-parse", "HEAD^{tree}")
    )
    await expect(
      captureTaskCommitPreviewTree(file("src"), ["../other.txt"], beforeCommit)
    ).rejects.toThrow()
  })

  it("keeps ordinary preview files when status also contains AD, gitlinks, directories or staged-only reversions", async () => {
    git("update-index", "--add", "--cacheinfo", `160000,${beforeCommit},module`)
    git("commit", "-qm", "add gitlink")
    const parent = git("rev-parse", "HEAD")
    mkdirSync(file("nested"))
    git("-C", "nested", "init", "-q")
    write("added-then-deleted.txt", "only staged then removed\n")
    git("add", "added-then-deleted.txt")
    rmSync(file("added-then-deleted.txt"))
    write("other.txt", "only staged\n")
    git("add", "other.txt")
    write("other.txt", "original\n")
    write("src/file.txt", "eligible\n")
    const preview = await captureEligibleTaskCommitPreview(
      root,
      ["module", "nested/", "added-then-deleted.txt", "other.txt", "src/file.txt"],
      parent
    )
    expect(preview.files).toEqual(["src/file.txt"])
    expect(git("diff-tree", "--name-only", "-r", parent, preview.tree)).toBe("src/file.txt")
  })

  it("leaves the real index unlocked when the owning process dies in a pre-commit hook", async () => {
    write("src/file.txt", "pending\n")
    write(".git/hooks/pre-commit", "#!/bin/sh\nexec node .git/hooks/interrupt.cjs\n")
    chmodSync(file(".git/hooks/pre-commit"), 0o755)
    write(
      ".git/hooks/interrupt.cjs",
      [
        'const fs = require("node:fs")',
        'fs.writeFileSync(".git/hook-observed-lock", String(fs.existsSync(".git/index.lock")))',
        'setTimeout(() => process.kill(Number(process.env.TASK_TEST_OWNER_PID), "SIGKILL"), 150)'
      ].join("\n")
    )
    const service = path.join(__dirname, "task-bound-git-commit.ts")
    const child = [
      "process.env.TASK_TEST_OWNER_PID = String(process.pid)",
      "const {executeTaskBoundGitCommit} = require(process.env.TASK_TEST_SERVICE)",
      'executeTaskBoundGitCommit({worktreePath:process.env.TASK_TEST_REPO,filePaths:["src/file.txt"],',
      'message:"child commit",revalidate:async()=>true,onPrepared:async()=>{throw Error("unexpected")}})'
    ].join("\n")
    expect(() =>
      execFileSync(process.execPath, ["--import", "tsx", "-e", child], {
        cwd: process.cwd(),
        env: { ...process.env, TASK_TEST_SERVICE: service, TASK_TEST_REPO: root },
        timeout: 30_000,
        windowsHide: true,
        stdio: "pipe"
      })
    ).toThrow()
    expect(readFileSync(file(".git/hook-observed-lock"), "utf8")).toBe("false")
    expect(existsSync(file(".git/index.lock"))).toBe(false)
    write("other.txt", "owner can stage immediately\n")
    git("add", "other.txt")
    expect(git("show", ":other.txt")).toBe("owner can stage immediately")
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
  })

  it("detects native index changes before installing a persisted candidate's lock", async () => {
    write("src/file.txt", "agent\n")
    write("other.txt", "staged while the candidate is prepared\n")
    const result = await commit(["src/file.txt"], {
      onPrepared: async (candidate) => {
        expect(candidate.indexRecovery?.lockInode).toBeTruthy()
        expect(existsSync(file(".git/index.lock"))).toBe(false)
        git("add", "other.txt")
      }
    })
    expect(result).toMatchObject({ status: "review", reason: expect.stringContaining("暂存区") })
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("show", ":other.txt")).toBe("staged while the candidate is prepared")
    expect(existsSync(file(".git/index.lock"))).toBe(false)
    expect(
      await commit(["src/file.txt"], {
        onPrepared: async () => write(".git/index.lock", "foreign")
      })
    ).toMatchObject({ status: "review" })
    expect(readFileSync(file(".git/index.lock"), "utf8")).toBe("foreign")
  })

  it("recovers a dead process's linked index lock after the Git ref transaction aborts on EOF", async () => {
    write("src/file.txt", "candidate before process exit\n")
    const receipt = file(".git/last-test-receipt.json")
    const child = [
      'const fs = require("node:fs")',
      "const { executeTaskBoundGitCommit } = require(process.env.TASK_TEST_SERVICE)",
      'executeTaskBoundGitCommit({worktreePath:process.env.TASK_TEST_REPO,filePaths:["src/file.txt"],',
      'message:"candidate",revalidate:async()=>true,canPublish:()=>process.exit(77),',
      "onPrepared:async c=>fs.writeFileSync(process.env.TASK_TEST_RECEIPT,JSON.stringify(c))})"
    ].join("\n")
    let status: number | undefined
    try {
      execFileSync(process.execPath, ["--import", "tsx", "-e", child], {
        cwd: process.cwd(),
        timeout: 30_000,
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          TASK_TEST_SERVICE: path.join(__dirname, "task-bound-git-commit.ts"),
          TASK_TEST_REPO: root,
          TASK_TEST_RECEIPT: receipt
        }
      })
    } catch (error) {
      status = (error as { status?: number }).status
    }
    expect(status).toBe(77)
    const record = JSON.parse(readFileSync(receipt, "utf8")) as TaskCommitCandidate
    await expect.poll(() => existsSync(file(".git/HEAD.lock")), { timeout: 5_000 }).toBe(false)
    expect(existsSync(file(".git/index.lock"))).toBe(true)
    expect(
      await recoverTaskBoundCommitIndex(root, record.sha, record.indexRecovery, record.branch)
    ).toMatchObject({ ok: false, cleared: true })
    expect(existsSync(file(".git/index.lock"))).toBe(false)
    expect(existsSync(file(".git/index.task-commit-recovery.lock"))).toBe(false)
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("diff", "--cached", "--name-only")).toBe("")
  })

  it("excludes other app writes only while the task commit is active", async () => {
    const gitDir = file(".git")
    const panel = prepareGitPanelWrite()
    const releaseFirst = await panel.reserve(root, Promise.resolve(gitDir))
    const releaseSecond = await panel.reserve(root, Promise.resolve(gitDir))
    try {
      write("src/file.txt", "modified\n")
      expect(await commit(["src/file.txt"])).toMatchObject({ status: "review" })
    } finally {
      releaseSecond()
      releaseFirst()
    }
    try {
      expect(
        await commit(["src/file.txt"], {
          onPrepared: async () => {
            await expect(panel.reserve(root, Promise.resolve(gitDir))).rejects.toThrow("Git 写入")
            expect(() => beginGitCheckoutWrite(gitDir)).toThrow("Git 写入")
          }
        })
      ).toMatchObject({ status: "committed" })
      const available = await panel.reserve(root, Promise.resolve(gitDir))
      available()
    } finally {
      panel.dispose()
    }
  })

  it("recovers a published receipt's exact pending index without overwriting a foreign lock", async () => {
    const index = file(".git/index")
    const lock = index + ".lock"
    write("other.txt", "other staged change\n")
    git("add", "other.txt")
    write("src/file.txt", "committed change\n")
    const previous = readFileSync(index)
    let recorded!: TaskCommitCandidate
    expect(
      await commit(["src/file.txt"], {
        onPrepared: async (value) => {
          recorded = value
        }
      })
    ).toMatchObject({ status: "committed" })
    // Recreate the durable filesystem state at process loss between update-ref and index rename.
    const prepared = readFileSync(index)
    renameSync(index, lock)
    writeFileSync(index, previous)
    const recover = () =>
      recoverTaskBoundCommitIndex(root, recorded.sha, recorded.indexRecovery, recorded.branch)
    writeFileSync(lock, "different writer")
    expect(await recover()).toMatchObject({ ok: false })
    expect(readFileSync(lock, "utf8")).toBe("different writer")
    writeFileSync(lock, prepared)
    expect(await recover()).toEqual({ ok: true })
    expect(existsSync(lock)).toBe(false)
    expect(readFileSync(index)).toEqual(prepared)
    expect(await recover()).toEqual({ ok: true })
    expect(git("rev-parse", "HEAD")).toBe(recorded.sha)
    expect(git("diff", "--cached", "--name-only")).toBe("other.txt")

    // The same interrupted operation before ref publication has the old parent,
    // its old index, and the receipt's intact pending lock. Only the lock is removed.
    git("update-ref", "HEAD", beforeCommit, recorded.sha)
    renameSync(index, lock)
    writeFileSync(index, previous)
    expect(await recover()).toMatchObject({
      ok: false,
      cleared: true,
      reason: expect.stringContaining("已释放")
    })
    expect(existsSync(lock)).toBe(false)
    expect(readFileSync(index)).toEqual(previous)
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(await recover()).toMatchObject({ ok: false, cleared: true })
  })

  it("keeps the main checkout intact and serializes simultaneous requests to a linked worktree", async () => {
    const linked = path.join(root, "linked")
    git("config", "--unset", "core.hooksPath")
    git("worktree", "add", "-q", "-b", "linked-branch", linked)
    write("src/file.txt", "main checkout only\n")
    writeFileSync(path.join(linked, "src", "file.txt"), "linked change\n")
    const first = commit(["src/file.txt"], { worktreePath: linked })
    const second = commit(["src/file.txt"], { worktreePath: linked })
    const statuses = (await Promise.all([first, second])).map((result) => result.status).sort()
    expect(statuses).toEqual(["committed", "review"])
    expect(git("rev-parse", "HEAD")).toBe(beforeCommit)
    expect(git("show", "refs/heads/linked-branch:src/file.txt")).toBe("linked change")
    expect(readFileSync(file("src/file.txt"), "utf8")).toBe("main checkout only\n")
  })

  it("preserves native SSH signatures on the published candidate when ssh-keygen is available", async (ctx) => {
    const privateKey = file(".git/test-key")
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey], {
        windowsHide: true,
        stdio: "pipe"
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ctx.skip()
      throw error
    }
    git("config", "gpg.format", "ssh")
    git("config", "user.signingkey", privateKey)
    git("config", "commit.gpgsign", "true")
    write("src/file.txt", "signed content\n")
    expect(await commit(["src/file.txt"])).toMatchObject({ status: "committed" })
    expect(git("cat-file", "commit", "HEAD")).toContain("gpgsig -----BEGIN SSH SIGNATURE-----")
  })
})
