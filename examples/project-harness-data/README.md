# 数据开发入门

编辑 devclaw.harness.json 的有序节点和 skills/*/SKILL.md。节点只描述 skill、必需产物、可选 JSON schema 和人工确认。example 是隔离测试文本，不会写入项目工作区。

修改节点后运行 openwork plugin compile <源码目录> --out <新目录>，再运行 doctor/test；AI 创作使用 project_compile(id,revision)。编译生成标准 devclaw.project-runtime.json 和逐个缺失产物/通过样例，实际测试使用宿主校验器。

复用业务能力通过 project_actions 与 project_bind_action 绑定已安装且授权的公开动作。重新编译保留绑定；不复制业务 hooks。测试不执行模型、技能或业务动作，也不证明代码或数据质量。

## 与文档插件一起使用

安装本插件和 `examples/project-docs-lite` 后，从项目对话打开“项目能力”。
“检查数据质量要求”可以与文档插件的“整理项目需求”一起用于项目对话。
完整流程则可排在文档流程之后，将前一步的 `draft` 交给“前一套流程的需求文档”。平台会把文件放到本流程的 `incoming/requirements.md`，无需手工复制。

交接文档是可选的；单独创建数据项目时仍使用原来的输入和阶段。原有产物检查和人工确认都保留。
