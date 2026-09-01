import type { AgentProfile } from "../agent-registry"
import { ANALYST_PROFILE } from "./analyst"

/**
 * Restriction profile for the requirement-management conversation mode.
 *
 * The runtime reads this config to filter the subagent profiles the main
 * agent may call via the task tool, and the skills the main agent may
 * invoke. Everything else in requirement mode (System Prompt, tool gating,
 * coordinator bypass) is driven by the `requirementMode` flag plumbed
 * through `CreateAgentRuntimeOptions` / `createDeepAgent`.
 *
 * Extend requirement mode by appending entries to the arrays below — the
 * runtime never needs to change. Keep this list curated: every entry here
 * is what the requirement-mode main agent is allowed to use, nothing more.
 */
export interface RestrictedModeConfig {
  /** Subagent profiles the main agent may call via the task tool. */
  readonly subagentProfiles: readonly AgentProfile[]
  /** Skill names the main agent may invoke. Empty = no skills. */
  readonly skillNames: readonly string[]
}

export const REQUIREMENT_MODE_CONFIG: RestrictedModeConfig = {
  subagentProfiles: [ANALYST_PROFILE],
  skillNames: ["requirement-to-prd"]
}
