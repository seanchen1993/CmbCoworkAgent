import { describe, expect, it, vi } from "vitest"
import type {
  DevelopmentBusinessStatus,
  DevelopmentBusinessTrialStatus
} from "../../../shared/mods/development"
import type { Thread, ThreadMessagesPage } from "../../../main/types"
import {
  businessCreatorTrialScope,
  businessCreatorTrialView,
  businessCreatorTrialSessionView,
  readBusinessCreatorTrialHistory
} from "./business-creator-trial-view"

const digest = "a".repeat(64)
const review: NonNullable<DevelopmentBusinessStatus["review"]> = {
  planId: "candidate-plan",
  phase: "needs-approval",
  name: "business-candidate",
  version: "1.0.0",
  digest,
  copyId: "copy",
  steps: [],
  diagnostics: [],
  canConfirm: true
}
function trial(
  change: Partial<DevelopmentBusinessTrialStatus> = {}
): DevelopmentBusinessTrialStatus {
  return {
    id: "host-owned-trial",
    version: 7,
    planId: review.planId,
    digest,
    name: review.name,
    goal: "Verify the real business flow",
    phase: "needs-confirmation",
    canPrepare: true,
    canStart: false,
    canStop: false,
    canRefresh: true,
    diagnostics: [],
    ...change
  }
}

function historyFixture() {
  const session = {
    threadId: "original-prd-thread",
    startedAt: "2026-10-18 13:43:59",
    incarnation: { token: "native-birth", legacyCreatedAt: 1234 }
  }
  const observation = {
    projectId: "trial",
    featureId: "feature",
    runId: "run",
    status: "running",
    workspace: "/private/workspace",
    threadId: session.threadId,
    sessions: [session]
  }
  const thread: Thread = {
    thread_id: session.threadId,
    created_at: new Date(1234),
    updated_at: new Date(1234),
    status: "idle",
    metadata: {
      workspacePath: observation.workspace,
      cmb_thread_incarnation: session.incarnation.token,
      harnessFeature: { projectId: "trial", slug: "feature", runId: "run" }
    }
  }
  const page: ThreadMessagesPage = {
    messages: [
      {
        id: "original-message",
        role: "tool",
        created_at: new Date(1234),
        content: '{"new_checkpoint":"prd_done"}'
      }
    ],
    beforeOrdinal: null,
    beforeMessageId: null,
    hasMore: false,
    total: 1
  }
  return { session, observation, thread, page }
}

describe("trial live versus durable-history presentation", () => {
  it("keeps a selected PRD history while the original controller moves to another thread", () => {
    const f = historyFixture()
    const initial = trial({ phase: "running", observation: f.observation })
    expect(businessCreatorTrialSessionView(initial).mode).toBe("live")
    const ended = { ...f.session, endedAt: "2026-10-18 13:44:43", outcome: "success" }
    const next = { ...f.session, threadId: "actual-next-thread" }
    const advanced = trial({
      phase: "running",
      observation: { ...f.observation, threadId: next.threadId, sessions: [ended, next] }
    })
    const pinned = businessCreatorTrialSessionView(advanced, f.session.threadId)
    expect(pinned.selected).toBe(ended)
    expect(pinned.mode).toBe("history")
    expect(businessCreatorTrialSessionView(advanced, next.threadId).mode).toBe("live")
    expect(advanced.observation!.threadId).toBe(next.threadId)
  })
  it("never mounts live presentation for a finished current session or cancelled trial", () => {
    const f = historyFixture()
    const ended = trial({
      phase: "running",
      observation: {
        ...f.observation,
        sessions: [{ ...f.session, endedAt: "ended", outcome: "success" }]
      }
    })
    expect(businessCreatorTrialSessionView(ended).mode).toBe("history")
    expect(
      businessCreatorTrialSessionView(trial({ phase: "cancelled", observation: f.observation }))
        .mode
    ).toBe("history")
  })
  it("does not silently replace a selected session omitted by a bounded history page", () => {
    const f = historyFixture()
    expect(
      businessCreatorTrialSessionView(
        trial({ phase: "running", observation: f.observation }),
        "older-truncated-thread"
      )
    ).toEqual({ selected: undefined, mode: "history" })
  })
  it("uses only original native get/page/get readers and retains durable content", async () => {
    const f = historyFixture()
    const api = { get: vi.fn(async () => f.thread), getMessagesPage: vi.fn(async () => f.page) }
    expect(await readBusinessCreatorTrialHistory(f.observation, f.session, api)).toBe(f.page)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.getMessagesPage).toHaveBeenCalledWith(f.session.threadId, {
      limit: 40,
      byteBudget: 256 * 1024
    })
  })
  it.each(["project", "feature", "run", "workspace", "birth"])(
    "rejects changed native %s before requesting history",
    async (field) => {
      const f = historyFixture()
      const metadata = f.thread.metadata!
      const feature = metadata.harnessFeature as Record<string, unknown>
      if (field === "project") feature.projectId = "foreign"
      if (field === "feature") feature.slug = "foreign"
      if (field === "run") feature.runId = "foreign"
      if (field === "workspace") metadata.workspacePath = "/foreign"
      if (field === "birth") metadata.cmb_thread_incarnation = "replacement"
      const api = { get: vi.fn(async () => f.thread), getMessagesPage: vi.fn(async () => f.page) }
      await expect(readBusinessCreatorTrialHistory(f.observation, f.session, api)).rejects.toThrow(
        "BUSINESS_TRIAL_HISTORY_THREAD_CHANGED"
      )
      expect(api.getMessagesPage).not.toHaveBeenCalled()
    }
  )
  it("discards a completed native page when its exact thread is replaced during the await", async () => {
    const f = historyFixture()
    let reads = 0
    const api = {
      get: vi.fn(async () =>
        ++reads === 1
          ? f.thread
          : {
              ...f.thread,
              metadata: { ...f.thread.metadata, cmb_thread_incarnation: "replacement" }
            }
      ),
      getMessagesPage: vi.fn(async () => f.page)
    }
    await expect(readBusinessCreatorTrialHistory(f.observation, f.session, api)).rejects.toThrow(
      "BUSINESS_TRIAL_HISTORY_THREAD_CHANGED"
    )
    expect(api.getMessagesPage).toHaveBeenCalledOnce()
  })
})

