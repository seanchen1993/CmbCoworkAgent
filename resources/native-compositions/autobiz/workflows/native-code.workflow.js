export const meta = {
  name: "autobiz-native-code",
  description:
    "由原生工作流管理已授权多仓批次DAG、每仓复用工作树、真实编译/测试、人工合并确认和最终E2E",
  phases: [
    { title: "计划检查", detail: "读取实际Host产物并执行固定业务规则" },
    { title: "实现", detail: "依赖就绪批次按顺序实现并运行生产编译" },
    { title: "评审", detail: "独立评审；最多一次定向修复后重新编译评审" },
    { title: "测试", detail: "独立生成测试并执行实际命令" },
    { title: "合并确认", detail: "封存实际SHA并由原生审批控制合并" },
    { title: "最终验证", detail: "合并后只运行一次最终E2E，返回原始回执引用" }
  ]
}

const input = args
if (!input || !input.rulesProvider || input.rulesProvider.plugin !== "autobiz-native-rules")
  throw Error("AUTOBIZ_RULE_PROVIDER_REQUIRED")
const provider = (actionId) => ({ ...input.rulesProvider, actionId })
const plan = JSON.parse(await readFile("PLAN.bundle.json"))
const design = JSON.parse(await readFile("DESIGN.bundle.json"))
const specs = JSON.parse(await readFile("SPECS.bundle.json"))
const prd = JSON.parse(await readFile("PRD.bundle.json"))
if (JSON.parse(prd.files["IMPLEMENTATION_SCOPE.json"]).implementationScope !== "backend_only")
  throw Error("AUTOBIZ_NATIVE_CODE_SUPPORTS_BACKEND_ONLY")
if (plan.stage !== "plan" || plan.feature !== design.feature || plan.feature !== specs.feature)
  throw Error("AUTOBIZ_CODE_INPUT_MISMATCH")
const checked = await action({ stepId: "plan-check", provider: provider("plan"), input: plan })
if (checked.status !== "succeeded" || checked.output?.passed !== true)
  throw Error("AUTOBIZ_PLAN_REJECTED")
const root = JSON.parse(plan.files["plan.json"])
if (root.batches.length > 8) throw Error("AUTOBIZ_NATIVE_CODE_BATCH_LIMIT")
const batches = root.batches.map((entry) => ({ entry, plan: JSON.parse(plan.files[entry.path]) }))
if (
  batches.some((batch) =>
    batch.plan.tasks.some(
      (task) => task.workspaceRef !== batch.entry.workspaceRef || task.executionMode !== "code"
    )
  )
)
  throw Error("AUTOBIZ_NATIVE_CODE_REQUIRES_CONSISTENT_REPOSITORY_CODE_TASKS")
