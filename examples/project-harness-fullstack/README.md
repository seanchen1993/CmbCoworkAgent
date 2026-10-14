# 全栈开发入门

编辑 devclaw.harness.json 的有序节点和 skills/*/SKILL.md。节点只描述 skill、必需产物、可选 JSON schema 和人工确认。example 是隔离测试文本，不会写入项目工作区。

修改节点后运行 openwork plugin compile <源码目录> --out <新目录>，再运行 doctor/test；AI 创作使用 project_compile(id,revision)。编译生成标准 devclaw.project-runtime.json 和逐个缺失产物/通过样例，实际测试使用宿主校验器。

复用业务能力通过 project_actions 与 project_bind_action 绑定已安装且授权的公开动作。重新编译保留绑定；不复制业务 hooks。测试不执行模型、技能或业务动作，也不证明代码或数据质量。
