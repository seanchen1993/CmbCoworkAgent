import { randomUUID } from "node:crypto"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { ModError } from "../errors"
import { functionExecutionTurn } from "./execution-context"

interface RegisteredToolHost {
  assertScope(workspace: string, threadId: string): void
  admit(identity: ModIdentity, tool: string, input: ModObject, signal: AbortSignal): Promise<void>
  publish(identity: ModIdentity, value: ModObject, signal: AbortSignal): Promise<ModObject>
}

/** A registered tool executes optional guest code, so admission and execution receipts wrap it. */
export class FunctionRegisteredTools {
  constructor(
    private readonly store: ModControlStore,
    private readonly host: RegisteredToolHost
  ) {}

  async call(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    origin: "model" | "mod",
    signal: AbortSignal,
    run: () => Promise<ModObject>
  ): Promise<ModObject> {
    const identity: ModIdentity = {
      workspace,
      threadId,
      turnId: functionExecutionTurn(workspace, threadId) ?? `function-tool:${threadId}`,
      callId: randomUUID(),
      toolCallId: String(input.tool_use_id),
      agentId: typeof input.agentId === "string" ? input.agentId : "main",
      origin,
      modId: grant.modId,
      grantEpoch: grant.epoch
    }
    const target = `function:${input.tool}`
    const assertLive = () => {
      signal.throwIfAborted()
      this.host.assertScope(workspace, threadId)
      if (grant.workspace !== workspace || !grant.modId.startsWith("function:"))
        throw new ModFunctionError("MODS_GRANT_REVOKED")
      this.store.assertGrant(grant)
    }
    let claimed = false,
      started = false,
      settled = false
    try {
      assertLive()
      await this.host.admit(identity, target, input, signal)
      assertLive()
      this.store.claim(identity.callId, target, input, identity)
      claimed = true
      started = true
      const result = await run()
      this.store.settle(
        identity.callId,
        typeof result.deny === "string" || result.isError === true ? "failed" : "succeeded"
      )
      settled = true
      assertLive()
      const published = await this.host.publish(identity, result, signal)
      assertLive()
      return published
    } catch (error) {
      if (claimed) {
        if (!settled) this.store.settle(identity.callId, started ? "unknown" : "failed")
        this.store.blockPublication(identity.callId)
      }
      if (signal.aborted) throw new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
      if (error instanceof ModError || error instanceof ModFunctionError) throw error
      throw new ModFunctionError("MODS_REGISTERED_TOOL_FAILED", "MODS_REGISTERED_TOOL_FAILED", true)
    }
  }
}
