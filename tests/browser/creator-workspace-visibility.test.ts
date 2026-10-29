import { expect, it } from "vitest"
import { hasNativeCreatorWork } from "../../src/renderer/src/components/customize/creator-workspace-visibility"

const empty = {
  threadId: "creator",
  workspace: "workspace",
  mode: "creator" as const,
  enabled: true,
  drafts: [],
  trials: []
}

it("keeps an empty creator compact without hiding an explicitly imported source set", () => {
  expect(hasNativeCreatorWork(empty)).toBe(false)
  for (const phase of ["dependencies", "compiling", "ready", "needs-review", "failed"] as const)
    expect(
      hasNativeCreatorWork({
        ...empty,
        sourceSet: { id: "source", title: "Imported source", phase, dependencies: [] }
      })
    ).toBe(true)
  expect(
    hasNativeCreatorWork({
      ...empty,
      sourceSet: { id: "source", title: "Imported source", phase: "cancelled", dependencies: [] }
    })
  ).toBe(false)
})
