# Design HTML 预览

Design 模式使用交互预览。工作目录文件标签仍使用静态预览，两者分别构建文档。

## 已验证的交互

- 普通与委托事件、Tab、页面 dialog、alert/confirm/prompt，以及编辑或注释模式退出后恢复交互。
- 下拉选择、checkbox/radio、日期、滑块、details、popover、表单必填/邮箱校验、文件选择 change 事件。
- Canvas 绘制、SVG 修改、中文锚点、本地 CSV/data URL 下载。
- A/B 方案保留完整文档中的共享弹窗、template、body/html 属性和其他方案节点，仅隐藏非活动方案。
- 本地 CSS、嵌套 `@import`、媒体条件、样式表 disabled 切换、图片与 srcset。
- 本地 JS 的 defer 顺序、ES 模块相对导入/导出、循环依赖和字符串常量动态 import。
- 字符串常量 `fetch()` 引用的本地 JSON，脚本和样式表子目录内的相对资源。
- 固定视口内滚动；100vh、固定定位与缩放基于可见画布尺寸，不随文档长度膨胀。

## 范围和限制

- 文件读取限于 HTML 所在目录及其子目录；依赖文件可以通过 `../` 引用该范围内的资源。目录外、绝对路径及远程资源不通过本地读取器加载。
- `fetch()` 和动态 `import()` 目前转换字符串常量路径。运行时拼接的本地资源路径、构建工具专用资源表达式，以及复杂 import-map scopes 不能保证兼容。
- CSS `@import` 支持普通和媒体条件。包含 layer/supports 条件的 import 保留给浏览器，不转换为本地内联资源。
- 外部页面导航、普通表单导航及新窗口按预览策略拦截。真实 OAuth 登录和后台 API 仍依赖相应服务、网络和跨域策略。
- 远程脚本、样式、图片和 iframe 保留原页面引用，是否成功加载由网络、原页面策略和沙箱权限决定。
- 页面下载允许带 download 属性的 Blob/data URL；应用顶部的 HTML/资源包导出由原有导出功能负责。

## 回归验证

执行 `npm run test:design-html`。测试在独立 Chromium 中使用实际文档构建器、导航拦截器与编辑脚本，不使用真实账号或后端服务。

可通过 `CHROMIUM_EXECUTABLE_PATH` 指定本机 Chrome，否则使用 Playwright 已安装的 Chromium。测试包含完整文档和 A/B 方案两条路径。
