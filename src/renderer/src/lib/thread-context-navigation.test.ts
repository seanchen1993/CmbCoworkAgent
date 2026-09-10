import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("thread context navigation isolation", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./thread-context.tsx", import.meta.url)),
    "utf8"
  )

  it("does not navigate when live or restored background approvals arrive", () => {
    expect(source).not.toContain("Auto-switching to thread")
    expect(source).not.toMatch(
      /onApprovalRequest[\s\S]{0,1800}useAppStore\.getState\(\)\.selectThread/
    )
    expect(source).not.toMatch(
      /getPendingApprovals[\s\S]{0,2400}useAppStore\.getState\(\)\.selectThread/
    )
  })
})
