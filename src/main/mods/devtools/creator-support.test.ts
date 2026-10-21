import { describe, expect, it } from "vitest"
import {
  CREATOR_CONDITIONAL_CAPABILITIES,
  CREATOR_S1_SUPPORT,
  type CreatorConditionalCapability
} from "./creator-support"

describe("creator support scopes", () => {
  it("separates the function S1 promise from conditional Host project capabilities", () => {
    expect(CREATOR_S1_SUPPORT.scope.id).toBe("function-authoring-s1")
    expect(CREATOR_S1_SUPPORT.conditionalCapabilities).toBe(CREATOR_CONDITIONAL_CAPABILITIES)
    expect(CREATOR_S1_SUPPORT.unsupported).not.toContain("完整业务插件导出或中间阶段重跑")
    expect(CREATOR_S1_SUPPORT.unsupported.join(" ")).toContain("条件能力见 conditionalCapabilities")
    expect(
      CREATOR_CONDITIONAL_CAPABILITIES.map((value) => [value.scope, value.availability])
    ).toEqual([
      ["host-project", "conditional"],
      ["host-project", "conditional"]
    ])
  })

  it("discovers actual authoring tool operations and keeps branch creation in native UI", () => {
    const [delivery, debug] = CREATOR_CONDITIONAL_CAPABILITIES
    expect(
      delivery.operations.map(
        (value) => value.kind === "tool" && [value.tool, value.arguments.action]
      )
    ).toEqual([
      ["mod_authoring", "project_read"],
      ["mod_authoring", "project_doctor"],
      ["mod_authoring", "project_test"],
      ["mod_authoring", "project_pack"]
    ])
    expect(debug.operations).toEqual([
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_stage_debug_list" } },
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_stage_debug_prepare" } },
      {
        kind: "native",
        api: "window.api.harnessBoard.localProjects.preview.stageDebug",
        operation: "create",
        entry: expect.stringContaining("确认创建分支")
      }
    ])
    expect(delivery.nextDiscovery).toMatchObject({ arguments: { action: "project_list" } })
    expect(debug.nextDiscovery).toMatchObject({ arguments: { action: "project_stage_debug_list" } })
    expect(JSON.stringify(debug.operations)).not.toContain("project_stage_debug_create")
  })

  it("supplies machine-readable prerequisites, blockers, owners and next discovery", () => {
    for (const capability of CREATOR_CONDITIONAL_CAPABILITIES as readonly CreatorConditionalCapability[]) {
      expect(new Set(capability.preconditions.map((item) => item.id)).size).toBe(
        capability.preconditions.length
      )
      expect(capability.preconditions.length).toBeGreaterThan(0)
      for (const condition of capability.preconditions)
        expect(condition.description.length).toBeGreaterThan(0)
      for (const blocker of capability.blockers) {
        expect(blocker.signals.length).toBeGreaterThan(0)
        expect(["creator-author", "user", "host-adapter-maintainer"]).toContain(blocker.owner)
        expect(blocker.reason.length).toBeGreaterThan(0)
        expect(["tool", "native"]).toContain(blocker.next.kind)
      }
    }
    const debug: CreatorConditionalCapability = CREATOR_CONDITIONAL_CAPABILITIES[1]
    expect(debug.preconditions.map((value) => value.id)).toEqual([
      "native-baseline",
      "source-settled",
      "compatible-candidate",
      "fresh-native-consent"
    ])
    expect(
      debug.blockers.find((value) => value.signals.includes("PROJECT_STAGE_DEBUG_SOURCE_UNSETTLED"))
    ).toMatchObject({ owner: "user", reason: expect.stringContaining("不得自动重放") })
    const adapter = debug.blockers.find((value) => value.owner === "host-adapter-maintainer")!
    expect(adapter.signals).toEqual(
      expect.arrayContaining([
        "PROJECT_STAGE_DEBUG_CONFIGURATION_UNSUPPORTED",
        "PROJECT_STAGE_DEBUG_CONTEXT_UNSUPPORTED",
        "PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED",
        "PROJECT_STAGE_DEBUG_CAPABILITY_FLOW_UNSUPPORTED"
      ])
    )
    expect(adapter.reason).toContain("不删除功能绕过检查")
  })

  it("distinguishes context occupancy from cumulative usage and never invents measurements", () => {
    const guidance = CREATOR_S1_SUPPORT.authoringConstraints.usageMetrics
    expect(guidance).toContain("上下文占用与累计输入/输出用量是不同指标")
    expect(guidance).toContain("SDK catalog/types 发现真实字段及来源")
    expect(guidance).toContain("暂无统计")
    expect(guidance).toContain("不得默认 0 当作已测量")
    expect(guidance).toContain("不得据此虚构 session API")
  })

  it("keeps export, debug and complex AutoBiz recovery claims bounded", () => {
    const [delivery, debug] = CREATOR_CONDITIONAL_CAPABILITIES
    expect(delivery.guarantees.join(" ")).toContain("不会安装、授权或执行")
    expect(delivery.guarantees.join(" ")).toContain("不代表真实业务验收通过")
    expect(debug.guarantees.join(" ")).toContain("不恢复数据库、网络、发布或 Git 状态")
    expect(debug.guarantees.join(" ")).toContain(
      "复杂 AutoBiz 的配置、知识、Hooks 与 workflow 恢复尚未支持"
    )
  })
})
