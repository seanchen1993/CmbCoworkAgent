# Mods v2 MCP 工具入口对齐

基线 `721f51af`，工作区 `C:\ai\CmbCoworkAgent-mods-v2`、分支 `codex/mods-v2`。
本批继续补 MCP 名称入口与权限目录，不代表所有对齐阶段已完成。

## 对照证据

重新提取固定版本 Claude Code 2.1.273 的 PE/Bun 内嵌程序，程序 SHA-256 为
`19654006672b6da7c945115eea99ca10051796016df563a65b3f0c7d72720ef0`。
提取脚本检查 PE 节、载荷边界、52 字节记录、指针和输出目录，记录 1963 个模块；
没有 source map，没有恢复原始 TypeScript。文件保留在忽略目录
`output/claude-code-2.1.273-analysis/`，不进入源代码或安装包。

`formatted/chunk-hr43png0.js` 的 `Ecr`（约 199275 行）从会话工具目录解析 MCP 名称，
调用 `JZ`；`JZ` 进入与 SDK 工具调用相同的引擎工具链。这证实 `mcp.call` operation 的
core 还会触发 `tool.call`。相反，直接 `tool.call` MCP 名称不会额外触发 `mcp.call`
operation。该结论来自固定程序的静态调用链，不能把它记成真实上游服务器联调通过。

## 实际变化

- `$.mcp.call(server, tool, args)` 解析当前宿主工具，再进入 `tool.call` Hook；后者收到
  宿主名称、独立 tool_use_id 和调用插件来源。改参、拒绝、合成结果及有界多次 next 生效。
- `$.tool.call({ tool: "mcp__…", ...args })` 支持真实 scoped/canonical MCP 名称。
  不拆分字符串并据此赋予服务器权限；宿主按已有元数据精确匹配，歧义拒绝。
- MCP SDK 的 Hook ref 只在当前调用中选择受保护的原始结果，保留 content 顺序和
  structuredContent。放弃 ref 的替换结果不携带旧 structuredContent；实际错误不被改成成功。
- 权限查询与执行共用 scoped 别名生成规则。已有运行使用自己的 peekTools；冷普通项目
  只能使用配置指纹仍有效的缓存，不做连接初始化。过期的已绑定会话不回退到全局目录。

名称解析只取元数据。临时 MCP 绑定在进入可选 Hook 之前释放；实际 next 再建立绑定，并
检查解析时与执行时的提供者、工具、schema 和连接代次指纹。不能在持有临时绑定队列时
等待插件调用其他工具，避免原生/MCP 嵌套等待形成循环。宿主最后的参数审批、配置复核、
调用记录与输出保护保持在真正执行入口。

宿主修订为 `desktop-mcp-tool-routing-v14`，旧快照需重新批准。没有数据库迁移或新增依赖。

## 验证与边界

专项已覆盖命名 MCP → 工具 Hook → 原生读取、来源与固定身份、最终参数、拒绝/合成、
精确别名、解析后 schema 改变、失效绑定和无副作用权限查询。47 个相关文件的 353 项
测试全部通过。真实 Electron E2E 42/42 通过，包含 stdio MCP 服务器、工具 Hook 内嵌
原生读取、named/direct 两入口、拒绝无执行，以及配置删除后失效。

宿主层性能采用 `node tests/run-function-host-performance.mjs 721f51af mcp-routing`，
四轮 ABBA/BAAB、1000 个元数据、每版 800 次采样：P50 10.6285 → 10.8902 ms；P95
11.3315 → 11.6233 ms（+2.5751%，约 +0.2918 ms）。包含真实管理器与 SQLite，dispatcher
直通；不含 VM、策略进程、绑定队列、真实网络。E2E 中实际读取禁用路径 P95 为
2.6563 → 2.7131 ms（+2.1383%）；跨进程 noop 1000 次 P50 8.3689 / P95 9.1687 ms，
pending 为 0。以上是局部门槛，不能作为整体性能验收。

Node/Web 类型检查通过；改动代码无新增 ESLint 问题，runtime 中保留 1 个基线显式 any。
初次全仓 Vitest 误用默认并发，64 项失败和 3 个 worker/通信异常，包含 5 秒超时；
保留 `vitest-mcp-routing-unbounded-workers.json`。按此前基线单 worker 条件重跑，
不调整单项时限或 QuickJS CPU 配额。单 worker 全仓 3392 项：3359 通过、28 失败、
5 跳过。26 项与基线同名同因；额外两项是未改动的浏览器脚本 `STACK_TRACE_ERROR` 和
checkpoint worker 的 1 ms 计时器次数断言（5 > 5），其后相同代码独立复跑两项均通过。
复跑的两文件 27 项中只剩既有 Windows 路径断言失败；没有将复跑覆盖到原全仓报告。
这两项的瞬时失败原因尚未完整定位，不声明全仓全绿。

81 个独立套件中 73 通过、8 个基线问题；7 项同因，另 1 项仍是 workflow-worktree
180 秒套件超时。跨进程 37/37 通过；真实运行的 runtimes/frames/replies/pending/calls
均归零。普通应用构建已恢复，E2E 测试入口不在产物中。

日志位于 `output/mods-v2-validation/`，当前专项、E2E、类型和性能文件均以
`mcp-routing-` 开头。反编译静态证据不增加上游真实 fixture 的累计 39 项计数。

冷工具目录、通过 MCP SDK 调用插件注册工具、子代理权限绑定/委托、Claude Read/Bash
完整 schema 与结果映射仍需后续接入。主模型流、session/turn、其余 UI 和开发工具也未
宣布完成；整体验收和两小时资源压力门槛保持未完成。
