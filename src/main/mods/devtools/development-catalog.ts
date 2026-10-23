import { describeFunctionDisplayRouting } from "../v2/display-routing"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "../../../shared/mods/v2/compatibility-catalog"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import {
  DEVELOPMENT_CAPABILITIES,
  DEVELOPMENT_REAL_CAPABILITIES,
  DEVELOPMENT_EVENT_CAPABILITIES
} from "../v2/development-session"
import { functionAuthoringDeclarations } from "./authoring-declarations"
import { CREATOR_S1_SUPPORT } from "./creator-support"
import { AUTHORING_TEMPLATE_KINDS } from "../../../shared/mods/authoring"

export const DEVELOPMENT_COUNTER_EXAMPLE = `import type { Register } from "devclaw-mods"
export const register: Register = (on) => {
  let calls = 0
  on("tool.call", async ($, event, next) => {
    calls += 1
    $.ui.invalidate("ui.render")
    return next(event)
  })
  on("ui.render", { component: "AbovePrompt" }, ($, event) => {
    const { Text } = $.ui.resolve(event)
    return Text({ children: "工具调用：" + calls })
  })
}
`

export const DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE = `import type { Register } from "devclaw-mods"
export const register: Register = (on) => {
  on("classic.PreSkillUse", { skill_name: "review" }, ($, event, next) => {
    $.ui.log("准备使用技能：" + event.skill_name)
    return next(event)
  })
  on("classic.PostSkillUse", { skill_name: "review" }, ($, event, next) => {
    $.ui.log("技能完成检查：" + event.skill_name)
    return next(event)
  })
}
`

/** The same declarations go to the model and the actual isolated type checker. */
export function developmentCatalog() {
  return {
    contract: "cmb-desktop-authoring-v2",
    support: CREATOR_S1_SUPPORT,
    hostDisplay: describeFunctionDisplayRouting(),
    authoringTemplates: [...AUTHORING_TEMPLATE_KINDS],
    types: functionAuthoringDeclarations("result-v1"),
    events: FUNCTION_COMPATIBILITY_EVENT_NAMES.map((name) => ({
      name,
      ...getFunctionEventSupport(name)
    })),
    sdkMethods: [...FUNCTION_SDK_METHODS],
    trialCapabilities: [...DEVELOPMENT_CAPABILITIES],
    authorizedTrialCapabilities: DEVELOPMENT_REAL_CAPABILITIES.filter(
      (value) => !value.startsWith("event:")
    ),
    trialEventEnvelope: [...DEVELOPMENT_EVENT_CAPABILITIES],
    trialEventConsent:
      "这组固定事件范围随 SDK 一起由用户确认；加载后逐项校验实际注册，拒绝通配符和范围外事件。",
    authorizedTrialEventConsent:
      "真实试用另按源码中的 literal 事件逐项申请已接通的事件（见 events 目录），不授予完整目录、动态或通配范围。",
    examples: {
      toolCounter: DEVELOPMENT_COUNTER_EXAMPLE,
      skillLifecycle: DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE
    },
    deliveryGuidance: [
      CREATOR_S1_SUPPORT.authoringConstraints.usageMetrics,
      "技能生命周期用 classic.PreSkillUse/PostSkillUse（本应用扩展），matcher 用 skill_name；从 events/types 读取宿主固定身份与结果。Pre block 阻止激活，Post block 请求修订、preventContinuation 才终止。普通 Mod 不能吞掉必需业务 Hooks，原脚本不自动迁移；真实试用须新确认。",
      "状态扩展用 scaffold(kind:state-extension) 生成真实 Function Mod、迁移计划与未执行测试入口，再 save/check/request_trial。默认只 hold；未确认原图、绑定原 writer 并实际验证前必须显示‘可执行决策骨架，未迁移状态’。inspect_raw.stateControl 保留原状态工具、Hooks、配置及知识来源；已有 Host authority 无需强制迁移。",
      "创造者模式按自然语言需求选择复用、组合或编写；不要让用户先配置添加功能、常用搭配或执行步骤。连续修改先 list/read 更新当前开发组件，保留已有功能。",
      "使用闭合的 SDK 路径和 literal 事件；SDK 对象或方法不能传给辅助函数、动态索引或外部代码。纯辅助函数只接收普通数据；SDK 调用直接写在有明确 $ 参数的事件处理器中，否则检查会报告 MODS_SDK_UNVERIFIED，保留草稿后按诊断修复。",
      "组合用 mod_composition list 搜索摘要，details 按需读取配置 schema；stage 同轮累积并深合并配置，可引用真实模型、技能、MCP 和已保存步骤。save/apply_saved 保存套用命名组合，undo/cancel 撤销选择或取消排队。提交后结束本轮，再核对真实回执。",
      "用户参数在灵件清单 userConfig 声明，由原生参数表单绑定；缺必填项不批准执行。升级重命名或删除字段可在同份声明加入 userConfigSchema:{version:1,migrations:[{fromVersion:0,toVersion:1,changes:[{kind:'rename',from:'oldLabel',to:'label'}]}]}，并声明 cmbCompatibility:{modelProtocol:'result-v1',userConfigMigrations:'v1'}；后续版本逐一连续迁移，删除用 {kind:'remove',key:'字段名'}，不运行迁移脚本。迁移须原生确认，失败保留旧配置；导出不携带本机保存值、凭据或授权。",
      "公共快捷指令应采用灵件专属名称，避免与已启用灵件重名。出现 MODS_COMMAND_CONFLICT 时修改本草稿的指令名称及使用说明，再重新请求试用；不要替用户关闭其他插件来绕开冲突。",
      "后续询问当前试用状态时先调用 list，依据 trials 最新 phase/error 回答。request_trial 的 needs-approval 只是当时快照；后续 failed 表示加载失败，不是仍待授权。不要循环轮询或自动重试；读取失败原因、修复后再请求用户试用。",
      "先实现最小完整效果，优先 submit 合并保存、检查和请求试用；诊断失败再修复。结束本轮，不循环等待授权。当前聊天恢复用 resume_trial，明确跨聊天复用才 request_reuse，由用户在一张原生卡确认后宿主完成原安装事务。",
      "交付说明只列如何触发、应看到什么、必要设置；不要把源码摘要、内部状态或接口清单当使用步骤。",
      "明确当前应用的聊天与实际生效状态；切回普通模式保留已生效功能，停止试用另行处理。",
      "明确触发条件，例如 edit_file 完成后触发，不等于发送普通消息后触发。注册的命令写明参数示例。",
      "需要文件、网络、模型、进程或业务能力时，可直接请求授权后的真实试用，无需先正式安装。确认绑定当前源码与目标，实际动作仍走宿主原权限；静态检查、隔离预览或批准都不是实际结果。",
      "session.start 只登记指令和无副作用界面。真实文件、网络、模型及长期任务放到生效后用户触发的动作中；候选阶段禁止外部效果，失败时旧可用版保留。",
      "真实动作后用读取或 platform.read/status 核对结果，不凭模型说明标完成。未知结果先读取核对，不自动重放；新权限更新须再次确认。",
      "工作流进度通过 platform.list 发现当前宿主的 native.workflow/runs@1.0.0，再用 platform.read/subscribe/poll/unsubscribe 读取和观察原运行器；target 仅为 {kind:'current'}。状态不含提示词或完整日志，截断时用 inspect 动作的页偏移补读。工作树 agentIndex 为空表示原记录没有明确关联，不能按名称猜测。cancel 动作仍需原生确认并等待实际清理，不能把请求成功当作已清理。",
      "result-v1 的 tool.call 返回包含 result 的对象；保留 next 返回的 ref 会保留原工具结果。追加说明用 context 字符串数组；通知须 await $.ui.toast(text)。",
      "制作轮中断后可在新的制作轮对未修改的草稿重新 request_trial；仍须等待新轮完成，不能报告已经生效。"
    ],
    package: {
      "plugin.json": {
        name: "my-component",
        version: "0.1.0",
        description: "组件说明",
        mods: "mods/manifest.json"
      },
      "mods/manifest.json": {
        apiVersion: "cmb.mods/v2",
        id: "my-component",
        entry: "main.ts"
      },
      "mods/main.ts": DEVELOPMENT_COUNTER_EXAMPLE
    },
    limitations: [
      "当前构建的桌面子集；事件支持不代表全部作者重载都已声明。",
      "旧本地试用接受 trialCapabilities；超出该范围且属于 authorizedTrialCapabilities 时，需用户批准精确源码摘要和当前目标后真实验证。其他方法不可用，不得绕过宿主授权。",
      "关闭制作面板不会停止已生效任务；停止试用、撤权、删除和退出应用会清理所属资源。普通定时器退出后不运行，重启不恢复试用授权或自动重放动作。",
      "轮次结束并且真实任务结算后才应用；request_trial 返回排队状态，不是生效证明。",
      "模块局部变量在重新加载后重置；状态需显式使用宿主接口。",
      "不得从其他会话或全局插件目录直接覆盖源码。"
    ]
  }
}

