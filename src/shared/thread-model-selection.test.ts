import { describe, expect, it } from "vitest"
import { resolveHydratedThreadModel } from "./thread-model-selection"

describe("resolveHydratedThreadModel", () => {
  const metadata = {
    model: "custom:manual-model",
    routingState: {
      lastResolvedModelId: "custom:auto-model",
      lastResolvedTier: "economy"
    }
  }

  it("restores the user's manual model in pinned mode", () => {
    expect(resolveHydratedThreadModel(metadata, "pinned")).toEqual({
      modelId: "custom:manual-model",
      routingResult: {
        resolvedModelId: "custom:auto-model",
        resolvedTier: "economy"
      }
    })
  })

  it("restores the last actually-routed model in auto mode", () => {
    expect(resolveHydratedThreadModel(metadata, "auto")).toEqual({
      modelId: "custom:auto-model",
      routingResult: {
        resolvedModelId: "custom:auto-model",
        resolvedTier: "economy"
      }
    })
  })

  it("falls back to the only persisted model when one source is missing", () => {
    expect(resolveHydratedThreadModel({ model: "custom:manual-model" }, "auto").modelId).toBe(
      "custom:manual-model"
    )
    expect(
      resolveHydratedThreadModel(
        { routingState: { lastResolvedModelId: "custom:auto-model" } },
        "pinned"
      )
    ).toEqual({
      modelId: "custom:auto-model",
      routingResult: {
        resolvedModelId: "custom:auto-model",
        resolvedTier: "premium"
      }
    })
  })

  it("ignores malformed persisted values", () => {
    expect(
      resolveHydratedThreadModel(
        { model: 42, routingState: { lastResolvedModelId: false } },
        "pinned"
      )
    ).toEqual({ modelId: "", routingResult: null })
  })
})
