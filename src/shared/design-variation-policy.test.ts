import { describe, expect, it } from "vitest"
import { designVariantPolicyIssue, isSingleDesignVariant } from "./design-variation-policy"
import { buildNewDesignPrompt } from "./managed-design-session"

describe("conversation single-variant policy", () => {
  it("recognizes persisted locks and existing design-system metadata after selection is cleared", () => {
    expect(isSingleDesignVariant({ singleVariant: true, selectedDesignSystemId: null })).toBe(true)
    expect(isSingleDesignVariant({ artifactMetadata: { designSystemId: "brand" } })).toBe(true)
    expect(isSingleDesignVariant({}, { designSystemId: "brand" })).toBe(true)
    expect(isSingleDesignVariant({})).toBe(false)
    expect(buildNewDesignPrompt("给两种风格", { singleVariant: true })).toContain(
      "permanently single-variant"
    )
  })

  it("rejects real variation containers but permits examples inside scripts and unrestricted sessions", () => {
    const variants =
      '<!doctype html><html><body><div id="variation-a">A</div><div id="variation-b">B</div></body></html>'
    expect(designVariantPolicyIssue(variants, true)).toContain("只允许单一方案")
    expect(designVariantPolicyIssue(variants, false)).toBeUndefined()
    expect(
      designVariantPolicyIssue(
        '<!doctype html><html><body><script>const example="variation-a";</script><main>单版</main></body></html>',
        true
      )
    ).toBeUndefined()
  })
})
