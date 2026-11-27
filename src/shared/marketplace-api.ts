export const MARKETPLACE_API_PATH = "/api/trajectories/marketplace"

export const marketplaceEndpoints = {
  list: (type: string) => `/list/${encodeURIComponent(type)}`,
  download: (type: string, name: string) => `/download/${encodeURIComponent(type)}/${encodeURIComponent(name)}`
}

export function marketplaceApiUrl(baseUrl: string | undefined): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, "")
  return base ? `${base}${MARKETPLACE_API_PATH}` : null
}
