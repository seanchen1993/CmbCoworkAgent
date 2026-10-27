import { openCreatorProjectPreview } from "./support/creator-navigation"
/** Real packaged mod_authoring → Skill+nodes → compile → UI preview → two native-tool stages. */
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
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import type { ProjectDevelopmentView } from "../src/main/mods/devtools/project-development-session"
import { readRuntimeScopedFile } from "../src/main/harness-board/project-runtime/safe-files"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { waitForAsyncEvidence } from "./support/async-evidence"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import {
  HARNESS_PACKAGE_ID,
  HARNESS_DRAFT,
  HARNESS_REVIEWED,
  HARNESS_NODE_TITLE,
  startProjectHarnessModel
} from "./support/project-harness-model-fixture"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR?.trim(), "Select the reviewed production package")
const artifacts = resolve(
  root,
  process.env.CMB_PROJECT_HARNESS_E2E_ARTIFACTS ??
    `output/project-platform-20261012/harness-authoring-${randomUUID()}`
)
assert(!existsSync(artifacts), "Preserve prior evidence")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const evidence: Record<string, unknown> = { isolated, manualSourceFiles: 0 }
const errors: string[] = []
const approvals: Array<{ id: string; filePath: string }> = []
let app: ElectronApplication | undefined
let page: Page
const pause = () => new Promise((resolve) => setTimeout(resolve, 150))

