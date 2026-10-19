# M02 / sol-xhigh 实施记录

**当前最终状态：review_pending，候选冻结，等待root独立审查与集成。** 最终79/79核心、32/32 IPC+Bot、530/530本地Bot、desktop/IM26入口、契约24、Java69/1884parity、实际服务UI/伙伴UI、main/Web类型与m02-isolated完整构建均通过；日志/命令见后文“最终候选”。真实HTTP最终命令7809已确认退出0，测试project `devclaw-bot-test-748763931d357b2f`精确removed，相关测试进程为空；root持有原B00 MySQL最终原状恢复责任。截图 `/tmp/m02-service-conversation.png` 已用构建theme/Tailwind重拍，结果时间本地化。准确候选SHA以包含本记录的Git提交及交付消息为准。

下方最初进度和“HTTP执行中”等段落是带顺序的历史检查点，不能覆盖上述最终状态。

2026-10-19。唯一产品实施写者 `/root/service_conversation_sol`，gpt-6.1-sol/xhigh。任务单 `tasks/M02-service-conversation.md` ready（3d26ccfc）。工作树 `/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6`，分支 `codex/bot-service-conversation-m02`。起始 clean/e80f741c，已 ff-only 同步至 3d26ccfc。目标 integration 仅只读 AGENTS.md，未写。

## 设计与进度

- shared 窄 API；SQLite journal 持久 scope/conversation/task/request、固定 command/version/deadline、enqueue 前完整执行与模型绑定。
- 主应用服务先 journal 再 HTTP，恢复只续原意图；当前 Run 终态前补充只留本地下一轮。
- 复用单 worker，按可信 claim 的 command/requester 和全部冻结 scope 路由；明确 legacy 开发命令仍 fake，其余拒绝。
- 展示消息使用独立 journal，无展示 Thread；执行继续使用专用 Task/stage/node Thread。beta 工作区增加服务专家入口/会话与任务卡，保留 local Bot 全路径。
- 模型 ref + 非密钥配置 hash；只通过 main registry 取 key，测试仅 fake 注入。

当前：已核对 Git/任务/最新 state 与 HANDOFF/README、M01 验收、功能设计，读现有 controller/client/worker/executor/attempt store/runtime resolver 与 beta 工作区。尚无产品写入、测试或服务/容器变更。下一步实现类型、journal 与应用服务，然后接 worker/IPC/UI。

## 验证与副作用

- `git status --short --branch && git rev-parse HEAD`：0，clean/e80f741c。
- `git merge --ff-only 3d26ccfc0a4053f5800252e66eb25a8be356d314`：0，仅 root 的四个交付文档。
- 当前无运行测试句柄；未调用真实模型/内网，未改用户 App/数据库/容器/卷；不恢复自动任务、不 push/deploy。

## 检查点：core/IPC/UI 初稿已接线，开始故障矩阵

新增 `shared/bot/service-conversation.ts`、`service-model-binding.ts`、`service-conversation-store.ts`、`service-conversation.ts`、`service-conversation-router.ts` 及 beta `ServiceExpertConversation.tsx`。旧 controller 增当前身份/业务 Group 权限上下文和显式 legacy enqueue 绑定；IPC lazy journal/service、preload 窄类型、单worker路由及生命周期已接。模型 hash 通过 executor→partnerInputOnly→最终 resolver 再核对，同一 config 快照构建模型，密钥不进入 journal/renderer。新增 scope/serverTask 与 enqueueCommand 表达式索引，deadline按 epoch 核对；enqueue 首次准备时持久固定期限，补充等待不消耗窗口。

root 早审指出 send replay catch(FORBIDDEN) 范围过大，已拆为显式 nullable 本地查询，远端 inspect 拒绝直接传播；加入成功缓存被拒负例。运行中恢复将用现有 node inspect 精确ticket，避免 Java claim(running) COMMAND_CONFLICT；executor 没有 durable attempt 时拒绝 running 重新开模型，未改 Java/公共契约。

