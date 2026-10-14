# DIY Claw 核心能力交付与验证记录

日期：2026-09-27。实现目录：`C:\ai\CmbCoworkAgent-mods-v2`，分支：`codex/mods-v2`。保留了本轮开始前的未提交改动，没有在 UAT 上继续开发。

## 达到的效果

本轮的主要目标已经实现：用户可以从 Autobiz 模板出发，在独立的「DIY 流程」页面启用/关闭步骤、调整顺序、选择每个 Agent 的角色和模型、配置通过/不通过条件和有界失败回退、增加人工确认，直接启动保存的版本并查看真实执行记录。

流程由原生宿主推进，不依赖聊天主模型重新解释编排。原生检查返回业务结果，失败会进入指定修复或停止；人工拒绝与取消终止。末尾检查、应用强制规则和人审通过后，Autobiz 使用实际上游校验与原生 CAS 提交一个合法 checkpoint。最终检查的新结果进入业务记录，修复或外部改动使旧证据失效。

真实 Electron 对照已证明 A→B、B→A、只启用 B 对应不同的实际模型请求顺序/数量；不是仅界面标签变化。

## Claude Code 调研与借鉴范围

独立取得并验证最新 `2.1.283` Windows x64 二进制，提取 2368 个嵌入模块，解压可读资源并检查分派、worker、journal 和类型声明。二进制、版本、哈希和关键位置见[审计报告](mods-v3-claude-2.1.283-audit-2026-09-27.md)。全局 Claude CLI 未被这次分析覆盖安装。

借鉴的是注册/分派、受控继续、真实执行身份、作用域、撤权、日志与恢复边界。没有把提取的上游实现复制进产品。最新声明还新增了本轮未扩围实现的 SDK 表面；现有插件兼容 profile 保持原声明。本次交付是业务 DIY 能力完成，**不是 Claude Code 2.1.283 全量 SDK/API/UI 一比一兼容声明**。官方是否提供同款通用可视化流程编辑器，现有证据不能证明。

## 双评审

方案第一轮由 `mods_compat_review` 和 `mods_perf_ux_review` 提出阻断项；补充提交顺序、真实 authority、产物绑定审批、修复后证据失效后，两位均明确通过，随后开始实现。

代码阶段两位继续交叉检视。已修复的主要发现：

1. 最终规则通过前不能提交 checkpoint。
2. 已失效但实际执行过的检查仍需最终复检，条件未选/禁用检查不能偷偷执行。
3. 成果变化时拒绝依然立即终止；旧 PASS 不能驱动新条件。
4. 最终验收结果需要进入业务记录及确认摘要；尾部人审在最终检查后只问一次。
5. 实际子 Agent 需要真实内部线程和独立租约；任务目录过滤明确内部标记。
6. 单个子清理失败不能跳过其他子资源和父资源撤权；清理前后校验身份，不误关替代线程。

最后两位均明确通过，无剩余代码阻断。低成本但重要的边界均有故障注入/回归测试。

## 验证结果

| 范围 | 实际结果与说明 |
| --- | --- |
| Node/web 类型检查 | `npm run typecheck` 通过 |
| 生产构建 | `npm run build` 通过 |
| 新核心回归 | `npm run test:mods:flows`：8 文件、74 项通过；包含 schema、状态机、存储、真实 adapter、IPC、严格模型/重试、拒绝回调、内部线程目录 |
| 新文件 lint | 新流程代码/测试及 user-input 变更检查 0 errors、0 warnings；全量旧 runtime/workflow 源文件仍有既有格式警告，未全文件重排 |
| 浏览器交互 | 5 组通过：增删/复制/排序/校验/版本、旧请求隔离、nonce操作、监听收敛、审批导航和大列表 |
| 生产 Electron E2E | 7 组通过，真实 React/preload/IPC/Agent runtime/文件工具/业务脚本/上游 validator/CAS；模型服务是本地受控协议 fixture，不是远程真实 LLM 能力评测 |
| 全库 Vitest | Node 22、`--maxWorkers=2`：4860 项中 4829 通过、26 失败、5 跳过。按完整测试名比较上一份基线，无新增失败；随后增量修复由最新 74 项核心回归覆盖 |
| standalone 测试 | 对 npm test 的命令拆开执行，避免已知失败截断后续；77 命令首轮73成功4失败，另4条已单独通过、3条 Vitest 命令已包含在全库测试中；复核见下文 |
| 既有 workflow | engine 96 项、worktree 66 项通过，旧模型 fallback 和原重试行为保留；desktop-agent-baseline 命令通过 |
| 包结构 | 新 Autobiz ZIP 生成成功，`plugin check` 返回 valid:true、14 个注册、diagnostics为空；包检查不等于业务验收或自动授权 |

