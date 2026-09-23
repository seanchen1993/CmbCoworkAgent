# 完成检查全程绑定原运行实例与真实租约

原 completion wrapper 仅在前后检查身份，等待中的模型/validator 未必主动收到租约失效。现在初始化前捕获原租约，全程复用 runtime authority 资源、binding/配置 epoch 和 runId/owner/acquiredAt 检查；release、替换、撤销及 off 取消检查，handoff watchdog 最迟下次 100ms 检查发现。finally 释放资源。不领取替代租约，不建立第二完成循环。原 native project/background process 共用生命周期 helper，并保留 grant 验证。

先 7 个失败测试，后加入成功资源释放/off 无门禁，共 8 个回归通过。窄测初轮 3 文件 56 tests；扩大 Mods36 包含真实 guest/native project checks 和原背景任务取消，验证 helper 不改变其权限边界。Node typecheck 最新 exit 0；共享/renderer 未再变化，Web 最近检查 exit 0。代码检视核对初始化前租约捕获、退出清理、旧 release 事件与 successor 隔离。

Focused Electron 8 checks exit 0（2026-09-24-completion-operation-electron.log / 同名 artifacts），覆盖 off、文件变化/重启、采集失败、真实 npm 失败阻止完成和修复后新证据；恢复普通 out。租约 handoff 的逐项时序在宿主回归测试中验证，不能声称 Electron 覆盖所有该时序。完整 Electron33 160 checks 是此前 bundle，不能当作本 guard 的完整 Electron 回归。这里的回调测试与项目演示均非真实 Autobiz 最终业务验收。

验证：Mods36 为 127 文件 / 1059 tests 通过（2026-09-24-mods-36.log）；Node/Web typecheck exit 0；最终 scoped ESLint 0 errors / 7 既有格式 warnings（2026-09-24-operation-matching-final-eslint.json）。

正式入口性能独占运行五轮 × 1000 samples，100 warmups：v2-ingress-2026-09-23T17-17-46-600Z-matrix-2b09447c。38515 events，activeCount 0；qualified true，但 budgetsPassed false / exit 2。一插件 p95 分别 16.7138、17.7740、16.3311、18.0141、16.8616 ms，均超过 15 ms。关闭对照 8/10 满足 5%，另两组 +8.1454% / +5.8224%；全部 off arms discovery/runtime starts 为 0。没有放宽门槛。条件 matcher 仍进行真实 RPC，本优化不宣称解决全部入口性能。

全仓 npm test 仍非全绿：初轮 25 失败文件低并发复测后剩 27 tests，其中新增测试清理问题已修复并复测 34 tests 通过；剩 26 tests 为此前独立基线复现的 9 类失败。npm test 的后续 standalone 链未运行。2 小时稳态、整应用最终性能与真实 Autobiz 业务验收仍未完成。
