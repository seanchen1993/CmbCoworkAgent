import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import type {
  SnapshotMaintenancePreview,
  SnapshotMaintenanceResult
} from "../../shared/project-runtime/snapshot-maintenance"
import { snapshotGroups } from "../../shared/project-runtime/snapshot-maintenance"
import { runtimeDirectoryIdentity } from "../harness-board/project-runtime/safe-files"
import { projectSnapshotRoots } from "../harness-board/project-runtime/snapshot-reference-audit"
import type { SnapshotReferenceAudit } from "../harness-board/project-runtime/snapshot-retention"

interface Inspection {
  published: number
  protected: string[]
  candidates: string[]
  blockers: string[]
}
interface Dependencies {
  trusted(event: IpcMainInvokeEvent): void
  base(): string
  prepare?(roots: readonly string[]): Promise<void>
  /** Advisory only. Collection always obtains new references inside its own root lock. */
  previewAudit?(roots: readonly string[]): SnapshotReferenceAudit
  inspect(root: string, previewReferences?: SnapshotReferenceAudit): Inspection
  collect(
    root: string,
    expectedDigests: readonly string[]
  ): {
    removed: string[]
    publishedAfter: number
    blockers: string[]
  }
  now?(): number
}

/** Preview capabilities are native-only, sender/frame-bound, single-use, bounded and short-lived. */
export function registerSnapshotMaintenanceHandlers(ipc: IpcMain, deps: Dependencies): void {
  const now = deps.now ?? Date.now
  const previews = new Map<
    string,
    {
      sender: IpcMainInvokeEvent["sender"]
      frame: IpcMainInvokeEvent["senderFrame"]
      base: string
      expires: number
      roots: Array<{ root: string; identity?: string; candidates: string[] }>
    }
  >()
  const prune = () => {
    for (const [id, preview] of previews)
      if (preview.expires <= now() || preview.sender.isDestroyed()) previews.delete(id)
  }
  ipc.handle("mods:snapshot-maintenance-preview", async (event, input: unknown) => {
    deps.trusted(event)
    if (input !== undefined) throw Error("SNAPSHOT_MAINTENANCE_ARGUMENTS")
    prune()
    const base = deps.base()
    await deps.prepare?.(projectSnapshotRoots(base).filter((root) => existsSync(root)))
    deps.trusted(event)
    if (deps.base() !== base) throw Error("SNAPSHOT_MAINTENANCE_PREVIEW_EXPIRED")
    const discovered = projectSnapshotRoots(base).map((root) => ({
      root,
      identity: existsSync(root) ? runtimeDirectoryIdentity(root) : undefined
    }))
    const existing = discovered.filter((entry) => entry.identity).map((entry) => entry.root)
    let previewReferences: SnapshotReferenceAudit | undefined
    if (existing.length && deps.previewAudit) {
      try {
        previewReferences = deps.previewAudit(existing)
      } catch {
        previewReferences = {
          complete: false,
          digests: new Set(),
          blockers: ["SNAPSHOT_REFERENCE_AUDIT_FAILED"]
        }
      }
    }
    const roots = discovered.map(({ root, identity }) => {
      const view = identity
        ? deps.inspect(root, previewReferences)
        : {
            published: 0,
            protected: [],
            candidates: [],
            blockers: []
          }
      return { root, identity, view }
    })
    const previewId = randomUUID()
    if (previews.size >= 16) previews.delete(previews.keys().next().value!)
    previews.set(previewId, {
      sender: event.sender,
      frame: event.senderFrame,
      base,
      expires: now() + 300_000,
      roots: roots.map(({ root, identity, view }) => ({
        root,
        identity,
        candidates: view.blockers.length ? [] : view.candidates
      }))
    })
    return {
      previewId,
      groups: roots.map(({ view }, index) => ({
        id: snapshotGroups[index],
        published: view.published,
        protected: view.protected.length,
        candidates: view.blockers.length ? 0 : view.candidates.length,
        blockers: view.blockers.slice(0, 12)
      }))
    } satisfies SnapshotMaintenancePreview
  })
  ipc.handle("mods:snapshot-maintenance-collect", (event, previewId: unknown) => {
    deps.trusted(event)
    if (typeof previewId !== "string" || !/^[a-f0-9-]{36}$/.test(previewId))
      throw Error("SNAPSHOT_MAINTENANCE_ARGUMENTS")
    prune()
    const preview = previews.get(previewId)
    if (
      !preview ||
      preview.sender !== event.sender ||
      preview.frame !== event.senderFrame ||
      preview.base !== deps.base()
    )
      throw Error("SNAPSHOT_MAINTENANCE_PREVIEW_EXPIRED")
    previews.delete(previewId)
    // Check all identities before any collection. The collector re-audits references and leases.
    for (const entry of preview.roots)
      if (
        existsSync(entry.root) !== !!entry.identity ||
        (entry.identity && runtimeDirectoryIdentity(entry.root) !== entry.identity)
      )
        throw Error("SNAPSHOT_MAINTENANCE_PREVIEW_EXPIRED")
    const result: SnapshotMaintenanceResult = { removed: 0, remaining: 0, blockers: [] }
    for (const entry of preview.roots) {
      if (!entry.identity) continue
      const collected = deps.collect(entry.root, entry.candidates)
      result.removed += collected.removed.length
      result.remaining += collected.publishedAfter
      result.blockers.push(...collected.blockers.slice(0, 12))
    }
    return result
  })
}
