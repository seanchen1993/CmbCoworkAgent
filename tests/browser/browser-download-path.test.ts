import { describe, expect, it } from "vitest"
import { resolveAvailableBrowserDownloadPath } from "../../src/main/browser/core/browser-service"

describe("Browser automatic download paths", () => {
  it("uses the original file name when it is available", () => {
    expect(resolveAvailableBrowserDownloadPath("/Downloads", "report.xlsx", () => false)).toBe(
      "/Downloads/report.xlsx"
    )
  })

  it("adds a Chrome-style numeric suffix instead of overwriting a download", () => {
    const taken = new Set(["/Downloads/report.xlsx", "/Downloads/report (1).xlsx"])

    expect(
      resolveAvailableBrowserDownloadPath("/Downloads", "report.xlsx", (path) => taken.has(path))
    ).toBe("/Downloads/report (2).xlsx")
  })

  it("prevents a response filename from escaping the Downloads directory", () => {
    expect(resolveAvailableBrowserDownloadPath("/Downloads", "../../secret.txt", () => false)).toBe(
      "/Downloads/secret.txt"
    )
  })

  it("sanitizes characters that are invalid in Windows file names", () => {
    expect(
      resolveAvailableBrowserDownloadPath(
        "C:\\Users\\demo\\Downloads",
        "report:Q4?*.xlsx",
        () => false
      )
    ).toBe("C:\\Users\\demo\\Downloads/report_Q4__.xlsx")
  })

  it("avoids Windows reserved device names and trailing dots", () => {
    expect(resolveAvailableBrowserDownloadPath("/Downloads", "CON.txt", () => false)).toBe(
      "/Downloads/_CON.txt"
    )
    expect(resolveAvailableBrowserDownloadPath("/Downloads", "report...", () => false)).toBe(
      "/Downloads/report"
    )
  })
})
