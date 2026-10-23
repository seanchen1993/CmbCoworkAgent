import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import type { BusinessModAssemblyRequest, BusinessModDefinition } from "../../shared/business-mods"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { HostProjectService } from "../harness-board/project-runtime/host-service"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { resolveFunctionUserConfig } from "../../shared/mods/v2/user-config"
import { BusinessModAssemblyService } from "./business-mod-assembly-service"
import { businessModCatalog, parseBusinessModCatalog } from "./business-mod-manifest"
import { snapshotDerivationSource } from "./derivation-source"
import { inspectBusinessWorkflow, transformBusinessWorkflow } from "./business-workflow-transform"

const execute = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const guard = () => {}
const sourcePath = resolve("examples/vendor-onboarding-mods")
const conversionPath = resolve("examples/vendor-requirement-conversion-mod")

async function fixture() {
  const directory = await mkdtemp(join(canonicalTmpdir(), "workflow-independent-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const baseSnapshot = await snapshotDerivationSource(sourcePath)
  const base = businessModCatalog(baseSnapshot)
  const conversionSnapshot = await snapshotDerivationSource(conversionPath)
  const conversion = businessModCatalog(conversionSnapshot).modules[0]
  const extensionIds = base.extensions!.map((extension) => extension.id)
  const original = inspectBusinessWorkflow(base.modules, extensionIds)
  expect(original.diagnostics).toEqual([])
  const dossier = structuredClone(base.modules[0])
  dossier.node.skill = "vendor-dossier-normalized"
  dossier.skill.entry = "skills/vendor-dossier-normalized/SKILL.md"
  dossier.dependencies.required.push(conversion.id)
  const transformed = transformBusinessWorkflow({
    modules: base.modules,
    extensionIds,
    sourceDigest: baseSnapshot.digest,
    expectedWorkflowDigest: original.digest,
    changes: [
      { kind: "insert", before: "vendor.dossier", module: conversion },
      { kind: "replace_step", id: "vendor.dossier", module: dossier }
    ]
  })
  expect(transformed.evidence).toBe("invalidated")
  expect(transformed.execution).toBe("unverified")
  expect(transformed.workflow.diagnostics).toEqual([])
  const draftRoot = join(directory, "transformed-source")
  await cp(conversionPath, draftRoot, { recursive: true })
  const draftCatalog = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: base.kernel!.id, version: base.kernel!.version },
    modules: transformed.modules.filter((mod) => transformed.changedIds.includes(mod.id))
  })
  await writeFile(join(draftRoot, "mods/business/manifest.json"), JSON.stringify(draftCatalog))
  const draftSnapshot = await snapshotDerivationSource(draftRoot)
  const installed: Array<{ id: string; name: string; path: string }> = []
  const assembly = new BusinessModAssemblyService(join(directory, "assembly"), {
    plugins: () => installed as never,
    validatePackage: async (root) => {
      const runtime = parseProjectRuntimeManifest(
        JSON.parse(await readFile(join(root, "devclaw.project-runtime.json"), "utf8"))
      )
      assertHostPackageSupported(root, runtime)
    },
    install: async (root, name, id, assertCurrent, verify) => {
      const path = join(directory, "installed", id)
      await cp(root, path, { recursive: true })
      await verify(path)
      assertCurrent()
      installed.push({ id, name, path })
      return { success: true }
    },
    invalidate: () => {}
  })
  const source = await assembly.inspect(sourcePath, "owner", guard)
  const draft = await assembly.inspect(draftRoot, "owner", guard)
  const request: BusinessModAssemblyRequest = {
    name: "vendor-with-requirement-conversion",
    version: "1.0.0",
    sources: [
      { inspectionId: source.id, modIds: ["vendor.decision"] },
      { inspectionId: draft.id, modIds: [conversion.id, dossier.id] }
    ],
    order: transformed.order,
    replacements: transformed.replacements.map((id) => ({
      id,
      sourceDigest: baseSnapshot.digest,
      replacementSourceDigest: draftSnapshot.digest
    }))
  }
  const create = async () => {
    const preview = await assembly.preview("owner", request, guard)
    expect(preview.valid).toBe(true)
    expect(preview.steps.map((stage) => stage.id)).toEqual([
      "vendor.requirement-convert",
      "vendor.dossier",
      "vendor.decision"
    ])
    const copy = await assembly.create("owner", preview.previewId, randomUUID(), guard)
    await assembly.check("owner", copy.copyId, copy.digest, guard)
    const installedCopy = await assembly.install("owner", copy.copyId, copy.digest, guard)
    const path = installed.find((plugin) => plugin.id === installedCopy.pluginId)!.path
    return { path, pluginId: installedCopy.pluginId! }
  }
  return { directory, assembly, request, transformed, base, baseSnapshot, draftRoot, create }
}

