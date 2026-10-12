import { Resolver } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { checkServerIdentity } from "node:tls"
import type { IncomingHttpHeaders, IncomingMessage, ClientRequest } from "node:http"
import type { RequestOptions } from "node:https"
import type { LookupAddress } from "node:dns"
import { normalizeBotPreviewUrl } from "../../shared/bot-link-preview"

export class LinkPreviewFailure extends Error {
  constructor(
    readonly reason: "blocked" | "timeout" | "cancelled" | "unavailable" | "proxy_unsupported"
  ) {
    super(reason)
  }
}
const blocked = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const)
  blocked.addSubnet(network, prefix, "ipv4")
// IPv6 requires global-unicast 2000::/3 below; also exclude reserved transition/special ranges.
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
] as const)
  blocked.addSubnet(network, prefix, "ipv6")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
export function isPublicPreviewAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  if (family !== 6) return false
  // This denies all IPv4-mapped/NAT64/local/link-local/multicast forms, even public embedded IPv4.
  return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6")
}
export interface PublicPreviewResponse {
  status: number
  headers: IncomingHttpHeaders
  bytes: Buffer
  finalUrl: string
}
export type PublicPreviewRequest = (
  options: RequestOptions,
  listener: (response: IncomingMessage) => void
) => ClientRequest
export type PublicPreviewResolver = (
  hostname: string,
  signal: AbortSignal
) => Promise<LookupAddress[]>
export async function resolvePublicPreviewAddresses(
  hostname: string,
  signal: AbortSignal,
  resolverFactory: () => Resolver = () => new Resolver({ timeout: 2000, tries: 1 })
): Promise<LookupAddress[]> {
  signal.throwIfAborted()
  const resolver = resolverFactory()
  const abort = () => resolver.cancel()
  signal.addEventListener("abort", abort, { once: true })
  try {
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname)
    ])
    signal.throwIfAborted()
    const values: LookupAddress[] = []
    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index]
      if (answer.status === "fulfilled")
        values.push(
          ...answer.value.map((address) => ({
            address,
            family: index === 0 ? 4 : 6
          }))
        )
      else {
        const code =
          typeof answer.reason === "object" && answer.reason !== null && "code" in answer.reason
            ? answer.reason.code
            : undefined
        if (code !== "ENODATA" && code !== "ENOTFOUND") throw new LinkPreviewFailure("unavailable")
      }
    }
    return values
  } finally {
    signal.removeEventListener("abort", abort)
    resolver.cancel()
  }
}
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
export class PublicLinkFetcher {
  constructor(
    private readonly resolve: PublicPreviewResolver = resolvePublicPreviewAddresses,
    private readonly request: PublicPreviewRequest = httpsRequest
  ) {}
  async fetch(
    raw: string,
    kind: "html" | "image",
    signal: AbortSignal,
    beforeRoute?: (url: string, signal: AbortSignal) => Promise<void>
  ): Promise<PublicPreviewResponse> {
    let current = normalizeBotPreviewUrl(raw)
    if (!current) throw new LinkPreviewFailure("blocked")
    const visited = new Set<string>()
    for (let redirect = 0; redirect <= 3; redirect++) {
      signal.throwIfAborted()
      if (visited.has(current)) throw new LinkPreviewFailure("blocked")
      visited.add(current)
      if (beforeRoute) await beforeRoute(current, signal)
      signal.throwIfAborted()
      const response = await this.once(new URL(current), kind, signal)
      if (!REDIRECTS.has(response.status)) return { ...response, finalUrl: current }
      const location = first(response.headers.location)
      if (!location || location.length > 2048 || redirect === 3)
        throw new LinkPreviewFailure("blocked")
      try {
        current = normalizeBotPreviewUrl(new URL(location, current).href)
      } catch {
        current = null
      }
      if (!current) throw new LinkPreviewFailure("blocked")
    }
    throw new LinkPreviewFailure("blocked")
  }
  private async once(
    url: URL,
    kind: "html" | "image",
    signal: AbortSignal
  ): Promise<Omit<PublicPreviewResponse, "finalUrl">> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const records = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolve(hostname, signal)
    signal.throwIfAborted()
    if (
      !records.length ||
      records.length > 32 ||
      records.some(
        (record) =>
          isIP(record.address) !== record.family || !isPublicPreviewAddress(record.address)
      )
    )
      throw new LinkPreviewFailure("blocked")
    const pinned = records.find((record) => record.family === 4) ?? records[0]
    const cap = kind === "html" ? 256 * 1024 : 512 * 1024
    let destroy: (() => void) | undefined
    let release: Promise<void> = Promise.resolve()
    try {
      return await new Promise<Omit<PublicPreviewResponse, "finalUrl">>((resolve, reject) => {
        let finished = false
        const chunks: Buffer[] = []
        let total = 0
        const fail = (error: unknown) => {
          if (finished) return
          finished = true
          destroy?.()
          reject(
            error instanceof LinkPreviewFailure
              ? error
              : new LinkPreviewFailure(signal.aborted ? "cancelled" : "unavailable")
          )
        }
        const req = this.request(
          {
            host: pinned.address,
            port: 443,
            servername: isIP(hostname) ? undefined : hostname,
            checkServerIdentity: (_server, certificate) =>
              checkServerIdentity(hostname, certificate),
            method: "GET",
            path: url.pathname + url.search,
            agent: false,
            maxHeaderSize: 16 * 1024,
            headers: {
              host: url.host,
              accept:
                kind === "html"
                  ? "text/html,application/xhtml+xml"
                  : "image/png,image/jpeg,image/webp,image/gif",
              "accept-encoding": "identity",
              connection: "close",
              "user-agent": "CMBDevClaw-LinkPreview/1.0"
            }
          },
          (response) => {
            const status = response.statusCode ?? 0
            const complete = () => {
              if (finished) return
              finished = true
              const bytes = Buffer.concat(chunks, total)
              response.destroy()
              req.destroy()
              resolve({ status, headers: response.headers, bytes })
            }
            response.on("error", fail)
            response.on("aborted", () => fail(new LinkPreviewFailure("unavailable")))
            if (REDIRECTS.has(status)) {
              complete()
              return
            }
            const mime = (first(response.headers["content-type"]) ?? "")
              .split(";", 1)[0]
              .trim()
              .toLowerCase()
            const allowed =
              kind === "html"
                ? ["text/html", "application/xhtml+xml"]
                : ["image/png", "image/jpeg", "image/webp", "image/gif"]
            const encoding = (first(response.headers["content-encoding"]) ?? "identity")
              .trim()
              .toLowerCase()
            const length = first(response.headers["content-length"])
            if (
              status < 200 ||
              status >= 300 ||
              !allowed.includes(mime) ||
              encoding !== "identity" ||
              (length !== undefined && (!/^\d+$/.test(length) || Number(length) > cap))
            ) {
              fail(new LinkPreviewFailure("unavailable"))
              return
            }
            response.on("data", (chunk: Buffer) => {
              if (finished) return
              if (total + chunk.length > cap) {
                fail(new LinkPreviewFailure("unavailable"))
                return
              }
              chunks.push(chunk)
              total += chunk.length
            })
            response.on("end", complete)
          }
        )
        destroy = () => req.destroy()
        release = new Promise<void>((done) => req.once("close", () => done()))
        const abort = () => fail(new LinkPreviewFailure("cancelled"))
        req.once("close", () => signal.removeEventListener("abort", abort))
        req.on("error", fail)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        else req.end()
      })
    } finally {
      destroy?.()
      await release
    }
  }
}