生产 E2E 7 组的具体结果：

1. 指定 A/B 模型分别进入真实子 Agent；原始订单实现使业务单测失败，经 read/edit 文件工具修复后 7 项独立业务断言通过；禁用步骤没有模型请求。
2. React 显示人工等待，点击同意后完成；运行有最终原生重验记录。
3. 第二次走通过路线跳过修复；取消等待不继续执行。
4. A→B、B→A、仅 B 的真实请求顺序和数量与保存版本一致。
5. 应用强制单测失败时，没有人审通过记录，checkpoint 未变化。
6. 真正的固定上游 Autobiz 编译/验收通过，确认后只有一次成功状态提交。
7. 完整退出重启后流程版本及完成记录保留，没有自动重放 Agent 或提交。

## 保留的历史失败及额外复核

26 项 Vitest 失败与[此前逐项说明](mods-v2-existing-failures-confirmation-2026-09-26.md)一致，涉及 Windows 路径/socket/macOS mock、旧静态断言、IM命令匹配和缺失扩展源码。没有删掉、跳过或改松这些断言来制造全绿。

standalone 首轮需区分具体原因：

- `local-sandbox-worktree-isolation` 在继承 PowerShell 时执行 Bash 专用 `pwd -W`/`printf` 失败。显式使用已安装 Git Bash 原样重跑通过；产品文件未为此修改。
- `sandbox-elevated` 新增的一项静态匹配失败源于 `singleAttempt` 预算变量重构。正式测试已同步检查“默认仍用原 MAX_RUNS，Flow 显式选 1”；重跑为 85 通过、2 个原有通知断言失败。
- `im-remote-approval`、`im-local-zhaohu-journey` 仍是原有失败。其业务链未被此次流程功能接入。
- 初次使用系统 Node 24 跑 Mods 相关 1384 项，3 个 AsyncLocalStorage 对照失败；用工程要求的 Node 22 重跑对应16项全通过，全库 Node22 运行中也通过。正式结论使用 Node22。

所以不能宣称整个仓库所有测试全绿。当前新增核心能力及其生产 E2E 已通过；已知历史缺口保留在报告中。

## 性能与存量影响

- 关闭 DIY 页面时不增加流程目录/运行查询及监听；聊天入口本身零 Flow IPC。编辑器按需加载。
- 100 个运行更新事件最多合并成两次当前运行读取，不重复拉整个目录、定义或历史；离开页面监听回到零。
- 64 步编辑器双帧响应 p95 最新复跑 **24.0ms**，低于100ms目标；256 条运行记录正常展示。
- 64 步、256 次有界执行的状态机/内存设置序列化总耗时 **333.4ms**，约 **1.30ms/次**；保存 p95 **1.84ms**、保留数据约89KB。该微基准不包含 SQLite 磁盘写、项目指纹扫描、模型与工具延迟，不能解释成端到端速度。
- 新模型严格选择、单次节点尝试、拒绝回调均通过显式可选参数启用，普通聊天/旧 workflow 默认保持原行为。
- 历史正式 TTFT p95 增量53.1ms超过40ms目标、长期内存尚未完成验收的结论没有被本轮微基准覆盖，不宣称已优化完成。

## 实操材料

优先阅读[一步步使用说明](mods-v3-diy-flow-hands-on-2026-09-27.md)。

- 新业务练习项目：`C:\ai\CmbCoworkAgent-mods-v2\output\mods-v3-demo\AutobizOrderDemo`。保留初始业务缺陷，可实际观察修复与单测变化。
- 新安装包：`C:\ai\CmbCoworkAgent-mods-v2\output\mods-v3-demo\package\AutobizDevOps_Plugin_Kanban_Mods.zip`。
- E2E 报告/截图：`output/mods-v3-validation/e2e/report.json`、`approval.png`、`complete.png`。
- 最新提取产物：`output/claude-code-2.1.283-analysis/`。
- 全库比较：`output/mods-v3-validation-baseline-comparison.json`；最终检查日志前缀 `output/mods-v3-validation-*`。

上述 output 材料是本机可复核产物，不提交第三方提取代码、用户数据或临时业务工程。可复现测试入口已加入 package.json：`test:mods:flows`、`test:mods:flows:browser`、`test:mods:flows:e2e`。

## 本轮明确不扩展的边界

普通本地项目、64步/256执行、单项目DIY互斥、有界失败回退、一次合法阶段提交是本轮范围。跨项目并发画布、任意表达式、断电后的自动恢复重放、全生命周期多阶段自治、完整2.1.283新增SDK表面仍未承诺。部分旧沙箱 soft error 可被模型归为业务失败；明确用户拒绝/取消与有类型宿主异常则终止。详细行为和操作限制已写入实操说明。
