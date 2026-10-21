/** Normal Electron build/ASAR: real installed Function Mod SDK → native readonly review → explicit native create. No testing bridge. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import {
  HARNESS_DRAFT,
  HARNESS_PACKAGE_ID
} from "./support/project-harness-model-fixture"
import {
  startStageDebugModel
} from "./support/project-stage-debug-model"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_PACKAGED_DIR?.trim() || process.env.CREATOR_E2E_BUILT_PREVIEW === "1",
  "Use an explicitly selected normal app build/ASAR, never implicit out fallback or a testing IPC bridge"
)
const candidate = projectCompositionCandidate(root)
assert.match(process.env.CREATOR_E2E_EXPECTED_SHA256 ?? "", /^[a-f0-9]{64}$/)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
  unobtrusivePresentation: true
})
const evidence: Record<string, unknown> = { candidate, isolated: fixture.isolated }
const errors: string[] = []
const approvals: Array<{ id: string; projectId: string; path: string }> = []
let app: ElectronApplication | undefined
let page: Page
const pause = () => new Promise((done) => setTimeout(done, 200))
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const value = await read()
    writeFileSync(join(fixture.isolated, "latest.json"), JSON.stringify({ label, value }, null, 2))
    if (accept(value)) return value
    await pause()
  }
  throw Error(`Timed out within original 90s stage budget: ${label}`)
}
function files(directory: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(join(directory, path))
      assert(!stat.isSymbolicLink())
      if (stat.isDirectory()) visit(path)
      else {
        assert(stat.isFile())
        result[path] = createHash("sha256")
          .update(readFileSync(join(directory, path)))
          .digest("hex")
      }
    }
  }
  visit("")
  return result
}
async function open() {
  app = await launch()
  for (const [name, stream] of [
    ["stdout", app.process().stdout],
    ["stderr", app.process().stderr]
  ] as const)
    stream?.on("data", (bytes) =>
      appendFileSync(join(fixture.isolated, `main.${name}.log`), `[${Date.now()}] ${bytes}`)
    )
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(20000)
  await page.addLocatorHandler(page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(), async guide => {
    await guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    evidence.creatorGuideDismissedThroughUi = true
  })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForFunction(() =>
    Boolean(window.api?.harnessBoard?.localProjects?.preview?.stageDebug)
  )
  await page.evaluate(() => {
    ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
  })
}
async function showCreator() {
  const workspace = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  const closeWorkspace = async () => {
    if (!(await workspace.isVisible())) return
    const returnToChat = workspace.getByRole("button", {
      name: "返回原聊天继续创作", exact: true
    })
    if (await returnToChat.isVisible()) await returnToChat.click()
    else await workspace.getByRole("button", { name: "Close", exact: true }).click()
    // This modal intentionally handles Escape itself. A keyboard event is not proof that the
    // native return action closed it; never type into a composer behind a still-open workspace.
    await workspace.waitFor({ state: "hidden" })
  }
  await closeWorkspace()
  const back = page.getByRole("button", { name: "返回会话", exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByText("Stage debug acceptance", { exact: true }).first().click()
  // Selecting the author remounts its creator panel. Its persisted trial may automatically
  // reopen the workspace after status hydration, so explicitly enter and leave that native
  // surface after selection rather than treating the child conversation's closed state as proof.
  const trigger = page.getByLabel("聊天模式与 Mod 状态", { exact: true })
    .locator('button[aria-haspopup="dialog"]')
  await trigger.waitFor()
  if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
  await workspace.waitFor({ state: "visible" })
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="聊天模式"] button')]
      .some((button) => button.textContent?.trim() === "创造者模式" && !button.disabled)
  )
  await closeWorkspace()
  await workspace.waitFor({ state: "hidden" })
  await page.locator("textarea.composer-textarea").waitFor({ state: "visible" })
  await page.waitForFunction(() => {
    const composer = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")
    return composer && !composer.disabled && !composer.readOnly
  })
  assert(await page.locator("textarea.composer-textarea").isEditable(),
    "Original creator conversation must be editable before submitting a revision")
}
async function showAuthor() {
  await showCreator()
  const region = page.getByRole("region", { name: "灵件对话创作", exact: true })
  const trigger = page
    .getByLabel("聊天模式与 Mod 状态", { exact: true })
    .locator('button[aria-haspopup="dialog"]')
  const deadline = Date.now() + 20000
  while (!(await region.isVisible()) && Date.now() < deadline) {
    if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click()
    await pause()
  }
  assert(Date.now() < deadline, "Native creator status opener exceeded original 20s budget")
  const preview = page.getByRole("region", { name: "项目模板隔离试用", exact: true })
  if (!(await preview.isVisible()))
    await page.getByText("高级：独立项目试用", { exact: true }).click()
  await preview.waitFor()
  await preview.getByRole("button", { name: "刷新项目草稿", exact: true }).click()
  return preview
}
const readProject = (projectId: string) =>
  page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)

async function main() {
  const model = await startStageDebugModel()
  const watchdog = setTimeout(() => void app?.close(), 360000)
  try {
    await open()
    const author = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "harness-author-fixture",
          name: "S6本地受控模型",
          baseUrl: url,
          model: "harness-author-fixture",
          apiKey: "isolated-loopback-fixture",
          maxTokens: 64000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:harness-author-fixture")
        const thread = await window.api.threads.create({
          title: "Stage debug acceptance",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        await window.api.mods.configureGlobal(true)
        const status = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, status.workspace)
        await window.api.mods.development.setEnabled({
          threadId: thread.thread_id,
          expectedWorkspace: status.workspace,
          enabled: true
        })
        return thread.thread_id
      },
      { workspace: fixture.workspace, url: model.url }
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.mods))
    await showCreator()
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "制作harness-lite两阶段项目：起草draft.md，复核时读取原稿再写reviewed.md和review.json；请求真实隔离试用，不自动开始。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(
      () => page.evaluate((threadId) => window.api.mods.development.status({ threadId }), author),
      (status) => Boolean(status.projectTrial),
      "original creator tools prepare trial"
    )
    const panel = await showAuthor()
    const create = panel.getByRole("button", { name: "创建试用项目（稍后开始任务）", exact: true })
    assert(await create.isDisabled())
    await panel.getByRole("checkbox").check()
    await create.click()
    const listing = await until(
      () => page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), author),
      (value) => Boolean(value.drafts.find((draft) => draft.id === HARNESS_PACKAGE_ID)?.projectId),
      "native original creation"
    )
    const originalId = listing.drafts.find((draft) => draft.id === HARNESS_PACKAGE_ID)!.projectId!
    let original = await readProject(originalId)
    assert.deepEqual(readdirSync(original.project.workspace), [])
    const originalRevision = listing.drafts.find(
      (draft) => draft.id === HARNESS_PACKAGE_ID
    )!.revision

    // File approvals deliberately open the actual stage conversation. Re-enter the original
    // creator workspace and select this exact project's native operation panel before every
    // next stage; an IPC advance does not navigate the renderer out of that conversation.
    const showProjectOperations = async (projectId: string, isolatedBranch: boolean) => {
      const owner = await showAuthor()
      if (isolatedBranch) {
        const summary = owner.getByText("按阶段修改与隔离调试", { exact: true })
        if (await summary.locator("..").getAttribute("open") === null) await summary.click()
        const debug = owner.getByRole("region", { name: "阶段隔离调试", exact: true })
        const history = debug.getByText(/^隔离调试结果与来源对照（/)
        await history.waitFor()
        if (await history.locator("..").getAttribute("open") === null) await history.click()
        // This fixture creates exactly one branch. Do not accidentally select an original
        // preview row, whose UI would present this as a whole-trial operation surface.
        const branchButton = debug.getByRole("button", {
          name: "查看此隔离分支的阶段操作", exact: true
        })
        assert.equal(await branchButton.count(), 1)
        await branchButton.click()
      } else {
        await owner.getByRole("button", { name: "查看本轮执行与阶段操作", exact: true }).click()
      }
      const expected = await readProject(projectId)
      const stage = expected.project.manifest.stages[expected.project.stageIndex]
      assert(stage)
      const native = owner.getByLabel("本地任务运行过程", { exact: true })
      await native.getByRole("heading", {
        name: `${expected.project.name} · ${stage.title}`, exact: true
      }).waitFor()
      return native
    }

    const execute = async (
      projectId: string,
      stage: "draft" | "review",
      proveNoInheritedApproval = false
    ) => {
      const before = await readProject(projectId)
      const workspace = before.project.workspace
      const native = await showProjectOperations(projectId, proveNoInheritedApproval)
      model.stage(workspace)
      let stopped = false
      let writeError: unknown
      const writes = (async () => {
        while (!stopped) {
          const current = await readProject(projectId)
          const thread = current.operations[0]?.execution?.threadId
          if (thread) {
            const pending = await page.evaluate(
              (id) => window.api.sandbox.getPendingApprovals(id),
              thread
            )
            for (const request of pending) {
              const approval = request as { id: string; operation: string; filePath: string }
              if (approvals.some((row) => row.id === approval.id)) continue
              assert.equal(approval.operation, "write_file")
              assert(
                (stage === "draft" ? ["draft.md"] : ["reviewed.md", "review.json"]).some(
                  (path) => join(workspace, path) === approval.filePath
                )
              )
              const show = page.getByRole("button", { name: "查看本次会话", exact: true }).first()
              if (await show.isVisible()) await show.click()
              await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
              await page.getByRole("button", { name: "允许", exact: true }).click()
              approvals.push({ id: approval.id, projectId, path: approval.filePath })
            }
          }
          await pause()
        }
      })().catch((error) => {
        writeError = error
      })
      try {
        await native.getByRole("button", { name: "开始当前阶段", exact: true }).click()
        if (stage === "review") {
          const prepared = await until(
            () => readProject(projectId),
            (value) => value.operations[0]?.status === "prepared",
            "original human stage preparation"
          )
          if (proveNoInheritedApproval) {
            assert.equal(prepared.operations[0].approval, null)
            assert.deepEqual(prepared.operations[0].receipts, [])
            const calls = model.traces.length
            await assert.rejects(
              () =>
                page.evaluate(
                  ({ id, operationId }) =>
                    window.api.harnessBoard.localProjects.command(id, {
                      kind: "start",
                      operationId
                    }),
                  { id: projectId, operationId: prepared.operations[0].operationId }
                ),
              /APPROVAL_REQUIRED/
            )
            assert.equal(model.traces.length, calls)
          }
          await native.getByRole("button", { name: "批准并执行", exact: true }).click()
        }
        return await until(
          () => readProject(projectId),
          (value) => {
            if (writeError) throw writeError
            const operation = value.operations[0]
            if (
              !operation ||
              value.operations.length <= before.operations.length ||
              !["succeeded", "failed", "cancelled", "unknown"].includes(operation.status)
            )
              return false
            assert.equal(operation.status, "succeeded", JSON.stringify(value))
            assert.equal(operation.execution?.terminal?.outcome, "success")
            assert(
              operation.receipts.length > 0 &&
                operation.receipts.every((receipt) => receipt.result === "passed")
            )
            return true
          },
          `actual ${projectId}:${stage} tool execution and native receipts`
        )
      } finally {
        stopped = true
        await writes
      }
    }
    const advance = (view: LocalProjectView) =>
      page.evaluate(
        ({ id, operationId }) =>
          window.api.harnessBoard.localProjects.command(id, { kind: "advance", operationId }),
        { id: view.project.projectId, operationId: view.operations[0].operationId }
      )
    original = await advance(await execute(originalId, "draft"))
    assert.equal(original.project.stageIndex, 1)
    const originalReviewInputFiles = files(original.project.workspace)
    original = await advance(await execute(originalId, "review"))
    assert.equal(original.project.status, "completed")
    const originalFiles = files(original.project.workspace)
    assert.equal(readFileSync(join(original.project.workspace, "draft.md"), "utf8"), HARNESS_DRAFT)
    const snapshots = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.preview.stageDebug!.list(id),
      author
    )
    const entry = snapshots.snapshots.find(
      (value) => value.projectId === originalId && value.stageId === "review"
    )
    assert(entry, "Original pre-execution review entry must have been captured by the native owner")
    evidence.original = { view: original, files: originalFiles, entry }

    model.revise()
    await showCreator()
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "S6：只修改现有项目的review技能正文以改善复核，保持draft技能、原检查、审批和节点契约；保存后检查，不直接运行或修改原项目。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    const revised = await until(
      () => page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), author),
      (value) =>
        model.revisionDone &&
        Boolean(
          value.drafts.find(
            (draft) => draft.id === HARNESS_PACKAGE_ID && draft.revision > originalRevision
          )
        ),
      "real creator dialogue saves revised review Skill"
    )
    await page
      .getByText(/S6_REVIEW_REVISION_READY/)
      .last()
      .waitFor()
    const draft = revised.drafts.find((value) => value.id === HARNESS_PACKAGE_ID)!
    await showCreator()
    const sourceApproval = await page.evaluate(async (threadId) => {
      const installed = await window.api.mods.communityExamples.install({ exampleId: "stage-debugger" })
      if (!installed.requiresApproval || installed.alreadyInstalled) throw Error("Fresh native installation must require approval")
      const pending = (await window.api.mods.status(threadId)).functionMods?.find(item => item.pluginId === installed.pluginId)
      if (!pending?.digest || pending.name !== "stage-debugger" || pending.state === "ready")
        throw Error("Installing the example must not grant source authority")
      const before = await window.api.mods.clawView(threadId)
      // Explicit native source approval through the real trusted renderer API. This is a
      // deliberate fixture user decision; no main cache, permission database or service mock.
      await window.api.mods.approveFunction(threadId, installed.pluginId, pending.digest, before.workspace)
      const approved = (await window.api.mods.status(threadId)).functionMods?.find(item => item.pluginId === installed.pluginId)
      if (approved?.state !== "ready" || approved.digest !== pending.digest) throw Error("Native approval did not settle")
      const profile = { ...(before.active ?? { capabilities: [] }), id: "stage-debug-mod-acceptance",
        name: "S6第三方调试Mod验收", capabilities: [
          ...(before.active?.capabilities ?? []).filter(item => item.name !== pending.name),
          { pluginId: installed.pluginId, name: pending.name, digest: pending.digest }
        ] }
      const saved = await window.api.mods.clawChange(threadId, { kind: "save", profile,
        revision: before.revision, workspace: before.workspace })
      const applied = await window.api.mods.clawChange(threadId, { kind: "apply", id: profile.id,
        revision: saved.revision, bindingRevision: saved.bindingRevision, workspace: saved.workspace })
      if (!applied.active?.capabilities.some(item => item.name === pending.name && item.digest === pending.digest))
        throw Error("Real creator conversation did not apply the approved Mod")
      return { installed, pendingState: pending.state, approvedState: approved.state,
        digest: pending.digest, bindingRevision: applied.bindingRevision }
    }, author)
    evidence.sourceApproval = sourceApproval
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.mods?.stageDebugReview))
    await showCreator()
    await until(() => page.evaluate(id => window.api.mods.platformSurfaceList(id), author),
      catalog => catalog.entries.some(item => item.ref.provider === "stage-debugger" && item.placement === "sidebar"),
      "real installed Mod publishes its sidebar surface")
    const sidebar = page.getByRole("complementary", { name: "扩展侧栏", exact: true })
    await sidebar.getByRole("button", { name: "阶段调试工作台", exact: true }).click()
    const modPane = page.getByRole("region", { name: "阶段调试工作台", exact: true })
    await modPane.getByRole("button", { name: "刷新原生状态", exact: true }).click()
    await modPane.getByRole("button", { name: new RegExp("快照 " + entry.id.slice(0, 12)) }).click()
    await modPane.getByRole("button", { name: new RegExp("候选 " + draft.id + " ·") }).click()
    await modPane.getByText("已选输入快照：" + entry.id, { exact: false }).waitFor()
    await modPane.getByText("已选候选：" + draft.id, { exact: false }).waitFor()
    const beforeSdk = await page.evaluate(id => window.api.harnessBoard.localProjects.preview.stageDebug!.list(id), author)
    assert.deepEqual(beforeSdk.branches, [])
    const requestsBeforeSdk = model.traces.length
    await modPane.getByRole("button", { name: "准备单阶段调试", exact: true }).click()
    await modPane.getByText("方案已校验；尚未创建、执行或批准。", { exact: true }).waitFor()
    assert.deepEqual((await page.evaluate(id => window.api.harnessBoard.localProjects.preview.stageDebug!.list(id), author)).branches, [])
    assert.equal(model.traces.length, requestsBeforeSdk, "SDK prepare is validation, never model execution")
    await modPane.getByRole("button", { name: "前往原生复核（另行确认创建和执行）", exact: true }).click()
    const intent = await until(() => page.evaluate(id => window.api.mods.stageDebugReview.current(id), author),
      value => !!value && value.snapshotId === entry.id && value.draftId === draft.id,
      "fresh native review readback after the actual SDK action ends")
    assert(intent)
    assert.equal(intent.caller.name, "stage-debugger")
    assert.equal(intent.caller.digest, sourceApproval.digest)
    assert.equal(intent.candidateDigest, draft.digest)
    assert.equal(intent.revision, draft.revision)
    assert.equal(intent.mode, "stage")
    const workspaceDialog = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    await workspaceDialog.waitFor({ state: "visible" })
    const debug = workspaceDialog.getByRole("region", { name: "阶段隔离调试", exact: true })
      .filter({ has: page.getByLabel("Mod 提交的阶段调试建议", { exact: true }) })
    assert.equal(await debug.count(), 1, "Only the original native review target should receive the intent")
    await debug.getByLabel("选择阶段输入快照", { exact: true }).waitFor()
    assert.equal(await debug.getByLabel("选择阶段输入快照", { exact: true }).inputValue(), entry.id)
    assert.equal(await debug.getByLabel("选择已保存的最新候选", { exact: true }).inputValue(), draft.id)
    assert.equal(await debug.getByLabel("调试范围", { exact: true }).inputValue(), "stage")
    assert((await debug.getByLabel("Mod 提交的阶段调试建议", { exact: true }).innerText()).includes(sourceApproval.digest))
    assert.equal(await debug.getByRole("region", { name: "阶段调试原生确认", exact: true }).count(), 0,
      "SDK review merely preselects; it cannot install a prepared native approval form")
    assert.deepEqual((await page.evaluate(id => window.api.harnessBoard.localProjects.preview.stageDebug!.list(id), author)).branches, [])
    assert.equal(model.traces.length, requestsBeforeSdk)
    evidence.modSdk = { caller: intent.caller, originalScope: author, snapshotId: intent.snapshotId,
      draftId: intent.draftId, candidateDigest: intent.candidateDigest, nativePreselected: true,
      automaticBranchCreation: false, automaticModelExecution: false }
    await debug.getByRole("button", { name: "准备阶段调试方案", exact: true }).click()
    const confirmation = debug.getByRole("region", { name: "阶段调试原生确认", exact: true })
    const createBranch = confirmation.getByRole("button", {
      name: "确认创建隔离调试分支（尚不执行）",
      exact: true
    })
    assert(await createBranch.isDisabled())
    await confirmation.getByRole("checkbox").check()
    const callsBeforeBranch = model.traces.length
    await createBranch.click()
    const branches = await until(
      () =>
        page.evaluate(
          (id) => window.api.harnessBoard.localProjects.preview.stageDebug!.list(id),
          author
        ),
      (value) => value.branches.some((branch) => branch.snapshotId === entry.id),
      "native confirmed isolated stage branch"
    )
    const record = branches.branches.find((branch) => branch.snapshotId === entry.id)!
    const branch = await readProject(record.projectId)
    assert.notEqual(branch.project.workspace, original.project.workspace)
    assert.equal(branch.project.stageIndex, 1)
    assert.equal(branch.project.manifest.stages.length, 2)
    assert.deepEqual(branch.operations, [], "No inherited approval, operation or receipt")
    assert.equal(record.status, "ready")
    assert.equal(model.traces.length, callsBeforeBranch, "Creating a branch must not run a model")
    assert.deepEqual(
      files(branch.project.workspace), originalReviewInputFiles,
      "Restore every original stage-entry file byte, including native workspace markers"
    )
    assert(!("reviewed.md" in originalReviewInputFiles))
    assert(!("review.json" in originalReviewInputFiles))
    assert.equal(readFileSync(join(branch.project.workspace, "draft.md"), "utf8"), HARNESS_DRAFT)

    // This acceptance ends at explicit native creation: SDK prepare/review is never execution.
    assert.deepEqual(files(original.project.workspace), originalFiles)
    assert.deepEqual((await readProject(originalId)).project, original.project)
    assert.deepEqual(errors, [])
    assert.deepEqual([...model.errors, ...model.original.errors], [])
    evidence.branch = { view: branch, record, noInheritedOperations: true,
      createdByExplicitNativeCheckbox: true, notStarted: true, originalFilesUnchanged: true }
    evidence.success = true
    await page.screenshot({ path: join(fixture.isolated, "stage-debug-mod-native.png") })
    console.log("PASS normal Electron third-party stage-debugger install/approve/Pane/prepare/review → native reprepare/checkbox/create only: " + fixture.isolated)
  } catch (error) {
    evidence.error = String(error)
    evidence.failureUi = await page?.locator("body").innerText().catch(() => "unavailable")
    await page?.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
    throw error
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(fixture.isolated, "report.json"),
      JSON.stringify(
        {
          ...evidence,
          approvals,
          traces: model.traces,
          originalModelRequests: model.original.requests,
          revision: model.revisionDone ? model.revised.revision : null,
          modelErrors: [...model.errors, ...model.original.errors],
          errors,
          limitations: [
            "Deterministic loopback model choices; normal app IPC, tools, permissions and receipts are real",
            "File-only Host stage debugging; no AutoBiz rollback, Git/database/network state restore or arbitrary Hook support",
            "Stops at manually confirmed creation: no debug range execution, PASS, inherited approval or whole-candidate acceptance is claimed",
            "Source authorization uses the real exact-digest renderer API; custom Pane buttons and native reprepare/checkbox/create are actual UI clicks"
          ]
        },
        null,
        2
      )
    )
    await app?.close().catch(() => {})
    await model.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
