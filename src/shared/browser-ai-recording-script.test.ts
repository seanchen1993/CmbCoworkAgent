import { describe, expect, it } from "vitest"
import { generateAiRecordingScript, parseAiRecordingScript } from "./browser-ai-recording-script"

describe("browser ai recording script", () => {
  it("preserves first occurrence hints when round-tripping parsed scripts", () => {
    const script = `import { test } from "@playwright/test";

test("AI recorded flow", async ({ page }) => {
  // Review generated locators before committing this test.
  await page.getByRole("button", { name: "Save" }).first().click();
});
`

    const parsed = parseAiRecordingScript(script, "ai")

    expect(parsed.actions).toEqual([
      expect.objectContaining({
        kind: "click",
        locator: expect.objectContaining({
          role: "button",
          accessibleName: "Save",
          matchCount: 2
        })
      })
    ])

    const regenerated = generateAiRecordingScript(parsed.actions, {
      source: "ai",
      variableActionIds: parsed.variableActionIds,
      variableActionNames: parsed.variableActionNames
    })

    expect(regenerated).toContain(
      'await page.getByRole("button", { name: "Save" }).first().click();'
    )
  })
})
