# Mods v2 权限查询与执行边界复核

开发分支 `codex/mods-v2`，本批基线 `2002fe64`。对照固定版本 Claude Code 2.1.273，
不把本批的完成等同于 B1–B8 的全部验收。

## 使用效果

`$.tool.check({ tool, input })` 返回 `{ decision: "allow" | "ask" | "deny", reason?, rule? }`。
示例插件新增 `/claw-check`：

```text
/claw-check {"tool":"read_file","input":{"file_path":"README.md"}}
/claw-check {"tool":"write_file","input":{"file_path":"notes.md","content":"hello"}}
```

查询不运行工具、classic Hook、模型分类器或审批，也不领取工具执行账本。它是权限判断，
不能保证文件存在、参数被远端服务器接受或工具随后一定成功。

原生工具复用实际路径、只读沙箱、工作树、敏感目录、命令安全、任务卡片、审批缓存和
永久规则判断。冷普通项目使用仅暴露查询闭包的沙箱探针，不安装后端、不预热沙箱或
改变 ACL。Windows 管理员状态可能需要一次 OS 元数据查询，这不是运行用户提交的工具。
特殊会话不能通过普通项目探针绕过其上下文。注册工具会复核定义、schema 和所有者授权。
MCP 仅查询配置指纹仍匹配的已有元数据，不连接服务器；缺失缓存和别名歧义明确拒绝。

## 执行与权限契约

- 查询没有 tool_use_id，实际执行由宿主设置。tool/input/id 全部固定；改写失败按上游
  可选 Hook 规则继续使用原始输入。返回值没有 value 外层。
- 模型来源是 engine/core，SDK 来源是发起插件；跨插件调用分别传递调用者与定义所有者，
  不把归因当作授权。原生/MCP 在最终参数授权入口检查，注册工具在进入可选实现前准入。
- deny 拒绝实际执行，ask 交给现有审批入口；经过保护的理由传到模型/界面。
  保留 D01：Hook 不能放宽宿主最终 deny/ask。查询结果不缓存为执行许可，也不消耗批准。
- 前后复核信号、授权、配置和绑定；没有权限 Hook 时实际工具不运行额外沙箱权限探针。

## 检视发现与修复

1. 原生绑定缺少失效检查：补上实例检查、轮次校验和条件释放。旧释放器不能删除新绑定，
   审批期间替换后端或关闭会话后，旧 SDK 调用不能继续。
2. 并发冷调用替换适配器：原生/MCP 共用队列实现、分别管理绑定，每类每会话最多 16 项。
   清理结束再接下一项；过期/取消调用不创建新绑定，嵌套调用保留真实父轮次。
3. 审批或连接复核拒绝被错误记为 unknown：宿主用私有 WeakMap 保存当前 callId 的
   未开始证据。当前调用的执行前失败记 not_started；子调用失败不能证明父调用未开始。
   真正丢失回复仍为 unknown，不重放。
4. 查询短路可能绕开宿主结论或输出保护：再次复核宿主约束，并保护覆盖后的最终结果。

宿主修订 `desktop-tool-permission-v13`，旧摘要需重新批准；没有数据库迁移或新增依赖。
UAT 工作区未参与修改。

## 验证

新增 `tests/fixtures/mods-v2/tool-check`，在真实 2.1.273 plugin test 验证裸结果/来源、
deny 无执行、锁定输入恢复，3/3 通过，累计上游契约证据 39 项。同一夹具还通过实际
Electron utilityProcess/QuickJS；没有以外部服务 mock 证明生产模型效果。

最终日志使用 `output/mods-v2-validation/permission-*`：

| 检查 | 结果与证据 |
| --- | --- |
| 全仓 Vitest | 3381 项：3350 通过、26 失败、5 跳过；26 项与 `2002fe64` 同名同原因，无新增失败。`vitest-permission-full-final.json`、`permission-failure-comparison-final.json` |
| 最后检视修复 | 全仓运行后补上注册工具拒绝的模型错误映射；随后运行 51 项专项，全部通过。`permission-admission-final.txt`；上述全仓报告不包含最后新增的该项回归 |
| 跨进程 | 37/37，真实 Electron utilityProcess / QuickJS。`permission-process-final.txt` |
| Electron E2E | 41/41，覆盖最后的错误映射、审批理由保护、并发绑定、撤权和重启。`permission-e2e-verified.txt`、`.json`；普通构建恢复，测试入口不存在 |
| 独立回归 | 81 套件中 73 通过；7 项断言失败与基线同名同因，另 1 项仍为 workflow-worktree 的 180 秒超时。`permission-standalone-comparison.json` |
| 类型与规范 | Node/Web 类型检查通过，改动代码无新增 ESLint 问题。`permission-types-accepted.txt`、`permission-lint-final.txt` |

E2E 初次复验在重启后切换会话时过早发送回车，文本仍留在输入框，没有模型请求。
夹具改为等待实际发送按钮可用后点击，再完整重跑。失败截图和 39 项已通过记录保留在
`permission-e2e-submit-failure.png` / `.json`，不将那轮记作完整通过。

独立回归初轮新增两项源码截取失败，原因是旧构造函数签名标记和缓存初始化断言没有适配
查询探针分支。修正标记与断言后，完整重跑该套件，84/87 通过，剩余 3 项与基线一致。
保留初轮 `permission-standalone-constructor-failure.txt`；招乎旅程另核对到同一断言
`im-local-zhaohu-journey.spec.ts:664`，没有仅凭通用 AssertionError 文本判定为相同原因。

宿主性能使用 `node tests/run-function-host-performance.mjs 2002fe64 mcp-sdk`：
两版调用相同 MCP SDK，1000 个工具元数据、4 轮 ABBA/BAAB、每版 800 次采样。
P50 为 10.303 → 10.307 ms，P95 为 11.051 → 10.976 ms（−0.67%）。
包含真实 ModEngine 与 SQLite，不包含 VM、策略进程或真实网络。
数据和两个 bundle 摘要见 `mcp-sdk-performance/result.json`。

最终 E2E 的实际读取禁用路径 P95 为 2.386 → 2.316 ms（−2.93%），每组 500 次、
预热 100 次。1000 次跨进程空 Hook 的 P50 / P95 为 8.004 / 8.818 ms，冷启动
206.698 ms，子进程 RSS 从 111685632 到 118370304 字节，待处理请求为 0。
此前批次的超门槛波动继续保留；本批局部通过不等于整个系统的性能门禁和两小时压力验收。

## 后续范围

继续推进实际子代理绑定和委托、冷工具目录、MCP 名称入口、session/turn、配置/自定义能力、
其余 UI 位置、主模型流和开发工具。Claude Read/Bash schema、生产模型、安装包和长期性能
门槛仍未宣布完成；MCP 权限查询尚未覆盖所有 scoped 别名。
