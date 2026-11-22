export const FUNCTION_UI_SITES = [
  "ChatHeader",
  "AbovePrompt",
  "PromptHint",
  "InfoNotice",
  "Spinner",
  "TurnDuration",
  "SessionMode",
  "UserMessage",
  "AssistantMessage",
  "CommandOutput",
  "ToolUse",
  "ToolResult",
  "ToolGroup",
  "AskUserQuestion"
] as const

export type FunctionUiSite = (typeof FUNCTION_UI_SITES)[number]
export type FunctionUiRenderComponent = FunctionUiSite | "Pane" | "Placed"

export function isFunctionUiRenderComponent(value: unknown): value is FunctionUiRenderComponent {
  return value === "Pane" || value === "Placed" || FUNCTION_UI_SITES.some(site => site === value)
}
