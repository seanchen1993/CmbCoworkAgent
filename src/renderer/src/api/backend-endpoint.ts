/** Missing optional remote capability; never a successful empty remote response. */
export class BackendNotConfiguredError extends Error {
  readonly code = "BACKEND_NOT_CONFIGURED"

  constructor(service: string) {
    super(`未配置有效的${service}地址，本地功能仍可使用。`)
    this.name = "BackendNotConfiguredError"
  }
}

export function isBackendNotConfiguredError(error: unknown): error is BackendNotConfiguredError {
  return error instanceof BackendNotConfiguredError
}

export function resolveBackendEndpoint(
  base: unknown,
  suffix: string,
  service: string,
  documentProtocol = globalThis.location?.protocol
): string {
  const value = typeof base === "string" ? base.trim() : ""
  const webDocument = documentProtocol === "http:" || documentProtocol === "https:"
  if (value.toLowerCase().startsWith("http://") || value.toLowerCase().startsWith("https://")) {
    try {
      const parsed = new URL(value)
      if (!parsed.hostname) throw new BackendNotConfiguredError(service)
      // Preserve the configured prefix and original endpoint concatenation semantics.
      return value + suffix
    } catch {
      throw new BackendNotConfiguredError(service)
    }
  }
  // Vite's same-origin proxy is valid on HTTP(S), never relative to a packaged file URL.
  if (webDocument && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      // This origin is only for parsing; the returned request remains the original relative URL.
      const resolved = new URL(value + suffix, documentProtocol + "//backend.invalid/")
      if (resolved.protocol === "http:" || resolved.protocol === "https:") return value + suffix
    } catch {
      throw new BackendNotConfiguredError(service)
    }
  }
  throw new BackendNotConfiguredError(service)
}
