import { afterEach, expect, it, vi } from "vitest"
import { createModAuthoringRuntimeTools, modAuthoringRuntimePrompt } from "./mod-authoring-runtime"
import {
  setModDevelopmentService,
  ModDevelopmentService
} from "../mods/devtools/development-service"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { createAuthoringTemplate } from "../mods/devtools/authoring-templates"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"

vi.mock("../storage", () => ({ getPlugins: () => [] }))
const threadId = "portable-creator"
const workspace = "Z:/fresh-computer/ordinary-workspace"
let enabled = false
let creator = false
const scope = { threadId, workspace, projectMode: false }
function fixture() {
  enabled = true
  creator = true
  setModDevelopmentService({
    isEnabled: (id, root) => enabled && id === threadId && root === workspace,
    isCreatorMode: (id, root) => creator && enabled && id === threadId && root === workspace
  } as ModDevelopmentService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "creator-run" })
}
afterEach(() => {
  setModDevelopmentService(undefined)
  releaseLocalThreadRunLease(threadId, "desktop", "creator-run")
})

it("admits the real creator tool and its built-in guidance without personal skills or a source checkout", async () => {
  fixture()
  const tools = createModAuthoringRuntimeTools(scope)
  expect(tools.map((tool) => tool.name)).toEqual(["mod_authoring", "mod_composition", "mod_configuration", "mod_business"])
  expect(modAuthoringRuntimePrompt(tools)).not.toBeNull()
  expect(modAuthoringRuntimePrompt(tools)).toContain("native.project-stage-debug/stages@1.0.0")
  expect(modAuthoringRuntimePrompt(tools)).toContain("不得编造公共 create/start/approve 动作")
  const overview = JSON.parse(await tools[0].invoke({ action: "catalog" }))
  expect(overview).toMatchObject({ ok: true, result: { contract: "cmb-desktop-authoring-v2" } })
  expect(overview.result.package["mods/manifest.json"]).toMatchObject({ apiVersion: "cmb.mods/v2" })
  const types = JSON.parse(await tools[0].invoke({ action: "catalog", catalogSection: "types" }))
  expect(types).toMatchObject({ ok: true, result: { section: "types", cursor: 0 } })
  expect(types.result.content).toContain("declare namespace DevClawMods")
  expect(types.result.nextCursor).toBeGreaterThan(0)
  let declarations = types.result.content
  let cursor: number | null = types.result.nextCursor
  for (let page = 0; cursor !== null && page < 32; page++) {
    const result = JSON.parse(await tools[0].invoke({
      action: "catalog", catalogSection: "types", cursor
    }))
    expect(result).toMatchObject({ ok: true, result: { section: "types", cursor } })
    declarations += result.result.content
    cursor = result.result.nextCursor ?? null
  }
  expect(cursor).toBeNull()
  expect(declarations).toContain('declare module "devclaw-mods" { export = DevClawMods }')
  expect(declarations).toContain('declare module "claude-code" { export = DevClawMods }')
})

it("explains original-plugin modularization, native journey evidence and explicit independent delivery", () => {
  const prompt = modAuthoringRuntimePrompt([{ name: "mod_business" }, { name: "mod_authoring" }])
  for (const text of ["inspect_raw", "read_raw_asset", "request_modularization", "trial.journey",
    "制作→试用→验收→保存", "指定独立新名称与版本", "模型终止",
    "project_stage_debug_list", "project_stage_debug_prepare", "仅支持受控文件阶段",
    "创建和启动不能由模型代批", "不能删除这些行为来获得调试通过"])
    expect(prompt).toContain(text)
})

it("routes native source edits and dependency reuse before legacy modularization", () => {
  const prompt = modAuthoringRuntimePrompt([{ name: "mod_business" }, { name: "mod_authoring" }])!
  expect(prompt.indexOf("先按真实源码选择创作入口")).toBeLessThan(prompt.indexOf("inspect_raw(pluginId)"))
  for (const text of ["composition/source.json", "dependency_prepare", "project-dependencies",
    "project_from_plugin(pluginId,id,name?)", "不需要用户提供 devclaw.source-set.json", "新草稿没有旧权限",
    "sourcePatch", "add /modules/-", "test 目标模块的 id",
    "不能按插件名称", "不再 inspect_raw", "由项目使用入口填写",
    'project_scaffold(template:"native-modular")', "用户不需要选择内部模板", "当前 JSON Schema 子集要求对象根",
    "按依赖范围原子提交", "按完整模块分批", "不静默改格式",
    "独立检查 Mod 接入原项目门禁", "不信任模型自报 passed:true"])
    expect(prompt).toContain(text)
  for (const text of ["modules[].skill", "共享同一 Skill", "不擅自改插件模板",
    "不用旧对话里的源码覆盖手工修改", "保存草稿、编译通过、试用通过、保存插件是不同结果",
    "不预设研发阶段", "阶段增删、替换和重组使用现有组合作者声明",
    "由插件开发者在 Skill、资源、工作流或独立提供器中实现", "不为单个插件增加平台分支",
    "上下游 Skill 与 tests/project-contract.json", "合并一次 project_patch，再编译",
    "不顺手重写用户未要求修改的阶段", "不能把新身份冒充原草稿修改完成"])
    expect(prompt).toContain(text)
  expect(modAuthoringRuntimePrompt([{ name: "mod_business" }])).not.toContain("dependency_save")
})

