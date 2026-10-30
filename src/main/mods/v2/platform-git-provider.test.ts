import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import {
  createGitInspectionPlatformProvider,
  type GitInspectionDependencies
} from "./platform-git-provider"

const roots: string[] = []
const providers: ReturnType<typeof createGitInspectionPlatformProvider>[] = []
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_AUTHOR_NAME: "Provider Test",
  GIT_AUTHOR_EMAIL: "provider@example.invalid",
  GIT_COMMITTER_NAME: "Provider Test",
  GIT_COMMITTER_EMAIL: "provider@example.invalid"
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }).trim()
}
function context(overrides: Partial<NativePlatformCallContext> = {}) {
  let revoked = false
  const controller = new AbortController()
  const value: NativePlatformCallContext = {
    workspace: "/workspace",
    threadId: "thread",
    incarnation: "incarnation",
    generation: "native-generation",
    caller: {
      name: "caller",
      provider: "caller",
      digest: "caller-digest",
      generation: "caller-generation"
    },
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted()
      if (revoked) throw Error("READ_AUTHORITY_REVOKED")
    },
    publish() {
      throw Error("UNEXPECTED_PUBLICATION")
    },
    async invoke() {
      throw Error("UNEXPECTED_NESTED_ACTION")
    },
    ...overrides
  }
  return {
    value,
    controller,
    revoke: () => {
      revoked = true
    }
  }
}
async function fixture(deps: Partial<GitInspectionDependencies> = {}) {
  const parent = await mkdtemp(join(tmpdir(), "mods-git-provider-"))
  roots.push(parent)
  const root = join(parent, "repo")
  await mkdir(root)
  git(root, "init", "-q")
  git(root, "config", "core.autocrlf", "false")
  await writeFile(join(root, "tracked.txt"), "base\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "baseline")
  const baseCommit = git(root, "rev-parse", "HEAD")
  let confirmations = 0
  const provider = createGitInspectionPlatformProvider({
    confirmDirectory: async () => {
      confirmations++
      return true
    },
    authorizePath: async () => {},
    ...deps
  })
  providers.push(provider)
  const owner = context()
  const act = async (action: string, input: ModObject, current = owner.value) => {
    const value = await provider.act(current, action, input)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("RESULT_REQUIRED")
    return value
  }
  return {
    parent,
    root,
    baseCommit,
    provider,
    owner,
    act,
    confirmations: () => confirmations,
    bind: (current = owner.value) => act("bind", { directory: root }, current)
  }
}
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close?.()
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("mods-git-provider-"))
      throw Error("OWNED_TEST_DIRECTORY_REQUIRED")
    await rm(target, { recursive: true, force: true })
  }
})

