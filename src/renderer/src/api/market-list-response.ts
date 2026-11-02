import type { MarketItem } from "./market"
import { RemoteJsonResponseError } from "./json-response"

/** A failed catalog is never a successful empty list or a partly trusted set of cards. */
export function marketListItems(data: unknown, response: Response): MarketItem[] {
  const fields = [
    "chinese_name",
    "description",
    "category",
    "featured",
    "guidance",
    "filename",
    "version",
    "type"
  ]
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray((data as { items?: unknown }).items)
  )
    throw new RemoteJsonResponseError(response, "应用市场", "invalid-shape")
  const items = (data as { items: unknown[] }).items
  if (
    items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>).name !== "string" ||
        !(item as { name: string }).name.trim() ||
        fields.some((field) => {
          const value = (item as Record<string, unknown>)[field]
          return value !== undefined && value !== null && typeof value !== "string"
        })
    )
  )
    throw new RemoteJsonResponseError(response, "应用市场", "invalid-shape")
  return items as MarketItem[]
}
