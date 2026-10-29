import { afterEach, expect, it, vi } from "vitest"
import { build } from "esbuild"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { AuthoringDraftStore } from "./authoring-store"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { AuthoringInstallService } from "./authoring-install-service"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { getPluginSkillSearchSources, readPluginManifest } from "../../plugins/manifest"
import { ClawStore } from "../claw-store"
import { ModDevelopmentService, type DevelopmentRuntime } from "./development-service"
import { CreatorReuseService } from "./creator-reuse"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { compileFunctionPlugin } from "../v2/loader"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import {
  developmentDependencyCatalogPage,
  readDevelopmentDependencySource
} from "./development-dependency-catalog"
import { prepareDevelopmentDependency } from "./development-dependency-prepare"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("preserves every pinned dependency and inert project companion through real save/check/native reuse/installation", async () => {
  const workerRoot = await mkdtemp(resolve("output/dependency-reuse-integration-"))
  const root = await mkdtemp(join(tmpdir(), "dependency-reuse-integration-"))
  cleanup.push(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("dependency-reuse-integration-") ||
      dirname(resolve(workerRoot)) !== resolve("output") ||
      !basename(workerRoot).startsWith("dependency-reuse-integration-")
    )
      throw Error("TEST_CLEANUP_BOUNDARY")
    await rm(root, { recursive: true, force: true })
    await rm(workerRoot, { recursive: true, force: true })
  })
  const workerEntry = join(workerRoot, "mods-authoring-preflight.js")
  await build({
    entryPoints: {
      "mods-authoring-preflight": resolve("src/main/mods/devtools/authoring-preflight-entry.ts"),
      analysis: resolve("src/main/mods/devtools/development-analysis.ts")
    },
    outdir: workerRoot,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external"
  })
  // The real analysis function locates its fixed Worker beside its compiled host module.
  const analyze = createRequire(import.meta.url)(join(workerRoot, "analysis.js"))
    .analyzeDevelopmentSource as typeof import("./development-analysis").analyzeDevelopmentSource
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
    threadId: "dependency-creator",
    incarnation: { token: "exact-dependency-chat", legacyCreatedAt: 1 }
  }
  const context = { scope, assertCurrent: () => {} }
  const identity = JSON.stringify([scope.threadId, scope.incarnation.token])
  const claws = new ClawStore(settings)
  const drafts = new AuthoringDraftStore(settings)
  claws.apply(
    root,
    identity,
    {
      id: "initial",
      name: "Initial",
      capabilities: [],
      models: { default: "preserved-model", roles: {} }
    },
    0
  )
  const versionsRoot = join(root, "formal-versions")
  const index = new PluginCatalogIndex(join(root, "plugins.json"))
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
  const stage = vi.fn(async () => {
    throw Error("DEPENDENCY_TRIAL_NOT_REQUESTED")
  })
  const runtime: DevelopmentRuntime = {
    developmentRetention: () => ({ releasable: false, revisions: [] }),
    stageDevelopment: stage,
    developmentStatus: () => [],
    approveDevelopment: async () => {},
    stopDevelopment: async () => {}
  }
  const development = new ModDevelopmentService({
    drafts,
    runtime,
    versionsRoot: join(root, "trial-versions"),
    workerEntry,
    analyze,
    context: () => context,
    changed: () => {}
  })
  let authorized = false
  let ready = false
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
        name: string
        path: string
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
    stopTrial: async () => {},
    approveInstalled: async (_scope, receipt, guard) => {
      guard()
      const plugins = JSON.parse(index.capture().raw ?? "[]") as Array<{ id: string; path: string }>
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

  const mainDirectory = resolve("main")
  const indexPage = developmentDependencyCatalogPage({
    mainDirectory,
    assetPath: "test-verification"
  })
  if (!("sourceDigest" in indexPage)) throw Error("EXPECTED_DEPENDENCY_INDEX")
  const source = readDevelopmentDependencySource({
    mainDirectory,
    sourceId: "test-verification",
    expectedDigest: indexPage.sourceDigest
  })
  expect(source.files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      "mods/runner.ts",
      "modules/e2e/SKILL.md",
      "workflows/verify.workflow.js"
    ])
  )
  // Same Host helper called by dependency_prepare; no save/check/preflight/installer mocks.
  const creator = development.projectAuthoringContext(scope.threadId)
  const claimCandidate = vi.fn()
  const preparedDependency = await prepareDevelopmentDependency({
    service: development, mainDirectory, threadId: scope.threadId,
    sourceId: "test-verification", turnId: "dependency-turn",
    signal: new AbortController().signal,
    assertCurrent: () => {
      creator.assertCurrent()
      development.assertScope(creator.scope)
    },
    claimCandidate
  })
  expect(preparedDependency).toMatchObject({
    sourceId: "test-verification", phase: "needs-approval",
    draft: { id: "test-verification", name: "test-verification", revision: 1,
      sourceDigest: source.digest },
    check: { valid: true, runtimeVerified: false },
    installed: false, grantsAuthority: false, executed: false, trialRequested: false
  })
  expect(claimCandidate).toHaveBeenCalledOnce()
  expect(Buffer.byteLength(JSON.stringify({ ok: true, result: preparedDependency }))).toBeLessThanOrEqual(24000)
  expect(preparedDependency.companionIndex.map(file => file.path)).toEqual([
    "modules/e2e/SKILL.md", "workflows/verify.workflow.js"
  ])
  if (!("companionSources" in preparedDependency)) throw Error("EXPECTED_BOUNDED_COMPANION_TEXT")
  for (const file of preparedDependency.companionSources)
    expect(source.files.find(original => original.path === file.path)).toEqual(file)
  const saved = development.read(scope.threadId, "test-verification")
  expect(saved.source.digest).toBe(indexPage.sourceDigest)
  expect(saved.source).toEqual(source)
  const originalPlan = reuse.status(scope)!
  const requestAgain = vi.spyOn(development, "requestReuse")
  const rechecked = await prepareDevelopmentDependency({
    service: development, mainDirectory, threadId: scope.threadId,
    sourceId: "test-verification", turnId: "dependency-turn",
    revision: saved.revision, expectedDigest: source.digest,
    signal: new AbortController().signal,
    assertCurrent: () => {
      creator.assertCurrent()
      development.assertScope(creator.scope)
    },
    claimCandidate
  })
  expect(rechecked).toMatchObject({ draft: { revision: 1 },
    reuse: { phase: "needs-approval", planId: originalPlan.planId } })
  expect(requestAgain).not.toHaveBeenCalled()
  const prepared = reuse.status(scope)!
  expect(prepared).toMatchObject({ sourceDigest: source.digest, phase: "needs-approval" })
  expect(applyInstall).not.toHaveBeenCalled()
  expect(authorized).toBe(false)
  expect(stage).not.toHaveBeenCalled()
  publishDevelopmentTurnSettlement({
    threadId: scope.threadId,
    turnId: "dependency-turn",
    incarnation: scope.incarnation,
    outcome: "completed"
  })
  await development.approveReuse(scope.threadId, root, {
    planId: prepared.planId!,
    sourceDigest: prepared.sourceDigest,
    compiledDigest: prepared.compiledDigest!,
    targetProfileDigest: prepared.targetProfileDigest!
  })
  await vi.waitFor(() => expect(reuse.status(scope)).toMatchObject({ phase: "active" }), {
    timeout: 15_000
  })
  expect(applyInstall).toHaveBeenCalledTimes(1)
  expect(authorized && ready).toBe(true)
  expect(stage).not.toHaveBeenCalled()
  const installed = (JSON.parse(index.capture().raw ?? "[]") as Array<{ path: string }>)[0]
  expect(installed).toBeDefined()
  const retained = createAuthoringSourceBundle(
    await Promise.all(
      source.files.map(async (file) => ({
        path: file.path,
        text: await readFile(join(installed.path, file.path), "utf8")
      }))
    )
  )
  expect(retained.digest).toBe(source.digest)
  expect(retained.files).toEqual(source.files)
  const compiled = await compileFunctionPlugin(installed.path)
  expect(compiled.sources.some((path) => /^(?:modules|workflows)\//.test(path))).toBe(false)
  const metadata = readPluginManifest(installed.path)!.manifest
  expect(getPluginSkillSearchSources(installed.path, metadata)).toEqual([])
  expect(metadata.hooks).toBeUndefined()
  expect(metadata.mcpServers).toBeUndefined()
}, 45_000)
