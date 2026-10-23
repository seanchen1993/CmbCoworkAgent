export function resolveHtmlPreviewBrowserUrl(
  browserUrl: string,
  workspacePath?: string | null,
  platform = window.electron.process.platform
): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(browserUrl)) return browserUrl

  const normalizedFile = browserUrl.replace(/\\/g, "/")
  const isAbsolute =
    /^[a-zA-Z]:\//.test(normalizedFile) ||
    normalizedFile.startsWith("//") ||
    normalizedFile.startsWith("/")
  if (!isAbsolute && !workspacePath) return browserUrl
  const absolutePath = isAbsolute
    ? normalizedFile
    : `${workspacePath!.replace(/\\/g, "/").replace(/\/+$/, "")}/${normalizedFile.replace(/^\/+/, "")}`
  return platform === "win32"
    ? `file:///${encodeURI(absolutePath)}`
    : `file://${encodeURI(absolutePath)}`
}
