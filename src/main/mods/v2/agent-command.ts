import { randomUUID } from "node:crypto"
import type { ModsManager } from "../manager"
import type { ModRuntimeAuthority } from "../runtime-instance"
import { captureLocalThreadRunLease } from "../../agent/thread-run-lease"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { withFunctionCommandBinding } from "./command-binding"
import { functionExecutionScope, withFunctionWriteLease } from "./execution-context"
import { functionCallAuthority, withFunctionAgentExecution } from "./host-call"

export interface FunctionAgentCommandHost {
  manager: Pick<
    ModsManager,
    "needsCommandBinding" | "functionUserScope" | "createRuntimeAuthority" | "bindThread"
  >
  /** Revalidate the host's grant, workspace, thread and configuration epoch. */
  assertLive(): void
  /** Reject special/non-project threads before creating a cold command owner. */
  assertStandalone(): void
}

/** A cold explicit command gets a short-lived owner, never a tool backend or old main owner. */
export async function withFunctionAgentCommand<T>(
  host: FunctionAgentCommandHost,
  workspace: string,
  threadId: string,
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  host.assertLive()
  // Existing model/hook callers keep their original provenance and permission binding.
  if (functionCallAuthority(workspace, threadId)) return run()
  const scope = functionExecutionScope(workspace, threadId)
  if (
    !scope?.userInitiated ||
    !scope.leased ||
    scope.immediate ||
    (scope.agentId !== undefined && scope.agentId !== "main")
  )
    throw new ModFunctionError("MODS_AGENT_COMMAND_SCOPE_REQUIRED")
  const lease = captureLocalThreadRunLease(threadId)
  if (!lease) throw new ModFunctionError("MODS_FS_WRITE_LEASE")
  const assertLive = () => {
    signal.throwIfAborted()
    if (!lease()) throw new ModFunctionError("MODS_FS_WRITE_LEASE")
    functionExecutionScope(workspace, threadId)
    host.assertLive()
    host.assertStandalone()
  }
  // This fence validates the physical lease captured by the ORIGINAL host entry;
  // capturing a replacement lease here must never revive a stale continuation.
  // Exit the write fence before a native child enters its own independent thread.
  await withFunctionWriteLease(workspace, threadId, async () => {})
  let owner: ModRuntimeAuthority | undefined
  return withFunctionCommandBinding(
    "native",
    workspace,
    threadId,
    signal,
    async () => {
      assertLive()
      if (
        host.manager.functionUserScope(workspace, threadId).runtimeAuthority ||
        !host.manager.needsCommandBinding(threadId)
      )
        throw new ModFunctionError("MODS_AGENT_COMMAND_RUNTIME_CHANGED")
      const turnId = `function-agent-command:${randomUUID()}`
      const binding = {
        workspace,
        threadId,
        turnId,
        agentId: "main",
        signal,
        commandOnly: true,
        assertLive
      }
      const instance = host.manager.createRuntimeAuthority(binding)
      let releaseBinding: (() => void) | undefined
      try {
        releaseBinding = host.manager.bindThread({
          ...binding,
          runtimeAuthority: instance.authority
        })
        owner = instance.authority
        return () => {
          try {
            releaseBinding?.()
          } finally {
            instance.release()
          }
        }
      } catch (error) {
        instance.release()
        throw error
      }
    },
    async () => {
      assertLive()
      return withFunctionAgentExecution(
        {
          workspace,
          threadId,
          agentId: "main",
          turnId: owner!.turnId,
          runtimeAuthority: owner,
          userInitiated: true,
          leased: true,
          immediate: false
        },
        run
      )
    }
  )
}
