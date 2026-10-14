# 开发参考

本页给出当前 Function v2 作者协议与对外名称的对应关系。精确签名由当前构建的能力目录和
类型检查器提供；不要从第三方最新文档推断本机已经支持某个接口。

[返回概览](README.md) · [事件与 API](events-and-api.md)

## 对外名称与兼容标识

| 内容 | 使用方式 |
| --- | --- |
| 功能名称 | DevClaw Sparks，中文“灵件”；单个能力称“一个灵件” |
| 文档入口 | `docs/sparks/README.md` |
| 插件清单字段 | 保留 `mods`，指向灵件清单 |
| 当前作者运行协议 | 保留 `cmb.mods/v2` |
| 源码与清单目录 | 教程保留 `mods/`，无需为名称变更移动旧文件 |
| 作者类型模块 | 保留 `import type { Register } from "claude-code"` |
| 内置创作 Skill 与工具 | 保留 `mod-authoring` 与 `mod_authoring` |
| 历史错误代码和日志 | 保留 `MODS_*` 等标识，便于准确定位 |

名称更新属于对外术语。当前没有名为 `sparks` 的新 CLI 命令、运行时模块或 npm SDK；
不要用新名称替换 JSON 字段、类型导入和实际工具名。

## 包结构和作者检查

推荐从[创建教程](create.md)的根 `plugin.json`、`mods/manifest.json`、`mods/main.ts` 开始。
`entry` 相对灵件清单目录解析。入口导出同步的 `register`，具体事件处理器可以异步，
以当前提供的作者类型检查。

加载器也支持函数 Hook 包结构：插件清单配合 `hooks/hooks.json` 和 `hooks/register.ts`。
其中 `hooks.json` 的 `modules` 指向入口，路径相对 `hooks.json` 所在目录，例如
`{ "modules": ["./register.ts"] }`。已有该结构的包无需为采用新名称而改成教程结构；
教程选用作者工具生成的原生 v2 格式，不表示它是唯一支持的包格式。

会话草稿是受控文本集合，最多 32 个文件、单文件 64 KiB，总量 256 KiB（含路径与文本）。
路径需为允许的相对路径，不能夹带 `.env`、`node_modules`、`.git` 或越界引用。
这些是作者草稿限制，不代表整个插件安装器的所有包格式或大小限制。

v2 的作者代码运行在受隔离环境中，通过宿主 SDK 使用能力；不是普通 Node.js 程序。
未声明模型协议的包默认使用 Claude 的 `result-v1` 结构化结果，不需要添加 DevClaw 专有字段。
以前依赖本开发分支字符串结果的包可显式声明 `cmbCompatibility.modelProtocol: "legacy-v1"`。
运行协议更新后，编译摘要随之变化，需要重新确认授权；安装器不会改写社区源码。

历史 v1 的 `on.command`、`on.ui` 和 `turn.summary` 写法不属于本教程的 v2 注册接口。
迁移时按现有包协议分别处理，不能只修改版本字段。

## 导入 Claude 社区灵件

在“自定义助手 → 灵件 → 我已添加”上传单个插件的 ZIP，或选择插件根文件夹。
保留原来的 `.claude-plugin/plugin.json`、`hooks/hooks.json` 和源码相对路径；
不用改名、换成 DevClaw 的模板或把源码粘贴进聊天。整个社区仓库里有多个插件时，
先选中其中一个插件目录；不能把整个仓库当成一个灵件。

安装后点击“检查社区兼容性”。检查会分别显示事件入口与源码中的 SDK 使用情况，
指出已识别的不支持项或需要确认的接口。它不会代替实际运行，也不会自动批准权限。
随后核对所需能力、应用到当前聊天，用作者提供的命令或示例任务试用。

多个灵件改写同一块界面时，排在前面的灵件可能直接替换后面的内容。例如官方
`token-weather` 会直接提供输入框上方的天气条，同一组合中的 `replay-theater` 入口
因此可能被覆盖。需要编辑回放时，在当前助手组合中暂时取消天气组件，保留回放组件后
再执行编辑。宿主保留原包的替换规则，不擅自拼接作者没有请求合并的界面；详见
[绘制界面](interface.md)。

