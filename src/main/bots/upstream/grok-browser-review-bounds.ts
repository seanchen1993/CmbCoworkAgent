// Copied pure action bounds and mutation classification from Grok Bot 0.18. See PROVENANCE.json.
export const SAND_BROWSER_AUTO_REVIEW_MAX_ELEMENT_CHARS = 500,
  SAND_BROWSER_AUTO_REVIEW_MAX_TEXT_CHARS = 2_000,
  SAND_BROWSER_AUTO_REVIEW_MAX_URL_CHARS = 2_000,
  SAND_BROWSER_AUTO_REVIEW_MAX_KEY_CHARS = 256,
  SAND_BROWSER_AUTO_REVIEW_MAX_CDP_PARAMS_CHARS = 2_000
const BYPASS = new Set(["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"])
export class SandBrowserAutoReviewBlockedError extends Error {
  override readonly name = "SandBrowserAutoReviewBlockedError"
}
export interface BrowserAction {
  readonly op: string
  readonly tabsAction?: string | undefined
  readonly element?: string | undefined
  readonly url?: string | undefined
  readonly text?: string | undefined
  readonly value?: string | undefined
  readonly values?: readonly string[] | undefined
  readonly key?: string | undefined
  readonly cdpMethod?: string | undefined
  readonly cdpParams?: string | undefined
  readonly tabIndex?: number | undefined
  readonly [key: string]: unknown
}
export function isSandBrowserAutoReviewMutatingAction(action: BrowserAction): boolean {
  return action.op === "tabs"
    ? action.tabsAction === "new" || action.tabsAction === "close"
    : !BYPASS.has(action.op)
}
function bounded(value: string | undefined, field: string, max: number): void {
  if ((value?.length ?? 0) > max)
    throw new SandBrowserAutoReviewBlockedError(
      `Browser Auto-review rejected oversized ${field} (max ${max} characters).`
    )
}
export function normalizeSandBrowserExactActionArgs<T extends BrowserAction>(action: T): T {
  bounded(action.url, "url", 2_000)
  bounded(action.text, "text", 2_000)
  bounded(action.value, "value", 2_000)
  bounded(action.key, "key", 256)
  bounded(action.cdpParams, "params", 2_000)
  if ((action.values?.join(", ").length ?? 0) > 2_000) bounded("x".repeat(2_001), "values", 2_000)
  return action
}
export function normalizeSandBrowserElement(element?: string): string | undefined {
  const trimmed = element?.trim()
  if (!trimmed) return undefined
  bounded(trimmed, "element", 500)
  return trimmed
}
