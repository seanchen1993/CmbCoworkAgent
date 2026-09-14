# 聊天闪动修复：代码检视与回归验证

分支：`codex/fix-chat-flicker`。基线：UAT `4dedee74`。日期：2026-09-14。

本文记录首轮提交 `63e96240` 的验证。随后按用户要求由三个中等思维强度子 agent 检视，修复了离屏完成的状态恢复边界，并加强测试隔离和断言。最新结果见[三 agent 检视与整改记录](chat-flicker-three-agent-review-2026-09-14.md)。

## 修复范围

产品代码只涉及消息列表和思考区的渲染状态：

- 把虚拟消息 item 的外边距改为纳入行高测量的内部 padding，避免每行漏算 16px。
- 在列表生命周期内保存思考区状态，避免虚拟滚动重挂载把长消息重新变成短消息。
- 首次挂载直接解析正确的展开状态，减少先提交错误高度再更正的过程。

未新增产品功能，也未改动滚动状态机、消息分页、模型协议、IPC、数据库、Markdown 节流/折叠策略或正式登录流程。测试脚本和本地诊断副本不参与生产入口。

## 代码检视及已处理问题

首轮完成了本地逐项代码检视；后续已补充三个独立子 agent 检视及修复后复核，详见上方记录。

| 检视项 | 发现与处理 |
| --- | --- |
| 原有行为兼容 | 初始草案的 `manual` 标记会使手动展开后的思考区跳过正文开始时的自动收起。这会改变现有行为，已去掉，改为保留原来两个一次性操作的 `autoOpened` / `autoCollapsed` 标记。 |
| 手动操作时机 | 正文首次出现仍自动收起一次；之后手动展开不会被后续 token 重复收起。新增单测和浏览器/E2E 断言覆盖。 |
| 首次渲染 | 初始化器直接计算展开状态，避免首次挂载为解析自动阶段再额外渲染一次；阶段变更在当前组件提交 DOM 前调整。 |
| 虚拟列表测量 | 行间距位于稳定的 item 盒子内部，不依赖“当前渲染窗口的最后一项”。Header/Footer 不匹配该样式选择器。 |
| 内存与更新范围 | 缓存最多 500 条，仅保存三个布尔字段；10,000 次消息访问的边界测试确认容量固定。Context 值在 token 更新间保持稳定。 |
| 每 token 开销 | 状态没有变化时返回同一个对象；10,000 次相同阶段更新的单测确认没有额外状态对象。没有增加全文解析或消息列表扫描。 |
| 测试实际执行 | Vitest 对 chat 目录使用显式白名单；已将新测试加入配置，防止文件存在但 `npm test` 实际不执行。 |
| E2E 可靠性 | 将临时诊断脚本整理为正式 `tests/chat-layout-e2e.spec.mjs`，补充失败断言和非零退出码，验证真实输入框、IPC 适配器、ChatContainer 与消息组件。 |

检视后未发现尚未处理的、由本次改动引入的确定性问题。这不等同于对所有硬件和输入给出无回归保证。

## 通过的验证

使用 Node 22.22.1。

| 验证 | 结果 |
| --- | --- |
| `npm run build` | 通过，最终 renderer 已用于安装包复测。 |
| `npm run typecheck` | Node 和 Web 均通过。 |
| 修改文件 ESLint | 0 error；两个原文件有 14 条原有格式/依赖提示。新增源码与测试无告警。 |
| 聊天组件、滚动状态机及尾部变化分类 | 8 个测试文件，88 个测试通过。 |
| `npm run test:messages` | 通过，包含流消息、并行工具结果、子代理消息顺序等既有回归。 |
| 消息显示、窗口连接、消息窗口、Markdown 调度、工具完成状态独立套件 | 全部通过。 |
| 新增浏览器回归 | 每个配置 9 项，DPR 1 / 1.25 / 1.5 三种配置共 27 项通过。视口宽度分别为 920 / 760 / 1100px。 |
| 新增完整页面 E2E | Electron 39.8.10，8 个场景通过。 |
| 现有聊天导航 E2E | 17 个检查通过，含 20 次缓存会话切换、历史页搜索、复制/编辑消息、文件/Git 面板切换、流式完成。 |
| 原安装包运行时 E2E | Electron 39.8.0，`app.isPackaged === true`，同样的 8 个场景通过。 |

