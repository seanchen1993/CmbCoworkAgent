import type { BusinessModCatalog } from "../../shared/business-mods"

/** An exact selected extension owns this protocol. It adds no Python or execution wildcard. */
export function assertBusinessModStageRecoveryProjection(
  catalog: BusinessModCatalog,
  files: ReadonlyMap<string, Buffer>
): string | undefined {
  const selected = (catalog.extensions ?? []).filter((extension) => extension.stageRecoveryAdapter)
  const bytes = files.get("devclaw.stage-recovery-adapter.json")
  if (!selected.length) {
    if (bytes) throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_UNDECLARED")
    return undefined
  }
  if (selected.length !== 1 || !bytes || bytes.length > 8192)
    throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_CONFLICT")
  const extension = selected[0],
    expected = extension.stageRecoveryAdapter!
  if (
    !extension.resources.some(
      (path) => expected.entry === path || expected.entry.startsWith(path + "/")
    )
  )
    throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_RESOURCE_MISSING")
  const adapter = files.get(expected.entry)
  if (!adapter || !adapter.length || adapter.length > 128 * 1024)
    throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_RESOURCE_MISSING")
  let actual: unknown
  try {
    actual = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_INVALID")
  }
  if (
    !actual ||
    typeof actual !== "object" ||
    Array.isArray(actual) ||
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(
      ([key, value]) => (actual as Record<string, unknown>)[key] !== value
    )
  )
    throw Error("BUSINESS_MOD_STAGE_RECOVERY_ADAPTER_CHANGED")
  return expected.entry
}
