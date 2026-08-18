/**
 * Unit tests for trace and Skill usage telemetry.
 *
 * Run:
 *   npx tsx tests/trace-telemetry.spec.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { SkillUsageDetector } from "../src/main/agent/skill-evolution/usage-detector.ts"
import { observeSkillUsageFromStream } from "../src/main/agent/coordinator-worker-stream.ts"
import {
  TraceCollector,
  createTraceCollectorSafely,
  finishTraceInBackground,
  runTraceSideEffect,
  setTraceReporter
} from "../src/main/agent/trace/collector.ts"
import { buildTraceTree } from "../src/main/agent/trace/tree-builder.ts"
import type { AgentTrace, ITraceReporter } from "../src/main/agent/trace/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertArrayEqual(actual: string[], expected: string[], message: string): void {
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

function makeLongText(
  prefix: string,
  middle: string,
  suffix: string,
  middleLength: number
): string {
  return `${prefix}${middle.repeat(middleLength)}${suffix}`
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for async trace reporter")
}

function restoreTraceEnv(previousTracesDir: string | undefined): void {
  if (previousTracesDir === undefined) {
    delete process.env.CMB_COWORK_TRACES_DIR
  } else {
    process.env.CMB_COWORK_TRACES_DIR = previousTracesDir
  }
}

function testSkillUsageDetectorNormalizesVersions(): void {
  const detector = new SkillUsageDetector()
  detector.onSkillsMetadata([
    { name: "代码审查", path: "/repo/skills/code-review/SKILL.md" },
    { name: "接口设计", version: "2.3.4", path: "/repo/skills/api-design/SKILL.md" },
    {
      name: "斜杠技能",
      version: "3.1.4",
      path: "C:\\Users\\demo\\.cmbcoworkagent\\enabled-skills-custom\\slash-skill\\SKILL.md"
    }
  ])

  assert(
    detector.onReadFilePath("/repo/skills/code-review/SKILL.md"),
    "exact SKILL.md read should add a skill"
  )
  assert(
    detector.onReadFilePath("/repo/skills/api-design/references/spec.md"),
    "root child read should add a skill"
  )
  assert(
    detector.onReadFilePath("C:\\Users\\demo\\.cmbcoworkagent\\skills\\slash-skill\\SKILL.md"),
    "slash command original skill path should alias to enabled custom skill metadata"
  )
  assert(
    !detector.onReadFilePath("/repo/skills/code-review/SKILL.md"),
    "duplicate reads should not add again"
  )
  assertArrayEqual(
    detector.getUsedSkillNames(),
    ["代码审查-v1.0.0", "接口设计-v2.3.4", "斜杠技能-v3.1.4"],
    "Skill detector should emit versioned identifiers with default version fallback"
  )
}

function testStreamSkillUsageObservation(): void {
  const detector = new SkillUsageDetector()
  const skillPath = "/repo/skills/stream-skill/SKILL.md"
  const snapshot = {
    skillsMetadata: [{ name: "stream-skill", path: skillPath }],
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          tool_calls: [{ id: "read-skill", name: "read_file", args: { path: skillPath } }]
        }
      }
    ]
  }

  assert(
    observeSkillUsageFromStream("values", snapshot, detector),
    "values stream should report a newly observed Skill read"
  )
  assertArrayEqual(
    detector.getUsedSkillNames(),
    ["stream-skill-v1.0.0"],
    "values stream should attribute the read Skill"
  )
  assert(
    !observeSkillUsageFromStream("values", snapshot, detector),
    "replayed cumulative values snapshots should not report duplicate Skill changes"
  )
}

async function testTraceSidecarFailureIsolation(): Promise<void> {
  const originalWarn = console.warn
  let warningCount = 0
  console.warn = () => {
    warningCount += 1
  }

  try {
    const throwingOptions = new Proxy(
      {},
      {
        get: () => {
          throw new Error("injected trace creation failure")
        }
      }
    ) as Parameters<typeof createTraceCollectorSafely>[3]
    assert(
      createTraceCollectorSafely(
        "sidecar-create-thread",
        "test safe trace creation",
        "model-test",
        throwingOptions,
        "TraceTest"
      ) === undefined,
      "trace creation failure should disable telemetry instead of escaping"
    )

    const throwingDetector = {
      getUsedSkillNames: () => {
        throw new Error("injected Skill observer failure")
      }
    } as unknown as SkillUsageDetector
    assert(
      !observeSkillUsageFromStream("values", {}, throwingDetector),
      "Skill observer failure should be swallowed and reported as no attribution change"
    )

    let continuedAfterMutation = false
    runTraceSideEffect("TraceTest", () => {
      throw new Error("injected trace mutation failure")
    })
    continuedAfterMutation = true
    assert(continuedAfterMutation, "trace mutation failure should not stop the agent path")

    let finishStarted = false
    let resolveFinish!: (trace: AgentTrace) => void
    const pendingFinish = new Promise<AgentTrace>((resolve) => {
      resolveFinish = resolve
    })
    const pendingTracer = {
      finish: () => {
        finishStarted = true
        return pendingFinish
      }
    } as unknown as TraceCollector
    let beforeFinishRan = false
    finishTraceInBackground(pendingTracer, "success", undefined, "TraceTest", () => {
      beforeFinishRan = true
    })
    assert(
      !beforeFinishRan && !finishStarted,
      "background trace preparation and completion should not execute inline on the agent completion stack"
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert(
      beforeFinishRan,
      "background trace preparation should run on the scheduled event-loop turn"
    )
    assert(
      finishStarted,
      "background trace completion should start on the scheduled event-loop turn"
    )
    resolveFinish({} as AgentTrace)

    let finishAfterPrepareFailureStarted = false
    const prepareFailureTracer = {
      finish: async () => {
        finishAfterPrepareFailureStarted = true
        return {} as AgentTrace
      }
    } as unknown as TraceCollector
    finishTraceInBackground(prepareFailureTracer, "success", undefined, "TraceTest", () => {
      throw new Error("injected pre-finish trace preparation failure")
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert(
      finishAfterPrepareFailureStarted,
      "a failed background trace preparation should not prevent trace completion"
    )

    const throwingFinishTracer = {
      finish: () => {
        throw new Error("injected synchronous trace finish failure")
      }
    } as unknown as TraceCollector
    finishTraceInBackground(throwingFinishTracer, "error", "test", "TraceTest")
    await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    console.warn = originalWarn
  }

  assert(warningCount >= 4, "every isolated telemetry failure should be logged")
}

async function testSkillUsageDetectorReadsSkillMetadataDirectly(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "slash-skill-direct-"))
  const skillDir = join(rootDir, ".cmbcoworkagent", "skills", "elementui-page")
  const skillMdPath = join(skillDir, "SKILL.md")

  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      skillMdPath,
      [
        "---",
        "name: elementui-page",
        "description: Element UI page generator",
        "version: v1.0.3",
        "evolved-by: CMBDevClaw Trace Evolver",
        "---",
        "",
        "Use Element UI components."
      ].join("\n"),
      "utf8"
    )

    const detector = new SkillUsageDetector()
    detector.onSkillsMetadata([{ name: "elementui-page", path: skillMdPath }])
    assert(
      detector.onReadFilePath(skillMdPath),
      "SKILL.md read should resolve name/version even when preloaded metadata has no version"
    )
    assertArrayEqual(
      detector.getUsedSkillNames(),
      ["elementui-page-v1.0.3"],
      "direct slash command skill detection should preserve the SKILL.md version"
    )
    assertArrayEqual(
      detector.getUsedEvolvedSkillNames(),
      ["elementui-page-v1.0.3"],
      "direct slash command skill detection should report cloud-evolved skills"
    )
    assert(!detector.onReadFilePath(skillMdPath), "duplicate skill reads should not add again")

    const directDetector = new SkillUsageDetector()
    assert(
      directDetector.onReadFilePath(join(skillDir, "references", "usage.md")),
      "slash command child file reads should resolve name/version without preloaded metadata"
    )
    assertArrayEqual(
      directDetector.getUsedSkillNames(),
      ["elementui-page-v1.0.3"],
      "direct slash command skill detection should preserve the SKILL.md version"
    )
    assertArrayEqual(
      directDetector.getUsedEvolvedSkillNames(),
      ["elementui-page-v1.0.3"],
      "child file reads should preserve cloud-evolved skill attribution"
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

async function testTraceCollectorReportsVersionedSkills(): Promise<void> {
  const tracesDir = await mkdtemp(join(tmpdir(), "trace-telemetry-"))
  const previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  let reportedTrace: AgentTrace | undefined
  const reporter: ITraceReporter = {
    async report(trace) {
      reportedTrace = trace
    }
  }

  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  setTraceReporter(reporter)

  try {
    const tracer = new TraceCollector(
      "thread-telemetry-unit",
      "请使用测试 Skill 生成代码",
      "model-a",
      {
        triggerSource: "scheduler_action"
      }
    )
    tracer.setModelName("Model A")
    tracer.setUsedSkills(["unit-skill", "unit-skill-v1.0.0", "another-skill-2.3.4"])
    tracer.setEvolvedSkills(["unit-skill"])
    tracer.beginStep()
    tracer.recordToolCall({
      name: "read_file",
      args: { path: "/repo/skills/unit-skill/SKILL.md" },
      result: "ok",
      durationMs: 12
    })
    tracer.endStep("读取 Skill 后继续执行")

    const trace = await tracer.finish("success")
    await waitFor(() => reportedTrace !== undefined)

    assert(trace.threadId === "thread-telemetry-unit", "trace should keep thread id")
    assert(trace.modelId === "model-a", "trace should keep model id")
    assert(trace.modelName === "Model A", "trace should keep model name")
    assert(trace.totalToolCalls === 1, "trace should count tool calls")
    assertArrayEqual(
      trace.usedSkills,
      ["unit-skill-v1.0.0", "another-skill-v2.3.4"],
      "trace should dedupe and normalize usedSkills before reporting"
    )
    assertArrayEqual(
      trace.evolvedSkills,
      ["unit-skill-v1.0.0"],
      "trace should normalize evolvedSkills before reporting"
    )
    assert(trace.triggerSource === "scheduler_action", "trace should keep triggerSource")
    assertArrayEqual(
      reportedTrace?.usedSkills ?? [],
      trace.usedSkills,
      "async trace reporter should receive normalized usedSkills"
    )
    assertArrayEqual(
      reportedTrace?.evolvedSkills ?? [],
      trace.evolvedSkills,
      "async trace reporter should receive normalized evolvedSkills"
    )
    assert(
      reportedTrace?.triggerSource === "scheduler_action",
      "async trace reporter should receive triggerSource"
    )

    const file = join(tracesDir, trace.threadId, `${trace.traceId}.jsonl`)
    const persisted = JSON.parse((await readFile(file, "utf-8")).trim()) as AgentTrace
    assertArrayEqual(
      persisted.usedSkills,
      trace.usedSkills,
      "persisted trace should contain normalized usedSkills"
    )
    assertArrayEqual(
      persisted.evolvedSkills,
      trace.evolvedSkills,
      "persisted trace should contain normalized evolvedSkills"
    )
    assert(
      persisted.triggerSource === "scheduler_action",
      "persisted trace should contain triggerSource"
    )
  } finally {
    setTraceReporter({
      async report(trace) {
        void trace
      }
    })
    restoreTraceEnv(previousTracesDir)
    await rm(tracesDir, { recursive: true, force: true })
  }
}

async function testTraceCollectorObservabilityContext(): Promise<void> {
  const tracesDir = await mkdtemp(join(tmpdir(), "trace-observability-"))
  const previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  setTraceReporter({
    async report(trace) {
      void trace
    }
  })

  try {
    const harnessFeature = {
      projectId: "project-observability",
      slug: "feature-observability",
      nodeName: "Dev-代码实现",
      nodeStatus: "进行中"
    }
    const rootTracer = new TraceCollector("root-thread", "Run a workflow", "model-root", {
      harnessFeature
    })
    rootTracer.setExecutionMode("workflow")
    const rootContext = rootTracer.getTraceContext()
    const rootTrace = await rootTracer.finish("success")

    assert(rootTrace.traceKind === "root", "root trace should default to traceKind=root")
    assert(rootTrace.executionMode === "workflow", "setExecutionMode should update root trace")
    assert(
      rootTrace.rootTraceId === rootTrace.traceId,
      "root trace should point rootTraceId to itself"
    )
    assert(
      rootTrace.rootThreadId === rootTrace.threadId,
      "root trace should point rootThreadId to itself"
    )
    assert(
      rootContext.rootNodeId === `trace:${rootTrace.traceId}`,
      "root context should expose root node id"
    )
    assert(
      rootContext.harnessFeature?.projectId === harnessFeature.projectId &&
        rootContext.harnessFeature?.slug === harnessFeature.slug &&
        rootContext.harnessFeature?.nodeName === harnessFeature.nodeName &&
        rootContext.harnessFeature?.nodeStatus === harnessFeature.nodeStatus,
      "root trace context should expose the project-mode binding for child traces"
    )

    const childTracer = new TraceCollector(
      "worker-thread",
      "Implement worker task",
      "model-child",
      {
        traceKind: "subagent",
        executionMode: "coordinator",
        rootTraceId: rootContext.rootTraceId,
        rootThreadId: rootContext.rootThreadId,
        parentTraceId: rootContext.traceId,
        parentThreadId: rootContext.threadId,
        parentSpanId: rootContext.rootNodeId,
        linkType: "async_span_link",
        subagentKind: "coordinator_worker",
        subagentRunId: "worker-1:turn:1",
        subagentThreadId: "worker-thread",
        handoffAction: "start_worker",
        coordinatorWorkerId: "worker-1",
        coordinatorWorkerTurn: 1,
        coordinatorWorkerRole: "implementer",
        coordinatorWorkerWorkload: "write",
        harnessFeature: rootContext.harnessFeature,
        includeSkillEval: false
      }
    )
    const childTrace = await childTracer.finish("success")

    assert(childTrace.traceKind === "subagent", "child trace should keep traceKind=subagent")
    assert(childTrace.executionMode === "coordinator", "child trace should keep execution mode")
    assert(childTrace.rootTraceId === rootTrace.traceId, "child trace should link to root trace")
    assert(childTrace.rootThreadId === rootTrace.threadId, "child trace should link to root thread")
    assert(
      childTrace.parentTraceId === rootTrace.traceId,
      "child trace should link direct parent trace"
    )
    assert(
      childTrace.parentSpanId === rootContext.rootNodeId,
      "child trace should link parent span"
    )
    assert(childTrace.linkType === "async_span_link", "child trace should mark async link type")
    assert(
      childTrace.subagentKind === "coordinator_worker",
      "child trace should keep subagent kind"
    )
    assert(childTrace.coordinatorWorkerId === "worker-1", "child trace should keep worker id")
    assert(childTrace.coordinatorWorkerTurn === 1, "child trace should keep worker turn")
    assert(
      childTrace.harnessProjectId === harnessFeature.projectId &&
        childTrace.harnessFeatureSlug === harnessFeature.slug &&
        childTrace.harnessNodeName === harnessFeature.nodeName &&
        childTrace.harnessNodeStatus === harnessFeature.nodeStatus,
      "child trace should retain inherited project-mode attribution"
    )
    assert(
      childTrace.skillEval === undefined,
      "child trace should skip skill eval by default option"
    )
  } finally {
    restoreTraceEnv(previousTracesDir)
    await rm(tracesDir, { recursive: true, force: true })
  }
}

async function testTraceCollectorCountsSubagentMetadataTools(): Promise<void> {
  const tracesDir = await mkdtemp(join(tmpdir(), "trace-subagent-tools-"))
  const previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  setTraceReporter({
    async report(trace) {
      void trace
    }
  })

  try {
    const tracer = new TraceCollector("worker-thread", "Summarize worker", "model-child", {
      traceKind: "subagent",
      executionMode: "coordinator",
      rootTraceId: "root-trace",
      rootThreadId: "root-thread",
      parentTraceId: "root-trace",
      parentThreadId: "root-thread",
      linkType: "async_span_link",
      subagentKind: "coordinator_worker",
      includeSkillEval: false
    })
    tracer.addTerminalNode({
      type: "message",
      output: "Worker summary",
      metadata: {
        toolNames: ["read_file"],
        toolCallCount: 3
      }
    })
    const trace = await tracer.finish("success")
    const root = trace.nodes.find((node) => node.type === "trace")
    const rootOutput = root?.output as { totalToolCalls?: number } | undefined

    assert(
      trace.totalToolCalls === 3,
      "subagent metadata toolCallCount should count repeated tool calls"
    )
    assert(
      rootOutput?.totalToolCalls === 3,
      "root trace node output should expose inferred tool count"
    )
  } finally {
    restoreTraceEnv(previousTracesDir)
    await rm(tracesDir, { recursive: true, force: true })
  }
}

async function testTraceCollectorSanitizesLargeFields(): Promise<void> {
  const tracesDir = await mkdtemp(join(tmpdir(), "trace-sanitize-"))
  const previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  let reportedTrace: AgentTrace | undefined
  const reporter: ITraceReporter = {
    async report(trace) {
      reportedTrace = trace
    }
  }

  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  setTraceReporter(reporter)

  try {
    const userMessage = makeLongText("USER_HEAD_", "u", "_USER_TAIL", 3000)
    const toolResult = makeLongText("RESULT_HEAD_", "r", "_RESULT_TAIL", 5000)
    const inputMessages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: makeLongText(`MSG_${index}_HEAD_`, "m", `_MSG_${index}_TAIL`, 2500)
    }))

    const tracer = new TraceCollector("thread-sanitize-unit", userMessage, "model-b")
    tracer.beginStep()
    tracer.recordToolCall({
      name: "exec_command",
      args: {
        command: makeLongText("ARGS_HEAD_", "a", "_ARGS_TAIL", 4000),
        nested: { content: makeLongText("NESTED_HEAD_", "n", "_NESTED_TAIL", 4000) }
      },
      result: toolResult,
      durationMs: 42
    })
    tracer.endStep(makeLongText("ASSISTANT_HEAD_", "s", "_ASSISTANT_TAIL", 4000))
    tracer.recordModelCall({
      messageId: "ai-large",
      startedAt: new Date().toISOString(),
      inputMessages,
      outputMessage: {
        role: "assistant",
        content: makeLongText("OUTPUT_HEAD_", "o", "_OUTPUT_TAIL", 4000)
      },
      toolCalls: [
        {
          name: "exec_command",
          args: { command: makeLongText("MODEL_ARGS_HEAD_", "x", "_MODEL_ARGS_TAIL", 4000) },
          result: makeLongText("MODEL_RESULT_HEAD_", "y", "_MODEL_RESULT_TAIL", 4000)
        }
      ],
      tokenUsage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 }
    })
    tracer.addToolNode({
      name: "exec_command",
      input: { command: makeLongText("NODE_INPUT_HEAD_", "i", "_NODE_INPUT_TAIL", 4000) },
      metadata: { stdout: makeLongText("NODE_META_HEAD_", "z", "_NODE_META_TAIL", 4000) }
    })
    tracer.addToolResultNode({
      output: makeLongText("NODE_OUTPUT_HEAD_", "p", "_NODE_OUTPUT_TAIL", 4000)
    })

    const trace = await tracer.finish(
      "error",
      makeLongText("ERROR_HEAD_", "e", "_ERROR_TAIL", 4000)
    )
    await waitFor(() => reportedTrace !== undefined)

    assert(
      trace.userMessage === userMessage,
      "local trace returned from finish should keep full user message"
    )
    assert(
      !trace.userMessage.includes("trace truncated"),
      "local trace returned from finish should not be sanitized"
    )
    assert(
      trace.modelCalls?.[0]?.inputMessages.length === 12,
      "local trace should keep all LLM input messages"
    )
    assert(
      trace.modelCalls?.[0]?.inputMessages[11]?.content.includes("_MSG_11_TAIL"),
      "local trace should preserve full retained input messages"
    )
    assert(
      trace.steps[0]?.toolCalls[0]?.result?.includes("_RESULT_TAIL"),
      "local tool result should keep tail"
    )
    assert(
      JSON.stringify(trace.steps[0]?.toolCalls[0]?.args).includes("ARGS_HEAD_"),
      "local tool args should keep head"
    )
    assert(trace.errorMessage?.includes("_ERROR_TAIL"), "local error message should keep tail")
    assert(
      reportedTrace?.userMessage.includes("trace truncated"),
      "cloud reporter should receive sanitized user message"
    )
    assert(
      reportedTrace?.metadata?.traceTruncation &&
        typeof reportedTrace.metadata.traceTruncation === "object" &&
        (reportedTrace.metadata.traceTruncation as { truncated?: boolean }).truncated === true,
      "reported trace metadata should record truncation"
    )
    assert(JSON.stringify(reportedTrace).length < 96 * 1024, "reported trace should fit hard limit")
    assert(
      !trace.metadata?.traceTruncation,
      "local trace should not include cloud truncation metadata"
    )
    const file = join(tracesDir, trace.threadId, `${trace.traceId}.jsonl`)
    const persistedRaw = (await readFile(file, "utf-8")).trim()
    const persisted = JSON.parse(persistedRaw) as AgentTrace
    assert(
      persisted.userMessage === userMessage,
      "persisted local trace should keep full user message"
    )
    assert(
      !persistedRaw.includes("trace truncated"),
      "persisted local trace should not be sanitized"
    )
    assert(
      persisted.modelCalls?.[0]?.inputMessages.length === 12,
      "persisted local trace should keep all input messages"
    )
    assertArrayEqual(
      reportedTrace?.modelCalls?.[0]?.inputMessages.map((message) => message.role) ?? [],
      persisted.modelCalls?.[0]?.inputMessages.map((message) => message.role) ?? [],
      "reporter should retain the same message sequence as persisted trace"
    )
  } finally {
    setTraceReporter({
      async report(trace) {
        void trace
      }
    })
    restoreTraceEnv(previousTracesDir)
    await rm(tracesDir, { recursive: true, force: true })
  }
}

async function testTraceCollectorPreservesUnknownOutcomeNodes(): Promise<void> {
  const tracesDir = await mkdtemp(join(tmpdir(), "trace-unknown-"))
  const previousTracesDir = process.env.CMB_COWORK_TRACES_DIR

  process.env.CMB_COWORK_TRACES_DIR = tracesDir
  setTraceReporter({
    async report(trace) {
      void trace
    }
  })

  try {
    const tracer = new TraceCollector(
      "thread-unknown-unit",
      "Goal paused for user input",
      "model-unknown"
    )
    const llmNodeId = tracer.beginLlmNode({ name: "LLM Call", input: [] })
    const toolNodeId = tracer.addToolNode({
      name: "read_file",
      parentId: llmNodeId,
      input: { path: "README.md" }
    })

    const reason = "Goal paused: needs user input"
    const trace = await tracer.finish("unknown", reason)
    const nodes = trace.nodes ?? []
    const root = nodes.find((node) => node.type === "trace")
    const llmNode = nodes.find((node) => node.id === llmNodeId)
    const toolNode = nodes.find((node) => node.id === toolNodeId)
    const terminal = nodes.find(
      (node) => node.type === "message" && node.status === "unknown" && node.output === reason
    )

    assert(trace.outcome === "unknown", "trace outcome should stay unknown")
    assert(root?.status === "unknown", "root node should use unknown status")
    assert(llmNode?.status === "unknown", "unfinished LLM node should use unknown status")
    assert(toolNode?.status === "unknown", "unfinished tool node should use unknown status")
    assert(terminal !== undefined, "unknown trace should include an unknown terminal node")
    assert(terminal?.name === "Run Ended", "unknown terminal should not say completed")

    const file = join(tracesDir, trace.threadId, `${trace.traceId}.jsonl`)
    const persisted = JSON.parse((await readFile(file, "utf-8")).trim()) as AgentTrace
    const persistedRoot = persisted.nodes?.find((node) => node.type === "trace")
    const persistedTerminal = persisted.nodes?.find(
      (node) => node.type === "message" && node.status === "unknown" && node.output === reason
    )
    assert(persisted.outcome === "unknown", "persisted trace outcome should stay unknown")
    assert(persistedRoot?.status === "unknown", "persisted root node should use unknown status")
    assert(persistedTerminal !== undefined, "persisted trace should keep unknown terminal node")
    assert(
      persistedTerminal?.name === "Run Ended",
      "persisted unknown terminal should not say completed"
    )
  } finally {
    restoreTraceEnv(previousTracesDir)
    await rm(tracesDir, { recursive: true, force: true })
  }
}

function testTraceTreeBuilderPreservesUnknownOutcome(): void {
  const startedAt = "2026-05-23T12:00:00.000+08:00"
  const endedAt = "2026-05-23T12:00:05.000+08:00"
  const trace: AgentTrace = {
    traceId: "trace-unknown-builder",
    threadId: "thread-unknown-builder",
    startedAt,
    endedAt,
    durationMs: 5000,
    userMessage: "Continue the active goal",
    modelId: "model-unknown",
    steps: [
      {
        index: 0,
        startedAt,
        assistantText: "Need more information before continuing.",
        toolCalls: []
      }
    ],
    totalToolCalls: 0,
    outcome: "unknown",
    errorMessage: "Goal paused: needs user input",
    usedSkills: []
  }

  const nodes = buildTraceTree(trace)
  const root = nodes.find((node) => node.type === "trace")
  const llmNode = nodes.find((node) => node.type === "llm")
  const terminal = nodes.find((node) => node.id === `legacy:unknown:${trace.traceId}`)

  assert(root?.status === "unknown", "legacy root node should use unknown status")
  assert(llmNode?.status === "unknown", "legacy final LLM node should use unknown status")
  assert(terminal?.status === "unknown", "legacy terminal node should use unknown status")
  assert(terminal?.name === "Run Ended", "legacy unknown terminal should not say completed")
  assert(terminal?.output === trace.errorMessage, "legacy unknown terminal should preserve reason")
}

async function run(): Promise<void> {
  const previousStorageMode = process.env.CMB_COWORK_TRACE_STORAGE_MODE
  // These legacy telemetry assertions inspect JSONL directly. Production uses
  // encrypted storage; codec/migration behavior is covered by local-storage.test.ts.
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  try {
    testSkillUsageDetectorNormalizesVersions()
    console.log("PASS Skill usage detector version normalization")
    testStreamSkillUsageObservation()
    console.log("PASS stream Skill usage observation")
    await testTraceSidecarFailureIsolation()
    console.log("PASS trace sidecar failure isolation")
    await testSkillUsageDetectorReadsSkillMetadataDirectly()
    console.log("PASS Skill usage detector direct SKILL.md metadata lookup")
    await testTraceCollectorReportsVersionedSkills()
    console.log("PASS trace collector telemetry usedSkills normalization")
    await testTraceCollectorObservabilityContext()
    console.log("PASS trace collector observability context")
    await testTraceCollectorCountsSubagentMetadataTools()
    console.log("PASS trace collector subagent metadata tool count")
    await testTraceCollectorSanitizesLargeFields()
    console.log("PASS trace collector trace field sanitization")
    await testTraceCollectorPreservesUnknownOutcomeNodes()
    console.log("PASS trace collector unknown outcome node status")
    testTraceTreeBuilderPreservesUnknownOutcome()
    console.log("PASS trace tree builder unknown outcome status")
  } finally {
    if (previousStorageMode === undefined) delete process.env.CMB_COWORK_TRACE_STORAGE_MODE
    else process.env.CMB_COWORK_TRACE_STORAGE_MODE = previousStorageMode
  }
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
