import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import AdmZip from "adm-zip"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ProjectAuthoringSessions } from "./project-authoring-session"
import { ModControlStore } from "../control-store"
import type { DevelopmentScope } from "../v2/development-session"
import { readProjectSource } from "./project-source"

const scope: DevelopmentScope = {
  threadId: "persistent-project",
  workspace: "creator-workspace",
  incarnation: { token: "same-chat", legacyCreatedAt: 1 }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creator-project-persistence-"))
  const settings = new ModControlStore(join(root, "control.sqlite"))
  const sourceRoot = join(root, "sources")
  const make = () => {
    const sessions = new ProjectAuthoringSessions()
    sessions.configurePersistence(settings, sourceRoot)
    return sessions
  }
  cleanup.push(async () => {
    settings.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("creator-project-persistence-")
    )
      throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  return { root, settings, sourceRoot, make, sessions: make() }
}

it("saves, restores and actually packs every admitted text resource without executing it", async () => {
  const f = await fixture()
  const guard = () => undefined
  const draft = await f.sessions.scaffold(scope, "resources", "文本资源", guard)
  const resources = ["mjs", "cjs", "mts", "cts", "py", "sh", "ps1", "txt"].map((suffix) => ({
    path: `hooks/resource.${suffix}`,
    text: `NEVER_EXECUTE_${suffix}\n精确保留\r\n`
  }))
  const saved = await f.sessions.save(
    scope,
    {
      id: draft.id,
      name: draft.name,
      revision: draft.revision,
      files: [...draft.source.files, ...resources]
    },
    guard
  )
  const restored = f.make()
  expect(restored.read(scope, draft.id).source).toEqual(saved.source)
  const packed = await restored.inspect(scope, draft.id, saved.revision, "pack", guard)
  if (
    !packed ||
    typeof packed !== "object" ||
    !("output" in packed) ||
    typeof packed.output !== "string"
  )
    throw Error("Expected ZIP")
  const archive = new AdmZip(packed.output)
  for (const resource of resources) expect(archive.readAsText(resource.path)).toBe(resource.text)
  const unpacked = join(f.root, "unpacked")
  archive.extractAllTo(unpacked, false)
  expect((await readProjectSource(unpacked)).bundle).toEqual(saved.source)
  expect(restored.developmentStatus(scope, draft.id)).toBeUndefined()
})

it("restores immutable source and trial requests after restart without restoring execution or authority", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "warehouse", "数仓", () => {}, "harness-data")
  await f.sessions.requestTrial(scope, draft.id, draft.revision, "受控数仓样例", () => {})
  const original = f.sessions.trialRequest(scope)!
  const running = f.sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {})
  expect(f.sessions.developmentStatus(scope, draft.id)?.activeRuns).toBe(1)
  const restored = f.make()
  expect(restored.list(scope)[0].source).toEqual(draft.source)
  expect(restored.trialRequest(scope)).toEqual(original)
  expect(restored.developmentStatus(scope, draft.id)).toBeUndefined()
  expect(() => restored.acquireDevelopment(scope, draft.id, draft.revision, () => {})).toThrow(
    "PROJECT_DEV_MISSING"
  )
  await restored.requestTrial(scope, draft.id, draft.revision, "重新明确确认", () => {})
  expect(restored.developmentStatus(scope, draft.id)).toMatchObject({
    activeRuns: 0,
    status: "prepared",
    executed: false
  })
  expect(restored.trialRequest(scope)?.id).not.toBe(original.id)
  running.release()
})