async function main() {
  const model = await startProjectHarnessModel()
  const watchdog = setTimeout(() => {
    console.error("HARNESS_E2E_WATCHDOG")
    process.exit(1)
  }, 360000)
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
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "项目模式使用引导", exact: true }),
      async (guide) => guide.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
    )
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    const author = await page.evaluate(
      async ({ url, workspace }) => {
        await window.api.models.setCustomConfig({
          id: "harness-author-fixture",
          name: "隔离节点作者",
          baseUrl: url,
          model: "harness-author-fixture",
          apiKey: "isolated-loopback-fixture",
          maxTokens: 64000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:harness-author-fixture")
        await window.api.mods.configureGlobal(true)
        const thread = await window.api.threads.create({
          title: "技能与节点作者验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(id, workspace)
        await window.api.mods.configure(id, true, true)
        return id
      },
      { url: model.url, workspace }
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.agent))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
    })
    await page.getByText("技能与节点作者验收", { exact: true }).first().click()
    await enterModsCreatorChat(page, author, workspace)
    const installed = await page.evaluate(() => window.api.plugins.list())
    const authorResult = await page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const events: unknown[] = []
          const cleanup = window.api.agent.invoke(
            id,
            "用harness-lite制作两节点项目，只改技能和节点：给复核节点改标题并完善技能说明，先检查旧编译结果再project_compile，检查测试并准备隔离试用。复核时保留原draft.md，把新版本写reviewed.md再写review.json。不要安装或自动开始。",
            (event) => {
              events.push(event)
              if (event.type === "done" || event.type === "error") {
                cleanup()
                resolve({ terminal: event.type, events })
              }
            },
            "custom:harness-author-fixture",
            "normal"
          )
        }),
      author
    )
    evidence.author = authorResult
    assert.equal((authorResult as { terminal: string }).terminal, "done")
    assert.deepEqual(
      model.observations.map((item) => item.action),
      [
        "project_scaffold",
        "project_save",
        "project_doctor",
        "project_compile",
        "project_doctor",
        "project_test",
        "project_dev"
      ]
    )
    const generated = model.draft.source.files
    const manifest = JSON.parse(
      generated.find((file) => file.path === "devclaw.project-runtime.json")!.text
    )
    assert.equal(manifest.stages[1].title, HARNESS_NODE_TITLE)
    assert.deepEqual(manifest.stages[1].artifactIds, ["review", "reviewed"])
    const saved = model.observations[1].packet.result as unknown as {
      source: { files: typeof generated }
    }
    const scaffold = model.observations[0].packet.result as unknown as typeof saved
    for (const path of ["devclaw.project-runtime.json", "tests/project-contract.json"])
      assert.deepEqual(
        saved.source.files.find((file) => file.path === path),
        scaffold.source.files.find((file) => file.path === path),
        "Model edits only nodes and Skills"
      )
    const dev = model.observations[6].packet.result as unknown as ProjectDevelopmentView
    assert.equal(dev.executed, false)
    assert.equal(dev.status, "prepared")
    assert.deepEqual(readdirSync(dev.workspace), [])
    assert.equal(model.draft.revision, 3)
    evidence.prepared = dev
    evidence.compiledSource = model.draft
    console.log(
      "PASS actual model scaffold harness-lite → Skill/node-only save → stale doctor → compile → doctor/test/dev"
    )

    const workspaceDialog = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    const creatorTrigger = page
      .getByLabel("聊天模式与 Mod 状态", { exact: true })
      .locator('button[aria-haspopup="dialog"]')
    if ((await creatorTrigger.getAttribute("aria-expanded")) === "false")
      await creatorTrigger.click()
    await workspaceDialog.waitFor()
    const panel = await openCreatorProjectPreview(page)
    await panel.getByRole("button", { name: "刷新", exact: true }).click()
    await panel.getByLabel("这次试用希望完成什么").fill("保留原稿，生成独立复核版本和真实检查记录")
    const create = panel.getByRole("button", { name: "开始试用", exact: true })
    assert(await create.isEnabled())
    assert.equal(await panel.getByRole("checkbox").count(), 0)
    const beforeCreate = model.requests.length
    await create.click()
    const deadline = Date.now() + 15000
    let projectId: string | undefined
    while (!projectId && Date.now() < deadline) {
      const listing = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.preview.list(id),
        author
      )
      const row = listing.drafts.find((item) => item.id === HARNESS_PACKAGE_ID)
      if (row?.projectId) {
        projectId = row.projectId
        assert.equal(row.development?.currentRevision, 3)
        evidence.preview = row
      } else await pause()
    }
    assert(projectId)
    assert.equal(model.requests.length, beforeCreate, "Preview creation never starts inference")
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), installed)
    await page.screenshot({ path: join(artifacts, "harness-preview-created.png") })
    await workspaceDialog.getByRole("button", { name: "Close", exact: true }).click()
    await workspaceDialog.waitFor({ state: "hidden" })
    const read = () =>
      page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId!)
    let view = await read()
    model.stage(view.project.workspace)
    const executionWorkspace = view.project.workspace
    const openProject = async () => {
      const back = page.getByRole("button", { name: "返回会话", exact: true })
      if (await back.isVisible()) await back.click()
      await page.getByRole("tab", { name: "项目模式", exact: true }).click()
      await page.getByRole("button", { name: "更新列表", exact: true }).click()
      await page.getByRole("button").filter({ hasText: view.project.name }).first().click()
    }
    await openProject()
    for (const stage of ["draft", "review"]) {
      const count = view.operations.length
      await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
      if (stage === "review")
        await page.getByRole("button", { name: "批准并执行", exact: true }).click()
      const until = Date.now() + 90000
      let inConversation = false
      let terminal: LocalProjectView | undefined
      while (Date.now() < until) {
        view = await read()
        const operation = view.operations[0]
        if (
          view.operations.length > count &&
          ["succeeded", "failed", "cancelled", "unknown"].includes(operation.status)
        ) {
          assert.equal(operation.status, "succeeded", JSON.stringify(operation))
          terminal = view
          break
        }
        if (view.operations.length > count && operation.execution?.threadId) {
          const threadId = operation.execution.threadId
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            threadId
          )
          for (const value of pending) {
            const approval = value as { id: string; operation: string; filePath: string }
            assert(approval.id?.trim())
            if (approvals.some((item) => item.id === approval.id)) continue
            assert.equal(approval.operation, "write_file")
            const expected = stage === "draft" ? ["draft.md"] : ["reviewed.md", "review.json"]
            assert(expected.some((path) => join(executionWorkspace, path) === approval.filePath))
            if (!inConversation) {
              await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
              inConversation = true
            }
            await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
            const current = await page.evaluate(
              (id) => window.api.sandbox.getPendingApprovals(id),
              threadId
            )
            assert.equal(current.length, 1)
            assert.deepEqual(current[0], value)
            await page.getByRole("button", { name: "允许", exact: true }).click()
            approvals.push({ id: approval.id, filePath: approval.filePath })
          }
        }
        await pause()
      }
      assert(terminal, `Stage ${stage} timed out`)
      view = terminal
      const operation = view.operations[0]
      const expectedChecks =
        stage === "draft" ? ["draft-check"] : ["review-check", "reviewed-check"]
      assert.deepEqual(
        operation.receipts.map((receipt) => receipt.checkId).sort(),
        expectedChecks.sort()
      )
      assert(operation.receipts.every((receipt) => receipt.result === "passed"))
      for (const receipt of operation.receipts) {
        const check = view.project.manifest.checks.find((item) => item.id === receipt.checkId)!
        const artifact = view.project.manifest.artifacts.find(
          (item) => item.id === check.artifactId
        )!
        assert.equal(
          receipt.artifactFingerprint,
          readRuntimeScopedFile(executionWorkspace, artifact.path).fingerprint,
          "Production receipt must bind the actual current output bytes"
        )
      }
      assert.equal(readFileSync(join(executionWorkspace, "draft.md"), "utf8"), HARNESS_DRAFT)
      if (stage === "review") {
        assert.equal(
          readFileSync(join(executionWorkspace, "reviewed.md"), "utf8"),
          HARNESS_REVIEWED
        )
        assert.equal(
          JSON.parse(readFileSync(join(executionWorkspace, "review.json"), "utf8")).checked,
          true
        )
      }
      evidence[stage] = view
      await openProject()
      await page.getByText("本阶段检查通过", { exact: true }).first().waitFor({ state: "visible" })
      assert.equal(await page.getByText("检查通过，等待进入下一阶段", { exact: true }).count(), 0)
      await page.screenshot({ path: join(artifacts, `harness-${stage}-checked.png`) })
      await page
        .getByRole("button", {
          name: stage === "draft" ? "进入下一阶段" : "确认完成任务",
          exact: true
        })
        .click()
      view = await waitForAsyncEvidence(
        read,
        (state) =>
          stage === "draft" ? state.project.stageIndex === 1 : state.project.status === "completed",
        `harness ${stage} native transition`,
        15_000
      )
    }
    assert.equal(view.project.status, "completed")
    assert.equal(approvals.length, 3)
    assert.deepEqual(
      await page.evaluate(() => window.api.plugins.list()),
      installed,
      "Preview never globally installs the authored package"
    )
    assert.deepEqual(model.errors, [])
    assert.deepEqual(errors, [])
    evidence.completed = view
    console.log(
      "PASS two real preview nodes: read Skills/draft, preserve original, approve three native writes, validate both review outputs, explicit completion; no global installation"
    )
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          success: true,
          ...evidence,
          approvals,
          observations: model.observations,
          requests: model.requests,
          errors,
          limitations: [
            "Deterministic localhost model, not novice study or external model quality",
            "Harness-lite real workflow; fullstack/data contracts are separate evidence",
            "No enterprise service or independent third-party developer acceptance"
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
          ...evidence,
          approvals,
          observations: model.observations,
          requests: model.requests,
          modelErrors: model.errors,
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
