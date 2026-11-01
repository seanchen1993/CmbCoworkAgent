import type { DeveloperEditorIntent } from "../../../shared/mods/v2/developer-editor"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

export function editorIntentScopeMatches(
  intent: DeveloperEditorIntent,
  current: { threadId: string; workspace: string; scopeKey: string }
) {
  return (
    intent.threadId === current.threadId &&
    intent.scopeKey === current.scopeKey &&
    isSameWorkspacePath(intent.workspace, current.workspace)
  )
}

export function editorIntentMatches(
  intent: DeveloperEditorIntent,
  current: { threadId: string; workspace: string; scopeKey: string },
  now = Date.now()
) {
  return editorIntentScopeMatches(intent, current) && intent.expiresAt > now
}
