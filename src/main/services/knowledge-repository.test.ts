import { execFileSync } from "child_process"
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  KnowledgeRepositoryLocalChangesError,
  syncKnowledgeRepository,
  knowledgeWorkspaceHasChanges
} from "./knowledge-repository"

let root: string
let remote: string

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: remote,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  }).trim()
}

async function commit(content: string): Promise<string> {
  await writeFile(join(remote, "AGENTS.md"), content)
  git("add", "AGENTS.md")
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", content)
  return git("rev-parse", "HEAD")
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knowledge-repository-"))
  remote = join(root, "source")
  execFileSync("git", ["init", "-q", "-b", "main", remote])
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "app-data"))
  await commit("initial knowledge")
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe("knowledge repository synchronization", () => {
  it("reuses an unchanged clean checkout without cloning again", async () => {
    const source = { role: "read" as const, idKey: "main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    const firstInode = (await stat(first.path)).ino
    const second = await syncKnowledgeRepository(source)
    expect(second).toEqual({ ...first, updated: false })
    expect((await stat(second.path)).ino).toBe(firstInode)
    expect(await readdir(join(root, "app-data", "knowledge"))).toHaveLength(1)
  })

  it("pauses for local edits instead of replacing them", async () => {
    const source = { role: "read" as const, idKey: "main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    await writeFile(join(first.path, "AGENTS.md"), "local edit")
    await writeFile(join(first.path, "untracked.txt"), "local file")
    await expect(syncKnowledgeRepository(source)).rejects.toBeInstanceOf(
      KnowledgeRepositoryLocalChangesError
    )
    expect(await readFile(join(first.path, "AGENTS.md"), "utf8")).toBe("local edit")
    expect(await readdir(first.path)).toContain("untracked.txt")
  })

  it("uses the stable id key path and replaces it with remote updates", async () => {
    const source = { role: "read" as const, idKey: "payment-main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    expect(first.path).toMatch(/knowledge[/\\]payment-main[/\\]read$/)
    expect(await readFile(join(first.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
    const nextCommit = await commit("updated knowledge")
    const second = await syncKnowledgeRepository({ ...source, url: ` ${remote} `, ref: " main " })
    expect(second.path).toBe(first.path)
    expect(second.commit).toBe(nextCommit)
    expect(await readFile(join(second.path, "AGENTS.md"), "utf8")).toBe("updated knowledge")
    expect(await readdir(join(root, "app-data", "knowledge"))).toHaveLength(1)
  })

  it("separates branches and repositories", async () => {
    const main = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "main",
      url: remote,
      ref: "main"
    })
    git("checkout", "-qb", "release/next")
    await commit("release knowledge")
    const release = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "release",
      url: remote,
      ref: "release/next"
    })
    const otherRemote = join(root, "other-source")
    execFileSync("git", ["clone", "-q", remote, otherRemote])
    const other = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "other",
      url: otherRemote,
      ref: "release/next"
    })
    expect(new Set([main.path, release.path, other.path]).size).toBe(3)
    expect(await readFile(join(main.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
    expect(await readFile(join(release.path, "AGENTS.md"), "utf8")).toBe("release knowledge")
  })

  it("preserves the previous checkout and removes staging when the remote becomes unavailable", async () => {
    const source = { role: "read" as const, idKey: "main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    await rename(remote, join(root, "unavailable"))
    await expect(syncKnowledgeRepository(source)).rejects.toThrow()
    expect(await readFile(join(first.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
    expect(await readdir(join(root, "app-data", "knowledge"))).toHaveLength(1)
  })

  it("clones again when the local checkout is missing", async () => {
    const source = { role: "read" as const, idKey: "main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    await rm(first.path, { recursive: true, force: true })
    const second = await syncKnowledgeRepository(source)
    expect(second.path).toBe(first.path)
    expect(await readFile(join(second.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
  })

  it("rejects missing branches and tags", async () => {
    git("tag", "v1")
    await expect(
      syncKnowledgeRepository({
        role: "read" as const,
        idKey: "missing",
        url: remote,
        ref: "missing"
      })
    ).rejects.toThrow()
    await expect(
      syncKnowledgeRepository({ role: "read" as const, idKey: "tag", url: remote, ref: "v1" })
    ).rejects.toThrow()
    expect(await readdir(join(root, "app-data", "knowledge"))).toEqual(["missing", "tag"])
  })

  it("honors cancellation without disturbing the previous checkout", async () => {
    const source = { role: "read" as const, idKey: "main", url: remote, ref: "main" }
    const first = await syncKnowledgeRepository(source)
    const controller = new AbortController()
    controller.abort()
    await expect(syncKnowledgeRepository(source, { signal: controller.signal })).rejects.toThrow()
    expect(await readFile(join(first.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
  })

  it("defaults missing and blank refs to main and logs each fallback", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const explicit = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "main",
      url: remote,
      ref: "main"
    })
    expect(log).not.toHaveBeenCalled()
    const missing = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "main",
      url: remote
    })
    const blank = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "main",
      url: remote,
      ref: "  "
    })
    expect(missing.ref).toBe("main")
    expect(missing.path).toBe(explicit.path)
    expect(blank.path).toBe(explicit.path)
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith("[knowledge_manage] 未配置 ref，回退使用 main 分支")
  })

  it("reuses framework Git environment sanitization", async () => {
    vi.stubEnv("GIT_DIR", join(root, "wrong-git-dir"))
    vi.stubEnv("GIT_WORK_TREE", join(root, "wrong-work-tree"))
    const result = await syncKnowledgeRepository({
      role: "read" as const,
      idKey: "main",
      url: remote,
      ref: "main"
    })
    expect(await readFile(join(result.path, "AGENTS.md"), "utf8")).toBe("initial knowledge")
  })
  it("updates read independently while preserving dirty write content", async () => {
    const source = { idKey: "shared", url: remote, ref: "main" }
    const read = await syncKnowledgeRepository({ ...source, role: "read" })
    const write = await syncKnowledgeRepository({ ...source, role: "write" })
    await writeFile(join(write.path, "AGENTS.md"), "unfinished deposition")
    await commit("published knowledge")
    await syncKnowledgeRepository({ ...source, role: "read" })
    await expect(syncKnowledgeRepository({ ...source, role: "write" })).rejects.toBeInstanceOf(
      KnowledgeRepositoryLocalChangesError
    )
    expect(await readFile(join(read.path, "AGENTS.md"), "utf8")).toBe("published knowledge")
    expect(await readFile(join(write.path, "AGENTS.md"), "utf8")).toBe("unfinished deposition")
  })

  it("switches the actual branch even when branches share the same commit", async () => {
    git("branch", "release")
    const source = { idKey: "shared", url: remote, role: "read" as const }
    const first = await syncKnowledgeRepository({ ...source, ref: "main" })
    const next = await syncKnowledgeRepository({ ...source, ref: "release" })
    expect(next.commit).toBe(first.commit)
    expect(next.updated).toBe(true)
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: next.path,
        encoding: "utf8"
      }).trim()
    ).toBe("release")
  })

  it("replaces a changed origin even when its commit is identical", async () => {
    const other = join(root, "other-origin")
    execFileSync("git", ["clone", "-q", remote, other])
    const source = { idKey: "shared", ref: "main", role: "read" as const }
    const first = await syncKnowledgeRepository({ ...source, url: remote })
    const next = await syncKnowledgeRepository({ ...source, url: other })
    expect(next.commit).toBe(first.commit)
    expect(next.updated).toBe(true)
    expect(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: next.path,
        encoding: "utf8"
      }).trim()
    ).toBe(other)
  })

  it("preserves unpushed commits and does not mistake them for uncommitted changes", async () => {
    const source = { idKey: "shared", role: "write" as const, url: remote, ref: "main" }
    const write = await syncKnowledgeRepository(source)
    await writeFile(join(write.path, "AGENTS.md"), "local commit")
    execFileSync("git", ["add", "AGENTS.md"], { cwd: write.path })
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "local"],
      { cwd: write.path }
    )
    await expect(knowledgeWorkspaceHasChanges(write.path)).resolves.toBe(false)
    await expect(syncKnowledgeRepository(source)).rejects.toBeInstanceOf(
      KnowledgeRepositoryLocalChangesError
    )
    expect(await readFile(join(write.path, "AGENTS.md"), "utf8")).toBe("local commit")
  })
})
