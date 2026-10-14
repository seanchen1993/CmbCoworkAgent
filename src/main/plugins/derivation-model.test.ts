import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ selected: vi.fn(), default: vi.fn(), invoke: vi.fn() }))
vi.mock("../models/registry", () => ({
  getModelConfigByRef: mocks.selected,
  getDefaultModelConfig: mocks.default
}))
vi.mock("../mods/v2/model-provider", () => ({ invokeFunctionModel: mocks.invoke }))
import { generateDerivationProposal } from "./derivation-model"

describe("isolated derivation model selection", () => {
  it("uses the selected model and bounded text-only request without history or tools", async () => {
    vi.clearAllMocks()
    const model = { ref: "selected", apiKey: "fixture-key" }
    mocks.selected.mockReturnValue(model)
    mocks.invoke.mockResolvedValue({ text: "{}" })
    await generateDerivationProposal(
      { instruction: "business", files: [] },
      new AbortController().signal,
      { owner: "workspace", identity: "scope", modelRef: "selected", guard: () => {} }
    )
    expect(mocks.selected).toHaveBeenCalledWith("selected")
    expect(mocks.default).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls[0][0]).toBe(model)
    expect(mocks.invoke.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        model: "selected",
        timeoutMs: 60_000,
        maxTokens: 12000
      })
    )
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty("tools")
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty("messages")
  })
  it("never falls back when an explicit selection is unavailable", async () => {
    vi.clearAllMocks()
    mocks.selected.mockReturnValue(undefined)
    await expect(
      generateDerivationProposal(
        { instruction: "business", files: [] },
        new AbortController().signal,
        { owner: "workspace", identity: "scope", modelRef: "missing", guard: () => {} }
      )
    ).rejects.toThrow("所选模型不可用")
    expect(mocks.default).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
