import type { Page } from "playwright"

/** This bundled Playwright's waitForFunction treats a Promise as truthy.
 * Await each IPC read outside its sync predicate poller before checking success. */
export async function waitForBotAppState(
  page: Page,
  predicate: (arg: any) => Promise<boolean>,
  arg?: unknown,
  options: { timeout?: number } = {}
): Promise<void> {
  const until = Date.now() + (options.timeout ?? 90000)
  do {
    if (await page.evaluate(predicate, arg)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < until)
  throw new Error("Timed out awaiting the actual Bot App state")
}
