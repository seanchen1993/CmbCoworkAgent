/** Production Electron/IPC/QuickJS/Agent loop with isolated data and controlled HTTP models. */
import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { ClawProfile } from "../src/shared/mods/claw"
import type { FlowDefinition, FlowRun } from "../src/shared/mods/flows/types"
import { compositionEnvironment, compositionPlugin } from "./support/mods-composition-fixtures"
import { startFlowModel } from "./support/mods-flow-model"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

const root = resolve(__dirname, "..")
const artifacts = process.env.CMB_MODS_CORE_E2E_ARTIFACTS
  ? resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS)
  : join(root, "output/mods-composition-e2e")
const { isolated, workspace, env } = compositionEnvironment(root)
const launchApp = createModsCoreLauncher(root, isolated, env, artifacts)
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, "report.json"), { force: true })
rmSync(join(artifacts, "failure.json"), { force: true })
rmSync(join(artifacts, "console-errors.json"), { force: true })
const checks: string[] = []
const errors: string[] = []
const consoleErrors: unknown[] = []
const performanceResults: Record<string, unknown> = {
  scope:
    "Local production IPC, two small approved fixture plugins, warm runtime; not a large-workspace benchmark"
}
let app: ElectronApplication | undefined
let page: Page | undefined
const pass = (label: string) => {
  checks.push(label)
  console.log("PASS " + label)
}

