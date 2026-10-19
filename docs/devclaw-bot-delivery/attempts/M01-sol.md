# M01 beta merge — sol attempt

2026-10-19 / gpt-6.1-sol high / agent `/root/beta_merge_sol`.
工作树：`/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`。分支 `codex/merge-beta-into-integration-20261019`。固定 integration d76f30201b8bca9cdf9d26daed1c710ce8c3c1aa，beta 91554cbc7df0b78e37c48d31b72628c16662911a。任务单 M01-beta-merge（2026-10-19 ready）及功能设计已读；root 独占 state/HANDOFF。

## 合并检查点

- 初始 HEAD=d76、clean detached；创建指定分支，实际执行 `git merge --no-ff --no-commit 91554cbc7df0b78e37c48d31b72628c16662911a`，退出1，停在真实合并。
- 文字冲突10文件：runtime.ts、main/index.ts、ipc/agent.ts、App.tsx、ChatContainer.tsx、MessageBubble.tsx、FileViewer.tsx、thread-context.tsx、types.ts、im-local-zhaohu-journey.spec.ts。root 已收到并同意逐项取舍。
- runtime sharedTaskContext+capabilityService；main 两套停止/活跃；agent beta 工具/交互/后台参数与需求策略并存、组合 prompt；App Bot titlebar 与需求导航；ChatSurface 两类并存、需求不显示goal按钮；消息需求标记和 Bot DOM 定位；HTML视觉编辑+文本预览；队列contextLabel+botReplyTo；IM保留integration Feature结构化回复断言。
- 接下来：自动合并语义检查、Node/Web类型和构建、Bot/Partner/桌面IM回归。尚未运行测试。Java root 独立验证，避免同缓存并行。
- 未调用真实模型/内网，未修改用户 profile/服务/数据库/调度；没有推送或目标分支修改。

## 类型与初轮回归

- Node22：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。初轮只读链接 integration 依赖，Bot 核心/IPC Vitest：24文件337测试通过（`/tmp/M01-bot-vitest.log`）；Partner/专家/线程/受限执行13文件：106测试0失败0跳过（`/tmp/M01-partner-tests.log`）。
- 原始 `tsc --noEmit -p tsconfig.node.json` 和 web 默认 composite=true，因为测试跨主/前端导入而 TS6307；Node 加 `--composite false` 通过。Web另缺beta新增TipTap模块；改为独立本地依赖副本后安装公开依赖，未在共享目录安装。
- Java/contracts/deploy相对d76零差异；root独立Java证据69JUnit/1884parity零差异仅记作root结果，不冒充本代理复验。
- 自动合并检查：standard-turn只增加bot source；AgentRunService继续先按partnerInputOnly独立分派、未注册拒绝；runtime允许技能/专家名单、allowlist backend、sharedTaskContext向叶子/worker传播保留；LocalSandbox readText/readRaw保留；双方IPC注册/活跃/退出清理均存在。
- `.env` 为既有加密载荷，未解密/输出内容。功能入口将通过源码和隔离构建核对。
- im-clean-cut全src字符串takeover会误拒beta浏览器接管；改为全域device限定旧协议与IM路径takeover检查，补充旧IM/跨边界协议拒绝与Bot浏览器允许负例，待回归。

## 最终候选验证（2026-10-19）

全部在本树、Node22运行，模型仅fixtures/fake，不连真实模型/内网。所有入口退出0，除首失败另列。

