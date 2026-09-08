import type { BrowserService } from "./browser-service"

let activeBrowserService: BrowserService | null = null

export function setGlobalBrowserService(service: BrowserService | null): void {
  activeBrowserService = service
}

export function getGlobalBrowserService(): BrowserService | null {
  return activeBrowserService
}
