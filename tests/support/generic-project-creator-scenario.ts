import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { nativeCompositionSchema } from "../../src/main/plugins/native-composition"
import type { Page } from "playwright"

export const genericProjectCreatorScenario = {
  repairPrompt: "刚才实际试用和普通项目都发现交付阶段把 review.json.summary 改写成了自己的概述，未满足信息衔接要求。请仅修改 deliver 的作者 Skill，明确：必须读取当前项目的 review.json，report.json.reviewSummary 必须与读到的 summary 字符串逐字完全相等，标点和换行也不得改写；新的分析和总结仅写入 report 字段。保留 collect、trace-review、全部产物、输入输出契约、检查、权限及阶段顺序，不能手动修产物或放宽检查。使用当前草稿增量修改、编译和测试，准备新版本隔离试用候选；不要安装、执行或代我批准。",
  firstPrompt: "请从零制作一个三阶段资料整理项目插件，使用原生项目创作的 native-modular 模板，不使用已有业务插件。阶段固定为 collect（资料整理）、review（质量复核）、deliver（报告交付）。collect 产生 materials.json（对象含 sources 数组，每项必须含 id、title、text，至少两项）；review 读取 materials.json，输出 review.json（对象含 sourceIds 字符串数组、findings 非空字符串数组、summary 非空字符串）；deliver 必须读取当前 materials.json 和 review.json，输出 report.json（对象含 sourceIds 字符串数组、reviewSummary 非空字符串、report 非空字符串）。各输出都要有严格 JSON Schema 检查，数组至少一项，所有字段 required，禁止仅用 checked:true 充当校验。每步 Skill 都有合法 name 和 description，只读当前项目输入并经原生审批写产物，不调用命令或网络，不自建状态文件。每步在完成后由人确认结果。请自行检查、编译、测试并准备可确认的隔离试用候选；不要安装、执行或代我授权。",
  followupPrompt: "刚才中间的质量复核不够好，请把 review 阶段替换为 trace-review（来源追溯复核）：逐条核对资料的来源 ID，明确引用对应资料的原句，标出来源不足或相互矛盾之处。更新该阶段 Skill 和检查，review.json 保持 sourceIds、findings、summary 并新增 evidence 数组，每项必须含 sourceId、quote、assessment 三个非空字符串。保留 collect 和 deliver 两阶段及其原有输出契约，deliver 继续实际读取本次 review.json。请通过原生增量修改更新模块和步骤引用，重新检查、编译、测试并准备新的隔离试用候选。不要安装、执行或代我授权。",
  runtimeGoal: "整理本次提供的两条公开资料：source-a，标题‘办公楼供电记录’，原文‘办公楼在2026年10月27日09:00至09:20暂停供电，09:20恢复。’；source-b，标题‘设备值守记录’，原文‘2026年10月27日09:10设备无法启动，09:25完成复位。’。收集时保留这两条原文和 ID。来源追溯复核需逐条引用原文，说明停电与设备复位时间并不能独自证明设备故障因果关系。交付报告必须读取本次生成的 materials.json 与 review.json，引用实际 sourceIds 和 reviewSummary。所有文件仅放当前项目目录，经原生审批写入，禁止执行命令、联网或修改平台状态。"
}

export function assertGenericProjectRepair(before: GenericProjectCandidate,
  after: GenericProjectCandidate) {
  assert.equal(after.draftId, before.draftId)
  assert(after.revision > before.revision)
  assert.notEqual(after.digest, before.digest)
  assert.deepEqual(after.source, before.source, "GENERIC_PROJECT_REPAIR_CONTRACT_CHANGED")
  for (const id of ["collect", "trace-review"])
    assert.equal(after.skills[id], before.skills[id], "GENERIC_PROJECT_REPAIR_OTHER_SKILL_CHANGED")
  assert.notEqual(after.skills.deliver, before.skills.deliver,
    "GENERIC_PROJECT_REPAIR_DELIVER_UNCHANGED")
  return { before: { revision: before.revision, digest: before.digest },
    after: { revision: after.revision, digest: after.digest },
    deliverSkillSha256: createHash("sha256").update(after.skills.deliver).digest("hex") }
}

