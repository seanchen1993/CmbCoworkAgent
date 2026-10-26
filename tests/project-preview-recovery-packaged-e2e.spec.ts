/** Real creator tools/native trial UI, persisted restart, fresh approval and original executor. */
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import AdmZip from "adm-zip"
import { delimiter, dirname, join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../src/shared/project-runtime/platform-api"
import { openUnifiedHostProject } from "./support/project-unified-native-journey"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import {
  HARNESS_DRAFT,
  HARNESS_PACKAGE_ID,
  HARNESS_REVIEWED,
  startProjectHarnessModel
} from "./support/project-harness-model-fixture"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.CREATOR_E2E_BUILT_PREVIEW === "1")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
// Only this private child's PATH supplies the external Node runtime. Neither the ZIP nor
// production plugin configuration captures this machine's Node installation directory.
const pathKey = Object.keys(fixture.env).find((key) => key.toLowerCase() === "path")
const inheritedPath = pathKey ? fixture.env[pathKey] : ""
if (pathKey) delete fixture.env[pathKey]
fixture.env.PATH = [dirname(process.execPath), inheritedPath].filter(Boolean).join(delimiter)
const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
  unobtrusivePresentation: true
})
const evidence: Record<string, unknown> = { candidate, isolated: fixture.isolated }
const errors: string[] = []
const mixed = process.env.PROJECT_RECOVERY_MIXED === "1"
const mcpJournal = join(fixture.env.TEMP, "package-mcp.jsonl")
const approvals: Array<{ id: string; path: string }> = []
const nativeDialogApprovals: Array<{
  title: string; message: string; detail: string; sourceId: string; approved: boolean
  response: number; signalAborted: boolean; error?: string
}> = []
const timeline: Array<{ at: number; event: string }> = []
const mark = (event: string) => {
  timeline.push({ at: Date.now(), event })
  writeFileSync(join(fixture.isolated, "timeline.json"), JSON.stringify(timeline, null, 2))
}
let app: ElectronApplication | undefined
let page: Page
const pause = () => new Promise((done) => setTimeout(done, 200))
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const end = Date.now() + 90000
  while (Date.now() < end) {
    const value = await read()
    writeFileSync(join(fixture.isolated, "latest.json"), JSON.stringify({ label, value }, null, 2))
    if (accept(value)) return value
    await pause()
  }
  throw Error("Timed out: " + label)
}
async function open() {
  app = await launch()
  for (const [channel, stream] of [
    ["stdout", app.process().stdout],
    ["stderr", app.process().stderr]
  ] as const)
    stream?.on("data", (bytes) =>
      appendFileSync(join(fixture.isolated, `main.${channel}.log`), `[${Date.now()}] ${bytes}`)
    )
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects?.preview))
  await page.evaluate(() => {
    ;(window as unknown as { __name: unknown }).__name = (value: unknown) => value
  })
  if (process.env.PROJECT_RECOVERY_DIAGNOSTICS === "1") {
    await app.evaluate(async () => {
      const inspector = process.getBuiltinModule("node:inspector")
      const session = new inspector.Session()
      session.connect()
      await new Promise<void>((done, fail) =>
        session.post("Profiler.enable", (error) => (error ? fail(error) : done()))
      )
      await new Promise<void>((done, fail) =>
        session.post("Profiler.start", (error) => (error ? fail(error) : done()))
      )
      Object.assign(globalThis, { __projectRecoveryProfiler: session })
    })
  }
}
async function showAuthor(id: string) {
  await page.keyboard.press("Escape")
  const back = page.getByRole("button", { name: "返回会话", exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByText("Project recovery acceptance", { exact: true }).first().click()
  const region = page.getByRole("region", { name: "灵件对话创作", exact: true })
  const status = page.getByLabel("聊天模式与 Mod 状态", { exact: true })
    .locator('button[aria-haspopup="dialog"]')
  const deadline = Date.now() + 20000
  // Source status may automatically open this same workspace after restart. Observe the
  // actual native trigger state instead of blindly toggling an asynchronously opened view.
  while (!(await region.isVisible()) && Date.now() < deadline) {
    if ((await status.getAttribute("aria-expanded")) === "false") {
      await status.click()
      mark("native-author-status-opener-clicked")
    }
    await pause()
  }
  const remaining = deadline - Date.now()
  assert(remaining > 0, "Native author status did not open within the original 20s budget")
  await region.waitFor({ timeout: remaining })
  const trial = page.getByRole("region", { name: "项目模板隔离试用", exact: true })
  if (!(await trial.isVisible()))
    await page.getByText("高级：独立项目试用", { exact: true }).click()
  await trial.waitFor()
  await trial.getByRole("button", { name: "刷新项目草稿", exact: true }).click()
  assert.equal(
    (await page.evaluate((threadId) => window.api.mods.development.status({ threadId }), id)).mode,
    "creator"
  )
  return trial
}
async function prepareNativeMcpApproval(sourceId: string) {
  await app!.evaluate(({ dialog }, expectedSourceId) => {
    const state = globalThis as typeof globalThis & {
      projectMcpNativeApproval?: {
        sourceId: string
        rows: Array<{
          title: string; message: string; detail: string; sourceId: string
          approved: boolean; response: number; signalAborted: boolean; error?: string
        }>
      }
    }
    if (state.projectMcpNativeApproval) {
      state.projectMcpNativeApproval.sourceId = expectedSourceId
      return
    }
    state.projectMcpNativeApproval = { sourceId: expectedSourceId, rows: [] }
    // Electron native-dialog harness response, not an OS click. The original manager
    // must request approval for these exact arguments before the harness can respond.
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as {
        title?: string; message?: string; detail?: string; type?: string; buttons?: string[]
        defaultId?: number; cancelId?: number; noLink?: boolean; signal?: AbortSignal
      }
      const sourceId = state.projectMcpNativeApproval!.sourceId
      let error: string | undefined
      try {
        const target = `mcp:plugin:${sourceId}/package_probe:echo`
        if (options.title !== "批准插件操作" || options.type !== "question" ||
            options.message !== `插件 function:harness-package-observer 请求执行 ${target}` ||
            JSON.stringify(options.buttons) !== JSON.stringify(["拒绝", "允许本次操作"]) ||
            options.defaultId !== 0 || options.cancelId !== 0 || options.noLink !== true ||
            !options.signal || options.signal.aborted)
          throw Error("Unexpected native MCP approval contract")
        const detail = options.detail ?? ""
        const offset = detail.indexOf("{")
        if (offset < 0) throw Error("Missing actual MCP approval arguments")
        const value = JSON.parse(detail.slice(offset))
        if (JSON.stringify(value) !== JSON.stringify({ text: "mod-stamp" }))
          throw Error("Unexpected native MCP approval arguments")
        if (state.projectMcpNativeApproval!.rows.length >= 1)
          throw Error("Repeated native MCP approval in one project stage")
      } catch (failure) { error = String(failure) }
      const approved = error === undefined
      const receipt = {
        title: options.title ?? "", message: options.message ?? "", detail: options.detail ?? "",
        sourceId, approved, response: approved ? 1 : 0,
        signalAborted: options.signal?.aborted ?? true, ...(error ? { error } : {})
      }
      state.projectMcpNativeApproval!.rows.push(receipt)
      console.log("[project-native-mcp-approval]", JSON.stringify(receipt))
      return { response: approved ? 1 : 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, sourceId)
}
async function collectNativeMcpApprovals() {
  if (!mixed) return
  const rows = await app!.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      projectMcpNativeApproval?: { rows: typeof nativeDialogApprovals }
    }
    return state.projectMcpNativeApproval?.rows.splice(0) ?? []
  })
  for (const row of rows) {
    nativeDialogApprovals.push(row)
    assert(row.approved && row.response === 1 && !row.signalAborted, JSON.stringify(row))
  }
}
async function main() {
  const model = await startProjectHarnessModel({
    requestTrial: true,
    ...(mixed
      ? {
          packageExtensions: {
            metadata: {
              mods: "mods/manifest.json",
              mcpServers: ".mcp.json",
              userConfig: {
                audience: {
                  type: "string",
                  title: "验收标记",
                  description: "本地隔离验收值，不写入插件包",
                  required: true
                }
              }
            },
            files: [
              {
                path: "mods/manifest.json",
                text: JSON.stringify({
                  apiVersion: "cmb.mods/v2",
                  id: "harness-package-observer",
                  entry: "main.ts"
                })
              },
              {
                path: "mods/main.ts",
                text: `export function register(on,options){
        if(options.audience!=="native-e2e")throw Error("NATIVE_PROJECT_CONFIGURATION_NOT_BOUND");
        on("session.start",async($,e,next)=>{await $.tool.register({name:"stamp",isDeferred:false,description:"Verify the package's exact Mod",inputSchema:{type:"object",properties:{},additionalProperties:false}});return next(e)});
        on("tool.call",{tool:"mcp__harness-package-observer__stamp"},async($)=>{
          const echo=await $.mcp.call("package_probe","echo",{text:"mod-stamp"});
          return {result:{marker:"HARNESS_PINNED_MOD",echo:echo.content,thread:await $.session.id()}}
        })
      }`
              },
              {
                path: "mods/server.js",
                text: readFileSync(
                  join(root, "tests/support/project-package-mcp-server.mjs"),
                  "utf8"
                )
              },
              {
                path: ".mcp.json",
                text: JSON.stringify({
                  mcpServers: {
                    package_probe: {
                      command: "node",
                      args: ["${CLAUDE_PLUGIN_ROOT}/mods/server.js", "-", "pinned"],
                      env: { CMB_E2E_PACKAGE_MCP_JOURNAL: "-" }
                    }
                  }
                })
              }
            ]
          }
        }
      : {})
  })
  const watchdog = setTimeout(() => void app?.close(), 360000)
  try {
    await open()
    const author = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
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
        const thread = await window.api.threads.create({
          title: "Project recovery acceptance",
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
    await page.getByText("Project recovery acceptance", { exact: true }).first().click()
    const installed = await page.evaluate(() => window.api.plugins.list())
    await page
      .locator("textarea.composer-textarea")
      .fill(
        "制作两阶段项目：保留原draft.md，生成reviewed.md与review.json。用harness-lite改技能和节点" +
          (mixed ? "，同包添加观察Mod与本地MCP验证工具" : "") +
          "，编译检查后请求真实隔离试用，不自动开始。"
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until(
      () => page.evaluate((threadId) => window.api.mods.development.status({ threadId }), author),
      (status) => Boolean(status.projectTrial),
      "real authoring request"
    )
    let panel = await showAuthor(author)
    const create = panel.getByRole("button", { name: "创建试用项目（稍后开始任务）", exact: true })
    assert(await create.isDisabled())
    await panel.getByRole("checkbox").check()
    const beforeCreate = model.requests.length
    await create.click()
    mark("native-project-created-click-complete")
    const listing = await until(
      () => page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), author),
      (value) => Boolean(value.drafts.find((row) => row.id === HARNESS_PACKAGE_ID)?.projectId),
      "native create"
    )
    const projectId = listing.drafts.find((row) => row.id === HARNESS_PACKAGE_ID)!.projectId!
    const read = () =>
      page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
    let view = await read()
    const workspace = view.project.workspace
    assert.deepEqual(readdirSync(workspace), [])
    assert.equal(model.requests.length, beforeCreate, "Creation must not run a stage")
    evidence.created = view
    model.stage(workspace)
    if (mixed) {
      const consent = page.getByRole("region", { name: "本包功能权限", exact: true })
      await consent.getByText("本包灵件：harness-package-observer", { exact: true }).waitFor()
      const approve = consent.getByRole("button", { name: "确认本包灵件权限", exact: true })
      assert(await approve.isDisabled())
      await consent.getByLabel(/^验收标记/).fill("native-e2e")
      await consent.getByRole("button", { name: "保存", exact: true }).click()
      mark("native-required-configuration-saved")
      await consent.getByRole("checkbox").check()
      await approve.click()
      await consent.getByText("此目录已授权当前源码版本。", { exact: true }).waitFor()
      mark("native-source-consent-complete")
      assert.equal(
        model.requests.length,
        beforeCreate,
        "Native Mod authorization must not execute a stage"
      )
      await prepareNativeMcpApproval(view.project.installedPluginId)
    }
    // Execute through the original native runner. Sandbox writes still need real UI approval.
    const execute = async (stage: "draft" | "review") => {
      const previous = (await read()).operations.length
      await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
      mark(`native-stage-${stage}-start-click-complete`)
      if (stage === "review")
        await page.getByRole("button", { name: "批准并执行", exact: true }).click()
      const terminal = await until(read, asyncSafeAccept, "stage " + stage)
      function asyncSafeAccept(value: LocalProjectView) {
        const operation = value.operations[0]
        if (value.operations.length <= previous) return false
        if (["succeeded", "failed", "cancelled", "unknown"].includes(operation.status)) {
          assert.equal(operation.status, "succeeded", JSON.stringify(value))
          return true
        }
        return false
      }
      return terminal
    }
    // Poll native sandbox requests while the original stage is running; grant only expected files.
    let stopApprovals = false
    const approveWrites = (async () => {
      while (!stopApprovals) {
        const value = await read()
        const threadId = value.operations[0]?.execution?.threadId
        if (threadId) {
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            threadId
          )
          for (const request of pending) {
            const approval = request as { id: string; operation: string; filePath: string }
            if (approvals.some((row) => row.id === approval.id)) continue
            assert.equal(approval.operation, "write_file")
            assert(
              ["draft.md", "reviewed.md", "review.json"].some(
                (path) => join(workspace, path) === approval.filePath
              )
            )
            await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
            await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
            await page.getByRole("button", { name: "允许", exact: true }).click()
            approvals.push({ id: approval.id, path: approval.filePath })
          }
        }
        await pause()
      }
    })()
    try {
      view = await execute("draft")
    } finally {
      stopApprovals = true
      await approveWrites
    }
    assert.equal(readFileSync(join(workspace, "draft.md"), "utf8"), HARNESS_DRAFT)
    view = await page.evaluate(
      ({ id, operationId }) =>
        window.api.harnessBoard.localProjects.command(id, {
          kind: "advance",
          operationId
        }),
      { id: projectId, operationId: view.operations[0].operationId }
    )
    assert.equal(view.project.stageIndex, 1)
    view = await page.evaluate(
      ({ id, version }) =>
        window.api.harnessBoard.localProjects.command(id, {
          kind: "prepare",
          expectedVersion: version,
          idempotencyKey: "recovery-before-restart"
        }),
      { id: projectId, version: view.project.version }
    )
    const operation = view.operations[0]
    view = await page.evaluate(
      ({ id, operation }) =>
        window.api.harnessBoard.localProjects.command(id, {
          kind: "approve",
          operationId: operation.operationId,
          expectedVersion: operation.expectedVersion,
          inputFingerprint: operation.inputFingerprint,
          decision: "approved"
        }),
      { id: projectId, operation }
    )
    assert.equal(view.operations[0].approval?.decision, "approved")
    evidence.beforeRestart = view
    const callsBeforeRestart = model.requests.length
    await collectNativeMcpApprovals()
    await app!.close()
    app = undefined
    await open()
    await page.evaluate(async (threadId) => {
      const status = await window.api.mods.status(threadId)
      await window.api.mods.development.setEnabled({
        threadId,
        expectedWorkspace: status.workspace,
        enabled: true
      })
    }, author)
    panel = await showAuthor(author)
    const expired = await read()
    assert.equal(expired.preview?.state, "expired")
    assert.equal(expired.operations[0].approval?.decision, "approved")
    const recover = panel.getByRole("button", { name: "核对并恢复原试用", exact: true })
    assert(await recover.isDisabled())
    assert.equal(model.requests.length, callsBeforeRestart)
    await panel.getByRole("checkbox").check()
    await recover.click()
    view = await until(read, (value) => value.preview?.state === "active", "native recovery")
    assert.equal(view.project.workspace, workspace)
    assert.equal(view.operations[0].status, "cancelled")
    assert.equal(
      model.requests.length,
      callsBeforeRestart,
      "Recovery cannot replay an approval or model call"
    )
    evidence.recovered = view
    if (mixed) await prepareNativeMcpApproval(view.project.installedPluginId)
    await page.screenshot({ path: join(fixture.isolated, "recovered.png") })
    // A newly prepared human stage requires a fresh confirmation after recovery.
    stopApprovals = false
    const secondApprovals = (async () => {
      while (!stopApprovals) {
        const state = await read()
        const threadId = state.operations[0]?.execution?.threadId
        if (threadId) {
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            threadId
          )
          for (const request of pending) {
            const approval = request as { id: string; operation: string; filePath: string }
            if (approvals.some((row) => row.id === approval.id)) continue
            assert.equal(approval.operation, "write_file")
            assert(
              ["reviewed.md", "review.json"].some(
                (path) => join(workspace, path) === approval.filePath
              )
            )
            const show = page.getByRole("button", { name: "查看本次会话", exact: true }).first()
            if (await show.isVisible()) await show.click()
            await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
            await page.getByRole("button", { name: "允许", exact: true }).click()
            approvals.push({ id: approval.id, path: approval.filePath })
          }
        }
        await pause()
      }
    })()
    try {
      view = await execute("review")
    } finally {
      stopApprovals = true
      await secondApprovals
    }
    assert.equal(readFileSync(join(workspace, "reviewed.md"), "utf8"), HARNESS_REVIEWED)
    assert(view.operations[0].receipts.every((receipt) => receipt.result === "passed"))
    view = await page.evaluate(
      ({ id, operationId }) =>
        window.api.harnessBoard.localProjects.command(id, {
          kind: "advance",
          operationId
        }),
      { id: projectId, operationId: view.operations[0].operationId }
    )
    assert.equal(view.project.status, "completed")
    evidence.completed = view
    const creatorResult = await until(
      () => page.evaluate((threadId) => window.api.mods.development.status({ threadId }), author),
      (status) => status.projectTrial?.journey?.phase === "passed",
      "original creator receives the complete native trial result"
    )
    const journey = creatorResult.projectTrial!.journey!
    assert.equal(journey.creatorThreadId, author)
    assert.equal(journey.projectId, projectId)
    assert.equal(journey.candidateDigest, creatorResult.projectTrial!.digest)
    assert.equal(journey.candidateCurrent, true)
    assert.equal(journey.canDeliver, true)
    assert.equal(journey.operationsTruncated, false)
    assert.equal(journey.stages.length, 2)
    for (const stage of journey.stages) {
      assert.equal(stage.status, "passed")
      assert.equal(stage.sessions.length, 1)
      assert(stage.checks.length > 0 && stage.checks.every((check) => check.result === "passed"))
      assert.notEqual(stage.sessions[0].threadId, author, "Stage isolation must remain intact")
    }
    assert.notEqual(journey.stages[0].sessions[0].threadId, journey.stages[1].sessions[0].threadId)
    evidence.creatorJourney = journey
    panel = await showAuthor(author)
    const acceptance = page.getByRole("region", { name: "整轮项目试用验收", exact: true })
    await acceptance.getByText("整轮试用已通过", { exact: true }).waitFor()
    assert.equal(await acceptance.getByLabel("本轮阶段验收", { exact: true })
      .locator(":scope > li").count(), 2)
    await panel.getByLabel("这次试用希望完成什么").fill("第二个独立试用，不继承前次产物")
    await panel.getByRole("checkbox").check()
    await panel.getByRole("button", { name: "创建试用项目（稍后开始任务）", exact: true }).click()
    const next = await until(
      () => page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), author),
      (value) => Boolean(value.drafts[0]?.projectId && value.drafts[0].projectId !== projectId),
      "fresh native trial"
    )
    const nextId = next.drafts[0].projectId!
    const fresh = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), nextId)
    assert.notEqual(fresh.project.workspace, workspace)
    assert.deepEqual(readdirSync(fresh.project.workspace), [])
    assert.equal(readFileSync(join(workspace, "draft.md"), "utf8"), HARNESS_DRAFT)
    await page.evaluate(
      ({ threadId, projectId }) =>
        window.api.harnessBoard.localProjects.preview.finish({ threadId, projectId }),
      { threadId: author, projectId: nextId }
    )
    assert.equal(approvals.length, 3)
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), installed)
    assert.deepEqual(model.errors, [])
    assert.deepEqual(errors, [])
    evidence.fresh = fresh
    if (mixed) {
      const calls = readFileSync(mcpJournal, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.deepEqual(
        calls.map((row) => row.text),
        ["mod-stamp", "draft", "mod-stamp", "review"]
      )
      assert(calls.every((row) => row.source.includes("/mods/server.js")))
      assert(calls.every((row) => !decodeURIComponent(row.source).includes("/installed/")))
      for (const call of calls)
        assert.throws(() => process.kill(call.pid, 0), "Each stage must close its real MCP process")
      evidence.actualPackageMcp = calls
    }
    // The generated package remains a real portable installer input, not just a preview token.
    model.pack()
    await page.keyboard.press("Escape")
    await page
      .locator("textarea.composer-textarea")
      .fill("检查当前项目包并导出ZIP，保留同包资源；不要自动安装。")
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByText("HARNESS_PACKAGE_EXPORTED", { exact: true }).waitFor({ timeout: 90000 })
    const zip = readFileSync(model.packed)
    const installedResult = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, "authored-project.zip", "local"),
      [...zip]
    )
    assert(installedResult.success, installedResult.error)
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (row) => row.name === HARNESS_PACKAGE_ID
    )!
    assert(plugin)
    const exported = await page.evaluate((id) => window.api.plugins.exportForMarket(id), plugin.id)
    assert(exported.success && exported.buffer, exported.error)
    const exportedBytes = Buffer.from(
      await page.evaluate(
        (id) =>
          window.api.plugins
            .exportForMarket(id)
            .then((result) => Array.from(new Uint8Array(result.buffer!))),
        plugin.id
      )
    )
    const archive = new AdmZip(exportedBytes)
    assert(archive.getEntry("devclaw.project-runtime.json"))
    if (mixed)
      for (const path of ["mods/main.ts", "mods/server.js", "mods/manifest.json", ".mcp.json"])
        assert(archive.getEntry(path), path)
    writeFileSync(join(fixture.isolated, "exported-project.zip"), exportedBytes)
    await collectNativeMcpApprovals()
    await app!.close()
    app = undefined
    await open()
    const restoredPlugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (row) => row.id === plugin.id
    )!
    assert(restoredPlugin)
    const installedWorkspace = join(fixture.workspace, "installed-task")
    mkdirSync(installedWorkspace)
    const installedProject = await page.evaluate(
      ({ workspace, pluginId }) =>
        window.api.harnessBoard.localProjects.create({
          workspace,
          installedPluginId: pluginId,
          name: "Roundtrip project",
          goal: "核对重启后完整包资源与本地授权"
        }),
      { workspace: installedWorkspace, pluginId: plugin.id }
    )
    const sourceReview = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      installedProject.project.projectId
    )
    if (mixed) {
      assert.equal(sourceReview.source?.name, "harness-package-observer")
      assert.equal(
        sourceReview.source?.configurationReady,
        false,
        "Native preview values must not become package defaults or another project's configuration"
      )
      assert.equal(
        sourceReview.source?.state,
        "needs-approval",
        "Preview consent cannot authorize an installed project"
      )
      assert(
        readFileSync(join(restoredPlugin.path, ".mcp.json"), "utf8").includes(
          "${CLAUDE_PLUGIN_ROOT}"
        )
      )
      const exportedMcp = JSON.parse(archive.readAsText(".mcp.json"))
      assert.equal(exportedMcp.mcpServers.package_probe.command, "node")
      assert.equal(exportedMcp.mcpServers.package_probe.env?.PATH, undefined)
      assert(!archive.readAsText(".mcp.json").includes(dirname(process.execPath)))
      assert(!archive.readAsText(".mcp.json").includes(fixture.isolated))
      assert(!archive.readAsText(".mcp.json").includes(mcpJournal))
      const normalizePathText = (value: string) => value.replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase()
      for (const entry of archive.getEntries().filter((row) => !row.isDirectory)) {
        const text = normalizePathText(archive.readAsText(entry))
        for (const privatePath of [fixture.isolated, mcpJournal, dirname(process.execPath)])
          assert(!text.includes(normalizePathText(privatePath)), `Private machine path in ${entry.entryName}`)
        assert(!text.includes(normalizePathText(fixture.env.PATH)), `Private child PATH in ${entry.entryName}`)
      }
      const pluginMetadata = JSON.parse(archive.readAsText("plugin.json"))
      assert.equal(pluginMetadata.userConfig.audience.required, true)
      assert.equal(pluginMetadata.userConfig.audience.default, undefined)
      // Installation and ZIP preservation alone do not prove the product can run.
      // Exercise a new installed project from its initial stage through the original UI.
      assert.deepEqual(readdirSync(installedWorkspace), [])
      model.stage(installedWorkspace)
      await page.getByRole("tab", { name: "项目模式", exact: true }).click()
      const onboarding = page.getByRole("button", { name: "知道了，不再提示", exact: true })
      await onboarding.waitFor({ state: "visible", timeout: 2000 }).catch(() => {})
      if (await onboarding.isVisible()) {
        await onboarding.click()
        mark("native-existing-project-onboarding-dismissed")
      }
      await openUnifiedHostProject(page, installedProject.project.name)
      const consent = page.getByRole("region", { name: "本包功能权限", exact: true })
      const approve = consent.getByRole("button", { name: "确认本包灵件权限", exact: true })
      assert(await approve.isDisabled())
      await consent.getByLabel(/^验收标记/).fill("native-e2e")
      await consent.getByRole("button", { name: "保存", exact: true }).click()
      await consent.getByRole("checkbox").check()
      await approve.click()
      await consent.getByText("此目录已授权当前源码版本。", { exact: true }).waitFor()
      mark("native-installed-required-config-and-consent-complete")
      await prepareNativeMcpApproval(plugin.id)
      const ordinary = await page.evaluate((id) => window.api.mods.status(id), author)
      assert(
        !ordinary.functionMods?.some((row) => row.name === "harness-package-observer" && row.state === "ready"),
        "The installed project's native consent cannot authorize the ordinary author chat"
      )
      const installedId = installedProject.project.projectId
      await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
      mark("native-installed-draft-start-click-complete")
      const installedDraft = await until(async () => {
        const view = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), installedId)
        const threadId = view.operations[0]?.execution?.threadId
        if (threadId) {
          const pending = await page.evaluate((id) => window.api.sandbox.getPendingApprovals(id), threadId)
          for (const request of pending) {
            const approval = request as { id: string; operation: string; filePath: string }
            if (approvals.some((row) => row.id === approval.id)) continue
            assert.equal(approval.operation, "write_file")
            assert.equal(approval.filePath, join(installedWorkspace, "draft.md"))
            const show = page.getByRole("button", { name: "查看本次会话", exact: true }).first()
            if (await show.isVisible()) await show.click()
            await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
            await page.getByRole("button", { name: "允许", exact: true }).click()
            approvals.push({ id: approval.id, path: approval.filePath })
          }
        }
        return view
      }, (view) => {
        const operation = view.operations[0]
        if (!operation || !["succeeded", "failed", "cancelled", "unknown"].includes(operation.status)) return false
        assert.equal(operation.status, "succeeded", JSON.stringify(view))
        return true
      }, "installed package actual draft")
      assert.equal(readFileSync(join(installedWorkspace, "draft.md"), "utf8"), HARNESS_DRAFT)
      assert(installedDraft.operations[0].receipts.every((receipt) => receipt.result === "passed"))
      const actualCalls = readFileSync(mcpJournal, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      assert.deepEqual(actualCalls.map((row) => row.text), [
        "mod-stamp", "draft", "mod-stamp", "review", "mod-stamp", "draft"
      ])
      for (const call of actualCalls)
        assert.throws(() => process.kill(call.pid, 0), "Installed stages must close their actual MCP peer")
      assert.equal(approvals.length, 4)
      assert.deepEqual(model.errors, [])
      assert.deepEqual(errors, [])
      evidence.installedDraft = { view: installedDraft, ordinary, actualCalls }
      await collectNativeMcpApprovals()
      assert.equal(nativeDialogApprovals.length, 3)
      mark("native-installed-draft-succeeded")
    } else assert.equal(sourceReview.source, undefined)
    evidence.roundtrip = {
      pluginId: plugin.id,
      installedProject,
      sourceReview,
      exportedFiles: archive.getEntries().map((entry) => entry.entryName)
    }
    writeFileSync(
      join(fixture.isolated, "report.json"),
      JSON.stringify(
        {
          success: true,
          ...evidence,
          approvals,
          nativeDialogApprovals,
          requests: model.requests,
          observations: model.observations,
          limitations: [
            "Deterministic localhost model choices; execution, IPC, permission UI and output validation are real",
            "Three exact MCP operation confirmations use an Electron native-dialog harness response, not OS clicks or human business approval",
            "The MCP command is portable 'node'; only the private test child's PATH supplies external Node22. The static test-peer flag CMB_E2E_PACKAGE_MCP_JOURNAL='-' enables optional telemetry in the private standard TEMP directory. The ZIP contains neither private PATH nor journal destination. This is a test package, not a required production logging configuration; it does not bundle Node or prove cross-OS runtime availability"
          ]
        },
        null,
        2
      )
    )
    console.log(
      "PASS real creator → native empty trial → actual draft → approved-only restart → native exact recovery cancels old approval without replay → fresh approval and actual review → separate empty trial preserves outputs" +
        (mixed ? " → portable node ZIP → install/export/restart → fresh native configuration/consent → actual installed draft/Mod/MCP with drained peers" : "")
    )
  } catch (error) {
    if (app) await collectNativeMcpApprovals().catch(() => {})
    await page?.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
    writeFileSync(
      join(fixture.isolated, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          ...evidence,
          approvals,
          nativeDialogApprovals,
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
    if (process.env.PROJECT_RECOVERY_DIAGNOSTICS === "1" && app) {
      const profile = await app
        .evaluate(async () => {
          const state = globalThis as typeof globalThis & {
            __projectRecoveryProfiler?: import("node:inspector").Session
          }
          const session = state.__projectRecoveryProfiler
          if (!session) return undefined
          const result = await new Promise<import("node:inspector").Profiler.StopReturnType>(
            (done, fail) =>
              session.post("Profiler.stop", (error, value) => (error ? fail(error) : done(value)))
          )
          session.disconnect()
          return result.profile
        })
        .catch(() => undefined)
      if (profile) writeFileSync(join(fixture.isolated, "main.cpuprofile"), JSON.stringify(profile))
    }
    await app?.close().catch(() => {})
    await model.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
