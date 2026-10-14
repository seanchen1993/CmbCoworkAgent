# 存量功能全面回检：Plugin 项目模式、Harness 与 Mods 共存

日期：2026-09-28。开发目录：`C:\ai\CmbCoworkAgent-mods-v2`，分支：`codex/mods-v2`。
本轮没有在 UAT 目录开发，没有提交或发布版本。测试使用独立数据目录和本地模型 / 服务夹具。

## 结论与验收范围

传统 Plugin 项目模式仍然保留，不要求转换为 Mods，也不要求取得 Mods 授权。
本轮验证了传统插件安装、Skill / Hook 发现、适配器创建项目与特性、执行记录、产物权限、
重启恢复和卸载后的项目保留；还验证了真实 MCP 子进程中的工具执行和连接清理。

不能仅凭 Mods 自身测试通过推断 Harness 无损。本轮真实桌面回检发现并修复了会影响
存量任务的 Stop 误续跑、流式消息覆盖、空 Mods 图额外消耗步数三个问题；空图优化首次
生产复验又发现宿主会话初始化遗漏，继续修正并保留失败记录。另修复了一处原有 IM 人工门禁提示错误。

本报告的“通过”指下表实际运行到的代码与断言。没有将企业服务、真实付费模型的回答质量、
macOS / Linux 桌面、安装包升级迁移或未覆盖的组合推断为通过。原有全仓失败仍独立记录。

## 已修复的实际问题

### 1. 原生 Stop 提示被误当成 Mods 续跑指令

- 触发：应用及项目开启 Mods，没有有效模块；旧 HTTP Stop Hook 只返回建议上下文，没有阻止完成。
- 原行为：桥接层误置续跑标志，产生多余模型调用，最终达到 Stop 重试上限。
- 修复：宿主记录 Function 回调是否真正新增完成反馈；纯原生结果和 `next()` 透传保留原 HookResult。
  内容保护改写自身不算插件反馈。真正的插件追加、短路、阻断仍按其语义执行。
- 回归：真实 QuickJS + manager 的无源、未授权、不匹配、透传、追加、短路、保护、原生阻断等场景。
  相关 4 套测试 49 项通过；原始失败保留在 `output/legacy-harness-before-fix.log`。

### 2. Mods 包装模型流时丢失完整消息块

- 触发：提供商在多轮回复复用消息 ID，Mods 开启但没有可执行模块。
- 原行为：早先的 `checking1` 会被后来的 `checking2` 覆盖；关闭 Mods 的同场景通过。
- 修复：流回调携带与实际 yield 一致的完整、处理后的 chunk，保留消息身份、工具和 reasoning 元数据。
  没有提前泄漏原始未处理内容，也没有修改前端合并规则绕过问题。
- 回归：真实 createAgent、原生 provider adapter、本地 SSE 复用 ID；模型边界与 electron-stream 合计 52 项通过。
  `output/legacy-model-boundary-before.log` / `output/legacy-model-boundary-after.log` 保留前后证据。

### 3. 空 Mods 图占用原任务步数

- 触发：全局和项目开关开启，但未安装模块或模块未获授权。
- 原行为：增加 6 个生命周期图节点；相同 2 次工具调用 + 最终回复的任务，在原 `recursionLimit=20`
  下关闭 Mods 成功，开启后提前失败。不能用增大预算掩盖这个问题。
- 修复：构图前只读检查当前摘要和授权，之后复核 epoch、取消和线程范围。没有有效来源时不加入
  Function 生命周期图节点；原生 InstructionsLoaded / PostToolBatch 仍按完整 Hook 上下文独立判断。
- 修正过程：首次生产 E2E 发现仅移除整个 session-view 工厂会同时丢失宿主 bind，导致
  `MODS_SESSION_UNAVAILABLE`。最终方案保留宿主初始化和 model/tool 包装，仅裁掉额外生命周期节点。
  初次失败证据保留在 `output/legacy-release-harness-on.log`，不会改写成通过。
- 最终定向 57 项通过，关闭 / 无源 / 未授权三种场景均为 **8 个节点、3 次模型调用、2 次工具调用、预算 20**。
  夹具补入了真实宿主模型选择更新路径，先红再绿。证据：`output/legacy-runtime-session-view-red.log`
  与 `output/legacy-runtime-readiness-final.log` / `.json`。
- 边界：图结构在一次物理 runtime 内固定。运行中首次授权的新增图阶段在下一 runtime 生效；
  正在执行的插件调用仍按原授权 / 撤权 epoch 失效规则处理，不承诺热插图或无条件继续旧调用。

### 4. 原有 Harness IM 人工门禁指令不可用

