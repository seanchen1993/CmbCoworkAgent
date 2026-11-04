import assert from "node:assert/strict"
import type { Page } from "playwright"

/** Answer one expected request through the same non-modal controls as the user. */
export async function allowModRequest(page: Page, threadId: string, modId: string): Promise<void> {
  await page.waitForFunction(() =>
    window.api.mods.approvalInbox.snapshot().then((snapshot) => snapshot.current !== null)
  )
  const snapshot = await page.evaluate(() => window.api.mods.approvalInbox.snapshot())
  assert(snapshot.current)
  assert.equal(snapshot.current.threadId, threadId)
  assert.equal(snapshot.current.modId, modId)
  assert.equal(snapshot.queued, 0)
  const inbox = page.getByRole("region", { name: "灵件请求", exact: true })
  const toggle = inbox.getByRole("button", { name: /^灵件请求待确认/ })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await inbox.getByRole("button", { name: snapshot.current.allowLabel, exact: true }).click()
  await page.waitForFunction(
    (requestId) =>
      window.api.mods.approvalInbox
        .snapshot()
        .then((next) => next.current?.requestId !== requestId),
    snapshot.current.requestId
  )
}
