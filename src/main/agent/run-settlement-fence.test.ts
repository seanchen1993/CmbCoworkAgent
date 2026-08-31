import { describe, expect, it, vi } from "vitest"
import {
  canUseBoundedCheckpointRecovery,
  isPathInsideAnyDirectory,
  OwnedClaimFence,
  runSettlementPhases,
  SingleFlightBatchCoalescer,
  TimedOutPredecessorFence
} from "./run-settlement-fence"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("timed-out predecessor recovery fence", () => {
  it("keeps a timed-out A fenced after B settles until A itself settles", async () => {
    const fence = new TimedOutPredecessorFence()
    const predecessorA = deferred()
    const replacementB = deferred()
    fence.track("thread", predecessorA.promise)

    replacementB.resolve()
    await replacementB.promise
    expect(
      canUseBoundedCheckpointRecovery("settled", fence.hasPending("thread"))
    ).toBe(false)

    predecessorA.resolve()
    await predecessorA.promise
    await Promise.resolve()
    expect(
      canUseBoundedCheckpointRecovery("settled", fence.hasPending("thread"))
    ).toBe(true)
  })

  it("never authorizes a timed-out immediate replacement", () => {
    expect(canUseBoundedCheckpointRecovery("timed_out", false)).toBe(false)
  })
})

