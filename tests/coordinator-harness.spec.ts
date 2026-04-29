/**
 * Unit tests for coordinator harness helpers and state tools.
 *
 * Run:
 *   npx -y tsx tests/coordinator-harness.spec.ts
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildCoordinatorSystemPrompt,
  buildCoordinatorTaskPrompt,
  buildHarnessSubagents,
  createCoordinatorHarnessTools,
  getAgentModeFromMetadata,
  resolveCoordinatorHarnessRequest
} from "../src/main/agent/coordinator-harness.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include "${expected}"`)
}

function assertNotIncludes(value: string, unexpected: string, label: string): void {
  assert(!value.includes(unexpected), `${label}: expected not to include "${unexpected}"`)
}

async function invokeTool(tool: unknown, input: Record<string, unknown>): Promise<string> {
  const result = await (tool as { invoke: (args: unknown) => Promise<unknown> }).invoke(input)
  return typeof result === "string" ? result : JSON.stringify(result)
}

async function testModeDetection(): Promise<void> {
  const oldCoordinatorEnv = process.env.CMB_COORDINATOR_MODE
  const oldHarnessEnv = process.env.CMB_HARNESS_MODE
  delete process.env.CMB_COORDINATOR_MODE
  delete process.env.CMB_HARNESS_MODE

  assert(getAgentModeFromMetadata({}) === "normal", "empty metadata should default to normal")
  assert(
    getAgentModeFromMetadata({ agentMode: "coordinator" }) === "coordinator",
    "agentMode metadata should enable coordinator"
  )
  assert(
    getAgentModeFromMetadata({ harnessMode: true }) === "coordinator",
    "legacy harnessMode metadata should enable coordinator"
  )
  assert(
    getAgentModeFromMetadata({ coordinatorMode: "true" }) === "coordinator",
    "string coordinatorMode metadata should enable coordinator"
  )
  assert(
    getAgentModeFromMetadata({ agentMode: "normal", harnessMode: false }) === "normal",
    "normal metadata should stay normal"
  )

  const prefixed = resolveCoordinatorHarnessRequest("[harness] build a todo app", {})
  assert(prefixed.enabled === true, "message prefix should enable coordinator")
  assert(prefixed.shouldPersist === true, "message prefix should request persistence")
  assert(prefixed.message === "build a todo app", "message prefix should be stripped")

  const hashPrefixed = resolveCoordinatorHarnessRequest("  #coordinator: add auth", {})
  assert(hashPrefixed.enabled === true, "#coordinator prefix should enable coordinator")
  assert(hashPrefixed.message === "add auth", "#coordinator prefix should be stripped")

  const metadata = resolveCoordinatorHarnessRequest("build a todo app", {
    agentMode: "coordinator"
  })
  assert(metadata.enabled === true, "metadata should enable coordinator")
  assert(metadata.shouldPersist === false, "metadata mode should not force a metadata rewrite")

  const normal = resolveCoordinatorHarnessRequest("build a todo app", { agentMode: "normal" })
  assert(normal.enabled === false, "normal metadata should not enable coordinator")
  assert(normal.message === "build a todo app", "normal message should be unchanged")

  process.env.CMB_HARNESS_MODE = "1"
  const envEnabled = resolveCoordinatorHarnessRequest("build a todo app", {})
  assert(envEnabled.enabled === true, "env var should enable coordinator")
  assert(envEnabled.shouldPersist === false, "env var should not persist mode")

  if (oldCoordinatorEnv === undefined) delete process.env.CMB_COORDINATOR_MODE
  else process.env.CMB_COORDINATOR_MODE = oldCoordinatorEnv
  if (oldHarnessEnv === undefined) delete process.env.CMB_HARNESS_MODE
  else process.env.CMB_HARNESS_MODE = oldHarnessEnv
}

async function testPromptContracts(): Promise<void> {
  const threadId = "thread-123"
  const timeContext = {
    timezone: "Asia/Shanghai",
    currentTime: "2026-04-28T16:30:00+08:00"
  }
  const prompt = buildCoordinatorSystemPrompt({
    threadId,
    workspacePath: "/tmp/workspace",
    platform: "macOS",
    shell: "zsh",
    ...timeContext,
    projectInstructions: "PROJECT_RULE",
    hasBrowserTool: true,
    hasCodeExecTool: true,
    deferredToolIds: ["github.search"]
  })

  assertIncludes(prompt, "CmbCowork Coordinator Harness Mode", "coordinator prompt")
  assertIncludes(prompt, "implementer is the generator", "coordinator prompt")
  assertIncludes(prompt, "verifier is the evaluator", "coordinator prompt")
  assertIncludes(prompt, "Before launching any worker", "coordinator prompt")
  assertIncludes(prompt, "Do not skip verifier", "coordinator prompt")
  assertIncludes(
    prompt,
    "Do not report success from implementer output alone",
    "coordinator prompt"
  )
  assertIncludes(prompt, "reports/implementer-latest.json", "coordinator prompt")
  assertIncludes(prompt, "answer draft", "coordinator prompt")
  assertIncludes(prompt, "check_verification_gate returns accepted=true", "coordinator prompt")
  assertIncludes(prompt, "Required fields: status, summary, evidence", "coordinator prompt")
  assertIncludes(
    prompt,
    "Use .cmbdevclaw/harness/thread-123/progress.md for task state",
    "coordinator prompt"
  )
  assertIncludes(prompt, "Do not edit application files directly.", "coordinator prompt")
  assertIncludes(prompt, "Current time: 2026-04-28T16:30:00+08:00", "coordinator prompt")
  assertIncludes(prompt, "Do not invent dates or timestamps", "coordinator prompt")
  assertIncludes(prompt, "browser_playwright", "coordinator prompt")
  assertIncludes(prompt, "github.search", "coordinator prompt")
  assertIncludes(prompt, "PROJECT_RULE", "coordinator prompt")

  const fallbackPrompt = buildCoordinatorSystemPrompt({
    threadId,
    workspacePath: "/tmp/workspace",
    platform: "Linux",
    shell: "bash",
    ...timeContext,
    hasBrowserTool: false,
    hasCodeExecTool: false,
    deferredToolIds: []
  })
  assertIncludes(
    fallbackPrompt,
    "Browser/runtime verification may not be available",
    "coordinator prompt fallback"
  )
  assertIncludes(fallbackPrompt, "code_exec is not available", "coordinator prompt fallback")
  assertIncludes(
    fallbackPrompt,
    "No deferred worker tools are currently registered",
    "coordinator prompt fallback"
  )
  assertNotIncludes(fallbackPrompt, "## Project Instructions", "coordinator prompt fallback")

  const taskPrompt = buildCoordinatorTaskPrompt(threadId)
  assertIncludes(taskPrompt, "Before the first task call", "task prompt")
  assertIncludes(taskPrompt, ".cmbdevclaw/harness/thread-123/spec.md", "task prompt")
  assertIncludes(taskPrompt, 'subagent_type="implementer"', "task prompt")
  assertIncludes(taskPrompt, 'subagent_type="verifier"', "task prompt")
  assertIncludes(taskPrompt, "Do not treat implementer self-checks as final", "task prompt")
  assertIncludes(taskPrompt, "reports/implementer-latest.json", "task prompt")
  assertIncludes(taskPrompt, "check_verification_gate returns accepted=true", "task prompt")
}

async function testSubagentDefinitions(): Promise<void> {
  const timeContext = {
    timezone: "Asia/Shanghai",
    currentTime: "2026-04-28T16:30:00+08:00"
  }
  const subagents = buildHarnessSubagents(
    "PROJECT_RULE",
    ["/skills/project"],
    "thread-123",
    timeContext
  )
  assert(subagents.length === 2, "coordinator harness should expose exactly two subagents")
  assert(
    subagents.map((agent) => agent.name).join(",") === "implementer,verifier",
    "subagent names should be stable"
  )

  const implementer = subagents[0]
  const verifier = subagents[1]

  assertIncludes(implementer.systemPrompt, "You are not the final evaluator", "implementer prompt")
  assertIncludes(
    implementer.systemPrompt,
    ".cmbdevclaw/harness/thread-123/spec.md",
    "implementer prompt"
  )
  assertIncludes(implementer.systemPrompt, "Always write", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "answer_draft", "implementer prompt")
  assertIncludes(implementer.systemPrompt, "handoff_for_verifier", "implementer prompt")
  assertIncludes(
    implementer.systemPrompt,
    "Current time: 2026-04-28T16:30:00+08:00",
    "implementer prompt"
  )
  assertIncludes(
    implementer.systemPrompt,
    "Do not invent completion_time/generated_at",
    "implementer prompt"
  )
  assertIncludes(implementer.systemPrompt, "PROJECT_RULE", "implementer prompt")
  assertIncludes(verifier.systemPrompt, "Be strict, skeptical", "verifier prompt")
  assertIncludes(
    verifier.systemPrompt,
    "Verify the concrete implementer handoff",
    "verifier prompt"
  )
  assertIncludes(verifier.systemPrompt, "answer_draft", "verifier prompt")
  assertIncludes(
    verifier.systemPrompt,
    "Current time: 2026-04-28T16:30:00+08:00",
    "verifier prompt"
  )
  assertIncludes(verifier.systemPrompt, "STATUS (PASS/FAIL/BLOCKED)", "verifier prompt")
  assertIncludes(
    verifier.systemPrompt,
    "Required fields: status, summary, evidence",
    "verifier prompt"
  )
  assertIncludes(
    verifier.systemPrompt,
    "PASS requires at least one evidence item",
    "verifier prompt"
  )
  assert(
    implementer.skills?.[0] === "/skills/project" && verifier.skills?.[0] === "/skills/project",
    "harness subagents should inherit skill sources"
  )

  const subagentsWithoutSkills = buildHarnessSubagents()
  assert(
    !("skills" in subagentsWithoutSkills[0]) && !("skills" in subagentsWithoutSkills[1]),
    "harness subagents should omit skills property when no skill sources exist"
  )
}

async function testHarnessStateTools(): Promise<void> {
  await withTempDir("coordinator-harness", async (workspace) => {
    await mkdir(workspace, { recursive: true })
    const tools = createCoordinatorHarnessTools({
      workspacePath: workspace,
      threadId: "thread-123"
    })
    const readTool = tools.find((tool) => tool.name === "read_harness_state")
    const writeTool = tools.find((tool) => tool.name === "write_harness_state")
    const checkGateTool = tools.find((tool) => tool.name === "check_verification_gate")

    assert(readTool, "read_harness_state tool should exist")
    assert(writeTool, "write_harness_state tool should exist")
    assert(checkGateTool, "check_verification_gate tool should exist")

    const writeResult = await invokeTool(writeTool, {
      file: "spec.md",
      content: "# Spec\n\nBuild a todo app."
    })
    assertIncludes(writeResult, ".cmbdevclaw/harness/thread-123/spec.md", "write result")

    const written = await readFile(
      join(workspace, ".cmbdevclaw", "harness", "thread-123", "spec.md"),
      "utf8"
    )
    assertIncludes(written, "Build a todo app.", "written harness file")

    const readResult = JSON.parse(await invokeTool(readTool, { files: ["spec.md"] })) as {
      files: Record<string, string | null>
    }
    assertIncludes(readResult.files["spec.md"] ?? "", "Build a todo app.", "read result")

    const defaultReadResult = JSON.parse(await invokeTool(readTool, {})) as {
      files: Record<string, string | null>
    }
    assertIncludes(defaultReadResult.files["spec.md"] ?? "", "Build a todo app.", "default read")
    assert(
      defaultReadResult.files["contract.json"] === null,
      "default read should return null for missing known harness files"
    )

    const missingGate = JSON.parse(await invokeTool(checkGateTool, {})) as {
      accepted: boolean
      schemaValid: boolean
      issues: string[]
    }
    assert(missingGate.accepted === false, "missing verification report should not pass gate")
    assert(
      missingGate.schemaValid === false,
      "missing verification report should not be schema valid"
    )
    assert(
      missingGate.issues.some((issue) => issue.includes("Missing")),
      "missing verification report should explain missing file"
    )

    await invokeTool(writeTool, {
      file: "reports/latest-verification.json",
      content: JSON.stringify({
        status: "PASS",
        summary: "Documentation was checked against project files.",
        evidence: ["Read README.md and confirmed the requested docs are present."],
        commands_run: [],
        checked_files: ["README.md"],
        findings: [],
        blockers: []
      })
    })
    const report = await readFile(
      join(
        workspace,
        ".cmbdevclaw",
        "harness",
        "thread-123",
        "reports",
        "latest-verification.json"
      ),
      "utf8"
    )
    assertIncludes(report, '"PASS"', "verification report write")

    const acceptedGate = JSON.parse(await invokeTool(checkGateTool, {})) as {
      accepted: boolean
      schemaValid: boolean
      status: string
      counts: { evidence: number; checked_files: number }
    }
    assert(acceptedGate.accepted === true, "valid PASS report should pass verification gate")
    assert(acceptedGate.schemaValid === true, "valid PASS report should be schema valid")
    assert(acceptedGate.status === "PASS", "valid PASS report should preserve status")
    assert(acceptedGate.counts.evidence === 1, "valid PASS report should count evidence")
    assert(acceptedGate.counts.checked_files === 1, "valid PASS report should count checked files")

    let rejectedBadPassWrite = false
    try {
      await invokeTool(writeTool, {
        file: "reports/latest-verification.json",
        content: JSON.stringify({
          status: "PASS",
          summary: "Looks fine.",
          evidence: [],
          commands_run: [],
          checked_files: [],
          findings: [],
          blockers: []
        })
      })
    } catch {
      rejectedBadPassWrite = true
    }
    assert(rejectedBadPassWrite, "write tool should reject PASS reports without evidence")

    const reportPath = join(
      workspace,
      ".cmbdevclaw",
      "harness",
      "thread-123",
      "reports",
      "latest-verification.json"
    )
    await writeFile(
      reportPath,
      JSON.stringify({
        status: "PASS",
        summary: "Looks fine.",
        evidence: [],
        commands_run: [],
        checked_files: [],
        findings: [],
        blockers: []
      }),
      "utf8"
    )
    const rejectedGate = JSON.parse(await invokeTool(checkGateTool, {})) as {
      accepted: boolean
      schemaValid: boolean
      issues: string[]
    }
    assert(rejectedGate.schemaValid === true, "empty-evidence PASS should still be schema valid")
    assert(rejectedGate.accepted === false, "empty-evidence PASS should not pass verification gate")
    assert(
      rejectedGate.issues.some((issue) => issue.includes("PASS requires at least one evidence")),
      "empty-evidence PASS should explain missing evidence"
    )

    await invokeTool(writeTool, {
      file: "reports/latest-verification.json",
      content: JSON.stringify({
        status: "FAIL",
        summary: "One acceptance criterion is not satisfied.",
        evidence: ["npm test failed in the auth suite."],
        commands_run: ["npm test -- auth"],
        checked_files: [],
        findings: ["Auth failure path still returns 200."],
        blockers: []
      })
    })
    const failGate = JSON.parse(await invokeTool(checkGateTool, {})) as {
      accepted: boolean
      schemaValid: boolean
      status: string
      issues: string[]
    }
    assert(failGate.schemaValid === true, "structured FAIL report should be schema valid")
    assert(failGate.accepted === false, "FAIL report should not pass verification gate")
    assert(failGate.status === "FAIL", "FAIL report should preserve status")
    assert(
      failGate.issues.some((issue) => issue.includes("Verifier status is FAIL")),
      "FAIL gate should explain failed verifier status"
    )

    await writeFile(reportPath, "{not valid json", "utf8")
    const malformedGate = JSON.parse(await invokeTool(checkGateTool, {})) as {
      accepted: boolean
      schemaValid: boolean
      issues: string[]
    }
    assert(malformedGate.schemaValid === false, "malformed JSON should fail schema validation")
    assert(malformedGate.accepted === false, "malformed JSON should not pass verification gate")
    assert(
      malformedGate.issues.some((issue) => issue.includes("not valid JSON")),
      "malformed JSON should explain parse failure"
    )

    const reportsDir = await stat(
      join(workspace, ".cmbdevclaw", "harness", "thread-123", "reports")
    )
    assert(reportsDir.isDirectory(), "harness tools should create reports directory")

    let rejectedTraversal = false
    try {
      await invokeTool(writeTool, {
        file: "../outside.md",
        content: "bad"
      })
    } catch {
      rejectedTraversal = true
    }
    assert(rejectedTraversal, "harness tools should reject non-whitelisted files")

    let rejectedUnknownRead = false
    try {
      await invokeTool(readTool, {
        files: ["notes/random.md"]
      })
    } catch {
      rejectedUnknownRead = true
    }
    assert(rejectedUnknownRead, "harness read tool should reject unknown files")
  })

  let rejectedBadThreadId = false
  try {
    const tools = createCoordinatorHarnessTools({
      workspacePath: "/tmp/workspace",
      threadId: "../bad"
    })
    await invokeTool(tools[0], {})
  } catch {
    rejectedBadThreadId = true
  }
  assert(rejectedBadThreadId, "harness tools should reject unsafe thread ids")
}

async function run(): Promise<void> {
  await testModeDetection()
  console.log("PASS coordinator mode detection")
  await testPromptContracts()
  console.log("PASS coordinator prompt contracts")
  await testSubagentDefinitions()
  console.log("PASS coordinator subagent definitions")
  await testHarnessStateTools()
  console.log("PASS coordinator harness state tools")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
