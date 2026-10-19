import {
  assertCurrentRuntimePluginSourceContent,
  currentRuntimePluginSource,
  type RuntimePluginSourceBinding
} from "../../plugins/runtime-source-scope"
import type { StageCheckReceipt } from "../../../shared/project-runtime/stage-check-receipt"
export interface ProjectCheckpointInput {
  checkpoint: string
  expectedStateDigest: string
  signal?: AbortSignal
}
export interface ProjectCheckpointResult {
  status: "committed" | "not-applied" | "unknown"
  stateDigest?: string
  receipts: StageCheckReceipt[]
  message?: string
}
interface Provider {
  available(binding: Readonly<RuntimePluginSourceBinding>): boolean
  execute(
    binding: Readonly<RuntimePluginSourceBinding>,
    input: ProjectCheckpointInput
  ): Promise<ProjectCheckpointResult>
}
let provider: Provider | undefined
export function registerProjectCheckpointProvider(next: Provider): () => void {
  if (provider) throw Error("PROJECT_CHECKPOINT_PROVIDER_EXISTS")
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}
export function projectCheckpointAvailable(): boolean {
  const binding = currentRuntimePluginSource()
  return Boolean(
    binding?.mode === "legacy" &&
    binding.projectId.startsWith("composition-legacy:") &&
    provider?.available(binding)
  )
}
export async function executeProjectCheckpoint(
  input: ProjectCheckpointInput
): Promise<ProjectCheckpointResult> {
  input.signal?.throwIfAborted()
  assertCurrentRuntimePluginSourceContent()
  const binding = currentRuntimePluginSource()
  if (!binding || !projectCheckpointAvailable() || !provider)
    throw Error("PROJECT_CHECKPOINT_UNAVAILABLE")
  const result = await provider.execute(binding, input)
  input.signal?.throwIfAborted()
  assertCurrentRuntimePluginSourceContent()
  return result
}
