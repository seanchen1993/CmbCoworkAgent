import type { BotDefinition } from "../../../shared/bots/contracts"
import type { BotWorkWorkspace } from "../../../shared/bots/work"

export type BotWorkspaceProfile = Pick<BotDefinition, "id" | "name" | "color" | "shape"> & {
  imGroups?: readonly { id: string; title: string }[]
}

export function botWorkOwnerLabel(
  metadata: Record<string, unknown> | undefined,
  bot?: BotWorkspaceProfile
): string {
  const group = bot?.imGroups?.find((item) => item.id === metadata?.botMockBindingId)
  return `${bot?.name || "Bot"} · ${group?.title || (metadata?.botMockBindingId ? "招乎任务" : "独立任务")}`
}

/** Presentation only: never changes the workspace path or a task's ownership. */
export function botDefaultWorkspaceOwner(path: string | null | undefined): string | null {
  return (
    path
      ?.replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .match(/\/bots\/workspaces\/([^/]+)$/)?.[1] ?? null
  )
}

export function workspaceFolderName(path: string | null | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || path || "未关联工作区"
}

export function botWorkspaceDisplay(
  path: string,
  profiles: readonly BotWorkspaceProfile[] = [],
  workspace?: BotWorkWorkspace,
  owner?: BotWorkspaceProfile,
  group?: { title: string }
) {
  const defaultOwner = botDefaultWorkspaceOwner(path)
  const isDefault = workspace ? workspace.kind === "default" : Boolean(defaultOwner)
  const groupId = defaultOwner?.startsWith("mock-") ? defaultOwner.slice(5) : undefined
  const bot =
    owner ??
    profiles.find(
      (profile) =>
        profile.id === defaultOwner ||
        (groupId && profile.imGroups?.some((item) => item.id === groupId))
    )
  const groupName = group?.title ?? bot?.imGroups?.find((item) => item.id === groupId)?.title
  return {
    isDefault,
    bot,
    name: isDefault
      ? `${groupName || (groupId ? "招乎群聊" : bot?.name || "Bot")} · 默认工作区`
      : workspace?.kind === "project"
        ? workspace.projectName
        : workspaceFolderName(path),
    kindLabel: isDefault ? "默认工作区" : workspace?.kind === "project" ? "项目工作区" : "指定目录"
  }
}
