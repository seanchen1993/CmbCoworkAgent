import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyToolSites(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  requests: Array<{ messages: unknown }>,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "tool-sites-project")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "claw-notes"), "ORIGINAL_TOOL_RESULT")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Tool sites E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/tool-sites"))
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "tool-sites.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "tool-sites")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Tool sites E2E", { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const started = requests.length
  try {
    await composer.fill("[mods-tool-rewrite]")
    await page.locator("form").filter({ has: composer }).locator('button[type="submit"]').click()
    await until(
      async () =>
        (await page.getByText("MODEL_TOOL_HOOK_OK", { exact: true }).count()) > 0 &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "real native tool turn completes"
    )
    await page
      .getByRole("button", { name: /claw-notes/ })
      .first()
      .click()
    const uses = page.locator('[data-function-site="ToolUse"]')
    const results = page.locator('[data-function-site="ToolResult"]')
    await until(
      async () =>
        (await uses.allInnerTexts()).join("\n").includes("DISPLAY_TOOL_INPUT") &&
        (await results.allInnerTexts()).join("\n").includes("DISPLAY_TOOL_RESULT"),
      "tool detail render hooks publish changed presentation"
    )
    const wire = JSON.stringify(requests.slice(started))
    const persisted = JSON.stringify(
      await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
    )
    for (const original of [wire, persisted]) {
      assert(original.includes("ORIGINAL_TOOL_RESULT"))
      assert(!original.includes("DISPLAY_TOOL_"))
    }
    await page.screenshot({ path: join(artifacts, "tool-sites-custom.png") })
    pass(
      "ToolUse and ToolResult change real native read presentation while model results and persisted transcript retain original evidence"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        !(await uses.allInnerTexts()).join("\n").includes("DISPLAY_TOOL_") &&
        !(await results.allInnerTexts()).join("\n").includes("DISPLAY_TOOL_"),
      "off restores native formatted tool details"
    )
    assert((await page.locator("body").innerText()).includes("ORIGINAL_TOOL_RESULT"))
    await page.screenshot({ path: join(artifacts, "tool-sites-off.png") })
    writeFileSync(
      join(artifacts, "tool-sites-evidence.json"),
      JSON.stringify(
        {
          modelRequests: requests.length - started,
          originalWire: true,
          originalHistory: true,
          off: true
        },
        null,
        2
      )
    )
    pass(
      "disabling tool render hooks restores native details and keeps the original tool result visible"
    )
  } finally {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
