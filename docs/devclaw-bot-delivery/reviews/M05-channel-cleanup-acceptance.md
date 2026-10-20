# M05-04/05 渠道模拟与旧链路清理验收

状态：2026-10-20 用户恢复实施；`94fb4fe9` 的渠道主路径检查点已独立复验，撤销后失回执的恢复出口正在补齐，随后继续旧链路清理，尚未最终集成。起点为实施分支 `dd12f43f`，保留已验收的本机对话关联。root 设计与验收，原 6.1-sol/xhigh 唯一产品写者。本文记录此次证据，不覆盖以前的验收历史。

## 范围

- 模拟个人/群入口使用真实本地 Bot、Thread、Runtime、SQLite，验证问答、任务、修改、完成/继续及原渠道回传。
- 核对可信绑定、来源/受众、群提及/引用、去重、离线、撤销、未知送达和权限隔离。真实 IM、LF39 合仓与生产授权仍延期。
- 拆除旧专家服务的 App 启动、活跃运行检测、退出、IPC/preload、专用界面及默认 input-only 引擎接线。保留 beta 原 requirements、工具、审批和其余能力。
- 旧本地记录只读分页查看/导出，不构造旧 Store，不建表、迁移、恢复、联网或重放历史。原表、Java 数据及必要历史协议源码保留。
- 运行中的用户预览由 root 独占维护。实施者仅使用隔离 profile、localhost 模型及独立构建目录；不调用真实模型。

## 初步核对

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
- 仍需窄修：已持久事件的回执丢失后若绑定撤销，不应永久锁住 Bot 其他模拟渠道。允许 owner 按完整事件标识与 fingerprint 只读核对旧回执；没有旧回执仍拒绝新事件，不能盲重发。明确未落盘的撤销事件需显式结束核对出口，保留记录，不能自动清除未知状态。

## 最终验收待补

- [ ] M05-04 主路径已过；补失回执与撤销组合后冻结。
- [ ] M05-05 拆线、只读历史和导出、无旧 worker/默认引擎启动证据。
- [ ] 实际旧数据副本升级/重开前后记录不变，普通 Bot 和本机对话关联回归。
- [ ] 受影响 beta、生产 IM V1、Runtime/hook、Node/Web 类型与隔离构建。
- [ ] 简化审查、候选冻结、root 独立复验和正常集成。
- [ ] 备份后更新用户同 profile 预览，核对原任务、消息、目录及模型配置。
