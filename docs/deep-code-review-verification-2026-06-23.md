# 深度代码审计复核报告（对照当前代码）

复核日期：2026-06-23
来源报告：2026-06-22 深度代码审计清单（261 条；原始清单未随本分支提交）
复核方式：6 个子代理单趟并行，对**当前代码**重新定位每条证据（审计里的行号多已过期），逐条判定真假；无对抗反驳阶段。覆盖安全 + 正确性/数据丢失高价值候选 90 条，长尾性能/质量门禁/跨平台按设计妥协整体归类。

## 一句话结论

**值得当 bug 修的约 41 个（按根因去重）；原始确认 58 条；其中 Critical 2 + High 14 = 16 个高危。** 原报告 261 条中，真正成立的就这些；其余多为设计妥协 / 已修 / 描述不符（见下）。

## 结论速览

| 裁决            |       数量 | 含义                                        |
| --------------- | ---------: | ------------------------------------------- |
| REAL_BUG        | 41(去重后) | 当前代码确实存在、值得修                    |
| PARTIAL         |         19 | 真但被夸大/只部分成立/已大部分缓解          |
| DESIGN_TRADEOFF |       6 类 | 设计妥协/工程债，非运行期 bug（按要求排除） |
| NOT_A_BUG       |          4 | 当前代码有防护或描述不符                    |
| STALE           |          2 | 已修复                                      |
| UNCERTAIN       |          1 | 证据不足，需进一步定位                      |

> 注：原报告"已复现"的几条最吓人的，复核后**不成立或已修**——见下方"重要更正"。

## 一、重要更正（原报告说真，实则不成立 / 已修）

| 原编号     | 原结论                                                                  | 复核           | 依据（当前代码）                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-3 / C-1 | code_exec VM 可 `setTimeout.constructor("return process")()` 逃逸到宿主 | **NOT_A_BUG**  | `script-runtime.ts:171` 用 `codeGeneration:{strings:false}` 创建 context，Function/eval 编译字符串会抛 EvalError，命中的逃逸向量被现有防护挡住；process/require/Buffer/global 也已置 undefined。（注：子进程继承 env 的那半是真的，见 S-17） |
| H-3        | 自动批准用 basename，`./ls`/`/tmp/evil/cat`/`./gradlew` 判 safe         | **STALE 已修** | `exec-policy.ts:1448` `isPathQualifiedExecutable` 现已显式拒绝带路径分隔符的可执行名，env 解包后再查一次                                                                                                                                     |
| S-19       | 只读门把 `printenv`/裸 `env` 判 safe                                    | **STALE 已修** | `exec-policy.ts:1473` 显式 `printenv→false`；`env` 分支拒绝 `VAR=val` 前缀和裸 `env`                                                                                                                                                         |
| P1-12      | renderer 可传任意 ES body                                               | **NOT_A_BUG**  | `dashboard.ts` 每个 query body 都由主进程按结构化参数拼，固定 `_search`，且过 `requireDashboardAccess()`                                                                                                                                     |
| S-16       | Dashboard 客户端可写/删 ES                                              | **NOT_A_BUG**  | ES 客户端只发 `_search`（只读），"fallback"是节点轮询不是写回退；无 `_bulk/_update/DELETE` 路径                                                                                                                                              |
| L-8        | ChatX 入站线程没持久化模型不能续聊                                      | **NOT_A_BUG**  | 每条入站都从 robot 配置重解析模型并复用同线程，入站路径续聊正常                                                                                                                                                                              |
| AE-1       | 当前轮 final answer 回退到上一轮                                        | **STALE 已修** | `ipc/agent.ts` 只从当前 turn 的 values slice 提取 final text；`goals/evaluator.ts` 仅接收调用方已限定为当前 turn 的 `lastFinalText`                                                                                                          |
| S-13       | 聊天报告自动上传外发正文/本地路径                                       | **UNCERTAIN**  | 在受检文件内未定位到该上传路径，需找到真正的 report-upload 发送方再判                                                                                                                                                                        |

