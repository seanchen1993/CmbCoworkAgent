# 核心版本正式入口矩阵 — 2026-09-24

冻结提交 `971f6d80467031a7f888c33485f5a79fbe68b678`。按运行前已记录的[协议](2026-09-24-next-formal-gates-protocol.md)，执行：

```text
node --import tsx tests/run-mods-v2-ingress-performance.ts --rounds=5 --samples=5000 --warmups=100
```

完整退出码 0；status=completed、workloadComplete=true、qualified=true、budgetsPassed=true。五轮全部完成，178515 个事件，耗时 1270095ms；结束 activeCount=0。未修改原 15ms 单插件预算和 5% 关闭预算。

## 全部预定轮次

| 轮次（从0计） | 单插件 p95 / ms | 项目关闭 p95 增量 / ms | 项目关闭增量 | 全局关闭 p95 增量 / ms | 全局关闭增量 |
| --- | --- | --- | --- | --- | --- |
| 0 | 13.4904 | -0.0502 | -2.2398% | -0.0192 | -0.8640% |
| 1 | 12.9915 | +0.0722 | +3.3066% | -0.0829 | -3.7427% |
| 2 | 13.3971 | -0.0932 | -4.0716% | -0.0005 | -0.0227% |
| 3 | 13.5970 | -0.0218 | -0.9862% | -0.0225 | -1.0362% |
| 4 | 13.1382 | -0.0247 | -1.0987% | +0.0020 | +0.0897% |

五轮单插件均低于 15ms；十组关闭对照全部低于 5%，各组 pluginDiscoveries=0、runtimeStarts=0。完整 0/1/8 插件数据和冷启动成本均保留在原始结果，不将八插件的总耗时误用为单插件阈值。

使用真实 ModsManager、FunctionSession、utilityProcess QuickJS、LocalSandbox.read、经典 Hook 入口、权限和 SQLite 审计。关闭对照在同一原生后端与配置下交错比较「没有 manager」和「已配置但关闭」。fixture 使用临时插件及受控线程租约；不包含 renderer/IPC、模型流、桌面空闲 CPU、业务验收或两小时长稳。

## 解释与限制

此次样本数按预先协议从旧 1000 增至 5000，不能据此宣称旧两轮关闭失败仅为噪声或已确定根因；旧 4/10 和 2/10 超预算结果仍完整保留。此次没有删样本、选择通过轮次或更改门槛。不能把入口预算通过当作正式桌面性能全部通过：当前核心代码桌面 TTFT 仍为 +54.6ms，超出 40ms 目标。

本机无并行构建、测试或源代码修改。期间仅轻量文档编辑、只读 GitHub 状态请求和 318838 字节验证 ZIP 核对；GitHub Actions 构建在远程机器运行。

原始证据：`v2-ingress-2026-09-24T15-33-41-877Z-matrix-78223f8e/run.json`、`result.json` 和 `2026-09-24-core-final-ingress.log`。run.json 保存 frozen bundle SHA、HEAD、PID 和原始参数。此报告只提交 Markdown，不提交生成 bundle 或原始日志。