export interface GenericProjectCandidate {
  digest: string
  revision: number
  draftId: string
  directory: string
  source: ReturnType<typeof nativeCompositionSchema.parse>
  skills: Record<string, string>
}

/** Read only the exact immutable host-owned revision; never write or supply candidate source. */
export function readGenericProjectCandidate(
  isolated: string,
  request: { draftId: string; revision: number; digest: string }
): GenericProjectCandidate {
  assert(/^[a-zA-Z0-9][\w.-]{0,63}$/.test(request.draftId))
  assert(Number.isSafeInteger(request.revision) && request.revision > 0)
  const root = realpathSync(join(isolated, "electron/mods/project-authoring"))
  const matches = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(root, entry.name), { withFileTypes: true })
      .filter((draft) => draft.isDirectory() &&
        draft.name.startsWith(`${request.draftId}-r${request.revision}-`))
      .map((draft) => join(root, entry.name, draft.name)))
  assert.equal(matches.length, 1, "GENERIC_PROJECT_REVISION_AMBIGUOUS")
  const directory = realpathSync(matches[0])
  const read = (path: string) => {
    const file = realpathSync(resolve(directory, path))
    const within = relative(directory, file)
    assert(within && !isAbsolute(within) && within !== ".." && !within.startsWith("..\\") &&
      !within.startsWith("../"), "GENERIC_PROJECT_SOURCE_OUTSIDE_CANDIDATE")
    return readFileSync(file, "utf8")
  }
  const source = nativeCompositionSchema.parse(JSON.parse(read("composition/source.json")))
  const skills = Object.fromEntries(source.modules.map((module) => [module.id, read(module.skill)]))
  const all = [JSON.stringify(source), ...Object.values(skills), ...source.resources.map(read)]
  assert(!all.some((text) => /autobiz|board_core|board_config/i.test(text)),
    "GENERIC_PROJECT_BUSINESS_DEPENDENCY_FORBIDDEN")
  return { draftId: request.draftId, revision: request.revision,
    digest: request.digest, directory, source, skills }
}

export function assertGenericProjectReplacement(
  before: GenericProjectCandidate,
  after: GenericProjectCandidate
) {
  assert.equal(after.draftId, before.draftId, "GENERIC_PROJECT_DRAFT_REPLACED")
  assert(after.revision > before.revision, "GENERIC_PROJECT_REVISION_NOT_ADVANCED")
  assert.notEqual(after.digest, before.digest, "GENERIC_PROJECT_OLD_CANDIDATE_REUSED")
  assert.deepEqual(before.source.modules.map((module) => module.id), ["collect", "review", "deliver"])
  assert.deepEqual(after.source.modules.map((module) => module.id), ["collect", "trace-review", "deliver"])
  for (const id of ["collect", "deliver"]) {
    assert.deepEqual(after.source.modules.find((module) => module.id === id),
      before.source.modules.find((module) => module.id === id), "GENERIC_PROJECT_OTHER_MODULE_CHANGED")
    assert.equal(after.skills[id], before.skills[id], "GENERIC_PROJECT_OTHER_SKILL_CHANGED")
  }
  assert.notEqual(after.skills["trace-review"], before.skills.review,
    "GENERIC_PROJECT_REPLACEMENT_SKILL_UNCHANGED")
  const revised = after.source.modules[1]
  assert.deepEqual(revised.outputs, before.source.modules[1].outputs,
    "GENERIC_PROJECT_OUTPUT_HANDOFF_CHANGED")
  assert.deepEqual(revised.inputs, before.source.modules[1].inputs,
    "GENERIC_PROJECT_INPUT_HANDOFF_CHANGED")
  assert(revised.checks.some((check) => check.kind === "json-schema" &&
    JSON.stringify(check.schema).includes('"evidence"')), "GENERIC_PROJECT_EVIDENCE_CHECK_MISSING")
  return {
    before: { revision: before.revision, digest: before.digest },
    after: { revision: after.revision, digest: after.digest },
    stages: after.source.modules.map((module) => module.id),
    replacementSkillSha256: createHash("sha256").update(after.skills["trace-review"]).digest("hex")
  }
}

