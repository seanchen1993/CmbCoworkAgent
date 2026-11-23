# Bot 长期记忆默认开启与应用设置隔离

## 目的与条件

验证应用全局记忆关闭时，新 Bot 和原来跟随全局的 Bot 仍可使用自己的长期记忆，显式关闭的 Bot 保留原选择。检查 Bot 的设置不会改变应用全局及项目模式的记忆设置。

2026-11-19 14:16–14:22（Asia/Shanghai）。macOS arm64、Node 25.5.0、Electron 39.8.10。基线为 codex/merge-uat-into-bot-beta 的 35aa5a4db7，本轮使用该提交加本地开关改动的隔离构建。Electron 使用临时资料库和本地模拟模型，通过实际 IPC、运行时和 SQLite 读写。未调用在线模型。

## 用例与结果

| 输入 | 验收与实际结果 |
| --- | --- |
| 关闭应用全局记忆，创建未指定记忆设置的 Bot，询问当前长期记忆设置 | 首次模型请求含 5 个 Bot 记忆工具。普通会话的 memory_search 未出现。 |
| 关闭 Bot，查询记忆，再重新开启 | 关闭后模型请求含 0 个 Bot 记忆工具。开启后依次创建、读取、更新和删除同一条偏好，条目 ID 保持一致，更新后的版本变化，删除后列表为空。两次读取的应用全局及项目模式开关均与初始值一致。 |
| 以缺少记忆字段的旧库重启应用 | 同一 Bot、同一会话恢复，首次查询即有 5 个 Bot 记忆工具。SQLite 单元测试另覆盖已存 inherit 迁移为 enabled、显式 disabled 保留，以及旧客户端改名后仍保留设置。 |
| 两个 Bot 在浏览器中交替打开记忆设置 | 缺省开关开启，切换只改变当前 Bot。关闭时仍能编辑已有记忆，保存失败后维持原状态，键盘可重试。Electron 的群聊详情入口也通过。 |

脱敏请求记录来自两次独立的 model-tools.json。新库的 Bot 记忆工具数依次为 5（默认）、0（关闭）、5（重开）。旧库重启后的默认请求为 5。两个模拟服务均记录 0 个请求错误。

## 复现与回归

- npm run test:bot-integration:e2e -- --build-only 生成独立构建。设置 BOT_TEST_APP_OUT 指向该构建，运行 node --import tsx tests/bots-memory-app.spec.ts。设置 BOT_TEST_LEGACY_MEMORY=1 重跑旧库场景。两次退出码均为 0。
- node --import tsx tests/bots-memory-settings-browser.spec.ts 与使用同一构建的 tests/bots-details-cards-app.spec.ts 通过。npm run typecheck 通过。
- Vitest 定向运行 host、runtime-adapter、memory、memory-tools、memory-maintainer、memory-summary-adapter、bot-memory-panel、summarizer-scope 共 8 个文件，736 项通过，耗时 22.85 秒。
- 扩展 Bot 核心回归初跑 4,134 项通过、8 项失败、1 项跳过。放开本机测试端口并复跑原 5 个失败文件后，242 项通过，1 项失败。剩余的 peer-feedback afterModel 用例报 commitTranscriptInjection is not a function，在未修改的基线代码上单独运行也复现。
- 首次补充默认工具清单断言时，脚本按完整消息匹配，未识别用户原文后附加的运行上下文，退出码为 1。请求日志已包含全部 5 个工具。修正脚本的消息匹配后，新库和旧库两条路径均通过。

本轮覆盖 macOS 的真实界面、模型请求内容和持久化行为。模型回复由本地测试服务生成。
