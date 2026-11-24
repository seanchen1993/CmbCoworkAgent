import { describe, expect, it } from "vitest"
import { botWorkModelRoutingMode, inheritBotWorkModelRouting, isBotCreatedWorkMetadata, resolveLegacyBotWorkModelRef } from "./model-policy"
import { resolveBotWorkViewModel, resolveHydratedThreadModel } from "../thread-model-selection"

const created = {
  botHostId: "local", botId: "assistant", botWorkId: "work", botAudienceKey: "desktop",
  botLocalConversation: true, botWorkOrigin: "created", model: "explicit",
  routingState: { lastResolvedModelId: "economy", lastResolvedTier: "economy" }
}

describe("native Bot work model continuity", () => {
  it("resolves legacy custom names without rebinding missing or explicit selections", () => {
    const configs = [{ id: "provider-a", model: "same-model" }, { id: "provider-b", model: "same-model" }]
    expect(resolveLegacyBotWorkModelRef("custom:same-model", configs)).toBe("custom:provider-a")
    expect(resolveLegacyBotWorkModelRef("custom:provider-b", configs)).toBe("custom:provider-b")
    expect(resolveLegacyBotWorkModelRef("custom:missing", configs)).toBe("custom:missing")
    expect(resolveLegacyBotWorkModelRef("builtin:same-model", configs)).toBe("builtin:same-model")
    expect(resolveLegacyBotWorkModelRef("custom:same-model", [...configs, { id: "same-model", model: "other" }]))
      .toBe("custom:same-model")
  })
  it("retains a pinned model when opening a task while global routing is auto", () => {
    const metadata = inheritBotWorkModelRouting(created, "explicit")
    expect(botWorkModelRoutingMode(metadata)).toBe("pinned")
    expect(resolveHydratedThreadModel(metadata, "auto").modelId).toBe("explicit")
  })

  it("keeps default-following work on global policy, even after the Bot setting changes", () => {
    const metadata = inheritBotWorkModelRouting(created, null)
    expect(metadata.botWorkModelRoutingMode).toBe("default")
    expect(inheritBotWorkModelRouting(metadata, "new-bot-model")).toBe(metadata)
    expect(botWorkModelRoutingMode(metadata)).toBeUndefined()
    expect(resolveHydratedThreadModel(metadata, "auto", "current-default").modelId).toBe("economy")
    expect(resolveHydratedThreadModel(metadata, "pinned", "current-default").modelId).toBe("current-default")
    expect(resolveHydratedThreadModel(metadata, "pinned", "changed-default").modelId).toBe("changed-default")
    expect(resolveHydratedThreadModel(metadata, "pinned").modelId).toBe("")
  })

  it("retains an explicit model even when the available global default changes", () => {
    const metadata = inheritBotWorkModelRouting({ ...created, model: "removed-config", botWorkModelRoutingMode: "pinned" }, "explicit")
    expect(resolveHydratedThreadModel(metadata, "pinned", "available-default").modelId)
      .toBe("removed-config")
    expect(resolveHydratedThreadModel(metadata, "auto", "available-default").modelId)
      .toBe("removed-config")
  })

  it("restores historical routing without requiring a loaded model catalog", () => {
    const metadata = { ...created, botWorkModelRoutingMode: "default",
      routingState: { lastResolvedModelId: "deleted-model", lastResolvedTier: "economy" } }
    expect(resolveHydratedThreadModel(metadata, "auto")).toEqual({
      modelId: "deleted-model",
      routingResult: { resolvedModelId: "deleted-model", resolvedTier: "economy" }
    })
  })

  it("inherits an explicit model and its policy together on first exposure", () => {
    const metadata = inheritBotWorkModelRouting({ ...created, model: "old-default" }, "current-bot-model")
    expect(metadata).toMatchObject({ model: "current-bot-model", botWorkModelRoutingMode: "pinned" })
    expect(resolveHydratedThreadModel(metadata, "auto").modelId).toBe("current-bot-model")
  })

  it("keeps the live routed model for context accounting instead of resetting it to the old/default model", () => {
    const models = [{ id: "default", available: true }, { id: "live", available: true }, { id: "old", available: true }]
    expect(resolveBotWorkViewModel("auto", "live", { model: "old" }, models, "default")).toBe("live")
    expect(resolveBotWorkViewModel("auto", "", { model: "old" }, models, "default")).toBe("old")
  })

  it("uses the actual routing result after an unsent manual choice switches back to auto", () => {
    const metadata = { ...created, model: "manual-unsent", botWorkModelRoutingMode: "default" }
    const models = ["manual-unsent", "economy", "global-default"].map(id => ({ id, available: true }))
    const hydrated = resolveHydratedThreadModel(metadata, "auto", "global-default")
    expect(resolveBotWorkViewModel("auto", hydrated.routingResult!.resolvedModelId,
      metadata, models, "global-default")).toBe("economy")
    expect(metadata.model).toBe("manual-unsent")
  })

  it("allows legacy work with no saved model to use the newly available runtime default", () => {
    const metadata = { ...created, model: "", routingState: undefined }
    expect(resolveBotWorkViewModel("pinned", "", metadata,
      [{ id: "available-default", available: true }], "available-default")).toBe("available-default")
    expect(metadata.model).toBe("")
    expect(botWorkModelRoutingMode(metadata)).toBeUndefined()
    expect(resolveBotWorkViewModel("pinned", "", metadata, [], "")).toBe("")
  })

  it.each([undefined, "", "   "])("does not pin a legacy work's historical route when its saved model is %s", (model) => {
    const metadata = { ...created, model }
    for (const historyAvailable of [true, false]) {
      const models = [{ id: "available-default", available: true },
        { id: "economy", available: historyAvailable }]
      expect(resolveBotWorkViewModel("pinned", "economy", metadata, models, "available-default"))
        .toBe("available-default")
    }
    // Read-only view selection does not erase the actual routing history or migrate the work.
    expect(resolveHydratedThreadModel(metadata, "pinned").routingResult?.resolvedModelId).toBe("economy")
    expect(metadata.model).toBe(model)
    expect(botWorkModelRoutingMode(metadata)).toBeUndefined()
    expect(resolveBotWorkViewModel("pinned", "economy", metadata, [], "")).toBe("")
  })

  it.each([undefined, "default"])("allows auto work with a removed historical model to submit (%s)", (mode) => {
    const metadata = { ...created, model: "deleted-model", botWorkModelRoutingMode: mode,
      routingState: { lastResolvedModelId: "deleted-model", lastResolvedTier: "economy" } }
    const hydrated = resolveHydratedThreadModel(metadata, "auto", "available-default")
    expect(resolveBotWorkViewModel("auto", "deleted-model", metadata,
      [{ id: "available-default", available: true }], "available-default")).toBe("available-default")
    // Availability changes don't rewrite a task's saved model, policy or routing evidence.
    expect(metadata.model).toBe("deleted-model")
    expect(metadata.botWorkModelRoutingMode).toBe(mode)
    expect(hydrated.routingResult?.resolvedModelId).toBe("deleted-model")
    expect(resolveBotWorkViewModel("pinned", "available-default", { ...metadata, botWorkModelRoutingMode: "pinned" },
      [{ id: "available-default", available: true }], "available-default")).toBe("deleted-model")
  })

  it("preserves legacy bound work's prior manual and global-auto semantics without a new policy", () => {
    expect(resolveHydratedThreadModel(created, "pinned", "global-default").modelId).toBe("explicit")
    expect(resolveHydratedThreadModel(created, "auto", "global-default").modelId).toBe("economy")
    expect(botWorkModelRoutingMode(created)).toBeUndefined()
  })

  it.each(["default", "pinned"] as const)("preserves the user's task-specific %s choice", (mode) => {
    const metadata = { ...created, botWorkModelRoutingMode: mode }
    expect(inheritBotWorkModelRouting(metadata, "other-model")).toBe(metadata)
    expect(resolveHydratedThreadModel(metadata, "auto", "current-default").modelId)
      .toBe(mode === "default" ? "economy" : "explicit")
  })

  it.each([
    {}, { ...created, botWorkOrigin: "existing" }, { ...created, botLocalConversation: false },
    { ...created, botId: "" }, { ...created, botWorkId: "" },
    { ...created, botGroupId: "group" }, { ...created, botMockBindingId: "binding" },
    { ...created, botAudienceKey: "im:group" }
  ])("does not apply Bot routing to other conversation scopes (%j)", (entry) => {
    const metadata = { ...entry, model: "manual", botWorkModelRoutingMode: "pinned",
      routingState: { lastResolvedModelId: "economy" } }
    expect(isBotCreatedWorkMetadata(metadata)).toBe(false)
    expect(inheritBotWorkModelRouting(metadata, "bot-model")).toBe(metadata)
    expect(botWorkModelRoutingMode(metadata)).toBeUndefined()
    expect(resolveHydratedThreadModel(metadata, "auto").modelId).toBe("economy")
  })
})