兼容层保留 Claude 的 `register(on)`、`claude-code` 类型模块和 `$.ui.resolve`。
`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` 均按 ESM 源码处理；`.cjs` 后缀不意味着可以
使用 Node 的 `require`。工作区文件、模型、进程和网络仍通过获准的宿主接口访问。

原生工具中的 `Read/Write/Edit/Bash` 对应 DevClaw 的读、写、编辑和执行工具；
兼容适配保留真实工具的最终参数检查和权限。没有等价实现的参数或工具不能靠改名
冒充支持。二进制读取返回 `{ base64 }`；如果项目输出策略不允许二进制内容，会明确拒绝，
不会用文本或损坏的数据替代。

`$.tool.register` 默认按需装载工具：模型先看到名称，通过搜索取得需要的工具定义，
后续步骤才可调用；显式 `isDeferred: false` 则直接提供定义。原生工具仍使用已有执行与审批流程。
目前 `Glob/Grep/MultiEdit` 没有等价的 Claude 工具适配；静态检查遇到这些明确名称会报告不支持。
动态计算的工具名称无法仅靠扫描确定，报告会标为需要验证。

原包回归固定使用官方 [claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/569c5283d9a0a7ee7938df85bb32e4f48cbb8c86/claude-code/mods)
提交 `569c5283d9a0a7ee7938df85bb32e4f48cbb8c86` 的 `token-weather`、`blast-radius`、
`replay-theater`，保留源码和来源哈希。测试分别检查目录和 ZIP 安装、实际事件及原生工具链。
测试中的模型回执和危险命令执行器受控，不表示已执行真实模型服务或破坏性命令。

兼容按已验证的上游契约持续维护。某个包安装成功、静态检查通过或三个示例通过，
都不等于任意社区包及任意版本全面兼容。遇到失败，请保留原包版本、检查报告与错误码，
以便修复宿主适配；移植过的副本与原包验证结果分别记录。

## 能力目录的三个层次

1. **运行时目录。** 说明宿主有哪些接口，以及事件支持程度。
2. **作者声明。** 说明当前 TypeScript 检查接受哪些参数和返回值。
3. **运行授权。** 决定该来源在该会话、该版本能否实际调用。

三个层次都满足，才能使用相应接口。`bounded` 表示存在受限适配，不表示全面兼容上游；
仅有元数据的事件也不能当作已接入实际执行。

开发试用的精确方法与事件见[事件与 API](events-and-api.md)。模型应分页获取完整声明，
避免只看到第一页便猜测未显示的方法。

## 项目内的规范来源

这些源码链接供维护者查证实际契约，不需要普通使用者逐一阅读。

| 内容 | 规范来源 |
| --- | --- |
| 当前目录及最小示例 | [development-catalog.ts](../../src/main/mods/devtools/development-catalog.ts) |
| 作者类型声明 | [authoring-declarations.ts](../../src/main/mods/devtools/authoring-declarations.ts) |
| 开发试用允许范围 | [development-session.ts](../../src/main/mods/v2/development-session.ts) |
| 事件支持等级 | [compatibility-catalog.ts](../../src/shared/mods/v2/compatibility-catalog.ts) |
| 宿主 SDK 方法 | [sdk-capabilities.ts](../../src/main/mods/v2/sdk-capabilities.ts) |
| 桌面渲染位置 | [sites.ts](../../src/shared/mods/v2/sites.ts) |
| 草稿文件限制 | [authoring-bundle.ts](../../src/main/mods/devtools/authoring-bundle.ts) |
| 创作 Skill | [SKILL.md](../../skills/mod-authoring/SKILL.md) |

## 参考与版本说明

本套文档借鉴 Claude 官方按概览、创建、界面和事件分篇的阅读方式；DevClaw 能力以本工程契约为准。
相关官方页面：[概览](https://code.claude.com/docs/zh-CN/plugins/mods/overview)、
[创建](https://code.claude.com/docs/zh-CN/plugins/mods/create)、
[界面](https://code.claude.com/docs/zh-CN/plugins/mods/interface)、
[事件](https://code.claude.com/docs/zh-CN/plugins/mods/events)。

本地验证范围及构建差异见[本轮交付记录](../mods-conversational-authoring-delivery-2026-10-09.md)。
该记录用于确认能力边界，不替代具体安装包的发布说明。
