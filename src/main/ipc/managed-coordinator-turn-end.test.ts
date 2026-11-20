import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { extractErrorDetail, isRetryableManagedProviderError } from "../agent/failover"
import type { AgentTurnEndEvent } from "../../shared/harness-board-types"

// Execute the invoke settlement callback with runtime boundaries stubbed, without
// initializing Electron and the unrelated agent tools imported by agent.ts.
const file = ts.createSourceFile(
  "agent.ts",
  readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)
const terminalFactory = file.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createAutoModeTerminal"
)
if (!terminalFactory) throw new Error("Managed terminal factory is missing")
const terminalFactoryCode = ts.transpileModule(terminalFactory.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
const createTerminal = new Function(
  "isRetryableManagedProviderError",
  "extractErrorDetail",
  `${terminalFactoryCode}\nreturn createAutoModeTerminal`
)(isRetryableManagedProviderError, extractErrorDetail) as (
  outcome: AgentTurnEndEvent["outcome"],
  code: AgentTurnEndEvent["endReason"]["code"],
  message: string,
  error: unknown
) => Pick<AgentTurnEndEvent, "outcome" | "endReason">

describe("managed terminal provider error metadata", () => {
  it("logs and stops an unclassified provider failure", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const terminal = createTerminal(
        "error",
        "provider_error",
        "未知失败",
        new Error("unclassified")
      )
      expect(terminal.endReason.retryable).toBe(false)
      expect(log).toHaveBeenCalledWith(
        "[AutoMode] Provider failure classified:",
        expect.objectContaining({ category: "unknown", retryable: false })
      )
    } finally {
      log.mockRestore()
    }
  })

  it("preserves the structured cause at all three failover exhaustion boundaries", () => {
    const constructors: ts.NewExpression[] = []
    function collect(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Error" &&
        node.arguments?.[0] &&
        ts.isTemplateExpression(node.arguments[0]) &&
        node.arguments[0].head.text.startsWith("All models failed")
      ) {
        constructors.push(node)
      }
      ts.forEachChild(node, collect)
    }
    collect(file)
    expect(constructors).toHaveLength(3)
    const original = Object.assign(new Error("网关暂时不可用"), { status: 503 })
    for (const node of constructors) {
      const wrapped = new Function(
        "allErrors",
        "lastInitializationError",
        `return ${node.getText(file)}`
      )("内置模型: 503 网关暂时不可用", original) as Error
      expect(wrapped.cause).toBe(original)
      expect(
        createTerminal("error", "provider_error", wrapped.message, wrapped).endReason.retryable
      ).toBe(true)
    }
  })

  it.each([
    { error: { status: 403, code: "ECONNRESET", message: "503 timeout" }, retryable: false },
    { error: { response: { status: 401 } }, retryable: false },
    { error: { status: 434 }, retryable: false },
    { error: { status: 503 }, retryable: true },
    { error: { code: "ECONNRESET" }, retryable: true }
  ])(
    "classifies $error as retryable=$retryable from the original error",
    ({ error, retryable }) => {
      const terminal = createTerminal("error", "provider_error", "调用失败", error)
      expect(terminal.endReason).toEqual({ code: "provider_error", retryable, message: "调用失败" })
    }
  )
})

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
