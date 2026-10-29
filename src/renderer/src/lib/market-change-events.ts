type PublishedMarketType = "skill" | "mcp" | "plugin"
const MARKET_PUBLISHED = "cmb:market-published"
const MCP_INSTALLATION_CHANGED = "cmb:mcp-installation-changed"

export function notifyMarketPublished(type: PublishedMarketType): void {
  window.dispatchEvent(new CustomEvent(MARKET_PUBLISHED, { detail: type }))
}

export function onMarketPublished(listener: (type: PublishedMarketType) => void): () => void {
  const handler = (event: Event): void =>
    listener((event as CustomEvent<PublishedMarketType>).detail)
  window.addEventListener(MARKET_PUBLISHED, handler)
  return () => window.removeEventListener(MARKET_PUBLISHED, handler)
}

export function notifyMcpInstallationChanged(): void {
  window.dispatchEvent(new Event(MCP_INSTALLATION_CHANGED))
}

export function onMcpInstallationChanged(listener: () => void): () => void {
  window.addEventListener(MCP_INSTALLATION_CHANGED, listener)
  return () => window.removeEventListener(MCP_INSTALLATION_CHANGED, listener)
}
