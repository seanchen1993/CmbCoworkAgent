import type { DevelopmentApi, DevelopmentStatus } from "../../../../shared/mods/development"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { prepareDevelopmentCreation, type DevelopmentSetupApi } from "./development-creation-setup"

/** Entry is an explicit user action; retain current settings and reject stale chat navigation. */
export async function enterCreatorMode(
  settings: DevelopmentSetupApi,
  development: Pick<DevelopmentApi, "setMode">,
  threadId: string,
  workspace: string,
  assertCurrent: () => void
): Promise<DevelopmentStatus> {
  await prepareDevelopmentCreation(settings, threadId, workspace, assertCurrent)
  assertCurrent()
  const next = await development.setMode({
    threadId,
    expectedWorkspace: workspace,
    mode: "creator"
  })
  assertCurrent()
  if (
    next.threadId !== threadId ||
    normalizeWorkspacePathKey(next.workspace) !== normalizeWorkspacePathKey(workspace)
  )
    throw Error("DEVELOPMENT_SCOPE_CHANGED")
  if (!next.enabled || next.mode !== "creator") throw Error("DEVELOPMENT_CREATOR_UNAVAILABLE")
  return next
}

export function creatorEntryError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (/SETUP_PARTIAL/.test(message))
    return "部分功能已开启，但尚未进入创造者模式。请核对当前聊天后重试。"
  if (/RECOVERY/.test(message))
    return "项目设置需要恢复，请在“高级自定义 → 灵件管理 → 我已添加”中处理后重试。"
  if (/SCOPE|STALE|WORKSPACE/.test(message))
    return "聊天或项目已变化，请重新选择目标聊天后再进入创造者模式。"
  return "暂时无法进入创造者模式，请稍后重试。"
}