describe("business creator trial display boundaries", () => {
  it("starts with a native request instead of inventing a trial or preparing without confirmation", () => {
    expect(businessCreatorTrialView(review)).toEqual({
      current: false,
      canRequest: true,
      canPrepare: false,
      showConfiguration: false
    })
    expect(businessCreatorTrialView(review, trial()).canPrepare).toBe(true)
    expect(businessCreatorTrialView(review, trial({ canPrepare: false })).canPrepare).toBe(false)
  })

  it.each(["plan", "digest"])(
    "does not borrow the previous candidate's %s confirmation or configuration",
    (changed) => {
      const old = trial({
        phase: "ready",
        canStart: true,
        ...(changed === "plan" ? { planId: "other-plan" } : { digest: "b".repeat(64) })
      })
      const next = businessCreatorTrialView(review, old)
      expect(next.current).toBe(false)
      expect(next.canPrepare).toBe(false)
      expect(next.showConfiguration).toBe(false)
    }
  )

  it.each(["unknown", "preparing", "starting", "running"] as const)(
    "does not expose start/configuration or a replacement request for an old %s trial",
    (phase) => {
      const old = trial({ planId: "old-plan", phase, canPrepare: true, canStart: true })
      expect(businessCreatorTrialView(review, old)).toEqual({
        current: false,
        canRequest: false,
        canPrepare: false,
        showConfiguration: false
      })
      expect(
        businessCreatorTrialView(review, { ...old, planId: review.planId }).showConfiguration
      ).toBe(false)
    }
  )

  it("requires settling a stop-capable original owner even if its display phase says failed", () => {
    expect(
      businessCreatorTrialView(
        review,
        trial({
          planId: "old-plan",
          phase: "failed",
          canStop: true
        })
      ).canRequest
    ).toBe(false)
    expect(
      businessCreatorTrialView(
        review,
        trial({
          planId: "old-plan",
          phase: "cancelled",
          canStop: false
        })
      ).canRequest
    ).toBe(true)
  })

  it.each(["completed", "failed", "cancelled"] as const)(
    "offers a fresh explicit request after %s without exposing the old start or configuration",
    (phase) => {
      const view = businessCreatorTrialView(
        review,
        trial({ phase, canPrepare: true, canStart: true })
      )
      expect(view.current).toBe(true)
      expect(view.canRequest).toBe(true)
      expect(view.canPrepare).toBe(false)
      expect(view.showConfiguration).toBe(false)
      expect(businessCreatorTrialView(review, trial({ phase, canStop: true })).canRequest).toBe(
        false
      )
    }
  )

  it("passes the captured native CAS version and candidate digest without substituting package identity", () => {
    const record = trial({ packageDigest: "b".repeat(64) })
    const input = businessCreatorTrialScope("creator-thread", "C:/private/creator", record)
    record.version++
    expect(input).toEqual({
      threadId: "creator-thread",
      expectedWorkspace: "C:/private/creator",
      trialId: "host-owned-trial",
      digest,
      expectedVersion: 7
    })
    expect(input).not.toHaveProperty("projectId")
    expect(input).not.toHaveProperty("pluginId")
    expect(input).not.toHaveProperty("packageDigest")
  })
})
