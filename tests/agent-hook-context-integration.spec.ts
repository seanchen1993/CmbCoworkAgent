/**
 * Behavioral coverage for agent/workspace context at the command-hook boundary.
 *
 * Run:
 *   npx tsx tests/agent-hook-context-integration.spec.ts
 */

import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import {
  buildSubagentStartHookContext,
  buildSubagentStopHookContext,
  extractSubagentStartToolCallsFromStreamPayload
} from "../src/main/hooks/subagent-context.ts"
import { runHooks, type HookContext, type HookResultCallback } from "../src/main/hooks/runner.ts"
import type { HookConfig, HookEvent } from "../src/main/hooks/types.ts"

interface CapturedCommandContext {
  payload: Record<string, unknown>
  env: {
    agentId: string | null
    workspacePath: string | null
  }
}

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function makeCaptureHook(event: HookEvent, matcher?: string): HookConfig {
  return {
    id: `capture-${event}`,
    event,
    matcher,
    type: "command",
    command: nodeCommand(`
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    additionalContext: JSON.stringify({
      payload: JSON.parse(input),
      env: {
        agentId: process.env.AGENT_ID ?? null,
        workspacePath: process.env.WORKSPACE_PATH ?? null
      }
    })
  }))
})
`),
    enabled: true,
    timeout: 5_000,
    createdAt: "",
    updatedAt: ""
  }
}

