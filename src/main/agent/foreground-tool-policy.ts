import type { AgentMode } from "./coordinator-mode"

/** Shared by foreground invoke/resume/interrupt and cold metadata preparation. */
export function foregroundToolPolicy(agentMode: AgentMode, metadata: Record<string, unknown>) {
  return {
    enableRequestUserInput: true,
    noSkillEvolutionTool: true,
    disableSubagents: agentMode === "normal" && metadata.subagentsEnabled === false
  }
}
