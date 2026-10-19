import { resolveBackendEndpoint } from "./backend-endpoint"

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

    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      return { success: false, error: "Response is not JSON" }
    }

    const data = (await response.json()) as MarketPluginListResponse
    return { success: true, data: Array.isArray(data.items) ? data.items : [] }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}
