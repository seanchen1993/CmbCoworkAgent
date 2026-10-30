import type { SDK } from "devclaw-mods"
/** Only original native action receipts can authorize the bounded repair branch. */
export async function readFailedTestReceipt($: Pick<SDK, "process" | "platform">, envelope: any) {
  const { runId, executionId, expectedCommit, workspaceRef, provider } = envelope.input
  if (runId !== envelope.runId) throw Error("AUTOBIZ_UT_FOREIGN_RUN")
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
    const run: any = (receipt.value as any)?.run
    if (
      receipt.status !== "succeeded" ||
      !(receipt.value as any)?.found ||
      run?.runId !== runId ||
      !["running", "completed"].includes(run.status) ||
      !/^[a-f0-9]{64}$/.test(run.scriptSha256)
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
  const candidates = actions.filter((action: any) => action.executionId === executionId)
  if (candidates.length !== 1) throw Error("AUTOBIZ_UT_ORIGINAL_RECEIPT_REQUIRED")
  const failed = candidates[0]
  const rules = actions.filter((action) => action.stepId === "solution-check")
  if (rules.length !== 1 || rules[0].status !== "succeeded" || rules[0].outputTruncated ||
      rules[0].output?.passed !== true || !rules[0].output?.inputDigests)
    throw Error("AUTOBIZ_UT_ORIGINAL_INPUTS_REQUIRED")
  const attempt = /^(.+)-test(?:-rerun-([12]))?$/.exec(failed.stepId)
  // The pinned workflow forwards its resolved action binding; final Code verification checks it again.
  if (
    failed.provider.pluginId !== provider.pluginId ||
    failed.provider.plugin !== provider.plugin ||
    failed.provider.digest !== provider.digest ||
    failed.provider.actionId !== "execute-command" ||
    failed.output?.headCommit !== expectedCommit ||
    failed.output?.workspaceRef !== workspaceRef ||
    failed.status !== "failed" ||
    failed.output?.phase !== "test" ||
    failed.outputTruncated ||
    !attempt ||
    actions.some(
      (action: any) =>
        action.provider.actionId === "execute-command" &&
        action.output?.phase === "test" &&
        action.stepId.startsWith(attempt[1] + "-test-rerun-") &&
        Number(action.stepId.split("-").at(-1)) > Number(attempt[2] ?? 0)
    )
  )
    throw Error("AUTOBIZ_UT_STALE_OR_FOREIGN_FAILURE")
  return { ...failed, inputDigests: rules[0].output.inputDigests }
}
