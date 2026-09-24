# 关闭 Function Mods 时保留原生经典 Hook 路径 — 2026-09-24

基线 `329ff86d`；只改 `runClassicFunctionHook` 关闭路径6行，宿主修订仍v63。没有授权缓存，没有削弱generation、lease、撤权或原生权限判断。

## 先失败再修复

新增 `classic-disabled.test.ts`：关闭与无manager的原生结果/回调语义一致；无插件输入投影；下一次开启立即生效；执行中取消/session替换；开始前取消。首次旧实现4失败/1通过，其中回调全量比较误包含每次不同durationMs，不能当产品缺陷；排除该计时字段后，其余失败仍明确指出关闭调用了桥接并读取guest输入。既有Stop测试原先mock关闭后仍返回插件反馈，与真实manager关闭行为不符；现明确关闭null/0次桥接，开启才收到反馈。

修复在live `isEnabled` 为false时执行原生legacy，完成后assertCurrent。该判断只跳过Function桥接；原生hooks、权限门禁及外层output policy继续运行。关闭中的调用不复用任何肯定授权。

5文件49窄测通过，含真实FunctionGuestRuntime/FunctionSession、空链grant/reload/publication以及once并发/telemetry。Node/Web types、3文件差量ESLint通过；旧runner51与classic integration57条格式warning无新增。新测试0warning。

## Electron 与当前验证

普通构建专项实际通过：已批准guest替换真实native读取结果、全局关闭恢复原结果；新增全局关闭/项目关闭两个HTTP拒绝规则对照，均实际通过，准确1次HTTP请求、结果含NATIVE_DISABLED_POLICY且不含文件内容/插件替换、原文件未变。

该专项随后原有MCP测试需test-only mods-e2e.js而普通构建不含，exit1；这是选错专项启动方式，不当作整套通过。改为仓库run-mods-e2e.mjs完整驱动（专用构建并最终恢复ordinary）。exec99277依次Mods60、utility、完整Electron，结果待填。未把可控HTTP/模型夹具描述成业务验收。

helper另做类型检查/ESLint；检视后确保删除原生hook失败时server仍在finally关闭，不留测试监听器。完整结果及性能复检待完成；旧正式ingress4/10失败仍保留，不把此修复提前宣称性能达标或最终交付。

## 完整回归结果

exec99277 exit0：Mods60 156文件1378项、真实utility44、完整Electron228检查通过，ordinary out已恢复。结果回执已另存2026-09-24-classic-disabled-full-electron-result.json，不复用旧226。全经典Hook目录再检10文件68项通过；helper最终types与差量lint通过（旧warning无新增）。当前exec7844随后正式ingress复检运行中。

Electron冻结生产期间仅新增未接线Base64测试/夹具/helper并跑单个真实QuickJS红测（1.27s，7项缺失globals失败）；没有修改冻结生产/根E2E驱动。这些不是本修复提交范围，也不算本轮通过测试。Base64 source仍仅ignored草稿。

## 性能复检结果

正式5轮/1000样本/100预热已结束，exec7844 exit2，目录`v2-ingress-2026-09-24T07-46-32-187Z-matrix-563b7b1e`；qualified=true/budgetsPassed=false。单插件五轮p95均低于15ms，但关闭仍有2/10组失败。生产/driver未变，无并行构建或重测试；初段曾对未接线Base64 process helper做约4秒ESLint，不能称绝对无其他进程。

| 轮次 | 模式 | p50增量ms | p95增量ms | 增量% | 门槛 |
| --- | --- | --- | --- | --- | --- |
| 0 | project-off | -0.0007 | -0.0013 | -0.0561 | 通过 |
| 0 | global-off | -0.0004 | -0.2003 | -8.4912 | 通过 |
| 1 | project-off | 0.0035 | -0.1373 | -5.1683 | 通过 |
| 1 | global-off | 0.0125 | 0.1461 | 6.5838 | 失败 |
| 2 | project-off | 0.0020 | -0.0422 | -1.8074 | 通过 |
| 2 | global-off | 0.0044 | -0.0079 | -0.3538 | 通过 |
| 3 | project-off | -0.0016 | -0.0154 | -0.6821 | 通过 |
| 3 | global-off | -0.0001 | -0.0894 | -3.9186 | 通过 |
| 4 | project-off | -0.0157 | 0.1760 | 7.7271 | 失败 |
| 4 | global-off | 0.0059 | -0.0087 | -0.3709 | 通过 |

关闭全部0发现/0 runtime；结束activeCount=0。与旧正式结果比较，中位开销下降只作诊断，不能替代p95门槛或证明全部长尾来自噪声。保留失败，不更改5%阈值；后续最终代码可用预先固定更大样本提高尾部估计精度，旧1000样本失败仍必须可见。尚未重做最终桌面与两小时长稳，不能声称可发布。
