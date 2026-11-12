# Design「通过内置浏览器打开」网页编辑与参考方案

日期：2026-11-12。状态：交互采用「输入链接 → 内置浏览器打开 → 用户选择编辑或添加参考 → 抓取当前页」。

浏览器确认栏提供两种用途，共用当前页抓取能力：

- **基于此页面编辑**：将 HTML、样式和图片复制到新设计的独立产物目录，立即进入画布。导入不调用模型、不自动套用设计系统；后续消息基于当前 HTML 继续迭代，原设计保持不变。
- **添加为页面参考**：将页面快照添加为当前设计的参考附件，保留已有画布、对话和未发送需求，由用户显式发送后交给模型。

编辑副本沿用标准设计产物路径，支持局部修改、重新打开和完整资源包导出。取消或保存失败时清理未接受的快照与编辑副本，不创建空设计。登录页的“仍然继续”操作保留用户先前选择的用途。

## 1. 目标与交付边界

将当前「下载服务端 HTML」升级为「使用平台浏览器登录态加载网页，提取渲染结果，生成可编辑设计」。

第一版交付：

- 复用平台内置浏览器的持久 Session，支持已有 Cookie 和同源持久存储中的登录状态。
- 等待页面脚本渲染后抓取 DOM、样式和当前显示状态。
- 输入链接后在内置浏览器打开，由用户完成登录、跳转并确认页面，再抓取当前页，保留页面内存、sessionStorage 和手动操作形成的状态。
- 输出可独立预览、可继续编辑的 HTML 和资源包，沿用 design 会话、Tweaks、保存与导出流程。
- 明确展示登录待处理、部分资源缺失、页面不支持等结果。

第一版还原的是抓取时刻的页面布局与内容。文字、图片、布局继续编辑；原站点登录、提交、支付、后台接口等业务功能不随快照迁移。Canvas、视频、复杂嵌入内容可能只保留图片占位，并在结果中说明。

## 2. 当前代码与可复用能力

| 位置 | 当前行为 | 改造方向 |
| --- | --- | --- |
| `src/main/ipc/design.ts` 的 `design:import-url` | `net.fetch`，20 秒超时，5MB HTML 上限 | 改为调用抓取服务，IPC 层只负责参数、任务归属和结果转换 |
| 同文件 `prepareImportedRemoteHtml` | 去除 CSP meta、补全文档、注入远程 base | 由快照生成与资源重写取代 |
| `src/main/browser/core/browser-service.ts` | 单个活动 WebContentsView，使用 `persist:cmbdevclaw-browser-profile` | 抽出共享 Session 入口，保留当前活动页面接口 |
| 同文件 `importProfileData` | Cookie 写入上述分区 | 保持写入同一个 Session |
| `src/main/browser/core/browser-service-registry.ts` | 提供活动 BrowserService | 用于定位当前页、打开浏览器处理登录 |
| `src/renderer/src/components/design/DesignView.tsx` | 加载 URL HTML，注入编辑能力，保存并应用 | 接入任务进度、资源包、警告与可恢复失败 |
| `src/renderer/src/components/design/DesignPreviewFrame.tsx` | 使用 iframe.srcDoc 预览 | 消费准备好的快照，只运行 design 自有编辑脚本 |
| `src/main/services/design/artifact-package.ts` | 导出完整产物目录 | 复用 HTML 与本地资源一起导出 |

## 3. 浏览器与登录态

### 3.1 统一 Session 来源

新增 `src/main/browser/core/browser-profile-session.ts`，集中提供：

```ts
export const BROWSER_PROFILE_PARTITION = "persist:cmbdevclaw-browser-profile"
export function getBuiltinBrowserSession(): Electron.Session
```

内置浏览器创建、Cookie 导入、design 抓取与资源获取均从该模块取 Session，移除重复分区字符串。

直接共享 Electron Session；不把 Cookie 导出给前端，不手动拼接 Cookie 请求头，也不复制到默认 Session。浏览器按域、路径、SameSite 等规则处理 Cookie。

共享 Session 是共享登录存储的基础，但不保证所有网站在新页面中自动登录：sessionStorage 与页面内存属于具体浏览上下文。已有的“导入浏览器数据”当前只导入 Cookie，也不等同于迁移外部浏览器的全部登录状态。

### 3.2 浏览器确认与抓取来源

**界面入口：在内置浏览器确认后抓取当前页。**

URL 弹窗只输入地址，点击「在内置浏览器中打开」后收起弹窗，打开平台内置浏览器。确认栏位于地址栏下方，参与面板布局，使原生 WebContentsView 从确认栏下方开始，避免覆盖操作。用户可以登录、完成验证、跳转和调整页面，随后选择「基于此页面编辑」或「添加为页面参考」。打开链接本身不创建抓取任务。

