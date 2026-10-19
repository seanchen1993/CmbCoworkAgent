import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assertOriginalProjectWorkspaceIdle } from "./composition-workspace-busy"
import { ProjectCompositionStore } from "./composition-store"

const base = resolve("output/project-composition-fixtures")
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + "/") && !root.startsWith(base + "\\"))
      throw Error("Unsafe fixture cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, "busy-"))
  roots.push(root)
  const host = join(root, "host.sqlite")
  const legacy = join(root, "legacy.sqlite")
  const workspace = join(root, "workspace")
  const db = new DatabaseSync(host)
  db.exec(
    "CREATE TABLE host_projects(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE host_operations(project_id TEXT,status TEXT)"
  )
  db.prepare("INSERT INTO host_projects VALUES (?,?)").run("p", JSON.stringify({ workspace }))
  db.close()
  const old = new DatabaseSync(legacy)
  old.exec("CREATE TABLE legacy_operations(status TEXT,data TEXT)")
  old.close()
  return { root, host, legacy, workspace }
}
describe("original project workspace admission", () => {
  it("does not impose composition filesystem rules on unrelated original entry workspaces", () => {
    const f = fixture()
    const store = new ProjectCompositionStore(join(f.root, "composition.sqlite"))
    try {
      const missing = join(f.root, "original-not-created-yet")
      expect(store.guardWorkspaceMutation(missing, () => "original path")).toBe("original path")
      mkdirSync(f.workspace)
      store.create(
        {
          apiVersion: "devclaw.project-composition/v1",
          parentProjectId: "p",
          workspace: f.workspace,
          units: [
            {
              id: "u",
              kind: "flow",
              source: { pluginId: "plugin", capabilityId: "flow", packageDigest: "a".repeat(64) },
              inputs: [],
              outputs: []
            }
          ]
        },
        "request"
      )
      expect(store.guardWorkspaceMutation(missing, () => "unrelated original path")).toBe(
        "unrelated original path"
      )
      expect(() => store.guardWorkspaceMutation(f.workspace, () => "must not run")).toThrow(
        "COMPOSITION_WORKSPACE_BUSY"
      )
    } finally {
      store.close()
    }
  })
  it("keeps the no-database and terminal-history paths available", () => {
    const f = fixture()
    expect(() =>
      assertOriginalProjectWorkspaceIdle(
        f.workspace,
        join(f.root, "missing"),
        join(f.root, "also-missing")
      )
    ).not.toThrow()
    const db = new DatabaseSync(f.host)
    for (const status of ["failed", "cancelled", "transitioned"])
      db.prepare("INSERT INTO host_operations VALUES (?,?)").run("p", status)
    db.close()
    const old = new DatabaseSync(f.legacy)
    for (const status of ["succeeded", "failed", "cancelled"])
      old
        .prepare("INSERT INTO legacy_operations VALUES (?,?)")
        .run(status, JSON.stringify({ workspace: f.workspace }))
    old.close()
    expect(() => assertOriginalProjectWorkspaceIdle(f.workspace, f.host, f.legacy)).not.toThrow()
  })
  it("fences each original host active or unresolved status, but only its workspace", () => {
    const f = fixture()
    for (const status of ["prepared", "started", "cancel_requested", "succeeded", "unknown"]) {
      const db = new DatabaseSync(f.host)
      db.exec("DELETE FROM host_operations")
      db.prepare("INSERT INTO host_operations VALUES (?,?)").run("p", status)
      db.close()
      expect(
        () => assertOriginalProjectWorkspaceIdle(f.workspace, f.host, f.legacy),
        status
      ).toThrow("COMPOSITION_WORKSPACE_BUSY")
      expect(
        () => assertOriginalProjectWorkspaceIdle(join(f.root, "other"), f.host, f.legacy),
        status
      ).not.toThrow()
    }
  })
  it("fences legacy execution and uncertain results including Windows path aliases", () => {
    const f = fixture()
    for (const status of ["started", "unknown"]) {
      const db = new DatabaseSync(f.legacy)
      db.exec("DELETE FROM legacy_operations")
      db.prepare("INSERT INTO legacy_operations VALUES (?,?)").run(
        status,
        JSON.stringify({ workspace: f.workspace })
      )
      db.close()
      const alias =
        process.platform === "win32" ? f.workspace.replaceAll("\\", "/").toUpperCase() : f.workspace
      expect(() => assertOriginalProjectWorkspaceIdle(alias, f.host, f.legacy)).toThrow(
        "COMPOSITION_WORKSPACE_BUSY"
      )
    }
  })
  it("fails closed for damaged original engine state and releases database handles", () => {
    const f = fixture()
    const db = new DatabaseSync(f.legacy)
    db.prepare("INSERT INTO legacy_operations VALUES (?,?)").run("started", "{}")
    db.close()
    expect(() => assertOriginalProjectWorkspaceIdle(f.workspace, f.host, f.legacy)).toThrow(
      "COMPOSITION_EXISTING_RUN_INVALID"
    )
    const reopened = new DatabaseSync(f.legacy)
    reopened.exec("DELETE FROM legacy_operations")
    reopened.close()
    expect(() => assertOriginalProjectWorkspaceIdle(f.workspace, f.host, f.legacy)).not.toThrow()
  })
})