- 这是共同基线已有问题，不是 Mods 引入的回归。
- 提示中的批准命令没有对应路由，拒绝命令落到了工具审批通道。
- 改为现有 `/门禁批准`、`/门禁拒绝`；没有放宽身份、会话、审批码或重复提交检查。
- 通知链路 34 项通过，含从实际发布文案提取命令，经解析和路由完成批准 / 拒绝的回归。

以上方案和边界经两位 agent 交叉评审；主任务独立负责最终生产构建和桌面复验。

## 非 Mods 功能覆盖矩阵

| 模块 | 实际覆盖 | 证据 / 局限 |
| --- | --- | --- |
| 传统 Plugin | ZIP 检查、安装、发现、启停、删除、Skill / Hook 目录失效 | npm plugin / hook suites；真实桌面 7 组 |
| Plugin 项目模式 | 真 Node adapter 创建项目 / 特性、worker 执行、产物读取、重启、删除插件保留用户数据 | `tests/legacy-plugin-project-e2e.spec.ts`；未经企业项目模式 gate 的完整点击路径不算通过 |
| 产物与授权隔离 | 已发布产物读取成功、同项目未发布文件拒绝、权限恢复和失效 | 上述生产 IPC 测试及原 Harness 隔离单元测试 |
| Skill 与 Slash | 多源优先级、生命周期、frontmatter Hook、显示标签、合并及命令标识 | 24 条补充回归中的相关 suites |
| 传统 MCP | SDK stdio 真子进程、3 次工具调用、重载后内容更新、禁用 / 删除拒绝、旧 PID 退出 | `src/main/mcp/legacy-plugin-lifecycle.test.ts`；此集成隔离 Mods manager，未冒称覆盖所有开关组合 |
| 聊天 / 模型 / 工具 | 流式多轮消息、提供商复用 ID、工具结果、最终状态、取消、Goal 完成 | `tests/stream-harness-e2e.spec.ts`，最终 Mods off / on 对照 |
| 会话与历史 | 导航、消息时序、快照、reasoning 展开、重载、checkpointer、fork、消息队列和并发 lease | 独立回归 + chat-navigation / stream-snapshot 生产 E2E |
| 多 Agent / Harness 输出 | 子任务工具顺序、任务切换、复用 ID 隔离、完整及 tail 修正、历史分页 | subagent-tool-order / agent-team-output / workflow-output E2E |
| Workflow / Worktree | 引擎、脚本、审批、只读限制、分支隔离、Goal runner、协调器、后台执行 | 84 条串行命令中 workflow 部分；隔离测试按实际 Git Bash 前提运行 |
| Git 与文件 | 多仓提交、本地 HTML 来源、预览、文件边界、工作区权限 | git-multi-repo-commit / workspace-html-source E2E，文件边界回归 |
| 调度 | scheduler transcript、消息尾部、唤醒 / 任务状态、重复消息保护 | 调度 E2E、单元与性能约束测试 |
| IM | 事件存储、收件箱、远端执行、取消、审批、卡片、功能绑定、命令、门禁生命周期 | im-v1 全部命令及 notification-pipeline；未连接企业线上 IM |
| 内置浏览器 | chat 集成、脚本执行、cookie IPC 服务、HTML 预览、错误边界 | 平台夹具修复后定向通过；Chrome 扩展源码缺失另列 |
| UI / 大历史 | 聊天布局、时间戳、白屏恢复、真实语法高亮 Worker、窄屏和虚拟列表 | 既有 browser suites；没有以空 Worker stub 代替真实执行 |
| 构建 / 类型 | Node 与 Web TypeScript、生产 Electron 三层 bundle | 最终日志见结果表；不等于安装包升级已验证 |

## 测试基础设施修复

下列更改都保留或加强原业务断言，没有把失败断言删除后计为通过：

- 独立浏览器 esbuild 夹具缺少 Vite `?worker` 处理：补真实 Worker 构建，增加真实 Shiki 往返测试。
- Windows cookie 测试使用 Unix socket、上传路径断言固定 POSIX：改用平台管道和真实 path.resolve。
- 子任务工具顺序 E2E 的未打包路径错误：显式指定仓库生产 renderer 路径。
- 快照 E2E 的 reasoning 新行折叠：按用户可见的展开动作读取，原内容断言保留。
- IM 文案、平台路径、sandbox owner 参数及 Harness 常量来源断言过时：与实际契约对齐，并加强隔离字段断言。
- 子任务 tail 将“字段缺失”误当“显式清空”：补单字段、缺失和显式空值向量，再执行原性能检查。
- Worktree 测试用到 `pwd -W`：用已安装 Git Bash 运行，没有更换产品默认 shell，也没修改隔离断言。