通过 BrowserService.getWebContents() 定位活动页面，直接读取当前渲染结果，不导航、不刷新，保留 sessionStorage、内存 token、弹窗及筛选条件等。抓取前后校验页面标识和导航版本；用户中途跳转时终止本次抓取，提示重试。该页面归用户所有，取消或成功时仅收起面板，不销毁页面。

处理中确认栏显示进度并允许取消。打开失败时可修改链接；抓取或保存失败时保留当前页供重试。成功提交设计后收起浏览器。修改链接重新打开弹窗时，通过平台的 data-cmb-modal-dialog 标记暂时隐藏原生浏览器视图。

关闭抽屉时立即标记 aria-hidden/inert，边界同步禁止重新显示关闭中的原生网页，BrowserPanel 卸载时再次隐藏视图。打开链接的 IPC 只准备隐藏目标并导航，面板显示由前端控制，避免异步初始化完成后重新弹出已关闭的浏览器。

**兼容服务能力：后台 URL 抓取。**

主进程保留 source=url 能力供兼容调用和集成验证。它创建共享 Session 的临时隐藏 BrowserWindow，任务结束时销毁；当前 Design 界面不使用该路径，也不在当前页抓取失败时自动回退。

### 3.3 登录与验证码

发现登录重定向、登录表单、验证码或拒绝访问迹象时返回 `needs_user_action`，保留具体原因，不直接把页面标为还原成功。HTTP 状态和 URL 均需结合页面内容判断，不能只根据地址中有 login 就下结论。

用户在已打开的内置浏览器中完成登录、验证码并进入目标页面后，选择确认栏中的页面用途，直接从该活动页面抓取，避免重新开页丢失 sessionStorage。

识别结果有不确定性时，在确认栏展示原因，并保留「仍然还原当前页面」选项，以支持用户本来就要还原登录页的情况。人工处理阶段不持续自动重试。

## 4. 抓取流水线

```text
输入链接 → 内置浏览器打开 → 用户确认页面
    → 创建当前页抓取任务
    → 绑定用户确认的现有页面
    → 等待渲染，检查登录与页面质量
    → 提取 DOM、样式、当前状态和参考截图
    → 保存资源并生成静态快照
    → 在独立预览环境验证
    → 保存产物并提交 design 会话
```

### 4.1 等待页面就绪

建议默认加载与渲染总预算 30 秒，资源处理与验证总预算 30 秒，另设整个自动任务的 60 秒硬截止。人工处理是单独状态，不计入自动等待，也不能无限保留后台窗口。

就绪信号组合使用：

- DOM 已建立，并存在有效正文或页面根内容。
- 等待字体与首屏图片，单项设置期限。
- 有限观察 DOM 和主要布局变化，例如连续约 800ms 无明显变化。
- 页面持续轮询或有动画时，达到观察上限后进入质量判断，返回可能仍在变化的警告。

不能仅等待 did-finish-load，也不能要求所有网络连接永久空闲。默认捕获当前已渲染状态；整页懒加载、虚拟列表完整展开留给后续版本。

### 4.2 提取可编辑静态快照

在页面中运行受控提取逻辑，处理克隆的 DOM，保持来源页面业务状态：

- 提取渲染后的 DOM，保留可编辑文本、层级、类名和有效样式。
- 获取页面样式，保留媒体规则、伪元素及 CSS 变量；处理 CSSOM 动态规则和 adoptedStyleSheets。无法读取的跨域样式转交资源步骤处理，禁止静默丢弃。
- 将输入框、textarea、select、checked 等当前状态写回快照；密码值和文件输入不导出。
- 固化响应式图片 currentSrc；可读取的 Canvas 转为图片，无法读取时记录降级。
- 冻结动画与过渡，保证导入后稳定预览。
- 清理来源脚本、事件属性、脚本 URL、刷新跳转、原站预加载和预取，以及已失效的水合数据。链接与表单默认由快照预览运行时阻止实际导航和提交。
- 注入 design 自有编辑协议、元素标识与 Tweaks 能力。

不能只取 outerHTML：它无法完整保存运行中的表单状态、Canvas、动态样式和 Shadow DOM。第一版对开放 Shadow DOM 做有限提取；闭合 Shadow DOM、复杂嵌入、跨域 iframe 以可识别占位或图片降级，并报告不可编辑范围。

参考截图用于用户确认和视觉验证；默认产物仍由可编辑 DOM 组成。

### 4.3 资源保存

产物按现有 design artifact 目录规范落盘，概念结构如下：

```text
<artifact-root>/
  index.html
  assets/
  source-preview.png
  capture-manifest.json
```

