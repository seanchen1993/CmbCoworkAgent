/** Real package only: catalogs → public assembly IPC → fresh installation → existing Host/SDK. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type {
  LocalProjectCommand,
  LocalProjectView
} from "../src/shared/project-runtime/platform-api"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import { portableBusinessModFiles } from "../src/main/plugins/business-mod-portable-source"
import {
  wrapProjectRuntimeManifest,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../src/shared/project-runtime"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR?.trim(), "Choose the newly built real ASAR package")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256, "Pin the reviewed package")
const fixture = projectCompositionEnvironment(root)
const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
  unobtrusivePresentation: true
})
let app: ElectronApplication | undefined
let page: Page
let negative = false
let currentStage = ""
const requests: unknown[] = [],
  errors: string[] = [],
  checks: string[] = [],
  hooks: unknown[] = []
const evidence: Record<string, unknown> = {
  candidate,
  isolated: fixture.isolated,
  limitations: [
    "Deterministic loopback provider, not real supplier qualification or external model quality.",
    "Native public approval IPC acknowledges only the exact observed fixture file request; no blanket grants.",
    "Host schema receipts prove declared technical checks, not cross-document truth or business approval.",
    "No S6 snapshots, isolation debugger or rollback is implemented or claimed."
  ]
}
const pause = () => new Promise((done) => setTimeout(done, 100))
const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex")
const ordinaryBoardPath = "board_core/board_config.json"
const ordinaryBoardBytes = readFileSync(
  join(root, "examples/vendor-onboarding-mods", ordinaryBoardPath)
)
const ordinaryBoardDigest = digest(ordinaryBoardBytes)
const expectedPolicy = readFileSync(
  join(root, "examples/vendor-onboarding-mods/knowledge/admission-policy.md"),
  "utf8"
)
  .replace(/\r\n/g, "\n")
  .trim()
const artifact = (name: string, value: unknown) =>
  writeFileSync(join(fixture.isolated, name), JSON.stringify(value, null, 2) + "\n")

type Message = {
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}
function text(messages: Message[]) {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => part?.text ?? "").join("\n")
          : ""
    )
    .join("\n")
}
function actualResult(messages: Message[], name: string, path?: string) {
  for (const message of messages)
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== name) continue
      if (path && resolve(JSON.parse(call.function.arguments).file_path) !== resolve(path)) continue
      const result = messages.find((item) => item.role === "tool" && item.tool_call_id === call.id)
      if (typeof result?.content === "string") return result.content
    }
  return undefined
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST")
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      assert(bytes < 2 * 1024 * 1024, "Bound actual request bytes")
      chunks.push(Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (request.url?.startsWith("/skill-hook/")) {
      hooks.push({ event: request.url.slice("/skill-hook/".length), stage: currentStage, body })
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
      return
    }
    assert.equal(request.url, "/v1/chat/completions")
    assert.equal(body.model, "vendor-independent")
    assert(requests.length < 100, "No uncontrolled model retry")
    const messages = body.messages as Message[]
    const prompt = text(messages)
    const stage = /"stageId"\s*:\s*"(vendor\.[\w.-]+)"/.exec(prompt)?.[1]
    assert.equal(stage, currentStage, "Original Host stage context must reach the real request")
    const skillPath = /<path>([^<]+)<\/path>/.exec(prompt)?.[1]
    assert(skillPath, "Original explicit Skill path must be available")
    const pluginRoot = dirname(dirname(dirname(skillPath)))
    const policyPath = join(pluginRoot, "knowledge/admission-policy.md")
    const tools = (body.tools ?? []).map(
      (item: { function?: { name?: string } }) => item.function?.name ?? ""
    )
    const settings = tools.find((name: string) => name.endsWith("__settings"))
    assert(settings, "The selected ordinary Function Mod must expose its registered native tool")
    const output =
      stage === "vendor.dossier"
        ? "dossier.json"
        : stage === "vendor.qualification"
          ? "qualification.json"
          : "vendor-report.json"
    const outputPath = join(fixture.workspace, output)
    const dossierPath = join(fixture.workspace, "dossier.json")
    const qualificationPath = join(fixture.workspace, "qualification.json")
    let name: string | undefined
    let input: Record<string, unknown> = {}
    const read = (path: string) => {
      name = "read_file"
      input = { file_path: path }
    }
    const configResult = actualResult(messages, settings)
    const policyResult = actualResult(messages, "read_file", policyPath)
    if (!actualResult(messages, "read_file", skillPath)) read(skillPath)
    else if (!configResult) {
      name = settings
      input = {}
    } else if (!policyResult) read(policyPath)
    else if (stage !== "vendor.dossier" && !actualResult(messages, "read_file", dossierPath))
      read(dossierPath)
    else if (stage === "vendor.decision" && !actualResult(messages, "read_file", qualificationPath))
      read(qualificationPath)
    else {
      assert(
        configResult.includes("enhanced") && configResult.includes("native-user-config"),
        "Actual saved native configuration must return through the real tool into the final request"
      )
      const actualPolicy = policyResult.replace(/^\s*\d+(?:\.\d+)?\t/gm, "").replace(/\r\n/g, "\n")
      assert(
        actualPolicy.includes(expectedPolicy),
        "The complete fixture policy must reach the request"
      )
      const configuredTier = /"policyTier"\s*:\s*"(standard|enhanced)"/.exec(configResult)?.[1]
      assert.equal(
        configuredTier,
        "enhanced",
        "Read the saved policy value from the actual tool result"
      )
      assert(prompt.includes("VENDOR_"), "Actual Skill read result must reach the request")
      if (stage !== "vendor.dossier") {
        assert(
          actualResult(messages, "read_file", dossierPath)?.includes("隔离资料供应商"),
          "Downstream stage must actually consume the original dossier tool result"
        )
      }
      if (stage === "vendor.decision") {
        assert(
          actualResult(messages, "read_file", qualificationPath)?.includes("needs-human-review"),
          "Final stage must actually consume the inserted user Mod result"
        )
      }
      const alreadyWrote = ["write_file", "edit_file"].some((tool) =>
        actualResult(messages, tool, outputPath)
      )
      if (!alreadyWrote) {
        if (existsSync(outputPath) && !actualResult(messages, "read_file", outputPath))
          read(outputPath)
        else {
          const dossier =
            stage === "vendor.dossier" ? undefined : JSON.parse(readFileSync(dossierPath, "utf8"))
          const qualification =
            stage === "vendor.decision"
              ? JSON.parse(readFileSync(qualificationPath, "utf8"))
              : undefined
          const document =
            stage === "vendor.dossier"
              ? {
                  vendorName: "隔离资料供应商",
                  registrationId: "fixture-vendor-id",
                  source: "隔离用户提供资料",
                  policyTier: configuredTier
                }
              : stage === "vendor.qualification"
                ? {
                    vendorName: dossier.vendorName,
                    source: "dossier.json",
                    policyTier: dossier.policyTier,
                    status: negative ? "pretend-approved" : "needs-human-review"
                  }
                : {
                    vendorName: dossier.vendorName,
                    policyTier: dossier.policyTier,
                    decision: "needs-human-review",
                    qualificationStatus: qualification.status,
                    sources: ["dossier.json", "qualification.json"]
                  }
          const content = JSON.stringify(document, null, 2) + "\n"
          if (existsSync(outputPath)) {
            name = "edit_file"
            input = {
              file_path: outputPath,
              old_string: readFileSync(outputPath, "utf8"),
              new_string: content
            }
          } else {
            name = "write_file"
            input = { file_path: outputPath, content }
          }
        }
      } else {
        const result =
          actualResult(messages, "write_file", outputPath) ??
          actualResult(messages, "edit_file", outputPath)!
        assert.match(
          result,
          /^Successfully (?:wrote|replaced)/,
          "Actual native file tool must succeed"
        )
      }
    }
    if (name) assert(tools.includes(name), "Use only an actual advertised tool")
    const delta = name
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `vendor-${requests.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(input) }
            }
          ]
        }
      : {
          role: "assistant",
          content: `VENDOR_STAGE_FINISHED_${stage}; native checks determine the result.`
        }
    requests.push({ stage, negative, body, selectedTool: name })
    response.writeHead(200, { "content-type": "text/event-stream" })
    const packet = (delta: unknown, finish_reason: string | null) => ({
      id: `vendor-${requests.length}`,
      object: "chat.completion.chunk",
      model: body.model,
      choices: [{ index: 0, delta, finish_reason }]
    })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify(packet({}, name ? "tool_calls" : "stop"))}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Independent business fixture assertion failed")
  }
})

async function install(bytes: Buffer, file: string) {
  const result = await page.evaluate(
    ({ bytes, file }) => window.api.plugins.install(new Uint8Array(bytes).buffer, file, "local"),
    { bytes: [...bytes], file }
  )
  assert(result.success, result.error)
}
async function installCatalog(name: string) {
  const source = await snapshotDerivationSource(join(root, "examples", name))
  const zip = new AdmZip()
  for (const file of portableBusinessModFiles(source)) zip.addFile(file.path, file.bytes)
  await install(zip.toBuffer(), `${name}.zip`)
  const plugins = await page.evaluate(() => window.api.plugins.list())
  const plugin = plugins.find((item) => item.name === name)
  assert(plugin)
  if (name === "vendor-onboarding-mods") {
    assert(
      zip.readFile(ordinaryBoardPath)?.equals(ordinaryBoardBytes),
      "Source ZIP must retain the ordinary resource exactly"
    )
    assert(
      readFileSync(join(plugin.path, ordinaryBoardPath)).equals(ordinaryBoardBytes),
      "Native source install must retain the ordinary resource exactly"
    )
    assert.equal(
      JSON.parse(zip.readAsText("mods/business/manifest.json")).kernel.boardConfigPath,
      undefined
    )
    evidence.sourceCollisionResource = {
      pluginId: plugin.id,
      path: ordinaryBoardPath,
      sha256: ordinaryBoardDigest,
      retainedBySourceZipAndInstall: true
    }
  }
  return plugin.id
}
async function assertNotLegacyEntrance(ids: string[], requireHostTemplate = false) {
  const observation = await page.evaluate(
    async (ids) => ({
      plugins: (await window.api.plugins.list()).filter((item) => ids.includes(item.id)),
      legacyRegistry: await window.api.harnessBoard.registry(),
      hostTemplates: await window.api.harnessBoard.localProjects.templates()
    }),
    ids
  )
  assert.equal(observation.plugins.length, ids.length)
  for (const plugin of observation.plugins) {
    assert.equal(
      plugin.hasProjectMode,
      false,
      "The public legacy project button must not be enabled for Host catalog or runtime sources"
    )
    assert(
      !observation.legacyRegistry.some((entry) => entry.name === plugin.name),
      "Host sources/resources must not become legacy AutoBiz entrances through their filenames"
    )
  }
  if (requireHostTemplate)
    for (const id of ids) {
      const template = observation.hostTemplates.find((item) => item.installedPluginId === id)
      assert(
        template && !template.unavailableReason,
        "Real Host template discovery must remain available"
      )
    }
  const observations = (evidence.entryClassifications ??= []) as unknown[]
  observations.push(observation)
}
async function assertLegacyAgentClosure(declared: boolean) {
  const name = declared ? "legacy-missing-agent-declared" : "legacy-missing-agent-historical"
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", skills: "skills" }))
  )
  zip.addFile(
    "skills/legacy/SKILL.md",
    Buffer.from(
      "---\nname: legacy-missing-agent\ndescription: Legacy negative fixture\n---\nNever execute this fixture.\n"
    )
  )
  zip.addFile(
    ordinaryBoardPath,
    Buffer.from(
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
  )
  if (declared)
    zip.addFile(
      "devclaw.project-runtime.json",
      Buffer.from(
        JSON.stringify(
          wrapProjectRuntimeManifest(
            {
              apiVersion: "devclaw.project-runtime/v1",
              plugin: { id: name, version: "1.0.0" },
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
    )
  const result = await page.evaluate(
    ({ bytes, file }) => window.api.plugins.install(new Uint8Array(bytes).buffer, file, "local"),
    { bytes: [...zip.toBuffer()], file: `${name}.zip` }
  )
  assert.equal(result.success, false, "Legacy missing-agent packages must remain rejected")
  assert.match(result.error ?? "", /PROJECT_AGENT_RESOURCE_MISSING: agents\/missing\.md/)
  const plugins = await page.evaluate(() => window.api.plugins.list())
  assert(
    !plugins.some((plugin) => plugin.name === name),
    "Rejected legacy source must not be installed"
  )
  const observations = (evidence.legacyAgentClosure ??= []) as unknown[]
  observations.push({ name, declaredRuntime: declared, installed: false, error: result.error })
}
const command = (id: string, command: LocalProjectCommand) =>
  page.evaluate(({ id, command }) => window.api.harnessBoard.localProjects.command(id, command), {
    id,
    command
  })
async function run(view: LocalProjectView) {
  currentStage = view.project.manifest.stages[view.project.stageIndex].id
  view = await command(view.project.projectId, {
    kind: "prepare",
    expectedVersion: view.project.version,
    idempotencyKey: randomUUID()
  })
  const operationId = view.operations[0].operationId
  let done = false,
    result: LocalProjectView | undefined,
    failure: unknown
  void command(view.project.projectId, { kind: "start", operationId }).then(
    (value) => {
      result = value
      done = true
    },
    (error) => {
      failure = error
      done = true
    }
  )
  const approved = new Set<string>()
  const deadline = Date.now() + 120000
  while (!done && Date.now() < deadline) {
    const latest = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.get(id),
      view.project.projectId
    )
    const threadId = latest.operations.find((item) => item.operationId === operationId)?.execution
      ?.threadId
    if (threadId) {
      const pending = await page.evaluate(
        (id) => window.api.sandbox.getPendingApprovals(id),
        threadId
      )
      for (const value of pending) {
        const approval = value as {
          id: string
          operation: string
          filePath: string
          tool_call: { id: string }
        }
        if (approved.has(approval.id)) continue
        assert(["write_file", "edit_file"].includes(approval.operation))
        assert(
          ["dossier.json", "qualification.json", "vendor-report.json"]
            .map((name) => resolve(fixture.workspace, name))
            .includes(resolve(approval.filePath))
        )
        assert(approval.tool_call.id)
        await page.evaluate(
          (entry) =>
            window.api.sandbox.sendApprovalDecision({
              requestId: entry.id,
              type: "approve",
              tool_call_id: entry.tool_call.id
            }),
          approval
        )
        approved.add(approval.id)
      }
    }
    await pause()
  }
  assert(done, "Original stage must physically settle within its original fixture deadline")
  if (failure) throw failure
  assert(result)
  return result
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  const watchdog = setTimeout(() => {
    errors.push("Independent business watchdog expired")
    void app?.close()
  }, 480000)
  try {
    app = await launch()
    const processHandle = app.process()
    evidence.application = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      path: app.getAppPath(),
      executable: process.execPath,
      pid: process.pid
    }))
    assert.equal((evidence.application as { packaged: boolean }).packaged, true)
    for (const [name, stream] of [
      ["stdout", processHandle.stdout],
      ["stderr", processHandle.stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes)
      )
    page = await app.firstWindow({ timeout: 60000 })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.businessModAssembly))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page.evaluate(async (url) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({
        id: "vendor-independent",
        name: "Independent supplier loopback",
        baseUrl: url,
        model: "vendor-independent",
        apiKey: "isolated-loopback",
        maxTokens: 64000,
        maxOutputTokens: 4096
      })
      await window.api.models.setDefault("custom:vendor-independent")
      await window.api.mods.configureGlobal(true)
      for (const event of ["PreSkillUse", "PostSkillUse"] as const)
        await window.api.hooks.create({
          event,
          matcher: "vendor-.*",
          type: "http",
          enabled: true,
          timeout: 10000,
          url: `${url.replace(/\/v1$/, "")}/skill-hook/${event}`
        })
    }, `http://127.0.0.1:${address.port}/v1`)
    const baseId = await installCatalog("vendor-onboarding-mods")
    const customId = await installCatalog("vendor-qualification-mod")
    await assertNotLegacyEntrance([baseId, customId])
    await assertLegacyAgentClosure(true)
    await assertLegacyAgentClosure(false)
    const scope = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Independent business assembly",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      return { threadId: thread.thread_id, expectedWorkspace: workspace }
    }, fixture.workspace)
    const sources = await page.evaluate(
      async ({ scope, baseId, customId }) => ({
        base: await window.api.businessModAssembly.inspect({ ...scope, pluginId: baseId }),
        custom: await window.api.businessModAssembly.inspect({ ...scope, pluginId: customId })
      }),
      { scope, baseId, customId }
    )
    assert(sources.base && sources.custom)
    const assembly = await page.evaluate(
      async ({ scope, base, custom }) => {
        const preview = await window.api.businessModAssembly.preview({
          ...scope,
          request: {
            name: "vendor-onboarding-composed",
            version: "1.0.0",
            sources: [
              { inspectionId: base, modIds: ["vendor.decision"] },
              { inspectionId: custom, modIds: ["vendor.qualification"] }
            ],
            order: ["vendor.dossier", "vendor.qualification", "vendor.decision"]
          }
        })
        return preview
      },
      { scope, base: sources.base.id, custom: sources.custom.id }
    )
    assert(assembly.valid)
    assert(assembly.extensions?.some((item) => item.id === "vendor.settings" && item.added))
    assert.deepEqual(
      assembly.steps.map((item) => item.id),
      ["vendor.dossier", "vendor.qualification", "vendor.decision"]
    )
    assert.equal(
      assembly.files.find((file) => file.path === ordinaryBoardPath)?.digest,
      ordinaryBoardDigest
    )
    assert(!assembly.files.some((file) => /autobiz|stage-checks/.test(file.path)))
    const created = await page.evaluate(
      ({ scope, previewId, requestId }) =>
        window.api.businessModAssembly.create({ ...scope, previewId, requestId }),
      { scope, previewId: assembly.previewId, requestId: randomUUID() }
    )
    const checked = await page.evaluate(
      ({ scope, copyId, expectedDigest }) =>
        window.api.businessModAssembly.check({ ...scope, copyId, expectedDigest }),
      { scope, copyId: created.copyId, expectedDigest: created.digest }
    )
    const output = join(fixture.isolated, "vendor-onboarding-composed.zip")
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, output)
    await page.evaluate(
      ({ scope, copyId, expectedDigest }) =>
        window.api.businessModAssembly.export({ ...scope, copyId, expectedDigest }),
      { scope, copyId: checked.copyId, expectedDigest: checked.digest }
    )
    const exported = readFileSync(output)
    assert(
      new AdmZip(exported).readFile(ordinaryBoardPath)?.equals(ordinaryBoardBytes),
      "The checked/exported generated plugin must retain the exact ordinary resource"
    )
    await install(exported, "vendor-onboarding-composed.zip")
    const plugins = await page.evaluate(() => window.api.plugins.list())
    const plugin = plugins.find((item) => item.name === "vendor-onboarding-composed")!
    assert(plugin && plugin.id !== baseId && plugin.id !== customId)
    assert(
      readFileSync(join(plugin.path, ordinaryBoardPath)).equals(ordinaryBoardBytes),
      "Native generated-plugin installation must preserve ordinary resource bytes"
    )
    await assertNotLegacyEntrance([plugin.id], true)
    evidence.assembly = {
      preview: assembly,
      copy: checked,
      archive: output,
      archiveSha256: digest(exported),
      ordinaryResourceSha256: ordinaryBoardDigest,
      pluginId: plugin.id
    }
    checks.push(
      "Public catalogs inspected, dependency assembled, checked, exported and installed through native ZIP"
    )
    checks.push(
      "A same-named ordinary board resource survives both ZIP installations without becoming an AutoBiz entrance; legacy missing-agent checks still reject"
    )
    let view = await page.evaluate((input) => window.api.harnessBoard.localProjects.create(input), {
      name: "独立供应商准入",
      workspace: fixture.workspace,
      installedPluginId: plugin.id,
      goal: "隔离资料：供应商名称为隔离资料供应商，信用标识fixture-vendor-id，来源为隔离用户提供资料。依次整理主体资料、资质审查、消费两份产物并给出待人工复核报告。"
    })
    const review = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      view.project.projectId
    )
    assert(review.source)
    const config = await page.evaluate(
      ({ id, pluginId }) =>
        window.api.harnessBoard.localProjects.mods.config.userConfig(id, pluginId),
      { id: view.project.projectId, pluginId: plugin.id }
    )
    await page.evaluate(
      ({ id, config }) =>
        window.api.harnessBoard.localProjects.mods.config.saveUserConfig(
          id,
          config,
          "policyTier",
          "enhanced"
        ),
      { id: view.project.projectId, config }
    )
    const refreshed = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      view.project.projectId
    )
    assert(refreshed.source)
    const ready = await page.evaluate(
      (input) => window.api.harnessBoard.localProjects.mods.approve(input),
      {
        projectId: view.project.projectId,
        projectVersion: view.project.version,
        packageDigest: view.project.pluginDigest,
        compiledDigest: refreshed.source.digest
      }
    )
    assert.equal(ready.source?.state, "ready")
    view = await run(view)
    assert.equal(view.operations[0].status, "succeeded")
    const dossierDigest = digest(readFileSync(join(fixture.workspace, "dossier.json")))
    view = await command(view.project.projectId, {
      kind: "advance",
      operationId: view.operations[0].operationId
    })
    negative = true
    view = await run(view)
    assert.equal(view.operations[0].status, "failed")
    assert(
      view.operations[0].receipts.some(
        (receipt) =>
          receipt.checkId === "vendor.qualification.schema" && receipt.result === "failed"
      )
    )
    const failed = view
    const denial = await command(view.project.projectId, {
      kind: "advance",
      operationId: view.operations[0].operationId
    }).then(
      () => "UNEXPECTED_ADVANCE",
      (error) => String(error)
    )
    assert.notEqual(denial, "UNEXPECTED_ADVANCE")
    assert.equal(existsSync(join(fixture.workspace, "vendor-report.json")), false)
    assert.equal(digest(readFileSync(join(fixture.workspace, "dossier.json"))), dossierDigest)
    negative = false
    view = await run(view)
    assert.equal(view.operations[0].status, "succeeded")
    view = await command(view.project.projectId, {
      kind: "advance",
      operationId: view.operations[0].operationId
    })
    view = await run(view)
    assert.equal(view.operations[0].status, "succeeded")
    assert(view.operations[0].receipts.every((receipt) => receipt.result === "passed"))
    view = await command(view.project.projectId, {
      kind: "advance",
      operationId: view.operations[0].operationId
    })
    assert.equal(view.project.status, "completed")
    assert.equal(
      JSON.parse(readFileSync(join(fixture.workspace, "vendor-report.json"), "utf8"))
        .qualificationStatus,
      "needs-human-review"
    )
    for (const stage of ["vendor.dossier", "vendor.qualification", "vendor.decision"])
      for (const event of ["PreSkillUse", "PostSkillUse"])
        assert(
          hooks.some(
            (hook) =>
              (hook as { stage: string; event: string }).stage === stage &&
              (hook as { event: string }).event === event
          ),
          `Missing original ${event} for ${stage}`
        )
    checks.push(
      "Native configuration and frozen knowledge reach actual requests; inserted Mod output consumed by final stage"
    )
    checks.push(
      "Wrong qualification output blocks original Host schema checks and advance; repaired stage completes without resetting prior data"
    )
    assert.deepEqual(errors, [])
    evidence.failed = failed
    evidence.completed = view
    evidence.denial = denial
    await app.close()
    app = undefined
    evidence.exit = { code: processHandle.exitCode, signal: processHandle.signalCode }
    assert.equal(processHandle.exitCode, 0)
    assert.equal(processHandle.signalCode, null)
    assert.deepEqual(errors, [], "No late renderer or provider errors during application shutdown")
    artifact("evidence.json", { ...evidence, passed: true, checks, hooks, errors, requests })
    console.log(`PASS independent Host business Mods journey: ${fixture.isolated}`)
  } catch (error) {
    artifact("failure.json", {
      ...evidence,
      passed: false,
      error: String(error),
      checks,
      hooks,
      errors,
      requests
    })
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
