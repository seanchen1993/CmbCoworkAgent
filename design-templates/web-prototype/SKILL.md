---
name: Web 原型
description: 通用桌面 Web 原型模板，适合产品网站、内部工具和视觉探索。
od:
  mode: prototype
  platform: web
  scenario: web-prototype
---

# Web 原型

当用户需要可用的 Web 原型、页面概念或桌面端产品界面时使用。

## 参考文件
生成前读取这些文件：
- `template.html`：起始结构和 edit-mode 契约。
- `layouts.md`：布局模式。
- `checklist.md`：最终质量检查。

## 输出规则
- 生成一个完整 HTML 文件，内嵌 CSS 和 JavaScript。
- 仅保留一个 `/*EDITMODE-BEGIN*/.../*EDITMODE-END*/` JSON 块。
- 如果存在当前 DESIGN.md，使用其中的 token。
- 除非用户要求其他语言，否则使用具体中文产品文案。
- 如果用户要的是工具或应用，不要用落地页套话填充；首屏必须有实际可用内容。
