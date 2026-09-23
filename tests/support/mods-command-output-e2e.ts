import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyCommandOutput(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "output-sites-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Output sites E2E",
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
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/output-sites"))
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "output-sites.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "output-sites")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Output sites E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  try {
    await composer.fill("/output-echo private-argument")
    await submit.click()
    const rows = page.locator('[data-function-site="CommandOutput"]')
    await until(
      async () => (await rows.allInnerTexts()).includes("DISPLAY_OUTPUT ***"),
      "command output hook redraws actual command result"
    )
    const jobs = await page.evaluate((id) => window.api.mods.jobs(id), threadId)
    assert.equal(jobs[0].state, "succeeded")
    assert.equal(jobs[0].result?.text, "ORIGINAL_OUTPUT")
    assert(!JSON.stringify(jobs).includes("private-argument"))
    assert(!(await rows.allInnerTexts()).join("\n").includes("private-argument"))
    await page.screenshot({ path: join(artifacts, "command-output-custom.png") })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Output sites E2E", { exact: true }).first().click()
    await until(
      async () => (await rows.allInnerTexts()).includes("DISPLAY_OUTPUT ***"),
      "durable command result redraws after reload"
    )
    pass(
      "CommandOutput customizes actual slash command display while durable result and execution state remain unchanged"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () => (await rows.allInnerTexts()).includes("ORIGINAL_OUTPUT"),
      "off restores original command result"
    )
    await page.screenshot({ path: join(artifacts, "command-output-off.png") })
    writeFileSync(
      join(artifacts, "command-output-evidence.json"),
      JSON.stringify(
        { originalResult: true, privateArgsAbsent: true, reload: true, off: true },
        null,
        2
      )
    )
    pass(
      "command display survives reload, masks absent argument metadata and restores native output when off"
    )
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
