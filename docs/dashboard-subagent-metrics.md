# 项目、Team、Workflow 运行开销统计

- 项目列表及阶段开销：在相同项目、开始时间范围和权限范围内，对所有主、子 trace 的顶层工具次数、模型次数、输入/输出/总 Token 求和。子 trace 保留 rootTraceId / parentTraceId，主 trace 不重复累加子 trace 的开销。包含后台任务。
- 对话轮数及阶段耗时：仍只统计主动触发的主 Agent。父轮次的耗时包含等待子任务的时间，不再叠加子任务耗时。
- 项目 Thread 明细：保持项目、时间、特性、阶段及触发范围；切换查询条件后失效旧缓存。列表预览仍有条数上限，完整统计以项目聚合和加载完成的明细为准。
- Team、Workflow 子 Agent：使用本轮输入消息 ID 定位，消费原始 values 中完整 AI 响应的 usage_metadata / response_metadata，按消息 ID 去重。续跑旧消息不重复计入，本轮的修订和补充回答继续计入；失败保留已观察到的调用。未收到响应及用量的失败 HTTP 请求不推算 Token。

## 历史数据与服务端

项目聚合修改可以重新计入已经上报的子 trace 数值，但不会补出历史上没有采集的模型调用次数。工具次数、trace 条数不能用来推算模型次数。

服务端仍需遵循已有的 trace 入库约定（见 trace-server-token-fix.md）：modelCallCount 优先使用 totalModelCalls，Token 使用顶层累计字段，不使用被截断的 modelCalls 数组长度。此次客户端没有新增这些字段，也不需要改变它们的 mapping。

回填前应先按 rootTraceId/parentTraceId 核对生产样本：顶层值正确的直接重新聚合；保留完整逐次响应的可去重回算；只有终端累计 Token 的最多补回 Token；缺少原始记录的模型次数不能准确还原。本次代码修复不改写生产历史数据。
