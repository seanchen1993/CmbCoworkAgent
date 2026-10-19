import { SystemMessage } from "@langchain/core/messages"
import { createAgent, createMiddleware } from "langchain"
import { getModelConfigByRef } from "../models/registry"
import { clawModelFingerprint } from "../mods/flows/model-fingerprint"
import { getCheckpointer, getModelInstance, type CreateAgentRuntimeOptions } from "./runtime"
import { createPromptCallAdmission, readPromptCallDrainReceipt } from "./prompt-call-admission"
import { readPromptOnlyStructuredOutputTool } from "./workflow/subagent"
import {
  describeFlowPromptRuntime,
  flowPromptDigest,
  type FlowPromptRuntimeFacts,
  type FlowPromptRuntimeReader
} from "./flow-prompt-runtime-contract"

const proofs = new WeakMap<object, { invocation: object; reader: FlowPromptRuntimeReader }>()

/** No public registration API: only the graph constructed below can own a reader. */
export function readFlowPromptRuntimeProof(
  runtime: unknown,
  invocation: object
): FlowPromptRuntimeReader | undefined {
  if (runtime === null || typeof runtime !== "object") return undefined
  const entry = proofs.get(runtime)
  return entry?.invocation === invocation ? entry.reader : undefined
}

/** Closed branch of the existing runtime factory, using its provider and checkpoint lifecycle. */
export async function createFlowPromptRuntime(options: CreateAgentRuntimeOptions) {
  const profile = options.flowPromptOnly
  if (
    !profile ||
    profile.profile !== "prompt-only-v1" ||
    options.modelId !== profile.expectedModelRef ||
    !options.abortSignal ||
    options.additionalTools?.length !== 1
  )
    throw Error("FLOW_PROMPT_RUNTIME_OPTIONS")
  const tool = options.additionalTools[0]
  const output = readPromptOnlyStructuredOutputTool(tool, profile.invocation)
  if (!output) throw Error("FLOW_PROMPT_RESULT_TOOL_IDENTITY")
  profile.assertCurrent()
  const config = getModelConfigByRef(profile.expectedModelRef)
  if (!config || clawModelFingerprint(config) !== profile.expectedModelDigest)
    throw Error("FLOW_PROMPT_MODEL_CHANGED")
  const descriptor = describeFlowPromptRuntime({
    model: config,
    rolePrompt: profile.rolePrompt,
    mandatoryPolicyDigest: profile.mandatoryPolicyDigest
  })
  if (output.schemaDigest !== descriptor.resultTool.schemaDigest)
    throw Error("FLOW_PROMPT_RESULT_SCHEMA")
  // Credentials remain an ephemeral equality guard, never an audit field or digest input.
  const credential = config.apiKey
  let invalid = false
  const assertCurrent = () => {
    if (invalid) throw Error("FLOW_PROMPT_AUTHORITY_INVALIDATED")
    try {
      profile.assertCurrent()
      output.assertCurrent()
      const current = getModelConfigByRef(profile.expectedModelRef)
      if (
        !current ||
        current.apiKey !== credential ||
        clawModelFingerprint(current) !== descriptor.modelConfigurationDigest
      )
        throw Error("FLOW_PROMPT_MODEL_CHANGED")
    } catch (error) {
      invalid = true
      throw error
    }
  }
  assertCurrent()
  const model = getModelInstance(config, undefined, undefined, "agent", options.threadId, options.creatorAccounting)
  const checkpointer = await getCheckpointer(options.threadId)
  assertCurrent()
  const admission = createPromptCallAdmission({
    signal: options.abortSignal,
    deadline: profile.deadline,
    maxCalls: 32,
    assertCurrent
  })
  const reject = (code: string): never => {
    admission.dispose()
    throw Error(code)
  }
  let businessInputDigest: string | undefined
  const modelRequests: string[] = []
  let acceptedDigest: string | undefined
  let resultInFlight = false
  const systemMessage = new SystemMessage(descriptor.systemPrompt)
  const middleware = createMiddleware({
    name: "flowPromptOnlyClosureV1",
    beforeModel: {
      canJumpTo: ["end"],
      hook: () => {
        assertCurrent()
        // A successful result is terminal; never make a speculative post-result model call.
        if (acceptedDigest !== undefined) return { jumpTo: "end" as const }
        return undefined
      }
    },
    wrapModelCall: async (request, handler) => {
      if (request.model !== model) reject("FLOW_PROMPT_MODEL_IDENTITY")
      if (request.tools.length !== 1 || request.tools[0] !== tool)
        reject("FLOW_PROMPT_MODEL_TOOL_IDENTITY")
      if (
        request.systemMessage !== systemMessage ||
        request.systemMessage.content !== descriptor.systemPrompt
      )
        reject("FLOW_PROMPT_SYSTEM_CHANGED")
      if (acceptedDigest !== undefined) reject("FLOW_PROMPT_RESULT_ALREADY_ACCEPTED")
      if (businessInputDigest === undefined) {
        const first = request.messages[0]
        if (
          request.messages.length !== 1 ||
          first?.getType() !== "human" ||
          typeof first.content !== "string"
        )
          return reject("FLOW_PROMPT_INITIAL_MESSAGES")
        businessInputDigest = flowPromptDigest(first.content)
      }
      // Logical model requests only. Native fetch retries retain their existing accounting.
      const serialized = JSON.stringify({
        system: request.systemMessage.toJSON(),
        messages: request.messages.map((message) => message.toJSON()),
        tool: descriptor.resultTool,
        model: descriptor.modelConfigurationDigest
      })
      if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) reject("FLOW_PROMPT_REQUEST_LIMIT")
      const digest = flowPromptDigest(serialized)
      return admission.run("model", digest, async () => {
        modelRequests.push(digest)
        return handler(request)
      })
    },
    wrapToolCall: async (request, handler) => {
      if (
        request.tool !== tool ||
        request.toolCall.name !== "structured_output" ||
        resultInFlight ||
        acceptedDigest !== undefined
      )
        reject("FLOW_PROMPT_RESULT_TOOL_IDENTITY")
      resultInFlight = true
      try {
        return await admission.run(
          "result-tool",
          flowPromptDigest(JSON.stringify(request.toolCall)),
          async () => {
            const result = await handler(request)
            acceptedDigest = output.readAccepted()?.digest
            return result
          }
        )
      } finally {
        resultInFlight = false
      }
    }
  })
  const runtime = (() => {
    try {
      return createAgent({
        model,
        systemPrompt: systemMessage,
        tools: [tool],
        middleware: [middleware],
        checkpointer,
        signal: admission.signal
      })
    } catch (error) {
      admission.dispose()
      throw error
    }
  })()
  let sealing: Promise<FlowPromptRuntimeFacts> | undefined
  const reader: FlowPromptRuntimeReader = Object.freeze({
    assertCurrent,
    dispose: () => admission.dispose(),
    seal() {
      return (sealing ??= (async () => {
        const token = await admission.seal()
        assertCurrent()
        const drain = readPromptCallDrainReceipt(token)
        const accepted = output.readAccepted()
        if (
          !drain ||
          !accepted ||
          accepted.digest !== acceptedDigest ||
          !businessInputDigest ||
          modelRequests.length === 0
        )
          throw Error("FLOW_PROMPT_UNSETTLED_RESULT")
        return Object.freeze({
          runtimeProtocol: descriptor.runtimeProtocol,
          modelRef: descriptor.modelRef,
          modelConfigurationDigest: descriptor.modelConfigurationDigest,
          mandatoryPolicyDigest: descriptor.mandatoryPolicyDigest,
          systemPromptDigest: descriptor.systemPromptDigest,
          rolePromptDigest: descriptor.rolePromptDigest,
          resultTool: descriptor.resultTool,
          actualCapabilitiesDigest: descriptor.actualCapabilitiesDigest,
          businessInputDigest,
          modelRequestLedgerDigest: flowPromptDigest(JSON.stringify(modelRequests)),
          invocationLedgerDigest: drain.digest,
          structuredOutputDigest: accepted.digest,
          modelCalls: modelRequests.length,
          providerUsageEvidenceIds: Object.freeze([])
        })
      })().finally(() => admission.dispose()))
    }
  })
  proofs.set(runtime, { invocation: profile.invocation, reader })
  return runtime
}