function captureNextHookResult(): {
  promise: Promise<CapturedCommandContext>
  onHookResult: HookResultCallback
} {
  let resolveCapture!: (capture: CapturedCommandContext) => void
  let rejectCapture!: (error: Error) => void
  const captured = new Promise<CapturedCommandContext>((resolvePromise, rejectPromise) => {
    resolveCapture = resolvePromise
    rejectCapture = rejectPromise
  })
  const timeout = setTimeout(
    () => rejectCapture(new Error("Timed out waiting for command hook")),
    10_000
  )
  timeout.unref?.()

  return {
    promise: captured.finally(() => clearTimeout(timeout)),
    onHookResult: (_event, _hook, result) => {
      try {
        assert.ok(result.additionalContext, "capture hook should return additionalContext")
        resolveCapture(JSON.parse(result.additionalContext) as CapturedCommandContext)
      } catch (error) {
        rejectCapture(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

async function captureContextThroughCommandHook(
  event: HookEvent,
  context: HookContext
): Promise<CapturedCommandContext> {
  const capture = captureNextHookResult()
  await runHooks([makeCaptureHook(event)], event, context, capture.onHookResult)
  return capture.promise
}

async function testRuntimeAgentIdFlowsThroughLocalSandbox(): Promise<void> {
  const runtimeSource = readFileSync(
    resolve(import.meta.dirname, "..", "src", "main", "agent", "runtime.ts"),
    "utf8"
  ).replace(/\r\n/g, "\n")
  assert.match(
    runtimeSource,
    /new LocalSandbox\(\{\s*rootDir: workspacePath,\s*agentId,/,
    "createAgentRuntime must forward its static agentId into LocalSandbox"
  )

  const workspacePath = mkdtempSync(join(tmpdir(), "agent-hook-runtime-"))
  const capture = captureNextHookResult()
  try {
    writeFileSync(join(workspacePath, "note.txt"), "runtime context\n", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: workspacePath,
      runId: "runtime-agent-thread",
      agentId: "runtime-static-agent",
      hooks: [makeCaptureHook("PreToolUse", "read_file")],
      onHookResult: capture.onHookResult
    })

    const contents = await sandbox.read("note.txt")
    assert.match(contents, /runtime context/, "read_file should still return the file contents")

    const observed = await capture.promise
    assert.equal(observed.payload.hook_event_name, "PreToolUse")
    assert.equal(observed.payload.session_id, "runtime-agent-thread")
    assert.equal(observed.payload.agent_id, "runtime-static-agent")
    assert.equal(observed.payload.workspace, workspacePath)
    assert.equal(observed.payload.workspace_path, workspacePath)
    assert.equal(observed.payload.tool_name, "read_file")
    assert.equal(observed.env.agentId, "runtime-static-agent")
    assert.equal(observed.env.workspacePath, workspacePath)
  } finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

async function testSubagentStartCommandPayload(): Promise<void> {
  const workspacePath = mkdtempSync(join(tmpdir(), "agent-hook-start-"))
  try {
    const context = buildSubagentStartHookContext({
      workspacePath,
      threadId: "parent-thread",
      turnId: "parent-turn",
      toolCallId: "task-call-start",
      subagentType: "code-reviewer",
      taskDescription: "Review the hook changes"
    })
    const observed = await captureContextThroughCommandHook("SubagentStart", context)
    const toolInput = observed.payload.tool_input as Record<string, unknown>
    const subagent = observed.payload.subagent as Record<string, unknown>

    assert.equal(observed.payload.hook_event_name, "SubagentStart")
    assert.equal(observed.payload.session_id, "parent-thread")
    assert.equal(observed.payload.agent_id, "task-call-start")
    assert.equal(observed.payload.workspace, workspacePath)
    assert.equal(observed.payload.workspace_path, workspacePath)
    assert.equal(toolInput.agent_id, "task-call-start")
    assert.equal(toolInput.tool_call_id, "task-call-start")
    assert.equal(toolInput.agent_type, "code-reviewer")
    assert.equal(toolInput.task_description, "Review the hook changes")
    assert.equal(subagent.id, "task-call-start")
    assert.equal(subagent.name, "code-reviewer")
    assert.equal(subagent.status, "started")
    assert.equal(observed.env.agentId, "task-call-start")
    assert.equal(observed.env.workspacePath, workspacePath)
  } finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

function testSubagentStartExtractionFromResumedStreamPayload(): void {
  const toolCalls = extractSubagentStartToolCallsFromStreamPayload([
    {
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: {
        type: "ai",
        tool_calls: [
          {
            id: "task-call-resumed",
            name: "task",
            args: {
              subagent_type: "researcher",
              description: "Resume the investigation"
            }
          },
          { id: "read-call-resumed", name: "read_file", args: { path: "note.txt" } }
        ]
      }
    },
    { namespace: "resume" }
  ])

  assert.equal(toolCalls.length, 1, "resumed AI payload should expose only task tool calls")
  assert.equal(toolCalls[0]?.id, "task-call-resumed")
  assert.equal(toolCalls[0]?.args?.subagent_type, "researcher")
  assert.deepEqual(
    extractSubagentStartToolCallsFromStreamPayload([
      {
        id: ["langchain_core", "messages", "ToolMessage"],
        kwargs: { type: "tool", name: "task", tool_call_id: "task-call-resumed" }
      }
    ]),
    [],
    "task result payload must not be mistaken for another SubagentStart"
  )
  assert.deepEqual(
    extractSubagentStartToolCallsFromStreamPayload({ malformed: true }),
    [],
    "malformed non-tuple stream payload should be ignored safely"
  )
}

async function testSubagentStopCommandPayload(): Promise<void> {
  const workspacePath = mkdtempSync(join(tmpdir(), "agent-hook-stop-"))
  try {
    const context = buildSubagentStopHookContext({
      workspacePath,
      threadId: "parent-thread",
      turnId: "parent-turn",
      toolCallId: "task-call-stop",
      failed: true
    })
    const observed = await captureContextThroughCommandHook("SubagentStop", context)
    const subagent = observed.payload.subagent as Record<string, unknown>

    assert.equal(observed.payload.hook_event_name, "SubagentStop")
    assert.equal(observed.payload.session_id, "parent-thread")
    assert.equal(observed.payload.agent_id, "task-call-stop")
    assert.equal(observed.payload.workspace, workspacePath)
    assert.equal(observed.payload.workspace_path, workspacePath)
    assert.equal(subagent.id, "task-call-stop")
    assert.equal(subagent.status, "failed")
    assert.equal(observed.env.agentId, "task-call-stop")
    assert.equal(observed.env.workspacePath, workspacePath)
  } finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await testRuntimeAgentIdFlowsThroughLocalSandbox()
  await testSubagentStartCommandPayload()
  testSubagentStartExtractionFromResumedStreamPayload()
  await testSubagentStopCommandPayload()
  console.log("PASS agent hook context integration")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
