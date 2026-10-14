# 定期检查偶尔失败也能继续：本阶段验收

本阶段已完成，仍在 C:/ai/CmbCoworkAgent-mods-v2 的 codex/mods-v2 开发，UAT 未修改。宿主版本 module-resources-v81，已有 Function 组件按原流程重新批准。没有新增用户操作，作者继续使用 $.clock.every、$.clock.after 和 cancel。

## 实际效果

定期查询偶尔抛错或异步失败，会记录本次失败，下一周期再检查。明确取消、权限撤销、重载、关闭、退出边界过期及周期规则拒绝仍停止任务；一次任务失败不重复。八个并行回调的入口上限保留，VM 暂时达到 32 帧会拒绝本周期，释放后下一周期可再次尝试。

每次回调仍复核当前资源、会话和批准。恢复只结束本次失败，不立即重试、不重放模型或进程，不提前释放真实未结束工作。普通回调不被误当成注册 Hook，没有强加新的十秒自身预算；原 CPU、内存和总期限继续有效。

复审发现新增原生调试输出可能记录组件伪造的 MODS_* 错误码，已在输出前限制为固定公开诊断码，未知码统一 MODS_TIMER_FAILED。同步或异步日志写入失败也不会中断周期。真实应用没有传 debugLog 时，现在同样有安全的原生调试记录。

## 原版对照和验证

固定并校验的 Claude Code 2.1.288 原版 plugin test 两项通过：首次每周期错误后继续、取消后停止；一次任务失败不重复。使用原 testkit 的 mock.clock，只证明这些行为，不能写成实际等待或预算验证。[官方 API 指南](https://code.claude.com/docs/en/plugins/mods/api)也说明这一点。

| 验证 | 实际结果 | 记录 |
| --- | --- | --- |
| 修复前反例 | 普通同步/异步恢复 2 失败，其他 8 项通过 | output/mods-timer-red.log |
| 真 QuickJS 最终周期回归 | 17 项通过，无未处理拒绝 | output/mods-timer-console-qualified.log |
| 回调、性能、兼容说明窄回归 | 57 项通过；新增 console 反例另行通过 | output/mods-timer-reviewed-narrow.log |
| 冻结受控广域 | 371 文件、3186 项通过 | output/mods-timer-controlled-broad.log；mods-timer-controlled-broad-scope.txt |
| 真实 Electron 原资源与错误恢复 | 8 检查点通过 | output/mods-validation/e2e-resources/result.json |
| 真实 Electron 参数配置、连续聊天、结束通知 | 14、8、5 检查点通过 | output/mods-timer-electron.log |
| Node/Web 类型 | 通过 | output/mods-timer-types-qualified.log |
| 本阶段 7 文件 lint | 0 错误，527 条已有风格警告 | output/mods-timer-lint-qualified.json |

两位独立设计和最终静态复核通过；固定日志问题修复后两位再次确认闭合。真实 Electron 35 个检查点通过，安装、批准、模块通道、原进程/网络、普通聊天和删除/退出沿用实际入口。timer-recovery-evidence.json 记录第二、第三周期和一次固定诊断；timer-recovered.png 为实际截图。结束后普通构建恢复，out/main/mods-e2e.js 不存在。

早期日志失败测试误把 UI 正常日志的诊断也设为失败，导致正常展示失败；修正测试注入范围为周期错误诊断，并保留同步、异步诊断反例。类型检查发现新测试回调缺显式返回，已修复后重新完整检查。失败轮没有计为通过。

受控清单包含旧 Plugin、Harness、IM、Goal 邻近用例，不等于全工程 npm test 或 lint 已全绿。全工程存量测试及风格债务保持单独记录。

## 性能及接续

真 QuickJS 24 个周期交替成功与失败，排除前两个后各 11 个样本：成功中位 1.44ms、95 分位 2.15ms；失败中位 1.41ms、95 分位 1.76ms。结束后真实活动、帧、回包均为零。数据 output/mods-timer-recovery-performance.json，不包含 IPC、网络、模型和绘制，不能据此保证整应用延迟或真实周期精度。

继续核验最新版本 2.1.289 的实际变化。它已经过完整 SRI 校验、只读提取、实际 --version 和原版隔离测试；下一阶段优先界面组件失败通知与一次备用界面重画，然后继续消息、附件、停驻通知等可适配项。当前没有新的框架限制证据，不停止整体目标。
