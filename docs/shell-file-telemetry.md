# Shell 文件操作埋点补齐

日期：2026-09-23。背景：Bash First（命令行优先）让 Agent 用 `execute` 读写普通文本文件，而代码采纳、Skill 使用识别、约束文件读取等埋点原来只挂在 read_file / write_file / edit_file 上，走 Shell 时全部缺失。

## 1. 口径

| 项目                 | 口径                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开关                 | 只在工具使用策略为"命令行优先"或"命令行优先（宽松）"时启用；标准模式完全走原来的逻辑                                                                                                                                                                                               |
| 计入采纳（A 类）     | 内容由模型决定、借 Shell 写入：heredoc、`printf >`、`sed -i`、`perl -pi`、`sed … > 过滤结果`、内联脚本、python/node 脚本、`python3 <<EOF` 这类从 stdin 读程序的解释器、同一条命令里刚写出或暂存在临时目录的 shell 脚本；先写临时文件再 mv/cp 到目标的改动                          |
| 归属但不计入（B 类） | 第三方工具按自身规则生成：formatter、代码生成器、脚手架、快照更新、pre-commit；包装它们的项目脚本（按 package.json 脚本内容或名字判断，如 `npm run format`、`make fmt`、`./scripts/format.sh`）；透传了 `--fix`、`-u` 等参数的脚本（如 `npm run lint -- --fix`、`npm test -- -u`） |
| 归属但不计入（C 类） | 搬运或恢复已有内容：cp、mv、git checkout / restore / stash / merge / pull 等；把已有文件内容、git 历史版本、下载内容重定向或通过管道搬到文件（`cat 模板 > 新文件`、`cat 模板 \| tee 新文件`、`git show HEAD:x \| tee x`、`curl … > x`）                                            |
| 不捕获               | 读命令、测试、构建、安装、后台命令；测试/构建把日志重定向到文件也不捕获                                                                                                                                                                                                            |
| 短命令               | 运行时间不超过 5 秒且不含测试/构建类片段：窗口内变化的文件都归它                                                                                                                                                                                                                   |
| 长命令               | 超过 5 秒或含测试/构建类片段：只认命令里点名的文件                                                                                                                                                                                                                                 |
| 点名路径             | 编辑段的参数和写入目标；管道喂给编辑段的读段路径、`for` 循环遍历的路径；sed/grep/awk/jq/tr 的表达式参数、数字、文件系统根目录不算                                                                                                                                                  |
| 窗口重叠             | 先归点名该文件的窗口；都没点名且有其他可能写文件的短窗口时，不归属，只记日志                                                                                                                                                                                                       |
| 识别不出的命令       | 按 A 类处理                                                                                                                                                                                                                                                                        |
| 看板                 | 不区分来源，`tool` 字段记为 `execute`，不改 ES mapping                                                                                                                                                                                                                             |
| SKILL.md 走 Shell    | 不拦截，按 read_file 同样口径记 Skill 使用识别；PreSkillUse 钩子和占位符替换不在本次范围                                                                                                                                                                                           |

## 2. 实现

开关：

1. `createAgentRuntime` 用提示词同一份策略快照决定 `LocalSandbox` 的 `shellFileTelemetry`：主图的有效策略（按 filesystemAccess、禁用工具、是否启用文件系统过滤，Windows 只读沙箱降为标准），或共用沙箱的 task 子 Agent 在访问限制下仍可能得到的策略，两者任一为命令行优先即开启（`resolveShellFileTelemetry`）。coordinator worker 和 workflow 子 Agent 按各自运行判断，workflow 子 Agent 在 YOLO 关闭时为标准模式，不捕获。
2. 流里的 Skill 识别读当前全局设置：标准模式下 execute 不参与识别，只认 read_file。运行中切换设置时，识别从下一次观测起按新设置生效，沙箱仍按构造时的快照。
3. write_file / edit_file 的写后登记不受开关控制。没有打开的比对窗口时它什么也不做；有窗口时（另一个运行开了命令行优先）用于防止重复计数。

写入侧在 execute 前后比对工作区：

