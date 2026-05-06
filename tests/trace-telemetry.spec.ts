/**
 * Unit tests for trace and Skill usage telemetry.
 *
 * Run:
 *   npx tsx tests/trace-telemetry.spec.ts
 */

import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { SkillUsageDetector } from "../src/main/agent/skill-evolution/usage-detector.ts"
import { TraceCollector, setTraceReporter } from "../src/main/agent/trace/collector.ts"
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

function makeLongText(prefix: string, middle: string, suffix: string, middleLength: number): string {
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
    { name: "接口设计", version: "2.3.4", path: "/repo/skills/api-design/SKILL.md" }
  ])

  assert(detector.onReadFilePath("/repo/skills/code-review/SKILL.md"), "exact SKILL.md read should add a skill")
  assert(detector.onReadFilePath("/repo/skills/api-design/references/spec.md"), "root child read should add a skill")
  assert(!detector.onReadFilePath("/repo/skills/code-review/SKILL.md"), "duplicate reads should not add again")
  assertArrayEqual(
    detector.getUsedSkillNames(),
    ["代码审查-v1.0.0", "接口设计-v2.3.4"],
    "Skill detector should emit versioned identifiers with default version fallback"
  )
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
    const tracer = new TraceCollector("thread-telemetry-unit", "请使用测试 Skill 生成代码", "model-a")
    tracer.setModelName("Model A")
    tracer.setUsedSkills(["unit-skill", "unit-skill-v1.0.0", "another-skill-2.3.4"])
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
      reportedTrace?.usedSkills ?? [],
      trace.usedSkills,
      "async trace reporter should receive normalized usedSkills"
    )

    const file = join(tracesDir, trace.threadId, `${trace.traceId}.jsonl`)
    const persisted = JSON.parse((await readFile(file, "utf-8")).trim()) as AgentTrace
    assertArrayEqual(
      persisted.usedSkills,
      trace.usedSkills,
      "persisted trace should contain normalized usedSkills"
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
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
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

    const trace = await tracer.finish("error", makeLongText("ERROR_HEAD_", "e", "_ERROR_TAIL", 4000))
    await waitFor(() => reportedTrace !== undefined)

    assert(trace.userMessage.includes("USER_HEAD_"), "sanitized user message should keep head")
    assert(trace.userMessage.includes("_USER_TAIL"), "sanitized user message should keep tail")
    assert(trace.userMessage.includes("trace truncated"), "sanitized user message should mark truncation")
    assert(trace.modelCalls?.[0]?.inputMessages.length === 12, "sanitizer should keep all LLM input messages")
    assert(
      trace.modelCalls?.[0]?.inputMessages[11]?.content.includes("_MSG_11_TAIL"),
      "sanitizer should preserve tails for retained input messages"
    )
    assert(
      trace.steps[0]?.toolCalls[0]?.result?.includes("_RESULT_TAIL"),
      "tool result should keep tail"
    )
    assert(
      JSON.stringify(trace.steps[0]?.toolCalls[0]?.args).includes("ARGS_HEAD_"),
      "tool args should keep head"
    )
    assert(
      trace.errorMessage?.includes("_ERROR_TAIL"),
      "error message should keep tail"
    )
    assert(
      trace.metadata?.traceTruncation &&
        typeof trace.metadata.traceTruncation === "object" &&
        (trace.metadata.traceTruncation as { truncated?: boolean }).truncated === true,
      "trace metadata should record truncation"
    )

    const file = join(tracesDir, trace.threadId, `${trace.traceId}.jsonl`)
    const persistedRaw = (await readFile(file, "utf-8")).trim()
    const persisted = JSON.parse(persistedRaw) as AgentTrace
    assert(persistedRaw.length < 96 * 1024, "persisted trace should fit hard limit")
    assert(persisted.modelCalls?.[0]?.inputMessages.length === 12, "persisted trace should keep all input messages")
    assertArrayEqual(
      reportedTrace?.modelCalls?.[0]?.inputMessages.map((message) => message.role) ?? [],
      persisted.modelCalls?.[0]?.inputMessages.map((message) => message.role) ?? [],
      "reporter should receive the same sanitized message sequence as persisted trace"
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

async function run(): Promise<void> {
  testSkillUsageDetectorNormalizesVersions()
  console.log("PASS Skill usage detector version normalization")
  await testTraceCollectorReportsVersionedSkills()
  console.log("PASS trace collector telemetry usedSkills normalization")
  await testTraceCollectorSanitizesLargeFields()
  console.log("PASS trace collector trace field sanitization")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
