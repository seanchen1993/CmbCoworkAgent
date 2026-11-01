/** Real configured model, isolated production Electron, public Host IPC. No business fixtures. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectCommand } from "../src/shared/project-runtime/platform-api"
import {
  createUnifiedHostProject,
  openUnifiedHostProject
} from "./support/project-unified-native-journey"
import { readProjectSource } from "../src/main/mods/devtools/project-source"
import { compileNativeComposition } from "../src/main/plugins/native-composition"
import { installLiveNativeProcessApprovals } from "./support/live-native-process-approvals"
import { selectLiveStageOperation } from "./support/live-project-stage-operation"
import { assertLeanResumeProject, prepareLeanResume } from "./support/live-lean-resume"
import { configureLiveRepositoryIdentity } from "./support/live-repository-identity"
import {
  createHeadlessProjectCompositionLaunch,
  existingProjectCompositionEnvironment,
  projectCompositionEnvironment,
  projectCompositionCandidate
} from "./support/project-composition-e2e-fixtures"

async function main() {
  const root = resolve(__dirname, "..")
  const uiJourney = process.env.LEAN_LIVE_UI_JOURNEY === "1"
  const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.0.0")
  assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1", "EXPLICIT_BUILT_PREVIEW_REQUIRED")
  assert.equal(process.env.COMPOSITION_E2E_PACKAGED_DIR, undefined, "NO_PACKAGING_ALLOWED")
  const candidate = projectCompositionCandidate(root)
  assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256, "LATEST_BUNDLE_REQUIRED")
  process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(root, "output/lean-live-20261031")
  const resume = process.env.CREATOR_LEAN_RESUME_RUN
    ? prepareLeanResume({
        run: process.env.CREATOR_LEAN_RESUME_RUN,
        artifactRoot: process.env.COMPOSITION_E2E_ARTIFACT_ROOT,
        projectId: process.env.CREATOR_LEAN_RESUME_PROJECT_ID ?? "",
        appDigest: candidate.sha256,
        sourceDigest: process.env.CREATOR_LEAN_SOURCE_DIGEST ?? "",
        feedbackPath: process.env.CREATOR_LEAN_RESUME_FEEDBACK_FILE ?? ""
      })
    : undefined
  assert(!resume || !uiJourney, "LEAN_RESUME_PUBLIC_IPC_REQUIRED")
  const fixture = resume
    ? existingProjectCompositionEnvironment(root, resume.isolated)
    : projectCompositionEnvironment(root)
  const evidenceDirectory = resume?.directory ?? fixture.isolated
  fixture.env.CMB_MODS_E2E = "0"
  const modelId = process.env.CMB_CREATOR_LIVE_MODEL_ID ?? "claude"
  const configHome = process.env.CMB_CREATOR_LIVE_CONFIG_HOME ?? join(homedir(), ".cmbcoworkagent")
  const stored = JSON.parse(readFileSync(join(configHome, "custom-models.json"), "utf8"))
  const provider = (Array.isArray(stored) ? stored : Object.values(stored)).find(
    (item: { id?: string }) => item.id === modelId
  )
  assert(provider?.model && provider?.baseUrl, "CONFIGURED_PROVIDER_REQUIRED")
  const keyName = "CUSTOM_API_KEY__" + sha(modelId).slice(0, 12)
  const credential = readFileSync(join(configHome, ".env"), "utf8")
    .split("\n")
    .find((line) => line.slice(0, line.indexOf("=")).trim() === keyName)
    ?.split("=")
    .slice(1)
    .join("=")
    .trim()
  assert(credential, "CONFIGURED_PROVIDER_CREDENTIAL_UNAVAILABLE")
  const endpoint = new URL(provider.baseUrl)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/v1"
  if (!endpoint.pathname.endsWith("/chat/completions")) endpoint.pathname += "/chat/completions"
  const redact = (text: string) => text.replaceAll(credential, "[REDACTED]")
  const events: unknown[] = []
  const evidence: Record<string, unknown> = {
    passed: false,
    candidate,
    model: { id: modelId, model: provider.model },
    authorship:
      "Live configured provider through isolated production app; no supplied business outputs",
    interface: "Production Electron and public IPC; harness decisions are automated and disclosed",
    knowledgeScope: "Only the explicitly bound small inventory knowledge directory is evaluated",
    isolated: fixture.isolated,
    evidenceDirectory,
    ...(resume ? { resumedAttempt: resume.attempt, feedback: resume.feedback } : {}),
    events
  }
  const save = (name = "evidence.json", value: unknown = evidence) => {
    const text = redact(JSON.stringify(value, null, 2))
    writeFileSync(join(evidenceDirectory, name), text)
    if (
      resume &&
      ["pending-approval.json", "pending-user-input.json", "pending-model-input.json"].includes(
        name
      )
    )
      writeFileSync(join(fixture.isolated, name), text)
  }
  save()
  const goal =
    "实现本地Node.js ESM库存预留模块，feature使用inventory-reservation。导出createInventory(initialStock)，返回reserve(orderId,sku,quantity)和getStock(sku)。初始库存用对象映射SKU到非负整数。reserve要求非空字符串订单ID与SKU；数量必须为number类型的有限正整数，严格拒绝0、负数、小数、NaN、Infinity、字符串、布尔及null。SKU不存在或库存不足须抛错，失败既不扣库存也不占用订单ID。成功时返回含orderId、sku、quantity的结果并扣减库存；同订单同SKU同数量重试返回原结果且不再次扣减，同订单不同参数必须冲突报错且库存不变。对库存10的SKU-1完整验收：预留3后余7，重试仍7，预留8失败仍7，失败订单随后预留2应成功余5。不得联网、发布或推送；只交付本地代码、真实Node编译/单元/E2E证据与归档。原始需求与知识约束必须贯穿五阶段，不得自称人类已批准。"
  const knowledge = join(fixture.isolated, "knowledge")
  if (!resume) {
    mkdirSync(knowledge)
    writeFileSync(
      join(knowledge, "AGENTS.md"),
      "# 库存服务约束\nINVENTORY_ATOMICITY_RULE: 验证失败必须保持库存和成功订单记录均不变。仅本地交付，禁止远程发布。\n"
    )
    writeFileSync(
      join(knowledge, "inventory.md"),
      "---\ntitle: 库存幂等边界\ntype: Service Knowledge\ndeploy_unit: inventory-api\n---\nINVENTORY_IDEMPOTENCY_RULE: 仅成功预留占用订单ID；相同订单的不同参数必须拒绝。数量严格限定number有限正整数，不能隐式类型转换。\n"
    )
    writeFileSync(
      join(fixture.workspace, "README.md"),
      "# Inventory reservation\nIndependent live acceptance workspace.\n"
    )
    const initialized = spawnSync("git", ["init"], { cwd: fixture.workspace, encoding: "utf8" })
    assert.equal(initialized.status, 0, initialized.stderr)
    configureLiveRepositoryIdentity(fixture.isolated, fixture.workspace)
    for (const args of [
      ["add", "README.md"],
      ["commit", "-m", "chore: initialize independent inventory project"]
    ]) {
      const result = spawnSync("git", args, { cwd: fixture.workspace, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
    }
  }
  for (const command of ["node", "python", "git"]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" })
    assert.equal(result.status, 0, `${command} unavailable`)
    events.push({ preflight: command, version: result.stdout.trim() })
  }
  function archive(directory: string) {
    const zip = new AdmZip()
    function visit(current: string) {
      for (const item of readdirSync(current, { withFileTypes: true })) {
        assert(!item.isSymbolicLink(), "SOURCE_SYMLINK_FORBIDDEN")
        const path = join(current, item.name)
        if (item.isDirectory()) visit(path)
        else zip.addFile(relative(directory, path).replaceAll("\\", "/"), readFileSync(path))
      }
    }
    visit(directory)
    return [...zip.toBuffer()]
  }
  let requests = 0
  const relay = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      assert(++requests <= 160, "LIVE_REQUEST_BUDGET_EXCEEDED")
      body.model = provider.model
      save(`request-${requests}.json`, body)
      const number = requests,
        startedAt = Date.now()
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000)
      })
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json"
      })
      let result = ""
      const decoder = new TextDecoder()
      if (upstream.body)
        for await (const bytes of upstream.body) {
          result += decoder.decode(bytes, { stream: true })
          response.write(bytes)
        }
      result += decoder.decode()
      response.end()
      writeFileSync(join(evidenceDirectory, `response-${number}.txt`), redact(result))
      events.push({ request: number, status: upstream.status, elapsedMs: Date.now() - startedAt })
      save()
    } catch (error) {
      events.push({ relayError: redact(String(error)) })
      save()
      if (!response.headersSent) response.writeHead(502)
      response.end(JSON.stringify({ error: { message: "LIVE_RELAY_FAILURE" } }))
    }
  })
  await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done))
  const address = relay.address()
  assert(address && typeof address !== "string")
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const deadline = Date.now() + 3600000
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    await app.evaluate(installLiveNativeProcessApprovals, {
      isolated: fixture.isolated,
      workspace: fixture.workspace
    })
    page = await app.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard?.localProjects))
    await page.evaluate("window.__name = value => value")
    const modelUrl = `http://127.0.0.1:${address.port}/v1`
    const threadId = await page.evaluate(
      async ({ workspace, modelUrl, model }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "lean-live-relay",
          name: "Lean real model relay",
          model,
          baseUrl: modelUrl,
          apiKey: "localhost-only",
          maxTokens: 128000,
          maxOutputTokens: 12000
        })
        await window.api.models.setDefault("custom:lean-live-relay")
        await window.api.mods.configureGlobal(true)
        const thread = await window.api.threads.create({
          title: "Lean live setup",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        const scope = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, scope.workspace)
        return thread.thread_id
      },
      { workspace: fixture.workspace, modelUrl, model: provider.model }
    )
    const install = async (bytes: number[], name: string) => {
      const result = await page!.evaluate(
        ({ bytes, name }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, name, "local", undefined, false),
        { bytes, name }
      )
      assert(result.success, JSON.stringify(result))
    }
    if (!resume)
      for (const name of ["rules", "knowledge", "delivery"])
        await install(
          archive(join(root, "resources/native-compositions/autobiz-lean/providers", name)),
          `${name}.zip`
        )
    save(
      "provider-status-before.json",
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    )
    const actions = await page.evaluate(async (id) => {
      const status = await window.api.mods.status(id)
      for (const provider of status.functionMods ?? []) {
        if (!provider.name.startsWith("autobiz-lean-")) continue
        if (!provider.digest) throw Error("PROVIDER_DIGEST_REQUIRED")
        await window.api.mods.approveFunction(
          id,
          provider.pluginId,
          provider.digest,
          status.workspace
        )
      }
      return (await window.api.mods.flowCatalog(id)).actions ?? []
    }, threadId)
    save("action-catalog.json", actions)
    save(
      "provider-status-after.json",
      await page.evaluate((id) => window.api.mods.status(id), threadId)
    )
    const selectedSource = process.env.CREATOR_LEAN_PROJECT_SOURCE
    const source = await readProjectSource(
      selectedSource ?? join(root, "resources/native-compositions/autobiz-lean/project")
    )
    if (resume)
      assert.equal(source.bundle.digest, resume.sourceDigest, "LEAN_RESUME_SOURCE_CHANGED")
    if (selectedSource) {
      assert.match(
        process.env.CREATOR_LEAN_SOURCE_DIGEST ?? "",
        /^[a-f0-9]{64}$/,
        "EXPLICIT_LEAN_SOURCE_DIGEST_REQUIRED"
      )
      assert.equal(
        source.bundle.digest,
        process.env.CREATOR_LEAN_SOURCE_DIGEST,
        "LEAN_SOURCE_DIGEST_CHANGED"
      )
    }
    save("authoring-source-provenance.json", {
      root: source.root,
      bundleDigest: source.bundle.digest,
      files: source.bundle.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.text),
        sha256: sha(file.text)
      }))
    })
    const declaration = source.bundle.files.find((file) => file.path === "composition/source.json")!
    const compiled = compileNativeComposition(JSON.parse(declaration.text), {
      files: source.bundle.files.map((file) => ({
        path: file.path,
        bytes: Buffer.from(file.text)
      })),
      actionCatalog: actions
    })
    const pluginName = JSON.parse(
      compiled.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
    ).name as string
    const zip = new AdmZip()
    for (const file of compiled.files) zip.addFile(file.path, file.bytes)
    save("compiled-provenance.json", { lock: compiled.lock, actionLock: compiled.actionLock })
    if (!resume) await install([...zip.toBuffer()], `${pluginName}.zip`)
    const template = await page.evaluate(
      async (name) =>
        (await window.api.harnessBoard.localProjects.templates()).find(
          (item) => item.name === name
        ),
      pluginName
    )
    assert(template && !template.unavailableReason, "LEAN_TEMPLATE_UNAVAILABLE")
    let view = resume
      ? await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          resume.initial.projectId
        )
      : uiJourney
        ? await createUnifiedHostProject(app, page, {
            name: "库存预留真实模型验收",
            workspace: fixture.workspace,
            installedPluginId: template.installedPluginId,
            pluginName: template.name,
            version: template.version,
            goal
          })
        : await page.evaluate(
            async ({ workspace, goal, pluginName }) => {
              const template = (await window.api.harnessBoard.localProjects.templates()).find(
                (item) => item.name === pluginName
              )
              if (!template || template.unavailableReason) throw Error("LEAN_TEMPLATE_UNAVAILABLE")
              return window.api.harnessBoard.localProjects.create({
                name: "库存预留真实模型验收",
                workspace,
                installedPluginId: template.installedPluginId,
                goal,
                expectedTemplate: template.expectedTemplate
              })
            },
            { workspace: fixture.workspace, goal, pluginName }
          )
    if (resume) assertLeanResumeProject(view, resume.initial)
    evidence.projectId = view.project.projectId
    evidence.interface = uiJourney
      ? "Normal project form, real stage buttons and public read-only observations"
      : evidence.interface
    if (uiJourney)
      await page.screenshot({ path: join(fixture.isolated, "ui-created.png"), fullPage: true })
    const projectId = view.project.projectId
    if (!resume)
      for (const [key, value] of [
        ["knowledgeRoot", knowledge],
        [
          "selectedDeployUnits",
          JSON.stringify([{ deployUnitId: "inventory-api", appType: "backend" }])
        ]
      ]) {
        await page.evaluate(
          async ({ projectId, pluginId, key, value }) => {
            const api = window.api.harnessBoard.localProjects.mods.config
            const config = await api.userConfig(projectId, pluginId)
            await api.saveUserConfig(projectId, config, key, value)
          },
          { projectId, pluginId: view.project.installedPluginId, key, value }
        )
      }
    const sourceReview = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      projectId
    )
    save("source-review.json", sourceReview)
    if (sourceReview.source?.state !== "ready")
      await page.evaluate((input) => window.api.harnessBoard.localProjects.mods.approve(input), {
        projectId,
        projectVersion: view.project.version,
        packageDigest: view.project.pluginDigest,
        compiledDigest: sourceReview.source!.digest
      })
    const command = (input: LocalProjectCommand) =>
      page!.evaluate(({ id, input }) => window.api.harnessBoard.localProjects.command(id, input), {
        id: projectId,
        input
      })
    const read = () =>
      page!.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
    const expectedStages = view.project.manifest.stages.map((stage) => stage.id)
    const completedStages: string[] = []
    const resumedStageIndex = resume ? view.project.stageIndex : 0
    evidence.expectedStages = expectedStages
    for (const [index, stage] of view.project.manifest.stages.entries()) {
      if (index < resumedStageIndex) {
        completedStages.push(stage.id)
        events.push({
          stage: stage.id,
          status: "previously-transitioned",
          attempt: resume!.attempt
        })
        continue
      }
      assert.equal(
        candidate.sha256,
        projectCompositionCandidate(root).sha256,
        "BUNDLE_CHANGED_DURING_RUN"
      )
      view = await read()
      assert.equal(
        view.project.manifest.stages[view.project.stageIndex]?.id,
        stage.id,
        "LIVE_CURRENT_STAGE_CHANGED"
      )
      const stageVersion = view.project.version
      const stageIndex = view.project.stageIndex
      const previousOperationIds = view.operations.map((item) => item.operationId)
      if (uiJourney) {
        await openUnifiedHostProject(page, view.project.name, fixture.workspace)
        await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
        do {
          await new Promise((done) => setTimeout(done, 200))
          view = await read()
        } while (
          !view.operations.some(
            (item) => item.stageId === stage.id && item.expectedVersion === stageVersion
          ) &&
          Date.now() < deadline
        )
      } else {
        view = await command({
          kind: "prepare",
          expectedVersion: view.project.version,
          idempotencyKey: randomUUID(),
          ...(resume && index === resumedStageIndex ? { stageInstructions: resume.feedback } : {})
        })
      }
      let operation = selectLiveStageOperation(
        view.operations,
        stage.id,
        stageVersion,
        previousOperationIds
      )
      save(`${stage.id}-prepared.json`, view)
      if (uiJourney && (stage.approval === "human" || operation.contextProvider)) {
        await page.getByRole("button", { name: "批准并执行", exact: true }).click()
      } else if (stage.approval === "human" || operation.contextProvider)
        view = await command({
          kind: "approve",
          operationId: operation.operationId,
          expectedVersion: view.project.version,
          inputFingerprint: operation.inputFingerprint,
          decision: "approved",
          ...(operation.contextProvider
            ? {
                contextProviderApproval: {
                  policyDigest: operation.contextProvider.policyDigest,
                  allowNetworkSideEffects: true
                }
              }
            : {})
        })
      const starting = uiJourney
        ? Promise.resolve(view)
        : command({ kind: "start", operationId: operation.operationId })
      let startError: unknown
      void starting.catch((error) => {
        startError = error
      })
      const seen = new Set<string>()
      while (Date.now() < deadline) {
        if (startError) throw startError
        view = await read()
        operation = view.operations.find((item) => item.operationId === operation.operationId)!
        save(`${stage.id}-current.json`, view)
        if (["failed", "unknown", "cancelled"].includes(operation.status))
          throw Error(`LIVE_${stage.id}_${operation.status}`)
        if (operation.status === "succeeded") break
        if (view.inputWait) {
          save("pending-user-input.json", view.inputWait)
        }
        if (operation.execution?.threadId) {
          const modelInput = await page.evaluate(
            (id) => window.api.userInput.getPending(id),
            operation.execution.threadId
          )
          if (modelInput)
            save("pending-model-input.json", {
              threadId: operation.execution.threadId,
              request: modelInput
            })
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            operation.execution.threadId
          )
          for (const raw of pending) {
            const approval = raw as {
              id: string
              tool_call_id?: string
              tool_call?: { id: string }
              operation?: string
              command?: string
              filePath?: string
            }
            if (seen.has(approval.id)) continue
            // Never approve arbitrary model commands. A reviewer may explicitly add the exact
            // request digest to this run's file while this loop waits; there is no global rule.
            const digest = sha(JSON.stringify(approval))
            save("pending-approval.json", { digest, approval })
            const reviewedPath = join(fixture.isolated, "reviewed-approvals.json")
            const reviewed = existsSync(reviewedPath)
              ? JSON.parse(readFileSync(reviewedPath, "utf8"))
              : []
            const decision = Array.isArray(reviewed)
              ? reviewed.includes(digest)
                ? "approve"
                : undefined
              : reviewed[digest]
            if (!["approve", "reject"].includes(decision)) {
              evidence.pendingApprovalDigest = digest
              save()
              continue
            }
            if (uiJourney) {
              const viewSession = page.getByRole("button", { name: "查看本次会话", exact: true })
              if (await viewSession.isVisible()) await viewSession.click()
              const expectedText =
                approval.operation === "execute"
                  ? approval.command!
                  : `${approval.operation === "write_file" ? "写入" : "编辑"}: ${approval.filePath}`
              await page.getByText(expectedText, { exact: true }).first().waitFor()
              await page.screenshot({
                path: join(fixture.isolated, `ui-approval-${digest}.png`),
                fullPage: true
              })
              await page
                .getByRole("button", {
                  name:
                    decision === "reject"
                      ? "拒绝"
                      : approval.operation === "execute"
                        ? "运行"
                        : "允许",
                  exact: true
                })
                .last()
                .click()
            } else
              await page.evaluate(
                ({ id, call, decision }) =>
                  window.api.sandbox.sendApprovalDecision({
                    requestId: id,
                    tool_call_id: call,
                    type: decision
                  }),
                {
                  id: approval.id,
                  call: approval.tool_call_id ?? approval.tool_call?.id ?? approval.id,
                  decision
                }
              )
            seen.add(approval.id)
            events.push({ stage: stage.id, reviewedApproval: digest })
          }
        }
        await new Promise((done) => setTimeout(done, 700))
      }
      assert.equal(operation.status, "succeeded", "LIVE_TIME_LIMIT")
      assert(
        operation.receipts.length && operation.receipts.every((item) => item.result === "passed"),
        "REAL_CHECKS_REQUIRED"
      )
      save(`${stage.id}-succeeded.json`, view)
      if (uiJourney) await openUnifiedHostProject(page, view.project.name, fixture.workspace)
      // Acceptance is deliberately held for independent model/human review. The reviewer
      // writes the exact Host review digest; this cannot bypass the Host result identity.
      if (view.resultApprovalRequired) {
        assert(view.resultReview, "HOST_RESULT_REVIEW_REQUIRED")
        save(`${stage.id}-review.json`, view.resultReview)
        const digest = sha(JSON.stringify(view.resultReview))
        evidence.pendingResultReview = { stage: stage.id, digest }
        save()
        let accepted = false
        while (Date.now() < deadline) {
          const path = join(fixture.isolated, "reviewed-results.json")
          if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).includes(digest)) {
            accepted = true
            break
          }
          await new Promise((done) => setTimeout(done, 1000))
        }
        assert(accepted, "INDEPENDENT_RESULT_REVIEW_REQUIRED")
        if (uiJourney) {
          await page.getByRole("button", { name: "接受当前成果", exact: true }).click()
          view = await read()
        } else
          view = await command({
            kind: "approve-result",
            operationId: operation.operationId,
            review: view.resultReview,
            decision: "approved"
          })
      }
      if (uiJourney) {
        await page.screenshot({
          path: join(fixture.isolated, `ui-${stage.id}-accepted.png`),
          fullPage: true
        })
        await page
          .getByRole("button", {
            name: stage.id === expectedStages.at(-1) ? "确认完成任务" : "进入下一阶段",
            exact: true
          })
          .click()
        view = await read()
      } else view = await command({ kind: "advance", operationId: operation.operationId })
      assert.equal(view.project.version, stageVersion + 1, "LIVE_TRANSITION_VERSION_MISMATCH")
      assert.equal(view.project.stageIndex, stageIndex + 1, "LIVE_TRANSITION_STAGE_MISMATCH")
      assert.equal(
        view.operations.find((item) => item.operationId === operation.operationId)?.status,
        "transitioned",
        "LIVE_OPERATION_NOT_TRANSITIONED"
      )
      completedStages.push(stage.id)
      events.push({ stage: stage.id, status: "transitioned", requests })
      save()
    }
    evidence.completedProject = view
    evidence.completedStages = completedStages
    assert.deepEqual(completedStages, expectedStages, "ALL_DECLARED_STAGES_REQUIRED")
    assert.equal(
      (await readProjectSource(source.root)).bundle.digest,
      source.bundle.digest,
      "LEAN_SOURCE_CHANGED_DURING_RUN"
    )
    assert.equal(view.project.status, "completed", "HOST_PROJECT_COMPLETION_REQUIRED")
    evidence.passed = view.project.status === "completed"
  } catch (error) {
    evidence.error = redact(String(error))
    process.exitCode = 1
  } finally {
    save()
    await app?.close()
    relay.closeAllConnections()
    await new Promise<void>((done) => relay.close(() => done()))
    console.log(
      JSON.stringify({
        evidence: join(evidenceDirectory, "evidence.json"),
        passed: evidence.passed,
        error: evidence.error
      })
    )
  }
}
void main().catch(() => {
  console.error("LEAN_LIVE_STARTUP_FAILED")
  process.exitCode = 1
})
