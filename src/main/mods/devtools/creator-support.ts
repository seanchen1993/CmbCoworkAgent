import { CREATOR_REQUEST_LIMITS } from "./creator-request-budget"
import { HOST_INPUT_RESUME_CAPABILITIES } from "../../../shared/project-runtime/host-types"

export type CreatorCapabilityDiscovery =
  | { kind: "tool"; tool: "mod_authoring"; arguments: Readonly<Record<string, string>> }
  | { kind: "native"; api: string; operation: string; entry: string }

export interface CreatorConditionalCapability {
  id: string
  scope: "host-project" | "plugin-owned-project" | "plugin-delivery"
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
    description: "真实Host进入快照的独立stage/downstream分支，须满足以下条件。",
    operations: [
      debugList,
      { kind: "tool", tool: "mod_authoring", arguments: { action: "project_stage_debug_prepare" } },
      debugNative
    ],
    preconditions: [
      {
        id: "native-baseline",
        description: "同创造者/项目真实试用进入快照，取list的snapshotId。"
      },
      {
        id: "source-settled",
        description: "原执行任何状态未结算皆拒；须工作区空闲。"
      },
      {
        id: "compatible-candidate",
        description:
          "传真实id/revision/snapshotId/debugMode；仅改目标/后续非共享Skill正文，保检查契约/输入身份。"
      },
      {
        id: "readonly-native-actions",
        description:
          "检查精确产物；仅platform.act/read，禁嵌套平台及文件/进程/网络权限；materials仅冻结材料，声明只读仍实核。"
      },
      {
        id: "fresh-native-consent",
        description:
          "prepare不执行；用户核候选摘要原生create；命令Hooks/脚本provider另确认网络副作用，逐阶段重批。"
      }
    ],
    blockers: [
      {
        signals: ["snapshots.length=0"],
        owner: "user",
        reason: "无快照：先原生批准真实试用。",
        next: debugList
      },
      {
        signals: ["PROJECT_STAGE_DEBUG_SOURCE_UNSETTLED"],
        owner: "user",
        reason: "原入口停止/核对未结算并释放占用；未知副作用不自动重放。",
        next: debugList
      },
      {
        signals: [
          "PROJECT_STAGE_DEBUG_CANDIDATE_CHANGED",
          "PROJECT_STAGE_DEBUG_SOURCE_CHANGED",
          "PROJECT_STAGE_DEBUG_INPUTS_CHANGED"
        ],
        owner: "creator-author",
        reason: "变化后重核来源与较早起点。",
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
          "PROJECT_STAGE_DEBUG_RESOURCE_ADAPTER_REQUIRED",
          "PROJECT_STAGE_DEBUG_READONLY_ADAPTER_REQUIRED",
          "PROJECT_STAGE_DEBUG_CHECK_EFFECT_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_CHECK_INPUT_UNSUPPORTED",
          "PROJECT_READONLY_CHECK_PROVIDER_DENIED",
          "PROJECT_READONLY_CHECK_DISPATCH_DENIED",
          "PROJECT_STAGE_DEBUG_CAPABILITY_FLOW_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_VERIFIED_ARTIFACTS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_SKILL_HOOKS_UNSUPPORTED",
          "PROJECT_STAGE_DEBUG_CAPABILITY_DEPENDENCY_UNSUPPORTED"
        ],
        owner: "host-adapter-maintainer",
        reason:
          "配置/知识冻结绑定，Hooks/脚本provider声明恢复兼容；只读核原权限/派发。进程检查/行为共享Mods/MCP/外部动作/未适配workflow皆拒，不删功能绕过检查。",
        next: debugList
      },
      {
        signals: [
          "PROJECT_STAGE_DEBUG_NATIVE_CONFIRMATION_REQUIRED",
          "PROJECT_STAGE_DEBUG_RECONFIRMATION_REQUIRED"
        ],
        owner: "user",
        reason: "创建/执行重获原生确认；模型不代批，历史不授权。",
        next: debugNative
      }
    ],
    nextDiscovery: debugList,
    guarantees: [
      "仅恢复受控工作区文件，不恢复数据库、网络、发布或 Git 状态。",
      "检查重产原Flow事实/业务凭据，不继承通过/成果批准/provider授权。",
      "命令 Hook 终态可冷核对，不替阶段/产物校验；单阶段≠整轮验收。",
      "自有状态另适配plugin-owned-stage-recovery，非Host快照。"
    ]
  },
  {
    id: "plugin-owned-stage-recovery",
    scope: "plugin-owned-project",
    availability: "conditional",
    description:
      "已适配插件通过自己的规划、应用和验证脚本，将已结束试用恢复为新的独立副本，继续沿用原业务引擎与 Hooks。",
    operations: [
      {
        kind: "native",
        api: "window.api.mods.development.businessTrial.recovery",
        operation: "inspect",
        entry: "插件试用 → 插件阶段恢复 → 检查阶段恢复条件"
      },
      {
        kind: "native",
        api: "window.api.mods.development.businessTrial.recovery",
        operation: "prepare",
        entry: "插件阶段恢复 → 核对实际版本与起点 → 确认规划"
      },
      {
        kind: "native",
        api: "window.api.mods.development.businessTrial.recovery",
        operation: "apply",
        entry: "插件阶段恢复 → 核对方案和产物 → 确认创建独立试用"
      },
      {
        kind: "native",
        api: "window.api.mods.development.businessTrial.recovery",
        operation: "latest",
        entry: "插件阶段恢复 → 读取已保存的恢复记录"
      },
      {
        kind: "native",
        api: "window.api.mods.development.businessTrial.recovery",
        operation: "reconcile",
        entry: "插件阶段恢复 → 核对记录；必要时重新批准只读验证"
      }
    ],
    preconditions: [
      {
        id: "native-ended-owner",
        description: "原试用和关联物理执行已结算，Main 核实保留包、工作区、会话身份及配置知识。"
      },
      {
        id: "declared-adapter",
        description:
          "精确保留包声明 devclaw.stage-recovery-adapter.json；业务组装扩展的 adapter 资源完整纳入原锁文件。"
      },
      {
        id: "exact-fresh-consent",
        description:
          "第一次批准绑定插件、适配器和输入摘要；第二次批准绑定实际方案摘要。Windows 文件隔离不保证阻断所有网络。"
      }
    ],
    blockers: [
      {
        signals: [
          "PLUGIN_STAGE_RECOVERY_ADAPTER_REQUIRED",
          "PLUGIN_STAGE_RECOVERY_ADAPTER_INVALID"
        ],
        owner: "host-adapter-maintainer",
        reason:
          "插件作者须先声明并验证插件自有恢复协议，重新组装和安装新版本；不能靠平台名称特例注入。",
        next: projectList
      },
      {
        signals: [
          "PLUGIN_STAGE_RECOVERY_OUTCOME_UNCONFIRMED",
          "PLUGIN_STAGE_RECOVERY_FRESH_APPROVAL_REQUIRED"
        ],
        owner: "user",
        reason: "读取原生恢复记录；未知命令不得重放，仅在真实成功终态确认后重新批准验证和接管。",
        next: {
          kind: "native",
          api: "window.api.mods.development.businessTrial.recovery",
          operation: "latest",
          entry: "插件阶段恢复 → 读取已保存的恢复记录"
        }
      },
      {
        signals: [
          "PLUGIN_STAGE_RECOVERY_ADAPTER_FAILED",
          "PROJECT_FILE_OBSERVATION_SENSITIVE_PATH"
        ],
        owner: "host-adapter-maintainer",
        reason: "当前副本恢复不回滚 Git 或外部工作树；插件必须补充私有仓库与工作树重绑定适配。",
        next: projectList
      }
    ],
    nextDiscovery: {
      kind: "native",
      api: "window.api.mods.development.businessTrial.recovery",
      operation: "inspect",
      entry: "插件试用 → 插件阶段恢复"
    },
    guarantees: [
      "保留原 Hooks、知识和必需产物校验，不继承旧授权，不把恢复成功当业务通过。",
      "未知结果只核对；确认成功后也仅验证和接管，不自动重放 apply。",
      "原项目保持不变，外部系统、数据库和 Git 状态不会随副本自动恢复。"
    ]
  },
  {
    id: "native-plugin-delivery-recovery-and-use",
    scope: "plugin-delivery",
    availability: "conditional",
    description:
      "安装和导出异常可核对实际结果；安装成功后从精确安装身份诊断配置、权限和真实使用入口。",
    operations: [
      {
        kind: "native",
        api: "window.api.mods.development",
        operation: "reconcileProjectDelivery",
        entry: "保存为新插件 → 核对实际交付结果"
      },
      {
        kind: "native",
        api: "window.api.mods.development",
        operation: "reconcileBusiness",
        entry: "业务插件保存 → 核对实际交付结果"
      },
      {
        kind: "native",
        api: "window.api.plugins",
        operation: "prepareStartUse",
        entry: "安装成功 → 开始使用 → 配置与环境核对"
      }
    ],
    preconditions: [
      {
        id: "exact-delivery-record",
        description: "使用 Main 持久交付记录与实际候选摘要；历史候选效果可核对但不代表当前版本。"
      },
      {
        id: "real-installed-identity",
        description: "开始使用核对安装 UUID、名称、版本和完整内容摘要；原生入口独立检查配置和权限。"
      }
    ],
    blockers: [
      {
        signals: ["PROJECT_DELIVERY_OUTCOME_UNCONFIRMED", "BUSINESS_CREATOR_OUTCOME_UNCONFIRMED"],
        owner: "user",
        reason:
          "先只读核对安装目录与导出文件；冲突保留证据处理后重新核对，确认未执行才可重新准备和批准。",
        next: {
          kind: "native",
          api: "window.api.mods.development",
          operation: "reconcileProjectDelivery",
          entry: "保存为新插件 → 核对实际交付结果"
        }
      }
    ],
    nextDiscovery: {
      kind: "native",
      api: "window.api.plugins",
      operation: "prepareStartUse",
      entry: "安装成功 → 开始使用"
    },
    guarantees: [
      "只读诊断不安装、不执行、不自动启用；配置和代码批准分别由用户确认。",
      "聊天扩展显示真实注册命令或可调用技能；项目流程定位实际项目入口，创建后仍需明确启动。"
    ]
  }
] as const satisfies readonly CreatorConditionalCapability[]

