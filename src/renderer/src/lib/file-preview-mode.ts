export type FilePreviewMode = "preview" | "source"

export type TextPreviewKind = "markdown" | "code"

function fileExtension(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  const extensionIndex = fileName.lastIndexOf(".")
  return extensionIndex >= 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : ""
}

export function filePreviewModeForPath(filePath: string): FilePreviewMode | undefined {
  const extension = fileExtension(filePath)
  return extension === "html" || extension === "htm" ? "source" : undefined
}

export function textPreviewKind(input: {
  markdownLike: boolean
  htmlLike: boolean
  previewMode?: FilePreviewMode
  truncated: boolean
}): TextPreviewKind {
  if (input.markdownLike) return "markdown"
  return "code"
}
