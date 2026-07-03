/**
 * Pure git ref helpers (src/main/services/git-refs.ts).
 *
 * Locks down two pieces of subtle correctness this module owns:
 *
 *  1. isGitCommitSignalPath — which `.git`-internal change re-triggers a sync.
 *     It must fire on real commit/ref signals (logs/HEAD, refs/**, packed-refs)
 *     and stay silent on the high-churn paths (index, objects/**, lock files,
 *     FETCH_HEAD, COMMIT_EDITMSG) whose churn formed the watcher→sync→git→watcher
 *     feedback loop this guards against.
 *
 *  2. getRemoteRefsSignature — the content hash that gates the 2-minute push
 *     probe. It must be stable across idle sweeps, change only when a remote
 *     ref's SHA actually moves, ignore local-only commits, be transparent to
 *     `git pack-refs`, and return null for a linked worktree (so the caller
 *     falls back to the normal git probe).
 *
 * The module is electron/DB-free, so these run against real throwaway git repos
 * with no mocking.
 */

import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, describe, expect, it } from "vitest"

import { getRemoteRefsSignature, isGitCommitSignalPath } from "./git-refs"

describe("isGitCommitSignalPath", () => {
  it("fires on real commit / ref-update signals", () => {
    expect(isGitCommitSignalPath(".git/logs/HEAD")).toBe(true)
    expect(isGitCommitSignalPath(".git/refs/heads/main")).toBe(true)
    expect(isGitCommitSignalPath(".git/refs/remotes/origin/main")).toBe(true)
    expect(isGitCommitSignalPath(".git/refs/tags/v1")).toBe(true)
    expect(isGitCommitSignalPath(".git/packed-refs")).toBe(true)
  })

  it("ignores high-churn paths that would feed the sync→git→watcher loop", () => {
    expect(isGitCommitSignalPath(".git/index")).toBe(false)
    expect(isGitCommitSignalPath(".git/objects/ab/cdef")).toBe(false)
    expect(isGitCommitSignalPath(".git/FETCH_HEAD")).toBe(false)
    expect(isGitCommitSignalPath(".git/ORIG_HEAD")).toBe(false)
    expect(isGitCommitSignalPath(".git/COMMIT_EDITMSG")).toBe(false)
    // HEAD itself (checkout) is covered by the logs/HEAD reflog write instead.
    expect(isGitCommitSignalPath(".git/HEAD")).toBe(false)
  })

  it("ignores transient *.lock files (the real ref/reflog write fires the event)", () => {
    expect(isGitCommitSignalPath(".git/refs/heads/main.lock")).toBe(false)
    expect(isGitCommitSignalPath(".git/packed-refs.lock")).toBe(false)
    expect(isGitCommitSignalPath(".git/index.lock")).toBe(false)
  })
})

const tempRoots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/** A fresh working clone of a fresh bare remote, with one commit on origin/main. */
function makeRepoWithRemote(): string {
  const root = mkdtempSync(join(tmpdir(), "cmb-refsig-"))
  tempRoots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  execFileSync("git", ["init", "-q", "--bare", remote])
  execFileSync("git", ["clone", "-q", remote, work])
  git(work, "config", "user.email", "t@t.co")
  git(work, "config", "user.name", "t")
  writeFileSync(join(work, "a.txt"), "a")
  git(work, "add", "a.txt")
  git(work, "commit", "-qm", "init")
  git(work, "push", "-q", "origin", "HEAD:main")
  git(work, "fetch", "-q", "origin")
  return work
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
})

describe("getRemoteRefsSignature", () => {
  it("is stable while idle and changes only when a remote-tracking ref moves", async () => {
    const work = makeRepoWithRemote()

    const base = await getRemoteRefsSignature(work, "origin")
    expect(base).not.toBeNull()
    // idle: two reads agree
    expect(await getRemoteRefsSignature(work, "origin")).toBe(base)

    // local-only commit must NOT move the remote-tracking signature
    writeFileSync(join(work, "b.txt"), "b")
    git(work, "add", "b.txt")
    git(work, "commit", "-qm", "second")
    expect(await getRemoteRefsSignature(work, "origin")).toBe(base)

    // push advances refs/remotes/origin/main → signature changes
    git(work, "push", "-q", "origin", "HEAD:main")
    expect(await getRemoteRefsSignature(work, "origin")).not.toBe(base)
  })

  it("is transparent to git pack-refs (loose ↔ packed-refs, same value)", async () => {
    const work = makeRepoWithRemote()
    const loose = await getRemoteRefsSignature(work, "origin")
    git(work, "pack-refs", "--all")
    expect(await getRemoteRefsSignature(work, "origin")).toBe(loose)
  })

  it("returns null for a linked worktree (.git is a file) → caller uses git probe", async () => {
    const work = makeRepoWithRemote()
    const worktree = `${work}-wt`
    git(work, "worktree", "add", "-q", "-b", "feature", worktree, "HEAD")
    expect(await getRemoteRefsSignature(worktree, "origin")).toBeNull()
  })
})
