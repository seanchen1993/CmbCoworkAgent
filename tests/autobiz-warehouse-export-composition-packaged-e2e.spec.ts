/** Original five-stage warehouse -> host-verified bundle -> independent Guest JSON consumer.
 * Models are loopback-controlled; native configuration, grants, tools, checks and stores are real. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import type { ManagedRunEvent } from "../src/shared/harness-board-types"
import { extensionContextStorageKey } from "../src/main/harness-board/extension-context"
import { compositionUnitConfigurationKey } from "../src/shared/project-runtime/composition-api"
import { compositionParentAdapter, createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate, projectCompositionEnvironment } from "./support/project-composition-e2e-fixtures"
import { warehouseExportLoopback } from "./support/warehouse-export-loopback"
import { withProjectMainIoDiagnostic } from "./support/project-main-io-diagnostic"
import { nativeManagedSessionDecisionSkill } from "./support/native-managed-session-decision"
import { installNativeModFileApproval, nativeModFileApprovalDecision, nativeVerifiedReportText } from "./support/native-mod-file-approval"

const root = resolve(__dirname, ".."), fixture = projectCompositionEnvironment(root)
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const archive = resolve(process.env.AUTOBIZ_WAREHOUSE_ARCHIVE ??
  "output/deliveries/mods-verified-artifacts-20261017-v5/12-数仓可验证产物导出版.zip")
const bytes = readFileSync(archive), zip = new AdmZip(bytes)
const consumerArchive = resolve(process.env.VERIFIED_CONSUMER_ARCHIVE ??
  "output/deliveries/mods-verified-artifacts-20261017-v4-cc/13-通用JSON产物消费Mod.zip")
const consumerBytes = readFileSync(consumerArchive)
const metadata = JSON.parse(zip.readAsText("plugin.json"))
const envelope = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
assert.deepEqual(envelope.extensionContract.verifiedArtifacts.artifactIds,
  ["warehouse_sql_results", "warehouse_quality"])
const loopback = warehouseExportLoopback(), approvals: unknown[] = []
const evidence: Record<string, unknown> = { passed: false, candidate, archive, archiveSha256: hash(bytes),
  consumerArchive, consumerArchiveSha256: hash(consumerBytes),
  budgets: { nativeSessionMs: 90000, skillHttpMs: 90000, totalLoopMs: 6 * 90000,
    nativeSessionBasis: "Original durable session_started to managed_agent_turn_ended timestamps; excludes earlier thread/context construction and does not claim whole-node prelude coverage" },
  scope: "Original producer checks and exact bytes reach an independently approved Guest consumer; business acceptance remains needs_review." }
const knowledge = join(fixture.isolated, "knowledge")
mkdirSync(join(knowledge, "DW"), { recursive: true })
const rule = "A12_KNOWLEDGE_RULE: explicitly authorized CNY integer cents; local five orders; businessAcceptance needs_review."
writeFileSync(join(knowledge, "agents.manifest.json"), JSON.stringify({ schemaVersion: "v1", systems: [{
  systemId: "DW", systemName: "Order warehouse", agentsPath: "DW/AGENTS.md",
  deployUnits: [{ deployUnitId: "DW.ORDER", description: "Local CNY sample" }]
}] }))
writeFileSync(join(knowledge, "DW/AGENTS.md"), `# Warehouse rules\n${rule}\n`)
writeFileSync(join(knowledge, "DW/orders.md"), `---\ntitle: Orders\ntype: Product Knowledge\ndeploy_unit: DW.ORDER\ndescription: A12_KNOWLEDGE_RULE\n---\n${rule}\n`)
// The original enterprise metadata fixture is controlled, never an external network connection.
const network = join(fixture.isolated, "network-fixture.cjs")
writeFileSync(network, `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
const original=http.request;http.request=(options,callback)=>{const host=typeof options==="string"?new URL(options).hostname:options.hostname;
if(host==="archguardservice.paas.cmbchina.cn"){require("node:fs").appendFileSync(require("node:path").join(__dirname,"metadata-requests.jsonl"),JSON.stringify({pid:process.pid,host,path:options.path})+"\\n");const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request}
if(!["127.0.0.1","localhost"].includes(host))throw Error("A12_EXTERNAL_HTTP_BLOCKED");return original(options,callback)};`)
fixture.env.NODE_OPTIONS = `--require "${network.replaceAll("\\", "/")}"`
let app: ElectronApplication | undefined
let nativeFileApprovals: unknown[] = []
const save = (name: string, value: unknown) => writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2))

async function main() {
  await new Promise<void>(done => loopback.server.listen(0, "127.0.0.1", done))
  const address = loopback.server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 900000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app.process().stdout?.on("data", chunk => appendFileSync(join(fixture.isolated, "main.stdout.log"), chunk))
    app.process().stderr?.on("data", chunk => appendFileSync(join(fixture.isolated, "main.stderr.log"), chunk))
    const currentApp = app
    await withProjectMainIoDiagnostic(currentApp, fixture.isolated, async () => {
    await currentApp.evaluate((_electron, fixtureModule) => {
      // Playwright deliberately removes launch NODE_OPTIONS. Bind only the controlled
      // metadata transport for subsequently spawned original Python -> Node collectors.
      process.env.NODE_OPTIONS = `--require "${fixtureModule.replaceAll("\\", "/")}"`
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw Error("A12_EXTERNAL_NETWORK_BLOCKED")
        return original(input, init)
      }
    }, network)
    const page = await currentApp.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.projectComposition?.prepare))
    await page.evaluate(() => { (window as unknown as { __name: unknown }).__name = (value: unknown) => value })
    const scope = await page.evaluate(async ({ archives, workspace, url }) => {
      for (const bytes of archives) {
        const installed = await window.api.plugins.install(new Uint8Array(bytes).buffer, "native-local.zip", "local")
        if (!installed.success) throw Error(installed.error)
      }
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.sandbox.setYoloMode(false)
      await window.api.mods.configureGlobal(true)
      await window.api.hooks.logging.save({ enabled: true, diagnostic: true })
      await window.api.models.setCustomConfig({ id: "warehouse-export", name: "Actual warehouse export",
        baseUrl: url, model: "warehouse-export", apiKey: "isolated-fixture", maxTokens: 64000, maxOutputTokens: 4096 })
      await window.api.models.setDefault("custom:warehouse-export")
      const parent = (await window.api.plugins.list()).find(item => item.name === "composition-parent-fixture")!
      const project = await window.api.harnessBoard.createProject({ adapterId: parent.id, adapterType: "plugin",
        name: "Warehouse handoff", projectCode: "WAREHOUSEEXPORT", projectFromLean: false,
        projectDir: "composition-parent", description: "Explicit local CNY sample",
        systemId: "DW", systemName: "Order warehouse", workspacePath: workspace })
      const thread = await window.api.threads.create({ title: "Native composed warehouse", workspacePath: workspace,
        agentMode: "normal", harnessProjectSession: { projectId: project.projectId, kind: "knowledge" } })
      await window.api.workspace.set(thread.thread_id, workspace)
      return { projectId: project.projectId, threadId: thread.thread_id, expectedWorkspace: workspace }
    }, { archives: [compositionParentAdapter(process.execPath), [...bytes], [...consumerBytes]],
      workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1` })
    const catalog = await page.evaluate(scope => window.api.projectComposition.catalog(scope), scope)
    const hookLogDir = await page.evaluate(() => window.api.hooks.logging.getLogDir())
    save("catalog.json", catalog)
    const producer = catalog.entries.find(item => item.sourceName === metadata.name && item.source.capabilityId === "project-flow")
    const consumer = catalog.entries.find(item => item.sourceName === "verified-artifact-consumer")
    assert(producer?.available, JSON.stringify(producer))
    assert(consumer?.available, JSON.stringify(consumer))
    assert.deepEqual(producer.outputs.map(item => item.id), ["verified-context"])
    const preview = await page.evaluate(({ scope, catalog, producer, consumer }) => window.api.projectComposition.preview({
      scope, catalogRevision: catalog.revision, definition: {
        apiVersion: "devclaw.project-composition/v1", parentProjectId: scope.projectId,
        workspace: scope.expectedWorkspace, goal: "Explicit local CNY five-order data only; original checks and native chosen knowledge; business review remains required. VERIFIED_REQUIRED_IDS=[\"warehouse_sql_results\",\"warehouse_quality\"].",
        units: [
          { id: "warehouse", kind: "flow", source: producer.source, inputs: [], outputs: producer.outputs.map(({ id, path }) => ({ id, path })) },
          { id: "consumer", kind: "flow", source: consumer.source,
            inputs: [{ inputId: "context", fromUnitId: "warehouse", artifactId: "verified-context" }],
            outputs: consumer.outputs.map(({ id, path }) => ({ id, path })) }
        ]
      }
    }), { scope, catalog, producer, consumer })
    assert.deepEqual(preview.issues, [])
    let prepared = await page.evaluate(({ scope, previewId }) => window.api.projectComposition.prepare({
      scope, previewId, requestId: "warehouse-export-configured"
    }), { scope, previewId: preview.id })
    assert.equal(prepared.configurationPending, true)
    assert.equal(loopback.requests.length, 0, "Prepare must not start a model or Hook")
    const reviews: unknown[] = []
    let nativeProducerWorkspace = ""
    let nativeConsumerWorkspace = ""
    for (const unitId of ["warehouse", "consumer"]) {
      const key = compositionUnitConfigurationKey({ scope, runId: prepared.id, unitId, expectedVersion: prepared.version })
      const review = await page.evaluate(key => window.api.projectComposition.unitMods.read(key), key)
      assert(review.source?.pluginId && review.source.digest)
      if (unitId === "warehouse") {
        assert(!existsSync(join(review.workspace, ".autobizdevops/state.json")), "No business initialization before native config confirmation")
        await currentApp.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
        }, knowledge)
        const saved = await page.evaluate(async ({ key, pluginId, workspace }) => {
          const api = window.api.projectComposition.unitMods.config
          const view = await api.userConfig(key, pluginId, workspace)
          const picked = await api.pickUserConfigPath(key, view, "knowledgeRoot")
          if (!picked) throw Error("Native picker cancelled")
          return api.saveUserConfig(key, view, "knowledgeRoot", picked)
        }, { key, pluginId: review.source.pluginId, workspace: review.workspace })
        assert.equal(saved.fields.find(field => field.key === "knowledgeRoot")?.value, realpathSync(knowledge))
        // Original local collector dependencies only. Knowledge is loaded from the native chosen directory.
        const storageKey = extensionContextStorageKey(metadata, zip.readFile("board_core/board_config.json")!,
          envelope.extensionContract.context, realpathSync(knowledge))
        const collector = join(fixture.env.CMB_COWORK_AGENT_HOME, "plugin-data", storageKey, "collector")
        mkdirSync(collector, { recursive: true })
        const dependencies = resolve("output/creator-context-fixture-deps/node_modules")
        assert(existsSync(join(dependencies, "gray-matter/index.js")))
        cpSync(dependencies, join(collector, "node_modules"), { recursive: true })
        evidence.nativeKnowledgeConfiguration = saved
      }
      const approved = await page.evaluate(({ key, review }) => window.api.projectComposition.unitMods.approve({
        projectId: key, projectVersion: review.projectVersion, packageDigest: review.packageDigest,
        compiledDigest: review.source!.digest
      }), { key, review })
      assert.equal(approved.source?.state, "ready")
      assert.equal(approved.workspaceEnabled, true)
      if (unitId === "warehouse") nativeProducerWorkspace = approved.workspace
      else {
        assert.equal(approved.source?.name, "verified-artifact-consumer")
        nativeConsumerWorkspace = approved.workspace
      }
      reviews.push(approved)
    }
    evidence.nativeUnitReviews = reviews
    const contextScope = { scope, runId: prepared.id, unitId: "warehouse", expectedVersion: prepared.version }
    const options = await page.evaluate(input => window.api.projectComposition.readUnitContext(input), contextScope)
    assert.equal(options.supported, true)
    assert.equal(options.required, true)
    assert.deepEqual(options.candidates, ["DW.ORDER"], "Candidates must come from the actual native chosen knowledge, not the original package defaults")
    assert.deepEqual(options.selected, [])
    assert(options.contextFingerprint)
    const previousVersion = prepared.version
    prepared = await page.evaluate(input => window.api.projectComposition.saveUnitContext(input), {
      ...contextScope, deployUnitIds: ["DW.ORDER"], contextFingerprint: options.contextFingerprint
    })
    assert.equal(prepared.version, previousVersion + 1)
    assert.equal(prepared.configurationPending, true)
    assert.deepEqual(prepared.unitContexts?.warehouse?.deployUnitIds, ["DW.ORDER"])
    assert.equal(loopback.requests.length, 0, "Native context confirmation must not start the business model")
    evidence.nativeUnitContext = { options, selection: prepared.unitContexts?.warehouse }
    const confirmedReviews: unknown[] = []
    for (const unitId of ["warehouse", "consumer"]) {
      const input = { scope, runId: prepared.id, unitId, expectedVersion: prepared.version }
      const key = compositionUnitConfigurationKey(input)
      const review = await page.evaluate(key => window.api.projectComposition.unitMods.read(key), key)
      assert.equal(review.source?.state, "ready", "The same explicit source grant must remain valid after the native run CAS")
      assert.equal(review.workspaceEnabled, true)
      const confirmed = await page.evaluate(input => window.api.projectComposition.readUnitContext(input), input)
      if (unitId === "warehouse") assert.deepEqual(confirmed.selected, ["DW.ORDER"])
      else assert.equal(confirmed.supported, false)
      confirmedReviews.push({ unitId, review, context: confirmed })
    }
    evidence.confirmedNativeUnits = confirmedReviews
    const nativeOwnerId = await (await currentApp.browserWindow(page)).evaluate(owner => owner.id)
    await currentApp.evaluate(installNativeModFileApproval, { ownerId: nativeOwnerId, producerWorkspace: nativeProducerWorkspace,
      consumerWorkspace: nativeConsumerWorkspace, validator: nativeModFileApprovalDecision.toString(),
      projector: nativeVerifiedReportText.toString() })
    const nativeProjectId = `composition-legacy:${prepared.id}:warehouse`
    await page.evaluate(projectId => {
      const state = window as unknown as { __a12NativeRunIds: string[] }
      state.__a12NativeRunIds = []
      window.api.harnessBoard.onManagedRunChanged(event => {
        if (event.projectId === projectId && event.featureId === "composition-warehouse")
          state.__a12NativeRunIds.push(event.run.runId)
      })
    }, nativeProjectId)
    const nativeSessions = new Map<string, { nodeId: string; slashSkill: string;
      decisionEventId: string; startedAt: number; endedAt?: number }>()
    const nativeJournals = new Map<string, { path: string; digest: string; count: number }>()
    const pendingNativeRuns = new Set<string>()
    const privatePath = relative(realpathSync(fixture.env.CMB_COWORK_AGENT_HOME), realpathSync(nativeProducerWorkspace))
    assert(privatePath && !isAbsolute(privatePath) && !privatePath.startsWith(".."),
      "Audit reads must stay within this fixture's original native private workspace")
    const nativeEventTime = (event: ManagedRunEvent) => {
      assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(event.createTime))
      return Date.parse(event.createTime.replace(" ", "T") + "+08:00")
    }
    let latest = await page.evaluate(({ scope, run }) => window.api.projectComposition.startPrepared({
      scope, runId: run.id, expectedVersion: run.version
    }), { scope, run: prepared })
    const approved = new Set<string>(), deadline = Date.now() + 6 * 90000
    while (Date.now() < deadline) {
      assert.deepEqual(loopback.errors, [])
      latest = await page.evaluate(({ scope, runId }) => window.api.projectComposition.read({ scope, runId }), { scope, runId: prepared.id })
      save("composition-run.json", latest)
      const changedRuns = await page.evaluate(() => (window as unknown as {
        __a12NativeRunIds: string[]
      }).__a12NativeRunIds.splice(0))
      for (const runId of changedRuns) pendingNativeRuns.add(runId)
      for (const runId of pendingNativeRuns) {
        assert(/^mr_[a-f0-9]{32}$/.test(runId), "Only an actual original native run identifier is accepted")
        const journalPath = join(nativeProducerWorkspace, ".cmbdevclaw/managed-runs/composition-warehouse", runId, "events.ndjson")
        if (!existsSync(journalPath)) continue
        const auditRelative = relative(realpathSync(nativeProducerWorkspace), realpathSync(journalPath))
        assert(auditRelative && !isAbsolute(auditRelative) && !auditRelative.startsWith(".."))
        // Read-only test audit. Do not instantiate a store, acquire authority or repair a journal.
        const journal = readFileSync(journalPath)
        assert(journal.byteLength < 1024 * 1024, "Original audit journal exceeded the bounded fixture budget")
        if (!journal.toString("utf8").endsWith("\n")) continue // An in-progress final append is retried.
        const events = journal.toString("utf8").split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as ManagedRunEvent)
        assert(events.length && events.every(event => event.runId === runId))
        nativeJournals.set(runId, { path: journalPath, digest: hash(journal), count: events.length })
        pendingNativeRuns.delete(runId)
        for (const event of events.filter(event => event.type === "session_started")) {
          assert(event.targetThreadId && event.nodeId)
          const slashSkill = nativeManagedSessionDecisionSkill(event, events)
          if (!nativeSessions.has(event.targetThreadId)) nativeSessions.set(event.targetThreadId,
            { nodeId: event.nodeId, slashSkill, decisionEventId: event.decisionEventId!,
              startedAt: nativeEventTime(event) })
        }
        for (const event of events.filter(event => event.type === "managed_agent_turn_ended")) {
          const session = event.threadId && nativeSessions.get(event.threadId)
          if (session) session.endedAt = nativeEventTime(event)
        }
      }
      evidence.nativeStageBudgets = Object.fromEntries(nativeSessions)
      evidence.nativeJournalAudit = Object.fromEntries(nativeJournals)
      for (const session of nativeSessions.values()) assert(
        (session.endedAt ?? Date.now()) - session.startedAt < 90000,
        `Original session_started-to-terminal window exceeded 90 seconds: ${session.nodeId}`
      )
      const stderrPath = join(fixture.isolated, "main.stderr.log")
      if (existsSync(stderrPath)) assert(!/REQUIRED_BUSINESS_CHECK_MISSING|HARNESS_REQUIRED_CONTEXT_UNAVAILABLE/.test(readFileSync(stderrPath, "utf8")),
        "Original runtime lacks required Hook/context; preserve actual failed admission instead of retrying")
      if (["succeeded", "failed", "unknown", "cancelled"].includes(latest.status)) break
      const pending = await page.evaluate(({ scope, runId }) => window.api.projectComposition.readToolApprovals({ scope, runId }), { scope, runId: prepared.id })
      for (const item of pending) {
        if (approved.has(item.requestId)) continue
        assert(item.command ? loopback.commands.has(item.command) : item.filePath && loopback.files.has(item.filePath), JSON.stringify(item))
        approved.add(item.requestId)
        approvals.push(item)
        await page.evaluate(({ scope, runId, item }) => window.api.projectComposition.respondToolApproval({
          scope, runId, unitId: item.unitId, requestId: item.requestId, decision: "allow"
        }), { scope, runId: prepared.id, item })
      }
      if (latest.status === "waiting-approval") {
        const gate = await page.evaluate(({ scope, runId }) => window.api.projectComposition.waitingApproval({ scope, runId }), { scope, runId: prepared.id })
        assert(gate?.kind === "legacy-human-gate", JSON.stringify(gate))
        approvals.push(gate)
        const confirmed = await page.evaluate(({ scope, run, gate }) => window.api.projectComposition.approve({
          scope, runId: run.id, unitId: gate.unitId, expectedVersion: run.version,
          kind: "legacy-human-gate", gateId: gate.gateId, decision: "approved"
        }), { scope, run: latest, gate })
        await page.evaluate(({ scope, run }) => window.api.projectComposition.resume({
          scope, runId: run.id, expectedVersion: run.version
        }), { scope, run: confirmed })
      }
      await new Promise(done => setTimeout(done, 100))
    }
    save("composition-run.json", latest)
    assert.equal(latest.status, "succeeded", JSON.stringify(latest))
    assert(latest.units.every(unit => unit.proof?.kind === "flow-completed"))
    assert.deepEqual([...new Set([...nativeSessions.values()].map(session => session.slashSkill))].sort(),
      ["autobiz-requirement-discuss", "autodev-specs", "warehouse-model", "warehouse-quality", "warehouse-sql"],
      "All five original native session event windows must bind their actual original decision Skills")
    assert([...nativeSessions.values()].every(session => session.endedAt !== undefined),
      "Every observed original native session must have a real terminal event")
    const observed = loopback.observed()
    assert(observed.consumed && observed.producerWorkspace && observed.consumerWorkspace)
    const metadataRequests = readFileSync(join(fixture.isolated, "metadata-requests.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line))
    assert(metadataRequests.length > 0, "The original Python-to-Node collector must use the controlled metadata transport")
    assert(metadataRequests.every(row => row.host === "archguardservice.paas.cmbchina.cn" &&
      row.path === "/cowork/get-analysis-info-v2?deployUnit=DW.ORDER" && Number.isInteger(row.pid)))
    evidence.actualCollectorMetadataRequests = metadataRequests
    const produced = readFileSync(join(observed.producerWorkspace, ".devclaw/handoffs/verified-context.json"))
    const copied = readFileSync(join(observed.consumerWorkspace, "inputs/verified-context.json"))
    assert.deepEqual(copied, produced)
    const bundle = JSON.parse(produced.toString())
    assert.deepEqual(bundle.files.map((file: { id: string }) => file.id).sort(), ["warehouse_quality", "warehouse_sql_results"])
    for (const file of bundle.files) {
      assert.equal(hash(file.content), file.digest)
      assert.equal(hash(readFileSync(join(observed.producerWorkspace, file.path))), file.digest)
      assert(file.checkedBy.nodeId && file.checkedBy.checkId && /^[a-f0-9]{64}$/.test(file.checkedBy.contractDigest))
    }
    assert.equal(observed.consumed.bundleDigest, hash(produced))
    const final = await page.evaluate(({ scope, runId }) => window.api.projectComposition.readArtifact({
      scope, runId, unitId: "consumer", artifactId: "report"
    }), { scope, runId: prepared.id })
    assert(final.content)
    assert.deepEqual(JSON.parse(final.content).artifacts, observed.consumed.artifacts)
    assert.equal(hash(final.content), latest.units[1].proof!.artifacts.find(artifact => artifact.id === "report")!.digest)
    // Original diagnostic records, produced by the real Hook runner, not model claims.
    let mandatoryStop: Record<string, unknown> | undefined
    const flushDeadline = Date.now() + 6500
    while (!mandatoryStop && Date.now() < flushDeadline) {
      if (existsSync(hookLogDir)) for (const name of readdirSync(hookLogDir).filter(name => name.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(hookLogDir, name), "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line)
          if (row.event === "Stop" && row.kind === "executed" && row.exitCode === 0 &&
            row.pluginName === "verified-artifact-consumer" &&
            JSON.stringify(row).includes("VERIFIED_REPORT_STOP_PASSED")) mandatoryStop = row
        }
      }
      if (!mandatoryStop) await new Promise(done => setTimeout(done, 100))
    }
    assert(mandatoryStop, "Real mandatory Stop must verify bound bytes and the original task before completion")
    evidence.mandatoryStop = mandatoryStop
    nativeFileApprovals = await currentApp.evaluate(() =>
      (globalThis as unknown as { __a12NativeFileApprovals: unknown[] }).__a12NativeFileApprovals)
    assert.equal(nativeFileApprovals.filter(item =>
      (item as { response: number }).response === 1).length, 1,
    "Exactly one original Mod report-write confirmation must be explicitly approved")
    evidence.passed = true
    evidence.producerToConsumer = { run: latest, bundle, actualGuest: observed.consumed, finalReport: JSON.parse(final.content) }
    assert.equal(projectCompositionCandidate(root).sha256, candidate.sha256)
    })
  } finally {
    clearTimeout(watchdog)
    if (app) nativeFileApprovals = await app.evaluate(() =>
      (globalThis as unknown as { __a12NativeFileApprovals?: unknown[] }).__a12NativeFileApprovals ?? [])
      .catch(() => nativeFileApprovals)
    evidence.nativeFileApprovalCount = nativeFileApprovals.filter(item =>
      (item as { response: number }).response === 1).length
    evidence.nativeFileApprovalExactlyOnce = evidence.nativeFileApprovalCount === 1
    save("evidence.json", { ...evidence, archiveUnchanged: hash(readFileSync(archive)) === hash(bytes),
      consumerArchiveUnchanged: hash(readFileSync(consumerArchive)) === hash(consumerBytes), errors: loopback.errors,
      nativeFileApprovals, approvals })
    save("model-requests.json", loopback.requests)
    await app?.close().catch(() => {})
    loopback.server.closeAllConnections()
    await new Promise<void>(done => loopback.server.close(() => done()))
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json") }))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
