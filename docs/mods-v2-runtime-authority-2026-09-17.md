# Mods v2 运行目录与宿主权限基础

基线 `ba02fc60`，分支 `codex/mods-v2`。本批修正已有执行链的权限来源，作为开放真实
子代理 SDK 的前置基础；不把未接入的代理、主模型流和 UI 站点记成完成。

## 检视发现和实现

`createAgentRuntime` 原本已区分 workspacePath（授权项目）和 fileRoot（实际 checkout），
但 LocalSandbox 的 Mods 绑定使用 workingDir 作为授权项目，Function 文件 SDK 又固定
读取授权项目。这会使 worktree 里的工具失去原项目授权，或由文件 SDK 读取项目中的同名文件。

现在 LocalSandbox 接收宿主显式传入的 modWorkspace，并在绑定上保留 executionWorkspace。
grant、插件状态、审计和输出策略继续使用授权项目；session.cwd、文件路径归一化、真实读取
使用当前执行目录。目录不会从 projectDir、父线程或字符串结构推导。

文件 SDK 捕获绑定实例，在读取前后和发布边界检查存活、配置代次及后端路径权限。目录
列表隐藏被后端拒绝的条目，过滤掉的条目仍计入 1024 项扫描上限。存在运行绑定但缺少
queryTool 时拒绝，不降级到项目探针；没有活跃绑定的普通本地项目才允许纯权限探针。
明确属于已结束运行的调用、失效异步作用域和未绑定子代理不能由此取得普通项目权限。

另一处问题是 runtime 的 blockedToolNames / filesystemAccess 主要作用于模型 middleware，
SDK 可以绕开目录和模型入口。现在原生 SDK、MCP、注册工具的查询/准入和模型工具目录使用
宿主提供的禁用清单；MCP 同时校验实际 scoped/canonical 名称。无 tool.check Hook、无
强制输出策略时也执行这些约束。被拒绝的注册工具按模型工具错误返回，不执行 guest 代码。

只读属性由 runtime 在构造后端前明确给出，不依赖之后 setReadOnlyShellEnforced 的时机；
MCP 绑定也接入实际运行的信号与只读属性。旧版 Mod dispatch 已移除找不到子代理绑定时
借用 main 后端的回退。模型工具上下文使用宿主解析出的实际 agentId。

宿主修订为 `desktop-runtime-authority-v15`，旧摘要需要重新批准。无数据库迁移或新增依赖。

## 验证记录

首轮相关测试 369/369 通过；其后新增运行时拒绝到模型工具错误的回归，12/12 通过。
独立 LocalSandbox / SQLite 测试验证授权项目与执行目录不同、同名文件来源、受限 .git
读取、绑定释放、无 Hook 时的禁用工具、构造时只读、注册工具拒绝和目录过滤。
FunctionSession 实测并发的两个执行目录，cwd 与规范化文件路径分别保持自己的宿主上下文。

新增 Electron E2E 使用真实 IPC、React 命令、utilityProcess、文件 SDK 与 LocalSandbox。
测试入口提供一个独立执行目录及工作树路径边界，验证授权项目和实际读取分离；它不执行
git worktree 创建，也不能替代完整 workflow/coordinator 子代理验收。
43/43 组 Electron E2E 通过，新增场景截图已人工检视。普通构建已恢复，不含测试入口。
Node/Web 类型检查通过，跨进程检查 37/37 通过；改动代码规范检查无新增问题，保留
runtime.ts 中已核对基线的一个显式 any。单 worker 全仓 Vitest 为 448 个文件、3409 项：
3378 通过、26 失败、5 跳过；26 个失败与 permission 基线逐项同名同因，未增加失败。
最终全仓运行包含全部 370 个 Mods 专项用例；没有声明全仓全绿。

独立回归首轮 81 套件中 71 通过、10 失败。其中两项是源码检查要求 rootDir 后紧邻
agentId；新增字段改变了该排列，实际身份传递仍存在。恢复原有字段顺序后，这两套件独立
复跑通过，原始报告保留。其余 8 项与 MCP 批基线一致（7 项同因、workflow-worktree
同为 180 秒超时），最终已验证 73 套件通过。字段排列修正未改变运行行为，性能数据为
该排列修正前的构建；对应源码检查复跑日志为 runtime-authority-*-recheck.txt。

性能对照基线为 ba02fc607e，四轮 ABBA/BAAB、每版本 800 次采样。宿主 MCP 转发链使用
真实 ModEngine 与 SQLite，透传 dispatcher，不含 VM、强制策略 worker、队列绑定或网络。
P50 为 10.3741 → 10.5964 ms，P95 为 11.1171 → 11.3704 ms，增加 0.2533 ms（2.28%）。
基线 bundle SHA-256 为 9ad488bcb23fcabc07b5e917a2a5d69fe9897b5d32c7fae1697eaf32d2adb6d8，
当前为 6f1a70bd4f499846626a0daac6c0f1bf9ff24c7cc19b4a48e816a290af11b791。
Electron 中实际读取禁用路径的 P95 为 2.3110 → 2.4057 ms（+4.10%）；1000 次 noop 的
P50/P95 为 8.0362/9.3403 ms，结束时 pending 为 0。本轮局部指标低于 5% 门槛，不能据此
宣布整体性能通过；两小时压力、实际远端服务和最终安装包仍未验收。

本地证据保存在 output/mods-v2-validation/runtime-authority-{types-final,process,
lint-final,e2e-first,performance} 对应日志/JSON；E2E 截图为
output/mods-validation/e2e/function-execution-scope.png。

## 下一步

SDK tool.list 中合并的注册项尚需与完整冷工具目录一起过滤；执行/查询入口已拒绝被禁项，
不能把尚未统一的 SDK 展示列表当成执行授权。共享后端的 deepagents 子代理仍需宿主显式
实例绑定和只读执行上下文；当前不会移除其
MODS_TOOL_AGENT_UNAVAILABLE。冷工具目录、MCP SDK 到注册工具、完整 Claude 原生工具
schema、代理委托、主模型流、其他 UI 站点、开发工具、安装包和两小时压力仍待后续阶段。
