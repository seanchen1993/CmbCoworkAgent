/** Real internal AutoBiz composition through IPC, original ManagedRun, main-only
 * project_checkpoint, original checks and tool approvals. Local deterministic fixture; built or packaged. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve, relative, isAbsolute } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import { withPinnedAutobiz } from "../src/main/mods/v2/autobiz-source"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import { RetainedPackageSnapshots } from "../src/main/harness-board/project-runtime/package-snapshots"
import { prepareFlowCompositionFiles } from "../src/main/plugins/derivation-flow-composition"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment,
  compositionParentAdapter,
  projectCompositionCandidate
} from "./support/project-composition-e2e-fixtures"
const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
const driver = join(root, "tests/support/composition-autobiz-local-artifacts.py")
const requests: Array<{ checkpoint: string; tool?: string; stage: string; workspace: string }> = []
const errors: string[] = []
const approvals: unknown[] = []
const retryDecisions: unknown[] = []
const injectRetry = process.env.COMPOSITION_E2E_LEGACY_RETRY === "1"
const withDocs = !injectRetry
const deliveryDirectory = process.env.COMPOSITION_E2E_DELIVERY_DIR
  ? resolve(process.env.COMPOSITION_E2E_DELIVERY_DIR)
  : undefined
const deliveryZips: Array<{ path: string; sha256: string }> = []
let installedPluginNames: string[] = []
const docsRequests: Array<{ workspace: string; tool?: string }> = []
let docsApproved = false
let docsWorkspace = ""
let injectedRetry = false
const approved = new Set<string>()
const commands = new Set<string>()
let originalSource = ""
let stages: Array<{ id: string; skill: string; checkpoints: string[] }> = []
let executionWorkspace = ""
let app: ElectronApplication | undefined
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert.equal(body.model, "legacy-internal-loopback")
    assert(requests.length < 55, "No uncontrolled inference retry")
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const parts = messages.flatMap((item) =>
      typeof item.content === "string"
        ? [item.content]
        : Array.isArray(item.content)
          ? item.content.map((part) => part?.text ?? "")
          : []
    )
    const workspace = /The workspace root is: ([^\r\n]+)/
      .exec(parts.join("\n"))?.[1]
      ?.trim()
      .replace(/^`|`$/g, "")
    assert(workspace, "Original context must supply isolated workspace")
    const below = relative(fixture.isolated, workspace)
    assert(below && !below.startsWith("..") && !isAbsolute(below))
    if (withDocs && /[\\/]docs$/.test(workspace)) {
      assert(docsRequests.length < 10)
      assert(executionWorkspace && workspace !== executionWorkspace)
      assert.equal(
        JSON.parse(readFileSync(join(executionWorkspace, ".autobizdevops/state.json"), "utf8"))
          .features["composition-autobiz"].checkpoint,
        "archived"
      )
      assert(parts.join("\n").includes("project-docs-lite-draft"))
      assert(parts.join("\n").includes("INTERNAL_AUTOBIZ_STANDARD"))
      assert(
        !existsSync(join(workspace, ".autobizdevops")),
        "No undeclared AutoBiz artifact handoff"
      )
      docsWorkspace = workspace
      const toolMessages = messages.filter((message) => message.role === "tool")
      const contextFile = join(workspace, "inputs/verified-context.json")
      const context = JSON.parse(readFileSync(contextFile, "utf8"))
      assert.equal(context.apiVersion, "devclaw.autobiz-context/v1")
      const prd = context.files.find((file: { id: string }) => file.id === "prd")
      assert(prd?.content.includes("ACTUAL_PRD_CONTENT_ONLY_20261016"))
      assert.equal(hash(Buffer.from(prd.content)), prd.digest)
      const code = context.sourceChanges?.changes.find(
        (file: { path: string }) => file.path === "src/order-export.ts"
      )
      assert(code?.content.includes("ACTUAL_SOURCE_BYTES_ONLY_20261016"))
      assert.equal(hash(Buffer.from(code.content)), code.digest)
      if (toolMessages.length)
        assert(
          String(toolMessages[0].content).includes("ACTUAL_PRD_CONTENT_ONLY_20261016") &&
            String(toolMessages[0].content).includes("ACTUAL_SOURCE_BYTES_ONLY_20261016"),
          "The native read_file tool must actually deliver the mapped producer bytes before drafting or reviewing"
        )
      const tool =
        toolMessages.length === 0 || (docsApproved && toolMessages.length === 1)
          ? "read_file"
          : toolMessages.length === (docsApproved ? 2 : 1)
            ? "write_file"
            : undefined
      const args =
        tool === "read_file"
          ? { file_path: toolMessages.length === 0 ? contextFile : join(workspace, "draft.md") }
          : {
              file_path: join(workspace, docsApproved ? "review.json" : "draft.md"),
              content: docsApproved
                ? JSON.stringify({
                    summary: `Reviewed actual document ${prd.path} SHA256 ${prd.digest} and source ${code.path} SHA256 ${code.digest}; scoped byte evidence, not per-file acceptance.`,
                    checked: true
                  })
                : `# Document based on actual producer material\n${prd.content}\nSource: ${prd.path}\nSHA256: ${prd.digest}\nActual implementation:\n${code.content}\nCode: ${code.path}\nSHA256: ${code.digest}\nThis is not a delivery acceptance report or per-file source acceptance.\n`
            }
      docsRequests.push({ workspace, tool })
      writeFileSync(
        join(fixture.isolated, `docs-request-${docsRequests.length}.json`),
        JSON.stringify(body, null, 2)
      )
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `docs-${docsRequests.length}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) }
              }
            ]
          }
        : {
            role: "assistant",
            content:
              "The local document stage read mapped original artifacts and scoped source bytes; this fixed fixture does not attest business quality."
          }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        `data: ${JSON.stringify({ id: "docs", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ id: "docs", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`
      )
      response.end("data: [DONE]\n\n")
      return
    }
    if (executionWorkspace) assert.equal(workspace, executionWorkspace)
    executionWorkspace = workspace
    const state = readFileSync(join(workspace, ".autobizdevops/state.json"))
    const records = JSON.parse(state.toString("utf8")).features
    assert.deepEqual(Object.keys(records), ["composition-autobiz"])
    const checkpoint = records["composition-autobiz"].checkpoint
    const managedRoot = join(workspace, ".cmbdevclaw/managed-runs/composition-autobiz")
    const runs = (await readdir(managedRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory()
    )
    assert.equal(runs.length, 1, "Only the original managed run may drive this fixture")
    const originalRun = JSON.parse(
      await readFile(join(managedRoot, runs[0].name, "run.json"), "utf8")
    )
    const slashSkill = originalRun.lastDecision?.policyResult?.facts?.slashSkill
    const stage = stages.find((item) => item.skill === slashSkill)
    assert(stage, `Original managed next skill is missing: ${slashSkill}`)
    const feature = join(workspace, ".autobizdevops/features/composition-autobiz")
    const prepared = existsSync(join(feature, "proposal.md"))
    const planDone =
      prepared && readFileSync(join(feature, "PLAN.md"), "utf8").includes("**状态:** 完成")
    let tool: string | undefined
    let args: Record<string, unknown> = {}
    if (!prepared || (stage.id === "dev.code" && !planDone)) {
      tool = "execute"
      const command = `python -I -B -X utf8 "${driver.replaceAll("\\", "/")}" "${originalSource.replaceAll("\\", "/")}" "${workspace.replaceAll("\\", "/")}" ${prepared ? "finished-plan" : "prepare"}`
      commands.add(command)
      args = { command, cwd: workspace }
    } else if (checkpoint !== stage.checkpoints.at(-1)) {
      tool = "project_checkpoint"
      const target = stage.checkpoints.includes(checkpoint)
        ? stage.checkpoints.at(-1)!
        : stage.checkpoints[0]
      args = { checkpoint: target, expectedStateDigest: hash(state) }
      assert(
        body.tools.some((item: { function?: { name: string } }) => item.function?.name === tool),
        "Only admitted internal original agent receives the main-owned checkpoint tool"
      )
    }
    const pausedForRetry = injectRetry && prepared && !injectedRetry
    if (pausedForRetry) {
      injectedRetry = true
      tool = undefined
    }
    requests.push({ checkpoint, tool, stage: stage.id, workspace })
    writeFileSync(
      join(fixture.isolated, `request-${requests.length}.json`),
      JSON.stringify(body, null, 2)
    )
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `internal-legacy-${requests.length}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) }
            }
          ]
        }
      : {
          role: "assistant",
          content: pausedForRetry
            ? "Local fixture intentionally stopped before advancing the original checkpoint."
            : "Local original stage completed and checked."
        }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: "legacy-internal", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({ id: "legacy-internal", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("Fixture rejected unexpected request")
  }
})
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 600000)
  try {
    await withPinnedAutobiz(undefined, async (source) => {
      originalSource = source
      stages = JSON.parse(await readFile(join(source, "board_core/board_config.json"), "utf8"))
        .workflow.nodes
      const installation: number[][] = deliveryDirectory
        ? []
        : [compositionParentAdapter(process.execPath)]
      if (deliveryDirectory) {
        for (const name of [
          "autobiz-project-composition-demo.zip",
          "project-docs-composition-demo.zip"
        ]) {
          const path = join(deliveryDirectory, name)
          const bytes = await readFile(path)
          deliveryZips.push({ path, sha256: hash(bytes) })
          installation.push([...bytes])
        }
      } else {
        const zip = new AdmZip()
        const add = async (directory: string, prefix = "") => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = prefix + entry.name
            if (entry.isDirectory()) await add(join(directory, entry.name), path + "/")
            else
              zip.addFile(
                path,
                path === ".mcp.json"
                  ? Buffer.from('{"mcpServers":{}}')
                  : await readFile(join(directory, entry.name))
              )
          }
        }
        await add(source)
        const docsZip = new AdmZip()
        if (withDocs) docsZip.addLocalFolder(join(root, "examples/project-docs-lite"))
        for (const file of prepareFlowCompositionFiles(await snapshotDerivationSource(source))
          .files)
          zip.addFile(file.path, Buffer.from(file.after))
        installation.push([...zip.toBuffer()])
        if (withDocs) installation.push([...docsZip.toBuffer()])
      }
      app = await createHeadlessProjectCompositionLaunch(root, fixture)()
      app
        .process()
        .stdout?.on("data", (data) =>
          appendFileSync(join(fixture.isolated, "main.stdout.log"), data)
        )
      app
        .process()
        .stderr?.on("data", (data) =>
          appendFileSync(join(fixture.isolated, "main.stderr.log"), data)
        )
      const page = await app.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.projectComposition))
      assert((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) > 0)
      const scope = await page.evaluate(
        async ({ installed, workspace, url, parentName }) => {
          for (const bytes of installed) {
            const result = await window.api.plugins.install(
              new Uint8Array(bytes).buffer,
              "local-fixture.zip",
              "local"
            )
            if (!result.success) throw Error(result.error)
          }
          const parent = (await window.api.plugins.list()).find((item) => item.name === parentName)!
          await window.api.autoCommit.saveSettings({ mode: "off", push: false })
          await window.api.models.setCustomConfig({
            id: "legacy-internal-loopback",
            name: "Local original composition fixture",
            baseUrl: url,
            model: "legacy-internal-loopback",
            apiKey: "local-fixture",
            maxTokens: 64000,
            maxOutputTokens: 2048
          })
          await window.api.models.setDefault("custom:legacy-internal-loopback")
          const project = await window.api.harnessBoard.createProject({
            adapterId: parent.id,
            adapterType: "plugin",
            name: "Local original composition fixture",
            projectCode: "INTERNALLEGACY",
            projectFromLean: false,
            projectDir: "composition-parent",
            description: "Isolated local original flow",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace
          })
          const thread = await window.api.threads.create({
            title: "Internal original legacy flow",
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
          installed: installation,
          parentName: deliveryDirectory
            ? "autobiz-project-composition-demo"
            : "composition-parent-fixture",
          workspace: fixture.workspace,
          url: `http://127.0.0.1:${address.port}/v1`
        }
      )
      installedPluginNames = await page.evaluate(async () =>
        (await window.api.plugins.list()).map((plugin) => plugin.name)
      )
      if (deliveryDirectory) {
        const originalName = (await snapshotDerivationSource(source)).name
        assert.notEqual(originalName, "autobiz-project-composition-demo")
        assert(
          !installedPluginNames.includes(originalName),
          "Delivery must not install as the original plugin"
        )
        assert(
          !installedPluginNames.includes("project-docs-lite"),
          "Delivery must use a distinct docs plugin identity"
        )
        for (const name of ["autobiz-project-composition-demo", "project-docs-composition-demo"])
          assert.equal(installedPluginNames.filter((installed) => installed === name).length, 1)
        assert.equal(
          installedPluginNames.length,
          2,
          "Delivery path must need only the two shipped plugins"
        )
      }
      const catalog = await page.evaluate(
        (scope) => window.api.projectComposition.catalog(scope),
        scope
      )
      writeFileSync(join(fixture.isolated, "catalog.json"), JSON.stringify(catalog, null, 2))
      const flow = catalog.entries.find((item) => item.source.capabilityId === "project-flow")
      assert(flow?.available, JSON.stringify(flow))
      const docs = withDocs
        ? catalog.entries.find((item) => item.source.capabilityId === "document-flow")
        : undefined
      if (withDocs) {
        assert(docs?.available, JSON.stringify(docs))
        assert(docs.inputs.some((input) => input.id === "context"))
      }
      const preview = await page.evaluate(
        ({ scope, revision, source, outputs, docs }) =>
          window.api.projectComposition.preview({
            scope,
            catalogRevision: revision,
            definition: {
              apiVersion: "devclaw.project-composition/v1",
              parentProjectId: scope.projectId,
              workspace: scope.expectedWorkspace,
              goal: "INTERNAL_AUTOBIZ_STANDARD: execute the local contract fixture only; no external systems",
              units: [
                { id: "autobiz", kind: "flow", source, inputs: [], outputs },
                ...(docs
                  ? [
                      {
                        id: "docs",
                        kind: "flow" as const,
                        source: docs.source,
                        inputs: [
                          {
                            inputId: "context",
                            fromUnitId: "autobiz",
                            artifactId: "verified-context"
                          }
                        ],
                        outputs: docs.outputs.map(({ id, path }) => ({ id, path }))
                      }
                    ]
                  : [])
              ]
            }
          }),
        {
          scope,
          revision: catalog.revision,
          source: flow.source,
          outputs: flow.outputs.map(({ id, path }) => ({ id, path })),
          docs
        }
      )
      assert.deepEqual(preview.issues, [])
      const started = await page.evaluate(
        ({ scope, previewId }) =>
          window.api.projectComposition.start({
            scope,
            previewId,
            requestId: "local-standard-original-run"
          }),
        { scope, previewId: preview.id }
      )
      let latest = started
      for (let i = 0; i < 1800; i++) {
        latest = await page.evaluate(
          ({ scope, runId }) => window.api.projectComposition.read({ scope, runId }),
          { scope, runId: started.id }
        )
        if (["succeeded", "failed", "unknown", "cancelled"].includes(latest.status)) break
        if (latest.status === "waiting-approval") {
          if (
            withDocs &&
            latest.units.find((unit) => unit.id === "docs")?.status === "waiting-approval"
          ) {
            const gate = await page.evaluate(
              ({ scope, runId }) => window.api.projectComposition.waitingApproval({ scope, runId }),
              { scope, runId: latest.id }
            )
            assert(gate && gate.kind !== "legacy-human-gate" && gate.unitId === "docs")
            assert(!docsApproved)
            assert.equal(docsRequests.length, 3)
            docsApproved = true
            const approvedRun = await page.evaluate(
              ({ scope, runId, gate }) =>
                window.api.projectComposition.approve({
                  scope,
                  runId,
                  unitId: gate.unitId,
                  operationId: gate.operationId,
                  expectedVersion: gate.operationVersion,
                  inputFingerprint: gate.inputFingerprint,
                  decision: "approved"
                }),
              { scope, runId: latest.id, gate }
            )
            await page.evaluate(
              ({ scope, run }) =>
                window.api.projectComposition.resume({
                  scope,
                  runId: run.id,
                  expectedVersion: run.version
                }),
              { scope, run: approvedRun }
            )
            continue
          }
          const decision = await page.evaluate(
            ({ scope, runId }) =>
              window.api.projectComposition.readLegacyDecision({ scope, runId }),
            { scope, runId: latest.id }
          )
          if (decision) {
            assert(
              injectRetry && injectedRetry && retryDecisions.length === 0,
              "Only one explicitly injected original retry"
            )
            assert.equal(decision.humanGatePending, false)
            const result = await page.evaluate(
              ({ scope, run, decision }) =>
                window.api.projectComposition.decideLegacyDecision({
                  scope,
                  runId: run.id,
                  unitId: decision.unitId,
                  notificationId: decision.notificationId,
                  expectedVersion: run.version,
                  action: "continue",
                  message: "Continue the isolated fixture with the original checkpoint tool."
                }),
              { scope, run: latest, decision }
            )
            retryDecisions.push({ decision, result })
            assert(result.applied, result.message)
            const refreshed = await page.evaluate(
              ({ scope, runId }) => window.api.projectComposition.read({ scope, runId }),
              { scope, runId: latest.id }
            )
            try {
              await page.evaluate(
                ({ scope, run }) =>
                  window.api.projectComposition.resume({
                    scope,
                    runId: run.id,
                    expectedVersion: run.version
                  }),
                { scope, run: refreshed }
              )
            } catch (error) {
              const diagnostic = await page.evaluate(
                async ({ scope, definition }) => {
                  const catalog = await window.api.projectComposition.catalog(scope)
                  const preview = await window.api.projectComposition.preview({
                    scope,
                    catalogRevision: catalog.revision,
                    definition
                  })
                  return { catalog, preview }
                },
                { scope, definition: preview.definition }
              )
              writeFileSync(
                join(fixture.isolated, "resume-diagnostic.json"),
                JSON.stringify(diagnostic, null, 2)
              )
              throw error
            }
          }
        }
        const pending = await page.evaluate(
          ({ scope, runId }) => window.api.projectComposition.readToolApprovals({ scope, runId }),
          { scope, runId: started.id }
        )
        for (const item of pending) {
          if (approved.has(item.requestId)) continue
          assert(
            item.allow &&
              (item.unitId === "autobiz"
                ? item.command && commands.has(item.command)
                : item.unitId === "docs" &&
                  item.filePath &&
                  [join(docsWorkspace, "draft.md"), join(docsWorkspace, "review.json")].includes(
                    item.filePath
                  )),
            JSON.stringify(item)
          )
          approved.add(item.requestId)
          approvals.push(item)
          await page.evaluate(
            ({ scope, runId, requestId, unitId }) =>
              window.api.projectComposition.respondToolApproval({
                scope,
                runId,
                requestId,
                unitId,
                decision: "allow"
              }),
            { scope, runId: started.id, requestId: item.requestId, unitId: item.unitId }
          )
        }
        await new Promise((done) => setTimeout(done, 250))
      }
      writeFileSync(join(fixture.isolated, "composition-run.json"), JSON.stringify(latest, null, 2))
      assert.equal(latest.status, "succeeded", JSON.stringify(latest))
      assert.equal(latest.units[0].proof?.kind, "flow-completed")
      if (withDocs) {
        assert.equal(latest.units[1].proof?.kind, "flow-completed")
        assert(docsApproved)
        assert(docsRequests.some((request) => request.tool === "read_file"))
        const document = await page.evaluate(
          ({ scope, runId }) =>
            window.api.projectComposition.readArtifact({
              scope,
              runId,
              unitId: "docs",
              artifactId: "draft"
            }),
          { scope, runId: latest.id }
        )
        assert(document.content?.includes("not a delivery acceptance report"))
        assert(document.content?.includes("ACTUAL_PRD_CONTENT_ONLY_20261016"))
        assert(document.content?.includes("ACTUAL_SOURCE_BYTES_ONLY_20261016"))
        const exported = await page.evaluate(
          ({ scope, runId }) =>
            window.api.projectComposition.readArtifact({
              scope,
              runId,
              unitId: "autobiz",
              artifactId: "verified-context"
            }),
          { scope, runId: latest.id }
        )
        assert(exported.content)
        const producer = JSON.parse(exported.content)
        const bytes = readFileSync(join(executionWorkspace, exported.path))
        assert.equal(latest.units[0].proof?.artifacts[0].digest, hash(bytes))
        assert.deepEqual(readFileSync(join(docsWorkspace, "inputs/verified-context.json")), bytes)
        assert.equal(producer.producer.source.packageDigest, flow.source.packageDigest)
        assert.equal(producer.producer.engineRunId, latest.units[0].proof?.engineRunId)
        for (const file of producer.files)
          assert.equal(hash(readFileSync(join(executionWorkspace, file.path))), file.digest)
        for (const file of producer.sourceChanges.changes)
          if (file.change !== "deleted")
            assert.equal(hash(readFileSync(join(executionWorkspace, file.path))), file.digest)
        writeFileSync(join(executionWorkspace, exported.path), "changed after proof")
        await assert.rejects(
          page.evaluate(
            ({ scope, runId }) =>
              window.api.projectComposition.readArtifact({
                scope,
                runId,
                unitId: "autobiz",
                artifactId: "verified-context"
              }),
            { scope, runId: latest.id }
          ),
          /ARTIFACT_CHANGED/
        )
        writeFileSync(join(executionWorkspace, exported.path), bytes)
        writeFileSync(join(fixture.isolated, "verified-context.json"), bytes)
      }
      // Presentation-only suppression: exercise the real scoped IPC without opening Explorer.
      await app.evaluate(({ shell }) => {
        const observed: string[] = []
        ;(
          globalThis as unknown as { compositionOpenedWorkspaces: string[] }
        ).compositionOpenedWorkspaces = observed
        shell.openPath = async (path) => {
          observed.push(path)
          return ""
        }
      })
      const located = await page.evaluate(
        ({ scope, runId }) =>
          window.api.projectComposition.openWorkspace({ scope, runId, unitId: "autobiz" }),
        { scope, runId: started.id }
      )
      assert.equal(located.path, executionWorkspace)
      assert.deepEqual(
        await app.evaluate(
          () =>
            (globalThis as unknown as { compositionOpenedWorkspaces: string[] })
              .compositionOpenedWorkspaces
        ),
        [executionWorkspace]
      )
      writeFileSync(
        join(fixture.isolated, "opened-workspace.json"),
        JSON.stringify(located, null, 2)
      )
      const engineRunId = latest.units[0].proof!.engineRunId
      const journal = readFileSync(
        join(
          executionWorkspace,
          ".cmbdevclaw/managed-runs/composition-autobiz",
          engineRunId,
          "events.ndjson"
        ),
        "utf8"
      )
      writeFileSync(join(fixture.isolated, "managed-events.ndjson"), journal)
      const sessions = journal
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "session_created")
        .map((event) => event.targetThreadId)
      assert(sessions.length > 1, "The original managed flow must create actual stage sessions")
      const visibleThreads = await page.evaluate(async () =>
        (await window.api.threads.list()).map((thread) => thread.thread_id)
      )
      assert(
        sessions.every((id) => !visibleThreads.includes(id)),
        "Internal original sessions must stay out of the ordinary thread list"
      )
      const retained = new RetainedPackageSnapshots(
        join(fixture.isolated, "data/project-compositions/legacy-packages")
      )
      await retained.readAsync(flow.source.packageDigest)
      assert.equal(
        JSON.parse(readFileSync(join(executionWorkspace, ".autobizdevops/state.json"), "utf8"))
          .features["composition-autobiz"].checkpoint,
        "archived"
      )
      assert(
        !existsSync(join(fixture.workspace, ".autobizdevops")),
        "Internal state must not leak into parent workspace"
      )
      assert.equal(retryDecisions.length, injectRetry ? 1 : 0)
      assert.equal(errors.length, 0, errors.join("\n"))
      console.log(`PASS real internal original AutoBiz composition: ${fixture.isolated}`)
    })
  } catch (error) {
    errors.push(String(error))
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify(
        {
          execution: candidate.execution,
          candidate,
          scenario: injectRetry ? "original-biz-retry" : "autobiz-then-docs",
          docsRequests,
          docsApproved,
          deliveryZips,
          installedPluginNames,
          fixtureChanges: deliveryDirectory
            ? ["none: delivery ZIP bytes installed unchanged"]
            : ["external MCP disabled", "four additive host-generated composition declarations"],
          requests,
          approvals,
          retryDecisions,
          errors
        },
        null,
        2
      )
    )
    assert.deepEqual(projectCompositionCandidate(root), candidate, "Candidate changed during E2E")
    for (const zip of deliveryZips)
      assert.equal(hash(readFileSync(zip.path)), zip.sha256, "Delivery ZIP changed during E2E")
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
