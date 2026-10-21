import { expect, it } from "vitest"
import type { DevelopmentStatus } from "../../../shared/mods/development"
import { hasNativeCreatorWork } from "../components/customize/creator-workspace-visibility"

const empty: DevelopmentStatus = {
  workspace: "C:/project",
  threadId: "chat",
  enabled: true,
  mode: "creator",
  drafts: [],
  trials: []
}

it("does not treat mode selection, ordinary model accounting or planner configuration as plugin creation", () => {
  expect(hasNativeCreatorWork(null)).toBe(false)
  expect(hasNativeCreatorWork(empty)).toBe(false)
  expect(
    hasNativeCreatorWork({
      ...empty,
      request: { runId: "ordinary request", startedAt: 1, operations: 0, candidates: 0 }
    })
  ).toBe(false)
  expect(hasNativeCreatorWork({ ...empty, planning: { revision: 1, state: "native" } })).toBe(false)
})

it("keeps native authoring work visible before a candidate or trial is ready", () => {
  expect(
    hasNativeCreatorWork({
      ...empty,
      drafts: [{ id: "draft", name: "Plugin", revision: 1, digest: "a".repeat(64) }]
    })
  ).toBe(true)
  expect(
    hasNativeCreatorWork({
      ...empty,
      business: {
        drafts: [
          {
            id: "business",
            name: "Business",
            revision: 1,
            digest: "b".repeat(64),
            modIds: ["review"]
          }
        ]
      }
    })
  ).toBe(true)
})
