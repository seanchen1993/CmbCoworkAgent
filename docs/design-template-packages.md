# 本地模板包

新建设计的“上传模板”支持 HTML、ZIP 和文件夹。导入后模板持久保存在应用数据目录 `design-template-packages/<id>/`，原文件移动或删除不影响后续使用。已导入模板可再次选择。

## 支持范围

- 完整 HTML 和相对路径引用的 CSS、JavaScript、图片、字体及 JSON。
- 浏览器版 React/Vue、Ant Design 等组件库；保留原有脚本加载顺序。
- Babel Standalone + `text/babel` JSX。无需安装 npm 依赖。
- 自动发现所有 `.html`/`.htm` 页面，优先选择 index、template、example，支持手动切换入口。
- 嵌套页面和包内 `../` 资源路径。

需要安装依赖、编译 TSX/Vue SFC 或后端服务的源码工程须先构建为可运行的静态目录。本功能不执行包内的 npm 或安装脚本。只有库文件而没有 HTML 时会提示补充入口。站点根路径引用（如 `/assets/...`）会提示改为相对路径；远程资源会提示离线限制。

单选 HTML 时只导入可发现的资源依赖，不复制整个所在文件夹。运行时拼接的资源路径无法完整静态发现，此类模板请导入 ZIP 或整个模板目录。

## 预览和生成

导入预览通过只监听 `127.0.0.1` 的随机端口服务访问，URL 包含随机令牌。服务仅支持 GET/HEAD，只读取已登记的包内文件，使用 iframe/CSP sandbox 隔离模板，且没有应用 preload 或 Node API。应用退出时停止服务。

创建页面保存模板 ID 和选定入口。每次生成前，宿主将模板复制到当前设计目录的 `template/<id>/`，后续生成不覆盖该设计已修改的依赖。代理获得入口位置、资源前缀和有上限的文件索引，按原模板框架和主题生成完整 HTML。压缩库不进入提示词；继续改稿时也读取持久化源码，而非包含内联库的预览文档。

生成页面位于设计目录根部，其资源应引用 `./template/<id>/<入口目录>/...`。框架模板的后续修改走完整源码改稿，避免 DOM 局部补丁与 React/Vue 重绘冲突。模板附图生成也使用有本地依赖上下文的代理流程。

保存和重新打开继续使用设计自己的依赖。ZIP 导出包含完整资源树及当前 HTML/Tweaks，排除临时 `.draft-*`/`.source-*` 文件；导出拒绝符号链接。独立 HTML 沿用既有资源内联导出能力，复杂资源包推荐导出 ZIP。

## 导入限制

ZIP 最大 120 MB；最多 5000 个文件、单文件 30 MB、HTML 5 MB、解压总计 200 MB。拒绝绝对路径、目录穿越、重复路径和符号链接；失败清理不完整导入。忽略 `node_modules`、`.git`、`__MACOSX` 等非静态资源目录。

## 验证

```sh
npm run typecheck
npm run test:design-templates
DESIGN_TEMPLATE_FIXTURE=/absolute/path/cdn.zip npm run test:design-templates
```

浏览器测试使用 Playwright；可以通过 `CHROMIUM_EXECUTABLE_PATH` 指定 Chrome。默认覆盖多目录静态包、隔离预览、生成产物预览和 ZIP 导出后的独立运行。附件模式还覆盖 React/Ant Design 表格、搜索、状态筛选、日期面板和提示消息。
