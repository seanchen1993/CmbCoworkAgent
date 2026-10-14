# Mods SDK 静态兼容检查

本说明对应 Mods／Harness 方案 B1。交付状态以[实施进度](mods-harness-implementation-progress-2026-10-09.md)中的集成和回归结果为准。

在工程中使用 Node 22、npm 10+，构建后运行：

```powershell
npm run build
node bin/cli.js plugin check C:/my-plugins/example
node bin/cli.js plugin inspect C:/my-plugins/example --strict-compatibility
```

普通检查保留包结构及事件提供者检查的退出语义，同时输出 SDK 诊断。严格模式要求事件报告和 SDK 报告都通过；没有 SDK 报告、明确不支持或无法确认的访问都会返回失败。

## 如何阅读报告

| 字段 | 含义 |
| --- | --- |
| `valid`／`packageValid` | 包和注册结构检查结果，不代表业务验收 |
| `compatibility` | 事件提供者支持范围，保留 `registration-events-only` 语义 |
| `sdkCompatibility` | 不可变源码快照上的静态 SDK 使用报告 |
| `sdkCompatibility.usages` | 可识别的调用路径、相对文件、行列和内置方法支持情况 |
| `sdkCompatibility.digest` | 与编译及注册检查相同的源码摘要 |
| `runtimeVerified: false` | 未证明模型、权限、项目、网络和当前会话能实际执行 |
| `parameterCoverage` | `selected-protocol-differences`，只检查特定协议差异，非完整参数验证 |
| `truncated` | 超过输入、节点、递归或工作量边界，不能据此给出严格通过 |
| `authorized: false` | 此检查没有授予插件执行权限 |

`bounded` 表示内置会话 SDK 存在该方法。它仍受用户授权、宿主入口和当前配置约束；不能将报告当作安全证明或全分支运行测试。

## 能检查的形式

入口来自实际 manifest／hooks 模块的 `register` 导出，支持可确认的导出别名、相对模块重新导出、常量函数引用和 `.catch` 回调。SDK 的作用域身份通过符号解析追踪，不把普通同名 `$`、业务变量、注释或字符串误认为 SDK。

检查覆盖直接调用、字面量索引、可选链、常量别名、解构和闭包引用。把 SDK 传给外部函数、返回或保存到普通对象，动态索引，可变回调，隐式 `arguments` 以及无法确定的注册方式均会标为未验证。代码可以继续使用这些 JavaScript 形式，但不能依赖当前静态分析获得严格通过。

`engine.create` 能改变能力表，而且自身没有普通会话 SDK。覆盖该事件的通配／否定 Hook 一旦引用 SDK，也不能按普通会话的能力目录判定通过。自定义提供者须在真实宿主场景单独验证。

## 协议迁移提示

- `model.complete` 的 `timeoutMs` 位于第一个请求对象，未声明协议默认使用 `result-v1`。显式 `legacy-v1` 返回字符串，切换协议时也要更新返回值处理。
- `model.complete` 第二个选项对象只接受 `signal`。
- `tool.register` 省略 `isDeferred` 或传 `true` 时默认延迟：模型先收到名称目录，通过 `mods_tool_search` 搜索后，下次模型请求才包含 schema；显式 `false` 立即提供 schema。`tool.describe` 返回的 `isDeferred` 优先于注册值。加载状态绑定运行作用域与实际定义，替换或撤销后必须重新加载。
- 这两类请求中的对象展开、动态字段或非字面量参数不会被推定为已经验证。其它方法的完整参数校验仍由真实宿主完成。

静态分析本身不执行作者代码，也不重新读取快照之外的文件。整个 `check` 仍会在受控 guest 中执行模块顶层代码及注册收集，业务 Hook 不会因检查而被触发。通过检查后，仍需安装、授权并运行实际业务场景。
