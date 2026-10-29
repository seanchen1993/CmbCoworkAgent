/** Real production Electron: traditional Plugin and Harness IPC, no Mods manifest/model/network. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { SavedFlow } from "../src/shared/mods/flows/types"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { waitForAsyncEvidence } from "./support/async-evidence"
import {
  closeModsProgress,
  openModsFlowPreset,
  openModsProgress
} from "./support/mods-sidebar-navigation"

const root = resolve(__dirname, "..")
const requireLocal = createRequire(join(root, "package.json"))
const binary = requireLocal("electron") as string
const isolated = mkdtempSync(join(tmpdir(), "cmb-legacy-plugin-e2e-"))
const requestedArtifacts =
  process.env.CMB_MODS_CORE_E2E_ARTIFACTS ?? process.env.CMB_LEGACY_PLUGIN_E2E_ARTIFACTS
const artifacts = requestedArtifacts
  ? resolve(requestedArtifacts)
  : join(root, "output/legacy-plugin-project-e2e")
const workspace = join(isolated, "workspace")
mkdirSync(workspace, { recursive: true })
mkdirSync(artifacts, { recursive: true })
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (
    value &&
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
      key
    )
  )
    env[key] = value
}
for (const [key, folder] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  CMB_COWORK_AGENT_HOME: "data",
  TEMP: "temp",
  TMP: "temp"
})) {
  env[key] = join(isolated, folder)
  mkdirSync(env[key], { recursive: true })
}
Object.assign(env, {
  CMB_E2E_DISABLE_GPU: "1",
  CMB_E2E_ELECTRON_BIN: binary,
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost"
})
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)

const name = "Legacy Project Fixture"
const zip = new AdmZip()
zip.addFile(
  "plugin.json",
  Buffer.from(
    JSON.stringify({
      name,
      version: "1.0.0",
      author: "E2E",
      description: "Traditional plugin without Mods"
    })
  )
)
zip.addFile(
  "skills/legacy-review/SKILL.md",
  Buffer.from(
    "---\nname: legacy-review\ndescription: Legacy review fixture\n---\n# Legacy skill\nReview the project."
  )
)
zip.addFile(
  "hooks/hooks.json",
  Buffer.from(
    JSON.stringify([
      {
        id: "legacy-stop",
        event: "Stop",
        type: "command",
        command: "echo LEGACY_HOOK",
        enabled: true
      }
    ])
  )
)
zip.addFile(
  ".mcp.json",
  Buffer.from(
    JSON.stringify({
      mcpServers: { "legacy-local": { command: process.execPath, args: ["-e", "process.exit(0)"] } }
    })
  )
)
// This adapter executes for real through production argv/worker paths. Its output is local fixture data.
zip.addFile(
  "adapter.cjs",
  Buffer.from(`
const fs = require("node:fs"), path = require("node:path")
const [mode, workspace, project, feature] = process.argv.slice(2)
const projectRoot = path.join(workspace, project)
const workflow = {display:{mode:"ordered_nodes",groupBy:"group"},nodes:[{id:"review",label:"Legacy review",group:"work",artifactDefinitions:[{id:"report",artifactType:"markdown",required:true}]}]}
const run = {featureId:"legacy-feature",featureName:"Legacy feature",currentNodeId:"review",currentNodeStatus:"done",nodes:[{id:"review",nodeStatus:"done",artifacts:[{id:"report",path:"docs/report.md",artifactStatus:"generated"}]}]}
if (mode === "createProject") {fs.mkdirSync(path.join(projectRoot,"docs"),{recursive:true});fs.writeFileSync(path.join(projectRoot,"docs/report.md"),"# LEGACY_ARTIFACT\\n");console.log("created")}
else if(mode === "createFeature") {fs.writeFileSync(path.join(projectRoot,"feature.txt"),feature);console.log("created")}
else if(mode === "project") { console.log(JSON.stringify({workflow,projects:{[project]:{runs:[run],watchRefs:[]}}})) }
else if(mode === "run") { console.log(JSON.stringify({workflow,run})) }
else throw Error("unexpected adapter mode: "+mode)
`)
)
const invoke = '"' + process.execPath.replaceAll("\\", "/") + '" "${pluginPath}/adapter.cjs"'
zip.addFile(
  "board_core/board_config.json",
  Buffer.from(
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: {
          create_project: invoke + ' createProject "${pluginWorkspace}" "${projectDir}"',
          create_feature:
            invoke + ' createFeature "${pluginWorkspace}" "${projectDir}" "${feature}"',
          project_status: invoke + ' project "${pluginWorkspace}" ${projectDirs...}',
          feature_status: invoke + ' run "${pluginWorkspace}" "${projectDir}" "${feature}"'
        }
      }
    })
  )
)

const checks: string[] = []
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page
function pass(label: string) {
  checks.push(label)
  console.log("PASS " + label)
}
async function boot() {
  app = await launchApp(60000)
  page = await app.firstWindow()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api?.plugins && window.api?.harnessBoard))
}
async function main() {
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 180000)
  let pluginId = "",
    projectId = ""
  try {
    await boot()
    assert.equal(await page.evaluate(() => window.api.mods.globalEnabled()), false)
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    await page.getByRole("button", { name: "插件", exact: true }).click()
    await page.getByRole("button", { name: "导入与发布", exact: true }).click()
    await page.getByText("暂无安装的插件", { exact: true }).waitFor()
    const installed = await page.evaluate(
      (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "legacy.zip", "local"),
      [...zip.toBuffer()]
    )
    assert.equal(installed.success, true, installed.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (row) => row.name === name
    )!
    assert(plugin)
    pluginId = plugin.id
    assert.equal(plugin.modCount ?? 0, 0)
    const detail = await page.evaluate((id) => window.api.plugins.getDetail(id), pluginId)
    assert.equal(detail.skills.length, 1)
    assert.equal(detail.mcpServers.length, 1)
    assert.equal(detail.hooks.length, 1)
    assert.equal(detail.hookCount, 1)
    const hookId = detail.hooks[0].id
    assert(
      (await page.evaluate(() => window.api.skills.listPlugins())).some(
        (row) => row.name === "legacy-review"
      )
    )
    assert(
      (await page.evaluate(() => window.api.plugins.listHooks())).some((row) => row.id === hookId)
    )
    assert(
      (await page.evaluate(() => window.api.harnessBoard.registry())).some(
        (row) => row.id === pluginId
      )
    )
    pass(
      "Mods default off: traditional ZIP install, Skill/Hook/MCP metadata and Harness adapter discoverable"
    )

    await page.getByText(name, { exact: true }).first().waitFor()
    const pluginRow = page
      .getByRole("button")
      .filter({ has: page.getByText(name, { exact: true }) })
    assert.equal(await pluginRow.count(), 1)
    await page.screenshot({ path: join(artifacts, "legacy-plugin.png") })
    pass("traditional Plugin remains visible in its original UI navigation")

    assert.equal(
      (
        await page.evaluate(({ id, hook }) => window.api.plugins.setHookEnabled(id, hook, false), {
          id: pluginId,
          hook: hookId
        })
      ).success,
      true
    )
    const disabledHook = (await page.evaluate((id) => window.api.plugins.getDetail(id), pluginId))
      .hooks[0]
    assert.equal(disabledHook.enabled, false)
    await page.evaluate(({ id, hook }) => window.api.plugins.setHookEnabled(id, hook, true), {
      id: pluginId,
      hook: hookId
    })
    await page.evaluate((id) => window.api.plugins.setEnabled(id, false), pluginId)
    const disabledName = pluginRow.locator("span.text-sm.font-medium.text-muted-foreground")
    await disabledName.waitFor()
    assert.equal(await disabledName.innerText(), name)
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).find((row) => row.id === pluginId)
        ?.enabled,
      false
    )
    assert(
      !(await page.evaluate(() => window.api.skills.listPlugins())).some(
        (row) => row.name === "legacy-review"
      )
    )
    assert(
      !(await page.evaluate(() => window.api.plugins.listHooks())).some((row) => row.id === hookId)
    )
    await page.evaluate((id) => window.api.plugins.setEnabled(id, true), pluginId)
    const enabledName = pluginRow.locator("span.text-sm.font-medium:not(.text-muted-foreground)")
    await enabledName.waitFor()
    assert.equal(await enabledName.innerText(), name)
    assert(
      (await page.evaluate(() => window.api.skills.listPlugins())).some(
        (row) => row.name === "legacy-review"
      )
    )
    pass(
      "traditional Hook and Plugin enable/disable invalidates Skill/Hook catalogs without Mods permission"
    )

    const project = await page.evaluate((input) => window.api.harnessBoard.createProject(input), {
      adapterId: pluginId,
      adapterType: "plugin" as const,
      name: "Legacy E2E Project",
      projectCode: "LEGACYE2E",
      projectFromLean: false,
      projectDir: "legacy-project",
      description: "Local regression fixture",
      systemId: "legacy",
      systemName: "Legacy",
      workspacePath: workspace
    })
    projectId = project.projectId
    assert.equal(project["harness-adapter"].id, pluginId)
    const feature = await page.evaluate(
      ({ projectId, workspace }) =>
        window.api.harnessBoard.createFeature({
          projectId,
          feature: "legacy-feature",
          sessionWorkspace: { source: "directory", path: workspace }
        }),
      { projectId, workspace }
    )
    assert.equal(feature.slug, "legacy-feature")
    assert.equal(
      readFileSync(join(workspace, "legacy-project/feature.txt"), "utf8"),
      "legacy-feature"
    )
    const projectDetail = await page.evaluate(
      (id) => window.api.harnessBoard.getProjectDetail(id),
      projectId
    )
    assert.equal(projectDetail.error, null)
    assert.equal(projectDetail.runs.length, 1)
    const run = await page.evaluate(
      (id) => window.api.harnessBoard.getRunDetail(id, "legacy-feature"),
      projectId
    )
    assert.equal(run.run.slug, "legacy-feature")
    assert.deepEqual(run.run.sessionWorkspace, { source: "directory", path: workspace })
    assert.equal(run.run.resolvedSessionWorkspacePath, workspace)
    assert.equal(run.run.nodes[0].artifacts.length, 1)
    assert(run.artifactPreviewGrant)
    const filePath = join(workspace, "legacy-project/docs/report.md")
    const preview = await page.evaluate(
      ({ grant, filePath }) =>
        window.api.workspace.readFilePreview({
          source: { externalGrant: grant, filePath },
          lane: "legacy-e2e",
          requestToken: "read-1"
        }),
      { grant: run.artifactPreviewGrant, filePath }
    )
    assert.equal(preview.success, true)
    assert("content" in preview && preview.content.includes("LEGACY_ARTIFACT"))
    const outside = await page.evaluate(
      ({ grant, filePath }) =>
        window.api.workspace.readFilePreview({
          source: { externalGrant: grant, filePath },
          lane: "legacy-e2e",
          requestToken: "read-2"
        }),
      { grant: run.artifactPreviewGrant, filePath: join(workspace, "legacy-project/feature.txt") }
    )
    assert.equal(outside.success, false)
    pass(
      "real adapter argv creates project/feature; worker projects run; artifact grant reads only published artifact"
    )

    await app!.close()
    app = undefined
    await boot()
    assert.equal(
      (await page.evaluate(() => window.api.plugins.list())).find((row) => row.id === pluginId)
        ?.enabled,
      true
    )
    assert(
      (await page.evaluate(() => window.api.harnessBoard.listProjects())).some(
        (row) => row.projectId === projectId
      )
    )
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.harnessBoard.getRunDetail(id, "legacy-feature"),
          projectId
        )
      ).run.slug,
      "legacy-feature"
    )
    pass("restart preserves Plugin, project adapter binding, feature and artifact data")

    assert.equal(await page.evaluate(() => window.api.mods.configureGlobal(true)), true)
    assert(
      (await page.evaluate(() => window.api.skills.listPlugins())).some(
        (row) => row.name === "legacy-review"
      )
    )
    assert(
      (await page.evaluate(() => window.api.plugins.listHooks())).some((row) => row.id === hookId)
    )
    assert.equal(
      (await page.evaluate((id) => window.api.harnessBoard.getProjectDetail(id), projectId)).error,
      null
    )
    assert.equal(
      (
        await page.evaluate(
          (id) => window.api.harnessBoard.getRunDetail(id, "legacy-feature"),
          projectId
        )
      ).run.slug,
      "legacy-feature"
    )
    pass("Mods globally on with no project grants leaves traditional Plugin/Harness paths usable")
    await page.screenshot({ path: join(artifacts, "restart-global-mods-on.png") })
    for (const kind of ["project", "feature"] as const) {
      const threadId = await page.evaluate(
        async ({ workspace, projectId, kind }) => {
          const thread = await window.api.threads.create({
            title: `Legacy ${kind} Flow`,
            workspacePath: workspace,
            agentMode: "normal",
            ...(kind === "feature"
              ? { harnessFeature: { projectId, slug: "legacy-feature", source: "autobizdevops" } }
              : { harnessProjectSession: { projectId, kind: "knowledge" } })
          })
          await window.api.workspace.set(thread.thread_id, workspace)
          await window.api.mods.configure(thread.thread_id, true, true)
          return thread.thread_id
        },
        { workspace, projectId, kind }
      )
      const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadId)
      assert.equal(catalog.available, true)
      assert.equal(catalog.hostAvailable, true)
      const saved = await page.evaluate(
        ({ id, kind }) =>
          window.api.mods.flowSave(
            id,
            {
              schemaVersion: 2,
              execution: { kind: "host" },
              id: `legacy-${kind}`,
              name: `Legacy ${kind}`,
              goal: "Verify a native Flow can coexist with the trusted legacy project binding",
              timeoutMs: 30000,
              maxExecutions: 4,
              steps: [
                {
                  id: "confirm",
                  name: "人工确认",
                  kind: "approval",
                  enabled: true,
                  prompt: "Confirm the legacy project binding before continuing"
                }
              ]
            },
            0
          ),
        { id: threadId, kind }
      )
      const binding = await page.evaluate(
        async ({ id, savedJson, kind }) => {
          const saved: SavedFlow = JSON.parse(savedJson)
          let view = await window.api.mods.clawView(id)
          if (!view.applicable) throw Error("Trusted Harness Claw unexpectedly blocked")
          view = await window.api.mods.clawChange(id, {
            kind: "save",
            workspace: view.workspace,
            revision: view.revision,
            profile: { id: `legacy-${kind}`, name: `Legacy ${kind}`, capabilities: [], flow: saved }
          })
          return window.api.mods.clawChange(id, {
            kind: "apply",
            workspace: view.workspace,
            revision: view.revision,
            bindingRevision: view.bindingRevision,
            id: `legacy-${kind}`
          })
        },
        { id: threadId, savedJson: JSON.stringify(saved), kind }
      )
      let run: { id: string }
      if (kind === "feature") {
        // Navigate the actual project surface: this catches both the chat eligibility guard
        // and the App-level sidebar portal, which an IPC-only run cannot exercise.
        await page.reload()
        const back = page.getByRole("button", { name: "返回会话", exact: true })
        const projects = page.getByRole("tab", { name: "项目模式", exact: true })
        await Promise.race([back.waitFor(), projects.waitFor()])
        if (await back.isVisible()) await back.click()
        await projects.click()
        // This isolated profile enters project mode for the first time; acknowledge its guide
        // through the visible UI before selecting the feature behind the modal overlay.
        const guide = page.getByRole("dialog", { name: "项目模式使用引导", exact: true })
        await guide.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
        await guide.waitFor({ state: "hidden" })
        await page.getByText("Legacy feature Flow", { exact: true }).first().click()
        const selection = await openModsFlowPreset(page)
        await selection.selectOption(`claw:${binding.bindingRevision}`)
        assert.equal(await selection.inputValue(), `claw:${binding.bindingRevision}`)
        assert.equal(
          (await page.evaluate((id) => window.api.mods.flowRuns(id), threadId)).length,
          0
        )
        await closeModsProgress(page)
        await page.locator("textarea.composer-textarea").fill("Verify legacy project Flow from UI")
        await page.getByRole("button", { name: "发送消息", exact: true }).click()
        run = (await waitForAsyncEvidence(
          () => page.evaluate((id) => window.api.mods.flowRuns(id), threadId),
          rows => rows.length > 0,
          "legacy feature flow started through the actual UI",
          30_000
        ))[0]
        await page.screenshot({ path: join(artifacts, "harness-feature-claw-flow.png") })
      } else {
        run = await page.evaluate(
          ({ id, revision }) =>
            window.api.mods.clawStart(id, revision, "Verify legacy project Flow"),
          { id: threadId, revision: binding.bindingRevision }
        )
      }
      const deadline = Date.now() + 30000
      let waiting: Awaited<ReturnType<typeof window.api.mods.flowRun>>
      do {
        waiting = await page.evaluate(
          ({ threadId, runId }) => window.api.mods.flowRun(threadId, runId),
          { threadId, runId: run.id }
        )
        if (waiting && ["waiting", "failed", "cancelled"].includes(waiting.status)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      assert.equal(waiting?.status, "waiting", JSON.stringify(waiting))
      assert.equal(waiting.pendingApproval?.stepId, "confirm")
      if (kind === "feature") {
        const progress = await openModsProgress(page)
        const current = progress.locator(`[data-flow-run="${run.id}"]`)
        await current.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
        await current.getByRole("button", { name: "停止任务", exact: true }).click()
      } else {
        await page.evaluate(({ threadId, runId }) => window.api.mods.flowCancel(threadId, runId), {
          threadId,
          runId: run.id
        })
      }
      await waitForAsyncEvidence(
        () => page.evaluate(({ threadId, runId }) => window.api.mods.flowRun(threadId, runId),
          { threadId, runId: run.id }),
        value => value?.status === "cancelled",
        "legacy flow cancellation persisted",
        30_000
      )
      pass(
        `Local legacy ${kind} binding supports Claw apply/start, real host preparation and approval/cancel`
      )
    }
    const removed = await page.evaluate((id) => window.api.plugins.delete(id), pluginId)
    assert.equal(removed.success, true, removed.error)
    assert(
      !(await page.evaluate(() => window.api.plugins.list())).some((row) => row.id === pluginId)
    )
    assert(
      (await page.evaluate(() => window.api.harnessBoard.listProjects())).some(
        (row) => row.projectId === projectId
      )
    )
    const missing = await page.evaluate(
      (id) => window.api.harnessBoard.getProjectDetail(id),
      projectId
    )
    assert(missing.error)
    assert.equal(readFileSync(filePath, "utf8"), "# LEGACY_ARTIFACT\n")
    pass(
      "uninstall preserves project/artifacts and produces a recoverable missing-adapter diagnostic"
    )
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          success: true,
          isolated,
          checks,
          pageErrors: errors,
          scope:
            "Production Electron/preload/IPC, local adapter child, worker, persisted stores and artifact capability",
          notCovered: ["external model execution", "live MCP tools", "business platform network"]
        },
        null,
        2
      )
    )
  } catch (error) {
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          isolated,
          checks,
          errors,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        null,
        2
      )
    )
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
