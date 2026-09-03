import { describe, expect, it } from "vitest"
import { WORKSPACE_FILE_PREVIEW_ERROR_CODES } from "../../../shared/workspace-file-preview"
import { formatFilePreviewError, normalizeFilePreviewError } from "./file-preview-error"

describe("file preview error presentation", () => {
  it("does not describe an application path boundary as a Windows permission failure", () => {
    const friendly = formatFilePreviewError({
      message: "Access denied: path outside workspace",
      code: WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_OUTSIDE_TRUSTED_ROOT
    })
    expect(friendly.title).toBe("文件不在允许的访问范围")
    expect(friendly.description).not.toContain("操作系统")
  })

  it("keeps real EACCES errors actionable", () => {
    const friendly = formatFilePreviewError({
      message: "EACCES: permission denied, open 'C:\\private\\report.txt'",
      code: WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILESYSTEM_PERMISSION_DENIED
    })
    expect(friendly.title).toBe("系统拒绝读取文件")
    expect(friendly.detail).toContain("Windows 文件权限")
  })

  it("classifies legacy unstructured authorization errors without weakening the boundary", () => {
    const normalized = normalizeFilePreviewError(
      new Error("Access denied: external file preview has no trusted source grant")
    )
    expect(normalized.code).toBe(WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_MISSING)
    expect(formatFilePreviewError(normalized).title).toBe("文件预览需要授权")
  })
})
