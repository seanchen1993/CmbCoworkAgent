# PostToolBatch 生产批次验证（2026-09-23）

基线 098e1198，host v48，仅 Mods v2 工作树；本报告不证明 Autobiz 最终业务验收或安装包交付。

## 行为与检视

- 主 runtime 的 afterModel 记录实际生成批次，下一次 wrapModelCall 等完整原生 ToolMessage 后才检查；原请求顺序、成功/失败输出保留。模型历史、部分返回、重复返回不冒充新完整批次。
- 原 ModsManager / FunctionSession / runHooksEnriched 执行 classic 与 legacy 核心；重复 next 只执行一次。缓存当前批次的结果 Promise，包括失败；取消及 authority 再检查阻止迟到结果和下一次模型调用。
- 宿主固定公共身份及批次事实，插件不能改变这些字段。上下文只附加到下一次模型请求，不改工具执行结果或持久化的原始消息。
- 批次入口仅 main runtime、最多 128 调用，受 classic JSON 限额约束；没有共享子 Agent 或重启后历史重放声明。tool_input 是模型请求参数，tool_response 是模型可见输出投影，不能作为原生执行凭证或业务 PASS。
- 新配置入口提供事件、stdin/返回值说明和同步等待语义。Mods 关闭且无独立 legacy 批次规则时不安装新 middleware。
- 实际 Electron 发现 LangChain MiddlewareError 保留 name/message 却把 HookHaltError 具体字段放在 cause。新增有界错误提取，主 IPC 三条终止路径保留真实阻止原因；原 rethrow guard 不变。

## 失败先行

新增 middleware missing-module、classic bridge、pinned facts、schema、matrix、错误包装红测均有日志。
聚焦 Electron1 为 fixture 的 Windows 绝对路径错误；2 为关闭对照断言旧 DOM 的时序错误；3 揭示实际 UI 丢失阻止原因，新增真实 MiddlewareError 回归后修复。保留所有失败日志。

## 验证

- 窄测 11 文件 75 项通过，包含真实 guest / FunctionSession / 原 legacy core 的批次门禁。
- Mods22：138 文件 1090 项通过，97.20 秒、maxWorkers4。
- 原 mcp-hook-halt 两项、tool-hook-regression 14 项独立回归通过。
- Node/Web typecheck 均 exit0。
- 配置弹窗以外的作用文件 ESLint 0 errors；保留大文件现有格式警告，未整文件格式化。AddHookDialog 的 18 errors 已用 HEAD 源码 lintText 逐项复现，基线与当前错误完全一致；详见 lint-baseline.json，不能宣称全项目 ESLint 通过。最初新测试两个 unused 参数错误已修复。
- 聚焦 Electron4：6 checks、exit0、普通 out 恢复。包括真实双文件读取（一个 ENOENT）、按顺序一次批次、上下文、关闭对照、阻止原因、评审期间取消/撤权关闭真实 HTTP 传输。截图已查看，归档 tool-batch-artifacts。
- 综合 Electron22：125 checks 通过；主流程、新批次及关闭对照均覆盖。exit0，普通 out 已恢复，out/main/mods-e2e.js 不存在；归档 electron-22-artifacts。

## 性能及剩余项

综合 Electron22：500 次原生 read/每组 100 次预热，manager absent p95 3.1924ms、disabled 3.1289ms（-1.9891%）；noop1000 p95 9.1294ms、pending0，仅单次观测。此前正式五轮入口性能预算失败仍未解决；单次桌面观测不能覆盖该失败。最终全应用性能、两小时 soak、Autobiz 真实示例和 GitHub Actions 安装包仍待完成。全仓历史 26 项基线失败有独立复现记录，不宣称 npm test 全绿。
