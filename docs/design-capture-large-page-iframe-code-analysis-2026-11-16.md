# 大页面卡顿、iframe 缺失及代码外露分析

日期：2026-11-16。范围：当前仓库代码审查及独立临时 Chrome 中的合成页面复现。本次未修改业务代码；未取得截图对应的原始 HTML 或该用户会话的性能记录。

## 结论与证据范围

| 问题 | 结论 | 证据范围 |
| --- | --- | --- |
| 大页面导致应用卡顿 | 预览编辑 ID 注入存在反复拼接整份 HTML 的热点，已测到秒级阻塞；资源内联和会话全量更新还会放大开销 | 真实源码函数、合成页面实测，不能视为用户现场耗时 |
| iframe 内容消失 | 当前抓取主动把所有 iframe 替换成“嵌入内容”，没有递归读取子页面 | 代码确认，同域 srcdoc iframe 复现 |
| 页面出现业务代码 | HTML 导入的微调脚本注入存在结构破坏缺陷：错误匹配 JS 字符串内的 `</body>` | 真实源码函数复现出 `function contact`、`${c.task}` 可见；截图文件是否命中同一条件仍需原文件确认 |

截图 1 的来源标记为“HTML 导入”，截图 2 为“网页来源”。两条路径共享后续预览处理，但不能把截图 1 的代码外露直接归因于网页抓取清洗。

## 一、大页面为什么会卡

### 1. 已测到的主要热点：给节点添加编辑 ID

`src/renderer/src/components/design/DesignView.tsx:980` 的 `prepareHtmlForSrcDoc` 在界面线程同步调用 `decorateDesignNodes`。

`src/shared/design-node-ids.ts:100` 先用 parse5 分析节点，再为每个待标记节点执行：

```ts
html = html.slice(0, edit.offset) + ` data-design-node="${edit.id}"` + html.slice(edit.offset)
```

编辑位置逆序处理保证了偏移正确，但每次迭代仍重新拼接整个文档。节点数与 HTML 长度一起增长时，呈现近似平方增长，且没有让出界面线程。函数外层声明为 async 不会把其中的同步操作移到后台。

真实 Chrome 中，两次独立运行得到以下耗时范围。夹具为同级 div，每项含约 100 个汉字，无图片、Shadow DOM、原站业务 JS 或模型请求。

| div 数 | 输入 UTF-8 字节数 | 仅 decorateDesignNodes 耗时 |
| --- | ---: | ---: |
| 1,000 | 335,980 | 31–35ms |
| 5,000 | 1,683,980 | 807–861ms |
| 10,000 | 3,368,980 | 3,196–3,294ms |
| 20,000 | 6,748,980 | 12,858–13,876ms |

同组无外部资源的 `buildDesignHtmlPreviewDocument` 仅约 2–32ms。因此不能笼统把这组卡顿都归结为 DOMParser 或浏览器渲染。这里测量的是局部同步耗时，不是整个抓取流程的延迟，也没有覆盖所有页面结构。

### 2. 仍存在的开销放大链路

- **抓取阶段**：`page-snapshot.ts:49` 全量枚举并克隆 DOM；Shadow DOM 展平时逐节点读取全部计算样式（`:148`）。这些发生在来源页面渲染进程，可能拖慢来源浏览器并扩大快照。
- **资源预览阶段**：`design-html-srcdoc.ts:562` 把本地图片替换为 data URL，CSS、字体也会内联。读取缓存避免重复读文件，但相同资源出现在多个属性时，序列化结果仍会重复包含资源字符串。抓取时 15MiB 的 HTML 限制检查发生在资源内联前，资源总预算又允许 50MiB，因此不能保证最终 srcDoc 仍很小。
- **滚动和状态保存阶段**：`DesignView.tsx:2762` 收到预览滚动消息后调用 `updatePreviewScrollState`；外部画布的 onScroll（`:5609`）也调用它。该函数经 `updateTs` 进入会话 patch。`run-manager.ts` 的 commit 仍保存、克隆并广播全量正式会话；`session-store.ts` 仍序列化包含正式 HTML 的 state。大 HTML 因而会放大本来很小的滚动或 UI 更新成本。这是代码路径确认，本次未测量该路径的现场占比。

之前已实现的输入框优化、300ms 输入合并、已读轻量更新、同 seq 去重仍然有效；它们没有消除本次定位的节点标记热点，也没有把所有 UI patch 改成增量产物同步。

## 二、iframe 为什么没有抓下来

`src/main/services/design/page-snapshot.ts:116` 对 iframe、object、embed 无条件建立普通 div，文字固定为“嵌入内容”，并返回 `embedded_content` 提示。后续 clean 还会移除剩余 iframe。

