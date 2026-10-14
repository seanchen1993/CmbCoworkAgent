# 跨插件界面组合：本轮交付与验证

日期：2026-10-05。开发分支：`codex/mods-v2`，开发目录：`C:\ai\CmbCoworkAgent-mods-v2`。
本阶段主机版本 v88。后续 Markdown 开发中的修改不属于本阶段验收。

现在，一个插件可以决定另一个插件怎样显示文字、布局和按钮，而按钮仍执行原插件的
操作。作者可以分别安装“做事的插件”和“改变展示的插件”，在 Claw 中组合使用，
不用改做事插件的代码。示例和步骤见 [双插件使用说明](mods-ui-resolve-usage-2026-10-05.md)。

## 已完成的效果

- 真正执行跨插件 `ui.resolve` 规则，按组合次序替换九种桌面构造器；缓存是真实函数表。
- 定义构造器的插件使用自己的存储、模型与权限；原按钮保留原绘制插件的回调。
- Fragment 是透明组合，布局需要作者明确使用 Box；原生聊天、问答和已有按钮保持原路径。
- 撤权、重载、关闭画面和取消后，旧构造器不能继续使用；仍在真实清理的异步工作保留占用。
- 尚未完成的 Markdown、消息追加、终端和手机能力继续明确列为差距。

依据锁定 Claude Code 2.1.289 的声明、提取代码和原版真实 test kit；不把本地测试当成
官方完整产品测试，也不宣称所有平台完全等价。实现与退出占用设计分别见
[构造器方案](mods-ui-resolve-design-2026-10-05.md) 和
[异步退出方案](mods-ui-resolve-retirement-design-2026-10-05.md)。

## 本次实际验证

| 范围 | 最新实际结果 | 证据 |
| --- | --- | --- |
| 冻结受控广域 | 439 文件：436 通过、3 默认跳过；3812 项通过、3 跳过；452.24 秒，退出码 0 | `output/stage21-controlled-broad-second.log` |
| 三项独占性能 | 3 文件、3 项通过，退出码 0；补跑上述默认跳过项 | `output/stage21-isolated-performance-final.log` |
| 真实 Electron | 21 检查点通过，含构造器 10、公共 JSX 5、原生界面 6；普通构建恢复成功 | `output/stage21-ui-resolve-electron-seventh.log` |
| 传统 Plugin／项目／Harness | 9 检查点通过；含真实安装、原项目启动路径、取消和重启保持 | `output/stage21-legacy-plugin-project-e2e-first.log` |
| 完整类型 | Node、Web 退出码均 0 | `output/stage21-production-types-eighth.log` |
| 阶段 lint | 160 文件、0 错误、18593 既有警告 | `output/stage21-foundation-final-lint-fourth.json` |
| 实际 Guest 深层模型链 | 19 项通过，覆盖两种实际模型协议 | `output/stage21-deep-chain-guest-second.log` |
| Utility 真实清理 | 15 项通过 | `output/stage21-nested-quiescent-utility-first.log` |
| 新示例源码 | 实际编译和运行时组合 1 项通过；不是新示例 ZIP 的人工 UI 验收 | `src/main/mods/v2/composition-example.integration.test.ts` |

广域首轮的唯一失败是旧 surface 测试仍期待 Fragment 自动增加 Box；修正了旧测试期待，
并增加真实 QuickJS 中显式 Box 的邻例。生产代码没有为消除该失败改回隐含布局。
首轮失败及全部七轮桌面尝试均保留，最后一轮并非借旧截图判断成功。

性能仅说明所测局部范围：真实 QuickJS 缓存构造器的批均值 95 分位为原生约 0.465ms、
规则不命中约 0.478ms、跨插件组合约 1.119ms。每样本包含 20 次绘制、12 个样本，
不是单次绘制延迟，也不包含 IPC、生产保护规则、React、系统绘制或模型。组合分支
真实占用 2 次配额请求和 256 个句柄；原生与不命中分支均为 0。原生内容与排队性能的
完整原始数据保存在 `output/stage21-performance-final`。这些结果不证明整机性能或无泄漏。

## 使用边界和下一步

真实桌面验证了 Q 原操作、P/R 改展示、一次点击一次回调、两条本地 HTTP 模型路由、
关闭后保存新参数、单次明确重载、撤权和普通聊天。重载前实际只读显示调用仍忙时，
可以返回等待状态；最后验收在真实活动归零后用一次重载成功，没有提前清空占用。

本阶段不等于全仓无债务：历史全仓测试与 lint 的存量失败仍需分别记录，受控范围通过
不能代称 `npm test` 全部通过。v87 的上阶段记录保持原日期和版本，不改写成 v88 证据。

继续实施 [Markdown 方案](mods-markdown-design-2026-10-05.md)，已取得两位正式方案评审
和原版 15 项实际通过证据。再补真实消息追加及其他可适配缺口；当前没有新的框架
不可实现证据，整体对齐工作继续。
