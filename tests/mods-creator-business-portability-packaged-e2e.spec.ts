/** A04 supplemental proof: exact 09 export, fresh home, original PRD/checks, native cancel.
 * Does not complete the eight-module/seven-node producer or replace original 09/B/Full10. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createRequire } from "node:module"
import type { ElectronApplication } from "playwright"
import type { ManagedRunEvent, ManagedRunSnapshot } from "../src/shared/harness-board-types"
import type { CompositionInternalProject } from "../src/main/harness-board/project-runtime/composition-internal-projects"
import type { StoredStageCheck } from "../src/main/harness-board/project-runtime/composition-stage-check-store"
import { readRuntimeScopedFile } from "../src/main/harness-board/project-runtime/safe-files"
import {
  capturePackageMetadataGuard,
  readPackageProtocolFiles
} from "../src/main/harness-board/project-runtime/package-snapshots"
import { captureThreadIncarnation } from "../src/main/services/thread-incarnation"
import { extensionContextStorageKey } from "../src/main/harness-board/extension-context"
import { compositionUnitConfigurationKey } from "../src/shared/project-runtime/composition-api"
import {
  canonicalStageCheckJson,
  parseStageCheckContracts,
  parseStageCheckReceipt,
  stageCheckArtifactAllowed
} from "../src/shared/project-runtime/stage-check-receipt"
import { isSameWorkspacePath } from "../src/shared/workspace-path"
import {
  compositionParentAdapter,
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { nativeManagedSessionDecisionSkill } from "./support/native-managed-session-decision"
import { creatorBusinessPortabilityModel } from "./support/creator-business-portability-model"

const root = resolve(__dirname, "..")
interface ReadOnlyArchiveEntry {
  readonly entryName: string
  readonly isDirectory: boolean
  getData(): Buffer
}
interface ReadOnlyArchive {
  getEntries(): ReadOnlyArchiveEntry[]
  readAsText(entry: string | ReadOnlyArchiveEntry): string
  readFile(entry: string | ReadOnlyArchiveEntry): Buffer | null
}
type ReadOnlyArchiveConstructor = new (bytes: Buffer) => ReadOnlyArchive
const archiveModule: unknown = createRequire(join(root, "package.json"))("adm-zip")
assert.equal(typeof archiveModule, "function", "Original installed ZIP reader constructor")
const AdmZip = archiveModule as ReadOnlyArchiveConstructor
const globalStartedAt = Date.now()
const required = (key: string) => {
  const value = process.env[key]?.trim()
  assert(value, `Explicit input required: ${key}`)
  return value
}
const digestInput = (key: string) => {
  const value = required(key)
  assert(/^[a-f0-9]{64}$/.test(value), `${key} must be a full SHA-256`)
  return value
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
assert(process.versions.node.startsWith("22."), "Use the repository Node 22 runtime")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Packaged execution only; no built fallback")
for (const key of [
  "CREATOR_E2E_BUILT_PREVIEW",
  "CREATOR_E2E_SHORT",
  "PROJECT_MAIN_IO_DIAGNOSTIC",
  "PROJECT_RECOVERY_DIAGNOSTICS"
])
  assert(!process.env[key], `No diagnostic/short mode: ${key}`)
const expectedAsar = digestInput("CREATOR_E2E_EXPECTED_SHA256")
const archive = resolve(required("A04_EXPORTED_ZIP"))
const expectedZip = digestInput("A04_EXPORTED_ZIP_SHA256")
const exportReceiptPath = resolve(required("A04_EXPORT_RECEIPT"))
const expectedExportReceipt = digestInput("A04_EXPORT_RECEIPT_SHA256")
const expectedExportSource = digestInput("A04_EXPORT_SOURCE_DIGEST")
const exportReceiptBytes = readFileSync(exportReceiptPath)
assert.equal(hash(exportReceiptBytes), expectedExportReceipt)
const exportReceipt = JSON.parse(exportReceiptBytes.toString("utf8")) as {
  passed: boolean
  package: string
  digest: string
  freshEnvironment: string
  installedId: string
  freshInstallId: string
  nativeExportConfirmations: number
  originalSourceUnchanged: boolean
  candidate: { execution: string; sha256: string }
}
assert.equal(exportReceipt.passed, true)
assert.equal(exportReceipt.nativeExportConfirmations, 1)
assert.equal(exportReceipt.originalSourceUnchanged, true)
assert.equal(exportReceipt.candidate.execution, "packaged-asar")
assert.equal(exportReceipt.digest, expectedExportSource)
const archiveBytes = readFileSync(archive)
assert.equal(hash(archiveBytes), expectedZip)
// Runtime intake binds the actual old export's exact raw ZIP, even if this input was moved.
assert.equal(hash(readFileSync(exportReceipt.package)), expectedZip)
const zip = new AdmZip(archiveBytes)
const metadata = JSON.parse(zip.readAsText("plugin.json")) as {
  name: string
  version: string
  hookPath?: string
}
assert.equal(metadata.name, required("A04_EXPORTED_PLUGIN_NAME"))
assert.equal(metadata.version, required("A04_EXPORTED_PLUGIN_VERSION"))
const envelope = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
assert.equal(envelope.apiVersion, "devclaw.project-runtime/v2")
assert.equal(envelope.runtime.mode, "legacy")
assert.equal(envelope.extensionContract.context.knowledge.required, true)
assert.equal(envelope.extensionContract.context.knowledge.binding, "knowledgeRoot")
const rawBoardBytes = zip.readFile("board_core/board_config.json")
assert(rawBoardBytes, "原包必须具备board配置")
const boardBytes: Buffer = rawBoardBytes
const board = JSON.parse(boardBytes.toString("utf8"))
assert.equal(board.workflow.nodes.length, 7, "All original runtime nodes, no stage subset")
assert.deepEqual(
  board.workflow.nodes.map((node: { id: string }) => node.id),
  ["biz.prd", "dev.specs", "dev.design", "dev.plan", "dev.code", "ops.cicd", "ops.archive"]
)
const assembly = JSON.parse(zip.readAsText("devclaw.business-assembly.json"))
assert.deepEqual(
  assembly.mods.map((item: { id: string }) => item.id),
  [
    "biz.prd",
    "dev.specs",
    "dev.design",
    "dev.plan",
    "dev.detail_design",
    "dev.code",
    "ops.cicd",
    "ops.archive"
  ]
)
assert.deepEqual(JSON.parse(zip.readAsText("devclaw.stage-checks.json")), {
  apiVersion: "devclaw.stage-check-adapter/v1",
  adapter: "autobiz-v1"
})
const fixture = projectCompositionEnvironment(root)
assert(!isSameWorkspacePath(fixture.isolated, exportReceipt.freshEnvironment))
assert(!isSameWorkspacePath(fixture.isolated, dirname(exportReceipt.package)))
fixture.env.GIT_BASH_PATH = realpathSync(required("GIT_BASH_PATH"))
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, "packaged-asar")
assert.equal(candidate.sha256, expectedAsar)
const evidence: Record<string, unknown> = {
  passed: false,
  partialProducerOnly: true,
  wholeProducerCompleted: false,
  controlledModel: true,
  controlledEnterpriseMetadata: true,
  enterpriseMetadataScope:
    "Only the original collector's buildEngineName preflight response is controlled; exact ZIP provider/render/collector, native KB binding and original validators/checkpoints/receipts are not replaced. This is not enterprise service connectivity acceptance.",
  businessAcceptance: "needs_review",
  productionAcceptance: "not_evaluated",
  candidate,
  exactZip: { archive, sha256: expectedZip, metadata },
  origin: {
    receipt: exportReceiptPath,
    receiptSha256: expectedExportReceipt,
    exporterAsar: exportReceipt.candidate.sha256,
    nativeReviewDigest: expectedExportSource,
    nativeReviewDigestIsRawZipSha: false
  },
  freshEnvironment: fixture.isolated,
  budgets: {
    watchdogMs: 240000,
    prdMs: 90000,
    cancelMs: 60000,
    prdBasis: "Date.now immediately before actual public startPrepared; never first HTTP"
  },
  oracle:
    "Test-only readonly SELECT, original parsers, original scoped artifact reads; no store construction or receipt writes"
}
const save = (name: string, value: unknown) =>
  writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))
const within = (directory: string, path: string) => {
  const child = relative(realpathSync(directory), realpathSync(path))
  assert(
    child &&
      !isAbsolute(child) &&
      child !== ".." &&
      !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
}
const pause = () => new Promise<void>((done) => setTimeout(done, 100))
const knowledge = join(fixture.isolated, "knowledge")
const knowledgeFile = join(knowledge, "A04/rules.md")
const rule =
  "A04_EXACT_EXPORT_KNOWLEDGE: backend_only; integer sample; business needs_review; production not_evaluated."
mkdirSync(join(knowledge, "A04"), { recursive: true })
writeFileSync(
  join(knowledge, "agents.manifest.json"),
  JSON.stringify({
    schemaVersion: "v1",
    systems: [
      {
        systemId: "A04",
        systemName: "Portability sample",
        agentsPath: "A04/AGENTS.md",
        deployUnits: [{ deployUnitId: "A04.LOCAL", description: "A04_EXACT_EXPORT_KNOWLEDGE" }]
      }
    ]
  })
)
writeFileSync(join(knowledge, "A04/AGENTS.md"), `# Local rules\n${rule}\n`)
writeFileSync(
  knowledgeFile,
  `---\ntitle: Exact export\ntype: Product Knowledge\ndeploy_unit: A04.LOCAL\ndescription: A04_EXACT_EXPORT_KNOWLEDGE\n---\n${rule}\n`
)
const model = creatorBusinessPortabilityModel({ knowledgeFile, knowledgeRule: rule })
// Reuse the A12 metadata transport shape, not enterprise credentials or a business runner.
const network = join(fixture.isolated, "metadata-fixture.cjs")
writeFileSync(
  network,
  `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
const original=http.request;http.request=(options,callback)=>{const host=typeof options==="string"?new URL(options).hostname:options.hostname;
if(host==="archguardservice.paas.cmbchina.cn"){require("node:fs").appendFileSync(require("node:path").join(__dirname,"metadata-requests.jsonl"),JSON.stringify({pid:process.pid,host,path:options.path})+"\\n");const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request}
if(!["127.0.0.1","localhost"].includes(host))throw Error("A04_EXTERNAL_HTTP_BLOCKED");return original(options,callback)};`
)
fixture.env.NODE_OPTIONS = `--require "${network.replaceAll("\\", "/")}"`
let app: ElectronApplication | undefined
let watchdogExpired = false
const approvals: unknown[] = []
const sessions = new Map<
  string,
  { nodeId: string; skill: string; engineRunId: string; incarnationKey?: string; terminal: boolean }
>()

async function main() {
  await new Promise<void>((done) => model.server.listen(0, "127.0.0.1", done))
  const address = model.server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(
    () => {
      watchdogExpired = true
      void app?.close().catch(() => {})
    },
    Math.max(1, 240000 - (Date.now() - globalStartedAt))
  )
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    const currentApp = app
    const launch = JSON.parse(readFileSync(join(fixture.isolated, "packaged-launch.json"), "utf8"))
    assert.equal(launch.packaged, true)
    assert.equal(launch.sha256, expectedAsar)
    assert.equal(realpathSync(launch.path), realpathSync(candidate.path))
    assert.equal(
      realpathSync(launch.executable),
      realpathSync(join(resolve(process.env.COMPOSITION_E2E_PACKAGED_DIR!), "CMBDevClaw.exe"))
    )
    evidence.actualPackagedLaunch = launch
    app
      .process()
      .stdout?.on("data", (part) => appendFileSync(join(fixture.isolated, "main.stdout.log"), part))
    app
      .process()
      .stderr?.on("data", (part) => appendFileSync(join(fixture.isolated, "main.stderr.log"), part))
    await app.evaluate((_electron, modulePath) => {
      process.env.NODE_OPTIONS = `--require "${modulePath.replaceAll("\\", "/")}"`
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        )
        if (!["127.0.0.1", "localhost"].includes(url.hostname))
          throw Error("A04_EXTERNAL_NETWORK_BLOCKED")
        return original(input, init)
      }
    }, network)
    const page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.projectComposition?.prepare))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    const scope = await page.evaluate(
      async ({ archives, workspace, url }) => {
        for (const bytes of archives) {
          const installed = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "native-portability.zip",
            "local"
          )
          if (!installed.success) throw Error(installed.error)
        }
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.sandbox.setYoloMode(false)
        await window.api.mods.configureGlobal(true)
        await window.api.hooks.logging.save({ enabled: true, diagnostic: false })
        await window.api.models.setCustomConfig({
          id: "a04-portability",
          name: "A04 exact export",
          baseUrl: url,
          model: "a04-portability",
          apiKey: "isolated-fixture",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:a04-portability")
        const parent = (await window.api.plugins.list()).find(
          (item) => item.name === "composition-parent-fixture"
        )
        if (!parent) throw Error("Native parent adapter missing")
        const project = await window.api.harnessBoard.createProject({
          adapterId: parent.id,
          adapterType: "plugin",
          name: "Exact export portability",
          projectCode: "A04PORTABLE",
          projectFromLean: false,
          projectDir: "composition-parent",
          description: "Controlled PRD only",
          systemId: "A04",
          systemName: "Portability sample",
          workspacePath: workspace
        })
        const thread = await window.api.threads.create({
          title: "Exact export native composition",
          workspacePath: workspace,
          agentMode: "normal",
          harnessProjectSession: { projectId: project.projectId, kind: "knowledge" }
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return {
          projectId: project.projectId,
          threadId: thread.thread_id,
          expectedWorkspace: workspace
        }
      },
      {
        archives: [compositionParentAdapter(process.execPath), [...archiveBytes]],
        workspace: fixture.workspace,
        url: `http://127.0.0.1:${address.port}/v1`
      }
    )
    const installed = await page.evaluate(() => window.api.plugins.list())
    const plugin = installed.find(
      (item) => item.name === metadata.name && item.version === metadata.version
    )
    assert(plugin)
    assert(exportReceipt.installedId && exportReceipt.freshInstallId)
    assert.notEqual(plugin.id, exportReceipt.installedId)
    assert.notEqual(plugin.id, exportReceipt.freshInstallId)
    const catalog = await page.evaluate(
      (scope) => window.api.projectComposition.catalog(scope),
      scope
    )
    const producer = catalog.entries.find(
      (item) =>
        item.sourceName === metadata.name &&
        item.source.capabilityId === "project-flow" &&
        item.source.pluginId === plugin.id
    )
    assert(producer?.available, JSON.stringify(producer))
    const preview = await page.evaluate(
      ({ scope, revision, producer }) =>
        window.api.projectComposition.preview({
          scope,
          catalogRevision: revision,
          definition: {
            apiVersion: "devclaw.project-composition/v1",
            parentProjectId: scope.projectId,
            workspace: scope.expectedWorkspace,
            goal: "Use the rebound A04.LOCAL knowledge. Author controlled backend_only PRD inputs via the original tools; retain all original stages/checks. The user will cancel after PRD receipts. Business needs_review; production not_evaluated.",
            units: [
              {
                id: "producer",
                kind: "flow",
                source: producer.source,
                inputs: [],
                outputs: producer.outputs.map(({ id, path }) => ({ id, path }))
              }
            ]
          }
        }),
      { scope, revision: catalog.revision, producer }
    )
    assert.deepEqual(preview.issues, [])
    let prepared = await page.evaluate(
      ({ scope, previewId }) =>
        window.api.projectComposition.prepare({ scope, previewId, requestId: "a04-exact-export" }),
      { scope, previewId: preview.id }
    )
    assert.equal(prepared.configurationPending, true)
    assert.equal(model.requests.length, 0)
    let key = compositionUnitConfigurationKey({
      scope,
      runId: prepared.id,
      unitId: "producer",
      expectedVersion: prepared.version
    })
    const review = await page.evaluate(
      (key) => window.api.projectComposition.unitMods.read(key),
      key
    )
    assert(review.source?.pluginId && review.source.digest)
    assert.equal(review.source.pluginId, plugin.id)
    assert.equal(review.packageDigest, producer.source.packageDigest)
    assert(!existsSync(join(review.workspace, ".autobizdevops/state.json")))
    const blank = await page.evaluate(
      ({ key, id, workspace }) =>
        window.api.projectComposition.unitMods.config.userConfig(key, id, workspace),
      { key, id: plugin.id, workspace: review.workspace }
    )
    assert(
      !blank.fields.find((field) => field.key === "knowledgeRoot")?.value,
      "Fresh home must not inherit the exported machine binding"
    )
    await currentApp.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, knowledge)
    const saved = await page.evaluate(
      async ({ key, view }) => {
        const api = window.api.projectComposition.unitMods.config
        const picked = await api.pickUserConfigPath(key, view, "knowledgeRoot")
        if (!picked) throw Error("Explicit native directory choice required")
        return api.saveUserConfig(key, view, "knowledgeRoot", picked)
      },
      { key, view: blank }
    )
    assert.equal(
      saved.fields.find((field) => field.key === "knowledgeRoot")?.value,
      realpathSync(knowledge)
    )
    const storageKey = extensionContextStorageKey(
      metadata,
      boardBytes,
      envelope.extensionContract.context,
      realpathSync(knowledge)
    )
    const collector = join(
      fixture.env.CMB_COWORK_AGENT_HOME,
      "plugin-data",
      storageKey,
      "collector"
    )
    mkdirSync(collector, { recursive: true })
    const dependencies = resolve(root, "output/creator-context-fixture-deps/node_modules")
    assert(existsSync(join(dependencies, "gray-matter/index.js")))
    cpSync(dependencies, join(collector, "node_modules"), { recursive: true })
    const approved = await page.evaluate(
      ({ key, review }) =>
        window.api.projectComposition.unitMods.approve({
          projectId: key,
          projectVersion: review.projectVersion,
          packageDigest: review.packageDigest,
          compiledDigest: review.source!.digest
        }),
      { key, review }
    )
    assert.equal(approved.source?.state, "ready")
    assert.equal(approved.workspaceEnabled, true)
    const contextScope = {
      scope,
      runId: prepared.id,
      unitId: "producer",
      expectedVersion: prepared.version
    }
    const context = await page.evaluate(
      (input) => window.api.projectComposition.readUnitContext(input),
      contextScope
    )
    assert(context.supported && context.required && context.contextFingerprint)
    assert.deepEqual(context.selected, [])
    assert.deepEqual(context.candidates, ["A04.LOCAL"])
    const previousVersion = prepared.version
    prepared = await page.evaluate(
      (input) => window.api.projectComposition.saveUnitContext(input),
      {
        ...contextScope,
        deployUnitIds: ["A04.LOCAL"],
        contextFingerprint: context.contextFingerprint
      }
    )
    assert.equal(prepared.version, previousVersion + 1)
    key = compositionUnitConfigurationKey({ ...contextScope, expectedVersion: prepared.version })
    const confirmed = await page.evaluate(
      (key) => window.api.projectComposition.unitMods.read(key),
      key
    )
    assert.equal(confirmed.source?.state, "ready")
    assert.equal(confirmed.packageDigest, review.packageDigest)
    const packageRoot = realpathSync(
      join(
        fixture.env.CMB_COWORK_AGENT_HOME,
        "project-compositions/legacy-packages",
        confirmed.packageDigest,
        "package"
      )
    )
    within(fixture.env.CMB_COWORK_AGENT_HOME, packageRoot)
    const sourceProof = (path: string) => {
      const guard = capturePackageMetadataGuard(realpathSync(path))
      const before = readPackageProtocolFiles(realpathSync(path)).map((file) => ({
        path: file.path,
        digest: hash(file.bytes)
      }))
      guard()
      return {
        path: realpathSync(path),
        before,
        assertUnchanged() {
          guard()
          const after = readPackageProtocolFiles(realpathSync(path)).map((file) => ({
            path: file.path,
            digest: hash(file.bytes)
          }))
          guard()
          assert.deepEqual(after, before)
          return {
            path: realpathSync(path),
            files: before.length,
            contentInventoryDigest: hash(JSON.stringify(before)),
            metadataAndBytesUnchanged: true
          }
        }
      }
    }
    const retainedProof = sourceProof(packageRoot)
    const installedProof = sourceProof(plugin.path)
    model.bind({
      workspace: approved.workspace,
      source: packageRoot,
      feature: "composition-producer"
    })
    const projectId = `composition-legacy:${prepared.id}:producer`
    const featureId = "composition-producer"
    const privateRoot = join(fixture.env.CMB_COWORK_AGENT_HOME, "project-compositions")
    const journalRoot = join(approved.workspace, ".cmbdevclaw/managed-runs", featureId)
    await page.evaluate(() => {
      const observations: Array<{ threadId: string; data: Record<string, unknown> }> = []
      const nativeWindow = window as unknown as {
        a04NativeObservations: typeof observations
        a04NativeStarted: string[]
      }
      nativeWindow.a04NativeObservations = observations
      nativeWindow.a04NativeStarted = []
      window.api.agent.onManagedAutoSendStreamStart((start) => {
        if (nativeWindow.a04NativeStarted.length >= 32) throw Error("A04_ADMISSION_LIMIT")
        nativeWindow.a04NativeStarted.push(start.threadId)
        window.api.agent.observeManagedAutoSendStream(start.runId, (event) => {
          if (event.type !== "custom") return
          const data = event.data as Record<string, unknown>
          if (data?.type === "hook_executed" || data?.type === "harness_agentmd_load_status") {
            if (observations.length >= 512) throw Error("A04_OBSERVER_LIMIT")
            observations.push({ threadId: start.threadId, data })
          }
        })
      })
    })
    const loadInternal = (): CompositionInternalProject | undefined => {
      const path = join(privateRoot, "internal-projects.sqlite")
      if (!existsSync(path)) return undefined
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const row = db
          .prepare("SELECT digest,data FROM internal_projects WHERE id=?")
          .get(projectId) as { digest: string; data: string } | undefined
        if (!row) return undefined
        assert(Buffer.byteLength(row.data) <= 1024 * 1024)
        assert.equal(hash(row.data), row.digest)
        const value = JSON.parse(row.data) as CompositionInternalProject
        assert.equal(value.projectId, projectId)
        assert.equal(value.parentProjectId, scope.projectId)
        assert.equal(value.compositionRunId, prepared.id)
        assert.equal(value.unitId, "producer")
        assert.equal(value.featureId, featureId)
        assert.equal(value.plugin.id, plugin.id)
        assert.equal(value.packageDigest, confirmed.packageDigest)
        assert(isSameWorkspacePath(value.workspace, approved.workspace))
        assert(isSameWorkspacePath(value.plugin.path, packageRoot))
        return value
      } finally {
        db.close()
      }
    }
    const journals = ():
      | { snapshot: ManagedRunSnapshot; events: ManagedRunEvent[] }
      | undefined => {
      const internal = loadInternal()
      if (!internal?.engineRunId) return undefined
      assert(/^mr_[a-f0-9]{32}$/.test(internal.engineRunId))
      const path = join(journalRoot, internal.engineRunId, "events.ndjson")
      if (!existsSync(path)) return undefined
      within(approved.workspace, path)
      const bytes = readFileSync(path)
      assert(bytes.length < 1024 * 1024)
      if (!bytes.toString("utf8").endsWith("\n")) return undefined
      const events = bytes
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ManagedRunEvent)
      assert(events.every((event) => event.runId === internal.engineRunId))
      const snapshotBytes = readFileSync(join(journalRoot, internal.engineRunId, "run.json"))
      assert(snapshotBytes.length <= 1024 * 1024)
      const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as ManagedRunSnapshot
      assert.equal(snapshot.runId, internal.engineRunId)
      assert.equal(snapshot.projectId, projectId)
      assert.equal(snapshot.featureId, featureId)
      for (const event of events.filter((event) => event.type === "session_started")) {
        assert(event.targetThreadId && event.nodeId)
        const skill = nativeManagedSessionDecisionSkill(event, events)
        const old = sessions.get(event.targetThreadId)
        if (old) assert.equal(old.nodeId, event.nodeId)
        else
          sessions.set(event.targetThreadId, {
            nodeId: event.nodeId,
            skill,
            engineRunId: internal.engineRunId,
            terminal: false
          })
      }
      for (const event of events.filter((event) => event.type === "managed_agent_turn_ended")) {
        if (event.threadId && sessions.has(event.threadId))
          sessions.get(event.threadId)!.terminal = true
      }
      save("native-journal.json", { snapshot, events, rawSha256: hash(bytes) })
      return { snapshot, events }
    }
    const captureThreads = async () => {
      let allIdle = true
      const started = await page.evaluate(
        () => (window as unknown as { a04NativeStarted: string[] }).a04NativeStarted
      )
      const threadIds = new Set([...sessions.keys(), ...started])
      for (const threadId of threadIds) {
        const session = sessions.get(threadId)
        const thread = await page.evaluate((id) => window.api.threads.get(id), threadId)
        assert(thread, "Native session row must remain readable")
        assert.equal(
          thread.metadata?.harnessFeature &&
            (thread.metadata.harnessFeature as { projectId: string }).projectId,
          projectId
        )
        assert.equal((thread.metadata?.harnessFeature as { slug: string })?.slug, featureId)
        assert(isSameWorkspacePath(String(thread.metadata?.workspacePath), approved.workspace))
        const key = JSON.stringify(
          captureThreadIncarnation({
            created_at: new Date(thread.created_at).getTime(),
            metadata: JSON.stringify(thread.metadata)
          })
        )
        if (session?.incarnationKey) assert.equal(key, session.incarnationKey)
        else if (session) session.incarnationKey = key
        const previous = admittedIncarnations.get(threadId)
        if (previous) assert.equal(key, previous)
        else admittedIncarnations.set(threadId, key)
        if (thread.status === "busy") allIdle = false
      }
      return allIdle
    }
    const readPrdReceipts = (): StoredStageCheck[] | undefined => {
      const path = join(privateRoot, "stage-checks.sqlite")
      if (!existsSync(path)) return undefined
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const row = db
          .prepare("SELECT data FROM contracts WHERE run=? AND unit=?")
          .get(prepared.id, "producer") as { data: string } | undefined
        if (!row) return undefined
        assert(Buffer.byteLength(row.data) <= 256 * 1024)
        const contracts = parseStageCheckContracts(JSON.parse(row.data)).filter(
          (item) => item.nodeId === "biz.prd"
        )
        assert(
          contracts.length && contracts.some((item) => item.checkId === "biz-prd-validate"),
          "Original biz PRD validator contract is mandatory"
        )
        const rows = db
          .prepare("SELECT data FROM receipts WHERE run=? AND unit=? ORDER BY seq")
          .all(prepared.id, "producer") as Array<{ data: string }>
        assert(rows.length <= 256)
        assert(rows.reduce((sum, item) => sum + Buffer.byteLength(item.data), 0) <= 4 * 1024 * 1024)
        const receipts = rows
          .map((row) => {
            assert(Buffer.byteLength(row.data) <= 65536)
            return JSON.parse(row.data) as StoredStageCheck
          })
          .filter(
            (item) => item.receipt.nodeId === "biz.prd" && item.hookId === "host:project_checkpoint"
          )
        // This is the published host checkpoint's original receipt channel, not a plugin
        // Hook id. Plugin Hook execution is independently observed on the native stream.
        if (!model.checkpointResults.length) return undefined
        const transitions = model.checkpointResults.map((call) => {
          assert(["prd_done", "specs_in_progress"].includes(String(call.args.checkpoint)))
          const transitionId = hash(
            JSON.stringify([
              prepared.id,
              "producer",
              call.args.checkpoint,
              call.args.expectedStateDigest
            ])
          )
          const transition = db
            .prepare("SELECT status,data FROM transitions WHERE id=? AND run=? AND unit=?")
            .get(transitionId, prepared.id, "producer") as
            | { status: string; data: string | null }
            | undefined
          assert(transition?.data)
          assert.equal(transition.status, "committed")
          assert(Buffer.byteLength(transition.data) <= 256 * 1024)
          const settled = JSON.parse(transition.data) as {
            status: string
            stateDigest: string
            receipts: unknown[]
            message?: string
          }
          assert.equal(settled.status, "committed")
          assert(/^[a-f0-9]{64}$/.test(settled.stateDigest))
          assert(Array.isArray(settled.receipts))
          assert(settled.message === undefined || typeof settled.message === "string")
          // The published native tool intentionally excludes main-only receipt details.
          // Mirror its actual JSON projection, including omission of undefined message.
          const publicResult = JSON.parse(
            JSON.stringify({
              status: settled.status,
              stateDigest: settled.stateDigest,
              message: settled.message
            })
          ) as Record<string, unknown>
          assert.equal(canonicalStageCheckJson(publicResult), canonicalStageCheckJson(call.result))
          return { transitionId, checkpoint: call.args.checkpoint, skill: call.skill, settled }
        })
        for (const item of receipts) {
          const receipt = parseStageCheckReceipt(item.receipt)
          const contract = contracts.find(
            (value) =>
              value.checkId === receipt.checkId && value.contractDigest === receipt.contractDigest
          )
          assert(contract)
          assert.equal(item.runId, prepared.id)
          assert.equal(item.unitId, "producer")
          assert.equal(item.packageDigest, confirmed.packageDigest)
          const session = sessions.get(item.threadId)
          assert(session && session.incarnationKey)
          assert.equal(item.engineRunId, session.engineRunId)
          assert.equal(item.incarnationKey, session.incarnationKey)
          assert.equal(item.hookId, "host:project_checkpoint")
          const origin = transitions.find(
            (value) =>
              value.skill === session.skill &&
              value.settled.receipts.some(
                (value) =>
                  canonicalStageCheckJson(parseStageCheckReceipt(value)) ===
                  canonicalStageCheckJson(receipt)
              )
          )
          if (!origin) return undefined // The original result may not yet have reached its next HTTP.
          if (receipt.checkId === "biz-prd-validate") {
            assert.equal(origin.checkpoint, "specs_in_progress")
            assert.equal(session.skill, "autodev-specs")
            // Original session.nodeId attributes the decision source, potentially biz.prd.
            // Only its linked native decision's actual slashSkill identifies the executor.
          }
          assert(receipt.artifacts.length || contract.checkOnly)
          for (const artifact of receipt.artifacts) {
            assert(stageCheckArtifactAllowed(contract, artifact))
            const observed = readRuntimeScopedFile(realpathSync(approved.workspace), artifact.path)
            assert(observed.bytes)
            assert.equal(hash(observed.bytes), artifact.digest)
          }
        }
        if (
          !contracts.every((contract) =>
            receipts.some(
              (item) =>
                item.receipt.checkId === contract.checkId &&
                item.receipt.contractDigest === contract.contractDigest
            )
          )
        )
          return undefined
        const requiredArtifacts = board.workflow.nodes.find(
          (node: { id: string }) => node.id === "biz.prd"
        ).artifacts.outputs as Array<{
          id: string
          path: string
          required?: boolean
        }>
        for (const artifact of requiredArtifacts.filter((item) => item.required)) {
          const path = `.autobizdevops/features/${featureId}/${artifact.path}`
          assert(
            receipts.some((item) =>
              item.receipt.artifacts.some(
                (value) => value.id === artifact.id && value.path === path
              )
            ),
            `Original required PRD artifact lacks an actual matching receipt: ${artifact.id}`
          )
          assert(readRuntimeScopedFile(realpathSync(approved.workspace), path).bytes?.length)
        }
        save("prd-receipts.json", { contracts, receipts, transitions })
        return receipts
      } finally {
        db.close()
      }
    }
    const admittedIncarnations = new Map<string, string>()
    let cancelled = false
    const startedAt = Date.now()
    let latest = await page.evaluate(
      ({ scope, run }) =>
        window.api.projectComposition.startPrepared({
          scope,
          runId: run.id,
          expectedVersion: run.version
        }),
      { scope, run: prepared }
    )
    let verified: StoredStageCheck[] | undefined
    const allowed = new Set<string>()
    while (Date.now() - startedAt < 90000) {
      assert.deepEqual(model.errors, [])
      latest = await page.evaluate(
        ({ scope, runId }) => window.api.projectComposition.read({ scope, runId }),
        { scope, runId: prepared.id }
      )
      const journal = journals()
      await captureThreads()
      verified = readPrdReceipts()
      const prd = [...sessions.values()].find(
        (item) => item.skill === "autobiz-requirement-discuss"
      )
      if (verified && prd?.terminal && model.complete.has("checkpoint-prd_done")) break
      assert(
        !["failed", "unknown", "cancelled", "succeeded"].includes(latest.status),
        JSON.stringify(latest)
      )
      const pending = await page.evaluate(
        ({ scope, runId }) => window.api.projectComposition.readToolApprovals({ scope, runId }),
        { scope, runId: prepared.id }
      )
      for (const item of pending) {
        if (allowed.has(item.requestId)) continue
        assert(isSameWorkspacePath(item.cwd, approved.workspace))
        assert(
          item.command
            ? model.commands.has(item.command)
            : item.filePath && model.files.has(item.filePath),
          "Only exact controlled model tools are approved"
        )
        allowed.add(item.requestId)
        approvals.push(item)
        await page.evaluate(
          ({ scope, runId, item }) =>
            window.api.projectComposition.respondToolApproval({
              scope,
              runId,
              unitId: item.unitId,
              requestId: item.requestId,
              decision: "allow"
            }),
          { scope, runId: prepared.id, item }
        )
      }
      if (latest.status === "waiting-approval") {
        const gate = await page.evaluate(
          ({ scope, runId }) => window.api.projectComposition.waitingApproval({ scope, runId }),
          { scope, runId: prepared.id }
        )
        assert(gate?.kind === "legacy-human-gate")
        assert.equal(gate.unitId, "producer")
        approvals.push(gate)
        const confirmed = await page.evaluate(
          ({ scope, run, gate }) =>
            window.api.projectComposition.approve({
              scope,
              runId: run.id,
              unitId: gate.unitId,
              expectedVersion: run.version,
              kind: "legacy-human-gate",
              gateId: gate.gateId,
              decision: "approved"
            }),
          { scope, run: latest, gate }
        )
        await page.evaluate(
          ({ scope, run }) =>
            window.api.projectComposition.resume({
              scope,
              runId: run.id,
              expectedVersion: run.version
            }),
          { scope, run: confirmed }
        )
      }
      evidence.lastNativeStatus = journal?.snapshot.status
      await pause()
    }
    assert(Date.now() - startedAt < 90000, "Original 90 second PRD deadline")
    assert(verified?.length && model.complete.has("read-chosen-knowledge"))
    assert(
      [...sessions.values()].some(
        (item) => item.skill === "autobiz-requirement-discuss" && item.terminal
      )
    )
    const stateBytes = readFileSync(join(approved.workspace, ".autobizdevops/state.json"))
    const state = JSON.parse(stateBytes.toString("utf8"))
    assert(["prd_done", "specs_in_progress"].includes(state.features[featureId].checkpoint))
    evidence.prd = {
      elapsedMs: Date.now() - startedAt,
      stateDigest: hash(stateBytes),
      checkpointAtObservation: state.features[featureId].checkpoint,
      receiptCount: verified.length
    }
    const cancelAt = Date.now()
    const beforeCancel = journals()
    assert(beforeCancel)
    await captureThreads()
    const cancelledTarget = beforeCancel.snapshot.currentSession?.threadId
    const heldBeforeCancel = model.observation()
    if (heldBeforeCancel.held) {
      assert.equal(heldBeforeCancel.held, 1, "Single original producer, one actual held HTTP")
      assert(cancelledTarget && sessions.has(cancelledTarget))
      assert(
        heldBeforeCancel.heldSkills.includes(sessions.get(cancelledTarget)!.skill),
        "Held HTTP Skill must match the original exact cancellation target in this workspace"
      )
    }
    for (const threadId of admittedIncarnations.keys())
      assert(
        sessions.get(threadId)?.terminal || threadId === cancelledTarget,
        "An early admission outside the original cancel target requires reconciliation"
      )
    latest = await page.evaluate(
      ({ scope, runId }) => window.api.projectComposition.read({ scope, runId }),
      { scope, runId: prepared.id }
    )
    latest = await page.evaluate(
      ({ scope, run }) =>
        window.api.projectComposition.cancel({
          scope,
          runId: run.id,
          expectedVersion: run.version
        }),
      { scope, run: latest }
    )
    while (Date.now() - cancelAt < 60000) {
      const journal = journals()
      const allIdle = await captureThreads()
      for (const threadId of admittedIncarnations.keys())
        assert(
          sessions.get(threadId)?.terminal || threadId === cancelledTarget,
          "Cancellation must not silently miss a later admitted physical thread"
        )
      if (
        latest.status === "cancelled" &&
        journal?.snapshot.status === "cancelled" &&
        (!journal.snapshot.currentSession ||
          journal.snapshot.currentSession.threadId === cancelledTarget) &&
        journal.events.some((event) => event.type === "run_cancelled") &&
        allIdle &&
        model.observation().held === 0
      ) {
        cancelled = true
        assert(await captureThreads(), "All original captured threads remain idle")
        break
      }
      assert(!["failed", "unknown", "succeeded"].includes(latest.status), JSON.stringify(latest))
      await pause()
      latest = await page.evaluate(
        ({ scope, runId }) => window.api.projectComposition.read({ scope, runId }),
        { scope, runId: prepared.id }
      )
    }
    assert(
      cancelled && Date.now() - cancelAt < 60000,
      "Native cancelled journal, all captured exact threads idle, held HTTP closed before cleanup"
    )
    if (heldBeforeCancel.held)
      assert(
        model.observation().heldByNativeClose >= heldBeforeCancel.held,
        "Only original cancellation, not test cleanup, closed the actual in-flight response"
      )
    assert(
      readPrdReceipts()?.length,
      "After physical settlement the original PRD receipts still match actual bytes"
    )
    assert.deepEqual(model.errors, [])
    evidence.cancel = {
      elapsedMs: Date.now() - cancelAt,
      composition: latest,
      sessions: Object.fromEntries(sessions),
      model: model.observation(),
      cancelledTarget,
      admittedIncarnations: Object.fromEntries(admittedIncarnations),
      heldBeforeCancel,
      heldHttpActuallyCancelled: heldBeforeCancel.held > 0,
      cancelObservation:
        heldBeforeCancel.held > 0
          ? "actual in-flight next Skill HTTP closed by native cancel"
          : "no held HTTP observed; no claim of cancelling a held request",
      cleanupReleaseUsedForProof: false,
      physicalOracle:
        "Original production cancel checks its exact captured current agent is not busy; all earlier sessions have native turn-ended, all observed admissions keep exact row identity and nonbusy status, original held HTTP closes before cleanup"
    }
    const metadataRequests = readFileSync(join(fixture.isolated, "metadata-requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{ host: string; path: string; pid: number }>
    assert(
      metadataRequests.length &&
        metadataRequests.every(
          (item) =>
            item.host === "archguardservice.paas.cmbchina.cn" &&
            item.path === "/cowork/get-analysis-info-v2?deployUnit=A04.LOCAL" &&
            Number.isInteger(item.pid)
        )
    )
    evidence.collector = metadataRequests
    const observations = await page.evaluate(
      () =>
        (
          window as unknown as {
            a04NativeObservations: Array<{
              threadId: string
              data: Record<string, unknown>
            }>
          }
        ).a04NativeObservations
    )
    const ownedObservations = observations.filter((item) => sessions.has(item.threadId))
    save("native-observations.json", ownedObservations)
    const hookRows = ownedObservations.filter(
      (item) =>
        item.data.type === "hook_executed" &&
        item.data.pluginId === plugin.id &&
        item.data.kind === "executed" &&
        item.data.exitCode === 0
    )
    assert(hookRows.some((item) => item.data.event === "PreToolUse"))
    assert(hookRows.some((item) => item.data.event === "PostToolUse"))
    const knowledgeLoads = ownedObservations.filter(
      (item) => item.data.type === "harness_agentmd_load_status"
    )
    assert(
      knowledgeLoads.some(
        (item) =>
          Array.isArray(item.data.agentmdLoadStatus) &&
          (
            item.data.agentmdLoadStatus as Array<{
              deployUnitId: string
              loaded: boolean
              source: string
              path: string
            }>
          ).some(
            (load) =>
              load.deployUnitId === "A04.LOCAL" &&
              load.loaded &&
              load.source === "remote" &&
              isSameWorkspacePath(load.path, knowledge)
          )
      )
    )
    evidence.nativeBindings = {
      scope,
      pluginId: plugin.id,
      packageDigest: confirmed.packageDigest,
      compiledDigest: confirmed.source!.digest,
      workspace: approved.workspace,
      source: packageRoot,
      selectedKnowledgeRoot: realpathSync(knowledge),
      selectedContext: prepared.unitContexts
    }
    evidence.sourceImmutability = {
      installed: installedProof.assertUnchanged(),
      retained: retainedProof.assertUnchanged()
    }
    assert(!watchdogExpired)
    assert.equal(hash(readFileSync(archive)), expectedZip)
    assert.equal(hash(readFileSync(exportReceiptPath)), expectedExportReceipt)
    assert.equal(projectCompositionCandidate(root).sha256, expectedAsar)
    evidence.businessProofPassedBeforeClose = true
  } catch (error) {
    evidence.failure = String(error)
    throw error
  } finally {
    // Cleanup must never turn a missing native terminal/physical proof into a passed result.
    evidence.modelBeforeCleanup = model.observation()
    evidence.watchdogExpired = watchdogExpired
    save("model-requests.json", model.requests)
    save("model-proof.json", {
      completedSteps: [...model.complete],
      actualCheckpointResults: model.checkpointResults,
      knowledgeRuleDigest: hash(rule)
    })
    try {
      await app?.close()
      assert.equal(hash(readFileSync(archive)), expectedZip)
      assert.equal(hash(readFileSync(exportReceiptPath)), expectedExportReceipt)
      assert.equal(projectCompositionCandidate(root).sha256, expectedAsar)
      assert(!watchdogExpired)
      evidence.naturalAppClosed = true
    } catch (error) {
      evidence.passed = false
      evidence.closeOrPostflightError = String(error)
      process.exitCode = 1
    } finally {
      model.releaseHeldForCleanupOnly()
      model.server.closeAllConnections()
      await new Promise<void>((done) => model.server.close(() => done()))
      evidence.totalElapsedMs = Date.now() - globalStartedAt
      evidence.passed =
        evidence.businessProofPassedBeforeClose === true &&
        !evidence.failure &&
        !evidence.closeOrPostflightError &&
        !watchdogExpired &&
        Date.now() - globalStartedAt < 240000
      if (!evidence.passed) process.exitCode = 1
      clearTimeout(watchdog)
      save("evidence.json", { ...evidence, modelErrors: model.errors, approvals })
    }
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json") }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
