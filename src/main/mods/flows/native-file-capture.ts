import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { readFlowFileRuntimeProof } from "../../agent/flow-file-runtime"
import { isVirtualTreeStore, type VirtualTreeStore } from "./virtual-tree"
import type {
  FlowFileDependencies,
  FlowFileRuntimeSettledCapture
} from "../../../shared/mods/flows/file-recovery"
import type { FlowPromptExecutionBinding } from "../../../shared/mods/flows/prompt-recovery"
import { flowPromptStructuredOutputDigest } from "./prompt-recovery-receipt"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Native host only. Caller must still finish owned child cleanup before publishing this data. */
export async function sealNativeFlowFileCapture(input: {
  runtime: object
  invocation: object
  store: VirtualTreeStore
  binding: FlowPromptExecutionBinding
  dependencies: FlowFileDependencies
  structured: { passed: boolean; summary: string }
  assertCurrent(): void
}): Promise<FlowFileRuntimeSettledCapture> {
  const { runtime, invocation, store, assertCurrent } = input
  // All three are generated inside NativeHost, never accepted through a renderer/model API.
  const binding = structuredClone(input.binding)
  const dependencies = structuredClone(input.dependencies)
  const structuredDigest = flowPromptStructuredOutputDigest(input.structured)
  if (!isVirtualTreeStore(store)) throw Error("FLOW_FILE_STORE_IDENTITY")
  const proof = readFlowFileRuntimeProof(runtime, invocation)
  if (!proof) throw Error("FLOW_FILE_RUNTIME_PROOF_REQUIRED")
  assertCurrent()
  const facts = await proof.seal()
  assertCurrent()
  proof.assertCurrent()
  const expected = {
    runtimeProtocol: dependencies.runtimeProtocol,
    modelRef: dependencies.modelRef,
    modelConfigurationDigest: dependencies.modelConfigurationDigest,
    mandatoryPolicyDigest: dependencies.mandatoryPolicyDigest,
    systemPromptDigest: dependencies.systemPromptDigest,
    rolePromptDigest: dependencies.rolePromptDigest,
    resultTool: dependencies.resultTool,
    businessInputDigest: dependencies.stableInput.digest,
    virtualInputRoot: dependencies.virtualInput.root,
    structuredOutputDigest: structuredDigest
  }
  if (
    Object.entries(expected).some(
      ([key, value]) => !isDeepStrictEqual(value, facts[key as keyof typeof facts])
    )
  )
    throw Error("FLOW_FILE_RUNTIME_DEPENDENCIES_CHANGED")
  if (
    facts.files.tree.originDigest !== dependencies.virtualInput.originDigest ||
    facts.files.tree.binding.executionId !== binding.executionId ||
    facts.files.tree.binding.parentIncarnation !== binding.parentThreadIncarnation
  )
    throw Error("FLOW_FILE_RUNTIME_BINDING_CHANGED")
  const { effectLedgerDigest } = store.verifyReceipt({
    treeId: facts.files.tree.treeId,
    inputRoot: facts.virtualInputRoot,
    finalRoot: facts.files.tree.root,
    originDigest: facts.files.tree.originDigest,
    effectIds: facts.files.tree.effects,
    binding: facts.files.tree.binding,
    assertCurrent
  })
  assertCurrent()
  return {
    schemaVersion: 1,
    binding,
    dependencies,
    actualCapabilitiesDigest: facts.actualCapabilitiesDigest,
    modelRequestLedgerDigest: facts.modelRequestLedgerDigest,
    invocationLedgerDigest: facts.invocationLedgerDigest,
    structuredOutputDigest: facts.structuredOutputDigest,
    modelCalls: facts.modelCalls,
    providerUsageEvidenceIds: [...facts.providerUsageEvidenceIds],
    virtualTree: {
      schemaVersion: 1,
      treeId: facts.files.tree.treeId,
      inputRoot: facts.virtualInputRoot,
      finalRoot: facts.files.tree.root,
      originDigest: facts.files.tree.originDigest,
      readDependencyDigest: digest(facts.files.tree.dependencies),
      effectLedgerDigest,
      fileCallLedgerDigest: digest(facts.files.calls),
      fileCalls: facts.files.calls.length,
      effectIds: [...facts.files.tree.effects]
    }
  }
}
