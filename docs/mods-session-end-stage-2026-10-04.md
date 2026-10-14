# 真正结束会话：本阶段验收

本阶段已完成，开发位置为 C:/ai/CmbCoworkAgent-mods-v2，分支 codex/mods-v2。对照的是固定并校验过的 Claude Code 2.1.288，未冒称它是当前最新版本。宿主版本 module-resources-v80，已有 Function 组件需按原界面重新批准。

## 用户能感受到什么

删除已经使用过的会话、真正退出应用时，组件能收到一次 session.end，分别看到 clear 和 logout。原有退出脚本先运行，组件再保存自己的短记录。所有组件共用 1.5 秒，包括等待 SDK 的时间；超时后继续原删除或退出流程。没有用过的会话不会为通知而启动组件。

重载、撤权和换组合属于组件清理，不冒充会话结束。通知携带原会话编号，不能据此声称恢复了完整历史。删除后续操作失败时，已结束的旧实例退休；会话仍存在的话，下一次明确操作可建立新实例，退出通知不重放。

真实退出还保留原经典脚本的共同 5 秒期限。给尚在运行的 Mods 包装和后台回调附着同一停止边界，不改变原脚本的取消信号，不提前释放真实仍在执行的占用；组件退出通知随后获得独立的 1.5 秒。普通周期任务、进程和迟到回包不能借过期调用继续工作，真正资源清理仍被允许。

## 发现并修复的问题

真实 Electron 验证发现，原 SessionEnd 匹配和 Mods 输入有 reason，经典命令及 HTTP 的实际输入却漏了该字段。已在原输入生成处仅为 SessionEnd 补上 clear、logout 或默认 other，其他事件不增加它。

同时补上退出开始时仍在加载的新实例的停止边界，防止它随后启动并绕过退出期限。共同期限使用两个真实进程的单调时钟；Windows Electron 实际八次往返采样通过，不能把这个结果推广为所有操作系统都已经验证。

最初的测试包未激活原经典插件退出脚本，随后 Windows bash 选中了未初始化的 WSL；这两轮属于测试设置失败，记录保留。本轮改用应用已有 Hook 设置入口及实际 PowerShell 执行，并验证脚本真正完成、读取正确 reason、随后才通知 Mods。此场景证明原命令退出入口，不冒称单独验证了旧 Plugin 项目模式的所有功能。

## 验证结果

| 验证 | 实际结果 | 记录 |
| --- | --- | --- |
| 冻结受控广域，含 Plugin、Harness、IM、Goal 邻近用例 | 370 文件、3171 项通过 | output/mods-session-end-controlled-broad.log；mods-session-end-controlled-broad-scope.txt |
| 真 main 与 utility process 单调时钟 | 八次实际采样通过 | output/mods-validation/e2e-shared-clock/shared-monotonic-clock.json |
| QuickJS 共同期限、冻结日历时钟、模块取消与迟到回包 | 3 文件、22 项通过 | output/mods-session-end-clock-qualified.log |
| 原工作忽略取消时，调用等待有界、真实占用保留 | 实际 5 秒用例及重叠退出通过 | manager.test.ts；mods-session-end-drain-qualified.log |
| 实际 Electron 删除、退出和挂起组件 | 5 检查点通过 | output/mods-validation/e2e-session-end/result.json |
| 实际 Electron 原配置、连续聊天、原生资源 | 14、8、7 检查点通过 | output/mods-session-end-electron-qualified.log |
| Node/Web 类型 | 通过 | output/mods-session-end-types-final.log |
| 本阶段 34 个代码文件 lint | 0 错误，3998 条已有风格警告 | output/mods-session-end-lint-final.json |

两位独立方案和最终静态检视均通过，最后的加载边界和 reason 补丁也单独复核。真实 Electron 共 34 个检查点通过，测试结束后恢复普通构建，out/main/mods-e2e.js 不存在。截图 session-end-before-delete.png 及实际 clear/logout 回执位于 e2e-session-end 目录。

全工程仍有已知测试和 lint 债务；这里的受控广域通过不能写成 npm test 或全工程 lint 全绿。记录实际命令退出码，不以日志中出现 PASS 代替完整成功。

## 性能和仍未覆盖的范围

真实应用退出约 4.49 秒，包含原脚本、通知和原关闭步骤；其中挂起组件也没有无限阻止退出。正常组件实际读取的总预算为 1500ms 左右。原输入只多一个 SessionEnd 字段，不增加其他事件调用。

本次广域的真实 QuickJS 样本：100 段回答约 61–67ms，100 段进程输出约 81–90ms，原生产者各一次、缓存最多一段、残留帧和回包均为零。300 次原生预算读取中位 6.27ms、95 分位 10.63ms，无 SDK 请求。数据位于 mods-stream-budget-performance.json 和 mods-hook-budget-performance.json；不包含网络、IPC、绘制，也不保证整应用响应时间。

Mac/Linux 的实际跨进程时钟未验证，CLI /clear 和恢复入口不能照搬为桌面新增按钮。普通 UI、周期任务和自定义服务函数不是自动注册 Hook，不能仅凭缺少 10 秒参数就认定缺口；后续分别核验其原版行为。消息和附件等可适配项仍继续，不在阶段完成时停止整体目标。
