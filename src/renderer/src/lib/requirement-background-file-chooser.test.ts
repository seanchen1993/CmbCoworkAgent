import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(
  new URL("../components/requirement/RequirementBackgroundMaterialsField.tsx", import.meta.url),
  "utf8"
)

describe("requirement background material file chooser", () => {
  it("opens the hidden input directly from a real button for Windows Electron", () => {
    expect(source).toContain("const fileInputRef = useRef<HTMLInputElement>(null)")
    expect(source).toContain("onClick={() => fileInputRef.current?.click()}")
    expect(source).toContain("ref={fileInputRef}")
    expect(source).not.toContain("event.currentTarget.control?.click()")
  })
})
