import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { createProjectActionBinding } from "../harness-board/project-runtime/action-input"
import { readProjectDependencyIds } from "./project-dependency-metadata"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const actual = realpathSync(root)
    expect(dirname(actual)).toBe(realpathSync(tmpdir()))
    expect(basename(actual)).toMatch(/^project-dependency-metadata-[a-zA-Z0-9]{6}$/)
    rmSync(actual, { recursive: true, force: true })
  }
})

function fixture(ids: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "project-dependency-metadata-"))
  roots.push(root)
  const plugin = { id: "project-one", path: root }
  const manifest = hostProjectFixture(root).manifest
  const lock = {
    apiVersion: "devclaw.project-actions-lock/v1",
    bindings: ids.map((pluginId, index) =>
      createProjectActionBinding(
        `action-${index}`,
        {
          pluginId,
          plugin: "same-display-name",
          digest: "a".repeat(64),
          actionId: "work",
          name: "Work",
          command: "work",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        },
        {},
        {}
      )
    )
  }
  manifest.actions = lock.bindings.map(({ id, ref }) => ({ id, ref: { ...ref } }))
  manifest.stages[0].actionIds = manifest.actions.map(({ id }) => id)
  const save = () => {
    writeFileSync(join(root, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    writeFileSync(join(root, "devclaw.project-actions.lock.json"), JSON.stringify(lock))
  }
  save()
  return { plugin, manifest, lock, save, root }
}

it("uses exact installed IDs, deduplicates shared dependencies and excludes self/missing IDs", async () => {
  const a = fixture(["provider-b", "provider-a", "provider-b", "project-one", "missing"])
  const b = fixture(["provider-b"])
  const installed = new Set(["project-one", "provider-a", "provider-b", "unrelated-same-name"])
  expect(await readProjectDependencyIds(a.plugin, installed)).toEqual(["provider-a", "provider-b"])
  expect(await readProjectDependencyIds(b.plugin, installed)).toEqual(["provider-b"])
  expect([...installed]).toContain("unrelated-same-name")
})

it("keeps a valid project identifiable even without installed dependencies or an optional lock", async () => {
  const a = fixture()
  rmSync(join(a.root, "devclaw.project-actions.lock.json"))
  expect(await readProjectDependencyIds(a.plugin, new Set())).toEqual([])
  const b = fixture(["missing-provider"])
  expect(await readProjectDependencyIds(b.plugin, new Set())).toEqual([])
})

it("keeps a project identifiable when another project references its exact installed ID", async () => {
  const project = fixture()
  const consumer = fixture([project.plugin.id])
  consumer.plugin.id = "other-project"
  const installed = new Set([project.plugin.id, consumer.plugin.id])
  expect(await readProjectDependencyIds(consumer.plugin, installed)).toEqual([project.plugin.id])
  expect(await readProjectDependencyIds(project.plugin, installed)).toEqual([])
})

it("fails visible for missing required locks, invalid JSON and mismatched action identities", async () => {
  const a = fixture(["provider"])
  const path = join(a.root, "devclaw.project-actions.lock.json")
  const installed = new Set(["provider"])
  rmSync(path)
  expect(await readProjectDependencyIds(a.plugin, installed)).toBeUndefined()
  writeFileSync(path, "{")
  expect(await readProjectDependencyIds(a.plugin, installed)).toBeUndefined()
  a.lock.bindings[0].ref.pluginId = "wrong-provider"
  a.save()
  expect(await readProjectDependencyIds(a.plugin, installed)).toBeUndefined()
})

it("does not classify ordinary, legacy or damaged runtime declarations as Host projects", async () => {
  const a = fixture()
  a.manifest.mode = "legacy"
  a.manifest.stateOwner = "plugin"
  a.save()
  expect(await readProjectDependencyIds(a.plugin, new Set())).toBeUndefined()
  writeFileSync(join(a.root, "devclaw.project-runtime.json"), "{}")
  expect(await readProjectDependencyIds(a.plugin, new Set())).toBeUndefined()
  const ordinary = join(a.root, "ordinary")
  mkdirSync(ordinary)
  expect(
    await readProjectDependencyIds({ id: "ordinary", path: ordinary }, new Set())
  ).toBeUndefined()
})
