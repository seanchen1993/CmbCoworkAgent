# Autobiz 组件包、三预设与 Python 检查验证

本记录属于四方向统一迭代，开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
专项代码、基础测试与真实 Electron 八项旅程已经通过。整体版本的全量回归状态见
[最新交付报告](mods-official-launch-implementation-2026-10-02.md)，专项通过不替代全部回归。

## 可用产物

- 生成器：`scripts/package-autobiz-mods.mjs`，固定上游 commit
  `8db1ec937d6ed3d271cb9dc540310d6633c91e70`，不改原工作树。
- 当前可导入 ZIP：`output/autobiz-integrated-2026-10-01-final/AutobizDevOps_Plugin_Kanban_Mods.zip`。
- 实际上游源码副本：同目录 `autobiz-source-project`，默认配置运行全部原 unittest，未注入故障。
- 用户与作者说明：[示例 README](../examples/autobiz-kanban-mods/README.md)。
- 三预设来自同一 `src/shared/mods/flows/autobiz-presets.ts`；生成包附 `flow-presets/*.json`。

组件为状态、看板、单文件检视、完成意见、跨插件输入。看板显式依赖状态；未选组件不注册业务命令。
原上游 Skills、MCP 与 Python 工具仍保留；并不意味着这些资产自动拥有相同的组件粒度。
此格式是本工程扩展，不宣称是 Claude 官方 manifest，也不宣称复制上游 reviewer/utest 内联语义。

## 三预设执行语义

| 预设 | 路径 | 写入与证明 |
| --- | --- | --- |
| 只检视 | Explore 读仓库 → Explore 汇报 → 确认 | 无修复步骤，无原生测试结论 |
| 检视与测试 | Explore 读仓库 → 原生单测 → 汇报 → 确认 | 测试失败停止，不自动改源码 |
| 修复与复检 | 读仓库 → 原生单测；失败才修复 → 同一单测复检 → 汇报 → 确认 | 首次通过跳过修复；失败最多两次修复，仍失败停止 |

Explore 使用实际只读执行策略。修复步骤不得修改测试、检查配置、需求或 checkpoint。
原生终结阶段可能为证据新鲜度重新检查；这不等于新增自动修复。预设不含阶段提交。
步骤模型可配置，汇报可以替换为其他已授权插件动作。模型意见不能代替项目测试回执。
插件动作选择“本次执行结果”输入来源并指定目标文本字段（如 `text`），宿主会注入本步骤之前
最新且有效的实际执行记录。JSON 包含 `nativeProjectTests` 与 `results`，失效、跳过、未来步骤
不算通过，Agent/插件声称的测试结果不计入原生测试。仅真实 check 类型和回执匹配才计数；
超过 24 KiB 明确失败，不静默截掉失败证据。此输入是当时结果，不能冒充后续最终门禁结论。

## Python 原生检查边界

显式 `.cmb/project-checks.json` v1，固定 `python-unittest`、项目内 ASCII `startDirectory`
与 `test_*.py` 类模式，不接受任意 command、解释器路径或 shell 文本，不扫描目录猜测运行器。
通过固定 Python unittest loader / runner 执行；零测试退出 2，失败退出 1，通过退出 0。
不安装 Python 或依赖。此配置只覆盖单元测试，E2E 仍须独立入口；未配置项目保留原 npm 语义。

主进程使用稳定文件句柄限长读取配置并固定 SHA。执行前、发布回执前核对同一配置，
`completion-evidence` 即使在 Git 忽略 `.cmb` 时也将其纳入配置指纹；无配置时保留旧指纹算法。
执行复用原 `host:execute` 参数断言、审批、取消、租约和真实回执，不另建免审批执行器。
目录链接、路径跳转、shell 元字符、未知字段和运行器均拒绝，无效配置不会降级为 npm 通过。
执行前后再次核对目录真实路径；固定 Python 程序启动时也检查完整路径解析，覆盖用户等待审批时
将最终目录或父目录替换为 Windows junction 的情形。该边界专项 2 文件 19 项通过，日志为
`output/mods-integrated-python-directory-boundary.log`。

## 上游隔离基线

