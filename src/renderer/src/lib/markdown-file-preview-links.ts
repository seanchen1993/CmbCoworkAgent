function normalizeWindowsDrivePath(value: string): string {
  return value.replace(/^\/+([a-zA-Z]:[\\/])/, "$1")
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "")
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)
}

function normalizePathForCompare(value: string): string {
  return normalizeWindowsDrivePath(stripLineSuffix(value)).replace(/\\/g, "/").replace(/\/+$/, "")
}

function isWorkspaceFilePath(
  filePath: string,
  workspacePath: string | null | undefined
): boolean {
  if (!workspacePath) return false
  const normalizedFilePath = normalizePathForCompare(filePath)
  const normalizedWorkspacePath = normalizePathForCompare(workspacePath)
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  )
}

function isLocalhostFileUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
    return null
  }
  let filePath: string
  try {
    filePath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  return isAbsoluteFilePath(stripLineSuffix(filePath)) ? stripLineSuffix(filePath) : null
}

export function normalizePreviewFileHref(
  href: string | undefined,
  workspacePath: string | null | undefined
): string | null {
  if (!href) return null
  let decoded: string
  try {
    decoded = decodeURI(href)
  } catch {
    return null
  }
  if (decoded.startsWith("codex-file://")) {
    try {
      const url = new URL(decoded)
      return `${url.hostname ? `/${url.hostname}` : ""}${url.pathname}`
    } catch {
      return null
    }
  }
  const localhostFilePath = isLocalhostFileUrl(decoded)
  if (localhostFilePath && isWorkspaceFilePath(localhostFilePath, workspacePath)) {
    return localhostFilePath
  }
  const withoutLine = normalizeWindowsDrivePath(stripLineSuffix(decoded))
  return isAbsoluteFilePath(withoutLine) && isWorkspaceFilePath(withoutLine, workspacePath)
    ? withoutLine
    : null
}

export function isLocalFileLikeHref(href: string): boolean {
  let decoded = href.trim()
  try {
    decoded = decodeURI(decoded)
  } catch {
    return true
  }
  const withoutLine = normalizeWindowsDrivePath(stripLineSuffix(decoded))
  return (
    decoded.startsWith("codex-file://") ||
    /^[a-zA-Z]:[\\/]/.test(withoutLine) ||
    /^\/+[a-zA-Z]:[\\/]/.test(decoded) ||
    withoutLine.startsWith("/")
  )
}
