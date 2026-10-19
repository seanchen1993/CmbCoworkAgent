import type { BusinessModKernel } from "../../shared/business-mods"
import type { BusinessModPreview } from "../../shared/business-mods"
import type { BusinessModAssemblyAdapter } from "./business-mod-assembly-contract"
import { autobizBusinessModAdapter } from "./business-mod-adapter-autobiz"
import { hostLinearBusinessModAdapter } from "./business-mod-adapter-host"

const compatibilityAdapter = autobizBusinessModAdapter
const assemblyAdapters: readonly BusinessModAssemblyAdapter[] = [
  compatibilityAdapter,
  hostLinearBusinessModAdapter
]

/** Closed, reviewed registry. Manifest authors cannot register or load executable adapters. */
export function resolveBusinessModAssemblyAdapter(
  kernel: BusinessModKernel
): BusinessModAssemblyAdapter {
  const id = kernel.runtime?.adapter ?? compatibilityAdapter.id
  const adapter = assemblyAdapters.find((candidate) => candidate.id === id)
  if (!adapter) throw Error("BUSINESS_MOD_ASSEMBLY_ADAPTER_UNSUPPORTED")
  if (
    assemblyAdapters.some(
      (candidate) => candidate !== adapter && candidate.ownsKernelIdentity?.(kernel)
    )
  )
    throw Error("BUSINESS_MOD_KERNEL_RUNTIME_CONFLICT")
  adapter.assertKernel(kernel)
  return adapter
}

/** Display/routing metadata only; it confers no installation or execution authority. */
export function describeBusinessModAssemblyRuntime(
  kernel: BusinessModKernel
): NonNullable<BusinessModPreview["runtime"]> {
  const adapter = resolveBusinessModAssemblyAdapter(kernel)
  return { adapter: adapter.id, mode: adapter.mode, stateOwner: adapter.stateOwner }
}
