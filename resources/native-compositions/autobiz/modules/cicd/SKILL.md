---
name: autobiz-native-cicd
description: 读取真实Code交付与此前确认产物，生成CI/CD准备清单和PR草稿，交由Host独立确认。
---

读取实际 CODE_RESULT.json、PLAN.bundle.json、DESIGN.bundle.json、SPECS.bundle.json 与 PRD.bundle.json。
输出 CICD.bundle.json：{feature,stage:"cicd",codeRunId,publication:{mode:"not-requested",status:"prepared-only"},files:{"CICD_CHECKLIST.md":"正文","PR_BODY.md":"正文"}}。
清单包括“## 交付范围”“## 验证证据”“## 发布状态”“## 已知阻断问题”“## 回滚计划”，引用实际runId和PRD/SPECS/DESIGN bundle路径。
明确写“未请求外部发布”和“prepared-only”，说明真实检查证据及仍需人工处理事项，不将准备成果说成CI/CD执行成功。
不要push、创建PR、触发流水线或部署。用户要求这些外部操作时，当前组合源缺少对应正式provider绑定；报告明确阻断，使用原安装/授权入口配置真实provider并重新编译后再做，不写伪造成功回执，也不对unknown自动重试。
旧阶段要求用户明确确认完成，现由Host对当前实际准备成果resultApproval独立确认，禁止写旧checkpoint/approved字段。
