import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { withFunctionAgentExecution } from "../mods/v2/host-call"
import { runWithHookAgentId } from "../hooks/execution-context"

/** Host-only callback capability, never serialized or reconstructed from an agent id. */
export type HostRuntimeLifecycle = <T>(run: () => Promise<T>) => Promise<T>

export function createHostRuntimeLifecycle(
  authority: ModRuntimeAuthority | undefined,
  signal?: AbortSignal
): HostRuntimeLifecycle {
  return async (run) => {
    const assertLive = () => {
      signal?.throwIfAborted()
      authority?.assertLive()
    }
    assertLive()
    const invoke = async () => {
      assertLive()
      const result = await run()
      assertLive()
      return result
    }
    if (!authority) return invoke()
    return withFunctionAgentExecution(
      {
        workspace: authority.workspace,
        threadId: authority.threadId,
        agentId: authority.agentId,
        turnId: authority.turnId,
        runtimeAuthority: authority,
        userInitiated: false,
        leased: true,
        immediate: false
      },
      () => runWithHookAgentId(authority.agentId, invoke)
    )
  }
}
