import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"
import type { WorkflowRunObservation } from "../../agent/workflow/observation"
import type { ModObject } from "../../../shared/mods/types"

export interface WorkflowPlatformDependencies {
  inspectActions?(context: NativePlatformCallContext, runId: string, offset?: number, limit?: number): ModObject
  launch?(context: NativePlatformCallContext, action: "start" | "resume", input: ModObject): Promise<ModObject>
  active(workspace: string, threadId: string): Promise<WorkflowRunObservation | null>
  latest(workspace: string, threadId: string): Promise<WorkflowRunObservation | null>
  inspect(
    workspace: string,
    threadId: string,
    runId: string,
    page: { agentOffset?: number; worktreeOffset?: number; limit?: number }
  ): Promise<WorkflowRunObservation | null>
  changed(listener: (threadId: string, runId: string) => void): () => void
  confirmCancel(context: NativePlatformCallContext, runId: string): Promise<boolean>
  cancel(threadId: string, runId: string): boolean
  settled(threadId: string, runId: string): Promise<void>
}

const object = { type: "object", additionalProperties: true }
const runInput = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: { runId: { type: "string", minLength: 1, maxLength: 160 } }
}

/** Thin original-service adapter. No workflow execution, state machine or restore loop lives here. */
export function createWorkflowPlatformProvider(
  deps: WorkflowPlatformDependencies
): NativePlatformCapabilityProvider {
  const read = async (context: NativePlatformCallContext): Promise<ModObject> => {
    context.assertCurrent()
    const active = await deps.active(context.workspace, context.threadId)
    const run = active ?? (await deps.latest(context.workspace, context.threadId))
    context.assertCurrent()
    if (!active && run?.status === "running")
      return {
        status: "unknown",
        reason: "WORKFLOW_TERMINAL_STATE_UNCONFIRMED",
        activeRunId: null,
        run
      }
    return { status: "ready", activeRunId: active?.runId ?? null, run }
  }
  return {
    provider: "native.workflow",
    digest: "native.workflow/runs/1.0.0",
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "runs",
      version: "1.0.0",
      title: "当前会话的真实工作流与工作树",
      scope: "conversation",
      stateSchema: object,
      actions: [
        { id: "start", title: "原生确认后启动工作流", inputSchema: { type: "object",
          additionalProperties: false, required: ["script"], properties: {
            script: { type: "string", minLength: 1, maxLength: 12000 }, args: {} } },
          outputSchema: object, requiredPermissions: ["platform.read"], cancellable: false, idempotency: "keyed" },
        { id: "resume", title: "原生确认后恢复原工作流", inputSchema: runInput,
          outputSchema: object, requiredPermissions: ["platform.read"], cancellable: false, idempotency: "keyed" },
        {
          id: "inspect",
          title: "读取工作流任务与工作树",
          inputSchema: {
            ...runInput,
            properties: {
              ...runInput.properties,
              agentOffset: { type: "integer", minimum: 0, maximum: 1_000_000 },
              actionOffset: { type: "integer", minimum: 0, maximum: 256 },
              worktreeOffset: { type: "integer", minimum: 0, maximum: 1_000_000 },
              limit: { type: "integer", minimum: 1, maximum: 32 }
            }
          },
          outputSchema: object,
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "cancel",
          title: "请求取消当前工作流并等待清理",
          inputSchema: runInput,
          outputSchema: object,
          requiredPermissions: ["platform.read"],
          cancellable: false,
          idempotency: "keyed"
        }
      ]
    },
    read,
    watch: (context) => {
      let closed = false,
        queued = false,
        running = false,
        dirty = false
      const drain = async () => {
        queued = false
        if (closed || context.signal.aborted || running) return
        running = true
        try {
          do {
            dirty = false
            context.publish(await read(context))
          } while (dirty && !closed && !context.signal.aborted)
        } catch {
          if (!closed && !context.signal.aborted) {
            try {
              context.publish({ status: "unknown", reason: "WORKFLOW_OBSERVATION_UNAVAILABLE" })
            } catch {
              /* Revoked scopes cannot publish a late diagnostic either. */
            }
          }
        } finally {
          running = false
        }
      }
      const stop = deps.changed((threadId) => {
        if (threadId !== context.threadId || closed || context.signal.aborted) return
        dirty = true
        if (running || queued) return
        queued = true
        queueMicrotask(() => {
          void drain()
        })
      })
      return () => {
        closed = true
        stop()
      }
    },
    act: async (context, action, input) => {
      context.assertCurrent()
      if (action === "start" || action === "resume") {
        if (!deps.launch) throw Error("WORKFLOW_NATIVE_RUNTIME_UNAVAILABLE")
        const result = await deps.launch(context, action, input)
        context.assertCurrent()
        return result
      }
      const runId = input.runId as string
      if (action === "inspect") {
        const result = await deps.inspect(
          context.workspace,
          context.threadId,
          runId,
          input as { agentOffset?: number; worktreeOffset?: number; limit?: number }
        )
        context.assertCurrent()
        if (result?.nativeParent && (result.nativeParent.provider !== context.caller.name ||
          result.nativeParent.digest !== context.caller.digest ||
          result.nativeParent.incarnation !== context.incarnation)) throw Error("WORKFLOW_NATIVE_PARENT_MISMATCH")
        return { found: result !== null, run: result ? { ...result,
          ...deps.inspectActions?.(context, runId, input.actionOffset as number | undefined,
            input.limit as number | undefined) } : null }
      }
      if (action !== "cancel") throw Error("WORKFLOW_ACTION_UNKNOWN")
      const active = await deps.active(context.workspace, context.threadId)
      context.assertCurrent()
      if (active?.runId !== runId) return { requested: false, reason: "not-active" }
      if (!(await deps.confirmCancel(context, runId)))
        return { requested: false, reason: "user-declined" }
      context.assertCurrent()
      const current = await deps.active(context.workspace, context.threadId)
      context.assertCurrent()
      if (current?.runId !== runId) return { requested: false, reason: "not-active" }
      const requested = deps.cancel(context.threadId, runId)
      if (requested) await deps.settled(context.threadId, runId)
      context.assertCurrent()
      return { requested, cleanupSettled: requested, observation: await read(context) } as ModObject
    }
  }
}
