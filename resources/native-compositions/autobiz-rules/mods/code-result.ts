import { createCodeEvidenceReader } from "./code-evidence-reader"
import { readCodeWorktrees } from "./code-worktrees"
import { checkUtBudget } from "./code-budget"
import { nativeCodeScriptSha256 } from "./code-script-identity"

/** Verify original platform/workflow receipts. The artifact only selects an existing run. */
export async function checkCodeResult($, envelope, checkPlan) {
  const selection = envelope.input
  const expected = envelope.config?.nativeCompositionProvider
  if (
    !selection ||
    typeof selection.feature !== "string" ||
    typeof selection.runId !== "string" ||
    !expected ||
    expected.plugin !== "autobiz-native-rules" ||
    !["code", "cicd", "archive"].includes(expected.actionId)
  )
    throw Error("AUTOBIZ_CODE_EVIDENCE_BINDING_REQUIRED")
  const inspect = await createCodeEvidenceReader($)
  let offset = 0
  let run
  const actions = []
  while (offset <= 128) {
    const receipt = await inspect(
      { runId: selection.runId, actionOffset: offset, limit: 32 },
      envelope.executionId + ":code-evidence:" + offset
    )
    if (receipt.status !== "succeeded" || !receipt.value?.found)
      throw Error("AUTOBIZ_CODE_ORIGINAL_RUN_UNAVAILABLE")
    const current = receipt.value.run
    if (
      !current ||
      current.runId !== selection.runId ||
      current.status !== "completed" ||
      current.scriptSha256 !== nativeCodeScriptSha256 ||
      current.resultTruncated ||
      !Number.isInteger(current.worktreeCount) ||
      current.worktreeCount < 1 ||
      current.worktreeCount > 8 ||
      !Array.isArray(current.worktrees)
    )
      throw Error("AUTOBIZ_CODE_ORIGINAL_RUN_UNVERIFIED")
    if (run && JSON.stringify(run.result) !== JSON.stringify(current.result))
      throw Error("AUTOBIZ_CODE_ORIGINAL_RESULT_CHANGED")
    run = current
    actions.push(...current.deterministicActions)
    const next = current.nextActionOffset
    if (next === null) break
    if (!Number.isInteger(next) || next <= offset || next > 128)
      throw Error("AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE")
    offset = next
  }
  run.worktrees = await readCodeWorktrees($, envelope, run, inspect)
  const result = run.result
  const currentPlan = JSON.parse(await $.fs.read("PLAN.bundle.json"))
  const planCheck = await checkPlan(currentPlan)
  if (
    planCheck.passed !== true ||
    result?.protocol !== "autobiz.native-code-result/v2" ||
    result.feature !== selection.feature ||
    currentPlan.feature !== selection.feature ||
    result.status !== "succeeded" ||
    result.planSha256 !== planCheck.inputSha256
  )
    throw Error("AUTOBIZ_CODE_PLAN_OR_RESULT_CHANGED")
  if (
    !Array.isArray(result.executionIds) ||
    new Set(result.executionIds).size !== result.executionIds.length ||
    actions.length !== result.executionIds.length ||
    actions.length !== run.actionCount
  )
    throw Error("AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE")
  const original = (executionId, allowFailure = false) => {
    const matches = actions.filter((action) => action.executionId === executionId)
    if (matches.length !== 1) throw Error("AUTOBIZ_CODE_ACTION_ID_INVALID")
    const action = matches[0]
    if (
      (!allowFailure && action.status !== "succeeded") ||
      action.outputTruncated ||
      (!allowFailure && action.output?.passed !== true) ||
      action.provider.pluginId !== expected.pluginId ||
      action.provider.plugin !== expected.plugin ||
      action.provider.digest !== expected.digest ||
      !["plan", "validate-command", "inspect-workspace", "repair-evidence"].includes(
        action.provider.actionId
      )
    )
      throw Error("AUTOBIZ_CODE_ACTION_IDENTITY_OR_RESULT_INVALID")
    if (
      action.provider.actionId === "validate-command" &&
      (action.output?.performance?.passed !== true ||
        !Array.isArray(action.output.performance.files) ||
        !Array.isArray(action.output.performance.errors) ||
        action.output.performance.errors.length !== 0)
    )
      throw Error("AUTOBIZ_CODE_PERFORMANCE_EVIDENCE_REQUIRED")
    return action
  }
  if (!Array.isArray(result.repairs)) throw Error("AUTOBIZ_CODE_REPAIR_EVIDENCE_REQUIRED")
  const allowedFailures = new Set()
  for (const repair of result.repairs) {
    const sameBatch = result.repairs.filter((item) => item.batchId === repair.batchId)
    if (
      !["source_bug", "test_bug"].includes(repair.kind) ||
      ![1, 2].includes(repair.attempt) ||
      sameBatch.filter((item) => item.kind === repair.kind).length !== 1 ||
      sameBatch.filter((item) => item.attempt === repair.attempt).length !== 1
    )
      throw Error("AUTOBIZ_CODE_REPAIR_BUDGET_INVALID")
    const failed = original(repair.failedExecutionId, true)
    const attested = original(repair.attestationExecutionId)
    const rerun = original(repair.rerunExecutionId, true)
    const expectedFailedStep = repair.batchId + (repair.attempt === 1 ? "-test" : "-test-rerun-1")
    if (
      failed.status !== "failed" ||
      failed.output?.passed !== false ||
      failed.output.phase !== "test" ||
      !Number.isInteger(failed.output.exitCode) ||
      failed.output.exitCode === 0 ||
      failed.output.logTruncated ||
      failed.stepId !== expectedFailedStep ||
      attested.provider.actionId !== "repair-evidence" ||
      attested.output.failedExecutionId !== failed.executionId ||
      attested.output.headCommit !== failed.output.headCommit ||
      attested.output.workspaceRef !== failed.output.workspaceRef ||
      rerun.output?.workspaceRef !== failed.output.workspaceRef ||
      rerun.stepId !== repair.batchId + "-test-rerun-" + repair.attempt ||
      JSON.stringify(rerun.output?.argv) !== JSON.stringify(failed.output.argv) ||
      JSON.stringify(rerun.output?.taskIds) !== JSON.stringify(failed.output.taskIds) ||
      !Array.isArray(attested.output.attestations) ||
      JSON.stringify(attested.output.attestations.map((item) => item.taskId).sort()) !==
        JSON.stringify([...failed.output.taskIds].sort())
    )
      throw Error("AUTOBIZ_CODE_REPAIR_CHAIN_INVALID")
    allowedFailures.add(failed.executionId)
  }
  for (const id of result.executionIds) original(id, allowedFailures.has(id))
  const root = JSON.parse(currentPlan.files["plan.json"])
  if (!Array.isArray(result.batches) || result.batches.length !== root.batches.length)
    throw Error("AUTOBIZ_CODE_BATCH_COVERAGE_INVALID")
  for (const batch of root.batches) {
    const completed = result.batches.find((item) => item.id === batch.id)
    const tests = actions.filter((action) => action.executionId === completed?.testExecutionId)
    if (
      !completed ||
      completed.review !== "pass" ||
      completed.workspaceRef !== batch.workspaceRef ||
      tests[0]?.output?.workspaceRef !== batch.workspaceRef ||
      tests.length !== 1 ||
      tests[0].status !== "succeeded" ||
      tests[0].output.passed !== true ||
      tests[0].output.phase !== "test" ||
      tests[0].output.headCommit !== completed.headCommit ||
      JSON.stringify([...tests[0].output.taskIds].sort()) !==
        JSON.stringify([...batch.taskIds].sort())
    )
      throw Error("AUTOBIZ_CODE_BATCH_TEST_EVIDENCE_INVALID")
  }
  const workspaceRefs = [...new Set(root.batches.map((batch) => batch.workspaceRef))]
  if (
    !Array.isArray(result.repositories) ||
    result.repositories.length !== workspaceRefs.length ||
    new Set(result.repositories.map((item) => item.workspaceRef)).size !== workspaceRefs.length ||
    run.worktreeCount !== workspaceRefs.length ||
    run.worktrees.length !== workspaceRefs.length
  )
    throw Error("AUTOBIZ_CODE_REPOSITORY_COVERAGE_INVALID")
  for (const workspaceRef of workspaceRefs) {
    const repository = result.repositories.find((item) => item.workspaceRef === workspaceRef)
    if (!repository) throw Error("AUTOBIZ_CODE_REPOSITORY_MISSING")
    const matching = run.worktrees.filter((item) => item.resource?.id === repository.resourceId)
    if (matching.length !== 1) throw Error("AUTOBIZ_CODE_RESOURCE_EVIDENCE_INVALID")
    const resource = matching[0]
    if (
      resource.status !== "merged" ||
      resource.dirty ||
      resource.resource?.state !== "sealed" ||
      resource.resource.budgetsTruncated !== false ||
      (resource.resource.workspaceRef ?? "default") !== workspaceRef ||
      resource.resource.generation !== repository.generation ||
      resource.resource.sealedCommit !== repository.candidateCommit ||
      resource.headCommit !== repository.candidateCommit ||
      resource.integrationCommit !== repository.integrationCommit
    )
      throw Error("AUTOBIZ_CODE_RESOURCE_EVIDENCE_INVALID")
    const repositoryBatches = root.batches.filter((batch) => batch.workspaceRef === workspaceRef)
    if (
      !Array.isArray(resource.resource.budgets) ||
      resource.resource.budgets.length !== repositoryBatches.length
    )
      throw Error("AUTOBIZ_CODE_UT_BUDGET_COVERAGE_INVALID")
    for (const batch of repositoryBatches)
      checkUtBudget(
        resource.resource.budgets,
        batch,
        result.batches.find((item) => item.id === batch.id),
        actions,
        resource.resource.generation
      )
    const prefix = workspaceRef === "default" ? "final" : workspaceRef + "-final"
    const e2e = original(repository.e2eExecutionId)
    const compile = actions.filter((item) => item.stepId === prefix + "-compile")
    if (compile.length !== 1) throw Error("AUTOBIZ_CODE_FINAL_COMPILE_MISSING")
    const repositoryTaskIds = root.batches
      .filter((batch) => batch.workspaceRef === workspaceRef)
      .flatMap((batch) => batch.taskIds)
      .sort()
    for (const [record, phase] of [
      [e2e, "e2e"],
      [original(compile[0].executionId), "compile"]
    ]) {
      const verification = record.verificationResource
      if (
        record.stepId !== prefix + "-" + phase ||
        record.output.phase !== phase ||
        record.output.workspaceRef !== workspaceRef ||
        record.output.headCommit !== repository.integrationCommit ||
        JSON.stringify([...record.output.taskIds].sort()) !== JSON.stringify(repositoryTaskIds) ||
        !verification ||
        verification.expectedCommit !== repository.integrationCommit ||
        verification.resourceId !== repository.resourceId ||
        verification.generation !== repository.generation ||
        (verification.workspaceRef ?? "default") !== workspaceRef
      )
        throw Error("AUTOBIZ_CODE_FINAL_REPOSITORY_EVIDENCE_INVALID")
    }
  }
  return {
    passed: true,
    errors: [],
    warnings: [],
    runId: selection.runId,
    repositories: result.repositories,
    executionIds: result.executionIds
  }
}
