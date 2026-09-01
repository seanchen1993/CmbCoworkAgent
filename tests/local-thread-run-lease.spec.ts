import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  assertLocalThreadRunLease,
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  isLocalThreadRunOwnedByAnotherSource,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../src/main/agent/thread-run-lease"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function assertSourceOrder(source: string, orderedNeedles: string[], message: string): void {
  let cursor = -1
  for (const needle of orderedNeedles) {
    const next = source.indexOf(needle, cursor + 1)
    assert(next >= 0, `${message}: missing ${JSON.stringify(needle)}`)
    assert(next > cursor, `${message}: out of order ${JSON.stringify(needle)}`)
    cursor = next
  }
}

function testForeignOwnerCannotSteal(): void {
  const threadId = "lease-foreign-owner"
  const desktop = claimLocalThreadRunLease({
    threadId,
    owner: "desktop",
    runId: "desktop-run",
    acquiredAt: "2026-01-01T00:00:00.000Z"
  })
  assert(desktop.acquired, "desktop acquires an empty Thread")

  const remote = claimLocalThreadRunLease({
    threadId,
    owner: "im",
    runId: "im-run",
    handoffFromRunId: "desktop-run"
  })
  assert(!remote.acquired, "foreign owner is rejected even with the current runId")
  assert(remote.conflict.owner === "desktop", "conflict identifies the desktop owner")
  assert(isLocalThreadRunOwnedByAnotherSource(threadId, "im"), "foreign-owner query is true")
  assert(releaseLocalThreadRunLease(threadId, "desktop", "desktop-run"), "owner releases lease")
}

function testSameOwnerHandoffRequiresExactRunId(): void {
  const threadId = "lease-same-owner-handoff"
  assert(
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run-1" }).acquired,
    "first run acquires"
  )
  assert(
    !claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run-2" }).acquired,
    "same owner cannot replace implicitly"
  )
  assert(
    !claimLocalThreadRunLease({
      threadId,
      owner: "desktop",
      runId: "run-2",
      handoffFromRunId: "wrong-run"
    }).acquired,
    "same owner cannot replace a mismatched run"
  )

  const handoff = claimLocalThreadRunLease({
    threadId,
    owner: "desktop",
    runId: "run-2",
    handoffFromRunId: "run-1"
  })
  assert(handoff.acquired && handoff.disposition === "handoff", "exact handoff succeeds")
  assert(getLocalThreadRunLease(threadId)?.runId === "run-2", "new run owns the lease")
  assert(releaseLocalThreadRunLease(threadId, "desktop", "run-2"), "new run releases")
}

function testLateReleaseIsIdentityFenced(): void {
  const threadId = "lease-late-release"
  assert(
    claimLocalThreadRunLease({ threadId, owner: "im", runId: "im-1" }).acquired,
    "first IM run acquires"
  )
  assert(
    claimLocalThreadRunLease({
      threadId,
      owner: "im",
      runId: "im-2",
      handoffFromRunId: "im-1"
    }).acquired,
    "next IM run receives explicit handoff"
  )
  assert(!releaseLocalThreadRunLease(threadId, "im", "im-1"), "late old release is ignored")
  assert(getLocalThreadRunLease(threadId)?.runId === "im-2", "late cleanup keeps new owner")
  assert(!releaseLocalThreadRunLease(threadId, "desktop", "im-2"), "wrong owner cannot release")
  assert(releaseLocalThreadRunLease(threadId, "im", "im-2"), "current identity releases")
}

