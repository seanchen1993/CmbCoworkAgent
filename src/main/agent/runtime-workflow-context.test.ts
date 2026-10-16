import { readFileSync } from "node:fs"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import type { CreateAgentRuntimeOptions } from "./runtime"

/** Execute the actual private child factory without booting Electron's application singletons. */
function workflowFactory(deps: Record<string, unknown>) {
  const source = ts.createSourceFile(
    "runtime.ts",
    readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let factory: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "createWorkflowTool") {
      const options = node.arguments[0]
      if (!ts.isObjectLiteralExpression(options)) throw Error("Workflow options changed")
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
          ts.isPropertyAssignment(property) && property.name.getText(source) === "createRuntime"
      )
      if (create && ts.isPropertyAssignment(create) && ts.isArrowFunction(create.initializer))
        factory = create.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!factory) throw Error("Production workflow factory not found")
  const javascript = ts.transpileModule(`const createChild=${factory.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(
    "deps",
    `const {${Object.keys(deps).join(",")}}=deps;${javascript};return createChild`
  )(deps) as (options: Record<string, unknown>) => Promise<unknown>
}

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
    const children = new Set<string>()
    const construct = workflowFactory({
      createAgentRuntime,
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
      worktreeSubagentThreads: children
    })
    expect(
      await construct({
        threadId: "child",
        agentId: "reviewer",
        shellAccess,
        worktreeIsolation: { workspaceRoot: "isolated-worktree" }
      })
    ).toBe(runtime)
    expect(createAgentRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: "child",
        workspacePath: "parent-workspace",
        approvalThreadId: "parent-thread",
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
    expect(children.has("child")).toBe(true)
    expect(status).toHaveLength(1)
  }
)
