/** Live authoring scenarios. Seed packages are disclosed installed inputs, never model output. */
import assert from "node:assert/strict"
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import AdmZip from "adm-zip"
import type { Page } from "playwright"
import {
  nativeCompositionSchema,
  compileNativeComposition
} from "../../src/main/plugins/native-composition"
import { readProjectSource } from "../../src/main/mods/devtools/project-source"
import { createProjectTemplate } from "../../src/main/mods/devtools/project-template"
import { stageMapping } from "../../resources/native-compositions/autobiz-lean/providers/knowledge/mods/stage-selection"

export type CreatorProjectMatrixMode = "autobiz-from-zero" | "report-derived" | "autobiz-derived"
export function creatorProjectMatrixMode(value: string | undefined) {
  if (value === undefined) return undefined
  assert(
    ["autobiz-from-zero", "report-derived", "autobiz-derived"].includes(value),
    "LIVE_PROJECT_MATRIX_MODE_INVALID"
  )
  return value as CreatorProjectMatrixMode
}

export interface MatrixCandidate {
  draftId: string
  revision: number
  digest: string
  source: ReturnType<typeof nativeCompositionSchema.parse>
  skills: Record<string, string>
}
export interface MatrixSeed {
  installedPluginId: string
  name: string
  directory: string
  digest: string
  source: MatrixCandidate["source"]
  skills: Record<string, string>
  origin: "installed-reference-fixture" | "real-model-delivered-plugin"
  deliveredSourceProof?: import("./matrix-delivered-source-proof").DeliveredMatrixSourceProof
}
function readComposition(directory: string) {
  const root = realpathSync(directory)
  const read = (path: string) => {
    const file = realpathSync(join(root, path))
    const tail = relative(root, file)
    assert(
      tail &&
        !isAbsolute(tail) &&
        tail !== ".." &&
        !tail.startsWith("..\\") &&
        !tail.startsWith("../"),
      "LIVE_MATRIX_SOURCE_PATH_OUTSIDE_PACKAGE"
    )
    return readFileSync(file, "utf8")
  }
  const source = nativeCompositionSchema.parse(JSON.parse(read("composition/source.json")))
  return {
    source,
    skills: Object.fromEntries(source.modules.map((module) => [module.id, read(module.skill)]))
  }
}
export function readMatrixCandidate(
  isolated: string,
  request: { draftId: string; revision: number; digest: string }
): MatrixCandidate {
  assert(/^[a-z][a-z0-9-]{0,47}$/.test(request.draftId), "LIVE_MATRIX_DRAFT_ID_INVALID")
  assert(Number.isSafeInteger(request.revision) && request.revision > 0)
  assert.match(request.digest, /^[a-f0-9]{64}$/)
  const root = realpathSync(join(isolated, "electron/mods/project-authoring"))
  const matches = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(root, entry.name), { withFileTypes: true })
        .filter(
          (draft) =>
            draft.isDirectory() && draft.name.startsWith(`${request.draftId}-r${request.revision}-`)
        )
        .map((draft) => join(root, entry.name, draft.name))
    )
  assert.equal(matches.length, 1, "LIVE_MATRIX_REVISION_AMBIGUOUS")
  return { ...request, ...readComposition(matches[0]) }
}

function archiveFiles(files: Array<{ path: string; bytes: Buffer }>) {
  const zip = new AdmZip()
  for (const file of files) zip.addFile(file.path, file.bytes)
  return [...zip.toBuffer()]
}
function archiveDirectory(directory: string) {
  const zip = new AdmZip()
  zip.addLocalFolder(directory)
  return [...zip.toBuffer()]
}

