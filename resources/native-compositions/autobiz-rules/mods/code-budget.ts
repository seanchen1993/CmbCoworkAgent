/** Accept only the original resource's durable budget and actual command-start facts. */
export function checkUtBudget(budgets, batch, completed, actions, generation) {
  const reject = () => {
    throw Error("AUTOBIZ_CODE_UT_DEADLINE_EVIDENCE_INVALID")
  }
  const budgetId = batch.id + "-utest"
  if (!Array.isArray(budgets) || completed.budgetId !== budgetId) reject()
  const matches = budgets.filter((budget) => budget.budgetId === budgetId)
  if (matches.length !== 1) reject()
  const budget = matches[0]
  const time = (value) => Number.isSafeInteger(value) && value > 0
  if (
    budget.status !== "succeeded" ||
    budget.generation !== generation ||
    budget.policy?.firstExecutionMs !== 1800000 ||
    budget.policy?.totalMs !== 2700000 ||
    budget.policy?.commandMs !== 300000 ||
    ![
      budget.startedAt,
      budget.firstDeadlineAt,
      budget.deadlineAt,
      budget.firstCommandAt,
      budget.settledAt
    ].every(time) ||
    budget.firstDeadlineAt !== budget.startedAt + 1800000 ||
    budget.deadlineAt !== budget.startedAt + 2700000 ||
    budget.firstCommandAt < budget.startedAt ||
    budget.firstCommandAt > budget.firstDeadlineAt ||
    budget.settledAt < budget.firstCommandAt ||
    budget.settledAt > budget.deadlineAt ||
    budget.executionId !== completed.testExecutionId ||
    !Array.isArray(budget.commands) ||
    budget.commands.length < 1 ||
    budget.commands.length > 3
  )
    reject()
  const expectedSteps = [batch.id + "-test", batch.id + "-test-rerun-1", batch.id + "-test-rerun-2"]
  const tests = actions.filter((action) => expectedSteps.includes(action.stepId))
  if (tests.length !== budget.commands.length) reject()
  const ids = new Set()
  for (const command of budget.commands) {
    const original = tests.filter((action) => action.executionId === command.executionId)
    if (original.length !== 1 || ids.has(command.commandId)) reject()
    ids.add(command.commandId)
    const receipt = original[0]
    if (
      command.status !== "finished" ||
      command.commandId !== receipt.stepId ||
      ![command.intentAt, command.startedAt, command.finishedAt].every(time) ||
      command.intentAt < budget.startedAt ||
      command.startedAt < command.intentAt ||
      command.finishedAt < command.startedAt ||
      command.finishedAt > budget.settledAt ||
      command.finishedAt - command.startedAt > budget.policy.commandMs ||
      command.exitCode !== receipt.output?.exitCode ||
      receipt.output?.phase !== "test" ||
      receipt.output?.workspaceRef !== batch.workspaceRef ||
      !["succeeded", "failed"].includes(receipt.status) ||
      JSON.stringify(command.argv) !== JSON.stringify(receipt.output?.argv)
    )
      reject()
  }
  if (budget.firstCommandAt !== Math.min(...budget.commands.map((command) => command.startedAt)))
    reject()
}
