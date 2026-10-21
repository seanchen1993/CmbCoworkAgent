import AdmZip from "adm-zip"
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins
}))
import { ModControlStore } from "../../mods/control-store"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { withNativeConfigurationScope } from "../../mods/v2/native-configuration-scope"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { createHostProjectInputIdentity } from "./package-input-identity"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"
import { setProjectActionRuntime } from "../project-action-runtime"
import { writeDerivationFiles } from "../../plugins/derivation-source"
import { readNativeCapabilityCatalog } from "../../plugins/capability-catalog"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { extensionContextStorageKey } from "../extension-context"
import {
  readCompositionUnitContext,
  assertCompositionUnitContextSelection
} from "./composition-unit-context"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe.runIf(process.env.RUN_AUTOBIZ_COLLECTOR_INTEGRATION === "1")(
  "reviewed AutoBiz collector (explicit artifact/dependency opt-in)",
  () => {
    it("lists the frozen producer's actual chosen knowledge through the original collector and fences later knowledge/config changes", async () => {
      const archive = resolve(
        process.env.AUTOBIZ_COMPOSITION_CONTEXT_ARCHIVE ??
          "output/deliveries/mods-verified-artifacts-20261017-v5/12-数仓可验证产物导出版.zip"
      )
      const dependencies = resolve(
        process.env.AUTOBIZ_CONTEXT_TEST_DEPENDENCIES ??
          "output/creator-context-fixture-deps/node_modules"
      )
      if (!existsSync(archive))
        throw Error(
          "AUTOBIZ_COLLECTOR_INTEGRATION_ARCHIVE_MISSING: set AUTOBIZ_COMPOSITION_CONTEXT_ARCHIVE to the reviewed warehouse ZIP"
        )
      if (!existsSync(join(dependencies, "gray-matter/index.js")))
        throw Error(
          "AUTOBIZ_COLLECTOR_INTEGRATION_DEPENDENCIES_MISSING: set AUTOBIZ_CONTEXT_TEST_DEPENDENCIES to prepared gray-matter@4.0.3 node_modules"
        )
      const archiveBytes = await readFile(archive),
        archiveHash = createHash("sha256").update(archiveBytes).digest("hex")
      const root = (state.root = await mkdtemp(join(tmpdir(), "composition-context-real-")))
      cleanup.push(async () => {
        if (
          dirname(root) !== tmpdir() ||
          !root.split(/[\\/]/).at(-1)!.startsWith("composition-context-real-")
        )
          throw Error("UNSAFE_TEST_CLEANUP")
        await rm(root, { recursive: true, force: true })
      })
      const source = join(root, "installed"),
        workspace = join(root, "unit"),
        knowledge = join(root, "knowledge")
      await mkdir(workspace)
      await mkdir(knowledge)
      await writeFile(
        join(knowledge, "agents.manifest.json"),
        JSON.stringify({
          schemaVersion: "v1",
          systems: [
            {
              systemId: "UNIT",
              systemName: "Unit",
              agentsPath: "UNIT/AGENTS.md",
              deployUnits: [{ deployUnitId: "UNIT.ONE" }, { deployUnitId: "UNIT.TWO" }]
            }
          ]
        })
      )
      await mkdir(join(knowledge, "UNIT"))
      await writeFile(join(knowledge, "UNIT/AGENTS.md"), "# Unit\nACTUAL_CHOSEN_KNOWLEDGE\n")
      await writeFile(
        join(knowledge, "UNIT/one.md"),
        "---\ndeploy_unit: UNIT.ONE\ntype: Product Knowledge\ntitle: One\n---\nActual unit facts\n"
      )
      await writeDerivationFiles(
        source,
        new AdmZip(archiveBytes)
          .getEntries()
          .filter((entry) => !entry.isDirectory)
          .map((entry) => {
            const bytes = entry.getData()
            return {
              path: entry.entryName,
              bytes,
              mode: 0o644,
              digest: createHash("sha256").update(bytes).digest("hex")
            }
          })
      )
      const metadata = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
      const retained = new RetainedPackageSnapshots(join(root, "retained")).capture(source)
      const snapshots = new RetainedPackageSnapshots(join(root, "retained"))
      const contentGuard = snapshots.captureGuard(retained.digest)
      const plugin = {
        id: "installed-producer",
        name: metadata.name,
        version: metadata.version,
        path: source,
        enabled: true
      } as PluginMetadata
      state.plugins = [plugin]
      const bound = { ...plugin, path: retained.root }
      let owner = true
      const guard = () => {
        if (!owner || !plugin.enabled) throw Error("ORIGINAL_CONTEXT_OWNER_REVOKED")
        contentGuard()
      }
      const store = new ModControlStore(join(root, "mods.sqlite"))
      const manager = new FunctionModsManager(
        store,
        {
          plugins: () => state.plugins,
          enabled: () => true,
          publish: async (_workspace, value) => value,
          changed: () => {}
        },
        () => {
          const guests: FunctionGuestRuntime[] = []
          return {
            async load(code, options) {
              const guest = await FunctionGuestRuntime.create(code, options)
              guests.push(guest)
              return guest
            },
            stop() {
              for (const guest of guests) void guest.dispose()
            },
            async stopAndDrain() {
              await Promise.all(guests.map((guest) => guest.dispose()))
            }
          }
        }
      )
      cleanup.push(() => {
        manager.close()
        store.close()
      })
      const nativeScope = {
        workspace,
        projectId: "composition-legacy:run:unit",
        plugin: bound,
        assertCurrent: guard,
        assertContentCurrent: guard
      }
      const nativeSave = async (directory: string) =>
        withNativeConfigurationScope(nativeScope, async () => {
          const signal = new AbortController().signal
          const view = await manager.userConfig(
            workspace,
            nativeScope.projectId,
            plugin.id,
            signal,
            guard
          )
          return manager.saveUserConfig(
            workspace,
            nativeScope.projectId,
            plugin.id,
            view.digest,
            "knowledgeRoot",
            directory,
            view.savedRevision,
            signal,
            guard
          )
        })
      await nativeSave(knowledge)
      const grantScope = { projectId: nativeScope.projectId, packageDigest: retained.digest }
      const context = readPackageExtensionContract(retained.root)!.context!
      const data = join(
        root,
        "plugin-data",
        extensionContextStorageKey(
          metadata,
          await readFile(join(retained.root, "board_core/board_config.json")),
          context,
          realpathSync(knowledge)
        )
      )
      await mkdir(join(data, "collector"), { recursive: true })
      await cp(dependencies, join(data, "collector/node_modules"), { recursive: true })
      const inputs = createHostProjectInputIdentity(manager, {
        rules: () => [],
        contextDataRoot: join(root, "plugin-data")
      })
      const flows = new FlowManager(new FlowStore(store), {
        assertScope: () => undefined,
        changed: () => undefined,
        prepare: async () => {
          throw Error("NO_FLOW_EXECUTION_FOR_CONTEXT_READ")
        }
      })
      setProjectActionRuntime({
        ...inputs,
        flows,
        catalog: async () => [],
        prepareSelection: async () => undefined
      })
      let fullReads = 0
      const authority = () => {
        if (!owner || !plugin.enabled) throw Error("ORIGINAL_CONTEXT_OWNER_REVOKED")
      }
      const full = () => {
        guard()
        snapshots.read(retained.digest)
        fullReads++
      }
      const queryTimings: Array<{
        legacyFullOwner: boolean
        elapsedMs: number
        fullReads: number
      }> = []
      const read = async (legacyFullOwner = false) => {
        const started = performance.now(),
          readsBefore = fullReads
        try {
          return await readCompositionUnitContext({
            plugin: bound,
            packageDigest: retained.digest,
            workspace,
            configurationWorkspace: workspace,
            manager,
            grantScope,
            assertCurrent: full,
            ...(legacyFullOwner ? {} : { assertAuthorityCurrent: authority })
          })
        } finally {
          // The 45s case watchdog covers native configuration, approval and several queries.
          // Each original candidate query keeps a separate 15s end-to-end ceiling.
          const elapsedMs = performance.now() - started
          queryTimings.push({ legacyFullOwner, elapsedMs, fullReads: fullReads - readsBefore })
          console.info("Native candidate query evidence", JSON.stringify(queryTimings.at(-1)))
          expect(elapsedMs).toBeLessThan(15_000)
        }
      }
      await expect(read()).rejects.toThrow("PROJECT_MODS_APPROVAL_REQUIRED")
      const review = await manager.runtimeSourceReview({
        workspace,
        plugin: bound,
        scope: grantScope
      })
      await manager.approveRuntimeSource(
        { workspace, plugin: bound, scope: grantScope, digest: review!.digest },
        guard
      )
      const catalog = await readNativeCapabilityCatalog(bound, "project")
      expect(catalog.status, JSON.stringify(catalog)).toBe("declared")
      // Explicit historical diagnostic only: a slow old callback remains a failed 15s query,
      // never an expected-failure pass or a reason to relax the normal query limit.
      const legacyBefore = fullReads
      const legacyOwner =
        process.env.CMB_COMPOSITION_CONTEXT_BASELINE === "1" ? await read(true) : undefined
      const legacyReads = fullReads - legacyBefore
      if (legacyOwner) expect(legacyReads).toBe(21)
      const before = fullReads
      const initial = await read()
      expect(fullReads - before).toBe(4)
      if (legacyOwner) expect(initial.view).toEqual(legacyOwner.view)
      expect(initial.view).toMatchObject({
        supported: true,
        required: true,
        candidates: ["UNIT.ONE", "UNIT.TWO"]
      })
      expect(
        initial.view.candidates.some((id) => id.startsWith("LA64") || id.startsWith("LB47"))
      ).toBe(false)
      const selected = {
        deployUnitIds: ["UNIT.ONE"],
        contextFingerprint: initial.view.contextFingerprint!
      }
      expect(() => assertCompositionUnitContextSelection(initial.view, selected)).not.toThrow()
      expect(() => assertCompositionUnitContextSelection(initial.view, undefined)).toThrow(
        "CONTEXT_REQUIRED"
      )
      const knowledgeFile = join(knowledge, "UNIT/one.md")
      const original = await readFile(knowledgeFile, "utf8")
      await writeFile(knowledgeFile, original + "\nChanged actual knowledge bytes\n")
      expect(initial.assertCurrent).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
      const previousReads = fullReads
      const changed = await read()
      expect(fullReads - previousReads).toBe(4)
      console.info(
        "Native candidate boundary evidence",
        JSON.stringify({ legacyReads, currentReads: 4, queryTimings })
      )
      expect(changed.view.contextFingerprint).not.toBe(initial.view.contextFingerprint)
      expect(() => assertCompositionUnitContextSelection(changed.view, selected)).toThrow(
        "CONTEXT_CHANGED"
      )
      await writeFile(knowledgeFile, original)
      const otherKnowledge = join(root, "other-knowledge")
      await cp(knowledge, otherKnowledge, { recursive: true })
      await nativeSave(otherKnowledge)
      expect(changed.assertCurrent).toThrow("CONTEXT_INPUT_CHANGED")
      owner = false
      await expect(read()).rejects.toThrow("OWNER_REVOKED")
      expect(
        createHash("sha256")
          .update(await readFile(archive))
          .digest("hex")
      ).toBe(archiveHash)
    }, 45_000)
  }
)
