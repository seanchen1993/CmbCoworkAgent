# AutoBiz 原流程 → Mods 交付报告

这是项目流程的消费方；实际报告能力由独立安装的真实 AutoBiz 插件提供。
此源码目录尚未绑定本机动作，不能把它直接作为已完成配置的演示插件。

1. 安装并启用改造后的 `AutobizDevOps_Plugin_Kanban_latest`，在目标工作目录明确批准其 Mods 源码版本。
2. 从宿主公开动作目录取得 `collect-evidence`、`generate-report` 的真实安装 UUID、编译摘要与 schema。
3. 运行 `scripts/package-autobiz-delivery-project.ts <目录结果.json> <新的交付目录>`，按原 doctor、合同测试和 pack 入口生成绑定后的 ZIP。也可在原项目作者工具使用 `project_actions`、`project_bind_action` 完成同样绑定。
4. 安装输出 ZIP。在项目会话的“项目能力”中先添加 AutoBiz 原流程，再添加“交付检查与报告”。后者“AutoBiz 已核验资料与源码”选择前者的 `verified-context`。
5. 检查并预览后明确启动。原 AutoBiz 检查、人工确认和工具批准保持。完成后宿主将真实资料与声明范围内源码正文交给报告流程。

报告阶段 Skill 只写输入说明；随后宿主按顺序调用 collect-evidence → generate-report，第一步的结构化结果传给第二步。
generate-report 真正读取输入、核对 SHA、写报告和 `delivery-report.json` 后才返回成功；宿主再检查文件结构，并等待人工确认。

动作锁只是数据，不是授权。安装 UUID、提供方摘要、平台协议版本或 schema 变化时必须重新检查与明确绑定，旧包不能自动借用新提供者。
不保证业务质量，不把报告生成称为执行测试、部署或验收通过；最终质量状态保留 `needs_review`。
