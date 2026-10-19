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
  /** Description only; may recognize a genuine pending admission before currentSession publishes. */
  canDescribe?(binding: Readonly<RuntimePluginSourceBinding>): boolean
  execute(
    binding: Readonly<RuntimePluginSourceBinding>,
    input: ProjectCheckpointInput
  ): Promise<ProjectCheckpointResult>
}
let provider: Provider | undefined
const scopedProviders = new Set<Provider>()
/** Main-owned exact-source providers, separate from the unchanged composition owner. */
export function registerScopedProjectCheckpointProvider(next: Provider): () => void {
  if (scopedProviders.size >= 16) throw Error("PROJECT_CHECKPOINT_PROVIDER_LIMIT")
  scopedProviders.add(next)
  return () => { scopedProviders.delete(next) }
}
function selectedProvider(binding: Readonly<RuntimePluginSourceBinding>): Provider | undefined {
  if (binding.mode !== "legacy") return undefined
  const matching = [...scopedProviders].filter(value => value.available(binding))
  if (binding.projectId.startsWith("composition-legacy:") && provider?.available(binding))
    matching.push(provider)
  if (matching.length > 1) throw Error("PROJECT_CHECKPOINT_PROVIDER_AMBIGUOUS")
  return matching[0]
}
export function registerProjectCheckpointProvider(next: Provider): () => void {
  if (provider) throw Error("PROJECT_CHECKPOINT_PROVIDER_EXISTS")
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}
export function projectCheckpointAvailable(): boolean {
  const binding = currentRuntimePluginSource()
  return Boolean(binding && projectCheckpointAvailableForBinding(binding))
}
/** Main-only admission query for the exact pending token, before entering its ALS scope.
 * This does not issue a token, invoke a provider or authorize a checkpoint transition. */
export function projectCheckpointAvailableForBinding(
  binding: Readonly<RuntimePluginSourceBinding>
): boolean {
  return Boolean(selectedProvider(binding))
}
/** Read-only hint query; it cannot select an execution provider or grant checkpoint authority. */
export function projectCheckpointDescriptionAvailableForBinding(
  binding: Readonly<RuntimePluginSourceBinding>
): boolean {
  if (binding.mode !== "legacy") return false
  const matches = [...scopedProviders].filter(value => {
    try { return value.canDescribe ? value.canDescribe(binding) : value.available(binding) }
    catch { return false }
  })
  if (binding.projectId.startsWith("composition-legacy:") && provider?.available(binding))
    matches.push(provider)
  return matches.length === 1
}
export async function executeProjectCheckpoint(
  input: ProjectCheckpointInput
): Promise<ProjectCheckpointResult> {
  input.signal?.throwIfAborted()
  assertCurrentRuntimePluginSourceContent()
  const binding = currentRuntimePluginSource()
  const selected = binding && selectedProvider(binding)
  if (!binding || !selected)
    throw Error("PROJECT_CHECKPOINT_UNAVAILABLE")
  const result = await selected.execute(binding, input)
  input.signal?.throwIfAborted()
  assertCurrentRuntimePluginSourceContent()
  return result
}