it("uses the configured trial root only for new trials while retaining old workspaces and scope guards", async () => {
  const f = await fixture()
  const guard = () => {}
  const draft = await f.sessions.scaffold(scope, "workspace", "隔离试用", guard)
  await f.sessions.requestTrial(scope, draft.id, draft.revision, "原试用", guard)
  const legacy = f.sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)
  const legacyWorkspace = legacy.snapshot.workspace
  await writeFile(join(legacyWorkspace, "legacy.txt"), "Retained trial evidence")
  legacy.release()
  const restoredDirectory = f.make().read(scope, draft.id).directory

  const trialRoot = join(f.root, "project-trials")
  const make = () => {
    const sessions = new ProjectAuthoringSessions()
    sessions.configurePersistence(f.settings, f.sourceRoot, trialRoot)
    return sessions
  }
  const sessions = make()
  expect(sessions.read(scope, draft.id).directory).toBe(restoredDirectory)
  expect(sessions.read(scope, draft.id).source).toEqual(draft.source)
  expect(sessions.developmentStatus(scope, draft.id)).toBeUndefined()
  await sessions.inspect(scope, draft.id, draft.revision, "dev", guard)

  // The native recovery caller supplies its checked, retained project workspace.
  const recovered = sessions.acquireDevelopment(
    scope,
    draft.id,
    draft.revision,
    guard,
    legacyWorkspace
  )
  expect(recovered.snapshot.workspace).toBe(legacyWorkspace)
  expect(await readFile(join(legacyWorkspace, "legacy.txt"), "utf8")).toBe(
    "Retained trial evidence"
  )
  recovered.release()

  const first = sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)
  expect(dirname(first.snapshot.workspace)).toBe(trialRoot)
  expect(await readdir(first.snapshot.workspace)).toEqual([])
  expect(first.snapshot.packagePath).toBe(recovered.snapshot.packagePath)
  expect(first.snapshot.packagePath.startsWith(f.sourceRoot)).toBe(true)
  expect(first.snapshot.digest).toBe(legacy.snapshot.digest)
  expect(() => sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)).toThrow(
    "PROJECT_DEV_RUNNING"
  )
  expect(() => sessions.configurePersistence(f.settings, f.sourceRoot, trialRoot)).toThrow(
    "PROJECT_DRAFT_PERSISTENCE_BUSY"
  )
  for (const other of [
    { ...scope, threadId: "other-chat" },
    { ...scope, workspace: "other-workspace" },
    { ...scope, incarnation: { token: "recreated", legacyCreatedAt: 2 } }
  ]) {
    expect(() => sessions.acquireDevelopment(other, draft.id, draft.revision, guard)).toThrow(
      "PROJECT_DRAFT_MISSING"
    )
  }
  await writeFile(join(first.snapshot.workspace, "earlier.txt"), "Earlier goal output")
  first.release()

  const beforeRevocation = await readdir(trialRoot)
  expect(() =>
    sessions.acquireDevelopment(scope, draft.id, draft.revision, () => {
      throw Error("revoked")
    })
  ).toThrow("revoked")
  expect(await readdir(trialRoot)).toEqual(beforeRevocation)
  const second = sessions.acquireDevelopment(scope, draft.id, draft.revision, guard)
  expect(second.snapshot.workspace).not.toBe(first.snapshot.workspace)
  expect(await readdir(second.snapshot.workspace)).toEqual([])
  second.release()

  const restarted = make()
  expect(restarted.read(scope, draft.id).source).toEqual(draft.source)
  expect(restarted.developmentStatus(scope, draft.id)).toBeUndefined()
  await restarted.inspect(scope, draft.id, draft.revision, "dev", guard)
  const third = restarted.acquireDevelopment(scope, draft.id, draft.revision, guard)
  try {
    expect(dirname(third.snapshot.workspace)).toBe(trialRoot)
    expect([legacyWorkspace, first.snapshot.workspace, second.snapshot.workspace]).not.toContain(
      third.snapshot.workspace
    )
    expect(third.snapshot.digest).toBe(first.snapshot.digest)
    expect(await readdir(third.snapshot.workspace)).toEqual([])
    expect(await readFile(join(first.snapshot.workspace, "earlier.txt"), "utf8")).toBe(
      "Earlier goal output"
    )
    expect(await readFile(join(legacyWorkspace, "legacy.txt"), "utf8")).toBe(
      "Retained trial evidence"
    )
  } finally {
    third.release()
  }
})

it("retains checked business origin as provenance across restart without restoring Host execution", async () => {
  const f = await fixture()
  const first = await f.sessions.scaffold(scope, "independent", "独立业务", () => {})
  const resource = { path: "arbitrary-business/policy.md", text: "既有声明资源，不丢失\r\n" }
  const draft = await f.sessions.save(
    scope,
    {
      id: first.id,
      name: first.name,
      revision: first.revision,
      files: [...first.source.files, resource]
    },
    () => {},
    [resource.path]
  )
  const origin = {
    kind: "business-assembly" as const,
    planId: "12345678-1234-1234-1234-123456789abc",
    copyId: "23456789-1234-1234-1234-123456789abc",
    digest: "b".repeat(64)
  }
  await f.sessions.requestTrial(
    scope,
    draft.id,
    draft.revision,
    "核对声明产物",
    () => {},
    [],
    origin
  )
  const restored = f.make()
  expect(restored.read(scope, draft.id).resourcePaths).toEqual([resource.path])
  expect(restored.trialRequest(scope)?.origin).toEqual(origin)
  expect(restored.developmentStatus(scope, draft.id)).toBeUndefined()
  expect(() => restored.acquireDevelopment(scope, draft.id, draft.revision, () => {})).toThrow(
    "PROJECT_DEV_MISSING"
  )
  await expect(
    restored.requestTrial(scope, draft.id, draft.revision, "invalid", () => {}, [], {
      ...origin,
      digest: "unverified"
    })
  ).rejects.toThrow("PROJECT_TRIAL_ORIGIN_INVALID")
  expect(restored.trialRequest(scope)?.origin).toEqual(origin)
  await restored.requestTrial(scope, draft.id, draft.revision, "重新明确确认", () => {}, [], origin)
  const lease = restored.acquireDevelopment(scope, draft.id, draft.revision, () => {})
  try {
    expect(await readFile(join(lease.snapshot.packagePath, resource.path), "utf8")).toBe(
      resource.text
    )
  } finally {
    lease.release()
  }
})