describe("generic creator workflow edits in an independent supplier plugin", () => {
  it("generates, checks and installs an inserted step without a business-specific platform adapter", async () => {
    const f = await fixture()
    const installed = await f.create()
    const compiled = await compileFunctionPlugin(installed.path)
    expect(compiled.userConfig).toBeDefined()
    expect(resolveFunctionUserConfig(compiled.userConfig!, { policyTier: "enhanced" })).toEqual({
      policyTier: "enhanced"
    })
    expect(await readFile(join(installed.path, "knowledge/admission-policy.md"))).toEqual(
      await readFile(join(sourcePath, "knowledge/admission-policy.md"))
    )
    expect(await readFile(join(installed.path, "board_core/board_config.json"))).toEqual(
      await readFile(join(sourcePath, "board_core/board_config.json"))
    )
    const runtime = parseProjectRuntimeManifest(
      JSON.parse(await readFile(join(installed.path, "devclaw.project-runtime.json"), "utf8"))
    )
    expect(runtime.mode).toBe("host")
    expect(runtime.stateOwner).toBe("host")
    expect(runtime.stages[1].skill).toBe("skills/vendor-dossier-normalized/SKILL.md")
    expect(runtime.stages[1].checkIds).toContain("vendor.dossier.schema")
    expect(JSON.stringify(runtime)).not.toContain("autobiz")
  })

  it("executes real outputs, rejects bad schema and stale upstream bytes, and persists only checked transitions", async () => {
    const f = await fixture()
    const installed = await f.create()
    const workspace = join(f.directory, "workspace")
    await mkdir(workspace)
    await writeFile(
      join(workspace, "raw-request.json"),
      JSON.stringify({
        vendorName: "隔离资料供应商",
        registrationId: "registration-42",
        source: "user-request-42"
      })
    )
    const store = new HostProjectStore(join(f.directory, "host.sqlite"))
    cleanup.push(async () => store.close())
    let corruptConversion = true
    let executions = 0
    const actualProcesses: string[] = []
    const host = new HostProjectService(
      store,
      new HostPackageSnapshots(join(f.directory, "snapshots")),
      {
        resolveInstalledPlugin: async () => ({
          installedPluginId: installed.pluginId,
          root: installed.path,
          packageId: f.request.name,
          packageVersion: "1.0.0",
          enabled: true
        }),
        authorize: async () => {},
        // The production Host, retained package, validators, SQLite writer and input guards are
        // real. The model boundary is deliberately controlled by an actual plugin child process.
        executeSkill: async (context) => {
          const ids = ["vendor.requirement-convert", "vendor.dossier", "vendor.decision"]
          const mode = ["convert", "dossier", "decision"][ids.indexOf(context.operation.stageId)]
          expect(context.snapshotRoot).not.toBe(installed.path)
          const skill = await readFile(join(context.snapshotRoot, context.skillPath), "utf8")
          expect(skill).toContain("VENDOR_")
          const runner = join(
            context.snapshotRoot,
            "mods/business/vendor.requirement-convert/run.mjs"
          )
          const result = await execute(
            process.execPath,
            [runner, mode, context.snapshotRoot, workspace, "enhanced"],
            {
              signal: context.signal,
              windowsHide: true,
              timeout: 5000
            }
          )
          expect(JSON.parse(result.stdout)).toMatchObject({
            knowledge: "VENDOR_POLICY_2026_01",
            policyTier: "enhanced"
          })
          actualProcesses.push(mode)
          executions++
          if (corruptConversion && mode === "convert")
            await writeFile(join(workspace, "normalized-request.json"), '{"schemaVersion":2}')
          return "succeeded"
        }
      }
    )
    await host.localCreate({
      projectId: "supplier-with-conversion",
      name: "前插需求转换的独立业务",
      workspace,
      installedPluginId: installed.pluginId,
      goal: "保留准入规则和配置，实际消费结构化需求。"
    })
    const run = async () => {
      const project = host.get("supplier-with-conversion")!
      const operation = host.prepare({
        projectId: project.projectId,
        expectedVersion: project.version,
        idempotencyKey: randomUUID()
      })
      return host.start(operation.operationId)
    }
    const bad = await run()
    expect(bad.status).toBe("failed")
    expect(bad.receipts).toEqual([
      expect.objectContaining({ checkId: "vendor.requirement.schema", result: "failed" })
    ])
    expect(() => host.transition(bad.operationId)).toThrow()
    expect(host.get("supplier-with-conversion")!.stageIndex).toBe(0)
    corruptConversion = false
    const converted = await run()
    expect(converted.status).toBe("succeeded")
    host.transition(converted.operationId)
    expect(host.get("supplier-with-conversion")!.stageIndex).toBe(1)
    const path = join(workspace, "normalized-request.json")
    const accepted = await readFile(path)
    await rm(path)
    await expect(run()).rejects.toThrow("PROJECT_HOST_REQUIRED_INPUT_MISSING")
    expect(host.get("supplier-with-conversion")!.stageIndex).toBe(1)
    await writeFile(path, accepted)
    const dossier = await run()
    expect(dossier.status).toBe("succeeded")
    await writeFile(
      path,
      accepted.toString().replace("registration-42", "changed-after-validation")
    )
    expect(() => host.transition(dossier.operationId)).toThrow("PROJECT_HOST_INPUT_CHANGED")
    expect(host.get("supplier-with-conversion")!.stageIndex).toBe(1)
    await writeFile(path, accepted)
    host.transition(dossier.operationId)
    const report = await run()
    expect(report.status).toBe("succeeded")
    expect(host.transition(report.operationId).status).toBe("completed")
    expect(actualProcesses).toEqual(["convert", "convert", "dossier", "decision"])
    expect(executions).toBe(4)
    const result = JSON.parse(await readFile(join(workspace, "vendor-report.json"), "utf8"))
    expect(result).toMatchObject({
      vendorName: "隔离资料供应商",
      policyTier: "enhanced",
      sources: ["normalized-request.json", "dossier.json"]
    })
  }, 15000)

  it("rejects duplicate replacement without precise provenance and rejects an edited source before publication", async () => {
    const f = await fixture()
    await expect(
      f.assembly.preview("owner", { ...f.request, replacements: [] }, guard)
    ).rejects.toThrow()
    await expect(
      f.assembly.preview(
        "owner",
        {
          ...f.request,
          replacements: f.request.replacements!.map((replacement) => ({
            ...replacement,
            sourceDigest: "0".repeat(64)
          }))
        },
        guard
      )
    ).rejects.toThrow("BUSINESS_WORKFLOW_REPLACEMENT_INVALID")
    const preview = await f.assembly.preview("owner", f.request, guard)
    await writeFile(
      join(f.draftRoot, "skills/vendor-dossier-normalized/SKILL.md"),
      "changed after preview"
    )
    await expect(
      f.assembly.create("owner", preview.previewId, randomUUID(), guard)
    ).rejects.toThrow()
  })

  it("allows a skill-only change, keeps its check contract and rejects removing original checks", async () => {
    const f = await fixture()
    const extensionIds = f.base.extensions!.map((extension) => extension.id)
    const original = inspectBusinessWorkflow(f.base.modules, extensionIds)
    const edited = transformBusinessWorkflow({
      modules: f.base.modules,
      extensionIds,
      sourceDigest: f.baseSnapshot.digest,
      expectedWorkflowDigest: original.digest,
      changes: [
        {
          kind: "replace_skill",
          id: "vendor.dossier",
          skillName: "vendor-dossier-normalized",
          skill: { entry: "skills/vendor-dossier-normalized/SKILL.md", resources: [] }
        }
      ]
    })
    expect(edited.modules[0].host).toEqual(f.base.modules[0].host)
    expect(edited.replacements).toEqual(["vendor.dossier"])
    const removed = structuredClone(f.base.modules[0]) as BusinessModDefinition
    removed.host!.checks = []
    expect(() =>
      transformBusinessWorkflow({
        modules: f.base.modules,
        extensionIds,
        sourceDigest: f.baseSnapshot.digest,
        expectedWorkflowDigest: original.digest,
        changes: [{ kind: "replace_step", id: "vendor.dossier", module: removed }]
      })
    ).toThrow("BUSINESS_WORKFLOW_REQUIRED_CHECK_REMOVED")
    expect(() =>
      transformBusinessWorkflow({
        modules: f.base.modules,
        extensionIds,
        sourceDigest: f.baseSnapshot.digest,
        expectedWorkflowDigest: "0".repeat(64),
        changes: [{ kind: "replace_step", id: "vendor.dossier", module: f.base.modules[0] }]
      })
    ).toThrow("BUSINESS_WORKFLOW_CHANGED")
  })
})
