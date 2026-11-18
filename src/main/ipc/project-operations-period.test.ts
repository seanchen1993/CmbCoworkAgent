import { describe, expect, it, vi } from "vitest"
import { aggregate, matches, type Doc } from "./es-aggregation-test-fixture"
import {
  fetchProjectOperationsPeriod,
  parseProjectOperationsPeriodInput
} from "./project-operations-period"
import type { ProjectOperationsPeriodInput } from "../../shared/project-operations-period"

const input: ProjectOperationsPeriodInput = {
  period: { kind: "week", anchorDate: "2026-11-12" },
  upperOrgLv1: "room"
}
const scope = {
  eventIndex: "event",
  traceIndex: "trace",
  accessFilters: [{ term: { upperOrgLv1: "room" } }],
  now: new Date("2026-11-20T00:00:00Z")
}
const at = "2026-11-10T01:00:00Z"
function trace(overrides: Doc = {}): Doc {
  return {
    upperOrgLv1: "room",
    userName: "User",
    sapId: "00000001",
    ystId: "u1",
    traceId: "t",
    traceKind: "root",
    triggerSource: "chat",
    harnessProjectId: "p",
    harnessFeatureSlug: "f",
    startedAt: at,
    endedAt: "2026-11-10T01:01:00Z",
    durationMs: 60000,
    totalToolCalls: 2,
    modelCallCount: 1,
    ...overrides
  }
}
function code(eventName: string, properties: Doc = {}, overrides: Doc = {}): Doc {
  return {
    upperOrgLv1: "room",
    userName: "User",
    sapId: "00000001",
    ystId: "u1",
    eventName,
    eventTime: at,
    properties: { harnessProjectId: "p", harnessFeatureSlug: "f", ...properties },
    ...overrides
  }
}
function snapshot(projectId = "p", properties: Doc = {}): Doc {
  return {
    upperOrgLv1: "room",
    eventName: "harness.project.snapshot",
    eventTime: "2026-11-18T00:00:00Z",
    properties: {
      projectId,
      name: "Project",
      projectFromLean: true,
      lifecycleStatus: "archived",
      features: [{ slug: "f", title: "Feature", currentNodeId: "dev" }],
      ...properties
    }
  }
}
function harness(events: Doc[], traces: Doc[]) {
  const query = vi.fn(async (index: string, body: Doc) => {
    const docs = index === "event" ? events : traces
    const selected = docs.filter((d) => matches(d, body.query))
    return { aggregations: aggregate(selected, body.aggs) }
  })
  return {
    query,
    load: (request: ProjectOperationsPeriodInput = input) =>
      fetchProjectOperationsPeriod(request, scope, query)
  }
}