it("routes independent cooperating Mods through public contracts and separate native package review", () => {
  const prompt = modAuthoringRuntimePrompt([{ name: "mod_authoring" }, { name: "mod_composition" }])!
  expect(prompt.indexOf("独立灵件不需要创建项目流程")).toBeLessThan(
    prompt.indexOf("先按真实源码选择创作入口"))
  for (const text of ['scaffold(kind:"capability"', 'catalog(query:"on.capability")',
    "$.platform.act", "只有一个开发试用槽", "确认安装后再制作和保存调用方", "保留已有选择",
      "无需写工作区临时文件", "不要让用户选择内部实现路线", "不要用动作名替换 ref.id",
      "完整传递该项 ref", "不能把空白结果当作成功"])
    expect(prompt).toContain(text)
  expect(modAuthoringRuntimePrompt([{ name: "mod_composition" }])).not.toContain("scaffold(kind")
})

it("does not inject creator tools or guidance into another scope, a subagent, a project runtime or a disabled chat", () => {
  fixture()
  for (const other of [
    { ...scope, threadId: "another-chat" },
    { ...scope, workspace: "Z:/another-workspace" },
    { ...scope, agentId: "worker" },
    { ...scope, projectMode: true },
    { ...scope, threadId: undefined }
  ]) {
    const tools = createModAuthoringRuntimeTools(other)
    expect(tools).toEqual([])
    expect(modAuthoringRuntimePrompt(tools)).toBeNull()
  }
  enabled = false
  expect(modAuthoringRuntimePrompt(createModAuthoringRuntimeTools(scope))).toBeNull()
  expect(modAuthoringRuntimePrompt([{ name: "read_file" }])).toBeNull()
})

it("fences creator tools in ordinary mode while the session remains enabled for applied Mods", async () => {
  fixture()
  const [tool] = createModAuthoringRuntimeTools(scope)
  creator = false
  expect(enabled).toBe(true)
  expect(JSON.parse(await tool.invoke({ action: "catalog" }))).toMatchObject({
    ok: false,
    error: "DEVELOPMENT_TURN_CHANGED"
  })
  expect(createModAuthoringRuntimeTools(scope)).toEqual([])
})

it("offers the real authoring tool after service restart and can update the original draft", async () => {
  fixture()
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  const execute = vi.fn()
  const createService = () => new ModDevelopmentService({
    drafts: new AuthoringDraftStore(settings), historySettings: settings,
    versionsRoot: "unused-mode-test", workerEntry: "unused-mode-test.js", changed: () => {},
    canRun: () => true,
    context: () => ({ scope: { threadId, workspace,
      incarnation: { token: "original-chat", legacyCreatedAt: 1 } }, assertCurrent: () => {} }),
    runtime: { developmentStatus: () => [],
      developmentRetention: () => ({ releasable: true, revisions: [] }),
      stageDevelopment: execute, approveDevelopment: execute, stopDevelopment: execute }
  })
  const original = createService()
  await original.setMode(threadId, workspace, "creator")
  const source = createAuthoringTemplate({ id: "restart", name: "Restart", instruction: "Demo", kind: "command" })
  original.save(threadId, { id: "restart", name: "Restart", expectedRevision: 0, files: source.files })
  setModDevelopmentService(createService())
  const tools = createModAuthoringRuntimeTools(scope)
  expect(tools.map(tool => tool.name)).toContain("mod_authoring")
  expect(JSON.parse(await tools[0].invoke({ action: "read", id: "restart" })))
    .toMatchObject({ ok: true, result: { revision: 1 } })
  expect(JSON.parse(await tools[0].invoke({ action: "save", id: "restart", name: "Restart",
    revision: 1, files: source.files })))
    .toMatchObject({ ok: true, result: { revision: 2 } })
  expect(execute).not.toHaveBeenCalled()
})

it("describes only the creator tools retained by the actual runtime allowlist", () => {
  const author = modAuthoringRuntimePrompt([{ name: "mod_authoring" }])
  expect(author).toContain("当前只提供 mod_authoring")
  expect(author).toContain('catalogSection="support"')
  expect(author).not.toContain("stage 提交")
  const composition = modAuthoringRuntimePrompt([{ name: "mod_composition" }])
  expect(composition).toContain("当前只提供 mod_composition")
  expect(composition).toContain("无法为缺失能力生成源码")
  expect(composition).not.toContain("catalogSection")
  expect(composition).toContain("不自动重放副作用")
  expect(composition).not.toContain("request_input")
  const configuration = modAuthoringRuntimePrompt([{ name: "mod_configuration" }])
  expect(configuration).toContain("request_input")
  expect(configuration).toContain("当前未提供源码制作和组合工具")
  const two = modAuthoringRuntimePrompt([{ name: "mod_authoring" }, { name: "mod_composition" }])
  expect(two).not.toContain("request_input")
  expect(two).toContain("本轮未提供插件用户配置工具")
})

it("guides business candidates through an uninstalled native trial before separate delivery", () => {
  const business = modAuthoringRuntimePrompt([{ name: "mod_business" }])
  expect(business).toContain("request_trial(previewId,goal)")
  expect(business).toContain("不先安装候选")
  expect(business).toContain("选择实际业务上下文")
  expect(business).toContain("创建新的隔离试用，不复用旧目录或批准")
  expect(business).toContain("停止和物理收尾结果分开核对")
  expect(business).toContain("阶段调试使用下述受控 Host 快照入口")
  expect(business).toContain("不删除业务 Hooks 或外部依赖来绕过支持范围")
  expect(business).toContain("host-linear-v1")
  expect(business).toContain("不能改成 Host 声明绕过原规则")
  expect(business).toContain("完整保留所声明资源")
  expect(business).not.toContain("后续通过原项目入口运行")
  expect(modAuthoringRuntimePrompt([{ name: "mod_authoring" }])).not.toContain(
    "request_trial(previewId,goal)"
  )
})
