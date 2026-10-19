import {
  describeFlowFileRuntime,
  type FlowFileRuntimeProfile,
  type FlowFileRuntimeFacts,
  type FlowFileRuntimeReader
} from "./flow-file-runtime-contract"
export { describeFlowFileRuntime } from "./flow-file-runtime-contract"
export type {
  FlowFileRuntimeProfile,
  FlowFileRuntimeFacts,
  FlowFileRuntimeReader
} from "./flow-file-runtime-contract"
import { DynamicStructuredTool } from "@langchain/core/tools"
import { types } from "node:util"
import {
  createVirtualFileTools,
  readVirtualFileToolFacts,
  isFixedVirtualFileTool
} from "../mods/flows/virtual-file-tools"
import { SystemMessage } from "@langchain/core/messages"
import { createAgent, createMiddleware } from "langchain"
import { getModelConfigByRef } from "../models/registry"
import { clawModelFingerprint } from "../mods/flows/model-fingerprint"
import { getCheckpointer, getModelInstance, type CreateAgentRuntimeOptions } from "./runtime"
import {
  createFileRuntimeCallAdmission,
  readFileRuntimeCallDrainReceipt
} from "./file-runtime-call-admission"
import { readPromptOnlyStructuredOutputTool } from "./workflow/subagent"
import { flowPromptDigest } from "./flow-prompt-runtime-contract"

function captureToolIdentity(tool: DynamicStructuredTool) {
  const layers: {
    target: object
    prototype: object | null
    keys: PropertyKey[]
    descriptors: PropertyDescriptor[]
  }[] = []
  for (let target: object | null = tool; target; target = Object.getPrototypeOf(target)) {
    const keys = Reflect.ownKeys(target)
    layers.push({
      target,
      prototype: Object.getPrototypeOf(target),
      keys,
      descriptors: keys.map((key) => Object.getOwnPropertyDescriptor(target, key)!)
    })
  }
  const schemaText = JSON.stringify(tool.schema)
  let nodes = 0
  const schemaJson = (value: unknown, depth = 0): unknown => {
    if (depth > 16 || ++nodes > 128) throw Error("FLOW_FILE_SCHEMA_CHANGED")
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value
    if (!value || typeof value !== "object" || types.isProxy(value))
      throw Error("FLOW_FILE_SCHEMA_CHANGED")
    const entries: [string, unknown][] = []
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (
        key === "__absolute_uri__" &&
        !descriptor.enumerable &&
        typeof descriptor.value === "string"
      )
        continue
      if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable)
        throw Error("FLOW_FILE_SCHEMA_CHANGED")
      entries.push([key, schemaJson(descriptor.value, depth + 1)])
    }
    return Array.isArray(value) ? entries.map((entry) => entry[1]) : Object.fromEntries(entries)
  }
  return () => {
    for (const layer of layers) {
      if (Object.getPrototypeOf(layer.target) !== layer.prototype)
        throw Error("FLOW_FILE_TOOL_CHANGED")
      const keys = Reflect.ownKeys(layer.target)
      if (keys.length !== layer.keys.length || keys.some((key, i) => key !== layer.keys[i]))
        throw Error("FLOW_FILE_TOOL_CHANGED")
      for (let i = 0; i < keys.length; i++) {
        const now = Object.getOwnPropertyDescriptor(layer.target, keys[i])!
        const prior = layer.descriptors[i]
        if (
          now.value !== prior.value ||
          now.get !== prior.get ||
          now.set !== prior.set ||
          now.writable !== prior.writable ||
          now.configurable !== prior.configurable ||
          now.enumerable !== prior.enumerable
        )
          throw Error("FLOW_FILE_TOOL_CHANGED")
      }
    }
    nodes = 0
    if (JSON.stringify(schemaJson(tool.schema)) !== schemaText)
      throw Error("FLOW_FILE_SCHEMA_CHANGED")
  }
}

function freezeFacts<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeFacts(child)
    Object.freeze(value)
  }
  return value
}

