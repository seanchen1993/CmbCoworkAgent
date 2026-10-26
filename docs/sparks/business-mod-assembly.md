# 业务 Mods 组装与执行适配

业务 Mods 用于声明可复用的阶段 Skill、检查、资源和常驻 Function Mods；组装结果是独立插件。平台负责依赖闭包、来源身份、配置、安装事务和原生执行约束，业务规则由插件定义。

## 选择执行契约

| 契约 | 适用情况 | 状态与检查由谁持有 |
| --- | --- | --- |
| `host-linear-v1` | 新的线性业务流程，可用阶段 Skill、产物、声明式检查和审批表达 | 原 Host 项目执行器、宿主状态和实际检查凭据 |
| `autobiz-v1` | 保留原 AutoBiz Python board、知识配置、Hooks 和动态流程 | 原插件执行器及状态；受审适配器核对必需检查 |

新的业务优先采用 Host 契约。添加业务场景只需增加插件源码与声明，不应在平台添加供应商、数仓等场景名称判断。旧来源未声明 `runtime` 时保留原兼容路径；这不代表任意旧 Python 内核均已准入。未知适配器会被拒绝。

适配器是受审的宿主桥接实现，组装时仅静态生成配置，不执行作者提供的 JavaScript 或 Python 适配器代码。普通作者可以自由定义 Host 业务内容；不能凭一个适配器名称获得原生权限，也不能通过把 AutoBiz 改标为 Host 来绕过原校验。

## 声明一个 Host 来源

源码目录需要 `plugin.json` 和 `mods/business/manifest.json`。共享内核声明如下：

```json
{
  "id": "my.business-kernel",
  "version": "1.0.0",
  "runtime": { "adapter": "host-linear-v1" },
  "resources": ["knowledge/policy.md"]
}
```

Host 内核不声明 `boardConfigPath`，不需要 AutoBiz checkpoint，也不生成 `devclaw.stage-checks.json`。每个模块提供真实 Skill 和 Host 阶段合同，例如：

```json
{
  "id": "review",
  "title": "资料审核",
  "node": { "id": "review", "skill": "review", "order": 20 },
  "skill": { "entry": "skills/review/SKILL.md", "resources": [] },
  "resources": [],
  "dependencies": { "required": ["intake"], "advisory": [] },
  "checks": { "validators": [], "guards": [] },
  "host": {
    "stage": {
      "actionIds": [],
      "artifactIds": ["review-result"],
      "checkIds": ["review-schema"],
      "approval": "none"
    },
    "actions": [],
    "artifacts": [
      { "id": "review-result", "path": "review.json", "required": true }
    ],
    "checks": [
      {
        "id": "review-schema",
        "kind": "json-schema",
        "artifactId": "review-result",
        "sideEffect": "read",
        "schema": {
          "type": "object",
          "properties": { "decision": { "type": "string" } },
          "required": ["decision"],
          "additionalProperties": false
        }
      }
    ],
    "environment": []
  }
}
```

以上模块依赖同一目录中声明的 `intake` 模块及其实现。自有模块来源使用精确 `kernelRef`，版本必须相同。组装器自动补入必需依赖，校验顺序、资源命名空间、配置冲突、阶段引用和检查闭包；不会自动推断脚本或提示词里未声明的依赖。

`host.stage` 不能覆盖模块 ID、标题或 Skill 身份。阶段 Skill 由真实 `skill.entry` 路径决定。每阶段必须有实际检查，必需产物必须由该阶段检查覆盖；无效引用、重复全局 ID、遗漏检查和混入旧 `validators`、`guards`、checkpoint 等语义均明确拒绝，不会静默丢弃。

当前 Host 组装不接受仍依赖原 board 的 Python `contextProvider.entry`。知识可以作为声明资源，由 Skill 经原生文件工具实际读取；配置可由普通 Function Mod 经原用户配置机制提供。需要原 Host action Context Provider 的完整项目可继续使用项目声明工具；不能为解决不支持的入口而伪造一个 AutoBiz board。

## 保留知识、配置与完整资源

`kernel.resources`、模块 `resources`、`skill.resources` 及扩展资源均属于显式闭包。资源声明可以是具体文件或安全目录前缀；目录内容按原有路径、类型、数量、深度及字节限制展开。声明资源缺失、敏感文件、链接和路径越界均拒绝，不能导出删减知识后的成功包。

源码、知识数据与运行结果分别处理。随包知识是版本化资源；账号、密钥、本地目录绑定和批准不会随包发布。目标环境重新配置后，真实工具和模型调用仍受原生授权控制。资源声明只证明文件被保留，不证明模型已经读取或理解，业务验收还需要检查真实请求、读取结果和产物。

普通 Host 来源可以包含同名 `board_core/board_config.json` 业务资料；文件名本身不选择旧引擎。来源须有有效 Host 运行声明或完整 Host catalog，非法声明不能回退为另一条路线。历史无声明的 board 插件继续采用原兼容保护。

独立业务例子采用普通 Function Mod 提供 `policyTier` 配置，Skill 读取随包知识，再读取前序阶段产物。平台没有为这些业务字段增加专用工具或状态分支。

## 加入自有 Mod 并交付

