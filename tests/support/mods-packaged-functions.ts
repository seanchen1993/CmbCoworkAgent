import assert from "node:assert/strict"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Uses public preload/UI only; the packaged app must not contain the test bridge. */
export async function verifyPackagedFunctions(
  page: Page,
  root: string,
  threadId: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  for (const name of ["engine-noun-provider", "engine-noun-consumer", "code-pane", "focus-board"]) {
    const zip = new AdmZip()
    zip.addLocalFolder(join(root, "tests/fixtures/mods-v2", name))
    const installed = await page.evaluate(
      ({ bytes, name }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, `${name}.zip`, "local"),
      { bytes: [...zip.toBuffer()], name }
    )
    assert.equal(installed.success, true, installed.error)
    const mod = (
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    ).functionMods!.find((mod) => mod.name === name)
    assert(mod?.digest, `${name} compiles in the installed application`)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
    )
  }
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Mods E2E", { exact: true }).first().click()
  await page.bringToFront()
  const composer = page.locator("textarea.composer-textarea")
  const run = async (name: string, args = "") => {
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), threadId)).find(
      (command) => command.command === name
    )
    assert(descriptor, `packaged command ${name}`)
    const before = new Set(
      (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).map((job) => job.id)
    )
    await page.evaluate(
      ({ id, descriptor, args }) => window.api.mods.enqueue(id, descriptor, { text: args }),
      { id: threadId, descriptor, args }
    )
    let text = ""
    await until(async () => {
      const job = (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
        (job) => !before.has(job.id) && job.command === name
      )
      if (!job || job.state === "queued" || job.state === "running") return false
      assert.equal(job.state, "succeeded", JSON.stringify(job))
      text = job.result?.text ?? ""
      return true
    }, `packaged ${name} terminal result`)
    return { descriptor, text }
  }
  const first = await run("noun-identity", "packaged")
  assert.equal(first.text, `ENGINE_NOUN:packaged!?:${threadId}:1`)
  assert.equal(
    (await run("noun-identity", "packaged")).text,
    `ENGINE_NOUN:packaged!?:${threadId}:2`
  )
  pass("packaged Function Mods compile two isolated guests and compose a live engine noun")

  await run("code-pane")
  const code = page.locator("section").filter({ hasText: "Code E2E" }).last()
  await code.locator(".shiki").waitFor()
  assert.deepEqual(await code.locator('[data-code-kind="remove"] > span').allTextContents(), [
    "1",
    "",
    "-"
  ])
  assert.deepEqual(await code.locator('[data-code-kind="add"] > span').allTextContents(), [
    "",
    "1",
    "+"
  ])
  const colors = await code
    .locator(".shiki .line span")
    .evaluateAll((tokens) => [...new Set(tokens.map((token) => getComputedStyle(token).color))])
  assert(colors.length > 1)
  assert.equal((await code.innerText()).includes("never-read/private.ts"), false)
  await page.screenshot({ path: join(artifacts, "packaged-function-code.png") })
  pass("packaged renderer loads the real syntax worker and displays validated Code diffs")

  await composer.fill("")
  await run("focus-board")
  const firstInput = page.getByRole("textbox", { name: "First focus field" })
  const secondInput = page.getByRole("textbox", { name: "Second focus field" })
  await firstInput.waitFor()
  await until(
    () => firstInput.evaluate((element) => document.activeElement === element),
    "packaged autoFocus"
  )
  await secondInput.fill("packaged focus persists")
  await page.getByText("focus-events:1 entered:packaged focus persists", { exact: true }).waitFor()
  assert(await secondInput.evaluate((element) => document.activeElement === element))
  await page.screenshot({ path: join(artifacts, "packaged-function-focus.png") })
  pass("packaged Pane uses host-validated focus and preserves the active input through redraw")

  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(
    async () => (await page.locator("[data-function-pane]").count()) === 0,
    "packaged Mods off removes panes"
  )
  const jobs = (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).length
  await assert.rejects(
    page.evaluate(
      ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "off" }),
      { id: threadId, descriptor: first.descriptor }
    ),
    /MODS_DISABLED/
  )
  assert.equal((await page.evaluate((id) => window.api.mods.jobs(id), threadId)).length, jobs)
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  assert.equal(
    (await run("noun-identity", "restored")).text,
    `ENGINE_NOUN:restored!?:${threadId}:1`
  )
  pass("packaged global off prevents execution and restore rebuilds independent guest state")
}