function boundedToolCall(value: unknown): string {
  let nodes = 0
  let bytes = 0
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 128 || depth > 8) throw Error("FLOW_FILE_CALL_LIMIT")
    if (typeof item === "string") {
      if (item.length > 4 * 1024 * 1024 || (bytes += Buffer.byteLength(item)) > 8 * 1024 * 1024) {
        throw Error("FLOW_FILE_CALL_LIMIT")
      }
      return item
    }
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return item
    if (
      !item ||
      typeof item !== "object" ||
      types.isProxy(item) ||
      (Object.getPrototypeOf(item) !== null && Object.getPrototypeOf(item) !== Object.prototype)
    ) {
      throw Error("FLOW_FILE_CALL_INVALID")
    }
    const keys = Reflect.ownKeys(item)
    if (keys.length > 16) throw Error("FLOW_FILE_CALL_LIMIT")
    return Object.fromEntries(
      keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (
          typeof key !== "string" ||
          key.length > 128 ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          throw Error("FLOW_FILE_CALL_INVALID")
        }
        return [key, copy(descriptor.value, depth + 1)]
      })
    )
  }
  return JSON.stringify(copy(value, 0))
}

const proofs = new WeakMap<object, { invocation: object; reader: FlowFileRuntimeReader }>()

/** No public registration API: only the graph constructed below can own a reader. */
export function readFlowFileRuntimeProof(
  runtime: unknown,
  invocation: object
): FlowFileRuntimeReader | undefined {
  if (runtime === null || typeof runtime !== "object") return undefined
  const entry = proofs.get(runtime)
  return entry?.invocation === invocation ? entry.reader : undefined
}

