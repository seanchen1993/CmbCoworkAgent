// Native JSON fields remain subject to the existing field-by-field runtime checks.
type EvidenceRecord = Record<string, any>
import type { JsonObject, SDK } from "devclaw-mods"
export type EvidenceOwner = "project" | "standalone"
/** Select exactly one original evidence owner; project errors never fall back to another thread. */
export async function selectCodeEvidenceOwner($: Pick<SDK, "platform">): Promise<EvidenceOwner> {
  const projectRef = { provider: "native.project-runtime", id: "project", version: "1.0.0" }
  const current = await $.platform.read({ ref: projectRef, target: { kind: "current" } })
  const value = current?.value as EvidenceRecord | undefined
  if (value?.status === "ready") return "project"
  if (value?.status === "unavailable" && value.code === "PROJECT_RUNTIME_PUBLIC_UNBOUND")
    return "standalone"
  throw Error("AUTOBIZ_CODE_PROJECT_EVIDENCE_SCOPE_UNAVAILABLE")
}

/** Return data only; never return a callback retaining a live SDK object. */
export async function readCodeEvidence(
  $: Pick<SDK, "platform">, owner: EvidenceOwner, input: JsonObject, requestKey: string
): Promise<EvidenceRecord> {
  if (owner === "project") return $.platform.act({
    ref: { provider: "native.project-runtime", id: "project", version: "1.0.0" },
    target: { kind: "current" }, action: "inspect-workflow-evidence",
    input: { ...input, stageId: "code" }, requestKey
  })
  if (owner === "standalone") return $.platform.act({
    ref: { provider: "native.workflow", id: "runs", version: "1.0.0" },
    target: { kind: "current" }, action: "inspect", input, requestKey
  })
  throw Error("AUTOBIZ_CODE_PROJECT_EVIDENCE_SCOPE_UNAVAILABLE")
}