export async function readInstalledMatrixSeed(
  page: Page,
  pluginId: string,
  origin: MatrixSeed["origin"]
): Promise<MatrixSeed> {
  const plugin = await page.evaluate(
    async (id) => (await window.api.plugins.list()).find((item) => item.id === id),
    pluginId
  )
  assert(plugin?.enabled && plugin.path, "LIVE_MATRIX_INSTALLED_SOURCE_MISSING")
  const source = await readProjectSource(plugin.path)
  return {
    installedPluginId: plugin.id,
    name: plugin.name,
    directory: plugin.path,
    digest: source.bundle.digest,
    ...readComposition(plugin.path),
    origin
  }
}

/** Actual public install/approval calls provision only the source the model must derive from. */
export async function provisionMatrixSeed(
  page: Page,
  root: string,
  threadId: string,
  mode: CreatorProjectMatrixMode,
  inheritedPluginId?: string,
  isolationRoot?: string,
  threadTitle?: string
): Promise<MatrixSeed | undefined> {
  if (mode === "autobiz-from-zero") return undefined
  if (inheritedPluginId)
    return readInstalledMatrixSeed(page, inheritedPluginId, "real-model-delivered-plugin")
  const deliveredRun = process.env.CREATOR_LIVE_MATRIX_DELIVERED_RUN
  if (deliveredRun) {
    assert.equal(mode, "report-derived", "DELIVERED_SEED_EXACT_SCENARIO_REQUIRED")
    assert(isolationRoot, "DELIVERED_SEED_ISOLATION_REQUIRED")
    assert(threadTitle, "DELIVERED_SEED_THREAD_TITLE_REQUIRED")
    const { installDeliveredMatrixSource } = await import("./matrix-delivered-source-install")
    const installed = await installDeliveredMatrixSource({
      page,
      repository: root,
      threadId,
      threadTitle,
      run: deliveredRun,
      isolationRoot
    })
    return {
      ...(await readInstalledMatrixSeed(page, installed.pluginId, "real-model-delivered-plugin")),
      deliveredSourceProof: installed.proof
    }
  }
  const install = async (bytes: number[], name: string) => {
    const result = await page.evaluate(
      ({ bytes, name }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, name, "local", undefined, false),
      { bytes, name }
    )
    assert(result.success, "LIVE_MATRIX_SEED_INSTALL_FAILED")
  }
  const name = mode === "report-derived" ? "matrix-report-source" : "autobiz-lean"
  if (mode === "report-derived") {
    const template = createProjectTemplate({
      packageId: name,
      name: "资料核对参考模板",
      template: "native-modular"
    })
    await install(
      archiveFiles(
        template.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) }))
      ),
      `${name}.zip`
    )
  } else {
    for (const provider of ["rules", "knowledge", "delivery"])
      await install(
        archiveDirectory(
          join(root, "resources/native-compositions/autobiz-lean/providers", provider)
        ),
        `matrix-${provider}.zip`
      )
    const actions = await page.evaluate(async (id) => {
      const status = await window.api.mods.status(id)
      for (const name of [
        "autobiz-lean-rules",
        "autobiz-lean-knowledge",
        "autobiz-lean-delivery"
      ]) {
        const matches = (status.functionMods ?? []).filter((provider) => provider.name === name)
        if (matches.length !== 1 || !matches[0].digest)
          throw Error("LIVE_MATRIX_PROVIDER_IDENTITY_REQUIRED")
        await window.api.mods.approveFunction(
          id,
          matches[0].pluginId,
          matches[0].digest,
          status.workspace
        )
      }
      return (await window.api.mods.flowCatalog(id)).actions ?? []
    }, threadId)
    const source = await readProjectSource(
      join(root, "resources/native-compositions/autobiz-lean/project")
    )
    const compiled = compileNativeComposition(
      JSON.parse(source.bundle.files.find((file) => file.path === "composition/source.json")!.text),
      {
        files: source.bundle.files.map((file) => ({
          path: file.path,
          bytes: Buffer.from(file.text)
        })),
        actionCatalog: actions
      }
    )
    await install(archiveFiles(compiled.files), `${name}.zip`)
  }
  const matches = await page.evaluate(
    async (name) => (await window.api.plugins.list()).filter((item) => item.name === name),
    name
  )
  assert.equal(matches.length, 1, "LIVE_MATRIX_SEED_IDENTITY_AMBIGUOUS")
  return readInstalledMatrixSeed(page, matches[0].id, "installed-reference-fixture")
}

