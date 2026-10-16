import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it } from "vitest"

const source = ts.createSourceFile(
  "runtime.ts",
  readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)
function initializer(name: string): ts.Expression {
  let result: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      result = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!result) throw Error("Missing production initializer: " + name)
  return result
}
function evaluate(expression: ts.Expression, deps: Record<string, unknown>) {
  const javascript = ts.transpileModule(`const value=(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(...Object.keys(deps), javascript + "\nreturn value")(...Object.values(deps))
}
const knowledge = "# Deployment knowledge\nDo not publish without review."
const loadStatus = [
  {
    deployUnitId: "api",
    path: "knowledge.md",
    loaded: true,
    source: "local",
    message: "",
    required: true
  }
]

it.each(["initial", "failover", "handoff"])(
  "carries resolved plugin knowledge and status in the actual coordinator %s options",
  (stage) => {
    const workerInput = {
      workerId: "worker",
      workerThreadId: "worker-thread",
      parentThreadId: "parent",
      workload: "verify",
      ownedFiles: ["src/api.ts"],
      abortSignal: new AbortController().signal
    }
    const inherited = evaluate(initializer("workerHarnessContext"), {
      workerInput,
      normalizedHarnessAgentsPrompt: knowledge,
      normalizedHarnessAgentmdLoadStatus: loadStatus,
      ...Object.fromEntries(
        [
          "onFileMutation",
          "systemId",
          "pluginRoot",
          "pluginId",
          "pluginName",
          "pluginWorkspace",
          "featureId",
          "isHarnessProjectSession",
          "harnessProjectId",
          "harnessAdapterName",
          "harnessAdapterVersion",
          "harnessNodeName",
          "harnessNodeStatus",
          "projectCode",
          "projectDir",
          "pluginOutputDir",
          "hookTurnId"
        ].map((key) => [key, key])
      )
    })
    const calls: ts.Expression[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "createAgentRuntime") {
        const options = node.arguments[0]
        if (
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isSpreadAssignment(property) &&
              property.expression.getText(source) === "workerHarnessContext"
          )
        )
          calls.push(options)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toHaveLength(3)
    const options = evaluate(calls[["initial", "failover", "handoff"].indexOf(stage)], {
      workerInput,
      workerHarnessContext: inherited,
      workspacePath: "/worker-worktree",
      toolStrategy: "standard",
      workerActionStationarityTurnId: "turn",
      managedExecution: true,
      candidateId: "first",
      nextCandidate: "second",
      usedWorkerModelId: "used",
      modelId: "default",
      workerRolePrompt: "role",
      workerMetadataPrompt: "metadata",
      handoffMetadataPrompt: "handoff",
      retryHooks: false,
      maxRetryAttempts: 0,
      memoryEnabledForThread: false,
      childInstructionParent: undefined,
      clawSources: undefined,
      workerHookScope: undefined,
      workerRuntimeTraceContext: undefined,
      workerOnHookResult: undefined,
      onFailureFuseNotice: undefined
    })
    expect(options.harnessAgentsPrompt).toBe(knowledge)
    expect(options.agentmdLoadStatus).toBe(loadStatus)
    expect(options.workspacePath).toBe("/worker-worktree")
    expect(options.threadId).toBe("worker-thread")
    expect(options.approvalThreadId).toBe("parent")
    expect(options.enableAgentsPrompt).toBe(false)
    expect(options.disableSubagents).toBe(true)
    expect(options.filesystemAccess.workload).toBe(stage === "handoff" ? "read_only" : "verify")
  }
)

it.each([true, false])(
  "does not duplicate resolved plugin knowledge in coordinator roles (project=%s)",
  (isProjectMode) => {
    const raw = "# Required knowledge"
    const combined = "## AGENTS.md instructions\n\n### Required knowledge"
    const workerAgentsPrompt = evaluate(initializer("workerAgentsPrompt"), {
      normalizedHarnessAgentsPrompt: raw,
      combinedAgentsPrompt: combined
    })
    const role = evaluate(initializer("coordinatorWorkerProjectInstructions"), {
      runtimePolicy: { isProjectMode },
      workerAgentsPrompt,
      renderedPluginPromptInject: "plugin context",
      coordinatorPluginPromptInject: "plugin context",
      extraSystemPrompt: "extra context"
    })
    expect(role).not.toContain("Required knowledge")
    expect(role).toContain("plugin context")
    expect(role).toContain("extra context")
    expect(
      evaluate(initializer("workerAgentsPrompt"), {
        normalizedHarnessAgentsPrompt: undefined,
        combinedAgentsPrompt: combined
      })
    ).toBe(combined)
  }
)

it("protects canonical rendered project instructions after heading normalization", () => {
  const combined = "## AGENTS.md instructions\n\n### Deployment knowledge\nRequired content"
  expect(
    evaluate(initializer("requiredProjectPrompt"), {
      normalizedHarnessAgentsPrompt: "# Deployment knowledge\nRequired content",
      combinedAgentsPrompt: combined
    })
  ).toBe(combined)
  expect(
    evaluate(initializer("requiredProjectPrompt"), {
      normalizedHarnessAgentsPrompt: undefined,
      combinedAgentsPrompt: combined
    })
  ).toBeUndefined()
})
