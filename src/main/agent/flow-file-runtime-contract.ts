import type { VirtualTreeStore, VirtualTreeBinding } from "../mods/flows/virtual-tree"
import type { readVirtualFileToolFacts } from "../mods/flows/virtual-file-tools"
import {
  describeFlowPromptRuntime,
  flowPromptDigest,
  type FlowPromptRuntimeFacts,
  type FlowPromptOnlyRuntimeOptions
} from "./flow-prompt-runtime-contract"

export interface FlowFileRuntimeProfile extends Omit<FlowPromptOnlyRuntimeOptions, "profile"> {
  profile: "workspace-files-v1"
  store: VirtualTreeStore
  treeId: string
  root: string
  binding: VirtualTreeBinding
}
export interface FlowFileRuntimeFacts extends Omit<FlowPromptRuntimeFacts, "runtimeProtocol"> {
  runtimeProtocol: "flow-files-runtime-v1"
  virtualInputRoot: string
  files: NonNullable<ReturnType<typeof readVirtualFileToolFacts>>
}
export interface FlowFileRuntimeReader {
  assertCurrent(): void
  dispose(): void
  seal(): Promise<FlowFileRuntimeFacts>
}
/** Pure descriptor: no provider, session, graph or file acquisition. */
export function describeFlowFileRuntime(input: Parameters<typeof describeFlowPromptRuntime>[0]) {
  const promptDescriptor = describeFlowPromptRuntime(input)
  const systemPrompt =
    input.rolePrompt +
    "\n\n" +
    "Complete the assigned task using only the supplied prompt and prior results, and the " +
    "fixed virtual file tools. Their paths belong to an isolated persisted virtual namespace, " +
    "not the user's live workspace. Reads and writes do not publish physical files. Writes atomically create missing virtual parent directories. " +
    "There are no shell commands, network tools, hooks, skills, or subagents. " +
    "Call structured_output only after all file operations complete. Do not claim native project tests or publication."
  return Object.freeze({
    ...promptDescriptor,
    runtimeProtocol: "flow-files-runtime-v1" as const,
    systemPrompt,
    systemPromptDigest: flowPromptDigest(systemPrompt),
    actualCapabilitiesDigest: flowPromptDigest(
      JSON.stringify({
        version: "flow-files-2026-10-09-v2",
        tools: [
          "virtual_read",
          "virtual_list",
          "virtual_exists",
          "virtual_write",
          "structured_output"
        ],
        dynamicExtensions: false,
        filesystem: "virtual-tree-only",
        shell: false,
        mcp: false,
        skills: false,
        stepHooks: false,
        subagents: false,
        compaction: false
      })
    )
  })
}
