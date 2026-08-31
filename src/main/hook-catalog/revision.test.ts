import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import {
  bumpHookCatalogGlobalRevision,
  bumpHookCatalogWorkspaceRevision,
  getHookCatalogGlobalRevision,
  getHookCatalogWorkspaceRevision,
  resetHookCatalogRevisionsForTests
} from "./revision"

describe("hook catalog main-process revisions", () => {
  beforeEach(() => resetHookCatalogRevisionsForTests())

  it("shares one global epoch and normalizes equivalent workspace paths", () => {
    expect(getHookCatalogGlobalRevision()).toBe(0)
    expect(bumpHookCatalogGlobalRevision()).toBe(1)
    expect(getHookCatalogGlobalRevision()).toBe(1)

    bumpHookCatalogWorkspaceRevision("C:\\repo\\")
    expect(getHookCatalogWorkspaceRevision("C:/repo")).toBe(1)
    expect(getHookCatalogWorkspaceRevision("C:/other")).toBe(0)
  })

  it("keeps every direct skill write broadcaster connected to the main epoch", () => {
    const notifications = readFileSync(
      new URL("../hooks/notifications.ts", import.meta.url),
      "utf8"
    )
    const evolution = readFileSync(
      new URL("../agent/tools/skill-evolution-tool.ts", import.meta.url),
      "utf8"
    )
    const optimizer = readFileSync(new URL("../ipc/optimizer.ts", import.meta.url), "utf8")
    const pluginFiles = readFileSync(
      new URL("../ipc/plugin-files.ts", import.meta.url),
      "utf8"
    )
    expect(notifications).toContain("bumpHookCatalogGlobalRevision()")
    expect(evolution).toContain(
      'if (channel === "skills:changed") bumpHookCatalogGlobalRevision()'
    )
    const applyCandidate = optimizer.slice(
      optimizer.indexOf("function applyCandidate"),
      optimizer.indexOf("function ensureEvolvedSkillMarker")
    )
    const writeIndex = applyCandidate.indexOf('writeFileSync(join(skillDir, "SKILL.md")')
    const revisionIndex = applyCandidate.indexOf("bumpHookCatalogGlobalRevision()")
    const invalidationIndex = applyCandidate.indexOf("invalidateEnabledSkillsCache()")
    const notificationIndex = applyCandidate.indexOf('notifyRenderer("skills:changed")')
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(revisionIndex).toBeGreaterThan(writeIndex)
    expect(invalidationIndex).toBeGreaterThan(revisionIndex)
    expect(notificationIndex).toBeGreaterThan(invalidationIndex)
    expect(pluginFiles).toMatch(
      /const payload = \{ reason \}\s+bumpHookCatalogGlobalRevision\(\)/
    )
  })
})
