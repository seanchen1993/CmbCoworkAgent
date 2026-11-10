---
name: 市场 W+ · 批量导入
description: Excel 拖拽上传、模板下载、解析进度及成功、部分错误、全部错误状态。
designSystemKey: builtin:wplus
mode: prototype
platform: desktop
scenario: enterprise
---

# 市场 W+ · 批量导入

本模板是市场 W+ 设计系统的专属页面参考，使用 React 18、Ant Design 5 与本地 Babel。

- 页面入口：`../../batch-import.html`。
- 设计映射：`../../DESIGN.md`；共享样式：`../../theme.css`。
- 保留原有组件库、主题、脚本加载顺序与离线依赖，按用户需求调整业务内容。
- 优先使用宿主提供的模板包入口与资源路径。输出一个完整 HTML 页面，不将压缩依赖内联到模型上下文，不改用远程 CDN。
- 原页面的演示数据与模拟业务逻辑仅作参考，不能表述为已经接入真实业务服务。