## 二、确认的真 bug（按严重程度，已按根因去重）

### 🔴 Critical

**1. preload 通用 IPC 桥 + 远程 SSO 窗口复用同一 preload + handler 缺 sender 校验**（P0-1 / H-4 / S-1 / M-11 / S-21 / P1-5 / S-2 / S-22）

- 根因 A：`src/preload/index.ts:141/150` 暴露通配 `ipcRenderer.send/invoke`，`:142-149` 通配 `on/once`，无 channel allowlist。
- 根因 B：`src/main/index.ts:577` 登录窗口、`:597` open-login-page、`:365` 主 renderer 可加载远程 URL（含 `https://oa-auth.paas...` SSO 页），都复用同一个 preload。
- 放大面：`threads:*`（`ipc/threads.ts:527-894`）等 handler 无 sender 校验；审批走 `runtime.ts:3095` 向**所有**窗口广播 + `sandbox.ts:743` 只校验"是某个已知窗口"。`ipc/git.ts:1199` 的 `execute-command` 可执行任意二进制（见 P1-9）。
- 后果:被攻陷/远程 SSO 页可订阅审批广播、伪造审批、读写删全部会话历史、改 sandbox/yolo,串成本机执行。
- 修:删通配 IPC 桥→最小化类型化 API;远程页/登录页用独立 session + 无 preload;特权 handler 校验 `event.senderFrame`/窗口归属 + 审批绑定 origin webContents id。

**2. 热更新信任根不成立**（P0-5 / H-7 / H-8 / M-12）

- `.env:21` `VITE_UPDATE_SERVER_URL=http://...`；`checker.ts:130` 按 scheme 静默走 http；manifest 无签名，期望 hash 也来自同一个 HTTP manifest（同源，对 MITM 无完整性意义）；`downloader.ts:142` `join(updatesDir, fileName)` 中 `fileName` 来自 manifest 无 basename/穿越校验；`installer.ts:633` 按下载文件扩展名 `.exe→spawn` / `.deb→sudo dpkg -i` 直接执行。
- 后果:控制更新源/DNS/内网链路即可下发恶意包并落到确定性执行。
- 修:强制 HTTPS + host allowlist;离线私钥签 manifest、客户端内置公钥验签;`fileName` 取 basename + 固定后缀/版本格式 + `path.relative` 校验在 updatesDir 内。

### 🟠 High