1. 前台 execute 在 `executeAfterPreToolUse` 中通过 AsyncLocalStorage 标记本次调用，包括生产 Orchestrator 分支和兼容 fallback 分支；`executeRaw` 在进入 Windows 沙箱队列前读取标记。审批等待、前后钩子和队列等待都不计入窗口，沙箱失败后的每次重试单独成窗。直接调用 executeRaw 的 Hook 和后台任务不带此标记。
2. 执行前对工作区内每个 git 仓库及其已初始化的子模块跑 `git status --porcelain=v2 -z --untracked-files=all --no-renames`，记录脏文件的 lstat，并读取脏代码文件内容（按路径、mtime、大小缓存）。只含 B/C 类的命令不读内容，只比 stat。
3. 执行后再跑一次 status，找出变化文件。前像取自缓存（原本就脏的文件）、`git cat-file --batch` 取 HEAD 版本（原本干净的文件，先用 `--batch-check` 查大小）或空内容（新文件）。目录、符号链接、子模块入口和未跟踪的嵌套仓库不算文件改动，也不算删除；新建的空文件保留。
4. 捕获模块只传原始字节，`recordShellEdit` 用提交时同一个 `decodeCodeBuffer` 解码，GBK 等非 UTF-8 文件的行哈希与提交时一致；再按行多重集相减，只记录新增行和删除行。解码和行比对的代码放在 `adoption-lines.ts`，前后内容合计 32 KB 以内在主线程直接算，更大的交给 worker 线程执行同一份代码，结果相同。
5. 归属的文件（含 B/C 类和删除）调用 `onFileMutation(path, "shell")`，恢复自动提交的"已报告文件"、git hook 自动安装和记忆整理的写文件列表。
6. write_file / edit_file 成功后登记写后内容。比对时若文件当前内容就是登记的内容，视为已由文件工具上报；若登记早于本次观测且 Shell 又改过，只计登记之后的部分；登记晚于本次观测的，交给文件工具自己上报。先结束的窗口登记自己的归属，后结束的重叠窗口以此为前像。

读取侧：

1. `readPathsForToolCall` 统一决定工具调用读了哪些路径，read_file 取参数，execute 从命令里提取路径（按 `execute.cwd` 和 `cd` 解析相对路径，去掉注释、heredoc 正文、写重定向目标和表达式参数）。4 个 Skill 识别点都改为调用它。
2. 约束文件：前台 execute 退出码为 0 且有 stdout 时，对命令里的路径调用现有的约束文件读取记录逻辑。execute 工具按 read_file 的方式解析发起调用的 Agent 的 trace，task 子 Agent 的读取记到它自己的 trace 上。
3. `recordSkillUse` 只服务于 PostSkillUse 钩子和 Stop 钩子上下文，属于钩子范围，本次不接。

## 3. 性能与主进程保护

| 措施             | 取值                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git 调用         | 全部异步 spawn，`GIT_OPTIONAL_LOCKS=0`，单次 3 秒超时，超时强杀；status 输出上限 8 MB                                                                                                                            |
| 慢仓库熔断       | 某仓库一次 status 超过 1.5 秒、超时或出错，暂停对它的捕获 10 分钟                                                                                                                                                |
| 总预算           | 执行前比对 4 秒、执行后比对 6 秒，超出即放弃本次捕获，命令照常执行和返回                                                                                                                                         |
| 内容读取         | 参与比对的单文件 2 MB 以内；每次快照读盘内容 32 MB 以内；内容缓存 64 MB；跟踪条目 5000 个以内；HEAD 版本单批 32 MB 以内                                                                                          |
| 编码探测与行比对 | 在工具结果返回之后逐个文件执行；纯 ASCII 内容直接按 UTF-8 解码（与探测结果一致）；前后合计 32 KB 以内在主线程算，最多几毫秒；更大的交给 worker 线程，主线程只拷贝字节                                            |
| worker 线程      | 按需启动，空闲 60 秒退出；任务逐个执行，单个任务 10 秒超时；超时或崩溃时跳过该文件并换新 worker，不回退到主线程；worker 启动失败时 60 秒内改在主线程计算，只算前后合计 256 KB 以内的文件（约 40 ms），更大的跳过 |
| package.json     | 异步读取、按 mtime 缓存，只在命令里出现 npm/pnpm/yarn/bun 时读取                                                                                                                                                 |

历史方案实测（下述数值来自恢复的设计记录，不是本次重建测量）：

