# Design 直接编辑

实现日期：2026-10-29。方案和进度见 [执行清单](./plans/2026-10-29-design-direct-edit-execution.md)。

## 使用

- 页面生成后默认进入编辑模式；顶部“编辑”入口独立于“微调”开关。
- 单击选中元素，双击文字打开原位输入。Enter 保存，Esc 取消；明确支持多行的文字使用 Shift+Enter 换行。
- 点击浮动工具条中的父级标签，可以逐层选择深处的容器、卡片或区块。
- 使用工具条“删除”或 Delete/Backspace 删除选中元素。文字输入期间这些按键只修改字符。
- 顶部撤销/重做和编辑模式下的 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z 共享修改历史。
- 切换到“预览”可操作原型中的按钮、表单等交互。批注和绘制保留各自模式。

这些操作不调用模型。文字和样式使用增量更新；静态删除可局部更新，恢复子树或修改框架源码时重建一次预览。

## 保存与恢复

直接编辑发送 `design-edit/1` 命令，主进程从正式源码解析目标并应用修改，不将运行中的整页 DOM 写回文件。

- SQLite 同事务保存源码、Tweaks、撤销记录、幂等回执和文件投影任务。
- 相同命令重试不会重复提交；版本、文字槽或相关参数变化会拒绝陈旧修改。
- 文件写入失败由现有 outbox 重试；已经提交的数据库版本仍然保留。
- 切模式、返回历史、导出和开始下一轮 AI 修改前等待编辑提交；宿主切换模式卸载 Design 时也捕获尚未提交的文字和样式。
- 导出和下一轮修改读取当前正式版本。编辑工具条、输入浮层和选框不进入导出文件。
- 老页面首次进入编辑时会补齐稳定节点身份，更新源码版本和旧定位锚点。

## 文案、图标和参数

编辑器修改具体文字槽，保留按钮里的 SVG、图标、属性和事件。格式化段落按命中的文字段编辑，不会拍平成整段纯文本。

受 Tweaks 控制的文字更新参数；共享参数默认拆分选中位置的绑定，其他位置继续使用原值。删除元素同时清理不再使用的绑定，撤销会恢复它们。

## React / Vue

支持以下有明确源码映射的情况：

- 内联 `script[type="text/babel|jsx|tsx"]` 中的 JSX 文本、字符串表达式和可删除 JSX 节点。
- Vue 的静态页面模板、内联 `template` 字符串和模板元素。
- 使用下面声明式数据协议的实例级文案和记录删除。

```html
<script type="application/design-edit+json">
{
  "data": { "records": { "item-a": { "title": "甲记录" } } },
  "bindings": {
    "a-title": { "kind": "text", "path": "/records/item-a/title" },
    "a-row": { "kind": "record", "path": "/records/item-a" }
  }
}
</script>
```

组件使用 `window.designData.data` 或 `window.designData.get('/records/item-a/title')` 读取声明式数据。对应 DOM 标记 `data-design-bind="a-title"` 和 `data-design-bind="a-row"`。记录以稳定 ID 为键，组件从当前数据集合渲染，删除配置记录后相应实例消失。

宿主安装的 `designData` 适配器也保留在独立 HTML 和 ZIP 中。框架修改保存源码或数据后重新加载，因此能经受组件重绘和重新打开。

任意运行时计算文字、重复组件的共享定义、第三方组件内部 DOM、不可访问的嵌套 iframe、Canvas 像素和没有源码映射的外部应用脚本，不承诺任意直接编辑；会显示受限能力，可通过 AI 源码改稿处理。包含运行代码或被必需脚本/表单关系引用的容器不能直接删除。

## 验证

- `npm run typecheck`
- `npm run test:design-sessions`：80 项单元测试，以及真实 DesignView/Chromium 浏览器回归。
- `npm run test:design-html`：完整 HTML、多方案、交互、资源、Canvas/SVG、下载等回归。
- `npm run test:design-templates`：隔离预览、资源包与独立导出。
- `npm run build`
- 编辑相关新增模块通过 ESLint。

浏览器回归使用已安装 Chrome；可通过 `CHROMIUM_EXECUTABLE_PATH` 指定。设置 `DESIGN_VUE_RUNTIME` 指向本地 Vue 全量浏览器构建，会额外验证真实 Vue 重绘；本次使用固定版本 Vue 3.5.13。React 测试使用项目已安装运行时，JSX 在测试桥中真实编译。

覆盖双击文字、中文 composition 事件、Esc 取消、键盘删除、图标保留、深层选择、撤销重做、离开保存、重开、HTML 下载、React/Vue 重绘和重复实例隔离。中文输入验证为自动化组合事件回归，未进行操作系统输入法人工测试。
