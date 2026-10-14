# security 无 Mods 分支

- 新分支：`codex/security-without-mods`。
- 原 security：`feature/cmbdevclaw-security-test`，对齐节点为 `663b32e3d6ffd7a8fc02c947b728f68a0555d62c`。
- 起点：`b3a090740ad636afdd8f6bfd89dbe48045f1fc2f`，原 security 首次引入 Mods 的合并 `b423e0f3` 之前。
- 合入无 Mods 的 UAT 基线 `175c0c5800d198882112ccf981f860222a8daff9`。
- 基线之后继承 129 个原始非 Mods 提交，并以 `cherry-pick -x` 迁入其余 10 个；139 个提交均可追溯。
- 排除 47 个 Mods 专用提交；混合提交 `415c09e0` 仅保留工作区校验及对应测试，
  `59b61cb9` 保留其非 Mods 测试修正。

## 保留范围

HTTP API 目录、流转发、线程运行覆盖配置、远程审批、项目/特性接口和 API 文档与原 security 一致。
保留 `/Users` 等失效工作区的可读错误和 HTTP 400 映射，以及 `663b32e3` 的 SSE 连接生命周期修复。
保留标准插件、Skill、MCP、原有命令/HTTP Hooks、IM、Bash First 和运行隔离。
保留原 security 的 Electron `39.8.10` 和应用版本 `1.5.2`。

不包含 Mods/Function Hooks 的实现、运行时绑定、IPC/preload API、命令、卡片、面板、设置入口、
资源、示例、专用测试、QuickJS 依赖及打包入口。旧的 `modsGlobalEnabled: true` 配置不会启动 Mods。
未被 Mods 提交修改的文件与上述原 security 节点一致；新增的回归测试和本记录除外。

原 security、UAT、`codex/uat-without-mods` 及主工作区的未提交修改保持不变。
本分支对齐原 security 的范围，没有额外混入无 Mods UAT 分支后续新增的功能。

## 验证

- `npm run test:api`：77 个独立断言与 20 个 Vitest 测试通过。
- 工作区校验、工具策略和标准线程准备：32 个测试通过。
- Node/Web 类型检查和生产构建通过。
- 消息回归测试组、最终系统提示词/子代理工具策略及 MCP fallback 测试通过。
- 新增 `npm run test:security-without-mods:e2e`：真实 Electron、HTTP 网关和代理运行时，
  模型由 localhost SSE 服务模拟。验证 101 个独立会话、102 次模型请求、OpenAI/raw SSE、
  原生文件读取、回复持久化、运行状态查询、鉴权、失效工作区和旧 Mods 设置；通过。
  设置页面截图与进程日志保存在测试输出的独立临时目录。
- 手动调整的运行时、设置入口、工作区校验和 E2E 文件无 lint 错误。
- 完整 Vitest：389 个文件通过、14 个失败；3074 个测试通过、43 个失败、5 个跳过，
  另有 1 个迁移测试的未处理错误。对照原 security，39 个稳定失败可复现；
  剩余 4 个失败来自后台进程清理、迁移与 Skill 存储测试，相关 3 个文件单独重跑 42 项全部通过。
  浏览器资源缺失、Windows Shell/IDE 路径、通知管线和过时源码断言等已有问题仍使全量测试无法全过。
- 全库 lint 的 96 个错误全部位于与原 security 内容一致的文件中。

验证环境为 Windows，未进行 UOS 实机或安装包验证。