新增 E2E 场景：行高测量、展开状态重挂载、长思考底部跟随、主动上翻后保持阅读位置、返回底部、超过 64 Ki 字符的有界预览、正文开始时自动收起、正文输出后的手动展开。

安装包最终测量：13,049 字符思考流，1,237 帧，0 空白帧、0 向上回跳、0 未捕获错误，最终距底部 0px；主动上翻后继续接收内容，阅读位置变化 0px。

性能回归检查在三个 DPR 配置下均挂载 19 个历史消息气泡。连续 100 次无内容变化的更新产生 0 次气泡重绘，合计约 14.1 / 14.3 / 15.2ms。时间仅为本机观测值；主要回归断言是挂载数量和重绘次数，不使用容易受机器负载干扰的微秒级阈值。

DPR 测试覆盖不同像素密度与视口宽度，不等同于完整验证所有 Windows 系统缩放和显卡组合。

## 全量测试与 UAT 基线对照

没有将全量测试标记为通过。用 `git archive 4dedee74` 在工作区生成未修改源码副本，复用相同依赖和 Node 版本，分别执行 `npm test`：

| | 修复分支 | 未修改 UAT 源码 |
| --- | --- | --- |
| 通过测试文件 | 351 | 349 |
| 失败测试文件 | 29 | 30 |
| 通过测试 | 2,795 | 2,786 |
| 失败测试 | 57 | 59 |
| 跳过测试 | 5 | 5 |
| 未处理错误 | 3 | 2 |

失败涉及 Git/文件权限、旧数据迁移、扩展资源、性能阈值及现有源码契约等。分支额外出现了 Vitest worker 的任务更新超时。

逐项比较失败记录后，仅在分支这一轮出现的 4 个用例涉及 Windows 后台 shell、Git 提交标记和仓库发现。这 4 个用例在分支和原始源码上以单 worker 分别重跑，均为 4/4 通过。没有发现稳定新增的失败；全量测试依然存在基线问题和并行运行波动，不能作为已全绿的发布结论。

`npm test` 在 Vitest 阶段失败后，不会继续其 `&&` 后面的全部独立套件。本次额外执行了与本改动相关的消息与窗口套件，没有宣称其他后续套件全部执行。

## 复测入口与证据

正式测试入口：

```powershell
npm run test:chat-layout:browser
npm run test:chat-layout:e2e
npm run test:chat-navigation:e2e
```

安装包诊断副本位于 `output/chat-layout/uat-runtime/`。以下命令用相同正式 E2E 测试该副本：

```powershell
$env:CHAT_LAYOUT_PACKAGED_EXECUTABLE = (Resolve-Path 'output/chat-layout/uat-runtime/CMBDevClaw.exe').Path
$env:CHAT_LAYOUT_E2E_ARTIFACT_DIR = 'output/chat-layout/branch-package-e2e'
node tests/chat-layout-e2e.spec.mjs
```

日志、测量和截图都在 Git 忽略的 `output/` 下：

- `output/chat-layout/branch-chat-tests.log`
- `output/chat-layout/dpr100/current/`、`dpr125/current/`、`dpr150/current/`
- `output/chat-layout/e2e/`、`output/chat-layout/branch-package-e2e/`
- `output/chat-navigation/e2e/`
- `output/chat-layout/branch-full-test.log`、`baseline-full-test.log`
- `output/chat-layout/full-test-comparison.json`
- `output/chat-layout/differential-rerun-branch.log`、`differential-rerun-baseline.log`

安装包复测使用软件渲染和隔离配置目录，通过受控 IPC 注入合成回复。原下载包未修改；正式登录代码未取消；没有测试真实模型服务，也没有验证受影响机器的原生 GPU 路径。整窗口闪屏的硬件相关部分仍需要目标机器验证。详见首次[排查报告](chat-flicker-investigation-2026-09-14.md)。

修复在独立分支交付，未合并 UAT，未发布正式安装包。
