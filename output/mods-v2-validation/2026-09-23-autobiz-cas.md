# Autobiz CAS 修复验证 — 2026-09-23

- 目标：修复旧指纹检查后 `replace` 的 TOCTOU，阻止伪收据和未归属目标状态被算作 duplicate。
- 基线：`2026-09-23-autobiz-cas-red.log`，5/5 失败（12.51 秒）。
- 实现后联合：`2026-09-23-autobiz-cas-tests.log`，CAS 12 + validator 8 + 真实 completion guest/session 9，29/29 通过（43.27 秒）。
- 最终联合：`2026-09-23-autobiz-cas-tests-final.log`，CAS 16 + validator 8 + completion 9，33/33 通过（33.59 秒；与打包/其他验证并发，不是性能 SLA）。包含 unknown 原操作定位、仅核验收据时绝不执行新推进，以及 unsupported platform 拒绝。
- 补充红测：`2026-09-23-autobiz-cas-operation-red.log` 的 2 项原操作 ID 断言失败；`2026-09-23-autobiz-cas-duplicate-only-red.log` 复现缺宿主收据时误推进。均在最终联合结果中转绿。
- Node typecheck：第一轮按项目命令 `npm run typecheck:node` 通过。最终轮见 `2026-09-23-autobiz-cas-typecheck.log`，本批文件无错误，但并发 `ipc/mods-configuration.test.ts:24` TS7030 和 `v2/manager.ts:12` unused createHash 导致整项未通过，已通知主代理处理。早期误用没有 `--composite false` 的裸 tsc 报跨项目 TS6307，已改用项目命令。
- ESLint：本批 8 个 TypeScript 文件，0 errors / 0 warnings，见 `2026-09-23-autobiz-cas-eslint.log`。
- 只使用临时 workspace 和临时应用数据根，固定上游源码只读提取。未触碰 UAT 或真实用户 Autobiz state。

已实测 Windows 本地 NTFS：锁前 writer 和 writable mmap 拒绝；锁后新 writer、state rename、`.autobizdevops` rename、workspace rename 拒绝；宿主 readFile 继续可用。正常提交复用真实 upstream prepare 和私有 snapshot writer，并逐字节比较输出。

故障回归以真实 Python 子进程在 ACK 后退出、写完 JSON 后退出、ACK 后阻塞超时模拟断链/部分写入；写完两份文件后的 AbortSignal 撤权仍返回 unknown。重新打开 SQLite、新子进程和不同 key 均不能消除 unknown。没有盲目 rollback，也没有自动 partial 恢复。

独立只读代码审查由 classic hooks 子任务执行：未发现 ACK 协议、pending 阻断或锁内写入路径的 false PASS；审查指出状态锁没有覆盖整个 workspace，已列为明确边界。主代理另发现 ledger 重复分支需要 requireCommittedReceipt，仅核验模式已通过先红后绿修复。

关闭模块对照由真实 completion integration 的相同临时任务 off/check 两次结果覆盖。性能只记录进程链路测试耗时，未将其误称为关闭状态开销基准。Electron E2E、打包应用和最终统一性能检查由主代理在最终快照执行；本文件不提前声明它们通过。

范围差异见 `docs/mods-v2-autobiz-state-cas-2026-09-23.md`：两份文件不是物理原子事务；状态锁不冻结需求/代码等整个工作区；unknown 恢复仍明确阻断；本批合同 fixture 不等于最终真实业务验收。

## 主工作树收口复核

2026-09-23 23:30：上述两个类型错误均已修复，最终 Node/Web检查通过；
Mods32 170文件1275项通过（含CAS16项），Electron31通用桌面回归156项通过且普通out恢复。
该Electron回归覆盖原应用/授权/取消/完成循环，不冒称其已经覆盖真实业务checkpoint推进。
关闭同路径p95本轮+7.2354%超过5%阈值；正式性能未通过。
真正业务演示、整个Electron进程重启后的未知提交恢复操作、应用内自动推进入口仍须继续实现。
