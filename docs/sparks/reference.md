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
| 作者类型模块 | 使用 `import type { Register } from "devclaw-mods"` |
| 内置创作 Skill 与工具 | 保留 `mod-authoring` 与 `mod_authoring` |
| 历史错误代码和日志 | 保留 `MODS_*` 等标识，便于准确定位 |

`devclaw-mods` 是应用内的作者类型模块，类型导入在编译时移除，不是 npm 运行依赖。
当前没有名为 `sparks` 的 CLI 命令或 npm SDK；JSON 字段、协议标识和实际工具名以本页为准。

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
未声明模型协议的包默认使用 `result-v1` 结构化结果。只有明确需要旧字符串结果的插件才声明兼容协议。
以前依赖本开发分支字符串结果的包可显式声明 `cmbCompatibility.modelProtocol: "legacy-v1"`。
运行协议更新后，编译摘要随之变化，需要重新确认授权；安装器不会改写社区源码。

历史 v1 的 `on.command`、`on.ui` 和 `turn.summary` 写法不属于本教程的 v2 注册接口。
迁移时按现有包协议分别处理，不能只修改版本字段。

## 用户配置与升级迁移

在灵件清单的 `userConfig` 中声明参数类型、标题、说明和必填条件。用户通过原生参数表单填写，
`register(on, options)` 接收当前作用域的有效配置。项目试用也使用该表单；创建草稿或打开表单
不要求先填完参数，批准代码和实际执行前则必须满足必填条件。

需要迁移旧参数时，可在同一份声明中使用 DevClaw 的可选迁移扩展：

```json
{
  "apiVersion": "cmb.mods/v2",
  "id": "document-helper",
  "entry": "main.ts",
  "userConfig": {
    "label": { "type": "string", "title": "标签", "description": "成果标签" }
  },
  "cmbCompatibility": { "modelProtocol": "result-v1", "userConfigMigrations": "v1" },
  "userConfigSchema": {
    "version": 1,
    "migrations": [
      { "fromVersion": 0, "toVersion": 1,
        "changes": [{ "kind": "rename", "from": "oldLabel", "to": "label" }] }
    ]
  }
}
```

未声明迁移版本的旧配置按版本 0 处理；后续版本需逐版本声明连续路径。当前只支持字段
`rename` 和 `remove`，不执行迁移脚本。`cmbCompatibility.userConfigMigrations` 与
`userConfigSchema` 必须同时声明；它们是本平台的显式迁移协议，不能推定其他运行环境已支持。
旧平台无法理解必需迁移时应拒绝该声明，不向未经验证的旧版本分发。

迁移经过原生确认、当前版本和配置修订核对；取消、冲突、缺少路径或加密存储不可用时保留
原配置。敏感参数由主进程使用系统加密存储处理；迁移不向模型或日志返回明文。
导出插件只携带参数定义、默认值和迁移声明，不携带本机保存值、原目录授权及执行权。

## 导入社区兼容插件

在“自定义设置 → 基础功能 → 灵件与使用设置 → 我已添加”上传单个插件的 ZIP，或选择插件根文件夹。
保留原来的 `.claude-plugin/plugin.json`、`hooks/hooks.json` 和源码相对路径；
不用改名、换成 DevClaw 的模板或把源码粘贴进聊天。整个社区仓库里有多个插件时，
先选中其中一个插件目录；不能把整个仓库当成一个灵件。

安装后点击“检查社区兼容性”。检查会分别显示事件入口与源码中的 SDK 使用情况，
指出已识别的不支持项或需要确认的接口。它不会代替实际运行，也不会自动批准权限。
随后核对所需能力、应用到当前聊天，用作者提供的命令或示例任务试用。

多个灵件改写同一块界面时，排在前面的灵件可能直接替换后面的内容。例如内置示例
`token-weather` 会直接提供输入框上方的天气条，同一组合中的 `replay-theater` 入口
因此可能被覆盖。需要编辑回放时，在当前助手组合中暂时取消天气组件，保留回放组件后
再执行编辑。宿主保留原包的替换规则，不擅自拼接作者没有请求合并的界面；详见
[绘制界面](interface.md)。

函数入口使用 `register(on)`，通过 `$.ui.resolve` 构造受支持的界面元素。历史包的协议标识由兼容层保留，不要求改写第三方源码。
`.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` 均按 ESM 源码处理；`.cjs` 后缀不意味着可以
使用 Node 的 `require`。工作区文件、模型、进程和网络仍通过获准的宿主接口访问。

原生工具中的 `Read/Write/Edit/Bash` 对应 DevClaw 的读、写、编辑和执行工具；
兼容适配保留真实工具的最终参数检查和权限。没有等价实现的参数或工具不能靠改名
冒充支持。二进制读取返回 `{ base64 }`；如果项目输出策略不允许二进制内容，会明确拒绝，
不会用文本或损坏的数据替代。

`$.tool.register` 默认按需装载工具：模型先看到名称，通过搜索取得需要的工具定义，
后续步骤才可调用；显式 `isDeferred: false` 则直接提供定义。原生工具仍使用已有执行与审批流程。
目前 `Glob/Grep/MultiEdit` 没有等价的工具兼容适配；静态检查遇到这些明确名称会报告不支持。
动态计算的工具名称无法仅靠扫描确定，报告会标为需要验证。

社区包回归使用固定版本的示例源码，保留原始许可、版权和来源哈希。测试分别检查目录和 ZIP
安装、实际事件及原生工具链；测试中的模型回执和危险命令执行器受控，不表示已执行真实
模型服务或破坏性命令。源码仓库内的溯源记录见[社区示例来源与验证范围](../mods-community-source-provenance.md)。

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

本说明依据当前应用源码、作者类型与能力目录维护。外部插件按具体来源和版本检查，安装成功或示例通过不代表所有插件全面兼容。第三方示例的原始许可、版权与源码来源随相应包保留。

本地验证范围及构建差异见[本轮交付记录](../mods-conversational-authoring-delivery-2026-10-09.md)。
该记录用于确认能力边界，不替代具体安装包的发布说明。
