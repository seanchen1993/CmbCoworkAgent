# 工作目录 HTML / JavaScript 预览修复说明

## 分支与范围

- 开发分支：`codex/fix-html-javascript-preview`。
- 基线：拉取后的 `origin/UAT`，提交 `9f981a365d3f573f5cebb2d5cbd756ee0f1c3e89`。
- 本次修复“工作目录 → 文件 → HTML/HTM”的页面渲染。
- 会话小眼睛仍显示 HTML 原文，不执行脚本；未修改 `RightPanel.tsx`。
- 初次交付只提交开发分支；用户随后明确要求推送并合并 UAT，集成记录见本文末尾。

## 原因与功能变化

旧版只提供静态 HTML 预览：构建预览文档时删除脚本，iframe 的空 sandbox 也禁止脚本执行。
因此，通过 JavaScript 创建主体内容，或初始化后解除隐藏状态的页面会显示为空白。

本次保留内联脚本、事件处理器，加载页面目录及子目录中显式引用的本地 JS/CSS，
使动态生成内容、DOMContentLoaded 初始化、按钮交互和本地 defer 脚本正常工作。
工作目录预览新增“预览 / 原文”切换。脚本错误、依赖缺失或资源受限时，在父面板显示提示，
用户仍可查看原文。切到原文时卸载脚本页面、消息监听及超时计时器，切回时启动新沙箱。

## 代码文件

| 文件 | 功能 |
| --- | --- |
| `src/renderer/src/lib/file-preview-mode.ts` | 定义仅工作目录可以显式开启的 `workspace-scripted` 策略。 |
| `src/renderer/src/components/tabs/TabbedPanel.tsx` | 仅工作目录文件标签授予 HTML/JS 渲染策略；保留任务与文件共同组成的重挂载 key。 |
| `src/renderer/src/components/tabs/FileViewer.tsx` | 保留入口、工作目录路径和任务检查；依赖读取通过原有受控 IPC；最多 16 个依赖、合计 2 MiB，并按文件加载代次缓存，避免反复切换耗尽预算。 |
| `src/renderer/src/lib/html-srcdoc.ts` | 构建完整预览文档；本地脚本转换为 UTF-8 data URL，保持解析顺序、defer/async/module 属性；本地 CSS 内联；限制路径、网络与嵌套页面；生成有界运行状态通知。 |
| `src/renderer/src/components/chat/previews/HtmlPreview.tsx` | 隔离 iframe、错误提示、原文切换、加载代次校验、运行时清理及可用高度布局。 |
| `src/shared/html-preview-runtime.ts` | 限定跨框架消息类型和当前文档标识，只传递 ready/error/blocked 状态，不提供文件读取或宿主调用能力。 |
| `src/main/html-preview-navigation.ts`、`src/main/index.ts` | 阻止嵌入页面发起导航和重定向，覆盖 CSP 无法阻止的 `location.href` 和动态链接；内置浏览器使用独立 webContents，不受这项预览策略影响。 |
| `tests/html-preview-browser.spec.mjs`、`package.json` | 新增实际浏览器行为回归及 `test:html-preview:browser` 命令。 |
| `tests/workspace-html-source-e2e.spec.ts` | 增强真实 Electron 工作目录入口、JS 动态渲染、交互、布局、隔离与小眼睛回归。 |
| `html-preview-navigation.test.ts`、`html-preview-runtime.test.ts`、`html-srcdoc.test.ts`、`file-preview-isolation.test.ts` | 导航、消息校验、路径边界、入口隔离和受限依赖读取回归。 |

## 安全及兼容边界

- iframe 仅设置 `sandbox="allow-scripts"`，不授予同源、弹窗、表单、顶层导航等权限。
- 页面脚本无法读取父页面 DOM、应用 preload API、Node require 或宿主持久存储。
- 保留 CSP 网络隔离；增加主进程导航拦截，避免启用脚本后通过跳转绕过资源限制。
- CSS 原始文本结束标签经过处理；JS 使用 base64 data URL，避免依赖内容变成宿主 HTML。
- 拒绝绝对路径、协议地址、父目录穿越；继续由主进程校验真实文件边界及授权。
- 支持内联脚本、显式引用的本地经典脚本和不含额外导入图的独立 module。
- 不把预览扩展为完整 Web 服务器：远程 CDN/API、模块内部的相对 import 图、eval 型运行时、
  fetch 读取额外资源等仍受限制；遇到受限或缺失依赖显示提示。
- 尚未收到用户实际空白 HTML 文件；已验证的是下述真实入口测试样本，不能据此承诺任意 JS 工程都兼容。

## 验证结果

环境为 Windows、Node `v24.14.0`、仓库当前安装的 Electron/Playwright。
仓库 `.nvmrc` 指定 Node 22，当前 Node 超出 package.json 声明范围，这是全量验证的环境限制之一。

| 检查 | 结果 |
| --- | --- |
| 专项 Vitest 回归 | 10 个测试文件，103 项通过。 |
| `npm run test:html-preview:browser` | 10 组实际浏览器行为回归通过。 |
| Electron E2E（构建后执行） | 73 项断言通过，最终退出码 0。 |
| `npm run typecheck` | Node/Web 均通过。 |
| `npm run build` | 通过；存在仓库已有的打包提示。 |
| 修改文件 ESLint | 0 errors；`src/main/index.ts` 未修改的关闭窗口条件有 1 项既有格式 warning。 |
| `git diff --check` | 通过。 |