在 Git archive 隔离副本执行，未修改 `C:\ai\autobiz_kanban`：

```text
python -B -m unittest discover -s tests -p test_*.py -v
Ran 168 tests in 9.896s
FAILED (failures=5, errors=1)
```

162 项通过。既有问题为 reviewer-agent(s) 文件名/文字断言、Windows 路径分隔符和 task runtime policy
相关断言。原失败不在本轮暗中修复，日志位于
`output/mods-integrated-autobiz-baseline-2026-10-01/baseline.log`。

原始 `test_project_status_invalid_checkpoint.py` 连续五次通过。含 Python 启动的直接进程基线
中位 494.6 ms，最大 674.0 ms，见同目录 `focused-performance.json`。这不是 Electron 流程延迟测量。

## 验证状态

- 首轮 6 文件 34 项定向回归通过：旧 npm 规划、配置拒绝、真实 Python 空集合/通过/失败、
  配置 SHA、被 Git 忽略的配置新鲜度，以及实际 FlowManager 的修复跳过/按需执行/上限。
- 新生成包 CLI 结构与全包注册检查通过，`authorized:false` 是正确状态，不预写授权。
- 扩大后的 6 文件 127 项通过，含旧 tool-sdk 52 项和真实原生 host 检查。
  过程中主线 `modelProtocol` 缺省导致的 22 项旧注册失败，在修复缺省后以原断言通过。
  日志 `output/mods-integrated-autobiz-final-targeted.log`；专项 scoped ESLint 通过。
- Electron 首轮实际通过 ZIP 安装授权与 status-only 命令隔离、只读检视、真实 Python 单测、
  初测通过时跳过修复。故障注入后原测试真实失败，但修复的 edit_file 等待审批时运行被取消，
  首次当时尚未通过整条修复验收；保留现场 `output/mods-autobiz-e2e/repair-cancelled-first.json`。
  排查后最终复测七项全部通过。官方发布调整后又增加独立 Flow 子 Agent 的真实 HTTP
  提示词 marker 验收，确实发现旧 main-only gate 漏接；保留原失败日志
  `output/mods-launch-final-validation/initial-failures/mods-autobiz-child-prompt.log`。
  双评审通过后修复真实 child authority、受保护 transport 和 SDK 请求隔离，2026-10-03
  八项全部通过，日志 `output/mods-launch-final-validation/mods-autobiz-electron.log`，
  耗时 154.0 秒。原断言保留，没有删除 marker 检查或把 child 改称 main。
- Electron 验收脚本 `tests/mods-autobiz-e2e.spec.ts` 还检查隔离源码读取/编辑→原测试通过、
  跨插件汇报真实证据、配置在确认期间改变后的证据拒绝；原测试文件 SHA 必须不变。
- 展示链路首轮实际通过 QuickJS 读取/填充真实 React 草稿且不自动发送、等待 hook 期间用户
  编辑时 CAS 拒绝覆盖；技能验证首轮 fixture 未发 read_file，已经修正为实际读取安装的 Skill
  后检查第二次模型输入。统一构建后六项展示链路全部通过，日志
  `output/mods-launch-final-validation/presentation-electron.log`。
- E2E 使用本地可控 HTTP 模型返回工具调用，用于证明真实读取/编辑/测试链路，不能证明线上模型检视质量。

运行时还观察到上游原始 `autodev-verify/SKILL.md` 的 `description:` 后缺空格导致 YAML 解析警告，
以及 `ZA21-encrypt` 名称不满足小写命名规范的警告。它们是归档源已有资产问题，当前保留并明确提示，
不以三预设可运行来宣称全部旧 Skills 已逐项兼容。

最终实际旅程包含：真实 ZIP 授权与组件隔离、只读检视、未改动的 Python 原测试、初测
通过时跳过修复、实现故障注入后真实 read/edit 修复并通过同一测试、另一插件接收实际
回执并调用模型、应用的跨插件 prompt.compose 进入真实 Flow 子 Agent HTTP 请求、
审批期间改变被 Git 忽略配置后拒绝旧证据。详情与截图见
`output/mods-autobiz-e2e/report.json`。没有把模型返回的 PASS 当作真实测试结果。
