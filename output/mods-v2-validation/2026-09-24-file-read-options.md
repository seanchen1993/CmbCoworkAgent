# 文件读取模式验证 — 2026-09-24

代码基线40fabd88之后的未提交修复，宿主修订file-read-options-v65。当前最终代码的窄测、类型、Mods、跨进程及完整Electron回归通过；性能短测无正式资格，正式性能未完成，不能标记最终交付。

## 实现与检视

basic-sdk校验默认/显式text、选项形状和改写后的mode，操作输入保留as:text。null、数组、未知字段、非法模式及多余参数拒绝；bytes明确MODS_FS_BYTES_UNSUPPORTED，在读取和发布前失败，不以文本冒充二进制。省略as的旧path-only Hook改写保持文本默认。

guest-bootstrap沿用fs.stat的可选参数规则，仅对恰好两个参数且第二项为undefined的fs.read省略该项，避免JSON数组把合法undefined变为null。显式null继续拒绝。ProjectFunctionFiles、原生read_file、发布过滤、authority、lease及generation未更改。矩阵两项仍partial/bounded，不宣称字节读取已实现。

代码检视覆盖SDK入口、Hook next改写、发布过滤和原生关闭对照；检视找到的undefined回归已先新增失败测试再修复。普通完整Electron套件总期限从15分钟改为20分钟，仅作用于!focus&&!packagedDir；单项等待、业务/SDK预算、专项和packaged期限、正式性能及soak期限均不变。

## 先失败再实现

1. 初始真实QuickJS/FunctionSession/实际临时文件测试15项中14失败，旧path-only兼容项通过；旧普通Electron复现bytes、非法、未知选项和Hook改写都错误返回文本。日志file-read-options-red及file-read-options-electron-red。
2. mode修复后相关4文件56项通过。普通Electron第一次仅因fixture未匹配既有Windows canonical小写路径而失败；按ModsManager.workspaceKey规范修正fixture，生产路径逻辑未改，相同构建green2三项通过。
3. 完整Mods62为164文件1424项、utility46、Electron234通过，属于补undefined前的历史结果，不能作为最终补丁全量证据。
4. 只读检视发现可选undefined回归；新增真实guest用例1失败15通过，普通Electron明确optional返回MODS_FS_OPTIONS，日志undefined-red/undefined-electron-red。随后仅扩展既有bootstrap条件，再验证。

## 最终代码验证

- 6文件78项窄测通过：16新实际文件读取、26session、7metadata、8access、18matrix及3evidence。日志file-read-options-final-narrow。
- Node/Web与新增Electron helper类型检查通过；修改行ESLint无新增诊断。最终watchdog格式修正后，basic-sdk保留2条旧warning，根E2E保留80条旧warning；6文件检查见file-read-options-watchdog-final-lint.json。
- 普通构建和Electron专项3检查通过，含显式undefined及关闭Mods后的实际模型/原生读取。日志file-read-options-undefined-electron-green。
- Mods63包含全部hooks及5个renderer测试文件：164文件1425项通过；真实utilityProcess46项通过。日志2026-09-24-mods63及file-read-options-final-process。
- 最终完整Electron首轮75841退出1：实际223项通过，895737ms最后正常PASS；900秒外层watchdog关闭应用，随后StopFeedback审批报MODS_HOST_UNRESPONSIVE。无此前断言失败。保留final-full-electron.log及final-full-electron-timeout-result.json，不标整套通过。
- 调整完整套件总期限后，60831先因watchdog修改行3条格式warning退出，未启动Electron；只格式化该block。75814的6文件差量lint通过，完整Electron实际234检查全部通过并exit0，ordinary构建已恢复且无mods-e2e.js测试bridge。回执另存file-read-options-final-full-electron2-result.json。生产未改变，已通过的Mods/types/utility不重复。

上述模型协议夹具用于验证应用链路，不属于真实业务验收；真正Autobiz业务演示另有独立报告。

## 性能与后续

首个v65正式desktop 65719在第一个idle窗口内，因独立源码检视发现undefined兼容问题而通过STOP主动中断，exit1/DESKTOP_PERFORMANCE_STOP_REQUESTED。目录desktop-performance-2026-09-24T08-43-54-982Z-full-6b182d4b保留；无完整idle/stream结果，不能算预算通过或失败，也不是按指标挑选样本。停止发生在新增测试和生产修改之前。

最终代码正式desktop 67586对应09-29-56-122Z-full-22ea4e75，在会话中断后未留下exit.json、progress或完整result。22:32重新核对，runner PID及该快照/driver进程均不存在。保留原目录和v65-final-formal-performance.log；无法判定结束原因及性能结果，不写成PASS。

随后独占性能短测9429退出0，目录desktop-performance-2026-09-24T14-32-40-730Z-smoke-2947657d。关闭/开启各2个样本，TTFT p95 125→176.3ms（+51.3ms），吞吐比1.0039996667；约1秒idle CPU差+1.2327168060百分点。qualified=false、passed=false；exit0只证明短测链路完成，不能算性能达标。完整日志v65-final-smoke-performance及JSON保留。

按用户最新要求先收尾主要能力、延期复杂边界兼容，详见核心交付范围文档；并不放宽性能门槛。该功能先单独提交，随后处理小范围Pane资源生命周期问题，最终代码再统一正式性能/长稳及全仓回归。此前ingress超预算、ACK6408失败和本次中断均保留；Actions实际包验收仍未完成。
