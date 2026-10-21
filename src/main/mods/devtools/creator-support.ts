import { CREATOR_REQUEST_LIMITS } from "./creator-request-budget"

export type CreatorCapabilityDiscovery =
  | { kind: "tool"; tool: "mod_authoring"; arguments: Readonly<Record<string, string>> }
  | { kind: "native"; api: string; operation: string; entry: string }

export interface CreatorConditionalCapability {
  id: string
  scope: "host-project"
  availability: "conditional"
  description: string
  operations: readonly CreatorCapabilityDiscovery[]
  preconditions: readonly { id: string; description: string }[]
  blockers: readonly {
    signals: readonly string[]
    owner: "creator-author" | "user" | "host-adapter-maintainer"
    reason: string
    next: CreatorCapabilityDiscovery
  }[]
  nextDiscovery: CreatorCapabilityDiscovery
  guarantees: readonly string[]
}

const projectList = {
  kind: "tool",
  tool: "mod_authoring",
  arguments: { action: "project_list" }
} as const
const debugList = {
  kind: "tool",
  tool: "mod_authoring",
  arguments: { action: "project_stage_debug_list" }
} as const
const debugNative = {
  kind: "native",
  api: "window.api.harnessBoard.localProjects.preview.stageDebug",
  operation: "create",
  entry: "插件创作工作区 → 阶段调试 → 核对并确认创建分支"
} as const

/** One discovery source for the S1 profile and its separately gated project capabilities. */
export const CREATOR_CONDITIONAL_CAPABILITIES = [
  {
    id: "host-project-package-export",
    scope: "host-project",
    availability: "conditional",
    description:
      "标准 Host 项目包可以检查并导出 ZIP；不属于 function-authoring-s1 的自动创作保证。",
    operations: [
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_read" } },
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_doctor" } },
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_test" } },
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_pack" } }
    ],
    preconditions: [
      {
        id: "creator-scope",
        description: "当前本地聊天已关联项目并开启创造者模式；制作轮与项目作用域仍有效。"
      },
      {
        id: "exact-source",
        description:
          "先 project_list/project_read 取得实际 id、最新 revision 与完整标准 Host 项目源码；read 传 id，检查和导出传 id、revision。"
      },
      {
        id: "package-valid",
        description:
          "按 project_doctor/project_test 的真实诊断修复；含公开动作锁时须从 project_actions 核对当前已安装、授权的身份与 schema。"
      }
    ],
    blockers: [
      {
        signals: ["PROJECT_DRAFT_MISSING", "PROJECT_DRAFT_REVISION_CHANGED"],
        owner: "creator-author",
        reason: "草稿不存在或版本已变化，重新读取实际候选，不能猜测 revision。",
        next: projectList
      },
      {
        signals: [
          "valid=false",
          "doctor.valid=false",
          "PROJECT_PACK_DOCTOR_FAILED",
          "PROJECT_PACK_CONTRACT_FAILED"
        ],
        owner: "creator-author",
        reason: "包或契约检查失败；保留源码并按诊断修复，失败包不能宣称可安装。",
        next: { kind: "tool", tool: "mod_authoring", arguments: { action: "project_doctor" } }
      }
    ],
    nextDiscovery: projectList,
    guarantees: [
      "project_pack 只导出当前候选 ZIP，不会安装、授权或执行；安装仍走原用户确认入口。",
      "导出或静态检查通过不代表真实业务验收通过，也不保证任意 legacy/AutoBiz 插件已适配。"
    ]
  },
  {
    id: "confined-file-stage-debug",
    scope: "host-project",
    availability: "conditional",
    description:
      "受控文件阶段可从实际阶段进入快照准备独立 stage/downstream 调试分支；不是复杂业务恢复保证。",
    operations: [
      debugList,
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_stage_debug_prepare" } },
      debugNative
    ],
    preconditions: [
      {
        id: "native-baseline",
        description:
          "同一创造者/项目作用域的真实试用已产生阶段进入快照；使用 list 返回的 snapshotId。"
      },
      {
        id: "source-settled",
        description:
          "原执行已结算且工作区空闲；prepared/started/cancel_requested/succeeded/unknown 等未结算操作会阻断。"
      },
      {
        id: "compatible-candidate",
        description:
          "传实际 id、revision、snapshotId、debugMode（stage/downstream）；只改目标及后续未共享 Skill 正文，原检查契约与输入身份保持一致。"
      },
      {
        id: "fresh-native-consent",
        description:
          "prepare 只准备；用户核对精确候选摘要后在原生卡 create，再重新批准并从原项目入口明确运行。"
      }
    ],
    blockers: [
      {
        signals: ["snapshots.length=0"],
        owner: "user",
        reason: "尚无可用阶段进入快照；先在原生工作区明确批准并进行真实试用。",
        next: debugList
      },
      {
        signals: ["PROJECT_STAGE_DEBUG_SOURCE_UNSETTLED"],
        owner: "user",
        reason: "先在原运行入口停止并核对未结算执行、释放占用；未知副作用不得自动重放。",
        next: debugList
      },
      {
        signals: [
          "PROJECT_STAGE_DEBUG_CANDIDATE_CHANGED",
          "PROJECT_STAGE_DEBUG_SOURCE_CHANGED",
          "PROJECT_STAGE_DEBUG_INPUTS_CHANGED"
        ],
        owner: "creator-author",
        reason: "候选、基线或输入已变化，重新核对实际来源和较早起点。",
        next: projectList
      },
      {
        signals: [
          "PROJECT_STAGE_DEBUG_CONFIGURATION_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_CONTEXT_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_HOOKS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_MCP_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_ACTIONS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_SHARED_MODS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_CAPABILITY_FLOW_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_VERIFIED_ARTIFACTS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_SKILL_HOOKS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_CAPABILITY_DEPENDENCY_UNSUPPORTED"
        ],
        owner: "host-adapter-maintainer",
        reason:
          "配置、共享知识/上下文、Hooks、MCP、外部动作或自定义 workflow 尚无此阶段隔离适配；保留完整原插件，不删除功能绕过检查。",
        next: debugList
      },
      {
        signals: [
          "PROJECT_STAGE_DEBUG_NATIVE_CONFIRMATION_REQUIRED",
          "PROJECT_STAGE_DEBUG_RECONFIRMATION_REQUIRED"
        ],
        owner: "user",
        reason: "分支创建与执行需要新的原生确认，模型不能代替批准；历史记录不恢复授权。",
        next: debugNative
      }
    ],
    nextDiscovery: debugList,
    guarantees: [
      "仅恢复受控工作区文件，不恢复数据库、网络、发布或 Git 状态。",
      "复杂 AutoBiz 的配置、知识、Hooks 与 workflow 恢复尚未支持；单阶段通过也不等于整轮验收。"
    ]
  }
] as const satisfies readonly CreatorConditionalCapability[]

