import assert from "node:assert/strict"
import type { Page } from "playwright"

/** Observe the actual surface; setup/navigation before this call is outside the metric. */
export async function observeCreatorClicks(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { creatorScenarioClicks: string[] }
    state.creatorScenarioClicks = []
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null
        if (button)
          state.creatorScenarioClicks.push(
            button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""
          )
      },
      true
    )
  })
  return {
    reset: () =>
      page.evaluate(() => {
        ;(window as unknown as { creatorScenarioClicks: string[] }).creatorScenarioClicks = []
      }),
    read: () =>
      page.evaluate(() => [
        ...(window as unknown as { creatorScenarioClicks: string[] }).creatorScenarioClicks
      ])
  }
}

/** Frozen after S0 focused regressions and measured baselines, before final S1 acceptance. */
export const CREATOR_S1_GATES = Object.freeze({
  frozenAt: "2026-10-16T21:54:00+08:00",
  weatherVisibleMs: 60_000,
  documentVisibleMs: 45_000,
  displayPatchMs: 30_000,
  submitClicks: 1,
  trialConfirmations: 1,
  technicalPageVisits: 0,
  unrelatedBusinessReruns: 0
})

export function assertCreatorCreationMetrics(kind: "weather" | "document", input: unknown) {
  const value = input as Record<string, number>
  assert(value && Number.isFinite(value.elapsedMs) && value.elapsedMs > 0)
  assert(
    value.elapsedMs <=
      (kind === "weather" ? CREATOR_S1_GATES.weatherVisibleMs : CREATOR_S1_GATES.documentVisibleMs),
    `${kind} first actual visible effect exceeded the frozen controlled-fixture gate`
  )
  assert.equal(value.submitClicks, CREATOR_S1_GATES.submitClicks)
  assert.equal(value.trialConfirmations, CREATOR_S1_GATES.trialConfirmations)
  assert.equal(value.technicalPageVisits, CREATOR_S1_GATES.technicalPageVisits)
  assert.deepEqual(
    (input as { clicks: string[] }).clicks.slice().sort(),
    ["发送消息", "确认并应用到这段聊天"].sort()
  )
  if (kind === "weather") {
    assert.equal(value.nativeHttpConfirmations, 1)
    assert.equal(value.authoringCandidates, 3)
  }
}

export function assertCreatorPatchMetrics(input: unknown) {
  const value = input as Record<string, number>
  assert(value && Number.isFinite(value.elapsedMs) && value.elapsedMs > 0)
  assert(value.elapsedMs <= CREATOR_S1_GATES.displayPatchMs)
  assert.equal(value.submitClicks, 1)
  assert.equal(value.confirmations, 0)
  assert.equal(value.additionalReviews, CREATOR_S1_GATES.unrelatedBusinessReruns)
  assert.deepEqual((input as { clicks: string[] }).clicks, ["发送消息"])
}
