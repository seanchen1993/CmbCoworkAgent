const safeId = /^[a-zA-Z0-9._:-]{1,160}$/
const knownMime = new Set([
  "text/event-stream",
  "application/json",
  "application/problem+json",
  "text/plain"
])
export interface SafeModelResponseHeaders {
  status: number
  requestId?: string
  contentType: string | null
}
const responses = new WeakMap<Response, SafeModelResponseHeaders>()

export function safeModelRequestId(
  value: string | null | undefined,
  secrets: readonly string[] = []
): string | undefined {
  if (
    !value ||
    !safeId.test(value) ||
    secrets.some(
      (secret) =>
        secret &&
        (value.includes(secret) ||
          (value.length >= 8 && secret.startsWith(value)) ||
          (secret.length > 160 && value.includes(secret.slice(0, 160))))
    )
  )
    return undefined
  return value
}

/** Cache only protocol metadata, without retaining the response/body/credentials. */
export function modelResponseHeaders(
  response: Response,
  secrets: readonly string[] = []
): SafeModelResponseHeaders {
  const previous = responses.get(response)
  if (previous) {
    if (!previous.requestId || safeModelRequestId(previous.requestId, secrets)) return previous
    const filtered = Object.freeze({ status: previous.status, contentType: previous.contentType })
    responses.set(response, filtered)
    return filtered
  }
  const mime = response.headers
    .get("content-type")
    ?.slice(0, 128)
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase()
  const requestId = safeModelRequestId(response.headers.get("x-request-id"), secrets)
  const metadata = Object.freeze({
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    contentType: mime && knownMime.has(mime) ? mime : null
  })
  responses.set(response, metadata)
  return metadata
}

export function inheritModelResponseHeaders(original: Response, wrapped: Response): Response {
  responses.set(wrapped, modelResponseHeaders(original))
  return wrapped
}