- 收集 HTML、CSS、内联样式中的图片、背景图、字体、样式表，以及递归 @import 和 url() 引用。
- CSS 内的相对地址以该 CSS 的实际来源 URL 解析；页面地址与重定向后的地址分别记录。
- 优先复用捕获时可用的资源；需要重新下载时使用共享 Session 的 fetch，并设置凭证策略与必要的来源信息。受签名、Referer、缓存或页面请求上下文限制的资源，重新下载不保证成功，需要在结果中列出。
- 能在页面上下文取得的 blob/data 资源转为本地文件。资源按内容去重，维护 URL 到本地路径映射。
- 重写引用为本地路径，清理依赖原站点的 base；适配现有 srcDoc 本地资源准备流程及导出目录相对路径。
- 所有自动步骤共享取消信号和总截止；建议初始限制为 500 个资源、单项 10MB、总计 50MB、下载并发 4，作为可调工程默认值。
- 资源失败返回清单；关键样式或主体内容缺失时判失败，非关键资源缺失允许带警告导入。需要远程引用的残余资源必须明确标识，不能宣称完全离线。

抓取清单只保存必要的来源、时间、视口、质量与资源映射。Cookie、Authorization、浏览器存储和敏感签名参数不进入日志、清单或模型上下文；页面自身显示的数据仍属于导入内容。

### 4.4 验证与提交

在不共享登录资料的临时预览环境中打开产物，验证正文非空、布局存在、资源可解析、编辑协议可用，并记录资源加载错误。对受控测试页面进行固定视口截图比较；任意线上页面的截图差异只能辅助判断，不能单独断言成功。

先写入任务暂存目录，再按现有产物规范提交 HTML 和资源，成功后调用 applyImportedDesign。前端持久化失败时显示失败，不能沿用当前“先提示成功、保存仅打印警告”的处理。

取消与失败清理暂存目录，保留已有设计。关联 requestId 与任务版本，忽略超时后迟到的结果，避免旧任务覆盖新导入。新增会话在成功提交时创建或绑定；无需在输入 URL 时先创建一个空会话。

## 5. IPC、状态与前端交互

共享协议新增 `src/shared/design-url-import.ts`。建议状态为：

```ts
type DesignImportStage =
  | "loading"
  | "waiting_render"
  | "needs_user_action"
  | "extracting"
  | "saving_assets"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"

interface DesignImportRequest {
  requestId: string
  source: "url" | "current-browser"
  url?: string
  workspacePath: string
  viewport?: { width: number; height: number }
}
```

保留现有 importFromUrl 入口并同步升级 preload 声明、调用方和测试替身，新增按 requestId 订阅的进度及取消接口。所有事件绑定发起方 webContents；其他窗口不能读取、取消或接管任务。

结果包括：状态、最终地址、标题、快照 HTML/产物路径、参考截图、警告列表和必要的抓取质量信息。登录识别、资源缺失和不支持的内容都有结构化原因，不塞进一个不明确的 error 字符串。

界面流程为「输入链接 → 在内置浏览器中打开 → 用户确认 → 抓取当前页」。URL 弹窗与浏览器确认栏不同时显示。确认前不调用 importFromUrl；确认后仅发送 source=current-browser。进度、取消、登录待处理、保存失败与重试均在浏览器确认栏完成，已有设计只在导入成功后替换。

浏览器抓取失败时，不自动改回旧的匿名 net.fetch 后报成功。若保留源码导入，只作为用户主动选择的兼容方式，并明确其限制。

## 6. 建议模块拆分

| 模块 | 职责 |
| --- | --- |
| `browser/core/browser-profile-session.ts` | 共享 Session 的唯一入口 |
| `services/design/url-import-service.ts` | 任务状态、截止、取消、人工处理与提交协调 |
| `services/design/page-capture.ts` | 临时浏览器生命周期、绑定当前页、页面就绪与提取 |
| `services/design/page-snapshot.ts` | DOM 状态固化、来源行为清理、编辑能力接入 |
| `services/design/capture-assets.ts` | 资源收集、下载、CSS 引用重写、限额与缺失报告 |
| `shared/design-url-import.ts` | 前后端共享请求、进度、结果协议 |

IPC 不继续堆入浏览器抓取、资源处理代码。现有 artifact 存储、预览资源准备和 ZIP 导出优先复用；文件名为建议，以实际实现时的相邻模块约定为准。

## 7. 迭代顺序

