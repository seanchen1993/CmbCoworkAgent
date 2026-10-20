# M05 验收记录

2026-10-20 UI优先切片：`a81b5f455` 已由root审全部五个renderer文件；去旧service左栏/hook/专属会话分流与伙伴设置入口，旧选择安全回退，右侧统一“独立任务”。实施者Node/Web与隔离build exit0；root原生CUA实际显示新Bot界面并置前供用户查看。本轮没有功能测试/模型旅程，不能标记M05功能完成。旧主进程链和历史数据保留，后续功能验证仍暂停。

2026-10-20 用户要求先看当前UI，功能验证与实施暂停。clean WIP `a33259483` 尚未验收；已有out已打开独立预览供用户检查，原用户窗口/数据保留。完整mock旅程修改结果显示仍有超时，不把已显示的UI称作闭环通过。

状态：未验收，设计与任务单已根据用户最新决定更新。M04 首轮候选虽已集成，不代表本轮统一 UI/本地体系完成。

## 设计基线

- 用户要求 beta 所有功能保留、仅扩展，本地数据/Runtime 为权威；独立工作放右侧，统一中间 ChatContainer 和右侧 Bot 详情。
- 后端允许 mock，LF39 真实接入、Java 精简合仓和平台联调延后。
- 设计：`M05-beta-local-unification-design.md`；清单：`../tasks/M05-beta-local-unification.md`。

## 待验收

- [ ] beta 能力保留矩阵完整，现有模型/历史/文件/记忆/例行任务无损。
- [ ] 右侧任务/统一 UI，真实工作与逐次执行分离。
- [ ] 主对话创建/转达、任务修改/完成/继续、结果/文件交付。
- [ ] 主对话与工作并发、共享资源边界、范围与上下文隔离。
- [ ] 持久恢复/去重/未知状态/失败重试和迟到回包。
- [ ] mock 渠道明确标识，真实本地链路和原渠道回传，生产 IM 回归。
- [ ] 不依赖 Java/MySQL；旧 App 双链路已收敛，旧数据保留。
- [ ] root 独立源码/关键测试/实际 App UI 与演示验收。

## 接口审查

root 已完整阅读原实施者 `edbcc351` 检查点（十五项 beta 能力保留矩阵、七组接口/调度/隔离方案），批准按设计第 10 节实施。关键收敛：既有主 thread 不变、目标贯穿全部能力、固定 thread 跨库恢复、不增加执行硬并发、外部 mock 仅文字/工作指令、本机完整 beta 能力保留、旧 journal 只读归档。此处仅设计审查，不勾选产品验收。

完成/停止归属已补充到设计：动态后台只作用于自己的工作 thread，协作前台/回传按 rootWorkId、shell 按 source_task_id 精确匹配；不扫描历史协作 Bot 的整个主 thread。待核验两个回归：无关后台不阻止完成；停止原工作不影响无关后台。协作 Bot 返回后独立启动的 workflow 仍归其主对话，本轮不提供跨 Bot 后续后台聚合。

## 事实与资源

### root 本地切片独立验收（整体 M05 尚未完成）

冻结候选 `3af3c2e993a0c6391e5f73066014887a8f365743`，正常合并 `cbfa823900f70f047dbc4a8351c49c5118bd0b1e`。合并后的 src/tests/package 与候选无差异；没有推送。源码审查发现并修复的最后问题为新增 work 转达未限制当前用户来源，现通知/例行/协作结果无法追加工作指令；既有协作能力保留。

- Node22核心27文件375/375，`/tmp/m05-root-local-core.log`；renderer/shared32文件231/231，`/tmp/m05-root-local-view.log`。两组少数文件重叠，不累加宣称独立数量。
- Node/Web类型与空envDir完整build通过，`/tmp/m05-root-local-node.log`、`web.log`、`build.log`。
- root自行运行真实App/preload/IPC/SQLite/Runtime/ChatContainer夹具通过，`/tmp/m05-root-local-app.log`。12次localhost固定provider调用；实际工具创建、真实文件审批/交付/预览/修改、等待期间主对话响应、完成/继续同thread、草稿和错误/迟到资源目标隔离。未调用付费模型，不是生产IM验证。
- 真实hook/右Panel目录夹具通过，`/tmp/m05-root-local-directory.log`：45项9次摘要list、最大补批5（硬上限40）、同时list1；另含7项无cursor展开与迟到/失败选择。无逐任务正文读取、无ES改动，不宣称生产实测耗时。
- 最终明/暗主题与文件预览已目视，新增区域沿用beta tokens。完整窄窗/迁移旧数据/真实模型演示与旧默认worker移除仍待M05-05；不得用当前截图中尚存旧Service入口宣称UI全部统一。
- 测试自有Electron、localhost provider及临时profile均退出/回收；Java/MySQL未启动、用户预览未升级。M05-04已放行，同一写者继续mock，M06真实后端仍延后。

### M05-04 实施中（2026-10-20，未验收）

`5dad1a2f` 为保全 WIP，产品继续写入，尚未 freeze。实施者报告 `/tmp/m05-mock-store-wip.log` 24/24、`/tmp/m05-mock-node-wip.log` exit0；不等于 root 独立验收，也不含模拟弹窗/实际App闭环。root 已审早期来源、引用和投递策略，继续检查 owner 未读汇总及 Runtime/hook 默认行为保留。真实后端与用户预览未改。

### 实施中检查点（尚未验收）

原实施者保存 WIP `358eaf689`，30 文件含 8 新文件，并继续实施；不是冻结候选，不集成。实施者报告核心/IPC/Runtime 25 文件、346/346 检查通过（`/tmp/m05-work-read-tests.log`），Node/Web 类型通过（`/tmp/m05-node-read-scope.log`、`/tmp/m05-web-read-scope.log`）。包括主/工作精确已读和批量确认的迟到版本边界。root 已做来源/目标/并发/后台边界早审，但尚未对该检查点独立复验或实际 App 验收。动态 workflow/coordinator 完成门禁、真实 UI、mock 与旧路径清理仍在后续工作中。

### root 改动前基线（2026-10-19）

integration 产品 `b479d51d`（后续仅文档提交 `3852c709`），Node 22 运行 `vitest run src/main/bots src/main/ipc/bots.test.ts`：21 文件、317 测试通过，exit 0，日志 `/tmp/m05-root-beta-baseline.log`。这是既有功能单元/组件边界基线，不代替新增任务、实际 UI 或最终能力矩阵验收；未调用真实模型/网关。

补充独立基线：`vitest run src/renderer/src/lib/bot` 29 文件、222 测试通过，日志 `/tmp/m05-root-beta-view-baseline.log`；shared bots file-delivery/client-registry 与 IPC bot-files 3 文件、18 测试通过，日志 `/tmp/m05-root-beta-ui-baseline.log`（名称含 UI，但实际仅三组边界测试）。合计 557 项现有检查，无真实 App/原生界面验收声明。全部句柄退出 0，无用户 profile 或服务变更。

原写者已保全五文件 M04 dirty 为 `9e83c3048`，在 `codex/beta-local-unification-m05` 正常合入设计文档后 HEAD `8545a4ea`，初始 clean。M05-01 接口/能力矩阵 `edbcc351` 已审，正在实施 M05-02/03，尚未收到冻结产品候选。

网关本机工程已定位并只读核对 HEAD `e744c6d7`，现有 `Dockerfile`/`README.md`/`pom.xml` 用户改动保持原样。网关当前明确忽略群消息，不宣称群平台已打通。原实施树五个未提交 M04 修复保留；本轮不接管用户预览，不恢复自动续跑，无真实平台/内网/推送/部署。
