import { tool } from "langchain"
import { z } from "zod"
import {
  executeProjectCheckpoint,
  projectCheckpointAvailable
} from "../../harness-board/project-runtime/project-checkpoint"
export function createProjectCheckpointTool(signal?: AbortSignal) {
  if (!projectCheckpointAvailable()) return undefined
  return tool(
    async (input) => {
      const result = await executeProjectCheckpoint({ ...input, signal })
      return JSON.stringify({
        status: result.status,
        stateDigest: result.stateDigest,
        message: result.message
      })
    },
    {
      name: "project_checkpoint",
      description:
        "Advance this admitted internal project through its original pinned checkpoint writer and original checks. Supply the target checkpoint and SHA-256 of the current original state file. Never edit state directly. Unknown means do not retry or claim completion; ask the user to reconcile the original operation.",
      schema: z
        .object({
          checkpoint: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
          expectedStateDigest: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict()
    }
  )
}
