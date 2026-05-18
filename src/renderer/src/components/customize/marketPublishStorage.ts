import type { MarketItemType } from "../../api/market"

export function readUploadedItemNamesFromStorage(type: MarketItemType): Set<string> {
  try {
    const raw = localStorage.getItem("marketplace_uploaded_items")
    const parsed: Array<{ name?: string; type?: MarketItemType }> = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((item) => item?.type === type && item.name)
        .map((item) => String(item.name).trim().toLowerCase())
        .filter(Boolean)
    )
  } catch (error) {
    console.warn("[marketPublishStorage] Failed to read uploaded items:", error)
    return new Set()
  }
}

export function markUploadedItemInStorage(name: string, type: MarketItemType): void {
  try {
    const raw = localStorage.getItem("marketplace_uploaded_items")
    const parsed: Array<{ name?: string; type?: MarketItemType; uploadedAt?: string }> = raw
      ? JSON.parse(raw)
      : []
    const records = Array.isArray(parsed) ? parsed : []
    const next = records.filter((item) => !(item?.name === name && item?.type === type))
    next.push({ name, type, uploadedAt: new Date().toISOString() })
    localStorage.setItem("marketplace_uploaded_items", JSON.stringify(next))
  } catch (error) {
    console.warn("[marketPublishStorage] Failed to mark uploaded item:", error)
  }
}