| 实际命令入口 | 结果 | 本机日志 |
| --- | --- | --- |
| `npm run typecheck` | Node/Web均零错误（使用项目既有composite false） | `/tmp/M01-typecheck-final.log` |
| `vitest run src/main/bots src/shared/bots src/main/ipc/bots.test.ts src/main/ipc/partner-dev.test.ts` | 24文件337通过 | `/tmp/M01-bot-vitest.log` |
| `node --import tsx --test tests/bot/{partner-prompt,group-task-intent,personal-context,partner-local-client,partner-local-config,partner-local-worker,partner-dev-controller,group-memory-validation,group-memory-controller,expert-memory,expert-controller,requirement-executor,task-thread-store}.spec.ts` | 13文件106通过0skip | `/tmp/M01-partner-tests.log` |
| `vitest run src/renderer/src/lib/bot- src/main/agent/standard-thread-turn.test.ts src/main/agent/agent-run-service.test.ts src/main/agent/skills-allowlist.test.ts` | 实际匹配30文件229通过，后两过滤路径不存在不计通过 | `/tmp/M01-bot-ui-vitest.log` |
| `npm run test:desktop-agent-baseline` | 7入口全部通过 | `/tmp/M01-desktop.log` |
| `npm run test:im-v1` | 19入口全部通过含模拟招乎完整旅程 | `/tmp/M01-im.log` |
| `node node_modules/electron-vite/bin/electron-vite.js build --mode m01-isolated` | main/preload/renderer完整通过 | `/tmp/M01-build.log` |
| `CMB_BOTS_E2E=1 node node_modules/electron-vite/bin/electron-vite.js build --mode m01-isolated` | 完整通过含浏览器测试入口 | `/tmp/M01-build-bots-e2e.log` |
| `node --import tsx tests/bots-process-recovery.spec.ts` | 真实Host SIGKILL/重启/队列/群结果/计划去重通过 | `/tmp/M01-bots-recovery.log` |
| `node --import tsx tests/bot-electron-engine.spec.ts` | 真实Electron隔离页面/持久Cookie/重启通过 | `/tmp/M01-bot-engine.log` |
| `node --import tsx tests/bot-native-browser-host.spec.ts` | 生产适配器真实host/页面/预览/接管/持久Cookie重启通过 | `/tmp/M01-bot-native-host.log` |
| `vitest run src/main/agent/{skill-sources,local-sandbox-background-settlement,tool-orchestrator,shell-file-effects,shell-command-profile,local-sandbox-shell-file-capture}.test.ts` | 6文件206通过，1原有Windows专用例在macOS跳过 | `/tmp/M01-shared-execution-final.log` |
| `vitest run src/main/services/requirements/security.test.ts src/main/ipc/requirements.test.ts` | 2文件54通过 | `/tmp/M01-requirements-vitest.log` |
| `node --import tsx tests/requirement-mode-skills.spec.ts`、`requirement-history-filter.spec.ts`、`requirement-credentials-renderer.spec.ts` | 技能白名单/历史/凭据与六操作边界通过 | `/tmp/M01-requirement-{skills,history,credentials}.log` |
| `vitest run src/main/ipc/project-mode-stage-usage.test.ts` | 5通过 | `/tmp/M01-stage-usage-test.log` |

`vitest`为本树`node node_modules/vitest/vitest.mjs`。最终shell组PATH须同时包含Node22与本树`node_modules/.bin`。构建只写本树out，不启动应用profile。测试临时目录/host由finally精确回收。独立node_modules由APFS副本后`npm install --ignore-scripts --no-audit --no-fund`新增43公开包；没有共享安装。lock仅同步根版本1.5.2→1.5.3与package一致，不保留npm peer元数据噪声。

### 失败与修复实况

- 初轮裸tsc未用项目既有composite false，跨层测试导入报TS6307；Web另缺TipTap。独立安装后项目typecheck通过。
- shell首轮直接node调用缺本地bin PATH，真实子进程`prettier: command not found`导致capture未finish与64槽后续泄漏，25例失败。三源文件和beta字节一致，修正PATH后整组206通过/1原有平台skip，未改源码或删除测试。首失败日志`/tmp/M01-shared-execution.log`，定点复现`/tmp/M01-shell-targeted.log`保留。
- root ES组发现beta旧测试仍断言每阶段main_agent_conversations，现有实现早已legacy_conversations+stage_duration。本轮仅改测试标题/类型/断言，验证新版完整耗时与旧耗时互斥、主Agent过滤、成本互斥，新增禁用stageDuration时fallback；保留原混合历史/解析/映射fallback用例，未改生产统计口径。

### 完整性、性能与边界

