# 主动 Pane 焦点验证 — 2026-09-24

代码基线 `88ced672` 加本次待提交差异；仅 Mods v2 工作树。焦点专项功能验证与性能回检已完成，但性能门槛仍未通过；不能据此认定全部 Mods v2 完成。

## 实现与检视

新增受限 `$.ui.focus({requestId,key})`。实际 renderer ownership 探测、原 dispatcher 的完整 Hook 链、最终 DOM focus 和匹配随机请求的 ACK 三者都成功才返回成功。保留原 session、授权、generation、callback 队列；ACK 独立返回以避免回调自锁。5 秒总限时，限制每 Pane 一个请求。目标只开放本插件桌面 Pane 原生控件；AbovePrompt、Client 目标与其他 surface 仍不支持，矩阵保持 partial/bounded。

失败测试先行，包括缺模块、实际 DOM 拒绝不能被 Hook 擦除、Hook 挂起、后置否决、刷新阶段探测丢失、排队取消、同 id 重开。检视分别修正先移动后否决、缺失探测身份、取消排队与重开失效。空字符串 deny 回归先实际失败（进入 apply），改为判断字符串存在后通过，任何明确 deny 都保留否决。Pane 忙碌回调用 aria-disabled/readOnly 与事件守卫保留焦点；其他站点默认 disabled 行为不变，重复激活仍被阻止。

## 已完成验证

- 最终窄测 3 文件 32 项通过（交换状态机 18、真实 QuickJS/FunctionSession 12、兼容检查 2），含空 deny 回归。
- 冻结代码的 Mods42：131 文件、1143 测试全部通过，日志 `2026-09-24-mods42.log`。Mods41 在执行期间加入了同 id 重开 red 测试，1142 通过、1 失败；不能标绿，已修复并通过 Mods42。
- Node/Web TypeScript、独立 E2E helper TypeScript 通过。scoped ESLint 零错误、63 项既有文件警告；新 focus 模块、renderer 修改与 helper 无警告。git diff --check 通过。
- 真实 Electron focused 第 4 轮 8 检查通过，`2026-09-24-imperative-focus-electron-4-artifacts/`。原生按钮到输入框、输入框到按钮、重复 Enter、防偷 composer、竞争输入、后置否决、修改目标、renderer 重载、撤权/关闭对照；不新增模型调用。已查看 success.png。
- busy 按钮能力在旧普通 bundle 下实际失败，再实现后构建并通过；不能以新的测试脚本跑旧 bundle 认定产品正确。
- 完整 Electron 第 1 轮 27 检查后颜色断言失败；截图高亮已完成，后续增加实际颜色就绪的有界等待，未修改生产高亮逻辑。原失败记录保留 `2026-09-24-focus-full-electron-artifacts/`；第 2 轮最终 172 检查通过、exit 0，普通 out 恢复；产物 `2026-09-24-focus-full-electron-2-artifacts/`。该完整构建早于空 deny 修复，不能标为精确最终版本全量验证。

- 空 deny 修复后，最新普通构建 focused Electron 9 检查通过、exit 0，产物 `2026-09-24-imperative-focus-electron-final-artifacts/`，含真实空 deny 不移动焦点；没有用旧 bundle 验证新断言。最终 Node 和 helper tsc 通过，新 focus 模块/renderer/helper ESLint 零错误/警告。
- 独立 harness 修正已提交 `16fe8def`，本能力提交不混入工具批次脚本改动。

## 独占性能回检

`desktop-performance-2026-09-23T21-53-02-115Z-smoke-0f435165/` 已结束 exit 0（runner 场景完成），但结果 qualified=false / passed=false。实际 8 guests、4 Clients、原 Agent/provider/IPC，off/on 各 2 个流样本；TTFT p95 109.6/177.5ms，增加 67.9ms，吞吐比 1.000615。1 秒 idle off/on 2.0395/3.8266 单核百分点，增量 1.7871；短样本不构成正式性能结论。不能把进程 exit 0 当成预算通过。

smoke 不能代替正式性能门槛和两小时 soak。原正式 desktop TTFT +67.7ms 超过 40ms 门槛、ingress 一轮 project-off +14.584% 超过 5% 门槛仍为失败。真实业务演示单列旧报告；本报告的契约场景不是新业务验收。
