import { describe, expect, it } from "vitest"
import { WORKSPACE_FILE_PREVIEW_ERROR_CODES } from "../../shared/workspace-file-preview"
import { classifyWorkspaceFilePreviewError, workspaceFilePreviewFailure } from "./errors"

function errno(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

describe("workspace file preview errors", () => {
  it("keeps operating-system permission failures separate from application policy", () => {
    expect(classifyWorkspaceFilePreviewError(errno("EACCES"))).toBe(
      WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILESYSTEM_PERMISSION_DENIED
    )
    expect(
      classifyWorkspaceFilePreviewError(new Error("Access denied: path outside workspace"))
    ).toBe(WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_OUTSIDE_TRUSTED_ROOT)
  })

  it("identifies expired capabilities and unavailable workspace metadata", () => {
    expect(classifyWorkspaceFilePreviewError(new Error("Invalid or expired grant"))).toBe(
      WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_INVALID
    )
    expect(classifyWorkspaceFilePreviewError(new Error("No workspace folder linked"))).toBe(
      WORKSPACE_FILE_PREVIEW_ERROR_CODES.WORKSPACE_UNAVAILABLE
    )
    expect(
      classifyWorkspaceFilePreviewError(
        new Error("Access denied: external file preview has no trusted source grant")
      )
    ).toBe(WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_MISSING)
  })

  it("preserves cancellation as a non-user-visible failure", () => {
    const error = new Error("superseded")
    error.name = "WORKSPACE_FILE_PREVIEW_CANCELLED"
    expect(workspaceFilePreviewFailure(error)).toMatchObject({
      success: false,
      cancelled: true,
      errorCode: WORKSPACE_FILE_PREVIEW_ERROR_CODES.CANCELLED
    })
  })
})
