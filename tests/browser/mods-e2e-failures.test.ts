import { describe, expect, it } from "vitest"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "../support/mods-e2e-failures"

describe("Mods E2E failure collection", () => {
  it("rejects with the original undefined reason", async () => {
    let rejected = false
    let actual: unknown = "not rejected"
    try {
      await runModsE2eWithFailures(() => {
        throw undefined
      })
    } catch (reason) {
      rejected = true
      actual = reason
    }
    expect(rejected).toBe(true)
    expect(actual).toBeUndefined()
  })

  it.each([
    { label: "undefined", reason: undefined },
    { label: "Error", reason: Error("Original body failure") }
  ])("keeps the $label body reason before every cleanup failure", async ({ reason }) => {
    const screenshot = Error("Screenshot failure")
    const resultWrite = Error("Result write failure")
    const appClose = Error("App close failure")
    const modelClose = Error("Model close failure")
    const echoRead = Error("Echo read failure")
    const evidenceWrite = Error("Evidence write failure")
    const steps: string[] = []
    const actual: unknown = await runModsE2eWithFailures(async failures => {
      try {
        throw reason
      } catch (bodyReason) {
        failures.push(bodyReason)
        await attemptModsE2eCleanup(failures, () => {
          steps.push("screenshot")
          throw screenshot
        })
      } finally {
        await attemptModsE2eCleanup(failures, () => {
          steps.push("result")
          throw resultWrite
        })
        await attemptModsE2eCleanup(failures, async () => {
          steps.push("app")
          await Promise.resolve()
          throw appClose
        })
        await attemptModsE2eCleanup(failures, () => {
          steps.push("model")
          throw modelClose
        })
        await attemptModsE2eCleanup(failures, () => {
          steps.push("echo")
          throw echoRead
        })
        await attemptModsE2eCleanup(failures, () => {
          steps.push("evidence")
          throw evidenceWrite
        })
      }
    }).then(
      () => {
        throw Error("Expected collected failures")
      },
      failure => failure
    )
    if (!(actual instanceof AggregateError)) throw Error("Expected AggregateError")
    expect(actual.errors).toEqual([
      reason, screenshot, resultWrite, appClose, modelClose, echoRead, evidenceWrite
    ])
    expect(actual.cause).toBe(reason)
    expect(steps).toEqual(["screenshot", "result", "app", "model", "echo", "evidence"])
  })

  it("reports cleanup failure after a focus returns early", async () => {
    const appClose = Error("Early focus app close failure")
    const steps: string[] = []
    const actual: unknown = await runModsE2eWithFailures(async failures => {
      try {
        steps.push("focus")
        return
      } finally {
        await attemptModsE2eCleanup(failures, () => {
          steps.push("app")
          throw appClose
        })
        await attemptModsE2eCleanup(failures, () => {
          steps.push("model")
        })
      }
    }).then(
      () => {
        throw Error("Expected early focus cleanup failure")
      },
      reason => reason
    )
    expect(actual).toBe(appClose)
    expect(steps).toEqual(["focus", "app", "model"])
  })

  it("continues cleanup after synchronous and asynchronous undefined failures", async () => {
    const failures: unknown[] = []
    const steps: number[] = []
    expect(await attemptModsE2eCleanup(failures, () => {
      steps.push(1)
      throw undefined
    })).toBe(false)
    expect(await attemptModsE2eCleanup(failures, async () => {
      steps.push(2)
      await Promise.resolve()
      throw undefined
    })).toBe(false)
    expect(await attemptModsE2eCleanup(failures, () => {
      steps.push(3)
    })).toBe(true)
    expect(failures).toEqual([undefined, undefined])
    expect(steps).toEqual([1, 2, 3])
  })

  it("resolves when the body and every cleanup succeed", async () => {
    const steps: string[] = []
    await expect(runModsE2eWithFailures(async failures => {
      steps.push("body")
      await attemptModsE2eCleanup(failures, () => {
        steps.push("app")
      })
      await attemptModsE2eCleanup(failures, async () => {
        await Promise.resolve()
        steps.push("model")
      })
    })).resolves.toBeUndefined()
    expect(steps).toEqual(["body", "app", "model"])
  })
})
