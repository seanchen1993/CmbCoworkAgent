# Claude Code 2.1.284 兼容增量：独立 HTTP 与 Electron 验收

验收分支：`codex/mods-v2`。使用主任务冻结后的普通生产构建、Node 22，未修改生成产物，所有 Electron 脚本串行运行。

## 结果

| 脚本或焦点 | 通过检查组 | 结果 |
| --- | ---: | --- |
| `mods-e2e.spec.ts` / `model-http-284` | 7 | 通过 |
| `mods-e2e.spec.ts` / `file-metadata` | 5 | 通过 |
| `legacy-plugin-project-e2e.spec.ts` | 7 | 通过 |
| `mods-flow-e2e.spec.ts` | 9 | 通过 |
| `mods-composition-e2e.spec.ts` | 11 | 通过 |
| `mods-claw-sources-e2e.spec.ts` | 10 | 通过 |
| 合计 | 49 | 六个进程均退出 0 |

这里统计的是脚本报告的业务检查组，不能理解为 49 个独立单元测试；两个新焦点分别包含全局默认关闭检查。旧四个脚本耗时分别为 13.18、59.19、25.13、24.55 秒。

## 新能力的真实链路

新焦点实际上传 ZIP、授权并在生产聊天输入区发送命令，经过 IPC、QuickJS 和真实宿主模型适配器，连接专用本机 HTTP 模型服务。未使用 `stubFunctionModels`。

- `result-v1` 冷 fork 返回 `nothing-to-fork`，没有模型请求。
- 成功请求返回文本和四个归一化 usage 字段；空响应和 HTTP 400 返回不同的有界结果，原始 provider 错误正文不泄漏。
- 同时安装的旧协议插件仍收到字符串。
- 不同模型协议观察者冲突在 matcher、handler 和 provider 请求之前被拒绝，即使 matcher 不匹配也不绕过协议检查。
- 插件 HTTP 经每跳独立批准的重定向后得到 gzip 解码文本；宿主覆盖插件的 Accept-Encoding；内容保护先于插件 after-hook，中文和 emoji 保持完整。
- 文件元数据焦点验证真实链接及 canonical 元数据、工作区边界、撤权期间拒绝发布，以及 Mods 关闭时原生文件读取。

## 存量功能

旧 Plugin 项目模式覆盖默认关闭 Mods 时的 ZIP、Skill、Hook、MCP、Harness 发现，旧界面、启停、真实项目/worker 权限、重启持久化、开启 Mods 但无授权时的原行为，以及卸载后的可恢复状态。

Flow 覆盖真实业务测试失败后的修复、单输入启动、人工确认、取消、模型顺序随配置改变、Autobiz 原生 checkpoint 提交和重启不重放。组合测试覆盖 A+B 真实输出传递、线程绑定隔离、角色模型、默认模型、撤权和不同窗口宽度的侧栏。来源测试覆盖 Skill/MCP 选择、空选择、缓存刷新、子线程继承、原生 Skill 真实读取及 Pre/Post、MCP 到插件的结构化输出、PreSkillUse 否决和定义持久化。

未发现这些已执行路线的生产回归。该结论不代替未执行模块的验收，也不等于任意第三方 provider、所有插件或外网服务均已兼容。

## HTTP 边界测试

`http-sdk.test.ts` 与 `http-session.integration.test.ts` 共 45 项通过，含真实服务器与 QuickJS：gzip/deflate/br、UTF-8 分块、wire/decoded 各 256 KiB 恰好允许及超限拒绝、损坏/截断压缩、压缩炸弹、编码链和未知编码拒绝、deflate 不猜 raw、HEAD/204/304 空体、重定向、取消、超时、撤权和内容保护。

生产实现已由另外两位 agent 独立只读检视。认证和 socket 等未支持能力保留原边界。返回文本已经解压，响应头保留服务器原始的压缩传输元数据，调用方不应按头再次解压文本。

## 首次失败的复核

首次新焦点中，旧插件命令没有参数，输入区仍展示斜杠补全菜单，因此发送按钮不可用。前面的结果协议命令已通过；失败不是任务结束后无法解锁输入框。测试给忽略参数的旧命令增加 `normal` 参数，再按相同用户链路执行，六个脚本全部通过。仅修改测试输入，没有修改生产交互或添加固定 sleep。

## 证据

全部相对路径均以仓库根目录为基准：

- `output/claude-code-2.1.284-analysis/e2e-<名称>.log`：六组执行日志。
- `output/claude-code-2.1.284-analysis/legacy-production-e2e-results.json`：旧四组退出码、检查组数和耗时。
- `output/claude-code-2.1.284-analysis/e2e-model-http-284/model-http-284-evidence.json`：模型请求、实际结果、HTTP 请求与批准、审计证据。
- `output/claude-code-2.1.284-analysis/e2e-model-http-284/model-http-284-results.png` 和 `model-http-284-conflict.png`：真实应用截图。
- `output/claude-code-2.1.284-analysis/e2e-model-http-284-initial-fixture.log` 及焦点目录 `failure.png`：保留的首次测试输入失败证据，不属于最终执行结果。
- 各 `e2e-<名称>/` 目录：最终运行报告和截图。
- `output/mods-http-compression-tests.log`、`output/mods-http-compression-types.log`：45 项 HTTP 测试与 Node 类型检查。
- `output/claude-code-2.1.284-analysis/http-regression-lint-final.log`：HTTP 三文件及新 Electron helper 的最终 lint。
