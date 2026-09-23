import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyUiFeedback(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "ui-feedback-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "UI feedback E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/ui-feedback"))
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "ui-feedback.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "ui-feedback")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("UI feedback E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const run = async (command: string) => {
    await composer.fill(`/${command} now`)
    await submit.click()
  }
  const rail = page.locator("[data-function-feedback]")
  try {
    await run("feedback-show")
    await page.getByText("FEEDBACK_TEMPORARY", { exact: false }).first().waitFor()
    await until(async () => (await rail.innerText()).includes("FEEDBACK_PINNED"), "status visible")
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    assert(!JSON.stringify(messages).includes("FEEDBACK_PINNED"))
    assert(!JSON.stringify(messages).includes("FEEDBACK_TEMPORARY"))
    await page.screenshot({ path: join(artifacts, "ui-feedback-visible.png") })
    await until(
      async () => (await rail.locator('[data-feedback-kind="toast"]').count()) === 0,
      "toast expires without user action"
    )
    assert((await rail.innerText()).includes("FEEDBACK_PINNED"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("UI feedback E2E", { exact: true }).first().click()
    await until(
      async () => (await rail.innerText()).includes("FEEDBACK_PINNED"),
      "reload keeps live session status"
    )
    await run("feedback-clear")
    await until(async () => (await rail.count()) === 0, "undefined clears status")
    pass("real guest toast expires and per-plugin status clears; neither changes stored messages")
    await run("feedback-show")
    await until(async () => (await rail.count()) === 1, "new feedback visible")
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(async () => (await rail.count()) === 0, "global off removes feedback")
    assert.deepEqual(await page.evaluate((id) => window.api.mods.feedback(id), threadId), [])
    await page.screenshot({ path: join(artifacts, "ui-feedback-off.png") })
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await page.evaluate((id) => window.api.mods.commands(id), threadId)
    assert.deepEqual(await page.evaluate((id) => window.api.mods.feedback(id), threadId), [])
    await run("feedback-show")
    await until(async () => (await rail.count()) === 1, "restored command feedback")
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "ui-feedback"), threadId)
    await until(async () => (await rail.count()) === 0, "revocation removes feedback")
    writeFileSync(
      join(artifacts, "ui-feedback-evidence.json"),
      JSON.stringify(
        {
          realSession: true,
          messagesUntouched: true,
          expiry: true,
          reload: true,
          clear: true,
          off: true,
          noStaleRestoration: true,
          revoke: true
        },
        null,
        2
      )
    )
    pass("off and revocation remove feedback; new runtime never restores stale status")
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
