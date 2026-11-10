import { resolveResourcePreviewPaths } from "./resource-preview-paths"

function normalizeWindowsDrivePath(value: string): string {
  return value.replace(/^\/+([a-zA-Z]:[\\/])/, "$1")
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "")
}

function decodeHref(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    try {
      return decodeURI(value)
    } catch {
      return null
    }
  }
}

function isWindowsAbsolutePath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(value) ||
    /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value) ||
    /^\/\/\?\/UNC\/[^/]+\/[^/]+(?:\/|$)/i.test(value)
  )
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value)
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]"
}

function pathFromCustomFileScheme(value: string, scheme: "codex-file:" | "file:"): string | null {
  const rest = value.slice(scheme.length)
  if (!rest.startsWith("//")) {
    return rest || null
  }

  const authorityAndPath = rest.slice(2)
  // `codex-file://C:/repo/file` is not parsed as a normal URL: URL treats `C:`
  // as the host. Handle the drive form before looking for an authority.
  if (/^[a-zA-Z]:[\\/]/.test(authorityAndPath)) return authorityAndPath
  if (authorityAndPath.startsWith("/")) return authorityAndPath

  const slashIndex = authorityAndPath.indexOf("/")
  if (slashIndex < 0) return `//${authorityAndPath}`
  const authority = authorityAndPath.slice(0, slashIndex)
  const pathname = authorityAndPath.slice(slashIndex)
  if (authority.toLowerCase() === "localhost") return pathname
  return `//${authority}${pathname}`
}

function pathFromHref(value: string): string | null {
  const decoded = decodeHref(value.trim())
  if (!decoded) return null

  const normalizedDrivePath = normalizeWindowsDrivePath(decoded)
  if (isAbsoluteFilePath(normalizedDrivePath)) return normalizedDrivePath

  const lower = decoded.toLowerCase()
  if (lower.startsWith("codex-file:")) {
    return pathFromCustomFileScheme(decoded, "codex-file:")
  }
  if (lower.startsWith("file:")) {
    return pathFromCustomFileScheme(decoded, "file:")
  }

  let url: URL
  try {
    url = new URL(decoded)
  } catch {
    return null
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && isLocalhost(url.hostname)) {
    try {
      return decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }
  return null
}

function rendererPlatformForPaths(filePath: string, workspacePath: string): NodeJS.Platform {
  if (isWindowsAbsolutePath(filePath) || isWindowsAbsolutePath(workspacePath)) return "win32"
  if (typeof window !== "undefined") {
    const platform = window.electron?.process?.platform
    if (platform) return platform
  }
  return "linux"
}

export function normalizePreviewFileHref(
  href: string | undefined,
  workspacePath: string | null | undefined
): string | null {
  if (!href || !workspacePath) return null
  const filePath = pathFromHref(href)
  if (!filePath) return null
  const withoutLine = normalizeWindowsDrivePath(stripLineSuffix(filePath))
  if (!isAbsoluteFilePath(withoutLine)) return null

  const resolved = resolveResourcePreviewPaths(
    withoutLine,
    workspacePath,
    rendererPlatformForPaths(withoutLine, workspacePath),
    "absolute"
  )
  return resolved.inWorkspace ? resolved.fullPath : null
}

export function isLocalFileLikeHref(href: string): boolean {
  const decoded = decodeHref(href.trim())
  if (!decoded) return true
  const withoutLine = normalizeWindowsDrivePath(stripLineSuffix(decoded))
  const lower = decoded.toLowerCase()
  return (
    lower.startsWith("codex-file:") ||
    lower.startsWith("file:") ||
    /^[a-zA-Z]:[\\/]/.test(withoutLine) ||
    /^\/+[a-zA-Z]:[\\/]/.test(decoded) ||
    withoutLine.startsWith("/") ||
    /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(withoutLine) ||
    /^\/\/[^/]+\/[^/]+/.test(withoutLine)
  )
}
