import { getUserInfo } from "../storage"
import {
  getMarketSourceAccess,
  type MarketSourceAccess,
  type MarketSourceIdentity
} from "../../shared/market-source-access"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Fetch policy from the market, never trust a renderer-supplied owner/allowlist flag. */
export async function resolveMarketSourceAccess(
  type: "skill" | "plugin",
  identity?: MarketSourceIdentity
): Promise<MarketSourceAccess | undefined> {
  if (!identity || typeof identity.name !== "string" || !identity.name.trim()) return undefined
  const base = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "")
  if (!base) return undefined
  try {
    const user = getUserInfo()
    if (!user?.sapId?.trim() && !user?.ystId?.trim()) return undefined
    const response = await fetch(`${base}/api/trajectories/marketplace/list/${type}`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      return undefined
    }
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) return undefined
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { items?: unknown[] }
    if (!Array.isArray(data.items)) return undefined
    const items = data.items.filter(
      (
        item
      ): item is {
        name: string
        id?: string
        user_id?: string
        extra_json?: string
      } =>
        Boolean(
          item && typeof item === "object" && (item as { name?: unknown }).name === identity.name
        )
    )
    if (items.length !== 1) return undefined
    const item = items[0]
    if (
      identity.id &&
      item.id !== identity.id &&
      !(item.id === undefined && identity.id === identity.name)
    )
      return undefined
    // An account switch while the request is in flight must not grant another account access.
    const current = getUserInfo()
    if (current?.sapId !== user.sapId || current?.ystId !== user.ystId) return undefined
    return getMarketSourceAccess(item, current)
  } catch {
    return undefined
  }
}
