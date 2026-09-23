# 无条件 Function matcher 的真实运行时快速路径

bootstrap 闭包导出 matcher 是否存在的不可变事实，宿主加载时复制无条件注册 ID。仅明确 hasMatcher=false 跳过 matcher RPC；旧 peer 缺字段和有条件 matcher 保持原行为，仍检验 generation、dispose 和 JSON 边界。不缓存可变 matcher 对象，也不信任调用者随后篡改 registrations。未新增 Claude API 兼容声明。

先 6 个失败测试（matcher-fastpath-red.log），后窄测 3 文件 30 tests 通过。真实 Electron utilityProcess/QuickJS 增加无条件 32 次匹配、动态 matcher 改值及 dispose 检查，共 40 checks 通过，runtime/frames/replies/pending/calls 全归零（2026-09-24-matcher-process-report.json）。完整 Electron33 160 checks 通过并恢复普通 out；artifact 为 2026-09-24-electron-33-artifacts。本轮代码检视确认条件对象未缓存、旧协议 fallback 和退出后的拒绝保留。

验证：Mods36 为 127 文件 / 1059 tests 通过（2026-09-24-mods-36.log）；Node/Web typecheck exit 0；最终 scoped ESLint 0 errors / 7 既有格式 warnings（2026-09-24-operation-matching-final-eslint.json）。

正式入口性能独占运行五轮 × 1000 samples，100 warmups：v2-ingress-2026-09-23T17-17-46-600Z-matrix-2b09447c。38515 events，activeCount 0；qualified true，但 budgetsPassed false / exit 2。一插件 p95 分别 16.7138、17.7740、16.3311、18.0141、16.8616 ms，均超过 15 ms。关闭对照 8/10 满足 5%，另两组 +8.1454% / +5.8224%；全部 off arms discovery/runtime starts 为 0。没有放宽门槛。条件 matcher 仍进行真实 RPC，本优化不宣称解决全部入口性能。

全仓 npm test 仍非全绿：初轮 25 失败文件低并发复测后剩 27 tests，其中新增测试清理问题已修复并复测 34 tests 通过；剩 26 tests 为此前独立基线复现的 9 类失败。npm test 的后续 standalone 链未运行。2 小时稳态、整应用最终性能与真实 Autobiz 业务验收仍未完成。
