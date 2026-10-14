import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { DevelopmentScope } from "../v2/development-session"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import { prepareProjectDevelopment } from "./project-tooling"
import { inspectProjectSource } from "./project-doctor"

export interface ProjectDevelopmentDraft {
  id: string
  revision: number
  directory: string
  source: AuthoringSourceBundle
}
export interface ProjectDevelopmentSnapshot {
  devId: string
  draftId: string
  revision: number
  digest: string
  packagePath: string
  workspace: string
}
export interface ProjectDevelopmentView extends ProjectDevelopmentSnapshot {
  currentRevision: number
  currentDigest: string
  pendingRevision: number | null
  activeRuns: number
  updateState: "current" | "queued" | "blocked"
  diagnostics: string[]
  status: "prepared"
  executed: false
}
interface Entry {
  root: string
  current: ProjectDevelopmentSnapshot
  pending?: ProjectDevelopmentSnapshot
  guard: () => void
  leases: Set<object>
  diagnostics: string[]
  latestRevision: number
}
const identity = (scope: DevelopmentScope, id: string) =>
  createHash("sha256")
    .update(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation, id]))
    .digest("hex")

/** Immutable packages; only the idle preview pointer changes. No installation or execution authority. */
export class ProjectDevelopmentSessions {
  private entries = new Map<string, Entry>()
  private staging = new Set<string>()

  read(scope: DevelopmentScope, id: string): ProjectDevelopmentView | undefined {
    const entry = this.entries.get(identity(scope, id))
    if (!entry) return undefined
    return {
      ...entry.current,
      currentRevision: entry.current.revision,
      currentDigest: entry.current.digest,
      pendingRevision: entry.pending?.revision ?? null,
      activeRuns: entry.leases.size,
      updateState: entry.diagnostics.length ? "blocked" : entry.pending ? "queued" : "current",
      diagnostics: [...entry.diagnostics],
      status: "prepared",
      executed: false
    }
  }

  block(scope: DevelopmentScope, id: string, revision: number, code: string): void {
    const entry = this.entries.get(identity(scope, id))
    if (!entry || revision < entry.latestRevision) return
    entry.latestRevision = revision
    entry.pending = undefined
    entry.diagnostics = [code]
  }

  async stage(
    scope: DevelopmentScope,
    draft: ProjectDevelopmentDraft,
    ownerRoot: string,
    guard: () => void,
    actions: readonly ClawActionDescriptor[] = [],
    assertCurrentRevision: () => void = guard
  ): Promise<ProjectDevelopmentView> {
    guard()
    const key = identity(scope, draft.id)
    if (this.staging.has(key)) throw Error("PROJECT_DEV_BUSY")
    const existing = this.entries.get(key)
    if (existing && draft.revision < existing.latestRevision)
      throw Error("PROJECT_DRAFT_REVISION_CHANGED")
    const { report } = inspectProjectSource(draft.source, [], actions)
    if (!report.valid) {
      if (!existing) throw Error("PROJECT_DEV_DOCTOR_FAILED")
      existing.pending = undefined
      existing.latestRevision = draft.revision
      existing.diagnostics = report.diagnostics.map((item) => item.code)
      return this.read(scope, draft.id)!
    }
    if (
      existing &&
      (existing.current.revision === draft.revision ||
        existing.pending?.revision === draft.revision)
    ) {
      existing.diagnostics = []
      return this.read(scope, draft.id)!
    }
    if (!existing && this.entries.size >= 64) throw Error("PROJECT_DEV_LIMIT")
    this.staging.add(key)
    try {
      const root = existing?.root ?? join(ownerRoot, `${draft.id}-development-${randomUUID()}`)
      if (!existing) await mkdir(root)
      guard()
      const prepared = await prepareProjectDevelopment(
        draft.directory,
        join(root, `revision-${draft.revision}-${randomUUID()}`),
        draft.source.digest,
        guard,
        actions
      )
      guard()
      assertCurrentRevision()
      const snapshot: ProjectDevelopmentSnapshot = {
        devId: existing?.current.devId ?? randomUUID(),
        draftId: draft.id,
        revision: draft.revision,
        digest: prepared.digest,
        packagePath: prepared.packagePath,
        workspace: existing?.current.workspace ?? prepared.workspace
      }
      if (!existing) {
        this.entries.set(key, {
          root,
          current: snapshot,
          guard: () => undefined,
          leases: new Set(),
          diagnostics: [],
          latestRevision: draft.revision
        })
      } else {
        existing.latestRevision = draft.revision
        existing.diagnostics = []
        if (existing.leases.size) existing.pending = snapshot
        else {
          existing.current = snapshot
          existing.pending = undefined
        }
      }
      return this.read(scope, draft.id)!
    } finally {
      this.staging.delete(key)
    }
  }

  /** Caller must hold this through actual settlement; unknown effects must retain the lease. */
  acquire(scope: DevelopmentScope, id: string, revision: number, guard: () => void) {
    guard()
    const key = identity(scope, id)
    const entry = this.entries.get(key)
    if (!entry) throw Error("PROJECT_DEV_MISSING")
    if (this.staging.has(key)) throw Error("PROJECT_DEV_BUSY")
    if (entry.current.revision !== revision || entry.diagnostics.length || entry.pending)
      throw Error("PROJECT_DEV_REVISION_UNAVAILABLE")
    if (entry.leases.size) throw Error("PROJECT_DEV_RUNNING")
    // A model save guard belongs to its tool turn. Retain only the actual preview lease guard.
    entry.guard = guard
    const token = {}
    entry.leases.add(token)
    const snapshot = structuredClone(entry.current)
    return {
      snapshot,
      release: () => {
        if (!entry.leases.delete(token)) return
        if (!entry.leases.size && entry.pending) {
          try {
            entry.guard()
            entry.current = entry.pending
            entry.pending = undefined
          } catch {
            entry.pending = undefined
            entry.diagnostics = ["PROJECT_DEV_SCOPE_CHANGED"]
          }
        }
      }
    }
  }
}
