import { afterEach, expect, it, vi } from "vitest"
import { createModAuthoringRuntimeTools, modAuthoringRuntimePrompt } from "./mod-authoring-runtime"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../mods/devtools/development-service"
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
  const overview = JSON.parse(await tools[0].invoke({ action: "catalog" }))
  expect(overview).toMatchObject({ ok: true, result: { contract: "cmb-desktop-authoring-v2" } })
  expect(overview.result.package["mods/manifest.json"]).toMatchObject({ apiVersion: "cmb.mods/v2" })
  const types = JSON.parse(await tools[0].invoke({ action: "catalog", catalogSection: "types" }))
  expect(types).toMatchObject({ ok: true, result: { section: "types", cursor: 0 } })
  expect(types.result.content).toContain('declare module "claude-code"')
  expect(types.result.nextCursor).toBeGreaterThan(0)
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
  expect(business).toContain("阶段回退调试仍不提供")
  expect(business).not.toContain("后续通过原项目入口运行")
  expect(modAuthoringRuntimePrompt([{ name: "mod_authoring" }])).not.toContain(
    "request_trial(previewId,goal)"
  )
})
