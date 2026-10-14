# Mods v2 待确认项逐项核验与本机启动恢复

本次接续[全面检视报告](mods-v2-comprehensive-review-2026-09-26.md)。功能开发仍在 `C:\ai\CmbCoworkAgent-mods-v2` 的 `codex/mods-v2`；仅为恢复用户指定的本机启动，修复了 `C:\ai\CmbCoworkAgent`（UAT）损坏的 `package.json`，没有把 ModsV2 功能合入 UAT。

## 本机启动：已修复并实测

在主目录实际复现 `npm error Missing script: "dev"`。其 `package.json` 相对自身 HEAD 只有删除：`keywords`、`scripts`、`build`、`devDependencies` 以及 `dependencies.esbuild`、`dependencies.quickjs-emscripten` 缺失。原文件先备份，再递归补回缺失字段，未覆盖任何现存值。恢复结果的 SHA-256 与该目录 HEAD 完全一致：`1f0f600d67a9ef5fbb84edbc381db6b0d97aeb663d5603884e679e113bfe0d4d`。配置何时被哪个程序删改无法由当前文件证明，不作归因猜测。

两个目录均使用当前系统 Node 24.14.0，实际启动 `npm run dev`，附加隔离 profile 和本地调试端口供自动验证；通过真实 Chromium 页面确认：

- 主进程、preload 构建成功，renderer 从 `http://localhost:5173/` 加载。
- `window.api.mods` 存在；能点击「自定义 → Function Mods」并进入设置页。
- 测量期间没有未捕获的 renderer 异常；通过 `app.quit()` 正常退出，dev runner 退出码 0。
- 未调用外部模型、修改真实用户项目规则或安装插件。隔离测试不是对真实用户数据和全部功能的验收。

ModsV2 的原始普通 `npm run dev` 也已完成编译并启动 Electron，未观察到致命加载错误。其最近一次 `npm install` 日志显示 `electron-rebuild -f -w node-pty` 失败；本次实际在 Electron 39.8.10 中使用已安装的 node-pty 创建 ConPTY、写入固定 echo 标记、退出，结果成功。没有因此重装全部依赖，也不声称已经修复所有机器上的安装工具链。当前 Node 24 冒烟成功不改变仓库 `.nvmrc` 的 Node 22 测试要求。

继续体验最新功能应使用开发目录：

```powershell
cd C:\ai\CmbCoworkAgent-mods-v2
npm run dev
```

启动证据位于 `output/mods-v2-validation/2026-09-26-dev-repair/`：`uat-package-before.json`、`manifest-recovery.json`、`uat-verified-result.json`、`mods-verified-result.json`、同名前缀日志与截图。早期测试 helper 的参数转义和退出调用错误日志也保留；最终成功回执的后缀为 `verified`，不能把 helper 调试错误当作已证实的应用故障。

## 待确认项现在分别是什么状态

“已确认原因”不等于“已正式修复”，“明确不支持”也不再列成可能已经支持但尚待验证。

