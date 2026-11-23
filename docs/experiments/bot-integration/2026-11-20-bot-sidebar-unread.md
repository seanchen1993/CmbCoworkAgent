# Bot 侧栏蓝点与私聊连接提示

2026-11-20（Asia/Shanghai）。在 `codex/merge-uat-into-bot-beta` 的 `6c9194b80` 和本地修复上验证。环境为 macOS arm64、Node 25.5.0、Electron 39.8.10。使用 SQLite 测试库、独立 Electron 用户目录和模拟的招乎连接状态，未使用模型或真实招乎账号。

## 问题与验收

侧栏蓝点汇总了主对话和独立任务的未读。原来打开主对话只确认主对话版本，有未读任务时蓝点会一直亮。修复后，打开 Bot 时还确认本次看到的任务动态版本，任务正文保留自己的未读位置。验收同时覆盖置顶入口、普通入口、切换到群聊后出现的新动态，以及在线、离线、无绑定的私聊提示。

## 运行结果

| 检查 | 结果 |
| --- | --- |
| 修改前单独运行新增的 SQLite 用例 | 1 项失败，旧实现对 Bot 任务汇总的已读请求返回「会话类型无效」。 |
| 修改后运行 Bot 任务、IM 通道、模拟通道、IPC 和前端未读回归 | 5 个文件，259 项通过，耗时 77.20 秒。已确认旧版本回执不会清除较新的任务动态，打开 Bot 也不会把单条任务正文标为已读。 |
| 打开置顶 Bot，再切换到群聊并注入新任务动态，取消置顶再打开 | 在 Electron 中实际点击，蓝点第一次消失，离开后收到新动态再次亮起，第二次打开再次消失。 |
| 私聊连接状态 | 在线时只显示绿点和「已连接招呼」，离线切换为灰点和「招呼已离线」，移除绑定后状态提示消失。 |
| 完整群聊桌面回归 | 通过，退出码 0。覆盖私聊与群聊切换、已读隔离、任务预览与跳转、分页、离线记录、取消绑定及布局。 |

第一次启动桌面测试时临时目录缺少生产 CSS，未进入界面。构建后，旧测试又先后在任务预览和任务行双按钮处停止。测试原来直接等待任务会话，且用任务标题同时匹配预览和跳转按钮。按当前界面补上预览中的打开动作，并对跳转使用准确的按钮名，随后完整桌面回归通过。上述重跑不累计样本数。

## 复现

- 数据侧运行 `node node_modules/vitest/vitest.mjs run --maxWorkers=2 src/main/bots/work.test.ts src/main/bots/im-channel.test.ts src/main/bots/mock-channel.test.ts src/main/ipc/bots.test.ts src/renderer/src/lib/bot/bot-unread.test.ts`。
- 桌面侧将 `BOT_TEST_APP_OUT` 指向含生产样式和 `artifacts` 目录的隔离构建，运行 `node --import tsx tests/bots-im-conversation-browser.spec.ts`。添加 `--private-sidebar` 可单独复现截图中的交互。
- 桌面测试输出包含 `PASS: pinned and unpinned Bot overview read cursors and personal connection status`。本次验证范围为本地客户端展示和已读存储。