- 2 万个文件的仓库上，每条会写文件的命令执行前、后各多出约 33 到 39 ms（含 200 个未提交修改文件时）。
- 主线程上，编码探测每 MB 约 70 到 130 ms（GBK 偏高），行比对每 MB 约 20 ms，所以大文件放到 worker 里。打包产物实测：worker 启动 32 ms，1.7 MB 的 GBK 文件前后对比在 worker 中约 0.5 秒。

## 4. 代码位置

| 文件                                     | 内容                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| src/main/agent/telemetry-shell-syntax.ts | 不执行命令的结构分词，保留重定向、复合块、引用、管道、heredoc 正文；不用于权限判定 |
| src/main/agent/shell-command-profile.ts  | A/B/C 与测试构建类判定、点名路径与读路径提取、package.json 脚本异步加载            |
| src/main/agent/shell-file-effects.ts     | 前后快照、差集、窗口登记表、归属规则、超时、熔断与预算                             |
| src/main/agent/tool-call-read-paths.ts   | 工具调用的读路径                                                                   |
| src/main/agent/tool-strategy.ts          | `resolveShellFileTelemetry` 开关判断                                               |
| src/main/agent/local-sandbox.ts          | executeRaw 接入、write/edit 登记、约束文件读取、采纳记录延后执行                   |
| src/main/agent/runtime.ts                | 打开沙箱的 `shellFileTelemetry`；execute 工具传入 trace                            |
| src/main/services/adoption-tracker.ts    | `tool: "execute"`、`recordShellEdit`                                               |
| src/main/services/adoption-lines.ts      | 解码、行归一化与哈希（从 adoption-tracker 原样移出）、`shellEditLineFragments`     |
| src/main/services/shell-edit-diff-\*.ts  | 大文件解码和行比对的 worker 线程及其客户端                                         |
| src/main/ipc/agent.ts                    | Shell 写入进入记忆整理的写文件列表                                                 |

## 5. 已知限制

- 窗口内用户在 IDE 里保存的文件，短命令下仍可能被算作 Agent 生成；长命令只认点名文件，降低了这种误算。
- 前台短命令窗口内，此前启动的后台命令写入的文件同样会归到这条前台命令上。
- 同一条命令里先 A 后 B（如 `sed -i ... && prettier --write .`），formatter 点名范围内的文件按 B 类处理。
- Shell 和文件工具在同一窗口内先后改同一个文件、且文件最终内容正好等于文件工具写入的内容时，Shell 在文件工具写入之前做的那部分改动不计入。
- 命令内完成修改并提交的文件，执行后 status 看不到，不会被捕获。
- HEAD 版本不经过 smudge/filter，git-crypt、LFS 指针文件的改动会按原始内容比较。
- 超过 2 MB 的文件只归属不计入。
- worker 超时或崩溃时，当次那个文件的改动不计入；worker 无法启动时，前后合计超过 256 KB 的文件不计入。两种情况都会打日志。
- Agent 自己写在工作区里、名字像 `fix.sh`、`format.sh` 的脚本，会按项目脚本的名字判断成 B 类；写在临时目录或同一条命令里刚写出的脚本不受影响。
- 标准模式下 Agent 偶尔用 Shell 改的代码仍然不计入采纳，与改动前一致。

## 6. 重建后的时序与保护补充

基于当前分支重建，不覆盖已合入的提交逐行映射、事务 Outbox、Task trace 与工作流阶段归属。

