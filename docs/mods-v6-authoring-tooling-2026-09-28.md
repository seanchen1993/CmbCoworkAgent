# V6 本地 Mods 作者类型工具

这次补齐从编写插件、声明状态到本机检查的关键步骤。作者无需手写主机 SDK 的类型存根；CLI 可以导出本机已覆盖接口的声明，并对插件入口与状态契约做严格检查。运行时权限、provider 可用性和 TypeScript 检查仍是三个独立结果，类型正确不会授予权限。

## 实际操作

工程根目录执行：

```powershell
npm run build
node bin/cli.js plugin check examples/mods-typed-counter --types
node bin/cli.js plugin types examples/mods-typed-counter --out examples/mods-typed-counter/.claude-plugin/types/claude-code/index.d.ts
```

`check --types` 同时返回插件摘要、注册结果、作者契约元数据和 `typecheck` 诊断。检查失败返回非零退出码。`types` 不带 `--out` 时把声明写到标准输出；指定文件时只允许创建新文件，避免覆盖已有插件代码或契约。升级声明请先将标准输出保存到另一个新文件，比较后再替换。

示例的 `contract.d.ts` 声明 `typed-counter.count` 为 number。将 `hooks/register.ts` 中状态写入值改为字符串，或者拼错状态键，`check --types` 会指出具体文件、行列与类型错误。安装并授权示例后，`/typed-counter` 每次执行将计数加一。

## 支持范围与安全边界

- manifest 的 `types` 只能指向插件目录内的 `.d.ts`，最大 256 KiB；它会进入源码快照与授权摘要。修改声明需重新检查授权。
- 按固定上游约定使用闭合契约：禁止 import、import type、export-from 和任何 triple-slash reference；模块扩展只允许 `claude-code`。
- 可提取 `EngineInterface` 字面量名和 `PluginState` 的插件名、状态键。计算属性、无法解析的状态类型和 dependency 注册汇总明确报告未验证或未实现。
- 输出标记为 `authoring-subset`。覆盖已列举的 command、agent.register/spawn、clock、state、environment、process、HTTP、session identity、简单 UI 与标准 globals；没有给未覆盖 SDK 增加 `any` 兜底，不能据此宣称完整 Claude SDK 类型兼容。
- `check --types` 只读取稳定捕获的插件源码、内置 SDK 声明和固定 ES 标准库。它忽略插件 tsconfig、编译器 plugins、Node/DOM 类型包与外部包解析。用户编辑器可以使用示例 tsconfig；CLI 仍使用独立的固定配置。
- TypeScript 编译器按需加载并随主进程构建为独立代码块；ES 标准库复制到 `out/resources/mods-authoring/typescript` 并随应用资源发布。普通没有 types 契约的插件加载不初始化编译器。声明解析缓存最多 32 项，不保留 AST。

生产构建的检查结果应为 `standardLibraries: "bundled-es-only"`。开发源码直接运行测试时可以出现 `development-es-only`，二者在报告中明确区分。CLI 回归额外禁止解析外部 TypeScript 包，验证构建产物不依赖开发环境的 TypeScript。

agent 作者声明支持本机已接受的角色注册字段，并保留 spawn 的 `{agentId?, model} | {deny}` 返回类型，调用者需要先处理拒绝；hook 不调用 next 而直接响应时可以不产生 agentId。角色只支持当前约束下的显式后台 spawn；permissionMode 仅 `default`/`plan`，不支持 bypassPermissions 或 fork。maxTurns 的 1..100 整数范围由运行时验证，类型声明附带范围说明。

## 本次没有宣称完成的部分

没有启用插件依赖的类型注册中心，因此声明不能证明跨插件 provider 已安装，也不会静默把依赖声明当成已生效能力。没有生成完整上游 testing kit、全量 UI/JSX 或尚未覆盖的 SDK 方法。元数据始终报告 `runtimeProvidersVerified: false` 与 `dependencyRegistry: false`。

相关代码检验位于 `src/main/mods/devtools/authoring-check.test.ts`，真实 Electron CLI 检验位于 `tests/mods-authoring-cli.spec.ts`。类型生成、专属文件创建、摘要变化、目录越界、闭合契约、外部类型读取和错误状态值均有对应回归。
