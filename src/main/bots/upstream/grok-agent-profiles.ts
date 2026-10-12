/** Extracted from Grok Bot 0.18 sand-agent-management-tools.ts.
 * Original profile schemas and omission rules; Cmb adds its existing storage
 * bounds, revision/approval checks and durable mutation receipts in the adapter.
 * Source hash and scope are recorded in PROVENANCE.json.
 */
import { z } from "zod"

export const createAgentParameters = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("A short, human-readable name for the new agent."),
  description: z
    .string()
    .trim()
    .max(32000)
    .default("")
    .describe(
      "The new agent's persona / instructions: what it is for and how it should behave. This becomes its profile and shapes its replies. Optional but strongly recommended."
    )
})

export const updateAgentParameters = z.object({
  agent_id: z.string().trim().min(1).max(160).describe("The id of the agent to update."),
  name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("A new name for the agent. Omit to leave the name unchanged."),
  description: z
    .string()
    .trim()
    .max(32000)
    .optional()
    .describe("A new persona/description for the agent. Omit to leave it unchanged.")
})

export function agentProfilePatch(args: z.infer<typeof updateAgentParameters>): {
  name?: string
  description?: string
} {
  const patch: { name?: string; description?: string } = {}
  if (args.name != null && args.name.length > 0) patch.name = args.name
  if (args.description != null && args.description.length > 0) patch.description = args.description
  return patch
}
