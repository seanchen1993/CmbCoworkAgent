# M01：beta 合入 integration 验收

2026-10-19。用户授权 root 负责设计与质量、gpt-6.1-sol/high 执行。源码审查与回归已通过，已正常合入目标分支；目标工作树安装依赖后的类型检查和完整构建也已通过。M01 验收完成。

## Git 交付

- 目标工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`。
- 目标分支：`codex/devclaw-bot-integration`。
- 原 integration：`d76f30201b8bca9cdf9d26daed1c710ce8c3c1aa`。
- 本次 fetch 后固定的 beta：`91554cbc7df0b78e37c48d31b72628c16662911a`。
- sol 候选：`bac6d2e7fdc6a0e83b36a3a99ba15260aeb460eb`，真实双亲为上述 integration 和 beta。
- root 目标合并：`f47861fec6b4748eae8c77f76c6b2a7bcffe7ee4`，保留 root 的设计和检查点提交。
- 已验证 beta 是目标 HEAD 的祖先；合并后全部非 docs 路径与验收候选完全一致。没有整树覆盖、squash 或强制改写历史。本轮新提交尚未推送。

## 保留与合并取舍

| 范围 | 验收结果 |
| --- | --- |
| beta 客户端 | 保留 BotsWorkspace、私聊/群聊、文件、浏览器接管、运行中补充、后台命令、计划及私有记忆路径。Bot 主进程、共享契约、preload、IPC 相对 beta 零差异；Bot renderer 仅增加预览禁用普通视觉提交的一行配置。 |
| integration 服务 | `services/bot-control`、`contracts`、`deploy` 相对原 integration 零差异，Java/MySQL、V1–V7、身份/权限/节点/Run/专家记忆及启动器均保留。 |
| 共享执行 | 逐项审查 runtime、AgentRunService、standard-thread-turn、IPC 和线程租约。保留 `sharedTaskContext`、个人上下文隔离、技能/专家白名单、需求模式配置，同时保留 beta capabilityService、附加工具、steering 和后台生命周期。 |
| 受限伙伴执行 | `partnerInputOnly` 继续选择独立执行体；未注册时拒绝，不回落到个人或 Bot 全工具 runtime。fake-model DeepAgent 测试验证零工具和线程隔离。 |
| 页面与生命周期 | 同时保留 Bot 工作区及需求/设计入口；两套 IPC/preload 注册、活跃检测、退出清理均存在。队列中的需求 contextLabel 和 beta botReplyTo 同时保留。 |
| 构建与依赖 | 保留双方资源和构建入口，合入 TipTap/Presence 依赖及原 AJV；lock 根版本与 package 的 1.5.3 对齐。加密 `.env` 沿正常合并保留，未解密；验证用独立 mode，不加载真实环境配置。 |

10 个文本冲突文件逐项处理后，root 又检查了自动合并代码。具体命令、取舍和初轮失败记录见 `../attempts/M01-sol.md`。

## 审查发现与修复

1. **Bot HTML 预览误获普通执行入口。** integration 的 FileViewer 原先只要存在 threadId 就启用视觉编辑，beta 新增的 Bot 预览调用方因此可能直接普通 stream.submit，绕过 Bot 队列。新增显式 `visualEditPolicy`，默认关闭；普通工作台入口明确启用，Bot 明确关闭。提交 hook 在渲染和实际点击时检查 Bot/Partner 持久标记，线程信息缺失时拒绝；普通和需求会话仍可使用。真实 React/FileViewer/HtmlPreview/hook 的隔离 Electron 回归验证按钮与实际提交次数，包含渲染后身份变化。此修复关闭合并引入的预览路径，不代表已完成所有历史 IPC 入口的长期所有权治理。
2. **ES 旧测试断言落后于 beta 实现。** 初次 root 专项为 67/68。保留当前生产聚合，仅将旧 `main_agent_conversations` 断言更新为实际 `legacy_conversations`/`stage_duration`，验证主 Agent、新旧耗时互斥及映射缺失 fallback；最终 69/69。未删用例或改统计口径来消除失败。
3. **旧 IM 退役协议检查误匹配 Bot 浏览器接管。** 检查改为 IM 路径的 takeover 和跨模块 device-takeover 协议名，并添加允许 Bot 浏览器、拒绝旧 IM 协议的例子。仍保留旧设备路由退役要求。

## 验证证据

测试范围有重叠，不将下表相加作为全量覆盖数。全部使用受支持 Node 22；本轮没有调用真实模型、生产 ES 或内网。

| 执行者 | 验证 | 结果 / 日志 |
| --- | --- | --- |
| root | `node deploy/dev/service/build.mjs` | 69 JUnit、1884 契约一致性样例零失败/差异，打包探针和产物审计通过；`/tmp/m01-root-java.log`。源码与候选完全相同，未声称重新编译所有缓存文件。 |
| root | `node --test --test-concurrency=2 tests/bot/service/*.spec.mjs` | 65/65；`/tmp/m01-root-service.log`。 |
| root | `node tests/bot/check-contracts.mjs` | 24/24，包括 schema、离线引用、生成漂移和类型消费；`/tmp/m01-root-contracts.log`。 |
| root | requirement-executor、task-thread-store、personal-context、expert-memory、expert-controller、partner-local-worker | 50/50；`/tmp/m01-root-partner.log`。 |
| root | 实际 React/Chromium Partner 面板，fake IPC | 通过；`/tmp/m01-root-panel.log`。 |
| root | ES 8 文件专项 | 69/69；`/tmp/m01-root-es-final.log`。初始失败保留在 `/tmp/m01-root-es.log`。 |
| root | 新预览实际 Electron 回归 + guard/预览隔离 | 浏览器通过、18/18；`/tmp/m01-root-visual-browser.log`、`/tmp/m01-root-visual-tests.log`。 |
| sol | Bot 主进程/契约/IPC；Bot UI 与 standard-turn | 337/337；229/229。 |
| sol | Partner 13 文件；需求安全/IPC | 106/106；54/54；需求技能/历史/凭据脚本均通过。 |
| sol | 桌面 baseline、IM V1 | 7 个入口、19 个入口均通过，含模拟招乎旅程。 |
| sol | 共享 shell/后台/编排 6 文件 | 206 通过、1 原有 Windows 专用用例在 macOS 跳过。初次 PATH 缺 prettier 导致失败，修正测试环境后全组通过；相关源码与 beta 一致，未修改生产逻辑。 |
| sol | 实际 Electron 引擎、native browser host、进程异常恢复 | 通过，包括真实 SIGKILL、SQLite 重启与队列/计划去重，使用临时 profile。 |
| sol | 修复后 Node/Web typecheck、完整隔离构建 | 均通过；`/tmp/M01-typecheck-preview-final.log`、`/tmp/M01-build-preview-final.log`。普通构建此前也通过。 |
| root | 目标工作树安装后的 Node/Web typecheck、普通完整构建 | 均退出 0；`/tmp/m01-root-target-typecheck.log`、`/tmp/m01-root-target-build.log`。安装 43 个公开包、不运行 install scripts；仅恢复 npm 改写的 5 个 peer 和 1 个 devOptional 标记，版本和解析地址与已审 lock 相同。 |
| sol | 视觉编辑与 stage 5 文件 | 28/28，新增实际 Electron 回归通过；`/tmp/M01-visual-stage-final.log`、`/tmp/M01-preview-visual-browser-final.log`。 |

以上不是 `npm test` 全仓所有测试的声明。Java 本轮没有连接真实 MySQL 做迁移升级验证；服务和迁移源码未改变，已有历史实库证据仍保留，不能当成本轮重新执行。

## ES 性能审查

beta 随带的评奖与阶段统计也纳入评审。查询先核对评奖权限并在 ES 应用时间、项目/技能等对应范围，以 `size: 0` 聚合和索引统计字段返回结果，不分页下载完整 Trace、上下文或 `_raw` 求和。

- 技能贡献每批 100 个候选，同时最多两个批次；每批 Trace/Event 两个独立请求，所以单次该查询最多 4 个并发 ES 请求。
- Composite 每页 500 个桶，跟随 `after_key` 读取全部候选；重复游标、超时、失败分片、缺失聚合拒绝返回不完整统计。没有通过 top-N 静默截断替代全量计数。
- 团队比较的 8 组 composite 查询按最多两个并发执行；用户应用三组独立聚合最多三个并发。上述是各调用内上限，不是所有页面同时刷新的全应用全局限流保证。
- 专项覆盖超过旧容量的用户/技能/事件、多个版本合并、主子 Agent 及新旧 stage schema；更新的断言还验证新旧耗时互斥及映射 fallback。

这些是源码结构和 fixture 的验证结果，没有生产 ES 大数据实测，也不承诺具体延迟改善。

## 交付边界与下一步

本次完成代码合并与兼容基础。beta 仍由本地 LocalBotHost 执行，尚未接成 Java 服务管理的 Bot；不能把本次 merge 描述为端到端功能融合已完成。

下一步建议按已讨论功能设计做首个纵向流程：在 beta 私聊交办工作，关联同一个服务 Task/Run，通过已授权节点执行并回传结果，在会话任务卡中展示真实状态。先明确 Bot/会话/业务 Task/一次执行之间的映射、幂等发送和授权检查，再扩展成果版本、确认/退回修改、群协作收束、例行任务记录及需求到设计交接。

私有记忆与正式专家知识仍独立；自动知识采纳尚未接通。既有预览启动器 Ctrl+C/相对路径等 WIP 没有因合并变成已验收能力。真实服务启动、用户 profile、数据库和暂停的自动任务未被本轮改动。
