import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { ElectronApplication, Locator, Page } from "playwright"
import type { PluginMetadata } from "../../src/main/types"
import type { CreatorProjectDeliveryStatus } from "../../src/shared/mods/development"

function inside(root: string, target: string) {
  const tail = relative(root, target)
  assert(
    tail &&
      !isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith("..\\") &&
      !tail.startsWith("../"),
    "LIVE_ZIP_OUTSIDE_PRIVATE_PROFILE"
  )
}

/** Real creator export, original ZIP upload UI, and a newly installed package identity. */
export async function reimportLiveProjectZip(input: {
  app: ElectronApplication
  page: Page
  card: Locator
  threadId: string
  workspace: string
  artifacts: string
  delivery: CreatorProjectDeliveryStatus
  plugin: PluginMetadata
  deadline: number
}) {
  const { app, page, delivery, plugin } = input
  const root = realpathSync(input.artifacts)
  inside(root, realpathSync(plugin.path))
  assert.equal(delivery.pluginId, plugin.id)
  const zip = join(root, `project-delivery-${randomUUID()}.zip`)
  assert(!existsSync(zip), "LIVE_ZIP_NEW_OUTPUT_REQUIRED")
  const token = randomUUID()
  await app.evaluate(
    ({ dialog }, selected) => {
      const state = globalThis as typeof globalThis & {
        __liveZipPicker?: { token: string; count: number; original: typeof dialog.showSaveDialog }
      }
      if (state.__liveZipPicker) throw Error("LIVE_ZIP_PICKER_ALREADY_INSTALLED")
      const current = { token: selected.token, count: 0, original: dialog.showSaveDialog }
      state.__liveZipPicker = current
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        dialog.showSaveDialog = current.original
        if (++current.count !== 1 || options?.title !== "保存为新的插件 ZIP")
          throw Error("LIVE_ZIP_UNEXPECTED_SAVE_DIALOG")
        return { canceled: false, filePath: selected.path }
      }) as typeof dialog.showSaveDialog
    },
    { token, path: zip }
  )
  try {
    await input.card.getByRole("button", { name: /^(?:核对并)?导出 ZIP…$/ }).click()
    await page.waitForFunction(
      async ({ id, digest, path }) => {
        const value = (await window.api.mods.development.status({ threadId: id })).projectDelivery
        return value?.phase === "exported" && value.sourceDigest === digest && value.output === path
      },
      { id: input.threadId, digest: delivery.sourceDigest, path: zip },
      {
        timeout: Math.max(1, Math.min(120_000, input.deadline - Date.now()))
      }
    )
  } finally {
    const count = await app.evaluate(({ dialog }, expected) => {
      const state = globalThis as typeof globalThis & {
        __liveZipPicker?: { token: string; count: number; original: typeof dialog.showSaveDialog }
      }
      const current = state.__liveZipPicker
      if (!current || current.token !== expected) throw Error("LIVE_ZIP_PICKER_SCOPE_CHANGED")
      dialog.showSaveDialog = current.original
      delete state.__liveZipPicker
      return current.count
    }, token)
    assert.equal(count, 1, "LIVE_ZIP_NATIVE_SAVE_DIALOG_REQUIRED")
  }
  const hash = createHash("sha256").update(readFileSync(zip)).digest("hex")
  const before = await page.evaluate(() => window.api.plugins.list())
  assert.equal(before.filter((value) => value.id === plugin.id).length, 1)
  const original = await page.evaluate((input) => window.api.plugins.prepareStartUse(input), {
    threadId: input.threadId,
    expectedWorkspace: input.workspace,
    pluginId: plugin.id,
    expected: { name: plugin.name, version: plugin.version, digest: delivery.digest }
  })
  assert.equal(original.kind, "host-project")
  const projects = await page.evaluate(() => window.api.harnessBoard.listProjects())
  assert(
    !projects.some(
      (value) =>
        value.harnessAdapter.id === plugin.id ||
        value.nativeBinding?.installedPluginId === plugin.id
    ),
    "LIVE_ZIP_INSTALLATION_ALREADY_REFERENCED"
  )
  // Only this just-delivered package in the private profile is removed. Native reference guards
  // remain authoritative; a refusal stops the test and never triggers filesystem deletion.
  const removed = await page.evaluate((id) => window.api.plugins.delete(id), plugin.id)
  assert(removed.success, `LIVE_ZIP_NATIVE_DELETE_REFUSED:${removed.error ?? "unknown"}`)
  assert(
    !(await page.evaluate(() => window.api.plugins.list())).some((value) => value.id === plugin.id)
  )
  const creator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (await creator.isVisible())
    await creator.getByRole("button", { name: "Close", exact: true }).click()
  await page.locator('[data-app-guide="customize"]').click()
  await page.getByRole("button", { name: "插件", exact: true }).click()
  const list = page.locator("[data-plugin-source-list]")
  await list.getByRole("heading", { name: "Plugins", exact: true }).waitFor()
  await list
    .getByRole("button")
    .filter({ has: page.locator("svg.lucide-plus") })
    .first()
    .click()
  const upload = page.getByRole("dialog", { name: "安装 Plugin", exact: true })
  await upload.locator("#upload-plugin-input").setInputFiles(zip)
  await page.waitForFunction(
    async ({ old, name, version }) => {
      return (await window.api.plugins.list()).some(
        (value) => value.id !== old && value.name === name && value.version === version
      )
    },
    { old: plugin.id, name: plugin.name, version: plugin.version },
    {
      timeout: Math.max(1, Math.min(60_000, input.deadline - Date.now()))
    }
  )
  const after = await page.evaluate(() => window.api.plugins.list())
  const fresh = after.filter(
    (value) =>
      value.id !== plugin.id &&
      value.name === plugin.name &&
      value.version === plugin.version &&
      !before.some((old) => old.id === value.id)
  )
  assert.equal(fresh.length, 1, "LIVE_ZIP_FRESH_INSTALLATION_NOT_UNIQUE")
  inside(root, realpathSync(fresh[0].path))
  assert.equal(createHash("sha256").update(readFileSync(zip)).digest("hex"), hash)
  const report = await page.evaluate((input) => window.api.plugins.prepareStartUse(input), {
    threadId: input.threadId,
    expectedWorkspace: input.workspace,
    pluginId: fresh[0].id,
    expected: { name: plugin.name, version: plugin.version }
  })
  assert.equal(report.kind, "host-project")
  assert.equal(report.identity.pluginId, fresh[0].id)
  assert.equal(report.identity.digest, original.identity.digest, "LIVE_ZIP_PACKAGE_CONTENT_CHANGED")
  await page.screenshot({ path: join(root, "project-delivery-original-zip-upload.png") })
  // Package identity is computed by the real loader, independently of the authoring digest.
  const back = page.getByRole("button", { name: "返回应用", exact: true })
  await back.click()
  return {
    plugin: fresh[0],
    identity: report.identity,
    evidence: {
      sourceDigest: delivery.sourceDigest,
      zip,
      sha256: hash,
      oldInstallation: plugin.id,
      newInstallation: fresh[0].id,
      packageDigest: report.identity.digest,
      upload: "original-PluginsPanel-file-input",
      copiedGrants: false
    }
  }
}
