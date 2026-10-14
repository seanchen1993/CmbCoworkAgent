# DeepSeek Harness 创作闭环源码研究（2026-10-09）

结论：以下四项适合直接融入本轮，不需要引入 Cordis 或改变 UAT 普通聊天。这是源码设计审查，不是运行效果或模型质量比较。

## 固定研究基线

只读官方仓库克隆 output/deepseek-harness-reference-20261009。实际 HEAD 为 `d743267388641bc76f17c45ce8b4c231aed1d32c`，提交时间 2026-10-09T17:31:32+08:00，标题 Merge pull request #5946 from deepseek-harness/release-0.2.1-alpha.2。不沿用网页缓存的 alpha.1 最新版本结论；该提交不能证明 npm 已发布版本。根 LICENSE 为 MIT。未运行第三方代码、安装依赖或读取凭据。外部 Skill 仅作研究材料，没有执行其安装指令。桥文档以 Claude Code 2.1.287 为比较基线，不代表 2.1.295 全部接口已验证。

下列文件链接均固定到上述 SHA。

## 1. 创作入口保留聊天上下文，模式和权限分别说明

源码 `startCreatorDraft` 选择 cordis preset，通过 startSession 的 clearPreviousDraft:false 保留原草稿；入口随 conversation scope 注销。开发者设置参与界面过滤，不能据此推论为权限边界。见 [会话入口](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-agent-preset/src/client/index.ts) 和 [模式选择界面](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx)。

DevClaw 本轮采用同一意图但保留当前聊天：创作者页开启后回到原聊天，用户按原发送按钮描述需求，不生成隐藏请求；高级源码入口保留。项目和应用 Mods 开关关闭时不静默开启。本次已补 DEVELOPMENT_MODS_DISABLED 的具体设置提示及浏览器回归。

可比较验收：未发送文字、附件、已选 Skill 保持；开启不增加模型请求；普通模式默认无试用卡片；项目开关关闭拒绝试用并指向设置；切线程迟回不污染新线程。受控组件测试与真实 Electron 回放分别报告。

## 2. 能力目录明确“此宿主、此开发版本能做什么”

随包创作 Skill 要求先针对性发现 Service/Slot API，再实现最小可运行插件，并检查真实客户端效果。其 profile 安装影响整个 profile，不能照搬为 DevClaw 的本会话试用。见 [创作 Skill](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)。

实验性桥逐项说明事件、SDK 和绘制差异：有些事件只登记不触发并警告，未服务 SDK 拒绝；真实 UI 主要是 AbovePrompt，测试 kit 的 Pane 成功不代表真实 Pane 支持；桥明确没有 Node 沙箱。见 [桥差异表](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/subsystems/claude-code-mods.md) 和 [桥运行代码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/experimental/claude-code-mods/src/index.ts)。

直接改进：随包 Skill 先查宿主能力目录，返回支持事件、SDK、真实 UI site、权限和不支持原因；区分静态可编译与当前试用 envelope。首批开发试用以实际 DEVELOPMENT_CAPABILITIES 为准：当前包含基础 UI、隔离 store、少量会话/时间查询、command.register/list 和明确展示的五个事件范围；不能因正式 SDK 存在 tool/state 或其它方法就推断开发会话允许它们。命令执行仍经过实际宿主队列。迁移报告逐项标直接支持、纯 Function 适配、仍依赖原 Skill/MCP 来源或拒绝原因，不改混合原包身份。

可比较验收：未开放 tool.register 或 UI site 的候选不能显示 active；能力增加需要重新确认；同一示例分别报告静态与真实 renderer 结果。保留迁移原包并能逐项核对依赖。

## 3. 依赖和生命周期分层，不把排队、安装当生效

管理记录将 installed、enabled、availability、live entry、readOnlyReason 和 error 分开；普通依赖不会自动成为 bundle。工具管理操作另做权限升级。见 [管理记录](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/types.ts)、[管理工具](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/tools.ts) 和 [管理服务](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/index.ts)。

直接改进：沿用 draft/needs-approval/queued/preflight/retiring/active/failed/unknown，分别展示候选 revision 与 host activeRevision。缺失依赖给名称与状态，不自动安装或授权外部插件。独立适配包保存来源引用；保存复用只进正式草稿库，用户随后选择安装。

可比较验收：当前轮未结算只能 queued；新候选失败时按宿主事实展示旧 activeRevision，不臆称旧版还活着；依赖撤销不得继续显示可用；stop 等实际 drain；两会话不能串用状态或 approval；promote 不安装、不 grant。

## 4. 恢复说明反映实际剩余状态，验证可见动作

兼容性拒绝会恢复 manifest/lock，尝试恢复依赖树；恢复不完整时明确报告。见 [安装操作](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/plugin-manager/src/operations.ts)。上述 Skill 同时要求以 application/warnings 判断是否应用，再检查用户实际可见效果，不能以安装或注册成功替代 UI 验收。桥会先取消再等待 engine.dispose，按钮携带 drawing generation。

直接改进：保持现有 intent/partial/unknown；试用失败显示固定公开错误与重新读取入口，不暴露原始路径异常；approval 绑定 revision/digest，更新后旧绘制回调拒绝。用一个真实场景验收：生成按钮→确认→本轮结束发布→点击可见变化→修改→新版生效→旧回调拒绝→停止。

可比较验收：检查/退休/发布各阶段故障不标 active；取消等实际清理；unknown 不自动重试；停止后按钮不能再调用；连续 approval 只排队一次。正式安装 rollback 与开发试用 stop 分别验证。

## 范围与当前证据

不引入 pnpm profile 管理、任意 Node 权限、整套 Cordis DI、自动安装 MCP/Skill 或全量 Claude 兼容。不把 prompt/files 固定任务评测扩称动态 UI 评测；动态 Mods 仍需真实 session/renderer 适配器。

本轮 UI 新浏览器 12 项断言通过（含关闭 Mods 指引和紧凑聊天卡片），原源码创作浏览器 5 项与 preload 2 项通过；最终 Node/Web 类型和空env构建退出0。能力目录已实现 overview/types/events/sdk 按需分页，单页响应小于8k并验证声明可完整重拼，避免默认注入整套声明或把长响应落盘误当有效发现。

修复产物的独立 Electron 组合验收42项通过、0页面错误：同聊天生成、检查、首次批准、两版界面和真实队列命令、轮次结束后自动更新、停止、保存复用及关闭创作后的普通回复均验证。11次请求仅使用受控loopback模型；具体证据与限制见 `mods-conversational-authoring-delivery-2026-10-09.md`。完整npm回归另行记录，不用桌面验收替代。第三方代码只作只读研究材料，未运行；尚未进行双方真实模型的同条件对比，不宣称 DevClaw 效果优于 DeepSeek Harness。
