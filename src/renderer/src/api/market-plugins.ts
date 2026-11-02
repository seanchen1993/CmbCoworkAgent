import { resolveBackendEndpoint } from "./backend-endpoint"
import { readJsonResponse } from "./json-response"
import { marketListItems } from "./market-list-response"

export interface MarketPluginItem {
  name?: string
  description?: string
  category?: string
  version?: string
}

interface MarketPluginListResponse {
  items?: MarketPluginItem[]
}

export interface MarketPluginListResult {
  success: boolean
  data?: MarketPluginItem[]
  error?: string
}

export async function getMarketPlugins(): Promise<MarketPluginListResult> {
  try {
    const response = await fetch(resolveBackendEndpoint(
      import.meta.env.VITE_API_BASE_URL,
      "/api/trajectories/marketplace/list/plugin",
      "应用市场服务"
    ), {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    })

    if (!response.ok) {
      return { success: false, error: `HTTP error! status: ${response.status}` }
    }

    const data = await readJsonResponse<MarketPluginListResponse>(response, "应用市场")
    return { success: true, data: marketListItems(data, response) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}
