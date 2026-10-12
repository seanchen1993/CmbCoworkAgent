# CmbCowork Bot 实施记录

更新：2026-10-07。状态：**实现中，尚未达到完整核心功能交付或生产发布条件**。

当前验收摘要与仓库内证据：[当前交付状态](16-current-delivery.md)。

## 当前工作（2026-10-07）

### 本次继续的实现与验收

- 最新修复已合入生产会话 store：会话尚在 opening、不能读取 transcript 时，不提前确认线程元数据 cursor，保留同 cursor 后续刷新读取摘要的机会。旧生产 store 的一项实际回归严格失败，新增 canonical 回归已并入原测试；未添加轮询、计时器或并发。该缺陷已复现，但没有证明它是此前 Workspace 第 4318 行超时的根因。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/root-integration.json`、`/tmp/cmb-root-opening-metadata-race-reproduction-v1/actual-baseline/root-verification.json`。
- 当前编译输出身份为 `outputRevisionSHA256=0ce3e79902f8ee8bedfaead445890c67cc96fb08a40e12252ec30743d7b05dcc`，界面产物 `BotWorkspace-D-23g-nQ.js`。原三文件 78 项近测、完整 Node/Web 类型均退出 0；首轮整体退出 1 是短 guard 的格式警告，原失败保留。仅合并短 if 行且逐字节证明可还原后，严格 lint、格式和生产构建均退出 0，3360 份输入无漂移。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/root-quality-build-verification.json`、`source-format-correction.json`、`current-output-manifest.json`。
- `NativeBuildId=aa183a16dd2d22fe8ad060e4` 标识原生后端，不能作为整个界面的构建身份。Root 已将当前 Main/预加载 182 份文件与原实际 Host9 的固定输入逐一核对，全部字节相同；原九项实际恢复验收适用于这一未变后端，包含 SIGKILL 增量恢复和已提交工具不重放；同一文件另 55 项未选择，不据此登记新 UI 通过。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/unchanged-backend-evidence.json`。
- 之前界面已修复关闭 Mac 任意命令后后台任务卡元数据读取/停止请求误报不可用的问题，以 `shell-job-controls-v1` 区分控制历史任务与执行新命令；停止仍只是取消请求，旧弱收据与恢复护栏保留。该版原五文件 92 项近测、32 条恢复/任务卡浏览器旅程通过；新增测试的 UUID nonce 接线修正及首轮失败继续保留。证据 `/tmp/cmb-root-shell-job-controls-integration-v1/root-integration.json`、`actual-original-nearest2/root-verification.json`。
- 之前界面 `BotWorkspace-AGN-7FR0.js` 的原完整浏览器 49 阶段已实际退出 0，849.1749 秒，27 文件/166 项、47 个直接入口及最后独立新聊天均顺序完成，3834 份输入无漂移，原断言和时限保持。该版独立 Node 服务六项、Mac builder 与整包 Desktop26（原非命令 23 项＋批准范围 3 项）也实际通过；这批真实结果只证明旧 UI 与其对应包。最初第 48 阶段 4318 行超时的失败现场继续保留，根因未确认；后续只读诊断单独 Workspace47 和整链通过不取消该失败记录。证据 `/tmp/cmb-root-shell-job-controls-integration-v1/current-complete-browser-after-workspace-diagnostics/root-verification.json`、`current-independent-node-service/root-verification.json`、`current-package/actual-desktop/root-verification.json`。
- 当前输出 `0ce3` 的原独立 Node 服务六项已实际退出 0，10.2934 秒，3834 份输入无漂移，原断言和时限保持；这是 macOS arm64 / Node 22.23.3 的服务证据。新 Mac builder 实际退出 0，59.0423 秒，4313 份输入无漂移；475 份实体产物、426 份 ASAR 编译代码和 180 份展开 Main 成员已核验，深度严格签名退出 0，Electron 39.8.10 相符，包内为新 UI `BotWorkspace-D-23g-nQ.js`。包为临时签名、未公证。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/current-independent-node-service/root-verification.json`、`current-package/root-verification.json`。
- 新包原 Desktop26 已实际退出 0，原非命令 23 项＋批准 Mac 范围 3 项合计 26 项通过，73.1502 秒，4017 份输入无漂移，21 份新输出 SHA 已由 Root 核验，原断言和时限保持。Root 已查看新版实际包的分支消息截图，没有新增可证视觉缺陷；单张截图不证明全部 Grok UI 一致。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/current-package/actual-desktop/root-verification.json`、`root-finite-visual-observation.json`。
- 新版 `BotWorkspace-D-23g-nQ.js` 原完整浏览器 49 阶段已实际退出 1，789.2911 秒，3834 份输入无漂移：首组 27 文件/166 项全部通过，前 47 阶段顺序完成，第 48 阶段 `tests/bot-workspace-browser.spec.ts:5774` 的 `routineClickCalls.length` 实际 31、预期 30；最后独立新聊天未启动。原断言和时限保持，五份新失败产物与摘要保留，根因尚未证明，后续单独复验和测试前置条件调整不能把这次失败记为通过。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/current-complete-browser/root-verification.json`、`workspace-failure-artifacts`。
- 随后原单独 Workspace 加入只读例程读取来源诊断后实际退出 0，189.1952 秒，3834 份输入无漂移，原断言和时限保持；诊断捕获钩子未触发，因此没有证明此前实际第 31 次读取的来源，也不替代 full49。源码范围确认全局计数也包含仍可见详情面板的合法摘要读取；Root 只为原测试补上关闭 Inspector 并等待隐藏的边界前置条件，生产源码与编译输出保持。660 个原断言及 33 个原计时表达式的规范化 token 相同，1268 个原浏览器动作及顺序保留，只新增关闭原详情面板、等待隐藏两个动作；严格 lint/格式退出 0，原失败记录保留。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/workspace-routine-boundary-diagnostics/actual-original-workspace/root-verification.json`、`root-owner-isolation-integration.json`。
- 同一新版 D-23/输出 `0ce3` 的新一轮原完整浏览器49已实际退出 0，826.7826 秒，3834 份输入无漂移，27 文件/166 项、47 个直接入口及最后独立新聊天全部按原顺序完成。原断言和时限保持，原 660 个断言及关闭原详情面板/等待隐藏两个测试前置动作的证明沿用上条；生产源码和编译输出未变。此前 4318 超时与实际第 31 次读取的来源仍未证明，所有原失败继续保留，当前整链通过不取消这些失败记录。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/current-complete-browser-after-routine-owner-isolation/root-verification.json`。
- 当前原完整 npm/九段串联已实际退出 0，822.2705 秒，3834 份输入无漂移：首组 892 文件/7546 项通过，36 文件/270 项按原条件跳过，0 项失败；后续 adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1 九个原阶段全部按原顺序完成。原命令、断言和时限保持；此结果与当前独立完整浏览器链分别核验。证据 `/tmp/cmb-root-thread-metadata-opening-integration-v1/current-full-npm-test/root-verification.json`。旧 AGN 界面的整链通过和 dec6 的 7544 项完整 npm/九段串联均不继承为新版 D-23 界面验收。Windows CPU-04/CPU-17 通用组合键、真实 IME 和 Raw Input 仍是实现缺口，范围答复及实机安装/原生验收待完成；Mac 已批准的纯原生范围与 Linux/K8s 后续计划保持，真实用户模型与全部 Grok 功能/UI 对齐仍未验收，不重算完成率。

#### 之前构建 dec6 与此前验收记录

- 之前构建 `dec6e66dd2abc61799256b9f` 的原独立纯 Node 服务验收已实际退出 0，耗时 9.75 秒，macOS arm64 / Node 22.23.3 原六项检查通过：无 Electron 的独立构建与锁定依赖新安装、Mods 编译器与 QuickJS 实际加载、断开客户端后 Host 保留及 SIGKILL 重启后保留精确收据、损坏 Worker 与超大 manifest 在数据副作用前拒绝、已有服务目录不被覆盖。登记 3358 份输入，无漂移；仅排除该命令不消费且正在并行诊断的 `workflow-child-runtime.test.ts`，全部生产源码、原服务命令、构建脚本、资源和锁输入保持固定，原断言和时限不变。该结果不证明外部模型、Windows/Linux 原生沙箱或 K8s 已通过。证据 `/tmp/cmb-root-disabled-private-dependency-history-integration-v1/current-independent-node-service/result.json`、`gate.log`。
- 此前 dec6 的原完整浏览器串联首轮实际退出 1，3359 份输入无漂移：首组 27 文件/166 项中，26 文件/165 项通过，`workflow-child-runtime.test.ts` 的 trusted browser child 原背景执行图用例失败；首个审批轮询在原 5 秒期限内未出现，最终观测为 `undefined`。后续 47 条直接旅程及新聊天旅程未启动；原失败日志和时限保留，目前仅定向诊断，尚未确认根因，不登记整链通过。证据 `/tmp/cmb-root-disabled-private-dependency-history-integration-v1/current-complete-browser/result.json`、`gate.log`。

- 之前 dec6 的原完整 `npm test` 已实际退出 0：首组 892 文件、7544 项通过，36 文件、270 项跳过；原 adoption、消息、Hooks、插件、任务卡、合并、Workflow、桌面基线和 IM 九段串联全部完成，3359 份输入无漂移，原命令和时限保持。之前一轮 13 个失败现场保留；仅修正夹具对实际命令端口的接线并恢复原生示例文件本地读取，原 13 项及相邻 17 项共 30 项在原断言、原时限下退出 0，未为此修改生产源码。完整原浏览器串联首轮退出 1，后续旅程未启动；当前独立纯 Node 服务原六项检查退出 0，详见本节最新记录，npm 通过不能代替完整浏览器验收。证据 `/tmp/cmb-root-disabled-private-dependency-history-integration-v1/current-full-npm-test-after-fixture-repair/root-verification.json`、`/tmp/cmb-root-full-regression-fixture-repair-v1/nearest/root-verification.json`。
- Windows C# 原生 Worker 的私有交叉编译诊断退出 0：锁定依赖恢复与 Release/win-x64 编译均成功，0 警告、0 错误，23 份源码无漂移，Root 已核对 5 份私有产物；SDK 为 10.0.401。此轮未 publish、未生成正式原生发行包、未运行 Windows 程序，不能替代 Windows 内核、安装或 GUI 实机验收，也未补齐通用组合键/IME/Raw Input；Windows 输入范围是否缩减仍待用户答复。证据 `/tmp/cmb-windows-cross-compile-v1/root-verification.json`。

- 当前交付边界：用户已明确移出 Mac 任意命令与独立通用原生桌面，专用浏览器、文件、浏览器示范和接管保留；旧弱收据继续保护，范围调整不等于原功能实现。Windows 通用组合键、真实 IME/Raw Input 仍是代码缺口，是否缩减首版范围待用户答复；Windows 实机、真实用户模型及固定 Grok 成果对照尚未通过。Linux/K8s 集群交付仍按既定范围延期，独立 Host 与公共内核扩展边界保留。当前包为临时签名、未公证；没有逐 ID 当前完整验收矩阵，不补造完成率。

- 之前构建 `dec6e66dd2abc61799256b9f`：修复停用私有技能的只读声明/历史被执行权限错误拦截；只允许同 Bot、未删除的当前版本读取，停用历史不会标为当前有效，提交与执行仍使用原严格校验。当前三套 24 项全部通过，完整 Node/Web 类型、39 文件严格 lint、39 文件格式及另一个原遗漏夹具的格式检查、构建均退出 0，3355 份输入无漂移。当前正式编译 Host 原九项门禁退出 0（另外 55 项未选择），包括真实 SIGKILL 后增量检查点续跑；新版 Mac builder 退出 0、474 个输出实体复制、426 个包内文件和 180 个展开 Main 成员核验通过，签名及 Electron 39.8.10 核验通过。当前实际整包 26 项已退出 0（原非命令 23 项＋纯原生范围 3 项），21 份新产物摘要相符，重启后同一草稿 owner 与 Tiptap 文档保持；完整 npm test 与当前独立纯 Node 服务已按文首记录退出 0；完整浏览器首轮退出 1，正在定向诊断，尚未登记整链通过。证据 `/tmp/cmb-root-disabled-private-dependency-history-integration-v1/`。
- 原 Mac 五项强制终止与逃逸保护已实际退出 0，原断言和时限保持，另外 59 项未选择。正式 Mac 不恢复任意命令入口；故障测试在私有编译 Host 显式使用旧测试工厂，复制的 Main 运行依赖由有摘要的私有 CommonJS 包边界只读提供。第一次五项失败是测试包漏读兄弟依赖，失败现场与日志保留。第二次强制 SIGKILL、未知效果不重放、弱收据保留和恢复拒绝均通过，3355 份输入无漂移；不声称任意 Shell 的物理强关闭。证据 `/tmp/cmb-root-mac-final-test-fixtures-integration-v1/actual-owned-lifetime-attempt2/root-verification.json`。
- 前版整包两次失败已保留。重启草稿场景通过真实持久 owner 与同 ID Tiptap 文档就绪同步后，实际证明同数据代次、同 Bot 和未发送草稿保持；随后暴露上述停用技能历史读取缺陷，已修复并换新构建复验，未删除原断言或扩大原超时。证据 `/tmp/cmb-root-mac-native-scope-integration-v1/current-package/actual-desktop-attempt2/browser-output/desktop-composer-restart-draft.json`。

- Windows 输入源码范围已核对：当前已编码 15 个基础单键＋F1–F12，共 27 个无修饰键，以及目标窗口的字面 Unicode `WM_CHAR`；UIA 提供经核对的控件赋值、完整 TextPattern 全选和公开控件调用。通用 Ctrl/Shift/Alt/Win 组合键、目标侧真实 IME 组合态与 Raw Input 尚未实现，CPU-04/CPU-17 的该部分是实现缺口，不能写成只待实机测试。窗口消息与语义控件路径不能保证任意应用输入，`keyboardInput:false` 保持；不以抢系统键盘或前台的回退补齐。用户此次只调整 Mac 范围，Windows 核心目标没有缩减授权。本条为源码事实记录，未运行 Windows，也未重算完成比例。证据：[输入范围报告](evidence/2026-10-07-windows-input-scope/REPORT.md)、[18 份源码摘要](evidence/2026-10-07-windows-input-scope/source-contracts.json)。

- 当前正式构建身份 `c7f11243b931c5da6a1e994e`：完整 Node/Web 类型、29 文件批次的严格 lint/格式及构建退出 0。原编译 Host 九项门禁退出 0（原另 55 项未选择），包括增量检查点实际 SIGKILL 后续跑、不重复已提交工具。新版 Mac builder 在同锁物理依赖目录实际退出 0；474 个输出文件以实体复制暂存，包内 426 个 Main/预加载/界面文件和 180 个实际展开 Main 成员逐项相符，签名与 Electron Framework 39.8.10 核验通过；实际包内未发现私有故障测试 Host 或测试命令工厂入口。包为临时签名、未公证，`nativeDistribution:null`；新的桌面验收和原五项 Mac 故障保护正在执行，不冒称 Windows/Linux 实机通过。证据 `/tmp/cmb-root-mac-native-scope-integration-v1/current-short-gates/`、`current-compiled-host/`、`current-package/`。

- 上述例程详情焦点修复后，当前原完整 Workspace 旅程已实际退出 0，3354 份输入无漂移，原时限保持。真实 Host/SQLite 检查覆盖保存结果投影、右侧详情、结构化冲突、原保存回执延迟、精确目标删除与 Esc 返回；打开/隐藏/退出详情前后三份电脑租约逐字段相同，实际面板与电脑 DOM 节点保留，只读详情仅轮询例程，打开编辑器时目录只读一次。Root 已查看本轮 1440px 深色/浅色及 390px 浅色三张稳定截图，原九段消息链也退出 0。原失败两轮完整保留；当前完整标准浏览器串联、新编译 Host 及新版整包验收继续执行。证据 `/tmp/cmb-root-routine-panel-integration-v1/workspace-owning-attempt3/root-verification.json`、`/tmp/cmb-root-mac-native-scope-integration-v1/messages-verification.json`。

- 修复工作应用普通文字在面板被覆盖时丢失的缺陷：仅移除该场景的普通草稿清空，密码、UIA 输入、目标身份、控制代次和在途操作仍按原规则退休。实际生产 React＋受控 Windows 通道的原七条及新增三条旅程共十条通过，页面错误和源码漂移均为零；覆盖时实际 requestSubmit 不发送，切换窗口/控制者后旧文字清空，取消或覆盖后密码不提交。新增测试沿真实“退出电脑全屏→详情→电脑→展开”路径运行，未把全屏中不存在的标签当产品缺陷。Root 已查看本轮录制截图。这不证明 Windows 内核或实机输入已通过。证据 `/tmp/cmb-root-native-message-draft-integration-v1/actual-browser-attempt2/root-verification.json`。

- 用户已明确 Mac 纯原生并调整电脑范围：不引入虚拟机，保留工作浏览器、文件、浏览器示范和接管，不开放任意系统命令及独立通用原生桌面。十三份生产源码和五份测试资产已按摘要合入；正式 Mac Host 在工厂准备之前拒绝命令，模型不注册命令工具，RPC 不声明命令相关能力，手动任务/服务/Hook/依赖入口同样检查实际可用性，历史与原项目绑定保留。Root 当前三套 29 项全部通过、完整 Node/Web 类型检查退出 0。原 Mac 编译命令工厂仅供显式测试使用，正式 Host 静态依赖图不能触达；旧弱收据及恢复/维护保护保持。实际新版桌面与完整回归尚在执行，不把范围调整视为原 177 项全通过。证据 `/tmp/cmb-root-mac-native-scope-integration-v1/`。
- 已按 Grok 实屏合入同一 Inspector 的例程详情，复用原 Resources owner；编辑、审批、历史和删除仍沿用原实现，保留原电脑节点与控制权。当前实际 Inspector 原八条旅程通过；完整 Workspace 两轮退出 1：第一轮发现两条旧状态定位仍假设状态位于按钮内部，已仅修正定位；第二轮确认任务删除后原焦点随卡片卸载而落到 body，Esc 无法返回，正在修复真实产品缺陷。失败日志、截图、源码登记及原时限均保留于 `/tmp/cmb-root-routine-panel-integration-v1/`，不记完整工作区通过。

- 本轮构建 `f5aaafc05e68acc0772a5524` 的原编译 Host 门禁已实际退出 0，九项全部通过，原另外 55 项未选择；3352 份登记输入无漂移。真实 SIGKILL 场景在重启前断言增量消息 head 的 parent 非空，恢复后记忆仅一条、最终答复仅一条、受控模型请求三次，已提交工具结果被保留。只读核对保留数据库：五份消息快照中四份为增量、四个增量 head；不读取或输出模型密钥。证据 `/tmp/cmb-current-routine-outcome-host-v1/`。这不证明 Mac 任意 Shell 强关闭、Windows 或 Linux 实机通过。
- 例行任务保存结果入口已接入：实际 create/update 工具保存与确认消息、紧凑身份记录共用原 toolOnce 事务；重放复用原收据，不重复保存或生成卡片。读取复用原事件索引并限制当前消息页，点击复用原只读详情意图，校验当前会话、分支、Bot 和数据代次，不触发执行。当前生产五套件 54 项、完整 Node/Web 类型、原九段消息链、13 文件严格 lint/格式及构建通过。实际完整 Workspace 追加验收已运行，原场景执行后在新详情的零 Form DOM 断言退出 1：原资源页保留了隐藏创建表单。失败、截图和无漂移输入保留于 `/tmp/cmb-root-routine-outcome-workspace-owning-v1/`，不计整体通过；正按 Grok 实屏改为同一 Inspector 的精确右侧详情，复用原资源 owner 并排除无用创建表单。证据 `/tmp/cmb-root-routine-save-outcome-v1/root-nearest-verification.json`。暂停计划展示 11 项近测及实际 Inspector 八条旅程通过，Root 已查看稳定后的深色、浅色及 390px 三张截图；瞬间白底来自主题过渡捕获，稳定样式对比度最低 7.22，没有据此认定持续主题故障。证据 `/tmp/cmb-root-routine-inspector-view-v1/root-final-verification.json`。
- 上述构建的新 Mac 测试包已实际核对 180 个展开 Main 成员和共 426 个 Main/预加载/界面成员；签名校验退出 0，Electron Framework `CFBundleVersion=39.8.10`、产品 `1.5.3`。打包进程的退出状态因中断未记录，保留实际成员检查及签名证据，不补造 builder 退出 0。包为临时签名、未公证，新的桌面 26 项尚未运行。上轮 `npm test` 在主组执行中中断，没有完整退出结果；原日志保留，不记为全量通过。证据 `/tmp/cmb-root-routine-save-outcome-v1/package-verification.json`、`package-signature-runtime-info.json`、`full-test.log`。
- 本轮按用户要求重新盘点固定 177 项核心范围，已有逐 ID 实现入口映射，但历史批次没有统一的“当前构建＋全部核心子条件”验收记录，不能据此计算逐项完成率。当前明确未完成的四个领域影响五个唯一 ID，其余 172 项的完整当前验收尚未逐条核实；没有把这些条目默认记为完成或失败。给用户的约 75% 是工程粗估，不能作为验收通过比例。有限账本 `/tmp/cmb-core-progress-ledger-v1/ledger.json` 保留原实现和历史执行证据，完成百分比字段保持 null；不据新粗估反向填造完成数。
- 本轮再次查看官方 Grok 0.68.1 例行任务的聊天结果入口、详情、编辑预填和返回操作，并核对当前客户端 automation-detail chunk；编辑只预填、聚焦，不发送或恢复。CMB 原“对话调整”和结构化编辑保留。已确认并合入暂停计划显示的窄修正：复用原 lossless 日历转换显示实际计划和时区，非事件任务无 nextAt 时不再标成等待事件；当前正在验收。Grok 成功保存后的可点击聊天结果投影是新确认的缺口，正在接入原成功事务与现有详情意图，尚未记为完成。
- 恢复校验增加有界失败 cause，全部五个原判断和读取方式保持；真实文件删除/恢复五条原浏览器旅程、五文件 47 条既有备份近测及九条实际 SQLite 变更检查通过，完整 Node 类型、严格 lint/格式通过。测试私有数据库改用 canonical 本机临时目录，证据仍在原 output；这不证明上次失败由同步目录引起，也不把 metadata 漂移视为成功。cause 可在直接 owning 错误中诊断，公开 RPC/worker 序列化形状保持。证据 `/tmp/cmb-root-backup-integrity-v1/root-verification.json`。
- 已按原顺序单独执行后续 48 条 direct 命令诊断：46 条通过，第 47 条 Workspace 因旧警告文案定位停止，第 48 条未启动。实际截图中敏感录制正确暂停；仅同步一条测试文字，原时限、暂停和零帧检查保持，完整 Workspace 随后退出 0并完成原夹具清理。此为分段诊断，未冒称整套标准浏览器通过；当前原新包 `5984c509` 早于恢复诊断及计划显示源码，不再标成当前源码验收包。证据 `/tmp/cmb-root-workspace-teach-warning-v1/workspace-root-verification.json`。
- 已对照官方 Grok Bot 0.68.1 的收件人搜索、同页群选与草稿转交源码，合入新建聊天的临时富文本、附件、按名称创建 Bot 和群聊交接；复用原 Tiptap、快速创建、群保存、草稿 parser 与唯一上传路径。没有确定收件人时不上传、不启动任务；原请求重试保留原 nonce，新页面的正文和附件不会被旧回执带走。实际 Chrome 已验证私聊两附件部分失败重试、新群聊正文/附件转交及明确发送；原期限保持，首发群聊 receipt 只有一个初始 Run，后续成员轮转仍按原群执行器进行。实测另修正群选返回后的焦点/观察器生命周期、同值草稿字段顺序误判，以及 Tiptap 可编辑状态切换误发内容更新导致附件票据失效。Root 五文件 84 项近测、完整 Web 类型、原九段消息串联及严格局部 lint/格式通过；新增群选页深色和窄窗浅色截图已由 Root 查看，原 scoped 新聊天完整旅程再次退出 0；当前整套浏览器验收链仍因后述恢复校验失败未通过。证据 `/tmp/cmb-root-new-chat-local-composer-v1/root-verification.json`；此前群选及入口证据 `/tmp/cmb-root-new-chat-entry-v2/root-verification.json`、`/tmp/cmb-root-new-chat-group-selection-v1/root-verification.json`。
- 已按 Grok 实屏和对应客户端代码补齐录制准备说明、红色录制按钮与取消图标，共两份产品源码；原录制请求、未知回执、历史和停录逻辑保持。当前完整 Web 类型、局部严格 lint/格式、原 Teach 菜单三条实际浏览器旅程通过。本轮另已修正取消准备：只退休本次录制准备，保留同一电脑全屏及控制权；实际验收发现退出全屏后未回输入框，已增加原触发元素退休时的同会话/数据代次焦点回退。原三条 Teach 浏览器旅程、完整 Web 类型及严格局部 lint/格式通过；窄窗准备态及新版打包应用仍待验收。证据 `/tmp/cmb-root-teach-cancel-preparation-v1/root-verification.json`。
- 已在 Main 人工维护路径补充负向 Shell 资源检查：核实认证 Host 身份后，已知弱关闭现场会在发送重启请求前被拒绝，以保留原活 Host；不清收据或放宽原离线维护护栏。当前完整 Node 类型、严格局部 lint/格式及四文件 46 项近测通过。已合入直接 RPC 持锁资源预检及 Main 自动升级保护：只有原空闲检查通过后才暂停调度与新 RPC；资源否决可恢复原活 Host，停止/失主/关闭后的晚到读取不能解封。合入后五文件 106 项近测、完整 Node/Web 类型及严格局部 lint/格式通过。已完成新 Mac 测试包 `7b1070f1e043ccd8484c867e`，180 个实际展开 Main 成员保持；第一次实际 26 项业务检查通过，但旧夹具 finally 因新保护正确拒绝重启而清理失败；失败记录保留。已限定修改一份测试，捕获原 Main 实际启动的 ChildProcess 并在 finally SIGTERM、按原 30 秒期限等待退出；同一包完整桌面旅程退出 0，26 项业务检查及真实子进程正常退出通过，额外安全重启后同会话/历史/未发送草稿保持、无额外模型调用。目录和一份弱收据仍保留；这不证明 Mac 任意 Shell 强关闭，且该包早于正在实现的新聊天父接线。证据 `/tmp/cmb-root-packaged-owned-host-cleanup-v1/root-verification.json`。证据 `/tmp/cmb-root-rpc-owned-resource-restart-v1/root-verification.json`、`/tmp/cmb-root-packaged-preflight-acceptance-v2/`。
- 前一批维护 IPC 已复用原错误序列化及传输适配，界面可显示原领域拒绝原因；两文件 120 项、完整 Node/Web 类型和实际维护界面旅程通过。Windows CI 已登记独立真实控件选择入口，WGC 检查增加实际像素断言；Windows 运行尚未执行。这批十四路径的登记和验收在 `/tmp/cmb-root-acceptance-and-maintenance-integration-v1/`。
- 已恢复原相对 files/unpack 规则，以同锁清单物理依赖和已核验原 Electron 运行时完成新 Mac 测试包：构建 `c53849d7625bd646978ca80b`，`/private/tmp/cmb-current-maintenance-pack-ywkvmvx3/mac-arm64/CMBDevClaw.app`。原完整桌面旅程 25 项通过，独立复核 180 个实际展开的 Main 成员及原运行时身份保持。包为临时签名、未公证，`nativeDistribution:null`；它早于本节录制准备及 Main 预检修改。最后一次 Shell 虽业务成功，仍正确保留 `closure-unproven` 收据；调整测试执行顺序没有解决 Mac 强关闭或后续启动问题。证据 `packaged-desktop-result.json`、`/tmp/cmb-current-maintenance-package-independent-review-v1/REPORT.md`。
- 当前标准浏览器整链正在复验。第二次原整链首组 27 文件 / 166 项全部通过，无跳过；40 项子任务 Runtime 全部通过。已限定更新三份旧入口测试，并为两份 embedded Host 夹具复用正式 bootstrap 的原目录/实际持锁资源核验，没有放宽产品护栏。随后四条直接旅程通过，示范菜单旅程发现按 Escape 时焦点落在 body 的问题，整链退出 1；原失败保留。现已在原录制控制器恢复自身请求引起的焦点丢失，并通过原 Radix 关闭钩子返回同一控制器的示范记录按钮；面板退役、隐藏或其他弹窗持焦点时不接管。真实已接受原 nonce 回执暂缓返回期间，打开记录、保留同一内部焦点、关闭并继续原三条旅程的复验全部通过。第三次首组为 26 文件 / 165 项通过、1 项恢复失败，因 bots.sqlite 校验被拒而退出 1，后续 48 条直接旅程未启动。正在核对读取期间的文件身份/元数据变动，仍保留哈希和持锁护栏；未登记整链通过。证据 `/tmp/cmb-root-new-chat-local-composer-v1/standard-browser-attempt2-result.json`、`standard-browser-attempt2-first-stage.json`、`teach-active-ref-verification.json`；各轮失败日志和截图保持。
- Windows 原生消息输入已增加无修饰键的 F1–F12，复用原目标/审批/共享键映射；原按下已接受后，即使取消或抛错，也只向原来的同一个子窗口投递匹配的释放，不重放按下。两文件 22 项近测、当前完整 Node/Web 类型及严格局部 lint/格式通过；二十三份原生输入按原锁文件和严格分析器完成 Windows-target 自包含发布，零警告/错误，源码前后保持。此项不等于通用组合键、IME、RawInput 或 Windows 实机验收，也不是完整 NativeAOT 发行包。证据 `/tmp/cmb-root-native-function-keys-v1/`、`/tmp/cmb-native-function-keys-net10-publish-actual-v1/audit-result.json`。
- 本轮新 Mac 测试包 `5984c5090ef8d9c398a546fc` 已完成：包内 180 个实际展开 Main 成员及 Main/预加载/界面共 426 份文件与当前构建逐项一致；原 Electron Framework 为 39.8.10，产品版本 1.5.3。实际完整桌面旅程退出 0，26 项检查通过，包括独立后台完成任务、桌面重开、空闲安全重启、资料、浏览器接管和原弱 Shell 拒绝重启；受控模型请求 4 次、记忆请求 1 次，实际子进程清理完成。21 份新产物已按本轮启动时间保存，未计入旧截图。包为临时签名、未公证、`nativeDistribution:null`；没有据此声称 Mac 强关闭或 Windows/Linux 运行已完成。证据 `/tmp/cmb-root-new-chat-local-composer-v1/final-packaged-desktop-verification.json`。
- 上述打包批次登记 3315 份输入，3313 份当时可读输入摘要未漂移；两份原 iCloud dataless 测试夹具未读，不声称全部 3315 份已核验。Mac 任意 Shell 强关闭、独立任意原生桌面和 Windows 通用组合键仍有缺口；Windows 实机、Linux/K8s 及真实外部模型验收未完成。

### 此前批次记录

- 已补齐本地详情、资料库和群成员页的输入框快捷键：原电脑面板 CSS 名也用于这些页面，现仅在实际电脑标签页及原模态/编辑区域阻止工作区快捷键。沿用 Grok 0.68.1 `sand.focusInput` 的入口和本应用原焦点方法，不增设全局监听。Root 实际 Workspace 单条完整旅程及五项单元检查通过，草稿、设置弹窗焦点和电脑控制权保持；三项 Inspector 行为的独立有限源码复核未发现新增阻断。证据 `/tmp/cmb-root-local-inspector-shortcut-v1/root-verification.json`、`/tmp/cmb-grok0681-focus-sequence-readonly-v1/REPORT.md`。
- Windows 控件已接入有界非敏感文本全选：仅支持可验证的 UIA 文本范围，绑定原控件、文本摘要和审批，操作后截图失败不会重复选择。同步修正 .NET 10 生成 COM 对象原来的不确定释放，按锁定生成器的独立引用完成释放，并在编译时检查九处生成调用；WGC 初始化异常也完成自身清理。Root 十九项近测、当前 Node/Web 类型及严格局部 lint/格式通过；二十三份原生输入 locked 发布为零警告/错误，独立源码核验和同助手的本地 IUnknown 引用计数检查通过。此项不等于通用 Ctrl+A、组合键、IME 或 Windows 实机验收。证据 `/tmp/cmb-root-native-text-selection-v2/root-verification.json`、`/tmp/cmb-native-com-ownership-independent-source-review-v2/REPORT.md`。
- 上述新批次及原测试夹具修正已固定 3309 份输入，当前完整 Node/Web 类型、二十六文件严格 lint 和二十九文件格式检查通过；原完整 `npm test` 退出 0，主组 885 文件 / 7421 项通过、35 文件 / 269 项按原条件跳过，后续九个串联组全部执行通过，登记输入摘要无漂移。新 Electron 构建完成，身份 `e56ab1af2f1ef2fd01f5b473`；实际 Host 原门禁 9/9 通过，包括增量检查点 SIGKILL 续跑且不重复已提交工具。180 个 Main 编译成员及共 430 个登记输出摘要保持，原另外 55 个 Host 场景未选择。标准浏览器首段曾有两条旧电脑面板名称定位失败，仅修正测试名称后原十条近测通过，原完整链尚待复跑；整窗视觉及三平台实机仍未完成；本机开发构建的 `nativeDistribution` 为 null，不是 Windows 发行包。原生发布的静态运行时布局经独立核验没有确认遗漏 DLL，未因此修改打包策略。证据 `/tmp/cmb-root-core-batch-final-gates-v1/`、`/tmp/cmb-native-readonly-runtime-independent-review-v1/REPORT.md`。
- 已合入独立 Windows 文本选择实机验收入口、WinForms 真实 GUI 状态夹具及依赖锁，共五个新文件；原五项 Windows 内核验收未改。候选原 Node 全图和严格 Windows 目标发布、locked restore 通过，合入后原完整 Node 类型、严格局部 lint、格式与 runner 语法检查通过；实际 Windows、UIA/WGC 和 COM 生命周期仍未执行，十二轮观察检查也不测精确 Release 次数。上述完整 npm 整链早于新增 Windows 验收文件，不借用其通过数量。证据 `/tmp/cmb-root-windows-selection-acceptance-v2/`、`/tmp/cmb-native-text-selection-windows-independent-review-v2/REPORT.md`。
- 新 Mac 测试包的首次打包被损坏 Electron 缓存及顶层依赖软链接布局阻断；现用同锁定清单的物理依赖目录和已核验的原 Electron 运行时。第一份完成打包的试验包在实际 Host 启动时被物理入口校验拒绝：临时绝对 FileSet 没有正确展开 Main；已保留失败日志，正在恢复原相对 files/unpack 规则重新打包，不放宽运行时检查。完整桌面夹具另三处过时入口名称已仅修测试。证据 `/tmp/cmb-root-core-batch-final-gates-v1/`、`/tmp/cmb-root-desktop-search-fixture-v1/applied-manifest.json`。
- 已重新核对当前官方 Grok Bot 0.68.1 电脑面板的关闭及输入框焦点行为，并参考冻结 0.66 共享详情面板的焦点逻辑。CMBDevClaw 私聊和群聊显式关闭详情/电脑面板后，沿原入口返回聊天输入框。两条同规格实际 Workspace 夹具保留原 10 秒期限，修正前焦点检查失败、合入后通过；原草稿可继续键入，设置弹窗保持自己的焦点，电脑控制权及远程输入保持。完整 Web 类型、局部严格 lint 和格式通过；尚未计为完整 Workspace 旅程通过。证据 `/tmp/cmb-root-inspector-close-focus-v1/root-verification.json`、`/tmp/cmb-root-group-inspector-close-focus-v1/root-verification.json`。
- 已合入浏览器组合键失败恢复：正常输入仍委托一次原按键调用；失败后释放原请求可能按下的键，输入或释放超时则关闭捕获的原浏览器，停止新输入并等待原调用及清理，不重放未知效果。Root 43 项近测、实际 Chrome 三场景、完整 Node 类型、严格局部 lint 和格式通过，六份合入源码摘要无漂移。原按键/接管/关闭合同及原测试期限保留。浏览器关闭可能丢失其他 Bot 的当前页面，最终系统清理没有绝对完成时限。证据 `/tmp/cmb-root-browser-keyboard-recovery-v2/root-verification.json`。
- 已接入 Windows 工作应用模型截图、精确窗口消息输入与操作后重新观察。审批与执行收据沿用原任务图；画面失败不会重新点击或输入。当前源码的 18 项专项、6 项前端坐标/按键检查及完整 Node/Web 类型检查通过。
- 已接入工作应用 Teach 采集适配、前端来源选择、录制期间模式锁定和示范控制，复用同一录制状态、视频编码、保存和学习队列；窗口消息明确记为“输入已提交”，不宣称业务效果已确认。原实际 React / 受控传输 4 条界面旅程、页面零异常、当前完整 Web 类型及局部严格 lint 通过；受控 PNG 不是 Windows 实机画面。
- 已按 Grok 的 `request_box_help`、hand-off、resume 与已核对的前端行为接入 16 个文件：浏览器/工作应用求助卡、本人接管、一次归还后自动续跑及重新截图。沿用原 Interaction、收据、队列和执行图；背景查看器覆盖暂停、保留原 DOM/草稿。当前 12 项专项通过，独立实际 Runtime / SQLite / 认证 RPC / Chrome / 本地受控 SSE 的 1 条完整图旅程通过；Root 实际 Workspace 同链界面旅程通过，确认关闭仍等待、背景不抢截图、归还只提交一次并保留原查看器。没有外部模型或 Windows 执行证明。
- 已接入原生应用专用人工安全输入，复用现有密码表单、认证 RPC 和 Teach 状态。输入绑定当前控件、客户端与控制权，单次短期票据只填入密码框；密码不进入聊天、检查点或示范录制。原控件转为普通控件仍受保护，必须核实它已从完整控件树退休才能继续。合并后实际 React 的 6 条受控传输旅程通过，包括提交前清空、转移控制权清理草稿和窄化目标传输；Windows Worker 当前 20 份输入严格编译通过，不代表 Windows 实机效果。
- 已按 Grok 的路径式操作补齐工作应用拖拽，沿用原画面票据、控制权与动作审批；整条路径只提交一次，隐藏或取消的本地手势不发送。按住时暂停更换输入画面，失败后向原控件尝试松开，不重新选择目标或重放未知效果。候选 20 项近测、Node/Web 类型及实际 React 的 3 条旅程通过；独立清理审查未发现新增阻断。最终安全输入与拖拽组合的 20 份 Windows Worker 源码已通过严格 locked 发布，0 警告/错误；通用物理鼠标、组合键和 Windows 实机仍未验证。
- 已按 Grok SendMessage 行为补齐任务中主动发消息：文字、明确选取的图片及原讨论中的引用复用原会话、工具收据与文件权限；消息提交后任务继续执行，最终交付保持原路径。直接示范学习可发送纯文字阶段进展，仍必须读取全部录像并保存技能；群聊学习工具集保持原五项。合并后 18 项普通消息与 14 项学习范围检查通过，原两条实际 Chrome / SQLite / CmbRuntime / 受控 SSE 学习旅程通过，学习阶段消息可在后续模型调用前读取且只有一个学习 run。
- 已按 Grok 0.18 重建源码补齐同 Bot、同桌面的后台 computerUse 子任务，复用现有工作流、子任务卡、消息与停止控制、审批和结果通知。主 Bot 可继续非电脑工作；原 SQL 子任务和未知操作收据持有屏幕使用权，进入与结算前等待原观察失效。子任务不分配第二台电脑，也没有 Shell、项目或管理权限。合并后的 7 项持久归属检查与 1 条实际父子 Runtime 图旅程通过；原生进程端口受控，不能视为 Windows 实机验收。26 个合并文件的完整 Node 类型及严格局部 lint 通过；独立源码复核未发现新增阻断。证据 `/tmp/cmb-root-computer-teach-integration-v2/root-verification.json`。
- 图片预览已按官方 Grok 0.66 实际媒体组件接入全屏缩放、拖动、键盘操作、多图循环切换与缩略图栏；复用原文件读取、下载、取消及资源释放，不增加全局键盘监听或文件缓存。修复缩小后画面移出视口及后台刷新中断长拖动；原 Dialog、聊天草稿和关闭后的焦点保持。V3 已按精确摘要合入；Root 在当前组合上运行原图片两条、原父视图选定两条交互，均通过，包括刷新期间长拖动、原草稿及焦点归还。完整 Web 类型及最新 Electron 构建通过；这些局部结果不代表全工作区视觉对齐。证据 `/tmp/cmb-root-media-preview-v3-integration/applied-manifest.json`、`/tmp/cmb-root-typed-user-form-integration-v1/root-verification.json`。
- 已按官方 Grok 0.66 表单组件接入普通信息收集：文本、长文本、日期、数字、邮箱、电话和下拉选择，复用原 Interaction、等待、审批范围、收据与恢复图。请求与答案有容量限制，敏感输入不走此表单；表单固定原数据代次，迟到回包不能覆盖新表单。待确认提交沿原持久恢复机制，跨窗口先展示原答案再由用户确认，不自动发送旧值。18 文件已按精确摘要合入；Root 实际 73 项近测、独立 14 项学习范围检查及 1 条实际 Workspace 表单旅程通过。完整 Node/Web 类型、49 文件严格 lint、51 文件格式及最新构建通过。证据 `/tmp/cmb-root-typed-user-form-integration-v1/applied-manifest.json`、`/tmp/cmb-root-typed-user-form-integration-v1/root-verification.json`。
- 原 `test:workflow` 本轮曾在旧消息队列夹具失败：它把不可变消息替换补丁误当成最终消息。仅修正该测试，以原 reducer 核对完整状态、旧消息不被修改及用户指令只出现一次；原 38 项通过后，本轮原完整 `test:workflow` 和 `test:messages` 均以退出码 0 结束。运行中只对该夹具整理格式并收窄新助手的类型，已核对生成 JS 的语法结构相同；未改变产品、断言或期限。旧失败日志仍保留。前一次原完整 `npm test` 主组退出 1，后续九个串联组未执行；新批次完整复验见上项。证据 `/tmp/cmb-root-message-queue-runtime-integration-v1/applied-manifest.json`、`/tmp/cmb-root-typed-user-form-integration-v1/root-verification.json`。
- 前一次原完整 `npm test` 主组为 872 文件 / 7364 项通过，11 文件 / 27 项失败，34 文件 / 266 项按原条件跳过；另有 1 个 Vitest worker 更新超时，当时整链未通过。已仅修正上下文正向夹具的当前工具预算、Mac 沙箱夹具的物理依赖路径、透明媒体按钮的静态样式误判及六处当前数据库/Host 端口/只读依赖夹具；原数据、备份、回滚、权限与期限断言保留。Root 三文件 33 项、六文件 38 项均通过，九文件严格 lint 和格式通过。Mods 原两文件先有超时和稳定文件读取失败；冻结九份原输入后保持源码与 5000 毫秒期限不变，单次复跑 15 项通过、摘要无漂移，尚未确证唯一原因；当前同规格完整整链已通过，见上项。证据 `/tmp/cmb-root-typed-user-form-integration-v1/full-test-chain-final.log`、`/tmp/cmb-root-main-failure-repairs-v1/`、`/tmp/cmb-root-main-fixture-integration-v1/`。
- 上一次验收构建的实际 Electron Host 原生门禁 9/9 通过：SIGKILL 后增量任务图恢复、不重复已提交工具、模型绑定保留、桌面连接关闭后后台继续运行、并发 Host 仲裁、代理、未知用量、下载通知与旧版全空恢复。构建身份 `adc53d4b28cc486449d329d0`，180 个实际编译成员在验收后摘要无漂移；另 55 项未选。它早于本轮浏览器按键恢复、焦点及原生文本选择修改，不作为这些修改的集成验收，也不代表 Windows/Linux 实机、真实外部模型或物理断电。证据 `/tmp/cmb-root-typed-user-form-integration-v1/native-host-final.log`、`/tmp/cmb-root-typed-user-form-integration-v1/root-verification.json`。
- Windows Worker 已完成锁定依赖的 x64 编译；这不等于 Windows 实机通过。通用桌面物理输入兼容、Windows 安装运行和 macOS 任意 Shell 强关闭仍没有完整验收，Linux K8s 实际集群部署仍属后续范围。

以下为历史批次记录；其中通过结果、百分比估计和待办应按各自源码批次理解，不代表上述当前版本整体完成。

本轮浏览器 10 文件修复已接入：沿原 Grok 派生驱动补齐模型目录中的选择、坐标点击、拖拽和标注；实际输入前复核控制权与页面归属，新建页面内部等待后再复核。坐标审批保留画面/几何摘要；清空失败停止输入，选择回包异常不再次执行，拖拽始终尝试释放并保留主异常。原执行图、审批、收据和父/子任务归属保持。Root 核对 10 文件、34 份证据及独立审查后接入，原四份测试的正文、断言和期限保留。候选最终实际页面 32 项、模型/子任务 3 项和 Node 29 项分别通过，重叠数量不相加；原版同测试有 11 项页面/4 项 Node 行为失败。证据 `/tmp/cmb-root-browser-actions-integration/production-applied-manifest.json`。

合并后的 5174 份源码、测试、配置、构建及资源输入固定，完整 Node/Web 类型、严格局部 lint、当前原生 Worker 公共恢复 2 例通过，输入无漂移。最新 Electron 构建及原 native Host 8 项＋新增旧数据启动/SIGKILL 恢复 1 项合计 **9/9 通过**；真正旧全空恢复数据经实际入口启动拒绝旧请求，强杀重启保留同一兼容代次且没有重复事件，增量图检查点续跑也保留已提交工具。场景保留，原期限不变。证据 `/tmp/cmb-root-current59-final-merged-gates/receipt.json`、`/tmp/cmb-root-current59-final-native-host/receipt.json`。其余 55 项不在该显式验收选择内；不是完整 native 场景、Windows/Linux、真实模型或物理断电证明。

当前实际合并源码的新增浏览器/模型 29 项通过；原标准链的 24 套 / 160 项及前 40 个直接入口通过，在第 41 个文件所有者入口失败，**该整链仍为失败**。失败夹具遗漏 `file-delete-epoch`，并将视图保留在模拟恢复代次，实际 SQLite 仍为 `initial`；产品按原能力与代次护栏正确禁删。单文件修正保留旧 Host 禁删负向检查，随后读取真实公开状态，经原夹具接口同步实际代次；同规格对照为 5 通过 / 1 失败 → 6 通过，19 个原断言、6 个原场景及 5000 毫秒期限保留。Root 核对全部摘要和独立审查后仅接入该测试，产品护栏未改。证据 `/tmp/cmb-root-current59-final-standard-browser/receipt.json`、`/tmp/cmb-root-files-owner-capability-integration/production-applied-manifest.json`。

随后固定同批 5174 输入继续原后四个入口，群成员、文件删除代次、本机工具许可三套通过；最后工作区入口在技能版本更新后的例程状态断言失败。原测试仍期待“已暂停”，实际 `needs_setup` 保留启用意愿并显示“需要设置”；自动事件不生成任务及实际 `enabled=false` 原断言已通过。仅更新原状态期望，并为实际 Host 夹具绑定既有独占锁和协作准入，保留原 361 个断言、38 处期限及全局任务数量断言。完整阶段旅程通过；最终启动锁兜底经正常结束 / 早期异常两例验证，完整最终集成旅程仍待门禁。Root 核对候选和独立审查后仅接入测试，产品准入与启用条件未改。证据 `/tmp/cmb-root-current59-final-browser-remaining4/receipt.json`、`/tmp/cmb-root-workspace-fixture-readiness-integration/production-applied-manifest.json`。

命令资源核对发现一处真实界面错误：`active-owner` 只表示后台持有锁，不能证明命令仍运行；原界面把关闭证据不足覆盖为“运行中的命令尚未确认关闭”。现直接展示后台已有核对结论，原现场保护、权限、维护阻断和读取生命周期均保持。相同规格实际 React / Chrome 配对在原 10 秒期限内从失败变为 6 条原旅程通过、页面错误 0；原 13 个断言全部保留。Root 核对两文件、13 份证据和独立审查后接入，完整集成门禁待执行。证据 `/tmp/cmb-root-shell-review-hint-integration/production-applied-manifest.json`。

当前所有新增修改固定后，最新完整 Web 类型、四个涉及文件的严格 lint 和 Electron 构建通过，5174 输入无漂移。完整标准浏览器 v2 第一组实际为 23 套 / 159 项通过、1 套 / 1 项失败；浏览器子任务在首个 5000 毫秒等待内未出现审批卡，尚未进入人工接管步骤，后续 45 个入口未执行。正在保留原期限定位审批前启动链，不能把局部通过合并成完整通过。证据 `/tmp/cmb-root-current59-final-ui-hint-quality/receipt.json`、`/tmp/cmb-root-current59-final-standard-browser-v2/receipt.json`。随后单次有限诊断保留原两个 5000 毫秒等待和 30000 毫秒用例期限，审批在 2142 毫秒出现、冷浏览器初始化 1354 毫秒、原流程 4496 毫秒通过；没有确证唯一失败原因，不修改产品或放大期限。相同最终源码重新运行原完整标准链 v3，24 套 / 160 项及后续 45 个界面入口全部通过（722.15 秒），5174 输入无漂移，包含最终工作区夹具完整清理和后台提示修正。v2 的真实失败仍保留。证据 `/tmp/cmb-workflow-browser-approval-current59-diagnostic/REPORT.md`、`/tmp/cmb-root-current59-final-standard-browser-v3/receipt.json`。完整主测试已结束：866 文件 / 7232 项通过，2 文件 / 6 项失败，32 文件 / 263 项按原条件跳过，1071.73 秒，5174 输入无漂移；后续九个串联组未执行，整链仍失败。五项关闭用例在编译阶段缺少新增旧数据启动依赖的受控导出；另一个 Webhook 用例在第二次 HTTP 请求前重新启用例程时，缺少现有人工确认来源。两处已仅按原合同修正测试接线，受控启动依赖保留同步调用，例程重新启用显式传入既有人工来源；原五项关闭用例及七项 Webhook 用例均通过，完整 Node 类型和两文件严格 lint 通过。产品护栏、原断言与期限均未改，整仓主组及九条串联组仍待新一轮完整复验。接入证据 `/tmp/cmb-root-main-startup-webhook-fixture-integration/production-applied-manifest.json`。证据 `/tmp/cmb-root-current59-final-full-test-chain/receipt.json`。Mac 任意 Shell 强物理关闭与 Windows 通用桌面独立并行仍未完成，已通过场景没有豁免这些边界。Windows 验收 Worker 仅有 `/tmp` v5 源码候选，经过独立静态审查补回文件 pin、时间戳精度、有符号窗口句柄表示边界及原 XSLT 构建输入；未编译、未运行、未计为产品功能完成。

旧版全空电脑恢复的启动兼容已按 6 文件摘要接入：复用原完成收据的只读校验和完整恢复事务，以新的兼容代次拒绝旧请求；保留 Bot、历史、原收据和文件，暂停待执行任务及自动触发。原有恢复标记直接返回，正常新用户保持 `initial`；当前版本的用户数据先做原 VACUUM 快照，POSIX 新数据库名和备份发布补齐目录同步。候选 14 项专项及原 8 套 / 70 项通过，Root 核对 6 文件、23 份证据、9 个真实旧现场成员及独立源码审查后接入；后续实际最新编译 Host 启动和强杀重启通过，见上段独立原生验收，整仓验证仍待执行。SQL 异常自身不计作强杀证明。证据 `/tmp/cmb-root-legacy-absent-integration/production-applied-manifest.json`、`/tmp/cmb-root-legacy-absent-prepared-receipt.json`。菜单 Esc 的失败已确认是检查早于 Radix 焦点归还约 8.6 毫秒，仅为原测试补等待真实焦点；4 条原旅程、13 个原断言和原期限保持，后续实际标准链已通过该入口。证据 `/tmp/cmb-root-menu-focus-integration/production-applied-manifest.json`。

上一批固定合并代码升级至 v59：复制范围、例程验证与启用、电脑恢复双事件/空控制数据库、历史 computer-only 事件读取及原索引迁移已接入；备份测试改用逐字节 Buffer 比较，保留原完整性和期限。当批 3202 份实际源码输入固定，完整 Node/Web 类型、95 文件严格 lint 通过；重新编译的 18 输入原生 Worker 经实际公共恢复两例验证，既有库及未来全空恢复均拒绝旧请求，输入无漂移。证据 `/tmp/cmb-root-current59-merged-gates/receipt.json`。旧 all-absent 恢复既无数据库也无事件，另以实际 Root59 认证入口复现过期请求被接受，当时待补启动兼容屏障；后续接入见上段。完整标准浏览器链运行 363.36 秒，输入无漂移；前序电脑、协作、示范和资料交互通过，在 `bot-menu-handoff-browser.spec.ts:135` 的 Esc 后即时焦点断言失败，后续核对及测试修复见上段。证据 `/tmp/cmb-root-current59-standard-browser/receipt.json`。其余浏览器入口、完整主测试/九条串联组及最新产品包仍待固定源码后执行。

本轮 Bot 交流已按原版实屏改为中间栏只读视图，保留原会话 DOM、草稿、阅读位置及右侧详情；双方作者颜色、头像、标题胶囊和关闭入口均已核对。当前 v57 实际源码的新/原交流 2 套共 10 条 Chrome 交互通过，完整 Node/Web 类型、严格局部 lint 及 27 项相关 Node 检查通过，3192 份输入无漂移。交流截图中更多按钮下落的原因是验收夹具遗漏组件 CSS；仅修正两套夹具加载真实构建输出，未重写已经存在的产品样式。证据 `/tmp/cmb-root-peer-exchange-inline-integration/production-applied-manifest.json`、`/tmp/cmb-root-peer-fixture-styles/production-applied-manifest.json`、`/tmp/cmb-root-current57-inline-browser/receipt.json`。

电脑面板覆盖条件已接入原 Workspace 所有者：帮助和下载弹窗暂停看屏/示范状态读取，成功创建 Bot 后实际未显示的反馈不再阻止新 Bot 画面刷新。独立候选真实公共创建和同 nonce 重放、原电脑及 Teach 菜单合计 12 条交互通过；2 文件已按摘要接入，当前合并源码仍需复验。Bot 复制另按 9 文件接入工作区代次与原视图归属，保留旧收据只读兼容、原复制规则和丢回包后的 nonce；三方接入保留上述交流与电脑修复。候选 69 项 Node / 4 条实际 SQLite+认证 RPC+公共备份恢复交互通过，当前整体门禁尚未据此计为通过。证据 `/tmp/cmb-root-inspector-modal-v2-integration/production-applied-manifest.json`、`/tmp/cmb-root-clone-epoch-integration/production-applied-manifest.json`。

本轮固定 v57+交流的整仓主组为 857 文件 / 7172 项通过，4 文件 / 8 项失败，31 文件 / 241 项按原条件跳过；1249.42 秒，3192 份输入无漂移。后续九个串联组因主组失败未执行。五条关闭用例的旧夹具缺少协作准入端口、一条旧版本断言仍写定 v54、一条八级协作用例未处理新增自动回信的真实准入，已修正原测试接线并保留原断言/期限；候选四套 50 项通过。备份完整性原用例的 5 秒超时保持为未关闭问题，孤立运行 3361 毫秒通过不代替整仓通过。另通过真实电脑检查点创建/恢复确认已有库和空库恢复均存在工作区代次缺口，修复正在准备。证据 `/tmp/cmb-root-current57-full-test-chain/receipt.json`、`/tmp/cmb-root-current-main-fixture-alignment/production-applied-manifest.json`。条件跳过不属于 Windows、Linux/K8s 或原生包验收。

最新补充：记忆面板的刷新沿用原策略读取和工作区代次护栏，使用已有 React `useEffectEvent` 读取最新回调，避免父组件重渲染触发重复列表读取。相同 17 条实际 Chrome 旅程对照：旧版 2 条失败，修复版全部通过；原 38 条断言和 5 秒默认期限保持，新增 5 条策略变化/回调断言。2 文件已按摘要接入，当前 lint 与完整 Web 类型通过、3170 份输入无漂移。证据 `/tmp/cmb-root-memory-policy-reload-production-applied-manifest.json`、`/tmp/cmb-root-memory-policy-reload-candidate/REPORT.md`。原浏览器整链在私有记忆处的失败已确认并修复，其后 14 个直接入口仍待当前源码复验，不将此专项写为整链或发布验收通过。

官方界面本日再核对了输入菜单、全屏示范准备、关闭后的焦点，以及 Bot 交流的只读消息页；见 [实屏记录第 11、12 节](13-original-app-observations.md)。协作回复调度已按 34 文件摘要合入真实 v55，复用原持久队列、权限、审批和模型图；私聊回复回到原等待任务，群聊派发后的私有回复不混入群消息，直接 Bot 消息不经过人员 Hook 或私有记忆授权。实际当前 v55 的新 2 条和原 4 条交流交互全部通过，3177 份输入无漂移；首轮失败为恢复后的测试未显式选择原 A 会话，只补该一步，原断言和时限保持。证据 `/tmp/cmb-root-col02-production/production-applied-manifest.json`、`/tmp/cmb-peer-turn-candidate/frozen/verification.json`。

示范学习已按 24 文件摘要三方合入真实 v56，保留 v55 协作及此前历史、搜索和记忆修复。输入菜单先打开电脑并准备示范，明确点击开始后才录制；开始范围绑定 Bot、讨论分支、工作区版本和真实操作目标，学习任务沿用原用户队列并限制为示范工具。群聊由用户明确选成员；这是对原版群聊电脑准备缺口的补充，不冒称照搬已成功的官方录制。窄屏提示裁切在冻结 v2 修正，Root 已查看最终截图。候选核心 53 项、实际原生示范 5 条、菜单 3 条和原电脑 6 条通过；当前 v55+56 合并源码的完整 Node/Web 类型及 16 套 / 116 项协作、示范近测通过，3189 份输入无漂移。证据 `/tmp/cmb-root-teach56-integration/production-applied-manifest.json`、`/tmp/cmb-root-current56-gates/receipt.json`；当前整条浏览器、构建及三平台实机验收仍未完成。

原直接浏览器链继续通过私有记忆、资料/技能代次修改和命令保存交互；任务恢复菜单快速重开时入口消失已在真实组件中复现。仅将原菜单入场动画限定到打开状态，保持原 9 条恢复旅程、断言与 8 秒期限，对照为旧 CSS 失败、修正 CSS 全通过且无页面异常。独立复核支持这一最小修改，具体事件顺序仅为源码推断；1 个 CSS 文件已按摘要合入。证据 `/tmp/cmb-root-recovery-menu-style-pair/result.json`、`/tmp/cmb-root-recovery-menu-style-production/production-applied-manifest.json`。当前生产随后 4 个入口与最后 6 个非全工作区入口均已通过；完整工作区将在协作/示范合并后复验，未计为整链通过。

资料库的旧夹具同步了当前详情面板的 `complementary` 角色，并明确提供详情页初次读取的例程端点；没有改生产功能。原资料读取 4 条和删除 4 条交互通过，AST 核对原 39 条断言全部保留，另加 2 条精确例程读取边界；生产局部 lint 和六入口链通过、3170 份输入无漂移。证据 `/tmp/cmb-root-library-role-fixture/REPORT.md`、`production-applied-manifest.json`、`/tmp/cmb-root-standard-browser-final9-result.json`。资料删除的跨恢复晚回包及旧请求准入另按真实后台链复核，不据此断言该边界已完成。

资料删除的恢复边界已按 8 文件摘要三方合入，保留 v55 协作、v56 示范和原读取队列：确认时固定文件身份、内容哈希及工作区版本，公共请求入场/返回和实际事务提交均复核；历史收据保持只读兼容，旧回包不刷新新工作区，同版本跨聊天的有效删除仍清理原会话附件。候选同源为 4 失败 / 1 通过→5 全通过；当前实际 v57 新 5 条、原删除 4 条和原资料 4 条全部通过，3192 份输入无漂移。旧版真实草稿本来未损坏，确认的缺陷是额外刷新及旧请求准入；旧能力用例是状态投影，不冒充旧安装包实测。证据 `/tmp/cmb-root-file-delete-integration/production-applied-manifest.json`、`/tmp/cmb-root-current57-delete-gates/receipt.json`。

记忆查询已升级真实 v56→57，仅新增按 Bot 定位证据和有效记忆的两个索引，原按状态索引、查询、排序与调度保持。实际公共查询计划不再扫描其他 Bot 的记忆元数据；真实 v56 库迁移、备份、第二索引故障回滚及六种使用场景均核对原记录和目标顺序。当前生产记忆/RPC/文件 8 套 / 98 项通过；两批涉及的 58 个 TS/TSX/MJS 文件严格 lint 无错误/警告、输入无漂移。该计划证明不换算为端到端速度承诺。证据 `/tmp/cmb-root-memory-index57-integration/production-applied-manifest.json`、`/tmp/cmb-root-current57-lint/receipt.json`。当前整仓、浏览器全链和新包仍待最终合并后执行。

本轮增量进展：直接创建后聊天、独立资料标签和会话行菜单已接入；18 项最近测试、13 条 Chrome 交互、完整 Bot 工作区、Node/Web 类型和局部 lint 通过。普通会话的 Mods 无工作区查询及切换后的迟到结果隔离修复已接入，生产 8 项测试 / 11 条 Chrome 交互通过。独立 Node Host 正式构建入口已加入，macOS arm64 / Node 22.23.3 新安装依赖、真实 Mods/esbuild/QuickJS 加载、连接断开、真实强杀重启、创建收据和产物变更拒绝验收通过；部署边界见 [独立 Host](16-standalone-host.md)。这些增量尚未重新执行当前全部源码的完整 `npm test` 链，不能以之前全仓通过结果代替。

浏览器旧收据迁移与重复执行的问题已修复：复用既有独立 SQLite 收据，兼容真实 Journal 格式，迁移后重试返回原结果；删除点保持墓碑，不能被旧创建请求复活。生产最近 74 项测试、编译后原生组合场景，以及下面新包浏览器 / 电脑维护旅程通过。真实保存路径的系统目录别名修复维持 Electron Node 22 文件保存 **35 / 35 项及压力门禁通过**。首轮及各次失败日志、截图均保留，包括新菜单导致旧桌面测试定位歧义；测试改为精确会话行后，同包重跑通过。

后续源码已接入资料内联编辑、独立命令所有者及离线资源核对入口。内联编辑生产最近 15 项 / Chrome 13 项、完整工作区通过；离线入口生产 IPC 128 项 / Chrome 6 项通过。当前构建加入第 16 个共享进程角色 `bot-shell-owner`。真实编译 Host 的原有 7 项重启验收，以及前台命令、后台任务、持续服务 3 项 Host 强杀后独立资源关闭验收通过。发现的系统路径别名、Hook 启动目录及异步审批上下文问题已修复；取消与错误分类生产 25 项、上述 Hook / 审批生产 7 项通过。日志及尚未关闭的边界见下节。这些源码晚于下面已验证测试包；本批完整测试及重新打包尚未完成。

随后补齐运行时代码写保护和公共链接预览。实际命令无法修改、删除或通过重命名祖先绕过当前进程代码保护，生产 14 项通过。链接预览沿用既有 Main IPC、可释放图片进程和消息虚拟列表，读取公开 HTTPS 元数据；真实 Chrome 10 条交互通过。独立复核确认缓存淘汰后保留的资源引用会造成容量统计错误，已修复并新增 4 条回归。当前固定输入完整门禁与新包验收待执行，不冒用下面旧包的通过结果。

本批固定 3019 份输入后，lint 无错误（原聊天组件 29 条既有警告）、Node / Web 类型通过。全仓测试运行 117.89 秒后主动中断，退出 130、输入无漂移；构建和其余阶段未执行。原因是新的真实 macOS 逃逸用例确认关闭判断错误：`POSIX_SPAWN_SETPGROUP` 后台进程在 Host SIGKILL 后继续写入，但收据被提升为已关闭，离线核对放行，Host 重启清除了现场。证据 `/tmp/cmb-shell-platform-draft/escape-product/RED-PROOF.json`、`/tmp/cmb-owned-link-quality-interrupted.json`。此前受控继承组的通过不能证明任意后台进程已经安全关闭。

关闭误判已修复：受控进程组关闭不再充当全部后代关闭证明；已知命令结果仍可正常结算，但未确认的物理现场保持保留，禁止重启或维护清场。生产最近 4 套件 / 41 项及 Node 类型通过；当前构建通过，随包 Electron Node 的 5 项真实 Host 强杀用例通过，输入无漂移（`/tmp/cmb-physical-closure-production-nearest.log`、`/tmp/cmb-physical-closure-native-quality-build.log`、`/tmp/cmb-physical-closure-current-native-five2-status.json`）。原生复验首次 2 项失败是探针未明确选择 Electron Node 模式，仅修正测试启动方式后通过；原失败日志保留。**这修复了错误放行，尚未完成 Mac 强隔离和可用的重启链**；不能把永久保留弱收据及达到 64 槽后拒绝运行当作最终产品。

UI-06 的现有中文界面、主题和跨时区排版已用实际 React 组件验证：3 时区 × 2 浏览器语言 × 4 窗口宽度 × 2 主题，共 48 项通过，包含系统主题事件、减少动画、键盘焦点和长文本（`/tmp/cmb-ui06-presentation-production-browser.log`）。这不是完整工作区或原生包验收；完整界面语言目录仍属延期范围。

技能创建、编辑和启用现复用原事务回执及共享本机记录保护，包含版本冲突、旧后台能力限制、历史回执不能复活删除技能，以及恢复期间的迟到结果隔离。当前生产 7 套件 / 43 项、Node/Web 类型、局部 lint、14 条实际 React + SQLite 交互及完整工作区 174.23 秒通过（`/tmp/cmb-skill-save-production-nearest.log`、`/tmp/cmb-skill-operation-ui-quality-status.json`）；该批输入无漂移。此前跨数据恢复迟到 ACK 清掉原记录的红证据保留，最终 18 文件修复已接入。

继续修复资料、群聊、头像、Webhook、工作流、例程运行、技能试跑和插件面板的迟到结果：数据已恢复时保留原待确认记录；同数据范围内卸载后的确切回执可清理本机记录，但不再更新旧页面或导航。当前生产资料 / 群聊 20 条、例程 / 技能 / 插件 16 条实际 React 交互通过，源码摘要无漂移（`/tmp/cmb-save-epoch-production-browser-status.json`）；头像 / Webhook / 工作流另有 9 条交互通过。资料回执的 24 条实际回调断言、最近测试和 Web 类型也通过。群聊及例程等重新打开时覆盖退役记录的问题已另行复现，尚待下批修复，不据此声称全部恢复链已关闭。

审批已补齐精确命令的“从不允许”：长期拒绝与本次拒绝分开，优先于独立审核，并阻止尚未执行的旧批准；设置中可改回询问或删除。SQLite v51 升级前备份并保留旧规则，恢复时撤销允许、保留拒绝。生产 6 套件 / 136 项、Node/Web 类型和 7 条实际 React + SQLite 交互通过（`/tmp/cmb-never-approval-owning.log`、`/tmp/cmb-never-approval-browser-green2.log`）；已检查深色规则面板与窄窗口截图。首轮测试夹具的 JSX 对象语法失败发生在打开 Chrome 之前，修正夹具后通过，原日志保留。**此项是具体命令规则，不等同于 Grok 按整台目标电脑设置的执行许可。** 2026-10-05 实屏已再次确认其电脑设置有始终允许 / 每次询问 / 从不允许三个选项；设备级许可仍需随执行环境补齐。审批设置本机记录的同类恢复问题已独立复现，继续修复。

### 原操作记录及恢复隔离（2026-10-05，当前增量）

- 群聊创建、资料及成员编辑复用共享保存状态，未知结果按原参数和原 nonce 核对；已确认结果的本机清理失败不会再次发送。群聊 38 条实际 React 交互通过，包含恢复期间卸载成员编辑器；源码与候选摘要逐项核对后接入。
- 例程保存、手动运行、技能试跑与插件面板统一使用既有记录保护。腐坏、无法读取或属于旧工作区的记录不会被新请求覆盖；原始内容可显式归档，归档不发起任务。25 条实际 React 交互及既有 16 条恢复交互通过。
- 例程已从当前列表删除时，仍能从“待确认操作”核对原收据，不会新建替代例程或任务。8 项最近测试与 12 条实际 React + SQLite 交互通过；原列表缺失恢复入口的失败证据保留。
- 审批规则和独立审核设置沿用原 flat 存储格式及容量限制，复用上述状态与清理逻辑。恢复后的迟到成功或拒绝不清除旧记录；26 条实际设置交互和原“从不允许”7 条交互通过。
- 头像、Webhook、工作流控制也已纳入共享保护。后台为新操作验证编辑时的工作区代次，已有确切收据仍按原身份只读核对；不会为历史请求补入新代次以再次执行。最近 16 套件 / 151 项、24 条回调断言、局部 lint 与 Web 类型通过，输入无漂移；37 条实际 React 浏览器路径通过，未出现页面异常。证据 `/tmp/cmb-envelope-operation-production-manifest.json`、`/tmp/cmb-current-mutation-recovery-final-status.json`、`/tmp/cmb-envelope-stable-unmount-browser2.log`。
- Webhook 恢复后立即隐藏上一工作区的密钥并停止复制。首轮密钥展示测试错误地持续返回旧版本状态，已修正夹具；此前按按钮文字判断卸载也不构成真实卸载证据，最终测试使用固定页面节点。
- 示范学习的自动用户消息改为明确工作说明，不向会话展示内部工具名或录制标识；原学习任务绑定与历史 nonce 收据保持兼容。15 项最近测试、Node 类型与局部 lint，以及 8 项真实浏览器 / 受控模型工具链检查通过。
- 上述检查分别覆盖真实 React、本机持久记录、SQLite 及受控模型路径；没有据此宣称 Windows 实机、Linux 内核或真实外部模型已验收。例程 / 技能新操作的后台代次校验、其余设置、内存恢复和后台停止入口继续收口；完整源码门禁与新包验收仍待执行。

### 后台提交范围与原操作记录（2026-10-06，当前已合入增量）

- 群聊保存补齐后台数据范围校验，参数保留提交时的 `expectedDataEpoch`，不会在重试时替换为当前范围；旧后台缺少相应能力时禁用提交。成员移除的未知结果和重试提示留在当前确认窗口中，避免提示被模态窗口遮挡。11 文件批次：最近 65 项、Node/Web 类型与 lint 通过；46 条实际 React + SQLite 交互通过。证据 `/tmp/cmb-group-host-epoch-candidate/group-final-status.json`、`group-browser2.log`。这些结果包含真实替换 Host 的范围拒绝，不构成原生 Windows/Linux 验收。
- 再次复核发现：已接受 nonce 的原 Store 回执虽是只读证据，替换 Host 若将其直接作为公开 RPC 成功确认，尚未收到恢复通知的界面仍会清除本机原记录。实际替换 Host 基线确认收到旧成功对象；修复后在认证 RPC 的提交和异步成功返回时校验原范围，拒绝跨范围成功确认。当前覆盖 19 个已有范围字段的公开修改接口，保留内部 Store 回执的原只读语义。最近 5 套 / 87 项、Node/Web/lint 通过，正式页面 48 条通过，其中 2 条实际复制检查点、调用生产恢复栅栏并连接认证替换 RPC，严格验证原记录、列表、关闭回调和数据库事件不变。证据 `/tmp/cmb-rpc-mutation-reply-baseline/actual-rpc-red1.log`、`/tmp/cmb-rpc-mutation-reply-candidate/rpc-group-browser-final.log`、`/tmp/cmb-rpc-mutation-reply-production-applied-manifest.json`。新增护栏不是所有公开修改接口均已校验的声明。
- 输出额度和通知设置复用原本机记录保护与共享保存状态，保留原编码、键和容量，明确区分后台配置视图和提交回执。11 文件批次：最近 34 项、Web/lint 通过；实际页面 28 条及原额度 7 条通过。基线真实复现 4 次恢复后的原记录误清；原版本内卸载正例保持允许。证据 `/tmp/cmb-flat-settings-next-candidate/README-CANDIDATE.md`、`/tmp/cmb-flat-settings-next-production-applied-manifest.json`。
- 例程保存、立即运行和技能试跑补齐原范围，后台新写在原收据事务内校验，可信模型工具仍经既有 lease、审批及 `toolOnce`。18 文件批次：最近 59 项及拥有方 15 项、Node/Web/lint 通过；新增实际页面 20 条，原页面与孤立记录回归共 53 条通过；同输入基线 16 条实际失败已保留。证据 `/tmp/cmb-routine-host-epoch-candidate/epoch-manifest.json`、`/tmp/cmb-routine-host-epoch-production-applied-manifest.json`。
- 记忆重试与备份配置接入共享原请求生命周期，损坏、不可读和恢复前记录禁止覆盖；清理失败后只清理本机记录或只读同步，不重复执行。真实记忆重试状态由任务完成、整理启动及失败产生；备份使用真实配置回执，不虚构已完成备份。10 文件批次：3 套 / 30 项、Web/lint 通过，实际页面 28 条通过；同输入基线 8 条中 5 条实际失败（4 次记录误清、1 次卸载后的额外读取）。证据 `/tmp/cmb-memory-backup-save-candidate/manifest.json`、`chrome-candidate3.log`、`/tmp/cmb-memory-backup-production-applied-manifest.json`。记忆策略开关已由下面独立批次补齐，不计入这 10 文件。
- 记忆开关补齐原工作区范围，在版本比较、人工修改屏障和事件写入之前拒绝旧页面修改。8 文件批次：最近 58 项、Node/Web/lint 通过，实际页面 8 条通过；同输入基线复现恢复前请求修改新策略等 3 个失败。公开 RPC 范围表由 19 项扩展为 20 项，仅增加记忆策略接口。证据 `/tmp/cmb-memory-policy-epoch-candidate/manifest.json`、`/tmp/cmb-memory-policy-production-applied-manifest.json`。私有/共享记忆条目的范围与生命周期已由下述 18 文件批次补齐，私有原 nonce 已由下述 12 文件批次补齐。
- Bot 创建、资料修改（含置顶/隐藏）和技能保存补齐提交时范围；新写在原 nonce 事务内校验，既有回执仍只读返回。可信模型/示范学习复用实际任务 lease，不向 RPC 提供绕过参数。21 文件批次：6 套 / 57 项、Node/Web/lint 通过，新增实际页面 40 条及原 13+13+14 条通过；同一最终测试源码基线 18 个失败、22 个正例。证据 `/tmp/cmb-profile-skill-host-epoch-candidate/epoch-manifest-final.json`、`/tmp/cmb-profile-skill-production-applied-manifest.json`。
- 任务恢复与后台命令停止复用共享原请求生命周期，保留原键、编码和容量。损坏、不可读、旧工作区或错误分支记录不能被覆盖；已确认结果清理失败后只清理或只读同步，不再次执行。命令读取由 Store 提供真实工作区版本，不将停止请求接受视作物理进程关闭。11 文件批次：4 套 / 18 项、Node/Web/lint 通过；实际 React + SQLite 32 条通过；同输入基线 8 条中的 4 次恢复后误清记录已复现，原范围卸载后的确切清理正例保留。旧 Store 缺少只读版本的单项失败亦保留。证据 `/tmp/cmb-recovery-shell-save-candidate/manifest.json`、`/tmp/cmb-recovery-shell-production-applied-manifest.json`。结果未知后任务转为运行/结束状态时的原恢复记录入口已由下述 7 文件批次补齐。
- Linux 原生命令源链已合入 44 文件，包含固定上游包及摘要、委托 cgroup v2 资源限制、首个执行效果前探针、准备/提交门槛、独立关闭见证及恢复维护读取；父进程 EOF 在等待启动前即登记。生产最近 59 项通过，2 项真实 Linux 专项在本 Mac 上明确跳过；Node 类型、lint 和构建脚本语法通过。证据 `/tmp/cmb-linux-native-production-status.json`、`/tmp/cmb-linux-native-production-applied-manifest.json`。Linux 原生编译、内核与 K8s 实测仍未完成，Windows v2 整链及设置接线已由下述 49 文件批次合入，原生编译与实机验收仍未完成。
- 私有/共享记忆增删改补齐真正工作区范围与任务 lease，公开 RPC 范围表现为 24 项。共享记忆复用原 nonce 回执及同一受保护操作记录，卡片已删除或窗口关闭后仍能从面板核对原请求，恢复及卸载后的迟到应答不更新旧视图。18 文件批次：7 套 / 96 项，原图运行专项 6 项、Node/Web/lint 通过；同最终页面输入基线 18 次实际失败，修复后 18 条通过，原记忆与策略 8 条亦通过。证据 `/tmp/cmb-memory-card-epoch-production-applied-manifest.json`。私有创建在提交后断连重复插入的基线已实证；后续 12 文件批次修复原请求核对，见下。
- 补齐终态任务的原恢复记录入口：运行记录已不再显示活动卡片时，仍可从工作区菜单核对原恢复决定；有界读取持久键，仅加载选中记录，不引入轮询或第二份索引。7 文件批次：3 套 / 14 项及 Web/lint 通过，实际页面 9 条通过；旧菜单基线确认缺少入口。证据 `/tmp/cmb-recovery-records-production-applied-manifest.json`。
- 新界面通过真实 `mutation-data-epoch-v2` 能力识别旧后台，保留原兼容标识。旧后台虽宣称支持早期校验，未完整处理新范围字段时，界面保持只读并提示更新。39 文件批次：5 套 / 74 项、Node/Web/lint/格式通过；4 项 Hook 基线和 5 条真实认证状态的页面基线失败，修复后相关 14 组页面通过。原状态夹具改用真实 API 状态；旧夹具将 `workspace_replaced` 当成普通拒绝的预期已修正为同范围 `invalid_input`，保留首轮失败日志。证据 `/tmp/cmb-rpc-epoch-capability-production-applied-manifest.json`。
- Windows 原生命令 source 链及显式管理员初始化已接通既有 Host、维护回执、Main IPC、preload 和设置页，仍用原 `bot-shell-owner` 构建角色。49 文件批次：最近 94 项、Node/Web/lint 通过；2 个 Linux、5 个 Windows 内核用例在 Mac 上跳过，未计为通过。真实 Windows Rust target ABI 三项诊断已修复，但未执行 C# 编译、完整链接或 Windows 内核。实际设置页 6 条通过；补齐等到显式状态刷新结束后检查无后台轮询，并修复切换深色时按钮文字颜色过渡造成的低对比闪烁。证据 `/tmp/cmb-windows-native-production-applied-manifest.json`、`/tmp/cmb-windows-setup-root-refinement-applied.json`。初始化中断且无法核验外部 UAC helper 时保留现场，不重复执行。
- 私有记忆创建、修改和删除复用既有 SQLite 原 nonce 收据事务；提交后断连、重启或卡片删除后，可核对同一请求，参数改变则拒绝。每 Bot 只保留一份有界待确认记录，已确认结果的本机清理失败不再次派发；真实 `private-memory-receipts` 能力不足时保持只读。12 文件批次：6 套 / 56 项、Node/Web/lint/格式通过；实际页面 16 条及原记忆 18 条、策略 8 条回归通过。包含真实认证 socket 的提交后断连和 SQLite 重开核对，不以模拟界面计作后台恢复证据。证据 `/tmp/cmb-private-memory-receipt-production-applied-manifest.json`。
- 多 Bot 停止传播已合入 5 文件：主任务明确停止或人工核对后结束时，在原事务内关闭属于该任务的协作后代及待回答操作；已开始的效果可正常结算，未知效果保留核对，独立任务和已成功交办的异步工作不受影响。12 项新增实际 SQLite 边界及 5 套 / 111 项原回归、Node/lint 通过；单一根任务/父任务索引经实际查询计划核对，无新增历史全表临时索引。证据 `/tmp/cmb-peer-cancellation-production-applied-manifest.json`。
- 原生组件配置的桌面启动链已修复：后台启动专用环境转发 5 个受控配置项，普通模型命令及 Hook 环境仍使用原过滤器。实际启动参数基线复现缺失配置；修复后 3 套 / 44 项、Node/lint 通过，包含原 Cmb 命令执行、取消和断连回归。另修复原生 Windows manifest 对正式构建器 `ownerProtocol` 字段的反向判断，基线失败后 10 项通过。证据 `/tmp/cmb-host-startup-env-production-applied-manifest.json`、`/tmp/cmb-native-manifest-contract-production-applied-manifest.json`。安装包内固定摘要与默认组件部署仍在补齐，未据此宣称普通 Windows 安装已可执行原生链。
- 电脑面板补齐隐藏后的截图生命周期：输入结果在关闭面板、切换标签或打开设置后到达时，不再发起额外截图；返回页面后重新观察，再开启输入。2 文件批次在同一正式 React/Chrome 测试中 6 次基线失败、修复后 6 条通过且无页面错误，Web/lint/格式通过；复用原可见性状态，无新增轮询。证据 `/tmp/cmb-computer-view-lifetime-production-applied-manifest.json`。输入传输为延迟受控桥，未据此宣称原生桌面或输入权限已验收。
- 本机项目访问许可已合入 31 文件，对齐 Grok 用户电脑权限卡的询问/允许/禁止、单次许可及撤回语义；实际实现复用原 Cmb 许可约束、任务租约、审批、收据和恢复栅栏。首次读取外部项目在模型与项目准备前确认，命令/写入逐操作确认，原审批继续生效；受管目录与专用浏览器不加这层外部项目许可。真实安装物理身份绑定 target，恢复后不继承历史允许；丢回复后从原卡或设置核对同一回答。新增 v52 三表及有界 UI 待确认入口，无第二数据库或后台轮询。64 项最近、6 项真实图/HTTP 模型、15 条实际 React/SQLite/认证 RPC 以及 Node/Web/lint 通过；大型 Office 文件复制的许可缺失与最终写入过期分别保留红绿证据。另以 3000 条历史及实际 SQL 计划验证权限撤回仅寻址可继续任务，已完成 allowed 历史不扫描改写。合入后的 7 套 / 121 项及当前构建通过，3135 个源码/配置/资源输入核对未变；尚未以此宣称当前 Electron 强杀链、Windows 或 K8s 验收。证据 `/tmp/cmb-local-tool-permission-production-applied-manifest.json`、`/tmp/cmb-local-permission-current-{integration,build}.log`。公开 RPC 范围字段由 24 项扩为 26 项，仅新增设置与回答接口。
- 当前构建后的真实 Electron Host 7 项通过、退出 0，覆盖额度/使用量重启、代理模型流、模型绑定强杀恢复、客户端断开后后台存活及持久历史、并发启动与启动描述符损坏；56 个未选中用例不计为通过。3135 个源码/配置/资源输入再次核对未变，证据 `/tmp/cmb-local-permission-current-native-host.log`、`/tmp/cmb-local-permission-current-inputs.json`。这 7 项不包含外部项目命令或 Setup Hook 的新增权限卡，相关强杀夹具正在按真实单次许可更新。
- Windows 只读命令配置传递已合入 9 文件：复用原 `readOnly` 和执行配置，通过同一规则贯通前台/后台工具、命令 Hook、两平台策略编译及 Worker；旧调用缺少字段或传入 false 不能放宽 Windows 只读配置，Linux/macOS 不继承 Windows 专属选项，已有子任务只读限制不变。当前许可 31 文件的最终执行栅栏保留。5 项真实工具/Hook/策略基线失败，修复后 6 套 / 42 项、Node/lint 通过；生产合入后含本机许可的 7 套 / 62 项通过。工厂验证隔离包校验、Windows ABI 和 cgroup 外部端口，不冒称内核强制验收。证据 `/tmp/cmb-native-readonly-production-applied-manifest.json`、`/tmp/cmb-native-readonly-current-nearest.log`。
- 原生组件安装默认路径与构建接线已合入 22 文件：复用稳定文件校验/复制、共享构建身份和既有后台/管理员初始化链。独立 manifest 摘要嵌入 Main/Host 与 buildId，桌面/独立后台构建只复制固定成员，最后封存；打包前强制核对摘要、目标、成员及来源，组件放在安装资源目录且不重复进入 asar。无组件开发包封存 null，不能据此宣称 Windows 命令可用；Linux 仍要求真实部署委托的 cgroup。首次获准命令才准备/探测组件，缺失组件不阻止对话启动，命令不降级到无隔离执行。两平台旧提前初始化基线失败；新增 32 项及原 37 项通过、2 项 Linux 内核明确跳过，候选 Node/lint 通过。生产合入后 14 套 / 108 项、Node/lint 通过。证据 `/tmp/cmb-native-distribution-production-applied-manifest.json`、`/tmp/cmb-native-distribution-current-{nearest,node,lint}.log`。本批未执行 Windows 完整 Cargo/C# 编译、Windows/Linux 内核或正式新安装包验收。
- 当前独立 Node 服务构建、锁定依赖的新目录安装及真实后台验收退出 0：16 个入口、Node 22.23.3/macOS arm64，实际 Mods/esbuild/QuickJS 加载、客户端断开后存活、SIGKILL 后原创建收据恢复、Worker 内容篡改和超大 manifest 在数据副作用前拒绝，以及既有服务目录不被替换均通过。3158 个源码/配置/资源输入前后核对未变化，证据 `/tmp/cmb-native-distribution-current-service.log`、`/tmp/cmb-native-distribution-current-service-inputs.json`。包含本机许可、只读配置和安装接线增量；不计作 macOS 强隔离、真实外部模型或 Linux/K8s 内核验收。
- Windows 命令所有者完整 305 行 C# 已用官方 .NET SDK 8.0.425/Roslyn 与 Microsoft net48 引用程序集实际跨编译：按正式构建参数生成 20,480 字节 AnyCPU/IL-only PE，零诊断；官方下载 SHA512 和生产源码前后摘要一致。辅助 C#5 语法检查亦通过，但不等同旧版 csc 兼容或 Windows 运行。固定 Rust fork 输入摘要核对通过，完整 Cargo 链接与真实 Job/UAC 内核仍未执行。所有工具和产物只在临时审计目录，未修改系统安装或生产 out。证据 `/tmp/cmb-windows-compile-audit/{COMPILE-RESULTS.md,full-owner-compile-evidence.json,managed-pe-evidence.json,verified-official-downloads.json}`。
- 实际程序与原生资源混包的发布缺陷已修复，6 文件批次：旧 Main/Host 的组件摘要 A 与新资源摘要 B 曾被真实 afterPack 放行，安装后运行时仍会拒绝该组合。现在从 Vite 最终 JS 入口及共享 chunk 生成有界摘要清单，打包时只读实际 app.asar/物理 app 的成员并逐个流式校验，打包阶段不能补造清单；开发 null 包同样必须核验。两套 / 31 项、Node/lint 通过，合入后同样 31 项通过；包含真实 Rollup 双入口、ASAR/unpacked 与 CJS afterPack，程序内容、共享 chunk、缺失清单及错组件均拒绝，同输入正例保留。证据 `/tmp/cmb-native-compiled-seal-production-applied-manifest.json`、`/tmp/cmb-native-distribution-audit/mixed-pin-evidence.json`、`/tmp/cmb-native-compiled-seal-current-nearest.log`。没有执行原生组件或据此验收 Windows/Linux 内核。
- 编译 Host 的明确本机许可测试夹具已合入 3 个仅测试文件：按临时项目物理身份、run/target/epoch 和精确命令提交 allow-once，不代答原动作审批，不放宽常驻策略。SQLite helper 6 项、原编译 native-owned 门禁 5 项通过；完整兄弟产物和全部测试资源已核对，Node/lint 通过。恢复抽样保留 2 通过、Setup 1 项真实失败：首条命令正常完成且提交 succeeded 效果，末条命令原审批仍待答，强杀后 Mac 物理闭合未证明，后台拒绝重启。原恢复期望未删改，也未清除资源证据。证据 `/tmp/cmb-local-tool-host-fixture-production-applied-manifest.json`、`/tmp/cmb-local-tool-host-fixture-candidate/{host-final-diagnostic,owned-shell-final-green}.log`；这些编译测试对应许可 31 文件后的构建，不冒用作此后安装接线批次的新构建验收。
- 本机许可并发与新读取边界已修复，13 文件批次：用每次操作独立持有的 admission 替换共享 mutation 槽，绑定精确原动作；Workflow、Mods 和原 Function SDK 的新读取检查当前许可，项目说明与 Harness 在异步准备后重读也须续期。已完成观察和结果发布直接复用。并发读取共用一张许可卡，但单个调用取消不影响其他读取，最后等待者取消只退役仍待答的原卡。相同最终测试在真实 Runtime 3 项、Harness 1 项基线失败；候选 6 套 / 99 项、真实 Runtime 3 项、Node/Web/lint 通过，合入后同样 99 + 3 项通过。证据 `/tmp/cmb-local-admission-production-applied-manifest.json`、`/tmp/cmb-local-admission-current-{owning,runtime}.log`。已开始命令继续收集结果的语义保持不变。
- 浏览器动作句柄释放已合入 3 文件：每次引用动作在成功、失败与拖拽第二目标失败时释放自有句柄；释放错误不改变已执行动作的结果，避免触发重放。25 项当前单元测试及相同源码的 3 项真实 Chrome 红绿检查通过，20 次真实输入的 20 个句柄各释放一次；失败节点 WeakRef/GC 检查通过。未把浏览器本身的 DOM 缓存判断为已全部清空。证据 `/tmp/cmb-browser-handle-lifetime-production-applied-manifest.json`、`/tmp/cmb-browser-handle-lifetime-current-unit.log`。
- 新标签覆盖旧页面操作目标已合入 2 文件：新导航不向驱动传入旧目标或模型给定的页面身份，仍由原注册链分配新目标。相同测试的 3 条真实 Chrome 旅程由失败转为通过，覆盖两个页面分别输入、归还后 Bot 回原页、导航失败后原页可用、接管期间排队操作被阻止，以及另一 Bot 页面不受影响。Node/lint 通过，测试浏览器/HTTP 均关闭；证据 `/tmp/cmb-browser-new-tab-target-production-applied-manifest.json`。这两条浏览器套件已注册到既有门禁，门禁拒绝跳过或部分通过。
- 独立服务容量规则已统一，2 文件批次：真实 Node 22 构建成功的 85 文件 / 787,613,712 字节服务曾被原启动器拒绝，同一原文件经修复后接受。只有严格组件 pin、实际资源封存文件及组件 manifest 摘要/目标全部一致时才使用 2 GiB 总额度；null 或旧包缺 pin 仍限 512 MiB，逐文件上限和流式摘要检查保留。四条同一大包负例和 14 项回归通过；当前生产含构建与混包校验的 3 套 / 45 项通过。证据 `/tmp/cmb-native-service-budget-production-applied-manifest.json`、`/tmp/cmb-service-capacity-audit/capacity-final-green-evidence.json`、`/tmp/cmb-native-service-budget-current-nearest.log`。验证未执行伪组件或 Host，不计作原生内核验收。
- 可信命令工厂在启动前失败的结算已合入 8 文件：复用领域错误与操作作用域，仅当前前台调用或对应后台/服务的真实准备失败记为 failed；取消保留 cancelled，提交后的异常仍按未知效果核对，跨调用传播旧错误不能证明新命令未执行。生产 7 套 / 59 项及真实 Runtime 13 项通过。证据 `/tmp/cmb-shell-preparation-production-applied-manifest.json`、`/tmp/cmb-shell-preparation-current-{owning,runtime}.log`。
- 原生构建输入与输出目标已合入：Linux 拒绝跳过 bwrap 或替换来源的环境变量；两平台使用显式 Rust target、私有 target 目录，拒绝环境重定向。生产 31 项通过；真实小型 Cargo 与完整构建器的受控编译观察保留红绿证据，不能作为完整原生组件编译通过。证据 `/tmp/cmb-native-build-{env,target}-production-applied-manifest.json`。
- Windows/Linux 发布接线已合入 3 文件：Linux 在原 manylinux2.28 环境编译原生包，独立 archive/manifest 摘要随产物传递；Windows 使用固定 MSVC 输入。打包前检查真实 ELF ABI、动态依赖、安装 Depends 和既有封存。候选 16 项近测、17 条工作流拼接、9 个真实小 ELF 与 37 条语法检查通过；生产格式检查发现 142 条警告，按本仓配置修正后 lint 无警告。未运行完整 Cargo、Windows/Linux 内核或实际安装验收；GNU 仍要求明确的 libssl1.1 兼容依赖，现代发行版 musl 路线未关闭。证据 `/tmp/cmb-native-release-abi-production-applied-manifest.json`、`/tmp/cmb-native-release-abi-current-lint-final.log`。
- Main 的两份既有 generated 脚本改为由 Rollup 发出后共同封存；启动和打包读取 ASAR 头、成员始终绑定同一文件句柄，头容量有界。独立服务与物理/unpacked 成员在全部读取后复核最早身份，拒绝读取期间的版本混装，句柄逐个关闭。当前 5 套 / 63 项、Node/Web 类型通过；首轮实际配置加载暴露 ESM 子路径缺 `.js`，修正后同组通过。新增 7 项永久边界回归已在生产源码通过，覆盖真实读取期间更新、16 MiB 头容量和句柄释放，已注册 CI；最终固定输入门禁尚待完成。证据 `/tmp/cmb-release-reader-root-current-inputs.json`、`/tmp/cmb-release-reader-current-nearest2.log`。
- 电脑预览点击/Enter/Space复用原面板展开状态；接管画面支持 Ctrl+Alt+Esc（Mac ⌃+⌥+Esc）回到本机控件，普通 Tab/Escape 继续发送给远端。真实 React/Chrome 同输入基线 7 条失败，生产 8 条全部通过、无页面错误；本机焦点及展开不发输入或转移控制。永久回归已接入原浏览器门禁。证据 `/tmp/cmb-bot-{ui-contract,computer-permanent}-production-applied-manifest.json`、`/tmp/cmb-bot-computer-navigation-current.log`。
- 独立 Host 并发关闭已合入 2 文件：信号和 RPC 重启加入同一个清理 Promise，重复同信号不绕过原超时；清理失败仍退出 1 且不提前释放锁。相同实际 Node 22 子进程/TCP/Unix socket 测试基线 4 失败、1 通过，生产 5 项全部通过；模型/数据库等依赖端口受控，不计作 SQLite、内核或 K8s 验收。证据 `/tmp/cmb-standalone-shutdown-production-applied-manifest.json`、`/tmp/cmb-standalone-shutdown-current-node22.log`。
- Bot/群聊资料库失败恢复已合入：保留原对话 key 和迟到请求隔离，读取错误增加直接重试入口，请求期间禁用；读取错误与删除错误分别保留。相同实际 React/Chrome 基线 4 失败，生产 4 全通过，其他 RPC 为 0、草稿不变；Web/lint 通过，永久测试已接入浏览器门禁。证据 `/tmp/cmb-bot-library-read-production-applied-manifest.json`、`/tmp/cmb-bot-library-read-permanent-production-applied-manifest.json`、`/tmp/cmb-bot-library-read-current-browser.log`。
- 本轮固定输入门禁首轮在 lint 停止：3189 个输入前后未变，ChatContainer 原有 29 条告警（20 条格式、9 条 Hook 依赖），后续阶段未执行。原失败日志保留于 `/tmp/cmb-core-final-current-quality-attempt1/`。单文件修正保留实际外部状态订阅，依照既有投影不变式去除重复依赖，补齐搜索与提交锁实际依赖；布局仍按原数值触发，不增加 RPC、轮询或缓存。生产 lint 无警告，候选完整 Node/Web 类型、已有投影/搜索/滚动 32 项、提交锁 10 项及 Goal 控制 8 项通过；未据此宣称整页或完整门禁已通过。证据 `/tmp/cmb-chat-hook-deps-production-applied-manifest.json`、`/tmp/cmb-chat-hook-deps-candidate/REPORT.md`。
- 工具安装与持久目录指导已合入 4 文件：三平台命令可用时统一说明临时 HOME/TMP 不能作为后续依赖位置，仍按既有命令审批执行；Help 明确项目范围及目录恢复点限制，不承诺系统软件或含链接的依赖全部恢复。真实 Runtime 请求与实际 FAQ SSR 9 项通过，同测试原生产 6 项预期失败；平台注入只验证提示，不验证原生执行。本批不宣布 CPU14 重建全项验收。证据 `/tmp/cmb-tool-storage-guidance-production-applied-manifest.json`。
- 第二轮固定输入门禁保留于 `/tmp/cmb-core-final-current-quality-attempt2/`：3190 个输入全程无漂移，lint、Node/Web、构建、7 项 Host、5 项受管命令关闭、链接预览及独立服务通过；主测试 812 文件 / 6830 项通过，但 10 文件 / 48 项失败、4 个异步异常，后续串联测试未执行。真实检查点恢复为 1 通过 / 6 失败；浏览器整组最后工作区阶段失败。这一批**未通过完整验收**，不能引用独立阶段绿色作为整体结论。
- 实际随包 Electron 39.8.10（Node 22.22.1）及目标 Node 22.23.3 均复现 Mods 外部 thenable 串入错误异步作用域的 3 项失败；单文件修正保留 Promise 创建、同步 getter 与回调注册各自归属。既有 3 套 / 31 项在两种真实运行时通过，未改断言；较新 Node 24 的语义不同，未据此改动当前目标版本。证据 `/tmp/cmb-function-async-scope-production-applied-manifest.json`。
- 文件删除复用既有读取清理：成功回执先撤销删除前列表读取，再发起一次当前列表读取；失败保留原行和原读取，不增加轮询。实际 Bot/群聊组件和共享刷新路径同测试基线 2 失败 / 2 通过，当前 4 条全部通过，其他 RPC 为 0。永久回归已接入浏览器门禁。证据 `/tmp/cmb-bot-file-delete-read-production-applied-manifest.json`、`/tmp/cmb-bot-file-delete-read-current3.log`。
- 6 份旧测试按既有真实契约修正：历史 nonce 只读回执、当前数据代次、新请求不能覆盖待确认记录，以及公开任务 revision；不修改运行时权限或缩小断言。工作流/上下文夹具显式绑定隔离临时目录的真实 Host 锁和本机授权，原动作审批仍保留，48 项通过；异步作用域、上述回执及主题组合当前 10 套 / 78 项通过。证据 `/tmp/cmb-regression-fixture-alignment-production-applied-manifest.json`、`/tmp/cmb-runtime-local-authority-fixture-production-applied-manifest.json`、`/tmp/cmb-core-final-current-nearest3.log`。
- 会话行菜单移除两处固定深色覆盖，沿用全局 popover/muted 主题，现有 16 项主题策略通过。工作区的两处默认电脑预览测试改为检查精确展开按钮及已绘制画面，保留真正接管画面的 application 断言；实际 Host/SQLite 窄验证确认尚未接管、无输入 RPC、窄布局及草稿不变。证据 `/tmp/cmb-bot-menu-theme-production-applied-manifest.json`、`/tmp/cmb-workspace-preview-fixture-production-applied-manifest.json`。新包实屏仍待重新构建。
- CPU10 本机浏览器休眠已合入 13 文件：复用原共享浏览器、任务状态及既有队列索引，默认闲置 5 分钟后实际关闭 Chrome，需要时自动重开；保留持久页面/工作数据和本次后台生命周期内的登录，临时 cookie 仅在 Host 内存保留（最多 2048 个 / 2 MiB），不把 DOM 或未保存表单当作可恢复状态。下载、示范、接管（包括断线后仍由人持有）、在途操作、活动任务及待核对任务阻止休眠；无关常驻 HTTP 服务不阻止。恢复后强制重新观察并拒绝旧目标；可重开的手动关闭与终止 Host 的 shutdown 分开，关闭未确认不能伪报成功。当前生产 7 套 / 44 项、lint 无警告，其中 14 项真实 Chrome 和 5 项受控 Node 进程，未跳过；2 套浏览器检查和 4 套近测已纳入原门禁。证据 `/tmp/cmb-computer-idle-production-applied-manifest.json`、`/tmp/cmb-computer-idle-current-owning1.log`。完整源码、新包及 Windows/Linux 仍待验收；Mac 命令强关闭问题未据此关闭。
- 六项 Host 强杀恢复测试已精确处理新增本机许可卡，只对固定临时项目/原任务及核验过的直接子任务逐项 allow-once，原动作审批、38 条断言、SIGKILL 和四种并行参数保持。实际源码权限链 6 条通过，尚未作为 compiled 恢复通过结论；新固定输入运行显式保留强杀场景的真实数据库和资源收据，连接与进程仍正常关闭。证据 `/tmp/cmb-host-recovery-permission-fixture-production-applied-manifest.json`。若 replacement Host 因 Mac 弱关闭证据拒绝启动，继续保留失败与现场，不清理收据绕过检查。
- RPC 关闭补齐在途请求排空：先同步撤销客户端输入并停止接收新请求，再等待已经受理的请求按原收据完成，最后关闭存储；并发关闭共用原 Promise，重启回调避免等待自身。原实现实际复现关闭返回后仍写入 SQLite、删除收据未结算和客户端信号未撤销；同输入基线 5 条失败，候选 5 套 / 107 项通过，类型和 lint 通过。仅增加既有在途计数的完成通知，不引入轮询或第二套任务状态；Host 原退出期限保留。证据 `/tmp/cmb-rpc-shutdown-drain-production-applied-manifest.json`、`/tmp/cmb-rpc-shutdown-drain-candidate/REPORT.md`。当前完整门禁仍待结束。
- 第三轮固定输入门禁已结束，3196 个输入全程未变；lint、Node/Web、构建、7 项 Host、5 项受管命令关闭、链接预览及独立服务通过。主测试 824 文件 / 6903 项通过，1 文件 / 1 项超时（另有 23 文件 / 181 项按原平台与专用门禁分流跳过），`npm test` 后续串联门禁未执行。检查点强杀恢复 1 通过 / 6 失败：原提交工具不重放通过；Notification 本机许可、终态 root 测试读取、Read child 补充消息接续存在真实缺口，Mac 弱关闭收据仍正确阻止 replacement Host。浏览器门禁在旧固定菜单颜色断言失败，之后的完整工作区尚未执行。全部阶段证据保留于 `/tmp/cmb-core-final-current-quality-attempt3/`，本轮不计整体通过。
- 旧上传排空测试现先启动 `server.close()`，确认服务器和文件服务均未提前完成，再释放已挂起请求并等待原全部关闭操作；保留原文件哈希、SQLite 收据和磁盘内容断言，不增加期限。单文件补丁已按摘要接入，最近 RPC / 文件及 ASAR 相关组合 97 项通过。证据 `/tmp/cmb-artifact-rpc-drain-fixture-production-applied-manifest.json`。
- 同批新包实际启动发现 ASAR 成员的 Electron 虚拟 inode 不稳定，触发 `Owned shell artifact changed`，随后桌面夹具解构失败；包及桌面失败证据保留于 `/tmp/cmb-core-final-current-package-*`，此包不作为可用交付。修复复用原有有界 ASAR 头和成员解析，改用 Electron 内置物理文件系统及单个固定句柄，保留文件/目录身份、哈希、防替换及释放检查；没有取消完整性校验。当前 5 套 / 51 项、Node 类型和 lint 通过，实际 Electron 39.8.10 / Node 22.22.1 运行新源码的两个成员校验通过；新的完整 Host/包验收另行运行，不以源码 probe 代替。证据 `/tmp/cmb-owned-asar-reader-production-applied-manifest.json`、`/tmp/cmb-owned-asar-current-electron-green4.log`。
- Notification Hook 的本机子许可按原 Hook id、action hash、项目和命令独立登记；原动作审批和本机许可不能相互代替，局部上下文结束即撤销，拒绝其他项目/命令及迟到回调。5 文件已按摘要接入；同当前依赖基线 5 失败 / 46 通过，候选 51 项及 4 项真实失败 DB 一次性副本读取通过，类型/lint 通过。恢复 helper 只在真实终态历史核验后复用先前 live root 身份，原 418 个断言及 34 处 SIGKILL 逐字保留，Read child 失败不被隐藏。证据 `/tmp/cmb-notification-local-scope-production-applied-manifest.json`；新的编译 Host 强杀恢复仍待复验。
- 会话菜单浏览器断言改为核对正式主题目录的 popover 色值，经 Chrome 归一化后与实际菜单比较；保留键盘、焦点、菜单布局、减少动画和原记录恢复断言。13 条实际 Chrome / React / SQLite 交互通过，日志 `/tmp/cmb-profile-theme-menu-current-browser1.log`。此项不代表后续完整浏览器门禁通过。
- ASAR / Notification 新固定 3199 份输入后，Node/Web、51 项审批组合、构建、7 项编译 Host 和临时签名打包通过，全程无漂移。实际新包正常创建 Bot，关闭桌面后继续执行，重启保留结果；随后旧桌面夹具未回答新增本机项目许可，等待原命令审批卡超时，未完成 23 项旅程。新包为 `/private/tmp/cmb-asar-current-um4isbrb/mac-arm64/CMBDevClaw.app`，当前仍不列为已通过桌面验收的交付。证据 `/tmp/cmb-asar-notification-current-package-*`；新包失败截图及真实现场均保留，单夹具按精确 allow-once 修正，不修改生产 ask 政策。
- 子任务补充消息修复已按摘要接入 4 文件：图启动前复用原 durable queue 接受消息，对照原检查点稳定 ID 重投已接受但未提交的消息；原 ToolMessage、子任务身份和完成兄弟收据保留。图和后台子任务开始后禁止外层重入，不改变工作流部分失败策略。生产 3 套 / 66 项及同源运行时模型专项 7 项通过，类型/lint 通过；补充专项纠正脚本中一个不存在的文件选择器，记录于 `/tmp/cmb-child-notification-current-recovery-execution-notes.json`，不将缺失选择算成已运行。
- 上述 3199 固定输入重构建后，原 7 项真实 Host SIGKILL 恢复为 **5 通过 / 2 失败**：普通检查点及四种并行协作矩阵全部通过，Read child 接受补充消息并成功，已完成编辑没有重放。Notification 与 child lifecycle 两项均因真正 Mac weak physical closure 阻止 replacement Host，原 scope / steering / root helper 错误已不再出现；失败数据库和资源收据继续保留。这不是全组绿色，也没有为通过而清除现场或降低护栏。证据 `/tmp/cmb-child-steering-recovery-production-applied-manifest.json`、`/tmp/cmb-child-notification-current-recovery-*`。
- Mac 原生关闭限制再次核对原 Cmb / Grok 与官方 XNU / Endpoint Security 源码，并在当前 macOS 26.5.2 作有限 OS 正反例：递归 kqueue 跟踪不支持，Seatbelt 的进程控制规则不能阻止 setsid / SETPGROUP；禁止 fork 又会破坏正常 npm / git 多进程工作。当前系统没有 macOS 27 的 ES descendant API，后者还需要 restricted entitlement 且本身不提供 Job 式自动关闭保证。12 份生产输入未变化；5 条有限证据断言通过，未运行长期逃逸进程、安装环境或修改 fence。报告 `/tmp/cmb-mac-strong-closure-review/REPORT.md`。完整 Mac 命令及可用重启仍属未完成架构门槛，正在评估应用管理的 Linux VM 复用既有 Linux cgroup 路线，尚未擅自替换运行环境。
- 桌面夹具已按单文件摘要接入精确临时项目 / 原任务的读取与 `node verify.cjs` 本次许可，原沙箱动作 UI 审批、24 处检查及 77 条断言保留。12 项相关检查、lint/格式通过；夹具类型诊断由既有 40 项减少至 21 项、无新增，并非类型全通过。对上述不可变 ASAR / Notification 包实跑 53.82 秒，项目审批和命令隔离检查已通过，继续至浏览器恢复点保存时被真正 Mac 弱关闭护栏拒绝；原 23 项旅程仍未完成。3199 份源码输入未漂移，包早于子任务补充消息批次，不冒充最新源码实包验收。失败现场 `cmb-bot-desktop-ZxEVf4` 和所有命令收据保留，未清除或降低护栏。证据 `/tmp/cmb-bot-desktop-local-permission-production-applied-manifest.json`、`/tmp/cmb-desktop-fixture-current-retry-*`。
- 该实包失败链另复现界面约每秒启动一个失败 Host 的资源问题。桌面启动现复用原并发连接 Promise，失败后仅新进程启动按 5 / 10 / 20 / 40 / 60 秒退避，最大 60 秒；缓存拒绝不会延长退避，不增加常驻定时器。仍先认证现有后台，其他启动者恢复就绪可立即连接；成功连接或成功维护清除退避，失败维护不清除，不重放域操作。生产 3 套 / 47 项、Node 类型和 lint/格式通过。当前仅源码验收，新包真实启动频率仍待验证；证据 `/tmp/cmb-desktop-launch-backoff-production-manifest.json`。
- Mac 共享 Linux VM 的只读可行性报告已完成：界面、模型、存储、审批和浏览器保持原生，仅命令复用原 Linux runner / cgroup / witness。标准 virtualization entitlement 的有限本机签名探针通过，框架 `isSupported=true`；尚需六项平台集成，且 supervisor 强杀后 Guest / 后端 IO 完整停止未获实机证明。24 份生产输入及 7 份 SDK header 未漂移；没有安装、构造或启动 VM，也未据此关闭 Mac 阻断。报告 `/tmp/cmb-mac-linux-vm-review/REPORT.md`；已向用户询问运行环境取舍，相关实现等待答复。
- SKL-01 的固定版本依赖核验已严格按 31 文件清单接入，复用 Cmb YAML、原技能来源、正常任务/本机许可/动作审批、原 runner 和效果收据。声明最多 32 项 / 8 KiB；导入仅预览，文件只核验类型，命令最多 5 秒，结果仅保留状态/布尔/规范版本，原输出不进入检查结果。记录绑定原版本、来源摘要、项目及运行环境、权限/代次，10 分钟后失效；不会标记技能试跑通过、授予权限或重放未知效果。实际 Mac CLI 版本可观察但弱关闭项及整体为未核验，原现场不被产品清理或放行。候选 84 项、当前生产 4 条实际 Chrome、Node/Web 类型与 35 文件 lint 通过；较宽执行器组合当前 9 套 / 375 项通过、19 项按原条件跳过，仍不作为全仓通过。折叠卡不发依赖 RPC，修复了初版自触发读取循环及多卡 fanout；六套单元检查及四条浏览器检查已登记原门禁。证据 `/tmp/cmb-skill-dependency-production-applied-manifest.json`、`/tmp/cmb-skill-dependency-production-*`。
- 桌面夹具进一步沿用原 `unwrapBotIpcResult` 在 Node 端处理 preload 返回的错误数据，先核对结果再访问资料、例程、状态、附件和分支字段；原版本冲突故意保留失败包用于断言。此前残留的 21 个诊断归零，专项真实 476 文件类型图与 lint 通过；原 UI 审批、超时和检查逻辑保持，不以解构/数组错误遮蔽真正的域错误。尚未据此宣称新包完整桌面通过。证据 `/tmp/cmb-desktop-ipc-result-production-manifest.json`、`/tmp/cmb-desktop-ipc-type-current/`。
- 原生命令补齐启动异常 finally 的定时器/监听释放、Windows UTF-8 字节界限及 Socket chunk 合并合法帧的解码。严格按 6 文件摘要应用，保留原 31 项测试、权限/首次效果与物理关闭证明；当前生产 6 套 / 39 项全通过。Windows/Linux 内核实机仍未执行，Mac 强关闭护栏不变。证据 `/tmp/cmb-native-shellrunner-production-applied-manifest.json`、`/tmp/cmb-native-shellrunner-production-owning1.log`。
- 运行间隔中断后的旧浏览器人工输入可在实际认证 RPC 及 Chrome 中继续点击，已通过原 Host ClockFence 修复：先持久撤销执行权限，再使旧画面/目标失效并取消运行；在页面读取、截图与示范的异步边界复核。不关浏览器、不归还用户控制、不增加轮询，刷新后同一用户可继续。严格按 5 文件摘要应用，当前生产 4 套 / 46 项通过；候选独立实际浏览器复现共 53 项通过。这里使用受控时钟，不冒充 OS 真实休眠/锁屏验收。原正式浏览器门禁纳入此文件，要求 12 套全部执行；命令新用例加入原 CI 门禁。证据 `/tmp/cmb-clock-supervision-production-applied-manifest.json`、`/tmp/cmb-clock-supervision-production-owning1.log`、`/tmp/cmb-native-clock-ci-production-manifest.json`。
- 固定 3215 份当前输入的整体验证已完成且无漂移：lint、Node/Web、构建、7 项独立 Host、5 项 owned runner、独立服务全新安装/强杀重启通过。`npm test` 主组 832 套 / 7012 项通过，3 套 / 6 项失败、24 套 / 193 项条件跳过；余下 9 条原 npm 门禁另按同一输入全部通过，不能合并冒充本轮 npm 全通过。3 套失败为技能导入预期字段及 Node 夹具对 Electron original-fs 的构建边界，保持原断言后已修正并在生产 23 项复验通过。原 7 项 Host 强杀恢复仍为 5 通过 / 2 项 Mac 弱关闭阻断。证据 `/tmp/cmb-core-current-integrated-quality4-*`、`/tmp/cmb-core-current-remaining-chain4-*`、`/tmp/cmb-full-fixture-integration-production-applied-manifest.json`。
- 同一固定输入的标准浏览器首组 12 套 / 58 项通过，后续完整工作区旅程在群聊弹窗关闭后遇到残留 pointer-events 锁，仍未通过；已保留失败页面、截图及真实状态，正在定位，未改为强制点击或放宽超时。实包 `/private/tmp/cmb-integrated-current-ll7lcg2l/mac-arm64/CMBDevClaw.app` 临时签名打包 40.67 秒通过，桌面旅程 60.68 秒在恢复点保存处被 Mac 命令弱关闭拒绝；源码及包摘要未变，失败现场 `cmb-bot-desktop-AmGjra` 保留。观察到两次失败 Host 启动间隔约 6.7 秒，已不按每秒重启，未据此声称完整退避或 23 项桌面验收通过。证据 `/tmp/cmb-core-current-integrated-package5-*`。
- SKL-09 技能验收补齐原事务及认证 RPC 的工作区版本校验，并沿用原 RPC 成功回包复核。旧页面/旧后台不能在恢复后确认已退休的试跑；重复相同验收只读取原回执，不重新执行任务。严格按 5 源码 + 2 最近测试摘要应用；生产 9 套 / 76 项（含上述 3 夹具）及 2 套 / 7 条实际 React/SQLite/替换 Host Chrome 旅程通过。专用 capability 与单元/浏览器检查已登记标准门禁，浏览器首组要求现为 13 套；尚未用该批次宣称整仓或实包通过。证据 `/tmp/cmb-skill-trial-review-epoch-production-applied-manifest.json`、`/tmp/cmb-root-skill-trial-fixture-owning1.log`、`/tmp/cmb-root-skill-trial-review-browser1.log`。
- Windows 原生构建与初始化现提取并复用 release 的固定源、Rust/MSVC/V8 校验及原桌面事务，CI 与桌面使用同一实现。15 文件按摘要接入，CI 三方合并保留 SKL-09 注册；真实 HostLock 的共享测试租约、原生配置与编译门禁要求全部适用 Shell / kernel 用例执行，跳过不算验收。本机生产相关 6 套 / 37 项通过，另 3 项原 Socket 用例通过；Node/Web 类型与 15 文件严格 lint 通过。实际 Windows 构建、管理员初始化、Job 关闭和 22 项编译验收尚未运行，Windows 通用桌面 Provider 仍未实现。证据 `/tmp/cmb-windows-native-ci-production-applied-manifest.json`、`/tmp/cmb-root-windows-native-ci-owning1.log`、`/tmp/cmb-root-windows-native-ipc1.log`。
- 工作区菜单复用原会话行的非模态菜单语义，关闭时首个外部点击可直接进入目标页面；Dialog 继续承担原模态控制，不写全局 body 样式。真实 Chrome 基线首个导航点击为 0，候选为 1；生产 4 条菜单/键盘/丢回包核对/减少动画路径通过。原偶发 pointer-events 残留未稳定复现，不能把菜单修正当成其全部原因已获证明。完整工作区同时补齐原夹具漏传的 SharedWorkspace 服务，与生产 Host 接线一致，没有增授项目权限；原插件审批与面板专项及当前完整工作区旅程通过。证据 `/tmp/cmb-menu-handoff-production-applied-manifest.json`、`/tmp/cmb-workspace-service-integration-production-applied-manifest.json`、`/tmp/cmb-root-menu-handoff-browser1.log`、`/tmp/cmb-root-workspace-menu-service-full1.log`；尚未冒用为全部标准浏览器、当前实包或三平台通过。
- COL-11 浏览器子任务已按 37 文件清单合入，保留 SKL-09 的工作区代次、能力与 CAS 校验。复用原工作流预约/队列/模型图/审批/检查点/结果路径，浏览器页面、画面、引用、控制权和下载绑定具体子任务；不借用父 Bot 页面。无项目的纯浏览器 Bot 可从认证 RPC 经真实 Host 队列执行及恢复原任务，终态屏幕只读，未知效果及人工接管现场保留。过期已知屏幕记录按原截止时间、索引和 16 行预算清理，不新增轮询。候选最终 8 项、原组合 128 项及 16 条实际 Chrome 路径通过；当前生产 4 套完整组合为 61 通过 / 1 项默认 5 秒超时，源码 2738 份无漂移；空闲单独复跑原浏览器子任务整套 15 项全通过，超时原用例 605ms，未改时限或断言。不能据此唯一归因 CPU/IO，也不称原组合全绿。证据 `/tmp/cmb-browser-child-v2-production-applied-manifest.json`、`/tmp/cmb-root-col11-polish-owning1-*`、`/tmp/cmb-root-browser-child-alone1-*`；没有新增编译 Host SIGKILL 或 Windows/Linux 实机证据。
- 电脑展示按旧 Grok 源码及官方 0.57.1 实屏适配：固定比例空白/就绪预览、可点击展开、独立全屏层、焦点限制与返回、示范录制红框/暂停状态、窄窗口及减少动画。沿用同一电脑和示范 DOM，保留草稿、在途输入、控制权与画面票据；没有第二套录制器或全局 body 样式重置。7 文件按摘要合入，直接声明原已安装的两项精确依赖，未安装或下载新包；实际 React/SQLite/认证 RPC/Chrome 的 4 条新交互、原 6 条查看器与 4 条子任务 UI 回归通过。生产合并 Node/Web 及 40 文件严格 lint 通过；上述当前完整组合同时覆盖这 4 条交互。证据 `/tmp/cmb-grok-computer-polish-production-applied-manifest.json`、`/tmp/cmb-root-col11-polish-{node,web,lint}1.log`；不称整个 UI 已完成或当前 Electron 包已验收。
- checkpoint 增量链复核发现 afterModel 追问会原地修改已缓存 AI 消息身份，导致 live 图与 fresh SQLite 读出的 ID 不一致。修复通过原消息 reducer 移除旧身份并加入保留 SDK 子类型/元数据的不可变替代消息，不改增量存储算法、不全量哈希历史。原真实 createAgent 的 AI/Chunk × durable/desktop 4 项同字节 RED→GREEN；独立实际 Cmb Runtime/deep graph/SSE/认证 RPC 的丢 ACK 重发及原租约恢复 2 项 RED→GREEN，加原 beforeModel/stream 2 项通过。恢复证据是同一 OS 进程的持久 fence、取消并等待原执行器、公共 recover，不冒充编译 Host 强杀重启。生产 3 文件应用时三方保留下面 Windows 提示词夹具修正，当前生产 9 套 / 65 项近测、10 项实际 Runtime、原消息队列及完整 `test:messages` 通过；3151 份输入未漂移。证据 `/tmp/cmb-root-checkpoint-routines-production-applied-manifest.json`、`/tmp/cmb-checkpoint-after-model-probe/`、`/tmp/cmb-checkpoint-after-model-runtime-review/`。
- 详情页例程摘要按官方实屏补齐紧凑任务行和暂停开关：普通行进入同一例程详情，“对话调整”仅预填原 Bot 草稿；未知回执进入原 Form 核对同一 nonce，已删除例程不被重建。抽取并复用原 CAS/epoch/本机保存协议，覆盖页面停止读取，cursor 变化合并为单在途读取；没有新缓存或定时轮询。5 源码 + 2 owning tests 按摘要合入，候选实际 React/SQLite/公开 RPC 7 条、原例程代次 20 条及 23 项纯逻辑通过；当前生产 7 条新 Chrome 旅程、原 20 条例程代次及上述单元组合全部通过。控制台 epoch 替换是受控状态夹具，未称为真实备份恢复或 Electron 证明。新 4 套浏览器/Runtime 检查已加入原标准浏览器首组，要求 17 套全部执行，新例程旅程及单元检查也已登记原门禁。
- 最新旧固定 3226 输入的 `npm test` 主组仍失败：7042 项通过、5 项失败、199 项按原条件跳过，后续 9 条链未执行。两项模拟 Windows 提示词用例误触发真实 Windows 测试初始化：先按实际物理平台准备原 runner，再模拟提示词平台，原 6 个组合/断言/20 秒时限保持，2 RED→6 GREEN、Node/lint 通过，已合入单测试文件，原生初始化要求不变。其余备份 2 项与真实 CLI 1 项在相同旧源的单 worker 单独及原两套全部 27 项均通过，原时限/护栏不变；只能说明负载相关的未收敛未重现，不能当整仓通过。证据 `/tmp/cmb-root-current-full-chain1-*`、`/tmp/cmb-root-shell-prompt-fixture-production-applied-manifest.json`、`/tmp/cmb-root-full-failure-independent-triage/REPORT.md`。后续当前全仓将固定外层并发后按原断言验证，不放宽业务或关闭证明。
- 附件与资料库补齐操作归属和有界读取，2 源码 + 1 测试按摘要合入。旧上传取消回执不能解除恢复后新上传的忙碌状态或放行发送；资料库复用原 keyed latest 队列，仅保留 1 个在途/1 个最新待办，覆盖或隐藏时退休读取，删除前响应不能恢复已删文件。没有第二套上传状态、协议或周期轮询。相同实际 Chrome/React/原 workspace Store/文件 RPC/SQLite 测试为基线 4 失败 / 2 通过，候选 6 全通过；当前生产原 6 项传输/队列回归及 6 条浏览器旅程全通过，严格 lint/runner 语法通过，3148 份输入无漂移。已登记原标准浏览器门禁；受控 UI epoch 不冒充实际备份/平台证明。证据 `/tmp/cmb-root-files-owner-production-applied-manifest.json`、`/tmp/cmb-root-files-owner-owning1-*`、`/tmp/cmb-bot-files-owner-candidate/REPORT.md`。
- 当前合并后的 Node / Web 类型检查均通过，3150 份输入无漂移。标准浏览器首组 17 套为 125 项通过 / 1 项失败，后续 40 条直接旅程未执行：旧新标签页夹具在归还控制权后未先观察最新画面，被原输入保护正确拒绝。夹具新增拒绝断言并调用原 snapshot，再执行原页面隔离断言；生产逻辑、时限未改，原 3 项单独重跑及严格 lint 通过。完整浏览器链仍需在后续批次合并后重跑，不能称全绿。证据 `/tmp/cmb-root-current-types7-result.json`、`/tmp/cmb-root-current-browser7-result.json`、`/tmp/cmb-root-new-tab-observation-fixture/production-applied-manifest.json`。
- 图片协作按 Grok 直接消息语义接入原审批、文件对象、任务收据和模型图：精确选择当前任务可见图片，收件人收到同内容哈希的作用域别名和实际图片输入，发送/接收记录在原事务共同提交。修复了直接交办图片时嵌套文件发布事务，抽取原发布步骤供原事务复用；故障时消息、别名、任务和事件一起回滚。17 源码 + 3 最近测试按摘要合入，Store/Workspace 三方保留群成员与删除范围修复。当前生产 7 套 / 85 项、2 项实际 Runtime/认证 RPC/受控 SSE、2 条图片 Chrome 路径通过，3159 份输入未漂移。受控模型拒绝图片时保留真实失败，不切换模型或伪造完成；这不是外部模型质量验收。证据 `/tmp/cmb-root-peer-images-production-applied-manifest.json`、`/tmp/cmb-root-peer-group-delete-owning1-*`。
- 群成员页使用原私聊导航，保留群/私聊草稿，不发消息或任务。删除 Bot 在原事务中按有界批次清理群成员，空群保留历史，恢复时复用同一清理逻辑及原删除账本。8 文件按摘要合入；生产原群/收件人/恢复完整 4 套 / 40 项和 3 条成员 Chrome 路径通过。首轮第三条夹具在恢复后省略新鲜删除请求的范围被正确拒绝；仅为两个新鲜测试请求加入当前范围，保留原失败、恢复导航断言和时限。证据 `/tmp/cmb-root-group-members-production-applied-manifest.json`、`/tmp/cmb-root-group-delete-fixture-owning2-*`。
- Bot 删除补齐提交时工作区版本：旧确认窗口不能删除恢复出的同 ID/版本 Bot，原确切删除重试保持幂等。7 文件按摘要合入；上述生产组合包含 6 项领域测试，另 3 条实际替换认证 Host/原页面交互通过。没有新队列或账本。图片和两组页面已登记原门禁，浏览器首组现要求 19 套，后续直接旅程为 42 条；整条标准门禁尚未重跑。证据 `/tmp/cmb-root-delete-epoch-production-applied-manifest.json`、`/tmp/cmb-root-peer-group-delete-registration.json`。
- 当前图片/成员/删除合并版的 Web 类型、构建和实际编译 Host 增量检查点强杀恢复通过，3161 份输入及构建产物无漂移：测试明确确认 SQLite 消息快照存在 `parent_id` 依赖，SIGKILL 后新 Host 经公开 recover 继续原图，已提交 remember 只保留一次，实际模型请求为三轮。这次定向 1 项通过，其余 62 项未选择，不当作全部 Host 通过或任意命令现场关闭证明。Node 全图初次发现 6 个新群成员测试入参缺少必填 description 的类型问题；补齐原值（无值为空串）后全图类型、8 项原断言及严格 lint/runner 语法通过，没有修改生产逻辑。原强杀恢复用例现登记标准编译 Host 门禁，要求由 7 项变为 8 项，整组仍待复跑。证据 `/tmp/cmb-root-peer-group-checkpoint-native1-*`、`/tmp/cmb-root-group-member-type-fixture-owning2-*`、`/tmp/cmb-root-checkpoint-native-registration/production-applied-manifest.json`。
- 侧栏顶部搜索按当前 Grok 实屏统一进入现有命令面板，复用 Bot/群聊原头像、虚拟列表、内容查询与定位；旧后台缺少内容查询时仍可本地导航。原常驻筛选框改为菜单/面板显式打开，原筛选、置顶顺序、隐藏对象、数字快捷键和草稿逻辑保留。4 源码 + 3 测试按精确摘要合入，生产 4 项纯逻辑、5 条新真实 Workspace/认证 RPC/SQLite Chrome 旅程及原独立面板旅程通过，3160 份输入无漂移，8 文件严格 lint/runner 语法通过。Root 实际查看深/浅/窄/减少动画四张最终截图；原完整工作区 361 断言仅同步入口发现，仍待合并后全旅程。正式浏览器直接旅程现为 43 条；完整 UI、当前 Electron 包和三平台仍未据此验收。证据 `/tmp/cmb-root-unified-search-production-applied-manifest.json`、`/tmp/cmb-root-unified-search-owning1-*`。
- COL-01 增加独立只读 Bot 交流记录，聊天、协作状态和任务历史共用同一入口。严格核对直接父子任务、请求/回送消息、会话分支与图片别名，拒绝读取其他私聊或嵌套协作；原恢复代次在读取前后复核。所有入口复用原有界 latest 队列，最多一个在途读取和一个最新待办；覆盖/隐藏/关闭停止读取，预览沿用原文件权限和 Blob 释放。18 文件按摘要接入，Workspace 三方保留此前搜索/群成员/图片/删除修复。当前生产 98 项领域/Runtime、4 条交流 Chrome、6 条电脑 Chrome 和 Node/Web 类型通过；已实际查看深色交流截图。初次全图类型发现测试 bundle.outputFiles 可为空，仅补构建结果校验后同 6 条原交互和类型通过。证据 `/tmp/cmb-root-peer-exchange-v2-production-applied-manifest.json`、`/tmp/cmb-root-peer-covered-owning1-*`、`/tmp/cmb-root-peer-covered-type-fixture-owning2-*`。
- 电脑面板被全屏层覆盖时，原 Inspector 现在将不可见状态传到同一 Computer/Teach owner，停止页面画面和状态读取；已接受的 Host 录制继续保留，不自动停止或归还控制。原 4 条交互与新增 2 条覆盖/迟到回包/StrictMode交互全部通过，不宣称后台录制 CPU 为零。证据 `/tmp/cmb-root-inspector-covered-production-applied-manifest.json`。
- 交流投影复核发现任务历史逐事件重复读取，已提取并复用同一批量 pageRecords/pageLinks。原公开 50 条历史页、协作预算和精确分支/图片校验保持；不增加全局缓存或存储。实际 34 次协作形成 102 个自然事件，相同 50 条事件新增投影查询从 500 次降为 6 次，100 条两页从 1000 次降为 12 次；普通历史无新增投影查询。此为查询次数，不是总 SQL 或端到端性能数字。3 文件按摘要接入，当前 5 套 / 34 项、严格 lint 和 Node/Web 类型通过，3169 份输入未漂移。证据 `/tmp/cmb-root-peer-history-production-applied-manifest.json`、`/tmp/cmb-root-history-browser-integrated2-*`。
- 标准浏览器合并门禁尚未全绿。首轮 19 套 / 132 项通过，子任务 UI 的 4 条在构建前被缺少 Worker 默认导出阻断；测试仅复用原实际 Highlight Worker 打包适配，4 条原断言和时限保持。第二轮首组 20 套 / 136 项全部通过，后续直接链在旧群编辑器未卸载的夹具竞态处停止。实际 held snapshot ACK 在原同断言基线复现，回调来自上一个仍挂载的 editor，发生于新 RPC 之前；应用正确拒绝旧恢复请求。仅在原 reset 起点调用既有 flushSync 卸载，最终当前 48 条原 Chrome 路径及 lint 通过，没有修改生产授权或断言。剩余直接旅程仍待继续，不能合并称整条标准通过。证据 `/tmp/cmb-root-browser-child-worker-fixture/production-applied-manifest.json`、`/tmp/cmb-profile-epoch-fixture-diagnostic/REPORT.md`、`/tmp/cmb-root-profile-epoch-fixture-owning1-*`。
- 以上各批均核对原源码和候选摘要并逐份应用；保留基线失败及夹具错误日志。用户解锁后本轮实际查看 Grok 主会话、电脑预览、详情、资料库、群成员导航和统一搜索入口，继续核对 UI 细节。Mac 强隔离及 Windows 完整原生构建/实机链仍在继续；完整固定输入门禁、当前新包和三平台实机验收仍未完成。

此前已验证 macOS arm64 测试包：`/private/tmp/cmb-bot-current-e06o36g2/mac-arm64/CMBDevClaw.app`。临时签名、未公证；包含此前检查点增量 / 孤立写入清理、文件服务生命周期、消息定位和分页、Harness 共用执行链、CPU-12 整体电脑恢复、MSG-19 诊断托盘，以及本轮资料 / 菜单、Mods 范围和维护收据修复。打包 55.67 秒通过；修正旧测试的定位歧义后，**23 项真实桌面旅程 74.06 秒通过**，两阶段源码和构建产物摘要均未变化（`/tmp/cmb-maintenance-package-run.log`、`/tmp/cmb-maintenance-desktop-retry-run.log`、`/tmp/cmb-maintenance-desktop-retry-desktop-checks.json`）。已检查主会话、详情和浏览器截图。此前固定输入完整测试与 7 项真实 SIGKILL / 重启证据仍按各自批次记录；当前新批次不冒用该全仓证据。Windows、Linux K8s、正式签名和真实外部模型仍未据此验收。

目标按用户 2026-10-02 最新要求更新：macOS、Windows 原生本机均支持，Windows 无 WSL2/容器依赖，未来适配 Linux K8s。当前开发和实测机器是 macOS；用户已有 Windows 测试机，待代码完成后进行实机验收。手机、语音等已延期范围没有改回首版要求。

**2026-10-05 按核心范围约 70% 粗估；这是按模块实现与剩余缺口作出的工程估算，不作为逐项验收通过率。2026-10-01 的约 60% 为历史估算。** 依据是工作区、持久运行、浏览器和部分工具已接通，标准研发执行链、若干核心交互及生产运行保障仍有缺口。177 项完整/部分核心尚未全部逐条验收，不能将代码文件数或单元测试数换算为完成率。Windows 通用桌面并行是未关闭的可行性门槛。

此前一次全流程通过的 `npm test` 退出码 0，主组 660 文件 / 5351 项通过、14 文件 / 141 项跳过；后续 adoption、消息、Hooks、插件、任务卡、合并、工作流、桌面基线和 IM 门禁全部通过（`/tmp/cmb-bot-quality-current-full.log`）。已包含失败反馈策略发布、Bot 执行去重隔离、设置浮层、模型编辑加载、检查点限制及此前执行链改动。后续表格、例程、桥接与时区以下述专项为准。新的整仓检查 `/tmp/cmb-bot-bridge-full.log` 出现多项 5 秒超时及插件清理失败；时区接入在它启动后修改，测试又加载了新用例与缓存旧模块，故主动中断，退出 130，不作为完整验收。修复与复验见下节，待代码固定后重新跑全流程。测试数不代表 Windows 实机或完整核心验收。

此前整仓基线对应的 macOS arm64 临时签名测试包为 `/private/tmp/cmb-bot-search-df2wjfht/mac-arm64/CMBDevClaw.app`。固定 2671 份源码/测试/配置，关联门禁与构建后，完整主测试 **672 文件 / 5502 项通过、14 文件 / 141 项跳过**，输入摘要无变化（`/tmp/cmb-search-postrepair-full.log`）；adoption、消息、Hooks、插件、任务卡、合并、工作流、桌面基线和 IM 标准串联门禁均通过（`/tmp/cmb-search-quality-*`）。实际原生 Host **5 项检查**、打包及真实桌面 **20 项旅程**通过（`/tmp/cmb-search-package-quality-{native-host,package,desktop}.log`、`output/bot-desktop/checks.json`）。包含分类引用、全局 AGENTS、工具输入收据、插件生命周期、项目扫描与取消等改动；已查看电脑预览截图。模型与企业身份均为本地夹具，包临时签名、未公证，Windows、Linux K8s、正式签名和真实外部模型仍未验收。此包早于下述草稿回执、富文本编辑器及下载连接生命周期修复。

本节改动完成后 Node/Web 类型及局部 ESLint 通过（`/tmp/cmb-bot-bridge-time-final-{node,web,lint}.log`）。冻结代码后的全流程 `/tmp/cmb-bot-bridge-time-full.log` 已结束，退出 1：主组 661 文件/5392 项通过，3 文件/5 项失败，14 文件/141 项跳过；后续串联门禁未执行。核对 `/tmp/cmb-bot-bridge-time-full-inputs.json` 的 2631 份源码/测试/配置摘要，测试期间均未变化。失败为两个摘要输入预算用例、工作副本隐式忽略的超时及后续断言，以及插件命令收尾被 MODS_TURN_ENDING 中断；正分别修复，不记为全绿。

## 已接入的产品代码

### 命令资源、资料交互与离线核对（2026-10-05，继续实施）

- macOS 命令沿用既有 Seatbelt 和 Cmb 命令执行器，增加独立所有者、准备 / 授权 / 提交 / 接收阶段及受控继承进程组。授权仍绑定具体动作；物理资源关闭与业务效果是否确定分别记录。持久证据有槽位和容量限制，状态不明时保留现场，不重放命令。
- Main 的只读资源核对入口独立于 Host RPC；Host 无法启动时仍能检查命令收据。仅应用主框架可调用，严格验证输入及返回值，原生展示只能使用已验证的收据目录；没有删除现场或重新执行按钮。生产 IPC 128 项与真实 Chrome 6 项通过（`/tmp/cmb-shell-review-nearest.log`、`/tmp/cmb-shell-review-production-browser.log`）。
- 实际编译 Host 首轮原生复验发现 `/var` 与 `/private/var` 的系统别名使严格目录身份检查失败。现由持有生命周期锁的启动入口一次性 canonicalize，后续 inode / 目录代次检查保持严格。修复后原 7 项原生 Host 验收通过（`/tmp/cmb-owned-shell-root-alias-native.log`）；前台、后台与持续服务实际 SIGKILL 三项通过（`/tmp/cmb-owned-shell-ui-production-owned-native.log`）。每项检查命令停止、独立关闭收据、Main 离线检查、重启清理及未知效果不重放。
- 复验还出现 5 个真实失败：审批通知在 Socket 回调中丢失原 AsyncLocalStorage 作用域；工作副本 Hook 的执行目录尚未创建，进程就尝试从该目录启动。现于调用入口捕获通知作用域、每次继续校验有效授权，并由可信项目目录启动工作进程，命令的获批执行目录不变。生产 7 项通过，包括拒绝 / 取消负例（`/tmp/cmb-shell-lifecycle-production-nearest.log`）；原失败日志保留在 `/tmp/cmb-shell-platform-draft/test-migration/nearest-runtime-first.log`。
- 启动前只读检查原来不可及时取消，保留项目锁直到配置读取返回；现提取既有带取消和截止时间的检查方法，停止后迟到返回不能再启动命令。已经接收的命令仍等待物理资源关闭。未知效果和维护拒绝沿用既有领域错误，安全序列化保留其代码。生产 3 套件 / 25 项通过（`/tmp/cmb-shell-guard-production-nearest.log`）。
- 名称 / 职责内联编辑沿用现有版本比较及持久 pending nonce，不引入第二套保存状态；未知回执仍按原意图核对。菜单尺寸、分组、焦点和减少动画按 Grok 实屏调整。生产最近 15 项、Chrome 13 项、完整工作区通过（`/tmp/cmb-inline-profile-production-nearest.log`、`/tmp/cmb-inline-profile-production-browser.log`、`/tmp/cmb-inline-shell-production-workspace-browser3.log`）。
- 已补齐当前运行代码的只读保护：可信启动器、所有者和 worker 目录可读但不可写，其祖先不可重命名或删除。实际 5 条原生攻击用例及既有隔离用例共 14 项通过（`/tmp/cmb-runtime-write-production-nearest.log`）；正常项目写入、工具 HOME / TMP 和工作副本仍可用。
- FIL-08 公共链接预览在独立 Main 通道接入，不启动 Host 任务、不复用登录 Cookie。DNS 固定解析、每次跳转重新检查公开地址、队列 / 正文 / 图片 / 超时有硬限制，图片沿用可释放 utility 进程生成有界 JPEG。生产 31 项、IPC 128 项和正式 Chrome 10 条通过；旧请求失败不覆盖新成功，隐藏 / 切换取消租约，卸载排空实际网络及图片资源（`/tmp/cmb-link-preview-production-nearest.log`、`/tmp/cmb-link-preview-ipc-production-nearest2.log`、`/tmp/cmb-link-preview-final-browser.log`）。
- 缓存复核发现过期或 LRU 淘汰后，挂载但隐藏的卡片仍保留旧图片，重新订阅时容量会变负。现统一释放快照及容量，订阅清理绑定原 entry；新增 4 条真实回归，生产 3 套件 / 22 项通过（`/tmp/cmb-link-preview-final-nearest.log`）。测试 TLS 夹具使用明确公开的测试证书，移除 Windows 上不保证存在的外部 OpenSSL 命令。
- 仍未关闭：Windows / Linux 的实际原生命令适配及对应实机验收；macOS 关闭误判、维护准入及现场保留已修复，强隔离和完整重启体验仍未完成。Windows 通用桌面多屏并行没有验收证据。本批最近验证不能替代完整固定输入门禁或实际新包验收。

### 本轮全面复核（2026-10-05，修复统一验收通过，继续核心实现）

- 复核范围包括业务状态、恢复与并发、权限、资源生命周期、消息交互、UI 和既有实现复用；下面的专项通过不代表完整核心已交付。本节修复已进入文首测试包；后续新功能单独记录。
- 检查点 `pending writes` 可以先于对应图状态提交。原清理仅遍历图状态，崩溃留下的孤立写入无法回收；现复用同一有界清理事务，纳入持久头之前的孤立写入，保留未来身份、父依赖和正在使用的状态。新增 8 项实际 SQLite 回归；相关 4 文件 / 38 项通过（`/tmp/cmb-checkpoint-orphan-green.log`）。
- 文件已重命名发布但数据库提交失败时，原临时路径清理不能清掉已发布对象；现由共用发布方法登记候选，在退出同哈希写入队列后执行既有引用检查和回收，保护共享对象及并发成功发布。新增 8 项回归，相关 3 文件 / 18 项通过（`/tmp/cmb-artifact-publication-green.log`）。
- 文件服务关闭原来只等待哈希队列，未等待前期上传、读句柄和分块传输；实际 RPC 关闭场景复现了关闭 SQLite 后仍写入的问题。现从首次异步准备前登记已接收的操作，拒绝新请求，关闭时排空已接收的操作及传输，释放资源后再报告子服务关闭异常。新增 12 项回归，相关 4 文件 / 30 项通过（`/tmp/cmb-artifact-service-green.log`）。
- 消息正文缓存按完整元数据控制每视图 1,500 条 / 16 MiB，只保留当前视图及其父视图；用户读旧页时，实时刷新保留当前连续窗口。消息响应超过协议帧上限时，Host 返回明确的过大错误，页面复用共用分页读取器缩小页数，普通连接错误不重试为小页；实际双向读取 120 条大中文消息通过，未重新建立认证连接。
- Bot 消息列表复用原 Cmb 的 `react-virtuoso` 与用户滚动判定。实际 Chrome 的 1,500 条变高消息检查中，挂载行数小于 60；前后分页和释放缓存后保持可见锚点。跟随流式输出与用户主动阅读由一个滚动写入方协调，监听器和 ResizeObserver 随视图释放。根代理最近 3 文件 / 11 项通过（`/tmp/cmb-root-settled-owner.log`）。
- 切换 Bot 的阅读位置沿用原聊天的有界 LRU 和 generation 租约，只缓存消息身份、偏移和跟随状态，正文仍按上述限制释放；返回时直接加载目标附近的页。读取失败与连接错误分开，后台刷新不清除错误或跳转最新页，显式重试读取原目标/方向；旧回包不能覆盖成功结果。相关 4 套件 / 73 项通过，页面往返与草稿保留已通过一次完整诊断旅程。
- 实际界面再次复测发现翻页的单帧校正可能先于 Virtuoso 双帧补偿结束。现复用原 Cmb 的 12 稳定帧/120 帧上限，逐帧重找消息身份，用户上下滚动均取消恢复；相关滚动、虚拟索引及实际 Chrome 3 文件 / 11 项通过。此前失败日志保留在 `/tmp/cmb-bot-skill-history-workspace-browser.log`。第四轮完整诊断 44 项旅程通过、页面错误 0（`/tmp/cmb-bot-skill-history-workspace-browser4.log`）；仍需在全仓固定输入门禁中复跑。
- 独立复核确认旧定位失败仍可能清除新视图的定位状态，搜索关闭重开后旧请求也可能关闭新窗口。Store 定位现在返回有效视图/lease 收据并接收取消信号，过期失败不再抛给 UI；取消立即释放当前开页状态。Workspace 只接受当前操作与收据，用户滚动、取消、卸载后不会重新定位；搜索独立校验窗口、查询和操作身份。新增 6 项 Store 回归，相关 4 套件 / 88 项通过；完整界面 45 项旅程通过，包括迟到 A 失败/新 B 待定位和返回未提交跳转前的阅读位置。搜索与快速查找旧实例迟到回包均在真实 Chrome 中先失败后通过；当前真实线程失败正确透传，取消和过期线程失败不误报。
- 实际 UI 复测发现 220 个排队任务卡占满消息区，目标消息未能挂载。现复用原任务身份和操作入口，正文仅保留最多 4 张活动卡、排队只保留一张摘要，全部任务每页 20 条；输出仅在用户展开后挂载。实际 Chrome 2,000 条任务检查与辅助状态共 6 项通过，第四轮完整界面旅程含翻页及历史定位也通过。任务弹窗、技能固定标题/版本说明和浅深色通知已检查截图。新增跨平台 `test:bot:browser`，CI 显式启用实际浏览器检查并拒绝跳过接受。
- 搜索列表改为仅保留当前页正文和最多 128 个返回游标。实际 React + Chrome + 2,000 条领域消息连续 20 页、上一页重新读取、原游标失败重试、查询切换的迟到回包隔离均通过；每页当前挂载 64 行，未累计 1,280 行 DOM。证据 `/tmp/cmb-bot-search-pages-browser.log`、`output/bot-search-pagination/`。
- 消息内技能引用可直接打开相应范围并展开当前步骤，明确显示消息引用版本与当前版本的差异；私有技能删除具备版本确认、原 nonce 收据、丢失确认后的持久核对入口。v49 主库和 v2 独立删除账本保留历史/试跑证据、阻止旧恢复点复活技能；已发布用户库副本独立保留。所属领域兼容 40 项、IPC 94 项和实际 RPC 1 项通过，第四轮实际 UI 完成版本差异展示、展开当前步骤和关闭重开后的原 nonce 删除核对。后续复核发现已完成任务的 keepAlive 服务遗漏技能撤权；现将私有、用户库、安装技能的当前授权检查统一到 runtime、dispatch 和服务，成功 origin 不重排，未知效果转人工核对。
- 标准研发执行链复用原 Harness 的项目/功能上下文、插件配置解析、AGENTS 指令、角色及 Hook 归属；当前项目权限变化与无关项目变化分开验证。复核发现并修复配置根软链接改目标、同路径目录替换、跨轮常驻服务撤权及 Hook/Mods function 请求末端缺少异步权限检查。实际泄漏均先失败后通过；无关项目变化不误停，已开始 SSE 的用量照常结算。该批 10 文件 / 105 项通过、17 文件 ESLint 无问题。统一固定输入门禁、构建、实际 Host 和打包仍待全部源码停止变更后执行。
- 恢复日志升级为包含独立准备摘要，继续执行时逐字节核验 post-fence 数据库、对象和 Teach；旧 pending 日志缺少可验证依据时停止并保留原始副本。Host 单链接、目录和 sidecar 身份检查贯穿准入及关键写入；失锁立即停止新调度、撤销后台模型和独立函数会话，允许已开始效果结算。慢 Webhook、定时备份子进程发布前重新检查同一归属；浏览器保存做来源第二遍核验，新恢复点绑定独立 origin，旧格式保持兼容。组合 11 文件 / 144 项通过、20 文件 lint 无问题。
- 备份与浏览器恢复点共用独立、有 8 MiB 硬上限的持久收据；删除前登记墓碑，旧创建 nonce 不会重新生成已删除内容，丢失发布确认返回原恢复点。原子文件写入失败只清理自身 pending，发布后的 fsync 失败保留目标；定时备份收到撤回终态后结束该 occurrence。组合 8 文件 / 89 项及最后补充 20 项边界通过，待统一门禁。整体电脑恢复 CPU-12 和错误通知托盘 MSG-19 经源码复核仍有明确核心缺口，将继续编码。

固定 2787 份源码、测试和配置的第一轮统一验收：lint 通过，Node 类型检查发现 6 处契约错误，退出 2；其余阶段未执行。已修正哈希校验参数、模型配置、角色身份和 Zod 类型契约，失败证据保留在 `/tmp/cmb-comprehensive-attempt1-*`。第二轮 lint、Node/Web 类型和真实浏览器通过；整仓主组 **714 文件 / 5950 项通过，16 文件 / 151 项条件跳过**，串联工作流门禁因 Harness 解析提取后旧测试仍只读 service.ts 退出 1（`/tmp/cmb-comprehensive-attempt2-*`）。现已检查共享模块和原 service 的实际接线，并直接验证合法/非法模式；该集成测试通过。第三轮仅该独立测试文件改变，应用与浏览器输入全部相同，浏览器通过证据明确沿用第二轮来源；完整 `npm test` 重跑通过（659.20 秒），所有串联门禁通过；构建、7 项原生 Host（19.98 秒）、7 项实际 SIGKILL/重启恢复（42.82 秒）、打包和 21 项真实桌面旅程通过，输入摘要无变化。证据 `/tmp/cmb-comprehensive-quality-*` 和 `/tmp/cmb-comprehensive-package-*`；两次失败证据保留。此结果验证本批修复，不代表整体方案或 Windows/K8s 已交付。

### 整体电脑恢复、诊断与持久保存（2026-10-05，统一验收中）

- CPU-12 已接通独立原生维护进程、持久操作收据、完整数据库及对象、浏览器状态、共享工作文件与受管 Git 工作副本的检查点。恢复先登记原状态，再应用新状态；启动入口在开放后台服务前恢复未完成事务。保留恢复副本与代码成果的来源凭据，用户后来修改代码不会被当作清理权限；删除元数据不擅自重建或删除用户目录。进度以实际完成工作计数，取消和超时等待维护进程物理退出。新打包桌面旅程仍待本轮统一运行，尚不代表 Windows 实机通过。
- MSG-19 已接通有界错误通知托盘及实际供应商请求标识，沿用现有诊断脱敏、调用身份和 UI 基础组件。取消不伪造失败，清理通知受修订号与恢复代次约束；隐藏窗口停止轮询。实际 Chrome 发现并修复了延迟提交后焦点恢复被吞的问题；通知托盘和电脑检查点的首轮固定输入类型、lint 与实际 UI 五阶段通过。
- 随后的固定输入完整门禁未通过：浏览器通过，主组 736 文件 / 6095 项通过，1 项真实目录监听失败，后续构建和原生阶段未执行。证据 `/tmp/cmb-computer-diagnostic-full-attempt1-*`。不能把单独用例绿色或扩大全量等待时限算作已修复：原 macOS 首次写入确实可能没有 FSEvents 事件，单次写入超过 3 秒仍未更新版本。
- 目录监听现复用原事件通知，在启动及目录重绑定后增加两次有限的元数据核对；不增加常驻轮询。启动先建立有界基线与监听注册，UI 和后台任务随后开放。实际无原生通知的单次写入已被核对捕获，相关 49 项通过；完整门禁等待新批次复验。
- M11 保存现在由 Main 持有 SQLite 队列与原生路径，最多两项并行。每个已落盘分块登记偏移及摘要，重启后校验断点；完整校验后以无覆盖方式发布。文件选择、取消、恢复、遗忘、维护和退出均有明确归属，未知收据不自动再执行；保存记录与原始成果、Host 和恢复代次绑定。下载的私有认证连接不取消共用聊天连接，页面只取得任务状态，不取得本机目标路径。
- 保存列表已接入工作区菜单、命令搜索、文件与预览。实际 Chrome 验证关闭重开、未知回执、损坏本机记录、版本冲突及键盘焦点；26 项真实文件系统、SQLite 与强杀恢复已通过。真实后台测试另发现成果删除误报为可重试中断，现改为来源变化；最终认证传输与资源门禁正在复验。
- 大文件压力测试暴露了共用 RPC 解码器反复拼接已收前缀的问题。约 3 KiB 内容按单字节碎片输入时，旧实现累计复制约 4.8 MiB；现按校验后的帧长度最多分配一次，并在连接关闭时释放残余缓冲与监听器。相关 RPC、解码与通信 60 项通过，保留原容量上限；两项 200 MiB 的最终原生内存测量尚未据此记为通过。
- 消息链接现保留经过校验的 Bot 消息定位协议，普通聊天 URL 策略不因此扩大；用户正文中的 HTTP 链接保留原文与引用偏移。15 项纯逻辑及实际 Chrome 导航通过。直接创建后聊天、资料标签与侧栏菜单仍在后续候选中，未以本节测试替代完整功能对齐。

### 检查点消息增量存储（2026-10-05，用户指出复用缺口后修正）

- 核对工作区与 Git HEAD，原 Cmb `SqlJsSaver` 确实已有外置消息、共享前缀/变化后缀和有界重建；此前 Bot 每步全量序列化消息。保留四个图快照和按数据量清理控制磁盘增长，不能替代增量编码。集中 SQLite 本身不因此被判为错误设计。
- 从原 Saver 提取共用外置引用、前缀比较、分块重建及深度/增量容量限制到 `message-snapshot-codec.ts`，原 Saver 改为调用共用实现。Bot 使用完整引用比较及调用时固定的数组序列，避免抽样未覆盖的中间替换被漏掉；消息值沿用 LangGraph 不可变 reducer 约定。
- Bot 增加不可变消息快照身份与图头映射，同一事务提交增量、图状态、运行指针及事件；图只保留近期状态，消息祖先按当前头可达性保留。跨 Saver 的同任务/命名空间 FIFO 与结果写入引用保护共用；读取在首次异步反序列化前固定完整依赖链，缺失/循环/前缀损坏拒绝恢复。128 层或 8 MiB 增量前重建完整基线，原总消息/检查点容量保护保留。
- v46 仅增加消息快照与头映射表；升级前保留 v45 数据库备份，原内联检查点不重写，仍能读取和继续。文首新测试包包含 v46 增量实现及下节 v47 修复；此前 bewq0tbe 测试包为 v45。
- 回归先复现：约 240 KB 的既有正文，追加 24 条短消息累计序列化 6,287,805 字节；改动后相同场景低于 65,536 字节，重开恢复完整消息（`/tmp/cmb-message-delta-red.log`、`/tmp/cmb-message-delta-green2.log`）。这是确定性夹具的序列化量，不代表真实模型端到端耗时或所有场景收益。当前 8 文件 / 111 项通过，覆盖原 Saver 24 项恢复、增量/并发/回滚/限额、上下文整理、原始任务历史、数据库升级和备份（`/tmp/cmb-message-delta-owner.log`）；随后新增已清理父快照的完整基线回退、编码途中取消，增量专项 16 项通过（`/tmp/cmb-message-delta-final-owner.log`）。固定 2728 份输入后的 lint、Node/Web 类型、完整 `npm test`（737.56 秒，主组 693 文件 / 5672 项通过、14 文件 / 144 项条件跳过）、构建及 7 项原生 Host 检查通过，输入摘要未变化（`/tmp/cmb-message-delta-verified-quality-*`）。编译 Host 的 7 项实际 SIGKILL/重启恢复检查通过（43.41 秒，`/tmp/cmb-message-delta-recovery-checkpoint-recovery.log`）；覆盖持久图、Notification、子任务及四种并行工作区组合。为先修复随后发现的边界问题，该批未单独打包。


### 代码复核：恢复一致性与长期运行查询（2026-10-05，继续实施）

- 用户明确复核不限于性能，需同时检查业务状态、异常恢复、资源生命周期、功能/UI 对齐与原有实现复用。当前不声称没有其他问题。
- 新回归复现了完整基线回退时重新读取调用方可变数组的缺陷：已编码的外置消息计数与重试正文可能不同，恢复时报损坏。重试现使用最初捕获的消息序列；超量消息数组也在复制/编码前拒绝。新增两项回归先失败，修复后通过（`/tmp/cmb-audit-followup-{red,green}.log`）。
- 工作区的恢复事件、未完成任务、待审批事项三条高频查询缺少适用索引，EXPLAIN 确认扫描全部历史；v47 增加仅含恢复事件/未结束记录的三个部分索引，查询与排序语义保持不变。升级前备份 v46，消息、运行和快照保持一致。查询计划及状态转移/恢复水位回归覆盖全部开放状态与即时关闭。
- 临时内存 SQLite 夹具各 10 万条事件、已完成任务、已回答交互及 10 万条已读消息，15 次测量的工作区快照中位耗时由 40.92 毫秒到 0.79 毫秒（`/tmp/cmb-hot-read-probe-all.ts`、`.log`）。该结果是本机受控样本，同时有查询计划证据，不是跨平台或实际业务 SLA。已读计数查询在相同样本没有表现出全历史扫描瓶颈，未据猜测重写。
- 6 文件 / 81 项增量、保留、限额、迁移、备份与查询检查通过；最终固定 2729 份输入后，lint、Node/Web 类型、12 文件 / 159 项、构建 22.41 秒、7 项原生 Host 21.43 秒均通过（`/tmp/cmb-audit-followup-quality-*`），输入摘要未变化。编译 Host 恢复用例新增落盘消息增量依赖的检查，7 项实际 SIGKILL 恢复再次通过（43.38 秒，`/tmp/cmb-audit-followup-recovery-checkpoint-recovery.log`）。临时签名打包 48.18 秒及 21 项真实桌面旅程 60.79 秒通过（`/tmp/cmb-audit-followup-package-quality-*`），测试包见文首。
- 删除与浏览器生命周期问题的修复和验收见下节。Bot 消息缓存及完整 DOM 随历史增长的问题继续处理，尚未全部关闭。


### 代码复核：Bot 删除与浏览器资源生命周期（2026-10-05）

- 对照 Grok `host-gateway-api.ts` 的 `releaseAgentBox`，实际 Chrome 测试先复现删除 Bot 后页面仍存活、示范录制中仍可删除两项缺陷。现在删除完成后释放该 Bot 的浏览器页面、下载作用域和安全输入引用；后台浏览器未启动时不为清理而启动。正在启动时等待并释放，删除后的迟到请求再次核对 Bot 身份。
- 页面关闭先撤销输入资格，再关闭已注册及注册中的页面；排队和在途操作不能在删除后继续发布结果。失败保留已关闭状态供相同删除版本重试清理，其他 Bot 不受影响。录制、暂停和生成示范期间要求先保存或丢弃，避免删除底层记录。精确重试允许恢复已删除 Bot 的未完成资源清理，其他过期版本仍拒绝。
- 弹窗在异步注册前预占页面名额，修复同时打开多个弹窗突破 30 页上限的竞态。实际 Chrome 阻塞注册并同时打开 32 个弹窗，最多 29 个注册占位加原页面；删除期间关闭全部页面，注册恢复后不能复活。导航事件保存改为每个 Bot 至多一个待处理任务；阻塞队列时 100 次页面导航只保存一次最终地址。
- 先失败证据 `/tmp/cmb-delete-browser-red.log`；实际浏览器生命周期专项 8 项通过（`/tmp/cmb-delete-browser-final-owner.log`）。冻结 2729 份输入后，lint、Node/Web 类型、11 文件 / 143 项相关测试、构建 22.90 秒、7 项原生 Host 22.09 秒通过，摘要未变化（`/tmp/cmb-browser-release-quality-*`）。临时签名打包 50.04 秒及 21 项实际桌面旅程 58.67 秒通过（`/tmp/cmb-browser-release-package-quality-*`），新测试包见文首。此批没有重复全量测试或 checkpoint 强杀门禁；相关增量存储恢复证据见上节。


### 代码复核：消息缓存与分支返回（2026-10-05，继续实施）

- 状态回归先复现四项问题：离开会话/分支后历史和分页缓存一直留存；恢复一个已无缓存的主线时停留空白；在分支中已消费事件水位后，返回主线无法及时显示期间新增消息；旧分页请求阻塞或清除同一视图后来请求的加载状态。证据 `/tmp/cmb-history-cache-red.log`。
- 普通导航本来就重新读取历史，因此只保留当前视图及当前分支的主线历史、分页信息；没有新增多份状态或重复的 LRU。草稿、上传和未确认发送回执沿用原生命周期。返回主线时复用现有数组和位置；缓存缺失时重新读取；已在浏览历史中间的窗口仍按前后页加载，不被最新页覆盖。页面请求的结果和清理均受同一选择代次约束，已离开的视图不会因迟到发送完成而重新加载历史。
- 返回缓存视图或 Host 身份变化时，重新同步最新消息与元数据；不再仅依赖工作区事件水位。新增回归验证连续切换 20 个分支最多保留两个历史视图，同时草稿、未确认发送和主线位置所需数组仍可用。初次专项 3 文件 / 30 项通过（`/tmp/cmb-history-cache-green.log`）。最终固定 2729 份输入后，lint、Node/Web 类型、6 文件 / 35 项状态测试、原 `test:messages` 专项、38 项实际 React UI 旅程（163.94 秒）、构建 19.94 秒通过，输入摘要未变化（`/tmp/cmb-history-cache-quality-*`）。实际 UI 包含历史锚点、未读边界、引用定位、分支草稿及位置返回；已查看 `output/bot-workspace/message-branch.png`。临时签名打包 50.12 秒及 21 项打包桌面旅程 58.37 秒通过（`/tmp/cmb-history-cache-package-quality-*`），测试包见文首。此次只改 renderer 状态，未重复全部 Host 强杀测试。
- 仍待处理：单个长期会话已加载消息与 DOM 行数的增长。已核对原 Cmb `ChatMessageVirtualList`、`thread-message-pages` 的虚拟列表与有界历史，后续需结合 Bot 的独立实时输出、引用定位、未读水位和分支返回位置复用；不能只截断数组造成消息缺口或误标已读。


### 代码复核：其他客户端删除 Bot 后的分支刷新（2026-10-05，继续实施）

- 新增三个回归先失败（`/tmp/cmb-deleted-view-red.log`）：正在显示的分支所属 Bot 已被删除，但刷新仍先读取失效分支及待处理指令；读取错误阻止新快照发布，界面无法切走。最后一个会话被删除时也未撤销旧分页请求，迟到响应会重新发布旧历史。
- 刷新先用新快照确认会话仍存在，再读取所选消息、分支和元数据。删除后切到仍存在的会话；无剩余会话时递增选择代次并清理阅读缓存，复用统一空历史状态；保留未发送文字和未知发送回执。三项复现修复后通过，相关 3 文件 / 33 项通过（`/tmp/cmb-deleted-view-green.log`）。真实 UI 新增另一客户端删除正在阅读的分支场景，验证窗口自动离开失效分支。
- 固定 2729 份输入后的 lint、Node/Web 类型、6 文件 / 38 项状态测试、原 `test:messages` 专项、39 项实际 React UI 旅程（169.25 秒）和构建 21.75 秒通过，输入摘要未变化（`/tmp/cmb-deleted-view-quality-*`）。新 UI 场景使用实际 Host/领域 API 删除正在阅读分支的 Bot，窗口自动切走，没有页面错误。临时签名打包 52.91 秒和 21 项打包桌面旅程 55.10 秒通过（`/tmp/cmb-deleted-view-package-quality-*`），测试包见文首；仍不代表 Windows/K8s 和真实模型验收。


### 群成员侧栏操作与无变化保存（2026-10-05，继续实施）

- 重新查看官方 Grok 的成员页、添加成员搜索弹层与输入框菜单；未发送消息、修改成员或启动录制。对照用户提供重建代码的 `agent-info/group-members/{view,model}` 与 `group-chat-glue.ts`，在已有详情面板增加搜索添加、行内移除、确认及键盘焦点恢复；使用 Cmb 现有 Radix、Bot 头像和主题，来源摘要已记录。
- 沿用原 `updateGroup`、revision、nonce 和 epoch 回执；保存回应丢失可关闭重开后核对，不重新提交一次不同成员修改。与完整编辑器共享未确认记录，拒绝覆盖另一处尚未确认的保存；旧 Host 未声明 `group-member-controls` 时提示重启。移除后允许群保留一个 Bot；创建仍按已约定 2～6 个 Bot，空群更新拒绝。
- 无变化的群设置保存（包括仅调整勾选数组顺序）保留原版本、讨论和审批；成员/目标真正变化仍停止旧讨论并校验版本。新增领域与回执回归先有 3 项失败，改动后 21 项通过（`/tmp/cmb-group-members-{red,green}.log`）。首次页面检查在关闭动画后焦点恢复前立即断言而失败；核对 Radix FocusScope 的卸载下一任务恢复逻辑后，改为有界等待实际焦点后继续原断言。固定 2724 份输入后的 lint、Node/Web 类型、61 项相关领域/RPC 检查、完整实际 React/Chrome/SQLite 旅程（162.99 秒）及构建（22.79 秒）全部通过（`/tmp/cmb-group-members-final-quality-*`），输入摘要未变化。保存回应丢失后重开核对未重复修改版本，成员移除至一个及重新添加完成；浅/深色搜索弹层、单成员和成员面板截图已检查。补充单成员文案后，与检查点数据量上限改动共同固定 2724 份输入；lint、Node/Web、28 项检查、构建、7 项原生 Host、7 项实际 SIGKILL 恢复检查通过。临时签名打包 51.66 秒、完整桌面 21 项旅程 58.48 秒通过（`/tmp/cmb-checkpoint-budget-quality-*`、`/tmp/cmb-checkpoint-budget-recovery-checkpoint-recovery.log`、`/tmp/cmb-group-members-package-quality-*`），测试包见文首。

### 执行检查点重复快照清理（2026-10-05，继续实施）

- 复现同一任务执行 40 步后保留 40 份完整状态及对应工具结果（`/tmp/cmb-checkpoint-retention-red.log`）。对照 Cmb 原 `SqlJsSaver` 按命名空间保留近期状态、在同一写事务内选取并清理的做法，为 Bot 的完整独立快照增加相应处理；没有将桌面消息差量格式直接套到 Bot 数据库。
- 每个任务/命名空间保留最近 4 份状态，同时保护新提交状态、直接父状态，以及正在序列化的结果所对应的状态。旧数据每次最多清理 64 份，读取候选时只取身份，不加载旧消息大对象；原聊天、审批、效果记录和审计事件保留。最近完整快照继续包含原任务消息，`read_task_history` 仍可读取模型摘要省略的内容。
- 清理与新检查点、任务恢复位置同一事务提交；删除失败全部回滚。并发工具结果按引用计数保护其检查点，结束/失败后解除保护；已过期旧身份禁止再次写入孤立结果，新检查点尚未异步提交时仍允许提前记录工具结果。没有额外常驻轮询，也未承诺 SQLite 文件立刻缩小；回收页供后续写入复用。
- 初轮 3 文件 / 18 项通过（`/tmp/cmb-checkpoint-retention-green.log`），覆盖 40 步积累、并发结果序列化、清理回滚、任务/命名空间隔离、提前写入、旧数据分批清理、检查点大小与取消限制，以及真实执行图的摘要/历史读取/审批恢复。固定 2723 份输入后的 lint、Node 类型和执行链 6 文件 / 283 项通过，19 项条件跳过（`/tmp/cmb-checkpoint-retention-quality-*`）。整仓主组 691 文件 / 5650 项通过，1 项目录监听真实文件系统用例失败，14 文件 / 144 项跳过；串联门禁、构建及原生检查未执行，输入摘要未变化。
- 失败发生在目录监听首次通知的默认 1 秒等待期限。原用例单独复测通过，尚未确认整仓失败的唯一原因；将前两步与原第三步统一为 3 秒实际事件等待，总期限 12 秒。不重写文件、不模拟通知、不删除断言。16 项目录监听检查通过；固定输入后的 `npm test` 全流程已通过，主组 692 文件 / 5651 项通过、14 文件 / 144 项条件跳过，后续 adoption、消息、Hooks、插件、任务卡、合并、工作流、桌面基线和 IM 串联门禁全部通过，输入摘要未变化，耗时 811.35 秒（`/tmp/cmb-checkpoint-final-quality-*`）。构建 26.8 秒、7 项原生 Host 检查 24.46 秒通过；另外 7 项实际 SIGKILL 恢复检查通过，覆盖持久图、Notification、子任务生命周期及四种并行工作区组合，其余 54 项本次未选中（`/tmp/cmb-checkpoint-retention-package-quality-checkpoint-recovery.log`，42.11 秒），输入摘要未变化。已与群成员改动和清理数据量限制共同打包，见上节。
- 本项处理重复执行快照；全量任务/审计数据的保留周期、通用桌面环境备份与目标平台恢复验收仍未完成。

### 下载中断记录与重启反馈（2026-10-05，继续实施）

- 普通点击、下载弹窗和人工接管下载原先只在进程内记录。开始下载的回归先失败（`/tmp/cmb-download-start-red.log`）；现复用唯一 CDP 下载路由，在接受下载时持久保存 GUID、Bot、原对话、分支和任务身份。SQLite v45 只保存这些归属，不保存 URL、凭据、文件名或未完成字节；现有下载数量、大小、超时与控制权限制保留。落盘失败取消该下载，不继续启动后台任务。
- 文件发布沿用原成果与消息附件事务。重启在持有 Host 排他锁、恢复成果之后清理未完成记录：已发布文件保留，未完成项在原分支说明“后台重启，下载已中断，请重新下载”；通知与记录清理同事务，重复启动不重发。已删除 Bot、已离开群聊不转投其他对话，也不唤醒模型或重新提交原网页请求。
- 5 文件 / 44 项先通过，包含实际 SIGKILL 的下载进行中、通知提交中、文件发布提交前后；v44 升级保留原消息并先备份数据库。随后固定 2722 份输入，lint、Node 类型、77 项领域/迁移/备份/成果检查（13 项条件用例跳过）、21 项显式真实 Chrome 浏览器检查、构建和 6 项原生 Host 检查通过（`/tmp/cmb-download-journal-quality-*`），输入摘要未变化。
- 为确认正式启动入口确实调用恢复，再增加编译 Host 连续两次重启检查：原分支只保留一条中断通知，完整文件仍可读取，无模型调用或新任务。新原生门禁 7 项通过（`/tmp/cmb-download-native-startup.log`）；最终 lint、Node 类型和 7 项原生 Host 在固定输入下再次通过（`/tmp/cmb-download-final-quality-*`）；产品源码与此前构建相同，仅增加正式启动回归。`otrbyher` 包打包 41.87 秒，21 项桌面旅程通过，成功报告时间为 2026-10-05 05:20:22（上海），2722 份输入摘要复核未变化（`/tmp/cmb-download-final-package-quality-*`）。
- 本项实现中断反馈及已完成文件恢复；未完成网络请求的跨进程续传和下载中心仍未实现。没有把 GET/POST 请求自动重放当作恢复，也没有将本机结果扩大为 Windows/K8s 实机验收。

### 例程列表、编辑层级与操作回执（2026-10-05，继续实施）

- 重新查看已运行 Grok 官方客户端的例程列表、详情和底部操作，并对照提供的重建仓库 `features/automations/routines/view.tsx`。按其信息层级调整现有 Cmb 组件：列表、新建、编辑分开，常用运行/编辑保留，记录、对话调整、暂停/恢复和删除放入已有 Radix 菜单；复用原表单、SQLite 版本与回执机制，没有另建调度链。
- 新建表单在列表间往返保持挂载以保留草稿，隐藏时不占布局或键盘序列；真实保存回执丢失后重新打开自动进入核对。标题、正文滚动与底部保存区域分开，修复轮询抢焦点的路径，并保留搜索定位、远端版本冲突、创建/编辑/删除回执与间隔计划时点检查。
- 首轮 lint 发现移动操作栏后的无用导入，清理后固定 2719 份输入，lint、Node/Web 类型、4 文件 / 17 项、完整 React + SQLite/Host 浏览器旅程 162.12 秒、构建 19.87 秒通过（`/tmp/cmb-routines-layout-quality-*`）。已逐张查看 `output/bot-workspace/routines-list-codex-{light,dark}.png`、`routines-menu-narrow.png`、`routine-create-narrow.png`；小窗口底部按钮可见、无水平溢出。首轮未打包；随后文首新包已包含这些 UI 改动。
- 随后继续补暂停/恢复的响应丢失场景。真实 SQLite + 实际组件浏览器用例先失败：暂停已落盘却没有可核对的回执界面。现复用同一保存 nonce 与待确认记录，重新打开后的恢复点击先核对原暂停，确认后才允许另一次恢复；未知错误保留回执、明确拒绝才清除。定向浏览器回归通过（`/tmp/cmb-routine-toggle-{red,green}.log`）。固定 2719 份输入后的 lint、Node/Web 类型、4 文件 / 18 项、回执专项浏览器及完整工作区 161.93 秒通过（`/tmp/cmb-routine-receipt-quality-*`）；构建 22.60 秒通过，输入摘要无变化。浏览器测试使用本地夹具，未调用真实模型服务。

### 桌面重开与配置监听误触发（2026-10-05，继续实施）

- 桌面重开原先无条件写入配置失效标记，导致仍在独立 Host 运行的任务被中断。现在先按完整值（含凭据）核对持久快照；配置不变不失效、不替换文件。真实在线变更仍同步失效，启动无法读取权威配置仍停止使用旧快照；关闭期间更改配置也不能让旧任务切换到新供应商。新增回归先失败再通过，固定 2718 份输入后 lint、Node 类型、7 文件 / 33 项、构建及 6 项原生 Host 通过（`/tmp/cmb-desktop-reopen-final-quality-*`）。
- 新包 `7c7ilv2e` 打包成功，但桌面复测间歇失败，单次复跑通过未作为结案。只记录文件名、时间及失效标记的存在性，未记录凭据。失败日志 `/tmp/cmb-desktop-reopen-configuration-trace2.log` 显示：创建命令工作目录后，旧任务模型调用前再次出现失效标记。
- 定位到 Hooks 监听器对整个数据根目录的任意 rename 都提升技能版本、通知 Bot 配置失效。普通工作目录、数据库临时文件等无关变化因此中断任务。新增测试明确复现 5 次错误失效（1 项失败 / 12 项通过），现仅把根目录下已知技能/插件目录的改名作为拓扑变化；技能子树改名、相关配置文件和无文件名事件仍保守失效。修复后 4 文件 / 24 项通过（`/tmp/cmb-hook-root-fence-{red,green}.log`），固定 2718 份输入后 lint、Node 类型、10 文件 / 53 项、标准 Hooks 集成、构建和 6 项原生 Host 检查通过，输入摘要未变化（`/tmp/cmb-hook-root-quality-*`）。新包 `qnnxv8hw` 打包 43.28 秒、21 项真实桌面旅程 55.61 秒通过，包含此前失败的重启后命令审批与执行（`/tmp/cmb-hook-root-package-quality-*`）。仅元数据的配置事件从失败复测的持续发布收敛到启动阶段；没有放宽任务撤销检查。
- 继续验证监听器生命周期：实际 macOS 文件系统目录替换用例在改动前已通过，未将其描述为本机复现失败；另一个关闭后迟到回调用例明确失败，旧监听器仍提升版本并启动通知计时器。改为按目录持有监听实例，退出或替换后旧回调无效；父目录发现技能/插件根替换时重新绑定子目录监听，实例数保持有界。跨平台重新绑定依据 [Node.js fs.watch inode 说明](https://nodejs.org/api/fs.html#inodes)，Windows/Linux 本轮未实测。修复后 4 文件 / 26 项通过（`/tmp/cmb-hook-watch-lifetime-{red,green}.log`），包含真实文件系统与过期监听回调；已加入三平台 CI 清单，远端 CI 尚未运行。
- 最终固定 2720 份输入，lint、Node 类型、11 文件 / 56 项、标准 Hooks 集成、构建和 6 项原生 Host 检查通过（`/tmp/cmb-hook-watch-final-quality-*`）。文首 `qlxlqvf0` 包打包 51.61 秒、21 项真实桌面旅程 60.92 秒通过，输入摘要未变化（`/tmp/cmb-routine-watch-package-quality-{package,desktop}.log`），已包含本节与例程界面/回执改动。
- 桌面验收启动时清除旧 `checks.json`，成功报告增加完成时间；失败不会继续展示上次成功记录。保留有界、仅元数据的配置变更轨迹，方便定位真实进程间时序。

### 原生窗口可见性与界面后台开销（2026-10-05，继续实施）

- 两次真实打包检查均记录到 `BrowserWindow.isVisible() = false`，但 `document.visibilityState = visible`，原依赖文档状态的判断不能可靠停止隐藏界面读取。接入 Electron 主窗口的显示、隐藏、最小化和恢复事件，与原文档/设置浮层状态共同控制 Bot 视图；后台 Host 继续独立执行。
- 新增只读窄 IPC，限制主窗口主框架，状态带递增版本；全部 Bot 视图共享一个原生订阅和文档监听。迟到初始读取不能覆盖较新的隐藏事件，最后一个视图卸载后清理订阅，旧订阅回包无效。首轮 Node 类型检查发现 Electron 不接受事件名称联合类型，改为显式绑定/解绑。固定 2717 份输入后 lint、Node/Web 类型、10 文件 / 39 项、完整 UI 153.32 秒、构建及 6 项原生 Host 检查通过（`/tmp/cmb-native-visibility-final-quality-*`）。
- 后续包 `/private/tmp/cmb-bot-current-qfysqd16/mac-arm64/CMBDevClaw.app` 正常打包，但桌面恢复仍失败。最小裸 Electron 窗口复现 `show()/hide()` 已改变 `isVisible()`，却未收到相应事件；诊断读取可以更新状态，故原用例调用 read 曾掩盖隐藏通知缺失，不能将其算作已通过的自动暂停。复现日志 `/tmp/cmb-native-visibility-probe{,2}.log`。原生事件本应存在，参照 [Electron BaseWindow 文档](https://www.electronjs.org/docs/latest/api/base-window#event-show)，仅记录当前 macOS / Electron 39.8.10 实测，不推断所有版本相同。
- 现对应用自身的启动显示、托盘隐藏与唤醒立即更新状态，同时在视图首次读取后启动一个每秒一次的窗口级原生状态兜底，窗口关闭即清理；状态未变不发 IPC，不截图、不读文件、不刷新业务。新增“丢事件仍恢复、单实例、关闭清理”用例先失败再通过，合计 9 项专项通过。打包用例改为只观察推送确认隐藏，保留焦点模拟、后台改动、重新显示刷新及未发送输入检查；不再用 read 帮产品修复状态。固定 2717 份输入后的 lint、Node/Web 类型、10 文件 / 40 项、构建和 6 项原生 Host 检查通过，摘要无变化；此次仅改主进程生命周期与测试，沿用同一渲染器已通过的完整 UI 旅程。新包 `/private/tmp/cmb-bot-current-bc0e2734/mac-arm64/CMBDevClaw.app` 打包 44.55 秒、真实桌面 56.19 秒通过，证据 `/tmp/cmb-native-visibility-native-quality-*` 与 `/tmp/cmb-native-visibility-native-package-quality-*`。

### 登录资料刷新与浏览器画面输入时序（2026-10-05，继续实施）

- 打包桌面复测再次遇到模型配置正在发布导致任务停止。随后独立复现：完全相同的登录资料重新保存，也会发出运行配置变更并使后台快照失效。保存前比较完整持久值，包含凭据及未知字段；键顺序或未落盘的 `undefined` 不构成变化。相同资料不改文件、不触发失效；凭据变化、退出、损坏文件修复仍发布通知，写入失败不报保存成功。新用例先 1 失败 / 1 通过，修复后 5 文件 / 19 项通过。没有把所有配置变更放行或放宽正在运行任务的撤销检查。
- 实际 React/Chrome 工作区通过延迟真实截图响应，复现新画面尚未解码时已有一次点击发往浏览器。现在点击、键盘、导航和标签页操作均需本次画面已加载；完整目标/代次/画面身份与可见状态继续校验。缓存中相同图像可直接确认，不重挂图片节点、不新增轮询；加载时保留画面尺寸并显示状态，失败可刷新。新用例先失败再通过。
- 接管专项及 20 次详情/电脑页切换通过：页面不可见、原生文档不可见、面板关闭后的读取计数均为 0，电脑组件维持单实例。两次主动 GC 之间 JS 堆约 20.57→20.77 MB，DOM 节点 1059→1069，监听器 486→482；这是该旅程测量，不是长期无泄漏证明。证据 `/tmp/cmb-viewer-frame-{red,green}.log`。固定 2712 份输入后的 ESLint、Node/Web 类型、8 文件 / 31 项、完整 UI 旅程（154.56 秒）、构建及 6 项原生 Host 检查通过，摘要未变化，见 `/tmp/cmb-identity-viewer-quality-*`。随后标准打包 43.62 秒通过，`/private/tmp/cmb-bot-current-jextqc6q/mac-arm64/CMBDevClaw.app` 的桌面旅程再次在原生窗口隐藏检查失败，未替代文首已验证包。
- 上一个包 `/private/tmp/cmb-bot-current-pwdl0qow/mac-arm64/CMBDevClaw.app` 已完成打包，但桌面首轮停在原生窗口隐藏后文档可见状态未改变；增加诊断后第二轮在命令任务遇到前述配置同步竞争。两轮均未全通过，不替代文首已验证包；窗口可见性问题仍待进一步核对，不能因为下一次局部通过就认定原因已消除。日志 `/tmp/cmb-compaction-package-final-quality-desktop.log`、`/tmp/cmb-compaction-desktop-diagnostic.log`。

### 长任务上下文整理进展（2026-10-05，继续实施）

- 对照 Cmb 共用执行图发现，Bot 已执行上下文摘要但未接入现有 `onContextCompaction` 通知。实际图新增暂停摘要用例，在旧实现中只能看到“正在思考下一步”；修复后显示“正在整理上下文”，摘要模型返回后显示“正在核对上下文摘要”，最终由原执行图继续检查预算和推进任务。摘要正文不进入进展记录。
- 回调复用原 `run.activity` 事件和界面，无新增轮询或定时器；取消及执行租约失效后不回写旧进展。实际图 8 项通过，包括压缩后证据读取、取消、检查点恢复和已完成修改不重放。首次类型门禁发现新增测试直接访问 `unknown` 类型的事件内容，改为结构化断言后 ESLint、Node 类型、专项、构建及 6 项原生 Host 通过；对应包的桌面失败见上节，见 `/tmp/cmb-compaction-progress-{red,owner}.log` 与 `/tmp/cmb-compaction-progress-final-*`。

### 任务恢复回执与命令路径边界（2026-10-04，继续实施）

- 再次用真实子进程复现了 macOS PATH 中根目录符号链接会意外放开目录外读取的问题。现在对工具查找目录做真实路径解析后再排除文件系统根；显式项目授权和后台目录拒绝规则保持原语义。源码 25 项命令检查、固定 2707 份输入的 ESLint、Node 类型、构建及 25 项编译原生命令检查通过，日志 `/tmp/cmb-shell-rootpath-{red,owner}.log`、`/tmp/cmb-shell-rootpath-quality-*`。文首安装包早于此修复。
- 恢复任务原先在后台提交成功、回执丢失后会因版本变化而无法确认。新增 SQLite 重开用例先复现 3 项失败，再复用现有持久回执事务保存人工核对、任务状态与原响应；重试只读原回执，不恢复后续再次中断的同一任务。恢复代次变化拒绝旧请求，改变原核对内容也拒绝复用身份；旧客户端无请求身份的调用保留原版本检查。初步领域与本地记录 35 项、实际 RPC 重连 1 项通过。
- 恢复窗口保留未确认的原始核对内容，重新打开后可继续确认同一请求；未确认期间禁用改写。使用共用选择器、分区滚动和固定底部操作。实际完整工作区旅程通过：首次发送前断线、关闭重开、后台已提交但丢回执、再次确认均为同一组核对内容和请求身份，数据库仅产生一次恢复记录。浅/深色及 580×620 窄屏截图已查看，操作栏保持可见，见 `output/bot-workspace/task-recovery-pending-{light,dark,narrow}.png`。
- 本轮首次固定 2711 份输入后，ESLint 与 Node 类型通过，Web 类型因 `node_modules/@types` 中 63 个带“ 2”后缀的不完整副本失败。将这些副本移入 `/var/folders/r4/m2gmdyyn06z9488ghc1044zh0000gn/T/cmb-type-duplicates-y_tffc4e` 并保留 manifest；原依赖和源码未改动，随后 Web 类型通过。首轮不记为通过，日志 `/tmp/cmb-recovery-quality-*`、`/tmp/cmb-recovery-retry-quality-*`，后续门禁继续执行。
- 关联 7 文件 / 114 项通过。两次 UI 失败均定位到新增夹具：事件查询默认只取最早一页；将相同 JSON 的属性顺序变化误判成不同请求。改为本轮游标查询及结构化内容比较，同时使用产品真实主题切换函数，再次固定输入后完整 UI 旅程、构建及 6 项原生 Host 检查通过（`/tmp/cmb-recovery-ui-quality-*`）。产品核对、事务及幂等判断未为此放宽。
- 后续打包被依赖目录中的异常副本阻塞。进程采样和文件访问记录定位到带数字后缀的重复目录；先将 753 个顶层/作用域副本移到 `output/dependency-duplicates-20261005-001628/`，原生依赖检查恢复正常，再定位并隔离 187 个具有正常同名目录的内部副本至 `output/nested-dependency-duplicates-20261005-002347/`。均保留完整目录与迁移清单，没有删除原依赖或跳过原生构建。被中止的 `/tmp/cmb-recovery-package-{retry,clean}-quality-package.log` 不作为打包通过证据，新包继续验收。

### 启动配置发布竞争（2026-10-04，继续实施）

- 新包桌面旅程发现：Host 已通过配置检查并认领任务后，桌面恰好开始发布配置，运行器首次读取快照会直接使任务失败。实际执行图加入确定性重现，发布/取消两种场景均先失败；修复后等待首次配置发布，未发送模型请求或执行工具，发布完成后只调用一次新模型。等待可取消，未知格式与存储错误不会被作为发布状态循环重试。
- 只在运行器的首次快照读取等待，现有模型重试、工具、插件的配置撤销检查仍立即拒绝旧配置。发布/取消、完成时插件配置检查及模型重试撤销共 5 项真实执行图检查通过；固定 2707 份输入后，关联 ESLint、Node 类型、6 文件 / 39 项配置专项、上述 5 项、构建、24 项编译原生命令及 6 项后台检查通过。没有将上节之后新增的缓存清理与本节修复冒充为重新完整跑过 `npm test`。日志 `/tmp/cmb-config-admission-{red,graph}.log`、`/tmp/cmb-config-admission-quality-*`。
- 最新测试包 `/private/tmp/cmb-bot-current-9mabrors/mac-arm64/CMBDevClaw.app` 标准依赖构建、临时签名和 **21 项真实桌面旅程通过**，源码摘要未变化，包含命令隔离、后台运行、浏览器接管、状态恢复及冷热启动消息导航。证据 `/tmp/cmb-config-admission-package-quality-{package,desktop}.log`。此前 `/private/tmp/cmb-bot-current-ays335y1/` 的超时为已复现的配置竞争，不记为通过，也未以单纯扩大等待时限修复。

### macOS 命令进程隔离与工作区兼容（2026-10-04，继续实施）

- 实际进程复现了旧执行器只约束工作目录、仍能通过间接脚本读取目录外文件的问题；使用临时假数据验证，没有读取真实凭据。现在 macOS 命令 worker 及其后代继承 Seatbelt 策略，项目/工具链可读、项目与独立临时目录可写，后台控制数据显式禁止读写，Unix 控制套接字禁止连接。沙箱初始化失败不退回普通进程；只读角色不能借间接脚本写项目。
- 复用 OpenAI Codex 固定提交 `afb436df8b70bb5bc57b86d9a3e829968988cd21` 的基础、平台与网络策略；保留 Apache 2.0 许可、NOTICE、来源和文件摘要，并将许可材料加入安装包。Grok 重建仓库只有原生 helper 接口，缺少该 helper 实现，未声称直接移植了缺失的二进制。
- 命令拥有独立临时主目录，避免 Git/npm 默认配置读取个人目录；持久成果与缓存仍应存项目，临时目录在 worker 退出后清理。按原工作区契约允许 Git 共享元数据写入，原项目工作文件不因此开放写权限。Hook 的脚本目录与实际项目目录分别处理；npm 的 PATH 元数据查询不会放开文件内容读取。IP 网络仍沿用已有命令审批，不声称已实现域名级网络代理隔离或通用桌面隔离。
- 审批卡与持久审批规则记录 `macos-seatbelt`，旧的普通执行授权不会自动匹配；模型接收项目/临时目录与权限失败处理说明。另修复电话脱敏规则误伤 UUID 导致并发模型调用无法关联的问题，只为经过严格 UUID 校验的任务身份字段保留原值；凭据字段与普通文本仍按原规则脱敏。
- 初次固定 2707 份输入的整仓回归主组 5598 项通过、1 项失败：独立工作区提交因 Git 元数据写入和个人 Git 配置读取被限制而失败。修复后实际提交/合并、10 文件 / 152 项专项、类型、构建、22 项原生命令及 6 项后台检查通过。完整 `npm test` 退出 0，主组 **683 文件 / 5599 项通过，14 文件 / 143 项跳过**，所有串联门禁通过，590 秒内输入摘要未变化。日志 `/tmp/cmb-mac-shell-final-*`、`/tmp/cmb-mac-shell-repair-*`。
- 临时签名测试包 `/private/tmp/cmb-bot-current-yk_naace/mac-arm64/CMBDevClaw.app` 的 **21 项实际桌面旅程通过**，包括真实审批后命令写项目而无法读取假后台控制文件；许可证已核对打入包中，审批卡截图已查看。首轮桌面测试的模型夹具复用了连续响应 ID，修正为每次响应独立 ID 后在同一包复跑通过；仅测试夹具变化。证据 `/tmp/cmb-mac-shell-package-desktop-retry.log`。
- 随后复现并修复了 Host 断开时只由父进程清理临时目录导致的遗留：命令 worker 自行等待后代停止并回收本次 HOME/缓存，未标记的系统 TMPDIR 不作为删除授权。前台/后台两种真实断连测试先失败后通过，24 项编译原生命令、6 项后台、Hook 与 Git 工作区检查通过（`/tmp/cmb-shell-scratch-*`）；包含本修复的新包在桌面检查中暴露了上节配置竞争，尚待修复后的包验收。未据此宣称同时 SIGKILL 全部进程或断电后的缓存回收已完成。
- 本节 OS 隔离仅在 macOS 原生进程验证。Windows 使用现有 Codex helper 的不同执行模式，禁止读取后台目录的能力仍需补齐并实机验证；Linux K8s 的进程隔离亦未据此完成。

### 并发模型请求诊断（2026-10-04，继续实施）

- 复用已有模型用量调用 ID 与 Cmb 日志格式，在主任务/工作流/协作模型及自动记忆调用中记录开始、HTTP 接收/拒绝、传输失败和流结束。每条元数据明确 Bot、任务、根任务和调用 ID；自动记忆没有伪造任务归属。采用请求内显式身份，不给共享模型/连接器对象套用首个创建者的全局异步身份。
- 只记录协议状态、耗时、字节数、供应商已报告 token 和受限格式的请求标识。新诊断不记录 URL、请求头、提示词、响应正文或原始异常文本。流被中断时不生成正常结束记录，HTTP 拒绝不表示已得到零费用回执；日志写入失败不改变响应交付或额度结算。
- 4 文件 / 24 项专项通过，覆盖交错返回的归属、实际持久调用 ID、自动记忆阶段、HTTP 拒绝、传输中断、日志故障及原脱敏/轮转。固定 2700 份输入后，相关 ESLint、Node 类型、上述专项、2 项真实执行图、构建及 6 项编译 Host 检查通过（`/tmp/cmb-model-trace-quality-*`）。下节最新测试包早于本诊断修改；本节没有重复跑整仓或打包验收，也不将模型诊断归因等同于全系统 OTel/跨进程追踪已完成。

### 用户与 Bot 输出额度（2026-10-04，继续实施）

- 对应 ADM-20 的本机模型/任务/Bot/用户用量与运行中预算。复用 Cmb 模型诊断、原任务/工作流预留账本和 Host 收据，在同一事务内检查并预留用户及执行 Bot 的过去 24 小时输出额度；实际 HTTP 请求的输出上限取各层剩余额度的最小值。主任务、子任务、协作和自动记忆计入各自模型与执行 Bot，不把缺失回执记为零。
- 用户/Bot 两层默认不设上限；原任务总额度继续生效。配置从下一次模型请求生效，已发出请求不因调低额度而取消。额度耗尽的任务明确失败，用户调整后可重新发起；自动记忆保留依据、延后重试，不消耗普通失败次数。修复 SDK 将本地额度错误包装成连接错误的问题，保留准确的暂停原因。
- v43→v44 迁移前备份，保留已有调用与未知预留。设置按范围、修订号和恢复代次校验，重放原 nonce 只返回原收据，不覆盖随后修改的额度。该额度依赖当前本机账本；恢复旧备份后以备份保留的数据为准，不代表供应商费用、不可篡改计费或已恢复真实的外部消费额度。
- 工作区菜单与命令搜索提供“用量与额度”：显示各模型调用、已报告输出、待确认预留与范围剩余额度。保存结果未知时保留原操作，重新打开后可确认；并发修改明确冲突。面板不可见时停止轮询，窄窗口只滚动明细，保留标题、范围和关闭入口。修复 Bot 深色主题下单色开关滑块对比度。实际浅/深/窄屏截图已查看，见 `output/bot-budget/`。
- 固定 **2698** 份源码/测试/配置：局部 ESLint、Node/Web 类型、8 文件 / 192 项专项、实际模型图额度拦截、用量 UI、完整工作区 UI、构建、5 项原生 Host 门禁均通过。编译 Host 新增额度专项通过：强制结束后保留用户/Bot 额度与未知预留，超额时不发送 HTTP，提高额度后新任务使用剩余额度。完整 `npm test` 退出 0，主组 **681 文件 / 5588 项通过，14 文件 / 143 项跳过**，所有后续标准串联门禁通过，输入摘要未变化；证据 `/tmp/cmb-budget-quality-*`。
- 随后仅调整保存提示的展示位置，并将额度图测试及编译 Host 恢复用例纳入现有三平台 CI。固定新摘要后，相关 ESLint、Web 类型、用量实际 UI、构建和扩大后的 **6 项原生 Host 检查**通过（`/tmp/cmb-budget-final-*`）。主执行代码与上述整仓基线相同；没有把前一次全量结果描述为后一次源码的重新全量运行。
- 新包 `/private/tmp/cmb-bot-current-3pwqwt2m/mac-arm64/CMBDevClaw.app` 已包含本节额度与 UI 修改，标准原生依赖构建/临时签名后，**20 项真实桌面旅程通过**，源码摘要未变化（`/tmp/cmb-budget-package-quality-{package,desktop}.log`）。真实供应商、Windows、Linux K8s、正式签名公证及完整核心功能仍待验收，不以本节测试数换算总完成率。

### 模型用量归因与本轮整仓基线（2026-10-04）

- 将主任务、摘要、工作流子任务、协作 Bot、自动审核及插件/技能辅助调用接入同一持久用量明细，沿用原有输出额度预留；记录调用时的模型身份，重命名和修改配置不改写历史。自动记忆提炼与核验单独归因，在记忆面板展示近 30 天调用。没有把跨任务整理强行归入某一个已完成任务。
- 复用 Cmb 有界流式响应诊断，读取供应商明确报告的输入、输出、缓存和推理 token，累计事件不重复相加。发送前记录调用，完整回执只结算一次；断流、崩溃或缺失回执保留未知，不把输出预留当成实际费用。任务记录展示具体模型及调用次数；记忆页区分提炼与核验。明细最多 100 个模型/用途分组，超出分组仍计入总数；数据库增加任务索引及只覆盖后台整理的部分索引。
- v42→v43 升级前保存 SQLite 备份，保留原任务额度，不给旧调用编造用量。初轮相关 9 文件 / 145 项通过；补充迁移和页面后固定 2691 份输入，局部 ESLint、Node/Web 类型、7 文件 / 86 项专项、实际记忆/工作区 UI、构建和 5 项编译 Host 门禁通过（`/tmp/cmb-usage-quality-*`）。已查看记忆浅/深色、任务记录截图：`output/bot-memory/memory-usage-{light,dark}.png`、`output/bot-workspace/task-model-usage.png`。
- 同一固定输入的完整 `npm test` 退出 0：主组 **679 文件 / 5566 项通过，14 文件 / 142 项跳过**；adoption、消息、Hooks、插件、任务卡、合并、工作流、桌面基线和 IM 后续门禁全部通过，源码摘要未变化。编译 Host 记忆 SIGKILL 恢复专项随后通过：1 项通过、58 项未选中，任务没有重放，缺失供应商用量的记录保持未知，再次重启保持同一统计（`/tmp/cmb-usage-memory-native.log`）。
- 这是已记录调用的模型用量，不是完整账单；模型连通性诊断、用户级月度预算及供应商费用核算不在本节范围。模型和企业服务使用本地夹具；Windows、Linux K8s、真实模型、正式签名及完整核心对齐仍未验收。该整仓基线早于下节通信队列修改，当前未重新打包。

### 桌面与后台的并发请求限流（2026-10-04，继续实施）

- 真实 Socket + Host + SQLite 复现：客户端同时发送 17 条需要异步目录查询的消息，超过后台每连接 8 个在途请求后，连接被关闭，已接收操作的回执丢失（`/tmp/cmb-transport-burst-red.log`）。
- 沿用原认证与帧协议，在客户端采用有界 FIFO：在途最多 8 个，等待最多 32 个 / 16 MiB，同时遵守 Socket 写入背压。排队时一次性固定请求身份及正文，发送前等待超时明确报告本次未发出；已经发送但超时的请求仍按结果未知处理。断线清理全部定时器和排队内容，不自动把旧操作搬到新连接。
- 修复后真实连接的 17 条消息全部保存，重试原 nonce 没有增加任务。新增容量、字节、背压、排队超时、响应超时、写入失败和旧连接迟到事件检查；连同 RPC、桌面客户端和升级检查 **4 文件 / 65 项通过**（`/tmp/cmb-transport-owner-final.log`）。首轮新增测试的并发计数遗漏提前返回的乱序响应，修正测试计数后通过；未放宽并发上限。固定 2691 份输入后，局部 ESLint、Node 类型、上述 65 项、真实 Electron 隔离桥、构建及 5 项原生 Host 门禁通过（`/tmp/cmb-transport-quality-*`）。
- 打包首轮停在依赖扫描，终止后保留失败日志；第二轮开启诊断，采样显示时间消耗在本机文件系统 `access` 检查，最终正常完成依赖检查与临时签名，没有跳过原生依赖构建。新包 `/private/tmp/cmb-bot-current-rp0q3ca1/mac-arm64/CMBDevClaw.app` 的 **20 项真实桌面旅程通过**，源码摘要未变化（`/tmp/cmb-transport-package-quality-{package,desktop}.log`、`output/bot-desktop/checks.json`）。已查看实际浏览器预览与接管截图。包含本页正文引用、记忆分批/重试/用量及并发队列改动；macOS arm64 临时签名，未公证，外部模型和企业身份仍为本地夹具。Windows、Linux K8s 和全部核心功能尚未据此记为通过。

### 正文引用的持久化与历史交互（2026-10-04，继续实施）

- 沿用已适配的 Grok/Tiptap 输入序列化，以同一份纯文本生成 UTF-16 引用位置；新增正文中的 Bot、群聊、例程、连接器、技能及群聊接收者展示。旧消息沿用原显示，未知或损坏的展示元数据回退纯文本；没有从名称推测历史身份。
- Host 校验有界、有序、不重叠的位置及发送时已选对象和名称，禁止以引用添加权限、隐式运行例程或改变接收者。消息、引用位置和原 nonce 收据在同一事务保存，重启、改名和回执丢失后仍对应原对象；分支与当前任务补充沿用同一条发送链。v41→v42 升级前保存 SQLite 备份，不给旧消息编造位置。
- 历史引用可键盘跳转到仍可访问的私聊/群聊；无目标时保留标签。正文已有的引用不在消息上方重复展示，外部选择的接收者仍保留独立标签。已查看浅/深色截图 `output/bot-workspace/inline-message-{light,dark}.png`，实际跳转后返回保留草稿；同一行的引用基线与原始正文分别验证。
- 6 文件 / 42 项专项通过（`/tmp/cmb-inline-owner.log`），局部 ESLint、Node/Web 类型、标准消息门禁、迁移专项及实际 Chromium 编辑旅程通过（`/tmp/cmb-inline-quality-*`）。完整工作区首轮检查只扫描最早 1000 条事件而漏掉本轮记录，改为从本轮开始游标检查；第二轮 `innerText` 为 inline-flex 标签插入换行，改为原始 `textContent` 核验并单独校验可见布局。未据此修改产品调度或放宽产品超时。
- 固定 2687 份输入后，完整 React + SQLite/Host 工作区旅程和构建通过，资源清理结束、摘要未变化（`/tmp/cmb-inline-final-*`）。输入/收据模型为本地夹具；尚未据此认定真实外部模型、Windows 实机、Linux K8s 或全部核心对齐已验收。最新编译 Host 的 5 项原生门禁通过（`/tmp/cmb-inline-native.log`），源码摘要未变化；包含代理、SIGKILL 模型绑定、客户端断开与并发启动。当前未重新打包。

### 自动记忆分批与失败重试（2026-10-04，继续实施）

- 核对发现自动整理未采用用户所选模型的上下文预算，最多 12 条证据与已有记忆可能超过请求容量。现复用 Cmb 输入/输出预留规则，以 UTF-8 字节数设置保守的本地输入上限；它不等于供应商精确 token 计费，也可能早于供应商实际上限拒绝请求。不下载模型词表，不默默删除当前快照中的记忆；按时间顺序选取能容纳的完整证据，其余持久队列项不增加尝试次数。
- 提炼与独立核验均检查请求大小。单项过大或核验内容超限时保留原记忆及失败证据，显示上下文原因，停止对同一内容的自动超限重试。修正模型后可从记忆面板重新整理；保留原三次普通失败退避，重试队列仍最多 64 项。
- 新增窄域 `retryMemory`，贯通 Host RPC、主进程、preload 和页面，复用原事务/nonce 收据；按 Bot、策略版本和恢复数据代次核对。关闭重开或回执丢失后核对原请求，已完成的整理不重复运行。手工修订、删除和关闭整理同时作废旧失败证据；历史版本遗留的失败记录再次重试也受原始消息屏障限制。
- 队列上限补充用例后记忆合成专项 24 项通过（`/tmp/cmb-memory-retry-cap.log`），实际记忆页重试及浅/深色截图复验通过（`/tmp/cmb-memory-retry-final-ui.log`）。此前专项 7 文件 / 160 项通过（`/tmp/cmb-memory-retry-owner.log`）。包括真实 HTTP/SSE 模型协议、12 批跨重启处理、中文长内容、独立核验超限、更换大上下文后恢复、重复收据、人工修订屏障、认证 RPC 和 IPC 主窗口限制。固定 2682 份输入后，局部 ESLint、Node/Web 类型、实际 React/Chrome 记忆流程、真实 Electron 隔离桥和构建通过（`/tmp/cmb-memory-retry-quality-*`），原记忆/共享技能流程保留。
- 最新编译 Host 的 SIGKILL 恢复专项 1 项通过，恢复自动整理且用户任务不重放（`/tmp/cmb-memory-retry-native.log`）；其余 58 项本轮未选中，输入摘要未变化。已查看记忆页截图；本节尚未重新打包，文首 rich 测试包不含本节。实际模型服务均为本地夹具，Windows、Linux K8s 和真实模型效果未据此记为通过。辅助模型调用的完整用量归因仍需接入，不将输入大小限制写成费用预算已完善。

### 自动记忆整理的休眠与时间变化保护（2026-10-04，继续实施）

- 核对发现主任务已有 `BotClockFence`，自动记忆整理只检查配置与记忆版本。若整理或独立审核期间系统时间跳变、监督间隔丢失，旧请求仍能按原日期写入长期记忆。新增可控时钟/真实 SQLite 回归，先复现前跳、回拨及长时间失去监督 3 项失败（`/tmp/cmb-memory-clock-red.log`）。
- 复用既有时钟保护，每次整理建立独立基准，后台心跳与模型连接、提议、核验、提交边界共同检查；失效后取消本次请求，保留原有记忆和证据，按原退避规则重试。下一次整理重新取日期与基准，同一次旧应答不能恢复写入资格；未新增第二套任务队列或时钟规则。
- 修复后记忆整理、实际配置模型协议及时钟保护共 3 文件 25 项通过（`/tmp/cmb-memory-clock-green.log`），包含中断后同一服务恢复并提交、显式记忆保留和证据不丢。时间变化通过受控时钟模拟，不将其写成 macOS/Windows 实际休眠验收。上述 3 组回归已加入平台 CI 清单，未运行远端 CI；文中的 rich 测试包早于本节改动。
- 固定输入后的局部 ESLint、Node 类型和构建通过（`/tmp/cmb-memory-clock-quality-*`）；最新编译 Host 的真实 SIGKILL 恢复专项通过，持久证据恢复整理且不重放用户任务（`/tmp/cmb-memory-clock-native.log`，1 项通过，其余 58 项本轮未运行）。

### 本轮固定源码验收（2026-10-04）

- 固定 2678 份源码/测试/配置后，相关 ESLint、Node/Web 类型、标准消息门禁、实际 Chromium 编辑流程和构建通过；输入摘要未变化（`/tmp/cmb-composer-quality-{status,inputs}.json`）。首轮类型检查指出测试夹具把 EventEmitter 的检查方法声明在 Playwright Page 上，已分开夹具事件对象与产品 Page 类型后通过。
- 原生编译 Host 的 5 项门禁通过，包含代理模型流、SIGKILL 后模型绑定、无客户端执行和启动竞争（`/tmp/cmb-composer-package-quality-native-host.log`）。随后临时签名包 20 项桌面旅程通过；打包日志发现 Tiptap React 的两个可选间接依赖解析为 3.31.4，与固定的核心 3.14.0 不匹配。
- 将这两个配套扩展也显式固定为 3.14.0，保留其余依赖版本。`npm ls` 通过；再次固定源码，Web 类型、编辑器浏览器回归、构建通过（`/tmp/cmb-composer-final-quality-*`）。新包 `/private/tmp/cmb-bot-rich-ex35sqns/mac-arm64/CMBDevClaw.app` 打包和 20 项真实桌面旅程通过，未再出现依赖冲突（`/tmp/cmb-composer-final-package-quality-{package,desktop}.log`、`output/bot-desktop/checks.json`）；已查看电脑预览及行内引用截图。
- 新包包含草稿回执、富文本编辑器及下载连接生命周期修复。它是 macOS arm64 临时签名验收包，未公证；模型仍为本地 SSE 测试夹具。没有将本轮专项当作整仓 5502 项重新执行，Windows、Linux K8s、真实模型与全量核心对照尚未验收。

### 富文本输入与草稿一致性（2026-10-04，继续实施）

- 读取 Grok 原 `rich-text-editor.tsx`，沿用同版本 Tiptap 3.14.0、段落/换行/链接序列化、原子引用、Backspace 回退搜索及 macOS 行内快捷键语义，适配现有 Cmb 草稿和 Host 引用契约。Bot、群聊、例程、连接器、技能与群聊接收者进入输入正文；来源与文件摘要已记录在 renderer `upstream/PROVENANCE.json`。
- 引用以类型和稳定 ID 保存，名称不作授权；复制粘贴只接受限定结构与链接协议。文字上限 64000 字符，最多 16000 文档节点、64 个可见引用节点，同时保留既有 6 个技能、12 个实体和 6 个接收者限额。普通粘贴、引用插入/删除分别建立撤销边界；切换会话、已确认发送及外部草稿替换重置历史，撤销不能恢复已发送旧任务。
- 群聊单个接收者与“全体 Bot”在同一次编辑事务中替换，撤销同步恢复路由；IME 组合输入不触发发送。例程“对话调整”保留既有引用及技能，弹窗关闭后仅恢复仍属于该会话/版本的编辑焦点。修复编辑器延迟挂载时分支焦点丢失，以及旧 textarea 光标接口不适用于富文本的问题。
- 草稿/引用/回复/分支等 5 文件 46 项通过（`/tmp/cmb-rich-editor-state.log`）；实际 Chromium 编辑、复制粘贴、撤销、接收者切换、IME、回执丢失及新草稿归属验证通过（`/tmp/cmb-rich-composer-ui8.log`）。完整真实 React + Host 工作区和资源清理通过（`/tmp/cmb-rich-workspace-ui8.log`），覆盖插件、例程、示范、审批、群聊和分支。首轮页面测试暴露段落断言和原 textarea 测试接口已不适用；同时修复实际粘贴撤销合并、分支焦点、例程追加文本丢失结构等问题，未用删除业务断言替代修复。
- 原 `.fill("")` 自动化失败经过最小复现，不能当作用户键盘清空故障；改用实际全选/Backspace 路径验证。聊天历史目前仍为正文与已有结构化引用展示，未宣称历史消息内每个引用位置均已按原版复现。新依赖、Node/Web 类型、消息门禁、构建及最终包验收另记下文；整仓 5502 项是本次改动前的基线。

### 浏览器下载恢复与关闭清理（2026-10-04，继续实施）

- 复现初始化失败的 Promise 被永久复用，后续重试无法恢复；修复为同一轮调用共享初始化，失败完成清理后允许重新连接。关闭发生在连接或下载配置期间时，迟到结果不得重新启用服务；只删除本次专用暂存目录，清理失败保留明确错误。
- 继续复现关闭时的页面连接竞态与监听器残留。所有页面连接在每个异步边界复核关闭状态，关闭等待未完成连接与分离操作结束；精确移除本页面的帧、目标和监听器，重复关闭共用同一清理 Promise。未扩大下载权限，原 25 MiB、全局 8 个/每归属 4 个并发及超时限制不变。
- 初始化 4 项及页面生命周期 2 项均先在旧代码失败（`/tmp/cmb-download-lifecycle-red.log`、`/tmp/cmb-download-page-lifecycle-red.log`）。修复后真实 Chrome、文件归属、POST/blob/子框架/弹窗下载、人工接管取消、发布恢复等 4 文件 25 项通过（`/tmp/cmb-download-lifecycle-final.log`）。新真实 CDP 用例首轮因 HTML 夹具未声明 UTF-8 导致中文链接无法定位；修正编码并使用与产品一致的持久浏览器上下文后通过，未放宽产品限时或关闭 Chromium 沙箱。
- 这是初始化和关闭恢复，不包含浏览器崩溃后的网络字节续传。新的纯状态回归已加入三平台 CI 清单；尚未在远端 CI 或 Windows 实机执行。

### 消息回执与新草稿隔离（2026-10-04，继续实施）

- 复现旧回执误清理：上一条消息结果未知，用户已填写新任务并沿用同一技能、附件或回复对象；重试成功后旧代码会删除这些新草稿内容。独立复现为 2 项失败（`/tmp/cmb-draft-receipt-red.log`）。
- 沿用现有 Zustand 草稿及持久 nonce，每次编辑增加本地草稿版本，发送时固定版本并保存到本地重试记录；版本不会传给 Host。回执只清理它所拥有的未修改草稿，收据与输入一次性更新。即使用户改回相同文字，也不由旧回执清空；技能、附件、引用、接收者、回复和富文本保持同一草稿生命周期。
- 刷新后仍按原 nonce 重试；已知的执行前拒绝释放旧重试状态。清理持久状态时核对 nonce/草稿版本，避免覆盖已经观察到的另一窗口新记录；旧格式无版本记录按完整内容兼容核对。没有把 localStorage 多窗口读写宣称为跨窗口原子事务。
- 修复后草稿/引用/回复/分支 4 文件、32 项通过；局部 ESLint 和 Web 类型通过（`/tmp/cmb-draft-receipt-{owner,lint,web}.log`）。真实 React 页面增加后台已提交、回执丢失、新任务继续输入、重试仅恢复原回执的旅程，完整页面和资源清理已通过（`/tmp/cmb-draft-receipt-ui2.log`），已查看 `output/bot-workspace/send-retry-draft.png`；最终局部 lint、Web 类型和构建通过（`/tmp/cmb-draft-receipt-{lint2,web2,build}.log`）。首轮页面验证发现引用选择后的延迟光标恢复可能覆盖下一次输入，补入会话/草稿版本/文本一致性检查后通过。此处未重跑整个后端主组，文首整仓记录是本次 renderer 改动前的基线。

### 项目扫描取消与有界并发（2026-10-04，继续实施）

- 冻结 2670 份输入后，lint、Node/Web 类型通过；整仓主组收齐为 665 文件 / 5480 项通过、5 文件 / 9 项失败、14 文件 / 141 项跳过，输入摘要无变化（`/tmp/cmb-global-final-quality-*`）。后续串联门禁未在该轮运行。失败涉及项目扫描、数据库/录像字节比较、子任务审核等待，以及主执行器 5 项，不能记为整仓全绿。
- 项目内容搜索原来在路径筛选及稳定读取前重复串行校验。保留所有路径/根目录替换/链接边界，目录校验及内容读取分别限制为每批最多 4 个；读取前按最坏情况预留容量，仍最多 1000 个文件、单文件 2 MiB、合计 16 MiB、200 个匹配/24000 字符。结果按候选顺序处理；返回或取消前等待当前批次结束，不留下后台读取。移除稳定读取入口前紧邻的重复校验，不缓存文件授权。
- 复用的工作流 glob 增加取消检查入口，Bot 原生工具、工作流文件端口和插件 SDK 均接入。内容搜索的 10 秒预算覆盖目录发现阶段；耗尽预算返回明确的部分扫描状态，不把未扫描解释为无结果。新增并发上限、容量预留、乱序完成、取消排空和目录发现超时的回归。
- 同机局部基线的千文件场景 727ms，改动后 365ms；这是该次实测，不是通用性能承诺。搜索/项目文件、浏览器恢复、录像、工作流文件和完整子任务图合计 6 文件 / 74 项通过（`/tmp/cmb-search-repairs-owner.log`）。数据库和录像夹具用 `Buffer.equals` 保留完整字节比较，避免对数十万个数组元素递归断言。子任务审核等审批改为在原 20 秒用例预算内最多等 10 秒，修正默认 1 秒提前清理，未更改产品限制或授权断言。
- macOS 电源日志确认 15:13:32–15:15:44 合盖休眠 132 秒，对应技能试跑 135 秒超时。主执行器 5 个失败场景及相邻用例原样重跑 11 项通过（`/tmp/cmb-global-five-runtime-recheck.log`）；其余整轮超时及 `MODS_RUNTIME_LOST` 原因尚未确认，局部通过不能代替根因结论。新增真实 v1/v2 子进程在父进程阻塞 2.4 秒后的存活检查均通过，未复现心跳误杀，没有据此修改监控逻辑（`/tmp/cmb-mod-heartbeat-stall-red.log` 名为调查日志，实际为 2 项通过）。
- 新冻结轮次 `/tmp/cmb-search-quality-*` 的实际工具图、原生插件进程、lint/Node 类型、标准串联门禁与构建均通过；其后在同一 2671 份输入上运行完整主测试，672 文件 / 5502 项通过、141 项跳过，摘要无变化（`/tmp/cmb-search-postrepair-full.log`）。原生 Host 5 项、实际桌面 20 项通过，新包见文首。本轮无失败，不据此将前轮未复现故障的根因写成已确定。

### 分类对象引用（2026-10-04，继续实施）

- 对照 MSG-09 发现原输入框仅有群内接收者选择。新增 Bot、群聊、例程、连接器四类引用，沿用现有 Grok 候选筛选、键盘操作与草稿组件；新增分类筛选和有界、延迟查询，关闭候选或切换对话后丢弃迟到结果。
- 发送只接受类型与稳定 ID，Host 校验对象存在并保存当时名称；v41 为消息新增独立引用表。历史改名不改写消息，重启、断线重试保留原收据；失效对象可移除重选，恢复数据代次变化时不重发旧引用。
- 引用元数据进入私聊、群聊及当前任务补充的准备链，不自动复制其他 Bot 的私聊、例程正文或凭据，不增加成员、不执行例程、不增加连接器授权。群内 Bot 选择继续使用原接收者路由。IPC、preload、Host RPC 和前端一并接入。
- 初次领域/迁移/准备链 6 文件 66 项通过（`/tmp/cmb-entity-integration.log`）；补充真实认证通信、IPC 拒绝、草稿重试后 4 文件 130 项通过（`/tmp/cmb-entity-owner-final2.log`）。Node/Web 类型先通过（`/tmp/cmb-entity-types.log`）；最终冻结 2667 份输入的 lint、Node/Web 类型、真实 React 工作区全旅程（含三类新增引用选择、发送与无隐式例程运行）、构建均通过；全量主组 667 文件/5452 项通过、2 项失败、141 项跳过，冻结输入未变化（`/tmp/cmb-entity-quality2-*`）。失败为备份链接数据库测试 5 秒超时及五万目录排序事件循环间隔 35.85ms 超过原 30ms 门槛；后续串联未执行。尚未打入文首 Mac 包。引用草稿截图 `output/bot-workspace/entity-reference-draft.png` 已查看。官方 0.66 客户端现场核对：原版引用作为编辑器内的原子节点，当前适配仍用输入区引用标签，富文本原子引用交互继续对齐。

- 后续补齐：旧消息的回复预览携带当时保存的引用身份；模型上下文明确将它作为历史资料。消息搜索可按当时引用名称定位，保持对话范围、删除过滤和分页字节预算；不读取被引用对象的私有正文。已成功发送的连接器引用重试先复核原回执，即使实时连接器目录不可用也不会误报失败或再次派发。领域/真实认证 RPC/回复/搜索/草稿共 6 文件 49 项通过（`/tmp/cmb-entity-history-owner.log`），包含改名、重启、历史超出当前页、伪造和冲突请求。实际执行图 3 项通过、233 项未选中（`/tmp/cmb-entity-history-graph.log`）；完整 React 工作区 36 项检查通过，Node/Web 类型和相关 lint 通过（`/tmp/cmb-entity-final-quality-{ui,types,lint}.log`）。第一次界面旅程等待录制中的瞬时文案失败，实屏已正确进入密码页自动暂停；夹具改为在普通页面验证手动暂停/恢复，在密码页验证稳定的自动暂停及零关键帧，未更改保护逻辑。后续构建和新包仍待完成。

- 2026-10-04 再次在官方客户端空草稿中核对：输入 `@` 显示 Bot 和连接器候选，选择后显示编辑器内带头像的整体引用；移除尾部空格再退格会将引用还原为 `@` 并重开候选。本次未发送消息，临时草稿已清空。已定位用户提供的 `rich-text-editor.tsx`（Tiptap 3.14.0）的节点、序列化、IME、撤销、作用域及发送后清空逻辑；当前产品仍未接入这些编辑器交互，不能将已有引用元数据等同于原版富输入体验。



### 全局工作规则与插件进程生命周期（2026-10-04，继续实施）

- Bot 已接入桌面现有全局 AGENTS 配置目录，复用 `discoverGlobalAgentsFiles/readAgentsFiles` 的 override 优先级、回退和链接边界；独立 Host 没有显式来源时不会擅自读取宿主用户目录。全局与项目规则合计沿用 32 KiB 提示预算，完整规则最多读取 1 MiB；剩余内容通过限定版本的只读工具分页提供，不向模型开放宿主文件路径。一个执行实例只保留一个内容版本，磁盘中途变化不会拼接新旧内容；恢复后仍按现有项目规则语义重新准备上下文，不宣称跨重启锁定同一规则版本。
- 只读、无 Shell 和禁止项目读取的子任务继续只接收其角色允许的上下文。规则正文不授予文件、工具或审批权限；配置来源变更仍进入执行授权摘要。已完成任务的收尾回执和直接插件命令不额外启动全局规则读取。
- 读取、分页、Unicode、大小预算、配置发布、项目父目录及链接边界 3 文件 / 27 项通过（`/tmp/cmb-global-instructions-owner.log`）。实际图验证无项目/有项目的长规则续读、四种子任务角色和配置来源变更，共 7 项通过（`/tmp/cmb-global-instructions-graph2.log`）。首轮两项图测试因夹具把结构化 system content 直接转成字符串失败，修正为读取真实内容，并将断言移出 HTTP 回调以避免未处理拒绝；产品权限与限制未放宽。
- v1 Mods 客户端原先会用旧子进程迟到的 `error` 停掉替换后的新进程；已采用 v2 的进程身份检查。异步 Host 回调在实际调用和返回结果前再次核对当前进程、请求与取消状态，结束/取消后不启动排队操作、不回送迟到结果。已经开始的外部操作不宣称可撤销，也不自动重试。
- 新增边界复现原实现 4 项失败，修复后含真实 Node 子进程 14 项通过（`/tmp/cmb-mod-lifecycle-{red,green}.log`）；补入并发调用期间的迟到回复用例后，完整 Mods 相关 73 文件 / 565 项通过、1 项条件跳过（`/tmp/cmb-mod-lifecycle-owner.log`）。新增回归已列入原三平台 CI，尚未执行远端 CI。
- 本节前的冻结主执行器回归为 219 项通过、1 项失败、19 项条件跳过（`/tmp/cmb-runtime-final-quality-agent-runtime.log`）；失败是 MCP 插件目录查询在 15 秒等待内未结束。原样单独复跑及相邻并发/取消/配置撤回 4 项通过，但整轮超时原因仍未确认；补入失败现场诊断，保留原等待限制，不将局部通过记作整仓通过。后续类型、整仓、构建与新包待新冻结轮次完成。

### 本轮整仓检查与任务准备链复核（2026-10-04，继续实施）

- `/tmp/cmb-repeat-final-quality-*` 的 lint、Node 类型通过；整仓遇错停止于 20 个真实仓库并发安装 Git Hook 的 20 秒超时，源码摘要未变化。单独原样复验通过，但安装本身耗时 11.42 秒。源码每次上下文分别查询三个 Hook 路径，安装后状态复查再查询一次；合并为 Git 解析一次 Hook 目录，将每个仓库的 Git 查询从 10 次降至 6 次，仍重新读取安装后的状态，不缓存外部 `core.hooksPath`。
- 实际 Git 验证普通仓库、关联 worktree、内部自定义目录、相对/绝对外部 Hook 路径，以及从子目录安装；外部 Hook 内容未改写。全部 37 项通过，并发安装本次 6.09 秒（`/tmp/cmb-hook-path-optimized.log`）。两次耗时受当时机器负载影响，不作为通用性能比例承诺。
- 下一轮 `/tmp/cmb-hook-final-quality-*` lint、Node 类型通过，整仓遇错停止在插件子任务用例的 5 秒内部等待，模型请求尚未到达。改为由真实嵌套请求通知测试已到达并发边界，保持整个用例原 30 秒上限；失败清理先取消并等待所有子任务退出，再关闭数据库和删除 worker 文件。调整后的子任务实际图 34 项全部通过（`/tmp/cmb-child-lifecycle-drain.log`），包括插件并发、受限角色、隔离工作区、后台任务及取消清理。两轮整仓均未完成整个测试链和构建，不能记为全绿。新的 `/tmp/cmb-runtime-final-quality-*` 先单独执行完整主执行器用例，再执行其余主组和串联门禁；使用同一份冻结输入并避免重复执行主执行器文件。
- `standard-thread-turn` 对照已确认 Bot 使用共用输入准备、Host 解析的技能身份、持久租约、技能/提交 Hook、固定模型及共用执行图；只读和禁止读取的子任务仍不自动注入项目规则。**新确认缺口：普通 Cmb runtime 会加载全局 AGENTS.md，当前 Bot 的 `botProjectContext` 只加载授权项目根目录。** 后续补齐需要沿用共用有界读取、明确全局配置来源与截断后读取方式，并保持子任务权限；本轮尚未接入，不把标准准备链标成完成。
- 官方客户端现场再次核对例程详情：暂停状态显示独立状态与恢复入口，编辑将指定例程预填至聊天；本次仅查看和清除由编辑入口产生的临时草稿，未启用或执行例程。已有 Bot 例程版本与运行回执验证仍按对应记录，不能用菜单查看代替执行验收。

### 同一任务中的重复验证命令（2026-10-04，继续实施）

- 实际源码复核发现，`beginEffect` 按整项动作摘要禁止同任务再次执行，导致用户重新批准后仍无法进行“运行测试—修改代码—再次运行测试”。新增 SQLite 重开用例与真实模型图/文件/命令用例均在原实现失败；执行未结束、失败、未知及旧版无审批关联四种反例保持通过（`/tmp/cmb-repeated-command-red.log`）。
- 改为单次审批只可用于一个执行记录。新的有效审批可以允许再次执行已明确完成的同一动作；旧调用身份仍由输入收据去重。未结束、失败、未知和无法证明审批使用情况的旧记录继续拒绝；增加审批关联查询索引，不改变 v41 数据格式。
- 领域与实际“测试—修改—再测试”链路共 8 项通过、295 项未选中（`/tmp/cmb-repeated-command-green.log`）；前后确实读取了不同文件内容，产生三个不同审批及三份完成记录。随后将脚本加强为修改前退出码 1、修改后 0，真实图再次通过（`/tmp/cmb-repeat-exit-code-graph.log`）。审批规则、旧数据迁移、历史和全部工作流子任务 5 文件/111 项通过（`/tmp/cmb-repeat-approval-integration.log`）。新冻结整仓未完成，后续失败与修正见本页本轮检查记录（`/tmp/cmb-repeat-final-quality-*`）。
- 新一轮整仓遇错停止在子任务插件启动用例：原 `vi.waitFor` 默认 1 秒无法覆盖真实插件进程的启动。已在原 25 秒集成用例总预算内显式给审批出现最多 10 秒等待，产品超时与执行断言未调整；该用例随后通过。前一轮整仓不是全流程通过（`/tmp/cmb-runtime-closure-quality-primary.log`）。

### 消息读取、工具回执与浏览器沙箱（2026-10-04，继续实施）

- `read_message` 补回持久消息中的对象引用，保持原名称/ID、原对话与分支读取限制、正文分页；模型读取引用消息尾部时不再丢失被引用对象。
- 图的租约校验层在执行工具及读取完成回执前，用现有事务收据绑定调用身份、工具名和原始参数摘要。模型再次使用同一调用 ID 但改变参数时拒绝，避免把另一个点击/下载的旧成功结果返回为本次结果；同参数正常恢复仍复用回执，不打开已经关闭的浏览器。这里只新增输入摘要，未新增授权或第二套执行账本；旧版本已有回执保留兼容，新绑定从本版本实际接收调用时建立。
- 实际 Playwright 启动显式开启 Chromium 进程沙箱，启动失败不降级重试。浏览器动作集成夹具改用产品 Provider；真实 Chrome 的进程命令行检查没有 `--no-sandbox`，并通过同 URL 多 Bot 隔离、共享登录、接管、POST/blob/iframe 下载、密码框与重建恢复，共 12 项（`/tmp/cmb-bot-browser-sandbox-real.log`）。这不代表 Shell 或整个本机 Host 已获得 OS 沙箱，也不代表 Windows/Linux 实机验收。
- 新增回归在修复前 4 项失败（`/tmp/cmb-bot-runtime-closure-red.log`）；修复后实际图 13 项通过、225 项未选中（`/tmp/cmb-bot-runtime-closure-green.log`），包括原回执重放、三种分支边界和五个插件 Hook 场景。Provider 4 项独立通过（`/tmp/cmb-bot-computer-sandbox-unit.log`）；其中测试的 `beforeEach` 原先返回 mock 函数，Vitest 将其再次作为清理执行，现改为无返回值，未放宽产品断言。
- 上轮冻结回归在实际图出现两项插件失败后停止，退出 130、1209 秒内输入未变化；不是全流程通过。两项单独原样复验通过（`/tmp/cmb-entity-plugin-failures.log`），包含五个相邻插件场景的后续复验亦通过，但尚未据此认定原失败原因。补充失败时的操作记录诊断，新冻结回归启用遇错停止，继续核对整仓结果（`/tmp/cmb-runtime-closure-quality-*`）。


### 大目录排序与备份回归（2026-10-04，继续实施）

- 备份链接数据库的原样保留断言改用 `Buffer.equals`，保持完整字节比较，避免测试框架递归比较二进制带来的额外时间。备份 17 项独立复验通过；未放宽超时。
- 工作区树排序复用两块归并缓冲区，只处理真正有多个子项的目录；事件循环按 4ms 时间预算让出定时器队列，替代固定 64 次消息队列计数。保留分块和取消检查。五万目录专项在与重型数据库用例并跑时仍出现一次 34.98ms 间隔，独立执行原 30ms 门槛的 3 项通过，不能据此保证所有系统负载下的最大延迟。
- 本轮冻结 2667 份源码/测试/配置，目录性能专项先单独运行，再运行排除该已测文件的完整 Vitest 主组与原串联门禁（`/tmp/cmb-entity-release-quality-*`）；性能门槛和断言未删除。专项、lint、Web 类型已通过；完整回归因实际图两项插件失败停止，退出 130，后续处理见上节。与此前完整 UI/Node 类型验证的源码差异仅树排序模块。


### 执行偏好与授权配置边界（2026-10-04，继续实施）

- 核对标准执行链时发现自动审核与工作流恢复对整个模型配置快照做身份比较。用户修改下一任务步数、工具偏好、时区、失败反馈或 Git 操作时限时，会误阻断当前任务或恢复。新增 13 项回归在原实现上 7 失败、6 通过，实际复现六类偏好误报及 SQLite 重开后工作流拒绝（`/tmp/cmb-execution-authority-red.log`）。
- 抽出共用授权摘要，只排除这六类由任务收据固定或独立限额的偏好，模型/凭据、默认模型、连接器、沙箱、插件、技能及未知新增字段继续参与比较。自动审核、记忆命令授权范围和工作流使用同一摘要；不新增权限或自动接受未知结果。
- 旧工作流仅在当前完整快照仍吻合旧摘要时原子迁移；不能还原旧快照时保留拒绝。首次领域复验 3 文件/26 项通过（`/tmp/cmb-execution-authority-green.log`）。补充旧记录与后台恢复测试发现严格持久结构未接受新增兼容字段，已补入并复验。领域 6 文件/62 项通过（`/tmp/cmb-authority-owner-final.log`），包括 SQLite 重开、旧摘要迁移、后台工作唯一恢复以及授权变更拒绝；真实图 9 项通过/227 项未选中（`/tmp/cmb-authority-graph-final.log`），任务中修改六类偏好后仍只审核/执行一次命令。此前扩大筛选复验有 MCP 原生资源用例 5 秒超时和原生 Hook/PDF 等等待超时；隔离复验后 MCP 与双 Hook 用例显式给定多进程集成总时限，产品限制和断言保持。本批 ESLint、Node 类型通过；随后冻结 2662 份输入的全量主组 666 文件/5441 项通过、2 项超时、141 项跳过（`/tmp/cmb-authority-quality-full.log`）。macOS 电源日志确认 11:22:53–11:32:13 休眠 560 秒，两项失败耗时约 558/560 秒；未改超时，隔离复跑 2 文件/4 项通过（`/tmp/cmb-authority-two-failures.log`）。全量串联与新包尚未完成，不把该轮称为整仓全绿。
- 本批前的新整仓回归因发现上述缺陷而主动停止，退出 130；303 秒内 2660 份输入未变化（`/tmp/cmb-current-full-regression-{status.json,full.log}`）。该轮不作为全流程通过。文首 Mac 包不含本批改动。


### 冻结树复验、追踪缓存与 Persona 修正（2026-10-04，继续实施）

- `/tmp/cmb-bot-final-review-full.log`：2655 份源码/测试/配置摘要在整轮检查期间未变化；UI 和 Node/Web 类型先通过，随后整仓主组 660 文件/5407 项通过、5 文件/7 项失败、14 文件/141 项跳过，并记录 1 个迁移测试拦截异常。失败覆盖追踪收尾、MCP SDK Hook 等待、并发 Git Hook 安装、备份字节断言和旧数据迁移；后续串联门禁与构建未执行，不能称整仓通过。
- 单独复验 `/tmp/cmb-final-failures-isolated-red.log`：MCP 失败结果路径、并发 Git 安装仍超时；追踪大输入用例接近 15 秒上限，备份字节断言约 4.65 秒。新增缓存 7 项回归全部在旧实现上失败，实际复现全量序列化/访问器执行、可变对象污染、过期引用复活、更新失败保留旧值、文本与 JSON 混淆及引用索引无界。
- 追踪尾部缓存现先按深度、项数和字节预算生成独立 JSON 快照，只保留完整结果；不执行 getter/toJSON，不先序列化整个超大对象。淘汰同时删除引用，替换不可保留的值时清除旧内容，内容地址区分文本与 JSON，引用数量有上限。备份原样保留检查改用等价的 `Buffer.equals`。多进程/大数据集成用例明确总等待上限，产品命令/解析/权限限制均保持。专项复验 7 文件/24 项通过，289 项未选中（`/tmp/cmb-final-failures-fixed.log`）；追踪大输入单独运行约 14.24→8.62 秒，备份原字节保留约 4.65→0.46 秒，保留本机测量边界，不称全应用性能结论。相关 ESLint 通过（`/tmp/cmb-final-fixes-lint.log`）。
- 从本机官方 Grok Bot 0.66.0 的实际渲染资源核对八种静态角色轮廓、主题色和镂空眼睛。两次独立提取结果一致；仓库只保存固定 SVG 数据，未引入官方三维引擎或遥测。改正旧重建实现把浅/深主题色用作渐变端点及白色横眼的偏差，保留当前轻量状态动画和不可见/减少动态效果暂停逻辑，隐藏时同时停用指针监听。来源与摘要已更新到 Persona PROVENANCE；完整官方三维动效未移植。冻结 2657 份输入后的 Node/Web 类型、完整 React 工作区、整条工作流及构建均通过（`/tmp/cmb-persona-quality-{types,ui,workflow,build}.log`）；浅色头像编辑器、浅/深色群聊截图已查看，工作状态与减少动态效果检查通过。本批已包含于文首最新安装包。


### 聊天日期定位（2026-10-04，继续实施）

- 从官方 0.66.0 实际应用资源确认时间标记条件为首条、跨日或相邻记录绝对间隔至少 15 分钟。提取该判断，使用 Cmb 已有绝对日期格式，避免“今天/昨天”跨夜陈旧且无需时钟轮询。新增纯展示组件，保持原消息顺序、分页、未读及回复定位和键盘目标；加载更早历史后重新判断页边界。
- 时间边界与原日期格式共 2 文件/10 项通过（`/tmp/cmb-transcript-time-unit.log`），相关 ESLint 与 Web 类型通过（`/tmp/cmb-time-quality-{lint,web}.log`）。冻结 2660 份输入后的完整工作区与构建再次通过（`/tmp/cmb-time-quality-{ui,build}.log`），已查看新的带日期深色群聊截图；原分页、未读、引用跳转、动画及群聊草稿回归均保留。最新构建的 5 项编译 Host 原生检查通过（`/tmp/cmb-persona-quality-native-host.log`）：代理、SIGKILL 后模型绑定保持/变更阻断、桌面断开后后台运行及多 Host 仲裁；54 项未选中，不计为全部 Host 测试。同一冻结输入的新包打包及 20 项桌面旅程通过，见文首。

### 群聊发言者识别和私聊跳转（2026-10-04，继续实施）

- 再次实看官方 Grok 群聊，确认发言者名称使用对应头像色并能进入私聊。CMB 复用现有 Persona 色板、会话选择及草稿状态，群聊发言者新增可键盘操作的私聊入口；主题文字色与头像色混合，长名称截断后可查看完整名称。已删除、无私聊目标或私聊中的发言者不提供误导性跳转。
- 真实 React + Chrome + SQLite 工作区旅程通过（`/tmp/cmb-group-author-browser.log`）：区分两个发言者、从群聊进入私聊、返回保留群聊草稿、跳转不新增消息，及原有完整工作区交互和清理；暗色截图已查看。随后为夹具固定同事头像色，避免随机同色导致偶发失败，并补充浅色截图与长名称布局约束；冻结 2655 份输入后的完整 UI 旅程再次通过（`/tmp/cmb-bot-final-review-ui.log`），浅/深色群聊截图均已查看，Node/Web 类型通过（`/tmp/cmb-bot-final-review-types.log`）。未据此将整体 Grok 对齐标为完成。
- 原工作流兼容性门禁运行至 `coordinator-mode-plumbing`，发现其两项旧断言仍在 `runtime.ts` 查找已提取的时间文案。现保留运行时调用接线断言，并验证共用函数实际生成的日期/时间规则；该专项通过（`/tmp/cmb-shell-monitor-plumbing2.log`）。首次整条工作流退出 1，后续门禁需继续，不把前半通过当作整条通过。

### 插件收尾竞态与真实 Shell 上下文（2026-10-04，继续实施）

- 冻结树整仓回归发现插件命令以 `MODS_TURN_ENDING` 失败。周期配置检查从运行阶段开始，I/O 返回时已进入正常收尾，原 `current(true)` 将阶段转换误判为执行失败。配置监测现独立于 SDK 的执行权限：前后仍检查租约、配置和 Bot 授权，收尾阶段允许监测继续，关闭后丢弃迟到检查；普通 SDK 调用仍不能在结束后获得权限。并发配置读取继续合并。
- 初始回归夹具分别遇到 Node ESM 导出不可修改、插件注册签名及阻塞点不准确，修正后在真实图中稳定复现错误中止信号（`/tmp/cmb-plugin-finish-race-red8.log`）；同时确认已持久完成的结果不会因更晚的配置撤销被改写，因此负例检查进行中的监测取消，而不错误要求推翻已完成任务。修复后正常收尾、撤销、原命令退出 0/7 及 Shell 上下文共 6 项通过（`/tmp/cmb-plugin-shell-graph.log`，229 项名称未选中）。
- 将原 `LocalSandbox` 的 Shell/PATH 解析提取为共用模块，保留既有缓存、发现顺序和受限 Windows 下避开 MSYS2 的行为。Bot 使用执行 worker 同款过滤后的环境解析，只向具有 execute 工具的模型提供实际 Shell 名称和命令语法。读取路径即可完成，未为每次任务新增探测进程；macOS/Linux/Windows 的选择规则与 Windows 普通对象环境变量大小写均有覆盖。Windows 样例是路径夹具，仍非 Windows 实机证据。
- 两个摘要成功用例原先只给提示、工具定义及摘要留下 11000 token，新增上下文后不足。现成功用例保留 13000 token 输入预算，新增更小预算必须拒绝且不向主模型发送的负例，未放宽产品上下文保护。Git 工作副本用例对实际导入/建库/提交/工作副本创建与清理采用 20 秒集成限时，避免超时后的环境恢复与下一用例重叠。Shell 原执行器、共用解析、摘要实际图和全局忽略共 4 文件/36 项通过（`/tmp/cmb-shell-monitor-unit.log`）。Node 首轮指出测试回调 this 未声明，已补类型并通过（`/tmp/cmb-shell-monitor-node2.log`），本节局部 ESLint 通过（`/tmp/cmb-shell-monitor-lint.log`）；本节尚未进入文首安装包，不能称当前全仓回归通过。

### 原版实屏与剩余执行准备核对（2026-10-04，继续实施）

- 本机已可读取官方 Grok Bot 窗口，实际查看群聊成员/详情/资料库、私聊电脑休眠预览、例程列表与暂停例程详情；未发送任务或修改保存配置，最后返回原群聊成员页。确认头像与名称居中、三栏边界、详情页签、例程卡片和底部操作布局。群聊资料库的原版空态仍写“此 Bot”，CMB 的同页使用“来自本群聊的附件与成果”，不照搬对象不符的文案。本次观察不计为模型或电脑并行能力验收。
- 继续对照原 `standard-thread-turn` 与 `createAgentRuntime` 的输入准备和最终组装：Bot 已分别接通显式技能、受限项目规则、模型绑定/预算、持久检查点、队列、Hook/Mods 生命周期及原图的完成检查。发现原 Cmb 会先解析实际命令解释器并注入 Shell 语法，Bot 当前只注入 Host OS。该缺口可能使 Windows 下的 Git Bash/PowerShell/cmd 命令选择不一致，接下来复用原解析器补齐，不把“共用图内核”视为全部任务准备已完成。
- 当前冻结树全仓回归已出现两项摘要预算失败，以及工作副本全局忽略测试的超时/后续断言失败，等待本轮完整结束后再修改。摘要用例的系统提示和工具定义加上短摘要估算为 11012 token，超过其 11000 输入预算；需同时保留真正超限拒绝和足够预算时压缩继续的两种验证，不能靠关闭预算保护使测试通过。

### 插件面板清理与集成测试准备（2026-10-04，继续实施）

- 单独复跑整仓失败项：工作区链接保护、迁移解析通过；20 个 Git 仓库准备、115 个持久任务准备及多原生命令生命周期仍有 5 秒超时，插件 260 次连续重绘仍触发资源预算（`/tmp/cmb-bot-full-failures-isolated.log`，4 文件失败、2 文件通过）。没有将所有失败笼统归因于机器负载。
- 将 Git 仓库和历史任务准备移入 beforeAll，查询/安装本身仍保留原测试限时；原生生命周期和实际脚本执行用例明确使用 20 秒测试总限时，产品命令超时不变。重绘清理用例仍执行 260 次，逻辑时间跨多个 CPU 窗口，不再假定 260 次绘制一定能在同一个 500ms/5s 配额内完成；真实资源限制保留。
- 发现 `Promise.allSettled(plugins.map(...))` 未捕获 map 中同步抛出的清理异常，导致错误语义被覆盖。改为每项异步收集。新增回归先复现 MODS_UNLOADED 覆盖异常；首次修复后发现可选插件失败按原设计降级，因此用例分别覆盖可选降级和必需错误传播，未改调度器的原策略。面板、Guest、未读分页、生命周期及 Git Hook 共 5 文件 / 63 项通过（`/tmp/cmb-quality-failures-fixed.log`）。

### 桌面时区与后台时间上下文（2026-10-04，继续实施）

- 对照原 Grok 例程的用户时区上下文与原 Cmb runtime，Bot 之前仅注入 UTC 时间。现从桌面受保护配置快照发布时区，使用原任务收据固定每个任务的时区，恢复任务继续使用原值，工作流子任务继承父任务；新任务采用新设置，已有例程仍保留各自保存的时区。旧配置未带时区时兼容使用 Host 时区，后续远程配置应明确提供用户时区。
- 将原 Cmb 时间上下文函数抽为桌面/Bot 共用模块。复现旧算法在纽约 2026-03-08 06:30Z 将 -05:00 算成 -04:00；原因为把格式化后的日历时间再次按 Host 时区解析。改为日历部分与 UTC 瞬时计算差值，并使用 h23 避免午夜显示 24 时，无效显式时区拒绝使用。
- 日历/DST/午夜/半小时及四十五分钟偏移、配置独立发布、SQLite 重开及过期租约专项已通过；最初 3 文件 / 29 项通过（`/tmp/cmb-runtime-time-unit.log`），随后增加半小时时区样例，格式专项 17 项通过（`/tmp/cmb-runtime-time-offsets.log`）。实际 Bot 图验证两个有效用户时区及无效时区在模型前拒绝，工作流子任务继承父时区，共 4 项通过（`/tmp/cmb-runtime-time-graph.log`）；实际脚本/审批及时间专项再次 5 项通过（`/tmp/cmb-runtime-time-graph2.log`）。模型为本地受控夹具，不据此宣称真实模型已正确完成自然时间任务。Node 首轮指出测试清理回调返回 VitestUtils，改为 void 后通过（`/tmp/cmb-runtime-time-node2.log`）；已纳入文首新包；工作流整条门禁随当前整仓回归执行。

### Electron 错误跨隔离上下文传输（2026-10-04，继续实施）

- 新例程安装包 `/private/tmp/cmb-bot-routines-ui-kmrivj_t/mac-arm64/CMBDevClaw.app` 构建及临时签名成功，但真实桌面验收在旧版本例程错误码断言失败，不能记为新包通过。确认主进程→preload 的封装正确，preload 抛出 Error 后，contextBridge 又丢弃自定义 code；此前单元测试只模拟第一层序列化，未覆盖这条边界。Electron 的 [contextBridge 类型说明](https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support) 明确说明此行为。
- Bot 命名接口统一传递普通错误数据；preload 声明区分传输结果和领域 API，由渲染器共用适配器在跨桥之后构造领域异常，保留 code、可读 message 和 Error 类型。49 个调用文件使用同一适配器，未开放通用 IPC 或新增业务状态；未知传输失败仍走未知结果处理。
- 新真实 Electron 专项通过 IPC、隔离 preload、contextBridge 和实际渲染器适配器，验证例程/消息/后台重启错误、成功回执与未知断线（`/tmp/cmb-bot-context-bridge.log`）。实际 React + SQLite 验证旧版本明确拒绝、不新增任务、清除未确认请求及确认新版本后重新执行（`/tmp/cmb-bot-bridge-routine.log`）。IPC、消息发送、引用/分支、上下文导入和文件传输专项共 6 文件 / 111 项通过（`/tmp/cmb-bot-bridge-unit2.log`），完整 React 工作区及清理通过（`/tmp/cmb-bot-bridge-workspace.log`），Node/Web 类型通过。新桥接测试首轮 ESLint 指出显式 any，改为明确夹具类型后通过（`/tmp/cmb-bot-bridge-lint3.log`）；其他调用文件 lint 通过。三平台 CI 已加入桥接专项，未执行远端 CI；文首新包的原生旧版本拒绝与恢复交互已通过。

### 例程手动运行回执与查看器生命周期（2026-10-04，继续实施）

- 对照官方例程的 Test/Running 交互，手动运行按钮现在显示等待、运行及待处理状态；完成后才重新开放。沿用 Host 原任务收据，将用户看到的例程 revision 纳入请求，未接受的旧版本拒绝执行；已经接受的旧请求在例程修改或窗口重开后仍返回原任务。待确认请求只保存 Bot/例程 ID、版本和 nonce，按数据恢复代次隔离；刷新失败或断线后重试不生成第二个任务。
- 初始回归复现旧版本仍可执行；IPC 核对又发现 Electron 丢弃错误码，已同步修正主进程和真实 preload 的领域错误封装。存储、例程权限、技能、历史、IPC/preload 和待确认记录共 6 文件 / 115 项通过（`/tmp/cmb-routine-run-final-unit.log`）。实际 React + Chrome + SQLite 验证回执丢失、关闭重开、修改配置后原请求重放、运行状态和新请求版本，首次测试域名不具备安全上下文，改为 localhost 后通过（`/tmp/cmb-routine-run-browser.log`）；Node/Web 类型通过。官方依据：<https://cursor.com/help/grok-bot/routines>，不据此假定未公开的闲置暂停期限。
- 核对发现资源和详情弹窗仍在隐藏窗口中轮询。例程、技能、记忆、运行记录、命令输出、审批规则、Webhook、备份设置及插件面板统一接入现有可见性接口；保留组件和输入状态，隐藏或设置覆盖时停止自动读取，重新显示时刷新。原记忆/技能固定间隔轮询改为请求完成后调度，资源首次读取和周期读取合并；插件面板合并未完成的同一读取，未增加第二套业务存储。
- 15 类真实 React 面板的受控浏览器生命周期验证通过：隐藏挂载无读取、持续 12 秒慢应答不叠加轮询、设置覆盖及隐藏期间停止、迟到失败不覆盖界面、恢复重新读取（`/tmp/cmb-panel-lifecycle-browser3.log`）。使用 Playwright 时钟和显式 document 事件，不冒充原生窗口证据。首轮测试因空容器不可见而等待超时，改为等待挂载；相关 ESLint 无错误/警告，Web 类型通过。完整工作区通过（`/tmp/cmb-panels-integrated-browser.log`），原生包首轮发现上节桥接问题；修复后的文首新包已包含本节改动，并通过真实窗口隐藏/恢复验收。
- 顺着 Cmb 原命令解释器发现桌面→Host→worker 的环境白名单丢弃 `GIT_BASH_PATH`、`ProgramFiles` 和 `ProgramFiles(x86)`，导致非默认 Windows Git 安装发现条件缺失。补齐原执行器需要的三个变量，仍排除模型凭据、启动注入和 Git 重定向。新增回归先失败后通过，真实 Shell 子进程、输出、取消、超时和进程树退出等 17 项通过（`/tmp/cmb-shell-discovery-{red,green,node}.log`）；路径发现样例在 macOS 测试，不等同于 Windows 实机通过。

### 子任务续租与连接器流程（2026-10-04，继续实施）

- 子任务每 250ms 检查仍校验父任务、工作流代次和子任务执行权，只有父租约期限变化时才写入子租约，缩短期限也立即继承。真实 SQLite、可控时钟复现由每分钟 246 次父/子续租写入降至 12 次；运行和人工等待两种状态均覆盖。新增两项先失败再通过，相关 4 文件 / 63 项通过，Node 类型和局部 ESLint 通过（`/tmp/cmb-child-heartbeat-{red,green,node,lint}.log`）。这不是 CPU 或总磁盘开销的测量。
- 最新构建产物下五项子任务 SIGKILL 恢复门禁通过，包括共享/隔离工作区、前台/后台子任务及生命周期收尾；已完成修改没有重放。首轮两项因测试沿用旧活动文案失败，核对当前共享后台结果队列后将“子任务”改为“后台任务”，原持久等待边界与恢复断言保留，第二轮全部通过（`/tmp/cmb-child-heartbeat-native{,2}.log`）。
- Bot 侧栏新增“连接应用”，复用现有连接器设置浮层，折叠为可访问的图标入口。继续修复原连接器设置：等待保存回执、失败后读取实际状态、加载失败重试、切换连接器后隔离旧连接测试结果；懒加载改为仅更新布尔字段的窄 IPC，避免用旧完整配置覆盖其他字段。真实 IPC/存储及既有设置专项 3 文件 / 9 项通过（`/tmp/cmb-connector-settings-unit.log`），浏览器验证保存失败读回、重复点击隔离、连接测试不串结果、清空搜索后的旧定时器、深浅色与 640px 往返通过（`/tmp/cmb-connector-settings-browser5.log`）。首轮浏览器夹具遗漏 Vite 环境变量，补齐后通过；Node 首轮指出测试 IPC 类型不完整，修正夹具后 Node/Web 通过。已检查截图并修正标题换行、窄屏布局和详情滚动；移除面向源码调试的默认说明。ESLint 本轮无错误/警告（`/tmp/cmb-connector-settings-lint2.log`），构建与文首新包的入口旅程通过。

### 表格附件预览（2026-10-04，继续实施）

- 对照 Grok `spreadsheet-viewer-model.ts` / `spreadsheet-viewer.tsx`，补齐 CSV、TSV、XLSX、XLS 的表格视图、工作表切换、单元格查看和复制。移植分隔文本的引号/换行语义和交互结构，复用 Cmb 的文件权限、不可变附件、编码识别、Office 解压限制、文档子进程及统一弹窗；来源与适配记录加入 `upstream/PROVENANCE.json`。
- 每页最多 50 行、20 列，支持继续查看后续行列，保留 Excel 原坐标；长单元格预览最多 512 个字符并明确提示。CSV 扫描统计时只保留当前窗口，不为跳过的行构建数组；Excel 不将整个工作表转换为二维数组。解析在原 256 MiB/15 秒的可取消子进程内执行，公式使用文件保存的值，文本不挂载为 HTML。
- 初轮用例发现空 XLS 的默认 A1 范围以及测试文件生成时的前导空范围，已分别修正空表识别和测试文件声明的范围；原失败日志保留。解析、真实文件服务/子进程和原文档能力共 4 文件 / 27 项通过（`/tmp/cmb-bot-table-service.log`）。实际 React + Chrome 验证工作表/行列切换、键盘选择、真实剪贴板、读取失败重试、单页 1000 个单元格及窄屏；补齐测试页 Bot CSS 后再次通过（`/tmp/cmb-bot-table-browser2.log`），深浅色截图已查看。
- 首轮 Node 类型检查指出夹具使用了未声明的 `aoa_to_sheet` 参数，改为库公开的 `sheet_add_aoa` 接口后，解析、Node/Web 类型均通过（`/tmp/cmb-bot-table-{parser3,node2,web2}.log`）。本节已进入文首新包，表格旅程使用真实附件服务及编译解析子进程并通过；完整 Office 排版、图表、编辑与公式重算不包含在只读表格预览中。

### 工具错误反馈与多 Bot 去重隔离（2026-10-04，继续实施）

- 继续核对原 Cmb runtime，发现 Bot 未传入原工具失败反馈回调。已复用 `failure-fuse` 的计数、成功复位、关闭/警告/调试模式与原图的反馈分支；工具返回错误与抛出异常共用同一观察窗口，人工取消沿用原排除规则。持续活动只记录次数，不保存可能包含服务错误正文或参数的 fingerprint。计数是单次物理执行的临时提示，不充当持久任务预算。
- 真实图的三模式用例最初两项失败、一项通过。接线后警告模式通过，但调试模式仍失败，定位到原进程全局去重 Set 将另一个 Bot/任务的相同 provider tool-call ID 认成已处理。新增 AsyncLocalStorage 范围，由 Bot 执行入口建立；并发 Bot 与工作流子任务的失败标记彼此独立，同一次调用内仍去重，退出时清空范围。原桌面调用保留原兼容路径，不在这里宣称原桌面全部入口也已隔离。
- 桌面三个失败设置通过原受保护配置快照发布，IPC 等待发布成功后确认；失败回执可重试。策略按任务持久保存，重开数据库和补充指令不改变当前任务，新任务采用新值；后台原环境变量不覆盖已发布配置，普通桌面调用仍使用原环境语义。
- 修复后实际图三模式及并发/嵌套范围专项 4 项通过；主执行链、子任务、Hooks、共享失败策略与边界共 7 文件 / 294 项通过、19 项条件跳过（`/tmp/cmb-bot-fuse-runtime.log`），工作流链通过。随后配置发布、真实 IPC、SQLite 恢复与去重共 6 文件 / 49 项通过，实际图验证三种模式均覆盖后台相反的旧设置，警告提示真正进入模型请求（`/tmp/cmb-bot-fuse-policy-{unit2,graph,node}.log`）。最终已并入文首整仓回归及新包，实际设置 IPC 发布与桌面旅程通过。

### 模型编辑器配置读取（2026-10-04，继续实施）

- 真实 React/浏览器延迟读取复现：配置未到达时已经可以输入，读取完成会替换正在编辑的内容。沿用原模型编辑器与读取接口，增加加载和读取失败状态；加载成功才开放表单，失败可重试，关闭后的迟到应答仍由原取消标记隔离，不将旧配置开放为可保存状态。
- 回归先失败后通过，验证延迟读取、失败后重开及明确重试（`/tmp/cmb-model-editor-loading-{red,final}.log`）；相关 ESLint 通过。最新 Web 类型、构建及文首新包 17 项桌面流程通过；未重复运行与本次局部 UI 修改无关的全部后端门禁。
- 检查点资源限制、Host 续租、工作区超时和 Bot 编辑恢复专项加入现有三平台 CI 清单；未执行远端 CI，不据此宣称 Windows/Linux 已通过。

### 设置浮层与检查点资源边界（2026-10-04，继续实施）

- 实看官方 Grok 设置界面后，Bot 设置改为保留对话背景的居中浮层，统一标题、关闭按钮、侧栏图标和选中状态；窄窗口使用完整可用区域。沿用原设置存储和模型编辑器，工作台设置仍保留原布局。设置遮住 Bot 时暂停列表、状态、画面与示范录制状态的观察轮询，Host 任务继续运行；关闭后保留输入和控制权，重新观察后再接收浏览器操作。
- 完整 React 工作区旅程通过（`/tmp/cmb-bot-floating-browser3.log`），包含设置期间无新增观察请求、返回后草稿及接管代际不变。前两次验证分别发现夹具虚拟模块缺少依赖解析目录、相对导入与别名导入未共用状态，已修正夹具并复跑；没有放宽停止轮询断言。真实桌面浮层、嵌套模型弹窗及工作台回归均已通过，见文首。
- 检查点主体已有 16 MiB 限制，补齐元数据和同一检查点工具结果的大小/条数限制。工具结果依次序列化，超限或取消后停止分配后续副本；多个任务分批提交的总量在原 SQLite 事务内检查，失败回滚整批，同时保留 LangGraph 的幂等和错误替换语义。不删除既有历史或擅自确定保留周期。
- 四项真实存储复现先失败后通过，连同原始历史读取、压缩及恢复执行图共 3 文件 / 15 项通过（`/tmp/cmb-bot-checkpoint-limits-{red,green}.log`）；随后补充错误记录替换超限的回滚检查，检查点专项 5 项通过（`/tmp/cmb-bot-checkpoint-limits-final.log`）。Node/Web 类型、构建及文首打包通过；该包包含资源限制。最新相关 ESLint 无错误，App.tsx 原 initUser effect 仍有一项依赖警告，未用禁用规则掩盖。

### 长任务心跳写入与设置导航回归（2026-10-04，继续实施）

- 新增可控时钟与真实 SQLite 用例，复现等待模型/人工输入时每次心跳都写任务租约：60 次正常心跳写 60 次。现在每次心跳仍校验租约身份、执行权和取消状态，剩余时间进入 20 秒窗口才续租至 30 秒；同一用例降至 6 次续租写入。没有延长允许失联的时间，也不以缓存状态代替权限检查。
- 租约撤销在下一次心跳立即中断执行；原时钟回拨、前跳、休眠、配置撤回和后台重启检查继续通过。新增用例先失败后通过，相关 4 文件 / 14 项通过（`/tmp/cmb-bot-heartbeat-{red,green}.log`）。这是数据库续租写入次数的验证，不是 CPU 占用百分比或全部磁盘写入量的测量。
- 首轮全仓 Vitest 为 656 文件通过、1 文件失败、14 文件跳过，5332 项通过、1 项失败、141 项跳过；失败在外观设置应紧邻通用设置的导航约束。新增模型入口曾插入两者之间，已将模型入口移到外观之后，保留直接打开模型设置的行为。对应专项及第二轮完整 `npm test` 已通过，见文首；首轮失败记录保留。

### 工具策略、Bot 保存恢复和工作区超时配置（2026-10-04，继续实施）

- 接通应用原工具策略设置与独立 Bot 执行链：沿用 `createToolStrategyTurnReminderMiddleware`，通过显式映射使用 Bot 的 `project_read/project_edit/read_skill`，不向模型提示不存在的工具。策略按运行持久保存，任务恢复保持原值；只读/无 Shell 权限的子任务不启用 Shell 优先，实际工具集继续参与校验，命令仍需原审批。
- 设置成功回执等待 Bot 配置发布完成；本地保存成功但后台发布失败时显示“未能确认已生效”，不再声称原设置未改变。模型配置、策略和运行步数仍共用原存储与受保护的配置快照。
- 为 Bot 设置增加持久请求收据。回执丢失后重试返回首次结果，不再次更新版本、事件或覆盖后续编辑；原调用不带 nonce 时仍走版本校验。抽出 `BotEditor`，未确认保存按数据库身份保留，关闭重开仍核对同一次请求，未确认时锁定字段；后台有新版本则保留草稿并要求明确载入，保存成功后的列表刷新故障不报成保存失败。
- 将应用已有 Worktree 创建/清理超时设置传到 Bot 的一次性 Git 进程，由原共享 Git 实现执行。Host 监督期限包含清理余量，避免原固定 60/120 秒先于 Git 设置超时；并发任务不修改 Host 进程的全局设置。模型配置暂不可读时，工作区维护仅沿用最近有效的非授权超时值或内置默认值，仍检查任务、目录与提交归属，模型执行的配置发布拦截保持不变。
- 验证：工具策略及发布/恢复专项 27 项通过，实际模型图与命令审批 7 项通过；工作流整条门禁退出 0（`/tmp/cmb-bot-strategy-workflow.log`）。Bot 保存存储/认证传输/前端恢复专项 54 项通过；完整 React 工作区旅程通过并已查看版本冲突截图（`/tmp/cmb-bot-editor-{owner2,browser}.log`）。工作区真实 Git 进程、子任务模型图、设置发布和边界验证 6 文件 / 65 项通过（`/tmp/cmb-bot-worktree-strategy-tests.log`），其中受限子任务未收到 Shell 优先提示。
- 本节已进入文首 17 项桌面验收包，实际 IPC/后台验证了设置发布与 Bot 保存重放；仍不能据此认定全部核心范围、Windows/Linux 或生产验收完成。

### 整体界面重整（2026-10-03，进行中）

- 用户要求全应用视觉和交互统一，并提供了原版 Grok 实屏对照；不能只以单个页面或弹窗截图作为完成依据。已通过电脑操作工具实看原版聊天、Bot 详情及资料库：单层导航、突出 Bot 身份、预览与操作分层、简洁的空状态。工具禁止访问 Codex 自身窗口；用户随后明确以 Grok 为主要参照，没有将 Codex 实屏对照记为已完成。
- Bot 路由使用自己的导航，主工作台侧栏不再与 Bot 列表并列占位；菜单保留工作台、自动化和应用市场入口，不改用户的工作台侧栏偏好。侧栏底部统一为后台状态、设置与折叠按钮。
- 浏览器面板加入 Bot 身份与屏幕预览；人工接管后展示标签页、地址和输入控件。滚动与辅助按键收进辅助菜单，保留原目标身份、画面序号和控制权检查。没有将本机浏览器描述为独立 Windows 桌面。
- 复用原 Radix Dialog、Select 和 Switch 统一 Bot 弹窗、下拉菜单、深浅主题、圆角与低动效设置；例程弹窗固定标题和提交区域，长表单独立滚动，保留草稿、版本冲突和未确认保存处理。插件命令按钮的隐式网格位置会多撑一行输入框，已明确其列与行。
- 前两轮工作区旅程到例程小窗口断言前通过。隔离原失败 DOM 复现：通用 Dialog 的 duration 工具类让默认 transition-property: all 生效，缩小窗口时 max-height 从 860px 向 540px 插值，标题和保存区域短暂越界；截图等待过渡结束才显得正常。Bot 弹窗现仅过渡颜色、边框和阴影，进出场动画保留。第三轮已通过边界检查，菜单焦点断言需等待 Radix 退场后恢复，补齐等待后第四轮完整 React 工作区旅程通过（`/tmp/cmb-workspace-redesign-browser4.log`）。桌面包尚未更新，不能据此宣称整体 UI 已对齐。

### 实屏对照后的导航与模型入口（2026-10-03，进行中）

- 原版 Grok 实屏再次确认：置顶 Bot 用头像卡片呈现，聊天标题突出身份，辅助操作集中在菜单。CMB 现沿用原头像动画、未读状态投影和版本约束排序，增加置顶卡片及窄屏头像栏；搜索时恢复带消息摘要的行。聊天标题居中，已读操作收进菜单；设置、文件、例程和电脑均保留入口。
- 第一轮新包 `/private/tmp/cmb-bot-ui-package-BolTVg/mac-arm64/CMBDevClaw.app` 构建、临时签名完成；编译 Host 门禁 5 项实际通过（`/tmp/cmb-workspace-redesign-{build,host,package}.log`）。桌面新增导航/设置旅程定位到真实故障：Bot 设置入口使用无人消费的旧 `settingsOpen` 状态，点击后没有打开设置。该轮在这里失败，不能算桌面验收通过。
- 已接入应用原 `setShowCustomizeView`，首次使用和快速查找可直达模型设置。设置增加模型目录，直接复用原 `CustomModelDialog`、模型目录缓存、密钥与保存接口；没有另建模型配置存储。真实桌面回归改为从界面新增本地夹具模型，再用该模型完成原后台任务。
- 完整 React 工作区旅程复跑通过（`/tmp/cmb-bot-identity-browser2.log`），包含置顶键盘/拖动排序、紧凑头像栏、搜索时显示摘要、未读菜单、电脑操作和原插件流程；浅/深色主界面及置顶两种布局截图已检查。首轮例程菜单隐藏与焦点恢复之间存在异步间隔，截图显示焦点正确回到触发按钮，断言改为等待实际焦点恢复后通过。Web 类型及相关 ESLint 通过。真实桌面从模型配置界面保存后完成 Bot 任务，连同原桌面流程共 11 项通过，见文首。

### 统一 Bot / 群聊侧面板（2026-10-03，进行中）

- 标题进入详情，右侧统一为详情、资料库、电脑页签。复用原头像与面板缩放、文件预览/下载/删除、资源弹窗和浏览器控制，不新增文件或控制权存储；资料库明确标注所属对话。打开详情不创建浏览器，首次进入电脑后保留输入草稿及正在执行的操作锁；隐藏电脑页签暂停画面轮询，返回后重新观察再允许输入。
- 首轮实页回归复现编辑弹窗关闭后残留两个面板：原同级编辑器、浏览器等使用相同 Bot ID 作为 React key。现为各界面增加独立前缀；第三轮完整 React 工作区旅程通过（`/tmp/cmb-bot-inspector-browser3.log`），包括只挂载一个面板、详情编辑、内联文件预览、跨页签控制权代次不变及输入草稿保留。输入只在实际提交成功后清空，失败保留原文；真实桌面使用超限输入，验证后台拒绝后原文仍保留。
- 继续实看 Grok 群聊详情/资料库/成员页签，复用同一面板外壳接入群聊，显示实时成员和职责，可打开对应 Bot 详情；成员增删仍走原版本约束更新接口。群聊文件沿用原对话权限，不带入成员私聊附件。群聊编辑表单改为独立内容滚动、固定标题和提交区；显示选择数量与成员头像。磁盘提醒简化文字，紧凑栏保留有标签的图标入口，普通不足与严重不足采用不同提示色。
- 第四轮回归已通过群聊文件隔离、成员更新、打开成员详情不启动浏览器及 620×540 表单可用性检查；后续例程键盘断言失败。核对 Radix 源码，选项焦点移动使用定时器；测试等待菜单焦点与每次按键结果后再继续，不修改产品选项值或跳过断言。第五轮完整 React 工作区旅程通过（`/tmp/cmb-bot-inspector-browser5.log`）。Web 类型及本轮源码 ESLint 通过。详情、资料库、群成员、窄屏编辑、电脑操作/预览截图已检查；实际安装包 13 项旅程通过，见文首。
- 增加独立资源专项（`CMB_BOT_INSPECTOR_UI_ONLY=1`）：隐藏与卸载后各观察两个轮询周期，画面/状态请求均为 0；切换 20 次后面板与电脑实例始终各一个。回收后 JS 堆 16,734,868 → 16,926,468 字节，DOM 节点 1039 → 1047，事件监听 456 → 452；实际渲染器 TaskDuration 增量约 1.45 秒（切换操作累计，不是空闲 CPU 占用率）。专项通过，数据见 `output/bot-workspace/inspector-resource-results.json` 与 `/tmp/cmb-bot-inspector-resources.log`；不将单次短程采样表述为全应用无内存泄漏或长期压力验收。

### 群聊保存的断线恢复（2026-10-03，进行中）

- 新增用例复现：群资料实际已更新，回执丢失后以同一请求重试，旧实现报版本冲突。现复用原 SQLite 事务及请求收据；重试返回首次结果，不再次取消讨论、修改版本或发送更新事件。旧客户端不带请求标识仍走原版本校验；新界面通过后台能力协商使用持久重试。
- 从主工作区抽出群聊编辑器，沿用例程编辑器的未确认保存处理：保留同一次请求，关闭后重开仍可核对；轮询不覆盖草稿，其他修改触发明确的版本冲突提示。保存已成功但列表刷新失败不再误报保存失败。待确认请求按数据库恢复代次隔离。
- 数据库重开、后续任务不被重试取消、请求标识冲突及浏览器恢复记录边界共 2 文件 / 19 项通过（`/tmp/cmb-group-retry-green.log`）；Web 类型通过（`/tmp/cmb-group-retry-web2.log`）。完整 React 工作区旅程通过（`/tmp/cmb-group-retry-browser.log`）：新建/修改回执丢失后关闭重开并核对，未产生重复群聊或版本；并发更新提示保留草稿，显式载入后才替换。620×540 表单和版本冲突截图已检查。Node 类型及相关 ESLint 通过。

### 任务执行步数设置（2026-10-03，继续接入标准配置）

- 回归复现设置未生效：桌面没有把步数限制同步到后台，Bot 图执行仍硬编码为 200。现通过已有受保护配置快照同步原 Cmb 设置；沿用共享范围校验与默认值，不新增设置存储或绕过执行限制。
- 每个任务在执行前把所选限制写入原请求收据。执行中修改设置不改变当前任务，数据库重开恢复仍用原值，新任务使用最新配置；写入过程检查租约，不消费等待中的补充要求。实际设置 IPC 在已启用 Bot 时等待配置快照发布后才确认成功；仅调整新任务预算不使正在执行任务的模型配置失效。
- 真实执行图循环工具调用、运行期间改设置、数据库重开、过期租约、默认值边界及桌面配置同步共 9 项通过（`/tmp/cmb-runtime-limits-green.log`），220 项因名称筛选未运行；随后主执行链、RPC、模型绑定、群聊保存与恢复记录共 7 文件 / 262 项通过，19 项平台或条件用例跳过（`/tmp/cmb-bot-quality-owner.log`）。子任务真实执行与生命周期另 2 文件 / 39 项通过（`/tmp/cmb-bot-quality-child.log`）；实际设置 IPC、后台配置同步与发布共 3 文件 / 14 项通过（`/tmp/cmb-bot-quality-settings.log`）。此设置是原图执行步数限制，不表述为覆盖所有后台工作的总 CPU 或 token 配额。

### 隐藏界面的资源使用（2026-10-03，验证中）

- 检查发现窗口不可见时工作区仍读取快照，保留的电脑页签仍读取示范状态。复用浏览器文档可见性事件，暂停隐藏窗口的主工作区/浏览器请求；电脑页签隐藏时也暂停示范状态读取，恢复可见后重新获取状态和画面。后台独立任务不跟随界面暂停。
- 草稿、控制权和进行中的操作锁继续保留；可见性切换不会反复建立并行轮询。挂载时启动的读取与显示状态分开管理，避免切换页签把用户已提交的操作结果丢掉。
- 最新完整 React 工作区旅程含资源专项通过（`/tmp/cmb-bot-quality-browser2.log`）：电脑页签隐藏后画面与示范状态请求均为 0；文档模拟隐藏后主快照、状态、电脑及示范请求均为 0；恢复可见立即读取后台新建 Bot。关闭面板后画面请求为 0。20 次切换保留单一面板/电脑，GC 后 JS 堆 16,823,456 → 16,978,220 字节，节点 1031 → 1041，监听器 458 → 454；TaskDuration 增量约 0.85 秒（操作累计，非空闲 CPU 百分比）。首轮测试夹具的嵌套函数被 tsx 加入命名辅助函数，跨页面求值缺少该函数；改为直接声明属性值后通过，没有绕过产品断言。
- 新增 macOS 实际 `BrowserWindow.hide/show` 验收，待最新安装包运行。上述文档生命周期模拟与短程采样不等于原生窗口或长期 CPU/内存验收。详情中的工作目录改为共享目录标签或目录名，完整路径保留悬停查看，避免长路径挤占侧面板。

### 原生生命周期与质量回归（2026-10-04，进行中）

- 电脑页签不可见时销毁轮询定时器，避免仅停止请求却每 1.5 秒空转唤醒。挂载存活状态、读取并发锁和轮询生命周期分开；快速切换不会启动重叠的控制权查询，已提交输入的结果仍可保留。
- 原生验收的失败定位到测试边界：启动函数局部 `window` 被 tsx 改名，导致跨页面读取预加载接口失败；已改用 `nativeWindow`。模型设置测试现直接核验保存成功时的原子快照值，避免将后续配置变更开启的同步保护误判为上次保存失败；不打印凭据内容。隐藏窗口检查须解除 Playwright 所属 CDP 会话强制可见的覆盖，普通新增 CDP 会话不能解除；独立、无 Playwright 的 Electron 探针确认本机窗口 hide 后文档状态为 hidden。解除覆盖后仍须通过真实隐藏/显示断言，尚未把失败轮次记为通过。
- 失败清理只回收本测试创建的隔离电脑控制权，待后台空闲关闭并移除描述文件后再删除临时目录。原始断言错误保留，清理失败单独报告，避免错误被覆盖及测试浏览器遗留。常规设置页的关闭行为下拉框从空值开始保持受控，修正异步加载触发的 React 状态警告；原生旅程增加此类警告检查。
- 取消空转定时器后的完整 React 工作区旅程及清理通过（`/tmp/cmb-bot-quality-browser3.log`），包含资源专项：隐藏页签/窗口及卸载后的相关请求均为 0；20 次切换，GC 后 JS 堆 16,880,836 → 17,029,156 字节（增加约 145 KiB），节点 1036 → 1046，监听器 458 → 454，TaskDuration 增量约 1.11 秒。此为短程观察数据，不据此承诺长期无泄漏。Web 类型、相关 ESLint、构建通过（`/tmp/cmb-bot-quality-lifecycle-{web,final-lint}.log`、`/tmp/cmb-bot-quality-final-build.log`）。
- 原生窗口测试已通过：确认本机 BrowserWindow 实际不可见、文档实际 hidden 后，经独立 Host 创建 Bot，隐藏界面不刷新列表；显示并聚焦后重新读取后台变化，输入草稿仍保留。新安装包共 15 项旅程通过及完整清理，设置页不再出现受控状态切换警告。先前窗口隐藏失败的轮次未计入通过；最终使用 Playwright 原所属调试会话解除覆盖，未伪造文档可见性或原生事件。
- 设置发布失败可能发生在本地值已保存之后，原“设置未更改”提示不准确；已改为“未能确认设置已生效，请重试”。实际 IPC 处理器增加发布失败及同值重试检查，8 项设置集成通过（`/tmp/cmb-bot-quality-settings-retry.log`）；重试会重新发布，成功回执仍等待发布完成。最后文案改动后的 Web 类型与相关 ESLint 通过（`/tmp/cmb-bot-quality-settings-final-web.log`、`/tmp/cmb-bot-quality-settings-retry-lint.log`）。

### 上下文压缩后的原始任务记录查阅（2026-10-03，执行链接续）

- 对照原 Cmb 摘要归档发现：Bot 默认图的 StateBackend 返回虚拟文件更新，但摘要控制器并未提交该更新，且 Bot 文件工具不接受此路径。真实执行图复现摘要宣称记录已保存到 `/conversation_history/…`，实际无法读取（`/tmp/cmb-context-history-repro.log`）。
- 复用 Bot 原持久检查点中的完整消息日志和 Cmb 原历史文本投影，新增只读 `read_task_history`，按消息和字符分页，保留工具调用关联与结果状态，媒体/二进制使用占位符。读取范围固定为当前租约的任务；拒绝指定其他任务、路径及超限参数，读取期间取消或租约失效不返回结果。子任务只读自己已接收的上下文。
- 共用摘要控制器增加显式的检查点历史模式：自动压缩只更新模型视图，不宣称存在虚拟文件，不重复复制历史；原桌面文件归档方式保持。会删除原消息的插件显式压缩仍拒绝用于此模式。
- 原始证据找回、SQLite 重开、图恢复后读取、取消、作用域及原摘要/子任务回归共 5 文件 / 134 项通过（`/tmp/cmb-context-history-owner-final.log`）。首次子任务插件测试的 1 秒等待不足，独立诊断复跑通过；增加早期失败传播和 5 秒进程等待上限后完整专项通过。整仓回归已通过，见文首；已并入最新安装包。

### 用户可见的空闲后台重启（2026-10-03，OPS）

- 帮助页“关于与反馈”增加后台重启入口，显示进行中、成功或拒绝原因。复用原空闲维护握手与启动流程；有执行/等待回复任务、后台服务或电脑占用时不强制结束。请求绑定当前 Host 身份，旧窗口不能重启已替换的后台。
- 桌面 IPC 独立暴露窄接口，只接受主窗口主框架和严格参数；不把重启权限加入 Bot 工具或普通 Host 业务接口。原维护、更新、通信、Shell 与 IPC 专项 146 项通过（`/tmp/cmb-restart-final-owner.log` 中旧提示断言一项失败，改为检查领域错误码后 4 项升级专项通过：`/tmp/cmb-restart-upgrade-final.log`）。同时保留显式清空代理变量，避免桌面启动 Host 时恢复已禁用代理。
- 完整 React 工作区旅程通过（`/tmp/cmb-restart-workspace-browser.log`），深色窄窗口与实际安装包界面已检查；Node/Web 类型、相关 ESLint、构建通过。实际安装包新增两种重启流程通过，见文首 9 项证据。

### 本机 Host 的模型和 HTTP MCP 代理接线（2026-10-03，ADM-09）

- 旧编译 Host 继承代理环境变量，但实际模型请求未使用代理；指定只能通过本地代理解析的夹具域名时无法完成任务（`/tmp/cmb-proxy-process-repro.log`）。新增启动期网络适配，使用固定 `undici@7.30.0` 的官方 `EnvHttpProxyAgent` 与 Node dispatcher，保留现有 fetch/Response、模型 SDK、重试和 MCP 客户端。无代理配置时不替换 dispatcher；关闭 Host 时释放代理连接。
- 遵循大小写优先级和 `NO_PROXY` 规则；本机控制连接强制绕过代理。支持 HTTP/HTTPS 代理，非法配置明确报错；代理认证失败不尝试直连。没有关闭证书验证或将模型认证传给代理，也不将代理认证传给目标服务。参考 [Undici 官方代理接口](https://github.com/nodejs/undici/blob/v7.30.0/docs/docs/api/EnvHttpProxyAgent.md) 及 [Node dispatcher 文档](https://nodejs.org/api/globals.html#custom-dispatcher)。
- Electron 自带 Node 实际执行：代理流式请求、取消、认证拒绝、本机绕过、环境规则、非法配置、TLS 自签名拒绝及原 MCP HTTP 客户端发现/调用，共 12 项通过（`/tmp/cmb-proxy-mcp-tests.log`）。此前网络/模型诊断/依赖边界/MCP 核心 5 文件 / 65 项通过（`/tmp/cmb-proxy-electron-owner.log`）。重新构建后的编译 Host 原失败场景通过，连同原恢复门禁共 5 项通过（`/tmp/cmb-proxy-native-host.log`）；最后一项非法 URL 编码检查晚于该构建，已在源码专项验证。
- 三平台 CI 同步增加网络专项和编译 Host 代理场景，尚未运行远端。尚无代理配置界面、PAC/系统代理导入、Chromium 网站代理、企业 SSO 或客户端证书实测；使用方式与重启边界见第 12 文档。此项不将 ADM-09 整体标为通过。

### 回收中断发布留下的无引用文件（2026-10-03，FIL-09 / OPS-04）

- 在现有真实子进程 SIGKILL 用例中补充重启检查，复现文件已落盘、事务未提交时内容长期留在磁盘（`/tmp/cmb-orphan-recovery-repro.log`）。沿用对象存储的同摘要互斥和删除维护队列：启动时识别扁平对象目录中的无引用普通文件，清理前重新查询有效引用，每次最多处理 128 个；暂时无法删除的文件继续留待维护重试。无需数据迁移，不删除已提交附件或递归清理其他目录。
- 实际中断前/后提交两种恢复均通过。文件、上传和备份恢复共 5 文件 / 39 项通过（`/tmp/cmb-orphan-owner-tests.log`），包括共享内容、并发发布、非托管路径、POSIX 符号链接及真实分块上传续传；Node 类型和相关 ESLint 通过。此改动晚于文首全仓回归及安装包，尚未合入新的打包证据。

### 使用实际 Electron Node 的后台进程门禁（2026-10-03，OPS）

- 新增 `test:bot:host` 命令和三平台 CI 步骤，复用现有编译 Host 测试及便携 Node 启动方式。后台子进程使用应用实际携带的 Electron Node；执行桌面断开后继续工作、多进程竞争，以及模型配置保持/变化两种 SIGKILL 恢复场景。检查 JSON 报告，要求指定场景全部实际运行并通过，筛选失效或全数跳过均报错；随后加入代理场景，当前要求五项。
- 当前 macOS 使用最新构建实际运行，4 项通过、54 项未选中，退出码 0（`/tmp/cmb-native-host-tests.log`）；启动脚本语法及 ESLint 通过。远端 CI 尚未运行，不能代替 Windows/Linux 实机证据。

### 下载文件与聊天附件的一致提交（2026-10-03，FIL / OPS 恢复）

- 真实子进程复现：文件记录已经保存、消息附件尚未保存时强制退出，重开 SQLite 后存在文件但没有所属分支消息（`/tmp/cmb-download-commit-repro.log`，提交前失败、提交后通过）。继续复用原对象存储、稳定文件校验与收据机制，将文件记录、生命周期、事件、分支消息、附件关联和去重收据放入同一个数据库事务；文件内容完整落盘后才提交。
- 实际进程在事务内及提交后分别被强制结束，重开后均保持一致；同一下载重放两次只形成一个文件和一条原分支消息。下载归属、撤权、对象存储、传输、删除及存储专项共 6 文件 / 43 项通过（`/tmp/cmb-download-commit-tests.log`），Node 类型及相关 ESLint 通过。新增进程用例和归属/文件专项加入三平台 CI，远端未运行。
- 真实 Chrome 普通 Bot 点击、仅下载弹窗及人工输入的交付专项通过，覆盖并行 Bot 与私聊/群聊/分支的归属（`/tmp/cmb-download-commit-browser.log`，1 项通过、11 项未选中）。本项处理已收到完整字节后的发布中断；没有将未完成网络下载自动续传、POST 重新提交或突然断电标为已支持。

### 完整短会话的历史分页提示（2026-10-03，MSG-06 / UI）

- 最新真实安装包截图复现：从未读消息进入后，完整的短会话已刷新，仍保留“加载更早消息”。两个状态回归分别证明轮询刷新和主动加载都会留下旧提示（`/tmp/cmb-history-boundary-repro.log`）。继续使用原 Zustand 和消息合并逻辑，完整末页返回时清除“可能还有更早消息”的标记；满页、断线间隔、已加载历史和消息身份处理沿用原逻辑。
- 分支状态、消息分页及导航共 3 文件 / 18 项通过，Web 类型、相关 ESLint 及完整消息专项通过（`/tmp/cmb-history-boundary-{tests,web,lint,messages}.log`）。新安装包内实际重新打开短会话后，该按钮正确隐藏；其余 7 项真实桌面流程通过（`/tmp/cmb-download-history-desktop.log`），截图已检查。

### 插件命令与启动回调的会话读取（2026-10-03，标准任务准备）

- 用未修改的 Cmb `function-commands` 插件复现：首次运行及已有历史后执行 `/plugin claw-session` 均不能读取会话，任务进入待核对（`/tmp/cmb-plugin-session-repro.log`）。原因是命令在图构建之前执行，原会话读取服务还没有绑定消息和模型。现复用 `ModsManager`、`queryFunctionSessionRead` 和图内会话观察中间件；图初始化前绑定本次允许读取的输入，执行后由原中间件更新实际模型状态。
- 图入口和插件共用同一个 Bot 输入构造函数。私聊读取 Host 已限定的历史；分支不带入分叉后的主线记录；群聊使用原群聊上下文格式；子任务只有明确分配的提示及自己的模型和窗口。空闲插件面板仍没有历史读取或任务执行权限。初始化不伪造请求、用量或上下文 breakdown。
- 原插件命令的首次/历史/分支，以及真实 QuickJS 回调的群聊/子任务隔离，共 5 项通过（`/tmp/cmb-plugin-session-scopes.log`）。主执行链、子任务、输入准备及摘要共 4 文件 / 242 项通过、19 项平台/条件用例跳过（`/tmp/cmb-plugin-session-runtime.log`）。随后补充实际模型返回用量更新检查，连同无桌面依赖边界、输入准备及空闲读取限制，14 项通过、39 项未选中或条件跳过（`/tmp/cmb-plugin-session-boundary.log`）；子任务初始化时用量未知，工具回调内能读到实际返回的 50 个输入 token。Node 类型及相关 ESLint 通过（`/tmp/cmb-plugin-session-{node,lint}.log`），不据此声明所有插件 SDK 或完整任务准备均已验收。

### 任务模型绑定及每次请求前复核（2026-10-03，ACC-09 / 标准任务准备）

- 实际执行图复现：服务返回 503 后，在重试等待期间更换密钥或标记配置正在同步，仍会向旧配置发送第二次请求，两例均失败（`/tmp/cmb-model-binding-repro.log`）。现在在原 Cmb 重试机制内部、每次预留额度和网络发送之前读取当前配置；不可用或与任务模型不一致时停止运行，保留明确的本地错误原因。
- 复用现有 SQLite 收据绑定任务首次请求所用的模型和配置身份；数据库重开后不能换用新的密钥、接口或默认模型继续原任务。摘要与主模型共用检查入口，未保存密钥或接口正文到任务收据。固定模型不受其他模型或展示名称调整影响。记录模型是后台记账，不消费或拒绝同时到达的补充要求。
- 修复后真实图重试两例通过（`/tmp/cmb-model-binding-graph.log`）；持久模型、配置同步、共享额度与存储共 4 文件 / 41 项通过（`/tmp/cmb-model-binding-owner2.log`），含正常恢复、配置变化拒绝、无关配置变化及补充要求保留。首轮补充要求夹具漏传 `steerRunId`，已按实际协议修正；产品代码未将普通新任务误当作补充要求。
- 实际主执行链、子任务、摘要与后台依赖边界 4 文件 / 242 项通过，19 项平台/条件用例未运行（`/tmp/cmb-model-binding-runtime.log`）。最新构建、Node 类型、相关 ESLint 通过（`/tmp/cmb-model-binding-{build,node-final,all-lint}.log`）。编译 Host 使用 Electron 自带 Node 实际 SIGKILL / 重启，两例通过：配置不变继续原任务；配置已变时旧任务不向新模型发送上下文，新建任务使用更新后的模型完成（`/tmp/cmb-model-binding-process.log`；其余 56 项未按名称选中）。整仓回归已通过，见文首；尚未替换文首安装包。

### 用户模型的连接故障诊断（2026-10-03，ACC-09）

- 模型能力检查沿用 Cmb 原 HTTP 状态码字典，区分认证、限流、模型不存在、不支持用途及服务故障；网络错误按实际底层错误码区分域名解析、拒绝连接、超时、连接中断和 TLS 证书问题。仅接收原生传输边界的异常，遍历有上限，不将服务响应中的任意 `code` 或错误文字当作网络证据。
- 真实 HTTP/SSE、连接拒绝和自签名 HTTPS 证书校验失败，以及纯诊断规则共 2 文件 / 38 项通过（`/tmp/cmb-model-diagnostics-tests.log`）。取消优先，凭据和上游错误正文不返回界面，不关闭证书校验或自动跟随重定向。TLS 测试临时生成证书；缺少 OpenSSL 的机器显式跳过该条，当前 macOS 已实际运行。
- Node 类型与相关 ESLint 通过（`/tmp/cmb-model-diagnostics-{node,lint}.log`）；相关专项加入三平台 CI，远端未运行。本项是错误诊断，不代表新增了企业代理配置、SSO 或 Windows 证书部署能力。

### 消息定位的焦点样式（2026-10-03，UI-07/10）

- 实际 macOS 冷启动链接截图中出现横跨整行的焦点框与气泡高亮重叠。现在键盘定位与消息定位共用气泡轮廓，去掉整行重复框；瞬时定位高亮消失后，键盘焦点仍清楚可见。系统高对比度模式使用显式轮廓，不依赖会被系统隐藏的阴影。
- 真实 React 工作区全旅程通过（`/tmp/cmb-message-focus-browser.log`），包含定位、等待高亮结束、键盘焦点、深浅主题及高对比度断言。`output/bot-workspace/reply-focus-{codex-light,codex-dark}.png` 已查看；无后端或协议改名，现有动效保留。Web 类型和源码构建通过（`/tmp/cmb-input-ui-update-build.log`）。文首旧安装包尚未包含此样式修改。

### ASAR 更新和回退的完整文件替换（2026-10-03，OPS-06 接续）

- 原脚本直接复制到正在安装的 `app.asar`；实际隔离脚本在写入一部分后被 SIGKILL，更新/回退两例均留下不完整文件（`/tmp/cmb-atomic-update-repro.log`）。现在先在目标同目录写入临时文件，完整复制后才替换；备份也用相同方式发布，失败不再原地覆盖恢复文件。
- Bash 使用同文件系统移动，保留已安装文件权限，局部清理不覆盖原日志退出处理。Windows 脚本使用 [.NET File.Replace](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace?view=netframework-4.8.1)，不忽略权限/属性合并失败；原文件不存在时使用同目录移动。未增加关闭校验、强杀用户应用或降级复制的路径。
- 实际 macOS 脚本验证：应用存活时等待；退出后更新/回退内容正确且权限保持；复制更新、回退及新备份期间强制结束脚本，当前应用和已有恢复副本仍完整。全部只使用隔离临时文件。更新器、桌面维护及空闲升级共 15 文件 / 139 项通过，12 项 Windows PowerShell 用例未在 macOS 运行（`/tmp/cmb-atomic-update-final-tests.log`）；新增 Windows 正常替换和复制中断用例已进入现有 CI 文件清单，远端尚未执行。Node 类型和相关 ESLint 通过。
- 该修复保证已验证的进程中断窗口不发布半份 ASAR；不据此宣称突然断电、签名包安装、标记/程序/数据库跨文件事务、旧数据版本回退或完整安装器交接已验收。SIGKILL 可能留下同目录临时文件，未将其认作有效安装或恢复副本。

### 输入改写保留附件、技能与群聊背景（2026-10-03，标准任务准备 / MSG-08 / COL-06）

- 用实际命令 Hook 复现：`UserPromptSubmit` 改写正文后，用户选择的技能指令从模型输入消失（`/tmp/cmb-input-envelope-repro.log`）。继续复用 Cmb `prepareUserPromptCore`，提供可选的正文改写适配；Bot 从已确认消息重建附件、引用和固定版本技能，其他调用方保持原行为。内部目标不允许适配器改写，异步重建期间取消或失去任务归属时拒绝继续。
- 群聊沿用 Grok 的发言与上下文格式，只改写当前任务用户消息的模型输入；保留群名、成员和其他人的发言，不修改已保存聊天、不改写其他消息、不改变审批依据。私聊引用的原文保留为引用，不能冒充新的授权。
- 群聊回归另复现引用旧消息中的 `@Bot` / `@everyone` 被当作新接收者，两例均失败（`/tmp/cmb-quoted-mention-repro.log`）。现在只按实际消息正文做提及路由，正文与引用合成的上下文仍用于模型阅读；初次派发和后续轮次都使用同一规则。
- 共用输入准备、Bot 输入/技能、群聊和无桌面依赖边界 5 文件 / 60 项通过（`/tmp/cmb-input-envelope-owner3.log`）。真实执行图、本地模型协议、命令 Hook 及实际附件读取 9 项通过，204 项未按名称选中（`/tmp/cmb-input-envelope-graph3.log`），覆盖私聊/群聊、引用、拒绝、执行中补充及插件命令；数据库重开复用原输入检查收据，不重复执行命令。新增夹具首轮漏用已导入技能的固定版本，随后补齐；群聊夹具明确选择有 Hook 的成员，没有放宽产品权限来通过测试。
- 最终 Node/Web 类型、相关 ESLint、全仓 `npm test` 通过（类型 `/tmp/cmb-input-envelope-node-verified.log`、`/tmp/cmb-message-focus-web.log`；其余见文首）。此结论针对实际执行链与协议夹具，不表示真实模型质量或通用桌面操作已通过验收。

### 安装更新与回退前的后台维护（2026-10-03，UI-11 / OPS-06，继续补齐）

- 复现原安装器未检查 Bot 空闲状态，以及操作系统尚未启动安装器就退出桌面的问题，4 项回归在修复前全部失败。ASAR、全量安装、手动及启动自检回退接入同一维护入口，复用已有 `restartIfIdle` 和 SQLite 进程生命周期锁；仍有任务、审批、后台服务、示范或人工控制时保留原后台并返回具体原因。
- 不以缺失或失联的描述文件判断后台已停止。空闲退出后必须实际取得排他锁，才启动安装器；桌面停止接收 Bot 请求、排他锁保留到进程退出，异步退出检查期间不能重新启动 Host。安装器真正触发 `spawn` 后才请求退出；启动失败释放锁和入口限制，可继续使用并重试。临时维护连接在拒绝或失败后关闭。
- 安装器启动成功后先保留维护锁，再调用桌面退出钩子；退出钩子异常不会错误释放已交给安装器的保护。修正 macOS 安装脚本误用 Linux 固定进程名的问题，ASAR 更新/回退及全量脚本均取实际可执行文件名。实际 Bash 脚本在独立临时应用进程存活时等待，退出后才替换临时 ASAR，备份内容正确；未操作用户安装的应用。测试使用自行编译的无害进程，初次复制系统 `sleep` 的夹具被 macOS 终止，已更换，不能将该夹具失败作为产品故障复现证据。
- 自动回退受阻时保留安装标记、回退备份和后续更新状态，继续打开桌面并提示原因，让用户能处理任务后重试；未完成回退不能触发备份清理。回退标记变更推迟至安装器已启动，覆盖 ASAR / 全量的忙碌及启动失败场景。
- 更新、回退、桌面连接、RPC 和空闲升级 14 文件 / 156 项通过，8 项 PowerShell 专项在当前 macOS 上跳过（`/tmp/cmb-update-bot-final.log`）。Node/Web 类型与相关 ESLint 通过；构建通过。真实 Electron Node 编译 Host 与独立维护进程 2 项通过：忙碌拒绝、取消后空闲退出、等待应用退出时第二个 Host 争锁失败、释放后原记录恢复（`/tmp/cmb-update-bot-process.log`）。CI 三平台列表加入这些专项，远端未运行。
- 随后更新/回退相关 16 文件 / 162 项通过、8 项跳过（`/tmp/cmb-update-native-final.log`）；修正全量脚本的一个遗留常量引用后，Node 类型及相关 ESLint 通过，安装器与脚本/回退专项再次通过（`/tmp/cmb-update-native-{node-final,lint-final,close-tests}.log`）。真实进程等待用例已加入 CI，macOS/Linux 测试使用系统 C 编译器，Windows 运行对应 PowerShell 专项。
- 最终源码构建通过（`/tmp/cmb-update-native-close-build.log`）；该记录早于随后输入准备修复，文首临时安装包也未计入脚本进程名修正。
- 本次实际进程验证不启动外部安装脚本替换应用；正式签名包替换、父进程退出后的完整安装器交接、安装中断恢复及旧版本数据兼容仍需验收，不能据此将 OPS-06 标为完整通过。

### macOS 安装包的外部消息定位（2026-10-03，MSG-06）

- 在真实后台中完成独立分支任务，通过系统 `open -a <测试包路径> <消息链接>` 调用 Launch Services，实际触发打包应用的 `open-url`；没有向 Electron 注入模拟事件。复用此前已移植的 Grok URL 校验、等待队列和去重，以及现有 Bot 分支归属查询。
- 运行中的原应用进程直接进入正确分支并高亮指定消息，不创建新任务或额外模型调用；实际截图 `output/bot-desktop/desktop-external-branch.png` 已检查。首轮测试漏传 `runHistory` 的分支范围，被现有权限校验拒绝，修正的是测试夹具。
- 关闭桌面并保留 Host 后，携带真实消息 URL 参数启动安装包，实际启动路由自动打开 Bot 工作区和正确分支；测试不手动切换页面、不重载页面，也没有额外模型调用。截图 `output/bot-desktop/desktop-startup-branch.png` 已检查；完整桌面旅程 7 项通过（`/tmp/cmb-startup-branch-desktop.log`）。
- 系统唤起显式指定临时包，冷启动测试使用真实进程参数；尚未证明操作系统冷启动协议分派、Windows 协议注册、默认应用选择、跨机器或多账号链接。

### 帮助窗口的滚动与固定操作区（2026-10-03，UI-07/10）

- 实际 macOS 打包截图中，“关于与反馈”的长信息列表将复制和下载按钮挤到滚动区域下方。继续使用原 Cmb Dialog、Tabs、Button，固定标题、页签和底部操作，仅正文滚动；指南和诊断面板高度一致，切换时窗口不跳动。诊断正文增加可聚焦滚动区域，保留键盘访问。
- 实际 React 工作区完整旅程通过（`/tmp/cmb-help-layout-browser2.log`）。浅色、深色及 700×600 小窗口截图已检查，长正文滚到底部后标题与操作区位置不变，无整个对话框的额外溢出；复制、下载、切换页签及返回快捷键入口仍正常。首轮新增尺寸断言落在缩放过渡帧，已在截取稳定布局后检查，不修改产品动画来规避。
- Web 类型及本文件 ESLint 通过；重新构建并临时签名的 macOS 安装包 5 项桌面旅程通过，实际帮助窗口截图已检查，底部按钮处于可视范围（`/tmp/cmb-help-packaged-desktop.log`）。截图位于 `output/bot-workspace/help-about-{codex-light,codex-dark,narrow}.png`。

### 工具失败检查与插件结构化结果（2026-10-03）

- 复现并修正 Cmb 共用 `detectToolFailure` 未识别 MCP `isError: true` 的问题。模型调用和原插件 SDK 调用均进入同一具体工具检查，保留原能力标识、审批和外部调用收据；顶层协议错误标记触发 `PostToolUseFailure`，正文中的示例、嵌套字段和字符串 `"true"` 不误触发。
- 实际插件调用复现第二个问题：原中间件将检查意见拼在 JSON 后面，SDK 无法解析，导致正常结果被标成错误，结构化数据丢失。复用原中间件已有的内容块追加方式，在 Bot SDK 适配处保留协议字段、原始内容及结构化数据，将检查意见放入单独文本块；拒绝结果不恢复为成功，也不通过截取任意 JSON 前缀绕过检查。
- 本机 SDK 也复现了附加检查意见后丢失退出码和产物 ID 的问题。沿用同一内容块处理，保留结构化执行收据，以 `hookFeedback` 字段传递意见；普通拦截文本及非零退出码继续按失败处理。没有修改原 Cmb 中间件的默认返回行为。
- 错误识别、实际模型与 MCP stdio 调用、配置变更/拒绝、原插件命令专项 55 项通过（`/tmp/cmb-mcp-combined.log`，部分用例按名称筛选未运行）。媒体结果、无桌面依赖边界 13 项通过；本机 SDK 正常/非零退出、修改授权、拒绝、改写及 MCP SDK 22 项通过（`/tmp/cmb-mcp-boundary.log`、`/tmp/cmb-native-hook-result-fixed.log`）。
- 原 Hooks 与完整工作流专项通过（`/tmp/cmb-mcp-hooks-regression.log`、`/tmp/cmb-mcp-workflow.log`）。Node 类型、相关 ESLint、构建通过。最新编译 Host 的真实 SIGKILL 恢复 4 项通过：连接器/文件已完成结果及检查意见恢复，检查命令只执行一次；连接器/命令在途结果保留未知状态、不自动重放（`/tmp/cmb-sdk-final-process.log`）。该验证使用本地模型与连接器夹具；没有覆盖 Windows 或外部真实服务。

### 本机后台连接代次隔离（2026-10-03，OPS-03/04）

- 确定性复现旧连接的迟到关闭事件清除新连接待处理请求，以及认证拒绝后套接字仍保持打开。修改原 `BotTransportClient`，每次连接独立保存认证 Promise、请求集合和超时；旧连接的关闭、失败和迟到结果仅处理自身状态。
- 关闭时结算自身请求，连接或认证途中关闭及时结束；每个调用绑定实际完成认证的连接，不能在等待认证后误发到另一个连接。保持原请求 ID、协议与认证方式，不增加失败操作的自动重放。
- 通信、真实 RPC、桌面连接及空闲升级专项 42 项通过；新增连接/认证途中取消后，确定性竞态专项 4 项全部通过（`/tmp/cmb-transport-reconnect-fixed.log`、`/tmp/cmb-transport-cancel.log`）。Node 类型、相关 ESLint 通过。真实 Chromium 多客户端接管、重建和 Teach 控制权 3 项通过；重新构建后的 macOS 安装包桌面旅程 5 项通过（`/tmp/cmb-transport-browser.log`、`/tmp/cmb-runtime-packaged-desktop.log`）。三平台 CI 增加通信、真实 RPC、MCP 结果及失败识别专项；尚未推送或运行远端 CI。

### 备份恢复保留后续删除（2026-10-03，ADM-22 / OPS-05）

- 先复现旧备份让已删除记忆重新出现的问题：正常与损坏当前数据库两例均失败。原逻辑只保留备份当时的删除标记，没有保留备份之后的删除。
- 沿用 Cmb 的原生 SQLite、领域事务及既有备份分步恢复日志。v40 在主数据库事务内记录删除待办；提交后写入独立于恢复范围的 SQLite 删除账本，落盘成功才返回。记录只含对象类型、身份及记忆内容摘要，不保存删除内容；账本有 64 MiB 硬上限。写入失败保留待办，重开重试；领域回滚不会产生删除记录，也不对已提交的领域事务再次执行回滚。
- 恢复先校验封存备份，再收集当前删除及旧版审计记录，在暂存数据库内重新应用。覆盖 Bot、文件引用、私有/共享记忆、示范记录、例程和撤回的共享技能；保留记忆删除摘要和既有提炼屏障。移除暂存中失去引用的文件/录像，其他存活文件引用共用的内容继续保留。原封存备份不被改写，主库损坏时使用已独立落盘的删除记录，删除账本损坏则在替换前明确失败。
- 领域/备份/迁移/后台依赖边界 4 文件 58 项通过（`/tmp/cmb-restore-verified.log`），涵盖 v39 升级、事务回滚、两个落盘中断窗口、重复恢复、共享字节、损坏数据库与链接拒绝。真实 React 备份旅程通过；编译后的独立维护进程及恢复中 SIGKILL 后 Host 启动通过，已删除记忆与 Bot 未复活（`/tmp/cmb-restore-process.log`，3 项含插件面板重启回归）。
- Node/Web 类型、相关 ESLint 与构建通过（`/tmp/cmb-restore-final-{node,web,lint}.log`、`/tmp/cmb-restore-build.log`）。实际页面截图发现测试 HTML 缺少 UTF-8 声明，GBK 误解码使根样式丢失；应用本身有 UTF-8 声明。已修正测试页并增加圆角和窄窗口校验。Windows/Linux 未实测，跨平台 CI 加入删除记录专项；后续 macOS 打包验收见文首。


### 持久插件面板与交互组件（2026-10-03）

- 复用 Cmb 原 `FunctionModsManager`、QuickJS、Pane/Client 控件和执行上下文，以及原 `FunctionPanes` / `FunctionClient` React 渲染器。Host 按 Bot、对话、分支保留运行环境，子任务结束后释放自己的环境；默认最多 24 个，容量不足仅回收没有打开面板的空闲实例。来源记录于 Bot PROVENANCE，不声称移植 Grok 云端实现。
- 保留插件状态与回调，但不保留上一任务的执行权限。每次业务按钮、提交、选择或键盘操作进入新的持久任务，仍执行原工具、文件、MCP 与模型授权；定时刷新、输入变化、指针及尺寸更新使用独立的受限展示上下文，只能访问已授权项目的只读文件和插件自身状态。配置撤销、项目身份变化、旧异步回调和任务租约失效均不能借用下一任务权限。
- SQLite v39 保存操作身份；响应丢失或切换页面后按同一操作核对结果，不创建重复任务或合成聊天消息。后台重启后旧回调失效；已完成收据和插件保存的数据仍在，未完成回调不自动重放。重新运行插件命令可以打开新的面板并读取保存的数据。
- 真实页面测试发现 Electron 可选字段中的 `undefined` 与持久 JSON 不一致，已在窄类型校验后统一规范化，补充同一请求重试测试。保存到本机的待确认操作绑定 Bot、分支及数据恢复代际；存储失败时不提交操作。
- 领域、v38→v39 迁移、IPC 与待确认状态先通过 114 项；补充删除 Bot 时释放全部所属面板、保留其他 Bot 实例，以及群聊成员访问校验后，6 文件 / 115 项通过（`/tmp/cmb-plugin-pane-lifecycle-final.log`）。实际执行图 52 项通过（`/tmp/cmb-plugin-pane-graph-final.log`），包含完成收据恢复、旧回调拒绝及原插件能力。原 Mods、工作流子任务与无 Electron 依赖边界 69 文件 / 560 项通过（`/tmp/cmb-plugin-pane-original-mods.log`）。
- 实际 React + Chrome + QuickJS 的面板按钮、备注、选择、嵌入组件、响应丢失和页面切换通过；调整输入草稿同步后，完整工作区旅程通过（`/tmp/cmb-plugin-pane-workspace-final.log`），最终浅色、深色和窄窗口截图已检查。编译 Host 实际 SIGKILL 后，旧收据可核对、旧回调被拒绝、重新打开后保存的计数仍为 1，未调用模型（`/tmp/cmb-plugin-pane-process.log`）。Node/Web 类型、相关 ESLint、消息专项通过；UI 调整后的构建通过，随后 Bot 删除清理已计入通过的整仓门禁；最新 v40 编译已通过，插件面板重启回归亦通过（`/tmp/cmb-restore-process.log`）。未更新文首旧安装包，Windows/Linux 实机仍待验收。

### 插件并发记录库修复（2026-10-03）

- 真实工作流子任务复现：第一个插件模型调用等待响应时启动同 Bot 的第二个子任务；两次调用均成功返回，但第一个持久收据错误地变为 `unknown`。原因是每个 `BotModsRun` 新建原 `ModControlStore`，其启动恢复会将其他仍在执行的调用标记中断。
- 保留原记录库、迁移、授权和恢复算法，由独占 Host 按 Bot 记录库路径共享连接并计数引用。不同 Bot 不共用；单个子任务退出不关闭其他任务的连接。最后一个使用者退出后关闭，之后重新打开仍执行真实中断恢复；缓存命中核对文件身份，拒绝把被替换的数据库当成同一实例。共用 Mods 管理器允许 Host 注入记录库句柄，桌面默认构造方式保留。
- 复现修复前失败、修复后通过，明确核对两条持久收据均为 `succeeded`。相关记录库、原 Mods 管理器与工作流子任务 5 文件 109 项通过；管理器关闭增加幂等及最终释放后，原插件模块与无界面依赖边界共 63 文件 511 项通过。Node/Web 类型、ESLint、构建，以及编译 Host 的通知恢复、显式插件命令恢复与无桌面插件执行 6 项通过。日志 `/tmp/cmb-plugin-shared-store-{repro,fixed,tests,mods,types,build,process}.log`。此修复晚于文首整仓门禁；它不代表插件面板已经接通。

### 审批通知 Hook（2026-10-03）

- 复用 Cmb 原审批通知事件、事件匹配、命令/HTTP/模型 Hook 执行器和工具中间件。手动审批触发 `Notification / permission_prompt`，保留原工具名称与有效参数；规则/自动批准和普通提问不触发通知。补齐共用 Hook 输入中的 `notification_type` 字段，技能导入预览同步支持此事件。
- SQLite v38 为通知执行建立独立阶段和第二个审批通道。原操作与通知脚本分别授权；先批准任意一项都不会放行另一项。通知执行能力绑定任务租约、阶段、具体操作摘要和异步作用域，拒绝递归通知、普通工具借用和过期回调。取消、补充要求、中断、恢复及备份还原同步处理阶段状态。
- 安全输入通道在通知之前登记；用户可以先提交密码，再处理通知审批。密码不进入 Hook 输入、模型请求或持久任务记录。页面分别显示两张审批卡，通知卡明确说明授权范围；补齐相邻卡片间距。
- 状态/迁移/备份/原 Hook 执行器 6 文件 97 项通过；实际模型协议执行图 5 项通过，覆盖两种顺序、拒绝通知、取消、普通问题及已保存规则。真实浏览器安全输入 2 项通过。编译 Host 实际 SIGKILL 后续接第二条通知，第一条完成收据保持不变，原操作仍需批准（1 项通过）。进程测试首次将通知脚本误放入私有 Host 数据目录而被既有保护拒绝，修正夹具路径后通过，未放宽保护。
- 实际 React 工作区旅程通过；补充间距和精简重复说明后再次通过（`/tmp/cmb-notification-ui-final.log`），最终截图 `output/bot-workspace/notification-approval.png` 已检查。Node/Web 类型、构建通过。日志 `/tmp/cmb-notification-{contracts,graph3,secret-browser,process3,final-types,build}.log`。随后完整 `npm test` 全部通过，见文首；Notification 与 v38 尚未计入文首旧安装包。

### macOS 凭据加密适配（2026-10-03）

- 参考 Grok `user-secrets-store.ts` 的 Electron `safeStorage`，保留 Cmb 已有凭据 Vault、Bot/网站/版本约束和原子写入。macOS Host 通过同一安装包的无窗口辅助进程访问系统钥匙串；启动入口在加载桌面服务和单实例锁前分流，桌面退出后仍可使用。Windows 继续使用现有 DPAPI，Linux 保留外部保护器接口。
- 凭据仅经匿名管道传输，输入输出和进程时间均有限额；拒绝畸形输入后才访问钥匙串，原生错误不进入界面或日志。关闭 Vault 先终止辅助进程；父进程生命管道断开后辅助进程退出。加密失败不改旧文件，临时解密失败可刷新重试，损坏内容不会被当作空凭据覆盖。
- 凭据窗口按实际保护器展示 macOS、Windows 或会话保存说明。该能力仅覆盖 Bot 网站凭据，不代表模型配置或所有应用数据均已系统加密。
- 5 文件 42 项通过（`/tmp/cmb-mac-secrets-tests2.log`），覆盖二进制往返、严格输入/容量、原生失败/超时/关闭、Vault 重开/临时拒绝/旧数据保护以及辅助进程依赖隔离。最初一项测试夹具漏传 stdin，修正夹具后通过。真实钥匙串、正式签名升级及 Windows 实机仍待验收；实际凭据进程测试在 macOS 需显式 `CMB_BOT_KEYCHAIN_TEST=1`，普通自动回归不访问个人钥匙串。
- 真实 Electron 辅助进程的畸形请求、父连接断开 2 项通过（`/tmp/cmb-mac-secrets-process2.log`），没有创建桌面设置/Bot 数据库，也没有输出请求内容。首轮暴露文件流读取生命管道会占用线程并拖住退出，改用 Node 额外 stdio 的非阻塞 Socket 后通过。Node/Web 类型、ESLint 和构建通过；整仓回归及同版安装包继续验证。Electron 39 使用其现有同步 API，仍需正式签名与系统授权验收，参照 [Electron safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage)。
- 随后将生命管道与 30 秒硬截止放入独立 Node worker，防止主线程同步等待系统授权时无法观察父进程退出；该 worker 不接收任何凭据。实际子进程用 `Atomics.wait` 阻塞主线程，父管道关闭后仍由 worker 终止进程，专项通过。最终领域/边界 6 文件 43 项通过（`/tmp/cmb-mac-secrets-final-tests.log`），相关 ESLint 0 错误。此补充晚于上述完整主测试组；实际最终 Electron/安装包仍继续验收。
- 最终 Node 类型、构建、独立 Electron 及安装包进程 2 项、完整桌面旅程 5 项均通过（`/tmp/cmb-mac-secrets-final-{types,build,process,desktop}.log`、`/tmp/cmb-mac-secrets-packaged-helper.log`）；Web 类型已在本轮界面改动后通过。实际加密成功、系统授权拒绝与正式签名升级仍需显式钥匙串验收，未用协议/模拟保护器测试代替。

### 三平台持续集成入口（2026-10-03）

- 现有 CI 的 Node 版本改为跟随仓库 `.nvmrc`（22），保留 Windows/macOS/Linux 构建矩阵，并在各平台构建后运行 11 个 Bot 存储、迁移、锁、群聊、工作流、审批和凭据测试文件。凭据 worker 测试不访问 macOS 钥匙串；Windows 专项只对新生成的随机字节调用真实 CurrentUser DPAPI。
- 在本机运行同一测试集合，10 文件 120 项通过、Windows DPAPI 1 项按平台跳过（`/tmp/cmb-bot-ci-contracts.log`）；CI YAML、文件路径及格式校验通过。没有推送或触发远端 CI，不据此宣称 Windows/Linux 已运行通过。

### 技能试跑消息展示（2026-10-03）

- 试跑消息按现有持久试跑记录投影为技能名、固定版本、任务输入与验收条件；完整执行说明默认折叠，侧栏使用简短试跑摘要。普通用户粘贴同样的英文提示仍是普通消息，不按文字猜测来源。历史技能改名、停用及数据库重开不会改写试跑名称和版本。
- 原消息正文、模型执行输入、检查点与显式搜索原文保留；模型上下文不带新增展示字段。未新增试跑数据或迁移行数据。
- 查询补入 `bot_trial_trigger_message` 部分索引，避免侧栏轮询扫描全部任务；现有 v37 数据库重开时可补建，不改变数据版本或试跑记录。迁移/试跑 3 文件 29 项通过，真实查询计划使用该索引（`/tmp/cmb-skill-trial-index-tests.log`）。
- 4 文件 13 项通过（`/tmp/cmb-skill-trial-presentation-tests.log`）。实际 React/Chrome 工作区完整旅程通过，新增卡片默认折叠、展开及再次收起的断言；`skill-trial-message.png` 已检查（`/tmp/cmb-startup-ui-budget-browser.log`）。Node/Web 类型与构建通过（`/tmp/cmb-startup-ui-budget-{types,build}.log`）。

### 长任务模型输入预算（2026-10-03）

- 将 Cmb 原纯预算计算、图压缩参数与摘要提示词提取到 `context-compaction-config.ts`，桌面与 Bot 共用；摘要提示词逐字保留。Bot 从原固定 70% 触发、保留 12 条消息，改为预留所选模型的输出额度、按 token 保留近期上下文、压缩后复核输入预算，并复用原摘要溢出恢复策略。
- 同步修复原摘要中间件快速路径：大工具结果临时截短后仍超过输入预算，继续走原摘要流程，不能直接向主模型发送超限请求。原完整工具结果仍在检查点中。过小输入预算连固定系统/工具定义都放不下时沿用 Cmb 明确拒绝，不承诺任意模型配置都可运行。
- 4 文件 99 项通过（`/tmp/cmb-context-budget-final-owner2.log`），覆盖原预算参数和真实 HTTP/SSE 图的提前摘要、过大摘要再次缩减、大工具结果、取消及检查点恢复；已完成文件修改的收据保持不变，仅重新审批未完成操作。主 Bot 冒烟 1 项、角色/并行子任务 5 项通过。两个泛用图夹具原 16k 上下文改用产品默认值，预算专项保留 32k/20k，未放宽产品校验。
- Node/Web 类型、构建通过；相关 ESLint 0 错误，原 runtime/摘要器未改行保留 30 条格式警告。模型为受控本地夹具，尚不代表用户模型的摘要质量或供应商精确 token 计数。

### 桌面连接与慢启动（2026-10-03）

- 原来固定 50 次、每次 100ms 的启动等待，会把超过约 5 秒的冷启动判为失败；新增回归先在原实现复现该问题（`/tmp/cmb-host-startup-before.log`）。改为以单调时钟控制 30 秒启动窗口，新建连接单次探测最多 3 秒，超时关闭对应探测连接，迟到响应不能发布为当前连接。已提交任务仍使用原 RPC 超时和持久请求语义。
- 多个桌面请求继续共用一次启动；竞争进程因未取得锁正常退出时等待真正的持锁 Host。异常退出或无法创建进程及时显示错误，允许后续重试；超时不杀后台进程。仍由原 Host 原子检查空闲状态后决定升级，活跃任务、审批和浏览器接管阻止重启。
- 安装包验收发现维护过程中 Host 正常退出删除描述文件，与“先检查存在、再读取”之间发生竞态，导致保存恢复点报 ENOENT。改为直接读取并只将 ENOENT 视为文件已移除；真正维护仍由进程锁排他，其他 Host 替换描述文件继续拒绝。新增对应时序及替换身份回归。
- 启动、升级与进程锁 3 文件 17 项通过（`/tmp/cmb-host-startup-maintenance-tests.log`）；Node 类型、相关 ESLint、构建和临时签名打包通过。修复后的 macOS arm64 包 `/private/tmp/cmb-bot-maintenance-fixed-package-Qkvn59/mac-arm64/CMBDevClaw.app` 完整桌面旅程 5 项通过：离线执行、重开读取、浏览器接管、实际版本及 Cookie/localStorage 备份恢复（`/tmp/cmb-startup-maintenance-{build,package,desktop}.log`）。该包早于后续 macOS 凭据适配；慢启动模拟及此安装包测试不能代替 Windows 实机或真实模型验收。

### 子任务项目规则与职责范围（2026-10-03）

- 复核确认 Bot 已复用 Cmb 原 `discoverAgentsFiles/readAgentsFiles/renderAgentsPrompt`，只读取获授权项目内的规则，不读取父目录；本轮没有重复编写加载器。
- 补齐与 Cmb 工作流角色一致的上下文规则：只读、无 Shell 角色不自动注入项目 AGENTS；显式禁止项目读取的角色也不经提示词获取文件正文。完整编码角色继续继承工作目录规则。子任务使用明确交办的任务与角色指令，不再自动带入主 Bot 的长期职责；主 Bot 自身职责不变。无 Shell 仅表示禁止 Shell，其他工具仍按该角色的独立权限裁决。
- 实际 Cmb 执行图验证 full/read_only/none/禁止读取四种角色，明确角色与任务保留、项目和父级私有内容范围正确；并行子任务与原独立 Git 工作区编码、审批、提交、合并旅程通过。6 项通过、26 项未重复（`/tmp/cmb-child-context-tests2.log`）。最初用例将无 Shell 误等同于禁止文件编辑，已按现有独立权限合同修正断言，未扩大产品权限。
- Node 类型和相关 ESLint 通过（`/tmp/cmb-child-context-types.log`、`/tmp/cmb-host-context-lint.log`）；模型仍为本地 HTTP/SSE 夹具，不代表真实模型效果。完整执行链其余缺口不因本项修正计为完成。

### 常驻后台日志容量与诊断（2026-10-03）

- 抽取 Cmb 原有日志参数投影，与原脱敏模块共同用于桌面和独立 Host；原桌面过滤、队列和历史迁移逻辑保留。新 Host 先取得进程锁、安装日志，再加载运行时；桌面不再长期向子进程传递追加文件描述符，关闭桌面后仍可记录诊断，模块加载/启动失败也能落入日志。
- 每个新日志文件最多 5 MiB，保留当前文件与两代轮转；单条参数、递归、UTF-8 字节及属性扫描有界，拒绝链接/特殊文件和被替换根目录。写盘或轮转失败只累计遗漏条数，恢复后写入提示，不追加无限缓存、不让日志错误终止任务。已有超大旧日志首次轮转原样保留，后续轮转淘汰；不宣称追溯清洗旧文件。
- 日志/原桌面脱敏/无界面依赖共 3 文件 25 项通过。编译后的 Electron Host 在忽略标准输出时完成任务、退出重启保留结果，独立竞争进程不写当前日志，启动失败仍有诊断且进程退出释放锁；3 项通过、50 项未重复。首次进程断言误用任务状态名称与快照消息接口，已改为原 runHistory/messages 合同，产品行为未为测试降级。
- Node 类型、构建及相关 ESLint 通过。日志 `/tmp/cmb-host-log-{tests,process3,types2,build,lint}.log`。仅 macOS 的 Electron/Node 实测；Windows 文件占用下的轮转和 Linux 运行环境仍需平台验收。动作审计继续由原 SQLite 收据承担。


### 共享工作文件恢复点与重置（2026-10-03，CPU-12/13 工作文件部分）

- 在持久共享目录上接通保存、删除、恢复与重置，从原“备份与恢复”进入。复用 Cmb 稳定文件句柄、备份字节复制、后台空闲停机及维护子进程；界面与浏览器维护共用操作确认和响应丢失后的核对流程。每个 Host 最多 20 份恢复点，每份 20 GiB / 50,000 个条目，包含普通文件、空目录、修改时间和文件权限；拒绝符号链接、硬链接和特殊文件，不宣称完整系统或虚拟机快照。
- 恢复绑定当前 Host 的共享目录身份与平台。文件逐项校验后在同一文件系统替换，操作前自动保存恢复点，旧目录原样保留为 recovery 文件夹，外部编辑器持有的旧文件也不会因自动清理而丢失。持久日志记录原目录、新目录和请求身份；启动先完成恢复，再启动任务。恢复不回退 Bot 对话、任务和外部操作记录，不处理自选项目及独立代码工作区。
- 后台互斥锁贯穿异步替换；错误身份、损坏快照、替换暂存、链接数据库在移动当前目录前拦截。7 个中断点恢复后只记录一次替换事件。相同请求可核对旧收据，不重复替换后续编辑；已删除恢复点的旧创建请求不能重新创建。未发布暂存可清理，缺少日志但含旧文件的目录不自动删除。
- 基础目录快照 8 项、共享目录 11 项、文件维护 17 项通过。相关备份、浏览器维护与 IPC 合计 6 文件 143 项通过（早于补充 2 项清理/异源恢复测试）；补充后选择组 118 项通过。实际 React / Chrome 验证保存、恢复、重置、删除、取消、响应丢失后重试和提交后刷新失败，浅色、深色与窄屏截图已检查。编译后的 Electron Host 在移动旧目录、更新目录身份两个位置被 SIGKILL，重启恢复后 Bot 成功读取原文件，真正的维护子进程可核对已完成请求且不覆盖后续修改（2 项通过 / 49 项未重复）。
- 日志 `/tmp/cmb-workspace-{owner,integrated-tests,brand-tests,browser,process,types2,webtypes,build}.log`、`/tmp/cmb-browser-shared-ui-regression.log`。Node/Web 类型、构建通过；新代码 ESLint 的控制字符正则和未使用变量已修正。仅 macOS 实测，Windows 与 Linux/K8s 仍待平台验收。

### 可见名称与界面细节（2026-10-03）

- 按用户要求仅统一可见产品名为 **CMBDevClaw**：Bot 设置、技能入口、帮助/诊断、用户错误提示及浏览器扩展名称。保留内部代码标识、数据目录、配置键、模型提示词和消息链接协议；曾尝试的协议改名已撤回。示例中的旧数据目录字面量改用“应用数据目录”说明，实际文件路径按真实值显示。
- 创建 Bot 使用已有 Select 控件，表单圆角、边框、间距与焦点样式统一；连接器增加一致尺寸的图标、选择状态及完整行点击区域。共享目录长路径按需展开，保持可查看和复制；保存期间禁止继续编辑表单。维护入口采用一致图标和布局。
- 实际 React 工作区完整交互旅程通过，更新后的设置界面截图已检查（`output/bot-workspace/connector-editor.png`）。首次因测试仍要求折叠路径直接可见而失败，已改为展开检查再折叠，未删除路径可达性断言。日志 `/tmp/cmb-brand-workspace-ui2.log`；Node/Web 类型通过。


### 持久共享工作目录（2026-10-03，FIL-07 接续）

- Host 建立独立于密钥/数据库的受控工作目录，并在私有控制目录记录稳定身份。新建及原来未指定项目的 Bot 使用同一工作目录；已指定项目保持原目录，设置中清空项目路径后使用共享目录。模型、连接器和项目文件权限沿用现有链路，文件修改继续审批；没有把共享目录称为 Bot 之间的安全隔离区。
- 复用 Cmb 稳定文件句柄、原项目文件工具、跨 Bot 写锁和内容版本校验。两个 Bot 基于同一版本提交修改时仅接受一个，另一个必须重新读取；补齐项目读取、图片/文档和搜索的硬链接拒绝，防止从项目内链接读取范围外文件。目录丢失/被替换时拒绝执行，不静默创建空目录掩盖原文件缺失。
- 初始化记录先落盘再创建目录，首次创建中断可从空的准备状态续接；非空未就绪目录、符号链接及不合法身份均拒绝自动接管。原创建请求按用户提交参数计算摘要，升级引入默认目录后仍可使用原 nonce 核对旧收据。工作目录不随 Bot 删除清理；当前数据备份不包含工作文件，恢复/重置范围已在界面明确，工作文件恢复点现已接通，见上节。
- 领域与项目文件 23 项通过，实际模型执行图验证 Bot A 审批写入、Bot B 读取和目录替换前置拒绝；所用模型为本地协议夹具。完整 React 工作区旅程通过，创建界面截图已检查。编译后的独立 Host 实际退出/重启后保留路径和文件，新 Bot 能读取，基础模型检查也通过（1 项通过、48 项未重复）。Node/Web 类型、构建、相关 ESLint 通过。日志 `/tmp/cmb-shared-workspace-{tests2,graph,browser,owner3,process,types3,web3,build,lint2}.log`。随后完整 `npm test` 退出码 0：主组 625 文件、5038 项通过，13 文件、125 项跳过；后续消息/Hooks/插件/工作流/桌面基线/IM 全部专项通过（`/tmp/cmb-model-workspace-full.log`）。该门禁覆盖模型检查与共享目录，早于共享工作文件恢复点实现。

### 用户配置模型的基础能力检查（2026-10-03，ACC-09 接续）

- 在 Bot 设置的模型选择下接入文字、工具调用和图片输入检查，复用 Cmb 原模型工厂与已保存配置。只发送随机标记和六张合成颜色图；工具检查仅核对返回名称与参数，不执行工具。结果仅代表基础样例，不当作实际任务质量、权限或自动路由依据。
- 每项检查最多 20 秒，不自动重试；最多两个并发，按 nonce 复用原结果。仅 Host 读取配置和密钥，渲染层不能提交任意接口地址。拒绝重定向，限制响应 128 KiB，不将上游错误正文返回界面；客户端断开、用户取消及 Host 停止均中止在途检查。
- 界面切换模型/关闭时取消旧请求，迟到结果不覆盖新选择；每次响应核对配置身份，连续检查之间配置变化清除旧结果。旧 Host 未声明能力时不展示入口。检查按用户操作发起，界面说明请求计费和测试数据范围。
- 真实 HTTP/SSE、模型工厂和受认证 Host 传输共 14 项测试通过；IPC 76 项（含非主窗口拒绝）通过。真实 React/Chrome 验证三类结果、模型切换、取消、配置变化、错误恢复及窄屏；深浅主题截图已检查。Node/Web 类型、构建、相关 ESLint 通过。日志 `/tmp/cmb-model-check-{tests2,browser,types2,web2,build,lint}.log`。未调用付费模型，不能据此宣称所有外部提供商兼容或模型质量通过。

### macOS 打包版桌面与后台验收（2026-10-03）

- 打包应用已验证真实 Electron/预加载/IPC/独立 Host：桌面退出后任务继续完成，重开加载原 Bot 和结果；界面接管真实 Chrome、导航、发送键盘输入并归还控制权，报告真实浏览器与 Electron 版本。模型使用本机 SSE 夹具；企业身份使用隔离测试资料及登录响应夹具，未改动正式企业登录逻辑，不能据此称企业 SSO 或真实模型质量已验收。
- 初始空白窗口实际来自离线环境下企业登录页加载失败；前两版夹具还存在模型上下文参数低于应用下限、重复文本定位，以及未等浏览器退出就删除临时目录的问题，均在测试侧修正。最终 `/tmp/cmb-bot-desktop-final.log` 命令退出码 0；截图 `output/bot-desktop/desktop-{running,about,browser}.png` 已检查。后续新增浏览器维护流程在新版包中继续验证，见下一节。
- 应用在普通本机临时目录中打包，使用已安装的同版本 Electron 39.8.10 分发目录。`after-pack.js` 只在签名前清除新应用包的扩展属性；已通过 `codesign --verify --deep --strict`。当前为本地临时签名，未做发布签名与公证。默认 Electron 解压路径曾缺少启动二进制，Desktop 输出目录还遇到文件扩展属性导致的签名失败；尚未将默认发布命令记为通过。

### 工作浏览器恢复点与重置（2026-10-03，CPU-12/13 浏览器部分）

- 参考 Grok 电脑设置中的共享环境影响说明、重置确认与进行中保护。实现复用 Cmb 稳定文件句柄、字节摘要、目录刷盘、后台空闲停机与进程生命周期锁；两类本机维护共用原备份子进程协议。没有把原 Grok 客户端的云端重建 RPC 当作可直接移植的服务端。
- 从“备份与恢复”进入，支持创建、删除恢复点及恢复/重置专用浏览器。恢复和重置前自动保存当前 profile；每用户最多 20 份、单份 2 GiB/50,000 个条目。保留 Cookie 与站点存储，限定同平台/浏览器，提示仅供原电脑使用、站点失效登录需重新认证；不承诺跨机复制登录凭据。项目文件、任务/操作收据、普通浏览器及系统设置不在操作范围，标签页重新打开。
- 维护排斥运行中的 Host、任务、服务、示范与人工接管；请求不向模型工具暴露。严格解析标识和摘要，拒绝越界路径、符号链接及浏览器遗留进程锁。暂存文件逐项哈希核对，恢复日志在新环境、数据库目标失效和操作收据持久后才清除。启动先续接恢复再打开运行时；不回滚外部操作记录或将旧文件推断为“操作未执行”。响应丢失使用同一 nonce 核对，界面刷新后保留待确认请求。
- 领域 11 项、维护/IPC/无桌面依赖边界等合计 4 文件 95 项通过；原数据备份 17 项与相关 IPC/维护测试在前一轮通过，新领域初次使用错误的数据库适配器查询方法，已修正夹具断言。真实 Chrome 已验证持久 Cookie、本地存储恢复及空白重置。五个断点模拟恢复和两个真实 SIGKILL 后编译 Host 启动恢复通过。实际 React 界面验证创建、恢复、重置、删除、取消和响应丢失后重试，深浅截图已检查。
- 补充数据库硬链接检查，领域 12 项通过，恢复不得修改链接指向的其他数据库。新版 macOS 打包桌面已串联 UI、IPC、维护子进程和真实 Chrome：保存恢复点、清空 Cookie/站点数据、恢复原数据全部通过；桌面退出后持续工作及重开结果仍通过。修复提交成功后的工作区刷新未处理异常，并覆盖刷新失败不会重做恢复。夹具另补等待维护后刷新完成再退出弹窗，未放宽产品保护。
- 日志 `/tmp/cmb-browser-maintenance-{owner-final,path,live2,process,ui3,types3,build3,package3,desktop5}.log`。后端/Web 类型、构建、打包与桌面串联已通过；全量回归继续执行。临时签名应用首启曾在原追踪模块同步钥匙串访问中等待，测试关闭可选追踪日志后验证 Bot 流程，未改变正式加密策略；发布版钥匙串授权仍需验收。此项仅关闭浏览器恢复/重置部分，项目工作文件统一恢复与通用桌面环境部分尚未完成；Windows 实机、Linux/K8s 实机及生产发布仍未验收。

### 命令面板与会话访问历史（2026-10-03，UI-05 接续）

- 直接移植 Grok 命令面板的 Unicode 规范化、分词模糊评分、键盘高亮、数字选择和虚拟列表几何，以及前进/后退状态转换。接入现有 Cmb 对话、全文搜索、设置、技能/记忆/例程和浏览器入口；快捷操作打开原界面，权限和确认仍由原入口处理。来源与摘要记录于 renderer PROVENANCE。
- Ctrl/Command+K 打开统一面板，支持全部/消息/Bot/群聊/文件/链接/例程/操作分类、嵌套工具菜单、上下选择、回车、数字直达和中文输入法。隐藏 Bot 仅在查询匹配后显示；内容查询有页数预算、继续搜索、暂停和旧响应隔离。列表只挂载可见行及缓冲行，500 个会话测试维持少于 25 个 DOM 行。
- 会话历史存入原 Zustand 工作区，最多 200 次访问，数据恢复后清空；前进/后退跳过不可用或隐藏会话，新选择截断前进历史。修复键盘切换后输入框重建导致焦点丢失，草稿继续按原会话保存。
- 领域/消息状态专项 4 文件 18 项通过；真实 React/Chrome/领域搜索验证完整历史续查、过期请求、暂停、隐藏条目、嵌套操作和输入法。真实工作区整条交互旅程通过，含快捷入口、前进/后退和草稿保留。深浅截图 `output/bot-palette/palette-{light,dark}.png` 已检查。日志 `/tmp/cmb-palette-{store,browser2,workspace3,final-types,final-lint,final-build}.log`；Node/Web 类型、构建和相关 ESLint 通过。
- 补充 Ctrl/Command+B 紧凑侧栏和 Ctrl/Command+Shift+M 技能入口；侧栏偏好本机保存，小窗口与手动收起都保留展开控件。连续切换会话改为布局提交时恢复输入焦点，真实工作区旅程通过（`/tmp/cmb-compact-workspace2.log`）；紧凑侧栏截图已检查。搜索续页插入结果时按条目 ID 保留用户选择，避免回车打开另一项；实际 Chrome 回归通过（`/tmp/cmb-palette-selection-browser.log`）。
- 完整 `npm test` 退出码 0：主组 623 文件、5004 项通过，13 文件、124 项跳过；后续消息、Hooks、插件、工作流、桌面执行及 IM 全部专项通过（`/tmp/cmb-maintenance-palette-full.log`）。此门禁早于随后紧凑侧栏补充，不代表 Windows、Linux/K8s 实机或整项 UI-05 已验收。

### PDF 页图像、局部放大与项目文档读取（2026-10-03，FIL-02 接续）

- 继续复用 Cmb 的 PDF.js 加载配置、原生 Canvas 和独立文档进程；Grok 本地恢复源码的 `pdf-utils.ts` 只保留分类器，未提供可直接移植的完整 PDF worker。没有另写 PDF 解码器。附件 `read_file`、技能 `read_skill_file` 支持指定 `pdf_page` 查看扫描页、图表和排版，`image_region` 按旋转后的 96 dpi 页面坐标裁剪；原文件不修改。
- 新增 `project_view`，使用原项目稳定文件句柄与路径校验读取文档和图片，无需先发布为附件。子任务继承 `read_file` / `project_read` 的禁用限制；插件原 SDK 文件读取合同保持原样。代码编辑仍通过 `project_read` 获取准确版本。
- 单次只渲染一页/局部，沿用 25 MiB 输入、2048 像素/1 MiB 模型图片、15 秒可取消子进程；页面及临时画布限制像素，最多 1000 页。发现 PDF.js 6.3.289 在部分解析错误后会返回空白/残缺操作列表，已通过该文档独占 worker 的公开消息端口捕获解析失败和空图片结果，拒绝把残缺页面作为成功读取。未修改依赖包或共享 worker。
- 实际扫描 PDF、旋转与裁剪颜色像素、页码/尺寸越界、过大嵌入图片、损坏图片和后续正常读取等，与原文档解析共 2 文件 15 项通过。真实 LangGraph、本地模型响应夹具与实际文档进程验证附件/技能/项目三种路径，连同原 Word 与图片回归 5 项通过。日志 `/tmp/cmb-pdf-reader3.log`、`/tmp/cmb-pdf-graph2.log`。这证明图像正确进入模型请求，不代表实际配置模型的视觉识别准确率已验收；Windows 与 Linux 原生运行仍待实机验证。

- 本轮后 Node/Web 类型、构建、编译后的 Electron 文档进程测试均通过。完整 `npm test` 退出码 0：主组 623 文件、5010 项通过，13 文件、124 项跳过；后续专项全部通过（`/tmp/cmb-pdf-full.log`）。此门禁覆盖紧凑侧栏及 PDF，早于下述模型检查接入。

### 独立模型操作审核（2026-10-02，APR-01/02/03 部分接线）

- 直接复用 Grok 的规则条数、长度及标准化实现；原客户端把分类请求交给云端 DashboardService，提供的源码不含该服务的判定实现。Cmb 使用已有配置模型与原无工具 function-completion 通道实现独立审核，不声称移植了 Grok 云端分类器。新建 Bot 默认关闭，用户在审批规则中开启并配置允许/先询问规则。
- 当前接通前台及任务内后台命令、项目修改、模型/插件 SDK 连接器的统一审批入口；凭据、常驻服务、权限变更及缺少任务授权上下文的来源继续人工确认。例程创建/更新与协作派发已接入（见下一节），浏览器基础操作继续接入（见下文），高级动作及非人员来源任务的审核仍未完成，不能把 APR-01 标为整项完成。原有工具权限、强制 Mods 策略、沙箱和工作副本限制继续执行。
- 审核仅接收当前用户任务、已采纳补充要求、已有拒绝记录及最终操作；历史导入和其他 Bot 的陈述不作为新授权。单次审核不配置工具，不自动重试，20 秒超时，最大 2048 输出 token，计入原共享任务预算。格式错误、服务不可用、内容超限转人工；命令先询问规则和同任务的同参数拒绝不交模型覆盖。自然语言规则的语义判断仍依赖用户配置模型，真实模型质量尚未验收。
- SQLite v33 保存设置版本、实际审核理由、模型、完整参数摘要及任务依据。执行前检查设置、命令规则、Bot 版本、任务要求、数据代际及 10 分钟有效期；延迟结果不能附着到更新后的授权。备份恢复关闭自动审核，复制 Bot 不复制审核设置。审核开启与旧调用并发时，未审核操作不能沿用已保存命令规则。
- 界面复用现有审批弹窗、主题、Switch 和按钮；提供命令规则/自动审核页签、人工确认理由与任务历史。保存响应丢失后保留原请求，重开可确认；确认旧请求后重新读取当前设置。首次真实 React 工作区旅程通过，深浅色截图已检查（`output/bot-workspace/auto-review-{dark,light}.png`）；确认旧请求后的当前设置读取已复测通过。
- 真实 LangGraph + 本地 SSE + 原生命令测试覆盖允许、先询问、坏格式、服务不可用；另有审核途中撤销设置与取消任务 2 场景通过。领域/规则/脚本 3 文件 30 项通过，RPC/备份/IPC/命令 5 文件 133 项通过。编译 Host 实际 SIGKILL 1 项通过/38 跳过：已审核的连接器在途调用恢复为待核对，审核理由和设置收据保留，调用没有重发。
- 日志 `/tmp/cmb-auto-review-{second-tests,fence,domain-final,owner,process,ui,types-final,build}.log`。初次领域新增测试选用了原 Cmb 禁止保存规则的 `git` 命令，已改为有效且绑定脚本的 `npm test`；最终领域 30 项通过。Node/Web 类型与构建已通过；该版完整 `npm test` 退出码 0，主组 605 文件、4832 项通过，后续集成组通过（`/tmp/cmb-auto-review-full.log`）。没有宣称 Windows 实机或生产验收完成。

### 例程与 Bot 协作审核（2026-10-02，APR-01 接续）

- 沿用原例程与协作队列，审核冻结例程的完整指令、时间锚点、触发条件及前一版本；协作冻结接收 Bot 的职责、模型、项目和连接器范围。确认期间例程或接收方配置变化，旧请求不会覆盖或继续派发。此处审核的是创建计划/派发任务；后续执行仍使用各任务原有权限和审批。
- 原执行收据继续负责去重，包括运行中启停审核后重放旧工具调用。例程及协作写入与审批消费在同一事务提交；修复工具收据嵌套时过早清除事务作用域的问题，验证内外层写入/收据/效果一并回滚，重试只提交一次。
- 长审批完整保存在 Host，工作区不批量携带全文；通过现有任务详情接口按需读取，加载成功前不提供批准按钮。支持 64k 例程指令的完整 JSON 转义，不以截断正文作为审批依据；工具返回超长结果提供预览，保存的指令保持完整。凭据请求继续使用安全输入卡。
- 领域、收据、RPC、历史关联 7 文件 80 项通过；真实 LangGraph + 本地 SSE 的例程/协作允许和拒绝 4 场景通过，另有长内容及固定计划 2 项通过。实际 React 工作区验证长内容加载失败重试、例程确认、协作拒绝和批准；深浅色截图已查看。展开全文与职责详情后保持操作按钮可见，滚动行为已复测。
- Windows 脚本补充识别大小写及明确的盘符、UNC、相对路径；路径不明、变量展开或 PATH 查找保持人工确认，不把包管理器同名路径当作可信启动器。相关 3 文件 25 项通过；这只验证解析与审批规则，不代表 Windows 执行验收。
- 编译 Host 的独立审核连接器 SIGKILL 场景再次通过，保留不明结果而不重发。日志 `/tmp/cmb-dispatch-{owner,graph,process,ui}.log`、`/tmp/cmb-win-candidate-final.log`。本节后端修改的完整 `npm test` 退出码 0：主组 607 文件、4850 项通过，后续全部集成组通过（`/tmp/cmb-dispatch-full.log`）；该门禁先于后续浏览器审核接线。

### 浏览器实际目标审核（2026-10-02，APR-01 接续）

- 直接移植 Grok 浏览器动作的只读分类与参数长度规则，保留原页面/标签身份核对思路；Cmb 从实际浏览器读取当前网址、表单提交地址、标签及输入框属性，不以模型自述用途代替真实目标。只读取目标语义，不读取输入框已有值、Cookie 或站点存储。
- 原 Grok 驱动继续执行点击与输入。审核绑定实际页面 Document 和 DOM 元素句柄；确认后及 Broker 串行执行边界分别核对。页面跳转、同址刷新、目标被替换、表单地址变化、焦点变化及接管使旧请求失效。其他 Bot 的页面不进入本 Bot 的审核身份。已完成操作先读取持久收据，不因旧元素消失而重发。
- 导航、元素点击/填写/键盘及标签修改接入原独立审核入口；敏感输入、坐标/拖动、高级调用、超长目标和缺少用途的点击继续人工确认。独立下载工具已接入，见下文；人员任务派发的工作流子任务已扩展审核授权上下文（见下节），例程来源仍未扩展。不会把网页脚本语义或模型判断质量称为已证明的安全保证。
- 实际 Chrome 的目标、变化拦截、焦点及不读取原值验证，与原共享登录/导出/接管用例共 22 项通过。真实模型图的允许、拒绝、人工确认期间表单变化及安全凭据原流程共 4 项通过（与目标单元合跑 14 项通过）。最终 Node/Web 类型与构建通过；编译 Host 独立审核连接器 SIGKILL 场景复测通过。该进程用例不是浏览器 SIGKILL 验证。
- UI 增加实际目标和当前页面。首次新增截图用例未声明测试网页 UTF-8，浏览器按错误编码解码标签导致断言失败；修正的是测试网页响应编码，产品读取及显示保持实际页面内容。修正后完整 React 工作区旅程通过，`output/bot-workspace/browser-review-target.png` 已检查。另修复工具中间件在已完成浏览器收据重放前仍等待电脑的遗漏，真实图验证旧目标已失效且电脑不可用时仍返回原收据，没有重新打开浏览器。日志 `/tmp/cmb-browser-review-{owner,graph,ui-final,process}.log`、`/tmp/cmb-browser-replay-final.log`。
- 首次合并全量有一个原迁移用例 5 秒超时，单文件复跑 8 项通过；停止并行构建和浏览器测试后，独占完整回归主组 608 文件、4852 项通过，106 项跳过，后续全部集成组通过，完整命令退出码 0（`/tmp/cmb-browser-exclusive-full.log`）。该结果先于子任务生命周期接线，不代表后续修改已通过全量。

### 子任务生命周期与委派操作审核（2026-10-02，标准执行链与 APR-01 接续）

- 复用 Cmb 的 SubagentStart/Stop 上下文构造、Hook 执行器和停止判定。工作流传递解析后的角色名，显示名称不代替角色匹配；检查绑定子任务租约、权限和工作目录，并行任务各自审批。启动检查被拒绝时不调用子任务模型；完成和失败分别保存结束状态。取消、撤权和未知效果不会追加未经核验的清理操作。
- 结束检查及其停止要求持久保存，父任务在继续调度、执行工具和生成回复前检查。即使工作流脚本捕获子任务异常，停止要求仍有效。恢复使用已保存的最终答复和检查收据，不重跑子任务工作。真实编译 Host 在第二个结束检查前 SIGKILL/恢复已通过：首个检查只执行一次，子任务模型不重调，父任务取得原子任务成果。
- 人员任务派发的同 Bot 子任务接入独立操作审核。审核接收父任务的实际用户要求、按消息顺序采纳的人工补充、分工、角色指令和工具边界；Bot 补充说明单独标为非授权数据。审核使用父任务配置模型，子任务可继续使用其他执行模型，父任务私有上下文不注入子任务执行模型。父任务及同组子任务的人工拒绝会进入审核依据，补充指令、分工说明或拒绝记录变化使旧自动批准失效。例程、事件、跨 Bot 委派来源仍保持人工确认，不能借子任务变成人员授权。
- 领域、配置、队列及无桌面依赖边界 6 文件 56 项通过；完整子任务真实图 26 项通过，另加不同模型路由下允许/转人工拒绝 2 场景通过。原工作流门禁、Node/Web 类型、构建及相关 ESLint 通过。首轮新增测试的项目配置格式和包装异常断言已按原合同修正；子任务人工消息保留原系统标签，没有为测试改写产品消息。编译 Host 恢复场景 1 项通过/39 跳过。全部模型用本地 SSE 夹具，不代表真实模型判定质量或 Windows 验收。
- 日志 `/tmp/cmb-child-lifecycle-{owner3,graph4,workflow,process}.log`、`/tmp/cmb-child-review-{domain2,graph}.log`、`/tmp/cmb-child-final-{owner,types,lint,build}.log`。补入完整角色指令字段后，Node/Web 类型、构建及完整 `npm test` 全部退出码 0：主组 609 文件/4873 项通过，12 文件/111 项跳过，后续集成组全部通过（`/tmp/cmb-child-last-{types,build}.log`、`/tmp/cmb-child-exclusive-full.log`）。此结果早于独立下载工具接线；Setup、Notification 及完整标准任务准备链仍未完成。

### 下载目标审核与已完成文件恢复（2026-10-02）

- 独立下载复用 Grok 元素点击、原 Chromium 下载路由及文件成果接收。直链、表单/POST/Blob 导出接入已有独立审核；表单按钮的提交地址、方式、编码和目标窗口均绑定实际 DOM。审批前后及派发边界核对；目标变化要求重新观察，没有执行则不登记外部效果。
- 完成收据在等待/打开电脑之前读取，源标签关闭或浏览器不可用时仍返回原成果，结果不明不重发。下载审批展示实际页面、导出目标及表单地址，沿用现有深浅主题。
- 实际 Chrome 目标/下载/并行/接管 2 文件 26 项通过；真实模型图下载、发布、读取及重放 5 场景通过，填写/导出允许、拒绝、审批期间目标变化 6 场景通过。首次导出夹具默认 GET 使测试端点未匹配查询串，已将夹具改为实际 POST 导出；产品执行路径未为测试放宽。真实 React 工作区全旅程通过，深浅色下载审批截图已查看。Node/Web 类型和构建通过；首次 ESLint 检出新增兼容代码的未使用局部变量，已修正，复检通过，0 错误。
- 子任务补充升级兼容：旧记录仅缺角色名时可以沿用原冻结输入与收据；角色指令或权限变化仍拒绝，新记录严格绑定角色名。关联领域 3 文件 42 项通过，首轮夹具字段名错误已修正为原合同 `roleSystemPrompt`。不据此声称 Windows 实机、真实模型判断及完整核心范围验收完成。
- 日志 `/tmp/cmb-download-{browser,replay,graph,export-graph2,ui,final-types,final-build}.log`、`/tmp/cmb-child-upgrade2.log`。本节尚未重复全仓门禁。

### 例程执行的持续授权依据（2026-10-02，APR-01 接续）

- 原例程保存、调度、手动试跑与 Webhook 队列仍共用原事务。新增 v34 保存授权来源和每次触发的任务依据；界面提交的指令与模型生成的例程分别记录。模型创建的例程保留原人工任务和实际拒绝，不能将生成的计划升级为新的人类授权。
- 定时、单次、手动与事件触发可使用已有独立审核。Webhook 数据单列为外部资料；调度游标推进及单次执行自动停用不改变任务依据。用户编辑、暂停、删除或未知来源重写后，旧自动决定失效。同 Bot 工作流子任务沿用这一依据；例程及其子任务不能通过再建例程扩展自动授权。复制 Bot 和迁移旧例程不补造授权；用户明确保存或手动运行后才有新的人工依据。
- 领域/迁移/例程历史 6 文件 57 项通过；实际鉴权 RPC、备份恢复、Webhook、技能绑定及无桌面依赖边界 6 文件 71 项通过。真实 LangGraph/本地 SSE/本机脚本的允许、转人工、旧例程无授权 3 场景通过，拒绝时文件没有生成；没有以夹具判定替代真实模型质量验收。v33 升级前保存原库，旧例程内容不变、授权表为空，重新保存后形成新记录。
- Node/Web 类型、构建已通过。编译 Host 的例程审核连接器 SIGKILL 通过：已保存理由和未知结果未丢失、调用未重发。最后领域 4 文件 65 项通过。完整 `npm test` 退出码 0，主组 610 文件/4893 项通过、12 文件/116 项跳过，后续集成组全部通过（`/tmp/cmb-routine-authority-full.log`）；该全仓门禁早于下面的人工确认和升级检查补充。跨 Bot 收件任务的自动审核和完整标准准备链仍未完成。日志 `/tmp/cmb-routine-authority-{owner2,integration,graph,final-types,build}.log`。首轮新领域测试误把 SQLite 空结果视为无列返回，已修正测试断言。

### 人工确认例程与升级期间操作（2026-10-02）

- 用户在审批卡明确批准完整例程时，原批准、例程写入、来源记录和结果收据同事务提交；派发后由此确认的定义形成持续指令。独立模型批准仍只保留原用户任务，不能变成人工确认。写入的内容或版本与批准不符时整体回滚，不留下例程或半个执行收据。补充确认/拒绝/模式切换领域 3 文件 27 项通过；首次联表误用了审批字段名，定向测试发现后已按原 schema 修正。
- 修复新桌面等待旧 Host 空闲升级时的操作入口：允许读取完整长审批、任务/分支/文件详情，提交当前安全输入，接管和归还电脑，取消当前子任务。Host 继续校验原身份、版本、作用域和单次批准；新任务、例程变更、模型审核设置修改、恢复执行和代码合并仍等待升级。鉴权 RPC 升级旅程 4 项通过，包含完整长审批读取、子任务取消及新任务/新要求拒绝。
- 最新 Node/Web 类型、构建和改动范围 ESLint 0 错误通过；既有 store 的 6 条格式警告未全文件重排。日志 `/tmp/cmb-upgrade-review-tests.log`、`/tmp/cmb-routine-confirm-tests2.log`、`/tmp/cmb-upgrade-routine-{types,build,lint}.log`。人工确认例程后的真实图补充 5 场景通过（`/tmp/cmb-routine-confirm-graph2.log`），包含人工确认后由原例程继续触发执行。

### 跨 Bot 执行的原始授权与模型隔离（2026-10-02，APR-01 接续）

- 协作派发复用已有消息交办、队列、角色、工具、项目与共享用量边界。SQLite v35 同事务保存原用户指令、实际交办链、接收方范围及每一级审核策略；只有发起方启用审核且有有效人类任务依据时才建立记录，旧协作任务保持人工确认。
- 执行审核使用最初发起 Bot 配置的模型，接收方及其工作流子任务可继续使用各自执行模型。源任务的私有指令只进入源方审核模型；执行模型只看到显式交办消息。子任务继续转交时保留原角色、只读及禁用工具范围，不能通过下一层协作扩大权限。跨 Bot 同一任务链的人工拒绝仍然有效。
- 原任务结束不终止合法交办；撤销任务、补充待处理人工指令、修改职责或审核策略、删除发起方、恢复数据等均撤销尚未执行的自动批准。最多八级协作使用单次同步遍历缓存，下一次派发重新核验，缓存不延长权限有效期。协作生成的例程不能自动升级为持续人类授权。
- 领域首次 4 文件 53 项通过；补充删除、子任务转交和八级协作后，RPC/备份/领域/无桌面依赖 4 文件 61 项通过，迁移与领域专项 2 文件 29 项通过。v34 升级备份完整，旧任务不补授权，新记录重启保留。两个不同模型的实际图允许/拒绝写文件通过，真实文件有无与批准一致，用量计入同一根任务。首轮图夹具误用插件 SDK 工具名，已按模型工具合同改为 `project_edit`。
- 实际编译 Host 在接收方连接器已派发未返回时 SIGKILL，重启仍保留独立审核记录并显示未知效果，不重发连接器（1 项通过，41 项未重复）。首次进程测试启动早于新版构建完成，使用旧产物停在人工审核；构建完成后重新验证通过，不将旧产物结果当作新版失败。
- Node 类型、构建和相关 ESLint 0 错误通过。日志 `/tmp/cmb-peer-{owner2,migration,boundaries,graph2,process2,lint,build}.log`。跨 Bot 接线后的整仓 `npm test` 退出码 0：主组 611 文件、4914 项通过，12 文件、117 项跳过；后续集成组均通过（`/tmp/cmb-peer-full.log`）。该门禁主组早于随后 Setup 接线；真实模型判断、Windows 实机和完整核心范围仍未验收。

### Bot 桌面通知（2026-10-02，UI-04 接线）

- 直接移植 Grok 的状态变化判断、初始基线、前台/隐藏/静音门控及按 Bot 和提醒类别的五秒去重。复用原生 Electron 通知、现有 Bot 消息深链接和窗口唤起；完成提醒无声音，需要输入的提醒使用原版优先级。提醒使用概述，不把审批参数、问题正文或成果内容放入系统通知。
- 桌面主进程只读观察独立 Host，关闭 Bot 页面后仍工作。通过持久事件捕捉两次轮询之间快速完成的任务，分页追赶有上限；启动和数据恢复重新建立基线，重连不弹出过期结果。点击定位实际消息及分支，不批准操作、不改未读状态。已解决的待处理事项、静音、隐藏、数据恢复和桌面退出会撤回对应提醒。
- SQLite v37 保存独立通知偏好及版本，不改变执行配置版本或使运行中的授权失效。菜单接入开启/关闭通知；请求响应丢失后保留原 nonce，重开菜单可确认，旧收据不能覆盖后来设置。复制 Bot 保留静音偏好并使用新的设置版本与身份。
- 首轮领域/IPC 5 文件 92 项通过；认证通信与 v36 迁移 2 文件 45 项通过；补充过期结果不占用新通知节流、复制偏好和队列回归后，6 文件 62 项通过。真实 React 工作区完整旅程通过，包含静音成功但响应丢失、重开重试和重新开启；`output/bot-workspace/notification-menu.png` 已检查。Node/Web 类型、构建和相关文件 ESLint 0 错误通过。日志 `/tmp/cmb-notify-{owner,rpc,final-owner,ui,final-types,build,lint}.log`。
- 原生通知生命周期通过注入端口测试，尚未进行 Windows 安装包的系统通知与外部唤起实机验收；本节没有覆盖应用完全退出后的系统提醒。这里是桌面提醒功能，不能代替尚未完成的技能 Notification Hook。最终整仓回归见下一节，不以此前 Setup 结果代替通知门禁。

### Bot 快捷键及大结果策略处理（2026-10-02，UI-05 部分接线）

- 移植 Grok 的按键标准化、组合键匹配、可编辑目标判断和相邻 Bot 不循环切换逻辑；接入新建 Bot、查找 Bot、当前对话/工作区搜索、设置、输入框聚焦、Alt 上下切换和数字定位。帮助页按 Mac/Windows 显示快捷键；范围以实际可见侧栏为准，保留各会话草稿。
- 中文输入法、重复键、已处理事件、弹窗/菜单及电脑操作区不被工作区快捷键抢占。真实 React + Chrome 旅程验证接管浏览器时 Ctrl+F 转交浏览器，筛选后的会话切换和草稿保留通过；帮助页截图 `output/bot-workspace/keyboard-help.png` 已检查。未把原版完整命令面板、历史导航等计为完成。
- 首次整仓主组 4960 项通过、1 项失败：插件大结果发布发生 `MODS_POLICY_UNAVAILABLE`，任务按约定停在待核对。新增接近内容上限、64 条脱敏规则的用例稳定复现了原 50ms 策略时限问题；仅源码完全等于应用内置纯策略的程序使用独立 1000ms 计算时限，普通插件不因名称获得该预算。保持内存/输入上限、拒绝策略 I/O、有限重算和失败禁止发布；不重发产生结果的工具调用。时限采用单调时钟，诊断仅保留方法及错误码。
- 大结果、普通插件死循环、实际独立策略 Worker 及 Bot 插件 MCP 链路定向验证通过；快捷键实际交互、Node/Web 类型、构建和相关 ESLint 通过。最终完整 `npm test` 退出码 0，主组 617 文件/4966 项通过，12 文件/118 项跳过，后续全部集成组通过（`/tmp/cmb-policy-full.log`）。该完整回归早于 MCP 资源接线；不代表 Windows 实机或后续修改已验收。
- 日志 `/tmp/cmb-keys-{ui-final,final-types,build,lint-final}.log`、`/tmp/cmb-policy-{large,budget,process-final2,full}.log`。原真实 Worker 新测试暴露预算中断错误在 Promise 收尾时丢失分类，已修复；不是放宽为接受普通执行错误。

### 连接器资源目录与读取（2026-10-02，PLG-10 接续）

- 复用 Cmb 原 MCP 客户端和已安装 SDK 的资源、模板、URI 展开协议；未将 Grok 未提供的云端实现标作移植。仅连接当前 Bot 已授权的来源，支持只有资源而没有工具的 MCP 服务。目录提供分页、大小/循环游标限制，模板参数按 SDK 编码；资源 ID 绑定来源、配置和原目录项。
- 读取沿用已有审批、执行收据、插件发布过滤和成果文件路径。审批展示实际提供方和展开后的 URI；Hook 不能将已解析的 URI 改成另一读取目标。插件自身的前后检查按来源激活；角色禁止调用连接器时同样禁止资源读取。二进制数据显式保留或按保护策略屏蔽，大文本先过滤后保存结果文件。
- 真实 LangGraph + 本地 SSE + 实际 MCP SDK 子进程的资源、模板、二进制、拒绝、撤销、断线和大结果保护 9 项通过（含原工具/SDK 回归）；插件前后检查仅各执行一次的实际流程通过。目录专项 4 项、资源连接核心 8 项通过。首次类型检查发现工具集合推断过窄，已改用原运行时相同的 StructuredToolInterface；Node/Web 类型、构建和相关 ESLint 0 错误已通过。
- 实际编译 Host 的待审批、已完成读取但后检查未结束、在途读取三个 SIGKILL 场景通过（3 项通过/43 跳过）：继续使用原目标和审批，完成读取只发生一次，后检查仅补做一次，在途未知结果不重发。首轮测试将 Hook 脚本放在受保护后台目录，随后又误以活动任务快照判断已完成状态；修正夹具目录和 runHistory 查询后通过，未放宽产品路径限制。最新目录结果按大小分页，避免正常长描述使整页不可用。首次完整回归的 Git 注册表用例超时：其 5 秒测试包含 12 个真实仓库的建仓/提交准备。将 72 条 Git 准备命令移入 beforeAll，保留原扫描时限、12 个仓库及一次写入断言；32 项 Git 专项通过，扫描约 0.7 秒。资源与帮助入口合并的完整 `npm test` 退出码 0，主组 619 文件、4980 项通过，12 文件、121 项跳过，后续集成组全部通过（`/tmp/cmb-resources-help-full.log`）。该门禁早于后续浏览器清理及首次引导接线。
- 日志 `/tmp/cmb-resources-{catalog,graph,hooks,types-final2,build,lint,process-final2}.log`、`/tmp/cmb-resource-core.log`。这些模型测试使用受控夹具，未代表外部企业系统或用户配置模型的效果验收。

### 帮助、关于与首次使用（2026-10-02，UI-12、ACC-02 接续）

- 参考原 Grok About 的版本、发布通道、平台展示和复制反馈，复用 Cmb 版本 IPC、更新状态、Dialog/Tabs 与主题。基础诊断按明确字段导出版本及连接状态，不序列化 Host 快照、路径、模型配置、凭据或原始异常；断线快照不显示执行就绪。可复制版本信息/反馈模板、下载 JSON，并进入原应用设置和快捷键页。来源与适配方式写入 Renderer PROVENANCE。
- 帮助页真实 React + Chrome 完整旅程通过，包含复制、下载、设置与快捷键跳转、草稿保留；深浅色及指南截图已检查。Node/Web 类型、构建、相关 ESLint 通过，基础诊断测试通过。日志 `/tmp/cmb-help-{owner,ui,types,lint,build}.log`；当时完整门禁见资源节。
- 随后补充首次使用步骤和首项任务建议：设置入口进入已有应用设置，创建使用原 Bot 编辑器；建议只填草稿，不自动发送，不覆盖已有正文。工作浏览器沿用真实打开/画面/失败重试流程；所选连接器仅标为已选择，不标为已授权。已有 Bot 但尚未选会话时显示已有工作入口。完整真实 React + Chrome 界面旅程随后通过，`first-use.png`、`first-task.png` 已检查；初次测试误将既有“接管操作”按钮定位为“接管”，改为等待实际画面并核对 Host 就绪状态后通过，产品无对应故障修补。日志 `/tmp/cmb-onboarding-ui2.log`。

### 浏览器初始化与状态（2026-10-02，CPU-16 接续）

- 修复 Chromium 已启动但初始化失败时未释放进程与 profile 的路径；清理结束前并发调用继续等待原启动请求。初始化期间连接断开不能发布就绪。原 Grok 浏览器驱动、共享登录与控制权实现保持原路径。
- 现有 Host status 增加可选浏览器状态、实际版本、启动时间及本次启动标识；读取状态不启动浏览器。启动/关闭/失败分开，重连使用新标识；帮助页诊断追加这些基础字段。未把浏览器就绪等同于站点登录或通用桌面能力。
- 五项状态/清理/诊断单元测试通过。首次 Node 类型检查发现测试函数参数与工厂同名形成类型递归，改名后 Node/Web 类型及 ESLint 通过。真实 Chrome 12 项通过，包含重连版本与身份、在途脚本关闭、共享登录及下载隔离；完整页面与最终构建通过。编译 Host 重启保留人工接管、显式重新接管及真实浏览器版本/新启动标识 1 项通过、45 项未重复运行。日志 `/tmp/cmb-computer-status-{owner,browser,process}.log`、`/tmp/cmb-onboarding-{types2,lint,ui2,build}.log`。

### 项目初始化检查（2026-10-02，标准任务生命周期接续）

- 接入 Cmb 原 Setup(init) Hook 与执行器，在 SessionStart 和任务模型调用前完成初始化检查。检查继续经过原 Hook 审批、项目/角色权限、配置和租约核验；脚本非零退出、明确 block/stop、人工拒绝或配置变化均不能标记初始化成功。共用 Hook 执行器补齐了退出码为 0 但返回明确阻断指令的判定，同步与原桌面路径都覆盖。
- SQLite v36 按实际项目目录身份和生效检查配置记录初始化状态。多个 Bot 使用同一项目/配置时复用成功记录；其他初始化请求等待现有任务，等待不占模型执行名额。中断或待核对初始化不能被另一个 Bot 自动重做；配置或目录身份变化重新检查。工作区可写的 setup-state 文件不作为 Host 已完成检查的证据。
- 恢复沿用已完成 Hook 的原审批和结果，不重复执行；没有完成的检查继续请求审批。首次新增测试发现初始化事务内再次调用 activity 事务，已改为同事务写入状态与进展；修复后领域/实际 Hook/迁移/技能导入 4 文件 45 项通过，无未处理异常。实际图允许、失败、拒绝和配置变化 4 场景通过；同一项目第二个 Bot 仅执行自身 SessionStart，不重复 Setup。共用 Hook 显式否决补充 4 场景通过。
- 编译后的独立 Host 在两个 Setup 步骤之间 SIGKILL，恢复仅继续第二个步骤，模型在全部检查通过后才调用；另一个 Bot 复用完成状态（1 项通过/42 跳过）。Node/Web 类型、构建、相关 ESLint 0 错误通过。日志 `/tmp/cmb-setup-{owner2,graph2,process,types,build,lint}.log`。本节后完整回归已通过：主组 612 文件、4932 项通过，12 文件、118 项跳过，后续专项组全部通过，完整命令退出码 0（`/tmp/cmb-setup-full2.log`）。首次整仓执行异常延长至约 2 小时 54 分钟并出现超时/性能失败及一次 Vitest RPC 超时，5 个失败文件定向复测 10 项通过后完成上述重跑；未放宽测试阈值。该回归早于桌面通知最终接线，Notification Hook 和完整标准任务准备链尚未完成，Windows 实机和真实模型效果仍未验收。

### 精确命令审批规则（2026-10-02，APR-02/03 部分接线）

- 复用 Cmb 原命令持久授权资格检查；“始终允许”保存具体 Bot、项目路径、完整命令、超时、沙箱与执行配置身份，不自动生成宽泛前缀。其他工具、未知命令、插件授权、后台服务保留原人工审批。当前只有符合原 Cmb 规则的前台命令支持保存，不能作为独立模型自动审核（APR-01）完成。
- SQLite v32 记录规则、规则版本及每次审批来源。自动批准仍生成绑定当前任务和最终参数的一次性审批收据，继续经过原权限、沙箱、角色、工作副本、任务租约及操作结果核对；“每次询问”禁止在单次卡片重新保存，规则修改撤销尚未执行的自动批准。过期或取消请求不能保存规则。规则不随 Bot 复制；备份恢复后保留历史并将保存规则改为每次询问。
- 从 Grok `sand-shell-auto-review-enrichment.ts` 直接移植命令候选解析；用 Cmb 项目稳定文件句柄替代原远程文件协议。包脚本绑定完整 `package.json` 内容摘要并显示对应脚本；直接入口脚本绑定文件摘要。执行前复核，定义变化不能沿用原批准；未读到、越界、链接、过长或项目选择含糊的定义不进入持久规则。此绑定针对清单/入口文件，不宣称覆盖全部依赖文件。补充 Windows 大小写和 `.cmd/.exe/.bat` 启动入口识别，路径限定启动器保留人工确认，原命令文本不改写。
- 复用现有审批卡、任务历史及弹窗组件；新增“始终允许”、Bot 菜单中的规则列表、每次询问/自动允许切换和删除。网络结果不明时保留原 nonce，重新打开窗口仍可核对，不以新请求重复修改；旧 Host 隐藏规则入口。
- 初始领域/历史/IPC 3 文件 88 项通过；迁移、真实鉴权 RPC、备份及无桌面依赖边界 5 文件 76 项通过；恢复与浏览器操作收据 2 文件 20 项通过。真实模型图使用本地 SSE 夹具和真实 `npm test`，验证首轮保存、次轮自动、撤销后人工拒绝且命令未运行。编译 Host 两次实际 SIGKILL 后保留规则及修改收据、恢复自动执行与每次询问，1 项通过/37 项未重复。
- 脚本定义绑定后的最终 Node/Web 类型、构建、完整 React 工作区旅程和编译 Host 两次 SIGKILL 场景均通过，深浅色截图已检查。关联领域/IPC/历史 93 项、RPC/备份 42 项、原生 SDK/后台执行 18 项及脚本变化拒绝 2 场景通过。完整 `npm test` `/tmp/cmb-definition-full-final.log` 退出码 0：主组 604 文件/4811 项通过，12 文件/93 项跳过，后续集成组全通过；此门禁早于上节独立审核接线及本节 Windows 入口适配。对应日志 `/tmp/cmb-definition-{final-owner,domain2,graph,fence,process,ui,types,build-final,lint}.log`，ESLint 0 错误，store 保留原有 6 条格式警告。

### 插件命令与 SDK 连接器调用（2026-10-02，标准执行链接续）

- 复用 Cmb Function Mods 的命令注册、QuickJS 执行、版本授权、SDK 路由和工具检查。私聊及分支可用 `/plugins` 分页查看命令，`/plugin 命令名 参数` 显式调用；输入区增加命令入口和具体参数审批卡。命令为独立排队任务，不通过主模型猜测调用，也不被后续聊天补充改写。群聊、例程、其他 Bot 消息和模型回调不获得用户命令权限。
- 原生 `$.mcp.call` 与 `$.tool.call` 按此 Bot 已授权的具体连接器解析，保留工具改写、权限、配置代次和结果过滤。模型工具与 SDK 共用 Bot 的操作审批、无重试远端执行及成果保存链；大结果过滤后保存成文件，SDK 获得明确截断的摘要和文件 ID，保留提供方错误标记。后台回调仍不能自行授权写操作。
- 命令源码摘要、原始参数、执行收据和最终文字持久保存；结果未明时不以新的 SDK 调用 ID 重跑整个命令。输入检查可拒绝命令，改写命令要求重新提交；已保存的完成结果在 SessionEnd 恢复时直接使用。原生命令已支持的只读 SDK 继续沿用项目范围；本机写入/执行见下一节，插件面板和完整标准任务准备链仍未完成。
- 实际模型图、QuickJS、原 MCP 路由、输入队列和无桌面依赖边界 6 文件 145 项通过/11 跳过；共同连接器执行链整理后，17 个真实图/MCP 关联场景通过；追加大结果过滤、最终参数改写、输入拒绝及改写 3 场景通过。日志 `/tmp/cmb-plugin-command-{owner,mcp,extra}.log`。
- 编译 Host 的两个实际 SIGKILL 场景通过：调用中断后保留核对记录、无重发；已完成命令重启后只继续结束检查，主模型请求始终为零。完整 React 工作区旅程通过，已检查 `output/bot-workspace/plugin-command-approval.png`。对应日志 `/tmp/cmb-plugin-command-{process,ui}.log`。Node/Web 类型、构建和相关 ESLint 通过；完整 `npm test` `/tmp/cmb-plugin-command-full.log` 退出码 0：主组 601 文件通过/12 跳过，4763 项通过/90 跳过，后续集成组全部通过。共享 MCP 整理后的编译 Host 2 场景复测通过（`/tmp/cmb-plugin-command-process-final.log`）。该门禁早于下一节本机 SDK 接线；Windows 实机及外部真实系统未验收。

### 插件 SDK 本机文件修改与命令执行（2026-10-02）

- `write_file/edit_file/execute/task_output` 接入既有 Bot 项目工具和原生执行器，沿用 Cmb SDK 参数合同、编辑匹配、审批、补丁与修改前备份、沙箱配置、工作副本限制和结果收据。工具检查可以拦截或改写输入，最终参数重新检查后执行；拒绝审批、检查拦截及非零退出显式返回 SDK 错误标记。
- 同一插件通过 `read_file` 或 `$.fs.read` 实际读取并通过结果发布后才取得现有文件版本；权限查询、目录列举不充当读取。新文件使用排他创建；审批期间人工改动不会被覆盖。SDK 调用和执行器使用独立收据名空间及稳定调用 ID，取消或作用域失效后不能继续写入。命令使用 Bot 项目根目录、前台运行 60 秒；其他 cwd 明确拒绝，不暗改命令文本。SDK 工具目录按实际适配器映射 `read_file/ls/glob/grep/write_file/edit_file` 等名字，不把仅供模型使用的工具名列为 SDK 可调用项。
- 实际 QuickJS/原生执行/项目和 Hook 关联回归 4 文件 171 项通过/11 跳过；追加共享文件 SDK 成功发布才记录版本、`$.fs.read` 后修改 2 场景通过。共享 Function 管理器、文件访问、项目文件、Hook 回归 4 文件 58 项通过。日志 `/tmp/cmb-plugin-native-{owner,fs,shared}.log`。
- 编译 Host 实际 SIGKILL 4 场景通过：MCP 已完成与执行中、项目文件已修改、原生命令执行中；恢复使用原收据，不重发操作。日志 `/tmp/cmb-plugin-native-process.log`。Node/Web 类型、相关 ESLint 和构建已通过；最终 16 个文件、命令、Hook 场景通过；追加目录、连接器发现 3 场景通过，后台权限与子任务原生 SDK 关联 23 场景通过（`/tmp/cmb-plugin-native-{final-cases,catalog,authority}.log`）。首轮完整回归仅有新增取消测试的预期错误：外层插件命令已经启动，取消后应保留“待核对”，并非直接标为取消；已修正断言并验证待批文件没有写入。合并后的完整回归正在重新执行，不据此宣称 Windows 或生产验收完成。

### 审批与提问历史详情（2026-10-02，活动流接续）

- 任务记录中的请求可按需展开，查看当时的审批内容、普通问题与用户回复。已拒绝、取消或过期的请求也有独立历史；已批准请求按真实关联跳转操作结果，不根据相似描述猜测。主任务及子任务都显示结果或失败说明，审批事件摘要区分批准、拒绝与信息补充。
- 复用现有 Cmb 审批内容卡、问题回复格式和操作回执组件；请求详情只读，不提供历史请求再次批准入口。接口核对完整对话/分支/任务归属，安全输入请求不回传输入令牌及秘密值。读取失败可重试并保留已读取内容，切换或关闭后不采纳过期回包；旧 Host 未投影详情 ID 时仍显示原摘要。
- 领域、真实鉴权 RPC 和 IPC 3 文件 94 项通过，覆盖错任务/分支、越界标识、拒绝请求、真实效果关联、普通回复与安全输入脱敏。完整 React 工作区旅程通过，包括首次读取失败后重试、拒绝审批、结构化问题回复和从批准请求查看不确定执行结果；历史查看没有再次回答请求。最终截图 `output/bot-workspace/request-history-{rejected,approved}.png` 已检查，精简嵌套操作卡重复审批内容后的完整界面旅程通过。
- 日志 `/tmp/cmb-interaction-{tests,tests2,ui2,link}.log`；Node/Web 类型、最终构建通过，相关 ESLint 仅保留 store 原有 6 个格式警告。编译 Host 四个 SIGKILL 场景及重启后历史读取通过（`/tmp/cmb-native-history-process.log`）。当时全量运行含修改前代码与新增关联断言，历史关联已在最终 5 项专项通过；另一次插件纯策略运算失败单独及完整执行器组复测通过，仍需以随后全量门禁为准。

### 项目源码内容检索（2026-10-02，标准工具接续）

- 从 Cmb 原 `LocalSandbox` 抽取文件编码识别、二进制判断、匹配结果累积与长行截断，桌面与 Bot 共用。保留 UTF-8/GBK/UTF-16 等原解码行为；Bot 通过项目内稳定文件句柄读取，不获得原桌面执行器的全盘文件权限。来源及抽取前摘要已记入 PROVENANCE。
- 模型 `project_grep` 支持区分大小写的原文搜索、单文件或目录、文件名过滤，返回项目相对路径、行号和片段。单次最多扫描 1000 文件、每文件 2 MiB、累计 16 MiB、10 秒及 200 项/24000 字符结果；达到限额或跳过二进制/超大/不可读文件时明确返回未完整扫描，不能据此断言整个项目没有匹配。
- 插件原生 `grep` 经同一项目范围与子任务角色校验，保留原 SDK 结果封装；权限查询不读取正文，禁止绕过 Host 私有目录、链接和 Git 内部文件。子任务禁止 `grep` 或 `project_grep` 后，模型工具与插件调用均被限制。
- 项目文件 12 项通过；真实模型和 QuickJS 2 场景、子任务插件权限 5 场景通过。Cmb 原 `read-file-tool.spec.ts` 通过，包含原 GBK 文件搜索与稳定句柄断言；无桌面依赖边界、项目文件及原后台结算 3 文件 26 项通过。Node/Web 类型、ESLint、构建和完整工作流门禁通过。日志 `/tmp/cmb-project-search-{files1,graph3,child,read-core,owner-final,types-final,lint,build,workflow}.log`。
- 后台命令核对状态同时收尾：人工核对后保留原中断事实和输出，界面显示“人工已核对”，待处理列表移除已核对项。领域与真实 React 4 文件 21 项通过（`/tmp/cmb-shell-review-tests.log`）。内容检索与该修正的合并完整 `npm test` 退出码 0：主组 600 文件通过/12 跳过、4750 项通过/88 跳过，后续集成组通过，日志 `/tmp/cmb-project-search-full.log`。Node/Web 类型、最终构建通过；ESLint 无错误，仅 `store.ts` 6 条既有格式警告。Windows 实机及真实外部模型仍未验收。

### 跨回复后台服务（2026-10-02，CPU-05 继续接线）

- 对照 Grok `BackgroundShellManager` 的进程归属、对话作用域和完成唤醒，继续复用 Cmb 原命令进程及沙箱。用户任务可审批 `execute(run_in_background=true, keep_alive=true)`；Host 独立持有进程，模型回复后仍运行，后续同一 Bot、同一对话分支可查询输出或停止。启动记录不代表应用已就绪，模型需检查实际输出或端点。
- SQLite v31 保存独立 Host 租约；服务运行期间保留未结束操作记录，回复完成不会将命令标为成功。完成收据与原对话通知、后续任务在同一事务提交，只通知一次。普通后台命令仍等待结算；服务仅在启动时占用项目修改锁，可与后续修改并行。
- 沿用原执行器最长两小时限制及准确时限审批；停止、到期、Host 关闭、执行配置变化均清理进程树。强制结束 Host 或租约失效保留输出，转为核对，不自动重启服务。旧服务中断时，后续任务先收取已发出的操作回执，再进入核对流程；不能在进程仍清理时提前恢复任务。
- 服务关联领域、任务列表、备份、时钟及 RPC 6 文件 65 项通过；真实 Cmb 模型图和命令进程 5 场景通过，包含两项原后台命令回归，以及服务正常结束、跨回复停止、配置撤销。真实 React 旅程通过，已检查 `output/bot-async-tasks/service-after-reply-light.png`；服务在回复完成后仍可见、可查看输出和停止。
- 编译 Host 的前台命令、任务内后台命令、跨回复服务 3 个实际 SIGKILL/重启场景通过：子进程停止、输出保留、无重复执行。最终 Node/Web 类型、构建及工作流门禁通过；ESLint 无错误，`store.ts` 保留 6 条既有格式警告。完整 `npm test` 退出码 0：主组 600 文件通过/12 跳过，4743 项通过/88 跳过，后续集成组全部通过；主组早于随后内容检索接线。日志 `/tmp/cmb-shell-services-{domain4,graph5,ui1,process1,types-final,build-final,workflow,full}.log`。此项未包括交互式 stdin、无限期运行和 Windows 实机验收，CPU-05 尚不标整项完成。

### 项目文件模式检索（2026-10-02，执行工具接续）

- 模型 `project_glob` 直接复用已有 `BotProjectFiles.glob` / Cmb 工作流有界遍历，支持子目录、稳定排序和分页。单页同时限制条数与字符数，返回下一位置；路径、符号链接、Git 内部数据和 Host 私有目录继续沿用项目权限校验。
- 子任务模型工具与插件 SDK 使用同一检索权限映射，禁止 `glob`、`project_glob` 或 `project_list` 时不能从插件绕过。真实模型图/QuickJS 7 场景通过；项目文件 9 项通过。Node/Web 类型、相关 ESLint 和构建通过，日志 `/tmp/cmb-project-glob-{tests,policy,files,types,lint,build}.log`。
- 下节完整回归早于此新增模型工具，检索接线使用本节专项验证；内容检索及跨轮次服务进程仍在继续开发。

### 任务内后台命令（2026-10-02，CPU-05 接续）

- 复用 Cmb 原 `executeBackground/getTaskOutput`、两小时上限、Windows 进程树及沙箱。`execute(run_in_background=true)` 在准确命令审批后返回稳定任务编号，Bot 可继续读取、分析及其他工作；后台命令与子任务共用结果通知队列，完成后唤回模型。最终交付等待当前任务派发的命令结算，项目修改继续使用既有串行锁。
- SQLite v30 保存任务、原调用身份、审批效果、状态及有界输出；启动编号不等同于命令成功。每任务最多 4 个在途命令、保存 16 条，Host 最多 8 个在途命令；超额拒绝不终止已有工作。排队取消不启动进程，已开始的取消或超时保留结果不明状态，重启后不重跑命令。输出保存上限 262144 字符，按页读取，不随轮询反复加载全部输出。
- 增加模型 `task_output` / `stop_shell_task`、后台任务中的命令入口及已结束任务的命令记录。界面展示原命令、分页输出、退出码和待核对状态；停止使用版本、数据代际和持久 nonce，回包丢失后刷新可确认原请求。审批卡明确后台运行；恢复备份将未完成命令标记待核对。
- 关联领域、工作流结果通知、任务列表、备份及 IPC 共 5 文件 97 项通过；追加容量与幂等专项 7 项通过。实际 Cmb 模型图与独立命令执行器 5 场景通过，覆盖后台运行时继续读取项目、结果唤醒、停止后核对，以及原前台命令与审批配置变化。编译命令执行器及原后台结算 2 文件 24 项通过，包含 Host IPC 断开后的真实进程树清理。
- 真实 React 旅程通过：后台列表→输出分页→停止回包丢失→刷新→同一请求确认→中断状态。深浅色截图 `output/bot-async-tasks/shell-live-dark.png`、`shell-interrupted-light.png` 已检查。Node/Web 类型、构建、相关 ESLint 通过（`store.ts` 6 条既有格式警告）。编译 Host 实际 SIGKILL 后停止子进程、保留输出及不重复执行的前台/后台两场景通过（其余 30 项跳过）。完整 `npm test` `/tmp/cmb-shell-jobs-full.log` 退出码 0：主组 599 文件通过/12 跳过，4724 项通过/87 跳过，后续集成组全部通过。完整门禁期间补充的容量拒绝与界面错误恢复使用上述专项复测；最终构建及 Node/Web 类型检查已通过。
- 子任务现已复用同一后台命令执行器，工作区边界和只读角色传入实际命令进程。真实 Git/命令测试验证输出仅写入独立工作区、只读角色在审批前拒绝写命令、父任务取消后等待子进程清理；专项 4 项通过（16 项跳过），Node/Web 类型、ESLint、构建通过。日志 `/tmp/cmb-child-shell-{tests2,types-final,lint-final,build}.log`。
- 范围：本节为根任务及子任务内的有限时长后台命令；跨回复服务后续接线见上节，Windows 实机仍未验收，不将 CPU-05 整项标为完成。日志 `/tmp/cmb-shell-jobs-{associated,capacity,runtime3,compiled,ui-final,types-complete,build-final,final-lint2,host,full}.log`。

### 常驻服务定时备份（2026-10-02，OPS-05 接续）

- 复用既有快照、稳定文件句柄及有界子进程传输。独立 Host 按用户配置的 1～168 小时间隔备份，不依赖桌面窗口、不调用模型、不打断在途任务。SQLite v29 保存配置版本、下次执行时间、待确认快照身份、最近结果与失败记录；并发触发合并，失败 5 分钟后重试，停机期间错过的周期不集中补跑。
- 配置使用版本和原 nonce 核对，页面刷新后可确认响应丢失的操作。后台中断后沿用同一快照编号，已发布的快照不会重复创建。关闭计划只阻止后续执行，正在复制的快照继续完成；Host 关闭中止子进程并保留待确认身份。恢复旧数据关闭例程及定时备份，清除旧待办，并拒绝恢复前配置请求的重放。
- 快照读取已提交 WAL 数据，并逐份验证其引用文件；复制期间删除或修改文件时不发布残缺副本。总大小在复制文件前核对。范围仍为 Bot 数据库、附件和 Teach 资料，不包含项目代码、浏览器登录或模型凭据；最多 50 份，达到上限报告失败并由用户审核删除，不自动淘汰。
- 领域/备份/IPC 3 文件 87 项通过；编译快照进程、无桌面依赖边界和 IPC 3 文件 76 项通过。真实 React 旅程验证配置响应丢失后刷新/原请求确认、真实备份恢复及恢复后禁用计划，暗色截图 `output/bot-backups/backups-dark.png` 已检查。编译 Host 无客户端恢复已发布快照、SIGKILL 后配置收据重放 1 项通过（其余 30 项本轮跳过）。
- Node/Web 类型、构建通过，相关 ESLint 0 错误（`store.ts` 6 条既有格式警告）。完整 `npm test` `/tmp/cmb-backup-full.log` 退出码 0：主组 597 文件通过/12 跳过，4703 项通过/86 跳过，后续集成组全部通过。此完整门禁早于随后磁盘监测接线；日志 `/tmp/cmb-backup-{tests,compiled,process,ui,types2,lint,build,full}.log`。Windows 实机及包含完整电脑环境的恢复仍未验收。

### 本机磁盘容量监测（2026-10-02，CPU-15 接续）

- 从 Grok 原 `disk-pressure-guard.ts` 提取阈值、恢复滞回及原生磁盘读取函数，源码哈希与适配边界记入 PROVENANCE。Host 读取 Bot 数据及已配置项目所在磁盘，按卷去重，不遍历文件内容。部分读取失败保留上一压力状态；无数据或无效容量不显示为健康。关闭 Host 后不发布迟到结果。
- 工作区新增容量入口与空间不足提示，展示整块磁盘的总量、可用量和读取时间；可进入已有备份列表逐份审核删除。沿用 Grok 已移植的稳定时钟判断过期读数，GiB/TiB 展示大容量。尚未创建自主清理 Bot，不将容量监测标为完整 Disk Saver，也不计为完整电脑状态诊断。
- 原生磁盘、分级恢复、部分失败和关闭后失效 5 项通过；关联 RPC、快照与无桌面依赖边界共 4 文件 41 项通过。真实 React 完整工作区旅程通过，包含低容量提示、部分读取失败保留原读数、恢复后提示消失；备份旅程追加容量→审核入口，读取与进入页面均未删除任何数据。截图 `output/bot-workspace/storage-pressure.png`、`output/bot-backups/storage-cleanup-entry.png` 已检查，后者为最终容量单位与稳定时钟版本。
- Node/Web 类型、最终构建与相关 ESLint 通过。编译 Host 原生采样及定时备份恢复 1 项通过（30 项跳过）。日志 `/tmp/cmb-storage-{tests,owner,ui,backups-ui,types,types-final,lint2,final-lint,build-final,process}.log`。上节完整回归覆盖定时备份，磁盘监测使用本节专项门禁；Windows 原生卷统计仍需实机验收。

### 插件工具目录、权限查询与文件范围（2026-10-02，执行能力接续）

- 将 Cmb 原 SDK 权限查询抽为桌面与 Bot 共用内核，保留原参数验证、工具别名解析和权限裁决；源码来源与摘要记入 PROVENANCE。插件可发现当前 Bot 已授权连接器的工具，查询权限只使用现有元数据，不执行外部请求。后台插件不能因发现工具而自行取得写权限；插件命令、面板和完整 SDK MCP 调用仍未完成。
- `glob` 复用现有工作流有界遍历和项目文件校验，支持按实际子目录搜索，排除链接、Git 内部文件及 Host 数据；权限查询只验证目录和表达式，不扫描文件。修正子任务原生 `ls/glob/read_file` 与项目权限的对应关系；模型及 SDK 的目录不再列出子任务无法调用的插件注册工具。
- 原桌面权限、无 Electron 依赖边界、项目文件及工作流存储 4 文件 25 项通过；真实模型图与 QuickJS/MCP 子进程关联 10 场景通过，覆盖具体连接器权限、参数改写、插件 SDK 发现、发现中取消与配置替换，外部操作保持零次。目录查找与越界 2 场景、子任务允许/禁止读取 2 场景通过；最后的子任务目录过滤复测 2 项通过。
- Node/Web 类型、相关 ESLint 和构建通过。完整 `npm test` `/tmp/cmb-plugin-files-full.log` 退出码 0：主组 596 文件通过/12 跳过，4688 项通过/85 跳过，后续集成组全部通过；此门禁早于最后的子任务目录过滤及后续定时备份接线。日志 `/tmp/cmb-plugin-catalog-{graph3,types2,build}.log`、`/tmp/cmb-plugin-files-{owner,tests,child3,types,lint,build,full}.log`。Windows 实机仍未验收。

### 任务开始、结束检查及恢复（2026-10-02，标准执行链接续）

- 接通原 Cmb `SessionStart` / `SessionEnd`，执行会话以单次 Bot 任务为边界。开始检查在主模型调用前完成；成功答复先持久保存，再执行结束检查。恢复正在结束的任务时读取原答复，只补做未完成的检查，不重复模型或已完成命令。模型失败保留原失败原因，并在有效任务租约内执行结束检查；用户明确取消后不再启动需要授权的清理命令。
- 结束检查开始后收到的新要求进入后续任务，不修改正在交付的结果，也不丢弃输入。尚未进入结束检查的补充要求仍沿用原任务输入队列。成功恢复通过原 Mods 执行作用域完成通知；技能导入预览与运行时使用同一支持事件列表。
- 领域及执行链关联 4 文件 47 项通过；真实模型图覆盖成功、模型拒绝、用户取消、收尾时追加要求 4 场景。编译 Host 两个实际 SIGKILL/恢复场景通过：成功或失败均保留原结果，两个结束脚本分段恢复，模型请求始终只有一次。
- Node/Web 类型、构建、相关 ESLint 通过。完整 `npm test` `/tmp/cmb-session-hooks-full2.log` 退出码 0：主组 596 文件通过/12 跳过，4681 项通过/85 跳过，后续集成组全部通过。首轮失败为修改中的插件 `modules` 兼容检查和技能预览的旧支持事件断言，修复后 15 项相关专项通过，随后重跑完整门禁。Function Mod 模块交给原管理器，混合配置中的传统 Hook 继续解析执行。
- 日志 `/tmp/cmb-session-hooks-{owner3,graph3,process2,source2,types3,lint,build2,full2}.log`。该完整门禁早于随后插件工具目录接线；Setup、Subagent、Notification 及 Windows 实机仍未验收。

### 全局、项目及插件配置 Hook（2026-10-02，标准执行链接续）

- 从 Cmb 原始配置读取全局 `hooks.json`、项目 `.cmbdevclaw/hooks` 及已启用插件的 Hook，复用原解析、范围匹配、执行和结果判定。执行不使用截断过的界面目录；配置数量、大小及嵌套有上限，无效检查、重复标识、链接或不支持的事件明确拒绝。任务记录配置摘要，审批期间或重启后配置改变时停止旧任务；插件检查仅在实际使用对应技能或已授权连接器后生效。
- 连接器检查针对已解析的具体工具及所属插件，可在审批前改写参数、拦截调用，并检查真实结果。复用原 Mods 对最终参数的权限校验；修复接线初版误将具体 MCP 工具再次当作本机工具校验的问题，相关 8 项集成回归通过。已完成外部操作仍用原收据，恢复时可继续完成结果检查，不重发外部请求。
- 项目 command Hook 在隔离子任务的真实 Git 工作副本中执行，CWD 和环境变量均指向副本；实际 Git/命令测试确认原项目未被写入。全局及插件的外部目录 command Hook 暂不在隔离子任务内执行，明确报错；不以回到原目录运行来绕过隔离。HTTP/模型检查保留既有作用域与审批。
- 领域、配置读取、桌面同步、原技能及完整 Bot 执行图 5 文件 123 项通过/11 跳过。新图场景验证全局输入检查→项目改写参数→真实 MCP→插件结果检查；审批期间改动配置，远端调用保持零次。编译 Host 的 SIGKILL/恢复 2 场景通过：原检查只执行一次，配置改变后零新增模型请求。实测发现检查点可能直接进入模型节点，已在重放前增加配置核对，不能只依赖 beforeModel。
- 审批卡兼容技能数字版本与配置摘要，展示实际命令、执行目录和事件输入。真实 React 记忆/技能/审批旅程通过，截图 `output/bot-memory/configured-hook-approval-dark.png` 已检查；更新了该旧旅程在共享/安装技能改版后的展开操作。Node/Web 类型、构建、相关 ESLint、工作流组通过。完整 `npm test` `/tmp/cmb-runtime-hooks-full.log` 退出码 0：596 文件通过/12 跳过，4672 项通过/83 跳过，后续集成组通过。
- 日志 `/tmp/cmb-runtime-hooks-{owner5,graph4,process2,worktree,ui3,types-final2,final-lint,build2,workflow}.log`。上述主回归早于随后任务 SessionStart/SessionEnd 的接线，不代表后续生命周期已验收；Setup、Subagent、Notification 等剩余事件及 Windows 实机仍未计为完成。

### 头像图片、裁剪与恢复（2026-10-02，BOT-02 继续补齐）

- 复用 Grok 头像裁剪、拖动和缩放算法，来源及哈希记入 PROVENANCE；在 Bot 菜单增加图片入口，支持上传、拖放、粘贴、键盘移动、居中和移除。裁剪保存为 256×256 PNG，替换图片前保留原头像，移除后恢复既有角色形象；列表及群成员头像使用同一图片。浅色/深色截图 `output/bot-avatars/` 已检查。
- 图片经独立媒体进程解码重编码、清除元数据后保存。SQLite v28 独立保存图片与摘要，活动快照只含摘要，按需读取并有界缓存；复制 Bot 独立保存图片，备份恢复包含图片。变更绑定 Bot 版本、数据代际及原 nonce，保存回包丢失后核对原请求，不重复覆盖之后的修改；不向模型工具开放头像修改。
- 领域/RPC/IPC/备份/恢复状态及实际 React 旅程 6 文件 104 项通过。真实界面覆盖无效图片、裁剪拖动/缩放、保存回包丢失、刷新核对、群头像及移除。完整工作区菜单旅程通过；编译 Host 经实际媒体进程保存后 SIGKILL/重启，原图片保留，清除后重放旧保存请求未覆盖新状态。
- Node/Web 类型、构建及改动范围 ESLint 通过。完整 `npm test` `/tmp/cmb-avatars-full.log` 退出码 0：主组 594 文件通过/12 跳过，4661 项通过/81 跳过，后续集成组通过；专项日志 `/tmp/cmb-avatars-{owner2,workspace-ui,process,final-types,final-build,final-lint,final-ui}.log`。该门禁早于后续全局/项目 Hook 接线；AI 生成头像、动画图片播放及 Windows 实机未计为完成。

### 本机 Webhook 与触发密钥（2026-10-02，AUT-14/15）

- 为事件例程增加独立 Host 的回环 HTTP 入口，复用现有事件队列、版本化技能引用、执行权限和任务历史。SQLite v27 保存固定端口、密钥摘要、接收记录与去重收据；同一事件重投返回原任务，内容不同则拒绝。HTTP 200 仅表示已落盘接收；客户端窗口关闭后仍可处理，关机/休眠时不可接收，公网/LAN 入口不在本机首版范围。
- 复读 Grok 原源码与官方例程说明，并提取 Rakazo 的不可信事件包装和投递标识摘要算法，来源、哈希和许可记入 PROVENANCE。其余接线复用 Cmb 持久队列与收据。请求限定 JSON、32 KiB、32 层嵌套；展开后 32,000 字符，每例程每分钟 60 次及 20 个未结束任务，另有全局限额。校验 Host/Origin/凭据，上传完成后重新检查密钥撤销，分块超限和中断不创建任务。
- 例程窗口提供地址、请求头复制、生成/替换/撤销密钥。密钥只在生成时展示，数据库、历史、模型提示和重试记录均不保存原值；该行为与可重复查看旧密钥的界面有明确区别。保存应答丢失后核对原 nonce，不重复轮换；未留存新密钥时由用户明确再次替换。恢复备份会撤销所有旧入口，避免已停用的旧密钥重新生效。
- 领域/HTTP/RPC/IPC/备份 5 文件 102 项通过，随后补测分块超限和上传中断，HTTP 6 项通过。实际 React 旅程及恢复状态 2 文件 3 项通过；包含真实事件接收、复制请求头、轮换回包丢失后刷新恢复、再次轮换与撤销，浅色/深色截图 `output/bot-webhooks/` 已查看。编译 Host 实际关闭 RPC 客户端、执行事件、SIGKILL/重启、固定 URL/密钥保留、同一事件重投和新事件执行均通过，且没有重复模型请求。初次进程测试误从活动快照等待已完成任务，改查持久任务历史后通过，产品逻辑未改变。
- Node/Web 类型、构建、改动范围 ESLint 通过。完整 `npm test` `/tmp/cmb-webhooks-full.log` 退出码 0：主组 592 文件通过/11 跳过、4650 项通过/79 跳过，后续集成组全部通过。专项日志 `/tmp/cmb-webhooks-{owner2,http3,ui1,process2,final-types,lint,build}.log`。该门禁早于头像图片接线；Windows 实机与远端接收未验收。

### 后台任务面板与控制恢复（2026-10-02，OBS-04 继续补齐）

- 复读 Grok 异步任务 provider、clock 和 view，移植稳定时钟和时间显示；首次重新打开时刷新旧时间快照。Bot 菜单新增后台任务入口，按 Bot 查询持久化子任务及尚未收取结果的后台工作流，显示排队、执行、等待和中断待核对状态。列表采用稳定游标分页；刷新失败保留上次结果，关闭或切换后的迟到响应不能覆盖新页面。
- 任务行使用完整对话/分支/运行身份打开原任务记录、补充要求、停止和工作区差异界面，提供返回后台列表入口。修复从父任务进入子任务后展开操作回执误用父任务 ID 的问题。控制请求发送前保存原 nonce、版本和输入，刷新后可核对同一次请求；备份恢复后的旧请求不重发，无法保存重试标识时不提交。
- 查询只投影名称、阶段、状态、时间和定位信息，不返回任务脚本、角色配置或模型检查点。后台重启后的排队子任务仍可发现；成员移除后不返回其任务；RPC 限额、游标范围与 iframe IPC 拒绝均覆盖。
- 实际 React 面板及关联领域/RPC/IPC/恢复状态 5 文件 82 项通过，包含 25 个任务分页、正确分支的补充要求、回包丢失后刷新重试只写入一次、单独停止不影响其他任务、失败保留结果及跨 Bot 迟到响应。浅色/深色截图 `output/bot-async-tasks/` 已查看。原工作流 React 旅程通过，包含子任务操作回执、真实 Git 差异/合并/丢弃；完整工作区旅程通过并验证菜单入口。
- Node/Web 类型、构建、改动范围 ESLint 均通过。完整 `npm test` `/tmp/cmb-async-tasks-full.log` 退出码 0：主组 589 文件通过/10 跳过，4631 项通过/77 跳过，后续集成组全部通过。专项日志 `/tmp/cmb-async-tasks-{ui3,workflow-ui,workspace-ui,types3,lint,build}.log`；该门禁早于 Webhook 接线。
- 不将独立 Shell 进程管理、跨轮续接任务、子任务专属浏览器及 Windows 实机验收计为完成；后台工作流行当前进入所属任务详情，不提供新的脚本级独立停止接口。

### 后台子任务派发、协作与恢复（2026-10-01，当前接线）

- 按 Grok `Task/CheckSubagent/MessageSubagent/StopSubagent` 的操作语义，新增 `dispatch_task/check_task/message_task/stop_task`。复用现有 Cmb 确定性工作流、角色库、独立子任务模型图、审批、检查点、Git 工作区、结果文件和任务面板；派发后主 Bot 可继续工作，结束前自动等待并汇总真实结果。工作流脚本工具保留同步语义；后台接口派发单个独立项目任务，可连续派发多个。
- SQLite v23 保存任务定义、执行授权摘要与完成收据，升级前备份 v22。恢复重新检查项目、角色、模型配置和技能版本；不把模型凭据存入任务定义。同一调用重试返回原任务，完成结果使用稳定消息 ID，直到图检查点确认收到后才停止投递，避免“已标记投递但检查点未保存”的丢失窗口。
- 主 Bot 补充要求保存为 Bot 来源，不冒充人工输入、不触发 UserPromptSubmit、不授予新技能或审批。停止只影响指定子任务；已有外部操作仍须结算，不把“取消中”视为撤销成功。主任务新增要求不会取消已经派出的后台子任务；明确取消主任务仍停止其子任务。
- 原有四个模型子任务并发配额继续共用；脚本进程最多四个运行，其余在有界队列等待，排队取消释放位置。查询支持有界分页；轮询只读取轻量任务状态，不反复解析完整角色/脚本快照。主任务等待时显示协作进度。
- 派发事务预先保留真实子任务 ID；复用从原引擎机械抽取的调用摘要算法，排队、执行和恢复保持同一身份。第五个任务在四个模型槽位占满时即可查看和停止，验证未产生模型调用、检查点或文件操作。启动失败自动结算尚未认领的占位任务，避免孤立排队记录；停止父任务会等待已开始操作的清理。
- 初轮领域/真实模型图/进程/迁移关联 6 文件 63 项通过（`/tmp/cmb-background-owner3.log`）。真实模型图验证两个后台任务等待期间主任务继续读取文件、收到全部结果后汇总，以及模型查询/补充/单独停止。控制场景使用 64k 上下文的本地 SSE 夹具；最初 16k 夹具触发压缩却错误返回工具调用，调整该场景的上下文容量后验证目标流程，未修改产品的压缩保护。
- 编译 Host 两个 SIGKILL 案例再次通过（`/tmp/cmb-reserve-host-final2.log`）：普通目录与独立 Git 工作区均保持任务 ID、检查点、工作区、补充要求和用量预留；已完成修改不重跑，恢复新增预期的两次模型调用，父任务只交付一次。复测曾多出一次请求，诊断为旧测试固定等待 200 毫秒、短于测试模型 300 毫秒回包延迟，强杀发生在父模型请求途中；现按真实“等待子任务”状态确定强杀时点，不增加容许次数或修改产品恢复行为。
- 完整 `npm test` `/tmp/cmb-reserve-full.log` 退出码 0：579 文件通过/6 跳过，4562 项通过/72 跳过，后续集成组全部通过。最新 Node/Web 类型、构建、改动范围 ESLint 通过，工作流专项与真实 React 任务面板旅程通过；已查看 `output/bot-workflow/workflow-queued-dark.png`。此全仓门禁开始于下面技能导入改动之前，不作为技能导入验收依据。
- 仍未宣称子任务专属浏览器、任务续接到另一轮、完整后台任务管理界面或 Windows 实机验收完成。

### 技能导入与运行要求预览（2026-10-01，继续补齐 SKL-01）

- 复读 Grok `workflow-store.ts` / `workflow-model.ts` 的 Markdown 导入和 URL 来源入口。Cmb 复用已有技能安装器、嵌套名称冲突处理、编码识别、目录刷新门禁和 Bot 技能同步；将原上传窗口抽为工作台与 Bot 共用组件。支持本地 Markdown/ZIP、原始文件 URL 和粘贴内容，先预览后安装；链接按既定固定版本要求保存本次预览内容，不采用 Grok 的动态来源指针。
- 预览展示正文、附属文件、运行要求与 Hook 依赖。直接复用原 Hook 文档解析器，并与 Bot 运行时共用支持事件清单，明确标出暂不可用的检查；不把声明的环境要求显示为已验证，不自动执行脚本或安装依赖。安装后原完整文件继续进入既有 Bot 版本、权限和执行检查。
- URL 下载限 5 MiB、15 秒、3 次重定向，逐跳校验协议并禁止 HTTPS 降级，不携带浏览器 Cookie、模型凭据或自定义认证头；允许用户指定的企业内网 HTTP 文件源。关闭窗口或渲染进程退出会取消请求，主界面身份、同窗口单请求和全局并发均受检查。
- 原安装器与预览共用压缩包前置校验：正文 256 KiB、512 个条目、单文件 4 MiB、解压总量 16 MiB；拒绝路径穿越、Windows 保留路径、大小写重名、文件/目录冲突、链接及特殊文件。针对 AdmZip 的零长度头部绕过解压限额单独校验；安装校验预览内容摘要，不在确认时重新下载已变化的 URL。
- 安装在私有暂存目录写入并核验全部文件后，通过目录重命名发布；持久清单记录内容摘要、文件身份和完成状态，半份技能不会进入目录。发布完成但应答丢失时，同一请求核对原结果；历史收据不覆盖用户之后的修改或删除。完成收据约保留 256 项，未完成安装最多 16 项，上传队列最多 4 项。POSIX 目录持久化与 Windows 行为分别处理，未宣称 Windows 断电持久性已验证。
- 三种来源的真实 React → 主进程处理器 → 原安装器 → Bot 技能目录旅程通过；覆盖预览不安装、附属文件保留、远端变化不改写预览、关闭取消、安装应答丢失后重新加载界面并重试，文件未重复写入。浅色/深色截图 `output/skill-import/preview-light.png`、`preview-dark.png` 已查看。安装故障注入 7 项、关联读取/IPC/安装 19 项、Hook 共用 26 项通过；新代码 ESLint 无错误，原大文件有既有格式警告。
- 最新 Node/Web 类型、构建及完整 `npm test` 通过，退出码 0；主组 581 文件通过/7 跳过，4578 项通过/73 跳过，后续集成组全部通过。日志 `/tmp/cmb-skill-install-{tests,owner,ui,final-types,final-build,full}.log`。该全仓结果早于后续例程直接编辑改动。
- 尚未将 SKL-01 整项标为完成：环境依赖自动核验、远端来源更新管理与 Windows 安装实测仍需补齐；本轮恢复验证采用写盘故障注入和界面重新加载，未新增实际断电测试。

### 例程直接编辑与保存恢复（2026-10-01）

- 复读 Grok `routines/view.tsx`、`schedule-editor.tsx`，提取原 `serializeSchedule` 的日历预设表达式。例程面板可直接编辑名称、指令、时区、启用状态和触发方式；每天、工作日、每周、每月、每小时、自定义 cron、固定间隔、单次和事件主题共用创建/编辑表单，保留“对话调整”入口。
- 任意已保存 cron、单次毫秒时间、间隔锚点在修改其他字段时保持原值；仅改变间隔才重新计时。轮询不覆盖编辑草稿，版本变化要求用户主动载入最新内容；已删除例程不能被旧窗口复活。
- 保存复用现有 SQLite 收据与版本检查，重试不再次创建或修改。界面在发请求前保留尚未确认的请求和 nonce，关闭重开仍能核对；记录绑定 Bot、例程和备份恢复后的数据代际。旧收据不会覆盖后续修改，也不会恢复后来删除的例程。
- 领域/日历/历史/传输/IPC/草稿 6 文件 75 项通过；Node/Web 类型检查通过（同时修正导入窗口 UUID 引用类型过窄的问题）。真实 React 完整旅程通过，涵盖远端修改保留草稿、编辑/创建回包丢失后重开重试、原计划不偏移及对话调整、删除。已检查 `output/bot-workspace/routine-edit-dark.png`。构建通过，相关 ESLint 0 错误，`store.ts` 先前区域的 3 条格式警告未重排。
- 日志 `/tmp/cmb-routine-edit-{types2,final-owner,ui2,lint,build}.log`。事件主题仍依赖已接入系统发送事件，编辑器不自动部署外部连接器；Windows 安装环境未实测。本条不宣称已复刻原版所有例程触发器。

### 任务失败处理与恢复（2026-10-01，继续接通生命周期）

- 接通已激活技能的 `StopFailure`，复用 Cmb 原错误分类、事件匹配、输入字段与 Hook 执行器；按原执行链语义，在非取消异常且尚未进入正常完成检查时触发。失败处理仍需审批并在当前租约内等待，脚本返回成功不会将原任务标为成功，拒绝或失败也保留原任务错误。
- 失败处理前保存终止阶段和错误摘要；中断恢复直接继续失败处理，不重新请求主模型。已完成的处理使用原持久操作收据，后续处理继续按顺序审批；操作结果不明、技能撤销、过期租约、取消不启动新的处理。后台子任务先完成停止清理。导入预览与运行时支持事件清单同步。
- 真实模型图的批准、拒绝、取消、正常 Stop 与失败事件互斥 4 项通过；重开 SQLite 后失败阶段及完成收据复用 2 项通过。编译 Host 实际 SIGKILL 案例通过：第一个失败脚本完成、第二个待审批时强杀，恢复后第一个不重跑，第二个重新确认，主模型仍只请求一次，最终保持原始失败；日志 `/tmp/cmb-stop-failure-process.log`。
- 构建与 Node/Web 类型通过；关联 5 文件 136 项通过/11 跳过。完整 `npm test` `/tmp/cmb-routines-failure-full.log` 退出码 0：主组 582 文件通过/7 跳过、4590 项通过/74 跳过，后续集成组全部通过。该阶段只接通已安装技能的失败事件，不将全局/工作区/插件来源及所有会话生命周期标为完成。该全仓结果早于下面的技能转例程改动。

### 已验收技能转例程（2026-10-01，继续补齐 SKL-11）

- 在已有试跑验收、技能引用和例程编辑器上接通“设为例程”。绑定经过人工验收的具体技能版本；例程内容另存每次任务的输入要求。定时、事件及手动执行均把固定引用写入原消息，复用现有模型提示和执行前/工具前版本检查，不增加工具权限。
- SQLite v24 以独立表保存绑定，升级前备份 v23，不改写旧例程的触发时间或旧消息。保存继续使用持久收据；修改名称、内容、频率保留绑定，移除或换版本必须显式操作。模型的例程修改工具不能升级或解除技能绑定。
- 技能更新、停用或尚未通过验收时禁止运行；自动触发会暂停受影响例程并在对话中提示，其他例程继续分发。已排队任务保留原版本并在执行前复核。复制 Bot 会将绑定映射到新技能，但保持例程暂停，原 Bot 的验收不作为副本的验收。
- 领域新增 6 项通过；真实模型图验证定时/事件/手动均使用固定技能、排队后技能升级不产生新模型请求。结合 RPC、IPC 与原例程工具的定向组 4 文件 15 项通过/157 跳过；关联 11 文件 117 项通过。Node/Web 类型、构建通过；ESLint 0 错误，仅 `store.ts` 原有 3 条格式警告。真实 React 完整工作区旅程通过，已查看 `output/bot-workspace/skill-routine-light.png` 和 `skill-routine-version-block.png`。
- 完整 `npm test` `/tmp/cmb-routine-skills-full.log` 退出码 0：主组 583 文件通过/7 跳过，4599 项通过/74 跳过，后续集成组全部通过。首次新增界面脚本有局部变量重名及误用菜单选择器，已分别修正后完整旅程通过，未修改产品交互来迎合测试。本门禁早于历史任务导入接线。
- 本条只绑定已有试跑验收机制覆盖的 Bot 技能，不将安装技能的依赖核验、所有外部事件适配器或 Windows 实机验收计为完成。

### 安装/共享技能试跑与例程（2026-10-02，SKL-01 / SKL-11 继续接线）

- 复用已有试跑、人工验收和例程表单，安装的 Cmb 技能与个人共享技能也可使用；界面不提供修改安装文件或继承原 Bot 验收的捷径。通过记录绑定实际执行 Bot、技能身份和版本，技能正文、附属文件或启用状态变化后重新验证。复制 Bot 不复制通过记录，绑定例程保持暂停。
- 安装/共享试跑通过原技能引用接入提示、初始化 Hook、附属文件读取和执行前校验。初始化脚本仍需逐项审批；排队期间更新或撤回，在模型调用前拦截；人工验收不会把失败任务标为通过。私有技能原有历史版本试跑语义保持兼容。
- SQLite v26 将试跑证据扩展至共享身份，保留 Bot / run 外键、历史数据和幂等收据，迁移前备份。界面提交前保存原 nonce、输入和版本；刷新、技能更新或丢失应答后核对同一次试跑，恢复旧备份后不发送旧暂存请求。成功提交后的界面刷新失败不会使表单误显示为尚未提交。
- 调度读取技能目录不可用时，按原计划等待同步，其他定时例程继续运行；涉及未就绪技能的事件请求不确认接收，原事务回滚，可用相同 nonce 重试。已确认更新、停用或撤回则暂停受影响例程。
- 领域、真实 v25 表迁移、重开数据库、备份、RPC / IPC 和恢复状态 10 文件 124 项通过。实际模型图验证技能初始化脚本审批、原安装资料读取，以及排队后资源变化零新增模型请求，1 项通过（同文件其余 103 项本次未重复）。真实 React 资源面板验证试跑应答丢失后刷新并核对、旧版本不验证新版本、人工验收、安装技能设为例程和共享技能独立验收，已通过；浅色/深色截图 `output/bot-external-trials/` 已检查。
- 日志 `/tmp/cmb-external-trial-{final-owner,graph,ui5,final-types}.log`。初次界面回归发现恢复后的文本域缺少稳定的可访问名称，已添加明确标签；另修正测试脚本对关闭详情和保存按钮的定位。全工作区真实 React 旅程通过（`/tmp/cmb-external-trial-workspace-ui.log` 含清理完成标记）；Node/Web 类型、构建通过，ESLint 0 错误、仅 `store.ts` 既有 3 条格式警告。完整 `npm test` `/tmp/cmb-external-trial-full.log` 退出码 0：主组 587 文件通过/9 跳过、4622 项通过/76 跳过，后续集成组全部通过；该门禁早于后台任务面板接线。依赖自动核验、来源更新管理及 Windows 实机仍未计为完成。

### 旧任务文字记录关联（2026-10-02，OPS-12 接线）

- 复用 Cmb 原有任务目录、消息分页和可见消息判定，用户在 Bot 菜单中选择旧任务并逐条勾选文字；每页最多 40 条，每次最多 40 条/24,000 字符。只提供完整的用户/助手文字，工具结果、推理内容、图片数据、系统提示、运行控制消息和过长/截断预览不进入选择。目录分页渲染，不一次性展开全部历史。
- 导入为 Bot 私聊中的参考快照，保留原任务 ID、标题和选中消息 ID；不创建执行任务、不复制账户配置、项目文件或原审批。历史助手文字进入模型时仍是引用资料，不重放成当前助手回复或工具结果。用户后续交办任务时可以引用；详情可打开原任务，原任务删除后快照仍可查看。
- SQLite v25 在原消息旁记录来源；升级前备份 v24，消息与来源、事件和请求收据在同一事务提交。应答丢失后，界面关闭/重新加载可核对同一次请求；原任务随后变化不改写已确认快照。暂存请求绑定 Bot 和数据代际；切换任务后丢弃旧分页响应。
- 真实 Cmb SQLite 分页 → React 勾选/预览 → Bot API/SQLite 旅程通过，覆盖跨页选择、迟到响应、导入应答丢失后重载、源任务改动与删除；已检查浅色/深色截图。关联 8 文件 104 项通过；真实模型图另验证导入不调用模型，新任务只将历史作为用户级引用数据且不继承操作授权。Node/Web 类型和构建通过，相关 ESLint 0 错误，仅原有 `store.ts` 3 条格式警告。
- 日志 `/tmp/cmb-context-import-{final-owner2,graph,final-types,final-lint,build}.log`；完整 `npm test` `/tmp/cmb-context-import-full.log` 退出码 0，主组 585 文件通过/8 跳过、4609 项通过/75 跳过，后续集成组通过。该结果早于后续安装/共享技能试跑扩展。这里迁移的是明确选中的可读文字快照；仅存于旧检查点的任务需先由原 Cmb 界面加载历史，不宣称自动迁移旧执行现场或 Windows 实机验收完成。

### 工作副本预览与隔离技能检查（2026-10-01）

- 工作区详情复用原 Git 生命周期查询与差异视图，展示冻结基线到当前工作副本的已提交、暂存、未暂存与未跟踪文本。禁用外部 diff/textconv；符号链接只展示链接本身，不读取目标。二进制、大文件、读取失败和截断明确提示，需外部审查的差异不开放直接合并。实际 Git worker 新增两类场景通过，真实 React 旅程通过，已查看未跟踪文件差异截图 `output/bot-workflow/workflow-uncommitted-dark.png`。
- 隔离子任务的 command Hook 使用已核验技能版本在工作区内的专用副本，执行目录、标准输入与环境变量一致指向隔离任务。复制有总量限制，拒绝软链接目录、junction、硬链接或已被修改的副本；原技能目录不作为可写执行目录。HTTP Hook 同样携带实际工作区；受限角色和显式禁止工具不能借 Hook 扩权。继续使用既有命令策略/Windows 沙箱配置，未把私有目录等同于完整操作系统隔离。
- 新增可恢复工具失败的 `PostToolUseFailure`：命令非零退出或文件读取失败后，在租约内审批并等待检查，结果交回原模型图；检查要求停止时不继续调用模型。复用 Cmb 原事件字段与判定规则；默认桌面链路保留原失败回调，不重复执行。普通文字中的 JSON 片段不误判为工具退出收据。
- 隔离 Hook/命令/技能/子任务 4 文件 40 项通过；Hook/工作区/内核后续组 3 文件 36 项通过；真实模型图 3 个失败/停止场景通过。Node/Web 类型、构建、相关 ESLint、原 Hook 全组通过。完整 `npm test` `/tmp/cmb-hooks-preview-full.log` 退出码 0：578 文件通过/6 跳过，4550 项通过/70 跳过，后续所有集成组通过；该轮 Vitest 开始于后台任务实现之前，不作为后台任务验收依据。
- 全局/工作区/插件来源的 Hook 和其他会话/失败生命周期事件仍未全部接通，Windows 安装与本机沙箱行为、Linux/K8s 部署仍待实机验证。

### 任务链模型额度与子任务操作（2026-10-01，继续验证中）

- SQLite v22 将已有模型请求台账扩展到父任务、peer 委派、工作流子任务、上下文压缩、模型 Hook 和插件 SDK 模型调用。每次 HTTP 尝试在派发前预留同一根任务的额度，重试/新工作流/新子任务不能重置额度；不同根任务互不挤占。旧 v21 的已用量与未决预留完整迁移。
- 完整 SSE 和有界完整 JSON 回执可按供应商实际输出用量结算；断流、错误、超限或未完整结束的响应保留预留。复用原响应诊断的透传流，不复制无界响应，不把模型内容写进用量日志。任务记录展示整个任务链的已确认用量与待确认预留。
- 定向追加要求与停止子任务接入现有 Cmb 持久输入队列/工作流取消机制。请求绑定会话、分支、子任务、版本与 nonce；失败重试不重复投递，不影响兄弟任务。补充要求使旧结构化结果失效；最后结算间隙仍未处理的输入转为人工核对，不静默创建另一项普通任务。
- 已复读 Grok `sand-subagent-management-tools.ts` 的查询/追加/停止语义；本实现复用 Cmb 的消息队列与持久租约，不直接采用原版内存注册表作为恢复依据。模型自行启动、查询、追加要求和停止后台子任务已在后续接线，见本页后台任务记录；完整后台任务面板及子任务浏览器尚未整体完成。
- 用量/诊断/迁移/历史组 4 文件 41 项通过（`/tmp/cmb-root-budget-final-tests.log`）；真实图模型/角色/技能 Hook 回归通过。子任务领域、真实模型图与 IPC 3 文件 64 项通过（`/tmp/cmb-child-controls-tests.log`），包括结构化结果已产生后被新要求修订。随后输入队列/策略/IPC 补充组 4 文件 68 项通过。
- v22 首轮全仓回归 577 文件通过、1 文件失败、6 跳过，4530 项通过、1 项失败、70 跳过（`/tmp/cmb-root-budget-full.log`）：MCP 结果发布时策略执行器一次不可用；单独复现通过。应用自有的纯策略计算增加一次受限重建重试，不重放外部工具，不放宽隔离预算，连续失败仍拦截；专项通过。随后全仓回归 4535 项通过、2 项失败：可选 threadRootId 为 undefined 时的收据序列化问题已修复；原 Git Hook 多仓库扫描超时的专项复核通过，未放宽超时或删减断言。随后完整回归 `/tmp/cmb-orphan-final-full.log` 通过（退出码 0）：578 文件通过/6 跳过，4540 项通过/70 跳过，全部后续集成组通过。此结果早于下面的新差异预览和技能 Hook 改动。
- 真实 React + Bot API + Git worker 旅程通过（`/tmp/cmb-child-controls-ui4.log`）：补充要求回复丢失后重试只投递一次，停止单个子任务不停止兄弟任务，浅色/深色、差异全屏及清理确认截图已检查。实际编译 Host 的两个 SIGKILL 案例再次通过（`/tmp/cmb-child-controls-host-recovery.log`），新增验证未处理的补充要求、未结算额度预留跨重启保留，恢复只产生预期的新模型请求。

### 独立代码工作区、交付与清理（2026-10-01）

- 显式 `isolation: "worktree"` 复用 Cmb 原 Git worktree 创建、归属校验、项目子目录限制、合并和清理实现；SQLite v21 固定工作流源版本、子任务工作区身份和用户操作收据。并行子任务各自使用独立目录/分支，源项目未提交内容不带入，模型不能在隔离执行中切换或合并源分支。
- 工作区 Git 操作在独立 Node 进程中执行；复用命令进程通信与取消机制，以进程生命周期 SQLite 锁串行化跨 Host 重启后的同仓库操作。恢复沿用原工作区、分支和检查点，不创建另一份目录覆盖已有成果。
- 真实 Cmb 模型图已验证：审批项目修改、原 Cmb 命令提交、形成可审查代码差异；只有用户确认后才合并源项目。合并和丢弃校验用户审阅的提交，操作 nonce 与任务/会话/动作绑定；删除成功但数据库应答丢失后可安全重试。活动任务不能被人工清理。
- 任务记录复用 Cmb `DiffDisplay`，支持代码着色、文件切换、全屏审查、合并确认、丢弃确认及待清理重试；修复原全屏组件嵌在任务弹窗内时被父弹窗限制的问题。已运行真实 React + Bot API + Git worker 旅程，检查深色差异、全屏和删除确认截图（`output/bot-workflow/`）。
- v20 → v21 升级保留原子任务身份/状态，升级前快照有效；恢复 Bot 备份后未完成任务停止，外部工作区保持当前文件内容，遗留运行状态转为可核对。备份界面明确包含数据库与附件、不包含项目文件及独立代码工作区；不会把旧数据库快照当作 Git 文件回滚。
- 实际编译 Host 的两个 SIGKILL/重启案例通过（普通目录、独立工作区各一）：已完成修改不重跑，未完成子任务恢复相同目录和检查点，父任务只交付一次。初版工作区接线全仓 `npm test` 通过：577 文件通过/6 跳过、4516 项通过/70 跳过，全部后续集成组通过（`/tmp/cmb-worktree-full.log`）。随后清理、升级、备份关联组 4 文件 34 项通过（`/tmp/cmb-worktree-cleanup-final.log`），真实 UI 旅程通过（`/tmp/cmb-worktree-ui-fullscreen.log`）。
- 工作区归属清单已落盘而 SQLite 绑定丢失时，任务详情按工作流/子任务/冻结源版本找回同一目录，不创建替代目录。读取时无记录返回明确的未创建状态；缺失或损坏目录仍提供归属记录及显式清理入口。实际 Git worker 关联组 3 文件 43 项通过（`/tmp/cmb-worktree-orphan-tests.log`），包含原 Git Hook 扫描专项。
- 限制仍明确保留：工作区依赖本机 Git；超大/二进制差异只提供有界预览与本地审查提示；归属清单本身未成功落盘的创建中断仍需核对。未提交文件预览、隔离任务命令/HTTP Skill Hook 已在下述记录接入。未做 Windows 实机和 Linux/K8s 部署验收。

### 工作流模型子任务、恢复与任务界面（2026-10-01，继续实现中）

- `workflow` 已接入 Bot 的真实 Cmb 模型图和独立脚本进程。复用原角色库、调度、结构化输出工具、输出解析及用量提取；父任务可并行启动同一 Bot 的多个子任务，每个子任务有独立运行记录、检查点、审批、取消和结构化结果。子任务只获得分派提示及项目能力，不继承父任务私聊/记忆或借用其浏览器。
- SQLite v20 持久保存子任务身份、完成收据、结构化输出、用量及模型请求预留。原引擎增加稳定的内容摘要/出现次数标识：并行顺序变化、子任务已完成但 journal 尚未写入后重启，都不会误复用兄弟任务或重复执行已完成任务。旧执行器不能取消或结算接替它的新租约。
- 角色限制落实到实际工具、插件 SDK 和命令进程；只读角色保留原 Cmb 命令规则，受限子任务不能经命令/HTTP Hook 绕开限制。显式 worktree 隔离现已接入下述独立工作区实现；无效 Git 项目仍在模型调用前拒绝，不降级到共享目录。
- 工作流子任务共用根任务输出额度（200,000 tokens）；每次真实 HTTP 尝试先持久预留，明确的完整流式 usage 回执释放余量，断流/未知用量保留预留。该阶段只覆盖子任务；后续 v22 扩展到父任务、peer 与模型辅助调用，见下述记录。
- 任务记录支持子任务列表、状态刷新、查看结果和返回父任务；运行区与审批卡显示子任务名称。真实 React 浅色/深色旅程通过，已查看 `output/bot-workflow/workflow-tasks-light.png` 与 `workflow-result-dark.png`。
- 真实 Cmb 图及领域关联组 3 文件 97 项通过/11 项可选跳过；旧执行器取消新租约的专项补充后，领域 9 项通过。新增模型中间件暴露了原输入检查 Command 重复传播问题，输入回执改用幂等集合，检查点标记允许重复应用；两项失败场景及整组回归已通过。
- 编译 Host 实际 SIGKILL、重启与人工恢复测试通过：两个子任务身份不变，已完成文件修改只执行一次，未完成子任务保留检查点并继续，父任务只交付一条最终答复。构建通过；日志 `/tmp/cmb-workflow-host-recovery.log`、`/tmp/cmb-recovery-regression.log`、`/tmp/cmb-child-stale-runner.log`、`/tmp/cmb-workflow-build2.log`。该阶段全仓 `npm test` 已通过（退出码 0）：576 文件通过/6 跳过，4509 项通过/69 跳过，后续集成组全部通过。运行环境为 macOS 和本地受控模型服务，未进行 Windows 实机或外部模型质量验收。
- COL-11/12 仍未整体完成：完整后台任务命令/面板及子任务浏览器仍有缺口；隔离工作区接线进展见下述记录。

### 确定性工作流内核与 Host 存储（2026-10-01，接线中）

- 复用 Cmb 原 `workflow/engine` 的 `agent/parallel/pipeline/workflow` 调度、内容摘要恢复及预算计算；将原 run-store 内存变更、glob 流式遍历机械提取为共用代码。桌面接口与文件存储继续使用原实现。复读 Grok `source/host/runner/subagent-runtime.ts` 的独立子会话、来源标识、取消/追加要求及结束回收；其内存生命周期记录不能替代 Bot 的持久租约。
- Bot 工作流脚本运行于独立 Node 进程中的可终止 Worker；监督进程始终响应 Host 断开。进程只接收脚本、状态、角色配置和消息，不接收模型凭据或项目访问路径。文件读取、写入、嵌套脚本与模型子任务经有界 RPC 交回 Host；原 VM 的构造器链隔离保留。Host 校验租约，脚本心跳失联时终止，取消后等待已派发的 Host 操作结算。真实 `await` 后死循环、微任务死循环，以及实际杀死父进程后的清理均已验证。
- 复用 `BoundedWorkerAdmission` 将不同工作流进程的 Host 子任务合计限制为 4 个。协议限制消息大小、挂起调用和事件数；每项文件操作根据内容及出现次数生成稳定身份，并行模型完成顺序不会改变同一文件操作的重放身份。
- v19 增加工作流状态、独立 journal 和文件观察表；状态与 Bot 数据库共用事务及备份。复用原内存变更规则，同一调用位置的不同内容保留各自记录；脚本、输入、模型或 Host 授权快照变化禁止重新绑定旧调用。保存失败后旧内存实例不可继续使用，过期租约及被接替的执行实例不可落库。元数据 4 MiB、journal 总量 24 MiB、文件观察总量 16 MiB、完整结果 8 MiB，各有明确上限。
- 工作流文件操作复用原项目权限、稳定读取句柄、审批差异、修改前备份和 CAS 写入。文件观察在本次工作流内固定，恢复使用原结果；新的读取身份仍可读取最新内容。拒绝被记录，恢复不会再次询问同一次拒绝；已成功写入不重复执行，审批期间文件变化保留他人修改并标记结果待核对。项目被替换时，旧观察缓存也不可使用。
- 源码进程/SQLite/真实文件接线 3 文件 24 项通过；编译后的实际 Electron/Node 执行进程 11 项通过。实际 v18 升级、现有迁移/备份组 33 项通过，原工作流引擎 96 项通过。`test:workflow` 首轮因 2 个静态断言仍检查提取前文件位置失败，迁移断言到共用内核并保留委托关系校验后，该 87 项静态组通过。Node 类型、此次新增代码 ESLint 和构建通过；原 run-store 未改动区域的格式警告保留，避免无关重排。完整 npm test 随后通过（退出码 0）：Vitest 573 文件通过/6 跳过，4485 项通过/68 跳过，后续集成组全部通过。此轮整仓门禁早于下一条结构化输出提取与归属检查，后续修改另有专项验证。
- 后续补上 Host 状态/租约归属核对，关联 4 文件 28 项通过。原结构化输出工具及其 schema 适配、近似输入修复和失败上限从 `subagent.ts` 机械提取到无桌面依赖的 `structured-output.ts`，旧导出保留；依赖边界验证及原引擎 96 项再次通过。日志 `/tmp/cmb-workflow-boundary.log`、`/tmp/cmb-subtask-structured-{types,owner}.log`。
- 日志 `/tmp/cmb-workflow-{process3,store-tests,files-tests,integrated,compiled,owner,contract-tests,final-types,final-lint,build,full}.log`。本节记录执行内核和存储接线阶段；后续模型子任务与界面进展见上节，COL-11/12 仍不标整体完成。未进行 Windows 实机验收。

### 共用 Hook 执行链及技能完成检查（2026-10-01，继续接入中）

- 将原 Cmb Hook 判定、作用域过滤和工具中间件提取为共用内核。桌面仍使用原配置/日志服务，Bot 注入任务租约、已确认技能来源及审批收据；没有重写事件匹配、输入改写、JSON 决策或完成检查协议。既有 Mods 继续负责插件授权，改写后的工具参数再次进入原权限校验。
- 读取已安装技能的 SKILL.md frontmatter、hooks.json、hooks/hooks.json，复用 Cmb 原格式解析器；读取和执行均校验技能及附属文件版本。当前接通 PreToolUse、PostToolUse、PostToolUseFailure、PreSkillUse、PostSkillUse、UserPromptSubmit、Stop；后续已增加 StopFailure，见本页失败处理记录。其他启用事件会明确阻止该技能使用，不静默忽略。全局/工作区/插件级 Hook，以及会话/失败等其他生命周期事件仍需接入；不得将本节记作完整标准执行链完成。
- 共用本地执行器增加仅供 Host 使用的解释器/标准输入/分离输出接口，保留 Windows 既定沙箱模式、取消和进程树清理；原 Cmb 的解释器选择、Windows 输出解码继续共用。环境只补充已定义事件字段，不传模型密钥或 shell 启动注入变量。输出超限、标准输入异常或不确定中断不能作为正常策略结果；失败清理也释放本次 ACL。
- 每次 Hook 显示技能来源、版本、实际命令或 URL/模型、执行目录和事件输入预览，单独审批。稳定事件身份、输入摘要和执行结果保存到现有事务收据；审批期间源文件变化会停止，拒绝时不执行后续动作，不确定结果需核对。once 状态在当前任务内持久恢复；它尚不表示跨任务的会话级注册/持久激活已完成。
- Stop 检查可让 Bot 继续补证据和修订，最多三轮；明确停止时不把草稿登记为成功。修订次数进入持久收据，模型修订继续使用原图、检查点、权限和审批。原配置为 async 的 Host Hook 必须在租约内结束；通知/结束事件内核也不会提前返回或在后台忽略取消。
- 已通过真实命令输入/输出/超限/父进程断开、真实模型图中的参数改写/拦截/拒绝/源文件变更、完成检查修订/停止，以及重开 SQLite 后已完成结果重放/once/不确定结果拒绝。关联回归 5 文件 96 项通过、11 项可选实测跳过；独立内核 10 项通过。原 Hook 全组已通过一次，此前该版完整 npm test 已通过（退出码 0）：Vitest 570 文件通过/6 跳过，4437 项通过/66 跳过，后续集成组全部通过。以下新增技能生命周期晚于这轮全仓门禁。
- Node/Web 类型、相关 ESLint、构建通过。真实 React 资源/审批旅程通过，已查看 `output/bot-memory/skill-hook-approval-dark.png`；测试定位修正为匹配带“预览”后缀的输入折叠入口，产品逻辑未改变。最新编译命令进程 5 项通过、5 项非目标跳过。上一版全仓 npm test 已通过。当前所有实际运行环境仍为 macOS；Windows restricted-token/elevated 的标准输入转发、Job/后代终止与安装布局仍需 Windows 实机确认，不将本机通过等同于 Windows 生产验收。
- 日志：`/tmp/cmb-hook-{protocol-tests,lifecycle-tests,graph3,stop-tests,durable-tests,regression,final-node-types,final-web-types,final-lint,final-build,ui2,compiled-shell,full}.log`。
- 后续复用原 Cmb `activation` 和 `completion-hooks` 的纯策略内核，接通技能启用前/完成后检查；原桌面 API 保留。用户明确选中的技能在调用主模型前完成检查，动态读取正文/附属文件先检查再提供内容；不通过时不会先泄露步骤再补检查。启用成功及检查说明持久保存，恢复和摘要后重新注入指导；分页读取不重复运行启用脚本。
- PostSkillUse 在生成最终答复后触发，每个成功启用的技能执行一次；沿用原 Cmb 的“检查请求修订后也标记已触发”语义，由 Stop 检查每次修订结果。检查收据关联完成消息和输入，重启同一完成边界返回原判定；PostSkillUse 与 Stop 的三次修订额度独立，旧 Stop 收据保持兼容。暂停/不确定执行不会误写检查完成收据。
- 审批期间有新要求时，取消尚未执行的旧审批，通过原输入队列接收消息并写入图检查点后再进入模型节点；未提前放开工具执行。真实图已验证这条路径，命令执行一次，主模型看到新的要求。后续已接通 UserPromptSubmit，见下条；完整会话生命周期仍未完成。
- HTTP Hook 已验证真实 POST、重开 SQLite 后不重复发送及不向重定向地址转交输入；模型 Hook 复用实际 Cmb 模型工厂和流式协议，明确拒绝非法策略判定/评估异常。此处使用本地受控模型服务，未宣称外部模型的策略判断质量已验收。
- 新增启用/完成真实图 6 场景通过，审批期间追加要求专项通过，恢复/网络/共用内核 22 项通过；原桌面技能激活和完成检查脚本通过，原 Hook 全组通过。该版 Bot 图等 5 文件 105 项通过/11 项可选跳过，Node 类型、ESLint 和构建通过。完整 npm test 已通过（退出码 0）：Vitest 570 文件通过/6 跳过，4453 项通过/67 跳过，后续集成组全部通过，日志 `/tmp/cmb-skill-lifecycle-full.log`。编译 Host 实际 SIGKILL/重启/人工恢复后，启用指导保留且已批准脚本只执行一次（`/tmp/cmb-skill-lifecycle-process2.log`）。首次进程测试误从只含摘要字段的 runHistory.run 读取 result，改为检查真实消息后通过，产品代码未为此改变。以下输入提交接线晚于这轮全仓门禁。日志 `/tmp/cmb-skill-lifecycle-{graph,steer4,core,desktop,desktop-activation,desktop-completion,regression,final-types,lint}.log`。

- UserPromptSubmit 使用 Cmb 共用输入准备规则，作用于原始任务及已被队列接受的补充要求；在主模型请求前审批、执行并保存判定，复用输入改写、附加上下文和拦截规则。已处理输入即使没有匹配 Hook 也保存完成记录，后来读取的新技能不会追溯检查旧消息；历史消息、工具消息和内部修订消息不作为用户新输入重复处理。恢复时使用原判定，不重复执行脚本；不缓存并覆盖其他模型中间件的整个请求。
- 输入/技能审批遇到新要求时，先通过原队列返回稳定消息及应用水位，再写入图状态并重新进入模型节点。完成检查审批期间也可接受新要求继续同一任务；修订次数与补充输入次数分开计数，最终检查包含已接受的新要求。已开始的外部操作沿原有收据流程结算，不把中断视为允许重发。
- 输入检查真实图 5 场景通过（首次改写/拦截、流式期间追加要求/追加要求被拦截、输入审批期间再追加要求）；7 文件 126 项关联回归通过/11 项可选跳过。交付检查追加要求及关联输入专项 8 项通过；节点类型与本轮 ESLint 通过，最新构建通过。日志 `/tmp/cmb-submit-{durable,graph,regression,completion-steer,types2,lint,build,final-types,final-lint}.log`。最新完整 `npm test` 已通过（退出码 0）：Vitest 570 文件通过/6 跳过，4461 项通过/68 跳过，后续集成组全部通过，日志 `/tmp/cmb-submit-full.log`。编译 Host 的 PreSkillUse/UserPromptSubmit 两个实际 SIGKILL、重启与人工恢复场景通过：检查说明/输入判定保留，已批准脚本没有重复执行；日志 `/tmp/cmb-submit-process.log`（2 项通过、17 项非目标跳过）。

### Cmb 既有技能目录同步（2026-10-01，继续补齐中）

- 复用 Cmb 原 `skill-plugin-catalog/reader` 的目录分页、私有覆盖内置规则、插件启用状态和精确身份解析；停用清单使用单独的 disabled 分页读取，未假定 skills 页面包含该清单。解析运行于独立受限进程，复用从原文档解析器提取的进程生命周期、超时、取消和退出清理。
- Desktop 将技能源路径与全局/停用修订纳入现有配置同步，文件树变更期间等待原拓扑门禁；配置变更先使旧快照失效。Host v18 保存只读技能缓存，独立启动后重新验证来源，不将数据库缓存当作授权。按修改时间/文件身份在工具边界拒绝旧版本，刷新失败停止使用旧目录，Bot 私有技能仍可用。
- `/` 选择、输入准备和 `list_skills/read_skill` 接入已有技能。更新/停用/卸载保留历史引用且递增可用版本，不能改写已接受的任务。新增「CmbCowork 技能」页签与搜索、手动刷新、正文预览、同步提示；目录查询只读取名称/来源/版本列，避免将全部正文反复解析或通过 RPC 发送。
- 512 项/16 MiB 总同步内容，单个源文件 256 KiB、有效步骤 64,000 字符；超出部分给出提示，不静默声称全部已同步。目录全量后台复核 30 秒，配置/停用文件变更提前触发；已读取技能的正文文件变化在下次执行边界校验，不等待周期扫描。
- 原技能目录、文档解析、配置同步等 30 项测试通过；外部技能、共享技能和引用 17 项通过；备份/迁移/无 Electron 依赖边界/IPC 等 70 项通过。真实模型图读取技能后修改源文件，后续工具写入被拦截；完整资源窗口旅程通过，更新显示新版本、停用移除旧预览，已查看 `output/bot-memory/installed-skills-dark.png`。Node/Web 类型、相关 ESLint 和构建通过。
- 日志 `/tmp/cmb-catalog-{reader-tests2,domain,regression,graph,ui2,types4,lint2,build}.log`。编译 Host/SIGKILL 专项通过：读取技能、实际执行、强制结束、重启后拒绝已停用版本，日志 `/tmp/cmb-catalog-process4.log`。初次测试错误地从活动列表寻找已完成任务，修正为任务历史查询后通过，未改变运行逻辑。该版完整 `npm test` 退出码 0：Vitest 568 文件通过/6 跳过，4405 项通过/66 跳过，后续所有集成组通过；日志 `/tmp/cmb-production-catalog-full.log`。以下附属文件扩展晚于这轮全仓检查。
- 后续补齐附属文件（见下节）。尚未把 SKL-01/03 判定为全部完成：本地/URL 导入及安装同步旅程随后补齐，见本页技能导入记录；依赖环境实际检查、Windows 打包后的技能布局仍需实机验证。

### 技能附属文件与脚本复用（2026-10-01）

- 独立目录进程扫描每个技能的附属文件和目录身份，最多 512 个条目、12 层深度、2048 个访问条目；隐藏项、Git/依赖缓存、符号链接/硬链接及独立嵌套技能不作为父技能资源。超限明确拒绝该项同步，其他技能仍可用。SKILL.md、脚本、模板和目录变化均纳入版本，不只检查说明正文。
- 新增 `list_skill_files/read_skill_file/copy_skill_file`，只接受当前技能 ID 和目录内相对路径。直接复用既有稳定文件句柄、独立文档/图片解析器、项目 CAS 写入、变更备份和审批收据。图片/Office/PDF 阅读与会话附件共用实现；没有增加任意主机路径或自动脚本执行权限。
- UTF-8 脚本/文本模板不超过 2 MiB 时按原始内容复制并展示差异，保留 BOM、换行和修改前文件；其他模板最多 25 MiB，只能创建新文件，不覆盖现有二进制文件。原模板保存为带“技能文件”来源的恢复证据。脚本执行沿用项目命令的独立审批与沙箱配置。
- 技能预览显示附属文件数量和原始 compatibility 要求；“安装与管理”打开原 Cmb 技能管理页，继续使用既有 .md/.zip 上传、编辑和停用流程。运行要求当前属于技能声明，未宣称已探测本机解释器/依赖或自动安装完成。
- 已验证实际图中读取→复制→执行脚本→命令输出，审批前不会产生目标文件；审批中源脚本改变后拒绝复制，后续命令未执行。真实 Word 模板经审批复制后字节一致。项目工具新增实际目录身份校验，路径相同但根目录被替换后停止读取/写入。
- 92 项关联图/目录同步/项目文件/文档解析/无桌面依赖测试通过，11 项可选实测跳过；另 22 项迁移/资源边界专项通过，包含实际 v17 升级与资源树超限。最后的共用写入整理、文件来源、入口按钮与嵌套技能停用保护复测 31 项通过；最终 Node/Web 类型、相关 ESLint 和构建均通过。
- 完整 React 资源窗口旅程通过，已检查 `output/bot-memory/installed-skills-dark.png` 与 `skill-template-approval-dark.png`。日志 `/tmp/cmb-skill-files-{fences,graph}.log`、`/tmp/cmb-skill-resource-{regression,ui,node-types,web-types,build}.log`。最新编译 Host 从真实技能目录读取附属 Markdown、执行后 SIGKILL、重启停用保护和维护进程备份恢复两项均通过；日志 `/tmp/cmb-skill-resource-process.log`。收尾日志 `/tmp/cmb-skill-finish-{tests,node-types,web-types,lint,build}.log`。

### 用户共享技能库（2026-10-01）

- 复核 Grok `host/workflows/workflow-library.ts` 和 `host/extensions/mcp/skill-publish.ts` 的独立技能库、来源和发布模型；Cmb 复用已有技能、选择器、输入准备、SQLite 事务和 nonce 收据，新增 v17 共享技能表与任务读取版本记录，没有直接依赖 Grok 私有 Dashboard 服务。
- 用户查看具体技能步骤后，可发布到个人所有 Bot 可用的技能库。共享版本独立保存；原 Bot 的修订/删除不自动更改已共享内容。更新、撤回都检查已确认版本，响应丢失重试保持原收据。模型没有发布接口，私聊、录屏、凭据和试跑记录不随技能公开，也不继承原项目的验证结论或授权。
- 复用 `/` 技能选择、首次及执行中输入准备、`list_skills`、`read_skill`。明确选择或动态读取的版本均有执行校验；撤回/更新后阻止旧任务继续派发工具。动态读取版本持久保存，重启仍受约束，已有操作和对话文本不会被抹除。最多 256 项同时启用的共享技能，总序列化内容不超过 4 MiB，避免超过 RPC 上限。撤回释放共享内容；重新发布分配新身份，旧任务不能重新获得读取权。
- 界面增加「此 Bot／我的技能库」，共享前完整步骤预览、撤回确认和亮暗主题；异步读取有请求代次隔离，后台刷新保留当前编辑。真实 React 旅程通过，包括提交成功但响应丢失、同一 nonce 重试、其他 Bot 可用、私有新版本不外泄、撤回后目录消失。已查看 `output/bot-memory/skill-library-light.png`、`skill-library-withdraw-dark.png`。
- 74 项存储/技能引用/输入准备/迁移/备份/IPC 等专项通过；补充 v16 升级及重开数据库后任务版本保护，12 项迁移测试通过。真实图与认证 RPC 两项专项通过，图中模型读到共享步骤后撤回，后续记忆写入没有执行。Node/Web 类型、相关 ESLint、构建通过。
- 最新编译维护进程实际备份/恢复并重启 Host 后，共享技能及发布收据一致（1 项通过，15 项非目标测试跳过）。日志 `/tmp/cmb-skill-library-{regression,graph,migration,ui2,types3,lint2,build,process}.log`。
- 本轮未将 SKL-01/03 整项标为完成：文件/URL/附属文件导入随后补齐，见本页技能导入记录；完整插件技能同步及依赖环境检查仍需补齐。个人共享边界仍是独立本机 Host；团队跨账号发布没有实现。

### 记忆范围、界面及恢复验证（2026-10-01）

- SQLite v16 新增独立共享记忆表，区分“此 Bot／当前项目／我的所有 Bot”。私聊记忆、自动整理队列和来源消息保持原边界；共享条目由用户明确填写，不自动公开私聊内容，也不允许模型借 `remember` 修改共享条目。
- 同项目以配置目录的真实路径确定，不从父级 Git 仓库扩大范围。模型任务固定首次读取的项目身份，目录联接改指向其他项目时拒绝沿用旧任务检索；项目切换、Bot 配置版本变化、猜测其他项目记忆 ID 均有校验。模型按页检索可用事实，群聊不提供私聊或用户共享记忆工具。
- 共享条目支持 CAS 修订、明确范围的删除确认、持久 nonce 收据；重试创建/删除不会重复或复活数据。删 Bot 保留其他 Bot 使用的共享条目。纠正共享事实会撤销此前私聊整理快照与待处理证据，旧任务不能再次自动提炼旧内容；已有对话文本仍保留，不能宣称从已发送的上下文中抹除信息。
- 单范围最多 256 条、单条最多 8,000 字符。界面复用既有 Radix Tabs/Dialog/Button 和记忆卡片；支持键盘切换、亮暗主题、范围说明、错误提示及删除确认。已从工作区大组件抽出资源窗口；真实界面验证保存、修订、切换范围和确认删除。测试页面修正为标准 HTML 模式，截图 `output/bot-memory/memory-project-light.png`、`memory-user-dark.png` 已检查。
- 作用域以当前本机用户的独立认证 Host 和数据目录为边界；两个隔离 Host 的数据互不可见。未实现跨账号共用单数据库的租户系统，未来 K8s 仍须在可信服务端分配独立身份/存储，不能将此测试描述为多租户生产验收。
- 83 项存储/迁移/备份/IPC/JSON 存储专项通过；补充真实模型图和 RPC 验证通过。编译后的独立维护进程实际备份、恢复，再启动 Host 验证共享记忆仍在（1 项通过，15 项非本次目标跳过）。模型图使用本地受控 SSE，未新增外部真实模型效果结论。日志 `/tmp/cmb-memory-scope-tests.log`、`/tmp/cmb-memory-scopes-graph.log`、`/tmp/cmb-memory-scopes-process.log`、`/tmp/cmb-memory-scopes-layout4.log`。

### 全仓门禁修复与浏览器扩展恢复（2026-10-01）

- 从本仓库历史提交 `c660e8f93200f291400c419e86e754d1638900d3` 恢复既有 Chrome Native Messaging 扩展，保留原 public key、协议和宿主名，来源及原文件摘要记录于 `chrome-extension/SOURCE.json`。接入既有测试要求的首连退避/分钟告警重连；增加普通配置限定、协议/权限检查、Cookie 数量/UTF-8 分块/总大小上限。只在临时夹具中验证，没有读取用户真实 Cookie 或安装扩展；Windows 注册/安装仍待实机验收。
- 修复 macOS `/var` 与 `/private/var` 路径别名对真实 Git 回滚和仓库发现的影响；文件访问仍保留真实路径包含关系检查，Windows 以外不再将所有路径强制小写。同步修正相关测试夹具的规范路径、Windows 平台桩及过长 Unix socket 名。
- Vitest 外层并发限制为 2（可由 CLI 覆盖），以容纳各测试内部 SQLite/QuickJS/迁移 worker 和子进程；没有放宽超时或性能断言。大 JSON 的元数据拒绝测试改为直接检查未分配/解析巨量内容，不再错误要求短于 1 ms 的异步操作期间定时器必须触发。
- 最新全仓 Vitest：565 文件通过、6 文件可选实测跳过，4384 项通过、65 项跳过，没有未捕获错误。后续 `npm test` 集成组继续执行至 IM 本地招乎旅程，遇到旧线程标题断言；随后按现有项目模式标题/回复规则更新旅程测试，并将 IM 设备 takeover 退役检查限定到 IM 实现，避免误拒绝 Bot 浏览器接管。两项余下脚本单独通过，日志 `/tmp/cmb-im-journey-final3.log`、`/tmp/cmb-im-clean-cut-final2.log`。共享技能初版的完整 `npm test` 随后全部通过（退出码 0）：Vitest 566 文件通过、6 跳过，4395 项通过、65 跳过；后续所有集成组通过。日志 `/tmp/cmb-production-library-full.log`。之后补充容量与撤回内容回收，7 项专项和最新 React 旅程通过；正在新增的插件目录同步、解析进程提取不属于这次全仓结果。

### 长期记忆自动整理与人工纠错（2026-10-01）

- 实际移植 Grok 原版记忆整理/独立核验提示、结构化输出解析、证据约束及文本归一化函数，来源摘要记入 PROVENANCE；模型请求复用 Cmb 已配置模型及共用模型工厂，不引入固定供应商或额外模型账号。
- SQLite v15 将成功私聊任务的消息引用加入持久队列；后台独立完成“提出变更—另一次模型核验—事务提交”。每个 Bot 独立处理，群聊、委派结果和示范学习不作为私聊记忆证据。每批最多 12 组证据、每条 500 字、最多 64 条变更，有超时、有界重试和输出限制；无工具的记忆模型不能操作系统。
- 保存来源消息/任务 ID、自动/显式标记及版本。人工修订后转为显式记忆，自动整理不能更改；删除/修订建立内容墓碑及消息水位，过期快照、旧排队证据和此前已开始但尚未结束的任务不能重新写回。全部候选变更先验证，再在同一事务内提交，失败不损坏原有记忆。
- 每日时效整理保留原证据；仅由日期推导的改写不得新增事实，原版提示与独立核验要求不能把过期计划推断为已完成。重大决策仍需重查源系统，模型核验不等于外部事实已验证。
- 界面可查看任务来源并定位对话、编辑/删除记忆、关闭自动整理；关闭会撤销正在整理的旧快照，保留既有记忆。修订来源明确标为“原始任务来源”。已检查浅色/深色截图 `output/bot-memory/memory-evidence-light.png`、`memory-dark.png`。
- 备份恢复同步撤销旧证据队列；v14 备份在验证后的临时副本中升级到 v15，原备份保持不变，旧版手动记忆继续按显式记忆保护。
- Bot 相关回归 53 文件通过、4 文件可选实测跳过，353 项通过、45 项跳过。真实模型工厂/本地 SSE 验证提炼和核验使用两个独立无工具请求，配置变化后不提交；独立编译 Host 在 SIGKILL 后继续完成记忆整理且原用户任务未重跑。真实 React 页面编辑/关闭/删除验证通过。日志 `/tmp/cmb-memory-{regression,runtime,process,ui2,build}.log`。
- 此范围为本机个人 Bot 的私聊记忆。跨 Bot 用户共享/项目共享记忆、Team 成员权限及真实外部模型的提炼质量仍未验收，不把这些范围记作完成。

### 文件来源、删除与存储回收（2026-10-01）

- SQLite v14 记录上传、Bot 生成、浏览器下载、项目文件、命令输出、连接器结果的来源；文件列表与预览共用来源标签。旧数据保留可识别的来源，不编造新元数据。
- 文件删除要求对话、内容摘要及 nonce 一致；活动或待核对任务引用所在对话时拒绝删除。删除保留历史引用与收据，同一 ID 不能重新上传复活，其他对话仍在引用的相同内容不会被清理。
- 逻辑删除后清理无引用内容；异步读取结束前重新校验删除状态。清理中断由 Host 启动和定时维护补做；Windows 文件占用错误保留待清理记录。
- 63 项领域/迁移/RPC/IPC 专项通过；编译 Host 强制结束后重启专项通过；真实页面包含来源、确认/取消删除、共用内容保留，完整旅程通过。Node/Web 类型、本轮 ESLint、构建通过。
- Bot 范围回归最终 285 项通过、42 项可选实测跳过；此前分块传输测试在并行负载下超过 5 秒，定位到对百万字节逐元素深比较，改用等价的完整字节比较并关闭文件服务，未增加超时或减少数据。日志 `/tmp/cmb-bot-file-lifecycle-{tests2,process,ui,regression2,final-types,final-lint,build}.log`。

### 数据备份与恢复（2026-10-01）

- 复用 Host 生命周期锁、原生 SQLite 一致性快照和 Cmb 稳定文件句柄，新增独立维护进程；只有后台空闲并退出后才能替换数据，维护期间拒绝新请求，不将旧请求排队到恢复之后。
- 快照覆盖数据库和仍有效的附件/示范引用，包含来源、删除记录、技能与收据；每个文件保存大小和 SHA-256，恢复前逐个校验。项目源文件、浏览器登录及私有模型/凭据配置不属于此快照。
- 恢复前保存当前快照；当前数据已损坏时保留原始数据库/WAL/文件用于排查。恢复安装有持久日志，Host 在打开数据库之前完成中断的安装。原未完成任务停止、例程禁用，浏览器目标与旧执行授权作废。
- 每次恢复产生新的数据代次，前端清除旧缓存、附件/回复/技能引用和重试请求，保留未发送文字；迟到的旧请求不能清掉恢复后新草稿。
- 55 项领域/IPC/桌面门禁/前端状态验证通过，包括 6 个安装中断点、损坏文件、损坏当前数据库、跨目录链接和响应丢失重试。独立真实 React 页面和完整 Bot 界面旅程通过，已检查浅色恢复确认与稳定后的深色截图。
- 编译维护进程→Host 联调通过；独立进程在替换文件后 SIGKILL，编译 Host 启动先补齐恢复，原排队任务未派发、没有模型调用。Bot 范围 315 项通过/44 项可选实测跳过，独立依赖边界 3 项、消息全组、Node/Web 类型、相关 ESLint 与构建通过。日志 `/tmp/cmb-bot-backup-{tests5,ui4,workspace-ui,process,process-kill,regression,boundary,messages,final-types,final-lint,build}.log`。
- 手动快照最多 50 份、单份最多 20 GiB/50,000 文件；损坏原始数据最多保留 5 份，可打开目录另存清理。仅手动快照与恢复前保护，不宣称定时备份、跨机器迁移、浏览器账号/项目源文件备份或 Windows 突然断电实机验收。Windows 使用文件刷盘和恢复日志，没有将目录 fsync 的 POSIX 结果套用为 Windows 断电保证。
- 本轮独占测试负载的全仓 `npm test`：547 文件通过、15 失败、6 跳过；4313 项通过、30 失败、64 跳过，无未捕获错误。Bot 文件均通过，其余失败仍需逐项处理，日志 `/tmp/cmb-bot-backup-full-test.log`。

### 共用输入准备与附件入口（2026-10-01）

- 将 `standard-thread-turn` 的技能激活、提交 Hook、异步有效性检查、改写和上下文合并顺序抽为 `prompt-preparation`；桌面入口仍注入原有真实 Hook 和技能服务，内部 Goal 的目标不被 Hook 改写。新增 9 项行为验证，桌面入口/架构全组通过；源码位置断言随提取调整，没有移除原约束。
- Bot 首次任务与执行中补充采用共用输入准备；只解析数据库已接受的技能身份与版本，注入每个技能前 8,000 字符并明确续读位置。消息正文中的桌面技能路径不会激活文件访问；停用/改版、跨对话和取消会在模型前阻断。Bot 单项 3 项、原技能/补充/边界与桌面准备 17 项、实际 Bot 模型图 58 项通过，11 项可选实测跳过。
- 这一步没有接通桌面命令 Hook、完整文件系统技能来源或 Harness/工作流；不能将共用输入准备函数等同于完整标准执行链。
- 移植 Grok `composer.tsx` 的剪贴板文件识别与拖放判定，沿用嵌套拖放反馈；附件选择、拖放和粘贴共用已有上传、校验、取消与重试。超额明确拒绝，未完成重试不被新粘贴覆盖；普通文字粘贴保持原行为，输入框外文件拖放不导致页面导航。
- 真实 React 全旅程通过；已检查 `composer-file-drop.png` 和 `composer-added-files.png`。上传断线按同一 nonce 重试。自动读位置与手动点击竞争已通过本窗口串行写入和用户意图代次修复：8 项专项及完整界面旅程通过，外部窗口版本冲突仍需刷新，不能静默重放。日志 `/tmp/cmb-bot-files-input-ui3.log`、`/tmp/cmb-bot-read-queue-tests.log`。
- Node/Web 类型、本轮 ESLint、构建、消息和 Hook 全组通过；日志 `/tmp/cmb-bot-input-final-{types,build}.log`、`/tmp/cmb-bot-preparation-{core-tests2,baseline,graph,desktop2,messages,hooks}.log`。最新全仓 `npm test` 停在 Vitest：536 文件通过、24 失败、6 跳过；4269 项通过、44 失败、61 跳过，1 个 legacy-subagent-migration 未捕获错误。旧 Hook EPIPE 未重现。两个 Bot 超时用例单独运行 11 项通过，后续传输比较开销已修复；其他失败仍需处理，不标为全仓通过。日志 `/tmp/cmb-bot-input-full-test.log`、`/tmp/cmb-bot-input-full-failed-owning.log`。

### 执行中补充要求与群聊安全切换（2026-10-01）

- 复用 Cmb `current-run-message-queue` 的 beforeModel/afterModel 路由，增加可注入的持久收件队列；SQLite v13 保存消息与所属任务，图检查点保存已注入 ID，压缩或重启后不会仅凭消息正文判断是否重复。消息接收与 nonce 收据共事务；检查点落盘前中断可按原 ID 重投。
- 私聊和分支可选择补充当前任务或作为新任务排队；消息显示“等待采纳／已采纳”，旧页中的状态也能刷新。附件、引用、显式技能随消息进入上下文。跨 Bot/对话/分支或后台任务不能被指定为当前任务；旧目标已结束时转成新任务。
- 待审批/问题/浏览器接管/协作等待可让出模型循环，未开始的旧动作不会消费旧审批。已发出的外部动作先记录回执再采纳新要求，不能重放。首次插件授权仍需要明确回复，补充消息不能替代权限审批。
- 群聊沿用原轮次替换规则；如果旧轮次已有外部操作开始，保留其执行权用于收取回执，禁止进一步派发。结果已知后结束旧任务，未知结果仍要求核对。明确点击“停止”继续保留中止语义。
- 单项真实模型图验证通过：流中补充、审批期间改口、在途 MCP 提交、群聊新要求与插件初始授权。模型为本地受控 SSE，MCP 为真实 SDK 子进程；未作为外部真实模型效果验收。
- 最新编译 Host SIGKILL/检查点恢复通过，补充要求只注入一次，已保存的记忆未重复；真实 React 全旅程通过，包含两种发送方式和状态反馈，已查看截图 `current-task-instruction-{pending,accepted}.png`。v12 迁移、旧页状态刷新及群聊边界共 28 项通过。日志 `/tmp/cmb-bot-steering-{ui2,process-final,migration-ui-state}.log`、`/tmp/cmb-bot-group-drain-graph2.log`。
- 全仓 `npm test` 本次停在 Vitest：543 文件通过、15 文件失败、6 跳过；4268 项通过、30 失败、61 跳过、1 个未捕获错误。Bot 执行图 58 项通过/11 项可选跳过，群聊 13 项通过。其他模块仍有失败，不能宣称全仓通过；Hook 子进程提前关闭 stdin 的 EPIPE 问题随后修复，包含 500 KB 输入与退出码 0/2 的实际子进程专项 3 项通过，完整 Hook 专项、Node 类型与相关 ESLint 通过。日志 `/tmp/cmb-bot-steering-full-test.log`、`/tmp/cmb-bot-hook-stdin-{tests2,hooks,types,lint}.log`。工作流全组复核通过，日志 `/tmp/cmb-bot-steering-workflow-final.log`；这些专项结果不替代全仓通过。

### 时钟异常和进程重启恢复（2026-10-01）

- Host 使用数据库时间和单调时钟共同校验执行权限。超过 5 秒的时钟偏移、30 秒以上的监督间隔会锁住旧执行权；先在事务内撤销租约、标记未决操作，再中止旧执行器。恢复原时间不会自行恢复旧权限。
- 独立 Host 在取得进程生命周期排他锁后，立即将旧进程遗留的活动任务置为待核对，避免时钟回拨后旧租约长时间挡住恢复。保留排队任务、已完成收据和人工恢复入口。
- 32 项时钟/领域/配置/升级测试、Node/Web 类型、ESLint 和构建通过。编译 Host 实际 SIGKILL 后立即进入待核对，原审批关联及置顶状态仍在，没有重复创建 Bot；任务历史最新版 React 完整旅程通过。日志 `/tmp/cmb-bot-clock-{tests,types2,lint,build,process}.log`、`/tmp/cmb-bot-history-ui-latest.log`。
- 检测阈值使用可控时钟验证；不等于所有短暂休眠都能检测，也不等于已完成 Windows 电源事件实机验收。

### 具体工具授权、任务记录与审批追溯（2026-10-01）

- 发现并修复 Bot 适配缺口：具体 MCP 工具现在进入 Cmb 原 Mods 管理器的策略和 `tool.check`；Bot 原生工具与插件 SDK 的文件读取在实际执行前调用原 `authorizeCurrentModInput`。没有将模型或后台插件调用伪装成用户操作，也没有启用尚未完成的插件命令/面板权限。
- 审批绑定插件改写后的最终参数；重复继续不能替换已经登记的参数。MCP 结果在写入操作记录和生成完整下载文件前执行发布策略，保留提供方 `isError`。真实 QuickJS worker、MCP SDK 子进程和模型图验证 21 项通过，包括具体工具拒绝、原生命令/附件读取拒绝、参数改写、下载内容处理、配置撤销及断线后不重放。日志 `/tmp/cmb-bot-mcp-policy-tests5.log`。Node/Web 类型、相关 ESLint 和构建通过。
- 新增任务记录界面，可从运行状态和本 Bot 消息打开，按持久事件分页查看进展、等待、协作、审批、操作结果和人工核对；不显示模型流式碎片、检查点或其他任务内容。跨对话/分支和外部游标拒绝，操作结果按 8,000 个字符分页，覆盖 Unicode 内容。
- SQLite v12 在开始操作的同一事务保存实际使用的审批 ID。详情展示原审批与已知结果；旧版没有关联的记录明确提示，不依据相似参数猜测。恢复界面增加详情入口，仍须逐项核对全部未知操作才能继续或结束。
- 领域/迁移/Profile/排序/IPC 45 项、真实认证 RPC/无界面依赖边界 14 项通过；Node/Web 类型、修正后的新增界面 ESLint、构建及消息专项通过。Bot 最新回归 38 文件通过、4 跳过，250 项通过、40 个可选实测默认跳过，日志 `/tmp/cmb-bot-run-history-regression.log`。
- 实际 React 完整旅程通过，覆盖失败任务入口、任务事件分页、原审批展示和人工核对结束；`task-run-history.png`、`task-recovery-details.png` 已查看。随后界面读取改为请求身份隔离并补充未确认结果轮询，需保留后续最新验证结果。日志 `/tmp/cmb-bot-run-history-ui.log`。
- 最新编译 Electron Node Host 创建操作后实际 SIGKILL，重启恢复保留同一 Bot、置顶次序、成功收据及准确审批关联，1 项通过、10 项未重复执行，日志 `/tmp/cmb-bot-run-history-process.log`。仍是 macOS 与受控模型夹具，不代表 Windows 或真实模型验收。

### 例程执行历史（2026-10-01）

- 新增实际执行历史，区分计划、事件和手动触发，以及排队、运行、待处理、完成、失败、停止和待核对状态。以触发时间与身份组合分页，历史页不会被新触发挤出或重复；删除例程保留已有执行记录。
- UI 支持状态刷新、前后翻页和定位到对应对话结果，复用原对话导航；时间显示提取自 Grok `run-history.ts`，保留时区/日历边界逻辑。例程限额由 Host 提供，界面显示当前数量。
- 模型只读工具 `list_routine_runs` 使用同一数据源，不启动任务；仅限当前 Bot 主私聊，群聊与分支不能借此读取主线结果。接口验证 Bot/例程归属和分页游标，不返回检查点等内部执行数据。
- 领域/模型工具/协议/IPC 4 文件 41 项通过，Node/Web 类型与相关文件 ESLint 通过。真实 React 完整旅程通过，覆盖 23 条记录分页、状态变化、失败摘要及结果定位；`routine-history.png` 已查看。日志 `/tmp/cmb-bot-history-regression2.log`、`/tmp/cmb-bot-history-types3.log`、`/tmp/cmb-bot-history-ui2.log`。
- 编译 Electron Node Host 手动执行真实图、删除例程、停止并重启后保留相同历史和消息，1 项通过、10 项未重复执行，日志 `/tmp/cmb-bot-history-process.log`。此前 Bot 全范围回归 38 文件通过、4 跳过，242 项通过、40 个可选实测默认跳过，日志 `/tmp/cmb-bot-profile-full-regression.log`；不是全仓测试结果。

### Bot 管理工具与置顶排序（2026-10-01）

- 从原 Grok `sand-agent-management-tools.ts` 提取创建/修改 Profile 的参数与空值保留规则，接入实际 Cmb 图中的 `create_bot`、`read_bot`、`update_bot`。创建需确认名称、职责和继承的模型/项目/连接器范围；不复制私有历史、记忆、凭据、例程或插件授权，不自动发起子任务。例程、事件及其委派后代不可创建 Bot 或修改职责。
- 本地修改、批准消耗和执行收据在同一 SQLite 事务提交；重复工具调用核对原参数并返回原收据，失败事务整体回滚，不错误地登记成外部操作结果未知。修改核对 Profile 版本；当前 Bot 可持有效租约修改自身名称/职责，从后续轮次生效，不能借此修改能力范围或覆盖其他正在运行的 Bot。
- Host 统一限制创建和复制数量，当前默认 50 个（本地产品配置，不对应 Grok 订阅权益）；隐藏 Bot 仍计数，删除释放名额，已提交请求在达到上限后仍可查回原收据。界面显示 Host 提供的限额并禁用超限创建。
- 直接复用 Grok `sidebar-model.ts` 的置顶分组与 before/after 移动算法；SQLite v11 保存列表与版本，升级先备份。支持拖放指示线及 Ctrl/Command+Shift+方向键移动，保留隐藏成员的位置；跨窗口失效操作明确拒绝，丢失响应后的相同 nonce 不再次移动。
- 回归实际发现主对话历史缓存的分支回复数可能滞后：分支中已更新全局 cursor 后，返回主线仍需刷新已加载消息的分支摘要。已修正选择代次校验，并保留原分页位置、草稿和消息身份；针对该时序的回归通过。
- Profile/存储/无界面边界 29 项通过；排序/迁移/协议/IPC/分支状态等 6 文件 53 项通过；新增 RPC 与模型图批准/拒绝/后台工具过滤 4 项通过。Node/Web 类型、构建、消息专项及相关文件 ESLint 通过。日志 `/tmp/cmb-bot-profile-*`、`/tmp/cmb-bot-pinned-*`。
- 实际 React 完整旅程通过并完成进程清理：创建审批、数量上限、键盘和拖动排序、分支返回均验证；`bot-profile-approval.png`、`pinned-order.png` 已查看。日志 `/tmp/cmb-bot-profile-ui4.log`。此前两次后段测试分别因夹具停用 Host 未恢复、结果文本同时匹配侧栏和正文而失败，修正夹具及选择器后通过。
- 最新编译 Electron Node Host 在创建已提交后 SIGKILL，重启保留同一 Bot、原成功收据与置顶次序；人工恢复图后无重复创建。此专项 1 项通过、10 项未重复执行，日志 `/tmp/cmb-bot-pinned-process.log`。仍为 macOS 与受控 SSE 模型，不能代替 Windows 或外部真实模型验收。


### 本轮补齐：浏览器接管的客户端归属（2026-10-01）

- 在既有 Browser Broker 的目标身份、串行队列和控制代次上补齐连接身份。每条受认证 RPC 连接获得仅存在 Host 内的控制身份；截图只返回“当前端/其他端”和连接状态，不携带可复制的操作凭据。旁观者不能输入、归还控制权或暂停/保存/丢弃别人的示范；显式转移绑定当前目标代次，旧端排队操作在执行前拒绝。
- 旁观者刷新不会使操作者的截图凭证失效；控制状态查询与截图查询分离，人工操作时仅轮询控制状态，避免重复截屏和频繁禁用输入。界面提供明确的转移确认，断线显示 Bot 保持暂停；状态不确定时刷新实际画面，不自动重发点击。
- 人工持有状态随原浏览器 Session 持久保存。客户端断开、浏览器重建及 Host 重启后仍需明确接管或归还，不自动恢复 Bot 输入。示范在控制端断开或转移时暂停，重新接管后由人继续；下载收集也复核发起端及控制代次。
- 真实 Chromium + 两条认证 Socket 的归属/转移/重连/录制测试 3 项通过；浏览器原动作与下载 12 项、RPC 10 项、IPC 22 项及示范模型图 3 项回归通过。组合运行另有示范文件服务 2 项触发原 5 秒超时，未提高超时阈值；该文件单独重跑 3 项通过。日志 `/tmp/cmb-bot-owner-regression2.log`、`/tmp/cmb-bot-owner-service3.log`，保留组合失败记录。
- 实际 React 完整旅程通过，新增旁观只读、取消转移、断线提示和确认转移；`computer-control-transfer.png` 已检查。测试曾直接读取操作者截图而使页面凭证过期，改为只读控制状态后验证通过，未放松产品校验。日志 `/tmp/cmb-bot-owner-ui3.log`。
- 最新编译 Electron Node Host 的持久接管与重启验证 1 项通过（其余 9 项本次未重跑），日志 `/tmp/cmb-bot-owner-process.log`。Node/Web 类型、构建、消息专项及本轮文件 ESLint 通过，日志前缀 `/tmp/cmb-bot-owner-`。验证平台仍为 macOS，Windows 实机及通用桌面多屏仍未验收。

### 接管期间任务等待与归还后的重新观察（2026-10-01）

- 使用原持久任务的 `waiting_input`、租约和执行代次保存浏览器等待，不新增第二套任务队列。等待时释放 Host 执行名额、保留单 Bot 串行约束；取消和过期租约不能恢复运行，也不能用归还浏览器绕过待回答的问题或审批。
- 浏览器、下载和安全填充工具在人工持有期间等待。归还后仅允许重新截图/快照直接执行，其余旧调用返回“未执行，请重新观察”，不重放旧页面元素。浏览器动作及下载的审批提交前复核目标；审批期间发生过接管或目标重建，原批准不启动外部效果。已经开始、结果不明的操作仍按原效果收据要求核对。
- 原图执行链新增 4 项真实浏览器验证通过：等待后继续、等待中取消、浏览器审批失效、下载审批失效；确认旧动作没有生成执行收据、下载或额外审批。领域存储 22 项通过。真实 React 全旅程通过，包含侧边栏等待状态、停止入口、归还后任务继续；截图 `computer-task-waiting.png` 已查看。
- Node/Web 类型、本轮文件 ESLint、构建及完整工作流专项通过；最新编译 Host 的实际模型图/分支/重启专项 1 项通过（其余 9 项本次未重跑）。日志 `/tmp/cmb-bot-computer-wait-{graph2,store,ui2,types2,lint,build,workflow,process}.log`。模型仍为本地受控 SSE 夹具，Windows 与外部真实模型尚未验收。

| 部分 | 当前实现 | 验证边界 |
| --- | --- | --- |
| Bot 工作区 | 创建和编辑职责/模型/头像、复制、隐藏/置顶/删除、已读/未读与定位、私聊、协作群聊、附件、文件结果、记忆、技能、例程管理 | 实际 React 页面连接真实域 API；模型由测试夹具提供 |
| 常驻 Host | 独立 Electron Node 进程、本机认证 RPC、IPC 主窗口校验、串行原子配置同步、断线重连、进程生命周期 SQLite 排他锁、原子发布描述文件 | Mac 已验证无客户端时继续执行、并发启动唯一 Host、残缺启动描述文件恢复及重启读取历史；Windows 尚未验证 |
| 持久任务 | SQLite WAL、请求去重、每 Bot 串行、多 Bot 调度、租约和执行代次、取消、审批、问题等待、未知外部操作核对 | 已有域测试；真实 SIGKILL 后独占 Host 启动即标记中断、人工核对、从图检查点恢复已通过，已提交的记忆不重复保存；外部写入中断还需逐项验证 |
| Bot 协作 | 持久直接消息、接收方唤醒、结果回送和等待；移植 Grok 群聊回应者选择、轮流发言、pass 与轮次上限，新增 SQLite 轮次/游标/发送收据 | 群聊改口、停止/编辑使旧轮次失效；最多 3 轮、10 条公开发言、每人每轮 2 条；重启不重复发言，未知效果等待核对。私下协作结果由成员明确发到群聊；真实图与页面测试通过 |
| 模型执行 | 实际 Cmb `assembleDeepAgent` 抽为共用图执行器；复用任务收尾、待办、动作重复保护、工具并发、错误恢复、模型与压缩；Bot 专用持久检查点 | 已验证实际模型适配器、SSE 增量显示、流中停止及本地模拟服务；未宣称外部真实模型效果已验证 |
| Bot 浏览器 | 共用专用登录环境、每 Bot 独立页面、Grok 浏览器工具、截图、人工接管、标签页管理、过期画面拒绝、页面清单恢复及浏览器关闭后重新创建 | 安装的 Mac Chrome 实测；不是 Windows 通用桌面多屏的替代验收 |
| 文件 | 上传资料、消息附件、分页文本/文档/图片读取、不可变成果下载、内容哈希及对话范围校验 | 普通文件 25 MiB、视频 200 MiB，分块上传/恢复/哈希下载；PDF/Office 文档分页、图片限额/区域读取、带登录的直链及 POST/blob/子框架导出、项目成果交付已接入。新增对话预览、普通点击/人工操作/弹窗下载；扫描 PDF OCR 及完整 Office 排版仍待补 |
| 项目文件 | 复用 Cmb 稳定文件句柄与编辑匹配；限定项目根目录、分页读取、精确差异审批、哈希校验、同目录并发串行、修改前文件与完整补丁留存 | 实际文件读写和模型—审批—写入链已测试；与 Shell 共用项目修改锁 |
| 项目命令 | 原 Cmb LocalSandbox 抽为桌面和无界面 worker 共用的执行器；具体命令/目录/超时/沙箱模式审批，持久收据、取消、输出成果、进程树清理；禁止不确定自动重试及静默降低 Windows 沙箱模式 | Mac 实际执行、拒绝审批、配置变化、超时、取消、Host 断开及 SIGKILL 后不重复执行已通过；Windows 沙箱/进程树未实机验收；命令经过现有具体动作审核与收据边界，工作流子任务已接入，共用任务准备合同已逐项核对；平台与效果验收见最新记录 |
| 后台配置更新 | 订阅既有模型/账号/连接器/插件/沙箱设置变化，串行同步私有快照，失败退避重试；不依赖 Bot 页面打开；同步代次标记阻断旧配置，新任务留在队列，完成当前代次后恢复派发 | 事件合并、写入期间变化、失败恢复、未使用 Bot 不复制凭据、旧代次不得清除新标记、任务不丢失等测试通过；沿用 Cmb 稳定文件句柄防止读取期间快照替换；不撤销已发生的外部效果 |
| MCP 连接器 | 原 Cmb 能力服务抽为桌面/Bot 共用模块，复用配置、发现、别名、Schema、搜索、结果解析；每 Bot 显式选择，凭据保留在私有配置，调用绑定审批和持久收据 | 真实 SDK stdio 子进程联调通过；包含配置变化和执行后断线，外部真实服务/OAuth/Windows 尚未验收；Mods 接入范围见下一行 |
| 工作插件（Mods） | 复用原 Mods / Function Mods 管理器、QuickJS、显式命令、SDK 文件/命令/MCP、持久 Pane/Client 与策略发布；每 Bot 独立授权，源代码变化重新授权，配置撤销中止执行 | 真实执行图、原插件回归、面板 UI 与编译 Host 恢复已有专项证据；Notification Hook 已接入。共用任务准备合同已逐项核对；跨平台实机验收仍未完成，见最新实施记录 |
| 结构化问题与表单 | 复用 Cmb 问题 Schema 和 UserInputRequestDialog，增加内联 Bot 展示与多选；单选/多选/文字/补充说明、逐题导航、显式提交/取消、服务端必填与选项校验、答案持久回显 | 实际模型图、SQLite 状态和 React UI 通过；旧问题不能回答新任务，重复提交不重复写消息，取消不默认选择或授权；敏感值使用独立安全输入卡片 |
| 消息表情回应 | 移植 Grok 分组/计数和六个快捷表情，支持单个 Unicode 表情输入、取消回应、多个 Bot 身份及模型工具 | SQLite v7 迁移与重启、真实模型图、React 页面及 220 条旧历史跨客户端刷新验证通过；显式 active+版本校验抵抗重试，回应不批准操作或触发任务 |
| 安全输入与网站凭据 | Grok 安全输入卡片及确认辅助函数、Windows DPAPI 和 macOS safeStorage 适配；专用 IPC 直达已绑定 DOM 密码框；每 Bot 凭据名称/说明/网站目录、添加/替换/删除、按网站及版本审批使用 | 原 Chrome/模型图/UI/Host 联调通过；不进入模型、消息、事件或操作收据，替换/撤销阻断旧授权。macOS 系统加密适配正在验收（见本页最新记录），真实钥匙串及 Windows DPAPI 实机未验证；Linux KMS 为可注入接口 |
| 浏览器示范学习 | 原生 Chromium WebM 录制、暂停/继续/丢弃/保存，关键帧和人工操作记录，学习任务读取实际图片，结构化保存技能；学习任务与录制记录在同一事务绑定；新增历史分页、校验后回看/导出、显式删除及 2 GB/500 条存储上限 | Mac Chrome 录制、视频解码、实际页面回看/导出/删除已通过；5fps、最多 10 分钟、仅浏览器、无音频；敏感输入检测不是任意秘密识别保证。删除保留技能和任务收据；真实模型泛化能力仍未验收 |
| 技能命令入口 | 输入 `/` 搜索可用技能，保留 Bot/技能 ID 和明确版本；Grok 模糊搜索、去重和键盘选择逻辑，Cmb 输入框/草稿适配 | 当前对话与接收者范围校验、禁用/改版拦截、重试去重、模型实际读取技能、React 搜索选择与提交均已验证；只传目录元数据，技能不额外授予权限 |
| 技能试跑与修订 | 固定技能版本/输入/验收条件创建真实任务，结果由用户判定，保留历史并发布新版本，新版本不继承验证状态 | 域和页面验证通过；通过记录只代表那次试跑，不代表所有输入均已验证 |
| 例程 | 单次、间隔、时区 cron、手动运行、事件主题、去重和错过时间合并 | 日历/DST/去重测试；外部系统事件适配尚未接入 |
| UI 样式与动画 | 实际移植 Grok 头像几何、身份映射、状态动效；移植形状/色板选择和拖拽控制；调整气泡、输入框、工具栏和电脑面板；动态尊重减少动画设置，暂停不可见头像；历史分页保留阅读位置 | 真实浏览器验证深浅色、640px 窗口、动效开关、头像保存、面板拖拽/键盘调整/展开、220 条历史分页及刷新节点稳定性；不等于全部官方 UI 已复刻 |

## 代码来源

- Grok 0.18 用户提供重建代码：浏览器操作、用户队列优先级、cron 计算、草稿解析、侧栏状态、头像与动效、形状/色板目录和侧栏拖拽控制。分别记录在 `src/main/bots/upstream/PROVENANCE.json` 和 `src/renderer/src/components/bots/upstream/PROVENANCE.json`。
- Rakazo 固定参考版本：Bot 目录和消息唤醒提示、人工操作坐标映射、技能试跑提示模板，已保留 Apache 2.0 许可文本和原几何测试。
- Cmb 原有能力：模型、重试与压缩、共用 LocalSandbox 命令执行器及 Windows 状态模块、共用 MCP 能力服务/配置/搜索/结果处理、原 Mods 与 Function Mods 管理器及 QuickJS 执行器、编辑匹配、稳定文件句柄，以及 Markdown、主题和 UI 基础组件。
- 本次新增：Bot 领域模型、持久调度/审批/恢复、Host 和协议接线、浏览器隔离与接管、产品工作区及上述能力的适配。

用户提供的 Grok 重建仓库未确认源码再分发许可；当前记录本地代码使用来源，不据此推断生产分发权利。

## 仍需完成，不能按“已交付”计算

1. **Cmb 执行合同与额外能力。** 源码审计已逐项对应输入准备、技能/Hook、项目规则/Harness、模型与工具范围、共用执行图、完成检查及持久生命周期，共 13 项合同；Bot 调用抽取的共用内核，通过自己的租约、审批和检查点适配，不是另写简化执行器。原自动模型分级路由、前台 Coordinator/Goal 界面及完整 TraceCollector/采用率遥测属于额外 Cmb 范围，当前未移植，不列为已实现。源审计未确认新的可复现缺陷，不代替真实模型、平台及外部效果验收。固定来源和对应关系见 `/tmp/cmb-standard-preparation-chain-audit/REPORT.md`。
2. **Teach 完整闭环。** 浏览器录制、读取真实关键帧、结构化技能保存、试跑/人工验收/修订、历史/回看/导出/删除已接线。通用桌面录制、真实模型异输入任务验收仍缺；不能把模拟模型返回技能当作已证明学习效果。
3. **Windows 通用桌面并行。** 不共享系统鼠标的通用应用独立屏幕仍缺可行性实测，G2B 未通过；不会把浏览器页面隔离标成桌面隔离。
4. **长期运行与恢复。** 已具备进程排他锁、启动/升级重连、v41 数据迁移、升级前 SQLite 备份、日志轮转、手动/定时快照、浏览器状态及共享文件恢复。完整通用桌面环境备份、全量运行数据保留策略、外部效果中断与恢复仍需补齐生产验收；多客户端接管已实现，Windows 实机验收仍缺。
5. **其余核心体验。** 流式显示、历史分页、事件/审批详情、富输入和分支导航已有实现及专项证据；macOS 冷启动链接分派已在文首原生包验收，Windows 协议唤起、群聊编排的全部对照、跨进程下载恢复和其余条目继续按 `core-scope.json` 逐项验收，不重复将已接通的局部功能列为未编码。
6. **平台与效果。** Windows 原生打包运行、签名升级、Linux 适配、真实模型及固定原版任务对照尚未完成；目前没有“超过 Grok”的证据。

## 已运行验证

本轮日志前缀为 `/tmp/cmb-bot-reuse-*`；后续代码变更需按关联风险重新验证，不能沿用旧结果冒充新版本通过。

- `npm run typecheck` 与 `npm run build`：MCP 接入、表单、v4 迁移以及示范事务/操作结果修复后的版本均通过。
- Bot/MCP/IPC/历史/主题/坐标定向 Vitest：109 项通过，12 项浏览器/进程测试默认跳过并单独显式执行。
- 实际 MCP 子进程集成：模型→工具 Schema→审批→执行→持久收据；审批期间配置变化不发送操作、不生成未知效果；执行后断线只发生一次外部写入，并留下待核对记录。模型为受控本地 SSE 服务。
- Mac Chrome：6 项浏览器和 3 项 Teach 测试已通过，包括实际 WebM 解码和关键帧经 Cmb 模型适配器发送。新增的人工操作结果标记也已通过；失败/结果未确认的输入不会被记录为已完成。
- 编译产物进程：3 项通过，覆盖界面离线后执行、唯一 Host、SIGKILL 后租约回收与图恢复；MCP 抽取后的最新构建产物已重验通过。
- 实际 React 页面：创建/发送/附件/成果、头像动画、深浅主题和减少动画、接管与标签页、面板尺寸、220 条历史分页、Teach 控件、技能试跑/验收/修订，以及新增连接器选择与固定表单按钮均已通过；截图在忽略目录 `output/bot-workspace/`。
- 迁移专项：包括旧 v3 Bot 默认无连接器授权、升级前 WAL 完整备份、未知未来版本拒绝修改。
- `npm run test:messages`：通过。原 Mods 专项首次 527 通过、15 失败、1 跳过。将失败涉及的 6 个文件在未修改 HEAD 的临时快照和当前树分别以单 worker 运行，两侧均为 83 通过、相同 12 项失败；另 3 项没有在单独复跑中重现。日志 `/tmp/cmb-bot-mcp-baseline.log` 与 `/tmp/cmb-bot-mcp-current-comparison.log`。这不是全量测试通过。
- `npm run test:workflow`：在 `sandbox-elevated.unit.spec.mjs` 的 3 个源码结构断言失败；已将 HEAD 中的测试及其读取文件单独提取到临时目录复跑，复现相同基线问题。失败涉及 `ensureCodexExe` 定义位置及两处通知调用结构。
- `npm test` 全量 Vitest 首次执行：33 文件失败、478 通过、4 跳过，62 用例失败、3948 通过、25 跳过。发现本次新增 BotComputer 的固定背景类违反主题策略，已修复并复跑该策略 16 项通过。Chrome cookie bridge 的 3 项失败已用短 `TMPDIR=/tmp` 复跑通过（默认 Mac Unix socket 路径过长）。其余全量失败尚未逐项验证基线；不能写成全部无关或全绿。

此记录用于保持实施与方案一致；它不是完成证明，也不替代逐项需求验收。

### 2026-09-30 后续验证

- Shell 共用内核抽取后：类型检查、构建通过；原 Shell/项目文件/配置相关 30 项回归通过，Bot 实际执行器 14 项通过，真实 Shell worker 6 项分别在源码和 Electron Node 编译产物下通过。日志 `/tmp/cmb-bot-shell-*`。
- 编译产物 Host 原 3 项通过；新增实际 Shell 执行期间 SIGKILL 测试通过：子进程停止、重启任务进入待核对、命令只执行一次。
- `test:workflow` 仍停在已在原 HEAD 复现的 3 项源码结构断言。全量 Vitest 本次 505 文件通过、18 失败、5 跳过；4021 用例通过、41 失败、32 跳过。其中新增的旧路径源码断言已修改为读取共用内核并通过 11 项专项复跑；其余失败名称均见于前次运行，但尚未全部单独复现基线，不能称全绿。
- Teach 历史/视频服务与前端校验 15 项通过；真实 Chrome Teach 3 项重验通过；React 页面视频加载/导出/删除及原页面旅程通过。修复了 tsx 转换在浏览器回调中注入辅助函数导致检测误报暂停的问题，保留敏感区域暂停策略。
- 配置订阅、并发快照同步与 IPC 校验 7 项通过；上述版本 `npm run typecheck` 通过。日志 `/tmp/cmb-bot-configuration-*` 和 `/tmp/cmb-bot-teach-history-*`。
- 配置代次保护接入后：Bot 实际执行链 14 项通过；配置/协议/依赖边界/原模型注册等 38 项通过，原存储 8 项通过；类型检查和构建通过。最新编译 Host 4 项全部通过，包含两类 SIGKILL 恢复，日志 `/tmp/cmb-bot-configuration-host.log`。
- 新增 Bot 范围 ESLint 检查仍有 49 项错误和 138 项警告（包含测试的显式 any、React effect/模块导出及格式项），尚未清零。不能将类型检查与构建通过表述为完整质量门禁通过。日志 `/tmp/cmb-bot-lint-current.log`。


### 共用图执行链（继续开发）

- 实际 Cmb 图组装与工具并发代码已移动为共用内核，桌面保持原服务注入；Bot 接入收尾检查、待办、重复动作保护、错误恢复、压缩与自己的持久执行边界。
- 收尾重试预算和终态判定随图检查点保存；重新创建执行器和已结束图恢复都保留未完成判定。待办状态声明的真实图缺口已修复。
- 图/收尾/Bot 模型执行 83 项通过；原最终提示词和角色工具矩阵通过，注册表/协调模式专项通过。编译 Host 4 项通过，包括两类实际 SIGKILL 恢复。依赖图没有 Electron、桌面 IPC、桌面数据库或 Mods 管理器。
- 全量 Vitest：507 文件通过、21 失败、5 跳过；4,041 用例通过、44 失败、33 跳过，另有 2 个未处理错误。此次同时运行较重回归，部分新增失败涉及性能超时；不能据此判为通过或全部无关。`test:workflow` 仍停在原先已复现的源码结构断言。消息队列独立源码断言另发现既有调用计数不符，待处理。
- 后续补入项目 AGENTS 上下文、致命错误后的批次停止；相关最新定向日志为 `/tmp/cmb-shared-graph-final-targeted.log`，类型检查为 `/tmp/cmb-shared-graph-types7.log`。这些变更仍需按最新结果记账，不能把早期通过当作全部验收。


### 群聊编排与管理（继续开发）

- 直接移植 Grok `group-chat.ts` 纯逻辑；按其原编排器规则实现持久化：回应者选择、@ 单人/多人/everyone、轮流发言、pass、轮次/消息上限。
- 新群消息、群资料变更和停止使旧 epoch 失效，并取消旧轮次仍在执行/排队的委派任务；不撤销已经发生的外部效果。不确定任务保留核对入口，旧 epoch 不得继续。
- 只有 `send_group_message` 的文本公开到群聊；模型临时输出与私下委派返回不自动广播。发送和去重收据在同一事务提交，重启后不重复公开。
- 新增群聊描述与成员编辑，同步共享契约、RPC、主进程 IPC、preload 和真实 UI；v4→v5 迁移前备份并保留已有群聊。
- 最新 68 项定向测试、Node/Web 类型检查通过；真实 React 页面创建群聊、收发、编辑成员/描述及原页面旅程通过，截图 `output/bot-workspace/group-conversation.png`、`group-settings.png` 已检查。日志 `/tmp/cmb-bot-groups-*`。
- 群聊 UI 和执行验证使用确定性模型夹具；不据此宣称真实模型协作质量或 Windows 环境已通过。


### 文档、下载及成果交付（继续开发）

- 复用 Cmb `file-parser.ts` 的 mammoth、SheetJS、编码识别与 Office 压缩包限额；新增分页参数，不改变旧附件默认截断行为。Word/Excel 可读取 24K 字符以后的内容。
- PDF 使用 Mozilla PDF.js 6.3.289；PPTX 使用已有 ZIP 能力和直接声明的 xmldom 依赖，按演示文稿关系顺序提取文本。PDF 保留页码，无文本页明确报告，不伪称 OCR。解析仅接收已校验的文件字节，不接收任意路径，禁止 PPTX 外部关系及 XML 实体。
- Bot 解析在一次性子进程中执行，复用原解析实现；5 MB 输入、32K 单次输出、15 秒、256 MB V8 堆及 4 个并发限额。超时/取消终止子进程，当前会话和租约在解析前后校验。此处是 V8 堆限制，不是整个原生进程 RSS 的硬上限。
- 新增 `download_file`：同一浏览器登录、每次独立临时页、精确下载 GUID、Chromium 进度大小检查、稳定句柄读取和发布前字节上限校验；接管或失去租约时取消。直链下载不改变 Bot 当前画面。仍需继续覆盖 POST 导出、普通点击/人工操作下载和异常退出后的临时文件保留策略，不能据此将全部下载要求勾选完成。
- `project_publish` 复用项目路径边界和稳定文件句柄；可交付真实二进制成果，审批绑定 SHA-256，审批期间变化则拒绝发布。新增对应下载/交付审批卡片。
- 实际文档解析 14 项通过；模型图与项目文件 29 项通过；Mac Chrome 8 项通过。编译后的 `bot-document.js` 在 Electron Node 模式运行 5 项通过，包含 PDF、Word、Excel、PowerPoint、异常文件和解析取消。日志 `/tmp/cmb-bot-doc-*`、`/tmp/cmb-bot-file-export-tests2.log`、`/tmp/cmb-bot-download-browser2.log`。
- PDF.js 使用原包 ESM worker、字体和 CMap，未把原生依赖硬塞入 CJS bundle。需要 Node >=22.13；当前 Electron 39 实际运行验证通过，未来 Linux Host 也须使用满足此要求的运行时，未修改整个仓库 engine 范围。

### 后台构建版本切换（继续开发）

- 所有后台入口共享构建内容标识，状态及本机描述文件带上 buildId；桌面识别旧后台。
- 新增仅限已认证本机传输的空闲重启请求，没有暴露为 renderer IPC。校验 Host 身份、执行中任务、示范、人工接管及其他进行中的 RPC；接受后同步停止新任务认领，回复写出后退出，客户端丢失也有退出兜底。
- 正在执行的任务继续运行，桌面仍允许查看、回复审批/问题和停止；新任务等待版本一致。队列保留在 SQLite，新后台接续；旧版不具备协议时不根据 PID 强杀。
- 生命周期/协议/锁 11 项通过；实际编译 Host 5 项通过，包含界面离线运行、唯一 Host、两类 SIGKILL 恢复及升级 ACK 后真实退出、重连、历史保留。日志 `/tmp/cmb-bot-upgrade-*`。
- 这不是完整安装包升级/回滚系统；Windows 签名安装、旧安装目录替换、完整备份恢复及多客户端升级竞争仍需验收。


### 存储类型、复制与阅读位置（继续开发）

- SQLite 领域投影、Teach 存储和图检查点读取改为 `unknown` 边界和明确 Schema 校验；移除 Bot 生产范围及其测试中的显式 `any`，头像几何/身份函数与 React 动画组件分开，修复 effect 依赖。当前限定范围 ESLint 为 **0 错误、0 警告**，不等于整个仓库 lint 已通过。日志 `/tmp/cmb-bot-registry-lint.json`。
- 依据原 Grok `agent-clone.ts` / `agent-lifecycle.ts` / `agent-db.ts`，复用现有 Bot 插入、技能及日历实现：事务内创建新身份，复制配置、启用技能和例程；副本可见且不置顶，不复制历史/记忆/附件/浏览器页面/运行中任务。模型和连接器仅复用配置引用，不复制凭据；技能不继承原试跑验证标记。
- 复制保留例程启用状态及配置，分配新触发身份；根据复制时间计算下次时间，不重放源 Bot 的逾期触发。事件主题沿用同一用户既有配置。原版 0.57.1 的首个触发时点和外部订阅克隆仍未完成对照；BOT-10 不标记已验收。
- v6 新增读取位置表。手动未读独立保留；可见消息水位单调前进，版本条件阻止迟到请求抹掉人工标记。旧记录迁移前备份，进入会话从首条未读开始，超过一页向后继续加载；后台轮询不跳过中间历史，不把未显示的新消息一并清为已读。
- 复制/版本冲突/事务失败回滚/未读竞态/重启/历史分页/IPC 与迁移相关 41 项通过；增加真实 RPC 后对应 3 个文件 15 项通过。类型检查和构建通过。日志 `/tmp/cmb-bot-registry-tests2.log`、`/tmp/cmb-bot-registry-final-tests.log`、`/tmp/cmb-bot-registry-types.log`、`/tmp/cmb-bot-registry-build.log`。
- 页面新增 257 条未读历史的连续分页、人工未读跨轮询保持、复制配置与例程，使用真实 React、域 API 和 SQLite；截图 `unread-boundary.png`、`copied-bot.png` 已检查。完整页面及清理通过日志 `/tmp/cmb-bot-registry-ui-updater.log`；模型依然为受控夹具。
- 退出排查：实际发现 Broker 等待页面操作结束后才断开传输可能无限等待，已改为先关闭传输；真实 Chrome 的永不返回页面脚本用例及其余浏览器用例共 9 项通过。另定位 UI 测试浏览器的更新器持有进程管道，补入 Playwright 上游已有 `--disable-updater-scheduler` 参数；两浏览器均真实 exitCode=0 后才打印 PASS，不靠超时强退宣称通过。源码依据 https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts 。


### 原有工作插件接入（继续开发）

- 直接抽取 Cmb 原管理器、策略、RPC 客户端、模型中间件和 Function Mods 运行器，共用原 QuickJS 隔离执行器；桌面仍用 utilityProcess，Bot 用受限环境及有界 IPC 的独立 Node worker。不是在 Bot 内另写一套插件引擎。
- 插件首次使用及代码摘要变化均需授权。授权按 Bot 隔离持久保存；配置撤销会中止等待授权、嵌套调用和当前任务。模型凭据只在 Host；插件内模型调用沿用用户配置及原 Cmb 模型适配器。
- Bot 工具不使用桌面的后端 Mods 包装器，因此在入口完整执行原工具检查；必需部署策略也覆盖未选可选插件的 Bot。新增禁止 execute 在审批/进程启动前被拒绝，以及允许会话附件读取的真实模型链回归。
- 复用回归中修复了原 Promise thenable 作用域传递，以及 macOS 路径别名导致的隔离工作区 .git 文件检查问题。应用内置 SDK 启动脚本时间预算单独调整；第三方插件脚本仍保留原执行限额。
- 原 Mods / Function Mods 专项：72 文件、547 项通过、1 跳过；Bot 执行/配置/无界面依赖边界专项：32 项通过、1 个需真实浏览器的测试跳过。Node/Web 类型及构建通过。日志 `/tmp/cmb-bot-mods-suite-final.log`、`/tmp/cmb-bot-mods-final-runtime-tests.log`、`/tmp/cmb-bot-mods-policy-types.log`、`/tmp/cmb-bot-mods-policy-build.log`。
- 全仓 Vitest 本轮为 509 文件通过、24 失败、5 跳过；4088 项通过、44 失败、38 跳过，另有 6 个未处理错误。其后 Bot 执行、Shell 进程、工作流存储单独重跑 80 项通过、1 跳过；不代表所有全仓失败均已解决。`test:workflow` 首轮被存储性能超时中断，尚未完成整条命令。
- Mods 完整命令/面板 UI、部分 SDK 路由和标准任务生命周期仍未完成；不将上述通过当作完整生产验收。


### 文件传输、页面导出与受控预览（继续开发）

- 原先 5 MiB 的整个 Base64 消息改为 512 KiB 分块传输；普通文件 25 MiB、视频 200 MiB。每个分块完成写入并同步磁盘后确认，重连沿用上传身份和服务端偏移；重复分块必须与已写内容一致。只有最终长度与 SHA-256 均匹配才发布附件。后台 SIGKILL 后续传已经过编译 Host 实测；未完成文件不会出现在可发送附件里。
- 上传支持进度、取消和显式重试；下载逐块读取并验证完整哈希后再提供 Blob，支持取消。视频支持传输和保存，不据此宣称模型能够理解视频。暂存区有限额、过期清理与关闭时等待写入。
- `download_file(ref)` 使用原页面和 Grok 的元素点击实现，覆盖带 cookie/CSRF 的 POST 导出、前端 blob 和子框架下载；每次捕获绑定精确页面/frame/GUID，并保留当前页面。并行 Bot 的文件不会串线。取消/超限/控制权变化中止捕获，临时文件清理仅作用于功能专用目录。普通点击、人工接管和新弹窗自动收集仍未完成，不将导出工具等同于全部浏览器下载体验。
- 大图保留不可变原文件；模型视图在现有一次性文档进程中检查像素数、解码、缩放或裁剪，单图输出最多 1 MiB、最长边 2048、原图最多 4000 万像素。支持 PNG/JPEG/WebP/GIF 单帧和原始坐标区域读取。原生解码库 `@napi-rs/canvas` 直接声明并配置解包，`image-size` 在原生解码前检查头部；没有扩大主进程原生解析面。
- 直接复用 Grok 的文件类型/扩展名识别模块，以及 Cmb 的 CodeViewer、MarkdownPreview、HtmlPreview、ImageViewer、PDFViewer、MediaViewer。消息附件与文件列表可直接预览；文本、Office 正文按页读取和复制；HTML 完整小文件用原隔离容器，长文件明确分页显示原文。PDF/音视频完整哈希核验后生成指定类型 Blob；SVG 仅显示源码。关闭预览取消工作进程并撤销 Blob URL，切换文件/页码不显示上一份内容。
- Office 当前为正文预览，完整排版、公式交互及内嵌图像尚未提供；图像为受限静态视图，原图可保存；不支持格式明确提供下载入口。此处仍是 FIL-05 的部分实现，不能按全部格式验收。
- 实测记录：文件传输/解析/IPC 等 43 项通过，浏览器与模型链 40 项通过；当时编译 Host 7 项通过。图片/预览新一轮 8 文件、76 项通过、1 跳过；Node/Web 类型和构建通过。真实 React 页面验证 HTML 无法读写父页面、CSP 拦截外传请求、Word 前后翻页、Markdown 与消息附件入口。分别见 `/tmp/cmb-bot-transfer-*`、`/tmp/cmb-bot-image-*`、`/tmp/cmb-bot-preview-*`。
- 页面验证发现普通文本 9 MiB 超过旧的 8M 解压文本上限；仅普通文本按已批准文件字节限额调整，Office/PDF 展开字符限制保持 8M。实际读取尾页通过；没有以截断结果宣称全文可读。
- 尚未通过 Windows 实机、完整包升级、全量真实模型及全部核心条目的生产验收。上述验证不改变其他未完成项的状态。

## 本轮补齐：安全输入与 Bot 凭据（MSG-14、APR-10/11/12，部分完成）

- 实际复用 Grok 安全输入标题/说明清理及完成确认函数，参考其安全输入卡片和秘密存储的加密/会话降级语义。保存使用 Cmb 原有模型配置的 DPAPI 实现，抽为共用 helper；模型配置行为保持原有语义。来源哈希及改动写入两份 PROVENANCE。
- 一次性输入仅经 `provideSecret` 到 Host 内存，再交给具体浏览器密码框；普通 `answer` 不能绕过专用入口批准。卡片展示实际网站、路径与输入框；不提交表单、不保存输入。页面、DOM 节点、输入框签名、控制权或任务租约变化后拒绝填充。底层错误统一脱敏，不把 Playwright 可能含输入值的调用日志带回模型。未知结果保留收据供核对，不自动重复。
- 保存凭据按 Bot 隔离，目录与 `list_secrets` 只返回名称/用途/网站/版本。添加、替换、删除有版本校验和串行落盘；Windows 使用 CurrentUser DPAPI 加密快照。Mac 或未配置加密 Provider 的环境仅存内存，界面明确说明。Linux K8s 可注入加密 Provider，本轮没有实现 KMS 连接。
- `fill_secret` 只向凭据允许的精确网站填充，审批绑定凭据版本与真实目标；执行前再次检查替换/删除。复制 Bot 不复制凭据；删除后清除其凭据，重启时清理删除中断遗留项。损坏或无法解密的文件拒绝读写，不覆盖为新空库。
- 完成 19 项存储/IPC 测试，47 项真实浏览器与图执行测试，8 项实际 Electron Host 编译产物测试。完整 React 回归覆盖安全输入、保存/替换/删除、密码不回显和不进入浏览器 localStorage；也验证密码页录制自动暂停及离开后恢复。截图已检查：`output/bot-workspace/secret-input-card.png`、`saved-credentials.png`。
- `npm run typecheck`、`npm run build` 通过；本次安全输入/凭据相关文件 ESLint 0 错误、0 警告。日志 `/tmp/cmb-bot-vault-*`。`test:workflow`、`test:messages` 在此前文件预览版本已通过；之后变更继续按相关范围验证。
- 尚未计为全部秘密能力完成：Windows 实机 DPAPI、非密码框/跨 frame 的安全输入、环境变量及连接器专用秘密目标仍未验收。

## 本轮补齐：结构化问题与普通表单（MSG-11、MSG-15）

- 从原 Cmb 工具抽取共用问题 Schema，原桌面工具的选项数和超时规则不变；复用原 UserInputRequestDialog 的选项、补充说明、题目导航及提交布局，新增内联模式、提交互斥、多选支持。按 requestId 重置表单，同一请求轮询保留填写内容；Bot 不自动选答案。
- Bot 的 request_user_input 支持 1～10 个问题，文本必填或 2～5 个选项，支持单选/多选及自定义文字。Host 校验完整字段、对应题目、选项范围、重复选择；显示标签由原问题决定，不能由客户端伪造。专用秘密字段定义拒绝进入普通表单。
- 回答绑定持久 interaction/run/版本，已处理、任务停止、过期或失去租约后拒绝；同一答案重传保持幂等。已确认的普通答案与对应问题一起写入对话，后续可查看；安全输入不走这条消息路径。
- 58 项领域/模型图/问题测试通过，6 项浏览器相关测试此命令跳过（此前独立显式通过）；完整真实 React 回归新增单选、多选、自由文本、补充说明、必填与取消，已通过并检查截图。原聊天导航 9 项测试、招乎远程问答专项通过。工作流完整专项在抽取共用 Schema 后通过。
- 类型检查通过；相关问题组件/模型工具/存储文件 ESLint 0 错误、0 警告。日志前缀 /tmp/cmb-bot-questions-*。后续继续验证最终编译产物。


### 消息表情回应（2026-09-30）

- 使用原 Grok `reaction-actions.ts` 的投影/计数和 `reaction-picker.tsx` 的六个快捷表情。使用 Cmb 现有 Popover/Button；支持粘贴单个 Unicode 表情，未引入完整表情目录。来源及哈希已记录。
- SQLite v7 保存每条消息的回应和修订号；升级前备份。用户只能切换自己的回应，Bot 工具只允许回应当前对话的用户消息；网络重试使用显式添加/移除，不能当作再次 toggle。回应不能触发任务或消费审批。
- 新 Host 广告 `message-reactions` 能力，旧 Host 过渡期间隐藏未支持入口。刷新包含所有已加载历史页的回应，旧请求不能覆盖较新修订，未变化消息保留 DOM 身份。
- `/tmp/cmb-bot-reactions-tests.log`：6 文件 80 项通过、6 项默认跳过；React 全旅程及旧历史回应新增/移除通过。节点/Web 类型、构建、消息回归通过；相关 ESLint 0 错误 0 警告。最新编译 Host 8 项通过，包含回应写入后进程重启读取。日志 `/tmp/cmb-bot-reactions-process.log`。

### 浏览器普通下载（2026-09-30，继续开发）

- 在既有 Grok 页面操作和 Cmb 不可变文件服务上统一下载路由；不再要求所有下载必须经 `download_file`。按 Chromium frame/target 身份分配文件，Target 创建时继承弹窗来源；显式下载工具优先，避免重复发布。
- 经批准的 Bot 浏览器操作收集开始的下载，返回文件 ID 或下载错误；人工接管绑定当时的对话，私聊和群聊分开。完成后使用既有哈希文件、附件和预览链路；下载提示不启动新的 Bot 任务。页面网址、请求头和内部错误路径不写入聊天。
- 单文件 25 MiB/30 秒、每 Bot 同时最多 4 项、全局 8 项；单次普通操作最多收集 4 个文件。保存前再次检查控制权、运行租约、对话成员；接管、取消和退出使旧操作失效。等待响应头期间也检查取消，终止悬挂导航，保留原页面。
- 真实 Chrome 覆盖双 Bot 并行 POST、blob、子框架、首次响应即文件的弹窗、显式下载不重复、人工点击、群聊归属、超限和未分配页面拒绝。模型图实际完成 `browser navigate → 审批 → 下载 → read_file`，使用本地 SSE 模型夹具。
- `/tmp/cmb-bot-autodownload-tests.log` 4 文件 70 项通过；补入群聊后的浏览器/文件专项 15 项通过；类型检查与构建通过，相关 ESLint 0 错误 0 警告。编译 Host 启动及持久数据回归 1 项通过（其余 7 项本次未重跑）。实际 React 全旅程通过，包含人工下载后的消息附件、正文预览；截图已检查。日志 `/tmp/cmb-bot-autodownload-ui-final.log`。后续补入弹窗关闭时注册清理，相关 Chrome 3 项再次通过。
- 限制：普通操作在浏览器确认后额外等待 200ms 收集已开始下载；很晚才由网站异步定时器触发的导出应使用显式等待下载工具。未分配页面、已失效操作不自动接收。浏览器异常退出仍会清理未完成临时文件，尚未实现跨进程续传和下载中心；Windows 实机仍待验收。


### 技能命令入口（2026-09-30）

- 移植 Grok `editor-suggestion-provider.ts` 的归一化/模糊排序/去重及上下键、Enter、Tab、Escape 行为，复用其 `findSpaceSuggestionMatch`；去掉仅为类型需要的 Tiptap 依赖，接入 Cmb 现有输入框。目录只返回启用技能的 ID/名称/版本和所属 Bot，不将全部技能正文传到输入框。
- 选择以标签和稳定 ID 保存，支持草稿、移除、多技能、发送后历史回显。SQLite v8 单独保存消息选择元数据；接收端在同一消息事务内校验 Bot 所属、接收者、版本和启用状态；复用 Cmb 实际图执行器和 `read_skill`，选择不授予浏览器/连接器/命令权限。
- 排队后技能被停用或更新时，在模型调用前拦截；执行中的工具边界继续复核。已接收请求重试使用原收据，不因技能后续变化重新执行；历史名称/版本不被更新覆盖。未知网络结果保留原 nonce，明确的技能错误保留草稿并允许修正。Electron IPC 针对发送保留域错误码，避免未知网络中断与确定拒绝混淆。
- 旧 Host 不广告技能能力时不开放选择/带技能发送，防止旧后台忽略技能字段。当前是适配现有输入框的技能标签，尚不是整个 Grok 富文本编辑器的逐像素移植。
- 实际图/技能域/重试状态/IPC 4 文件 56 项通过、7 项浏览器专项默认跳过；v7 升级/重开及客户端重试专项 9 项通过；既有存储/群聊/技能试跑/上下文/IPC 55 项通过。React 全旅程通过，包含 `/` 搜索、Enter 选中不误发送、禁用过滤、草稿 ID、历史引用和 Escape 关闭；菜单截图已检查。
- 节点/Web 类型、构建、相关 ESLint 0 错误 0 警告。编译 Host 的技能目录 RPC、发送后技能引用和表情重启读取通过（1 项，其他 7 项本轮跳过）。日志 `/tmp/cmb-bot-skills-*`。后续小屏菜单滚动/焦点处理需随下一轮界面回归验证。


### 指定消息回复（2026-09-30，MSG-06 的引用部分）

- 复用 Grok 的引用摘要/截断及 Host `buildReplyContextNote`，沿用原草稿 `replyToId`；来源哈希写入 PROVENANCE。真实页面支持回复、取消、跨对话保留草稿、发送后显示引用、点击定位与短暂高亮。Bot 内部任务关联及问题答案不会被误显示为用户引用。
- Host 在发送事务内解析同对话目标，消息与任务和幂等收据共同提交；客户端不能提交伪造引用内容，跨对话/缺失目标拒绝。重试仍使用原目标和 nonce；明确拒绝后保留可编辑草稿，已接受的旧回复不清除用户新选的目标。
- 引用原文最多随上下文携带 8,000 字符，并保留原消息 ID/附件；新增 `read_message` 可在当前对话分段读取完整原文。引用以用户数据传给模型，不能作为审批。主线与群聊均接入引用上下文。
- 定向领域/IPC/草稿/历史测试 59 项通过；实际图执行 35 项通过、7 项浏览器测试在本次命令默认跳过。真实 React 全旅程通过，新增引用/取消/草稿和定位 220 条历史之前的消息，截图 `reply-composer.png`、`reply-jump.png` 已查看。技能选择此前补入的失焦关闭/滚动行为随此次页面版本回归。
- Node/Web 类型、构建、原消息专项通过；相关 ESLint 0 错误 0 警告。编译 Host 的关闭客户端继续运行、重启与引用 RPC 验证通过（1 项定向，其余 7 项未重复运行）。日志 `/tmp/cmb-bot-replies-*`。
- **这不是全部消息分支完成。** MSG-06 还需要独立分支视图、执行上下文隔离、计数/未读/深链接及返回主线位置恢复；继续实施，不因引用功能通过就标记整项完成。


### 工作区搜索（2026-09-30，MSG-20）

- 复用 Grok `agent-content-search.ts` 的摘要与周边文字投影；参考 Cmb 原 `searchThreadMessages` 的有界扫描方式。新增 Host 只读搜索与统一 IPC 契约，按消息、Bot、群聊、文件名/MIME、消息内 HTTP(S) 链接、例程六类检索，支持当前对话过滤。
- 搜索在 SQL 读取前过滤没有存活成员的对话、删除的 Bot 及其私有例程。模型配置、凭据库、执行内部收据不在检索表中。链接搜索只定位来源消息，不自动打开网站。
- 每次最多读取 32 条记录、正常域记录按 512 KiB 内容预算停止；稳定游标绑定关键词/类型/对话，空结果页仍可继续，不漏掉字节预算边界的记录。前端连续分批读取至一页结果或结束，可暂停/继续；切换条件/关闭窗口使旧响应失效。
- 复用当前消息分页与定位、文件预览、例程管理入口。搜索结果可跨 Bot 定位原消息并高亮，文件打开真实预览，例程定位到具体条目；不会执行例程或打开链接。没有宣称搜索文件正文、模糊语义或尚未实现的消息分支。
- 服务端/协议/IPC/状态专项 35 项通过；导航与草稿 10 项回归通过。实际 React 全旅程通过（`/tmp/cmb-bot-search-ui-final.log`），截图 `content-search.png` 已查看。首次文件搜索页面测试暴露测试夹具在历史阶段提前关闭文件服务，已将关闭移至最终清理，无产品绕过。
- Node/Web 类型和构建通过，相关 ESLint 0 错误 0 警告。编译 Host 重启后搜索持久消息通过，1 项定向执行、7 项未重复。日志 `/tmp/cmb-bot-search-*`。

### 群聊指定 Bot（2026-09-30）

- 共用 Grok 的匹配、模糊排序及键盘选择实现；群聊输入 `@` 可选择实际成员或全体 Bot，同名成员显示 ID 后缀。选择使用稳定 ID，保存在各对话草稿；Enter 选中不会误发送。仍采用现有输入框和收件人按钮，未将其标记为完整富文本实体编辑器。
- SQLite v9 保存 Host 解析的发送时名称和身份；升级前备份。名称修改和成员移除不改写历史。明确的多 Bot 选择优先于正文姓名解析，未选成员不能被正文或引用中的姓名加入此轮讨论。
- 未确认送达的请求保留原 nonce 和接收者；旧收据不能清除后来编写的任务及其选择。明确成员无效时保留可编辑草稿，成员移除后不能静默扩大为向全体发送。
- 9 文件 63 项领域、迁移、协议及草稿测试通过；真实 React 全旅程覆盖选择、对话切换、发送和历史身份。两张 `bot-mention-*.png` 已检查。Node/Web 类型、构建、原消息专项通过，相关 ESLint 0 错误 0 警告；编译 Host 的引用、接收者及历史重启读取 1 项通过（7 项未重跑）。日志 `/tmp/cmb-bot-mentions-*`。

### 例程修改与确认删除（2026-09-30）

- 沿用已移植的 Grok 日历计算和既有存储/调度器，补齐当前 Bot 例程的分页读取、精确版本修改、暂停及确认删除工具；每 Bot 最多 50 个。修改时未提供的字段保持原值，失效版本提示重新读取。例程和事件触发的任务（含手动运行一次和后续委派）不能再创建、修改、删除例程。
- 模型删除需要对应 ID/版本的人工确认；确认后执行前再次核对版本、授权和租约。删除事务只取消还未启动的对应任务，保留运行、等待和待核对任务及历史成果；客户端丢失响应后可以使用相同 nonce 核对，重启后仍返回原收据。
- 例程窗口实时刷新已保存状态，保留正在填写的新例程草稿和输入焦点。编辑按既定方案回到对话并定位具体例程；删除窗口会拦截确认期间已变化的版本。已核对原 Grok `routines/view.tsx` 的直接编辑器；随后编辑与保存恢复见本页新记录，不将此旧阶段当作全部例程 UI 完成。
- 领域/存储/协议/IPC 5 文件 55 项通过；模型图 37 项通过，7 项浏览器专项本次跳过。真实 React 全旅程通过，包含远端修改刷新、编辑焦点、过期确认和删除成功但响应丢失后的重试；两张 `routines-live.png`、`routine-delete.png` 已查看。
- Node/Web 类型、构建、工作流专项通过，相关 ESLint 0 错误 0 警告。编译 Host 的删除与重启收据读取 1 项通过（7 项未重跑）。日志 `/tmp/cmb-bot-routines-*`。

### 插件任务生命周期（2026-09-30）

- 直接复用 Cmb `FunctionTurnLifecycle`、完整模型响应观测、拒绝/用量判定和 Function Mods 的发布策略，为每个 Bot 执行实例接入开始、完成及停止回调。共用管理器接受 Host 注入的生命周期，原桌面的线程占用与空闲通知行为保持原路径。Bot 在关闭插件进程前等待终态回调，最多 15 秒；失去任务租约后不能发布迟到结果。
- 修复适配层忽略插件 `turn.abort` 中 `turnId` 的问题：沿用原生命周期的精确身份、当前状态与频率限制；仅停止该 Bot 当前任务，先写入持久取消状态。终态回调使用独立事实发布范围，不恢复文件、模型或工具执行权限，配置撤销继续生效。
- 插件返回的提示经原发布策略后单独保存在已有事件库，按执行代次去重；聊天显示独立“插件提示”，不替换模型原答复，也不加入下一轮模型上下文。原 Cmb 可恢复的可选回调异常沿用其链路回退；无法完成终态发布时显示有限失败提示，不向消息写入内部异常。当前为进程内执行生命周期，未宣称插件在进程崩溃恢复后具备跨进程恰好一次通知。
- Bot 图执行、存储、生命周期 3 文件 81 项通过，7 项浏览器测试默认跳过。新增 5 种实际 QuickJS worker 场景再次通过，包含流式中止的部分答复、错误 turnId、主动停止、可选回调异常与配置撤销。插件大组 71 文件/548 项通过、1 项失败、1 项跳过；面板重绘失败单独复测通过，仍保留整组并发稳定性缺口。生命周期、面板和无 Electron 依赖边界专项共 27 项通过。
- 真实 React 全旅程通过，`plugin-turn-notice.png` 已检查。Node/Web 类型、构建、消息专项、工作流专项通过，相关 ESLint 0 错误 0 警告。编译 Host 两个场景分别通过：关闭客户端后继续运行/例程删除收据，以及真实插件执行并重启保留提示；第二项首次测试末尾误用已停止进程的存活断言，修正断言时点后通过。日志 `/tmp/cmb-bot-modturns-*`。
- 尚未完成 Mods 命令/面板/SDK MCP，以及完整 `standard-thread-turn/createAgentRuntime` 生命周期；本节只补齐插件轮次事件，不把全部 Cmb 执行能力标成完成。


### 消息分支与定位（2026-10-01，MSG-06 继续实施）

- SQLite v10 为分支起点、消息归属和读取位置建立独立记录，不复用同时承载审批/任务关联的 `reply_to`。主线和每个分支分别分页、保存草稿、技能/收件人/引用选择及未知发送收据。分支继承起点及之前最多 100 条主线消息，加上最多 100 条本分支消息；之后的主线及其他分支不进入本次上下文。当前支持由主线消息建立一级分支，尚未提供嵌套分支。
- 任务的增量输出、提问、审批、最终消息及下载提示绑定分支；群聊活动轮次索引按对话和分支区分，主线的新消息不会替换其他分支的讨论。`read_message` 允许本分支与继承背景，拒绝其他分支及起点之后的主线。仍按原有权限使用同一项目和对话文件；分支不是新的文件权限隔离区。
- 复用 Grok `projectThreadCounts`，新增分支入口/回复数/未读、起点摘要和返回主对话，返回时恢复已加载历史窗口、位置和草稿；搜索可直接定位分支消息。读取状态采用各自的版本，迟到轮询不得覆盖新读取位置。新增“查看未读分支”入口，能直接进入旧历史起点下的未读讨论，不依赖起点已在当前页面加载。空分支计数批量读取，避免对每条无分支的历史消息重复扫描整段对话。
- 人工接管浏览器时绑定实际主线或分支；下载开始后固定该范围，完成不会跟随当前选中的对话变化。真实 Chrome 验证普通点击、弹窗、群聊与分支的附件归属。文件依然归所属对话共享，提示只进入接管时的讨论。
- 移植 Grok 深链接的原始 URL 校验、16 项启动等待队列、2 秒去重和页面就绪生命周期，增加 `cmbcowork://app/v1/bots/<对话>/messages/<消息>`。链接由服务端消息记录解析主线/分支；复制及当前应用点击定位已接入，只执行读取导航。主窗口 IPC 就绪校验拒绝 iframe/其他窗口。打包配置与 Windows 参数启动、macOS open-url 接收已编码；**安装包向系统注册协议及 OS 外部唤起尚未实机验收**，不宣称跨机器分享或 K8s/多账号链接已实现。
- 9 文件 87 项领域/迁移/IPC/状态测试通过；实际 v9 旧单群活动索引升级与备份、分支/已读/轮次重启保留已验证。实际模型图 3 项通过：读取继承背景成功，读取之后主线及其他分支被拒绝；模型为受控本地 SSE 夹具。真实 Chrome 下载专项 1 项通过（同命令其余 11 项未重复执行）。
- 编译后的独立 Host 专项 1 项通过：实际分支执行、主线不混入分支结果、读取位置与消息归属重启保留、重复发送使用旧收据（其余 8 项未重复）。真实 React 全旅程两次通过，包含草稿、位置恢复、未读、搜索、实际导航 Hook 和剪贴板复制链接；`output/bot-workspace/message-branch.png` 已检查。链接/队列/主窗口 IPC 新增 3 项通过。
- 分支相关类型检查、构建、ESLint、原消息和工作流专项已通过；链接整合后的 Node/Web 类型、构建和新文件 ESLint 已通过；App/主入口/preload 整合文件另查为 0 错误、23 警告，主要为这些文件的格式及一个既有 Hook 依赖提示，没有称整合文件零警告。记录见 `/tmp/cmb-bot-links-*`。分支专项日志 `/tmp/cmb-bot-branches-*`。不将该范围的通过等同于 Windows 桌面隔离、标准执行生命周期或全部核心功能完成。

- 随后补入未读分支入口：3 文件 16 项相关测试及完整 React 旅程通过；Node/Web 类型、构建、相关 ESLint 再次通过，日志 `/tmp/cmb-bot-branches-unread-*`。