it("can recover missing materialized directories and rejects concurrent stale source commits", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "docs", "文档", () => {})
  const old = f.make()
  old.read(scope, draft.id)
  await rm(f.sourceRoot, { recursive: true, force: true })
  const fresh = f.make()
  const recovered = fresh.read(scope, draft.id)
  expect(await fresh.inspect(scope, draft.id, draft.revision, "pack", () => {})).toMatchObject({
    sourceDigest: draft.source.digest
  })
  expect(await readFile(join(recovered.directory, "plugin.json"), "utf8")).toContain(
    '"name": "docs"'
  )
  const next = await fresh.save(
    scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
    () => {}
  )
  await expect(
    old.save(
      scope,
      { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
      () => {}
    )
  ).rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  expect(f.make().read(scope, draft.id).revision).toBe(next.revision)
})

it("cancels recovery after a partial staged write without poisoning the final source or retry", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "atomic-docs", "Atomic source", () => {})
  await f.sessions.requestTrial(scope, draft.id, draft.revision, "Review source", () => {})
  const restored = f.make()
  const retained = restored.read(scope, draft.id)
  const parent = dirname(retained.directory)
  let interrupted = false
  const guard = () => {
    const staging = readdirSync(parent).find((name) => name.startsWith(".project-source-"))
    if (staging && existsSync(join(parent, staging, retained.source.files[0].path))) {
      interrupted = true
      throw Error("RECOVERY_REVOKED_MID_WRITE")
    }
  }
  await expect(restored.materializeForDelivery(scope, draft.id, draft.revision,
    draft.source.digest, guard)).rejects.toThrow("RECOVERY_REVOKED_MID_WRITE")
  expect(interrupted).toBe(true)
  expect(existsSync(retained.directory)).toBe(false)
  expect((await readdir(parent)).some((name) => name.startsWith(".project-source-"))).toBe(false)
  await restored.materializeForDelivery(scope, draft.id, draft.revision, draft.source.digest, () => {})
  expect((await readProjectSource(retained.directory)).bundle.digest).toBe(draft.source.digest)
  expect(restored.developmentStatus(scope, draft.id)).toBeUndefined()
})

it("accepts concurrent exact recovery publications but never overwrites an existing foreign directory", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "concurrent-docs", "Concurrent source", () => {})
  await f.sessions.requestTrial(scope, draft.id, draft.revision, "Review source", () => {})
  const left = f.make(), right = f.make()
  const retained = left.read(scope, draft.id)
  await Promise.all([left, right].map((sessions) => sessions.materializeForDelivery(
    scope, draft.id, draft.revision, draft.source.digest, () => {})))
  expect((await readProjectSource(retained.directory)).bundle.digest).toBe(draft.source.digest)
  expect((await readdir(dirname(retained.directory))).some((name) =>
    name.startsWith(".project-source-"))).toBe(false)
  await rm(retained.directory, { recursive: true })
  await mkdir(retained.directory)
  await writeFile(join(retained.directory, "foreign.txt"), "Retain foreign bytes")
  await expect(left.materializeForDelivery(scope, draft.id, draft.revision,
    draft.source.digest, () => {})).rejects.toThrow()
  expect(await readFile(join(retained.directory, "foreign.txt"), "utf8")).toBe("Retain foreign bytes")
  expect(await readdir(retained.directory)).toEqual(["foreign.txt"])
})

it("binds recovered sources to the exact original chat incarnation and rejects edited source bytes", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "docs", "文档", () => {})
  const nextScope = { ...scope, incarnation: { token: "new-chat", legacyCreatedAt: 1 } }
  expect(f.make().list(nextScope)).toEqual([])
  const restored = f.make()
  const recovered = restored.read(scope, draft.id)
  await mkdir(recovered.directory, { recursive: true })
  for (const file of recovered.source.files) {
    await mkdir(dirname(join(recovered.directory, file.path)), { recursive: true })
    await writeFile(join(recovered.directory, file.path), file.text)
  }
  await writeFile(join(recovered.directory, "plugin.json"), '{"name":"tampered"}')
  await expect(restored.inspect(scope, draft.id, draft.revision, "dev", () => {})).rejects.toThrow(
    "PROJECT_SOURCE_CHANGED"
  )
})

it("invalidates the old trial request after source changes and does not reuse its confirmation", async () => {
  const f = await fixture()
  const draft = await f.sessions.scaffold(scope, "docs", "文档", () => {})
  await f.sessions.requestTrial(scope, draft.id, draft.revision, "写一份真实文档", () => {})
  await f.sessions.save(
    scope,
    { id: draft.id, name: draft.name, revision: draft.revision, files: draft.source.files },
    () => {}
  )
  expect(f.sessions.trialRequest(scope)).toBeUndefined()
  expect(f.make().trialRequest(scope)).toBeUndefined()
})
