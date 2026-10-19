import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { resolveFunctionUserConfig } from "../../shared/mods/v2/user-config"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { testProjectPlugin } from "../mods/devtools/project-tooling"
import { BusinessModAssemblyService } from "./business-mod-assembly-service"
import { readNativeCapabilityCatalog } from "./capability-catalog"
import { snapshotDerivationSource } from "./derivation-source"
import { portableBusinessModFiles } from "./business-mod-portable-source"
import { readBusinessModSelectionPolicy } from "./business-mod-selection"
import { assertPackageExtensionCompatibility } from "./extension-contract"
import {
  wrapProjectRuntimeManifest,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../../shared/project-runtime"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})
const guard = () => {}
const ordinaryBoardPath = "board_core/board_config.json"
const ordinaryBoardBytes = readFileSync(
  resolve("examples/vendor-onboarding-mods", ordinaryBoardPath)
)
const ordinaryBoardDigest = createHash("sha256").update(ordinaryBoardBytes).digest("hex")
async function phase<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    console.info(
      "independent-business-phase " +
        JSON.stringify({
          phase: label,
          elapsedMs: Number((performance.now() - started).toFixed(2))
        })
    )
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "business-independent-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const installed: Array<{ id: string; name: string; path: string }> = []
  const service = new BusinessModAssemblyService(join(directory, "assembly"), {
    plugins: () => installed as never,
    validatePackage: async (root) => {
      assertPackageExtensionCompatibility(root)
      const manifest = parseProjectRuntimeManifest(
        JSON.parse(await readFile(join(root, "devclaw.project-runtime.json"), "utf8"))
      )
      assertHostPackageSupported(root, manifest)
      expect((await phase("native-author-contract", () => testProjectPlugin(root))).valid).toBe(
        true
      )
    },
    install: async (source, name, id, assertCurrent, verify) => {
      const path = join(directory, "installed", id)
      await cp(source, path, { recursive: true })
      await verify(path)
      assertCurrent()
      installed.push({ id, name, path })
      return { success: true }
    },
    invalidate: () => {}
  })
  const source = await phase("inspect-base", () =>
    service.inspect(resolve("examples/vendor-onboarding-mods"), "owner", guard)
  )
  expect(source.kernel).toMatchObject({ id: "vendor.onboarding", runtimeAdapter: "host-linear-v1" })
  const custom = await phase("inspect-custom", () =>
    service.inspect(resolve("examples/vendor-qualification-mod"), "owner", guard)
  )
  async function assemble(customIncluded: boolean) {
    const name = customIncluded ? "vendor-onboarding-enhanced" : "vendor-onboarding-basic"
    const preview = await phase("preview-" + name, () =>
      service.preview(
        "owner",
        {
          name,
          version: "1.0.0",
          sources: [
            { inspectionId: source.id, modIds: ["vendor.decision"] },
            ...(customIncluded
              ? [{ inspectionId: custom.id, modIds: ["vendor.qualification"] }]
              : [])
          ],
          order: [
            "vendor.dossier",
            ...(customIncluded ? ["vendor.qualification"] : []),
            "vendor.decision"
          ]
        },
        guard
      )
    )
    expect(preview.valid).toBe(true)
    expect(preview.runtime).toEqual({ adapter: "host-linear-v1", mode: "host", stateOwner: "host" })
    expect(preview.extensions).toEqual([
      expect.objectContaining({ id: "vendor.settings", added: true })
    ])
    const copy = await phase("create-" + name, () =>
      service.create("owner", preview.previewId, randomUUID(), guard)
    )
    await phase("check-" + name, () => service.check("owner", copy.copyId, copy.digest, guard))
    const installedCopy = await phase("install-" + name, () =>
      service.install("owner", copy.copyId, copy.digest, guard)
    )
    const path = installed.find((item) => item.id === installedCopy.pluginId)!.path
    return { preview, copy: installedCopy, path, name }
  }
  return { directory, service, assemble, source }
}

