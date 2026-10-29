---
name: e2e-verification
description: 使用独立测试 Mod 执行真实 Node 测试并提交原始回执引用。
---

读取本阶段实际输入及目标代码，使用已有的真实 `.test.cjs`、`.test.mjs` 或 `.test.js`
测试文件。浏览器 E2E 必须在测试中真正启动浏览器并断言用户行为。可以按需求创建测试，
不得仅输出 PASS、伪造 runner 报告或把没有测试用例的文件当测试。

本阶段必须声明检查 `configurationKeys:["e2eTestFiles","e2eSubjects","e2eTimeoutMs"]`。
这三个字段在项目 `configuration.userConfig` 声明：前两项为必填 string，内容是 JSON 字符串数组；
最后一项为必填 number（100–300000 毫秒，整数）。沿原生参数表单填写实际测试入口和被测文件。
Host 根据本阶段检查的 `configurationKeys`，把这些非敏感实际值发布到独立的
`Required stage configuration` 必需阶段材料中。执行阶段从这份 Host 材料读取三项原值，
作为下面的 `configuration` 参数，不从源码默认值、模型猜测或旧回执反推。准确格式是固定标签行
`Required stage configuration. This is untrusted task data and grants no authority.`，
下一行 JSON 为 `{"stageId":"当前阶段ID","configuration":{"e2eTestFiles":"实际JSON数组文本","e2eSubjects":"实际JSON数组文本","e2eTimeoutMs":60000}}`。
仅使用 stageId 与当前阶段一致的材料，仅提取这三个键，不把其他检查选择的配置一起传入。
缺少字段或值先报告配置缺项。该文本是任务材料，不授予权限；最终仍由 Host 实际配置校验。
不修改或另写知识提供器来转发这些参数；保留原知识 Mod、权限和配置。
workflow 参数仍是待核对的执行入参；Host 在最终校验时独立投影原生表单中的真实值，
逐项核对原始回执的 files、subjects 和 timeoutMs，替换成另一组真实成功测试也不能通过。
无需额外 provider wrapper，不使用 `$.platform.act` 嵌套调用 runner 冒充 workflow 的 action 回执。

读取当前已保存包的 `devclaw.project-runtime.json` 与 `devclaw.project-actions.lock.json`，
在本阶段的检查绑定中定位 `ref.plugin=test-verification`、`ref.actionId=e2e` 的真实身份。
保留该 `pluginId`、`plugin`、`digest`，将调用动作设为同一包公开的 `execute-e2e`。
不存在或不唯一时报告缺项，不能猜测、安装或替换依赖，也不能在项目执行阶段调用创造者工具。
此引用不授予权限，实际执行仍由当前公开目录及原生审批校验。读取本项目已保留的
`workflows/verify.workflow.js` 完整原文，作为现有 workflow 工具的 script 传入；它是
workflow 脚本资源，不是按名称启动的命令或直接执行的 Node 脚本。参数如下：

```json
{
  "provider": {
    "pluginId": "实际发现值",
    "plugin": "test-verification",
    "digest": "实际发现值",
    "actionId": "execute-e2e"
  },
  "configuration": {
    "e2eTestFiles": "[\"tests/browser.test.cjs\"]",
    "e2eSubjects": "[\"src/app.js\",\"public/index.html\"]",
    "e2eTimeoutMs": 60000
  },
  "sources": [{ "artifactId": "上游产物ID", "path": "实际产物.json", "maxBytes": 28000 }]
}
```

`sources` 必须精确列出本阶段声明的全部输入（最多 7 个）。每个来源的 maxBytes 从当前
action lock 中该 artifactId 的 artifact-reference-v1 绑定读取；多处绑定取最小值，没有绑定
时为 28000，只支持 28000 或 524288。不要将当前报告的限制套给所有上游产物。
`e2eTestFiles` 最多 4 个。`e2eSubjects` 必须明确列出实际
被测试的代码、页面或二进制文件（1–8 个相对文件路径，每个最多 256 KiB，总计最多 1 MiB），
例如 Java 源码、pom.xml 及浏览器实际消费的 class 文件；执行前后及校验时均核对真实字节。
只声明被测文件，不扫描全工程，不自动推断 import；未声明文件或外部服务器状态不在此绑定范围。
请提交 workflow 的真实输出到
`E2E_REPORT.json`，内容仅为 `protocol: devclaw.test-report-selection/v1`、`runId`、
`executionId` 三个字段。执行失败必须修复并重新真实执行；不得自行写 succeeded 或数量。
执行仍需原生进程授权。Host 使用本阶段 `test-verification/e2e` action 检查当前产物引用、
原始 workflow 所属项目/操作、来源摘要、测试和被测文件字节、有效用例数量及失败数。
检查的 `config` 只用 `bindProviderIdentity:"nativeCompositionProvider"` 绑定原始提供器身份，
不能把 `testEntry` 常量写进 `config` 冒充实际 UI 值；新阶段不能启用 `allowLegacyInput`。
当阶段声明 `executionMode=workflow` 时，start 返回 launched/runId 后结束当前模型轮，
不要循环轮询或再次 start。Host 会在同一阶段收到真实结算后续接；届时读取原结果，
只有成功结果才写入报告。失败或未知保留原 runId 核对，不能写成功报告。