## 结果和证据

- 初次 `npm test`：5,176 项，5,145 通过、26 失败、5 跳过。Vitest 失败导致 npm 后续链条短路。
- 为避免短路掩盖其他模块，拆开执行了所有 9 个 npm 分组的 84 条命令；修复与复验后 **84 条都有通过证据**。
  `output/legacy-followup-tests/effective-results.json` 保留初次和复验记录，没有覆盖失败历史。
- 额外执行 **24 条** Skill / Goal / 性能 / 浏览器回归命令，均有通过证据：
  `output/legacy-extra-tests/effective-results.json`。
- 原有 **13 套** browser / Electron E2E 均有通过记录；修复夹具后的日志在 `output/legacy-ui-tests/`。
- 本轮补充传统 Plugin 项目模式、真实 MCP 生命周期、Mods 开关下生产 Harness 对照及免口令设置回归。
- 以上不同层级的数字有重叠，不能相加当作唯一用例数。

### 最终执行结果

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 全量 Vitest | 653 文件，5,203 项：5,187 通过 / 11 失败 / 5 跳过 | `output/legacy-release-vitest.log` / `.json`；分类 `output/legacy-release-assessment.json` |
| 空图与宿主会话最后补丁 | 57 / 57 通过；包含 44 runtime authority、9 readiness、4 session-view | `output/legacy-runtime-readiness-final.log` |
| 传统 Plugin 项目模式生产 E2E | 7 组通过 | `output/legacy-release-plugin-project.log` |
| 真实 MCP 生命周期 | 完整生命周期通过，3 次实际工具调用 | `output/legacy-mcp-lifecycle.log` |
| Harness / Goal / 流 / 工具 / 取消，Mods 关闭 | 生产 E2E 通过 | `output/legacy-release-fixed-off.log` |
| 同一套 Harness，Mods 开启且无有效模块 | 生产 E2E 通过，模型次数相同，三条 UI 回复各自保留 | `output/legacy-release-fixed-on.log` |
| Autobiz DIY 流程生产 E2E | 7 组通过，含分支修复、人工确认、取消、步骤重排和重启不重放 | `output/legacy-release-fixed-flow.log` |
| 免口令设置生产 E2E | 14 组通过，含安装、授权、规则、卸载、重启 | `output/legacy-release-settings.log` |
| 兼容检查 / Stop 反馈 / InstructionsLoaded / PostToolBatch | 4 套生产 E2E 通过，覆盖开关对照、真实工具、原提示注入、预算、取消和撤权 | `output/legacy-release-mods-compatibility.log`、`output/legacy-release-mods-stop-feedback.log`、`output/legacy-release-mods-instructions-loaded.log`、`output/legacy-release-mods-tool-batch.log` |
| 设置浏览器 / 单元回归 | 14 组 browser、29 项单元通过 | `output/legacy-password-browser.log`、`output/legacy-password-unit.log` |
| Node / Web 类型检查 | 通过 | `output/legacy-release-typecheck.log` |
| 生产构建 | 通过，无 `out/main/mods-e2e.js` 测试入口 | `output/legacy-release-build.log` |
| `npm run dev`，显式隔离用户目录 | 主进程 / preload 编译、Vite 服务、Electron 本地页面加载和 5 秒存活检查通过 | `output/legacy-dev-smoke.log`、`output/legacy-dev-smoke-result.json` |
| 本轮变更定向 ESLint | 0 error | `output/legacy-release-lint.log`；另有 runtime / manager、MCP 定向检视 |
| 全仓 `npm run lint` | **未通过：100 error**，另有大量原有格式 warning | `output/legacy-release-lint-full.log` |

开发启动核验结束后已恢复生产构建，最后一次构建日志为
`output/legacy-release-restored-build-verified.log`，测试入口 `out/main/mods-e2e.js` 不存在。
上述 4 套补充事件 E2E 使用此生产构建，均无测试桥接入口。
Harness 两种开关状态的对照摘要：`output/legacy-release-harness-comparison.json`；
两边均为 3 次主模型调用、1 次 Goal 评估，分别保留 `checking-1`、`checking-2`、最终回复。

全量运行期间继续定位了最后一个宿主初始化问题；不是所有 5,203 项都在最后补丁后重新跑过。
该补丁及其调用关系随后重新执行 57 项定向回归，并在重新构建后执行上表最终 off / on 和 Flow
生产 E2E。真实 MCP 新测试在本轮全量发现测试文件之后加入，单独通过，不混入 5,203 项计数。