function testIdempotentClaimPreservesTimestampAndSnapshotIsolation(): void {
  const threadId = "lease-idempotent"
  const first = claimLocalThreadRunLease({
    threadId,
    owner: "scheduler",
    runId: "scheduled-run",
    acquiredAt: "2026-02-03T04:05:06.000Z"
  })
  const second = claimLocalThreadRunLease({
    threadId,
    owner: "scheduler",
    runId: "scheduled-run",
    acquiredAt: "2099-01-01T00:00:00.000Z"
  })
  assert(first.acquired && second.acquired, "same identity is idempotent")
  assert(second.disposition === "existing", "idempotent claim is reported")
  assert(second.lease.acquiredAt === "2026-02-03T04:05:06.000Z", "timestamp is stable")
  assertLocalThreadRunLease(threadId, "scheduler", "scheduled-run")
  let mismatchRejected = false
  try {
    assertLocalThreadRunLease(threadId, "im", "scheduled-run")
  } catch {
    mismatchRejected = true
  }
  assert(mismatchRejected, "Runtime guard rejects the wrong lease identity")
  second.lease.runId = "mutated-copy"
  assert(getLocalThreadRunLease(threadId)?.runId === "scheduled-run", "snapshots are defensive")
  assert(releaseLocalThreadRunLease(threadId, "scheduler", "scheduled-run"), "lease releases")
}

async function testReleaseNotificationIsIdentityFencedAndUnsubscribable(): Promise<void> {
  const threadId = "lease-release-notification"
  const notifications: Array<{ threadId: string; owner: string; runId: string }> = []
  const unsubscribe = onLocalThreadRunLeaseReleased((lease) => notifications.push(lease))
  const flushNotification = () => new Promise<void>((resolve) => queueMicrotask(resolve))

  assert(
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "desktop-run" }).acquired,
    "desktop run acquires"
  )
  assert(
    !releaseLocalThreadRunLease(threadId, "scheduler", "desktop-run"),
    "wrong identity cannot release"
  )
  await flushNotification()
  assert(notifications.length === 0, "failed release does not emit an idle notification")

  assert(
    releaseLocalThreadRunLease(threadId, "desktop", "desktop-run"),
    "matching identity releases"
  )
  await flushNotification()
  assert(notifications.length === 1, "successful release emits exactly once")
  assert(
    notifications[0].threadId === threadId &&
      notifications[0].owner === "desktop" &&
      notifications[0].runId === "desktop-run",
    "notification identifies the released physical run"
  )

  unsubscribe()
  assert(
    claimLocalThreadRunLease({ threadId, owner: "scheduler", runId: "scheduler-run" }).acquired,
    "next run acquires"
  )
  assert(releaseLocalThreadRunLease(threadId, "scheduler", "scheduler-run"), "next run releases")
  await flushNotification()
  assert(notifications.length === 1, "unsubscribed listener receives no later release")
}

