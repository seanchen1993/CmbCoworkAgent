import type { SlashCommandItem } from "../slash-commands/useSlashCommands"

export const REQUIREMENT_WORKBENCH_COMMAND_ID = "requirement-workbench"
export const REQUIREMENT_WORKBENCH_SKILL_NAME = "requirement-workbench"
export const REQUIREMENT_WORKBENCH_DISPLAY_NAME = "需求工作台"

export const REQUIREMENT_WORKBENCH_COMMAND: SlashCommandItem = {
  id: REQUIREMENT_WORKBENCH_COMMAND_ID,
  title: REQUIREMENT_WORKBENCH_DISPLAY_NAME,
  command: "/requirement",
  usage: "/requirement <需求信息>",
  description: "使用 requirement-workbench 技能分析需求并推进 PRD",
  insertText: "",
  keywords: ["requirement", "需求工作台", "需求", "PRD"]
}

export function isRequirementWorkbenchSlashCommand(command: { id: string }): boolean {
  return command.id === REQUIREMENT_WORKBENCH_COMMAND_ID
}
