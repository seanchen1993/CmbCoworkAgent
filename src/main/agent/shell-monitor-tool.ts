import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "langchain"
import { z } from "zod"
import { getCurrentHookAgentId, getHookAgentIdFromRequest } from "../hooks/execution-context"
import { toolFailureSignalFromAbort } from "../hooks/tool-failure"
import { mergeUpdatedInput } from "../hooks/updated-input"
import { WorkspaceExecutionLockUnavailableError } from "./file-operation-lock"
import type { LocalSandbox } from "./local-sandbox"
import {
  SHELL_TASK_MONITOR_MAX_WAIT_MS,
  SHELL_TASK_MONITOR_TOOL_NAMES,
  SHELL_TASK_OUTPUT_TOOL_NAME,
  type ShellTaskSnapshot
} from "./shell-task-monitor"

// A private configurable object avoids copying the owner into LangChain metadata.
export const SHELL_TASK_OWNER_CONFIG_KEY = "__cmb_subagent_shell_task_owner"

export function getShellTaskOwnerId(config?: RunnableConfig): string | undefined {
  // Each Task invocation has its own owner, including when providers reuse tool IDs.
  const invocationOwner: unknown = config?.configurable?.[SHELL_TASK_OWNER_CONFIG_KEY]
  if (
    invocationOwner &&
    typeof invocationOwner === "object" &&
    "id" in invocationOwner &&
    typeof invocationOwner.id === "string"
  ) {
    return invocationOwner.id
  }
  return getHookAgentIdFromRequest(config) ?? getCurrentHookAgentId()
}

type ShellMonitorBackend = Pick<
  LocalSandbox,
  "getTaskOutput" | "waitForTaskOutput" | "runPreToolUseHookForTool" | "applyPostToolUseHookToText"
>

const DEFAULT_TASK_OUTPUT_WAIT_MS = 30_000

const monitorSchema = z.object({
  task_id: z.string().describe("The task ID returned by execute for a background command"),
  block: z
    .boolean()
    .optional()
    .describe(
      "Wait for completion (default: true). For a snapshot, a busy hook workspace returns not_ready."
    ),
  timeout: z
    .number()
    .min(0)
    .max(SHELL_TASK_MONITOR_MAX_WAIT_MS)
    .optional()
    .describe("Wait budget in milliseconds for hook workspace access and command completion")
})

function formatTaskSnapshot(
  snapshot: ShellTaskSnapshot,
  retrievalStatus: "not_ready" | "timeout"
): string {
  if (snapshot.completed) {
    const status = snapshot.exitCode === 0 ? "succeeded" : "failed"
    const output = snapshot.output ?? "<no output>"
    return `${output}\n[Command ${status} with exit code ${snapshot.exitCode}, elapsed: ${snapshot.elapsedSeconds}s]`
  }

  return JSON.stringify({
    retrieval_status: retrievalStatus,
    elapsed: snapshot.elapsedSeconds,
    command: snapshot.command,
    partialOutput: snapshot.partialOutput,
    partialTruncated: snapshot.partialTruncated,
    idleSeconds: snapshot.idleSeconds
  })
}

export function createShellTaskMonitorTools(sandbox: ShellMonitorBackend) {
  const runMonitor = async (
    toolName: (typeof SHELL_TASK_MONITOR_TOOL_NAMES)[number],
    input: z.infer<typeof monitorSchema>,
    config?: RunnableConfig
  ): Promise<string> => {
    const ownerId = getShellTaskOwnerId(config)
    const legacy = toolName === SHELL_TASK_OUTPUT_TOOL_NAME
    const defaultTimeout = legacy ? DEFAULT_TASK_OUTPUT_WAIT_MS : undefined
    const abortMessage = legacy
      ? "Task polling aborted: conversation was cancelled by user."
      : "Task monitoring aborted: conversation was cancelled by user."
    const signal = config?.signal
    if (signal?.aborted) return abortMessage
    const startedAt = performance.now()
    const toolArgs: Record<string, unknown> = { ...input }
    let block = input.block !== false
    let timeoutMs = block ? (input.timeout ?? defaultTimeout) : 0
    const workspaceLockDeadline = () =>
      timeoutMs === undefined ? undefined : startedAt + timeoutMs

    try {
      const preResult = await sandbox.runPreToolUseHookForTool(
        toolName,
        toolArgs,
        signal,
        workspaceLockDeadline()
      )
      if (signal?.aborted) return abortMessage
      if (preResult?.blocked || preResult?.decision === "block") {
        const reason = preResult.stdout || preResult.reason || `${toolName} was blocked by a hook`
        return `[Hook blocked] ${reason}`
      }

      const effectiveArgs = mergeUpdatedInput(toolArgs, preResult?.updatedInput)
      const taskId =
        typeof effectiveArgs.task_id === "string" && effectiveArgs.task_id.trim()
          ? effectiveArgs.task_id
          : input.task_id
      if (!taskId) return "Error: Invalid task id."
      if (typeof effectiveArgs.block === "boolean") block = effectiveArgs.block
      const timeout = effectiveArgs.timeout
      timeoutMs =
        typeof timeout === "number" && Number.isFinite(timeout)
          ? Math.max(0, Math.min(timeout, SHELL_TASK_MONITOR_MAX_WAIT_MS))
          : (input.timeout ?? defaultTimeout)
      if (!block) timeoutMs = 0
      const deadline = workspaceLockDeadline()

      let snapshot: ShellTaskSnapshot | null
      if (block) {
        const wait = await sandbox.waitForTaskOutput(taskId, {
          ownerId,
          timeoutMs:
            deadline === undefined ? undefined : Math.max(0, Math.ceil(deadline - performance.now())),
          signal
        })
        if (wait.status === "aborted") return abortMessage
        snapshot = "result" in wait ? wait.result : null
      } else {
        snapshot = sandbox.getTaskOutput(taskId, ownerId)
      }
      if (signal?.aborted) return abortMessage
      const resultText = snapshot
        ? formatTaskSnapshot(snapshot, block ? "timeout" : "not_ready")
        : `Error: No background task found with id "${taskId}".`
      const failureSignal = snapshot?.cancelled ? toolFailureSignalFromAbort(resultText) : undefined
      const result = await sandbox.applyPostToolUseHookToText(
        toolName,
        effectiveArgs,
        resultText,
        failureSignal,
        { abortSignal: signal, workspaceLockDeadline: deadline }
      )
      return signal?.aborted ? abortMessage : result
    } catch (error) {
      if (signal?.aborted) return abortMessage
      if (!(error instanceof WorkspaceExecutionLockUnavailableError)) throw error
      return JSON.stringify({
        retrieval_status: block ? "timeout" : "not_ready",
        reason: "workspace_hook_busy"
      })
    }
  }

  const [monitorName, taskOutputName] = SHELL_TASK_MONITOR_TOOL_NAMES
  return [
    tool((input, config) => runMonitor(monitorName, input, config), {
      name: monitorName,
      description:
        "Wait for completion of a background command started by execute and return its result. " +
        "Omit timeout to listen until the command finishes, or set block=false for a snapshot.",
      schema: monitorSchema
    }),
    tool((input, config) => runMonitor(taskOutputName, input, config), {
      name: taskOutputName,
      description:
        "Compatibility tool for retrieving the output of a background command. " +
        "Waits up to 30 seconds by default. Set block=false for a snapshot.",
      schema: monitorSchema
    })
  ] as const
}