已完成：持久命令与模型、补充串行、结果稳定投影、当前权限读核验、早claim绑定、窄IPC、beta服务会话初稿。剩余：故障矩阵修复/IPC安全测试、实际DeepAgent路由和重开重交、真实JavaHTTP隔离MySQL旅程、真实React界面与local Bot回归、类型与安全构建、格式审查和候选提交。

初轮 main 类型命令遗漏仓库既有 `--composite false`，产生历史跨renderer test文件TS6307及一条新增unused；已按 npm typecheck:node参数重跑，`/tmp/m02-main-second.log` 空日志/退出0。第一次主端命令日志 `/tmp/m02-main-first.log` 保留。Web首次与新SQLite core测试已执行，正在读取结果；未声称通过。尚无服务/容器/真实模型调用或用户App变更。活动句柄：此前Web53137（待取终态）。

## 检查点：单元/实际UI通过，真实HTTP旅程执行中

- `/tmp/m02-core-second.log`：11/11新SQLite矩阵通过。首轮10/11的unknown断言提前一个扫描周期，测试现核对观察到前Run unknown后阻止补充；没有放宽不发message/enqueue要求。
- `/tmp/m02-core-regression-first.log`：55/55（新11 + controller/client/worker/executor受影响回归）。
- `/tmp/m02-ipc-first.log`：16/16（含新窄API形状、顶层窗口与不可传身份/路径/RunSpec）；随后增加updates和失败连接失效通知用例，最终需重跑。
- `/tmp/m02-runtime-first.log`：2/2，实际受限DeepAgent与单worker；router后resolver前模型漂移零模型、检查后config快照跨await保持、RUNNING result_ready+删除模型通过node inspect恢复同结果settle、无attempt running拒绝模型。
- `/tmp/m02-ui-fifth.log`：真实隔离Electron/React通过：正常新Task/运行→同Task补充next_round→精确request停止→分析结果→重挂载不send；41条展开历史刷新保留、终态停止poll、切任务迟到read与换身份迟到send丢弃，local Bot调用0。
- UI前次失败日志保留：first因esbuild无outdir无法导入CSS；second/third发现StreamingMarkdown隐含ThreadProvider/个人文件预览依赖。生产服务结果现用ReactMarkdown安全纯展示（禁文件/图片/链接动作），复用Bot头像/布局，未引入展示Thread。
- `/tmp/m02-web-third.log`：Web类型0（首两次误用window.electron而非项目window.api，已修正）；main third日志0。新修改后最终类型仍待重跑。

恢复与安全收尾：result_ready/settled路由不要求模型仍存在；reserved/running本地unknown持久并不被只读服务running覆盖。模型拒绝用既有Java允许的EXECUTION_FAILED结算、journal留MODEL_*解释。OUTCOME_UNKNOWN的HTTP写回包按原命令恢复；与模型执行unknown分开。首次enqueue才冻结deadline。服务变更操作开始/结束均发busy失效通知，失败也清空旧缓存；scope切换期间暂停旧结果读取。自动UI仅updates非终态请求（每批40），终态历史只在手动刷新/重开时重读；展开页范围保持。

`tests/bot/service-conversation-http-journey.ts` 已就绪。root核对原B00容器/卷/daemon并临时精确启动同MySQL693a1c3，httpDevProof健康通过后授权唯一隔离harness。当前命令句柄21500，日志 `/tmp/m02-http-first.log`，未得终态，不声称通过。测试只fake模型、专用fixture；不动用户Partner库，root负责最后还原原B00停止状态。最终正常UI截图目标 `/tmp/m02-service-conversation.png`（新一轮待生成）。

## 最终候选 / review_pending

本片产品实现已完成，自测进入待root审查；候选为包含本记录的本地提交（准确SHA见Git/交付消息）。不自行写state/HANDOFF、集成目标树或恢复定时。

最终模块：

