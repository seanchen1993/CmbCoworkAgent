# M05-04/05 渠道模拟与旧链路清理验收

状态：2026-10-20 最终候选 `bbe06f47862894550d50c7a4b62dbfe741cc23cf` 已由 root 验收，正在正常集成与同 profile 预览更新。渠道主路径、撤销后失回执出口、默认旧链路清理及审查返工均通过。用户明确“不用管旧专家的数据”，取消历史查看、导出和迁移。起点为实施分支 `dd12f43f`，保留已验收的本机对话关联。root 设计与验收，原 6.1-sol/xhigh 唯一产品写者。本文记录此次证据，不覆盖以前的验收历史。

## 范围

- 模拟个人/群入口使用真实本地 Bot、Thread、Runtime、SQLite，验证问答、任务、修改、完成/继续及原渠道回传。
- 核对可信绑定、来源/受众、群提及/引用、去重、离线、撤销、未知送达和权限隔离。真实 IM、LF39 合仓与生产授权仍延期。
- 拆除旧专家服务的 App 启动、活跃运行检测、退出、IPC/preload、专用界面及默认 input-only 引擎接线。保留 beta 原 requirements、工具、审批和其余能力。
- 不处理旧专家数据，不新增只读历史、导出或迁移；默认 App 不构造旧 Store、恢复或重放旧执行。旧表/Java 数据不主动删除，必要历史协议源码仍保留至后续合仓。
- 运行中的用户预览由 root 独占维护。实施者仅使用隔离 profile、localhost 模型及独立构建目录；不调用真实模型。

## 历史：初步核对（旧数据事项随后取消）

1. `mock-channel.test.ts` 8、`mock-runtime-policy.test.ts` 1、`standard-thread-turn.test.ts` 8，共 17 项独立检查通过，日志 `/tmp/m05-04-root-baseline.log`。仅作为当前基线，不代表真实 App 旅程或最终候选已验收。
2. 初审发现模拟弹窗保留首轮历史游标、后续仅合并最新 40 条，新增消息超过页容量时可能形成不可达缺口；已要求复现和修正连续分页。恢复 interrupted 记录的无界查询也需检查。
3. 当前预览库保留旧 service 表：conversation 2、task 3、request 7、execution binding 7、delivery action 4、delivery summary 1、expert input 5、expert summary 3、expert action 2。无需连接 Java 或复制其他用户 profile 才能展示历史。
4. 已用 SQLite backup 建立 root 私有验收副本 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-05-legacy-readonly-x5sh1stx/legacy.sqlite`，`quick_check=ok`，同目录 `proof.json` 记录逐表行数和内容哈希，不含正文。副本无 WAL，关闭后 immutable 只读校验；原运行库不使用 immutable。
5. 初步源码确认仍有 `registerPartnerDevHandlers`、`hasActivePartnerDevRun`、`stopPartnerDev`、preload 旧 API 和 `registerPartnerInputOnlyRuntime`。不能仅删除可见入口就宣称旧运行链路已清理。

## 04 检查点证据

- `94fb4fe94f0206d91f84d66dfec7f98d7db52438` 的真实隔离 App 旅程通过，日志 `/tmp/m05-04-app-final-queued.log`：12 次 localhost 固定模型调用，个人问答、真实工具建任务、桌面修改回原渠道、完成/继续、离线恢复、群提及和同群引用、撤销取消待执行、普通 Bot 工具与 hooks 保持。此证据不是生产 IM 联调。
- root 独立执行 mock、策略、hook、实际工具白名单、标准 Runtime 及 IPC 六文件，37/37，`/tmp/m05-04-root-final.log`，exit0。实施者另有193项受影响核心及 Node/Web、独立正常构建，精确记录在其 attempt。原生 invoke/resume/interrupt 拒绝通过已有通知通道结束，未产生消息、Task 或模型调用。
- 弹窗171条历史、末页、突发消息超40、迟到旧页及切绑定检查通过。恢复查询采用一次高水位及稳定 id 游标，单批40条元数据，105条实际40/40/25；EXPLAIN 使用部分索引，批间让出事件循环。只报告结构性优化和本地测试，没有 ES 改动或生产耗时数据。
- root 已跑生产 IM V1 全部19个脚本，均 exit0，报告 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-root-im-regression-szpp3l2n/report.json`。仅 localhost/隔离 profile；Java/MySQL/真实模型未启动。
- 后由 `9130de36a` 修复并通过 Store10项与真实弹窗检查：已持久事件的回执丢失后若绑定撤销，不应永久锁住 Bot 其他模拟渠道。允许 owner 按完整事件标识与 fingerprint 只读核对旧回执；没有旧回执仍拒绝新事件，不能盲重发。明确未落盘的撤销事件需显式结束核对出口，保留记录，不能自动清除未知状态。

## 最终验收待补

