import assert from "node:assert/strict"
import { isAbsolute, relative } from "node:path"
import { realpathSync as realpath } from "node:fs"
import type { Page } from "playwright"
import { pollPublicState } from "./poll-public-state"
import {
  readDeliveredMatrixSourceProof,
  verifyDeliveredMatrixSourceProof
} from "./matrix-delivered-source-proof"

/** Public upload of an actual earlier delivery into a new profile, with no authority copied. */
export async function installDeliveredMatrixSource(input: {
  page: Page
  repository: string
  threadId: string
  threadTitle: string
  run: string
  isolationRoot: string
}) {
  const { page } = input
  const proof = await readDeliveredMatrixSourceProof(input.repository, input.run)
  const before = await page.evaluate(() => window.api.plugins.list())
  assert(
    !before.some((row) => row.name === proof.identity.name),
    "DELIVERED_SEED_FRESH_PROFILE_REQUIRED"
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
  await page
    .getByRole("dialog", { name: "安装 Plugin", exact: true })
    .locator("#upload-plugin-input")
    .setInputFiles(proof.zip)
  const installed = await pollPublicState(
    () => page.evaluate(() => window.api.plugins.list()),
    (rows) =>
      rows.some(
        (row) => row.name === proof.identity.name && !before.some((old) => old.id === row.id)
      ),
    { deadline: Date.now() + 60_000, code: "DELIVERED_SEED_UPLOAD_NOT_CONFIRMED" }
  )
  const fresh = installed.filter(
    (row) =>
      row.name === proof.identity.name &&
      row.version === proof.identity.version &&
      !before.some((old) => old.id === row.id)
  )
  assert.equal(fresh.length, 1, "DELIVERED_SEED_INSTALLATION_NOT_UNIQUE")
  const root = realpath(input.isolationRoot)
  const tail = relative(root, realpath(fresh[0].path))
  assert(
    tail &&
      !isAbsolute(tail) &&
      tail !== ".." &&
      !tail.startsWith("../") &&
      !tail.startsWith("..\\"),
    "DELIVERED_SEED_INSTALLATION_OUTSIDE_NEW_PROFILE"
  )
  const workspace = await page.evaluate(
    async (id) => (await window.api.mods.development.status({ threadId: id })).workspace,
    input.threadId
  )
  const identity = await page.evaluate((value) => window.api.plugins.prepareStartUse(value), {
    threadId: input.threadId,
    expectedWorkspace: workspace,
    pluginId: fresh[0].id,
    expected: proof.identity
  })
  assert.equal(identity.kind, "host-project")
  assert.equal(identity.identity.digest, proof.identity.digest)
  assert.equal(identity.identity.pluginId, fresh[0].id)
  await verifyDeliveredMatrixSourceProof(proof)
  await page.getByRole("button", { name: "返回应用", exact: true }).click()
  await page.getByRole("tab", { name: "对话模式", exact: true }).click()
  const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(input.threadId)}]`)
  if (!(await chat.isVisible())) {
    await page.getByText(input.threadTitle, { exact: true }).first().click()
  }
  await chat.waitFor()
  return {
    pluginId: fresh[0].id,
    proof,
    upload: "original-PluginsPanel-file-input" as const,
    grantsCopied: false
  }
}
