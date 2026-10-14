import { createHash } from "node:crypto"
import { clawModelFingerprint } from "../mods/flows/model-fingerprint"

export interface FlowPromptOnlySubagentOptions {
  profile: "prompt-only-v1"
  expectedModelDigest: string
  mandatoryPolicyDigest: string
  deadline: number
}
export interface FlowPromptOnlyRuntimeOptions extends FlowPromptOnlySubagentOptions {
  /** Created only by this runWorkflowSubagent invocation, not copied from Flow JSON. */
  invocation: object
  expectedModelRef: string
  rolePrompt: string
  assertCurrent(): void
}
export const FLOW_PROMPT_RUNTIME_PROTOCOL = "flow-text-runtime-v1" as const
export const FLOW_PROMPT_RESULT_TOOL_PROTOCOL = "host-workflow-structured-output-v1" as const
// Bump with any graph, fixed prompt, result-tool implementation, or middleware semantics change.
export const FLOW_PROMPT_IMPLEMENTATION_VERSION = "flow-text-runtime-2026-10-09-v1"
export const FLOW_PROMPT_FIXED_SYSTEM =
  "Complete the assigned text task using only the supplied " +
  "prompt and prior results. You have no business tools, filesystem access, skills, or subagents. " +
  "Return the final result through structured_output with passed and summary. Do not claim " +
  "that you ran project checks or performed external actions."

export function flowPromptResultSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["passed", "summary"],
    properties: {
      passed: { type: "boolean" },
      summary: { type: "string", minLength: 1, maxLength: 8000 }
    }
  }
}
export const flowPromptDigest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Pure descriptor; does not create a provider, graph, tool, session, connection, or authority. */
export function describeFlowPromptRuntime(input: {
  model: Parameters<typeof clawModelFingerprint>[0]
  rolePrompt: string
  mandatoryPolicyDigest: string
}) {
  const systemPrompt = input.rolePrompt
    ? `${input.rolePrompt}\n\n${FLOW_PROMPT_FIXED_SYSTEM}`
    : FLOW_PROMPT_FIXED_SYSTEM
  return Object.freeze({
    runtimeProtocol: FLOW_PROMPT_RUNTIME_PROTOCOL,
    modelRef: input.model.ref,
    modelConfigurationDigest: clawModelFingerprint(input.model),
    mandatoryPolicyDigest: input.mandatoryPolicyDigest,
    systemPrompt,
    systemPromptDigest: flowPromptDigest(systemPrompt),
    rolePromptDigest: flowPromptDigest(input.rolePrompt),
    resultTool: Object.freeze({
      protocol: FLOW_PROMPT_RESULT_TOOL_PROTOCOL,
      name: "structured_output" as const,
      schemaDigest: flowPromptDigest(JSON.stringify(flowPromptResultSchema())),
      implementationDigest: flowPromptDigest(FLOW_PROMPT_IMPLEMENTATION_VERSION)
    }),
    actualCapabilitiesDigest: flowPromptDigest(
      JSON.stringify({
        implementation: FLOW_PROMPT_IMPLEMENTATION_VERSION,
        businessTools: [],
        resultTool: FLOW_PROMPT_RESULT_TOOL_PROTOCOL,
        dynamicExtensions: false,
        skill: false,
        mcp: false,
        memory: false,
        workspacePrompt: false,
        subagents: false,
        filesystem: false,
        shell: false,
        stepHooks: false,
        compaction: false
      })
    )
  })
}

export interface FlowPromptRuntimeFacts {
  runtimeProtocol: typeof FLOW_PROMPT_RUNTIME_PROTOCOL
  modelRef: string
  modelConfigurationDigest: string
  mandatoryPolicyDigest: string
  systemPromptDigest: string
  rolePromptDigest: string
  resultTool: ReturnType<typeof describeFlowPromptRuntime>["resultTool"]
  actualCapabilitiesDigest: string
  businessInputDigest: string
  modelRequestLedgerDigest: string
  invocationLedgerDigest: string
  structuredOutputDigest: string
  modelCalls: number
  /** No fabricated IDs; actual upstream accounting references only. */
  providerUsageEvidenceIds: readonly string[]
}

export interface FlowPromptRuntimeReader {
  assertCurrent(): void
  dispose(): void
  seal(): Promise<FlowPromptRuntimeFacts>
}