- [x] M05-04 主路径、失回执与撤销组合通过；最终审查边界见下方。
- [x] M05-05 拆线、冗余 UI/API 删除、无旧 worker/默认引擎启动证据。
- [x] 普通 Bot 和本机对话关联回归；旧数据专项验证已按用户要求取消。
- [x] 受影响 beta、生产 IM V1、Runtime/hook、Node/Web 类型与隔离构建；最终窄修另补影响范围检查。
- [ ] 简化审查、候选冻结、root 独立复验和正常集成。
- [ ] 备份后更新用户同 profile 预览，核对原任务、消息、目录及模型配置。

## 1caeee24 候选独立复验与审查返工

- root 扩大回归65文件623项通过，独立 profile、并发2，日志 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-root-beta-final-sa0r_2uf/vitest.log`，同目录 manifest 列出精确范围。桌面 baseline 与默认依赖断链共8脚本：7项首次通过，旧架构断言固定9处 parser 与新增受管保护不符；更新为准确10处并检查保护内 parser/work/mock 三条后，root 单独复验 `/tmp/m05-05-root-standard-architecture.log` exit0。
- 最终隔离 App `/tmp/m05-05-app-final.log` exit0，12次 localhost 固定模型调用、12次仅 owner hook；真实 preload 不再暴露两个旧 API。1250个 App 可达模块中旧 services/bot 为0，正常 Bot、requirements 和生产 IM 仍可达。实施者 Node/Web、正常独立构建及旧生命周期10项通过；精确命令见 attempt。
- root 已读宽明、窄暗与模拟弹窗截图，统一 beta 布局、右侧任务和来源提示保留。窄暗图有关闭设置菜单的动画残影，只作为布局证据，不冒称无动画过渡；用户同 profile 预览尚未升级。
- 按 simplify 的复用、质量、效率三视角只读审查同一完整 `dd12f43f..1caeee24` diff。没有收益足够的抽象/风格重构；两个真实问题已交原 sol/xhigh 唯一写者修复：
  1. **P2**：Host首批40条恢复后立即历史清理，可能删除超过30天、非最近100的尚未补回执记录。复用 `mockRecoveryComplete`，恢复完成后才维护；补实际 Host+过期积压回归。
  2. **P1**：mock消息改传原文后，首条 `[coordinator]`/`#coordinator` 会进入桌面模式提交并写坏后续 mock 所需 normal 模式；`/goal` 也会早于工具边界启动 Goal。保持消息原文，在可信 mock 策略下禁止消息触发桌面控制解析；原本机/生产 IM 默认不变。需独立实际 App 窄验证及后续普通消息可用证明。

上述为 `1caeee24` 审查时的返工决定，后续复验如下。

## 审查问题定向复验

- P2 已由 root 独立复验：3文件96/96，日志 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-root-repair-h8svso32/vitest.log`。实际 Host 泵恢复105条31天旧 interrupted，另有100条新终态；首次真实历史清理之前105个回执已全部落盘，随后按原保留规则清理100条旧Task，未调用Runtime或发送端。原每批40和索引策略保持。
- P1 在 `4cdadbae` 已通过：root 独立5文件69项及 Goal/coordinator/两架构脚本4项均 exit0，报告 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-root-controls-0k02it8_/report.json`。实际 App 窄旅程 `/tmp/m05-05-controls-app-second.log` exit0：3个空渠道的两种 coordinator 前缀、/goal 及各自后续共6次外部调用，原文保存、normal 模式、无 Goal/额外 Task、仅5工具；普通 beta /goal 状态命令仍处理且不调模型。加 owner 初始调用共7次 localhost 调用。第一次仅正例夹具误用 API 参数，修夹具后通过，不隐去失败。
- 窄复核另发现保留内部协议串被通用历史过滤，最终 `bbe06f47` 复用既有过滤判定明确拒收，普通 /goal 和 coordinator 前缀继续接纳。主进程与弹窗共享纯校验：新消息先验证再保存 pending；原 pending 不凭错误字符串清除。root 两文件13项和默认依赖断链均通过，报告 `/var/folders/kq/m0q4z3m91tx9fpfbf501hfrr0000gn/T/m05-root-text-final-43nkrvdp/report.json`；最终1251个可达模块，旧服务0，正常 Bot/requirements/IM 保留。
- 实施者最终实际弹窗 `/tmp/m05-05-shared-validation-dialog.log` exit0：171条连续分页及 lost-ack/撤销/结束核对/重挂保持，保留标记与附件/技能四类无效输入均无 inject/pending，仍可编辑后正常发送。最终 Node/Web 与正常 main/preload/renderer 隔离构建通过；没有再重复7/12次模型旅程。
- 最终构建 `/tmp/m05-05-controls-out-6f0cuab0`，证明 `/tmp/m05-05-shared-validation-build-proof.json`；application SHA256 `b6306a4aad47714c586cc1c454735ef99239a62d7b01a8464c19ed8eeeb6f786`，无测试入口。前面的623、96、69、13等存在重叠，不相加宣传总量。