1. **打通登录态与动态抓取**：共享 Session、后台页面、当前页入口、就绪判断、登录待处理、任务进度与取消。
2. **完成可编辑产物闭环**：静态快照、CSS/图片/字体保存、原脚本清理、编辑协议、原子提交、关闭浏览器后的预览与导出验证。与第 1 步一起组成第一版验收范围。
3. **提高复杂页面覆盖率**：滚动懒加载、虚拟列表策略、更多 Shadow DOM/iframe 处理、资源捕获增强及视觉差异定位。

仅将 net.fetch 换成共享 Session.fetch 可作为短期补丁，但不会执行页面脚本，也不能解决当前浏览上下文状态与预览资源问题，不作为第一版完整交付。

## 8. 第一版验收标准

使用可控的本地测试站点做 Electron 集成验证，包含登录、跨源资源和动态渲染用例：

1. 内置浏览器登录后，链接还原获得登录后的正文；只登录默认 Session 时不会误用其身份。
2. HttpOnly Cookie 由共享 Session 正常处理；Cookie 值不出现在 IPC 结果、日志和产物清单。
3. 依赖 localStorage 的登录可在共享分区后台页面运行；sessionStorage/内存状态可通过抓取当前页保留。
4. 客户端渲染页面拿到渲染后的内容；持续轮询不会无限等待；实际重定向 URL 与单页路由均记录正确。
5. 输入链接只打开浏览器，不提前抓取；用户确认后抓取当前页且不刷新页面，取消不会销毁用户页面；修改链接弹窗不被原生视图覆盖。
6. 登录、验证码、拒绝访问、空正文、渲染进程退出、超时均有明确状态，无伪成功。
7. 字体、图片、跨域 CSS、CSS @import/url()、blob 图等有受控用例；资源失败和不支持范围可见。
8. 产物加载不重复执行来源站点脚本、不重新发起原业务接口请求；文字、图片、布局编辑及 Tweaks 可用。
9. 保存后关闭抓取浏览器并断开测试站点，承诺已本地化的内容仍可预览；导出包在独立目录中能打开。
10. 取消、重复点击、页面中途导航、迟到结果、部分保存失败不会覆盖现有设计，临时窗口与暂存资源得到清理。

## 9. 技术依据

- 当前项目锁定 Electron 39.8.10；实施 API 以项目内 `node_modules/electron/electron.d.ts` 为准。
- [Electron Session](https://www.electronjs.org/docs/latest/api/session#frompartitionpartition-options)：同一 partition 返回同一 Session，persist 分区可供应用内页面共享；该页面也说明 Session.fetch。
- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents)：页面导航、生命周期、脚本执行及截图能力。
- [HTML Standard: Web storage](https://html.spec.whatwg.org/multipage/webstorage.html#the-sessionstorage-attribute)：sessionStorage 的窗口上下文边界，是保留“抓取当前页”入口的依据。

## 10. 第一版实现与验证

已实现共享 Session、独立后台抓取、当前页抓取、有限渲染等待、登录待处理、来源行为清理、表单/Canvas/开放 Shadow DOM 状态提取、递归资源保存、独立预览验证、进度与取消、按窗口隔离的任务归属，以及产物确认接收前的自动清理。前端保存成功后才创建或更新设计会话；保存失败不会生成空设计。

资源下载通过 Session.fetch 的 credentials/referrer/referrerPolicy 处理凭证与来源。不要手动设置 Referer 请求头：Electron 39 的真实测试中该写法会导致 ERR_BLOCKED_BY_CLIENT。

新增测试入口：`npm run test:design-url-import`。界面回归：`node scripts/run-design-session-browser.mjs tests/design-background-session-browser.spec.ts`，可通过 CHROMIUM_EXECUTABLE_PATH 指定已安装的 Chrome。类型检查：`npm run typecheck`。

`tests/design-browser-confirmation-electron.spec.mts` 使用实际 BrowserPanel、OverlayDrawer、平台样式和 BrowserService/WebContentsView，检查原生页面从确认栏下方开始、修改链接时隐藏原生视图、关闭弹窗后恢复原页面，以及关闭面板/取消还原后在退场动画、迟到尺寸更新和组件卸载过程中持续隐藏原生网页。

真实 Electron 用例覆盖 HttpOnly Cookie 与默认 Session 隔离、动态 DOM、跨源 CSS 与嵌套依赖、CSSOM、字体、blob、Canvas、开放 Shadow DOM、当前页 sessionStorage/输入状态、取消权限、导航竞争，以及停止源站后的独立导出预览。界面用例覆盖打开浏览器不提前抓取、手动确认、进度、取消、打开失败、保存失败、登录重试，以及修改链接弹窗触发原生视图隐藏。

第一版默认保存已渲染内容。整页滚动懒加载、虚拟列表完整展开、闭合 Shadow DOM 与 iframe 内部结构仍按上文约定作为后续增强或明确降级，不承诺恢复原站的业务操作。