- `shared/bot/service-conversation.ts`、main `service-conversation-boundary/store/service/router/model-binding` 与窄 preload。SQLite事务保存完整scope（含本机工作区映射的非明文hash）、conversation/task/request、原命令、CAS版本、模型冻结和enqueue绑定；不保存模型/服务密钥。
- beta `BotsWorkspace` 服务专家入口、独立展示会话和任务记录。新任务/选任务、保存/等待/运行/下一轮/结果/停止与重开恢复，安全Markdown仅显示文本，不挂个人Thread或local Bot提交/文件/浏览器入口。
- 单node worker精确路由；claim早于HTTP回包可安全绑定；保留旧开发fake路径。RUNNING通过当前node inspect恢复原ticket，result_ready只重交；reserved/running/lease lost持久unknown，不被只读running覆写、不自动启动新Run。
- 模型显式选择，ref+非密钥参数hash在请求接受时冻结、enqueue前保存完整绑定；router、最终resolver均核对，同一config快照跨异步构建。漂移/删除拒绝新执行，Java用既有合法失败码结算，journal保留可解释原因；已保存结果不依赖模型仍存在。
- startExpert复用当前相同space/group/node/owner/workspace、enabled且未过期的grant，避免重启隐式递增grantVersion破坏原Run恢复；撤销/过期后仍需用户明确启动授权。启用确认已说明服务会话使用明确模型、开发演示仍模拟。
- 连接/身份/权限变更前后发busy失效通知，失败同样清空旧结果，变更期间不读缓存；所有迟到回包检查generation/conversation/task。当前权限核验先于缓存结果披露。

### 实际最终命令与结果

全部使用 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`，表中`node`均指此绝对路径。日志不互相相加作为全仓覆盖数。

| 命令 | 结果与日志 |
| --- | --- |
| `node --import tsx --test tests/bot/service-conversation.spec.ts tests/bot/service-conversation-runtime.spec.ts tests/bot/expert-controller.spec.ts tests/bot/partner-local-client.spec.ts tests/bot/partner-local-worker.spec.ts tests/bot/partner-dev-controller.spec.ts tests/bot/requirement-executor.spec.ts tests/bot/task-thread-store.spec.ts` | `/tmp/m02-core-freeze.log`；含create/message/enqueue失连接及显式OUTCOME_UNKNOWN、SQLite落盘失败、幂等冲突、同文本新请求、补充顺序/CAS冲突、取消竞态、跨scope/缓存拒读、95条任务分页与受限runtime恢复。最终79/79。此前最终增补前77/77为`/tmp/m02-core-post-format.log`。 |
| `node node_modules/vitest/vitest.mjs run src/main/ipc/partner-dev.test.ts src/main/ipc/bots.test.ts src/shared/bots/contracts.test.ts src/main/agent/agent-run-service.test.ts` | 实际匹配2文件32/32（partner17、Bot15）；后两个路径无匹配用例，不计作已测。`/tmp/m02-ipc-bot-final.log`。 |
| `node node_modules/vitest/vitest.mjs run src/main/bots src/shared/bots src/renderer/src/components/bots src/renderer/src/lib/bot-` | 51文件530/530，`/tmp/m02-local-bot-regression.log`。 |
| `node --import tsx --test --test-concurrency=2 <package.json中desktop7与IM19入口>` | 26入口26/26，含模拟招乎与桌面租约/受控提交；`/tmp/m02-desktop-im-regression.log`。实际路径按两个npm script的既有入口展开，无新增测试选择口径。 |
| `node --import tsx tests/bot/partner-panel-browser.ts` | 实际React/Chromium、启用模型说明、记忆/权限/旧开发界面通过；`/tmp/m02-partner-ui-final.log`。 |
| `node --import tsx tests/bot/service-conversation-browser.ts` | 实际React/Chromium全部通过；`/tmp/m02-ui-themed-final.log`。41条展开分页、正常发送/补充/停止/结果/重挂载不重发、迟到read/send与busy切连接、终态不poll，local Bot调用0。最终加载构建的App Tailwind/theme与Bot CSS，截图 `/tmp/m02-service-conversation.png`，使用现有本地化结果时间。 |
| `node --import tsx tests/bot/service-conversation-http-journey.ts` | 最终0，`/tmp/m02-http-final.log`；Java HTTP+隔离MySQL+真正SQLite关闭重开+单worker+现有DeepAgent fake。首轮+同Task补充model2/tools0，early claim；模型漂移零额外模型且服务合法失败；result_ready后模型删除，RUNNING inspect原attempt重交不重跑；旧开发fake保留，总模型4。最终project `devclaw-bot-test-748763931d357b2f`精确removed，原dev identity/健康保持。前次同旅程`/tmp/m02-http-second.log`也0/已回收。 |
| `node deploy/dev/service/build.mjs` | 69JUnit、1884parity零差异、Java8打包/产物审计通过；`/tmp/m02-java-build.log`。Java/公共协议/迁移没有产品改动。 |
| `node tests/bot/check-contracts.mjs` | 24/24，`/tmp/m02-contracts-final.log`。 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` 与Web同参数 | 最终均0，`/tmp/m02-main-freeze.log`、`/tmp/m02-web-freeze.log`。 |
| `node --import tsx --test tests/bot/service-conversation-runtime.spec.ts tests/bot/requirement-executor.spec.ts` | 最终hash校验后25/25，`/tmp/m02-runtime-freeze.log`。 |
| `node node_modules/electron-vite/bin/electron-vite.js build --mode m02-isolated` | 最终main/preload/renderer完整0，`/tmp/m02-build-freeze.log`（25.34s）。此前`/tmp/m02-build-final.log`也0；使用隔离mode，未解密/输出`.env`内容。 |