describe("run settlement phases", () => {
  it("continues after cleanup failures and releases settlement even when diagnostics throw", async () => {
    const calls: string[] = []

    await runSettlementPhases({
      phases: [
        {
          name: "flush-transcript",
          run: () => {
            calls.push("flush-transcript")
            throw new Error("database unavailable")
          }
        },
        {
          name: "release-controller",
          run: () => {
            calls.push("release-controller")
          }
        }
      ],
      resolveSettlement: () => {
        calls.push("resolve-settlement")
      },
      onPhaseError: () => {
        calls.push("report-error")
        throw new Error("logger failed")
      }
    })

    expect(calls).toEqual([
      "flush-transcript",
      "report-error",
      "release-controller",
      "resolve-settlement"
    ])
  })

  it("bounds a stalled phase before continuing and releasing settlement", async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const errors: Array<{ phaseName: string; error: unknown }> = []

    try {
      const settlement = runSettlementPhases({
        phases: [
          {
            name: "restore-notifications",
            run: () => new Promise<void>(() => {}),
            timeoutMs: 1_000
          },
          {
            name: "release-controller",
            run: () => {
              calls.push("release-controller")
            }
          }
        ],
        resolveSettlement: () => {
          calls.push("resolve-settlement")
        },
        onPhaseError: (phaseName, error) => errors.push({ phaseName, error })
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await settlement

      expect(calls).toEqual(["release-controller", "resolve-settlement"])
      expect(errors).toHaveLength(1)
      expect(errors[0].phaseName).toBe("restore-notifications")
      expect(errors[0].error).toMatchObject({ name: "RunSettlementPhaseTimeoutError" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips successor-owned cleanup, including when its ownership guard fails", async () => {
    const calls: string[] = []
    const errors: string[] = []

    await runSettlementPhases({
      phases: [
        {
          name: "clear-terminal-queue",
          shouldRun: () => false,
          run: () => {
            calls.push("clear-terminal-queue")
          }
        },
        {
          name: "clear-terminal-acls",
          shouldRun: () => {
            throw new Error("ownership unavailable")
          },
          run: () => {
            calls.push("clear-terminal-acls")
          }
        }
      ],
      resolveSettlement: () => calls.push("resolve-settlement"),
      onPhaseError: (phaseName) => errors.push(phaseName)
    })

    expect(calls).toEqual(["resolve-settlement"])
    expect(errors).toEqual(["clear-terminal-acls:guard"])
  })

  it("runs terminal cleanup only while the physical run has no successor", async () => {
    let hasSuccessor = false
    const calls: string[] = []

    await runSettlementPhases({
      phases: [
        {
          name: "clear-current-terminal-queue",
          shouldRun: () => !hasSuccessor,
          run: () => {
            calls.push("clear-current-terminal-queue")
          }
        },
        {
          name: "publish-successor",
          run: () => {
            hasSuccessor = true
          }
        },
        {
          name: "clear-successor-owned-acls",
          shouldRun: () => !hasSuccessor,
          run: () => {
            calls.push("clear-successor-owned-acls")
          }
        }
      ],
      resolveSettlement: () => calls.push("resolve-settlement")
    })

    expect(calls).toEqual(["clear-current-terminal-queue", "resolve-settlement"])
  })

  it("releases an owned workflow claim before a successor can claim it", async () => {
    let claimOwner: "predecessor" | "successor" | undefined = "predecessor"
    const calls: string[] = []

    await runSettlementPhases({
      phases: [
        {
          name: "release-workflow-claim",
          shouldRun: () => claimOwner === "predecessor",
          run: () => {
            claimOwner = undefined
            calls.push("release-workflow-claim")
          }
        },
        {
          name: "publish-successor",
          run: () => {
            if (claimOwner === undefined) claimOwner = "successor"
            calls.push("publish-successor")
          }
        }
      ],
      resolveSettlement: () => calls.push("resolve-settlement")
    })

    expect(claimOwner).toBe("successor")
    expect(calls).toEqual([
      "release-workflow-claim",
      "publish-successor",
      "resolve-settlement"
    ])

    await runSettlementPhases({
      phases: [
        {
          name: "late-predecessor-clear",
          shouldRun: () => claimOwner === "predecessor",
          run: () => {
            claimOwner = undefined
          }
        }
      ],
      resolveSettlement: () => {}
    })
    expect(claimOwner).toBe("successor")
  })

  it("preserves transcript and tool-call retry state when the strict flush fails", async () => {
    let transcriptPending = true
    let toolCallAccumulatorPending = true
    const transcriptFlushSucceeded = false

    await runSettlementPhases({
      phases: [
        {
          name: "flush-stream-transcript",
          run: () => {
            throw new Error("checkpoint write failed")
          }
        },
        {
          name: "discard-tool-call-accumulator",
          shouldRun: () => transcriptFlushSucceeded,
          run: () => {
            transcriptPending = false
            toolCallAccumulatorPending = false
          }
        }
      ],
      resolveSettlement: () => {}
    })

    expect(transcriptPending).toBe(true)
    expect(toolCallAccumulatorPending).toBe(true)
  })

  it("bounds a stalled fork-boundary write and observes a late rejection", async () => {
    vi.useFakeTimers()
    const lateBoundary = deferred()
    const calls: string[] = []

    try {
      const settlement = runSettlementPhases({
        phases: [
          {
            name: "persist-fork-boundary",
            run: () => lateBoundary.promise.then(() => Promise.reject(new Error("late failure"))),
            timeoutMs: 1_000
          },
          {
            name: "publish-terminal-event",
            run: () => {
              calls.push("publish-terminal-event")
            }
          }
        ],
        resolveSettlement: () => calls.push("released")
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await settlement
      expect(calls).toEqual(["publish-terminal-event", "released"])

      lateBoundary.resolve()
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("owned claim fence", () => {
  it("does not let a late predecessor clear a successor claim", () => {
    const fence = new OwnedClaimFence<string, string>()
    const releases: string[] = []

    fence.claim("workflow-run", "predecessor")
    fence.claim("workflow-run", "successor")

    expect(
      fence.release("workflow-run", "predecessor", () => releases.push("predecessor"))
    ).toBe(false)
    expect(
      fence.release("workflow-run", "successor", () => releases.push("successor"))
    ).toBe(true)
    expect(releases).toEqual(["successor"])
  })
})

describe("directory path matching", () => {
  const workspacePath = "C:\\work\\project"
  const memoryDirs = ["C:\\work\\project\\.memory"]

  it("matches Windows paths case-insensitively and resolves relative writes", () => {
    expect(
      isPathInsideAnyDirectory(
        "c:\\WORK\\PROJECT\\.MEMORY\\facts.md",
        memoryDirs,
        workspacePath,
        "win32"
      )
    ).toBe(true)
    expect(
      isPathInsideAnyDirectory(".memory\\notes.md", memoryDirs, workspacePath, "win32")
    ).toBe(true)
  })

  it("requires a directory boundary instead of matching prefix siblings", () => {
    expect(
      isPathInsideAnyDirectory(
        "C:\\work\\project\\.memory-backup\\facts.md",
        memoryDirs,
        workspacePath,
        "win32"
      )
    ).toBe(false)
  })

  it("filters only the direct-memory turn from a mixed pending batch", () => {
    const turns = [
      { conversation: "B", fileWritePaths: [".memory\\b.md"] },
      { conversation: "C", fileWritePaths: ["src\\c.ts"] }
    ]
    const turnsToSummarize = turns.filter(
      (turn) =>
        !turn.fileWritePaths.some((filePath) =>
          isPathInsideAnyDirectory(filePath, memoryDirs, workspacePath, "win32")
        )
    )

    expect(turnsToSummarize.map((turn) => turn.conversation)).toEqual(["C"])
  })
})

describe("single-flight batch coalescer", () => {
  it("processes B and C together after A without dropping the intermediate batch", async () => {
    const scheduled: Array<() => Promise<void>> = []
    const activeA = deferred()
    const processed: string[][] = []
    const coalescer = new SingleFlightBatchCoalescer<string, string[]>({
      schedule: (operation) => scheduled.push(operation)
    })
    const merge = (current: string[], incoming: string[]): string[] => [
      ...current,
      ...incoming
    ]
    const worker = async (batch: string[]): Promise<void> => {
      processed.push(batch)
      if (batch.includes("A")) await activeA.promise
    }

    coalescer.enqueue("thread", ["A"], merge, worker)
    expect(scheduled).toHaveLength(1)
    const drain = scheduled[0]()
    await Promise.resolve()
    expect(processed).toEqual([["A"]])

    coalescer.enqueue("thread", ["B"], merge, worker)
    coalescer.enqueue("thread", ["C"], merge, worker)
    expect(scheduled).toHaveLength(1)

    activeA.resolve()
    await drain
    expect(processed).toEqual([["A"], ["B", "C"]])
    expect(coalescer.hasPending("thread")).toBe(false)
  })

  it("keeps pending work isolated when the same thread changes memory scope", async () => {
    const scheduled: Array<() => Promise<void>> = []
    const processed: string[][] = []
    const coalescer = new SingleFlightBatchCoalescer<string, string[]>({
      schedule: (operation) => scheduled.push(operation)
    })
    const merge = (current: string[], incoming: string[]): string[] => [
      ...current,
      ...incoming
    ]
    const worker = async (batch: string[]): Promise<void> => {
      processed.push(batch)
    }

    coalescer.enqueue("thread\0workspace-a", ["A"], merge, worker)
    coalescer.enqueue("thread\0workspace-b", ["B"], merge, worker)
    expect(scheduled).toHaveLength(2)

    await Promise.all(scheduled.map((operation) => operation()))
    expect(processed).toEqual([["A"], ["B"]])
  })

  it("filters direct-memory evidence per turn without dropping its queued sibling", async () => {
    interface Turn {
      conversation: string
      wroteMemory: boolean
    }
    const scheduled: Array<() => Promise<void>> = []
    const activeA = deferred()
    const summarized: string[][] = []
    const coalescer = new SingleFlightBatchCoalescer<string, Turn[]>({
      schedule: (operation) => scheduled.push(operation)
    })
    const merge = (current: Turn[], incoming: Turn[]): Turn[] => [...current, ...incoming]
    const worker = async (batch: Turn[]): Promise<void> => {
      summarized.push(
        batch.filter((turn) => !turn.wroteMemory).map((turn) => turn.conversation)
      )
      if (batch.some((turn) => turn.conversation === "A")) await activeA.promise
    }

    coalescer.enqueue(
      "thread\0workspace",
      [{ conversation: "A", wroteMemory: false }],
      merge,
      worker
    )
    const drain = scheduled[0]()
    await Promise.resolve()
    coalescer.enqueue(
      "thread\0workspace",
      [{ conversation: "B", wroteMemory: true }],
      merge,
      worker
    )
    coalescer.enqueue(
      "thread\0workspace",
      [{ conversation: "C", wroteMemory: false }],
      merge,
      worker
    )

    activeA.resolve()
    await drain
    expect(summarized).toEqual([["A"], ["C"]])
  })

  it("releases its keyed state when scheduling fails", () => {
    const errors: unknown[] = []
    const coalescer = new SingleFlightBatchCoalescer<string, string[]>({
      schedule: () => {
        throw new Error("scheduler unavailable")
      },
      onError: (error) => errors.push(error)
    })

    coalescer.enqueue(
      "thread",
      ["A"],
      (current, incoming) => [...current, ...incoming],
      async () => {}
    )

    expect(coalescer.hasPending("thread")).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it("keeps optional batch merge failures out of the foreground caller", async () => {
    const scheduled: Array<() => Promise<void>> = []
    const errors: unknown[] = []
    const processed: string[][] = []
    const coalescer = new SingleFlightBatchCoalescer<string, string[]>({
      schedule: (operation) => scheduled.push(operation),
      onError: (error) => errors.push(error)
    })
    const worker = async (batch: string[]): Promise<void> => {
      processed.push(batch)
    }

    coalescer.enqueue("thread", ["A"], (current, incoming) => [
      ...current,
      ...incoming
    ], worker)
    expect(() =>
      coalescer.enqueue(
        "thread",
        ["B"],
        () => {
          throw new Error("merge failed")
        },
        worker
      )
    ).not.toThrow()

    await scheduled[0]()
    expect(processed).toEqual([["A"]])
    expect(errors).toHaveLength(1)
    expect(coalescer.hasPending("thread")).toBe(false)
  })
})