这没有区分同域、跨域或 srcdoc。当前 `page-capture.ts` 对顶层 WebContents 执行快照函数，没有枚举子 frame，也没有调用 iframe.contentDocument 的递归采集逻辑。

真实 Chrome 夹具中，同域 srcdoc iframe 的正文为“应采集的 iframe 内容”，源页面可正常读取；提取后正文消失，只剩“嵌入内容”占位及对应 warning。截图 2 与这个明确分支一致，不能先认定是登录态、加载等待不足或跨域导致失败。

改进应逐 frame 采集当前已渲染的 DOM，并分别处理子页面的资源基址、样式隔离、嵌套深度和体积预算。Electron 提供 [WebFrameMain 的 frame 访问与 executeJavaScript](https://www.electronjs.org/docs/latest/api/web-frame-main)，可以作为实现入口。无法提取的 frame 再降级为截图或说明明确的占位。不能仅保留原 iframe.src，否则离线还原仍依赖原站网络、登录和嵌入策略。

## 三、为什么业务代码会变成正文

### 1. 已复现的结构破坏点

HTML 文件导入依次经过依赖内联、`applyImportedDesign` 和 `ensureEditMode`。后者为没有微调声明的页面注入脚本。

`DesignView.tsx:1256` 的 `appendEditScript` 及 `:1360` 的 `injectColorVars` 都使用：

```ts
html.replace(/<\/body>/i, script + "\n</body>")
```

正则匹配第一个文本片段，不识别它属于真实 body 结束标签还是 JavaScript 字符串。合法的原页面可能包含：

```html
<script>
const printHtml = "<html><body>打印页</body></html>";
function contact(c) { return `<div>经营场景</div><p>${c.task}</p>`; }
</script>
```

导入后微调脚本被插进 printHtml 字符串；新增脚本的 `</script>` 提前结束原 script，后面的业务代码被浏览器当成 HTML 正文。模板里的 div、p 又会被解析为真实元素，`${c.task}` 则作为字面文本显示。这能同时解释截图中的代码、未插值变量和异常布局。关于脚本结束标签的解析约束，见 [HTML 标准](https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements)。

用从当前 DesignView 源码 AST 原样抽取的函数进行真实 Chrome 验证：

| 阶段 | 可见 innerText | 测试脚本成功执行 |
| --- | --- | --- |
| 原始 HTML | 财富管理 | 是 |
| buildDesignHtmlPreviewDocument 后 | 财富管理 | 是 |
| ensureEditMode 后 | 财富管理、function contact、经营场景、`${c.task}` 等 | 否，出现 Invalid or unexpected token |

因此这是可以独立复现的产品缺陷。当前仅凭截图，尚不能确认该 HTML 是否包含打印/导出模板、是否原文件已经损坏，或是否触发了其他脚本边界问题。

### 2. 与浏览器抓取的区别

浏览器快照在 `page-snapshot.ts:189` 清理来源 script 和 on* 属性。正确位于 script 内的业务函数通常不会作为代码留在快照中。如果原页面已把代码解析成普通文本，删除 script 也不会移除这些游离文本。

`url-import-service.ts:88` 的验证仅检查正文/图像、图片完成情况及远程资源请求；它不是脚本语法或视觉一致性验证，并且运行在后续 renderer 微调注入之前。因此“快照验证成功”不能证明最后的设计预览没有代码外露。

修复应通过 HTML 解析树或解析器提供的真实标签位置插入宿主脚本，避免对整份文档用结束标签正则替换。应验证包含 `</body>`、`</html>` 的打印模板仍能执行，且业务函数和 `${...}` 不会进入可见正文。不要用删除疑似代码文本作为修复，它会误删合法页面内容并掩盖结构损坏。

## 建议处理顺序

1. 修复微调脚本的插入位置，避免继续破坏导入文件。
2. 把节点 ID 装饰改为按原始偏移收集片段、最后一次 join；将纯字符串/解析工作移到后台，并为相同源版本复用预览准备结果。
3. 限制预览资源内联后的实际体积；滚动等高频 UI 状态采用局部状态或合并保存，避免携带全量正式 HTML。
4. 增加逐 frame 静态采集及有明确原因的降级；继续单独定义原站业务交互的支持范围。

复现方式：使用仓库真实 TypeScript 函数，经 esbuild 编译后在安装的 Chrome 独立临时配置中运行。未访问原站、用户登录数据或模型接口。本次结论不包含上线修复、完整应用性能基线或截图原文件的最终定因。
