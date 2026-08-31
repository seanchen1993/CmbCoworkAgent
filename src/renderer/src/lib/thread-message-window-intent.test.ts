import { describe, expect, it } from "vitest"
import {
  canCancelThreadMessageWindowIntent,
  createThreadMessageWindowIntentCoordinator
} from "./thread-message-window-intent"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe("thread message window latest-intent sequencing", () => {
  it("does not let an old durable reveal overwrite a newer return-to-bottom", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const oldTargetPage = deferred<string>()
    const latestPage = deferred<string>()
    const committed: string[] = []

    const targetToken = coordinator.begin("thread-a", "target")
    const targetCommit = oldTargetPage.promise.then((value) => {
      if (coordinator.isCurrent(targetToken)) committed.push(value)
    })
    const latestToken = coordinator.begin("thread-a", "latest")
    const latestCommit = latestPage.promise.then((value) => {
      if (coordinator.isCurrent(latestToken)) committed.push(value)
    })

    oldTargetPage.resolve("stale-target")
    latestPage.resolve("latest")
    await Promise.all([targetCommit, latestCommit])

    expect(committed).toEqual(["latest"])
  })

  it("cancels query A before query B and keeps other threads isolated", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const queryA = coordinator.begin("thread-a", "target")
    const threadB = coordinator.begin("thread-b", "target")

    expect(coordinator.cancel("thread-a", "target")).toBe(true)
    const queryB = coordinator.begin("thread-a", "target")

    expect(coordinator.isCurrent(queryA)).toBe(false)
    expect(coordinator.isCurrent(queryB)).toBe(true)
    expect(coordinator.isCurrent(threadB)).toBe(true)
    expect(coordinator.cancel("thread-a", "older")).toBe(false)
    expect(coordinator.isCurrent(queryB)).toBe(true)
  })

  it("keeps search B authoritative across search A -> return bottom -> search B", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const searchA = deferred<string>()
    const latest = deferred<string>()
    const searchB = deferred<string>()
    const committed: string[] = []
    const commitWhenCurrent = (
      token: ReturnType<typeof coordinator.begin>,
      request: ReturnType<typeof deferred<string>>
    ): Promise<void> =>
      request.promise.then((value) => {
        if (coordinator.isCurrent(token)) committed.push(value)
      })

    const searchAToken = coordinator.begin("thread-a", "target")
    const searchACommit = commitWhenCurrent(searchAToken, searchA)
    const latestToken = coordinator.begin("thread-a", "latest")
    const latestCommit = commitWhenCurrent(latestToken, latest)
    const searchBToken = coordinator.begin("thread-a", "target")
    const searchBCommit = commitWhenCurrent(searchBToken, searchB)

    latest.resolve("stale-latest")
    searchA.resolve("stale-search-a")
    searchB.resolve("search-b")
    await Promise.all([searchACommit, latestCommit, searchBCommit])

    expect(committed).toEqual(["search-b"])
  })

  it("cancels whichever window request is current on explicit user intent", () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()

    for (const kind of ["older", "gap", "latest", "target"] as const) {
      const token = coordinator.begin("thread-a", kind)
      expect(coordinator.cancel("thread-a")).toBe(true)
      expect(coordinator.isCurrent(token)).toBe(false)
      expect(coordinator.activeKind("thread-a")).toBeNull()
    }
  })

  it("fences a late checkpoint transcript after the initial page yields to user navigation", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const checkpoint = deferred<string>()
    const targetPage = deferred<string>()
    const committed: string[] = []
    const hydration = coordinator.begin("thread-a", "hydrate")

    if (coordinator.isCurrent(hydration)) committed.push("initial-128")
    const checkpointCommit = checkpoint.promise.then((value) => {
      if (coordinator.isCurrent(hydration)) committed.push(value)
    })
    const target = coordinator.begin("thread-a", "target")
    const targetCommit = targetPage.promise.then((value) => {
      if (coordinator.isCurrent(target)) committed.push(value)
    })

    checkpoint.resolve("stale-checkpoint")
    targetPage.resolve("target-window")
    await Promise.all([checkpointCommit, targetCommit])

    expect(committed).toEqual(["initial-128", "target-window"])
  })

  it("keeps checkpoint fallback current when the initial DB page rejects before first paint", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const hydration = coordinator.begin("thread-a", "hydrate")
    const checkpoint = deferred<string>()
    const committed: string[] = []
    const checkpointCommit = checkpoint.promise.then((value) => {
      if (coordinator.isCurrent(hydration)) committed.push(value)
    })

    const firstTranscriptPublished = false
    if (
      canCancelThreadMessageWindowIntent(
        coordinator.activeKind("thread-a"),
        firstTranscriptPublished
      )
    ) {
      coordinator.cancel("thread-a")
    }
    checkpoint.resolve("checkpoint-fallback")
    await checkpointCommit

    expect(coordinator.isCurrent(hydration)).toBe(true)
    expect(committed).toEqual(["checkpoint-fallback"])
  })

  it("allows user navigation to cancel late checkpoint work after the first DB page paints", async () => {
    const coordinator = createThreadMessageWindowIntentCoordinator()
    const hydration = coordinator.begin("thread-a", "hydrate")
    const checkpoint = deferred<string>()
    const committed = ["initial-128"]
    const checkpointCommit = checkpoint.promise.then((value) => {
      if (coordinator.isCurrent(hydration)) committed.push(value)
    })

    const firstTranscriptPublished = true
    if (
      canCancelThreadMessageWindowIntent(
        coordinator.activeKind("thread-a"),
        firstTranscriptPublished
      )
    ) {
      coordinator.cancel("thread-a")
    }
    checkpoint.resolve("stale-checkpoint")
    await checkpointCommit

    expect(coordinator.isCurrent(hydration)).toBe(false)
    expect(committed).toEqual(["initial-128"])
  })
})