/** Targeted discovery stays within the normal tool-result budget instead of dumping the SDK. */
export function developmentCatalogPage(
  section: "overview" | "types" | "events" | "sdk" | "support" = "overview",
  cursor = 0
) {
  const catalog = developmentCatalog()
  if (section === "support") {
    const capabilities = catalog.support.conditionalCapabilities
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > capabilities.length)
      throw Error("DEVELOPMENT_CATALOG_CURSOR")
    const size = 2
    return {
      contract: catalog.contract,
      section,
      cursor,
      content: {
        ...catalog.support,
        conditionalCapabilities: capabilities.slice(cursor, cursor + size)
      },
      ...(cursor + size < capabilities.length ? { nextCursor: cursor + size } : {})
    }
  }
  if (section === "overview")
    return {
      contract: catalog.contract,
      hostDisplay: catalog.hostDisplay,
      supportProfile: {
        id: catalog.support.id,
        section: "support",
        scope: catalog.support.scope,
        conditionalCapabilities: catalog.support.conditionalCapabilities.map(
          ({ id, availability, nextDiscovery }) => ({ id, availability, nextDiscovery })
        )
      },
      trialCapabilities: catalog.trialCapabilities,
      authorizedTrialCapabilities: catalog.authorizedTrialCapabilities,
      trialEventEnvelope: catalog.trialEventEnvelope,
      trialEventConsent: catalog.trialEventConsent,
      authorizedTrialEventConsent: catalog.authorizedTrialEventConsent,
      package: catalog.package,
      examples: { skillLifecycle: catalog.examples.skillLifecycle },
      authoringTemplates: catalog.authoringTemplates,
      deliveryGuidance: catalog.deliveryGuidance,
      limitations: catalog.limitations,
      discovery:
        "用 catalogSection=support/types/events/sdk 分页读取精确声明；nextCursor 存在时继续，缺省返回入门范围。"
    }
  const value =
    section === "types" ? catalog.types : section === "events" ? catalog.events : catalog.sdkMethods
  const size = section === "types" ? 6000 : section === "events" ? 12 : 60
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > value.length)
    throw Error("DEVELOPMENT_CATALOG_CURSOR")
  return {
    contract: catalog.contract,
    section,
    cursor,
    content: value.slice(cursor, cursor + size),
    ...(cursor + size < value.length ? { nextCursor: cursor + size } : {})
  }
}
