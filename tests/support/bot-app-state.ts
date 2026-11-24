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

/** Business cases begin after welcome. Never dismiss a question from the measured user turn. */
export async function settleBotTestIntroduction(page: Page, botId: string): Promise<void> {
  await page.evaluate(id => (window as any).api.bots.open(id), botId)
  await waitForBotAppState(page, async id => {
    const api = (window as any).api.bots
    const pending = (await api.snapshot()).tasks.filter((task: any) =>
      task.botId === id && task.origin.kind === "introduction" && ["queued", "running", "waiting_user"].includes(task.state))
    for (const task of pending) if (task.state === "waiting_user") await api.cancel(task.id)
    return pending.length === 0
  }, botId)
}
