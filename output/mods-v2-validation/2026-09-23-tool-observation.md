# Mods v2 工具执行观察验证 — 2026-09-23

工作树 C:\ai\CmbCoworkAgent-mods-v2，分支 codex/mods-v2；父提交 da1479bd。
宿主契约版本 v52。未修改 UAT、共享 node_modules 或本地安装包。

## 先失败再修复

- tool-observation-red：3 文件 6 项新增失败；真实 guest 可改写后置事实、生产 MCP 无耗时、
  sandbox 可被参数中的旧 tool ID 抑制失败通知。
- red2：原生 AbortError、TimeoutError 和非法可选执行字段共 4 项失败。
- Electron1/2：真实 MCP 失败通知没有送达，诊断确认 MODS_CALL_SCOPE_EXPIRED；原调用 lease
  已先结束。增加有/无 Mods 的等待边界红测（lifetime-red2），随后只在开启 Mods 时等待
  MCP 失败观察结束。lifetime-red 初版 fixture 缺 bindMcp，已修正；不把该错误当生产红测。
- legacy-red：传统脚本缺顶层宿主工具 ID、error/is_interrupt；保留原 tool_response 后补齐。
- matrix-red：兼容矩阵缺实测范围及证据引用。

## 实现与检视

固定后置事件的真实工具身份、输入、结果/错误和中断/耗时信息；输出替换仍限模型/显示层。
MCP 单调计时只围绕实际 adapter 调用，排除 Hook/审批/预选/发布。未知耗时省略。
原生失败调用 ID 从原 toolCall 传入，去重不读工具参数。识别原生取消/超时错误名称。
开启 Mods 时 MCP 失败观察留在原 authority/lease 内；关闭时保留原 legacy 异步路径。
代码检视检查了计时范围、事实来源、guest next 伪造恢复、错误状态保留和无额外重复执行。

## 验证

- 初窄测 6 文件 57 项；加入等待边界后 6 文件 59 项。
- 最终窄测 7 文件 **76 项通过**，含真实 QuickJS guest / FunctionSession / 原 runner。
- 扩大 Mods26 回归 **159 文件 1225 项通过**（111.72 秒）；该轮早于最后的等待边界、legacy
  字段和矩阵补测，后续由上述最终窄测覆盖，不重复计为全量新结果。
- 原 tool-hook-regression 14 项、MCP fallback、hook-phase2 42 项通过。
- Node/Web reviewed 类型检查均 exit0；最终 ESLint **0 errors / 226 warnings**。
- 聚焦 Electron3 **5 checks exit0**；原生读开启/关闭对照，真实 MCP 失败回执、同 ID/耗时、
  失败观察送达均通过，普通 out 已恢复。截图已查看。
- 综合 Electron26：**145 checks 通过**（包含新 MCP 观察取消/撤权以及既有全部 Mods E2E）；完整 runner **exit0**，普通 out 已恢复。

## 性能与界限

综合 Electron26：相同原生读取 absent/off 各 500 次、预热各 100 次，p95 2.9594/3.0072 ms，变化 +1.6152%。noop1000 p95 8.8387 ms，pendingRequests=0。开启耗时带实际动作，不拿它当空钩开销。归档 2026-09-23-electron-26-artifacts/result.json；不替代正式五轮矩阵。

经典 PostToolUse / PostToolUseFailure 仍 partial：未测量原生工具/抛出异常的耗时；原生失败
观察仍异步，不声明取消后必定送达；没有以这些事件或模型协议 fixture 替代业务 PASS。
此前正式五轮性能预算失败仍有效，单次 E2E 指标不能宣布最终性能门禁通过。
全仓已归因的 26 项既有失败未修复，本报告不声明 npm test 全绿。

原始日志均在本报告同目录；仅提交报告，不提交日志、bundle、fixture 工作目录或本地凭据。
