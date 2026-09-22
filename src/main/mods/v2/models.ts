import { randomUUID } from "node:crypto"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { ModError } from "../errors"
import { assertFunctionGrant, functionCallIdentity, runFunctionHostCall } from "./host-call"
import {
  functionModelRequest,
  validateFunctionModelText,
  type FunctionModelRequest,
  type FunctionModelReply
} from "./model-sdk"

interface FunctionModelHost {
  assertScope(workspace: string, threadId: string): void
  resolve(name: string): Promise<ResolvedModelConfig>
  invoke(
    config: ResolvedModelConfig,
    request: FunctionModelRequest,
    signal: AbortSignal
  ): Promise<FunctionModelReply>
  admit(identity: ModIdentity, input: ModObject, signal: AbortSignal): Promise<void>
  publish(identity: ModIdentity, value: string, signal: AbortSignal): Promise<string>
}

/** Bounded, separately accounted completions. Every explicit next reaches a fresh reservation. */
export class FunctionModels {
  private readonly active = new Map<string, number>()
  private pending = 0

  constructor(
    private readonly store: ModControlStore,
    private readonly host: FunctionModelHost
  ) {}

  get stats() {
    return { pending: this.pending, scopes: this.active.size }
  }

  async complete(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    callerSignal: AbortSignal
  ): Promise<string> {
    const request = functionModelRequest(input)
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), 60000)
    const signal = AbortSignal.any([callerSignal, timer.signal])
    const assertLive = (): void => {
      assertFunctionGrant(this.store, workspace, threadId, grant, signal)
      this.host.assertScope(workspace, threadId)
    }
    const key = JSON.stringify([workspace, grant.modId])
    let reserved = false
    try {
      assertLive()
      if (this.pending >= 4 || (this.active.get(key) ?? 0) >= 2)
        throw new ModFunctionError("MODS_MODEL_CAPACITY")
      this.pending++
      this.active.set(key, (this.active.get(key) ?? 0) + 1)
      reserved = true
      const config = await this.host.resolve(request.model)
      assertLive()
      const maxTokens = Math.min(request.maxTokens ?? 256, config.maxOutputTokens ?? 4096)
      const identity = functionCallIdentity(workspace, threadId, grant, {
        fallbackTurnId: `function-model:${randomUUID()}`,
        origin: "mod"
      })
      const finalInput = { ...input, model: config.ref, maxTokens }
      return await runFunctionHostCall({
        store: this.store,
        identity,
        assertLive,
        admit: () => this.host.admit(identity, finalInput, signal),
        claim: () =>
          this.store.claimFunctionModel(identity, input, finalInput, config.ref, maxTokens),
        invoke: () => this.host.invoke(config, { ...request, maxTokens }, signal),
        status: () => "succeeded",
        recordResult: (result) =>
          this.store.recordFunctionModelUsage(
            identity.callId,
            result.inputTokens,
            result.outputTokens
          ),
        publish: async (result) => {
          validateFunctionModelText(result.text)
          // Complete provider text is protected before any guest after-hook can observe it.
          const published = await this.host.publish(identity, result.text, signal)
          validateFunctionModelText(published)
          return published
        }
      })
    } catch (error) {
      if (signal.aborted)
        throw new ModFunctionError(timer.signal.aborted ? "MODS_MODEL_TIMEOUT" : "MODS_CANCELLED")
      if (error instanceof ModFunctionError || error instanceof ModError) throw error
      // Provider errors can contain credentials, request bodies or endpoint details.
      throw new ModFunctionError("MODS_MODEL_FAILED")
    } finally {
      clearTimeout(timeout)
      if (reserved) {
        this.pending--
        const count = this.active.get(key)! - 1
        if (count) this.active.set(key, count)
        else this.active.delete(key)
      }
    }
  }
}
