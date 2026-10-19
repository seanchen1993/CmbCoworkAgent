import assert from "node:assert/strict"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ClawActionDescriptor } from "../src/shared/mods/claw-actions"
import { createAuthoringSourceBundle } from "../src/main/mods/devtools/authoring-bundle"
import { bindProjectPublicAction } from "../src/main/mods/devtools/project-action-reuse"
import { readProjectSource } from "../src/main/mods/devtools/project-source"
import { inspectProjectSource } from "../src/main/mods/devtools/project-doctor"
import { packProjectPlugin } from "../src/main/mods/devtools/project-tooling"

const provider = "AutobizDevOps_Plugin_Kanban_latest"

async function main() {
  assert(process.argv[2] && process.argv[3], "Usage: <approved-action-catalog.json> <new-directory>")
  const catalogPath = resolve(process.argv[2])
  const stat = await lstat(catalogPath)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, "Bounded catalog file required")
  const value = JSON.parse(await readFile(catalogPath, "utf8"))
  const catalog: ClawActionDescriptor[] = Array.isArray(value) ? value : value.actions
  assert(Array.isArray(catalog) && catalog.length <= 128, "Public action catalog required")
  const selected = [
    ["collect-evidence", "collect"],
    ["generate-report", "generate"]
  ].map(([actionId, action]) => {
    const matches = catalog.filter((item) => item.plugin === provider && item.actionId === actionId)
    assert.equal(matches.length, 1, `Select exactly one approved ${provider}/${actionId}`)
    const item = matches[0]
    assert(item.platform?.id === "autobiz.delivery-report" && item.platform.version === "1.0.0" &&
      item.platform.action === action && item.command === undefined, "Exact platform export required")
    return item
  })
  assert(selected[0].pluginId === selected[1].pluginId && selected[0].digest === selected[1].digest,
    "Both actions must belong to the same approved installation and source version")
  let source = (await readProjectSource(resolve(__dirname, "../examples/autobiz-delivery-project"))).bundle
  source = bindProjectPublicAction({ source, stageId: "delivery", localActionId: "collect-evidence",
    action: selected[0], constants: { contextPath: "incoming/verified-context.json" } })
  source = bindProjectPublicAction({ source, stageId: "delivery", localActionId: "generate-report",
    action: selected[1], constants: { contextPath: "incoming/verified-context.json", receiptPath: "delivery-report.json" },
    inputFrom: { kind: "action", actionId: "collect-evidence", pointer: "" } })
  // Reconstructing is intentional: no mutable source object can change after this digest is chosen.
  source = createAuthoringSourceBundle(source.files)
  const { report } = inspectProjectSource(source, [], selected)
  assert(report.valid, JSON.stringify(report.diagnostics))
  const destination = resolve(process.argv[3])
  await mkdir(destination) // Never overwrite a previous delivery or user workspace.
  const directory = join(destination, "source")
  await mkdir(directory)
  for (const file of source.files) {
    const target = join(directory, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.text, { encoding: "utf8", flag: "wx" })
  }
  const packed = await packProjectPlugin(directory, join(destination, "autobiz-delivery-project.zip"),
    source.digest, () => {}, selected)
  await writeFile(join(destination, "binding-review.json"), JSON.stringify({
    provider, sourceDigest: source.digest, actions: selected, package: packed,
    approval: "Action locks are data; current source, scope and native permissions are rechecked at execution.",
    businessExecuted: false
  }, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ output: packed.output, sourceDigest: source.digest, actions: selected.length,
    contractCases: packed.tests.cases.length, businessExecuted: false }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