const tasks = batches.flatMap((batch) => batch.plan.tasks)
if (!tasks.length) throw Error("AUTOBIZ_CODE_TASKS_REQUIRED")
// Acquire every declared repository before any model writes; unknown or unbound refs fail closed.
const resources = new Map()
for (const workspaceRef of [...new Set(batches.map((batch) => batch.entry.workspaceRef))]) {
  const resourceId =
    workspaceRef === "default" ? "feature-integration" : "feature-integration-" + workspaceRef
  const resource = await worktree({
    op: "acquire",
    resourceId,
    ...(workspaceRef === "default" ? {} : { workspaceRef })
  })
  if (resource.state === "unknown") throw Error("AUTOBIZ_CODE_RESOURCE_RECONCILIATION_REQUIRED")
  resources.set(workspaceRef, {
    workspaceRef,
    resource,
    head: resource.baseCommit,
    finalCompileArgv: null
  })
}
const implementationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["compileArgv"],
  properties: {
    compileArgv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
  }
}
const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { enum: ["pass", "fail"] },
    findings: { type: "array", items: { type: "string", minLength: 1 } }
  }
}
const testSchema = {
  type: "object",
  additionalProperties: false,
  required: ["argv"],
  properties: {
    argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
  }
}
const implement = async (prompt, options) => {
  const result = await agent(prompt, {
    ...options,
    agentType: "autobiz-native-implementer",
    commitChanges: true
  })
  return { ...result.output, commitSha: result.commitSha }
}
const authorTests = async (prompt, options) => {
  const result = await agent(prompt, {
    ...options,
    agentType: "autobiz-native-test-author",
    commitChanges: true
  })
  return { ...result.output, commitSha: result.commitSha }
}
const receipts = [checked.executionId]
const repairs = []
const completed = []
const activeBudgets = new Map()
const runCommand = async (
  stepId,
  phase,
  command,
  taskIds,
  baselineCommit,
  handle,
  allowFailedTest = false,
  verificationResource
) => {
  const scope = [...resources.values()].find(
    (value) => value.resource.handle === (handle ?? verificationResource?.handle)
  )
  if (!scope) throw Error("AUTOBIZ_CODE_COMMAND_RESOURCE_REQUIRED")
  const deadlineBudgetId = activeBudgets.get(scope.workspaceRef)
  if (phase === "test") {
    if (!deadlineBudgetId || !handle) throw Error("AUTOBIZ_UT_BUDGET_REQUIRED")
    await worktree({
      op: "deadline-command",
      handle,
      budgetId: deadlineBudgetId,
      commandId: stepId,
      argv: command.argv
    })
  }
  const result = await action({
    stepId,
    ...(deadlineBudgetId ? { deadlineBudgetId } : {}),
    provider: provider("validate-command"),
    ...(handle ? { resourceHandle: handle } : { verificationResource }),
    input: {
      phase,
      baselineCommit,
      expectedCommit: command.commitSha,
      argv: command.argv,
      taskIds,
      workspaceRef: scope.workspaceRef
    }
  })
  receipts.push(result.executionId)
  if (
    allowFailedTest &&
    result.status === "failed" &&
    result.output?.passed === false &&
    result.output.phase === "test" &&
    Number.isInteger(result.output.exitCode) &&
    result.output.exitCode !== 0 &&
    !result.output.logTruncated &&
    result.output.headCommit === command.commitSha
  )
    return result
  if (result.status !== "succeeded" || result.output?.passed !== true)
    throw Error("AUTOBIZ_CODE_VALIDATION_FAILED:" + stepId)
  return result
}
for (let cycle = 0; completed.length < batches.length; cycle++) {
  if (cycle >= batches.length) throw Error("AUTOBIZ_CODE_DAG_UNRESOLVED")
  const next = batches.find(
    (batch) =>
      !completed.some((value) => value.id === batch.entry.id) &&
      (batch.entry.deps || []).every((id) => completed.some((value) => value.id === id))
  )
  if (!next) throw Error("AUTOBIZ_CODE_DAG_BLOCKED")
  const state = resources.get(next.entry.workspaceRef)
  const resource = state.resource
  let head = state.head
  const id = next.entry.id
  const taskIds = next.plan.tasks.map((task) => task.id)
  const context = JSON.stringify({ feature: plan.feature, batch: next.plan, specs, design })
  let implemented = await implement(
    "执行本批次生产实现，保留全部规格、设计、来源约束。只改本批业务生产代码；不得改计划/规格/检查器；不得运行测试或包构建；生产编译由显式动作执行。只写生产实现并返回只含生产compile目标的argv；由原生Git服务提交真实修改。不得伪造编译或测试成功。\n" +
      context,
    {
      resourceHandle: resource.handle,
      phase: "实现",
      label: id + "-implement",
      schema: implementationSchema
    }
  )
  await runCommand(
    id + "-compile",
    "compile",
    { commitSha: implemented.commitSha, argv: implemented.compileArgv },
    taskIds,
    head,
    resource.handle
  )
  let review = await agent(
    "只读评审生产提交、规格覆盖、边界/失败路径及设计契约。不得修改生产或测试、不得运行编译或测试。输出pass或具体阻断发现；不能因时间压力忽略阻断。\n" +
      context,
    {
      resourceHandle: resource.handle,
      phase: "评审",
      agentType: "autobiz-native-reviewer",
      label: id + "-review",
      schema: reviewSchema
    }
  )
  const verifyReview = async (stepId) => {
    const verified = await action({
      stepId,
      resourceHandle: resource.handle,
      provider: provider("inspect-workspace"),
      input: { expectedCommit: implemented.commitSha }
    })
    receipts.push(verified.executionId)
    if (verified.status !== "succeeded" || verified.output?.passed !== true)
      throw Error("AUTOBIZ_REVIEW_MODIFIED_WORKSPACE")
  }
  await verifyReview(id + "-review-boundary")
  if (review.verdict !== "pass") {
    const beforeRepair = implemented.commitSha
    implemented = await implement(
      "按以下独立评审作一次定向生产修复并返回生产编译argv；不执行Git，原生服务会提交修改。不得改变规格/验收或运行测试。\n" +
        JSON.stringify({ review, context }),
      {
        resourceHandle: resource.handle,
        phase: "实现",
        label: id + "-repair",
        schema: implementationSchema
      }
    )
    await runCommand(
      id + "-repair-compile",
      "compile",
      { commitSha: implemented.commitSha, argv: implemented.compileArgv },
      taskIds,
      beforeRepair,
      resource.handle
    )
    review = await agent(
      "只读重新评审原阻断和修复。不得修改文件或执行编译测试。\n" +
        JSON.stringify({ review, context }),
      {
        resourceHandle: resource.handle,
        phase: "评审",
        agentType: "autobiz-native-reviewer",
        label: id + "-re-review",
        schema: reviewSchema
      }
    )
    await verifyReview(id + "-re-review-boundary")
    if (review.verdict !== "pass") throw Error("AUTOBIZ_CODE_REVIEW_FAILED:" + id)
  }
  const budgetId = id + "-utest"
  await worktree({
    op: "deadline-begin",
    handle: resource.handle,
    budgetId,
    policy: { firstExecutionMs: 1800000, totalMs: 2700000, commandMs: 300000 }
  })
  activeBudgets.set(state.workspaceRef, budgetId)
  try {
    let test = await authorTests(
      "依据全部task testPoints、acceptanceCriteria、SCN创建独立行为测试；包含正常/边界/失败路径，禁止修改生产实现或验收条件。只写测试和必要测试配置，返回实际执行测试的argv；原生Git服务负责提交，测试将由显式动作运行。\n" +
        context,
      {
        resourceHandle: resource.handle,
        deadlineBudgetId: budgetId,
        phase: "测试",
        label: id + "-test-author",
        schema: testSchema
      }
    )
    let tested = await runCommand(
      id + "-test",
      "test",
      test,
      taskIds,
      implemented.commitSha,
      resource.handle,
      true
    )
    const usedRepairs = []
    // Original policy: at most one test_bug fix and one attested source_bug fix.
    // A third attempt is the final rerun, not permission for another production repair.
    for (let attempt = 1; tested.status === "failed" && attempt < 3; attempt++) {
      const attested = await action({
        stepId: id + "-repair-evidence-" + attempt,
        provider: provider("repair-evidence"),
        deadlineResource: { handle: resource.handle, budgetId },
        input: {
          runId: tested.parentRunId,
          executionId: tested.executionId,
          expectedCommit: test.commitSha,
          workspaceRef: state.workspaceRef,
          provider: input.rulesProvider
        }
      })
      receipts.push(attested.executionId)
      if (attested.status !== "succeeded" || attested.output?.passed !== true)
        throw Error("AUTOBIZ_UT_REPAIR_EVIDENCE_REJECTED")
      const diagnosis = await agent(
        "只读诊断真实失败UT与当前验收条件。source_bug只能指生产实现违反已确认规格；test_bug只能指测试资产错误。契约缺失、环境/依赖失败、超时、偶发或不确定不得分类为source_bug/test_bug；不得修改文件或执行命令。\n" +
          JSON.stringify({ context, failed: tested.output, attestation: attested.output }),
        {
          resourceHandle: resource.handle,
          deadlineBudgetId: budgetId,
          phase: "测试",
          agentType: "autobiz-native-reviewer",
          label: id + "-ut-diagnosis-" + attempt,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: {
              kind: {
                enum: ["source_bug", "test_bug", "contract_gap", "environment", "flaky", "unknown"]
              },
              reason: { type: "string", minLength: 1 }
            }
          }
        }
      )
      if (
        !["source_bug", "test_bug"].includes(diagnosis.kind) ||
        usedRepairs.includes(diagnosis.kind)
      )
        throw Error("AUTOBIZ_UT_REPAIR_DEFERRED:" + diagnosis.kind)
      usedRepairs.push(diagnosis.kind)
      const failed = tested
      const before = test.commitSha
      if (diagnosis.kind === "source_bug") {
        implemented = await implement(
          "一次受原始UT失败证据约束的生产修复。仅修复已确认规格违反，不改测试、验收、计划或检查器；不得运行测试。返回生产编译argv。\n" +
            JSON.stringify({
              context,
              diagnosis,
              failure: failed.output,
              attestation: attested.output
            }),
          {
            resourceHandle: resource.handle,
            deadlineBudgetId: budgetId,
            phase: "实现",
            label: id + "-source-repair",
            schema: implementationSchema
          }
        )
        await runCommand(
          id + "-source-repair-compile",
          "compile",
          { commitSha: implemented.commitSha, argv: implemented.compileArgv },
          taskIds,
          before,
          resource.handle
        )
        test = { ...test, commitSha: implemented.commitSha }
      } else {
        const repaired = await authorTests(
          "一次测试资产修复，禁止改变生产代码、验收或降低断言。须保留相同测试命令，修正实际测试错误后交原命令复跑。\n" +
            JSON.stringify({
              context,
              diagnosis,
              failure: failed.output,
              attestation: attested.output
            }),
          {
            resourceHandle: resource.handle,
            deadlineBudgetId: budgetId,
            phase: "测试",
            label: id + "-test-repair",
            schema: testSchema
          }
        )
        if (JSON.stringify(repaired.argv) !== JSON.stringify(test.argv))
          throw Error("AUTOBIZ_UT_REPAIR_COMMAND_CHANGED")
        test = repaired
      }
      tested = await runCommand(
        id + "-test-rerun-" + attempt,
        "test",
        test,
        taskIds,
        diagnosis.kind === "source_bug" ? test.commitSha : before,
        resource.handle,
        true
      )
      repairs.push({
        batchId: id,
        attempt,
        kind: diagnosis.kind,
        failedExecutionId: failed.executionId,
        attestationExecutionId: attested.executionId,
        rerunExecutionId: tested.executionId
      })
    }
    if (tested.status !== "succeeded") throw Error("AUTOBIZ_UT_REPAIR_BUDGET_EXHAUSTED")
    await worktree({
      op: "deadline-settle",
      handle: resource.handle,
      budgetId,
      outcome: "succeeded",
      executionId: tested.executionId
    })
    activeBudgets.delete(state.workspaceRef)
    state.finalCompileArgv = implemented.compileArgv
    state.head = head = test.commitSha
    completed.push({
      id,
      workspaceRef: state.workspaceRef,
      taskIds,
      headCommit: head,
      review: "pass",
      budgetId,
      testExecutionId: tested.executionId
    })
  } catch (error) {
    // Failure settlement preserves expired/unknown facts and never authorizes more work.
    await worktree({ op: "deadline-settle", handle: resource.handle, budgetId, outcome: "failed" })
    activeBudgets.delete(state.workspaceRef)
    throw error
  }
}
// Each repository is promoted independently. Cross-repository work is not an atomic Git transaction.
// Run one final E2E per repository on its actual approved source commit, after all batches settle.
const repositories = []
for (const state of resources.values()) {
  const { resource, workspaceRef } = state
  const repositoryTasks = tasks.filter((task) => task.workspaceRef === workspaceRef)
  const prefix = workspaceRef === "default" ? "final" : workspaceRef + "-final"
  const e2e = await authorTests(
    "依据本仓全部已确认SCN与批次交互创建最终E2E测试，由原生Git服务提交。不得修改生产代码或其他仓库；不得执行测试。返回实际E2E测试argv。\n" +
      JSON.stringify({ workspaceRef, tasks: repositoryTasks, specs, design }),
    {
      resourceHandle: resource.handle,
      phase: "测试",
      label: prefix + "-e2e-author",
      schema: testSchema
    }
  )
  const sealed = await worktree({
    op: "seal",
    handle: resource.handle,
    expectedCommit: e2e.commitSha
  })
  if (sealed.state !== "sealed" || sealed.sealedCommit !== e2e.commitSha || sealed.dirty)
    throw Error("AUTOBIZ_CODE_SEAL_UNCONFIRMED")
  const merged = await worktree({
    op: "merge",
    handle: sealed.handle,
    expectedCommit: e2e.commitSha
  })
  if (merged.status !== "merged" || !merged.integrationCommit)
    throw Error("AUTOBIZ_CODE_MERGE_NOT_APPROVED_OR_UNCONFIRMED")
  const verification = { handle: sealed.handle, expectedCommit: merged.integrationCommit }
  await runCommand(
    prefix + "-compile",
    "compile",
    { commitSha: merged.integrationCommit, argv: state.finalCompileArgv },
    repositoryTasks.map((task) => task.id),
    merged.integrationCommit,
    undefined,
    false,
    verification
  )
  const final = await runCommand(
    prefix + "-e2e",
    "e2e",
    { commitSha: merged.integrationCommit, argv: e2e.argv },
    repositoryTasks.map((task) => task.id),
    state.head,
    undefined,
    false,
    verification
  )
  repositories.push({
    workspaceRef,
    resourceId: merged.resourceId,
    generation: merged.generation,
    candidateCommit: e2e.commitSha,
    integrationCommit: merged.integrationCommit,
    e2eExecutionId: final.executionId
  })
}
return {
  protocol: "autobiz.native-code-result/v2",
  feature: plan.feature,
  status: "succeeded",
  planSha256: checked.output.inputSha256,
  provider: input.rulesProvider,
  batches: completed,
  repairs,
  repositories,
  executionIds: receipts
}
