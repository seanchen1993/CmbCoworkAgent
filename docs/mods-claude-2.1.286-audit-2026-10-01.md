# Claude Code 2.1.286 安装包核验与四方向兼容边界

2026-10-01 从 npm 官方固定版本包完成下载、校验、PE/Bun 模块提取、内嵌声明解码和原版探针。
没有替换本机全局 CLI，也没有修改 UAT。研究目录为
`C:\ai\CmbCoworkAgent-mods-v2\output\claude-code-2.1.286-analysis`。

来源：[官方 Windows x64 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/2.1.286)。
完整元数据保存在研究目录 `npm-native-metadata.json`，包含固定 tarball URL 和 SRI。
本次“反编译”是只读提取 Bun 模块表及压缩声明资产，没有恢复原始 TypeScript 或原生机器码。
不执行提取代码；仅执行通过完整 SRI 校验的官方二进制，第三方代码不进入产品。

## 可复核产物

| 产物 | 值 |
| --- | --- |
| native.tgz | 111087799 字节 |
| SHA512 SRI | `sha512-Cvq6m1e2eP0p47Ze+b6rw+DjXMhLCcT9g8ZKfFDxT0NB9d9mjHcNs6Qjb1oTqbO6AsN3Ie1DIqWt50J7kboz7g==`，下载后完整比对通过 |
| claude.exe | 245092000 字节，原版 `--version` 为 `2.1.286 (Claude Code)` |
| PE SHA256 | `0b6ecec8edef1ce3069682f696c894d1553239faa6b84e56e167a3ced88fa333` |
| manifest.json | 2349 个模块，43884444 字节内容，0 个 sourcemap；包含各资产偏移与 SHA256 |
| 内嵌声明 | `extracted/claude-code.d.ts-015d8aac.txt.zst`，Node 24 zstd 解码为 `readable/claude-code.d.ts` |
| 声明大小 / SHA256 | 565597 字节 / `6d21c8b4131b935bb12219747ed7179eb54cd3ea64c87e44d7768183de10a454` |
| 285 → 286 声明差分 | `embedded-declarations.diff`，新增 195 行、删除 11 行 |

`extract_bun.py` 复用前次只读提取器，所有路径和模块指针均有边界检查。
解码使用 Node 24 `zlib.zstdDecompressSync`，并非把压缩数据当作可执行模块加载。

## 原版行为探针

探针运行设置独立 `CLAUDE_CONFIG_DIR`，并启用官方提示的
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`（同时设置 `ENABLE_FUNCTION_HOOKS=1`）。
命令为原版 `claude.exe plugin test <研究目录>/probe`。最终日志
`model-contract-probe.log`：10 通过、0 失败。

| 探针 | 项数 | 证明内容 |
| --- | --- | --- |
| 模型结果 | 4 | answered、empty-reply、aborted、api-error 的联合结果与 usage 原样穿过 SDK |
| fork / 预取消 | 2 | nothing-to-fork 明确结果；预取消使测试 provider 零调用 |
| prompt.fill | 2 | Hook 返回直接 `{ isFilled }`，不是 operation 的 `{ value }` |
| skill.prompt | 1 | 测试 Engine 事件接收完整正文并返回替换正文 |
| tool.describe | 1 | 测试 Engine 事件接收来源并返回说明及 isDeferred |

关键区别：官方插件 `$.prompt.fill` SDK 的实际返回还带 `text`、`cursor`，探针中为空草稿
`""`、`0`；声明中的 Hook 返回仍是 `PromptFillResult`。不能把 SDK 外层便利结果误当事件返回。
`prompt.read` 保持 operation 语义。Skill/工具展示用 testing Engine 的 noun 驱动，插件 SDK
并不提供同名 `$.skill.prompt` / `$.tool.describe` 主动调用入口。

首次探针误用上述入口、把 SDK 结果当事件结果时出现 4 个失败；原始输出保存在
`initial-probe-mismatch.log`，随后修正探针并完整重跑。测试器提供下层结果，没有调用付费模型、
真实 composer 或真实模型工具绑定；这些探针不替代本工程真实 HTTP、Electron 与权限测试。

## 四方向差分和本轮决策

| 方向 | 286 核实结果 | 本工程本轮边界 |
| --- | --- | --- |
| 模型取消、effort、usage | 相对 285 核心类型未变，6 项旧探针继续通过 | result-v1 与旧协议显式区分；独立取消、预算清理及真实传输单独验收 |
| 技能正文、工具说明、草稿 | skill.prompt、tool.describe、prompt.fill 核心字段未变 | 正文按宿主 read_file 实际消费时扩展；tool.describe 不模拟 ToolSearch；草稿通过真实 composer 接口 |
| 本地 Plugin/Harness Flow | 未发现本工程 Flow 的同名官方产品协议 | 属于宿主适配，沿用项目绑定、Stop、完成 gate 和阶段权限，不称为官方界面复刻 |
| 项目底线与 Claw 附加规则 | 本工程策略不是官方 manifest 等价字段 | 附加规则只能收紧、不可授权修复或阶段推进；Autobiz 用真实检查收据汇报 |

286 新增 `prompt.compose`：调用事实包含 model/promptModel、surfaces、tools、outputStyle、traits，
返回有序 `{ sections: [{ id, text, scope }] }`；shared 在 session 前，缓存边界由引擎放置。
它允许整份系统提示词的附加、替换、重排、删除。本轮不扩展既定四方向来模拟此能力；
已加入事件目录并明确标为 unavailable，精确依赖它的插件会得到不兼容说明，不被当作未知自定义事件。

286 还新增 `$.prompt.submit({ asUser: true })`，模型读取时省去插件文字包裹，但 Hook 的 origin
仍是 plugin 并保留来源。本工程 prompt.submit 尚未接入，所以 asUser 也未支持，不降格成人工用户身份。
其他变化包括 prompt.section 对 compose section id 的说明、终端 ui.promptHint 的 tail。
未接入的终端展示、凭据、env.set 等边界仍见既有兼容矩阵。

新增目录回归：`src/shared/mods/v2/compatibility.test.ts` 36 项通过，日志
`output/mods-integrated-286-catalog-tests.log`。全量、构建、Electron 和性能结果应以本轮最终交付报告为准。
“四方向完成”不代表 286 全 API、全部 UI 或所有 Claude 运行环境完全对齐。
