/** Select exactly one original evidence owner; project errors never fall back to another thread. */
export async function createCodeEvidenceReader($) {
  const projectRef = { provider: "native.project-runtime", id: "project", version: "1.0.0" }
  const current = await $.platform.read({ ref: projectRef, target: { kind: "current" } })
  const value = current?.value
  if (value?.status === "ready") return (input, requestKey) => $.platform.act({
    ref: projectRef, target: { kind: "current" }, action: "inspect-workflow-evidence",
    input: { ...input, stageId: "code" }, requestKey
  })
  if (value?.status === "unavailable" && value.code === "PROJECT_RUNTIME_PUBLIC_UNBOUND")
    return (input, requestKey) => $.platform.act({
      ref: { provider: "native.workflow", id: "runs", version: "1.0.0" },
      target: { kind: "current" }, action: "inspect", input, requestKey
    })
  throw Error("AUTOBIZ_CODE_PROJECT_EVIDENCE_SCOPE_UNAVAILABLE")
}
