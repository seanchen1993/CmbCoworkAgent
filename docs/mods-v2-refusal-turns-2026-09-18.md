# Mods v2：真实提供商拒绝终态

开发分支 `codex/mods-v2`，起点 `733414f5`，宿主修订 `desktop-refusal-turns-v23`。
固定契约对照仍为 Claude Code 2.1.273。

## 效果与来源

主、共享子任务和后台运行的 `turn.complete` 现在保留提供商明确报告的拒绝事实，
提供 `reason: "refusal"` 及可空的 `category/explanation`。用量仍来自实际响应。
取消优先于拒绝，拒绝优先于普通错误或回答，与冻结还原代码 `Cyt/Ayt`
（格式化 chunk 第 132651–132674 行）一致。

项目通过 OpenAI-compatible Completions 适配实际模型：`refusal` 文本保存在
`additional_kwargs`，同时作为实际可见文本传递；`content_filter` 无分类时返回空值，
不编造 Anthropic 分类。兼容端点明确返回 `stop_details` 时保留其字段。普通正文中的
“不能回答”不会被推断成拒绝。Claude 原生 API error message 与本工程提供商消息格式
不同，本批没有把文本适配声明为原生 Anthropic 传输或 fallback 路由的实现。

协议依据：[Claude 拒绝与 fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)、
[OpenAI Completions](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions)。
还原产物用于核对终态语义，未拷贝到产品代码。

## 底层处理与检视

- 在现有模型适配器边界保留拒绝字段，流聚合、检查点、轮次观察读取相同事实。
  流式与非流式均覆盖，推理显示适配不再吞掉与推理一同返回的拒绝正文。
- 完成门禁把明确拒绝视为终态，不触发空回复或未完成 todo 的自动模型重试；
  provider 同时携带工具调用时，主图在工具节点前结束。
- Stop/PostSkillUse 修订在初始拒绝或修订产生拒绝后停止。桌面目标自动续跑暂停，
  invoke/resume/interrupt 均按未完成结算。
- 定时任务、心跳和旧远程入口在成功记账、提交及成功通知之前核对实际拒绝。
  后台仅增加终态观察，不因此获得前台队列权限或启用前台恢复重试。
- 后台物理运行结束时清理拒绝报告。子代理事实不会把父任务的完成原因改成拒绝。
  共享子代理的原生任务状态展示仍需下一批统一，不以 Mods 事件正确替代该验证。

## 验证

首轮 115 项及扩展 150 项通过。两次类型检查分别发现测试的 LangGraph 类型推断和
HookResult 夹具缺少字段，均已修正；最终 Node/Web 类型检查通过。

代码检视新增的混合推理回归先复现 2 项失败，再修复适配器。修复后扩展专项
610 项全部通过，原有 `tests/completion-hooks.spec.ts` 通过。
最终跨进程 37 项通过；23 个改动源码文件规范复核无新增问题，保留 1 个既有显式 any
错误及 4162 个既有格式告警。全仓基线失败仍按先前记录留存，未宣称全仓全绿。

桌面 E2E 63 组通过，含主任务三种拒绝协议、真实共享子代理拒绝、定时任务与心跳
拒绝；各场景核对实际 HTTP 请求次数，没有自动恢复请求。普通构建已恢复。
该 E2E 在最后两行混合推理修复之前完成；最后修复由真实 SDK、图执行、检查点
以及完整专项与类型检查覆盖，后续 UI 批次会重跑桌面套件。

此轮禁用读取 P95 2.2947 → 2.2353 ms（−2.59%）；no-op 1000 次 P95 8.8997 ms，
冷启动 215.52 ms，最终 pending 0。最终性能与长期稳定性门禁尚未完成。
证据保留在 `output/mods-v2-validation/refusal-*`；截图为
`output/mods-validation/e2e/function-turn-refusal.png`。

## 继续推进

下一批补齐原生子任务拒绝状态与按轮次定位附加说明，再推进 session usage/compact、
代理及模型完整接入、其余 UI、开发工具和 B8 验收。B1–B8 全部完成前不会把局部通过
写成完整对齐。
