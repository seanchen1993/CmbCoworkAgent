import { openModsResults } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

export async function verifyNamedState(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "named-state")
  mkdirSync(project, { recursive: true })
  const id = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Reactive named state",
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
  for (const folder of ["owner", "reader", "policy"]) {
    const zip = new AdmZip()
    zip.addLocalFolder(join(root, "examples/mods-reactive-state", folder))
    const result = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "named-state.zip", "local"),
      [...zip.toBuffer()]
    )
    assert(result.success, result.error)
  }
  async function approve(name: string) {
    const mod = (await page.evaluate((id) => window.api.mods.status(id), id)).functionMods!.find(
      (row) => row.name === name
    )!
    assert(mod?.digest)
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      { id, pluginId: mod.pluginId, digest: mod.digest! }
    )
  }
  for (const name of ["state-owner", "state-reader", "state-policy"]) await approve(name)
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Reactive named state", { exact: true }).first().click()
  await openModsResults(page)
  async function run(command: string) {
    const descriptor = (await page.evaluate((id) => window.api.mods.commands(id), id)).find(
      (row) => row.command === command
    )!
    assert(descriptor, command)
    const job = await page.evaluate(
      ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
      { id, descriptor }
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), id)).some(
          (row) =>
            row.id === job.id &&
            ["succeeded", "failed", "cancelled", "interrupted"].includes(row.state)
        ),
      command
    )
    const result = (await page.evaluate((id) => window.api.mods.jobs(id), id)).find(
      (row) => row.id === job.id
    )!
    assert.equal(result.state, "succeeded", JSON.stringify(result))
    return result.result!.text
  }
  await run("state-open")
  await run("state-reader-open")
  const owner = page.locator('[data-function-pane="state-owner"]')
  const reader = page.locator('[data-function-pane="state-reader"]')
  await owner.getByText("OWNER_COUNT_0", { exact: true }).waitFor()
  await reader.getByText("READER_SCORE_0", { exact: true }).waitFor()
  const latencies: number[] = []
  let value = 0
  for (let press = 0; press < 3; press++) {
    const started = performance.now()
    await owner.getByRole("button", { name: "Increment shared count", exact: true }).click()
    value = (value + 1) * 2
    await owner.getByText(`OWNER_COUNT_${value}`, { exact: true }).waitFor()
    await reader.getByText(`READER_SCORE_${value * 10}`, { exact: true }).waitFor()
    latencies.push(performance.now() - started)
  }
  assert.deepEqual(JSON.parse(await run("state-inspect")), { value: 14, version: 3 })
  pass(
    "three approved plugins share versioned state: owner writes, policy rewrites, reader redraws"
  )
  const denied = await run("state-denied")
  assert.match(denied, /MODS_STATE/)
  assert.deepEqual(JSON.parse(await run("state-inspect")), { value: 14, version: 3 })
  pass("another plugin can read but cannot directly write the owner's state")
  // Re-approval invalidates/reloads the real runtime while retaining the host session state.
  await approve("state-owner")
  await run("state-open")
  await run("state-reader-open")
  await owner.getByText("OWNER_COUNT_14", { exact: true }).waitFor()
  await reader.getByText("READER_SCORE_140", { exact: true }).waitFor()
  pass("actual runtime replacement keeps session values and installs fresh drawing subscriptions")
  await page.evaluate((id) => window.api.mods.revokeFunction(id, "state-policy"), id)
  assert.equal(await run("state-increment"), "15")
  await run("state-open")
  await run("state-reader-open")
  await reader.getByText("READER_SCORE_150", { exact: true }).waitFor()
  pass("revoking the rewriting plugin immediately changes the actual state transition")
  await page.screenshot({ path: join(artifacts, "named-state.png") })
  writeFileSync(
    join(artifacts, "named-state-evidence.json"),
    JSON.stringify(
      {
        value: JSON.parse(await run("state-inspect")),
        denied,
        clickToBothDrawingsMs: latencies
      },
      null,
      2
    )
  )
  await page.evaluate(() => window.api.mods.configureGlobal(false))
  await until(
    async () => (await owner.count()) === 0 && (await reader.count()) === 0,
    "off releases reactive views"
  )
  const composer = page.locator("textarea.composer-textarea")
  await composer.fill("Ordinary chat still works with reactive Mods disabled")
  assert.equal(await composer.inputValue(), "Ordinary chat still works with reactive Mods disabled")
  assert.deepEqual(await page.evaluate((id) => window.api.mods.commands(id), id), [])
  await page.evaluate(() => window.api.mods.configureGlobal(true))
  pass("Mods off removes reactive views and commands while preserving the ordinary composer")
}
