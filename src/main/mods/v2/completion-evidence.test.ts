import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import {
  bindingFingerprint,
  captureCompletionBinding,
  sameCompletionBinding
} from "./completion-evidence"

const roots: string[] = []
const execute = promisify(execFile)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("binds workspace, run, plugin generation, diff, requirements and file fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-"))
  roots.push(root)
  await writeFile(join(root, "requirements.md"), "REQ-001")
  const first = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    runId: "run",
    pluginDigests: { autobiz: "digest-1" },
    runtimeGeneration: 7,
    config: { mode: "check" }
  })
  expect(first).toMatchObject({ workspace: root, threadId: "thread", turnId: "turn", runId: "run" })
  expect(first.pluginDigests).toEqual({ autobiz: "digest-1" })
  expect(first.files).toEqual([expect.objectContaining({ path: "requirements.md", size: 7 })])
  expect(bindingFingerprint(first)).toHaveLength(64)
})

it("invalidates a prior PASS when a requirement or changed file is modified", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-"))
  roots.push(root)
  await writeFile(join(root, "requirements.md"), "before")
  const before = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1
  })
  await writeFile(join(root, "requirements.md"), "after")
  const after = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1
  })
  expect(sameCompletionBinding(before, after)).toBe(false)
})

it("binds configuration and runtime generation into the invalidation key", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-"))
  roots.push(root)
  const base = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: { p: "d" },
    runtimeGeneration: 1,
    config: { mode: "report" }
  })
  const changed = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: { p: "d" },
    runtimeGeneration: 2,
    config: { mode: "check" }
  })
  expect(sameCompletionBinding(base, changed)).toBe(false)
})

it("honors cancellation before enumeration and records missing explicit files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-"))
  roots.push(root)
  const controller = new AbortController()
  controller.abort()
  await expect(
    captureCompletionBinding({
      workspace: root,
      threadId: "thread",
      turnId: "turn",
      pluginDigests: {},
      runtimeGeneration: 1,
      signal: controller.signal
    })
  ).rejects.toMatchObject({ name: "AbortError" })
  const binding = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1,
    paths: ["not-created.txt"]
  })
  expect(binding.files).toEqual([{ path: "not-created.txt", size: -1, sha256: "missing" }])
})

it("expands explicit directory scope and does not fingerprint the directory as a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-evidence-"))
  roots.push(root)
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "index.ts"), "version one")
  const binding = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1,
    paths: ["src"]
  })
  expect(binding.files).toContainEqual(expect.objectContaining({ path: "src/index.ts" }))
})

it("binds staged, unstaged, deleted and untracked paths to the actual current diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-diff-evidence-"))
  roots.push(root)
  const git = (...args: string[]) => execute("git", ["-C", root, ...args], { windowsHide: true })
  await git("init")
  for (const name of ["staged.ts", "modified.ts", "deleted.ts", "unchanged.ts"])
    await writeFile(join(root, name), "before")
  await git("add", ".")
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial"
  )
  await writeFile(join(root, "staged.ts"), "staged")
  await git("add", "staged.ts")
  await writeFile(join(root, "modified.ts"), "modified")
  await rm(join(root, "deleted.ts"))
  await writeFile(join(root, "untracked.ts"), "new")
  const binding = await captureCompletionBinding({
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1
  })
  expect(binding.files.map((file) => file.path)).toEqual([
    "deleted.ts",
    "modified.ts",
    "staged.ts",
    "untracked.ts"
  ])
  expect(binding).toHaveProperty("diffFiles", [
    "deleted.ts",
    "modified.ts",
    "staged.ts",
    "untracked.ts"
  ])
})
