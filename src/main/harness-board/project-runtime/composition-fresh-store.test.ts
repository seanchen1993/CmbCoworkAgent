import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { ProjectCompositionStore } from "./composition-store"

describe("first project flow storage", () => {
  it("keeps registered directories available after cancellation and rejects physical replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "composition-locate-"))
    const store = new ProjectCompositionStore(join(root, "state.sqlite"))
    try {
      const run = store.create(
        {
          apiVersion: "devclaw.project-composition/v1",
          parentProjectId: "parent",
          workspace: root,
          units: [
            {
              id: "first",
              kind: "flow",
              inputs: [],
              outputs: [],
              source: { pluginId: "installed", capabilityId: "flow", packageDigest: "a".repeat(64) }
            }
          ]
        },
        "request"
      ).run
      const workspace = join(root, "unit")
      mkdirSync(workspace)
      expect(store.unitWorkspace(run.id, "first")).toBeUndefined()
      store.registerUnitWorkspace(run.id, "first", workspace)
      store.cancel(run.id)
      expect(store.unitWorkspace(run.id, "first")).toBe(workspace)
      renameSync(workspace, join(root, "original-unit"))
      mkdirSync(workspace)
      expect(() => store.unitWorkspace(run.id, "first")).toThrow(
        "COMPOSITION_WORKSPACE_OWNER_CHANGED"
      )
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("creates its own database directory without prior capability configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "composition-first-"))
    try {
      const path = join(root, "fresh", "project-compositions", "state.sqlite")
      const store = new ProjectCompositionStore(path)
      store.close()
      expect(existsSync(path)).toBe(true)
      new ProjectCompositionStore(path).close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("does not create directories through a redirected existing parent", () => {
    const root = mkdtempSync(join(tmpdir(), "composition-parent-"))
    try {
      const target = join(root, "target")
      mkdirSync(target)
      symlinkSync(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
      expect(
        () => new ProjectCompositionStore(join(root, "linked", "new", "state.sqlite"))
      ).toThrow()
      expect(existsSync(join(target, "new"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
