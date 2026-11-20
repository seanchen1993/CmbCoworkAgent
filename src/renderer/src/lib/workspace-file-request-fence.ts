import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

export interface WorkspaceFileRequestToken {
  threadId: string | null
  workspaceKey: string
  epoch: number
}

function requestIdentity(threadId: string | null, workspacePath: string | null): string {
  const workspaceKey = workspacePath ? normalizeWorkspacePathKey(workspacePath) || "/" : ""
  return JSON.stringify([threadId, workspaceKey])
}

/**
 * Fences async Files-panel work by both normalized workspace identity and a
 * monotonically increasing request epoch. Observing A -> B invalidates A before
 * any late continuation can publish into B's ThreadState.
 */
export class WorkspaceFileRequestFence {
  private identity = requestIdentity(null, null)
  private epoch = 0

  observe(threadId: string | null, workspacePath: string | null): void {
    const nextIdentity = requestIdentity(threadId, workspacePath)
    if (nextIdentity === this.identity) return
    this.identity = nextIdentity
    this.epoch += 1
  }

  begin(threadId: string | null, workspacePath: string | null): WorkspaceFileRequestToken {
    this.observe(threadId, workspacePath)
    this.epoch += 1
    return {
      threadId,
      workspaceKey: workspacePath ? normalizeWorkspacePathKey(workspacePath) || "/" : "",
      epoch: this.epoch
    }
  }

  isCurrent(token: WorkspaceFileRequestToken): boolean {
    return (
      token.epoch === this.epoch &&
      requestIdentity(token.threadId, token.workspaceKey) === this.identity
    )
  }

  invalidate(token: WorkspaceFileRequestToken): void {
    if (token.epoch === this.epoch) this.epoch += 1
  }
}
