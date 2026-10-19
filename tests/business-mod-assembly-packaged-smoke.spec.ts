/** Final packaged artifact smoke. No model, inference, or performance testing.
 * COMPOSITION_E2E_PACKAGED_DIR=<win-unpacked> npx tsx tests/business-mod-assembly-packaged-smoke.spec.ts --packages <plugins>
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import AdmZip from "adm-zip"
import type { ElectronApplication } from "playwright"
import type { BusinessModInspection } from "../src/shared/business-mods"
import { businessSmokeUiPlan } from "./support/business-smoke-ui-plan"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const argument = process.argv.indexOf("--packages")
assert(argument >= 0 && process.argv[argument + 1], "Explicit --packages is required")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit final packaged candidate is required")
const packages = resolve(process.argv[argument + 1])
const expectCustom = process.argv.includes("--expect-custom")
const diagnosticWithoutRequest = process.argv.includes("--diagnose-without-agent-request")
const prefixArgument = process.argv.indexOf("--package-prefixes")
const prefixes = prefixArgument < 0 ? [] : process.argv[prefixArgument + 1]?.split(",")
assert(
  prefixes && prefixes.every((prefix) => prefix && /^[\w-]+$/.test(prefix)),
  "Invalid package prefixes"
)
const packageFiles = readdirSync(packages)
  .filter(
    (name) =>
      name.endsWith(".zip") &&
      (!prefixes.length || prefixes.some((prefix) => name.startsWith(prefix)))
  )
  .sort()
assert(packageFiles.length >= 2, "Expected at least two assembled demo plugins")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const results: unknown[] = []
const catalogIssues: unknown[] = []
const catalogScopes: Array<{
  pluginId: string
  scope: { projectId: string; threadId: string; expectedWorkspace: string }
}> = []
function assertNoPythonCache(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert(
      entry.name !== "__pycache__" && !entry.name.endsWith(".pyc"),
      `Native commands must leave installed source immutable: ${join(directory, entry.name)}`
    )
    if (entry.isDirectory()) assertNoPythonCache(join(directory, entry.name))
  }
}
const packageMetadata = packageFiles.map((filename) => {
  const zip = new AdmZip(join(packages, filename))
  return {
    metadata: JSON.parse(zip.readAsText("plugin.json")),
    manifest: JSON.parse(zip.readAsText("mods/business/manifest.json"))
  }
})
const zipDigests = packageFiles.map((filename) =>
  createHash("sha256")
    .update(readFileSync(join(packages, filename)))
    .digest("hex")
)
let app: ElectronApplication | undefined
let providerCalls = 0
const providerGuard = createServer((_request, response) => {
  providerCalls++
  response.writeHead(500).end("Unexpected model admission with missing required knowledge")
})
async function main() {
  const watchdog = setTimeout(() => void app?.close(), expectCustom ? 360000 : 180000)
  try {
    await new Promise<void>((done) => providerGuard.listen(0, "127.0.0.1", done))
    const address = providerGuard.address()
    assert(address && typeof address !== "string")
    app = await createHeadlessProjectCompositionLaunch(root, fixture)()
    app
      .process()
      .stdout?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stdout.log"), bytes)
      )
    app
      .process()
      .stderr?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "main.stderr.log"), bytes)
      )
    const page = await app.firstWindow()
    await page.waitForFunction(() =>
      Boolean(window.api?.businessModAssembly && window.api?.projectComposition)
    )
    await page.evaluate(() => window.api.autoCommit.saveSettings({ mode: "off", push: false }))
    for (const filename of packageFiles) {
      const path = join(packages, filename)
      const bytes = readFileSync(path)
      const zip = new AdmZip(bytes)
      const metadata = JSON.parse(zip.readAsText("plugin.json"))
      const manifest = JSON.parse(zip.readAsText("mods/business/manifest.json"))
      const board = JSON.parse(zip.readAsText("board_core/board_config.json"))
      const lock = JSON.parse(zip.readAsText("devclaw.business-assembly.json"))
      assert.equal(lock.name, metadata.name)
      assert(
        !JSON.stringify(lock).includes("pluginId"),
        "Portable provenance cannot depend on source install UUID"
      )
      const installed = await page.evaluate(
        ({ bytes, filename }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, filename, "local"),
        { bytes: [...bytes], filename }
      )
      assert(installed.success, installed.error)
      const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
        (item) => item.name === metadata.name
      )!
      assert(plugin)
      assert.equal(plugin.businessModCount, manifest.modules.length)
      assert.equal(
        plugin.modCount ?? 0,
        manifest.extensions?.length ? 1 : 0,
        "Resident components share one actual function-plugin package; component counts are separate"
      )
      assert.equal(plugin.businessExtensionCount ?? 0, manifest.extensions?.length ?? 0)
      assert([2, 3, 5, 8, 9].includes(plugin.businessModCount!))
      await page.evaluate((id) => window.api.plugins.setEnabled(id, true), plugin.id)
      const projectDir = `packaged-${results.length}`
      const project = await page.evaluate(
        ({ id, name, workspace, projectDir }) =>
          window.api.harnessBoard.createProject({
            adapterId: id,
            adapterType: "plugin",
            name,
            projectCode: projectDir.toUpperCase().replaceAll("-", ""),
            projectFromLean: false,
            projectDir,
            description: "Final packaged native initialization smoke",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace
          }),
        { id: plugin.id, name: metadata.name, workspace: fixture.workspace, projectDir }
      )
      const projectRoot = join(fixture.workspace, projectDir)
      const knowledgeContract = manifest.extensions?.some(
        (extension: { id: string }) => extension.id === "autobiz.knowledge"
      )
      let knowledgeEvidence: unknown
      if (knowledgeContract) {
        assert(
          !existsSync(join(plugin.path, "sys")),
          "Fresh package must not contain a fabricated knowledge cache"
        )
        const before = await page.evaluate(
          ({ pluginId, projectId }) =>
            window.api.harnessBoard.getKnowledgePreview(pluginId, { projectId }),
          { pluginId: plugin.id, projectId: project.projectId }
        )
        assert(before.configured && before.exists && before.path)
        assert.deepEqual(before.files, [], "A new host cache has no loaded knowledge files")
        const data = dirname(before.path)
        const dependencies = resolve("output/creator-context-fixture-deps/node_modules")
        assert(
          existsSync(join(dependencies, "gray-matter/index.js")),
          "Prepare real gray-matter fixture dependencies first"
        )
        mkdirSync(join(data, "collector"), { recursive: true })
        cpSync(dependencies, join(data, "collector/node_modules"), { recursive: true })
        const provider = manifest.extensions.find(
          (extension: { id: string }) => extension.id === "autobiz.knowledge"
        ).contextProvider.entry
        const render = spawnSync(
          "python",
          [
            "-X",
            "utf8",
            join(plugin.path, provider),
            "--devclaw-operation",
            "session-context",
            "--",
            "--selected-deployUnit",
            JSON.stringify([{ deployUnitId: "SMOKE.KNOWLEDGE.NOT.SYNCED" }]),
            "--session-workspace-path",
            projectRoot,
            "--node-command",
            process.execPath
          ],
          {
            cwd: plugin.path,
            encoding: "utf8",
            timeout: 45000,
            windowsHide: true,
            env: {
              ...fixture.env,
              PYTHONDONTWRITEBYTECODE: "1",
              PYTHONIOENCODING: "utf-8",
              PYTHONUTF8: "1",
              DEVCLAW_PLUGIN_DATA_ROOT: data,
              DEVCLAW_RUNTIME_CONFIG_PATH: join(data, "board_config.json"),
              DEVCLAW_KNOWLEDGE_ROOT: before.path,
              DEVCLAW_KNOWLEDGE_READONLY: "0",
              npm_config_offline: "true"
            }
          }
        )
        assert.equal(render.status, 0, render.stderr || String(render.error))
        const actual = JSON.parse(render.stdout)
        const missing = actual.agentmdLoadStatus.find(
          (status: { deployUnitId: string }) => status.deployUnitId === "SMOKE.KNOWLEDGE.NOT.SYNCED"
        )
        assert(
          missing && missing.loaded === false,
          "Actual installed provider must report unsynced knowledge as not loaded"
        )
        assert(!existsSync(join(plugin.path, "sys")))
        assert.deepEqual(readdirSync(before.path), [])
        knowledgeEvidence = {
          nativePreview: before,
          actualProviderStatus: missing,
          businessKnowledgeLoaded: false,
          installedSourceCacheFabricated: false
        }
      }
      const workflow = await page.evaluate(
        (id) => window.api.harnessBoard.getDynamicWorkflowConfig(id),
        project.projectId
      )
      assert(workflow)
      assert.deepEqual(
        workflow.nodes.map((node) => node.id),
        board.workflow.nodes.map((node: { id: string }) => node.id),
        "Native workflow config must match the original assembled board main-chain projection"
      )
      const declared = [
        ...board.workflow.nodes,
        ...(board.workflow.dynamicStages ?? []).flatMap(
          (stage: { nodes: Array<{ id: string }> }) => stage.nodes
        )
      ]
      assert.deepEqual(
        declared.map((node: { id: string }) => node.id).sort(),
        manifest.modules.map((mod: { id: string }) => mod.id).sort(),
        "Every business Mod remains on the main chain or its real dynamic branch"
      )
      if (manifest.modules.length < 8) {
        assert(!workflow.nodes.some((node) => ["dev.code", "ops.archive"].includes(node.id)))
      }
      await page.evaluate(
        ({ projectId, projectRoot }) =>
          window.api.harnessBoard.createFeature({
            projectId,
            feature: "packaged-smoke",
            sessionContextInjectionSource: "plugin",
            sessionWorkspace: { source: "directory", path: projectRoot }
          }),
        { projectId: project.projectId, projectRoot }
      )
      const state = JSON.parse(readFileSync(join(projectRoot, ".autobizdevops/state.json"), "utf8"))
      assert.equal(state.features["packaged-smoke"].checkpoint, "prd_in_progress")
      const nativeRun = await page.evaluate(
        ({ projectId }) => window.api.harnessBoard.getRunDetail(projectId, "packaged-smoke"),
        { projectId: project.projectId }
      )
      assert.equal(nativeRun.adapterSnapshot.mock, false)
      assert.equal(nativeRun.run.slug, "packaged-smoke")
      assert.equal(nativeRun.run.currentNodeId, "biz.prd")
      if (knowledgeContract && !diagnosticWithoutRequest) {
        const callsBefore = providerCalls
        const refusalTitle = `Required knowledge refusal ${metadata.name}`
        const refusalThread = await page.evaluate(
          async ({ projectId, workspace, endpoint, title }) => {
            await window.api.models.setCustomConfig({
              id: "missing-knowledge-guard",
              name: "No model admission",
              baseUrl: endpoint,
              model: "missing-knowledge-guard",
              apiKey: "isolated-fixture",
              maxTokens: 64000,
              maxOutputTokens: 1000
            })
            await window.api.models.setDefault("custom:missing-knowledge-guard")
            const mapping = {
              deployUnitIdMapping: "smoke-missing-unit",
              deployUnitId: "SMOKE.KNOWLEDGE.NOT.SYNCED",
              localRepoPath: workspace
            }
            await window.api.harnessBoard.saveDeployUnitMappings([
              { ...mapping, repositoryPaths: [{ pathId: "smoke-path", localRepoPath: workspace }] }
            ])
            await window.api.harnessBoard.createFeature({
              projectId,
              feature: "missing-knowledge",
              selectedDeployUnits: [mapping],
              sessionContextInjectionSource: "plugin",
              sessionWorkspace: { source: "directory", path: workspace }
            })
            const thread = await window.api.threads.create({
              title,
              workspacePath: workspace,
              agentMode: "normal",
              harnessFeature: { projectId, slug: "missing-knowledge", source: "autobizdevops" }
            })
            await window.api.workspace.set(thread.thread_id, workspace)
            return thread.thread_id
          },
          {
            projectId: project.projectId,
            workspace: projectRoot,
            title: refusalTitle,
            endpoint: `http://127.0.0.1:${address.port}/v1`
          }
        )
        // Feature conversations remain owned by project mode; invoke the real typed IPC
        // against its saved Feature binding, without inventing a normal-chat UI binding.
        const refusal = await page.evaluate((threadId) => {
          return new Promise<unknown[]>((resolve, reject) => {
            const events: unknown[] = []
            const timer = setTimeout(() => {
              cleanup()
              reject(Error(`Required knowledge refusal timed out: ${JSON.stringify(events)}`))
            }, 30000)
            const cleanup = window.api.agent.invoke(
              threadId,
              "Do not run without the selected required knowledge.",
              (event) => {
                events.push(event)
                if (["error", "done"].includes(event.type)) {
                  clearTimeout(timer)
                  cleanup()
                  resolve(events)
                }
              },
              "custom:missing-knowledge-guard",
              "normal"
            )
          })
        }, refusalThread)
        assert.match(JSON.stringify(refusal), /harness_context_unavailable|必需.*知识|必需.*约束/)
        assert.match(JSON.stringify(refusal), /SMOKE.KNOWLEDGE.NOT.SYNCED/)
        assert.equal(
          providerCalls,
          callsBefore,
          "Missing required knowledge must block the actual model boundary"
        )
        knowledgeEvidence = {
          ...(knowledgeEvidence as object),
          nativeRequestRefusal: refusal,
          providerAdmitted: false
        }
      }
      const scope = await page.evaluate(
        async ({ projectId, workspace }) => {
          const thread = await window.api.threads.create({
            title: "Packaged business Mods smoke",
            workspacePath: workspace,
            agentMode: "normal",
            harnessProjectSession: { projectId, kind: "knowledge" }
          })
          await window.api.workspace.set(thread.thread_id, workspace)
          return { projectId, threadId: thread.thread_id, expectedWorkspace: workspace }
        },
        { projectId: project.projectId, workspace: fixture.workspace }
      )
      const nodeCatalog = await page.evaluate(
        (scope) => window.api.nodeComposition.catalog(scope),
        scope
      )
      assert.deepEqual(
        nodeCatalog.nodes.map((node) => node.id),
        workflow.nodes.map((node) => node.id),
        "Project step entry must expose every assembled business Mod"
      )
      const customSelections: unknown[] = []
      if (expectCustom) {
        const custom = nodeCatalog.config.templates.find((item) => item.templateType === "custom")
        assert(custom, "New assembled plugins must actually advertise custom selection")
        const first = [manifest.modules[0].id]
        const selections = [
          custom.requiredNodes.length ? workflow.nodes.map((node) => node.id) : first
        ]
        if (custom.requiredNodes.length) {
          await assert.rejects(
            page.evaluate((input) => window.api.nodeComposition.preview(input), {
              ...scope,
              templateId: custom.id,
              selected: first,
              includeOptionalDependencies: false
            }),
            /必需输入|必需依赖|依赖检查|遗漏/,
            "Original mandatory template nodes cannot turn a partial selection into a valid flow by dropping inputs"
          )
        }
        if (manifest.modules.some((mod: { id: string }) => mod.id === "warehouse.quality")) {
          selections.push(["warehouse.quality"])
          const statePath = join(projectRoot, ".autobizdevops/state.json")
          const beforeRejectedCreate = readFileSync(statePath)
          await assert.rejects(
            page.evaluate((input) => window.api.harnessBoard.createFeature(input), {
              projectId: project.projectId,
              feature: "unsafe-missing-producers",
              workflowTemplate: custom.id,
              workflowNodes: ["warehouse.quality"],
              workflowConfig: nodeCatalog.config,
              sessionContextInjectionSource: "plugin" as const,
              sessionWorkspace: { source: "directory" as const, path: projectRoot }
            }),
            /必需依赖|必需输入/,
            "Calling the original create endpoint must not bypass dependency validation"
          )
          assert.deepEqual(readFileSync(statePath), beforeRejectedCreate)
        }
        for (const [index, selected] of selections.entries()) {
          const plan = await page.evaluate((input) => window.api.nodeComposition.preview(input), {
            ...scope,
            templateId: custom.id,
            selected,
            includeOptionalDependencies: false
          })
          assert.deepEqual(plan.selected, selected)
          assert.equal(plan.entryInputFallbacks.length, 0, "Strict custom keeps required inputs")
          assert.deepEqual(
            plan.ordered,
            selected[0] === "warehouse.quality"
              ? ["biz.prd", "dev.specs", "warehouse.model", "warehouse.sql", "warehouse.quality"]
              : selected,
            "The real dependency closure must add producers, not unrelated development stages"
          )
          const feature = `custom-smoke-${index}`
          await page.evaluate((input) => window.api.nodeComposition.create(input), {
            ...scope,
            planId: plan.planId,
            feature: {
              projectId: project.projectId,
              feature,
              sessionContextInjectionSource: "plugin" as const,
              sessionWorkspace: { source: "directory" as const, path: projectRoot }
            }
          })
          const record = JSON.parse(
            readFileSync(join(projectRoot, ".autobizdevops/state.json"), "utf8")
          ).features[feature]
          assert.equal(record.workflowTemplate, custom.id)
          assert.deepEqual(record.workflowNodes, plan.ordered)
          assert.equal(record.checkpoint, "prd_in_progress")
          customSelections.push({ selected, ordered: plan.ordered, added: plan.added, record })
        }
      }
      const inspection = await page.evaluate(
        ({ scope, pluginId }) => window.api.businessModAssembly.inspect({ ...scope, pluginId }),
        { scope, pluginId: plugin.id }
      )
      assert.deepEqual(
        inspection?.mods.map((mod) => mod.id),
        [...manifest.modules, ...(manifest.extensions ?? [])].map((mod: { id: string }) => mod.id)
      )
      const catalog = await page.evaluate(
        (scope) => window.api.projectComposition.catalog(scope),
        scope
      )
      const entry = catalog.entries.find(
        (entry) =>
          entry.source.pluginId === plugin.id && entry.source.capabilityId === "project-flow"
      )
      assert(entry, JSON.stringify({ entry, diagnostics: catalog.diagnostics }))
      if (!entry.available)
        catalogIssues.push({ filename, entry, diagnostics: catalog.diagnostics })
      catalogScopes.push({ pluginId: plugin.id, scope })
      assertNoPythonCache(plugin.path)
      results.push({
        filename,
        zipSha256: createHash("sha256").update(bytes).digest("hex"),
        pluginId: plugin.id,
        name: metadata.name,
        version: metadata.version,
        businessModCount: plugin.businessModCount,
        businessExtensionCount: plugin.businessExtensionCount ?? 0,
        nodes: workflow.nodes.map((node) => node.id),
        dynamicStages: board.workflow.dynamicStages,
        nativeRun,
        knowledge: knowledgeEvidence,
        nativeCheckpoint: state.features["packaged-smoke"].checkpoint,
        templates: nodeCatalog.config.templates,
        customSelections,
        catalog: entry,
        assembledSource: inspection
      })
      writeFileSync(
        join(fixture.isolated, "native-progress.json"),
        JSON.stringify(
          {
            candidate,
            results,
            catalogIssues,
            passed: false,
            complete: false
          },
          null,
          2
        )
      )
    }
    assert.equal((await page.evaluate(() => window.api.plugins.list())).length, packageFiles.length)
    await page.evaluate(async (workspace) => {
      const thread = await window.api.threads.create({
        title: "Packaged business Mods authoring",
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
    }, fixture.workspace)
    // Refresh through the normal renderer bootstrap so its real thread store
    // observes the persisted chat; no injected store or test-only scope.
    await page.reload()
    await page.getByRole("button", { name: "自定义设置", exact: true }).click()
    if (!(await page.getByRole("button", { name: "灵件管理", exact: true }).isVisible()))
      await page.getByRole("button", { name: "高级自定义", exact: true }).click()
    await page.getByRole("button", { name: "灵件管理", exact: true }).click()
    await page.getByRole("combobox", { name: "配置目标聊天", exact: true }).click()
    await page.getByRole("option", { name: /Packaged business Mods authoring/ }).click()
    await page.getByRole("button", { name: "我已添加", exact: true }).click()
    const uiPlan = businessSmokeUiPlan(
      packageMetadata.map((source, index) => ({
        ...source,
        inspection: (results[index] as { assembledSource: BusinessModInspection }).assembledSource
      }))
    )
    for (const installed of uiPlan.installed) {
      const row = page.getByRole("article", { name: installed.name, exact: true })
      await row.getByText(`${installed.business} 个可组合业务 Mods`, { exact: false }).waitFor()
      if (installed.extensions)
        await row.getByText(`${installed.extensions} 个可组合常驻扩展`, { exact: false }).waitFor()
    }
    await page.screenshot({
      path: join(fixture.isolated, "packaged-business-mods-installed.png"),
      fullPage: true
    })
    const uiAssemblyPreviews: Array<{
      source: string
      selected: string[]
      steps: Array<{ id: string; title: string }>
      extensions: Array<{ id: string; title: string }>
      fixedWorkflowAcknowledgement: string
      generatedCopy: boolean
      screenshot: string
    }> = []
    for (const [index, assembly] of uiPlan.assemblies.entries()) {
      if (index) {
        // A new panel owns one source/kernel. Do not mix two assembled parent packages.
        await page.reload()
        await page.getByRole("button", { name: "自定义设置", exact: true }).click()
        if (!(await page.getByRole("button", { name: "灵件管理", exact: true }).isVisible()))
          await page.getByRole("button", { name: "高级自定义", exact: true }).click()
        await page.getByRole("button", { name: "灵件管理", exact: true }).click()
        await page.getByRole("combobox", { name: "配置目标聊天", exact: true }).click()
        await page.getByRole("option", { name: /Packaged business Mods authoring/ }).click()
      }
      await page
        .getByLabel("灵件工作区", { exact: true })
        .getByRole("button", { name: "对话创作", exact: true })
        .click()
      await page
        .getByRole("button", { name: "高级：手动组装、源码与历史版本", exact: true })
        .click()
      await page.getByRole("button", { name: "从 Mods 组装", exact: true }).click()
      const panel = page.getByRole("region", { name: "业务 Mods 组装", exact: true })
      await panel.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
      await panel
        .getByLabel("已安装的 Mods 来源", { exact: true })
        .selectOption({ label: assembly.name })
      await panel.getByRole("button", { name: "读取插件 Mods", exact: true }).click()
      await panel
        .getByRole("checkbox")
        .nth(assembly.all.length - 1)
        .waitFor()
      assert.equal(await panel.getByRole("checkbox").count(), assembly.all.length)
      // The real panel preserves checkbox selection order in request.order.
      // Select business producers before consumers, then retain declared extensions.
      for (const mod of [...assembly.steps, ...assembly.extensions]) {
        const position = assembly.all.findIndex((item) => item.id === mod.id)
        assert(position >= 0, `Missing original native module: ${mod.id}`)
        const checkbox = panel.getByRole("checkbox").nth(position)
        assert.equal(await checkbox.getAttribute("aria-label"), `选择 Mod ${mod.title}`)
        await checkbox.check()
      }
      await panel.getByLabel("新插件名称", { exact: true }).fill(`packaged-ui-preview-${index}`)
      await panel.getByRole("button", { name: "预览新插件", exact: true }).click()
      const preview = panel.locator('[aria-label="组装预览"]')
      const generate = preview.getByRole("button", { name: "生成独立插件", exact: true })
      await generate.waitFor()
      assert.equal(await preview.locator("ol li").count(), assembly.steps.length)
      const steps = await preview.locator("ol li").allTextContents()
      assembly.steps.forEach((mod, step) => {
        assert(
          steps[step].includes(mod.title) && steps[step].includes(assembly.name),
          `Preview must preserve the selected source step: ${mod.id}`
        )
      })
      for (const extension of assembly.extensions)
        await preview
          .getByLabel("常驻扩展预览", { exact: true })
          .getByText(`${extension.title} · ${assembly.name}`, { exact: true })
          .waitFor()
      const fixed = preview.getByRole("checkbox", { name: /我选择使用当前所选的固定步骤/ })
      const requiresAcknowledgement = (await fixed.count()) === 1
      if (requiresAcknowledgement) {
        assert.equal(
          await generate.isEnabled(),
          false,
          "Original fixed-step acknowledgement must gate creation"
        )
        await fixed.check()
      }
      await page.waitForFunction(() => {
        const preview = document.querySelector('[aria-label="组装预览"]')
        return [...(preview?.querySelectorAll("button") ?? [])].some(
          (button) => button.textContent?.trim() === "生成独立插件" && !button.disabled
        )
      })
      assert(await generate.isEnabled())
      const screenshot = index
        ? "packaged-resident-extension.png"
        : "packaged-business-mods-creator.png"
      await page.screenshot({ path: join(fixture.isolated, screenshot), fullPage: true })
      assert(await page.getByRole("button", { name: "从 Mods 组装", exact: true }).isVisible())
      uiAssemblyPreviews.push({
        source: assembly.name,
        selected: assembly.selected.map((mod) => mod.id),
        steps: assembly.steps.map((mod) => ({ id: mod.id, title: mod.title })),
        extensions: assembly.extensions.map((mod) => ({ id: mod.id, title: mod.title })),
        fixedWorkflowAcknowledgement: requiresAcknowledgement
          ? "Explicit original native checkbox; generation was disabled before acknowledgement"
          : "Not required by the original preview",
        generatedCopy: false,
        screenshot
      })
    }
    const afterUiCatalog: Array<{
      pluginId: string
      available: boolean
      pythonCachePresent: boolean
    }> = []
    for (const { pluginId, scope } of catalogScopes) {
      const catalog = await page.evaluate(
        (scope) => window.api.projectComposition.catalog(scope),
        scope
      )
      const entry = catalog.entries.find(
        (entry) =>
          entry.source.pluginId === pluginId && entry.source.capabilityId === "project-flow"
      )
      assert(
        entry?.available,
        JSON.stringify({ pluginId, entry, diagnostics: catalog.diagnostics })
      )
      const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
        (item) => item.id === pluginId
      )!
      assertNoPythonCache(plugin.path)
      afterUiCatalog.push({ pluginId, available: true, pythonCachePresent: false })
    }
    for (const [index, filename] of packageFiles.entries())
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(packages, filename)))
          .digest("hex"),
        zipDigests[index]
      )
    const output = process.env.COMPOSITION_E2E_ARTIFACT_ROOT
      ? resolve(process.env.COMPOSITION_E2E_ARTIFACT_ROOT)
      : resolve("output/demo-readiness-20261016")
    mkdirSync(output, { recursive: true })
    const evidence = {
      passed: catalogIssues.length === 0 && !diagnosticWithoutRequest,
      candidate,
      isolated: fixture.isolated,
      results,
      catalogIssues,
      providerCalls,
      asarSha256: candidate.sha256,
      afterUiCatalog,
      diagnosticWithoutRequest,
      ui: {
        installedCounts: uiPlan.installed,
        creatorEntry:
          "Real persisted workspace chat selected through normal configuration picker; actual selected sources, required dependency closure and declared extensions checked through native UI; valid preview and generation-button gates verified, no copy generated by this UI segment",
        assemblyPreviews: uiAssemblyPreviews,
        screenshots: [
          "packaged-business-mods-installed.png",
          ...uiAssemblyPreviews.map((item) => item.screenshot)
        ]
      },
      limits:
        "Final packaged IPC, metadata, original initialization, catalog and assembly preview. With --expect-custom, also verifies dependency closure, rejected forged selections and real feature state. Does not execute a complete model-driven business workflow."
    }
    writeFileSync(
      join(output, "business-mods-packaged-smoke.json"),
      JSON.stringify(evidence, null, 2)
    )
    writeFileSync(join(fixture.isolated, "evidence.json"), JSON.stringify(evidence, null, 2))
    assert.equal(
      catalogIssues.length,
      0,
      `Every native project-flow catalog entry must remain available: ${JSON.stringify(catalogIssues)}`
    )
    assert(!diagnosticWithoutRequest, "Diagnostic-only run cannot produce a final passed receipt")
    console.log(`PASS final packaged business Mods smoke: ${fixture.isolated}`)
  } catch (error) {
    const page = await app?.firstWindow().catch(() => undefined)
    if (page && !page.isClosed()) {
      writeFileSync(
        join(fixture.isolated, "failure.json"),
        JSON.stringify(
          {
            error: String(error),
            body: await page.locator("body").innerText(),
            results,
            catalogIssues
          },
          null,
          2
        )
      )
      await page
        .screenshot({ path: join(fixture.isolated, "failure.png"), fullPage: true, timeout: 5000 })
        .catch(() => undefined)
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    await app?.close()
    await new Promise<void>((done) => providerGuard.close(() => done()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