| 编号        | 标题                                                 | 当前证据                                                                                                                                           | 为何是真 bug                                                                       |
| ----------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0-6        | workspace 命令 hook 默认信任                         | `ipc/hooks.ts:294` untrusted 列表恒返回空；`storage.ts:3522` `getWorkspaceHooks` 无 trust gate 直接加载 `<ws>/.cmbdevclaw/hooks/*.json`            | 克隆/打开仓库即可投放命令 hook，在匹配事件时本机执行                               |
| S-17        | 命令 hook 继承完整 `process.env`                     | `hooks/runner.ts:328` `{...process.env}` 进子进程；`storage.ts:1040` 模型 API key 写入 `process.env`                                               | hook（含上面的不可信 workspace hook）拿到模型 API key 等全部 secret                |
| P0-4 / H-6  | ystRefreshToken/ystCode 明文进系统 prompt→trace      | `runtime.ts:3191-3192` 拼接;`trace/sanitizer.ts` 只按长度截断不按字段名脱敏;`task-cards.ts:475` 对同字段已 `<redacted>`(不一致)                    | 刷新 token 流向模型供应商 + 云端 trace                                             |
| P1-2        | memory_get 绝对路径/`../` 越界                       | `memory/store.ts:519` `isAbsolute(p)?p:join(memoryDir,p)` 后直接 readFileSync,无 containment                                                       | agent 启用 memory 即可读任意文件                                                   |
| P1-1        | workspace 读边界字符串前缀                           | `ipc/models.ts:3180` `startsWith(resolvedWorkspace)` 无尾分隔符、无 realpath                                                                       | `/a/proj` 接受 `/a/proj-evil/...`;symlink 也越界                                   |
| P1-3        | preload 任意外部文件读                               | `ipc/models.ts:4111` `readExternalFile`/`:4134` binary,`path.resolve` 后直接读无 capability/边界(注释明写"允许 workspace 外")                      | renderer 可读任意绝对路径(文本/二进制)                                             |
| P0-2        | HTML 预览 srcDoc 同源逃逸                            | `HtmlPreview.tsx:162` `sandbox="allow-scripts allow-same-origin"` + srcDoc 为 LLM 可影响 HTML;主窗口 contextBridge 暴露 `window.api`(含外部文件读) | iframe 脚本可达 `window.parent` 与 `api`                                           |
| P0-7        | MCP stdio 任意本地命令 + 远程默认注入身份头          | `ipc/mcp.ts:22` stdio connector 仅类型校验无 allowlist;`mcp/headers.ts:18` `injectUserHeaders!==false` 默认注入 yst_id_token/sap_id                | renderer 可配置启动任意本地命令;身份头默认外发                                     |
| P1-9        | git execute-command 任意二进制 + 全局 safe.directory | `ipc/git.ts:1199`→`runShellCommand`→`parseCommand`(无 `isGitExecutable` 守卫)→execFile;`models.ts:1120` `git config --global ... safe.directory`   | IPC 可执行任意二进制;污染用户全局 git 配置                                         |
| P1-7 / S-11 | LSP VSIX 仅结构校验即 chmod+执行                     | `lsp/server.ts:128` 只查结构/平台;`:247` `extractAllTo`(无大小/entry/zip-slip 上限);`:286` chmod 0o755 后执行打包 java                             | 恶意/被 MITM 的 VSIX→代码执行 + zip-slip/zip-bomb                                  |
| S-10        | workspace agents 覆盖内置只读子代理提权              | `agent-registry.ts:585` workspace `.cmbcoworkagent/agents` 最后加载(后写覆盖);`parseAgentFile` 由 frontmatter 决定 shellAccess 无 clamp            | 不可信仓库放同名 agent 文件即可把只读子代理改成 full                               |
| S-15        | 真实密钥随 .env/VITE\_\* 分发                        | `.env`(仍被 git 跟踪)含已填的 `VITE_ROUTING_CLASSIFIER_API_KEY`、`VITE_ES_PASSWORD`,VITE\_ 前缀编进 renderer 包                                    | 模型 key + ES 口令进入分发产物可被提取                                             |
| Q-5         | sql.js 核心 DB 全库 export 直接覆盖                  | `checkpointer/sqljs-saver.ts:205`、`db/index.ts:30` `export()` 后 `writeFileSync` 写最终文件,无 tmp+rename                                         | 崩溃/断电/磁盘满→截断损坏唯一 DB,丢历史(仓库已有原子写法 `storage.ts:3428` 未复用) |
| L-7         | ChatX stop/删除后仍 drain 队列                       | `services/chatx.ts:481` cancel 只 abort 不清 queue;`:310` finally 无条件处理下一条;`threads.ts` 无任何 ChatX cancel                                | 停止/删除后队列继续起 agent run + 回 HTTP                                          |
| Q-3         | resume failover 重复提交 HITL                        | `ipc/agent.ts:6871` 流中 failover 在已消费 resume 后又 `stream(new Command({resume}))`                                                             | 同一审批/输入决策对无 pending interrupt 的 checkpoint 重放,工具可能重复执行        |

### 🟡 Medium

