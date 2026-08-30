import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../storage", () => ({ getUserInfo: () => null }))
vi.mock("../org-levels", () => ({ deriveUpperOrgLv1FromPath: () => "" }))
vi.mock("./service", () => ({
  getHarnessLeanTokenConfig: () => ({ leanToken: "test-token" })
}))

import {
  HarnessEnterpriseRequestCancelledError,
  cancelAllHarnessEnterpriseRequestScopes,
  cancelHarnessEnterpriseRequestScope,
  getEnterpriseProjectDetails
} from "./enterprise-projects"
import { HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS } from "./enterprise-projection-protocol"

describe("Harness enterprise request cancellation", () => {
  const requestSignals: AbortSignal[] = []

  beforeEach(() => {
    requestSignals.length = 0
    vi.stubEnv("VITE_ENTERPRISE_PROJECT_LIST", "https://example.test/projects")
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal
        if (!signal) throw new Error("expected fetch signal")
        requestSignals.push(signal)
        return new Promise<Response>((_resolve, reject) => {
          const rejectFromAbort = (): void => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"))
          }
          if (signal.aborted) rejectFromAbort()
          else signal.addEventListener("abort", rejectFromAbort, { once: true })
        })
      })
    )
  })

  afterEach(() => {
    cancelAllHarnessEnterpriseRequestScopes()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it("aborts the prior fetch when the same renderer lane is superseded", async () => {
    const first = getEnterpriseProjectDetails(
      { prjCodeList: ["PROJECT-1"] },
      { scope: "renderer:7:enterprise-details:selected" }
    ).catch((error: unknown) => error)
    const second = getEnterpriseProjectDetails(
      { prjCodeList: ["PROJECT-2"] },
      { scope: "renderer:7:enterprise-details:selected" }
    ).catch((error: unknown) => error)

    expect(await first).toBeInstanceOf(HarnessEnterpriseRequestCancelledError)
    expect(requestSignals[0]?.aborted).toBe(true)
    expect(requestSignals[1]?.aborted).toBe(false)

    cancelHarnessEnterpriseRequestScope("renderer:7:enterprise-details:selected")
    expect(await second).toBeInstanceOf(HarnessEnterpriseRequestCancelledError)
    expect(requestSignals[1]?.aborted).toBe(true)
  })

  it("propagates an external AbortSignal into the active fetch", async () => {
    const controller = new AbortController()
    const pending = getEnterpriseProjectDetails(
      { prjCodeList: ["PROJECT-1"] },
      {
        scope: "renderer:9:enterprise-details:selected",
        signal: controller.signal
      }
    ).catch((error: unknown) => error)
    controller.abort(new Error("view unmounted"))

    expect(await pending).toBeInstanceOf(HarnessEnterpriseRequestCancelledError)
    expect(requestSignals[0]?.aborted).toBe(true)
  })

  it("keeps board-batch and selected-project lanes independent", async () => {
    const boardBatch = getEnterpriseProjectDetails(
      { prjCodeList: ["PROJECT-1"] },
      { scope: "harness-enterprise:7:board-batch" }
    ).catch((error: unknown) => error)
    const selected = getEnterpriseProjectDetails(
      { prjCodeList: ["PROJECT-2"] },
      { scope: "harness-enterprise:7:selected-project" }
    ).catch((error: unknown) => error)

    expect(requestSignals).toHaveLength(2)
    expect(requestSignals.every((signal) => !signal.aborted)).toBe(true)

    cancelHarnessEnterpriseRequestScope("harness-enterprise:7:board-batch")
    expect(await boardBatch).toBeInstanceOf(HarnessEnterpriseRequestCancelledError)
    expect(requestSignals[0]?.aborted).toBe(true)
    expect(requestSignals[1]?.aborted).toBe(false)

    cancelHarnessEnterpriseRequestScope("harness-enterprise:7:selected-project")
    expect(await selected).toBeInstanceOf(HarnessEnterpriseRequestCancelledError)
  })

  it("rejects an oversized raw project-code array before traversing it or fetching", async () => {
    const oversized = new Array<string>(HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS + 1)
    Object.defineProperty(oversized, 0, {
      get() {
        throw new Error("oversized input was traversed")
      }
    })

    await expect(
      getEnterpriseProjectDetails({ prjCodeList: oversized })
    ).rejects.toThrow(`单次最多查询 ${HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS} 个项目`)
    expect(fetch).not.toHaveBeenCalled()
  })
})
