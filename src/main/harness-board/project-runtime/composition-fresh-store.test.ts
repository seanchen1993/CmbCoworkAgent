import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
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
  it("fails closed and releases every invalid database handle before in-process recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "composition-corrupt-"))
    const path = join(root, "state.sqlite")
    const close = vi.spyOn(DatabaseSync.prototype, "close")
    const work = vi.fn()
    try {
      writeFileSync(path, "invalid SQLite contents".repeat(128))
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(() => new ProjectCompositionStore(path).guardWorkspaceMutation(root, work))
          .toThrow(/not a database/i)
      }
      expect(work).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(3)
      rmSync(path)
      const repaired = new ProjectCompositionStore(path)
      try {
        repaired.guardWorkspaceMutation(root, work)
        expect(work).toHaveBeenCalledOnce()
      } finally {
        repaired.close()
      }
    } finally {
      close.mockRestore()
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
