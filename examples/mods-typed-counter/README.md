# 带类型检查的计数器 Mod

该示例把插件自己的状态契约放在 `contract.d.ts`，由 manifest 的 `types` 指向。`Register<"typed-counter">` 让编辑器检查本插件状态键、值类型与已覆盖的 SDK 参数。

在工程根目录先构建，再运行：

```powershell
npm run build
node bin/cli.js plugin check examples/mods-typed-counter --types
node bin/cli.js plugin types examples/mods-typed-counter --out examples/mods-typed-counter/.claude-plugin/types/claude-code/index.d.ts
```

第二个命令生成当前主机的作者类型子集，编辑器会使用本目录的 tsconfig。输出文件已存在时命令会拒绝覆盖；升级类型文件请先人工比较新版本 stdout 输出。CLI `check --types` 使用固定安全配置，忽略插件的 tsconfig 和 TypeScript plugins。

安装并授权这个插件后，在会话中运行 `/typed-counter`，每次加一。把 `register.ts` 中 `$.state.set` 的第二个参数改成字符串，CLI 会报告类型不匹配；把 `count` 改成未声明的键也会报错。

边界：生成的是明确列举的作者接口子集，不是完整 Claude SDK。没有为未覆盖方法添加 any 兜底。声明不授予运行权限，也不证明依赖插件已安装；跨插件 dependency 类型汇总尚未提供，会显式报告未解析。当前契约遵循闭合规则，不支持 import/reference。更改契约会改变授权摘要，重新检查和授权后使用。
