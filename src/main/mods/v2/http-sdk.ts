import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { pipeline, Transform, Writable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

const MAX_BODY = 512 * 1024
const MAX_RESPONSE = 256 * 1024
const MAX_HEADERS = 32 * 1024
const MAX_WIRE_RESULT = 900_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"])
const HOST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept-encoding"
])
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export interface FunctionHttpRequest {
  url: string
  method: string
  headers: Readonly<Record<string, string>>
  body?: string
}

export interface FunctionHttpContext {
  signal: AbortSignal
  assertLive(): void
  /** Approves this exact immutable request, after hook rewriting and redirect normalization. */
  authorize(request: Readonly<FunctionHttpRequest>, signal: AbortSignal): Promise<void>
  publish(response: ModObject, signal: AbortSignal): Promise<ModObject>
}

function failure(code: string): ModFunctionError {
  return new ModFunctionError(code)
}

function checkedUrl(raw: string): URL {
  if (raw.length > 8192) throw failure("MODS_HTTP_URL")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw failure("MODS_HTTP_URL")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw failure("MODS_HTTP_URL")
  url.hash = ""
  return url
}

/** Bounded text transport. No credentials, Unix sockets, implicit environment headers or proxy. */
export function functionHttpRequest(input: ModObject): Readonly<FunctionHttpRequest> {
  if (
    typeof input.url !== "string" ||
    Object.keys(input).some((key) => !["url", "init"].includes(key))
  )
    throw failure("MODS_HTTP_ARGUMENTS")
  const init = input.init === undefined ? {} : input.init
  if (!isModObject(init)) throw failure("MODS_HTTP_ARGUMENTS")
  if (init.auth !== undefined) throw failure("MODS_HTTP_AUTH_UNSUPPORTED")
  if (init.socketPath !== undefined) throw failure("MODS_HTTP_SOCKET_UNSUPPORTED")
  if (
    Object.keys(init).some(
      (key) => !["method", "headers", "body", "auth", "socketPath"].includes(key)
    )
  )
    throw failure("MODS_HTTP_ARGUMENTS")
  if (init.method !== undefined && typeof init.method !== "string")
    throw failure("MODS_HTTP_METHOD")
  const method = (init.method ?? "GET").toUpperCase()
  if (!TOKEN.test(method) || ["CONNECT", "TRACE", "TRACK"].includes(method))
    throw failure("MODS_HTTP_METHOD")
  if (
    init.body !== undefined &&
    (typeof init.body !== "string" || Buffer.byteLength(init.body) > MAX_BODY)
  )
    throw failure("MODS_HTTP_BODY_LIMIT")
  if (init.body !== undefined && ["GET", "HEAD"].includes(method))
    throw failure("MODS_HTTP_BODY_METHOD")
  if (init.headers !== undefined && !isModObject(init.headers)) throw failure("MODS_HTTP_HEADERS")
  const headers: Record<string, string> = Object.create(null)
  let bytes = 0
  const entries = Object.entries(init.headers ?? {})
  if (entries.length > 64) throw failure("MODS_HTTP_HEADERS")
  for (const [key, value] of entries) {
    if (!TOKEN.test(key) || typeof value !== "string" || /[^\t\x20-\x7e\x80-\xff]/.test(value))
      throw failure("MODS_HTTP_HEADERS")
    if ((bytes += Buffer.byteLength(key) + Buffer.byteLength(value)) > MAX_HEADERS)
      throw failure("MODS_HTTP_HEADERS")
    const name = key.toLowerCase()
    if (!HOST_HEADERS.has(name)) headers[name] = value
  }
  headers["accept-encoding"] = "gzip, deflate, br"
  if (typeof init.body === "string")
    headers["content-length"] = String(Buffer.byteLength(init.body))
  return Object.freeze({
    url: checkedUrl(input.url).href,
    method,
    headers: Object.freeze(headers),
    ...(typeof init.body === "string" ? { body: init.body } : {})
  })
}

function assertActive(context: FunctionHttpContext, signal: AbortSignal): void {
  signal.throwIfAborted()
  context.assertLive()
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => {})
  signal.throwIfAborted()
  let stop!: () => void
  const abort = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? failure("MODS_CANCELLED"))
    signal.addEventListener("abort", stop, { once: true })
  })
  try {
    return await Promise.race([promise, abort])
  } finally {
    signal.removeEventListener("abort", stop)
  }
}

function responseHeaders(response: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  let bytes = 0
  for (const [key, raw] of Object.entries(response.headers)) {
    if (raw === undefined) continue
    const value = Array.isArray(raw) ? raw.join(", ") : raw
    if ((bytes += Buffer.byteLength(key) + Buffer.byteLength(value)) > MAX_HEADERS)
      throw failure("MODS_HTTP_HEADERS_LIMIT")
    headers[key.toLowerCase()] = value
  }
  return headers
}

interface HttpHop {
  status: number
  headers: Record<string, string>
  text: string
}

