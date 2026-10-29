import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"
import { afterEach, expect, it, vi } from "vitest"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { openCreatorStep } from "../support/creator-navigation"
import {
  preserveLiveCreatorDependencyReview,
  reviewLiveCreatorDependency
} from "../support/creator-live-dependencies"

vi.mock("../support/creator-navigation", () => ({ openCreatorStep: vi.fn() }))

const directories: string[] = []
function fixture() {
  const artifacts = mkdtempSync(join(tmpdir(), "creator-dependency-review-"))
  directories.push(artifacts)
  const source = createAuthoringSourceBundle([{ path: "plugin.json", text: "{}" }])
  const review = {
    threadId: "thread",
    workspace: "C:\\acceptance\\workspace",
    planId: "original-plan",
    draftId: "dependency",
    revision: 1,
    sourceDigest: source.digest,
    compiledDigest: "b".repeat(64),
    targetProfileDigest: "c".repeat(64),
    capabilities: ["platform.read"],
    source
  }
  return { artifacts, review }
}
afterEach(() => {
  vi.clearAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("preserves an identical existing complete proposal without rewriting or approving it", () => {
  const input = fixture()
  const first = preserveLiveCreatorDependencyReview(input)
  const original = readFileSync(first.proposal, "utf8") + "\n\n"
  writeFileSync(first.proposal, original)
  expect(preserveLiveCreatorDependencyReview(input)).toEqual(first)
  expect(
    preserveLiveCreatorDependencyReview({ ...input, expectedPlanId: input.review.planId })
  ).toEqual(first)
  expect(readFileSync(first.proposal, "utf8")).toBe(original)
  expect(existsSync(first.approval)).toBe(false)
  writeFileSync(
    first.proposal,
    JSON.stringify({ digest: first.digest, ...input.review, revision: 2 })
  )
  expect(() => preserveLiveCreatorDependencyReview(input)).toThrow(
    "LIVE_DEPENDENCY_REVIEW_MISMATCH"
  )
  expect(JSON.parse(readFileSync(first.proposal, "utf8")).revision).toBe(2)
})

it("requires the original complete review on resume and rejects every changed identity without new files", () => {
  const input = fixture()
  const expectedPlanId = input.review.planId
  expect(() => preserveLiveCreatorDependencyReview({ ...input, expectedPlanId })).toThrow(
    "LIVE_DEPENDENCY_ORIGINAL_REVIEW_REQUIRED"
  )
  expect(existsSync(join(input.artifacts, "dependency-review"))).toBe(false)
  const original = preserveLiveCreatorDependencyReview(input)
  const bytes = readFileSync(original.proposal, "utf8")
  const changes = [
    { planId: "replacement-plan" },
    { sourceDigest: "d".repeat(64) },
    { compiledDigest: "d".repeat(64) },
    { targetProfileDigest: "d".repeat(64) },
    { revision: 2 },
    { capabilities: ["process.run"] },
    { source: { ...input.review.source, files: [{ path: "plugin.json", text: "changed" }] } }
  ]
  for (const change of changes)
    expect(() =>
      preserveLiveCreatorDependencyReview({
        ...input,
        expectedPlanId,
        review: { ...input.review, ...change }
      })
    ).toThrow(/LIVE_DEPENDENCY_(?:PLAN_REPLACED|REVIEW_MISMATCH)/)
  expect(readdirSync(join(input.artifacts, "dependency-review"))).toHaveLength(1)
  expect(readFileSync(original.proposal, "utf8")).toBe(bytes)
})

function nativePage(input: ReturnType<typeof fixture>, currentChange = {}) {
  const { source, threadId, workspace, ...identity } = input.review
  const status = { workspace, reuse: { phase: "needs-approval", name: "Dependency", ...identity } }
  const nativeConfirm = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const card = { isVisible: vi.fn(async () => true), getByRole: () => ({ click: nativeConfirm }) }
  const feedback = { isVisible: vi.fn(async () => false) }
  const feedbackMatches = { filter: () => ({ first: () => feedback }) }
  const panel = {
    getByRole: (role: string) =>
      role === "article" ? card : role === "status" ? feedbackMatches : { click: close }
  }
  vi.mocked(openCreatorStep).mockResolvedValue(panel as never)
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ source })
    .mockResolvedValueOnce({ ...status, reuse: { ...status.reuse, ...currentChange } })
    .mockResolvedValueOnce({ ...status, reuse: { ...status.reuse, phase: "active" } })
  return {
    page: { evaluate, getByRole: () => ({}) } as unknown as Page,
    evaluate,
    status,
    nativeConfirm,
    feedback,
    close,
    threadId,
    workspace
  }
}

