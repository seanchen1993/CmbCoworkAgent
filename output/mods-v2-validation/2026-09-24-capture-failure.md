# 初始证据采集失败的可解释记录

真实 guest 的 report/check/repair 三个失败测试先复现：大文件导致初始 capture 抛错，
账本没有记录，report 也被错误中断。现在宿主保存 capture.failed，binding 为 null；
capture 字段只有已知执行身份、插件摘要、runtime generation 与配置指纹。
没有虚构 diff、需求版本、文件指纹或 checkpoint 证明。

仅报告模式继续原完成流程，强制模式阻止完成。原始取消和授权失效仍传播，不能转成通过。
未绑定记录不能用于 checkpoint 推进；宿主持久化层拒绝将 null binding 写为 PASS。
真实 SQLite 关闭重开仍保留失败，UI 显示错误、未取得文件证据和下一步。
本改动没有采集开始日志；采集中进程死亡的完整步骤日志仍需后续完善。

- 红测：3 个真实 guest capture 失败用例全部失败；修复后联合 guest/实际固定 validator/UI 3 文件 38 通过。
- 检视：null binding 判别联合防止误用，补已取消信号不转成 advisory PASS；追加持久化拒绝伪 PASS 和 UI 回归。
- 相关持久化、UI、IPC、应用规则、freshness 5 文件 40 通过。
- 扩大 Mods34：174 文件 1305 测试通过，2 workers，最终取消测试包含在内。
- Node/Web TypeScript 均 exit 0。相关 ESLint exit 0，8 个既有格式警告。
- Electron focused completion-freshness：5 项通过，runner exit 0、普通 out 恢复。覆盖真实模型入口 off/on、物理文件变化失效、报告模式采集错误、UI 与 renderer 重载。
  截图已检查，归档 2026-09-24-capture-failure-electron-artifacts。
- 前序完整 Electron32 156 项通过，但不包含随后新增的 capture.failed 分支；本分支由上述 focused 验证。
- 关闭对照无门禁、无证据 UI，无额外检查/模型重放。采集错误不执行评审模型。

此前独占性能失败仍开放；本 focused 没有全应用性能数值，不冒称新性能验收。
下一次冻结普通 bundle 将复测 CPU/流式和两小时稳定性。合同夹具、受控模型协议和宿主检查记录均不等于真实 Autobiz 业务验收。