- 重叠窗口使用单调高精度时钟，避免同一毫秒内开始/结束时漏判并发；结束窗口仍参与与它重叠的窗口的归属判断。
- 新建空文件保留文件变更通知，不产生代码行数。文件读取按句柄限量读取并复核身份/大小，避免文件增长或符号链接替换造成越界分配和错误前像。
- 并发快照内容总预算 128 MB；内容缓存仍为 64 MB，写后登记 32 MB；Shell 异步采集队列最多 64 项、32 MB。超限仅跳过采集或改为只归属，不改变工具执行结果，也不限制 Agent 并行任务数。
- 标准模式没有比对窗口时不额外编码文件内容；文件工具的写后内容采用惰性编码。
- 在工具结果返回前同步登记 Shell 生成的路径、时间与上下文，CPU 比对延后执行。上下文快照不会被任务结束或下一轮覆盖；共享 Task 后端使用发起调用的子代理线程归属。
- 同一路径的 Shell 和文件工具生成记录按接受顺序串行落库，防止异步解码颠倒覆盖关系。Shell 的 rm/mv 会等待已经接受的生成记录，再作废或迁移旧归属。
- Git hook 的待采纳检查包含尚在异步比对中的记录。提交测量最多等待 250 ms；相关生成尚未完成时保持现有持久化提交任务待重试，不以零记录完成。生成时间取自接受时刻，不取 Worker 完成时刻。
- 未识别的项目编辑脚本仍按 A 类；已识别的格式化/生成脚本按 B 类，测试/构建脚本不捕获。同一命令里写出的临时文件再 cp/mv 到目标保留 A 类。
- 保留旧提交解码口径。过短的非 UTF-8 文本仍可能被编码探测器误判，但 Shell 与提交使用同一函数，不新增另一套编码推断。

### 验证入口

- `npx vitest run src/main/agent/shell-command-profile.test.ts src/main/agent/shell-file-effects.test.ts src/main/agent/local-sandbox-shell-file-capture.test.ts src/main/agent/tool-call-read-paths.test.ts src/main/services/shell-edit-diff-client.test.ts`
- `npm run test:adoption`：真实 Git、SQLite、Outbox 到报告事件，包括异步采集先于提交、上下文清理、Shell 与文件工具交叉覆盖。
- `npm run typecheck:node`、`npm run typecheck:web`、`npm run build`、`npm run test:im-v1`。
- `npm run build && npx tsx tests/shell-file-telemetry-benchmark.ts`：临时创建 2 万文件、200 个预存脏文件的仓库；校验只计目标改动，测量前后快照；使用真实打包 Worker 对比 GBK 内容并测主线程计时延迟，完成后删除临时数据。

修复后本地测量（macOS，仅说明当前机器上的量级，不代表所有内网机器）：2 万文件、200 个脏文件，前置采集约 63–87 ms、后置采集约 40–65 ms；前后合计 2.22 MB 的 GBK 内容由打包 Worker 比对约 371 ms，主线程 5 ms 定时器的最大额外延迟约 1.68 ms。

本次验证在 macOS 上完成，Windows 路径和命令解析有单元测试，Windows 原生进程、文件系统及企业沙箱仍须在 Windows 环境验证。Unix Shell 真实执行集成测试不会在 Windows 上假装通过。

完整 Vitest 也进行了候选与隔离 HEAD 对照：候选复跑的 41 个失败断言在未修改的 HEAD 中逐项同名复现，未作为本次 Shell 修复范围处理；不将整仓库测试描述为全绿。本次 Shell 专项、采纳闭环、类型检查和构建独立验证通过。

桌面基线的旧源码断言 `desktop-agent-invoke-characterization.spec.ts` 因 `getHarnessAgentContext` 调用已改变而失败；未改动的原分支同样失败，已对照确认不是本次重建引入，暂不修复无关断言。其余六项桌面基线检查通过。

## 7. 生产链路与结构性补齐

此次漏报的直接原因是生产环境一直配置 Orchestrator（包括 YOLO），而最初捕获标记只覆盖 fallback 分支。原测试没有设置 Orchestrator，无法发现真实 App 入口根本未打开窗口。修复不仅覆盖该入口，还补齐以下独立问题：

- 写入可能性与路径解析分开：`done > 文件`、`fi > 文件`、分组外重定向、shell 包装器外重定向都保留；未知变量路径仍开启短窗口，不因无法静态解析而误判成只读。
- `2>&1`、`&>`、`&>>` 不误判为后台；引用中的 `<<EOF` 不误判为 heredoc。真正的解释器 heredoc 正文用来提取写入路径，不再作为 Shell 命令扫描。
- 管道保留内容来源：模型输出按 A 类、模板/历史/下载按 C 类、格式化输出按 B 类。package 脚本名字的 format/test/build 语义不会被递归分析的 Node 包装器覆盖。
- Git Bash 的 `/c/...`、`/cygdrive/c/...` 按当前 POSIX shell 转换；原生 PowerShell/CMD 不作 MSYS 转换。每次原始执行都使用实际 shell 类型，包含重试切换 shell 的情况。
- 同文件重叠窗口按先完成观测的窗口登记，再向后续窗口交接前像；不再按先开始的编号抢占。已确认不存在的文件使用空前像，和读取失败/内容超限分开，支持删除后重建、预先删除后恢复为 HEAD 内容。
- 64 个窗口名额在首次 await 之前预留，包含尚在获取前像的调用。正常结束、只读跳过、异常、超时都释放；超时后的异步续段不得继续修改登记。
- workflow 共用工作区的子代理及 Team worker 传递文件变更通知；隔离 worktree 的路径不送到父线程自动提交范围。Shell rm/mv 的旧采纳归属更新使用实际 `execute.cwd`。

