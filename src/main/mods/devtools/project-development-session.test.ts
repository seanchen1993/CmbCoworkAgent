import { readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import * as tooling from "./project-tooling"
import type { DevelopmentScope } from "../v2/development-session"
import { ProjectAuthoringSessions } from "./project-authoring-session"

const scope: DevelopmentScope = {
  threadId: "development-project",
  workspace: "test-workspace",
  incarnation: { token: "first", legacyCreatedAt: 1 }
}
const roots = new Set<string>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots) {
    const target = resolve(root)
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("devclaw-project-authoring-")
    )
      throw Error("Unsafe test cleanup path")
    await rm(target, { recursive: true, force: true })
  }
  roots.clear()
})
async function fixture() {
  const sessions = new ProjectAuthoringSessions()
  const draft = await sessions.scaffold(scope, "preview", "Preview", () => undefined)
  roots.add(dirname(draft.directory))
  await sessions.inspect(scope, draft.id, draft.revision, "dev", () => undefined)
  const save = (revision: number, suffix: string, guard = () => undefined) =>
    sessions.save(
      scope,
      {
        id: draft.id,
        name: draft.name,
        revision,
        files: draft.source.files.map((file) =>
          file.path === "skills/draft/SKILL.md" ? { ...file, text: file.text + suffix } : file
        )
      },
      guard
    )
  return { sessions, draft, save }
}

it("updates the same idle preview while keeping previous package bytes and workspace", async () => {
  const { sessions, save } = await fixture()
  const first = sessions.developmentStatus(scope, "preview")!
  const previousBytes = await readFile(join(first.packagePath, "skills/draft/SKILL.md"), "utf8")
  const next = await save(1, "\nNew version instructions.\n")
  expect(next.development).toMatchObject({
    devId: first.devId,
    workspace: first.workspace,
    currentRevision: 2,
    activeRuns: 0,
    pendingRevision: null,
    updateState: "current"
  })
  expect(next.development!.packagePath).not.toBe(first.packagePath)
  expect(await readFile(join(first.packagePath, "skills/draft/SKILL.md"), "utf8")).toBe(
    previousBytes
  )
  expect(await sessions.inspect(scope, "preview", 2, "test", () => undefined)).toMatchObject({
    valid: true
  })
  expect(sessions.list(scope)[0].development?.currentRevision).toBe(2)
})

it("pins an active preview and promotes only the newest queued revision after settlement", async () => {
  const { sessions, save } = await fixture()
  const lease = sessions.acquireDevelopment(scope, "preview", 1, () => undefined)
  const second = await save(1, "\nSecond.\n")
  expect(second.development).toMatchObject({
    currentRevision: 1,
    pendingRevision: 2,
    activeRuns: 1,
    updateState: "queued"
  })
  const third = await save(2, "\nThird.\n")
  expect(third.development).toMatchObject({ currentRevision: 1, pendingRevision: 3 })
  expect(lease.snapshot.revision).toBe(1)
  expect(() => sessions.acquireDevelopment(scope, "preview", 1, () => undefined)).toThrow(
    "PROJECT_DRAFT_REVISION_CHANGED"
  )
  await expect(sessions.inspect(scope, "preview", 3, "test", () => undefined)).rejects.toThrow(
    "PROJECT_DEV_REVISION_UNAVAILABLE"
  )
  lease.release()
  lease.release()
  expect(sessions.developmentStatus(scope, "preview")).toMatchObject({
    currentRevision: 3,
    pendingRevision: null,
    activeRuns: 0
  })
})

