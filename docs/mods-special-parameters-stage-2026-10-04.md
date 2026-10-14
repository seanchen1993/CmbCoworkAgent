# 列表、文件和目录参数已接通

开发工作区是 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`，宿主版本 `module-resources-v75`。UAT 未修改。这是持续对齐中的一个完成阶段，整体目标仍进行中。

用户现在可以在“自定义 → Function Mods → 插件参数”中逐项添加、删除文本，手填或选择文件/目录路径，再保存。照常聊天时，真实插件获得对应参数；运行中的任务保留原参数，结束后安全应用。需要执行启动操作的组件仍使用明确重载。文件选择只填草稿，不保存、读取内容或增加权限。旧多项参数原来是一个文本时，不拆逗号或换行，不悄悄改旧值；明确点击保存才改为列表。

列表逐项保留逗号、换行、空项、重复和顺序。真实普通设置列表含非敏感文件/目录文字行；列表不加入普通设置列表。活跃文字/文件/目录参数仍经过原处理链，拒绝、缺行或保护失败不能偷偷改为直接写入。选择器结束、参数发布及实际保存前复核原窗口、项目、字段、代码和保存版本；过期选择不覆盖新草稿，保存结果采用实际提交值。

固定官方依据为 Claude Code 2.1.288 声明/解包运行器与[官方参数说明](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration)，没有把本轮重新宣称成当前最新版本核验。敏感参数是紧接着继续实施的下一阶段，当前不宣称全部参数兼容。

两位独立方案及最终静态检视通过。355 文件、3034 项受控回归通过：`output/mods-special-parameters-controlled-broad.log`；范围记录在 `output/mods-special-parameters-controlled-scope.txt`。全工程已有历史失败不计作通过。Node/Web 类型检查通过，修改范围 lint 为零错误，保留大文件格式及一条既有 Hook 依赖警告：`output/mods-special-parameters-types-closed.log`、`output/mods-special-parameters-lint-final.log`。

真实 React 浏览器 13 场景通过：`output/mods-special-parameters-browser-first.log`。真实 Electron 参数、连续聊天、原聊天保护和用量合计 31 项通过；源码复用后参数/重载的 14 项再次通过且恢复普通构建：`output/mods-special-parameters-electron.log`、`output/mods-special-parameters-electron-cached-final.log`。实际表单增删项、保存、SQLite 版本、独立运行进程的真实 options 与刷新持久化已经验证。选择器的受控回归不冒充操作系统窗口实际点击；本轮尚未验证 OS 原生选择的正向点击。

性能反例使用真实 128 个源码、近 2MiB、64 个参数，保存处理函数实际调用一次设置列表。8 次保存中位由 4073ms 降至 381ms，95 分位由 4157ms 降至 853ms，包含第一次冷读取，不含模型或桌面绘制：`output/mods-parameter-performance.log`、`output/mods-parameter-performance-final.log`。仅复用最多 16 条深冻结的源码编译结果，每次命中仍完整复核真实路径、内容、文件身份及原缺失路径；参数、许可、视图、实例不缓存。频繁的窗口/取消检查不再重复扫描全部源码，真实提交与发布末尾仍保留完整复核。

缓存回归覆盖目录别名换目标、同字节文件替换、恢复文件时间后内容改变、更高优先清单出现、旧包忽略过大清单、容量淘汰及清理。仍不承诺排除外部程序随后修改文件。宿主版本变化后 Function Mods 按实际新摘要重新批准，未自动扩大旧许可。

继续执行 `mods-sensitive-parameters-design-2026-10-04.md`：两位独立方案评审已通过，没有发现可据以停止整体工作的框架限制。
