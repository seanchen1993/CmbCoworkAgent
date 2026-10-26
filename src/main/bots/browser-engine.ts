import type { BrowserContext, Page } from "playwright"

export type BotBrowserToolbarAction = {
  action: "back" | "forward" | "reload" | "new" | "close" | "navigate" | "return"
  url?: string
}

/** Local Electron and future remote engines keep process/platform effects outside Bot coordination. */
export interface BotBrowserEngine {
  context: BrowserContext
  createPage(): Promise<Page>
  /** Browser-owned metadata must remain readable while a page's JavaScript dialog is open. */
  getTitle(page: Page): Promise<string>
  getPageState(page: Page): Promise<{ title: string; canGoBack: boolean; canGoForward: boolean }>
  /** Capture the owned native surface without waiting for page scripts or fonts. */
  capturePage(page: Page): Promise<Buffer>
  show(page: Page, generation?: number, instruction?: string): Promise<void>
  onWindowHidden(listener: (page: Page, generation: number) => void): () => void
  /** Exclude trusted browser chrome from task-owned content pages. */
  isContentPage?(page: Page): Promise<boolean>
  onToolbarAction?(
    listener: (page: Page, generation: number, action: BotBrowserToolbarAction) => Promise<void>
  ): () => void
  hide(): Promise<void>
  close(): Promise<void>
}
