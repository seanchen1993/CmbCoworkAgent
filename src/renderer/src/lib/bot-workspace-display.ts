import type { BotDefinition } from "../../../shared/bots/contracts"
import type { BotWorkWorkspace } from "../../../shared/bots/work"

export type BotWorkspaceProfile = Pick<BotDefinition, "id" | "name" | "color" | "shape">

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
  owner?: BotWorkspaceProfile
) {
  const defaultOwner = botDefaultWorkspaceOwner(path)
  const isDefault = workspace ? workspace.kind === "default" : Boolean(defaultOwner)
  const bot = owner ?? profiles.find((profile) => profile.id === defaultOwner)
  return {
    isDefault,
    bot,
    name: isDefault
      ? `${bot?.name || "Bot"} · 默认工作区`
      : workspace?.kind === "project"
        ? workspace.projectName
        : workspaceFolderName(path),
    kindLabel: isDefault ? "默认工作区" : workspace?.kind === "project" ? "项目工作区" : "指定目录"
  }
}
