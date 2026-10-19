import { describe, expect, it } from "vitest"
import type { ManagedRunEvent } from "../../../shared/harness-board-types"
import { projectCreatorBusinessTrialSessions as project } from "./creator-business-trial-sessions"

const owner = {
  projectId: "native-trial",
  featureId: "native-feature",
  runId: "native-run",
  workspacePath: "C:/private/trial/workspace"
}
function event(threadId: string, change: Partial<ManagedRunEvent> = {}): ManagedRunEvent {
  return {
    version: 2.5,
    eventId: `event-${threadId}`,
    runId: owner.runId,
    type: "session_started",
    scope: "stage",
    createTime: "2026-10-18 13:43:59",
    targetThreadId: threadId,
    nodeId: "biz.prd",
    summary: "Native session started",
    ...change
  }
}
function row(token = "original-birth", change: Record<string, unknown> = {}) {
  return {
    created_at: 1234,
    metadata: JSON.stringify({
      workspacePath: owner.workspacePath,
      harnessFeature: { projectId: owner.projectId, slug: owner.featureId, runId: owner.runId },
      cmb_thread_incarnation: token,
      ...change
    })
  }
}

describe("native creator trial session history projection", () => {
  it("projects actual start and terminal facts with their original birth identity", () => {
    const result = project(
      owner,
      {
        hasMore: false,
        events: [
          event("prd"),
          event("prd", {
            type: "managed_agent_turn_ended",
            targetThreadId: undefined,
            threadId: "prd",
            outcome: "success",
            endReason: { code: "normal" },
            createTime: "2026-10-18 13:44:43"
          }),
          event("specs")
        ]
      },
      () => row()
    )
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0]).toMatchObject({
      threadId: "prd",
      outcome: "success",
      endReason: "normal",
      incarnation: { token: "original-birth", legacyCreatedAt: 1234 }
    })
    expect(result.sessions[1].outcome).toBeUndefined()
    expect(result.sessionsTruncated).toBe(false)
  })
  it("never reads an unrelated run's journal thread", () => {
    const seen: string[] = []
    const result = project(
      owner,
      { events: [event("foreign", { runId: "other-run" }), event("own")], hasMore: false },
      (id) => {
        seen.push(id)
        return row()
      }
    )
    expect(seen).toEqual(["own", "own"])
    expect(result.sessions.map(({ threadId }) => threadId)).toEqual(["own"])
  })
  it("keeps an actual same-thread native continuation live until its own terminal record", () => {
    const events = [
      event("one"),
      event("one", {
        type: "managed_agent_turn_ended",
        targetThreadId: undefined,
        threadId: "one",
        outcome: "success"
      }),
      event("one", { type: "session_continued" })
    ]
    expect(
      project(owner, { events, hasMore: false }, () => row()).sessions[0].endedAt
    ).toBeUndefined()
    events.push(
      event("one", {
        type: "managed_agent_turn_ended",
        targetThreadId: undefined,
        threadId: "one",
        outcome: "error"
      })
    )
    expect(project(owner, { events, hasMore: false }, () => row()).sessions[0].outcome).toBe(
      "error"
    )
  })
  it.each(["project", "feature", "run", "workspace"])(
    "rejects foreign native %s metadata",
    (field) => {
      const feature = { projectId: owner.projectId, slug: owner.featureId, runId: owner.runId }
      if (field === "project") feature.projectId = "other-project"
      if (field === "feature") feature.slug = "other-feature"
      if (field === "run") feature.runId = "other-run"
      const result = project(owner, { events: [event("thread")], hasMore: false }, () =>
        row("birth", {
          harnessFeature: feature,
          ...(field === "workspace" ? { workspacePath: "C:/other" } : {})
        })
      )
      expect(result.sessions).toEqual([])
      expect(result.sessionsUnavailable).toBe(true)
    }
  )
  it("does not bless a same-ID replacement or a changed owner before publication", () => {
    for (const replaced of [
      row("replacement-birth"),
      row("original-birth", { harnessFeature: {} })
    ]) {
      let reads = 0
      const result = project(owner, { events: [event("same-thread")], hasMore: false }, () =>
        ++reads === 1 ? row() : replaced
      )
      expect(result.sessions).toEqual([])
      expect(result.sessionsUnavailable).toBe(true)
    }
  })
  it("reports missing/malformed history without authorizing or reconstructing it", () => {
    for (const missing of [undefined, { created_at: 1, metadata: "{" }]) {
      const result = project(owner, { events: [event("gone")], hasMore: false }, () => missing)
      expect(result.sessions).toEqual([])
      expect(result.sessionsUnavailable).toBe(true)
    }
  })
  it("bounds distinct sessions to 32 and reports both page and session truncation", () => {
    const result = project(
      owner,
      { events: Array.from({ length: 35 }, (_, i) => event(`t${i}`)), hasMore: false },
      () => row()
    )
    expect(result.sessions).toHaveLength(32)
    expect(result.sessions[0].threadId).toBe("t3")
    expect(result.sessionsTruncated).toBe(true)
    expect(
      project(owner, { events: [event("one")], hasMore: true }, () => row()).sessionsTruncated
    ).toBe(true)
    expect(
      project(
        owner,
        { events: Array.from({ length: 35 }, () => event("one")), hasMore: false },
        () => row()
      ).sessionsTruncated
    ).toBe(false)
  })
})
