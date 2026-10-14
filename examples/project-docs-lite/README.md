# 两阶段文档项目

这是普通插件格式的轻量项目包：`plugin.json`、运行声明、一个 Skill、隔离合同样例。无需 Python 或企业字段。

在包含本轮 CLI 的构建中执行 `openwork plugin doctor <本目录>`、`openwork plugin test <本目录>`，再 `openwork plugin pack <本目录> --out <新的.zip文件>`。产物通过原插件安装入口导入。

起草阶段检查 `draft.md` 存在，复核阶段检查它及 `review.json` 的结构，并要求人工确认。文件存在和结构通过均不宣称业务质量合格。

运行声明是宿主接口；不要直接编辑项目数据库或伪造阶段状态。隔离测试只执行产物校验，不调用模型或批准阶段。完整创建、运行、拒绝、修复和重开场景需宿主入口验收。

参见仓库 `docs/sparks/project-plugin-cookbook.md`。