it("accepts the original late approval only after the actual original native confirmation", async () => {
  const input = fixture()
  const original = preserveLiveCreatorDependencyReview(input)
  writeFileSync(original.approval, JSON.stringify({ digest: original.digest, decision: "approve" }))
  const ui = nativePage(input)
  const receipt = await reviewLiveCreatorDependency({
    ...input,
    ...ui,
    deadline: Date.now() + 10000,
    expectedPlanId: input.review.planId
  })
  expect(ui.nativeConfirm).toHaveBeenCalledTimes(1)
  expect(ui.close).toHaveBeenCalledTimes(1)
  expect(receipt).toMatchObject({
    planId: input.review.planId,
    sourceDigest: input.review.sourceDigest,
    compiledDigest: input.review.compiledDigest,
    targetProfileDigest: input.review.targetProfileDigest,
    nativeUIConsent: true,
    reviewDigest: original.digest
  })
  expect(receipt.source).toBeUndefined()
  expect(readdirSync(join(input.artifacts, "dependency-review"))).toHaveLength(2)
})

it("stops immediately when the native approval UI reports an error without a terminal status", async () => {
  const input = fixture()
  const original = preserveLiveCreatorDependencyReview(input)
  writeFileSync(original.approval, JSON.stringify({ digest: original.digest, decision: "approve" }))
  const ui = nativePage(input)
  ui.feedback.isVisible.mockResolvedValue(true)
  ui.evaluate
    .mockReset()
    .mockResolvedValueOnce(ui.status)
    .mockResolvedValueOnce({ source: input.review.source })
    .mockResolvedValue(ui.status)
  await expect(
    reviewLiveCreatorDependency({
      ...input,
      ...ui,
      deadline: Date.now() + 600000,
      expectedPlanId: input.review.planId
    })
  ).rejects.toThrow("LIVE_DEPENDENCY_NATIVE_APPROVAL_FAILED")
  expect(ui.nativeConfirm).toHaveBeenCalledTimes(1)
  expect(ui.evaluate).toHaveBeenCalledTimes(4)
  expect(ui.close).not.toHaveBeenCalled()
})

it("requires a new exact proposal and approval after explicit preparation produces a new plan", () => {
  const input = fixture()
  const original = preserveLiveCreatorDependencyReview(input)
  const accepted = JSON.stringify({ digest: original.digest, decision: "approve" })
  writeFileSync(original.approval, accepted)
  const next = preserveLiveCreatorDependencyReview({
    ...input,
    review: { ...input.review, planId: "new-native-plan" }
  })
  expect(next.digest).not.toBe(original.digest)
  expect(existsSync(next.proposal)).toBe(true)
  expect(existsSync(next.approval)).toBe(false)
  expect(readFileSync(original.approval, "utf8")).toBe(accepted)
})

it.each([
  { change: { phase: "active" }, failure: "LIVE_DEPENDENCY_PHASE_CHANGED" },
  { change: { targetProfileDigest: "d".repeat(64) }, failure: "LIVE_DEPENDENCY_IDENTITY_CHANGED" },
  { change: {}, approvalDigest: "d".repeat(64), failure: "LIVE_DEPENDENCY_REVIEW_MISMATCH" }
])(
  "refuses changed phase, target or approval before native consent: $failure",
  async ({ change, approvalDigest, failure }) => {
    const input = fixture()
    const original = preserveLiveCreatorDependencyReview(input)
    writeFileSync(
      original.approval,
      JSON.stringify({ digest: approvalDigest ?? original.digest, decision: "approve" })
    )
    const ui = nativePage(input, change)
    await expect(
      reviewLiveCreatorDependency({
        ...input,
        ...ui,
        deadline: Date.now() + 10000,
        expectedPlanId: input.review.planId
      })
    ).rejects.toThrow(failure)
    expect(ui.nativeConfirm).not.toHaveBeenCalled()
  }
)
