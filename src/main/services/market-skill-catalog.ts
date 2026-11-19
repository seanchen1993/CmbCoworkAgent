import { createHash } from "node:crypto"
import { BrowserWindow } from "electron"
import {
  MARKET_SKILL_CATALOG_CHANGED,
  MARKET_SKILL_LIST_MAX_ITEMS,
  MARKET_SKILL_LIST_MAX_RESPONSE_BYTES,
  type MarketSkillCatalogPage
} from "../../shared/market-skill-catalog"
import { readBoundedResponse } from "./market-source-access"

export function marketSkillUrl(route: string): string {
  const base = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "")
  if (!base) throw new Error("Market base URL is not configured")
  return base + "/api/trajectories/marketplace" + route
}

let snapshot: { items: unknown[]; hash: string } | undefined
let pending: Promise<MarketSkillCatalogPage> | undefined

function publishCatalog(next: typeof snapshot): void {
  const changed = next?.hash !== snapshot?.hash
  snapshot = next
  if (!changed) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(MARKET_SKILL_CATALOG_CHANGED)
  }
}

async function fetchCatalog(): Promise<MarketSkillCatalogPage> {
  try {
    const response = await fetch(marketSkillUrl("/list/skill"), {
      headers: { "Content-Type": "application/json" }
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("HTTP error! status: " + response.status)
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel()
      throw new Error("Response is not JSON")
    }
    const body = await readBoundedResponse(response, MARKET_SKILL_LIST_MAX_RESPONSE_BYTES)
    if (!body) throw new Error("Market skill list is unavailable")
    const data = JSON.parse(new TextDecoder().decode(body)) as { items?: unknown }
    const items = Array.isArray(data.items) ? data.items : []
    publishCatalog({ items, hash: createHash("sha256").update(body).digest("hex") })
    return { items: items.slice(0, MARKET_SKILL_LIST_MAX_ITEMS), total: items.length }
  } catch (error) {
    publishCatalog(undefined)
    throw error
  }
}

// Only the existing market catalog readers request the list. Shortcuts can
// read a completed snapshot while a slow market request is still in progress.
export function refreshMarketSkillCatalog(): Promise<MarketSkillCatalogPage> {
  pending ??= fetchCatalog().finally(() => {
    pending = undefined
  })
  return pending
}

export function readMarketSkillCatalog(): readonly unknown[] {
  return snapshot?.items ?? []
}
