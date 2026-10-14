import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { flowDraftId } from "./flow-draft-id"

export interface SimpleAuthoringScope {
  threadId: string
  workspace: string | null
}

export interface SimpleAuthoringPracticeIntent {
  id: string
  scope: SimpleAuthoringScope
  task: "create" | "combine" | "inspect"
  target: "derive-source" | "simple-combination" | "diff" | "runs"
  suggestedName?: string
  suggestedText?: string
}

export function sameSimpleAuthoringScope(
  expected: SimpleAuthoringScope,
  actual: { threadId: string | null; workspace?: string | null }
): boolean {
  return (
    expected.threadId === actual.threadId &&
    normalizeWorkspacePathKey(expected.workspace) === normalizeWorkspacePathKey(actual.workspace)
  )
}

export function createPracticeIntent(
  task: SimpleAuthoringPracticeIntent["task"],
  scope: SimpleAuthoringScope
): SimpleAuthoringPracticeIntent {
  return {
    id: flowDraftId("claw"),
    scope,
    task,
    target:
      task === "create" ? "derive-source" : task === "combine" ? "simple-combination" : "diff",
    ...(task === "create" ? { suggestedName: "我的 AutoBiz" } : {}),
    ...(task === "combine" ? { suggestedName: "我的文件检视助手" } : {})
  }
}
