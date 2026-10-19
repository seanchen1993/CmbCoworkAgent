import type { BrowserContext, Page } from "playwright"

/** Local Electron and future remote engines keep process/platform effects outside Bot coordination. */
export interface BotBrowserEngine {
  context: BrowserContext
  createPage(): Promise<Page>
  /** Browser-owned metadata must remain readable while a page's JavaScript dialog is open. */
  getTitle(page: Page): Promise<string>
  show(page: Page): Promise<void>
  hide(): Promise<void>
  close(): Promise<void>
}
