import { z } from "zod"
import { createWorkflowTool, type CreateWorkflowToolOptions } from "./tool"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type { NativePlatformCallContext } from "../../mods/v2/platform-capabilities-types"
import type { ModObject } from "../../../shared/mods/types"
import { loadWorkflowRunAsync } from "./run-store"
import { workflowRunManager } from "./run-manager"

interface Registration {
  options: CreateWorkflowToolOptions
  assertCurrent(): void
}
const registered = new Map<string, Registration>()

/** The real runtime supplies its original approval channel, subagent factory and locks. */
export function registerNativeWorkflowLaunch(
  options: CreateWorkflowToolOptions,
  assertCurrent: () => void,
  signal?: AbortSignal
): () => void {
  if (signal?.aborted) return () => {}
  const registration = { options, assertCurrent }
  registered.delete(options.threadId)
  registered.set(options.threadId, registration)
  // Resident runtime registrations are bounded; eviction fails closed until runtime recreation.
  while (registered.size > 256) registered.delete(registered.keys().next().value!)
  const close = () => {
    if (registered.get(options.threadId) === registration) registered.delete(options.threadId)
    signal?.removeEventListener("abort", close)
  }
  signal?.addEventListener("abort", close, { once: true })
  return close
}

const start = z
  .object({ script: z.string().min(1).max(12000), args: z.unknown().optional() })
  .strict()
const resume = z.object({ runId: z.string().regex(/^wf_[a-z0-9]{6,32}$/) }).strict()

export async function executeNativeWorkflowLaunch(
  context: NativePlatformCallContext,
  action: "start" | "resume",
  raw: unknown
): Promise<ModObject> {
  context.assertCurrent()
  const registration = registered.get(context.threadId)
  if (!registration || !isSameWorkspacePath(registration.options.workspacePath, context.workspace))
    throw Error("WORKFLOW_NATIVE_RUNTIME_UNAVAILABLE")
  const assertCurrent = () => {
    context.signal.throwIfAborted()
    context.assertCurrent()
    registration.assertCurrent()
    if (registered.get(context.threadId) !== registration)
      throw Error("WORKFLOW_NATIVE_RUNTIME_CHANGED")
  }
  assertCurrent()
  const nativeParent = {
    threadId: context.threadId,
    incarnation: context.incarnation,
    provider: context.caller.name,
    digest: context.caller.digest
  }
  let input: { script?: string; args?: unknown; resumeFromRunId?: string }
  if (action === "start") input = start.parse(raw)
  else {
    const request = resume.parse(raw)
    const run = await loadWorkflowRunAsync(context.workspace, context.threadId, request.runId)
    assertCurrent()
    if (!run || JSON.stringify(run.nativeParent) !== JSON.stringify(nativeParent))
      throw Error("WORKFLOW_NATIVE_PARENT_MISMATCH")
    input = { resumeFromRunId: request.runId }
  }
  // Native requests always use the original approval UI, including when normal model YOLO is on.
  let launchedRunId: string | undefined
  const tool = createWorkflowTool({
    ...registration.options,
    readYoloMode: () => false,
    yoloMode: false,
    assertCurrent,
    nativeParent,
    requestLaunchApproval: (request) =>
      new Promise((done, failed) => {
        const abort = () => failed(context.signal.reason ?? Error("WORKFLOW_NATIVE_CANCELLED"))
        context.signal.addEventListener("abort", abort, { once: true })
        if (context.signal.aborted) abort()
        Promise.resolve()
          .then(() => {
            assertCurrent()
            if (!registration.options.requestApproval)
              throw Error("WORKFLOW_NATIVE_APPROVAL_UNAVAILABLE")
            return registration.options.requestApproval(request)
          })
          .then(done, failed)
          .finally(() => context.signal.removeEventListener("abort", abort))
      }),
    onLaunched: (runId) => {
      launchedRunId = runId
      registration.options.onLaunched?.(runId)
    }
  })
  let output: unknown
  try {
    output = await tool.invoke(input)
    assertCurrent()
  } catch (error) {
    if (launchedRunId) {
      workflowRunManager.cancel(context.threadId, launchedRunId, false)
      await workflowRunManager.waitForRunLifecycle(context.threadId, launchedRunId)
    }
    throw error
  }
  if (typeof output !== "string") throw Error("WORKFLOW_NATIVE_RESULT_INVALID")
  const result = JSON.parse(output) as Record<string, unknown>
  if (result.status === "rejected") return { status: "rejected" }
  if (result.status !== "launched" || typeof result.runId !== "string")
    throw Error("WORKFLOW_NATIVE_RESULT_INVALID")
  return {
    status: "launched",
    runId: result.runId,
    name: String(result.name ?? ""),
    ...(typeof result.warning === "string" ? { warning: result.warning } : {})
  }
}
