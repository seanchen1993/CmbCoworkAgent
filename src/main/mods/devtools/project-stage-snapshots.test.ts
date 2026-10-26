import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"
import { createProjectTemplate } from "./project-template"
import { ProjectStageSnapshots, PROJECT_STAGE_SNAPSHOT_LIMITS } from "./project-stage-snapshots"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stage-input-snapshot-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"),
    workspace = join(root, "workspace")
  await mkdir(source)
  await mkdir(workspace)
  const template = createProjectTemplate({
    packageId: "stage-snapshot-project",
    name: "Real project"
  })
  for (const file of template.files) {
    await mkdir(dirname(join(source, file.path)), { recursive: true })
    await writeFile(join(source, file.path), file.text)
  }
  const retained = new HostPackageSnapshots(join(root, "packages")).capture(source)
  const projects = new HostProjectStore(join(root, "projects.sqlite"))
  cleanups.push(async () => projects.close())
  const project = projects.create({
    projectId: randomUUID(),
    name: "Original project",
    goal: "Preserve knowledge, binary input and the current stage entry state",
    workspace,
    installedPluginId: randomUUID(),
    packageId: retained.manifest.plugin.id,
    packageVersion: retained.manifest.plugin.version,
    pluginDigest: retained.digest,
    manifest: retained.manifest
  })
  const prepare = () =>
    projects.prepare({
      projectId: project.projectId,
      expectedVersion: project.version,
      stageId: project.manifest.stages[project.stageIndex].id,
      idempotencyKey: randomUUID(),
      inputFingerprint: runtimeDigest("native admitted input")
    })
  const operation = prepare()
  await mkdir(join(workspace, "inputs", "empty"), { recursive: true })
  await mkdir(join(workspace, "knowledge"))
  await writeFile(join(workspace, "inputs", "sample.bin"), Buffer.from([0, 255, 10, 128]))
  await writeFile(join(workspace, "knowledge", "policy.md"), "原始知识正文，不能只保留索引。\n")
  await writeFile(join(workspace, "draft.md"), "Original entry-state draft\n")
  const snapshotRoot = join(root, "snapshots")
  const snapshots = new ProjectStageSnapshots(snapshotRoot)
  const input = {
    scopeKey: "native-creator-incarnation",
    project,
    operation,
    sourceRoot: retained.root,
    inputIdentity: runtimeDigest("native config/context/knowledge identity"),
    guard: () => {}
  }
  async function destination(name: string = randomUUID()) {
    const path = join(root, `branch-${name}`)
    await mkdir(path)
    return path
  }
  return {
    root,
    project,
    projects,
    operation,
    prepare,
    retained,
    workspace,
    snapshotRoot,
    snapshots,
    input,
    destination
  }
}

