import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
