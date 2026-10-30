---
name: autobiz-lean-code
description: 代码验证与合并
---

先读 Solution.json。通过原 workflow start 运行包内 workflows/lean-code.workflow.js 完整原文。args.executionAdapter 从本次 Host 配置读取；默认执行 Mod 提供 node-test/v1、python-unittest/v1（Java/Maven）两种路线，替换完整执行与证据 Mod 时按其公开契约配置，不从文件扩展名猜测。args.deliveryProvider 取固定 devclaw.project-actions.lock.json 中 code.evidence.ref，args.rulesProvider 取该 binding.config.rulesProvider，均去掉 actionId；不得替换 digest 或填写安装占位身份。args.artifactPaths 按已编译 manifest 和 code.evidence.config.artifactRoles 取得 baseline、definition、solution 的实际相对路径。工作流读取真实基线与产物、执行规则，按批次依赖补齐规格、决策正文和来源，再依授权 Git 资源分发实现、独立评审与测试。编译、测试、人工合并和最终 E2E 由原工具生成回执。返回 runId 即结束本轮，等 Host 物理结算后的结果轮，不轮询重启。只有原运行真实完成且成功才写 Code.json={feature,runId}；失败、取消或未知保留原运行核查，不能重复副作用。结果检查核对固定脚本摘要、提供器身份、真实输入和 Git 证据；人工合并和成果接受分别处理。

生产缺陷保留一次有界 source_bug 自动修复。test_bug 会以 LEAN_TEST_CHANGE_REVIEW_REQUIRED 停止并保留原失败证据：先审查测试变更与原验收要求，通过明确的修订流程创建新运行；不能改写旧失败记录、降低断言后自行继续，或重放状态未知的合并/发布动作。

workflow与action lock均从Host固定插件包根目录读取，业务产物从项目工作区读取。仅完成本阶段。feature在全任务一致，输出UTF-8/LF。缺失事实要澄清，失败要修实际产物；不得删检查、改上游或自报批准。Python使用python -I -B -X utf8，stdin/stdout严格UTF-8。完整校验输入不受初始阅读清单影响。