describe("native stage input snapshots", () => {
  it("binds only a validated opaque configuration identity into immutable stage metadata", async () => {
    const f = await fixture()
    const recoveryInputs = { schemaVersion: 1 as const, id: randomUUID(), digest: "a".repeat(64) }
    const captured = await f.snapshots.capture({ ...f.input, recoveryInputs })
    expect(f.snapshots.read(captured.id, f.input.scopeKey).recoveryInputs).toEqual(recoveryInputs)
    recoveryInputs.digest = "b".repeat(64)
    expect(f.snapshots.read(captured.id, f.input.scopeKey).recoveryInputs?.digest).toBe(
      "a".repeat(64)
    )
    await expect(
      f.snapshots.capture({
        ...f.input,
        recoveryInputs: { ...recoveryInputs, rawSecret: "must-never-enter-metadata" }
      } as never)
    ).rejects.toThrow("RECOVERY_INPUTS_INVALID")
    await expect(
      f.snapshots.capture({ ...f.input, recoveryInputs: { ...recoveryInputs, digest: "forged" } })
    ).rejects.toThrow("RECOVERY_INPUTS_INVALID")
  })
  it("restores complete binary inputs and empty directories in an independent branch after restart", async () => {
    const f = await fixture()
    const captured = await f.snapshots.capture(f.input)
    expect(captured.id).toMatch(/^[a-f0-9]{64}$/)
    expect(captured.project).toEqual(f.project)
    expect(captured.operation).toEqual(f.operation)
    expect(captured.sourceDigest).toBe(f.retained.digest)
    expect(captured.inputIdentity).toBe(f.input.inputIdentity)
    expect(captured.files.map((file) => file.path)).toEqual([
      "draft.md",
      "inputs/sample.bin",
      "knowledge/policy.md"
    ])
    expect(captured.directories).toContain("inputs/empty")
    expect(JSON.stringify(captured)).not.toContain("原始知识正文")
    const restarted = new ProjectStageSnapshots(f.snapshotRoot)
    expect(restarted.read(captured.id, f.input.scopeKey)).toEqual(captured)
    const branch = await f.destination()
    await restarted.materialize(captured.id, f.input.scopeKey, branch, () => {})
    expect(await readFile(join(branch, "inputs/sample.bin"))).toEqual(
      Buffer.from([0, 255, 10, 128])
    )
    expect(await readFile(join(branch, "knowledge/policy.md"), "utf8")).toBe(
      "原始知识正文，不能只保留索引。\n"
    )
    expect(await readdir(join(branch, "inputs/empty"))).toEqual([])
    expect(f.projects.get(f.project.projectId)).toEqual(f.project)
    expect(f.projects.getOperation(f.operation.operationId)).toEqual(f.operation)
    expect(existsSync(join(branch, "plugin.json"))).toBe(false)
  })
  it("retains separate immutable snapshots for different attempts at the same stage", async () => {
    const f = await fixture()
    const first = await f.snapshots.capture(f.input)
    f.projects.cancel(f.operation.operationId)
    const secondOperation = f.prepare()
    await writeFile(join(f.workspace, "draft.md"), "Changed next-attempt input")
    const second = await f.snapshots.capture({ ...f.input, operation: secondOperation })
    expect(first.id).not.toBe(second.id)
    expect(first.stageId).toBe(second.stageId)
    expect(first.operation.operationId).not.toBe(second.operation.operationId)
    const branch = await f.destination()
    await f.snapshots.materialize(first.id, f.input.scopeKey, branch, () => {})
    expect(await readFile(join(branch, "draft.md"), "utf8")).toBe("Original entry-state draft\n")
    expect(await readFile(join(f.workspace, "draft.md"), "utf8")).toBe("Changed next-attempt input")
  })
  it("lists only the requested scope and retains discovery across native service restart", async () => {
    const f = await fixture()
    const own = await f.snapshots.capture(f.input)
    const other = await f.snapshots.capture({ ...f.input, scopeKey: "other-native-incarnation" })
    const restarted = new ProjectStageSnapshots(f.snapshotRoot)
    expect(restarted.list(f.input.scopeKey).map((snapshot) => snapshot.id)).toEqual([own.id])
    expect(restarted.list("other-native-incarnation").map((snapshot) => snapshot.id)).toEqual([
      other.id
    ])
    expect(restarted.list("missing-native-incarnation")).toEqual([])
  })
  it("rejects cross-scope readback and materialization, unknown IDs and malformed IDs", async () => {
    const f = await fixture(),
      snapshot = await f.snapshots.capture(f.input)
    expect(() => f.snapshots.read(snapshot.id, "another-incarnation")).toThrow("METADATA_CHANGED")
    expect(() => f.snapshots.read("../outside", f.input.scopeKey)).toThrow("ID_INVALID")
    expect(() => f.snapshots.read("f".repeat(64), f.input.scopeKey)).toThrow("MISSING")
    const branch = await f.destination()
    await expect(
      f.snapshots.materialize(snapshot.id, "another-incarnation", branch, () => {})
    ).rejects.toThrow("METADATA_CHANGED")
    expect(await readdir(branch)).toEqual([])
  })
  it("rejects modified metadata even when all workspace input files are intact", async () => {
    const f = await fixture(),
      snapshot = await f.snapshots.capture(f.input)
    const path = join(f.snapshotRoot, snapshot.id, "snapshot.json")
    const metadata = JSON.parse(await readFile(path, "utf8"))
    metadata.project.goal = "Attacker changed the original goal"
    await writeFile(path, JSON.stringify(metadata))
    expect(() => f.snapshots.read(snapshot.id, f.input.scopeKey)).toThrow("METADATA_CHANGED")
  })
  it.each(["change", "missing", "extra", "empty-directory-missing"])(
    "rejects stored inventory tampering before any destination write: %s",
    async (mode) => {
      const f = await fixture(),
        snapshot = await f.snapshots.capture(f.input)
      const files = join(f.snapshotRoot, snapshot.id, "files")
      if (mode === "change") await writeFile(join(files, "draft.md"), "modified stored input")
      if (mode === "missing") await rm(join(files, "draft.md"))
      if (mode === "extra") await writeFile(join(files, "unlisted.txt"), "unlisted source")
      if (mode === "empty-directory-missing") await rmdir(join(files, "inputs/empty"))
      const branch = await f.destination()
      await expect(
        f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {})
      ).rejects.toThrow("FILES_CHANGED")
      expect(await readdir(branch)).toEqual([])
    }
  )
  it.each([".env", ".git", "secrets.json", "private.key", ".aws"])(
    "fails a complete snapshot explicitly instead of silently dropping sensitive path %s",
    async (name) => {
      const f = await fixture()
      await writeFile(join(f.workspace, name), "DO_NOT_COPY_LOCAL_SECRET")
      await expect(f.snapshots.capture(f.input)).rejects.toThrow("SENSITIVE_PATH")
      expect(await readdir(f.snapshotRoot)).toEqual([])
    }
  )
  it("refuses hardlinked inputs and reparse-point directories", async () => {
    const f = await fixture()
    await link(join(f.workspace, "draft.md"), join(f.workspace, "linked.md"))
    await expect(f.snapshots.capture(f.input)).rejects.toThrow()
    await rm(join(f.workspace, "linked.md"))
    const outside = await f.destination("outside")
    await symlink(
      outside,
      join(f.workspace, "reparse"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(f.snapshots.capture(f.input)).rejects.toThrow()
    expect(await readdir(f.snapshotRoot)).toEqual([])
  })
  it("refuses an oversized source file without silently truncating it", async () => {
    const f = await fixture()
    const file = await open(join(f.workspace, "oversized.bin"), "wx")
    try {
      await file.truncate(PROJECT_STAGE_SNAPSHOT_LIMITS.fileBytes + 1)
    } finally {
      await file.close()
    }
    await expect(f.snapshots.capture(f.input)).rejects.toThrow("LIMIT")
    expect(await readdir(f.snapshotRoot)).toEqual([])
  })
  it("does not overwrite nonempty branches or restore over the original/store/source roots", async () => {
    const f = await fixture(),
      snapshot = await f.snapshots.capture(f.input)
    const branch = await f.destination()
    await writeFile(join(branch, "keep.txt"), "Must remain intact")
    await expect(
      f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {})
    ).rejects.toThrow("DESTINATION_NOT_EMPTY")
    expect(await readFile(join(branch, "keep.txt"), "utf8")).toBe("Must remain intact")
    for (const path of [f.workspace, f.root, f.retained.root, f.snapshotRoot])
      await expect(
        f.snapshots.materialize(snapshot.id, f.input.scopeKey, path, () => {})
      ).rejects.toThrow("SCOPE_OVERLAP")
  })
  it("detects actual original input edits during capture and never publishes a valid snapshot", async () => {
    const f = await fixture()
    let calls = 0
    await expect(
      f.snapshots.capture({
        ...f.input,
        guard: () => {
          if (++calls === 8) writeFileSync(join(f.workspace, "draft.md"), "Raced original input")
        }
      })
    ).rejects.toThrow("PACKAGE_CHANGED")
    expect(await readdir(f.snapshotRoot)).toEqual([])
  })
  it("keeps full input checks bounded while retaining authority checks at every copied file", async () => {
    const f = await fixture()
    for (let index = 0; index < 32; index++)
      await writeFile(join(f.workspace, `extra-${index}.txt`), `original-${index}`)
    let authorityChecks = 0, fullChecks = 0
    const snapshot = await f.snapshots.capture({ ...f.input,
      guard: () => { authorityChecks++ },
      assertInputsCurrent: () => { fullChecks++ }
    })
    expect(snapshot.files).toHaveLength(35)
    expect(authorityChecks).toBeGreaterThan(32 * 4)
    expect(fullChecks).toBeGreaterThan(1)
    expect(fullChecks).toBeLessThan(16)
    expect(f.snapshots.read(snapshot.id, f.input.scopeKey).files).toEqual(snapshot.files)
  })
  it.each(["copy", "publication", "after-publication"])("rejects external input changes during %s before returning the captured workspace", async phase => {
    const f = await fixture()
    const external = join(f.root, "external-context.txt")
    await writeFile(external, "original context")
    let authorityChecks = 0, fullChecks = 0
    await expect(f.snapshots.capture({ ...f.input,
      guard: () => {
        authorityChecks++
        if (phase === "copy" ? authorityChecks === 8 : phase === "after-publication" &&
          readdirSync(f.snapshotRoot).some(id => existsSync(join(f.snapshotRoot, id, "snapshot.json"))))
          writeFileSync(external, "modified context")
      },
      assertInputsCurrent: () => {
        fullChecks++
        if (phase === "publication" && fullChecks === 3)
          writeFileSync(external, "modified context")
        if (readFileSync(external, "utf8") !== "original context")
          throw Error("SOURCE_CONTENT_CHANGED")
      }
    })).rejects.toThrow("SOURCE_CONTENT_CHANGED")
    expect(fullChecks).toBeGreaterThan(1)
    expect(await readdir(f.snapshotRoot)).toEqual([])
  })
  it("refuses a metadata target created concurrently before publication", async () => {
    const f = await fixture()
    let fullChecks = 0
    await expect(f.snapshots.capture({ ...f.input,
      assertInputsCurrent: () => {
        if (++fullChecks !== 3) return
        const [id] = readdirSync(f.snapshotRoot)
        expect(id).toMatch(/^[a-f0-9]{64}$/)
        writeFileSync(join(f.snapshotRoot, id, "snapshot.json"), "concurrent owner", { flag: "wx" })
      }
    })).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readdir(f.snapshotRoot)).toEqual([])
  })
  it("detects retained runtime changes and rejects mismatched original operation/version", async () => {
    const f = await fixture()
    await expect(
      f.snapshots.capture({
        ...f.input,
        operation: { ...f.operation, expectedVersion: f.project.version + 1 }
      })
    ).rejects.toThrow("OPERATION_CHANGED")
    await writeFile(
      join(f.retained.root, "devclaw.project-runtime.json"),
      JSON.stringify({
        ...f.project.manifest,
        plugin: { ...f.project.manifest.plugin, version: "9.0.0" }
      })
    )
    await expect(f.snapshots.capture(f.input)).rejects.toThrow("SOURCE_CHANGED")
  })
  it("honors cancellation and native scope revocation without granting a restored execution", async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort(Error("NATIVE_STAGE_CANCELLED"))
    await expect(f.snapshots.capture({ ...f.input, signal: controller.signal })).rejects.toThrow(
      "NATIVE_STAGE_CANCELLED"
    )
    const snapshot = await f.snapshots.capture(f.input),
      branch = await f.destination()
    await expect(
      f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {
        throw Error("NATIVE_SCOPE_CHANGED")
      })
    ).rejects.toThrow("NATIVE_SCOPE_CHANGED")
    expect(await readdir(branch)).toEqual([])
    expect(f.projects.getOperation(f.operation.operationId)?.status).toBe("prepared")
  })
  it("rejects concurrent captures and restores into the same native branch", async () => {
    const f = await fixture()
    const first = f.snapshots.capture(f.input)
    await expect(f.snapshots.capture(f.input)).rejects.toThrow("BUSY")
    const snapshot = await first,
      branch = await f.destination()
    const restores = await Promise.allSettled([
      f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {}),
      f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {})
    ])
    expect(restores.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(restores.filter((result) => result.status === "rejected")).toHaveLength(1)
  })
  it("rejects an unexpected destination file added during restoration instead of admitting a dirty branch", async () => {
    const f = await fixture(),
      snapshot = await f.snapshots.capture(f.input)
    const branch = await f.destination()
    let injected = false
    await expect(
      f.snapshots.materialize(snapshot.id, f.input.scopeKey, branch, () => {
        if (!injected && existsSync(join(branch, "draft.md"))) {
          injected = true
          writeFileSync(join(branch, "unexpected.txt"), "Not part of admitted input")
        }
      })
    ).rejects.toThrow("FILES_CHANGED")
    expect(injected).toBe(true)
    expect(await readFile(join(branch, "unexpected.txt"), "utf8")).toBe(
      "Not part of admitted input"
    )
  })
})
