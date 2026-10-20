# M05-06 本机对话关联验收

2026-10-20：本片已通过源码、针对性检查和同 profile 原生界面验收，已更新用户预览。完整 M05-04/05、项目/云端适配、真实 IM 仍不在此次完成范围。

## 候选与设计

- 产品基线 `852fc3e466f23486482b21e9ea326aa98f9043f2`；最终 `dd12f43fa588f3ad2e53647842fabfa51af1698a`，分支 `codex/beta-local-unification-m05`，实施工作树干净。中途保全 `ca0369d3`、`884c63c02`。
- 设计 `M05-local-conversation-link-design.md`；原 gpt-6.1-sol/xhigh 唯一实施，root 设计、源码审查、独立测试与原生验收。实施者已停写。
- 任务引用真实会话；两个入口共用 Thread、消息、草稿、目录、模型和 Host 调度。关联既有普通会话不复制、不自动执行；解除后原历史与设置保留。未来 project_session/cloud_session 类型明确预留，当前不假装可用。

## 源码审查

root 已读 Store迁移/journal、主进程双存储握手、Host/Runtime/IPC门禁、数据归属、共用会话、侧栏/文件编辑和草稿队列接线，并审最终增量。早审退修已关闭：deleting门禁下existing保留、created清理失败可重试、preparing恢复仍经真实idle、right expose恢复不被提前阻断、无关普通/项目/远程UI不依赖Bot、同目录保留原文件锁、模型编辑当前Thread、工具卡双向回调、遗留Bot草稿不换目标重发。

- 数据升级保留列/索引/触发器/序号高水位及旧回执原归属；未知复杂schema原子拒绝。
- renderer不能用空闲状态绕Host裸发送；完成/关联身份/来源约束在主进程再次核验。
- owner会话模型/模式工具栏重叠已修，仍复用原ChatContainer；原Bot主对话紧凑样式保留。仅发送按钮在stream未就绪时禁用，没有改发送调度。
- 原普通会话/项目/远程切换不会逐任务查正文。选中会话按revision合并查询，回执每批最多32。无ES改动，无生产性能实测结论。

## 独立检查与实施者证据

统一 Node22：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。

root 独立命令均 exit0：

- `/tmp/m05-06-root-focused.log`：5文件28/28；conversation-link store/service、request-receipts、conversation-transition、draft-sender。命令另含一个不存在的过滤路径 `src/main/ipc/bots-conversation.test.ts`，未声称该路径被执行；真实IPC见下组。
- `/tmp/m05-06-root-runtime.log`：4文件85/85；Runtime58、history-retention8、bots IPC17、thread-classification2。两组不同文件共113项。
- `/tmp/m05-06-root-node.log`、`/tmp/m05-06-root-web.log`：`tsc --noEmit -p tsconfig.node.json/tsconfig.web.json --composite false`通过。最后产品增量仅已审的按钮/CSS及格式整理，不重复无变化检查；最终`git diff --check`通过。

实施者实际完整App的窄旅程：`/tmp/m05-06-app-fifth.log`、修布局后的`/tmp/m05-06-app-final-second.log`均exit0，每次5个localhost固定模型请求。覆盖既有普通Thread→显式关联且0额外执行→Bot/普通两入口连续修改且保留前轮上下文→原文件预览及模型双向一致→完成/裸IPC拒绝/继续→解除保留历史目录→created任务在普通侧栏打开同Thread。不是生产模型或完整MVP测试。

隔离hook检查 `/tmp/m05-06-hook-browser.log`通过：普通/项目/远程0关联lookup/订阅、迟到A不覆盖B、同scope最多1在途。最终增量队列/分类17项、类型、独立build也通过。实施者日志表对删除/恢复检查的命令路径有一处误写为bots.test；真实5/7项输出来自 `src/main/bots/conversation-link-service.test.ts`，root已独立执行该文件并通过7项，以实际日志为准。

早期失败均留在实施记录：旧测试CAS版本、删除失败重试的真实产品缺陷、App错误测试API和未等hydration、临时覆写React Context造成夹具超时。后者已移除，只保留正常只读就绪等待；不把模拟失败称产品缺陷，不以延长超时伪造通过。最终linked截图在继续后瞬间抓到空历史，未据其验收；root在真实预览实际看到完整历史并往返验证。created最终截图已目视接受输入区分行。

## 同 profile 升级与原生检查

- 预览：`/Users/heyirui/.devclaw-bot-b00/runtime/m05-ui-preview-whpkhytt`。
- 升级前确认Bot与Thread无执行中任务，精确停止本人supervisor77648/App77657；完整备份 `/Users/heyirui/.devclaw-bot-b00/runtime/m05-pre-conversation-link-82a36a9bac`。备份在退出后复制，无未合并WAL；只读普通连接失败后以immutable只读核验quick_check与数据。
- 使用已验证的正常生产构建 `/tmp/m05-06-out-843qqwqs`；三部分outDir独立、空envDir，未加载真实凭据构建；原out保全 `/tmp/m05-06-previous-out-82a36a9bac`。未运行测试入口。原launcher/同profile/现有环境重新启动：App91596、supervisor91586、exec session88579。
- Mac锁屏时先请求解锁，用户回复后原生CUA实际检查。两条原任务「示例｜周末读书会通知」「周末吃饭预约通知」均在；示例两轮3点/4点正文完整。普通对话→返回Bot任务→在对话模式打开→Bot主对话→右侧原任务均通过。临时未发送草稿在两入口共享，随后清空并核实；无新增消息或真实模型调用。
- 两入口显示同实际工作目录、deepseek-v4-flash，右侧明确为Bot共享目录。输入与模型/模式无重叠。最终留在读书会任务，右侧任务列表与新入口可见。
- 与停机备份比对通过：两任务ID/标题/状态、全部Thread身份/创建时间/标题、thread_messages、thread_message_fragments、thread_subagent_messages逐行一致；无新增Bot执行；`.env`与custom-models.json哈希一致，不输出凭据。
- 证明：原profile `conversation-link-upgrade.json`，进程记录 `preview-process.json`。不触碰其他应用、Java/IM、容器、自动化或原用户模型文件。

## 完成边界

- [x] M05-06A 引用/本机归属/既有任务与会话接纳恢复。
- [x] M05-06B 共用执行与原数据设置保留。
- [x] M05-06C 右侧任务/普通对话双向入口、实际目录与状态。
- [x] M05-06D 源码/针对性检查/同profile更新与原生UI。

关联任务内 `/goal`、Mods暂需显式解除关联后使用；原设置与历史保留。项目和云端适配尚未实现。全分支包含M05-04未验收WIP，本轮保存在原实施分支并更新预览，没有整分支合并到integration，也没有push/deploy。下一步等待用户UI反馈，不自动恢复04/05完整验证。