/** A bounded first-release promise, not an authorization envelope or a replacement SDK. */
export const CREATOR_S1_SUPPORT = Object.freeze({
  id: "creator-s1-2026-10-16",
  target: "关联本地项目的普通聊天",
  scope: {
    id: "function-authoring-s1",
    description: "首批函数创作保证；Host导出/调试另核条件。",
    discovery: {
      kind: "tool",
      tool: "mod_authoring",
      arguments: { action: "catalog", catalogSection: "support" }
    }
  },
  conditionalCapabilities: CREATOR_CONDITIONAL_CAPABILITIES,
  authoringConstraints: {
    nativeComposition: {
      protocol: "devclaw.native-composition/v1",
      source: "composition/source.json",
      scaffold: { tool: "mod_authoring", action: "project_scaffold", template: "native-modular" },
      discovery: { tool: "mod_authoring", action: "project_actions" },
      compilation: { tool: "mod_authoring", action: "project_compile" },
      runtime: { provider: "native.project-runtime", discovery: "platform.catalog" },
      stateOwner: "host",
      stageExecutionModes: {
        default: "normal",
        explicit: ["normal", "workflow"],
        workflowRequires: "frozen-host-stage-with-skill",
        completion: "original-managed-workflow-notification-before-host-checks",
        workflowInputResume: {
          live: "same-original-input-request",
          cold: "blocked-after-workflow-launch"
        },
        resultRoundReplacementWorkflow: false
      },
      inputResume: HOST_INPUT_RESUME_CAPABILITIES,
      execution: "unverified-until-fresh-native-trial",
      requirements: [
        "仅维护单source及真实Skill/资源；编译生成Host计划/检查/动作锁，不手写成功凭据。",
        "输入须前序真实输出及契约；输出须实检。",
        "project_actions选已安装检查提供器；编译不授权。",
        "知识读声明文件或native.project-context；选择器仅platform.read/act，材料/目录/公开配置由Host绑定签发。",
        "执行批准/成果批准/提交独立；仅请求平台，禁造完成。",
        "仅显式工作流模式开放工具；launched结束轮，Host物理结算后同源结果轮验产物。",
        "前序核验用runtime.provider的inspect-workflow-evidence，传声明stageId/真实runId；禁假会话/搬通过/扩current权限。"
      ],
      limitations: [
        "旧项目需确认才采候选；稳定边界仅改未来产物/业务检查计划。已完成Skill/检查/Hooks/知识/配置保原字节证据，不重放。",
        "已完成阶段/命令动作、脚本上下文迁移须恢复适配；原Flow/工作流/后台须结算，编译不保证在线迁移。",
        "仅安全输入续原持久检查点；工作流启动后只原活动轮可答；冷断unknown/待核对不重启；授权失效/输入变化拒。",
        "首次迁移逐项映射Hooks/知识/领域状态；静态转换/空计划≠旧业务。"
      ]
    },
    workflowComposition: {
      discovery: { tool: "mod_business", action: "read_workflow" },
      transformation: { tool: "mod_business", action: "transform_workflow" },
      operations: ["insert", "replace_skill", "replace_step"],
      requires: [
        "inspected-source-digest",
        "current-workflow-digest",
        "complete-module-contract",
        "real-implementation-files"
      ],
      preserves: [
        "required-checks",
        "hooks",
        "knowledge-resources",
        "configuration",
        "required-input-output",
        "native-approval"
      ],
      execution: "unverified-until-fresh-native-trial",
      limits: "只变换已声明且执行器支持的契约；线性视图不补语义、不替原生状态权限。"
    },
    stateExtensions: {
      scaffold: { tool: "mod_authoring", action: "scaffold", kind: "state-extension" },
      artifact: "executable-decision-scaffold",
      stateMigration: "not-migrated",
      execution: "unverified",
      originalInspection: { tool: "mod_business", action: "inspect_raw", field: "stateControl" },
      requirements: [
        "未知图作者确认；组装声明≠可执行状态Mod。",
        "保原Hooks/知识/配置/检查/唯一writer；既有 Host authority 不强制迁移。",
        "state.set ifVersion仅会话内 CAS；platform结果≠业务提交/多文件原子事务。",
        "默认hold；真实writer绑定及批准测试前，禁称迁移完成/造committed回执。"
      ]
    },
    usageMetrics:
      "Token 上下文占用与累计输入/输出用量是不同指标；用当前 SDK catalog/types 发现真实字段及来源，按语义取数。缺字段/统计显示“暂无统计”，不得默认 0 当作已测量，不得据此虚构 session API。"
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
    "按 schema 改组件字段",
    "对象深并/数组替换/显式删字段",
    "真实模型/技能/MCP 选择",
    "目录/文件/敏感字段沿原校验；禁读/导出敏感值"
  ],
  reuse: ["命名组合保存/套用", "草稿恢复后重核", "原安装事务确认后复用正式函数 Mod"],
  limits: CREATOR_REQUEST_LIMITS,
  unsupported: [
    "任意 DOM/CSS 或宿主/权限内核重写",
    "动态/通配事件",
    "自动启动任意已保存 Flow",
    "首批不保证任意业务插件导出/中间阶段重跑；条件能力见 conditionalCapabilities",
    "跨项目复用旧授权",
    "未知副作用自动重放"
  ],
  onUnsupported:
    "保留当前运行版、草稿和可用组合；明示缺口/实际替代，未应用标草稿。禁删功能/关其它Mod/虚构完成；高级SDK≠首批保证。"
})
