import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

// Execute the invoke settlement callback with runtime boundaries stubbed, without
// initializing Electron and the unrelated agent tools imported by agent.ts.
const file = ts.createSourceFile(
  "agent.ts",
  readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)
let invokeTerminalCallback: ts.ArrowFunction | undefined
function visit(node: ts.Node): void {
  if (invokeTerminalCallback) return
  if (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(file) === "name" &&
        ts.isStringLiteral(property.initializer) &&
        property.initializer.text === "queue-managed-auto-mode-terminal"
    )
  ) {
    const run = node.properties.find(
      (property) => ts.isPropertyAssignment(property) && property.name.getText(file) === "run"
    )
    if (run && ts.isPropertyAssignment(run) && ts.isArrowFunction(run.initializer)) {
      invokeTerminalCallback = run.initializer
    }
  }
  ts.forEachChild(node, visit)
}
visit(file)
if (!invokeTerminalCallback) throw new Error("Managed invoke terminal callback is missing")
const callbackCode = ts.transpileModule(`const execute = ${invokeTerminalCallback.getText(file)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function loadTerminalCallback(overrides: Record<string, unknown> = {}) {
  const queueTerminal = vi.fn()
  const delivery = { send: vi.fn() }
  const dependencies = {
    autoModeTerminal: { outcome: "success", endReason: { code: "normal" } },
    invokeFinalReason: undefined,
    createAutoModeTerminal: vi.fn(),
    isWorkflowNotificationInvoke: false,
    workflowNotificationTerminalEligibleForManaged: false,
    isTrustedCoordinatorNotificationInvoke: true,
    isCoordinatorNotificationTurn: true,
    isActiveManagedRunSession: () => true,
    abortController: new AbortController(),
    managedExecution: undefined,
    threadId: "thread",
    usedModelId: undefined,
    invokeRoutingResult: undefined,
    modelId: undefined,
    getDefaultModelConfig: () => ({}),
    highWaterInputTokens: 0,
    workflowLaunchedRunIds: new Set<string>(),
    queueAutoModeAgentTurnEnd: queueTerminal,
    ensureTurnId: () => "turn",
    turnState: {},
    delivery,
    isPhysicalStreamRunActive: () => true,
    runToken: "run",
    ...overrides
  }
  const execute = new Function(...Object.keys(dependencies), `${callbackCode}\nreturn execute`)(
    ...Object.values(dependencies)
  ) as () => Promise<void>
  return { execute, queueTerminal, delivery }
}

describe("managed coordinator result-delivery terminal", () => {
  it.each([
    { outcome: "success", endReason: { code: "normal" } },
    { outcome: "error", endReason: { code: "provider_error" } }
  ])(
    "reports $outcome to the managed controller after handling worker results",
    async (terminal) => {
      const { execute, queueTerminal, delivery } = loadTerminalCallback({
        autoModeTerminal: terminal
      })

      await execute()

      expect(queueTerminal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadId: "thread", turnId: "turn", terminal, delivery })
      )
    }
  )

  it.each([
    { reason: "ordinary thread", isActiveManagedRunSession: () => false },
    { reason: "stale notification", isCoordinatorNotificationTurn: false },
    { reason: "notification not processed", autoModeTerminal: undefined },
    { reason: "cancelled run", abortController: { signal: { aborted: true } } }
  ])("does not report a $reason", async (overrides) => {
    const { execute, queueTerminal } = loadTerminalCallback(overrides)

    await execute()

    expect(queueTerminal).not.toHaveBeenCalled()
  })

  it("still reports ordinary managed turns", async () => {
    const { execute, queueTerminal } = loadTerminalCallback({
      isTrustedCoordinatorNotificationInvoke: false,
      isCoordinatorNotificationTurn: false,
      managedExecution: true
    })

    await execute()

    expect(queueTerminal).toHaveBeenCalledOnce()
  })
})
