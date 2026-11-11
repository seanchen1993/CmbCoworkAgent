import { getUserInfo } from "../storage"
import {
  getMarketSourceAccess,
  type MarketSourceAccess,
  type MarketSourceIdentity
} from "../../shared/market-source-access"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer | undefined> {
  if (!response.ok || Number(response.headers.get("content-length")) > limit) {
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
      if (size > limit) return undefined
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Fetch policy from the market, never trust a renderer-supplied owner/allowlist flag. */
export async function resolveMarketSourceAccess(
  type: "skill" | "plugin",
  identity?: MarketSourceIdentity,
  installationContent?: ArrayBuffer
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
    const metadata = await readBoundedResponse(response, MAX_RESPONSE_BYTES)
    if (!metadata) return undefined
    const data = JSON.parse(metadata.toString("utf8")) as { items?: unknown[] }
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
    if (!getMarketSourceAccess(item, user)) return undefined
    // Bind the grant to the actual package, not only the renderer's market identity.
    if (installationContent !== undefined) {
      if (installationContent.byteLength > MAX_BUNDLE_BYTES) return undefined
      const download = await fetch(
        `${base}/api/trajectories/marketplace/download/${type}/${encodeURIComponent(item.name)}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      const expected = await readBoundedResponse(download, MAX_BUNDLE_BYTES)
      if (!expected || !expected.equals(Buffer.from(installationContent))) return undefined
    }
    // Include package verification in the account-switch check.
    const current = getUserInfo()
    if (current?.sapId !== user.sapId || current?.ystId !== user.ystId) return undefined
    return getMarketSourceAccess(item, current)
  } catch {
    return undefined
  }
}
