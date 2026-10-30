export const meta = {
  name: "autobiz-lean-code",
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

// BEGIN PURE CONTEXT CONTRACT: exercised independently and by the real workflow engine.
function buildBatchContext(definition, solution, batchId, sources, executionContract) {
  const entries = solution.plan?.batches
  if (!Array.isArray(entries) || !entries.length || entries.length > 8 ||
      new Set(entries.map((row) => row.id)).size !== entries.length)
    throw Error("LEAN_BATCH_DEPENDENCY_INVALID")
  const visited = new Set(), visiting = new Set(), closure = []
  const visit = (id) => {
    if (visiting.has(id)) throw Error("LEAN_BATCH_DEPENDENCY_CYCLE")
    if (visited.has(id)) return
    const entry = entries.find((row) => row.id === id), batch = solution.batches[id]
    if (!entry || !batch || !Array.isArray(batch.tasks) || !batch.tasks.length ||
        !Array.isArray(entry.deps ?? [])) throw Error("LEAN_BATCH_DEPENDENCY_MISSING:" + id)
    visiting.add(id)
    for (const parent of entry.deps ?? []) visit(parent)
    visiting.delete(id)
    visited.add(id)
    closure.push({ id, batch })
  }
  const requested = Array.isArray(batchId) ? batchId : [batchId]
  if (!requested.length || requested.length > 8 ||
      requested.some((id) => typeof id !== "string") || new Set(requested).size !== requested.length)
    throw Error("LEAN_BATCH_SELECTION_INVALID")
  for (const id of requested) visit(id)
  const refs = closure.flatMap((row) => row.batch.tasks.flatMap((task) => task.specRefs ?? []))
  const selectedSpecs = {}
  for (const ref of refs) {
    const match = /^specs\/([a-z0-9-]+)\/spec\.md(?:#((?:REQ|SCN)-\d{3}))?$/.exec(ref)
    if (!match || typeof definition.specs?.[match[1]] !== "string")
      throw Error("LEAN_BATCH_SPEC_REF_INVALID:" + ref)
    const text = definition.specs[match[1]]
    if (match[2] && !new RegExp("^#{1,6}[^\\n]*\\b" + match[2] + "\\b", "m").test(text))
      throw Error("LEAN_BATCH_SPEC_REF_UNDEFINED:" + ref)
    selectedSpecs[match[1]] = text
  }
  if (!Object.keys(selectedSpecs).length) throw Error("LEAN_BATCH_SPEC_REQUIRED")
  const proposal = definition.proposal
  if (typeof proposal !== "string") throw Error("LEAN_PROPOSAL_REQUIRED")
  const decisions = {}, sections = []
  const headings = [...proposal.matchAll(/^(#{1,6})[ \t]+([^\n]+)$/gm)]
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index], ids = heading[2].match(/\bDEC-\d{3}\b/g) ?? []
    if (!ids.length) continue
    if (ids.length !== 1 || decisions[ids[0]]) throw Error("LEAN_DECISION_DUPLICATE")
    const end = headings.slice(index + 1).find((next) => next[1].length <= heading[1].length)?.index ?? proposal.length
    const text = proposal.slice(heading.index, end)
    decisions[ids[0]] = text
    sections.push({ start: heading.index, end })
  }
  // Keep non-decision proposal prose: it may contain global scope or source constraints.
  let globalProposal = proposal
  const orderedSections = [...sections].sort((a, b) => a.start - b.start)
  if (orderedSections.some((section, index) => index > 0 && section.start < orderedSections[index - 1].end))
    throw Error("LEAN_DECISION_SECTIONS_OVERLAP")
  for (const section of sections.sort((a, b) => b.start - a.start))
    globalProposal = globalProposal.slice(0, section.start) + globalProposal.slice(section.end)
  const used = new Set((JSON.stringify({ closure, specs: selectedSpecs,
    design: solution.design, globalProposal }).match(/\bDEC-\d{3}\b/g) ?? []))
  for (const id of used) {
    if (!decisions[id]) throw Error("LEAN_DECISION_UNDEFINED:" + id)
    for (const dependency of decisions[id].match(/\bDEC-\d{3}\b/g) ?? []) used.add(dependency)
  }
  const value = {
    feature: definition.feature,
    ...(Array.isArray(batchId)
      ? { batches: requested.map((id) => ({ id, ...solution.batches[id] })) }
      : { batch: solution.batches[batchId] }),
    dependencyBatchIds: closure.map((row) => row.id).filter((id) => !requested.includes(id)),
    requirements: definition.requirements,
    requirementCoverage: definition.requirementCoverage,
    baselineDecisions: definition.baselineDecisions,
    decisionCoverage: definition.decisionCoverage,
    scope: definition.scope,
    ui: definition.ui,
    specs: selectedSpecs,
    proposal: globalProposal,
    decisions: Object.fromEntries([...used].map((id) => [id, decisions[id]])),
    sourceContext: definition.sourceContext ?? null,
    sourceTexts: definition.sourceTexts ?? {},
    design: { design: solution.design, designLock: solution.designLock },
    provenance: sources,
    executionContract
  }
  // Bound the UTF-8 material, never silently cut a required dependency.
  let bytes = 0
  for (const char of JSON.stringify(value)) {
    const point = char.codePointAt(0)
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
  }
  if (bytes > 192 * 1024) throw Error("LEAN_BATCH_CONTEXT_LIMIT")
  return value
}

function failedTestReviewMessage(batchId, executionId) {
  return JSON.stringify({ batchId, executionId,
    next: "保留原失败运行和回执；审查测试变更与原验收要求后创建新运行。不得将旧失败改为成功或重放未知副作用。" })
}
// END PURE CONTEXT CONTRACT

const input = args
if (!input?.rulesProvider || !input?.deliveryProvider) throw Error("LEAN_PROVIDER_BINDING_REQUIRED")
if (typeof input.executionAdapter !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/.test(input.executionAdapter)) throw Error("LEAN_EXECUTION_ADAPTER_REQUIRED")
const provider = (actionId) => ({ ...input.deliveryProvider, actionId })
const artifactPaths = input.artifactPaths ?? {
  baseline: "RequestBaseline.json", definition: "Definition.json", solution: "Solution.json"
}
if (!artifactPaths || Object.keys(artifactPaths).sort().join("|") !== "baseline|definition|solution" ||
    Object.values(artifactPaths).some((path) => typeof path !== "string" || path.length > 256 ||
      !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) ||
    new Set(Object.values(artifactPaths)).size !== 3) throw Error("LEAN_ARTIFACT_PATHS_INVALID")
const artifactTexts = Object.fromEntries(await Promise.all(Object.entries(artifactPaths)
  .map(async ([role, path]) => [role, await readFile(path)])))
const definition = JSON.parse(artifactTexts.definition)
const solution = JSON.parse(artifactTexts.solution)
const plan = { feature: solution.feature }
if (definition.scope.implementationScope !== "backend_only")
  throw Error("AUTOBIZ_NATIVE_CODE_SUPPORTS_BACKEND_ONLY")
if (definition.feature !== solution.feature) throw Error("LEAN_INPUT_MISMATCH")
const checked = await action({ stepId: "solution-check",
  provider: { ...input.rulesProvider, actionId: "solution.inspect" }, input: { artifactPaths } })
if (checked.status !== "succeeded" || checked.output?.passed !== true)
  throw Error("LEAN_SOLUTION_REJECTED")
for (const [role, path] of Object.entries(artifactPaths))
  if (await readFile(path) !== artifactTexts[role]) throw Error("LEAN_INPUT_CHANGED_DURING_PREPARATION")
const contract = await action({ stepId: "test-contract", provider: provider("test.contract"), input: { executionAdapter: input.executionAdapter } })
if (contract.status !== "succeeded" || contract.output?.protocol !== "devclaw.execution-evidence/v1" ||
    !contract.output?.inputSchema || !contract.output?.compileInputSchema ||
    !Array.isArray(contract.output?.actions) ||
    !["prepare-test", "execute-command", "inspect-workspace", "repair-evidence"].every(
      (id) => contract.output.actions.includes(id))) throw Error("LEAN_TEST_CONTRACT_REQUIRED")
if (contract.output.executionAdapter !== input.executionAdapter) throw Error("LEAN_EXECUTION_ADAPTER_CHANGED")
const root = solution.plan
if (root.batches.length > 8) throw Error("AUTOBIZ_NATIVE_CODE_BATCH_LIMIT")
const batches = root.batches.map((entry) => ({ entry, plan: solution.batches[entry.id] }))
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
const implementationSchema = contract.output.compileInputSchema
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
  type: "object", additionalProperties: false, required: ["testInput"],
  properties: { testInput: contract.output.inputSchema }
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
  const prepared = await action({ stepId: options.label + "-prepare",
    resourceHandle: options.resourceHandle,
    ...(options.deadlineBudgetId ? { deadlineBudgetId: options.deadlineBudgetId } : {}),
    provider: provider("prepare-test"), input: { executionAdapter: input.executionAdapter, testInput: result.output.testInput } })
  receipts.push(prepared.executionId)
  if (prepared.status !== "succeeded" || prepared.output?.passed !== true ||
      !Array.isArray(prepared.output.argv)) throw Error("LEAN_TEST_PREPARATION_FAILED")
  return { argv: prepared.output.argv, commitSha: result.commitSha }
}
const receipts = [checked.executionId, contract.executionId]
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
    provider: provider("execute-command"),
    ...(handle ? { resourceHandle: handle } : { verificationResource }),
    input: {
      phase,
      executionAdapter: input.executionAdapter,
      baselineCommit,
      expectedCommit: command.commitSha,
      argv: command.argv,
      taskIds,
      workspaceRef: scope.workspaceRef,
      declaredProductionPaths: tasks.filter((task) => taskIds.includes(task.id))
        .flatMap((task) => task.expectedFiles ?? []),
      protectedArtifactPaths: Object.values(artifactPaths)
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
  const context = JSON.stringify(buildBatchContext(definition, solution, id,
    { paths: artifactPaths, digests: checked.output.inputDigests }, contract.output))
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
      "依据全部task testPoints、acceptanceCriteria、SCN创建独立行为测试；包含正常/边界/失败路径，禁止修改生产实现或验收条件。只写测试和必要测试配置，按公开适配器契约返回testInput；适配器说明：" + JSON.stringify(contract.output) + "。；原生Git服务负责提交，测试将由显式动作运行。\n" +
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
    // Only an attested source repair may run automatically. Test changes require a new review/run.
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
          provider: input.deliveryProvider,
          artifactPaths
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
      if (diagnosis.kind === "test_bug")
        throw Error("LEAN_TEST_CHANGE_REVIEW_REQUIRED:" + failedTestReviewMessage(id, tested.executionId))
      if (
        diagnosis.kind !== "source_bug" ||
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
    "依据本仓全部已确认SCN、需求决定与批次交互创建最终E2E测试，由原生Git服务提交。不得修改生产代码或其他仓库；不得执行测试。按公开适配器契约返回testInput。\n" +
      JSON.stringify({ workspaceRef, tasks: repositoryTasks,
        ...buildBatchContext(definition, solution,
          batches.filter((batch) => batch.entry.workspaceRef === workspaceRef).map((batch) => batch.entry.id),
          { paths: artifactPaths, digests: checked.output.inputDigests }, contract.output) }),
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
  protocol: "autobiz.lean-code-result/v1",
  feature: plan.feature,
  status: "succeeded",
  executionAdapter: input.executionAdapter,
  inputDigests: checked.output.inputDigests,
  rulesProvider: input.rulesProvider,
  provider: input.deliveryProvider,
  batches: completed,
  repairs,
  repositories,
  executionIds: receipts
}
