import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import type { CreateAgentRuntimeOptions } from "./runtime"

/** Execute the actual private child factory without booting Electron's application singletons. */
function workflowFactory(deps: Record<string, unknown>, selected = "createRuntime") {
  const source = ts.createSourceFile(
    "runtime.ts",
    readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let factory: ts.ArrowFunction | undefined
  const optionsByName = new Map<string, ts.ObjectLiteralExpression>()
  function findOptions(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)) optionsByName.set(node.name.text, node.initializer)
    ts.forEachChild(node, findOptions)
  }
  findOptions(source)
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createWorkflowTool") {
      const argument = node.arguments[0]
      const options = ts.isIdentifier(argument) ? optionsByName.get(argument.text) : argument
      if (!options || !ts.isObjectLiteralExpression(options)) throw Error("Workflow options changed")
      const subagents = options.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === "subagentDeps"
      )
      if (
        !subagents ||
        !ts.isPropertyAssignment(subagents) ||
        !ts.isObjectLiteralExpression(subagents.initializer)
      )
        throw Error("Missing child dependencies")
      const create = subagents.initializer.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === selected
      )
      if (create && ts.isPropertyAssignment(create) && ts.isArrowFunction(create.initializer))
        factory = create.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!factory) throw Error("Production workflow factory not found")
  let cleanupHelper = ""
  if (selected === "cleanupThread") {
    const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "cleanupChildRuntimeResources")
    if (!declaration) throw Error("Production child cleanup helper not found")
    cleanupHelper = declaration.getText(source).replace(/^export\s+/, "")
  }
  const javascript = ts.transpileModule(`${cleanupHelper}\nconst createChild=${factory.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(
    "deps",
    `const {${Object.keys(deps).join(",")}}=deps;${javascript};return createChild`
  )(deps) as (options: Record<string, unknown> | string) => Promise<unknown>
}

it.each([false, true])("the real Workflow cleanup waits Function retirement and still drains other resources on failure=%s", async failure => {
  const gate = Promise.withResolvers<void>()
  const releaseChild = vi.fn()
  const drain = vi.fn(() => gate.promise)
  const physicalExit = Promise.withResolvers<void>()
  const processDrain = vi.fn(() => physicalExit.promise)
  const children = new Map([["child", releaseChild]])
  const revoke = vi.fn(async () => {})
  const checkpoint = vi.fn(async () => {})
  const removeCheckpoint = vi.fn()
  const cleanup = workflowFactory({
    getModsManager: () => ({ closeFunctionThreadAndWait: drain }),
    workflowModsChildren: children,
    clearActionStationarityTurn: vi.fn(),
    LocalSandbox: { cancelBackgroundTasksAndWait: processDrain, revokeGrantedAclsForRun: revoke },
    closeCheckpointer: checkpoint,
    deleteThreadCheckpoint: removeCheckpoint
  }, "cleanupThread")
  const pending = cleanup("child")
  const observed = failure ? expect(pending).rejects.toThrow("EXIT_UNCONFIRMED") : pending
  await Promise.resolve()
  expect(releaseChild).not.toHaveBeenCalled()
  expect(processDrain).not.toHaveBeenCalled()
  if (failure) gate.reject(Error("EXIT_UNCONFIRMED"))
  else gate.resolve()
  await vi.waitFor(() => expect(processDrain).toHaveBeenCalledExactlyOnceWith("child"))
  expect(releaseChild).toHaveBeenCalledOnce()
  expect(children.has("child")).toBe(false)
  expect(revoke).not.toHaveBeenCalled()
  expect(checkpoint).not.toHaveBeenCalled()
  expect(removeCheckpoint).not.toHaveBeenCalled()
  physicalExit.resolve()
  await observed
  expect(revoke).toHaveBeenCalledExactlyOnceWith("child")
  expect(checkpoint).toHaveBeenCalledExactlyOnceWith("child")
  expect(removeCheckpoint).toHaveBeenCalledExactlyOnceWith("child")
  expect(removeCheckpoint.mock.invocationCallOrder[0]).toBeGreaterThan(checkpoint.mock.invocationCallOrder[0])
})

it.each(["full", "read_only", "none"])(
  "carries resolved plugin knowledge into the real workflow child constructor with shellAccess=%s",
  async (shellAccess) => {
    const status = [
      { deployUnitId: "team", path: "team.md", source: "local", loaded: true, message: "" }
    ]
    const runtime = { stream: vi.fn() }
    const createAgentRuntime = vi.fn<
      (options: CreateAgentRuntimeOptions) => Promise<typeof runtime>
    >(async () => runtime)
    const children = new Map<string, () => void>()
    const closeChild = vi.fn()
    const construct = workflowFactory({
      createAgentRuntime,
      createWorkflowChildModsRuntime: async (_input: unknown,
        create: (bind: (lifecycle: unknown) => void) => Promise<unknown>) => ({
        runtime: await create(() => {}), close: closeChild
      }),
      creatorAccounting: undefined,
      workflowModsChildren: children,
      normalizedHarnessAgentsPrompt: "TEAM_REQUIRED_KNOWLEDGE",
      normalizedHarnessAgentmdLoadStatus: status,
      workspacePath: "parent-workspace",
      threadId: "parent-thread",
      childInstructionParent: undefined,
      clawSources: [],
      toolStrategy: "native",
      resolveWorkflowToolStrategy: (value: unknown) => value,
      getYoloMode: () => false,
      memoryEnabledForThread: false,
      retryHooks: undefined,
      maxRetryAttempts: 0,
      hookScope: undefined,
      createInheritedHookScope: () => undefined,
      onHookResult: undefined,
      onFailureFuseNotice: undefined,
      hookTurnId: "parent-turn",
      pluginRoot: "plugin-source",
      pluginId: "knowledge-plugin",
      pluginName: "Team",
      pluginWorkspace: "parent-workspace",
      featureId: "feature",
      isHarnessProjectSession: false,
      harnessProjectId: "project",
      harnessAdapterName: "Team",
      harnessAdapterVersion: "1",
      harnessNodeName: "review",
      harnessNodeStatus: "in_progress",
      projectCode: "code",
      projectDir: "project",
      pluginOutputDir: "output",
      onFileMutation: vi.fn(),
      managedExecution: undefined,
      autoBackgroundHandoff: false
    })
    expect(
      await construct({
        threadId: "child",
        agentId: "reviewer",
        shellAccess,
        toolAllowlist: ["read_file"],
        worktreeIsolation: { workspaceRoot: "isolated-worktree" }
      })
    ).toBe(runtime)
    expect(createAgentRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "child",
        workspacePath: "parent-workspace",
        allowedToolNames: ["read_file", "structured_output"],
        approvalThreadId: "parent-thread",
        shellParentThreadId: "parent-thread",
        autoBackgroundHandoff: false,
        harnessAgentsPrompt: "TEAM_REQUIRED_KNOWLEDGE",
        agentmdLoadStatus: status,
        enableAgentsPrompt: shellAccess === "full",
        disableMemoryInjection: shellAccess !== "full",
        disableSubagents: true,
        filesystemAccess: { workspacePath: "isolated-worktree", shellAccess, disallowedTools: [] },
        toolConcurrencyQueueId: "isolated-worktree",
        onFileMutation: undefined
      })
    )
    expect(children.get("child")).toBe(closeChild)
    expect(closeChild).not.toHaveBeenCalled()
    expect(status).toHaveLength(1)
  }
)