export function assertGenericProjectArtifacts(materials: {
  sources: Array<{ id: string; title: string; text: string }>
}, review: {
  sourceIds: string[]; findings: string[]; summary: string
  evidence: Array<{ sourceId: string; quote: string; assessment: string }>
}, report: { sourceIds: string[]; reviewSummary: string; report: string }) {
  const ids = materials.sources.map((source) => source.id).sort()
  assert.deepEqual(ids, ["source-a", "source-b"], "GENERIC_PROJECT_SOURCES_LOST")
  assert.deepEqual([...review.sourceIds].sort(), ids, "GENERIC_PROJECT_REVIEW_SOURCES_CHANGED")
  assert.deepEqual([...report.sourceIds].sort(), ids, "GENERIC_PROJECT_REPORT_SOURCES_CHANGED")
  assert.equal(report.reviewSummary, review.summary, "GENERIC_PROJECT_REPORT_OLD_REVIEW")
  assert(review.findings.length > 0 && review.summary.trim() && report.report.trim())
  assert.deepEqual([...new Set(review.evidence.map((item) => item.sourceId))].sort(), ids,
    "GENERIC_PROJECT_EVIDENCE_SOURCES_INCOMPLETE")
  for (const source of materials.sources)
    assert(review.evidence.some((item) => item.sourceId === source.id && item.quote.trim() &&
      source.text.includes(item.quote)), "GENERIC_PROJECT_SOURCE_CONTENT_NOT_QUOTED")
  for (const evidence of review.evidence) {
    const source = materials.sources.find((item) => item.id === evidence.sourceId)
    assert(source && evidence.quote.trim() && evidence.assessment.trim() &&
      (source.text.includes(evidence.quote) || source.title.includes(evidence.quote)),
    "GENERIC_PROJECT_QUOTATION_NOT_FROM_CURRENT_SOURCE")
  }
  return { sourceIds: ids, citations: review.evidence.length,
    reviewSha256: createHash("sha256").update(JSON.stringify(review)).digest("hex") }
}

/** Extra business audit observes actual persisted output and successful native read messages. */
export async function auditGenericProjectRuntime(page: Page, projectId: string) {
  const view = await page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
  assert.equal(view.project.status, "completed")
  assert.deepEqual(view.project.manifest.stages.map((stage) => stage.id),
    ["collect", "trace-review", "deliver"])
  const root = realpathSync(view.project.workspace)
  const read = (file: string) => {
    const target = realpathSync(join(root, file))
    assert.equal(relative(root, target), file, "GENERIC_PROJECT_ARTIFACT_PATH_CHANGED")
    return JSON.parse(readFileSync(target, "utf8"))
  }
  const artifacts = assertGenericProjectArtifacts(read("materials.json"), read("review.json"),
    read("report.json"))
  const reads: Array<{ stage: string; file: string }> = []
  for (const [stage, files] of [["trace-review", ["materials.json"]],
    ["deliver", ["materials.json", "review.json"]]] as const) {
    const operation = view.operations.find((entry) => entry.stageId === stage &&
      entry.status === "transitioned")
    assert(operation?.execution?.threadId, "GENERIC_PROJECT_STAGE_EXECUTION_MISSING")
    const messages = await page.evaluate((id) => window.api.threads.getMessages(id),
      operation.execution.threadId)
    for (const file of files) {
      const matches = messages.flatMap((message) => message.tool_calls ?? [])
        .filter((call) => call.name === "read_file" &&
          (call.args as { file_path?: string })?.file_path === join(root, file))
      assert(matches.some((call) => messages.some((message) =>
        message.role === "tool" && message.tool_call_id === call.id &&
        typeof message.content === "string" && message.content.includes("source-a") &&
        message.content.includes("source-b"))), "GENERIC_PROJECT_CURRENT_INPUT_NOT_READ")
      reads.push({ stage, file })
    }
  }
  return { projectId, ...artifacts, nativeSuccessfulReads: reads }
}
