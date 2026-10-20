import { openModsSettings } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Real install, isolated registration VM, production IPC and the visible settings control. */
export async function verifyCompatibility(
  page: Page,
  workspace: string,
  artifacts: string,
  pass: (label: string) => void
) {
  const id = await page.evaluate(async (workspace) => {
    const thread = await window.api.threads.create({
      title: "Compatibility inspection",
      workspacePath: workspace,
      agentMode: "normal"
    })
    const id = (thread as unknown as { thread_id: string }).thread_id
    await window.api.workspace.set(id, workspace)
    return id
  }, workspace)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "compatibility-check", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("classic.FileChanged", () => { throw Error("MUST_NOT_INVOKE") });
    on("env.set", () => { throw Error("MUST_NOT_INVOKE") });
    on("command.run", () => { throw Error("MUST_NOT_INVOKE") });
  }`)
  )
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "compatibility-check.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success)
  const before = await page.evaluate((id) => window.api.mods.status(id), id)
  const mod = before.functionMods!.find((row) => row.name === "compatibility-check")!
  assert.equal(mod.state, "needs-approval")
  assert(mod.digest)
  const report = await page.evaluate(
    ({ id, mod }) => window.api.mods.checkFunctionCompatibility(id, mod.pluginId, mod.digest!),
    { id, mod }
  )
  assert.equal(report.compatibility.status, "unsupported")
  assert(report.compatibility.diagnostics.some((row) => row.code === "MODS_EVENT_SCHEMA_ONLY"))
  assert(report.compatibility.diagnostics.some((row) => row.pattern === "env.set"))
  await assert.rejects(
    page.evaluate(
      ({ id, mod }) => window.api.mods.checkFunctionCompatibility(id, mod.pluginId, "0".repeat(64)),
      { id, mod }
    ),
    /MODS_APPROVAL_STALE/
  )
  pass(
    "production compatibility IPC reports missing providers without invoking handlers or granting approval"
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Compatibility inspection", { exact: true }).first().click()
  await openModsSettings(page)
  assert.equal(await page.locator("[data-mods-locked]").count(), 0)
  const row = page
    .locator("[data-mods-settings]")
    .locator('[data-function-mod-id="compatibility-check"]')
  await row.waitFor({ state: "attached" })
  await row.evaluate((node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true
  })
  const check = row.locator("[data-function-compatibility]")
  assert.equal(await check.getByRole("status").count(), 0)
  await check.getByRole("button", { name: "检查社区兼容性", exact: true }).click()
  await check.getByText("有规则暂时无法生效", { exact: true }).waitFor()
  await check.getByText("仅有事件结构定义，尚未接入实际业务触发点。", { exact: false }).waitFor()
  await row.getByText("等待授权", { exact: true }).waitFor()
  const after = await page.evaluate((id) => window.api.mods.status(id), id)
  assert.equal(after.enabled, before.enabled)
  assert.equal(after.functionMods!.find((row) => row.name === mod.name)!.state, "needs-approval")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.jobs(id), id), [])
  await page.screenshot({ path: join(artifacts, "compatibility-check.png") })
  writeFileSync(join(artifacts, "compatibility-report.json"), JSON.stringify(report, null, 2))
  pass(
    "visible compatibility check explains nonfiring events and preserves project switch and approval state"
  )
}
