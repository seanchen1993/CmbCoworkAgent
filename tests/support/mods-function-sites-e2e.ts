import assert from "node:assert/strict"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Exercise installed sites through actual React surfaces and the public production bridge. */
export async function verifyFunctionSites(
  page: Page,
  root: string,
  threadId: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/site-board"))
  const result = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "site-board.zip", "local"),
    [...zip.toBuffer()]
  )
  assert.equal(result.success, true, result.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((entry) => entry.name === "site-board")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Mods E2E", { exact: true }).first().click()
  const above = page.locator('[data-function-site="AbovePrompt"]')
  const composer = page.locator("textarea.composer-textarea")
  await until(
    async () => (await above.innerText()).includes("SITE_ABOVE count:0"),
    "live AbovePrompt"
  )
  await above.getByRole("button", { name: "Site increment", exact: true }).click()
  await until(
    async () => (await above.innerText()).includes("count:1"),
    "AbovePrompt callback redraw"
  )
  await above.getByRole("textbox", { name: "Site note", exact: true }).fill("site evidence")
  await above.getByRole("button", { name: "Save site note", exact: true }).click()
  await until(
    async () => (await above.innerText()).includes("submitted:site evidence"),
    "AbovePrompt submit"
  )
  await until(
    async () =>
      (await composer.getAttribute("placeholder"))?.includes(
        "SITE_HINT draft:false working:false"
      ) === true,
    "real empty composer hint"
  )
  await composer.fill("draft")
  await until(
    async () =>
      (await composer.getAttribute("placeholder"))?.includes("SITE_HINT draft:true") === true,
    "real draft composer hint"
  )
  await page.screenshot({ path: join(artifacts, "function-sites-composer.png") })
  pass(
    "installed AbovePrompt handles real input callbacks and PromptHint follows the actual composer draft"
  )

  await composer.fill("SITE_BLOCK_PROBE")
  await composer.press("Enter")
  const notice = page.locator('[data-function-site="InfoNotice"]')
  await until(
    async () =>
      (await notice.count()) > 0 &&
      (await notice.innerText()).includes("SITE_NOTICE SITE_HOST_BLOCK"),
    "real Hook interruption InfoNotice"
  )
  await page.screenshot({ path: join(artifacts, "function-sites-notice.png") })
  pass("InfoNotice decorates an actual UserPromptSubmit block from the original hook path")

  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(
    async () => !(await above.innerText()).includes("SITE_ABOVE"),
    "off removes site content"
  )
  await until(
    async () => !(await composer.getAttribute("placeholder"))?.includes("SITE_HINT"),
    "off restores composer placeholder"
  )
  await until(
    async () => (await notice.innerText()) === "SITE_HOST_BLOCK",
    "off preserves the actual interruption reason"
  )
  await page.screenshot({ path: join(artifacts, "function-sites-off.png") })
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  await until(
    async () => (await above.innerText()).includes("SITE_ABOVE count:0"),
    "on starts a new site guest"
  )
  await composer.fill("")
  pass(
    "Mods off restores the host hint and interruption text, and re-enable creates a fresh site lifecycle"
  )
}
