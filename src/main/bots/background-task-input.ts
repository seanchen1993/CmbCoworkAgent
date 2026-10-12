import { z } from "zod"
import { resolveProfileFromList } from "../agent/agent-registry"
import { workflowAgentCallHash } from "../agent/workflow/agent-call-identity"
import type { BotWorkflowDefinition } from "./workflow-store"
import type { BotWorkflowChildInput } from "./workflow-children"

export const BOT_BACKGROUND_TASK_SCRIPT =
  'export const meta={name:"Background task",description:"One delegated task"}; return await agent(args.prompt,{label:args.label,agentType:args.agentType,model:args.model,isolation:args.isolation});'

export const backgroundTaskArguments = z.object({
  prompt: z.string().trim().min(1).max(64000),
  label: z.string().trim().min(1).max(120),
  agentType: z.string().trim().min(1).max(100).optional(),
  model: z.string().max(200).optional(),
  isolation: z.literal("worktree").optional(),
  taskType: z.enum(["browser", "computer"]).optional()
})

/** This owned script has exactly one top-level agent call, at occurrence zero.
 * The engine's own identity function makes reservation and execution agree. */
export function backgroundTaskInput(
  definition: BotWorkflowDefinition
): BotWorkflowChildInput | undefined {
  if (definition.script !== BOT_BACKGROUND_TASK_SCRIPT) return undefined
  const args = backgroundTaskArguments.parse(definition.args)
  const profile = resolveProfileFromList(definition.agentProfiles, args.agentType)
  if (args.agentType && !profile) throw new Error(`Unknown agentType "${args.agentType}"`)
  const model = args.model ?? profile?.model
  const hash = workflowAgentCallHash({
    prompt: args.prompt,
    model,
    defaultModelId: definition.defaultModelId,
    profile,
    isolation: args.isolation
  })
  return {
    prompt: args.prompt,
    label: args.label,
    phase: null,
    model,
    agentIndex: 1,
    toolStreamKey: `${hash}_c0`,
    durableCallKey: `${hash}_n0`,
    agentType: profile?.name,
    roleSystemPrompt: profile?.systemPrompt,
    disallowedTools: profile?.disallowedTools,
    shellAccess: profile?.shellAccess,
    ...(profile?.browserAccess ? { browserAccess: profile.browserAccess } : {}),
    ...(profile?.desktopAccess ? { desktopAccess: profile.desktopAccess } : {}),
    isolation: args.isolation
  }
}
