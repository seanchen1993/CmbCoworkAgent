import type { SDK } from "devclaw-mods"
import { assertPythonTestCompilation, workflowReceiptOrder } from "./python-evidence"
import { validCounts } from "./test-adapter"
import { selectCodeEvidenceOwner, readCodeEvidence } from "./code-evidence-reader"
import { readCodeWorktrees } from "./code-worktrees"
import { checkUtBudget } from "./code-budget"

/** Verify original platform/workflow receipts. The artifact only selects an existing run. */
export async function checkCodeResult($: Pick<SDK, "process" | "platform">, envelope: any, inputs: any) {
  const adapter = inputs.executionAdapter
  if (adapter !== "python-doctest/v1") throw Error("LEAN_EXECUTION_ADAPTER_CHANGED")
  const selection = envelope.input
  const expected = envelope.config?.nativeCompositionProvider
  const expectedRules = envelope.config?.rulesProvider
  const workflowSha256 = envelope.config?.workflowSha256
  const validIdentity = (value: any) => value && typeof value.pluginId === "string" &&
    value.pluginId.length > 0 && typeof value.plugin === "string" && value.plugin.length > 0 &&
    /^[a-f0-9]{64}$/.test(value.digest) && typeof value.actionId === "string"
  if (
    !selection ||
    typeof selection.feature !== "string" ||
    typeof selection.runId !== "string" ||
    !validIdentity(expected) ||
    !validIdentity(expectedRules) || expectedRules.actionId !== "solution.inspect" ||
    !/^[a-f0-9]{64}$/.test(workflowSha256) ||
    !["code.verify", "delivery.verify"].includes(expected.actionId)
  )
    throw Error("AUTOBIZ_CODE_EVIDENCE_BINDING_REQUIRED")
  const owner = await selectCodeEvidenceOwner($)
  let offset = 0
  let run: any
  const actions: any[] = []
  while (offset <= 128) {
    const receipt = await readCodeEvidence($, owner,
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
      current.scriptSha256 !== workflowSha256 ||
      current.resultTruncated ||
      !Number.isInteger(current.worktreeCount) ||
      current.worktreeCount < 1 ||
      current.worktreeCount > 8 ||
      !Array.isArray(current.worktrees)
    )
      throw Error("AUTOBIZ_CODE_ORIGINAL_RUN_UNVERIFIED")
    if (run && (JSON.stringify(run.result) !== JSON.stringify(current.result) || run.scriptSha256 !== current.scriptSha256 || run.actionCount !== current.actionCount || run.worktreeCount !== current.worktreeCount))
      throw Error("AUTOBIZ_CODE_ORIGINAL_RESULT_CHANGED")
    run = current
    actions.push(...current.deterministicActions)
    const next = current.nextActionOffset
    if (next === null) break
    if (!Number.isInteger(next) || next <= offset || next > 128)
      throw Error("AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE")
    offset = next
  }
  run.worktrees = await readCodeWorktrees($, envelope, run, owner)
  const result = run.result
  if (result?.executionAdapter !== adapter) throw Error("LEAN_EXECUTION_ADAPTER_CHANGED")
  const solution = inputs.documents["Solution.json"]
  const definition = inputs.documents["Definition.json"]
  if (result?.protocol !== "autobiz.lean-code-result/v1" || result.feature !== selection.feature ||
      definition.feature !== selection.feature || solution.feature !== selection.feature ||
      result.status !== "succeeded" ||
      !["RequestBaseline.json", "Definition.json", "Solution.json"].every((name: any) =>
        result.inputDigests?.[inputs.paths[name]] === inputs.inputDigests[inputs.paths[name]]))
    throw Error("LEAN_CODE_INPUT_CHANGED")
  if (
    !Array.isArray(result.executionIds) ||
    new Set(result.executionIds).size !== result.executionIds.length ||
    actions.length !== result.executionIds.length ||
    actions.length !== run.actionCount ||
    new Set(actions.map((item: any) => item.executionId)).size !== actions.length ||
    actions.some((item: any) => !result.executionIds.includes(item.executionId))
  )
    throw Error("AUTOBIZ_CODE_ACTION_EVIDENCE_INCOMPLETE")
  const actionOrder = workflowReceiptOrder(actions, result.executionIds)
  if (actions.filter((item: any) => item.stepId === "solution-check").length !== 1)
    throw Error("AUTOBIZ_CODE_RULES_RECEIPT_REQUIRED")
  const original = (executionId: any, allowFailure = false) => {
    const matches = actions.filter((action: any) => action.executionId === executionId)
    if (matches.length !== 1) throw Error("AUTOBIZ_CODE_ACTION_ID_INVALID")
    const action = matches[0]
    if (
      (!allowFailure && action.status !== "succeeded") ||
      action.outputTruncated ||
      (!allowFailure && action.output?.passed !== true) ||
      (action.stepId === "solution-check" ? (
        !["pluginId", "plugin", "digest", "actionId"].every((key: any) => action.provider[key] === expectedRules[key]) ||
        !["RequestBaseline.json", "Definition.json", "Solution.json"].every((name: any) =>
          action.output?.inputDigests?.[inputs.paths[name]] === inputs.inputDigests[inputs.paths[name]])
      ) : (
        action.provider.pluginId !== expected.pluginId ||
        action.provider.plugin !== expected.plugin || action.provider.digest !== expected.digest ||
        !["execute-command", "inspect-workspace", "repair-evidence", "test.contract", "prepare-test"].includes(action.provider.actionId)
      ))
    )
      throw Error("AUTOBIZ_CODE_ACTION_IDENTITY_OR_RESULT_INVALID")
    if (["execute-command", "test.contract", "prepare-test"].includes(action.provider.actionId) &&
        action.output?.executionAdapter !== adapter) throw Error("LEAN_EXECUTION_ADAPTER_CHANGED")
    if (
      action.provider.actionId === "execute-command" &&
      (action.output?.performance?.passed !== true ||
        !Array.isArray(action.output.performance.files) ||
        !Array.isArray(action.output.performance.errors) ||
        action.output.performance.errors.length !== 0)
    )
      throw Error("AUTOBIZ_CODE_PERFORMANCE_EVIDENCE_REQUIRED")
    if (action.provider.actionId === "execute-command" && action.output?.phase === "compile" &&
        adapter === "python-doctest/v1") {
      const compiled = action.output.compilation
      if (compiled?.protocol !== "autobiz.production-compile/v1" || compiled.mode !== "python-pycompile" ||
          compiled.passed !== true || !Array.isArray(compiled.files) || !compiled.files.length ||
          compiled.files.some((path: any) => !/^src\/[a-zA-Z0-9_./-]+\.py$/.test(path)) || compiled.files.length > 64 ||
          new Set(compiled.files).size !== compiled.files.length ||
          !/^[a-f0-9]{64}$/.test(compiled.sourceFingerprint) ||
          action.output.productionFiles.some((path: any) => /\.py$/.test(path) && !compiled.files.includes(path)))
        throw Error("LEAN_PRODUCTION_COMPILE_COVERAGE_REQUIRED")
    }
    return action
  }
  if (!Array.isArray(result.repairs)) throw Error("AUTOBIZ_CODE_REPAIR_EVIDENCE_REQUIRED")
  const allowedFailures = new Set()
  for (const repair of result.repairs) {
    const sameBatch = result.repairs.filter((item: any) => item.batchId === repair.batchId)
    if (
      repair.kind !== "source_bug" ||
      ![1, 2].includes(repair.attempt) ||
      sameBatch.filter((item: any) => item.kind === repair.kind).length !== 1 ||
      sameBatch.filter((item: any) => item.attempt === repair.attempt).length !== 1
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
      JSON.stringify(attested.output.attestations.map((item: any) => item.taskId).sort()) !==
        JSON.stringify([...failed.output.taskIds].sort())
    )
      throw Error("AUTOBIZ_CODE_REPAIR_CHAIN_INVALID")
    allowedFailures.add(failed.executionId)
  }
  for (const id of result.executionIds) original(id, allowedFailures.has(id))
  const root = solution.plan
  if (!Array.isArray(result.batches) || result.batches.length !== root.batches.length)
    throw Error("AUTOBIZ_CODE_BATCH_COVERAGE_INVALID")
  for (const batch of root.batches) {
    const completed = result.batches.find((item: any) => item.id === batch.id)
    const tests = actions.filter((action: any) => action.executionId === completed?.testExecutionId)
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
  const workspaceRefs = [...new Set(root.batches.map((batch: any) => batch.workspaceRef))]
  if (
    !Array.isArray(result.repositories) ||
    result.repositories.length !== workspaceRefs.length ||
    new Set(result.repositories.map((item: any) => item.workspaceRef)).size !== workspaceRefs.length ||
    run.worktreeCount !== workspaceRefs.length ||
    run.worktrees.length !== workspaceRefs.length
  )
    throw Error("AUTOBIZ_CODE_REPOSITORY_COVERAGE_INVALID")
  for (const workspaceRef of workspaceRefs) {
    const repository = result.repositories.find((item: any) => item.workspaceRef === workspaceRef)
    if (!repository) throw Error("AUTOBIZ_CODE_REPOSITORY_MISSING")
    const matching = run.worktrees.filter((item: any) => item.resource?.id === repository.resourceId)
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
    const repositoryBatches = root.batches.filter((batch: any) => batch.workspaceRef === workspaceRef)
    if (
      !Array.isArray(resource.resource.budgets) ||
      resource.resource.budgets.length !== repositoryBatches.length
    )
      throw Error("AUTOBIZ_CODE_UT_BUDGET_COVERAGE_INVALID")
    for (const batch of repositoryBatches)
      checkUtBudget(
        resource.resource.budgets,
        batch,
        result.batches.find((item: any) => item.id === batch.id),
        actions,
        resource.resource.generation
      )
    const prefix = workspaceRef === "default" ? "final" : workspaceRef + "-final"
    const e2e = original(repository.e2eExecutionId)
    const compile = actions.filter((item: any) => item.stepId === prefix + "-compile")
    if (compile.length !== 1) throw Error("AUTOBIZ_CODE_FINAL_COMPILE_MISSING")
    const repositoryTaskIds = root.batches
      .filter((batch: any) => batch.workspaceRef === workspaceRef)
      .flatMap((batch: any) => batch.taskIds)
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
  // Passing exit codes alone are never proof that any behavioral test ran.
  for (const record of actions.filter((item: any) => item.provider.actionId === "execute-command" &&
      ["test", "e2e"].includes(item.output?.phase) && item.status === "succeeded")) {
    const test = record.output.test
    if (test?.protocol !== "autobiz.test-execution/v1" || test.runner !== adapter ||
        adapter === "python-doctest/v1" && test.completed !== true || !validCounts(test.counts) ||
        ![test.testsFingerprint, test.subjectFingerprint].every((hash: any) => /^[a-f0-9]{64}$/.test(hash)) ||
        !Array.isArray(test.files) || !test.files.length || !Array.isArray(test.subjects) || !test.subjects.length)
      throw Error("LEAN_TEST_STATISTICS_REQUIRED")
    if (adapter === "python-doctest/v1") assertPythonTestCompilation(actionOrder, record)
    const required = actions.filter((item: any) => item.provider.actionId === "execute-command" &&
      item.output?.phase === "compile" && item.output.workspaceRef === record.output.workspaceRef &&
      (record.output.phase === "e2e" || item.output.taskIds.some((id: any) => record.output.taskIds.includes(id))))
      .flatMap((item: any) => item.output.productionFiles ?? [])
    if (!required.length || required.some((path: any) => !test.subjects.includes(path)))
      throw Error("LEAN_TEST_SUBJECT_COVERAGE_REQUIRED")
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
