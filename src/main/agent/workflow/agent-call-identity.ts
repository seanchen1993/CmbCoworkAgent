import { createHash } from "node:crypto"
import type { AgentProfile } from "../agent-registry"

/** Shared by engine dispatch and Host reservation. Preserve field order and
 * null/default handling: existing journals must retain their exact hashes.
 * Label and phase are presentation only; resolved model and role policy are not. */
export function workflowAgentCallHash(input: {
  childCacheKey?: string
  prompt: string
  schema?: unknown
  model?: string
  defaultModelId?: string
  profile?: AgentProfile | null
  isolation?: "worktree"
}): string {
  const agentProfile = input.profile
  return createHash("sha256")
    .update(
      JSON.stringify({
        child: input.childCacheKey ?? null,
        prompt: input.prompt,
        schema: input.schema ?? null,
        model: input.model ?? input.defaultModelId ?? null,
        agentType: agentProfile?.name ?? null,
        agentProfile: agentProfile
          ? {
              systemPrompt: agentProfile.systemPrompt,
              disallowedTools: [...agentProfile.disallowedTools].sort(),
              shellAccess: agentProfile.shellAccess,
              ...(agentProfile.browserAccess ? { browserAccess: agentProfile.browserAccess } : {}),
              ...(agentProfile.desktopAccess ? { desktopAccess: agentProfile.desktopAccess } : {})
            }
          : null,
        // Ordinary tasks intentionally keep the pre-isolation identity.
        ...(input.isolation ? { isolation: input.isolation } : {})
      })
    )
    .digest("hex")
}