export function matrixFirstPrompt(mode: CreatorProjectMatrixMode, seed?: MatrixSeed) {
  if (seed)
    return `请从已安装的项目插件派生一个独立项目插件草稿。真实安装身份 pluginId=${seed.installedPluginId}，名称=${seed.name}。使用 inspect_plugin 与 project_from_plugin 原生派生入口，不能从零重写或导入源码。第一轮完整保留阶段、Skill、输入输出、检查、知识、配置和公开依赖。使用独立草稿id，编译检查并准备可确认的隔离试用候选。不要安装或执行，不代替用户批准。`
  assert.equal(mode, "autobiz-from-zero")
  return "从零创建一个名为AutoBiz研发需求准备的项目插件，不能派生或读取现有AutoBiz项目作者源码。这里只做小型研发需求准备流程，不实现编码、Git、部署或冒称完整AutoBiz。用native-modular模板，3个阶段baseline、solution、delivery。baseline生成baseline.json，对象含request非空字符串与requirements非空字符串数组；solution读取baseline.json，输出solution.json，对象含design非空字符串、acceptance非空字符串数组；delivery读取两份上游产物，输出delivery.json，对象含summary非空字符串、limitations非空字符串数组。每个输出使用真实JSON Schema门禁，所有字段required且字符串minLength=1、数组minItems=1。保持本地文件范围，不调用命令或网络，不编写状态文件；成果需人工确认。为每步写合法name/description的Skill，并同步更新模板契约测试，不要保留引用已删除阶段的测试。检查、编译、测试并准备隔离试用候选，不执行不安装不代我授权。"
}

export function matrixFollowupPrompt(before: MatrixCandidate, mode?: CreatorProjectMatrixMode) {
  const previous = before.source.modules.at(-1)!
  const artifact = previous.outputs[0]
  const auditId = before.source.modules.some((module) => module.id === "audit")
    ? "audit-again"
    : "audit"
  const configuration =
    mode === "autobiz-derived"
      ? `新增阶段还需要按此插件公开知识提供器契约增补配置：先读取已安装autobiz-lean-knowledge的公开说明/配置契约与当前contextAction，给contextAction.config.stageTags.${auditId}显式配置非空合法知识标签。审计包含交付和归档引用，至少保留当前${previous.id}阶段已有的全部交付相关标签；可按公开契约补充其他适用旧标签，不能只填audit而遗漏交付资料。保留未标注的全局知识并说明资料选择范围。唯一允许增加的配置路径是contextAction.config.stageTags.${auditId}；绝对不要新增或修改configuration.userConfig、auditMaterials、knowledgeRoots、知识子目录字段或其他用户设置。保留所有旧阶段映射、其他配置与provider身份不变。这是插件作者配置调整，不修改平台或提供器源码，也不凭猜测省略映射。将该新增映射与阶段/Skill在同一补丁提交。`
      : "配置逐项保持不变。"
  return `请继续修改同一草稿 ${before.draftId}，读取最新revision/sourceDigest。在现有末尾追加一个阶段${auditId}（独立资料审计），它消费当前${previous.id}的产物${artifact.id}，契约${artifact.contract}，路径${artifact.path}，真实读取后输出${auditId}.json（产物id=${auditId}，契约=${auditId}/v1）。输出对象必须包含summary非空字符串、findings非空字符串数组，使用JSON Schema检查required/minLength/minItems，成果要人工确认。其Skill强调根据实际输入说明发现和限制，禁止虚构通过。只用read_file读取实际产物、write_file写结果；JSON Schema由Host自动检查，不调用Python、Node、shell或任何命令自检。其他所有阶段、Skill、输入输出、检查、审批、依赖与资源逐项保留。${configuration}先读取所需声明/Skill与契约测试，新增阶段及其作者Skill/声明资源和必要测试样例合并一次project_patch，再重新编译、检查并准备新修订试用候选。不得改写原安装插件，不运行不安装，不代用户批准。`
}

