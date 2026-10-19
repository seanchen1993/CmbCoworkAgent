import { describe, expect, it } from "vitest"
import { ProjectCompositionPreviews } from "./composition-preview"
import type { CompositionCatalogSnapshot } from "../../plugins/project-composition-catalog"

function fixture(dependencies: string[] = []) {
  let now = 1000
  let current = true
  const previews = new ProjectCompositionPreviews(() => now)
  const scope = { threadId: "thread", projectId: "project", expectedWorkspace: "C:/work" }
  const source = { pluginId: "installed", capabilityId: "delivery", packageDigest: "a".repeat(64) }
  const snapshot: CompositionCatalogSnapshot = {
    revision: "revision",
    diagnostics: [],
    sources: [
      {
        plugin: { id: "installed", name: "plugin", version: "1", enabled: true, path: "C:/plugin",
          description: "", author: "", skillCount: 1, mcpServerCount: 0, createdAt: "", updatedAt: "" },
        capability: {
          id: "delivery",
          title: "交付",
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json",
          dependsOn: dependencies
        },
        entry: {
          source,
          title: "交付",
          sourceName: "plugin",
          kind: "flow",
          available: true,
          reasons: [],
          inputs: [],
          outputs: [{ id: "report", title: "报告", path: "report.md" }]
        }
      }
    ]
  }
  previews.remember(
    scope,
    {
      identity: "incarnation-one",
      projectName: "Project",
      assertCurrent: () => {
        if (!current) throw Error("changed")
      }
    },
    snapshot
  )
  const definition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "project",
    workspace: "C:/work",
    units: [
      {
        id: "first",
        kind: "flow",
        source,
        inputs: [],
        outputs: [{ id: "report", path: "report.md" }]
      }
    ]
  }
  return {
    previews,
    scope,
    definition,
    snapshot,
    expire: () => {
      now += 600_001
    },
    change: () => {
      current = false
    }
  }
}
describe("host-owned project composition previews", () => {
  it("returns an immutable confirmed definition and supports uncertain-response retries", () => {
    const f = fixture()
    const preview = f.previews.preview(f.scope, "revision", f.definition)
    expect(preview.issues).toEqual([])
    preview.definition.units[0].outputs[0].path = "tampered.md"
    const first = f.previews.consume(f.scope, preview.id)
    expect(first.preview.definition.units[0].outputs[0].path).toBe("report.md")
    expect(f.previews.consume(f.scope, preview.id).preview).toEqual(first.preview)
  })
  it("rejects cross-project access, stale incarnation, stale revision and expiry", () => {
    const f = fixture()
    const preview = f.previews.preview(f.scope, "revision", f.definition)
    expect(() => f.previews.consume({ ...f.scope, threadId: "other" }, preview.id)).toThrow()
    expect(() => f.previews.preview(f.scope, "old", f.definition)).toThrow("CATALOG_CHANGED")
    expect(() =>
      f.previews.preview(f.scope, "revision", { ...f.definition, parentProjectId: "other" })
    ).toThrow()
    f.change()
    expect(() => f.previews.consume(f.scope, preview.id)).toThrow("changed")
    f.expire()
    expect(() => f.previews.consume(f.scope, preview.id)).toThrow("EXPIRED")
  })
  it("does not authorize altered outputs, undeclared inputs or unselected dependencies", () => {
    const f = fixture(["prepare"])
    f.definition.units[0].outputs[0].path = "other.md"
    const preview = f.previews.preview(f.scope, "revision", f.definition)
    expect(preview.issues).toHaveLength(2)
    expect(() => f.previews.consume(f.scope, preview.id)).toThrow("INVALID")
  })
  it("cannot activate unavailable skills or a different installed source", () => {
    const f = fixture()
    f.definition.units[0].source.pluginId = "unselected"
    expect(f.previews.preview(f.scope, "revision", f.definition).issues.length).toBeGreaterThan(0)
  })
  it("binds confirmation to one request while allowing the same request to retry", () => {
    const f = fixture()
    const preview = f.previews.preview(f.scope, "revision", f.definition)
    f.previews.consume(f.scope, preview.id, "one")
    expect(() => f.previews.consume(f.scope, preview.id, "one")).not.toThrow()
    expect(() => f.previews.consume(f.scope, preview.id, "two")).toThrow("ALREADY_USED")
  })
})
