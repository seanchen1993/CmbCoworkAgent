import type { ModControlStore, ModGrant } from "../control-store"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { ModFunctionError, type ModOrigin } from "../../../shared/mods/v2/contracts"
import { ModError } from "../errors"
import { assertFunctionGrant, functionCallIdentity, runFunctionHostCall } from "./host-call"

interface RegisteredToolHost {
  assertScope(workspace: string, threadId: string): void
  admit(
    identity: ModIdentity,
    tool: string,
    input: ModObject,
    signal: AbortSignal,
    caller?: ModOrigin
  ): Promise<void>
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
    run: () => Promise<ModObject>,
    caller?: ModOrigin
  ): Promise<ModObject> {
    const identity = functionCallIdentity(workspace, threadId, grant, {
      fallbackTurnId: `function-tool:${threadId}`,
      toolCallId: String(input.tool_use_id),
      origin
    })
    if ((input.agentId ?? "main") !== identity.agentId)
      throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
    const target = `function:${input.tool}`
    const assertLive = () => {
      assertFunctionGrant(this.store, workspace, threadId, grant, signal)
      this.host.assertScope(workspace, threadId)
    }
    try {
      return await runFunctionHostCall({
        store: this.store,
        identity,
        assertLive,
        admit: () => this.host.admit(identity, target, input, signal, caller),
        claim: () => this.store.claim(identity.callId, target, input, identity),
        invoke: run,
        status: (result) =>
          typeof result.deny === "string" || result.isError === true ? "failed" : "succeeded",
        publish: (result) => this.host.publish(identity, result, signal)
      })
    } catch (error) {
      if (signal.aborted) throw new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
      if (error instanceof ModError || error instanceof ModFunctionError) throw error
      throw new ModFunctionError("MODS_REGISTERED_TOOL_FAILED", "MODS_REGISTERED_TOOL_FAILED", true)
    }
  }
}
