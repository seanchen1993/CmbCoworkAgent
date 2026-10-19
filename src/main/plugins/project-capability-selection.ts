import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  compositionDigest,
  compositionText,
  type ProjectCompositionSource
} from "../../shared/project-runtime/composition"
import { runtimeDirectory } from "../harness-board/project-runtime/safe-files"
import { getOpenworkDir } from "../storage"

export interface ProjectCapabilitySelection {
  apiVersion: "devclaw.project-capability-selection/v1"
  revision: string
  sources: ProjectCompositionSource[]
}
export function parseProjectCapabilitySources(value: unknown): ProjectCompositionSource[] {
  if (!Array.isArray(value) || value.length > 16) throw Error("PROJECT_CAPABILITIES_LIMIT")
  const seen = new Set<string>()
  return value.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["pluginId", "capabilityId", "packageDigest"].includes(key))
    )
      throw Error("PROJECT_CAPABILITY_INVALID")
    const source = {
      pluginId: compositionText(value.pluginId),
      capabilityId: compositionText(value.capabilityId),
      packageDigest: compositionDigest(value.packageDigest)
    }
    const key = JSON.stringify([source.pluginId, source.capabilityId])
    if (seen.has(key)) throw Error("PROJECT_CAPABILITY_DUPLICATE")
    seen.add(key)
    return source
  })
}
const empty = (): ProjectCapabilitySelection => ({
  apiVersion: "devclaw.project-capability-selection/v1",
  revision: "0",
  sources: []
})

/** Durable per-project selection. It grants no execution until the original lifecycle admits it. */
export class ProjectCapabilitySelectionStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS project_capability_selections (
        project_id TEXT NOT NULL, workspace TEXT NOT NULL, revision TEXT NOT NULL, sources TEXT NOT NULL,
        PRIMARY KEY(project_id,workspace));`)
  }
  close(): void {
    this.db.close()
  }
  private workspaceKey(workspace: string): string {
    const path = resolve(workspace)
    return process.platform === "win32" ? path.toLowerCase() : path
  }
  get(projectId: string, workspace: string): ProjectCapabilitySelection {
    const row = this.db
      .prepare(
        "SELECT revision,sources FROM project_capability_selections WHERE project_id=? AND workspace=?"
      )
      .get(compositionText(projectId), this.workspaceKey(workspace))
    return row
      ? {
          apiVersion: "devclaw.project-capability-selection/v1",
          revision: compositionText(row.revision),
          sources: parseProjectCapabilitySources(JSON.parse(String(row.sources)))
        }
      : empty()
  }
  save(
    projectId: string,
    workspace: string,
    expectedRevision: string,
    value: unknown
  ): ProjectCapabilitySelection {
    const sources = parseProjectCapabilitySources(value)
    runtimeDirectory(workspace)
    const workspaceKey = this.workspaceKey(workspace)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const current = this.get(projectId, workspace)
      if (current.revision !== expectedRevision) throw Error("PROJECT_CAPABILITIES_CHANGED")
      const revision = randomUUID()
      this.db
        .prepare(
          `INSERT INTO project_capability_selections VALUES (?,?,?,?)
        ON CONFLICT(project_id,workspace) DO UPDATE SET revision=excluded.revision,sources=excluded.sources`
        )
        .run(projectId, workspaceKey, revision, JSON.stringify(sources))
      this.db.exec("COMMIT")
      return { apiVersion: "devclaw.project-capability-selection/v1", revision, sources }
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
let store: ProjectCapabilitySelectionStore | undefined
const path = () => join(getOpenworkDir(), "project-compositions", "capabilities.sqlite")
export function getProjectCapabilitySelections(): ProjectCapabilitySelectionStore {
  return (store ??= new ProjectCapabilitySelectionStore(path()))
}
/** Existing projects without any configuration keep their original zero-initialization path. */
export function readProjectCapabilitySelection(
  projectId: string,
  workspace: string
): ProjectCapabilitySelection {
  return store || existsSync(path())
    ? getProjectCapabilitySelections().get(projectId, workspace)
    : empty()
}
