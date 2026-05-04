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

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for async trace reporter")
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
    setTraceReporter({ async report() {} })
    if (previousTracesDir === undefined) {
      delete process.env.CMB_COWORK_TRACES_DIR
    } else {
      process.env.CMB_COWORK_TRACES_DIR = previousTracesDir
    }
    await rm(tracesDir, { recursive: true, force: true })
  }
}

async function run(): Promise<void> {
  testSkillUsageDetectorNormalizesVersions()
  console.log("PASS Skill usage detector version normalization")
  await testTraceCollectorReportsVersionedSkills()
  console.log("PASS trace collector telemetry usedSkills normalization")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
