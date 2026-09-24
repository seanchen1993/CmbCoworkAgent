# 实际子 Agent 实例 SDK 验证 — 2026-09-24

基线 7363ce1e / codex/mods-v2，仅 C:/ai/CmbCoworkAgent-mods-v2；参考官方 v2.1.278，host revision v59。原任务包装器传实际 metadata，原 withSharedAgent 和 runtime resource 生命周期更新独立有界 host 表，SDK 沿用 FunctionSession、原输出保护及 authority。没有修改 UAT/共享依赖或本地打包。

## 失败先行

真实 guest/session 3 项先因 agent.list 不存在失败；实际 native manager 缺 list API 的 3 项失败；实例表和 publication helper 缺模块失败。实现初稿误对 operation envelope 做数组校验导致 2 项失败，修为 value.value 并保留空 deny。原 native Error 在 dispatcher 中转换为 MODS_DOWNSTREAM_REJECTED，测试按原错误边界验证，不暴露原宿主异常。

旧 ordinary 包的实际 Electron red-2 在冷命令得到 `ERROR:cannot read property list of undefined`；更早一次缺 focus 白名单进入全套 fixture，只是 harness 故障，不计功能红测。

## 当前结果

- 真实 guest/session、host 实例表、实际 DeepAgents task 与 native runtime scope 窄测 3 文件52通过；随后补结果结构/超限/非法metadata，最终窄测 4 文件 **65 项通过**（exec56554 exit0）。
- Electron 专项第二轮 **8 检查通过**（exec58966 exit0）：冷查询无模型、真实 native task 内 running→completed、provider refusal failed、原取消 killed、renderer 重载、真正撤权、关闭后原 native child + read_file。`2026-09-24-agent-list-electron-green-2-artifacts/`。
- 首轮 Electron 的撤权检查发现 helper 传错参数，原接口需要模块 name 而不是安装 ID。修正后同时检查 needs-approval 和命令移除；并单独修复此前两个 helper、重跑5+7检查，更正历史报告，见 7363ce1e。
- 最终 Node/Web/helper 类型通过；修改文件 ESLint 无错误，与 HEAD 比较无新增警告，新增 7 文件零警告。已检视真实实例截图。
- 完整 **Mods49 141 文件 / 1266 项通过**；真实 utility process **41 检查通过**。完整 Electron 首轮在 agent.list 关闭对照失败（exec38472 exit1，普通out恢复）：截图显示原任务已结束，测试依赖可见历史答案数量递增，虚拟化卸载旧行后不成立。改为新增持久化 assistant 答案 ID + 原 idle/新答案可见性/真实文件读取断言，未修改应用行为。helper类型/lint通过；修后 focused green-3 **8 检查通过**（exec68680 exit0），完整第二轮 **199 检查通过**（exec86475 exit0），普通out已恢复。随后仅加强helper撤权任务自身 failed / MODS_CANCELLED / 无result 断言，最终专项 **8 检查通过**（exec77129 exit0，types/lint通过），未改应用代码。
- 独占标准 performance smoke **exec25810 exit0**：`desktop-performance-2026-09-24T01-36-25-341Z-smoke-56bdf39f/`。qualified=false / passed=false；off/on 各2次 TTFT p95 为110.7 /179.7ms，增量69.0ms；吞吐比0.997205；约1秒空闲 CPU 增量1.898952单核百分点。只作回检和开关对照，不代表正式预算通过。

范围说明：Mods49 为默认 Mods 范围；Mods48 另外包含未改动的 renderer function-scroll-follow 1 文件2项，不把两轮数量直接相减判断删除测试。完整 Electron 本轮覆盖实际主动滚动。

存量专项：standard-thread-turn-architecture、agent-tool-guard（6 cases）、local-thread-run-lease（6）和 subagent-observability（6）四个 standalone 命令均通过；保持原线程、只读限制、租约及子任务展示行为。

## 检视边界

最多100 scopes×100 instances，容量或元数据不完整时拒绝查询，原生任务不因表满中断；不返回伪造的空完整列表。只存标识和元数据，不留存 authority 对象。已验证同 ID 迟到完成与清除竞争、真实嵌套 parentId、原错误对象保留，以及 publication 等待中的 cancel/disable/revoke/replace/workspace 五种失效。

仍 partial/bounded：opaque graphs、独立 workflow workers、teammates 不枚举，应用重启不伪造任务恢复。completed 是循环状态，不是业务 PASS。列表展示 hook 不能修改 host 表或原执行回执。正式 TTFT/ingress关闭预算、2h10000soak、剩余兼容项与最终 Actions 安装验证仍未完成。