/** A bounded first-release promise, not an authorization envelope or a replacement SDK. */
export const CREATOR_S1_SUPPORT = Object.freeze({
  id: "creator-s1-2026-10-16",
  target: "当前已关联本地项目的普通聊天",
  scope: {
    id: "function-authoring-s1",
    description:
      "首批函数 Mod 自动创作保证；标准 Host 项目导出与受控文件阶段调试属于另行核对前置条件的高级能力。",
    discovery: {
      kind: "tool",
      tool: "mod_authoring",
      arguments: { action: "catalog", catalogSection: "support" }
    }
  },
  conditionalCapabilities: CREATOR_CONDITIONAL_CAPABILITIES,
  authoringConstraints: {
    usageMetrics:
      "Token 上下文占用与累计输入/输出用量是不同指标。必须先用当前构建的 SDK catalog/types 发现真实字段及来源，再按各自语义取数；字段未提供或未统计时显示“暂无统计”，不得默认 0 当作已测量，也不得据此虚构 session API。"
  },
  sites: ["AbovePrompt", "PromptHint", "InfoNotice", "TurnDuration"],
  events: [
    "session.start",
    "ui.render",
    "tool.call",
    "command.run",
    "turn.complete",
    "prompt.compose"
  ],
  localMethods: [
    "ui.open",
    "ui.close",
    "ui.resolve",
    "ui.invalidate",
    "ui.log",
    "ui.status",
    "ui.toast",
    "store.get",
    "store.set",
    "store.keys",
    "store.delete",
    "command.register",
    "clock.now"
  ],
  authorizedMethods: [
    "http.fetch",
    "fs.read",
    "fs.list",
    "fs.exists",
    "fs.stat",
    "model.complete",
    "tool.call",
    "tool.list",
    "tool.check"
  ],
  configuration: [
    "按已有 schema 修改组件字段",
    "对象深合并、数组替换、显式字段删除",
    "真实模型/技能/MCP 选择",
    "目录/文件绑定与敏感字段沿用原校验；不读取或导出敏感值"
  ],
  reuse: ["命名组合保存/套用", "当前草稿恢复后重新核对", "原安装事务确认后的正式函数 Mod 复用"],
  limits: CREATOR_REQUEST_LIMITS,
  unsupported: [
    "任意 DOM/CSS 或宿主/权限内核重写",
    "动态/通配事件",
    "自动启动任意已保存 Flow",
    "function-authoring-s1 不保证任意完整业务插件导出或任意中间阶段重跑；条件能力见 conditionalCapabilities",
    "跨项目复用旧授权",
    "未知副作用自动重放"
  ],
  onUnsupported:
    "保留当前运行版、草稿和可用组合，说明具体缺口及实际支持的替代方案；未应用的部分标为草稿。不要删除原功能、关闭其它 Mod 或虚构能力来宣称完成。高级 SDK 的存在不等于首批自动创作保证。"
})