export function assertMatrixOrigin(
  mode: CreatorProjectMatrixMode,
  candidate: MatrixCandidate,
  seed: MatrixSeed | undefined,
  trace: Array<{ id: string; request?: unknown; response?: unknown }>,
  failures: Array<{ id: string }>
) {
  const successful = trace
    .filter(
      (row) => row.response !== undefined && !failures.some((failure) => failure.id === row.id)
    )
    .map(
      (row) => row.request as { action?: string; pluginId?: string; template?: string } | undefined
    )
  if (seed) {
    assert(
      successful.some(
        (request) =>
          request?.action === "project_from_plugin" && request.pluginId === seed.installedPluginId
      ),
      "LIVE_MATRIX_NATIVE_DERIVATION_NOT_OBSERVED"
    )
    assert.deepEqual(
      candidate.source.modules,
      seed.source.modules,
      "LIVE_MATRIX_FIRST_DERIVATION_CHANGED_STAGES"
    )
    assert.deepEqual(candidate.skills, seed.skills, "LIVE_MATRIX_FIRST_DERIVATION_CHANGED_SKILLS")
    assert.deepEqual(candidate.source.configuration, seed.source.configuration)
    assert.deepEqual(candidate.source.resources, seed.source.resources)
    assertPreservedSettings(seed.source, candidate.source)
  } else {
    assert.equal(mode, "autobiz-from-zero")
    assert(
      successful.some(
        (request) => request?.action === "project_scaffold" && request.template === "native-modular"
      ),
      "LIVE_MATRIX_FROM_ZERO_SCAFFOLD_NOT_OBSERVED"
    )
    assert(
      !successful.some((request) => request?.action === "project_from_plugin"),
      "LIVE_MATRIX_FROM_ZERO_DERIVED_SOURCE"
    )
    assert.deepEqual(
      candidate.source.modules.map((module) => module.id),
      ["baseline", "solution", "delivery"]
    )
    assert(
      candidate.source.modules.every((module) =>
        module.checks.some((check) => check.kind === "json-schema")
      )
    )
  }
}

export function assertMatrixAssembly(
  before: MatrixCandidate,
  after: MatrixCandidate,
  mode?: CreatorProjectMatrixMode
) {
  assert.equal(after.draftId, before.draftId, "LIVE_MATRIX_DRAFT_CHANGED")
  assert(
    after.revision > before.revision && after.digest !== before.digest,
    "LIVE_MATRIX_NEW_REVISION_REQUIRED"
  )
  assert.equal(
    after.source.modules.length,
    before.source.modules.length + 1,
    "LIVE_MATRIX_STAGE_NOT_APPENDED"
  )
  assert.deepEqual(
    after.source.modules.slice(0, -1),
    before.source.modules,
    "LIVE_MATRIX_EXISTING_CONTRACT_CHANGED"
  )
  for (const module of before.source.modules)
    assert.equal(
      after.skills[module.id],
      before.skills[module.id],
      "LIVE_MATRIX_EXISTING_SKILL_CHANGED"
    )
  for (const path of before.source.resources)
    assert(after.source.resources.includes(path), "LIVE_MATRIX_RESOURCE_REMOVED")
  assert.deepEqual(after.source.configuration, before.source.configuration)
  const audit = after.source.modules.at(-1)!
  if (mode === "autobiz-derived") {
    const mapping = stageMapping(after.source.contextAction?.config?.stageTags, audit.id)
    const expected = structuredClone(before.source)
    assert(expected.contextAction?.config, "LIVE_MATRIX_ORIGINAL_CONTEXT_CONFIG_REQUIRED")
    const priorMapping = stageMapping(
      expected.contextAction.config.stageTags,
      before.source.modules[0].id
    )
    const deliveryTags = priorMapping[before.source.modules.at(-1)!.id]
    assert(
      deliveryTags?.every((tag) => mapping[audit.id].includes(tag)),
      "LIVE_MATRIX_AUDIT_DELIVERY_KNOWLEDGE_OMITTED"
    )
    expected.contextAction.config.stageTags = { ...priorMapping, [audit.id]: mapping[audit.id] }
    assertPreservedSettings(expected, after.source)
  } else assertPreservedSettings(before.source, after.source)
  assert.equal(
    audit.id,
    before.source.modules.some((module) => module.id === "audit") ? "audit-again" : "audit"
  )
  const output = before.source.modules.at(-1)!.outputs[0]
  assert(
    audit.inputs.some(
      (input) => input.artifactId === output.id && input.contract === output.contract
    ),
    "LIVE_MATRIX_INPUT_HANDOFF_MISSING"
  )
  assert(
    audit.checks.some(
      (check) =>
        check.kind === "json-schema" &&
        check.artifactId === audit.id &&
        hasRequiredAuditSchema(check.schema)
    ),
    "LIVE_MATRIX_AUDIT_CHECK_MISSING"
  )
  assert.equal(audit.resultApproval, "human")
}

function hasRequiredAuditSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const summary = properties?.summary
  const findings = properties?.findings
  const item = findings?.items as Record<string, unknown> | undefined
  return (
    schema.type === "object" &&
    Array.isArray(schema.required) &&
    ["summary", "findings"].every((key) => (schema.required as unknown[]).includes(key)) &&
    summary?.type === "string" &&
    Number(summary.minLength) >= 1 &&
    findings?.type === "array" &&
    Number(findings.minItems) >= 1 &&
    item?.type === "string" &&
    Number(item.minLength) >= 1
  )
}

function assertPreservedSettings(
  before: MatrixCandidate["source"],
  after: MatrixCandidate["source"]
) {
  for (const key of [
    "configuration",
    "context",
    "executionResources",
    "contextAction",
    "environment"
  ] as const)
    assert.deepEqual(after[key], before[key], `LIVE_MATRIX_SETTING_CHANGED:${key}`)
}

export const matrixRuntimeGoal =
  "本项目需求完整列在这段说明中；这是全新空工作目录，无需查找历史需求文件。除读取Host给出的当前Skill和本项目实际产物外，不搜索父目录、其他项目、安装目录或试用目录。直接根据本说明创作文档，不需要额外收集材料。为团队准备离线需求文档工具的研发需求：用户可创建、编辑、按标题查找需求；需求含标题、目标、范围、验收标准；本地保存后重启能读回。不联网、不部署、不实现代码，只整理需求和实施方案并清楚记录未实现能力与待确认项。所有阶段读取实际上游文件，审计给出具体发现和限制，不伪造通过；仅原生read_file读取与文件写入，不执行命令。JSON Schema由Host自动验收，无需且禁止Python、Node、shell或任何辅助命令自检；读文件确认实际内容后直接完成产物。"

export const matrixReportRuntimeGoal =
  "整理本验收提供的两条示例资料：记录A原文‘10月30日10:00会议开始，10:30结束’；记录B原文‘10月30日10:10收到通知，10:20回复’。资料仅证明各自时间，不证明通知与会议有因果关系。起草阶段写一段不超过200字的纯文本摘要，作为document.json的content字符串；复核与后续审计真实读取各自上游产物，简洁说明已确认的时间事实和因果证据不足，不能虚构通过。每份产物保持简短，不扩写软件需求、代码、实现方案或长篇文档。上述资料已完整给出，初始工作目录为空，无需搜索历史文件；除当前Skill与项目内实际产物，不搜索父目录、安装目录或其他项目。仅使用read_file和原生文件写入；禁止任何execute/Python/Node/shell命令。JSON Schema由Host自动检查，写完无需脚本或命令自检。"
