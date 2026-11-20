import { protocol } from "electron"
import { Readable } from "node:stream"
import {
  WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS,
  WORKSPACE_FILE_PREVIEW_SCHEME,
  WorkspaceFilePreviewMediaRegistry
} from "./media-registry"

export const workspaceFilePreviewMediaRegistry = new WorkspaceFilePreviewMediaRegistry()

let protocolRegistered = false
let cleanupTimer: NodeJS.Timeout | null = null

export type MediaByteRange = { start: number; end: number } | { invalid: true } | null

export function parseMediaByteRange(header: string | null, size: number): MediaByteRange {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || size <= 0) return { invalid: true }
  const startText = match[1]
  const endText = match[2]
  if (!startText && !endText) return { invalid: true }
  if (!startText) {
    const suffixLength = Number(endText)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true }
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(startText)
  const requestedEnd = endText ? Number(endText) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return { invalid: true }
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

export function registerWorkspaceFilePreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKSPACE_FILE_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

export async function handleWorkspaceFilePreviewProtocolRequest(
  request: Request,
  registry: WorkspaceFilePreviewMediaRegistry = workspaceFilePreviewMediaRegistry
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 })
  }
  let token: string
  try {
    const url = new URL(request.url)
    token = url.hostname
  } catch {
    return new Response("Invalid preview URL", { status: 400 })
  }
  const entry = registry.lookup(token)
  if (!entry) return new Response("Preview expired", { status: 410 })

  let currentSize: number
  try {
    const currentStat = await entry.fileHandle.stat()
    if (!currentStat.isFile() || currentStat.size !== entry.size) {
      return new Response("Preview file changed after authorization", { status: 409 })
    }
    currentSize = currentStat.size
  } catch {
    return new Response("Preview file is unavailable", { status: 404 })
  }
  const range = parseMediaByteRange(request.headers.get("range"), currentSize)
  if (range && "invalid" in range) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${currentSize}`, "accept-ranges": "bytes" }
    })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? Math.max(0, currentSize - 1)
  const contentLength = currentSize === 0 ? 0 : end - start + 1
  const responseHeaders = new Headers()
  responseHeaders.set("content-type", entry.mimeType)
  responseHeaders.set("content-length", String(contentLength))
  responseHeaders.set("accept-ranges", "bytes")
  responseHeaders.set("last-modified", entry.modified_at)
  if (range && !("invalid" in range)) {
    responseHeaders.set("content-range", `bytes ${start}-${end}/${currentSize}`)
  }
  responseHeaders.set("cache-control", "no-store, private")
  responseHeaders.set("x-content-type-options", "nosniff")
  responseHeaders.set("content-security-policy", "default-src 'none'; sandbox")
  responseHeaders.set(
    "content-disposition",
    entry.mimeType === "application/octet-stream" ? "attachment" : "inline"
  )
  const body =
    request.method === "HEAD" || currentSize === 0
      ? null
      : (Readable.toWeb(
          entry.fileHandle.createReadStream({ start, end, autoClose: false })
        ) as ReadableStream)
  return new Response(body, {
    status: range ? 206 : 200,
    headers: responseHeaders
  })
}

export function registerWorkspaceFilePreviewProtocol(): void {
  if (protocolRegistered) return
  protocolRegistered = true
  protocol.handle(WORKSPACE_FILE_PREVIEW_SCHEME, (request) =>
    handleWorkspaceFilePreviewProtocolRequest(request)
  )

  cleanupTimer = setInterval(
    () => workspaceFilePreviewMediaRegistry.pruneExpired(),
    Math.min(60_000, WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS)
  )
  cleanupTimer.unref()
}

export function closeWorkspaceFilePreviewProtocol(): void {
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = null
  workspaceFilePreviewMediaRegistry.clear()
  if (protocolRegistered) protocol.unhandle(WORKSPACE_FILE_PREVIEW_SCHEME)
  protocolRegistered = false
}
