---
name: 市场 W+ · 筛选表格
description: 响应式筛选区、数据表格、排序分页、行编辑、列设置与密度切换。
designSystemKey: builtin:wplus
mode: prototype
platform: desktop
scenario: enterprise
---

# 市场 W+ · 筛选表格

本模板是市场 W+ 设计系统的专属页面参考，使用 React 18、Ant Design 5 与本地 Babel。

- 页面入口：`../../filter-table.html`。
- 设计映射：`../../DESIGN.md`；共享样式：`../../theme.css`。
- 保留原有组件库、主题、脚本加载顺序与离线依赖，按用户需求调整业务内容。
- 优先使用宿主提供的模板包入口与资源路径。输出一个完整 HTML 页面，不将压缩依赖内联到模型上下文，不改用远程 CDN。
- 原页面的演示数据与模拟业务逻辑仅作参考，不能表述为已经接入真实业务服务。
