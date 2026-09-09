export type FilePreviewMode = "preview" | "source"

export type HtmlPreviewPolicy = "workspace-static"

export type TextPreviewKind = "markdown" | "html" | "code"

function fileExtension(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : ""
}

export function resourcePreviewModeForPath(filePath: string): FilePreviewMode | undefined {
  const extension = fileExtension(filePath)
  return extension === "html" || extension === "htm" ? "source" : undefined
}

export function workspaceFilePreviewModeForPath(filePath: string): FilePreviewMode | undefined {
  const extension = fileExtension(filePath)
  return extension === "html" || extension === "htm" ? "preview" : undefined
}

export function textPreviewKind(input: {
  markdownLike: boolean
  htmlLike: boolean
  allowHtmlRender: boolean
  previewMode?: FilePreviewMode
  truncated: boolean
}): TextPreviewKind {
  if (input.markdownLike) return "markdown"
  if (
    input.htmlLike &&
    input.allowHtmlRender &&
    input.previewMode === "preview" &&
    !input.truncated
  ) {
    return "html"
  }
  return "code"
}
