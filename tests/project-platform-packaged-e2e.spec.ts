/** Production Electron only. Real install, SDK/Skill/Hooks/tools, project receipts and restart. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import type { HostProjectOperation } from "../src/shared/project-runtime/host-types"
import { packProjectPlugin } from "../src/main/mods/devtools/project-tooling"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { saveProjectKnowledge, exerciseProjectLibrary, KNOWLEDGE_MARKER } from "./support/project-library-packaged-journey"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { projectBuiltPreview } from "./support/project-built-preview"
import { createUnifiedHostProject, openUnifiedHostProject } from "./support/project-unified-native-journey"
import {
  startProjectPlatformModel,
  type ProjectModelPhase
} from "./support/project-platform-model-fixture"

const root = resolve(__dirname, "..")
const selectedLaunch = projectBuiltPreview(root, process.env.CMB_MODS_PACKAGED_DIR)
const artifacts = resolve(
  root,
  process.env.CMB_PROJECT_PLATFORM_E2E_ARTIFACTS ??
    `output/project-platform-20261012/packaged-${randomUUID()}`
)
assert(!existsSync(artifacts), "Preserve earlier evidence; select a fresh artifact directory")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const checks: string[] = []
const errors: string[] = []
const readBack: Record<string, unknown> = {}
let app: ElectronApplication | undefined
let page: Page
let projectId = ""
const taskName = "本地项目生产链验收"

function pass(label: string) {
  checks.push(label)
  console.log("PASS " + label)
}
async function boot() {
  selectedLaunch.assertCurrent()
  app = await launch(60000)
  const identity = await selectedLaunch.verify(app, join(root, "out/main"))
  if (identity) {
    const launches = (readBack.previewLaunches ??= []) as unknown[]
    launches.push(identity)
  }
  app.process().stdout?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
  app.process().stderr?.on("data", (chunk) => appendFileSync(join(artifacts, "runtime.log"), chunk))
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on("pageerror", (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
  )
  await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
  await page.evaluate(() => {
    ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
  })
}
async function read() {
  return page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
}
async function waitView(accept: (view: LocalProjectView) => boolean, label: string) {
  const deadline = Date.now() + 15000
  let view = await read()
  while (!accept(view) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    view = await read()
  }
  assert(accept(view), `${label}: ${JSON.stringify(view)}`)
  return view
}
async function openProject() {
  // Never bypass the public navigation with a store mutation or enterprise-gate fixture.
  await openUnifiedHostProject(page, taskName)
}
async function terminal(previousCount: number, status: HostProjectOperation["status"]) {
  const deadline = Date.now() + 90000
  let latest: LocalProjectView | undefined
  let inspecting = false
  const approved = new Set<string>()
  while (Date.now() < deadline) {
    latest = await read()
    if (latest.operations.length > previousCount && latest.operations[0].status === status) {
      if (inspecting) await openProject()
      return latest
    }
    const actual = latest.operations[0]
    if (
      latest.operations.length > previousCount &&
      actual?.execution?.threadId &&
      actual.status === "started"
    ) {
      const pending = await page.evaluate(
        (id) => window.api.sandbox.getPendingApprovals(id),
        actual.execution.threadId
      )
      for (const value of pending) {
        const approval = value as { id?: string; operation?: string; filePath?: string }
        assert(approval.id?.trim(), "Live approval must expose its actual request id")
        assert(["write_file", "edit_file"].includes(approval.operation ?? ""))
        assert(approval.filePath, "File approval must identify its target")
        assert(
          [join(workspace, "draft.md"), join(workspace, "review.json")].includes(approval.filePath),
          `Unexpected file approval: ${approval.filePath}`
        )
        if (approved.has(approval.id)) continue
        if (!inspecting) {
          // The in-flight panel must expose its new conversation without a manual refresh.
          await page
            .getByText(
              "打开“查看本次会话”可查看实时进度，处理文件修改等确认。确认后助手会继续执行。"
            )
            .waitFor()
          await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
          inspecting = true
        }
        const label = approval.operation === "write_file" ? "写入" : "编辑"
        await page.getByText(`${label}: ${approval.filePath}`, { exact: true }).waitFor()
        const current = await page.evaluate(
          (id) => window.api.sandbox.getPendingApprovals(id),
          actual.execution.threadId
        )
        assert.equal(current.length, 1, "Visible approval must identify the sole live request")
        assert.deepEqual(current[0], value, "Approval identity must remain current before clicking")
        await page.getByRole("button", { name: "允许", exact: true }).click()
        approved.add(approval.id)
        checks.push(
          `Approved ${approval.operation} ${approval.id}: ${approval.filePath} through UI`
        )
      }
    }
    if (
      latest.operations.length > previousCount &&
      actual &&
      ["failed", "unknown", "cancelled", "succeeded"].includes(actual.status)
    )
      throw Error(`Unexpected stage terminal: ${JSON.stringify(actual)}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw Error(`Project stage timeout: ${JSON.stringify(latest)}`)
}
async function verifyTranscript(operation: HostProjectOperation, phase: ProjectModelPhase) {
  assert(operation.execution?.threadId)
  assert.equal(operation.execution.terminal?.outcome, "success")
  const rows = await page.evaluate(
    (id) => window.api.threads.getMessages(id),
    operation.execution.threadId
  )
  const marker = `PROJECT_PLATFORM_FINAL_${phase.toUpperCase()}`
  const answers = rows.filter(
    (row) => row.role === "assistant" && JSON.stringify(row.content).includes(marker)
  )
  assert.equal(answers.length, 1, "Persisted assistant answer must not be duplicated")
  readBack[`transcript-${phase}`] = rows
  return marker
}
async function inspectRunUI(marker: string, threadId: string) {
  await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
  await page.getByText(marker, { exact: true }).waitFor()
  assert.equal(await page.getByText(marker, { exact: true }).count(), 1)
  await page.getByRole("button", { name: "运行过程", exact: true }).click()
  await page.getByRole("dialog", { name: "本阶段运行过程", exact: true }).waitFor()
  await page.getByRole("heading", { name: "本次规范与运行概况", exact: true }).waitFor()
  const overview = await page.evaluate(
    ({ id, workspace }) => window.api.mods.builtinOverview(id, workspace),
    { id: threadId, workspace }
  )
  assert(
    overview.policy.decisions?.records.some(
      (record) => record.source === "tool-approval" && record.decision === "allow"
    ),
    "Original file approval must be observable in its real host decision record"
  )
  assert(
    overview.policy.decisions?.records.some((record) => record.source === "hook"),
    "Original Skill Hook outcome must be observable without replaying it"
  )
  await page.getByText("变更审阅 · 看看文件改了什么", { exact: true }).click()
  for (const baseline of ["task", "stage", "project"] as const) {
    await page.getByLabel("比较范围").selectOption(baseline)
    await page.getByRole("button", { name: "查看改动", exact: true }).click()
    await page.getByRole("region", { name: "关联检查记录" }).waitFor()
    const review = await page.evaluate(
      ({ id, workspace, baseline }) => window.api.mods.builtinChangeReview(id, workspace, baseline),
      { id: threadId, workspace, baseline }
    )
    assert.equal(review.status, "available", JSON.stringify(review))
    assert(review.files.some((file) => file.path === "review.json"))
    assert.equal(
      review.files.some((file) => file.path === "draft.md"),
      true,
      "The review really revises draft.md, visible in task, stage and project baselines"
    )
    assert(review.evidence?.checks.some((check) => check.result === "passed"))
    readBack[`review-${baseline}`] = review
  }
  readBack.policyDecisions = overview.policy.decisions
  const samples = await page.evaluate(async (marker) => {
    const values: Array<{ at: number; answerVisible: boolean; overviewVisible: boolean }> = []
    for (let i = 0; i < 45; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const headings = Array.from(document.querySelectorAll("h3"))
      values.push({
        at: performance.now(),
        answerVisible: document.body.innerText.includes(marker),
        overviewVisible: headings.some(
          (item) => item.textContent === "本次规范与运行概况" && item.getClientRects().length > 0
        )
      })
    }
    return values
  }, marker)
  assert(
    samples.every((sample) => sample.answerVisible && sample.overviewVisible),
    "Visible settled result must not blink out across frames"
  )
  readBack.uiFrames = samples
  await page.screenshot({ path: join(artifacts, "real-thread-run-overview.png") })
  await page.keyboard.press("Escape")
  await page
    .getByRole("dialog", { name: "本阶段运行过程", exact: true })
    .waitFor({ state: "detached" })
  await openProject()
}

async function main() {
  const model = await startProjectPlatformModel(workspace)
  const advisorAtFailure = process.env.CMB_PROJECT_ADVISOR_AT_FAILURE === "1"
  async function inspectAdvisor(view: LocalProjectView) {
    const advisorThread = view.operations.find((operation) => operation.execution)?.execution
      ?.threadId
    assert(advisorThread)
    const messagesBeforeAdvisor = await page.evaluate(
      (id) => window.api.threads.getMessages(id),
      advisorThread
    )
    const defaultAdvisor = await page.evaluate(
      ({ id, workspace }) => window.api.mods.builtinAdvisor(id, workspace, "view"),
      { id: advisorThread, workspace }
    )
    assert.equal(defaultAdvisor.enabled, false)
    assert.equal(model.advisorRequests.length, 0)
    model.setAdvisorMode(view.project.status === "completed" ? "completed" : "missing")
    await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
    await page.getByRole("button", { name: "运行过程", exact: true }).click()
    const advisorDialog = page.getByRole("dialog", { name: "本阶段运行过程", exact: true })
    await advisorDialog.getByText("智能建议 · 可选", { exact: true }).click()
    const enabled = advisorDialog.getByLabel("在本次应用会话中启用")
    async function toggleAdvisor(expected: boolean) {
      assert.equal(await enabled.isChecked(), !expected)
      // The controlled checkbox updates after IPC returns; click once, then await acknowledgement.
      await enabled.click()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const state = await page.evaluate(
          ({ id, workspace }) => window.api.mods.builtinAdvisor(id, workspace, "view"),
          { id: advisorThread!, workspace }
        )
        if (state.enabled === expected && (await enabled.isChecked()) === expected) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.fail(`Advisor UI and backend did not acknowledge enabled=${expected}`)
    }
    await toggleAdvisor(true)
    assert.equal(model.advisorRequests.length, 0, "Enabling never starts inference")
    await advisorDialog.getByRole("button", { name: "分析已有记录", exact: true }).click()
    await advisorDialog.getByText(/^PROJECT_ADVISOR_RESULT/).waitFor({ timeout: 20000 })
    assert.equal(model.advisorRequests.length, 1)
    await page.screenshot({ path: join(artifacts, `advisor-${view.project.status}.png`) })
    await advisorDialog.getByRole("button", { name: "忽略这条建议", exact: true }).click()
    await advisorDialog.getByText(/^PROJECT_ADVISOR_RESULT/).waitFor({ state: "detached" })
    await advisorDialog.getByRole("button", { name: "分析已有记录", exact: true }).click()
    await advisorDialog.getByText("请间隔一分钟再分析。", { exact: true }).waitFor()
    assert.equal(
      model.advisorRequests.length,
      1,
      "Dismiss/retry within cooldown never consumes another model call"
    )
    await toggleAdvisor(false)
    await advisorDialog
      .getByRole("button", { name: "分析已有记录", exact: true })
      .waitFor({ state: "detached" })
    const disabledAdvisor = await page.evaluate(
      ({ id, workspace }) => window.api.mods.builtinAdvisor(id, workspace, "view"),
      { id: advisorThread, workspace }
    )
    assert.equal(disabledAdvisor.enabled, false)
    assert.equal(disabledAdvisor.result, undefined)
    assert.deepEqual(await read(), view, "Advisor cannot mutate project receipts/state")
    assert.deepEqual(
      await page.evaluate((id) => window.api.threads.getMessages(id), advisorThread),
      messagesBeforeAdvisor,
      "Advisor must not inject chat messages"
    )
    readBack.advisor = { defaultAdvisor, disabledAdvisor, requests: model.advisorRequests }
    await page.keyboard.press("Escape")
    await openProject()
    model.setPhase(view.project.status === "completed" ? "review" : "missing")
    pass(
      "Actual advisor SDK receives bounded enum/count historical project facts only; zero tools/files/goal/history; explicit enable/analyze/dismiss/disable, no project/chat writes"
    )
  }
  const watchdog = setTimeout(() => {
    errors.push("watchdog expired")
    void app?.close()
  }, 360000)
  try {
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(isolated, "empty-git-config")
    })
    writeFileSync(env.GIT_CONFIG_GLOBAL, "")
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: workspace, env, windowsHide: true })
    git(["init", "--template="])
    writeFileSync(join(workspace, "existing.md"), "Pre-existing fixture file\n")
    git(["add", "existing.md"])
    git([
      "-c",
      "user.name=Isolated fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "baseline"
    ])
    const zip = join(artifacts, "project-docs-lite.zip")
    readBack.package = await packProjectPlugin(join(root, "examples/project-docs-lite"), zip)
    await boot()
    await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "project-platform-fixture",
          name: "隔离项目模型",
          baseUrl: url,
          model: "project-platform-fixture",
          apiKey: "isolated-loopback-fixture",
          maxTokens: 32000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:project-platform-fixture")
        await window.api.mods.configureGlobal(true)
        const row = await window.api.threads.create({
          title: "验收初始化",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (row as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        await Promise.all(
          (["PreSkillUse", "PostSkillUse"] as const).map((event) =>
            window.api.hooks.create({
              event,
              matcher: "project-docs-lite-draft",
              type: "http",
              enabled: true,
              timeout: 10000,
              url: `${url.replace(/\/v1$/, "")}/skill-hook/${event}`
            })
          )
        )
      },
      { workspace, url: model.url }
    )
    const installed = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "project-docs-lite.zip", "local"),
      [...readFileSync(zip)]
    )
    assert(installed.success, installed.error)
    const templates = await page.evaluate(() => window.api.harnessBoard.localProjects.templates())
    const template = templates.find((item) => item.name === "project-docs-lite")
    assert(template && !template.unavailableReason, JSON.stringify(templates))
    assert.notEqual(template.installedPluginId, "project-docs-lite")
    let view = await createUnifiedHostProject(app, page, {
      name: taskName,
      workspace,
      installedPluginId: template.installedPluginId,
      pluginName: template.name,
      version: template.version,
      goal: "在当前阶段生成文档产物；按照固定 Skill 执行，只报告实际完成的工作。"
    })
    projectId = view.project.projectId
    const digest = view.project.pluginDigest
    assert.equal(
      view.project.packageVersion,
      JSON.parse(readFileSync(join(root, "examples/project-docs-lite/plugin.json"), "utf8")).version,
      "Created project must retain the actual authored package version"
    )
    assert.equal(model.requests.length, 0)
    assert.equal(existsSync(join(workspace, "draft.md")), false)
    pass(
      "Real author pack → formal plugin install → ordinary New Project form → Host creation without inference"
    )
    await openProject()
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    view = await terminal(0, "failed")
    assert(
      view.operations[0].receipts.some(
        (receipt) => receipt.checkId === "draft-exists" && receipt.result !== "passed"
      )
    )
    await verifyTranscript(view.operations[0], "missing")
    assert.equal(existsSync(join(workspace, "draft.md")), false)
    pass("Real original Skill/model terminal cannot replace missing-artifact validation")
    if (advisorAtFailure) await inspectAdvisor(view)
    model.setPhase("draft")
    const oldCount = view.operations.length
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    view = await terminal(oldCount, "succeeded")
    assert.match(readFileSync(join(workspace, "draft.md"), "utf8"), /隔离项目真实工具产物/)
    assert.equal(view.project.stageIndex, 0)
    await verifyTranscript(view.operations[0], "draft")
    await openProject()
    await saveProjectKnowledge(page)
    await page.getByRole("button", { name: "进入下一阶段", exact: true }).click()
    view = await waitView((value) => value.project.stageIndex === 1, "Explicit stage advance")
    assert.equal(view.project.stageIndex, 1)
    const beforeApproval = model.requests.length
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    await page.getByRole("button", { name: "拒绝本次执行", exact: true }).click()
    view = await waitView(
      (value) => value.operations[0]?.approval?.decision === "rejected",
      "Human rejection"
    )
    assert.equal(view.operations[0].approval?.decision, "rejected")
    assert.equal(model.requests.length, beforeApproval)
    pass(
      "Actual native write_file fixes missing output; explicit advance and rejected human approval preserve control"
    )
    model.setPhase("review")
    const beforeReview = view.operations.length
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    await page.getByRole("button", { name: "批准并执行", exact: true }).click()
    view = await terminal(beforeReview, "succeeded")
    assert(view.operations[0].receipts.every((receipt) => receipt.result === "passed"))
    assert.equal(JSON.parse(readFileSync(join(workspace, "review.json"), "utf8")).checked, true)
    assert.match(readFileSync(join(workspace, "draft.md"), "utf8"), /PROJECT_REVIEW_REVISED_DRAFT/)
    const marker = await verifyTranscript(view.operations[0], "review")
    assert(JSON.stringify(model.received).includes(KNOWLEDGE_MARKER), "Saved project knowledge reaches later Skill as reference")
    assert(JSON.stringify(model.received).includes("untrusted task data"))
    for (const phase of ["missing", "draft", "review"])
      for (const event of ["PreSkillUse", "PostSkillUse"])
        assert(
          model.hooks.some((hook) => hook.phase === phase && hook.event === event),
          `Missing real ${event}/${phase}`
        )
    assert(model.requests.some((request) => request.phase === "draft" && request.wrote))
    assert(model.requests.some((request) => request.phase === "review" && request.wrote))
    await inspectRunUI(marker, view.operations[0].execution!.threadId)
    await page.getByRole("button", { name: "确认完成任务", exact: true }).click()
    view = await waitView((value) => value.project.status === "completed", "Explicit completion")
    assert.equal(view.project.status, "completed")
    assert.equal(view.project.pluginDigest, digest)
    readBack.completed = view
    readBack.library = await exerciseProjectLibrary(page, view, artifacts)
    pass("Checked knowledge reused across tasks; explicit multipart delivery, catalog retry, scoped IPC and unchanged project verified")
    await page.screenshot({ path: join(artifacts, "completed-project.png") })
    pass(
      "Approved review uses the original SDK/Skill HTTP Hooks/native write, real schema receipt, unique answer and stable run-overview UI"
    )
    if (!advisorAtFailure) await inspectAdvisor(view)
    const requestsBeforeRestart = model.requests.length
    await app!.close()
    app = undefined
    await boot()
    const restored = await read()
    assert.deepEqual(restored, view)
    const libraryRestored = await page.evaluate((id) => window.api.harnessBoard.localProjects.library.list(id), projectId)
    assert(libraryRestored.some((entry) => entry.kind === "delivery" && entry.status === "sent"))
    assert(libraryRestored.some((entry) => entry.note === KNOWLEDGE_MARKER))
    assert.equal(model.requests.length, requestsBeforeRestart)
    await openProject()
    await page.getByRole("heading", { name: `${taskName} · 已完成`, exact: true }).waitFor()
    await page.getByText("任务配置与版本", { exact: true }).click()
    await page.getByRole("button", { name: "比较已安装版本", exact: true }).click()
    assert.deepEqual(await read(), restored)
    readBack.versionReport = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.versions(id),
      projectId
    )
    await page.screenshot({ path: join(artifacts, "reopened-fixed-version.png") })
    await page.getByRole("link", { name: /使用说明/ }).first().click()
    const docImage = page.getByRole("img", { name: /成果与经验的交付详情/ })
    await docImage.scrollIntoViewIfNeeded()
    await docImage.evaluate((image: HTMLImageElement) => image.decode())
    assert(await docImage.evaluate((image: HTMLImageElement) => image.naturalWidth > 1000))
    await page.screenshot({ path: join(artifacts, "packaged-guide-image.png") })
    await page.keyboard.press("Escape")
    assert.deepEqual(model.errors, [])
    assert.deepEqual(errors, [])
    pass(
      "Full process restart preserves fixed version, operation receipts and completion; version comparison is read-only"
    )
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          complete: true,
          execution: selectedLaunch.execution,
          checks,
          isolated,
          workspace,
          readBack,
          requests: model.requests,
          advisorRequests: model.advisorRequests,
          hooks: model.hooks,
          errors,
          limitations: [
            ...(selectedLaunch.preview ? ["Normal built Electron preview, not an ASAR/package validation"] : []),
            "Loopback deterministic provider, not customer model quality",
            "One ordinary viewport; 45 settled frames do not prove absence of every transient flash",
            "No arbitrary interrupted-stage resume, legacy migration, or external service side effects claimed"
          ]
        },
        null,
        2
      )
    )
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {})
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          checks,
          isolated,
          workspace,
          readBack,
          requests: model.requests,
          advisorRequests: model.advisorRequests,
          hooks: model.hooks,
          providerErrors: model.errors,
          received: model.received,
          errors
        },
        null,
        2
      )
    )
    throw error
  } finally {
    clearTimeout(watchdog)
    try {
      await app?.close()
    } finally {
      await model.close()
    }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