async function main() {
  const model = await startFlowModel(workspace)
  const watchdog = setTimeout(() => {
    void app?.close()
  }, 360_000)
  try {
    app = await launchApp(60_000)
    page = await app.firstWindow()
    await page.addInitScript(() => {
      ;(window as unknown as { __CMBConsoleEnabled: boolean }).__CMBConsoleEnabled = true
      const captured: unknown[] = []
      ;(window as unknown as { __compositionConsoleErrors: unknown[] }).__compositionConsoleErrors =
        captured
      const original = console.error
      console.error = (...values: unknown[]) => {
        captured.push(
          values.map((value) =>
            value instanceof Error ? { message: value.message, stack: value.stack } : String(value)
          )
        )
        original.apply(console, values)
      }
    })
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() !== "error") return
      void Promise.all(
        message
          .args()
          .map((argument) =>
            argument
              .evaluate((value) =>
                value instanceof Error
                  ? { message: value.message, stack: value.stack }
                  : String(value)
              )
              .catch(() => "unavailable console argument")
          )
      ).then((arguments_) => {
        consoleErrors.push({ text: message.text(), location: message.location(), arguments_ })
        writeFileSync(
          join(artifacts, "console-errors.json"),
          JSON.stringify(consoleErrors, null, 2)
        )
      })
    })
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    await page.waitForFunction(() => Boolean(window.api?.mods?.clawStart))
    await page.evaluate(() => {
      ;(window as unknown as { __name: unknown }).__name = (v: unknown) => v
    })
    await page.evaluate(async (url) => {
      await window.api.mods.configureGlobal(true)
      for (const id of ["composition-a", "composition-b"])
        await window.api.models.setCustomConfig({
          id,
          name: id,
          baseUrl: url,
          model: id,
          apiKey: "isolated-fixture",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
      await window.api.models.setDefault("custom:composition-a")
    }, model.url)
    const createThread = (title: string) =>
      page!.evaluate(
        async ({ workspace, title }) => {
          const row = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = (row as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(id, workspace)
          await window.api.mods.configure(id, true, true)
          return id
        },
        { workspace, title }
      )
    const threadA = await createThread("Composition A+B")
    const threadB = await createThread("Composition B only")
    for (const name of ["composition-a", "composition-b"] as const) {
      const installed = await page.evaluate(
        (bytes) =>
          window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "composition.zip",
            "local",
            undefined,
            true
          ),
        compositionPlugin(name)
      )
      assert(installed.success, installed.error)
    }
    const plugins = (
      await page.evaluate((id) => window.api.mods.status(id), threadA)
    ).functionMods!.filter((plugin) => plugin.name.startsWith("composition-"))
    assert.equal(plugins.length, 2)
    for (const plugin of plugins)
      await page.evaluate(
        async ({ id, plugin }) => {
          await window.api.mods.approveFunction(id, plugin.pluginId, plugin.digest!)
          await window.api.mods.setCompletionPolicy(id, plugin.name, {
            mode: "off",
            scope: "diff",
            checks: [],
            maxRepairs: 0,
            timeoutMs: 120000,
            modelTokenBudget: 4096
          })
        },
        { id: threadA, plugin }
      )
    const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), threadA)
    const actionA = catalog.actions?.find((action) => action.plugin === "composition-a")
    const actionB = catalog.actions?.find((action) => action.plugin === "composition-b")
    assert(actionA && actionB, "Both independently installed action exports must be discovered")
    const nonce = "composition-" + Date.now()
    const definition: FlowDefinition = {
      schemaVersion: 1,
      id: "composition-roundtrip",
      name: "A to B with model roles",
      plugin: "composition-a",
      goal: "Verify independent composition",
      timeoutMs: 180000,
      maxExecutions: 12,
      steps: [
        {
          id: "produce",
          name: "A produces",
          kind: "plugin-action",
          enabled: true,
          pluginId: actionA.pluginId,
          plugin: actionA.plugin,
          digest: actionA.digest,
          actionId: actionA.actionId,
          input: { nonce },
          config: { tag: "saved-config" }
        },
        {
          id: "review-action",
          name: "B consumes",
          kind: "plugin-action",
          enabled: true,
          pluginId: actionB.pluginId,
          plugin: actionB.plugin,
          digest: actionB.digest,
          actionId: actionB.actionId,
          input: {},
          inputFrom: { stepId: "produce" }
        },
        {
          id: "implement",
          name: "Model A",
          kind: "agent",
          enabled: true,
          modelRole: "implementation",
          prompt: "[FLOW-PLAN] Return a structured result."
        },
        {
          id: "review-model",
          name: "Model B",
          kind: "agent",
          enabled: true,
          modelRole: "review",
          prompt: "[FLOW-REVIEW] Return a structured result."
        },
        {
          id: "confirm",
          name: "Confirmation",
          kind: "approval",
          enabled: true,
          prompt: "Confirm composition"
        }
      ]
    }
    const saved = await page.evaluate(
      ({ id, definition }) => window.api.mods.flowSave(id, definition, 0),
      { id: threadA, definition }
    )
    const profileA: ClawProfile = {
      id: "composition-ab",
      name: "A+B with independent models",
      capabilities: plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        name: plugin.name,
        digest: plugin.digest!
      })),
      models: {
        default: "custom:composition-a",
        roles: { implementation: "custom:composition-a", review: "custom:composition-b" }
      },
      flow: saved
    }
    const saveApply = async (id: string, profile: ClawProfile) =>
      page!.evaluate(
        async ({ id, profile }) => {
          let view = await window.api.mods.clawView(id)
          view = await window.api.mods.clawChange(id, {
            kind: "save",
            profile,
            workspace: view.workspace,
            revision: view.revision
          })
          return window.api.mods.clawChange(id, {
            kind: "apply",
            id: profile.id,
            workspace: view.workspace,
            revision: view.revision
          })
        },
        { id, profile }
      )
    const bindingA = await saveApply(threadA, profileA)
    await saveApply(threadB, {
      id: "composition-b-only",
      name: "B only",
      capabilities: profileA.capabilities.filter(
        (capability) => capability.name === "composition-b"
      ),
      models: { default: "custom:composition-b", roles: {} }
    })
    await page.evaluate(
      (id) =>
        window.api.threads.patchMetadata(id, {
          set: { model: "custom:removed-thread-model" }
        }),
      threadB
    )
    const commandNames = (id: string) =>
      page!.evaluate(
        async (id) => (await window.api.mods.commands(id)).map((command) => command.command).sort(),
        id
      )
    assert.deepEqual(await commandNames(threadA), ["composition-a", "composition-b"])
    assert.deepEqual(await commandNames(threadB), ["composition-b"])
    pass("Two same-workspace conversations keep separate plugin and model bindings")

    const changedDefinition = structuredClone(definition)
    changedDefinition.steps = [
      {
        id: "replaced",
        name: "New template",
        kind: "approval",
        enabled: true,
        prompt: "New template only"
      }
    ]
    await page.evaluate(
      ({ id, definition, revision }) => window.api.mods.flowSave(id, definition, revision),
      { id: threadA, definition: changedDefinition, revision: saved.revision }
    )
    const run = await page.evaluate(
      ({ id, revision, goal }) => window.api.mods.clawStart(id, revision, goal),
      { id: threadA, revision: bindingA.bindingRevision, goal: nonce }
    )
    const readRun = () =>
      page!.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
        id: threadA,
        runId: run.id
      })
    let current: FlowRun | null = run
    for (let attempt = 0; attempt < 600; attempt++) {
      current = await readRun()
      if (current?.status === "waiting") break
      assert(
        current && !["failed", "cancelled", "interrupted", "complete"].includes(current.status),
        JSON.stringify(current)
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.equal(current?.status, "waiting", JSON.stringify(current))
    assert.equal(
      current!.flow.digest,
      saved.digest,
      "Applied flow snapshot must survive template edits"
    )
    const resultA = current!.attempts.find((attempt) => attempt.stepId === "produce")?.result
    const resultB = current!.attempts.find((attempt) => attempt.stepId === "review-action")?.result
    assert.equal(resultA?.output?.configured, "saved-config")
    assert.equal(resultB?.output?.nonce, nonce)
    assert.equal(resultB?.output?.receivedFrom, "composition-a")
    assert.equal(resultB?.provider?.pluginId, actionB.pluginId)
    assert.equal(resultA?.provider?.pluginId, actionA.pluginId)
    assert(
      model.requests.some(
        (request) => request.marker === "PLAN" && request.model === "composition-a"
      )
    )
    assert(
      model.requests.some(
        (request) => request.marker === "REVIEW" && request.model === "composition-b"
      )
    )
    assert(
      !model.requests.some(
        (request) => request.marker === "REVIEW" && request.model !== "composition-b"
      )
    )
    pass(
      "Real QuickJS A output reaches independent B; real HTTP requests honor model roles; applied flow is frozen"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Composition A+B", { exact: true }).first().click()
    await page.getByRole("button", { name: "Claw 工作台", exact: true }).click()
    await page.getByRole("region", { name: "人工成果确认" }).waitFor({ timeout: 30_000 })
    await page.getByRole("button", { name: "收起 Claw 工作台", exact: true }).click()
    assert.equal((await readRun())?.status, "waiting")
    await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
    await page.getByRole("region", { name: "人工成果确认" }).waitFor()
    assert.equal((await readRun())?.pendingApproval?.nonce, current!.pendingApproval!.nonce)
    for (const width of [1366, 1024, 800]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(640, 600)
        window.setContentSize(width, 900)
      }, width)
      await page.waitForFunction((expected) => window.innerWidth === expected, width)
      const composer = page.locator("textarea.composer-textarea")
      assert.equal(await composer.count(), 1)
      assert(await composer.isVisible())
      const bounds = await composer.boundingBox()
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
      await page.screenshot({ path: join(artifacts, `approval-sidebar-${width}.png`) })
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1366, 900)
    )
    await page.getByRole("button", { name: "配置", exact: true }).click()
    await page.screenshot({ path: join(artifacts, "configuration-sidebar.png") })
    await page.getByRole("button", { name: "编辑我的 Claw", exact: true }).click()
    await page.getByLabel("Claw 默认模型").waitFor()
    await page.getByRole("button", { name: profileA.name, exact: true }).click()
    assert.equal(await page.getByLabel("Claw 默认模型").inputValue(), "custom:composition-a")
    assert.equal(await page.getByLabel("Claw 角色模型 review").inputValue(), "custom:composition-b")
    await page.screenshot({ path: join(artifacts, "claw-binding-editor.png") })
    await page.getByRole("button", { name: "回到聊天使用", exact: true }).click()
    pass(
      "Actual Electron approval sidebar and Claw configuration render at 1366, 1024 and 800 widths"
    )
    await assert.rejects(
      page.evaluate(async (id) => {
        const view = await window.api.mods.clawView(id)
        return window.api.mods.clawChange(id, {
          kind: "apply",
          id: null,
          revision: view.revision,
          workspace: view.workspace
        })
      }, threadA),
      /busy|运行|活动|执行|任务或审批正在进行|lease/i
    )
    pass("Active conversation binding cannot be switched during a waiting flow")
    await saveApply(threadB, {
      id: "composition-b-only",
      name: "B independently reapplied",
      capabilities: profileA.capabilities.filter(
        (capability) => capability.name === "composition-b"
      ),
      models: { default: "custom:composition-b", roles: {} }
    })
    assert.equal((await readRun())?.status, "waiting")
    pass("Applying the idle conversation does not revoke the other conversation's waiting run")
    await page.evaluate(
      ({ id, runId, nonce }) => window.api.mods.flowDecide(id, runId, nonce, true),
      {
        id: threadA,
        runId: run.id,
        nonce: current!.pendingApproval!.nonce
      }
    )
    for (let attempt = 0; attempt < 200; attempt++) {
      current = await readRun()
      if (current?.status === "complete") break
      assert(
        current && !["failed", "cancelled", "interrupted"].includes(current.status),
        JSON.stringify(current)
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.equal(current?.status, "complete", JSON.stringify(current))
    pass("The composed A+B and model-role flow reaches production final acceptance after approval")
    const cancelled = await page.evaluate(
      ({ id, revision, goal }) => window.api.mods.clawStart(id, revision, goal),
      {
        id: threadA,
        revision: bindingA.bindingRevision,
        goal: nonce
      }
    )
    await page.evaluate(({ id, runId }) => window.api.mods.flowCancel(id, runId), {
      id: threadA,
      runId: cancelled.id
    })
    assert.equal(
      (
        await page.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
          id: threadA,
          runId: cancelled.id
        })
      )?.status,
      "cancelled"
    )
    assert.equal(
      (await page.evaluate((id) => window.api.mods.clawView(id), threadB)).active?.id,
      "composition-b-only"
    )
    pass("Cancellation settles the real run without altering another conversation binding")

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Composition A+B", { exact: true }).first().click()
    assert.equal(await page.locator("textarea.composer-textarea").count(), 1)
    await page.getByRole("button", { name: "打开 Claw 工作台", exact: true }).click()
    await page.locator("[data-claw-sidebar-shell]").waitFor()
    await page
      .getByText(`可启动流程：${saved.definition.name} · v${saved.revision}`, { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(artifacts, "composition-sidebar.png") })
    pass("Production chat has one composer and a separate Claw sidebar")
    await page.getByText("Composition B only", { exact: true }).first().click()
    await page.locator("textarea.composer-textarea").fill("确认 B 对话的默认模型归属")
    await page.locator("textarea.composer-textarea").press("Enter")
    await page
      .getByText("普通聊天答复：已读取本次问题与运行摘要。", { exact: true })
      .first()
      .waitFor({ timeout: 60_000 })
    assert(
      model.requests.some(
        (request) => request.marker === "UNKNOWN" && request.model === "composition-b"
      )
    )
    pass("The ordinary production chat adapter uses the current conversation's bound default model")
    await page.getByLabel("当前助手指定的聊天模型").waitFor()
    assert.match(await page.getByLabel("当前助手指定的聊天模型").innerText(), /composition-b/)
    await page.screenshot({ path: join(artifacts, "bound-default-model-chat.png") })
    const readCounts = async () => {
      const counts: number[] = []
      for (const command of ["composition-a", "composition-b"]) {
        const job = await page!.evaluate(
          async ({ id, command }) => {
            const descriptor = (await window.api.mods.commands(id)).find(
              (item) => item.command === command
            )!
            return window.api.mods.enqueue(id, descriptor, { text: "inspect-count" })
          },
          { id: threadA, command }
        )
        let count: number | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
          const settled = await page!.evaluate(
            async ({ id, jobId }) =>
              (await window.api.mods.jobs(id)).find((row) => row.id === jobId),
            { id: threadA, jobId: job.id }
          )
          assert(settled?.state !== "failed", settled?.error)
          if (settled?.state === "succeeded") {
            count = Number(settled.result?.text)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(typeof count, "number", "Count probe did not settle")
        counts.push(count!)
      }
      return counts
    }
    const beforeRevocation = await readCounts()
    for (const method of ["clawView", "flowCatalog"] as const) {
      const samples: number[] = []
      for (let index = 0; index < 10; index++) {
        const started = performance.now()
        await page.evaluate(({ id, method }) => window.api.mods[method](id), {
          id: threadA,
          method
        })
        samples.push(performance.now() - started)
      }
      const sorted = [...samples].sort((a, b) => a - b)
      performanceResults[method] = {
        samplesMs: samples,
        p50Ms: (sorted[4] + sorted[5]) / 2,
        p95Ms: sorted[9]
      }
    }
    assert.deepEqual(
      await readCounts(),
      beforeRevocation,
      "Catalog and Claw view reads must not execute actions"
    )
    pass("Ten Claw view and ten catalog IPC reads are measured and cause zero action executions")
    await page.evaluate((id) => window.api.mods.revokeFunction(id, "composition-b"), threadA)
    const rejectedRun = await page.evaluate(
      ({ id, revision, goal }) => window.api.mods.clawStart(id, revision, goal),
      {
        id: threadA,
        revision: bindingA.bindingRevision,
        goal: nonce
      }
    )
    let rejected: FlowRun | null = rejectedRun
    for (let attempt = 0; attempt < 100; attempt++) {
      rejected = await page.evaluate(({ id, runId }) => window.api.mods.flowRun(id, runId), {
        id: threadA,
        runId: rejectedRun.id
      })
      if (rejected?.status === "failed") break
      assert(rejected && ["queued", "running"].includes(rejected.status), JSON.stringify(rejected))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(rejected?.status, "failed", JSON.stringify(rejected))
    assert(!rejected!.attempts.some((attempt) => attempt.status === "passed"))
    assert(rejected!.summary, "Preparation rejection must have a visible reason")
    await page.evaluate(
      ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
      {
        id: threadA,
        pluginId: actionB.pluginId,
        digest: actionB.digest
      }
    )
    assert.deepEqual(
      await readCounts(),
      beforeRevocation,
      "Revoked preparation must execute neither A nor B"
    )
    pass("Revoked plugin authority cannot be revived by an already applied Claw snapshot")
    writeFileSync(
      join(artifacts, "report.json"),
      JSON.stringify(
        {
          passed: true,
          isolated,
          checks,
          pageErrors: errors,
          performance: performanceResults,
          modelRequests: model.requests,
          run: current,
          notCovered: [
            "online model answer quality",
            "arbitrary hook splitting",
            "replaceable sandbox/storage"
          ]
        },
        null,
        2
      )
    )
  } catch (error) {
    const renderedFailure = await page
      ?.locator("body")
      .textContent()
      .catch(() => undefined)
    const capturedConsole = await page
      ?.evaluate(
        () =>
          (window as unknown as { __compositionConsoleErrors?: unknown[] })
            .__compositionConsoleErrors
      )
      .catch(() => null)
    writeFileSync(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          isolated,
          checks,
          errors,
          error: String(error),
          renderedFailure,
          capturedConsole,
          stack: error instanceof Error ? error.stack : undefined,
          modelRequests: model.requests
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
    await model.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
