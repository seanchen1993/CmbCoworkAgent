import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import type { ModCommandJob } from "../../src/shared/mods/types"

/** Actual React composer/runtime/model transport; no production test bridge or synthetic UI state. */
export async function verifyStatusSites(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<string> {
  const previous = await page.evaluate(() => window.api.mods.globalEnabled())
  assert.equal(previous, true, "Enable Mods before running the status site probe")
  const project = join(workspace, "status-sites-project")
  mkdirSync(project, { recursive: true })
  const title = "Status sites E2E"
  const threadId = await page.evaluate(
    async ({ project, title }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: project,
        agentMode: "normal"
      })
      const id =
        (thread as unknown as { thread_id?: string; id?: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, project)
      await window.api.threads.patchMetadata(id, {
        set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
      })
      await window.api.mods.configure(id, true, true)
      return id
    },
    { project, title }
  )
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/status-sites"))
  const installed = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "status-sites.zip", "local"),
    [...zip.toBuffer()]
  )
  assert.equal(installed.success, true, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((entry) => entry.name === "status-sites")
  assert(mod?.digest, "Installed status fixture must have a captured production digest")
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText(title, { exact: true }).first().click()
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const spinner = page.locator('[data-function-site="Spinner"]')
  const durations = page.locator('[data-function-site="TurnDuration"]')
  const mode = page.locator('[data-function-site="SessionMode"]')
  const modeButton = page.getByRole("button", { name: /^执行模式：Solo。/ })

  async function cancel(): Promise<void> {
    await page.getByRole("button", { name: "停止生成", exact: true }).click()
    await until(async () => (await spinner.count()) === 0, "status turn is stopped")
  }
  async function style(custom: boolean): Promise<void> {
    const job = await page.evaluate(
      async ({ id, custom }) => {
        const command = (await window.api.mods.commands(id)).find(
          (entry) => entry.command === "status-sites-style"
        )
        if (!command || command.apiVersion !== "cmb.mods/v2" || !command.immediate)
          throw Error("Status probe requires its real immediate command")
        return window.api.mods.enqueue(id, command, { text: custom ? "custom" : "native" })
      },
      { id: threadId, custom }
    )
    let done: ModCommandJob | undefined
    await until(async () => {
      done = (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
        (entry) => entry.id === job.id
      )
      return !!done && !["queued", "running"].includes(done.state)
    }, "status fixture preference is persisted")
    assert.equal(done?.state, "succeeded", done?.error)
    assert.equal(JSON.parse(done.result!.text!).custom, custom)
  }
  try {
    for (let index = 0; index < 2; index++) {
      await composer.fill(`Status native duration ${index}`)
      await submit.click()
      await until(
        async () => (await spinner.count()) === 0 && (await durations.count()) >= index + 1,
        `real completed turn ${index} has a native duration`
      )
    }
    assert.equal(await modeButton.count(), 1)
    assert.equal(await modeButton.locator("span.font-medium").isVisible(), true)
    assert.equal(await mode.innerText(), "")
    await composer.fill("Status native spinner [stall]")
    await submit.click()
    await until(
      async () => (await spinner.locator(".thinking-shimmer-text").count()) === 1,
      "native loading shimmer survives an installed pass-through module"
    )
    await page.screenshot({ path: join(artifacts, "status-sites-native.png") })
    await cancel()
    pass(
      "installed pass-through status sites preserve the native spinner, multiple duration rows and mode button"
    )

    await style(true)
    await until(
      async () => (await mode.innerText()).includes("STATUS_MODE"),
      "custom mode label is drawn beside the original control"
    )
    assert.equal(await modeButton.count(), 1)
    assert.equal(
      await modeButton
        .locator("span.font-medium")
        .evaluate((element) => element.classList.contains("sr-only")),
      true
    )
    await until(
      async () =>
        (await durations.allInnerTexts()).filter((text) => text.includes("STATUS_DURATION"))
          .length >= 2,
      "multiple visible message duration owners coexist"
    )
    await composer.fill("Status custom spinner [stall]")
    await submit.click()
    await until(
      async () =>
        (await spinner.count()) === 1 && (await spinner.innerText()).includes("STATUS_SPINNER ~"),
      "actual streaming turn is decorated by Spinner"
    )
    assert.equal((await page.locator(".rainbow-spinner").count()) > 0, true)
    assert.equal(await modeButton.count(), 1)
    await page.screenshot({ path: join(artifacts, "status-sites-custom.png") })
    await cancel()
    pass(
      "real Spinner/TurnDuration/SessionMode hooks customize only their presentation and retain host controls"
    )

    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        (await mode.innerText()) === "" &&
        !(await modeButton
          .locator("span.font-medium")
          .evaluate((element) => element.classList.contains("sr-only"))),
      "off restores the original mode label"
    )
    await until(
      async () =>
        (await durations.allInnerTexts()).every((text) => !text.includes("STATUS_DURATION")),
      "off restores all visible native durations"
    )
    await composer.fill("Status off spinner [stall]")
    await submit.click()
    await until(
      async () => (await spinner.locator(".thinking-shimmer-text").count()) === 1,
      "off restores the original live spinner"
    )
    await page.screenshot({ path: join(artifacts, "status-sites-off.png") })
    await cancel()
    writeFileSync(
      join(artifacts, "status-sites-evidence.json"),
      JSON.stringify(
        {
          threadId,
          project,
          scope: "actual renderer/composer/main runtime/local HTTP model",
          sites: ["Spinner", "TurnDuration", "SessionMode"],
          native: true,
          custom: true,
          off: true,
          visibleDurationRows: await durations.count(),
          modeControlPreserved: true,
          viewportRows: "unsupported; no fabricated onScreen"
        },
        null,
        2
      )
    )
    pass("Mods off restores the original loading text, duration labels and execution-mode control")
  } finally {
    await page.evaluate((id) => window.api.agent.cancel(id), threadId).catch(() => {})
    await page.evaluate((enabled) => window.api.mods.configureGlobal(enabled), previous)
  }
  return threadId
}
