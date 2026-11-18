import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "langchain"
import { z } from "zod"
import { getCurrentHookAgentId, getHookAgentIdFromRequest } from "../hooks/execution-context"
import { mergeUpdatedInput } from "../hooks/updated-input"
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
  block: z.boolean().optional().describe("Wait for completion (default: true)"),
  timeout: z
    .number()
    .min(0)
    .max(SHELL_TASK_MONITOR_MAX_WAIT_MS)
    .optional()
    .describe("Optional maximum wait in milliseconds")
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
    input: z.infer<typeof monitorSchema>,
    config: RunnableConfig | undefined,
    defaultTimeout?: number
  ): Promise<string> => {
    const ownerId = getShellTaskOwnerId(config)
    const abortMessage =
      defaultTimeout === undefined
        ? "Task monitoring aborted: conversation was cancelled by user."
        : "Task polling aborted: conversation was cancelled by user."
    const toolArgs: Record<string, unknown> = { ...input }
    // Keep the hook identity shared so the new spelling obeys existing task_output policies.
    const preResult = await sandbox.runPreToolUseHookForTool(SHELL_TASK_OUTPUT_TOOL_NAME, toolArgs)
    if (preResult?.blocked || preResult?.decision === "block") {
      const reason = preResult.stdout || preResult.reason || "task_output was blocked by a hook"
      return `[Hook blocked] ${reason}`
    }
    if (config?.signal?.aborted) return abortMessage

    const effectiveArgs = mergeUpdatedInput(toolArgs, preResult?.updatedInput)
    const taskId =
      typeof effectiveArgs.task_id === "string" && effectiveArgs.task_id.trim()
        ? effectiveArgs.task_id
        : input.task_id
    if (!taskId) return "Error: Invalid task id."
    const notFound = `Error: No background task found with id "${taskId}".`
    const block =
      typeof effectiveArgs.block === "boolean" ? effectiveArgs.block : input.block !== false
    const timeout = effectiveArgs.timeout
    const timeoutMs =
      typeof timeout === "number" && Number.isFinite(timeout)
        ? Math.max(0, Math.min(timeout, SHELL_TASK_MONITOR_MAX_WAIT_MS))
        : (input.timeout ?? defaultTimeout)

    let resultText: string
    if (block) {
      const wait = await sandbox.waitForTaskOutput(taskId, {
        ownerId,
        timeoutMs,
        signal: config?.signal
      })
      if ("result" in wait) {
        resultText = formatTaskSnapshot(wait.result, "timeout")
      } else if (wait.status === "aborted") {
        return abortMessage
      } else {
        resultText = notFound
      }
    } else {
      const snapshot = sandbox.getTaskOutput(taskId, ownerId)
      resultText = snapshot ? formatTaskSnapshot(snapshot, "not_ready") : notFound
    }
    if (config?.signal?.aborted) return abortMessage
    return sandbox.applyPostToolUseHookToText(
      SHELL_TASK_OUTPUT_TOOL_NAME,
      effectiveArgs,
      resultText
    )
  }

  const [monitorName, taskOutputName] = SHELL_TASK_MONITOR_TOOL_NAMES
  return [
    tool((input, config) => runMonitor(input, config), {
      name: monitorName,
      description:
        "Wait for completion of a background command started by execute and return its result. " +
        "Omit timeout to listen until the command finishes, or set block=false for a snapshot.",
      schema: monitorSchema
    }),
    tool((input, config) => runMonitor(input, config, DEFAULT_TASK_OUTPUT_WAIT_MS), {
      name: taskOutputName,
      description:
        "Compatibility tool for retrieving the output of a background command. " +
        "Waits up to 30 seconds by default. Set block=false for a snapshot.",
      schema: monitorSchema
    })
  ] as const
}