| 项目 | 确认结论 | 对使用和验收的影响 |
| --- | --- | --- |
| `npm run dev` | 主目录 manifest 缺损已恢复；主目录及 ModsV2 真实界面冒烟通过 | 可按上面命令启动开发版本 |
| 两项 Mods 相关旧测试 | 原报告归类过宽；是 Mods 重构后静态断言未同步，已正式修复 | Registry 43 项通过；sandbox 启动窄测通过 |
| 26 项原 Vitest 失败 | 21 项已通过隔离诊断确认平台 fixture/旧契约问题；5 项缺少扩展真实资产 | 没有改产品来迎合旧断言；正式全仓仍非全绿，见逐条报告 |
| 其他独立套件失败 | sandbox 另 2 条格式/owner 参数断言过时；IM 两套是 Windows 路径和项目回复格式预期过时 | 隔离诊断确认原因，尚未全部修改正式测试 |
| 原新增 Git 超时 | 原断言、原门槛的隔离回跑通过 | 不能据此删除全仓失败记录或宣布无并发波动 |
| 原 IM clean-cut 新失败 | 新测试标题碰到扫描禁词；只改两个标题后原扫描通过 | 已关闭，不改产品或旧断言 |
| A–D 功能回归 | 前轮 236 Electron、14 设置、46 utility、9 Chromium、200 历史交互已通过 | 覆盖报告列出的具体场景，不代表所有第三方插件 |
| 正式首字延迟 TTFT | 已证实失败：开启增加 p95 53.1ms，要求不超过 40ms | 本次进一步分段诊断；诊断不能覆盖正式失败 |
| 正式吞吐、空闲 CPU | 已通过：吞吐保留 99.8475%，CPU 增加 0.106 个百分点 | 是该 Windows 固定负载的测量结论 |
| 旧版两小时交互与持久化 | `971f6d80` 的 10000 确认、4×2500 计数、50 job、41 关闭窗口已验证 | 当前版本短回归不能替代新的两小时验收 |
| 长期内存稳定性 | 旧版 GC 后堆中位数 15.781588→18.041830MiB，增长 2.260242MiB；稳定性验收未通过 | 增长事实已确认；对象保留路径和当前版本长稳缺证据，不能直接断言泄漏或无泄漏 |
| Windows 阶段提交边界 | 本地受支持 NTFS 范围内可用；非 Windows、网络卷、非 NTFS、reparse 和状态硬链接明确不支持 | 超出边界应保守阻断，不宣传跨平台可用 |
| 全工作区事务、未知提交自动回放/回滚 | 明确未实现；现有为保守阻断与只读恢复核对 | 按之前批准的核心范围保留限制 |
| Claude Code 全量等价 | 明确未达成：矩阵 49 adapted / 155 partial / 41 unsupported / 0 full | v2.1.280 为声明参考；已有实际二进制限定比对为 v2.1.273 的 52 用例，不能宣称全运行时等价 |
| 真实模型业务 | `3b8ce3f7` 的一个 DeepSeek 订单场景已验证 7 条外置业务断言、保护文件不变及一次推进 | 当前 A–D 没有新增付费模型业务验收，不扩大成任意项目成功率 |
| 当前安装包 | 当前 A–D 未重新构建或发布安装包；旧 `971f6d80` Windows unpacked 9 项通过 | 旧包成功不能代替当前代码交付验收 |
| NSIS 安装/卸载、Linux/macOS 桌面 | 本轮没有运行证据；历史 Linux 构建成功不代表桌面运行通过 | 需相应一次性 VM/平台验证，当前 Windows 主机不冒充其他平台 |
| 环境自动安装、完整阶段向导 | 明确未实现、按核心交付范围延期 | 当前手动提供依赖、选择已有项目/Feature；不是隐藏的已完成能力 |

## 遗留失败的具体归因与修复

26 个 Vitest 失败、4 个独立命令及每个失败点均在[逐项独立确认报告](mods-v2-existing-failures-confirmation-2026-09-26.md)列出。证据包含原样复现、源码和 Git 归因，以及不改产品的隔离诊断。

本轮先提交最小方案给两个独立 agent 审批，再修改两个正式测试：

1. Registry 测试保留 coordinator/leaf 限制，验证 enabled → 异步加载 profiles 或空数组 → Mods 仅筛选已加载 profiles → 生成 specs 的连续链路。不是删除限制来恢复旧代码形状。
2. Sandbox 测试按抽出的 `codex-sandbox-binary.ts` 检查全部 helper 的异步文件访问，同时保留 runtime 资源区间、原 import/code-exec 限制及 Windows `await` 调用检查。

两位已批准方案，兼容 agent 已复核实际 diff 与结果。完整 registry 43 项通过；sandbox 窄测 1 项通过、完整 87 项中 85 通过，剩余 2 项正是旧多行 broadcast 正则、owner 参数正则。没有宣称 sandbox 全绿。

21 项原 Vitest 归因的隔离诊断为 7 文件 76 项通过，两套 IM 的隔离完整旅程通过。它们只在 output 中修正测试假设，并没有修改正式测试，不能与正式全仓结果混用。缺失的 `chrome-extension/popup.js`、`service-worker.js` 在主目录和开发工作树都不存在，5 项扩展测试无法验证真实实现，未造假 fixture 或跳过测试求通过。

## 首字延迟诊断与本轮最终回归

两位独立 agent 审批了仅在测试 helper 计时的方案：普通构建冻结、隔离数据、8 个真实 Hook 与 4 个 Pane、off/on/on/off 四块，每块 1 预热和 10 正式测量，共 44 请求。校验每次一个物理请求、完整同序输出、最终关闭 utility，并核对应用和驱动前后哈希；跨进程相位附时钟误差界。