function requestHop(
  request: FunctionHttpRequest,
  context: FunctionHttpContext,
  signal: AbortSignal
): Promise<HttpHop> {
  assertActive(context, signal)
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined
    let decoder: Transform | undefined
    let wireCounter: Transform | undefined
    let collector: Writable | undefined
    let settled = false
    const finish = (error?: unknown, value?: HttpHop) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      if (error) {
        response?.destroy()
        outgoing.destroy()
        wireCounter?.destroy()
        decoder?.destroy()
        collector?.destroy()
        reject(error)
      } else resolve(value!)
    }
    const abort = () => finish(signal.reason ?? failure("MODS_CANCELLED"))
    const transport = request.url.startsWith("https:") ? httpsRequest : httpRequest
    const outgoing = transport(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        maxHeaderSize: MAX_HEADERS,
        agent: false
      },
      (incoming) => {
        if (settled) {
          incoming.destroy()
          return
        }
        response = incoming
        incoming.once("error", () => finish(failure("MODS_HTTP_NETWORK")))
        incoming.once("aborted", () => finish(failure("MODS_HTTP_NETWORK")))
        try {
          assertActive(context, signal)
          const status = incoming.statusCode ?? 0
          const headers = responseHeaders(incoming)
          if (REDIRECTS.has(status) && headers.location) {
            // Never buffer redirect bodies. The next destination gets an independent approval.
            finish(undefined, { status, headers, text: "" })
            incoming.destroy()
            return
          }
          // These statuses carry no entity. Length/encoding may describe the selected resource.
          if (request.method === "HEAD" || status === 204 || status === 304) {
            finish(undefined, { status, headers, text: "" })
            incoming.destroy()
            outgoing.destroy()
            return
          }
          const encoding = (headers["content-encoding"] ?? "identity").trim().toLowerCase()
          if (!["identity", "gzip", "deflate", "br"].includes(encoding))
            throw failure("MODS_HTTP_ENCODING_UNSUPPORTED")
          if (Number(headers["content-length"]) > MAX_RESPONSE)
            throw failure("MODS_HTTP_RESPONSE_LIMIT")
          const chunks: Buffer[] = []
          let wireBytes = 0
          let decodedBytes = 0
          wireCounter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              try {
                assertActive(context, signal)
                if ((wireBytes += chunk.length) > MAX_RESPONSE)
                  throw failure("MODS_HTTP_RESPONSE_LIMIT")
                callback(null, chunk)
              } catch (error) {
                finish(error)
                callback(error as Error)
              }
            }
          })
          if (encoding !== "identity") {
            decoder =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "deflate"
                  ? createInflate()
                  : createBrotliDecompress()
            decoder.once("error", () => finish(failure("MODS_HTTP_DECOMPRESSION")))
          }
          collector = new Writable({
            write(chunk: Buffer, _encoding, callback) {
              try {
                assertActive(context, signal)
                if ((decodedBytes += chunk.length) > MAX_RESPONSE)
                  throw failure("MODS_HTTP_RESPONSE_LIMIT")
                chunks.push(chunk)
                callback()
              } catch (error) {
                finish(error)
                callback(error as Error)
              }
            }
          })
          // pipeline preserves backpressure and destroys every stage on an early failure.
          // Keep wire response headers for compatibility; text is always decoded UTF-8.
          pipeline([incoming, wireCounter, ...(decoder ? [decoder] : []), collector], (error) => {
            if (error) {
              finish(error instanceof ModFunctionError ? error : failure("MODS_HTTP_NETWORK"))
              return
            }
            try {
              assertActive(context, signal)
              finish(undefined, { status, headers, text: Buffer.concat(chunks).toString("utf8") })
            } catch (error) {
              finish(error)
            }
          })
        } catch (error) {
          finish(error)
        }
      }
    )
    outgoing.once("error", () => finish(failure("MODS_HTTP_NETWORK")))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    outgoing.end(request.body)
  })
}

/** Host-only implementation; authorization must be supplied by the actual product boundary. */
export class FunctionHttpHost {
  constructor(private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw failure("MODS_HTTP_TIMEOUT_ARGUMENT")
  }

  async fetch(input: ModObject, context: FunctionHttpContext): Promise<ModObject> {
    let request = functionHttpRequest(input)
    const timeout = new AbortController()
    const signal = AbortSignal.any([context.signal, timeout.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      for (let redirects = 0; ; redirects++) {
        assertActive(context, signal)
        await abortable(context.authorize(request, signal), signal)
        assertActive(context, signal)
        // User approval before the first network operation does not consume the HTTP timeout.
        timer ??= setTimeout(() => timeout.abort(failure("MODS_HTTP_TIMEOUT")), this.timeoutMs)
        const response = await requestHop(request, context, signal)
        assertActive(context, signal)
        if (REDIRECTS.has(response.status) && response.headers.location) {
          if (redirects >= 5) throw failure("MODS_HTTP_REDIRECT_LIMIT")
          let destination: URL
          try {
            destination = checkedUrl(new URL(response.headers.location, request.url).href)
          } catch {
            throw failure("MODS_HTTP_REDIRECT_URL")
          }
          const headers: Record<string, string> = { ...request.headers }
          if (destination.origin !== new URL(request.url).origin)
            for (const name of Object.keys(headers))
              if (!CROSS_ORIGIN_HEADERS.has(name)) delete headers[name]
          const switchToGet =
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && request.method === "POST")
          request = functionHttpRequest({
            url: destination.href,
            init: {
              method: switchToGet ? "GET" : request.method,
              headers,
              ...(!switchToGet && request.body !== undefined ? { body: request.body } : {})
            }
          })
          continue
        }
        const result: ModObject = {
          ...response,
          ok: response.status >= 200 && response.status < 300
        }
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_WIRE_RESULT)
          throw failure("MODS_HTTP_RESPONSE_LIMIT")
        const published = await abortable(context.publish(result, signal), signal)
        assertActive(context, signal)
        if (Buffer.byteLength(JSON.stringify(published)) > MAX_WIRE_RESULT)
          throw failure("MODS_HTTP_RESPONSE_LIMIT")
        return published
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