1. 在“从 Mods 组装新插件”中导入共享内核来源和自己的模块来源，选择业务步骤及常驻扩展。
2. 核对预览中的执行方式、自动补齐的依赖、实际步骤、检查和完整文件列表。
3. 生成独立副本，执行原检查；需要时导出 ZIP 或通过原安装入口安装。生成、检查和安装都不等于业务成功。
4. 在创造者模式中，可对已检查的精确候选请求 `request_trial`。Host 候选导入原项目创作与试用服务，AutoBiz 候选进入原受审旧项目路径；均需原生确认，不先安装候选，也不继承旧批准。
5. 读取实际阶段、工具、产物检查及反馈，再修改候选、重新检查和确认。来源或配置发生变化后，旧观察不能证明新版本。

安装并启用后，面板会重新核对实际插件和模板。所有项目插件统一从“项目模式 → 新建项目”选择；系统按所选插件展示相应配置，并调用其对应的项目运行服务。创造者交付卡的“开始使用”可定位已安装的新插件。卸载、停用或模板变化后请重新检查入口；旧项目继续保留原版本和检查记录，不自动改绑新插件。

原项目创作试用有独立的文本与资源限制，例如单文件 64 KiB、总量 256 KiB、32 个文件及有限深度。超过限制会明确拒绝，不把业务组装器的较大来源限额误称为所有试用入口均支持的规模。

## 插入步骤时的产物衔接

新模块要声明自己的依赖、实际 Skill、产物和检查。下游需要新增步骤的结果时，也必须声明相应依赖并实际读取，不能仅依靠相邻排列或文件存在。Host 使用原输入指纹、产物摘要与检查回执：前序必需产物发生变化后，旧回执不能继续证明当前状态。

原 AutoBiz 的检查可能在阶段迁移边上发生，不能仅按界面节点完成判断。其原知识、角色、工具前后 Hooks、checkpoint 与迁移检查继续由专用适配器及原执行链保留。适配器抽离不表示允许删除检查或接受普通 Mod 自报 `passed`。

## 当前边界

原始插件可在创造者中先 `inspect_raw` 检查真实来源，按文件读取迁移材料，再以
`request_modularization` 请求原生确认。确认只在私有目录新增模块化候选，不修改原插件、
不安装、不转移权限。明确 Host 阶段可静态拆分；共用 Skill 保留原文件和名称，按阶段生成
安全别名。别名与原 Skill 目录互为同父目录的兄弟目录，保持 `../shared`、`../../scripts`
等引用的父目录和深度；只替换真实 YAML frontmatter 中的 `name`，正文与资源保持原字节。
如原插件包含 `PreSkillUse`、`PostSkillUse`（含通配 matcher）、无法识别的 Hook 声明，
自动别名明确阻断，须先由作者完成 Hook 映射；不会静默改写原 matcher 或跳过原 Hook。
这是转换完整性的保守边界；[技能前后事件已向 Mod 开放](events-and-api.md#技能使用前后扩展)，
不等于转换器能够无损拆分任意原 Hooks、重写 matcher 或自动迁移原校验脚本。
别名冲突、缺失检查、未知上下文或无法保持原契约时明确阻断，不能删除阶段或校验来通过。
确认后的 `inspectionId` 进入既有组合、试用、检查与独立插件安装/导出流程。

对尚无运行声明的经典 Skill 插件，创造者可显式编写 catalog，并以
`modularizationFiles:[{path,text}]` 补充首次 Host 试用所需的 `tests/project-contract.json`、
新 Skill 和知识资源。此输入仅能新增，沿用 32 文件、单文件 64 KiB、总量 256 KiB 的文本
限制；只接受必要包内目录，禁止覆盖原文件、创建身份或运行声明、敏感路径及大小写冲突。
原源 digest 保持审批锚点，新文件必须进入 catalog 的完整资源闭包。原生确认卡逐项显示
新增文件的字节数与 SHA-256；变更新增文件需要重新请求确认。源码生成不执行新增脚本，
之后仍由原组装、doctor、contract 和 Host 真实试用及授权入口检查。已有 Legacy 运行时或
无法判明语义的旧 board 不能据此改标 Host；须保留原受审适配器边界。

Host 多阶段可引用相同的动作、产物、检查和环境声明。同标识且结构完全相等时共享一份，
定义冲突继续拒绝。`kernel.runtime.capabilities` 可保留原 Host 的五项布尔声明，缺省仍采用
既有线性适配器默认值；只接受完整五字段，不接受额外字段。声明不授予执行权限，也不证明
宿主新增了 DAG、条件执行、幂等或恢复能力。AutoBiz 的受审协议仍只接受其既有适配器字段。

- Host 契约支持既有声明式线性执行器，不因此获得任意 DAG 或任意旧内核的自动迁移能力。
- 原 AutoBiz 的精确受审资源准入继续存在；其可选本地来源验证策略与正常包内 Hooks 是不同路径。
- 通用 completion 采集已不再猜测 AutoBiz 状态目录；适配器在原生边界提供受控证据引用。该引用是内部公共合同，本轮未新增允许普通 Guest 任意指定采集路径的 SDK 字段。
- 同阶段失败后的原有重试不等于阶段回退。已提供阶段快照、隔离分支和中间阶段重跑，但须通过来源、冻结输入、检查及恢复策略准入。插件自有状态还需显式恢复适配器，不能据此撤销已发生的外部副作用；详见[阶段调试扩展](stage-debug-mod-extension.md)和[插件状态恢复](creator-plugin-workflow.md#插件拥有状态时如何恢复阶段)。
- 检查凭据证明指定来源及版本的规则实际执行，不证明规则充分或业务审批已经完成。真实外部模型质量、业务正确性与成本需要另行评估。