诊断已完成，44 个物理请求全部校验输出，最后关闭 Mods 且验证 utility 退出，进程退出码 0。389 个应用文件、90 个驱动文件前后哈希全部一致。这是定位诊断，始终 `qualified=false`、`formalPassed=null`；不更改产品执行链、授权、文件指纹、发布保护、正式样本数或 40ms 门槛。

| 诊断指标 | 关闭 Mods | 开启 Mods |
| --- | --- | --- |
| TTFT p50，20 个有效样本/组 | 132.5ms | 192.3ms |
| TTFT p95 | 142.5ms | 196.6ms |
| 发起到 provider 收齐/解析请求，p50 时钟误差区间 | 93.99–95.58ms | 151.42–152.29ms |
| 本地 provider 收齐请求到首写，p50 | 28.64ms | 26.93ms |
| provider 首写到 renderer 回调收到首段文本，p50 时钟误差区间 | 2.37–3.67ms | 8.58–9.32ms |

本轮新增确认：主要增量发生在 provider 收齐请求前的准备/传输阶段，首写后的接收/发布链路也有较小增量。本地响应服务等待不是主要增量来源。这个结论还不能细分到某个主进程函数、某次权限查询或纯 CPU 成本；前段包含请求传输、读取和解析，后段包含调度、IPC 等。终点实际是 renderer 中 `window.api.agent.invoke` 回调收到首段文本，不是精确的 preload 内部时刻，也不是画面绘制时刻。分位数不能简单相加。四块前后时钟校准均有重叠区间；每次从 5 个 ping 中选择最小 RTT 样本，这 8 个选中样本的最大 RTT 约 1.59ms，全部 40 个 ping 的最大 RTT 约 31.72ms。仍保留“块内无未观察时钟跳变”的测量假设和会话历史逐渐增长的限制。

诊断 p95 增量 54.1ms 与原正式失败方向一致，不代表性能改善。没有据此批准权限缓存、跳过发布/指纹检查或修改产品链路。下一项可执行调查是对前述准备/传输阶段作主进程有界 span/采样，先提出具体方案并双人评审；当前没有足够证据直接实施安全提速补丁。长期内存、跨平台/安装包的证据缺口仍按表中状态保留。

原始结果：`output/mods-v2-validation/ttft-phases-2026-09-26T04-43-03-058Z-494bd299/` 下 `ttft-phase-result.json`、`phase-summary.json`、`integrity.json`、`exit.json`；启动日志为 `2026-09-26-confirm-ttft-phases.log`。

本轮真实执行 `npm test`，默认并发下 Vitest 为 607 文件中 580 通过、27 失败；4781 项中 4712 通过、64 失败、5 跳过，另报告 2 个未处理错误，退出 1，因此后续独立阶段被脚本短路。不能写成完整 npm test 通过。两处修改涉及的独立套件已另外完整运行，结果如上；前一轮其他 84 命令的历史结果仍保留，不伪装成本轮全部重跑。

对这 27 个失败文件保持原断言/超时，使用 `--maxWorkers=2` 整组复跑：395 项中 366 通过、26 失败、3 跳过。逐个匹配原 64 个失败名：38 个在复跑中通过，26 个仍为本文逐项归因的旧失败；不存在漏匹配。仅说明额外失败在限并发下未复现，不能由此宣布全仓全绿或已证明每个波动的唯一根因。

测试名以外另有 3 个 suite 的 `afterAll` 超时：`hook-catalog/client` 为 30000ms、`skill-plugin-catalog/client` 为 60000ms、`workspace-file-scan/client` 为 10000ms，三文件复跑状态均为 passed。后两文件原本没有失败测试名，因此不能只用 64 项映射代表全部 suite 失败。另 2 条未处理错误为 `legacy migration parsed on the main thread`、`legacy JSON was parsed on the main thread`；复跑未再报告，但并未确证所有调度/清理波动的唯一原因。suite 记录与测试名映射分开保存。

证据为 `2026-09-26-confirm-npm-test.log`、`2026-09-26-confirm-failed-files-recheck.json/.log`、`2026-09-26-confirm-failure-resolution.json`。修改的两个测试文件 ESLint 0 error；2130 个 warning 均在未修改行（主要是原文件 CRLF），修改行诊断为 0，未为整文件格式清理制造无关 diff。普通 `npm run build` 通过。
