import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./harness-board.ts", import.meta.url), "utf8")

describe("Harness run artifact preview authorization", () => {
  it("issues capabilities from the trusted run detail instead of renderer roots", () => {
    const issuerStart = source.indexOf("function issueHarnessRunArtifactPreviewGrant")
    const issuerEnd = source.indexOf("export function registerHarnessBoardHandlers", issuerStart)
    const issuer = source.slice(issuerStart, issuerEnd)

    expect(issuerStart).toBeGreaterThanOrEqual(0)
    expect(issuer).toContain("detail.project.projectRootPath")
    expect(issuer).toContain("projectHarnessPluginRunArtifacts(detail)")
    expect(issuer).toContain("issueExternalFileReadGrant(")
    expect(issuer).toContain("EXTERNAL_FILE_READ_GRANT_TTL_MS")
    expect(issuer).not.toContain("input.projectRootPath")
  })

  it("re-reads the authoritative run before renewing an expired capability", () => {
    const start = source.indexOf('"harnessBoard:refreshRunArtifactGrant"')
    const end = source.indexOf('ipcMain.handle(', start + 1)
    const handler = source.slice(start, end < 0 ? undefined : end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("getHarnessRunDetail(projectId, slug")
    expect(handler).toContain("issueHarnessRunArtifactPreviewGrant(detail, event.sender.id)")
    expect(handler).toContain("resolveExternalFileReadGrant(")
    expect(handler.indexOf("getHarnessRunDetail(")).toBeLessThan(
      handler.indexOf("issueHarnessRunArtifactPreviewGrant(")
    )
    expect(handler.indexOf("issueHarnessRunArtifactPreviewGrant(")).toBeLessThan(
      handler.indexOf("resolveExternalFileReadGrant(")
    )
  })

  it("resolves directory reveal requests through the sender-bound grant", () => {
    const start = source.indexOf('"harnessBoard:revealRunArtifact"')
    const end = source.indexOf('ipcMain.handle(', start + 1)
    const handler = source.slice(start, end < 0 ? undefined : end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(handler).toContain("resolveExternalFileReadGrant(")
    expect(handler).toContain("event.sender.id")
    expect(handler.indexOf("resolveExternalFileReadGrant(")).toBeLessThan(
      handler.indexOf("shell.showItemInFolder(")
    )
  })
})
