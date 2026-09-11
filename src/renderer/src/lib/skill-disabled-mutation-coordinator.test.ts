import { describe, expect, it } from "vitest"
import { SkillDisabledMutationCoordinator } from "./skill-disabled-mutation-coordinator"

describe("SkillDisabledMutationCoordinator", () => {
  it("does not let an older response overwrite a newer click", () => {
    const coordinator = new SkillDisabledMutationCoordinator([])
    const disable = coordinator.begin("builtin/docs", true)
    const enable = coordinator.begin("builtin/docs", false)

    expect([...disable.snapshot]).toEqual(["builtin/docs"])
    expect([...enable.snapshot]).toEqual([])
    expect([...coordinator.settle("builtin/docs", disable.version, ["builtin/docs"])]).toEqual([])
    expect([...coordinator.settle("builtin/docs", enable.version, [])]).toEqual([])
  })

  it("overlays pending local intent on a cross-window authoritative refresh", () => {
    const coordinator = new SkillDisabledMutationCoordinator(["builtin/pdf"])
    coordinator.begin("builtin/docs", true)

    expect([...coordinator.replaceAuthoritative(["builtin/sheets"])]).toEqual([
      "builtin/sheets",
      "builtin/docs"
    ])
  })

  it("rolls back a failed latest intent to the last renderer authority", () => {
    const coordinator = new SkillDisabledMutationCoordinator(["builtin/pdf"])
    const intent = coordinator.begin("builtin/docs", true)

    expect([...coordinator.abandon("builtin/docs", intent.version)]).toEqual(["builtin/pdf"])
  })
})
