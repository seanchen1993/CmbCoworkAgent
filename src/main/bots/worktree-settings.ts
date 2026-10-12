import {
  normalizeWorkflowWorktreeTimeoutMinutes,
  normalizeWorkflowWorktreeRemoveTimeoutMinutes
} from "../../shared/agent-runtime-limits"
import { readBotModelSnapshot } from "./model-config"
import type { BotWorktreeOperation } from "./worktree-contract"

/** Non-authorizing Git limits. Maintenance remains available if model settings
 * are missing or currently being republished; credentials are never returned. */
export class BotWorktreeSettings {
  private lastApplied = {
    createMinutes: normalizeWorkflowWorktreeTimeoutMinutes(undefined),
    removeMinutes: normalizeWorkflowWorktreeRemoveTimeoutMinutes(undefined)
  }

  constructor(private readonly modelFile: string) {}

  async prepare(input: BotWorktreeOperation, fallbackMs: number) {
    try {
      const snapshot = await readBotModelSnapshot(this.modelFile)
      this.lastApplied = {
        createMinutes: normalizeWorkflowWorktreeTimeoutMinutes(
          snapshot.workflowWorktreeTimeoutMinutes
        ),
        removeMinutes: normalizeWorkflowWorktreeRemoveTimeoutMinutes(
          snapshot.workflowWorktreeRemoveTimeoutMinutes
        )
      }
    } catch {
      // A model publication fence must not prevent inspecting/cleaning an owned
      // worktree. Only these bounded timeouts may use the last applied values.
    }
    const timeouts = { ...this.lastApplied }
    const createMs = timeouts.createMinutes * 60_000
    const removeMs = timeouts.removeMinutes * 60_000
    const timeoutMs = ["prepare", "acquire", "merge"].includes(input.op)
      ? createMs + removeMs
      : ["discard", "cleanup"].includes(input.op)
        ? fallbackMs + removeMs
        : fallbackMs
    // The supervisor includes rollback/removal time; the worker applies each
    // configured limit to the corresponding shared Git operation.
    return { input: { ...input, timeouts }, timeoutMs }
  }
}
