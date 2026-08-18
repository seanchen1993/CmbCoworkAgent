import { describe, expect, it } from "vitest"

import {
  didHarnessSystemConstraintsLoadSuccessfully,
  type HarnessAgentmdLoadStatusItem
} from "./harness-board-types"

function item(loaded: boolean): HarnessAgentmdLoadStatusItem {
  return {
    deployUnitId: "unit-a",
    path: "/repo/AGENTS.md",
    loaded,
    source: "local",
    message: ""
  }
}

describe("didHarnessSystemConstraintsLoadSuccessfully", () => {
  it("requires at least one reported system constraint", () => {
    expect(didHarnessSystemConstraintsLoadSuccessfully([])).toBe(false)
  })

  it("returns true only when every reported system constraint loaded", () => {
    expect(didHarnessSystemConstraintsLoadSuccessfully([item(true)])).toBe(true)
    expect(didHarnessSystemConstraintsLoadSuccessfully([item(true), item(true)])).toBe(true)
    expect(didHarnessSystemConstraintsLoadSuccessfully([item(true), item(false)])).toBe(false)
    expect(didHarnessSystemConstraintsLoadSuccessfully([item(false)])).toBe(false)
  })
})
