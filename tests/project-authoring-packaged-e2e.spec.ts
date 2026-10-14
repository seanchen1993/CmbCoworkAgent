/** Actual packaged SDK/tool/installer/Flow chain. All data and HTTP stay isolated. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { FlowRun } from "../src/shared/mods/flows/types"
import type { ProjectDevelopmentView } from "../src/main/mods/devtools/project-development-session"
import type { packProjectPlugin } from "../src/main/mods/devtools/project-tooling"
import type {
  LocalProjectCommand,
  LocalProjectView
} from "../src/shared/project-runtime/platform-api"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import {
  AUTHOR_PACKAGE_ID,
  startProjectAuthoringModel
} from "./support/project-authoring-model-fixture"

const root = resolve(__dirname, "..")
assert(
  process.env.CMB_MODS_PACKAGED_DIR?.trim(),
  "Select the newly built reviewed production package"
)
const artifacts = resolve(
  process.env.CMB_PROJECT_AUTHORING_E2E_ARTIFACTS ??
    join(root, `output/project-platform-20261012/authoring-packaged-${randomUUID()}`)
)
assert(!existsSync(artifacts), "Use fresh evidence directory")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const evidence: Record<string, unknown> = {
  isolated,
  manualSourceFiles: 0,
  limitation:
    "Deterministic loopback model; automated user actions are not a novice timing study. Explicit dev preview is isolated and never globally installs a draft."
}
let app: ElectronApplication | undefined
let page: Page
let approvals = 0
const errors: string[] = []
const pause = () => new Promise((resolve) => setTimeout(resolve, 200))

async function install(bytes: Buffer) {
  const result = await page.evaluate(
    (bytes) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, "author-fixture.zip", "local"),
    [...bytes]
  )
  assert(result.success, result.error)
}
async function setupThread(path: string, title: string) {
  return page.evaluate(
    async ({ path, title }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: path,
        agentMode: "normal"
      })
      const id = (thread as unknown as { thread_id: string }).thread_id
      await window.api.workspace.set(id, path)
      await window.api.mods.configure(id, true, true)
      const status = await window.api.mods.status(id)
      const provider = (status.functionMods ?? []).find(
        (item) => item.name === "project-public-action-provider"
      )
      if (!provider?.digest) throw Error("Installed provider or digest missing")
      await window.api.mods.approveFunction(id, provider.pluginId, provider.digest)
      return { id, provider, workspace: status.workspace }
    },
    { path, title }
  )
}
// UI approval uses the existing one-shot button. Never grant session/global file permissions.
async function settle<T>(pending: Promise<T>, open?: () => Promise<void>): Promise<T> {
  let done = false
  let value: T | undefined
  let failure: unknown
  void pending.then(
    (result) => {
      value = result
      done = true
    },
    (error) => {
      failure = error
      done = true
    }
  )
  const deadline = Date.now() + 180000
  while (!done && Date.now() < deadline) {
    if (open) await open()
    const allow = page.getByRole("button", { name: "允许", exact: true })
    if ((await allow.count()) && (await allow.first().isVisible())) {
      await allow.first().click()
      approvals++
    }
    await pause()
  }
  assert(done, "Real invocation timed out; preserve pending approval/failure evidence")
  if (failure) throw failure
  return value!
}
async function command(id: string, command: LocalProjectCommand) {
  return page.evaluate(
    ({ id, command }) => window.api.harnessBoard.localProjects.command(id, command),
    { id, command }
  )
}
async function runProject(
  path: string,
  label: string,
  templateId: string,
  existing?: LocalProjectView
) {
  const setup = await setupThread(path, `授权准备-${label}`)
  let view =
    existing ??
    (await page.evaluate((input) => window.api.harnessBoard.localProjects.create(input), {
      name: `作者闭环-${label}`,
      workspace: path,
      installedPluginId: templateId,
      goal: "根据当前阶段创建文档与检查记录；复用已绑定的公开格式动作。"
    }))
  for (const stage of ["draft", "review"]) {
    view = await command(view.project.projectId, {
      kind: "prepare",
      expectedVersion: view.project.version,
      idempotencyKey: randomUUID()
    })
    let operation = view.operations[0]
    if (stage === "review")
      view = await command(view.project.projectId, {
        kind: "approve",
        operationId: operation.operationId,
        expectedVersion: view.project.version,
        inputFingerprint: operation.inputFingerprint,
        decision: "approved"
      })
    await page.getByRole("tab", { name: "项目模式", exact: true }).click()
    await page.getByRole("button", { name: "更新列表", exact: true }).click()
    await page.getByRole("button").filter({ hasText: view.project.name }).first().click()
    let opened = false
    await page.getByRole("button", { name: "继续执行", exact: true }).click()
    const projectId = view.project.projectId
    const operationId = operation.operationId
    const terminal = (async () => {
      for (let count = 0; count < 850; count++) {
        const next = await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          projectId
        )
        const current = next.operations.find((item) => item.operationId === operationId)
        if (current && ["succeeded", "failed", "cancelled", "unknown"].includes(current.status))
          return next
        await pause()
      }
      throw Error("Stage terminal timeout")
    })()
    view = await settle(terminal, async () => {
      if (opened) return
      const button = page.getByRole("button", { name: "查看本次会话", exact: true }).first()
      // The production panel observes an active operation without requiring a manual refresh.
      if ((await button.count()) && (await button.isVisible())) {
        await button.click()
        opened = true
      }
    })
    operation = view.operations[0]
    assert.equal(operation.status, "succeeded", JSON.stringify(operation))
    assert.equal(operation.execution?.terminal?.outcome, "success")
    assert(operation.receipts.every((receipt) => receipt.result === "passed"))
    if (stage === "review") {
      await page.getByRole("tab", { name: "项目模式", exact: true }).click()
      await page.getByRole("button", { name: "更新列表", exact: true }).click()
      await page.getByRole("button").filter({ hasText: view.project.name }).first().click()
      await page.getByRole("button", { name: "查看公开动作结果", exact: true }).first().click()
      const results = page.getByRole("region", { name: "公开动作历史结果" })
      await results
        .getByText(/AUTHORING_PUBLIC_ACTION_INPUT/)
        .first()
        .waitFor()
      assert.equal(
        await results.locator("pre").filter({ hasText: "AUTHORING_PUBLIC_ACTION_INPUT" }).count(),
        2
      )
      const publicResults = await page.evaluate(
        ({ projectId, operationId }) =>
          window.api.harnessBoard.localProjects.actionResults(projectId, operationId),
        { projectId: view.project.projectId, operationId: operation.operationId }
      )
      assert(
        publicResults.actions.every((action) => action.authorizedNow && action.status === "passed")
      )
      assert.equal(
        JSON.parse(publicResults.actions[1].output!).text,
        "整理结果：\n整理结果：\nAUTHORING_PUBLIC_ACTION_INPUT"
      )
      evidence[`visible-actions-${label}`] = publicResults
      await page.screenshot({ path: join(artifacts, `public-action-results-${label}.png`) })
      // Read ONLY this test's isolated persisted Flow results, without bypassing IPC execution scope.
      const db = new DatabaseSync(join(env.CMB_COWORK_AGENT_HOME, "mods-control.sqlite"), {
        readOnly: true
      })
      try {
        const row = db
          .prepare("SELECT value FROM mods_meta WHERE key = ?")
          .get(
            JSON.stringify(["diy-flow-v1", "runs", setup.workspace, operation.execution!.threadId])
          )
        assert(row, "Real Flow must have persisted results")
        const runs: FlowRun[] = JSON.parse(String(row.value))
        const outputs = runs.flatMap((run) =>
          run.attempts.map((attempt) => attempt.result?.output?.text)
        )
        assert(outputs.includes("整理结果：\nAUTHORING_PUBLIC_ACTION_INPUT"), JSON.stringify(runs))
        assert(
          outputs.includes("整理结果：\n整理结果：\nAUTHORING_PUBLIC_ACTION_INPUT"),
          JSON.stringify(runs)
        )
        evidence[`flows-${label}`] = runs
      } finally {
        db.close()
      }
    }
    view = await command(view.project.projectId, {
      kind: "advance",
      operationId: operation.operationId
    })
  }
  assert.equal(view.project.status, "completed")
  assert.match(readFileSync(join(path, "draft.md"), "utf8"), /AUTHORING_FILE_BODY_SENTINEL/)
  assert.equal(JSON.parse(readFileSync(join(path, "review.json"), "utf8")).checked, true)
  evidence[label] = view
  return view
}

async function main() {
  const model = await startProjectAuthoringModel()
  try {
    app = await launch(60000)
    app
      .process()
      .stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    app
      .process()
      .stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page.evaluate(async (url) => {
      await window.api.models.setCustomConfig({
        id: "project-author-fixture",
        name: "隔离作者模型",
        baseUrl: url,
        model: "project-author-fixture",
        apiKey: "isolated-loopback-fixture",
        maxTokens: 64000,
        maxOutputTokens: 8192
      })
      await window.api.models.setDefault("custom:project-author-fixture")
      await window.api.mods.configureGlobal(true)
    }, model.url)
    const providerZip = new AdmZip()
    for (const file of ["plugin.json", "mods/manifest.json", "mods/main.ts"])
      providerZip.addFile(
        file,
        readFileSync(join(root, "examples/project-public-action-provider", file))
      )
    await install(providerZip.toBuffer())
    const author = await setupThread(workspace, "自然语言作者验收")
    await page.evaluate(
      ({ id, workspace }) =>
        window.api.mods.development.setEnabled({
          threadId: id,
          expectedWorkspace: workspace,
          enabled: true
        }),
      { id: author.id, workspace: author.workspace }
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.agent))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page.getByText("自然语言作者验收", { exact: true }).first().click()
    const authorResult = await settle(
      page.evaluate(
        (id) =>
          new Promise((resolve) => {
            const events: unknown[] = []
            const cleanup = window.api.agent.invoke(
              id,
              "请制作两阶段文档项目：创建源码，检查不支持的 schema 并修复，通过真实检查后列出已授权公开动作，把格式动作连续复用两次，准备隔离试用目录并打包。不要自动安装或执行业务。",
              (event) => {
                events.push(event)
                if (event.type === "done" || event.type === "error") {
                  cleanup()
                  resolve({ terminal: event.type, events })
                }
              },
              "custom:project-author-fixture",
              "normal"
            )
          }),
        author.id
      )
    )
    evidence.author = authorResult
    assert.equal((authorResult as { terminal: string }).terminal, "done")
    assert.equal(model.observations.length, 13)
    const dev = model.observations.find((item) => item.action === "project_dev")!.packet
      .result as ProjectDevelopmentView
    const packed = model.observations.find((item) => item.action === "project_pack")!.packet
      .result as Awaited<ReturnType<typeof packProjectPlugin>>
    assert.equal(dev.executed, false)
    assert.equal(dev.status, "prepared")
    assert.deepEqual(readdirSync(dev.workspace), [])
    assert(resolve(packed.output).startsWith(resolve(isolated)))
    const zip = readFileSync(packed.output)
    evidence.sourceFileCount = model.draft.source.files.length
    evidence.prepared = dev
    evidence.package = packed
    evidence.provider = author.provider
    const installedBeforePreview = await page.evaluate(() => window.api.plugins.list())
    const previewList = () =>
      page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), author.id)
    async function openCreator() {
      await page.getByRole("tab", { name: "对话模式", exact: true }).click()
      await page.getByText("自然语言作者验收", { exact: true }).first().click()
      await page.getByRole("button", { name: "创作已开启", exact: true }).click()
      await page.getByRole("region", { name: "项目模板隔离试用", exact: true }).waitFor()
    }
    async function createPreview(revision: number) {
      await openCreator()
      const panel = page.getByRole("region", { name: "项目模板隔离试用", exact: true })
      await panel.getByRole("button", { name: "更新项目草稿", exact: true }).click()
      await panel.getByLabel("这次试用希望完成什么").fill("根据当前阶段创建文档与检查记录")
      const create = panel.getByRole("button", { name: "创建隔离试用（不开始）", exact: true })
      assert(await create.isDisabled(), "Preview requires real UI version consent")
      await panel.getByRole("checkbox").check()
      const callsBefore = model.requests.length
      await create.click()
      let row
      for (let i = 0; i < 100; i++) {
        row = (await previewList()).drafts.find((item) => item.id === AUTHOR_PACKAGE_ID)
        if (row?.projectId) break
        await pause()
      }
      assert(row?.projectId && row.development)
      assert.equal(row.development.currentRevision, revision)
      assert.equal(model.requests.length, callsBefore, "Creating a preview cannot start inference")
      assert.deepEqual(
        await page.evaluate(() => window.api.plugins.list()),
        installedBeforePreview,
        "Preview never modifies global installed plugins"
      )
      await page.screenshot({ path: join(artifacts, `preview-created-r${revision}.png`) })
      const view = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.get(id),
        row.projectId
      )
      await page.keyboard.press("Escape")
      return view
    }
    const preview = await createPreview(model.draft.revision)
    const initialRevision = model.draft.revision
    model.update()
    await settle(
      page.evaluate(
        (id) =>
          new Promise((resolve) => {
            const cleanup = window.api.agent.invoke(
              id,
              "请更新刚才项目的技能说明，保留已有阶段与公开动作绑定。不要自动运行或安装。",
              (event) => {
                if (event.type === "done" || event.type === "error") {
                  cleanup()
                  resolve(event.type)
                }
              },
              "custom:project-author-fixture",
              "normal"
            )
          }),
        author.id
      )
    )
    assert.equal(model.draft.revision, initialRevision + 1)
    const queued = (await previewList()).drafts.find((item) => item.id === AUTHOR_PACKAGE_ID)!
    assert.equal(queued.development?.currentRevision, initialRevision)
    assert.equal(queued.development?.pendingRevision, initialRevision + 1)
    assert.equal(queued.development?.activeRuns, 1)
    evidence.previewQueued = queued
    model.stage(dev.workspace, "preview-original")
    await runProject(dev.workspace, "preview-original", "", preview)
    const idle = (await previewList()).drafts.find((item) => item.id === AUTHOR_PACKAGE_ID)!
    assert.equal(idle.projectId, undefined)
    assert.equal(idle.development?.currentRevision, initialRevision + 1)
    assert.equal(idle.development?.pendingRevision, null)
    assert.equal(idle.development?.activeRuns, 0)
    const nextPreview = await createPreview(initialRevision + 1)
    assert.notEqual(nextPreview.project.pluginDigest, preview.project.pluginDigest)
    model.stage(dev.workspace, "preview-next")
    await runProject(dev.workspace, "preview-next", "", nextPreview)
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), installedBeforePreview)
    evidence.previewIdle = idle
    console.log(
      "PASS isolated preview explicit creation → queued source update → original Skill snapshot → idle new version → original global plugins unchanged"
    )
    await install(zip)
    let templates = await page.evaluate(() => window.api.harnessBoard.localProjects.templates())
    const trial = templates.find((item) => item.name === AUTHOR_PACKAGE_ID)!
    assert(trial && !trial.unavailableReason)
    model.stage(dev.workspace, "trial")
    await runProject(dev.workspace, "trial", trial.installedPluginId)
    await page.evaluate((id) => window.api.plugins.delete(id), trial.installedPluginId)
    await install(zip)
    templates = await page.evaluate(() => window.api.harnessBoard.localProjects.templates())
    const formal = templates.find((item) => item.name === AUTHOR_PACKAGE_ID)!
    assert(formal && !formal.unavailableReason)
    assert.notEqual(formal.installedPluginId, trial.installedPluginId)
    const formalWorkspace = join(isolated, "formal-workspace")
    mkdirSync(formalWorkspace)
    model.stage(formalWorkspace, "formal")
    await runProject(formalWorkspace, "formal", formal.installedPluginId)
    assert(approvals > 0, "Original write_file approval UI must be exercised")
    assert.deepEqual(model.errors, [])
    assert.deepEqual(errors, [])
    evidence.success = true
    console.log(
      "PASS actual natural-language authoring → repair → isolated trial → formal install → public action mapping"
    )
  } catch (error) {
    evidence.failure = String(error)
    if (page!) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    throw error
  } finally {
    evidence.approvals = approvals
    evidence.model = {
      observations: model.observations,
      requests: model.requests,
      errors: model.errors
    }
    evidence.pageErrors = errors
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(evidence, null, 2))
    await app?.close().catch(() => {})
    await model.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
