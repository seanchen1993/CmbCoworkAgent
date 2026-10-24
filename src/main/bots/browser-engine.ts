import type { BrowserContext, Page } from "playwright"

/** Local Electron and future remote engines keep process/platform effects outside Bot coordination. */
export interface BotBrowserEngine {
  context: BrowserContext
  createPage(): Promise<Page>
  /** Browser-owned metadata must remain readable while a page's JavaScript dialog is open. */
  getTitle(page: Page): Promise<string>
  getPageState(page: Page): Promise<{ title: string; canGoBack: boolean; canGoForward: boolean }>
  /** Capture the owned native surface without waiting for page scripts or fonts. */
  capturePage(page: Page): Promise<Buffer>
  show(page: Page, generation?: number): Promise<void>
  onWindowHidden(listener: (page: Page, generation: number) => void): () => void
  hide(): Promise<void>
  close(): Promise<void>
}
