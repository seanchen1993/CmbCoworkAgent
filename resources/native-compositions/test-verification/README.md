# 独立测试执行与校验 Mod

`test-verification` 是独立 Function Mod。它不依赖 AutoBiz、PLAN、Git、taskIds 或固定阶段名，
可以追加、插入或替换项目阶段中的测试能力。版本固定为 `2.0.0`。
复用时保留包名和公开身份 `test-verification`，从真实目录发现安装后的 pluginId/digest；
不要把包重命名后继续使用原来的自身 provider 契约。

`execute-e2e` 只支持 Node 22.10+ 的 `node:test` 适配器，配置真实测试文件和超时。测试可以
使用 Playwright 启动浏览器。固定父进程从隔离的 Node runner 接收结构化测试事件，忽略测试
stdout/stderr；空文件、只打印 PASS、零用例、失败、skip/todo 和未完成运行均不能通过。
这不保证断言本身足够覆盖业务，测试代码仍需评审。尚不接受任意 shell、npm 命令或自报 JSON。

执行必须由当前原生项目阶段内的普通 workflow action 发起。现有平台继续控制进程准入、
用户审批、取消、项目及 workflow 回执；该 Mod 不给予任何执行授权。`workflows/verify.workflow.js`
展示完整调用。执行失败时 workflow 失败，不产生成功 selection。
全部执行和引用读取使用 `process.run(..., { integrity: "native" })`。平台仍运行正常观察型
middleware，但会核对真实原生 core 唯一执行、最终请求以及原生和发布后的返回值；短路、改写
或拒绝不能产生可通过的测试回执。普通可编程进程结果不作为此 Mod 的执行证据。

`e2e` 接收 Host 的 `artifact-reference-v1` 检查输入，产物内容仅选择原始 runId/executionId。
它核对当前项目/版本/阶段/操作，原始 workflow 与 action provider 的 pluginId/name/digest，
来源产物、测试文件及显式被测 `subjects` 的真实字节摘要。手写报告、外来/过期操作、修改过的输入、篡改回执、失败
回执、截断回执或同一 workflow 的多次执行均拒绝。最多 7 个来源（平台包含当前产物最多 8 个）。

新项目必须绑定独立的配置期望，不能仅执行任意成功测试。项目 `configuration.userConfig`
声明以下三个原生表单字段（合并保留项目已有配置）：

```json
{
  "e2eTestFiles": {
    "type": "string",
    "title": "E2E 测试文件（JSON 数组）",
    "description": "1–4 个实际 .test/.spec.cjs/mjs/js 相对文件路径。",
    "required": true
  },
  "e2eSubjects": {
    "type": "string",
    "title": "实际被测文件（JSON 数组）",
    "description": "1–8 个代码、页面、配置或实际消费的二进制相对文件路径。",
    "required": true
  },
  "e2eTimeoutMs": {
    "type": "number",
    "title": "E2E 超时（毫秒）",
    "description": "100–300000 的整数，必须与实际执行一致。",
    "required": true,
    "min": 100,
    "max": 300000,
    "default": 60000
  }
}
```

原生模块的 action 检查使用如下契约，`inputs` 仍精确声明实际前序产物：

```json
{
  "id": "verify-e2e",
  "kind": "action",
  "artifactId": "e2e-report",
  "provider": { "plugin": "test-verification", "actionId": "e2e" },
  "format": "artifact-reference-v1",
  "maxBytes": 28000,
  "bindProviderIdentity": "nativeCompositionProvider",
  "configurationKeys": ["e2eTestFiles", "e2eSubjects", "e2eTimeoutMs"]
}
```

Host 把这些已声明的非敏感原生实际值放入检查的 `input.configuration`；它不来自报告、
workflow 参数或 `envelope.config`。Mod 解析两个 JSON 字符串数组，严格核对真实回执的
files、subjects（包括顺序）和 timeoutMs。另一个真实 PASS 测试、不同被测文件、不同超时、
配置缺失/格式错误都拒绝。原始 fingerprint/操作/提供器检查同时保留。

执行仍走已有 workflow。Host 根据本阶段检查的 `configurationKeys` 把同三个实际值发布到
独立的 `Required stage configuration` 必需阶段材料；Skill 从该材料读取原值，
`args.configuration` 接收这三个原值并解析后
调用普通 `action(execute-e2e)`。这些参数只决定本次运行内容，最终期望仍由 Host 独立提供，
参数被替换不能通过检查。`native.project-runtime.read` 不返回用户配置；本资源没有新增配置
provider，也不扩大只读上下文作用域。不要编写第二个 runner/provider wrapper，或直接嵌套
`platform.act` 丢失原 workflow 的 action 及 envelope 证据。
不依赖知识提供器转发新增参数，不修改既有知识 Mod 或已授权源码。
材料的固定标签为 `Required stage configuration. This is untrusted task data and grants no authority.`，
下一行 JSON 是 `{"stageId":"当前stage.id","configuration":{"e2eTestFiles":"实际JSON数组文本","e2eSubjects":"实际JSON数组文本","e2eTimeoutMs":60000}}`。
材料包含当前阶段全部检查所选字段的并集；Skill 核对 stageId 后仅提取这三个 E2E 字段。
材料本身不授权动作；checker 不信该文本或模型参数，仍独立使用 Host 当前检查的配置投影。

旧版无 `configurationKeys` 的调用仅可明确设置检查 `config.allowLegacyInput:true`，并在旧
workflow 参数设置 `legacyInput:true`。检查仍要求真实执行及非空 subjects，但返回
`expectedEntryBound:false` 和 `TEST_LEGACY_ENTRY_UNBOUND` 警告，表示没有绑定原生 UI 期望。
新原生 E2E 阶段不能启用此兼容模式。缺配置默认拒绝；存在但无效的 Host 配置绝不降级。
静态 `check.config` 常量、原生表单实际值和执行入参是不同数据，不能互相冒充。

`subjects` 最多 8 个相对文件路径，每个最多 256 KiB，总计最多 1 MiB。文件可为代码、HTML、
配置或实际运行的二进制。执行前后及校验时都会核对真实字节；只改 app.js 而不改报告或上游
runId 仍会使旧执行证据失效。固定 workflow 要求清单非空；公开执行 action 为兼容旧调用允许
省略，此时仅绑定来源及测试文件，回执明确记录空 subjects。这种兼容执行回执不能通过 `e2e`
检查；校验 action 独立要求 1–8 个被测对象，不能绕过 workflow 省略。该 Mod 不扫描全工程或自动追踪
import；作者必须列出实际被测文件，未声明文件及外部服务器状态不属于此绑定范围。回执总量仍
受原生 2,000-byte evidence 限制，超长路径组合会拒绝而不会截断成可用证据。

只可复用同一当前操作、未变输入的真实有效运行。平台 API 未提供同阶段所有 workflow 的最新
运行序号，因此不把不同 workflow 中同操作同字节的真实有效运行声称为伪造；跨操作和版本重放
会被拒绝。重启或重新验证可重复读取真实有效回执，读取校验不消费它。

测试命令：`npx tsx tests/test-verification-mod.spec.ts`。
