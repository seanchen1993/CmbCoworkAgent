import type { AgentProfile } from "../agent/agent-registry"
import type { BotWorkflowChildInput } from "./workflow-children"

// Adapted from Grok 0.18 sand-computer-use-subagent.ts. Physical execution
// remains CMB's original native broker and workflow graph, not a new Box.
export const BOT_COMPUTER_TASK_PROFILE: Readonly<AgentProfile> = Object.freeze({
  name: "computerUse",
  description:
    "Delegate one self-contained Windows application task in this Bot's current desktop. It runs in the background and returns its result automatically; only one task can use this shared screen at a time.",
  systemPrompt:
    "Complete only the assigned GUI task in the owning Bot's existing work application desktop. Use native_computer with fresh observations and exact screenshot tickets; preserve current application state and verify outcomes. The parent continues non-GUI work while you exclusively use this screen. No shell, project-file tools, browser pages, persistent Bot administration, private parent memory or further task dispatch is available. Native launch keeps its existing per-action approval and fixed filesystem permissions. For login, MFA, CAPTCHA, payment or another unavoidable human step, request_computer_help in the same Windows application and wait for the actual user's return, then observe again. Never request credentials in chat, force handback, bypass approval or repeat an uncertain action. Return findings and artifact IDs to the owning workflow.",
  source: "built-in",
  disallowedTools: [],
  shellAccess: "none",
  desktopAccess: "shared-native"
})

/** A field or role name alone is never an authority grant. Frontmatter cannot
 * assign this private capability, and Host dispatch freezes this exact role. */
export function isBotComputerTaskProfile(profile: AgentProfile | null | undefined): boolean {
  return Boolean(
    profile &&
    profile.source === "built-in" &&
    profile.name === BOT_COMPUTER_TASK_PROFILE.name &&
    profile.description === BOT_COMPUTER_TASK_PROFILE.description &&
    profile.systemPrompt === BOT_COMPUTER_TASK_PROFILE.systemPrompt &&
    profile.desktopAccess === "shared-native" &&
    profile.browserAccess === undefined &&
    profile.shellAccess === "none" &&
    profile.disallowedTools.length === 0
  )
}

export function isBotComputerTaskInput(input: BotWorkflowChildInput): boolean {
  return (
    input.agentType === BOT_COMPUTER_TASK_PROFILE.name &&
    input.roleSystemPrompt === BOT_COMPUTER_TASK_PROFILE.systemPrompt &&
    input.desktopAccess === "shared-native" &&
    input.browserAccess === undefined &&
    input.shellAccess === "none" &&
    input.disallowedTools?.length === 0 &&
    input.isolation === undefined
  )
}