function testRuntimeEntryPointArchitecture(): void {
  const leaseSource = read("src/main/agent/thread-run-lease.ts")
  const standardTurn = read("src/main/agent/standard-thread-turn.ts")
  const desktop = read("src/main/ipc/agent.ts")
  const scheduler = read("src/main/services/scheduler.ts")
  const heartbeat = read("src/main/services/heartbeat.ts")
  const imRunner = read("src/main/services/im/remote-runner.ts")

  assert(!leaseSource.includes("setTimeout("), "leases cannot expire or be timeout-stolen")
  assert(!leaseSource.includes("forceRelease"), "leases expose no force-release escape hatch")
  assert(
    leaseSource.includes("current.owner === input.owner") &&
      leaseSource.includes("input.handoffFromRunId === current.runId"),
    "same-owner handoff is an exact compare-and-swap"
  )
  assert(
    count(desktop, "const leaseClaim = claimDesktopThreadRunLease(") === 3,
    "invoke, resume, and interrupt each claim under the existing mutation lock"
  )
  for (const [label, start, end, runToken] of [
    [
      "invoke",
      "const replacement = await withThreadRunMutationLock",
      'if ("startRejectedDuringShutdown" in replacement)',
      "nextInvokeRunToken"
    ],
    [
      "resume",
      "const resumeReplacement = await withThreadRunMutationLock",
      "const resumeCoordinatorSelectedSkill",
      "nextResumeRunToken"
    ],
    [
      "interrupt",
      "const interruptReplacement = await withThreadRunMutationLock",
      "const interruptCoordinatorSelectedSkill",
      "nextInterruptRunToken"
    ]
  ] as const) {
    const startIndex = desktop.indexOf(start)
    const endIndex = desktop.indexOf(end, startIndex)
    assert(startIndex >= 0 && endIndex > startIndex, `${label} replacement slice exists`)
    assertSourceOrder(
      desktop.slice(startIndex, endIndex),
      [
        "withThreadRunMutationLock(threadId",
        `claimDesktopThreadRunLease(threadId, ${runToken})`,
        "activeRuns.set(threadId"
      ],
      `${label} claims inside the mutation lock before installing its controller`
    )
  }
  assert(
    count(desktop, 'releaseLocalThreadRunLease(threadId, "desktop", runToken)') === 4,
    "the shared physical-run finalizer and all abandoned setup guards use identity-fenced release"
  )
  assert(
    count(desktop, "rejectDesktopRunForForeignOwner(threadId, window, channel)") === 3,
    "all desktop Runtime starts reject a visible foreign owner before stateful work"
  )
  const cancelHandler = desktop.slice(desktop.indexOf('"agent:cancel"'))
  assertSourceOrder(
    cancelHandler,
    [
      "withThreadRunMutationLock(threadId",
      "const lease = getLocalThreadRunLease(threadId)",
      'lease.owner !== "desktop"',
      "const controller = activeRuns.get(threadId)"
    ],
    "desktop cancel refuses a foreign owner under the same mutation lock before aborting"
  )
  assert(
    standardTurn.includes(
      "assertLocalThreadRunLease(options.threadId, input.runLease.owner, input.runLease.runId)"
    ),
    "the shared Runtime factory verifies its lease identity"
  )
  assertSourceOrder(
    standardTurn,
    ["assertLocalThreadRunLease(", "return createAgentRuntime(options)"],
    "shared Runtime creation follows the lease assertion"
  )

  for (const [label, source, owner, runId] of [
    ["scheduler", scheduler, "scheduler", "schedulerRunId"],
    ["heartbeat", heartbeat, "scheduler", "heartbeatRunId"]
  ] as const) {
    assertSourceOrder(
      source,
      [
        "claimLocalThreadRunLease({",
        "pinCheckpointer(threadId)",
        `assertLocalThreadRunLease(threadId, "${owner}", ${runId})`,
        "createAgentRuntime({"
      ],
      `${label} claims before pin and Runtime creation`
    )
    assertSourceOrder(
      source,
      ["closeCheckpointer(", `releaseLocalThreadRunLease(threadId, "${owner}", ${runId})`],
      `${label} releases only after checkpointer close`
    )
  }
  assert(
    imRunner.includes('owner: "im"') &&
      imRunner.includes("prepareStandardThreadRuntimeFactory({") &&
      !imRunner.includes("createAgentRuntime("),
    "IM claims its local owner and can only construct a Runtime through the shared factory"
  )
  assertSourceOrder(
    imRunner,
    [
      "await closeCheckpointer(threadId)",
      'releaseLocalThreadRunLease(target.threadId, "im", runId)'
    ],
    "IM releases its local Thread lease only after checkpointer close"
  )
}

const tests: Array<() => void | Promise<void>> = [
  testForeignOwnerCannotSteal,
  testSameOwnerHandoffRequiresExactRunId,
  testLateReleaseIsIdentityFenced,
  testIdempotentClaimPreservesTimestampAndSnapshotIsolation,
  testReleaseNotificationIsIdentityFencedAndUnsubscribable,
  testRuntimeEntryPointArchitecture
]

async function main(): Promise<void> {
  for (const test of tests) {
    await test()
    console.log(`PASS ${test.name}`)
  }
  console.log("local-thread-run-lease.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
