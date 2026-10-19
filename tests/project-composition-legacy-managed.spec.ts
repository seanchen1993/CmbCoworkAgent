/** Real original lean ManagedRun through production IPC and loopback SSE.
 * This validates the legacy engine, not internal composition/catalog admission.
 * Only external MCP declarations are disabled in the local fixture copy.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve, relative, isAbsolute } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import type { BrowserWindow as ElectronBrowserWindow } from "electron"
import { withPinnedAutobiz } from "../src/main/mods/v2/autobiz-source"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = { mainModified: statSync(join(root, "out/main/index.js")).mtime.toISOString() }
const driver = join(fixture.isolated, "local-legacy-driver.py")
const requests: Array<{ checkpoint: string; tool: boolean; stage: string }> = []
const errors: string[] = []
const approvals: unknown[] = []
const approvalIds = new Set<string>()
const authorizedCommands = new Set<string>()
let installedSource = ""
let projectRoot = ""
let app: ElectronApplication | undefined
writeFileSync(
  driver,
  `import json,os,runpy,subprocess,sys
from pathlib import Path
source=Path(sys.argv[1]); root=Path(sys.argv[2]); stage=sys.argv[3]
sys.path.insert(0,str(source))
assert root.name=='legacy-project'
f=root/'.autobizdevops/features/demo'
state=root/'.autobizdevops/state.json'
env=dict(os.environ,PLUGIN_WORKSPACE=str(root.parent),PROJECT_DIR=root.name)
def transition(value):
    subprocess.run([sys.executable,'-I','-B','-X','utf8',str(source/'hooks/update_checkpoint.py'),'--feature','demo','--checkpoint',value],env=env,check=True)
if stage=='specs':
    v=runpy.run_path(str(source/'tests/test_artifact_contracts.py'))
    (f/'specs/order-export').mkdir(parents=True,exist_ok=True)
    (f/'proposal.md').write_text(v['PROPOSAL_OK'],encoding='utf-8')
    (f/'specs/order-export/spec.md').write_text(v['SPEC_OK'],encoding='utf-8')
    transition('specs_done')
elif stage=='code':
    transition('code_in_progress')
    transition('code_done')
elif stage=='archive':
    transition('archived')
else: raise ValueError(stage)
print('LOCAL_LEGACY_STEP_DONE',stage)
`
)
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    assert.equal(body.model, "legacy-loopback")
    assert(requests.length < 18, "No uncontrolled inference retry")
    const messages = body.messages as Array<{ role: string; content: unknown }>
    const prompt = JSON.stringify(messages.filter((item) => item.role === "user").at(-1))
    const checkpoint = JSON.parse(
      readFileSync(join(projectRoot, ".autobizdevops/state.json"), "utf8")
    ).features.demo.checkpoint
    const stage = prompt.includes("autodev-code")
      ? "code"
      : prompt.includes("autoops-archive")
        ? "archive"
        : "specs"
    const completed =
      stage === "specs"
        ? checkpoint === "specs_done"
        : stage === "code"
          ? checkpoint === "code_done"
          : checkpoint === "archived"
    const tool = !completed
    requests.push({ checkpoint, tool, stage })
    writeFileSync(
      join(fixture.isolated, `request-${requests.length}.json`),
      JSON.stringify(body, null, 2)
    )
    const command = `python -I -B -X utf8 "${driver.replaceAll("\\", "/")}" "${installedSource.replaceAll("\\", "/")}" "${projectRoot.replaceAll("\\", "/")}" ${stage}`
    authorizedCommands.add(command)
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `local-legacy-${requests.length}`,
              type: "function",
              function: {
                name: "execute",
                arguments: JSON.stringify({ command, cwd: projectRoot })
              }
            }
          ]
        }
      : { role: "assistant", content: "Local legacy stage completed with original script checks." }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: "legacy-loopback", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({ id: "legacy-loopback", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`
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
  const watchdog = setTimeout(() => void app?.close(), 180000)
  try {
    await withPinnedAutobiz(undefined, async (source) => {
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
      await page.waitForFunction(() => Boolean(window.api?.harnessBoard))
      const surfaces = await app.evaluate(({ BrowserWindow, webContents }) => ({
        className: BrowserWindow.name,
        windows: BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          webContents: w.webContents.id,
          url: w.webContents.getURL(),
          constructor: w.constructor.name
        })),
        baseWindows: Object.getPrototypeOf(BrowserWindow)
          .getAllWindows?.()
          .map((w: Pick<ElectronBrowserWindow, "id" | "webContents">) => ({ id: w.id, webContents: w.webContents.id })),
        contents: webContents
          .getAllWebContents()
          .map((w) => ({ id: w.id, type: w.getType(), url: w.getURL() }))
      }))
      writeFileSync(join(fixture.isolated, "surfaces.json"), JSON.stringify(surfaces, null, 2))
      if (process.env.COMPOSITION_E2E_LEGACY_DIAG === "1") {
        console.log(fixture.isolated, surfaces)
        return
      }
      assert(
        surfaces.windows.some((window) =>
          surfaces.contents.some(
            (content) => content.id === window.webContents && content.type === "window"
          )
        ),
        "Approval acceptance requires an original registered BrowserWindow"
      )
      const scope = await page.evaluate(
        async ({ bytes, workspace, url }) => {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "legacy-fixture.zip",
            "local"
          )
          if (!result.success) throw Error(result.error)
          const plugin = (await window.api.plugins.list()).find(
            (item) => item.name === "AutobizDevOps_Plugin_Kanban_latest"
          )!
          if (!plugin) throw Error("Missing pinned fixture plugin")
          for (const mcp of await window.api.mcp.list())
            await window.api.mcp.setEnabled(mcp.id, false)
          await window.api.autoCommit.saveSettings({ mode: "off", push: false })
          await window.api.models.setCustomConfig({
            id: "legacy-loopback",
            name: "Local legacy fixture",
            baseUrl: url,
            model: "legacy-loopback",
            apiKey: "local-fixture",
            maxTokens: 64000,
            maxOutputTokens: 2048
          })
          await window.api.models.setDefault("custom:legacy-loopback")
          const project = await window.api.harnessBoard.createProject({
            adapterId: plugin.id,
            adapterType: "plugin",
            name: "Local legacy fixture",
            projectCode: "LEGACYLOCAL",
            projectFromLean: false,
            projectDir: "legacy-project",
            description: "No external business",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace
          })
          await window.api.harnessBoard.createFeature({
            projectId: project.projectId,
            feature: "demo",
            workflowTemplate: "lean",
            workflowConfig: (await window.api.harnessBoard.getDynamicWorkflowConfig(
              project.projectId
            ))!,
            sessionContextInjectionSource: "plugin",
            sessionWorkspace: { source: "directory", path: workspace + "/legacy-project" }
          })
          return { projectId: project.projectId, pluginPath: plugin.path }
        },
        {
          bytes: [...zip.toBuffer()],
          workspace: fixture.workspace,
          url: `http://127.0.0.1:${address.port}/v1`
        }
      )
      installedSource = scope.pluginPath
      projectRoot = join(fixture.workspace, "legacy-project")
      const below = relative(fixture.isolated, projectRoot)
      assert(below && !below.startsWith("..") && !isAbsolute(below))
      const run = await page.evaluate(
        ({ projectId, workspacePath }) =>
          window.api.harnessBoard.startManagedRun({
            projectId,
            featureId: "demo",
            workspacePath,
            initialUserMessage: "Run the isolated local lean fixture. No external systems."
          }),
        { projectId: scope.projectId, workspacePath: projectRoot }
      )
      let latest = run
      for (let i = 0; i < 480; i++) {
        latest = (await page.evaluate(
          (projectId) => window.api.harnessBoard.getLatestManagedRun(projectId, "demo"),
          scope.projectId
        ))!
        if (["completed", "failed", "cancelled"].includes(latest.status)) break
        const threadId = latest.currentSession?.threadId
        if (threadId) {
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            threadId
          )
          for (const item of pending as Array<{
            id: string
            tool_call: { id: string; name: string; args: { command: string } }
          }>) {
            if (approvalIds.has(item.id)) continue
            assert.equal(item.tool_call.name, "execute")
            assert(
              authorizedCommands.has(item.tool_call.args.command),
              "Only the exact local fixture command may be approved"
            )
            approvalIds.add(item.id)
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
      writeFileSync(join(fixture.isolated, "managed-run.json"), JSON.stringify(latest, null, 2))
      const events = await page.evaluate(
        ({ projectId, runId }) =>
          window.api.harnessBoard.getManagedRunEvents({
            projectId,
            featureId: "demo",
            runId,
            limit: 500
          }),
        { projectId: scope.projectId, runId: run.runId }
      )
      writeFileSync(join(fixture.isolated, "managed-events.json"), JSON.stringify(events, null, 2))
      assert.equal(latest.status, "completed", JSON.stringify(latest))
      assert.equal(
        JSON.parse(readFileSync(join(projectRoot, ".autobizdevops/state.json"), "utf8")).features
          .demo.checkpoint,
        "archived"
      )
      assert(events.events.some((item) => item.type === "run_completed"))
      assert.equal(errors.length, 0, errors.join("\n"))
      for (const path of [
        "hooks/init_workspace.py",
        "hooks/update_checkpoint.py",
        "hooks/state_checkpoint.py",
        "hooks/hooks.json",
        "board_core/board_config.json",
        "skills/autodev/hooks/artifact_check.py"
      ])
        assert.deepEqual(
          await readFile(join(installedSource, path)),
          await readFile(join(source, path)),
          `Original runtime file changed: ${path}`
        )
      assert(existsSync(join(projectRoot, ".autobizdevops/features/demo/proposal.md")))
      console.log(
        `PASS original lean ManagedRun + real init/create/IPC/SSE/tools/hooks: ${fixture.isolated}`
      )
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
          execution: "built-output original ManagedRun; not composition admission or ASAR",
          candidate,
          fixtureChanges: ["external MCP declarations disabled"],
          requests,
          approvals,
          errors
        },
        null,
        2
      )
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
