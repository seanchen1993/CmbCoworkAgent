import type { BrowserContext, Page } from "playwright"

/** Local Electron and future remote engines keep process/platform effects outside Bot coordination. */
export interface BotBrowserEngine {
  context: BrowserContext
  createPage(): Promise<Page>
  show(page: Page): Promise<void>
  hide(): Promise<void>
  close(): Promise<void>
}
