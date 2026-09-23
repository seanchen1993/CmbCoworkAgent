import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"

/** Production IPC, React, browser sandbox and isolated guest; no synthetic DOM injection. */
export async function verifySvg(
  page: Page,
  root: string,
  workspace: string,
  artifacts: string,
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void
): Promise<void> {
  const project = join(workspace, "svg-project")
  mkdirSync(project, { recursive: true })
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Vector E2E",
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
  zip.addLocalFolder(join(root, "tests/fixtures/mods-v2/svg-pane"))
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "svg-pane.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods?.find((mod) => mod.name === "svg-pane")
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Vector E2E", { exact: true }).first().click()
  const outbound: string[] = []
  const listen = (request: import("playwright").Request): void => {
    if (request.url().includes("mods-svg-invalid.example")) outbound.push(request.url())
  }
  page.on("request", listen)
  const started = performance.now()
  try {
    const job = await page.evaluate(async (id) => {
      const descriptor = (await window.api.mods.commands(id)).find((c) => c.command === "svg-pane")
      if (!descriptor) throw Error("Missing SVG command")
      return window.api.mods.enqueue(id, descriptor, { text: "" })
    }, threadId)
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.jobs(id), threadId)).some(
          (j) => j.id === job.id && j.state === "succeeded"
        ),
      "SVG command finishes"
    )
    const drawing = page.getByRole("img", { name: "Static vector", exact: true })
    const client = page.getByRole("img", { name: "Client vector", exact: true })
    await until(
      async () => (await drawing.count()) > 0 && (await client.count()) > 0,
      "SVG leaves are mounted"
    )
    await until(
      async () =>
        (await drawing.evaluate((node) => (node as HTMLImageElement).naturalWidth === 120)) &&
        (await client.evaluate((node) => (node as HTMLImageElement).naturalWidth === 80)),
      "SVG image decoder renders both guest surfaces"
    )
    const frameElement = page.locator('iframe[title="Interactive vector"]')
    assert.equal(await frameElement.getAttribute("sandbox"), "")
    assert.equal(await frameElement.getAttribute("allow"), null)
    const frame = page.frameLocator('iframe[title="Interactive vector"]')
    const shape = frame.locator("#shape")
    await shape.waitFor()
    assert.equal(await shape.evaluate((el) => getComputedStyle(el).fill), "rgb(0, 128, 0)")
    await shape.hover()
    await until(
      async () => (await shape.evaluate((el) => getComputedStyle(el).fill)) === "rgb(0, 0, 255)",
      "scriptless interactive SVG keeps CSS hover"
    )
    assert.equal(
      await frame.locator("script, image, foreignObject, a, [onclick], [onload]").count(),
      0
    )
    assert.equal(await frame.locator('meta[http-equiv="refresh"]').count(), 0)
    assert.equal(await page.evaluate(() => "__modsSvgEscaped" in window), false)
    assert.deepEqual(outbound, [])
    const firstDrawMs = performance.now() - started
    await page.screenshot({ path: join(artifacts, "svg-isolated.png") })
    pass(
      "real pane and Client render static and scriptless interactive SVG without injecting app DOM or external requests"
    )
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(
      async () =>
        (await page.locator('iframe[title="Interactive vector"]').count()) === 0 &&
        (await drawing.count()) === 0,
      "off unmounts vector frames"
    )
    writeFileSync(
      join(artifacts, "svg-evidence.json"),
      JSON.stringify({ firstDrawMs, outbound, isolated: true, cssHover: true, off: true }, null, 2)
    )
    pass("disabling Mods removes vector resources and leaves the native composer usable")
    await page.locator("textarea.composer-textarea").fill("native composer unaffected")
  } finally {
    page.off("request", listen)
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
