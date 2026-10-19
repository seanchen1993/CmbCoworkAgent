import { afterEach, expect, it, vi } from "vitest"
import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { AuthoringDraftStore } from "./authoring-store"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { AuthoringInstallService } from "./authoring-install-service"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { ClawStore } from "../claw-store"
import { ModDevelopmentService, type DevelopmentRuntime } from "./development-service"
import { CreatorReuseService } from "./creator-reuse"
import { CreatorCompositionSave } from "./creator-composition-save"
import { CreatorCompositionHistory } from "./creator-composition-history"
import { createAuthoringTemplate } from "./authoring-templates"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import type { DevelopmentTrialStatus } from "../../../shared/mods/development"
import { compileFunctionPlugin } from "../v2/loader"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("saves an uninstalled trial via real development requestReuse, formal Worker compilation and original installation", async () => {
  const workerRoot = await mkdtemp(resolve("output/save-reuse-integration-"))
  const root = await mkdtemp(join(tmpdir(), "save-reuse-integration-"))
  cleanup.push(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("save-reuse-integration-") ||
      dirname(resolve(workerRoot)) !== resolve("output") ||
      !basename(workerRoot).startsWith("save-reuse-integration-")
    )
      throw Error("TEST_CLEANUP_BOUNDARY")
    await rm(root, { recursive: true, force: true })
    await rm(workerRoot, { recursive: true, force: true })
  })
  const workerEntry = join(workerRoot, "preflight.cjs")
  await build({
    entryPoints: [resolve("src/main/mods/devtools/authoring-preflight-entry.ts")],
    outfile: workerEntry,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external"
  })
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      values.set(key, value)
    },
    compareAndSetSetting: (key: string, before: string | undefined, next: string) => {
      if (values.get(key) !== before) return false
      values.set(key, next)
      return true
    }
  }
  const scope = {
    workspace: root,
    threadId: "creator",
    incarnation: { token: "same-chat", legacyCreatedAt: 1 }
  }
  const context = { scope, assertCurrent: () => {} },
    identity = JSON.stringify([scope.threadId, scope.incarnation.token])
  const claws = new ClawStore(settings),
    drafts = new AuthoringDraftStore(settings)
  claws.apply(
    root,
    identity,
    {
      id: "initial",
      name: "Initial",
      capabilities: [],
      models: { default: "retained-model", roles: {} },
      builtins: { contextMeter: true }
    },
    0
  )
  const versionsRoot = join(root, "formal-versions"),
    index = new PluginCatalogIndex(join(root, "plugins.json"))
  const installer = new AuthoringInstallService({
    settings,
    drafts,
    index,
    versions: new AuthoringVersionRepository(versionsRoot, workerEntry),
    versionsRoot,
    isVersionReferenced: () => false,
    assertIdle: () => {},
    changed: () => {},
    inspectNames: async () => ({ names: [], assertCurrent: () => {} })
  })
  const applyInstall = vi.spyOn(installer, "apply")
  let trials: DevelopmentTrialStatus[] = [],
    authorized = false,
    ready = false
  const runtime: DevelopmentRuntime = {
    developmentRetention: () => ({ releasable: false, revisions: [1] }),
    stageDevelopment: async (_scope, candidate, guard) => {
      guard()
      trials = [
        {
          ...candidate,
          capabilities: [...candidate.capabilities],
          phase: "active",
          activeRevision: candidate.revision,
          activeDigest: candidate.compiledDigest
        }
      ]
    },
    developmentStatus: () => trials,
    approveDevelopment: async () => {},
    stopDevelopment: async (_scope, _id, guard) => {
      guard()
      trials = []
    }
  }
  const development = new ModDevelopmentService({
    drafts,
    runtime,
    versionsRoot: join(root, "trial-versions"),
    workerEntry,
    context: () => context,
    changed: () => {}
  })
  const reuse = new CreatorReuseService({
    settings,
    drafts,
    claws,
    install: installer,
    readContext: () => context,
    readDraft: (_thread, id) => development.read(scope.threadId, id),
    identity: () => identity,
    available: async () => {
      const plugins = JSON.parse(index.capture().raw ?? "[]") as Array<{
        id: string
        path: string
        name: string
      }>
      return Promise.all(
        plugins.map(async (plugin) => ({
          pluginId: plugin.id,
          name: plugin.name,
          digest: (await compileFunctionPlugin(plugin.path)).digest,
          capabilities: [],
          state: authorized ? ("ready" as const) : ("needs-approval" as const)
        }))
      )
    },
    stopTrial: async (_scope, id, guard) => { await runtime.stopDevelopment(scope, id, guard) },
    approveInstalled: async (_scope, receipt, guard) => {
      guard()
      const plugins = JSON.parse(index.capture().raw ?? "[]") as Array<{
        id: string
        path: string
      }>
      const installed = plugins.find((plugin) => plugin.id === receipt.installationId)
      expect(installed).toBeDefined()
      expect((await compileFunctionPlugin(installed!.path)).digest).toBe(receipt.compiledDigest)
      authorized = true
    },
    assertAuthorized: () => {
      if (!authorized) throw Error("NOT_AUTHORIZED")
    },
    runtimeReady: () => ready,
    applySelection: async (_workspace, _thread, _profile, commit, guard) => {
      guard()
      commit()
      ready = true
    },
    busy: () => false,
    onIdle: () => () => {},
    changed: () => {}
  })
  cleanup.push(async () => reuse.close())
  development.configureReuse(reuse)
  await development.setEnabled(scope.threadId, root, true)
  const source = createAuthoringTemplate({
    id: "doc-review",
    name: "Review",
    kind: "command",
    instruction: "Show real review evidence"
  })
  development.save(scope.threadId, {
    id: "doc-review",
    name: "Review",
    expectedRevision: 0,
    files: source.files
  })
  await development.requestTrial(
    scope.threadId,
    "doc-review",
    1,
    "trial-turn",
    new AbortController().signal,
    () => {}
  )
  const trialDigest = trials[0].compiledDigest
  const history = new CreatorCompositionHistory(settings)
  const save = new CreatorCompositionSave(history, {
    trials: () => trials,
    prepareReuse: async (_thread, dependency, input) =>
      (
        await development.requestReuse(
          scope.threadId,
          dependency.draftId,
          dependency.revision,
          input.turnId,
          input.signal,
          input.assertTurn
        )
      ).reuse!,
    reuseFacts: (scope) => reuse.compositionFacts(scope)
  })
  cleanup.push(async () => save.close())
  expect(
    await save.start({
      scope,
      identity,
      name: "Daily",
      revision: 0,
      profile: claws.selection(root, identity).profile,
      turnId: "save-turn",
      signal: new AbortController().signal,
      assertTurn: () => {}
    })
  ).toMatchObject({ saved: false, phase: "needs-approval" })
  const prepared = reuse.status(scope)!
  expect(prepared.compiledDigest).not.toBe(trialDigest)
  expect(history.saveIntent(scope)).toMatchObject({
    nativeReuseCompiledDigest: prepared.compiledDigest,
    dependencies: [{ activeTrialCompiledDigest: trialDigest }]
  })
  expect(history.list(root)).toEqual([])
  expect(applyInstall).not.toHaveBeenCalled()
  publishDevelopmentTurnSettlement({
    threadId: scope.threadId,
    turnId: "save-turn",
    incarnation: scope.incarnation,
    outcome: "completed"
  })
  await development.approveReuse(scope.threadId, root, {
    planId: prepared.planId!,
    sourceDigest: prepared.sourceDigest,
    compiledDigest: prepared.compiledDigest!,
    targetProfileDigest: prepared.targetProfileDigest!
  })
  await vi.waitFor(
    () =>
      expect(reuse.status(scope), JSON.stringify(reuse.status(scope))).toMatchObject({
        phase: "active"
      }),
    { timeout: 15_000 }
  )
  await save.reconcile({
    scope,
    identity,
    current: () => claws.selection(root, identity).profile,
    assertCurrent: () => {},
    validate: async () => {
      expect(authorized && ready).toBe(true)
    }
  })
  expect(save.status(scope)).toMatchObject({ saved: true, phase: "saved", revision: 1 })
  const saved = history.load(root, "Daily", 1)
  expect(saved.capabilities[0].digest).toBe(prepared.compiledDigest)
  expect(saved.models?.default).toBe("retained-model")
  expect(saved.builtins?.contextMeter).toBe(true)
  expect(applyInstall).toHaveBeenCalledTimes(1)
}, 45_000)
