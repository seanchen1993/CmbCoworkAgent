import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { withoutGitRepositoryOverrides } from "../../services/git-environment"
import { readFunctionSessionRepo, sessionRepoRemote } from "./session-repo"

const roots: string[] = []
const signal = () => new AbortController().signal
function fixture(bare = false) {
  const root = mkdtempSync(join(tmpdir(), "mods-session-repo-"))
  roots.push(root)
  const repo = join(root, "main repo")
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      windowsHide: true,
      encoding: "utf8",
      env: withoutGitRepositoryOverrides(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    })
  git("init", ...(bare ? ["--bare"] : []))
  return { root, repo, git }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-session-repo-")
    )
      throw Error("Unexpected cleanup target")
    rmSync(root, { recursive: true, force: true })
  }
})

it("returns null outside a repository, and real metadata without an origin", async () => {
  const f = fixture()
  const live = vi.fn()
  expect(await readFunctionSessionRepo(f.root, signal(), live)).toBeNull()
  expect(await readFunctionSessionRepo(f.repo, signal(), live)).toEqual({
    root: f.repo.replaceAll("\\", "/"),
    remote: null,
    internal: false,
    name: null
  })
  expect(live).toHaveBeenCalled()
})

it("uses the main worktree root, freshly reads push origin and strips URL userinfo", async () => {
  const f = fixture()
  f.git(
    "-c",
    "user.name=Mods fixture",
    "-c",
    "user.email=mods@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture"
  )
  const tree = join(f.root, "linked tree")
  f.git("worktree", "add", "--detach", tree, "HEAD")
  const nested = join(tree, "nested")
  mkdirSync(nested)
  f.git("remote", "add", "origin", "https://user:fake-read-key@example.invalid/team/fetch.git")
  f.git(
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://user:fake-push-key@example.invalid/team/push.git"
  )
  expect(await readFunctionSessionRepo(nested, signal(), () => {})).toEqual({
    root: f.repo.replaceAll("\\", "/"),
    remote: "https://example.invalid/team/push.git",
    internal: false,
    name: null
  })
  f.git("remote", "set-url", "--push", "origin", "git@example.invalid:team/new.git")
  expect((await readFunctionSessionRepo(nested, signal(), () => {}))?.remote).toBe(
    "git@example.invalid:team/new.git"
  )
})

it("does not inherit process Git repository or config redirection", async () => {
  const f = fixture()
  vi.stubEnv("GIT_DIR", join(f.root, "missing.git"))
  vi.stubEnv("GIT_WORK_TREE", f.root)
  vi.stubEnv("GIT_CONFIG_COUNT", "1")
  vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.pushurl")
  vi.stubEnv("GIT_CONFIG_VALUE_0", "https://other.invalid/unrelated.git")
  expect(await readFunctionSessionRepo(f.repo, signal(), () => {})).toMatchObject({
    root: f.repo.replaceAll("\\", "/"),
    remote: null
  })
})

it("supports a bare repository and preserves scp/local remote spellings", async () => {
  const f = fixture(true)
  expect(await readFunctionSessionRepo(f.repo, signal(), () => {})).toMatchObject({
    root: f.repo.replaceAll("\\", "/")
  })
  expect(sessionRepoRemote("git@example.invalid:team/repo.git")).toBe(
    "git@example.invalid:team/repo.git"
  )
  expect(sessionRepoRemote("../local.git")).toBe("../local.git")
  expect(sessionRepoRemote("ssh://user:password@example.invalid:2222/team/repo.git")).toBe(
    "ssh://example.invalid:2222/team/repo.git"
  )
})

it("checks cancellation and scope after an asynchronous Git read", async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort(Error("cancelled"))
  await expect(readFunctionSessionRepo(f.repo, controller.signal, () => {})).rejects.toThrow(
    "cancelled"
  )
  let checks = 0
  await expect(
    readFunctionSessionRepo(f.repo, signal(), () => {
      if (++checks >= 2) throw Error("replaced")
    })
  ).rejects.toThrow("replaced")
})

it("does not turn corrupt Git configuration into a false no-repository answer", async () => {
  const f = fixture()
  writeFileSync(join(f.repo, ".git", "config"), "[invalid https://user:private@example.invalid")
  await expect(readFunctionSessionRepo(f.repo, signal(), () => {})).rejects.toMatchObject({
    message: "MODS_SESSION_REPO_UNAVAILABLE"
  })
})
