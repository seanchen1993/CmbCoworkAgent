# 工具输入与 JSON Schema 契约审查（2026-09-23）

本轮对照 Claude Code v2.1.278 官方 `ToolCallEnvelope`、`ToolCallReserved`、
`ToolCallResult`、`ToolCheckInput`、`BuiltinToolInputs` 和 `ToolSpec.inputSchema`。
官方类型来源为 `C:\ai\claude-code-v2.1.278\mods\types\claude-code.d.ts`。
JSON Schema 注解和 type 声明形状另对照项目已安装 Ajv 随附的官方 2020-12
`meta/validation.json`、`meta/meta-data.json`。不新增通用 validator 依赖或放开可执行 schema。

## 修复的两项已声明能力缺陷

1. 之前 `title: 1`、`description: {}`、`$comment: false`、`examples: "text"` 和
   `type: ["string", "string"]` 都能注册，并替换现有工具。现在注册时递归校验注解类型及
   type 数组唯一性，错误返回 `MODS_TOOL_SCHEMA`；失败替换保留原条目。默认值仍是任意
   JSON 注解，不填充、不强转，也不要求 default/example 本身满足旁边的校验条件。
2. 之前工具结果只要带字符串 deny 且不带 result，就直接跳过校验，允许混入官方 deny
   分支禁止的 context/ref/text/isError。现在这些字段与 deny 互斥。真实 guest 的非法结果
   进入既有 optional-hook fallback；未调用 next 的坏 hook 被跳过，宿主 core 执行一次。
   合法 `{ deny: "原因" }` 仍直接结束调用且不执行 core。该 fallback 不替代宿主授权，
   权限、lease、取消和危险参数检查继续位于实际执行路径。

先加入失败测试：16 项中 14 失败、2 通过；然后只修改 `tool-schema.ts` 和 `tool-sdk.ts`。
新增 `tool-schema-contract.test.ts` 使用真实 QuickJS guest 和 FunctionSession，覆盖失败注册
不会替换现有工具、仍可调用原工具，以及 ref/组合/对象枚举/默认注解的真实执行。

## 当前 JSON Schema 支持边界

| 类别 | 状态 | 实际边界 |
| --- | --- | --- |
| 类型和对象/数组属性 | adapted | type、properties、required、additionalProperties、单 schema items；根 schema 必须是对象，根 type 只能省略或为 object；根参数必须是对象。 |
| 组合与常量 | adapted | anyOf/allOf/oneOf/not、enum/const；深比较支持对象键顺序差异，oneOf 恰好一个匹配。enum 必须非空，仍是有界子集。 |
| 范围、数量与唯一值 | adapted | 字符按 Unicode code point 计数；字符串/数组/对象数量范围、数值范围、精确十进制 multipleOf、uniqueItems；超计算预算拒绝。 |
| 定义引用 | partial | 已支持根 `#/$defs/Name` 和 `#/definitions/Name`，并同时执行 ref 的 sibling 约束。名称限首字符英文字母、后续字母数字下划线点横线，总长 1–64；循环、缺失目标、外部引用及其他 JSON Pointer 明确拒绝。 |
| 注解 | adapted | title/description/$comment 是字符串，examples 是数组；default 可为 JSON 值。只作为注解，不改变工具输入。 |
| 其他 schema 词汇 | unsupported | regex/pattern、patternProperties、format、tuple/prefixItems、contains、条件 if/then/else、dependentRequired/dependentSchemas、unevaluated*、动态/递归/远程引用及 dialect 切换。未知关键字注册时拒绝，不静默跳过。 |

沿用上限：schema 16000 字符、256 个访问节点、12 层（含引用展开）；输入 64000 字符；
校验最多 20000 步、递归深度 32。每插件 32 个工具、每会话 128 个、元数据合计 256000
字符。共享 JSON 的大小、纯数据和危险键约束继续执行。宿主身份参数
tool/tool_use_id/agentId 不允许作为根注册参数，包括根 ref/组合间接声明。

之前 authoring/matrix 中“refs unsupported”的文字落后于已有提交 825339c1；应按上述有限
本地引用改为 partial。当前不是完整 Draft-07 或 2020-12 实现。

## 原生工具与官方名称的差异

原生 SDK 只接受应用真实绑定的 read_file/write_file/edit_file/ls/glob/grep/execute/task_output；
内建模型入口保留实际 adapter schema，MCP 使用当前 host adapter 的 schema。没有把注册工具
的 schema 替换给原生/MCP adapter。上述名称、结果映射、部分默认值和权限流程与官方不同，
整体保持 adapted。

官方 Bash/PowerShell 的 timeout、description、dangerouslyDisableSandbox，以及 Read 的 pages
等目前并非上述 SDK 的受支持参数；继续明确拒绝，不能通过忽略参数制造兼容。尤其不能把
dangerouslyDisableSandbox 或插件自报 consent 转成沙箱豁免或用户授权。execute 的后台运行、
task_output 的 block/timeout 使用应用已有真实后端，保留范围、类型、lease、generation 校验。
不因为同名字段或相似行为宣称官方完整 BuiltinToolInputs / BuiltinToolResults 兼容。

结果包络修复仅保证 deny 与已知结果字段互斥；应用的 context 大小上限、ref 规则及实际
原生输出结构仍属 adapted，本轮未新增每个官方内建工具的输出 schema。

## 验证边界

5 套 58/58 通过，包含新增 16、registry 12、SDK 4、model-tools 12、SDK integration 14。
集成覆盖真实本地后台进程、八种取消/撤权/替换/lease 结束、零超时轮询、宿主工具禁用和
同一原生任务 Mods 关闭对照。结果不是 Autobiz 业务验收。最终 Electron 和整包验证由主任务
使用合并快照进行；此 worker 未单独运行新一轮 Electron。
