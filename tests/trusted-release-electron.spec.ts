import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { compileTrustedReleaseSource } from "../src/main/mods/devtools/trusted-release-delivery"
import { readTrustedReleasePackage } from "../src/main/mods/devtools/trusted-release-package"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

async function main() {
  const root = resolve(__dirname, "..")
  const candidate = projectCompositionCandidate(root)
  assert.equal(candidate.execution, "built-output")
  assert.equal(candidate.sha256, process.env.TRUSTED_RELEASE_E2E_EXPECTED_SHA256)
  const fixture = projectCompositionEnvironment(root)
  const path = join(fixture.isolated, "release-candidate.zip")
  const app = await createHeadlessProjectCompositionLaunch(root, fixture)()
  const watchdog = setTimeout(() => void app.close(), 180_000)
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(window.api?.mods?.authoringInstall))
    await app.evaluate(({ dialog }, filePath) => {
      const message = dialog.showMessageBox
      const save = dialog.showSaveDialog
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string; detail?: string }
        if (options.title !== "核对发布候选包") return Reflect.apply(message, dialog, args)
        if (!options.detail?.includes("包 SHA-256")) throw Error("Missing native package review")
        dialog.showMessageBox = message
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options.title !== "保存新的发布候选包") return Reflect.apply(save, dialog, args)
        dialog.showSaveDialog = save
        return { canceled: false, filePath }
      }) as typeof dialog.showSaveDialog
    }, path)
    const result = await page.evaluate(async workspace => {
      const api = window.api
      if (await api.mods.trustedRelease.available()) throw Error("Unexpected online authority")
      const thread = await api.threads.create({
        title: "可信发布候选验证", workspacePath: workspace, agentMode: "normal"
      })
      await api.workspace.set(thread.thread_id, workspace)
      const status = await api.mods.status(thread.thread_id)
      const scope = { threadId: thread.thread_id, expectedWorkspace: status.workspace }
      const id = "release-example", name = "发布候选验证"
      const source = await api.mods.authoring.generate({ ...scope, id, name, kind: "command", instruction: "Summarize" })
      const saved = await api.mods.authoring.save({ ...scope, id, name, expectedRevision: 0, files: source.files })
      const prepared = await api.mods.authoringInstall.prepare({
        ...scope, draftId: id, revision: saved.currentRevision, requestId: crypto.randomUUID(),
        sourceDigest: saved.source.digest
      })
      if (!prepared.ok) throw Error(prepared.code)
      const applied = await api.mods.authoringInstall.apply({
        ...scope, handle: prepared.value.handle, expectedCatalogDigest: prepared.value.catalogDigest
      })
      if (!applied.ok || applied.value.state !== "settled") throw Error("Installation not settled")
      const receipt = await api.mods.authoringInstall.exportReleaseCandidate!({
        ...scope, installationId: applied.value.installationId, versionId: applied.value.versionId
      })
      if (!receipt.ok || !receipt.value) throw Error(receipt.ok ? "Export cancelled" : receipt.code)
      return { packageSha256: receipt.value.packageSha256, sourceDigest: saved.source.digest }
    }, fixture.workspace)
    const archive = new AdmZip(readFileSync(path))
    const manifest = JSON.parse(archive.readAsText("release.json"))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.package.packageSha256, result.packageSha256)
    const source = readTrustedReleasePackage(archive.readFile("plugin.zip")!, manifest.package)
    assert.equal(source.digest, result.sourceDigest)
    assert.equal((await compileTrustedReleaseSource(source, () => {})).digest, manifest.package.compiledDigest)
    writeFileSync(join(fixture.isolated, "release-acceptance.json"), JSON.stringify({ candidate, ...result }, null, 2))
    console.log("PASS saved version exported through real Electron with a verifiable release package")
  } finally {
    clearTimeout(watchdog)
    await app.close()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
