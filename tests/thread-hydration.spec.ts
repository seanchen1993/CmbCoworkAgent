import assert from "node:assert/strict"
import {
  CoordinatorWorkerRequestCache,
  ForegroundHydrationGeneration,
  isThreadHistoryHydrationAttemptActive,
  shouldKeepMainTranscriptLoadingAfterPage,
  type ForegroundHydrationToken
} from "../src/renderer/src/lib/thread-hydration"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function foregroundRaceContract(): Promise<void> {
  const generation = new ForegroundHydrationGeneration("A")
  const applied: string[] = []
  const loads = new Map<string, ReturnType<typeof deferred<string>>>()

  const start = (threadId: string, token: ForegroundHydrationToken): Promise<void> => {
    const load = deferred<string>()
    loads.set(threadId, load)
    return load.promise.then((payload) => {
      if (generation.isCurrent(token)) applied.push(payload)
    })
  }

  const tokenA = generation.capture("A")
  assert.ok(tokenA)
  const loadA = start("A", tokenA)
  generation.transition("B")
  assert.equal(
    isThreadHistoryHydrationAttemptActive(
      { loadGeneration: 1, foregroundToken: tokenA },
      1,
      generation
    ),
    false,
    "a stale foreground load must not keep an inactive loading shell out of the LRU"
  )
  const tokenB = generation.capture("B")
  assert.ok(tokenB)
  const loadB = start("B", tokenB)
  generation.transition("C")
  const tokenC = generation.capture("C")
  assert.ok(tokenC)
  const loadC = start("C", tokenC)

  loads.get("B")?.resolve("B")
  loads.get("A")?.resolve("A")
  loads.get("C")?.resolve("C")
  await Promise.all([loadA, loadB, loadC])
  assert.deepEqual(applied, ["C"], "only the latest foreground hydration may apply")

  generation.transition("A")
  const reopenedA = generation.capture("A")
  assert.ok(reopenedA)
  assert.notEqual(
    reopenedA.generation,
    tokenA.generation,
    "reopening A must allocate a new generation instead of reviving its stale load"
  )
}

async function coordinatorInFlightContract(): Promise<void> {
  const cache = new CoordinatorWorkerRequestCache<string[]>()
  const calls: boolean[] = []
  const first = deferred<string[]>()
  const load = (subscribeUpdates: boolean): Promise<string[]> => {
    calls.push(subscribeUpdates)
    return first.promise
  }

  const foreground = cache.request("thread-1", true, load)
  const history = cache.request("thread-1", false, load)
  assert.equal(foreground, history, "foreground bind and history restore must share one request")
  assert.deepEqual(calls, [true])
  first.resolve(["worker"])
  assert.deepEqual(await history, ["worker"])

  const upgradeCache = new CoordinatorWorkerRequestCache<string[]>()
  const snapshot = deferred<string[]>()
  const subscription = deferred<string[]>()
  const upgradeCalls: boolean[] = []
  const upgradeLoad = (subscribeUpdates: boolean): Promise<string[]> => {
    upgradeCalls.push(subscribeUpdates)
    return subscribeUpdates ? subscription.promise : snapshot.promise
  }
  const snapshotRequest = upgradeCache.request("thread-2", false, upgradeLoad)
  const subscriptionRequest = upgradeCache.request("thread-2", true, upgradeLoad)
  const duplicateSubscription = upgradeCache.request("thread-2", true, upgradeLoad)
  assert.equal(subscriptionRequest, duplicateSubscription)
  assert.deepEqual(
    upgradeCalls,
    [false],
    "the upgrade must wait for the snapshot already in flight"
  )
  snapshot.resolve([])
  await snapshotRequest
  await Promise.resolve()
  assert.deepEqual(upgradeCalls, [false, true], "only one subscription upgrade may be issued")
  subscription.resolve(["subscribed-worker"])
  assert.deepEqual(await subscriptionRequest, ["subscribed-worker"])
}

async function main(): Promise<void> {
  assert.equal(
    shouldKeepMainTranscriptLoadingAfterPage({ succeeded: true, total: 0 }),
    true,
    "an empty DB page must wait for its legacy checkpoint fallback"
  )
  assert.equal(
    shouldKeepMainTranscriptLoadingAfterPage({ succeeded: true, total: 1 }),
    false,
    "a non-empty DB page releases first-screen loading"
  )
  assert.equal(
    shouldKeepMainTranscriptLoadingAfterPage({ succeeded: false }),
    false,
    "a failed DB page must release loading instead of permanently blocking the UI and LRU"
  )
  await foregroundRaceContract()
  await coordinatorInFlightContract()
  console.log("thread hydration race contracts passed")
}

void main()
