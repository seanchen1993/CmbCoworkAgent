# 子 Agent 实例列表

`await $.agent.list()` 读取当前项目、线程中的 shared task 实例。字段对应官方固定 v2.1.278 的 AgentInfo，仍为 **partial / bounded**；它不创建新 Agent，也不是可用 Agent 定义目录。

```ts
const agents = await $.agent.list()
for (const agent of agents) {
  $.ui.log(`${agent.id} ${agent.type}: ${agent.status}`)
}
```

## 实际来源

原 task 工具的宿主包装器提供真正的工具调用 ID、任务描述和 Agent 类型，原 withSharedAgent/runtime authority 生命周期记录 `running`、`completed`、`failed`、`killed`。父子关系来自 parent authority；能确认插件触发时才提供 spawnedBy。模型拒绝沿用原 withTaskModelOutcome，不能仅因返回了文本就记录成功。

信息表只由宿主更新，SDK 不接受目标项目或线程参数。旧完成回调不能覆盖同 ID 的新实例，关闭或清除后也不能复活记录。元数据不会保留父 runtime authority 对象。原任务权限、返回值、错误和 lease 不变。

## 范围和限制

- 列出当前观察生命周期内接入 shared task 的循环。未覆盖 opaque 自定义图、独立 workflow worker 或 teammate；不把 agent.offer 的定义行假扮成正在运行的任务。
- 最多保留 100 个项目/线程作用域，每个最多 100 个实例。元数据不合法或容量不足时查询以 MODS_AGENT_LIST_LIMIT 拒绝，原生任务继续运行。项目配置/关闭清除对应观察，应用开关切换和关闭清除所有观察；全局容量溢出需要清除整个观察生命周期。不会静默截断列表并声称完整。
- renderer 重载继续读取宿主事实；应用重启没有运行实例恢复。开启前或观察生命周期已清除的任务不会被补猜。
- 查询跨输出保护的等待期间仍绑定原 workspace/thread/runtime；取消、撤权、替换或项目切换拒绝发布旧查询。没有绑定 runtime 的查询只允许原普通前台任务的冷读取路径。
- 这是查询时点的观测。插件可以用正常 hook 改写查询展示，但不能修改宿主实例表、原生工具回执或业务/checkpoint 证据。`completed` 表示子任务循环完成，不表示测试或业务验收通过。

host revision 为 `desktop-agent-instances-v59`，旧摘要须重新授权。详细测试、Electron 开关对照与性能结果见[验证报告](../output/mods-v2-validation/2026-09-24-agent-list.md)。
