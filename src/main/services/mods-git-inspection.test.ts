import { execFileSync } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  createModsGitInspection,
  ModsGitPathAuthorizationError,
  type ModsGitChangePage
} from "./mods-git-inspection"

const roots: string[] = []
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_AUTHOR_NAME: "Inspection Test",
  GIT_AUTHOR_EMAIL: "inspection@example.invalid",
  GIT_COMMITTER_NAME: "Inspection Test",
  GIT_COMMITTER_EMAIL: "inspection@example.invalid"
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }).trim()
}
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "mods-git-inspection-"))
  roots.push(parent)
  const root = join(parent, "repo")
  await mkdir(root)
  git(root, "init", "-q")
  git(root, "config", "core.autocrlf", "false")
  await writeFile(join(root, "tracked.txt"), "base\n")
  await writeFile(join(root, "deleted.txt"), "delete me\n")
  await writeFile(join(root, "renamed.txt"), "rename preserved content\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "baseline")
  const baseCommit = git(root, "rev-parse", "HEAD")
  const service = createModsGitInspection({ timeoutMs: 30000 })
  const identity = await service.inspectDirectory(root)
  return { root, parent, baseCommit, service, identity }
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe("Mods read-only Git inspection (real repositories)", () => {
  it("reports partial readable results without opening denied files or hiding gitlinks", async () => {
    const f = await fixture()
    git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.baseCommit},nested`)
    git(f.root, "commit", "-qm", "gitlink")
    const baseCommit = git(f.root, "rev-parse", "HEAD")
    // Exceeds the file read budget: success proves the denied tracked file was not read.
    await writeFile(join(f.root, "tracked.txt"), Buffer.alloc(17 * 1024 * 1024, 65))
    await writeFile(join(f.root, "private-untracked.txt"), "private fixture content")
    await writeFile(join(f.root, "deleted.txt"), "readable change\n")
    const authorizePath = async (path: string) => {
      if (["tracked.txt", "private-untracked.txt"].includes(path))
        throw new ModsGitPathAuthorizationError()
    }
    const page = await f.service.listChanges(f.identity, { baseCommit, authorizePath })
    expect(page.entries).toEqual([{ path: "deleted.txt", status: "modified" }])
    expect(page).toMatchObject({
      completeness: "partial",
      excluded: { denied: 2, gitlinks: 1 },
      limitations: ["paths-not-authorized", "gitlinks-not-inspected"],
      total: 1
    })
    expect(JSON.stringify(page)).not.toContain("tracked.txt")
    expect(JSON.stringify(page)).not.toContain("nested")
    expect(
      (await f.service.readFile(f.identity, { ...page, path: "deleted.txt", authorizePath })).patch
    ).toContain("+readable change")
    await expect(
      f.service.readFile(f.identity, { ...page, path: "tracked.txt", authorizePath })
    ).rejects.toMatchObject({ code: "PATH_DENIED" })
  }, 30000)

  it("invalidates comparisons when path authorization changes, even with unchanged files", async () => {
    const f = await fixture()
    let denied = "tracked.txt"
    const authorizePath = async (path: string) => {
      if (path === denied) throw new ModsGitPathAuthorizationError()
    }
    const page = await f.service.listChanges(f.identity, {
      baseCommit: f.baseCommit,
      authorizePath
    })
    denied = "deleted.txt"
    const changed = await f.service.listChanges(f.identity, {
      baseCommit: f.baseCommit,
      authorizePath
    })
    expect(changed.entries).toEqual(page.entries)
    expect(changed.excluded).toEqual(page.excluded)
    expect(changed.comparisonId).not.toBe(page.comparisonId)
    denied = ""
    await expect(
      f.service.listChanges(f.identity, { ...page, authorizePath })
    ).rejects.toMatchObject({ code: "COMPARISON_STALE" })
    expect(
      (await f.service.listChanges(f.identity, { baseCommit: f.baseCommit, authorizePath }))
        .completeness
    ).toBe("complete")
    await expect(
      f.service.listChanges(f.identity, {
        baseCommit: f.baseCommit,
        authorizePath: async () => {
          throw Error("RUNTIME_REVOKED")
        }
      })
    ).rejects.toThrow("RUNTIME_REVOKED")
  }, 30000)

  it("keeps actual autocrlf checkouts clean and previews changed text with the same normalization", async () => {
    const f = await fixture()
    git(f.root, "config", "core.autocrlf", "true")
    await rm(join(f.root, "tracked.txt"))
    git(f.root, "checkout", "--", "tracked.txt")
    expect(await readFile(join(f.root, "tracked.txt"), "utf8")).toBe("base\r\n")
    expect((await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })).entries).toEqual(
      []
    )
    await writeFile(join(f.root, "tracked.txt"), "changed\r\n")
    // Untrusted index optimization flags must not hide real working bytes.
    git(f.root, "update-index", "--assume-unchanged", "tracked.txt")
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    expect(page.entries).toContainEqual({ path: "tracked.txt", status: "modified" })
    const preview = await f.service.readFile(f.identity, { ...page, path: "tracked.txt" })
    expect(preview.current).toBe("changed\n")
    expect(preview.patch).toContain("+changed")
    expect(preview.patch).not.toContain("\r")
  }, 30000)

  it("honors text/eol and -text attributes without applying custom transformations", async () => {
    const f = await fixture()
    await writeFile(join(f.root, ".gitattributes"), "tracked.txt text eol=crlf\nraw.dat -text\n")
    await writeFile(join(f.root, "raw.dat"), "raw\r\n")
    git(f.root, "add", ".")
    git(f.root, "commit", "-qm", "attributes")
    const baseCommit = git(f.root, "rev-parse", "HEAD")
    await writeFile(join(f.root, "tracked.txt"), "base\r\n")
    expect((await f.service.listChanges(f.identity, { baseCommit })).entries).toEqual([])
    await writeFile(join(f.root, "raw.dat"), "raw\n")
    expect((await f.service.listChanges(f.identity, { baseCommit })).entries).toEqual([
      { path: "raw.dat", status: "modified" }
    ])
    await writeFile(join(f.root, "raw.dat"), "raw\r\n")
    await writeFile(join(f.root, ".gitattributes"), "tracked.txt text eol=crlf\nraw.dat text\n")
    const forced = await f.service.listChanges(f.identity, { baseCommit })
    expect(forced.entries).toContainEqual({ path: "raw.dat", status: "modified" })
    expect((await f.service.readFile(f.identity, { ...forced, path: "raw.dat" })).current).toBe(
      "raw\n"
    )
  }, 30000)

  it("compares raw blob identities in SHA-256 repositories", async () => {
    const f = await fixture(),
      shaRoot = join(f.parent, "sha256")
    await mkdir(shaRoot)
    git(shaRoot, "init", "-q", "--object-format=sha256")
    git(shaRoot, "config", "core.autocrlf", "false")
    await writeFile(join(shaRoot, "one.txt"), "base\n")
    git(shaRoot, "add", ".")
    git(shaRoot, "commit", "-qm", "base")
    const identity = await f.service.inspectDirectory(shaRoot)
    const baseCommit = git(shaRoot, "rev-parse", "HEAD")
    expect(baseCommit).toHaveLength(64)
    expect((await f.service.listChanges(identity, { baseCommit })).entries).toEqual([])
    await writeFile(join(shaRoot, "one.txt"), "changed\n")
    expect((await f.service.listChanges(identity, { baseCommit })).entries).toEqual([
      { path: "one.txt", status: "modified" }
    ])
  }, 30000)

  it("fails explicitly when tracked comparison bytes exceed the bounded scan", async () => {
    const f = await fixture()
    await truncate(join(f.root, "tracked.txt"), 17 * 1024 * 1024)
    await expect(
      f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "QUERY_TOO_LARGE" })
  }, 30000)

  it.each(["head", "index", "content"] as const)(
    "rejects a %s change between the two parallel metadata snapshots",
    async (kind) => {
      const f = await fixture()
      await writeFile(join(f.root, "tracked.txt"), "before read\n")
      const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
      let changed = false
      await expect(
        f.service.readFile(f.identity, {
          ...page,
          path: "tracked.txt",
          authorizeContent: async () => {
            if (changed) return
            changed = true
            if (kind === "head") git(f.root, "commit", "--allow-empty", "-qm", "new head")
            else if (kind === "index") git(f.root, "add", "tracked.txt")
            else await writeFile(join(f.root, "tracked.txt"), "after read\n")
          }
        })
      ).rejects.toMatchObject({ code: "COMPARISON_STALE" })
      expect(changed).toBe(true)
    },
    30000
  )

  it("compares a frozen base with committed, staged, working and untracked changes without index writes", async () => {
    const f = await fixture()
    await writeFile(join(f.root, "tracked.txt"), "committed\n")
    git(f.root, "commit", "-qam", "later")
    await writeFile(join(f.root, "staged.txt"), "staged\n")
    git(f.root, "add", "staged.txt")
    await writeFile(join(f.root, "tracked.txt"), "working\n")
    await rm(join(f.root, "deleted.txt"))
    git(f.root, "mv", "renamed.txt", "改名 with spaces.txt")
    await writeFile(join(f.root, "新文件.txt"), "untracked\n")
    const indexBefore = await readFile(join(f.identity.gitDir, "index"))
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    expect(page.head).not.toBe(f.baseCommit)
    expect(page.baseCommit).toBe(f.baseCommit)
    expect(page.entries).toEqual(
      expect.arrayContaining([
        { path: "tracked.txt", status: "modified" },
        { path: "staged.txt", status: "added" },
        { path: "deleted.txt", status: "deleted" },
        { path: "新文件.txt", status: "untracked" },
        { path: "改名 with spaces.txt", oldPath: "renamed.txt", status: "renamed" }
      ])
    )
    const preview = await f.service.readFile(f.identity, { ...page, path: "tracked.txt" })
    expect(preview.patch).toContain("-base")
    expect(preview.patch).toContain("+working")
    expect(preview.base).toBe("base\n")
    expect(preview.current).toBe("working\n")
    const deleted = await f.service.readFile(f.identity, { ...page, path: "deleted.txt" })
    expect(deleted.base).toBe("delete me\n")
    expect(deleted.current).toBeNull()
    const added = await f.service.readFile(f.identity, { ...page, path: "新文件.txt" })
    expect(added.current).toBe("untracked\n")
    expect(added.base).toBeNull()
    expect(await readFile(join(f.identity.gitDir, "index"))).toEqual(indexBefore)
  }, 30000)

  it("keeps linked worktrees independent and invalidates a replaced directory", async () => {
    const f = await fixture()
    const linked = join(f.parent, "linked")
    git(f.root, "worktree", "add", "--detach", linked, f.baseCommit)
    await writeFile(join(linked, "tracked.txt"), "linked content\n")
    const identity = await f.service.inspectDirectory(linked)
    expect(identity.commonDir).toBe(f.identity.commonDir)
    expect(identity.gitDir).not.toBe(f.identity.gitDir)
    const page = await f.service.listChanges(identity, { baseCommit: f.baseCommit })
    expect((await f.service.readFile(identity, { ...page, path: "tracked.txt" })).current).toBe(
      "linked content\n"
    )
    expect((await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })).entries).toEqual(
      []
    )
    await rename(linked, join(f.parent, "old-linked"))
    await mkdir(linked)
    git(linked, "init", "-q")
    await expect(
      f.service.listChanges(identity, { baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "DIRECTORY_CHANGED" })
  }, 30000)

  it("paginates bounded results and rejects pages and previews after content changes", async () => {
    const f = await fixture()
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(f.root, name), name)
    const first = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit, limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await f.service.listChanges(f.identity, {
      baseCommit: f.baseCommit,
      cursor: first.nextCursor,
      limit: 1
    })
    expect(second.entries[0].path).not.toBe(first.entries[0].path)
    await writeFile(join(f.root, "a.txt"), "changed in place")
    await expect(
      f.service.listChanges(f.identity, { baseCommit: f.baseCommit, cursor: first.nextCursor })
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" })
    await expect(f.service.readFile(f.identity, { ...first, path: "a.txt" })).rejects.toMatchObject(
      { code: "COMPARISON_STALE" }
    )
    const bounded = createModsGitInspection({ maxEntries: 2 })
    await expect(
      bounded.listChanges(f.identity, { baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "QUERY_TOO_LARGE" })
  }, 30000)

  it("reports binary and bounded content without pretending a partial patch is complete", async () => {
    const f = await fixture()
    await writeFile(join(f.root, "binary.dat"), Buffer.from([1, 0, 255, 2]))
    await writeFile(join(f.root, "large.txt"), "中".repeat(1000))
    const service = createModsGitInspection({ maxBytes: 100, timeoutMs: 30000 })
    const page = await service.listChanges(f.identity, { baseCommit: f.baseCommit })
    const binary = await service.readFile(f.identity, { ...page, path: "binary.dat" })
    expect(binary).toMatchObject({ binary: true, current: null, patch: "" })
    const large = await service.readFile(f.identity, { ...page, path: "large.txt" })
    expect(large).toMatchObject({ truncated: true, binary: false, patch: "" })
    expect(Buffer.byteLength(large.current ?? "")).toBeLessThanOrEqual(100)
  }, 30000)

  it("rejects missing baselines, options, path traversal, unavailable directories and cancellation", async () => {
    const f = await fixture()
    await expect(
      f.service.listChanges(f.identity, { baseCommit: "does-not-exist" })
    ).rejects.toMatchObject({ code: "BASE_COMMIT_MISSING" })
    await expect(f.service.listChanges(f.identity, { baseCommit: "--help" })).rejects.toMatchObject(
      { code: "BASE_COMMIT_MISSING" }
    )
    await expect(
      f.service.readFile(f.identity, {
        baseCommit: f.baseCommit,
        comparisonId: "none",
        path: "../secret"
      })
    ).rejects.toMatchObject({ code: "PATH_DENIED" })
    await expect(
      f.service.readFile(f.identity, {
        baseCommit: f.baseCommit,
        comparisonId: "none",
        path: ".git/config"
      })
    ).rejects.toMatchObject({ code: "PATH_DENIED" })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      f.service.listChanges(f.identity, { baseCommit: f.baseCommit, signal: aborted.signal })
    ).rejects.toMatchObject({ code: "QUERY_CANCELLED" })
    await expect(
      createModsGitInspection({ timeoutMs: 1 }).listChanges(f.identity, {
        baseCommit: f.baseCommit
      })
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })
    await rm(f.root, { recursive: true, force: true })
    await expect(
      f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE" })
  }, 30000)

  it("rechecks host permission for renamed historical paths and for content", async () => {
    const f = await fixture()
    git(f.root, "mv", "renamed.txt", "public.txt")
    const denied = createModsGitInspection({
      authorizePath: async (path) => {
        if (path === "renamed.txt") throw new Error("policy-denied")
      }
    })
    await expect(denied.listChanges(f.identity, { baseCommit: f.baseCommit })).rejects.toThrow(
      "policy-denied"
    )
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    await expect(
      f.service.readFile(f.identity, {
        ...page,
        path: "public.txt",
        authorizeContent: async () => {
          throw new Error("sensitive-content")
        }
      })
    ).rejects.toThrow("sensitive-content")
  }, 30000)

  it("does not execute repository external diff, textconv, fsmonitor, clean or process filters", async () => {
    const f = await fixture()
    const marker = join(f.parent, "executed")
    const command = `echo unsafe > '${marker.replaceAll("\\", "/")}'`
    git(f.root, "config", "diff.external", command)
    git(f.root, "config", "core.fsmonitor", command)
    git(f.root, "config", "diff.evil.textconv", command)
    git(f.root, "config", "filter.evil.clean", command)
    git(f.root, "config", "filter.evil.process", command)
    git(f.root, "config", "filter.evil.required", "true")
    await writeFile(join(f.root, ".gitattributes"), "*.txt filter=evil diff=evil\n")
    await writeFile(join(f.root, "tracked.txt"), "safe preview\n")
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    const result = await f.service.readFile(f.identity, { ...page, path: "tracked.txt" })
    expect(result.current).toBe("safe preview\n")
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  }, 30000)

  it("denies junction escape and preserves unambiguous unicode names", async () => {
    const f = await fixture()
    const outside = join(f.parent, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "secret.txt"), "outside secret")
    await symlink(
      outside,
      join(f.root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(
      f.service.readFile(f.identity, {
        baseCommit: f.baseCommit,
        comparisonId: "none",
        path: "escape/secret.txt"
      })
    ).rejects.toMatchObject({ code: "PATH_DENIED" })
    await rm(join(f.root, "escape"))
    const names =
      process.platform === "win32" ? ["空 格.txt"] : ["空 格.txt", 'quote".txt', "new\nline.txt"]
    for (const name of names) await writeFile(join(f.root, name), "new\n")
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    expect(page.entries.map((entry) => entry.path)).toEqual([...names].sort())
  }, 30000)

  it("marks conflicts separately and exposes current content without a normal patch", async () => {
    const f = await fixture()
    git(f.root, "checkout", "-qb", "other")
    await writeFile(join(f.root, "tracked.txt"), "other\n")
    git(f.root, "commit", "-qam", "other")
    git(f.root, "checkout", "--detach", f.baseCommit)
    await writeFile(join(f.root, "tracked.txt"), "ours\n")
    git(f.root, "commit", "-qam", "ours")
    expect(() => git(f.root, "merge", "other")).toThrow()
    const page: ModsGitChangePage = await f.service.listChanges(f.identity, {
      baseCommit: f.baseCommit
    })
    expect(page.entries.find((entry) => entry.path === "tracked.txt")?.status).toBe("conflict")
    const result = await f.service.readFile(f.identity, { ...page, path: "tracked.txt" })
    expect(result.patch).toBe("")
    expect(result.current).toContain("<<<<<<<")
    expect(result.limitations).toContain("conflict-current-content-only")
  }, 30000)

  it("keeps directory authorization across HEAD changes and cancels an active query", async () => {
    const f = await fixture()
    await writeFile(join(f.root, "tracked.txt"), "later commit\n")
    git(f.root, "commit", "-qam", "advance")
    expect((await f.service.inspectDirectory(f.root)).identity).toBe(f.identity.identity)
    const page = await f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    expect(page.entries).toContainEqual({ path: "tracked.txt", status: "modified" })
    const controller = new AbortController()
    const pending = f.service.listChanges(f.identity, {
      baseCommit: f.baseCommit,
      signal: controller.signal
    })
    const timer = setTimeout(() => controller.abort(), 20)
    try {
      await expect(pending).rejects.toMatchObject({ code: "QUERY_CANCELLED" })
    } finally {
      clearTimeout(timer)
    }
  }, 30000)

  it("checks tracked directory junctions before Git reads them", async () => {
    const f = await fixture()
    const dir = join(f.root, "tracked-dir")
    await mkdir(dir)
    await writeFile(join(dir, "file.txt"), "original\n")
    git(f.root, "add", ".")
    git(f.root, "commit", "-qm", "nested")
    const outside = join(f.parent, "external")
    await mkdir(outside)
    await writeFile(join(outside, "file.txt"), "restricted\n")
    await rm(dir, { recursive: true })
    await symlink(outside, dir, process.platform === "win32" ? "junction" : "dir")
    await expect(
      f.service.listChanges(f.identity, { baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "PATH_DENIED" })
  }, 30000)
})
