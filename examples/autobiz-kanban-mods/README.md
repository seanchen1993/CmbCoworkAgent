# Autobiz Kanban Function Mods

## 组件组合与真实源码预设（2026-10-01）

生成器现在输出 `1.5.0` 原生组件包。安装后可分别选择“状态与产物检查”“项目看板”
“单文件模型检视”“完成前检查意见”“跨插件检视输入”；看板依赖状态组件，其他组件可单独选择。
这是本工程显式组件格式，不是 Claude 官方 manifest。上游 Skills、Python 工具和 MCP 文件仍保留，
不会自动拆分任意旧插件，也不能将这套预设称为上游 reviewer/utest 流程的完整复刻。

在“DIY 流程”选择 Autobiz 预设：

- **只检视**：Explore 角色实际读取仓库，汇报发现并等待确认，不运行项目测试。
- **检视与测试**：只读检视后运行真实单元测试；失败停止，不自动改代码。
- **修复与复检**：先检视、测试；仅测试失败才修改实现并运行同一原生测试，最多两次修复。
  初次测试已通过会跳过修复步骤。不得通过改弱测试、需求或检查配置来掩盖失败。

每个 Agent 步骤可以换模型；汇报步骤可以替换为另一个已安装授权插件的动作。
保存 Flow 后绑定到 Claw，保存并应用到当前对话，再从聊天“执行流程”发送本次目标。
这些预设默认不修改 checkpoint、不自动推进阶段。单文件 `/kanban-review` 仍只是输入文件的模型意见，
真实仓库检视由预设中的 Agent 工具调用完成，真实测试由宿主回执证明。

生成目录中的 `autobiz-source-project` 是固定上游源码的独立副本，无人为故障；可将它作为项目打开。
它没有 `package.json`，使用显式 `.cmb/project-checks.json`：

```json
{
  "schemaVersion": 1,
  "unitTest": {
    "runner": "python-unittest",
    "startDirectory": "tests",
    "pattern": "test_*.py"
  }
}
```

需要已安装的 `python`。宿主固定调用 Python unittest loader，不安装依赖、不接受任意 shell 文本；
空测试集合失败。路径仅接受项目内 ASCII 相对目录，不允许链接和跳出目录；文件模式以 `test_` 开始、
`.py` 结束，可使用 `*`、`?`。执行仍走原工具审批、取消和测试回执，配置变化会使旧证据失效。
没有该配置的 npm 项目继续使用原有检查入口；Python 配置不代表已配置 E2E。

固定上游完整基线 168 项有 5 failures 和 1 error，原结果如实保留。
若只体验已核验焦点用例，可显式把 `pattern` 改为 `test_project_status_invalid_checkpoint.py`；
这只验证该用例，不证明上游全量通过。不要将旧 `demo-project` 的合成订单演示当作这个源码副本。
生成包附 `flow-presets/*.json` 便于审阅；应用内置按钮与这些 JSON 来自同一预设函数。

当前完整操作、兼容缺口和旧插件改造方式见 [使用与迁移指南](../../docs/mods-compatibility-impact-and-plugin-migration-2026-09-29.md)。

## 跨插件组合动作（2026-09-29）

新版安装包导出“Autobiz：准备单文件检视输入”。它读取真实 Feature/checkpoint 和一个项目文件，
输出结构化 `feature/checkpoint/stage/path/source/context`；它本身不完成检视、运行测试或推进阶段。
需要先用下方脚本生成完整安装包，本目录是覆盖模板，不能独立安装。

同时安装并授权 `examples/mods-review-agent` 的独立 Review 插件，然后在 Claw 中选择这两个来源：

1. 第一节点选择 Autobiz 的 `prepare-review`，输入例如
   `{"feature":"order-export","path":"order-export.cjs"}`。文件须真实存在且不超过 4000 字符。
2. 第二节点选择 Review 的 `review-input`，输入来源选择第一节点，JSON Pointer 留空，常量输入填 `{}`。
   可在参数中设置 `{"model":"custom:你的模型ID"}`，并将此模型加入 Claw 的角色模型绑定；
   不配置时使用 Claw 默认模型，未指定 Claw 默认时使用宿主默认。
3. 后面可以添加内置测试和人工确认。保存流程到 Claw，保存组合，再选择“在当前对话使用”。
4. 对话中选择“执行流程”，输入这次检视目标并发送。右侧核对两个不同提供者的执行结果。

