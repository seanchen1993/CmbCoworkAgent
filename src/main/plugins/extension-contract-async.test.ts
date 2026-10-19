import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  parseProjectRuntimeManifestV1,
  wrapProjectRuntimeManifest
} from "../../shared/project-runtime"
import { createProjectActionBinding } from "../harness-board/project-runtime/action-input"
import * as packageReaders from "../harness-board/project-runtime/package-snapshots"
import * as asyncFiles from "../harness-board/project-runtime/safe-files-async"
import { collectSnapshotGarbage } from "../harness-board/project-runtime/snapshot-retention"
import { assembleBusinessMods } from "./business-mod-assembler"
import { businessModCatalog } from "./business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "./derivation-source"
import {
  assertPackageExtensionCompatibility,
  assertPackageExtensionCompatibilityAsync
} from "./extension-contract"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "extension-contract-async-"))
  roots.push(root)
  return root
}
async function json(root: string, path: string, value: unknown) {
  await writeFile(join(root, path), JSON.stringify(value))
}
function runtime(mode: "host" | "legacy" = "legacy") {
  return parseProjectRuntimeManifestV1({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "async-business", version: "1.0.0" }, mode,
    stateOwner: mode === "legacy" ? "plugin" : "host",
    stages: mode === "host" ? [{ id: "draft", title: "Draft", actionIds: [],
      artifactIds: [], checkIds: [], approval: "none" }] : [],
    actions: [], artifacts: [], checks: [], environment: [],
    capabilities: { execution: true, conditionalTransition: false,
      idempotency: false, reconciliation: false, cancellation: true }
  })
}
const contract = {
  apiVersion: EXTENSION_CONTRACT_API_VERSION,
  requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
}
function syncFailure(root: string) {
  try { assertPackageExtensionCompatibility(root); return undefined }
  catch (error) { if (!(error instanceof Error)) throw error; return error.message }
}
async function matchesSync(root: string, expected?: string) {
  const failure = syncFailure(root)
  if (expected) expect(failure).toContain(expected)
  else expect(failure).toBeUndefined()
  if (failure) await expect(assertPackageExtensionCompatibilityAsync(root)).rejects.toThrow(failure)
  else await expect(assertPackageExtensionCompatibilityAsync(root)).resolves.toBeUndefined()
}

it("retains ordinary v1 behavior and rejects unknown semantics on every entrance", async () => {
  const root = await directory(), original = runtime()
  await json(root, "devclaw.project-runtime.json", original)
  await matchesSync(root)
  await json(root, "devclaw.project-runtime.json", { ...original, apiVersion: "devclaw.project-runtime/v99" })
  await matchesSync(root, "PROTOCOL_UNSUPPORTED")
  await json(root, "devclaw.project-runtime.json", original)
  await json(root, "secondary.json", { apiVersion: "devclaw.project-runtime/v2", runtime: original,
    extensionContract: { ...contract, requires: ["unknown.protocol/v1"] } })
  await json(root, "devclaw.capabilities.json", { apiVersion: "devclaw.capabilities/v1",
    capabilities: [{ id: "secondary", title: "Secondary", kind: "flow", usage: "project", entry: "secondary.json" }] })
  await matchesSync(root, "PROTOCOL_UNSUPPORTED")
})

it("requires the actual declared provider and mandatory agent bytes without broadening compatibility", async () => {
  const root = await directory()
  await json(root, "devclaw.project-runtime.json", wrapProjectRuntimeManifest(runtime(), {
    ...contract, requires: [...contract.requires, CONTEXT_HANDOFF_PROTOCOL],
    context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true }, provider: { entry: "provider.py", operations: ["session-context"] } }
  }))
  await matchesSync(root, "PROVIDER_MISSING")
  await writeFile(join(root, "provider.py"), "# Original declared provider\n")
  await mkdir(join(root, "board_core"))
  await json(root, "board_core/board_config.json", { apiVersion: 2, workflow: { nodes: [{
    id: "specs", runtimePolicy: { subagentConfig: { customSubagentFiles: ["agents/specs.md"] } }
  }] } })
  await matchesSync(root, "PROJECT_AGENT_RESOURCE_MISSING")
  await mkdir(join(root, "agents"))
  await writeFile(join(root, "agents/specs.md"), "---\nname: Spec-author\n---\nOriginal role\n")
  await matchesSync(root)
})

it("uses the original locked action validator for host action providers", async () => {
  const root = await directory(), original = runtime("host")
  const binding = createProjectActionBinding("context", {
    pluginId: "installed-provider", plugin: "provider", digest: "a".repeat(64),
    actionId: "context", name: "Context", command: "context",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }, {})
  original.actions = [{ id: binding.id, ref: binding.ref }]
  await json(root, "devclaw.project-runtime.json", wrapProjectRuntimeManifest(original, {
    ...contract, requires: [...contract.requires, CONTEXT_HANDOFF_PROTOCOL],
    context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true }, provider: { actionId: "context", operations: ["session-context"] } }
  }))
  await matchesSync(root, "PROJECT_ACTION_LOCK_MISSING")
  await json(root, "devclaw.project-actions.lock.json", { apiVersion: "devclaw.project-actions-lock/v1", bindings: [binding] })
  await matchesSync(root)
  await json(root, "devclaw.project-actions.lock.json", { apiVersion: "devclaw.project-actions-lock/v1",
    bindings: [{ ...binding, ref: { ...binding.ref, digest: "b".repeat(64) } }] })
  await matchesSync(root, "PROJECT_ACTION_LOCK_MISMATCH")
})

