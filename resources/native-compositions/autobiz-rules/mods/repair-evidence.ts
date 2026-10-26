import { nativeCodeScriptSha256 } from "./code-script-identity"

/** Only original native action receipts can authorize the bounded repair branch. */
export async function readFailedTestReceipt($, envelope) {
  const { runId, executionId, expectedCommit, workspaceRef, provider } = envelope.input
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(workspaceRef))
    throw Error("AUTOBIZ_UT_WORKSPACE_REF_INVALID")
  let offset = 0
  const actions = []
  while (offset <= 128) {
    const receipt = await $.platform.act({
      ref: { provider: "native.workflow", id: "runs", version: "1.0.0" },
      target: { kind: "current" },
      action: "inspect",
      input: { runId, actionOffset: offset, limit: 32 },
      requestKey: envelope.executionId + ":repair-evidence:" + offset
    })
    const run = receipt.value?.run
    if (
      receipt.status !== "succeeded" ||
      !receipt.value?.found ||
      run?.runId !== runId ||
      !["running", "completed"].includes(run.status) ||
      run.scriptSha256 !== nativeCodeScriptSha256
    )
      throw Error("AUTOBIZ_UT_ORIGINAL_RUN_UNAVAILABLE")
    actions.push(...run.deterministicActions)
    if (run.nextActionOffset === null) break
    if (
      !Number.isInteger(run.nextActionOffset) ||
      run.nextActionOffset <= offset ||
      run.nextActionOffset > 128
    )
      throw Error("AUTOBIZ_UT_ORIGINAL_EVIDENCE_INCOMPLETE")
    offset = run.nextActionOffset
  }
  const candidates = actions.filter((action) => action.executionId === executionId)
  if (candidates.length !== 1) throw Error("AUTOBIZ_UT_ORIGINAL_RECEIPT_REQUIRED")
  const failed = candidates[0]
  const attempt = /^(.+)-test(?:-rerun-([12]))?$/.exec(failed.stepId)
  // The pinned workflow forwards its resolved action binding; final Code verification checks it again.
  if (
    failed.provider.pluginId !== provider.pluginId ||
    failed.provider.plugin !== provider.plugin ||
    failed.provider.digest !== provider.digest ||
    failed.provider.actionId !== "validate-command" ||
    failed.output?.headCommit !== expectedCommit ||
    failed.output?.workspaceRef !== workspaceRef ||
    failed.status !== "failed" ||
    failed.output?.phase !== "test" ||
    failed.outputTruncated ||
    !attempt ||
    actions.some(
      (action) =>
        action.provider.actionId === "validate-command" &&
        action.output?.phase === "test" &&
        action.stepId.startsWith(attempt[1] + "-test-rerun-") &&
        Number(action.stepId.split("-").at(-1)) > Number(attempt[2] ?? 0)
    )
  )
    throw Error("AUTOBIZ_UT_STALE_OR_FOREIGN_FAILURE")
  return failed
}
