import type { SlashCommandItem } from "./useSlashCommands"

export type BuiltinNavigationTarget =
  | "diff"
  | "instructions"
  | "runs"
  | "policy"
  | "create"
  | "help"

export const BUILTIN_NAVIGATION_COMMANDS: SlashCommandItem[] = [
  ["diff", "查看改动", "比较项目文件，查看新增、修改和删除"],
  ["instructions", "项目规范", "查看本次使用的项目要求"],
  ["runs", "运行过程", "查看进度、结果和失败原因"],
  ["policy", "使用限制", "查看需要确认的操作和限制原因"],
  ["create", "制作插件", "从已有插件创建，或描述你需要的功能"],
  ["help", "使用帮助", "打开官方说明和操作示例"]
].map(([target, title, description]) => ({
  id: `builtin:${target}`,
  kind: "builtin-navigation",
  title: `内置 · ${title}`,
  command: `/${target}`,
  insertText: `/${target}`,
  description,
  keywords: [target, title]
}))

export function builtinTargetFromItem(item: SlashCommandItem): BuiltinNavigationTarget | null {
  if (item.kind !== "builtin-navigation") return null
  return (
    (BUILTIN_NAVIGATION_COMMANDS.find((command) => command.id === item.id)?.command.slice(1) as
      | BuiltinNavigationTarget
      | undefined) ?? null
  )
}

export function parseBuiltinNavigation(text: string): BuiltinNavigationTarget | null {
  const command = BUILTIN_NAVIGATION_COMMANDS.find(
    (item) => item.command === text.trim().toLowerCase()
  )
  return command ? (command.command.slice(1) as BuiltinNavigationTarget) : null
}

export function builtinCommandConflicts(
  text: string,
  commands: readonly { command: string }[],
  skills: readonly { name: string }[]
): boolean {
  const name = text.trim().toLowerCase()
  return (
    commands.some((item) => item.command.toLowerCase() === name) ||
    skills.some((item) => `/${item.name.toLowerCase()}` === name)
  )
}

export function builtinNavigationPrefix(text: string): BuiltinNavigationTarget | null {
  return parseBuiltinNavigation(text.trim().split(/\s+/)[0])
}