describe("Git inspection provider with real repositories", () => {
  it("returns an explicit partial list with tracked sensitive paths without exposing their names", async () => {
    const f = await fixture()
    await writeFile(join(f.root, ".env"), "encrypted-fixture-placeholder\n")
    git(f.root, "add", ".env")
    git(f.root, "commit", "-qm", "sensitive fixture")
    const baseCommit = git(f.root, "rev-parse", "HEAD")
    await writeFile(join(f.root, "tracked.txt"), "readable change\n")
    const bound = await f.bind()
    const page = await f.act("list", { directoryRef: bound.directoryRef, baseCommit })
    expect(page).toMatchObject({
      completeness: "partial",
      excluded: { denied: 1, gitlinks: 0 },
      limitations: ["paths-not-authorized"],
      entries: [{ path: "tracked.txt", status: "modified" }]
    })
    expect(JSON.stringify(page)).not.toContain(".env")
    expect(JSON.stringify(page)).not.toContain("encrypted-fixture-placeholder")
    const preview = await f.act("file", {
      directoryRef: bound.directoryRef,
      baseCommit,
      comparisonId: page.comparisonId,
      path: "tracked.txt"
    })
    expect(preview.patch).toContain("+readable change")
    await expect(
      f.act("file", {
        directoryRef: bound.directoryRef,
        baseCommit,
        comparisonId: page.comparisonId,
        path: ".env"
      })
    ).rejects.toThrow("PATH_DENIED")
  }, 30_000)

  it("distinguishes a path policy denial from revocation and rejects reused comparisons", async () => {
    let denial = true,
      revoke = false
    const f = await fixture({
      authorizePath: async (_context, _root, path) => {
        if (path.endsWith("tracked.txt") && denial) {
          if (revoke) f.owner.revoke()
          throw Error("MODS_GIT_PATH_DENIED")
        }
      }
    })
    const bound = await f.bind()
    const input = { directoryRef: bound.directoryRef, baseCommit: f.baseCommit }
    const page = await f.act("list", input)
    expect(page).toMatchObject({
      completeness: "partial",
      excluded: { denied: 1, gitlinks: 0 },
      entries: []
    })
    denial = false
    await expect(
      f.act("list", { ...input, comparisonId: page.comparisonId })
    ).rejects.toMatchObject({ code: "COMPARISON_STALE" })
    denial = true
    revoke = true
    await expect(f.act("list", input)).rejects.toThrow("READ_AUTHORITY_REVOKED")
  }, 30_000)

  it("reuses an exact scoped grant and returns real changes without writing the index", async () => {
    const f = await fixture(),
      bound = await f.bind()
    expect(await f.bind()).toEqual(bound)
    expect(f.confirmations()).toBe(1)
    await writeFile(join(f.root, "tracked.txt"), "working\n")
    const before = await readFile(join(f.root, ".git", "index"))
    const page = await f.act("list", { directoryRef: bound.directoryRef, baseCommit: f.baseCommit })
    expect(page.entries).toEqual([{ path: "tracked.txt", status: "modified" }])
    const preview = await f.act("file", {
      directoryRef: bound.directoryRef,
      baseCommit: f.baseCommit,
      comparisonId: page.comparisonId,
      path: "tracked.txt"
    })
    expect(preview.patch).toContain("-base")
    expect(preview.patch).toContain("+working")
    expect(preview).not.toHaveProperty("base")
    expect(preview).not.toHaveProperty("current")
    expect(await readFile(join(f.root, ".git", "index"))).toEqual(before)
    expect(git(f.root, "rev-parse", "HEAD")).toBe(f.baseCommit)
  }, 30_000)

  it("isolates directory refs across workspace, conversation, incarnation and caller sources", async () => {
    const f = await fixture(),
      bound = await f.bind()
    const originals = f.owner.value
    const variations: Partial<NativePlatformCallContext>[] = [
      { workspace: "/other" },
      { threadId: "other" },
      { incarnation: "other" },
      { generation: "other" },
      ...["name", "digest", "generation"].map((field) => ({
        caller: { ...originals.caller, [field]: "other" }
      }))
    ]
    for (const variation of variations)
      await expect(
        f.act("release", { directoryRef: bound.directoryRef }, context(variation).value)
      ).rejects.toThrow("MODS_GIT_DIRECTORY_REF_INVALID")
    expect(await f.act("release", { directoryRef: bound.directoryRef })).toEqual({ released: true })
    await expect(
      f.act("list", { directoryRef: bound.directoryRef, baseCommit: f.baseCommit })
    ).rejects.toThrow("MODS_GIT_DIRECTORY_REF_INVALID")
    const renewed = await f.bind()
    expect(renewed.directoryRef).not.toBe(bound.directoryRef)
    expect(f.confirmations()).toBe(2)
  }, 30_000)

  it.each(["release", "revoke", "cancel"] as const)(
    "rejects a pending real content read after %s instead of returning cached bytes",
    async (change) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      let hold = false
      const f = await fixture({
        authorizePath: async () => {
          if (hold) {
            entered.resolve()
            await release.promise
          }
        }
      })
      const bound = await f.bind()
      await writeFile(join(f.root, "tracked.txt"), "working\n")
      const page = await f.act("list", {
        directoryRef: bound.directoryRef,
        baseCommit: f.baseCommit
      })
      hold = true
      const pending = f.act("file", {
        directoryRef: bound.directoryRef,
        baseCommit: f.baseCommit,
        comparisonId: page.comparisonId,
        path: "tracked.txt"
      })
      const rejected = expect(pending).rejects.toThrow()
      await entered.promise
      try {
        if (change === "release") await f.act("release", { directoryRef: bound.directoryRef })
        else if (change === "revoke") f.owner.revoke()
        else f.owner.controller.abort(Error("READ_CANCELLED"))
      } finally {
        release.resolve()
      }
      await rejected
    },
    30_000
  )

  it("rejects directory replacement both during approval and after a grant was bound", async () => {
    let changeDuringApproval = false
    const f = await fixture({
      confirmDirectory: async (_context, root) => {
        if (changeDuringApproval) {
          await rename(root, join(dirname(root), "second-old"))
          await mkdir(root)
          git(root, "init", "-q")
        }
        return true
      }
    })
    const bound = await f.bind()
    await rename(f.root, join(f.parent, "first-old"))
    await mkdir(f.root)
    git(f.root, "init", "-q")
    await expect(
      f.act("list", { directoryRef: bound.directoryRef, baseCommit: f.baseCommit })
    ).rejects.toMatchObject({ code: "DIRECTORY_CHANGED" })
    changeDuringApproval = true
    await expect(f.bind()).rejects.toThrow("MODS_GIT_DIRECTORY_CHANGED")
  }, 30_000)

  it("enforces the 32-grant limit after simultaneous native confirmations", async () => {
    const allEntered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let entered = 0
    const f = await fixture({
      confirmDirectory: async () => {
        if (++entered === 33) allEntered.resolve()
        await release.promise
        return true
      }
    })
    const pending = Promise.allSettled(
      Array.from({ length: 33 }, (_, index) =>
        f.bind(context({ threadId: `thread-${index}` }).value)
      )
    )
    await allEntered.promise
    release.resolve()
    const results = await pending
    const succeeded = results.filter((result) => result.status === "fulfilled")
    const failed = results.filter((result) => result.status === "rejected")
    expect(succeeded).toHaveLength(32)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ reason: { message: "MODS_GIT_DIRECTORY_LIMIT" } })
    expect(new Set(succeeded.map((result) => result.value.directoryRef)).size).toBe(32)
  }, 60_000)
})
