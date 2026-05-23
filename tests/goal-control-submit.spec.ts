/**
 * Unit tests for renderer goal control submit routing.
 *
 * Run:
 *   npx tsx tests/goal-control-submit.spec.ts
 */

import {
  isGoalSlashControlCommandInput,
  isGoalTerminatingControlCommandInput
} from "../src/renderer/src/features/slash-commands/useSlashCommands.ts"
import {
  resolveGoalControlSubmitRoute,
  shouldClearPendingApprovalAfterGoalControl
} from "../src/renderer/src/lib/goal-control-submit.ts"

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function routeFor(input: string, isLoading: boolean) {
  return resolveGoalControlSubmitRoute({
    isGoalControlCommand: isGoalSlashControlCommandInput(input),
    isLoading
  })
}

function clearPendingFor(input: string, terminatedCurrentRun: boolean): boolean {
  return shouldClearPendingApprovalAfterGoalControl({
    hasPendingApproval: true,
    isTerminatingControlCommand: isGoalTerminatingControlCommandInput(input),
    terminatedCurrentRun
  })
}

function testIdleGoalStatusUsesControlPlaneAndKeepsPendingApproval(): void {
  const route = routeFor("/goal status", false)

  assertEqual(
    route.shouldUseGoalControlPlane,
    true,
    "idle /goal status should use agent.goalControl instead of stream.submit"
  )
  assertEqual(
    route.shouldUseSubmitLock,
    true,
    "idle /goal status should still use the submit lock to avoid duplicate submits"
  )
  assertEqual(
    clearPendingFor("/goal status", true),
    false,
    "/goal status must not clear or reject an existing pending approval"
  )
}

function testBareGoalUsesControlPlaneAndKeepsPendingApproval(): void {
  const route = routeFor("/goal", false)

  assertEqual(
    route.shouldUseGoalControlPlane,
    true,
    "idle bare /goal should use agent.goalControl instead of stream.submit"
  )
  assertEqual(
    clearPendingFor("/goal", true),
    false,
    "bare /goal status shorthand must not clear or reject an existing pending approval"
  )
}

function testTerminatingGoalControlsClearPendingApprovalOnlyWhenRunTerminated(): void {
  assertEqual(
    clearPendingFor("/goal pause", true),
    true,
    "/goal pause should clear pending approval when it actually terminates the run"
  )
  assertEqual(
    clearPendingFor("/goal pause", false),
    false,
    "/goal pause should not clear pending approval when no run was terminated"
  )
  assertEqual(
    clearPendingFor("/goal clear", true),
    true,
    "/goal clear should clear pending approval when it actually terminates the run"
  )
}

function testLoadingGoalControlUsesSideChannelWithoutSubmitLock(): void {
  const route = routeFor("/goal pause", true)

  assertEqual(route.shouldUseGoalControlPlane, true, "loading /goal pause should use goalControl")
  assertEqual(
    route.isSideChannelGoalControl,
    true,
    "loading /goal pause should be marked as the side-channel control path"
  )
  assertEqual(
    route.shouldUseSubmitLock,
    false,
    "loading side-channel goal controls should remain available during an active stream"
  )
}

function testGoalResumeStaysOnStreamSubmitPath(): void {
  const route = routeFor("/goal resume", false)

  assertEqual(
    route.shouldUseGoalControlPlane,
    false,
    "/goal resume should not use the goalControl side-channel"
  )
  assertEqual(
    route.shouldUseSubmitLock,
    true,
    "/goal resume remains a real stream.submit path and should use the submit lock"
  )
}

testIdleGoalStatusUsesControlPlaneAndKeepsPendingApproval()
testBareGoalUsesControlPlaneAndKeepsPendingApproval()
testTerminatingGoalControlsClearPendingApprovalOnlyWhenRunTerminated()
testLoadingGoalControlUsesSideChannelWithoutSubmitLock()
testGoalResumeStaysOnStreamSubmitPath()

console.log("goal-control-submit.spec.ts passed")
