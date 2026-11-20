# Managed Mode V3 历史路线（未实施）

以下保留原设计中的 V3 章节；这些能力是历史规划，不构成当前实现承诺。当前行为以 [托管模式与消息通知设计](2026-07-28-managed-mode-v1-design.md) 为准。原章节编号保留，便于追溯。

### 3.3 V3 目标

V3 规划：

- action 索引、actionKey、执行恢复和跨重启幂等；
- versioned event reducer、journal replay 和 snapshot reconcile；
- 会话/节点计数、硬上限和平台动作重试；
- 抽取 Workflow Structured Output 的公共 Schema Capture 内核；
- 保持现有 `structured_output` 名称、错误、重试和 stop semantics 完全不变；
- 新增 `managed_stage_result`；
- 在派生的 `nextAction.userMessage` 后追加 `<managed-mode>` 控制信封；
- 正常 Turn 结束但未提交合法报告时，在同一 Thread 最多自动补发三次；
- 三次补交仍失败时将整个 ManagedRun 标记为 failed；
- 报告缺失不调用 Side Agent；
- 仅在报告与 feature_status 冲突、同节点进度模糊或异常恢复难以按规则判断时调用只读 Side Agent；
- Side Agent 使用结构化输出、hash 缓存和有界重试。

### 10.3 V3 提升

V3 再增加：actionKey、Thread metadata 关联、action 索引、平台动作重试、跨重启幂等、会话/节点计数、硬预算和 event replay。

## 14. V3：结构化阶段结果与 Side Agent

### 14.1 公共 Schema Capture

将 Workflow `createStructuredOutputTool()` 中通用能力抽取为参数化内核：

- JSON Schema tool input；
- runtime validation；
- repair feedback；
- 最大 5 次不同无效输入；
- 连续 3 次相同无效输入 hard stop；
- 首个合法结果获胜。

原 `structured_output` 必须保持：

- 工具名；
- Prompt；
- 错误文本；
- stopAfterAccepted；
- nudge；
- fresh-session retry；
- journal/hash；
- 全部现有测试。

### 14.2 managed_stage_result

托管会话注入独立工具 `managed_stage_result`，使用公共 Schema Capture，但：

- 不替代用户最终回复；
- 不自动 stop stream；
- 结果持久写入 ManagedRun；
- 与 stageExecutionId/turnId 关联；
- 不允许指定任意 Skill、命令、workspace 或 checkpoint。

实际发给 Agent 的模型消息在原 `nextAction.userMessage` 后追加：

```xml
<managed-mode>
当前 Feature 已开启托管模式。
本轮工作结束前必须调用 managed_stage_result 工具，提交符合 Schema 的阶段执行结果。
该报告不替代 Skill 产物、Hook、runner、Evidence 或 checkpoint。
</managed-mode>
```

插件 `feature_status` 原始对象不被修改；这是 Controller 派生的模型消息。

### 14.3 缺失报告补交

仅 `outcome=success` 正常结束但缺少合法报告时：

1. ManagedRun 进入 `awaiting_stage_result`；
2. 同一 Thread 自动发送报告补交 userMessage；
3. 不重新执行业务、不增加 bizRetryCount；
4. 初始业务 Turn 之后最多补发 3 个报告 Turn；
5. 仍缺失则整个 ManagedRun failed；
6. 此分支不调用 Side Agent。

Provider Error 使用独立重试预算，不消耗报告补交次数；hook_halt、failure_fuse、用户取消和 pending user input 不触发补交。

### 14.4 Recovery Side Agent

V3 只在规则无法确定时调用只读 Side Agent：

- feature_status 与合法报告冲突；
- 路由未变化且报告语义不足；
- 无法区分合法 handoff 和业务 retry；
- 异常恢复证据冲突。

Side Agent 输出结构化决策；相同证据使用 evidenceHash 缓存。Side Agent 不修改文件、不启动 subagent、不选择任意 nextAction，不覆盖 feature_status 明确事实。低置信度结果转为 failed 并等待人工重新开始。

### 17.5 V3

1. actionKey、action 索引和 Thread metadata 幂等关联；
2. event replay、lastAppliedEventCursor 和 versioned reducer；
3. 平台动作恢复/重试和跨重启 reconcile；
4. 会话/节点计数、硬上限和精确预算；
5. 公共 Schema Capture 抽取；
6. `managed_stage_result`；
7. `<managed-mode>` 控制信封；
8. 最多三次报告补交；
9. Side Agent；
10. evidenceHash 缓存；
11. 冲突决策可视化。