| 编号        | 标题                                                            | 关键证据                                                                                                                                      |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| M-14 / AE-9 | failover 把 480/483/485、内容审核 4xx 当可重试                  | `failover.ts:117` non-retryable 只有 400/401/403;`:180` `status>=4xx→retry`;字典已把 480/483/485 标 invalid_request,换模型只是重复必败请求    |
| AE-5        | Auto 路由可选无 key 模型,primary 错配在 failover 前硬失败       | `storage.ts:3841`/`routing/index.ts:709`/`failover.ts:417` 不按 apiKey 过滤;keyless primary 返回 401 被判 non-retryable→`agent.ts:3942` throw |
| AE-2        | resume 路径不复用正常 invoke 副作用                             | `ipc/agent.ts:6881-6957` 缺 `tracer.finish`/routing feedback/ChatX 回复/skill evolution(invoke 路径 `:5920-5993` 有)                          |
| Q-6         | checkpointer 并发初始化同线程两 saver 覆盖                      | `runtime.ts:2116` 在 `await initialize()` 之后才写 cache,无 in-flight promise 去重                                                            |
| Q-14        | ChatX 队列满前已标 processed,重试永久丢                         | `services/chatx.ts:174` dedup 早于 `:182` 队列满丢弃                                                                                          |
| C-1b        | 替换运行只等 30s,无 runId/epoch 门                              | `ipc/agent.ts:277` 30s;stream 仅按 `agent:stream:${threadId}` 键,旧 run 迟到事件可污染新轮                                                    |
| H-9 / C-6   | heartbeat running 守卫在 await 后 + 全局 abortController 空引用 | `heartbeat.ts:234` running 在 `await resolveModel` 后才置;`:140` stop 把 abortController 置 null 而运行循环仍 `:301` 解引用                   |
| S-5         | testConnection 把已存 API key 转发到 renderer 指定 URL          | `ipc/models.ts:2761` `apiKey=saved.apiKey` 但 `baseUrl` 用入参→`:2805` 发到任意 URL(key 外泄/SSRF)                                            |
| S-7         | renderer 可任意写 UserInfo/SSO 身份                             | `ipc/models.ts:2676` 无校验持久化;喂 `dashboard.ts:711` 授权(unrestrictedIds)与 MCP 身份头                                                    |
| S-18        | 远程 MCP 默认注入企业身份头                                     | `mcp/headers.ts:18` 默认 on,yst_id_token 默认发往任意远程 MCP URL                                                                             |
| S-24        | Market 只读边界依赖可变 origin                                  | `plugin-file-gates.ts:199` 按 `origin==='local'`;`plugins.ts:824` `setOriginsBatch` 可被 renderer 改写                                        |
| S-12        | manage_skill patch/delete 无确认                                | `skill-evolution-tool.ts` create 有 `requestConfirmation`,patch(全量替换 `:421`)/delete 无                                                    |
| S-14        | ChatX 默认明文 ws/http + 入站无 sender 授权                     | `services/chatx.ts:326` 允许 `ws://`;`:166` 仅按 chatId 匹配,fromId 不校验即驱动 agent                                                        |
| M-13        | scheduled tasks 非原子写                                        | `storage.ts:1764` `writeFileSync`;`:1716` 读失败 `return []`→下次 upsert 写空丢任务                                                           |
| QE-18       | Windows watch-ref 边界用 `/` 拼接                               | `watch-ref-watcher.ts:17` `resolve()` 后却硬编码 `/`,Windows 合法子路径被误拒                                                                 |
| D-18        | Dream 整理移动 fact 后不同步 MEMORY.md                          | `memory/consolidate.ts` 文件头承诺更新 MEMORY.md,apply 路径只重建索引未重生成 manifest                                                        |

### 🟢 Low（真但低危/窄触发，按 ROI 可缓修）

M-10(只读 agent 可 nslookup/ping 带外)、S-22(openExternal 无 scheme allowlist)、D-4(metadata 解析失败写回 `{}`)、D-2(heartbeat restore 先删后写,崩溃丢史)、D-3(goal 事件持久化失败仍报成功)、D-8(memory-settings 损坏 fail-open 重启用)、D-9(userinfo-models.json 无解析保护阻断 runtime)。

