import { describe, expect, it, vi } from "vitest"
import {
  functionMarkdownLinkAddressKey,
  validateFunctionMarkdownLinkAction,
  type FunctionMarkdownLinkAddress
} from "./markdown-links"

const address: FunctionMarkdownLinkAddress = {
  kind: "pane",
  pane: "actual:panel",
  generation: "generation-1"
}
const action = () => ({
  address: { ...address },
  nonce: "published-1",
  intentId: "click-1",
  href: "https://example.com/report"
})

describe("native Markdown link input", () => {
  it("accepts only the complete address for each drawing kind", () => {
    for (const target of [
      address,
      { kind: "site", owner: "site-1", pane: "actual:panel", generation: "generation-1" },
      { kind: "client", instance: "client-1", pane: "actual:panel", generation: "generation-1" }
    ])
      expect(() =>
        validateFunctionMarkdownLinkAction({ ...action(), address: target })
      ).not.toThrow()
  })

  it("rejects claimed source, authority and fields belonging to another drawing kind", () => {
    expect(() => validateFunctionMarkdownLinkAction({ ...action(), plugin: "Q" })).toThrow()
    expect(() => validateFunctionMarkdownLinkAction({ ...action(), authority: "user" })).toThrow()
    expect(() =>
      validateFunctionMarkdownLinkAction({
        ...action(),
        address: { ...address, owner: "site-1" }
      })
    ).toThrow()
    expect(() =>
      validateFunctionMarkdownLinkAction({
        ...action(),
        address: { kind: "site", pane: "actual:panel", generation: "generation-1" }
      })
    ).toThrow()
  })

  it("rejects accessor and hidden fields without invoking their code", () => {
    const read = vi.fn(() => "pane")
    const target = { ...address }
    Object.defineProperty(target, "kind", { enumerable: true, get: read })
    expect(() => validateFunctionMarkdownLinkAction({ ...action(), address: target })).toThrow()
    expect(read).not.toHaveBeenCalled()
    const hidden = action()
    Object.defineProperty(hidden, "authority", { value: "user" })
    expect(() => validateFunctionMarkdownLinkAction(hidden)).toThrow()
    expect(() =>
      validateFunctionMarkdownLinkAction({ ...action(), [Symbol("proof")]: true })
    ).toThrow()
  })

  it("bounds every public reference and keeps different owner addresses separate", () => {
    expect(() => validateFunctionMarkdownLinkAction({ ...action(), nonce: "" })).toThrow()
    expect(() =>
      validateFunctionMarkdownLinkAction({ ...action(), intentId: "x".repeat(129) })
    ).toThrow()
    expect(() =>
      validateFunctionMarkdownLinkAction({ ...action(), href: "x".repeat(2049) })
    ).toThrow()
    expect(() => validateFunctionMarkdownLinkAction({ ...action(), href: "a\u0000b" })).toThrow()
    expect(functionMarkdownLinkAddressKey(address)).not.toBe(
      functionMarkdownLinkAddressKey({
        kind: "site",
        owner: "site-1",
        pane: address.pane,
        generation: address.generation
      })
    )
    expect(functionMarkdownLinkAddressKey(address)).not.toBe(
      functionMarkdownLinkAddressKey({
        kind: "client",
        instance: "client-1",
        pane: address.pane,
        generation: address.generation
      })
    )
  })
})
