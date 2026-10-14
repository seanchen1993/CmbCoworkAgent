import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listClawSkillSources, type ClawSkillPolicy } from "../claw-skills"
import type { ModsManager } from "../manager"
import type { FunctionModsManager, HostCompletionOptions } from "../v2/manager"
import type { FlowRun, FlowStep } from "../../../shared/mods/flows/types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { currentFunctionExecution } from "../v2/execution-context"
import { NativeFlowHost } from "./native-host"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { issueRuntimePluginSourceToken, withRuntimePluginSource, captureRuntimePluginSourceThreadGuard } from "../../plugins/runtime-source-scope"
import type { PluginMetadata } from "../../types"

const mocks = vi.hoisted(() => ({
  promptProof: vi.fn(),
  hooks: [] as Array<{ event: string }>,
  sandbox: vi.fn(),
  skillSource: "",
  runtime: vi.fn(),
  legacyHook: vi.fn(),
  harnessContext: vi.fn(),
  runner: vi.fn(),
  prepareMcp: vi.fn(),
  invokeMcp: vi.fn(),
  mcpChanged: false,
  cleanup: vi.fn(),
  acl: vi.fn(),
  checkpointer: vi.fn(),
  deleteCheckpoint: vi.fn(),
  modelOverrides: new Map<string, Record<string, unknown>>(),
  defaultRef: "custom:default" as string | null,
  threads: new Map<string, { metadata: string }>()
}))
vi.mock("../../harness-board/service", () => ({
  buildHarnessFeatureAgentContext: mocks.harnessContext,
  readHarnessFeatureMetadata: (metadata: { harnessFeature?: unknown }) =>
    metadata.harnessFeature ?? null,
  resolveHarnessFeaturePluginIdentity: async () => ({}),
  resolveHarnessFeatureCurrentStage: async () => null
}))
vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: mocks.legacyHook }))
vi.mock("../../db", () => ({
  // Map-backed threads are not an authentic native database for the optional facts path.
  getDb: () => {
    throw new Error("NATIVE_HOST_FIXTURE_NO_NATIVE_DB")
  },
  createThread: (id: string, metadata: object) => {
    const row = { metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: id }) }
    mocks.threads.set(id, row)
    return row
  },
  getThreadCore: (id: string) => mocks.threads.get(id),
  deleteThread: (id: string) => mocks.threads.delete(id)
}))
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "C:/app" } }))
vi.mock("../../agent/local-sandbox", () => ({
  LocalSandbox: class {
    constructor(options: unknown) {
      mocks.sandbox(options)
    }
    static cancelBackgroundTasksAndWait = mocks.cleanup
    static revokeGrantedAclsForRun = mocks.acl
  }
}))
vi.mock("../../agent/codex-sandbox-binary", () => ({ ensureCodexExe: vi.fn() }))
vi.mock("../../storage", () => ({
  getUserInfo: () => undefined,
  getEnabledHooks: () => mocks.hooks,
  getPlugins: () => [{ id: "legacy", enabled: true, path: "plugin", version: "1" }],
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => [],
  getEnabledSkillsSources: async () => (mocks.skillSource ? [mocks.skillSource] : []),
  getSkillsSources: () => (mocks.skillSource ? [mocks.skillSource] : []),
  getEnabledPluginSkillSourceMetadata: () => [],
  getDisabledSkillDirs: () => [],
  getWindowsSandboxMode: () => "none",
  deleteThreadCheckpoint: mocks.deleteCheckpoint
}))
vi.mock("../../agent/action-stationarity", () => ({ clearActionStationarityTurn: vi.fn() }))
vi.mock("../../models/registry", () => ({
  getDefaultModelConfig: () =>
    mocks.defaultRef
      ? { ref: mocks.defaultRef, apiKey: "test", ...mocks.modelOverrides.get(mocks.defaultRef) }
      : null,
  getModelConfigByRef: (id: string) =>
    id === "missing" ? null : { ref: id, apiKey: "test", ...mocks.modelOverrides.get(id) }
}))
vi.mock("../../agent/agent-registry", () => ({
  loadAgentProfilesAsync: async () => [
    {
      name: "review",
      systemPrompt: "read only",
      disallowedTools: ["write_file"],
      shellAccess: "read_only"
    }
  ],
  resolveProfileFromList: (profiles: { name: string }[], name: string) =>
    profiles.find((role) => role.name === name)
}))
vi.mock("../../agent/workflow/subagent", () => ({ runWorkflowSubagent: mocks.runner }))
vi.mock("../../agent/runtime", () => ({
  createAgentRuntime: mocks.runtime,
  closeCheckpointer: mocks.checkpointer
}))
vi.mock("../v2/native-user-input", () => ({ functionUserInputInvoker: () => vi.fn() }))
vi.mock("./native-mcp", () => ({ prepareNativeMcpStep: mocks.prepareMcp }))
vi.mock("../../agent/flow-prompt-runtime", () => ({
  readFlowPromptRuntimeProof: mocks.promptProof
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hooks = []
  mocks.promptProof.mockReset()
  mocks.skillSource = ""
  mocks.threads.clear()
  mocks.modelOverrides.clear()
  mocks.defaultRef = "custom:default"
  mocks.mcpChanged = false
  mocks.legacyHook.mockReset().mockResolvedValue(null)
  mocks.harnessContext.mockReset().mockResolvedValue(null)
  mocks.invokeMcp.mockReset().mockImplementation(async (_input, signal) => {
    signal.throwIfAborted()
    expect(currentFunctionExecution()?.turnId).toBe("flow_test")
    return {
      content: [],
      text: "Real provider result",
      structuredContent: { value: "from-mcp" },
      isError: false
    }
  })
  mocks.prepareMcp.mockReset().mockImplementation(async (options) => ({
    plan: {
      provider: options.provider,
      toolName: options.toolName,
      schemaDigest: options.schemaDigest
    },
    assertCurrent: () => {
      options.assertLive()
      if (mocks.mcpChanged) throw Error("FLOW_MCP_CONNECTION_CHANGED")
    },
    invoke: mocks.invokeMcp
  }))
  mocks.cleanup.mockReset().mockResolvedValue(undefined)
  mocks.acl.mockReset().mockResolvedValue(undefined)
  mocks.checkpointer.mockReset().mockResolvedValue(undefined)
  mocks.runtime.mockImplementation(async (options) => {
    options.onHostLifecycleReady?.((operation: () => unknown) => operation())
    return { stream: vi.fn() }
  })
  mocks.runner.mockImplementation(async (deps, request) => {
    await deps.createRuntime({
      threadId: "child",
      agentId: "physical-child",
      modelId: request.model,
      extraSystemPrompt: request.roleSystemPrompt,
      abortSignal: request.signal,
      disallowedTools: request.disallowedTools,
      shellAccess: request.shellAccess
    })
    return { structured: { passed: true, summary: "reviewed" }, outputTokens: 3 }
  })
})
afterEach(() => {
  releaseLocalThreadRunLease("thread", "mods", "flow_test")
  releaseLocalThreadRunLease("child", "mods", "flow_test:e1")
  releaseLocalThreadRunLease("child-two", "mods", "flow_test:e1")
})

function fixture(steps: FlowStep[]) {
  mocks.threads.set("thread", {
    metadata: JSON.stringify({ workspacePath: "workspace", agentMode: "normal" })
  })
  let version = 0
  let enabled = true
  const lifecycle = new AbortController()
  const calls: string[] = []
  const runtimeInstance = new ModRuntimeAuthorities().create({
    workspace: "workspace",
    threadId: "thread",
    turnId: "flow_test"
  })
  const authority = runtimeInstance.authority
  const released = vi.fn(runtimeInstance.release)
  const manager = {
    isEnabled: () => enabled,
    closeFunctionThread: vi.fn(),
    createRuntimeAuthority: vi.fn(() => ({ authority, release: released })),
    store: { saveCompletionEvidence: vi.fn() },
    createHostFlowAuthority: vi.fn((input) => ({ ...input, kind: "host-flow" })),
    runHostFlowProjectCheck: vi.fn(async () => ({
      kind: "unit-test",
      passed: true,
      executionId: "receipt",
      exitCode: 0,
      output: "passed",
      outputFingerprint: "output-digest"
    })),
    publish: vi.fn(async (_workspace, value) => value)
  } as unknown as ModsManager
  const functions = {
    clawSelection: vi.fn(() => null),
    prepareAction: vi.fn(async (_workspace, _thread, action) => ({
      action: {
        ...action,
        command: action.actionId,
        name: action.name,
        inputSchema: {}
      },
      command: {}
    })),
    runAction: vi.fn(async (_workspace, _thread, prepared, envelope) => {
      expect(currentFunctionExecution()?.runtimeAuthority).toBe(authority)
      return {
        text: "Action complete",
        output: { provider: prepared.action.plugin, ...envelope.input }
      }
    }),
    prepareFlowScope: vi.fn(async () => ({
      signal: lifecycle.signal,
      assertLive: () => lifecycle.signal.throwIfAborted(),
      fingerprint: async () => `version:${version}`,
      captureBinding: async () => ({
        workspace: "workspace",
        threadId: "thread",
        turnId: "flow_test",
        runId: "flow_test",
        pluginDigests: {},
        runtimeGeneration: 1,
        configFingerprint: "config",
        diffFingerprint: `version:${version}`,
        stateFingerprint: "state",
        requirementVersion: "requirements",
        files: []
      }),
      withOwnerGrant: vi.fn(),
      stages: [],
      dispose: vi.fn()
    })),
    completionGate: vi.fn(async (_workspace, _thread, _context, options: HostCompletionOptions) => {
      return async () => {
        expect(currentFunctionExecution()?.runtimeAuthority).toBe(authority)
        expect(options.checkOnly).toBe(true)
        calls.push(
          options.temporaryPolicy
            ? String((options.temporaryPolicy.policy as { checks: string[] }).checks[0])
            : "application"
        )
        return { decision: "pass" }
      }
    }),
    advanceAutobizCheckpoint: vi.fn()
  } as unknown as FunctionModsManager
  const run: FlowRun = {
    id: "flow_test",
    threadId: "thread",
    workspace: "workspace",
    status: "running",
    startedAt: 1,
    epoch: 0,
    attempts: [],
    failureCounts: {},
    flow: {
      revision: 1,
      digest: "digest",
      updatedAt: 1,
      definition: {
        schemaVersion: 1,
        id: "demo",
        name: "Demo",
        plugin: "demo",
        goal: "Ship",
        timeoutMs: 10000,
        maxExecutions: 32,
        steps
      }
    }
  }
  claimLocalThreadRunLease({ threadId: "thread", owner: "mods", runId: run.id })
  const host = new NativeFlowHost(manager, functions, {
    scope: () => "workspace",
    changed: vi.fn()
  })
  const signal = new AbortController().signal
  const context = { run, executionId: "e1", signal }
  return {
    host,
    run,
    context,
    calls,
    authority,
    manager,
    functions,
    released,
    lifecycle,
    change: () => {
      version++
    },
    disable: () => {
      enabled = false
    }
  }
}

it("observes legacy recovery without preparing runtime, MCP, authority or child threads", async () => {
  const f = fixture([])
  releaseLocalThreadRunLease("thread", "mods", "flow_test")
  f.run.executionPlan = { models: { edit: { ref: "missing", fingerprint: "old" } }, actions: [] }
  const result = await f.host.observeRecovery(f.run)
  expect(result.authority).toBe("unavailable")
  expect(result.reasons?.map((row) => row.code)).toContain("model-unavailable")
  expect(result.artifactFingerprint).toBeUndefined()
  expect(f.functions.prepareFlowScope).not.toHaveBeenCalled()
  expect(f.manager.createRuntimeAuthority).not.toHaveBeenCalled()
  expect(mocks.runtime).not.toHaveBeenCalled()
  expect(mocks.prepareMcp).not.toHaveBeenCalled()
  expect(mocks.threads.size).toBe(1)
})

it.each(["flow", "definition", "execution"])(
  "diagnoses missing %s in legacy history without preparing execution",
  async (missing) => {
    const f = fixture([])
    if (missing === "flow") Reflect.deleteProperty(f.run, "flow")
    else if (missing === "definition") Reflect.deleteProperty(f.run.flow, "definition")
    else Reflect.deleteProperty(f.run.flow.definition, "execution")
    const result = await f.host.observeRecovery(f.run)
    expect(result.authority).not.toBe("current")
    expect(result.reasons?.length).toBeGreaterThan(0)
    expect(f.functions.prepareFlowScope).not.toHaveBeenCalled()
    expect(f.manager.createRuntimeAuthority).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  }
)

it("allows read-only disabled diagnostics without reenabling Mods", async () => {
  const f = fixture([])
  f.disable()
  expect(await f.host.observeRecovery(f.run)).toMatchObject({
    authority: "unavailable",
    reasons: [{ code: "mods-disabled" }]
  })
  expect(f.functions.prepareFlowScope).not.toHaveBeenCalled()
  expect(f.functions.clawSelection).not.toHaveBeenCalled()
  expect(f.manager.isEnabled("workspace")).toBe(false)
})

it("records a detached component selection snapshot in the prepared execution plan", async () => {
  const f = fixture([])
  const prepareScope = vi.mocked(f.functions.prepareFlowScope)
  const scope = await prepareScope(
    "workspace",
    "thread",
    "demo",
    "flow_test",
    "digest",
    f.context.signal
  )
  const components = { demo: { ids: ["base", "review"], selectionDigest: "a".repeat(64) } }
  prepareScope.mockResolvedValueOnce({ ...scope, components })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(execution.plan?.components).toEqual(components)
  components.demo.ids.push("not-selected")
  expect(execution.plan?.components?.demo.ids).toEqual(["base", "review"])
  await execution.dispose()
})

const nativeMcpStep: FlowStep = {
  kind: "mcp-tool",
  id: "mcp",
  name: "Read service",
  enabled: true,
  provider: { id: "provider:a", name: "A", digest: "a".repeat(64) },
  toolName: "read",
  schemaDigest: "b".repeat(64),
  input: { value: "request" }
}

it("passes protected MCP structured output to a later action and prevents repeated invocation", async () => {
  const action: FlowStep = {
    kind: "plugin-action",
    id: "action",
    name: "Use output",
    enabled: true,
    pluginId: "plugin",
    plugin: "plugin",
    digest: "c".repeat(64),
    actionId: "consume",
    input: {},
    inputFrom: { stepId: "mcp", path: "/structuredContent" }
  }
  const f = fixture([nativeMcpStep, action])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  try {
    expect(mocks.prepareMcp.mock.calls[0][0]).toMatchObject({
      manager: f.manager,
      threadId: "thread",
      turnId: "flow_test",
      withOwnerGrant: expect.any(Function)
    })
    expect(execution.plan?.mcpTools?.mcp).toMatchObject({
      toolName: "read",
      provider: nativeMcpStep.provider
    })
    const result = await execution.execute(nativeMcpStep, f.context)
    expect(result).toMatchObject({
      passed: true,
      source: "mcp-tool",
      mcpTool: { toolName: "read" }
    })
    f.run.attempts.push({
      executionId: "e1",
      stepId: "mcp",
      attempt: 1,
      epoch: 0,
      status: "passed",
      startedAt: 1,
      result
    })
    const actionResult = await execution.execute(action, { ...f.context, executionId: "e2" })
    expect(actionResult.output).toMatchObject({ provider: "plugin", value: "from-mcp" })
    await expect(
      execution.execute(nativeMcpStep, { ...f.context, executionId: "e3" })
    ).rejects.toThrow("FLOW_MCP_REPLAY_FORBIDDEN")
    expect(mocks.invokeMcp).toHaveBeenCalledOnce()
  } finally {
    await execution.dispose()
  }
})

it.each(["source", "grant"])(
  "rejects a pending approval fingerprint after %s changes",
  async (mode) => {
    const f = fixture([
      nativeMcpStep,
      { id: "approval", name: "Confirm", enabled: true, kind: "approval", prompt: "Proceed" }
    ])
    const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
    try {
      expect(await execution.fingerprint(f.context.signal)).toBe("version:0")
      f.run.status = "waiting"
      if (mode === "source") mocks.mcpChanged = true
      else f.lifecycle.abort(Error("grant revoked"))
      expect(() => execution.assertLive()).toThrow()
      await expect(execution.fingerprint(f.context.signal)).rejects.toThrow()
      await expect(execution.execute(nativeMcpStep, f.context)).rejects.toThrow()
      expect(mocks.invokeMcp).not.toHaveBeenCalled()
    } finally {
      await execution.dispose()
    }
  }
)

it("checks source freshness again after asynchronous result publication", async () => {
  const f = fixture([nativeMcpStep])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  vi.mocked(f.manager.publish).mockImplementation(async (_workspace, value) => {
    mocks.mcpChanged = true
    return value
  })
  try {
    await expect(execution.execute(nativeMcpStep, f.context)).rejects.toThrow(
      "FLOW_MCP_CONNECTION_CHANGED"
    )
    expect(mocks.invokeMcp).toHaveBeenCalledOnce()
  } finally {
    await execution.dispose()
  }
})

it("installs the same selected Skill policy and registry on the native Flow root backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "claw-flow-skill-"))
  try {
    mocks.skillSource = root
    for (const name of ["one", "two"]) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n${name}`)
    }
    const entries = await listClawSkillSources()
    const f = fixture([
      { id: "approve", name: "Approve", kind: "approval", enabled: true, prompt: "Confirm" }
    ])
    vi.mocked(f.functions.clawSelection).mockReturnValue({
      id: "selected",
      name: "Selected",
      capabilities: [],
      skills: { mode: "selected", items: entries.filter(({ name }) => name === "one") }
    })
    const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
    const options = mocks.sandbox.mock.calls[0][0] as {
      clawSkillPolicy: ClawSkillPolicy
      skillLifecycleRegistry: { resolveExplicit: (value: { skillPath: string }) => unknown }
      hookScope: unknown
    }
    expect(options.clawSkillPolicy.isPathHidden(join(root, "one", "SKILL.md"))).toBe(false)
    expect(options.clawSkillPolicy.isPathHidden(join(root, "two", "SKILL.md"))).toBe(true)
    expect(
      options.skillLifecycleRegistry.resolveExplicit({ skillPath: join(root, "two") })
    ).toBeNull()
    expect(options.hookScope).toBeDefined()
    await execution.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("retains the exact runtime authority in sandbox and host check execution", async () => {
  const step: FlowStep = {
    id: "check",
    name: "Test",
    kind: "check",
    check: "unit-test",
    enabled: true
  }
  const f = fixture([step])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(mocks.sandbox.mock.calls[0][0].modRuntimeAuthority).toBe(f.authority)
  expect(await execution.execute(step, f.context)).toMatchObject({
    passed: true,
    source: "native-check"
  })
  releaseLocalThreadRunLease("thread", "mods", f.run.id)
  claimLocalThreadRunLease({ threadId: "thread", owner: "mods", runId: f.run.id })
  expect(() => execution.assertLive()).toThrow("FLOW_LEASE_CHANGED")
  await expect(execution.dispose()).rejects.toThrow("FLOW_CLEANUP_FAILED")
  expect(f.released).toHaveBeenCalledTimes(1)
  expect(mocks.cleanup).not.toHaveBeenCalledWith("thread")
  expect(mocks.acl).toHaveBeenCalledWith(expect.stringMatching(/^flow:/))
})

it("passes frozen role limits and strict single attempt model choice to real runtime adapter", async () => {
  const step: FlowStep = {
    id: "review",
    name: "Review",
    kind: "agent",
    enabled: true,
    agentType: "review",
    prompt: "review",
    modelId: "custom:test"
  }
  const f = fixture([step])
  f.run.taskGoal = "Review this chat's order export changes"
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(await execution.execute(step, f.context)).toMatchObject({
    passed: true,
    source: "agent",
    outputTokens: 3
  })
  expect(mocks.runner.mock.calls[0][1]).toMatchObject({
    prompt: expect.stringContaining("Review this chat's order export changes"),
    singleAttempt: true,
    strictModel: true,
    model: "custom:test",
    shellAccess: "read_only"
  })
  expect(f.run.flow.definition.goal).toBe("Ship")
  expect(mocks.runner.mock.calls[0][1].prompt).not.toContain("Ship")
  expect(vi.mocked(f.functions.prepareFlowScope).mock.calls[0][4]).not.toBe("digest")
  expect(mocks.runtime.mock.calls[0][0]).toMatchObject({
    approvalThreadId: "thread",
    autoApproveFileEdits: false,
    managedExecution: true,
    filesystemAccess: { shellAccess: "read_only", disallowedTools: ["write_file"] }
  })
  expect(JSON.parse(mocks.threads.get("child")!.metadata)).toMatchObject({
    parentThreadId: "thread",
    workflowRunId: f.run.id,
    workspacePath: "workspace",
    isInternalFlowRuntime: true
  })
  await execution.dispose()
  expect(mocks.threads.has("child")).toBe(false)
})

it.each([{ agentType: "unknown" }, { modelId: "missing" }])(
  "rejects unknown frozen selection before any runtime executes: %j",
  async (selection) => {
    const f = fixture([
      { id: "a", name: "A", kind: "agent", enabled: true, prompt: "work", ...selection }
    ])
    await expect(f.host.prepare("workspace", "thread", f.run, f.context.signal)).rejects.toThrow()
    expect(mocks.runtime).not.toHaveBeenCalled()
  }
)

it("finalizes only selected checks and mandatory rules before confirmation", async () => {
  const steps: FlowStep[] = [
    { id: "unit", name: "Unit", enabled: true, kind: "check", check: "unit-test" },
    { id: "skip", name: "Skip", enabled: true, kind: "check", check: "code-review" },
    { id: "off", name: "Off", enabled: false, kind: "check", check: "e2e" }
  ]
  const f = fixture(steps)
  // A later writing agent invalidated the earlier PASS; it remains a required final check.
  f.run.attempts.push({
    stepId: "unit",
    executionId: "prior",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1,
    invalidated: true
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  const record = vi.fn()
  expect(
    await execution.finalize(
      f.context,
      async () => {
        f.calls.push("confirm")
      },
      record
    )
  ).toMatchObject({ passed: true })
  expect(record).toHaveBeenCalledWith(
    "Unit",
    expect.objectContaining({ passed: true }),
    "version:0"
  )
  expect(f.calls).toEqual(["unit-test", "application", "confirm"])
  expect(f.functions.advanceAutobizCheckpoint).not.toHaveBeenCalled()
  await execution.dispose()
})

it("rejects post-check mutation, absent gate and revocation without permitting fallback", async () => {
  const step: FlowStep = {
    id: "unit",
    name: "Unit",
    enabled: true,
    kind: "check",
    check: "unit-test"
  }
  const f = fixture([step])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await expect(execution.finalize(f.context, async () => f.change(), vi.fn())).rejects.toThrow(
    "FLOW_FINAL_EVIDENCE_STALE"
  )
  vi.mocked(f.functions.completionGate).mockResolvedValue(undefined)
  await expect(execution.execute(step, f.context)).rejects.toThrow("FLOW_CHECK_UNAVAILABLE")
  f.lifecycle.abort(Error("revoked"))
  expect(execution.signal?.aborted).toBe(true)
  await expect(execution.execute(step, f.context)).rejects.toThrow("revoked")
  await execution.dispose()
})

it("reruns final checks and confirms new results when an artifact changes during approval", async () => {
  const step: FlowStep = {
    id: "unit",
    name: "Unit",
    enabled: true,
    kind: "check",
    check: "unit-test"
  }
  const f = fixture([step])
  f.run.attempts.push({
    stepId: "unit",
    executionId: "prior",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  const confirm = vi.fn(async () => {
    if (confirm.mock.calls.length === 1) f.change()
  })
  const record = vi.fn()
  expect(await execution.finalize(f.context, confirm, record)).toMatchObject({ passed: true })
  expect(f.calls).toEqual(["unit-test", "application", "unit-test", "application"])
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(record).toHaveBeenCalledTimes(2)
  await execution.dispose()
})

it("commits one terminal stage only after all checks and approval", async () => {
  const f = fixture([{ id: "stage", name: "Stage", kind: "autobiz-stage", enabled: true }])
  f.run.flow.definition.feature = "feature"
  f.run.flow.definition.stageStart = "start"
  vi.mocked(f.functions.completionGate).mockImplementation(
    async (_workspace, _thread, _context, options) => async () => {
      f.calls.push(options?.stage ? "stage-check" : "application")
      if (options?.stage)
        options.evidence?.({
          phase: "validator.result",
          status: "pass",
          binding: { stateFingerprint: "fingerprint" },
          detail: {
            feature: "feature",
            attempt: "proof",
            stage: { start: "start", end: "end", alreadyAtTarget: false }
          }
        } as never)
      return { decision: "pass" }
    }
  )
  vi.mocked(f.functions.advanceAutobizCheckpoint).mockImplementation(
    async (_workspace, _thread, args) => {
      f.calls.push("commit")
      expect(args).toMatchObject({
        evidenceId: "proof",
        stateFingerprint: "fingerprint",
        from: "start",
        to: "end"
      })
      return { applied: true, duplicate: false }
    }
  )
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(f.run.flow.definition.steps[0], f.context)
  expect(f.functions.advanceAutobizCheckpoint).not.toHaveBeenCalled()
  const confirm = vi.fn(async () => {
    f.calls.push("confirm")
    if (confirm.mock.calls.length === 1) f.change()
  })
  expect(await execution.finalize(f.context, confirm, vi.fn())).toMatchObject({ passed: true })
  expect(f.calls).toEqual([
    "application",
    "stage-check",
    "confirm",
    "application",
    "stage-check",
    "confirm",
    "commit"
  ])
  expect(f.functions.advanceAutobizCheckpoint).toHaveBeenCalledTimes(1)
  await execution.dispose()
})

it("a real host refusal callback aborts the node before a model business result can be accepted", async () => {
  const f = fixture([{ id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }])
  mocks.runtime.mockImplementation(async (options) => {
    options.onToolRejected("approval-rejected")
    return { stream: vi.fn() }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await expect(execution.execute(f.run.flow.definition.steps[0], f.context)).rejects.toThrow(
    "FLOW_TOOL_REJECTED"
  )
  expect(execution.signal?.aborted).toBe(true)
  await execution.dispose()
})

it("aggregates child cleanup failure while still cleaning other children and parent resources", async () => {
  const f = fixture([{ id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }])
  mocks.runner.mockImplementation(async (deps, request) => {
    for (const childId of ["child", "child-two"])
      await deps.createRuntime({
        threadId: childId,
        agentId: childId,
        modelId: request.model,
        extraSystemPrompt: "",
        abortSignal: request.signal
      })
    return { structured: { passed: true, summary: "done" } }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(f.run.flow.definition.steps[0], f.context)
  mocks.checkpointer.mockImplementation(async (childId) => {
    if (childId === "child") throw Error("injected checkpoint close failure")
  })
  await expect(execution.dispose()).rejects.toBeInstanceOf(AggregateError)
  expect(mocks.cleanup).toHaveBeenCalledWith("child")
  expect(mocks.acl).toHaveBeenCalledWith("child")
  expect(mocks.checkpointer).toHaveBeenCalledWith("child-two")
  expect(mocks.threads.has("child-two")).toBe(false)
  expect(mocks.threads.has("child")).toBe(true)
  expect(mocks.cleanup).toHaveBeenCalledWith("thread")
  expect(mocks.acl).toHaveBeenCalledWith(expect.stringMatching(/^flow:/))
  expect(f.released).toHaveBeenCalled()
})

it("never closes or deletes a replacement child incarnation during cleanup", async () => {
  const f = fixture([{ id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(f.run.flow.definition.steps[0], f.context)
  const replacement = {
    metadata: JSON.stringify({
      ...JSON.parse(mocks.threads.get("child")!.metadata),
      cmb_thread_incarnation: "replacement"
    })
  }
  mocks.threads.set("child", replacement)
  await expect(execution.dispose()).rejects.toBeInstanceOf(AggregateError)
  expect(f.manager.closeFunctionThread).not.toHaveBeenCalledWith("child")
  expect(mocks.cleanup).not.toHaveBeenCalledWith("child")
  expect(mocks.acl).not.toHaveBeenCalledWith("child")
  expect(mocks.checkpointer).not.toHaveBeenCalledWith("child")
  expect(mocks.deleteCheckpoint).not.toHaveBeenCalledWith("child")
  expect(mocks.threads.get("child")).toBe(replacement)
  expect(mocks.cleanup).toHaveBeenCalledWith("thread")
  expect(mocks.acl).toHaveBeenCalledWith(expect.stringMatching(/^flow:/))
})

it("binds explicit model roles and keeps a credential-free fingerprint plan", async () => {
  const step: FlowStep = {
    id: "agent",
    name: "Review",
    kind: "agent",
    enabled: true,
    prompt: "review",
    modelRole: "reviewer"
  }
  const f = fixture([step])
  vi.mocked(f.functions.clawSelection).mockReturnValue({
    id: "claw",
    name: "Claw",
    capabilities: [],
    models: { default: "custom:primary", roles: { reviewer: "custom:review" } }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(execution.plan?.models.agent).toEqual({
    ref: "custom:review",
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
  })
  expect(JSON.stringify(execution.plan)).not.toContain("apiKey")
  expect(await execution.execute(step, f.context)).toMatchObject({ modelId: "custom:review" })
  expect(mocks.runner).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ model: "custom:review", strictModel: true })
  )
  await execution.dispose()
})

it("rejects model configuration changes while allowing host credential rotation", async () => {
  const f = fixture([
    {
      id: "agent",
      name: "Agent",
      kind: "agent",
      enabled: true,
      prompt: "work",
      modelId: "custom:fixed"
    }
  ])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  mocks.modelOverrides.set("custom:fixed", { apiKey: "rotated-secret" })
  expect(() => execution.assertLive()).not.toThrow()
  mocks.modelOverrides.set("custom:fixed", { baseUrl: "https://different.invalid" })
  expect(() => execution.assertLive()).toThrow("FLOW_MODEL_CHANGED")
  await expect(execution.execute(f.run.flow.definition.steps[0], f.context)).rejects.toThrow(
    "FLOW_MODEL_CHANGED"
  )
  expect(mocks.runner).not.toHaveBeenCalled()
  await execution.dispose()
})

it("requires an available model role instead of falling back to default", async () => {
  const f = fixture([
    {
      id: "agent",
      name: "Agent",
      kind: "agent",
      enabled: true,
      prompt: "work",
      modelRole: "missing"
    }
  ])
  await expect(f.host.prepare("workspace", "thread", f.run, f.context.signal)).rejects.toThrow(
    "FLOW_MODEL_ROLE_UNAVAILABLE"
  )
  expect(mocks.runner).not.toHaveBeenCalled()
})

it("pins Claw model policy even for an action-only flow", async () => {
  const step: FlowStep = {
    id: "action",
    name: "A",
    enabled: true,
    kind: "plugin-action",
    pluginId: "a",
    plugin: "a",
    digest: "a".repeat(64),
    actionId: "run",
    input: {}
  }
  const f = fixture([step])
  vi.mocked(f.functions.clawSelection).mockReturnValue({
    id: "claw",
    name: "Claw",
    capabilities: [],
    models: { default: "custom:primary", roles: { reviewer: "custom:review" } }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(execution.plan?.modelPolicy).toHaveProperty("custom:review")
  mocks.modelOverrides.set("custom:review", { model: "changed" })
  await expect(execution.execute(step, f.context)).rejects.toThrow("FLOW_MODEL_CHANGED")
  expect(f.functions.runAction).not.toHaveBeenCalled()
  await execution.dispose()
})

it("pins the implicit default pointer and permits model-free flows without credentials", async () => {
  const f = fixture([
    { id: "approval", name: "Approve", kind: "approval", enabled: true, prompt: "Confirm" }
  ])
  vi.mocked(f.functions.clawSelection).mockReturnValue({
    id: "claw",
    name: "Claw",
    capabilities: [],
    models: { roles: {} }
  })
  mocks.defaultRef = null
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(execution.plan?.defaultModelRef).toBeNull()
  expect(() => execution.assertLive()).not.toThrow()
  mocks.defaultRef = "custom:new-default"
  expect(() => execution.assertLive()).toThrow("FLOW_DEFAULT_MODEL_CHANGED")
  await execution.dispose()
})

it("rejects changing default selection even when the original model configuration still exists", async () => {
  const f = fixture([
    { id: "approval", name: "Approve", kind: "approval", enabled: true, prompt: "Confirm" }
  ])
  vi.mocked(f.functions.clawSelection).mockReturnValue({
    id: "claw",
    name: "Claw",
    capabilities: [],
    models: { roles: {} }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  mocks.defaultRef = "custom:other"
  expect(() => execution.assertLive()).toThrow("FLOW_DEFAULT_MODEL_CHANGED")
  await execution.dispose()
})

it("executes pinned independent actions under native authority and passes only valid outputs", async () => {
  const first: FlowStep = {
    id: "first",
    name: "A",
    enabled: true,
    kind: "plugin-action",
    pluginId: "a",
    plugin: "a",
    digest: "a".repeat(64),
    actionId: "run",
    input: { file: "orders.ts" }
  }
  const second: FlowStep = {
    ...first,
    id: "second",
    name: "B",
    pluginId: "b",
    plugin: "b",
    digest: "b".repeat(64),
    input: {},
    inputFrom: { stepId: "first" }
  }
  const f = fixture([first, second])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(f.functions.prepareAction).toHaveBeenCalledTimes(2)
  const result = await execution.execute(first, f.context)
  expect(result).toMatchObject({
    source: "plugin-action",
    provider: { plugin: "a" },
    output: { file: "orders.ts" }
  })
  f.run.attempts.push({
    executionId: "previous",
    stepId: "first",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1,
    result
  })
  expect(await execution.execute(second, f.context)).toMatchObject({
    provider: { plugin: "b" },
    output: { file: "orders.ts" }
  })
  f.run.attempts[0].invalidated = true
  await expect(execution.execute(second, f.context)).rejects.toThrow("CLAW_ACTION_OUTPUT_MISSING")
  expect(f.functions.runAction).toHaveBeenCalledTimes(2)
  await execution.dispose()
})

it("passes host-projected review and test results to an independent reporting action", async () => {
  const review: FlowStep = {
    id: "review",
    name: "Review",
    enabled: true,
    kind: "agent",
    prompt: "review"
  }
  const report: FlowStep = {
    id: "report",
    name: "Report",
    enabled: true,
    kind: "plugin-action",
    pluginId: "report",
    plugin: "report",
    digest: "b".repeat(64),
    actionId: "report",
    input: { text: "caller cannot replace host evidence" },
    evidenceInput: { field: "text" }
  }
  const f = fixture([review, report])
  f.run.attempts.push({
    executionId: "review-execution",
    stepId: "review",
    attempt: 1,
    epoch: 0,
    startedAt: 1,
    status: "passed",
    result: { passed: true, summary: "Actual review", source: "agent" }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(report, f.context)
  const input = vi.mocked(f.functions.runAction).mock.calls[0][3].input
  const evidence = JSON.parse(String(input.text))
  expect(evidence.nativeProjectTests).toBe("not-run")
  expect(evidence.results).toEqual([
    expect.objectContaining({ stepId: "review", summary: "Actual review" })
  ])
  expect(input.text).not.toContain("caller cannot replace")
  await execution.dispose()
})

it("rechecks identity after an awaited cleanup before touching the replacement's remaining resources", async () => {
  const f = fixture([{ id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }])
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(f.run.flow.definition.steps[0], f.context)
  mocks.cleanup.mockImplementation(async (childId) => {
    if (childId === "child")
      mocks.threads.set("child", {
        metadata: JSON.stringify({
          ...JSON.parse(mocks.threads.get("child")!.metadata),
          cmb_thread_incarnation: "replacement"
        })
      })
  })
  await expect(execution.dispose()).rejects.toBeInstanceOf(AggregateError)
  expect(mocks.acl).not.toHaveBeenCalledWith("child")
  expect(mocks.checkpointer).not.toHaveBeenCalledWith("child")
  expect(mocks.deleteCheckpoint).not.toHaveBeenCalledWith("child")
  expect(mocks.threads.has("child")).toBe(true)
  expect(mocks.acl).toHaveBeenCalledWith(expect.stringMatching(/^flow:/))
})

it.each([false, true])(
  "rejects invalid config during preparation with inputFrom=%s",
  async (fromPrevious) => {
    const step: Extract<FlowStep, { kind: "plugin-action" }> = {
      id: "action",
      name: "Action",
      enabled: true,
      kind: "plugin-action",
      pluginId: "a",
      plugin: "a",
      digest: "a".repeat(64),
      actionId: "run",
      input: {},
      ...(fromPrevious ? { inputFrom: { stepId: "previous" } } : {})
    }
    const f = fixture([step])
    vi.mocked(f.functions.prepareAction).mockResolvedValue({
      action: {
        ...step,
        command: "run",
        inputSchema: {},
        configSchema: {
          type: "object",
          properties: { model: { type: "string" } },
          required: ["model"]
        }
      },
      command: {} as never
    })
    await expect(
      f.host.prepare("workspace", "thread", f.run, f.context.signal)
    ).rejects.toMatchObject({ code: "CLAW_ACTION_CONFIG_INVALID" })
    expect(f.functions.runAction).not.toHaveBeenCalled()
    expect(mocks.runner).not.toHaveBeenCalled()
  }
)

it("defers inherited input requirements while accepting fully valid static config", async () => {
  const step: Extract<FlowStep, { kind: "plugin-action" }> = {
    id: "action",
    name: "Action",
    enabled: true,
    kind: "plugin-action",
    pluginId: "a",
    plugin: "a",
    digest: "a".repeat(64),
    actionId: "run",
    input: {},
    inputFrom: { stepId: "previous" },
    config: { model: "custom:review" }
  }
  const f = fixture([step])
  vi.mocked(f.functions.prepareAction).mockResolvedValue({
    action: {
      ...step,
      command: "run",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      configSchema: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"]
      }
    },
    command: {} as never
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(f.functions.runAction).not.toHaveBeenCalled()
  await execution.dispose()
})

function useHostDefinition(f: ReturnType<typeof fixture>) {
  const { plugin, ...definition } = f.run.flow.definition
  expect(plugin).toBe("demo")
  f.run.flow.definition = { ...definition, schemaVersion: 2, execution: { kind: "host" } }
}

it("prepares an owner-free host Flow and binds its real runtime authority", async () => {
  const f = fixture([{ id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }])
  useHostDefinition(f)
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  expect(f.functions.prepareFlowScope).toHaveBeenCalledWith(
    "workspace",
    "thread",
    undefined,
    "flow_test",
    "digest",
    f.context.signal
  )
  expect(f.manager.createHostFlowAuthority).toHaveBeenCalledWith(
    expect.objectContaining({
      workspace: "workspace",
      threadId: "thread",
      runId: "flow_test",
      runtimeAuthority: f.authority
    })
  )
  expect(await execution.execute(f.run.flow.definition.steps[0], f.context)).toMatchObject({
    passed: true
  })
  await execution.dispose()
})

it("records real host check receipts and repeats selected checks before mandatory rules and final confirmation", async () => {
  const step: FlowStep = {
    id: "test",
    name: "Tests",
    kind: "check",
    check: "unit-test",
    enabled: true
  }
  const f = fixture([step])
  useHostDefinition(f)
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  const result = await execution.execute(step, f.context)
  expect(result).toMatchObject({
    passed: true,
    source: "native-check",
    check: "unit-test",
    evidenceIds: [expect.any(String)]
  })
  f.run.attempts.push({
    executionId: "e1",
    stepId: "test",
    attempt: 1,
    epoch: 0,
    status: "passed",
    startedAt: 1,
    result
  })
  const confirm = vi.fn(async () => {})
  expect(await execution.finalize(f.context, confirm, vi.fn())).toMatchObject({ passed: true })
  expect(f.manager.runHostFlowProjectCheck).toHaveBeenCalledTimes(2)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(f.calls).toEqual(["application"])
  expect(f.manager.store.saveCompletionEvidence).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: "validator.result",
      status: "pass",
      binding: expect.objectContaining({ runId: "flow_test" }),
      detail: expect.objectContaining({
        executionId: "receipt",
        exitCode: 0,
        outputFingerprint: "output-digest"
      })
    })
  )
  expect(f.functions.completionGate).toHaveBeenCalledWith(
    "workspace",
    "thread",
    expect.any(Function),
    expect.not.objectContaining({ temporaryPolicy: expect.anything() })
  )
  await execution.dispose()
})

it.each(["missing-receipt", "changed-artifact"])(
  "rejects host check %s without persisting PASS",
  async (failure) => {
    const step: FlowStep = { id: "test", name: "Tests", kind: "check", check: "e2e", enabled: true }
    const f = fixture([step])
    useHostDefinition(f)
    vi.mocked(f.manager.runHostFlowProjectCheck).mockImplementation(async () => {
      if (failure === "changed-artifact") f.change()
      return {
        kind: "e2e",
        passed: true,
        executionId: failure === "missing-receipt" ? undefined : "receipt",
        exitCode: 0,
        output: "passed",
        outputFingerprint: "digest"
      }
    })
    const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
    await expect(execution.execute(step, f.context)).rejects.toThrow(
      failure === "missing-receipt"
        ? "MODS_PROJECT_CHECK_RECEIPT_REQUIRED"
        : "COMPLETION_EVIDENCE_STALE"
    )
    expect(f.manager.store.saveCompletionEvidence).not.toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "check.result",
        status: "pass"
      })
    )
    await execution.dispose()
  }
)

it("does not skip selected plugin mandatory rejection in a host Flow", async () => {
  const f = fixture([
    { id: "approve", name: "Approve", kind: "approval", enabled: true, prompt: "Approve" }
  ])
  useHostDefinition(f)
  vi.mocked(f.functions.completionGate).mockResolvedValue(async () => ({
    decision: "block",
    reason: "mandatory"
  }))
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  const confirm = vi.fn(async () => {})
  expect(await execution.finalize(f.context, confirm, vi.fn())).toMatchObject({
    passed: false,
    summary: "mandatory"
  })
  expect(confirm).not.toHaveBeenCalled()
  await execution.dispose()
})

it("passes only the host principal to native MCP in schema v2", async () => {
  const step: FlowStep = {
    id: "mcp",
    name: "MCP",
    enabled: true,
    kind: "mcp-tool",
    provider: { id: "provider", name: "Provider", digest: "a".repeat(64) },
    toolName: "echo",
    schemaDigest: "b".repeat(64),
    input: { text: "hello" }
  }
  const f = fixture([step])
  useHostDefinition(f)
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  const options = mocks.prepareMcp.mock.calls[0][0]
  expect(options).not.toHaveProperty("withOwnerGrant")
  expect(options.hostAuthority()).toMatchObject({
    kind: "host-flow",
    runtimeAuthority: f.authority
  })
  expect(await execution.execute(step, f.context)).toMatchObject({
    passed: true,
    source: "mcp-tool"
  })
  await execution.dispose()
})

it("preserves Harness context in host children without overriding readonly restrictions", async () => {
  const step: FlowStep = {
    id: "review",
    name: "Review",
    kind: "agent",
    enabled: true,
    prompt: "review",
    agentType: "review"
  }
  const f = fixture([step])
  useHostDefinition(f)
  mocks.threads.set("thread", {
    metadata: JSON.stringify({
      workspacePath: "workspace",
      agentMode: "normal",
      harnessFeature: { projectId: "project", slug: "feature" }
    })
  })
  mocks.harnessContext.mockResolvedValue({
    pluginId: "legacy",
    pluginRoot: "plugin",
    harnessProjectId: "project",
    featureId: "feature",
    systemPromptInject: "project rules",
    enableAgentsPrompt: true,
    agentConfig: { toolConfig: { requestUserInput: { allowAutoResolution: false } } }
  })
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  await execution.execute(step, f.context)
  expect(mocks.runtime).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "legacy",
      pluginPromptInject: "project rules",
      featureId: "feature",
      harnessProjectId: "project",
      enableAgentsPrompt: false,
      managedExecution: true,
      disableSubagents: true,
      filesystemAccess: expect.objectContaining({ shellAccess: "read_only" }),
      modTurnRunId: "flow_test:e1"
    })
  )
  expect(JSON.parse(mocks.threads.get("child")!.metadata).harnessFeature).toEqual({
    projectId: "project",
    slug: "feature"
  })
  await execution.dispose()
})

it("admits a real NativeFlowHost child under opaque legacy ownership and revokes its model fence on disposal", async () => {
  const step: FlowStep = { id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: "work" }
  const f = fixture([step])
  useHostDefinition(f)
  mocks.threads.set("thread", { metadata: JSON.stringify({ workspacePath: "workspace", agentMode: "normal",
    harnessFeature: { projectId: "project", slug: "feature" } }) })
  mocks.harnessContext.mockResolvedValue({ pluginId: "legacy", pluginRoot: "pinned", harnessProjectId: "project",
    featureId: "feature", enableAgentsPrompt: true })
  const token = issueRuntimePluginSourceToken({ mode: "legacy", threadId: "thread", incarnationKey: "parent",
    projectId: "project", featureId: "feature", operationId: "operation", workspace: "workspace",
    packageDigest: "a".repeat(64), stageId: "legacy-owned",
    plugin: { id: "legacy", path: "pinned", enabled: true } as PluginMetadata })
  await withRuntimePluginSource(token, async () => {
    expect(() => captureRuntimePluginSourceThreadGuard("child", "workspace")).toThrow("ADMISSION_REQUIRED")
    const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
    await execution.execute(step, f.context)
    const boundary = mocks.runtime.mock.calls.at(-1)![0].onModelBoundary
    expect(() => boundary()).not.toThrow()
    const row = mocks.threads.get("child")!
    const original = row.metadata
    row.metadata = JSON.stringify({ ...JSON.parse(original), cmb_thread_incarnation: "replacement" })
    expect(() => boundary()).toThrow("FLOW_CHILD_ID_CHANGED")
    row.metadata = original
    await execution.dispose()
    expect(() => boundary()).toThrow("LEGACY_CHILD_ADMISSION_REVOKED")
  })
})

it.each(["block", "continue"])(
  "parent Stop %s fails before native final checks without implicit retry",
  async (mode) => {
    const f = fixture([])
    useHostDefinition(f)
    mocks.legacyHook.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...(mode === "block"
        ? { blocked: true }
        : { stopFeedbackContinuation: true, additionalContext: "continue" })
    })
    const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
    const confirm = vi.fn()
    await expect(execution.finalize(f.context, confirm, vi.fn())).rejects.toThrow(
      "FLOW_STOP_COMPLETION_BLOCKED"
    )
    await expect(execution.finalize(f.context, confirm, vi.fn())).rejects.toThrow(
      "FLOW_STOP_COMPLETION_BLOCKED"
    )
    expect(mocks.legacyHook.mock.calls.filter((call) => call[1] === "Stop")).toHaveLength(1)
    expect(f.functions.completionGate).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    await execution.dispose()
  }
)

async function promptFixture() {
  const f = fixture([
    { id: "write", name: "Write", enabled: true, kind: "agent", prompt: "draft text" }
  ])
  const { FlowStore } = await import("./store")
  const settings = new Map<string, string>()
  Object.assign(f.manager, { workspaceKey: (value: string) => value })
  Object.assign(f.manager.store, {
    getSetting: (key: string, fallback: string) => settings.get(key) ?? fallback,
    setSetting: (key: string, value: string) => settings.set(key, value)
  })
  const store = new FlowStore(f.manager.store)
  f.run.flow = store.save(
    "workspace",
    {
      id: "prompt-flow",
      name: "Prompt flow",
      goal: "Ship",
      timeoutMs: 10000,
      maxExecutions: 32,
      steps: f.run.flow.definition.steps,
      schemaVersion: 2,
      execution: { kind: "host", profile: "prompt-only-v1" }
    },
    0
  )
  mocks.threads.set("thread", {
    metadata: JSON.stringify({
      workspacePath: "workspace",
      agentMode: "normal",
      cmb_thread_incarnation: "parent-inc"
    })
  })
  const assertPolicy = vi.fn()
  Object.assign(f.functions, {
    capturePromptOnlyBoundary: vi.fn(() => ({
      policyDigest: "b".repeat(64),
      assertCurrent: assertPolicy
    }))
  })
  const scope = await f.functions.prepareFlowScope(
    "workspace",
    "thread",
    undefined,
    f.run.id,
    f.run.flow.digest,
    f.context.signal
  )
  vi.mocked(f.functions.prepareFlowScope).mockClear()
  Object.assign(f.functions, { preparePromptOnlyFlowScope: vi.fn(() => scope) })
  const { describeFlowPromptRuntime, flowPromptDigest } =
    await import("../../agent/flow-prompt-runtime-contract")
  const dispose = vi.fn()
  let onSeal = () => {}
  let implementation: import("../../agent/flow-prompt-runtime-contract").FlowPromptRuntimeReader
  mocks.runner.mockImplementation(async (deps, request) => {
    const invocation = Object.freeze({})
    expect(mocks.promptProof.getMockImplementation()).toBeDefined()
    const runtime = await deps.createRuntime({
      threadId: "child",
      agentId: "physical-child",
      modelId: request.model,
      abortSignal: request.signal,
      extraSystemPrompt: "",
      additionalTools: [],
      flowPromptOnly: {
        ...request.flowPromptOnly,
        invocation,
        expectedModelRef: request.model,
        rolePrompt: request.roleSystemPrompt ?? ""
      }
    })
    const runtimeOptions = mocks.runtime.mock.calls.at(-1)![0]
    const descriptor = describeFlowPromptRuntime({
      model: { ref: request.model, apiKey: "test" } as never,
      rolePrompt: request.roleSystemPrompt ?? "",
      mandatoryPolicyDigest: request.flowPromptOnly.mandatoryPolicyDigest
    })
    implementation = {
      assertCurrent: runtimeOptions.flowPromptOnly.assertCurrent,
      dispose,
      seal: async () => {
        onSeal()
        runtimeOptions.flowPromptOnly.assertCurrent()
        return {
          ...descriptor,
          businessInputDigest: flowPromptDigest(request.prompt),
          modelRequestLedgerDigest: "c".repeat(64),
          invocationLedgerDigest: "d".repeat(64),
          structuredOutputDigest: flowPromptDigest(
            JSON.stringify({ passed: true, summary: "reviewed" })
          ),
          modelCalls: 1,
          providerUsageEvidenceIds: []
        }
      }
    }
    // createRuntime needs the reader before returning; the delegating reader below is installed first.
    try {
      await runtime.completeTurn?.({ structured: { passed: true, summary: "reviewed" } })
    } finally {
      await deps.cleanupThread("child")
    }
    return { structured: { passed: true, summary: "reviewed" }, outputTokens: 3 }
  })
  // The runtime itself is mocked in this host-adapter test. Its private origin is tested separately.
  mocks.promptProof.mockImplementation(() => ({
    assertCurrent: () => implementation.assertCurrent(),
    dispose: () => implementation.dispose(),
    seal: () => implementation.seal()
  }))
  f.run.attempts = [
    {
      executionId: "e1",
      stepId: "write",
      epoch: 0,
      attempt: 1,
      status: "running",
      startedAt: Date.now(),
      inputFingerprint: "before"
    }
  ]
  f.run.startedAt = Date.now()
  return {
    ...f,
    store,
    settings,
    assertPolicy,
    dispose,
    onSeal: (callback: () => void) => {
      onSeal = callback
    },
    restoreProof: () => {}
  }
}

it("uses a closed text child without optional skill lifecycle or ordinary plugin scope", async () => {
  const f = await promptFixture()
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  try {
    const result = await execution.execute(f.run.flow.definition.steps[0], f.context)
    expect(result).toMatchObject({ passed: true, summary: "reviewed" })
    expect(f.functions.prepareFlowScope).not.toHaveBeenCalled()
    expect(mocks.legacyHook).not.toHaveBeenCalled()
    expect(mocks.threads.has("child")).toBe(false)
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(execution.promptRecovery?.settledCapture("e1")).toMatchObject({
      binding: { runId: f.run.id, executionId: "e1", parentThreadIncarnation: "parent-inc" },
      dependencies: { coverage: "prompt-and-prior-receipts" },
      modelCalls: 1
    })
  } finally {
    await execution.dispose()
    f.restoreProof()
  }
})

it("does not publish a settled capture when child cleanup fails", async () => {
  const f = await promptFixture()
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  mocks.cleanup.mockRejectedValueOnce(Error("cleanup-failed"))
  try {
    await expect(execution.execute(f.run.flow.definition.steps[0], f.context)).rejects.toThrow(
      "FLOW_CLEANUP_FAILED"
    )
    expect(execution.promptRecovery?.settledCapture("e1")).toBeUndefined()
  } finally {
    await execution.dispose()
    f.restoreProof()
  }
})

it("rejects unproved policies before preparing a scope or child", async () => {
  for (const event of ["UserPromptSubmit", "PreToolUse", "SessionStart"]) {
    const f = await promptFixture()
    mocks.hooks = [{ event }]
    try {
      await expect(f.host.prepare("workspace", "thread", f.run, f.context.signal)).rejects.toThrow(
        "FLOW_PROMPT_LEGACY_POLICY_UNVERIFIED"
      )
      expect(f.functions.preparePromptOnlyFlowScope).not.toHaveBeenCalled()
      expect(mocks.runtime).not.toHaveBeenCalled()
    } finally {
      f.restoreProof()
    }
  }
})

it("rechecks text receipts without creating a runtime, scope, or child", async () => {
  const f = await promptFixture()
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  try {
    const result = await execution.execute(f.run.flow.definition.steps[0], f.context)
    const attempt = f.run.attempts[0]
    Object.assign(attempt, {
      result,
      status: "passed",
      finishedAt: Date.now(),
      outputFingerprint: "original-output"
    })
    const { bindFlowPromptReceipt } = await import("./prompt-recovery-receipt")
    attempt.recoveryEvidence = bindFlowPromptReceipt({
      run: f.run,
      attempt,
      capture: execution.promptRecovery!.settledCapture("e1")!,
      parentThreadIncarnation: "parent-inc",
      priorReceipts: []
    })
    f.store.put(f.run)
    vi.mocked(f.functions.preparePromptOnlyFlowScope).mockClear()
    mocks.runtime.mockClear()
    const before = JSON.stringify(f.store.runs("workspace", "thread"))
    const observed = await f.host.observeRecovery(f.run)
    expect(observed).toMatchObject({
      authority: "current",
      promptReceipts: { verifiedExecutionIds: ["e1"] }
    })
    expect(JSON.stringify(f.store.runs("workspace", "thread"))).toBe(before)
    expect(f.functions.preparePromptOnlyFlowScope).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.threads.size).toBe(1)
    mocks.modelOverrides.set("custom:default", { temperature: 0.9 })
    expect((await f.host.observeRecovery(f.run)).authority).toBe("unverified")
  } finally {
    await execution.dispose()
    f.restoreProof()
  }
})

it("rechecks native completion rules and explicit confirmation for the text profile", async () => {
  const f = await promptFixture()
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  try {
    const confirm = vi.fn(async () => {})
    const result = await execution.finalize(f.context, confirm, vi.fn())
    expect(result.passed).toBe(true)
    expect(f.calls).toContain("application")
    expect(confirm).toHaveBeenCalledOnce()
  } finally {
    await execution.dispose()
    f.restoreProof()
  }
})

it("rejects a policy change at seal and publishes no evidence", async () => {
  const f = await promptFixture()
  const execution = await f.host.prepare("workspace", "thread", f.run, f.context.signal)
  f.onSeal(() =>
    f.assertPolicy.mockImplementation(() => {
      throw Error("policy-revoked")
    })
  )
  try {
    await expect(execution.execute(f.run.flow.definition.steps[0], f.context)).rejects.toThrow(
      "policy-revoked"
    )
    expect(f.manager.publish).not.toHaveBeenCalled()
  } finally {
    await execution.dispose()
    f.restoreProof()
  }
})

it("rejects dynamic function policy before any scope startup", async () => {
  const f = await promptFixture()
  vi.mocked(f.functions.capturePromptOnlyBoundary).mockImplementation(() => {
    throw Error("FLOW_PROMPT_DYNAMIC_POLICY_UNVERIFIED")
  })
  try {
    await expect(f.host.prepare("workspace", "thread", f.run, f.context.signal)).rejects.toThrow(
      "FLOW_PROMPT_DYNAMIC_POLICY_UNVERIFIED"
    )
    expect(f.functions.prepareFlowScope).not.toHaveBeenCalled()
    expect(f.functions.preparePromptOnlyFlowScope).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  } finally {
    f.restoreProof()
  }
})