## 三、PARTIAL（真但被夸大 / 已大部分缓解）

- **C-1a**:VM 逃逸不成立(见更正),但子进程继承 env 拿 API key 那半是真的(并入 S-17)。
- **P1-8**:skill 安装已有 zip-slip 防护(`skills.ts:1154`)且 adm-zip 不落 symlink;仅剩无大小/entry 上限的本地 zip-bomb DoS(低)。真正无界解压在 LSP VSIX(P1-7)。
- **P1-6**:凭据暴露是上述具体项(S-17/P0-4)的伞,非单点。
- **AE-11**:MCP 错误文本**会**到模型,但 ToolMessage 恒 `status:'success'`,丢的是结构化 isError 标志。
- **C-3**:scheduler/heartbeat 用独立 threadId,不会与用户删线程相撞;只有 ChatX 那条腿真(=L-7)。
- **C-5**:后台 shell 任务其实按 threadId 在 cancel/interrupt 路径被取消,"完全脱离生命周期"已基本缓解;残留只是有意的"切会话存活"。
- 其余:S-8、S-23、S-9、L-4、C-9、Q-7、Q-8、Q-9?、L-5、D-7、D-10、P2-3、AE-4、QE-20 —— 见报告数据,多为窄边界或部分成立。
- **D-7**:外键 CASCADE 声明了但 `PRAGMA foreign_keys` 没开是真的,**但 `runs` 表全代码无 INSERT,是死 schema**,无实际孤儿数据。

## 四、按要求排除（设计妥协 / 非问题）

- **性能 PF-1~PF-33**:观察属实(逐 token 全量重渲染、sql.js 每次全库 export、in-memory 解 zip、同步日志 rotate、会话级缓存无界),但不产生错误结果/数据丢失,属可扩展性/性能债→性能 roadmap。
- **质量/发布/跨平台 QE-1~QE-28**(除 QE-18/QE-20):CI 不跑测试、release 跳门禁、签名/公证缺失、版本漂移、POSIX-only 脚本等——真实的发布工程缺口,但非运行期 bug→发布加固 backlog。
- **AE-17~AE-30**:agent 执行效果/保真度类(resume 回放截断值、token 预算欠计、上下文污染、相对/绝对路径),耦合 workflow-resume 设计语义,建议交 workflow/agent owner,不作独立 bug。
- **S-4(Terminal PTY)**:是用户自己的终端功能(非 agent 工具),且 `terminal.ts:447` 有 `isAllowedSender` 挡远程页——不是缺陷。
- **S-20(IDE 配置桥)**:用户发起的 IDE 选择器,固定 argv 无 shell 插值,无注入;利用面归并到 preload 信任边界问题。
- **Q-20(StreamConverter 丢无主 subagent chunk)**:有意的兜底,backend 有 owner 提示 + 三级归属,真丢极少。

## 优先级建议（ROI）

1. **先修信任边界两根**:preload 通配 IPC 桥 + 远程 SSO 复用 preload(收一处塌掉 ~8 条);热更新 HTTPS+签名(P0-5 链)。
2. **低成本高收益**:`memory_get` 与 workspace 读用 realpath+relative(P1-2/P1-1);sql.js 核心 DB 改 tmp+rename(Q-5,仓库已有现成写法);scheduled-tasks 原子写(M-13);failover 错误码白名单(M-14/AE-9)。
3. **凭据面**:YST token 移出 prompt + 轮换(P0-4);hook/子进程 env allowlist 剔除 token/key(S-17);.env 里 VITE\_ 只放公开配置 + 轮换已泄密钥(S-15)。
4. **ChatX**:停止/删除清队列(L-7);dedup 改在入队后(Q-14)。
