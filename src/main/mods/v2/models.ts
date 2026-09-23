import { randomUUID } from "node:crypto"
import type { ModControlStore, ModGrant } from "../control-store"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { ModError } from "../errors"
import { currentCompletionBudget, reserveCompletionModelUsage, type CompletionReservation } from "./completion-budget"
import { assertFunctionGrant, functionCallIdentity, runFunctionHostCall } from "./host-call"
import {
  functionModelRequest,
  validateFunctionModelText,
  type FunctionModelRequest,
  type FunctionModelReply
} from "./model-sdk"
import {
  classifyLabel,
  functionModelClassifyRequest,
  functionModelForkRequest,
  type FunctionModelForkReply,
  type FunctionModelForkSnapshot
} from "./model-operations"

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
  captureForkSnapshot?(workspace: string, threadId: string): FunctionModelForkSnapshot | null
  invokeFork?(
    config: ResolvedModelConfig,
    request: { prompt: string; model?: string; maxTokens?: number },
    snapshot: FunctionModelForkSnapshot,
    signal: AbortSignal
  ): Promise<FunctionModelForkReply>
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
    const result = await this.runModel(
      workspace,
      threadId,
      grant,
      input,
      request,
      callerSignal,
      (config, resolved, signal) => this.host.invoke(config, resolved, signal)
    )
    return result.text
  }

  async classify(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    callerSignal: AbortSignal
  ): Promise<string | undefined> {
    const request = functionModelClassifyRequest(input)
    const labels = request.labels.map((label) => JSON.stringify(label)).join(", ")
    const prompt =
      `Choose exactly one label from [${labels}] for the text below. ` +
      `Return only the label, with no explanation.\n\nText:\n${request.text}`
    const result = await this.runModel(
      workspace,
      threadId,
      grant,
      input,
      {
        model: request.model,
        prompt,
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens })
      },
      callerSignal,
      (config, resolved, signal) => this.host.invoke(config, resolved, signal)
    )
    return classifyLabel(result.text, request.labels)
  }

  async fork(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    callerSignal: AbortSignal
  ): Promise<FunctionModelForkReply | null> {
    const request = functionModelForkRequest(input)
    if (!this.host.captureForkSnapshot || !this.host.invokeFork) return null
    assertFunctionGrant(this.store, workspace, threadId, grant, callerSignal)
    this.host.assertScope(workspace, threadId)
    const snapshot = this.host.captureForkSnapshot(workspace, threadId)
    if (!snapshot) return null
    try {
      snapshot.assertLive?.()
      const result = await this.runModel(
        workspace,
        threadId,
        grant,
        input,
        {
          model: snapshot.model,
          prompt: request.prompt,
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens })
        },
        callerSignal,
        async (config, resolved, signal) => {
          snapshot.assertLive?.()
          const reply = await this.host.invokeFork!(config, resolved, snapshot, signal)
          snapshot.assertLive?.()
          return {
            text: reply.text,
            inputTokens: reply.usage?.input_tokens,
            outputTokens: reply.usage?.output_tokens
          }
        },
        () => snapshot.assertLive?.(),
        Buffer.byteLength(JSON.stringify({ messages: snapshot.messages, system: snapshot.system,
          prompt: request.prompt }), "utf8") + 128 * (snapshot.messages.length + 2)
      )
      return {
        text: result.text,
        ...(result.inputTokens === undefined && result.outputTokens === undefined
          ? {}
          : { usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens } })
      }
    } catch (error) {
      if (
        error instanceof ModFunctionError &&
        ["MODS_MODEL_FAILED", "MODS_MODEL_UNAVAILABLE"].includes(error.code)
      )
        return null
      throw error
    } finally {
      snapshot.release?.()
    }
  }

  private async runModel(
    workspace: string,
    threadId: string,
    grant: ModGrant,
    input: ModObject,
    request: FunctionModelRequest,
    callerSignal: AbortSignal,
    invoke: (
      config: ResolvedModelConfig,
      request: FunctionModelRequest,
      signal: AbortSignal
    ) => Promise<FunctionModelReply>,
    assertCapturedScope?: () => void,
    inputUpperBound = Buffer.byteLength(request.prompt + (request.system ?? ""), "utf8") + 128
  ): Promise<FunctionModelReply> {
    const timer = new AbortController()
    const timeout = setTimeout(() => timer.abort(), 60000)
    const signal = AbortSignal.any([callerSignal, timer.signal])
    const assertLive = (): void => {
      assertFunctionGrant(this.store, workspace, threadId, grant, signal)
      this.host.assertScope(workspace, threadId)
      assertCapturedScope?.()
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
      const completionBudget = currentCompletionBudget()
      const availableOutput = completionBudget
        ? completionBudget.availableTokens() - inputUpperBound : Infinity
      // A too-large observer rewrite may reduce the output cap, but cannot spend past the budget.
      if (availableOutput < 1) completionBudget!.reserve(inputUpperBound, 1)
      const maxTokens = Math.min(request.maxTokens ?? 256, config.maxOutputTokens ?? 4096, availableOutput)
      const identity = functionCallIdentity(workspace, threadId, grant, {
        fallbackTurnId: `function-model:${randomUUID()}`,
        origin: "mod"
      })
      const finalInput = { ...input, model: config.ref, maxTokens }
      let providerResult: FunctionModelReply | undefined
      let completionReservation: CompletionReservation | undefined
      const published = await runFunctionHostCall({
        store: this.store,
        identity,
        assertLive,
        admit: () => this.host.admit(identity, finalInput, signal),
        claim: () =>
          this.store.claimFunctionModel(identity, input, finalInput, config.ref, maxTokens),
        invoke: async () => {
          completionReservation = reserveCompletionModelUsage(inputUpperBound, maxTokens)
          try {
            providerResult = await invoke(config, { ...request, maxTokens }, signal)
          } catch (error) {
            // Preserve the provider failure, but a caller cannot catch it and invent known usage.
            try { completionReservation?.settle() } catch { /* budget keeps the failure */ }
            throw error
          }
          return providerResult
        },
        status: () => "succeeded",
        recordResult: (result) => {
          this.store.recordFunctionModelUsage(
            identity.callId,
            result.inputTokens,
            result.outputTokens
          )
          completionReservation?.settle(result.inputTokens, result.outputTokens)
        },
        publish: async (result) => {
          validateFunctionModelText(result.text)
          // Complete provider text is protected before any guest after-hook can observe it.
          const published = await this.host.publish(identity, result.text, signal)
          validateFunctionModelText(published)
          return published
        }
      })
      return {
        text: published,
        ...(providerResult?.inputTokens === undefined
          ? {}
          : { inputTokens: providerResult.inputTokens }),
        ...(providerResult?.outputTokens === undefined
          ? {}
          : { outputTokens: providerResult.outputTokens })
      }
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
