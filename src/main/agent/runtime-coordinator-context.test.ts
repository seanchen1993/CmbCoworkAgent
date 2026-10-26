import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it, vi } from "vitest"

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
    const workerAccounting = evaluate(initializer("workerAccounting"), {
      creatorAccounting: undefined, threadId: "parent", workerInput, workspacePath: "/worker-worktree"
    })
    expect(workerAccounting).toBeUndefined()
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
      creatorAccounting: undefined,
      workerAccounting,
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
    expect(options.creatorAccounting).toBe(workerAccounting)
    expect(options.filesystemAccess.workload).toBe(stage === "handoff" ? "read_only" : "verify")
  }
)

it("captures one worker billing parent before initial/failover/handoff and reuses that exact receipt", () => {
  const workerInput = { workerThreadId: "actual-worker", abortSignal: new AbortController().signal }
  const receipt = Object.freeze({ billingOnly: true })
  const forChild = vi.fn(() => receipt)
  const workerAccounting = evaluate(initializer("workerAccounting"), {
    creatorAccounting: { forChild }, threadId: "parent", workerInput, workspacePath: "/owned-root"
  })
  expect(workerAccounting).toBe(receipt)
  expect(forChild).toHaveBeenCalledExactlyOnceWith("parent", "actual-worker", "/owned-root", undefined, workerInput.abortSignal)
  const bindings: ts.PropertyAssignment[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createAgentRuntime") {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
        ts.isSpreadAssignment(property) && property.expression.getText(source) === "workerHarnessContext")) {
        const binding = options.properties.find((property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "creatorAccounting")
        if (!binding) throw Error("Missing actual worker accounting binding")
        bindings.push(binding)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(bindings).toHaveLength(3)
  for (const binding of bindings) expect(evaluate(binding.initializer, { workerAccounting })).toBe(receipt)
  expect(forChild).toHaveBeenCalledOnce()
})

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

// Evaluate the actual createDeepAgent call's Mods contribution property as well
// as its plain prompt input; a second injection path must not restore the goal.
it.each(["host", "legacy", undefined])("selects the same task background for both prompt channels: %s", mode => {
  const parent = "MAIN_STAGE_AND_REJECTION_GOAL"
  const background = "FROZEN_DELEGATION_BOUNDARIES"
  const agents = "PROTECTED_KNOWLEDGE_CONFIG_AND_AGENTS"
  const taskPluginPromptInject = evaluate(initializer("taskPluginPromptInject"), {
    hostModeSource: mode ? { mode, subagentContextPrompt: background } : undefined,
    renderPluginPromptInject: (text: string | undefined) => text,
    renderedPluginPromptInject: parent
  })
  const deps = { taskPluginPromptInject, combinedAgentsPrompt: agents,
    projectModeTaskSubagentsInheritFullContext: true,
    modInstructionContext: { name: "claudeMd" }, requiredProjectPrompt: agents }
  const plain = evaluate(initializer("taskSubagentExtraSystemPrompt"), deps)
  let contributions: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createDeepAgent" &&
        ts.isObjectLiteralExpression(node.arguments[0])) {
      const property = node.arguments[0].properties.find(p => ts.isPropertyAssignment(p) &&
        p.name.getText(source) === "modTaskProjectContributions")
      if (property && ts.isPropertyAssignment(property)) contributions = property.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(contributions).toBeDefined()
  const mods = evaluate(contributions!, deps) as Array<{ text: string; requiredText?: string }>
  expect(mods.map(item => item.text).join("")).toBe(plain)
  expect(mods.at(-1)?.requiredText).toBe(agents)
  expect(plain).toContain(mode === "host" ? background : parent)
  if (mode === "host") expect(plain).not.toContain(parent)
})
