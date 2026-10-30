---
name: autobiz-lean-delivery
description: 交付准备与归档
---

先读 Code.json，再按需要读取已接受的RequestBaseline与Definition/Solution交付范围及实际检查结果。生成 Delivery.json={feature,codeRunId,publication:{mode:"not-requested",status:"prepared-only"},checklist,prBody,archive}。checklist含 ## 交付范围、## 验证证据、## 发布状态、## 已知阻断问题、## 回滚计划，引用真实runId及RequestBaseline.json/Definition.json/Solution.json/Code.json，明确“未请求外部发布”和“prepared-only”。使用tools/archive-delivery.py确定性读取这四个原文件并产生archive={文件名:{text:原始完整UTF-8文本,sha256:真实字节摘要}}，不让模型重述或重新格式化原文本。校验独立核对全部业务内容、原运行与归档字节。Host人工接受交付成果后结束；正式外部发布须另绑定实际授权provider，本流程不创建PR/流水线/部署或伪造已发布。

工具路径从固定插件包根定位；以项目工作区为cwd执行python -I -B -X utf8 <包根>/tools/archive-delivery.py，将stdout JSON作为archive，helper不接收stdin。仅完成本阶段。feature在全任务一致，输出UTF-8/LF。缺失事实要澄清，失败要修实际产物；不得删检查、改上游或自报批准。stdin/stdout严格UTF-8。完整校验输入不受初始阅读清单影响。
