import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, expect, it } from "vitest"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { readProjectSource } from "../../mods/devtools/project-source"
import { bindProjectPublicAction } from "../../mods/devtools/project-action-reuse"
import { inspectProjectSource } from "../../mods/devtools/project-doctor"
import { testProjectSource } from "../../mods/devtools/project-contract"
import { packProjectPlugin } from "../../mods/devtools/project-tooling"
import { PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import { assertHostPackageSupported } from "./package-preflight"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// Contract fixtures only: real installation identities are selected from the host at packaging.
const actions: ClawActionDescriptor[] = ["collect", "generate"].map((action) => ({
  pluginId: "isolated-provider-installation",
  plugin: "AutobizDevOps_Plugin_Kanban_latest",
  digest: "a".repeat(64),
  actionId: action === "collect" ? "collect-evidence" : "generate-report",
  name: action,
  platform: { id: "autobiz.delivery-report", version: "1.0.0", action },
  inputSchema: { type: "object", required: ["contextPath"], properties: {
    contextPath: { type: "string" }, receiptPath: { type: "string" }
  } },
  outputSchema: { type: "object" }
}))

async function boundSource() {
  let source = (await readProjectSource(resolve("examples/autobiz-delivery-project"))).bundle
  source = bindProjectPublicAction({ source, stageId: "delivery", localActionId: "collect-evidence",
    action: actions[0], constants: { contextPath: "incoming/verified-context.json" } })
  return bindProjectPublicAction({ source, stageId: "delivery", localActionId: "generate-report",
    action: actions[1], constants: { receiptPath: "delivery-report.json" },
    inputFrom: { kind: "action", actionId: "collect-evidence", pointer: "" } })
}

it("packs the external platform dependency without mixing guest source into the pinned host package", async () => {
  const source = await boundSource()
  const { report, manifest } = inspectProjectSource(source, [], actions)
  expect(report.diagnostics).toEqual([])
  expect(report.valid).toBe(true)
  expect(manifest!.stages[0].actionIds).toEqual(["collect-evidence", "generate-report"])
  expect(manifest!.stages[1].approval).toBe("human")
  const contract = await testProjectSource(source, manifest!)
  expect(contract.valid).toBe(true)
  expect(contract.cases.find((item) => item.id === "skill-cannot-substitute-report")?.actual).toBe("failed")
  expect(contract.cases.find((item) => item.id === "reject-false-quality-pass")?.actual).toBe("failed")
  const root = await mkdtemp(join(tmpdir(), "autobiz-delivery-pack-"))
  roots.push(root)
  const directory = join(root, "source")
  await mkdir(directory)
  for (const file of source.files) {
    const target = join(directory, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.text)
  }
  expect(() => assertHostPackageSupported(directory, manifest!)).not.toThrow()
  const packed = await packProjectPlugin(directory, join(root, "delivery.zip"), source.digest,
    () => {}, actions)
  const zip = new AdmZip(await readFile(packed.output))
  const lock = JSON.parse(zip.readAsText(PROJECT_ACTION_LOCK_PATH))
  expect(lock.bindings[0].platform).toEqual(actions[0].platform)
  expect(lock.bindings[1].inputFrom).toEqual({ kind: "action", actionId: "collect-evidence", pointer: "" })
  expect(lock.bindings.every((binding: Record<string, unknown>) => !Object.hasOwn(binding, "command"))).toBe(true)
  expect(zip.getEntries().some((entry) => entry.entryName === "mods/manifest.json" || entry.entryName.startsWith("hooks/")))
    .toBe(false)
})

it("refuses stale provider versions and never treats a dependency lock as approval", async () => {
  const source = await boundSource()
  expect(inspectProjectSource(source).report.valid).toBe(false)
  const changed = actions.map((action) => ({ ...action, digest: "b".repeat(64) }))
  const { report } = inspectProjectSource(source, [], changed)
  expect(report.valid).toBe(false)
  expect(report.diagnostics.some((item) => item.code === "PROJECT_ACTION_LOCK_INVALID")).toBe(true)
})
