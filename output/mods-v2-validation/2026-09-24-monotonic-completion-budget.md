# 完成与修复预算使用单调时间

最长执行时间改用 performance.now；系统墙钟前跳不会提前耗尽预算，后跳不会延长预算。私有 deadline 不再暴露给其他时钟直接相减；原 guest 检查、项目测试、Autobiz validator、原 Stop/PostSkillUse 修复循环继续共享同一预算。原生 AbortSignal.timeout 接收向上取整的剩余毫秒，避免小数触发 RangeError。模型用量和关闭模式语义保持原有边界。

先两个校时失败测试（monotonic-budget-red.log），分别复现提前超时和把剩余时间增加一天；修复后预算/真实 QuickJS 完成策略 3 文件32tests通过，原 Stop/PostSkillUse/真实进程修复预算另3文件14tests通过。Mods38 扩大回归、Node typecheck通过；Web此前通过且本改动无renderer。ESLint新增预算代码0errors0warnings。

2026-09-24-checkpoint-budget-electron-artifacts：实际 Electron 原完成门禁与原生 npm 项目失败/修复后复检等9checks通过，exit0并恢复普通out；off仍无门禁或证据UI。真实进程取消由completion-native-budget.test.ts验证；校时用确定性时钟测试，不声称改动机器系统时间。

本改动不改变工具入口发现、运行时启动或执行回执耐久性。正式入口性能仍是之前qualified但FAIL；完整Electron34附带off +7.1633%也未达5%，不声称整体性能通过。最终整应用性能/2h稳态和真实业务验收尚未完成。