describe.skipIf(!process.env.AUTOBIZ_BUSINESS_SOURCE)("actual reviewed asynchronous protocol closure", () => {
  let files: ReturnType<typeof assembleBusinessMods>["files"]
  beforeAll(async () => {
    const source = await snapshotDerivationSource(process.env.AUTOBIZ_BUSINESS_SOURCE!)
    files = assembleBusinessMods([{ snapshot: source, catalog: businessModCatalog(source),
      modIds: ["biz.prd", "dev.specs"] }], { name: "async-reviewed-closure", version: "1.0.0",
      sources: [], verifiedArtifactIds: ["prd"] }).files
  }, 60_000)
  async function reviewed() {
    const root = await directory()
    await writeDerivationFiles(root, files)
    return root
  }

  it("reads real files afresh each time with zero synchronous whole-package reads", async () => {
    const root = await reviewed()
    expect(syncFailure(root)).toBeUndefined()
    const sync = vi.spyOn(packageReaders, "readPackageProtocolFiles")
    const actualReads = vi.spyOn(asyncFiles, "readRuntimeScopedFileAsync")
    await assertPackageExtensionCompatibilityAsync(root)
    const count = actualReads.mock.calls.length
    expect(count).toBe(files.length)
    await assertPackageExtensionCompatibilityAsync(root)
    expect(actualReads).toHaveBeenCalledTimes(count * 2)
    expect(sync).not.toHaveBeenCalled()
  }, 30_000)

  it.each(["hooks/state_checkpoint.py", "agents/critic.md", "devclaw.business-assembly.json"])(
    "rejects each changed %s and accepts only a fresh restored source", async path => {
      const root = await reviewed(), original = await readFile(join(root, path))
      await assertPackageExtensionCompatibilityAsync(root)
      await writeFile(join(root, path), Buffer.concat([original, Buffer.from("\n# changed\n")]))
      await matchesSync(root, "ADAPTER_UNSUPPORTED")
      expect(syncFailure(root)).toBeDefined()
      await writeFile(join(root, path), original)
      await matchesSync(root)
    }, 30_000)

  it.each(["source", "added-file", "deleted-file", "replaced-root", "abort"] as const)(
    "rejects %s changes while an actual original file read awaits", async change => {
      const root = await reviewed(), controller = new AbortController()
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      const read = asyncFiles.readRuntimeScopedFileAsync
      const path = "hooks/state_checkpoint.py"
      vi.spyOn(asyncFiles, "readRuntimeScopedFileAsync").mockImplementation(async (...args) => {
        const observed = await read(...args)
        if (args[1] === path) { entered.resolve(); await release.promise }
        return observed
      })
      const pending = assertPackageExtensionCompatibilityAsync(root, controller.signal)
      const rejected = expect(pending).rejects.toThrow()
      await entered.promise
      if (change === "source") await writeFile(join(root, path), "# Changed after its real read\n")
      if (change === "added-file") await writeFile(join(root, "new-unreviewed.py"), "# New code\n")
      if (change === "deleted-file") await unlink(join(root, path))
      if (change === "replaced-root") {
        const retired = root + "-retired"
        await rename(root, retired)
        roots.push(retired)
        await mkdir(root)
        await writeDerivationFiles(root, files)
      }
      if (change === "abort") controller.abort(new Error("ORIGINAL_CALL_CANCELLED"))
      release.resolve()
      await rejected
    }, 30_000)

  it("does no asynchronous source IO for an already aborted call", async () => {
    const root = await reviewed(), controller = new AbortController()
    controller.abort(new Error("ORIGINAL_CALL_CANCELLED"))
    const reads = vi.spyOn(asyncFiles, "readRuntimeScopedFileAsync")
    await expect(assertPackageExtensionCompatibilityAsync(root, controller.signal))
      .rejects.toThrow("ORIGINAL_CALL_CANCELLED")
    expect(reads).not.toHaveBeenCalled()
  })

  it("holds the original exact snapshot lease until the actual asynchronous scan settles", async () => {
    const base = await directory(), source = join(base, "source")
    await mkdir(source)
    await writeDerivationFiles(source, files)
    const snapshots = new packageReaders.RetainedPackageSnapshots(join(base, "snapshots"))
    const retained = snapshots.capture(source)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const read = asyncFiles.readRuntimeScopedFileAsync
    vi.spyOn(asyncFiles, "readRuntimeScopedFileAsync").mockImplementation(async (...args) => {
      const observed = await read(...args)
      if (args[1] === "hooks/state_checkpoint.py") { entered.resolve(); await release.promise }
      return observed
    })
    const pending = assertPackageExtensionCompatibilityAsync(retained.root)
    await entered.promise
    const collect = () => collectSnapshotGarbage(snapshots.root, () => ({
      complete: true, digests: new Set<string>(), blockers: []
    }))
    try {
      expect(collect().protected).toEqual([retained.digest])
    } finally { release.resolve() }
    await pending
    expect(collect().removed).toEqual([retained.digest])
  }, 30_000)
})
