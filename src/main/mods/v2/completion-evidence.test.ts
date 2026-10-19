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
import { AUTOBIZ_COMPLETION_EVIDENCE } from "../adapters/autobiz-completion-evidence"

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

it("does not infer an AutoBiz layout, while its explicit adapter still binds ignored legacy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-declared-evidence-"))
  roots.push(root)
  await execute("git", ["-C", root, "init"], { windowsHide: true })
  await writeFile(join(root, ".gitignore"), ".autobizdevops/\n")
  await mkdir(join(root, ".autobizdevops"))
  await writeFile(join(root, ".autobizdevops", "state.json"), "legacy state")
  const input = {
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1
  }
  const generic = await captureCompletionBinding(input)
  expect(generic.stateFingerprint).toBe("missing")
  expect(generic.files.some((file) => file.path.startsWith(".autobizdevops/"))).toBe(false)
  const legacy = await captureCompletionBinding({
    ...input,
    references: AUTOBIZ_COMPLETION_EVIDENCE
  })
  expect(legacy.files).toContainEqual(
    expect.objectContaining({ path: ".autobizdevops/state.json" })
  )
  expect(legacy.stateFingerprint).toBe(
    legacy.files.find((file) => file.path === ".autobizdevops/state.json")!.sha256
  )
})

it("binds independent business state and requirement references without a platform business branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-independent-evidence-"))
  roots.push(root)
  await mkdir(join(root, ".review"))
  await writeFile(join(root, ".review", "status.json"), "initial")
  await writeFile(join(root, "acceptance.txt"), "must be verified")
  const input = {
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1,
    references: { statePaths: [".review/status.json"], requirementPaths: ["acceptance.txt"] }
  }
  const before = await captureCompletionBinding(input)
  await writeFile(join(root, ".review", "status.json"), "reviewed")
  const after = await captureCompletionBinding(input)
  expect(before.stateFingerprint).not.toBe(after.stateFingerprint)
  expect(before.requirementVersion).toBe(after.requirementVersion)
  const noDeclaredRequirement = await captureCompletionBinding({
    ...input,
    references: { statePaths: [".review/status.json"] }
  })
  expect(noDeclaredRequirement.requirementVersion).not.toBe(after.requirementVersion)
  expect(noDeclaredRequirement.configFingerprint).not.toBe(after.configFingerprint)
})

it.each(["../outside", "C:/outside", "/outside", "nested/../outside", "nested\\outside"])(
  "rejects an unscoped evidence reference before reading files: %s",
  async (path) => {
    const root = await mkdtemp(join(tmpdir(), "mods-reference-guard-"))
    roots.push(root)
    await expect(
      captureCompletionBinding({
        workspace: root,
        threadId: "thread",
        turnId: "turn",
        pluginDigests: {},
        runtimeGeneration: 1,
        references: { statePaths: [path] }
      })
    ).rejects.toThrow("COMPLETION_EVIDENCE_REFERENCE")
  }
)

it("requires declared state references to identify files and preserves evidence exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-reference-files-"))
  roots.push(root)
  await mkdir(join(root, "records"))
  await writeFile(join(root, "records", "status.json"), "{}")
  const input = {
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    pluginDigests: {},
    runtimeGeneration: 1
  }
  await expect(
    captureCompletionBinding({ ...input, references: { statePaths: ["records"] } })
  ).rejects.toThrow("COMPLETION_EVIDENCE_REFERENCE_FILE_REQUIRED")
  await expect(
    captureCompletionBinding({
      ...input,
      references: { statePaths: ["records/status.json"] },
      excludePaths: [join(root, "records", "status.json")]
    })
  ).rejects.toThrow("COMPLETION_EVIDENCE_REFERENCE_FILE_REQUIRED")
})
