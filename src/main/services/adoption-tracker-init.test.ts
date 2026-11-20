import { mkdirSync, rmSync } from "fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os")
  return {
    root: join(tmpdir(), "adoption-tracker-init-test") as string,
    initializeIndex: vi.fn<() => Promise<boolean>>(),
    flushIndex: vi.fn<() => boolean>(),
    closeIndex: vi.fn<() => boolean>(),
    trimSource: vi.fn(),
    trimDetails: vi.fn(),
    resetCommitJobs: vi.fn(),
    resetOutbox: vi.fn()
  }
})

vi.mock("../storage", () => ({ getOpenworkDir: () => testState.root }))
vi.mock("./adoption-index", () => ({
  initializeAdoptionIndex: testState.initializeIndex,
  flushAdoptionIndex: testState.flushIndex,
  closeAdoptionIndex: testState.closeIndex,
  trimGeneratedSourceTextToByteCap: testState.trimSource,
  trimAdoptLineDetails: testState.trimDetails,
  resetInterruptedCommitJobs: testState.resetCommitJobs,
  resetInterruptedOutboxEvents: testState.resetOutbox
}))

import { initializeAdoptionTracker, shutdownAdoptionTracker } from "./adoption-tracker"

describe.sequential("adoption tracker initialization", () => {
  beforeEach(() => {
    shutdownAdoptionTracker()
    vi.clearAllMocks()
    rmSync(testState.root, { recursive: true, force: true })
    mkdirSync(testState.root, { recursive: true })
    testState.closeIndex.mockReturnValue(true)
  })

  afterEach(() => {
    shutdownAdoptionTracker()
    vi.restoreAllMocks()
    rmSync(testState.root, { recursive: true, force: true })
  })

  it("does not start timers when the index cannot initialize", async () => {
    testState.initializeIndex.mockResolvedValue(false)
    const interval = vi.spyOn(globalThis, "setInterval")
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(await initializeAdoptionTracker()).toBe(false)
    expect(testState.flushIndex).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
  })

  it("closes the index and does not start timers when the initial flush fails", async () => {
    testState.initializeIndex.mockResolvedValue(true)
    testState.flushIndex.mockReturnValue(false)
    const interval = vi.spyOn(globalThis, "setInterval")
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(await initializeAdoptionTracker()).toBe(false)
    expect(testState.closeIndex).toHaveBeenCalledTimes(1)
    expect(interval).not.toHaveBeenCalled()
  })
})
