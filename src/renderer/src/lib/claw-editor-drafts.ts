import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import type { SimpleClawDraft } from "./simple-claw-builder"

export interface ClawEditorScope {
  accountRevision: number
  threadId: string
  workspace: string | null | undefined
}

/** Editing values only. Host views, grants, catalogs and callbacks never enter this cache. */
export class ClawEditorDrafts {
  private revision = 0
  private entries = new Map<
    string,
    { scope: ClawEditorScope; draft: SimpleClawDraft; size: number }
  >()
  private size = 0

  constructor(
    private maxEntries = 16,
    private maxChars = 2 * 1024 * 1024
  ) {}

  private key(scope: ClawEditorScope): string | undefined {
    const workspace = normalizeWorkspacePathKey(scope.workspace)
    return scope.accountRevision === this.revision && workspace
      ? JSON.stringify([scope.threadId, workspace])
      : undefined
  }

  /** An absent paged directory row is not evidence of deletion. null means retired/changed. */
  synchronize(revision: number, workspaceFor: (threadId: string) => string | null | undefined) {
    if (revision !== this.revision) {
      this.entries.clear()
      this.size = 0
      this.revision = revision
    }
    for (const [key, entry] of this.entries) {
      const workspace = workspaceFor(entry.scope.threadId)
      if (
        workspace === null ||
        (workspace !== undefined &&
          normalizeWorkspacePathKey(workspace) !== normalizeWorkspacePathKey(entry.scope.workspace))
      )
        this.remove(key)
    }
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (entry) this.size -= entry.size
    this.entries.delete(key)
  }

  read(scope: ClawEditorScope): SimpleClawDraft | undefined {
    const key = this.key(scope)
    const entry = key ? this.entries.get(key) : undefined
    if (!entry || !key) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return structuredClone(entry.draft)
  }

  /** Clean/saved/discarded documents remove their old draft instead of reviving it next time. */
  write(scope: ClawEditorScope, draft: SimpleClawDraft, dirty: boolean): boolean {
    const key = this.key(scope)
    if (!key) return false
    this.remove(key)
    if (!dirty) return true
    const size = JSON.stringify(draft).length
    if (size > this.maxChars || this.maxEntries < 1) return false
    const copy = structuredClone(draft)
    this.entries.set(key, { scope: { ...scope }, draft: copy, size })
    this.size += size
    while (this.entries.size > this.maxEntries || this.size > this.maxChars)
      this.remove(this.entries.keys().next().value!)
    return true
  }
}
