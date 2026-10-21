/** Plugin business policy. Python validators remain authoritative for artifacts and lifecycle. */
export const transitions: Record<string, readonly string[]> = {
  prd_in_progress: ["prd_done"],
  prd_done: ["specs_in_progress"],
  specs_in_progress: ["specs_done"],
  specs_done: ["design_in_progress"],
  design_in_progress: ["design_done"],
  design_done: ["plan_in_progress"],
  plan_in_progress: ["plan_done"],
  plan_done: ["code_in_progress", "detail_design_in_progress"],
  detail_design_in_progress: ["detail_design_done"],
  detail_design_done: ["code_in_progress"],
  code_in_progress: ["code_done"],
  code_done: ["cicd_in_progress"],
  cicd_in_progress: ["cicd_done"],
  cicd_done: ["archived"],
  archived: []
}

const fixedNodes = [
  "biz.prd",
  "dev.specs",
  "dev.design",
  "dev.plan",
  "dev.code",
  "ops.cicd",
  "ops.archive"
]

export function decide(record: Record<string, unknown>, requested: string) {
  if (!record || typeof record.checkpoint !== "string") throw Error("AUTOBIZ_MOD_STATE_INVALID")
  const nodes = record.workflowNodes
  if (
    Array.isArray(nodes) &&
    nodes.length &&
    JSON.stringify(nodes.filter((node) => node !== "dev.detail_design")) !==
      JSON.stringify(fixedNodes)
  )
    throw Error("AUTOBIZ_MOD_FIXED_WORKFLOW_REQUIRED")
  const allowed = transitions[record.checkpoint]
  if (!Array.isArray(allowed) || !allowed.includes(requested))
    throw Error("AUTOBIZ_MOD_TRANSITION_REJECTED")
  return { from: record.checkpoint, to: requested }
}
