import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { UiGuideConfig } from "../../shared/ui-guides"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "./native-sqlite-adapter"
import {
  acknowledgeUiGuide,
  ensureUiGuideSchema,
  getUiGuideState,
  recordUiGuideDisplay
} from "./ui-guide-store"

const config: UiGuideConfig = {
  guideId: "project-mode-getting-started",
  revision: 1,
  maxShowCount: 3
}

let directory: string
let path: string
let database: NativeSqliteAdapter

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ui-guide-"))
  path = join(directory, "guides.sqlite")
  database = openNativeSqliteDatabase(path).database
  ensureUiGuideSchema(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("UI guide persistence", () => {
  it("checking eligibility does not count; only three displays are allowed", () => {
    expect(getUiGuideState(database, config)).toEqual({
      shownCount: 0,
      acknowledged: false,
      shouldShow: true
    })
    expect(getUiGuideState(database, config).shownCount).toBe(0)
    for (let count = 1; count <= 3; count += 1) {
      expect(recordUiGuideDisplay(database, config)).toBe(true)
      expect(getUiGuideState(database, config)).toEqual({
        shownCount: count,
        acknowledged: false,
        shouldShow: count < 3
      })
    }
    expect(recordUiGuideDisplay(database, config)).toBe(false)
    expect(getUiGuideState(database, config).shownCount).toBe(3)
  })

  it("acknowledgement stops displays even when the limit is later raised", () => {
    getUiGuideState(database, config)
    recordUiGuideDisplay(database, config)
    acknowledgeUiGuide(database, config)
    const raisedLimit = { ...config, maxShowCount: 10 }
    expect(getUiGuideState(database, raisedLimit)).toEqual({
      shownCount: 1,
      acknowledged: true,
      shouldShow: false
    })
    expect(recordUiGuideDisplay(database, raisedLimit)).toBe(false)
  })

  it("restarts the budget for a new revision without affecting other guides", () => {
    getUiGuideState(database, config)
    recordUiGuideDisplay(database, config)
    acknowledgeUiGuide(database, config)
    const secondGuide = { ...config, guideId: "another-guide", maxShowCount: 1 }
    getUiGuideState(database, secondGuide)
    recordUiGuideDisplay(database, secondGuide)

    const nextRevision = { ...config, revision: 2 }
    expect(getUiGuideState(database, nextRevision)).toEqual({
      shownCount: 0,
      acknowledged: false,
      shouldShow: true
    })
    // A delayed acknowledgement/display from the previous revision is ignored.
    acknowledgeUiGuide(database, config)
    expect(recordUiGuideDisplay(database, config)).toBe(false)
    expect(getUiGuideState(database, nextRevision).shouldShow).toBe(true)
    expect(getUiGuideState(database, secondGuide).shouldShow).toBe(false)
  })

  it("persists both counts and acknowledgement across database reopen", () => {
    getUiGuideState(database, config)
    recordUiGuideDisplay(database, config)
    const secondGuide = { ...config, guideId: "acknowledged-guide" }
    getUiGuideState(database, secondGuide)
    acknowledgeUiGuide(database, secondGuide)
    database.close()
    database = openNativeSqliteDatabase(path).database
    ensureUiGuideSchema(database)
    expect(getUiGuideState(database, config).shownCount).toBe(1)
    expect(getUiGuideState(database, secondGuide).acknowledged).toBe(true)
  })

  it.each([
    { ...config, guideId: " " },
    { ...config, revision: 0 },
    { ...config, revision: 1.5 },
    { ...config, maxShowCount: 0 }
  ])("rejects invalid configuration: %j", (invalid) => {
    expect(() => getUiGuideState(database, invalid)).toThrow("引导配置无效")
    expect(() => recordUiGuideDisplay(database, invalid)).toThrow("引导配置无效")
    expect(() => acknowledgeUiGuide(database, invalid)).toThrow("引导配置无效")
  })
})
