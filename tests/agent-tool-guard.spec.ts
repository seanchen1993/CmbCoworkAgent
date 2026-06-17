/**
 * Integration test for the Solo registry-subagent tool guard
 * (createAgentToolGuardMiddleware). Drives the REAL guard's wrapToolCall — not a
 * simulation — to prove:
 *   - a read-only `execute` call runs its handler INSIDE
 *     readOnlyShellExecutionContext (so the shared LocalSandbox's post-hook gate
 *     fires for a Solo subagent that shares the main, non-flagged sandbox);
 *   - a non-read-only command is blocked before the handler runs;
 *   - the context is NOT established for full-shell guards or non-execute tools
 *     (no false-positives on write-capable siblings).
 *
 * Run:
 *   npx tsx tests/agent-tool-guard.spec.ts
 */

import assert from "node:assert"
import { createAgentToolGuardMiddleware } from "../src/main/agent/runtime.ts"
import { readOnlyShellExecutionContext } from "../src/main/agent/local-sandbox.ts"

interface GuardResult {
  contextSeen?: boolean
}

/** Invoke a guard's wrapToolCall with a fake tool call + a handler that records
 * whether the read-only execution context is active when it runs. */
async function invoke(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guard: any,
  toolCall: { name: string; args?: unknown; id?: string }
): Promise<{ result: unknown; handlerCalled: boolean; contextSeen: boolean | undefined }> {
  let handlerCalled = false
  let contextSeen: boolean | undefined
  const handler = async (): Promise<GuardResult> => {
    handlerCalled = true
    contextSeen = readOnlyShellExecutionContext.getStore()
    return { contextSeen }
  }
  const result = await guard.wrapToolCall(
    { toolCall: { id: toolCall.id ?? "t1", name: toolCall.name, args: toolCall.args } },
    handler
  )
  return { result, handlerCalled, contextSeen }
}

function isBlockedMessage(result: unknown): boolean {
  const content = (result as { content?: unknown })?.content
  return typeof content === "string" && /blocked|unavailable/i.test(content)
}

async function run(): Promise<void> {
  // Mirror the built-in Explore/Plan profile: read-only shell + write tools denied.
  const roGuard = createAgentToolGuardMiddleware(["write_file", "edit_file"], "read_only")
  const fullGuard = createAgentToolGuardMiddleware([], "full")

  // 1) read-only execute + a read command → handler runs INSIDE the context.
  const readRun = await invoke(roGuard, { name: "execute", args: { command: "ls -la" } })
  assert.equal(readRun.handlerCalled, true, "read-only read command must reach the handler")
  assert.equal(
    readRun.contextSeen,
    true,
    "read-only execute must run its handler inside readOnlyShellExecutionContext"
  )

  // 2) read-only execute + a build command → BLOCKED before the handler.
  const buildRun = await invoke(roGuard, { name: "execute", args: { command: "npm install" } })
  assert.equal(buildRun.handlerCalled, false, "read-only build command must NOT reach the handler")
  assert.ok(
    isBlockedMessage(buildRun.result),
    "read-only build command must return a block message"
  )

  // 3) read-only execute + env-wrapped build → BLOCKED (env unwrapped).
  const envRun = await invoke(roGuard, { name: "execute", args: { command: "env npm install" } })
  assert.equal(envRun.handlerCalled, false, "env-wrapped build must NOT reach the handler")
  assert.ok(isBlockedMessage(envRun.result), "env-wrapped build must return a block message")

  // 4) FULL-shell guard + a build command → handler runs and the read-only
  //    context is NOT set (write-capable siblings are never constrained).
  const fullBuild = await invoke(fullGuard, { name: "execute", args: { command: "npm install" } })
  assert.equal(fullBuild.handlerCalled, true, "full-shell guard must allow builds")
  assert.notEqual(
    fullBuild.contextSeen,
    true,
    "full-shell guard must NOT establish the read-only context"
  )

  // 5) read-only guard + a non-execute tool (read_file) → handler runs, NO context
  //    (the context is scoped to read-only execute calls only).
  const readFile = await invoke(roGuard, { name: "read_file", args: { file_path: "/x" } })
  assert.equal(readFile.handlerCalled, true, "non-execute tool must reach the handler")
  assert.notEqual(
    readFile.contextSeen,
    true,
    "non-execute tool must NOT establish the read-only context"
  )

  // 6) read-only guard + a denylisted tool (write_file) → BLOCKED before handler.
  const write = await invoke(roGuard, { name: "write_file", args: { file_path: "/x" } })
  assert.equal(write.handlerCalled, false, "denylisted write_file must NOT reach the handler")
  assert.ok(isBlockedMessage(write.result), "denylisted write_file must return a block message")

  console.log("PASS agent tool guard read-only context (6 cases)")
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
