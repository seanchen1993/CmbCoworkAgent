import { z } from "zod"
import { canonicalBotFileBase64Bytes } from "./bot-file-base64"

export const BOT_LINK_URL_BYTES = 2048
export const BOT_LINK_IMAGE_BYTES = 128 * 1024
export const BOT_LINK_PREVIEW_REASONS = [
  "blocked",
  "proxy_unsupported",
  "capacity",
  "timeout",
  "cancelled",
  "unavailable",
  "closed"
] as const
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "cluster",
  "svc",
  "arpa",
  "onion",
  "test",
  "invalid",
  "example"
]
const PUBLIC_QUERY_KEYS = new Set([
  "q",
  "query",
  "search",
  "page",
  "p",
  "offset",
  "limit",
  "lang",
  "language",
  "locale",
  "sort",
  "order",
  "tag",
  "category",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content"
])
const SECRET_KEYS =
  /(?:token|secret|password|passwd|credential|signature|session|authorization|api.?key|access.?key|private.?key|client.?secret|^key$|^code$|^state$|^sig$|^auth$|^jwt$|^saml|^x-amz-|^x-goog-)/i
const AUTH_SEGMENTS = new Set([
  "login",
  "signin",
  "sign-in",
  "sign_in",
  "sso",
  "oauth",
  "oauth2",
  "authorize",
  "authentication",
  "saml"
])

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || (code >= 127 && code <= 159)) return true
  }
  return false
}

/** Pure renderer/Main first fence. DNS and numeric-address authority remain Main only. */
export function normalizeBotPreviewUrl(raw: unknown): string | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > BOT_LINK_URL_BYTES ||
    /[\s\\]/u.test(raw) ||
    hasControl(raw)
  )
    return null
  try {
    const url = new URL(raw)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return null
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
    if (
      !hostname ||
      PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
      (!hostname.includes(".") && !hostname.includes(":"))
    )
      return null
    const labels = hostname.split(".")
    if (labels.some((label) => AUTH_SEGMENTS.has(label))) return null
    for (const rawSegment of url.pathname.split("/")) {
      const segment = decodeURIComponent(rawSegment).toLowerCase()
      if (AUTH_SEGMENTS.has(segment)) return null
    }
    let count = 0
    for (const [rawKey, rawValue] of url.searchParams) {
      if (++count > 16 || rawKey.length > 64 || rawValue.length > 256) return null
      let key = rawKey,
        value = rawValue
      for (let depth = 0; depth < 3; depth++) {
        if (
          SECRET_KEYS.test(key) ||
          /(?:bearer\s|^eyJ[A-Za-z0-9_-]{10,}\.|[A-Za-z0-9_-]{32,}|(?:https?:\/\/|\/\/))/i.test(
            value
          )
        )
          return null
        if (!key.includes("%") && !value.includes("%")) break
        if (depth === 2) return null
        key = decodeURIComponent(key)
        value = decodeURIComponent(value)
      }
      if (!PUBLIC_QUERY_KEYS.has(key.toLowerCase()) || hasControl(key) || hasControl(value))
        return null
    }
    // Fragments are never sent to the origin; do not retain fragment secrets in a card/cache.
    url.hash = ""
    url.hostname = hostname
    return url.href.length <= BOT_LINK_URL_BYTES ? url.href : null
  } catch {
    return null
  }
}

const publicUrl = z
  .string()
  .max(BOT_LINK_URL_BYTES)
  .refine((value) => normalizeBotPreviewUrl(value) === value)
export const botLinkPreviewRequest = z
  .object({ requestId: z.string().uuid(), url: publicUrl })
  .strict()
export const botLinkPreviewCancel = z.object({ requestId: z.string().uuid() }).strict()
export const botLinkPreviewImage = z
  .object({
    mime: z.literal("image/jpeg"),
    base64: z
      .string()
      .max(Math.ceil(BOT_LINK_IMAGE_BYTES / 3) * 4)
      .refine((value) => {
        const length = canonicalBotFileBase64Bytes(value, BOT_LINK_IMAGE_BYTES)
        return length !== null && length > 0
      }),
    width: z.number().int().min(1).max(480),
    height: z.number().int().min(1).max(480)
  })
  .strict()
export const botLinkPreviewMetadata = z
  .object({
    url: publicUrl,
    finalUrl: publicUrl,
    hostname: z.string().min(1).max(253),
    title: z.string().max(512),
    description: z.string().max(1024),
    siteName: z.string().max(128),
    image: botLinkPreviewImage.optional(),
    fetchedAt: z.number().int().nonnegative()
  })
  .strict()
  .refine((value) => new URL(value.finalUrl).hostname === value.hostname)
export const botLinkPreviewResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), metadata: botLinkPreviewMetadata }).strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum(BOT_LINK_PREVIEW_REASONS)
    })
    .strict()
])
export type BotLinkPreviewRequest = z.infer<typeof botLinkPreviewRequest>
export type BotLinkPreviewImage = z.infer<typeof botLinkPreviewImage>
export type BotLinkPreviewMetadata = z.infer<typeof botLinkPreviewMetadata>
export type BotLinkPreviewResult = z.infer<typeof botLinkPreviewResult>
export interface BotLinkPreviewClient {
  getLinkPreview(input: BotLinkPreviewRequest): Promise<BotLinkPreviewResult>
  cancelLinkPreview(input: { requestId: string }): Promise<void>
}