it("invalid newer source cancels pending promotion without changing the active package", async () => {
  const { sessions, draft, save } = await fixture()
  const lease = sessions.acquireDevelopment(scope, "preview", 1, () => undefined)
  await save(1, "\nQueued.\n")
  const broken = await sessions.save(
    scope,
    {
      id: draft.id,
      name: draft.name,
      revision: 2,
      files: draft.source.files.filter((file) => file.path !== "skills/draft/SKILL.md")
    },
    () => undefined
  )
  expect(broken.development).toMatchObject({
    currentRevision: 1,
    pendingRevision: null,
    updateState: "blocked"
  })
  lease.release()
  expect(() => sessions.acquireDevelopment(scope, "preview", 1, () => undefined)).toThrow(
    "PROJECT_DRAFT_REVISION_CHANGED"
  )
  await save(3, "\nRepaired.\n")
  expect(sessions.developmentStatus(scope, "preview")).toMatchObject({
    currentRevision: 4,
    updateState: "current"
  })
})

it("does not promote after creator scope revocation and cannot cross incarnations", async () => {
  const { sessions, save } = await fixture()
  let revoked = false
  const lease = sessions.acquireDevelopment(scope, "preview", 1, () => {
    if (revoked) throw Error("revoked")
  })
  await save(1, "\nQueued.\n")
  revoked = true
  lease.release()
  expect(sessions.developmentStatus(scope, "preview")).toMatchObject({
    currentRevision: 1,
    pendingRevision: null,
    updateState: "blocked",
    diagnostics: ["PROJECT_DEV_SCOPE_CHANGED"]
  })
  const other = { ...scope, incarnation: { token: "recreated", legacyCreatedAt: 2 } }
  expect(sessions.list(other)).toEqual([])
  expect(() => sessions.acquireDevelopment(other, "preview", 1, () => undefined)).toThrow(
    "PROJECT_DRAFT_MISSING"
  )
})

it("does not publish a first preview after a newer draft won during preparation", async () => {
  const sessions = new ProjectAuthoringSessions()
  const draft = await sessions.scaffold(scope, "preview", "Preview", () => undefined)
  roots.add(dirname(draft.directory))
  const original = tooling.prepareProjectDevelopment
  let continuePreparation!: () => void
  let prepared!: () => void
  const reached = new Promise<void>((resolve) => {
    prepared = resolve
  })
  const gate = new Promise<void>((resolve) => {
    continuePreparation = resolve
  })
  vi.spyOn(tooling, "prepareProjectDevelopment").mockImplementation(async (...args) => {
    const result = await original(...args)
    prepared()
    await gate
    return result
  })
  const opening = sessions.inspect(scope, "preview", 1, "dev", () => undefined)
  const rejected = expect(opening).rejects.toThrow("PROJECT_DRAFT_REVISION_CHANGED")
  await reached
  await sessions.save(
    scope,
    { id: draft.id, name: draft.name, revision: 1, files: draft.source.files },
    () => undefined
  )
  continuePreparation()
  await rejected
  expect(sessions.developmentStatus(scope, "preview")).toBeUndefined()
  expect(() => sessions.acquireDevelopment(scope, "preview", 1, () => undefined)).toThrow(
    "PROJECT_DRAFT_REVISION_CHANGED"
  )
})

it("a completed model turn does not become a permanent preview authorization guard", async () => {
  const sessions = new ProjectAuthoringSessions()
  let turnActive = true
  const guard = () => {
    if (!turnActive) throw Error("turn ended")
  }
  const draft = await sessions.scaffold(scope, "preview", "Preview", guard)
  roots.add(dirname(draft.directory))
  await sessions.inspect(scope, "preview", 1, "dev", guard)
  turnActive = false
  const lease = sessions.acquireDevelopment(scope, "preview", 1, () => undefined)
  expect(lease.snapshot.revision).toBe(1)
  lease.release()
})

it("contract preview reads the retained package and fails closed on edited snapshot bytes", async () => {
  const { sessions } = await fixture()
  const view = sessions.developmentStatus(scope, "preview")!
  await writeFile(join(view.packagePath, "skills/draft/SKILL.md"), "tampered")
  await expect(sessions.inspect(scope, "preview", 1, "test", () => undefined)).rejects.toThrow(
    "PROJECT_SOURCE_CHANGED"
  )
  expect(sessions.developmentStatus(scope, "preview")?.activeRuns).toBe(0)
})
