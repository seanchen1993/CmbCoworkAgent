# M05-04/05 渠道模拟与旧链路清理验收

状态：2026-10-20 用户恢复实施；尚未接受新候选。起点为实施分支 `dd12f43f`，保留已验收的本机对话关联。root 设计与验收，原 6.1-sol/xhigh 唯一产品写者。本文记录此次证据，不覆盖以前的验收历史。

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

## 最终验收待补

- [ ] M05-04 实际 App 全流程、分页/迟到响应、权限及恢复检查点。
- [ ] M05-05 拆线、只读历史和导出、无旧 worker/默认引擎启动证据。
- [ ] 实际旧数据副本升级/重开前后记录不变，普通 Bot 和本机对话关联回归。
- [ ] 受影响 beta、生产 IM V1、Runtime/hook、Node/Web 类型与隔离构建。
- [ ] 简化审查、候选冻结、root 独立复验和正常集成。
- [ ] 备份后更新用户同 profile 预览，核对原任务、消息、目录及模型配置。