全仓 lint 的 100 个 error 分布在 48 个文件。47 个文件与共同基线内容一致（忽略 CRLF / LF）；
唯一有差异的 `AddHookDialog.tsx` 单独对基线及当前版本运行 ESLint，均为相同的 18 个 error。
因此这里确认的是“本轮没有新增这些 lint error”，不能写成“全仓 lint 通过”。机器可读证据：
`output/legacy-release-lint-errors.json`、`output/legacy-release-lint-baseline.json`。

开发启动的首次 smoke 失败属于夹具问题：精简 Windows 环境无法取得默认 appData，
electron-vite 会清空预设 CLI 参数，而 npm 透传的字面引号使显式 userData 路径无效。
6 个最小 Electron 探针对照排除了 `.` / 直接 JS 入口差异；修正参数后启动通过。
夹具还修复了 Vite ANSI 颜色码影响就绪判断的问题。没有通过修改 electron-store、
绕过产品初始化或使用日常用户数据来得到通过结果。诊断证据 `output/legacy-electron-path-probe.json`。
开发启动检查只验证启动；真实交互由上表的生产 E2E 覆盖。

## 性能与 Harness 效果的判断

已发现并修正的性能 / 行为退化是“空 Mods 图也消耗任务步数”，其影响不是仅多几毫秒，
而是相同任务会更早终止。修复要求同样的预算和模型 / 工具调用次数完成，不能靠提高上限通过。

其他性能约束测试覆盖上下文尾部、checkpointer reopen、fork 冷路径、子任务 transcript tail、
工具关联、scheduler tail、workflow history。UI 压测实际跑过 400 条 Agent 历史 + 30 帧更新，
60 个最大 workflow 快照，及 2,000 条时间戳虚拟列表；窗口 / 分页 / 导航断言通过。
日志中的耗时来自本机并行测试环境，不能作为与 UAT 比较的稳定延迟基准，也不宣称零开销。

开启一个真正改变提示词、工具、完成条件或模型的 Mod，本来就会改变任务行为和成本；
本次要求的是“不使用它时不破坏存量行为”，而非所有 DIY 组合都与旧模型回答完全相同。

## 仍存在的失败、覆盖缺口与分支差异

全仓最终剩余 11 项测试失败，三类如下：

1. 5 项 macOS JetBrains 测试在 Windows 主机上构造 POSIX `.app` 路径，未通过路径有效性检查。
   不以此判定 Windows IDE 入口故障，也不以此宣布 macOS 已验证；需 macOS 环境复验。
2. 5 项 Chrome 扩展 popup / service-worker 测试引用的 `chrome-extension` 源文件缺失。
   主应用浏览器测试不能替代扩展验收；扩展链路暂不能给出通过结论。
3. 1 项主题固定色规则发现 22 处原有违规。不是此次 Mods 新增，但深浅主题一致性仍有存量欠账。

外部企业 IM、真实模型业务回答质量、企业 gate 全 UI 路径、跨平台安装包与所有 Mods / MCP 组合
不在本机已执行证据内，不能笼统说“全部功能绝对正常”。

此外，开发分支和最新 UAT 不是同一功能基线。以下 UAT 后续提交没有自动并入本开发分支：

- `875f7dc5`：Windows 文件链接大小写 / UNC / file URL 修复。
- `a5d2cbe3`：右栏展开收起时的资源抽屉状态修复。
- `9b1080cb`：Bash First 工具策略。
- `af7dfb1b`：独立外观设置页（当前分支外观设置仍在原页面）。

上述文件在共同基线到当前分支没有被 Mods 删除相应能力；这是分支同步差异。
本轮没有擅自合并 UAT，发布前应在合流版本中再次验证这些差异。

## 管理口令移除

按前一条指令，已删除 Mods 设置管理口令及输入页。打开“自定义 → Function Mods”即可安装和设置。
应用默认关闭；安装不会自动运行，仍需应用开关、项目开关和当前插件版本授权。
可信窗口检查、项目范围、工具操作审批、撤权、内容保护和取消机制仍保留。
移除的是 Mods 管理口令，不是模型密钥、企业登录或其他认证。

相关测试保留不信任调用方拒绝、只读设置拒绝、版本授权、卸载失效及重启恢复；
兼容旧 preload 解锁接口仅返回设置可访问，不会启用功能或授予权限。

## 参考

- `docs/legacy-plugin-harness-review-2026-09-28.md`：另一位 agent 的独立检视、MCP 和模型流修复证据。
- `docs/mods-ux-guide-2026-09-28.md`：当前入口和免口令使用说明。
- `output/legacy-*`：本轮原始日志、JSON、截图与失败复现；这些是本地验证产物，不应提交到 Git。
