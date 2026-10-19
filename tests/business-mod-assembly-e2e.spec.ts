/** Real Electron IPC + fresh export installation + original dynamic kernel checks.
 * Run explicitly: npx tsx tests/business-mod-assembly-e2e.spec.ts --source <catalog>
 *   --custom-source <user-catalog> [--artifacts <relative-path-to-content.json>]
 * The loopback model writes controlled requirement documents only. It cannot write
 * state, acceptance receipts, or claim business quality; the actual kernel decides.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { snapshotDerivationSource } from "../src/main/plugins/derivation-source"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const args = process.argv.slice(2)
function argument(name: string, required = true) {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]
  if (required) assert(value && !value.startsWith("--"), `Explicit ${name} is required`)
  return value ? resolve(value) : undefined
}
const source = argument("--source")!
const customSource = argument("--custom-source")!
const artifactInput = argument("--artifacts", false)
const extraDocuments = artifactInput
  ? (JSON.parse(readFileSync(artifactInput, "utf8")) as Record<string, string>)
  : {}
const root = resolve(__dirname, "..")
const candidate = projectCompositionCandidate(root)
const assemblyEnvironment = projectCompositionEnvironment(root)
const runtimeEnvironment = projectCompositionEnvironment(root)
const requests: unknown[] = []
const approvals: unknown[] = []
const errors: string[] = []
const authorizedCommands = new Set<string>()
const authorizedWriteFiles = new Set<string>()
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
interface NodeDefinition {
  id: string
  checkpoints: string[]
  artifacts: { outputs?: Array<{ path: string; required?: boolean }> }
}
interface Execution {
  pluginPath: string
  projectRoot: string
  feature: string
  nodes: NodeDefinition[]
  bizValidation?: "pending" | "passed"
  negative?: { digest: string; checkpoint: string; pending: boolean; verified?: boolean }
}
const executions = new Map<string, Execution>()
let app: ElectronApplication | undefined

function document(path: string, feature: string): string {
  if (Object.hasOwn(extraDocuments, path)) return extraDocuments[path]
  if (path === "PRD.md")
    return `# 本地订单导出需求\n\n本次仅验证本地需求与规格文档组合，不宣称代码或测试验收。\n\n## 用户故事\n用户可把当前订单列表导出为 CSV。\n\n## 验收标准\n导出含 id 和 amount 两列，空列表仍含表头。\n\n## 外部资料与实现约束\n无\n`
  if (path === "proposal.md")
    return `# Order export\n\n## Capabilities\n\n- \`orders\`: Describe a deterministic local CSV export.\n\n## Out of Scope\nNo code delivery or test acceptance.\n`
  if (path === "specs/orders/spec.md")
    return `# Orders\n\n### Requirement REQ-001: Export orders\nThe export SHALL contain id and amount columns.\n\n#### Scenario SCN-001: Export succeeds\n- **WHEN** a user exports a local order\n- **THEN** it appears in the CSV\n`
  if (path === "UI_CONTEXT.json")
    return JSON.stringify({
      version: 1,
      featureId: feature,
      uiRequired: false,
      decisionStatus: "locked",
      decisionSource: "user_confirmed",
      notApplicableReason: "Explicit API-only local contract example; no UI is requested.",
      lockedAtCheckpoint: "specs_done",
      pages: [],
      interactions: [],
      visualSources: [],
      capabilities: []
    })
  throw Error(
    `Provide real controlled input for ${path} through --artifacts; no fabricated report fallback`
  )
}
function outputs(node: NodeDefinition) {
  return (node.artifacts.outputs ?? [])
    .filter((item) => item.required !== false)
    .map((item) => {
      if (item.path === "specs/**/*.md") return "specs/orders/spec.md"
      assert(!item.path.includes("*"), `Unsupported fixture output ${item.path}`)
      return item.path
    })
}
function transition(execution: Execution, checkpoint: string) {
  const q = (path: string) => `"${path.replaceAll("\\", "/")}"`
  const command = `python -B -X utf8 ${q(join(execution.pluginPath, "hooks/update_checkpoint.py"))} --feature ${execution.feature} --checkpoint ${checkpoint} --json`
  authorizedCommands.add(command)
  return { command, cwd: execution.projectRoot }
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    assert(requests.length < 100, "No uncontrolled inference retry")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert.equal(body.model, "business-mod-loopback")
    const text = body.messages
      .flatMap((item: { content: unknown }) =>
        typeof item.content === "string"
          ? [item.content]
          : Array.isArray(item.content)
            ? item.content.map((part) => part?.text ?? "")
            : []
      )
      .join("\n")
    const workspace = /The workspace root is: ([^\r\n]+)/
      .exec(text)?.[1]
      ?.trim()
      .replace(/^`|`$/g, "")
    assert(workspace)
    const execution = [...executions.values()].find(
      (item) => resolve(item.projectRoot) === resolve(workspace)
    )
    assert(execution, `Unexpected model workspace ${workspace}`)
    const statePath = join(execution.projectRoot, ".autobizdevops/state.json")
    const stateBytes = readFileSync(statePath)
    const record = JSON.parse(stateBytes.toString("utf8")).features[execution.feature]
    const index = execution.nodes.findIndex((node) => node.checkpoints.includes(record.checkpoint))
    assert(index >= 0, "Checkpoint must belong to an actually assembled node")
    const node = execution.nodes[index]
    const final = node.checkpoints.at(-1)!
    const tools = body.messages.filter((item: { role: string }) => item.role === "tool")
    const lastTool = tools.at(-1)
    let tool: string | undefined
    let input: Record<string, unknown> = {}
    if (execution.negative?.pending) {
      assert.equal(
        hash(stateBytes),
        execution.negative.digest,
        "Missing real outputs must not advance terminal state"
      )
      assert.match(String(lastTool?.content), /missing_required_artifacts/)
      assert.match(String(lastTool?.content), /Command failed with exit code 1/)
      execution.negative.pending = false
      execution.negative.verified = true
    }
    if (execution.bizValidation === "pending") {
      assert.equal(lastTool?.name, "execute")
      assert.match(String(lastTool?.content), /"ok"\s*:\s*true/)
      assert.match(String(lastTool?.content), /Command succeeded with exit code 0/)
      execution.bizValidation = "passed"
    }
    if (record.checkpoint === final) {
      if (!tools.length && execution.nodes[index + 1]) {
        tool = "execute"
        input = transition(execution, execution.nodes[index + 1].checkpoints[0])
      }
    } else {
      const featureRoot = join(execution.projectRoot, ".autobizdevops/features", execution.feature)
      const missing = outputs(node).find((path) => !existsSync(join(featureRoot, path)))
      if (index === execution.nodes.length - 1 && missing && !execution.negative) {
        execution.negative = { digest: hash(stateBytes), checkpoint: final, pending: true }
        tool = "execute"
        input = transition(execution, final)
      } else if (missing) {
        if (node.id === "user.docs-quality") {
          tool = "execute"
          const command = `python -B -X utf8 "${join(execution.pluginPath, "mods/business/user.docs-quality/check.py").replaceAll("\\", "/")}" build --feature-dir "${featureRoot.replaceAll("\\", "/")}"`
          authorizedCommands.add(command)
          input = { command, cwd: execution.projectRoot }
        } else {
          tool = "write_file"
          authorizedWriteFiles.add(resolve(join(featureRoot, missing)))
          input = {
            file_path: join(featureRoot, missing),
            content: document(missing, execution.feature)
          }
        }
      } else if (node.id === "biz.prd" && execution.bizValidation !== "passed") {
        tool = "execute"
        const command = `python -B -X utf8 "${join(execution.pluginPath, "skills/autobiz/hooks/biz_validate.py").replaceAll("\\", "/")}" prd --feature ${execution.feature} --json --draft`
        authorizedCommands.add(command)
        execution.bizValidation = "pending"
        input = { command, cwd: execution.projectRoot }
      } else {
        tool = "execute"
        input = transition(execution, final)
      }
    }
    requests.push({ workspace, node: node.id, checkpoint: record.checkpoint, tool, input })
    writeFileSync(
      join(runtimeEnvironment.isolated, `model-request-${requests.length}.json`),
      JSON.stringify(body, null, 2)
    )
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `business-${requests.length}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(input) }
            }
          ]
        }
      : {
          role: "assistant",
          content:
            "The controlled local document stage has ended. Original checks and host state determine its result; no code or business quality acceptance is claimed."
        }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: "business", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({ id: "business", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end("Controlled fixture rejected unexpected request")
  }
})

async function sourceZip(directory: string) {
  const snapshot = await snapshotDerivationSource(directory)
  const zip = new AdmZip()
  for (const file of snapshot.files) zip.addFile(file.path, file.bytes, "", file.mode & 0o777)
  return { name: snapshot.name, bytes: [...zip.toBuffer()] }
}
async function install(page: Page, bytes: number[], filename: string) {
  const result = await page.evaluate(
    ({ bytes, filename }) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, filename, "local"),
    { bytes, filename }
  )
  assert(result.success, result.error)
}
async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), 480000)
  try {
    const original = await sourceZip(source)
    const custom = await sourceZip(customSource)
    app = await createHeadlessProjectCompositionLaunch(root, assemblyEnvironment)()
    let page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.businessModAssembly))
    await install(page, original.bytes, "original-business-catalog.zip")
    await install(page, custom.bytes, "user-business-catalog.zip")
    const installed = await page.evaluate(() => window.api.plugins.list())
    const originalPlugin = installed.find((item) => item.name === original.name)!
    const customPlugin = installed.find((item) => item.name === custom.name)!
    assert(originalPlugin && customPlugin)
    const scope = await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Business Mods assembly",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      return { threadId: thread.thread_id, expectedWorkspace: workspace }
    }, assemblyEnvironment.workspace)
    const inspected = await page.evaluate(
      async ({ scope, originalId, customId }) => ({
        original: await window.api.businessModAssembly.inspect({ ...scope, pluginId: originalId }),
        custom: await window.api.businessModAssembly.inspect({ ...scope, pluginId: customId })
      }),
      { scope, originalId: originalPlugin.id, customId: customPlugin.id }
    )
    assert(inspected.original && inspected.custom)
    const prd = inspected.original.mods.find((mod) => mod.nodeId === "biz.prd")!
    const specs = inspected.original.mods.find((mod) => mod.nodeId === "dev.specs")!
    assert(prd && specs && inspected.custom.mods.length === 1)
    const deliveries: Array<{
      name: string
      path: string
      nodeIds: string[]
      originalPluginId: string
    }> = []
    for (const [index, customIncluded] of [false, true].entries()) {
      const name = `business-${customIncluded ? "custom" : "light"}-${Date.now()}`
      const request = {
        name,
        version: "1.0.0",
        sources: [
          { inspectionId: inspected.original.id, modIds: [prd.id, specs.id] },
          ...(customIncluded
            ? [{ inspectionId: inspected.custom.id, modIds: [inspected.custom.mods[0].id] }]
            : [])
        ]
      }
      const preview = await page.evaluate(
        ({ scope, request }) => window.api.businessModAssembly.preview({ ...scope, request }),
        { scope, request }
      )
      assert(preview.valid)
      assert.deepEqual(
        preview.steps.map((step) => step.id),
        [prd.id, specs.id, ...(customIncluded ? [inspected.custom.mods[0].id] : [])]
      )
      const copy = await page.evaluate(
        ({ scope, previewId, requestId }) =>
          window.api.businessModAssembly.create({ ...scope, previewId, requestId }),
        { scope, previewId: preview.previewId, requestId: randomUUID() }
      )
      const checked = await page.evaluate(
        ({ scope, copyId, expectedDigest }) =>
          window.api.businessModAssembly.check({ ...scope, copyId, expectedDigest }),
        { scope, copyId: copy.copyId, expectedDigest: copy.digest }
      )
      const installedCopy = await page.evaluate(
        ({ scope, copyId, expectedDigest }) =>
          window.api.businessModAssembly.install({ ...scope, copyId, expectedDigest }),
        { scope, copyId: checked.copyId, expectedDigest: checked.digest }
      )
      assert(installedCopy.pluginId && installedCopy.pluginId !== originalPlugin.id)
      const path = join(assemblyEnvironment.isolated, `business-plugin-${index}.zip`)
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      }, path)
      await page.evaluate(
        ({ scope, copyId, expectedDigest }) =>
          window.api.businessModAssembly.export({ ...scope, copyId, expectedDigest }),
        { scope, copyId: checked.copyId, expectedDigest: checked.digest }
      )
      assert(existsSync(path))
      const archive = new AdmZip(path)
      const lock = JSON.parse(archive.readAsText("devclaw.business-assembly.json"))
      assert.equal(lock.name, name)
      assert(
        !JSON.stringify(lock).includes(originalPlugin.id) &&
          !JSON.stringify(lock).includes(customPlugin.id)
      )
      deliveries.push({
        name,
        path,
        nodeIds: preview.steps.map((step) => step.id),
        originalPluginId: installedCopy.pluginId
      })
    }
    await app.close()
    app = await createHeadlessProjectCompositionLaunch(root, runtimeEnvironment)()
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard))
    for (const delivery of deliveries)
      await install(page, [...readFileSync(delivery.path)], "assembled-independent.zip")
    const freshPlugins = await page.evaluate(() => window.api.plugins.list())
    assert.equal(freshPlugins.length, 2, "Fresh installation needs no original catalog/plugin UUID")
    assert(!freshPlugins.some((item) => [original.name, custom.name].includes(item.name)))
    await page.evaluate(async (url) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({
        id: "business-mod-loopback",
        name: "Local document fixture",
        baseUrl: url,
        model: "business-mod-loopback",
        apiKey: "local-fixture",
        maxTokens: 64000,
        maxOutputTokens: 2048
      })
      await window.api.models.setDefault("custom:business-mod-loopback")
    }, `http://127.0.0.1:${address.port}/v1`)
    for (const [index, delivery] of deliveries.entries()) {
      const plugin = freshPlugins.find((item) => item.name === delivery.name)!
      assert(plugin && plugin.id !== delivery.originalPluginId)
      await page.evaluate((id) => window.api.plugins.setEnabled(id, true), plugin.id)
      const project = await page.evaluate(
        ({ pluginId, workspace, index }) =>
          window.api.harnessBoard.createProject({
            adapterId: pluginId,
            adapterType: "plugin",
            name: `Assembled project ${index}`,
            projectCode: `ASSEMBLY${index}`,
            projectFromLean: false,
            projectDir: `assembled-${index}`,
            description: "Run actual selected business Mods only",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace
          }),
        { pluginId: plugin.id, workspace: runtimeEnvironment.workspace, index }
      )
      const projectRoot = join(runtimeEnvironment.workspace, `assembled-${index}`)
      assert(
        !relative(runtimeEnvironment.isolated, projectRoot).startsWith("..") &&
          !isAbsolute(relative(runtimeEnvironment.isolated, projectRoot))
      )
      const board = JSON.parse(
        readFileSync(join(plugin.path, "board_core/board_config.json"), "utf8")
      )
      assert.deepEqual(
        board.workflow.nodes.map((node: NodeDefinition) => node.id),
        delivery.nodeIds
      )
      assert(
        !board.workflow.nodes.some((node: NodeDefinition) =>
          ["dev.code", "ops.archive"].includes(node.id)
        )
      )
      executions.set(projectRoot, {
        pluginPath: plugin.path,
        projectRoot,
        feature: "assembly-demo",
        nodes: board.workflow.nodes
      })
      await page.evaluate(
        ({ projectId, projectRoot }) =>
          window.api.harnessBoard.createFeature({
            projectId,
            feature: "assembly-demo",
            sessionContextInjectionSource: "plugin",
            sessionWorkspace: { source: "directory", path: projectRoot }
          }),
        { projectId: project.projectId, projectRoot }
      )
      const started = await page.evaluate(
        ({ projectId, projectRoot }) =>
          window.api.harnessBoard.startManagedRun({
            projectId,
            featureId: "assembly-demo",
            workspacePath: projectRoot,
            initialUserMessage:
              "Draft the local order CSV requirement and behavioral specification. No code delivery or test acceptance. Execute only the selected business Mods and their original checks."
          }),
        { projectId: project.projectId, projectRoot }
      )
      let latest = started
      const answered = new Set<string>()
      for (let attempt = 0; attempt < 600; attempt++) {
        latest = (await page.evaluate(
          (projectId) => window.api.harnessBoard.getLatestManagedRun(projectId, "assembly-demo"),
          project.projectId
        ))!
        if (["completed", "failed", "cancelled"].includes(latest.status)) break
        if (latest.currentSession?.threadId) {
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            latest.currentSession.threadId
          )
          for (const item of pending as Array<{
            id: string
            tool_call: {
              id: string
              name: string
              args: { command?: string; file_path?: string; filePath?: string }
            }
          }>) {
            if (answered.has(item.id)) continue
            assert(
              (item.tool_call.name === "execute" &&
                item.tool_call.args.command &&
                authorizedCommands.has(item.tool_call.args.command)) ||
                (item.tool_call.name === "write_file" &&
                  (item.tool_call.args.file_path ?? item.tool_call.args.filePath) &&
                  authorizedWriteFiles.has(
                    resolve((item.tool_call.args.file_path ?? item.tool_call.args.filePath)!)
                  )),
              JSON.stringify(item)
            )
            answered.add(item.id)
            approvals.push(item)
            await page.evaluate(
              (item) =>
                window.api.sandbox.sendApprovalDecision({
                  requestId: item.id,
                  tool_call_id: item.tool_call.id,
                  type: "approve"
                }),
              item
            )
          }
        }
        await new Promise((done) => setTimeout(done, 250))
      }
      const events = await page.evaluate(
        ({ projectId, runId }) =>
          window.api.harnessBoard.getManagedRunEvents({
            projectId,
            featureId: "assembly-demo",
            runId,
            limit: 500
          }),
        { projectId: project.projectId, runId: started.runId }
      )
      writeFileSync(
        join(runtimeEnvironment.isolated, `run-${index}.json`),
        JSON.stringify({ latest, events }, null, 2)
      )
      assert.equal(latest.status, "completed", JSON.stringify(latest))
      assert(events.events.some((event) => event.type === "run_completed"))
      assert(
        executions.get(projectRoot)!.negative?.verified,
        "Original terminal check must reject absent real outputs"
      )
      assert.equal(executions.get(projectRoot)!.bizValidation, "passed")
      const detail = await page.evaluate(
        (projectId) => window.api.harnessBoard.getRunDetail(projectId, "assembly-demo"),
        project.projectId
      )
      assert.equal(detail.run.currentNodeId, delivery.nodeIds.at(-1))
      assert.equal(detail.run.featureStatus, "done")
      assert(detail.run.nodes.every((node) => node.nodeStatus === "done"))
      for (const node of board.workflow.nodes as NodeDefinition[])
        for (const path of outputs(node))
          assert(existsSync(join(projectRoot, ".autobizdevops/features/assembly-demo", path)))
      if (delivery.nodeIds.includes("user.docs-quality")) {
        const featureRoot = join(projectRoot, ".autobizdevops/features/assembly-demo")
        const report = JSON.parse(readFileSync(join(featureRoot, "DELIVERY_QUALITY.json"), "utf8"))
        assert.equal(report.businessAcceptance, "needs_review")
        assert.equal(report.documents.length, 3)
        for (const item of report.documents) {
          const bytes = readFileSync(join(featureRoot, item.path))
          assert.equal(item.sha256, hash(bytes))
          assert.equal(item.bytes, bytes.length)
        }
      }
    }
    assert.equal(errors.length, 0, errors.join("\n"))
    writeFileSync(
      join(runtimeEnvironment.isolated, "evidence.json"),
      JSON.stringify(
        {
          candidate,
          deliveries,
          requests,
          approvals,
          executions: [...executions.values()],
          boundaries: [
            "Real Electron IPC, package builder, export and independent installation",
            "Real original initialization, stages, validators, state and ManagedRun journal",
            "Controlled local document inputs only; no business or code quality acceptance"
          ]
        },
        null,
        2
      )
    )
    console.log(
      `PASS business Mods assembly and independent native execution: ${runtimeEnvironment.isolated}`
    )
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
