---
name: 数据看板
description: 面向运营、分析和管理场景的高密度看板模板，包含 KPI、图表、表格、筛选和决策状态。
od:
  mode: prototype
  platform: web
  scenario: dashboard
---

# 数据看板

用于后台管理、数据分析、可观测性、财务、CRM 或运营监控类看板。

## 参考文件
- `template.html`：看板基础结构。
- `layouts.md`：看板模块组合模式。
- `checklist.md`：看板质量检查。

## 输出规则
- 构建真实可用的看板界面，不要做成营销落地页。
- 包含筛选控件、指标卡、一个主图表区域、一个表格或列表，并在需要时加入空状态、错误态或告警态。
- 使用紧凑排版和等宽数字。
- 保留一个 edit-mode JSON 块。
