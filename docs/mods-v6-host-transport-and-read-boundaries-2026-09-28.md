# V6 宿主执行、网络与只读配置：已接能力和明确边界

基线是本地固定提取的 Claude Code **2.1.283** 声明及实现；不是“未来所有 Claude Mods 完全兼容”的承诺。本轮目标是让 DIY 流程真正调用网络、启动进程、跨创建 hook 返回继续收取输出，并在撤权时收敛资源。

## HTTP 和进程

- `http.fetch` 使用真实 Node HTTP/HTTPS 传输。hook 改写后的最终 URL、method、headers、body 必须经过本次原生审批；每个重定向重新审批。首次批准后计时 30 秒，包含后续审批和完整响应体。4xx/5xx 正常返回，不伪装成传输错误。303 无条件转 GET（包括 HEAD），按固定提取实现复核。
- 主动使用 identity 编码；不支持压缩响应、凭据 auth handle、Unix socket、隐式代理。请求体最多 512 KiB，响应体原始字节最多 256 KiB，UTF-8 解码后的序列化结果另有线协议上限。超限明确报错，不假称上游 4 MiB 等价。
- `process.run` 与 `process.spawn` 均使用 argv，不拼 shell 字符串。cwd、环境覆盖、stdin/input 与最终 argv 一并审批。命令以当前系统用户权限运行；**cwd 不是文件访问沙箱**。
- `run` 默认 30 秒、最多 10 分钟；非零退出码正常返回。每个输出流保留前 256 KiB，同时持续排空其余输出，避免管道死锁。截断位置不生成半个 UTF-8 字符。
- `spawn` 首次 pull 才启动，独立 `started` 只在真实启动确认后完成；安静进程不必先输出才能离开创建 hook。数据每块最多约 32 KiB，队列在 1 MiB 暂停读取，额外 128 KiB 是硬上限保护。结束值独立于 chunk，提前 return/撤权会关闭进程。
- Windows 通过现有 Job controller 的新增 argv 模式运行，直接执行目标程序、保留精确空参数/引号/反斜杠。Job 限制不允许 breakaway；父目标退出后清理后代，再等待剩余输出排空。controller 持有创建宿主的真实进程句柄，宿主崩溃也关闭 Job。旧 PowerShell/cmd 模式保持原行为。
- Unix 使用进程组 TERM/KILL 收敛普通后代；主动建立新会话的恶意程序仍需操作系统级沙箱才能强制约束。没有把进程组声称为 OS 沙箱。

## 构建与回归证据

`scripts/build-windows-background-job-controller.mjs` 根据源码/二进制 SHA-256 缓存决定是否重编；Windows `predev`、`prebuild` 和 Windows 打包均接入。非 Windows 普通构建不调用 C# 编译器；跨平台 Windows 打包要求资源含新协议。生成 exe 已本地重编用于验证，不能发布旧协议资源。

本轮独立后端验证包含真实本地 HTTP server、真实子进程，而非仅 mock：

- `http-sdk.test.ts`：14 项，审批前无请求、每跳审批、303 精确语义、跨源去凭据、超时/取消/超限、发布前撤权。
- `process-sdk.test.ts`：15 项，精确 argv、stdin/env、非零退出、首次 pull、静默启动 ACK、2 MiB 慢消费不丢数据、背压无消费取消、UTF-8 截断、进程树、宿主崩溃。
- 原 `windows-background-job-controller.test.ts`：9 项旧 PowerShell/cmd 回归通过。
- `tests/support/mods-resources-e2e.ts` 的真实 Electron + utilityProcess + production IPC 端到端用例已通过：最终 hook URL 审批后真实请求、argv 非零返回、创建 hook 返回后的输出/结果/成功审计、后台 timer 与取消、拒绝网络零请求、撤权后真实 child PID 消失。证据在 `output/mods-v6-validation/e2e-resources/resources-evidence.json`（本地验证产物，不提交）。
- `scripts/mods-v6-resource-performance.ts` 测量 5 个安静进程等待 pull 时的宿主 CPU/RSS 及关闭耗时；不把子进程内存排除后的数字称作整体内存。

2026-09-28 安静窗口单次 Windows / Node 22.23.2 测量：5 个进程启动共 136.83 ms，2.011 秒等待期间宿主 CPU 采样 0 ms、RSS 增加 69,632 字节，全部关闭 12.88 ms。该数字仅描述本次宿主采样，受系统计时精度影响，不代表绝对零 CPU，也不包含 child/controller 内存。结果保存为 `output/mods-v6-validation/resource-performance.json`。

## settings.read / env.get

`settings.read()` 接口只返回宿主提供的实际 effective 配置，放在 `cmbdevclaw` 命名空间，避免伪造 Claude 的 `permissions` 或配置文件。任何 `source` 选择明确拒绝：本工程没有与 Claude user/project/local/flag/policy 五层逐一等价的来源。输出是深拷贝，经过内容保护和权限复查，最多 256 KiB。

`env.get` 的许可是两者交集：编译时在源码中发现的字面量名称，以及宿主明确列出的基础环境变量。编译声明写入 digest，并由开发检查报告展示；直接动态名称拒绝，无法静态识别的别名不会获得额外权限。Windows 名称按系统语义不区分大小写。输出再次经过内容保护；不存在的允许项返回 undefined。模型 API key 等凭据不在基础 allowlist 中。

## 为什么 env.set 本轮没有假实现

固定上游声明明确承诺：修改影响之后启动的 Bash、MCP 与 `process.run`。本工程目前有两个架构事实：

1. `src/main/agent/local-sandbox.ts` 在实例构造时生成并保存 `this.env`，后续不同沙箱/系统后端各自使用该快照。
2. `src/main/mcp/capability-service.ts` 使用跨会话共享的连接缓存，fingerprint 基于 connector/plugin 配置；已经启动的 MCP 进程没有会话环境 revision，也没有按会话拆分连接所有权。

仅给新 process backend 增加 overlay 会造成“set 成功，但 Bash/MCP 不生效”；修改 Electron `process.env` 则会污染其他用户任务。要完整接通，需要 per-session 环境版本、所有命令启动后端接线、按 session/revision 隔离的 MCP 池、配置优先级、旧连接释放、撤权回收和跨会话回归。这不是补一个 setter 的开发量。

因此本轮不暴露一个返回成功但缺少传播语义的 `env.set`。这不妨碍主要 DIY 链路：每次 `process.run/spawn` 已可传明确审批的 `env`；MCP 继续使用原配置中的环境变量。需要一次修改影响所有后续工具/MCP 的插件，仍属于明确未完成的兼容项。
