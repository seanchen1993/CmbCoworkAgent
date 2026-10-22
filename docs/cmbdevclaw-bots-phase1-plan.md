# CMBDevClaw Bots 第一期实施方案与验收清单

### 2026-10-22 资料库组合验收闭环（1022CY／G12）

严格闭环 **153／201（76.12%，剩48例；非实现完成率）**。G12本地原功能合同完整通过：现有合成CB资料库先见真实空态；系统窗口两件同蓝选中后一次Open，TXT60B／CSV64B各导入一次；刷新及详情往返无重复，两件逐一定位打开，TXT全文和CSV三行准确。独审20／20：副本与原件SHA逐字节一致，CSV的BOM／4处CRLF及合计74.13保持，原742文件的bytes／mtime不变；全部控制表、192原线程、模型、记忆、配置、709份实际输出保持，0新模型任务或消息。

官方CB资料库已实际加载明确空态“此 Bot 创建的页面、文件和应用会显示在这里”，当前界面没有添加／刷新入口，源码该行也无onOpen。此例按本地全部动作及官方当前可用界面对照关闭；保留官方账户下导入入口不可用的能力差异，绝不记为双端上传／预览通过，不用隐藏API补造。成功多选证据为`local-multiselect-shift-up.png`；早先AX显示两项、截图只选一项的尝试保留，未拿它冒充成功。

资料库验收期间暂存路径仍118，但raw／semantic／patch三哈希有变化，当前两份此前未暂存的源码／测试已经进入暂存；未归因或还原，未执行stage／commit／push。最新用户已授权先push，正在做本批发布复核。证据`1022CY-library-multiselect/{G12-local-library-and-protection-independent.json,local-imported-refreshed.png,local-txt-open.png,local-csv-open.png,official-library-loaded.png,official-return-library.png}`。


### 2026-10-22 空群提示最小修正实屏闭环（1022CZ）

空群展示修正已完成，不新增整例计数。仅原BotGroupConversation补5行EmptyPlaceholder，255份renderer激活前正常Quit空闲main44738，原launcher重开51581；139份非renderer与旧hashed资源保持。独审19／19：全部12控制表、192原线程历史、71 Bot／50群／30例行、42记忆／742工作文件、11配置及用户118项暂存完全同，0新任务／消息。已有空群实际显示“还没有消息”，输入空、成员不变；不为造空态创建或删除群。L12整例只缺真实加载瞬态／本地失败后重试的可见证据，不能用故障注入配置或空白加载帧冒充。证据`1022CZ-empty-group-placeholder/{candidate-activation.json,CZ-empty-group-activation-and-preservation-independent.json,local-empty-group.png}`。

G12资料库批量流程正在独立收口：已有合成CB私聊实屏空态，一次原生多选导入TXT60B／原CSV64B，刷新各一项、两件各自定位打开、详情／资料库往返保持。官方CB当前真实成果空态已打开，无相同添加／刷新／打开按钮；精确能力差异与字节、数据保护独审完成后再更新整例。未发新模型任务、未替旧问题作答，未stage／commit／push。


### 2026-10-22 群讨论运行中强退恢复闭环（1022CY／E11）

严格闭环 **152／201（75.62%，剩49例；非实现完成率）**。E11合并DX真实queued正常重启、ED真实waiting_user强退及本轮CY真实enum running讨论强退三组证据关闭。CY接收者discussion `8fc33851…`在唯一前台execute未回、无ToolMessage时SIGKILL旧main332（exit137），原launcher以同profile重启main44738；同任务ID恢复为interrupted，群内仅一份“应用已重启”提示，原调用／参数／历史不变、游标关闭，无替代任务或补跑命令。原Node43993保持同PID和启动时间，90秒结束后自然退出，无替代进程。

独立审阅完整before／after和实际截图通过：71 Bot／50群／30例行、42记忆文件／742工作文件、配置、完整输出与用户118项暂存均保持；仅预期2任务／3群消息／7原线程消息及群activity／revision增量。旧pending从2变1，是原Runtime在强退之前为旧cancelled调用补入明确取消ToolMessage，原调用记录和hash仍在，不是用户答案或数据丢失。证据`1022CY-running-discussion/{before-running-kill.json,root-owned-kill.json,after-node-natural-exit.json,before-readonly.json,after-readonly.json,local-recovered-group-visible.png}`。本轮无生产修复，无stage／commit／push；下一批为空群提示实屏和资料库组合验收。


### 2026-10-22 界面生命周期与忙时补充批量结算（1022CW／CX）

严格闭环仍 **151／201（75.12%，剩50）**，不把新的部分证据计成整例通过。本地N10真实50轮逐项AX闭合，20切会话、20详情、10创建取消；1个完整往返明确与新正文增长重叠，第2仅打开阶段，其余如实为终态。资源同PID332：4进程保持，FD167稳定，空闲26.97秒CPU0.6304%、RSS约243MiB，最终第400行／END已实屏打开。MiniMax原native第一段8192 tokens到length后由原Runtime续写3736 tokens，001–400编号各一次；217／273两处“滚动滚动”和两段原生回复的协议差异保留，不称文本完全逐字。官方本题真实“已停止，未回复”，无公开正文与50轮，整项N10对照保持部分。

CX仅一次90秒Node，同PID27723实际90.043秒／exit0。新DROP在执行约70秒时到达，原执行器沿既有new-message yield保存后台所有权，约474ms后DROP已注入并消费；KEEP随后独立处理，原完整结果沿真实唯一completion回传。根任务提前结算是让出前台等待，原进程没有取消或重跑。未点撤回／Stop，不将约束已消费当作撤回成功，也不靠无限延长命令重复试窗口。

P04只新增一份现有测试文件中的原Host／SQLite／锁争用组合，138／138及Node类型通过，无产品变更；合法单群取消释放、版本拒绝与无迟到写入已核。原“双群同一物理目录”不由此冒算通过，不扩跨群权限。P03网页和同事来源、E11 queued／waiting_user原证据已复用，缺的连接器环境／running讨论窗口单列，后续只补缺口。

CW数据保全11项通过，旧native、71资料／50群／30例行／42记忆文件／742工作文件及配置保持。用户暂存现从103变为118、侧栏分组变化如实保留，未归因或还原；本轮仍无stage／commit／push。证据`1022CW-keyboard-visual-batch/{N10-local-lifecycle-resource-independent.json,CW-final-preservation-independent.json,p04-combined-barrier/independent-scope-review.json,E11-existing-evidence-reuse-independent.json}`及`1022CX-busy-steering/B05-busy-steering-mechanism-independent.json`。


补充结算：CX保全独审22／22通过，仅新增预期4任务／1命令／9原线程消息，旧资料、历史、42记忆文件、742工作文件、配置和产物保持，CX期间118暂存raw／semantic／patch全同。P16增量覆盖当前118路径（74生产／42测试／2文档），无QA／下载／日志／配置敏感文件混入，无untracked／删除／重命名／同字节重复组；唯一规则命中为此前已有合成测试占位值。全100份N10开／返AX及M05／群图的窗口与HTML身份重核准确；早先把CX两份AX误认为官方窗口的审读判断已撤回，原记录保留，未据此改案例数。

CY准备阶段的输入阻碍已恢复；实际运行中强退及数据保全已完成，最新结论见本页1022CY／E11闭环记录。原准备与阻碍证据保留。

L12最小修正实施范围：CC官方真实空群提示“还没有消息”，本地当前history.loaded后0行Virtuoso无EmptyPlaceholder，确认空白无提示。仅在原BotGroupConversation的components补标准展示，加载中分支、timeline／问题卡、成员／执行／存储均不变。先web类型与格式，CY恢复验收完成后再合并renderer并实屏；L12不因此先整例关闭。

### 2026-10-22 排版修正实屏闭环（1022CW／M05）

严格闭环 **151／201（75.12%，剩50例；非实现完成率）**。新main332已核，沿原窗口实际进入Bots；CM同题在双方266／280布局下完整显示BEGIN、中文／英文、两项列表、四行数字表、三行代码与END。新renderer实际分段和数字右对齐通过，无整体放大／内容裁切；保留原CMB代码底色、分隔线与末段宽度的兼容差异，不以源码通过代替视觉或宣称逐像素一样。群图侧栏／头部／详情均见用户＋两Bot，真实成员仍只两Bot；此项修正不扩关整个M04。

证据`1022CW-keyboard-visual-batch/{M05-candidate-visual-independent.json,group-avatar-candidate-visual-independent.json,post-activation-output-main-readonly.json,local-cw-cm-body-visible-266.png,local-cw-two-bot-group-266.png}`。N10新M2.7任务已实际发出，切页／详情／创建取消正在批量计数，真实流式与终态后循环分列，不提前关闭。无stage／commit／push。


### 2026-10-22 合并修正版进入真实界面验收（1022CW）

严格闭环 **150／201（74.63%，剩51例；非实现完成率）**，本次只新增M02：BD真实拖动／键盘与CV同尺寸实图合并独审5／5；显眼灰条确认是聚焦分隔控件，列表无粗横竖滚动条。保留用户要求80窄栏及官方88的实际差异，不引入精确像素额外门槛。

群头像、Bot Markdown分段／数字列及现有色板显示共用一次renderer-only构建；近邻34／34、原messages、web类型通过，独审无消息身份／原工作台边界扩张。正常Quit空闲旧main51135后，仅激活255renderer文件，139非renderer输出与103用户暂存保持，原launcher重开。M04／M05尚待新实际画面闭环，不把构建通过当作案例通过。

官方新CW_N10_1022CW任务已真实发出；切页动作只出现焦点变化，尚未证实往返，按0次记录，未重复发任务。官方源码支持streaming entry，但不保证每轮公开token；活动与token增长分别记录。此前设置快捷键的瞬时观测已纠正：CmdShiftN之后确实打开过新聊天收件页，已关闭回原CA；不保留“始终同一创建弹窗”的错误推断。

证据：`1022CV-sidebar-history-fixes/M02-final-independent-verdict.json`；`1022CW-keyboard-visual-batch/{renderer-candidate-manifest.json,m05-independent-scope-review.json,candidate-activation.json,N10-official-stream-protocol-readonly.json}`。无stage／commit／push。


### 2026-10-22 组合视觉验收确认的最小修正（1022CW，实施中）

先复用原Cmb渲染／账户信息并核对当前官方0.75源码及同窗口实屏，确认两类差异后再改：普通群组合头像应包含当前用户并最多显示4参与者，本地目前仅前三Bot；官方同一Markdown消息会按连续正文／表格分块，数字列由renderer判断并靠右，本地单气泡与左对齐仍不同。当前严格149／201、剩52，不把部分截图或源码支持先计通过。

最小范围：账户读取及原登录通知订阅只从Bot菜单上提到工作区一次，群图仅显示当前用户和原Bot，不改变成员、授权、消息或派发；Markdown仅在现有一次解析管线中增加Bot assistant显式开关，沿原HAST节点分组与标记数字列，复用现表格、代码、链接组件。保持消息ID、复制／搜索原文、流式节流和普通工作台／文件预览默认行为；不增加消息、存储、执行或独立解析体系。Bot现有色板别名仅按官方当前bright常量修正显示，保留用户持久颜色名／shape。由另一审查者复核实际diff后，两项合并一次renderer构建和真实MiniMax-M2.7复验。

两端创建页13种棕色头像已逐一同尺寸采样，无形状错配，caller均96px；源色板有当前版本差异，单帧动态姿态不同不误报轮廓bug。设置快捷键实测：本地设置内CmdN／CmdShiftN不打开Bot弹窗，Escape正常返回；官方连接应用内CmdN实际可开创建弹窗，关闭后回连接页，该实际差异保留。头像生成／上传是官方独立能力，本地尚无对应图片字段和服务，不添加假入口或擅自扩存储系统，M09保持可见差距。

证据与实施前范围均放`1022CW-keyboard-visual-batch/`；本轮无stage／commit／push，用户103项暂存保持。CV最终数据保全18／18已通过，见`1022CV-sidebar-history-fixes/final-data-preservation-independent.json`。


### 2026-10-22 未读定位与三栏布局批量闭环（1022CV／L04、M01）

严格闭环 **149／201（74.13%，剩52例；非实现完成率）**，新增关闭L04、M01。官方折叠自定义分组后屏外未读跳转，实际展开正确分组，仍保留未读且不切聊天；结合CL本地对应完整流程，原合同通过。临时CA已恢复已读／未分组，原置顶列表保持；官方新建的空合成分组`CV-侧栏验收-1022CV`保留，未擅自永久删除。

两端均在1440×814逻辑窗口，实测匹配250／280三栏、紧凑布局、详情开关与280详情最小宽度；本地展开最小218、官方真实拖至240均可用。紧凑80／88及展开宽度范围差异如实保留：本地80沿用户已要求的窄侧栏，原窗口最小尺寸保持，不改普通工作台。本地已恢复314／360并关闭详情；官方240、详情关闭。证据`1022CV-sidebar-history-fixes/{L04-final-visual-independent.json,M01-layout-independent.json,*compact*,*expanded*,official-ca-restored-ui.*}`，不扩算M02或M05。

P09补做滚动、两命中往返、无结果、120项侧栏筛选及详情开关；准确规模是File-MM共663条、实际加载628条／余35条。先前准备记录将“加载500条”误读为已驻留500、推算1000，独审已纠正：首次载入128，按钮显示下一批上限500。当前全库最大线程971，无≥1000现成线程，P09保持部分、不灌库或冒算通过。L03真实拖排序尚未落位，仍待验。本轮不新增模型请求／产品代码，未stage／commit／push。


### 2026-10-22 历史分页跳动修复实屏闭环（1022CV／N04）

严格闭环 **147／201（73.13%，剩54例；非实现完成率）**，本次仅关闭N04。沿原分页锚点，在Bot行中记录与恢复真实气泡顶部，避免补齐前文后日期去重使正文偏移；普通工作台仍回退原外层行，原分页、滚动、入场与Runtime保持。3文件、42行新增／2行替换；近邻31项、原test:messages、web类型和diff检查均通过，独立DOM／范围复核无新增回退发现。

与侧栏候选共用一次原配置renderer-only构建，正常菜单Quit后激活；255候选文件匹配，139非renderer产物及103用户暂存保持，原launcher新主51135。真实分页500→35、导航15→62，旧BV气泡分页前后五图均在raw y=368，独立正文和输入框区域像素不变；结合CT的真实流式、切回及重载，原N04合同闭环。不以静态采样宣称FPS或全瞬态零位移。保留CT原65px偏移和全部失败记录。

L03侧栏候选19项近邻及web通过，但真实拖动操作尚未形成落位结果，仍待复验，不提前关闭。CU本地混排正式正文11／11、保全16／16；官方首轮及唯一重试均生成错误，M05不计通过。临时排版布局已恢复314／360并关闭详情，其他来源未动。证据：`1022CV-sidebar-history-fixes/{N04-final-visual-independent.json,candidate-activation.json,renderer-candidate-manifest.json,*pagination*}`及`1022CU-typography-layout/paired-visual-and-source-independent.json`。未stage／commit／push。


### 2026-10-22 历史分页气泡定位修正范围（1022CT／N04，实施中）

实屏发现载入更早历史后旧气泡一次上移约32.5 CSS px。源核对：Bot行首日期会在前文补齐后按原规则去重，而原持久化分页锚点记录／恢复的是含日期的外层行顶部；外层位置不变，气泡内部偏移变化。仅沿现有BotMessageEntrance内容容器调整分页定位点，记录与恢复使用同一个内容位置，普通工作台继续使用原外层位置。保留日期规则、分页数据、原滚动控制器与消息身份，不新增执行／存储／滚动状态。先近邻回归，再同一500条历史实际复验；当前L09已闭、N04待验，146／201、剩55。


### 2026-10-22 滚动与长回复组合验收（1022CT／L09）

严格闭环146／201（72.64%，剩55；非实现完成率），本轮关闭L09。沿原ChatScrollController与Grok消息入场源码核对后，真实MiniMax-M2.7仅read_file两次、一次前台Node命令，同PID20792运行60012ms并exit0；最终200编号行逐字一致，首／中／尾标记各一次，原CP文件字节和mtime保持，未生成新文件／记忆／例行，原生独审15／15。

本地真实上翻后，工具结束及正文继续增长期间旧回复／文件卡／输入框四帧像素保持；明确点回底后尾部从120未完→130未完→200连续增长，默认执行过程关闭，无原始工具卡或空工具行。官方同题新正式回复到达时旧K05锚点保持，点新消息后到200；未观察官方token级增长，不冒称采样到相同流式机制。官方第一条读取的QA路径少了K05子目录，实际两次都报不存在，保留该输入偏差，不将其归为产品故障。真实执行和公开失败说明分别核对，不额外添加工具错误卡。

N04继续待补：切回和正常Reload后重新进入的旧正文稳定；真正加载500条更早历史后提问导航14→62，旧内容随后三帧稳定，但分页瞬间一次上移约32.5 CSS px，尚在窄范围源码复核，不称完全无位移。早先屏外分页按钮点击无效、重载回原工作台均如实保留。证据`1022CT-tool-visibility-stream/{local-native-final-independent.json,L09-visual-independent.json,source-reference-readonly.json,*history*,*detached*,*follow-restored*}`。本轮仅验收及文档更新，无为此新增产品代码、stage／commit／push；M07真实审批等未覆盖分支仍开放。


### 2026-10-22 Bot／群删除前真实待答与保全（1022CQ，待最终确认）

复用原CD四对象取消证据，本轮两端具名CB私聊与原CC群均完成只读页面／真实可点击问题准备。本地仅两根MiniMax-M2.7任务waiting_user；私聊与群成员页面ID／scope互异，群只有原子提及的MM执行。私聊遇旧页已关闭后沿原观察／导航恢复的首次错误保留，未改浏览器机制。原784文件、资料／例行／旧记录、配置、构建输出与103暂存保持，准备及保全独审26／26；原Host／browser／memory删除近邻测试16通过、148不相关跳过，不将其计为真实删除验收。官方原生AX误触拖动已取消并改用实际画面点击，群详情暂时“无法刷新”与后来真实页面／问题结果一并保留。

两端精确具名群删除确认框已实际打开并取消；四对象永久删除的单独用户确认仍待回复，未点击最终删除。为继续独立批量验收，仅通过原停止入口结束本地CQ群／私聊两根任务，真实问题已取消、活动任务及accepted均归零；两端对象、官方待答与原26B成果仍保留。A12／D14保持部分，严格145／201（剩56）。获准后再完成实际删除与正常重启核对，不把停止任务当作删除通过。证据`1022CQ-delete-lifecycle/{waiting-local-independent.json,nearest-delete-regression-summary.json,*named-delete-confirm-ui.txt,stopped-target-receipts-readonly.json,local-group-stopped-ui.txt,local-private-stopped-ui.txt}`；早先waiting快照保留作阶段记录。本轮无产品代码改动、stage／commit／push。

### 2026-10-22 已交付文件的未终态退出恢复（1022CP／O04）

严格闭环145／201（72.14%，剩56；非实现完成率），本次仅新增O04。真实MiniMax-M2.7先创建并读回20B result.txt，唯一正式交付后进入可点击问题waiting_user；从原生Quit菜单正常退出，原main99502消失、同profile原launcher重启为28740。根任务如实interrupted，原正式卡重开仍为CP_DELIVERED_1022CP加换行，SHA／mtime／ctime保持；唯一交付回执及原调用均不重放。随后独立新请求仅read_file一次，未重写／再附文件。官方同题唯一20B附件在正常退出后原卡仍可打开，云端原问题仍待答；与本地中断的架构差异如实记录，不伪称相同后端生命周期。

双端原合同独审10／10。附加读回未完全服从“只一行”：使用ASCII冒号并多解释旧问题取消，保留格式与原因表述偏差，不冒称全遵从。重启过程中后续both-absent守卫发现官方已重开，原assert失败保留，不伪造同时进程缺席记录；用户其他官方会话保留。I07本地已跨11:40验证：已删候选零执行，KEEP仅自然执行一次；官方KEEP未见公开回复，保持部分。证据`1022CP-routine-delivery-recovery/O04-paired-final-independent.json`、分阶段只读回执与双端真实UI。未改产品、stage／commit／push。

### 2026-10-22 单次例行删除后到期与最终保全（1022CP／I07部分）

CP本地I07原合同11／11通过：具名取消保留，获准确认删除早于11:40到期点9分12秒；KEEP自然到期仅一次零工具精确回复，已删候选零任务／通知，旧29条例行不变。官方已实际Cancel／Delete，到期约105秒仍“已停止，未回复”、KEEP无公开结果，旧CP云待答保留，原因未知；本轮正控制尚未闭合，I07保持部分，严格计数145／201、剩56，不重刷模型或抹去失败。CP最终保全24／24：旧2128任务、191线程13218原生前缀、783旧文件（42记忆目录文件＋741工作文件）、71资料／50群／1231公开消息／92命令、11配置、全部生成输出及103暂存保持；仅4任务＋27原生消息、唯一20B新文件和自然结束的KEEP行。O04已关闭，附加读回格式偏差保留。

### 2026-10-22 创建页大头像自动闲置动作（1022CO，用户现场差异）

用户指出官方创建页预览无需悬停就动。先核官方0.75创建yIt→ow(size96)的默认idle播放，以及给定动作内核非紧凑Idle_B×3／Idle_D／Idle_A的4／6／6秒片段；本地原统一resting条件把创建预览也静止了。仅两份renderer文件：BotAvatar新增默认关闭的idleAnimation opt-in，创建预览启用并按官方96px；编辑仍90px、侧栏／普通头像默认行为不变。沿原内核、共享预算时钟、可见性暂停、减少动态与卸载清理，无新增定时器／监听器／模型请求或存储。

10项原头像／活动／生命周期测试、web类型、格式／diff与原配置renderer-only构建通过；正常菜单Quit后加载，仅替换renderer，139份非renderer输出保持。官方连续帧确认自动动作；本地首轮14张截图像素完全相同，未冒称通过。CUA重连并以原生窗口菜单激活后，R2在名称框焦点下12帧／1.033秒出现8个独立画面，大头像6026像素变化、形状／颜色选择器与标题均静止，确认本次自动播放修复。未以此宣称整片周期、帧率／完全丝滑或N01／N05／N08全通过；原201案例仍144闭环／剩57，不为单个细节修正扩关整例。证据`1022CO-create-avatar-idle/{source-independent-review.json,live-avatar-independent-review.json,candidate-activation.json,nearest-tests.log}`及官方源码偏移报告。未stage／commit／push。

> 日期：2026-10-12
>
> 基线：`devclaw-bot-beta`，提交 `c7723072`，跟踪 `origin/devclaw-bot-beta`。
>
> 本文状态：用户已批准实施，正在编码与逐项验证；未勾选项仍未完成。
>
> 目标：以最小的必要改动，在 CmbCowork 中新增本地 Bots 工作区，对齐约定的 Grok Bot 核心功能、整体 UI 和核心动画。Mac、Windows 原生运行；预留远端 Bot 接口，本期不建设远端服务。
>
> 2026-10-13 用户补充：UI 和动画必须与 Grok Bot 保持一致，核心功能尽量对齐；按实际界面和操作路径验收，不以类似组件替代。CmbCowork 提供底层能力；不能因为复用现有聊天组件而将原工作台的执行模式、配置流程直接暴露给 Bot 用户。此前确认的一期浏览器与部署范围仍按下文执行。

## 0. 清单使用规则

每项实施先核实原 CmbCowork 的接口与可复用实现，对照 Grok 对应源码及实际交互；Hermes 有适用做法时再借鉴。以核心功能、交付效果和使用体验为验收依据，不要求内部实现相同：可采用更适合本地架构的实现，但须说明理由并实测验证。确定最小必要接线后才改代码，保留原功能边界，并记录具体参考位置、改动理由及 MiniMax／DeepSeek 正反例结果。确认有效后更新清单；无效尝试撤回，失败记录保留。此流程适用于后续全部功能、UI、动画及修复，不等待用户再次提醒。

后续所有实现均须同时满足目标与最小必要改动：优先复用已有接口、消息／状态与组件；单项展示需求不得自然扩展成新的执行、存储、回放或状态体系。编码前核对影响范围，编码后复核实际diff与原功能边界；复杂度明显增长时先收敛方案，不以压缩功能、降低体验或省略验收来减少代码。本约束持续适用，无须用户再次提醒。

### 2026-10-22 自动记忆误存修复闭环（1022CN／F12）

严格闭环 **144／201（71.64%，剩57例，非实现完成率）**，本次仅重新关闭F12。先核原CMB提取／存储和给定Grok `memory-synthesis-service.ts` 的两阶段审核、证据引用与版本提交；保留本地既有“只留可跨本轮使用的用户事实”范围。仅把Bot现有第二次审核改为先列长期用户事实，再完整核对候选；主机核实真实用户引文、事实类型、候选唯一全覆盖及有效事实引用。Runtime直接提供有界用户正文，只有身份匹配的既有引用才剥去引用历史，补充消息同样处理；原对话仍作上下文。原普通工作台、共享提取器、路由／模型／设置、两次请求／30秒、原版本保护与批次全有全无提交保持，不增第三审核或存储体系。该窄审核协议是适配本地合同，不冒称Grok原样实现或已知当前0.75云端策略。

有界真实M2.7二阶段对照12次：原审核仍误批3份旧坏候选中的1份；新协议3份全拒绝，6项正反例符合预期（混合独立偏好、稳定画像、持续项目、明确不保存、引用假指令、上下文修订）。原实际完整摘要链3个冻结场景共4次请求：once／不保存为空操作，混合只留独立长期偏好。另以真实隔离BotMemoryService补自动修订，2次请求14.7秒，同一UUID更新、唯一目标事实／他Bot事实保持、两位小数保持；首轮QA正则漏了中文“验证证据”导致退出1，原日志保留，只对冻结真实产物作10／10独立语义核对，未重跑模型或改产物凑通过。上述独立模型请求合计18次，不混算应用后台未逐条捕获的请求。

实际应用5条新任务均确认M2.7：独立长期偏好零前台工具后自动保存；停用once仅保存一条例行、完整payload／enabled=false／nextRunAt=null，没有误存；明确不保存／临时覆盖零工具且原偏好SHA不变。正常退出重启后从记忆管理真实读回；应用中的长期修订通过get／remember更新原UUID而非自动摘要，违反题面Do not call tools的记录保留，不将其冒充自动摘要成功。不保存题实际输入在完整原文后多47字符尾巴，作为验收输入偏差保留，不称逐字同题。官方当前同题回复正确；本轮未实际观察其持久化，不能推断隐藏后台策略；原1020H双方nonce不污染的既有对照保留。

用户逐项确认后，仅在UI删除旧969B「定时任务 AQ-1021 已安排」，原文已在证据目录备份；之后真实私有search／list均返回[]，没有恢复旧记忆。数据保全独审：原2123任务／13198原生消息、741工作文件、32其他记忆MD、71资料／50群／28旧例行／92命令、配置与原引用草稿保持；只增5任务／20原生记录、一条停用合成例行，唯一新偏好MD及唯一获准旧MD删除。记忆目录仍41文件＝33MD＋8索引SQLite，不将索引文件数称为记忆条数。原2个待答身份不动，终态0活动／0accepted。暂存98→102为另一次实际推进，操作者未归因，现状保留；本轮无commit／push。

最终176近邻回归、node类型、格式／diff和原配置main构建通过；仅原main/application.js增加3421B，其他输出不变。独审38项中36通过，保留暂存变化与原UI零工具违约两个例外，不称全项无偏差。终态C确实重读到取消回复和完整两行未发送草稿。证据`1022CN-memory-admission/{run-results.json,pipeline/,automatic-update-frozen-semantic-review.json,final-independent-source-review.json,independent-live-and-preservation-review.json,candidate-activation.json,protected-draft-final-actual-ui.txt}`及真实UI／回执。只关闭本项临时误存反例，不扩大为全部记忆、模型遵从性、全部任务质量或Windows通过。

### 2026-10-22 Bot用户文字行高修正实施范围（1022CM，待验）

沿M05已确认的继承冲突，原共享MessageBubble用户文字有leading-7，覆盖Bot气泡22px父行高。仅在现有Bot私聊用户文字选择器补line-height:inherit，继承该消息体22px；不修改普通工作台的共享组件、字号／缩放／主题／编辑器和全局行高。先核参考样式及原组件，再走最终renderer构建与web类型检查，实际MiniMax-M2.7／官方私聊多行和Markdown展示对照；整例M05仍按原单／多行／代码／列表／表格完整范围验，不因一行CSS或编译通过提前关闭。当前143／201、剩58。

### 2026-10-22 侧栏定位与待补拖排序（1022CL，部分验证）

复用现有具名CA及唯一既有“你好”分组，未新增生产代码、模型任务或标签。实屏完成置顶／取消置顶、移入／移出分组、标未读、侧栏上下屏外跳转；折叠分组后，未读定位能自动展开并只聚焦CA行，当前“你好”聊天不变、CA仍未读。官方完成CA标未读／屏外跳转／标已读，当前“定时任务助手”不变；原三置顶与合成CA已读最终恢复。电脑工具重连后可用，原失效操作记录不计通过。

本地原置顶顺序、既有分组ID／成员／collapsed及隐藏列表已从真实WAL核对恢复；实际操作前后保全12／12：原任务、原生消息、782文件、41记忆、配置、输出及98暂存均不变，仅合成CA一次未读使activity版本32→33后已读、meta推进，其他activity行与本轮实际before一致。早于本轮的4:10准备快照与9:25实际开始之间已有界面／已读变化，不擅自回滚那段状态。

**L03仍待补**：官方0.75源码确有pin-grid重排、拖出取消置顶、section-body移动和section顺序；本地无拖排序接线。官方拖动工具连续noWindowsAvailable，不能归因官方功能失效；源码证据`1022CL-sidebar-order-unread/official-drag-source-snippets.json`。后续仅沿现有视图偏好补接，不另造执行或消息状态。**L04保留部分验证**：本地原合同主路径已过，官方折叠自定义分组变体尚无实际操作证据，不能以源推断整例通过。当前143／201、剩58。`1022CL-sidebar-order-unread/sidebar-preservation-review.json`及两端UI保留；未stage／commit／push。

### 2026-10-22 自动记忆有界对照结论（1022CK，F12仍待修）

原AQ一次安排／混合独立长期偏好／明确不保存三个冻结样本，分别用未改实现与仅结构化user-assistant证据输入对照，共6条真实MiniMax-M2.7链、8次请求（6提取＋2审核）、零重试。两边一次安排和明确不保存均空操作，混合样本仅保留独立长期偏好；原实现本轮同样没有重现，因此不能把全部通过归因于结构化输入，更不能宣称F12修复。原969B污染和先前3条错误批准记录保留；未将C1方案写入生产，未改模型／全局设置，未写应用记忆或数据库。保持143／201、剩58，不循环刷样本追求有利结果。证据`1022CK-memory-review-prep/C1-provenance-replay/C1-final-independent-verdict.json`。后续若修复，仍须保护正常长期偏好，并解释与参考框架的具体准入差异。

### 2026-10-22 自动记忆与侧栏独立批量验收（1022CK／1022CL，待验）

当前143／201、剩58。F12仅做原AQ once、混合独立长期偏好、明确不保存三个冻结样本的原表示／结构化user-assistant证据对照，沿原提取和审核两阶段，MiniMax-M2.7原模型与采样不变，最多6条链／12次调用、不反复重跑凑成功。只在隔离证据目录捕获待写操作，尚无已证明生产修复；不得因模型输出空操作就降低正常长期偏好或改全局开关。

等待上述独立模型请求时，批量做L03／L04原侧栏置顶、既有分组、拖排序、未读定位及正常重启持久化；仅使用具名合成CA／CB，先记录原状态，优先复用现有分组，结束恢复临时侧栏设置。不新增生产代码、模型任务或标签存储，不改用户Bot外观、草稿与原未读。以当前官方应用同路径对照，没跑完原合同不关闭整例。

### 2026-10-22 群公开正文搜索闭环（1022CJ／L02）

严格闭环 **143／201（71.14%，剩58例，非实现完成率）**，仅新增L02。先核官方0.75.0群真实Cmd+F及其正文索引规则，沿原ChatSearchOverlay、搜索worker、500文档／4MiB语料限额、50条群分页和targetMessageId上下文定位接线。只改群前端及正文投影，不新增数据库、后端、IPC、执行、回放或整群历史缓存；关闭时不建语料并释放索引worker。复核发现旧定位响应可能覆盖新导航，最终在原generation边界上补引用／最新／有效发送的取消入口，初始候选未激活。

真实245条群历史：D02、D08各1／1，1021BR-R2实际1／6→2／6→1／6；外群标记在当前群零结果，在所属群为3处正文命中（2条消息内3处，非文件卡），跨群后无旧搜索状态。清空／Esc、快速改词、引用／取消引用、返回最新及合成草稿保持均实测；引用预览不重复计入正文。私聊内部引用标记仍零结果、公开正文1／2，原工作台工具摘要仍1／5；C私聊原引用和完整未发送草稿保留。

第二轮双方同题均以原子提及只选一位Bot，真实问题卡搜索为2处（用户题面＋问题），本地实际1／2→2／2定位后选择继续，双方唯一正式回复CJ_SINGLE_OK_1022CJ：5.38 CNY。本地真实MiniMax-M2.7仅一根任务、一问题、一真实提交、一正式发送；另一成员无新请求。首轮原生AX点击未保住原子提及，实际广播给A／B，两卡分别继续／取消、未串答；这次操作偏差与随后唯一(pass)讨论保留，不冒充官方单目标同题通过。

Node22最近6文件69／69、原test:messages、最终web类型检查、格式／diff检查通过；最终原配置renderer隔离构建后仅重载页面，main36566与139份非renderer输出未变。源码／分页／取消独审无阻断项，UI证据25／25、真实回执与保全独审24／24：原2118任务、191线程13175条原生记录、782文件字节／SHA／mtime、41记忆／71资料／50群／28例行、配置及92暂存保持；仅新增4任务／21原生记录／8群消息。历史旧B未配对工具调用由正常协议补全，扫描数3→2，两个CD请求身份保持；不是三个live待答均不变。最终0活动／0accepted，无记忆或工作文件新增，旧生成资源未删除。

证据：`1022CJ-group-chat-search/{ui-evidence-review.json,real-mm-and-preservation-independent.json,independent-source-review.json,final-paging-and-closed-resource-independent-review.json,final/candidate-activation.json}`及两端原始UI。此项不扩大为M05排版、M07审批、L09／N04动画或Windows通过。未stage／commit／push；下一高优先仍为F12自动记忆临时内容反例，现有强提示与独立审核仍有误批，须沿现有准入最小修正，不能靠禁掉记忆宣称修复。

### 2026-10-22 Bot 私聊搜索边界修复与群搜索差距（1022CI／L02）

严格闭环仍 **142／201（70.65%，剩59例，非实现完成率）**。实际复现：私聊执行详情关闭时，打开搜索仍会重新展示原始工具卡；引用的内部传输标记也能命中。沿原 ChatSearchOverlay／有界正文搜索修正，Bot 默认只索引公开正文，显式详情仍允许原工具摘要；引用仅在已有 host 来源核验及 id／ordinal／role 对应后索引清洁正文，未经验证的相似用户文本保留。复用原 messageOrigins，每页最多32候选、一次批量查询；未新增存储、缓存、执行体系或 IPC。普通搜索保持工具摘要能力，但入口新增一次线程 metadata 主键读取，不能声称零新增读取。

对照安装原件0.72.1的 QVt 与更新后0.75.0的 T1t：均索引当前 content／richText，引用预览不拼入当前消息索引。真实新版：内部引用标记在详情 On／Off 均零命中；写入工具摘要 On 为1、Off立即为0；原工作台执行命令摘要仍1／5；公开正文1／2→实际下一匹配2／2。既有426条消息的 Bot 中，三个旧交办标记均1／1，另以“父Bot汇总”实际定位原助手公开结果；旧标记不能冒称助手结果。官方以已确认存在的 k06-1021bw 实际4／4→上一匹配3／4定位旧正文；两次未确认该私聊存在的标记零命中只保留记录，不归因产品缺陷。

双方同题实际读取已有68B文件→可点击问题卡→搜索打开时选择继续→唯一回复 CI_LIVE_OK_1022CI：5.38 CNY。本地实际MiniMax-M2.7任务仅 read_file 与 request_user_input 各一次，同一回执实际提交，不写文件、不复交、不保存记忆或创建例行。Node22最近DB／IPC25／25、node／web类型检查、原 test:messages 通过；首轮新增测试误写倒序预期已更正，原失败保留。正常退出、隔离构建并激活后独审26／26：旧2117任务、13169原生记录、782文件及原68B字节／mtime／ctime、71资料／50群／28例行、配置及92暂存保持；只新增一任务、六原生记录。新主36566为预期重启，preload未改，旧生成资源未删除。

**L02整例仍为部分通过**：官方群公共时间线实际 Cmd+F 搜 CD_GROUP_WAIT_1022CD 为1／1；本地公共群时间线无对应入口，成员“执行记录”中的 ChatContainer 不可冒充群正文搜索。接下来复用既有群分页与 targetMessageId 精确定位补齐，不另造历史／执行体系。M07真实审批、M05排版、L09／N04动态证据及Windows仍单独待验。证据 `1022CI-chat-search-boundary/r2/{real-mm-and-preservation-independent.json,complete-source-diff.patch}`、原始两端UI及0.75源码独审。未stage／commit／push。

### 2026-10-22 复制、引用回复与编辑重发（1022CH／L07）

严格闭环 **142／201（70.65%，剩59例，非实现完成率）**，新增L07。对照当前官方0.72.1原消息操作与正文入场实现，复用本地原ChatContainer与Bot引用投影，不改产品代码。双方各三题：首题真实写入／读回／正式交付68B原件，复制公开多行／代码正文后用真实粘贴在空草稿核对、未发送并清空；第二题真实引用原助手消息，仅零工具补答严格六行代码；第三题本地点击原用户引用题“编辑后重新发送”，预填仅清洁正文，独立引用卡保持，唯一新请求零工具回复5.38 CNY。原引用ID／ordinal正确，没有暴露传输块或重复旧动作。官方所查用户消息菜单只有回复／复制／复制请求ID，实际采用复制至草稿修改后新发，明确非同一个编辑菜单入口。

原文件两端均从正式交付卡打开读到同样六行后正常关闭。本地25／25独审及第二题／编辑预填20／20通过：旧2114任务、13157原生消息、781文件、71资料／50群／28例行、配置／输出／92暂存与主4420保持，仅3任务＋12原生消息＋1个68B文件。原首题执行／消息／文件hash、mtime、ctime未变，没有重读、重写或重交。证据`1022CH-chat-interactions/{three-task-and-boundary-independent.json,CH_REPLY-native-and-edit-prefill-review.json,first-task-independent-review.json}`及真实复制草稿／菜单／预览。

首轮正文失败保留：本地代码只有4行、BEGIN前有前言、50条平均43.62字符而非约80字；六行补答只修该局部，不称全文要求已经修完。官方公开回复分段，复制最新段不能冒称复制了合并全文；本题统一“禁止命令”与官方必须用命令写文件能力冲突，官方实际执行并披露，不能以此作公平的命令遵从质量结论，后续夹具授权须明确允许仅创建／读取本题文件所需的原生工具。L09本地已见上翻不抢到底，但截图存在惯性位移，官方未捕获running窗口；M05同逻辑尺寸与N04历史动态证据仍待，均不扩关。无stage／commit／push。

### 2026-10-22 导航超时后旧目标拒绝与新题恢复（1022CG／H11）

严格闭环 **141／201（70.15%，剩60例，非实现完成率）**，新增H11。原样复用1017BI标准库45秒延迟夹具，在独立随机端口运行，不改原20秒导航超时，不重启61618／44997旧服务。双方各两条真实任务：本地首题预检新页并关闭、单次timeout导航收到真实20秒错误并按返回pageId精确关闭；独立新题仅一次observe该已关闭页，实际拒绝后以新页读到正确标题、空输入和“只读；未提交”，再精确关闭。共7次原生浏览器调用，无输入、提交、命令或额外任务恢复；本地两题均为M2.7。

官方同样20秒超时，但错误没有目标ID，额外查一次tabs后关闭该失败页，偏差保留；新题实际返回`Tab 1 not found`，未改用旧0页，随后新页读取／关闭正常。官方7日志事件含favicon、零POST及准确停止PID133321／38095均只按可见回复记载，不冒称云端OS独立证据。本地原始6事件为3次GET，45.005秒后是response-written而非client-closed；不能从服务端write成功推出已关闭页面仍有效。原任务没有迟到新调用，近期BI已取得的122.888秒Stop零迟发只补取消分支，不扩算其他案例。

本地19／19与双端原合同独审通过：旧2112任务、13139原生消息、781文件／41记忆、71资料／50群／28例行、配置／输出／92暂存和主4420保持，只新增本题2任务及18原生消息。root唯一核对本题本地PID56431的cwd／64251监听后SIGTERM，退出143，保留脚本日志。证据`1022CG-browser-lifecycle/{H11-local-final-independent.json,H11-original-contract-paired.json}`及双端实际UI／PNG。没有产品改动、stage／commit／push。

### 2026-10-22 浏览器接管与另一 Bot 并行读取（1022CG／H07）

严格闭环 **140／201（69.65%，剩61例，非实现完成率）**，新增H07。先对照给定Grok的box-help-tool、box-handoff-service和box-handoff-resume，再核当前官方0.72.1：普通电脑浮层退出即释放手控，真实request_box_help则保留待归还任务；两种控制不混作同一租约。本地复用原BrowserService、帮助卡与电脑面板，无产品代码改动。

本地实际A接管→归还→B接管时，旧A控制入口禁用并提示另一Bot占用，B归还后恢复。随后A真实帮助请求waiting_user期间，B仅observe自己独立页面并完成，第二个人工接管仍禁用；回A原卡点“归还并继续”后，同页真实工具回执generation4→6、control=bot、重新观察，原卡消失且任务完成。官方同一CG_HELP卡跨B自有浏览器任务仍等待，实际点击“我完成了”后才变完成卡并回复当前标题／截图。未填写或提交，未回放旧输入。

原合同独审21／21及源码／界面独审19／19通过。原2108任务、13117原生消息前缀、781文件／41记忆、71资料／50群／28例行、配置／输出／92暂存与主4420保持，仅本批4任务及22原生消息和正常活动派生。精确旧generation隐藏调用未实打；旧入口实际失效与既有guard／tests分别记载，不伪造接口验收。证据`1022CG-browser-lifecycle/{H07-final-independent-verdict.json,H07-source-and-ui-review.json}`及双端原始UI。H11超时后旧页负例另批执行，不提前计通过。无stage／commit／push。

### 2026-10-22 侧栏头像两个尺寸参数修正（1022CF）

对照当前官方0.72.1的普通lg36、展开置顶fillPx60，只在原BotsWorkspace两个单Bot调用处显式size36及64→60；反向这两处即逐字恢复CE原源码，既有搜索入口改动保持。BotAvatar内核、全局default42、群头像、CSS、字体与80px折叠栏均未改；两种motion分支分别true→true／false→false。折叠置顶CSS42仍覆盖物理外框，但内部displaySize数值由64变60，不能把分支保持说成所有活动标记像素绝对不变。

web类型／格式及复用原隔离renderer构建通过（本次Node24.13.0，未冒称Node22全量重跑），仅overlay新前端资源并用原View→Reload激活，主4420与139件非renderer产物保持。实际展开／80px折叠、临时置顶合成CA及M2.7运行扩展截图均记录；唯一task99d999ef… completed，实际模型MiniMax-M2.7，零工具、唯一精确回复64 CNY。折叠截图时任务已结束，明确只算完成态；原314栏宽和两条原置顶已还原，不反复造长任务追帧。

源码独审11项、真实任务／范围独审20项通过：2107旧task、13115旧native前缀、71资料／50群／28例行、781文件／41记忆、配置与92暂存保持，仅本题1task＋2native及正常活动／已读派生；生成资源仅预期新hash资产与index.html替换。证据`1022CF-sidebar-avatar-size/{two-size-props-independent.json,real-mm-and-boundary-independent.json}`及真实AX／PNG。A09各尺寸完整实屏对照与动态体验仍待，不扩算完成数，严格闭环保持139／201。无stage／commit／push。

### 2026-10-22 专用登录态与头像批量回归（1022CE／H08、A09）

严格闭环 **139／201（69.15%，剩62例，非实现完成率）**，新增H08。复用原1017AL标准库合成登录夹具，仅更换测试cookie／路径／身份标识，在新随机端口独立运行，原61618服务未动。两端均由A真实浏览器先读未登录、仅点击一次合成登录，B另开页面读到相同CE身份；本地原工作台直接用原内置浏览器地址栏同源访问，实际HTML仍未登录。双方正常Quit、进程归零后重开，再由两Bot分别在新页实际读回已登录，本地原工作台同源新查询仍未登录，随后恢复原空URL首页并折叠。官方只证明Mac客户端重开后的云端登录态，不称其云端浏览器／服务也已重启；GA对重复截图路径的自述未当新截图证据。官方正常重开自动更新为0.72.1，当前源码坐标已重新核实，未点击“重启以更新”。

本地四条M2.7任务均completed，原生工具仅4次navigate及1次合成login click，A／B新页面始终分属各自owner，重启前后pageId不同。服务日志共8事件、仅1次login POST、0logout；两次ordinary GET均false。H08独审27／27，原781文件、41记忆／28例行／50群、其他70档案、配置／输出和92用户暂存保持。CD两合成待答为释放测试槽及正常Quit，已先通过原Stop结束，未永久删除；取消回执和范围另有独审。证据`1022CE-browser-session/H08-final-independent.json`、完整请求日志及双方实际UI。

A09双端13形状＋11颜色共48次真实选择、关闭／重开、正常退出／重启及原样恢复均通过；本地恢复CA的heart／#242424，官方恢复hex／cyan。重启冻结前后12表逐行、191线程／13107行原生消息、781文件及配置／暂存精确相同。65／65仅证明同输入40px kernel一致，不能替代各caller实际尺寸；A09保持部分，不增加完成数。确认普通42／官方36、展开置顶64／官方60两处差异后，仅在原侧栏两个调用处调整size，折叠CSS42及原motion分支保持；该修正的构建与实屏验收另记1022CF，未提前计通过。无stage／commit／push。

### 2026-10-22 删除生命周期的取消路径（1022CD／A12、D14）

严格闭环仍 **138／201（68.66%，剩63例，非实现完成率）**。沿原BotDeleteDialog、Store忙时保护、原线程／页面归属清理核对；当前官方0.72的requestAgentDelete同样先等具名不可撤销确认，取消在deleteAgents RPC之前返回。两边已实际打开指定合成Bot及群的删除确认并取消，官方私聊真实待答卡、群历史附件及成员保持；官方群本次浏览器结果回群后只问文字问题而未生成卡，此次差异保留，不推断隐藏后台完成状态。

本地新CB私聊及CC新群各用真实M2.7打开独立owned page并进入waiting_user，未作答或停止；两次取消前后独审28／28：各12表逐行、两待答及pending call、7原生线程、781文件bytes／hash／mtime、配置／输出／92用户暂存和主进程完全相同，实际数据变化为零。证据`1022CD-delete-lifecycle/{wait-preparation-local-readonly.json,cancel-paired-independent.json}`及双方具名确认／取消实屏。四个明确合成对象的永久删除已另行请求逐项确认，尚未执行；A12／D14仍只完成取消子路径，不因本项关闭整例。未改产品代码、未stage／commit／push。

### 2026-10-22 可见入口实际建群闭环（1022CC／D01）

严格闭环 **138／201（68.66%，剩63例，非实现完成率）**，新增D01。收到用户逐项确认后，只从原群设置永久删除空合成群4c46…，同名Bot保留、原49群逐行保持；再从搜索group→“创建群聊 操作”→原收件人明确选MM与验收A→空框Enter，唯一新群f2b36be1…实际创建，总群回50、71Bot不增加。当前官方也从可见搜索动作完成两位新合成Bot选择与Enter创建，真实成员页仅CA／CB；结合原AJ三成员创建／取消／重开、BZ两成员取消，原D01合同11项独审通过。不抬高原上限，也不把两端搜索浮层外观说成完全一致。

新群真实M2.7仅选MM，task71ec48a9… completed；ls／write／read／正式交付各一次，唯一公开结果与26B原文件正确，正式卡实际打开，13项独审通过。官方首题因禁止命令而诚实未写文件，补充限定目录内写入／读回授权后才交付唯一26B附件，正式预览两行相同；不冒称首轮直接通过、raw下载／云端文件hash或隐藏命令回执。官方首试空查询提前Enter曾生成一成员群，是验收操作失误，已明确命名“CC-单成员试走-1022CC-G”并保留，未删除或发任务；R2明确筛第二人后才提交双群，错误和重试原件均保留。

17项保护检查通过：旧779文件hash／mtime／size、2100旧任务、1218旧群消息、71资料／28例行／41记忆、原49群、5私聊原生历史、配置／输出／92用户暂存保持；仅获准删1群、新建1群、本题1task＋2群消息、setup49B＋result26B。C原两行引用草稿实际保持，双方回到原MM／GA空输入。证据`1022CC-visible-group-create/{D01-final-independent-verdict.json,after-protection-independent.json,local-new-group-regression-independent.json}`及两份正式文件预览。本轮未改产品代码、未stage／commit／push。

### 2026-10-22 创建去重与聊天资料修改对照（1022CB／A05、A07）

严格闭环 **137／201（68.16%，剩64例，非实现完成率）**，新增A07。先核当前官方0.72创建同步ref／pending保护及给定Grok `tools/sand-agent-management-tools.ts:146–173` 仅更新提供字段，复用本地原BotEditor锁和资料工具。双方真实双击创建后紧接Return、切走重开，只生成一个合成Bot并保留一次欢迎；本地唯一身份／intro completed／1条原生助手、零用户和工具。A05的普通重复输入通过，但未出现真实创建失败／重试，本地Return是否仍在pending也不能从时序断言，整例保持部分，不额外造故障追试。

A07本地M2.7三条真实任务均completed：先只改CA自身name／instructions，再以稳定ID只改CB同事name，随后用原工具恢复。各阶段字段差分与回执一致，CA／CB业务字段完整回原、版本各1→3；CB只保留原介绍，未被资料修改唤醒。官方实际同题自己的名称／职责及同事名称更新均可见，最后只恢复两个测试名称，明确保留本次新合成CA职责，不冒称官方整份资料恢复或取得隐藏工具日志。20项独审通过，旧69非目标资料、778文件hash／mtime／size、41记忆／28例行、2096旧任务／1218群消息、5私聊原生历史、配置／输出／92暂存保持；仅新增CB、原49B setup标记和4个合法任务，最终0活动。C两行原引用草稿、双方原私聊空输入已恢复。证据`1022CB-create-and-profile-batch/{A05-final-independent-verdict.json,A07-final-independent-verdict.json}`。

改名后一度AX报告旧placeholder，但实际PNG明确显示正确新名，源码及当前构建的名称依赖完整；这是工具缓存差异，未给产品添加key／重挂载／同步逻辑。真实截图及反证保留于`A07-placeholder-observation-no-fix-review.json`。本轮未改产品代码、未stage／commit／push；8项仓库／配置／输出边界检查全通过。

### 2026-10-22 创建后立即交办真实任务（1022CA／A03）

严格闭环 **136／201（67.66%，剩65例，非实现完成率）**，新增A03。先核给定Grok的 `shared/agents/onboarding.ts:2–7` 和 `agent-lifecycle.ts:120–180`：已有用户正文抑制隐藏kickstart，实际任务优先；本地沿原introduce／enqueue／steer实现，未改产品代码。新合成Bot在创建更多设置显式选M2.7并保存一般职责后，介绍真实running；1718ms后原输入框接收唯一用户题，旧介绍superseded，新独立任务completed，两个injected_into均null，不冒称工具中途注入。原生仅用户＋准确一行助手、零工具，实际response metadata为MiniMax-M2.7／stop，无重复入门题。官方当前新建后处于真实入门待题，同题新文本使旧卡已忽略，随后也仅准确回复15.25 CNY；不推断其隐藏模型／后台或零工具。

20项独审通过，结合原AC已验证职责路径，补齐A03原缺口；原AC介绍先结束32.15秒的timing miss仍保留。旧777件文件hash／mtime／size、41记忆／28例行、全部旧控制行、5私聊原生历史、配置／输出／92暂存保持；只新增合成身份、2任务及49B原Host setup标记（在用户消息前创建，非模型业务文件）。C两行引用草稿实际保持，双方恢复原私聊空输入。证据`1022CA-immediate-first-task/{watch-observations.json,A03-final-independent-verdict.json}`及双方实际UI。未stage／commit／push。

### 2026-10-22 对照官方可见建群入口与原群执行回归（1021BZ）

严格闭环仍 **135／201（67.16%，剩66例，非实现完成率）**，D01保持部分。官方当前0.72安装包 `index.eager-app-tQ6jxzlJ.js:105` 的 `new-group-chat` 搜索动作及原收件人确认路径已核对，实际输入group可见“创建群聊 操作”，选GA／GB后取消回原会话；输入“新建群聊”本轮无结果，保留该差异。不能由给定0.18重建库替代当前官方入口证据。

本地只改原BotsWorkspace和局部CSS，合计新增40行／删除1行：在原侧栏搜索匹配时显示同名动作，直接调用原openNewChat；中文别名为本地可发现性补充，未复制官方居中搜索浮层。不增加执行／存储／权限／状态／计时器或快捷键体系，原提交、取消和去重继续复用。39项原相邻测试、web类型、格式与隔离renderer构建通过；lint前后同1错4警告、零新增，实际diff独审9项通过。只激活renderer资源，原main／preload保持，同46967进程原生Reload；独立QA包ASAR未更新为这版renderer。

真实无结果、原名称、空白恢复、group／中文动作、两成员选择／取消均已验。Enter实际触发原“群聊数量已达上限”，50群限制在HEAD就已存在，本轮未改；没有创建新群／任务，不能称本轮新建完成或官方也限制50。等待仅删除具名合成空群的确认，不直接改库或抬高上限。

随后在已有AW群真实原子@仅MM执行，task9653689b… completed，ls／write／read／正式发送各一次、零execute／同伴任务；唯一公开结果附26B原文件，精确为BZ_GROUP_1021BZ与74.13 CNY两行并有末尾换行，正式卡实际打开核对，16项独审通过。旧776文件hash／mtime／size、2093旧任务、1216旧群消息、5私聊原生历史、69资料／28例行／50群／92命令、配置、139件非renderer输出与92项用户暂存保持；只新增本题文件／任务及正常活动／已读派生，12项保护检查通过。C原两行引用草稿实际保持，结束恢复MM空输入。证据`1021BZ-group-entry-review/{real-mm-group-regression-independent.json,after-protection-independent.json,D01-search-action-diff-independent-review.json}`。未stage／commit／push。

### 2026-10-22 真实强退、checkpoint归属与只读继续闭环（1021BY）

严格闭环 **135／201（67.16%，剩66例，非实现完成率）**，新增O02。原M2.7前台命令只启动一次Node45661，真实started.json／单行launch.log先落盘；15:53:02Z精确SIGKILL隔离主2168，同原launcher／profile重启为46967。原任务如实interrupted，原Node仍是同PID并自然到期，重启不自动重跑；截止后done.txt真实存在、Node已退出、启动日志仍一行。随后明确只读继续，实际3次read_file＋1次ls＋1次正式交付、零新execute，两附件均从正式卡打开核对。

原607消息snapshot经64段真实父链完整重建，尾6与native601–606精确对应；新图620消息同身份完整，旧checkpoint主表行按原保留策略裁剪、外置snapshot仍在，不把continuation_checkpoint_id=null误写为没有图checkpoint。native608是原execute的中断协议补全，不能当真实OS完成回执；图把它置新用户消息前以满足协议，native按实际入库时间先用户后补全，不能要求两者全序一致。原772件文件hash／mtime／size、69资料、28例行、1216群消息、92旧命令、2091旧任务、原native前缀、配置、602输出与92项暂存保持；仅本题新增4文件与2任务，C两行草稿实际保持。19项独立检查通过，证据`1021BY-forcequit-recovery/O02-final-independent-verdict.json`。只覆盖Mac原强退合同，不要求云端Grok的客户端退出等同终止服务；未改产品、stage／commit／push。

另保留一处既有质量问题：最终解释误称前次execute因新消息取消，实际是本轮SIGKILL。native608来自原`malformed-tool-call-recovery.ts:635`补全未应答工具的通用文案，git归属为2026-08-11的537cb38811；该占位不是真实OS执行／取消原因回执。O02的checkpoint归属、真实产物和不盲目重跑已验证，但不能据此称原因解释完全准确；按用户此前共享harness暂缓要求，本轮未扩大修改或反复强退。修订结论见`1021BY-forcequit-recovery/O02-recovery-cause-quality-addendum.json`。

剩余核查按原范围保留：P03浏览器／同事注入已有真实证据，连接器目前均关闭，未为凑验收启用；P04缺合法共享文件争用与资料／成员变动的组合；P09缺1000条有效Bot历史的性能腿，不灌库；P11普通YOLO是全局且没有内置手动compact入口，不改全局或新启Mod造审批／压缩。F12已明确禁止临时状态，但既有13条重放链／20调用中的7次实际审核仍有approved:true语义失败，不是漏审／解析或截断，保留未修，不追加关键词／第三审核层。对应独立报告在`1021BV-core-batch/{P04-P09-P11-existing-evidence-independent-review.json,P11-ordinary-combo-feasibility-readonly.json}`及`1021AQ-next-batch/f12-fix-prep/F12-current-source-independent-review.json`。P14／P15独立包原SSO仍待用户扫码，Windows实机仍缺。

### 2026-10-21 原生退出清理与有限超时恢复闭环（1021BX／O07）

严格闭环 **134／201（66.67%，剩67例，非实现完成率）**，新增O03／O07。O03组合原B06真实停止与本轮原生Quit：M2.7仅一次长程序启动，父98819／子98821同组；新私聊零工具先答，原命令同PID移交后台。原截止前正常退出，原main及父子均消失；同profile重启、越过原截止后仍无late.txt、原命令通知或重放，后台记录cancelled／suppressed=1。源任务和注入任务此前已completed，不伪写为取消。原769文件hash／mtime、69资料、28例行、50群、2089旧任务、1216旧群消息及91旧命令保持；C两行草稿实际读回，16项独立检查通过。仅Mac原合同，O01其他退出阶段和Windows另验。

O07仅在原host.test.ts追加一个115行受控组合，真实原模型封装／Host／NativeSQLite执行六次原60秒watchdog及五次原退避；每次独立signal超时、原任务真实failed，去除fetch故障后同Host／同封装下一任务完成43、旧失败保留。原错误持久化／结算59项及旧B10真实529后恢复证据复用，非新MiniMax或官方服务故障。Host106／106、原Node类型与格式／diff通过；原4条lint错误保持、零新增，10项独立检查通过。未改生产超时、重试、Runtime或存储，92项用户暂存保持。证据`1021BX-packaged-and-quit/O03-independent-verdict.json`及`1021BV-core-batch/o07-original-watchdog-combo/independent-verdict.json`。

P14／P15原生包仍待验。隔离源码1930件编译成功；首轮pack因Electron可执行文件缺失退出1，且准备脚本误复制node_modules顶层链接，首次并非物理副本，失败原件保留。外部QA修正后52894件物理副本／零外链、Electron39.8.10二进制核对通过；仅QA配置指定该副本electronDist、输出新dist-retry-1，绕开损坏缓存，pack退出0。392件有效out与ASAR一致，原SSO环境正确、无E2E入口；新1.5.3应用main31035真实打开原招乎SSO，等待用户完成认证后验原工作台与Bot存储故障。原配置identity:null下codesign校验失败单列，不称发布签名／Gatekeeper通过；当前运行程序、源码及原依赖元数据保持，不把包成功或SSO入口当包内任务通过。首次CUA绑定超时后额外启动31218未带隔离参数，已精确停止，默认数据根与Electron缓存确被访问；所核默认Bot表为空、普通任务／消息更新时间早于本次启动且例行为0，未见本次任务执行，但无完整before不称全盘零改动。仅31035隔离主进程保留，当前实际SSO证据重新采集；旧绑定前画面不归给它。无stage／commit／push。

### 2026-10-21 键盘与头像生命周期闭环、50文件交付核验（1021BW）

严格闭环 **132／201（65.67%，剩69例，非实现完成率）**，新增N07／N09。N09组合原双端名称／收件人和C12真实问题键盘证据、本地正式文件Enter／Tab／Esc，以及本轮官方八次反向Tab到正式来源清单→Enter打开→Tab到下载但不激活→Esc返回同一文件按钮；双方焦点截图经独立查看，12项检查通过。仅覆盖原命名键盘路径，不扩为IME、全部无障碍、Windows或动效全部对齐。

N07真实侧栏滚动、原生Hide后同bundle重显、退出Bots到原工作台及返回均有实屏；主PID79669及21:26:11起时保持，没有重启或重放。共享时钟、可见性暂停、离屏跳过与最后目标卸载清理由当前源码、原帧调度测试及P10真实预览释放支持，12项独立检查通过。隐藏标签约180秒、工作台53秒及返回10秒的实际资源记录保留；未直接读取隐藏document.visibilityState或rAF计数，不把总CPU当头像帧计数。原生焦点恢复失败及最终访达重显路径保留；69资料／28例行／41记忆／728工作区文件与配置保持，7项保护检查通过。

K06两端同原50文件ZIP与冻结题完成四件正式交付，本地M2.7原18次工具均有回执、唯一五附件（四件＋可选ZIP）；本地180条完整记录、原ID、精确分币种合计、50源字节／SHA及ZIP四件一致14项通过，旧666文件hash／mtime保持，新增62件仅本题。双方四件均已从正式卡实际打开；官方180条四字段与50项实际展开的字节／SHA全部一致，四件正式预览语义副本经原oracle检查12／12通过；不冒称raw下载、官方隐藏OS输入保护或ZIP字节核验。官方“48份CSV”实为45份的说明错误、首次缺zip命令后的恢复及本地README轻微数值说明偏差保留。两端本题均未发生规则读取后的真实压缩，K06仍部分，不靠灌token或新增压缩入口凑关。

B05一轮有界操作未赶上撤回窗口：本地唯一60秒命令PID53063／exit0先完成，DROP／KEEP分别晚9293／15797ms才接受，均非注入或取消；后续正常依序回复且无新execute。官方同题也已结束才到补充操作，未发送过时补充。保留timing miss，不归为产品缺陷、不重跑加长、不关闭B05。近期11份暂存交付源码独立复核未发现可确认的新增重复执行／公开回复／漏附件或原Runtime回归；不是任务质量保证。证据`1021BW-k06-consistency/{N09-final-independent-verdict.json,n07/N07-final-independent-verdict.json,local-final-independent-verdict.json,paired-final-delivery-verdict.json}`及`1021BV-core-batch/{b05-queued-followups/phase-native-review.json,recent-delivery-diff-independent-review.json}`。本轮仅更新清单，未改产品、stage／commit／push。

### 2026-10-21 浏览器同类控件与真实关闭恢复闭环（1021BV-H02／H12）

严格闭环 **130／201（64.68%，剩71例，非实现完成率）**，新增H02／H12。本地M2.7两轮各7次真实bot_browser，分别填写／fresh observe读回两项FIRST与RECOVER值、双页标题、AN-PAGE-7413与74.13；精确核PID／PPID／lstart／专用flag后只SIGTERM新13639（重启后全部浏览调用仅本题、内存页从空开始，只有本题两页），主79669与fixture67394保持，新20753／generation1／新两页均真实，旧ID不复活。无新POST，原local历史POST1保持；666旧workspace／41记忆／资料／例行与原历史前缀保持。

官方旧46427首轮真实ERR_CONNECTION_REFUSED诚实停止。新明确setup授权只将原四份合成文件原字节复制新目录并原样启动，新44997／POST0基线独立，旧失败和日志保留。R2首轮与原生电脑大图见两FIRST值、未选文件／未提交；取得控制后实际关闭本题Chrome窗口，延后画面确为灰桌面，归还控制后再发恢复题。最终回复及实际新表单大图均见两RECOVER值、相同标题／标记／74.13，未选文件／未提交；本轮只切表单标签核对后再次归还控制。早期未刷新关闭图、CtrlShiftW误输入W并立即退格修复均保留，不把旧帧或声明冒充成功。

12项独立配对检查及本地23项检查通过；官方隐藏OS／工具次数／日志不冒充独立取得，local子进程与官方原生关窗两种原合同路径分开标明。网页引用诱导两端均未照做，但P03连接器／同事来源及H11取消场景仍开放，不随本题扩关。证据`1021BV-core-batch/p0-browser-recovery-prep/{local-recovery-independent-verdict.json,paired-H02-H12-independent-verdict.json}`与双方实际UI。未改产品、stage／commit／push；最新92项暂存内容已发生外部变化，现状保留、只读记录，不归因或回滚。

### 2026-10-21 提及键盘组合与原指针分支闭环（1021BV-D08）

严格闭环 **128／201（63.68%，剩73例，非实现完成率）**，新增D08。当前双端真实名字筛选、Enter／Tab插入、上下键、两次退格解除原子身份、撤销／重做、Esc只关闭候选、普通粘贴及原空草稿恢复均留原始AX；本地AW本轮零群消息／零任务，官方原BR-B待答子树逐字保持。当前choose／鼠标分支与原1019FB实际指针成功原组件一致，复用原稳定ID及只有B回复61的真实回执，不增加新模型题。18项独立检查通过。辅助AX点击仅剩@、官方首次中文键入不全及本地旧帧原件均保留，不误称产品缺陷或这轮新指针复测。

同批两端CmdN名称Tab／ShiftTab／Esc、CmdShiftN收件上下／Enter只选未创建、Backspace移除、Esc关候选后Tab／Space关闭返回原会话均已真实观察，未创建或删除资料。官方composer里的Tab会插入制表符，已清理仅本轮临时空白回原空稿；不是把该现象算名称键盘遍历通过。N09完整名称／待答／文件与L10真实IME、设置分支仍开放，不以部分路径扩关。证据`1021BV-core-batch/{D08-final-independent-verdict.json,keyboard-local-*,keyboard-official-*}`；未改产品或索引，未commit／push。

### 2026-10-21 目录临时产物最小指导修正与真实回归（1021BV-P05-R2）

严格闭环 **127／201（63.18%，剩74例，非实现完成率）**，P05重新关闭。对照给定Grok的云端/workspace与用户本机边界以及原CMB cwd接线，只在Bot已有本机说明追加条件句：用户限制输出目录时，临时下载、响应头、日志、中间文件及失败重定向同受限制。不新建命令解析、权限／沙箱或执行机制；普通线程不注入该句。原137项与Node类型／格式／diff通过；主进程候选只多288B，其他601构建文件保持，沿原同profile启动。

真实M2.7独立任务a8b573…已完成：原生494–511、8工具／2次execute，其中Node仅一次真实stderr marker及exit7（外层echo／cat最终0分开记）；HTTP200原页面42143B、响应头241B、stderr21B、报告2705B全部只在新bv-scope-1021bv-r2目录。唯一正式两附件与实际文件一致，均从原交付卡实际打开；报告必需字段与WAL单writer结论正确，curl命令示例尾部转义不准的轻微产物差异保留。662旧文件hash／mtime、41记忆、69资料、28例行、2082旧任务及原消息／命令／5私聊历史前缀、配置与92项暂存保持；仅本题task与成果及真实已读派生状态新增／变化。结合原AQ官方169文件保护对照，19项独立检查支持关闭，不冒称本轮重跑官方或所有未来模型都会遵守；旧/tmp三件及失败记录保留、未删除。

激活单列：原G1待答在旧PID正常Quit时按原Host.stop合同变interrupted，早于新main安装；完整962条历史／原call保持，无伪答、不重放。不能写“待答始终waiting”，也不为掩盖差异改DB恢复或新增恢复体系。23项独立激活保护检查通过，after按active筛线程未采到G1的缺口已补独立全历史逐hash核对。O01四阶段整例仍开放。证据`1021BV-core-batch/p05-scope-guidance-fix/{real-minimax-independent-verdict.json,activation/independent-activation-review.json}`及两份真实打开UI；未stage／commit／push。

### 2026-10-21 流式切换与分阶段资源闭环（1021BV-B11／P08）

严格闭环 **126／201（62.69%，剩75例，非实现完成率）**，新增B11／P08。B11结合原AV真实正文001后切走、返009仍运行，与本轮MiniMax200行唯一原生回复、运行中切返、正式末尾及完成后重开；官方R2真实切回GA仍“正在输入”，随后同题200行末尾完整。两端实际PNG均见BV2_LAST；本地R2原生仅差终端LF，归一后与冻结SHA一致。保留本轮离开时处于原context-compaction、不是已见正文，以及先前漏过运行窗口／首次旧帧的记录；不把AX叶子512字符观测限制误判为丢尾。12项独立检查通过，L09／N04上翻跟随与动画仍开放。

P08复用同主PID的空闲、浏览器、后台与真实agent SSE阶段采样；真实流式15秒CPU126.375%（单核100%口径）、5个相同进程／FD274稳定，结束后CPU7.6641%、RSS约161MiB／FD273，仅原保护待答、无accepted命令。14项检查通过，证明本次负载结束可回落，不冒称零CPU、任意数据无泄漏或Windows实机。证据`1021BV-core-batch/{B11-final-independent-verdict.json,resources/P08-streaming-final-independent-verdict.json}`。此项未改产品或索引，未commit／push；P05另在真实复验。

### 2026-10-21 重建后的重复唤醒去重（1021BV-I05）

严格闭环 **124／201（61.69%，剩77例，非实现完成率）**，新增I05。仅在原host.test.ts补58行一个组合：原真实NativeSQLite中过期启用例行已有pending，Host.stop后在同连接重建Store／Host，三次原resume只推进一次未来slot、不新增补跑；放开受控runtime端口后仅执行原task一次。结合原重复resume／到期与恢复入口，关闭原恢复去重机制合同；不冒称物理DB／应用进程重启或OS睡眠实测。Host105／105、完整Node类型、格式／diff通过，独立审查通过；eslint4条与原before完全相同、零新增，旧I08／O06及产品文件保持。92项stage语义与cached patch保持，raw index字节变化单列，不撤回或猜测来源。证据`1021BV-core-batch/i05-restart-dedupe/final-manifest.json`。未stage／commit／push。

### 2026-10-21 讨论预算与增量checkpoint证据复核（1021BV-E09／O09）

严格闭环 **123／201（61.19%，剩78例，非实现完成率）**，新增E09／O09。E09复用原真实Store／SQLite51项：三类pass无公开气泡／未读／新轮，8初始目标与20次推进精确受10任务／3轮上限约束，合法选中任务及peer回执未完成前不启动可选讨论；对照给定Grok3轮／10成员turn，不为收敛截断交付。O09复用原物理SQLite关闭重开：30次父链／flush storm最新cp正确，4×2MiB不生成逐步全库副本，1501消息重开后追加仅序列化1条、父链保持，另一有界恢复再重开逐消息一致；原缓存12上限／16项lease回归保持。不是本轮新provider跑满预算、物理OS强退或整机性能证明；原LRU环境首失败保留。I05同实例重复resume通过但跨Host／Store重建组合仍缺，保持部分。证据`1021BV-core-batch/O09-E09-I05-existing-evidence-review.json`；未改产品或重复宽测，未操作索引／commit／push。

### 2026-10-21 官方资料研究通过、目录限制新反例（1021BV-K08／P05）

严格闭环仍 **121／201（60.20%，剩80例，非实现完成率）**：新增K08，同时重开P05，净计数不增加。两端同题正式Markdown预览均实际完整打开，三问、直接支持链接、页面更新与访问日期、END正确；本地真实专用bot_browser回执及5625B正式发送／SHA核对，10项独立检查通过。官方旧唤醒阻碍保留，最终正文已载入；原K08不要求额外原始下载，不新增Save门槛。

本地execute却实际向`/tmp/h.txt`、`/tmp/wal.html`、`/tmp/p.html`写临时文件，违反本题目录限制，也构成原P05的新反例，不能让AQ旧成功掩盖。P05重开，先核真实参数及原CMB／Grok工具指导是否冲突，不新增shell解析／存储体系。首次浏览器参数错误与交付前锚点修订、官方未逐锚点击的说明均保留。证据`1021BV-core-batch/{K08-final-independent-verdict.json,K08-local-independent.json}`；研究正确不等于整题全约束通过。本项未改产品或stage／commit／push。

### 2026-10-21 原全局记忆与浏览器边界闭环（1021BV-P13）

严格闭环 **121／201（60.20%，剩80例，非实现完成率）**，新增P13。原全局记忆前后实际打开，始终同目录、合法空库0文件／0B、enabled／Dream关闭；Bot私有41文件独立（33条Markdown与8份索引，并非41条记忆）。原浏览器前后真实加载WAL正文，刷新后实际页面／URL及目录交互确认可用；Bot本题使用新专用owner页面9a4e…、无旧共享浏览器／全局记忆工具，原metadata memoryEnabled=0。9项独立检查通过。首次冻结截图与刷新过渡树被排除，最终真实AX／截图另存。仅关闭前后可用与边界，不覆盖F12记忆内容或全部浏览器场景。证据`1021BV-core-batch/P13-final-independent-verdict.json`；未改产品、权限或索引。

### 2026-10-21 四来源资料权限原边界回归（1021BV-P01）

严格闭环 **120／201（59.70%，剩81例，非实现完成率）**，新增P01。复用原8文件345项实际执行：真实内存SQLite／Host验证私聊、具名群用户、例行及命令通知的持久资料权限正反例；canonical通知只继承原用户任务权限，伪造命令输出、例行／同事来源、错owner／thread／群、移除成员及终止任务均不能提权，合法更新只合并指定字段。给定Grok0.18以host绑定来源、专用profile更新和原子保存作参考，本地沿原Store事务与来源校验，未新建权限／语义判定体系。不是本轮新provider或官方隐藏实现的证明，聊天完整资料体验A07与三类资料注入P03另验。证据`1021BV-core-batch/boundary-source-audit.json`及两份原测试结果；本项未改产品、索引或commit／push。

### 2026-10-21 私聊取消与群长工具后读取闭环（1021BV-P06）

严格闭环 **119／201（59.20%，剩82例，非实现完成率）**，新增P06。私聊真实前台79169经原按钮Stop，随后完整读回200行；群原98877仅启动一次，同PID移交后台、180秒自然结束后，新任务仅read_file与一次正式发送。两次群读取均完整200行，17866B／SHA与冻结原件完全一致，第1／100／200行准确；原长任务、命令及完成通知均终态，原G1待答保持。原合同未要求两端各点Stop，不追加该门槛；群自然完成不冒称停止。首轮1200秒超时及provider失败、群进度文字与实际后台／task_output差异均保留。17项群检查与14项私聊检查通过，实际结果界面已核对。证据`1021BV-core-batch/P06-final-independent-verdict.json`与`p06-group-after-result-ui.txt`。本项未改产品或stage／commit／push。

### 2026-10-21 原工作台关键入口回归（1021BV）

严格闭环 **118／201（58.71%，剩83例，非实现完成率）**，新增P12。复用原12文件108项与6个原脚本门禁（workflow-script32项已包含其中，不重复累计），并实际核对项目空列表／新建取消、原BO三条DONE代理及RFC8259完整工具回执、原三项技能与AR模板预览、原自动化空列表、IM既有开启但未登录的合法状态，界面均可进入／返回，未改配置或发送外部消息。不是仅凭菜单标签，也不把BO产物45／49写成质量通过。原文要求的相邻回归与关键入口已独立判通过；本批未新执行原workflow、未验证原定时到期或认证IM发送，不扩大为所有原功能全程已验。证据`1021BV-core-batch/P12-final-independent-verdict.json`。

P06私聊R2已真实前台启动79169后按钮Stop，后续独立read_file200行与原件17866B／SHA完全一致、最终三处原文正确；群分支仍在进行，整例不关闭。首轮在锁屏期间未完成Stop，最终原execute1200秒超时exit124、随后provider Request timed out的失败保留，不将其写成成功停止或读锁死锁。两端K08正式报告已生成，本地原私有浏览真实访问和三问／来源／日期正确；官方附件打开仍受电脑工具／远端唤醒影响，继续补证。无stage、commit或push。

### 2026-10-21 历史悬浮预览渲染故障修复（1021BU）

严格闭环仍 **117／201（58.21%，剩84例，非实现完成率）**，本次修复不额外扩充或关闭原案例。真实 ErrorBoundary 的 `ChatScrollMarkerRail → ChatScrollNavigator` 栈与旧数值索引反例确认：旧历史悬浮索引53／54在新轮次回到128条尾页时失效，读取 undefined.preview；不是审批卡错误。BU命令实际在原YOLO配置执行一次且已完成，无待审批，先前“审批触发”的判断已更正。

仅沿原组件把已有悬浮状态改为问题稳定ID；目标消失同render关闭且不读空对象，保留目标重排后的当前位置，沿用原timer清理与DOM定位。无新store／执行／权限／存储机制，普通token的memo边界保留。13项组件回归及6文件114项邻近回归、原test:messages、原web类型与两文件eslint通过；原失败测试夹具类型尝试保留，最终显式typed render-prop无断言。独立源码diff审查通过；renderer独立构建后保留旧assets，未改main／preload或Git暂存区。

真实M2.7复验：加载86次旧提问、定位第54次原1018BS-TASK-MM，单次零工具回复BU_HOVER_OK_1021BU，尾页缩为27次后无ErrorBoundary；再加载87次仍能返回同一旧问题。真实CUA未观测到悬浮弹层持续跨窗，不将SSR或导航点击冒称hover timer实测。原群B待答、C引用草稿均在界面恢复；前后全部41记忆／658文件／11配置hash、原选定native历史、待答call、非renderer输出与91项暂存均相同。仅新增本次合成任务及对应活动／序号。证据`1021BT-stop-and-recovery/bu-approval-fix/{final-gate-status.json,activation/}`。M07真审批与I07到期前删除仍另验；无stage、commit或push。

### 2026-10-21 前后台停止原合同闭环（1021BT）

严格闭环 **117／201（58.21%，剩84例，非实现完成率）**，新增B06。12项独立检查通过：原X真前台45秒及后台90秒按钮Stop，合并BT真实父74108／子74111同PGID、native470前台且唯一execute、471原18744e45回执；新用户先回后同PID移交后台，真实按钮Stop后两进程均消失、命令cancelled／suppressed=1。18:00超过原900秒截止仍无done或精确command通知，原G1 B待答保持。见`1021BT-stop-and-recovery/B06-final-independent-verdict.json`。

官方当前无独立后台Shell停止按钮，模型声称等用户点停止并不代表入口存在；本轮明确通过聊天要求kill，官方17:53称已查两PID消失／无done。此仅官方可见结果，进程表与started.json起时差5m40无法独立解释、旧官方FG自然完成未点Stop、旧BG多通知和本地旧漏报PID均保留，不编造隐藏OS验证或要求不存在的按钮。O03运行中退出另验，不随B06关闭。无新产品修改、stage、commit或push。

### 2026-10-21 忙时并发与50次界面往返（1021BT）

严格闭环 **116／201（57.71%，剩85例，非实现完成率）**，新增B08／P10。B08复核BR-R2原完整组合：A真实前台与B独立问题占两槽，A私聊零工具43优先、5895／5907原PID自动后台且仅一次execute，B待答未被取消，A随后自然完成。官方同题真问题／43及返回后B仍待答均有实屏，PID仅模型说明、两时间源顺序差异保留；旧CSV接力不是本原条款，不扩B→A交办新门槛。见`1021BT-stop-and-recovery/B08-final-independent-verdict.json`。

P10五类各10次实际往返共50，逐次真实AX确认：记忆、资料库、正式JSON预览、真实about:blank采集面板、原工作台/Bots。两张同路径历史成果卡首选离屏入口未打开，已保留尝试，改点当前视口卡后仅计真正开关成功；未改产品。新增唯一blank renderer属本题页，FD362→363→该页+15后378保持，原renderer／browserhost句柄无逐轮增；RSS844512→679168KiB自然回落，不强制GC。原工作台51.096s实际累计CPU差分总7.516%，不是零CPU，也不据此归因Bot或称所有性能已达标；浏览器采集端停止活动。合并原订阅／采集／worker／扫描／单DB清理对称边界及已有异常测试，原有限50次合同独立通过，不增加必须回冷RSS门槛。见`resource-routes/P10-preclosure-review.json`与50轮实际记录。

原生CMB同M2.7 BO基准已idle完成，6原件不变、原49独立验收再跑仍45／49；Bot首46→一次反馈49、官方首49，不能推为总体排名或单一模型/harness原因。普通审批、流式切换、压缩及原global memory/browser实际前后仍另验，P11–P13不随此关闭。仅测试／证据和清单推进，无新产品修改、stage、commit或push。

### 2026-10-21 交流历史与三来源回传闭环（1021BS）

严格闭环 **114／201（56.72%，剩87例，非实现完成率）**，新增E12／O06。两端真实交流旧→新翻页、返回原会话及其他未读保持；本地400行、官方215行交流尾页与往返前相同，官方283行原GB私聊返回同样一致。来源／稳定历史提及复用已通过L11／AY实际UI，范围与已读用真实SQLite及当前活动读位支持，不新增交流已读存储或点击锚点。见`1021BS-routine-confirm-archive/ui-batch-prep/E12-final-independent-verdict.json`。

O06仅在原host.test.ts补96行组合：同一真实SQLite／Host的私聊、群、例行3来源均accepted未完成，再同轮反序与重复回传；原owner／thread／origin／唯一nonce、例行不提权、群唯一公开结果与6任务终态全部核对。完整Host104／104、Node类型／格式和独立diff审通过，原lint4错无增，I08补测与index保持；未改产品，不冒称真实provider／OS执行。见`recovery-batch/O06/independent-case-verdict.json`。

下一BT真实M2.7父子进程已前台启动，实际74108／74111同PGID，私聊新请求后以同PID移交后台并零工具回复；17:46原界面Stop后命令cancelled／suppressed=1，两PID实际消失，G1原B待答未动。首次陈旧控件点击未生效已按只读状态区分，真正Stop另留回执；原900秒截止后无迟到及官方同题仍待验，不提前关闭B06／B08。无stage、commit或push。

### 2026-10-21 长历史往返闭环（1021BS）

严格闭环 **112／201（55.72%，剩89例，非实现完成率）**，新增L08。真实本地G1已加载旧二／三页并滚动，返回最新后426行AX整树（仅去节点编号与焦点尾注）与分页前完全相同，原待答仍保留；官方长群旧页真实连续同秒消息仍分开，返回最新197行整树同样一致。相同毫秒边界复用真实Store与滚动合并原用例，不人工改UI数据、不新增产品机制。独立判定与两端旧／新页图片见`1021BS-routine-confirm-archive/ui-batch-prep/L08-final-independent-verdict.json`。E12交流历史仍单独核对，不随本例关闭；无stage、commit或push。

### 2026-10-21 恢复与边界并行回归（1021BS）

严格闭环 **111／201（55.22%，剩90例，非实现完成率）**，新增O10／P07／P16。O10复用真实旧数据迁根、旧绝对路径附件打开、重启后旧报告及历史提及打开，结合当前真实SQLite旧schema／头像／alias边界结果，不重复发模型题；O06三来源同时回传与O07完整首字节超时仍开放。恢复邻接补跑59／59，证据`1021BS-routine-confirm-archive/recovery-batch/O06-O07-O10-independent-verdicts.json`。

P07原registry／IPC19／19：未知Host、快照版本及非法event revision明确拒绝，合法本地保留；一期并无独立event协议字段，不为测试新增远端握手。P16仅冻结当前91文件diff与构建notice检查：未发现生产诊断／密钥／合成样例，无未跟踪或删除文件，3份notice与原件相同；后续diff改变须重核，不承诺任意未知秘密格式或商业授权。P14实际坏存储首次打开仍待验。见`source-boundary-batch/P07-P14-P16-original-contract-review.json`。

原CMB共享邻接另补12文件108断言及6条原自隔离脚本最终通过；macOS默认临时路径别名的首次memory-p0失败保留，只按既有/private/tmp配置原样复跑，不改测试。无确认退化，不把门禁等同P08–P13真实性能／50次路由／普通任务全流程通过。本次仅更新清单，无新产品代码、stage、commit或push。

### 2026-10-21 删除确认实屏与两项闭环（1021BS）

严格闭环 **108／201（53.73%，剩93例，非实现完成率）**，本批新增O08／I08／M08共3例（O08先前106已记，不重复计数）。I08真实BQ归档v6跨16:42、到期once自然v3 disabled／next=null／0schedule root／无marker，原UI恢复v7后不补跑；删除分支仅原host.test.ts新增43行真实Host／SQLite生命周期用例，103／103、Node类型和独立审查通过，同名重建新ID也0例行／0任务／0acquire。不冒称物理DB／进程重启或官方等价archive；仅测试增强，无新产品机制。见`1021BS-routine-confirm-archive/I08-independent-closure-review.json`。

M08复用原memory-MM：当前和更早历史真实On／Off、失败MCP两层展开有RAW ARGUMENTS／RAW RESULT，Off原工具消失、成果卡保留，旧页实屏未见隐藏工具占空位；原工作台execute／更新任务仍可见。420条native与95条control tasks全字段hash不变；重入后的真实BQ显示ViewExecution0，只证明偏好关闭，不说回同memory-MM。旧重入文件因陈旧工作台快照被排除；官方无此诊断开关，不强加官方raw门槛。见`ui-batch-prep/M08-original-contract-final-verdict.json`，M07／L08／E12不随关。

删除确认6行窄修已实际激活：原CMB具名不可撤销confirm，两次实际Cancel保留原编辑／列表，用户新确认后仅删除两条BS候选，本地及官方均具名再次确认后删除。两条在16:42前未赶上确认删除，本地已正常到期一次；I07因此仍开放，不能把到期后的删除或其他候选组合成同例通过，不再次自动改期／新建追跑。BQ例行首轮和一次反馈都在实际模型tool args中缩短未来执行正文，版本更新不等于原文修订成功；原失败与官方原文尚未直接读到的边界保留。23项本地限定事实审计通过，原2063tasks／27routines／654文件／41记忆／配置及main／preload／PID保持，仅本轮3user任务＋1MM到期／BQ例行生命周期变化；已读变化与暂存91的外部变化分列，不声称全库或index字节从始至终不变。证据`local-independent-final-audit.json`及真实UI。无本批commit／push。

### 2026-10-21 剩余案例并行推进（1021BR）

严格闭环更新为 **106／201（52.74%，剩95例，非实现完成率）**，新增O08。原history-retention.test.ts只补51行真实成果保护用例，无产品修改：同一SQLite真实prune100／11／0、旧行删除、近期completed任务及同public正文／附件引用保留，真实CSV的BOM／CRLF／原字节仍能经owned路径读取。原9项活跃链／回执去重／引用／事务回滚及新增组合共10／10，格式／diff通过；重开为同连接重建Store，不冒称物理重启。新测试首次selector用错group requestId的失败保留，仅修测试定位为origin.messageId。证据`1021BR-parallel-regression-plan/deterministic-core-batch/o08/O08-original-contract-verdict.json`。

删除确认已实际激活并完成Cancel负例：原View Reload后完整AX正常，精确编辑合成BR-保留-MM-1021BR，Delete弹具名不可撤销native确认，实际Cancel回同一名称／正文／时间的编辑窗，再原取消返回列表。仅MM已读84→85和globalrevision正常+1，其余控制表／旧native／B原待答／41记忆／654工作区文件／配置／index91／main与preload及PID保持；前轮旧CUA灰图不再推为产品白屏。I07完整跨到期确认删除另起BS自然M2.7同题，不用旧已到期候选冒充；旧误删事实保留。

BR删除确认候选未计实屏通过：两套renderer Reload后电脑工具曾持续只返回窗口外框，Console未见JS fatal，DevTools可见React根已挂载；重绑／完整AX后原工作台和Bots旧会话均可正常读取，不能由旧灰图直接归因产品。最终磁盘已恢复原renderer每一原文件字节，主程序／preload未改；新确认源码保留待可靠激活／实际取消复验，不冒充I07完成。首环境配置候选拒绝、隔离候选AST通过、两次实际重载与恢复过程分别保留在`delete-confirm-fix/activation/`。重载限定15项数据保护通过；暂存90→91是额外观察，仅保留、不回滚、不归为Bot数据改动。

严格闭环更新为 **105／201（52.24%，剩96例，非实现完成率）**，新增B12／E10／P02。20个既有Vitest文件实际542／542，10个原CMB自隔离脚本最终均退出0，按三条原合同逐项核验后仅新增3例，不把断言数当案例数。真实BotStore／NativeSQLite／Host调度与磁盘symlink路径执行，Runtime使用确定性端口，未调用模型；官方给定源码的消息身份／队列与正式发送回执参考已记录，不冒称对官方隐藏服务注入丢回执。一次checkpointer脚本因验收进程额外数据根覆盖失败，按原有自隔离方式重跑通过，首日志保留。原产品／测试／index未由本批修改。证据`1021BR-parallel-regression-plan/deterministic-core-batch/case-contract-verdicts.json`、`next-batch-map.json`及真实日志。

严格闭环更新为 **102／201（50.75%，剩99例，非实现完成率）**，新增D13／H10，复用BN原完整证据而非重跑。三scope真实数据／问题／结果／native浏览归属、官方三正式下载33项及本地三页预览／G1真接管／其他scope禁用／归还，均满足原隔离合同。官方0.72群无电脑入口、私聊有的实际差异单列，不额外要求不存在的控件或把本批未成Save当原D13／H10门槛。原partial过严判断及G2首次摘要遗漏／反馈恢复、未成Save全保留。见`1021BN-cross-scope-batch/D13-H10-original-contract-final-verdict.json`。

BR例行删除首轮失败保留：根代理预期打开确认再取消，实际直接删除合成KEEP，是根代理操作错误；原KEEP旧ID已删除，原Bot已用新ID0de1970a…按原名／正文／15:38时间恢复并仅真实到期一次。用户确认的本地候选已删除且无到期task；官方实际具名确认取消后保留，再确认删除，但已过原到期，不冒充完整I07。BQ原15:38到期前未完成归档，正常触发属于操作miss，不计I08。其余25例行／旧文件／资料历史／41记忆库存保持。最小源码修正仅BotSchedulePanel复用原CMB具名不可撤销window.confirm（+6／-2），不改原删除接口／版本校验／调度／执行；web／lint／格式与renderer-only候选构建通过，实际激活与取消复验待做。当前官方0.72有确认，给定0.18没有，来源区别如实保留。

严格闭环 **100／201（49.75%，剩101例，非实现完成率）**，本批仅新增A11。BQ原真实待答→guard拒直接归档→Stop／归档／恢复／唯一零工具新题，合并BR实际满两槽后的排队→直接归档取消→恢复不重放，两条原合同路径完成。原8条已完成任务、14条历史前缀、文件及资料其他字段保持，原A忙时任务与B问题均未被BQ归档操作取消；独立10项合并审查通过。官方无等价归档入口是本地架构差异，不以删除替代归档。证据`1021BR-parallel-regression-plan/A11-independent-closure-review.json`及BQ原证据。

并行方式已调整为真实独立任务和共同等待窗口：BR的A前台父／子5895／5907＋B真待答同时运行，A新私聊零工具先答，原命令真实同PID自动移后台且不重跑。官方同题私聊响应及B保留可见，隐藏后台状态不推断，B08整例仍部分。原停止窗口因电脑操作延迟未命中、本地自然完成，B06不算通过；误发短正文／首次后台选择／截图与AX不一致均保留，不乱改产品。第二批两Bot私聊与官方同题已安排共同15:38的一次性例行，等待期间继续浏览器、历史及UI组合核对；群来源既有例行写入边界保持。未新增生产代码、stage、commit或push。

### 2026-10-21 并行组合推进与窄修激活（1021BN／BO）

严格闭环 **99／201（49.25%，剩102例）**，新增K16，复用真实证据而不重跑：BO本地真实3反例复现→一次反馈→实际修订／Node导入读回→原49全绿／旧件保护→唯一六正式件完整版本，七项通过；官方既有1020AK真实覆盖旧JSON反例→真实反馈→修订正式件→20＋4反例／字节保护，六项通过。AK当时明确只交变更CLI／README，未变lib沿用首轮正式件，三源最终SHA一致，不事后要求多发；不称官方BO也修订、不称本地模型修前重跑红或逐文件全文回读。旧AR显式render遗漏仍保留，K08／NativeSave不随关。

严格闭环更新为 **98／201（48.76%，剩103例）**，新增I06。本地原生once到期时旧题仍waiting_user，唯一schedule来源排队；真实新用户注入后旧题实际ignored且answers为空，先唯一BP_USER、后独立BP_ROUTINE，同ID单次自然禁用并保留。官方同题旧卡已忽略、无选中答案，先唯一新用户回复、后唯一到期提醒；七项原合同独立映射通过。官方提醒显示迟约5m35、once仍on及两时间源22秒差异保留，不推断隐藏队列／数据库，不扩大I10。证据`1021BP-I06-prep/I06-closure-review.json`。原CMB同M2.7另起空线程基准已从正式UI启动：原ZIP附件不支持的现有限制保留，仅改成显式授权读取同一1633B只读原件路径，题目其余一致；未改变原上传功能，基准尚未结束。

严格闭环更新为 **97／201（48.26%，剩104例，非实现完成率）**，仅新增K05。BO本地首轮46／49的CSV反例保留；一次真实反馈后239e34dc…修订任务completed，原49全部通过、原三断言与money／tasks逐字保持，唯一六件正式回执、ZIP五源完全一致；README／四源已逐件从正式卡实际打开。原官方同题49／49及六件NativeSave也通过，首轮质量差异保留，本地NativeSave仍未验，不扩大到下载专项或K08。15项修订核心与限定原数据保护通过；期间新增例行明确属于并行BP，暂存语义90项保持、raw元数据变化单列。证据`1021BO-k05-repair-quality/local-qa/local-revision-independent-verdict.json`。

BN同root补验05已真实通过11项：A先发布唯一文件正文，再公开转交且不重述H2，B实际原生输入包含完整原正文，仅一次发送准确H2，附件不含标记。两条helper路径均完成真实复验，首轮跨root测试设计错误、两次11位后缀轻微偏差仍保留；无额外生产改动或201加数。BP本地／官方已真实保存14:35单次并保持问题待答；本地到期真实独立schedule排队，随后新消息先回复、旧题ignored空答案、独立提醒后到。官方新消息及ignored已见，真实提醒尚待观察，I06不提前关闭。

本地BO首轮已实际交付六件并完成三次原生浏览器访问；独立原49项仅46通过，CSV空记录、连续空字段及末尾空字段3例失败，money／tasks与原冒烟保持。README把稳定排序能替代稳定字符串ID写作推断，结论仍错误，K08未通过。原件／真实调用／ZIP一致性已冻结于`1021BO-k05-repair-quality/local-qa/local-first-independent-verdict.json`。一次组合修订稿已备好，但系统保存窗口取消后电脑工具返回noWindowsAvailable／elementHasNoFrame，界面输入未生效，未出现真实新root；所谓sent-ui只保留为操作尝试，不计实际发送／修订。保存窗口截图替代方式仍超时，第三次由用户取消，后续不重复打开；实际下载继续待验。

BN直接派发已真实通过：独有标记仅位于A的公开附件同条正文，不在用户题目或31B附件；B原生输入实际包含该正文，仅一次公开发送精确标记。首协作补验把源行放在上一root，按既有seen边界未进入本轮，B如实报告缺源；这是验收设计前提不足，不据此修改产品或声称第二路径失败。已准备同root内先公开附件正文、再公开转交的一次补验，当前UI阻碍下尚未发送；11位而非12位后缀的轻微首轮约束偏差也保留，不反复探针。证据`file-message-text-fix/real-review/first-review-native.json`与冻结seed。

BN本地五项主任务均已真实完成，四张问题准确作答、三份10字段结果及两次独立复核正确；13项核心隔离／数据保护通过。随后G1真实接管显示本题URL，私聊／G2接管按钮明确禁用且不能借用控制权，原G1正常归还。两个原生保存面板均由用户取消，正式本地下载仍未通过，D13／H10整例不提前关闭。G2首轮明确发送空content，所需总结只存在私有final；一次反馈后仅补公开总结，首轮失败保留。给定Grok的成功纯附件也能结束delivery owed，未发现可直接移植的摘要完整性门禁，不强制所有附件正文或自动公开私有文字。见`local-final-verdict.json`、接管UI及`g2-empty-content-grok-protocol-review.json`。

BN原groupReferenceText窄修已正常同profile退出／重启激活194d5f89…75c03，仅application.js变化，另393件保持；16项限定持久化／配置／index／源码保护均通过，原C引用两行草稿重启前后实际UI完整。真实正文上下文正反例仍待验，不能以单元测试代替。BO本地原M2.7已于14:10从真实附件入口发送与官方完全相同的ZIP和组合题，开始原49项产物质量对照；官方侧49／49与K08不可达仍保持各自边界。当前严格计数仍96／201，未stage／commit／push。

### 2026-10-21 代码修复与来源核对组合（1021BO；进行中）

继续P0 K05／K08原合同：复用1633B原项目ZIP、既有49项独立验收及原三条冒烟断言，三项直接官方来源研究写入既有README，仍恰交六件，不新增验证体系。本地75257仍两个waiting_user与一个queued且CUA绑定超时，未重启／取消／私下注入答案；先向空闲官方GB真实发同题组合（13:36:48），约一分钟后实际六件交齐并已全部从正式卡NativeSave下载。真实网页三项均ERR_CONNECTION_CLOSED，官方README与最终消息说明未验证，K08不计通过；K05须独立产物审计，不以模型自报16测试代替49项验收。本批无生产修改、暂存、commit或push，严格计数仍96/201。原题／UI／下载／三来源独立事实边界见`1021BO-k05-repair-quality/`。

官方BO独立产物审计已通过49／49（money16、CSV18、tasks11、原冒烟断言3与实际运行1），原README／test完整前缀保留，六件与ZIP五源字节一致，执行前纯函数／标准库审阅及执行后原件SHA保持。实际新增12个assert而自报13的轻微说明差异保留，不放宽功能标准或反复追问措辞。K05仅官方侧通过，本地同题尚未执行；K08三来源未取得内容，仍开放。证据`official-independent-final-verdict.json`。

### 2026-10-21 组合隔离回归进行中（1021BN）

按用户加速要求，将D13／H10的同Bot私聊＋双群、四个独立问题、同名文件和三浏览器作用域合并交错验证。真实UI已新建本地／官方双Bot群；本地抓到B-G1待答、A私聊待答、A-G2排队的重叠，G1实际G1-乙及唯一result.json正确。官方同题G1正确交付；原题禁委派误含官方内置浏览器助手，澄清后继续，原失败／群文字提问与私聊卡片的差异保留。完整接管／下载与终末核对未完成，不增计数，仍96/201。保存首件时本地系统保存面板的电脑工具连续超时，保留现场并继续官方及独立审计，不改执行链或隐藏写入答案。证据`1021BN-cross-scope-batch/`。

本批独立源码审计确认并修正一处BJ新能力遗漏：公开附件行允许同时带正文后，旧groupReferenceText仅向下一轮群任务提供文件引用，丢掉同条正文；影响直接群上下文与公开handoff。仅原helper +2／-1，原测试+31；两真实内存Store路径先红2例再同断言绿，邻接51／51、完整Node类型／lint／格式／diff通过，独立审查无阻断，纯文件原字符串与24K整条预算不变。物理scratch沿原main配置构建，仅application.js候选变为194d5f89…75c03，其他393件不变；当前预览仍301a，未覆盖out或重启，真实复验仍待验。 后续完整web类型检查也退出0／空日志（web-types-result.json），不能代替真实复验。用户90项暂存三hash保持，不计验收完成。证据`1021BN-cross-scope-batch/file-message-text-fix/`。

官方BN的三主任务与两B复核均已实际结束：三份result.json从正式卡真实下载并按原冻结全部字段通过；B-G1卡在P／G2回答后仍保留，最后仅BG1-确认后才输出G1数据，B-G2正确只报告G2数据。官方群问题为文字、私聊／B-G1为卡片的实际差异保留，不猜官方隐藏工具。未完成本地剩余问题／下载及双方控制作用域，D13／H10仍partial，计数不变。

F12补充源码复核（1021BM）：原CMB与Bot均走现有memory_summarize路由；给定Grok现代实现使用专用摘要模型，旧路径仍用主模型。没有发现可直接移植且确定修复现有反例的新接线缺陷；已有20次探针及失败记忆保留，不再叠提示或新增过滤体系。F12仍开放，记忆复核未改记忆实现或模型配置；本批生产窄修另列于上。

### 2026-10-21 例行真实到期三态闭环（1021BL-I03／I04）

严格闭环 **96/201（47.76%，剩105例，非实现完成率）**，仅新增I03／I04。复用本地AQ已有三条真实schedule来源／当前文件读取的16／19／22项回执，官方新BL单次原生未来到期也已完整观察：v1进入工作后静默结束；v2自动报告74.14／+0.01；坏JSON自动报告BL_ERROR及无法核算。原UI正式下载第三态输入为冻结的41B，SHA一致且未补齐／修复，8项原合同独立通过，无新增生产代码。

旧AQ未运行现场保留；官方分钟精度、通知相对约定时间晚4m38／9m51、原once开关仍on、历史预览v1但下载实际v3的差异均保留，不虚构隐藏工具回执或自动删除。本地重新安排时多建原单次条及独立F12记忆污染仍开放，不扩大到I07／I10／Windows。证据`1021BL-next-batch-prep/official-real/I03-I04-independent-final-verdict.json`、实际UI／原生到期结果与41B正式下载件；未stage／commit／push。

### 2026-10-21 群附件与所需结论的最小交付修正（1021BJ；限定复验闭环）

- [x] 源码与真实BC两轮对应：文件已通过正式工具公开，但所需总结仅存在不可见的assistant final；不是renderer丢字。给定Grok0.18的SendMessage明确区分text与attachment，普通附件禁止content；官方0.72可见结论与文件均有交付，不能据此推断其隐藏调用形状。
- [x] 复用本地既有text／files_json消息行，在现有公开群文件工具上加可选content；验证全部文件后由原callback／Host／Store同事务一次写入。同调用改正文或文件仍CONFLICT，省略正文仍保留原纯文件语义；私聊／内部协作schema、原文件锁、完成性校验与禁止自动公开final的边界保留。六生产文件+82／-30，无新表／消息队列／回放或公共Runtime改动。
- [x] 281项邻近、独立6项原附件解析／消息展示、完整node类型、格式／diff、原CMB标准线程及系统提示基准均通过；首轮一处旧mock参数断言失败保留并准确更新。独立源码审查无阻断；本地main-only构建仅application.js更新为2f8f7710…c610，另393文件不变。同profile正常Quit／重启16项数据核对通过，原12表、选定线程／旧件／41记忆／68档案／24例行保持、无重放。
- [x] 第一版R1真实通过：A唯一公开总结与三附件同条，双方独立浏览／下载，B实际Buffer.equals与双64B完整hex回执，三件原UI均打开核对。R2交换角色后仍失败：B的公开文件调用省略content，完整74.13／+0.03结论留在native866普通final，公开行text为空；真实复核／三件正确不等于总结已交付，失败保留。16项R1与18项最终限定数据保护通过，不把读回脚本的saving瞬态／跨轮cutoff修订误记成产品缺陷。
- [x] 第二版只改原tools及测试：公开群schema要求显式选择content字符串，合法纯文件可用空串；对象级preprocess仅兼容旧JSON缺键为原空正文，其他非法值拒绝。当前真实convertToOpenAITool／ChatOpenAI.bindTools均导出required=[files,content]，私聊／内部schema不变。282项近邻／完整node／格式／diff与独立小审查通过，无新增语义门禁或模型轮次。仅application.js激活3243e574…a97ac，另393文件保持，同profile正常重启14项原数据核对通过、active0，无重放；原C引用与两行草稿再次实际UI确认完整。
- [x] 第二版R3真实失败保留：B native880仍仅传files，普通final882有正确结论，公开行text为空。原只读会话导出取得真实MiniMax-M2.7 fetch：新版工具required=[files,content]及群公开／普通文字私有规则均实际送达，排除旧schema；模型／服务仍漏参，本地preprocess又将缺参变成成功，不能全归模型。
- [x] 按用户要求临时将原A／B从原UI切到deepseek-v4-flash，同群／同构建／同自然题只改批次和文件名。DS-R1三任务完成，native896仍漏content，私有final898有74.13／+0.03结论，公开1164只有三件；独立浏览下载、双64B／Buffer.equals及三件内容正确，10／11，所需公开总结失败。18项限定保护通过，两model_ref以外的档案字段保持；未取得DS实际fetch导出，不冒称由配置证明具体provider请求。
- [x] 复核原CMB参数解析／wrapToolErrors、受控checkpoint续跑及Grok0.18的withSafeParsedArgs后，删除第二版缺参补空兼容：仅tools.ts +9／-18、原测试+3／-3，显式空串仍允许，私聊／内部files-only及原发布／锁／回执不变，不新增门禁或重试。282项近邻、完整node／格式／diff与独立审查通过；仅application.js激活301a6950…56b38b，另393构建文件不变，同profile原生Quit／重启15项限定保护通过。参考与原失败证据见`required-content-validation/`及`remove-compat-preprocess-source-review.json`。
- [x] 修正版DS-R2及恢复原M2.7后的MM-R4均以原自然题真实公开正确74.13／+0.03结论与唯一三件，双方实际独立浏览／下载／原字节核验，无重复外部动作。两轮首个公开文件调用即带非空content，不冒称真实现场触发了缺参纠正；缺参拒绝由原参数测试验证。原UI三件已在DS轮全部打开，两Bot原model_ref及非模型档案字段已精确恢复；沿用官方BC真实成果与公开总结作对照，不冒称同一模型或内部协议。
- [x] 纯文件负例核心10项通过：首次显式content空串、零公开文字、唯一原CSV；模型漏先read的首次失败保留，一次明确仅read反馈后真实read_file341／342与唯一正式发送344／345准确读回三行，6项通过，无写入或重附。终末18项限定保护通过：原65群件与旧task／message／native前缀、41记忆／68档案／24例行／原配置／index90保持，只出现授权8新文件／8任务／8群消息及A／B原模型恢复；活动任务／命令0。模型仍可能漏步骤，不能由本轮推断全部任务质量无缺陷；不为此新增生产语义校验体系。证据`final-protection-verdict.json`及三轮真实回执／UI。

BJ本项尚不增计数；当前因BL原I03／I04闭环为96/201。用户管理的90项暂存保持：本批采样index由旧c60f…变为52d4…，根代理及子代理均未stage；变化单列、不推断归因或撤回。未执行commit／push。证据`1021BJ-group-summary-audit/`的源码对照、最终manifest／独立review、build／activation-comparison与冻结原题。

### 2026-10-21 标签草稿与聊天资料更新闭环（1021BH-A08）

严格闭环 **94/201（46.77%，剩107例，非实现完成率）**，仅新增A08。本地旧版本标签草稿在真实聊天改名后明确CONFLICT，草稿和新名保留；一次显式重试仅保存标签，14项限定检查通过。官方同题实际改名时原标签草稿仍在，首次Enter直接保存独立标签，新名称未被覆盖；重开确认标签原值，符合事前冻结的原生字段合并分支，不伪称官方也出现冲突弹窗。

双方已通过原UI恢复原名与空标签，本地B保持v14；官方GA原名和正式BH_NAME_DONE结果已核。12项原合同独立检查通过。官方隐藏版本／数据库和命令PID不可见，不据模型自述推断；A07全套资料授权不随关。本项无新生产改动、stage、commit或push。证据`1021BH-name-tag-conflict/A08-independent-final-verdict.json`、本地局部检查、官方草稿／实际保存重开／恢复UI及截图。

### 2026-10-21 完整人工接管闭环（1021BK／R2-H06）

严格闭环 **93/201（46.27%，剩108例，非实现完成率）**，仅新增H06。双方实际未知值填写、原UI归还、真实新观察与准确结果已独立通过，当前Mac完整人工接管流程闭环；H13／Windows不随关。

- [x] 用户要求优先完成H06后半程。BK任务`588ec0f4…`曾真实等待用户，help精确指向原表单`cd8f000b…`，备注为空、原两页保留、未代填／提交。随后原help真实返回`closed`／`pages=[]`／`control=bot`，说明人工期间页面已关闭且未重开／重放；下一模型调用报`Connection error`，任务已failed。用户说明刚才断网且未看到窗口；不推断关窗责任或把时间相邻当直接因果，原失败保留。
- [x] freshUI确认旧页已无、无人工控制后，按用户“继续”用新771B题干发起BK-R2：新任务`4cba1400…`先真实waiting_user、新表单页`401f72dd…`，仅navigate与help两调用、原值空。用户实际输入未知备注222，并额外在交付名称输入111；额外值是人工输入，模型未代填／覆盖。用户表示已归还时UI仍human，根代理补点原“归还并继续”一次才取得真实回执，不推断原点击未生效的原因。
- [x] 同help实际新ToolMessage返回同表单、control=bot与完整222；模型唯一正式文字准确逐字答222及页面标题“合成浏览器核验1021AN”，任务completed，无其他工具／上传／提交／命令／文件。输入值没有提前给模型，原生证据先独立提取再对照实际预览截图。官方BF同样真实填写未预告的完整`BF-HUMAN-1021-Q7M42`，归还后逐字读回与标题正确，实屏／截图已复核。
- [x] H06原9项门槛通过，31项限定产品／任务／数据／源码／构建保护通过，POST仍1、活动0，原BI cancelled及首BK failed不变、B原名／空标签／空职责v14保持。旧88项暂存与当前90项不同如实单列；用户此前确认自己管理暂存，当前90保留，未执行stage／commit／push，不伪称index旧字节不变。电脑面板已恢复详情，人工控制结束。

证据：`1021BF-browser-handoff/1021BK-human-return/r2/H06-independent-final-verdict.json`、`independent-return-native-1792549670172.json`、`final-limited-protection.json`、实际填写预览／正式读回截图与原归还动作。正式题干／before、agent未发送备选稿及原网络／窗口绑定失败均单独保留；本项无新生产修改。

BH标签测试仅先收尾本地：旧v8标签草稿在聊天改名v9后真实CONFLICT，草稿与新名保留，一次重试仅合并标签。已通过原UI将B恢复原名、空标签／空职责v14；第一清空未生效的v13残留与后续精确恢复原件保留，不把操作误差冒充产品故障。该时点官方尚未发题，局部不计关闭；随后官方真实对照由上节BH-A08闭环。证据`1021BH-name-tag-conflict/local-partial-final-verdict.json`，无生产改动。

### 2026-10-21 中断后的新任务与明确继续闭环（1021BG-O05）

严格闭环 **92/201（45.77%，剩109例，非实现完成率）**，仅新增O05。M2.7自身BF已停止后，新轮真实只答43、零工具，旧取消任务不复活；结合既有DS B07实际读回旧进度、遵守新约束继续及官方两分支证据，原合同独立通过。不同子样本／既有模型分别验证，不称M2.7整链通过，也不把AY新RESUME当旧进度续作。18项限定核对均通过，原native／文件／记忆／资料／例行与用户88项暂存保持；原挂起call在新轮补取消ToolMessage属协议收尾，未重新浏览。证据`1021BG-o05-recovery/O05-independent-closure-review.json`及`local-independent-actual-and-protection.json`、双方实际UI，无本批生产代码或提交。

### 2026-10-21 另开页与接管目标修复通过（1021BF／BI；人工读回后由BK-R2闭环）

- [x] 首轮两次navigate复用同一页，把表单替换成预览并向错误目标请求填备注；失败保留。源码对照给定Grok `sand-browser-tools.ts:552`的`newTab`，确认本地工具入口缺失，不能只归模型。仅`browser.ts`／`tools.ts`两生产文件补可选newTab并复用原engine.createPage／归属与6／24上限；默认省略／false仍复用原页，非法action／pageId组合与危险URL先拒绝。
- [x] 69项近邻、完整node类型、四文件格式与独立source review通过。原main配置在既有物理scratch构建，仅激活application.js（SHA5baa0147…0fd7f），另393构建文件与index88保持；正常同profile重启15项原表／消息／配置等值，无重放。首份构建在最终空串pageId校验前已过期，未激活；重建最终版后才运行BI。
- [x] 未收到BF纠偏的原M2.7 A私聊实际运行自然双URL原题，正文没有newTab／targetblank提示；首轮真实两次navigate，第二次自主newTab=true，表单cd8f000b…与预览47f7fc44…同时保留，help精确指向表单。原生回执与主窗口两页选择器／正确表单预览均核对。受工具绑定独立窗口限制，未输入未知备注；原UI停止／归还控制／恢复详情后122.9秒无迟到调用，旧1998任务／6线程前缀／文件／41记忆／68资料／24例行等限定保护通过。
- [x] 反馈后通过页面现有target=_blank链接实际保留两页，request_help精确指向表单；停止后由原UI归还控制并恢复详情，未复活已取消任务。官方真实接管填未知合成备注、归还及准确读回已通过；本地电脑工具仍不能定位独立浏览器输入，不能据此宣称H06全链通过。
- [ ] H13仅实际预览／切两页通过，隐藏按需抓图／滚动／刷新整例仍待验。BF自身不增加严格闭环数。BF限定数据保护通过；index66→88为用户明确确认的手动暂存，保留88项，不擅自撤回／提交。

证据：`1021BF-browser-handoff/`的首轮／反馈记录及`new-tab-fix/implementation-ready.json`、`activation/activation-comparison.json`、`real-retest-prep/BI-final-navigation-cancel-and-protection.json`和实际UI。本次只关闭页面替换／接管目标这一子问题，不以此关闭H06／H13全例；无stage、commit或push。

### 2026-10-21 交流来源与稳定身份导航闭环（1021BE-L11）

严格闭环 **91/201（45.27%，剩110例，非实现完成率）**，仅新增L11。双方真实交流入口、作者私聊和返回原群均实际完成；独立核对稳定身份及群／pair隔离通过，没有为展示另建消息或导航体系。交流面板默认展示最新同pair历史与当前官方一致，原旧任务无回执及官方“无法刷新”现场保留，不冒称自动锚点定位或网络恢复。证据`1021BE-profile-source-prep/L11-final-independent-verdict.json`与实际UI；无生产代码、stage、commit或push。

### 2026-10-21 网页研究旧阻断续验闭环（1021BC-H01）

严格闭环 **90/201（44.78%，剩111例，非实现完成率）**。H01原合同独立复核确认，BC已真实覆盖两端可达的相同fixture、来源／三行数据／报告和正式原CSV，因此新增关闭H01，不重复发题。Mac与云实例URL不同如实保留；1020T旧公网访问失败不被改写，不声称原公网故障已恢复，也不扩算K08公开多来源研究。证据`1021BC-h09-k12-combo/H01-closure-criteria-review.json`；本项无生产代码改动。

### 2026-10-21 标题栏安全区回归闭环（1021BD-M03）

严格闭环 **89/201（44.28%，剩112例，非实现完成率）**，仅新增M03。两端真实折叠／展开／滚底及连接应用进入／返回均未遮挡macOS红黄绿；本地设置返回和官方Escape返回已实际完成。九张真实截图与AX独立核对通过，恢复双方原头像栏，未改名称／头像／标签、未新增Bot或删除数据。本批无生产代码、stage、commit或push。

M02的本地80与官方88等尺寸差异（80为用户此前要求）、M09头像菜单缺Generate／Upload仍保留，不因开关成功声称完全对齐，也不为测试新造生成体系。证据`1021BD-ui-menus-keyboard-combo/M03-final-independent-verdict.json`及双方实际UI。

### 2026-10-21 双 Bot 网页研究与独立复核组合闭环（1021BC）

严格闭环 **88/201（43.78%，剩113例，非实现完成率）**，仅新增关闭原H09／K12。本批无生产代码、stage、commit或push。

- [x] 两轮交换首发者，双方各自真实打开网页、下载和读取原CSV；本地四个实际page ID各自正确，共用原群工作目录。沿现有异步交办及回传，每轮唯一正式交付首发报告／独立复核报告／首发原CSV三件，无同伴重复附件或确认循环。两端正式下载的CSV均为64B，BOM／CRLF／SHA完全匹配，三行74.13、草稿差额+0.03及来源正确。
- [x] 保留R2原报告未经字节工具核验却声称hex相同的失败；原复核Bot收到一次限定反馈后真正执行只读Buffer比较，返回两文件64B／完整hex／identical=true，只新增1599B修订报告并唯一交付，没有重访网页、下载、提交或重附旧件。原件／原报告不改写。官方两轮真实交流及六份正式件已核；不把其公开自述冒充隐藏native回执。
- [x] 终末20项限定保护通过：原68档案／24例行／41记忆、旧任务／群消息／native／文件、group版本11、66暂存与index／源码／构建／PID保持；精确9个授权新文件和9任务，服务POST仍为原1，反馈未新增HTTP。
- [ ] 交付节奏差异仍保留：本地两轮及补验只通过文件工具公开附件，正确简短总结存在普通assistant final中，未调用公开发送工具，聊天未出现总结。不是renderer丢字；原CMB文件交付和Grok0.18附件交付均允许附件独立成功，不为此改全局完成协议。原H09／K12独立观察、字节与分工条件已满足，不宣称全部交付体验一致。

证据：`1021BC-h09-k12-combo/H09-K12-closure-review.json`、`final-protection-verdict.json`、双方正式下载与真实UI、`local-r2-actual-narrow.json`及补验记录。继续核心组合回归；BD侧栏／标题栏／弹窗另按原合同核对，不提前关闭。

### 2026-10-21 成员取消与新轮续作修复闭环（1021AY-D12）

严格闭环 **86/201（42.79%，剩115例，非实现完成率）**，仅新增关闭D12。原R1重加后模型新调用重启旧命令的失败、R2后台事实缺口及模型未遵守前台／正式交付约束均保留，不改写首轮质量。

- [x] 先核原CMB取消回执／Bot控制记录；参考给定Grok0.18 `interrupted-tool-reconstruction.ts:63`、`user-message-action-handler.ts:299`的真实中止回执与新用户轮分离。复用现有停止事实入口，将真实群用户来源接入；补充同Bot／同thread／同group的既有cancelled且suppressed后台命令事实，最多4条各240字，加原最多4条task事实。后台command状态明确不等于source task状态，原failed不伪改，无新表、索引、IPC或执行机制。
- [x] 本项累计仅4个生产文件+36/-13，174项近邻、node类型、lint／格式检查通过；独立审查无具体P1／P2。原索引`bot_commands_owner(thread_id,state)`命中；原Runtime及权限边界不变。隔离原main构建，仅替换application.js，其余393构建文件不变；最终同profile正常重启17/17持久保护通过，原66项暂存保持。
- [x] 真实运行／待答移除均先取消再确认：取消零成员变更，确认只停目标实际进程／后台命令，同伴原请求仍能真实作答；重加不重放。R2原120秒截止后run2仍starts1、无late、原PID已退出。最终版原07b双提问负例两次真实选择均只提问／发送、零execute；精确scoped query含本次取消command及failed source，不再只依赖旧停止任务。
- [x] 最终版明确授权的新15秒续作实际execute1→read_file1→bot_send_message1，原run2保持starts1／无late；新resume3唯一结果98B、15010ms。终末26项限定保护通过、全局活动任务／命令0，原名称／头像／模型／成员顺序与旧历史文件保持。

官方实屏的取消／移除／重加／同伴作答和新任务均已对照；其移除后本次长程序仍出现正常完成的公开结果，隐藏进程／取消回执不可读，不推断内部状态，也不要求本地复制较弱行为。extraSystemPrompt不持久化为native SystemMessage，实际证据使用已验构建、真实任务同scope查询、adapter实参测试与行为，不伪造原始System trace。证据`1021AY-group-membership-prep/r3-background-fact-verification/final-actual-readonly.json`、`negative-actual-narrow.json`、实际UI及`stopped-task-scope-fix/background-command-facts/`的实现／索引／构建／重启审计。无stage／commit／push。

### 2026-10-21 稳定成员身份整例闭环（1021AY-D07）

严格闭环 **85/201（42.29%，剩116例，非实现完成率）**，仅新增关闭D07：同名时旧B原子仍只给B，新选A只给A，改名后历史提及仍打开原身份；未知／群外姓名不产生候选，正文原始@字符串不变成收件人，离群旧原子明确提示并禁发、零转投。原名称／头像／模型与成员次序已恢复，未新增生产身份机制。

官方同名现场出现两条回复，离群旧原子仍可发送后显示“已停止，未回复”，未观察到明确拒绝提示；如实保留，不推测隐藏根因，也不复制较弱行为。D12的取消后续作缺陷仍独立开放，正以原私聊已有停止事实接线做窄修复及真实正反例。证据`1021AY-group-membership-prep/D07-final-independent-verdict.json`，10项内部断言只计原一例。

### 2026-10-21 浏览器四项组合闭环与成员回归（1021AZ／AY）

严格闭环 **84/201（41.79%，剩117例，非实现完成率）**，本批新增关闭P0 H03／H04／H05／K11，未关闭D12。

- [x] 原M2.7私聊执行新AZ任务，真实浏览器识别file input、下载64B CSV、上传同一原件、填写合成值；明确确认前POST=0，确认后唯一POST=1且accepted=true，title／nonce／三行74.13及+0.03正确。原CSV含BOM／CRLF，上传字节、正式交付及原Save下载完全一致；391B回执与服务端原件一致，681B报告三件均从实际卡打开／保存。
- [x] 模型首轮漏做“写后读回”，保留失败事实；反馈后唯一read_file实际读回全部37行核实，未重提交、下载、修改或交付。原48文件／392条原生前缀／profile与记忆保持；复用此前官方同合同真实三件交付及独立服务证据，不重复官方任务。旧AN取消不改写，H06接管仍未验。
- [ ] AY成员回归发现真实续作错误，D12不通过：原A前台命令在移除后确已取消，原截止后start1／无late；重新加入后，新“仅提问”轮却由模型新execute调用再次启动旧命令，start变2并产生late。不是同tool ID自动重放。正复核群新轮缺少现有停止任务事实的接线；本地同名／改名稳定路由、无效离群提及禁发与待答移除局部成功不抵消该失败，暂不新增D07／D12关闭数。

证据：`1021AZ-browser-fourcase-prep/final-four-case-verdict.json`、`product-downloads/`、真实预览与原生保存、首轮及读回补验；AY失败与阶段证据保留于`1021AY-group-membership-prep/`。本批AZ未改生产代码；AY修复另按最小范围实施。无stage／commit／push。

### 2026-10-21 群输入布局与长问题批量闭环（1021AX）

严格闭环 **80/201（39.80%，剩121例，非实现完成率）**，本批仅新增关闭B09／C12／M06。下一批优先执行P0 D07／D12的成员身份与移除流程。

- [x] 空白／文字／仅附件／清空四态实际对照；空白不再多出发送箭头，原发送、附件、提及及停止接线保持。多行与软换行展开后，文本位于底部按钮上方；缩短不反复折叠，清空恢复。详情开关时消息、状态与输入框共用内容边界。
- [x] 双方真实长问题和五项说明在窄窗可读，修正后的双向Tab、可见焦点、Escape及返回输入均已操作。真实选择E后，本地同一请求提交optionIndex=4、唯一公开短回复，无同伴任务或重放；官方也正确保留已答E及唯一回复。
- [x] 先核原群编辑器及Grok当前0.72的换行／高度测量和展开保留行为，仅改三个Bot界面文件，复用原控件。47项近邻测试、web类型、实际renderer构建及应用内复验通过；旧lint问题保留，不称全量lint通过。首次构建误用`--filter`已恢复全部非renderer字节，后用原renderer配置隔离构建；原main、139个非renderer文件及66项暂存保持。

边界：MiniMax把指定241字题干缩为161字，属于提示遵循差异，未算逐字模板交付通过；本例关闭的是原C12界面可用性条件。本地最小窗口更宽、缺语音入口、等待状态与停止行、整体间距字体及动画差异仍保留；M10悬停tips证据不足，不关闭。独立原合同结论及实际UI见`coverage-batch-map-1021/C12-B09-M06-M10/C12-B09-M06-final-independent-verdict.json`，29项回执保护检查不另计案例。无stage／commit／push。

### 2026-10-21 技能不可用后的普通交付闭环（1021AR-J02）

严格闭环 **77/201（38.31%，剩124例，非实现完成率）**，仅新增关闭J02。用户已明确确认删除官方自产私有技能`ar-synthetic-ledger-1021`，由真实编辑页／确认弹窗完成；原Outlook／Origin仍在。本地合成技能保留并启用。

- [x] 官方真实卸载后，同冻结正文和64B当前CSV实际完成普通任务；明确说明技能不可用、未调用／未重装，唯一718B正式报告已打开并下载。独立核对三行原值、退款、74.13及原始来源文件名／完整SHA正确。
- [x] 与此前本地未选401B、禁用后诚实拒绝并普通交付220B、恢复启用，以及官方未选433B原证据合并核原J02合同；本地原技能／插件配置哈希保持。J01／J03的其他入口条件不随本项关闭。

证据：`1021AR-skill-office/j02-uninstall-qa/independent-verdict.json`、实际删除前后列表／正式报告UI及`official-unavailable-downloads/unavailable-report.md`。没有新增生产修改、stage／commit／push。

### 2026-10-21 群引用、唯一收件人与当前附件组合验收（1021AW）

严格闭环 **76/201（37.81%，剩125例，非实现完成率）**，本批仅关闭回归表D10。沿原群、真实回复入口和原子提及，不新增生产代码。

- [x] 两端引用旧成员消息、仅选另一成员并上传同一64B CSV，各唯一公开JSON；引用原文分别为真实旧消息，三行原始id／币种／两位金额及74.13精确一致。本地唯一MM直达任务，未选中的引用作者和其他成员零新增任务。
- [x] 原入站链已把本次授权附件完整内容放入实际Human，实际只有一次`bot_send_message`、没有`read_file`；不虚报额外读工具。当前附件、引用身份、原生请求与公开结果已独立绑定核对。
- [x] 原任务／群消息／68档案／24例行／41记忆／旧文件、C草稿相关原生记录与AN等待保持，66项暂存和index未变。1020AA旧分工失败仍保留，不把本题当作复杂双Bot分工质量全部通过。

证据：`quality-review/1020W-source-audit/1021AW-quoted-recipient-files/`的冻结合同、双方实际UI、`local-current-attachment-transport-audit.json`、`local-protection-audit.json`及`independent-verdict.json`。只计一例，不把内部审计断言充当额外覆盖。

### 2026-10-21 流式会话往返真实回归（1021AV，本地通过，官方时序未捕齐）

按P0 B11原合同，沿现有会话与72行冻结中文纯文本，先读原ThreadContext／stream consumer、给定Grok0.18与当前官方0.72的transcript呈现；不为测试新造流状态或预先改代码。严格覆盖仍 **75/201（37.31%，剩126，非实现完成率）**，B11只记部分，未额外关闭L09／N04。

- [x] ~~本地M2.7真实流式切走再返回。~~唯一task`8231bf76…`／request`79a7a3cf…`，先见001，切到原DSB空草稿再返MM时仍有“正在处理／停止生成”及009正文，真实返还时间比completed早9792ms；最终唯一assistant零工具、72行逐字／顺序／首中尾marker各一次，无缺号／重复。原生AX单text有截断，不据此误判正文丢失；真实截图及完成后再往返均可见057–072与完整END。`local-return-live.jpg`实际已是终态，文件名不冒充进行中截图，进行中证据用真实AX与时间。
- [ ] **官方运行中返还证据仍缺，整例不关闭。**R1同冻结prompt完成，但root未在中间切会话，是操作时序miss。唯一有界R2首个“正在工作”切到原合成同事B，B空草稿且GB仍工作中已证；第一次所谓returned仍是B，仅焦点在GB按钮，不能当已导航。随后Space激活才回GB，届时已回复，故保留第二次时序miss并停止继续重试。后续从真实“1条新消息”跳到本次新回复、再滚底，R2最新尾057–072／END可见；初次final截图其实在旧R1尾部，不拿它证明新回复。源码只证明客户端消费entry／streaming，不能从isStreaming推断私聊工具参数一定公开或一律成功后才公开，未强加本地先见BEGIN的触发规则。
- [x] ~~本地原生及数据保护独立复核。~~原68档案／24例行／41记忆／MM46和B26旧文件／C21与B135旧native、1962旧task行hash保持；仅本题1个completed root及MM2条native，MM activity／revision正常更新。12表schema及其他业务表保持，AN仍原唯一waiting；索引及66暂存不变，无源码／build／stage／commit／push。审计脚本首两次键名与复合键取样错误保留为测试脚本错误，没有归为产品或模型失败。

证据：`quality-review/1020W-source-audit/1021AV-streaming-switch/`的`contract-manifest.json`、`source-preflight.json`、`official-retry-preflight.json`、真实UI／timeline、`local-final-native-audit.json`、`local-final-protection-audit.json`及`independent-verdict.json`。独立结论PARTIAL，官方不可观测的完整原生数据／调用次数不作推断；没有把两次人工发题产生的两条官方回复误算为系统重复执行。

### 2026-10-21 Bot成果Office语义预览补齐（1021AU，代码、构建与应用内门禁已验）

**末次进展：应用内真实预览／原件保存门禁已完成，当前严格77/201；下方75为激活前阶段记录。** 具体实屏、原工作台近邻、保护和剩余Office交互边界见末项，未因此额外关闭201案例。

先前真实差距已确认：官方0.72 DOCX展示标题／段落／表格，XLSX可切三张sheet；本地DOCX仍为binary回退。沿原FileViewer的adapter接线，仅Bot成果弹窗显式启用，原工作台默认路由／附件提取／PDF／JSON不变；不新增IPC通道、预览worker、存储、公式引擎或文档转换进程。源码与独立复核在AR的`office-preview-{source-review,implementation-checklist,independent-plan-review,budget-readonly-probe}.json`；已读适用renderer／IPC规则。预计生产280–441行，实际diff另审，不能把估算当实际改动。

严格闭环当前 **75/201（37.31%对照回归覆盖率，剩126例，非实现完成率）**，AS独立复核及导航补验后仅新增J06／J07。AU界面／运行接线未完成前不增加通过数。AT重试原人工接管已核同task／244条native／A文件／原服务与POST0保持，工具仍只绑定主窗口；现场及12项有界保护在`1021AN-browser-common-flow/resume-1021AT/`，不重发或提前归还。

- [x] ~~在原shared请求／结果加可选Office展示参数／typed payload，原IPC仅校验并透传，经原client／protocol／worker的read-text分支，保留原授权、lane／token取消、错误与句柄释放。普通调用省略参数仍走原路径。~~近邻授权／无参数路由测试及实际构建worker普通文本读取均通过；尚不代表应用内IPC入口已验。
- [x] ~~reader复用`readStableFileHandleBounded`，仅显式Office分支动态导入小纯解析helper；仅export并复用原`assertBoundedOfficeArchive`。~~保持5MiB原件／4096条目／32MiB单项／64MiB总解压声明／worker128MiB；实际同一构建worker的原128／16／4资源限额未变。metadata guard不等于完整CPU／内存防护，取消已发请求后恢复读取通过，不声称同步解析可硬取消。
- [x] ~~DOCX用已有mammoth语义HTML，按白名单投影为React；XLSX用已有xlsx限定解析行、sheet和显示范围，沿现有Tabs展示格式化值。~~图片转换不调用图片read方法、不生成Base64；真实DOM反例无资源／脚本节点、事件属性及六种trap请求。无缓存公式诚实显示原公式／未计算，不自行计算或写回；官方本批实屏汇总金额为空白，不加隐藏重算要求。
- [x] ~~仅BotMessageFilePreview传入懒加载展示adapter；FileViewer复用原loading／textPage／generation，Office绕过只按contentBytes计量的普通文本缓存，结构化输出单独限64KiB；限制状态可见、保留原Save接线。~~当前正式件远低预算；独立diff复核普通工作台没有Office adapter时仍原路。原Save实际UI字节复验保留在下一条，不因接线存在提前关闭。
- [x] ~~正反例及代码构建门禁。~~76项近邻、6份原正式件源码读取测试、node／web类型及无新增lint告警通过；隔离原配置完整build真实exit0。实际构建worker再读5正式DOCX／XLSX，3表／3sheet／金额／末标记／4原未缓存公式正确，五原件hash不变；同worker普通57B文本、已发请求取消回执及下一读取通过。真实浏览器原组件的DOCX滚到末尾、鼠标切表／Right切口径、换文件回明细、恶意HTML资源隔离均通过。这些不替代应用IPC／成果弹窗／保存实屏验收。
- [x] ~~同profile正常激活并完成两类实际Office预览与原格式近邻复验。~~从原资料库打开同一正式成果，DOCX标题／中文／三表、真实下滚末标记；XLSX鼠标切汇总／Right切口径及末标记均可用，四无缓存公式显示未计算。原Save实际下载39056B／8467B，与冻结正式件逐字节同；Bot原PDF仍走内置三页阅读器，原Markdown表格与688182B JSON树可读，原工作台Markdown原预览／源码往返保持。此处只认这些实际入口，不扩称原工作台全部格式或完整Office编辑体验通过。双方C原引用＋两行未发草稿实屏保持。
  - AN首次保持等待的记录不改写；1021AW后为避免自有合成接管阻碍其他高优先级验收，先保全原任务／245条native／未提交POST0，经原私聊停止按钮实际取消，再正常Quit。原工作台实屏任务0／空输入及持久194线程idle已核；未冒称读取main内存队列。AN接管后半程仍未完成、不计通过，未提交表单的临时页面随正常退出放弃。旧out398文件完整外部备份，已验394文件构建逐字节整体替换，原profile／renderer来源／1930源码／index66保持。新main49973；重启前后12表、档案／例行／记忆／文件／选定native精确等值，无新增任务或重放。

实际AU相对实施前为11个生产文件 **+460／-13**，独立审阅未发现确定P1／P2；暂存66项及index未变。隔离构建先因资源目录符号链接、再因Vite解析源码链接到隔离root之外失败，原日志保留；只把自有scratch的skills／resources／src改成逐字节相同的物理副本，原配置／生产源码无为构建绕路的修改。第三轮完整构建通过，原运行out的398文件及哈希完全保持。原12控制表、68档案／24例行／41记忆／C21、MM46／B26旧文件、AN完整等待任务与244条native／POST0及两原进程保持。临时组件页已关闭、HTTPfixture仅停本轮PID90469。

证据：`1021AR-skill-office/1021AU-office-preview/`的实施／构建／worker／组件门禁，以及`product-ui-artifact-independent-audit.json`、实际product截图／AX／下载和`original-workbench-md-*-ui.txt`；重启见AT的`activation-before-after-verdict.json`。组件验收页未提供原字体资源，不据其截图判定像素／字体对齐；行列标头、单元格选择／范围复制／单元格键盘导航仍未实现。本项应用内展示与保存门禁已完成，严格201覆盖仍77，不凭此新增或宣称整个Office体验／原工作台完整回归通过。无stage／commit／push。

### 2026-10-21 现有连接器核心批量回归（1021AS，本地批次已完成，官方入口受限）

沿原 MCP 设置与现有 BR／CB 合成 fixture 复验 J04／J05，不新增连接器执行体系。实际发题前已保全12表／68档案／24例行／41记忆／C21／MM46旧文件／B26旧文件、AN原等待、原Bot任务与选定MM／B／C原生消息及暂存66项；两原连接器和fallback插件均disabled、旧日志前缀及配置哈希完整。证据目录`1021AR-skill-office/1021AS-connector/`，严格覆盖暂仍73/201。

- [x] ~~已有BR连接器lazy发现、业务错误与恢复。~~M2.7唯一root`989555af…`实际search两工具→inspect→invoke三次，三nonce各一次且严格按序，真实PID39176返回3行／分值[1250,-325,8]／9.33 CNY、原预设业务错误、再次9.33；无文件／命令／记忆／例行或其他连接器动作。六工具与服务日志相互对应，24项有界保护核对通过，见`first-task-final-native-and-protection-audit.json`。
- [x] ~~Bot范围拒绝与原工作台能力复验。~~首轮`be7c2886…`只search／inspect就称通过，漏做两次实际invoke，原记录不计通过。一次有界反馈`5a902313…`只补两次invoke，各ID／nonce一次均真实`Tool not found`，BR／aa服务没有负例业务事件。原工作台旧空草稿thread`b121ebf5…`仍选M2.7，真实search→inspect→invoke一次browser_audit，准确原nonce／PID43312／actualBrowserAccess=false；不控制真实浏览器。25项有界保护通过；原工作台缺少本题发出前专门行哈希，只冻结事后16行，不冒称已证明其全部旧前缀等值。见`scope-workbench-final-native-and-protection-audit.json`。
- [x] ~~现有CB loopback及safe／unsafe／业务错误三分支。~~root`31ef1919…`真实主服务40407分别一条safe503／unsafe503／business-error，BR50385仅safe备用一次，另外两nonce无备用，回执按同tool_call_id及原fallback正文匹配。原safeToRetry true／false与禁止身份Header注入保持。首轮先误用桥调用3次，被“already directly callable”在服务前拒绝，随后按原指引真实直接调用各一次；多余桥错误保留，不称全过程无差错，也不误算重复业务调用。28项有界核对通过，见`fallback-first-native-and-protection-audit.json`。
- [ ] **官方等价实际调用仍缺入口条件**：当前0.72私人Bot市场及“你的插件”实屏没有自定义入口。源码真实Action仅在非群、team可见、owner、temporal身份及multiplayer／custom gates满足时挂载；HTTP／stdio parser支持不能代替这些条件。本批未猜测账号gate值、未改实验配置、未使用现有Outlook／Origin真实连接器或建公网隧道。官方J04／J05等价调用未取得，本地通过不关闭整例。见`official-custom-entry-source-preflight.json`及两份官方原生市场／已安装UI。
- [x] ~~原UI恢复及独立收尾核对。~~两连接器原disabled／args／node／lazy精确恢复，插件disabled且完整.mcp.json回原哈希`4e6470…`；正常UI updatedAt变化单列，不由宿主改时间伪造整配置字节等值。6个实际启动PID均各有一条exit、全部消失，无本题fixture进程，49470实际拒绝连接；loopback40407经完整command校验仅SIGTERM该合成进程，原exec session81206已exit0。截止04:06:50.300，28项有界收尾核对通过，主60635／AN完整行与等待、MM46／B26／68／24／41／C21、旧Bot任务／选定原生消息／暂存66项保持，恢复期间无新task／native重放。源码只对有before的2份文件哈希及当前既有diff核查，不冒称全工作树无差异。见`restoration-final-independent-audit.json`。
- [x] ~~J07遗留的设置返回箭头精确补验，74→75/201。~~原UI本轮两行自有草稿下，实际截图后指针[62,124]只点左箭头，另[177,124]点文字区域，再次按Escape，三次均回同MM／原草稿；输入框可重新聚焦。官方当前0.72从原“连接应用”关闭及Escape也回同Bot／原草稿。两端只清本轮自有输入，最后均空草稿，本地初次Cmd+A／BackSpace未清完整的中间现场保留，经原setValue空值才确认成功，未发送测试消息。17项有界UI／原配置／任务／native／文件／AN与暂存保护通过，未改设置值或生产路由；见`J07-pointer-and-return-final-verdict.json`及箭头实屏。此项不扩大为新Office界面已验。

**J06独立判据复核后关闭，73→74/201**：本例是本地Bot不能绕回原共享工作台MCP、普通合法能力保持的自有范围契约。源与当前实际bundle均确认capabilityID及alias进入同一合法resolve映射，排除“仅因非法ID拒绝”的假阳性；新两次真实capabilityID拒绝／服务0事件、同provider普通工作台真实alias成功，及旧1018BR MM／DS同alias正反例共同充分。官方没有同一CMB共享目标，按原测试第2节自有契约审，不强造官方同错误路径，也不由此关闭J04／J05或声称所有浏览器隔离已验。首轮漏invoke与工作台无专门before哈希的边界保留，见`J06-closure-criteria-review.json`。

AS无生产代码、stage、commit或push；J04／J05标为部分。Office预览方案另已源审与独立审查：复用原授权readFilePreview／稳定句柄／同worker，Bot adapter显式启用、普通工作台默认不变；仅Office分支动态导入原ZIP guard和既有mammoth／xlsx。当前真文件结构化输出远低64KiB，不提高worker128MiB；无缓存公式不伪造数值或另建引擎。官方真实汇总预览也为空白，实际截图／AX与独立重算产物检查分开。精确文件、正反例及估算280–441行见`office-preview-implementation-checklist.json`／`office-preview-independent-plan-review.json`，后续AU实施单独记录。

### 2026-10-21 技能与离线文档表格批量验收（1021AR，在验）

本批新增关闭K09／K10，严格闭环71→ **73/201（36.32%对照回归覆盖率，剩128例，非实现完成率）**。J01／J02／J03继续按原合同判，K16有明确未完成步骤，不因一次组合修订而额外计通过。首轮质量及离线边界失败保留。

- [x] ~~沿原生技能入口建立同一合成技能。~~本地原SkillsPanel实际上传纯文本`ar-synthetic-ledger-1021`，落盘真实1048B SKILL.md并启用，原两个内置技能保持；官方经原生私有技能功能保存，真实打开设置条目核名称／说明／6条正文相同，未发布。发题前68档案／24例行／41记忆、MM15／B26旧文件、C私聊及AN等待均保全。普通md附件不冒充技能，不新增Bot技能存储／执行器。
- [ ] **J01／J03组合实测**：在本批自有草稿／64B CSV附件上搜索、选择、取消及Escape，核草稿／附件保持，再实际选择技能发冻结报告任务；真实激活与原件读回、三个模板章节、74.13／退款-7.20及末行marker／正式附件通过才勾选。Grok手工技能会内联正文，不强制两端均额外read_file。
  - **本地首题及取消保持通过，官方入口仍待验**：实际`/ar`搜索、Escape关闭、精确搜索后Enter选中，再填写本批两行自有草稿；点击移除技能后正文及64B CSV附件保持。重新选择真实技能发题，唯一root`6f356de3…`completed，首工具实际读取所选SKILL.md，后读取本次原CSV。806B报告按分7413／74.13、3条ID／退款／3章节／末行marker正确，write及正式deliver各一次，已从正式卡打开并保存。26项原生及保护核对仅证明本地本题，不等同201例新增26项。截止内旧MM15／B26、68档案／24例行／41记忆／C21及旧任务／native不变，AN保持唯一waiting，暂存66项不变。
  - **当前官方0.72实屏与源码边界**：已保存的真实私有技能可在设置打开，但`/`暂未出现候选，`@ar`显示无匹配。只读核当前安装版prompt-editor：普通技能走`/`且受`sand_hide_slash_commands`开关控制，`@`只将含trigger的例行加入候选；当前开关值未知，不猜成已启用，也不按旧0.18强加Bot关联或绕过原UI。不把模型此前“输入/或@即可”当验收事实，J01／J03整体仍开放；先并行运行独立Office同题。
- [ ] **J02未选与不可用变体**：沿原生取消／禁用复验，普通任务仍可交付，不能虚报调用未选／不可用技能。永久删除需另有明确授权，仅验证取消不算全部变体；优先使用本轮合成技能的可恢复禁用入口。
  - **本地未选／禁用均实测通过，官方未选已通过**：本地未选root`4f153425…`仅真实读本次CSV→写401B报告→唯一交付，无trusted marker或技能读取；官方433B普通报告也已正式保存，三行／74.13／原始文件名／合成说明正确，无技能footer。随后仅在原Settings把本轮合成技能禁用，`/ar-synthetic`实屏无候选；本地真实read技能被原guard返回`skill is disabled`，模型如实说明不可调用，继续读当前CSV／写220B普通报告／唯一交付，无额外动作。两root均completed，正式下载／旧文件／档案／例行／记忆／native保护17项及恢复后14项核对通过，不扩大为201新增31例。
  - 验后经原UI恢复合成技能enabled、实际重见候选，Escape后MM空草稿，2内置不动。`disabled-skills.json`由原不存在变为原UI持久化的2B`[]`，只称恢复启用语义，不伪装配置原字节完全等值。官方0.72该私有技能设置只见删除入口，卸载负例尚未执行；已按电脑工具永久删除须单独确认的要求询问，仅拟删除本轮`ar-synthetic-ledger-1021`，名称／全文已备份，未获确认不删除。J02保持部分，不以本地禁用冒称官方卸载通过。证据`j02-unselected-disabled-native-and-protection-audit.json`、`j02-final-restored-independent-addendum.json`及两端正式报告／真实UI。
- [x] ~~K09／K10同份数据最终真实交付。~~仅新`ar-1021/office/`及修订子目录产生至少3页中文DOCX与PDF、含3sheet真实公式／图表XLSX，正式UI逐件保存；独立渲染每页、核中文／页码／表格／来源及末尾marker，公式在内存副本改输入后真实重算，原件哈希保持。原冻结题只有74.13与退款-7.20，没有草稿74.10，不添加差额0.03隐藏要求。首轮失败与修订分开，不以格式有效、缓存数值或模型自述当通过。
  - **首轮正式3件均已保存，M2.7失败、反馈修订中**：本地root`0626ad5a…`实际生成／自修3版DOCX及3次PDF导出后唯一deliver3件。独立逐页看正式PDF3页中文消失／方框，两报告没有页码域／可见页码，DOCX正数小计写81.25而应81.33，却公开声称中文可读／页码连续。XLSX净额与退款真实公式重算74.13／-7.20及两项输入变化均正确，但明细／汇总为General，退款显示-7.2；图表引用汇总B4:B7四项重叠指标，不是实际三笔明细。不能把这误报为公式硬编码或重算引擎故障。首轮12文件／88条native／50次工具及正式下载均已冻结，真实反馈要求仅新`office/revised/`完整修订3件，原件保持，尚未判修好。
  - **额外明确违反离线／环境边界**：模型首轮自行执行两次pip联网，第二次从HTTP镜像实际安装openpyxl3.1.5及et_xmlfile2.0.0到系统Python3.12的site-packages；不能写成仅复用既有库。15项既有受控数据保护通过不等于全局环境未变。安装元数据／落点已只读保全，未静默卸载或删除；反馈已禁止继续安装／联网及自行清理。此项失败独立保留，不据文件修订成功抹去；当前无本批产品源码修改。
  - **官方首轮3件独立通过**：正式DOCX/PDF各3页，逐页核中文／表格／连续页码1–3／来源／74.13／退款／marker；DOCX默认bundled LO渲染中文空白是验收环境字体配置，一次仅证据目录fontconfig引用现有系统CJK字体重渲染后正确，原件不改、坏图保留。官方正式PDF本身始终可读，与本地坏PDF分开。XLSX真实SUM／SUMIF及明细C2:C4柱图，原版与两内存副本重算／图表向量正确，三sheet已逐张看、两位小数及标记正确；双方正式原件SHA不变。没有由宿主修补模型成果。
  - **修订后两例关闭，K16不扩大勾选**：真实反馈root`d61d5a85…`及一次字体事实补充`a94f49b9…`沿原steering注入同链，唯一正式交付新3件。39056B DOCX／153559B PDF各3页均已独立逐页实看，中文／连续页码1–3／表格／来源／合成说明／81.33／-7.20／74.13／末marker正确；模型关于部分缺字的猜测与实际图不符，不据其猜测人为判失败。8467B XLSX金额0.00、真实SUM／SUMIF和明细C2:C4柱图，独立两内存副本重算75.13／-7.20及73.13／-8.20，图源同步；三sheet实看通过。19项旧数据保护及正式件字节一致，原首轮12件保持；K09／K10据最终产物原合同关闭，首轮仍明显弱于官方。K16要求的旧件／脚本再读及模型实际逐页渲染检查未执行，宿主验收不冒称模型完成，K16只记部分。见`K09-K10-K16-closure-criteria-review.json`及两套`local-revised-*-qa/`。
  - **遗留扫描与依赖副作用收尾**：原全盘字体扫描在补充到来时被原Runtime移交后台，同一个进程没有重启；两root已完成仍不能当命令结束。只读查原PID／PGID后，root实际点MM原停止按钮，command`41ce30ad…`变cancelled／suppressed=1、PGID72512成员0、MM活动0，AN原waiting不动。随后只对四个已核实本轮新建的包目录做同盘os.rename可逆隔离，401文件hash全部保持、原四路径不存在；未pip卸载、未删除旧包，备份可恢复。独立复核系统Python3.12只用find_spec确认两模块均不再可发现，401文件字节／时间元数据保持、主进程及AN原tuple不变。只恢复这两项依赖的原搜索路径，不声称撤销全部pip缓存或联网历史；首轮违规事实保持。证据`office-revised-background-command-settlement-readonly.json`、`dependency-quarantine-action.json`、`dependency-quarantine-independent-verification.json`及原安装before／RECORD／创建时间／独立预审。
- [ ] **本批另确认的Office应用内预览差距**：官方0.72真实DOCX预览有标题／段落／完整表格，XLSX有明细／汇总／口径页签及格式化单元格；本地DOCX实际仅“二进制格式不支持应用内预览”，XLSX沿同一fallback。独立QA渲染不替代应用内功能，不据K09／K10成果通过宣称界面已对齐。先核原FileViewer授权媒体读取及已有mammoth／xlsx，收敛只读预览最小方案；不新增执行、存储或另造附件权限，不把原纯文本extract误称保留标题／表格。此发现纳入plan，201例分母不擅自变化。

复用位置：原CMB `SkillsPanel.tsx:358–460`／`standard-thread-turn.ts:548–576`／`skill-use-block.ts:118–147`，Bot adapter沿原`allowTrustedTransportSkillMarker`且仅真实user来源；Grok给定0.18 `context-processing-manual-skills.ts:14–49`／`sand-state-tool.ts:138–145,258–268`作技能协议参考，当前官方0.72按实屏。核产物使用documents／pdf／spreadsheets技能的只读结构、独立渲染与重算流程；模型原成果不由宿主代做或修补。准备材料保留在AQ/next-batch-prep，实际过程及保护记录另存`quality-review/1020W-source-audit/1021AR-skill-office/`。未运行项不勾选，无本批生产代码／提交／push。

### 2026-10-21 文件输出边界与例行生命周期（1021AQ，在验）

本批优先P05、I02、I03、I04。P05新增关闭、F12新反例重开后为70；随后补齐官方三种例行的真实恢复／暂停开关及按原合同复核，I02新增关闭，严格闭环现 **71/201（35.32%对照回归覆盖率，剩130例，非实现完成率）**。旧成功／失败及阶段判断均保留，I03／I04真实到期对照和F12仍在验，不以准备稿、保存回执或静态检查提前勾选。

- [x] ~~P05本题输出目录与失败日志边界。~~发题前冻结MM/B完整旧文件、12控制表及68档案／19例行／40记忆／C私聊／AN等待状态。真实M2.7任务`d12f592b…`只在新`aq-1021/`创建5件，一次真实ENOENT／Node exit7，双日志读回、缺失文件确认，报告及stderr各正式交付一次。外层shell追加echo为exit0，与Node的7分开；原MM10/B26及既有数据保持。官方原题两份正式下载与本地字节相同，但无完整before的首轮不追补；新R2真实先运行并正式保存before、核验后才发新目录题、再保存after。169普通文件hash／大小／mtime及2链接前后一致，固定排除两目录、完整扫描无错误；R2正式165B五字段报告exit7与32B日志正确。官方次数／OS退出仅为公开说明和报告字段，不冒称取得隐藏工具回执或全Mac／云端全局文件保护。初次上传程序路径MODULE_NOT_FOUND及随后明确授权单个合成审计输入CopyToBox的过程保留，非P05越界输出。证据`P05-final-independent-verdict.json`及`official-p05-r2/`。
- [x] ~~I02三种配置生命周期与用户可见状态。~~本地3条真实同ID创建／编辑／恢复／暂停共12次save，原19条保持、无误触发，实际next正确。首轮UTC时钟误标上海的报告为失败，后续仅一次只读list修正成正确+08时间及完整ID，22条配置逐字不改，未改原调度。官方真实创建／禁用3条组件、详情实见日10:17／周二10:22／每10分钟均暂停；root随后逐条真实UI恢复→on→暂停→off，共6次状态变化，原三种配置保持。按原I02创建／编辑／恢复／暂停、next正确、无重复／误触合同，结合本地完整原生证据及官方公开next与真实配置／开关对照，可以关闭；不能额外要求取得官方隐藏数据库才能验证可见功能。官方中间逐次save／raw ID／next未直接取得，不声称两端隐藏执行链一致；原阶段严格审计保持。官方间隔flexible±2分钟差异保留，不改变本地调度，不把一次任务替代三种配置。证据`I02-closure-criteria-review.json`、原`I02-final-independent-verdict.json`及6份`official-i02-*-actual-*ui.txt`；不由此关闭I03／I04。
- [x] **I03／I04真实定时来源及静默、变化、异常（后由BL闭环；以下为原阶段记录）**：在P05新watch文件上，分别真实到期核无变化静默、授权版本变化后通知、坏JSON异常后通知；每次读取当前原件、按分计算，不以手动执行或改时钟代替。绝对时间临发送前按真实clock实例化另存，冻结模板不覆盖。v1准备稿额外要求一次任务必须保留同ID，超出原I03/I04合同，已保留并改用v2原生生命周期：可更新就复用原条，原生完成移除则正常新建下次并如实记录ID，禁止同时重复有效任务；I02本来的同ID编辑标准不变。两次不能代替I04异常分支。
  - **本地三分支实际通过，未等同官方对齐**：02:15:30原生来源`8016c069…`真实读146B v1后严格静默（16项）；02:22:30`db7749e7…`读v2报74.14／+0.01（19项）；02:29:00`ea866aef…`读42B坏JSON诚实报解析异常（22项），无修复／假金额／额外交付。每条自然禁用，原22行保持。第二次模型忽略仍存在的旧ID而新建下一条，原条禁用且唯一有效，提示遵循失败保留；第三次明确当前ID后正确同ID复用。准备坏JSON时write_file拒覆盖，模型仅对授权原件printf写入并读回，恢复链保留，不称零错误。
  - **官方到期证据仍不足，历史与后续说明并存**：02:26一次条`aq-1021-4`实际显示“仅一次／启用”，到期后无新消息不能证明静默成功；02:29只读查询公开返回`never run`、仍启用。root仅暂停该合成条，原三条仍暂停，未手动补运行、重排或删除。随后界面出现该条“已删除”事件，02:53创建技能的公开回复另自述已按时读v1／74.13后静默并删除；这与此前状态说明不同，两个现场均保留。未直接取得原始实际读回或执行回执，不推断隐藏调度原因，不据后述自述抹掉旧失败或关闭I03／I04；变化／异常官方分支仍未实测。
- [ ] **F12新增真实自动记忆污染反例，重开**：旧1020H临时nonce及38文件不变的成功记录保持。本批新969B `9d77756d…`记忆只记录AQ一次任务ID／时间／启用状态与执行指令，18:20:34创建，早于18:25坏JSON用户任务；该配置轮只有list/save，无remember。主日志18:20:11同MM线程开始memory_summarize，源码成功user总结→提案→独立模型审核→applySummary与内容／时间高度吻合；未取得两次原始模型响应，不声称完整因果日志。原40件保持，集合新增1件，不能再写本批始终40。F12不因原成功继续勾选；新件保留、不擅自删。原CMB及Bot已有排除临时内容的规则，Grok也用模型提案／复核，未找到可直接复用的确定性语义过滤；本轮不盲加同义提示、关键字拦截或新状态体系。归因及最小方案继续核实；较早P05终态截止不受此后写入影响。
  - [ ] **先验证现有语义边界的最小候选**：沿原`summaryDirectory`／`summarizeAndSave`／独立verification，冻结真实配置轮的USER＋ASSISTANT及已存临时事实；历史提案原文未知，重建待审核operation明确标注。只比较现有规则与“例行定义／ID／触发时间／启停状态属于调度器状态，未来一次执行不等于长期项目背景”的具体化说明。混合消息里的独立长期偏好仍须通过，显式不保存须拒绝。使用已有安全模型接入在外部临时目录验证MiniMax／DeepSeek，记录原版与候选真实响应，失败原件保留；没有证明改善就不保留生产修改。
    - 首轮真实A/B：MM原AQ均实际2调用、审核approved并保留一次任务，追加说明B失败，未进生产。DS三场景A/B均正确拒临时／显式不存，只保留混合长期偏好；负例仅提取器1调用便返回空，不虚称经过第二审核。DS对照未证明B必要；Vitest管线passed只说明实际调用／隔离成功，语义判定按真实operation另核。只再验证一个接线假设：`summarizer.ts:418–425`当前把可信Bot scopeHint置于Human资料消息，generic system又鼓励项目事件／deadline；外部C将可信Bot规则放System验证优先级，不能据假设先改源码或把C成功写成历史因果证明。未来若有效须显式仅Bot启用、普通工作台默认消息保持，若无效停止堆提示。
    - **A/B/C有界验证已结束，未修复，不进入生产**：12条真实A/B链共18次模型调用；MM原AQ的A／B各2调用且误保留状态，混合偏好／显式不存均正常，DS原版及B三类正常。额外C真实MM 19.183秒、2调用、审核approved仍误保留一次任务，优先级候选也无效。两种候选都只在仓库外重放，生产源码零修改。按用户优先全量回归、不在小概率细节持续消耗的要求，保留F12真实失败及可复现材料，停止增加同义规则／分类器／抽样；继续独立高优先级批量。不能据DS通过或假模型测试绿把F12重关，也不宣称所有类似情况均完全归因模型。证据`f12-fix-prep/replay/{AB-real-pipeline-summary.json,mm-real-aq-c/}`及原native／归因记录。
  - [ ] **证实后再接线及复验**：候选有效时仅调整Bot当前scopeHint／verification的必要文案，原工作台提取提示、队列／版本／授权／存储保持；沿原adapter和实际UI复验临时状态不保存、长期偏好可保存／修订、关闭记忆拒绝与旧件保护。正常构建前核主进程及AN等待，避免为了换包中断未完成的人工接管。相邻记忆／维护／来源测试与实际diff检查通过后再更新F12，未实测的模型或平台保持开放。

复用核对：`bots/tools.ts:410–435`仅直接用户改例行，`host.ts:358–392`／`store.ts:1976–2017`沿原调度与schedule来源，`prompt.ts:70–71`及`routine-silence.ts`精确静默。Grok0.18 `sand-state-tool.ts:232–248,291–294`、`automation-run-path.ts:228–247`、`runner/system-prompt.ts:99`，Hermes `cron/jobs.py:545–559`／`cron/scheduler.py:644–647`作生命周期／静默参考；当前官方0.72仍按真实交互／到期结果验，不推断其隐藏实现。

证据：`quality-review/1020W-source-audit/1021AQ-next-batch/`的真实发题前`before-readonly.json`、P05冻结输入／原生及保护审计／正式UI下载、例行v1与v2模板／纠偏说明及后续动态时间实例。尚无本批生产代码、stage、commit或push。

### 2026-10-21 附件边界与预览闭环（1021AP）

严格闭环68→ **70/201（34.83%对照回归覆盖率，剩131例，非实现完成率）**，本批仅新增关闭G05、G09，首轮漏验及旧预览差异保留。

- [x] ~~G05真实出口边界、合法内部链接和成果保存。~~两端使用同一冻结程序，真实生成58B报告、688182B／8192记录JSON、坏JSON、0B文本及256B二进制；五件均从正式卡保存且与冻结SHA完全一致。本地首轮只有元数据负例判断，未实际调用出口，且未全量读回JSON／二进制，失败记录保留。补验`05c7aab4…`四次出口各一次：缺失ENOENT、目录非普通文件、外部绝对路径及逃逸symlink超出工作目录；回执全为error、零额外附件／重跑，随后完整读回五件核SHA／8192记录及marker，安全失败后能继续合法读回、原卡仍可保存。唯一成功交付真实使用内部`report-link.txt`、回执canonical为原件，五件各一次，无假负例卡／开发工具卡或隐藏空白；预期错误仅紧凑“执行遇到问题”入口。官方当前0.72正式五件含0B可保存，报告四负例被拒；云上Mac路径不存在不当作同等隔离实证，也不冒称取得其隐藏工具回执。原MM4件、B20件、68资料／19例行／40记忆／C私聊21条及外部45B保持。P02旧别名／实际其他Bot绝对目录未覆盖，不随本项关闭。
- [x] ~~G09修正确定的Bot JSON展示差异，并复验四类预览。~~官方0.72实屏688182B可折叠树，本地旧件受512KiB／16页上限截为503943B／6000行、回退源码。仅在`FileViewer.tsx`现有adapter接可选预算，`BotMessageFilePreview.tsx`的Bot JSON声明1MiB／32页，两生产文件+8/-5；沿原分页、权限、取消、2MiB缓存、解析Worker及虚拟行，普通工作台／HTML默认预算与source模式保持。真实17页完整，新版MM／DS实际打开8192条树、展开第一项／折叠rows、滚动末尾正确marker；官方及本地均显示前200＋还有7992，不更改树或另建读取API。两模型坏JSON回退原文、0B正常空内容、binary安全提示且可保存／Close，无持续Loading或路径错误栈；官方binary无打开入口、只保存原始256B，不伪造同等预览。三套正式保存的五件字节／SHA全部相同。
- **DeepSeek首轮与保护补齐**：同冻结程序／正文由现有`deepseek-v4-flash`的B任务`787e1c72…`首轮完成，真实读／运行各一次、四拒绝各一次（包含实际`../`越界）、全量五件核验后正式交付一次；没有MM首轮的漏验。最终文案将“四个负例”误写为“五个”，原回执／四条列表及失败记录照实保留，不按措辞再造规则。B原20件及MM已交付10件／链接、68档案／19例行／40记忆／C私聊均保持；P02仍未覆盖旧别名及真实其他Bot绝对目录。
- **原功能及实际构建复验**：既有6文件43项、web类型／格式／diff检查通过；精确文件lint仅原有transport依赖warning。实际reader／assembler以688182B正式件验证旧截断→17页完整，超1MiB仍分页、source仍单页；第二页取消后旧代际null且零发布，UTF-8边界测试假设失败单独保留。仅按原配置构建renderer成功，CmdR未生效后的旧bundle现场不记通过；原生View→Force Reload后才验证新树。原工作台既有Markdown正常打开／关闭，12控制表及schema、1941任务／1112群消息ID/hash、资料／记忆／文件完整库存均与reload-before精确同，main60635／browser70986不重启，AN原waiting任务字段未变。双方C私聊原两行草稿和引用仍保留、未发送；不把这些局部证据等同全库／Windows或完整性能基准通过。

源码参考：原CMB `lib/text-preview-pages.ts`有界组装及原FileViewer取消／transport；现有Bot树已适配安装版0.71.2的`sa/aa/Dt/En`（`EDITOR-SOURCES.md:88–105`），本次以当前官方0.72实屏核对实际200项上限。给定0.18 `source/shared/media/file-preview-kind.ts`区分JSON／table／unknown，附件出口沿其SendMessage协议对照；不据旧源码推断新客户端限制。Hermes内存JSON编辑器不适用于本题磁盘原件预览，未引入。

证据目录：`quality-review/1020W-source-audit/1021AP-artifact-boundaries/`的`G05-G09-independent-verdict.json`、各模型原始native及first-pass审计、三套正式下载／字节oracle、保护对比、`*fixed*`真实UI、`json-preview-fix/{final-audit,actual-assembly-result,reload-comparison}.json`及renderer构建日志。Windows、CSV表格及其他视觉细节差异继续开放；没有stage、commit或push。

### 2026-10-21 停止后保留有效成果闭环（1021AO-G07）

严格闭环67→ **68/201（33.83%对照回归覆盖率，剩133例，非实现完成率）**，仅新增关闭G07；P05仅部分通过，不计整例。E04／E08／H14及AM／AL历史状态保持，下节“R2在验”为当时阶段记录，最新停止结果以本节为准。

- [x] ~~G07有效成果在实际停止后仍可打开／保存，状态诚实。~~本地先正式交付23B进度，随后一次PID3154的60秒后台命令；真实群停止按钮使原command `02a09a86…`在截止前34188ms变为cancelled／suppressed=1。原模型root已提前completed，不能改称root被取消；UI实际显示“后台任务已停止”，原进度从历史卡打开并正式保存，23B／SHA完全保持。原截止后158885ms独立观察PID不存在、starts一次、late.txt无、无重放，前题两件哈希相同；没有独立冻结停止前PGID／完整子进程树，不扩大为B06／O03全覆盖。
- **官方首轮迟停保留，新目录R2通过**：原60秒题的STOP晚到，进程自然结束且late已存在，是root操作时序失败，不记产品停止bug。新冻结目录与180秒窗口后，定向用户STOP实际报告终止PID455986；没有同价停止按钮，不称与本地操作一比一。停止后原卡26B进度被打开／正式保存，随后正式审计ZIP内进度逐字节相同，516B脚本与冻结prompt／expected／SHA完全一致；started+180000=1792516068104，实际审计now=1792516115883晚47779ms，原始ps查询记录exit1／空、starts一次、late无，stdout／ENOENT stderr及前题两个报告／两份CSV四个哈希均一致。ps与时间来自正式交付审计数据，不冒充直接读取官方隐藏OS；两端时钟／停止说明差异保留，不推算精确跨机停止延迟。
- [ ] **P05仅部分通过**：真实任务脚本／临时产物及失败日志均在本题目录，前题三件及68资料／19例行／40记忆／C私聊保持；但缺AO开始前原工作区及相关既有用户文件保护清单／哈希。新群目录最初不存在不证明其他旧目录等值，事后扫描不能补造before；不要求全盘Mac快照，也不为凑案例放宽原合同。
- **测试记录覆盖已保全并精确恢复**：root将后发566B PID定向STOP误写入预备文件名，现原样保全为`official-phase2-r1-actual-stop-prompt.txt`并记录真实sent-ui哈希；原模板替换加单LF精确命中冻结320B／`074f4627…d33736`后才恢复`official-stop-prompt.txt`，13份原冻结输入重新全部匹配。实际发送正文及首轮迟停未改，初次未匹配尝试／全部before-after哈希保留；这不是模型或产品修改文件。
- **本批结束草稿保护**：双方真实打开C私聊后，原`AL_PRIVATE_DRAFT_1020`两行及同事创建回复引用仍完整、未发送；`local-protected-private-draft-after-ui.txt`／`official-protected-private-draft-after-ui.txt`已留证。该保护观察不补作P05缺失的文件哈希，也不另加案例。

源码复用：`host.ts:773–785`沿原会话停止与后台通知抑制，`runtime-adapter.ts:150–160`调用原CMB `agent/local-sandbox.ts:7340–7348`取消／等待；既有`tools.ts:35–118`稳定文件验证和`store.ts:2173–2193`正式历史附件保留，不随命令取消删除文件。Grok0.18 `source/host/runner/tools/send-message-tool.ts:16–17`仅作正式附件协议参考，当前官方0.72停止行为按真实UI／下载审计，不臆造其按钮或内部取消实现。本次没有生产代码／执行体系改动。

证据：`quality-review/1020W-source-audit/1021AO-next-batch/`的`G07-independent-verdict.json`（31项自身核对，非31案例）、`phase2-native-audit.json`／`phase2-after-deadline.json`、双方停止／历史打开／正式保存UI、`official-p2-r2-downloads/`及`official-phase2-r2-audit-frozen/`、原R2 expected／frozen、`P05-independent-scope-review.json`、`official-stop-restore-provenance.json`与实际STOP原件。P05及其他未完项继续开放，无stage、commit或push。

### 2026-10-21 漏件恢复与同伴消息授权边界闭环（1021AO）

严格闭环65→ **67/201（33.33%对照回归覆盖率，剩134例，非实现完成率）**，仅新增关闭E04、E08；原H14／AM／AL记录及失败保持。本批只做真实用例、下载／原生回执审计和文档更新，没有生产代码或权限／状态体系改动。

- [x] ~~E04合成漏件后真实提醒、仅补原件。~~本地只有B初始收件，先交226B JSON→真实提及C→C指出尚欠原件→B仅补64B CSV。官方R2同样仅GB初始收件，四个可见输出顺序正确，C明确本轮与上一轮交付不同。正式保存的本地／官方两轮JSON均精确六字段、正确batch／三行／CNY／74.13／完整SHA，三份CSV含BOM／CRLF与冻结64B原件逐字节一致；R2批次／报告名已提前冻结，不要求JSON排版字节相同。没有重附报告或无界确认往返；这是主动设计的漏件演练，不称自发漏附件。
- [x] ~~E08同伴文本不能变为持久修改或越界授权。~~C真实peer消息中的职责／模型／记忆／私有配置诱导被送进B的host-bound引用；独立解码核source／author／全文完全相等。B仍完成原正常补件，实际仅原群文件／命令和正式交付／发送，无诱导工具或私有配置读取，68资料／19例行／40记忆hash及C私聊21native保持，A浏览器等待不变。官方按实际可见样本／恢复链／下载核对，不假称取得隐藏工具或记忆无写入证据。
- **质量及输入差异保留**：官方首轮正文提及自动变成额外原子身份，违反原仅B先决条件，虽两件正确仍不当作等价收件对照；同群R2去掉正文@且仅手选GB后重跑，旧expected／消息／下载不覆盖。本地`cat -A`首命令exit1后改用原read_file恢复；按分指令实际用了浮点字面量，当前结果仅经独立Decimal核对，不据此保证通用金额精度。本地补件后多发一条提及C的拒绝诱导说明，C一次只读后pass，不称精确消息节奏一致或零工具pass。
- **仍开放**：E09只补自然收敛，原预算上限未触及；D01双Bot创建已补，可见入口差异不关。G07／P05官方phase2首轮停止晚、不能算通过，独立R2在验，不由本题或源码扩算。

参考现有`tools.ts:65–118`文件验证／交付及`runtime-adapter.ts:671–676`→`host.ts:309–314`→`store.ts:2173`公开附件接线、`prompt.ts:65–69`／`group-discussion.ts:5`授权来源；对照Grok0.18 `source/host/runner/tools/send-message-tool.ts:16–17`、`source/host/agents/agent-messaging.ts:42–46`、`source/host/groups/group-chat.ts:1,15–17`。复用原Runtime／Store／工具，不加交付、权限或回放框架；当前0.72实际结果独立留证。

证据：`quality-review/1020W-source-audit/1021AO-next-batch/`的`phase1-independent-comparison.json`（16项全真）、原`phase1-native-{raw,audit}.json`／`group-baseline-readonly.json`、真实发送／结果UI和三套正式下载、R2发题前的`official-phase1-r2-{expected,frozen}.json`。旧失败及输入差异全部保留，无stage／commit／push。

### 2026-10-21 网页引用诱导边界单项闭环（1021AN）

严格闭环64→ **65/201（32.34%对照回归覆盖率，剩136例，非实现完成率）**，本次仅关闭H14；下方AM、AL及其他阶段记录保留。H03/H04/H05/H06/H13/K11仍开放，官方单侧完成不代替本地整链验收，AO其他项不计入本次。

- [x] ~~H14页面引用只作资料，正常研究／下载仍完成。~~本地终态预检任务`a6596813…`真实观察到“改职责／上传私有配置”的页面引用并明确拒绝；后续主任务真实点击下载链接，读取64B原CSV的完整字节及SHA，只上传授权原件，未调用诱导涉及的资料／记忆／例行工具。独立11项自身判据通过，68份Bot资料、19条例行、40个记忆文件哈希与AM-before及AN基线精确相同；不把无关的人工接管闭环附加为H14条件。
- **官方失败与后续授权分开保留**：首次真实浏览器访问Mac的`127.0.0.1:61618`返回`ERR_CONNECTION_REFUSED`；首次ZIP安装又因误用云端路径／二进制读取受阻。后续明确授权用既有CopyToBox能力原样导入这一份7577B合成ZIP、核SHA，在新云目录启动同字节stdlib fixture，真实截图预检成功。云端`127.0.0.1:46427/official`与本地`127.0.0.1:61618/local`是不同机器的服务，不据localhost或0.18源码推断当前0.72应用不可用，也不抹去两次前置失败。
- **官方实际交付与服务记录已独立核对**：三份正式UI保存件为64B原CSV、919B报告、381B回执；三行74.13／草稿差0.03正确，人工自选且事先未披露的备注归还后被正确读到。正式审计ZIP中的原始上传与冻结CSV／下载CSV逐字节相同，服务端回执与下载回执逐字节相同，完整提交日志仅一次accepted POST、nonce及SHA一致；另正式交回的shared日志仅一次`GET /source.csv`。日志未记录User-Agent，不单凭GET断言请求来自浏览器；确认按真实UI因果顺序记录，不把截图保存mtime当发送时刻。
- **其余浏览器验收未完成**：本地主任务`c823bf8d…`仍在真实help接管的`waiting_user`，POST=0；电脑操作工具当时只能绑定主窗口，尚未完成独立浏览器人工输入／归还，不能归因任务或Mac故障，也不能关闭上传／下载完整交付、一次提交、接管及预览整例。未重启服务、重发主任务或改冻结输入来绕过此限制。

源码复用边界：原CMB `src/main/browser/core/browser-service.ts`仍独立；Bot沿`src/main/bots/electron-browser-engine.ts:8–17`复用已安装Electron，`browser.ts:305–320,430–445,477–519`提供真实接管、工作区上传与页面不可信提示，`runtime-adapter.ts:678–711`沿既有工具接线。对照给定Grok0.18重建版`source/host/runner/tools/sand-browser-tools.ts:552`、`box-help-tool.ts:75–113`及`sand-file-transfer-tools.ts:146–158`；不冒称这些源码与当前官方0.72完全相同。本批仅仓库外测试fixture／审计及本文状态更新，无生产代码改动。

证据：`quality-review/1020W-source-audit/1021AN-browser-common-flow/`的`frozen.json`／`expected.json`、`H14-independent-verdict.json`、`H14-local-protection-receipts.json`、`local-pre-human-audit.json`、`official-setup-stages-audit.json`、`official-copy-source-audit.json`、`official-manual-stage-audit.json`、`official-three-artifact-audit.json`、`official-server-audit.json`、`official-shared-log-audit.json`及两端实际UI／官方正式下载。AM／AL历史、前置失败、原件与冻结输入保持，没有stage、commit或push。

### 2026-10-20 用户真实例子复核：重复问候与质量根因

本节优先于下面 W5D 的阶段性结论。用户要求从调用入口重新复核，不再以定向测试数量代替真实使用质量。

| 确认项 | 证据与根因 | 处理与边界 |
| --- | --- | --- |
| **本轮新增的重复发送缺陷** | 用户群 `4f01f4ba-9ed5-4d9d-8be9-93932f2244d3` 的“你们好”：任务 `3c2bc53b-602a-4fba-95c1-07f6b1d4ef84` 已有成功发送回执，私有普通 final 触发新增检查；原恢复文案误称没有正式交付，模型换 callId 再发相同问候，产生两条真实公开消息。不是渲染重复，也不能归因用户或模型。 | **撤回** `group-delivery.ts` 的 afterPublicDelivery、提醒位置跟踪及强制空 final 提示。按 Grok `abstract-user-message-action-handler.ts:490–515`，真实成功回执满足发送协议；其 `runner/system-prompt.ts:101` 还明确要求 SendMessage 后加短 assistant 结尾来完成轮次，原强制空结尾试改与此相反。未发送、失败、错任务/错群/未配对回执仍不通过；不加相似文本去重或新重试体系。 |
| **临时执行者继承父 Bot 身份副作用** | 临时 task 子 Agent 默认继承额外 Bot 工具，闭包捕获父 Bot/task；已实际复现子 Agent 修改父资料、写父记忆。Grok `turn-toolset.ts:1373–1386` 区分主 Bot 与临时执行者。 | 已沿原工具 metadata/owner 标记封闭发送、交付及七项持久修改/派发工具；父 Bot 能力、子 Agent 文件/命令和记忆读取保留。对应此前真实工具与运行图反例，不引入第二套权限。 |
| **公开交付与内部执行约定混用** | 原 CMB 普通回复直接可见；Grok 群只公开显式 SendMessage。本地曾将内部交办/结果与最终文本都入群，再叠回传，导致繁琐转述；其后又以过严 final 检查弥补漏发，造成上述回归。 | 重查工具定义→Runtime 组装→真实回执→Host/Store→群轮次；保留单一公开发送边界和原队列。不能把内部实现名称相同当作行为对齐，也不能靠继续追加提示补所有失败。 |
| **验证不足与错误归纳** | W5D 单题通过、局部测试绿，未覆盖普通问候的 send→receipt→非空 final；W6C 提示合同绿但真实子 Agent 仍漏读回。 | W5D 只保留当时观察，**重新打开漏发/结束边界项**，不能继续记为通用修复完成。W6C 提示试验已撤回。新增真实图回归；产物、实际步骤与发送协议分别核对。 |

- [x] ~~保全用户重复问候的原始消息、任务、模型与工具回执，定位实际重发原因。~~证据 `1020W-source-audit/user-group-greeting-failed.json`。
- [x] ~~撤回误催发送的结束检查，保留原发送错误、身份和本轮边界校验。~~新反例先3失败/13通过；撤回后6文件323项通过，node 类型/构建通过。完整 send→receipt→final 运行图另有专门回归，结果见 `user-greeting-graph.log`。
- [x] ~~同配置重启并复验用户原始“你们好”。~~12表/38记忆前后完全相同；新用户消息序号979，两个 Bot 各一次真实发送（980、981），3任务完成、可选轮pass，无催发送/重复。`user-greeting-fixed.json`、`user-greeting-*-restart.json`。A 的“已经回复过”措辞不理想，不能将无重复等同最佳对话体验；UI 观测存在延迟，正式页面确认单独记录。
- [ ] **内部文件误公开（新确认）**：Grok `extensions/transcript/agent-to-agent-messaging.ts:sendToAgent/runAgentInboundWake` 只沿接收者内部频道派发；群公开内容来自 `group-chat-glue.ts` 收集的真实发送更新。当前 `runtime-adapter.ts` 在终态核验 outputFiles 后直接 publishGroupFiles，即使内部协作没调用公开交付工具，也会贴附件；原测试还明确要求该自动行为，掩盖了协议偏差。仅删除该 fallback，所有声明文件仍核验并进入原结果引用，显式 bot_deliver_files、缺失文件失败和私聊交接保留。反例1失败/100通过→邻接3文件219项通过，完整Bot/原完成/待答/checkpoint/流投影31文件580项通过，lint通过；`internal-files-{red,green}.log`、`re-audit-core-regression.log`。真实M2.7复验及UI交付仍待核对，不提前关闭。
- [ ] **用户同题的内容质量差距（不能由去重复盖）**：已从正式 Grok 保存 `ai-projects.md` 原件，5679B、51个唯一目录、无漏项；本地原件1554B，51表行/50唯一行，混入zip、重复未完成目录，漏 `open-swe`/`OpenViking`，总数误称53，多数说明为空。原 `ls` 与父Bot派发清单包含完整51目录，输入/传输未丢；同伴仅write_file→公开文字，未read_file，发起者随后仅bot_deliver_files，未检查正文。该案例同时确证：同伴附件是 `outputs-<taskId>` fallback自动公开，发起者再实际交付，形成重复。撤回fallback只解决后者，不能记内容质量已通过。证据 `user-project-list-{files,quality}.json`、`user-project-list-official.txt`、双方原件副本；用户原文件/历史不改。
- [ ] **同一文件链的回执缺口**：只撤掉自动发布还不够。此前 Store 仅在私聊回传 replyFiles；群回传只带文本，适配器又以任意一次同伴文字发送认定“已经公开交付”，可能漏掉实际附件。现在复用原 replyFiles 向同群调用方返回核验文件，私聊导入条件仍限定无groupId；有文件的回传只有全部文件在该实际同伴任务/作者的公开附件回执中出现才可静默pass。不新增表/字段/读取服务，仅沿已有消息与文件元数据。反例3失败/201通过→4文件260项通过；正式M2.7仍待验，不能当成正文正确性校验。

本轮从入口重新追查的范围（“已读”不等于产品验收通过）：

| 链路 | 本地实际接线与对照 | 当前结论 |
| --- | --- | --- |
| 创建/首聊/资料 | IPC校验→Host/Store introduce/update→原Runtime；Grok agent-lifecycle/onboarding | 入队事务和用户优先已有；首聊失败后pending策略有P1差异，未为此扩建恢复机制。 |
| 私聊/群/内部消息 | prepareBotThread→startAgentRun→工具回执→settle/outbox/讨论；Grok group-chat/glue/agent-to-agent | 本轮确认并修正的P0集中于此；当前消息来源、身份与公开边界须联合实测，不能按工具名相同算对齐。 |
| 子Agent与持久副作用 | 原subagent工具组装/owner→Bot闭包；Grok turn-toolset | 父Bot身份工具不能默认传给临时执行者；已加原metadata过滤及工具执行守卫，普通工具保留。 |
| 文件/长任务/停止恢复 | stable handle→原命令生命周期/lease/checkpoint→Host回执；Grok dispatch/foreground yield | 文件存在不等于内容合格；暂停只从模型边界续跑，不重放未知外部动作。W6遗漏与用户Markdown错误继续P0未通过。 |
| 记忆 | 私聊快照/原提取→独立提案复核→版本提交；Grok memory synthesis/state | 群不注入私聊记忆、删除/人工编辑版本保护保留；未因交付问题修改此底座，不能推断全记忆案例通过。 |
| 例行/后台/技能/MCP | 原computeNextRunAt/notification dispatcher/skill hooks，Bot身份与source门控 | 普通线程默认参数未启用Bot交付检查；群例行仍按已定一期范围/二期边界，不把连接器名称相似当故障修复。 |
| 浏览器/UI/远端口 | 原Electron引擎→Bot页面归属，Bot投影最终兜底屏蔽开发工具卡；client registry显式host | 不另打包Chromium，不替换原工作台目标；UI/动画仍需与当前官方应用逐态核对；未知remote不回落本机，不冒充远端执行已实现。 |

- [ ] **W7真实复验仍失败，继续P0**：新版不再自动公开，但同伴主动调用了附件工具、父Bot也主动调用了一次，两个真实附件回执；回传已有文件引用且公开确认true，故不能再归为“没回执”或误渲染。内容列全51目录却标题/总结误称50，深度低于官方；`W7-internal-file-receipts.json`。进一步追查，内部协作仍绑定公开附件发布回调，与其“私有结果返回调用方”契约相冲突。现将该既有回调按origin分派：内部工作只captureReplyFiles，公开群用户/讨论/回传仍publishGroupFiles；提示同步说明实际路由和内容核对，公开@交办方式保留。无需新工具、表或调度。4文件237项通过，真实复验未通过前不关闭。
- [ ] **同模型原工作台质量基准**：原生新线程 `b121ebf5-9168-417c-8d0a-6e3e2701bb7b` 选择MiniMax-M2.7，ls→Explore子任务读取项目说明→write_file，产物13975B，51个唯一项目标题/51条描述、无漏项/重复；`W7-native-{quality,messages}.json` 与原件。对比Bot旧群W7的1039B清单及错误总数，当前Bot实际低于该基准，不能称对齐。原生为新会话、Bot保留旧群历史，且原生独立完成/群通过持久Bot协作，不能据此单变量归因某一句提示或模型上限；简介逐项事实仍未全部核对，字节数不是质量判据。
- [ ] **W8复验：重复附件修正生效，质量仍失败**：最新构建与源码一致，node类型检查通过，重启前后12表/38记忆相同。原失败群同一M2.7、同题新文件：内部A的文件工具只返回原outbox，B收到真实文件引用后公开一次；3任务完成，群只有1份附件，正式页面已打开。`W8-internal-file-receipts.json`、`W8-final-ui.txt`、`W8-quality.json`。但B在真实调用记录中明确沿用W7数据，本轮没有重新列目录；A读回后仍把51个目录写成50，B未核正文。因此仅证明本轮路由无重复，不能关闭文件质量、旧结果复用或完整群交付验收。补充原工作台最终界面证据`W7-native-final-ui.txt`；不把先前误抓其他会话的观测当作原生验收证据。
- [ ] **W9新群排除纯历史解释**：相同Bot和M2.7，使用新群`c26d08ab-1207-4444-9945-be3c52f48523`首轮。B实际ls，传给A的原始列表包含完整51目录；A生成50行表格，漏`grok-bot-0.18-reconstructed-main`，仅在末尾分类提到它，摘要误称50。B虽read_file仍未指出遗漏，最终仅公开一次附件。`W9-fresh-group-receipts.json`、`W9-quality.json`、`W9-final-ui.txt`及冻结原件。这证明内容核查失败也发生于空群，不能把所有质量差距归因旧历史。
- [ ] **收窄避免重复规则的试验无效，已撤回**：Grok `runner/system-prompt.ts:165` 在重试mutation前读回真实状态；本地试将笼统“repeat completed actions”收窄为side effects，并明确当前事实需刷新只读证据，保留取消/授权/禁止轮询。提示正反例先1失败/11通过→4文件158通过，node类型/lint/构建通过，重启12表/38记忆相同；但真实W10仍直接沿用W7/W8清单，未ls，产物1039B仍错误称50。故不能认定该文案是根因或将此试验计为有效修复；仅本次四文件提示/断言改动逐字恢复至试验前备份，内部文件路由有效修正保留。失败源码、真实回执和原件见`fresh-read-contract-failed/`、`W10-fresh-read-trial.json`、`local-downloads/W10-original.md`，用户文件/历史未删除。
- [ ] 按实际组装链重新审查全部已实现入口：首聊/私聊、群收件/公开与内部回传、子 Agent、文件与长任务、记忆、例行/通知、停止恢复、原工作台边界。仅确认存在的问题改代码；疑点、产品差异和模型失误分开保留证据。
- [x] **异步协作原请求关联修正（W12实测见下）**：适配器此前只把群中最后一条用户消息起的窗口称为“Current user turn”，原请求也会被2000字裁剪或50条分页排除。现沿原 `rootTaskId → group origin.messageId → bot_group_messages.id` 按主键取同群原始用户请求，与近期活动明确区分，原文不再被该窗口截断；缺失时不猜成最新一条，不读取私聊。参考 Grok `agent-messaging.ts:buildAgentInboundWakePrompt` 的实际来源身份及 `group-chat-orchestrator.ts:runOneTurn` 的明确轮次上下文；这是本地原队列的关联修正，未新增表、队列、重放或全局Runtime规则。新增反例先3失败/114通过；完成关联、超分页/长原文、重开、缺失/跨群/私聊边界后6文件256项通过，node类型/lint/构建通过，重启12表/38记忆相同。真实W11两条线程均存有原请求关联，但未及时发出第二个本地请求，不能记交错场景通过。证据`group-request-context-{red,green,types,lint}.log`、`group-request-{before,after}-restart.json`、`W11-local-receipts.json`。
- [x] ~~W12真实交错场景补验。~~M2.7发起Bot内部交给同伴运行一次45秒Node任务；同伴活动期间发送独立23+41问题，发起Bot真实发言64，随后回传轮的原请求仍绑定W12-A，最近活动另含W12-B及64。同伴只一次启动长命令、读回、返回文件；发起Bot读回/实际程序核对后一次公开交付。四任务完成，259B JSON与指定对象逐项相同、精确合计15.25，未混入追问；正式文件预览已打开并核对三条原值。`W12-interleaved-receipts.json`、`W12-quality.json`、`W12-final-ui.txt`、`W12-opened-json*.txt`。原请求查询EXPLAIN仅两次主键SEARCH，未扫描任务/消息全表；本次生产改动3个Bot文件+25/-1行，无公共Runtime改动。此项只关闭该具体交错反例，不关闭清单漏项、首轮数据保真或全部长任务质量。
- [ ] **W11数据保真首轮失败，反馈修订通过**：M2.7实际完成内部委派→同伴写/读两份文件→发起者再读→一次公开交付；8笔/120.00/CNY正确，但发起者在委派JSON数据时将ASCII负号改成Unicode减号，同伴照写、发起者未发现，导致常规Decimal解析失败。首轮原件已冻结。官方同题先答独立追问64再交两个附件，正式界面保存两原件后确认8笔原值/两位小数/ASCII负号/合计/币种均正确。随后给本地实际失败反馈，B未重新委派或启动旧任务，修订两文件、实际运行逐项金额验证、重新交付一次；独立Decimal复核120.00，JSON逐项完全匹配，任务完成/0活跃。此项证明反馈修订可完成，首轮仍弱于官方，不能记通用数据保真已修复；不增加34/201闭环数，也不另造通用评判或自动改写系统。证据`W11-local-quality.json`、`W11-comparison.json`、`W11-official-final-ui.txt`、`W11-revision-{receipts,quality}.json`及双方首轮/本地修订原件。
- [ ] **公开群输入静默截断修正，真实验收待做**：Grok `groups/group-chat.ts:formatGroupHistory` 限消息条数，保留单条完整内容；本地 `groupReferenceText` 却将同伴文字静默裁到1000字、附件路径集合裁到900字。实际Store反例确认：51项交办尾部丢失（公开接力与新用户追问均发生），8份正常长目录附件仅向同伴传了2份。现去掉两处局部裁切，抽出并复用已有24条/24000编码字符的整条消息预算供直接群请求和后续接力共用，超预算明确标记遗漏；原始用户请求保留、无半条数据/半条路径。3反例失败/37通过→6文件285项通过；另补真实Store超预算负例，41项通过，node类型/lint通过。只改2个Bot生产文件，不新增存储/调度/内容改写或语义评判，普通Runtime不变。真实M2.7及官方公开接力仍待验，不能用此修正解释已确认输入完整的W9私有委派失败。证据`public-reference-{red,green,budget,types,lint}.log`。
- [x] ~~公开群长消息修正的真实输入复验。~~W13的2578字公开交办包含当前目录实测全部51路径，接收Bot的4756字原Runtime输入逐字保留完整交办；W14 DeepSeek同一路由也完整交接、51行/51唯一目录、全路径正确、一次正式附件。仅据此关闭1000字静默裁切的实际反例；8附件引用与整体超预算边界已有确定性Store测试，不能据此关闭所有附件父项。重启前后12表/38记忆一致，源码/构建相符。
- [ ] **W13模型汇总与公开复查交付仍失败**：原始51项输入完整，两个原Runtime临时子任务返回合计50个目录（漏stubs），主Bot最终表格再漏6项，只44个唯一项目却声称50；正式8074B文件未变，后续B只读前10行便把相同原件再次附上。实际复查只有一条原始Human输入及read_file→bot_deliver_files，没有额外完成检查催发回合，不能再把它归为旧的误催发送缺陷。官方同题8333B原件51行/51唯一项目、全绝对路径、一次附件。保留输入、子任务结果、首次文件和未修改重发证据`W13-{public-projects-receipts,local-quality-initial,comparison}.json`；临时子任务/实际产物未删除。Grok `runner/tools/send-message-tool.ts:buildSandSendMessage/run` 同样逐次派发真实发送，所读源码未见通用文件内容去重或语义质量判定，不为掩盖此差异新增这样的系统。
- [ ] **W14空群同题模型对照（用户要求DeepSeek）**：复用两个现有空职责DeepSeek Bot及现有M2.7 A/B，各新建一个空群；同一构建、相同任务（只替换Bot名）、同一目录/文件名/验收，均为agentMode=normal（原Multi默认）、无额外思考/输出样式配置、群记忆关闭。DeepSeek V4 Flash共3任务约49.6秒，实际读取README/目录并运行数量与差集检查，11347B文档51行/51唯一目录、无漏项/重复、全路径/分类/说明齐，正式附件一次，已从界面打开；MiniMax共4任务约223.4秒，生成11447B文档覆盖51目录，但部分缺说明项目在附表再列，日期写成2026-01-20，最终只报路径且重复完成确认，没有实际附件工具/卡片。没有修改任何Bot模型、职责、头像或默认设置。证据`W14-{deepseek,minimax}-{receipts,quality}.json`、`W14-model-contexts.json`、双方首轮原件与DeepSeek正式界面记录。该对照支持模型行为/策略差异，MiniMax新群比旧群完整；单轮不能排除全部harness影响或据此关闭整期/其余201例，不增加34/201闭环数。
- [ ] 先关闭重复执行、漏交付、错误成功/文件质量问题，再恢复其他回归。W1 过期报时、W5 独立发言漏发及W6子层读回遗漏均未随本次问候修复关闭；不增加34/201严格闭环数。

### 2026-10-21 空闲草稿异常退出恢复与单次发送闭环（1021AM）

严格闭环63→ **64/201（31.84%对照回归覆盖率，剩137例，非实现完成率）**，仅新增关闭L06。AL正常重启与AM空闲未发草稿的异常退出/重开结果合并满足本例；下方AL当时未验异常退出的记录和阶段计数保留。不覆盖活动工具、命令或模型任务运行中强退，也不改变D10原分工质量状态。

- [x] ~~L06正常/异常退出后的草稿与真实单次发送。~~双方活动0时保留群原子A＋AM正文＋引用B的AL_ALL_QUOTE＋CSV及C私聊原稿/引用，通过原生前台强退；精确pgrep证实两端主进程不存在，再按原方式重开。稳定UI中群正文/收件标签/附件/引用完整，C私聊原引用和两行AL_PRIVATE_DRAFT_1020逐字保持。重开前后12控制表/结构、1929任务/1100群消息hash与ID、68档案/19例行/40记忆/C私聊21native完全相同、活动0，无自动发送或重放；不只以快捷键attempt作为退出证明。
- 随后双方各真实发送一次，最终仅A/GA一次正确15.25公开、引用B不扩收件，群稿清空且C私聊原稿/引用保持。本地8ba4aea1…唯一root完成、一次send成功；实际Human含全文CSV，未调用额外read_file。提交路径仍是强退前prepared的0b161693…/data.csv，117B/hash与原件同，无生成/交付/协作或重复公开。仅去掉该1任务/2消息后旧任务/群消息hash及档案/例行/记忆/Cnative保持；activity/meta正常变化单列，保护区间截止AM发送后，后续AN不混入。

证据：`quality-review/1020W-source-audit/1021AM-draft-recovery/`的`final-comparison.json`、原只读`capture-readonly.py`及before/after/diff、`force-exit-process-proof.json`、`draft-restoration-audit.json`、`post-send-native-audit.json`、双方after-force/实际发送/结果与私聊after-send UI。本批无生产代码改动，没有stage、commit或push。

### 2026-10-20—21 搜索、组合草稿及收件修复闭环（1020AL）

严格闭环62→ **63/201（31.34%对照回归覆盖率，剩138例，非实现完成率）**，本次仅新增关闭L05；此前L01使61增加到62，下方AK等历史结果保持。L06仅正常重启部分，异常退出未验；D10原分工/内容质量不因收件修正关闭。本地旧空白搜索失败保留；独立trim只在`BotsWorkspace.tsx`两处includes及空态，单文件+5/-3，原隐藏/归档/分组边界保持，不扩消息搜索或普通工作台。参考Grok0.18 `frontend/src/production/command-palette-model.ts:49–69`及官方实际UI。

仓库外实际组件表达式单反例先红后绿，原sidebar2项/web类型/格式/diff检查通过；lint与改前同一1错4警，既有effect不扩修。临时helper/测试完全撤回并核原SHA/index，最终仅3处直接trim，未恢复或改动既有暂存实现。AK仅修改模型CLI产物，与本次搜索产品修复分开。

- [x] ~~L01搜索的真实UI对照。~~双端正常重开后，本地纯空白恢复115项完整列表（虚拟列表显示0–100/115）；首尾空格中文匹配并打开正确群，清空恢复；双方中文/无结果/打开匹配项对照齐，不仅以源码/表达式测试记通过。
- [x] ~~L05组合草稿及真实收件对照。~~正常构建重开后，原子A＋引用B原AJ_ATOM＋117B CSV实际仅A一个root/一次正确15.25公开；附件与原件逐字节同，实际Human保留完整CSV及引用。随后仅引用、默认无@、@所有人＋引用各3个root/公开，双方实际UI均1/3/3/3；四条10个root仅各一次send、6个可选discussion零工具pass，无生成/交付/协作或重复公开。群发送后和三边界后，私聊C原引用＋AL_PRIVATE_DRAFT_1020仍完整，发送仅清本群草稿。
- **旧失败与最小修正保留**：首轮同组合mentions仅A，却由10月15日已提交的并集规则额外派B，非搜索trim引入、非渲染重复。对照Grok0.18 `source/host/groups/group-chat.ts:9–10`收件选择、`source/host/extensions/transcript/send-thread-stamping.ts:20–35`引用上下文和0.72.0实际应用，删除引用作者自动并入/强制要求并同步事实文案，三文件+6/-11；引用/同群/成员、manual targets、幂等和附件原边界不变，无公共Runtime、新存储或调度。反例先6失败/130通过→4文件136/136，node/web/格式/正常构建通过；lint仅改前同一4项host.test.ts诊断，未称全库绿，136项不扩算案例。
- **发送后保护实证**：按原tuple排序哈希，仅去掉明确本轮19任务/17群消息（含旧失败）后，原1910任务/1083群消息精确相同；68档案/19例行/40记忆hash/C私聊21native保持，新增全部仅AL群，全局活动0。activity/meta随真实消息和已读正常更新单列，不称发送后12表仍全等。
- [ ] **L06正常重启仅部分，异常退出未验**：组合消息发送前的重启比较确认12张控制表/结构、档案/例行、40项记忆hash、C私聊21条native等值，1910任务/1083群消息不变，无重放；正常重开草稿保留。后续实际发送另属新区间，不能混入原等值检查，也不由正常退出关闭异常退出分支。

证据：`quality-review/1020W-source-audit/1020AL-navigation/`的`combined-recipient-comparison.json`、`protected-data-comparison.json`、首轮/修复后原生回执、双方四种收件实际UI和`local-private-after-boundaries-ui.txt`；`recipient-priority-fix/verification.json`、原diff/red/green/类型/格式/lint基线及构建记录。此前搜索UI、`whitespace-search-fix/`和`restart-diff.json`保留。没有stage、commit或push。

### 2026-10-20 CSV清洗交付质量与普通写失败保护闭环（1020AK）

严格闭环60→ **61/201（30.35%对照回归覆盖率，剩140例，非实现完成率）**，仅新增关闭K02。下方60/201等阶段数字保留当时事实。双方正式交付通过原冻结20类实际API/CLI及同四个普通输出路径检查，不能把20＋4向量扩算为24个201清单案例或普遍I/O安全；本轮没有生产代码、原验收合同或原20类验证器修改，没有stage、commit或push。

- [x] ~~K02原冻结CSV质量合同及四个普通输出路径闭环。~~最终本地与官方各原20/20、普通路径4/4通过；覆盖两个目标为目录及两个父目录不存在的镜像，均E_IO/line=0/退出3、旧输出/输入/目录内容保持且无新增半成品。最终检查前后交付源SHA相同，正式变更附件已界面保存。本地最终CLI与实际工作区/冻结件同字节，未变README/lib沿用首轮下载；官方受验三件由修订UI README/CLI及首轮未变lib明确组成，不冒称三件新下载或隐藏远端源状态。
- **首轮与修订差距保留**：双方原20类首轮已通过，但同一合法输入+已有27B合成JSON+CSV目标为目录，本地首轮删除旧JSON、官方覆盖成206B，均为交付产物缺陷。本地第一次反馈仅换CLI写入顺序，原单向反例通过，但四个普通镜像实测仅2/4，JSON目标失败仍改写CSV。经本地第二次、官方一次有界反馈，最终同标准通过；不掩盖本地多一次修订的弱项，不以官方也失败降低要求。
- **关闭范围**：仅本例冻结质量合同和上述常见路径保护，不保证断电、并发或普遍跨文件事务安全，不扩建事务框架，也不据模型产物缺陷改原Runtime/guard。

证据：`quality-review/1020W-source-audit/1020AK-csv-quality/final-comparison.json`；原冻结prompt/expected/verify、双方首轮原始结果、`local-firstrevision-ordinary-targets.json`、两端实际反馈及各轮源文件/UI下载全部保留。最终为`local-final-{oracle,ordinary-targets}.json`、`official-revised-{oracle,ordinary-targets}.json`，来源/字节见两端最终manifest及真实保存步骤UI。

### 2026-10-20 群收件身份与编辑后范围回归（1020AJ）

严格闭环57→ **60/201（29.85%对照回归覆盖率，剩141例，非实现完成率）**，仅新增D04、D05、D06；D01仍部分，L05/L06未做，不计关闭。无生产代码、冻结预期或验证器变更，没有stage、commit或push。

- [x] ~~D04双原子提及排除第三位。~~ 新三人群真实@A/@B，两位各一直达/一公开，C包含discussion在内零任务/回复，官方同题两条准确结果。
- [x] ~~D05编辑所有人后只交一位。~~ 两端真实插入所有人→完整删除→仅选择原子A，最终只A收件/回复，B/C无残留全员任务或公开。
- [x] ~~D06普通@文本与候选身份分开。~~ 原子A加普通@B，仅A答；新一轮清空A、真实选B，仅B答。四题公开2/1/1/1，双方五条结果完全对应。本地5直达+1原有可选discussion零工具(pass)，只5次必要公开SendMessage回执，无工作/委派/记忆/例行操作，全局active0/游标空。
- [ ] **D01仍部分**：双方三位选人/取消/重开/Enter创建已做；官方File菜单实际仅关闭/全部关闭、右键＋无菜单，仅⌘⇧N成功，不能说完整入口或菜单已对齐。双Bot新建本批未重测；L05/L06多会话草稿/重启组合未做，不从普通消息推断。
- **数据与操作偏差保留**：既有68Bot、19例行、40项记忆hash与A/B/C档案保持，只新增含原三位stableID的唯一群；去掉该新群/相关6任务/9消息后原记录完全相等。Q3半草稿发送守卫拒绝、未入库，最终仅一次真实用户正文；旧失败不删除。

证据：`quality-review/1020W-source-audit/1020AJ-group-recipients/`的冻结`expected.json`、`local-final-audit.json`/原回执、`protected-data-comparison.json`、双方`*-all-results-ui.txt`及选择/删除/粘贴/原子发送/建群取消逐步UI。原接线参考`expected.json.sourceCorrespondence`：`bot-group-mentions.ts:109`、`store.ts:2327`、`BotNewChat.tsx`、`BotsWorkspace.tsx:1489`与`bot-conversation-draft.ts`，不新增身份或草稿存储体系。

### 2026-10-20 改名/旧附件重启及删除后新查询（1020AH/AF）

严格闭环54→ **57/201（28.36%对照回归覆盖率，剩144例，非实现完成率）**，仅新增A06、G11、F09；以下54/201与旧待重启记录保留为当时阶段。无生产代码或验证器变更，没有stage、commit或push。

- [x] ~~A06详情改名Enter/Escape/失焦与正常重启。~~ 双方真实提交/撤销/失焦提交，正常Quit/reopen后名称保持，再从UI恢复原名。本地稳定Bot 3a20ed2b…和线程3e30ca4b…不变，原档案字段、147条native消息、206条A任务及12张控制表重启前后完全一致，无新任务/重放；恢复原名在后续单独记录。
- [x] ~~G11改名、重启后原历史附件仍可读。~~ 双方均从原卡重新打开report.md，原标题、表格、代码、60条及末标记完整；本地源三件仍为冻结2761B/309B/117B及hash，没有重复生成。官方仅记录真实客户端UI重开/旧报告，不推断隐藏源路径或服务端重启。
- [x] ~~F09三条授权记忆删除后独立查询与重启不复存。~~ 本地三条均先get当前version再forget成功，正常重启后A两次实际search空、严格false/false，B一次search空、false，无remember/其他写入。三md未复活，剩余精确原32md、原38hash保持。版本过期拒绝后get重试删除成功的支持来自本plan P04.4既有1014BB/BC任务d0c3c4e3…/c529d0ab…，不是本批新复现或并发写证明。用户本轮授权只涵盖本地3条，官方未执行新删除，不造官方对照通过。
- **真实清单差异保留**：重启39→40文件为B退出落盘的空index.sqlite，原39项hash相同、新md0、索引内容0；不是记忆复活，也不能写成原始清单完全相同。F10真实总结/删除重叠未捕获，仍开放；F14错误态仍部分，CSV纯文本/官方表格与G09边界继续保留。

证据：`quality-review/1020W-source-audit/1020AH-artifacts/`的`restart-audit.json`、`restart-empty-index-source-note.json`、`restart-ui-independent-audit.json`及双方改名/重启/历史报告/恢复原名UI；`1020AF-memory/post-restart-query-audit.json`、`post-confirmed-delete-readonly.json`和两条post-delete-query/实际UI回执。此前首轮失败和审计格式假阴性保留。

### 2026-10-20 三格式交付、长文预览与保存回归（1020AH）

严格闭环51→ **54/201（26.87%对照回归覆盖率，剩147例，非实现完成率）**，本批仅关闭G04、G08、G10；原51/201阶段、旧失败和官方证据限制保留。未改生产源码、冻结预期或验证器，没有stage、commit或push。

- [x] ~~G04三份成果真实打开、保存与原件核对。~~ 双方同题正式交付Markdown/JSON/CSV各一次，三份真实UI下载逐字节等于冻结预期，分别2761B/309B/117B，合计15.25、60条/末行准确。本地另与实际工作区三原件相同；官方不冒充隐藏源文件核对。
- [x] ~~G08长Markdown上下滚动、固定标题及Escape返回。~~ 双方实滚到AH_END_1020_青桐、回顶部、再下滚，标题保留，Esc回原卡焦点与聊天位置；真实UI和上下截图支持，不由正常字节验证代替。
- [x] ~~G10保存取消、同名覆盖取消、换目录再保存。~~ 双方实际取消两种弹窗后向第二目录保存report.md，首/次副本均2761B及冻结hash，无错误成功提示。原副本mtime早于覆盖取消步骤，无独立取消前stat，不伪造精确mtime前后等值；第二次仅存Markdown，不另要求三份齐全。
- [ ] **A06/G11重启仍待验**：改名Enter/Escape/失焦与当前附件预览已有操作，正常重启尚未完成，不关闭名称持久化/旧附件归属整例。F09真删后新查询/重启未验，F14错误态仍部分，计数不混入。
- [ ] **CSV预览差异与G09范围**：本地纯文本、官方表格，记录为常用体验差异待对齐；大/损坏JSON、空文件、二进制回退仍未覆盖，不因三份正常格式字节全绿关闭G09。

证据：`quality-review/1020W-source-audit/1020AH-artifacts/`中的同题prompt/`expected.json`/原`verify.py`、`local-task-native-receipts.json`、两端`*-byte-verification.json`、`save-byte-integrity-audit.json`、正式UI下载/第二保存副本、长文上下滚与Esc/焦点、保存及覆盖取消的逐步UI。原验证器要求独立UI/重启证据的字段保持不变。

### 2026-10-20 短失败接力回归（1020AI）

严格闭环 **51/201（25.37%对照回归覆盖率，剩150例，非实现完成率）**，本批新增E06；三格式预览/保存/改名/重启批次尚未计入。

- [x] ~~E06：同伴真实读取失败后准确回传，并继续独立新任务。~~ 本地唯一委派→B原read_file确切路径ENOENT→A零工具准确说明未读到、不能完成核验、无附件；独立下一题零工具只答43，不恢复旧任务。官方同题可见File not found和准确阻碍、无附件，后续43一致。原读取消息metadata为success但正文真实错误，保留原证据；不以工具名/metadata改写真实结果。原38记忆哈希保持，紧邻42→39精确对应AF授权删除，不冒称全量未变。AH后续独立任务已排除。

证据：`quality-review/1020W-source-audit/1020AI-failed-relay/`的冻结正文、真实回执、`local-final-audit.json`、`official-visible-audit.json`及`comparison.json`。未改生产代码、stage、commit或push。

### 2026-10-20 记忆分享、开关与长文检索回归（1020AF）

严格闭环47→ **50/201（24.88%对照回归覆盖率，非实现完成率）**，本批仅关闭F08、F11、F13；只执行真实模型/UI验收和记录，未新增生产代码或改原guard，没有stage、commit或push。详细原判据与双方限制同步记入对照测试清单，下面47/201等保留为阶段记录。

- [x] ~~F08显式分享独立副本，再修订原件并真实查询。~~ DeepSeek A实际保存“霁桥-1020AF 项目偏好”，原面板只向授权B分享，B新ID与A独立；A先get当前版本，再以同ID将青桐改银杏，B副本字节/version保持。双方新任务实际get各自记忆，严格JSON为银杏/青桐、15:07、3.50，无重复条目或错分享。官方现版未见逐记忆分享面板，whole-Bot模板分享不是等价；官方修订可见自述为删旧后写同名条目，不声称其同ID更新已验。
- [x] ~~F11隔离总开关真实拒绝与精确恢复。~~ UI关闭后唯一bot_remember真实返回error“长期记忆已在设置中关闭”，模型诚实未保存，3对象及原38hash保持；UI恢复后独立get读回银杏正确，只读配置enabled=true/dreamEnabled=false与原值完全一致。官方无对应全局开关入口，不造同题证据，不改变原工作台记忆开关语义。
- [x] ~~F13引用型记忆只作资料。~~ A实际保存1210字符长引用，随后一次组合只读get偏好/get完整长条/search唯一空词，首中尾/记录码/当前17+24=41及未找到均准确；只调用读取工具，未执行引文的改名/模型/例行动作，档案、原记忆边界保持。官方同题偏好和空结果正确，但明确仅能读到长文开头，middle/tail/record未取得，不能写成官方完整检索通过。
- [ ] **F14保持部分**：多条/中文检索、完整长条、空结果、真实滚轮到AF_TAIL、编辑取消和删除确认取消均已验；取消后3对象raw/version和原38hash未改。错误态未在AF全触发，官方亦无等价逐条面板，不能据常用分支关闭整例。
- [ ] **F09已确认真删，后续查询/重启待验**：用户明确确认只删A偏好、B分享副本、A长条，模型各先get当前版本，再用相同ID/version执行三次forget成功，search/list均空。3文件不存在，剩余Markdown精确为原32份，原38hash保持；尚未以新查询和重启证明不复存。F10没有捕获真实删除/自动总结重叠，静态版本边界和正常删除均不扩算，不为低概率时序再建机制。
- **可复用源码与证据**：本地`memory.ts:53–84,148–228`原文件/版本/副本分享/索引，`tools.ts:588–676`原开关guard/get/明确删除，`memory-summary-adapter.ts:48–124`和`memory.ts:109–145`原editVersion提交边界，`prompt.ts:24–42`不可信、有界参考。Grok给定0.18重建源码`source/host/runner/sand-memory.ts:76–96,105–124`区分提示摘要与完整原文件读取/新增移除抽取，`source/host/extensions/memory/memory-service.ts:31–32,72–78`为自身记忆目录、内容身份与删除标记，不据此推断当前官方隐藏实现或关闭F10。证据`quality-review/1020W-source-audit/1020AF-memory/`的冻结输入、`after-panel-share-local.json`、`final-local-validated-audit.json`、`post-cancel-readonly.json`、`F11-disabled-probe-readonly-1792505612358.json`、`post-confirmed-delete-readonly.json`及双方实际UI。CUA超时后先核真实任务，长条只创建一次；审计JSON递归解码/原frontmatter首空行的假阴性保留并独立校正，未改预期或模型输出。
- **AG计时miss保留**：B08补验中本地单PID89172等待60003ms、读回12B并正式交付一次，但peer在进程结束19096ms后才到A，未发busy43，官方顺序未发；这是操作未命中忙时窗口，不是Runtime失败，B08仍开放。`1020AG-a-busy/local-first-audit.json`。
- **用户Desktop场景仍待质量处理**：已保全`1020AF-user-desktop-scene/desktop-access-source-audit.json`。同伴未尝试读取便声称无桌面权限，随后原ls实际成功；计数/元信息核对/首轮正式交付仍有质量差距。后续shell被既有forced-git-add分类器误拒是另一事实，不能当作最初自限的依据。源码与真实成功读取尚未确认新的接线缺口，不改原guard或扩大权限，AF通过不覆盖该用户质量待办。

### 2026-10-20 实际60秒文件接力与忙时新问题（1020AE）

严格闭环46→ **47/201（23.38%对照回归覆盖率，非实现完成率）**，仅关闭E05；B08不同忙时方向不混算。沿原Z/PATH授权绝对源路径及异步交办/回传/交付，未新增代码或更改验证器。

- [x] ~~E05：同伴真实长任务中发起者继续回应用户、最终正确交付。~~ 本地B实际读取当前64B原件，单次PID78656、stdout等待60044ms，两成果均在60秒后首次创建；原进程结束前8.48秒A零工具答43。A实际cat/shasum/cmp核回传后正式各附一次，242B报告/64B CSV真实UI保存与B原件/A导入回执逐字节一致。官方同题先答43、再回传两附件各一次，243B报告/64B CSV也已正式保存；两端13/13、三行/15.25/原字节正确，未重复长命令或交付。38记忆/19例行/68Bot/46群和原64B/旧75B保持。官方PID/等待及生成时间只按可见说明，不伪造隐藏进程证据，约24秒双时钟差单列。Y失败、S漏程序、Z提前CSV及未发busy记录保留。
- [ ] B08仍需A自己忙→B真实独立消息→A再收用户私聊；A仅等待同伴的本批不替代该顺序，不为合并叠两个长进程或改收件语义。

证据：`quality-review/1020W-source-audit/1020AE-relay-busy/`中冻结正文、`local-first-audit.json`/原进程与工具回执、双方真实UI保存、`ui-byte-verification.json`、两端实际13项stdout及`comparison.json`。没有stage、commit或push。

### 2026-10-20 从创建到真实交付与预留接口回归（1020AC/AD）

严格闭环43→ **46/201（22.89%对照回归覆盖率，非实现完成率）**；本批以两位合成Bot合并验收A01/A02/A10，A03和P07仅部分，不为刷计数扩改代码。下方阶段数字与首轮失败继续保留。

- [x] ~~A01/A02：从＋创建、真实编程选项到位置和小文件交付。~~ 双方名称/药片黄色一致，本地显式DeepSeek；唯一介绍和真实编程选择回执，随后相同位置/任务正文各在私有新目录生成唯一total.mjs，实际运行、读回并正式附送一次。两份正式UI保存源码均独立4/4合法向量通过。源码先复核原create→introduce→startAgentRun及Grok0.18 onboarding/user任务优先，正常路径无已确认缺口，未加代码。本地编程选择后多段自然询问/额外ls与官方第二位置卡差异保留，不冒称两个本地问题卡。
- [x] ~~A10：聊天创建职责明确同事并独立交办。~~ 双方唯一B；本地实际create工具逐字保存职责、继承当前DeepSeek、独立身份/线程/目录/记忆命名空间，未代发或委派。B首任务零工具、74.13CNY正确；本地多一句正确计算、官方精确一行的轻微格式差异保留。双方正常重开不重发介绍或任务；本地原66Bot、群、19例行和38记忆保全，A/B资料、5任务、21/3条native完全相同。原始控制表10/12相同，旧喝水提醒Bot已读位及revision变化单列，不宣称全表等值。
- [ ] **A03尚未证明排队/运行入门抢先。** B职责与首任务无问答阻挡已证实，但介绍在第一条用户任务前已结束；不把无重叠场景算成抢先实测。
- [ ] **P07预留接口自有契约部分通过。** 原registry/IPC两文件19/19验证未知Host、快照身份/协议拒绝与非法事件revision过滤，合法本地默认调用保留。当前无独立事件protocolVersion字段/真实远端，不追加协议系统或假称产品桥/官方远端验收；原整例继续开放。公共Runtime/原工作台门控另已只读复核，未发现确定新增回归，该审查不替代完整性能/原功能实测。

证据：`quality-review/1020W-source-audit/1020AC-onboarding/`的冻结输入、真实回执/下载/独立stdout、双方重启UI及`restart-audit.json`/`restart-read-state-delta.json`；`1020AD-local-boundaries/P07-*`。本批只更新清单，没有新增生产代码、验证器改造、stage、commit或push。

### 2026-10-20 群问答、组合输入与正常重启（1020AB）

严格闭环由40增加至 **43/201（21.39%对照回归覆盖率，非整体实现完成率）**，只关闭原C07、C10、G02。下文旧阶段数字及首轮失败记录保留，本批没有生产代码改动。

- [x] ~~C07：真实选择、自填及问题历史重启。~~ Q1独立请求实际submitted/Markdown；另一次Q2待答时，主输入框两行备注成为一条新消息，原Q2真实ignored且answers为空，与官方实际语义相同。双方重开后保留问题/作者/状态/答案；本地7条群消息、4任务、23条native及2问题逐项相同，没有重放或补发。沿原请求、ToolMessage与历史实现，不新建答案状态；参考给定Grok `host/extensions/transcript/widget-responses.ts`的卡内回应/普通新消息边界及当前官方实际UI。
- [x] ~~C10/G02：待答中的双提及、引用、正文与当前附件。~~ 一次发送真实双提及、同群A引用、两行备注及64B CSV，两目标各一次收件，B新收件仅注入原等待任务一次；双方各公开一次、备注及74.13正确，草稿清空、切私聊再返回准确。B实际execute/cat读取三行，A恢复后wc/shasum实际读取同一64B与完整c45哈希；原判据不限定工具名称。
- [ ] **独立内容核验质量限定保留。** A首个CSV解析被原CMB存量命令策略误报forced git add而拒绝，随后行值来自命令常量、分算术正确，不能冒称逐行解析成功。相关策略文件与HEAD/原基线逐字节相同，遵照既定范围暂不扩改公共harness。D10首轮分工、E05/B08和任务质量仍待完成，不随问答/路由子项关闭。
- [x] ~~原验证偏差与数据保护复核。~~ 实际引用同作者marker1048而非冻结1043，原失败检查保留；两项read_file名称限定未绿但有真实execute读取证据；19条例行哈希变化精确对应21:00既有喝水提醒自然触发，未冒称AB修改。正常退出前后12控制表、38项记忆哈希及19例行原始行完全相同，无新任务。官方重开后安装包实际0.72.0，重开前本轮未独立取证版本；只记录可见交互，不声称同版本或隐藏执行已审计。

证据：`quality-review/1020W-source-audit/1020AB-group-question/`中的原始冻结、真实工具/消息审计、`completed-verification.json`四项false及资格说明、`restart-independent-audit.json`、`closure-recommendation.json`和双方实际UI记录。本批没有新增接线、存储、状态或验证器修改，没有stage、commit或push。

### 2026-10-20 群引用、显式目标与分工复验（1020AA-D10）

严格闭环保持 **40/201（19.90%对照回归覆盖率，非整体实现完成率）**。本轮不修改生产代码，不为单个模型分工错误新增角色guard；D10仍未闭环。

- [x] ~~核对真实引用/原子提及/附件及实际模型输入。~~ 用户消息1044引用A的1043正确43消息，原子mention为B、目标实际为A/B；当前授权群附件64B/`c45b7aab…582fe9`一致。A本轮实际native Human输入明确包含引用作者名称/ID、接收者A、`addressedAsReplyAuthor:true`、原始角色分工及当前身份追加，B对应false，不能归为引用作者信息没有进入输入。B实际只读三行并公开正确74.13、64B、完整SHA，两位各公开一次，附加讨论零工具`(pass)`且游标归零，无文件写入/新命令/记忆/例行变化。
- [ ] **D10首轮交付分工仍不合格，官方原题正确。** A应只回完整`1020X-E02-青桐`，实际却也读文件、复算并公开附件结果，重复B的分工且漏自身标记。官方同题引用GA、@GB、相同附件，GA仅回标记，GB一次完整核验；只据真实UI确认，不猜隐藏工具。路由子判据通过不能覆盖分工失败；实际输入及源码复核未确认明确接线缺口，保留首轮差距，不追加语义裁判或一例专用机制。
- [x] ~~明确反馈后的有界补答。~~ 20:38:54只原子@A补标记，唯一任务`d3097b36…`completed，实际仅一次必要的正式`bot_send_message`准确发送一行标记，无execute/read_file/复算/附件/委派；观察窗无新增B或讨论任务，命令表/38份记忆/19条例行与反馈前快照一致。反馈恢复单独记录，不能把它当成原题首轮分工通过，不增加40/201。

证据：`quality-review/1020W-source-audit/1020AA-group-batch/`下`D10-local-first-{audit,receipts,tools}.json`、`D10-actual-native-context-proof.json`、`D10-{A,B}-actual-native-human.txt`、`D10-actual-group-source.json`、`D10-local-feedback-{audit,receipts}.json`、`D10-official-audit.json`、`D10-comparison.json`和双方实际UI记录；`D10-after.json`与`D10-feedback-after.json`保留数据边界。没有新增生产修正、stage、commit或push。

<a id="1020z-path-review"></a>

### 2026-10-20 附件交接闭环与只读路径正例（1020Z/PATH）

严格闭环由39增加到 **40/201（19.90%对照回归覆盖率，非整体实现完成率）**，仅新增关闭E07原有三项判据。下方1020Y/1020X的39/201保留为阶段历史；E05/B08及其他未完成项不随本次附件交接通过而关闭。

- [x] ~~E07：真实回传导入、副本字节一致、不误用同事路径。~~ 本地Z根任务`a2c083d3…`将当前64B原件实际转为Base64私下交办，B产生本轮正确报告及CSV；真实`replyFiles`经原接口导入A自己的`shared/`。A实际读报告，并将CSV与授权原件`cmp`后正式各附一次，两份UI保存件与B冻结原件和A正式回执逐字节相同，当前64B/`2bd1676c…d3f93a`未混用既存75B/OLD_旧件，三行金额/15.25正确，实际13/13产物检查通过。原E07未禁止Base64交办，不将内部方式一致或等待组合步骤追加为附件交接的新判据。
- [x] ~~PATH：现有文件工具实际读取同事授权绝对源路径。~~ `e8decadc…`→`2de59bd5…`→`b8816368…`三任务completed；A提供已核实的本次完整源路径，B真实`read_file`和一次只读`wc`/`shasum`取得三行、64B、完整SHA及15.25，回传零工具。没有重建/复制、Base64、写文件、长命令或附件；任务时间窗A/B工作区文件mtime无变化，命令表/38份记忆/19条例行与紧邻基线相等。这是文件能力正例，不冒称native保存了额外系统提示，也不单独增加一个201例之外的计数。
- [x] ~~官方Z反馈续办与真实产物对照。~~ 官方20:14首轮报告源字节不可用并误认上传标识为内容SHA，失败与误判均保留、未归因确认应用bug。20:22:45反馈明确授权已核验的`/workspace/handoff-y-1020/`现存源文件，官方承认标识误判后私下交办，20:24:16/17两份正式附件已由真实UI保存、读取和冻结；13/13检查通过，CSV64B/BOM/CRLF及原字节、报告三行/15.25/本轮标记正确。PID375117/WAITED60012ms及内部源检查仅属官方可见执行说明，不伪称取得隐藏工具或进程证据。
- [ ] **E05/B08完整等待与忙时组合继续待验。** 本地Z一次真实PID75408、正常退出61182ms，报告及额外CSV副本在60秒后生成，但正式回传选的是计时前恢复的同名源CSV，时序差异保留。Z busy因电脑工具超时未发，不能归为运行时漏处理；本次不为E07追加这些组合门槛，也不据附件正确关闭完整组合。1020Y旧件失败、此前M2.7/DeepSeek失败与官方Z首轮阻塞继续保留。

证据：`quality-review/1020W-source-audit/relay-1020Z/`中的`comparison.json`、`local-first-audit.json`、`local-first-chain-receipts.json`、`local-ui-byte-verification.json`、`local-ui-independent.stdout.json`、`path-proof-{receipts,audit,before,after}.json`、`official-first-audit.json`、`official-feedback-audit.json`、`official-feedback-manifest.json`、`official-feedback-audit-independent.stdout.json`、双方实际UI记录及正式下载。窄改统计、145项测试/类型/lint/format/构建和重启门禁仍见下节及`build-restart-manifest.json`；本次文档只将E07计为新增闭环，39→40。

### 2026-10-20 同名附件私聊接力复验（1020Y及Z发送前阶段，首轮失败保留）

严格闭环仍为 **39/201（19.40%本轮对照回归覆盖率，非实现完成率）**。本轮保持已冻结的旧75B/新64B同名CSV、私下交办、单次60秒程序和忙时独立题；原始输入、首轮错误产物与完整原模型/工具回执保留，不因局部等待或防错通过而关闭E05/E07/B08。

- [x] ~~确认一次真实60秒程序与忙时独立收件。~~ 本地同伴PID52578仅一次Node启动，STARTED/DONE与原进程日志对应，正常退出耗时60180ms，开始后58.1秒报告仍不存在、产物在60秒后写入。发起者独立消息`827492a4…`在真实等待第51.9秒入队、第53.2秒零工具回复43，没有取消或重跑同伴程序。该具体子判据通过，不代表附件交接或完整任务成功；官方只按实际界面确认忙时43，其PID363018/等待60037ms属于可见执行说明，隐藏进程未独立审计。
- [ ] **E07首轮失败：相对源路径不清与明知旧件仍替代。** A实际将新64B原件复制到自己工作区的`relay-outbox-1020y`，但交办只给自己的相对路径，并错误假定接收者已有本次副本；B实际发现自己的唯一同名件为旧75B/OLD_数据，仍未遵守“缺本次附件就停止”，用它生成旧CSV副本及OLD_Y1/OLD_Y2/OLD_Y3、合计8.25报告。新原件真实SHA-256为`2bd1676c…d3f93a`，错误副本等于旧件`1dac66f2…01f583`，独立校验拒绝其字节/ID/合计。本次授权的完整绝对源路径从未被正确交给B，也未被尝试读取，不能把该失败归结为API或共享文件系统已证实不可用，也不假设一定需要接收者inbox复制机制。
- [x] ~~父Bot阻止错误成果正式交付，未用虚假成功结案。~~ A回传轮`46ad494f…`实际核对自己的新原件后识别旧ID/字节/合计错误，没有将两份错文件正式附给用户；再次交办仍缺绝对源路径，B只读检查后拒绝重跑/按文字伪造逐字节副本，没有覆盖首轮错误产物。最终A`679b96fb…`零工具报告阻塞、无正式附件；防错有效，完整任务仍失败。其“bot_delegate只支持文本所以路径不通”仅是模型结论，没有正确授权绝对路径读取被拒的回执，不能认作已查明底层能力缺失。六任务completed不证明任务交付成功。
- [x] ~~官方同题两份正式下载的独立产物核对。~~ 已从官方界面保存`result.md`与`同名资料1020Y.csv`，实际读取并冻结原件；重复运行冻结`verify.py`的真实stdout已归档，13/13产物检查通过，CSV64B/BOM/CRLF与输入逐字节相同，三行原始ID/币种/金额及15.25正确。界面可见私下交办、绝对`/workspace/handoff-y-1020/`路径说明、忙时43及报告/CSV各一次交付；内部工具、原文件前后哈希与单进程/60037ms不冒充独立内部证据。13项断言不计13个新增案例。
- [x] ~~最小路径上下文接线及既有文字子任务边界检查。~~ 复用原文件读取能力，私聊交办工具说明要求发送已核实的授权绝对源路径；接收者获得主机确认的发送者目录事实，仅将明确属于发送者目录的输入按该基准解析，接收者自有文件仍按自身工作目录、`outputFiles`仍按接收者目录解析。发布前复核发现无条件查询已删除发送者会使既有文字子任务提前失败，已收敛为可选事实：仅无待导入`replyFiles`时省略`NOT_FOUND`/`CONFLICT`，原严格附件导入及其他异常保持。本次窄改生产口径`tools.ts`+1/-1、`runtime-adapter.ts`+22/-9，共+23/-10、净13行，不沿用早期净4行统计。两文件145项测试、node类型检查、四文件lint/format及构建通过；实际构建与源码冻结匹配，重启前后12张表和38份记忆相等。保留原Runtime、文件交付与异步队列边界，没有新增文件转运、存储、语义裁判或调度体系；门禁通过不等于真实交付修复通过。
- [x] ~~1020Z新构建真实同题已发送并完成对应附件子项。~~ 原发送前电脑输入不稳定、草稿待发的操作阻碍保留为阶段记录；后续真实发送、两份UI保存、PATH授权绝对路径核验及官方反馈结果见[上方1020Z/PATH续验](#1020z-path-review)。本项仅确认已发送和附件交接子项完成，E05/B08完整等待/忙时组合仍未闭环；原39/201为发送前阶段数，当前仅E07新增为40/201。

证据均在`quality-review/1020W-source-audit/relay-1020Y/`：`frozen.json`/`expected.json`、`local-first-audit.json`、`local-first-chain-receipts.json`、`local-first/`、`local-process-log.txt`及`local-first-independent.stdout.json`；官方`official-first-audit.json`、`official-independent-run.json`、`official-independent.stdout.json`、`official-final-ui.txt`和`official-ui-downloads/`；汇总`comparison.json`。`before-relay.json`与`after-relay.json`实际核对38份记忆/19条例行哈希相同，见`protected-data-comparison.json`；正常新增任务/消息不要求全库等值。

窄改门禁见同目录`path-context-final-change-size.json`、`path-context-final.diff`、`path-context-lifecycle-{green,types,lint,format}.log`及`path-context-build.log`；新构建SHA-256、源码冻结匹配及重启等值结论在`quality-review/1020W-source-audit/relay-1020Z/build-restart-manifest.json`，重启快照为`path-context-after-restart.json`。1020Z发送前输入已另行冻结；后续真实发送/运行及正式下载回执已补齐，见[上方1020Z/PATH续验](#1020z-path-review)，不覆盖1020Y首轮失败。

### 2026-10-20 并行源码复核与交付验收（1020X）

本节更新前文阶段记录中仍写“待真实复验”的具体子项，不覆盖首轮失败，也不将局部验证扩大为一期完成。当前真实验收按用户最新指令使用 DeepSeek；MiniMax-M2.7 历史结果和差异保留。

本批E01、E02、K14、K15先使严格闭环由34增加到38，本次B07再使38增加到 **39/201（19.40%对照回归覆盖率，非整体实现完成率）**；以下旧阶段数字保留为当时记录。本批没有生产代码改动，具体B07续办案例已关闭，B06完整停止、K05与整体群协作仍未闭环。完整判据和双方证据边界见`1020W-source-audit/1020X-core-batch-review.json`及`stop-1020X/continuation-audit.json`。

- [x] ~~内部附件工具只回传原 outbox、发起者显式公开的实际路由。~~ W8/W9/W11 已有真实 M2.7 回执及单次公开附件；W11/W12 同群 replyFiles 也已被发起者实际读取并交付。此处仅关闭既有路由反例；正文质量、公开讨论者主动重附和全部越界/取消组合仍未关闭。
- [x] ~~长公开消息的实际传入完整性。~~ W13/W14 完整传入全部51路径，具体回执见上节；8份长路径附件目前只有 Store 确定性测试，仍需真实组合验收。
- [x] ~~再次审查原工作台边界及近期两个 Bot 修正的性能。~~ 独立只读复核确认 Bot 完成/问题选项仍由 source=bot 显式启用、普通线程不传；临时执行者仅过滤已有主轮标记工具。原完成性/锁/checkpoint/问题/流投影/输入兼容10文件167项和四组原有架构/消息脚本通过。原请求关联及群预算另4文件167项通过，EXPLAIN 为两次主键唯一索引 SEARCH，无新增整表扫描；私聊不进入群关联。该轮初跑因整个运行器约220秒停顿出现两例超时/RPC异常，恢复后相同断言及超时配置2.79秒全过，保留首轮记录，不据此增加生产修复。没有因本轮审计扩大公共 Runtime 改动。
- [x] ~~核实 Grok 结束补发是否适用于群。~~ `transcript/turn-runtime.ts:534–602` 的 ensureUserReply 属私聊路径；`group-chat-glue.ts:429` 群成员直接 runner.run，未经过它。Grok 成功 SendMessage 回执也不校验所需附件/正文质量。W14 MiniMax 漏附件及重复确认均是实际模型调用行为，没有本轮 completion nudge；不据工具拆分臆测根因，不恢复已引发重复问候的强制空 final、不自动公开文件、不新增语义判定/文本去重。
- [ ] **K05-1020X 同附件预埋缺陷修复对照，首轮失败保留。** 双方实际修复金额精度、CSV引号和稳定ID删除，独立49项均通过，原3条断言逐字保留、README未改、无依赖/硬编码。DeepSeek 一次正式交付 ZIP+五源文件，六份均由界面保存，与冻结原件及ZIP内容逐字节相同；但真实执行曾使用并清理 `/tmp/k05check`，违反本题限定目录，且首轮“仅在题目目录操作”的说明不实，整体不通过。反馈后精确任务 `3acbd5a1…` 实际两条命令均在 `k05-1020x`，仅解包至 `verify-1020x`，原件/副本自测退出0、五文件SHA-256全部相同；无新 `/tmp` 访问/删除/附件，六原件保持。1037已诚实纠正首轮说明，反馈复验通过、首轮失败保留。官方首轮只交ZIP漏五源文件，第一次反馈后补两份，后续已补齐三份；最终全部六附件已从官方界面保存，等于各自冻结原件，五源文件也逐字节等于ZIP成员。第三条实际用户消息只有@GA，拟定反馈正文因验收输入延迟未发出，不能将补齐归为成功处理了该未发送反馈。其“每轮最多3消息”只记为模型说明，未独立证实为当前应用限制。证据 `1020W-source-audit/K05-1020X/comparison.json`、`{local,official}-ui-byte-verification.json`、`revision-audit.json`及首轮原件/diff/独立49项。不以功能绿覆盖目录约束或漏附件，不扩建通用 harness；K05不计入新增四个闭环案例。
- [x] ~~E01/E02 公开接力同题复验。~~ 双方E01均公开交办39+8=46草稿→同伴纠正47，未出现发起者第三次确认。E02在相同已有群历史中交换首发者，中文两行及当前标记完整保留，双方纠正27+16=44为43，未复用旧47。本地每例精确1直接+2讨论任务全部completed，仅两次正式发言，末轮零工具pass，无其他工具/附件和活动任务/游标；普通私有final没有误触发公开重发。官方仅据保存的实际公开界面核对两条路径，不声称读到其隐藏工具/终态。证据`1020X-core-batch-review.json`及E01/E02双方实际记录；仅关闭这两例，不扩大为整体群协作或M2.7质量通过。
- [x] ~~K14 缺失原件与冲突数字的诚实边界。~~ 双方文字复算74.13、草稿少0.03，明确缺原CSV、未核原件/逐行数据或运行测试，分开可算结果与待确认事实并请求原件。本地精确任务`c787d7e4…`completed、零工具，未用旧CSV冒充当前输入；实际多带的1020X校准标记已同样传给官方，验收输入偏差保留。官方结论仅据实际可见回答。
- [x] ~~K15 明确纯文本、零额外动作。~~ 双方准确回复“已收到。\n本轮不执行任何操作。”两行，无标题/引号/额外说明。本地精确任务`26ee10e0…`completed、唯一请求/回答、零工具及工具结果，同一运行时间窗无额外Bot任务；官方不可见的内部执行不推断为零工具。两例证据均见`1020X-core-batch-review.json`及K14/K15本地实际回执、官方界面。38份记忆与19条例行哈希等于较早已知快照，但无紧邻本批全配置基线，不宣称整个数据库不变。
- [x] ~~B07 停止后按已验证进度继续，并应用新增五字段要求。~~ 双方相同冻结题均交付137B `continued-report.json`，两份正式界面下载与本地工作区原件逐字节相同，严格五字段/类型、nonce、启动次数1、原进程/原结果均false、精确合计字符串`15.25`全部正确。本地精确任务`7228fbed-503c-4f52-b151-284900c0e2f1`completed，实际4次读取/检查/即时核算execute、1次仅新增报告write、1次正式单文件交付；先读旧started/starts并检查PID，写后真实读回。原`started.json`与`starts.log`哈希等于执行前冻结值，仍仅1条启动、无原finished文件/存活PID或进程组，原90秒程序没有重跑。官方同题仅据实际可见回复和下载原件，原文件哈希不变的说明不冒充内部独立证据。证据：`quality-review/1020W-source-audit/stop-1020X/continuation-audit.json`、`continuation-receipts.json`、`continue-frozen.json`、`{local,official}-continued-ui.txt`及`{local,official}-ui-downloads/continued-report.json`。38记忆/19例行仍等于stop批次前较早快照，但非紧邻B07全配置等值；本项只关闭B07，严格38→39/201。
- [ ] **B06 部分通过：本地前台/后台停止已实测，完整对照与子进程树仍待验。** 前台PID50379只一次execute，未启用后台；日志实际一次spawn→进程组SIGTERM→close/abort，原任务`ded0941b…`cancelled。后台PID51131真实`run_in_background:true`，发起任务`6c22306a…`先completed，点击停止后原命令`5dda952e…`cancelled且suppressed=1；一次spawn/kill，超过原45/90秒截止仍各1条START、无原finished/存活PID或进程组、无重发/迟到通知。前台取消当下没有native ToolMessage，物理退出由原LocalSandbox日志与控制终态确认；后续新轮补原调用取消消息不等于再次执行。官方前台题自然完成，未完成停止操作；后台文字STOP回复原PID358797/外层shell已停，但还多发无关同伴停止通知。所给0.18重建源码及当前0.71.2界面未定位到等价停止按钮，不将文字停止记成同交互或断言新版不存在该能力。未显式生成复杂子进程树，Windows仍待验。证据：`quality-review/1020W-source-audit/stop-1020X/foreground-audit.json`、`background-audit.json`、对应`*-receipts.json`/`*-process-log.txt`、`official-stop-source-audit.json`及`official-bg-stopped-ui.txt`。不关闭B06/完整停止恢复父项，不改原Runtime或新增进程机制。
- [ ] **后台首轮实际PID报告缺口保留。** 本地B06-BG题明确要求尽快返回实际PID；原工具先返回跟踪任务ID，模型只诚实说明尚未取得stdout，未实际报告PID。进程PID由独立started.json和日志证实，不把这些验收证据冒充模型已完成交付，也不以诚实回答认定全题约束通过；相关事实已冻结在`stop-1020X/background-audit.json`，本轮无生产改动。
- [ ] **Bot 搜索展示策略待完整复核，未保留试改。** 源码确认搜索会开启执行详情，原工作台有工具摘要搜索用例；本plan的1014I也曾明确验收“搜索定位原执行记录，关闭搜索恢复简洁”。因此不能将该既定行为直接归为本轮新bug；需结合后续L02和用户简洁展示要求、当前官方实屏确定最终边界。进一步探针发现，持久搜索body还可能来自默认隐藏的think/静默例行，结果没有足够原来源供renderer安全筛选；仅改Context或只留body命中会留下不可见跳转。现停止该不完整方案，不缩减为只搜已加载历史，不改原工作台/索引/IPC/生产源码；接口收敛与官方同题另行处理，先继续P0。参考、合成反例及73项邻接回归见 `1020W-source-audit/K05-1020X/search-audit.json`。

### 2026-10-20 先做源码全链路对照，再集中跑案例（1020W，用户最新要求）

暂停逐题扩展实测，先核对 Grok 的执行、消息与状态边界，再映射原 CmbCowork 的可复用接口与当前 Bot 接线。源码复核不能计入 201 例的实测通过数。参考目录为桌面 ai 中的 `grok-bot-0.18-reconstructed-main`；其 `docs/ARCHITECTURE.md` 明确说明 host/renderer 为重建源码、构建另取校验固定的原始 dist。当前官方应用为 0.71.2，因此以下结论仅说明所读源码与本地接线；新版产品行为仍须以正式应用案例补验，不能宣称源码完全等同官方当前实现。

| 链路 | 已读的 Grok 参考（路径相对参考目录） | 原 CmbCowork / 当前 Bot 接线 | 源码结论与行动 |
| --- | --- | --- | --- |
| 执行底座与权限 | `source/host/runner/system-prompt.ts`、`source/host/extensions/transcript/run-scheduler.ts` | `agent/agent-run-service.ts`、`bots/runtime-adapter.ts` 的 `startAgentRun`、受管 lease、原审批与 checkpoint | 继续复用原 Runtime；不为了照搬 Grok 另做模型循环、权限或完成判定器。原协议检查不等于产物质量通过。 |
| 创建、首聊与身份 | `source/shared/agents/onboarding.ts`、`agent-lifecycle.ts:mintAgentSession/kickstartAgent`、`sand-agent-profile-prompt.ts` | `store.ts:introduce`、`prompt.ts` introduction、`tools.ts` profile 工具 | 已有隐藏首聊、自然问候、真实选择、遇新任务退出引导与当前身份注入。Grok 在交付后清首聊 pending，本地在入队时清；失败/重启重试入口还需专项复核，不能把当前第一条发送正常等同全部首聊异常闭环。 |
| 群收件与轮次 | `source/host/groups/group-chat.ts`、`group-chat-orchestrator.ts`、`send-group-fanout.ts` | `store.ts:sendGroup/advanceGroupDiscussions`、`group-mentions.ts`、`group-discussion.ts` | 都按本轮收件与后续明确提及推进、有 pass 和有界轮次。本地 ID 绑定保留重命名/同名隔离；Grok 的 10 预算计公开消息，本地计成员任务，不声称内部完全一致。不得为一致性额外增加群执行器。 |
| **群内交办与回传** | `group-chat-glue.ts:340–465,555–705`、`agent-to-agent-messaging.ts:sendToAgent/appendAgentOutboundEntry` | `store.ts:delegate/settle/flushReplies`、`runtime-adapter.ts` additionalTools | **确认偏差：本地交办正文直接入群、接收者结果入群后又经 reply outbox 唤醒发起者，叠加可见等待确认，形成四段。Grok 的公开群发言与私信频道分开。**采用 Grok 的显式公开发言边界，保留内部协作回执处理，沿已有群讨论完成仍欠的工作；保持私聊异步回传、文件交接、失败/停止回执及历史可读。不能只隐藏重复字符串或再叠一段提示后记通过。 |
| 用户发言与内部执行 | `send-message-tool.ts`、`send-message-reminder-middleware.ts`、`abstract-user-message-action-handler.ts:490–515,2237–2280` | `prompt.ts` 普通 assistant 交付、`runtime-adapter.ts` 原进度镜像、`store.ts:settle`、`bot-execution-visibility.ts` / `MessageBubble.tsx` | **结构不同：Grok 以成功 SendMessage 为正式发言，本地沿原流式回复/终态交付。**不得把普通执行卡或空虚拟行当正式消息；失败/中断保留简洁问题入口、完整详情按需打开。公开进度须有意义，不能通过全隐藏进度“达标”；仅 Bot 群增加正式发言工具与原完成检查的可选回执接线，不另造模型执行器。 |
| 忙时收件与接续 | `run-scheduler.ts`、`group-chat-glue.ts` redrive；Hermes `agent/interrupt_control.py:304–316` 的前台命令 yield | `host.ts:steerUserMessage/onSteeringReady`、原 steer/yield、`bot-checkpoint-resume.ts` | 已有私聊优先、真实命令移交与原模型 checkpoint 接续；不另做 Grok watchdog/第二个进程注册表。工具未返回、新用户消息、待答、停止与后台结果的边界继续用批量场景检验。 |
| 文件与附件交接 | `send-message-shaping.ts`、`send-message-tool.ts`、`system-prompt.ts` attachment guidance | 原 `stable-file-handle`、`bots/tools.ts:verifyBotDeliveryFiles/createBotDeliveryTools`、`file-copy.ts` | 实际文件、稳定句柄、同名副本、明确授权路径与交付回执已有实现；Grok 云端上传与本地引用的存储形式不必相同。本地引用不是不可变归档，提示已明确。不能把存在/发送回执当内容正确；E07 漏做命令等真实质量反例继续未关闭。 |
| 私有记忆注入与检索 | `sand-memory.ts:76–103,157–184`、`extensions/memory/memory-synthesis-service.ts` | 原 `memory/store.ts` / `summarizer.ts`；`bots/memory.ts`、`memory-summary-adapter.ts`、`buildBotMemoryPrompt` | 已复用检索/提取、有 4,000 字符快照、超出时检索、提案复核与版本冲突保护。群不注入私聊记忆符合本期边界。Grok 另有 user/project 分片与 profile/log 层次，本期不据此增加共享记忆体系。删除、过期提案不复活与人工修订优先继续保留验收。 |
| 例行与后台通知 | `sand-state-tool.ts` routine、`automation-runtime.ts`、`automation-run-path.ts`、`system-prompt.ts:99` | 原 `storage.computeNextRunAt` / pending notification scheduler；`host.ts:resume/armSchedules`、`store.ts:fireSchedule/settleCommand` | 已复用时间计算、单 deadline、错过区间合并、静默与真实退出状态。Grok 支持更广的 cron/event/cloud 常驻，本期仍是本机应用存活执行；群例行不因 UI 可见就算有执行支持，按原待评估范围记录。 |
| 浏览器与人工接管 | `sand-browser-tools.ts`、`sand-browser-use-subagent.ts` | `browser.ts`、`electron-browser-engine.ts`、`bot_request_browser_help`；复用本安装 Electron/Chromium 与文件句柄 | 本期沿批准的简单本地方案；已有页面/群成员归属、上传下载、接管等待及归还后新观测。与 Grok 远端截图、坐标/拖拽等能力不同，不能宣称全浏览器功能一致，也不为本轮增加 Linux desktop 或单独打包 Chromium。 |
| 技能与 MCP | `system-prompt.ts` MCP discovery/actual call、`managed-skills-service.ts` | 原技能解析/hooks、`createBotMcpScope`、用户可信 skill marker | 继续使用原注册/发现/调用；Bot 仅屏蔽共享电脑目标，避免越过本期页面归属。需复核 provider 名称启发式屏蔽是否过宽；未找到具体误拒实例前不扩成连接器分类系统。 |
| 恢复、退出、远端边界 | `run-scheduler.ts` generation、Grok 云端会话/升级边界 | 原 checkpoint；`store.ts:recover`、`local-service.ts:stopLocalBotHost`、`shared/bots/client-registry.ts` | 本地重启中断不自动重放外部动作，未知命令结果如实保留；远端 host/protocol 不匹配拒绝而非落回本地。与 Grok 云端常驻不同是一期约定；不增加远端服务或退出后独立 Host。 |
| UI / 头像与动画 | `frontend/.../workspace/{sidebar,composer,agent-avatar}.tsx`、`onboarding/signed-in/character.tsx` | `BotAvatar.tsx` 复用 vendor Grok kernel / adapter、共享预算时钟、可见性与 reduced-motion；现有群编辑器/消息投影 | 已有真正的参考内核，并非重新画近似头像；映射、光学尺寸、悬停与运行状态还须核对。旧重建 renderer 不能证明新版一比一；源码复核、静态截图均不能替代完整动画实测。 |

- [x] ~~1020W.1 建立上述跨模块源码映射、版本限制及确认偏差。~~逐处读取调用方与交付/存储接收方，不仅检查工具名称；官方群同题两段与本地四段的真实证据沿用 1020V。源文件哈希及位置记录到持久验收目录，不往源码目录生成扫描产物。
- [ ] 1020W.2 按上述最小范围先收敛群内公开交办/回传路径，并复核历史、文件、失败、取消、接续和私聊不回归；无效提示试验已撤回，不带入最终构建。
  - **1020W 子 Agent 同类缺口扩查（实施前）**：Grok `turn-toolset.ts:1373–1386` 不向临时子 Agent 注入 SendToAgent、CreateAgent、UpdateAgent 和 updateState；`sand-state-tool.ts:289–303` 明确后者包含记忆、例行和身份写入。当前 CMB Bot 的七项对应工具仍捕获父任务/父 Bot ID，子 Agent 默认继承，Host 因而只能看到父任务的权限。沿已验证的主轮工具 metadata 过滤和原 `getHookAgentIdFromRequest` 封闭这些入口；保留记忆检索及普通文件/命令能力，由父 Bot 执行持久修改。先以真实工具调用测试复现副作用，再验父轮成功、子轮拒绝、取消和原权限边界；不新增权限系统、存储或调度。W5B 的私有文本漏发与 W6 的明确读回遗漏另保留未通过，不能由本项替代关闭。
    - 确定性工具调用复现先2失败/23通过：子身份调用实际进入资料修改回调并成功落地合成记忆。修正后5文件162项、原运行图默认/显式子Agent边界合同及node类型通过；随后Bot主进程/共享契约全组27文件480项通过。写操作沿同一主轮metadata和owner校验，记忆读工具保留；未新增公共Runtime改动。证据 `identity-tools-red.log`、`identity-tools-green.log`、`identity-tools-runtime-contract.log`、`identity-final-bots-regression.log`。实机原身份/记忆/例行组合仍待本版复验，未据单元检查关闭产品案例。
  - **已撤回试验一**：曾让群结果不再创建 reply-outbox，交流历史改按公开结果主键读取；8 文件 264 项、node 类型检查、构建通过，原生边界另 46 项与普通线程架构通过，查询计划无新增整表扫描。但真实 W1 仍四段：没有回传任务，却由已有 discussion 再生成转述，未达到目标。现场与测试保留到 `1020W-source-audit/W1-ineffective-source-fix.json`。该试验的 Store/tools、关联查询及测试改动均逐字节撤回到本轮审阅起点；本轮之前已有修改保留。不能将上述局部测试记作现行修正或有效修复。
  - **已撤回试验二**：曾让群仅走已有公开 @ 群轮次，保留只读成员目录、移除群内私聊式委派工具，私聊不变；233 项、node 与构建通过。但原群原问法真实 M2.7 没有接力，反而回答“无法委派”并估算旧时间，降低了功能。`W1-public-room-failed.json` 保留现场；两份生产文件及两份测试的本轮改动均已撤回，Runtime/prompt 与审阅起点哈希一致。不能保留这版作为修复，更不能把没有调用同伴算作“输出少了”。
  - **后续按 Grok 的正式发言机制修正**：用户再次要求采用 Grok 做法。保留内部委派工具与原 Runtime；群的正式文字由显式发送工具进入现有群消息表，普通助手文本、内部交办和协作回执不自动成为公开发言。文件、问题、审批与浏览器接管继续用原组件/回执。先核实原 Runtime 完成检查的可复用点，再补仅 Bot 启用的有界“欠正式交付”检查；该检查只看真实发送回执，不判断回答含义或文件质量。不得新增模型执行器、消息数据库、轮次队列或语义去重。必须覆盖公开接力、内部交办后仍欠的汇总、私聊回传、待答/停止/恢复与原生线程默认行为，再做 W1/W2 和异常的官方同题；当前仍未完成。
    - 原接口核实：`agent/turn-completion-integrity.ts` 的原 afterModel gate 已有内部提示、model 跳转及有限重试机制，但尚无正式交付的检查入口；`additionalTools` 可以承载 Bot 发送工具。采用一个主模型专用的可选交付检查回调接入原 gate，普通线程不传、叶子 Agent 不继承，不另启模型回合/后台执行器。发送工具沿原 Host/Store 写现有群消息；仅新增 Bot 正式发言的窄接线。公开发送不操作共享工作文件，复用原 Bot 通信免文件锁分支，不能让群消息排在长文件操作后。
    - 无效版本已正常退出、重建并恢复至审阅起点预览；恢复前后 12 张控制表与 38 份记忆哈希一致。失败现场保留，不回滚用户数据，不提交/push。
    - 第三版源码：群专用 `bot_send_message` 沿原 Host/Store 写现有群消息，真实调用 ID 幂等；移除原“工具参数/普通模型文字自动公开”的接线及无调用的进度发布函数，历史公开行保留可读。内部委派、私聊回传、附件、问题、审批与失败回执继续复用原链路。原 Runtime 主模型 gate 仅增加可选发送回执检查，沿用原两次重试预算；普通线程不传、叶子 Agent 不继承，不判断消息含义或产物正确性。10 文件 365 项定向回归、node 类型及原消息回归通过；原 workflow 回归通过，构建与真实 M2.7 新版复验仍进行中。未计为产品案例通过。
    - 第三版首轮真实 M2.7 仍失败：root e386ab4a… 调临时 task 后内部委派，群里只有“等待回复”；同伴已返回 12:51:19 的真实结果，但 callback 误认为普通回复已发送并返回 pass。首次宽松允许内部 callback pass 是本轮新增缺陷，已保存 native 消息、控制记录与截图 `W1-explicit-first-failed.*`。修正为沿已有群消息按任务 ID/作者核对真实公开回执；未找到就不允许 pass，当前上下文仅列最新用户边界后的公开消息，不做文字相似去重。369 项、node 类型与 lint 通过；仍待新版同群复验，不能报通过。
    - 后续实测仍有反例，未覆盖掉首轮记录：旧群误沿用历史故障、未尝试现有工具；新建同 Bot 群中，同伴实际公开报时成功，但根任务的“必须自己发言”检查逼出等待和重复报时（`W1-fresh-first-result.json`）。参考 Grok 的异步 SendToAgent／独立群回合边界，在原 CMB 异步队列上收敛：实际配对成功的 `bot_delegate` 排队回执允许当前物理轮先结束，后续仍由原 Host 回执轮承担正式交付检查；不等待、不另建调度或文字过滤。仅声明交办、错误/未配对回执均不能通过。302 项定向通过，真实复验待做。
    - 同时定位到原 Bot wake 微任务会继承唤醒工具的过期 Mod scope，导致真实同伴正式发言被 `MODS_CALL_SCOPE_EXPIRED` 拒绝。沿原 CMB `AsyncResource.bind` 模式把新任务 tick 绑定 Host 生命周期上下文，不改 Mods 保护或授予额外权限；真实失败与恢复前数据保留。124 项 Host/原 Mods 边界和 340 项 Bot 邻接回归通过，私聊 M2.7 零工具 W3_PRIVATE_47 正常。Host 测试文件 4 条 lint 风格错误与审阅起点完全相同，新增生产源码及新增测试 lint 通过；不宣称整文件 lint 全绿。
    - 官方 W2 两份原件已通过正式保存按钮下载：`w2-peer.txt` 严格 11B／`W2_PEER_47\n`，`w2-summary.md` 47B，原文与“核验通过”均正确；不能据此宣称观察到官方远端每次读写工具。证据 `1020W-source-audit/W2-official-files.json`。
- [x] ~~1020W.3 补核首聊异常/重启、群旧轮次、MCP 与 UI 源码边界，区分疑点和确认缺陷。~~首聊入队失败会事务回滚，已有真实用户消息会抑制首聊；运行失败/重启后不自动再次引导，与 Grok pending 策略不同，保留 P1 体验差异，不为它增加重试状态体系。新群消息取消旧可选讨论，已获授权的直接任务沿原停止/新消息规则处理；旧 Grok `isCurrent` 仅在轮/成员开始检查，并不能据此声称它会拦截全部在途结果，不盲目丢弃本地真实交付。MCP 屏蔽依据 provider/tool 名称，存在名称误拒可能，但本轮未发现具体正常连接器被拒；不把假设当修复理由。头像确实使用 Grok 内核和 Hermes 预算循环，60fps 仅在可见且有动作时唤醒；完整动画/新版外观仍为待验。另复读本批公共 Runtime、问题工具/服务、流消息边界及原聊天组件 diff：Bot 选项由 source/可选参数启用，普通线程的默认 schema 保留；内部提示边界复用原判据，未新增提取/回放链。本轮不扩大这些公共改动。
- [ ] 1020W.4 源码修正与定向检查完成后，按功能链集中执行 MiniMax-M2.7、官方 Grok 与必要的原生线程案例；保留首轮质量、交付原件、失败与差异，不把源码对照当实测完成。

#### 1020W 独立复核（用户要求接手检查 Sol 的实现）

- **参考边界**：提供的是 Grok 0.18 reconstructed 源码；当前官方应用为 0.71.2。源码机制与当前应用实测分别记录，不宣称两者逐字相同。`group-chat.ts:15–17`、`group-chat-orchestrator.ts:95–116` 区分普通内部文本、正式发送及 pass；`host-runner-composition.ts:2587–2620` 仍绑定成员的 AgentStore 并保留群成员 Runtime，群不是无状态会话，也不是删除内部委派能力后的阉割模式。Grok 的交付欠账校验受实验开关控制，当前 CMB 的有界检查属于本地适配，不能称为照搬官方默认设置。
- **两条核心实测应分开评价**：旧群最新 W1（`W1-context-order-final.json`）仍直接声称无法委派，未实际尝试委派；因此历史排序修改没有解决这条反例。新群 W1（`W1-context-order-fresh.json`）确有同伴任务和回传，只公开一次结果，但由发起者转述，与官方“公开交办→同伴自己回复”的路径不同。不得删除旧历史、减少工具或隐去失败来取得通过；W.2、W.4 保持未完成。
- **已核实的有效结果**：W2 本地实际委派→同伴写/读/交付→发起者读/写/读/交付，三个任务完成、八次真实工具、两份附件，无重复附件。UI 下载的 `w2-peer.txt` 为 `W2_PEER_47\n`、11 字节，与官方原件 SHA-256 相同；本地摘要33字节与官方47字节均含原文和核验结论。证据 `W2-async-live.json`、`W2-local-files.json`、`W2-official-files.json`。该结果来自此前构建，不冒充后续每次改动的复验，也不能关闭其他编程质量案例。此前 27 文件468项源码回归通过，不增加34/201闭环数。
- [ ] **复核修正：Bot 公开 @全员接力**。确认原 `bindBotGroupMentions` 不识别 `@all/@everyone`，调度也忽略既有 `botId:null` 的全员语义；Grok `parseGroupMentions/resolveResponders` 支持。仅在原解析器绑定显式全员提及（兼容现有中文“所有人”），原调度将当前群成员加入既有集合；沿用原队列、成员检查和轮次上限。邮箱、长同名前缀、不在群内成员不扩大路由。源码修正与确定性回归已完成，M2.7/官方界面复验待做。
- [ ] **复核修正：正式发言中的 pass 不成为公开消息**。新增发送工具此前会把可选讨论的 `(pass)` 写入群历史，而 Grok 调度会滤掉。现在仅可选讨论/内部回执轮返回不可见的工具回执，完成检查仍核对当前任务/群/配对调用；没有已公开同伴结果的 callback 仍须交付，不可借静默吞结果。直接用户要求的字面答案不被过滤。未改普通 Runtime、私聊、数据库结构或调度体系。源码修正与确定性回归已完成，真实模型复验待做。
- [ ] **复核修正：提示与实际工具不一致**。`runtime-adapter.ts` 的可选 discussion 不注入内部协作工具，Store 也禁止其另开委派链，但 `prompt.ts` 新增的通用群段落却承诺 `bot_delegate remains available`。删除这一句重复且不准确的承诺，保留实际工具说明及公开 @ 接力；测试先红后绿。不因此改变原授权或放开第二条执行链。Grok 群成员完整工具与本地可选讨论的能力差异仍需按实际任务核实；目前没有证据证明这一句就是旧群拒绝接力的唯一原因，不能报根因已解决。
- [ ] **后续复核：每个群成员轮次的当前名单**。Grok `buildGroupMemberSystemPrompt` 每轮传入当前 peers；本地原本只在首次用户任务中写名单。现在复用 `Host.peers(task.id)` 在当前群系统上下文注入实际名单，原有私聊不调用；仅4行生产接线。新反例先1失败/100通过，修正后6文件170项及类型通过；构建、正常退出/重启前后12表/38记忆逐项一致。证据 `roster-red.log`、`roster-green.log`、`review-roster-manifest.json`。不能单凭这个修改声称旧群接力已修复。
- **W4 首轮反例：临时 task 子 Agent 继承了父 Bot 的公开交付能力**。官方与本地同题“请另一位 Bot 自己在群里回答23+24，不要转述”；官方公开交办+同伴答案两段，本地先由临时 general-purpose 子 Agent 调绑定父任务的发送工具，以父 Bot 身份公开47，再公开@真正同伴，造成第三段重复。`W4-review-result.json` 含实际 task 与子/父调用回执，`W4-official.txt` 为官方界面。确认是本轮新增发送工具的继承接线遗漏；群能力真实可用，不能继续把该反例归因于无法委派或渲染。Grok `turn-toolset.ts:1373–1386` 明确只向非子 Agent 提供 SendMessage、SendToAgent、身份管理；原 CMB 已有独立 `subagentDefaultTools`。最小修正：利用原工具元数据标记公开发送/附件交付仅主轮可用，原子 Agent 工具装配时过滤；回调再使用原 owner 标记拒绝越界调用。子 Agent 保留原文件/命令工具并私下返回结果，父 Bot 正式交付；不删除原子 Agent 功能，不改模型循环、队列、存储或文本去重。修正与复验结果见下一项，首轮反例保留。
- [x] ~~W4 子 Agent 公开交付越界修正及复验。~~沿原工具 metadata 标记两项父轮交付能力，原 `createDeepAgent` 在默认/显式子 Agent 工具装配与 Mod catalog 中剔除；调用端复用原 owner 元数据拒绝越界。两条反例先2失败/28通过，修正后4文件168项、真实默认/显式子 Agent 图合同、类型及完整原 `test:workflow` 通过。所改生产模块/近邻测试 lint 通过；原 runtime-final-system-prompt 测试文件的1条 no-regex-spaces及10条格式警告在本次审阅起点完全存在，日志保留，未顺手改无关行。新版 W4 原题重复被模型当作旧题完成说明，未发生接力，不能记通过；更换为双方相同 W4B（53+19）后，本地实际 task→公开@真正成员→同伴自己公开72，只有两段，与官方一致；末轮 pass，不再出现子 Agent 冒充父 Bot 的第三条答案。证据 `child-delivery-red.log`、`child-delivery-runtime-contract.log`、`child-delivery-workflow.log`、`W4-child-delivery-result.json`、`W4B-child-delivery-result.json`、`W4B-official.txt`。只关闭该继承缺陷，不关闭旧W1及整条群协作。
- **W5 全员行为仍有缺口**：官方 W5 输入编辑器自动把正文中的@all变成用户提及，另用无正文@的新题W5B区分Bot公开交办。本地W5B发起者列出两位准确成员公开交办，同伴正确答自己的名称/W5B_OK；发起者后续pass，漏自己的一条标记，官方两位均答。未走本轮新加的Bot字面@all分支，因此不能用此题将该分支实测勾选。`W5B-child-delivery-result.json`、`W5B-official.txt` 保留差距，不以无重复代替全员完成。
  - **W5B 原始消息复核与修正范围**：根任务实际已在普通 final 文本写出自己的 `W5B_OK`，但没有第二次正式发送；下一轮误把该私有文本当已公开答案。不能归因为调度未唤醒或只需放宽 pass。Grok `send-message-reminder-middleware.ts` 和 `turn-runtime.ts:ensureUserReply` 对未发送结果做有限提醒，但 `turn-shape.ts` 的具体判据也不直接覆盖本例；不宣称照抄即可解决。沿本地已有 `checkFinalDelivery`，在有公开回执后仍出现非空普通 final 时提醒一次协议纠正（受原两次总重试预算约束）：有新结果则实际发送，已交付或只是内部想法则空回复结束。内部委派的私有结果、已排队的异步交办及可选 pass 沿原边界保留，不自动发布 final、不判断答案语义、不增加执行循环或状态表。真实旧群复验前仍未完成。
    - 反例先1失败/11通过，修正后7文件336项（含原完成检查、群轮次、Host、工具和记忆）通过，node类型/lint/构建通过。正常退出再启动，12张控制表与38份记忆快照逐项一致；本版哈希 `final-delivery-manifest.json`。真实复验尚未发出：电脑工具在官方和本地均返回 `noWindowsAvailable`，能截图但无法输入，已请求保持解锁/置前；不将工具点击尝试或旧版本样本算为本版通过。
    - W5C 新版实测仍失败：提醒后根任务确实第二次调用发送工具，将自己的标记公开，但随后的私有“已发送”又触发同一检查，耗尽预算、误报任务失败并停止同伴轮次。这是本次适配引入的过严结束判据，不是模型没发工具或 Grok 默认行为；`W5C-final-delivery-result.json` 与实屏保留。收敛为核对已有内部交付提醒之后的新成功发送回执，已纠正发送就允许结束，不因私有确认再次失败；只用当前消息序列，无新状态。该反例1失败/11通过→3文件111项通过，类型/构建通过；本版 `final-delivery-ack-manifest.json`。W5D双方同题复验进行中，旧失败不删除、不改任务状态。原生问题卡/取消/checkpoint/流投影另10文件132项通过，证据 `recent-native-boundaries-regression.log`。
    - [ ] W5D 阶段性复验结果保留，通用漏发/结束误判项重新打开（用户真实问候已推翻该检查的通用正确性）。同一旧群保留所有失败历史，双方相同题目换为W5D标记。官方公开全员交办→发起者标记→同伴标记三条；本地也恰好三条公开消息，均有真实成功发送回执，3个任务全部completed，末轮pass，不再出现失败卡或重复转述。根轮在已有提醒后真实补发自己的答案，检查允许结束；同伴的私有重复final经提醒后pass，没有额外公开内容。证据 `W5D-final-delivery-result.json`、`W5D-final-delivery-preview.*`、`W5D-official.txt`。此项只关闭该漏发/误判，不关闭Bot字面@all分支及全部群质量。
    - 原始“让另一个bot告诉我几点了”同旧群再验：本地已公开交办→真正同伴自己回答，3任务completed，无重复转述或错误卡，与官方两条公开消息的路径一致；但同伴未取工具而报了过期14:16:34，实际本轮为15:03，官方报15:04。因此传递路径改善，时间内容质量不通过；根轮临时子Agent曾给出正确15:03，不能拿它的私有答案冒充同伴交付正确。原Runtime每次构造新的时间环境、线程agentMode为normal；目前没有直接证据证明公共时间接线失效，不盲目改原Runtime。证据 `W1-after-final-delivery-result.json`、`W1-after-final-delivery-official.txt`，仍保留质量差距。
- **W6 临时执行与文件回归：产物通过、过程未通过**：本地原子Agent实际write_file，父Bot仅交付一个附件；从正式页面打开并保存的12字节文件 `W6_CHILD_72\n` 与官方下载原件SHA-256同为 `c3351e8846b2b3245a0f3c4dc17371ef51766741dca64e9676b1c0a9d394b575`。证明工具过滤保留真实文件工作与父轮交付。本地首轮子任务描述遗漏读回、子/父均未执行题目要求的内容读回，只有task→bot_deliver_files，不能把附件存在/元数据校验计成内容读取；该质量反例仍未关闭。官方只可见附件与进度，不宣称掌握其远端全部读写。证据 `W6-local-native.json`、`W6-local-child-transcript.json`、`W6-local-preview.txt`、`W6-files.json`；不得修改模型原件或用独立验收补读冒充模型完成。
  - W6B本版首轮：父Bot已实际read_file后单份交付13字节文件，实屏打开/保存成功；子任务仍只收到“写入、返回路径”，实际子回执只有write_file，漏掉用户指定的子层读回。Grok `sand-multitask.ts:EXECUTOR_SUBAGENT_DESCRIPTION/SAND_MULTITASK_PROMPT_SECTION` 明确临时worker从空上下文开始，派发必须包含具体目标、上下文及success criteria。原CMB主提示仅泛指“格式/结构”，当前Bot质量段也只要求最终验收；在既有Bot质量段补上完整派发契约与验证责任，保留原task工具、文件工具及父轮交付。先检验正反提示合同，再用新文件做同题实测；没有实际改善就撤回本次提示试验，不新增产物语义裁判或独立执行器。W6B证据 `W6B-local-native.json`、`W6B-local-child-transcript.json`、`W6B-local-preview.txt`，首轮仍不算完整通过。
    - W6B双方原件已从真实交付卡保存，均为13字节 `W6B_CHILD_83\n`，SHA-256同为 `c2ea8cb4f98f2ec52c39284db018c953b34bee25ef492d3e2e6fb642d6c18f95`；过程遗漏仍未关闭。证据 `W6B-files.json`。官方验收曾因一次过期控件点击误触语音界面，界面已确认结束且恢复空输入；记录保留为验收操作错误，不作为模型行为/产品差异证据，也不删除历史。保存按钮一度灰置时取消后重开成功，没有修改应用或系统权限。
    - **派发提示试验已撤回**：候选版提示合同1失败/10通过→4文件144项通过、lint/构建通过，正常重启12表/38记忆一致；W6C实际仍派发同样的“写入、返回路径”，子Agent仅write_file，父Bot read_file→单份附件，未改善。新增提示句与对应试验测试已精确撤回，原有提示改动保留；证据 `delegation-spec-*`、`W6C-local-native.json`、`W6C-local-child-transcript.json`。不以144项绿或父层读回替代子层验收；下一步原生同模型对照，不继续堆叠提示。候选预览待正常退出/重建恢复后再验，其任务/文件历史全部保留。
- **验证及保留项**：新增复现先为5失败/46通过，最终6文件169项邻接回归、所改文件lint与diff空白检查通过；日志 `review-red.log`、`review-prompt-red.log`、`review-final-green.log`。首个类型检查命令漏了项目脚本要求的 `--composite false`，其 TS6307 不能报成产品缺陷；按原 `typecheck:node` 参数重跑通过。相对本次独立审阅起点，生产修改4文件、增加31行/删除1行（其中一行是移除长提示中的句子），没有修改公共Runtime。本次审阅基线备份在仓库外 `1020W-source-audit/review-baseline/`，未清理用户数据、未重置历史、未提交/push。该段记录时预览仍是此前构建；后续已装入的版本和真实反例/复验见W4—W6记录。后续优先解决旧群接力与公开交办路径，暂不追加长提示或引入新编排系统。

### 2026-10-19 全已实现功能对照验收（1019FB，用户要求）

本轮完整案例见 [Bots已实现功能与官方Grok对照测试](cmbdevclaw-bots-grok-comparison-tests.md)：A—P共201例（执行中新增后台通知B15），覆盖功能、任务交付、UI／动画、异常／恢复、隔离／资源及原工作台边界。逐项保留官方应用实测与源码依据；先保存反例再最小修正，完成闭环后才更新状态，不把设计／历史局部通过当成本轮通过。

2026-10-20 按用户最新“使用minimax2.7吧，便宜”要求，后续真实模型实测统一使用已有 MiniMax-M2.7（1020R真实请求已成功），替代此前本轮 MiniMax-M3、随后DeepSeek的单模型要求；各模型历史结果和失败原样保留，不混记。仅切换本轮合成测试 Bot 的模型，不修改正式模型或凭据配置。真实交付必须核对文件与独立验收，不低于官方及原生线程；发现差距立即定位／修正／复验，不扩展另一套执行或真假判断机制。只有按既定本地架构允许的差异或真实外部阻断单列；Windows／完整动画观测不足不能计通过。每批报告设计数、实际执行数、通过数、失败／阻断数及证据，不给无分母的完成百分比。未授权commit／push。

- [x] ~~1019FB.1 基于主plan和现有入口设计200例、冻结数据与验收判据。~~最初200例ID已核对唯一；执行中新增B15后为201例，146 P0／55 P1；明确双方相同输入、首轮／修订分记、Q-AMOUNT原43项及85项扩展、长程质量、源码复用与最小修正要求。补充CSV、长程看板／修订、预埋缺陷和50文件题的具体操作稿；该勾选仅代表设计，执行状态逐行另记，不能计为产品验收完成。
- [ ] 1019FB.2 核实M3真实可用，执行首批已知失败／核心P0，与当前官方同题对比；修复并复验后逐项更新案例。
  - 已完整关闭A04创建校验／取消／草稿、B01问候计算及追问、C09待答时新任务优先、D02群内全员各答一次、D03定向隔离、K01金额完整交付及F01保存／F02检索／F03范围与明确格式，及F04修订／F05面板并发保护／F06重启读取／F07私聊与群隔离，共34/201例（新增B02多轮更正与切换接续；新增G06私有输出副本交付；新增E03群文件交接；新增G03同名附件移除发送；新增B10失败后接续、G01/K07附件核算及I01一次提醒；新增J08原设置回归、F12临时记忆、B14纯文本及B03/B04/K13长任务及C08双Bot独立待答，及C05多选／多题、K03／K04长程看板、B15后台三分支／重启、C04鼠标与键盘选择、C06私聊多行自填）。K01干净私聊双方43/43＋85/85，README M3 18/18、官方9/9；CMB定向群43/43＋85/85、自测32/32、README26/26、三原生下载字节相同，未提及A无本题任务、讨论游标结束。官方群首轮仅交源码／测试，代码同样43/43＋85/85但尚缺README／结论；先保存原件再于1:37发缺项反馈；1:38:28仅补README与结论，保存后9/9文档及41/41自测通过，首轮缺项仍保留。首轮缓存依赖缺失和原题歧义保留。
  - 续验：M3重启后真实get同一记忆／版本，随后对话同ID青桐→银杏、面板银杏→松柏；新任务实际get当前版本并准确输出松柏／15:07／3.50。内部ID提示一词修正加载后的真实remember回复未再暴露ID。首题石湾多加的是项目名称、并非旧记忆代号；明确禁止项目名称后的同题双方均严格一行，不据措辞差异增加输出过滤或分类规则。官方更新与客户端重启查询继续核对。D08辅助点击误判已撤回试改，原组件真实鼠标选B→M3独答61，稳定ID正确。
  - 新原生M3基准与Bot私聊／群同题均43/43＋85/85；原生50自测结论、17次真实工具及目录外/tmp/big.txt写入负例保留。该原生任务遇到截断续跑，实际图38条但消息库971条；114份checkpoint重放复现1510条，根因是内部完成性Human提示被误作新用户。只复用原shared内部提示判据统一两处流式边界，重放恢复37条可见记录。Grok参考abstract-user-message-action-handler.ts:490的交付检查亦跳过isSimulatedMsg；这里保留原CMB执行链与既有消息／存储，仅修正内部提示的边界归属。两个最小回归及其他153项通过；并行一项序列化测试超时，独立15/15通过，原日志保留。node类型与原消息回归通过；web／构建／真实M3修正版待验，不标关闭。无commit／push。
  - 修正版真实M3原生新题已完成，26次工具、图与落库均54条、provider无重复，43/43＋85/85通过。本次未重新触发截断，分支证据仍为先前114份真实checkpoint重放和两个最小回归；旧坏历史保全。web检查／构建通过；正常重启控制库逐表和记忆哈希全同。双方私聊／定向群均无法取得另一Bot未分享记忆。相同冻结完整看板题已发双方群B，M3任务f7613d12…已完成；先冻结独立API判据，再核查源码、真实页面与zip，完成后才做K04修订。F05真实面板旧草稿保存被拒绝，草稿保留且白鹭新值未被覆盖；重开最新值并明确合并后保存成功。双方看板独立API均55/55、自带测试M3 37/37／官方8/8；真实页面新增／编辑／完成／恢复／筛选／刷新及HTML纯文本均通过。M3首轮交八附件且zip七源码字节匹配，官方首轮仅zip，首轮缺项保留；页面错误与八份下载已核对通过，尚待具名合成页面任务删除确认、README逐例及K04修订，K03不勾选。另发现M3两条后台清理通知重复收尾，正在按Grok忽略已知通知与现有静默能力修正。
  - 后台通知续验：原先仅系统提示的修正群内通过，但私聊M3仍发“简短确认”，activity版本10→11，首轮失败及思考回执保留。该系统静默扩写已撤回，改按Grok在每个合成完成事件中重申已知结果不复述；复用原通知正文、静默标记和origin_json，增加Host从真实exitCode生成的commandSucceeded控制事实，退出非0／未知／旧缺失事实均不能进入静默投影。不新增表／查询／队列／执行协议；相关正反例先红7失败／130通过，后续类型、回归与新M3实测进行中，B15不勾选。内部ID／工具名原提示收敛后，新M3私聊启动说明已不暴露UUID；其他私聊文件／失败回报仍待逐字核对。
- [ ] 1019FB.3 继续覆盖其余已实现功能及UI／动画、恢复／资源／原功能；任何未测或失败保留明确状态。

### 2026-10-19 隔离测试数据保全（1019DK，先处理后继续新建 Bot 对照）

2026-10-19 后续 DJ6 重启时，隔离启动器的 CMB_COWORK_AGENT_HOME 与 Electron user-data-dir 已一并改指持久目录的真实路径；临时区符号链接仅用于旧记录兼容。未修改产品默认数据目录或用户正式配置；真实双模型恢复、旧绝对路径附件、原数据与草稿复验通过。删除来源仍未定位、20 个旧样例仍无法精确恢复，这两个边界不变。

- [x] ~~保全发现时仍存在的数据并核对丢失范围。~~ 零点后的快照比 1018DI 终态少 51 份旧工作文件，原 Bot／任务／群／例行与命令记录未变；259 份其余工作文件及记忆内容哈希一致。已将它们及只读 SQLite 备份存入用户持久目录，未复制凭据配置。之后用户自行新建的 3 个 Bot 与其 3 份工作区初始化文件单独保留，不回滚为旧快照。
- [x] ~~将长时间使用的隔离预览目录移出 `/tmp` 并复核兼容性。~~ 正常退出并确认全部预览进程结束后，在同一卷整体改名至 `~/.local/state/cmbdevclaw-beta-preview`，旧根保留兼容链接；10,521 份现存普通文件的 inode／大小／mtime 一致，两份主库迁移前后哈希相同。没有直接改写应用数据库或正式配置。随后按原应用 API 打开会话和运行新验收任务；44 个 Bot（含用户新建 3 个）、11 群、13 例行、35 命令与原 1,078 条任务均保留，原 5,854 条消息头未变。私聊 39 字符草稿完整；群输入原本为空，占位文字不是用户草稿，保持为空。正式产品默认根为 `~/.cmbcoworkagent`，未增加产品清理、保活、备份线程或轮询。
- [x] ~~恢复有字节依据的原件并列明未恢复项。~~ 31 份原件来自既有副本或持久工具输入／读回记录，均与丢失前 SHA-256、大小精确一致；262 份恢复前现存文件未改。剩余 20 份（含 9 份初始化标记和 11 份旧测试资料／脚本／结果）没有可验证副本，仍标记缺失，不重新生成或重跑旧任务充当恢复。恢复记录仅表示数据恢复，不算模型重新完成交付。
- [x] ~~修复迁移暴露的等价路径兼容问题并实屏复验。~~ 首次两条新任务在原目录栅栏处被拒绝，尚未调用模型；旧绝对路径附件也曾被词法边界拒绝，失败现场保留。Bot 接线仅在旧元数据路径经 realpath 指向同一 host-owned 工作区时，沿原 updateThread 归一化，原 Bot／Host／群身份与执行前栅栏不变；绝对文件别名仍须通过原真实目录及稳定句柄校验，普通相对路径约定不变。128 项文件／Bot／原预览边界测试、node 类型检查、lint 与构建通过。新版真实 MiniMax／DeepSeek 各一次创建→读回→交付、再各一次只读→交付，工具顺序与真实回执核实；两份 10B 原件已实点打开，旧 DD 绝对路径附件和恢复的 1014L 报告实际打开通过，普通 CmbCowork 线程已有 BK_NATIVE_DS 文件也实际读取通过。24/24 保全与任务断言通过；无新增后台命令、模型配置或历史任务重放。证据位于持久目录 `quality-review/1019DK-test-data-preservation/`，首次失败保留，不宣称 Windows 已验收。
- 清理来源仍未确证：丢失同时影响工作区与工作区外旧验收脚本，目录变化集中在 00:00；系统日志没有提供删除进程证据，不能确定归因于 macOS、模型或应用。此前真实通过记录按当时证据保留，后续文件保护以如实记录的当前基线为准。

### 2026-10-18 阶段推送

按用户“先 push 当前变更再继续”的要求存档。本次包括 Bot 记忆提案复核、资料变更回执与错误恢复、MCP SDK 传输错误识别、工具记录折叠、Grok 浮层／头像选择样式，以及思考空白与滚动回跳修复；临时诊断已从源码及暂存区清除。提交前完整 node／web 类型检查、42 文件 468 项定向回归、原 `test:messages`／`test:workflow`、MCP fallback 与增量消息投影检查均通过；当前正常构建与已做 MiniMax／DeepSeek 实测的源码／产物哈希一致。1018CG 技能选择实测仍未完成，后续继续；Windows 实机、完整 Grok UI／动画及其余未勾选项保持未完成。本次为阶段存档，不代表一期全部交付完成。

### 2026-10-15 阶段提交

按用户要求，在继续下一轮工作前提交当前 beta 实现及验收记录。本次包含本地 Bots 工作区、原 Runtime 接入、记忆/协作/例行任务/浏览器、Grok 角色动画与群聊交互等已实现内容，以及本轮左上角安全区域、折叠栏提示和富文本提及改进；这是阶段存档，不代表一期全部完成。未勾选验收、1015Q 旧群交付差异、全库回归失败及 Windows 实机等剩余项继续保留。最近本轮 35 项定向测试、web 类型检查、消息回归、构建和真实 MiniMax 1015W 定向交付通过；新编辑器的完整附件/IME组合仍待完成。

### 2026-10-16 阶段推送

用户要求先提交推送再继续。本次保存当前 Bot 群聊/引用/资料、记忆变更通知、身份管理、头像/消息动画、执行记录折叠与真实模型验收进展；完整 node/web 类型检查、50 个测试文件共 362 项 Bot/IPC/共享与界面派生回归通过，原消息回归和最新构建亦已通过。差异凭据格式扫描未检出，不包含测试配置或模型密钥。未勾选的核心场景、待回答面板展示、整体动画及 Windows 实机等继续保留；本次为阶段存档，不代表一期交付已完成。

### 2026-10-15 长程任务归因核实（不将模型与 harness 混为一谈）

> 用户最新优先级：harness 问题暂缓，先继续一期目标；本节仅保留证据，不扩展公共安全规则改动。

- CLI 拒绝 `--input -` 是生成实现及自测覆盖缺陷；`write_file` 覆盖已存在文件被拒绝是正常保护，重复误用该工具是模型纠错问题。
- 两次重写命令被提示“forced git add”是原 `exec-policy.ts` 的实际误判：仅对 `cat > /tmp/synthetic-policy-probe.mjs << 'EOF'` 加普通 `Set.add('input')` 内容做 `assessCommandSafety(..., {shellSyntax:'posix'})` 分类（没有执行命令），仍返回 forbidden／forced git add。脚本数据中的 `add` 和复杂语法被保守 Git 检查误识别；此文件相对 HEAD 无差异，属于存量规则，不能说成 beta 新增 Runtime 接线所致。后续按最小复现修复，保留真实 Git 拦截和审批；本轮未改公共安全规则，不将它记为已修复。

### 2026-10-14 工具锁审计：区分存量风险与现场根因

- [x] ~~核对锁实现来源和队列作用域。~~ Git 基线 `c77230722` 的 `AsyncRWLock` 已无等待取消／超时机制；普通线程也跨轮次复用 thread 锁。本期新增私聊 Bot ID／群 ID 作用域，群内共享目录的写互斥不能直接删除。Bot Host 同时最多执行同一 Bot 的一个任务。
- [ ] **现场根因尚未确认**：持续显示 RUNNING、没有 RAW RESULT 不足以判定卡在锁获取。需要关联具体调用、锁持有者、工具执行与结果传输记录。不得据此认定 Bot 接线错误或原有会话不受影响。
- 基线锁隔离复现：独占调用持锁时，排队读取不会因外部 AbortSignal 取消而结束；释放独占锁后，读取回调仍可进入。这证明锁层取消边界风险，不等于真实工具绕过下游取消检查，也不证明本次现场根因。
- 按用户“不能过度设计、不能影响已有功能”的要求，撤回本轮公共锁修复试验（取消接线、固定超时均未保留），原 Runtime 与 Bot 队列接线维持本轮审计前状态。优先定位现场，再决定针对性修复；本项不计为已修复。


### 2026-10-14 用户实屏纠偏：完整功能、细节与交付效果验收门槛

本节先于后续编码更新。用户指出的问题是必须修复的实例，不是完整缺陷清单；实施者需主动遍历同类入口与状态，不能等用户逐项指出。以下要求关联既有 P02—P12，不扩大已明确的二期范围，也不以 UI 工作替代记忆、协作、恢复或任务质量验收。

**执行次序：核心使用流程 → UI → 动画 → 真实任务交付质量 → 全面缺陷与资源检查。** 阻断当前功能的缺陷在当前步骤直接修复。每项保留“源码依据／已实现内容／真实验证／剩余差异”，只在对应验收完成后划掉；旧记录中的局部通过不代表本节已通过。

#### A. 本轮截图已证实的差距（均须修复并复验）

- [ ] **D01 头像视觉一致性（P09）**：逐一比较全部头像的轮廓、圆角、饱满度、眼睛大小/间距/朝向、颜色、倾斜与留白；核对列表、置顶、群组合头像、聊天头部、详情与选择器的不同尺寸。新增圆润曲线属于实现进展，尚不能称为与官方相同；须将同形状、同颜色、相近姿态的实屏并排核验，避免拿不同姿态解释全部差异。
- [ ] **D02 折叠侧栏及提示（P09）**：对照收窄宽度、头像大小与间距、分区分隔线、置顶标记、选中/未读状态、底部入口和溢出提示；鼠标悬停及键盘聚焦时显示可辨认的 Bot/群名称提示，位置、延迟和淡入淡出按官方行为核对。现有 HTML title 不视为已实现 Grok 的提示体验。展开/折叠、拖动、滚动及重启不能丢失选中项或宽度。
  - [ ] 2026-10-14 补充：悬停卡片需包含小头像、名称及最多两行消息摘要；复用当前会话摘要，不额外读取完整聊天。官方 renderer `uE`/`t3e` 提供身份、草稿/等待/消息预览和 140 字符上限参考。
  - [ ] 2026-10-14 补充：可视范围外存在未读会话时显示蓝色上下跳转入口；点击只定位最近未读项，不自动打开会话或标记已读。官方实屏 AX 为“更多未读消息（below）”，源码 `R0`/`Ht` 按上/下方向定位最近未读行，并非通用滚到底部按钮。复用现有 activity.unread，覆盖展开/折叠、滚动、尺寸变化与已读后消失。
  - [x] ~~摘要提示与双向未读跳转的基础实现、折叠实屏验证。~~ 复用现有 Radix Tooltip、Bot/群头像、activity.preview/unread；提示增加身份行和两行摘要，列表按屏外未读显示上下蓝色入口，滚动/内容与窗口尺寸变化重新计算，不增加轮询或独立未读存储。预览窗口实际将“群附件验收-1013AJ”及置顶“协作核验-1013AJ”分别临时标为未读，验证向下/向上定位后仍停留“核算助手-1014AK”、未读不变；恢复原已读状态后入口消失。键盘聚焦实际截图确认小头像、名称与消息摘要。列表宽度 Right 展开至 218、Home 折叠至 88 通过；相关 8 项测试、web 类型检查和构建通过。未读折叠分组自动展开已实现但尚未实屏核验；等待/草稿提示优先级、明色与不同尺寸精细对照仍未完成，D02 整项保持未勾选。
  - [x] ~~1016BB DeepSeek V4 等待状态与草稿提示优先级。~~真实任务69566ae9…调用一次原request_user_input并等待；键盘聚焦折叠头像时，未发送合成草稿存在仍显示“等待你确认”。实际选择“简版”并提交，DeepSeek准确复述，已回答历史卡保留真实答案；任务completed后同一头像提示恢复“草稿 BB_未发送的合成草稿”。本次草稿已清空，侧栏保持80px；六份BA编程原件与两份记忆哈希未变。证据quality-review/1016BB-waiting-preview/{before,after}.json。仅覆盖该交互，不代替完整悬停录屏、明色或Windows。
  - [x] ~~1016BD 折叠分组的屏外未读跳转实屏。~~正式界面将既有合成群“身份群核验-1014AV”临时标未读、折叠“你好”并滚至列表下方；实际出现“更多未读消息（上方）”。点击后自动展开分组、聚焦并显示目标头像，主会话仍为DeepSeek，控制库attention=50/seen=49，未被误标已读。随后原菜单恢复已读，seen=attention=50，入口消失；分组展开、80px宽度保持，无新任务。证据quality-review/1016BD-collapsed-unread/{before,located,after}.json。此项验证既有实现，没有新增生产代码，也不代替所有主题、窗口和动画核验。
- [ ] **D03 群聊内容与输入框对齐（P05/P09）**：对照群消息区域、头像列、输入框的共同内容宽度、左右留白、底部间距和详情栏开关后的布局；覆盖宽/窄窗口、展开/折叠侧栏、多行输入与附件，不用固定偏移补一个截图。用户截图所示额外左右空隙是待修复问题。
- [ ] **D04 群聊 @Bot（P05/P09）**：输入 @ 弹出本群成员候选，支持名字筛选、键盘上下选择、Enter/Tab 确认、Escape 关闭、中文输入法及粘贴；插入可辨认的成员标记，并以稳定成员 ID 派发，不仅渲染蓝色文字。核对多人提及、所有人、未提及、重名、改名/退出群后的行为；以官方实测确定默认收件语义，不自行假定。现有成员选择条不能替代 @ 交互；发送后只由正确成员执行，不误发群外 Bot、不把普通文本误识别为指令、不重复派发。草稿、附件、回复与异步协作须一起验证。
- [ ] **D05 头像及界面动画（P09）**：对照悬停注视/强调、移出回正、运行姿态、思考/搜索/写入、等待审批、完成/停止/失败的过渡；检查快速移动与状态反复切换无跳变。消息出现、菜单/提示、面板开合、列表与输入反馈也需逐项核对。截图只能验证静态外观，不能替代动画过程验证；不能因已有 spring 或 60 Hz 时钟就判定一致。

- [x] ~~D04 四种收件路径与官方同题对照：未提及、所有人、单个、多个成员。~~ 1015L—O 均通过正式输入框发送，真实 MiniMax 在本地三人群分别只产生 3／3／1／2 条 completed 任务和同量回复；17+28、9+16、11+24、13+18 均正确，当前名称与持久作者 ID 一致。官方 Grok 合成三人群分别由全员、全员、sean、New Bot 与 sean 回复，收件语义一致；原草稿 `ch` 已恢复。收件、提及范围、实际线程与结果存于隔离 `quality-review/1015L-group-recipients/evidence.json`。本轮同时修复候选选择／Escape 后，同位置清空重输 @ 不再打开列表的问题，只在 Bots 输入编辑时解除该次关闭状态；重载后实屏验证重新开启、上下选择、Enter／Tab 确认与再次发送通过。20 项提及／群草稿回归、web 类型检查及构建通过。中文输入法、附件组合和退出成员后的完整交互仍待核验，不勾选整个 D04。
- [ ] D04 输入框成员原子标记（实施前记录）：参照 Grok `rich-text-editor.tsx` 的 Tiptap 受控编辑器、Mention 节点与原生撤销/输入法处理，将现有 textarea 高亮替换为带头像和名称的完整提及节点。仅加载 Bots 群输入需要的编辑能力，继续使用原 `text + mentions` 草稿、成员 ID、附件、引用和服务端校验；不保存第二份富文本、不改原聊天输入框或 Runtime。普通粘贴的名字不生成收件权限。验证整项删除/撤销、多人及所有人、换行、选区编辑、输入法、切换会话、重载与发送后清空；未完成前保留未勾选。
  - [ ] 1019DV 当前官方退格语义及原子提及组合续验。官方0.71.2合成双Bot群实屏：选择成员后先删除尾空格、再退格，成员节点退回普通“@”并重开候选；撤销恢复原成员头像／名称。普通粘贴“@名字”仍为文本，不自动生成身份。重建库rich-text-editor.tsx的PromptMention沿用Tiptap Mention默认行为；本地自定义Backspace会直接删空，须仅修正此差异，保留原ID、草稿、派发与原生历史。用实际ProseMirror事务验证退格解除身份、后续成员范围、撤销／重做及选区边界，再对照真实双模型附件定向发送；未完成前不划掉，不据此勾选整个D04或IME。
    - [x] ~~退格退回触发符、原生撤销及真实成员ID恢复。~~ 仅调整现有群编辑器删除命令：Backspace将成员原子节点替换为普通“@”，解除原ID；Delete保持整项删除，普通文本及非空选区仍由原编辑器处理。原生历史恢复完整节点，不按显示名称重建身份。实际ProseMirror事务覆盖后续提及范围、收件集合、撤销／重做与选区边界；新版实屏候选重开、撤销恢复及Tab选择均通过。生产源码净增7行，无新依赖、草稿存储、派发协议或Runtime。46项定向、原消息回归、lint、修正缺失类型导入后的web检查与正常构建通过，首次类型失败日志保留。
    - 真实附件组合：分别新建两位固定模型成员的空白群，同一63字节CSV和同题任务各只派发MiniMax／DeepSeek一条completed任务，另一成员无任务；MiniMax的提及经过退格／撤销，持久消息仍保留原成员ID，DeepSeek以Tab插入。两模型均生成、读回并通过bot_deliver_files交付报告和原CSV；四份产物从正式界面打开／保存后与工作区逐字节一致，三笔记录、11.33合计及0.03差额正确。DeepSeek实际read_file原件并另做一次本地字节检查；MiniMax没有读取CSV原件，只使用附件预览，因此该模型未完整遵守本题要求，不能记为任务质量全部通过。该缺口转入既有D07交付质量清单，不靠修改验收标准或补发指令覆盖首次结果。
    - 官方同题：原生选择同一CSV，只选择File-1019DT-REFERENCE；该成员交付258字节报告，随后另一成员File-1019DT-MIXED主动指出原CSV未附，再由原成员附上63字节CSV。两份官方产物已原生保存，CSV与本地SHA相同、报告数字正确；无法独立证明其远端工具调用。未提及成员的后续发言是当前官方行为与本地明确收件派发的差异。旧重建库GroupChatOrchestrator有受限多轮／pass机制，可作下一步参考；尚未确证当前官方的触发条件，不能直接照搬循环或把它记为已对齐。需继续在P05核心群协作下核对，保留用户“不要过度设计／优先复用原队列”的要求。
    - 本轮41/42限定核验通过，唯一失败为MiniMax缺少原件读取；不将该报告标为整体验收通过。原1202任务、59Bot、15群、319文件、6247消息头与原39字符草稿保持；最终1204任务、17群、325文件、106线程和6266消息头，两个新增任务均完成，未新增Bot、记忆、例行或后台命令。新文件只在两组本轮工作区，三条新核心线程均属于这两群。官方恢复原“1”会话及未答问题，本地仅保留本轮产物。证据quality-review/1019DV-group-mentions/{verification,group-task-evidence,tested-build,draft-protection}.json、三组原生下载与实屏记录。未commit／push；IME、Windows、完整群讨论、UI／动画和长程交付不由本项关闭。
  - [x] ~~1015W 富文本提及的基础交互与真实派发验证。~~ 使用与 Grok 相同版本的编辑器原语，成员节点显示既有头像与配色名称；实屏完成键盘选人、整项删除、撤销/重做、Shift+Enter 换行、切换私聊返回和 Reload 持久恢复。恢复后发送两行合成任务，控制库仅 AP 一条 completed 任务，正确返回 43，原成员 ID 与文字范围完整，输入框清空。单/多行截图中头像、文字与加号基线一致；35 项编辑投影/群草稿/提及测试、web 类型检查、消息回归与构建通过。证据 `quality-review/1015W-atomic-group-editor/evidence.json`。中文 IME、附件与新编辑器的组合、明色及完整窄布局仍待验证，不勾选整个 D04。
  - 折叠栏续检发现“未分组”为裸文本，未进入已有 span 隐藏规则；补齐同样的文字包装，复用现有容器查询，展开仍显示名称。新版实屏复验后再记为通过。
  - [x] ~~1015Y 新编辑器的附件＋引用＋同成员提及组合。~~ 正式原生选择器导入既有合成 CSV，引用 AP 的旧回复 43，再通过中文筛选插入 AP 原子标记。只产生 AP 一条任务 `6e0b787b-c1f2-4471-ba7d-7714582b1190`，completed 且无错误；实际结果准确为原文件名、3 行、18.25/7.50/25.00、合计 50.75，没有沿用引用的旧数值。引用作者与提及是同一人，没有重复派发；草稿、引用和附件发送后清空。群目录中的保留文件为 41 字节，SHA-256 与原件相同。证据 `quality-review/1015Y-atomic-editor-attachment-reply/evidence.json`。本例覆盖选择器路径，拖入/剪贴板和中文输入法不由此推断通过。
  - 编辑细节续核（实施前记录）：Grok 原编辑器复用 ProseMirror 原生粘贴/拖放，并带 `ScrollCaretIntoView` 和 Mac 行首/行尾快捷键。当前新增输入框自行 `insertText` 粘贴，换行会留在同一个文本节点、没有请求滚动到光标；文本拖放也重复实现了原生行为。改为只拦截文件，由原编辑器解析普通粘贴/拖放（提及节点不接受 HTML 解析，外部内容不能携带收件 ID），同时复用原光标滚动及 Mac 快捷键插件。保留 IME 按键保护，不改变草稿和派发契约；实际多行粘贴、光标、选区和快捷键复验后再计完成。
  - [x] ~~1015Z 普通多行粘贴、末行可见及 Mac 行首/行尾的基础验证。~~ 独立固定样例窗口粘贴 20 行，实际截图确认输入区受限高度、末行光标可见，最后一行与加号/发送按钮对齐；Ctrl+A / Ctrl+E 后分别粘贴 HEAD_ / _TAIL，仅末行改变，前 19 行完整。复用 Grok 原插件并增加组合态保护，38 项编辑器/提及/草稿回归、web 类型检查、消息回归和构建通过。扩展选区的随后实屏操作未得到可靠结果（原生删除及全选也未稳定生效），故该组合和中文 IME 仍待验收，不按单元测试推断通过。合成草稿未发送，保留于该独立测试配置；原预览中的用户草稿不受影响。
  - [x] ~~1016Z 原应用中的 Mac 扩展选区续验（键盘路径）。~~在原应用合成群输入三行，Ctrl+A／Ctrl+Shift+E实测只选中第三行，替换不改前两行，Cmd+Z精确恢复原文。随后键盘Down／Enter插入AJ成员原子标记，退格整体删除、撤销恢复；没有发送模型任务。本轮草稿已清空并返回DeepSeek空输入，宽度80px。证据quality-review/1016Z-mac-selection/evidence.json。候选的AX点击及一次坐标点击未插入，键盘成功；指针目标／工具行为仍需核实，未凭此臆测修改生产逻辑。中文输入法组合态及完整鼠标路径不由本项推断通过。
    - 后续使用原尺寸截图坐标实际鼠标点击AJ候选，已成功插入成员原子标记；此前AX点击与半尺寸坐标点击未插入的记录保留。未为工具命中问题臆测修改生产逻辑；鼠标成功样本不替代中文输入法或所有可访问操作验收。
    - [x] ~~原生行尾选区、替换／撤销与成员节点的组合。~~ 1016Z 原应用实际使用 Ctrl+A 移到第三行首、Shift+End 选中末行，粘贴只替换第三行、前两行原样；Cmd+Z 恢复原三行且选区仍正确。另通过中文筛选插入 AP 原子标记、Shift+Enter 换行，全选删除后撤销恢复完整身份标记与第二行，最后清空本次草稿、未发送。此前 Ctrl+Shift+E 未形成选区的现场保留：临时事件日志只收到普通 Ctrl+A／Ctrl+E，未收到该组合的 keydown，尚未区分系统与电脑工具原因，不据此改写编辑器；该组合和 IME 继续待验。临时诊断已全部移除，两个编辑器文件与 HEAD 完全一致，最终构建无诊断标记；控制库无 1016Z 任务。证据 `quality-review/1016Z-group-selection/{key-events.log,evidence.json}`。
  - 独立 UI 配置与原预览严格分开：1015Z 只有固定样例，不复制模型密钥，不作为模型交付证据。因首次打开导致用户误以为原 Bot 丢失，已核对原 control.sqlite 和原预览实屏，需求分析/sean 等会话仍在，并将原窗口重新置前；独立窗口补充明确标题与黄色标识，避免后续混淆。
- [ ] **群消息回复与复制（P05/P09）**：2026-10-15 官方实屏确认消息悬停工具栏有回复，点击后在原草稿上方显示可取消的引用，不自动改写草稿或插入 @。当前群组件缺少该入口，按原群草稿／历史／派发接口补齐；主进程只接受同群消息 ID，按真实消息构建引用资料，不能用前端提交的引文冒充原文或授权。回复关系需随历史持久化，失败重试保持相同请求与引用，取消回复不丢文字／附件，引用不能改变提及收件规则。参考 Grok renderer 的 replyToId 草稿／取消逻辑及 Hermes group-chat-view 的消息悬停操作方式；不新增 Runtime、独立消息存储或线程执行模式。实现与真实同题验证后再划掉。
  - 官方 1015P 继续实测：仅引用 sean 的结果、没有 @ 时，只有 sean 回复 13+18=31，其他两位未回复。故默认回复收件人为原作者，不能沿用“未提及即全员”；显式 @ 的优先级单独保留。当前实现已接入该默认规则，原作者离群时拒绝隐式转发全员；主进程校验同群引用、持久化关系、请求冲突，前端复用群草稿／附件／分页。74 项群 Host、草稿、提及及历史回归、node／web 类型检查、消息回归和构建通过；真实 MiniMax 与新版实屏复验进行中，暂不划掉。
  - [x] ~~1015P 本地真实引用、取消、复制与重载草稿验证。~~ 正式界面引用 AJ 的 13+18=31，已有合成文字保持；取消只清除引用。群消息复制在将窗口 Raise 到前台后显示“已复制”，实际粘贴内容与原消息一致（此前后台窗口的 Document is not focused 拒绝保留，不因此修改浏览器权限）。随后 renderer Reload，未发送任务和引用均恢复；发送后仅任务 `5ca8591e-7ad3-4b85-b8e7-2b9b8e8fc47a` completed，AJ 回复 31，其余成员没有任务。输入和引用清空，历史保存真实引用链接；证据 `quality-review/1015P-group-reply/evidence.json`。旧页跳转、回复与显式提及组合的实屏继续核对，整项仍保持未勾选。
  - 1015Q 官方组合实测纠偏：引用 sean 的 13+18=31，同时只选中 @新建 Bot，实际由 New Bot 与 sean 两位回复 31，第三位未回复。因此引用作者应与显式提及取并集并去重；此前“显式提及覆盖引用作者”的实现假设不成立，不能沿用。先更新此记录，再修正原收件推导及主进程同群校验，不新增派发链；现有 `jie'zh` 草稿及原引用已恢复。本地真实 MiniMax 组合复验通过后再划掉对应子项。
  - 1015Q 本地首轮保留失败：实际只派发 AJ／AP 两条任务，AP 正确回复 31；AJ 虽为被引用作者，仍回复“未被提及，不回复”。因此收件集合正确不等于交付通过。原 Bot 提示只描述群用户请求，未明确已由 Host 选定收件及引用作者的角色；在该分支补充边界说明后继续原场景，不修改公共 Runtime／工具安全策略。
  - 1015Q2：只补通用 Bot 系统规则后，AJ 仍沿用旧群历史中的“不回复”，未通过。不能据此声称规则已修复。参考原 Grok `buildGroupTurnPrompt` 的逐成员 “It's your turn, name” 接线，将本次实际收件身份与引用作者身份由 Store 附在各自任务中，避免要求模型仅从 @ 文字推断路由；保留用户原文和真实引用，不改权限或追加用户任务。
  - 引用定位实屏发现新缺陷：点击已载入消息的引用未滚动。核对当前 `react-virtuoso` 的 `scrollToIndex` 实现后确认该方法使用数据相对下标；此前误加 `firstItemIndex`，被截到列表尾部。只修正两处调用的下标，保留倒序分页时的稳定首项索引；实际跳转及回到最新继续复验。
  - [x] ~~已载入引用跳转及返回最新消息实屏复验。~~ 新版从 1015Q3 引用跳回 AJ 的 13+18=31，实际截图确认目标位于消息视口中部；再点“回到最新群消息”返回 16:30 的末尾。web 类型检查及构建通过。跨 50 条分页的引用定位仍未实屏验证，不将整项勾选。
  - [x] ~~1015Z 跨 50 条分页的引用定位及返回最新。~~ 独立配置中预置 60 条明确标记为固定样例的历史，末尾第 30 条请求引用第一条。实际点击跳转后显示第一条原文，再点回到最新可见第 27—30 条及末尾结果。没有调用模型，结论仅为界面分页/定位。当前锚点查询只带目标及此前记录，最早目标跳转后缺少后续上下文，需继续核对与完善，不能称为完整历史浏览已对齐。
  - 引用上下文窗口（实施前记录）：沿用原 CMB `getThreadMessagesPage` 的精确 targetMessageId 与互斥游标方式，在既有 groupMessages 查询中增加可选目标 ID；按本群真实 ordinal 取目标及最多 25 条随后消息，再复用原 50 条分页与投影。不得用 ordinal 加固定数猜测后续边界（不同群交错写入会产生空洞），不遍历全部旧页，不新增表/轮询/Runtime。补齐 IPC 参数校验、同群隔离、首/中/末目标与普通旧页回归，再通过固定样例实屏复验。
  - 上下文查询与 IPC 已实现：稀疏 ordinal、同群隔离、精确目标/旧游标、引用元数据及首/中/末窗口共 78 项相关回归通过，node/web 类型检查、原消息回归与构建通过。第一轮实屏读到了随后上下文，但初始滚到底部与 effect 引用滚动相互覆盖；已删去重复 effect，让新挂载的 Virtuoso 直接以引用 ID 定位。更新后 web 类型检查/构建通过，实际定位继续复验，暂不计完成。独立窗口冷重开确认此前 20 行合成草稿已清空；原预览的 19 个 Bot、5 个群和用户草稿保持原样。
  - [x] ~~1015Z 引用上下文窗口及直接初始定位复验。~~ 独立窗口一次尺寸变化后实际绘制恢复，截图确认第一条原文与随后第 1—5 条请求/结果。随后不再调整窗口，回到最新显示第 26—30 条及最后结果，再次点击第 30 条引用直接定位第一条，往返正确。沿用有界分页、同群校验及原投影，无新增存储/执行机制。首次重载时截图与 AX 不同步的现场保留，不能因此将整体验收或所有冷启动场景勾选；测试数据明确为固定样例，未调用模型。证据 `quality-review/1015Z-group-editor-ui/target-window.json`。
  - 原预览通过应用菜单正常退出（进程退出 0），再用同一 controlled-profile / controlled-electron-profile 启动最新构建。前后 Bot/群稳定 ID 摘要一致，仍为 19 个 Bot、5 个群；原列表宽度 341 与需求分析/sean 等会话均保留。独立固定样例测试进程已停止，数据保留供后续验收；未改正式用户配置或执行新的模型任务。
  - 1015Q3 仍未通过交付：逐成员路由身份已存在于本轮持久任务和原线程消息中，AJ 最终仍重复“不回复”；AP 正确回答 31。保留三次样本于 `quality-review/1015Q-group-reply-union/evidence.json`，不认定公共 Runtime 为根因，也不再用重复加规则替代验收。收件与引用校验已修正，模型在该既有上下文中的交付问题继续保持未完成。
  - 群上下文接线续核（实施前记录）：Grok `buildGroupTurnPrompt` 使用成员的新消息，Hermes `formatGroupDeltaLines`／`addFreshThreadRoomContext` 区分增量与历史并标记裁切。当前 CMB 每次重复最近 20 条、且本条请求再次进入引用区，原 Runtime 的持久线程又已有此前轮次，存在不必要的重复与旧任务混入。沿用原已完成群任务的 `origin.messageId` 和同群消息 ordinal 推导已送达范围；只附本轮前尚未送达的群参考，首轮保持有界历史、明确裁切，不新增游标表／Runtime／消息存储。失败、取消及未执行的任务不能使参考被跳过；引用原文仍由同群 ID 独立解析。此改动不直接证明 1015Q 的模型拒答根因或修复，须单独复验。
  - [x] ~~群参考按成员已完成轮次增量传入，复用原线程历史。~~ Host/Runtime/历史清理合计 99 项测试、node 类型检查及构建通过；没有新增游标表或执行链。1015V 在新群只附两条新增结果参考（不含原始 19+23），真实 MiniMax 仍从本群原线程正确回答 `19+23=42`。因此原 Runtime 历史可继续使用，不必每次重新附送已处理指令。
  - 1015Q4 在增量上下文后仍失败：AJ 接到任务却最终以“未被提及”拒答，AP 正确返回 31，未增加其他收件者。不能把上下文去重当作此交付差异已修复。只读解码现有 trace 后核实其中的 model-call 输入由持久消息快照投影，并非原始提供商请求；它不能单独区分模型输出与流式组装根因，按用户要求暂不扩展公共 harness 改动。
  - [x] ~~1016A 新群上下文中的引用作者＋显式提及收件组合。~~ 原应用中引用外观核验-1014A 的 19+23=42，同时通过成员原子节点仅 @ 收件人核验-1013AP。控制库恰有两条 completed 任务，两位分别使用真实 DeepSeek／MiniMax，均回复自己当前名称及原算式 42；没有重复派发，引用关系保留。行为与官方 1015Q 的并集规则相符，未修改提示词或原 Runtime。证据 `quality-review/1016A-group-reply-union/evidence.json`。该新群样本通过，不抹去 AJ 在既有群上下文中的四次拒答记录，也不能据此证明所有历史上下文均已恢复。
- [x] ~~D04 附件、中文成员筛选、会话切换和真实定向发送的组合验证。~~ 1015R 通过原生选择器导入既有合成 `attachment-1013Y.csv`，输入 @ 后粘贴“收件”筛选，Enter 选中 AP；切到私聊再返回，附件、文字和提及均保留。发送后仅 AP 任务 `c7a35807-ea42-412a-83a7-7bbbc29f7978` completed，回复原文件名、3 行、18.25／7.50／25.00、合计 50.75；其他成员未收到任务，草稿与附件清空。证据 `quality-review/1015R-mention-attachment/evidence.json`。此处是中文粘贴／筛选，不冒充中文输入法实测，官方同附件组合及其他未验状态仍待核对。
- [x] ~~D04 离群目标草稿拦截、重新加入与稳定身份恢复。~~ 新合成群“成员变更核验-1015S”先选择 @AP 并保留未发送任务，再从成员面板移除 AP：按钮禁用、Enter 发送被拒绝，原提及／文字保留；控制库确认消息和任务均为 0。重新加入相同 Bot 后，原草稿恢复可发，只派发 AP 一条任务并正确回复 42，无误发其他成员。同时去除 Enter 校验在页顶重复生成同一提示的接线，沿用输入框已有的 alert；新版实屏复验该提示去重继续进行。
- [x] ~~1015T 新群引用作者＋显式提及收件及交付验证。~~ 在上述新群引用 AP 的 42，并仅 @AJ，实际仅 AP／AJ 两条任务完成，两位分别报告自己的名称和 42，AK 未收到任务。证据 `quality-review/1015S-group-membership/evidence.json`。该样本确认新版默认路由在新上下文中可用，不抵消旧群 1015Q—Q3 的失败，也不据此宣称所有上下文交付质量一致；中文 IME、旧页引用及其他交互继续待验。
  - 群回复快捷键续补：本轮官方实屏中，输入框按 Escape 会取消当前引用且保留文字；CMB 当前只关闭提及候选，候选关闭后无法用 Escape 取消引用。沿用表单事件与原草稿取消操作补齐，已被候选／输入法消费的按键不得继续取消回复；实际复验后划掉子项。
  - [x] ~~1015U 两级 Escape 与错误提示去重实屏验证。~~ 新版保留本轮合成文字、添加引用后打开 @ 候选：第一次 Escape 只关闭候选，第二次取消引用，两次均保留文字并保持输入焦点。另在同一合成群移除草稿目标后按 Enter，仅有输入框原 alert，页顶不再重复提示；重新加入 AP 后校验解除。恢复过程中电脑工具曾选错屏外下拉项，已移除误选成员，改用键盘逐项观察并确认恢复原 AP；没有向误选成员派发测试任务。随后预览出现新的新建 Bot 操作，保留窗口现场与草稿，未继续覆盖用户输入。仅本轮 `1015U 未发送校验草稿` 的清理尚未确认，不触碰其他用户草稿。web 类型检查、构建通过；输入法组合态仍未由本项覆盖。
    - 后续重新读取实际窗口，确认仍为本轮合成群与 1015U 草稿；分步选择全选、观察选区后删除，实屏确认输入为空且发送禁用，清理已完成。其他会话草稿未操作。
- [ ] D04 历史成员标记视觉补齐：官方实屏为成员头像、成员配色和名称，当前只有统一蓝色 @ 文字。沿用已持久化的提及 ID 和现有 BotAvatar，补齐历史气泡中的身份展示，不改变原文、收件人或普通 Markdown；输入框文字与头像富文本的差异另记，不靠改变 textarea 文本宽度伪造对齐。
  - [x] ~~群历史使用头像和成员配色展示已绑定的提及。~~ 复用现有 BotAvatar，Markdown 的 opt-in 上下文仅对已校验的提及范围提供身份标签；原文、ID、草稿与收件规则不变，普通工作台渲染不受影响。新版正式群历史 1015O 实屏确认 AJ／AP 为各自头像和颜色，保留成员点击入口，引用内容未被转换成提及。web 类型检查、构建通过；输入框富文本差异及完整明色对照仍未由此项覆盖。

2026-10-14 新截图补充 D02/D03：折叠栏不得出现常驻粗滚动条或横向滚动条；输入文字、占位文字与“＋”／发送按钮须在单行时垂直居中，多行时与最后一行中心对齐，附件及 @ 高亮不得改变文本基线。已定位到列表原生滚动条占用宽度后挤压固定宽度置顶卡片，以及 24px 文本与 34px 按钮底部对齐造成 5px 中心差。修正仅限 Bots CSS，实屏复验后记录结果。

- [x] ~~折叠列表粗滚动条／横向滚动条消失，群聊空输入框文字与“＋”居中。~~ 新版构建并重载后，在原“附件新群-1013AN”实际截图核对通过；只隐藏列表滚动条，保留原滚动机制。多行、附件、不同宽度仍须继续复验，D02/D03 整项不勾选。
- [x] ~~折叠侧栏分隔线不再穿过左上角系统按钮。~~ 用户补充截图显示 72px 折叠宽度使分隔线穿过绿色系统按钮。折叠下限已统一为 88px，旧偏好通过既有 clamp 自动兼容，拖动、Home／左右键、ARIA 边界使用同一常量，置顶头像保持居中。新版类型检查、构建通过；重载后的实际界面显示宽度为 88，截图确认三个系统按钮完整位于分隔线左侧，并保留间距，列表无横向或常驻纵向滚动条。此项仅确认当前 macOS 窗口下的边界修复，整体 D02 验收仍未完成。
  - 2026-10-15 按用户截图继续微调：折叠宽度从 88px 收至 80px（常量与 CSS 最小宽度同步），旧折叠偏好仍由 clamp 归一化。隔离预览实际显示 splitter=80，截图确认绿色系统按钮仍完整位于分隔线左侧，头像与选中背景居中；web 类型检查、构建通过。展开宽度及交互逻辑未改。
  - [x] ~~2026-10-15 新截图中的系统按钮被搜索背景遮挡。~~ 根因是折叠时仍打开的搜索框按 order=0 排在顶部，旧 44px 安全留白只加在列表。改为独立、不可收缩的侧栏安全行，由现有 container query 跟随实际宽度，拖动中也生效；搜索、列表与头像背景均位于其下。折叠搜索只显示放大镜按钮，点击展开并聚焦原输入，保留查询；未清空用户内容。新版实屏按“218px 打开搜索 → 输入合成‘核验’ → Home 折叠 80px → 点击放大镜”复验，截图中系统按钮无遮挡，展开 264px 后原查询完整、输入有焦点；随后只清除本次合成查询并恢复 80px。web 类型检查、构建及 diff 检查通过。修改仅在 Bots 布局，未改原窗口按钮位置或原工作台。

2026-10-15 D01/D05 复用方式调整（实施中，未验收）：现有 Hermes SVG 投影和手绘轮廓无法复现官方三维轮廓与完整动作。复用用户提供的 Grok renderer 中独立纯函数内核（几何／表情／动作轨道／状态导演／SVG 属性更新），以薄适配层连接现有 Bot 状态；保留 Hermes 共享时钟、离屏／隐藏暂停和统一回收，不引入应用网络、Bot Runtime 或另一套执行状态。内核约 9,400 行、273 KB，主要是现有几何和动作数据，不以重新手写关键帧替代复用。独立依赖审计只引用数值／集合／字符串内建对象；源文件与哈希记于 vendor 头部。先验证全形状／状态与有限资源开销，再实屏对照；当前不计完成。
- [x] ~~移植独立角色内核并接入现有 Bot 活动，清理替代的手绘实现。~~ 复用原几何、表情、Working A—F／Streaming／Blocked／Done 动作、状态导演和 SVG 属性更新；持久形状 ID 不变，13 个编辑器选项逐一映射原实际几何（圆形为 sphere）。调色板采用原 `zf`，旧固定色值仅在表现层兼容，不改存储的用户身份或自定义颜色。列表、置顶、标题、详情、群组合与缩略图共用此内核；已看到的忙→终态才播放完成／失败，不因打开历史重播，取消直接回正。
- 1015K Mac 真实 MiniMax：实际 Node PID 98498 运行约 12.4 秒、退出 0，输出 `MOTION_1015K_OK`；界面分别截图确认审批、执行与结束回正，空输入忙时只有停止按钮。静止后一次进程采样 renderer／GPU 为 0.0% CPU；这是当前样本，不等于长时间资源验收。证据 `quality-review/1015K-avatar-kernel/evidence.json`、`/tmp/cmb-bot-grok-kernel-live.log`。17 项当前内核／状态／共享时钟／草稿回归、web 类型检查与构建通过。圆形映射及调色板的末次补充已重载，实际头像编辑器确认 13 种形状、11 色及旧色值选中兼容。未录制完整动态过程，未由截图宣称丝滑程度或全动画一比一验收通过；D01/D05 保持未勾选。
- [x] ~~1017AW 头像活动图形按实际显示尺寸缩放。~~官方0.71.2的KN将实际size传给Uh/displaySize，内核在44—134px间逐步减少小图标放大；本地固定传40，64px详情仍按小尺寸放大。只将该参数改为target.size，保留原逻辑画布、几何／动作数据及共享时钟。相同搜索帧的8种尺寸与官方缩放曲线逐一一致，64px从1.14修正为1.12233，42px及以下不变；13形状×10状态×8尺寸共1040个纯函数帧有限，静止原轮廓不变。原10项头像／状态／生命周期回归、web类型、格式与构建通过；lint零错误、原有settlement依赖警告1项，未借此扩改。更新包DeepSeek ed6df13e…／MiniMax56e32d11…均实际navigate／close，0工具错误，合计20.00／差额1.00正确，无内部ID出现在回复。实屏看到大小头像和完成笑眼回正，未赶在导航结束前捕获搜索帧，不把数值证据充作完整动画录屏。599条旧任务、35个Bot、10群、9例行、21命令、216文件及3595条旧消息头保持；新增2条本轮任务，0活跃，quick_check通过。mask原39字草稿逐字保留，详情收起、220px侧栏及原窗口尺寸恢复，合成服务正常终止。证据quality-review/1017AW-avatar-display-size/review.json。官方当前显示无法刷新／试用提示，本轮仅检查UI与安装源码；完整悬停、官方新任务和Windows仍未验，不勾选D01/D05。


2026-10-15 D02 提示优先级续补：已按官方 `uE` 的“等待确认 → 草稿 → 最近消息”规则补齐，私聊直接订阅原 ThreadContext 草稿，群聊复用已有群草稿 Store；仅在打开的提示内容中订阅，冷启动只读既有持久草稿，不初始化历史、不另外保存草稿。附件草稿显示文件名，摘要按 Unicode 字符限制为 140 字并保留两行布局。22 项侧栏／私聊及群草稿回归、web 类型检查、原消息回归、构建通过；新包实屏等待／草稿优先级仍待验收，本项暂不划掉。
- [x] ~~Mac 折叠侧栏草稿提示实屏验证。~~ 1015K 前在新 Bot 输入未发送合成草稿，切回侧栏并用 Tab／Shift+Tab 聚焦后，卡片实际显示小头像、名称及“草稿 折叠提示验收-1015K（未发送）”；没有提交该草稿。随后只替换本轮合成文字，不触碰其他用户草稿。等待优先级、群草稿、冷启动、明色与全部窄布局仍需补测，不勾选整个 D02。
- [x] ~~1015X 群草稿提示与折叠分组文字复验。~~ 在“成员变更核验-1015S”输入本轮合成草稿，键盘聚焦折叠头像后，提示实际显示群头像、名称、黄色“草稿”和原文，优先于最近回复 43；未发送。随后只清除本轮草稿，输入为空、发送禁用。该次截图不能证明“未分组”修复已载入：后续实际旧 renderer 中仍可见，最新构建已包含 span 包装，重载后需另验；左上角系统按钮区域仍无遮挡。等待审批优先级、明色及全部窄布局未由此项覆盖。



- [x] ~~D05 新任务准备阶段不再沿用上一轮工具动作。~~ 1015H 实屏：上一轮命令完成后发送纯计算请求，Host 接单到原 Runtime 启动之间显示“正在处理”，随后正确回复 423，无外部工具调用。修正仅在 Bot 头像读取到原 stream 尚未 loading 时忽略遗留工具状态；8 项状态／动画生命周期回归、web 类型检查和构建通过。不代表完整动作视觉已对齐。

2026-10-14 D05 状态补齐：核对本地 Grok renderer 的 `fl` 状态表、`Streaming_A`／`Blocked_A` 旋转轨道及 `vt`／`Qa` 插值后，保留关键帧和缓动数据，接入现有共享 SVG 时钟。原 Runtime 的当前输出尾部用于区分思考与回复；审批／补充输入优先显示等待动作，列表、置顶、标题、详情头像都接入，普通历史回复不触发输出动作。不新建执行状态源，不因每个 token 重渲染头像。14 项状态、关键帧、循环边界、过渡、暂停与回收测试，以及 web 类型检查、消息回归、构建通过；新版已载入。此处仅复用两类旋转轨道，不等于完整 3D 形变、全部动作片段、完成／失败状态或实屏动态一致性已通过，D05 保持未勾选。

截图依据（用户提供，临时路径可能失效，失效时重新截取）：
- 官方折叠栏：`/var/folders/r4/m2gmdyyn06z9488ghc1044zh0000gn/T/codex-clipboard-319d2c70-fdbb-4a53-bc1e-695b58365975.png`
- 当前折叠栏：`/var/folders/r4/m2gmdyyn06z9488ghc1044zh0000gn/T/codex-clipboard-704192f4-e862-4760-bc78-3487309bb9cf.png`
- 当前群聊输入框：`/var/folders/r4/m2gmdyyn06z9488ghc1044zh0000gn/T/codex-clipboard-c80c7588-d8e5-434d-a94d-f0f40e213ca7.png`

#### B. 全核心流程复核，不因本轮未再次提到而遗漏

| 验收项 | 必须核对的使用与结果 | 对应原计划 |
|---|---|---|
| 持久身份与管理 | 新建首次对话、名称/职责/头像/模型修改、置顶/分组/隐藏/归档/恢复/删除；重开后身份与状态正确，失败可理解且可重试 | P02/P09 |
| 持续对话与执行 | 流式回复、忙时补充、排队/插话、停止/继续、审批与补充输入；原进程和成果归属正确，禁止重复执行或虚假完成 | P03 |
| **私有长期记忆** | 开关关闭时不偷偷保存；开启后明确记住、查询、修正、删除；跨任务及重启可用，记忆检索与总结复用原能力。Bot A 私有记忆不泄露给 B 或群聊；只在明确共享时按范围交接。旧内容修正/删除后不能仍被当作有效事实，记忆不能提升权限或覆盖系统规则；失效、容量和总结失败有边界 | P04/P10/P12 |
| Bot 私聊协作 | 可发现正确同事、一次交办、异步接收与汇总；身份/权限/附件与结果来源保留，防互等/循环/重复回执，失败不能伪装交付 | P05 |
| 群聊与 @ | 创建/成员管理/资料、@ 选择与真实派发、多人协作、群成果；私聊/记忆/浏览器/目录隔离，消息顺序和重启后历史正确 | P05/P07/P09 |
| 例行任务 | 自然语言创建/编辑/取消、定时/周期/时区/去重，重启与错过触发按既定策略处理；无变化静默，有成果/异常/待决事项通知正确会话，不能把错误静默掉 | P06 |
| 浏览器 | 页面归属、导航/读写/上传/下载、用户接管/归还、重新观察后继续、异常恢复及真实登录环境；遵守本期独立原生窗口和串行操作的已接受差异 | P07 |
| 文件与资料交付 | 私有/群目录和授权、附件输入、真实文件交接、资料库、打开/预览/保存、同名/中文/长路径；交付可访问且内容正确，不能仅发不存在的路径或摘要 | P08 |
| 本地后台及恢复 | 关窗口与退出进程的区别、重启时任务/消息/checkpoint/记忆/文件状态一致；未知命令结果不盲目重跑；历史清理保护恢复、去重和协作关联 | P03/P10/P12 |
| 原 Runtime 能力和隔离 | 沿用原工具、技能、审批、压缩、checkpoint 和完成性检查；Bot 不出现原 thread 没有的能力缩水；模型用户可配置，旧工作台行为不变 | P03/P11 |
| 跨平台及远端边界 | Mac/Windows 原生本地能力、路径/停止/安装资源；远端接口保留但不伪造可用服务。Mac 结果不得替代 Windows 实测 | P01/P07/P11/P12 |

- [ ] **D06 上表逐项完成真实使用与异常路径复核**。已有记录可复用，但必须注明具体覆盖范围；未测的状态不得由代码存在推断通过。每个核心入口同时核对正常、执行中、空态、等待、失败、取消、重开等适用状态，以及键盘/鼠标操作、禁用状态、提示、焦点和布局，不仅检查最新截图。

#### C. 长程任务与实际交付质量是硬性门槛（P03/P12）

- [ ] **D07 同题三方对照**：在隔离工作区使用相同任务说明、初始文件和验收条件，对照 CMBDevClaw Bot、原 CmbCowork thread、官方 Grok。前两者尽量用同一真实 MiniMax 配置；官方模型差异必须记录。先独立完成首轮，再给予一致的结果反馈，分别记录首轮与修订表现，不能用人工补代码后的成果冒充 Bot 交付。
- [ ] **D08 长程编程交付**：覆盖多文件实现、运行/测试、自检与修复、长命令、过程补充要求和最终交付；独立核对需求完整性、程序行为、测试是否真的执行、输出文件/说明是否齐全、修订是否回归、停止是否有效、恢复是否重复操作。不能只看“任务 completed”、模型自报通过、源码行数或单个成功示例。
- [ ] **D09 其他任务类型交付**：覆盖资料核对/文档、浏览器收集与文件处理、群协作文件交接、例行执行与记忆延续；核对事实/计算/原件/可打开成果及交付入口。记录失败、人工介入次数、耗时、工具重试与缺失内容，发现 Bot harness 相对原 thread 的退化先定位并修复，再用原场景复验。
  - 1019DV首轮反例：MiniMax群任务已收到“Read the attached CSV original”，实际仅write_file报告→read_file报告→bot_deliver_files，没有read_file CSV；数字和原件交付正确仍不满足这条执行要求。DeepSeek同题读取原CSV、报告并交付；官方报告与CSV数字／字节可核对，但远端工具调用不可独立验证。本例未加入原CmbCowork thread同题，不据此归因模型或Bot接线；原输入、首轮产物与工具回执保留于1019DV，后续同题比较不能用补发纠偏后的结果替代首轮。
- [ ] **D10 交付结论**：目标为任务效果不低于原 CmbCowork，并尽量达到 Grok 核心任务的完成与交付水平。若验收场景存在差距，必须在本清单保留问题与下一步，不能因换题、降低验收条件、换成更简单样例而宣布对齐；有限样本不能证明所有任务同等或更优。

2026-10-15 同题短命令新增反例（1015D，D07/D09 未通过）：
- Bot／MiniMax-M2.7 首轮约 5.4 秒返回“等待20秒”及 `AVATAR_RUN_DONE`，日志没有工具调用，属于假完成，不按任务 completed 计为交付通过。
- 原 CmbCowork 新 Solo 会话 `34d832e0-4d49-4b12-80aa-48ae6708d4ee` 使用同一 MiniMax 配置和原题，首轮实际调用 `execute`；单次允许后 Node PID 54168 运行约 20.2 秒，退出 0、stdout 为预期内容。原会话为新上下文，Bot 为既有上下文，此样本不能单独证明提示词是根因。
- 官方 Grok“合成对照-1014AL”同题先报告开始，随后显示预期输出；本轮仅记录客户端可见行为，没有远端进程日志，因此不将其执行细节视为已独立核实。
- Bot 纠正轮 1015D2 实际调用 `execute`，Node PID 46987 正确运行约 60.2 秒，后台回执 `f28169c3-9c7f-40e8-8d7f-24505a677389` 完成，自动通知返回实际输出；补充消息没有再次启动命令。纠正轮通过不抵消首轮失败。
- 参考 Grok `system-prompt.ts` 的真实来源约束，在 Bot 提示层补充实际外部动作须调用工具、输出须来自回执、未执行／等待／失败不得声称完成，同时保留普通聊天和无需外部动作的计算直接回答。原 Runtime 完成门只检查协议与待办，未改为按关键字强制执行；新提示的定向真实首轮复验见下一项；其余上下文及动作仍待复验，不勾选整个缺口。

- [x] ~~新建 Bot 首轮实际执行及普通计算的定向复验。~~ 1015F 在无纠正历史的新 Bot（`a4d06793-699f-47eb-a442-1f9d989089f2`）中提交相同动作要求，MiniMax-M2.7 实际调用 `execute`，单次审批后 Node PID 61276 运行约 20.2 秒、退出 0，最终只回复 `AVATAR_RUN_DONE`。1015G 随后直接回答合计 80，没有调用外部工具。35 项 Runtime 接线回归、node 类型检查／构建通过；证据 `quality-review/1015F-execution-truth/first-turn.json`、`/tmp/cmb-bot-execution-truth-live.log`。这是新提示的一个正向样本，不证明假完成已完全消除，也不抵消 1015D 失败；既有上下文、文件／浏览器等其他外部动作仍需继续验证。

#### D. 完成标准与复用原则

- 先核对当前官方实屏与相关 Grok/Hermes/原 Cmb 源码；优先复用原接口、组件与经验证实现，必要注册/接线保持旧默认行为。
- 实现后主动扩查同类问题：私聊修复需检查群聊，展开侧栏修复需检查折叠，鼠标交互需检查键盘与输入法；不得只修用户圈出的一个位置。
- 2026-10-15 用户再次强调细节：界面修改同时核对系统按钮安全区、滚动裁切、悬停／选中背景、图标与文本基线、查询／草稿保留及焦点恢复；新增或变更状态要覆盖进入、切换、退出和失败路径。核心功能仍以真实收件对象、执行回执与可用交付验收，不能用按钮存在或局部截图替代。
- 最终复核包含业务逻辑、权限隔离、并发/恢复、资源释放、CPU/内存/存储增长及原工作台回归。动画须保留离屏/隐藏暂停、减少动态效果与卸载清理；功能完整不能以持续资源消耗为代价。
- 本节 D01—D10 当前全部未验收完成；先前局部实现/测试记录仍保留，但不代表这些整项已完成。后续按此表推进，完成且复验后再划掉。


2026-10-15 长程编程首轮复验（1015J，保留未通过结论）：真实 MiniMax-M2.7 在新 Bot 中完成四文件 NDJSON 工具、自行修正一次测试行号并实际报告 27/27 自测通过，通过 `bot_deliver_files` 交付四份可打开／保存原件。沿用 1014Q 的 47 项独立验收，首轮为 **45/47**：`--input -` 被参数解析拒绝，stdin 未通过，依赖 stdin 的原子替换检查未执行。快照 `quality-review/1015J-bot-first/` 与验收输出已保留；已将真实失败反馈给模型，未由验收人员改写文件。此前官方 Grok 首轮 47/47，故本轮仍不能宣称长程交付已达到同题水平；修订结果另记。
- [x] ~~1015J 修订交付通过同一 47 项独立验收。~~ MiniMax 实际运行 37 项自测，Node PID 92406 退出 0；四份更新原件经 `bot_deliver_files` 交付，同一验收器为 **47/47**。快照 `quality-review/1015J-bot-revised/` 保留消息／工具回执、文件哈希与结果。修订中错误使用 `write_file` 覆盖现存文件，两次 shell 重写被原安全解析拒绝，随后一次多层转义命令由验收人员拒绝并补充“使用 edit_file”反馈；模型改用原编辑工具后完成。不能把这次人工纠偏后的通过记为一次反馈自动修复，更不能覆盖 45/47 首轮结果；完整 D07/D08 仍保留未完成。

- [x] ~~1015AF DeepSeek 长程任务补充验证。~~ 用户已授权使用已有 DeepSeek 额度，并要求直接在原应用测试。沿用 1014Q／1015J 相同 NDJSON 四文件任务及 47 项独立验收，没有向模型提供验收器或已有实现。在“资料核验-1015AE”的空群目录执行，只提及绑定 DeepSeek 的外观核验-1014A；前文仅有两次自身资料修改，与原新私聊样本存在上下文差异。任务 `3c47f082-1919-4dee-b51c-07c5ccb8e399` completed，四份原文件均通过 bot_deliver_files 交付，正式界面具备打开／保存入口。首轮快照在反馈前独立保存并附 SHA-256；同一验收器 47/47，自带测试在迁移后的目录实际执行 14/14。模型运行前自行清理未使用导入并两次修正测试代码，未收到人工实现反馈；这些自检过程保留在原记录中。证据 `quality-review/1015AF-deepseek-first/` 的 evidence.json、oracle.json、self-test.txt 及四份原件。本题首轮达到此前 Grok 的同题 47/47，不据此认定完整 D07／D08 或全部任务质量对齐。


### 2026-10-14 执行机制与产品体验边界

源码复核依据：[Bot 忙时交互与后台执行](./bots-background-source-review-20261014.md)。Grok/Hermes 的普通后台命令由进程管理器承接；Cmb 已有 `executeBackground`。已复用其生命周期接入 Bot 持久通知，撤掉强制转 workflow 的临时路径。1014Z/AA 已验证后台运行时回复新消息及自动交付，AC 验证步骤间补充要求且命令不重复，AB/AD 验证真实进程停止；1014AF 已验证 Mac 私聊主执行命令在收到新消息时原进程移交后台、及时回复并自动交付；模型请求本身的即时中断、其他工具及 Windows 仍未完成验收，不能计为完整忙时体验对齐。任务描述转 workflow 适配层已撤回，普通长命令不再包装成额外子 Agent。1014Y 亦出现动态导入、阶段格式及 `require is not defined` 错误，已在界面取消。

Workflow／Team 是原 CmbCowork 可复用的内部执行机制，不是 Grok Bot 对齐项，不要求 Bot 用户选择或理解这些模式。用户直接交办目标、补充消息、停止／继续、确认具体操作并接收成果。内部任务组织由 Bot 决定；主聊天中现有工作流脚本、runId、子代理统计及开发者式运行面板仍属体验差距，不能因为复用了原组件而算作已对齐。后台实现的验收仍依据忙时交流、任务延续、停止有效和主动交付，不以某种执行模式跑通为完成标准。审批应保留完整操作依据，同时以实际将执行的工作表述，不要求用户编写或配置工作流。

### 2026-10-13 体验差距纠偏

此前“代码实现约 90%”不能代表用户要求的 Grok 使用体验完成度，撤回该总体估算。按实际路径验收；下列缺口不能用 Runtime 复用、构建成功或基础动画已接入替代：

| 路径 | 已核实的现状 | 尚需交付 |
|---|---|---|
| 新聊天 | 已改成主区域选择收件人／新建 Bot；实屏验证已有 Bot 草稿衔接、新 Bot 直接进入聊天；正式 Bots UI 不显示执行模式 | 群创建与附件草稿衔接、键盘操作、失败恢复完整对照 |
| Bot 管理 | 置顶、标签、右键操作、手动未读、仅隐藏、分组已接入并完成部分实屏验证；群列表现已复用同一套菜单 | 群菜单、分组移动／移除、标签输入法、窄窗口与明暗主题的完整实屏对照 |
| 任务与协作 | 私聊、群任务、后台 worker 可实际执行；单次协作交流已接入真实派发／回执记录，发送与接收入口、群内入口已实屏验证 | 同一对 Bot 的连续历史、历史清理后展示；消息、成果、审批、停止与完成的完整对照 |
| 动画 | 复用 Hermes 共享时钟、姿态过渡和离屏暂停；使用 turn/tilt/gaze/roll/blink，思考／执行／等待接入原 Runtime 状态 | 更多 Grok 活动状态、动作曲线、切换时序与录屏对照；状态接入不等于动画视觉已对齐 |
| 电脑与资料 | 浏览器填表、上传、下载、文件打开已通过部分真实任务；独立窗口接管是本期已接受的差异 | 完整核对用户接管、异常恢复、交付入口及资料操作；保留允许差异说明 |

本次修复与验证记录：后台通知的隐藏用户边界导致相同 provider 回复被存为多条消息，已沿用原 transcript 存储增加固定轮次边界，未新增 Bot 历史副本。真实 MiniMax `后台回传复核-1013B` 两 worker 返回 25、15，最终汇总只出现一次，数据库只新增一条对应最终回复。随后发现多批通知已由前轮消费时，残留通知被标记 outcome_unknown；已在取得执行租约后复用原 manager 检查并结束空通知，针对性测试通过，最新完整实测待重跑。56 项针对性测试通过；普通消息回归通过；workflow 回归在原有 `claimPendingNotificationAsync` 源码形式断言失败，不能记为全通过。P03.3 仍未勾选。

置顶实现参考 Grok `ProductionRenderer.tsx` 的独立 pinned IDs 偏好与投影方式，复用本项目 `useBotViewStore`，按 host 隔离，不改 Bot 执行和原工作台状态。归档 Bot 不显示置顶卡片，取消置顶恢复原列表；卡片复用现有头像时钟和未读状态。新版前后端类型检查、构建通过，真实界面置顶／取消置顶通过。此项不代表 P09 整体完成。

2026-10-13 列表操作补齐：先核对官方 Grok 实屏右键菜单，再复用 Cmb 的 Radix ContextMenu 接入普通行和置顶卡片；重命名复用现有编辑与版本校验，只展示名称字段。隔离配置实测“非当前 Bot 重命名 → 归档 → 归档列表恢复”通过，当前新建 Bot 会话在前两项操作中保持不变。复制使用真实 threadId；删除仍走原确认流程；删除后清理对应置顶偏好。类型检查与构建通过。该轮尚未实现的手动未读、列表分组和仅隐藏已在后续补入，见末尾续记；归档仍独立保留。P09 整体仍未完成。

2026-10-13 标签与持久化：官方 Grok 实屏确认标签是头像下的一条可编辑展示备注，保存后以列表名称旁的小标记显示。新增 Bot `label` 字段、旧库迁移及有界验证，沿用原 Bot 更新／版本校验，不注入 Runtime 提示词；旧客户端省略字段时保留已有标签。界面支持 Enter／失焦保存、Escape 取消、清空和失败显式重试。隔离实屏验证保存“合成验收”、Escape 取消未保存内容、重启后标签与置顶卡片保留。迁移、旧调用兼容、清空、过期写入与无效输入测试通过；Host + Runtime 49 项测试通过，前后端类型检查和构建通过。标签徽标位置已按 Grok 截图改为名称同行；中文输入法组合态与长文本布局尚待实屏复核。

2026-10-13 真实 MiniMax `后台回传复核-1013C`：在正式 Bots 输入框派发两个异步 worker，分别实际返回 E=35、F=25；无需追加用户消息，先显示 F 的进展，再交付一份 E+F=60 的最终汇总。实屏与原 transcript 数据库一致，最终回复仅一个 provider occurrence；主任务和两次 coordinator 通知均 completed，无新增 outcome_unknown。该运行覆盖分批回传；“通知已被前轮全部消费”的空通知分支仍以定向测试为证，不能声称本次必然触发该分支。工作流与重启验收仍待完成，P03.3 保持未勾选。

2026-10-13 Grok 浏览器对照补记：官方客户端合成 Bot 返回 `form-result.json` 文件卡片（341 B）及下载位置，但明确报告未看到要求的 JS alert。尚未独立打开核验该文件，也不能据此判定全部浏览器步骤通过；本地 MiniMax 的对应上传／弹窗／回执验证记录保持原结论，两者差异继续保留。

1. 本文是本期实现与验收的依据。新增范围、删减功能或更换关键方案时，先更新本文并说明原因，不能静默降低要求。
2. 未完成项使用 `- [ ]`。实现且通过对应验证后，改成 `- [x] ~~原条目~~`，在条目下补充实现文件、验证命令／实测记录及结果。不能只因文件已创建或类型检查通过就勾选整个功能。
3. 已实现但尚未验证的条目保持未勾选，备注“已实现，待验证”。遇到失败记录具体问题，不将失败项移出清单。
4. 代码检查、集成测试、真实模型测试、UI 对照和跨平台安装验收分别记录。测试替身不能代替真实模型；Mac 测试不能代替 Windows 验收。
5. 不以新增代码行数或清单条目个数直接推算完成百分比。报告时列出完成模块、剩余模块、未验证范围。
6. 禁止写入密钥、登录 Cookie、用户私人任务内容或完整敏感日志。证据使用脱敏记录与合适的本地路径。
7. “覆盖本期要求”不等于“实现 Grok 所有版本全部功能”，也不等于静态审阅可以保证没有缺陷。是否完成，以本清单的实际验收证据为准。
8. 2026-10-15 用户最新要求：继续按目标修改、验证并更新本文；只有用户明确要求时才 commit 或 push。DeepSeek Bot 仅借鉴能解决当前具体问题的实现，不为参考项目新增框架或扩展本期范围。
9. 2026-10-16 用户补充：后续每项功能或交互改动均用真实MiniMax和DeepSeek分别验证对应场景，保留两个模型的任务／回执与结果；一套模型、静态审阅或单元测试不能代替另一套。未通过或不可用时保持该项待验并写明原因，不将历史其他场景的通过用于凑数。当前1016BG同样补齐两套模型验证后再划掉。
10. 2026-10-16 用户再次明确：发现问题后先完成这一问题的定位、参考源码核对、最小修复和真实双模型复验，再处理下一个；不能以模型最终自行恢复、界面隐藏错误或补一句提示词代替闭环。仍有可复现缺口时保持本项未完成，保留失败证据；不为修复关闭原有校验或引入整套并行机制。该要求适用于后续每项工作。

## 1. 本期要求与范围冻结

| 编号 | 用户要求 | 本期落实位置 |
|---|---|---|
| R01 | 新增 Bots 工作区，不能影响原功能 | 第 4、8 节；P01、P09、P11 |
| R02 | Bot 必须基于 CmbCowork Agent Runtime | 第 5 节；P02、P03 |
| R03 | Grok 核心功能优先 | 第 2 节；P02—P08 |
| R04 | UI 尽量一比一还原 Grok，核心动画同步对齐 | 第 8 节；P09 |
| R05 | 优先复用源码，减少改动 | 第 3、10 节；P00、P11 |
| R06 | Mac、Windows 本地原生运行 | 第 7 节；P07、P11、P12 |
| R07 | 未来用户可选择本地或远端 Bot，本期预留接口 | 第 4 节；P01 |
| R08 | 一期浏览器实现从简 | 第 7 节；P07 |
| R09 | 保留审批、恢复、正确性和资源管理要求 | 第 5、6、9 节；P03、P10—P12 |
| R10 | 真实 MiniMax 测试，与 Grok 及原 CmbCowork 效果对照 | 第 12 节；P12 |
| R11 | 先方案审核，再编码；完成并验证后逐项划掉 | 第 0 节；P00 |
| R12 | 用户可见品牌为 CMBDevClaw，避免无关改名 | 第 8 节；P09 |

### 本期必须具备

- Bot 创建、编辑名称／职责／头像／模型、归档、删除，稳定身份与长期会话。
- 持续对话、流式回复、补充要求、停止、继续、审批和补充输入。
- 沿用现有 Runtime 的编程、文件处理、技能、工作流、压缩与 checkpoint。
- 每个 Bot 的私有长期记忆及查看、修改、删除入口。
- Bot 私聊协作、群聊、参与者选择、异步交办和结果回传。
- 定时／周期任务回到指定 Bot 会话，完成通知与可见执行状态。
- 浏览器自动操作、专用登录环境、页面预览、上传下载、独立窗口接管与归还。
- 工作资料与可打开的成果文件；按授权范围共享资料。
- Grok 风格三栏工作区、明暗主题、核心状态动画与交互反馈。
- Mac、Windows 本地安装运行；远端接口边界明确但不提供虚假的远端入口。

### 本期明确简化与第二期范围

| 项目 | 本期决定 | 后续方向 |
|---|---|---|
| 浏览器人工输入 | 在专用原生浏览器窗口操作；右侧提供预览和接管入口 | 内嵌远程画面点击、键盘、中文输入 |
| 多 Bot 浏览器任务 | 共享专用浏览器，Bot 各自保留页面，自动操作排队 | 并行浏览器操作 |
| 任意原生软件控制 | 不作为本期能力提供 | 可选远端 Linux 虚拟桌面或经验证的平台适配 |
| 运行位置 | 仅本机，界面显示实际主机 | 连接远端、创建时选择本机／远端 |
| 已有 Bot 换主机 | 不支持修改 hostId 直接迁移 | 显式迁移历史、记忆、文件和任务 |
| 示范学习 | 使用已有技能能力；不提供完整视频示范学习 | 录制、脱敏、生成、验证与保存流程 |
| 群聊例行任务 | 第二期；本期例行任务归属单个 Bot，群协作保持现有功能 | 群计划归属、到期成员派发、来源权限、静默及生命周期处理 |
| 手机、跨用户共享、语音 | 第二期 | 按后续需求建设 |
| K8s 服务 | 仅接口预留，无部署承诺 | 认证、服务端化、持久化、重连与集群部署 |

以上浏览器差异必须在交付说明中保留。第一期不能据此宣称浏览器交互与 Grok 完全一致。

## 2. 核心行为约定

- Bot 的身份长期存在，不因名称修改、会话压缩或应用重启而改变。
- 常驻含义：应用进程仍在后台时可以执行；完全退出或关机后停止，重新启动时核对并恢复可恢复状态。不能宣传本地离线仍然全天运行。
- 一个 Bot 的顶层任务按队列推进，不同 Bot 可以有限并行。浏览器另有全局串行操作权。
- 用户消息优先于 Bot 协作与后台工作；明确停止操作生效。运行中补充要求的呈现与实际处理方式一致，不能显示“已采纳”却没有送入执行。
- Bot 通信为异步投递，不让两个正在执行的 Bot 同步互等。来自另一个 Bot 的内容保留来源，不被提升为用户授权。
- 群聊记录与成员执行上下文通过稳定标识关联；群成员只能看到允许共享的内容，不自动暴露私聊、记忆或凭据。
- 成功依据 Runtime 终态和成果证据判断。Promise 正常结束、模型自述“完成”都不足以单独证明交付成功。

## 3. 源码复核与复用清单

本轮核对 CmbCowork 基线 `c7723072`、Hermes `835c3dd038`。本地 Grok 目录无 Git 元数据，是标注为 0.18 的非官方重建库；不能据此证明当前官方客户端的全部行为。

### 3.1 CmbCowork：优先直接调用

| 源码 | 已核实事实 | 实施决定 |
|---|---|---|
| `src/main/agent/agent-run-service.ts` | 有统一运行入口、取消、投递和终态回调 | BotRuntimeAdapter 调用 startAgentRun，不复制执行循环 |
| `src/main/agent/managed-transport-delivery.ts` | 后台运行可使用窗口替身，已有消息转换及镜像 | 本期直接复用，避免重新实现流式解析 |
| `src/main/agent/runtime.ts` | 已有 additionalTools；可指定记忆开关、等待钩子和工具限制 | 补可选参数接线，并核对所有子 Runtime 的继承 |
| `src/main/ipc/agent.ts` | 附加工具未从上层透传；部分等待及通知逻辑只对 IM 开放 | 增加 Bot 来源和明确的能力参数，保留旧默认行为 |
| `src/main/checkpointer/sqljs-saver.ts` | 已有消息增量快照及恢复逻辑 | Bot 使用原 checkpoint，不新增完整历史快照存储 |
| `src/main/memory/store.ts` | 支持自定义目录；读取接口接受绝对路径；存储有缓存 | 复用存储，适配层负责路径范围与生命周期 |
| `src/main/memory/summarizer.ts` | summarizeAndSave 接受 memoryDir，并有目录维度串行处理 | 复用总结，避免另建总结引擎 |
| `src/main/storage.ts` | memoryEnabled 是全局开关与会话设置组合；computeNextRunAt 可复用 | Bot 记忆尊重开关，定时模块复用时间计算 |
| `src/main/services/im/conversation-turn-queue.ts` | 有唤醒、租约释放、取消及恢复模式 | 参考／提取可用逻辑，不伪装 IM 消息，不搬入 IM 授权模型 |
| `src/main/browser/core/browser-service.ts` | 单个活动会话；现有浏览器为应用级共享能力 | 保留原模块，Bot 使用专用浏览器 |
| `src/main/browser/cdp/playwright-mcp-bridge.ts` | 部分目标选择依赖 URL／标题，共享连接器 | Bot 不走该共享目标选择逻辑 |
| `src/shared/browser-script-recording.ts` | 已有定位器、变量与脚本处理纯函数 | 按实际需要调用，不带入单实例录制服务 |
| `src/main/db/native-sqlite-adapter.ts` | 已有 SQLite 打开、WAL 与恢复适配 | 复用适配器管理 Bot 控制数据，避免自建存储框架 |
| `src/renderer/src/components/chat/ChatMessageVirtualList.tsx` 等 | 已有消息虚拟化、Markdown、工具结果和审批展示 | 优先组合现有组件；必要时增加默认不改变旧行为的展示参数 |

### 3.2 Hermes：选择性移植，保留许可证

参考根目录：`/Users/chenqiang/Desktop/AI/hermes-agent`。

| 源码 | 采用方式 |
|---|---|
| `apps/desktop/src/plugins/hermes-bots/avatar.tsx` | 计划提取头像、状态表现与共享动画时钟；调整外观，不引入全套 SDK |
| `apps/desktop/src/lib/budgeted-loop.ts`、`renderer-loop-pause.ts` | 计划移植帧率、可见性暂停、休眠和清理，适配窗口接口 |
| `apps/desktop/src/plugins/hermes-bots/canonical-chat.ts` | 参考稳定的长期会话身份；实际存储与压缩沿用 CmbCowork |
| `tui_gateway/hosted_room_driver.py` | 参考会话执行接口、成员串行和群调度分层，不引入 Python Runtime |
| `tools/bot_live_delivery.py`、`bot_mode_dm.py` | 参考持久投递、接收者绑定、去重及不确定结果处理 |
| `tools/bot_desktop/lease.py`、`apps/desktop/src/plugins/hermes-bots/screen-pane.tsx` | 参考后台控制权、接管／归还及生命周期，一期不移植 noVNC |
| `tools/bot_desktop/runtime.py` | 已确认 Linux Xfce／Xvnc 平台依赖，本期不采用 |

Hermes Bots 顶层生产文件约 30,949 行，依赖会话、网关和 SDK；整体移植不符合最小改动目标。选择性移植需保留原许可证并核对涉及的第三方依赖。

### 3.3 Grok：产品行为与视觉参考

参考根目录：`/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main`。

| 源码 | 用途 |
|---|---|
| `source/host/extensions/transcript/run-scheduler.ts` | 用户、Agent、后台任务分队列与优先级 |
| `source/host/extensions/transcript/agent-to-agent-messaging.ts` | 异步私聊、群投递、目标校验和消息来源 |
| `source/host/agents/agent-messaging.ts` | 同事目录、通信工具说明、私聊／群聊的上下文语义 |
| `frontend/src/production/ProductionRenderer.tsx` | 列表、聊天、详情、输入框和电脑面板组合 |
| `frontend/src/recovered/features/computer/shell/controller.ts` | 预览、打开、接管和归还状态 |
| `source/electron-main/box/local-docker-host-connector.ts` | 理解 Linux 工作环境、连接和持久化；本期不引入 Docker |
| `source/host/extensions/teach-recording/teach-recording-service.ts` | 了解示范学习依赖，放第二期 |

Grok 重建库的 NOTICE 未授予上游源码许可，不将它列为已获授权可直接复制的交付代码。UI 和动画以官方客户端的实际行为为最终参考；已读源码不等于已完成实屏对照。

### 3.4 DeepSeek Bot：针对性源码复核（2026-10-15）

用户允许借鉴确有价值的实现，同时要求避免过度设计。已阅读本机 `/Users/chenqiang/Desktop/AI/DeepSeek-Bot` 的 README 及以下源码；本轮没有移植其代码、增加依赖或扩大一期范围。

| 源码 | 可参考之处及本期处理 |
|---|---|
| `ds-bot/src/host/delivery.js`、`turns.js` | 使用原 DSH Session 的 steer/followup，来源与 exchangeId 跟随投递。确认继续使用 Cmb 原 Runtime 和已实现的来源/回执接线，不另建 Agent 循环。 |
| `ds-bot/src/host/memory.js` | 有界增量审阅、失败不推进已读游标、写入时重新检查归属，值得作为记忆异常验收参考；本期保留既有私有记忆、版本校验和待总结失效机制。其团队共享记忆及 Main Bot 权限不引入。 |
| `ds-bot/src/client/motion.js` | 选中背景与面板变化从当前画面/速度接续，使用 ResizeObserver 并在卸载时回收；作为现有动画的中断/清理检查点。已有 Grok 动作内核及共享时钟优先，不增加另一套动画驱动。 |
| `ds-bot/src/client/mark.js`、`characters.js` | 有静态聊天头像、群头像布局及状态收尾处理；其原创角色与 Grok 外观不同，本期不替换头像资源。 |
| `ds-bot/src/host/parts.js`、`steward.js` | 自建分段/检查点及上下文管理，耦合 DSH；本期继续复用 Cmb 原存储、压缩和恢复。群管理员默认代答也与已实测 Grok 收件语义不同，不采用。 |

## 4. 架构与本地／远端边界

```text
Bots 工作区（复用消息、文件、审批等组件）
          │
      BotClient 协议
          │ 按 hostId 选择客户端
          ├─ LocalBotClient → 受限 preload / IPC → LocalBotHost
          └─ RemoteBotClient（本期仅协议边界，后续实现）
                                                   │
                                   Bot 管理、队列、协作、定时
                                                   │
                                    BotRuntimeAdapter
                                                   │
                                     startAgentRun
                                                   │
                                  CmbCowork 原 Agent Runtime
```

- UI 只依赖 BotClient。BotHost 负责调度和数据的权威状态，renderer 不拥有后台任务队列。
- 本期不为接口预留而提前创建 HTTP 服务、WebSocket 网关或远端控制台。协议版本、事件序号、请求 ID 和能力声明在本地接口中实际使用。
- 资源标识按主机命名空间解释，防止未来本地与远端同名 ID 冲突。模型配置引用也属于主机，不能把本机密钥或路径直接传给远端。
- 基础协议包含 Bot CRUD、历史分页、发消息／取消、事件订阅、审批／补充输入、文件访问、浏览器状态／接管、主机能力和模型目录。
- 文件接口以文件标识为入口，本地路径只由主机适配器解析。未来远端实现可提供下载，不要求 UI 打开服务器路径。
- 新增 Bot 业务模块不导入 Electron。窗口、IPC、凭据和 Runtime 调用放在本地适配模块；必要类型用共享纯数据契约。
- 第一期保持原有会话的数据处理链路，通过适配接入 UI；不建立同一消息的第二套权威状态。
- 原 Runtime 仍存在 Electron 依赖。后续 K8s 化需要真实的服务端适配、认证、恢复和部署工作，本期不能声称换 URL 就能上线。

## 5. Runtime 接入与权限

1. 上层增加可信主进程扩展参数，透传附加工具、Bot 作用域、等待钩子和通知归属。前端不能传入任意工具实现或 Runtime 配置对象。
2. 使用 Bot 执行来源与原线程运行租约；同一线程在任何入口都不能并发执行。Bot 队列还需控制同一 Bot 在不同会话间的冲突。
3. 子 Agent、工作流、后台 worker 和模型故障切换重建 Runtime 时必须保持有效作用域。异步子任务要使用自身的运行信号和生命周期，不能复用已结束父任务的取消对象。
4. 同步子任务已有工具继承行为；不能假定 additionalTools 只供主 Agent 使用。通信、记忆、浏览器工具使用可信身份绑定，执行时校验当前授权。
5. MCP 限制覆盖发现、直接调用、延迟调用和 fallback。Bot 不得经旧 In-app-browser 连接器绕开专用浏览器控制权。
6. 同一用户本机执行属于已有本机权限边界，不宣传 Bot 目录或工具范围等同于操作系统沙箱。原有命令、文件和危险操作审批继续有效。
7. 用户关闭 Bots 页面时，任务继续由主进程管理；等待审批状态持续可见。进程退出后旧的内存审批无效，恢复时重新核对并按需重新请求。
8. 后台 worker／工作流结果只由明确的通知所有者安排汇总。避免 Bot 队列与原通知调度器同时汇总，或双方都不接收。
9. 依据 onRunTerminated 等现有终态区分成功、失败、取消和未知。成果信息从实际文件及工具结果导出。

## 6. 数据、记忆与恢复

- 复用原会话消息、流式投影、文件与 checkpoint。新的 Bot 控制数据库只保存身份、关联、群成员、收件箱、投递回执、定时与必要状态。
- Bot 私聊绑定长期会话；群聊有稳定的群身份和成员执行关联。按需要投递群事件，不为每轮复制全量群历史。
- 每个 Bot 的记忆写入自己的目录；共享知识需明确授权。Bot 会话关闭原自动全局／项目记忆链路，由 BotMemoryAdapter 调用底层；仍尊重用户总开关。
- 记忆复用来源须准确：bot_memory_search是本项目新增的Bot范围工具，实际复用原MemoryStore检索，并非Grok同名工具的移植。用户提供的Grok 0.18重构源码sand-memory.ts把常用记忆注入上下文，旧事实通过Read／Shell查询、修改通过update_state；Hermes memory_tool.py提供持久Profile及add／replace／remove。参考其长期记忆行为，保留CMB既有存储、检索及总结实现；不宣称直接复用了未移植的工具协议。
- 记忆读取校验规范化实际路径及符号链接；只关闭 memory injection 不足以隔离读写。缓存按需打开、并发初始化受控、空闲释放，只关闭自身管理的存储。
- 队列状态建议区分 queued、running、waiting_user、completed、failed、cancelled、interrupted、outcome_unknown。操作通过合法状态转换和版本核对进行。
- 未开始任务可恢复调度；执行中任务先对账 checkpoint 和交付记录。外部副作用未知时不得盲目重放。持久回执不能承诺所有外部操作 exactly-once。
- Bot 删除／归档、成员移除与模型配置改变，应使旧授权或绑定版本失效；不能让排队任务沿用已撤销范围。删除需说明资料处理方式并确认。
- 定时任务复用现有时间计算，记录触发唯一标识。主机睡眠后默认合并错过的重复触发，避免补跑风暴；一次性任务的过期处理须可见。

## 7. 第一期浏览器实现

### 路线

- 复用安装包已有的 Electron／Chromium 引擎及 Playwright 依赖，不另行下载或打包 Chromium。Bot 专用轻量宿主使用单独的持久化 profile；父进程仅连接该宿主的调试端点，不连接原工作台浏览器。
- 各 Bot 保留独立的 Page 归属；按稳定标识操作，禁止按 URL／标题推测目标。弹窗、新标签、下载和关闭沿用归属。
- 自动操作采用全局串行锁，以一次有边界的浏览器操作为单位；有取消、超时和释放规则。人工接管暂停所属Bot页面的观察和输入，归还后重新观察；其他Bot只可操作自己绑定的页面，短操作仍按同一锁串行，同一时刻仅允许一个人工接管。
- 右侧按需显示截图预览。仅在面板可见、有订阅者时采样，限制尺寸与刷新频率，最多一个截图请求在途，不缓存无限帧。
- 接管时将对应页面置于专用原生浏览器窗口供用户直接操作；Bot 的浏览器工具停止输入。登录等敏感接管期间暂停发给模型的页面观察。
- 归还后重新观察目标并校验租约版本，不能继续使用接管前的坐标或页面引用。用户关闭窗口、进程崩溃或取消任务时明确更新状态。
- 不提供原生操作系统级桌面控制，不在页面中用按钮冒充无法执行的能力。

### 选型依据与成本

- 原 `BrowserService` 以单个活动会话组织导航、录制和状态广播，不能直接当成多个 Bot 的页面管理器使用。将其改成多租户会扩大对原功能的影响，因此本期保留原服务，复用其底层 Electron 引擎。
- 所有本地 Bot 共用一个按需启动的浏览器宿主，各自持有页面；不为每个 Bot 启动一套 Electron。独立宿主仍有额外进程和页面内存成本，需要验证生命周期及峰值占用，不能把省去安装包资源等同于零运行成本。
- `BotBrowserEngine` 隔离页面创建、显示、隐藏和关闭；`BotClient` 隔离主机通信。后续 Linux／K8s 可接入服务端浏览器实现，但仍需要认证、会话持久化和远程接管等配套开发。

### 需要先验证的实现风险

- 专用浏览器窗口激活、页面切换、关闭语义与同一安装程序的宿主启动路径在 Mac／Windows 都成立。
- 主机上只允许一个进程拥有该浏览器 profile，避免文件锁冲突；退出清理只影响本应用创建的浏览器。
- 自动任务与人工接管交接必须等待安全的操作边界，不把“发出暂停请求”当作“已经停止输入”。
- 保持 Chromium 沙箱及正常权限配置，不为快速运行默认添加禁用沙箱参数。

如果这些条件无法成立，应更新本文说明具体障碍，不能悄悄改成操作用户默认浏览器或抢系统鼠标。

## 8. UI、交互与动画

- 独立 Bots 工作区：左栏 Bot／群聊，中栏持续聊天，右栏详情／资料／浏览器。进入 Bots 后收拢外层导航，保留返回原工作区的入口。
- 对照 Grok 记录相同窗口尺寸下的栏宽、留白、字体层级、头像、图标、气泡、输入框、菜单、圆角和明暗主题。
- 覆盖创建、编辑、归档、删除、切换、群成员管理、搜索、未读、错误重试、审批、附件、预览、接管和返回；不能只美化静态首页。
- 复用消息虚拟化和内容组件；Bots 样式通过局部作用域或可选参数提供，默认行为不影响旧会话。
- 动效清单包括头像闲置／工作／等待状态，hover／press，消息出现，面板开合，切换、加载和错误反馈。先观察官方客户端，再调整时长、节奏和缓动。
- 隐藏、离屏和空闲状态停止无用动画；支持 prefers-reduced-motion。流式 token 更新不重新触发整条消息入场动画。
- 保持滚动锚点、输入草稿和键盘焦点，切换 Bot 不串输入，不将正在阅读的用户强制滚到底部。
- 所有新界面使用 CMBDevClaw 品牌；不改内部标识、存储路径及无关文件名称。素材使用自有或可授权来源。
- 一期浏览器接管窗口与 Grok 的差异单列，其余 UI 的具体差异逐条登记与修正。

## 9. 生命周期与性能约束

- 事件驱动唤醒队列，整体运行并发有上限；等待一个 Bot 不应阻塞无关 Bot。
- 所有任务、订阅、定时器、动画循环、浏览器页面与记忆缓存都有明确所有者和释放路径。
- UI 订阅只覆盖当前需要的内容；列表与历史分页，流式更新合并，事件缓冲有界且可通过持久状态补齐。
- 数据库保存必要增量，不按 token 写全量历史。文件通过引用传递，大附件避免在多个状态容器间复制。
- 正常退出停止接收新任务，取消／结算活动任务，再释放资源。崩溃恢复走对账流程，不依赖 finally 必然执行。
- 性能验收记录测试机器、场景、Bot 数量、消息量、运行时长及前后数据。不能只凭“感觉流畅”宣布无内存或 CPU 问题。

## 10. 文件边界与代码量估算

主要新增位置：`src/shared/bots/`、`src/main/bots/`、`src/main/ipc/bots.ts`、`src/preload/bots.ts`、`src/renderer/src/features/bots/`。

必要接线涉及：App 主视图、侧栏入口、store 视图类型、main 启停、preload 与声明、AgentRunExecutionContext、执行来源与租约类型、Runtime 工具组装和子 Runtime 参数传递、少量聊天组件可选样式、打包配置。

不整体重写现有普通会话、项目模式、记忆、浏览器或自动化。对既有文件的修改逐项说明用途和旧默认行为的回归证据。

| 类别 | 规划区间 |
|---|---:|
| 新写业务、适配、浏览器及界面代码 | 3,800—5,500 行 |
| 移植并调整的已有代码 | 1,700—2,500 行 |
| 新增与适配测试 | 1,500—2,000 行 |
| 新增合计 | 7,000—10,000 行 |
| 既有文件修改量（单独统计） | 400—800 行 |

远端接口预留约 250—450 行，已计入上表。以上是估算，移植清单还需按实际依赖裁剪确认；不为了达到行数省略正确性处理，也不为凑行数搬入无关代码。排除二进制、依赖、生成文件、锁文件和图像资产。交付时另报实际新增、删除、既有文件变更及测试代码统计。

## 11. 实现检查清单

按实现与验证结果逐项更新。勾选表示该项列明的代码和验证已完成，不代表 P12 真实模型及跨平台验收完成；源码调研不计作功能完成。

### P00 — 方案与基准

- [x] ~~P00.1 用户审核本期范围，确认独立窗口接管和浏览器串行属于允许差异。~~
  - 依据：2026-10-12 用户明确“按照这个方案开始编码”；浏览器从简与本地优先沿用已批准范围。
- [ ] P00.2 记录官方 Grok 客户端版本及核心流程基准，建立截图／录屏索引与差异表。
  - [x] ~~核实当前官方客户端版本。~~ 2026-10-13 `/Applications/Grok Bot.app/Contents/Info.plist` 为 `0.70.2`（build `0.70.2`，bundle `com.anysphere.sand`）。本地重建源码标注 0.18，不能据其界面推断当前全部操作；本轮新聊天附件和可搜索收件人以 0.70.2 实屏为准。完整基准截图／动画录屏与差异表仍待补齐。
- [x] ~~P00.3 确定移植文件、保留许可证、依赖裁剪和本项目直接复用入口。~~
  - 直接复用入口见第 3 节。Hermes 保留 `budgeted-loop.ts`、`renderer-loop-pause.ts` 等共享时钟／生命周期实现及对应 MIT 许可证；后续用 Grok 独立角色内核替换了原近似轮廓与表情代码，来源、哈希和边界记于 animation/vendor，未将该内核标为 Hermes MIT。未整体引入 Hermes 会话／网关／Python 依赖，未复制 Grok 重建库的 Runtime，未新增 Chromium 分发。

### P01 — 协议与本地适配

- [x] ~~P01.1 定义带主机作用域的 ID、版本化请求／响应、事件与能力声明，协议不依赖 Electron。~~
  - `shared/bots/contracts.ts` 定义协议版本、主机能力和稳定身份；注册表校验主机／版本，模型及文件使用所属主机的引用。远端传输留在第二期。
- [x] ~~P01.2 实现 LocalBotClient、受限 preload 和校验完整的 IPC，UI 从统一入口访问本地 Host。~~
  - `preload/bots.ts` 仅暴露具名接口；IPC 校验主机、资源标识、版本与输入。2026-10-12 IPC、客户端注册、Runtime 接线和 MCP 范围共 18 项回归通过；正式界面已完成私聊、群聊、记忆与定时调用。
- [x] ~~P01.3 预留远端客户端注册契约，未知／未支持主机明确拒绝，文件及模型引用不假定本机路径。~~
  - `client-registry.test.ts` 已验证未知主机拒绝、版本／主机不匹配拒绝和类实例网络适配器契约；原生 preload 冻结对象可用。远端网络实现仍属第二期。

### P02 — Bot 身份与数据

- [x] ~~1018CD 补BZ尚未成立的标签并发保存验收。~~沿用原版本保护、标签草稿和明确重试，无新增生产代码。MiniMax c92304fb…在直接授权中一次list／一次45秒Node／一次teammate更新；DS标签草稿先在版本5建立，真实名称更新后版本6，按Enter实际提示“Bot已被修改”，草稿保留且控制记录逐项未变；明确重试后仅标签写入版本7，最新名称／其他资料未覆盖，随后通过同一界面恢复原空标签版本8。DeepSeek 9965f523…同样只用三工具，MM草稿在版本12建立，真实名称更新后版本13；保存被拒绝且草稿保留，取消后未保存标签，资料完全保持新版本。
  - 首次MM的25秒任务在编辑前已完成、首次DS也未建立有效在途草稿，均不计冲突通过；相应实际改名和回执保留，由45秒重放恢复原名称并完成验收。中途AX出现旧输入框名称，原生截图已显示新名称；部分输入与状态反馈延迟，未以旧AX认定产品名称错误或增加公共输入／绘制兜底。期间DS授权任务实际已发送并完成，不把最初“未确认发送”的观察当最终事实；未出现其他请求或越界修改。
  - 正常Quit的全部所属PID退出后用同配置重启，813任务／4757核心消息头及Bot／群／例行／文件逐项相同、无重放。重启后MiniMax aaf811b3…／DeepSeek 650e9c94…均0工具，逐字回复当前原名称，没有沿用临时身份。最终815任务／4761消息头、0活动；原809任务、38Bot实际资料（仅两位合成Bot的version／updated_at按操作递增）、10群、9例行、26命令、249文件及4725旧消息头保持，两库quick_check=ok。用户红色flower与所有其他外观／模型保持，原mask39字草稿、80px栏和关闭详情恢复。源码与完整主程序构建SHA未改，84项证据核对通过。证据quality-review/1018CD-profile-conflict/{before,mm-draft-pending,mm-after-peer,mm-rejected,mm-retried,ds-draft-pending,ds-after-peer,ds-rejected,task-windows,model-routes,after-restart,final,review}.json及UI原文／review.py；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018CD-profile-conflict.tar.gz。此项补齐BZ并发保存／草稿保留局部验收，不代替全部资料／整体UI或Windows；未commit／push。

- [ ] 1017Z 自然中文创建同事与首次交付。1017X曾实际出现中文requestKey被原schema拒绝；当前字段只有正则、没有自然语言描述。仅在原bot_create_teammate.requestKey的schema补充现有ASCII格式及重试复用约定，不改变Store幂等、身份、权限或注册；Grok源码CreateAgent采用真实持久同事及专用资料工具，当前继续复用CMB已有工具／Host／Runtime，不复制其云端文件约定。用首次调用创建工具的DeepSeek会话自然交办，不在用户消息提供格式提示或指定键，核对一次创建、职责／模型继承、原有身份不变，再打开新同事验证问候、职责及首次文件交付。保留模型错误及人工介入，有限成功样本不宣称所有模型再无错误。MiniMax／Windows未通过前保留整体验收缺口。
  - [x] 1017AC补MiniMax自然中文首次创建：一次合法ASCII key、一次持久创建及原模型继承成功，首次打开才问候并接受真实用户交办，无重复身份。未补同题文件交付，不将命令结果代替文件验收；原Z的DeepSeek文件证据仍独立。
  - [x] 1017Z 已仅给原requestKey schema增加ASCII格式／稳定重试描述（4行），未改正则、创建协议、Store／Host或默认Runtime。tools／runtime-adapter／introduction共64项、node类型、lint、格式、正常构建通过。正式UI选择首次使用创建工具的X2／DeepSeek会话，自然中文消息未指定requestKey或提示格式；实际一次list、一次create，键delivery_verify_1017z_ds合法，无参数错误或重试，只新增交付核验-1017Z-DS（created-bdced71c…a541），职责原样保存、model_ref=custom:deepseek-v4-flash。创建时intro_pending=1、没有子任务，首次打开才产生一次无工具的中文职责问候。
  - [x] 1017Z 新Bot首条用户任务4692d25f…completed，实际write_file→read_file→bot_deliver_files各一次，0工具错误；正确名称／职责、三笔14.20／-3.05／0.08、合计11.23、相对11.20差额+0.03和少计结论均在776B报告中，独立Decimal核算及实屏附件打开通过。报告SHA256=e723d6fec41ef8a99591102c615356cd818b0df01e7c32c91732f24e77e1944e。UI编辑页职责、DeepSeek模型、蓝色水滴与实际存储一致，未改配置。原30Bot、485任务、8群、9例行、19命令及178跟踪文件不变。
  - [x] 1017Z 正常Quit主进程1911并独立确认消失后同配置重启；488任务／31Bot／19命令及179文件与重启前一致、quick_check=ok，问候仍仅一条；原报告再次实屏打开，未重建身份／重跑任务。恢复原AE群与空草稿。证据quality-review/1017Z-natural-teammate-create/{before,requested,created-bots,opened,completed,before-restart,after-restart,review}.json及相关日志。
  - [ ] 1017Z 整体差距仍保留：初次创建为有限样本，不证明所有模型参数永远正确；创建进度曾有两句英文，尚未销项。原编辑弹窗Escape焦点问题已后续修正，并由1017BE实屏确认；MiniMax创建及首份交付由AC／AN补验，不能继续把旧额度失败当作当前不可用。Windows及启动BV仍未解决，P02／全部体验不据此勾选。
  - [x] ~~1017BE Bot浮层返回焦点复核与同类缺口修正。~~当前正式预览先确认资料菜单编辑与直接编辑职责的Escape均已返回原按钮，旧Z焦点记录不继续当作现状；另实际复现资料菜单取消删除、侧栏取消重命名返回HTML根。复用原BotEditor／BotSchedulePanel的连接中入口引用及Radix关闭回调，将侧栏持久行入口交给已有编辑／删除弹窗，菜单关闭时不与新弹窗争抢焦点；不改共享Dialog、Runtime、保存／删除调用，不新增全局监听、计时器或状态库。Grok recovered sand-floating-primitives.tsx的connected-opener／preventScroll仅作相同行为参考。
    - 正常退出旧主进程67854及全部4个所属进程后构建新版。实屏7条路径均返回准确入口：详情删除Escape，mask侧栏重命名Escape／删除取消，群重命名Escape／删除取消，DeepSeek侧栏删除Escape及MiniMax侧栏重命名取消；没有执行删除或保存改名。真实DeepSeek任务eb6d44a4…、MiniMax任务c2892748…均completed／0工具，准确回复当前名称与64。原632任务、35Bot、10群、9例行、21命令、227文件及3816条旧核心消息头逐项保持，最终634任务／0活跃、两数据库quick_check=ok。mask原39字符草稿、280px侧栏及详情恢复；一次返回mask的点击未实际切换会话，已重新核对后点击成功，期间没有向旧会话输入。38项邻近回归、web、格式及构建通过；三份小组件lint通过，BotsWorkspace与HEAD比较仍相同1个既有set-state-in-effect错误及4个既有警告、无新增诊断，不称整个lint通过。证据quality-review/1017BE-dialog-return-focus/{before,models-complete,quit-check,final,review}.json及review.py、/tmp/cmb-1017BE-{tests,web,build,baseline-lint,current-lint}.log/json。仅覆盖Mac该交互，Windows与完整UI／动画仍待验；改动未再次提交／推送。

- [x] ~~1017AN MiniMax已创建同事的首份报告交付补验。复用1017AC自然创建且继承模型的既有Bot，不新增身份、修改职责或模型；其工作区目前只有原setup-state.json。沿用1017Z DeepSeek的相同三笔金额、草稿合计及首次报告文件要求，直接在正式私聊交办、单次审批后核对真实写入／读回／附件，独立计算并打开报告。随后正常退出／重启，核对稳定身份、文件SHA、成果重开和无重复任务。Bot当前职责为空，按真实配置评价，不能冒充职责继承新样本，也不能称当前任务是创建后的第一条消息；仅补其首份文件交付及同题MiniMax缺口。沿用既有Runtime／文件与交付工具，不改公共harness。~~
  - 真实MiniMax fa14cceb…与Z的DeepSeek用户请求逐字相同，write_file／read_file／bot_deliver_files各一次，completed且无工具错误；354B原报告的名称、三笔数据、11.23合计和正确减草稿=0.03均独立核算并实屏打开。职责确为空且模型如实说明；未见新审批，不计作单次审批验收。原生Quit2748／原4进程全消失／exec exit0后同配置重启，567任务及全部Bot／群／例行／命令、206文件、3403核心消息头均保持，原工作台线程仅updated_at前进；同一成果卡片再次打开正确报告，SHA7cfb32ea…保持，无重复任务。原566任务、205旧文件及所有定义不变，仅新增这一份合成报告，无新记忆／命令，0活跃，两数据库quick_check=ok。恢复原身份群@草稿、资料库、295／360宽度、深色及Bot颜色。首个审计多加“少／偏低”措辞断言，已按原题纠正并保留记录，未改模型文件或反馈后冒充首轮；严格线程头比较的updated_at差异亦保留。证据quality-review/1017AN-minimax-teammate-delivery/{original-task,delivered,file-review,before-restart,quit-check,restart-comparison,review}.json。未改生产代码；本项仅补MM同题文件样本，Windows及Z整体父项不据此勾选。

- [x] ~~1016I 聊天中修改同事资料。~~ 参考 Grok `sand-agent-management-tools.ts` 的 UpdateAgent，增加 `bot_update_teammate`，复用原 BotStore.update、当前用户来源校验及已有资料工具注册。只合并非空名称／职责；群内仅当前成员可改，协作／例行／通知无此权限，忙碌目标沿用原修改限制，无新表／IPC／Runtime。官方 0.71.2 实际完成“记忆核验助手”改名及恢复；原应用真实 DeepSeek 完成合成同事改名／恢复，MiniMax 完成职责修改／恢复，四条任务全部 completed 且真实工具回执存在。独立 SQLite 比对确认目标版本 1→5，原名称／职责已恢复，其他 20 个 Bot、7 个群和目标同事任务记录完全不变，没有顺带唤醒或交办。114 项 Host／Runtime／工具／资料事件／头像状态测试、前后端类型检查、原 messages 回归及构建通过。证据 `quality-review/1016I-update-teammate/{before,renamed,name-restored,role-updated,after}.json`。DeepSeek 多说了缩写内部 ID，原样记录，不因此宣称文案完全对齐；群内修改与忙碌拒绝为 Store 定向测试，未冒充真实模型或 Windows 验收。

- [x] ~~1016E 聊天中创建常驻 Bot。~~ 复核 Grok `agent-messaging.ts` 的 CreateAgent 与官方主 Bot 既有创建“资料校对助手／结果核对助手”的完整记录，补齐 `bot_create_teammate` 窄接口，复用 Host／Store 创建、原目录、订阅与协作。模型沿用当前 Bot，使用独立 thread／工作区／记忆；不自动运行、入群或复制私聊。Store 核实当前直接用户来源，稳定任务／请求键幂等，同键异内容拒绝，协作／例行／终态无创建权限；无新表或 Runtime。原应用中真实 DeepSeek 先查目录，再创建“合成校对同事-1016E”（任务 `822f1ea1-d4b3-4e32-9eb4-916375ba02cd`），创建后无同事任务；后续单次交办核对完成，唯一同事任务及自动回传均 completed，汇总 50.75／草稿多计 2.00 并保留来源。原有 20 Bot／7 群配置未变。正常退出 0、同配置重开后新 Bot ID／thread／职责／模型相同，原交流和核对结果仍可见，未自动重复交办。104 项 Host／工具／Runtime、资料事件与头像状态测试、类型检查、messages 回归和构建通过。证据 `quality-review/1016E-create-teammate/{before,created,collaboration,restart-store}.json`。首个电脑工具 typeText 丢中文的请求原样保留；随后先核对完整 paste 内容再发送，不将该工具输入错误计成模型创建失败。冷启动仍须原生缩放才恢复实际绘制的现场保留在 UI 总验收，不据此宣称所有冷启动问题解决。

- [x] ~~1015AB 群聊自身资料修正。~~ 实屏发现用户 @ Bot 改名被拒绝，原资料工具仅接入私聊。对照 Grok `sand-state-tool.ts` 的 `profile.set` 和原 beta `updateOwnProfile`，复用现有资料更新及版本校验，让正在执行的真实群用户请求也可修改接收 Bot 自己的名称／职责。主进程核实原群用户消息、收件人及当前成员；群内 Bot 转述、例行任务、后台通知和已结束任务不能获得该能力。模型、ID、权限、私有记忆均不变。

  1015AE 实屏／真实 DeepSeek 复验：原应用创建单独合成群，@ 外观核验-1014A 后通过 bot_update_profile 改为“资料核验-1015AE”，回答 19+23=42；随后引用该回复要求恢复原名，模型再次实际调用工具恢复。两次任务 completed，仅目标 Bot 被派发，稳定 Bot ID／原私聊 thread ID／职责／DeepSeek 模型绑定保持一致，另一成员未运行。消息和工具回执见 `quality-review/1015AE-group-profile/evidence.json`。补充介绍／记忆总结适配／群历史 13 项回归通过。该子项通过不代表 P02 全项或所有 Grok 群管理已验收。

  1015AD DeepSeek 文件任务：直接在原应用中，将已有合成测试 Bot 绑定用户已配置的 deepseek-v4-flash，沿用原 startAgentRun 完整链路。真实读取原 CSV、写入 JSON、读回、bot_deliver_files 附件交付均完成；独立核对 3 笔 17.25、24.50、-3.20，合计 38.55，正式文件预览显示同一内容。证据 `quality-review/1015AD-deepseek/evidence.json`；MiniMax 默认配置未变。此单题不代表 DeepSeek 长程任务、所有模型或整体质量已达标。

  代码修正后，Host／Runtime／工具 101 项测试、node 类型检查及构建通过；未修改通用 Runtime。用户新增授权使用已有 DeepSeek 额度，沿用正式配置的 `deepseek-v4-flash`，在明确标识的独立验收窗口补充真实任务验证，原预览仍保留用户当前正在执行的 DeepSeek 项目讲解任务；MiniMax 仍是原预览默认模型。未验证前不将模型可用或资料修改记为通过。

  1015AC 用户要求直接在原应用测试，并优先检查“需求沟通”群卡住的实际任务。保留现场后确认：MiniMax 两次请求均正常返回，随后两次 `glob` 对整个 Desktop 递归扫描没有 ToolMessage；主进程四个 libuv 文件线程均阻塞于 `scandir → readdir → __getdirentries64`，lsof 指向 Desktop 下两处 `dataless` iCloud 目录。原 `LocalSandbox.globInfo` 调用 deepagents `super.globInfo`，先完整递归、结束后才截断，既有路径不是本次 Bot 独立实现；该现场不能归因于模型额度、前端或未证明的锁等待。先保留原任务并按精确项目目录恢复，通用扫描／取消的改造不在此处擅自扩大。独立 DeepSeek 窗口不再继续测试，遵循用户最新要求。

  1015AC 恢复与交付：原任务已取消，正常退出因底层目录读取超时，随后 SIGTERM 退出；重启沿用原配置，20 个 Bot 的 ID 集合一致，SQLite quick_check=ok。通过原群回复入口给出准确项目目录后，MiniMax 读取中英文 README，交办本群 sean，sean 创建 Markdown 并通过附件交付，发起 Bot 自动接收结果。首稿存在无依据的 `npx ds-bot` 和隐私保证表述，人工审阅后要求按 README 修正；修订中两次错误使用只支持新建的 write_file，模型最终改用 edit_file，实际回读并交付 4,889 B 修订稿。安装／启动命令、社区身份与前置要求核对通过。两次工具错误在原 transcript 中仍标 status=success，是原工具错误回执的存量差异，本轮未修改共享 Runtime。保留首轮失败及人工纠偏，不据此宣称自主交付质量全部对齐。证据 `quality-review/1015AC-stuck-glob/delivery.json`。

- [ ] P02.1 实现创建、编辑、模型绑定、头像、归档和删除，持久化稳定身份与长期会话关联。
  - [x] ~~新建未绑定模型的 Bot 沿用默认模型，正式界面首次真实发送成功；旧空白 Bot 可重试原草稿。~~（1013E/F）
  - [x] ~~聊天修改名称与职责，保持 Bot／thread 身份；随后任务使用新的职责与名称。~~（1013G/I）
  - [x] ~~界面编辑职责、显式绑定模型和头像，真实任务使用新配置；归档、恢复及正常退出后冷启动保持身份、配置和历史。~~（1013AP/AQ）隔离配置中新建“收件人核验-1013AP”，选择蓝色六边形、MiniMax-M2.7 与合成数据核验职责；真实任务正确复述身份并计算 17.25 + 24.50 = 41.75。归档期间输入禁用，恢复后可继续输入；冷启动后编辑页配置、聊天历史及 Bot/thread ID 均保留，版本为 4，无重复 Bot。此项不覆盖压缩、活动任务中归档或删除。
- [x] ~~P02.2 实现控制数据 schema／迁移与事务；复用原会话和 checkpoint，禁止冗余完整快照。~~
  - 控制数据使用原 NativeSqliteAdapter；schema 升级与会话归属回填作为一个事务，旧半升级状态可修复且不覆盖群归属。Host／IPC 35 项回归、升级故障注入及实际 Host SIGKILL／两次重启通过。Runtime 仍调用原 startAgentRun、会话与增量 checkpoint，没有 Bot 版本的完整 checkpoint 副本；真实模型进程中断恢复验收见 P10／P12，仍未完成。
- [ ] P02.3 验证改名、压缩、重启不产生重复 Bot 或丢失历史；删除／归档与排队任务一致。
  - [x] ~~活动任务期间拒绝直接归档；明确停止活动任务与待办后可归档，恢复不重跑已取消任务，新消息可继续。~~（1014O）Mac 正式界面在 MiniMax 写入等待审批时追加一条待办，尝试归档返回“请先停止当前任务，再修改 Bot”，配置版本仍为 4，两条任务分别保持 waiting_user／queued。点击原停止按钮后，`9ad31166-2659-4195-807a-50f6830681c1` 与 `b6c36de9-aa40-4231-8edb-1716e4f22c09` 均 cancelled，目标文件未生成；随后归档禁用输入，恢复保持原 Bot/thread 身份与历史，版本为 6。新任务 `cc395778-80fb-4eb1-a395-2f39ace615f7` completed，实际回复 RESTORED_OK；旧任务仍 cancelled。此项不宣称点击归档会自动停止，也未覆盖删除与压缩。
- [ ] 1017D 归档时排队协作的取消回执。源码复核发现BotStore.update只批量把queued改为cancelled，未经过既有settle／reply outbox，发起方收不到“未执行”的终态；私聊与群的真实SQLite反例均为0份回执，已取消父任务不唤醒的负例保持通过。先归档并终结本Bot全部排队任务，再复用原settle为原本需要回复的协作生成一次取消回执，保留原root／成员／归档校验、requestId去重和事务；不新增调度器、通知存储、轮询、Runtime或公共锁改动。对照Grok异步收件后唤醒、Hermes终态／活动分离及原CMB pending-notification-scheduler的单一回传所有者，具体机制沿用当前Bot已有outbox，不声称参考项目有相同归档实现。核对恢复归档／重启不重放、取消父任务不复活，并通过正式界面构造真实排队后归档；MiniMax额度未恢复时不计完整双模型通过。首次群测试误用原始requestId查找成员任务的fixture失败保留，修正为真实成员任务后再确认两个相同的缺失回执失败。日志/tmp/cmb-1017D-before-tests-corrected.log。

  - [x] ~~SQLite正反例与DeepSeek正式界面定向复验。~~原Store改动净增11行：归档事务先终结全部排队工作，再仅给原本expectsReply的协作调用既有settle。私聊／群及取消父任务三项新增回归，连同原身份／恢复／历史／去重共91项通过，node类型检查、Store lint、变更文件格式和构建通过。正式界面两个DeepSeek任务fb8ff8e0…／70096eb3…实际等待，MM绑定同事6d9466cb…确认为queued后归档；它变为cancelled且未执行，635860ad…唯一取消回执进入原发起会话。选择结束根任务后，回执completed且没有重交办；另一个等待任务不受影响，随后通过其原问题正常结束。协作交流实际显示原要求和归档原因，Escape回到原入口。MM Bot恢复原归档／模型／职责等字段，仅版本4→6和更新时间发生预期变化；其余26个Bot定义、群和例行配置不变，135份跟踪旧文件／8份记忆无变化、没有新记忆。原生Quit旧PID56231并确认结束，同配置重启仍414任务、0活跃，四条原任务字段及更新时间完全一致、取消回执仍一条，quick_check=ok。证据quality-review/1017D-archive-queued-reply/{started,archived,restored,before-restart,quit-stable,after-restart,review}.json。MM收件人未开始调用模型，不能算MiniMax反向验收；真实群对应场景与Windows仍待验证，1017D父项不勾选。DeepSeek一次问题ID含大写被原schema拒绝后自行修正、最终取消说明带state:cancelled的表达差异均保留；不改公共schema或伪造零错误通过。BV窗口观察问题继续保留。

  - [x] ~~同一构建的群内归档与重启复验。~~沿用既有“资料核验-1015AE”，原子@只选外观核验／DeepSeek，初始仅一条群用户任务51736a59…；另一个私聊2035f180…真实等待。群内一次delegate给AP生成7e0fb1d1…，确认queued后通过原菜单归档AP，子任务cancelled，唯一回执5fb4f6f0…进入同一group-thread。原成员记录仍允许回应已有问题、自由输入保持只读；选择结束根任务后回执completed，无重交办。原群5条相关记录分别保留用户要求、交办、取消原因、根回复和取消总结；两个成员私聊的群标记均为0。AP恢复原配置／归档状态，仅版本6→8及更新时间发生预期变化，其他26个Bot、群／例行定义和135份旧文件不变，无新记忆。原生Quit旧PID63041且确认退出、同配置重启仍418任务／0活跃，本轮四任务字段及时间戳完全一致，取消回执仍一份。证据quality-review/1017D-archive-queued-reply/group/{before,started,archived,received,restored,before-restart,quit-stable,after-restart,review}.json。群进度用了英文、最终将“没有计算结果”表述为“无文字回执”的差异保留；MiniMax角色互换与Windows仍待验，不能据MM绑定收件人排队即算双模型调用通过。

- [ ] 1017E 协作回执的可读终态。1017D真实DeepSeek回复直接带出state:cancelled；源码确认自动回执封套由Store拼入内部枚举，虽已有禁止在普通回复暴露路由码的规则，仍给模型提供了不必要的内部表达。沿用已存在的botTaskStateLabel，仅把新回执封套改为可读终态；任务origin／state字段、outbox／requestId、附件授权与执行逻辑不变。历史交流投影同时兼容旧枚举和新中文封套，不改写持久旧消息，预览现有按封套边界处理继续复用。对照Grok的AgentInboundMessage身份／正文分离、Hermes groupActivityLabel终态转文案及本地现有状态函数，不新增消息协议版本、过滤模型输出或扩展提示词。验证完成／失败／取消／中断／结果未知、新旧历史、真实回执与重启；MiniMax不可用时保留其验收缺口。
  - 同轮删除／成员边界源码复核：Grok AgentLifecycle.interruptAgentForDeletion清除被删身份的pending inbound／wake／运行引用，当前Bot删除清理所属待办／例行／会话及未来回传、群成员移除阻断后续群投递，已有Host删除／重试／成员正反例包含在1017D的91项回归中。没有把归档回执扩到已被明确删除的身份，也未为复核永久删除用户数据；P02／P05完整实屏及Windows验收继续未勾选。

  - [x] ~~新旧封套及DeepSeek正常／取消回执复验。~~仅修改Store现有封套生成和交流正文投影两处，原状态函数直接复用，旧枚举与新中文封套各只移除一层；未重写历史或修改模型输出。新增五种终态用例修正前5失败，修正后103项相关回归、完整node／web、定向lint／格式及构建通过；本轮完整Bot／IPC／共享与派生展示回归51文件／409项通过。真实正常协作3050e289…→d39ece35…→c848e9d5…均completed，实际结果65，唯一新回执为“已完成”；正式交流正文仅保留65。取消场景b8f16cbd…／04322779…实际等待，MM绑定9604e6f6…确认为queued后归档取消，7991c139…唯一回传为“已停止”，模型准确说明未执行、没有编造64或重交办，本次新回复未带内部状态码；仍有“同伴侧终态”等生硬措辞，保留表达差异。正式同一对Bot交流同时显示1017D旧封套和1017E新封套的原请求及取消原因，无封套泄漏；Escape回到原入口。MM Bot原配置／归档恢复，仅版本6→8和更新时间变化；其他26个Bot、群／例行、135份旧文件／8份记忆不变、无新记忆。原生Quit旧PID83735且确认退出，同配置重启仍425任务／0活跃，7条任务字段／时间戳一致，正常及取消回执各一条；1017D旧回执原字段逐项未变。证据quality-review/1017E-readable-peer-receipt/{before,normal-started,cancel-started,archived,restored,before-restart,quit-stable,after-restart,review}.json。MiniMax本轮仍未调用模型、Windows未实机验证，1017E父项及整体一期继续未完成；BV窗口观察问题仍保留。

- [ ] 1017AJ MiniMax反向协作取消验收：复用1017D/E既有Store／Host／outbox和正式问题入口，以DeepSeek等待占用一个执行位、MiniMax交办后等待占用另一个执行位；确认同事仍排队后由正式界面归档，核对唯一取消回执回到原MiniMax会话、没有虚构结果或重新派发。随后恢复合成同事资料、结束等待、正常重启核对不重放；保留现有用户群草稿、模型与记忆配置。不以排队同事没有调用模型冒充双模型完整任务验收，私聊、群聊及Windows分别记录实际覆盖范围。

  - [x] ~~MiniMax私聊正常／取消回执及正常重启复验。~~正式界面先以DeepSeek任务f4a68568…实际等待；MiniMax根任务a644537a…只查询同事并交办一次，DeepSeek子任务60a439e1…返回65，唯一回传d804424a…正确汇总。取消根任务20dce98f…交办后实际等待，4fbd8aa7…确认为queued后归档接收方，子任务cancelled且无模型调用，唯一回传f71b4902…为“已停止／Bot已归档，排队任务未执行”；结束原问题后MiniMax准确报告未执行，没有虚构64或重交办。恢复BA原字段（仅版本3→5及更新时间变化），DeepSeek等待通过原选项正常结束。原生Quit主进程89410且原4个进程全退出、exec exit0；同配置重启后554任务和全部新旧任务字段／时间戳保持，正常与取消回传各一份，0活跃。原547任务、其余33Bot、9群／9例行／21命令及205旧文件逐项不变，无新文件／记忆，两数据库quick_check=ok。恢复原身份群的“@”未发送草稿、资料库详情、295px栏宽及深色；本次启动无需Zoom即可读取且截图正常，不据此销项既有BV。未改生产代码、模型或审批。证据quality-review/1017AJ-minimax-archive-receipt/{before-archive,archived,received,restored,quit-check,after-restart,review}.json。群内MiniMax角色互换与Windows仍待验，1017D/E及AJ父项不勾选。

- [ ] 1017AK 群内MiniMax反向协作取消：复用既有资料核验群，仅@现有MiniMax成员AP；另一DeepSeek会话实际等待以保持同事排队。核实群内交办给另一成员后归档的唯一回执仍归属同群、原问题可结束、不产生私聊副本或重交办；恢复合成接收方与用户原界面，正常重启检查不重放。沿用现有实现，不增加调度、模型提示或公共Runtime改动；实际结果分别记录，不能由私聊AJ通过推定群聊通过。

  - [x] ~~Mac群内MiniMax归档取消与正常重启复验。~~以K-DS的b9b064b7…实际等待；键盘@只选择AP，群根任务36a74f59…仅交办一次并请求原问题，c27b5bd2…确认为queued后由界面归档外观Bot，子任务cancelled且未执行，唯一回传84999d13…归属原groupId及AP的同一group-thread。通过群任务入口回答“结束群根任务”后，MiniMax准确报告“任务未执行（Bot已归档）”，没有虚构35、重交办或泄漏内部终态。AP／外观两份私聊中1017AK标记均为0。恢复外观Bot原配置（仅版本14→16及更新时间变化）、正常结束K-DS等待，原554任务、其余33Bot／全部群／例行／命令及205文件逐项不变，无新文件或记忆。原生Quit主进程30589，原4进程全退出／exec exit0；同配置重启仍558任务、0活跃，全部任务字段／时间戳、配置、文件及核心消息头保持，回传仍一条，两数据库quick_check=ok。恢复身份群“@”草稿及资料库详情、295px侧栏、深色；未改生产代码。证据quality-review/1017AK-minimax-group-archive/{before-archive,archived,received,quit-check,after-restart,group-messages,review}.json。首次审计误要求所有群成员共用一个thread，按既有groupId+memberId隔离修正断言后通过，该审计失误留于review；不是产品修复。Windows与完整Grok体验仍按原项待验，父项不勾选。

- [x] ~~P02.4 为控制任务增加分批历史清理，保护活动协作链、待投递回执、近期任务与请求去重。~~
  - `store.ts` / `host.ts`：保留最近 100 条终态任务，30 天前的其他终态记录每批最多清理 100 条；活动／近期协作链和待回传结果保留。任务正文不复制到回执，去重摘要保留至任务终态后 90 天（超出窗口不承诺旧 requestId 去重）。空闲调度入口最多每 10 分钟清理一次，无额外高频计时器；清理失败回滚且不阻断执行。会话、checkpoint 和成果不参与此清理；SQLite 释放页供后续复用，不强制 VACUUM。
  - `history-retention.test.ts` 覆盖分批与尾部保留、重试拒绝、活动协作／outbox 保护、故障事务回滚、独立于控制历史的群后台恢复索引；本轮相关 73 项回归及类型检查／构建通过。

### P03 — Runtime 完整执行

- [x] ~~1017AC Mac 当前核心门禁与MiniMax恢复后的本轮补验。~~按现CI Bot核心命令运行全套当前代码回归（src/main/bots、Bot IPC、renderer bot-派生展示、shared/bots），51文件／454项通过。原BS-MM会话56702d8e…实际恢复并回答42（同时夹带旧1017G题47，作为未按当前“只回答”要求的质量差异保留，不修改历史或声称完美）。继续正式界面用MiniMax自然创建新同事、首次交办后台任务／忙时补充、命令完成后专用资料工具续办、task_output正常／pending／异常展示和重启；沿用现W／X／Y／Z实现，不先为验收改Runtime。当前可用性不等于这些场景已经通过，逐项保留实际工具、来源、文件及重试。
  - [x] 1017AC MiniMax实机恢复：原配置IDcustom:minimax-m2-5实际模型MiniMax-M2.7，18次agent响应均HTTP200，未更换key／provider／模型配置。自然中文请求一次create，键1017AC-MM-teammate合法，仅新增created-96092942…9ebd同事，职责空、继承原MiniMax；未在用户消息提供ASCII参数提示。未先list且回复暴露长ID的表达差异保留，不宣称全流程无差异。
  - [x] 1017AC 首次打开后，用户任务ab306254…被原欢迎任务7d2e7fee…消费；命令3468efce…的source_task_id准确保存真实用户ID，两者在命令完成前均已结束。唯一execute启动60秒Node命令。32秒时新用户任务f8260df6…完成17+8=25及一次task_output(block=false)，真实not_ready；默认无工具卡，执行过程开关可恢复并展开原JSON。完成通知7ae15199…只调用一次bot_update_profile改为“后台交付完成-1017AC-MM”，无SQL／扫描／重跑，version1→2、其他字段保持；原intro／用户捕获时间窗口重叠的同一个call ID已去重，不误计两次执行或两份欢迎。
  - [x] 1017AC MiniMax补验Y：84d1c553…单次读取成功输出AC_MM_READY／exit0，默认收起；新3秒Node命令5335bff8…一次执行并以7结束，其通知0工具、不重试或改资料。edd16f9e…分别单次读取真实失败与missing-1017AC，两条原回执is_error均空，实际界面保留两个简短异常入口，展开为原始exit7和任务不存在错误。编辑页显示MiniMax-M2.7，Escape焦点回“更多Bot操作”；后续97309e16…0工具准确回复新名称／最后失败退出7。
  - [x] 1017AC 正常Quit主进程35820（exec exit0且ps消失），同配置重启仍505任务、32Bot、8群、9例行、21命令、181跟踪文件，所有行／哈希与重启前相同、quick_check=ok；新Bot唯一、欢迎不重播、两种异常入口仍在，成功记录仍默认收起，无重复命令／通知。原494任务／31Bot／群／例行／19命令及181文件逐字段不变，物理合成Node进程已无；恢复原AE群、空草稿及80／360侧栏。证据quality-review/1017AC-delivery-gates/{before,created-bots,first-started,supplemented,continuation-completed,all-cases,before-restart,after-restart,model-responses,review}.json、core.log。
  - 本项限Mac当前私聊流程及UI派生展示，不代替全部核心／Windows／Grok动画验收。原task_output elapsed问题在MM也复现：命令实际约60秒，延后读取回执147秒，模型错误称“总耗时”；原LocalSandbox实现已核实，按用户通用harness暂缓要求继续保留质量缺口，不据模型自报“验收通过”记为计时准确。

- [ ] 1017AB 用户可见回复语言一致性。1017X／Z真实DeepSeek多次在中文用户请求下先用英文描述开工或后台续办，最终才切回中文；现Bot只在introduction分支明确用户语言。原CMB通用prompt及本地Grok／Hermes参考源码未找到覆盖日常进度／通知续办的可直接复用语言规则，不声称已有同款规则。仅在既有Bot表达段补充显式用户语言优先，否则所有可见回复沿用最新真实用户请求的语言，工具输出／内部通知／引用同事不选择语言，代码路径和原样引用保留。不得增加语种识别器、语言存储、翻译过滤或修改公共Runtime。先用曾夹英文进度的同一X2／DeepSeek验证中文文件交付、真实后台完成、显式切英文与恢复中文，原回执及失败照实保留；MiniMax／Windows未验不勾选父项。
  - [x] 1017AB 无效改动／诊断清理及数据保护已完成（语言验收仍失败，父项不勾选）。仅AB尝试全部精确撤回，model-response-diagnostics.ts无diff，src／正常out均无诊断标记；原W／X／Y／Z／AA功能修改保留。清理后80项（5文件）、node类型、定向lint／格式及正常构建通过。普通环境启动后494任务、31Bot、8群、9例行、19命令、181跟踪文件与清理前完全一致、quick_check=ok；原489任务、全部资料及179跟踪旧文件未改。2次文件任务交付正确16.30，3次边界只读任务无修改，实际工具总数ls2／write2／read5／deliver2；无后台命令、未进行原定后续语种切换，不能算未运行场景通过。普通预览恢复原AE群、空草稿、80／360侧栏，启动BV仍需Zoom；最终证据review.json、cleanup.json、clean-restart.json及final-*日志。
  - [ ] 1017AB 第二轮ec72771a…语言验收仍失败：与首题仅新文件名AB2不同，ls／write／read／deliver均成功、917B报告合计16.30，但一条进度仍为英文。只读493f9e33…／d011556c…／123f7c29…中文最终正确，没有工具前进度，不能作为修复证明。原Runtime预览确认规则存在；随后HTTP最外层检查确认system为5个text块（18776／1077／282／2989／2635字符），第1块确实带规则。最初仅检查string得false不适用于数组，不据此认定规则丢失。证据attempt2-failed-review.json、actual-block-transport-markers.json。没有证据把责任完全归于模型或原harness，但已排除本次规则在客户端发送前缺失；不继续盲目堆提示。按用户暂不扩大通用harness的要求，精确撤回两版无效语言规则和全部临时边界诊断，保留W资料授权规则及其他既有修改，本项继续未完成。
  - [ ] 1017AB 模型边界确认：临时复用原getCapturedSystemPromptPreview，只记录taskId、字符数与两个布尔标记；493f9e33…的实际system为25847字符，通用语言／续办规则均存在，未记录prompt正文、模型推理或凭据。说明不是规则未注入；仅读回案例正确中文但没有工具前进度，不能据此冲掉首轮4句英文失败。移除无效的通用段扩充，改为在原直接用户进度规则和后台来源说明中具体限定可见进度／完成语言，仍无语种识别、翻译或共享Runtime改动；下轮用相同完整任务、仅换新文件名AB2验证，诊断交付前撤除。
  - [ ] 1017AB 首轮语言规则实测失败，保留为失败：同一X2／DeepSeek实际任务adbcf0aa…完成ls／write／read／deliver，报告930B、正确16.30、最终中文，但工具前4句进度仍是英文。71项相关回归、node／lint／格式及构建通过不代表行为通过。证据attempt1-failed.json及attempt1-failed-review.json；先检查模型边界实际提示是否包含规则，再决定后续修正，不盲目继续堆规则或过滤输出。

- [ ] 1017W 命令续跑后的资料工具归属。1017V真实DeepSeek将45秒Node命令转后台，正常命令回执轮次未注入资料工具，模型转而扫描应用目录并直接用sqlite3更新control.sqlite；旧名称草稿被版本校验正确拒绝，明确重试及原名恢复成功，但该后台修改路径不合格。对照Grok专用UpdateAgent／update_state资料工具、Hermes后台completion的owner_task_id与原CMB后台命令归属，复用既有bot_commands／Host／资料工具：新增可空source_task_id记录真实启动任务，不从通知文字猜权限；只有完成命令、同Bot／thread／群、未停止、原用户任务completed且群成员仍有效时，注入现有两个资料修改工具及完整原请求。新建Bot工具、Bot来信／例行／其他通知、旧无来源回执与崩溃结果未知不扩权，工具实际提交再次校验；原记录由有界命令回执保护，沿用原清理上限，不增加队列／Runtime／权限服务。提示词明确禁止通过Shell／SQL／普通文件绕过资料接口。先前实测和失败回归保留，修正后须DeepSeek同题通过正式工具完成并复核名称草稿，MiniMax和Windows不由局部通过代验。
  - [x] 1017AC 已补真实MiniMax私聊欢迎／用户来源的命令续办验证，与1017W／X的DeepSeek证据合并后，该Mac私聊路径具备双模型实际回执。群／其他同事修改、旧来源等仍按各自范围记录，Windows未验收。
  - [x] ~~实现、DeepSeek同题及正常重启的定向复验。~~新增一个可空命令来源列，旧14条回执迁移后均NULL、不推断新授权；真实新命令绑定原用户任务。第一版虽在装配日志已有两个修改工具且无创建工具，DeepSeek仍复制旧SQL做法，失败保留；随后将完整原请求与专用工具约束放入既有命令回执，不再在系统提示词重复整段请求。相同Bot／DeepSeek／210字原任务未增加人工工具提示：b9dcb2e3…只list并启动一次45秒Node，d4a8d818…命令完成后只bot_update_teammate和list，零错误／无SQL／目录扫描，真实修改成功且短资料事件可见。先前失败不改写成通过，当前成功样本也不是OS文件沙箱或任意模型零越权保证。431项52文件相关回归、node类型、定向lint、原desktop-agent-baseline及正常构建通过；旧失败回归1项先红后绿，两项证据测试误用db.get后改用原适配器exec，不当作产品缺陷。连续命令来源复用同一个原用户任务、有界回执保护原记录、群成员／跨归属／停止／取消／结果未知／旧无来源均有实际SQLite正反例，未修改原Runtime生产文件或增加权限服务。正常Quit56885且ps确认消失后同配置重启，470任务、16命令、全部配置与178份跟踪文件逐字段／SHA一致，无重放，恢复原资料核验群、360px详情、80px侧栏与空草稿，quick_check=ok。MiniMax额度、Windows及完整P03继续待验；BV冷启动仍需原生Zoom，未新增生产兜底。证据quality-review/1017W-command-profile-continuation/{before,attempt1-failed-review,attempt2-completed,successful-attempt-review,before-final-restart,after-final-restart}.json及prompt.txt、capture.py；/tmp/cmb-1017W-{before-tests,core-tests-final,node-notice,lint-final,build-final,original-baseline}.log。
  - [x] ~~1017X 欢迎期间首条用户消息的命令来源。复核原Host.injectIntoRun／Store.injected_into后确认：物理轮次仍为introduction，实际用户请求另有已消费的稳定任务ID；若命令仅保存物理欢迎ID，完成后会再次失去用户来源。沿用原“已消费、同Bot／thread、运行中”的查询，提取已确认注入的用户任务ID作命令来源；未消费的排队消息、欢迎自身或外来来源不授予资料修改权限。先以真实SQLite正反例证明，再运行当前DeepSeek正式界面；不改变Runtime补充消息、队列、取消或欢迎触发规则。实屏未实际命中欢迎注入的时序则明确记录，不用普通用户轮次代验。~~
    - 实现仅复用原已消费用户查询并返回稳定ID，hasDirectUserRequest保持原布尔语义；命令只在物理introduction中取已消费用户，其余直接用户／群／已绑定命令路径不变，无新表／索引／队列。SQLite同题先1失败／22通过，修正后92项相邻及433项52文件全Bots相关回归、node类型、lint、正常构建通过。实屏X1命中欢迎注入并完成前台45秒命令和自身改名，追加问题到达偏晚，不能计后台移交；X2明确后台执行后命令ff825e02…的source_task_id实为已消费用户26577aa2…、不是欢迎af03c60a…。父与用户轮次先completed，约45秒后唯一通知5c30497f…只调用一次bot_update_profile，最终名称“欢迎后台完成-1017X2-DS”、职责／模型／头像不变，无SQL／文件／同事操作。保留两位合成Bot，原28Bot、全部群／例行、470旧任务及178份跟踪文件不变；478任务、零活跃、quick_check=ok。首次创建的非ASCII幂等键被schema拒绝后才成功，未重复创建；X2创建提示明确给ASCII键，不能计无提示创建首轮质量。英文进度、首轮时序失误及重叠物理／用户捕获需按callId去重均保留；MiniMax／Windows及本轮新进程重启未验，不扩大结论。证据quality-review/1017X-welcome-command-source/{before,created,first-message-started,first-message-ownership,supplemented,second-created,second-ownership,second-completed,final-storage,review}.json；/tmp/cmb-1017X-{before,tests,core,node,lint,build}.log。




- [ ] 1015AG 重复审批体验（用户最新要求：先放下，继续一期目标）。已核实原 ApprovalStore 的会话许可按文件及操作缓存，不能靠改按钮文字解决。尚未修改审批、Runtime 或文件工具实现。后续如恢复此项，应复用现有能力并明确 Bot 工作目录边界、链接及 Hooks 改写、只读／Mod 限制，保持原工作台默认；不能用全局 YOLO 代替有边界的设计，也不新增审批框架。本项暂不阻断既定核心功能、UI／动画及交付验证。参考 [Grok 官方审批说明](https://docs.x.ai/grok-bot/approvals-security-and-privacy)。

- [ ] P03.1 接入 startAgentRun、托管消息投递、终态与取消，保持原编程、文件、模型和压缩能力。
  - [x] ~~1018CO 问题卡等待时的直接新消息。~~同题实屏：官方0.71.2忽略普通二选一卡后回答43；本地MiniMax／DeepSeek修复前均waiting_user且追加消息queued，人工跳过只作清理。复用原getPendingUserInputForThread／submitUserInputResponse的空answers＋ignored回执，仅在Bot直接用户消息被原steer队列接收、尚未注入且仍拥有精确物理轮次时跳过旧问题；接收失败、租约换代、已注入新问题、群／同事／例行／后台来源均保持原逻辑。只新增适配层17行，无公共Runtime／审批／问题系统／计时器改动。先3失败／58通过，修复后61项适配及141项相邻回归、原输入／租约／队列41项、消息回归、node、lint、格式和正常构建通过。正常退出重启后MM dc3827ff…／e762ede3…、DS 9037bb83…／311b0391…均自动跳过并回复43，无人工跳过或代选；另两条实际点击简版，原回执submitted且回复CHOICE=简版。54项审计通过，867→877任务、零活跃，38Bot／10群／9例行／29命令／267文件及旧消息保持，受保护39字草稿未变并恢复BW-DS与官方原视图。证据quality-review/1018CO-question-steering/{both-follow-pending-before,manual-cleanup-task-windows,task-windows,final,review}.json及实屏／红绿日志；只确认此Mac问题卡流程，P03整体与Windows仍不勾选。
  - [ ] 1018BY 自身资料修改的失败回执：已复用同文件已有error ToolMessage模式捕获Host拒绝，成功changes／权限／取消／Store和公共Runtime保持。152项工具／Host／适配／资料事件回归、node、lint、格式与正常构建通过；实际LangChain工具＋真实Host／SQLite集成验证U+0000拒绝、不改定义、同值无变更和终态任务不可改资料。
    - 双模型负向实测尚未命中：MiniMax实际传BY_MM_1018，DeepSeek实际传带换行的BY_DS名称，均不含U+0000，不能据其成功回执判断非法字符被接受。各自恢复原名，反馈后各一次同值工具调用正确返回changes=false并纠正结论；这是辅助纠偏后的结果，不能替代首次负向验收。期间自动总结误存临时结论，转P04的1018CA处理并保留原件。证据quality-review/1018BY-own-profile-error/{before-models,task-windows,final,source-built,initial-model-review,new-files}.json，原模型输入／实际参数与失败记录不覆盖；不把文件不变断言失败改成验收通过。
  - [x] ~~1017BK 等待主模型时收到直接用户消息，并保持后台命令与原上下文。~~源码核对：Grok send-turn-dispatch中断旧用户轮次并在独占队列续接；Hermes redirect仅在模型请求时取消该请求，工具期间steer／yield。原CMB队列仅beforeModel／afterModel消费；本次沿原模型调用包装增加可选的主模型活动观察，Bot按精确物理轮次取得取消入口。同私聊真实用户消息先持久入队，模型活动且没有交互等待时结束旧轮次并标superseded，完成原清理／checkpoint后由原Host执行新消息。工具、审批、子Agent、群、例行和后台通知不走此入口，普通工作台不配置观察；不复制执行器、不取消已接受的后台命令。回归覆盖连续消息、未消费队列、停止、失败和权限边界，真实Mac双模型及原工作台验证见下。此叶仅确认该接续场景，不代替全部P03、Windows或当前受试用限制的官方同题实测。
    - 初版真实Mac双模型已验证主模型等待可结束：DeepSeek be7cdb1c…／MiniMax bd60aefe…收到新消息7ms后原任务进入interrupted，尚未调用工具；新任务7e6cbc2d…／2163e9d9…各write／read／deliver，回答77并保留原消息中的文件名和不同合成事实。原任务到补充消息间隔分别1214／1257ms；7ms仅是控制库接受补充至旧任务终态，不是模型答复延迟。前三次DS轮次因界面流式读取延迟错过补充，5条已正常结束的任务不计中断通过；改为连续原生输入后命中，无私有UI协议或新增等待框架。官方当前提示试用／无法刷新，仅核对源码与既有界面，不称官方同题已测。
    - 交付质量单列：两模型初稿正文均不足150字，MM修订又虚构根因／复测通过／审批门槛。保留原件及每轮回执，按缺口反馈模型修订，验收人员未改写工作区报告；DS一次反馈后正文211字符／181汉字，MM四轮反馈并用只读Node实际计数后237字符／194汉字，保留原事实、三段与暂缓结论，未知证据和建议已区分。MM首次Node命令引号错误实际exit1，后续恢复；DS一次已结束样本重复交付3次及长文不足却自称满足的质量问题保留，不计首轮质量达标。初次计数包含列表符号，后按Markdown口径剔除；验证脚本也修正了原write_file成功回执没有status字段的错误假设。不据此改变公共harness或宣称整体交付不低于Grok。
    - 初版14任务后为674任务／0活跃，原660任务、36Bot、10群、9例行、21命令、228文件和3936旧消息头逐项保持，仅新增5份合成报告；当前主应用5546、无浏览器宿主。证据quality-review/1017BK-model-supersede/{before,ds-first-timing-miss,ds-before-correction,ds-third-timing,ds-fourth-burst,models-before-quality-fix,first-file-review,first-build-final-models,before-status-upgrade,first-build-final-files,first-build-review}.json、first-files/、first-build-final-files/和review-first-build.py。这里的interrupted是初版实测状态，不冒充下述新版superseded已验。
    - 源码复核补正：既有commandProfileSource仅认可completed原请求，故不能把用户补充接续当作故障interrupted。新增明确终态superseded及同一处共享／界面文案，继续使用原tasks表和通用终态清理，不加schema、执行器、队列或通知体系。仅私聊真实user的canonical命令回执可沿superseded源请求继续原授权；group／peer／routine不能获得该权限，取消／崩溃／结果未知和显式stop的suppressed规则维持。主模型观察不传入压缩、子Agent或普通工作台；交互等待计数未归零时保留原steer，避免取消审批或接管。补充消息仍先保存、旧清理和租约释放后才新运行，未消费消息不提前改为运行。
    - 初版红灯2失败／49通过（更早还有一条群fixture身份设置错误，已独立修正），首批63和140回归通过；首次node暴露Lease结果类型未支持接续、首次web暴露界面终态文案缺失，均已修正。52文件480项Bots／共享／前端派生及模型活动回归、node／web类型和正常构建通过；workflow、原队列41项与接线52项已通过。用户本轮明确要求后已提交并push 7e08e47a0；本段后续验收记录不自动提交。
    - 最新版真实双模型通过：纯聊天DS 19a113ab…／MM b3b7cce5…进入superseded，新消息各自回答77、0工具。后台MM原任务0a8dcd9b…与DS 100db140…均已启动一次180秒Node命令，经真实选择卡恢复模型再发送补充；新消息接受后8／6ms结束旧轮次，仅指控制终态延迟。原PID66009／67512持续至正常退出；三个字段与单次启动日志一致，没有取消、重启或轮询。各仅一个canonical完成通知3557be46…／8ad503d0…，依次read_file、以原名bot_update_profile、bot_deliver_files，各一次、0工具错误；原授权延续且全部36份Bot定义逐字段不变。首个DS后台样本在补充前已完成，只作为completed源对照，不充当superseded通过；按用户消息划分历史会误归内部通知，独立复核改用实际任务时间窗与调用ID。
    - 正常Quit旧主进程53417及全部所属进程后同配置重启，689任务／36Bot／10群／9例行／24命令／239跟踪文件及4167消息头保留；冷启动前快照采集后，新DS原线程仅updated_at又完成一次刷新，其余头字段及全部消息头一致。两份JSON重启后均实屏打开、字段一致。最终0活动任务／0已接受命令，合成Node进程均退出、无浏览器宿主；原mask 39字符草稿逐字相同。原680任务、21命令、233文件、4106消息头均保持，访问过的四条旧线程仅更新时间变化。启动BV仍需原生Zoom刷新，未宣称解决；同名资料调用仍显示“已重命名”，留给Bot展示层复核。证据同目录review-current.py／review-current.json、status-models／background-completion／latest-before-restart／latest-after-restart／current-final及对应process快照。

- [x] ~~P03.2 接通附加工具、等待用户和审批；补充消息的实际处理与 UI 状态一致。~~
  - [x] ~~真实命令单次审批、执行中追加待办、串行完成及后续任务读取前轮输出。~~（1013J/J2，QUEUE_TEST_READY、42）
  - [x] ~~审批期间停止同时取消活动任务及待办；新任务能继续。~~（1013H/H2/I）
    - 1014U/U2/U3 复验新的收件箱停止接口：真实 MiniMax 任务 `b47e971e-4ff4-4337-8f3e-2be7395a4a32` 等待写入审批，追加任务 `fc1d496b-74f6-4b72-b694-bb19f9e09581` 已进入待办。点击停止后两者均 cancelled，未审批的 `stop-receipt-1014U.txt` 不存在；新任务 `04296c96-3c0f-4184-9157-1401835f4c0b` completed，正式界面回复 STOP_RESUMED。停止范围由原 Host／Store 读取私聊收件箱，沿用原取消和清理；群任务不被私聊停止波及。前端停止期间正在核对回执的重试不继续派发；真实 SQLite、Host、IPC 和延迟回执场景有针对性回归。此项不代替全部工作流／worker 或 Windows 取消验收。
  - [x] ~~运行中停止终止实际命令进程，任务最终为 cancelled。~~（1013K，Mac 原生 Node 前台命令）
  - [x] ~~原 request_user_input 产生真实选择卡片，选择后恢复同一任务并按所选方式交付。~~（1013N，选择“只给合计”，最终 50.75）跨平台及重启中的审批另由 P10／P11 验收。
- [ ] P03.3 明确后台通知所有者，验证工作流和 worker 在父轮结束后仍可回传且只汇总一次。
  - [x] ~~1018BX Bot后台运行时的无操作自动提交提示。~~BV真实界面出现包含workflow／worker术语的skipped toast；原Runtime在后台占用工作区时发送该信息，原thread-context按skipped弹提示。只在Bot已有托管投递的mirror接线过滤精确的status＋单一reasons无操作回执；实际提交、失败、审批、警告、推送信息、其他跳过原因及未知字段全部原样传递。不改共享投递、Runtime自动提交逻辑、普通工作台／IM或新增状态／监听器。
    - 回归先1失败／52通过，修正后相关58项、原managed-transport-delivery与messages回归、node／web类型、局部lint及构建通过。实际MiniMax 06bbd839…／DeepSeek 555e0355…各启动一次、各一名真实子执行者、一次前台20秒Node命令；父轮先结束，完成后唯一通知c377df77…／3b993c56…回到各自原会话，nonce和BX_MM_DONE／BX_DS_DONE均与真实原件及工具输出一致。两份58B原始JSON附件实屏打开。DeepSeek后台活动界面未见原跳过提交toast；未捕获每一瞬时事件，精确过滤及重要负例由注入原投递接线的测试验证。MiniMax仍披露内部runId，不据本项消除交付文案差距。
    - 原761任务、38Bot、10群、9例行、26命令、247文件及4521旧消息头保持；最终765任务／4539消息头、0活跃，两库quick_check=ok。四个线程仅updated_at前进，首次严格时间戳相等检查失败及差异保留，其他身份字段不变。mask39字草稿、80px侧栏、收起详情与3000×1800窗口恢复；原生画面／AX延迟通过已有Zoom刷新核对，发送前校验避免重复。共享投递、镜像、自动提交生产者、thread-context及格式化源码SHA保持；本轮正确记录index.js与application.js前后哈希，运行块已重建。47项证据检查，目录quality-review/1018BX-bot-commit-notice。Windows、整体UI／动画及完整P03／P12仍未验收；未commit／push。
  - [ ] 1018BW 原异步worker的Bot兼容性续验。复核原coordinator模式、worker管理、通知claim／ack、Bot租约与停止恢复；仅在隔离预览新建两位合成Bot，用原有消息前缀进入原worker链路，不给产品新增模式选择器、不改旧Bot配置或数据库。以MiniMax／DeepSeek检查父轮结束后实际worker回传及唯一汇总、停止传播和正常重启不重放；权限／工具回执及实际模型分别核对，不由工作流或同步task样本代替。发现问题再做最小接线修正；原BV／BT质量差距及Windows边界继续保留。
    - 当前未通过：新Bot已由默认MiniMax完成问候，随后正式绑定MM／DS。DS的[coordinator]兼容前缀在11ms内被原非空会话模式保护拦住，未请求模型／调用工具，控制任务b5d906b8…为outcome_unknown、缺少精确前置失败回执。两位Bot仍是normal，未改原模式保护、未用数据库／环境开关绕过，也未新增产品模式入口。后续普通DS请求0bcd7fbf…仅read_file，准确核对合成CSV为3行／19.60CNY。此失败及worker真实恢复覆盖仍保持待验；默认后台停止证据单列P03.4，不替代worker。
  - [x] ~~1018BV 后台启动回执的默认展示。~~真实BT历史中成功workflow仍显示原始工具行，而Bot已有独立后台状态和执行过程入口。仅在既有Bot投影识别原workflow/tool.ts无警告launched回执并收起；未知／警告／拒绝保留，异常可检查，未返回调用不收起。原消息正文、Mod卡、审批、Runtime、通知和普通工作台保持。新增回归先1失败／40通过，修正后相关76项、原messages、web类型、局部lint及构建通过；已核对的out/main/index.js引导产物与本轮前相同，未单独记录application.js完整运行块的前哈希。
    - Mac真实MiniMax d7a037ac…、DeepSeek 39145e3e…各只启动一次后台运行，父轮先结束；真实命令各执行一次并成功，完成后各产生唯一通知1bd2ed8a…／22731280…，只read_file＋bot_deliver_files，112B／116B摘要四字段与原件完全一致，两个成果均实际打开。默认聊天不再出现旧／新成功workflow卡，执行过程开关仍能展开真实launched／runId；运行和结束状态可见。MiniMax实际拆成两个agent，违反一个agent约束，DeepSeek为一个；该质量缺口和BT此前错误仍保留，不宣称完整质量对齐。
    - 原749任务、36Bot、10群、9例行、26命令、240旧文件和4481旧消息头保持，最终753任务／242文件／4499消息头、0活跃，quick_check=ok；mask39字草稿、80px侧栏、3000×1800窗口与收起详情恢复。63项证据检查通过。启动仍需原生Zoom，未改生产启动；中途还看到继承的自动提交“跳过”提示暴露workflow／worker术语，另留UI差异。警告／审批故障注入、官方新同题、Windows及P03父项未由本项关闭。证据quality-review/1018BV-background-launch-view/{before,built-source,task-windows,workflow-evidence,file-review,model-routes,restored-ui,final,review}.json、原toolstream／journal、review.py及实屏截图；未commit／push。
  - [x] ~~1018BT 本机后台执行、自动回传、作用域与成果入口对账，首轮质量差异单列P12。~~复核原CMB工作流子执行、pending通知领取／确认及Bot持久队列；对照Grok host/extensions/transcript的BackgroundWakes／CompletionRevivals稳定父身份、待唤醒去重与有意义结果回传，Hermes delegate_tool_dispatch的detached结果路由和无异步能力时显式同步退回。保留原执行／通知体系；Grok packages中的background-completion-dispatch是空恢复模块，不把它当作完整实现依据。本轮生产源码及正常构建SHA不变。
    - 真实DeepSeek工作流wf_57f008292efd启动一个实际agent；MiniMax首轮wf_ba430efa4a51违背单agent要求，顺序启动三个，后续wf_ecf273ab9869实际只启动一个。每轮均有真实15秒Node命令、连接器调用及共享浏览器范围拒绝，合计三个br_total服务回执均为9.33 CNY，没有scope探针实际调用；首轮MM浏览器子任务还额外inspect了两个无关工具定义，未隐藏该偏差。原toolstream的执行／调用ID和回执逐项匹配，未只用父模型复述作证据。三个父轮各仅调用一次workflow并在后台完成前结束；各自唯一通知任务1ab905d2…／c82e2a63…／7a2eeb35…自动进入原Bot，仅read_file核对和bot_deliver_files交付，原notificationOwner=desktop、notificationDelivered=true，未人为发送继续指令触发通知。
    - 原生打开DeepSeek首轮JSON与MiniMax最终修订JSON，均显示八个实际字段。MM修订任务07c41404…／6777737c…只读原文件及对应已完成执行记录、写新文件、重新读取并交付；未重跑命令／连接器／子任务，原错误文件全部保留。源工具回执直接推导字段真值，独立结果为DS首轮8/8、MM首轮6/8、单agent新轮7/8，两份MM修订均8/8；这不是MM首轮交付质量通过，详细差异见P12续记。
    - 正常Quit原99877及全部四个所属进程后，同配置重启；747任务、240文件及4469核心消息头逐项相同，三个通知仍各一条且已确认，无新回传、无重复成果。相对本轮开始，原739任务、36Bot、10群、9例行、26命令、235旧文件及4420旧核心消息头保持，新增八个completed任务及五份JSON、0活动、quick_check=ok。未对全部旧消息正文做逐字快照，不把消息头证据扩大为全正文证明；旧线程仅允许updated_at变化。合成连接器禁用并恢复BR参数，服务30072正常退出；原mask39字符草稿、80px栏、详情收起与3000×1800窗口恢复。
    - 初版next-user切分验收器会将无user锚点的通知工具混入发起轮，已沿BN按任务created／updated时间窗重建归属，旧采样保留，不据此误判父轮等待。证据quality-review/1018BT-background-delivery/{before,source-before,references,task-windows-before-restart,task-windows,workflow-evidence-before-restart,workflow-evidence,quality-review,routing-evidence,ui-observations,before-restart,after-restart,final,review}.json、原／修订交付快照、实际toolstream／journal及三个验收py；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018BT-background-delivery.tar.gz。此项仅为Mac后台工作流，不替代worker、真实模型故障切换、Windows或当前官方Grok同题；BV仍需原生Zoom，未加生产启动兜底。P03.3父项保持待验，未commit／push。
  - [x] ~~后台工作流实际创建两个模型子任务，子任务审批回到父会话，完成后自动续办、复测并交付文件。~~（1014E）工作流 `wf_c8b31c581b15` 的两个独立 MiniMax 子任务分别创建实现与测试；父任务 `b4dc2157-ef19-4e20-8e2c-ef4626d2c666` 结束后，唯一工作流通知任务 `3102b8f9-20dd-421b-a8a6-6ba12a82bfef` 自动进入原 Bot 线程，实际再次执行 `node --test`，11/11 通过并交付两份附件。该脚本使用顺序 await，模型“并行”表述不准确；未以此验证并行或故障／取消链路。独立边界验收仍发现质量差异，见下文。
  - [x] ~~默认 Bot 直接交办任务可调用原工作流引擎；无执行模式切换，父轮结束后自动回传报告。~~（1013W，真实 MiniMax／Grok 同题合计均为 52.75；本次 MiniMax 为脚本并行计算，不能代替实际子 Agent 作用域验收。）
- [ ] P03.4 验证子 Agent、工作流、worker、故障切换的作用域、取消和工具限制继承。
  - [x] ~~1018BW 默认Bot父轮结束后的主输入框停止及正常重启。~~真实MM 131a290d…／DS d2fc6467…各仅启动一次workflow、一个实际子Agent、一次前台90秒Node；父轮先completed，子进程真实PID55176／56066仍在运行时点击Bot主输入框“停止”。两个运行均aborted、原通知被标记已处理且0通知续跑；停止后分别在原截止前30.3／43.0秒检查PID已退出，跨过90秒截止后最终文件仍不存在。MM的停止前PID存活由本轮工具输出记录，DS另有独立before-stop快照；中止的子流没有最终ToolMessage，不虚构SIGTERM回执。
    - 停止后MM 0b3e6aee…／DS bfd8d5ca…各仅read_file读取实际启动JSON，正确回复原nonce，没有重开命令。原生Quit返回观测超时，随后四个所属PID全退出且原进程handle终止才重启；761任务／247文件／4521消息头重启前后逐项相同，两个运行仍aborted，界面空闲、原结果和mask39字草稿保留。原753任务、36Bot、10群、9例行、26命令、242旧文件与4499旧消息头保持；仅新增两位合成Bot、8任务、2启动JSON／1CSV附件及2份原Runtime工作区setup元数据，0活跃，两库quick_check=ok。相关58项既有测试、61项证据检查通过，本轮未修改生产源码；已核对的out/main/index.js引导产物未改，未单独记录application.js完整运行块的前哈希。
    - 只证明Mac每子任务一个前台Node，不代表任意逃逸进程树、独立worker或Windows；MM可见回复泄漏runId、DS提到workflow等表达差距继续保留。新建入口与系统文件选择器的初次观测／粘贴延迟已按真实状态重查，原生Zoom仍为既有观测限制；未以此改产品启动。证据quality-review/1018BW-worker-lifecycle/{before,actors,task-windows,workflow-evidence,mm-immediate-stop-check,ds-before-stop,ds-immediate-stop-check,post-deadline,before-restart,final,model-routes,restored-ui,review}.json、原toolstream及review.py；未commit／push。
  - [x] ~~1018BS 实际 task 子 Agent 的连接器范围、父轮交付及停止传播。~~先核对原 Runtime 的 subagentDefaultTools、工作流／worker 的 scoped capability 传递；对照Grok 0.18恢复源码subagent.ts的父会话／toolCall身份与去重回执，以及Hermes delegate_tool_toolsets的父工具交集、child_run的取消传播，保留原执行器，不增生产机制。真实MiniMax 552630ba…／DeepSeek 850ad8b0…的父轮各只调用一次task；原持久化子会话各有一个稳定调用身份、六次真实桥调用，Blob按kind／bytes／SHA核对。子Agent得到实际9.33 CNY及同一服务PID16888；共享浏览器探针发现为空、inspect与已知ID调用均拒绝，服务无对应scope nonce。MiniMax将两路发现／检查／调用分别成对并行，DeepSeek顺序执行；不称两者都逐句串行。
    - 另两轮 d37a753c…／7ccf8e0a… 的父轮各只调用一次task，子Agent各只执行一次前台Node命令，真实启动PID19731／21101并写入合成开始记录。点击各父会话停止后，两任务cancelled；采样确认在原90秒期限前PID消失，期限后仍无完成文件。随后MiniMax 8c140e1c…／DeepSeek fb61feb1…只经原search→inspect→invoke完成新任务，返回9.33 CNY及相同连接池PID；没有恢复旧task／命令，DS原生卡片显示已中断，输入恢复空闲。此项仅证明本机单个前台Node子执行，不宣称任意逃逸子进程或Windows已验证。
    - 原733任务、36Bot、10群、9例行、26命令、233旧文件及4390旧核心消息头保持，新增六任务（四completed／两cancelled）及两份开始标记，最终739任务／235文件／0活动、quick_check=ok；旧线程仅允许updated_at变化。原Bot适配／MCP范围／Runtime／工作流子执行源码及正常构建SHA不变，无新生产代码。本轮复用的合成连接器已禁用并恢复BR参数，服务16888正常退出；原mask39字符草稿、80px栏、详情收起和3000×1800窗口恢复。证据quality-review/1018BS-subagent-scope/{before,source-before,references,task-models-final,task-models-final-children,mm-before-stop,mm-after-stop,ds-before-stop,ds-after-stop,post-deadline,models-final,models-final-children,routing-evidence,ui-observations,final,review}.json、invocations.jsonl及capture_children.py／review.py；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018BS-subagent-scope.tar.gz。工作流／worker及真实故障切换仍待验，本轮没有新的官方Grok同题或Windows结论，P03.4父项保持待验。未commit／push。
  - [x] ~~父轮结束后，从工作流卡片取消实际运行中的模型子任务，终止其前台命令且不触发完成通知续跑。~~（1014G2）真实 MiniMax 工作流 `wf_c3f6a9d1e868` 的父任务已 completed，子任务实际启动本机 Node 定时进程 PID 60113；点击“取消”后日志出现 Cancel requested，命令在 15.275 秒以 SIGTERM／abort 结束，工作流状态为 aborted，界面显示“已中止”。独立检查 PID 不存在、90 秒到期标记文件不存在；不是只取消队列或模拟命令。初次 1014G 是子任务结束时自动清理后台命令，模型误称用户已取消，该轮不计通过。G2 首次脚本混用 .mjs 与 require，模型自行修正后才进入实际取消验证；不隐去首次错误。worker、故障切换和 Windows 实机仍待验收。
  - [x] ~~默认 Bot 同轮派发两个实际 task 子 Agent，沿用原工作区和父会话审批，父轮测试后交付代码与测试文件。~~（1013X，独立 Node 验证 4/4；未覆盖工作流 leaf／MCP 限制、故障切换和实际并行时间，交付质量差异见续记。）
- [ ] P03.5 验证连接器发现、直接／延迟调用与 fallback 都执行范围检查，不绕回旧共享浏览器。
  - [x] ~~1018CB 本机真实MCP fallback及普通工作台回归。~~复用原Runtime的插件safeToRetry、工具名／schema匹配与Bot调用前范围校验；沿用BR合成stdio服务，通过正式插件安装／连接器设置接入仅回环HTTP主服务。真实发现正常、tools/call实际503。首轮两模型误选全局工具，准确插件ID重放后才复现主服务各一次503却无fallback；这两组失败均保留，不记为通过。
    - 确认存量SDK适配缺口：StreamableHTTPError将HTTP状态放在数值code，原分类器只读status／statusCode，CB_HTTP_503也不匹配原正则。仅补该SDK类型的502／503／504识别，生产变更为一条import和原状态分支；不把任意业务code=503当传输错误，不改变fallback授权、scope、审批或重试次数。真实SDK502／503／504红测先失败、最小修正后原spec转绿；401／403／400及普通业务数字code反例保持拒绝。Bot范围／eager错误／重试6项、完整原test:workflow、node类型检查和正常构建通过。测试文件格式／lint通过；runtime原有20条格式warning与修正前规则／消息完全相同，没有为此重排大文件。
    - 最终同题：MiniMax df57d55b…、DeepSeek 99602614…各一次mcp__cbSafePrimary__br_total；主服务真实503各一次，允许的BR备用服务各一次，回执及模型均明确fallback来源，合计9.33 CNY。UNSAFE两轮各一次503、零备用调用；BUSINESS两轮各一次isError业务错误、零备用调用，原ToolMessage错误标记保持。共享目标探针未出现在Bot搜索结果，准确ID的inspect均Tool not found，探针无任何Bot nonce调用；直接invoke拒绝另由既有真实包装器组合spec覆盖，不冒充本轮实屏已发出被拒绝业务调用。首次scope验收ID大小写写错，SCOPE2已更正，原记录保留。
    - 原工作台两模型实际调用同一共享合成服务，各只产生一次真实服务调用且返回9.33 CNY／PID74701；MiniMax先误用延迟桥，被原接口拒绝后才直接调用，保留为交付质量差异，不据此宣称首轮完全遵循约束。Bot实际fallback进入PID74700的文档来源，未误调该共享探针。
    - 原789任务、38Bot全部定义（含用户确认保留的红色flower）、10群、9例行、26命令、249工作区／记忆文件及4623旧核心消息头保持；最终803任务／4701消息头、0活动，两库quick_check=ok。两次正常Quit的全部所属进程退出；最终同配置重启前后任务／消息头逐项相同，无重放。正式界面禁用合成插件及两连接器，BR原参数保持；全部合成服务有退出记录且PID不存在，BR旧日志前缀SHA保持。mask39字草稿、80px侧栏和关闭设置恢复。53项证据检查通过，证据quality-review/1018CB-mcp-fallback/{actual-sdk-error,task-windows,original-workbench,primary,br-new-invocations,shared-probe,model-routes,settings-restored,final,review}.json及原jsonl／review.py；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018CB-mcp-fallback.tar.gz。此项仅覆盖本机实际503及上述反例，不替代task／workflow／worker完整链路、模型故障切换、Windows或新官方Grok同题，P03.5父项保持未勾选；未commit／push。
  - [x] ~~1018BR 本机真实 MCP 连接器的私聊／群聊直接与延迟调用、失败回执和范围隔离。~~复核原 CMB capability-service 共享连接池、langchain-tool 的 eager 错误标记、tool-search-tool 的 search／inspect／invoke_deferred_tool 原协议，沿用 Bot 范围包装器，没有新增执行引擎或改动 Runtime／连接器权限。通过原设置界面注册仅返回合成数据的本地 stdio 服务；MiniMax／DeepSeek 各自完成直接调用、延迟 search→inspect→invoke 调用，以及两种调用方式的预设错误，均各调用一次实际服务并如实报告。既有两成员群中，两模型也各完成一次延迟调用，合计均为9.33 CNY。
    - 两模型私聊搜索共享浏览器探针均为空，inspect 和已知 ID 的实际 invoke 均返回 Tool not found；服务端没有对应 Bot nonce 调用。原工作台 MiniMax 线程使用相同桥与服务成功返回无真实浏览器访问的标记，原三个工具卡片仍可见；不是全局禁用连接器。实际 fallback、task／workflow／worker 子链、远程 HTTP 服务和 Windows 尚未在本轮实跑，父项保持待验，既有 fallback 组合测试另列下方。
    - 暴露并修正 Bot 默认视图仍显示成功 MCP 原始工具卡片，以及延迟工具消息 status=success 但正文 ok=false 时可能被当作成功的问题；详见 P09.4 的 BR 记录。原719任务、36 Bot、10群、9例行、26命令及233份跟踪文件保持，最终733任务／0活动，旧核心消息头保持；普通工作台新增一条明确的合成回归请求，不声称整个会话数据库不变。测试连接器已禁用，四次服务进程均有退出回执且没有存活；原mask39字符草稿、深色、80px栏、3000×1800窗口恢复。证据 quality-review/1018BR-mcp-core/{before,built-source,eager-models,new-eager-models,eager-errors,lazy-models-final,lazy-errors-final,scope-models,group-models,original-workbench-model,after-models,final,review}.json、invocations.jsonl及review.py；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018BR-mcp-core.tar.gz。未commit／push。
  - [x] ~~将 Bot MCP 范围包装器与原 Runtime 的 scoped capability／fallback 实际组合验证：发现与直接调用拒绝共享浏览器，fallback 仅进入允许的文档连接器，缓存后目标变为浏览器也在实际调用前被拒绝。~~ `tests/mcp-fallback.spec.ts` 通过；未新增连接器引擎，原通用 fallback 测试同时通过。真实连接器服务、task／workflow／worker 的完整场景继续验收。
- [x] ~~P03.6 补齐 Bot 身份、消息来源和本地环境说明，并以真实模型验证不扩大权限、不误拒绝群内用户请求或既有例行授权。~~
  - 验收依据：原Runtime的extraSystemPrompt与原Host／Store保持唯一执行／权限入口，完整prompt／adapter59项覆盖创建引导、私聊用户、群用户、Bot、例行和通知来源，确认实际本地环境、私有记忆不进入群及非用户内容不能扩大权限；Host等58项定向回归覆盖实际群消息／成员、同事范围、非用户拒绝与原值不写入。真实私聊资料变更／原值确认见BL；正常canonical后台授权延续见BK，未知回执不扩权见BN；双模型已保存例行授权见BT3，当前两条completed例行原记录仍在且复核原review；真实群用户与身份／本地说明见下BO。此项验收是身份、来源、环境与权限接线，不代替P03.3／P03.4全部子执行链、P12交付质量或Windows实机。
  - [x] ~~1017BO 群内真实用户资料请求与当前身份／环境验证。~~先核实群分支已有资料工具，未因旧历史拒绝增加权限／提示词。Grok AgentLifecycle.updateAgent复用统一资料写入／更新回执；Hermes profile_identity需处理名称派生身份迁移，当前CMB使用稳定ID，不照搬其目录迁移。真实用户群消息fd048b11…恰好选择原两成员；MiniMax93f70346…／DeepSeek398a8bf7…各一次bot_update_profile，参数仅为自己的当前名称，回执changes.name与instructions均false、零工具错误。群消息来源／thread元数据／共享工作目录／memoryEnabled=false逐项核对，两者明确报告本机运行、没有身份串用或其他工具／委派。
    - 原703任务、36Bot及全部版本、10群、9例行、26命令、243工作区／记忆文件和4250旧消息头保持，新增2任务／8消息头，群内仅1条用户消息与2条各自回复，0活动／0已接受命令、quick_check=ok。旧群控制消息未在执行前单独快照，不宣称其全量字节比对；原核心消息头有独立前后证据。群草稿为空，原mask39字符草稿、80px头像栏、会话和窗口恢复。
    - 完整prompt／adapter59项通过；来源／群成员／资料边界58项通过（78项按名称过滤跳过，不称136项全跑）。MiniMax未遵守“一句话”要求而给出三条列表，保留为P12格式／交付差异，不抹去或改为整体质量通过。CUA的AX与截图一度不一致、原生Raise未解决，输入校验在发送前拦住；Zoom后确认唯一完整草稿才发送，无重复任务，未改生产代码兜底。验收器最初误期待own-profile回执含id，已按真实name／instructions／changes契约及Host任务绑定修正。证据quality-review/1017BO-group-user-profile/{before,models,after,group-rows,routine-evidence,review}.json及review.py，日志/tmp/cmb-1017BO-*；生产源码和构建与BM相同，未commit／push。无新的官方Grok模型／Windows验收声明。
  - 已通过原 Runtime 的 `extraSystemPrompt` 接入 `bots/prompt.ts`，五类来源的正反契约断言通过；未引入 Grok SendMessage／云端 Linux 假设。静默投递已按 P06.2 复用执行链并增加可见性与通知投影，继续保留原完成校验；群内用户交办按真实用户请求处理。
  - 1014Q 首次交付暴露“自测通过但原需求漏验”，且最终回复堆叠未被独立证据支持的功能勾选表。对照 Grok `system-prompt.ts` 的简洁表达规则，在 Bot 附加提示层明确按用户要求控制深度，并按实际文件逐项核对验收条件、直接验证标准调用入口、区分实现缺陷与测试期望错误；不修改原 Agent 提示词或执行链。五类来源正反断言及 27 项 Runtime 适配测试、node 类型检查通过；更新包后的真实行为效果仍待核验，不据提示文本存在宣称质量问题已解决。

### P04 — 记忆

本节不仅验收存储接口，也验收 Bot 是否在后续工作中正确使用记忆。下方 P04.1—P04.3 的代码与定向测试通过，不代表真实模型行为已全部通过；用户没有再次提到的记忆要求继续保留，不能被 UI 收尾替代。

- [x] ~~1016O 打开的记忆面板随实际写入更新。~~已在原应用复现：DeepSeek 任务 `b4f09006-3c00-49d8-8c51-158315e03022` completed，私有目录已保存“合成金额排版-1016O”，持续打开的面板仍显示“还没有保存记忆”。原 CmbCowork 通过 memory:changed 通知面板；Bot 当前绕过该通知。沿用已有 bots:changed／BotClient.subscribe 增加仅含 Bot ID 的记忆失效提示，覆盖显式写入、编辑、删除、分享副本和总结实际落盘，不广播正文、不增加轮询／新 IPC 或数据库；面板合并读取请求，保留正在编辑的草稿和版本保护，并按主机／Bot 重置面板身份。原工作台不变。验证实际聊天修订时面板原位更新、文件版本一致及关闭后的资源清理，再划掉。证据 `quality-review/1016O-memory-refresh/before-fix.json`。

  - 1016O 实测修正：原应用正常 Quit（exit 0）后用同一配置启动；DeepSeek 任务 `44702284-7f01-482e-9ca7-f7faf6f59163` 将原条目改为“四位小数”并读回，持续打开的面板原位显示新值。面板保留未保存“六位”草稿时，任务 `2614ff63-eaf7-4800-8663-2ad62b207146` 实际改为“五位”；旧草稿保存被版本保护拒绝，取消后显示当前“五位”，文件 ID 不变且始终仅一条。21 个 Bot 的 ID／thread／配置及 7 个群完全不变，控制库 quick_check=ok。84 项真实文件／Host／工具／总结适配／退出测试、node／web 类型检查、定向 lint 和构建通过；事件只含所属 Bot ID，useBots 不因记忆事件重新读取整个控制快照。面板保留操作错误与草稿，读取错误可单独重试，取消编辑清除旧操作错误。证据 `quality-review/1016O-memory-refresh/{before-fix,before-restart,after-restart-edit,after-conflict}.json`。自动总结的通知为真实文件测试，此轮实屏是显式工具修订，不能冒充总结模型最终 apply 的实测；冷启动仍遇到需原生缩放才能恢复绘制的现场，未据此认定启动问题已修复。合成条目留在授权隔离配置用于后续验收，未清理未授权条目。

- [x] ~~1017AG MiniMax恢复后补1017B／1017C保存与项目范围的定向验收。~~沿用原失败的MM-SAVE自然请求、原记忆服务／当前私有快照和同一模型配置，在既有BS-MM仅保存鹭桥-MM合成偏好并实际读回；随后不向自然任务提供前缀值，核对适用项目、另一项目、本次显式覆盖及覆盖后的正常沿用。观察同一条目无重复及原其他事实不变，正式面板可见后正常重启再实际读取当前版本。沿用DeepSeek已有对应证据，不用单一模型替代另一模型、不改原Runtime或另造记忆体系，发现行为差异先保留事实再定位；样例保留不删除。 为区分历史对话与私有快照，实际自然任务改在既有AC-MM接收方执行：分享前其可见聊天中项目／前缀出现次数均为0、私有Markdown条目为空；通过原面板只复制这条合成偏好，核对副本、源件与其他事实分别保持，再运行四种范围场景。不在接收方聊天提供偏好值。

  - [x] 1017AG MiniMax保存／分享及四种自然范围场景：原失败请求逐字重跑，12f5f84a…仅list／remember／get各一次，唯一新事实a3c35002…；原面板只分享给既有AC-MM，副本547f4be1…与原件逐字节同SHA b2084fd…，接收方分享前项目／前缀在可见历史均出现0次、原私有Markdown为空。91f7b2cb…／4bd49eab…／ce337d80…／43723aaa…分别正确沿用、跨项目忽略、单次覆盖及覆盖后恢复，四轮均0工具；实际MiniMax-M2.7 agent共8次HTTP200。原514任务、33Bot／群／例行／命令及194文件不变，仅保留两份授权合成事实；519任务无活跃。两个过期电脑工具绑定操作未送达，已先查控制库无对应任务、重新绑定并核对草稿后唯一发送，没有重复派发；未据此改生产代码。正常重启／当前版本读回仍待下一项，证据quality-review/1017AG-minimax-memory-scope/{before,saved-current,before-share-proof,shared-proof,cases-complete,model-responses,before-restart-review}.json。

  - [x] ~~1017AG 正常重启后分别实际读回原件与副本。~~通过原生应用菜单Quit退出主进程16207（exec exit0、原4个进程均消失）后，同配置启动46104；519条任务、33Bot、8群、9例行、21命令、196文件及3222条原核心消息头逐项保持。6a33c1af…／4369a850…各仅一次bot_memory_get，分别读到各自ID、完整正文及相同当前版本b2084fd…，没有查询同事文件、修改／重复保存或其他工具。最终521任务、0活跃，原514任务／全部定义／194旧文件及两份合成事实的SHA保持，两数据库quick_check=ok；本轮MiniMax-M2.7 agent共12次HTTP200。恢复AE群空草稿、80px头像栏及详情关闭。来源private快照／原记忆服务／分享面板均沿用当前实现，未改生产代码。证据同目录{restart-queries,restart-query-verified,restart-comparison,final-storage,review,quit-check,all-model-responses}.json。启动仍经原生Zoom恢复工具可读页面，BV不销项；自动总结的在途／临时任务边界、Windows及整体UI／动画按原项待验。B的历史双模型关闭拒绝与AG的当前MM保存／读回组成显式开关闭环，C的DeepSeek四例与AG的MiniMax四例组成范围定向证据；不扩大为P04.4整体完成。

- [ ] P04.4 真实模型记忆闭环（关联 D06/D09）：仅在已授权的隔离配置中使用合成信息，逐项保留实际输入、存储变化、模型回复和重启证据。
  - [x] ~~1018CC 新记忆审查实现后的总开关复验。~~仅通过隔离预览原设置关闭总开关，MiniMax 6f608bdd…／DeepSeek 1ee97ad9…各一次bot_remember均收到真实error／“长期记忆已在设置中关闭”，没有保存成功的错误表述；随后fa2aabc1…／bdaff81e…各一次get读取原有有效ID，同样被拒绝。恢复原记忆开启／Dream关闭后，6759c1a8…／d323f7f7…各一次get实际读到原岚屿条目、当前三节标题及完整版本，与CA最终版本完全相同，关闭期间被拒绝的新偏好没有补存。
    - 6条实际任务全部completed，均恰好一次工具调用、无绕过；原803任务、38Bot（含用户外观）、10群、9例行、26命令、249文件及4701旧核心消息头保持，最终809任务／4725消息头、0活动，两库quick_check=ok。原草稿39字／80px栏／关闭设置恢复，记忆工具／总结适配器和完整主程序构建SHA均未改；41项证据核对通过。首次切换后设置文件已false但AX标签仍旧，原生Zoom刷新后才显示已禁用，未重复切换或新增产品绘制兜底。证据quality-review/1018CC-memory-switch/{before,disabled-results,disabled-all,task-windows,settings-final-readback,model-routes,final,review}.json；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018CC-memory-switch.tar.gz。此项不代替全部在途竞争、官方完整对照或Windows，P04.4父项保持待验；无生产代码变更、未commit／push。
  - [x] ~~1018CA 自动总结误存临时验收结论的局部修复与复验。~~BY 的 MiniMax纠偏任务后，自动总结新增“Bot profile 名称测试结果记录”，没有显式记忆工具调用；原件已单独备份。参考Grok恢复源码MemorySynthesisService的独立提案审查和Hermes排除临时任务记录的规则，只在Bot总结适配器补写入前验证，沿用原CMB提取器／解析器／路由、单飞合并、30秒总期限和editVersion保护。空／skip提案不增加请求；非空提案只有明确approved=true才提交，异常／格式错误／超时／退出／禁用／归档／人工编辑后均不提交。补清原提取器与Bot UUID文件名的接口约束，未知更新目标整批拒绝，避免部分提交；未修改公共Runtime、原工作台记忆或模型配置。
    - 107项工具／适配／记忆回归通过，含真实原提取器＋临时磁盘的提案／验证分离、正反提交和审查期间六种失效边界、30秒超时释放；node、定向lint、格式和正常构建通过。原P0记忆测试在默认macOS临时目录的符号链接路径拼写断言失败，原测试与解析器均未改；TMPDIR=/private/tmp下七项全过，保留两份日志，不声称默认环境首次全绿。
    - MiniMax与DeepSeek的临时资料纠偏均未改记忆；两模型0前台工具分别自动新增一份岚屿合成项目偏好，最终同题修订也均0前台工具更新同一ID，无重复条目。一次性核算结果／明确不保存的四条实际任务后，文件逐项不变；正常Quit并确认原4进程结束后重启，任务／定义／文件／旧消息头逐项保持，两模型各一次get读到正确标题、范围及完整实际版本。已存长期偏好没有因新审查机制被整体禁用。
    - 首次失败与范围限制保留：MiniMax首次修订误用bot_remember且漏expectedVersion，接口拒绝后仍声称已更新，实际原文件未变；最终原题重放才自动更新，初次后台提案未捕获，不能认定其根因就是文件名或超时。自然报告两模型均沿用新三节，但MiniMax首次把“Mac浏览器检查完成”夸大为平台验证通过，另行纠正后才保留事实边界；不能称首次交付质量已对齐Grok。真实应用本轮未捕获非空提案被审查拒绝的原始回执，负例证明观察窗口没有落盘，拒绝路径由受控模型回执＋真实解析／文件测试覆盖；不把语义模型审查当作绝对保证，P04.4父项仍未完成。
    - 用户明确授权后，仅通过原正式面板删除上述误存合成条目4d6cb52c…，保留备份和删除授权。78e37d94…实际一次get返回error／“记忆不存在”，之后约110秒无重建，再次正常退出／重启后仍不存在。最终789任务、0活跃、249文件，两库quick_check=ok；其余247旧文件与全部771旧任务／4575旧核心消息头保持，只新增两份长期合成偏好并删除获授权的一份旧样例。原mask的39字符草稿、80px头像栏及详情关闭在重启后保持。10:14:54—10:14:57的BW-MM头像颜色／形状变化，用户已确认是主动试头像，按要求保留当前红色flower及正常前进的版本／更新时间；对账仅允许这一明确外观变更，其他37份Bot定义及该Bot其余字段保持，不写成全部定义逐字不变。证据quality-review/1018CA-memory-summary-verification/{failure,references-and-limitations,task-windows,final-revisions,authorized-delete,delete-settled,restart-comparison,final-restart-comparison,final-source-matches-built,final-ui}.json及原始各阶段快照。Windows／完整竞争场景／整体Grok与UI动画仍按原项待验，未commit／push。
  - [x] ~~1018BP 自动总结在途手动编辑、真实只读总结空操作与重启检索。~~先核实原CMB总结器、BotMemoryMaintainer及editVersion提交边界；对照Grok恢复源码MemoryService.prepareSynthesis/applySynthesis的fingerprint过期拒绝和Hermes旧条目校验／原子写入，当前已有同类保护，无需增加生产机制。隔离Mac预览中，MiniMax任务029f82a9…的真实总结请求开始后9815ms手动保存，14021ms后返回1条create操作；DeepSeek任务d72aeb49…请求开始后285ms手动保存，3896ms后返回1条create操作。两者enabled／active均true、signal未取消，仅editVersion改变导致eligible=false；对应快照没有新增记忆，人工内容保留。两轮正例均为拒绝迟到create，不能据此声称已验证所有update／delete竞争。
    - 实际只读查询0a9feb73…（DeepSeek）与44979a28…（MiniMax）各仅一次bot_memory_get，读取当前人工正文和版本；原自动总结器均实际返回operations:[]，不是仅依据“未见新增文件”推断。移除临时元数据诊断、恢复源码逐字节一致、正常构建后重启，85487b61…／1f799cf2…再次各一次get，名称／正文／版本与重启前工具回执完全一致。MiniMax转述正文时将中文引号改为英文引号，保留为输出细节差异，不称回复逐字准确；本轮空操作仅覆盖只读查询，不替代此前临时浏览器原场景。
    - DeepSeek前三次在人工保存前已返回，不计在途保护通过：首次旧编辑器保存明确提示“记忆已被更新，请刷新后修改”；第三次提出未知reference_前缀更新文件名，被原有文件匹配规则忽略，另新增一份合并项目格式合成事实3162f657…并保留。另一次真实在途返回空操作，不作为拒绝实际写入的正例。原始请求、时序、错误提示与未命中记录均保留，没有重写为全部首轮通过。未删除任何记忆，两份既有合成记忆经正式面板恢复到原始字节／SHA；本轮开始时230份既有文件和705条既有任务／全部Bot、群、例行、命令定义及4258条旧核心消息头保持，最终715任务、231文件、0活跃，两数据库quick_check=ok。
    - 正常退出诊断进程3577及全部所属进程后才构建；24项原记忆回归、node类型检查和正常构建通过，正常产物不含诊断标记。预览原39字符mask草稿已手动恢复，80px头像栏与原窗口大小恢复；本轮重启后该草稿输入为空，先前输入使用AX setValue，不能声称草稿自动恢复通过，也不据此直接归因生产代码，后续须用原生粘贴复验。BV仍需原生Zoom，P04.4与P11整体保持待验；删除／归档／退出／超时的真实在途场景、Windows与官方Grok实跑不在本轮通过范围。未修改生产记忆实现，未commit／push。
    - 本轮开始前即发现相对BO少13份旧/tmp验收文件、预览包Info.plist等资源也已缺失，删除来源未确定；保留清单，不归因Bot代码。按匹配的原Electron 39.8.10补回239份缺失包资源，使用LaunchServices记录核对原com.cmbdevclaw.bot-preview标识，恢复启动，没有修改产品启动代码。证据quality-review/1018BP-memory-inflight-edit/{audit-events,models-before-restart,models-after-restart,mm-manual-timing,ds-final-manual-timing,before-normal-restart,after-normal-restart,final,review,preexisting-file-difference,preview-bundle-repair}.json（audit-events为jsonl）、review.py及/tmp/cmb-1018BP-*日志；另保留到用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018BP-memory-inflight-edit.tar.gz，避免只依赖/tmp。
  - [x] ~~1017BD 真实总结请求在途关闭记忆。~~隔离预览沿用原自动总结、原设置和已配置模型；临时诊断仅记录请求开始／正常返回、操作数量及提交资格，不记录正文／请求／密钥，不延迟或替换返回。MiniMax任务f5de8f38…前台0工具，真实总结耗时23276ms返回8条操作，enabled=false／eligible=false；219份既有记忆及工作文件保持。DeepSeek任务ca767123…前台0工具，总结耗时19855ms返回20条操作，同样拒绝提交，227份既有文件保持。两个批次大小不同，仅作为关闭边界验证，不是交付质量同题比较。三次较短请求已在关闭前返回，均保留为时间窗未命中、不计通过；期间自动新增／修订的9份合成事实保留，不删除样例。
    - 已恢复记忆启用／Dream禁用，正常退出临时进程54331及全部4个所属进程后，诊断源码精确恢复到8dd7677e2；正常构建不含诊断标记、24项记忆回归及node类型检查通过。正常重启后原627任务、35Bot、10群、9例行、21命令、218旧文件和3806条旧核心消息头逐项不变；最终632任务／0活跃、两数据库quick_check=ok，mask原39字符草稿与280px侧栏恢复。重启仍需原生Zoom恢复电脑工具可读页面，BV不销项。此轮只完成真实关闭开关后的迟到结果边界，编辑／删除／归档／退出／超时竞争、Windows及P04.4整体仍待验。证据quality-review/1017BD-memory-inflight/{audit-events,models-complete,before-mm,before-ds,before-ds-large,ds-large-disabled,normal-quit-check,final,review}.json（audit-events为jsonl）、review.py及/tmp/cmb-1017BD-{memory-tests,normal-build,audit-node}.log。无生产记忆代码改动。
  - [x] ~~1017AH MiniMax自动总结与临时任务边界的定向验收。~~复用N模板及原summaries.enqueue→原路由／summarizeAndSave→版本检查，既有BS-MM以当前MiniMax运行：5df3abcd…前台0工具，后台唯一新增869e8a1c…（SHA903e2238…）；f2c2860c…同样0工具，修订写回同ID（SHA2b4e34c0…）。ccfce760…／2bd748b8…逐字相同的素材请求分别使用原／新三节，均保留Windows尚未验证、不增写计划。正式面板可见修订；128d7a47…只navigate／observe／close合成页面，实际空输入、尚未提交，无POST；总结路由后约49秒及重启后全部记忆SHA保持。原生菜单退出46104，原7个进程均消失／exec exit0；同配置正常重启后d6c11426…仅一次bot_memory_get，实际正文及完整当前版本匹配。原539任务、34Bot、9群、9例行、21命令及200旧文件不变，仅保留授权合成事实；最终545任务、0活跃、两数据库原消息头保持且控制库quick_check=ok。恢复用户本轮新建的需求沟通群、295px侧栏及空输入；未改生产代码或模型／记忆开关／路由。证据quality-review/1017AH-minimax-auto-memory/{before,after-auto-create,after-correction,before-browser,before-restart,quit-check,restart-comparison,restart-read-review,final-storage}.json。
    - [ ] 本轮范围限制：自然回复仍有同会话历史，不能单凭回复证明只来自私有记忆；自动落盘由0前台工具及新增／修订文件单独证明。修订请求因电脑工具输入的尾部残留多出“-MM-1017AH”，实际原文保留于控制库，不能称修订模板逐字一致；其余两次自然任务原文逐字一致。临时任务未捕获原始operations空数组，仅证明总结路由后至重启／读回的观察窗口未写入。真实总结在途取消、全部竞争场景及Windows仍待验；冷启动仍需原生Zoom恢复工具可读页面，BV不销项，P04.4父项保持待验。

  - [x] ~~1017N DeepSeek自动总结与临时任务边界的定向验收。~~复用K合成Bot与原summaries.enqueue→BotMemoryMaintainer→summarizeAndSave→applySummary、既有pinned路由，未改Dream／总开关／Runtime／总结代码。52a5acbc…前台0工具，仅确认鹤汀-1017N长期格式；后台真实DeepSeek路由后新增52c73cae…私有事实，144e1e91…不含标题约定的自然任务实际采用原三节。1773f78e…前台仍0工具，仅修订长期格式；后台更新同一ID为“本次变更／测试结果／待办事项”，没有第二条，持续打开的面板原位刷新。f56cc5a1…原题原文重测实际采用修订三节，保留“Windows未验证”，未编造放开／发布时间。临时浏览器任务07d4f80c…实际仅两次bot_browser（打开／关闭），读到回环合成页标题、空字段、尚未提交，未填表、提交或写记忆；其总结路由后69秒仍仅该一条新事实、修订SHA保持，无总结／解析错误。没有取得模型原始空操作响应，不把无落盘扩大为已证明所有提取决策。正常Quit PID18002及浏览器宿主38750并ps确认均消失，合成服务38310停止exit143；重启原配置451份任务／定义／文件不变，b832b65c…实际bot_memory_get读回同一修订ID、当前版本与三个标题。最终452任务／0活跃、quick_check=ok，原Bot／群／例行、446份旧任务及跟踪旧文件均未变，仅新增该合成事实并保留；没有删除样例或新增生产代码。BV启动绘制仍需原生缩放恢复，MiniMax、真实在途取消／关闭及整体记忆父项仍待验。证据quality-review/1017N-deepseek-auto-memory/{before,auto-saved,auto-save-storage,corrected,correction-storage,natural-and-browser,before-restart,after-restart-before-query,restart-query,review}.json。
  - [ ] 1017K 按用户最新要求先用DeepSeek验收当前记忆分享。复用既有BS-DS的鹭桥-DS合成偏好和已有外观核验-1014A（DeepSeek），先在未分享时实际查询目标Bot自己的记忆，再通过正式记忆面板只分享指定条目；独立任务读回副本、临时修改副本后核对原件不变和实际使用新值，最终恢复副本正文并保留样例、不删除任何记忆。再在已有资料核验群仅@该DeepSeek成员，确认私聊偏好不进入群。沿用现有BotMemoryService.share／版本保护、面板及原Runtime，不另写分享或记忆系统。新任务、文件哈希、真实工具回执和正常重启分别记录；不得把提示词存在、用户消息提供的前缀或旧MiniMax验收替代本次DeepSeek实际证据。
    - 首轮未通过，保留证据：02eb1016…实际查询自己的索引只返回两条无关记忆，明确没有鹭桥-DS偏好；正式面板选择外观核验-1014A后仅新增fe5ce60e…副本，逐字节等于原件且旧八份记忆不变。但独立自然任务dc1f2f55…仅返回“夜间任务延迟”，未用已存前缀，completed／0工具不能当作行为通过。用原BotMemoryService.forPrompt读当前三条事实，包含副本，原记忆块增加181字符，恰与两次真实Runtime的19352→19533字符增量相同；每轮重新创建Agent，未据此误改缓存或分享存储。参照Grok“持续沿用已知事实”和Hermes“召回资料非新用户指令”的边界，只在原记忆说明补清本轮快照优先于旧聊天的无记忆／旧值判断，已有事实可用于无工具的格式任务；不改变用户明确覆盖、项目范围、权限和4000字符预算。先用原自然题及不适用／显式覆盖反例复测，未通过前不继续副本编辑或群验收。证据quality-review/1017K-deepseek-memory-sharing/{before-share-query,shared,after-share-natural,natural-failed-before}.json。
    - 一句记忆说明修订复测仍失败：0ec873ac…原题原文／0工具，仍只回复“夜间任务延迟”。67项契约、node、lint和构建通过并不能证明模型行为有效，该新增说明及对应契约已撤回，原C范围规则保留。接着临时复用原Runtime已有getCapturedSystemPromptPreview，在隔离测试flag下只记录模型调用边界是否含私有记忆标题／指定合成副本ID／合成前缀及长度，不打印完整提示词、正文或密钥；诊断代码将撤除并重建后再交付。当前尚未定位为模型或harness，不提前下结论，不继续副本编辑／群验收。证据同目录after-memory-guidance.json，失败产物保留。
    - 模型边界诊断：ba732e52…仍0工具并回答本轮只有旧两条记忆；原Runtime最终systemMessage捕获却明确含共享副本ID与前缀（26634字符）。因此不能据组装前长度归因于模型忽略，也不能认定分享存储失败。继续在DeepSeek现有completionWithRetry发包边界临时记录仅system／developer消息的索引、长度、是否含上述合成标记；不读取或输出助手推理、完整请求／系统正文、key或其他配置。两处限定诊断均须撤除，查明实际HTTP消息是否含陈旧系统消息后再决定最小修复。证据同目录final-boundary-probe.json及/tmp/cmb-original-preview-1017K-diag.log中的限定审计行。
    - 实际普通通道已取证：当前DeepSeek配置enableThinking=false，故第一次专用thinking子类诊断未触发，不能当作请求不存在；已移到真实ToolCallAware completions边界只读记录。83acd80b…真实HTTP参数共223条消息，唯一system位于0，26630字符，含私有记忆标题／共享副本ID／合成前缀；Runtime捕获同样全部为true。模型仍声称只有旧两条事实，不能归因于分享未注入或旧system覆盖。下一步仅新增一个明确合成的DeepSeek短会话Bot并通过原面板分享相同事实，在未粘贴事实值的自然任务中做对照，区分长历史影响。原目标／源配置及文件保持，临时诊断仍须撤除后重建；此项继续未通过。证据transport-audit.json／actual-transport-probe.json。
    - 短／长会话对照：仅新增合成Bot“记忆短会话核验-1017K-DS”（4a71cf9b…），通过原编辑器选择deepseek-v4-flash、职责为空；创建时的介绍任务751582af…已正式停止且无可见回复，不计模型验收。正式面板只复制同一事实到441828a4…，逐字节等于源文件。78c8abbb…使用与长会话首轮完全相同、不含前缀值的自然任务，completed／0工具，正确回复“LBD-1017B-夜间任务延迟”。长会话bd20e42a…随后按要求实际bot_memory_search一次，再正确回复带前缀标题；查询未修改记忆。证据支持共享存储、每轮注入和检索可用，也表明该DeepSeek长会话曾忽略已注入事实，不能宣称自然沿用已稳定或靠提示词改动修复。保留长历史失败，不清空会话、不强制每轮检索、不增加输出改写。两处临时诊断已从源码精确撤除，原Runtime／模型通道没有生产改动；旧PID86666正常Quit且ps确认消失后重建正常包，原66项提示／Runtime适配／记忆／总结测试通过。后续在正常包中验证短会话副本修改、恢复及重启，原长会话／源事实不再修改。证据short-context-natural.json／long-context-search.json／before-normal-restart.json。
    - [x] ~~DeepSeek共享副本、当前版本、适用范围、群聊隔离及重启读回的定向验收。~~正常构建中只将合成短会话副本临时改为LBD-1017K-COPY，61ec42ba…自然任务正确采用新值；正式面板逐字恢复原正文后，0536c7b2…正确回到LBD-1017B，没有沿用历史临时值。8820efd0…另一项目无前缀，9461e4f9…仅本次不加前缀生效；四轮均completed／0工具，没有把预期值写进自然任务。已有资料核验群此前未出现该项目／前缀，只@持有副本的DeepSeek成员，bf4a9736…仅回复“批处理延迟”且0工具，未带入私聊偏好或触发另一MiniMax成员。正常Quit PID2497、ps确认消失后重启同一配置，443份任务逐项未变；22216e8d…实际bot_memory_get读回同一副本原正文、当前版本与范围。最终444任务／0活跃、quick_check=ok；原27份Bot定义、7群、例行配置、429份旧任务状态／更新时间及135份旧工作文件／记忆哈希均不变，仅新增已记录的一个合成Bot及两份分享副本，所有样例保留未删除。源码及正常构建均无临时诊断标记，构建／66项回归／diff检查通过。两次重启仍需原生Window→Zoom恢复电脑工具可读页面，BV不销项；长历史自然漏用、MiniMax及整体记忆父项继续未通过。证据normal-cases.json／copy-edit-storage.json／copy-restored-storage.json／before-final-restart.json／after-final-restart.json／restart-query.json／review.json。
  - [x] ~~1017B 双模型显式记忆开关、保存与读取的定向验收（B＋AG）。~~在现有BS合成Bot中分别交办一项仅针对新合成项目的长期标题偏好，先通过原请求选择卡等待；任务已开始后，从原设置关闭隔离配置记忆总开关，再继续两条任务，实际记忆工具必须拒绝写入且旧记忆不变，禁止改用普通文件绕过。恢复原开关后，分别明确保存新合成偏好并在独立任务实际检索，核对唯一条目／项目范围及正常重启后的状态。复用原memory:setEnabled、Bot记忆工具与总结适配器，不加新开关、存储或测试特例；保留新合成条目作样例，不删除用户记忆。首次只允许请求选择，后续写入需按当时真实开关执行，不能从提示词或模型“已保存”判断通过。自动总结的在途结果边界仍由BQ／后续实测单列，父项不提前勾选。
    - 当前M2.7保存请求52f75e99…因429／Token Plan用量上限失败，未调用工具；不算保存验收。模型列表实际还有既有MiniMax M2.5，仅对本轮合成MM Bot临时切换一次做正式任务探测，之后恢复原modelRef；不新增配置、不复制或输出密钥、不改其他Bot及全局默认，若服务不可达保留外部依赖缺口，不用DeepSeek替代MiniMax计数。
    - 两任务288ea294…／d6879041…均已实际request_user_input等待；关闭后选择保存，各一次bot_remember均返回error／“长期记忆已在设置中关闭”，无重试／其他文件工具，7份既有记忆Markdown逐项不变，无新条目；新启动进程日志无memory_summarize路由。恢复enabled=true／dreamEnabled=false后仍400任务、0活跃、没有迟到写入。DeepSeek新任务ae0be7cb…实际search/list/remember/get，仅新增5875b7df…一份条目；面板实际显示，后续ab9ea682…实际search正确取得前缀和范围，旧7份文件不变。M2.7新保存52f75e99…遇额度错误，M2.5探测27abf432…约208秒无响应后由正式停止取消、无工具；已恢复MM Bot原modelRef，其版本由2经临时选择变为4，其他字段应保持，不声称所有Bot版本未变。证据quality-review/1017B-memory-switch/{waiting-before-disable,disabled-before-answers,both-disabled,disabled-review,enabled-restored-before-save,saved,after-ds-query,mm-alternative-cancelled}.json；本项继续待双模型完整验收。
    - 1017G MiniMax可用性复核：正式MM Bot请求e2f04d02…只计算31+16，无工具或副作用；约106秒后真实failed，仍为429／Token Plan用量上限，没有工具及新增助手回复。未将running观察当失败或在处理中重复派发。证据quality-review/1017G-model-availability/{probe,settled,observed}.json，MM模型／配置不变；双模型待验缺口继续保留。
  - [x] ~~1017C 项目范围及单次覆盖的双模型定向复验（C＋AG）。~~1017B自然任务690b0ab9…明确给榆湾项目写一行告警标题，DeepSeek却套用了仅适用于鹭桥-DS的LBD前缀并额外解释，不能据保存／检索正确判定应用正确。已核对持久当前请求为榆湾、原条目明确“其他项目不适用”，Bot原记忆提示已有正向scope规则但模型仍越界应用。对照Grok的事实／请求区分、Hermes的memory-context参考数据边界，仅收紧既有Bot记忆使用说明：以最新请求确定当前范围，不把旧任务范围或记忆值当作用户本轮要求；当前是另一项目时忽略该项目专属规则，不无故追问是否沿用，明确扩展范围的当前用户要求仍优先。保留全部真实记忆及4000字符数据预算，不做硬编码项目匹配、输出删词、额外模型调用或新记忆体系。先跑既有正反契约，再用原题重测、另一无关项目和适用项目自然任务，MiniMax不可用时保持未完成并保留首轮失败。
    - [x] ~~DeepSeek 项目范围与本次要求的定向复验。~~只替换原记忆使用说明的一段文字，保留事实快照、4000字符预算、工具与原Runtime。原题802fc9a2…和另一项目c45d13e1…均只返回本项目标题，未套用LBD前缀；适用项目1eafeacd…正确沿用LBD-1017B；本次临时覆盖3b3d2b01…按用户要求不加前缀，四任务均completed／0工具。正常Quit旧PID71320并确认退出后，用同配置启动7727；四任务原状态／输出未变，新任务e9eb7ef1…实际bot_memory_get读回原条目，确认临时要求未写入。8份既有记忆Markdown逐项不变、没有新条目，27个Bot定义、群和例行配置不变，410任务／0活跃、quick_check=ok。66项原提示／Runtime适配／记忆／总结回归、node／web类型检查、定向lint／格式及构建通过。证据quality-review/1017C-memory-project-scope/{failed-before,scope-three-cases,before-restart,quit-stable,after-restart,restart-query,review}.json。冷重启仍需原生Window→Zoom恢复电脑工具可读页面，BV继续保留；MiniMax因额度未完成本次复验，1017B／1017C及P04.4父项不勾选。
  - [x] ~~1016BS 自然任务使用记忆。为排除旧聊天提供答案的干扰，在隔离预览通过正式入口新建MiniMax／DeepSeek两个合成Bot，分别显式分享已有青桐-1016X偏好副本；不在新聊天粘贴偏好正文，也不点名记忆工具，只交办该项目的普通发布说明任务。核对真实调用／回答是否采用固定三节，文件、他人记忆和原Bot配置不变。若未生效，先核对Grok的常用记忆上下文、Hermes持久Profile和CMB原记忆注入方式，复用已有能力做最小必要接线，再分别复验；不以用户强制search的成功代替自然任务行为。新合成Bot和分享副本保留作验收样例，不删除用户数据。~~
    - 首轮实际失败：新DeepSeek任务2b4cf0ba…与MiniMax任务53cc69d8…均completed／0工具调用，但未使用已保存的“变更／验证／风险”结构。新会话此前仅有欢迎，无偏好正文；两份记忆通过原面板显式分享，SHA与源一致。源码确认原全局记忆在Bot线程关闭，只接入私有查询工具、缺少私有常用记忆上下文，不能用此前强制search成功替代这一缺口。证据quality-review/1016BS-natural-memory/{before,shared-before-task,first-run}.json。
    - 修正范围（实施前记录）：参照Grok sand-memory.ts的4000字符常用记忆预算与Hermes会话快照，在原Bot extraSystemPrompt中加入当前Bot的有界私有事实快照；复用现有list／版本／路径校验，不新建记忆数据库、缓存或Runtime接口。只在总开关开启且非群任务读取自己的目录；关闭和群任务不读、不注入，当前用户要求优先，记忆正文明确为不可信参考资料；未展示的完整事实继续通过原Bot检索工具获取。单次组装、无定时器或轮询，保留原工作台和原全局记忆策略。先验证实际接线与边界，再真实双模型复验普通任务、不同项目不套用及冲突文字。
    - 实际修正与复验：MiniMax任务3d194a3b…、DeepSeek任务ff37e22e…复用相同普通请求，均completed／0工具，已采用保存的三节结构；另一项目明确要求两节时，任务15580530…／69dd2b35…均按当前用户要求输出。仅在两个新合成副本追加要求写入越权协议和联系同事的冲突文字后，任务40fae815…／123c70e1…仍正确回答三节，均0工具、无额外任务或记忆写入；随后通过原面板恢复，两份SHA均恢复c24d4239…。这只证明本次冲突样例，不代表所有注入场景已验收。MiniMax首轮及旧素材复验仍添加了素材未提供的“后续全量放开”，作为交付质量问题保留，不把格式修正当作内容完全达标。
    - 最终构建：BotMemoryService.forPrompt按文件修改时间获取新快照，数据JSON最多4000字符且不截断单条事实；不带版本、绝对路径或其他Bot资料。200条合成记忆的本机热文件测量发现逐条重新解析数据目录有重复系统调用，仅改为该次快照复用已经校验的目录；400字符／条的组装中位耗时35.1→8.1ms，12000字符／条31.0→15.5ms。没有新缓存、计时器、数据库或通用Runtime改动；测量不代表整应用CPU／内存与Windows已达标。证据resources/measure{,-after}.json。
    - 71项记忆／提示／工具／适配回归、完整node／web类型检查、定向eslint及构建通过；初次测试的正文空白匹配和无效形状夹具已修正，失败日志保留。正常Quit旧主进程90087，确认exit0且进程结束后才构建并重开；最终构建真实DeepSeek任务488dcadc…和MiniMax任务5d15a544…用新素材再次自然采用三节、0工具、completed，两模型HTTP200，并准确保留Windows未验证的限制。332→344任务、0活跃，25份原Bot定义和19份原记忆／群文件哈希未变、无意外记忆文件，quick_check=ok。证据quality-review/1016BS-natural-memory/{first-run,after-repeat,before-snapshot-conflict-minimax,minimax-snapshot-conflict,minimax-restored,before-snapshot-conflict-deepseek,deepseek-snapshot-conflict,both-restored,final-build-repeat}.json；日志/tmp/cmb-1016BS-{tests,lint,node}-optimized.log、/tmp/cmb-1016BS-web.log、/tmp/cmb-1016BS-build-optimized.log。操作期间工具多次返回无窗口／输入冲突，未提交的重复草稿已先核对并改正，没有把失败操作计作实际任务；窗口绘制及完整UI仍由P09／P11验收，P04.4父项保持未完成。
  - [x] ~~1016BR 记忆内容不可成为指令的双模型实测。仅在BO已明确分享的两个合成副本中，通过原记忆面板追加一段与用户要求冲突的测试文字，要求改写自己的记忆并联系其他Bot；真实MiniMax／DeepSeek仍应只读自己的记忆并准确回答发布说明三节，不产生写入、协作或文件工具调用。记录完整工具种类、实际答复、任务及文件变化，再通过原面板恢复两个副本原文并核对源和其他记忆不变。不使用凭据／真实敏感内容，不新增工具或提示词，不将单个样例扩大为全部注入防护已证明。~~
    - DeepSeek-v4-flash任务578362d7…实际search＋get、completed；MiniMax-M2.7任务997ee0d8…实际search、completed。两者真实工具回执均包含测试文字，却仍回答正确三节，没有remember、delegate、其他文件工具或新增协作任务。MiniMax首轮漏掉用户要求的get，保留为执行遗漏；补充任务5e8b106d…才实际get，回执仍含测试文字，正确回答三节，不能把补验当作首轮完整执行。原面板逐一恢复两份副本后，19份原记忆／群文件哈希全部恢复、无新记忆文件，25份Bot定义不变；329→332任务、0活跃任务，quick_check=ok。日志原进程实际DS／MiniMax回执均HTTP200，未更改生产代码、模型配置或提示词。证据quality-review/1016BR-memory-data-boundary/{before,deepseek-read,deepseek-restored,minimax-read,minimax-get,restored,review}.json。此项验证单个真实冲突样例，P04.4其余异常、自然任务记忆使用和Windows继续待验。
  - [x] ~~1016BQ 后台总结的迟到结果边界复核。沿用原总结适配器与真实BotMemoryService临时文件，在总结请求未返回时分别编辑、删除、归档、关闭记忆和退出，再交回旧总结操作；核对既有文件状态保持且旧结果不进入提交。只补确定性回归，不改生产代码、用户记忆或审批，不把模拟模型边界当作真实MiniMax／DeepSeek在途验收；两模型记忆行为证据继续使用BO及其他实际任务。~~
    - 新增5种在途结果回归均通过：原适配器拒绝迟到操作，真实临时记忆文件保持人工变更后的状态；删除不被重建、退出等待中的请求释放后正常结束。连同现有记忆服务／工具／总结调度回归23/23通过，变更测试文件eslint通过，日志/tmp/cmb-1016BQ-{memory,lint}.log。无需修改生产实现；不据此勾选真实模型异常路径或P04.4父项。
  - [x] ~~1016BO 原记忆面板显式分享双模型续验。复用外观核验-1014A已有青桐-1016X合成条目，分别通过原分享入口复制给AP／MiniMax和DeepSeek交付核验；不向模型直接提供源正文，接收方须实际search／get读取自己的副本。只在接收方副本加一行合成备注，核对源及另一副本独立，再恢复副本原文；保留本次明确分享的两份合成副本，不删除已有记忆、不新增存储或模型实现。核对源、其他记忆及工作资料哈希，原生退出／同配置重启后两模型再次实际检索验证副本持久。已有1015A的MiniMax分享验收保持，本次补同一当前构建下的双模型和双副本证据，不据此宣布全部记忆异常路径完成。~~
    - 原生面板两次分享均明确核对接收方后确认，仅新增AP的ad15127d…与DeepSeek的8948a9e0…两个文件，原文／SHA与源相同。两条真实任务7149ea18…／097cf899…各调用search和get，均报告正确三节。只编辑DeepSeek副本后，任务6f4dca14…实际读到新增备注，MiniMax任务d7e9c363…实际读回“没有”，源和另一副本哈希不变。恢复副本原文后，正常Quit主进程78853、exit0且独立确认结束；同配置重启仍325条任务、无重放，旧任务终态与时间未变。重启后两模型任务320e4065…／d7456869…均search＋get、completed、HTTP200，读取同一各自ID与原文，明确当前没有旧备注；最终327任务、0活跃，18份既有记忆／群文件与25份Bot定义未变，两个副本恢复原SHA，quick_check=ok。没有修改生产代码、模型、记忆开关或审批。证据quality-review/1016BO-memory-share/{before,shared,retrieved,copy-edited,independent-retrieved,restored-before-restart,after-restart-before-query,after-restart-query}.json。只覆盖这次显式副本分享、编辑独立及正常重启，P04.4其余异常／群边界与Windows仍保留。
  - [x] ~~1016BN 双模型私有记忆检索隔离。复用外观核验-1014A已保存的青桐-1016X合成记忆作为源，只在原AP／MiniMax与DeepSeek交付核验私聊检索该标记；实际工具应仅访问当前Bot记忆并返回无命中，回复准确区分“自己的私有记忆无结果”和“别人没有记忆”。不向接收方提供记忆正文，不显式分享、不新增或删除条目、不改开关、模型与职责；核对源和其他既有记忆、工作资料哈希保持。此项不替代显式副本分享和群任务边界的其余验收。~~
    - 真实DeepSeek-v4-flash任务5de68efe…、MiniMax-M2.7任务9ce84a71…均completed／HTTP200，各仅新调用一次bot_memory_search，query相同，两份真实ToolMessage均为[]；最终回复明确为本人未命中、不能推断其他Bot，未复述源记忆正文。源条目实际存在且含该标记；18份既有记忆／群文件哈希和25份Bot定义未变，0活动任务。沿用原工具硬绑定bot.id的查询，未改任何生产源码或配置。证据quality-review/1016BN-memory-isolation/{before,after}.json。MiniMax轮次还持久化了一条历史request_user_input取消补回执，属于原1016AR中断问题，无新问题调用；不把它当成本轮记忆工具。此项只证明两位非拥有者的实际检索隔离，不代替显式分享、恶意记忆或完整自动总结并发验收。
  - [x] ~~1016AN 面板旧版本与真实模型更新冲突。复用外观核验-1014A 的既有合成金额排版-1016O 条目，保存原文件／版本证据；在面板保留“四位小数”未提交草稿，再通过正式私聊让该 Bot 只把同一条目改成“三位小数”。旧面板保存必须拒绝且保留草稿，存储仍为模型新值；取消后重新读取并从面板恢复原“五位小数”，核对另一条记忆不变及后续未覆盖恢复值。不新建或删除记忆，不改正式配置，完成后核对重启状态。~~
    - 原配置真实 DeepSeek-V4-Flash：任务 13ed6807-33bd-4ab8-b698-026da9f3370f 实际更新并读回同 ID；保存旧面板草稿后显示“记忆已被更新，请刷新后修改”，未丢弃四位小数草稿，磁盘仍是三位小数。取消／重新打开即显示最新三位小数，从面板恢复五位后两份文件 SHA-256 均与测试前一致。原生 Quit 并独立确认主进程86178／浏览器宿主86751不存在；同配置重启，任务 5f3c5260-0311-44f8-b71c-c47adf67d2e6 实际 bot_memory_get 得到五位小数，模型明确区分当前版本与旧聊天。无新增／删除条目，无源码修改。证据 quality-review/1016AN-memory-edit-conflict/{before,after-conflict,restored-before-restart,after}.json。此次恢复时未独立证明总结仍在执行，不以它替代“旧待总结不能覆盖”的并发验收；MiniMax 记忆仍引用此前实测，不将 DeepSeek 结果冒称 MiniMax。
  - [x] ~~1016AO 任务开始后关闭记忆总开关。只操作已获授权的隔离配置；在既有 Bot 的真实任务等待输入时关闭原应用记忆开关，再继续原任务尝试保存合成偏好。必须拒绝写入且既有文件不变，自动总结不得落盘；恢复原开关后核对旧任务不被重放。使用原设置、Runtime、工具和记忆实现，不新增开关或特例，不以“新请求开始前就关闭”的旧测试代替。~~
    - 原预览真实 MiniMax-M2.7 任务 437cf71a-ce03-41d8-b164-cf5d863221e7 在记忆开启时启动，实际 request_user_input 等待且控制库为 waiting_user；从原设置关闭隔离配置记忆后，返回同一卡片选择保存。实际 bot_remember 返回 status=error／is_error=1、“长期记忆已在设置中关闭”，模型未重试、未写文件，任务 completed。AP 私有 Markdown 仍为零，另一 Bot 两份既有记忆哈希完全不变；本次完成后没有 AP 的 memory_summarize 路由，符合适配器在总结执行前检查开关的实现。恢复 enabled=true／dreamEnabled=false 后任务数仍为268、原任务终态时间未变、无补写条目。证据 quality-review/1016AO-memory-disabled-midrun/{before,waiting-before-disable,after-disabled,after-restored}.json。此项覆盖任务进行中禁用；不替代“模型总结已经发出后再禁用／编辑／删除”的独立并发验收。没有修改源码、正式配置或审批策略。
  - [x] ~~1016AG 临时浏览器任务与“不保存记忆”真实 MiniMax 续验。复用原预览 AP、已有本机合成页面及原总结链，实际观察页面但不提交表单，不产生长期偏好。检查主任务工具／回执、私有 Markdown 前后哈希，以及最终总结 apply 的操作数；仅临时输出布尔状态和操作类型，不记录模型正文或凭据，验证后撤除诊断。不得仅凭目录暂时为空声称总结已完成。~~
    - 原应用真实 MiniMax：a4ac7538-be81-4c3c-accb-afa194d2c66a 实际观察合成标题／两字段，completed，最终总结 accepted=true、operations=[]；9dfb5253-3f6a-4389-bfc7-15915b7a2f08 不重复显式“不保存”禁令，临时核对后总结同样零操作。两次前后 Markdown 均为零，持续打开的面板保持空态。第二题发生旧 pageId 拒绝、模型重新导航后恢复，但把文件输入的 button 角色误判为无文件控件，该交付错误另列 1016AH，不能将两题浏览器质量都记为通过。证据 `quality-review/1016AG-memory-no-save/{before-files,after,second}.json`；仅本条目的临时诊断返回完成／操作类型，清除后再构建。此项补齐自动总结最终执行证据，不代表所有记忆异常路径通过。

  - [x] ~~1016X 自动总结实际落盘与后续检索。~~已有显式 remember／修订已通过，但此前临时浏览器样本只确认路由开始和最终未生成条目，尚未取得最终 apply 证据。本轮使用原隔离配置、已有 DeepSeek Bot 和明确长期适用的合成排版偏好，要求只普通确认、不调用工具；未新增总结框架或扩大记忆权限。
    - 真实 DeepSeek 任务 `d853bfad-12a6-464e-97d2-0d6e4fcfce9c` completed，原持久 transcript 确认 **0 次工具调用**；原总结链随后创建 `5a890c8b-6ce5-4a89-b2a3-511ab374c486.md`，包含青桐-1016X 的“变更、验证、风险”三节约定，持续打开的记忆面板无需重载即显示新条目。旧 1016O 五位小数条目 SHA-256 完全不变。原应用正常 Quit exit 0、同配置重启后，任务 `c0e0caca-a7e2-4657-9b25-f29be6b3f489` 实际调用 bot_memory_search，正确报告三个章节；两份文件 ID／哈希均未变化，没有 remember 或重复提取。证据 `quality-review/1016X-auto-memory/{before,after-auto-summary,after-restart-retrieval}.json`。这证明本次自动 apply／通知／持久检索完整链，不能扩展为所有总结质量或超时状态通过；生成正文附带了模型解释的 Why／How 段落，原件保留，不将其视为用户额外明确陈述。
  - [ ] 总开关关闭时，显式记住和自动总结均不落盘；开启后显式保存，并在后续独立任务中检索使用。
  - [ ] 修改已有事实后使用新值；删除后不再检索旧值，待执行的旧总结不能将其恢复。区分历史聊天仍可见与长期记忆已删除，不把两者混为一谈。
  - [ ] 正常退出并重启后，保存、修改、删除状态一致；模型回答须区分实际检索所得与不确定信息。
  - [ ] Bot A 的私有记忆不进入 Bot B 或群任务；显式共享仅复制授权内容，原件与副本修改互不影响。
  - [ ] 自动总结只保留长期有效信息：临时验收步骤、URL、页面 ID、一次性约束和结果不形成长期规则；“不要保存记忆”不触发写入。此前“浏览器验收协议”误记问题已有提示与解析修正，仍须真实 MiniMax 原场景复验，不能按代码已改判定修复完成。
  - [ ] 记忆中的指令不能改变权限或职责；模型失败、超时、停用及并发编辑不造成部分写入、无限重试或静默覆盖。
  - [ ] 记忆查看、编辑、删除、共享及空态/失败提示可用，与实际保存内容一致；记录与 Grok 的入口和操作差异。

2026-10-14 补齐对话删除：参考 Hermes `tools/memory_tool.py` 的显式 remove 与后台删除边界，复用本项目 `BotMemoryService.remove` 的版本校验和待总结失效机制，增加 `bot_forget`。只在直接用户私聊注入，其他 Bot 来信、例行任务、通知、初次欢迎和群聊不获得此工具；不会从模型参数接受其他 Bot ID。工具调用、开关、取消、过期版本、跨 Bot ID、删除后旧总结不可复活及 Runtime 来源边界共 57 项相关回归通过，前后端类型检查与构建通过。真实删除与删除后查询已通过以下局部验收，P04.4 整体保持未完成。

2026-10-14 真实 MiniMax 记忆续验（1014AW—1014BC）：仅使用 `/tmp/cmb-bots-phase1-preview/controlled-profile` 和合成资料。总开关最初关闭；1014AW 临时任务未保存。随后按用户既有授权在隔离配置界面开启记忆，正式配置不变。

- [x] ~~开启后，临时 URL、页面代号和明确“不保存”的验收指令未形成记忆条目。~~ 1014AW2 回答 25，自动总结路由实际触发，未生成 `.md` 记忆文件。此为定向样本，不替代此前完整浏览器误记场景复验。
- [x] ~~长期偏好自动保存，后续任务实际检索，修正原条目且无重复。~~ 1014AX 保存“项目周报格式偏好”，1014AY 实际调用 list/get，1014AZ 将合成代号从“青鹭-1014AX”修正为“白鹭-1014AZ”；金额两位小数保留，原条目 `01825d30-7eac-4636-91a4-7f0fc067d146` 更新，始终只有一份记忆。
- [x] ~~正常退出重启后，已修正内容仍可实际检索。~~ 重启前后文件 SHA-256 一致；1014BA 调用 list/get 后回答“白鹭-1014AZ”及两位小数。证据：`/tmp/cmb-bots-phase1-preview/quality-review/1014AW-AZ-memory/before-restart.json`。
- [x] ~~对话删除后再次查询为空，旧聊天内容没有被重新保存。~~ 1014BB 首次 `bot_forget` 使用过期版本被拒绝，模型重新 get 后成功删除；1014BC 实际调用 list 返回空，明确区分聊天记录与长期记忆。之后再次检查私有记忆目录，无 `.md` 文件。任务分别为 `d0c3c4e3-eb22-4ba1-96aa-983a63d0f3f9`、`c529d0ab-17b6-466d-9c3d-7693ba4490ed`；磁盘证据 `after-forget.json`，运行日志 `/tmp/cmb-memory-forget-live.log`。这是版本保护与模型重试恢复证据，不宣称实测了两个同时写入的请求。

- [x] ~~删除后的再次进程重启仍保持为空。~~ 1014BD：预览进程正常退出（exit 0）后启动新版，真实 MiniMax 调用 `bot_memory_list`，界面回答长期记忆为空。任务 `4c952b5d-7d4b-4f3b-b450-d127d34eb0fb` completed，结束后独立检查无 `.md` 文件；证据 `after-delete-restart.json` 和 `/tmp/cmb-avatar-state-live.log`。

截至下方续验后仍待完成：面板删除与失败恢复、完整 Grok 记忆入口对照、处理中关闭开关、完整浏览器误记原场景及其他异常路径；跨 Bot／群聊隔离、分享、面板编辑及禁用时显式写入的已测范围见续验，P04.4 整项仍未完成。

2026-10-14 真实 MiniMax 隔离续验（1014BE—1014BF）：
- [x] ~~A 显式保存私有偏好，B 在未分享前实际查询不到该条目。~~ 初见验收-1014AI 调用 `bot_remember` 保存“值班记录排版偏好”（银杏-1014BE、24 小时制）；协作核验-1013AJ 调用 `bot_memory_list` 后回答自己的列表为空。两任务分别 `d4b16c1a-8872-4e53-8e72-d6660cf88ade`、`3bfeac90-575e-4d3d-92e7-163d9a712379`，均 completed。磁盘确认 A 一条、B 无条目；证据 `/tmp/cmb-bots-phase1-preview/quality-review/1014BE-memory-isolation/before-share.json`。只证明此直接检索场景，群任务隔离、显式分享及副本独立修改继续待验。
- [x] ~~成功记忆工具记录遵循执行过程开关。~~ 实屏确认原先执行过程关闭时，成功的记忆工具仍显示卡片。沿用已有普通工具折叠白名单补充五个非交互记忆工具，未改 Runtime 或消息存储。投影测试 5 项、原消息回归、web 类型检查和构建通过；2026-10-15 新版实际打开初见验收-1014AI，关闭开关时记忆查询/保存记录收起、用户回复保留，打开开关后 list/remember 记录重新可见，再恢复关闭。失败保留有定向测试，新增真实失败展示尚未复测，不据此认定全部工具展示已对齐。

- [x] ~~面板显式分享后，修改原条目不覆盖副本；接收 Bot 实际读取副本。~~ 2026-10-15，通过初见验收-1014AI 的记忆面板分享“值班记录排版偏好”给协作核验-1013AJ，成功提示出现；随后在同一面板将原条目改为“松柏-1015A”，接收方界面仍是“银杏-1014BE”。1015A 真实 MiniMax 回复代号“银杏-1014BE”、24 小时制，任务 `77b90d72-e2ee-4dc8-9a41-e06fdc953393` completed；磁盘原件与副本 ID、内容独立。证据 `quality-review/1014BE-memory-isolation/after-share-edit.json`。两份合成条目暂留供后续禁用/删除验收。
- [x] ~~已有私有记忆的 Bot 在群聊中不自动带入该内容。~~ 1015B 在身份群核验-1014AV 使用键盘 @ 选中协作核验-1013AJ，只询问标题、未提供私有代号；群内回复“不知道。当前群聊上下文中未提供……具体内容”。控制库只派发所选成员，群专属 thread，任务 `0ea9ed6b-d4c8-499b-929b-82db0937a56b` completed，未改变两份记忆文件。本例验证正常群任务隔离，不代替恶意越界尝试的权限测试。

- [x] ~~总开关关闭时，真实模型明确请求保存仍被拒绝，已有记忆不变。~~ 1015C／1015C2 仅关闭隔离配置总开关，真实 MiniMax 实际调用 `bot_remember`，回复“未保存”，原条目文件 SHA-256 保持 `f7a3829d…695b6`，无新条目；自动总结适配器也由总开关阻止。证据 `quality-review/1014BE-memory-isolation/disabled-write.json`、`disabled-write-fixed.json`。这验证开关关闭期间的新请求，处理中途关闭仍需另验。
- [x] ~~记忆工具错误保留错误状态，简洁聊天不隐藏失败。~~ 1015C 暴露原 Runtime 的 `wrapToolErrors` 把抛出的 Bot 记忆错误转成普通文本，界面显示 OK。复用现有 Bot 文件交付／浏览器的错误 ToolMessage 做法，在记忆工具入口补充带调用 ID 的错误返回，保留取消抛出和无调用 ID 的原错误行为；未改原 Runtime。23 项工具、存储与展示回归及 node 类型检查／构建通过。正常退出重启后，1015C2 同题实测“工具失败”在执行详情关闭时仍可见，模型回复未保存，磁盘无变化。旧历史不靠文本猜测修写错误状态；新结果保留真实状态。
- [x] ~~面板删除原件与分享副本，空态及后续模型查询正确。~~ 用户明确确认后，通过两个 Bot 各自面板删除两份“值班记录排版偏好”；删除 A 原件后 B 副本仍在，随后删除 B。两面板显示“还没有保存记忆”，独立检查两个目录均无 `.md` 文件；1015E 真实 MiniMax 调用 `bot_memory_list` 并明确条目已从长期记忆删除，没有从旧聊天重新保存。证据 `quality-review/1014BE-memory-isolation/after-panel-delete.json`；总开关已在隔离配置界面恢复开启，Dream 保持关闭。

1015AA 续验准备：复用已有合成表单服务，在独立回环端口执行一次临时浏览器读取（标题、字段、提交状态），不提交表单、不变更长期偏好。沿用原隔离配置及协作核验-1013AJ，执行前私有记忆为空；检查真实浏览器工具结果、任务终态和自动总结后的磁盘状态，复验此前一次性浏览器步骤被误记的问题。只新增验收证据，不更换记忆实现。

1015AA 实测：真实 MiniMax 经 `bot_browser` 正确读出“合成资料验收”、两个空字段及“尚未提交”，任务 `015a1686-9276-400f-be91-72134364b787` completed，未提交表单。日志确认进入 `memory_summarize` 路由，随后及正常重启后该 Bot 私有记忆仍为空，未再生成“浏览器验收协议”；本轮没有独立观测到总结模型的最终响应／apply 完成事件，因此只记录该实际结果，不据此宣布记忆异常路径全部通过。证据 `quality-review/1015AA-browser-memory/after-restart.json`；自建合成服务随后停止。


- [x] ~~P04.1 接入指定目录的记忆存储、检索、总结；关闭 Bot 会话原全局写入并尊重总开关。~~
  - 2026-10-12：复用原 `MemoryStore`、`summarizeAndSave`、模型路由和 `SingleFlightBatchCoalescer`；Bot 会话关闭原全局自动记忆写入，私聊成功后在独立目录总结。适配器测试验证总开关、归档状态、目录归属和提交时复核；真实模型效果另见 P12.1。
- [x] ~~P04.2 提供记忆查看、编辑、删除与共享授权；路径及符号链接越界被拒绝。~~
  - 记忆面板已接入查看、编辑、删除、按指定版本分享；`memory.test.ts` 验证路径穿越、符号链接、过期版本拒绝和分享副本隔离。视觉与真实模型体验另在 P09／P12 验收。
- [x] ~~P04.3 验证多 Bot 不串记忆、删除后不被异步总结复活、并发初始化及缓存释放正确。~~
  - 2026-10-12：`memory.test.ts`、`memory-maintainer.test.ts`、`memory-summary-adapter.test.ts` 共 11 项通过；覆盖隔离检索、同时初始化、手动编辑／删除使旧总结失效、指定记忆复制、单请求串行、待办合并和退出取消。模型调用超时 30 秒、禁用内部重试；每个 Bot 的待总结文本有上限。

### P05 — 收件箱与协作

- [x] ~~1019EF 同一对 Bot 参与两群的任务隔离（Mac，真实MiniMax／DeepSeek交换角色）。~~ 沿用原Host的Bot级串行租约、每群游标、group/member线程及群工作目录，没有新增生产机制。A群MM任务c5e4c1a8…实际选择等待时，B群DS任务c9aa436a…已write／read／deliver，MM的B群复核0d11fa00…保持queued且A文件不存在。反向A群DS任务07d18093…真实等待时，B群MM任务7f164b04…完成相同交付，DS的B群直接任务347b6e66…保持queued且A2文件不存在。两次真实Continue后，原A任务完成，排队任务才进入各自B群线程；四份文件均从正式成果入口打开，群间标记、路径及回复未串线。
  - 32项限定隔离核对通过：13条相关任务全部completed、0活动／0游标；原1274任务、60Bot完整资料、17群、15例行、54命令、339旧文件／记忆及6516旧消息头保持。仅新增一个两位既有成员的合成群、四份样例及原Runtime正常生成的群工作区setup-state.json。最终1287任务、18群、344文件／6586消息头、两群四个成员线程归属正确；沿用ED构建，源码及完整主程序SHA保持，未重新构建或改模型配置。证据quality-review/1019EF-multi-room/{verification,final-results,final,source-and-build}.json及各等待／排队现场、真实问题／成果预览；Windows、更多群压力、全UI／动画与官方云端多群行为没有被本项代验。
  - 首轮质量问题保留，allTaskConstraintsPassed=false：MM的A1首次工具参数本身没有末尾LF，文件13B，与工具回执一致，不是写文件工具删换行。明确反馈后b7481a5d…先read，再write被原“文件已存在”守卫拒绝，随后edit／read／deliver成功，14B修订成果已从界面打开；首件单独保留。MM的B1复核额外交付同一文件，A2可选轮又发“本轮无需我执行任何操作”，不符合原约束；不以隔离通过或修订成功宣称交付质量／回复节奏达标，继续由EH处理。
  - 原mask的39字符私聊草稿及另一群的506字符未发送草稿仅作长度／SHA核验，均保持；恢复陈强原会话、详情及窗口。后续EH构建前通过原生菜单正常Quit，旧预览session40762退出0、全部所属进程为0；EF数据未被测试脚本改写，未commit／push。
  - 参考边界更正：Hermes groupSessionKey显式按thread／member持久隔离；Grok 0.18重建源码pinMemberSessionForGroupTurn按memberId取得原session，再绑定room transport，不能称两者都采用相同的每群独立后端会话。CMB直接保留已有每群成员thread。部分电脑工具输入／控件绑定失败均发生在发送前，正文及收件人逐项核对后才唯一发送；B2最终通过正常群输入向两成员交办明确不同职责，用户已确认未同时操作窗口。未用私有IPC或数据库写入构造测试。

- [x] ~~1019EH 可选群复核的进度／文件交付范围局部修正与Mac双模型复验。~~ EF已复现额外附件和无事确认；原可选轮已有exact pass规则，但后面仍追加面向一般任务的进度及文件交付提示。参考Grok群专属SendMessage/pass职责和Hermes可选群轮的单条有用回复／exact pass，仅让discussion不接收一般任务的进度交付段，并用复核范围替换其通用文件交付段：已有同伴附件不自动成为自己的新交付，仍可发布缺失／修订成果及用户明确分配的新交付。工具、权限、原Runtime、轮次、消息投影均未变，没有输出过滤器或新调度机制。
  - 先红后绿：新增范围用例修改前1 failed／9 passed，修正后Prompt／群轮次／Host共120项通过；node、最终lint／格式、正常构建通过。使用修改前源码及同一依赖实际生成10类非discussion提示，全部逐字节相同，覆盖普通私聊、介绍、直接群任务、私聊／群协作与回执、例行及后台通知。合成discussion提示从6868降至6191字符；原exact pass、真实证据、成员范围及补交能力保留，不靠堆叠一组额外规则。
  - R1原题重放：DS 99ead92b…只write／read／deliver，MM a990257b…直接pass；原题允许同伴选择检查，因此不把“没有再附文件”当成实际只读验证。随后R2的MM cdde91e1…、R3的DS 0f1bde01…在明确职责中各实际read_file一次、报告真实标记，零写入／零附件；两源件均从聊天成果入口打开。两题后续轮均pass，没有用不执行检查来掩盖重复交付。
  - 正例P1／P2：首成员分别只交付保留错误算式的明确UNVERIFIED草稿；MM 11d42528…及DS ec5ad71b…作为可选复核者，分别实际read／write／read／deliver新final文件，独立核对17+8=25并指出草稿24错误。两份最终报告124B／135B均从正式界面打开，两个原草稿逐字保留；没有把修订与需要交付的工作静默掉。S1重放EF无事确认的真实选择场景：DS 4c11a48d…实际等待、原生Continue后write／read／deliver，文件标记与换行正确；MM 0477d88c…零工具且没有群消息。六个无新工作的可选轮均无公开气泡／附件。
  - 35项限定核对通过：6份唯一用户请求／16条completed执行、0活动／0游标；原1287任务、60Bot／18群／15例行／54命令、344旧文件／记忆及6586旧消息头保持。仅新增8份指定群文件；最终1303任务、352文件、6676消息头，无新线程或私聊任务。两份原草稿哈希保持，恢复陈强原空输入及详情。源码和完整主程序仍与tested-build逐项匹配。证据quality-review/1019EH-review-scope/{verification,final-results,final,tested-build,prompt-comparison}.json、原生选择／成果预览与红绿／类型／构建日志；最初把空编辑器的15字符占位文案当草稿的验收保护误报，仅修正外部验收器的“原占位且发送禁用”判断，未改产品。
  - 官方0.71.2本轮只读打开原合成群，核对消息／附件展示后经搜索恢复陈星越原空草稿，未发送新消息；不将这次只读检查称为官方同题模型对照。本项证明当前Mac样本中多余附件／无事确认的复现路径已修正，不保证任何模型未来永不违反指令，也不关闭P05／P12父项、Windows、全UI／动画或全部长程质量。未commit／push。

- [x] ~~1017AU Mac新聊天附件在取消群创建后的衔接。1013AN已覆盖正常建群，本轮只补此前未实测的取消再建群路径，并验证现有DeepSeek／MiniMax两成员分别交付同题文件：在选定收件人前添加合成CSV和文字，取消群创建时不得创建群、导入文件或丢失草稿；重新选择并创建后只把附件导入该群，切换原群不串稿，实际发送只产生两个成员任务。继续使用现有BotNewChat／BotDraftFileTransfer／carryGroupDraft及原CMB附件解析与Runtime；沿用Grok先暂存、后按收件人提交的行为，不新增草稿或传输系统。独立核对附件副本、两份报告的计算／字段／交付入口、实际任务与工具回执；保留原群@草稿与既有数据，不把本项计为拖拽、真实输入法、失败网络或Windows验收。~~
  - 已验证取消时无数据变化、草稿和附件保留；再建群仅导入一份92B原件，SHA与源CSV相同。两成员各read_file／write_file／bot_deliver_files一次，恰好2条completed任务、零工具错误；两份原件均在群内打开，独立Decimal核对5笔／48.70／草稿多计1.00正确。DS1102B报告使用无依据的“虚报”判断，单列交付质量差异；MM935B报告无此判断。证据quality-review/1017AU-new-chat-cancel/{cancel-review,handoff-review,delivery-review}.json；不以这些局部结果宣布本项完成。
  - [x] ~~同路径发现取消后的键盘焦点缺口：Escape回到HTML根，随后Tab到侧栏“搜索Bot”，没有回原收件人。BotChatRecipientPicker的临时option关闭后卸载；沿用1017AM账户菜单先聚焦稳定入口再打开设置的原做法，在choose中先聚焦现有combobox，再关闭选项并调用原onSelect。核对已安装Radix源码发现模态Dialog默认仅恢复DialogTrigger，本弹窗没有Trigger，单靠前述两行不足；继续复用本文件已有useRef和原BotEditor的onCloseAutoFocus／isConnected／preventScroll模式。仅修改两个Bot组件，不改公共Dialog／草稿／派发，不新增监听、计时器或焦点系统；按Grok已核对的稳定入口原则处理。重建后实际验证鼠标取消／Escape／后续Tab及重开，双模型报告复核与原数据保持后再划掉。~~
  - 1017AU最终Mac复验：鼠标选择“创建群聊”后Escape及鼠标取消均回到收件人候选，下一次Tab准确到“关闭新聊天”，不再到HTML／侧栏搜索；合成草稿保持，随后仅清空本轮草稿。现有群的“群聊设置→取消”回原设置按钮。实际焦点由AX的候选aria-activedescendant和后续Tab共同核对，不把候选行当作独立DOM焦点。改动限BotChatRecipientPicker两行与BotGroupEditor的原模式焦点回退，共两个Bot组件，无新增监听／计时器。最终web、lint零错误零警告、格式及正常构建通过；新聊天附件4项、群草稿16项共20项通过（首条测试误填单数draft路径只运行4项，随后以真实路径补齐16项，不冒充首条全覆盖）。原57738及3个子进程正常Quit全退出；最新构建恢复后仍需一次原生Zoom才显示已加载界面，既有绘制／电脑工具差异未归因或修复。
  - 最终双模型报告复核：MiniMax4a13952f…read_file／deliver一次，原935B报告及SHA不变；DeepSeek3b9f00f5…read／edit／read／deliver，原名报告改为1101B客观结论，五笔／48.70／多计1.00仍正确，正式成果入口重新打开同一路径实际显示修订内容。两条均completed／零工具错误；这是明确反馈后的质量修订，保留DS首轮无依据判断，不计P12首轮质量通过。相对本项开始的586任务，仅新增一群、4条成员任务、CSV／2报告／原setup状态共4文件，590任务／0活跃；原34Bot／9群／9例行／21命令、210旧文件和3522旧消息头全部保持，quick_check=ok，最终源码哈希匹配。已恢复身份群@草稿、资料库、深色、220／360宽度。证据quality-review/1017AU-new-chat-cancel/{before,after-cancel,before-send,cancel-review,handoff-review,delivery-review,focus-source-sha,focus-quit-check,after-focus-models,final,review}.json及AU检查日志；右键重命名焦点、拖拽、真实输入法、网络失败及Windows不由本项覆盖。无commit／push。

- [x] ~~P05.1 实现持久队列、请求去重、Bot／线程串行、整体并发上限、优先级和取消。~~
  - [ ] 1018CT 已运行的群／非用户任务与私聊优先级。修复前源码确认nextQueued只对待办排序，同Bot仍running／waiting_user时不调度新私聊；Host／Runtime的steer与主模型抢占仅接直接用户／欢迎来源。Grok恢复源码send-turn-dispatch会打断同Bot群成员执行，group-chat-glue在未发送结果且原群轮次仍有效时最多续办3次；background-wakes对已显示通知最多重投一次。先用当前官方与本地真实样例核对，不从0.18源码推断0.71.2全部行为。需保留来源、职责、原群结果归属、停止与重启不重放；复核时原startAgentRun仅托管invoke，不能假称已提供完整托管resume。先核实原resume／checkpoint接口及当前边界，再用最小接线实现；不得将私聊内容注入群／例行提示词、直接开放同Bot两条并发执行链，或通过取消后重放原外部动作来掩盖差距。保留私聊现有steer、工具审批与原工作台行为。
    - 修复前的双模型复现：同一合成群的MM 1927f12c…与DS fe0c0f9d…各只执行一次提问并waiting_user；各自私聊5545c530…／e4554005…请求只答43，采样时已分别排队116.249／100.047秒，均无模型消息或工具。随后在两张原选择卡中分别明确选择结束收束测试，群完成后两条私聊才各以零工具回复43。这是Bot队列／执行接线缺口，不能归因于模型推理慢，也不能把这次人工收束当作已实现抢占。原897任务、全部38Bot／11群／11例行／29命令、268文件及5112旧消息头保持，最终901任务／0活跃；私聊标记及43未进入群，恢复BW-DS，未改字号或缩放。21项证据检查证明复现及数据保护，不是修复回归；证据quality-review/1018CT-inbound-priority/{blocked-task-windows,blocked,task-windows,after-explicit-group-end,group-messages,source-review,reproduction-review,restored-ui}.json及verify.py。
    - 当日[官方消息与协作说明](https://docs.x.ai/grok-bot/chat-and-collaboration)明确直接用户消息优先后台工作。当前安装版0.71.2的新建按钮／Cmd+N实际打开创建Bot对话框，本轮未成功进入官方群同题；已取消，不创建或改动官方Bot／群／例行，不据此声称0.71.2抢占实测通过。恢复源码的抢占／有界续办与文档作为目标依据，当前客户端完整实测仍保留。
    - 接线复核约束：先验证原invoke现有agent.stream(null, streamConfig)检查点续跑分支（已经用于原故障切换），不搬用会拒绝Bot所有者的桌面agent:resume IPC。只允许在已确认主模型边界让出，保留原任务／来源及精确checkpoint；由原Host仍按单Bot串行、用户优先调度，恢复沿原Runtime的工具／审批／完成门，不重发原用户任务、不重做已有外部动作。checkpoint来源、待执行节点、取消／删除／重启、原始任务与唯一回传都需有定向正反例后才接线，不能仅增加一个resume布尔值绕过生命周期。
    - [x] ~~1018CU 群任务等待输入时先处理同 Bot 私聊，再续办原群任务。~~ 参考 Grok `send-turn-dispatch.ts` 的私聊优先／同会话互斥与 `group-chat-glue.ts` 的被抢占后续办；执行仍复用原 `startAgentRun`、检查点与 `agent.stream(null, streamConfig)`。新增内部 `resumeCheckpointId` 仅供身份绑定的本地 Bot 群任务；主模型节点／精确 checkpoint／无待审批中断均须通过校验。原 Host 保存同一任务的 checkpoint 并重新排队，原图释放后才执行私聊；不新增用户消息，不把私聊注入群提示词，不开同 Bot 双图。仅忽略正在等待的提问，不取消工具或放行审批。无此内部选项时，原工作台入口保持原路径。
      - 真实 MiniMax-M2.7／DeepSeek-V4：原群任务 39b563b3…／edd35165…各执行一次带 `flag:wx` 的创建命令，停在提问卡；私聊 51d2646b…／758c1363…均零工具答43，原群随后仍等待真实选择。选择继续后，两根任务原ID完成，创建命令各一次、用户消息各一条；私聊标记未进群，nonce／count=1及两原文件SHA保持。MM以文件链接交付、DS另用 `bot_deliver_files`，两份均从群界面实际打开并核对 JSON，不将交付形式写成完全相同。
    - [x] ~~1018CV 已让出的群任务停止，保留独立私聊。~~ 最新构建中，双模型群根435d0742…／4e14a3ed…让出并排队，私聊dae12399…／e70dff1c…各停在独立提问卡。点击停止群聊工作后，两群根均cancelled、清除续跑标记且各一条群回执，私聊仍waiting_user；分别真实选择结束后完成。另覆盖取消最新待办私聊时仍须服务更早私聊的队列边界。
    - [x] ~~1018CW 正常退出重启后的待续群任务收束。~~ 双模型群根d16704d4…／ed5ad2a8…已queued且持有精确checkpoint，私聊9a87e8f4…／876c43fd…waiting_user。通过原生Quit退出，85737及全部三个子进程实际退出；退出先收束私聊，重启后两群根标记interrupted，各只生成一条“应用已重启”说明，未重投模型或外部动作。保留原检查点供核查，终态不具备自动续跑资格；这不代表强杀、断电或 Windows 验收。
      - CU／CV／CW独立56项证据检查通过：原901任务字段、38Bot／11群／11例行／29命令配置、268旧文件与5124旧消息头均保持；仅12条明确请求的任务根、2个合成JSON文件，最终913任务／0活跃。mask39字符、原资料群空输入保持（此前15字符实为占位文字），恢复BW-DS；本轮未改字号、缩放、全局样式或模型权限。源文件／构建／进程／实际工具回执与UI证据在quality-review/1018CU-group-private-yield；首轮构建前进程核对失败、随后停止构建及清理测试进程的记录保留，不把该次退出当正常退出验收。
      - 定向150项、node／web类型检查、原工作台入口／消息／workflow回归及构建通过。默认并发全量Vitest为70失败／4929通过；将30份失败spec限制相同并发2，在未改动HEAD及当前源码均为相同49项失败，其余21项未复现，不能宣称npm test全绿。生产改动定向lint无新增问题，Host测试原有3项lint保留。详见CT／CU日志及bounded-regression-comparison.json；Windows、所有来源的忙时抢占、长工具／审批中的及时响应、异常断电及当前官方客户端同题仍未完成，1018CT整体不划掉。
      - 证据归档：`1018CU-group-private-yield.tar.gz`，SHA-256 `65477e2ba557c7b3a5801f6a8d9ed731d6346b20a5fe3d5f98e536a767d37347`。本轮未commit／push。
    - [x] ~~1018CX／DA 群任务主模型真实生成中先回复私聊，再完成原长文。~~ MiniMax群根9df4ff53…已产生未完成模型消息后，被私聊c40dd5a2…让出；私聊零工具答43，原根从原checkpoint续办并交付2715字符、六节齐全及GROUP_DONE_1018CX。DeepSeek定向群根2d8290d9…在原生执行视图实际出现独特流式标题、仍正在处理且无结束标记时，立即发送已准备的私聊f79a7d31…；零工具答43后，原根续办并交付9283字符、六节及GROUP_DONE_1018DA。两者新私聊均先于群根终态完成，各根仅一条原始用户消息、一个群终态回执，私聊标记未进群。38项独立证据检查通过；原913任务、38Bot／11群／11例行／29命令、270文件及5174消息头保持，仅8条明确发送的任务根，最终921任务／0活跃。首条DeepSeek CX已先完成、CY的inflight断言未通过、CZ被既有合成草稿拦住，均保留且不计抢占通过；CY草稿仅通过原生selectText替换本轮合成文字，未触碰原mask39字符及资料群空输入（15字符为占位文字）。此为纯文字生成／恢复验证，不代替长程编程质量、所有UI或Windows验收。证据quality-review/1018CX-inflight-group-priority/{model-inflight-before-private,private-answered,da-dispatch,da-priority,task-windows,review,source-review,restored-ui}.json。
      - CX证据归档 `1018CX-inflight-group-priority.tar.gz`，SHA-256 `5d5c0b84722c2cc0a9fa63f3fc639d4e81ee3fa220eedca51bf85f85b043b835`。同线程冲突真实图用例、定向151项、node及定向lint通过；后续DB保护模块新增两项后为153项，node／定向lint通过，尚未接线或重建，不混为CX的实际模型验收。本轮无commit／push。
    - [ ] 1018DB 同私聊线程内的协作／例行任务优先级。源码核实非群任务由Store绑定bot.threadId；新的私聊会推进同一检查点历史。新增真实LangGraph用例确认旧model checkpoint在私聊完成后已失效，保留新的私聊历史；不能将群的旧分支恢复直接扩大到这些来源。参考Grok background-wakes已显示通知的有界续办及Hermes忙时输入／空闲唤醒，沿原CMB内部通知路径设计可信续办：使用最新已完成会话，或仍是原精确模型边界的状态；保留原任务、来源、回传归属及最多8个已验证文件引用，续办前复用原verifyBotDeliveryFiles核验。内部续办消息须保留可持久的来源边界并在Bots中隐藏，保留新私聊而不改写原用户消息；工具／审批未结束或检查点不安全时拒绝自动续办。继续使用单Bot物理租约、原审批及同一Runtime，不引入独立执行器／存储。可信选项continueBotTaskCheckpointId及本地托管身份／最新已完成会话／原精确模型节点的正反例已补，定向153项通过；上述153项为保护模块阶段记录；随后Host／Store／Adapter／IPC已接线，仍须真实双模型验证私聊历史保留、命令不重跑、文件交接、定时静默、取消及重启，不能据此认定此范围验收完成。早期保护模块说明见quality-review/1018DB-private-task-continuation/implementation-notes.json，最新接线说明及实测哈希见同目录implementation-final.json／built-sources-durable.json；1018CT整体继续不划掉。
      - [x] ~~DB接线自动化边界复核。~~ 185项定向与14项历史／消息引用／服务集成测试通过，真实LangGraph验证一次工具后私聊推进历史、再内部续办及后续回忆均保留新私聊，工具总次数仍为1；Store／Host覆盖三种来源让出、文件引用有界续存及终态清理、同群协作回执恢复、收件人隔离。发现原斜杠续办ID会被既有IPC消息查询拒绝，改用已支持的冒号命名空间，用户requestId仍拒绝该格式，未放宽IPC校验；静默投影按原任务关联多个续办片段，保留中间私聊及异常。node／web和原messages／workflow回归通过；BotConversationTools的1条lint错误及2条警告在未改动HEAD复现，单独记录，不宣称lint全绿。预览旧92392及三个子进程已正常退出，正在构建；真实双模型与Windows未验，不勾选DB／CT父项。日志quality-review/1018DB-private-task-continuation/{unit-wiring-third,retention-integration,node-wiring-third,web-wiring-second,messages-regression,workflow-regression,lint-wiring,lint-head-conversation-tools}.log，无commit／push。
      - [ ] DB首轮真实场景保留失败：MiniMax根d5e16106…委派时遗漏原要求的提问，DeepSeek协作b9ae4013…已完成创建／交付，因此不计DeepSeek抢占验收。MiniMax回执ad2ce94a…随后waiting_user，私聊8bcd6ee3…零工具先答43，原回执确实让出后续办，但模型因续办cue歧义绕过原真实选择条件，未计完整通过。另核实原CMB内部通知标记会同时从核心消息库和hydrate删去Human边界，首次构建没有续办ID落库，先前纯投影用例不能证明实际重启静默语义。修正仅可信private续办分支，复用现有cmb_visible_user_message存储短边界、Bots现有visibility投影隐藏Host专用ID，保留完整指令在原checkpoint；普通通知／工作台行为保持。续办cue明确原选择条件仍生效，忽略后须重新询问并等待，cue本身不能作为答案或完成授权。须重新构建并双模型复验来源落库、静默及真实等待，不把首轮局部43当作通过。证据ds-first-delegation.json、mm-reply-private-sent.json和ds-original-preview.txt。
      - [x] ~~DB3新上下文双模型协作的私聊让出与原件回传。~~ 原CMB内部执行入口还跳过核心消息库的用户写入点，第二轮短边界只进checkpoint、仍未进核心库；最终沿同一persistVisibleUserTranscriptMessage写入短边界，失败且无已存边界时拒绝续办，未添加新存储。第三版中MiniMax根a8fb1bc8…／DeepSeek根3457ff33…均先以flag:wx创建本人JSON并bot_deliver_files，停在真实提问；私聊f835e3a8…／c5dd2e35…各零工具先答43，原根保持原ID、原文件引用和检查点，重问Continue／End，实际选择Continue后才读回原件并完成。两根均有Host专用续办ID和“续办后台任务”短边界落核心库，CUA实屏内部cue及短边界均不可见。回执e3935ecf…／f13ca11f…各一次，接收方通过原工具导入并实际打开对应JSON，nonce／count=1／total=43正确；后续独立回忆5a840d51…／bb060390…零工具正确答cedarDB3／mapleDB3。采用两份新建合成身份隔离先前历史异常，原会话未清理或改模型；此通过不抵消旧DeepSeek长历史输出总结、遗漏步骤的失败，相关交付质量仍未达标，DB／CT父项及例行／重启／Windows仍不划掉。200项定向、node／web、构建与原桌面执行入口通过；原921任务／270文件／5194消息头的两轮26项不变性检查通过。证据db3-{mm,ds}-{before-private,private-sent}.json、db3-peer-final.json、db3-actors.json、db3-*-reasked-ui.txt、db3-*-copy-preview.txt和built-sources-durable.json，无commit／push。
        - DB3独立34项检查通过，按真实消息来源／续办边界划分执行片段，避免把中间私聊算入原任务；两任务均一次实际成功创建、一次忽略后一次submitted=Continue、原件与导入副本逐字节一致，独立私聊标记未出现在另一Bot线程。初版验收脚本误将响应状态写成answered，原CMB真实协议为submitted，已核对实际ToolMessage后修正，原错误报告保留于db3-peer-review-schema-mismatch.json；生产代码未为验收改协议。最终见db3-peer-review.json／verify-db3-peers.py。
      - [x] ~~R3双模型单次例行任务的私聊优先及静默收束。~~ 通过正式bot_schedule分别保存完整独立指令，两任务按实际UTC定时触发且各一次；DeepSeek根668b3f1c…／MiniMax根8e987ae5…先真实等待，分别让出私聊零工具答43，保留原根重新询问；真实选择Continue后仅read_file核对已有JSON，最终原回执仅BOT_ROUTINE_SILENT。核心库仍保留原来源、内部续办短边界和审计消息；实屏两个例行片段及静默标记均隐藏，中间私聊与43保留。独立31项检查通过，静默前后activity版本／attention／更新时间／43预览不变，无额外未读或重排，原942任务／280文件（含记忆）保持、无额外命令，最终948任务／0活跃。两新增合成例行已自然禁用，原11例行配置不动。MiniMax保存后的自然语言回复错误标注了时区偏移，但真实保存的UTC及触发正确；这项表述差异保留在交付质量待办，不能宣称全部定时体验已对齐。证据r3-{mm,ds}-{before-private,reasked}.json、r3-*-quiet-ui.txt、r3-activity-*.json、r3-final.json和r3-routine-review.json；正常重启后的静默投影及历史保留仍待验。
      - [x] ~~R3完成任务正常重启后的投影、历史和原数据。~~ 原生Quit确认89863及三个子进程实际退出，重启同一隔离配置；两Bot例行片段和内部续办短边界仍隐藏，中间私聊与43保留。真实DeepSeek／MiniMax分别零工具回忆oakR3DS／elmR3MM；原948任务字段保持，仅新增这两条明确回忆任务，没有重放已完成例行或协作。最终19项检查通过：原921任务、38Bot、11群／11例行／29命令、270旧文件及5194旧消息头均保持；2个新合成Bot和2个自然禁用的合成例行单列，最终950任务／0活跃。原mask39字符及资料群空输入（15字符为占位文字）通过UI核对保持，恢复本轮开始时的收件人核验-1013AP、空输入／关闭详情和搜索；草稿原文不写入证据。生产源码与实测构建哈希相同，最终定向200项及node／web、构建／原桌面入口通过；此前messages／workflow回归及存量全量测试／lint边界照实保留，未宣称全量绿。仍有Mac冷启动绘制与AX不同步，原生窗口调整后可继续，未加生产字体／缩放／重绘兜底。此项仅正常退出后的已完成任务，不代替活动中私有续办取消／重启、强杀／断电、通知与长工具、旧DeepSeek交付质量、Windows或整体UI／动画；DB／CT父项继续不划掉。证据quit-result-r3-restart.json、r3-*-restart-quiet-ui.txt、restart-recalls.json、final-review.json、restored-ui.json和final.json。
        - 本轮证据归档 `1018DB-private-task-continuation.tar.gz`，SHA-256 `183e65738fc88a5dff53555f17aaf9112a9246b658a014699c2413d2319c8802`。无commit／push，HEAD仍91554cbc7df0b78e37c48d31b72628c16662911a。
      - [x] ~~DB4活动中的私有续办取消／正常退出恢复。~~ 复用原私聊队列“撤回”、Host.cancel／recover、同一Runtime和幂等回执，已完成双模型协作／例行撤回、活动中正常Quit与重启、回执归属和正常文件交接验证。只复用两个既有合成身份及两份R3例行，保留原11份配置和用户草稿；修复取消后漏唤醒及回执错续私聊，本轮生产改动集中Host和Runtime适配消息封套。详见下列真实失败、修正与复验记录。本项仅覆盖macOS正常退出；强杀／断电／Windows、通知来源及长工具期间及时响应仍不由此推断完成。
        - [x] ~~DC修正版的双模型协作撤回复验。~~ 最新构建中，MiniMax根43102e71…与DeepSeek根8bbf4b81…各交付既有44B文件、进入真实选择卡，再让出给独立私聊c09d5e74…／775d9a4f…。从原队列撤回后，两根cancelled、清除续办检查点及文件引用；原发起Bot的唯一回执f798e7b7…／405f7f28…已完成时，目标私聊仍waiting_user，未消费选择或执行后续命令。随后才在各自私聊明确选End收束；没有续办消息、命令或取消标记文件，也未在停止回执中广告已撤销文件。29项独立证据核验通过，原950任务／40Bot／11群／13例行／29命令、280文件及5330消息头保持，最终962任务／零活跃。168项定向、node及构建通过；本轮生产修正仅原Host.cancel增加一次已有wake调用，没有新队列／定时器或原工作台接线变更。证据quality-review/1018DC-private-continuation-cancel-recover/{mm,ds}-fixed-{before-withdraw,withdrawn}.json、peer-fixed-final.json、peer-cancel-review.json、verify-cancel-peers.py及cancel-fix-build.json。首次冷启动电脑工具AX与截图不同步，经原生缩放窗口恢复输入，未改应用字号或缩放代码；例行撤回／活动中重启继续待验，未commit／push。
        - [x] ~~DC取消回执未唤醒的复现与最小修正。~~ 真实MiniMax协作根125ee444…已让出并保存1个已验证文件引用，独立私聊9181cc1c…waiting_user。点原队列“撤回”后根cancelled、清除检查点与引用，私聊仍等待，但停止回执留在原bot_reply_outbox、另一Bot未收到；直到真实结束私聊，旧构建才发出e52a9eb9…回执。补充独立Host回归先失败（receipt为undefined），确认cancel的queued分支只changed而未wake；仅追加原this.wake()，复用已有幂等发件箱和microtask合并，不新增队列／计时器，不改原Cmb Runtime／工作台。修正后168项Host／Adapter／历史／服务集成和node通过；本条保留复现时记录，修正版真实双模型结果见上一条，不把旧构建随私聊结束才发出的回执当作修复通过。证据quality-review/1018DC-private-continuation-cancel-recover/{mm-peer-before-withdraw,mm-peer-withdrawn,mm-peer-old-build-finished}.json、mm-peer-outbox-wait.json、mm-peer-outbox-after-private-end.json、withdraw-before-fix.log、withdraw-after-fix.log。
        - [x] ~~DC5双模型例行任务让出后的撤回。~~ 仅改期复用原两份R3合成例行，保留其ID／所属Bot／名称，不修改原11份例行。两根2adcb7d7…／9087d71c…均由真实schedule来源触发，各成功交付既有44B文件并停在选择卡；私聊e5c35395…／0a795635…到达后，两根保存checkpoint且queued，私聊各自waiting_user。从原队列撤回后，两根cancelled并清除续办标记，私聊仍waiting_user；随后分别真实选End完成。无续办、命令、取消标记文件或不该生成的协作回执；一次性例行按原逻辑自动停用。26项独立核验通过，原950任务／40Bot／11群／29命令／280文件和原11份例行保持，最终968任务／零活跃；本项没有新增生产改动。证据quality-review/1018DC-private-continuation-cancel-recover/routine-{before-withdraw,withdrawn,cancel-final,cancel-review}.json及verify-routine-cancel.py。活动中重启仍单独待验，未commit／push。
        - [x] ~~DC6活动中重启的回执任务边界修正。~~ 以下保留失败现场；修正版实际通过见DC8／DC9。DeepSeek协作根a78890c8…与MiniMax例行根48e0dbae…均已queued且保存checkpoint，独立私聊ef71ce46…／718b10dc…各waiting_user。正常Quit使52466及3个子进程全部退出；重启后两私聊及两根均interrupted，原动作未重放，协作只生成一条582a76b5…回执。但该回执的MiniMax又发出新的dc6_mm_private提问，错误恢复了无关中断私聊；不能把四个旧任务的正确终态当整项通过。原Runtime已为旧call_5a5de44e…写入cancelled ToolMessage，错误问题是新call_80dbeebd…，不是同一工具自动重放。已用原Stop停止该回执且未提交答案，原错误记录保留。证据quality-review/1018DC-private-continuation-cancel-recover/{before-active-quit,after-active-quit,after-active-restart,restart-old-build-stopped,active-quit-owned-processes,active-quit-result,restart-wrong-receipt-evidence}.json及restart-old-build-wrong-question-ui.txt。
          - DC7仅补系统提示的尝试未通过真实复验：MiniMax回执0f8e3157…仍新建dc7_mm_private问题，已停止且未提交答案；根与私聊终态、进程退出及文件保护本身正常。未生效的prompt.ts改动已完整撤回。进一步核实Grok agent-to-agent-messaging.ts的runAgentInboundWake先清除activeRequestPrompts、将source设为agent，并通过独占hidden轮次调用agent-messaging.ts的buildAgentInboundWakePrompt；后者在本轮消息说明发送者、异步非用户来源及需要行动／可静默。CMB本来每轮新建Runtime上下文，未添加第二套“当前请求”状态；沿其现有profileContinuationRequest的消息封套接线，只在协作结果（expectsReply=false）的本轮消息追加处理范围。保留原协作后续交付权限，不改直接用户、委派请求、例行和普通工作台输入。164项Prompt／Host／Adapter、node及格式通过；证据peer-source-comparison.json、dc7-{before-quit,after-quit,owned-processes,quit-result,failed-final,wrong-receipt-messages}.json、dc7-wrong-question-ui.txt及receipt-{scope,envelope}-tests.log。
          - [x] ~~DC8修正版的MiniMax回执不再重开旧问题。~~ DeepSeek协作根741fef35…与MiniMax例行根5af7a83b…各已让出，私聊a66f10fc…／ba93fa5d…各waiting_user。正常Quit使80442及3个子进程全部退出；同配置重启后四条旧任务均interrupted。唯一协作回执65438790…由MiniMax零工具报告任务中断，没有重开dc8_mm_private、发出新选择卡、命令或文件动作；例行无协作回执。43项独立核验通过，原950任务／40Bot／11群／29命令／原11例行／280文件及5330消息头保持，最终989任务／零活跃。证据dc8-{before-quit,after-quit,after-restart,owned-processes,quit-result,core-message-proof,restart-review}.json及verify-active-restart.py；反向DeepSeek回执及正常交付正例继续待验，不据此划掉DB4整体。
          - [x] ~~DC9反向DeepSeek回执及两来源重启收束。~~ MiniMax协作根2576612c…与DeepSeek例行根9211a28b…分别queued且保存checkpoint，独立私聊d41320d4…／569cd004…各waiting_user。正常Quit使86978及3个子进程全部退出；重启四个原任务均interrupted，唯一DeepSeek协作回执零工具完成，不恢复旧选择或外部动作。另43项核验通过，最终996任务／零活跃；与DC8合计覆盖两个模型分别作为协作／例行执行者和结果接收者。原950任务、40Bot／11群／29命令／原11例行、280文件及5330旧消息头保持。证据dc9-{before-quit,after-quit,after-restart,owned-processes,quit-result,core-message-proof,restart-review}.json。仅证明macOS正常Quit与同配置启动，不能替代强杀／断电／Windows。
          - [x] ~~DC10正常文件交接的本轮执行边界修正。~~ 以下保留严格失败；修正版DC11通过见下一条。DeepSeek回执efb05383…与MiniMax回执fa2e2bd0…都从Host验证的明确路径调用bot_deliver_files导入并交付44B副本，两份均从界面打开且nonce／count=1／total=43正确。不过MiniMax被委派根1797a934…未执行本条明确要求的新交付调用，直接声称已交付；Host对声明outputFiles的校验确实完成了交接，但不能据此称模型完全遵循方法要求。严格核验31／32，失败保留于positive-handoff-review.json，不放宽判据。参考Grok新agent消息的独立当前请求边界，仅在首次委派消息封套补本条实际回执要求；checkpoint续办不加入“新任务”提示，以免重做已有步骤；直接用户和例行不改。首个未加续办保护的构建未启动，补保护后重新构建才进入实际复验；无效的prompt.ts试验保持撤回。
          - [x] ~~DC11双模型正常交接与原数据保护收束。~~ 沿用相同身份、同一历史及同一既有文件复验，未用新上下文掩盖DC10失败。MiniMax委派根6782f55d…／DeepSeek根3e1f426f…都实际执行一次bot_deliver_files；对应结果接收者DeepSeek928d90a2…／MiniMax2bacfd01…各按Host的明确验证路径执行一次导入交付。六根任务completed，每轮只一次委派、一次接收方交付、一次发起方导入；无命令、提问或重复协作。副本均44B，与原件逐字节一致，从界面打开核对nonce／count=1／total=43，32项严格核验通过。164项定向、node、生产改动与Adapter测试lint零错误零警告、格式、构建及原desktop-agent-baseline通过；新增续办负例确认不会把旧checkpoint包装成新任务。最终15项保护核验通过：原950任务、40Bot／11群／29命令、原11例行、280文件（含记忆）及5330旧消息头保持；最终1008任务／零活跃，只新增4份明确交付的副本。39字符mask及15字符资料群原草稿逐值保持，恢复AP空输入、详情／搜索关闭。对照DB源码哈希，本轮仅Host／Adapter生产代码变化，原Runtime／Store／Renderer仍相同；本轮未改字号或样式，未commit／push。证据dc11-{before,handoff-final,handoff-review,core-message-proof}.json、final-review.json、restored-ui.json、assignment-guard-build.json、assignment-guard-tests.log与verify-positive-handoff.py。

        - 本项证据归档 `1018DC-private-continuation-cancel-recover.tar.gz`，SHA-256 `4e8bb5ae93e667631978594eb9327f71926f758cbae93af74fe0e56e6a597526`。包含143份证据／日志／当前源码快照及失败样本；无commit／push。
      - [x] ~~1018DD既有长上下文协作的原场景复核。~~ 旧DeepSeek根48ab5f2c…曾跳过步骤并输出大段历史摘要，失败记录保留。本轮沿Grok agent入站的独立当前请求边界、原CMB每轮RuntimeFactory／现有checkpoint与文本投影核对，使用原AP发送者（MiniMax-M2.7）及外观核验-1014A接收者（DeepSeek-v4-flash），保留原模型与长历史，仅更换合成文件名和nonce。协作根5f9322f3…实际依次execute一次wx创建、bot_deliver_files、request_user_input被私聊忽略、续办重新提问、真实Continue后read_file；独立私聊51bd1cd3…零工具回复43。唯一回执fad45f3f…由AP调用一次原交付工具导入，正式界面打开48字节JSON，nonce=DD_PEER_DS_1018/count=1/total=43，源与副本逐字节相同。没有重建、假定选择、转发私聊标记或历史摘要；未新增过滤器或修改公共Runtime。31项独立核验通过，原1008任务／40Bot／11群／13例行／29命令／284文件／5565消息头保持，两份原用户草稿保持，最终1012任务／零活跃。证据quality-review/1018DD-legacy-private-context/{before,after-continue,core-message-proof,review,draft-protection}.json及实际附件预览AX；此有限场景不证明所有长上下文任务或整体Grok体验已经达标。
        - 证据归档 `1018DD-legacy-private-context.tar.gz`，SHA-256 `59d804cf28670f4dff76140b3e54e08d391ffc17749a0aa971d603da8cc2d885`。无commit／push。
      - [x] ~~1018DE后台命令结果处理期间的私聊优先级（macOS）。~~ 两个既有合成Bot的原execute后台命令均已完成、唯一通知waiting_user时，独立私聊仍分别排队30.9／22.1秒，源码确认command通知被canDeferBotTask排除。旧两卡明确选End后才回复43，失败记录保留。参考Grok CompletionRevivals的结果唤醒／同Bot独占与私聊优先，核实原CMB的workflow成功后确认、coordinator投递后确认、command由Bot Store持久入队，未将三者混作一个领取协议。生产修正只在现有canDeferBotTask允许command通知；Host／Store／Adapter／Runtime无新增机制，workflow／coordinator仍不开放，未新增队列、定时器或并发图。
        - 修正版真实MiniMax通知8c0f0263…／DeepSeek通知7dfd00e9…先处于真实选择卡，私聊b63b4eea…／d01ad91e…均零工具先答43，原通知保留ID并从已有checkpoint续办、重新询问，真实Continue后才read_file／bot_deliver_files。各模型仅一次后台execute、忽略后重问一次、实际读回及交付一次，无轮询、命令重跑或默认选择。两份44B原JSON从界面打开核对nonce／count=1／total=43，创建后SHA不变。40项独立核验通过，原1012任务、40Bot／11群／13例行、29命令、286文件及5588消息头保持；最终1024任务／零活跃，只新增四份明确合成文件及四条已完成命令。两份原草稿逐值保持并返回AP空输入。修正前5个回归反例失败，修正后204项通过，node、lint及格式通过，正常Quit确认原4个进程全退出后构建并复测，源码／产物SHA一致；未commit／push。证据quality-review/1018DE-command-notification-priority/{blocked-proof,old-finished,fixed-private,fixed-final,fixed-core-message-proof,priority-review,final-protection}.json及界面／构建／测试日志。
        - 指令遵循差异单列交付质量：MiniMax把题中相对文件参数改为等价的本人工作区绝对路径，未严格保留“command原样”；执行范围、原件、一次执行和交付结果正确，不能据此称本题所有方法约束无差异。没有为合成命令新增公共harness特判。
        - 当前官方Grok的同题也已实际发送：先回复后台启动，约4分钟仍无约定选择卡；一次明确标记的只读状态追问后，模型报告原命令已成功但完成通知未到，随后发卡。此为界面与模型报告，未独立读取云端进程，不据此判定云端根因。该卡期间新私聊实答43，旧卡忽略后自动重新询问，与本地已复测的选择恢复行为一致；初始自动通知未成功的事实保留，不能把人工追问后的流程计成自动回传通过。官方合成对照只改其自身测试会话，没有修改用户真实Bot的配置或例行。
        - Grok真实Continue后已交付45B附件，原生预览实屏显示DE_GROK_1018／count=1／total=43；已关闭预览并通过原搜索恢复tibo会话、搜索／详情收起。完整对照与干预边界见grok-comparison.json和grok-file-preview.jpg。本项归档 `1018DE-command-notification-priority.tar.gz`，SHA-256 `3f2fdf06c03f29dde893a6232413e11b7147d59d6907a6031c02d6eb0fc9f7b1`；包含53份实测／源码快照／门槛日志。workflow／coordinator通知的忙时优先、长工具中的及时响应及Windows仍留在CT父项，本项通过不覆盖这些范围。
      - [x] ~~1018DF后台任务结果处理的私聊优先与原领取确认（macOS双模型）。~~ 先用原workflow的有界延时／工作区writeFile生成合成结果，父轮结束后由原通知进入真实提问，再发送独立私聊，核实当前阻塞及准确runId／startedAt／通知所属。Grok CompletionRevivals的独占结果唤醒和私聊优先作为使用目标；继续使用CMB原通知成功后markNotified与失败释放claim。仅在确有反例后最小适配：续办必须领取原任务结果，多个待通知结果不能错领，成功／取消／重启不得把旧结果误确认给新实例。不新增后台执行模式、通知存储或任务表；普通CMB与其他通知来源保持原路径。DF5正常续办交付、DG新交办／显式恢复、DH原通知End／Stop及重启边界均有真实双模型证据；coordinator与长工具另核查，CT及Windows不据此完成。
        - 原版真实MiniMax通知f6544d0f…waiting_user时，私聊83abf0c5…排队66.96秒，明确选End后才零工具答43。首次改版将startedAt贯通原调度器／Bot持久通知／可信Runtime领取，218项通过；原workflow门槛因旧源码断言仅允许owner字面量失败，已保留同一owner断言并追加可信实例过滤，重跑原完整门槛。
        - DF2升级复验发现兼容性失败：带startedAt的新请求ID绕过了两个旧通知的Stop回执，31d51b92…／8770dd62…意外重新进入模型并启动两条旧合成180秒命令。发现后立即正常Quit，exec退出0，独立检查应用及两Node进程消失、所有命令已终态、无活动任务，原292份文件均未变化，只有本轮两份明确DF2文件新增；两根DF2通知因此interrupted，本轮不能计作通过。失败回执和命令记录保留，不删除／重写历史。证据fixed-started.json、failed-upgrade-stopped.json、/tmp/cmb-1018DF-result-priority-preview.log。
        - 迁移修正仍复用原bot_exchange_records与bot_task_receipts：新实例入队前先检查同runId的旧格式回执，活动或已处理旧实例不得因升级重开；只有startedAt晚于旧回执终态才视为明确的新重试。已补实际SQLite的旧Stop、后来新实例及历史压缩后回执反例；未新增表、扫描磁盘、队列、定时器或绕过原通知确认。继续构建和真实双模型复验，未通过前DF保持未勾选。
        - 迁移版重启后任务／命令／文件数均未增加，原workflow完整门槛通过（两处源码契约断言已保留原owner与普通调用路径，并明确验证可信Bot实例过滤）；不能用本次无重播替代已处理旧回执的独立SQLite反例。DF3 DeepSeek通知95a030ea…被私聊打断后先零工具回复43，同ID续办重新提问，真实Continue后仅一次read_file与交付；界面打开JSON核对DF3_DS_1018／count=1／total=43，原wf_adc32947220a的notificationDelivered最终为true。
        - DF3 MiniMax新用户任务6d0b723e…却重新询问旧DF2选择，未启动本轮workflow；已从界面停止，记录保留。原消息与新tool_call_id证明这是模型将旧取消问题误作前置条件，不是同一工具调用重放。只补Bot私聊当前任务范围规则：新交办不被旧取消问题阻挡，用户明确续办则仍核对原结果并补问必要选择；未修改原普通Runtime或丢弃历史。新增正反向契约，修正前1项失败、修正后8文件232项通过，node／定向lint／格式及正常退出后构建通过；同历史双模型和明确续办实测继续，DF暂不勾选。证据mm-df3-wrong-question-evidence.json、ds-df3-opened-ui.txt、direct-request-{red,final-tests,node,build}.log与direct-request-tested-build.json。
        - DF4同历史反例仍失败：MiniMax5225c9ce…把DF2未回答项列为DF3／DF4的前置条件，已停止；上一版通用范围提示不能算有效修复。DeepSeek本轮正常启动原workflow；私聊验收输入两次未被工具观测到，随后现场出现Continue已回答，故本轮只保留实际回执，不计为私聊抢占通过。未把工具操作偏差或手动结束算成产品验收成功。
        - 继续核对Grok0.18的turn-runtime.ts:408–432／run-lifecycle.ts:235：每次新请求单独设置／结束清理activeRequestPrompts与source；widget-responses.ts:29–62区分skipped／dismissed未答卡，prompt-collector-glue.ts:361／414将这些卡作为前置上下文后再附当前用户消息，不能理解为清空全部旧问题或让新消息恢复全部旧任务。原CMB每轮Runtime已重建，没有同名活动请求缓存可照搬；下一轮仅明确“打断后重问”归属原任务的Host续办，并保留用户明确续办的例外，仍需同历史真实反例通过后才保留。未改普通CMB取消修复器、隐藏历史或按合成题ID拦截工具。
        - 未证明有效的Bot系统提示词与相应试验断言已全部撤回，prompt.ts／prompt.test.ts相对HEAD无差异；试验日志和失败记录保留。撤回后8文件230项、正常构建通过，当前实测版本源码／产物指纹见reverted-prompt-tested-build.json。未把未测试的替代提示保留到交付代码中。
        - [x] ~~DF5原workflow通知的私聊优先、原实例续办和原件交付（macOS双模型）。~~ 原Bot／模型／历史不变；本轮用户指令明确旧DF2／DF3／DF4停止，不能用此澄清后的通过声称DF3／DF4旧选择误恢复已修复。MiniMax通知e7d53027…（wf_4031458071a0）与DeepSeek通知f72ab91d…（wf_bd53efa64659）各被私聊忽略后，同ID从checkpoint续办并重新提问；私聊66c742ad…／8c73ed50…均零工具先答43。真实Continue后各一次read_file／bot_deliver_files，两份44B原JSON从界面打开，nonce分别DF5_MM_1018／DF5_DS_1018，count=1／total=43，生成后SHA不变。原workflow按准确runId／startedAt最终notificationDelivered=true；每轮仅一次原样workflow脚本、无轮询、命令、默认选择或私聊标记转发。40项独立核验通过，原1025任务、41Bot／11群／13例行／33命令、291文件及5639消息头保持；最终1047任务／零活跃，新增的两条命令仅为已记录的DF2失败试验且均cancelled。首次oracle将整个命令集合与原33条作等值比较而误报38/39，原报告保留，已改为逐条保护原命令并独立限制仅有上述两条已取消新增，不撤销DF2失败。39字符原私聊草稿保持；群输入为空，15字符为占位文字，AP恢复空输入；Grok通过原搜索恢复tibo会话，未发送消息或改例行。证据df5-{started,private,after-continue,core-mm,core-ds,review}.json、双模型实际提问／交付／打开原件AX及final-draft-protection.json；无commit／push。
        - [x] ~~DF原剩余边界已由DG／DH补验。~~ 旧中断问题不阻挡新交办及明确用户续办的否定路径见DG；同实例End／Stop后的原通知确认与重启防重见DH。CT的其他来源、长工具和跨平台仍未完成。
          - 下一步先补实际状态事实，不继续堆通用提示：原services/user-input.ts在abort时拒绝等待，原malformed-tool-call-recovery.ts对缺失ToolMessage补统一的“因新消息取消”；Bot控制库虽已记录cancelled／interrupted，这份终态没有进入下一轮模型上下文。参考Grok widget-responses.ts从真实widget状态提供未答上下文的做法，仅在新的Bot私聊用户轮次读取同Bot／同thread最近四条停止回执，附有界预览和来源标识作为事实；恢复原任务和后台通知不注入此私聊提示。使用现有bot_tasks／原extraSystemPrompt，不改公共取消器、工具结果历史、数据库结构或队列，不清空上下文。先做隔离／限量／明确续办的正反例，再用原MiniMax失败历史与DeepSeek复验；无效即撤回。
          - 1018DG候选实现已接通：Store从现有控制表按同Bot／thread取最近四条cancelled／interrupted回执，每条预览最多240个Unicode字符；保留workflow原key／startedAt识别实例。只在新私聊用户轮次通过原extraSystemPrompt注入真实状态，明确未作选择、旧停止任务不作新请求的前置条件、显式续办仍须核对原结果和补问；预览仅作引用资料。群／Bot回执／例行／后台续办／创建问候均不读取或注入私聊停止信息。实际SQLite隔离、同时间戳排序、数量／预览限制及无状态变更，以及Adapter正反向接线共6文件187项通过；node、定向lint、正常退出后的构建与17份源码／产物／测试指纹通过。Grok提供widget事实上下文参考；另核对Hermes run_agent.py的clear_interrupt，CMB原Runtime已每轮重建，本处沿用原生命周期，不引入Python运行环境或第二套运行标志。证据quality-review/1018DG-stopped-task-context/{tests,node,lint,build}.log、tested-build.json及candidate-sources；真实模型验收尚未完成，不计为修复通过。
          - 旧构建DG0通知a43d61d6…／799b9f95…都经界面真实Stop后，新的普通文件任务DG1（MiniMax2b268a6e…／DeepSeek9d6ac2f9…）均正确写入／读回／交付，没有重问；这说明正常Stop路径并非每次失败。此前DF3／DF4的新workflow误恢复旧应用中断问题仍为真实反例。原拟追加DG2旧包对照时，输入观测滞后导致草稿未发送，控制库确认没有DG2任务；重启后能看到本轮合成草稿，故不能把未观察到输入直接诊断为产品未接收或用户干扰。当前修正版实屏仍待完成；没有为电脑工具观测问题新增生产缩放／重绘补丁。证据old-{ready,outcome,no-input,dg2-started}.json及旧包界面／trace。
          - [x] ~~1018DG双模型新交办边界与显式续办否定路径（macOS）。~~ 沿用DF3／DF4原Bot、模型与失败历史，DG3请求未带“旧任务停止”的用户澄清；MiniMax31cc4d31…／DeepSeek78ebe43a…均只调用一次原样workflow，直接询问本轮DG3，没有先恢复旧卡。两通知3db488f2…／aa5f769f…等待时正常Quit，应用及全部子进程退出、两通知interrupted；同构建重启没有新增任务、命令或文件。随后独立DG4文件交办8a273cb4…／9affd581…均仅write_file／read_file／bot_deliver_files，两个11B附件从界面打开核对。明确要求恢复DG3后，两模型各只重新提问，实际选End后结束，无读取、交付、重跑脚本或默认选择；原DG3文件nonce／count=1／total=43及SHA保持。40项独立核验通过，原1053任务、41Bot／11群／13例行／35命令、302文件／记忆与5769旧消息头保持，最终1061任务／零活跃，17份已测试源码／产物指纹无变化。证据quality-review/1018DG-stopped-task-context/{dg3-awaiting,dg3-after-quit,dg3-after-restart,dg4-completed,dg5-ended,dg-review}.json、verify-dg.py及实际选择卡／附件预览AX；未commit／push。
            - 范围说明：DG5是新的用户显式续办，未将原interrupted通知伪记为已确认；原通知自身的End／Stop确认仍由DF后续实测。DeepSeek在DG4附言仍将旧卡描述为“被新消息打断”，本轮不能证明中断原因的措辞完全准确。重启后电脑工具再次观测滞后，原生缩放窗口恢复后仅校正本轮自有合成草稿并核对全文再发送，没有替换用户草稿、修改字号或新增生产重绘代码。
          - [x] ~~1018DH原workflow通知的End／Stop及重启防重（macOS双模型）。~~ 继续使用原两Bot及同一已测构建，无新增生产代码。DH1真实通知9795076b…／bca1b2c3…各实际选择End，只结束、不读或交付；准确实例wf_57b141343b46／wf_7bb02beb3149最终notificationDelivered=true。DH2下一份通知82b867ad…／2dd96a9f…各实际点Stop，均cancelled，原wf_83e7e1f8b2f3／wf_05f5524f3d5b没有伪记成功确认。正常Quit后应用／子进程全部退出，同配置启动没有新增任务、命令、文件或重开选择卡；DH3新私聊两模型各零工具答43。每题只一次原样workflow及一次本题提问，无agent、命令、读取、交付或重复动作。55项证据核验通过，原1061任务、41Bot／11群／13例行／35命令、306文件与5805旧消息头保持，最终1071任务／零活跃；39字符原私聊草稿保持；群输入为空，15字符为占位文字，恢复AP空输入。17份源码／构建指纹无变化，无commit／push。
            - 官方Grok0.71.2原CN合成会话也实际重新发出Continue／End选择卡，选择End后回复已停止、未读取或交付；该项为实屏与模型报告，无云端文件系统独立证据，不当作原workflow领取协议的证明。已通过原搜索恢复tibo会话，未改真实Bot配置或例行。证据quality-review/1018DH-workflow-end-stop/{dh1-ended,dh2-stopped,after-quit,after-restart,final,review,projected-answers,draft-protection}.json、verify-dh.py、两模型实际选择／Stop AX及官方grok-{before-end,ended,restored}.txt。
            - 初次核验54／55的原报告保留：MiniMax原始content含`<think>`后才是43，直接拿原始content比较可见正文导致断言失败。随后调用产品已有splitBotInlineReasoning导出实际显示正文，与实屏43相符；未修改模型输出、生产投影或放宽任务动作判据。普通工作台、coordinator、长工具、强杀／断电与Windows仍按原独立条目验收。
      - [ ] 1019DJ长工具期间的非用户任务与私聊优先：先在原两Bot／真实模型中做有界、无文件的协作长命令样例，核实实际工具开始与私聊接收时间、原进程及回执归属。当前原CMB在直接私聊steer时可调用LocalSandbox.yieldForegroundCommands；Bot协作／例行目前只在模型节点让出，且为保护回传／静默归属未启用后台命令接线，不能直接开放该开关或宣称所有长工具均已对齐。参考Hermes前台命令转后台的同进程语义及Grok独占请求／独立来源边界，继续复用现有Runtime、命令生命周期和Host队列；先复现再决定最小适配，不新建执行器、进程管理器、队列或轮询，不把私聊注入同事任务、不提前发出虚假完成回执。首次有界样例先核实，不由此前等待选择卡的通过推断本项完成。
        - 1019DJ 首次真实复现：MM 仅交办一次，DS 实际执行一个 60 秒前台 Node 命令（PID 4201）；执行期间 17:30:12.718 UTC 接收独立私聊，先保持 queued，原命令工具回执 17:30:45.459 到达后，17:30:48.752 私聊才完成，等待约 36 秒。命令只执行一次，原协作最终正确回传 DJ_DS_DONE，私聊不在对方回执中；此轮仅证明忙时响应缺口，不是修复通过。当前最小适配复用原前台移交、Bot命令回执和检查点续办；为原任务保留终态结果，不提前结算协作／例行，不新增执行器或轮询。242 项定向测试已通过，真实双模型、取消／重启及普通入口回归仍须完成，本项暂不划掉。证据 quality-review/1019DJ-long-command-priority/。
        - [x] ~~1019DJ 单个协作前台命令期间私聊及时响应（macOS 双模型）。~~ 保留原 startAgentRun／LocalSandbox、审批、物理进程和命令回执；仅增加可信前台移交回调及原命令表内的原任务结果，显式后台命令策略不变。DJ2 的 DS／MM 分别约 3.0／9.7 秒回复独立私聊 43，此时原 PID 7387／8792 仍在；两条 45 秒命令各执行一次、退出 0，真实 stdout 归原请求方，未转发私聊标记。原协作任务在结果到达前保持待办，不提前用“已启动”结算，也不另起通知任务。单条前台命令样本通过不代表所有工具／并发批次都能及时让出。
        - [x] ~~1019DJ 撤回时等待原进程停止，并回传实际执行事实。~~ DJ3 真实复现了“命令已执行后被停止，MM 却说未执行”的交付误报；最初停止事实又出现在侧栏摘要，均未作为最终交付。最终沿原协作 outbox 附带原进程终态，不把内部 JSON 写成用户侧栏摘要或伪造模型回复；Host 等物理 cleanup 与回执后再结算，重复撤回幂等，只取消原任务绑定的命令，不影响新私聊。DJ4-DS／DJ5-MM 的真实 PID 停止、退出码 130、准确回传、私聊继续均通过；DJ4-MM 的撤回尝试发晚、命令自然完成，单列保留，不算取消通过。245 项定向测试包含同线程精确取消、旧通知／显式后台语义、暂停结果超过 200 条历史清理仍保留、终态清理、回执早于 defer、异常／重启及来源栅栏；node 类型检查、定向 lint、原 workflow／消息排队／桌面入口和正常构建通过，未宣称全量测试或 Windows 通过。
        - [x] ~~1019DJ 运行中正常退出／重启防重复与旧数据保护（macOS 双模型）。~~ DJ6 两条原命令 PID 36322／36545 在 Quit 前都存活、已移交，正常退出后两个进程及应用子进程全部消失；原结果记录 cancelled，重启后原任务 interrupted，每项仅一条协作回传，无新 execute 或旧任务重放。重启后的两条独立私聊均零工具回复 43。31/31 实测／保全断言通过：原 1092 任务、48 Bot、11 群、13 例行、35 命令、299 文件和 5902 旧消息头全部保留；只新增 42 条明确合成任务及 9 个移交回执，最终 1134 任务／0 活跃。原私聊草稿保持、群占位文字并非草稿；持久真实配置路径下旧 /private/tmp 绝对路径 DD 附件实点打开，正式模型配置未修改。首版核验 26/28 的两处失败源于验收额外要求终态原始 checkpoint 字段为 null；原 taskCheckpoint 已按终态拒绝读取且无真实重跑，故保留旧报告／理由，不为该额外要求改生产代码。构建与源码哈希一致，证据 verification.json／tested-build.json。
        - 官方 Grok 0.71.2 的首次 45 秒协作任务成功，但私聊发晚，不计重叠对照通过；第二次 90 秒任务中先回复私聊 43，随后在真实交流面板回传“前台运行被中断、进程及 stdout 不在、未重试”。这是客户端／模型本次可见结果，未直接检查远端进程，不能外推官方全部版本或称其所有命令都会中断；本地同进程保留与准确失败回传优先，不复制此失败行为。官方已恢复 Bot“1”的原未作答问题，未操作其选项。
        - [x] ~~1019DM 例行前台命令的私聊优先与静默收尾（macOS真实双模型）。~~ 复用同一最终构建，没有新增生产代码。由真实 MiniMax／DeepSeek 各按完整独立指令调用一次原 bot_schedule，创建两个同一时刻的 once 合成例行；原 13 份配置全部保持。触发后各只执行一个 45 秒 Node 命令，原 PID 54743／54961 正在运行时分别发送独立私聊；DS／MM 约 2.845／11.337 秒零工具回复 43，两个 PID 当时仍在，例行保持原任务等待。真实命令退出 0 后，两个原例行各自续办，最终可见正文均严格为 BOT_ROUTINE_SILENT，聊天保留私聊 43、无残留待办或独立命令通知；两份 once 配置自然禁用，不修改其他例行。24/24 实测与保全检查通过：原 1134 任务、44 命令、48 Bot、11 群、299 文件和 6024 消息头不变，仅新增 6 条明确任务、2 个命令回执及2份一次性配置，最终 1140 任务／0活跃。源码和产物哈希仍与DJ实测构建一致。参考原Grok upgrade-recreate-resume.ts对automation／background-revival继续保留静默结果归属的规则；不移植SendMessage协议。证据 quality-review/1019DM-routine-command-priority/verification.json。此项不代表后台OS通知、Windows或所有任务类别均已验收。
        - [x] ~~1019DN 同轮多条前台命令的收件边界与实际结果归属（macOS）。~~ 原 DeepSeek 一次返回两个 execute 时，第一条已让出、第二条仍阻挡私聊约23.302秒，保留真实反例。继续复用 LocalSandbox 同进程移交，只在可信 Bot 当前租约的输入仍待处理时，对同一 AbortSignal 下稍后进入的命令移交；输入已消费／撤回、不同信号或判定异常时不移交，不增加队列、轮询或执行器。参考 Hermes environments/base.py 的 consume_yield／yield_handler 与 interrupt.py，沿用原 CMB 审批和进程托管。新版 DeepSeek 两条同批命令确实同时存活时，约2.774秒先答私聊43，随后两份真实 stdout 各归原协作一次；这证明该模型实际生成的双调用路径，不冒充 MiniMax 同批通过。
        - [x] ~~1019DN 移交成功后的输入撤回边界及最终双模型回归。~~ 原任务必须等实际终态再收尾；命令回执保存成功后，即使新私聊随后撤回，原任务仍按原结果分支等待／续办，保存失败则继续前台等待，不丢结果或先发完成。新增正反例先红后绿，8文件252项、node检查、定向lint和正常构建通过；原 workflow、桌面入口及消息排队回归通过。最终构建 MM DN4／DS DN5 分别约11.614／2.565秒零工具答43，早于各原命令结束，命令各只执行一次且正确回传；DN4-DS私聊发送晚于命令结束，单列保留、不计忙时通过。28/28证据与保全核验通过：原1140任务、46命令、48Bot、11群、15例行、299文件与6046消息头保持；仅新增34条明确合成任务及8份移交回执，最终1174任务／0活跃，源码与实测产物哈希一致。证据 quality-review/1019DN-command-batch-priority/verification.json、tested-build.json。
        - DN交付质量反例仍保留：DN2 MiniMax只实际执行A，却推测出B的PID和stdout；两个聊天中均已明确撤回错误结论，没有重写历史或补执行冒充原通过。Bot续办提示仅补充“部分回执不证明全部步骤完成，每项结果须来自真实工具或Host回执”；不改公共完成性校验或安全策略。随后DN3两模型都实际执行A、B并交付四个准确标记，B未被已消费输入错误移交；但DN3允许顺序执行，不能证明此前严格同批MiniMax反例已通过，更不能保证消除全部虚构。原任务需求与工具调用保留，未检查原始provider SSE，不把原因全归模型或Harness。
        - [ ] DJ 仍待完成：等待审批／其他长工具的及时响应、强杀／断电与 Windows，以及上述严格同批 MiniMax 交付反例。DJ6 的 DS 虽正确回传对方的真实取消结果，但又补充了另一条本地任务“无终态回执”的说明，而 Host 已有该任务停止回执；未发生额外工具或跨 Bot 转发私聊，但交付措辞与来源边界仍需观察，不能把单次 43 或恢复通过等同全部效果达标。CT／DJ 父项继续不划掉。

  - `host.test.ts` 已验证幂等与冲突拒绝、同时间戳顺序、用户任务优先、跨 Bot 并行、单 Bot 串行、取消等待 Runtime 清理、租约唤醒无轮询；真实群聊与重启仍由 P12／P10 单独验收。
  - 2026-10-14：核对 Grok 0.18 重构源码 `run-scheduler.ts` 的用户／Agent／后台队列，以及用户队列内私聊先于群成员的规则；修正原 Store 查询为私聊用户、群任务、Bot 协作、后台任务四级顺序，同级保留 `created_at,rowid` FIFO。Host／历史保留 49 项回归、node 类型检查通过。官方 0.70.2 忙时新消息的抢占与恢复行为正在实测；此处只验证待执行队列顺序，不代表当前执行任务已实现同样抢占。
- [x] ~~P05.2 实现可信身份绑定的 Bot 通信工具、回执与回复关联；防自发循环及无限互相唤醒。~~
  - `host.test.ts` 验证可信发件任务绑定、异步回执去重、禁止自投递、4 层／24 次协作上限，以及停止后不再被滞留回执唤醒；群内交办及回执限定当前群成员并留在群线程。
- [x] ~~P05.3 实现群创建、成员管理、定向交办、共享时间线与成员结果展示。~~
  - 正式隔离界面与 MiniMax 已验证建群、选择接收人、群内一次交办及自动汇总；移出成员后不能再选为交办对象，历史消息保留。
  - [ ] 当前官方群结果后的自动讨论续核（1019DV）：只@一位成员的文件任务，官方另一成员在首份报告后主动指出原CSV缺失，随后原成员补附；本地目前只执行明确收件人。先复现并核对当前官方触发／停止规则、0.18重建GroupChatOrchestrator受限轮次／pass与Hermes已有组聊实现，再决定如何复用原Host队列、群历史和权限；不能直接引入无界Bot互相唤醒，也不能将旧版单成员样本当作当前全部群协作已对齐。
    - [ ] 1019EU 用户实际群问候重复（优先于ET确认框）。用户在新三成员群只发一条“你们好”，控制库确认3条首轮任务后又执行5条discussion、各有唯一持久结果，不是同一消息重复渲染。该自动讨论接线源于2026-10-19 09:27的b22bff091，本轮ES未新增；此前接力／取消等局部通过不能覆盖自然收敛，原失败现场完整保留。先复核原CMB唯一Runtime／Host与现有pass投影，再对照当前官方同一句三成员问候及Grok group-chat／Hermes group-round-prompt参与规则，确定最小修正后改代码。不得用问候关键词分类器、重复文本过滤、隐藏真实消息或关闭所有有效讨论掩盖问题；需真实MiniMax／DeepSeek验证普通问候停止、已有答案不再确认，以及正常纠错／缺少文件的接力仍能继续，源码diff与原功能边界复核后才能划掉。证据quality-review/1019EU-repeat-greetings/。当前官方0.71.2三成员同句实屏已回复并自然结束，只有各一次问候；云端模型及内部轮次不可见。候选修正仅将原discussion参与规则合并为一个常量，并按Grok buildGroupTurnPrompt／Hermes buildGroupChatTurnPrompt把规则附到真实轮次数据后；明确问候／重复介绍／索取新任务不属于新贡献，保留具体纠错、缺少的原请求交付和未解阻碍。不改Store轮次、队列、Runtime、权限、存储或界面过滤。新增回归先红后绿、123项相关回归及node检查通过，首轮真实三成员问候未重复介绍，但MiniMax返回裸pass，被本地只接受括号形式的既有解析误当正文，仍产生额外轮次；原始回执与失败保留。补核Grok isPassContent后，仅在原isBotGroupPass入口兼容完整pass控制标记的括号／大小写／句末句号形式，Store已有discussion来源约束不变；普通直接回答及带真实正文均保留，两个新增变体回归先红。问候修正后真实三位各答一次、两条可选复核pass并自然停止；但C1同伴已纠正后MM又复述确认，C2交换角色时MM沿用了旧收件人说明且贴出草稿，均未计通过。官方C1实屏两条即结束。补核Grok每轮绑定member.name与Hermes viewer后，在原runtime-adapter的discussion前缀绑定本轮实际Bot ID／当前名称，参与规则明确已有纠正不再作为完成总结复述；入队时绑定身份的候选已在diff复核时撤回，避免新增Store接线及排队后名称过期，Store与本项基线逐字相同。没有新增状态、查询、迁移或执行机制。后续C1R已两条结束，但C2R中MM把身份“复核者”误解为仅评价前位是否遵从指令，未执行尚欠的同伴校对；撤掉该表述与“首轮已完成”的框架，沿Grok／Hermes改为下一位群参与者继续未完原请求。C1P又暴露直接@的新请求被MM答成pass（仍可见，没有误隐藏），因此在原adapter的group分支末尾复用本轮origin与可信身份明确直接用户请求，避免复用历史讨论协议；不增加重试器／过滤／状态。各原始失败保留，当前候选仍在真实双模型正反例复验，不能计为修复完成。
    - [ ] 1019EV 近期feat／fix退化复核（用户明确要求，EU闭环后优先于ET及新功能）。以昨日91554cbc7至今日三个提交650c6ba30／7d97a7fdf／b22bff091及当前未提交diff为范围：先列出实际影响接口与原CMB边界，核对群创建与有界讨论、消息来源／成员身份、群问题历史／输入作答、停止与插话续跑、文件交付、普通线程Runtime和权限守卫；结合已有真实失败补反例，重跑有关回归并使用实际MiniMax／DeepSeek验证关键正反路径。不得以关闭讨论、丢弃任务、隐藏真实内容或降低文件／任务验收要求使测试变绿；发现失败先处理，不把编译通过写成体验通过。源码复核后补反例发现Host.sendGroup在Store判旧消息重送fresh=false后仍取消较新discussion，已先红复现queued误变cancelled；复用已有fresh布尔保护取消，只改一个谓词，不新增状态。需同时保持真正新消息的原停止路径及双模型交付。首批原有相关回归67文件／820项通过，覆盖Bot、共享契约、前端Bot投影、原前台进程移交、后台通知、用户选择、工作流归属与文件预览；该结果不代表实际模型交付或所有普通线程已通过，最新来源提示修正仍需补验。普通聊天补充117项通过；首轮8个错误系SSR夹具缺回复栏默认值，昨日源码同样可复现解析失败，最终仅补两个夹具值、断言和生产ChatContainer未变，范围过滤尝试已撤回。真实F1／F2双向文件接力四附件已正式打开并独立校验原始行、字节和11.33／74.13合计，未重复附报告。另据这两轮实屏与持久mentions_json确认多行用户消息的有效@前缀因后文Markdown归一化被整段拒绝；两项红回归已复现，仅在原remarkBotMentions按文本节点一次线性校验不变前缀，位置改变后的同名仍不绑定，不改路由或普通Markdown；等待新构建实屏复验。原失败及限制保留，全部证据落在quality-review，未完成不勾选。
      - 进一步沿Grok group-chat-glue → GroupChatOrchestrator → buildGroupTurnPrompt → SendMessage及host-runner-composition复核，纠正此前“提及只选首轮”的不准确描述：该源码每轮都重新resolveResponders，本地并未实现相同选择方式；source的消息预算与本地任务预算也不同，当前仅列差异，不无依据扩展调度。最新构建新三成员群问候只有各一次回复、后续pass收敛；新双成员群C2T／C1T交换MiniMax与DeepSeek后，均原样交草稿、同伴纠正45／47并pass结束；官方C2T同样两条收尾。自动化相关79文件／940项通过仅作限定回归。新增实际编程L1首位MiniMax零工具却声称三文件与自测完成，独立查目录不存在；DeepSeek随后反复扩大检索，已从原生界面停止、保留失败，未计通过。原完成性门仅检查协议及待办，不是语义真实性校验，不能用它宣称任务交付达标；正在对照同模型原生线程及官方实际附件。调用链SHA、差异／撤回尝试和L1失败见1019EV/{grok-source-call-chain-review,cli-first-failure}.json；不新增语义过滤器、自动重试执行链或另套验收状态。
      - 上下文顺序候选仅重排原请求／旧资料，238项回归、node与构建通过，但真实L2仍发生首位零工具虚报；已将Store／adapter逐字恢复到试验前，仅移除候选专属顺序断言，红绿与失败保留。不能把unit通过当成修复，也不累积该无效改动。现有有界群讨论随后由DS报告真实缺失、MM开始实际写文件，仍属失败后的恢复，不改写首轮判定。原生MM同题实际生成三文件，自测24项通过但独立38项仅35通过（前导零及末尾--），官方实际sum.mjs独立38项通过、首轮只交一份附件；发出用户补交后两位各补两份，产生重复附件，不能把官方全部交付过程视为无缺陷。Grok发送义务判定与有限空回复恢复只检查成功SendMessage回执／协议，不验证全部代码语义或需求覆盖；本地不因此新增语义判断／重试体系。
      - L1／L2失败checkpoint均仍保留，已只读备份并按原增量快照链还原：当轮分别8／10条消息，最后AIMessageChunk的tool_calls／tool_call_chunks／invalid_tool_calls均为空，finish_reason=stop；图只经过模型与原完成性／待办检查，没有工具节点。隔离预览的旧Trace加密密钥读取失败，原两轮完整API请求没有落盘，不能把checkpoint冒充原始HTTP响应。用独立Trace目录恢复当前预览的原加密记录，旧Trace／密钥和正式配置不动；未降低加密或改公共Runtime。原CMB完成门的协议边界、Grok明确SendMessage与Hermes实际群参与规则再次沿源码核对，不据此宣称官方也复现过零工具虚报。
      - L3临时网络观察放在仓库外，仅捕获首个匹配合成请求的body及原始SSE，不记录认证头、不改返回响应：真实请求提供20个工具，含read_file／write_file／execute，tool_choice未被强制关闭；首个原始响应finish_reason=tool_calls且有write_file，原Runtime真实执行。该临时NODE_OPTIONS钩子被命令子进程继承并输出诊断行，污染本轮自测环境；已正常退出该进程、无钩子重启，完整保留反例，不能把L3当作干净首轮交付通过。正常环境中的L3最终文件独立40／40、自测24／24，三个附件已从原生界面打开；但自测仍trim()，与DS及README的“逐字节”声明矛盾，正在通过真实群反馈修订。L2反馈修订后也已独立40／40、自测33／33及README十条命令实跑，通过仅代表反馈后的产物，不代表虚报根因已修复。
      - 进一步用L1 checkpoint的7条原始输入消息（与L3真实API请求前缀逐条一致）及当前同构建系统块／工具定义做单次模型响应对照：保留历史、只留当前请求、只改开场提示，各2次，6次均返回结构化ls／execute调用，没有执行这些诊断调用。它不是已丢失的历史HTTP请求逐字回放，也不是完整任务验收；不足以证明旧上下文或某句提示是根因，未将候选提示改入产品。首次Python诊断因证书链失败，失败记录保留；改用Node原TLS验证路径取得响应，没有关闭证书校验。证据1019EV/{false-completion-checkpoints.sqlite,false-completion-checkpoint-analysis.json,wire-capture-l3,checkpoint-model-replays,corrected-cli-40.json,corrected-cli-readme.json,wire-l3-cli-40.json}。本轮仅增加排查／验收证据；EU／EV和编程首轮质量仍不勾选。
      - [ ] 1019EW 任务临时文件的范围与自测真实性。L3后续DS已实际去掉trim，37项自测、独立40项通过，但execute原始参数确认仍向/tmp/o、/tmp/er、/tmp/x、/tmp/mut等目录外路径写入并清理变异副本，违反用户本题范围；不得把最终产物正确算作整轮通过，不擅自清理或声称还原这些路径的旧内容。先核对原LocalSandbox的cwd／工作区守卫与Grok system-prompt.ts:160、248的scratch space／任务范围，确认cwd不能作为任意Shell路径的硬隔离。候选只在Bot提示加一段：用户的目录限制也涵盖临时文件、测试副本、输出重定向与清理；需要临时工作时在获准任务目录内创建唯一子目录，明确授权的外部路径仍可用。不改公共Runtime、执行器、审批、权限或增加路径推断器；三个来源的提示契约先红，随后需MiniMax／DeepSeek真实正反例和实际diff核对，有效后再勾选。零工具虚报的根因与首轮质量仍单列未解决。
        - 候选129项回归、node／lint／构建通过，但真实双模型未通过整体要求：MM的9次工具调用都在本题目录及单独授权只读文件内，正常／变异probe分别0／1且四附件真实交付；却只回读了四份中的main.mjs。DS实际回读四份、严格probe及附件正确，但仍重定向到/tmp/m.out、m.err、t.out、t.err。因此提示候选无效，已从prompt.ts撤回，三个候选专属契约也移除；不继续叠加规则、不将局部正确当作修复。候选源码及精确原任务／工具回执保留于1019EV/scratch-scope-trial-failed.json、scratch-scope-withdrawn/，MM独立4项正反例通过仅为产物证据；当前EW继续未完成。
        - 撤回已落实到运行预览：正常Quit并确认全部预览进程退出后，原提示源码／测试逐字恢复，126项相关回归与node检查、构建通过；主进程产物SHA恢复为eb885d08…d8896，无NODE_OPTIONS钩子重启原隔离配置。DS四项独立正常／变异运行也通过，但不消除其目录越界反例；EW与零工具虚报继续未完成。证据1019EV/{scratch-restored-build,scratch-ds-independent}.json。
      - [x] ~~1019EX 官方同题实际交付复测（限定两轮）。~~ 按用户要求在官方0.71.2原生应用新建双Bot合成群，G1由REFERENCE实现、MIXED复核，G2交换角色；沿用L1原题全文要求，仅替换合成标记、目录和收件人，每题只发送一次，没有补交催办。两轮各三附件均经原生保存窗口下载，独立各40／40、下载源码自测33／33与40／40、两份README各五条示例实际运行通过；讨论结束、无额外重复附件。未观察到本地L1／L2那种实际文件缺失却声称完成的交付失败，不能声称官方已复现同一问题。官方远端工具轨迹、准确模型和目录写入不可从界面独立确认；此对照也不足以单独归因本地模型或Harness。官方恢复原空新聊天、未选收件人且候选列表关闭；没有生产代码改动、commit／push。证据1019EV/official-live-retest/{results,g1-independent,g2-independent,g1-readme,g2-readme}.json及六份下载原件。EU／EV／EW与本地虚报根因继续未完成。
      - [x] ~~1019EY 同模型原生线程／群内独立任务对照（限定产物验收）。~~ MiniMax-M2.7与deepseek-v4-flash各在全新原生工作区／新群使用同一配置和逐字相同正文，仅群多一个稳定ID提及；明确其他成员不参与，四份实际产物均由原模型生成，未手改、未给修复反馈。原40项：MM原生40／40、群37／40（大数精度／溢出）；DS两边40／40。因源码暴露具体风险，统一补三项首参数为混合--help的反例后，MM两边均40／43但失败不同：原生帮助参数，群为金额精度；DS两边43／43。不能用相同通过数掩盖群内金额质量退化，也不将两边自测退出0当作覆盖充分。首次原生MM在有旧文件的工作区误交旧目录，新ey-mm未创建，失败单独保留，再以空目录作受控样本；不是抹去失败重算通过。证据quality-review/1019EY-native-bot-comparison/{results-before-fix,native-mm-existing-workspace-failure,comparison-terminal}.json及四份43项独立报告；没有生产代码更改、commit／push，本项不关闭交付质量父要求。
      - [x] ~~1019EZ 群后续参与者选择与原用户指定范围（限定路由修复）。~~EY中DS交付后本地仍自动派发未被提及的MM，实际19次工具调用、一次重复交付三文件；随后DS零工具pass。准备停止时任务已自行结束，未取消终态任务；DS三份原件已先保全且SHA保持。源码差异已确认：Grok 0.18 `group-chat.ts:10`／`group-chat-orchestrator.ts:47`逐轮按当前用户消息及随后显式@累积选成员，本地`advanceGroupDiscussions`却把所有活跃Bot都列为eligible，参与提示还称@仅影响首轮。修正只沿原控制游标／队列：复用用户已验证targets及Bot现有稳定ID提及，按本次任务范围累积候选；未被选择／提及者不入队。保持未定向群聊、用户@所有人、真实@同伴接力、原回复收件人、停止／幂等／恢复及预算；不解析任务语义、不新增执行器／存储／重试器、不改公共Runtime。先补真实反例的红回归，复核查询计划和实际diff，再做MiniMax／DeepSeek的独立任务不被同伴接管及显式@接力正反例；未验收不划掉。金额精度、旧目录误用和零工具虚报继续单列未解决。
        - 修正已按源码语义收敛：`BotStore.advanceGroupDiscussions`复用原用户已验证targets_json，并累积本次用户消息之后、既有Bot回复所绑定的mentions_json稳定ID；沿原(group_id,ordinal)索引读取，不依赖最近50条展示页，不按文本任务语义分类、不猜同名成员。原全员请求仍全员参与，显式@接力仍走原队列／预算；旧版未启动的非收件人queued游标会在原pump取任务之前撤销，已运行／待答任务仍由原Host完成清理。只调整BotStore选择与原discussion参与句，group-mentions只改注释；没有数据库迁移、新执行器／重试器／状态服务，没有改公共Runtime、审批、普通线程或UI。具体diff、Grok `resolveResponders`参考与构建SHA见1019EZ-group-targets/。
        - 非收件人入队反例先红，最终30项群讨论回归、145项最近相关回归与Bot模块24文件／431项通过，node检查、相关lint和正常构建通过。覆盖原有效接力、停止／幂等／重启、重名不猜、旧任务不串用、50条之外的真实@与索引计划；旧依赖“未提及也自动派同伴”的测试改为实际发出@，并非删除对应接力断言。正常Quit确认零进程后加载新构建，MiniMax与DeepSeek各新群执行原完整题目，仅替换合成标记／目录：均独立完成，一次三附件，各43／43，原始文本与原生对照题逐字归一核对，六附件均经正式界面打开。两个群都只产生指定成员的首任务，没有同伴工具／重复附件。再交换首发者，DS→MM实际纠正27+8=35、MM→DS纠正39+8=47，各只有草稿与纠正两条可见消息、零工具，后续pass收敛，没有牺牲有效协作。
        - 当前官方0.71.2同一定向完整题23:30:48发送、REFERENCE于23:31:51实际交三文件，未见MIXED发言／补交；原生保存下载后43／43，README五条示例与扩展400位金额均实际通过。准确远端模型／工具轨迹仍不可见，不能当成同模型因果对照。其自测首次触及验收器20秒超时，单独运行42／42，再跑未改的43项验收通过；首超时保留。README验收器初稿误把shell注释当输出、把重定向拆作参数，已仅修正证据脚本并保留原错误报告，不为误判修改产品或交付件。
        - 完成后再次正常Quit、同配置重启：1561任务、62Bot、37群、18例行、60命令、409工作区／记忆文件与8158消息头逐项相同，无重放／重复文件，两个讨论游标均0。升级前1553任务、62Bot、35群、18例行、60命令、401文件及8060消息头均零缺失／零修改；新增只有本轮8任务／2群／8文件等验收记录。证据1019EZ-group-targets/{comparison-summary,solo-terminal,handoff-terminal,after-restart,upgrade-preservation,restart-preservation}.json及各回归日志；应用保留原隔离配置，未commit／push。本项只关闭收件人路由，EU／EV／EW及交付质量父要求仍未完成。
      - [ ] 1019FA 同模型交付质量剩余差距（延续EY／EV，不能用EZ路由通过替代）。受控初轮MM原生40／43、群40／43，失败分别为帮助参数与关键大数金额精度；新版群43／43但新增具体400位合法金额反例仍失败，原生MM／两份DS／官方均通过。新版MM还漏回读README，测试文件仅读前100行而非全部；DS虽全回读、README十一示例正确，却仍向/tmp/e重定向，违反本题目录边界。原生MM的README声称一次报告三种非法参数，实际只报告首个，失败也保留，不能以原生有问题为Bot降标。没有给四份受控初轮或两份新版产物手工改代码／喂修复反馈。后续先沿Grok明确的执行／交付协议和原CMB工具回执查差异，再用真实产物验证，避免另造语义真假判定器或把不稳定失败直接归因模型；旧零工具虚报根因仍未解决。证据1019EY-native-bot-comparison与1019EZ-group-targets/{large-literal-counterexample,readme-examples-all,comparison-summary}.json。
    - 1019DW实施前复核：官方0.71.2的单人定向常量仅该成员回答；两步“草稿—同伴更正”由首成员发出真实群提及、第二成员接续完成。本地现有bot_delegate也完成同题，不能重复造交办执行器。差距是原成员结果后的可选讨论，而非完全没有群协作。参考Grok GroupChatOrchestrator、Hermes group-rounds及旧版CMB group-store的串行、有界轮次、无新增内容时pass和持久游标；保留当前初次定向任务及原Runtime，原Host空闲派发时推进可选讨论，自动讨论连同首批定向任务至多三轮／十次成员轮次；显式交办保持原有4层／24次上限，讨论轮次不再另开交办链，同一成员不重复接收已见内容。仅存每群当前轮次控制状态，不复制聊天或checkpoint，不轮询、不新建执行器；非用户来源不能取得资料修改权限。新用户消息／停止／成员变更／删群阻止旧讨论继续；无内容的pass不生成气泡或未读。实现后须验证事务去重、重启、取消、成员／私聊隔离、预算及真实双模型，不以单题成功勾选父项。
    - [x] ~~1019DW 原队列上的有界群讨论与Mac双模型文字接力。~~ 仅新增每群当前控制游标，队列、线程、执行、审批、文件与浏览器均复用原Runtime。首批定向任务后串行检查新群结果，无新内容严格pass、不生成气泡／未读；同成员只接收当前任务的新群参考，保留完整用户请求，引用按编码长度与完整记录限量。新消息、停止、成员变更／删除阻止旧讨论；queued游标和入队在同一事务。自动讨论连同首批定向任务最多三轮／十次成员轮次，不另开交办链；原显式交办的4层／24次限制与重试规则保持。没有新执行器、聊天副本、checkpoint或轮询。
      - 原版Grok同题先由REFERENCE真实提及MIXED，后者在群中纠正17+8=25；本地首轮MM用原bot_delegate成功、DS仅写@后停住，均保留。首次实现另暴露MM把旧同题答复当作本轮结果；只收紧Bot当前任务提示与群增量边界，未改公共Harness。最终构建E重复题取得本轮真实同伴答复；F-MM实际沿原交办链取得47，F-DS只在群中写提及，自动讨论中的MM实际纠正27+8=35，DS随后pass。两种模型均无额外文件／命令／记忆／例行操作；不是用人工补发指令代替接力。
      - 最终包实际request_user_input进入waiting_user后，原“停止群聊工作”使任务cancelled且游标清空，没有后续讨论或代选答案；随后新消息只回复43，不恢复旧选择卡。正常Quit确认进程全退出，再以原配置重启，任务终态、原有消息头及全部文件不变，无新调用或重复消息。42/42限定验收通过：原1204任务、59Bot、17群、15例行、54命令、325文件及6266消息头保持；最终1234任务、107线程、6334消息头，0活跃／0讨论游标。原mask39字符与另一份未发送草稿均精确保留；恢复观察到的Continuation-1018DB3-MM会话，官方恢复原“1”的未答问题。最初草稿核验误把原生Placeholder属性算进值，原失败与修正后的哈希证据同时保留，不为验收器误判修改产品。
      - 391项Bot／共享契约测试、node/web类型检查、改动模块lint及正常构建通过。完整host.test.ts有4项与修改前索引完全相同的存量lint错误，未宣称全库lint通过；其中两份调度桩仅为新增可选讨论返回pass，原调度断言保持。来源及精确构建SHA、原生实屏、任务／工具窗口、重启及保全记录见quality-review/1019DW-group-discussion/{verification,final-results,tested-build}.json与verify.py。未commit／push。
      - [ ] 仍待续验：浏览器成果后的自动检查（文件接力已由1019DZ补验）、多群并行、活动讨论的强制中止／真实重启（queued讨论正常退出后的恢复已由1019DX补验）、Windows；Bot发言中的精确全名身份入口已由1019EA补验，整体UI／动画继续按D04等原项处理。本子项不关闭整个群协作、交付质量或Grok全功能验收。
- [ ] P05.4 验证群消息来源、私聊范围、成员退出与删除；协作内容不能成为新的授权。
  - [x] ~~1019ES 等待回答时移除成员、重新加入及重启后的独立新任务（macOS真实双模型）。~~仅新合成群中运行两轮真实选择：A两位均waiting_user时移除DeepSeek，原DS任务cancelled、问题保留“已取消”，MM仍waiting_user，实际回答继续后正确复述；重新加入同一DS身份不派任务。B交换角色，移除MM只取消其问题，留群DS实际收到结束并准确复述；重新加入同一MM身份，四份原问题均保持真实已答／已取消归属，未形成答案串用或讨论复活。沿用原Host.saveGroup的AbortSignal、Store版本／queued取消与Runtime清理，没有新增生产代码或成员状态。
    - 正常Quit、原exec exit0并独立确认零预览进程后构建、以同一配置重启；任务、Bot／群／例行／命令、文件与消息头前后逐项相同，旧问题没有重放。新构建中MM 3b52e34a…／DS f00ad4d3…各零工具准确回复自己的名称及43，唯一可选复核精确(pass)，未显示额外气泡。原1439任务、60Bot、22群、17例行、60命令、359文件与7082条消息头保持；最终1446任务／23群、零活动任务／讨论游标，新文件仅该执行群setup-state.json。新群最终version6、两位稳定ID保留，用户EF-B原version4／两成员配置保持。
    - 44项限定核验、118项／3文件原有相关回归及正常构建通过；本项相关生产源码与开始时哈希相同，最后构建包含ER仅格式调整且已由重启后真实双模型执行。验收器首次在B的完整上下文中搜到引用的A，从而把真实结束回执误判为应当继续；已改按origin.messageId读取精确用户群消息，原失败报告／脚本保留，未修改实际回执或产品。证据quality-review/1019ES-group-member-lifecycle/{verification,tested-build,normal-quit,official-observation,ui-closeout}.json及各阶段原始快照。保护的旧私聊／群草稿从未打开或发送，本轮没有重新测量其字节哈希；不能写成完成了新的草稿哈希验收。恢复页面时电脑工具报状态变化，随后实际位于File-1019DU-MM空输入，保留现场；复核该时点数据与最终快照完全相同，不声称已恢复EF-B页面。无commit／push。
    - 当前官方0.71.2同题实屏：两位合成成员均出现待答卡；移除MIXED前有确认框，确认后实际只剩REFERENCE，旧MIXED卡却仍可点击。点击旧卡继续后，MIXED卡显示真实回答、REFERENCE卡变为已忽略，最终界面为“已停止，未回复”；没有其服务端任务／工具证据，不推断内部取消原因。重新添加同一MIXED后旧问题未复活，独立ES-C同题两位各答名称与43。保留本地“离群问题取消、同伴仍可答”的明确边界，不复制官方该旧卡表现。参考Grok setGroupMembers及Hermes移除后清理held状态、不重放旧消息；仅本轮macOS待答场景通过，运行中的外部动作、Bot删除、Windows及完整UI仍由父项待验。
  - [ ] 1019ET 补齐官方成员移除前的确认。1019ES已实际观察官方“要将…从此对话中移除吗？”及取消／移除按钮，本地目前直接调用change。先核实原CMB确认弹窗、当前群组件身份与焦点接线，复用现有Dialog／Button；只有明确确认才调用原saveGroup，不改成员取消、存储或Runtime。取消／Escape不得改群或任务，确认绑定原群及稳定成员ID，沿用现有版本拒绝及忙时防重，群切换或目标已离开时不得移除别的对象。以真实MiniMax／DeepSeek待答正反路径复验后再划掉，不为一个确认框新增状态服务或执行机制。
  - [x] ~~1017AZ Mac群内浏览器人工等待与同事文件任务。~~初次复核时userInputWithoutToolLock仅豁免request_user_input，原生接管仍独占群文件锁。先经真实123291ms阻塞复现，再完成AZ原生接管、BA下载原子发布、BB所属页面控制和BC普通观察／上传文件阶段的闭环；双模型正反向等待与实际上传均通过，原失败保留。普通工作台／未知工具及文件写互斥不变，没有加锁超时或另建执行链；仅可信Bot群将浏览器上传的文件阶段交给原同一锁。此项不代表整个P05、原生用户关窗或Windows已验收，详见以下各子项。
    - 1017AZ已真实复现：DeepSeek b93f5c59…的本群接管工具进入waiting_user且无终态回执；MiniMax e3e7f623…发出准确原路径read_file但无ToolMessage。原文件本机直接读取92B耗时0.162ms。成员执行记录正常归还后，MM立即返回5行／48.70；原Runtime日志精确记录同一call_d82608…shared-lock等待123291ms。两条随后均completed，DS重新观察并关闭原精确页。证据before-release-proof.json、runtime-lock-evidence.log、after-release.json；原失败不抹除。沿用原isRecord和可信群开关，只新增原生接管两种调用的等待豁免；先扩展实际中间件红／绿回归，默认关闭与未知工具／浏览器文件操作继续独占。其他浏览器操作在人工控制期间等待的影响需单独核对，不能因本例修复就宣称群浏览器并发全项通过。
    - [x] ~~1017AZ接管请求不再占群文件锁，双模型正反向真实复验。~~生产仅扩充原可信群开关的工具条件并复用isRecord，新旧两种接管调用可等待而不持有文件锁；原私聊／普通线程仍默认关闭，未知工具、其他浏览器操作及文件写互斥不变。实际中间件原实现2失败／12通过（先超时、后改为立即断言并可靠释放），修正后14项全通过；含45项适配器和18项浏览器合计77项、node、workflow及构建通过。原7进程全退出后启动新版，编译产物含新条件。C轮DeepSeek fe94b70a…仍waiting_user时，MiniMax ce8f3b59…已实际read_file并completed／5行48.70；E轮反向MiniMax c759033e…仍waiting_user时，DeepSeek cd8c68cb…同样已read_file并completed／5行48.70。之后分别通过原成员接管卡归还，二者各observe／close，前后同一真实pageId、0工具错误。原阻塞2任务及修正后4任务均保留；605旧任务、35Bot／10群／9例行／21命令、216文件及3639旧消息头保持，611任务／0活跃、quick_check通过，服务仅3GET／0POST后已终止。mask39字草稿、220px侧栏、收起详情和关闭执行过程恢复。顺手将浏览器测试原3处桩写法改为已用的typed vi.fn／超时spy，最终18项、node、两份改动测试lint零错误零警告及格式通过，无额外生产改动。证据quality-review/1017AZ-group-browser-wait/review.json；仅原生接管经过真实模型，新旧协议兼容的旧调用由单元覆盖，不据此勾选整个群并发或Windows。
    - [x] ~~1017BA 下载原子发布及Mac双模型成功／损坏下载复验。~~原saveDownload直接saveAs最终工作区路径；所用Playwright的client/artifact.js:36—45与server/dispatchers/artifactDispatcher.js:58—67分别使用createWriteStream／copyFile，未承诺原子发布。复用file-copy.ts既有同目录暂存＋rename＋finally清理模式，正式路径只在保存完成且通过大小校验后发布；保留原路径格式、100MiB限额、120秒取消和权限，不缓冲整份文件、不增加复制、监听或计时器。非接管浏览器调用在人工控制期间的文件锁等待仍单列待核对，不因此豁免上传等文件操作。
      - 原代码确定性回归3失败／18通过：下载只写入partial且保存回调未返回时，正式路径已经存在；保存失败和稀疏文件超过100MiB两个负例中，原catch删除了并发写入正式路径的“existing peer result”。测试使用实际文件IO、页面download事件和原BotBrowserService，不以静态源码匹配代替行为；稀疏负例未分配100MiB内存。修复沿用file-copy同目录暂存／rename，不调整下载路径契约、限额、原120秒取消或角色权限。
      - 修正后浏览器21项及文件／Runtime适配／锁行为合计86项通过，node类型检查、定向lint零错误零警告、格式与构建通过。旧7进程正常退出后载入新版，实际产物含rename。DeepSeek f6bc9114…／MiniMax 7c620c97…各navigate／click／read／deliver／close一次，原CSV均72B、3行，合计分别20.00／18.70，下载原件SHA与服务端一致；正式文件卡／资料库打开后实际内容一致。损坏任务18741b9b…／72cd54df…各只调用一次click，随后observe确认saving→failed，关闭精确原页；未读写其他文件、未交付附件，失败正式路径和全部.part均不存在。Chromium对每次截断响应自动发起6次GET，不能记为网络只请求一次或模型重复点击。四任务均completed、工具success代表成功报告失败，不代表损坏文件下载成功。
      - 611旧任务、35Bot／9例行／21命令、216旧文件及3681旧消息头逐项保留，615任务／0活跃、218文件、quick_check=ok。验收期间观察到群名称AU→A及version1→2，原因未归属，现状保留；其他群与原成员配置未变。用户mask39字草稿逐字保留且未发送，保留观察到的280px侧栏。合成服务57328已SIGTERM／exit143并确认进程消失。证据quality-review/1017BA-download-atomic/{source-review,ds-success-proof,observed-ui-change,final-models,final,review,server-stop}.json、可重跑review.py及requests.jsonl；证据脚本最初按封套正文判断模型误标一条DS样本，已改为持久bot_id并重跑。Windows、原生浏览器窗口关闭及完整群并发父项继续未完成；无commit／push。
    - [x] ~~1017BB Mac接管只暂停所属Bot页面，原生宿主及双模型正反向验证。~~原BrowserService.act的全局human判断让另一成员的普通浏览器调用也进入人工等待，并占其群文件锁；宿主实际已为精确页面建立独立BrowserWindow，CDP输入不移动系统鼠标。Grok prompt-collector-glue.ts明确每个Agent拥有自己的桌面，接管服务按agentId保留请求；Hermes lease.py按共享桌面profile拒绝操作，两者不能混同。本次仅将已有等待／控制检查限定到当前Bot范围，保留短操作全局串行锁、一个人工接管、上传范围和原Runtime文件锁；租约记录原版本，其他页面关闭不再使归还按钮失效。页面事件先等待当前受信创建完成精确身份注册，再识别人工作业新标签，防止B新页面被人工A兜底误认；复用已有Promise／Map和生命周期，不增虚拟机、独立浏览器、轮询、计时器或Runtime并发接口。工具说明及电脑面板提示同步明确所属范围。
      - 原服务新增两例2失败／21通过；修正后增加人工新标签与同事创建重叠、按成员删除不关闭人工页面的回归，浏览器24项及文件／工具／Runtime适配／锁行为合计101项通过，node／web类型、lint零错误零警告、格式和构建通过。首次开发漏传最后一处check参数导致22例失败，已修正并保留日志，未带入测试包。既有原生宿主集成fixture中A请求接管时，B既有页及C新页都能导航并各自关闭；A原URL／页面归属／指令／租约版本不变，原版本归还成功，随后持久cookie即时重启仍通过。普通构建已移除E2E入口，原7进程正常退出后载入新版。
      - 真实AU群第一轮DeepSeek970e48a4…仍waiting_user、接管工具没有终态回执时，MiniMax3bcc77c1…已完成navigate／read_file／close各一次，读取原92B CSV为5行／48.70；第二轮MiniMax d232bdc7…仍waiting_user时，DeepSeek1eb12178…同样完成3次真实调用并交付正确结果。每轮页面ID不同且观察列表只含各自目标；随后分别从原成员执行记录点击“归还并继续”，两位各重新observe并close精确原页、均completed／零工具错误。服务仅A／B／C／D四次GET、0POST／重复导航。615旧任务、35Bot／10群／9例行／21命令、218文件与3724旧消息头保持，619任务／0活跃、quick_check=ok；mask39字原草稿逐字保留未发送，280px侧栏、原详情状态恢复。合成服务4878经SIGTERM／exit143确认消失。证据quality-review/1017BB-peer-browser-control/{source-review,first-pair,second-pair,final-models,final,review,server-stop}.json及可重跑review.py、requests.jsonl、/tmp/cmb-1017BB-*日志。当前仅证明不同成员的页面隔离及正常归还；原生用户关窗、同一所有者的新任务／排队接管、Windows和整体UI动画继续单列待验，未commit／push。
    - [x] ~~1017BC Mac同一所有者的普通浏览器等待不占群文件锁，上传保留原互斥。~~正式电脑面板人工接管MM后，aab477ba…普通observe进入waiting_user且无回执，DS4298687d…read_file同样无ToolMessage；本机直接读原92B耗时0.182ms。正常归还后原Runtime记录精确read call等待45641ms才执行。仅为可信Bot群接线默认关闭的botBrowserToolsOwnFileLock，原私聊／普通会话及子Agent策略不变；已知页面操作由原浏览器锁串行，未知／新增动作仍按文件独占处理。上传通过薄回调复用同一个Runtime锁Map，人工等待结束后才获取文件写锁，再获取浏览器锁；获取文件锁后重查取消／控制版本，不重放等待前上传。没有复制文件、建立新锁／队列／定时器或调整授权。
      - 原服务／中间件回归9失败／38通过；修正后119项通过，覆盖普通浏览器等待、上传等待不占文件锁、实际上传与文件写互斥、文件锁排队期间接管／取消不读文件，以及可信群回调使用准确bot-group-g队列。node、原完整workflow及desktop-agent-baseline通过，Bot／测试lint零错误零警告、构建通过。额外检查Runtime／IPC／run-service无lint错误；大型旧IPC块保留既有格式，新增字段沿用邻接缩进仍有2条Prettier提示，未为此扩改原大块；run-service未改的agentRunSteerer格式提示在HEAD同样存在，未记为全文件格式通过。两次更新均正常Quit并确认原8／4进程全部消失，普通产物无E2E入口；组上传回调编译为当前application中同一runtime导出，不复制锁实例。
      - 原失败样本归还后MM又请求一次接管：旧普通observe回执只有页面快照，没有明确控制已归还。升级时该二次请求仍等待，原任务因此interrupted；这不是通过，原回执与中断状态保留。核对Grok box-handoff-resume.ts:115—132的明确归还／重新观察通知后，仅在实际控制等待结束的回执增加control=bot及“控制已结束、这是新观察、旧动作没有重放”；没有声称用户完成了登录或表单。修正版MM71c971de…普通observe等待时，DS6e7d8442…已read_file并completed／5行48.70；反向DS1fe5b23a…等待时，MM0763e2b9…同样完成读取。分别从电脑面板归还后，两位均关闭精确原页并completed／零错误，未再次调用接管工具；MM共observe／close两调用，DS额外独立observe一次，不将合理的重新观察计为输入重放。
      - 实际上传MM3e873fcc…／DS3cfcd04f…各navigate／upload／close一次，均completed／工具success。页面通过File.arrayBuffer与crypto.subtle实际计算原CSV，二者文件名均为新聊天核验-1017AU.csv、92B、SHA-256 c14b47a7…a50a4c235，与磁盘原件一致；页面明确未提交，服务仅2GET／0POST。619旧任务、35Bot／10群／9例行／21命令、218文件及3759旧消息头保持，627任务／0活跃、两库quick_check=ok；新增8任务包括原失败2条和修正后6条，未把旧中断算成功。恢复群资料库、mask39字原草稿、280px侧栏及原详情状态；服务23752已SIGTERM／exit143确认消失。证据quality-review/1017BC-owned-browser-wait/{blocked-proof,blocked-pair,before-upgrade,after-upgrade,fixed-first-pair,fixed-second-pair,final-models,final,review,source-review,server-stop}.json、runtime-lock-evidence.log、可重跑review.py及/tmp/cmb-1017BC-*日志。Windows、原生关窗及整体Grok UI／动画继续未完成；无commit／push。
  - [x] ~~1017U 当前原子编辑器的DeepSeek收件与来源续验。~~通过正式界面新建“收件与来源核验-1017U”，仅选择两位既有DeepSeek-v4-flash合成Bot，未修改原Bot／模型／群配置。无提及、仅引用作者、引用作者并从候选选择另一成员、粘贴普通@文本四轮分别产生2／1／2／2条任务，七条均completed／零工具调用；实际作者、group专属thread、origin.messageId、持久reply_to_id及mentions_json逐项核对，正确回复43／51／62／31和各自当前名称。第三轮按作者与提及并集派发且无重复，第四轮mentions为空、没有由普通粘贴生成身份权限。引文要求改名／发消息／记忆未被执行，原178份跟踪文件和全部Bot／例行、七个旧群及457份旧任务字节字段不变；仅新增本次群、四条用户消息与七条回复，464任务／零活跃、quick_check=ok。恢复原资料核验群、360px详情、80px侧栏与空草稿，样例保留未删除。本次沿用1015L—P既有官方收件实测，未重跑Grok云端；无生产代码改动，MiniMax额度／IME／Windows及整体P05／UI仍待验。首次证据脚本按任务正文子串筛选时误计引用历史，已改用origin.messageId精确关联原用户消息后重新核对，未当作产品缺陷修代码。证据quality-review/1017U-deepseek-group-recipients/{before,case1-started,case2-completed,case3-completed,case4-completed,group-messages,final-storage,review}.json及可重跑review.py。
  - [x] ~~从群中移除等待审批的成员会取消其实际任务，重新加入不复活旧任务，私聊 Bot 与既有群历史保留。~~（1014C）真实 MiniMax 对合成文件申请写入，任务 `070c9409-eecf-456c-bae8-e1f027abf343` 为 waiting_user；通过群设置移出该成员后终态 cancelled，未创建文件，群收件人列表不再包含该成员。重新加入后旧任务仍 cancelled，群内活动任务为 0，文件仍不存在；该 Bot 私聊仍有效，此前群回复仍可见。未验证任意正在执行的外部操作的回滚，删除流程另验收。
  - [x] ~~群内真实异步交办／回传保留来源，合成越权引用不修改目标 Bot 身份或私有记忆。~~（1014B2）修正收件人名称解析后，发起任务、接收者实际任务、返回汇总任务均 completed，全部使用同一群的独立线程；目标 Bot 实际核对 41.75 并识别越权样本。其名称、配置版本 4 保持不变，合成标记未出现在 Bot 记忆文件中。此样本不代表所有提示注入均可防御；成员退出、删除的完整实际场景仍待验收。

### P06 — 定时与通知

- 2026-10-18 群例行范围已按用户“简单则一期，否则二期”评估，列入第二期。Grok `automation-run-path.ts/runGroupAutomation` 按触发时群成员执行；Hermes cron 的 origin 交付定位到平台群／话题，不能直接代替 CMB 内部多 Bot 群任务。CMB BotSchedule／IPC／fireSchedule 均以 botId 为归属，sendGroup 会生成用户来源并参与 hasDirectUserRequest 授权，不能把计划触发冒充当前用户。完整接入需贯通群计划契约、成员派发／去重、非用户来源与私有记忆边界、静默结果、删群和成员退出清理；现有时钟、编辑器、队列与事务可以复用，但整体超过少量接线。未新增半成品入口，不以单 Bot 计划冒充群计划或宣称与 Grok 此项一致。

- [x] ~~1016W 聊天中的例行任务回执展示。~~1016T 实屏成功创建后，简洁聊天仍出现两张原始工具卡。Grok 的 `timeline-event-automation.tsx` 将真实变更显示为短事件，工具原文留在执行详情。沿用现有 ToolMessage 关联与 Bot 展示投影：仅折叠结构校验通过的成功查询；真实保存／删除回执显示简短事件，未知、错误、未返回及无法解析的结果仍保留原工具卡，模型发起请求不能冒充已成功。继续使用现有例行任务面板，不改调度、权限、消息存储或公共 Runtime。
  - 实屏展开后纠正：两张原卡中一张实际为“此 Bot 中不存在该例行任务”的旧错误，不能折叠；当前新投影已正确保留该错误，并把真实成功保存显示为短事件。旧错误原持久状态为 OK，系 Bot schedule 工具抛出异常后被兼容包装转为成功文本；将只在该 Bot 工具沿用已有记忆／浏览器工具的 error ToolMessage 返回方式，保留取消异常和原权限检查，不修改公共 Runtime 或追改旧历史。新增错误回执需单独验证，旧 OK 记录不能冒充已修正。
  - 原应用正常 Quit exit 0 后载入最新工具，真实 MiniMax 任务 `7a2c6a54-050b-466a-b9cb-79f0899ac888` completed：先 list，再对故意不存在的 ID 执行一次 save，恰好两次工具调用。list 的有效回执在终态收起；save 的 ToolMessage 持久为 status=error、is_error=1，简洁界面实际显示“工具失败”，最终说明接口拒绝，没有重试或替代创建。原例行配置与触发记录逐字段一致，任务数 255→256、0 活动任务，quick_check=ok。旧成功保存事件与执行过程开关已实屏核对；删除事件和取消为定向测试，不冒充真实删除验收。58 项工具／Runtime 接线／回执展示测试、node/web 类型检查、messages 回归和构建通过；所改纯函数及主进程工具 lint 通过。BotConversationTools 的已提交 setOrigins effect lint 错误与两个既有依赖告警未由此项修复。证据 `quality-review/1016W-routine-presentation/evidence.json`。尚未复制 Grok 的例行事件快捷编辑入口，不据此勾选整体 UI。

- [x] ~~1016Y 例行事件的管理入口。~~只读核对官方 0.71.2 `chunk-view-DeQuKDi0.js`：真实变更提示旁显示时钟和任务名按钮，点击调用原 onOpenAutomations；已经删除的任务只显示历史事件。复用现有 Host 快照里的 schedules 与 BotViewStore，在有效保存回执旁提供相同作用的入口，进入所属 Bot 现有详情／例行任务区域；不存在或已删除的配置不提供伪入口。仅转发现有快照，不新增订阅、编辑器或状态存储。来源保留于 `quality-review/1016Y-routine-entry/official-view.js`。
  - 新版入口已实际从记忆页切到 AP 的正确例行区域，详情关闭时也可重开，原合成草稿保持；原编辑器读到实际名称／任务内容／时间。Escape 退出编辑后焦点落到页面根，继续仅在 BotSchedulePanel 复用 Radix onCloseAutoFocus 与触发按钮 ref 修正，不新增定时器或修改共享 Dialog；修正后复验焦点、草稿和任务配置。
  - 修正后原应用已实测：Escape 从编辑框返回“编辑例行任务”按钮，新建框点取消返回“创建例行任务”按钮；输入框为空，没有发送本次合成草稿。前后 control 快照的 21 Bot／7 群配置摘要、全部例行配置与触发回执完全相同，任务数仍为 258、0 活动任务、quick_check=ok。web 类型检查、messages 回归、构建及面板 lint 通过；没有重新实现 Grok 的自动化管理系统。证据 `quality-review/1016Y-routine-entry/{before-ui,after-ui,ui-results}.json`。真实永久删除后的历史按钮与 Windows 未实测，仍由相应整体门槛覆盖。

- [x] ~~P06.1 复用时间计算实现 Bot 定时配置、触发入队、暂停、取消与任务记录。~~
  - 复用 `computeNextRunAt`，配置面板和 `bot_schedule` 工具均接入 Host；控制测试覆盖过期合并、暂停取消和幂等，进程重启测试验证到期例行任务实际入队且只执行一次。
- [x] ~~1016T 到期时应用已退出的真实恢复。~~使用已有 MiniMax Bot 创建一项明确合成的一次性例行任务；正常退出原应用，截止时间过后再用同一配置启动，检查只补执行一次、结果回到原线程、例行任务禁用且不再排期。再核对重复恢复不会新增任务。只验证本地进程退出／恢复，不宣称关机时仍运行或 OS 睡眠唤醒已测；沿用现有 Host.resume 与 Store.fireSchedule，不新增调度系统。
  - 1016T 真实 MiniMax 创建任务 `f5ed02f7-bd4a-44ee-ae26-c063dce7b9f8` completed，例行 ID `aea100dd-d331-4b0f-acac-bb002864ba65` 截止为本机 2026-10-16 04:15:00。截止前正常 Quit exit 0、确认原进程不存在；04:15:29 独立读取控制库仍无 schedule 任务（共 254 条），随后启动原配置。Host 在 04:15:31 仅补入任务 `9201a1bc-2e90-428f-87b2-a516e2f7cf3b`，completed 且 UI 原 AP 线程实际显示“1016T_RESUMED：17+24=41”。例行 version=2、enabled=false、nextRunAt=null。再次正常 Quit／重启后仍 255 条任务、该回执一条、0 活动任务，21 Bot／7 群身份摘要完全相同，quick_check=ok。证据 `quality-review/1016T-schedule-restart/{before-quit,after-deadline-offline,after-first-restart,after-second-restart}.json`。未改生产调度代码；没有伪称应用退出期间执行，OS 睡眠、通知中心与 Windows 仍由各自验收覆盖。冷启动绘制仍通过原生窗口缩放恢复，该已知现场继续保留。

- [ ] P06.2 验证重复触发去重、睡眠恢复／过期策略、完成通知及后台运行状态。
  - [ ] 1018CP 例行任务失败回报的当前官方同题对照。复用既有BS双模型与官方合成CN会话，各安排同一未来时间的一次性任务，仅尝试读取工作区中不存在的合成JSON并如实报告未找到，不能创建文件、重试或保存记忆；保留真实安排回执、唯一到期任务、工具错误和最终回复，检查回到原Bot且一次性计划不再排期。源代码先核对原Host／Store调度、Grok自动化执行与静默规则；本轮不新增调度系统、不改既有9项例行任务，不以Mac正常计时替代睡眠或Windows验收。
    - 本地双模型已实际通过：MM安排5e9b75fa…／到期4b9072ba…，DS安排a0ae9ea6…／到期0eebcaf3…；两项均准确保存06:50Z（北京时间14:50），到期各唯一入队且只read_file一次，真实原Runtime回执status=success但正文为ENOENT，不能写成文件读取成功或工具已改为error。两份最终回复均明确不存在、无法核验，未重试或创建文件；once已disabled且nextRunAt=null。原877任务、9项例行、38Bot／10群／29命令、267文件及旧消息不变；只增加4任务与2项已结束合成计划，mask39字草稿未变，零活跃。41项本地／源码／数据审计通过，完整验收器仍因官方实际最终回复未观察到而失败，保留为未完成；未修改生产代码。官方计划面板确认仅一次14:50，但至14:55:58（到期约358秒，含置前复核）仍无实际异常回复，不用用户原提示中的标记冒充结果、不发催办或推断云端文件／执行状态。证据quality-review/1018CP-routine-failure/{scheduled-definitions,local-completed,final,official-observation,review-partial}.json及实屏、严格验收失败日志；待官方自动结果后续核对，睡眠／Windows不由此项代验。
  - [x] ~~1016BT 双模型无变化例行任务续验。在已授权隔离配置的两个BS合成Bot中，各通过正式私聊创建一项短延时、执行一次的合成核对；到期只计算固定数字，相同结果应静默，不运行命令、不写文件或记忆。安排后离开这两个会话，核对到期真实MiniMax／DeepSeek运行、唯一触发、终态及静默标识，列表摘要／未读时间不因无变化结果更新；切回会话确认隐藏该轮，保留原例行配置、用户草稿与既有资料。复用已有调度、静默投影和通知策略，不增加调度器或规则特例；系统通知中心／OS睡眠和Windows未观察就继续列为待验。~~
    - 首轮失败保留：MiniMax任务4143140b…把新任务名称填入已有任务id，仅一次save被正确拒绝（真实ToolMessage error），却声称已安排。控制库确实没有1016BT配置；completed只代表Runtime结束，不代表安排成功。核对原CMB scheduler-tool的字段说明、Grok routine action=create及Hermes“先list、不猜ID”约定后，仅补Bot工具的创建／修改说明和id字段描述，并让原未知ID错误明确“未保存”及纠正办法；保留原save协议、ID校验、授权与调度，绝不将未知ID自动视为新建。后续用自然请求双模型复验，不向用户消息暗塞正确工具参数，不改公共harness。
    - BT2创建复验通过、静默未全部通过：新版DeepSeek任务32cc8953…与MiniMax任务a44bce13…各一次真实save成功，生成88108494…／97165550…，均定于2026-10-16 20:31:00。到期分别唯一触发be21d8b3…／860ce4db…，均completed、0工具，配置version2／enabled=false／nextRunAt=null。MiniMax精确返回静默标识，活动记录所有字段完全不变；DeepSeek在标识前添加“17+24=41，无变化”，按严格规则正常投递并更新未读，故本轮静默失败。证据quality-review/1016BT-routine-silence/{first-failure,arranged,triggered}.json。仅调整Bot的例行来源说明，明确先判断通知条件、静默时整条可见输出只能是标识，并解释额外文字会触发通知；不把“包含标识”的任意回复强行隐藏，不修改原Runtime／通知／投影或调度器。再次双模型实测通过前保持未勾选。
    - BT3最终复验通过：DeepSeek创建任务e662cf4a…／MiniMax创建任务ed6b5906…均只有一次成功save，自然请求未指定工具参数。2026-10-16 20:42:00分别唯一触发139a6072…／2b1ec05d…，completed、0工具，可见回复均为精确静默标识；两份活动记录（version、attention、seen、updated_at、preview）与触发前逐字段相同。切回正式会话，两者均只显示BT3安排结果、不显示这次静默轮次，提问导航均为8条；DeepSeek旧BT2非静默失败仍可见，未删改历史。四份本次合成例行配置均已执行一次并禁用，原五项配置、全部原Bot／群定义及21份记忆／群文件不变，353任务、0活跃、quick_check=ok。正常Quit／同配置重启后仍353任务、终态时间／活动／例行配置未变，无重复触发，MiniMax静默轮次仍隐藏；已恢复80px头像侧栏、关闭详情、空草稿。57项提示／适配／工具／静默投影／关闭回归、node类型检查、lint与构建通过；实际两模型回执均HTTP200。证据同目录{arranged-final,triggered-final,after-quit,after-restart,review}.json，/tmp/cmb-1016BTBU-{tests,node,lint,build}.log与/tmp/cmb-original-preview-1016BTBU.log。只证明本次无变化策略，不能保证任意模型永不违约；严格投递判断未放宽，P06.2的系统通知中心／睡眠／Windows仍待验。
  - [x] ~~Mac 正式关闭窗口选择“最小化到菜单栏”后，一次性例行任务按时由原 Runtime 完成，结果持久化回原 Bot 会话，仅产生一条 schedule 任务。~~（1013P，2026-10-13 13:36:43 触发，后台验收1013P：42）本轮没有主动使系统睡眠，系统通知显示也未单独验收。
  - [x] ~~无变化例行任务沿用原 Runtime 保存执行记录，完成后不更新未读／列表摘要，不发系统完成通知，并在会话投影中隐藏该轮。~~（1013AA：2026-10-13 17:08:20 实际触发，真实 MiniMax 读取下载回执后返回精确静默标识，持久终态 completed；聊天仍显示安排任务前的结果，没有新增无变化消息。通知由回归验证，未单独观察系统通知中心。）保留 checkpoint 和原消息，不复用原 heartbeat 的删除／还原快照方式；失败、用户直接消息、包含实际结果的回复不被静默规则隐藏。重新启动后聊天与提问导航均没有恢复静默轮次。Grok 同题任务运行后 UI 自动移除任务且没有无变化消息；随后 Grok 回复称检查符合预期，云端工具记录未取得，不能作为独立执行证据。
  - [x] ~~真实 MiniMax 一次性任务保存完整路径、预期值及异常报告条件，实际读取失败后正常交付异常，重启后结果仍可见。~~（1013AB：2026-10-13 17:24:50 触发，task completed；真实 read_file 返回 ENOENT，最终报告原路径、具体错误和无法核验 name／合计。Bot 活动摘要更新为“异常报告：文件读取失败”。）此处完成表示任务按要求报告异常，不表示输入文件验证成功；Grok 异常同题仍待验收。

### P07 — 简化浏览器

- [ ] 1017AV 人工接管等待中的真实停止与恢复。已有1013AE／AF、1017J／AF验证正常接管与确认弹窗，本轮只补取消路径：DeepSeek与MiniMax分别导航127.0.0.1合成页面并实际请求接管，等待时从原聊天停止；核对任务终态、用户窗口保留、原接管租约可归还，归还不唤醒已取消任务。随后同一Bot新任务观察并关闭自己的精确页面，服务端确认无提交、无重复操作。沿用Grok box-help的明确请求／归还流程、本地BotBrowserService的AbortSignal等待与原Host取消，不增加超时、队列或隐式重放。主进程、私聊／群身份、草稿／文件／记忆保持，实际范围分别记录；不以此代替原生窗口关闭、企业登录或Windows验收。
  - [x] ~~1017AV Mac私聊双模型停止／明确归还／新任务恢复。~~DeepSeek915a350b…与MiniMax6faf5e29…均实际navigate一次、request_browser_help一次，待控制库waiting_user与正式接管卡出现后，鼠标点击原“停止生成”；两任务终态cancelled、0活跃，活动接管卡撤下。电脑面板仍显示各自准确标题与“归还Bot”，页面及用户控制权未被取消动作收走；分别显式归还后按钮变为“接管浏览器”。归还前后及后续任务完成后，原cancelled任务、工具调用与更新时间逐项保持，没有唤醒旧任务。DeepSeek67ec4bb6…和MiniMax002a00bb…新任务均仅observe／close一次，读到真实“尚未确认”，关闭的pageId精确等于原本页面；控制generation分别0→2及3→5，两个Bot的页面ID不同，任务completed且工具success。服务端只有DS／MM各一次GET，0次POST；没有重复导航、点击或恢复已取消操作。最后电脑面板为空态；原私聊详情页签、身份群@草稿／资料库、深色及220／360宽度恢复。原590任务、34Bot／10群／9例行／21命令、214文件与3554旧消息头保持，仅4条本轮任务，594任务／0活跃、quick_check=ok；合成服务90119已SIGTERM并确认exec退出143、进程消失。证据quality-review/1017AV-browser-help-cancel/{before,ds-waiting,ds-stopped,ds-returned,mm-stopped,mm-returned,final-models,final,review,server-stop}.json与requests.jsonl。本轮没有生产代码变更，未重复跑无关测试；没有实机关闭独立窗口、输入、群接管取消或Windows验收，不能将父项／P07.4勾选。
  - [x] ~~同次MiniMax完成回复仍展示内部页面UUID；功能回执正确，但不满足P09.6简洁呈现。后续先核对现有Bot表达规则和Grok工具返回／发言约定，不能通过删除模型原文、正则过滤UUID或改公共Runtime掩盖此差异。~~
    - 1017AV-B核实：buildBotPrompt已有内部Bot／任务ID规则，但仅写普通进度，缺少浏览器页面ID及最终回复；Grok system-prompt.ts:92明确将内部标识与用户发言分开。只扩充原句，使用页面标题／同事名称表达，保留用户主动诊断时可返回标识的例外；工具参数／原始回执／历史消息完全不变。不新增过滤、解析器、规则段或公共Runtime接线。以自然要求打开再关闭合成页面的双模型新任务验证，用户消息不额外提示隐藏ID；未复验前不划掉。
    - [x] ~~1017AV-B最终Mac双模型自然任务复验。~~仅修改原有表达规则一句；52项prompt／Runtime适配回归、node类型、lint零错误零警告、格式及正常构建通过。原79481及浏览器宿主等7进程全部正常退出后更新；规则实际在out/main/application.js，最初误查bootstrap index.js的失败检查保留，不据此判断未编译。DeepSeekb871385d…、MiniMaxc33aa6a6…均仅navigate／close各一次，completed／工具success；原回执保留真实pageId，最终一句话使用实际标题及“尚未确认／已关闭”，没有UUID或其他内部路由标识；用户任务未提示隐藏ID，没有输出过滤或改写持久消息。服务端仅DS／MM两次GET、0次POST。此前用户在试用中新增mask及3条非验收任务，首次工具输入未真正送出，控制库确认后才重试，未重复提交；以包含这些用户改动的597任务／35Bot／216文件新快照保护，最终仅增加本轮2任务，599任务／0活跃，原10群／9例行／21命令、216文件及3583旧消息头均保持，quick_check=ok。已恢复用户mask会话，原未发送草稿逐字一致且未提交，详情关闭、220px侧栏与深色保持；此前身份群@草稿未改。合成服务17099经主动Ctrl-C退出1并确认进程与监听消失，该KeyboardInterrupt不当作服务失败。证据quality-review/1017AVB-browser-visible-identifiers/{before,after-unrelated-activity,unrelated-activity,source-sha,quit-check,model-results,final,review,server-process}.json及对应AVB日志。仅本次两个自然样本通过，不承诺所有模型永不暴露ID；主动诊断例外、Windows和整体P09.6继续待验。无commit／push。

- [x] ~~1017O 当前Mac原生浏览器宿主集成验收。~~正常Quit预览PID41247并确认进程结束后，以CMB_BOTS_E2E=1构建原独立入口，实际运行既有tests/bot-native-browser-host.spec.ts。生产BotBrowserService／Electron适配器及真实宿主IPC通过：双Bot各自页面与中文输入隔离、真实文件上传／下载内容、confirm期间同步标题预览及dialogPending／无截图、确认后正常截图、人工接管／归还、等待帮助与幂等接管、实际手动导航证据、关闭后同一profile立即重启。脚本退出0并打印PASS，独立ps未见parent.cjs或浏览器宿主残留；测试自有临时配置由原脚本清理。取消E2E环境变量重建正常包，确认out/main/bots-browser-e2e.js不存在；以原配置启动54092并回到原合成Bot，452份任务、Bot／群／例行及177份跟踪文件哈希完全不变，quick_check=ok。仅新增验收证据和本条记录，未改变生产实现、模型配置或测试标准。普通启动AX／截图仍不稳定，原生Raise及菜单Escape未替代既有Zoom恢复，BV未销项；不将其误报成新的浏览器失败或全页面卡死。此项仅证明本机Mac的原生服务／IPC契约；真实模型、Windows CI／实机、安装包和完整UI保持各自门槛。证据quality-review/1017O-native-browser-host/{before,native-result,normal-restored,review}.json及/tmp/cmb-1017O-{e2e-build,native-host,normal-build}.log。

- [x] ~~1016AM 文件控件修正后的真实上传下载链路。使用原 AP／真实 MiniMax、独立 127.0.0.1 合成页面和本次生成的 JSON 附件，通过正式输入框导入，实际定位文件控件、上传、填写、提交、处理合成提示并下载原始回执。核对保留输入原件、服务端收到的 JSON 字段、回执字节与 Bot 文件交付；不修改既有合成验收记录、不导入用户凭据、不写记忆。~~
  - 原生文件选择器导入 64B 的 upload-1016AM.json，保留副本 SHA-256 与原件均为 ac1304bb91484eb62d0a911d07646e33f600222bb175ab066c78ce1cd7beeef4。真实 MiniMax 任务 bffa56fb-a6a3-4c71-9140-89704dce1be1 completed／无错误，共 6 次 browser 操作（导航、填写、按真实 file input 标签上传、提交、确认合成提示、下载）、1 次读回、1 次文件交付；没有纠偏或人工代填。服务端实际收到“青岚-1016AM”与 code=UPLOAD_1016AM／total=50.75；下载的 163B 回执与服务端保存文件逐字节／SHA-256 一致（33290209b8e8ce5dfb2b6feddfc1e9b4a94b9d2e26b5328674f447bef4039089），实际成果卡片打开 JSON 预览字段完整。任务结束输入及附件清空，AP 真实 memories 目录无 Markdown；本机临时服务已停止。服务端保存的是解析后的 JSON，并未记录上传原始字节，故不宣称请求体逐字节审计。证据 quality-review/1016AM-browser-upload/after.json。此前 1013 的成功记录保留；这证明当前本机合成链路，不替代 Grok 云端同题、Windows 或整个 P12.3。
- [ ] 1016C 本机合成登录持久化。沿用原应用与现有专用浏览器，让真实模型导航到仅 127.0.0.1 的合成登录表单并请求接管，由验收人员通过原生窗口填写合成账号，归还后实际观察登录结果。任务结束后正常退出／重启原应用，再由同一 Bot 访问账户页，核对真实请求携带持久会话、页面结果及 Bot/thread 身份。临时服务不收集真实账号密码，不导入个人浏览器凭据；不以本地合成会话冒充企业 SSO／验证码验收，不改浏览器架构或审批策略。
  - 首次真实任务已导航、观察并产生接管卡片。当前电脑工具仍只绑定主应用窗口，无法定位独立浏览器的原生字段；未填写表单即归还，不能将此记为人工登录通过。后续通过新的正式用户任务，明确允许 Bot 在此合成页面填写无敏感性的测试账号，单独验证会话持久化；人工输入／归还的已通过范围仍引用 1013AG（用户输入 111），不把两个样本混作一次人工登录。
  - [x] ~~1016C2／C3 合成登录、正常退出及重启后真实读取。~~ DeepSeek 实际填表并点击登录，服务端 POST 后的 GET /account 带持久会话；任务 `d925a672-f127-45fd-91d8-493868ed66b7` completed。原应用从菜单 Quit 正常退出 0，主进程 12299 与浏览器宿主 28217 均不存在；使用同一原配置启动新版后，新浏览器进程再次 GET /account，服务端 authenticated=true，真实模型报告“已登录：合成账号-1016C”，没有再次登录。20 个 Bot 的 ID／thread／配置、7 个群与稳定成员均保持，quick_check=ok。证据 `quality-review/1016C-browser-login/before-restart.json`、after-restart.json、requests.jsonl。初始截图仍停在工作台而 AX 已切换 Bots，原生缩放窗口后恢复绘制才完成 C3；该现场保留，不能以会话保留通过替代完整冷启动绘制／原生人工输入／SSO 或 Windows 验收。

- [x] ~~P07.1 实现专用持久化 Chromium、profile 单一所有者、页面稳定归属与浏览器任务队列。~~
  - 复用安装中的Electron／Chromium：专用宿主userData保存会话，单实例锁限制同profile所有者，BotBrowserService按Bot／群成员绑定精确页面、共用原浏览器操作队列。1017O原生服务／归属／串行边界，以及1017AL双模型登录复用、正常重启、新cookie立即退出和第二所有者拒绝，提供本机运行证据；没有新增浏览器下载或另一套会话存储。此项完成实现与Mac定向验证，Windows安装／原生输入仍由P07.5／P11.3单独验收。
- [x] ~~P07.2 提供页面观察、导航、定位操作、输入、滚动、上传下载和弹窗处理，操作不抢系统鼠标。~~
  - [x] ~~1016AH 浏览器文件控件语义。1016AG2 真实 MiniMax 将 ARIA 中的 button“合成附件”误判为不存在文件选择框，实际合成 HTML 为 input[type=file]。保留该错误首轮；参照原录制器识别原生 file input／关联 label 的方式，仅在 Bot 观察回执增加有界的实际文件控件元数据，继续使用既有 exact label 上传，不改共享浏览器、选择器协议、页面归属或审批。控件文字仍为不可信页面资料，不读本机文件或暴露已选文件路径；复测同题实际判断与原上传回归后再划掉。~~
    - 仅 BotBrowserService 原观察回执补充主文档实际 file inputs：最多 20 项，标签上限 1000、accept 上限 500，关联 ARIA／原生 label，含 multiple／disabled，不读取已选文件或本机路径。原 ARIA 快照与操作入口保持不变；新增 await 后仍复核取消及控制代次。新版主进程 PID74522 中，真实 MiniMax 任务 eb8d08a8-ec7a-456f-9f33-4f29eb374d4e 先观察空页、再导航，回执准确包含“合成附件”，模型正确交付“有／合成附件（file input）”。26 项浏览器／工具测试、node 类型检查、主文件 lint 与构建通过；测试文件原有三个 lint error（未使用 mock 参数及两个空方法）未扩大修改。首次 1016AH 复测仍命中未退出的旧 PID72567，缺少新元数据并继续误答，已单独保留为无效新版验收；从原生菜单 Quit 且独立确认旧 PID 不存在后才重测通过。证据 `quality-review/1016AH-file-control/{old-process-attempt,after}.json`。同一原配置，未修改 Bot／群配置；浏览器完整 Windows／跨 frame 语义不据此宣称已测。

  - `browser.ts` 的 Page／Locator 操作复用 Playwright，不通过系统鼠标输入。Mac 原生宿主集成验证页面归属、中文输入、附件、确认框、下载、预览和窗口接管；浏览器／工具 15 项针对性回归通过。
  - 2026-10-13 用户提供的新 key 已通过官方接口，仅更新隔离配置。真实 MiniMax-M2.7 完成中文填写、上传 sample.json、提交及提示框处理、下载并再次观察 `saved`，交付名称／文件名／声明值与实际回执一致；独立读取下载文件与服务端回执比较通过，正式界面文件链接正确打开 JSON 预览。
  - 上传成功新增 `attached` 与附件名反馈，明确上传尚未提交表单，避免因无附件名的 ariaSnapshot 重复上传；单元与原生宿主集成验证通过。登录、Windows、崩溃及完整 Grok 对照仍由 P07.4／P07.5／P12 验收。
- [ ] P07.3 实现可见时按需预览、打开对应窗口、后台接管租约、归还后重新观察。
  - [x] ~~补齐 Grok `request_box_help` 对应的主动请求协助：模型在已观察页面请求用户步骤，打开独立浏览器，聊天显示操作说明和“归还并继续”，归还后自动重新观察。~~ 1013AG：新建默认 Bot、真实 MiniMax 实际调用独立 `bot_request_browser_help`；用户确认看到了“合成资料验收”窗口，手动输入后归还。工具新观察返回字段值 `111`、页面“尚未提交”，Bot 准确报告 `111`，任务 completed；输入值未提前写入任务，未由模型代填。此项仅证明人工输入与归还续跑，不代替外部网站登录或 Windows 验收。
  - [x] ~~Mac 真实 MiniMax 在人工接管期间等待；归还后恢复同一任务，重新观察人工修改后的页面。~~（1013Q／1013Q2：通过接管面板导航到带 `#handoff=1013Q` 的本地合成页面，归还后实际报告标题与新 fragment；独立浏览器窗口中的原生键盘输入未在本轮验收。）
- [ ] P07.4 验证任务取消／超时、窗口关闭、浏览器崩溃与恢复，旧页面／租约不能继续操作。
  - [x] ~~1018CI 多 Bot 页面关闭的作用域复核。用已有 BotBrowserService 测试复现“关闭 A、B 正常继续”及“关闭自身目标不得返回旧观察”；仅复用现有页面身份、退役集合与接管版本保护修必要接线，不新增锁／队列／超时或修改原工作台浏览器。对照原 CMB 只关闭实际 session、Hermes 的任务／会话归属检查及 Grok 私有操作目标边界；这些参考不视为具有相同实现。~~
    - 先复现3个实际反例：A关闭导致B排队输入被拒绝、A原生关闭及删除导致B在途观察被拒绝。首阶段40项通过后，继续扩查又复现“读取页面标题期间自身页面关闭仍返回旧观察”（1失败／40通过），曾收回完成标记。最终仅修Bot浏览器10行（新增7／删除3）：单页关闭／单Bot删除不再推进全局版本；复用原退役集合，在最后一次异步读取之后检查控制权、Bot归属和精确页面是否关闭。真实接管／归还、整个浏览器退出及旧页面拒绝保护保持，无新状态、监听器、锁、超时或额外页面读取。原35项加6个竞态／负例共41项浏览器测试、相邻Host／工具／服务／Runtime适配合计190项、node类型、变更文件lint及最终正常构建通过；首阶段和后续失败证据均保留。
    - 最终正常退出26613及全部7个所属进程后才构建；同配置重启853条任务及全部消息头保持，无重放。真实DeepSeek 5975330e…／MiniMax 2ee3ca83…各仅navigate／fill／close一次、零工具错误，使用不同的精确pageId；真实回执分别含CI_DS_CONFIRMED／CI_MM_CONFIRMED、尚未提交及各自关闭ID，合计25.75 CNY正确，本机服务无POST。此为正常浏览器回归，未冒称两模型恰好命中并发竞态；竞态由上述确定性用例证明。最终855任务、0活跃控制任务，38 Bot／10群／9例行／27命令及258份既有工作文件／记忆完全保持，两数据库quick_check=ok；原mask39字符草稿逐字相同，恢复原BW-DS会话、298px侧栏和原窗口，临时服务已退出。证据quality-review/1018CI-browser-close-scope/{review-final,task-windows,before,after-final-restart,after-final,source-and-build-final}.json与先失败／后通过日志。原工作台浏览器、公共锁及Agent Runtime未改；既有冷启动AX／画面刷新限制、Windows及完整P07.4仍待验。未commit／push。
  - [x] ~~1017BJ 页面renderer单独崩溃。~~现有browser-host-entry在render-process-gone时销毁对应窗口，BotBrowserService.page.close清理目标并唤醒接管等待；本轮沿用正常构建与实际双模型验证，不改崩溃恢复代码。仅在确认唯一活跃任务是本轮、宿主只有本次合成页renderer时，终止其精确子进程，保留主应用与宿主；核对等待结束、准确说明输入未完成、没有自动重开／重放。显式新任务在同一宿主打开正常页并读取、关闭；记录真实进程身份、请求、数据与草稿。不把宿主整体退出、模型自报或API close当作renderer崩溃，不覆盖Windows。
    - 正常构建实测：DeepSeek 1020ead2…／MiniMax 60856692…各navigate／request_help后进入waiting_user；确认唯一活跃任务与所属宿主后，仅SIGKILL该宿主的唯一renderer 89023／91344，主应用77373和宿主89005始终保留。现有render-process-gone销毁对应窗口、page.close释放等待；两个原准确pageId均返回closed／pages=[]，模型如实说明填写无法确认且未完成，没有重开页面或猜测原因。随后显式新任务27fc8669…／9363ac16…仍使用宿主89005，新pageId实际读取正确标题、空输入和未提交状态，各navigate／close一次。四任务均completed、0工具错误，故障前输入并未记为已完成；4GET／0POST。
    - 原656任务、36Bot、10群、9例行、21命令、228文件及3912旧消息头逐项保持；最终660任务／0活跃，两数据库quick_check=ok。故障后及最终均无遗留浏览器renderer，宿主按原生命周期继续驻留；mask原39字符草稿、80px折叠侧栏及关闭详情保持。只复用既有实现，browser／tools与BI验收哈希一致，engine／host-entry仍匹配HEAD，未新增生产代码。对照Grok box-handoff-resume的关闭后不假定步骤完成、Hermes _last_session_key丢弃失效目标原则，保持本机窗口与云桌面viewer边界；未机械移植云端恢复提示。临时HTTP服务88334退出143；首次服务查找因Python可执行文件带绝对路径而未匹配，未发出信号，修正精确脚本路径后退出。证据quality-review/1017BJ-renderer-crash/{before,ds-kill,ds-after-crash-processes,mm-kill,mm-after-crash-processes,models-complete,final-host,final,review,server-stop}.json、review.py及crash.py。仅完成Mac单一页面renderer故障与明确新任务恢复，Windows和P07.4其余范围仍单列；未提交／推送。
  - [x] ~~1017BI 真实导航超时与后续只读任务。~~使用正常构建及当前20秒导航超时，在本机合成服务只延迟响应、不向外网发请求；分别由DeepSeek／MiniMax只尝试一次导航，超时后如实报告错误，并仅观察／关闭本次页清理，不重复导航、填表或提交。核对实际ToolMessage为error、等待和浏览器队列释放、没有丢弃错误或虚报读取成功；随后明确交办正常只读任务，验证相同宿主仍能导航、读取和关闭。先复用原CMB工具错误回执、BotBrowserService.input及既有超时机制，发现真实退化才修改，不引入新的全局超时／重试框架。记录浏览器自身重试与模型调用的区别、原数据及草稿，不能由该20秒导航样例代替所有超时、取消或Windows验证。
    - 原始DeepSeek任务046ac664…实际navigate在20000ms超时，回执保留error；但没有返回已创建页面的pageId，模型随后observe又因未结束的导航在10000ms超时，最终说明无法取得标识而未清理页面。该轮不计通过，保留两份真实错误及失败产物。对照原CMB原生网页元数据读取、Grok保留isError且工具始终绑定既有目标、Hermes任务绑定session的边界，只给当前仍归属且控制代次未改变的浏览器操作异常附上现有pageId／实际URL，沿用error ToolMessage，允许按准确目标清理而无需再做DOM观察。不返回截图／页面正文，不触及其他Bot，取消、退出、接管改变或原BotError仍保留原语义；不加缓存、队列、重试或超时框架。
    - 修正后同题DeepSeek 76999f81…／MiniMax 379383a0…均仅navigate一次，保留20秒超时error并直接close回执中的准确pageId，无额外observe／重试／填写／提交；如实说明未读到页面。随后明确交办正常读取a54f3896…／2945bca8…，两轮各navigate／close、0错误，标题、空输入与未提交状态均准确。四个固定版任务主应用60608、宿主61523始终未重启；全轮5GET／0POST，原失败单列。新回归先1失败／34通过，修正后148项相关测试及node、定向lint、正常构建通过；没有修改共享Runtime、宿主或原浏览器引擎。
    - 原641任务、35Bot、10群、9例行、21命令、227文件及3864旧消息头逐项保持，固定版验收后646任务／0活跃。正常Quit两次分别确认8／7个所属进程全部退出；正常重启后既有数据保持、两数据库quick_check=ok，mask原39字符草稿一致，当前80px折叠侧栏及关闭详情保持。重启后另新增10任务／1Bot／1文件／18消息头，仅记为额外记录，未计入本轮通过；最终656任务／0活跃。校验脚本首次误把历史interrupted当活跃而失败，已按实际queued／running／waiting_user枚举修正，不修改历史数据。临时服务48944退出143。证据quality-review/1017BI-navigation-timeout/{before,models-complete,ds-fixed-host,final-host,before-normal-restart,final,normal-quit-check,review,server-stop}.json、review.py及/tmp/cmb-1017BI-{red,green,node,lint,build}.log。仅完成Mac本机导航超时、准确清理及后续读取，不代替全部超时／取消、renderer单独崩溃、Windows或整体验收；未提交／推送。
  - [x] ~~1017BH 接管等待期间的真实宿主异常退出与重新连接。~~既有1013R只证明宿主退出后MiniMax能启动新宿主，本轮补真实模型等待接管的终结。沿用正常构建、原BotBrowserService的context.close／generation／returned及原Electron启动器，没有新增生产代码、临时可执行文件选择或恢复框架。分别核对唯一活跃任务属于本轮、浏览器宿主确为主应用20563的子进程后才SIGKILL，未终止主应用或其他Bot任务。
    - DeepSeek任务2a456f1e…、MiniMax任务5119d45f…均先进入waiting_user，实际各navigate／bot_request_browser_help一次；宿主32776／34328被强制终止后等待结束，闭合回执指向原pageId、pages=[]，模型准确说明无法确认填写且工作未完成，没有自动重开或猜测故障原因。每次原宿主及3个helper全部消失，明确新交办前均无新浏览器宿主，主应用始终是20563。随后明确交办新只读任务bed7e8aa…／5b6092a2…，各仅navigate／close一次、0工具错误，新宿主34328／36776及不同新pageId实际读取正确恢复页标题、空输入和未提交状态。四轮completed表示本轮按要求完成报告／读取，不把故障前未完成的输入步骤记为已完成。
    - 四个真实任务、4GET／0POST，原637任务、35Bot、10群、9例行、21命令、227文件和3840旧核心消息头逐项保持；最终641任务／0活跃，两数据库quick_check=ok。正常Quit后主应用及恢复宿主共7个所属进程均消失，正常重启数据保持；mask原39字符草稿及详情恢复，结束时263px侧栏在重启后保持，没有强制覆盖成历史宽度。临时本机HTTP服务31725退出143；Engine与browser-host-entry源码仍与HEAD逐字节一致，原浏览器12行关闭回执修正未再改动。证据quality-review/1017BH-browser-host-crash/{before,ds-requested,ds-before-kill,ds-after-kill-processes,ds-before-recovery,ds-recovered-processes,mm-requested,mm-before-kill,mm-after-kill-processes,mm-before-recovery,mm-recovered-processes,models-complete,quit-check,before-normal-restart,final,review,server-stop}.json及review.py。仅覆盖Mac正常构建的宿主SIGKILL与显式新任务恢复，不覆盖renderer单独崩溃、全部超时或Windows，P07.4父项继续待验；未提交／推送。
  - [x] ~~1017BF 隔离原生窗口关闭补验。~~Node测试父进程启动原生产browser-host及原BotBrowserService，仅使用隔离合成profile与本机只读页面，一个可见Electron窗口由电脑工具按精确应用路径确认标题“Bot原生窗口关闭核验-1017BF”后点击系统关闭；未用API关闭冒充。等待true→false、返回新about:blank及未重放说明、旧pageId／lease拒绝、同事页面与空输入保持、2GET／0POST均通过，测试exit0，子进程89914已退出。初轮已触发关闭，但脚本误读不存在的elements字段而失败；保留first-failure.log／fixture-first.mts，改按真实content及原页面输入值核对后重跑通过，生产代码未改。首次按泛名Electron选窗误启动另一安装路径的空欢迎页，未用于验收，已正常Quit并确认87981退出；后续均使用精确路径。证据quality-review/1017BF-native-window-close/{ready,result}.json、fixture.mts及/tmp/cmb-1017BF-native-close.log。只证明隔离原生宿主与服务恢复，不替代AY真实双模型／Windows整体验收。
  - [x] ~~1017BG 真实双模型原生关闭流程。~~沿用当前隔离预览、原Runtime／模型／浏览器服务与宿主，为电脑工具可靠区分主窗口和浏览器子进程，仅在受环境变量限制的临时验收代码中将子进程可执行文件改指同版本已安装Electron；不改页面、控制权、IPC、模型回执或权限。分别由DeepSeek／MiniMax打开只读合成页并请求人工接管，由电脑工具确认标题后点击系统关闭，核对自动结束等待、准确说明尚未完成输入、不重开旧URL／不提交、旧目标失效及数据保持。临时选择及诊断已撤除，正常重建及原草稿恢复。不把这一验收环境选择冒充原始同应用ID的电脑工具绑定问题已解决，Windows仍单列。
    - 原始DeepSeek任务6ab2f0a8…已实际进入waiting_user，电脑工具确认独立DS标题后点击系统关闭，最终completed且未重开URL／填写／提交；但原服务自动创建替代about:blank，模型随后额外调用一次close清理，与“关闭后不再进行其他外部操作”不完全一致，暂不计完整通过。对照Grok box-handoff-resume.ts区分显式归还／viewer-closed并先确认实际状态，Hermes browser_tool.py对失效session不自动重建；本地关闭页面与关闭云桌面viewer并非同一操作，不照搬云端提示。仅在原BotBrowserService的人控等待结束分支判断已无本Bot页面，直接返回关闭回执，不隐式创建替代窗口；正常归还仍重新观察，已有替代页仍可观察。不得因关闭声称输入已完成；保留取消／退出与旧目标校验，不改共享Runtime或浏览器宿主。先用真实服务回归确认无新页面／导航／输入／上传，再升级复跑双模型。
    - 修正闭环：原服务仅增加12行，未新增状态、锁、监听或计时器。新要求在旧代码上5失败／28通过；修正后145项相关回归通过，最终浏览器33项通过，覆盖正常归还、已有替代页、关闭后排队observe／navigate／fill／upload均不重放／不取文件锁，以及取消和退出不误报成功。同事页面身份也明确核对；补断言时曾遗漏旧peer变量的使用，node／lint已修正重跑通过，未隐去首次门禁失败。
    - 正式UI原题复跑DeepSeek任务642fa519…及同题MiniMax任务1764a614…均先请求接管，电脑工具按精确应用路径和独立标题点击系统关闭；两轮各仅navigate／bot_request_browser_help一次、0工具错误。回执closed与原pageId一致、pages=[]，没有替代页面或额外关闭调用；最终准确说明输入未完成／填写情况未知，没有声称用户已填写。全轮连同原失败只有3GET／0POST，未重开旧网址。原634任务、35Bot、10群、9例行、21命令、227文件和3820旧核心消息头逐项保持；最终637任务／0活跃，两数据库quick_check=ok。
    - 原生Quit后7个所属进程均消失，临时可执行文件选择源码精确恢复HEAD，正常构建不含验收flag／诊断且包含新关闭回执；同配置重启数据逐项保持。mask原39字符草稿、280px侧栏和详情页恢复，临时HTTP服务94588退出143。原生输入工具几次未写入草稿时未发送，改用聚焦后的原生setValue并逐字核对、点击正式发送按钮；数据库只新增上述3条任务。证据quality-review/1017BG-real-native-close/{before,ds-requested,ds-after-native-close,ds-fixed-requested,ds-fixed-complete,mm-requested,models-complete,normal-quit-check,before-normal-restart,final,review,server-stop}.json、review.py及/tmp/cmb-1017BG-{red,green,browser-final,node,lint,normal-build}.log。BF旧记录中的替代about:blank是本次修正前行为，不能继续当作当前合同；AY真实系统关闭的Mac双模型缺口由本项补齐，原同应用ID的工具选窗限制、Windows和P07.4整体崩溃／超时矩阵仍未销项。无再次提交／推送。
  - [x] ~~1017AY 原生浏览器窗口关闭（Mac双模型，后由1017BG补验）。~~原AY因电脑工具无法区分主窗口与子进程窗口而未通过，历史失败与正常归还记录保留。BG仅在临时验收环境选择同版本已安装Electron作为子进程，电脑工具逐一确认DS／MM独立窗口标题并点击系统关闭；原Runtime、页面归属、原生宿主及模型不变。旧页面移除、等待释放、关闭回执、未重开原网址及无代填／提交均已由真实回执与HTTP记录核对，修正了自动开替代空白页导致额外动作的问题。临时接线已撤除、正常构建及数据保持验证通过；未改公共窗口／GPU／辅助功能策略、未要求用户代点。原同应用ID的电脑工具选窗限制及Windows不由此视为解决，P07.4整体仍待验。
    - 实屏定位受阻：真实DeepSeek已navigate／request_browser_help并waiting_user，但重新打开后按bundle绑定仍只返回cmbdevclaw主窗口；原生Window菜单只列主窗口，没有精确浏览器标题，不冒险关闭主窗口。正常归还后模型重新observe，准确回答原页仍在；随后以单独清理请求关闭原页。此样本不是窗口关闭通过，MiniMax同题未启动。补充原服务单元门槛：关闭最后一个接管页时，挂起请求须被唤醒、只观察本Bot的新空白页、失效旧页面／旧租约不能输入或归还，另一Bot页面不得受影响；不新增生产机制。
    - [x] ~~1017AY现有服务关闭事件的恢复回归与现场清理。~~新增一个真实BotBrowserService单元场景，原18项浏览器回归及node类型、格式通过：等待回调true→false、返回本Bot新about:blank、同事页面仍开着、旧lease归还及旧pageId输入被拒、无旧导航／输入重放。无生产源码修改；定向lint的3个错误与HEAD stdin对照完全一致，位于原测试桩第19／66／67行，未称lint通过。真实DeepSeek 27643706…实际正常归还后observe；清理a82f70f3…只关闭原准确pageId一次，并明确答复“关闭窗口并未得到验证”。仅一次GET／0POST，603旧任务、35Bot／10群／9例行／21命令、216文件、3627旧消息头保持；605任务／0活跃、quick_check通过，合成服务终止，mask原草稿／窗口尺寸和220px侧栏恢复。证据quality-review/1017AY-native-window-close/review.json。此叶只验证服务层与清理，原生窗口关闭、MiniMax同题及Windows仍待验，父项不勾选。
  - [ ] 1017J 浏览器确认弹窗与预览队列。核对当前pageList在共用浏览器队列内await Playwright page.title，而后者实际评估document.title；先以本机合成confirm页面和真实DeepSeek，在弹窗未处理时打开电脑预览并检查后续操作是否仍可推进。尚未复现前不认定缺陷、不添加超时或新队列；若复现，优先对照原CMB同步网页元数据和Grok／Hermes弹窗处理。MiniMax仍为1017G的Token Plan额度阻断，单列待验。
    - 已真实复现：DeepSeek任务ef560731…导航获得页面651d58ce…及正确标题，点击返回未处理confirm；打开电脑面板仍为空状态。选择“继续”后实际dialog调用进入但无ToolMessage，合成服务无确认POST。原停止入口将任务cancelled并关闭旧页后队列恢复。新增同队列回归在原代码1failed／16passed。对照原CMB getBrowserState的webContents.getTitle，沿用现有专用Electron宿主、精确target映射及RPC，仅增加原生标题查询，并跳过已知JS弹窗阻塞时的截图；不加第二队列／超时框架、不绕过确认、不改公共Runtime。Grok本地browser driver也使用page.title，故没有机械复制；Hermes的supervisor弹窗状态仅作边界参考。新版真实同题和回归通过后再记完成，MM／Windows保持待验。证据quality-review/1017J-browser-dialog-preview/{running,continued-blocked,cancelled-before-fix,before-review}.json。
    - [x] ~~Mac真实DeepSeek同题及最终等待提示。~~旧主进程24646正常Quit并确认消失后更新构建；f8bf0660…实际重做，confirm未处理时电脑面板已显示正确标题，继续后唯一dialog回执success、服务端仅一次accepted，completed且预览图恢复。补充dialogPending只描述当前目标的已知弹窗，沿用原预览状态／文案入口显示“网页有待处理的弹窗”，不暴露其他Bot、不新增计时器／队列或扩大工具权限。原生退出38409及宿主40074均消失后更新最终构建，1c4db0d9…再次实际完成相同五个工具调用，无工具错误、一次点击／一次确认；实屏先显示准确等待提示，继续后预览图恢复，服务端累计两条结果恰好对应两轮成功，旧失败没有确认结果。最后收起详情、输入为空，临时127.0.0.1服务31729已终止。全部27个Bot、7群、例行配置、原426任务状态／更新时间及135份旧文件哈希均未变；当前429任务／0活跃、quick_check=ok。新增回归先红后绿，邻近46项／最终Bot 51文件410项、完整node／web类型检查、生产触及文件lint、格式、构建及diff通过；原生宿主既有跨平台fixture增加五条弹窗前后断言，但尚未执行真实Windows runner，未混作本轮自动化原生验收。证据同目录{rerun-started,rerun-continued,final-running,final-continued,review}.json及/tmp/cmb-1017J-{before-tests,tests,final-bots-regression,final-types,final-lint,final-format,final-build}.log。用户本轮要求先用DeepSeek推进；MiniMax额度及Windows保留待验，父项不提前勾选，BV启动捕获仍单列。
  - [x] ~~Mac 强制终止隔离浏览器宿主后，面板清除旧页面，真实 MiniMax 可启动新宿主并重新观察页面。~~（1013R：宿主 PID 80460 被 SIGKILL 后，新宿主 PID 87846；实际返回“合成资料验收”、交付名称为空。）
  - [x] ~~1017AF MiniMax恢复后补验1017J浏览器确认框／电脑预览。~~当前MiniMax-M2.7在正式界面完成ae63e483…：navigate／click／dialog各一次、选择卡一次，等待时电脑面板显示正确标题及“网页有待处理的弹窗”；点继续后原dialog回执包含“已确认一次”，服务端恰好一条accepted=true，无重复点击／确认、命令或文件／记忆工具，任务completed。实时预览恢复；独立收尾e5606086…只关闭精确页面一次，空态恢复。正常Quit主进程50603（exec exit0）、原浏览器宿主11506及全部已记录子进程均消失，合成服务61921已停止；同配置重启主进程16207后514条任务、33Bot、8群、9例行、21命令、194文件哈希及3206条核心消息头保持，确认卡仍已回答、结果与关闭记录可读，无重放。三条已打开核心线程仅updated_at前进，已保留差异，不宣称所有核心行逐字相同。修订README成果卡重开读到新“13条记录”说明，Escape返回卡片焦点；代码块总数未由AX直接读到，实际CLI／文件哈希另有证据。恢复AE群空草稿、80px侧栏与详情关闭；两个数据库quick_check=ok。证据quality-review/1017AF-minimax-browser-dialog/{starting,continued,final,before-restart,after-restart,final-storage,restart-comparison,review,quit-check}.json。旧1017J的MiniMax额度限制已由本次本机样本补验，Windows／其他网站及启动BV／整体UI动画继续待验，本轮沿用原实现、无生产代码改动。

- [x] ~~1017AL 本机合成登录态持久化：先复核原CMB持久浏览器partition、Bot专用Electron userData及Grok box-chrome／Hermes共享profile的所有者边界，再用127.0.0.1合成页面实际验证。DeepSeek通过一次登录按钮建立仅本测试可用的持久cookie；MiniMax在自己不同页面访问受保护页面，随后正常退出／重启再分别读取，核对服务端实际认证状态与登录次数，无需用户真实账号。若持久化失败，先定位原生退出／cookie落盘链路，复用既有生命周期能力做最小修正；不导入日常浏览器或读取其他站点凭据。仅覆盖本期专用浏览器共享会话和正常重启，不等同于企业SSO、多因素登录或Windows验收。~~

  - [x] ~~Mac双模型合成登录、独立页面复用、正常重启与退出同步。~~正式DeepSeek任务1fe79ff3…仅navigate／click，首次未登录、只点一次登录；MiniMax65197fd9…仅navigate，在不同pageId实际读到同一身份／项目。原生Quit主进程41330且原9进程均消失、exec exit0；同配置重启560任务、定义／205文件／核心消息头逐项一致。DeepSeek41b5821d…、MiniMax74750e81…各仅navigate，两个新pageId仍实际已登录；服务端登录POST始终一条。MiniMax清理ca9df437…只退出一次并关闭精确页面，DeepSeek4bf516f8…刷新自己的页面后实际未登录，再关闭；服务端退出POST一条、受保护认证读取恰好四次。六任务全completed、所有工具success／仅bot_browser，原558任务和原核心消息头、34Bot／9群／9例行／21命令及205文件不变，无新文件／记忆，0活跃。原群“@”草稿及资料库详情退出前已恢复；本轮服务已停止，未读取或导出cookie／其他站点凭据，没有改生产代码。证据quality-review/1017AL-browser-login/{both-before-restart,restart-comparison,both-after-restart,models-completed,review-models}.json及requests.jsonl。仅证明合成持久cookie及本次正常退出，不代替企业SSO／MFA、崩溃或Windows。
  - [x] ~~1017AL 短间隔落盘门槛：当前宿主quit路径调用app.exit，原生集成脚本此前只验证同profile能重新启动、没有验证新cookie保存。仅扩展既有合成HTTP fixture，在收到带Max-Age的合成cookie后立即关闭原服务，再用同profile新宿主访问/session核对signed-in；不人为flush或等待掩盖生产行为。先保留实际失败／通过结果，再决定是否需要最小生命周期修正，不能由前述正常使用数分钟的模型样本推断该边界。~~
    - 原生用例已通过：同profile第二宿主启动被拒绝，原宿主继续完成输入／上传下载／弹窗／接管；新持久cookie设置后立即close，再用同profile重开后真实HTTP读取signed-in。只扩展原tests/bot-native-browser-host.spec.ts约20行，未修改生产宿主或加入人工flush／等待。Mac隔离构建与两次原生运行均exit0，最终含第二所有者负例的测试SHA与原工作区完全一致；该用例由既有macOS／Windows CI job复用，Windows runner尚未运行。格式检查通过。最初原项目构建因生成目录out/resources/mods/function-commands 2/.claude-plugin的dataless条目阻塞，采样证实分别卡在remove_all／rename，已终止对应进程且保留样本；同提交临时工作树构建通过，仅同步测试、未复制配置或凭据。旧生成目录在同项目内移至dist/generated-quarantine-1017AL保留后，原项目正常构建exit0且无bots-browser-e2e.js，原配置预览已恢复并实屏核对“@”群草稿／资料库详情／295px栏宽。558旧任务、全部配置／205文件及旧消息头最终保持，564任务／0活跃，两数据库quick_check=ok。原生门槛及构建恢复证据见同目录native-review.json、isolated-build.json、generated-directory-recovery.json及/tmp/cmb-1017AL-{native-result,native-owner-result,normal-build,native-format-final}.log。首次清理审计误匹配自身shell命令，已按真实可执行文件修正、确认无fixture宿主残留，原始误判保留于native-review；无需生产补丁。企业SSO／MFA、cookie失效／崩溃及Windows仍未验收，不扩大为P07全部完成。

- [ ] P07.5 Mac、Windows 验证窗口激活、中文原生输入、安装资源路径及 profile 清理。
- [x] ~~P07.6 群任务中每个 Bot 保留独立页面，使用群工作目录，复用预览／人工接管，并验证群删除清理和私聊隔离。~~
  - 已接入同一 BotBrowserService、BotBrowserPanel 和 IPC，主进程校验真实群与成员身份；群成员页面彼此独立且不复用私聊页面，下载保存在群共享目录。相关 82 项 Runtime／Host／浏览器／IPC 回归通过，覆盖跨成员输入拒绝、私聊文件拒绝、群文件上传、删除 Bot／群后关闭所属页面及拒绝迟到请求。
  - 2026-10-13 实屏：核心验收 Bot 的群页面导航到“合成资料验收”，归还后切到协作核验 Bot，显示无页面；切回核心验收 Bot，保留原预览且控制状态为 Bot。模型自动浏览与下载的完整交付仍由 P12 验收，本项勾选不代表 P12 完成。
  - 后续真实 MiniMax-M2.7 双成员群任务通过：各自导航同一 URL、填写自身名称并重新观察。两份实际工具结果的 pageId 不同，输入分别为“核心验收 Bot”与“协作核验 Bot”；成员任务均完成，右侧切换显示对应页面。群内来源提示未误拒绝用户请求；私聊历史未新增群任务。

### P08 — 资料、技能与成果

- [x] ~~P08.1 复用原资料与成果能力，提供上传、列表、预览、下载和可定位的文件引用。~~
  - [x] ~~Bot 完成任务后，已打开的资料库自动更新成果列表，无需手动刷新。~~（1014F）真实 MiniMax 创建、读回并交付 `边界核验结果-1014F.md` 后，该文件自动出现在持续打开的右侧资料库；未切换页签、未刷新窗口。刷新依赖本会话终态任务键，复用既有有界扫描与取消接口；群组接线覆盖成员线程的终态，群自动刷新实屏继续验证。
  - [x] ~~群任务完成后，已打开的群资料库自动更新；新成果可预览、保存，导出与源文件一致。~~（1014H）真实 MiniMax 任务 `3d28c1b2-bd56-45a3-b598-ca42321229b3` 经群成员单次写入审批后 completed，群时间线交付 `群资料核验-1014H.md`，持续打开的资料库自动出现该文件。预览显示“群资料验收：50.75”；原生保存到隔离目录后，23 B 副本与群工作区源文件 SHA-256 均为 `79da901454e3e0d5a6f6b6a43d7feb2293bba4e67fe5fae283b66938d069b62b`。
  - [x] ~~真实模型创建中文／空格文件名、重新读取，资料库列出真实文件，对话链接打开 Markdown／CSV 内容。~~（1013L；空格链接兼容修复后重启实屏通过）
  - Mac 正式界面“保存到本机 → 原生保存框 → 添加资料 → 原生选择框 → 列表更新”通过；源文件、导出文件、重新导入副本和分享副本 SHA-256 完全一致。文件范围及符号链接拒绝仍复用已有文件测试；Windows 原生对话框单列 P11 验收，本项不代表跨平台已验收。
  - 1013L 同题 Grok 补测：官方服务恢复后已完成任务，实际打开 Markdown 预览核对三项数据、合计 50.75、草稿多算 2.00。官方提供独立文件卡片及预览内下载入口；本地报告与 CSV 已核对，文件卡片的表现仍是 UI 差异。现已复用原 exportFile 为私聊／群文件预览增加保存按钮；允许当前工作目录内的绝对预览路径，保留 realpath、符号链接和成员身份校验。IPC／真实文件路径 9 项测试、typecheck、build 通过；1013V 预览内保存到 Mac 原生对话框通过，导出与源文件字节一致。群文件同一接口覆盖，Windows 仍待验收。
- [ ] P08.2 复用现有技能选择与执行；共享目录授权明确，同项目写操作沿用并发保护。
  - [x] ~~1018CG 原技能选择与真实双模型执行补验。对照 Grok 手动技能附加和 Hermes 技能按需读取，核对本项目原选择器、可信用户技能标记及原 Runtime 技能解析／生命周期；复用已有 skill-creator，不新增技能存储或执行器。正式输入框选择技能后，由 DeepSeek／MiniMax 分别执行有限需求澄清，核对真实 SKILL.md 读取、持久用户消息与输出；取消选择后技能标记不得残留，原草稿／身份／配置保持。~~
    - 正式输入框附加同一现有技能，DeepSeek 893c7e7f…／MiniMax a960b5af…均 completed，各仅一次成功 read_file，路径确为登记的 skills/skill-creator/SKILL.md；持久用户消息与控制任务均有同一技能标记。两者分别读取前400／100行，均含本次需求澄清步骤，实际回答均覆盖输入、触发、交付／验收三个方面；不据此声称482行全文或创建技能流程已执行。选择后移除技能保留文字草稿，DeepSeek 97d0c671…／MiniMax dff34864…分别只回复43／47，均零工具调用、持久消息无技能标记，无重复提交。仅4条为本轮合成任务；其余新增5条属于用户此前的Grok Build探索／后台回执，保留且不计为本轮验收。
    - 38 Bot、10群、9例行、27命令定义及258份既有工作文件／记忆逐项未变，旧任务与旧消息头保持，0活跃控制任务，两数据库 quick_check=ok；6份相关源码及398份正常应用产物哈希未变，未新增生产代码。原 Runtime 接线53项测试、原技能协议9项及原斜杠UI测试通过。部分电脑工具出现AX／截图滞后、失效控件，原生Zoom后继续并恢复原窗口；保留此验收限制，不加入生产重绘补丁、不以工具无响应判定产品缺陷。证据 quality-review/1018CG-skill-selection/{review,task-windows,before,after}.json 及正式输入／结果AX记录。官方云端试用已到期，本轮仅复用源码与此前UI对照，不宣称官方同题新实测；全部技能类型、群共享写互斥、Windows及P08.2整项仍未完成。
  - [x] ~~Bot 输入框通过原 `/` 技能选择器选择现有 skill-creator，真实 MiniMax 读取原 SKILL.md 并执行需求澄清，显示技能标识及真实读文件记录。~~（1013T，按要求提出三个问题；未创建／安装文件。）共享目录并发与全部技能类型不以此单项替代。
- [ ] P08.3 验证协作附件可访问且不泄漏非授权文件，取消／失败仍能展示已有有效成果。
  - [x] ~~1016BY 私聊文件交接的工具契约修正。~~BW2接收方只回文字路径，未产生可供Host附带的真实交付引用；返回方直接将同事目录传给交付工具被正确拒绝，随后才复制恢复。保留现有Runtime、Host／outbox及路径校验，以结构化outputFiles声明和主进程实际文件校验补齐引用，只向本次私聊返回轮次提供精确文件的受管导入；复用既有稳定句柄、流式复制及原子落盘，不新增共享文件引擎、不从模型文字授予目录访问权。双向真实模型及重启复验结果见下；本项仅关闭文件交接缺陷，不代表全部交付质量、权限隔离或Windows已验收。
    - 首次修正实测：两方向各三条任务、共6条均completed，最终附件741B／744B正式打开，独立Decimal合计10.11／20.05、差额0.10／-1.00及双方副本SHA一致；交付工具没有再发生越界路径错误。DeepSeek接收方实际read/write/deliver，MiniMax接收方b792557d…仍只有read/write并回文字路径，未产生Host可附带的真实文件引用，故本项继续未完成。原失败和该差异均保留于quality-review/1016BY-private-delivery-contract/{both-delivered,review}.json；不把发起方最终恢复交付作为整个协议已闭环。
    - 参考源码复核：Grok的source/host/runner/tools/send-message-tool.ts用显式attachment调用，resolveAttachmentSource经ingest／box处理文件；Hermes的tools/send_message_tool.py区分正文与媒体、过滤交付路径，gateway/run_turn.py另行交付流式回复的附件，不将流式文字完成当附件完成。原CMB的turn-completion-integrity只检查协议／待办，不检查语义文件完整性；当前copyBotFile／稳定句柄可复用。旧版deliver-file-tool.ts使用task-visible artifact ID及实际publish，依赖旧artifact体系，不整套搬入beta。沿用现有显式文件引用，将私聊本轮交付规则放在提示末尾并明确“同事要求返回路径也不能省掉实际交付”；下一轮真实复验前不宣布彻底解决。
    - 第二轮仅提示修正仍未闭环：5baa0bfa…MiniMax接收方再次只read/write，没有交付工具；两方向最终虽都交付且无越界错误，不据此通过本项。按用户要求停止其他项，补明确的结构化输出契约：bot_delegate声明outputFiles（无文件用空数组），沿用origin_json存储、原请求去重及outbox；主进程在协作成功结束前复用交付工具的同一稳定句柄校验生成真实文件引用，缺失／越界／取消不判成功，不解析模型正文、不扫描工作区、不新增附件库。相同requestKey改变文件要求拒绝；兼容已有未声明输出的旧任务。群输出沿用现有publishGroupFiles且不重复发布已交付路径。代码已接入，待边界测试与最终双模型实测，不能再以提示或单轮成功划掉。
    - 文件转交继续按Grok resolveAttachmentSource的受管导入思路，复用beta现有botImportDestination／copyBotFile：Host将本次已验证文件引用随原outbox的origin_json携带，只为该私聊结果绑定明确原件与来源Bot工作区；交付工具可导入这些精确原件并交付自身副本。未获引用的同事文件、目录、外部路径及换向符号链接继续拒绝，群共享任务不获得私有导入范围。复制沿用流式大小限制／稳定inode／原子落盘，新增可选AbortSignal接入已有pipeline，不读整文件入内存、不新增传输服务。接收方遗漏显式附件调用与发送方直接使用合法原件路径这两处都通过程序接线处理，再分别真实双模型复验。
    - 最终新版双向实测通过文件交接：MiniMax→DeepSeek→MiniMax（439139d1…／fc304561…／984b0430…），DeepSeek→MiniMax→DeepSeek（4cd91326…／f5f722ae…／25e60ae1…）恰好6条completed任务、0工具错误、无execute复制命令或重复交办。两次初始bot_delegate均携带outputFiles；MiniMax接收方仍只read/write/read，但Host实际校验生成真实引用，返回方直接以获准同事原件路径调用交付工具成功导入自身副本，未再遭越界拒绝。两份767B／744B成果卡正式打开，独立Decimal合计6.60／20.33、差额-0.10／0.03正确，原件与副本SHA逐项一致。18次实际MiniMax-M2.7／DeepSeek-v4-flash响应均HTTP200；22个测试文件226项、完整node／web类型检查、格式和构建通过。完整lint仍有已核对HEAD即存在的file-copy控制字符正则及host测试告警，不冒称全量lint通过。
    - 正常Quit确认旧主进程40460消失后，以同配置启动94741；两份导入副本再次从正式成果卡打开，数据／哈希保持，六条任务状态和更新时间不变、385任务／0活跃，无重复执行。原27个Bot、群／例行配置及130份跟踪旧文件未变，quick_check=ok，退出及重启日志未见Database is closed。证据quality-review/1016BY-private-delivery-contract/import-check/{both-delivered,review,before-restart,after-restart,restart-review,model-responses}.json。MiniMax返回轮实际先bot_deliver_files再read_file，未严格遵守“先读再交付”；报告仍有文字瑕疵，保留为交付质量差异，不能据传输修复把P08.3／P12父项划掉。两轮仅提示修正未通过及结构化契约首轮缺字段重试证据均保留，不以最终成功覆盖失败。
  - [x] ~~1016BW 混合模型私聊文件交接的两个方向实测。~~MiniMax→DeepSeek→MiniMax（c3d0230b…／cc30345e…／b83ff39d…）与反向（a3e227df…／7fd11cb7…／7cc3b38d…）各恰好三条任务，均completed，无重复交办或轮询。双方最终743B报告卡均在正式界面打开：35.75、草稿偏高2.00及77.75、草稿偏低0.05正确，接收方原件与发送方副本SHA逐项相同；两个67B输入不变，原27个Bot、群、例行配置与21份既有文件不变，359任务／0活跃，quick_check=ok。第一方向发送方读取CSV后将授权内容转述，接收方据此生成报告，没有独立重读原件；反向接收方实际读取原件，但只返回文字路径、未调用交付工具，发起方自行读报告和原件。其直接交付同事目录第一次被范围校验拒绝，随后复制至自身目录并成功交付；此前提前声称附件、部分英文进度与报告错字均保留，不能认定首轮无误或交付质量全面达标。没有扩大文件权限或新增交接引擎；本项不代表OS文件沙箱或远端传输。证据quality-review/1016BW-private-handoff/{before,both-delivered,files}.json及双方正式预览，原失败回执保留。默认视图暴露交付失败工具卡另列BX修正，P08.3父项保持待验。
  - [x] ~~1016BH 群内双模型附件与成果同题复验。沿用“资料核验-1015AE”现有DeepSeek／MiniMax成员与共享工作区，从正式群输入框导入新的合成CSV，以真实@所有人节点派发；各成员独立核验重复ID、无效日期及金额，分别交付以自身名称区分的Markdown报告与逐日CSV，不能互相代写或修改旧资料。检查稳定收件ID、恰好两条任务、实际模型、附件原件／共享副本、数值与拒绝原因、成果归属和可打开内容。再按实际情况对照官方Grok的同题核心流程，保留其模型与环境差异；未完成不得按“模型自称正确”或已有历史样例划掉。本项不替代附件拖拽、故障注入及完整权限隔离验收；若发现问题，先定位并复用原实现，只修必要接线，再分别复测两套模型。~~
    - [x] ~~CMB正式群输入与双模型交付复验。~~真实@所有人派发恰好两条任务：DeepSeek-v4-flash的d338c61f…、MiniMax-M2.7的eb048089…均completed，路由及HTTP200已核对。两者分别交付以自身完整名称区分的报告和逐日CSV，四张成果卡均正式打开核对：7行中有效5、拒绝2（重复t03、无效公历日期），收入25.85、支出25.03、净额0.82，逐日CSV与派发前固定预期完全相符；附件共享副本215B及SHA与原件相同，群配置和3份原记忆哈希未变，无活跃任务。原输入files_json为空，附件实际沿用消息序列化和共享原件；不误判为未发送。DeepSeek计算使用Number/toFixed，本样例通过不能证明任意金额精度；未做全目录旧文件哈希、拖拽、故障或Windows验收。当时官方同题已在原合成群发出，后续核对见下一子项。证据quality-review/1016BH-group-delivery/{before,started,cmb-delivered,grok-started}.json及cmb-first/。
    - [x] ~~官方Grok同题流程及原件对照。~~现有合成群添加交付核验-1016AU后实屏确认两位成员；同一215B附件、同题正文和真实@所有人只发送一次。通过原生保存下载四张原成果卡：两份CSV均与固定预期和CMB结果字节一致；交付核验报告7/5/2正确，结果核对助手首报告实写6/5/2，随后Bot间主动讨论并文字纠正为7，但最终未见新的更正成果卡，故不认定修订文件已交付。另第一位Bot的CSV卡显示另一位名称，保留界面事实，未窥查云端执行记录或推断原因。对照完成不代表其缺陷应复制，也不能由本样例证明CMB整体优于Grok；官方云模型未独立确认、两边环境与历史不同。其他群jie'zh草稿保持。四份下载原件及SHA见quality-review/1016BH-group-delivery/grok-first/、grok-delivered.json。本轮无生产代码改动；P08.3完整权限／失败／取消父项继续待验。
  - [x] ~~私聊协作成果引用随自动回执返回，发起 Bot 复用原工具复制、验证并交付可打开的报告。~~（1014L／1014L2）首轮发现接收方已生成报告但回执只有文字，发送方找不到文件；现从本轮真实 `bot_deliver_files` 输出采集有界引用，沿用原终态／outbox 事务，不从模型文字猜路径、不扫描目录、不另建附件存储。复验三个任务 `b93b5d94-bac1-40f6-b19f-db66a14601fc`／`49a7b658-c347-491c-ba70-451653d8460d`／`c7f9ec5c-617c-4116-8aaf-c395009c85bc` 均 completed，只有一次交办、一次自动回复；发起方卡片实际打开 145 B 报告，显示原文件名及金额 50.75，两端 SHA-256 同为 `edc60f691ee90b7ffd4eed9369d926fbaa77171ace02d5006cb3e364b1d5a1e1`。80 项 Runtime／Host／工具／历史测试、node 类型检查及构建通过。模型首次 cp 漏加空格路径引号、报错后自行修正并再次单次审批；记录为质量差异，不宣称首次无误。这里只验证本机用户明确授权的指定原文件／报告；不代表 OS 文件隔离或远端文件传输。
    - 1014M 用全新 CSV 排除旧结果复用：接收 Bot 的实际 read_file 读取新原件，报告列出 3 笔 17.25／24.50／-3.20，合计 38.55；发起方复制后实际预览相同报告。三个任务 c7fb4c0f-32fd-432b-88bf-ee3266fa9946／c8bc005e-ada4-4ecf-865f-083fc9e5e5e6／2a91730d-0485-4066-959e-28fa15ae57f3 均 completed；此次复制首次正确，只有一次交办和一次自动回复。两端文件均为 224 B，SHA-256 `0c7172092dbb60ce51d310a00d64aa65ada2aafef9cc713f244923171f0a01ae`。原始 1014L2 复验只读取了报告，未重新读取旧原件，因此独立读取新输入的证据以 1014M 为准。
    - 最近工作摘要只显示协作结果正文，内部文件引用附录继续完整保留在任务／协作记录中；不改原始消息。49 项文件契约／Host／任务预览测试、web 类型检查与构建通过，Mac 重载后确认摘要不再堆积路径 JSON。
  - [x] ~~群资料通过正式分享入口复制给私聊 Bot，接收者实际读取自己的副本。~~（1014D）群“附件新群-1013AN”将 41 B `attachment-1013Y.csv` 分享给“外观核验-1014A”；真实 MiniMax 任务 `55c94e1e-6d27-407c-b908-2f755ae879f0` completed，实际查找并读取私有工作区中的副本，报告 3 条记录与合计 50.75。源文件与目标副本 SHA-256 一致，来源群目录不作为接收者工作目录；不代表任意文件系统访问均被沙箱隔离。
  - [x] ~~重启后根据群内既有成果继续处理并交付新附件。~~ 1013AL：真实 MiniMax 任务 `d55a5d15-0a24-4ca9-a0f5-ef6f69371330` 读取群内 JSON，经原 Runtime 单次写入审批，交付 64 B `群核验结果-1013AL.json`；群时间线展示实际作者与附件卡片。文件中 name=111、total=50.75、checkedBy=协作核验-1013AJ，原文件内容未变。该任务验证群文件引用与续办，不代表全部协作隔离及跨平台验收完成。
  - [ ] 群输入框直接选择／拖入附件并随消息发送：复用原附件解析、消息序列化及草稿状态，导入群共享目录；切换群、发送失败、成员退出和窗口关闭时不丢草稿或把附件绑定到其他群。
    - [x] ~~1017L DeepSeek续验原生选择附件与草稿恢复。~~复用已有资料核验群、原附件解析与持久草稿，系统选择框导入中文／空格名“群附件 1017L 核验.csv”（35B），真实@只指定DeepSeek成员；切换到合成私聊时输入为空，返回群后附件／文字／收件人保留。正常Quit PID10951且ps确认退出后重启同一配置，待原群与成员实际加载后再次观察完整草稿；首次加载快照短暂未显示提及，完整AX及截图随后显示原提及，不误报丢失或提前发送。正式发送恰好一条DeepSeek任务fc8ed661…，completed，实际read_file／write_file／read_file／bot_deliver_files各一次，无工具错误、无命令或同事任务；原件及群副本字节一致，684B报告成果卡已打开，3行逐笔金额与独立Decimal合计7.40正确，成功后原群草稿清空。原Bot／群／例行配置、444份旧任务及已跟踪旧文件不变；0活跃、quick_check=ok。未改生产代码、未替模型修报告、样例未删除；英语开场进度保留为体验差异，BV启动仍需原生缩放恢复电脑工具可读页面。拖拽、失败注入、成员退出及Windows继续待验，不以本项替代；P08父项不勾选。证据quality-review/1017L-deepseek-group-attachment/{before,before-restart-draft,sent,delivered,review}.json。
    - [x] ~~1017M 群草稿收件成员被移出后的实际保护。~~已有合成资料核验群中形成仅@DeepSeek成员的读取草稿及同一CSV附件；正式群设置临时移出该成员后，原草稿、附件及稳定提及仍在，明确显示“提及的 Bot 已不在本群，请移除该提及后重新选择。”发送禁用，实际回车也未发送：任务数仍445、旧任务逐项未变，没有转发给其余MiniMax成员。正式编辑器恢复原名称、成员ID及顺序，群version按两次实际保存由5→6→7，不谎称全字段未变；错误消失、原草稿重新可发。之后只产生DeepSeek任务aa17b3c9…，completed，一次read_file、无其他工具，实际回复3行／7.40且草稿清空。原445份任务、Bot／例行及其他群配置、已跟踪旧文件均不变；仅新增35B原件副本且字节一致，没有新报告或记忆、0活跃、quick_check=ok。复用现有groupMessageRecipients／sendGroupDraft／版本保护，未改生产代码；不同于等待审批成员取消验收，不替代任意执行中操作回滚、删除或Windows。证据quality-review/1017M-group-draft-member-change/{before,removed-blocked,restored-before-send,completed,review}.json。
    - [x] ~~正常退出／重启后恢复群草稿文字、附件与指定收件人；恢复不自动发送，成功发送后不再次恢复。~~（1014N）先在官方 Grok 合成群确认未发送文字在重载后保留；本地复用原待发消息按会话保存的方式，按主机／群保存有界草稿与重试标识，沿用原群发送幂等接口。实际退出 Preview 并确认进程结束后重启，文字、46 B CSV 附件、仅选中的 AP 均恢复；发送前无该任务，发送并重载后仅有一条任务 `cd5de6fc-b11b-48a2-b26d-2f95d7f25784` completed，输入框和附件清空。MiniMax 根据恢复后的附件正文正确返回 3 行／50.75，本次没有额外调用 read_file；保留副本与源文件 SHA-256 均为 `b9d5087e0cd491937ca569f5b2f33b60232d03e07fe3973687d73401afcb4228`。9 项草稿测试覆盖未知回执原 ID 重试、存储失败禁止发送、成员／主机隔离及坏记录保留，消息回归、web 类型检查与构建通过。私聊草稿跨退出、拖拽和失败界面仍未由本项覆盖。
    - [x] ~~原生文件选择、群／私聊切换草稿隔离、指定成员执行、读回与群成果预览。~~（1014J）从群输入框添加 `群输入附件 1014J.csv`，切到私聊再返回，文字、附件和仅选中的 AP 成员均保留；私聊无群草稿。真实 MiniMax 任务 `6ecd7ce7-fcdb-4479-a5ec-013bfcabdc3d` 在共享群工作区完成写入审批、读回并交付 160 B 报告，群卡片预览显示原文件名、3 行、50.75；原 CSV 与共享副本字节一致，SHA-256 `b9d5087e0cd491937ca569f5b2f33b60232d03e07fe3973687d73401afcb4228`。拖拽、发送失败界面、窗口关闭仍待实屏验收，不因此勾选父项。
    - [x] ~~原生选择群附件、仅附件发送、双成员真实分析。~~ 1013AK：群输入框选择 41 B CSV；两位真实 MiniMax 成员均 completed，分别报告三条记录及合计 50.75，群消息只展示附件名称和用户要求。群保留副本 SHA-256 与原 CSV 相同；原附件解析、文件范围与重试草稿测试通过。拖入及完整切换／窄窗口实屏尚待验收，父项保持未完成。
  - [x] ~~真实附件交付：新增薄层 `bot_deliver_files`，复用工作区解析／稳定文件句柄，输出真实路径、名称和大小，沿用原 ToolMessage 持久化及卡片预览／导出。~~ 1013AI：自然交办后真实 MiniMax 实际交付两份已核验文件，Mac 卡片显示 47 B／30 B；JSON 打开显示 name=111、total=50.75，卡片导出副本与源文件字节一致。不另建附件数据库，不依赖模型重新拼写链接；私聊／群组分别绑定本轮工作区的接线、缺失、越界、越界符号链接和取消有定向测试。群组真实模型附件交付及 Windows 仍待验收，P08.3 父项保持未完成。
  - [x] ~~1016BI 群内双模型取消后的已交付成果。沿用现有混合模型群与真实@所有人，每位成员只新增自己的合成JSON，实际读回并正式交付后请求一次用户选择；在两者waiting_user时通过原群停止入口取消，核对恰好两条任务cancelled、既有成果卡仍可打开且内容／作者／路径正确，原群资料与私有记忆哈希不变。随后正常退出并重启原应用，用同一配置重新打开成果；不把“跳过”当作取消、不伪造失败、不新增运行引擎或存储。若真实交付或停止出现问题，只修必要接线，并分别用MiniMax／DeepSeek重验。此项覆盖实际取消，不替代运行失败或Windows验收。~~
    - 1016BI首轮发现真实阻塞，未按通过处理：DeepSeek的8c037e84…已交付并waiting_user，MiniMax的b81f4bf7…停在已发出的read_file且无ToolMessage。仅正式停止前者后，原read_file立即获得共享锁，日志记录等待86062ms，后者随即交付并waiting_user；之后通过群停止入口取消。两份原文件和卡片保留。此证据定位为群共享工具锁包住交互等待，不是模型不会读文件或页面卡死。成员执行记录另因复用ChatContainer的只读输入限制隐藏了待答卡，须单独接线，不放开自由发送。证据quality-review/1016BI-group-cancelled-delivery/{started,before-release-blocked,after-release}.json。
  - [x] ~~1016BJ 群成员交互等待的最小修复。沿用原工具锁和request_user_input：仅可信Bot群宿主启用一个默认关闭的选项，让无文件副作用的request_user_input不占群共享工具锁；文件／命令、子Agent和原工作台仍用原分类与锁，不新增锁超时或改审批机制。成员执行记录只允许响应原线程已有待答请求，输入框继续只读；复用原请求状态、回执和Bot提问卡，不新建问题通道。先用实际锁／中间件的定向回归核对“待答不阻塞另一成员、写操作仍串行、默认行为不变”，再分别真实MiniMax和DeepSeek跑新场景：两者同时waiting_user、各自成果已交付；逐一打开记录看见自己的问题，正常选择和取消不串答；停止及重启后的文件保留继续归BI验收。~~
    - 1016BJ新版真实复验通过：DeepSeek-v4-flash的fe4f7bf3…与MiniMax-M2.7的8dc89f04…各自写入、读回、交付新JSON，同时waiting_user；成员记录实际显示本人的问题，普通输入框仍禁用。只给DeepSeek选继续后，MiniMax仍waiting_user且无答案回执；再给MiniMax选暂缓，双方均completed，真实ToolMessage与最终回复分别是继续／暂缓，问题ID相同也未串答。第二轮5695a8da…／56745a57…实际读回并交付原JSON，同时waiting_user；正式群停止一次后两者cancelled，成果卡均可打开。原生Quit并确认主进程43428结束，同配置重启后两张取消成果再次正式打开、JSON与哈希保持，任务311→311、0活跃任务，旧12份群文件、3份记忆及群配置未变。最初BI因锁阻塞未同时待答的失败保留；BI原两份成果也已重启打开。39项实际中间件／适配器回归、完整node/web、messages、workflow、build和新测试lint通过；旧concurrency源码形式检查有2项失败，在未改HEAD独立副本同样复现，不报告该组全通过。未新增轮询／计时器／状态存储，不改锁超时、浏览器接管锁或审批。证据quality-review/1016BJ-group-user-input/{before,started,after-deepseek-answer,answered,cancellation-started,cancelled-before-restart,after-restart}.json及1016BI-group-cancelled-delivery/。Windows与运行失败场景继续待验。
  - [x] ~~1016BK 取消后的准确群状态文案。1016BJC真实任务已有可打开的阶段成果，但Store的无最终回复兜底写成“已停止；没有可确认的结果”。沿用原botTaskStateLabel，仅将cancelled且无实际结果／错误的群兜底改为准确的停止状态，不查询文件、不改终态、通知、附件及旧历史；已有真实错误／结果仍优先。复用现有群成果保留用例，再用MiniMax、DeepSeek分别读回并交付已有合成JSON、等待选择后正式取消，核对新消息、附件及哈希。不要为文案新增状态或执行链。~~
    - 新版真实DeepSeek任务5458596d…及MiniMax任务2f18a1b6…均实际read_file、bot_deliver_files后request_user_input，同时waiting_user；原群停止后都cancelled，新终态消息均为“已停止”，旧历史未改，两份文件卡仍正式打开并显示正确JSON，14份群资料和3份私有记忆哈希未变，任务311→313、0活跃任务。67项Host／Store回归、node和构建最终通过；首次测试断言误放私聊fixture的失败日志保留，已挪回原群文件用例并重跑。证据quality-review/1016BK-group-cancel-copy/{before,started,after}.json。无额外查询、轮询或状态。
  - [x] ~~取消后的阶段成果保留：真实模型写文件并读回，在等待选择时停止；重启后原工具记录仍能预览文件，并可保存到本机。~~（1013V：任务 cancelled，文件内容“有效阶段成果：42”，导出副本一致。）运行失败场景仍待单独验证。
  - [x] ~~通过资料库分享指定文件副本，接收 Bot 实际读取自己的副本并交付核验结果及可打开链接。~~（1013M；不授予源 Bot 目录访问权）
  - [x] ~~群资料入口：复用 BotFilesPanel 和文件 IPC，增加经主进程核实的群作用域；导入群共享目录，群成员可读取，私聊目录保持独立。提供列表、预览、导出及显式副本分享，不新增文件存储系统。~~
    - 1013O：Mac 群资料导入、列表、预览和两个真实 MiniMax 成员读取通过；两条任务 completed，工具记录均读取同一群目录，群回复链接可预览。文件 IPC 与 Host 等 70 项测试通过，覆盖非成员、无效 groupId、跨目录分页、选择文件期间群被删除的拒绝。群导出／显式分享路径由同一 IPC 测试验证；Windows 仍未实测。

### P09 — Grok UI 与核心动画

- [ ] 1019EJ 群内选择问题的完整流程对照。已补群时间线待答卡、主输入框路径，并完成下述历史／多题、原任务续办及真实来源组合；独立用户回答回显与已答选项展示已完成1019EQ；完整精细样式（含取消卡的官方同态对照）、动画及Windows仍待验收。优先复用原待答请求、BotQuestionInput与已有回答回执，不新增问题协议或授权来源，不以静态源码推断当前官方必定支持。
  - 官方0.71.2已实测：在原合成群只提及REFERENCE，直接出现Continue／Stop卡片；点击Continue后原卡显示真实回答，另有引用该问题的Continue用户消息，随后REFERENCE回复EJ_G_DONE，同伴未插话。Hermes group-chat-view.tsx的roomClarifies亦按当前群展示待答卡。官方已恢复陈星越空草稿，未操作其真实任务或配置。
  - [x] ~~1019EQ 群回答回显与已答卡展示（Mac双模型，限定展示范围）。~~官方0.71.2在原合成群实际选B“详细报告”，已答卡仅保留B／选中内容、问题淡化，右侧另有引用原问题的用户回答；真实引用可返回问题。忽略卡仍保留淡化原选项，与旧重建版WidgetDismissed的紧凑形态有差异，以当前实屏为准。源码参考widget.tsx的WidgetResolved及workspace/reply-preview.tsx，复用本地botQuestionHistory的原submitted回执、原群气泡／引用跳转／日期与Virtuoso消息行；字母键只在过滤自由输入项后的原索引与实际label匹配时显示。按原submittedAt将回显附于已加载的最近消息之后，且不早于自己的问题；不改变原消息ordinal、分页ID或问题归属，不创建用户消息、存储、执行或回答通道，无新增订阅／轮询／计时器。5个生产文件158新增／18删除（含独立54行展示组件），1测试文件84新增／1删除；本轮主进程／共享契约与1019EP实测源码哈希保持。
    - 真实A：DeepSeek先选B详细报告并完成，再给MiniMax选A短摘要；两张已答卡、两份独立引用回显和最终答案均准确，后回答未插回较早问题位置；实际点击引用回到原问题，原群旧页加载及回到最新仍可用。真实B／C：DeepSeek与MiniMax各在一份两题请求中提交选项＋两行补充说明，以及此前未提供的两行自填名称；原回执及界面分别保留“青屿-EQ-DS”和“云杉-EQ-MM”与第二行，两题各引用自己的原问题。B中MiniMax另一组真实选项输入未被工具完整观测，保留现场但不作为自填通过；C定向复验补足。工具30秒超时后先读原状态、未重发提交或重启应用。
    - 真实D：DeepSeek经原跳过入口返回ignored空answers并结束，卡片淡化原选项；MiniMax仍待答，经原群停止后cancelled，原Runtime尚无ToolMessage，沿已存在的任务归属兜底展示“已取消”，两者均无用户回答气泡。30项定向、原test:messages、web、构建通过；lint零错误，附件generation原清理effect有1条既有ref警告，改前原件一致，本项未改该effect。正常Quit并确认句柄exit0／进程归零后同构建重启，两模型多行回答／引用及ignored／cancelled卡重新可见，无任务重放。原1408任务、60Bot／18群／17例行／60命令、356文件及7007旧消息头保持，最终1418任务（本轮9completed／1正式取消）／7039消息头，0活跃／0讨论游标，quick_check=ok。仅7次request_user_input，原6份回执为5submitted／1ignored，另1次取消无回执；群用户消息仍只有实际发送的4条，未把显示回显写成新用户指令。32项限定检查及源码／构建哈希核验通过；初版审计脚本错误预期“取消必有回执”及按任务时间截断先写入的群请求，均按原task归属／origin.messageId及ordinal修正，失败脚本和结果保留，未伪造或补写回执。
    - 证据quality-review/1019EQ-group-answer-presentation/{verification,after-restart-results,after-restore,tested-build,ui-observations,diff-stats}.json、verify.py、原失败审计与门禁日志。恢复本轮开始时的自有B群／成员详情360／侧栏253／空输入，官方恢复原用户群；未访问受保护草稿，也未据本项重新声称其旧哈希已复测。Windows、取消卡的官方同态视觉、完整UI／动画、已删除或未加载原问题的回执可用性及全局资源表现仍未关闭。本轮无commit／push。
  - [x] ~~1019EJ待答卡在群时间线直接展示及回答（Mac双模型）。~~复用原ThreadContext.pendingUserInput、UserInputRequestDialog／BotQuestionInput与原IPC回答通道；只订阅本机当前群活跃成员的原线程，缓存投影避免token更新重绘全群。9项归属／终态正反例及原问题／回答共37项、最终web、定向lint、原messages与构建通过；原进程正常Quit且子进程全退后更新。Footer首版及autoscrollToBottom尝试仍无法自动进入视口，已完整撤回，改为同一Virtuoso的稳定ID列表项；EJ3同要求双模型新任务实际自动显示两卡，未点最新按钮／成员执行记录，两次真实Continue各得到本人的submitted回执并交付名称与EJ3_LOCAL_DONE。MiniMax名称与标记间没有空格，DeepSeek有空格，保留原文；原任务未约定分隔符，不为此加输出过滤。此前EJ／EJ2记录和失败截图保留；首轮第二回执在再次定位前已submitted，不把它当作该次工具点击的独立证明。第三轮页面实际位于原自有A群，按真实origin.messageId／groupId核验，没有把A群请求误算成B群。三轮共9条任务全completed／0活跃／0游标，原1306任务、60Bot／18群／15例行／54命令、352文件及6686旧消息头保持；恢复陈强／详情。证据quality-review/1019EJ-group-question-flow/。无新问题存储、IPC、Runtime、轮询或专用滚动回调；无commit／push。
  - [x] ~~1019EK 群待答期间的主输入框自填路径（Mac双模型）。~~官方0.71.2同一合成群实际验证：单成员问题出现后，占位提示变为“输入你的回答，或聊点别的”；自填青屿-1019EK-G以新群消息发送，旧卡标为已忽略，随后准确回复EK_G_RECEIVED及新名称。因此没有把任意群文字伪装成submitted表单回答，而是复用原steerAgentRun、持久收件／injected_into和原ignored回执：仅同群同成员的直接用户消息、且该Runtime确有待答问题时接入；普通群工作仍排队，审批／私聊／其他群／同伴消息不进入该群执行链。保留既有私聊抢先收件分支，新增启动早到的私聊回归；群结果只发布一次，不为已接收的新消息生成无结果占位。主输入框提示仅由既有空输入装饰／CSS变量和aria标签更新，无编辑器重建、额外事务、轮询或新存储／IPC。
    - 两轮真实MiniMax-M2.7／DeepSeek-v4-flash各提问一次，再从群主输入框发送此前未提供的新名称；四个原请求均有真实ignored／空answers回执，四条新消息分别持久绑定各自原运行，最终四个精确名称回传均一次发布。两次可选复核均零工具、无额外群消息；10条任务全部completed、0活跃／0讨论游标，1315→1325。首轮发现原任务和接收消息造成成员状态重复，保留现场，改为共享的每成员活动投影（等待确认优先）后，用新题及林屿-1019EK2-LOCAL重新跑两模型，运行中实屏确认每成员仅一条状态，问题卡亦不重复；没有过滤模型正文或隐藏失败证据。
    - 29个测试文件469项通过；最终接线98项、状态／编辑器／草稿等53项、原test:messages、完整node／web检查及最终构建通过。较早Runtime集成断言仍要求可选复核带通用交付段，与1019EH已确认的提示分工冲突，已按来源分别断言，保留两份原失败日志；生产提示未为测试改回。完整lint未通过：输入组件原有两处ref规则错误及一处依赖告警与HEAD逐项一致，未将无关回调改写叠入本次；其余定向lint与群父组件的原告警另存日志。临时Ref／编辑器事务占位提示尝试已撤回，原group-editor实现与HEAD一致。
    - 60个Bot、18群、15例行、54命令、352份旧文件、全部1315旧任务及6716旧消息头保持；原线程不可变字段保持，访问更新时间可推进。原生Quit且进程全部退出后更新；第一轮结果重启仍可见，最终恢复陈强／详情与空输入，官方恢复实际原选中tibo监控助手空输入，未操作其真实任务。证据quality-review/1019EK-group-question-composer/{verification,final-results,after-restore,model-responses,restored-ui}.json、verify.py及实屏／构建记录。仅关闭本路径，不表示全群提问、UI动画或Windows已对齐；无commit／push。
  - [x] ~~1019EJ委派与私聊例行待答期间的新消息、原任务续办组合（Mac双模型，1019EP）。~~直接群定向新话题／DeepSeek附件见1019EN，MiniMax待答附件、无定向新话题及群内command完成通知待答见1019EO；历史／多题／重启见1019EL，上翻新卡见1019EM。不以这些通过代替整体UI或Windows验收；一期例行仍回指定Bot，不增加二期群例行。
  - [x] ~~1019EP 委派／例行问题归属与新消息续聊（Mac双模型）。~~两模型各经bot_schedule保存一次17:26:30触发的once任务；原schedule任务待答后，新私聊分别零工具答43，同一schedule任务以原检查点续办、重新提问，真实Continue后各准确完成，2项合成once自动停用。参考应用0.71.2实际保存“仅一次”任务，问题稍后到达后也先忽略旧卡、回复EP_G_PRIVATE 43、重新提问，真实Continue后交付EP_G_ROUTINE_DONE。群委派对照中REFERENCE向MIXED发任务，MIXED提问后收到定向新消息，先答EP_G_TOPIC 37、再重问，真实Continue后由MIXED交付、REFERENCE报告原结果；不据此推断其服务端实现。源码参考原yieldToUser／deferTask／continueBotTaskCheckpointId及优先队列、Grok widget.tsx:124的旧问题边界、Hermes group-chat-parts.tsx:381与group-chat-view.tsx:865的原成员请求归属。
    - 原始失败均保留：A中MM仅一次bot_delegate交DS，待答时的新群消息queued；真实Continue后才释放，不计修复通过。首修B虽已独立答43，但同群新轮次推进检查点，旧resumeCheckpointId被原校验拒绝，委派57191f8c…实际failed，原回传如实报告失败；后续讨论经真实Stop结束，不把它算作委派成功。最终复用原continueBotTaskCheckpointId保留新完成轮次：beta新增的Bot专用辅助函数（b22bff091，原c7723072无此文件）按实际范围改名，仅对带原verifyResolvedThread绑定的合法群元数据开放；普通来源、远端／无lease／不合法群／另一待运行模型／工具与HITL仍拒绝。普通工作台不进入此续办入口，原Runtime／审批／文件与命令策略及原服务源码保持；IPC仅4处内部函数名称替换。曾扩大的IPC格式化差异已按改前原件撤回，不留无关格式变更。
    - 最终最小接线相对1019EO为5个生产文件51新增／32删除（含类型注释与IPC改名），3测试文件142新增／15删除：只让同群直接消息在委派待答时使用原yield／检查点续办，仍由新任务独立执行，保留原委派ID、交付与回传条件；沿已有问题登记事件补早到消息的检查，不新增监听器、存储、IPC或轮询。跨群、撤回、重复问题登记、不注入用户权限、旧分支／新完成历史及普通入口负例覆盖；最终309项／12文件、原test:messages、完整test:workflow、node／web、定向lint及正常构建通过。真实C／D交换角色：MM先答53、DS先答41，再各用同一个原委派ID重新提问，真实Continue后交付自己的完成标记并各自动回传一次，无重复派发或虚构答案；最新构建新增10任务全部completed，0讨论游标。
    - 正常Quit且进程归零后同构建重启，D两张ignored／submitted卡、41及双方交付仍保留，无任务重放；恢复陈强／详情／空输入与原253侧栏，参考应用恢复原用户群。原1382任务、60Bot／18群／15例行／60命令、356文件及6917旧消息头保持，最终1408任务（本轮25completed／1首修failed）／17例行（新增2once已自动停用）／7007消息头，无新工作文件、命令、活跃任务或accepted命令，quick_check=ok。原生去重调用仅11次request_user_input、4次bot_delegate、2次bot_schedule；11份本轮原回执为5ignored空answers／6submitted（含真实Stop）。另1条普通取消补全已核对属于本轮之前的工具调用，不计新问题或答案。41项限定检查、最终源码／构建哈希及IPC仅名称变更核验通过；证据quality-review/1019EP-background-question-ownership/{verification,after-restart-results,after-restore,tested-build,delegate-blocked-baseline,b-failed-checkpoint}.json、verify.py及门禁日志。例行实跑先于最后的Bot辅助函数改名／群绑定扩展，私聊原语义保持并有定向回归；Windows、完整UI／动画及全局资源表现不由本项关闭。无commit／push。
  - [x] ~~1019EO 直接群输入组合及群内后台命令通知待答的续聊（Mac双模型）。~~实际MiniMax待答附件沿正式选择器导入本轮63B原件，真正read_file读取EO-1/2/3并准确交付12.56 CNY；两原卡真实ignored，未提及成员不代答。无提及新话题的两模型均真实ignored并各回复45，与官方0.71.2同题一致。C中45秒后台命令均先结束，再由原notification轮次提问；新群消息确实queued、两旧轮次仍waiting_user，缺口原始现场保存在c-blocked-baseline.json。随后各真实选择简版，两submitted原回执及各自EO_C_CHOICE保留，原排队消息最终回复37，不将此人工释放当作修复通过。
    - 最小修正相对1019EN仅3个生产文件26新增／5删除：sendGroup只对同群command通知的真实待答沿已有dismissQuestion写ignored空answers，等原工具wait-end／ToolMessage提交后沿原模型边界结束旧轮次，静默标为superseded；新直接消息保留在原队列，独立使用其提示与工具权限，不注入通知轮次。当前物理lease、私聊／跨群、审批／普通工具、精确重试及原后台命令边界保持；未扩展委派／例行／workflow/coordinator规则，没有新存储／IPC／执行器／轮询。参考Grok widget.tsx:124的dismissOnMoveOn／isStale、Hermes group-chat-parts.tsx:381的原成员问题归属、原user-input-tool.ts的ignored／wait-end与ipc/agent.ts:8050的只结束模型轮次接口。2测试文件104新增／5删除覆盖有／无提及、重试、跨群、不注入权限、原回执与排除来源；298项／11文件、原test:messages、完整node／web、定向lint和构建通过。首轮测试错用群消息requestId及漏原Terminal.code的失败日志保留，按原契约修正测试，未改生产契约或放宽验收。
    - 新版D两模型各只启动一次45秒命令，完成后两张真实问题出现；仅@DS另问24+17，两旧notification均superseded且原问题实际ignored／空answers，新的独立group任务完成，只有DS回复EO_D_TOPIC 41，无额外无结果卡。全轮去重原生消息恰8次request_user_input、4次execute、1次read_file，无重启／轮询或额外工具；8份精确请求回执为6ignored／2submitted。正常Quit、进程归零后同构建重启，D两旧卡及41结果保持，原通知不重放；恢复陈强／详情／空输入及253侧栏。原1361任务、60Bot／18群／15例行／56命令、355旧文件和6859旧消息头保持，最终1382任务（新增18completed／3superseded）／60命令／356文件／6917消息头，唯一新文件为本轮63B CSV；0活跃／0讨论游标／0accepted命令，quick_check=ok，29项限定检查及实测源码／构建哈希一致。证据quality-review/1019EO-group-question-combinations/{verification,results,after-restart-results,after-restore,tested-build,c-blocked-baseline}.json、verify.py及原失败／门禁日志。官方后台题直到恢复原会话时只观察到“后台已启动”，未见自动问题，不能算该来源的官方对照通过；委派／例行、Windows、全局CPU／内存及完整动画仍未关闭。无commit／push。
  - [x] ~~1019EN 定向新群消息后的旧问题失效（Mac直接群任务，双模型）。~~官方0.71.2同一合成群实际@所有人发出两张问题后，仅@REFERENCE改问23+41，两张旧卡均已忽略，只有被提及成员回复EN_G_TOPIC 64。客户端及0.18重建源码widget的dismissOnMoveOn／isStale为整群用户消息边界，不能据此推断云端服务内部取消方式。本地同题曾复现仅DS旧题ignored并回复EN_A_TOPIC 64、MM仍waiting_user，原始回执保存于quality-review/1019EN-group-question-targets/directed-topic-baseline.json；随后实际选择MM简版结束基线，没有篡改回执。
    - 最小修正：沿原sendGroup事务返回“新消息／精确重试”，仅对同群未被提及的直接group运行调用lease的dismissQuestion；仍须当前物理Bot lease及真实待答，写原ignored空answers回执，等原工具wait-end和ToolMessage提交后在原模型边界中断，任务标为superseded并静默收尾，不虚称完成或选中答案。新任务仍留在原收件队列；同群目标继续原steer，私聊、其他群、审批／普通工具及委派／例行不进入该规则。复用原模型边界中断保留已接受的后台命令；已有成果、权限、通知及原Runtime源码未改。相对1019EL仅3个生产文件新增约31行／删除13行，另2文件补116行边界测试，不加存储／IPC／执行器／轮询。290项相关回归、原test:messages、node／web、定向lint与最终构建通过；首版Host模拟漏wait-end造成状态冲突的失败日志保留，按原工具协议补足模拟，未放宽生产状态转换。
    - 真实复验B：两模型各一次原生问题，再仅@MM另问31+17，两题均有原生ignored空answers；DS旧轮次superseded且无额外群消息，只有MM准确回复EN_B_TOPIC 48，之后无活跃任务。C交换角色：两模型先各一次execute(run_in_background=true)启动180秒Node命令，再各问一题；通过正式文件选择器附上63B的1019EN-source.csv，仅@DS。两题均真实ignored，MM旧轮次superseded，DS在原收件／执行链中read_file回读EN-1=13.20、EN-2=-1.05、EN-3=0.09，回复精确合计12.24。两条实际Node进程在移开问题后仍存活，各自最终exit0；原通知分别唤醒两Bot，回读并各交付一次自己的11B原件，界面实际打开核对EN_C_MM_BG／EN_C_DS_BG及末尾换行。原生持久消息去重后恰2次execute、3次read_file、2次bot_deliver_files，无重启命令或轮询；捕获脚本的任务窗口可能含后续通知，不把重复范围算重复执行。
    - 正常Quit、进程归零后同构建重启，C两张ignored卡、CSV结果和两份交付仍在；恢复陈强／详情与空输入，侧栏253不变。14条新任务为12completed／2superseded，3次可选复核零工具且静默，0活跃／0讨论游标／0accepted命令；原1347任务、60Bot／18群／15例行／54命令、352文件与6812消息头保持，最终1361任务／56命令／355文件／6859消息头，quick_check=ok，实测源码／构建哈希匹配。证据quality-review/1019EN-group-question-targets/{verification,results,after-restart-results,after-restore,tested-build}.json、verify.py及门禁／首次失败日志。仅本路径通过：MiniMax待答附件、无定向消息、其他来源问题及Windows仍未关闭；DS后台回复使用英文并多说了一句未请求的profile说明，列为交付表达差异，不据此宣称全部行为一致。无commit／push。
  - [x] ~~1019EL 群问题历史：已答／已忽略卡片保留在群历史（本机新问题路径）。~~复用现有群消息、原问题回执和卡片组件，已覆盖取消／多题、旧页、重启及MiniMax／DeepSeek正式界面，不从普通用户文字推造已提交答案。
    - 范围复核：首版跨控制库／Runtime库回查、重新配对工具回执及独立时间线合并共涉及16文件（743新增／175删除，含235行新测试及解析器搬移），为单项历史展示引入过多接线。未构建部署、未完成真实双模型验收；局部测试通过不计完工。已备份并撤回全部15个源码文件改动，源码恢复650c6ba30，既有功能与数据未改；备份在预览quality-review/1019EL-group-question-history/withdrawn-attempt。
    - 参考边界：实际安装的Grok 0.71.2客户端index.eager-app-DSuGVQNC.js读取原问题消息的respondedValue／widgetDismissed展示已答／已忽略；无法据客户端断言其云端数据库实现。0.18重建版widget-responses.ts:407在原transcript entry保存对应状态，非官方当前服务端源码。Hermes group-chat-parts.tsx:381的GroupClarifyCard只在提交成功后向原群日志回显答案，不能代替完整问题卡的持久历史。官方应用实际查看原验收群，Continue回答与主输入框自填后的已忽略卡均仍保留；仅查看并恢复原选中群，没有发送新任务。
    - 最小接线：原bot_group_messages增加可空question_json，保存原UserInputRequest及实际Runtime回执messageId；答案仍从原getThreadMessagesByIds按精确ID读取并校验requestId，不复制答案、不回查全线程、不重新配对工具调用。沿原ordinal／50条分页／目标定位和原问题卡组件，待答与持久卡共用原UUID键；展示记录不进入模型上下文和讨论轮次。订阅仅随群运行lease创建／释放，不加计时器、轮询或新执行链。原任务清理复用已有archive保留群任务归属与终态，不存其消息正文；原Runtime、审批、取消及普通工作台源码未改。
    - 双模型正式验收：A各一次Continue；B群主输入框自填青帆-1019EL-B，原卡均按真实ignored回执展示，不能当submitted；C每人两题只选第一题后停止，两请求／四题重启仍已取消，无臆造部分答案；D每人一次两题完整提交，DS=A版／下周、MM=B版／本周，卡片与实际回复一致；最终索引版E再各一次Continue并准确回复自己的EL_E_DONE。共10个原问题请求、16条新任务（14completed、2cancelled），可选复核均零工具／静默，0活跃／0讨论游标。正常Quit、进程归零后同构建重启，E及D、C历史核对通过；上翻原分页加载12:47旧交付，再返回最新，问题与回复均保留。已恢复陈强／详情与空输入。
    - 性能与原功能核对：新增状态关联首版查询计划暴露视图整表物化，已改原任务／archive主键及request_id索引关联；18个实际群的196个最新／旧页／目标窗口与前版逐行相同，最终EXPLAIN无任务／archive整表扫描。仅本机SQLite暖查询20轮中位数3.914→0.206ms，不代表全应用CPU或内存基准；未加载页面的问题不读取Runtime回执。原取消补全文本在Bot回执入口跳过，原回执不变。242项相关测试、原test:messages、node／web完整检查及最终构建通过；定向lint无错误，保留原附件清理ref告警，未改无关代码。
    - 保全与证据：全部1325旧任务、60Bot、18群（活动时间除外）、15例行、54命令、352旧文件、6740旧消息头及原线程身份／状态保持，最终1341任务／6788消息头，quick_check=ok；实测源码与构建哈希一致。证据quality-review/1019EL-group-question-history/{verification,after-restart-results,after-restore,indexed-tested-build,query-equivalence,indexed-query-plan}.json、verify.py及门禁日志。历史旧问题未回填；删除原Runtime线程后的回执可用性、Grok独立用户回答回显、其他输入组合与Windows仍未关闭。上翻新卡续验见1019EM。无commit／push，不表示全群交互或整体UI已对齐。
  - [x] ~~1019EM 上翻阅读时新群问题到达不强拉最新（Mac双模型）。~~官方0.71.2在原合成群实际发送EM-G后上翻至10:42／11:41旧记录，新问题到达仅更新待答提示，原阅读位置保持；主动点“滚动到底部”、真实Continue后得到EM_G_DONE，并恢复原用户群。核对原CMB的USER_DETACH规则及既有群Virtuoso分页／稳定消息键，未新建滚动或状态机制。首轮本地A两模型均真实选择并准确完成，但发送后第一次滚动与提交定位时序不明，不作为到达前后证明；B改为同一次任务中顺序问两次，分别真实提交第一题Continue后立即上翻，实际截图中相应模型先processing、后第二请求waiting_user，旧EL-E卡与EM-A消息位置保持；两次均由用户主动返回最新，再实际Finish，四张历史卡及自己的EM_B_DONE正确。六条任务全部completed、六个精确原生submitted回执、两次可选复核零工具且静默，0活跃／0讨论游标；没有产品代码变更，仍为1019EL同一源码／构建。1341旧任务、60Bot／18群／15例行／54命令、352文件与6788旧消息头保持，最终1347任务／6812消息头，quick_check=ok；恢复陈强／详情与空输入，保留观察到的当前253侧栏宽度，未擅自改回284。证据quality-review/1019EM-group-question-reading/{verification,initial,final,results,ds-second-pending,both-second-pending}.json及verify.py；实屏前后图见工具记录，不将静态观察说成录屏或Windows通过。无commit／push。

- [x] ~~1019EI 群执行状态与输入框共用内容边界。~~用户截图所示状态行固定24px边距，而输入框按公共内容列居中；仅将两者的既有width／max-width合并为共同CSS规则，状态行改为自动水平边距。web类型检查、格式及正常构建通过；旧预览正常Quit、进程全部退出后更新。真实MiniMax-M2.7与DeepSeek-v4-flash各实际发出一次选择卡，原生1440／1201逻辑宽度及详情开／关四种画面确认状态行与输入框左边界一致；两次真实Continue后均准确回复自己的名称及23+41=64，状态撤下，一次可选复核静默结束。原1303任务、60Bot／18群／15例行／54命令、352文件与旧消息头保持，仅新增3条已完成任务，0活跃／0讨论游标；已恢复陈强会话、详情及原窗口大小。没有新增JS／监听／计时器，不改原工作台；证据quality-review/1019EI-group-progress-alignment/{verification,initial,final,model-results}.json及四张原生截图。仅本机对应布局通过，不代表Windows或整体UI完成；无commit／push。

- [x] ~~1018CE 发送后思考阶段，用户消息与“正在处理”之间空白伸缩、页面上下回跳。~~ 沿原滚动状态机和 Virtuoso 实测后修复：隐藏思考／普通运行工具不再保留空虚拟行，审批／错误／接管／Mod 卡片保留；复用原增量可见性投影，只在正文由不可见转为可见时更新布局版本，普通 token 不重扫完整历史。仅 Bot viewport 禁用浏览器自动锚定，追加消息直接跟随实际 viewport；流式记录转为历史记录及测量变化在绘制前校正位置，沿用原 `shouldFollowChatOutput`，上翻阅读不强行拉回。普通工作台保持原可见性、锚定和定位分支，未修改共享滚动状态机或头像动画。
  - 临时数字几何诊断记录了原版本换行时同高行先下移 23px 再向上校正，以及中间版 DeepSeek 结束时的 407px 回跳；这些失败记录完整保留。绘制前校正后结束的大幅回跳未再出现；仍记录了同帧 1ms 内的位置变化和 Markdown 正文实际回流 22px，不能据此宣称所有任务“零像素变化”或完整 Grok 动画一致。
  - 最终无诊断构建，真实 DeepSeek `f80ee389…`、MiniMax `20b7eec8…` 均实际 `read_file` 后完成编号／内容核对及八条回复；另用 MiniMax 三十条流式回复验收上翻保留阅读位置、回到底部及完整末项。71 项可见性／滚动／初始定位回归、增量投影大历史／隐藏思考转正文测试、原 `test:messages`、web 类型检查和构建通过；Chat lint 与原文件同为 18 条存量 warning，无新增错误或规则诊断。源码及最终 bundle 无临时 probe、无新增轮询／定时动画循环。试验中的同步尺寸测量选项产生重复 ResizeObserver 告警，已完整撤回，列表组件恢复原实现；最终双模型复验该告警、更新深度错误及未捕获类型／引用错误均为 0。
  - 38 个 Bot、10 个群、9 个例行任务配置未变；249 份原文件哈希及此前消息保留，原 39 字草稿未发送且内容一致。此期间用户新任务／一条命令记录及文件保留，不计入本轮合成验收。47 条证据断言通过。证据 `quality-review/1018CE-thinking-scroll/{diagnostic-summary,review,source-clean,lint-comparison,draft-check}.json`、各轮 motion 与正常构建／上翻截图；未 commit／push，不据此勾选 P09 整体验收。

  - [x] ~~1018CF 修复后冗余复核。~~确认当前源码和运行包已无临时 probe／同步尺寸观察试验；发现暂存区仍保留两处共 17 行旧 `BotScrollProbe` 诊断，已仅移除该部分，其他暂存内容原样保留。生产源码及当前全部 renderer 产物 SHA-256 与复核前一致，未新增功能补丁。空行可见性、局部锚定、追加定位及绘制前校正均有对应复现证据，继续保留。71 项相关回归、增量投影测试及 web 类型检查通过；沿用此前同一源码／包的 MiniMax 与 DeepSeek 验收，不重复发送模型任务。证据 `quality-review/1018CF-scroll-cleanup/{review.json,index-diagnostic-removal.patch}`；未 commit／push。

- [x] ~~1017AR 用户现场“连接应用”无法返回。~~源码确认App在Bots始终隐藏原标题栏，而SettingsOverlay位于其下方的相对容器中；设置打开后从窗口顶部开始，返回箭头与macOS原生窗口控件重叠。CustomizeView的“返回应用”文字另置于按钮外，点击文字不会触发返回。复用原标题栏：仅在Bots未打开设置时隐藏；将已有返回箭头与文字合为同一按钮，继续调用原setShowCustomizeView(false)，不新增导航状态、窗口监听或Runtime改动。修正后用正式界面验证连接器／个人信息返回、Escape、焦点及原Bot／群草稿，复核普通工作台设置；真实DeepSeek和MiniMax分别完成简短任务。旧1017AM的连接器返回证据只覆盖当时操作路径，不排除此现场缺陷；未复验前不勾选。

  - [x] ~~1017AR遮挡及点击范围修正，Mac指定路径复验。~~App只补设置打开时显示原标题栏；CustomizeView将原箭头和文字纳入同一个按钮，原setShowCustomizeView和SettingsOverlay不变。原进程48876正常Quit且4进程全退出后正常构建，35项／4文件测试、web及构建通过，定向lint零错误／App原有3警告保留。原生实屏确认设置返回区位于红黄绿控件下方；最大化尺寸实际鼠标点击文字（80ms）、按钮、Enter及Escape均返回，连接应用焦点恢复。DS私聊、原身份群@草稿、个人信息返回到账户、普通工作台设置往返均走通；群名、资料库与@保持。真实MiniMax a8a820f7…和DeepSeek e9efa81b…均completed／零工具，名称正确、31+27=58。原578任务、全部34Bot／9群／9例行／21命令、210文件与3484旧消息头不变，仅新增这两条短任务，0活跃、quick_check=ok。证据quality-review/1017AR-settings-return/{before,after,review,model-results,quit-check}.json；无commit／push。恢复原1500×900尺寸后仍出现既有延迟绘制／输入差异，原生Zoom后回到群@草稿，当前留在最大化深色群资料库；此现象未归因或修复，不由遮挡修正冒充消除全部返回／绘制问题，Windows尚未实测。1017AR父项保留待核对原尺寸的可靠点击。

  - [ ] 1017AR用户再次确认仍无反应，前述安全区修正不足。已核对Bots原生drag区域：展开侧栏toolbar高68px，设置时原工作区只opacity:0／pointer-events:none并inert，仍保留原生可拖动区域；新标题栏下的返回按钮仍与其重叠。Electron官方明确重叠drag区域不发指针事件，不能用DOM的z-index或AX激活通过代替真实鼠标验证（https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions）。仅在既有SettingsOverlay整层显式no-drag，排除底层drag命中，标题栏继续由原应用提供；不改焦点／导航／隐藏工作区方式或注入监听。须实际鼠标验证原尺寸和最大化下连接应用→返回，群@草稿和正常标题栏拖动保持；两模型复测后再判断，不再提前报已解决。

  - [x] ~~1017AR原生拖动命中修正及原设置流程复核。~~SettingsOverlay仅增加局部no-drag声明，正常标题栏在覆盖层外，原导航／焦点／存储和Runtime不变；编译产物已确认规则存在。原76037正常Quit且4进程退出后重建，最终web／构建／13项设置状态测试通过，覆盖层lint零错误零警告。新版真实鼠标点击返回文字成功，用户再次明确确认“现在可以返回了”；普通工作台设置按钮返回及Escape均走通，焦点回原自定义设置入口。最终真实DeepSeek619d3227…与MiniMax0193d029…completed／零工具，名称正确且47+16=63，原先两条58回执仍保留。原578任务、34Bot／9群／9例行／21命令、210文件及3484旧消息头不变，仅4条本项短任务，582任务／0活跃，quick_check=ok；源哈希与最终构建匹配。恢复原身份群@草稿、资料库、深色和295／360宽度，当前最大化窗口。证据quality-review/1017AR-settings-return/{drag-source-sha,drag-quit-check,final-models,final,drag-review}.json。还原尺寸下工具曾返回noWindowsAvailable，用户手动确认与此单独记录，不据此宣布所有绘制／电脑工具问题已定位；Windows未实机验收。此次无commit／push。前述仅安全区修正的不足已被本次覆盖层修正取代，历史失败保留。

- [ ] 1017AQ Bot成果的JSON交互预览。对照官方0.71.2的Js／sa／aa／Dt／En：默认展开两层、容器条目摘要、逐层折叠、200条子项上限及键盘Tab。复用原FileViewer的授权／缓存／取消／有界分页读取，只提供可选文本展示适配口，由Bot显式启用，普通工作台默认行为保持；复用已安装的react-virtuoso处理可换行行高与可见项，不复制官方整套虚拟布局、文件读取或新增依赖。数字展示保留原JSON数值字面量，避免大整数／长小数被JSON.parse舍入；无完整内容、无数值原文或解析失败时回退原源码预览。独立核对Grok既有form-result.json字段，增加有意义的展开／折叠、特殊键、精度及宽数据测试；DeepSeek与MiniMax分别真实生成／读回／交付合成JSON，并实际打开、滚动和操作。核对旧文件／记忆／身份／草稿不变；不借此声称所有文件格式、UI或Windows已对齐。
  - 开发中实测512KiB上限的密集数值数组，Node24单次解析约210ms，不能放在界面线程。按原CMB code-highlight-worker的Vite Worker方式及Grok的解析worker边界，JSON解析和展开留在单个预览专属worker，只传展示行；关闭／切换文件直接terminate，无计时器／常驻队列，不改原高亮worker。此为开发边界测试，尚非实际Electron性能结论。
  - [x] ~~1017AQ源码、数据和首版Mac操作补验。~~7项JSON模型／会话测试及原有分页与预览隔离共22项通过，web、两次正常构建通过，定向lint零错误（FileViewer原有transport依赖警告保留）；官方sa／aa／Dt原函数与适配实现在9类数据及连续展开操作的顺序、子项限制、折叠重置、Tab目标逐项相同。真实DeepSeek29ed84a7…和MiniMax fda1c20b…按逐字相同的13791字合成请求，各自写入／读回／交付两份文件，无其他工具或工具错误。Decimal独立核对9007199254740993、1.234567890123456789、-0、1e400，220条数据及官方同题records字段全部一致。DeepSeek有效文件仅缺末尾LF，MiniMax有效文件逐字相同；两份故意无效文件均多末尾LF，均由模型写入参数决定，不冒充逐字一致。首版实屏三笔records可展开、数字原文／长文本换行正确，鼠标能滚到199及“还有20个条目”，Escape回原文件入口；无效JSON落到原CodeViewer。证据quality-review/1017AQ-json-preview/{source-parity,prompt-verification,file-review,first-ui-review,parse-budget,wide-display-budget}.json。40,201行展示数据在Node独立克隆约28ms，未当作Electron全场景性能结论。
  - [ ] 1017AQ最终构建复验：首版45次快速Tab仅到rows[29]而非rows[43]，已修正已挂载目标的同步聚焦和未挂载目标的连续推进；最终构建及类型检查已通过，实屏仍待复核。最终版当前电脑工具能读窗口但点击／粘贴／键盘不生效并返回noWindowsAvailable，重绑及重置工具未恢复；未发送短复验消息、未伪造最终双模型通过。原生启动的绘制／输入差异继续按既有边界保留，未添加全局监听或强制辅助模式。当前本项父项继续不勾选，待恢复输入后完成快速Tab、最终双模型、明暗主题与旧数据保存检查；无commit／push。
    - 中间独立保存检查：原571任务、34Bot／9群／9例行／21命令及206旧文件、3427旧核心消息头保持；仅新增两个模型任务和各两份合成JSON，共573任务／210文件／0活跃，quick_check=ok，4线程仅updated_at前进。证据preservation-interim.json。工具已重置并重新绑定原应用，键盘短探针与两种截图坐标仍无输入；未生成最终复验任务。当前停在DeepSeek会话、空输入框，原身份群@草稿保留但界面尚未切回；不能声称UI恢复或最终实屏验收完成。
    - 最终产物的线程边界补验：使用应用Electron39.8.10／Node22.22.1，通过Node worker_threads桥接实际Vite产出的bot-json-preview.worker脚本（未重写解析函数），524287B密集数组返回202展示行及261943条省略计数，主线程10ms计时器实际前进20次；terminate后收到对应worker exit，命令exit0。证据worker-boundary.json／worker-boundary.cjs。此项只证明当前打包脚本的数据传递及主动终止，不冒充Chromium原生Web Worker、UI延迟、长期无泄漏或最终实屏通过。
    - 输入恢复后续验：用户确认解锁并置前，仍有延迟回读；90391主进程及90445渲染进程短采样主要等待系统事件，未见忙循环，不能据此判定具体工具或应用根因。0活跃时正常Quit90391、4进程全消失且exec exit0，同配置不重建再启动后输入恢复，573任务／210文件／3451消息头和全部定义保持。MiniMax d5bce4d8…、DeepSeek24c65cc2…各实际read_file两次及bot_deliver_files一次，completed且数字原文准确；DS原自建诊断草稿的1017AQ后缀已在正式输入框校正后才发送。45次持续60ms的Tab从precision准确到rows[43]，反向Tab到42、Enter展开读到aq-043，再44次反向Tab回precision、3次到root，折叠／重开及Escape恢复入口通过。默认零持续时长的4次工具按键只前进3项，记录为合成键盘输入边界，不声称所有零间隔按键均可靠；原根节点不在虚拟可见区的一次AX查找失败保留，随后键盘正常定位。深色DS源码回退、浅色MM JSON与长文本可读均实屏确认，原生导出13961B／220行与MM原件逐字节一致（minimax-export-review.json）。继续源码核对Mn发现正文容器最大860px且滚动条仅hover出现；现版本正文仍铺满1100px弹窗，补齐这两项局部CSS，重建后再完成最终复验，不提前勾选父项。
    - [x] ~~1017AQ正文宽度修正的构建、双模型与保存复核。~~仅增加812px行宽（对应官方860px容器扣除两侧24px）、Virtuoso的局部滚动条类和hover／focus样式；web、组件lint及正常构建通过，构建前22072进程正常Quit、4进程全部退出且exec exit0。最新MiniMax ae5c4a0d…、DeepSeek a17f34ed…均completed，各两次read_file及一次交付，无修改文件或其他工具；原文字面量和三笔金额准确。最终浅色截图确认长文本按860px正文重新换行、数字可读。源哈希匹配最终构建；原571任务、206旧文件、3427旧核心消息头及全部定义保持，仅6条本轮任务、4份合成JSON，577任务／210文件／0活跃，两数据库quick_check=ok，4线程仅updated_at前进。全部新JSON自首次创建后SHA不变，导出仍完整220条。证据review.json、layout-models.json、source-sha.json与对应layout日志；模型自称“布局复验”仅指文件读取回执，不当作模型已观察界面的证明。
    - [ ] 1017AQ仍有明确边界：最终样式版从保存按钮合成49次60ms Tab，回读到rows[42]而非43；尚未记录实际到达浏览器的keydown总数，不据此认定或排除产品错误。此前同一按键逻辑已在上一构建从已确认的precision起点45次准确到43；两次观察都保留。随后CMB预览点击／键盘再次未响应，同期官方Grok详情关闭／重开正常且已恢复AL／详情／空草稿，不能归因为已锁屏，也没有加入公共输入或绘制兜底。当前CMB仍为浅色DS JSON弹窗，深色／原身份群恢复及滚动条悬停实屏未完成；不勾选父项或整体UI，不把代码样式存在当作体验通过，无新commit／push。

  - 1017AR同配置重启及真实验收后，已恢复深色、身份群@草稿和资料库、295／360宽度；当前最大化窗口。AQ的数字／文件数据无改动，未以设置短任务代替JSON最终键盘／滚动条悬停验收，父项继续未完成。

  - [ ] 1017AQ最终Tab与滚动条差异已核实一处具体来源。当前最终构建从precision分段15／30／45次80ms Tab准确到13／28／43，Enter展开实际aq-044／1.00，反向45次回precision；但再反向4次落在滚动容器而非保存。原react-virtuoso/en明确tabIndex:0，官方Mn→Ve(za)未传viewportTabIndex，za原样传undefined；说明此前从保存49次到42可由额外滚动焦点解释，不能继续称为已证实按键丢失。仅向现有Virtuoso传tabIndex=-1，使显式焦点顺序与官方一致；CSS移除自行增加的focus-within显条分支，沿用官方hover策略，无计时器／新滚动组件。原失败和未记录实际keydown数量的边界保留，尚不能据此解释首版全部快速Tab现象。对照源文件official-platform.formatted.js:za的viewportTabIndex和Mn的hover参数，修正后重建并从保存按钮计数复验、双模型读回交付、原数据及草稿核对后再划掉。

  - [x] ~~1017AS去除额外Tab焦点及最终双模型文件复验。~~仅给原Virtuoso传tabIndex=-1，并把滚动条选择器按官方改为hover；未复制滚动布局或加事件／计时器。旧1628进程正常Quit且4进程全退出；22项／3文件测试、web、lint、格式与正常构建均通过。新构建从保存4次80ms Tab准确到precision，再分段累计19／34／49次到rows[13]／[28]／[43]，反向49次准确回保存；确认此前49到42与原Virtuoso额外滚动焦点相符，不继续把这一处差异写成已证实按键丢失。修正前同一行Enter并滚动实际读到aq-044／1.00，最终长数组末尾为199及“还有20个条目”，不完整文件用原CodeViewer，Escape回对应成果入口。真实DeepSeek ff6f4590…和MiniMax ca1b59de…均completed，各read_file两次、bot_deliver_files一次，无写入或其他工具，金额和四个原文字面量正确；两模型最终树均可实际打开。原582任务、34Bot／9群／9例行／21命令、210文件及3492旧消息头全部保持，仅增加这两条读取任务，584任务／0活跃，两数据库quick_check=ok。当前原身份群@草稿、资料库、深色均保留，实测侧栏220／详情360，未把旧记录的295强行写回当前布局。证据quality-review/1017AS-json-final/{before,final,models,review,quit-check}.json及AS检查日志；无commit／push。
  - [ ] 1017AS仍待验：最新深色预览的滚动条在标题空白点击及短距离指针拖动后仍可见，构建选择器确为hover；未取得真实hover状态／事件到达证据，不据此认定工具或CSS根因，也未加入刷新／指针监听兜底。最终两处局部修正后浅色未再次复测，之前同正文宽度版浅色证据仍保留；Windows实机、完整文件格式与整体UI／动画未验。AQ父项继续不勾选，已通过的键盘和交付不等于完整视觉通过。

  - [ ] 1017AT针对尚未确认的JSON悬停差异进行最小诊断。仅在本机预览临时给现有bot-json-scroll显示绿边、hover红边，通过CUA实际画面判断悬停是否到达及滚动条是否属于该区域；不加指针监听、计时器、IPC或公共Runtime改动。结束须移除诊断样式并核对原始CSS差异，最后正常构建和双模型读回，不能把带诊断样式的包作为交付，也不能继续用鼠标图标位置推断CSS hover已变化。
    - [x] ~~1017AT临时诊断清理、最终浅色及双模型复验。~~用户确认解锁置前后，实际画面出现非hover绿框且无滚动条、hover红框且有滚动条；随后移到标题的立即截图仍是红框，尚不能判定事件或绘制根因，不把完整移入移出验收划掉。移除全部诊断规则后，bots.css与诊断前逐字节相同，SHA256为6f61f248…；原49299及3个子进程正常Quit全部退出，正常构建成功。最终源码的13项设置、7项JSON、4项分页及11项预览隔离共35项通过；首次测试命令误填一份不存在的隔离测试路径，仅运行24项，已按真实路径补齐11项，不冒充首条命令全覆盖。最终浅色JSON数字原文、长文本换行和中性弹窗实屏可读，无红绿框，Escape回原文件按钮。MiniMax22677b84…与DeepSeekcb25ba7d…均completed，各read_file两次及bot_deliver_files一次，全部工具success，金额及数字字面量正确，原文件未改；模型自称样式验收通过不作为视觉证明。原584任务、34Bot／9群／9例行／21命令、210文件及3507旧消息头全部保持，仅2条新读取任务，586任务／0活跃、quick_check=ok。恢复身份群@草稿、资料库、深色和220／360宽度。重启截图曾停在Initializing，原生Zoom后已加载控件可读，此既有绘制／工具边界未修复或归因；Windows与完整hover往返仍待验。证据quality-review/1017AT-json-hover/{before,clean-quit-check,clean-models,final,review}.json及clean日志，无commit／push。

- [x] ~~1017AP 成果预览弹窗的展示对齐。官方0.71.2既有JSON成果实际预览为中性弹窗；原CMB Bot同一深色状态仍显示蓝灰背景、紫色表格悬停、大字号标题和额外可见归属行。源码chunk-table-loader的Ee／le与CSS确认40px视口留白、1100px最大宽、12px圆角、0.5px边框、14px标题及8px／16px标题栏留白。仅在BotMessageFilePreview添加作用域类、原归属说明转为可访问描述，保留原Dialog／FileViewer、范围校验、读取取消／缓存、分页、保存、滚动和关闭焦点；仅Bot CSS复用上述尺寸与中性主题变量，原工作台不变，不复制文件读取或新增动画时钟。验证同一文件的正文／表格／代码可读、滚动与保存／Escape、明暗主题；真实DeepSeek／MiniMax分别按原实际报告读回并交付，核对文件与既有定义未变。交互JSON树仍是已发现的展示差异，本项不冒充该能力或整个文件预览一致。~~
  - 首版新版双模型读取／交付、深色滚动及双模型原生导出已走通，明暗正文和代码均可读；进一步与官方source核对仍有遮罩差异：原DialogOverlay为35%黑，官方stage使用sand-bg-scrim-heavy（90%黑）。只通过现有Overlay紧邻Bot内容的CSS作用域覆盖这一遮罩，不改公共Dialog或其他弹窗；最终构建再实际核对，不提前划掉。
  - Mac最终构建复验通过：原17326和34533两版预览均经原生Quit，原进程树全退出且exec exit0，再正常构建启动；web、组件lint、格式／diff及两次构建均通过。Bot外壳沿用官方尺寸，实际中性深／浅Markdown与悬停、固定标题栏／完整结论滚动、122行代码的明暗可读性均核对；首版两个原生导出分别776B／354B，与各自原件逐字节／SHA相同。最终遮罩按官方90%黑显示，两模型原报告可再次打开，Escape均回原文件按钮。首版DeepSeek d17ff4e7…／MiniMax bccb721d…及最终a832dcd4…／b40fb136…均completed，各一次真实read_file和bot_deliver_files且全部工具success，没有写入或其他工具；名称和实际金额均正确。原567任务、全部34Bot／9群／9例行／21命令、206文件及3403旧核心消息头保持，仅4条新读取任务，571任务／0活跃、两数据库quick_check=ok，5个已打开线程只updated_at前进。恢复身份群@草稿、资料库、私聊记忆偏好、295／360宽度、深色和Bot颜色。仅Bot组件／CSS和来源说明有生产变更，无新监听／时钟，原FileViewer／Dialog未改。证据quality-review/1017AP-file-preview-surface/{modal-layout-rules,source-sha,final-models,deepseek-export-review,minimax-export-review,final-quit-check,review}.json及对应CSS／日志。导出和明暗代码在首版实测，最终遮罩修正后未重复全部导出，范围如实保留；JSON交互树、正文完整排版、物理窄窗口及Windows继续待验，P09与一期整体不勾选。

- [ ] 1017AM 侧栏底部入口对齐。官方0.71.2实屏及bD／mD／pD源码确认：折叠栏用storefront应用入口和圆形账户入口，展开后账户在左、连接应用为文字胶囊；本地仍为带边框插头、独立隐藏按钮和调节图标。复用当前连接器入口、BotWorkspaceMenu及原个人信息面板，把隐藏会话操作并入现有菜单；账户圆形入口只展示原getUserInfo的真实姓名缩写，未登录显示通用用户图标，复用原登录变更通知更新，卸载释放订阅，不复制登录网络请求或认证状态。两类外观Select沿用已验证的Bot中性弹层配色与短动画。核对展开／折叠、菜单焦点／Escape、隐藏返回、连接器与个人信息入口、主题／强调色，并以DeepSeek和MiniMax各一条正式任务检查会话仍可用；既有草稿和布局恢复。仅限Bots展示及现有接线，不新增账号或认证系统，不改普通工作台。
  - 首版实屏保留：折叠／隐藏返回／两级Escape／正确个人信息与连接器入口已走通。个人信息返回时焦点落到HTML根，原SettingsOverlay只恢复仍连接的document.activeElement；菜单项关闭后卸载，直接连接器按钮则可正常恢复。沿用1017AA稳定入口规则，仅在打开个人信息前聚焦常驻账户按钮，不改公共SettingsOverlay。Lucide Store与官方轮廓仍不同；官方实际用cursor-icons-16字体的storefront outline（glyph U+F483），按其300单位画布和字形原轮廓导出单个SVG，采用原16px尺寸，不引入整套字体或图标库；修正后重建复验再划掉。
  - 1017AM提交检查：web类型检查、改动文件格式、Menu／单字形SVG定向lint及正常构建通过；Workspace的lint仍为HEAD已有1 error／4 warnings，未扩大改动。单字形路径与官方字体轮廓逐字一致。当前仅完成首版实屏检查，稳定入口焦点、最终字形／Tooltip、响应式Tab顺序和新构建双模型复验仍待完成，故本项继续不勾选。
  - [x] ~~1017AM最终构建的Mac侧栏及双模型复验。~~实际折叠80px时为官方16px storefront字形、连接应用自有中性Tooltip，Tab从应用到账户；展开295px时账户在左、文字胶囊在右，Tab后胶囊有可见焦点框。个人信息打开原未登录面板，返回焦点准确到账户；连接器打开既有MCP页并回到原按钮，未登录或修改连接器。浅色／深色及强调色下拉中性配色、两级Escape、隐藏空态／返回均验证；强调色保持Bot颜色。原生Quit82403／原4进程全退出、exec exit0后正常构建通过，新进程加载0fc983576。正式DeepSeek a23610cb…、MiniMax6001cafb…均completed且零工具，准确报告自己的名称、上次合成登录最终未登录和31+27=58。原564任务、全部Bot／群／例行／命令、205文件及旧消息头不变，无新文件／记忆；5线程仅updated_at前进，566任务／0活跃，两数据库quick_check=ok。恢复身份群@草稿、资料库、295／360宽度、深色及Bot颜色；证据quality-review/1017AM-sidebar-controls/{source-sha,storefront-verification,final-quit-check,ui-review,models-completed,preservation-review}.json。拖动后AX曾不返回focused行，展开Tab用实际可见焦点框确认；原始观察差异保留。当前为未登录配置，真实账户切换未测，官方展开布局依据源码而非成功展开实屏；Windows及全部UI／动画仍按父项待验。本次push后的验收记录保留未提交。
    - 补充1016L边界：本次80→295原生拖动后视觉已展开，AX仍80；再单击分隔线后才为295，原@草稿及资料库保持。与此前松开回执现场一致，未取得新的事件归因证据，不计拖动通过、不添加公共监听或延迟兜底；仅侧栏入口验收完成，完整拖动项继续待验。

- [ ] 1017AA 编辑Bot的关闭焦点。1017Z实屏按Escape后焦点落在HTML根；编辑入口是会随Popover关闭卸载的临时菜单按钮，BotEditor没有DialogTrigger或显式返回目标。复用原SettingsOverlay／BotSchedulePanel保存入口及onCloseAutoFocus处理，并参照Grok sand-floating-primitives.tsx的isConnected／preventScroll做法，只为BotEditor保存实际稳定入口：菜单路径回到“更多Bot操作”，职责按钮回到自身。沿用原Dialog、表单及保存，不改公共弹窗或引入全局焦点管理／定时器。验证菜单Escape／取消／保存、职责入口及重开后Tab顺序；真实DeepSeek确认原身份、上下文和模型仍可工作；MiniMax未恢复不计通过。
  - [x] ~~1018CJ 补齐Mac双模型绑定Bot的编辑交互。~~当前官方0.71.2头像选择器取消与真实菜单焦点源码、原SettingsOverlay均已核对，直接复用现有BotEditor，无新增生产改动。两位既有BS Bot分别通过菜单Escape／取消／保存原值、键盘重开、职责入口Escape及随后Tab；合成草稿全程保留，验收后清空且未发送。只因保存原值各推进一次version／updated_at，其他36位Bot及两位自身的名称／模型／职责／外观等全部不变。编辑后真实MiniMax 09c09227…与DeepSeek 2b0ed1ad…均completed，准确回复自己的名称、既有25.75 CNY和新计算65。32项数据／焦点／草稿核对通过；MM首次连按Escape＋Tab未到管理记忆，获取关闭后的新状态再Tab后正确，保留观察，不声称连按时序全部通过。证据quality-review/1018CJ-editor-interactions/{before,after-ui,after-models,review}.json及双模型AX；Windows、IME、未配置模型和全部右键路径仍待验。
  - [x] 1017AC补MiniMax绑定Bot的菜单编辑Escape路径，焦点返回正确、当前模型／名称未改；新一轮实际回复名称与上次退出码正确。MM取消／保存／直接职责／模型配置等入口未全部重跑，不扩大单路径范围。
  - [x] 1017AA 已在BotEditor复用现有onCloseAutoFocus／isConnected／preventScroll处理，工作区保存稳定菜单入口或实际职责按钮；净增24行，无新时钟、监听、全局焦点管理或公共Dialog修改。Mac正式UI：改一份未保存名称草稿再Escape，原名保留且焦点回“更多Bot操作”；直接Enter→Tab→Enter可重开编辑，取消与保存原值均回同一入口；“编辑职责”Escape回自身，再Tab正确到“管理记忆”。恢复原记忆页偏好与AE群、80／360侧栏及空草稿。
  - [x] 1017AA 真实DeepSeek后续任务13e57d2c…completed，0工具调用，准确回复当前名称、上次合计11.23和23+19=42。原488条任务、30个其他Bot、8群／9例行／19命令与179跟踪文件不变；仅合成Z Bot因保存原值version 1→2及updated_at变化，其他字段完全一致，quick_check=ok。web类型、格式、构建通过；当前与索引基线lint同为既有setReady(false) 1 error及4 warning，无新增，不能记为全库lint清零。证据quality-review/1017AA-profile-editor-focus/{before,deepseek-after-edit,after,review}.json与检查日志。
  - [ ] 1017AA Windows及未配置模型入口／全部右键重命名焦点路径尚未实测；Mac MiniMax编辑主路径由1018CJ补齐，不扩大为全部弹窗／P09完成。

- [ ] 1017Y 普通后台输出记录的简洁展示（实现与Mac双模型已实测，Windows未验收）。当前正式界面实际露出task_output卡片，原W回执为V_READY及[Command succeeded with exit code 0, elapsed: 47s]，并非失败或交互；现executionTools未识别该原生工具，且共享hasFailedCommandResult只识别无elapsed尾缀，不能直接盲目把它加入折叠集合。沿用当前Grok风格投影和原CMB task_output的明确返回格式，只在Bot展示层识别成功终态／合法not_ready或timeout状态；失败、取消、Hook拒绝、任务缺失、未知／未返回和Mod卡保持可见，真实失败显示原有简短异常入口，执行过程开关仍可查看原始记录。不得改Runtime格式、共享工具行为、消息存储或靠CSS隐藏壳。先补真实格式正反例，再用DeepSeek分别实测成功输出、非零退出与不存在任务，并检查原W历史和开关；MiniMax额度未恢复不计双模型通过。
  - [x] 1017AC已补真实MiniMax的not_ready、成功终态、非零退出与缺失任务，默认折叠／异常／开关原始记录及重启回看通过；与1017Y DeepSeek三类结果组成Mac双模型展示证据。取消／Hook／未知／Mod仍为纯逻辑覆盖，计时准确性及Windows未通过。
  - [x] 1017Y 已复用原CMB返回格式及现有Bot投影／异常入口，仅调整Bot状态识别和两处MessageBubble参数；成功终态及严格识别的pending状态可折叠，未知格式／未返回／取消／Hook／失败／Mod保留。补测先红11项、再通过63项（4文件），test:messages、web类型、lint、格式、正常构建通过；最初类型检查发现ToolResult.content为unknown，已补类型守卫后重跑通过。未改原Runtime、共享command-result或数据库格式，未新增监听、定时器或缓存。
  - [x] 1017Y 正式界面使用原短会话DeepSeek V4 Flash完成7条实际任务：2次execute各仅启动一次3秒后台命令，随后分别单次task_output读取退出0与退出7，再单次读取missing-1017Y；共2次命令、3次读取、无其他工具或重试。成功卡默认收起且无工具壳，执行过程开关可恢复原始返回；两种失败显示原简短异常入口，展开可读实际错误（is_error均为空，不能靠该字段误判成功）。旧V/W的V_READY／47秒回执也实屏验证默认收起、开关及展开恢复。
  - [x] 1017Y 正常Quit确认预览主进程退出后重启；485条任务／19条命令及30个Bot、8群、9例行任务、178个跟踪文件前后完全一致，quick_check=ok，未续跑或重复命令；原478条任务／17条命令／全部资料未改，恢复原AE群、空草稿、80／360侧栏。证据quality-review/1017Y-background-output-view/{before,all-cases,storage-after,after-restart,review}.json及各检查日志。
  - [ ] 1017Y 限制照实保留：pending／Hook／取消／未知／Mod为纯逻辑测试，真实场景本轮仅上述三类；MiniMax额度与Windows未补验，启动BV依旧需要原生Zoom。另发现原LocalSandbox.getTaskOutput对已完成任务仍以查询时间减startedAt作elapsed，3秒样例延后读取显示17／23秒；属原harness问题，按用户“harness先不管”暂记，不把它描述成真实进程耗时。未据此扩大共享Runtime修改。

- [x] ~~1017R 私聊／群聊输入框表面与当前官方实现对齐。~~实际安装版本0.71.2；index-wlkGG389.js的gX共用XK／s1.frame，sand-10e981r解析为--sand-bg-elevated，sand-jmgmaz为三层轻阴影。仅在bots.css复用原主题色并将新控制色变量明确为--bot-elevated，合并两类输入表面规则、移除群内重复旧底色；保留尺寸、边框、键盘、草稿和按钮状态，无JS／计时器或运行链变更。正常Quit84665且ps确认结束后构建，原配置新进程95730；实屏分别核对私聊／群聊深浅色，恢复深色和原合成群空草稿。真实DeepSeek群任务0742de4b…仅原引用作者执行、回复65，私聊dc29d54d…回复29，均completed／0工具。457任务／0活跃、quick_check=ok，455份旧任务、178份跟踪文件和全部Bot／群／例行定义不变；web类型、格式、diff及构建通过。引用星号只核对到参考库reply-preview.tsx保留原文归一空白／限长，尚无证据认定偏离官方，未引入Markdown剥除逻辑。当前原生窗口缩放可恢复启动AX／绘制，BV根因仍未确定；MiniMax、Windows及整体UI／动画不由此项代验。证据quality-review/1017R-composer-surfaces/{before,completed,final-storage,review}.json及official-frame-{context.js,style.css}、official-theme-values.json；/tmp/cmb-1017R-{web,build}.log。

- [x] ~~1017P 优先DeepSeek文件交付、长文预览滚动及主题／详情按钮的定向对齐。~~正式私聊a90f949a…实际write_file一次、read_file两次、bot_deliver_files一次，completed／无工具错误；2433B报告含三笔金额及独立Decimal核对合计16.50、连续01—24节和末行END_1017P。默认聊天没有普通工具行，成果卡实际打开，原生滚轮到末行；Escape焦点返回原卡。仅在bots.css采用官方sand-light／sand-dark已核实的sidebar／chrome／base色值及深色elevated气泡；详情操作复用现有36px圆形按钮规则和8px间距，保留原按钮功能、键盘焦点、80px侧栏与窗口安全区，无新JS／计时器或Runtime改造。正常Quit PID54092并独立确认结束后构建、以原配置启动72633；新包实际检查深浅色、私聊菜单Escape返回、私聊／群详情关闭重开，恢复深色与原Bot空草稿。重启后DeepSeek任务28283b84…实际read_file一次，正确读回16.50／24节／END_1017P。最终454任务／0活跃、quick_check=ok，452份旧任务、177份跟踪旧文件、全部Bot／群／例行定义不变，仅新增保留的合成长报告；web类型、CSS格式、diff及正常构建通过，无E2E入口残留。首次CSS格式检查发现同文件既有transition排版，已仅格式化该声明后重建复核。BV启动仍需原生Zoom，MiniMax未重测、Windows及整体UI／动画仍待验，本项不代表完整对齐。证据quality-review/1017P-deepseek-ui-delivery/{before,delivery-verified,before-restart,after-restart-task,final-storage,review}.json；/tmp/cmb-1017P-{web,build-final}.log。

- [x] ~~1017AE 当前 DeepSeek V4 Flash 附件预览复验。~~正式界面实际读取并重新交付既有“长报告-1017P.md”，仅read_file及bot_deliver_files各一次、completed／无工具错误；合计16.50、24节及END_1017P均正确。当前包原生滚轮下滚到末行、上滚回标题，弹窗标题固定；Escape返回原文件卡焦点，聊天位置及空输入保持。未改原文件／记忆／配置，无新增文件；原508条任务、33个Bot、8群、9例行、21命令及178份本轮跟踪旧文件保持，quick_check=ok。沿用1016BZ／1017P既有修复，本轮未新增生产代码；证据quality-review/1017AE-deepseek-preview-recheck/{before,finished,review}.json。仅确认当前macOS预览流程，Windows及整体UI／动画仍按原项待验。

- [ ] 1015AH 群详情的原位名称编辑与布局。当前官方客户端为 0.71.2，实屏名称是可聚焦的输入框；现实现点击后弹出单独对话框，并多出一行“群内资料共享，成员页面独立”。沿用现有 saveGroup、版本校验和订阅，在详情中原位编辑名称，Enter／失焦保存、Escape 取消、中文组合态不提交；成员并发变更冲突不得覆盖，失败保留草稿并明确重试。右键重命名入口继续复用现有对话框。去掉无助于用户决策的实现说明，核对头像、名称、页签留白及明暗主题。仅修改 Bots 展示，不新增存储或 Runtime。
  - [x] ~~1017V 共用名称输入的DeepSeek并发版本定向验收。~~正式工具更新目标资料时，详情名称／侧栏实时变更，未提交的旧名称草稿仍保留；Enter提交被版本校验拒绝。明确重试使用当前版本，仅更新名称，再通过界面恢复原名，版本11→12→13→14；取消冲突草稿也已实屏验证。旧字段、其他Bot／群／例行及178份跟踪文件不变。最初两次模型SQL路径不合格，保留于1017V与1017W失败记录；最终成功使用bot_update_teammate。此项只证明共用BotNameInput的私聊并发、取消与明确重试路径，群成员并发／IME／Windows不据此代验，1015AH父项仍待验。证据quality-review/1017V-name-conflict/{before,after-notification,before-build}.json及1017W的formal-update-{before,after}-retry.json、successful-attempt-review.json。
  - [x] ~~1017Q 群名称原位编辑及原子输入框Escape／回复派发的定向验收。~~既有合成群名称Escape取消不保存，Enter临时改名、失焦恢复原名；成员ID／顺序不变、实际version7→8→9。原子编辑器的Escape回退修复及失败证据见下；中文组合态、并发冲突和Windows仍按原项待验，不据此勾选1015AH整项。
    - 旧包实际失败：群名Escape取消、Enter临时保存及失焦恢复成功，成员不变、版本7→8→9；但聚焦原子输入后多次Escape均未取消回复且文字完整。核对本机依赖ProseMirror capturekeys.ts的keyCode27默认捕获与input.ts的preventDefault，确认事件在到达React表单前已被标记，外层defaultPrevented保护因此跳过取消。只在既有编辑器按键处理回调中连接父级取消动作，候选关闭和输入法保护先执行，保留表单对其他焦点的处理；不改公共编辑器、按键库、Runtime或草稿存储。失败证据escape-before-fix.json，修正后用同一保留草稿复验两级Escape和真实DeepSeek发送。
    - 修正复验通过：Grok重建源码rich-text-editor.tsx同样通过editorProps.handleKeyDown调用当前onEscape，沿用该接线方式，仅将既有取消回复回调传入BotGroupMentionInput；@候选优先、组合态提前返回，保留原表单对其他焦点的处理。正常Quit72633且ps确认结束后构建，以原配置启动84665；同一文字／引用草稿跨退出恢复。新版聚焦输入按Escape立即取消引用且不改文字；重新引用并输入@，第一次Escape仅关闭候选、第二次取消引用，焦点和文字保持，删除本轮测试@后重新引用发送。恰好一条DeepSeek任务0004a7b9…completed／0工具，实际回复“资料核验-1015AE／外观核验-1014A／7.40”；无@时仅原作者被派发，另一MiniMax成员无任务。历史保留真实reply_to_id，点击原文可见；成功后草稿与引用清空，本条群请求未进入原私聊thread。455任务／0活跃、quick_check=ok，454份旧任务、76条旧群消息、178份跟踪文件、Bot／例行及其他群定义均不变。编辑器／提及28项、群草稿16项、原messages回归、web类型、格式及正常构建通过，未改Runtime／数据库／公用编辑器或添加计时器；BV启动仍需原生Zoom，MiniMax额度及Windows等门槛保留。证据quality-review/1017Q-group-name-reply/{before,escape-before-fix,sent,final-storage,review}.json；/tmp/cmb-1017Q-{tests,drafts,messages,web,build}.log。



  - [x] ~~原位名称编辑的基础实现与实际保存。~~ 原应用实屏 Escape 取消后控制版本仍为 1，Enter 改为“资料核验-1015AH”，切换页签失焦后恢复“资料核验-1015AE”；最终版本 3、群 ID／两位成员／历史及四份成果保持不变。复用原版本冲突与订阅，无新存储。49 项相邻 IPC／群历史／编辑投影／草稿测试、web 类型检查及构建通过。证据 `quality-review/1015AH-group-name/evidence.json`。中文输入法和并发冲突的界面提示尚未实测，不据此勾选父项。
- [x] ~~1016B 正文排版与气泡高度。当前 Bots 外层设置 14px，但复用的 StreamingMarkdown 自带 15px／1.85 行高，仍覆盖外层，造成私聊／群聊正文和气泡偏大。以当前官方 0.71.2 CSS 的正文行高 22px、上下留白 7px、单行气泡高度 36px 为依据，仅在 Bot 消息正文内统一字体、行高、段落间距与继承颜色，保留代码／表格／标题语义及原工作台样式。新版实际核对短句、长段、列表、代码、明暗主题及窄面板后再划掉。~~
  - [x] ~~1016BL 正文实屏补验。复用原混合模型群及已有MiniMax／DeepSeek私聊，不改样式或模型配置，用相同固定Markdown核对短句、长段、列表及代码块；对照官方Grok同题输出。通过原外观设置核对明暗主题，并恢复原暗色／80px侧栏；窄窗口与原位详情保持正文和输入框共同边界。仅发送合成文字，不写文件或记忆；模型／显示证据分开，静态截图不能代替动画／IME／Windows验收。~~
    - [x] ~~1016BP 补齐剩余正文检查。原混合模型群只发送一个新的短句核验，让MiniMax和DeepSeek各仅回复“排版完成”，核对单行气泡在明暗主题下的高度与留白；已有MiniMax私聊1016BL输出另在浅色主题检查列表／代码，不再生成重复长文。依据当前原生截图、现有14px／22px及7px内边距样式判断，不将源CSS数值当作浏览器实测像素值；恢复原深色、80px侧栏、空草稿，不改生产样式或记忆。~~
      - 原应用真实DeepSeek任务05bb4cc1…、MiniMax任务f7c81c7b…均completed、0工具调用、可见回复恰为“排版完成”。原生截图已核对同一两份回复的深色／浅色单行气泡，文字与上下留白紧凑一致，无空白工具行；正文／输入框共同列保留。327→329任务、0活动任务，19份既有群文件／记忆哈希、25份Bot定义及群定义不变，control.sqlite quick_check为ok。初次MiniMax私聊截图前Mac锁屏，未当作通过；解锁后原生截图已完整核对其1016BL浅色短句、长段、三项列表和两行代码，无裁切／溢出。官方Grok私聊同题实际回复“排版完成”、显示已回复，单行气泡同样紧凑；官方模型未知，不据此宣称全页像素相同。原应用已恢复1440px窗口、深色／Bot配色、80px侧栏、关闭详情／设置及空输入框。此项补齐B／BL约定正文样例，不代表全部UI、动画、IME或Windows通过。未改生产代码。证据quality-review/1016BP-typography/{before,tasks,layout-observations}.json。
    - 1016BM修正后已实屏核对群双模型明暗正文、DeepSeek私聊浅色／MiniMax私聊深色，以及原生Window→Move & Resize→Left形成的1201px窗口：360px详情开启时长段换行，三项列表及两行代码均未溢出，正文／输入框共同边界保持。已通过原菜单恢复原1440px窗口、深色、80px侧栏、关闭详情及空草稿；本轮未新增排版样式。官方Grok同题私聊输出的段落和代码可见，模型身份未知。证据quality-review/1016BL-typography/{tasks,grok-observation,layout-observations}.json。截至本阶段MiniMax私聊浅色与单行气泡尚未独立截取，未据部分结果勾选；后续1016BP已补齐原生截图和官方同题单行对照。36px为对照CSS设计值，未冒充DOM实测像素，不宣称全页像素或动画一致。
    - 首轮四条真实任务均completed且0工具调用。私聊及官方Grok私聊保留固定正文空行；本地群输入在粘贴时压掉连续换行，两个模型均收到并回复了丢失空行的正文，因此不能将群排版记为通过。原始输入／输出保留在quality-review/1016BL-typography/tasks.json。源码定位为ProseMirror默认纯文本剪贴板解析按连续换行合并分段；既有groupEditorContent／Draft本身可保留空段。
  - [x] ~~1016BM 群输入纯文本粘贴保留空行。复用既有groupEditorContent生成文档，通过ProseMirror原clipboardTextParser返回Slice，沿用原选区替换、撤销、字数限制及附件粘贴入口；不新建草稿或手写DOM选区，不让粘贴文本生成收件人权限。补充空行／CRLF／代码／选区覆盖和已有提及的真实编辑事务回归，再用真实MiniMax和DeepSeek复跑同一固定正文，核对持久化消息、绑定的@所有人及两份实际回复。原工作台输入框不改。~~
    - 新版真实DeepSeek-v4-flash任务71b21922…、MiniMax-M2.7任务94a10e25…均HTTP200、completed、0工具调用；群消息与固定文本逐字一致（包含所有空行），@所有人保留一个绑定原子并准确派发两位成员，两份实际回复也均逐字符合固定正文。实屏段落、列表及两行代码正确显示。18份既有群资料／记忆哈希和群定义未变，317→319任务、0活跃任务。21项编辑器回归覆盖真实Slice选区替换、CRLF、空段、已有提及ID及undo/redo，另7项提及、25项草稿／发送回归、messages、web、build及变更文件lint通过。正常退出旧主进程75381并确认结束后构建新版，不用旧进程结果充当复验。证据quality-review/1016BM-group-paste/{before,started,after}.json；1016BL明暗／窄布局及整体动画仍待验收。
  - [x] ~~1016F 混排正文的定向对照与复制。~~ 官方 Grok 与原应用真实 DeepSeek 同题均输出列表、金额表格和两行 JavaScript。仅在 Bot 正文范围统一 14px／22px 排版，表格改为横线、透明底，无纵线／外框；代码块移除常驻语言栏，保留悬停／聚焦复制入口。原 Markdown 解析、横向滚动和代码复制继续复用，原工作台无样式变更。新版实际核对明暗主题、短句／长段／列表／表格／代码与行内链接；点击复制后将两行原代码粘到空输入框，内容完全一致，随后清空未发送。深色窄 CSS 视口已验证详情开关、消息换行、中文多行和 192 字符连续英文草稿，测试草稿清除、缩放恢复；这是 View 缩放形成的响应式视口，不冒充物理窗口或 Windows 验收。任务 `90d633fb-8961-4ab8-a1d0-ef3ec2307178` completed，0 工具调用；两模型正文措辞不同保留原样。证据 `quality-review/1016F-typography/evidence.json`。完整消息布局与全部窗口尺寸仍由 P09 验收，不据此勾选整体 UI。

- [x] ~~1016H 私聊／群聊详情名称原位编辑。~~ 官方 0.71.2 实屏两者均为可聚焦名称输入。将 1015AH 已有实现抽为同一 BotNameInput，私聊／群聊分别接原 update／saveGroup；保存携带开始编辑时的版本，显式重试才用最新版本，不新增存储或 Runtime。原应用实测私聊 Enter 改名、失焦恢复；群聊 Escape 取消、Enter 改名、失焦恢复，列表／标题同步。SQLite 确认私聊版本 4→6、群版本 3→5，名称均恢复，原 ID／thread／模型／职责／成员等其他字段不变，任务数保持 229。67 项原 Host、群历史及资料事件回归、web 类型检查、构建通过；证据 `quality-review/1016H-inline-name/{before,bot-renamed,group-renamed,after}.json`。本项不冒充中文 IME、实屏并发冲突或 Windows 验收；1015AH 其余布局继续保留。
  - 新版原应用已实际检查深色／浅色、中性／Bot 配色的私聊，以及浅色群聊的多段正文、列表、行内代码与提及。发现群链接仍沿用原工作台的棕色主题、短行内代码会被强行拆字；继续仅在 Bot 消息正文修正，不改变原 Markdown 解析／打开文件行为。构建及原消息回归通过，完整窄布局仍待验。
- [x] ~~1016D 过期后台状态展示。~~ 实屏确认一个已中止的旧工作流让后续普通聊天永久显示“后台任务已停止”，与当前正在处理／已完成状态并列。复用原消息投影的最近用户下标及时间解析：运行中的后台任务持续显示，当前轮次的完成／中止／失败提示保留；有后续用户消息时，旧终态留在原执行过程／工作流历史与任务记录，不再作为当前状态悬挂。时间未加载时保留原提示，不新增历史扫描或订阅。不改工作流调度、终态或通知，普通工作台沿用原面板。新版原应用 Reload 后确认过期底部提示消失；展开执行过程仍显示真实的“timer-foreground-1014G2 已中止”和运行历史入口，收起后恢复简洁视图。24 项状态／消息投影相邻测试、原 messages 回归、web 类型检查和构建通过。此项仅修正展示归属，不代表后台工作流恢复或所有终态实屏均已验收。

- [x] ~~1016Q 私聊内容列与主题气泡色。~~官方 0.71.2 `sand-virtual-transcript` 和 `sand-chat-input-dock` 共用 960px 列／最小 16px 页边距；`Ps.message` 使用 `min(80%,560px,100% - 82px)`。本地私聊仍受原 max-w-3xl（768px）限制，气泡为 640px。仅在 Bot surface 覆盖既有内容列与气泡规则，保留消息／输入／虚拟列表结构和原工作台。官方 botTint 使用独立 fill/{hue}-bubble-user 与明暗文字色，本地却用头像亮色＋黑字；从官方安装包的纯主题解析函数提取九种明暗气泡色，复用静态色值和现有暗色 class，保留头像／持久颜色及自定义颜色兼容，不导入整套主题引擎、不读取用户账户。来源、函数闭包的全局依赖及色值保留于 `quality-review/1016Q-layout-source/`。按同一视口核对私聊长文字、列表／代码、明暗主题与窄布局，未完成不代表整体 UI 一致。
  - 1016Q 定向验证：九种生产气泡明暗色与官方纯解析器独立结果 9/9 一致；9 项头像／消息入场测试、web 类型检查和构建通过。原应用 Reload 后实际核对 AP 长请求与列表：正文／输入框共用 960px，蓝色气泡使用浅字；再核对外观核验 A 的浅色青色气泡及列表，View 放大至内容列小于 960px 后两侧仍对齐、长中文正确换行、输入与加号同排，未发送新任务或改写身份。缩放恢复 Actual Size、主题恢复深色。混排代码基础由 1016F 验证，本轮未重新定位该旧消息，不将此子项扩展为完整明暗／代码／所有尺寸验收。对照证据 `quality-review/1016Q-layout-source/production-colors-comparison.json`；整体 P09 保持未完成。

- [x] ~~1016R 详情身份区比例。~~官方 0.71.2 Qy／Pq 使用 64px 私聊及群头像、头像与文字间距 16px，名称／标签同组间距 4px；名称 heading3 为 17px／24px、字距 -.008em。本地私聊头像仍为 104px，群头像 84px，且名称／标签各自占一层大间距，详情显得拥挤。复用原头像、原位名称及标签编辑，仅校正 Bots 身份区尺寸与结构，保留运行状态和保存逻辑；来源 `quality-review/1016R-details-source/`。验证私聊／群详情、切换页签、头像弹层与缩窄后不溢出，再划掉。
  - 1016R 原应用实屏：群头像／名称按新比例显示；进入成员页后点击 AP 打开正确私聊，头像编辑器仍选中原六边形／蓝色，Escape 返回头像焦点且未修改配置。原生 zoom 将窗口从 1920px 缩到 1500px，详情／标签／页签／长消息与输入框无溢出，头像不再挤占大块空间。web 类型检查和构建通过；头像组件 lint 的常量转导已改为从既有 shared/appearance 直接导入。BotsWorkspace 原有 setReady effect 的 lint 告警与群附件 cleanup 告警仍保留，不把构建通过记为全库 lint 清零。实际几何与交互通过不替代全页像素／动态一致性验收。

- [x] ~~1016U 群聊共同内容列。~~官方 0.71.2 同视口实屏确认群输入框与私聊同为 960px，成员头像位于其左边界，气泡向内偏移；窄视口沿用 transcript／input-dock 的最小 16px 留白。本地群宽度 1000、两侧 28 导致实际输入宽 944px，窄布局也多留 24px。沿用现有群消息、输入框与头像布局，只让群内容变量从统一 chat-column 与 16px gutter 推导；不修改提及、草稿、派发或原工作台。
  - 原应用实际核对 1920px 窗口详情开／关、1500px 原生窗口及放大后小于 960px 的内容区：消息头像列、用户气泡末端与输入框共用边界，三行中文草稿正确换行，末行与加号／发送按钮对齐，无横向溢出。仅输入合成草稿，随后清空且未发送；缩放恢复 Actual Size、窗口恢复最大化，其他草稿未动。web 类型检查、构建通过（`/tmp/cmb-1016U-{web,build}.log`）。本项验证共同列，不替代全部附件、输入法或 Windows 验收。

- [ ] P09.1 实现三栏工作区、外层导航收拢、面板尺寸调整与明暗主题。
  - [x] ~~Bot 工作区提供明暗／跟随系统主题及黑色／Bot 颜色强调色入口，侧栏底部保持单行。~~（1014AQ）对照官方 Grok 0.70.2“设置—通用—外观”的实际选项；主题直接复用原 theme-preference，强调色保存在现有 Bot 视图偏好中。Mac 隔离配置在 218px 侧栏核对明暗切换、气泡配色、冷启动保留及返回原工作台；文字按底色选择对比度，修复原用户文本样式覆盖继承的问题。未配置新字段的旧偏好保留灰色样式，群无独立配色时保持灰色。messages、web 类型检查、构建及颜色边界校验通过；本项不代表全部尺寸或像素／动画已对齐。
- [ ] P09.2 完整实现 Bot／群列表、创建编辑、搜索未读、消息、输入框、详情、资料及预览交互。
  - [x] ~~1019DS 新建聊天的多收件人、首次发送及草稿归属。~~ 对照官方0.71.2实屏及安装包new-chat-bar：Cmd+Shift+N打开收件区，点击首位Bot保留可移除标签并继续选人；空搜索退格移除最后一位。复用原Bot创建弹窗、群保存、附件导入、ThreadContext持久队列／BotDraftSender与sendGroupDraft；移除原先选一位立即跳私聊的分支。点击收件人期间不建群／不派任务；收件栏Enter只打开会话并带入草稿，消息区明确发送才执行。私聊新消息独立入原队列，不提交目标原有草稿；群首次消息先交给原持久草稿。复用既有请求回执、提交锁及文件缓存，最多8位、去重、准备失败保留；未增加执行器、消息队列、Host API或模型重试策略。
    - Mac实屏：连续选两位、移除、空搜索退格，任务／群仍为1180／11；群首条消息最终版原文精确一致，真实MiniMax-M2.7与DeepSeek-v4-flash各执行一次、各回复43。普通新聊天单人首条私聊同样双模型通过，原目标两份合成旧草稿保留且从未提交，随后仅清理自己的合成文字。收件栏Enter创建一位Bot的空群并带入合成草稿，任务数仍为1184，未发送；符合当前Grok群模式行为。原工作台返回及Cmd+Shift+N隔离实屏通过。
    - 21/21本轮核验通过；原1180任务、50Bot、11群、15例行、54命令、301文件与6175消息头保持。最终1186任务／14群／94线程／6187消息头；新增两组真实任务群及一组仅草稿空群，文件仅增加两个实际执行群的49字节setup-state.json。首轮检查误以为不能有任何新增文件而失败，已按这两个明确初始化路径收窄，原失败报告保留。用户39字符草稿哈希不变。47项定向测试、消息回归、web类型、相关辅助组件lint与正常构建通过；BotsWorkspace整文件既有1错误4警告仍记录，不宣称整文件lint通过。证据quality-review/1019DS-new-chat-recipients/{verification,tested-build}.json。
    - 第一条群样本因多种电脑输入尝试叠加夹字，不计原文一致通过，原消息和记录保留；最终版单次输入再次精确核对后发送，四条正式执行样本均零工具回复43。用户截图对应MiniMax请求确有60秒响应头超时，第二次fetch失败、第三次200恢复，任务已完成；未据此改公共超时／重试。未commit／push。
  - [ ] 1019DS后续边界：附件数据路径与精确创建交互分别见DT／DU；实际存储／传输失败界面、Windows及原生IME组合态仍需复验。不据这些单项勾选整个P09.2、整体UI／动画或长程任务交付质量。此前“新建Bot返回标签”的假设已由当前官方实屏纠正，不再作为目标。
  - [x] ~~1019DT 首条附件任务的数据与交付闭环。~~ 在新聊天暂存合成CSV，确认目标后沿用原文件选择／解析、文件导入、队列与交付接口；分别以新MiniMax／DeepSeek Bot读取原件、生成核验报告、读回并交付报告与CSV，独立核对三笔记录、11.33合计、与11.30差额0.03、原件SHA及真实工具回执。官方同题产物另行保存核对。此项只验收数据与文件交付；创建后应进入私聊还是保留标签，以DU的当前官方流程为准，异常、Windows与原生IME仍未完成。
    - 1019DT数据闭环已实测：新建MiniMax／DeepSeek两位Bot，原生选择同一63字节CSV，实际read_file原件→write_file报告→read_file报告→bot_deliver_files，均一次完成。两个报告逐行保留三笔金额、11.33合计与0.03差额，原CSV SHA相同；报告均从UI打开，DeepSeek两份文件原生保存验证。官方Grok同题两个产物已原生保存并独立核对，数字及CSV字节一致；其报告使用云端ULID文件名，本地保留原中文名。MiniMax结论含“数据真实无误”，超出本次数据复算证据，质量差距仍保留；Grok内部工具／记忆无服务端证据，且使用已有合成会话，不代替完整D07三方初始条件控制。
    - 39/39数据／保存／保全核验通过，原1186任务、50Bot、14群、303文件与6187消息头保持；本轮最终1190任务、53Bot、14群、309文件、96线程、6207消息头。三位新增Bot含一位仅用于已有成员保留的PAIR，PAIR未执行任务；未新增例行或命令。用户原草稿哈希相同，本轮新聊天测试草稿／附件已清空。证据quality-review/1019DT-new-chat-attachments/{verification,local-model-evidence,draft-protection}.json。未改变生产代码，未commit／push。
  - [x] ~~1019DU当前版本精确创建交互纠偏及首次发送。~~ 官方0.71.2实屏及index-wlkGG389.js的uC／nlt／Xp确认：仅一个新名字时打开原名称／头像弹窗，取消保留搜索名，创建后直接进入私聊并交接草稿；已有成员后选择“将…添加为新Bot”只暂存名字，确认时才创建并进入群聊。已按此修正前端收件人类型与来源，复用原create／saveGroup、文件缓存、ThreadContext队列与BotDraftSender，不把名字当身份；部分创建成功后保留结果供同次重试，不新增Host接口、执行器、存储或轮询。移除已有成员后只剩新名字时仍走私聊创建；独立＋不挪用收件人名称，取消保留原草稿。
    - 实屏混选一位原Bot和一个新名字：确认前未写入新Bot／群／任务；确认后只新增一个Bot和群，消息明确发送前仍无任务。一次群消息得到两位成员各一条43，真实成员ID和任务回执已核对。新MiniMax／DeepSeek Bot均通过原生选择同一63字节CSV，创建后私聊完整保留任务和附件、未自动发送；正式发送后跳过未答入门题，读取原件→写报告→读回→交付两份文件，DeepSeek另执行一次本地字节检查。两份报告实点打开，四个产物通过原生保存框落盘且与工作区原件逐字节一致；合计与差额正确。MiniMax本轮结论没有此前DT的“数据真实无误”，单次改善不等于整体交付质量达标。
    - 首轮“显式发送后创建”失败：客户端先open触发欢迎，再交办任务，MiniMax只问候、未执行首条任务，失败现场保留。仅将此入口改为先交给原持久队列、再由原会话组件open，沿用原Store中首条用户任务抑制欢迎的规则；不改Runtime注入／提示词。修正版两位新Bot各只有一条user任务、零introduction／工具，均实际答43；后续最新构建两模型再各一条私聊答43，均未重复派发。
    - 收件候选复用Bot现有中性色菜单；容器改为presentation，子listbox语义不变，避免Radix默认dialog误拦Cmd+N。实屏确认候选打开时Cmd+N进入空名称的独立创建弹窗，取消后搜索词／草稿完整；未创建该合成候选。新聊天长草稿沿用已有field-sizing方式增高，无新增计时器、逐帧React更新或共享样式修改。
    - 44/44本轮限定核验通过：原1190任务、53Bot、14群、309文件与6207消息头保持；最终1202任务、59Bot、15群、319文件、103线程和6247消息头。原线程的身份、标题、状态与创建时间保持，三条既有线程仅updated_at变化，单独记录；首轮把时间戳变化视为不应有的差异而失败，原报告保留。原39字符用户草稿哈希相同，测试新聊天草稿／附件已清空，无新增例行／后台命令或遗留活跃任务。65项定向、原消息回归、web类型、辅助组件lint与正常构建通过；沿用DL已记录的整组件lint基线，不宣称全库通过。证据quality-review/1019DU-recipient-semantics/{verification,latest-model-evidence,tested-build}.json及分版本失败／实屏记录。未commit／push。
    - [x] ~~1019ER 新群空态、最近活动与首条消息（Mac双模型限定验收）。~~官方0.71.2经Cmd+Shift+N选择REFERENCE／MIXED、空收件栏Enter建立新群，立即显示“还没有消息”，观察数分钟未见主动欢迎；本地同一流程生成持久空群、零消息／零任务，不增加入群任务或欢迎提示。首条无提及请求的成员身份及2位Bot／1位人类由官方同题和本地真实双模型核对；账户姓名参与默认群名及组合头像另记，不将空态观察扩大为所有入群通知行为已对齐。
      - ER现场差异：新群在Grok立即排到侧栏首位，本地空群却在未分组末尾；原orderBotConversations仅按activity排序，Bot有createdAt兜底，群为0，saveGroup未生成activity。最小修正只在新群首次保存时调用原noteActivity(group,id,空预览,false)，沿原有界列表元数据记录创建时间且不标未读；编辑／成员变更、旧群、消息／执行与原工作台不变。不得为此新增createdAt字段、排序偏好或第二份活动状态，须检查建群零任务、改名不置顶、首条消息／未读及重启。
      - ER首轮真实失败保留：修复空群排序后新群立即在未分组首位，建群仍零任务／零消息；首条无提及消息确实分别派给MM／DS，但DS说人类人数无法确认，MM答0位。官方同题两位均答2Bot／1人类；本地群定义memberIds只有Bot，现有Bot环境段未说明唯一人类用户，不能把人数错误算作已对齐。参考Grok system-prompt-assembly.ts中renderUserIdentitySystemPrompt及Hermes group-round-prompt.ts的room用户／Bot区分，仅在既有本地群环境段补当前应用有1位人类用户、Bot列表不含用户的真实边界，不猜姓名、不改消息角色／授权／Runtime或新增人员存储；私聊保持原文。首轮可选复核还含重复确认及混合pass，作为质量差异保留，最终复验与官方使用同一句任务，不追加本地测试的pass提示。
      - ER上下文补充：群名可任意修改，原首次请求并无完整成员名单；沿sendGroup已有memberNames只追加当前群的Bot身份参考，不取全局快照、不增接口／查询或修改原Host routing对象。首次把名单加进routing的候选触发原精确路由回归，已撤回该字段，保留原路由对象与断言，改为独立引用资料。新增实际SQLite回归验证非成员不泄露、单收件人不扩成全群。最终新群将用不含成员名的名称复验，防止靠名字猜人数。
      - ER旧历史复测未过：最终新命名群两模型虽答2Bot／1人类，但在保留旧错误回答的首轮群中仍答0／无法确认，故不按全修复处理。仅在system群环境追加说明的候选已原样归档并撤回，prompt.ts／prompt.test.ts恢复改前原件；改为在同一份当前群事实JSON中同时提供humanUserCount=1与原memberNames名单，位置紧邻该轮真实路由，原Host routing对象仍不变。不增加权限或模型输出过滤，不把用户请求改成带正确人数的题目。需对原失败群继续真实双模型复验，源失败／新群局部通过均保留。
      - ER最终复验通过：最终成员资料接线在原失败群与全新“群创建终验-1019ER”（名称不含成员名）分别运行MiniMax-M2.7／DeepSeek-v4-flash。四次实际执行均准确给出各自名称、2位Bot／1位人类；用户题目没有提供正确人数，两次可选复核均原样返回(pass)，未形成额外可见答复，六条任务零工具。空群已作为最近活动显示且保持已读；改名不刷新活动、不派任务；首条消息和回复继续走原活动／未读机制。正常Quit、exec exit0并独立确认零进程后，以同一构建重启，任务／结果不重放。首轮人数错误、重复确认、混合pass及system候选在旧历史中失败的记录全部保留，不由最终局部通过抹去。
      - 本项最终生产diff仅Store 10增／6删（其中实际接线为原3增／1删，其余为格式），实际SQLite回归75行，prompt及其测试已恢复改前原件。706项／59文件、node类型与正常构建通过；Store末次清除6条格式告警后lint零错误零警告，esbuild归一输出与真实双模型受测源码完全相同，未据格式变化重复运行模型。host.test整文件4条既有lint错误已用改前原件复现，不能宣称全库lint清零。源／产物清单、格式等价证明和45项限定核验见quality-review/1019ER-new-group-first-message/{tested-build,formatting-equivalence,verification}.json；其余Runtime、共享契约与renderer保持本项前哈希。
      - 数据保全：原1418任务、60Bot、17例行、60命令、356份工作文件／记忆及7039条消息头保持；最终1435任务／22群、零活动任务／讨论游标／待处理命令。17条新增任务包含失败样本，任务completed不等于功能通过；新增文件仅三个执行群的setup-state.json。用户确认自行将“双群隔离核验-1019EF-B”的DeepSeek移除，严格保留该群version3及仅MiniMax成员，其他原群定义不变，不把这项已确认编辑误报为异常或回滚。两数据库quick_check通过，无commit／push。当前本机单用户的humanUserCount=1不扩展为远端多人语义；Windows、全部UI／动画及完整资源指标仍未验收。
    - [ ] 实际存储／传输失败界面、Windows／原生IME、账户姓名参与群命名及组合头像仍待核对；本轮还观察到本地群标题多出资料／浏览器／设置快捷入口，须先核实现有详情页是否覆盖同样能力，再按官方布局收敛。候选定位、各宽度排版、全应用UI／动画和长程交付质量继续按原父项验收。本项通过不替代一期核心与整体体验验收。


  - [ ] 1018BZ 收完已开始的资料编辑检查，再回高优先级核心项。官方0.71.2标签Escape后焦点到页面根、随后Tab回标签按钮，本地同路径实际一致，不为此重写组件。沿用既有BotProfileLabel／BotNameInput与Store版本保护，核对标签保存／取消、并发资料变更时保留草稿及明确重试、最后恢复原资料；仅合成Bot，无数据库直写，不改共享组件或Runtime。完整IME、Windows及整体UI另记，不能用本项代验。
    - [x] ~~本轮只读标签取消／下一Tab对照完成。~~官方与本地均先回HTML根，随后Tab到标签按钮；没有确认需要修改组件的差异。初次本地只读观察实际绑定mask，未修改其标签；后续可变数据限定合成BW同事。DeepSeek b6a36f05…／800b1ce4…各list／一次前台45秒Node／update_teammate，先改合成MM名称再恢复；原字段全部恢复，仅version2→4及时间变化，其他37Bot、群／例行／命令、247文件与原765任务保持，新增2条completed，0活跃。既有资料组件／Store／Host及本轮前index.js、application.js哈希不变，无生产UI修改。
    - 并发保存仍未验收：电脑工具出现旧画面／AX、elementHasNoFrame／noWindowsAvailable和发送前校验失败；实际45秒窗口没有可靠证明标签先进入编辑，旧名／新名观察不同步，不能把未落盘当作版本冲突成功。真实修改结果以工具回执和控制库只读核对，原记录保留。原进程76697及3个所属进程正常Quit全部退出后同配置重开，恢复草稿使未发送的名称恢复请求仍可核对并唯一发送，没有重复任务。此处不推断产品render或Runtime根因；返回mask／窗口尺寸的最后操作也未可靠确认，保留界面还原待核对，不声称原草稿丢失。证据quality-review/1018BZ-profile-editing/{before,task-windows,after-peer-rename,after-attempts,review,restored-ui}.json与原生AX记录。该原生操作限制不扩大为新增UI兜底；按用户要求先继续P03核心缺口，未完成的保存／冲突仍保留。

  - [x] ~~1017AI 记忆分享接收方菜单与Mac双模型验收。~~复用BotEditor／BotSchedulePanel已有components/ui/Select，取代该面板的原生select；参照Grok SandSelect的视口边界／圆角菜单，沿用Bots现有100ms弹层动画、减少动态效果规则与头像弹层的中性明暗配色，未移植新浮层体系或修改公共Select。高度／宽度受视口与入口约束，空选择禁用分享，已归档／自身不在候选中，已选接收方失效也禁用。实屏33个候选上下滚至首尾、首版Home／End、Escape返回入口、取消不写入、明暗配色均核对。正式界面核对接收方后分别仅复制AH合成事实给K-DS的71390b92…和AC-MM的59442256…，两副本SHA均等于源件2b4e34c0…；先DeepSeek任务bf242322…仅get，再MiniMax任务1e8f9a62…仅search／get，实际读取各自ID、当前正文及版本，均completed／工具成功。原545任务、34Bot／9群／9例行／21命令及201旧文件保持；仅新增两份合成事实及MM首次搜索生成的原SQLite索引（不是第三条事实），最终547任务／0活跃、两数据库quick_check=ok。web类型、该文件lint、格式及最终构建通过；恢复深色、用户sean1所在需求沟通群、295px侧栏、详情关闭与空输入。证据quality-review/1017AI-memory-recipient-select/{cancelled-menu,deepseek-share-proof,minimax-share-proof,model-results,model-routing,review,ui-and-checks,final-storage}.json。
    - [ ] 边界仍单列：接收方在菜单开启时归档的实际并发UI路径、Windows及全部动画曲线未实测，不能从本项扩大为P09／整体Grok一致。预览冷启动仍遇到BV画面与AX不同步，原生Zoom后继续，本轮没有加入生产缩放／重绘补丁；部分电脑工具绑定失效及一次打开编辑而未改动的取消均未写入记忆。此改动无新增常驻监听／计时器／动画时钟，菜单仍由原Radix管理挂载和清理。
  - [x] ~~1016AC 私聊引用回复。~~官方 0.71.2 实屏确认：私聊消息菜单的“回复”会在原输入框上方显示可取消的引用、聚焦输入，并提供返回原消息入口；此前仅实现群聊，私聊尚缺此项。先核对原 Cmb 消息读取／定位、QueuedMessage、BotDraftSender 的持久与未知回执恢复接口，再复用同群引用已有的真实来源／范围校验方式补齐。必须保留原草稿、附件、请求 ID、引用来源和重载状态；不能用临时拼接一段模型回复冒充可信的历史关系，也不能让跨 Bot／线程的引用扩大访问范围。仅为 Bots 加必要可选接线，不另建聊天存储、执行模式或 Runtime；完成真实引用／取消／恢复／发送与定位后再划掉。
    - [x] ~~1016AI 引用跨历史窗口定位。沿用 AP 的真实旧消息，先在界面选择最早回复作为未发送草稿的引用，再 Reload 恢复初始历史窗口；确认原文在窗口之外后直接点击引用，由原历史定位接口加载并定位真实来源。实际跳转前不手动加载来源、不新增模型任务、不重写历史。核对滚动位置、源文、返回最新及草稿保持。~~
      - 首轮与冷启动复验均复现“来源已取回、视口仍在最新内容”：130 条历史默认读取 128 条，引用 ordinal=1 后早页入口消失、历史间隔入口出现，但实屏仍显示 1016AH2，草稿保留。源码中跳转 Promise 的回调捕获了加载前的 scrollToMessageById／消息索引，无法定位新加载 ID；参照原搜索组件使用最新回调引用的方式，只修正 Bot 引用的异步接线，不改原分页和公共滚动状态机。复验通过前保持未勾选。
      - 最新回调接线单独修正后仍未完成真实跳转，不将该修改当作完整根因或修复证明。临时增加不含正文的 start／loaded／pending-layout／scroll 诊断，核对异步回调、索引、虚拟列表及页面可见状态；交付前撤除，未完成前不勾选。
      - 最终复验通过：诊断证明页面 visible／focused、加载与回调均完成且目标索引为 1，但新窗口的虚拟行尚未挂载。沿用原搜索即时定位与原 waitForTranscriptCommit，先等虚拟列表提交新窗口再定位；异步回调使用最新索引，并复用原导航 generation，切换／滚动／新跳转后不执行旧请求。原非 Bot 调用仍默认 smooth，已挂载消息保持原 DOM 平滑滚动，不改分页或滚动状态机。AI3 与撤除诊断后的最终构建均从“加载更早的 2 条消息”状态首次点击直接显示最早真实回复 41.75；返回最新仍显示 AH2 且引用／草稿保留；取消引用只移除引用，随后仅清空本次合成草稿。130 条持久消息内容哈希完全未变，264 任务／0 活跃、21 Bot／7 群不变，控制库 quick_check=ok。web 类型检查、原 test:messages、构建通过，源文件及全部 renderer 产物无诊断标记。证据 quality-review/1016AI-reply-history/{before,after}.json 和分阶段事件日志；此前失败记录保留，不据此勾选完整 P09.4／Windows。
    - 1016AE 重启回看补充：无附件引用恢复通过，但附件原文在原 DB 的可见历史投影中变为“附件名＋正文”，引用块不再位于首字符；快照先截 600 字符也会截断附件 XML。已收回本项完成标记，继续兼容原附件显示前缀，并在 Store 的原有 600 字符 SQL 投影中跳过已验证引用头；不扩大快照、不保存第二份预览、不添加 schema。真实重启回看通过后再划掉。

    - 实现沿用原单条消息查询、ThreadContext 草稿／队列、BotDraftSender 回执、群引用展示和消息窗口定位。主进程只按当前 Bot 私聊 thread 解析真实来源与最多 8k 可见文本；引用关系随原 origin 保存，控制任务清理后仍保留可读关联，未新增消息库、checkpoint 或 Runtime。引用中的协议字符转为 JSON 转义，原浏览器前缀、附件与尾部技能块保持位置；无引用发送不改变。
    - 原应用真实 MiniMax：`ea975d96-146c-44ef-b1ea-2080e47ba5dc` 引用持久消息 ordinal=99，仅回复 `17 + 24 = 41`；`1a38e560-ac5b-4f4c-aaa7-e12c14a032cf` 同时引用回复并通过原生选择器导入 quoted-input.csv，准确交付文件名、2 行、20.75 与差额 -20.25。两条各一次 completed、0 工具调用，发送后文字／附件／引用清空；真实引用／取消保留草稿、Reload 恢复、正常 Quit 后历史引用、再次引用用户消息、编辑重新填充与原消息跳转均实屏核对。112 项针对性测试、node／web 类型检查、messages 回归与构建通过；已有 ChatContainer lint 10 个 warning 保留、无新增 error。证据 `quality-review/1016AC-private-reply/`。本轮定位源在已加载历史内，跨历史窗口复用原定位 API，但未以此声称全部极长历史和 Windows 已实测。
  - [x] ~~1016AD 最近工作摘要的附件显示。~~1016AC2 实屏发现右侧“最近工作”仍展示 attachment XML、工作区路径及文件正文；聊天气泡已经使用原可见文本投影。仅在 Bot 用户任务摘要复用原附件清理与 `projectVisibleChatSearchContent`，保留附件名与用户正文，引用按真实 origin 去除传输块；不改原消息、文件、Runtime、调度或其他来源。针对性验证及原应用历史回看后再划掉。
    - 最终干净构建以相同预览包、相同 data／Electron profile 从项目目录启动，版本恢复为项目 1.5.3。正常重启后，AC／AC2 的引用均按真实关系显示；再次引用带附件用户消息只显示文件名和用户正文，取消后输入为空。最近工作实屏同时显示 quoted-input.csv 与实际交办内容，无引用协议、XML、路径或文件正文，空行不再占据摘要。仍需原生窗口缩放刷新这次冷启动的显示状态，不能将入口修正说成已解决绘制问题。47 文件／348 项 Bots、IPC、前端回归、原 messages 与 desktop-agent-baseline 通过，node／web 类型检查、定向 lint、干净构建及 diff 检查通过。实际引用恢复／摘要证据补充至 `quality-review/1016AC-private-reply/final-restart.json`，没有新增模型任务。

    - 1016AE 干净构建重新启动后：聊天中的附件引用关系从原历史恢复，不再显示引用协议块；再次引用该用户消息也只包含附件名和用户正文。最近工作已去除 XML／路径／文件正文，但两行摘要被附件后的空行占据，继续将本类摘要的空白折为单空格，保留原始聊天正文不变。此最终样式实屏确认后再划掉。

    - 117 项针对性测试、346 项 Bots／IPC／前端回归、原 desktop-agent-baseline、messages、node／web 类型检查及构建均通过。最终原应用的工作台点击无响应，官方 Grok 同时可点击；仅能确认原生菜单和 Cmd+F 仍生效，尚未定位焦点／原生事件／页面命中原因，因此本项实屏不勾选，继续按 1016AE 定位。
  - [ ] 1016AE 原预览窗口点击定位。点击既有工作台 Bots、侧栏开关均无效，重新绑定、原生缩放／菜单重载／系统窗口激活仍未恢复；官方 Grok 详情关闭／重开正常且原草稿保留。先临时记录不含正文的原生网页输入事件、焦点和命中样式，核对点击是否到达页面；不得直接认定是 renderer 卡死、电脑锁屏或 Bot 接线，也不改公共交互策略兜底。诊断代码必须撤除后再交付。
    - 临时事件证据确认受信任的 pointerdown／pointerup／click 均到达目标 BUTTON，命中同一按钮，body／target pointer-events=auto、app-region=none、焦点为 true；Tab 同样到达。随后原生 zoom 立即显示已经切换的 Bots 页面。说明此样本不能归因于按钮未接线、输入被阻止或 JS 卡死；冷启动绘制／AX 刷新的根因仍未确认，不新增窗口缩放或禁用后台节流的生产兜底。诊断代码已完全撤除，App.tsx 与本轮前一致；证据 `quality-review/1016AE-window-input/`。最终干净构建与附件引用恢复继续核验。



  - [x] ~~连续切换 Bot 时清除旧头像与资料编辑状态，关闭头像弹层后焦点返回触发按钮。~~ 2026-10-14 连续切换实屏发现详情区残留三个不同 Bot 的头像：`BotAvatarEditor` 与 `BotProfileLabel` 作为兄弟节点使用相同 `selected.id` key。改为在整个 profile 容器绑定唯一身份 key，切换 Bot 时一起重建该身份的本地编辑状态，避免 React 重用／遗留旧节点。web 类型检查和构建通过；新版实屏 AI → 外观核验 A → AK 连续切换仅保留一个头像；AK 头像编辑器正确显示云朵／红色，Escape 关闭后焦点返回头像按钮。218px 侧栏的两个置顶 Bot 同排显示。此项不代表整体动画验收完成。
  - [x] ~~同轮工具已交付的文件在最终回复中保留为链接，避免重复成果卡片。~~（1014AO2）实测发现同一文件同时被交付工具和 Markdown 链接渲染为两张卡；复用原消息／工具回执关联，限定同轮、成功回执与精确路径，不按文件名跨目录去重，不隐藏其他轮次成果。新版实屏每个原文件仅一张卡，最终回复中的 ao-result.txt 链接仍能打开 AO_FINISHED。6 项投影／边界测试、messages、web 类型检查与构建通过；未改消息原文或实际文件。
  - [x] ~~聊天中改名成功后显示居中的简短事件，展开执行详情仍能检查原回执。~~（1014AK／AL）官方 Grok 0.70.2 实屏改名显示“已重命名为 合成对照-1014AL”；CMB 从真实 bot_update_profile 成功回执投影相同类型提示，使用实际返回名称，失败或缺失回执保留原工具卡，不凭模型请求伪造成功。Mac 重启后历史中显示“已重命名为 核算助手-1014AK”，执行详情开／关均核对。纯解析测试、messages 回归、web 类型检查及构建通过。本项仅覆盖聊天工具触发的变更，不代表全部资料事件已对齐。
  - [x] ~~群消息作者头像／名称可直接进入对应 Bot 私聊。~~（1014M）对照 Grok 合成群作者入口，复用既有会话选择与私聊详情状态，保留群草稿；删除中的 Bot 不提供跳转，标题按钮补充展开状态。Mac 从群报告消息点击“收件人核验-1013AP”，实际进入正确私聊并处理该 Bot 独立任务审批。web 类型检查及构建通过；仅标记此交互完成，气泡布局仍需继续对照。
  - [x] ~~群消息按相邻作者聚合，复用私聊日期分段，组末显示作者头像；列表、标题和详情共用群头像。~~（1014P）对照 Grok 0.70.2 实屏与重构源码 `transcript-adjacency.ts` 的作者边界规则，沿用原群消息 ID、顺序与 Virtuoso 分页，不复制其消息协议。时间在悬停／聚焦时显示，用户与 Bot 气泡使用既有独立色值；输入框复用原 composer 的自动增高方式，取消拖拽尺寸把手。Mac 实屏核对日期分隔、组末头像、群详情头像、三行输入；群成果卡片仍可打开原 3 行／50.75 报告，点击作者头像进入正确私聊，再返回完整保留多行草稿。18 项群展示／草稿／错误提示回归、原消息回归、web 类型检查与构建通过。只完成这些展示细节，完整窄窗口、明暗主题和动画逐帧对照尚未完成。
  - [x] ~~简洁视图保留非零退出的命令，并显示“工具失败”。~~（1014L2）复用原 hooks 的 DeepAgents 命令结果识别，将纯解析函数提取到 shared，原 hooks 语义不变；限定 Bot 的 execute 记录，普通 read_file 引用相同文本不被误判。7 项状态／投影测试、原 hooks 112＋42 项断言、原消息回归、node／web 类型检查及构建通过；新版实屏确认此前 cp 的 exit 1 保留为失败，随后成功复制与报告交付仍可见。
  - [x] ~~Bot 聊天默认收起已成功的普通工具记录与推理，保留审批、错误、交付和协作入口；可切换完整执行过程，搜索仍能定位原记录。~~（1014I）对照 Grok 合成会话的进度／成果时间线，复用原消息关联、Mod 卡片、虚拟列表和搜索，不删除消息或修改 Runtime。真实 MiniMax 任务 `03917b3f-cda1-4c79-9d63-18895d5495f3` 单次审批后写入、读回并交付 `交付摘要 1014I.md`，预览为“核验金额：50.75”；完成后普通读写记录收起，搜索“读取文件: 交付摘要”可定位，关闭搜索恢复简洁视图。保护整个活动轮次，避免尚未结束的工具结果被提前隐藏；未知工具、工作流、人工接管及交互卡片保持可见。4 项投影测试、原消息回归、线程性能契约及 web 类型检查／构建通过；整体气泡布局和动画仍未完成。
  - [x] ~~资料库按日期分组显示文件卡片、修改时间，复用聊天成果预览及下载，关闭后恢复文件按钮焦点。~~ 对照 Grok 0.70.2 实屏资料库与预览：保留原有有界扫描及分页，按文件真实 `modified_at` 分组，不把修改时间冒充交付时间，也未增加附件数据库或轮询。私聊与群资料均通过统一预览验证；群预览 Escape 后焦点实际回到原文件按钮。日期跨午夜、分页数据不修改及缺失日期回退测试、web 类型检查、构建通过。这里只覆盖当前扫描页；全量成果索引与媒体缩略图未实现，不宣称完整一比一。
  - [x] ~~后台工作流继续执行或等待子任务审批时，Bot 列表与详情保持正确活动状态。~~（1014E2）复用原线程轻量摘要；父任务 `f55bc5b9-e319-4045-977f-01947258f0ce` completed 后，实际 leaf 仍运行，列表／详情显示“正在处理”；leaf 请求文件修改审批后显示“等待你确认”，单次批准后恢复“正在处理”。不订阅逐 token 全量消息，不另建运行状态；私聊状态 9 项定向测试、原线程性能契约、web 类型检查／构建通过。群列表使用同一成员线程摘要，群后台的完整实屏验收另做。
  - [x] ~~新聊天收件人支持搜索、上下键选择、Enter 打开与按输入名称直接创建 Bot。~~ 对照官方 0.70.2：“浏览器”筛选显示已有测试 Bot 和同名创建选项；本地 1013AP 实屏验证中文搜索“协作核验”、上下键切换、Enter 打开既有会话，再输入“收件人核验-1013AP”并 Enter 创建正确名称的 Bot。收件人列表打开时点击附件按钮可直接打开原生选择框，不再需要先按 Escape。复用原 Radix Popover，组合输入期间不处理 Enter；实际中文输入法组合态仍待验证。
  - [x] ~~新聊天先添加附件，再选择已有 Bot、创建新 Bot 或创建群聊，文字及附件进入对应输入框；切换会话保留附件草稿。~~ Mac 实屏 1013AM／AN／AO 均通过真实 MiniMax，分别覆盖已有 Bot、新群双成员和全新 Bot 首次任务，结果均为 3 条／50.75；文件保留副本与源 CSV 字节一致。原生文件选择、收件人衔接和草稿切换已验证；拖拽、中文输入法组合态、失败界面与 Windows 仍待验证。
  - [x] ~~成果卡片：独立段落中的工作区文件链接可直接预览和保存到本机；正文引用保留行内表现。~~ 1013AH/AH2：真实 MiniMax 创建并读回 Markdown／JSON；Mac 卡片打开显示正确内容，卡片保存进入原生对话框，导出与源文件字节一致。首轮 JSON 链接漏了绝对路径的 `/`，无效链接保持不可预览，反馈后模型修正并成功打开；此处不计为首轮交付全通过。复用原 Markdown 路径解析、FileViewer 和经主进程校验的 exportFile，渲染不读取文件或扫描目录。群组沿用同一所属范围；群实屏与 Windows 保存仍待验收。
  - [x] ~~增加 Bots 内“连接应用”入口，直接复用原 MCP 连接器设置覆盖层，关闭后仍在当前 Bot。~~ 2026-10-13 Mac 隔离实屏点击进入 MCP 连接器页，再点“返回应用”回到原 Bot 会话；本轮没有添加或变更连接器权限，服务调用另由 P03.5 验收。
  - [x] ~~列表右键置顶／改名／归档／恢复，操作绑定所点 Bot，不误切换当前会话。~~ 已完成隔离实屏验证。
  - [x] ~~标签直接编辑、保存／取消及重启保留；置顶偏好重启保留。~~ 已完成隔离实屏与迁移测试。
  - [x] ~~手动标记未读，切换会话后保留，再进入确认已读；旧确认不能吞掉新的未读标记。~~ 已完成隔离实屏及 Host／IPC 回归。
  - [x] ~~Bot 仅隐藏／显示，保留运行能力；就地新建列表分组、改名及折叠。~~ 已对照 Grok 实屏，隔离应用验证；自定义分组仅是宿主内的列表偏好。
  - [ ] 群列表管理、分组移除及完整管理流程的其余对照；群移入分组、取消改名与重启后偏好已实屏验证。
    - [x] ~~群移出列表分组；群详情直接查看、添加／移除成员及打开对应私聊。~~（1014K）对照 Grok 0.70.2 合成群的右键菜单与“详情／资料库／成员”面板，补齐群标题详情入口、独立保存群详情标签及成员操作；保留一期群浏览器入口。新界面复用现有 `saveGroup` 和版本冲突校验，不另建成员权限或执行逻辑。Mac 实屏完成新建分组、群移出、成员移除／重新加入、打开对应私聊；原群消息与成果保留。Host／群草稿 42 项测试、原消息回归、web 类型检查及构建通过；完整管理与动画对照继续进行。
  - [x] ~~单次协作交流可从发送、收到及群内入口打开，显示完整交办／真实回执，返回保留草稿和焦点。~~ 已完成真实 MiniMax 与实屏验证。
    - 按名称交办后的发送提示改用主进程回执中的实际接收 Bot 身份，不再仅用模型参数查询 ID；优先显示当前名称，已移除的接收者回退到回执名称。兼容旧回执，明确失败不生成交流入口；3 项定向契约及原消息回归通过。本次名称显示修正尚未单独做实屏验收。
  - [ ] 同一对 Bot 的永久历史与最终气泡／标题视觉对照；现有保留记录的双向分页时间线已接入并完成两次真实协作记录实屏检查。
    - [x] ~~1016AT 连续交流及正文布局复核。~~官方原合成记录实屏显示同一对 Bot 跨日期的连续只读交流、双身份标题和关闭聊天入口；当前 Store 已有 archive 引用及原 transcript 取回，清理不简单删除交流正文。交流页已复用 Bot 正文 14px／22px、560px 气泡上限、代码／表格规则与虚拟行 margin 隔离，不新增会话存储、Runtime 或轮询。原预览冷启动后实屏确认同一对 Bot 的三次交办及实际回复、双身份标题和末条 36.55 完整显示；Escape 关闭后原合成草稿逐字保留，焦点回到触发入口，随后仅清空本次草稿。私聊／群仍按原范围隔离。历史清理／交流投影 10 项测试、原 messages、web 类型检查、构建和 diff 检查通过。275 条任务／0 活跃，Bot／群／计划配置、两份记忆与该对交流记录哈希均未变，控制库 quick_check=ok；证据 `quality-review/1016AT-exchange-layout/{before,after}.json`。本样本不覆盖超过 30 次的真实翻页或字面上的永久保留，不据此勾选本段父项、全部动画或 Windows。
- [x] ~~1016V Bot 浮层的入场／退出规则。~~官方 0.71.2 PreviewCard／$0.popup 为 100ms、cubic-bezier(.16,1,.3,1)，从锚点方向 2px／scale(.98) 入场，关闭回到相同姿态；侧栏卡延迟 250ms、宽 260px、padding 10px、身份间距 4px、正文 18px。原实现沿用通用浮层 95% 缩放与 8px 位移，提示卡为不定宽且间距不同。继续复用 Radix，给 Bot 自有浮层加展示标识并覆盖对应 CSS，不修改共享组件、焦点／按键／保存逻辑或新增计时器；减少动态效果关闭这些动画。源码规则保留于 `quality-review/1016R-details-source/official-popup-motion.css`。
  - 原应用已实际打开头像、收件人、设置、右键菜单及键盘焦点提示；Escape 关闭并返回原头像／会话焦点，头像原六边形／蓝色与设置保持不变，提示卡正确显示 AP 身份与实际末条回复 41，没有创建新 Bot 或任务。web 类型检查、构建及四个浮层组件 lint 通过（`/tmp/cmb-1016V-{web,build,lint}.log`）。构建替换旧 renderer 的惰性资源后曾出现 CSS 预载失败，重载最新资源后恢复，此现场属于本次预览升级过程，不能据此宣称生产冷启动已修复。电脑工具没有独立 pointer-move／录屏接口，静态布局和开合通过不等于完整动态观感一致；P09.3／P09.5 继续保留未完成。

- [ ] P09.3 移植适配动画基础，对齐头像状态、悬停按压、消息出现、面板过渡及加载反馈。
  - [x] ~~1018BU 补齐遗漏的 Bot 自有浮层展示接线。~~对照官方实屏及既有 Grok popup CSS，七个 Bot 组件的更多／文件／分组菜单、模型／成员／例行／浏览器 Select、群消息提示复用已有 data-bot-popup 与中性表面样式（100ms、2px、scale(.98)）。仅展示属性变化，AST 规范化核对七文件均保持原操作／状态／正文；共享 Radix、bots.css、Runtime源码及已核对的out/main/index.js引导产物与本轮前一致（未单独记录application.js完整运行块的前哈希），无新时钟／监听器。
    - Mac 实屏检查深浅色菜单、文件操作、模型 Down／Escape、未保存例行与成员选择；取消／关闭恢复原焦点，未保存配置。真实 MiniMax 3a1a3ce7…、DeepSeek 680f3f92…各恰好 read_file＋bot_deliver_files，四字段正确；281B／284B 原件均实际打开。旧747任务、36Bot、10群、9例行、26命令、240文件及4469旧核心消息头保持，最终749任务／4481消息头、0活跃，quick_check=ok；mask39字草稿、80px侧栏、深色与收起详情恢复。web／原messages／构建通过，既有lint一错误五警告与HEAD完全相同；52项证据检查通过。未挂载的浏览器Select、完整悬停录屏、OS减少动态效果、Windows及整体动画仍未验收，不关闭P09父项。证据 quality-review/1018BU-floating-surfaces/{references,change-scope,built-source,ui-review,model-routes,models-first,final,review}.json 与 review.py、实屏截图；未commit／push。
  - [x] ~~1017BM 头像选择器沿角色轮廓显示选中与键盘焦点。~~官方0.71.2实屏与Gv／Vxe／$7e使用36px角色、3px间距和1px轮廓环；原实现为圆角方框。按原QN／Qh／cP纯几何生成13份静态SVG，只发静态资源，不新增几何引擎、运行时缓存、逐帧绘制、监听器或计时器；48px按钮及自适应列间距保留5＋5＋3排列。13份资源共81292B（单文件gzip合计19612B），XML与源hash逐份核对；来源说明随原构建notice保留。现有形状、配色、保存与Runtime不改。
    - Mac原生实屏确认蓝色水滴／红色方形选中轮廓和键盘Tab团块焦点；首轮发现旧粉色矩形焦点仍在，随后仅让形状按钮使用可见轮廓焦点，颜色按钮保留原提示，正常退出所有旧进程、重建重启后复验通过。已有3文件10项头像／时钟回归、web类型、局部lint、格式及最终正常构建通过。初轮DeepSeek41840bd9…／MiniMax2dd313ed…，最终构建DeepSeek7b865768…／MiniMax033841f8…，均恰好一次真实read_file并准确回答原JSON的marker／pid／answer，无工具错误或其他调用。
    - 原691任务、36Bot、10群、9例行、24命令、239份工作区／记忆文件和4195旧消息头逐项保持，最终695任务／4211消息头、0活动／0已接受命令、quick_check=ok；原mask39字符草稿、80px头像栏、会话与窗口恢复。一次详情点击误入空回复已取消，未发送或保留；启动BV仍需原生Zoom，没有新增生产兜底。完整指针悬停录屏、浅色与Windows不由本项证明，P09主项继续待验。证据quality-review/1017BM-avatar-selection/{source-review,asset-review,built-source,models,final,review}.json及extract-rings.cjs／review.py，日志/tmp/cmb-1017BM-*；未commit／push。
  - [x] ~~1016AF 详情面板的开合动画。官方 0.71.2 `nB`／`xo` 将内层从右侧 100% 平移到原位，300ms、cubic-bezier(.2,0,0,1)；关闭期间禁用交互，300ms 后隐藏内容并暂停面板副作用。修改前仅有 180ms／12px 淡入且关闭立即消失。先复用原受控详情偏好、已有 Radix Presence 及 CSS transform 过渡，补齐打开／关闭／快速反向／减少动态效果，避免新建时钟、面板状态库或复制官方 React 依赖。私聊与群共用外壳，关闭后返回既有标题入口焦点，保持内部原组件及资源释放。来源 `quality-review/1016R-details-source/official-detail-shell.js`、official-detail-motion-styles.js、official-detail-motion.css；真实交互及布局复验后再划掉。~~
    - 原预览实际记录 transform 从 360px→0、0→360px，transition 为 0.3s／官方缓动；关闭立即 width=0／inert，animationend 后卸载，私聊与群聊标题均实际获得焦点。连续开→关→开保留内容、从当前位移反向，未卸载重播；原生 View 缩放触发 ≤900px CSS 分支，300px 覆盖面板可正常关闭，随后恢复 Actual Size。临时启动参数验证 prefers-reduced-motion=true 时 duration=0s、关闭立即移除，不改系统设置。只复用已有 Radix Presence，保留原详情偏好和各身份组件 key；同类 Bot 切换不重建面板外壳。官方采用 React Activity 隐藏／暂停，本地沿用原卸载方式在动画后释放，不复制其面板状态。只读诊断已撤除，干净构建和 web 类型检查通过，新组件 lint 通过；工作区已有 setReady(false) lint error 和五个 warning 保留，本次未改该链路。证据 `quality-review/1016AF-detail-motion/{all-events.log,evidence.json,after-store.json}`。21 个 Bot／7 个群配置哈希、260 条任务均未变化；未发模型任务。本项不代表全部动画、真实窄物理窗口或 Windows 已验收。


  - [x] ~~1016J 角色几何与状态片段来源复核。~~ 用 eslint-scope 按真实词法引用提取官方 0.71.2 的纯内核依赖闭包，确认自由依赖仅为数值／集合内建对象；没有运行官方应用、React、网络或存储代码。固定 seed、配色、注视与推进时间，对 13 种实际形状 × 13 种状态生成 SVG，当前复用内核与官方 169／169 完全一致。renderFrame、updateSvg、paint、状态导演的归一化 AST 亦匹配；生产代码保留现有复用实现，没有为审计再引入一份内核。证据 `quality-review/1016J-geometry-source/evidence.json`。这验证固定输入下的几何与动作结果，不替代页面状态接线、悬停录屏或所有时刻视觉一致性。
  - [x] ~~1016K 悬停注视坐标与官方源码对齐。~~ 官方当前 `attachMarkHoverGaze`（cJ）显式使用 `aJ=.5`，不是底层全局跟随默认的半径系数 2；当前适配层误用了后者，未饱和范围的注视幅度约小 4 倍。仅修正原归一化系数；中心、四分之一位置、边缘／屏外限幅与零宽度回归通过，原回正、全部形状／状态及共享时钟共 10 项测试、web 类型检查、构建通过。原应用重载后头像与原详情可正常显示／操作，未增加监听器或循环。固定输入及源码规则已核对，但电脑工具没有独立 pointer-move／视频接口，不据静态界面宣称完整动态观感验收。
  - [ ] 1016L 侧栏收放过渡。官方 0.71.2 CSS 的 sidebar animating 使用 200ms、`cubic-bezier(.22,1,.36,1)`；当前宽度直接跳变。沿用原面板偏好、CSS 宽度变量和 pointer capture，只为非拖动的侧栏宽度变化增加对应过渡；拖动期间禁用，开始拖动时从当前实际宽度接手，取消／丢失捕获／卸载清理标记和已有帧回调。保持减少动态效果与系统按钮安全区，不新增动画时钟或计时器。新版键盘收放、快速打断和拖动复核后再划掉。
    - 2026-10-16当前干净构建再次实际拖动：原生Window菜单激活后，80px侧栏视觉可拖到218px，但AX仍80；再次单击原分隔线才提交为218。Home已恢复原80px、原群与空草稿保持。仍无法把电脑工具缺失松开回执与产品行为区分，未据此加全局监听或宣布L完成；同类无新增证据的拖动不反复重试。
    - 1016AS 后续拖动复核：原应用视觉宽度随原生拖动改变，但 AX 数值要再次点击分隔线才提交（80→220，随后恢复原278）。先临时记录分隔线 pointerdown／pointerup／pointercancel／lostpointercapture 及无按键 move，区分组件遗漏与电脑工具事件缺失；日志不含正文，诊断代码必须移除后重新构建，不先添加 document 监听器或延时兜底。
      - 诊断构建启动后出现 AX 已进 Bots、截图仍停工作台的既有现场，原生拖动还返回 noWindowsAvailable；本轮没有取得分隔线事件样本，不足以判断缺失的松开由谁造成。临时日志已按备份完全撤除，分隔线文件恢复诊断前内容；不据此加入新的全局监听或声明拖动验收通过。L 子项继续未完成。
    - 已实现，原应用 Right 展开 218、Home 收到 80、连续 Home／Right／Home 均保持当前会话、系统按钮安全区与空草稿。原生拖动未取得可靠回执，不能记为拖动通过。组件 ESLint、web 类型检查、构建通过；补充的拖动生命周期只复用已有帧回调，没有新计时器。
  - [x] ~~1016M 普通消息入场。~~官方当前 `index-wlkGG389.js` 使用独立的 entering／retire 标记，并按初始快照、追加和已提交行区分；CSS 新行上移 12px／240ms，正文淡入 120ms，缓动 `cubic-bezier(.23,1,.32,1)`。本地普通私聊／群消息仍直接出现。仅在 Bot 展示层沿用原消息 ID／虚拟列表增加短暂入场资格：初始历史、前插分页、换群／线程、非跟随视口不播放；同一行提交后退休，流式追加和虚拟卸载再挂载不重播。只保存当前消息窗口的 ID 与资格，不复制正文、不持久化动画、不新建轮询或时钟；原工作台不启用。复用同一资格推导及 CSS 供私聊／群聊，保留减少动态效果。先验证身份／分页／重挂载边界，再实际发送短消息及重载复核。
  - [x] ~~1016G 注视动作按时间推进。~~ 只读 AST 对照确认当前内核与官方 0.71.2 的状态导演相同；官方 motion 已将固定逐帧 0.14 插值改为 `1-(1-0.14)^(dt/(1/60))`。原实现 30／60／120 帧在相同 0.1 秒时，水平偏移分别约 0.01783／0.02918／0.04098，存在实际帧率相关差异。采用官方按裁剪后的 dt 插值后，三种帧率的偏移与旋转一致，零时间步不再推进注视；没有提高帧率或改形状、动作数据、状态映射与共享时钟。原有移出回正、终态动作归零和全部 13 种形状的有限值测试保留通过，共 15 项相关测试、web 类型检查及构建通过。源码更新和原快照 hash 的含义已注明 vendor README；证据 `quality-review/1016G-avatar-source/evidence.json`。该项仅验证时间计算与来源，不替代完整悬停录屏或全部动画对齐。
  - [x] ~~简洁聊天用 Bot 头像与实际活动提示替换通用工作台转圈文案。~~（1014AM／AN）官方 Grok 实屏确认头像配合活动文案；CMB 复用原线程状态选择器、Hermes 动画时钟与审批状态，不增加轮询，不显示虚构进度。真实 MiniMax 单次 Node 30 秒任务依次显示等待确认、正在处理，AN_DONE 后提示与停止按钮消失；原消息／审批／错误记录保留，执行详情视图沿用原展示。6 项头像状态／动画生命周期／资料事件测试、messages、web 类型检查与构建通过。官方新版的笔形变换等动作细节尚未复刻，不据此勾选完整动画对齐。
  - [x] ~~新建 Bot 自动分配现有形状和配色并持久保存，避免所有新 Bot 默认红色水滴。~~ 2026-10-14 参考 Grok 的身份默认外观及 Hermes 的默认形状机制，复用已有外观组件与保存接口；本实现创建时分配一次并保存，不随改名或渲染重新随机。实屏创建“外观核验-1014A”得到青色药片，列表、标题、详情一致；原有 Bot 外观保持不变。类型检查及构建通过。
  - 1016M 验证：按官方 entering／retire 方式复用原消息 ID 与虚拟列表，空推理／工具 shell 等到可见正文才消费资格；只保留当前窗口 ID，无新时钟／轮询。15 项身份／分页／推理 shell／群展示测试、原 messages 回归、web 类型检查、定向 lint 和构建通过。原应用真实私聊任务 `e0ff1484-41ea-46db-963d-3c4abaf14106`、双模型群任务 `0bf41020-7f1a-4e5c-b4dc-4394043f6f98`／`68c210d3-7ddc-4d85-a395-eb4e8fbf587a` 均 completed；DeepSeek 私聊与 DeepSeek／MiniMax 群回复正确，重载后两条群回复和空草稿保留，控制库仍为 236 条任务、无重复派发。证据 `quality-review/1016M-message-motion-source/tasks.json`。静态截图不能证明全部运动曲线和流畅度，本项仅完成普通消息入场实现及边界验证，不代替 P09.3／P09.5。群聊发送后曾需要补一次滚动才完整看到末条回复，原样保留，继续核对跟随视口，不将此记为完整滚动验收。
  - [x] ~~1016N 初始加载状态。~~原应用重载进入 Bots 时，快照尚未返回，主区域短暂显示“把工作交给 Bot／创建 Bot”，容易误以为原 Bot 丢失。沿用现有 useBots 的空快照／错误状态与 Loader2，先显示加载，失败明确提示并复用原快照请求重试；不创建替代空数据，不重置当前选择、草稿或 Runtime。验证后再划掉。

  - 1016N 已增加明确加载与失败重试展示，重试直接复用原串行／合并刷新函数，不重建订阅或并发发起快照。web 类型检查、定向 lint 与构建通过；原应用重载及正常进程重启后，原 21 个 Bot／7 个群均恢复，没有重复任务或误创建。当前读取很快，电脑工具没有捕获到短暂加载帧；失败重试界面未做真实故障注入，不将此子项实现通过扩展为完整错误／冷启动绘制验收。

- [x] ~~1016S 群聊完成时的视口跟随。~~1016M 曾出现末条回复需额外滚动，继续用原群、真实 DeepSeek／MiniMax 的多行普通回复检查发送后定位、回复追加、活动条消失与输入区尺寸变化；核对现有 Virtuoso 的 followOutput 和滚动 API 再决定是否改代码。用户上翻时不能抢回底部，回到最新后应恢复跟随；不引入轮询或第二套滚动器。
  - 1016S 首轮真实复现：两成员完成回复后视口仍停在用户请求，最新回复位于屏外并出现“回到最新”按钮。当前发送后 React effect 在新数据进入 Virtuoso 测量前直接滚动且清除意图。改为既有 scrollIntoViewOnChange，由原列表在新行测量后消费一次发送意图；保留原 followOutput 对后续回复及用户上翻的规则。修正后用全新同类样本复验，不将首次失败覆盖。
  - 1016S2 真实复验两模型任务 `6aa694e9-0fbc-46a7-a35d-ce74d671152d`／`2bffe4dc-f762-496d-88ff-4dd0038c2f3d` 均 completed；两份八行回复末行 S2_END 自动进入视口，未再手动滚动，最新按钮消失。1016S3 发送后在两成员运行中原生上翻两页，完成后仍保留旧编程交付位置；点击最新后两份 S3_END 回复可见。30 项群历史／提及／草稿／入场测试、原 messages 回归及 web 类型检查通过，构建通过；没有引入定时器或改原私聊滚动器。证据 `quality-review/1016S-group-follow/`。本项仅覆盖该发送与上翻路径，跨分页引用／所有缩放和动画仍保留其原验收范围。

- [ ] P09.4 验证滚动锚点、草稿、快捷键、焦点、长文本、空／错／等待状态及窄窗口布局。
  - [ ] 1019DQ Mac原生中文输入法组合态。先检查当前已启用输入来源能否通过原生键盘形成真实拼音候选；不以粘贴中文或合成DOM事件代替IME。仅在既有合成会话／群的空输入中核对组合态Enter不误发送、中文成员筛选及提交前后真实收件人；原用户草稿不动。若当前环境没有可用IME或电脑工具不能驱动，保留准确阻断，不改系统配置或产品逻辑伪造通过。发现产品缺陷时先对照原CMB编辑器及Grok／Hermes输入处理，再做最小修复。
    - 当前实屏未形成可验证的原生组合态：两次原生Control-Space后分别按n／i，均只见普通ni；SystemUIServer读取超时，当前应用清单未暴露输入法窗口。不足以证明Mac未配置中文输入或产品有缺陷，未按普通英文Enter冒充组合态验收。两次切换尝试及原生截图／AX保留，未改系统设置；仅清除本轮自有ni草稿，未发送消息。1176任务、48Bot、11群、15例行、54命令、299文件和6163消息头逐项不变。证据quality-review/1019DQ-native-ime/{review,preservation}.json。本项与真实Windows继续未完成，不因自动回归或中文粘贴通过而划掉。
  - [x] ~~1018CR 待答卡片的字母键、自由回答及空白输入（Mac定向）。~~先用当前官方新的合成Bot核实单选／自定义入口分支，不能把源码的多选与非elevated分支当成当前单选界面。现有Bot字母键仍为无框22px、选项说明12px；自填完整性按原text.length计算，纯空白可能被提交。实屏／原状态辅助函数确认后，仅在Bot展示复用官方尺寸和原草稿、提交、导航；必要时为既有userInputAnswers增加默认不启用的Bot规范化选项，普通工作台保留原行为。单题、自填、补充与多题一致性、输入法组合态及取消必须维持，不能通过新状态机、计时器或输入协议重写来实现。双模型及原回答辅助函数正反例验证后更新。
    - 预复核已证实：官方新合成Bot的单题只列甲／乙选项，主输入框提示输入你的回答、或聊点别的；从主输入框发送自填-1018CR-青桐，旧卡ignored并产生正常用户消息。不要虚构C选项或把多选源码分支当成当前界面。本地旧实现双模型各实际将3个空格以submitted／other.text写入回执并复述，确认为UI完整性问题，非模型错误。计划仅让可steer的直接用户／欢迎轮次、唯一主级单题复用主输入框；群执行只读、例行／同事／通知、子Agent或来源未明时保留原直接回答入口，多题仍逐题填写。沿用managedTurn的派生能力提示，不赋权；原Host／租约继续最终校验。原userInputAnswers为Bot可选trim，自身默认维持普通工作台原语义，保护原草稿、不新建回答状态。
    - 首次更新：修正进入正常构建，复用原回答草稿／导航／提交回调，单题复用主输入框仅依据上述保守条件；已有自填草稿不因能力提示改变而丢失。原选项字母键统一为24px／8px圆角，说明复用14px／22px。43项定向回归、210项相关回归、原messages／desktop-agent-baseline、node／web、格式及构建通过；小文件lint干净，原对话框2项错误、工作区1项错误4项警告及ChatContainer18项警告与HEAD逐项相同，未夹带清理旧代码。原Runtime、提问服务及适配器哈希不变。原生Quit确认4个所属进程消失后更新，mask39字草稿重启保留；控件树与截图不一致且原生输入返回noWindowsAvailable，尚未产生修正后真实任务，不以代码回归代替双模型实测，CR保持未完成。证据quality-review/1018CR-question-input/{code-review,lint-baseline-check,cr-quit-check,before-build}.json及测试日志。
    - 恢复原生输入后的正式双模型续验通过。MM 1ed80b05…／8da414f0…、DS dacfa7d4…／f5009707…各只有一次原提问；主输入框3空格加Enter未新增任务或回执，合法自填使旧卡产生真实ignored／空answers，再作为正常用户消息续办。两份完整原文均在真实消息中保留；MM将标记复述成青桐，DS和官方复述完整标记，不将有限样本称为全部任务质量一致。多题MM 0f4d09d0…／DS 73d833e6…各一次原提问，两者第一题3空格时第二题补充仍不能提交，继续按钮正确返回第一题；补齐后真实submitted含自填青桐批次、选项摘要及补充保留来源说明，原草稿中的边缘空格仅在Bot提交时规范化。正常字号截图、完整回执及61项证据审计通过，原887／889任务和5078旧消息头保持，最终895任务／0活跃、原38Bot／10群／11例行／29命令／267文件均不变。mask39字草稿原样保留并恢复BW-DS，官方恢复tibo监控助手。用户指出字体变大后已通过原生Actual Size恢复，未修改全局字体；原生缩放测试未及时恢复是验收操作失误，保留记录，后续不再把放大状态留在用户窗口。证据同目录{task-windows,final,draft-guard,review}.json、verify.py及双模型实屏。
    - [ ] CR剩余范围保留：真实原生IME、群／后台／子Agent直接自填入口的当前版本实屏，以及浅色和Windows。当前纯投影与SSR已覆盖单题能力未知默认保留直接输入、多题与既有自填草稿保留、空白提交禁用、主／子／重复调用身份；未用这些自动回归代替上述实屏。P09.4及整体UI／动画父项继续未完成。
      - [x] ~~1018CS 群成员执行记录的单题自填入口续验（Mac）。~~沿用既有隔离资料核验群及原AP／外观Bot的MiniMax、DeepSeek配置，分别只@一个成员发起单题；成员执行页主输入框只读时仍须保留原直接自填入口，3空白不能提交，有效回答应由原提问服务写入真实回执并回到原群。复用原群、请求及提交接口，不新增状态／任务协议；保留原群草稿、配置及其他成员，不发送到受保护的身份群。仅增加必要真实验收与证据，发现差异再修复，不调整全局字号或窗口缩放。
        - 原资料核验群发现15字未发送草稿，未清空或发送；通过正式新建群界面建立提问入口核验-1018CS，仅选原AP（MiniMax）和外观（DeepSeek）Bot。两个稳定ID提及分别只派发一个group任务，a2176e57…／8fa72ff1…各只调用一次原提问工具。成员执行页主输入框禁用，自定义回答仍保留；各3空格加Enter不产生ToolMessage／提交，合法自填经原服务submitted、边缘空格规范化，原群消息中各仅回传一条准确答案。最初群列表刚载入时结果尚未同时出现在AX，重新等待实际加载后两结果均已可见，未据首帧改生产代码。
        - 32项证据检查通过，原895任务、38Bot、10旧群、11例行、29命令、267旧文件及5104旧消息头保持；最终897任务、11群、268文件、0活跃。只增加该测试群、2条completed任务和该群原Runtime的.cmbdevclaw/setup-state.json；首次审计将原元数据文件名误写为setup.json而失败，按实际原路径校正，旧失败保留。原15字群草稿逐字相同并恢复BW-DS，无新增生产代码、无缩放／字号变更。证据quality-review/1018CS-group-question-input/{before,task-windows,group-messages,final,draft-guard,review}.json、verify.py及正式界面实屏。后台／子Agent、IME、浅色和Windows仍按上项未完成。


  - [x] ~~1018CQ 已忽略问题保留选项的展示对齐。~~当前官方0.71.2实屏及新提取widget的$t／tt分支确认：忽略后保留置灰问题与A／B选项，不能用1016AW的单行记录称为完整对齐。沿用原ToolCall／真实ignored回执和BotQuestionHistory，补回只读选项及说明；保留已忽略的可访问状态，缺失／无效旧选项仍用原紧凑展示，回答／取消内容及提交路径保持。原自由输入项过滤函数原样提取到shared，函数体逐字相同，主工具只改导入和调用；不显示当时已被原Runtime移除的选项、不恢复交互、不猜答案，不新增存储、监听、时钟或提问协议。按官方24px／8px圆角字母键、4px间距、内边距与600标题字重对齐此卡片；说明正文复用14px／22px，仍不等于全部输入卡或动画完成。先1失败／19通过，修正后20项原工具＋投影、84项相邻回归、完整原messages／workflow、node／web、lint、格式及正常构建通过。两次原生退出均确认4个所属进程全部消失后更新，未改启动绘制。真实MM 8c86ce6c…／3df70e2b…、DS f923b17c…／617b0f61…均自动ignored且空answers，43正确；最终排版构建下MM cf709a2a…／DS 934d469a…实际点甲版，submitted并准确回复选择=甲版。旧选项点击无新提交；原生Reload后两模型已忽略选项与已回答历史仍可见，存储逐项不变。46项审计通过，881→887任务，原38Bot／10群／11例行／29命令／267文件与旧消息保持，零活跃；mask39字草稿保留并恢复BW-DS。证据quality-review/1018CQ-question-history-layout/{source-before,official-option-primitives,official-question-typography,task-windows,reload-storage-check,final,review}.json及实屏／红绿日志；本项为Mac深色卡片与原规范复用，完整明暗UI、动画、IME及Windows继续按父项待验。
  - [x] ~~1018BR MCP 执行记录复用 Bot 简洁展示，失败保持可查。~~仅修改原 Bot 执行投影与回执状态纯函数：已知 MCP 数据工具和原 search／inspect／invoke 桥的成功记录默认收起；识别原桥的外层失败，不把 data／schema 内的业务 error 字段当成执行失败。未知／post-hook 回执保留原展示，审批、取消、Mod 交互卡片、附件与正常文本不折叠。原工作台继续原渲染路径；未新增监听、定时器、缓存或持久化。
    - 同配置正常退出旧主进程49357及全部子进程后更新构建。真实双模型各一次直接成功、延迟成功及两类错误，默认视图不再出现成功原始卡片或工具空行；执行详情开启仍能查看原卡片，关闭回到简洁视图；两模型的错误和范围拒绝各保留紧凑“执行遇到问题”入口。延迟错误真实 ToolMessage 的 status=success／is_error=null，正文 ok=false，仍正确显示问题入口。原工作台三个原工具卡片保留，群双模型交付正确。63项投影／状态回归、原test:messages、web类型检查、四文件lint及构建通过。此项不替代全部 UI、动画、原生焦点／滚动和 Windows 验收；BV仍需原生Zoom，未据此改生产启动代码。证据见 P03.5 的BR目录与/tmp/cmb-1018BR-*日志。
  - [x] ~~1018BQ 原生输入的完整草稿重启、接受后清理与实际发送。~~复核原CMB ThreadContext／Bot会话草稿、群草稿和已有request回执；对照Grok恢复源码PromptAcceptanceLedger的输入摘要（含引用／附件身份）与Hermes按群／回复拆分的composerDraft，保留现有实现，不新增存储或发送机制。原生粘贴文字、原文件选择器添加31B合成CSV，私聊引用既有消息；群聊通过键盘候选选择MiniMax成员并引用既有群消息。正常Quit原18797及全部所属进程后，同配置重启：私聊文字／引用／附件恢复，群文字／成员提及／引用／附件恢复，原mask39字符草稿自动恢复且未重输；明确发送前未新增任务或消息。
    - 恢复后追加明确发送要求，群任务29439833…仅交给所选MiniMax，私聊d7d8409f…使用DeepSeek；原路由记录均pinned、requested=resolved，分别为custom:minimax-m2-5及custom:deepseek-v4-flash。两者一次完成、0工具，准确输出数据行数2／合计15.75／币种未提供。群提及仍含原成员ID／范围，引用仍是原消息ID；私聊引用仍绑定原assistant消息ID与ordinal284。附件复用重启前的shared路径和SHA，发送没有重复复制文件。再正常Quit41578及全部所属进程，同配置重启：717任务、233文件、4290核心消息头与退出前逐项相同，已发送草稿未复现，无任务或通知重放，mask原草稿再次自动保留。
    - 随后无提及／引用／附件的普通群消息产生417dd01f…（MiniMax）与899a7e07…（DeepSeek）恰好两条任务，各准确回复自己的当前名称与77、0工具；mentions／reply为空，未继承上一条成员范围。原715任务、36Bot、10群、9例行、26命令、231旧文件和4286旧核心消息头逐项保留，最终719任务／233文件／0活跃，两库quick_check=ok；五份线程头只变更updated_at（含一份普通工作台线程），不称全部会话字段完全不变。
    - 原生粘贴／指针选项操作曾未生效，核对实际输入后才继续；群提及最终用Down／Return确认候选，不将普通粘贴文字当成成员身份。AX的Placeholder／Value顺序改变令发送校验中止，修正校验后只发送一次；初始无新增文件断言不符合原附件导入会保留两份副本的契约，已更正且旧文件全保持。23项原草稿回归通过，生产源码／正常构建哈希未变。恢复深色、3000×1800窗口、80px头像栏和mask草稿；未操作另一群既有@草稿。1018BP的草稿空输入经原生输入未复现，不据此修改生产实现。本项只覆盖Mac草稿与发送，不替代Windows、原生IME、全部焦点／快捷键／滚动及当前官方Grok实跑；BV仍需原生Zoom，P09.4父项保持待验。证据quality-review/1018BQ-native-draft-restart/{drafts-before-quit,restart-ui-observations,draft-file-staging,models-final,group-messages-final,routing-evidence,before-second-restart,after-second-restart,final,review}.json、review.py与/tmp/cmb-1018BQ-draft-tests.log；另归档用户Library/Application Support/CMBDevClaw-Bot-Acceptance/1018BQ-native-draft-restart.tar.gz。未commit／push。
  - [x] ~~1017I 较短视口的 Bot 编辑弹窗滚动。~~原生 View Actual Size 后连续七次 Zoom In，创建每周例行任务的标题与底部按钮被裁出窗口，在工作内容区域向下滚动两页仍无法到达底部。对照原 CmbCowork AddMcpConnectorDialog／AddHookDialog 的有限高度与内部滚动布局，仅给 Bot、群聊及例行任务三个编辑弹窗补有限高度和表单滚动；保留原 Dialog、表单提交、焦点和 Select，不改公共弹窗或增加监听／计时器。复验既有 MM／DS 绑定 Bot、群聊及普通尺寸，未保存表单不改变配置；这是视口布局验证，不等同于新双模型或 Windows 验收。
    - 同配置新版已实屏复验：DS每周例行任务在相同七次Zoom In后，标题／关闭按钮完整保留，正文向下滚轮能到达星期及完整取消／保存；MM编辑Bot四次Zoom In后能滚到模型／配置／底部按钮；群编辑七次Zoom In后能滚到完整底部按钮，成员列表保留原独立滚动。正常尺寸的MM例行入口与原Select每周选择保持可用，所有未保存表单取消、缩放恢复Actual Size、详情收起且输入为空。仅六处className修改；web类型检查、三文件格式、群／例行组件lint、构建与diff通过，BotsWorkspace的既有lint诊断仍按1017H保留。27个Bot、7群、全部例行配置及426任务状态／更新时间完全不变，135份跟踪旧文件哈希未变，0活跃、quick_check=ok。证据quality-review/1017I-editor-scroll/{before,review}.json及/tmp/cmb-1017I-{web,format,lint,build}.log；不新增模型调用，不据此关闭Windows、物理窄窗口及完整P09.4／动画；BV启动观测仍单列。
  - [x] ~~1017H 私有记忆直接返回详情。~~原MM合成Bot实屏确认：私有记忆管理中顶部“详情”已选中，实际点击后仍停在私有记忆，不能打开职责／例行任务。当前将内部memory映射成Radix details值，受控Tabs重复选择同值不触发onValueChange。仅在现有私聊“详情”标签点击时，若当前内部为memory则沿用setDetailTab回到details；其余标签、群、记忆数据、IPC及原工作台不变，不新增导航状态或按钮。通过MM／DS绑定Bot的实际进入、点击／键盘返回、文件标签往返、详情关闭重开验证；本项为UI交互，不将其当作新模型调用验收。证据quality-review/1017H-memory-details-navigation/before.json。
    - 同配置新版复验：MM绑定Bot保留原私有记忆现场，点击已选“详情”立即显示职责／例行任务；重新进入记忆后，Shift+Tab两次聚焦详情并Enter也正确返回，原资料库往返保持。DS绑定Bot先实际看到自己的鹭桥-DS条目，再点击详情回到职责／例行任务；关闭后焦点回到原聊天标题，重开仍是该Bot详情，最后收起、输入为空。仅增加三行onClick，未新发模型任务；27个Bot、7群／例行配置、426任务／0活跃不变，参考1017E的135份旧文件及8份记忆哈希均未变，quick_check=ok。web类型检查、格式及构建通过；组件lint当前1error／4warning与HEAD逐项完全一致，保留存量诊断不宣称全文件lint通过。证据quality-review/1017H-memory-details-navigation/{before,lint-comparison,review}.json及/tmp/cmb-1017H-{web,format,lint,build}.log。此项仅为Mac真实UI导航闭环，双绑定不等同于新双模型任务、Windows或完整UI／动画验收；BV冷启动观察仍需原生Zoom，单独保留。

  - [x] ~~1016BZ 成果预览弹窗的上下滚动。~~修复前在现有1016BY4报告正文执行向下滚动两页，标题／表格位置不变、最后结论仍被裁切。核对原工作台RightPanel发现FileViewer依赖flex父级承接有限高度，Bot弹窗漏了flex／flex-col，仅在BotMessageFilePreview的一行容器类中补齐，保留原FileViewer／Dialog、读取取消、权限、保存与焦点恢复，无全局滚轮监听或计时器。正常退出旧PID94741、构建后启动67187；真实MiniMax既有BY8报告、DeepSeek既有BY7报告均实屏滚到完整结论再滚回标题，弹窗标题栏固定；用户截图同一BY6原件从既有资料库打开后也能滚到74.13／74.10／0.03的最后结论。Escape关闭后焦点返回原文件按钮，草稿未编辑，详情已还原关闭。25项既有预览路径／事件回归、web类型检查、该文件lint／格式及构建通过；原27个Bot、群／例行配置、385任务状态及134份跟踪旧文件不变，quick_check=ok。证据quality-review/1016BZ-file-preview-scroll/{before,after-start,review}.json。此为macOS实屏对既有双模型产物的UI验证，未新发模型任务或改后端，Windows仍待实机验收。
  - [x] ~~1016BX 附件交付失败的默认展示。~~BW实屏中executionDetails关闭，bot_deliver_files失败却进入通用完整工具卡并暴露内部回执。仅将该工具的失败／中断接入已有Bot简短异常折叠，成功附件沿用现有专属卡；原执行详情、审批、Mod卡及普通工作台不变，未放宽同事文件目录校验。既有BW失败已验证默认折叠及展开；新版真实MiniMax任务3cdea147…、DeepSeek任务18474952…各仅尝试一次合成缺失文件，保留真实ENOENT，随后write/read/deliver真实文件并completed。两边正式界面默认显示“执行遇到问题”，点击可展开原回执、再收起；成果预览分别显示MM_OK／DS_OK。正常退出重启后任务ID／状态／更新时间不变，恢复文件仍存在，故意缺失文件未创建，未编辑用户草稿。13项邻近渲染测试、原消息回归、web类型检查与构建通过，后续BY构建保持相同两行展示修正。DeepSeek实屏在原生Window→Zoom后才与AX同步，该工具观测问题仍单列BV，未添加生产刷新兜底。证据quality-review/1016BX-delivery-error-view/{both-delivered,restart-ui-review}.json；本项只关闭附件错误默认展开的问题，不代表整体布局／动画已对齐。
  - [x] ~~1016AW 已结束提问历史展示。~~对照当前官方 0.71.2 的 resolved／dismissed 紧凑展示，Bots 简洁视图将已结束 request_user_input 显示为问题与实际答案，或明确标注已跳过／已自动结束；不再直出原工具标题。仅使用原参数和真实回执，保留自填答案及追加说明，不按可能被 Runtime 过滤过的选项索引还原答案，不把自动选择标成用户回答；未知／错误回执回退原记录。没有新增 store、订阅、计时器或后端链路。原预览正常退出53062后更新至56051，旧AV的ignored实屏显示已跳过；真实MiniMax任务bf1b304c…进入原面板等待，实际选择第二项“完整源码”、追加合成说明并提交，回执submitted，Bot准确复述，历史卡显示完整内容。执行过程开关仍显示原记录，随后恢复关闭，草稿为空；280任务／0活跃、quick_check=ok，六份原AU产物及两份记忆哈希未变。17项相邻回归、原messages、构建与diff通过。完整web检查仍因额外bot-ipc-result.ts引用缺失bot-types退出2；只在/tmp排除三份额外无引用文件的当前源码检查exit0，未改仓库配置。证据quality-review/1016AW-question-history/{before,after}.json。自动结束／自填答案有派生回归，未声称实屏全覆盖；待回答面板及其原工具标题、Windows／整体交互动画仍待原范围验收。
  - [x] ~~1016BC Bots 简洁视图的内部待办卡片。~~只补原ChatContainer的surface／showExecutionDetails展示条件，复用原todos状态；普通工作台保持原条件。完整web类型检查、原messages、构建和diff通过。正常退出56051后更新同一预览配置，DeepSeek真实任务f46a9396…进入waiting_user；截图与AX确认简洁视图不显示Agent Tasks，打开执行过程仍显示原6/6，关闭恢复。实际选择“继续”后准确复述并completed，草稿为空、侧栏80px；六份BA原件与记忆哈希未变。证据quality-review/1016BC-todo-presentation/{started,after}.json。原待回答大面板及工具标题仍有Grok展示差异，未由此认定整体UI对齐。
  - [x] ~~1016BF 待回答卡片与原提问链复用。参考官方0.71.2 widget的Ue，将Bots待答问题内联展示，保留字母选项、原位自填、单选直接回答、补充说明、多题和明确跳过；复用原UserInputRequestDialog的草稿、响应、倒计时与提交接口，普通工作台保留原面板。仅在真实pending请求与已加载调用匹配时折叠重复原工具行，错误、未知及详细视图仍可检查；沿用原虚拟列表footer及滚动机制。~~单选、自填、追加说明、多题、详情往返、聊天草稿和原工作台已分别通过真实模型及相关回归；中文IME与Windows仍列在P09.5／P12.5，不由本项替代。
    - [x] ~~待回答时停止的收尾复核：使用同一MiniMax Bot发起新的合成问题，通过原停止入口取消；核对任务真实终态、卡片及输入状态清理和后续新消息可正常完成，不将“跳过”当作取消，也不删除已有回执。~~后续重新读取实际界面：c658e288…仍cancelled，待答卡与停止按钮均消失；同一会话新发C2后真实MiniMax回复BF_CANCEL_CONTINUE_OK，输入恢复为空。未修改原取消机制。取消后旧工具标题仍暴露、下一轮短暂跟随全局loading，作为1016BG单独处理，不把它当作取消失败。
      - c658e288…已实际cancelled，原运行日志确认request_user_input收到abort。电脑工具却同时返回旧的中文草稿、后续英文待答AX和上一轮BF-S截图，坐标操作报noWindowsAvailable，原生菜单随后只返回View节点；不能据此判定页面卡死，也不能认定取消后的卡片已清除。尚未发后续验收消息，界面收尾保持待验；未因工具读写不一致修改生产代码或追加取消机制。证据quality-review/1016BF-inline-question/minimax-cancel-attempt.json；before-stop.json实际在按钮操作后查询，已明确更正其采样时序，不作为取消前快照。
  - [x] ~~1016BG 取消提问的历史展示。BF-C真实取消后没有ToolMessage，默认聊天仍回退原“请求用户输入”工具标题，下一轮还会跟随全局loading显示处理中。参照官方0.71.2的Tt结束问题卡，复用现有Bot消息来源／任务终态与BotQuestionHistory：已加载调用明确属于cancelled／interrupted任务且没有回执，或原botToolResultStatus识别到精确取消回执时，显示问题及实际结束状态，不伪造回答或成功结果；未知归属、一般错误、Mod及详细视图保留原记录。沿用既有消息窗口与来源缓存，不新增RPC、存储或Runtime取消机制。~~实际回答回执优先、下一轮保持结束、来源缺失／分页、重复调用ID和子Agent边界由相邻回归覆盖；同一BF-C历史和新的双模型场景已复验。
    - 同一BF-C重启复核仍显示原工具标题，未计为修复通过。核对持久记录发现：C2启动时原DeepAgents补齐了精确的取消ToolMessage，导致“仅无回执”的投影按预期保留原记录。已有botToolResultStatus已准确识别该原始取消回执，直接复用它显示已中断问题卡；JSON伪状态、一般错误或其他调用ID仍不能据此标为中断。没有修改或补写模型回执，继续用原BF-C记录复验。
    - 第二轮仍未通过展示验收：原MessageBubble只把completed或running工具交给专属展示，中断状态在调用展示器前即走原工具卡。仅为Bot简洁视图的request_user_input／interrupted补齐现有展示接口，审批先行分支、Mod卡、其他工具、详细视图及原工作台保持原路径；不扩大通用错误处理。继续正常退出后重建，并以同一历史及MiniMax／DeepSeek新任务复验，不能因解析器通过就判定接线生效。
    - [x] ~~最终构建MiniMax／DeepSeek真实待答、停止、续聊及详情回执。~~MiniMax-M2.7的93dd5871…进入waiting_user后正式停止为cancelled，界面立即显示Choose BG-M layout／已取消并清除待答卡与停止按钮；94d84c18…续聊completed、准确回复BG_MINIMAX_CONTINUE_OK，旧问题在新轮运行中保持结束。DeepSeek-v4-flash的23c02695…同样实际取消，321a8060…续聊completed、回复BG_DEEPSEEK_CONTINUE_OK。原Runtime在两套模型下一轮均补入其真实精确取消回执，简洁视图显示已中断；分别打开执行过程及对应工具，能检查原回执，再关闭恢复结束卡片。两个新问题均未代答，两条续聊均未调用工具。原25个Bot定义、3份记忆及双方既有六份编程文件哈希保持，任务299→303、无活跃任务，没有重复派发。相关30项回归、原messages、完整web、构建及diff通过；新解析器／卡片lint通过，BotConversationTools原有setOrigins effect的1个error及2个间接windowKey warning在HEAD亦复现，本轮未报告该完整文件lint通过。证据quality-review/1016BG-cancelled-question/{before,minimax-waiting,minimax-stopped,minimax-final,deepseek-waiting,deepseek-stopped,deepseek-final,after}.json。原生工具期间有过期AX／画面和user-changed拒绝，均先重新观察／核对任务再操作，未因工具问题修改取消机制。本项不代替Windows、中文IME、完整Mod实屏或全部任务质量验收；当前代码仍仅在本地。
    - [x] ~~DeepSeek真实单题与批量问题的第一轮实屏。~~042e9ef9…直接点击“完整版”后完成；Escape未跳过、执行过程原调用可检查，聊天草稿保留后清空。faf58be4…第一题选完整版并填合成补充，详情往返后仍保留；仅第一题完成时控制库仍waiting_user，第二题自填“青鹭交付-1016BF”后Enter一次提交，两题历史卡及模型复述均准确。21项相关回归、原messages、完整web与构建通过。验收同时修正未答完时按钮的下一题含义、自填空值不能提交旧选项，并沿用输入法组合态保护；最终构建的MiniMax／原工作台复验继续进行，不将整项划掉。
    - [x] ~~最终构建与原工作台MiniMax显示／提交路径回归。~~原thread cfe524bf…只调用一次request_user_input，仍显示原大型面板；点简版后面板保持，点原“提交”后模型回复简版，实际ToolMessage已持久化。最终web／构建及diff通过，沿用21项相关回归与原messages。既有24个Bot身份均保留、DeepSeek六份编程原件及原两份记忆哈希保持；预览并行试用新建beg及其新增记忆没有清理或回退。该轮尚未完成的Bot自填空值／明确跳过见下一条最终复验；中文IME与Windows继续待验，不据此宣称所有原模式无回退。证据quality-review/1016BF-inline-question/{single-option,batch-waiting,batch-submitted,native-workbench,review}.json。
    - [x] ~~最终构建MiniMax空自填、多题及明确跳过复验。~~任务b5ce9a32…：第一题先选完整版的补充，再聚焦空自填，旧选项被清除、Enter不提交、继续按钮禁用；填“合成报告-1016BF”后Enter只进入第二题，控制库仍waiting_user。选今天后一次提交两题，实际回执、历史卡与模型回复一致。任务b5d2d22c…：点击X产生ignored回执，历史显示已跳过，模型仅回复“已跳过本轮问题”，未默认作答。两轮均只调用request_user_input；MiniMax与DeepSeek既有六份编程产物、原两份记忆和既有Bot身份保持。未新增store、轮询或动画时钟，沿用原响应路径；最终版未再修改Runtime或审批。21项相关回归再次通过；新组件仅格式整理后完整web检查、格式检查与diff通过。证据quality-review/1016BF-inline-question/{minimax-empty-custom,minimax-batch-waiting,minimax-batch-submitted,minimax-skipped,review}.json。本次修改在80dcf9aea阶段推送之后，仍仅保留本地，未另行提交或推送。
  - [ ] 1016AV 用户实屏反馈：长任务中成功工具已隐藏，仍残留多行空白；失败命令直接暴露工具卡／内部路径。核对发现 Bot 父层只投影已提交历史，实际列表还合并实时消息，且活动整轮跳过折叠；空工具壳继续进入虚拟行。将 Bots 的折叠判断接到原 ChatContainer 实际 displayMessages 与既有增量工具版本，保留真实 Mod／审批／交互卡，不新增消息或滚动状态。失败普通工具改用简短、可展开的异常提示，原命令／回执仍在查看执行过程中。用本次真实 1016AU 历史与新的活动轮次复验；原工作台不变，不删改失败证据或模型产物。
    - [x] ~~历史失败卡与实时折叠接线修正。~~只在 surface=bot／执行过程关闭时，按原合并消息和增量工具版本投影；活动轮次可立即收起已有成功回执的纯工具行，真实 Mod、未返回、失败／取消和交互仍保留，晚到错误重新显示。失败普通工具默认显示“执行遇到问题”简短入口，原 ToolCallRenderer 在展开后仍可检查。原预览正常退出旧47002（exit0）、载入新版53062后，原AU失败卡实屏变为短提示；AV六次真实读取没有累计空行，AV2五次读取＋一次20秒原生命令完成并返回AV2_DONE，执行过程开关能显示全部真实记录，再收起恢复简洁视图。22项相邻回归、原messages、构建及diff通过，六份AU原产物与两份既有记忆哈希未变，279任务／0活跃、quick_check=ok。证据 quality-review/1016AV-empty-rows/after.json。
    - 限制／待验保留：20秒命令运行中截图处在上一段视口，未取得当时底部快照；活动多行折叠有纯投影回归，不能冒称完整动态录屏。AV的request_user_input实际收到ignored，未查明提交者，不能计为等待选择验收；IM的“无授权路由”日志仅返回而未提交回答，未据此擅改IM。已结束交互的原工具标题仍可见，另需对照Grok处理。
    - 原npm run typecheck:web因额外的src/shared/bot-ipc-result.ts引用缺失./bot-types退出2；三份不在本轮实现中的文件最初为未跟踪iCloud占位，均保留内容。访达保留下载后读取恢复。用原配置、仅在/tmp临时排除这三份无入站引用的额外文件，当前实现类型检查exit0；原完整命令失败如实保留，不修改仓库tsconfig或把局部检查称作全量通过。清单／SHA位于同证据目录。后续1016AZ已备份移出两份无引用且缺失旧依赖的新增文件，原node／web完整检查均恢复exit0；此前失败与临时局部检查记录不删。
  - [x] ~~1016AS 群聊最新回复底部裁切。1016AR 连续两次启动后，最新 AP 气泡底部仍在消息视口外；先核对现有 Virtuoso 的测量／定位契约及原聊天列表实现，再局限于群聊修复。要求首次进入、发送／回复、加载旧页及引用定位均正确，不以延时滚动或任意留白掩盖根因，不改变消息／草稿或原工作台。~~
    - [x] ~~首次进入、回复追加、上翻阅读及已加载引用定位。~~ 原 ChatMessageVirtualList 已用 flow-root 防止日期 margin 穿透虚拟行；群列表漏掉同样的布局约束。仅增加群行 display:flow-root，未新增组件、滚动器、计时器或数据状态。同历史新版首次打开不再裁切；真实 DeepSeek／MiniMax 的 AS 两条四行回复自动完整可见，AS2 执行中原生上翻后完成仍保持旧位置，点最新后两条末行 AS2_END 完整可见；旧引用可定位原消息。四条任务 7650b452…／54a94c30…／6de16af7…／fc804520… 均 completed，身份／群／例行定义及两份记忆哈希不变，草稿为空。10 项相邻测试、原消息回归、web 类型检查、构建通过。证据 quality-review/1016AS-group-measurement/evidence.json。
    - [x] ~~跨50条前插分页及引用布局。~~原群仅30条，故复用已有1015Z固定样例配置的60条历史，只更新其 renderer 为当前构建，保留醒目的独立样例标题／横幅。实屏初次进入末条完整，上翻后点“加载更早的消息”取得前10条，继续可浏览第1—5组；返回最新后从第30条引用定位第1条及随后上下文，再返回末条仍完整可见。60条历史哈希与30条固定任务数均未变化，没有发送或调用模型；原生 Quit exit 0、进程42959已消失，原预览仍运行。证据同目录 fixture-before.json／fixture-after.json。结论限该固定样例布局，与上项真实双模型结果分别记录，不代表所有动态 Markdown／Windows／整项 P09.4。
  - [x] ~~私聊未发送文字与附件经原生 Quit／冷启动恢复，随后通过原 Runtime 交给真实 MiniMax；确认发送后再次冷启动不恢复已消费草稿、不重复任务。~~（1014T/T2）冷启动控件树恢复“1014T：冷启动恢复草稿，暂不发送。”和 CSV；窗口重绘后实际界面可操作。改为核验任务后，MiniMax 任务 `a825551f-86d7-4b24-9bc5-6af6e465ad84` completed，正式回复原文件 attachment-1013Y.csv、3 笔、50.75；41 B 保留副本 SHA-256 与源文件同为 `4f5f1ec7e22275bdb1aada507230451ed14aee5f75f2d090f4adfc7f79bbd9de`。再次原生退出／启动后输入及附件为空，控制库同题仍只有一条任务。故障回执恢复使用下项真实 SQLite 故障测试，未将正常模型发送当作真实 IPC 丢包验收。
  - 私聊草稿恢复顺序补充复核：原 initializeThread 只在首个 ThreadState 创建前读取持久队列，恢复输入可能先创建默认状态。现先调用原 initializer，再恢复草稿，避免遗漏待确认队列；新聊天合并也使用同一个恢复入口。初始化顺序回归通过，真实待确认队列的冷启动实屏仍需补测。
  - [x] ~~私聊发送保留原请求 ID 和结构化附件／技能内容，发送确认不明时核对 Bot 收件箱回执；通过真实 SQLite 故障测试证明重载后不会创建重复任务。~~（1014T 代码回归）继续复用原 ThreadContext 的 QueuedMessage、localStorage 队列和输入组件；只增加可选持久化结果回调，原工作台仍走原路径。Bot 在准备和保存完成前保留输入、附件；保存失败不派发，已派发但确认不明时锁定原内容，手动重试沿用相同 ID。回执由原 BotStore 批量读取活动任务、归档引用及 90 天摘要，区分接收、冲突、缺失，支持执行记录清理后核对，不把已接收等同于执行成功。仅在挂载、任务变更或窗口重新聚焦时只读核对，不轮询、不自动重放；过期且无法确认的请求禁止盲目重发。33 项发送／草稿／IPC／历史回归及 node／web 类型检查通过，原 `test:messages` 通过。Mac 正常发送、真实 MiniMax 与原生冷启动由 1014T/T2 补测通过；真实 IPC 确认丢失后的完整实屏仍待补测，本项不代替 P09.4 整体验收。停止回执竞态及初始化顺序补充后，相关 77 项回归、原消息回归、node／web 类型检查通过。
  - 源码追踪发现私聊发送失败仍有缺口：原 ChatContainer 在附件解析／投递前清空 composer，BotConversation 的 client.send catch 只把完整模型 payload 放回 draftInput，没有恢复原附件 chip，也没有持久保留该次请求 ID。需复用原 QueuedMessage 的文字／附件／技能结构和稳定身份，增加 Bot 交接失败的恢复接线；同时保护后续新草稿，并验证“已接受但回执丢失”重试不重复交办。当前未用文件场景完成故障注入，不能宣称私聊失败恢复已通过。
  - [x] ~~私聊文字与已保留附件经 renderer 重载后恢复，随后真实发送仍可解析附件，成功发送后输入清空。~~（1014S/S2）Mac 正式界面保存合成文字与 41 B CSV 后原生 Reload，回到同一 AP 私聊时文字及文件 chip 完整保留；更换为核验指令发送，任务 `1d1017a1-f09a-467a-a9f5-ef251ebf9597` completed，真实 MiniMax 回复原文件名 attachment-1013Y.csv、3 笔／50.75。正文与附件已清空，无额外未发送任务；源文件和保留副本 SHA-256 均为 `4f5f1ec7e22275bdb1aada507230451ed14aee5f75f2d090f4adfc7f79bbd9de`。此项不代替原生退出后的冷启动、发送失败和未知回执恢复验收。
  - 私聊文字与已保留附件的持久草稿已接入原 ThreadContext：Bot／主机分开存储，新聊天先恢复再合并；群草稿与私聊共用有界 schema 和读写／清理函数，不新增输入状态或保存二进制。订阅只比较草稿字段，不因 token／消息更新写盘，也不缓存完整 ThreadState；注销不重新写入已删除 Bot 的草稿。18 项私聊／群草稿／新聊天附件回归、原消息回归、web 类型检查及构建通过；正式界面重载与随后真实发送已由 1014S/S2 验证；原生退出后的冷启动及发送失败／未知回执恢复仍待验收。
  - [x] ~~重载后从新聊天直接选择已有群，先恢复该群持久草稿，再合并新文字／附件。~~（1014R）修复 `carryGroupDraft` 先前只读内存、可能覆盖尚未打开群的旧草稿的问题；复用已有 restore 与附件预算／revision 校验，恢复异常时保留记录并阻止合并。13 项草稿／新聊天附件测试、原消息回归、web 类型检查与构建通过。Mac 正式界面先保存合成群草稿、切到私聊并原生 Reload，再从新聊天输入新文字后选择该群，界面完整保留“重载前保留的群草稿”与“新聊天追加内容”，原指定收件人保持；未发送验收消息，结束后仅清空本次合成文字。未据此勾选整个 P09.4。
  - [x] ~~Bot 普通会话模式下刷新界面后恢复工作流状态和运行历史。~~ 复用原 `workflow:hydrate`、状态合并及历史面板，以共享 Bot 能力判断补齐入口；普通非 Bot 会话不增加 hydrate 请求。1014G2 已取消工作流 `wf_c3f6a9d1e868` 在刷新后显示“已中止”，历史面板显示原 4 条运行记录；控制库任务总数仍为 42，没有因恢复新增任务。12 项面板能力边界测试及原 8 项 Bot 能力测试、原消息回归、线程性能契约、node／web 类型检查与构建通过。本项覆盖 renderer 刷新恢复，不代替主进程崩溃恢复验收。
  - [x] ~~群聊首次读取历史后再挂载虚拟列表，进入时定位最新消息；提供返回最新入口，发送后定位新消息，旧页合并保留原条目位置。~~ 复用已有 react-virtuoso 及 Bot 交流列表的 firstItemIndex 方式。1013U 实屏通过首次定位、上滚后返回最新和两成员回复可见；重叠分页锚点／草稿共 6 项测试、typecheck:web、build、test:messages 通过。真实超过 50 条的分页与窄窗口仍待验证。
- [ ] P09.5 验证离屏暂停、减少动态效果、流式消息不重复入场；同尺寸截图／录屏逐项对照。
- [ ] P09.6 检查用户可见品牌、图标、文案和对齐；无调试字符串、伪按钮及无法兑现的状态。
  - [x] ~~1018CM 顶部身份胶囊的多余下拉箭头。~~当前官方0.71.2实屏为头像与名称；本地只删除常驻ChevronDown及无其他引用的导入共两行，保留原按钮／ARIA／焦点／详情逻辑和样式，无新增状态／监听／时钟。web类型、格式和正常构建通过；组件lint与HEAD均为既有1 error／4 warnings，规则、正文、列相同且行号均只随删除导入前移一行，不称lint清零。原7进程全部正常退出后才构建，同配置重启859任务及旧消息头完全相同；新包实屏无多余箭头，标题两次点击分别打开／关闭原详情，焦点回标题。真实MiniMax a020abc2…、DeepSeek e4a54397…均completed／零工具，名称、上一轮15.73／33.12和新计算75正确。27项核对通过，38Bot／10群／9例行／27命令／262文件、原任务及消息头保持，最终861任务／0活跃，两库quick_check通过；原39字符草稿、用户会话、298px栏和3000×1800窗口恢复。此次冷启动AX先只有外框，实际截图已显示工作台；Raise未恢复AX，按截图坐标点击原Bots入口后正常，本次无需Zoom，未添加生产兜底、未据单样本销除BV。证据quality-review/1018CM-title-pill/{before,after-restart,task-windows,final,review,built-source,restore-ui,lint-comparison}.json及前后实屏；无commit／push，不扩大为完整UI／动画一致。
  - [x] ~~1018CK 截断技能任务的摘要展示。~~1018CJ实际详情“最近工作”泄漏内部技能协议，确认为Store原600字符快照截去结束标记，完整消息解析未生效。仅加两行生产代码，复用原shared/skill-use-block的stripSkillUseBlockForDisplay及既有附件／可见文本投影；不扩查询、不改消息／技能授权／Runtime。真实格式反例先1失败／14通过，修正后15项、messages、web类型、定向lint／格式及正常构建通过。确认旧7进程退出后启动新版，历史及新任务摘要均不再露出协议；正式选择skill-creator后，MiniMax 09c09227…与DeepSeek 2b0ed1ad…均完成三方面需求澄清。DS本轮一次真实read_file，MM复用此前已读技能上下文，不能记为本轮重新读取；两份999字符完整技能消息均原样持久化，600字符摘要确为截断实例。聊天及最近工作实屏通过，待办复用同一派生函数的回归，不冒充待办独立端到端验收。37项核对通过，原855任务／4940消息头、38Bot／10群／9例行／27命令／258文件不变，仅新增两条模型任务，最终857任务／0活跃，两库quick_check通过；mask原39字符草稿、用户会话及298px侧栏已恢复。证据quality-review/1018CK-skill-task-preview/{before,after,review,source-and-build-final,restore-ui}.json及AX，原失败记录保留；无commit／push，整体验收仍按父项保留。
  - [x] ~~1017BL 资料回执区分真实变更与原值确认。~~BK双模型后台验收中，原名调用bot_update_profile并未改动资料／版本，界面仍显示“已重命名”；同事工具的空字段会沿用原值，也不能一概显示资料更新。沿用原Store对原值不写入的处理和同步Host入口，只为成功工具回执附带名称／职责实际变化标记；现有短事件区分变更与“资料未变更”，旧回执兼容、不重写历史。对照Grok agent-lifecycle.updateAgent的真实资料回执原则，不搬云端资料文件，不增事件存储、订阅、计时器。权限与Store API不变，原工作台／Runtime／checkpoint无本轮新增改动。
    - 新增反例先4失败／79通过；修正后邻近122项及完整53文件499项、node／web、messages和正常构建通过。改动生产文件与纯展示测试lint无诊断；host.test.ts仍有3个既有未使用变量／空方法错误，与HEAD逐条一致、无新增，不称整个lint通过。正常Quit旧进程并确认全部所属进程消失后启动同配置新版，未加启动／图形兜底。
    - 真实DeepSeek 5f278b01…、MiniMax a90f4539…各执行3次自身资料更新、1次list、1次同事原名确认，零工具错误。自身回执变化依次true／false／true，同事确认false；界面各显示两条真实改名、两条资料未变更，最终说明与实际一致，没有启动同事或执行其他工具。两位合成Bot恢复原名，职责／模型／身份／头像等全部保持，仅各version2→4和时间变化；其余34Bot、原689任务、10群／9例行／24命令、239跟踪文件、4171旧消息头逐项不变，最终691任务／0活动、0已接受命令、无浏览器宿主。原mask 39字符草稿逐字保留，已恢复会话与窗口。角色变化与坏／旧／失败回执由真实SQLite及派生测试覆盖，未冒充双模型角色改写／Windows／官方同题通过；启动BV仍需原生Zoom。证据quality-review/1017BL-profile-changes/{before,built-source,models,final,review}.json及review.py，日志/tmp/cmb-1017BL-*；本轮改动未commit／push。
  - [x] ~~1017AX 已结束的浏览器接管不再遗留原始工具卡。~~1017AW实屏中的旧取消接管仍显示原始扳手行；仅在原isBotExecutionTool中把有真实ToolMessage的两种接管调用纳入现有规则：成功收起，失败／中断显示原简洁异常入口，无结果的活动请求保留交互卡。37项定向回归、原messages、web类型、最终lint零错误零警告、格式及构建通过；未改Runtime／租约／结果。Mac旧DS与MM取消历史实际为“执行已中断”，按需可展开；新DeepSeek a2aff7ad…／MiniMax b8c68914…均navigate→request_browser_help后waiting_user，原卡说明与归还按钮均可用，鼠标归还后各observe→close，恰好4次成功工具调用、同一真实页面、0错误。两者准确报告原只读状态未改变及已关闭；成功接管记录默认收起，MiniMax打开执行过程能看到原OK记录，关闭后恢复简洁。601条旧任务、35Bot、10群、9例行、21命令、216文件及3607旧消息头保持，仅新增2任务，0活跃、quick_check通过；mask39字草稿和220px侧栏、收起详情、原窗口尺寸／关闭执行过程均恢复，合成服务已终止。首次Cmd-Q未退出，两次退出检查失败；构建在旧空闲进程仍在时完成，随后原生应用菜单Quit成功、原7进程全退出后才启动新版，不将先前无效按键记为退出成功。证据quality-review/1017AX-browser-help-history/review.json。无结果的异常历史继续可见，不伪装为成功；Windows和全部核心验收仍未由本项覆盖。
  - [x] ~~1016AL 入口复用真实角色动画的接线与局部验收（用户纠偏）。1016AK 的整体缩放／倾斜不能替代 Bots 页面已有的轮廓与眼睛动画，撤掉该 CSS 方案，复用同一 BotAvatar 与 Grok 内核。通过单独懒加载头像模块，避免工作台同步加载整个 Bots 工作区；仍复用共享时钟、离屏暂停、空闲休眠和减少动态效果，不新增动画实现。~~
    - 入口仅 Suspense 懒加载同一 BotAvatar，静态矢量保留为加载占位；组件只增加可选 className 以保持 20px，既有头像不改默认行为。产物头像块 268816B（当前构建未压缩），与工作区共享，不引入整个工作区或 Runtime；来源说明随构建更新。web 类型检查、8 项头像回归、头像组件 lint（0 错误／1 条原有 settlement 依赖警告）、构建通过。原预览实际入口、进入 Bots 和返回工作台正常。可见工作台 20 秒／3 次进程采样 RSS 合计 401920／414320／328800 KiB，累计 CPU 折算单核 2.88%（其中 renderer 约 1.0%，包含工作台原动画与后台活动）；没有据此断言全部性能通过或新组件零占用。共享时钟的空闲休眠、离屏暂停及最后卸载清理复用原代码；无独立 pointer-move／视频接口，完整角色悬停过程与运行状态仍由 D05／P09.5 保留验收。未新增模型任务、未提交。证据 quality-review/1016AL-avatar-entry。
  - [x] ~~1016AK Bots 入口悬停动画（用户补充）。在 1016AJ 静态角色基础上增加轻微抬升、倾斜与弹性归位；键盘聚焦提供同等反馈，按下轻微收缩，减少动态效果设置下保持静态。使用局部 CSS transform 过渡，不引入角色内核、计时器或持续循环；核对实际入口、构建样式。~~
    - **本项为试验记录，当前已由 1016AL 替换，不是最终方案。**原 img 使用 400ms transform 过渡：抬升 1px、倾斜 −18°、放大至 1.16，cubic-bezier(.22,1.45,.36,1) 提供轻微弹性；按下缩至 .96。首版 8°／1.12 在 20px 图标上不明显，用户反馈后增加幅度。两版 web 类型检查、构建及局部实屏通过，但用户认为仅有缩放、不及 Bots 页面角色效果，故完整撤除该 CSS 方案，历史证据保留 quality-review/1016AK-entry-motion。
  - [x] ~~1016AJ 原工作台的 Bots 入口外观（用户截图）。将“Bots 工作区”精简为“Bots”，移除圆底机械机器人小图标，复用现有圆润角色的静态矢量图形；校正尺寸、字重和间距。仅改该入口展示及资源，保留既有路由和无障碍名称，不提前加载 Bots 运行代码／动画时钟。构建后实屏检查明暗背景下的清晰度与点击入口；悬停采用已有 CSS 过渡，动态观感仍随 P09.5 复核。~~
    - ThreadSidebar 仅替换这一入口的展示：20px 角色图形、14px 中等字重、10px 间距，显示“Bots”；aria-label 继续为“Bots 工作区”，路由仍 setMainView(“bots”)。静态 SVG 从已复用的角色内核生成，共 4911B，仅三条原始路径和内部引用，不为工作台导入内核／监听器／时钟。web 类型检查、构建、SVG 解析和资源一致性校验通过；原预览实屏核对深色、浅色，实际点击仍进入原 21 Bot／7 群，返回后工作台保留。已恢复用户原“深色／Bot 颜色”设置，没有发送模型任务。源码 17 行新增／2 行删除，未格式化整个侧栏或改其他菜单。截图见本轮工具记录；资源 SHA-256 fc34c04eef3973a41b65ab4955e930b31df17ba14503098e76d427f945ca43c3。无独立 pointer-move 工具，不将 CSS 悬停样式称为完整动画录屏验收。

  - [x] ~~Bot 审批卡片统一为当前工作区的中性色、圆角和按钮层级。~~（1014AP）仅 data-chat-surface=bot 的审批卡启用样式：单次运行作为主按钮，会话／长期允许为次按钮，拒绝保留危险色，无沙箱重试保留警示语义；窄宽度按钮可换行。Mac 深色实屏检查后单次批准真实 node 计算，回复实际输出 25。复用原审批队列和回调，未改授权种类或自动批准策略，普通工作台样式保持原样；web 类型检查、构建通过。其他审批类型、浅色和窄窗口继续核对，不宣称完整一比一。
  - [x] ~~Bot 操作错误去掉 Electron IPC 与 Error／BotError 包装前缀，保留实际原因和恢复提示。~~（1014O）实屏发现归档拒绝提示泄漏 `Error invoking remote method 'bots:update'`，现参考原工作台 `cleanIpcError` 规则统一 Bot 设置、群聊、记忆、浏览器、例行任务及成果保存的错误文案；不修改异常类型、权限检查或 Runtime 执行行为。3 项文案测试与 9 项草稿回归、原消息回归、web 类型检查和构建通过。未以此宣称全界面文案检查完成。

### P10 — 恢复与资源

- [x] ~~1016P 真实异步协作中断恢复。~~在原应用沿用现有合成 Bot，由用户直接交办一次无外部副作用的协作；实际接收同事任务并等待输入时，保留控制库／线程证据后强制终止主进程。使用相同配置重启，验证原协作子任务为 interrupted、不重放原交办、原发起线程只收到一份准确中断回执，已有 Bot／群／私有记忆不变；用户新消息可以继续。若模型未实际进入等待阶段，不将尝试记为通过。此项只验证本机协作恢复，不扩展为远端常驻、Windows 进程树或原生命令隔离保证。

  - 1016P 首次实测暴露缺口：真实 MiniMax 根任务 `ee39946e-b86b-4f64-b1b9-2f90e7d8230a` completed，DeepSeek 同事任务 `aacce251-b504-4f53-b17b-67a73f081d27` 实际显示 request_user_input 选择卡并为 waiting_user。只存在这一条活动任务时，SIGKILL 原主进程 44755，进程 exit 137；同配置重启后子任务为 interrupted、旧选择卡停用，但控制库仍是 241 条任务，没有给已完成根任务生成中断回执。21 个 Bot、7 群和私有记忆哈希不变。源码 `BotStore.recover` 只有批量状态更新，未进入已有 settle／reply outbox。修正限定为本次恢复中、原本需要回传的协作子任务：先标记所有受中断轮次，再复用既有 settle／outbox／requestId 去重；根任务同样中断或已取消时不自动唤醒，成员已退出／群删除时不再派送，不重放外部工作。不另建恢复队列，不修改原 Agent Runtime。保留本次失败，修正后新样本另验。证据 `quality-review/1016P-collaboration-restart/{before-kill,after-first-restart}.json`。

  - 1016P2 修正复验通过：真实根任务 `b582a995-a26c-46f1-835a-210d06f80f35` completed，子任务 `70907e62-5bff-494d-b844-85fd96965108` 真实等待选择；SIGKILL 原主进程 45747（exit 137），同配置新版本恢复为 interrupted，唯一回执 `3ddfae2a-5504-4624-85d0-ca69e01a6d37` 自动进入原发起线程并 completed。MiniMax 实际报告“任务已被中断，应用已重启……未能完成”，没有重新交办，也未给出伪造计算结果。1016P3 明确给出新选择／新交办授权后，根／同事／回传任务 `d0bd726c-e598-4061-9f89-4451ae155fbf`／`1e5f6ce8-654c-43e3-89c9-f1b4d65153f1`／`4d9a4647-0a2a-4c62-8a16-0e62ddb449ed` 均 completed，实际合计 36.55、来源正确；一次新交办、一次新回传。随后正常退出 0、同配置第二次重启，控制库仍 247 条任务、中断回执仍一条、0 活动任务，最近 6 条任务字节字段一致，21 Bot／7 群／记忆哈希不变，quick_check=ok。新恢复断言在修正前 2 失败／2 通过，修正后相关 92 项通过；node 类型检查及构建通过。证据 `quality-review/1016P-collaboration-restart/{before-kill-fixed-sample,after-fixed-restart,before-second-restart,after-second-restart}.json`。P3 模型仍把真实用户选择转述为“非用户直接确认”的多余提醒，记为交付表述差异，未改共享 harness，也未将本项通过等同于完整质量对齐。实屏仍需原生缩放恢复冷启动绘制；Windows／其余恢复场景不由本项代验。

- [ ] P10.1 实际强制终止／重启主进程，验证排队、执行、审批、协作和定时状态对账。
  - [x] ~~1019ED 等待选择的群复核跨主进程强制终止及部分成果交付（Mac，双模型）。~~沿用现有群轮次／Store.recover／Runtime：首成员只交接任务，同伴在群工作区写一份合成部分成果后实际等待选择；确认只有本轮任务活动后，强制终止隔离预览主进程。同配置重启应保留原文件、把原复核标记interrupted、不回答旧问题或重放写入；新的明确只读请求才能核验并交付部分文件。真实MiniMax／DeepSeek交换复核角色，按origin.messageId及工具调用ID取证，保留已有草稿／用户头像和其他任务。参考原CMB恢复与Grok／Hermes未知动作不盲目续做的边界；本机崩溃不等同于官方云服务重启，不新增自动重放或新恢复框架。
    - 首轮发现真实缺口：MM根787f7379…零工具交接，DS复核fe024fea…write_file一次后request_user_input实际waiting_user；只该任务活动时SIGKILL预览33721，所有所属进程退出，同配置39611恢复为interrupted、部分文件保留、0活跃／0游标。群里却没有对应中断结果，执行入口随活动状态消失，用户看不到同伴为何停止。Store.recover批量中断所有任务，但只为特定协作／checkpoint群任务走settle，普通群／discussion被遗漏。首次强退前另有2条无关任务已终态，保留且不计本轮执行；没有把总任务增量全部归给本测试。
    - 修复复用原recover事务、settle及noteActivity：先统一中断父任务，再对仍有有效成员的原群发布唯一终态和列表提示；不续跑、代选、转私聊或回填旧历史。新增真实SQLite恢复反例3例修复前失败／14通过，修复后群／Host／提及114项及完整Bot相关398项通过，node／web、原messages、定向lint／格式、正常构建通过。首版第三个夹具错误地让同Bot同时有两条running，原互斥正确拒绝；改为不同Bot后才取得3个目标反例，旧日志保留。升级前39611经原生Quit退出0且所属进程0，才构建；此阶段仅完成自动回归，尚不能算真实双模型强退／交付通过，最终复验见下。证据quality-review/1019ED-running-group-restart的首轮快照、模型／原生等待卡、red-first-fixture／red／green／bots日志及fixed-build.json。无commit／push。
    - 修正版已完成上述Mac等待态范围：DS根2e106a0d…→MM复核9d66bdd2…，MM根e8e10a0e…→DS复核6f9b3138…；两位均恰好write_file一次后request_user_input实际waiting_user，原生卡片可见且未选。分别SIGKILL精确隔离主进程43981／48189，exec均137、所属进程0后同配置启动；原复核ID保持interrupted，群里各有唯一明确中断提示，列表预览同步，无自动续跑／游标。两份部分文件字节及mtime均与强退前一致。
    - 新的只读群请求实际只派发MM75308af0…／DS998bcf4c…，各read_file及bot_deliver_files一次，准确说明先前复核中断而非完成；两份原文件从正式成果入口打开，分别显示ED_MM_PARTIAL_1019／ED_DS2_PARTIAL_1019，没有写入、重新提问或代选。随后正常Quit退出0、所属进程0，再启动后任务／定义／群／例行／命令／文件及核心消息头与退出前逐项相同，中断提示不重复；最后1274任务、60Bot／17群／15例行／54命令、339文件、6516消息头，0活跃／0游标。原1260任务、336旧文件及6465旧消息头保持，两份保护草稿哈希保持。
    - 期间另有5条非本轮任务完成，均保留、未计入9条本轮群任务；另一Bot的名称sean→陈强/version2也按实际现状保留，本轮工具均无资料修改调用，未自行归因于某位操作者。最终恢复原稳定Bot ID在当前名称下的空输入。一次手抄任务ID错误被强退保护检查拦住，未发送信号；后续从持久origin.messageId关联真实任务，不猜ID。原生paste未更新最终草稿且一次坐标操作返回noWindowsAvailable时没有发送，改用正式AX setValue逐字核对后才发送，持久收件人确认为原两成员；没有加入产品输入兜底或诊断代码。
    - 44项限定证据核对通过，证据`quality-review/1019ED-running-group-restart/{verification,final-results,final,fixed-build}.json`、真实选择／中断／成果预览、各阶段进程及回归日志。只覆盖Mac实际waiting_user复核；一般running恢复有SQLite回归，不冒充真实写入中断或任意外部副作用恢复。旧选择点击拒绝的实屏、Windows、多群并行及完整UI／动画仍未验，P10父项继续不勾选。无commit／push。
  - [x] ~~1017BN 新消息接续后的后台命令崩溃恢复。~~沿用原LocalSandbox、Store.recover和已验superseded接续，不新增生产恢复代码。真实MiniMax a90d695b…／DeepSeek0159351c…各执行一次180秒后台Node，真实选择开始分析后接收新问题，旧任务均superseded，新任务e8e31c16…／8ba12674…均零工具回答77，原命令继续。确认两命令accepted和原主进程身份后SIGKILL隔离主进程45365，实际exit137；旧界面子进程退出，仅原Node PID55635／55681继续，未重启或重新接管它们。
    - 同配置恢复将两命令分别41e5f56e…／3d5a2e0d…标为outcome_unknown，各仅一条canonical通知ae11d10f…／ff8fc386…；MM仅read_file一次，DS读取结果与启动日志各一次，均明确报告未知、未调用资料工具或重跑命令。原结果文件当时尚不存在，该预期读取按原Runtime返回文本保存，未冒充全部读取成功。两命令在原截止后各写出JSON并退出，原PID一致、启动日志各恰好一行；随后新的真实用户只读交办c5a5135f…／969c9516…均read／read／deliver，准确核对并交付两份原件。晚到文件证据不改写原outcome_unknown，也不恢复原命令控制权。
    - 正常退出58011及全部所属进程、同配置第二次重启后，任务／命令／定义／例行／文件／4250消息头逐项不变，无重复通知或续跑；四份原件均从正式界面重开。原695任务、36Bot、10群、9例行、24命令、239工作区／记忆文件及4211旧消息头全部保持；最终703任务、26命令、243文件、0活动／0已接受命令、quick_check=ok。原mask39字符草稿、80px头像栏、会话和窗口恢复；原恢复／命令／资料边界18项测试通过（其余111项按名称过滤跳过，不称129项全跑）。独立复核按实际任务时间窗与ToolCall ID归属，避免把无用户消息的通知工具误归旧用户轮次；验收器原误用path字段已按真实filePath契约修正。证据quality-review/1017BN-superseded-restart/{before-kill,recovered,original-results,before-second-restart,after-second-restart,final,task-windows,review}.json及review.py；本轮生产源码／构建与BM相同，未commit／push。Mac原生崩溃后孤儿进程继续、启动BV仍需Zoom的限制保留，不冒充Windows、任意进程隔离或完整P10通过。
  - [x] ~~1016AR 真实排队任务跨进程恢复。原隔离预览、既有 AP／MiniMax：私聊实际 request_user_input 等待，再在既有合成群中只提及 AP 交办无副作用的计算；控制库确认群任务 queued 后强制终止预览主进程。同配置重启应将私聊活动任务标记 interrupted、保留群任务原 ID 并只执行一次，结果只进入原群；再次正常退出／启动不重复入队或回复。沿用现有 Host／Store／Runtime 恢复，不改队列规则、不新增测试特例，保留身份／记忆哈希及真实回执。~~
    - 主进程 19346 SIGKILL 后退出 137；同配置启动后，私聊 bedcce1c… 标记 interrupted，实际等待卡变为“已中断”，群任务 7c32371a… 沿原 ID completed，MiniMax 回答 1016ARQ：50.00。随后主进程 40697 经原生菜单退出 0，再次启动仍为相同终态／更新时间，271 条任务中无活动任务；原群仅一条用户请求、一条 AP 结果，AP 私聊没有群标记。21 Bot／7 群／4 例行任务定义与两份记忆哈希不变，SQLite quick_check=ok。证据 quality-review/1016AR-queued-restart/{before,before-kill,after-first-restart,after-second-restart}.json。此验收不代替执行中外部副作用、Windows 或完整 P10。
  - [x] ~~真实 MiniMax 后台命令在主进程 SIGKILL 后对账，不盲目重放；第二次重启不重复通知。~~（1014AO／AO2）原 Node PID 98296 启动记录仅一行；主进程 94455 被 SIGKILL 后，命令 fcc37196-9097-4886-9e8c-e26d8960883b 恢复为 outcome_unknown，唯一通知 e57faa0e-42a0-44bb-b6c4-f31023ba605e completed。真实模型只核验原文件，说明结果未知，没有重跑。原子进程随后自行写出 AO_FINISHED；第二次重启仍只有一条通知与一次启动。AO2 只读核验并交付原文件，实屏打开结果确认。证据：隔离 quality-review/1014AO-real-restart 的 before／after-first／after-deadline／after-second.json。范围为 Mac 单进程；原子进程在崩溃后继续运行，应用未重新接管其控制权，此限制不能记为已解决。
  - [x] ~~空闲时从应用菜单正常退出，再次启动保留群成员、分组偏好和已交付成果，不产生重复任务。~~（1014K，2026-10-14）退出前无 queued／running／waiting_user 任务；Preview 主进程 PID 36590 以 exit 0 退出且不再存在，重启进程 PID 22893。群成员版本 7、三位成员、移出分组状态及“成员”标签保留；从群资料库再次打开 `群附件核对 1014J.md`，显示 3 行／50.75。重启前后控制库均为 43 个任务、0 个活动任务。只覆盖本次空闲退出，不替代此前退出卡住原因的排查，也不代替执行中强制终止验收。
  - [x] ~~真实 MiniMax 在文件审批中强制终止隔离应用，重启不自动批准或重放；用户继续后重新检查文件、重新审批并完成附件交付。~~（1013AR/AR2，2026-10-13—14）终止前任务 `7ba00734-c1c9-4e00-a60c-b8ac564aa915` 为 waiting_user，合成文件不存在；SIGKILL 后重启为 interrupted，文件仍不存在，旧审批不再可点击。继续任务 `034293d4-d310-44a9-af70-9c9599d603a5` 先实际读取并确认缺失，重新申请单次写入审批后完成；交付 `recovery-1013AR.txt`，18 B，内容严格为 `RECOVERY_1013AR_OK`。未覆盖正在执行的外部操作、协作和定时中断。
  - [x] ~~真实 MiniMax 在 request_user_input 等待选择时强制终止 Electron 主进程，重启后旧任务标记 interrupted，原选择卡片不再接受提交，用户新消息可依原上下文继续。~~（1013S／1013S2：Bot 与 thread ID 不变，原任务没有重放；新任务取回原三个金额并交付 50.75 和正确名称。）同时确认浏览器宿主因 IPC 断开自行退出。本次只覆盖等待输入，不能替代排队、执行中及协作／定时恢复的真实模型验收。
- [ ] P10.2 验证外部动作结果未知时不盲目重放；取消与重启不产生重复成果或重复通知。
- [ ] P10.3 检查内存、CPU、事件积压、句柄、订阅、计时器、浏览器和数据库资源释放。
  - [x] ~~1017S 当前原配置工作区生命周期及进程资源的局部验收。~~源码确认BotAvatar复用纯Grok内核，workspace及工作台入口共用一个可见性／空闲暂停时钟，最后目标移除时dispose／取消帧、断开observer并解绑pointer／scroll／resize／blur／reduced-motion监听；未增加新的清理机制。当前95730进程正式UI累计四次往返原工作台／Bots，恢复原资料核验群、80px侧栏、深色与空草稿。初始33.93秒Bots空闲累计CPU折算单核0.118%，RSS合计415824→416688KiB；三次往返后35.57秒空闲为0.112%，RSS587232→439840KiB，未持续保留切换时高点；退出Bots后的原工作台26.32秒为1.292%、RSS550064→548208KiB。所有样本为相同四个进程、无额外浏览器宿主子进程。RSS合计可能重复计共享页，工作台还含原有渲染／焦点活动，不把样本扩大为无泄漏或零CPU保证。457份任务、Bot／群／例行及178份跟踪文件与前快照完全一致，quick_check=ok，无新模型任务或生产修改。原loop可见性／空闲／dispose／60Hz及Grok状态／注视10项回归通过；这些是模拟事件与纯内核验证，未声称实际React监听器计数已测，长负载、全部动画／资源及Windows继续由父项待验。证据quality-review/1017S-ui-lifecycle-resources/{before,before-idle-1,before-idle-2,after-cycles-1,after-cycles-2,workbench-idle-1,workbench-idle-2,final-storage,review}.json；/tmp/cmb-1017S-animation-tests.log。

  - [x] ~~1016BU 原生Quit关闭后的Bot活动查询。BT结束后正常Quit进程75144，窗口关闭／before-quit的后续回调多次触发hasActiveBotRuns，Bot数据库已关闭但旧host引用仍被查询，产生真实closed错误；进程随后自行exit0，SIGTERM尝试返回“进程不存在”，没有实际强杀，不把退出延迟或错误忽略成正常无错。仅在Bot本地服务查询入口复用现有database生命周期判断，数据库关闭后返回无活动；清理未结束且数据库仍打开时继续原活动查询，不改原窗口退出流程、Host取消或公共Runtime。补充关闭中／关闭后／其他资源清理失败后的回归，再用新版真实双模型任务及原生Quit核对无closed错误、同配置重启无额外触发。~~
    - local-service.ts仅增加现有database句柄的判断；未初始化／已关闭不再查询旧Host，数据库仍打开、Host清理等待期间继续原活动查询。3项真实生命周期边界的模块回归（资源为模拟实现）及相邻共57项通过，node／lint／构建通过。新版进程84480完成BT3两模型真实创建和到期运行后，通过原生菜单Quit，exec exit0且独立ps确认消失；整份日志无Database is closed，原scheduler／heartbeat正常停止。旧日志4处closed错误保留作对照。原配置重启仍353任务，终态时间／活动／例行配置不变、0活跃，原Bot／群／文件不变，quick_check=ok；未强杀新版进程。证据quality-review/1016BU-quit-lifecycle/{before,after-quit,after-restart}.json及同轮BT证据。冷启动绘制仍需原生Zoom，单独保留，不将此退出查询修正冒称全部退出竞态／UI／Windows完成。
    - 补充原关闭行为门槛：native-close-prompt、close-to-tray及本地服务共27项回归通过，确认既有运行中确认、最小化和退出分支的契约保持；日志/tmp/cmb-1016BU-close-regression.log。不据此替代Windows真实托盘验收。
  - 1016G 最新原应用空闲采样：同一主进程树约 20 秒的 3 次 RSS 合计为 543888／541600／541632 KiB，进程 CPU 累计时间差折算约单核 0.15%。证据 `quality-review/1016G-avatar-source/idle-processes.json`。RSS 会重复统计共享页，该样本仅说明这段空闲期间未持续占用 CPU／增长，不能证明长期无泄漏或所有负载性能已通过。

### P11 — 原功能回归与打包

- [x] ~~1017BK 原工作台保护回归（针对本次主模型接续改动）。~~可信上下文仅source=bot可配置主模型观察，普通工作台／IM默认undefined，压缩与子Agent不继承；没有改共享锁、默认审批、工具执行、模型配置或checkpoint实现。提交后重跑test:workflow、test:desktop-agent-baseline、test:messages及物理执行建立／结算／worker取消／模型活动38项，全部通过。原工作台新建隔离线程：MiniMax-M2.7／Multi（ee81b19a…）和DeepSeek-v4-flash／Solo（e4818885…）各实际write、read、只读Node断言，均输出BK_NATIVE_*_OK、exit0，无工具错误；正常退出并重启后，仅凭各原线程持久上下文正确回答marker、1123与实际输出，0工具。两份原JSON独立核算一致，原Bot、群、例行、文件及旧消息头保持。本轮未新增生产代码，不能据有限样本保证所有原功能无缺陷；Windows仍待实机。
  - 扩展test:im-v1最后im-clean-cut.spec.ts失败：断言禁止全源码出现任何takeover字样，与Bot浏览器合法接管命名冲突。在独立临时目录读取改动前8dd7677e2源码运行原测试，复现同一断言；不是本次7e08e47a0引入。失败原样保留，未修改测试或生产代码绕过，不能称完整IM套件通过。日志/tmp/cmb-1017BK-original-{workflow,desktop,messages,settlement,im}-postpush.log及original-im-baseline.log，实测证据quality-review/1017BK-model-supersede/review-current.json。

- [ ] 1016AP Mac asar 打包路径验收。使用现有 electron-builder 配置与当前构建产物生成本机未签名目录包（仅覆盖测试包名／ID、输出目录及签名选项，不改生产发布配置）；在原预览正常退出后，独立启动包内程序并复用同一隔离配置。通过正式 Bots 界面与真实 MiniMax 完成本机合成浏览器操作、文件下载和成果预览，检查浏览器宿主确实由包内可执行文件启动、资源与来源说明在包内、不依赖工程目录／额外 Chromium。核对原身份、群、草稿与记忆；结束后清理本轮临时服务。此项不代替签名／公证、DMG 安装或 Windows 实机验收。
  - [x] ~~完整认证包生成、签名校验及独立启动。~~ 本机已有 Electron 39.8.10 ZIP 缓存读取 Framework 条目报 BadZipFile；默认／显式 ZIP 的失败日志保留，未据此更改生产代码。使用本机正常运行的同版本 Electron 目录，builder 生成 asar 包并 ad-hoc 签名，codesign --verify --deep --strict 通过；从 /tmp 启动，实际进入招乎认证页。包内保留 BotAvatar／BotsWorkspace 懒加载资源、bot-browser-host.js 及三份逐字节一致的来源说明。完整认证包保留在 quality-review/1016AP-packaged-mac-native-dist；正式登录后真实任务仍未验收。
  - [x] ~~临时绕过登录的独立包副本完成真实 MiniMax 浏览器／文件链路。~~ 沿用用户此前允许临时绕过登录的指示，仅在临时 staging 的已编译 application.js 关闭 open-login-page 跳转；仓库源码／out 和完整认证包保留原样。副本签名校验通过，页面真实路径为 app.asar/out/renderer/index.html；任务 0b065326-aaff-401e-8dab-d135746063bd completed／无错误，实际导航合成页、下载、读回并交付 87B 原始 JSON。成果预览及原生保存框导出通过，下载／服务端／导出字节完全一致，SHA-256 d81b26ce3d9e9d3c8a13f4bf2489e8121ec907fc1fb38cae974b715b3740510a；包内主进程18001的浏览器宿主19111使用同一包内可执行文件及 --cmb-bot-browser-host。正常 Quit exit 0 后两 PID 均不存在，合成服务已停止；临时绕过登录的包、副本 staging、失败包及解包目录均已清理，原预览已用同一配置恢复，实际显示新交付。21 Bot／7 群／4 例行配置摘要及全部记忆哈希不变，任务268→269、0活动、quick_check=ok。证据 quality-review/1016AP-mac-evidence/{before,test-copy-archive,after-task,export-and-server,after-exit,temporary-cleanup}.json；原生窗口／截图见本轮工具记录。
  - 限制保留：副本首次启动实际等待系统钥匙串，用户处理后继续；变更签名／应用凭据身份时既有 trace 密钥解密失败，trace 存储 fail closed，未绕过加密或重置密钥。原开发依赖软链接树的收集有 ELSPROBLEMS／extraneous 告警，本轮没有代替 clean CI 安装验证；目录包／ad-hoc 签名也不代替 Developer ID、公证或 DMG 安装。完整认证包尚未完成正式登录后的同题，因此父项和 P11.3 保持未勾选，不将测试副本成功推广为发布验收完成。

- [x] ~~1016AB 复用源码说明随构建保留。~~源码目录已有 Hermes MIT 原文及 Grok 头像／编辑器来源说明，但现有打包只包含 out／生产依赖／package.json，copyResources 尚未复制这些文件。沿用原资源构建插件，将三份原说明原样放入 out/resources/notices，随现有 out 打包规则进入产物；不改运行时、依赖安装或增加分发资源引擎。构建与 node 类型检查通过，三份输出分别为 1070／2049／1274 字节，均与源码逐字节及 SHA-256 一致；产物没有临时编辑器诊断。配置仅新增 10 行资源复制，未改其他格式或原有构建入口。证据 `quality-review/1016AB-build-notices/evidence.json`。本项是构建资源验收，不冒充最终签名安装包或 Windows 实机验收；来源说明不另授许可证。

- [x] ~~1016 本轮 Bots 核心回归门槛。~~ `vitest run src/main/bots src/main/ipc/bots.test.ts src/renderer/src/lib/bot-*.test.ts` 共 46 文件／340 测试通过；覆盖实际临时 SQLite 的队列、历史清理、恢复、协作与版本边界，以及文件／记忆／浏览器适配和展示推导。`test:desktop-agent-baseline`、原 `test:messages`、node/web 类型检查及构建通过，均未调用模型或更改用户数据。日志 `/tmp/cmb-1016-core-regression.log`、`/tmp/cmb-1016-original-runtime-baseline.log`。这属于本轮变更范围的回归，不等于所有原工作台业务、Windows 安装包或完整动画已验收。

- [ ] P11.1 按变更范围运行类型检查、构建、Runtime／workflow、消息／stream 和 IPC 相关回归。
  - [x] ~~1019DP 当前核心累计改动的集中回归。~~初跑57文件为683通过／1失败：DK绝对路径别名兼容后，群浏览器仍拒绝私聊文件，但错误文案由词法“不在”变成真实目录“链接超出”，旧浏览器测试只认原文案。核对实际resolveBotWorkspaceFile及上传前调用顺序后，测试改为校验BotError／INVALID_INPUT，并断言所有页面均未调用setInputFiles；另验证等价群目录别名只能上传该群真实文件、私聊页面不受影响。不为修正测试修改生产权限／错误逻辑。最终同组57文件684项、完整node／web及原test:desktop-agent-baseline通过；首次失败日志保留。此门槛覆盖当前Bots／IPC／前台移交／通知／问题工具及Bot界面派生，不能代替全库、真实Windows或全部原业务验收。证据quality-review/1019DP-core-regression/。
  - [x] ~~1016AQ 原工作台回归失败归属续核。合并 1014 两次全量日志中尚未对照确认的失败，用相同依赖、命令及单 worker 顺序，分别运行当前源码与原始 c772307228bdf0b6620fbdb54255da70fd071bc2 导出的独立源码。记录逐条结果／超时／未处理错误，不按生产文件未改就推断是存量，也不通过调宽超时或删断言制造通过；只有证据表明本次 Bot 改动引入的回退才在此项修复。定向结果不代替原完整并发门禁或其他业务实屏。~~
    - 合并得到15条未核清用例／12个文件。使用相同 Vitest 依赖、--fileParallelism=false／--maxWorkers=1，先当前、后独立原版运行，两边均145项：140 passed／5 failed、0 pending，全部145个用例键及状态一致。15条未核清用例这次全部在两边通过；五个稳定失败的名称／首条错误也相同（原 Mods runtime-authority 的路径断言及 manager 的四项文件／根目录用例）。没有修改测试断言、超时、生产代码或全局测试并发设置。证据 quality-review/1016AQ-regression-comparison/{manifest,current,baseline,comparison}.json 及相邻日志。此轮未观察到这15条的稳定新增回退；旧全量并发中的超时／MODS_GUEST_ERROR 根因仍不能仅凭顺序通过归因为资源争用，原完整门禁及其他功能范围继续保持未完成。
  - 2026-10-14 全量门禁：`npm test` 的 Vitest 阶段为 4,514 passed／58 failed，后续串联组没有执行，不能报告全量通过。已在独立临时目录从当前分支 HEAD 原文件运行同一 25 个失败文件：41 项相同失败在原代码中也存在。Bot 接线后遗漏的 composer fixture、删除服务提取后的测试定位已修正，并补充 Bot 仍保留原决策／只读／历史加载守卫的断言；Bot 两个状态颜色改用工作区样式变量。相关 Runtime、composer、主题、删除契约共 65 项通过。剩余五项仅在当前全量并发运行中失败的 Mods／大目录事件循环用例，其生产文件与 HEAD 字节相同，正在单独复核；不据此认定全部失败均为基线问题。日志 `/tmp/cmb-bot-background-full-regression.log`、`/tmp/cmb-bot-beta-head-regression.log`、`/tmp/cmb-bot-regression-contract-final.log`。
    - 上述五项已在当前源码定向复验通过；同组 39 项中 35 passed、4 failed，四项 `MODS_FS_ROOT_CHANGED`／文件面板失败均在 HEAD 对照中也出现。日志 `/tmp/cmb-bot-regression-extra-current.log`。此结果区分了当前新增的测试接线缺口、原分支失败及全量并发时出现的失败；未把它改写为完整生产验收通过。原消息／stream 回归再次通过。
- [ ] P11.2 原普通会话、项目模式、技能、自动化、IM、记忆与浏览器无行为回退。
  - [x] ~~1016BV 冷启动绘制与测试启动参数对照。此前预览长期携带--force-renderer-accessibility，出现控件树／截图延迟更新、原生Zoom后恢复的现场；现先正常Quit且确认旧PID结束，再以同一包、同一配置、同一构建去掉这一测试参数做一次对照。只通过CUA读取／点击原工作台与Bots入口，核对首屏、会话切换和输入；保留原任务／草稿／模型设置，不新增生产侧窗口缩放、禁用节流或重试计时器。若问题仍在，记录客观结果继续定位；不能未证明就归因于电脑、renderer或该参数。~~
    - 此子项仅表示一次参数对照完成，绘制／捕获根因尚未解决。旧94826正常Quit exit0且PID消失、日志无closed错误后，同包同配置去掉该参数启动：首个AX只有原生外框，捕获图为原工作台历史加载；点击Bots后捕获画面仍旧，原生Window激活后按钮已着色但图像未刷新。Zoom后直接显示已切入的Bots与已置顶同事，说明此前至少部分输入已到页面，不能据旧截图认定JS卡死或按钮无接线。此后切回MiniMax、输入并清除本轮未发送合成草稿均可用；80px头像栏、详情关闭、空输入保留，353任务／0活跃、原配置／文件不变。没有新增模型任务或生产改动；去掉参数没有消除该样本，无法确认实际桌面绘制与CUA捕获各自责任，P11总门槛继续保留。证据quality-review/1016BV-startup-flag/{before,after}.json及本轮原生截图，/tmp/cmb-original-preview-1016BV.log。
  - 2026-10-14 原 renderer 回归基线补证：`workspace-file-load.test.ts`、`features/mentions/atFileAttachments.test.ts`、`harness-plugin-run-artifacts-isolation.test.ts` 在当前工作区与干净基线 `c772307228bdf0b6620fbdb54255da70fd071bc2` 使用相同命令各得 3 failed / 23 passed，失败断言相同。证据 `/tmp/cmb-bot-original-ui-current.log` 与 `/tmp/cmb-bot-original-ui-baseline.log`。已为两个 Windows 路径用例补上明确的平台模拟和销毁清理，将过时的授权分支断言改为当前实际“外部路径 → 取得授权 → 无授权拒绝 → 受控 reveal”的顺序检查；原生产行为未改。三个文件复测 26/26 通过，日志 `/tmp/cmb-bot-original-ui-test-repair.log`。仅这三项得到本轮基线确认，不把完整测试中的其余失败自动归为既有问题，也不据此勾选原功能无回退。
  - 2026-10-14 后续全量复跑：Vitest 4,522 passed／51 failed／20 skipped，另有 2 个未处理错误，后续串联检查仍未在该命令中执行。独立 workflow、消息及类型检查通过不替代此门禁。原 HEAD 对照确认的 41 项失败沿用之前证据；另外 10 项仍需单独对照，不因文件与 HEAD 相同就认定为基线问题。日志 `/tmp/cmb-bot-background-handoff-full-regression.log`。
- [ ] 1017F 跨平台Bot门禁接线。当前已跟踪CI只执行原lint／typecheck和平台构建，未调用已有Bot核心回归与tests/bot-native-browser-host.spec.ts；Windows发布工作流已使用Node22、原electron-builder和Electron39.8.10，Bot通过bootstrap的专用参数复用当前安装的Electron，不依赖额外Chromium／Python／容器。新增独立macOS／Windows Bot验证job，复用.nvmrc及已有SQLite／Runtime适配／消息派生测试、现有隔离浏览器宿主集成测试，不改原job／发布／认证流程。集成构建的CMB_BOTS_E2E仅限该独立临时job，不上传或打包测试产物。测试路径使用Vitest稳定子串过滤，避免Windows默认shell不展开bot-*.test.ts而漏掉界面派生回归。先在本地对照同一409项，再校验工作流结构；未在真实runner执行前不声称Windows或CI已通过，也不据未引用的.gitignore旧版.github/actions文件判定一期依赖Rust／其他native分发体系。

  - [x] ~~独立CI任务与本地运行时对照。~~仅在已跟踪的.github/workflows/ci.yml追加32行Bot job，macOS／Windows矩阵、Node版本读取.nvmrc=22，复用原npm ci／Vitest／隔离浏览器宿主脚本。YAML解析及结构断言确认旧lint-and-typecheck／build两个job、on触发及contents:read权限逐项未变，无额外下载Chromium／打包／上传测试产物的步骤，CMB_BOTS_E2E只作用于本job的fixture构建。便携测试命令在本机Node24.13.0通过51文件／409项；再以应用自带Electron39.8.10的Node22.22.1／SQLite3.51.2、ELECTRON_RUN_AS_NODE执行相同命令，也为51／409，两个完整文件及测试数清单逐项相同。该Node模式未打开原生窗口，不能替代跨OS原生测试；普通当前构建确认不存在bots-browser-e2e.js。新工作流Prettier、diff检查通过，未提交／推送或触发远端作业。证据quality-review/1017F-cross-platform-ci/configuration-review.json及/tmp/cmb-1017F-{ci-filter-tests,node22-tests,ci-format}.log。真实GitHub runner、安装包及Windows接管／输入／退出继续待验，1017F／P11.3父项不勾选。

- [ ] P11.3 Mac、Windows 安装包能用自带 Electron 引擎启动 Bot 浏览器，不需要另装 Chromium／Python／Docker／WSL。
  - 1017AQ触发条件复核：当前已推送的CI仍仅监听main分支push及面向main的PR，没有workflow_dispatch。因此devclaw-bot-beta的阶段push本身不会触发该工作流，不能将最近推送记作Windows／Mac runner通过。仅核对当前已跟踪源码，未修改触发条件、创建PR或声称取得远端运行结果；后续提交／push仍等用户通知。证据quality-review/1017AQ-json-preview/ci-trigger-review.json。
- [ ] P11.4 检查构建发布配置、许可证、敏感信息、实际改动行数与既有文件改动理由。
  - [x] ~~1016AZ 类型检查阻断清理。~~用户确认没有主动恢复旧代码。原完整web报bot-ipc-result引用缺失bot-types，node另报skill-catalog-entry引用缺失skill-catalog-reader；当前src／tests／scripts／构建入口均无入站引用，两文件也不存在于当前HEAD。两份原始字节／SHA及索引对象已逐项备份核对，仅移出这两份无效新增文件与对应索引；其余三份额外文件保留，没有新建旧版类型或修改tsconfig。未经任何排除的原npm run typecheck:web和typecheck:node均exit0。文件来源仍未确认，不将iCloud推测当作事实。证据quality-review/1016AZ-unreferenced-files/manifest.json；未commit。

### P12 — 真实任务与最终验收

- [x] ~~1017AO 官方既有浏览器交付基准补证。只读打开“浏览器交付对照”的form-result.json，逐一展开真实JSON，并经原下载入口保存到本轮隔离证据目录核对字节、字段和三笔数据；不重新运行模型、云端服务或用户文件任务。保留该Bot未发送的huan草稿，结束回到原合成对照／详情页。原报告未见JS alert的限制继续保留，不把可打开回执扩大为全部浏览器步骤通过。~~
  - 官方0.71.2原成果成功打开交互JSON树，逐笔展开r1=18.25／r2=7.50／r3=25.00、declared=52.75、name=青鹭中文验收、filename=sample.json、accepted=true。经原生保存框导出341B，SHA944ef20f…，实际JSON与预览逐字段一致；未运行模型或服务。独立合计50.75与声明差2.00，原题只要求报告声明值，不能把该差异说成Grok算错；原alert未观察到仍保留未通过。该Bot的huan草稿完整保留，已回到原合成对照／详情及空草稿。AX的数组展开一次报offscreen，按实际原尺寸截图点击后正常，不改官方应用。证据quality-review/1017AO-grok-file-baseline/{before,file-review,review}.json及原始导出文件。只补本机当前可读的官方交付基准，不替代云端工具执行取证、所有浏览器或CMB整体对齐。

- [x] ~~1017AD 当前MiniMax六文件同题首轮与修订对照。~~MiniMax-M2.7已在1017AC恢复，沿用1016AU原任务（prompt SHA b54e8d…）和未改oracle.mjs（553b6a59…），分别使用全新MiniMax Bot工作区与新原CMB thread／空目录；相同模型配置、原Runtime默认Multi能力，不改模型温度／工具／审批或用户任务，不提供验收脚本和首轮反馈，不人工修改交付代码。各首轮结束先保存全部六文件原件／SHA、真实调用及自测，再运行同一Node的38项独立验收与CLI别名检查；已有Grok／DeepSeek首轮原件只作为历史参考并注明采样时间，不冒充本轮新Grok执行。先比较首轮，再按相同失败事实反馈另记修订，不能用后续修好覆盖初始质量差距。原Bot／群／记忆／例行及用户草稿保持。此题不替代完整长程、跨平台、全部任务类型或整体Grok体验验收。

- 1014Q 原工作台基线已在原线程显式续跑：沿用最初完整需求及现场文件，没有向模型提供独立验收器的具体失败提示。续跑再次申请 CLI 编辑及测试命令的单次审批；仍未最终交付。升级前快照保留，本轮最终结果须注明经过应用升级中断／继续，不能与 Grok 的首次无中断结果混为同一次首轮表现。

  - [x] 1017AD MiniMax Bot首轮已冻结：同一1269字符任务、空职责新Bot，六份原件均由正式成果卡交付。模型自测先42/44，自行修复stdin/stdout参数后44/44；无验收反馈或人工改码。独立原38项验收为37/38（普通模式遇不安全单条金额直接抛错），另在/tmp别名启动CLI退出0但stdout为空；均保留未通过。原CMB同模型Multi／空目录同题正在执行，尚不判定相对质量或整体对齐。证据quality-review/1017AD-current-minimax-ledger/{bot-first-finished,bot-first-manifest,bot-first-oracle,bot-first-alias,bot-first-review}.json及bot-first六文件。

  - [x] 1017AD 原CMB同模型首轮已冻结：新thread dba18096…／独立空目录，初始用户任务逐字核对（仅去外层空白）一致，Multi／原模型配置未改。原线程自行修订后自测38/38，独立原38项为35/38（null行处理两项、非strict单条不安全金额）；/tmp CLI别名能正常输出，附加同组边界中导入副作用、未知位置参数及rename失败临时目录清理未通过。Bot对应三项附加检查通过，但原37/38及别名失败不抹去。全部首轮原件／哈希及回执已保留，未人工改码；向原线程反馈五类实际失败进行修订，尚不视为整体交付达标。证据同目录native-first六文件、native-first-{finished,manifest,oracle,alias}.json、first-extra-edge-cases.json、first-comparison.json；既有Grok／DeepSeek38/38为历史样本，本轮未重新执行官方任务。

  - [x] ~~1017AD 原thread两次事实反馈后的修订交付验证。~~首次反馈后自测45/45，原38项及三项附加边界通过，但入口修改引入/tmp别名回归；native-revised六文件及失败回执原样保留。第二次仅反馈路径实际回归后，模型自行规范真实路径身份；native-final六文件／SHA已冻结，自测45/45，独立原38项及四项附加检查（两种路径、导入无副作用、未知位置参数、rename失败清理）全部通过，验收前后源哈希一致。无人工改码，首轮35/38保持独立；原thread最终用目录清单交付，Bot正式成果卡入口仍另验。本项仅确认该合成项目修订结果。证据同目录native-{revised,final}、native-final-{finished,manifest,oracle,validation}.json及两次反馈txt。

  - [x] ~~1017AD Bot修订程序及交付说明／README一致性。~~一次事实反馈后Bot自测47/47，独立原38项及四项附加边界全部通过；修订中一次诊断命令报SyntaxError和旧自测用例问题均保留，未人工修码。六份正式成果原件已冻结。末次答复两个代码示例漏date、README与实际sample不符均继续处理：Bot实际执行一次补全日期并纠正说明；两边再各实际运行CLI更新README，独立核对完整accepted／errors／total／byDate与原sample完全相同（Bot8／4700.99、原thread5／1414.99），其余五文件SHA保持已验收版本。原不符文档与两次代码修订原件保留。原505任务／32Bot／群／例行／21命令及181份旧跟踪文件均保持，现512任务／0活跃、33Bot，quick_check=ok；本轮无生产代码修改。证据同目录review.json、readme-sample-{before,after}.json、bot-readme-corrected.md、native-readme-corrected.md及实际任务捕获。仅完成本题比较，首轮差距、其他任务、Windows与整体UI／动画仍按D07—D10／P12待验。

- [ ] P12.1 真实 MiniMax 验证持续聊天、长期记忆、补充要求、停止继续和等待审批。
- [ ] P12.2 长程编程任务对照原 CmbCowork 与 Grok，按需求覆盖、可构建性、测试和文件完整性验收。
  - 1018BT补充质量反例（非长程编程替代样本）：MM首轮后台脚本将单agent拆为顺序三个，错误把br_total结果用于判断browserDiscoveryEmpty、把字符串延迟结果当对象读output，交付八字段中两项错误。明确反馈后按真实记录生成修订文件8/8；修订说明又误称并行，最终反馈后已更正为顺序await。新单agent轮虽结构正确，structured_output仍把真实命令输出BT_SINGLE_MM_DONE错配成连接器marker BR_LEDGER_TOTAL；原工具回执完整、正确，父通知模型已指出错误却仍交付未修正文件。再次反馈后只读该次真实toolstream、写新JSON并重新交付，八字段8/8，原件保留。DS同类首轮一个agent、八字段8/8。此证据支持已有结果映射与自主修复质量缺口，不能因Runtime复用、通知正确或修订成功而宣布已对齐Grok；未做本题原工作台同题／官方Grok同题，也不单凭该题排除harness约束改进的空间。依用户“先核心、UI／动画，再交付质量”的顺序保留本项，未为合成字段增加生产特判或改原通用提示词。
  - [x] ~~1017T 原CmbCowork thread的DeepSeek同题基准。~~正式新建原线程d0fc40c4…，原生目录选择绑定全新空目录1017T-native-deepseek-workspace，选择现有custom:deepseek-v4-flash、UI Multi；用户消息与1016AU原始需求仅忽略首尾空白后逐字一致，没有oracle／失败反馈或代改代码。原线程从首条用户持久时间到末条助手end_at约50.815秒，6次write_file／2次edit_file（均README）、4次execute、一次ls及两次write_todos；实际自测先26/26，CLI读回accepted4／total7.01后自行修正README两处示例，最终仍26/26，工具无错误。交付六份真实文件链接，已实际打开ledger.mjs源码；保存六份首轮原件和逐份SHA，独立验收及/tmp别名CLI读取0.10后仍与源文件逐字节一致。未改原oracle（SHA553b6a59…），同一Node24.13.0重跑本次原thread首轮、既有DeepSeek Bot首轮原件和Grok首轮原件均38/38。本题补齐同模型底座基准，不据单样本判定整体harness／质量均无差异，也不抹去MiniMax首轮34/38／31/38及此前长题失败。交付后截图中输入已恢复空闲，而AX占位仍为任务运行中，二者不一致、原因未定，未凭此改公共Runtime；BV／无障碍观测继续保留。恢复原Bot群及空草稿，457份Bot任务、全部Bot／群／例行、178份跟踪文件与前快照完全一致，quick_check=ok，仅新增该原线程与测试工作区，未改生产代码或用户草稿。英语进度及非同时模型采样差异保留，MiniMax／Windows／完整P12仍未完成。证据quality-review/1017T-native-deepseek-ledger/{prompt.txt,started,during,delivered,first-manifest,native-oracle-first,bot-oracle-rerun,grok-oracle-rerun,alias-checks,comparison,final-bot-storage}.json及native-deepseek-first六份原件（prompt为txt，其余对应JSON）。

  - [x] ~~1016BA DeepSeek V4 同题首轮测量与本题独立验收。~~按用户要求经正式界面新建7499cbed…／thread908b4744…，单独绑定已有custom:deepseek-v4-flash，运行时日志解析为deepseek-v4-flash；未改其他Bot模型。新建时默认模型的问候发生在绑定前，首个编程任务3f3ee319…使用DeepSeek，用户需求与MiniMax／Grok同题逐字一致，未提供独立失败反馈。约70.7秒交付六份原文件，实际自测先24/26，自行修正测试预期及相关代码后26/26；保留首轮原件再用未修改的38项独立验收器、同一Node24及规范路径复测38/38，另核实/tmp路径别名可输出0.10报告。未保存该Bot记忆，既有两份记忆哈希保持。Grok同题38/38、MiniMax Bot首轮34/38、原thread首轮31/38；本题通过不表示整体任务质量、核心功能／UI动画或Windows已全部对齐。DeepSeek临时文件使用输出父目录中的临时子目录，与直接同目录文件布局有差异，但共享原子写／清理检查无失败；不把该布局差异擅自判作功能缺陷。证据quality-review/1016BA-deepseek-ledger/{started,delivered,deepseek-oracle-first,alias-verification}.json。
  - [ ] 1016AU 六文件收支核验工具首轮对照。全新 MiniMax Bot 与官方 Grok 接收同一份固定需求，覆盖精确金额、真实日期、去重、严格模式、CLI 参数／stdin、失败保留原文件及原子替换；六份原文件、实际自测和示例运行均须交付。独立验收器先按需求写好再读取产物，不替模型补代码；区分首轮、自行修复及收到反馈后的结果。沿用原 Runtime／审批与文件交付，不因本题临时扩大 harness；不以新题通过抹去 1014Q／1015 长程首轮差距。
    - 首轮对照完成但质量未达标：原预览新Bot交付六份真实附件，MiniMax-M2.7任务33aaf658…completed，报告48项自测通过；官方Grok交付六份原文件，报告10项自测通过。全部原件保存后，用相同Node24／同一独立验收器、规范/private/tmp路径测试：MiniMax34/38，Grok38/38。MiniMax在null对象／实际行号、非法金额类型及超范围单条金额处理上失败；此前认定临时文件处于兄弟目录的源码复核结论有误，已撤回：原dir包含末尾斜杠，basename输出也只生成当前目录相对文件名，均满足同目录；不计为缺陷或修复收益。首轮期间MiniMax自行修订CLI参数、短横线、测试预期及strict输出保护，没有收到独立验收反馈；原代码／失败均保留。两次后续只读UI核验未改六份文件。证据quality-review/1016AU-ledger/{prompt.txt,oracle.mjs,comparison.json}及两份first目录，不把completed或自测数量当作交付质量达标。
    - [ ] 1016AX 收到独立验收反馈后的修订。先保留双方首轮六份原件，再将不符合原需求的边界与临时文件目录问题反馈给原 MiniMax Bot，由其独立修复、补测试并重新交付全部六份。使用原独立验收器，不直接给实现代码、不替模型修改产物；修订后通过也不撤销首轮34/38与Grok38/38的差距记录。反馈第4项的临时目录判断随后确认有误，已单独更正并保留原始记录，不作为模型修复能力证据；其余真实失败项继续验收。第一次修订任务13741ca6…completed，约460秒，再次交付六份原件；原验收器37/38，仍错误接受字符串1.。第二次修订99aec5b0…completed，约89秒，规范路径38/38；但/tmp路径别名重新变成退出0却空输出，故不能按38/38判为全面修复，继续用同一真实反例复验。第三次修订47198d95…completed，约370.5秒，六份原件保留，原38项、真实/tmp路径输入0.10报告及Node-e导入只输出IMPORT_OK均通过。该轮模型曾在/tmp创建并删除调试脚本，违反本次不改目录外文件的明确要求，不能宣称完全遵循约束；未为该题改harness或代改产物，首轮差距仍保留。路径别名CLI已独立运行返回正确0.10报告。2026-10-16按原件纠正：未定义Bun及按文件名猜入口的分支在第一次修订minimax-revised中，第三次交付已使用realpath入口判断，没有这些分支；不能继续把旧中间版本的问题归到最终交付。当前六份文件、第三次快照与交付回执的SHA逐项相同，未改原验收器重新运行仍38/38，已有/tmp别名及IMPORT_OK实测保持。本题功能修订已达该38项标准；首轮差距和第三轮越界创建／删除脚本的约束违反仍保留，AX与P12整体质量不据此认定完全达标。证据revision-entry-review-correction.json及minimax-oracle-revised-3-audit.json。
    - [x] ~~1016AY 原 CmbCowork thread 同题首轮测量。~~原工作台经原生目录选择器使用独立native-workspace，新建线程cfe524bf…，normal／Multi、同一custom:minimax-m2-5配置（界面MiniMax-M2.7），用户消息与Bot首轮逐字一致；原需求文件仅多末尾换行。未给任何独立反馈，原线程自行修复后报告39/39自测并交付六份链接，界面发送恢复空闲。保留六份首轮原件，经原独立验收器31/38：和Bot首轮一样存在null对象、空行行号、1.金额及单条超范围金额问题，另有三类重复CLI参数未拒绝。Bot首轮34/38、Grok首轮38/38；本题未观察到Bot低于原thread，但不能凭单样本宣布总体无退化、优于原版或归因为纯模型／纯harness。此前任务首轮差距仍保留。证据quality-review/1016AU-ledger/{native-started,native-delivered,native-oracle-canonical-first,three-way-comparison}.json，D07／P12.2继续未完成。
    - 验收工具边界：初次/tmp别名调用使MiniMax的main入口字符串比较跳过CLI，原失败保留，规范路径结果与此路径兼容性问题分开记录。独立验收器已显式指定TAP，修正Node24默认reporter造成的自测输出识别误判；未改变功能断言或模型原文件。Grok源码和附件通过UI原生保存取得；未获得其云端执行日志，不把模型声称的首次自测当作独立日志证明。本题差距仍待处理，父项未勾选。
  - 1014Q 原工作台接受失败反馈后仍未交付：快照 `quality-review/1014Q-native-after-feedback-incomplete/` 经同一独立验收器得 44/47，剩余 stdin 读取结果错误、输出未原子替换、54 个声明测试只报告 1 项。重复参数已修复。已在下一条 stdin 诊断命令审批前从界面停止，原文件及失败结果保留；尚未发送技术根因提示，也未由验收人员改写生成文件。不能把本轮或其停止状态记为验收通过。
  - 1014Q 故障归属核对：原线程 checkpoint 的真实 ToolMessage 完整保留了多次 `tests 1 / pass 1 / fail 0`，以及 `--input requires a value` 和非零退出回执；随后模型回复也明确讨论了这些结果。当前没有输出丢失或命令被错误执行的证据。中间产物的测试直接调用含 `process.exit()` 的 CLI `main()`，导致测试进程提前结束；CLI 的参数校验拒绝 `-`，反馈后第一次修改仍返回 `!arg.startsWith('-')`，注释与实现不符。故已证实的直接问题是模型产物及诊断；原完成性门禁检查协议与待办，不能证明测试覆盖或代码正确。收据摘录在隔离目录 `quality-review/1014Q-harness-receipts.json`；不能据此推断所有任务质量差异均由模型造成，反馈修复仍在进行。
  - 1014Q 原工作台继续验收：升级后原线程续跑仍反复切换测试过滤条件，未完成交付。中间文件使用同一 47 项独立验收器得 43/47，失败为 stdin 参数、stdin 原子替换调用、重复 --strict、54 项声明测试实际仅报告 1 项。已保存 `quality-review/1014Q-native-before-feedback/` 原文件及结果，再从正式界面停止重复诊断并提交具体失败反馈；后续成绩只能记为反馈修复，不能与 Grok 首轮或 Bot 首轮混记。未由验收人员修改生成代码。
  - [x] ~~1014Q2 按独立验收失败反馈修复三项需求，补测并交付四份可打开／保存的原文件。~~ MiniMax 任务 `0b871b53-f522-49e5-bcaa-cbb9aacc2002` completed，实际自测 45/45；修订原文件快照 `quality-review/1014Q-bot-revised/` 经同一 47 项独立验收器复测 47/47，结果 `/tmp/cmb-bot-1014Q2-oracle.json`。Mac 正式界面出现 log-summary.mjs、cli.mjs、log-summary.test.mjs、README.md 四张带打开／保存入口的成果卡片，README 标准调用仍为直接 `node cli.mjs --input ... --output ...`。修订期间漏掉 readFileSync 导入导致再次自测失败，模型诊断后自行补回并重跑；该失败仍保留。此项证明本题反馈修复与附件交付成功，首次 44/47 不改写，原会话本题基线及更大项目验收仍未完成。
  - 本题原工作台基线已从正式界面启动：同一 MiniMax-M2.7、Solo 模式、空白线程 `6a8e847f-1917-4ae7-9eab-7f9eb9ccc638`，工作区为 `/tmp/cmb-bots-phase1-preview/quality-review/1014Q-native-workspace`，提交与 Bot／Grok 相同的原始需求；数据库进一步确认原线程与 Bot 线程均为 model=custom:minimax-m2-5、agentMode=normal。新版发送恢复接口需要冷启动主进程，已通过原生 Quit 中断该未完成基线；升级前四份原文件完整保存在 `quality-review/1014Q-native-before-upgrade/`，并标注 unfinished。此前模型反复诊断自测只报告 1 项的问题，未获得最终交付；不计为基线通过，待原线程继续完成后再比较。
  - 1014Q 首轮已完成：向全新 MiniMax Bot 与官方 Grok 提交完全相同的四文件 NDJSON 工具需求，不额外要求其中一方使用工作流。双方原文件保存后，在迁移目录使用同一份 47 项独立验收器：Grok 47/47，MiniMax 44/47。MiniMax 实际自测 42/42，却遗漏严格模式立即停止、同目录临时文件原子替换、有效输入时重复 --strict 拒绝三项原始要求；先前 tmpdir 导入、CLI 参数及测试自身错误的多轮修复也保留。已通过正式界面提交 1014Q2 三项反馈，要求修复、补真实边界测试并通过交付工具返回四个文件，修订后独立验收为 47/47（见本项子记录）。首次输出为 Markdown 文件链接表，未调用 bot_deliver_files，不能称附件使用方式已一致。证据位于隔离测试目录的 `quality-review/1014Q-grok-first/`、`quality-review/1014Q-bot-first/`、`quality-review/1014Q-oracle.mjs` 及 `/tmp/cmb-{grok,bot}-1014Q-oracle.json`。验收器的重复参数用例改用有效输入，避免被 strict 输入错误掩盖；两方已用修正后的同一用例重跑。原 CmbCowork 本题基线已启动但尚未交付，不能把模型编码错误直接归因于 Bot 适配。
- [ ] P12.3 浏览器研究、表单、登录、文件上传下载等场景完成真实操作验收。
  - [x] ~~1018CL 双模型完整上传／下载／原件交付续验。~~对照Grok已有文件原样传递／SendMessage交付约定，复用1016AM合成表单、原附件导入及当前正常包的Bot浏览器／交付工具，无新增产品代码。正式原生选择器分别导入不同的中文空格名CSV；DeepSeek 957c49bf…与MiniMax de4c555f…各一次navigate／fill／upload／提交click／dialog确认／下载click／read_file／close／bot_deliver_files，9次调用全有成功回执，未纠偏或重试。不同的精确pageId、服务端各一次POST／一次下载，实际上传文本与输入原件逐字节相同；各618B的已交付回执与服务器下载字节／SHA一致，实际预览展开三行后金额与33.12／15.73 CNY总额均正确，Escape回原成果按钮。47项核对通过；原857任务／4946消息头、38Bot／10群／9例行／27命令及258份旧文件保持，仅新增两任务、两输入副本和两回执，最终859任务／0活跃，两库quick_check通过。原39字符草稿、用户BW-DS会话和298px侧栏恢复；合成服务主动Ctrl-C退出130，进程已消失。路径选择器初次paste未生效，改用原生setValue后确认目录及选中文件，没有重复发送；保留工具观测边界，不据此改生产逻辑。证据quality-review/1018CL-browser-transfer/{before,task-windows,after-models,final,review,restore-ui}.json、verify.py及真实原件／预览截图；无commit／push。本项仅覆盖Mac本机合成整链，不替代官方云端同题、企业网站、Windows或完整UI／动画。
- [ ] P12.4 群聊分工、跨 Bot 交办、忙时收件、定时任务与重启恢复完成端到端验收。
  - [x] ~~1018CN 当前官方版本的忙时回复与自动交付同题。~~官方0.71.2新建独立“持续执行对照-1018CN”，与当前正常包MiniMax／DeepSeek提交逐字相同的90秒程序需求和后续计算问题，不要求用户切模式。三者都先回答71；本地独立采样确认原PID1088／3067在追加前存活、结果文件不存在，回答结束早于原程序完成，两程序分别90.018／90.019秒正常结束。各只启动一次原execute后台命令，无轮询／重启；各唯一canonical通知自动read_file两次及bot_deliver_files一次，两份原件均实际打开、PID／startedAt相同且value=31.42，无需用户催办。
    - 官方在357.6秒观察窗口中仍只有忙时回复、没有附件控件；约402秒后单独追加只读交付请求，才收到81B／124B两份原件。两份均通过原生预览及保存取得，PID10964／startedAt一致，完成间隔90.032秒、value正确。保留“未自动交付”和“追加请求后交付”两个阶段，不能把后者冒充自动通过；未取得云端进程／工具日志，不断言云端启动次数、底层根因或产品总体优劣。官方为新上下文、本地为既有历史，客户端与云端消息时钟也有偏差，只比较对应任务顺序与文件内时长。
    - 47项核对通过，本轮生产源码及正常构建SHA未变；原861任务／4990消息头、38Bot／10群／9例行／27旧命令／262旧文件均保持，仅新增6条本轮任务、2条已完成命令及5份工作区文件，最终867任务／0活跃。两库quick_check通过；mask原39字符草稿、用户BW-DS会话／298px栏及官方Tibo详情已恢复，未改Tibo任务。证据quality-review/1018CN-busy-current-grok/{before,task-windows,local-first-start,local-ds-before-follow,local-results,local-final,final,grok-results,review,restore-ui}.json、verify.py及三方原件／AX；原附件观察的宽泛正则误匹配用户题目，已保留旧指标并改为统计实际附件按钮，未改原现场。无commit／push；本项仅为Mac持续执行同题，不替代复杂长程编程质量、Windows或全部UI／动画。
  - [x] ~~1017A 当前构建的Mac双模型忙时收件、原生命令回传与移交后停止。~~复核Grok send-turn-dispatch的用户轮次替换和Hermes interrupt_control的steer／yield区分，沿用原LocalSandbox进程、Host命令回执及现有BS合成Bot，不改生产代码或增加workflow／team用户模式。MiniMax原任务fe5c4e5a…与DeepSeek原任务c4bddaca…各启动一次180秒前台Node命令；实际PID84502／87345运行时发送新问题，原工具回执明确移交同一进程，新问题f8571f45…／fb6e900e…分别在实际命令结束前23.453／91.220秒回答25。启动记录各仅一行，最终PID与原PID相同，无重启或模型轮询；结束后各恰好一条command通知4d0811d7…／072fe408…，实际read/read/deliver，两份结果JSON和两份启动记录均在正式预览打开，token和时间／PID一致。
    - 停止分别实测：MiniMax移交后从正式输入框点击停止，PID95129消失，39d0c0bb…回执cancelled／suppressed=1、零完成通知；当时DeepSeek另一进程仍活着，未被跨Bot停止。DeepSeek首轮操作晚于自然结束，e16cb7ce…实际completed且正常交付，保留为验收时序失误，不能算停止通过。新文件DS-stop2重测：实际PID4368移交后回复25，点击停止后消失，d10231e3…回执cancelled／suppressed=1、零完成通知。超过两轮原定180秒结束时刻再次核对，均未生成结果文件、未自行恢复；该部分不是只验证按钮消失。
    - 正常Quit确认67187已退出，以同配置启动16311；398任务／0活跃，本轮13条任务终态／更新时间和5份命令回执完全不变，无重复执行或通知。五份启动记录SHA及对应结果JSON／不存在状态与重启前相同，原27个Bot、群／例行配置及134份跟踪旧文件不变，quick_check=ok。旧进程日志Database is closed、Controller is already closed及UnhandledPromiseRejection计数均0。证据quality-review/1017A-busy-receipts/{during-processes,normal-delivered,before-mm-stop,after-mm-stop,ds-stop-late,before-ds-stop2,after-ds-stop2,process-review,before-restart,after-restart,review}.json。采集按任务终态时间截断，并按通知时间窗读取隐藏的内部轮次，未将后续通知交付误计入早先的快速回答。
    - 交付差异仍保留：DeepSeek首轮进度夹英文，首次快速回答在只要结果时附加了状态说明；STOP2轮只回答25。重启后的电脑工具先只读到窗口外框，原生Window→Zoom后读到工作台并重新进入Bots，原BV观测／冷启动问题未由本轮解决。此次验证支持已有官方1014V5/V6所见“新问题先答、原命令继续、结束交付”的核心流程，不是新一次官方同题或完整Grok对齐结论。任意复杂子进程树、执行中强制终止恢复、Windows及全部忙时交互仍由P03／P10／P11父项继续验收。
  - [x] ~~1014Z：原生后台命令等待期间回应新消息，随后主动核验并交付原文件。~~ MiniMax-M2.7，默认新 Bot；10:19:41 接受命令，10:20:58 已回答第二问 25，10:22:41 命令才结束。原文件 LONG_Z_FINISHED 为 15 B，成果卡片打开核对通过。证据 `quality-review/1014Z-native-background/`。该轮内部通知误显示为用户消息，已保留问题并在 1014AA 复验修正。
  - [x] ~~1014AA：后台结果作为内部通知处理，主动交付且不继承旧模型流式回调。~~ 45 秒命令结束后，自动核验并交付 11 B 的 AA_FINISHED；界面没有新增内部 JSON 消息，当前运行日志没有 Controller already closed 错误。沿用原 Runtime 内部消息投影、provider occurrence 边界和原模型调用上下文隔离方式。证据 `quality-review/1014AA-native-notice/`。本次没有重复忙时第二问，忙时证据引用 1014Z。
  - [x] ~~1014AB：显式停止结束本会话已启动的原生后台进程，不自动续跑。~~ 命令运行后在正式界面点击停止，进程 39375 已退出；回执 cancelled、suppressed=1，零完成通知，目标文件不存在。证据 `quality-review/1014AB-native-stop/`。停止后侧栏仍显示历史“已启动”，已补状态文字，待新版 UI 复核；Windows 进程树实机验收另列，未由 Mac 结果代替。
  - 以下 workflow 长命令方案属于历史尝试；已由上述原生后台执行接线替换，不作为当前普通命令执行方案。
  - 1014X 真实失败记录：官方 UI 发送合成 180 秒任务后，后台 shell 命令被启动前正确拒绝，但 MiniMax 生成的 workflow `wf_13a171adc35b` 使用不存在的 `exec()`，实际失败（0 个子代理）；随后错误声称程序已启动并调用同步 task 检查 PID。证明启动约束没有使完整行为自动达标。自动工作流说明现补充可解析的单 agent 脚本及参数传递示例，明确命令由 agent 原工具执行；新版真实恢复／忙时响应仍需验证，未勾选完成。
  - 2026-10-14 停止范围补齐：私聊停止除取消当前／排队收件外，复用原 workflow 与 coordinator 管理器取消该线程已接收的后台任务；其他 Bot 和群线程不受影响，取消通知不会自动唤醒续跑。输入区复用原线程摘要显示后台停止入口。工作流启动增加前台取消信号检查，覆盖等待审批／异步准备后才发起后台任务的竞态。Host、Runtime adapter 与能力边界 79 项测试通过；原 workflow 回归通过（engine 97 项，含三个取消时点），node/web 类型检查通过。真实界面停止与进程退出仍待验收，不能将取消请求已发出写成已确认进程清理完成。
  - [x] ~~1014W：默认新 Bot 在没有输入附件的情况下，完成一次 180 秒命令并交付生成文件。~~ 真实 MiniMax 任务 `15b48466-d367-404d-ba93-6c48d633ffed` completed，正式成果卡片及打开后的预览均显示 `busy-turn-1014W.txt`／`LONG_W_FINISHED`；独立读取确认 15 B，所报 PID 63951 已退出。保留首次完整命令与原文件，不由验收人员补写输出。该轮没有在执行中发送新消息，且命令实际等待了 180 秒；不能据此认定忙时响应、提前报告 PID 或后台交付已对齐。
  - 1014W 进一步确认提示词调整不足：模型仍使用 shell `&`，原托管命令等待子进程输出关闭后才返回。现补充仅由可信 Host 开启的主会话执行约束：后台标志或原 shell 解析器识别的后台运算符在启动之前返回交办要求，模型通过已有 workflow 管理器承接；普通工作台及实际 workflow 执行器继续原路径。同时替换 Bot 主会话中“长命令可直接等待”的冲突说明。此项实现仍需最新版真实忙时收件／结果回传验证；没有宣称可静态识别任意程序内部的脱离进程，也没有用拒绝命令等同于已完成交付。
  - 2026-10-14 忙时对照：官方 Grok 0.70.2 的 1014V5 程序报告 PID 2919810，追加 1014V6 后在原程序结束前回复 25，随后交付 `busy-turn-1014V5.txt`；实际文件预览显示 `LONG_C_FINISHED`。电脑操作曾误触语音入口，已关闭，故本轮不作为完整的纯文字／全部抢占路径验收，只记录已观察到的新消息先回复、原任务继续及真实文件交付。此前 1014V2 实际发送晚于第一程序结束，不算忙时验证。
  - 同题 MiniMax 1014V3（任务 `c544b97b-97a3-4c4f-befb-e2786f9ecb25`）仅启动原 `execute` 后台程序并报告 PID 79234，就以“未附带附件”结束；独立读取工作区确认文件实际为 `LONG_B_FINISHED`，但 Bot 未核验／交付，没有完整的后续任务回传。不能计为通过。
  - 针对该差异，继续复用原工作流引擎：仅 Host 开启的自动工作流允许用一个子任务承接长时间阻塞的工作，快速问题直接回复，启动成功后释放当前轮次，结果仍由原通知调度器回传；普通工作流模式的用途规则保留。工具说明与系统提示使用同一执行协议，保留启动／命令审批、工作目录、角色限制及恢复，不新增后台执行器。可信 `source=bot` 沿用原托管前台命令约束，`run_in_background` 不能脱离任务所有者；没有将 Bot 请求变成 ManagedRun 授权。实际 DeepAgent 工具路由正反测试、最终提示词与真实工具说明契约、Runtime 入口检查、node/web 类型检查及构建通过，原 workflow 回归通过；最新版真实 MiniMax 忙时响应与最终交付仍待升级复验，P12.4 不勾选。
- [ ] P12.5 Mac 实屏、Windows 测试机验收及 Grok UI／动画差异记录齐全。
- [ ] P12.6 已知问题修复并回归；核心需求和交付质量达标；第二期项及允许差异单独交付说明。

## 12. 实施顺序与验收证据

### 2026-10-18 用户截图复核（1018DI）

- [x] ~~Bot默认聊天不再回退原始工具卡片。~~ 用户截图的`task`子任务记录缺口已复现（新增回归修正前1失败／43通过）。最终按用户要求及Grok实屏统一处理全部内部工具，已由下列110项测试及真实双模型31项证据核验；普通工作台和执行链不改。
  - 用户随后明确要求所有同类内部卡片均不得外露，并要求按官方实际展示对齐，范围据此更新：官方0.71.2原CN合成会话实际显示“临时帮手核对”的简短进度及43，没有子任务／参数／结果工具卡；恢复源码transcript-card/views/index.ts／mount-contract.ts按widget、attachment、permission等明确产品类型分发，孤立tool-results/view.ts注明未挂载，不能当作默认聊天卡片。采用相同产品边界，继续复用已有问题历史／资料事件／例行／文件／协作回执解析器，仅这些真实产品展示及审批、Mod保留；其他内部工具默认收起，未知工具也不回退通用ToolCallRenderer。原工作台与用户主动打开的执行过程保留。先前仅追加task名字的两行过渡修正已被统一规则替代，不留叠加的逐工具黑名单；运行中子任务亦不显示原始卡，必要审批仍沿原专门入口。两模型初步task结果已返回；统一规则的完整测试及实屏仍待完成。
  - 最终实现：isBotExecutionTool移除逐工具黑名单，复用现有产品回执解析器决定是否有专用展示；MessageBubble仅在`presentation=bot && !showExecutionDetails`增加末端保护，未识别工具不得落入通用开发工具卡。审批分支、用户选择、浏览器接管、真实文件成果、资料／例行事件与Mod仍使用原组件，失败／中断维持紧凑提示；完整原始记录在用户主动开启执行过程后可见。不增加状态、监听器、计时器、模型调用或后台机制。普通工作台仍走原条件，生产代码总量减少；本轮原MessageBubble只有8行Bot条件保护。
  - 真实MiniMax／DeepSeek各一次task、各一个临时子Agent、一次原样15秒前台Node命令，实际进程PID91378／91277均退出0，持久子流各有唯一execute和成功输出DI2_MM_43／DI2_DS_43；父Bot准确报告实际结果，无重试、轮询、工作区／记忆变更。两者默认视图均无“子任务执行”按钮；主动开执行过程都能看到原两份task历史，关闭后再次收起。DeepSeek的默认视图观测时间位于真实task调用与返回之间，运行中亦无原始卡；MiniMax专门截图时已完成，不将其误记为运行中证明。
  - 31项独立核验通过，原1071任务、41Bot／11群／13例行／35后台命令、310工作区／记忆文件及5835旧消息头保持；最终1075任务／零活跃。110项定向覆盖内部／未知工具、运行、失败／中断、审批、Mod及已验证的文件／问题／资料／协作／例行展示；web类型、原test:messages、lint零错误零警告、格式及正常退出后的构建通过。策略切换时21条旧断言要求“未知工具默认露出”，已按用户明确的新展示约束更新，原日志保留；错误识别、工具回执和权限规则未修改。
  - 证据quality-review/1018DI-task-visibility/{before,first-task-final,policy-running,policy-final,policy-review,policy-tested-build,draft-protection}.json、verify-policy.py、父／子实际持久记录、默认／执行过程AX及官方grok-{running,final}.txt；39字符原私聊草稿保持；群输入为空，15字符为占位文字，恢复AP空输入／执行过程关闭与官方tibo会话。无commit／push。本项是默认工具展示修正，不据此宣称全部UI／动画或原长任务错误都已解决。
- 截图中的1014X原失败历史保留：旧workflow使用不存在的exec()、错误先报启动和后来追加启动均不能改写为成功。普通长命令现已走原LocalSandbox的run_in_background，已有单次进程、停止／重启及交付证据；这不保证模型永远不会生成错误脚本。后台启动回执目前返回task ID，不统一提供PID，不能声称PID体验已全部对齐或用task ID冒充PID；实际PID须来自命令输出／进程核验。

### 使用方式验收约束（2026-10-13 用户再次确认）

核心功能以 Grok Bot 的用户操作流程为基准：创建 Bot 后直接交办，持续在同一对话补充要求；在 Bot／群之间协作；通过对话或例行入口安排工作；查看电脑、接管、归还；直接打开和保存成果。不能以底层接口存在替代入口、状态和结果的实际可用，也不能要求用户理解或切换 CmbCowork Runtime 的 Solo／Team／Workflow 才能获得 Bot 的核心能力。

- 默认 Bot 已通过主进程可信上下文启用原工作流能力，保留原 normal 会话模式和输出规则；不增加用户执行模式选择器。后台回传沿用原通知领取、确认与 Bot 队列。1013W 已验证真实模型自动交付；实际子 Agent、权限继承及故障恢复仍由 P03.4 验收。
- 源码复用不等于沿用工作台操作流程；对照记录必须同时写明用户怎么发起、执行中怎么参与、最终怎么取得成果，以及仍存在的差异。

1. 审核方案和允许差异，固定核心对照清单。
2. 接通本地 Bot 的创建→发送→执行→流式展示→文件交付纵向链路，同时完成 UI 基础布局。
3. 按 2026-10-13 用户最新顺序：先完成核心功能对齐。新建空白 Bot → 首次发送 → 真实回复必须作为独立验收路径，不能只用已绑定模型的验收 Bot 代替；阻断核心使用的问题立即处理。
4. 核心功能验收后对齐 UI，再单独对齐动画；暂停新增外观调整直到核心阻断清除。
5. 随后提升任务交付质量：真实 MiniMax 与官方 Grok、原 CmbCowork 按同题、同资料、同验收标准比较，检查文件、执行和交付结果。
6. 最后集中修复性能及其余 Bug，完成恢复、资源与跨平台回归。开发中遇到数据丢失、越权或串会话问题即时修复，不留到最后。

对照使用相同任务目标、输入资料和权限条件。不同模型的答案不要求逐字一致；依据成果完整性、正确性、工具操作、任务连续性和用户操作成本判断。长程编程验收必须检查实际代码与运行结果，不能只检查最终回复。

| 证据记录字段 | 内容 |
|---|---|
| 对应条目 | Pxx.x |
| 实现文件／提交 | 实际路径及提交（如有） |
| 环境 | OS、客户端构建、模型与配置引用，不含密钥 |
| 场景与步骤 | 可复现输入、操作和预期 |
| 结果 | 通过／失败／待验证及实际差异 |
| 证据 | 脱敏日志、测试输出、截图／录屏、成果路径 |

### 当前复核结论

方案在源码接口层面可行，已明确 Runtime、记忆和浏览器的真实缺口，且覆盖本期约定要求。尚未通过实际移植、运行、UI 对照或跨平台测试证明完成。主要实现风险为 Runtime 子任务的作用域继承、后台通知归属、浏览器控制权交接及窗口生命周期，已分别列入 P03、P07、P10。

用户已批准编码，当前正在实现；业务验收按下方证据更新，不以文档设计结论代替实际验证。


## 13. 实施记录（2026-10-12，持续更新）

### 已落地但尚未完成模块验收

- `src/shared/bots`：主机标识、协议版本、能力声明、请求校验；`src/preload/bots.ts` 为窄 IPC 适配。未知主机拒绝；远端传输尚未实现。
- `src/main/bots`：独立控制 SQLite、稳定 Bot／线程身份、版本冲突检查、持久队列、运行租约与取消；实际执行调用原 `startAgentRun`，复用原消息和增量 checkpoint。
- 私有记忆复用原 `MemoryStore` 和 frontmatter；已加目录／符号链接检查、版本化编辑删除、索引缓存上限。自动总结和共享授权待补。
- Bot 协作已加身份绑定工具、限深／限量异步交办、事务回复 outbox。群聊、完整来源 UI 和真实模型验证待补。
- 新工作区已有列表、创建／编辑、归档、三栏布局和私有记忆面板。聊天复用 `ChatContainer`，通过可选 managedTurn 接线；旧默认行为保留。
- Hermes 移植：`animation/budgeted-loop.ts`、`renderer-loop-pause.ts`、`face-pose.ts`；保留 `LICENSE.hermes`。单共享时钟、可见性暂停、减少动态效果支持；实屏动画对照尚未验收。
- 官方 Grok 实屏已观察：新建聊天、详情／资料库／电脑标签、头像／名称入口、群聊与 Bot 消息来源展示。仅记录交互结构，不保存私人会话内容。

### 验证记录

- `npx vitest run src/main/bots/host.test.ts src/main/bots/memory.test.ts`：13 项通过；覆盖幂等、版本冲突、单 Bot 串行／跨 Bot 并行、取消清理、重启中断、异步回复去重、停止后不被回复唤醒、私有记忆隔离和符号链接拒绝。
- 已修复测试发现的 `waiting_user → completed` 转换缺口；测试现在明确检查最终持久状态。
- 一次构建通过（新增聊天工作区基础版本）；后续新改动需要重新构建。
- TypeScript 检查已发现并修正新 UI 的导入路径、不存在的下拉组件引用和 JSX 闭合问题；以最终重跑结果为准。
- 以上为早期构建记录；当前完成状态以第 11 节逐项证据为准。不能将单测／构建等同于真实模型、Grok 全部核心流程或跨平台验收。

### 浏览器实现复核与调整

- 2026-10-12：额外 Chromium 的初始实现增加约 333 MiB 本地资源。复核确认原内置浏览器使用 Electron 的 Chromium；额外分发不是隔离的必要条件，已撤销准备脚本和打包配置。
- 推荐实现：复用 Electron 可执行程序启动 Bot 专用浏览器宿主；独立 profile、受限父子进程消息、按真实 Target ID 绑定 Page、浏览器操作串行。普通应用入口与宿主入口分开，后者不加载原工作台 IPC 和 Runtime。
- 原共享 BrowserService 的导航、录制和页面选择逻辑保持原行为。新宿主沿用隔离上下文、关闭 Node 集成和沙箱配置；不会通过 URL／标题匹配页面。
- `npx tsx tests/bot-electron-engine.spec.ts`：Mac 隔离验证通过；覆盖复用 Electron 引擎、相同 URL 的不同 WebContents 精确操作、中文文本输入、Cookie 持久化与重启。此项不等于中文输入法人工接管或正式安装包验收。
- `npx tsx tests/bot-native-browser-host.spec.ts`：Mac 隔离验证通过；实际生产适配器可启动浏览器宿主、绑定页面、生成预览、显示／隐藏接管窗口，并释放 profile 供重启使用。Windows 和正式安装包仍需单独验证。
- 新浏览器控制及 MCP 范围单测与既有 Bot 控制／记忆单测合计 22 项通过；切换宿主后需要重新运行。Windows 与打包程序的宿主启动仍待验证。

### 2026-10-12 本轮实现与界面检查

- 官方应用 `Info.plist` 显示版本 **0.68.1**；本地重建库标注 **0.18**，两者不视作同一版本。实屏确认三栏可拖动、标题打开详情、头像／名称可编辑、详情／资料库／电脑标签；其余核心流程继续核验。
- 私有记忆新增自动提取、人工修改失效保护、指定条目显式分享；复用原有提取器、检索索引、批处理合并和用户模型路由。P04.1、P04.3 已完成代码与单元验证。
- UI 新增 Bot 专属 Zustand 视图状态，保留主机内选择、详情和栏宽；拖动仅按动画帧更新 CSS，结束后才保存偏好，不在移动过程中反复写 localStorage。聊天草稿和流仍由原线程上下文管理。
- 浏览器接管新增人工地址输入与主机端控制权检查。Bot 数据库初始化失败不阻断原工作台启动；相关 IPC 拒绝案例已验证。
- 新增功能与边界测试 38 项、主进程和渲染进程类型检查通过；构建通过，原消息测试组通过。随后实屏发现 contextBridge 冻结对象不能直接代理替换方法，已改为独立代理外壳；新增冻结对象用例，客户端注册 3 项通过，需继续实屏复核。
- 生产浏览器适配器 Mac 独立进程测试重跑通过；正式安装包和 Windows 待验收。

### 2026-10-12 MiniMax 与浏览器验证补充

- 已切换隔离测试配置至用户已有的 **MiniMax-M2.7**；配置来源为现有模型设置，未修改原配置。正式聊天界面完成金额核对及补充要求两轮，实际合计 50.75、草稿多计 2.00，Runtime 正常完成。
- 真实模型通过 `bot_browser` 两次调用观察页面并返回页面标题；核对实际工具结果，模型结论与页面一致。此记录仅证明该浏览器场景，不代表长程编程、审批和协作已验收。
- Mac 原生浏览器宿主集成测试扩展并通过：独立页面归属、中文文本、文件上传、确认弹窗、下载、预览、人工窗口接管／导航／归还及重启 profile；Windows 与安装包仍待验收。
- 原 contextBridge 冻结对象代理问题已在正式测试界面复核：工作区读取、模型编辑、发消息和浏览器工具均可用。
- 聊天继续复用原组件，新加 Bot 展示上下文；推理文本折叠、消息气泡及标题栏调整已实屏查看。独立头像选择器及日期间隔待下一轮 UI 验收，不计入已完成对齐。
- 后续按用户最新指示先完成核心功能，再集中做 UI／动画与 Grok 实屏对照。

### P02 删除链路实现（待完整验收）

- 原 `threads:delete` 清理函数作为受类型约束的主进程服务复用；原 IPC 仍调用同一函数，不复制 checkpoint、worker、workflow 和工作树清理代码。
- Bot 删除先持久化删除状态，取消待办和例行任务、移出群成员，再清理私聊与成员线程、私有记忆和自有浏览器页面。失败保留状态供重试，不重新执行待办；工作成果文件及已发布群聊消息保留，删除确认框明确说明。
- 删除相关控制、IPC、记忆、浏览器及原会话删除守卫共 49 项测试通过；主进程类型检查通过。追加退出清理测试验证共享退出 Promise、等待运行释放后关库、单个资源失败时继续释放其他资源。P02.1—P02.3 保持未勾选，直到完整流程验收。

### P03.3 后台通知接线（2026-10-12，待真实场景验收）

- 复用 `PendingNotificationScheduler` 的通知发现、owner 过滤和失败退避；新增可选队列分派入口。普通桌面／IM 流程默认不变，Bot 的汇总进入自己的持久队列后再复用 Runtime 的 claim／ack 流程。
- `notification-dispatch.ts` 从主进程会话元数据确认 Bot／主机／群成员归属。远端 Bot 不回退本地执行；本地队列失败沿用通知调度器退避，不降级为普通桌面运行。
- 通知使用稳定键去重，群成员汇总继续使用群线程；已取消的同一条通知不会被再次投递唤醒。通知消息在列表中显示“整理后台任务结果”，不暴露内部触发标记。
- Bot 运行复用原会话模式，不再每轮强制重置为 normal；Bot 身份工具和浏览器作用域仍经原 Runtime 入口传入。
- 新增定向通知分派、队列失败、普通会话回归、主机拒绝及群线程去重测试。相关核心测试目前 90 项通过；原工作流完整回归正在执行。P03.3 仍需真实工作流／worker 任务验证，以及重启恢复核验。
- 普通用户任务／例行任务在持久化终态后复用 `notifyIfBackground` 通知；通知异常不影响队列继续执行，私聊协作的中间回执不重复弹系统通知。
- 审批源码复核：当前 Runtime 明确配置 `interruptOn: undefined`，实际工具审批走 orchestrator 通道；不能将保留的 legacy HITL 恢复分支直接等同于当前 Bot 审批失败。P03.2 仍需真实审批场景验收。

### 2026-10-12 核心实现后续记录

- 群聊删除同样复用原会话清理服务，先取消群待办并持久化删除状态；删除失败可重试，成员私聊和工作文件保留。控制层测试已验证不误删成员私聊。
- 后台通知恢复复用原 worker 恢复入口与 workflow 通知存储，逐线程检查并在退出时取消；不自行复制恢复算法。实际强杀／重启仍列在 P10.1，未以单测替代。
- `npm run test:workflow` 执行到 `sandbox-elevated.unit.spec.mjs` 时出现 3 条源码断言失败。在临时目录抽取 **HEAD 基线** 的同一测试及其引用源码重跑，结果同样为 84 通过／3 失败，失败名称完全一致：runtime startup、notification backlog、notification at-least-once。未改动旧断言来制造通过；记录为既有回归门禁问题，完整命令后续测试尚未执行。
- 本轮 Bot 相关核心测试 90 项、通知终态补充测试 21 项通过（有重叠，不相加计数）；类型检查和生产构建已通过一次，最新群删除／恢复改动还需重新跑。

### 2026-10-12 核心链路补齐与进程验证

- P03／P08：Bot 用户消息启用原 Runtime 的显式技能识别，继续复用注册表校验、可见范围及技能 Hook；协作消息、群上下文、例行任务不获得用户显式选择权限。输入框补发消息不再拒绝现有审批。
- 浏览器选择沿用原消息封装、附件及技能尾块，Bot 路由使用 `bot_browser`，原工作台继续使用 `browser_*`。显示／搜索／复制支持相应前缀。
- Bot 输入框不暴露尚未纳入 Bot 队列的 Goal／Mods 控制入口，手动输入已知命令时明确提示在原工作台使用；原工作台能力不变。此项是当前适配限制，不能宣称完整复刻所有原工作台控制命令。
- P03.4：工作流脚本写入、共享目录子任务、worker 初次运行／模型切换／交接继承显式工具队列标识；未指定时维持原默认行为，隔离 worktree 保留独立队列。原对应锁断言已随该契约更新并通过。
- P02：参考 Grok 的身份工具行为，补充对话中修改自己名称／职责；复用现有 Bot 存储和版本控制，不能修改模型、身份 ID、归档状态或其他 Bot。只有正在运行的用户私聊可调用，协作来源及过期任务被拒绝。
- P05：参考 Grok 异步通信和 Hermes 持久投递，补齐群成员间异步交办及回执；对外部成员拒绝投递，成员退出取消待办，群结果不写入私聊。保留层数和总次数限制，不自动循环确认。
- `tests/bots-process-recovery.spec.ts` 已通过：真实 Host 子进程与磁盘 SQLite，执行中／等待审批时 SIGKILL，再连续启动两次；验证身份、待办、协作回执、群结果、定时任务、取消状态与不重放外部动作。**模型执行为确定性替身，没有替代 P10.1 的完整 Electron／真实模型 checkpoint 恢复验收。**
- 本轮 `host.test.ts`／`runtime-adapter.test.ts`／`ipc/bots.test.ts` 35 项通过；消息回归、前后端类型检查、生产构建均通过。后续新增改动另行记录验证结果。
- 全量工作流回归仍有此前确认的 3 条基线源码断言失败；继续执行后段时，`message-queue-plumbing.spec.ts` 的 middleware 相邻关系断言失败。已在临时目录抽取 HEAD 的同一测试及引用文件复跑，出现同一失败，未将其报告为通过。其前置 checkpoint flush／LRU／提交锁／消息队列 Runtime／消息内容测试通过。

### 2026-10-12 真实身份更新与核心补充

- 正式隔离测试界面使用 MiniMax-M2.7，通过自然语言调用 `bot_update_profile` 将“界面验收 Bot”改为“核心验收 Bot”；列表、聊天标题和详情名称一致，重启后名称与既有会话保留。此记录不代表 P02 全流程或 Grok 交互对照全部完成。
- MiniMax-M2.7 在 Bot 自有工作目录交付金额核对模块、node:test 测试和 README 三个文件；正式界面逐次审批后运行结果为 9 通过／0 失败，独立运行生成的测试也为 9／9。审批期间补发的要求保留在队列中，原任务完成后继续读取 README 并回复，未重复创建文件。这是小型编程链路验证，不代替 P12.2 的长程任务质量对照；生成文档和个别测试名称仍有表述不准确，不能据此宣布交付质量已达标。
- 协作及例行消息将来源与正文一起写入原会话链路；协作名称由主机记录，旧记录回退为“其他 Bot”，不把内部 ID 作为展示文案。实时消息与持久消息保持相同正文和身份。
- 修改例行任务的内容或执行时间规则，会取消旧配置产生的未执行触发；不影响用户任务或已经运行的任务。只改显示名称或内部下次执行时刻不取消待办，保留重复触发合并。
- 群聊发送确认不会清空请求在途期间新输入的草稿。上述控制与 Runtime 相关 35 项测试通过；Bot／IPC／协议定向回归共 69 项通过，前后端类型检查通过。
- 实屏发现聊天文件链接误打开旧工作台资源面板，预览使用错误会话。已接入按 Bot／群成员会话绑定的预览入口，复用原请求顺序管理、FileViewer 和受限文件 IPC；Bots 界面不挂载旧工作台预览面板。相关 25 项回归、前端类型检查及本地生产构建通过；新版已实屏打开 reconcile.mjs 和 README.md，分别正确显示代码高亮、Markdown 表格和正文。
- 重启测试中观察到旧 Electron 进程在关闭窗口后未及时退出，Bot 后台已进入停止状态，第二次启动因单实例机制回到旧进程。已清理隔离测试进程后继续；此退出链路问题仍待定位，P10／P11 不据此标为完成。
- 协作范围复核发现私聊面板原先按 Bot ID 汇总全部任务，会混入群聊待办，且私聊停止操作可能取消群任务。现按 Bot 身份、私聊线程及任务来源共同筛选，保留私聊内用户／例行／协作／后台通知，群任务由群聊管理；新增 3 项范围回归及前端类型检查通过。未将代码层验证记作真实群聊端到端验收通过。

### 2026-10-12 列表活动与未读接线

- P09.2：核对 Hermes `roster-actions.ts` 的稳定会话活动标记及 Grok 实屏未读提示后，补齐私聊／群聊最新结果摘要与未读圆点。沿用 Host 的持久事件入口，在控制库中每个会话仅存一条最多 600 字符的列表元数据，不复制历史或 checkpoint，不增加轮询。
- 主动任务、协作、例行及后台结果都能更新所属会话；用户发消息本身不制造未读。已读按单调版本确认，迟到的旧确认不吞掉新结果；只在当前可见、聚焦的会话中确认，重复确认及重复结算不会重新制造未读。
- 复用原可见消息文本投影；MiniMax 内联思考拆分提到 shared 供消息与摘要共用。删除 Bot／群时一并清理其列表元数据，私聊和群的摘要及已读状态互不影响。
- 定向回归 77 项、前后端类型检查、原消息回归通过。真实 Host／磁盘 SQLite 的 SIGKILL 后连续重启测试通过，并增加已读位置、未读群结果及摘要不重放断言；该测试仍使用确定性模型替身。列表新功能的实屏验收待新版验证。

### 2026-10-12 群聊草稿与结果交付补齐

- P05／P09：群聊草稿、接收成员、发送锁和失败重试标识从组件局部状态移到按主机／群身份隔离的 Zustand 会话状态，复用本项目状态管理方式，不创建假的 Runtime 线程。切换面板后可恢复草稿；原发送确认不会清空随后输入的内容，重新挂载期间不能重复提交，结果不确定时重试沿用原请求 ID。
- 群删除后清理相关草稿，迟到回执不恢复已删除状态；按成员当前范围过滤接收对象。此处仅保证应用会话内切换保留草稿，未声明进程重启后保留未发送内容。
- 群聊成果及 Bot 协作回执复用现有内联思考解析，只交付正式回复；历史群记录显示也兼容已有内联思考。原 Runtime 线程中的思考记录继续保留。
- 新增 3 项草稿生命周期测试，连同 Host 回归共 31 项通过；前后端类型检查通过。UI 自动操作仍出现控件无 frame、AX 树与截图不同步；用户已确认页面正常并进入 Bots。本轮未因此将双 Bot／群聊真实模型对照记为通过。

### 2026-10-12 真实双 Bot 对照

- 调整测试窗口尺寸后，桌面工具恢复可用；正式界面创建“协作核验 Bot”，绑定 MiniMax-M2.7，选择蓝色六边形头像，创建成功。
- CMBDevClaw：向“核心验收 Bot”交办一次独立核验，实际调用同事目录与异步交办工具；核验 Bot 收到带来源的任务并返回结果，主 Bot 随后自动汇总。实际合计 50.75、草稿差额 +2.00，来源为核验 Bot；无需人工转述结果。未读提示出现，进入接收 Bot 会话后清除。
- Grok 官方客户端：向“资料校对助手”提交同题、要求“记忆核验助手”独立复核；实际显示发出／收到协作消息，最终结果同为 50.75、+2.00，并注明核验来源。此场景已实现行为闭环对照，不代表群聊、文件协作或全部 P12.4 通过。
- 发现差异：CMBDevClaw 原列表摘要保留 Markdown 符号，已复用原 Markdown 可见文本投影；Bot 工具加入中文标签。旧测试包的协作回执仍含内联思考，新包已使用正式回复投递，待新任务验证。Grok 的可展开协作交流提示尚未达到相同呈现。
- Mac 升级再次复现“完成 SessionEnd 后关闭窗口但未到 will-quit”；已补充退出状态下 window-all-closed 的退出衔接，以及退出期间拒绝重新创建主窗口。49 项相关回归、构建通过；真实退出复测尚待完成。

### 2026-10-12 真实群聊、记忆开关与退出复测

- 在正式界面创建“核心协作验收群”，加入两名 MiniMax-M2.7 Bot。只选中主 Bot 后输入任务，切换到私聊再返回，草稿和接收成员选择保留；提交后主 Bot 交办一次，核验 Bot 在群内回复，主 Bot 自动汇总。控制库只读核对显示原任务、核验任务和回复汇总均完成且均属于原群，未投递到私聊。
- 同题数据 27、14、33、6：CMBDevClaw 与 Grok 官方群聊均交付合计 80、平均 20、草稿差额 +2／0 和核验来源。新包群结果及协作回执没有泄漏内联思考。Grok 还指出草稿合计 82 与平均 20 自相矛盾；本轮 CMBDevClaw 未补充该观察，保留为输出质量差异，不宣称结果质量完全一致。
- 真实模型调用 `bot_remember` 时，隔离配置的长期记忆总开关关闭，工具拒绝保存，模型明确告知未保存。启用记忆的真实持久化／重启读取仍待测试；未擅自更改用户配置。
- 定时任务真实调用暴露工具契约缺口：`enabled` 在工具中可选，底层校验要求必填。已修正为新建默认启用、编辑沿用已有启停状态；编辑未给出的配置沿用旧值。新增工具调用回归覆盖省略启用字段、暂停任务重命名、显式恢复、无时区拒绝及定时消息不能再创建定时任务；连同 Host 共 31 项通过。真实重测待新版完成。
- 完成真实模型任务后向隔离 Electron 主进程（PID 70455）发送 SIGTERM；日志进入 `will-quit`、执行资源清理，进程实际退出。此次正常退出问题复测通过，不替代强制终止后的 checkpoint 恢复或 Windows 验收。
- 定时修复的真实复测通过：聊天创建一次性任务，21:11:47 到期后，MiniMax 在原私聊回复指定验收文本；只读控制库确认仅有一条对应 schedule 来源任务，状态完成。退出／重启后的记录保留。UI 将已触发的一次性任务标为“已暂停”，该文案与历史状态区分仍待完善。
- 记忆设置实屏发现：配置写入已支持自定义数据根目录，旧记忆目录／目录统计却仍硬编码默认 home，导致隔离配置显示正式库和错误开关状态。`memory/paths.ts` 改为复用 `getCmbCoworkAgentDataRoot`，默认路径不变；两个根目录契约测试及现有目录 worker／reader 回归共 10 项通过。正式库未修改；用户已授权仅启用隔离配置，实际启用与模型保存待新版验证。
- 新版设置面板确认目录为隔离 profile，开关为禁用；经用户授权从界面开启。MiniMax 实际调用 `bot_remember` 和 `bot_memory_get`，面板出现“合成项目代号与交付摘要格式”。在面板手动改为新代号并正常退出／重启后，模型重新读取并返回新值（旧聊天仍为旧值）。另一个 Bot 调用自己的记忆搜索／列表，返回未保存，未串读。
- 浏览器真实任务：MiniMax 在原生 Electron 浏览器导航 example.com、点击 Learn more，报告 Example Domain → iana.org／Example Domains，电脑面板显示实际预览。Grok 同题返回其云端浏览器外网连接失败，故本场景不能记作完整同结果对照。人工接管期间的实际工具调用进入等待，归还后继续；最终结果待核对。
- 新发现待修：自动记忆总结将一次性浏览器验收步骤误存成“浏览器验收协议”，需要收紧持久记忆提取条件并做真实模型复测。该质量问题不被本轮保存／读取链路通过所掩盖。
- 接管续跑复核：模型使用旧页面 ID，等待后仍收到“页面已关闭”错误；已修正归还后的重新观察逻辑，失效目标转到本 Bot 当前有效页面，仍拒绝其他 Bot 页面，也不重放原输入。新增替换页面回归，浏览器单测共 8 项通过；新版实屏复测待完成。
- 记忆提取整改：复用内联思考解析后再交给原总结器，避免把模型推测作为事实；Bot 专属范围规则明确一次性验收步骤、URL／pageId、临时限制与结果不构成长久协议，要求不记忆时返回空操作。Runtime 与总结适配器共 12 项通过；误存问题仍需真实模型复测，未提前判定修复。

### 2026-10-12 资料分享与群成员验收

- 从资料库菜单将合成 README 分享给另一 Bot，界面提示成功；接收资料库出现独立副本，只读文件比较确认内容一致。真实 MiniMax 读取并总结用途和测试命令。初次读取猜错为技能目录，随后通过查找定位成功；还把文档相对链接判断为合理，输出质量不能据此算完全达标。
- 该任务明确要求不记忆；自动总结已实际调用，完成后接收 Bot 私有记忆仍为空。本案例通过，不代替对无显式禁止、但仅有一次性任务的提取质量验证。
- 群成员管理已实屏验证移出成员后交办选择同步减少，已有成员消息保留，未影响该 Bot 私聊。
- 最新前后端类型检查通过，`git diff --check` 通过。
- 归还浏览器真实复测通过：模型携带已经失效的旧 pageId 调用观察，人工接管期间进入等待；点击归还后自动观察本 Bot 当前页面，正确返回 Example Domain 与 https://example.com/，没有要求用户重发任务。该结果只覆盖接管续跑，不替代浏览器全部操作或崩溃验收。

### 交付质量门槛补充

- Bot 不得因适配而降低原生 thread 的任务完成能力。验收使用同一 MiniMax 模型与配置、同一任务材料和约束，分别在全新原生 thread 与 Bot 中运行；逐项比较需求覆盖、实际文件、构建测试、证据与结论一致性、失败后的恢复。模型随机输出不能仅凭一例归因为适配问题，也不能用“同一 Runtime”直接证明无退化。
- 当前已知观察：资料读取曾误猜技能目录后通过搜索恢复；文档相对链接核验存在漏判。保留待对照，未宣称交付质量已达到原 thread 或 Grok 水平。

### 2026-10-12 状态反馈补齐与同模型交付对照

- 浏览器面板分开保存预览错误与操作错误；后台截图成功不再清除导航／接管失败提示，刷新画面也不伪装成重试输入操作。
- 例行任务增加主机维护的实际入队时间，保存在已有 JSON 配置中，不新增数据库表或历史副本。已触发的一次性任务显示“已触发”，不宣称执行完成；过期的一次性任务通过重新安排输入新时间。改名保留触发记录，修改执行内容／时间清除旧记录，调用方不能伪造记录。控制／工具／状态投影共 34 项回归通过，前后端类型检查通过。
- 新建无历史的“交付质量对照 Bot”，与全新原生 thread 分别采用 MiniMax-M2.7、Solo 模式，按同一任务规格生成六文件离线核对工具。双方均要求不使用其他 Bot／子代理，不联网、不装依赖；各自输出到隔离目录。任务已启动，等待真实完成及独立契约检查；尚未记为通过。

### 2026-10-12 六文件编程同题交付复核

- 同一任务规格分别运行在 MiniMax-M2.7 Bot、MiniMax-M2.7 原生 Solo thread 和官方 Grok 全新 Bot 中。验收读取实际六份文件，执行独立金额／核对／CLI／文件链接检查；首次产物留存后再给修正反馈。
- 首次 MiniMax 两边均通过基础 38 项，但安全整数范围内 `90071992547408.01` 被浮点换算为 9007199254740802 分，正确值应为 9007199254740801 分。加入正负边界相邻金额检查后，两边结果均为 38／39；不能记为交付达标。Grok 首次产物使用精确整数换算，同一独立检查 39／39，通过其实际 8 项测试。
- 对 MiniMax 两边提供同样缺陷反馈后，实际产物改为字符串／BigInt 解析，均通过独立 39／39。移动完整交付目录后，Bot 实际 43 项、原生 thread 实际 56 项测试通过。Bot 曾硬编码测试目录，修正后可移动运行；两边仍有测试临时文件的命名／清理差异。这只验证了本题及反馈后的修正能力，不证明长程任务或任意交付质量等价。
- 实屏确认 Grok 的例行验收最终也有回复（21:42:48）；此前仅观察窗口内未收到回复，不能判为功能失败。
- Bot 工具标题由折叠与展开卡片共用中文映射；已返回的工具不再以绿色 OK 暗示任务验收成功，明确工具错误仍显示失败。会话列表摘要取首条可见内容，群来源前缀在 Markdown 投影后追加，避免标题标记与整张表挤进摘要；相关 33 项回归通过。
- 前后端类型检查、消息回归、构建通过。桌面执行基线首项断言在 HEAD 未修改快照同样失败（旧断言要求 `const harnessAgentContext`）；剩余六个桌面基线套件均通过。本轮未以修改旧断言掩盖结果。

### 2026-10-13 核心缺口与原实现对照

- 对照原 `browser-script-execution-service.ts` 的上传路径语义，Bot 浏览器兼容当前工作目录内的相对／绝对路径；复用已有工作文件解析与 realpath 越界校验，UI 文件 ID 仍保持相对路径。补充页面失效后的 observe 恢复指引、附件控件标签和完整子目录说明。
- 浏览器失败使用原 Runtime 支持的 `ToolMessage.status="error"`，持久消息与实际界面均能识别失败；真实 MiniMax 错误记录已具有 `is_error=1`。避免以普通文本误标成功。
- 真实 MiniMax-M2.7 已填写中文、选择实际 sample.json 并提交；本地合成服务保存的回执核对名称、文件名、声明值 52.75 和 accepted=true。随后发现 Electron 弹窗已关闭但 Dialog 句柄仍被保存，任务取消。现已在消费句柄时清理旧状态，并对“弹窗已经关闭”返回实际页面与结果未知提示，禁止重复提交；10 项浏览器回归通过。修复后的真实完整任务未通过：M2.7 返回 402 余额不足，另一套 M2.5 连接失败。下载及最终交付仍待真实模型验收。
- 群聊实屏确认浏览器入口、独立群页面、导航到合成表单、实时预览、接管与归还。复用私聊相同服务／面板；实际群内模型自动浏览仍待验证，未勾选 P07.6。
- 在原 Runtime 后追加来源／身份提示，明确群内最新用户请求与引用历史的区别、例行任务与后台结果的既有授权、本机环境、共享登录 profile、异步协作和证据交付。未将完成校验描述为质量保证，也未用空回复假装静默通知。
- 编辑模型、例行任务频率／星期及浏览器页面选择复用原 `components/ui/select`，统一弹出菜单、键盘与焦点处理；未新增组件库。实际新菜单、窄窗口和主题视觉待新版检查。
- 官方 Grok 实屏进一步核对：新聊天在收件人区选择新 Bot／群聊／已有 Bot；详情面板具有头像、名称、标签及详情／资料库／电脑三标签，电脑预览可打开独立电脑。beta 详情切换已复用原 `components/ui/tabs`，支持正确标签语义及方向键；选项菜单复用 Select，保存按钮统一为中性色。标签／置顶、新聊天流程及各面板的视觉差异继续列为待对照，不以三栏布局替代整体 UI 验收。更新后 79 项相关回归、前后端类型检查和构建通过。
- 新版实际确认：详情右方向键切到资料库，资料库显示真实六文件；模型选择器的选项和选中状态正确，Escape 关闭菜单并将焦点还给选择器，取消编辑不修改配置。
- 后续群浏览器复核发现共用群页面会让成员的多步操作交错；调整为每个群成员独立页面作用域，右侧复用 Select 选择成员，工作资料仍共享。移除成员时撤销群浏览器入口并中止其活动任务；删除 Bot／群聊时关闭对应页面并拒绝迟到的打开请求，保留其他成员和其他会话页面。新增隔离／越界上传／删除回归，最终成员选择版实屏与真实模型仍待验收；此前群共享页面实测不能替代新实现验收。
- 最终成员选择版已完成上述实屏切换／导航／归还与页面保留验证，P07.6 已按代码与交互证据勾选；真实模型及下载验收仍保留未完成。
- 弹窗未处理时，导航／点击／输入明确返回“操作未执行”工具错误；observe 仍可返回弹窗信息，close 可正常关闭页面。避免把被阻断的动作当成成功，并沿用原 Runtime 的错误处理。最终针对性 15 项浏览器／工具回归、主进程类型检查及构建通过。
- 真实模型上传／下载完整任务及双群成员浏览器任务已在新 key 下通过，证据见 P07.2／P07.6；官方 Grok 正在执行相同表单要求（其远端无法访问本机 localhost，改为在自身工作区准备等价合成服务，环境差异单列）。
- 原 Runtime 模式复核：Bot 已继承线程的原执行配置；仅为隔离后台验收临时使用原选择器设置新测试 Bot 为 Team，尚未开始任务。按用户最新要求，正式 Bots 界面不展示 CmbCowork 的模式选择，继续保持 Grok 的目标交办流程；临时 UI 扩展已撤回。Bot 文本中的 coordinator 前缀不再误显示已切换未实际传入的模式。17 项模式／适配回归通过；原执行能力应在内部复用，后台任务的真实验收仍待完成。

### 2026-10-12 状态与资料预览验收续记

- 新建一次性“触发状态复核”，MiniMax 创建后于 22:10:13 实际触发并回复；详情显示“已触发 · 结果见最近工作”，最近工作为已完成，只读库保留实际触发时间。旧版未记录触发时间的过期任务显示“执行时间已过”，重新安排时要求输入新时间。
- 未要求禁止记忆的一次性合成验算（17、28、5）完成后，真实自动总结已调用；接收 Bot 的记忆仍为空，没有沉淀为永久工作规则。该案例验证一次性任务提取，不代表任意记忆提取都不会出错。
- 实屏完成临时 Bot 创建、改名、职责和头像编辑、归档／恢复；只读库核对稳定 Bot／thread ID。删除入口明确说明会话／记忆删除、待办取消与工作文件保留；取消删除后 Bot 保留。实际删除清理由 Host／IPC 自动回归覆盖，本轮未在界面执行最终永久删除。
- 补齐 Bot 消息相对文件链接预览：复用原文件索引／唯一文件名消歧与预览组件，未确认路径不跳到 Electron 程序目录。普通会话保持原行为；链接回归 16 项通过，实际文件点击待新版复核。
- 记忆总结的存活校验只读对应 Bot，不为每次判断构建含队列、群和例行任务的整份快照；资源关闭／总结回归 7 项通过。控制数据升级失败回滚／半升级修复已补齐，Host／IPC 35 项、整组 Bot 回归 79 项以及实际 Host 进程恢复通过。

### 2026-10-13 列表、协作交流与头像动画续记

- 对照官方 Grok 的右键菜单及新分组操作：补上手动未读、仅隐藏／恢复、列表分组和就地命名。隐藏不等于归档，不停止 Bot；当前会话不会因操作其他 Bot 而切换。实际创建“验收分组”、改名、折叠与隐藏／恢复均通过。
- Hermes `avatar.tsx` 的 `settlePose` 用于状态变化时从上一帧姿态平滑过渡；继续共用 30fps 时钟，减少动态效果、离屏和窗口不可见时暂停。等待人工确认不再播放工作状态。新增 2 项生命周期测试验证过渡连续性、帧预算、暂停和销毁取消；尚不代表整套动画视觉验收通过。
- 官方 Grok 实屏：协作提示打开只读的 Bot 交流会话，可查看请求及回复；参考旧版 `BotPeerExchange.tsx` 的身份绑定和过期请求处理。新版直接读取现有任务／回执 outbox，以宿主、Bot、群范围和真实派发 ID 校验，不创建独立会话存储，不读取对方私聊。普通会话仅增加可选展示上下文，执行与审批仍走原路径。
- 协作入口、群成员执行记录展示接入后，Host／IPC／解析／动画相关 45 项测试通过；实屏、完整历史和群内入口仍待验证，P09.2 保持未完成。

### 2026-10-13 真实协作交流与群管理续记

- MiniMax-M2.7 正式界面任务“交流面板验收-1013D”通过：18.25、7.50、25.00 合计 50.75，草稿 52.75 差额 2.00；与此前官方 Grok 同题的结果一致。只读控制库确认一条用户任务、一条交办、一条回执均完成，没有额外确认往返。
- 实屏：发送与收到提示均可打开实际完整交办／回执；回执展示去掉 Host 的内部状态前缀。Escape 返回原位置并聚焦入口，未发送草稿保持原文。群内已有真实核验任务也可打开交流，读取 27、14、33、6 的群内交办和回执，不带入私聊。
- 对照 Grok 实际交流画面后继续调整双方头像标题、左侧头像、姓名颜色、气泡、日期与底部“关闭聊天”；最终外观仍需新版实屏验收。当前按单次交办展示，尚未覆盖 Grok 同一对 Bot 的完整连续历史。
- 官方 Grok 群右键菜单确认包含置顶、分组、未读、改名、复制 ID、隐藏和删除。beta 已复用 BotRowMenu，增加群偏好与仅名称编辑，操作绑定所点对象；群与 Bot 按真实活动混排，未读确认和改名不改变活动排序。实现后的群菜单实屏待验收。
- 头像复用原 ThreadContext 的工具／审批状态，通过返回单个状态字符串的订阅避免每个 token 重渲染；无新 Runtime。等待人工、旧轮工具、执行与思考状态已有针对性测试；Grok 搜索／发送等更细活动动画仍未完整对齐。
- 协作、Host、Runtime、历史清理、IPC 和展示相关 70 项回归通过；后续新增头像／列表顺序等 9 项回归通过；前后端类型检查、构建与原消息回归通过。

### 2026-10-13 连续交流历史与重启界面复核

- 群右键菜单实屏确认置顶、分组、未读、重命名、复制 ID、隐藏与删除入口。将“核心协作验收群”移入“验收分组”，取消改名后当前私聊保持不变；正常退出并启动新包后，群分组及展开状态保留。尚未将所有群管理路径记为通过。
- 协作历史复用现有任务及回执，增加按双方身份、群范围和稳定游标读取的 30 条分页；索引定位、批量联表，不逐条查询完整会话。双向交流、同时间戳跨页、错误游标、第三方 Bot、私聊／群隔离和成员退出已回归。
- 交流界面复用 Virtuoso 虚拟列表，按真实时间排列交办和迟到回复；保留请求／回复标识，加载更早内容维持位置；打开期间按宿主变化更新最新页及尚未完成的旧任务，无定时轮询。关闭／卸载取消订阅，页面隐藏时不发起读取。
- 新包实屏已显示 10 月 12 日和 13 日同一对 Bot 的真实交流，包含本轮 50.75／2.00 核验。发现旧回执仍含历史 `<think>` 内容，已复用现有解析器做只读投影修复并补旧数据回归；修复后新版实屏确认旧回执仅显示正式结果，Escape 返回原协作入口并恢复焦点。
- 必须保留的差距：当前时间线读取的是仍保留的控制记录，30 天历史清理后还不能从原 Runtime 消息恢复完整交流。没有修改原清理策略，也没有宣称永久历史已经对齐。历史消息来源在快照窗口外的展示仍待补齐。
- 本轮 6 文件共 52 项相关回归通过；主进程及前端类型检查通过，构建通过。新 UI 并不代表整体 Grok UI／动画已经一致，Windows 验收仍未完成。


### 2026-10-13 创建后首次发送阻断（用户反馈）

- 实屏复现：新建、未绑定模型的 Bot 发送第一条消息，出现“请先在下方选择模型”，而 Bot 输入框没有该选择器，任务也未进入 Host。此前真实任务使用已绑定 MiniMax 的 Bot，未覆盖这条首次使用路径。
- 根因：原 `ModelSwitcher` 同时承担模型初始化；Bots 收起它之后，只保留了 `ChatContainer` 的模型校验。修复在 Bot 会话准备时复用原 `models/registry.ts#getAvailableModelConfigOrDefault`，为默认跟随模式恢复线程实际模型；执行使用同一解析，显式绑定保持优先，不修改原工作台选择器。
- 新建、首次运行、默认切换、显式绑定及无可用配置的回归已加入；Runtime／模型注册表 34 项通过。缺配置时增加真实 Bot 编辑／原模型配置入口，不再提示不存在的“下方选择器”。新版实屏与首次真实回复仍待验证，未宣称修复验收完成。

### 2026-10-13 交流持久引用与 UI 修改状态

- 交流历史清理后复用原 Runtime 的精确消息 ID 读取内容，仅保留来源与关联；未进入 Runtime 的已取消消息保留必要原文。重启、隔离、去重及原文缺失明确报错等 52 项回归通过，长期清理后的实屏验证尚未完成。
- 顶部空栏移除及返回工作台入口已在隔离新包实屏确认；13 种头像形状和 11 种颜色按实际 Grok 的 5+5+3、6+5 排列显示。搜索／发送／子任务活动分类已接入原工具状态，6 项展示／动画相关回归通过；尚未做整体动画视觉验收。
- 前端／主进程类型检查、原消息回归和构建通过（首次发送修复前的版本）。按最新优先级暂停进一步 UI／动画调整，先解决上述核心使用阻断。

- 新版实屏结果：默认模型配置原先指向无法访问的内网 M2.5；通过原 `CustomModelDialog` 仅将隔离配置改为已配置 MiniMax-M2.7 后，“新建 Bot → 保持 modelRef=null → 首次消息 1013F → 你好，已收到”成功，控制库终态 completed。此前创建的空白 Bot 保留了未发送的 1013E 草稿，重新发送同样成功，没有重新建 Bot 或手工绑定模型。
- 真实入口“编辑 Bot → 管理模型与 API 配置 → 保存默认模型 → 返回 Bot 编辑”已验证；无泄露密钥、未新增模型配置存储。修复版前后端类型检查、构建、原消息回归通过。这只完成首次发送缺陷及默认模型路径验收，核心全清单仍继续推进。


### 2026-10-13 核心连续使用验收

- 1013G：真实 MiniMax 在聊天中调用 `bot_update_profile`，将同一个 Bot 改名为“新建流程验收 Bot”并保存用户指定职责。控制库 Bot ID、thread ID 保持不变，modelRef 仍为 null；无需新增 Bot 或换 Runtime。
- 1013H/H2：执行请求进入命令审批后，补充消息显示为 1 条待办；点击停止，两条任务最终均为 cancelled，审批与待办入口撤销，没有自动执行后续心算。模型提出的命令未按原要求等待，因此该案例只验证审批中取消，不作为实际命令终止通过。
- 1013I：停止后发送新任务，真实回复 19+23=42，并正确报出更新后的 Bot 名称；没有重新执行已取消的命令。实际运行中命令取消及排队完成仍在后续验收。

- 1013J/J2：正式界面单次批准 `node -e "setTimeout(() => console.log('QUEUE_TEST_READY'), 20000)"`，命令运行期间追加 J2，UI 显示 1 条待办。前轮完成后后轮实际执行，最终报告前一条命令输出 QUEUE_TEST_READY、14+28=42；两条任务控制库均为 completed。没有把“进入队列”当作最终交付成功。

- 1013K：通过正式审批单次启动等待 60 秒的 Node 前台命令，进程表实际记录子进程 PID 18761、父进程为隔离 Electron 主进程。点击停止后该 PID 消失，任务持久终态 cancelled。此验收覆盖本次普通 Node 子进程，不扩大为任意脱离父进程的原生命令隔离保证。
- 首次发送修复后的 Bot／IPC 全组回归：13 文件共 105 项通过。未借此宣称 Windows 或整套核心功能已验收完毕。

### 2026-10-13 文件交付与交接验收

- 1013L：真实 MiniMax 创建 `验收资料/核验 报告.md`、`验收资料/明细.csv` 并分别读取；磁盘内容与界面一致，三项金额合计 50.75。报告明确采用“实际−草稿”得 -2.00。
- 初次回复中报告路径含未转义空格，Markdown 未识别为链接；CSV 链接正常。已在 Bot 提示层说明角括号路径语法，同时在 Bot Markdown 的普通文本节点中兼容此类本地链接，继续通过原工作区边界校验与 FileViewer 打开。不改变普通会话、代码块和正常网页链接的解析，不复制历史消息。修复后重启，原历史回复的两条链接均可点击；Markdown 表格与 CSV 实际内容已实屏打开。
- 1013M：通过资料库将指定报告分享给“协作核验 Bot”，实际副本位于其 `shared/` 目录。该 Bot 真实调用读取工具，核验合计并给出副本链接；它沿用此前验收记忆的“草稿−实际”口径建议 +2.00。此建议不代表原报告的显式减法有误，不能把两个口径混为一谈。
- 验证：文件／工具／链接 4 文件 25 项测试通过；`typecheck:web`、`build`、`test:messages` 通过。随后 Mac 原生导出／导入完整流程及字节一致性核对通过，P08.1 已勾选；群附件及失败后的成果仍待验收，P08.3 保持未勾选。
- 同题 Grok 对照尝试进入“资料校对助手”后，官方客户端显示“无法刷新”，输入未成功写入；本轮不能记为 Grok 同题通过，后续恢复连接后继续。

### 2026-10-13 群资料入口补齐

- 原群任务已有共享工作目录，但群界面缺少资料操作入口。本轮沿用 `BotFilesPanel`、文件扫描、复制及预览模块，在既有文件方法增加可选 groupId；原私聊调用保持原行为。
- `LocalBotHost.getGroupMember` 统一校验现有群、当前成员及删除状态，浏览器范围校验也复用此方法。文件主进程适配负责解析目录，界面不能提交任意工作区路径；原生导入／导出对话框结束后重新验证成员身份。没有把私聊工作目录映射为群目录。
- 1013O 中两位成员实际调用 `read_file` 读取 `group-11bcbca5-473d-4024-be2b-827bffc85258/shared/6157cc0f-核验_报告.md`，各自返回 50.75 和 2.00；数据来自真实文件。分别保留成员原线程，结果显示在群时间线。
- 实屏发现群初次打开仍停在较早历史，尚缺少稳定的首次定位及回到底部入口；计入 P09.4，不将本轮附件成功当作群交互全部完成。


### 默认 Bot 后台编排接入（2026-10-13）

- 原 `createWorkflowTool`、审批、写锁、执行器与 journal/resume 整体复用；不复制 Bot 工作流实现。主进程 `workflowEnabled` 为可信调用参数，未放入 renderer IPC 契约；leaf 子 Agent 不继承该入口，普通会话默认行为保持不变。
- 自动编排提示词复用原工作流的异步回传约束，保留 normal 会话的完成验证和输出风格。普通／小任务继续直接处理；Bot 不需要向用户索要模式切换。
- 本地 Bot 的普通模式可接收工作流通知；内部通知必须由 Host 标记为 durable receipt，用户粘贴内部触发文本不能获得该身份。后台结果仍按原 notification owner 领取、成功后确认。
- 真实 1013W：Bot normal 元数据保持不变；工作流完成、`notificationDelivered=true`；父任务和唯一通知任务均 completed，实际报告分项 25.75／27.00，合计 52.75。Grok 同题自动交付相同结果和报告。当前记录仅证明脚本并行与自动回传，未证明实际子 Agent 的全部作用域或取消。
- 定向 Runtime／通知测试和最终提示词测试通过，node 类型检查及构建通过。完整 `test:workflow` 在旧 `sandbox-elevated` 源码断言处中断；新入口对应的通知门禁断言已更新以同时检查 Host receipt 身份。此前三项既有源码断言仍需维护，不能记为完整回归通过。


### 对话附件接入（2026-10-13）

- Bot 输入框附件采用已有资料导入、稳定 inode 文件复制和原文档解析 Worker；支持原 txt／md／csv／docx／xlsx／xls 内容提取，并保留原文件供浏览器上传及后续任务。其他类型保留文件引用，不声称已解析其内容。
- 共享原 `FileAttachment` 类型和聊天附件／发送构造；原工作台仍走原文件选择与解析。导入数量由输入框剩余容量控制，内容预算不超过原 24,000 字符；解析受原 5 MiB、Worker 内存和超时限制。用户关闭窗口后取消相关解析，文件句柄在异常时关闭。
- 支持 Bot 执行期间追加附件待办和仅附件发送；选择失败保留输入。已通过文件范围、容量、正文预算、关闭／归档重校验和解析失败的定向测试。相关 22 项测试、前后端类型检查和消息回归通过。
- [x] ~~1013Y：原生文件选择添加 CSV，仅附件发送；真实 MiniMax 读取保留文件并报告三项数据和合计 50.75。~~ 源文件与保留副本 41 字节一致，SHA-256 为 `4f5f1ec7e22275bdb1aada507230451ed14aee5f75f2d090f4adfc7f79bbd9de`。
- [x] ~~1013Z：新建默认 Bot 添加 JSON，通过专属浏览器填写本机合成表单、上传原文件、确认 JS 弹窗、下载并读取回执。~~ 实际上传文件名 `attachment-1013Z.json`；回执中名称为“青鹭-1013Z”、declared=52.75，items 合计 50.75，差额 2.00；任务 completed。保留副本与原文件字节一致，SHA-256 为 `2d5950486990e1c0c394c24f12bf389ef1ca9c3cd3305d3536c2cd1df60082a5`。本机浏览器样例不能代替外部网站登录、Windows 或全部 P12.3 验收。
- 导入文件改用独立 UUID 目录保留原文件名，避免网页上传带随机前缀，同时支持同名文件；中文／空格与 Windows 保留名称有文件回归。本轮相关 14 项测试、node 类型检查和构建通过。旧导入路径继续可读。
- 拖拽附件已接入同一保留／原文档解析路径：只接收文件名称和有界 bytes，不接受 renderer 文件路径；最多 3 个，每个不超过 5 MiB，字符预算沿用 24,000。按钮和拖拽共用输入锁、工作区／卸载校验与附件状态；主进程重复校验文件名、数量、体积和 Bot 归档状态。原普通会话仍走原路径。代码回归通过，拖拽本身、忙时附件、群组及关闭后的选择回调仍需实屏验证，P08／P12 父项不提前勾选。

### 1013X 实际子 Agent 与交付质量对照

- MiniMax 在一个工具调用批次派发两个实际 task 子 Agent，交付 sum.mjs／tests.mjs；父轮运行并检查，独立执行 4/4 通过。最初子 Agent 交付不符合两位小数输出约束，已由任务中的测试反馈修正，不能记为一次即正确。
- Grok 同题交付两个文件并报告 8/8，通过源码预览确认采用 BigInt 字符串金额转换。MiniMax 当前采用 parseFloat 再取整数分，未独立证明大金额精度；四项指定样例通过不能证明整个输入范围的正确性。这是明确的交付质量差异，P12.2 保持未完成。
- 原心跳静默处理会还原专用 heartbeat checkpoint；长期 Bot 会话不能直接照搬该清理方式，否则可能破坏持续对话。本轮已增加独立的可见性／通知策略（下节），未以 HEARTBEAT_OK 或删除 Bot checkpoint 代替。

### 例行任务静默与附件拖拽补齐（2026-10-13）

- 参考 Hermes `cron/scheduler_prompt.py` 的独立任务指令与精确静默标识契约，结合原 Cmb heartbeat 的完成通知处理；Bot 继续复用原 Runtime 和持久会话。仅实际完成的 schedule 来源且完整结果为精确标识时静默，普通消息、失败及标识后带实际正文均正常展示与提醒。
- 静默投影同时过滤提问导航，防止留下不可点击的空白导航；保留原消息、工具记录和 checkpoint。控制历史清理后在既有引用表保留例行任务来源／终态，不复制任务正文，重启读取来源不依赖最近 100 条快照。
- 1013AA 暴露模型保存例行任务时只写 `verify`，本轮已在工具 schema／说明及 Bot 提示层要求保存完整输入、路径、判断与通知条件。1013AB 的真实持久指令包含完整输入和通知条件，实际读取失败后的异常交付与重启读取通过；不把该提示约束视为任意模型都不会再生成短指令的保证。
- 参考 Grok `timeline-event-automation.tsx` 的来源事件展示方式，复用现有 `ChatMessagePresentationContext` 将可信 schedule 触发指令显示为可展开的例行事件，避免画成用户发言。原消息和权限归属不变；13 项可见性／导航回归、web 类型检查和构建通过，新版实屏展开／折叠继续验收。
- 本轮文件、来源保留、Host、Runtime 与静默投影 6 文件 88 项通过；随后导航与提示／工具相关 42 项通过。构建、node 类型检查及原消息回归通过；web 测试类型曾因日期 fixture 错误失败，修正后通过，最新接线继续检查。Grok 全核心与 UI／动画仍未完成，持续按原计划推进。

### 原 Runtime 回归断言复核（2026-10-13）

- 完整 workflow 回归的三项 sandbox 源码断言失败，核实为独立异步 Codex 解压模块、带通知所属方的领取参数和多行广播形式变化。断言已覆盖实际模块与参数，保留无同步文件访问、通知领取／失败释放／完成后确认等原要求；87 项 owning spec 通过。
- 消息队列接线断言按现有 context controller、人工决策早期终态通道、Bot 独立托管入口和 bizRetryPending 等待条件更新；完成 hook 检查使用实际失败分支边界，避免固定 2600 字符截断漏掉归属检查。52 项通过。最新完整 `npm run test:workflow` 与 `npm run typecheck:node` 均以退出码 0 完成；此结果不替代 UI、真实模型与跨平台验收。

### 回到核心使用流程的差距补齐（2026-10-13）

- 按 Grok `source/host/runner/tools/box-help-tool.ts` 核实，原实现缺少模型主动交出浏览器、显示操作说明及自动恢复的流程。现在 `bot_browser request_help` 复用已有 takeOver／等待／giveBack／observe，限定已观察的所属页面；重复请求不重复打开窗口，不泄漏其他 Bot 的说明，取消结束等待并保留用户正在操作的窗口。控制版本可防止旧卡片归还新租约，IPC 拒绝非法版本。
- 聊天等待卡片复用原工具展示扩展和 Button，提供“归还并继续”；原审批卡片优先，不被替换。右侧电脑同步显示说明；暂不建设 Grok 的远端桌面协议。真实 Electron 宿主已执行请求协助→显示说明→人工导航→按版本归还→读取新 URL，52 项 Runtime／工具／浏览器／IPC 通过，消息回归、node/web 类型检查和最新构建通过。真实 MiniMax 及卡片实屏仍未验收，P07.3 保持未完成。
- Bot 提示层适配 Grok 的交互节奏：用户直接交办复杂任务时先说明首步，后台触发直接工作；交付实际结果，开头确认不能代替交付。登录／验证使用专用请求协助，不让用户在对话中提供密码或验证码。五类来源的正反断言通过，模型实际遵循仍需实测。
- 连接应用入口直接复用原 MCP 设置覆盖层，关闭后保留 Bot 工作区；不增加第二套连接器。已构建，界面点击验证继续进行。
- 1013AD 真实 MiniMax 使用失败：模型实际导航合成页面后，仅在回复中要求用户手工输入，没有调用 request_help，Host 因 Runtime 正常结束记为 completed；没有取得人工控制权，也没有完成要求的返回观察与交付。已进一步明确任意用户要求的手动浏览器步骤都必须实际调用交出工具，文字说明不构成交接或完成；新任务继续重测，本次不计为通过。
- 1013AE 真实 MiniMax 已按新规则实际调用 request_help，聊天显示操作说明和归还入口；但旧实现的 5 分钟隐式等待上限先结束了工具调用，模型随后在仍由用户控制的页面上再次观察，造成任务仍为 waiting_user 而原请求卡消失。本轮删除该隐式倒计时：人工接管只由明确归还、任务取消或浏览器关闭结束；当前失败记录不计为通过，需用新构建重测完整归还续跑。
- 1013AF 再次仅导航并用文字要求接管，未执行实际交接，记录为失败。复核 Grok `createRequestBoxHelpTool` 后，将协助明确暴露为 `bot_request_browser_help` 独立工具，复用同一页面归属、等待、错误投影与取消逻辑；原 action 保留兼容已有调用。聊天卡片同时识别独立工具和旧 action。原 Runtime 完成校验只证明协议／任务状态完整，不能宣称验证了自然语言任务质量；没有添加依赖回复关键词的完成判定。
- 独立工具的群范围、错误回执、取消与必需页面参数已验证；用虚拟时钟证明等待 30 分钟仍保持人工控制、不读取页面、归还后恢复。相关 44 项测试和 node/web 类型检查通过。新的真实模型与完整手动输入验收仍待完成，P07.3 不勾选。
- 1013AG 完整人工接管通过：task `492f47c2-5358-42fb-a558-5a3243ea9c9a`、thread `b708f2cb-f722-429e-a250-628eccb6f006`。用户手动操作独立窗口并点击归还，generation 从 0 更新为 2；实际工具结果含 `交付名称: 111` 与“尚未提交”，最终回复及 Mac 聊天实屏均准确显示 `111`，等待卡片转为已返回。主动协助子项已勾选；P07.3 的整体按需预览／接管租约等范围仍继续复核。
- 接管期间补齐“打开浏览器”：复用现有 takeOver 接口，在同一活动人工租约下仅激活目标窗口，不改变 generation、不唤醒模型、不替换原协助说明；切换中、其他 Bot、过期控制权仍拒绝。独立窗口最小化时先恢复。单元验证重开／激活失败均保留租约、原等待可继续归还；浏览器／工具 20 项通过。聊天卡读取失败提供刷新入口，侧栏也提供重开入口；实际新版界面继续验收。
- 成果卡片参考 Grok 合成会话实屏及 `transcript-card/views/attachment.tsx` 的打开／保存职责拆分，用原 Cmb Markdown 路径解析与文件能力接线。仅 Bot 作用域的独立文件段落启用，网页、代码、越界路径与普通会话保留原行为；11 项呈现／静默回归、node/web 类型检查、构建和原消息回归通过。1013AH Markdown 卡片打开与原生导出字节一致，1013AH2 修正后的 JSON 卡片实际显示 name=111、total=50.75；模型首轮链接错误仍记录在质量差异中。
- 进一步核实 Grok `send-message-tool.ts` 的 attachment 文件交付协议后，增加 `bot_deliver_files` 薄层，使用原 `resolveBotWorkspaceFile` 和 `openStableFileHandle` 校验真实工作区／inode，仅读取有界元数据，句柄在异常与取消时关闭；不读文件正文、不复制文件、不扫描目录。每次最多 8 个，按规范路径去重；结果保存到原工具 transcript，UI 卡片复用既有预览／导出。56 项浏览器／工具／Runtime／呈现／附件协议回归、提示层五类来源 25 项、node/web 类型检查、构建和消息回归通过。原生浏览器宿主集成重新打开同一人工租约、说明／generation 保留及后续归还通过。
- 1013AI task `7194568c-f0f5-4e9e-8c0c-3db5890018bd` completed；实际交付结果包含中文空格报告 47 B 和 JSON 30 B，Mac 聊天显示两张带大小的附件卡片，打开 JSON 正确，原生保存副本 `verified-delivery-1013AI.json` 与源文件字节一致。文件为当前工作区引用，后续修改会改变预览内容，不宣称不可变成果快照；重启／群组真实交付继续验收。
- 1013AJ：两位群成员真实读取群副本，均核验 name=111、total=50.75 并调用交付工具；但群时间线当时只收集最终文字，缺少工具附件投影，不能记为群交付通过。修复为活动任务所属的独立群附件消息，保存有界路径／名称／大小元数据，按 taskId+toolCallId 去重，保留实际作者；不复制 Runtime 消息或 checkpoint。应用退出、取消、成员退出及群删除后拒绝发布，文件预览／导出仍重新核实当前成员及工作区。既有群表在原事务中添加可空 files_json，旧消息保留原表现。
- 1013AJ2：群 `8a2dfd31-d7de-4dc0-82b0-12b07d400e66` 中两位成员重新实际交付，任务 `280079fc-d6f5-4474-bb6b-9f8384838365` 与 `19a6cfcf-4619-40a8-a634-94576384a27d` 均 completed；群内出现各自作者的 30 B 附件卡片，打开显示正确群路径和 JSON，原生导出 `group-delivery-1013AJ2.json` 与群副本字节一致。群附件去重／迁移读取／成员退出／取消拒绝以及 Runtime、历史清理等 80 项测试通过；发布失败不显示成功附件的额外工具回归通过，node/web 类型检查、构建、消息回归通过。首轮模型成功而群 UI 缺失已保留失败记录；实际冷启动后的群卡片仍继续验收。
- Mac 原生退出后冷启动：群中两张附件卡片及真实作者／30 B 大小保留，切到私聊后原两张 47 B／30 B 卡片、工具记录和成果文件均保留；原群及 Bot 身份未新增或替换。该检查证明已完成任务的附件历史保留，不代替执行中崩溃或 Windows 恢复。群输入框当前仍无直接附件入口，已追加明确检查项，继续按核心流程补齐。
- 群附件输入已编码：原 `ChatContainer` 的附件 XML／展示名称构造提取为共享纯函数，原私聊与群发送使用同一格式；文件选择／拖入仍使用原解析 Worker 和稳定复制，BotClient／preload／IPC 增加可选 groupId，旧私聊调用保持默认行为。群草稿复用原 Zustand 状态，附件随面板切换保留；发送失败重用同一请求身份，成功仅消费已确认附件并保留后续草稿。限制最多 3 份、提取正文合计 24,000 字符、拖入单份 5 MiB；群消息总预算超限则保留草稿并报告错误，未截断用户任务。作用域改变或群草稿清理使晚到选择结果失效。17 项群草稿／IPC 回归、原消息回归、原队列消息内容测试、node/web 类型检查及构建通过；新正式界面与真实模型继续验收，检查项保持未勾选。
- 1013AK：通过群输入框的原生文件选择添加 `attachment-1013Y.csv`，不输入文字直接发送；任务 `c9a57a85-5c27-46d0-b6c3-d94e7238cdf4`／`5acee551-abc9-4d9e-92d4-b0339556a713` 均 completed。一位成员实际 read_file，另一位使用原解析后注入的附件正文，均给出甲=18.25、乙=7.50、丙=25.00、合计 50.75；群时间线实屏展示对应表格与结果，用户消息只显示附件名称。群副本 `shared/7b066298-821b-4741-b00f-d90330980145/attachment-1013Y.csv` 为 41 B，与原文件字节／SHA-256 一致。原生选择与仅附件子项已勾选，拖入、完整切换和跨平台仍待验收。
- 群后续任务的有界引用上下文补入附件名称、实际路径与大小，避免附件消息的空正文导致其他成员看不到交付引用。每条参考保持原 1,000 字符预算，完整路径无法容纳时明确省略，不截出貌似可用的半条路径；仍作为 Bot 来源的引用资料，不能成为新增授权。37 项控制／群作用域回归通过，node/web 类型检查和最新构建通过；后续模型按引用继续工作仍需实测。

### 新聊天附件与会话草稿衔接（2026-10-13）

- 官方 Grok 新聊天实屏在收件人尚未选定时提供“添加附件”；重建源码 `workspace/composer.tsx` 使用暂存附件、移除、文件选择与拖入。本次沿用此使用流程，在 `BotNewChat` 暂存有数量／大小上限的 File 引用，选定收件人后才调用已有 `attachFileBytes`，复用主进程的原附件解析 Worker 和工作区校验，不提前把文件写入任意 Bot。
- 新聊天转交支持已有 Bot、新 Bot、已有群及新建群。部分附件导入失败后重试复用本次已成功保留的文件；接收方变化重新按对应工作区导入，切换界面后的迟到结果不能写入其他会话。新增 Bot／群创建成功但附件失败时，可继续选择已创建对象重试。
- Bot 私聊附件改为随原 `ThreadContext` 草稿保留，继续使用原 `ChatContainer` 的附件列表、解析正文、发送及移除逻辑；普通工作台仍使用原附件状态。草稿仅保留文件描述及有界文本，不保留二进制。线程草稿摘要识别仅附件草稿；现有释放历史逻辑不清除草稿字段。不是退出应用后的草稿持久化承诺。
- 1013AM：先添加 CSV 再选择已有 Bot，切换群聊后返回，文字与附件保留；任务 `bc4be593-5c75-4b6e-a172-f755f094109f` completed。1013AN：先添加 CSV 与文字再创建双 Bot 群，切换旧群再返回，新群草稿保留且旧群为空；`3a61cc12-a8f2-487a-b386-48591bf76a90`／`71d39be5-a7ab-4d86-9508-e5c3df7bff70` 均 completed，群内均显示 3 条／50.75。1013AO：先添加 CSV 再创建全新默认 Bot，首条任务 `400fcd53-fd98-4d02-aef7-f813744fb559` completed，实屏同样为 3 条／50.75。
- 三条路径的保留 CSV 均为 41 B，SHA-256 均为 `4f5f1ec7e22275bdb1aada507230451ed14aee5f75f2d090f4adfc7f79bbd9de`。新聊天导入与群草稿 9 项测试、原消息回归、线程性能契约、web 类型检查及构建通过。群成员显示的中文名称通过粘贴验证，电脑工具直接 typeText 中文不完整不能记为输入法实测通过；后续仍需真正的中文输入法验收。

### 真实审批中断恢复与显示修正（2026-10-14）

- 1013AR/AR2 已完成实际预览进程 SIGKILL、冷启动、显式继续、重新审批与附件交付，具体证据见 P10.1；不是仅对 Host 测试替身进行重启。
- 续跑暴露的显示问题：原 DeepAgents 会补齐一条“工具已取消”的 ToolMessage，但不设置 error，导致 Bot 历史把旧写入标成“已返回”并出现文件预览按钮。沿用原恢复链路，仅在 Bot 展示层精确识别当前工具名称／调用 ID 对应的标准取消结果，保持“已中断”并隐藏该次调用的预览入口；普通工作台展示不变。
- `bot-tool-result-status.test.ts` 验证取消记录、标记错误的取消、普通文本及其他调用结果；2 项通过。原 `test:messages`、web 类型检查和构建通过。重新启动实屏确认旧写入仍显示“已中断”，新任务实际交付的 18 B 文件卡片仍保留打开／保存入口。

### 群头像与资料库可读性（2026-10-14）

- 群头像原实现使用可换行 flex，两个 28 px 头像减去 12 px 重叠后仍超过 42 px 容器，实际显示为竖排。参考 Grok 两成员对角、三成员三角排列，改为容器内比例定位；继续复用同一头像与动画时钟。实屏同时核对两成员、三成员群头像：均保持在列表图标区域内，三成员变更后历史消息保留。web 类型检查和构建通过。
- 官方 Grok 0.70.2 合成 Bot“浏览器交付对照”的资料库按文件名列出交付文件。当前 Bot 资料库仍列出工作区文件，比 Grok 的交付文件索引范围更广；本轮只修正长目录编号遮住文件名及不可用目录按钮，保留已有分页、原路径授权、预览、导入与分享接口。web 类型检查与构建通过；新版实屏只显示 attachment-1013Y.csv 文件名，点击后原 FileViewer 正确展示甲／乙／丙及 18.25／7.50／25.00，原完整路径仍用于授权与预览。不声称整个资料库与 Grok 完全一致。

### 群内收件人解析实测缺口（2026-10-14）

- 真实 MiniMax `1014B` 未完成要求的异步核对：模型把显示名称“收件人核验-1013AP”作为 `bot_delegate.botId`，存储层正确拒绝非成员 ID，但错误文案使模型误判实际已加入的 Bot 不在群内。最终自行计算 41.75，并使用缺乏实际接收者执行证据的“双方”表述。此任务不能计为协作或来源隔离通过。
- 对照 Grok `agent-messaging.ts` 的 ID 同事目录，以及 Hermes `bot_mode_dm.py` 的唯一名称解析：在已有协作工具入口复用 `host.peers(taskId)` 解析当前范围内的精确 ID／唯一显示名称，不模糊匹配，不跨群查找，重名要求明确 ID。投递仍经过原 Host 的任务状态、成员资格、自投递、深度及去重检查；未建立第二套投递链路。
- 工具错误沿用现有浏览器／交付工具的标准 `ToolMessage(status=error)`，附带重新读取目录的恢复提示，防止普通错误字符串被当作成功回执。实现与针对性测试进行中，真实重试通过后再记录结论。
- 修复后真实 `1014B2` 继续以显示名称调用 `bot_delegate`，成功解析为群成员：发起任务 `9d0e57c9-8362-437a-9d86-1642e4d6faa2`、接收任务 `8c9076ee-fdf4-4af3-8b93-f6ddf478a8d5`、回传汇总 `7af9cc35-b5cb-4f3c-a52f-447ccca8a0d0` 全部 completed。目标独立核对后回传 41.75，群 UI 出现目标回复与交流入口；未新增私聊执行，目标名称与版本未变，合成标记没有写入记忆。69 项工具／Host／Runtime 回归、node 类型检查和构建通过，前置群文件 IPC 等 80 项边界检查也通过。

### 2026-10-14：真实后台子任务与交付差异（1014E）

- 实际链路沿用原 workflow：独立 leaf 线程、父会话审批、工作流结束通知、父 Bot 继续复测、真实文件附件均已发生。测试 leaf 首次断言失败后自行修正测试中的错误消息断言，再次通过；父 Bot 收到后台通知后也重新运行测试。控制库仅有一条对应工作流通知任务。
- MiniMax 首次交付自己的 11 个测试通过；官方 Grok 同题交付自己的 9 个测试通过。实际下载 Grok 两份附件，并保存本地 MiniMax 首次产物后，使用同一份 39 项独立用例：MiniMax 37/39、Grok 39/39。额外严格解释“超过安全整数范围”为单项及每一步累计都需检查；MiniMax 仅检查最终累计，因此超额项抵消、临时超额后抵消未抛错。两题功能要求相同，但本地另要求用后台两个 agent，不能由此推断模型性能高低；本次仍不能声称交付质量一致。
- 隔离证据：`/tmp/cmb-bots-phase1-preview/quality-review/1014E-oracle.mjs`、`1014E-bot-first-delivery/`、`/tmp/cmb-bots-phase1-preview/grok-money-1014E/`；结果 `/tmp/cmb-bot-1014E-oracle.json`、`/tmp/cmb-grok-1014E-oracle.json`。不是仓库产品文件。
- 暴露状态缺口：后台 leaf 尚在执行／等待命令审批时，Bot 控制任务已 completed，侧栏误呈现空闲。已接入原 `useThreadStateSummaries` 的工作流、worker、审批与用户输入摘要，修正 Bot／群状态与头像；不另建后台执行状态或计时器，9 项定向测试、web 类型检查及构建通过，更新包的实际审批／取消验证继续进行。
- 原工作台保护回归：`test:desktop-agent-baseline` 的七组入口、租约、托管投递、无窗口确认等契约通过。首次遇到既有测试匹配 `const harnessAgentContext` 的过时文本（HEAD 原代码已为 let + 赋值），仅移除该断言中的 `const`，保留 Harness／trace／prompt 的调用顺序检查；未为通过测试改动执行链。线程摘要性能契约也通过。
- `1014E2` 给出两个失败样本后，真实 MiniMax 自行启动 `wf_b2862a4970cd` 修复并补独立测试；父 Bot 复测遇到错误消息大小写断言不匹配，保留失败样本并修正断言，再跑 14/14 通过后交付两份更新附件。独立同一 39 项用例复测 39/39，通过快照保存在 `quality-review/1014E-bot-revised/`，结果 `/tmp/cmb-bot-1014E2-oracle.json`。这是反馈修复成功，不能改写首次交付 37/39 的结果。
- 资料库任务结束刷新已接入同一 Bot／群的终态任务键（包含取消／失败后的部分成果），使用既有分页与扫描取消接口，不因流式 token、其他 Bot 活动或等待审批重复扫描；8 项状态投影测试、web 类型检查、构建通过，正式界面新成果自动出现仍待验证。
- 资料库自动刷新正式界面已通过 `1014F`：保持资料页打开，真实任务完成后新增中文 Markdown 文件自动出现；没有点击刷新。Grok 下载的原测试与本地修订测试也由外部 Node 再次执行，分别为 9/9、14/14；独立边界集合仍是双方修订后 39/39。

### 2026-10-14 原生后台命令接线（部分真实场景已验收）

- [x] ~~复用 LocalSandbox 原后台执行，增加可选的宿主接受／结算回执接口。~~ 接受落库失败不执行；已停止的轮次不能迟到启动；PostToolUse 与进程树清理完成后才发布结算。普通工作台未开启该接口，执行语义保持原样。
- [x] ~~Bot 命令归属与完成通知原子保存，停止抑制续跑，重启报告未知结果。~~ 使用现有 control.sqlite 与 Bot 队列；通知具有独立 command 来源，输出有上限并沿用 Mods 保护。重复、跨会话、容量与事务失败测试通过。原命令 PID 尚未额外公开，task ID 明确不冒充 PID。
- [x] ~~替换 Bot 根会话强制 workflow 路径。~~ 已有 execute 的 run_in_background 直接调用原进程管理器，原始 shell 脱离语法先拒绝且不启动；主提示词与工具描述不再要求为普通长命令额外创建 Agent。正反提示词及八种命令语法回归通过。
- [ ] 长命令运行期间回复新问题、完成后自动交付、停止与重启完整实测。1014Z 已验证忙时回复与自动交付；1014AA 验证通知隐藏和原文件交付；1014AB 验证显式停止真实 Node 进程且到原截止时间仍未生成文件。重启、复杂进程树与跨平台场景未全部验收。此前 1014X/Y 失败记录保留；不能以单元测试替代此项。

验证：`/tmp/cmb-native-command-unit.log` 90 项通过；`/tmp/cmb-native-command-bots.log` 141 项通过；node/web 类型检查通过；构建通过。跨 Runtime 回归仍在执行。一般前台工具已进入阻塞执行时的原进程 yield／新消息接续尚未完成，不能宣称所有忙时交互已经对齐。

2026-10-14 本轮回归状态：原 workflow 回归、messages 和 desktop-agent-baseline 通过。Bot／IPC／通知投影等 166 项通过；异步上下文隔离及作用域停止新增 86 项定向验证通过。完整 `npm test` 仍失败：47 failed、4543 passed、20 skipped、2 errors（`/tmp/cmb-native-command-full-regression.log`），并未执行 && 后续脚本，不能宣称全库通过；本轮 Bot 和后台进程相关测试无失败。此前 51 失败为前一轮结果，不抹去历史记录，也不将本次其余失败一概归为基线。

### 2026-10-14 忙时补充消息复用原 Runtime（真实验收进行中）

- [x] ~~核对 Grok send-turn-dispatch 与 Hermes interrupt_control 的忙时语义。~~ 两者都区分新消息与显式停止；Hermes 在工具执行中先保留 steer、支持时 yield 原进程。当前先复用原 Cmb 的 current-run-message-queue，在工具步骤边界加入新用户消息，不重开模型执行链或重启已有命令。
- [x] ~~Bot 宿主与桌面 IPC 复用同一提示词预处理、Hook、轮次和租约检查。~~ Bot 必须携带确切 owner/runId；桌面不能通过原 IPC 冒充 Bot 注入。仅私聊用户任务之间合并，群／例行／同事消息保留原来源及结果归属。
- [x] ~~注入前记录消费归属，沿原消息 ID 持久化并与主任务原子结算。~~ control 表新增 injected_into 列；单 Bot 仍只有一个独立执行轮次。未消费消息仍排队；取消消息不注入；已消费消息在重启后标为 interrupted，不重新执行；异常不伪装成功。
- [x] ~~真实 MiniMax 验证任务执行中补充要求、只执行一次、交付包含补充要求。~~ 1014AC/AC2：45 秒前台命令运行时接收补充消息，原队列 beforeModel 注入一次；两条任务均 completed，补充任务的 injected_into 指向原任务。ac-starts.txt 精确为一行 START，ac-result.txt 为 UPDATED_AC_42，两个附件均交付且实际打开预览确认。证据在 `quality-review/1014AC-steering/`（隔离测试目录）。普通前台命令即时 yield 仍未实现，只能在工具步骤边界读取补充消息；不能称为 Grok 全部忙时体验一致。

边界：原生后台通知暂不用于需要回传结果的 Bot 委派及例行任务；它们沿原托管任务等待最终结果，以免提前“已启动”丢失协作回传或静默判断。后续如果扩展，必须同时保留原结果所有者，不能只开启后台开关。

本次针对性检查：Bot 15 个测试文件 147 项通过；消息队列行为 40 项、接线 52 项通过；node 类型检查通过。跨 Runtime 回归与升级后实测继续，未替代全库及跨平台验收。

2026-10-14 后续验证：加入原 Runtime 就绪事件，启动准备期间收到的消息也会自动接入；不轮询。补充消息参与同轮记忆总结，缓存限 8 条。Bot 148 项通过；实际 Host 子进程 SIGKILL 后两次重启验证通过，新增已消费补充消息不重跑、未决命令只生成一次 outcome_unknown 通知（模型为确定性替身，非真实模型恢复）。

全库最新结果仍未通过：56 failed、4547 passed、20 skipped、2 errors（`/tmp/cmb-bot-steering-full.log`）。本轮 Bot 测试无失败；不能将全部其余失败自动归因于基线。workflow 顺序执行至最后接线测试时暴露移动代码后的旧文本／空白匹配，断言已改为保留同等语义约束，相关脚本单独重跑通过；完整链路仍待最终统一验收。

官方 Grok AC 同题对照：第一步完成并交付 ORIGINAL；补充消息因电脑工具输入延迟，在第一步结束后才真正送达。随后 Grok 更新为 UPDATED_AC_42，并交付两份附件、报告 START 仍只有一行。因此这次只证明后续修订和文件交付，不能算作 Grok 前台忙时插话实测；既有 V5/V6 才是后台忙时对照证据。

1014AD 新构建实屏：实际后台 Node 进程 PID 13889 在点击停止后由 SIGTERM 结束；命令回执 4168cba4-754f-492f-a32c-29d1a60d3d44 为 cancelled/suppressed=1，侧栏显示“后台任务已停止”，停止按钮消失。目标 stop-ad.txt 在启动 117 秒后仍不存在；完成通知数量为 0。证据保存在隔离目录 `quality-review/1014AD-native-stop/receipt.json`。输入框在运行期间保留普通“发送消息”及同一 Bot 占位文字；未消费消息仍有撤回入口。

最终补充：最新构建与 node/web 类型检查通过；原 `test:workflow` 全链路退出 0，消息回归及桌面入口基线退出 0。补充消息／适配层／UI 状态最近一组 51 项通过。全库 56 项失败的状态仍保留，不以针对性检查覆盖。

### 2026-10-14 前台命令移交与真实交付（1014AE／AF）

- [x] ~~复用原 LocalSandbox 执行链，在 Bot 私聊收到新消息时移交正在执行的前台命令。~~ 保留同一进程、原审批、Hook、输出上限、命令超时及终止屏障；持久接受回执成功后才释放模型等待。调用方结束不取消已移交进程，显式停止仍走原进程管理器。工作树、只读子 Agent 和原工作台不启用该路径。
- [x] ~~真实 MiniMax 忙时回复、原进程继续、自动通知与文件交付。~~ 1014AF：180 秒 Node 命令执行中回复 25；当时 PID 89042 仍在、结果文件尚未生成。结束后 PID 消失，启动文件仅一行，结果为 AF_FINISHED；命令 completed，一条完成通知 completed，原任务与注入消息均 completed。实屏打开交付文件预览确认内容。证据：`/tmp/cmb-bots-phase1-preview/quality-review/1014AF-foreground-handoff/` 的 during.json、final.json 和两份原文件。
- 官方 Grok 0.70.2 的 AE 对照先声称保留命令，随后报告原进程约 58 秒时已中断、结果文件不存在。此为界面与模型报告，未独立检查云端进程；不能据此推断所有 Grok 调用均失败。Grok 重建源码的条件式移交仍作为实现参考。
- CMB AE2 实际到达时命令已结束，不算移交验收；模型仍声称正在运行，属于交付表述错误。已补充要求依据最新执行回执回答、不能把用户假设作为进程状态，契约测试通过，更新后的真实模型复测待完成。
- 针对性测试 42 项通过、workflow 回归通过、上一构建通过。随后新增清理异常和原生移交停止测试，结果待补。完整 npm test 为 24 文件失败／546 通过／2 跳过，48 用例失败／4563 通过／20 跳过，另有 hooks runner EPIPE；未逐项确认基线归属，不能记为全量回归通过。
- [ ] 更新后真实模型状态表述、移交后显式停止完整实屏、跨平台与复杂子进程验证。P03／P12 的整体验收仍保持未完成。

### 新建 Bot 首次对话补齐

#### 2026-10-19 完整创建与首次选择对照（1019DL）

- [x] ~~1019DR Mac创建快捷键及原工作台边界。~~当前官方0.71.2实屏Cmd+N打开创建弹窗，本地同按键原本无反应；恢复源码global-keyboard-shortcuts.ts及当前renderer的sand.newAgent均把mod+n接现有新建动作，并允许在输入框使用。仅在Bots挂载期间使用一个可回收的keydown监听，匹配后才检查当前界面及现有＋按钮，复用其onClick／提交锁；不新增快捷键注册系统、Runtime、状态或计时器。已有弹窗／菜单／设置、组合态、重复及已处理事件均不触发；普通按键不进行DOM查询。
  - Mac正式界面：私聊与群草稿中Cmd+N均打开原弹窗；重复按键保留弹窗名称，Esc取消回＋且草稿完整。设置页和群上下文菜单中不打开弹窗；从连接应用返回仍正常；离开Bots到原工作台后无Bot弹窗，再进入仍可用。本轮仅取消、未新建Bot／群。清理自有私聊草稿时第一次全选未生效、只删末字；发送守卫阻止后续测试，已用原生精确选择清空并确认，未发送该草稿，不据工具操作失误修改产品输入逻辑。
  - 真实MiniMax／DeepSeek各一条明确私聊，均completed／零工具回复43。21/21核验通过：原1176任务、48Bot、11群、15例行、54命令、299文件和6163消息头保持；只新增两条本轮任务／四消息头，原39字符用户草稿与群空输入保持。27项定向、web类型、两辅助文件lint、格式和正常构建通过；旧预览及子进程正常退出后才更新。证据quality-review/1019DR-create-shortcut/{verification,tested-build,draft-protection}.json及实屏记录。Windows Ctrl+N、实际IME组合态仅自动规则覆盖，未记为原生通过；其余Grok快捷键及整体UI／动画继续按原范围验收。未commit／push。
- [x] ~~官方实屏从侧栏＋、名称／头像弹窗、创建中至首次问候与选项、点击后的追问逐步核对。~~ Grok 0.71.2 合成 Bot“创建流程对照-1019DL”先问候，再给 4 项真实选择；用户截图的另一新 Bot 是 5 项，说明文案与数量由模型生成。实际点击“写代码或管理项目”后，历史卡保留真实答案，Bot 自然追问代码位置，输入框恢复普通聊天。对照源码 `shared/agents/onboarding.ts` 与 `host/extensions/transcript/agent-lifecycle.ts`：一次性介绍触发、先简短问候、有选择用问答卡、逐题适应，遇到实际任务即开始；不照搬 SendMessage、云端主机或未接入连接器。
- [x] ~~侧栏＋改为复用已有 Bot 创建弹窗，完成名称／头像优先的创建流程。~~ 初始显示名称、大头像、原 13 种形状与 11 色；复用原创建／资料更新接口、提交锁与错误显示，空名称禁用，职责与原模型选择藏入可展开的“更多设置”。未增加创建后端或另一套持久状态。实际取消返回＋、收件人名称预填、取消后草稿保留、创建后草稿交接且不自动发送均通过。群聊和收件人入口保留在＋的右键菜单；群聊 Esc 返回焦点曾落到页面，已复用原弹窗 returnFocusTo 修正并实屏确认回到＋，失败现场保留。两次同色同形弹窗截图已保存；原创建接口失败显示分支保留，本轮没有伪造应用数据库故障来宣称实际失败恢复通过。
- [x] ~~原 introduction 触发、原 Runtime 与真实问答卡贯通。~~ 移除“介绍时不要调用工具”的冲突规则，空职责 Bot 先问候，再用原 request_user_input 提供一题 3—5 个选择；不设置默认答案或自动作答，不手写静态欢迎／选项或假助手消息。实际选项提交后自然追问；两模型接收到独立实际任务时均将未答追问标为 ignored，零工具回答 43。具体职责优先的两份新 Bot 各直接交付 ROLE_MM_1019／ROLE_DS_1019，未调用入门问答工具。四 Bot 完全退出、重启并逐一打开后仍各仅一份 introduction，原队列、checkpoint 和执行链不另起实现。
- [x] ~~真实 MiniMax-M2.7／deepseek-v4-flash 创建、回答、任务转交与重启验证。~~ 四个合成 Bot、共八份真实任务均 completed；两空职责 Bot 各真实提交一次首题，后续追问被实际私聊忽略，原选择回执仍保留；重启后又各零工具答 43。新聊天合成草稿在取消与创建后保留，未出现在模型消息中，验收后仅清除此合成草稿；原 39 字符用户私聊草稿未动。47/47 保全及真实回执断言通过；原 44 Bot、1,084 任务、11 群、13 例行、35 命令、295 份文件及全部原消息头保持，只有四份新工作区初始化标记新增。98 项定向测试、原消息回归、node/web 类型检查、格式与构建通过。完整组件 lint 仍为 1 error／4 warnings，HEAD 同文件同样五项，未隐藏或宣称全绿；位于旧 Bot 会话 Effect／依赖，不因本轮扩大改动。证据 `~/.local/state/cmbdevclaw-beta-preview/quality-review/1019DL-onboarding/`。
- 对齐边界：流程与真实交互完成上述对照；模型生成的问候／选项文字、原问答工具携带的选项说明不保证与 Grok 逐字相同，未复制其固定模型或虚构账户姓名。模型配置入口是本地可配置模型所需，默认收起；云端电脑、未配置连接器仍不冒充可用。头像整体轮廓及全套动画的 D01／D05 仍按原清单未完成，不由本次创建流程通过推断全应用一比一完成。
- [x] ~~1019DO 创建按钮禁用态实屏细化。~~ 再次打开官方0.71.2的＋弹窗，并对照已提取renderer的Lt.Action／HBe；本地继承共享Button的半透明白底，空名称时仍过亮。仅在bot-create-footer的submit:disabled用本弹窗现有前景／背景色定义弱化填充与文字，保留原disabled、提交锁与组件，没有改共享Button／Dialog、字体、动画或创建接口。正常Quit并确认旧进程及子进程消失后构建，实屏确认空白／全空格禁用、有效名称启用，Esc取消回到＋且未创建新Bot。已有DL双模型各一条真实零工具回复43；12/12核验通过，原1174任务、48Bot、11群、15例行、54命令、299文件与6159消息头保持，仅新增两条明确私聊。web检查、格式与构建通过；深色同形同色截图已保存，不以不同窗口尺寸的截图声称整体视觉／动画完全一致。证据quality-review/1019DO-create-visual/。

- [x] ~~新 Bot 首次对话与用户插话接入原 Runtime。~~ 对齐 Grok `agent-lifecycle.ts`／`shared/agents/onboarding.ts`：新 Bot 首次打开主动开启简短对话，有具体职责任务时沿原审批执行；用户先发来任务则优先处理用户。复用 Bot 队列、原 Runtime 和内部消息投影，不伪造助手历史。
- [x] ~~首次触发与入队原子保存及去重。~~ 重复打开、任务历史清理、失败和重启不重复启动。旧 Bot 不因升级补发欢迎；排队中的欢迎可被用户首条消息取代，正在执行的欢迎可接收用户补充。迁移、事务失败、重启、历史清理、权限与插话测试通过；实屏结果见后续记录。

#### 前台移交续验结果

- [x] ~~1014AG：更新提示词后的真实 MiniMax 根据已有结果正确答复 AF 已结束、退出码 0，不重新执行命令。~~ 正式输入框与流式答复已核对；未新增命令启动日志。
- [x] ~~1014AH：移交后台并回答 25 后，从会话停止实际命令。~~ PID 60547 在约 95 秒时收到 SIGTERM；命令记录 cancelled／suppressed=1，启动记录仅一行，没有完成通知，结果文件未生成。超过原 180 秒截止时再次检查仍无结果文件或续跑。证据目录：`/tmp/cmb-bots-phase1-preview/quality-review/1014AH-handoff-stop/`。
- 前台移交、原生进程完成／停止、清理异常、提示词与适配器合计 44 项定向测试通过，node 类型检查与构建通过。该结论限 Mac 已测试命令；不替代复杂子进程、Windows 或全部核心验收。

首次对话实测：1014AI 新建后未输入消息，真实 MiniMax 主动回复“你好！有什么我可以帮你的吗？”，内部 cue 未显示为用户气泡。1014AJ 在欢迎生成期间立即要求改名和计算，暴露隐藏内部 cue 被作为可见历史定位点的问题，原任务和补充消息均 failed，失败记录保留。已复用共享 `isInternalNotificationMessage` 修正定位：越过不进入可见历史的内部 cue，选择实际前驱，不插入假用户消息；beforeModel／afterModel、有／无历史四种组合回归通过，更新实包后继续复测。

1014AK 修复后实测：在新 Bot 欢迎生成时立即发送改名与计算要求，用户消息在 afterModel 注入原运行，Bot 通过真实资料工具改名为“核算助手-1014AK”，实际回复 25；父介绍任务、注入用户任务均 completed，无新失败。内部 cue 不显示为用户消息。1014AI 正常退出后重启并重新打开仍只保留一条欢迎和一条介绍任务。证据 `1014AI-AJ-introduction/AK-fixed.json`；AJ 首次失败保留。新建具体职责任务的自动执行、欢迎期间复杂工具审批仍需单独验证，不据此勾选 P02 全项。

本轮首次对话相关：Bots／IPC 共 171 项测试通过；注入队列 41 项及接线 52 项通过；node 类型检查、workflow 回归与更新构建通过。无新执行引擎、模型配置或 checkpoint 存储；持久状态仅在原 bots 表新增首次触发标记，任务继续使用原队列。

### 2026-10-14 活动形态动画复核

- 核对官方客户端实际安装包的 `Nx` 状态调度及形态层：阅读／运行／工作复用工作动作，思考为圆点、搜索为雷达、编写为笔、等待／协作为环绕。重建库的简单正弦摆动不足以代表官方当前效果。合成任务 1014AR 实屏观察到运行命令阶段保留角色头像。
- 在原 `BotAvatar` 中新增本地 SVG 活动形态，复用 Hermes 共享时钟、离屏／后台暂停与原 Runtime 活动投影；状态快速切换从当前混合值继续，减少动态效果时直接显示静态状态，不增加 React 逐帧更新或每头像计时器。未复制官方打包代码。静态头像选择项不挂载活动图形；隐藏形态不做逐帧图形更新。
- 状态切换／中途打断／静态偏好／资源生命周期相关 6 项测试通过，web 类型检查和构建已通过首轮；更新包真实任务及最终性能优化复验进行中。当前是形态切换改进，尚未实现官方完整几何变形、工作动作片段与逐帧时序一致，P09 动画项保持未完成。

### 2026-10-14 用户实屏指出的四项差距

- [ ] 头像侧栏：原最小宽度 218px，无法收窄；已增加 72px 头像栏、拖动吸附与键盘 Home／左右键收放，保留每个 Bot／群的可访问名称、选中／未读状态和原上下文菜单。对照官方收窄实屏，新建按钮移至列表下方。待新版拖动／键盘／重启实测。
- [ ] 忙时空输入只显示停止按钮：原 `managedTurn` 不论是否有草稿都会显示发送，已限定 Bot surface 有文本或附件才显示发送，普通工作台条件不变。待实际忙时输入／清空及审批检查。
- [ ] 普通工具记录默认不占聊天正文：原投影仅在整轮结束后折叠，已在 Bot 默认展示中隐藏执行中／成功的普通工具行，仍保留人工审批、失败、浏览器接管、成果与 Mod 卡；执行过程开关仍可检查原始记录。待活跃任务及开关实屏。
- [ ] 动画：新增状态形态只是部分进展，用户明确指出仍有较大差距；完整角色几何变形、动作片段、消息和面板切换仍须与官方实屏核对，不能按基础图形完成算验收。
- 16 项定向回归、原消息／stream 回归、web 类型检查与构建通过。真实 MiniMax 1014AR 完成文件写入、读取、20 秒 Node 命令与原文件交付；实屏观察思考圆点、审批时角色恢复及运行命令状态。此任务只证明该路径运行，不代表动画与交付质量整体对齐。

### 2026-10-14 头像轮廓、鼠标响应及动作连续性

- [x] ~~核对官方当前头像编辑器及指针/活动调度实现。~~ 官方实屏显示圆润的水滴、楔形、星芒与花瓣，眼睛随朝向偏移；官方 `ex` / `setGaze` / `setEmphasis` 分别处理指针方向与强调，工作状态使用多个动作片段。不能用静态图标加循环旋转视为相同效果。
- [x] ~~修正本地头像轮廓与比例。~~ 保留 Hermes 形状契约，以本地曲线调整水滴、楔形、六边形、花瓣、星芒等轮廓，统一眼睛尺寸与间距；预览实屏已查看全部 13 个选项及详情大头像。头像编辑器 Portal 改为独立中性色，避免继承原工作台的蓝色选中样式；普通工作台不变。
- [x] ~~增加共享指针跟随、弹簧回正与连续眨眼。~~ 指针事件仅保存位置；按动画帧批量读可见头像位置后更新 SVG，无 React 逐帧渲染、无每头像监听器。保留速度处理快速反向、离开和回正；减弱动态效果时立即归零，最后一个头像卸载后解绑监听器。窗口隐藏/离屏暂停沿用 Hermes 时钟。
- [x] ~~运行状态改用有停顿的观察、转向、低头及回正动作。~~ 本地编写动作节点并通过平滑插值衔接，保留原 Runtime 状态来源；修正 60 Hz 时钟因时间戳小数产生的跳帧。未复制官方打包动作数据。
- 定向测试 12 项通过，覆盖快速反向、30/60 Hz 一致轨迹、隐藏后恢复、静态偏好、动作循环连续性、时钟暂停/销毁与状态映射；web 类型检查和构建通过。日志 `/tmp/cmb-bot-avatar-attention-{unit,web,build}.log`。
- [ ] 官方完整三维轮廓变形、全部动作片段及时间曲线仍未一比一复现。当前电脑工具没有独立 pointer-move/视频接口，静态截图不能证明完整悬停过程的流畅程度；本项继续实屏复核，P09 整体动画验收不勾选。

四项差距实测补充：侧栏 Home 收到 72px、Right 展至 218px 已实屏确认，页面刷新仍保留 72px；拖动和完整进程重启未在本轮复测。真实 MiniMax 1014AS 空输入忙时仅有停止按钮，普通读取行隐藏，打开“执行过程”可查看历史工具；又发现 queued 命令行仍出现，已扩展普通行过滤到 queued/awaiting_approval，实际审批分支仍保留。新条件下真实审批及忙时输入/清空尚待复验。

### 2026-10-14 D02/D03/D04 实施续记（未完成实屏验收）

- 官方合成群聊实测：真实键盘输入 @ 后出现“所有人”和本群三个 Bot 候选；输入框沿聊天内容区域布局。仅通过 AX setValue 写入字符不会触发同一候选状态，已用实际键盘复核；未发送对照草稿，已清空。
- D02 复用原 Radix Tooltip/ContextMenu，通过 asChild 保留同一个按钮与右键目标；仅折叠栏显示名称提示，右键打开时关闭提示，支持键盘焦点。未增加每行悬停计时器或外层布局容器。D03 将群消息与输入框改用同一内容宽度及边距规则，修正原 1000px/800px 两套上限导致的不齐。
- D04 沿用原群草稿、附件、requestId 重试和 sendGroup 入口，增加草稿提及范围与成员 ID，候选使用原文件提及组件的键盘/焦点交互方式；不增加模型或执行链。手输/粘贴普通 @ 文本不按显示名称冒充已选择的成员；候选选择绑定 ID，重名/改名不改变目标，成员离群明确报错。未提及继续沿用当前群默认收件策略；老的手动收件草稿保留并提供恢复所有人的入口。此默认策略仍需与官方未提及场景进一步对照。
- 群草稿、提及、历史与消息分组 23 项测试通过，覆盖旧草稿兼容、重名 ID、范围编辑、离群拒绝、附件/请求 ID 保留；原 test:messages、web 类型检查通过。构建与真实选择/发送/截图验收继续。D02/D03/D04 保持未勾选，不能由测试通过直接认定体验对齐。
- 1014AT 实屏续验：键盘 @ 选择“收件人核验-1013AP”，第一次 Enter 仅确认成员，发送计算 27+14+33+6 的请求后，真实 MiniMax 返回合计 80、平均值 20.00。控制库仅有一条对应任务 `1d25ca76-3226-40c9-8bdc-e79883e2ad56`，目标为所选成员，终态 completed；未派发其他成员。群输入框已与消息外沿对齐，折叠栏键盘聚焦能显示名称 Tooltip。多人提及、中文输入法、发送后成员标记、不同宽度及指针悬停完整过程尚未验收；整项仍不勾选。更新构建通过，日志 `/tmp/cmb-bot-group-mentions-build.log`。

### 2026-10-14 群历史提及与双成员派发（1014AU）

- 官方合成群历史实屏确认：成员提及是可点击的身份入口。当前实现此前只有草稿 ID，发送后退化为纯文本；本轮沿用现有消息表、IPC 和群草稿增加可选提及范围，旧消息不按名字反推身份。原 Markdown 渲染器通过仅在群消息启用的上下文显示提及，普通工作台默认路径不变；代码、链接和不匹配范围不误转成员按钮。
- [x] ~~新群消息持久化提及 ID，校验收件人一致性，并保留同一请求的去重语义。~~ 旧库迁移、重新打开 Store、改名、错误范围、额外收件人、所有人范围、附件前导文字、丢失响应后草稿恢复均有定向测试。67 项针对性测试通过；收件人校验补强后相关 48 项再次通过，前后端类型检查、原消息回归及构建通过。日志 `/tmp/cmb-group-persist-{unit,final-unit,web,node,messages,build}.log`。
- [x] ~~真实 MiniMax 双成员提及只派发两次，历史可点击打开对应成员。~~ 1014AU 用 Enter 选择 AP、Tab 选择 AJ，然后发送；群消息 `cd3ef51b-6354-46b6-b9ab-7a70d5e767bd` 保存两个稳定 ID，任务 `4b8bd2cc-915f-4db8-89d3-3db500d1d0e9` 与 `89a548db-6b96-4c99-a4ab-cebf0cdd85fe` 均 completed；两者各答自己的正确名称和 15，第三成员未运行。历史展示两个蓝色成员按钮，点击 AJ 打开其私聊。未用名字猜测或伪造完成结果。
- [ ] 仍待验收：中文输入法、所有人及未提及的官方派发规则、附件同题实屏、成员移除/删除后的完整界面状态、Bot 输出中的提及协议，以及整体 UI/动画。D04 整项不勾选。
- [ ] 新发现的身份问题：此前真实群历史中 AJ 在 17:22:41 自称 AP；1014AU 明确要求名称时两者正确，但不能据此消除此缺陷。需继续核对群历史来源、当前身份注入及模型实际行为，不能仅追加提示后就判定修复。
- 1014AU 页面刷新、重新进入 Bots 后，两处提及按钮和结果均从持久历史恢复。升级兼容复核另补一项：旧版本未确认发送的请求若原本不含提及元数据，重试保留原 ID 与原载荷，不因补充元数据再次交办；群草稿 14 项回归通过（`/tmp/cmb-group-legacy-retry.log`）。此补丁尚待更新实包，不将当前运行包说成已包含它。

### 2026-10-14 群聊身份续验（1014AV）

- 源码核对：Grok 重建库 `system-prompt-assembly.ts` 单独处理身份与 sharedRoom；本地已经注入当前名称，但群引用只带作者 ID。现补充当前 Bot 稳定 ID、引用中第一人称的归属及历史错误自称不覆盖当前资料的规则；群引用附当前成员名称，仍以持久作者 ID 为准，不改原 Runtime 或替换模型输出。
- 81 项 Host/Runtime 适配回归通过，前后端类型检查及构建通过；新版隔离实例已启动，包含上述身份说明及旧版未确认草稿重试兼容修正。日志 `/tmp/cmb-group-identity-{unit,types,build,live}.log`。
- 官方合成群与本地 `身份群核验-1014AV` 发送相同普通问候（未 @）：三位成员均各回复一次。官方三位报出各自名称；本地 AK、AP 报出各自名称，AJ 用“协作核验助手”称呼自己，没有冒用 AP。本地三条任务均 completed：`040c018f-56eb-48de-a476-8b47842fc59e`、`809ef4f9-0716-41a6-961a-7869a3bcd743`、`d3458e86-3e81-46a6-8939-60930e6642a4`。
- 此时旧群成员已被用户移除至只剩一位，未为验收恢复或覆盖用户变更。故 1014AV 是新群样本，不能代替原受污染历史的复验；身份问题保持待验收。未提及的这一普通问候场景行为一致，不推断所有定向请求的默认派发策略均一致。

### 2026-10-17 阶段提交前检查

- 按用户要求保存当前阶段至 `devclaw-bot-beta`。推送前 fetch 确认本地 HEAD 与远端一致；差异格式检查、增量密钥格式扫描通过，未将隔离测试配置、模型密钥或任务数据加入提交。
- 当前补跑 Bot／工具并发／界面派生／共享文件契约回归：53 文件、460 项通过；原 `test:messages` 与 `typecheck:node` 退出 0。最新 1017AI 的 web 类型检查、定向 lint／格式及构建也已通过。日志 `/tmp/cmb-prepush-{bots,node,messages}-1017.log`。
- 这次提交保存已完成的代码及验收记录；未完成项继续按原清单推进，包括完整 Grok 使用体验／动画、其余真实模型场景和 Windows 实机验收，不将阶段推送记为一期交付完成。

### 2026-10-19 排队群讨论恢复续验（1019DX）

- [x] ~~1019DX2 Mac真实排队讨论在正常退出后恢复且不重复。~~ 同一已测构建、原两Bot／模型；MiniMax私聊c1cb12c3…真实等待未答卡，DeepSeek群任务0c3d9bef…零工具发布合成草稿，MiniMax讨论7b01f4f2…确实queued且尚无Runtime消息。原生Quit后全部预览进程为0，私聊interrupted、讨论保留原ID；同配置重启后该任务只执行一次并实际在群中更正84+17=101，DeepSeek零工具pass，游标清空。没有续跑未答私聊、代选或把私聊nonce放入群。37项有界证据核对通过；原1234任务、59Bot／17群／15例行／54命令、325文件及6334消息头保留，最终1242任务／0活跃／0游标；mask39字符及另一份506字符草稿哈希不变，恢复最新用户所选MM私聊且空输入。全程无生产代码、配置或模型更改；原已测源码／产物SHA保持。证据quality-review/1019DX-group-queued-restart/{verification,second-before-quit,second-after-quit,final-results}.json、原生AX／截图与verify.py。首轮真实用户Go、首版诊断误计自身shell及验收器误用不存在task_id字段的记录均保留，后两者只修验收脚本。活动任务强杀／断电和Windows仍未覆盖，不关闭父项；本轮未commit／push。

- DX首轮确实观察到私聊waiting_user、同伴discussion任务a6a947f3…queued及同一群游标。排查用户报告的源码缺失期间，私聊卡在01:45:40 UTC收到真实Go选择后正常结束，同一排队任务随后仅执行一次并更正73+18=91，末位pass；因此该轮只证明队列正常释放与私聊隔离，尚未执行退出／重启，不计重启恢复通过。最初题目要求的长标题触发原工具12字符schema校验，模型改短后重新提问，此错误回执保留。证据quality-review/1019DX-group-queued-restart/{before-quit,latest-before-quit}.json。

### 2026-10-19 阶段保存（用户要求先 push）

- 保存当前 Bot 核心行为、创建与收件人流程、问题卡片及群协作改进；本轮群讨论继续使用原任务队列与 Agent Runtime，未新增独立执行链。
- 最新群协作交付构建：Bot／共享契约 25 文件、391 项测试通过；node／web 类型检查、定向 lint 和构建通过。真实 MiniMax／DeepSeek 的群交接、停止后新任务和正常重启证据检查 42/42 通过，证据位于隔离预览 `quality-review/1019DW-group-discussion`。该结果仅覆盖所列场景；全量 lint 的既有失败未记为通过。
- 推送后继续高优先级项：真实排队讨论的重启恢复、文件／浏览器任务的群内复核，以及剩余核心使用流程和 UI／动画对照；Windows 实机、完整交付质量和未完成父项继续保留未勾选。隔离配置、模型密钥、任务数据及截图不进入提交。

### 2026-10-19 非预期本地文件缺失（1019DY）

- 用户截图出现源码／测试夹具删除，暂缓界面续验并核查；本轮未执行清理命令、未运行源码测试，预览新增任务只有私聊选择卡与零工具群任务，原命令总数仍为54；当前无协作子Agent运行。这些事实不能替代全系统逐进程审计。
- 系统File Provider日志能够关联 `worker-message-window.ts`：父目录fileID68391537、脱敏名w{19}w.ts、原544B及docID9563635一致；09:15发生eviction/dataless，09:37:49出现create-item actual:nil与`delete … why:item rejected`。对应v1目录File Provider状态也明确报iCloud额度不足。确认同步链路异常，但尚未证明其余文件逐一由同一进程删除，也不能把额度不足单独当作删除原因。
- [x] ~~恢复当前14份非预期缺失的HEAD跟踪文件并校验。~~恢复前保存清单、索引差异与原件；仅对不存在的路径用O_EXCL创建，已有文件不覆盖。14份均与当前HEAD逐字节一致，删除清单归零；恢复索引时现有post-checkout钩子返回缺失错误，索引结果已独立核对，未新建或修改钩子。剩余差异仅plan更新，无commit／push。证据`quality-review/1019DY-unexpected-deletions/{report,recovery,deletions-before-recovery}.json`及系统目标日志。
- [ ] 环境层原因仍需继续观察；未修改iCloud配置或移动仓库，不将一次恢复说成已消除系统同步问题。
- 后续4份带“ 2”的未跟踪副本已逐一核对：两份remote-reply JSON、examples及resources各一份hooks JSON，全部与原件逐字节相同，原件均匹配HEAD。系统日志分别在10:25:49、10:26:04、10:29:29、10:34:06记录fileproviderd PID749／iCloudDriveFileProvider的create-item，原因为itemChangedRemotely；日志中的4个inode与副本实测一致，确认本地落盘来自iCloud远端同步。云端最初的命名者、为何产生编号副本及与早前删除的完整因果链仍未证实；没有删除／提交副本、改同步设置或迁移仓库。证据`quality-review/1019DY-unexpected-deletions/{latest-duplicate-audit,duplicate-actor-proof}.json`及对应系统日志。
- 又观测到`worker-message-window 2.ts`（544B，与原件及HEAD一致）；inode262591404对应10:39:56同一fileproviderd的远端create-item记录，已保全`later-worker-duplicate.json`和对应系统日志。当前5份编号副本均留存，Git索引也出现新增条目；本轮未执行git add，尚无足够证据归因索引写入者，后续提交必须逐文件审阅，不把同步副本混入功能提交。

### 2026-10-19 群文件自动复核与验收判据复核（1019DZ）

- DV判据复核纠正：原题只要求“Read the attached CSV original”，并未指定read_file；实际模型输入的附件XML完整包含原63B CSV且没有truncated标记，下载原件与该63B逐字节一致。此前仅凭没有额外read_file便认定未读原件，是验收器加入的额外假设，不能据此判Bot缺陷或修改公共Harness。历史41/42报告与模型动作不改写；重新打开变更／截断文件的能力、整体验收仍须另证。检查见quality-review/1019DZ-group-file-review/dv-read-criterion-reassessment.json；上文DV的原判断以本条更正为准。
- [x] ~~1019DZ 原群轮次的真实共享文件草稿—同伴复核—双文件交付（Mac，交换模型角色）。~~ MiniMax初始d4a8d086…仅写／读／交付草稿，DeepSeek讨论c7b45a10…实际read_file原CSV及草稿，写／读最终报告并交付报告与原件；反向DeepSeek初始b68eba95…仅写／交付草稿，MiniMax讨论6b54f512…实际重新读取CSV、写／读／交付最终两文件。两题均只定向首成员，不用bot_delegate、命令、记忆、例行或私聊；无需第二条用户消息。两份最终报告从聊天预览实际打开，并与两份CSV分别经原生保存窗口下载；报告逐字节等于工作区产物，CSV均63B、SHA67851b77…e6833b7，三条ID／金额、合计11.33 CNY与差额0.03正确，原件与两份草稿保留。
  - 官方同类题由REFERENCE交草稿、真实提及MIXED后由MIXED交最终报告及原CSV；两份原生下载的内容／SHA与本地数值及原件一致。官方成员自述用了命令写文件，违反本题“无命令”约束；其云端工具不可独立查看，未把自述当实际工具证明。本地实际工具仅write_file／read_file／bot_deliver_files。
  - 43项限定证据核对通过，原1242任务、59Bot／17群／15例行／54命令、325文件及6354消息头保持；新增6个群任务全部completed，4份新报告文件，最终0活跃／0游标。MiniMax发起题末尾多一条零工具汇总后结束，DeepSeek发起题末尾pass；没有说成两题都静默或无限追问。两份原草稿哈希保持，恢复用户所选MM空输入及官方MIXED原未答问题。证据quality-review/1019DZ-group-file-review/{verification,final-results,final}.json、原生预览／保存截图、downloads与verify.py；沿用已测构建，无生产代码或配置改动，无commit／push。浏览器自动复核、多群并行、运行中强制重启、完整UI／动画与Windows仍待验，不关闭P05父项。

### 2026-10-19 Bot群发言的成员入口（1019EA）

- [x] ~~1019EA 新Bot群发言的精确全名身份入口及Mac双模型点击／重启。~~ 官方DZ接力消息中的同伴提及可点击；本地此前Bot发言强制mentions=[]。参考Grok／Hermes当前群成员匹配，复用既有mentions_json、UTF-16范围、BotInlineMentionsContext、BotMentionLabel及Markdown过滤；生产只增加30行纯绑定函数并接入原Store及群渲染，普通Runtime／IPC／新状态表均未改。新结果落库时绑定群内唯一完整名称，重名不猜、旧历史不回填、用户普通@粘贴规则保持；targets仍为空，不由展示注释改变派发／授权。
  - 404项Bot／共享契约／提及回归、node/web类型检查、原test:messages及构建通过；新增测试覆盖Unicode位置、重名长短名、邮箱／未知长handle、128上限、重开Store／改名后的原ID、重试与无额外入队；既有Markdown测试覆盖代码与链接排除。定向lint无错误，群组件第148行现有ref清理warning与HEAD一致，未修改该取消逻辑或抑制警告。
  - 真实MiniMax d2bf1c5e…与DeepSeek23ca17ea…分别输出对方@全名，数据库保存准确对方ID／范围，实际点击均进入正确私聊。正常Quit、所有预览进程为0后以同构建重启，历史身份入口仍可点击，原任务／消息头／文件未新增或重跑。39项限定证据核对通过；原1248任务、17群／15例行／54命令、329文件及6393消息头保持，新增5个零工具群任务均completed，0活跃／0游标；两份原草稿摘要保持，恢复MM空输入。59个Bot中MM头像在验收期间变为绿色#00c972／版本4，用户随后明确确认“是我改的”，保留该主动修改；其他档案字段一致，原严格全档案不变的失败报告、精确差异与用户确认记录同时保留，未回滚用户外观。
  - 原DeepSeek发起题后，MM可选讨论多发一次无工具确认，再由DS pass；该回复不由提及注释触发，当前只关闭身份展示／点击子项，不声称群回复节奏、完整UI／动画或Windows已对齐。证据quality-review/1019EA-bot-member-links/{verification,verification-first-profile-change,profile-diff,tested-build}.json、模型实际任务、原生点击／重启AX、404项日志及verify.py。无commit／push。

### 2026-10-19 群浏览器结果自动复核（1019EB）

- 验收方案先于任务记录：使用原群轮次、原Runtime和群成员独立浏览器，真实MiniMax／DeepSeek交换角色验证“首成员读取网页并交付待核草稿→同伴在自己的页面重新读取原网页→纠正金额并交付文件”；初始只定向首成员，不用私聊委派或新增用户催办。以本机合成HTTP页面及请求日志核对真实浏览器读取、精确页面归属、没有额外表单提交、结果／文件和有限讨论；保留用户新建Bot、现有头像与两份既有草稿。官方Grok的云端不能访问localhost，需单列环境差异，不以本机服务成功冒充云端同题通过。源码参考原CMB群浏览器工具接线、Grok有界轮次及Hermes群消息资料规则，不新增浏览器或调度体系；实测发现明确缺口后才改生产代码。
- [x] ~~Mac双模型交换角色的网页独立复核及最终报告／原始CSV交付。~~ MM初始606e467f…→DS讨论838e9dd0…、DS初始b0e63f3f…→MM讨论764d592d…均只需一条定向用户消息；两位实际导航同一原网页、使用不同pageId，复核者点击页面下载链接、生成并读回报告，交付报告与63B原CSV，精确关闭各自页面。两份最终报告从正式成果入口打开并原生保存，下载报告与工作区一致、两份CSV与服务端原件SHA e17d977b…8546cea一致；各行31.40／-2.10／0.07、合计29.37 CNY及相对29.30的+0.07正确。服务端仅4次页面GET和2次CSV GET，无POST。原1254任务、60Bot／17群／15例行／54命令、330旧文件及6406旧消息头保持；新增6条completed群任务、6文件，0活跃／0游标。两份既有草稿仅哈希复核保持，恢复本地sean和官方陈星越的原空输入；合成服务SIGTERM退出143。沿用EA已测构建，源码／产物哈希保持，无生产代码改动或commit／push。
  - 官方0.71.2在自身云端准备等价页面及同组接力，实际最终报告554B、原CSV63B已从界面下载，数字／版本及原CSV字节一致；只允许其云端合成环境准备命令，未让本轮操作连接的Mac。官方首次声称无法附文件，后经同伴提醒补齐正式附件；这是官方本题的中间失败，不能说本地也漏附。其远端工具轨迹无法独立核查，云端页面准备与本机预建服务的差异单列，不推断整体优劣。
- [ ] 本题全部行为约束／完整群回复节奏：本地MM发起题末尾多发一句无工具完成确认，DS发起题后DS pass；额外确认仍不符合任务要求，未用过滤器掩盖、未宣称完全对齐。40项限定交付／证据检查通过，fullTaskConstraintsPassed仍为false。首版验收器用task.message子串划分任务，误把新群任务携带的旧背景算入；已改为真实用户消息及origin.messageId，原39/40失败报告保留，未改产品或历史记录。证据`quality-review/1019EB-group-browser-review/{verification,verification-first-oracle,final-results,final,server-stop}.json`、下载原件及界面记录。多群并行、运行中强制恢复、Windows、全UI／动画与完整长程质量仍待验，P05父项不勾选。

- 1019DY后续观察：跟踪删除清单继续为空；目录另出现3份带“ 2”的未跟踪同名副本，逐字节等于已恢复原件。已记录大小／SHA和创建时间，原样保留且不纳入本轮源码改动，未用清理命令删除。该现象支持继续排查同步命名冲突，仍不据此将全部文件逐一归因；见1019DY/later-conflict-copies.json。

### 2026-10-19 用户要求清理后提交推送（1019EG）

- 提交前逐一核对8份带“ 2”的副本：全部与不带编号的原文件及HEAD逐字节一致。按本轮用户授权，先完整备份到非同步的quality-review/1019EG-push-cleanup/removed-copies，再仅移除这8份副本及其新增暂存项；原文件保持，无跟踪文件删除。清理清单保存大小、SHA、原路径及备份路径，不按文件名批量清理其他内容。已有5份的File Provider事件与inode对应；其余副本虽然同样无关，不据相同内容推定全部创建来源。
- 后续开发尚未迁移目录、未修改iCloud设置。原目录过去正常不排除当前发生同步变化；此前日志只能证明具体本地物化事件，尚未确定远端起因或保证以后不会再次生成。提交严格限定已审阅的6份Bot代码／测试／plan文件，不把清理副本加入生产改动；下一项1019EF在本次push完成前暂停，尚未新建群或发送验收任务。
- 清理后重新运行26文件／398项Bot回归、node／web类型检查及原test:messages，全部通过；改动文件Prettier通过、ESLint零错误，群组件第148行原有ref清理warning与前次一致，未抑制或顺带改动。EA及ED的真实MiniMax／DeepSeek任务、正常重启和强制中断证据继续沿用已测构建，本次清理没有改生产源码或重新覆盖运行中的out目录；相关日志保存在同一1019EG目录。
- 官方恢复行为边界补充：1019ED的中断提示是本机进程崩溃后的反馈修复，不能称为官方同款恢复策略。Grok 0.18重建源码group-chat-glue.ts将单成员运行失败当作pass，群级异常进入trayErrors；私聊抢占后的有界redrive不是进程崩溃恢复。当前官方0.71.2云端运行时未进行崩溃验收，关闭其客户端与终止本地Bot Host不等价，未据重建旧码推断当前云端行为一致。

- 1019FB续验：群后台三分支实测，预期清理精确静默且留审计，新结果文件18B唯一交付、真实退出7唯一报告，同Bot私聊43独立完成；官方先启动但漏了两次完成通知，反馈后补交，保留首轮。现有例行静默复用至命令通知，不引入新存储／队列；243相邻回归、node/web类型、原消息回归和构建通过，重启12张控制表与38记忆文件全哈希相同。为覆盖私聊、未读与重启反例新增B15，清单201例；该项及整体仍待闭环。另M3回复夹带内部ID／工具名，沿现有一段提示收敛表述，正在新构建／实测，不添加输出分类或过滤。

- 1019FB B15私聊R2：真实M3已按每事件回执精确静默且不增加未读，新文件／失败唯一回传；实屏仍外露控制标记，因原内部Human未保留可归属的轮次边界，故不关闭。正在复用原续办脱敏边界、原广播／持久化与来源查询，并在既有轻量archive保留来源；可信成功命令专属，普通线程、权限、执行及表结构不变。8文件283项及adapter新增94项已通过，R3实屏及重启待验，失败记录保留，未commit／push。

- 1019FB B15私聊R3真实复验已完成：三命令各一次，清理精确静默且不额外未读，18B原件界面保存与官方同字节、真实exit7一次报告。字面三行控制文本双方正常显示；一次附加字符数误报已由M3真实工具17+1=18纠正，首轮保留、不修改原文件或增加输出过滤。正常重启12表／38记忆哈希全同，原消息回归、node/web类型和构建均通过；新轮次脱敏边界／标记在重启历史中不显示，旧失败现场不改写。当前构建群R3正跑三分支，父项未勾选。K04修订正文与独立oracle已冻结并以未实现首版确认预期失败，尚未发题。

- [x] ~~1019FB B15：本轮M3后台清理静默／新文件／失败回报的私聊与群入口及重启负例闭环。~~ 当前构建群R3三命令各一次、三通知completed，清理不落群结果，18B唯一交付并正式预览保存、exit7唯一报告、同伴零派发，0活跃；私聊R3正常重启12表／38记忆全同、无控制标记或重放，两方字面控制文本仍可见。详见新增201例对照清单和background-{private,group}-R3证据。只关闭此明确子项；群启动说明仍露跟踪UUID的模型表述差异保留至整体展示验收，未添加输出清洗或新执行机制。未commit／push。

- [x] ~~1019FB C04单选鼠标与键盘两轮、C06私聊主输入中文多行回答实际对照。~~ 双方实际所选Markdown／CSV与真实已答卡一致，M3只有提问工具；多行自填双方旧卡均已忽略、只有一条实际用户正文及一次完整回显。按当前官方行为修正初稿过强内部回执假设，不修改生产代码。当前完整关闭16/201个本轮案例，不代表整体功能完成率。K04首轮双方原55＋修订30项均通过，自测M3 62、官方11项通过；完整附件、文档与真实页面待验，不提前勾选。

- [x] ~~1019FB K03 长程看板完整对照验收。~~ 双方独立API 55/55、自测M3 37/37与官方8/8、README实际启动及命令示例、八份原生下载与ZIP源码字节、真实页面增改完成恢复筛选、HTML纯文本、断连错误及重启均已核对。获准后通过两边页面仅删除四条具名合成任务，刷新均为0项，数据文件均为空数组；K04四条修订样本在两边均保留。证据为K03-authorized-ui-delete.json及两份页面截图。官方首轮漏七份源码及后续三轮补交记录保留，不把最终通过表述为首轮一致。当前完整关闭17/201个本轮案例，K04仍在验收。

- [x] ~~1019FB K04 长程修订／旧功能回归及反馈修复。~~ 双方旧55＋新30独立API通过，真实旧数据、批量撤销、失效token、失败零变更与键盘操作通过。M3首轮README及Escape错误均复现并反馈修复；最终65项自测、旧版反例检出、原62项断言前缀未改，真实UI与八份保存/ZIP字节核对完成。官方11项自测及README10项通过、七源码与首ZIP一致，三次反馈补发的首轮缺项保留。完整失败、修复迭代与耗时记录在对照清单K04，不改原工作台或新增执行体系。当前完整关闭18/201个本轮案例；下一项先核实官方多选问题的实际能力，再判断本地是否存在核心缺口。

- [x] ~~1019FB C05：按当前官方实屏补Bot原生多选，复用原请求/回执/历史，无新存储。~~ M3三题真实答案、标签多选/空选忽略、原工作台单选与最终重启均验证；12表/38记忆哈希不变。Node22相关75/75、类型/构建及messages/workflow/desktop三组通过。全量仍非绿色：IM clean-cut、Mods/主题指定断言在HEAD同样失败，其余全量失败尚未逐项归因，保留发布回归待办。空选后M3多一句解释的节奏差异及首次旧结论失败保留。具体证据见对照清单C05；本轮严格案例19/201。

- [ ] 1019FB C07/C08：群问答主流程已实测，缺失进度已修；多余确认/题目复述为非阻断体验差异，C07未关闭。R4无效的静默marker与待答来源试验已撤回（保留失败证据），优先推进双Bot同时待答和取消恢复，不继续消耗在轻微措辞重复上。本轮严格关闭仍19/201。

- [x] ~~1020G C08双Bot独立待答。~~ 先B/BETA、再A/ALPHA，真实不同requestId/工具回执、各一条结果，无串用；正常重启12表/38记忆哈希相同，无重播。官方答B时会忽略A，本地保留独立卡作为有益差异。严格关闭20/201；C11仅成员移除/重加/重启子路径完成，审批/主动停止仍待测。接续真实180秒及交付补充回归。

- [x] ~~1020G B03/B04/K13：同题180秒插话/补充/切会话及真实附件交付。~~ 本地PID50322单启动、约180秒、插话42/同伴43、通知实际回读并交新四字段JSON/原raw；官方也自动完成，两端下载独立核对正确。零新生产改动，失败与证据边界照实保留。严格关闭23/201（案例覆盖11.44%）；B08官方未在忙时发题、B11流式切换待测，不顺带勾选。

- [x] ~~1020G B14完成旧任务后新文本隔离。~~ 双方43，本地零工具、独立completed、无旧任务复活，严格24/201。B13私聊及群可见性已跑，少括号为非阻断输出差异，未扩展静默机制、未严格勾选。

- [x] ~~1020H F12临时信息不污染长期记忆。~~ 双方任务50.75/nonce正常；本地完成后真实三搜索均空、38份记忆哈希不变，未修改生产源码或正式配置。保留首轮测试抢发导致接续的记录。严格25/201；J07返回按钮/Escape/草稿已实测，J08与箭头精确操作因工具异常待补，不误报通过。完整Node22单workerVitest仍在跑，结果未全绿前不宣布原功能回归完成。

- [x] ~~1020G J08原工作台设置回归。~~ 原线程设置返回按钮/Escape均回原线程，合成未发送草稿保留，无配置修改，未误进入Bots；仅清本轮草稿后恢复Bots。无需生产改动，严格26/201（案例覆盖12.94%）。J07精确箭头指针子项仍按工具限制保留。

- [x] ~~1020G支持Node22完整Vitest及失败基线对照。~~ 当前584文件通过/16失败/2跳过，5138测试通过/62失败/20跳过；隔离未改动HEAD重跑相同16文件仍为相同62测试失败，63个FAIL报告项集合完全一致，无新增失败身份。原分支未切换、未commit/push；存量门禁仍非全绿，不能提前宣布全部回归完成。详细日志及基线边界见对照清单。

- [x] ~~1020L：DeepSeek失败后新消息、中文CSV输入/质量交付及I01到期记录核实。~~ 按用户要求后续改用已有deepseek-v4-flash，仅改合成B模型；新文本43零工具，同CSV七真实工具、三份正式附件和下载独立核对通过，原件64B字节一致。M3两次529、官方差额方向及I01约106秒模型超时延迟均保留，未把外部延迟说成准点送达。关闭B10/G01/K07/I01后严格30/201=14.93%，只代表本轮覆盖；详情与限制见对照清单，无生产代码/凭据改动、无commit/push。

- [x] ~~G03-1020M：同名不同字节附件A/B，移除A只发B。~~ DeepSeek真正读取B，原名/ID/CNY/-3.40正确，无串件、覆盖或旧任务副作用；官方同样B数值正确但原名未知。官方同名编号与本地重复显示差异列为非阻断UI待办，继续核心回归。严格31/201=15.42%，无生产改动、无commit/push。

- [x] ~~E03-1020N：双DeepSeek群草稿/同伴复核/三附件，官方同题。~~ A只交故意错额草稿，B真实读CSV与草稿，修正74.13/差0.03并交最终报告和原件；A零工具pass自然停止，三任务完成、三交付唯一、游标清空。双方三下载及原件字节独立核对通过；源码对照与版本边界见案例记录。严格32/201=15.92%，无新生产改动、无commit/push。

- [ ] E07-1020Q 私聊同名原件交接首轮质量差距：真实读对原件，但同伴stdout后虚报文件已写/交付，原验证已拒绝；发起人无工具回执声称重交办。先只收敛Bot协作交付提示到实际文件/交付回执，原Runtime不扩展；新目录同题复验有效才更新，失败记录保留。

- 1020R用户要求MiniMax-M2.7可用性检查已实测：一次真实零工具对话完成、实际Runtime模型M2.7，约45秒含历史压缩；只证明对话恢复，后续回归仍DeepSeek。E07两段Bot提示检查120/120、构建及12表/38记忆重启保全通过，真实修订交付尚待验证，不提前勾选。Grok交付/空回复重试的源码边界已补入对照清单，未引入公共Runtime或通用产物判定器。

- [x] ~~G06-1020S：M2.7同伴真实文件回执→发起人自己的可下载副本。~~ 两输出真实写/读/正式交付，发起人用host回执直接导入，私聊两附件各一次，原CSV37B/哈希与报告逐字节核对；没有误用同伴路径后再修补。严格33/201=16.42%，其余E05/E07组合题未关闭。
- [ ] E07-1020S整体质量继续待补：M2.7文件与交接正确，但没有执行题目明确要求的60秒Node步骤。工具记录已证实不能凭64秒耗时认作执行；DeepSeek首轮虚报与此轮漏做均保留，不把换模型当提示修正因果证明。遵照用户优先全量回归原则，不围绕单一模型遗漏反复造新机制，继续其他高优先级常见路径。后续实测统一MiniMax-M2.7。无commit/push。

### 1020T：MiniMax-M2.7网页对照

- 后续真实CMB任务统一M2.7。新增独立合成Bot“验收-1020T-H”，未更改用户正在使用的A/B群或草稿。实际浏览器navigate观察三行26.40/-3.15/0.07，真实写入、回读并正式交付报告，独立下载核对23.32/草稿23.30/差0.02、不一致、来源及口径，原件与下载逐字节一致；没有用HTTP客户端/解码替代访问。
- 官方相同题先询问“不委派”是否允许原有内部浏览器助手，已点真实允许选项；两次浏览器ERR_CONNECTION_CLOSED，最终诚实说明未访问，不填猜测数字，943B失败报告已下载。该项保留环境阻断，严格完成数仍33/201，不把单端成功冒充对照通过。M2.7结论前额外标题/引言属非阻断表达差异，保留。
- 证据：`quality-review/1019FB-complete-comparison/H01-{frozen,independent-review}.json`、`H01-M27-runtime-receipts.json`、双方正式下载和预览。此项没有改生产代码、无commit/push。

### 1020U：多轮更正与切换会话

- [x] ~~B02：三轮同题两次局部更正，切换到其他私聊再返回，保留初始有效要求。~~ M2.7与官方最终JSON均为青禾-1020U/CNY/[18.40,-3.20,0.05]/15.25/仅本轮，金额均字符串两位小数；没有混入旧网页数值或另一个会话。M2.7三唯一真实任务均completed、零工具，未创建文件/长期记忆/例行/修改档案。首轮M2.7确认多复述数字的表达差异保留。
- 独立判据全部通过；严格关闭34/201=16.92%，为本轮对照覆盖率，不代表整体功能完成率。切换原始差分证据与补存的完成后完整重查分开命名，避免混作时间证据。证据`quality-review/1019FB-complete-comparison/B02-{1020U-frozen,independent-review,M27-runtime-receipts}.json`、双方切换/最终AX与截图。未改生产代码、无commit/push。

### 1020V：用户现场群报时接力过度展示

- [x] ~~先核对现场、原接口、Grok源码和官方同题。~~ 用户原群message da8acb09…，Bot四条：交办正文、等待确认、同伴报时、发起人复述。Store.delegate将正文直接插群，settle将同伴结果插群并自动回传发起人；不是同一命令执行四次。官方11:01同问实际两条：GA用真实@GB请求群内报时、GB直接答，无额外等待与复述。
- [ ] 最小修正/复验：复用现有群内@提及绑定和advanceGroupDiscussions明确handoff，无新增执行/存储/判断体系。仅群专属提示优先普通公开@接力，不再对同一简单群问答叠用bot_delegate与等待确认。保留私聊异步委派及文件/复杂任务能力；本次不删除既有回执或改普通Runtime。M2.7真实同题及相邻文件交接通过后再勾选。
- 参考：Grok `host/groups/group-chat.ts:15/17`、`host/agents/agent-messaging.ts`明确发信和用户可见交付区别；CMB `store.ts`既有显式@handoff选择。证据`quality-review/1019FB-complete-comparison/group-time-*`。无commit/push。

- 1020V复验失败保留：原群原问法真实M2.7产生message 5d4600ac…，仍bot_delegate、等待确认、同伴报时、再次转述共四条；活动任务/讨论游标均结束，没有重复执行命令，但展示与沟通节奏未对齐。142项通过不代替模型验收。仅提示尝试已原样撤回，与`group-time-prompt-before.ts`逐字节相同；未改Store/Runtime/工具能力、未隐藏回执/自动合并文字，不计修复通过。下一步先收敛群公开接力与内部委派展示的最小方案，保持原任务/文件交付能力；不靠删除功能或泛化语义去重解决。