新/修改TS/TSX/CSS已用仓库Prettier格式化；对既有大文件只保留新增模块接点，清除formatter对无关旧段的重排。`git diff --check`通过。全部本代理测试/构建句柄已取退出0（最终core增补79/79同样已确认）；相关测试Node/Electron/PartnerHttpMain进程查询为空。未推送/部署，不动用户App或Partner用户库；root临时启动的原B00 MySQL由root在独立复验后恢复原停止状态，本代理不擅自操作。

### 初轮失败与修复事实

- 初轮main tsc遗漏既有`--composite false`导致TS6307，后按仓库命令通过；初轮Web误用`window.electron`，改为项目`window.api`后通过。
- 首SQLite矩阵unknown状态断言早于扫描观察，改为检查观察后仍不追加/不派发，补充本地unknown不被remote running覆写与CAS冲突不跳过输入用例。
- UI首轮esbuild缺outdir，后发现StreamingMarkdown隐式个人Thread/预览依赖；现用无文件/链接/图片动作的Markdown显示，真实Electron重验通过。
- 第一HTTP在建库前因本树未有target jar而退出1（`/tmp/m02-http-first.log`），没有测试project或数据副作用；先build.mjs后两次真正旅程通过。
- root早审的缓存FORBIDDEN catch范围、模型TOCTOU、deadline等待窗口、RUNNING恢复/grantVersion、合法服务失败码、分页/迟到回包/连接失败失效均已修正并有上述针对性验证。

### 范围与性能说明

本片仅当前注册单专家、本机journal历史、文本分析；没有专家目录/换机同步、正式成果文件版本/确认审批、群收束或自动知识采纳。真实配置模型能力已接线，验证全部fake，付费模型调用0；不声称已做真实provider推理实测。

本片没有ES查询新增/修改。journal按scope/conversation/task复合索引、稳定向前游标每页40（多取1判定下一页）；pending恢复批8、单泵串行；结果inspect同时最多2，HTTP client总在途上限8，单node worker/单graph。终态停UI轮询，自动更新只查询可见非终态request，手动刷新保持已展开历史范围；不通过丢历史/重置命令/新deadline换速度。以上为结构与fixture验证，不是生产耗时承诺。