/** Closed branch of the existing runtime factory, using its provider and checkpoint lifecycle. */
export async function createFlowFileRuntime(
  options: CreateAgentRuntimeOptions,
  requestedProfile: FlowFileRuntimeProfile
) {
  const { abortSignal, threadId, modelId, additionalTools } = options
  const tool = additionalTools?.[0]
  const toolCount = additionalTools?.length
  const profile = Object.freeze({
    ...requestedProfile,
    binding: Object.freeze({ ...requestedProfile.binding })
  })
  if (
    !profile ||
    profile.profile !== "workspace-files-v1" ||
    modelId !== profile.expectedModelRef ||
    !abortSignal ||
    !tool ||
    toolCount !== 1
  )
    throw Error("FLOW_PROMPT_RUNTIME_OPTIONS")
  abortSignal.throwIfAborted()
  const output = readPromptOnlyStructuredOutputTool(tool, profile.invocation)
  if (!output) throw Error("FLOW_PROMPT_RESULT_TOOL_IDENTITY")
  profile.assertCurrent()
  const config = getModelConfigByRef(profile.expectedModelRef)
  if (!config || clawModelFingerprint(config) !== profile.expectedModelDigest)
    throw Error("FLOW_PROMPT_MODEL_CHANGED")
  const descriptor = describeFlowFileRuntime({
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
      abortSignal.throwIfAborted()
      profile.assertCurrent()
      abortSignal.throwIfAborted()
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
  const model = getModelInstance(config, undefined, undefined, "agent", threadId, options.creatorAccounting)
  const checkpointer = await getCheckpointer(threadId)
  assertCurrent()
  const admission = createFileRuntimeCallAdmission({
    signal: abortSignal,
    deadline: profile.deadline,
    maxCalls: 128,
    assertCurrent
  })
  let fileCapabilities: ReturnType<typeof createVirtualFileTools>
  try {
    fileCapabilities = createVirtualFileTools({
      store: profile.store,
      treeId: profile.treeId,
      root: profile.root,
      binding: profile.binding,
      invocation: profile.invocation,
      signal: abortSignal,
      deadline: profile.deadline,
      maxCalls: 64,
      assertCurrent
    })
  } catch (error) {
    admission.dispose()
    throw error
  }
  const fileTools = (() => {
    try {
      return fileCapabilities.tools.map((capability) => {
        const schema = {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            path: { type: "string" as const, maxLength: 1024 },
            ...(capability.name === "virtual_write"
              ? { content: { type: "string" as const, maxLength: 4 * 1024 * 1024 } }
              : {})
          },
          required:
            capability.name === "virtual_list"
              ? []
              : capability.name === "virtual_write"
                ? ["path", "content"]
                : ["path"]
        }
        const adapter = new DynamicStructuredTool({
          name: capability.name,
          description: "Access only the persisted virtual namespace; never the live workspace.",
          schema,
          func: (input: unknown) => {
            if (!isFixedVirtualFileTool(capability, profile.invocation))
              throw Error("FLOW_FILE_TOOL_IDENTITY")
            return capability.invoke(input)
          }
        })
        return adapter
      })
    } catch (error) {
      admission.dispose()
      fileCapabilities.dispose()
      throw error
    }
  })()
  const expectedTools = [tool, ...fileTools]
  const fileGuards = fileTools.map(captureToolIdentity)
  const assertFileTools = () => {
    for (const guard of fileGuards) guard()
  }
  const reject = (code: string): never => {
    admission.dispose()
    fileCapabilities.dispose()
    throw Error(code)
  }
  const toolCallDigest = (value: unknown) => {
    try {
      return flowPromptDigest(boundedToolCall(value))
    } catch {
      return reject("FLOW_FILE_CALL_INVALID")
    }
  }
  let businessInputDigest: string | undefined
  const modelRequests: string[] = []
  const fileInvocations: string[] = []
  let acceptedDigest: string | undefined
  let resultInFlight = false
  let fileInFlight = 0
  const systemMessage = new SystemMessage(descriptor.systemPrompt)
  const middleware = createMiddleware({
    name: "flowVirtualFilesClosureV1",
    beforeModel: {
      canJumpTo: ["end"],
      hook: () => {
        assertCurrent()
        assertFileTools()
        // A successful result is terminal; never make a speculative post-result model call.
        if (acceptedDigest !== undefined) return { jumpTo: "end" as const }
        return undefined
      }
    },
    wrapModelCall: async (request, handler) => {
      if (request.model !== model) reject("FLOW_PROMPT_MODEL_IDENTITY")
      assertFileTools()
      if (
        request.tools.length !== expectedTools.length ||
        request.tools.some((candidate, index) => candidate !== expectedTools[index])
      )
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
          typeof first.content !== "string" ||
          first.content.length > 1024 * 1024
        )
          return reject("FLOW_PROMPT_INITIAL_MESSAGES")
        businessInputDigest = flowPromptDigest(first.content)
      }
      // Logical model requests only. Native fetch retries retain their existing accounting.
      const serialized = JSON.stringify({
        system: request.systemMessage.toJSON(),
        messages: request.messages.map((message) => message.toJSON()),
        tool: descriptor.resultTool,
        fileCapabilities: descriptor.actualCapabilitiesDigest,
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
      assertFileTools()
      const fileIndex = fileTools.findIndex((candidate) => candidate === request.tool)
      if (fileIndex >= 0) {
        if (
          request.toolCall.name !== fileTools[fileIndex].name ||
          acceptedDigest !== undefined ||
          resultInFlight
        ) {
          reject("FLOW_FILE_TOOL_IDENTITY")
        }
        fileInFlight++
        try {
          assertCurrent()
          return await admission.run("file-tool", toolCallDigest(request.toolCall), async () => {
            fileInvocations.push(request.toolCall.name)
            const result = await handler(request)
            assertFileTools()
            assertCurrent()
            return result
          })
        } catch (error) {
          admission.dispose()
          fileCapabilities.dispose()
          throw error
        } finally {
          fileInFlight--
        }
      }
      if (
        request.tool !== tool ||
        request.toolCall.name !== "structured_output" ||
        resultInFlight ||
        fileInFlight > 0 ||
        acceptedDigest !== undefined
      )
        reject("FLOW_PROMPT_RESULT_TOOL_IDENTITY")
      resultInFlight = true
      try {
        return await admission.run("result-tool", toolCallDigest(request.toolCall), async () => {
          const result = await handler(request)
          acceptedDigest = output.readAccepted()?.digest
          return result
        })
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
        tools: expectedTools,
        middleware: [middleware],
        checkpointer,
        signal: admission.signal
      })
    } catch (error) {
      admission.dispose()
      fileCapabilities.dispose()
      throw error
    }
  })()
  let sealing: Promise<FlowFileRuntimeFacts> | undefined
  const reader: FlowFileRuntimeReader = Object.freeze({
    assertCurrent,
    dispose: () => {
      admission.dispose()
      fileCapabilities.dispose()
    },
    seal() {
      return (sealing ??= (async () => {
        const [token, fileToken] = await Promise.all([admission.seal(), fileCapabilities.seal()])
        assertFileTools()
        const files = readVirtualFileToolFacts(fileToken)
        if (!files) throw Error("FLOW_FILE_UNSETTLED")
        assertCurrent()
        const drain = readFileRuntimeCallDrainReceipt(token)
        const accepted = output.readAccepted()
        if (
          drain?.calls.filter((call) => call.kind === "file-tool").length !== files.calls.length ||
          JSON.stringify([...fileInvocations].sort()) !==
            JSON.stringify(files.calls.map((call) => call.name).sort())
        )
          throw Error("FLOW_FILE_TOOL_COVERAGE")
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
          virtualInputRoot: profile.root,
          files: freezeFacts(files),
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
      })().finally(() => {
        admission.dispose()
        fileCapabilities.dispose()
      }))
    }
  })
  proofs.set(runtime, { invocation: profile.invocation, reader })
  return runtime
}