第二节点会等待真实模型返回检视后再完成。模型未配置、源文件不存在、授权撤销都会停止，
不能把“已启动后台检视”当作完成，也不能把单文件模型意见当作测试通过。
`claw-actions.json` 在打包时合入 `plugin.json`，导出声明与代码共同绑定授权摘要。

## DIY 步骤编排（2026-09-27）

开发版新增「自定义 → DIY 流程」：从 Autobiz 模板选择步骤、调整顺序、选择 Agent/模型、配置失败回退和人工确认。安装授权仍在 Function Mods 页面。完整操作见 [DIY Claw 实操说明](../../docs/mods-v3-diy-flow-hands-on-2026-09-27.md)；旧 `/kanban-*` 辅助命令不能代替新流程编排。

将 `seikou00/autobiz_kanban` 的工作流资产接入 CMBDevClaw：保留原 Skills、MCP、Python 检查器和业务目录，提供 Function Mods 看板、命令与完成前代码评审。打包固定使用上游 `dev_agents_inject` 的提交 `8db1ec937d6ed3d271cb9dc540310d6633c91e70`（上游版本 `1.0.79`）。

当前版本的项目完成规则由应用管理。宿主能够执行项目测试、固定版本 Autobiz validator，并在检查、证据复核和权限审批全部满足后提交当前阶段。插件意见、文件存在检查、业务测试和阶段提交是不同的结果，不能互相替代。

## 生成安装包

在 CMBDevClaw 开发工程根目录执行；输出目录必须是新目录：

```powershell
node scripts/package-autobiz-mods.mjs C:/ai/autobiz_kanban output/autobiz-mods-new
node bin/cli.js plugin check output/autobiz-mods-new/AutobizDevOps_Plugin_Kanban_Mods
```

CLI 的 `valid: true` 仅表示包结构和注册有效，不代表已经授权或业务验收通过。生成器附带的旧 `demo-project` 用于看板/单文件评审，不能直接当作完整业务测试和自动推进的验收项目。

## 安装和设置

1. 使用 ModsV2 开发应用，创建关联业务项目目录的普通本地会话。
2. 在「自定义 → Function Mods」上传 ZIP 或从打包后的插件文件夹安装。当前没有管理密码，项目运行授权仍需完成。
3. 开启应用级及项目级 Mods，检查并授权当前源码摘要。更新包后需要重新授权。
4. 在该插件的「完成检查规则」选择模式、范围、检查项和预算，点击「保存项目规则」。安装、授权和打开看板本身不会开启自动完成检查。

模式含关闭、仅报告、阻止完成、自动修复并复检。代码评审由本插件处理，项目测试与 Autobiz validator 由宿主执行。自动评审使用应用默认模型，会产生实际模型用量。

选择 Autobiz 检查时先执行环境预检。自动推进还需选择严格模式、Feature ID 和阶段起点；留空起点仅检查。宿主从固定 workflow 推导终点，不接受插件随意指定目标；当前自动阶段提交仅支持 Windows 本地固定 NTFS 磁盘。

## 命令分别做什么

| 命令 | 能力及边界 |
| --- | --- |
| `/kanban` | 打开看板，显示项目真实状态和完成规则摘要；需要时点击“刷新真实状态” |
| `/kanban-check order-export` | 检查当前阶段产物存在且非空；不运行完整 validator、不证明业务通过、不推进阶段 |
| `/kanban-review order-export.cjs` | 主动执行一次单文件模型评审；不执行测试或推进阶段 |
| `/kanban-last` | 查看最近插件自动评审报告；不代替宿主完整完成证据 |
| `/kanban-mode`、`/kanban-target` | 兼容尚未保存应用规则的旧配置；应用接管后提示回“完成检查规则”修改 |

旧文档中的“单文件、不会推进”仅适用于这些辅助命令，不能代表当前宿主完成规则的全部能力。完整过程应看任务底部「完成检查证据」，并核对磁盘测试和状态。不要同时手工启用保留的 `hooks/classic-hooks.json` 来重复执行相同门禁。

## 在源码工程中查阅

详细规则见工程内 `docs/mods-v2-application-completion-rules.md`；当前本机完整订单导出演练见 `docs/mods-v2-autobiz-hands-on-2026-09-26.md`，包含新的 ZIP、独立业务项目、三轮对照和项目外验证工具。该教程的本机路径不能直接当作其他机器已经存在的文件。
