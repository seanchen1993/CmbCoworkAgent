# Mods v2 模型失败观察验证 — 2026-09-23

父提交 67df9c3c，分支 codex/mods-v2，宿主 v54。UAT/共享依赖未改，不执行本地安装包构建。

## 失败与实现

- observer 新模块测试先失败（模块未实现）；随后验证开启等待、关闭异步、观察异常不覆盖原错误。
- 生产字段、真实 guest 固定事实、schema 三项先失败，50 项原测试通过。
- 聚焦 Electron red 真实模型收到 400 后缺 error_details；SDK 快速观察在该次运行完成，
  不将该运行描述为稳定复现了生命周期竞态。等待边界用受控 pending 测试和真实 stall 取消验证。
- 矩阵新增说明断言先失败，更新为 partial 并明确非全部入口/非完整错误分类。

原错误出口复用原 runner，增加实际详情及 collector 的可用部分回答，绑定原 abort signal。
开启 Mods 等待失败观察，关闭保留原异步时序。所有观察返回均不影响原错误，不触发修复循环。
检视确认 Stop/StopFailure 互斥、原错误分类未改变、取消和撤权不产生迟到续跑、宿主事实固定。
类型检查发现移除直接调用后留下 runHooks import，已删除该无用导入。

## 验证

- 窄测 4 文件 56 项通过，包含真实 QuickJS / FunctionSession。
- Mods28 **162 文件 1251 项通过**（121.33 秒）。
- 原 hook-phase2-followup **115 checks 通过**。
- 最终 Node/Web 类型检查 exit0；作用文件 ESLint **0 errors / 4400 warnings**（包含原大型 agent.ts）。
- 聚焦 Electron1 **6 checks exit0**、普通 out 恢复；实际 400 错误保持原错误卡，真实 SDK 观察、
  reload 后新任务、同输入关闭对照、取消和撤权均通过。截图已查看，归档 stop-failure-focused-artifacts。
- 完整 Electron28：**156 checks 通过，完整 runner exit0**，ordinary out 已恢复。
- 最终补充窄测 8 文件 87 项通过（也包含下一项兼容证据和性能诊断纯函数检查）。

## 限制与性能

综合 Electron28：原生读取 absent/off 各500样本、各100预热，p95 4.9196/4.9043ms，
变化 -0.3110%；noop1000 p95 9.3321ms，pendingRequests=0。归档 electron-28-artifacts。此前正式五轮性能失败仍有效；不把单次 E2E 测量作为最终门槛通过。
当前仅原 main invoke 错误出口；resume/interrupt/remote 的剩余触发器和上游完整错误枚举未完成。
没有业务 validator/checkpoint 推进，无 Autobiz 业务通过声明。全仓既有失败不在本报告中改称全绿。
