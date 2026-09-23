# 动态上下文来源（2026-09-23）

`session.context` 现在读取主 Agent 实际模型请求中的 memory、skills、MCP 和 agent 信息。
memory 取已加载的 `memoryContents`，skills 取中间件解析的 frontmatter，并按本次启用的
source 过滤；不再把磁盘目录名或仅存在的文件当作已加载内容。MCP 的 `isLoaded` 根据最终
请求的 tool ID 判断。只有实际提供 task 工具时才列出可用 agent。

观察中间件显式声明共享 state 字段，避免 LangChain 丢弃 memory/skills 状态。请求快照
复制嵌套数组，防止后续修改污染先前读取。关闭来源后，旧 state 中的残留数据不能重新出现。
该路径不额外扫描文件或连接 MCP。token 数量仍为本地主机估算，因此兼容等级为 adapted。

验证证据位于 `output/mods-v2-validation/`：

- `2026-09-23-context-classic-final.log`：6 文件、47 项通过，包含实际 deepagents
  memory/skills 中间件读取临时 MEMORY.md、SKILL.md 的启用/关闭对照。
- `2026-09-23-all-mods-final.log`：88 文件、680 项通过（此联合快照早于后续模型小修）。
- `2026-09-23-typecheck-final.log`：Node/Web 均通过。
- `2026-09-23-eslint-final.log`：无错误；保留当时格式告警，随后统一修改源文件 LF。
- `2026-09-23-real-process-final.log`：真实 Electron utilityProcess 通过；文件、Pane、
  Client 和动态 noun 经过生产 session/guest，含关闭对照。
- `2026-09-23-electron-integrated-2.log`：应用上下文、真实 MCP/native 工具、主模型和
  engine/Code 场景通过；后续 focus 插件缺少 hooks 清单导致安装失败，尚非完整 E2E 通过。

这些证据证明宿主接线和隔离行为，不代表 Autobiz 业务验收通过。
