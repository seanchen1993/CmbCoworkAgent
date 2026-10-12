import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ root: "" }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => fixture.root,
  getCustomSkillsDir: () => join(fixture.root, "skills"),
  getPluginsDir: () => join(fixture.root, "plugins"),
  invalidateEnabledSkillsCache: vi.fn()
}))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))

import { startHookConfigWatcher, stopHookConfigWatcher } from "./hook-config-watcher"
import {
  getHookCatalogGlobalRevision,
  resetHookCatalogRevisionsForTests
} from "../hook-catalog/revision"

afterEach(async () => {
  stopHookConfigWatcher()
  resetHookCatalogRevisionsForTests()
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  fixture.root = ""
})

it("continues watching a skill root replaced with a new directory", async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "cmb-hook-watch-"))
  const skills = join(fixture.root, "skills")
  await mkdir(skills)
  await mkdir(join(fixture.root, "plugins"))
  await startHookConfigWatcher()
  const beforeInitialWrite = getHookCatalogGlobalRevision()
  await writeFile(join(skills, "SKILL.md"), "initial")
  // Native filesystem events are asynchronous and have no 1-second delivery
  // contract. Use the same bounded deadline for all three observed changes;
  // never rewrite the file while waiting, which could conceal a lost event.
  await vi.waitFor(
    () => expect(getHookCatalogGlobalRevision()).toBeGreaterThan(beforeInitialWrite),
    {
      timeout: 3000
    }
  )
  const beforeReplacement = getHookCatalogGlobalRevision()
  await rename(skills, join(fixture.root, "retired-skills"))
  await mkdir(skills)
  await vi.waitFor(
    () => expect(getHookCatalogGlobalRevision()).toBeGreaterThan(beforeReplacement),
    { timeout: 3000 }
  )
  // Drain the native rename batch and the 150 ms renderer debounce. Only an
  // edit made after that batch can prove that the new directory is watched.
  await delay(350)
  const beforeEdit = getHookCatalogGlobalRevision()
  await writeFile(join(skills, "SKILL.md"), "replacement")
  await vi.waitFor(() => expect(getHookCatalogGlobalRevision()).toBeGreaterThan(beforeEdit), {
    timeout: 3000
  })
}, 12000)
