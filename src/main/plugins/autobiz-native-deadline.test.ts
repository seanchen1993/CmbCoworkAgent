import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { transformSync } from "esbuild"
import { expect, it } from "vitest"

function fixture() {
  const startedAt = 1000000
  const argv = ["python", "-m", "unittest", "test_orders.py"]
  const command = {
    commandId: "B001-test",
    argv,
    executionId: "original-test-action",
    intentAt: startedAt + 1,
    startedAt: startedAt + 2,
    finishedAt: startedAt + 10,
    exitCode: 0,
    status: "finished"
  }
  return {
    budgets: [
      {
        budgetId: "B001-utest",
        generation: 1,
        policy: { firstExecutionMs: 1800000, totalMs: 2700000, commandMs: 300000 },
        startedAt,
        firstDeadlineAt: startedAt + 1800000,
        deadlineAt: startedAt + 2700000,
        firstCommandAt: command.startedAt,
        settledAt: command.finishedAt + 1,
        status: "succeeded",
        executionId: command.executionId,
        commands: [command]
      }
    ],
    batch: { id: "B001", workspaceRef: "default" },
    completed: { budgetId: "B001-utest", testExecutionId: command.executionId },
    actions: [
      {
        executionId: command.executionId,
        stepId: command.commandId,
        status: "succeeded",
        output: { phase: "test", workspaceRef: "default", exitCode: 0, argv }
      }
    ]
  }
}
type Fixture = ReturnType<typeof fixture>
const module = {
  exports: {} as {
    checkUtBudget: (
      budgets: Fixture["budgets"],
      batch: Fixture["batch"],
      completed: Fixture["completed"],
      actions: Fixture["actions"],
      generation: number
    ) => void
  }
}
runInNewContext(
  transformSync(
    readFileSync(
      resolve("resources/native-compositions/autobiz-rules/mods/code-budget.ts"),
      "utf8"
    ),
    { loader: "ts", format: "cjs" }
  ).code,
  { module, exports: module.exports }
)
const check = (value: Fixture) =>
  module.exports.checkUtBudget(value.budgets, value.batch, value.completed, value.actions, 1)

it("accepts settled original budget facts and permits later receipt inspection without refreshing time", () => {
  const value = fixture()
  const before = JSON.stringify(value)
  expect(() => check(value)).not.toThrow()
  expect(() => check(value)).not.toThrow()
  expect(JSON.stringify(value)).toBe(before)
})

const invalid: Array<[string, (value: Fixture) => void]> = [
  [
    "stale resource generation",
    (value) => {
      value.budgets[0].generation = 2
    }
  ],
  [
    "missing budget",
    (value) => {
      value.budgets = []
    }
  ],
  [
    "duplicate budget",
    (value) => {
      value.budgets.push(structuredClone(value.budgets[0]))
    }
  ],
  [
    "different batch",
    (value) => {
      value.completed.budgetId = "another"
    }
  ],
  [
    "extended stage",
    (value) => {
      value.budgets[0].deadlineAt++
    }
  ],
  [
    "extended policy",
    (value) => {
      value.budgets[0].policy.totalMs++
    }
  ],
  [
    "first command too late",
    (value) => {
      value.budgets[0].firstCommandAt = value.budgets[0].firstDeadlineAt + 1
    }
  ],
  [
    "settlement too late",
    (value) => {
      value.budgets[0].settledAt = value.budgets[0].deadlineAt + 1
    }
  ],
  [
    "unknown process",
    (value) => {
      value.budgets[0].commands[0].status = "unknown"
    }
  ],
  [
    "process not physically finished",
    (value) => {
      value.budgets[0].commands[0].finishedAt = NaN
    }
  ],
  [
    "command exceeds 300 seconds",
    (value) => {
      const budget = value.budgets[0]
      budget.commands[0].finishedAt = budget.commands[0].startedAt + 300001
      budget.settledAt = budget.commands[0].finishedAt + 1
    }
  ],
  [
    "unmatched action identity",
    (value) => {
      value.budgets[0].commands[0].executionId = "unrelated"
    }
  ],
  [
    "unmatched command",
    (value) => {
      value.budgets[0].commands[0].argv = ["different"]
    }
  ],
  [
    "unmatched exit",
    (value) => {
      value.budgets[0].commands[0].exitCode = 1
    }
  ],
  [
    "cross repository receipt",
    (value) => {
      value.actions[0].output.workspaceRef = "secondary"
    }
  ],
  [
    "not settled",
    (value) => {
      value.budgets[0].status = "active"
    }
  ]
]
it.each(invalid)("rejects %s instead of trusting a successful Code result", (_label, mutate) => {
  const value = fixture()
  mutate(value)
  expect(() => check(value)).toThrow("AUTOBIZ_CODE_UT_DEADLINE_EVIDENCE_INVALID")
})

it("binds a failed command and one successful rerun to the same original budget", () => {
  const value = fixture(),
    budget = value.budgets[0]
  budget.commands[0].exitCode = 1
  value.actions[0].status = "failed"
  value.actions[0].output.exitCode = 1
  const rerun = {
    ...budget.commands[0],
    commandId: "B001-test-rerun-1",
    executionId: "original-rerun-action",
    intentAt: budget.startedAt + 100,
    startedAt: budget.startedAt + 101,
    finishedAt: budget.startedAt + 110,
    exitCode: 0
  }
  budget.commands.push(rerun)
  value.actions.push({
    executionId: rerun.executionId,
    stepId: rerun.commandId,
    status: "succeeded",
    output: { phase: "test", workspaceRef: "default", exitCode: 0, argv: rerun.argv }
  })
  budget.executionId = value.completed.testExecutionId = rerun.executionId
  budget.settledAt = rerun.finishedAt + 1
  expect(() => check(value)).not.toThrow()
  budget.startedAt = rerun.intentAt
  expect(() => check(value)).toThrow("AUTOBIZ_CODE_UT_DEADLINE_EVIDENCE_INVALID")
})
