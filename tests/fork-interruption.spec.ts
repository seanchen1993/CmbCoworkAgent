/**
 * Regression contracts for user-interrupted fork boundaries and action placement.
 *
 * Run:
 *   npx tsx tests/fork-interruption.spec.ts
 */

import assert from "assert"
import { readFile } from "fs/promises"
import { resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

async function readProjectFile(path: string): Promise<string> {
  return (await readFile(resolve(PROJECT_ROOT, path), "utf8")).replace(/\r\n/g, "\n")
}

async function testAbortPathsMarkStableForkBoundary(): Promise<void> {
  const source = await readProjectFile("src/main/ipc/agent.ts")
  const interruptedMarkerCalls =
    source.match(/source: "agent_run_interrupted"/g)?.length ?? 0

  assert.equal(
    interruptedMarkerCalls,
    4,
    "normal and throwing invoke aborts plus resume and interrupt aborts must retain markers"
  )
  assert.match(
    source,
    /const outcome = source === "agent_run_interrupted" \? "interrupted" : "completed"/,
    "fork boundary metadata must distinguish interrupted runs"
  )
  assert.match(
    source,
    /if \(hasPendingApprovalForThread\(threadId\)\) return[\s\S]*checkpointHasInterrupt\(tuple\.checkpoint\)/,
    "interrupted boundaries must preserve approval and graph-interrupt safety gates"
  )
  assert.match(
    source,
    /if \(\(tuple\.pendingWrites\?\.length \?\? 0\) > 0 && source !== "agent_run_interrupted"\) return/,
    "user-stopped tool runs may retain abandoned pending writes while completed runs may not"
  )
}

async function testAssistantActionsRenderAfterTools(): Promise<void> {
  const source = await readProjectFile("src/renderer/src/components/chat/MessageBubble.tsx")
  const toolListIndex = source.indexOf("{hasToolCalls && (")
  const forkActionIndex = source.indexOf('aria-label="从这里 fork"')

  assert(toolListIndex >= 0, "assistant tool list should exist")
  assert(forkActionIndex >= 0, "assistant fork action should exist")
  assert(
    toolListIndex < forkActionIndex,
    "assistant actions must render after tool execution boxes"
  )
  assert.match(
    source,
    /const shouldShowAssistantActions =[\s\S]*Boolean\(content \|\| hasToolCalls\)/,
    "assistant actions must still render for tool-only assistant messages"
  )
  assert.match(
    source,
    /\{shouldShowAssistantActions && \(/,
    "assistant action row should not be gated directly on text content"
  )
}

async function testForkabilityAllowsInterruptedPendingWritesOnly(): Promise<void> {
  const source = await readProjectFile("src/shared/checkpoint-forkability.ts")
  assert.match(
    source,
    /function isUserInterruptedForkBoundary\([\s\S]*agent_run_interrupted[\s\S]*outcome[\s\S]*interrupted/,
    "forkability must recognize explicit user-interrupted fork boundaries"
  )
  assert.match(
    source,
    /if \(hasPendingWrites && !isUserInterruptedForkBoundary\(marker\)\)/,
    "pending writes should only be allowed for user-interrupted fork boundaries"
  )
}

async function testForkWaitsForAbortingRunToSettle(): Promise<void> {
  const agentSource = await readProjectFile("src/main/ipc/agent.ts")
  const threadsSource = await readProjectFile("src/main/ipc/threads.ts")

  assert.match(
    agentSource,
    /export function isActiveAgentRunAborting\(threadId: string\): boolean \{[\s\S]*signal\.aborted === true/,
    "agent IPC should expose whether an active run is already aborting"
  )
  assert.match(
    agentSource,
    /export async function waitForActiveAgentRunToSettle\([\s\S]*waitForReplacedRunToSettle\(threadId\)/,
    "fork checks should be able to wait for an aborting run's final checkpoint cleanup"
  )
  assert.match(
    threadsSource,
    /if \(hasActiveAgentRun\(threadId\)\) \{[\s\S]*!isActiveAgentRunAborting\(threadId\)[\s\S]*waitForActiveAgentRunToSettle\(threadId\)[\s\S]*return true[\s\S]*\}/,
    "fork busy checks should wait only for aborting active runs and keep true running sessions blocked"
  )
}

async function main(): Promise<void> {
  await testAbortPathsMarkStableForkBoundary()
  await testAssistantActionsRenderAfterTools()
  await testForkabilityAllowsInterruptedPendingWritesOnly()
  await testForkWaitsForAbortingRunToSettle()
  console.log("fork interruption regression tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