describe("complete period metrics foundation", () => {
  it("counts all 30 people, deduplicates shared projects/features and includes archived activity", async () => {
    const h = harness(
      [snapshot()],
      Array.from({ length: 30 }, (_, i) => trace({ sapId: String(i), ystId: `u${i}` }))
    )
    const data = await h.load()
    expect(data.people).toHaveLength(30)
    expect(data.summary).toMatchObject({
      projectCount: 1,
      featureCount: 1,
      personCount: 30,
      conversationCount: 30
    })
    expect(data.projects[0]).toMatchObject({
      lifecycleStatus: "archived",
      fromLean: true,
      snapshotAt: "2026-11-18T00:00:00Z"
    })
    expect(data.periodComplete).toBe(true)
    expect(data.people.every((p) => p.summary.conversationCount === 1)).toBe(true)
    expect(JSON.stringify(h.query.mock.calls)).not.toContain('"size":10')
  })
  it("uses a half-open local calendar week and preserves root/child cost semantics", async () => {
    const h = harness(
      [],
      [
        trace({ startedAt: "2026-11-08T16:00:00Z" }),
        trace({ startedAt: "2026-11-15T15:59:59.999Z" }),
        trace({ startedAt: "2026-11-15T16:00:00Z" }),
        trace({ startedAt: "2026-11-08T15:59:59.999Z" }),
        trace({ traceKind: "subagent", totalToolCalls: 7, modelCallCount: 3 }),
        trace({ upperOrgLv1: "outside", totalToolCalls: 999 })
      ]
    )
    const data = await h.load()
    expect(data.summary).toMatchObject({
      conversationCount: 2,
      traceCount: 3,
      durationMs: 120000,
      toolCalls: 11,
      modelCalls: 5
    })
    expect(data.coverage.missingProjectSnapshots).toBe(1)
    expect(data.projects[0].fromLean).toBeNull()
    expect(data.summary.code).toBeNull()
  })
  it("attributes later adoption to generation week and computes weighted rates", async () => {
    const events = [
      code("code_gen", { lineCount: 100 }),
      code("code_gen", { harnessFeatureSlug: "g", lineCount: 900 }),
      code(
        "code_adopt",
        {
          generatedAt: at,
          generatedLineCount: 100,
          effectiveGeneratedLineCount: 80,
          adoptedLineCount: 40,
          harnessNodeStatus: "进行中",
          usedSkills: ["skill"],
          pushed: true,
          pushedAt: "2026-11-18T01:00:00Z"
        },
        { eventTime: "2026-11-17T01:00:00Z" }
      ),
      code("code_adopt", {
        harnessFeatureSlug: "g",
        generatedAt: at,
        generatedLineCount: 900,
        effectiveGeneratedLineCount: 900,
        adoptedLineCount: 90,
        harnessNodeStatus: "已完成"
      }),
      code("code_adopt", {
        generatedAt: "2026-11-01T00:00:00Z",
        generatedLineCount: 9999,
        effectiveGeneratedLineCount: 9999,
        adoptedLineCount: 9999
      }),
      code("code_gen", { lineCount: 9999 }, { eventTime: "2026-11-16T00:00:00Z" })
    ]
    const data = await harness(events, [trace()]).load()
    expect(data.summary.code).toMatchObject({
      generatedLines: 1000,
      effectiveGeneratedLines: 980,
      adoptedLines: 130,
      pushedAdoptedLines: 40
    })
    expect(data.summary.code!.adoptionRate).toBeCloseTo(130 / 980)
    expect(data.summary.code!.pushedAdoptionRate).toBeCloseTo(40 / 980)
    expect(data.summary).toMatchObject({ harnessAdoptedLines: 40, vibeAdoptedLines: 90 })
  })
  it("keeps delayed generation delivery in the original generation period", async () => {
    const data = await harness(
      [
        code("code_gen", { lineCount: 20, createdAt: at }, { eventTime: "2026-11-17T01:00:00Z" }),
        code("code_gen", { lineCount: 50, createdAt: "2026-11-08T15:00:00Z" }),
        code("code_gen", { lineCount: 10 })
      ],
      []
    ).load()
    expect(data.summary.code?.generatedLines).toBe(30)
  })
  it("counts recorded knowledge reads by summary time without inventing code or historical zeroes", async () => {
    const data = await harness(
      [
        code("harness.system_constraint.read_summary", {
          successfulReadCount: 3,
          distinctFileCount: 1
        }),
        code("harness.system_constraint.read_summary", { successfulReadCount: 2 }),
        code(
          "harness.system_constraint.read_summary",
          { successfulReadCount: 90 },
          { eventTime: "2026-11-08T15:59:59Z" }
        ),
        code(
          "harness.system_constraint.read_summary",
          { successfulReadCount: 90 },
          { eventTime: "2026-11-15T16:00:00Z" }
        ),
        code(
          "harness.system_constraint.read_summary",
          { successfulReadCount: 90 },
          { upperOrgLv1: "other" }
        ),
        code("harness.system_constraint.read_summary", {})
      ],
      [trace({ sapId: "00000002", ystId: "u2" })]
    ).load()
    expect(data.summary).toMatchObject({
      knowledgeReadCount: 5,
      knowledgeReadSummaryCount: 2,
      code: null
    })
    expect(data.people.find((p) => p.sapId === "00000001")?.summary.knowledgeReadCount).toBe(5)
    expect(data.people.find((p) => p.sapId === "00000002")?.summary.knowledgeReadCount).toBeNull()
  })
  it("merges observed SAP/YST aliases, never merges names, and supports independent personal results", async () => {
    const h = harness(
      [],
      [
        trace(),
        trace({ sapId: undefined }),
        trace({ sapId: "00000002", ystId: "u2" }),
        trace({ sapId: undefined, ystId: undefined })
      ]
    )
    const data = await h.load()
    expect(data.people).toHaveLength(2)
    expect(data.people.find((p) => p.sapId === "00000001")?.summary.conversationCount).toBe(2)
    expect(data.summary.conversationCount).toBe(4)
    expect(data.coverage.unidentifiedContributions).toBe(1)
    const personal = await h.load({ ...input, person: { idType: "ystId", id: "u1" } })
    expect(personal.summary).toMatchObject({ personCount: 1, conversationCount: 2 })
    expect(personal.coverage.unidentifiedContributions).toBe(0)
    const absent = await h.load({ ...input, person: { idType: "sapId", id: "absent" } })
    expect(absent.summary.conversationCount).toBe(0)
  })
  it("reconciles generation/adoption denominators after resolving stable identity aliases", async () => {
    const data = await harness(
      [
        code("code_gen", { lineCount: 100 }),
        code(
          "code_adopt",
          {
            generatedAt: at,
            generatedLineCount: 100,
            effectiveGeneratedLineCount: 80,
            adoptedLineCount: 40
          },
          { ystId: undefined }
        ),
        code("code_gen", { harnessFeatureSlug: "unmeasured", lineCount: 50 }, { sapId: undefined }),
        code("code_adopt", {
          harnessFeatureSlug: "missing-gen-event",
          generatedAt: at,
          generatedLineCount: 20,
          effectiveGeneratedLineCount: 10,
          adoptedLineCount: 5
        })
      ],
      [trace()]
    ).load()
    const feature = data.contributions.find((row) => row.featureSlug === "f")!
    expect(feature.metrics.code).toMatchObject({
      generatedLines: 100,
      effectiveGeneratedLines: 80,
      adoptionRate: 0.5
    })
    // Keep the unmeasured and missing-generation cohorts separate across features.
    expect(data.summary.code).toMatchObject({
      generatedLines: 150,
      effectiveGeneratedLines: 140,
      adoptedLines: 45
    })
    expect(data.summary.code?.adoptionRate).toBeCloseTo(45 / 140)
    expect(data.people).toHaveLength(1)
    expect(data.people[0].summary.code).toEqual(data.summary.code)
  })
  it("does not guess the owner when one legacy YST ID maps to multiple SAP IDs", async () => {
    const h = harness([], [trace(), trace({ sapId: "00000002" }), trace({ sapId: undefined })])
    const data = await h.load()
    expect(data.summary.personCount).toBe(2)
    expect(data.coverage).toMatchObject({ ambiguousIdentityCount: 1, unidentifiedContributions: 1 })
    await expect(h.load({ ...input, person: { idType: "ystId", id: "u1" } })).rejects.toThrow(
      "冲突"
    )
  })
  it("keeps missing fields distinct from measured zeros and rejects partial backend results", async () => {
    const data = await harness([], [trace({ totalToolCalls: undefined, modelCallCount: 0 })]).load()
    expect(data.summary).toMatchObject({
      toolCalls: null,
      toolReportedTraceCount: 0,
      modelCalls: 0,
      modelReportedTraceCount: 1
    })
    await expect(
      fetchProjectOperationsPeriod(input, scope, async () => ({ timed_out: true }))
    ).rejects.toThrow("未完整")
  })
  it("does not truncate beyond a composite page or assume feature slugs are globally unique", async () => {
    const data = await harness(
      [],
      Array.from({ length: 501 }, (_, i) => trace({ harnessProjectId: `p${i}` }))
    ).load()
    expect(data.summary).toMatchObject({
      projectCount: 501,
      featureCount: 501,
      conversationCount: 501
    })
    expect(data.contributions).toHaveLength(501)
  })
  it("marks the current month as unfinished and rejects periods that have not begun", async () => {
    const h = harness(
      [code("code_gen", { lineCount: 99, createdAt: "2026-11-25T00:00:00Z" })],
      [trace()]
    )
    const current = await h.load({ ...input, period: { kind: "month", month: "2026-11" } })
    expect(current.periodComplete).toBe(false)
    expect(current.summary.code).toBeNull()
    await expect(h.load({ ...input, period: { kind: "month", month: "2026-12" } })).rejects.toThrow(
      "尚未开始"
    )
  })
  it("validates scope/identity and propagates cancellation without a partial result", async () => {
    expect(() => parseProjectOperationsPeriodInput({ ...input, upperOrgLv1: ["a", "b"] })).toThrow(
      "一个室"
    )
    expect(() =>
      parseProjectOperationsPeriodInput({ ...input, person: { userName: "User" } })
    ).toThrow("工号")
    const controller = new AbortController()
    controller.abort()
    const query = vi.fn()
    await expect(
      fetchProjectOperationsPeriod(input, { ...scope, signal: controller.signal }, query)
    ).rejects.toThrow()
    expect(query).not.toHaveBeenCalled()
  })
})