Electron E2E 覆盖：

1. 从实际“工作目录 → 文件”点击 HTML，页面主体由本地 JS 创建并从隐藏状态显示。
2. CSS 布局、背景、圆角、内联 module、JS 按钮交互。
3. 1500×900、1200×700 两种窗口尺寸，预览填满高度且可滚动到动态页面末尾。
4. 预览/原文切换以及连续重复切换 10 次，脚本重新初始化且不会耗尽依赖预算。
5. 静态 `.HTM` 回归、脚本出错与依赖缺失后的提示和原文查看。
6. 父页面/API/存储隔离、动态链接和自身导航拦截、外部请求未发出。
7. 会话小眼睛在普通侧栏和折叠抽屉仍只显示原文；末行可滚动查看；无独立空白分块。
8. 未授权外部文件拒绝访问，禁止调用系统文件夹打开操作。

实际命令：

```text
npx vitest run src/main/html-preview-navigation.test.ts src/shared/html-preview-runtime.test.ts src/renderer/src/lib/html-srcdoc.test.ts src/renderer/src/lib/file-preview-mode.test.ts src/renderer/src/components/tabs/file-preview-isolation.test.ts src/main/workspace-file-preview/reader.test.ts src/main/services/stable-file-handle.test.ts src/main/services/external-file-read-tokens.test.ts src/main/services/trusted-tool-file-preview.test.ts src/main/ipc/workspace-file-preview-boundary.test.ts
npm run test:html-preview:browser
npm run typecheck
npm run build
node --experimental-strip-types tests/workspace-html-source-e2e.spec.ts
```

Electron E2E 使用独立临时用户目录；需正常系统权限运行。
受限命令沙箱会使 Electron 的 srcdoc iframe 出现与正常运行不同的空内容，因此最终验收在正常权限下完成。

## 全量测试与 UAT 对照

`npm test` 已执行，但不能宣称全量通过：

- 开发分支：24 个文件失败 / 369 个通过；57 项失败、2943 项通过、5 项跳过，1 个未处理错误。
- 未修改的 UAT 对照工作树：25 个文件失败 / 365 个通过；58 项失败、2904 项通过、9 项跳过，1 个未处理错误。
- 两边主要失败涉及原生 SQLite、缺失浏览器扩展资源、平台路径、Git/文件权限、性能时限及既有源码约束。
- 开发分支独有的 5 个失败用例所在文件又分别在两边复跑：两边均为 77 项通过、2 项跳过。
  未观察到可复现的本次新增失败，但不能据此把全量测试标记为绿色。
- `npm test` 在 Vitest 阶段失败，后续由 `&&` 串联的独立套件未执行，不记为通过。

本地证据保留在未纳入提交的 `output/html-preview/`：
`regression.log`、`electron-e2e.log`、`build.log`、`npm-test.log`、`uat-baseline-test.log`、
`branch-failure-recheck.log`、`uat-failure-recheck.log`、`workspace-javascript-preview.png`。
对照工作树已清理；可从上述 UAT 提交重新创建，原始代码未丢失。

## 回检结论

本轮自检修正了资源错误误报、原文切换的运行时清理、重复切换的依赖预算问题，并复跑验证。
已检查入口策略、脚本执行权限、宿主通信、导航、依赖边界、陈旧请求与布局。
在上述已验证范围内未发现未解决的 P2 及以上问题。这不是独立审计，也不是全仓库无缺陷保证。
全量基线仍非绿色，且用户实际文件尚待验证；初次交付未自动合并 UAT。
用户随后明确要求推送并合并，本次按明确指令推进，失败项及兼容限制保留在提交和合并备注中。

## 推送及 UAT 集成复验（2026-09-15）

- 原修复提交在推送前改为完整中文说明，提交号为 `745d6123`，代码树未改变。
- 拉取远端后，UAT 已前进到 `554aba16`，包含本地 Markdown 文件链接修复等变更。
- 先在开发分支无冲突地同步最新 UAT，集成提交为 `0549f444`；本次 HTML/JS 实现文件未被覆盖。
- 集成后的专项回归增加最新 UAT 的 Markdown 链接用例，共 11 个文件、105 项通过。
- 实际浏览器 10 组通过；重新构建后的 Electron E2E 73 项断言通过。
- Node/Web 类型检查、构建和差异空白检查通过；修改文件 ESLint 为 0 errors、1 项既有格式 warning。
- 集成后的 `npm test`：24 个测试文件失败、370 个通过；58 项失败、2944 项通过、5 项跳过，
  2 个未处理错误；仍在 Vitest 阶段中断，后续串联独立套件未执行。不宣称全量绿色。
- 与前次开发分支/UAT 对照相比，新增波动失败涉及历史路径缓存、Git 撤销测试、迁移恢复及 Git 钩子
  4 个测试文件。这些模块未被本次或最新 UAT 集成修改，单独复跑 4 个文件、40 项全部通过。
- 先推送开发分支，再通过独立的中文 merge commit 合并至 UAT；不使用强制推送，不覆盖远端新增提交。
- 最终以远端 Git 合并提交为准；合并树必须与复验通过的开发分支代码树一致。

本轮本地复验证据：`output/html-preview/uat-integration-regression.log`、
`uat-integration-build.log`、`uat-integration-lint.log`、`uat-integration-e2e.log`、
`uat-integration-full-test.log`、`uat-integration-failure-recheck.log`；日志和临时数据不纳入代码提交。
