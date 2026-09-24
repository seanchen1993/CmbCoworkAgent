# Mods v2 核心版本验证汇总 — 2026-09-25

功能代码冻结于 `971f6d80467031a7f888c33485f5a79fbe68b678`，分支 `codex/mods-v2`，工作目录 `C:\ai\CmbCoworkAgent-mods-v2`。没有修改或合并 UAT 工作树。后续收尾只更新文档和验证记录。

按用户最新要求，本轮优先完成主要应用能力；复杂且不影响已开放功能的兼容边界延期，详见[核心范围](../../docs/mods-v2-core-delivery-scope-2026-09-24.md)。延期不改变权限、证据失效、取消与 checkpoint 正确性要求，也不把失败改成通过。

## 功能与存量回归

最近两项独立修复为 `2ce87e81` 文件读取选项校验和 `971f6d80` Pane 焦点请求清理，均先复现失败再实现最小修复。前者保持真实 guest/host 读取、Hook 改写、显式 undefined 和旧 path-only 行为的边界；后者清理已关闭面板的请求记录，保留当前请求去重及原生焦点归属。未开放二进制读取，也未改变宿主权限协议。

| 检查 | 最终代码的结果 |
| --- | --- |
| 相关 guest/session 与 renderer 窄测 | 7 文件、78 项通过 |
| Node / Web / helper TypeScript | 通过 |
| 修改行 ESLint | 通过；新 helper 和 Pane 文件无 warning，根 Electron 测试保留 80 条旧 warning，无新增修改行诊断 |
| 普通 Electron 焦点专项 | Pane 生命周期 3、原生焦点 9、Client 焦点 9 项通过 |
| 兼容矩阵及证据文件检查 | 功能提交前及最终文档更新后均为 2 文件、21 项通过 |
| 真实 utility process | 46 项通过 |
| 完整 Electron | 236 项通过，退出 0，恢复普通构建，无测试 bridge |
| 全仓 Vitest | 606 文件：597 通过、9 失败；测试 4732 通过、26 失败、5 跳过。26 项失败名称与旧 `0273980c` 已复现清单相同，无新增或消失的失败项 |
| 全部独立测试命令 | 84 条完整执行，80 通过、4 失败；失败命令和实际断言均与旧基线一致，零超时或中断 |

独立命令的旧失败是 agent-registry、sandbox-elevated、IM remote approval Windows 路径和 IM Zhaohu journey；没有通过修改旧模块或放宽断言来使它们变绿。不能称全仓测试全部通过。

详细先失败后修复及日志说明见[文件读取报告](2026-09-24-file-read-options.md)和[Pane 生命周期报告](2026-09-24-pane-focus-lifecycle.md)。最终全仓对照为 `2026-09-24-core-final-vitest-comparison.json`、`2026-09-24-core-final-standalone-comparison.json`；原日志与 JSON 保留在本地忽略目录。

## 性能、关闭对照与长稳

- 正式入口矩阵：预定 5 轮、每组 5000 样本、100 预热全部完成，178515 事件，qualified=true / budgetsPassed=true。五轮单插件 p95 为 12.9915–13.5970ms；十组关闭对照均低于 5%，最大 +3.3066% / +0.0722ms，关闭期间插件扫描与 runtime 启动均为 0。原来的 1000 样本失败仍保留，见[完整入口报告](2026-09-24-core-final-ingress.md)。
- 正式桌面流式对照：qualified=true / passed=false。关闭、开启各 50 个样本，TTFT p95 156.6→211.2ms，增加 54.6ms，超过 40ms 目标；吞吐比 0.9974499119、两个 300 秒空闲窗口 CPU 差 +0.1216494852 个百分点达标。使用本地受控 SSE producer 和真实应用执行路径，不是外部模型推理性能测量。保留失败，作为后续优化项。
- 两小时桌面长稳：exit=0、qualified=true，120.11 分钟、10000 次确认、40 次关闭/重载，四个面板各 2500 次。41 个关闭窗口（含最后关闭）无 Function Mods utility；退出后独立只读数据库核对四个 count 和 50 条成功命令，DB SHA 前后相同。input→第二帧 p95=17.4ms，但仍有 330 个慢样本、最大 1854.5ms；每千事件 live GC 堆中位数从 15.781588 上升至 18.041830MiB，内存稳定性尚未通过验收。工作量、确认和关闭通过不等于全部长稳/性能通过，见[完整报告](2026-09-25-core-final-soak.md)及[过程记录](2026-09-25-core-soak-observations.md)。旧 ACK 失败和一次额外只读 CDP 诊断均保留。

## 真实业务与安装包

真实 Autobiz 订单导出演示已经完成原 Agent 失败修复、真实测试、固定 compiler/validator 复检和仅一次 checkpoint 推进；关闭规则对照保留缺陷，开启后七条独立业务断言通过，受保护需求、测试和脚本未改变。这是有明确输入、预算和依赖的真实示例，不是所有业务的验收证明，见[业务报告](2026-09-24-real-business-demo.md)。本轮没有为了回归重复调用高用量真实模型。

[GitHub Actions 36021056459](https://github.com/seanchen1993/CmbCoworkAgent/actions/runs/36021056459) 对精确功能 SHA 构建成功，Windows/Linux 安装包和 unpacked 产物已上传；Windows 实际生产包九项检查通过。验证 ZIP 已下载并核对 GitHub SHA-256。源版本、artifact ID、摘要与实际检查内容见[交付报告](2026-09-24-core-actions-delivery.md)。未执行 NSIS 安装/卸载或 Linux 桌面运行验收，没有本地重新打包，也没有创建 tag/release 或合并 main/UAT。

## 兼容范围

固定官方参考 Claude Code v2.1.280，声明与 v2.1.278 字节相同，不代表 v2.1.280 二进制行为已经全量验证。逐项表保持 49 adapted、155 partial、41 unsupported、0 full。15 个 schema-only classic 事件、未开放 SDK/浏览器全局、非桌面及复杂 UI 等价性、未知 checkpoint 自动回放/回滚和整个工作区原子事务按核心范围延期。没有凭同名 API 或测试桩通过宣称完全兼容。

## 收尾检视

最终矩阵及证据检查 2 文件、21 项通过；9 份改动文档的 58 个本地链接均存在。相对功能提交的 src/tests/scripts/resources/工作流与依赖清单差异为空，git diff --check 通过。长稳结束后复核 389 个应用快照及 9 个驱动文件指纹，全部匹配运行前记录；已查看实际最终关闭截图。文档提交不改变 Actions 安装包对应的功能代码，也不触发重复打包。