验证增加真实闭环：脚本化模型响应 → App 实际组装的 execute 工具 → Orchestrator（YOLO/审批）→ 真实 Shell → SQLite/Outbox → Git 提交采纳，检查数字循环生成的 HTML 上报 100 行且提交采纳也是 100 行。另保留标准模式、Hook、后台、拒绝审批、部分失败、模板搬运、子代理 trace、同文件交叠和 66 路并发压力的回归测试。

日志仅包含状态/路径/数量，不打印命令正文或文件内容。`Shell file capture completed` 提供 counted/attributed/unattributed 数量；未归属时区分 long-command-unscoped、named-peer、concurrent-unscoped、stale-observation、excluded-output，另有内容超限、仓库冷却、并发名额、前后快照超时日志。以上日志不依赖 Debug 级别。

复核补充：

- 测试/构建 stdout 显式携带 excluded 来源，经过 `tee`、过滤器、包装器或重定向都不变成 A 类；同命令包含其他模型写入时，日志目标仍按 excluded-output 排除。
- 格式化器即使不带 `--write`，把 stdout 重定向到文件也按 B 类归属；管道和包装器同样保留其来源。
- 复合生产者的 stdout 汇总所有未重定向的输出，而不是只认最后一段。模板与模型内容混在同一文件时保守归 C 类，不把模板行误计为生成行。
- 同一结构分析器通过生成器请求 package 元数据，异步采集按当前有效 cwd（含静态 `cd`、npm `--prefix`、pnpm `-C/--dir`、yarn/bun `--cwd`）选择 package；同步读取路径分析不做文件系统 I/O。脚本透传 argv 保留并重新引用，不执行扩展。
- 所有 A/B/C/排除类写后登记共用 epoch 新旧检查。慢 formatter 或搬运快照不能覆盖更新的模型前像；新增三窗口交错回归验证后续只计算新追加的行。
- 递归包装器不仅保留 stdout，也接收 stdin 来源；`make test | bash -c 'sed …' > report.html` 和 package 脚本消费测试日志时仍排除。忽略 stdin 的 `printf` 或显式读取模板文件的 `cat` 不继承上游日志来源。
- 未解析的重定向目标使用独立 unknown scope，不再等同于全工作区写入：测试日志重定向到环境变量时，不会吞掉同命令中明确点名的模型文件。真正全工作区 formatter 保留其保守归属语义。
- 子 Shell 关闭时恢复 cwd 和变量环境；命令临时环境赋值不污染后续命令。变量与 cwd 分支值各保留最多 32 个候选，超限/无法解析时转为未知；`else/elif` 恢复可达的分支入口环境，不继承互斥 `then` 的变化，不执行命令来推断条件。
- B/C 窗口与模型窗口交叠时，写后读取和 dirty→clean 补读使用同一个条件。`git restore` 先恢复 HEAD、模型随后续写时，以恢复后的实际内容作前像，而不是把干净文件误记为 unavailable。
- AND/OR 条件列表保留右支关系并合并变量可能值；管道中的赋值或分组按子 Shell 环境处理，不泄漏到父 Shell。不会把 `false && target=b.ts` 静态误判为一定执行。
- 写后登记使用文件事实的观测 epoch，不使用异步结算/发布时间；旧事实不能覆盖新登记，干净前像以实际仓库观察时点比较。模型 peer 在快照期间加入时动态补读所需内容；文件工具也在写后调用入口记录时点，避免 realpath 的异步顺序颠倒写入事实。
