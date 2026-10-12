import type { Browser, BrowserContext, Page, ElementHandle } from "playwright"
export function refHandle(page: Page, ref: string): Promise<ElementHandle<HTMLElement | SVGElement>>
export interface GrokBrowserState {
  views: Record<string, string>
  lastViewId?: string
  deletedViews?: string[]
}
export interface GrokBrowserResult {
  page?: Page
  viewId?: string
  summary: string
  data?: string
  fullPage?: boolean
}
export interface GrokBrowserInputGuard {
  prepare(page?: Page): Promise<void>
  assert(page?: Page): void
  /** Trusted failure shutdown; never supplied by tool arguments. */
  stopKeyboardCleanup?(browser: Browser | null | undefined): Promise<void>
}
export function executeGrokBrowserAction(
  request: Record<string, unknown> & { op: string },
  context: Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">,
  state: GrokBrowserState,
  inputGuard?: GrokBrowserInputGuard
): Promise<GrokBrowserResult>

export function pressGrokBrowserKey(
  page: Page,
  key: string,
  stopCleanup?: (browser: Browser | null | undefined) => Promise<void>
): Promise<void>