describe("independent supplier business through the public assembly and Host services", () => {
  it("exports and reimports a Host catalog preserving a same-named ordinary board resource", async () => {
    const { directory, service, source } = await fixture()
    const sourceSnapshot = await snapshotDerivationSource(
      resolve("examples/vendor-onboarding-mods")
    )
    const portableSource = portableBusinessModFiles(sourceSnapshot)
    const sourceArchive = new AdmZip()
    for (const file of portableSource) sourceArchive.addFile(file.path, file.bytes)
    expect(
      sourceArchive.getEntries().some((entry) => entry.entryName === "mods/business/manifest.json")
    ).toBe(true)
    expect(
      sourceArchive
        .getEntries()
        .some((entry) => entry.entryName === "knowledge/admission-policy.md")
    ).toBe(true)
    expect(sourceArchive.readFile(ordinaryBoardPath)).toEqual(ordinaryBoardBytes)
    expect(
      JSON.parse(sourceArchive.readAsText("mods/business/manifest.json")).kernel
    ).not.toHaveProperty("boardConfigPath")
    const sourceZip = join(directory, "portable-source.zip")
    sourceArchive.writeZip(sourceZip)
    const importedSource = join(directory, "imported-source")
    new AdmZip(sourceZip).extractAllTo(importedSource)
    expect(() => assertPackageExtensionCompatibility(importedSource)).not.toThrow()
    expect(readFileSync(join(importedSource, ordinaryBoardPath))).toEqual(ordinaryBoardBytes)
    const importedInspection = await service.inspect(importedSource, "owner", guard)
    expect(importedInspection.kernel?.runtimeAdapter).toBe("host-linear-v1")
    expect(importedInspection.mods.map((mod) => mod.id)).toEqual(source.mods.map((mod) => mod.id))
  })

  it.each([false, true])(
    "checks, installs, discovers and exports a supplier variant (custom=%s)",
    async (customIncluded) => {
      const setup = await fixture()
      const variant = await setup.assemble(customIncluded)
      expect(variant.preview.steps.map((step) => step.id)).toEqual([
        "vendor.dossier",
        ...(customIncluded ? ["vendor.qualification"] : []),
        "vendor.decision"
      ])
      const names = variant.preview.files.map((file) => file.path)
      expect(names).toContain(ordinaryBoardPath)
      expect(variant.preview.files.find((file) => file.path === ordinaryBoardPath)?.digest).toBe(
        ordinaryBoardDigest
      )
      expect(readFileSync(join(variant.path, ordinaryBoardPath))).toEqual(ordinaryBoardBytes)
      expect(names).not.toContain("devclaw.stage-checks.json")
      expect(names.some((name) => name.includes("autobiz"))).toBe(false)
      expect(readFileSync(join(variant.path, "knowledge/admission-policy.md"), "utf8")).toContain(
        "VENDOR_POLICY_2026_01"
      )
      const compiled = await phase("native-compile", () => compileFunctionPlugin(variant.path))
      expect(compiled).toBeDefined()
      const catalog = await phase("capability-catalog", () =>
        readNativeCapabilityCatalog(
          {
            id: variant.copy.pluginId!,
            name: variant.name,
            version: "1.0.0",
            path: variant.path,
            enabled: true
          },
          "project"
        )
      )
      expect(catalog.status).toBe("declared")
      expect(catalog.legacyAdapter).toBeUndefined()
      expect(catalog.capabilities).toEqual([
        expect.objectContaining({
          id: "project-flow",
          kind: "flow",
          runtimeMode: "host",
          applicable: true,
          available: false
        })
      ])
      const snapshot = await snapshotDerivationSource(variant.path)
      expect(readBusinessModSelectionPolicy(snapshot)).toBeUndefined()
      const changed = (mutation: "legacy" | "stage-id" | "stage-skill") => ({
        files: snapshot.files.map((file) => {
          if (file.path !== "devclaw.project-runtime.json") return file
          const envelope = JSON.parse(file.bytes.toString("utf8"))
          const runtime = envelope.runtime ?? envelope
          if (mutation === "legacy") {
            runtime.mode = "legacy"
            runtime.stateOwner = "plugin"
          } else if (mutation === "stage-id") runtime.stages[0].id = "changed-stage"
          else runtime.stages[0].skill = "skills/not-the-selected-skill/SKILL.md"
          return { ...file, bytes: Buffer.from(JSON.stringify(envelope)) }
        })
      })
      expect(() => readBusinessModSelectionPolicy(changed("legacy"))).toThrow("OWNER_MISMATCH")
      for (const mutation of ["stage-id", "stage-skill"] as const)
        expect(() => readBusinessModSelectionPolicy(changed(mutation))).toThrow(
          "BUSINESS_MOD_HOST_RUNTIME_CONFLICT"
        )

      const schema = compiled.userConfig!
      expect(resolveFunctionUserConfig(schema, { policyTier: "enhanced" }).policyTier).toBe(
        "enhanced"
      )
      const archive = join(setup.directory, "vendor-enhanced.zip")
      await setup.service.export("owner", variant.copy.copyId, variant.copy.digest, archive, guard)
      const zip = new AdmZip(archive)
      expect(zip.readFile(ordinaryBoardPath)).toEqual(ordinaryBoardBytes)
      expect(zip.readAsText("devclaw.project-runtime.json")).toContain('"mode": "host"')
      expect(
        zip.readAsText("devclaw.business-assembly.json").includes("vendor.qualification")
      ).toBe(customIncluded)
      expect(
        zip.getEntries().some((entry) => /(?:state\.json|\.sqlite|\.env)$/.test(entry.entryName))
      ).toBe(false)
    }
  )

  it.each([true, false])(
    "keeps legacy agent resource checks (runtime declared=%s)",
    async (declared) => {
      const directory = await mkdtemp(join(tmpdir(), "business-legacy-agent-"))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      await mkdir(join(directory, "board_core"))
      await writeFile(
        join(directory, ordinaryBoardPath),
        JSON.stringify({
          apiVersion: declared ? 2 : 1,
          workflow: {
            nodes: [
              {
                id: "legacy.node",
                runtimePolicy: {
                  subagentConfig: {
                    customSubagentFiles: ["agents/missing.md"]
                  }
                }
              }
            ]
          }
        })
      )
      if (declared)
        await writeFile(
          join(directory, "devclaw.project-runtime.json"),
          JSON.stringify(
            wrapProjectRuntimeManifest(
              {
                apiVersion: "devclaw.project-runtime/v1",
                plugin: { id: "legacy-resource-negative", version: "1.0.0" },
                mode: "legacy",
                stateOwner: "plugin",
                stages: [],
                actions: [],
                artifacts: [],
                checks: [],
                environment: [],
                capabilities: {
                  execution: true,
                  conditionalTransition: false,
                  idempotency: false,
                  reconciliation: false,
                  cancellation: true
                }
              },
              {
                apiVersion: "devclaw.extension-contract/v1",
                requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
              }
            )
          )
        )
      expect(() => assertPackageExtensionCompatibility(directory)).toThrow(
        "PROJECT_AGENT_RESOURCE_MISSING: agents/missing.md"
      )
    }
  )

  // This integration journey includes checked assembly/installation, SQLite transactions,
  // retained package snapshots, input revalidation and four original Host operations. Its
  // explicit 15-second fixture budget is not a performance benchmark; production deadlines,
  // existing regression limits and the other cases' default five-second budget stay unchanged.
  it("executes inserted business artifacts and rejects bad schema and stale receipts in the original Host", async () => {
    const setup = await fixture()
    const custom = await setup.assemble(true)
    const workspace = join(setup.directory, "workspace")
    await mkdir(workspace)
    const store = new HostProjectStore(join(setup.directory, "host.sqlite"))
    cleanup.push(async () => store.close())
    let invalidQualification = true
    const consumed: string[] = []
    const host = new HostProjectService(
      store,
      new HostPackageSnapshots(join(setup.directory, "snapshots")),
      {
        resolveInstalledPlugin: async () => ({
          installedPluginId: custom.copy.pluginId!,
          root: custom.path,
          packageId: custom.name,
          packageVersion: "1.0.0",
          enabled: true
        }),
        authorize: async () => {},
        // This service-level test deliberately uses a controlled Skill callback. The separate
        // packaged journey verifies real SDK, public tools, native grants and Skill Hooks.
        executeSkill: async (context) => {
          expect(context.snapshotRoot).not.toBe(custom.path)
          expect(readFileSync(join(context.snapshotRoot, context.skillPath), "utf8")).toContain(
            "VENDOR_"
          )
          if (context.operation.stageId === "vendor.dossier") {
            writeFileSync(
              join(workspace, "dossier.json"),
              JSON.stringify({
                vendorName: "本地资料供应商",
                registrationId: "fixture-registration",
                source: "用户提供的隔离资料",
                policyTier: "enhanced"
              })
            )
          } else if (context.operation.stageId === "vendor.qualification") {
            const dossier = JSON.parse(readFileSync(join(workspace, "dossier.json"), "utf8"))
            consumed.push(dossier.vendorName)
            writeFileSync(
              join(workspace, "qualification.json"),
              JSON.stringify({
                vendorName: dossier.vendorName,
                status: invalidQualification ? "pretend-approved" : "needs-human-review",
                source: "dossier.json",
                policyTier: dossier.policyTier
              })
            )
          } else {
            const dossier = JSON.parse(readFileSync(join(workspace, "dossier.json"), "utf8"))
            const qualification = JSON.parse(
              readFileSync(join(workspace, "qualification.json"), "utf8")
            )
            consumed.push(qualification.status)
            writeFileSync(
              join(workspace, "vendor-report.json"),
              JSON.stringify({
                vendorName: dossier.vendorName,
                policyTier: dossier.policyTier,
                decision: "needs-human-review",
                qualificationStatus: qualification.status,
                sources: ["dossier.json", "qualification.json"]
              })
            )
          }
          return "succeeded"
        }
      }
    )
    await host.localCreate({
      projectId: "vendor",
      name: "供应商准入",
      workspace,
      installedPluginId: custom.copy.pluginId!,
      goal: "核对隔离供应商资料，并记录真实消费的资质产物。"
    })
    const run = async () => {
      const project = host.get("vendor")!
      const operation = host.prepare({
        projectId: "vendor",
        expectedVersion: project.version,
        idempotencyKey: randomUUID()
      })
      return phase("host-" + operation.stageId, () => host.start(operation.operationId))
    }
    const dossier = await run()
    expect(dossier.status).toBe("succeeded")
    host.transition(dossier.operationId)
    const failed = await run()
    expect(failed.status).toBe("failed")
    expect(failed.receipts).toEqual([
      expect.objectContaining({ checkId: "vendor.qualification.schema", result: "failed" })
    ])
    expect(() => host.transition(failed.operationId)).toThrow()
    expect(host.get("vendor")!.stageIndex).toBe(1)
    expect(existsSync(join(workspace, "vendor-report.json"))).toBe(false)
    invalidQualification = false
    const qualification = await run()
    expect(qualification.status).toBe("succeeded")
    // A successful model/Skill result or stale receipt cannot bypass new file bytes.
    const path = join(workspace, "qualification.json")
    const original = await readFile(path)
    await writeFile(path, "{}")
    expect(() => host.transition(qualification.operationId)).toThrow("EVIDENCE_STALE")
    await writeFile(path, original)
    host.transition(qualification.operationId)
    const report = await run()
    expect(report.status).toBe("succeeded")
    expect(report.receipts.every((receipt) => receipt.result === "passed")).toBe(true)
    expect(consumed).toContain("needs-human-review")
    expect(host.transition(report.operationId).status).toBe("completed")
  }, 15000)
})