- `git diff HEAD -- contracts services/bot-control deploy`零差异，Java/MySQL/V1-V7/授权/专家记忆/启动器完整保留。`src/main/bots`、`src/shared/bots`相对beta零差异；Bot renderer子树仅BotMessageFilePreview新增一行显式关闭普通视觉编辑提交。
- Bot页面独立titlebar布局保留，onWorkbench返回工作台；需求/设计按钮源码不受新Bot开关隐藏，模块lazy加载保留。两套IPC、preload、数据库注册及活跃/退出处理完整。加密.env正常合并，未解密或输出内容。
- beta随带ES查询优化由root独立审查/8文件复验。本代理仅更新过时测试，不更改请求数/批次/并发/范围或统计口径；无生产实测，不宣称生产耗时改善。
- root独立结果（非本代理复验）：Java69JUnit/1884parity零差异、服务Node65/65、契约24/24；Partner受限真实DeepAgent graph/Thread/记忆50/50、真实React+Chromium假IPC面板通过；root最终ES8文件69/69通过（`/tmp/m01-root-es-final.log`，root证据）。

### 业务能力尚未接通

beta继续是本地LocalBotHost，未改为Java服务派发；会话一次发送自动关联服务Task、真实模型/文件工具接入integration受限需求执行体、不可变成果/确认/修改、专家正式知识自动采纳、群业务任务收束、统一例行任务业务记录、需求确认版本进入设计消费均未实施。私有记忆与专家正式记忆保持独立，不自动同步/授予权限或恢复调度。既有预览Ctrl+C/相对路径限制保留。本次是合并基础，不是功能闭环已完成。

状态：review_pending，最终typecheck与完整构建均退出0，保存候选后冻结由root审查。无用户决策阻塞；无真实业务副作用/推送/部署/目标分支改写。

## root P1复审修复：托管预览不能普通提交

root审查发现：integration FileViewer按任意threadId启用视觉编辑，而beta Bot预览新调用该组件，可能意外走普通stream.submit绕过LocalBotHost队列。

- 显式`visualEditPolicy`默认disabled；BotMessageFilePreview明确disabled，普通TabbedPanel/RightPanel明确thread-submit。外部知识预览保持默认关闭；不按cacheNamespace/标题推测身份。
- 检查全项目视觉提交入口：仅FileViewer中的HtmlPreviewWithVisualEdit调用useVisualEditSubmit。hook首次展示与实际提交均检查持久Bot身份botId+botHostId及Partner专用`cmb_devclaw_partner_task`标记；信息缺失时拒绝普通提交，点击时重读store防止旧闭包。普通/需求会话保留视觉编辑，不改BotClient或后端协议。
- 新增`tests/file-preview-visual-edit-browser.spec.ts`：实际React/FileViewer/HtmlPreview/useVisualEditSubmit，假file/stream IPC，隔离Electron。Bot/default HTML可预览且没有标注按钮；普通/需求HTML保留按钮；真正调用hook只产生ordinary/requirement两次stream提交，Bot/Partner/missing均false，渲染后改Bot元数据也拒绝。临时profile/host由finally回收。首次新测试fixture忘设esbuild虚拟模块resolveDir，编译失败；补齐后完整通过，非生产改动。
- 源码接线回归+纯guard/store/context+stage：5文件28/28，通过`/tmp/M01-visual-stage-final.log`；真实浏览器通过`/tmp/M01-preview-visual-browser-final.log`。修复后最终typecheck/build日志分别`/tmp/M01-typecheck-preview-final.log`、`/tmp/M01-build-preview-final.log`，对应最终产品快照；此前Java/核心Bot/IM代码未再改变，不重复无关全量。

候选最终以Git合并提交为准，双亲固定d76与91554。完成后进入review_pending并停止写产品代码，等待root审查；本代理不合目标分支、不推送。

最终产品检查点：`npm run typecheck`（`/tmp/M01-typecheck-preview-final.log`）与`CMB_BOTS_E2E=1 node node_modules/electron-vite/bin/electron-vite.js build --mode m01-isolated`（`/tmp/M01-build-preview-final.log`）均实际退出0；5文件28测试及浏览器回归退出0。`git diff --cached --check`通过。所有本代理测试/构建命令已结束，无存活测试句柄；临时Electron均正常close，无用户现有App/Java/数据库服务改动。
