# Autobiz fullstack 0920 · 原生 Mods 增强

新开发者请先看[插件开发入门](../../docs/sparks/plugin-cookbook.md)：练习二添加阶段说明，
练习三把本包读取动作接给独立 Review，练习四说明复用业务节点必须保留的 Hooks 与验证链。

本目录提供项目能力面板声明及四个增量灵件。完整安装包由专用打包器从
`dev_autobiz_fullstack_0920 / 504e327d2f9a4d9e30e9f541c4432accf8000ad5 / 1.0.87`
导出原插件，再加入本目录的 `mods` 和 `devclaw.project.json`。包名和 native id 为
`AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods`。
这里没有复制旧看板、旧 compiler、七种旧流程、完成门禁或阶段提交器。

## 项目模式中的统一入口

安装完整包，在项目模式绑定本插件并配置工作区，打开一个需求即可看到项目能力面板。
阶段指导、前置检查规则、完成验收规则和中文使用说明集中在详情中。
产物与 Hook 历史继续来自原项目适配器；规则说明不代表已经验证通过。
进入当前阶段会话只准备原技能指令，发送后才执行。已有运行、人工审批与恢复沿用原入口。
标准、精简和详细设计动态节点均由原工作流决定，声明不增删阶段、不关闭 Hooks。
通用接入说明见工程 `docs/project-capability-authoring.md`。

## 选择组件后怎么使用

| 组件 | 命令和作用 |
| --- | --- |
| 真实状态与来源 `status` | `/autobiz-fullstack-info` 查看分支、提交、原版本和边界；`/autobiz-fullstack-status [Feature ID]` 查询原脚本的规范状态。未指定 Feature 时列出记录，不自动挑第一条。 |
| 项目真实状态看板 `board` | 依赖 `status`。`/autobiz-fullstack-board [Feature ID]` 打开交互看板，明确选择 Feature，查看原记录的 checkpoint、阶段和选定 `workflowNodes`。刷新重新调用原只读脚本。 |
| 真实单文件模型检视 `review` | `/autobiz-fullstack-review src/example.py` 经宿主权限读取当前项目文件，等待当前组合默认模型回复。文件和有效模型回复均不超过 4000 字符。 |
| 跨插件检视输入 `review-input` | 只导出可等待动作“Autobiz：准备真实单文件检视输入”。隐藏命令 `autobiz-fullstack-prepare-review` 接收宿主动作 envelope v1，必须给出 `input.feature` 和 `input.path`。 |

状态与看板命令没有设置 `immediate`，保留原执行审批；看板按钮刷新同样走受审批的
`$.process.run`。脚本固定为安装包内的 `read_state_json.py`，使用 `python -B -X utf8`，
最长 30 秒；不调用会修写状态的 `inspect_state.py`。
工作区只取当前 `$.session.root()`，由其父目录和目录名分别提供原脚本要求的
`PLUGIN_WORKSPACE`、`PROJECT_DIR`。不能输入任意外部工作区，不能选文件系统根目录。
Python 的退出码、schema、ok、来源和记录错误均需通过检查，不能把失败显示成空项目。

先在 DevClaw 选择自己的项目目录，导入并授权完整包。在“我的 Claw”中选择所需组件、
已有模型和流程，保存后确认应用。只选状态不会注册检视命令或准备动作；选看板必须同时选状态。
保存和应用不会自动运行任务，普通聊天发送对应命令才触发。

## 与其他插件组合

流程选择本包的“准备真实单文件检视输入”，明确真实 Feature 与项目相对文件路径。
动作实际等待读取完成，先后查询原规范状态，确认所选 Feature 的完整记录没有变化，
才返回且仅返回 `{feature, checkpoint, stage, path, source, context}`。
未知 Feature、受限状态文件、状态变化、读取拒绝或空／过大文件都会拒绝该动作。
它不会偷偷执行模型任务、写文件、跑测试或推进阶段。

下一步可选独立 Review 插件的输入检视动作，输入选择前一步的完整对象；再选择汇报动作时，
按照该动作 schema 用“本次执行结果”输入，不把 Review 的单个字符串假充成所需对象。
Agent 步骤可以另外选择 A／B 模型；当前示例的单文件检视使用 `model: "default"`。
清单明确采用 `legacy-v1` 模型文本协议，空回复、非文本或超过 4000 字符均拒绝，
不会把 `result-v1` 对象或错误文本当成有效检视结论。

文件路径必须是当前项目内的相对路径，拒绝 `..`、绝对路径、设备／流路径。
`state.json`、`STATE.md`、`hooks.ndjson`、`.plan.lock` 不交给模型直接读取。
链接目标、稳定文件读取和实际权限仍由宿主限制；本例没有通过 Python 绕过文件权限读取输入文件。

## 不能据此声称什么

`1.0.87-mods.3` 新增独立 `devclaw.project-runtime/v1` 声明，状态仍由原插件负责。
实际阶段从原详情读取，声明不固定一套阶段，因此不删除动态或精简路线。
新面板可查看阶段与证据并使用原会话入口；平台直接执行、原子推进和自动恢复尚未验收，
相应能力明确关闭。原有会话、审批、取消和托管入口保持其原行为，这不是关闭原插件功能。

看板只显示原分支规范化记录，不猜动态流程的下一步、不判断验证通过，也不自动推进。
模型检视只是单文件意见，不是项目测试、业务验收或阶段完成证据。
完整打包保留原 Skill、MCP、角色、工作流、Python 和经典 Hook；原完整 Plugin／Harness
业务通过原入口使用。普通本地 Function 演示并不证明全部原业务门禁都已生效。
本例不把新分支交给旧宿主 Autobiz validator 自动批准。

`mods/source.generated.ts` 是来源模板，专用打包器只在输出副本中写入实际解析的
`{branch, commit, upstreamVersion}`。本目录本身不是完整上游插件，也不含业务状态数据。
新增回归使用真实编译、组件投影和 GuestRuntime 核对 SDK 调用、等待及边界；
原 Python 入口、原分支测试基线和冻结包体验由独立实测记录证明，不能由有限 mock 回归代验。
