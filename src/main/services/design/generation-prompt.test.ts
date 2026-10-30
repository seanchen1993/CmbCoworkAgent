import { describe, expect, it } from "vitest"
import {
  DESIGN_FIRST_WRITE_TARGET_BYTES,
  validateFirstDesignWrite,
  buildDesignContinuationPrompt,
  hasDesignContinuationProgress,
  DESIGN_ARTIFACT_CONTINUATION_MAX_ATTEMPTS
} from "./generation-prompt"
import { inspectDesignDocument } from "../../../shared/design-progressive"

describe("first design framework budget", () => {
  const page = (body: string) =>
    `<!DOCTYPE html><html><head><title>销售看板</title></head><body data-design-build="building"><nav>销售中心</nav><section data-design-section="overview" data-design-pending>${body}</section></body></html>`

  it("continues only outstanding sections without counting cosmetic writes as progress", () => {
    const before = inspectDesignDocument(page("概览"))
    const cosmetic = inspectDesignDocument(page("新概览"))
    expect(hasDesignContinuationProgress(before, cosmetic)).toBe(false)
    const completedSection = inspectDesignDocument(page("概览").replace(" data-design-pending", ""))
    expect(hasDesignContinuationProgress(before, completedSection)).toBe(true)
    const finished = inspectDesignDocument(
      page("概览").replace(" data-design-pending", "").replace(' data-design-build="building"', "")
    )
    expect(hasDesignContinuationProgress(completedSection, finished)).toBe(true)
    expect(hasDesignContinuationProgress(before, undefined)).toBe(false)
    expect(buildDesignContinuationPrompt("/draft.html", before)).toContain("未完成区块：overview")
    expect(buildDesignContinuationPrompt("/draft.html", before).length).toBeLessThan(1300)
    expect(DESIGN_ARTIFACT_CONTINUATION_MAX_ATTEMPTS).toBe(3)
  })

  it("accepts coherent UTF-8 frameworks above the target without forcing repeated rewrites", () => {
    expect(validateFirstDesignWrite(page("销售概览"))).toBeUndefined()
    const content = page("销".repeat(DESIGN_FIRST_WRITE_TARGET_BYTES / 2))
    expect(Buffer.byteLength(content)).toBeGreaterThan(DESIGN_FIRST_WRITE_TARGET_BYTES)
    expect(validateFirstDesignWrite(content)).toBeUndefined()
    expect(content.endsWith("</html>")).toBe(true)
  })

  it("treats the byte target as advisory but still rejects partial HTML", () => {
    const overhead = Buffer.byteLength(page(""))
    expect(
      validateFirstDesignWrite(page("x".repeat(DESIGN_FIRST_WRITE_TARGET_BYTES - overhead)))
    ).toBeUndefined()
    expect(
      validateFirstDesignWrite(page("x".repeat(DESIGN_FIRST_WRITE_TARGET_BYTES - overhead + 1)))
    ).toBeUndefined()
    expect(validateFirstDesignWrite("<section>未完成")).toContain("complete")
    expect(validateFirstDesignWrite(page("预览").replace("</section>", ""))).toContain(
      "not ready to preview"
    )
  })
})
