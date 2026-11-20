# Workflow 子代理重复展示修复与验证记录

日期：2026-09-14。基线为当日 `git fetch origin UAT` 后的
`4dedee744f62fa7855489f06e9d78e09d7a3ff6a`，修复分支为
`codex/fix-workflow-output-duplication`。

修复工作树：`C:/Users/87624/AppData/Local/Temp/cmb-workflow-output-fix-20260914`。
对照工作树：`C:/Users/87624/AppData/Local/Temp/cmb-workflow-duplicate-audit-20260914`。
原工作区 `C:/ai/CmbCoworkAgent` 的源码和分支未被本任务修改。
使用 Node 22.22.2，通过 junction 读取既有 node_modules，没有安装或更新依赖。

## 结论与根因

已修复可以稳定复现的 **workflow 子代理完整快照在前部更正后仍残留旧内容** 的展示缺陷。
此前主 agent 的去重修复没有被撤销；本次问题来自后来用于长历史的尾部缓存优化。

以下旧修复均仍是本次 UAT 的祖先：

| 提交       | 日期       | 范围                       |
| ---------- | ---------- | -------------------------- |
| `8bc0f8d8` | 2026-06-04 | 主聊天流式重复与恢复一致性 |
| `6da18fea` | 2026-07-10 | 重开会话的回复重复         |
| `5eb90de5` | 2026-07-11 | 流式消息重复、乱序与恢复   |

Workflow 子代理使用独立的 values 快照路径：生产者序列化完整的、有界的消息列表，
实时 IPC 或完成后的 toolstream 历史读取替换面板快照，再经 converter 和 projector 送入 UI。
该面板此前复用了 `createStreamPanelMessageProjector`：当消息数量及最后 32 条身份不变时，
只更新最后 32 个位置。这个优化隐含了“历史前缀不会更正”的前提，workflow 完整快照并不保证它。
实现可追溯至 `0e2b76bd`（2026-08-21），当前历史经 `c37ef195`（2026-08-30）重新应用。

最小复现：两帧各 40 条，同样的 ID 和顺序。第一帧第 0 条为 `A response 0`；
第二帧第 0 条更正为 `Corrected earlier answer`，第 39 条为 `A response 0`。
第二帧源数据中的旧正文只有一处，但旧投影保留第 0 条旧对象，界面显示两处。
修复前的实际 Electron E2E 在等待首条更正时失败；修复后开发构建和 ASAR 包均通过同一用例。

没有取得用户现场那一次的 runId 和原始帧，因此上述结论针对已复现的展示缺陷，
不代表已证明现场所有重复都由同一条件触发。原始模型/图状态正文自身包含重复时，仍按权威数据展示。
主路径的首次全文回放保护与 workflow 有处理差异，但不能据此删除合法重复文本或不同轮次的回复。

## 变更范围

- 仅将 `WorkflowAgentStreamPanel` 切换为 workflow 专用完整快照 projector。
- 检查全部输入位置，处理前部正文、reasoning、工具参数、结果身份/状态、更换、重排、缩短和清空。
- thread/run/agent 共同限定缓存作用域；相同文本、重复 provider ID 的不同 occurrence 完整保留。
- 沿用现有字段比较，不变消息复用对象；相同帧复用数组，有变化时新建数组，不修改已发布数组。
- converter 每次生成接收时间 `created_at`；比较时忽略该合成时间，避免相同历史仅因接收时间更新而失去引用稳定性。
- 未修改通用 projector、主 agent、普通子代理、生产传输、持久化格式、消息数量/字符预算及 UI 功能。

## 回归与构建

| 检查                                             | 结果                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| 新增 `workflow-agent-message-projection.test.ts` | 7/7 通过；三位检视者分别独立重跑通过                   |
| `tests/stream-panel-message-window.spec.ts`      | 通过，通用尾部投影和分页原测试保持通过                 |
| `tests/electron-transport-subagent.spec.ts`      | 88 个 PASS 输出组通过，涵盖既有主/子代理恢复与全文回放 |
| `tests/workflow-script.spec.ts`                  | 32 项通过                                              |
| `npm run typecheck`                              | Node/web 两部分通过                                    |
| `npm run build`                                  | main/preload/renderer 构建通过                         |
| 变更文件 ESLint                                  | 通过，0 error/0 warning                                |

执行了全库 `npm run lint`，未全绿：99 个 error 中 3 个来自不提交的 `output/` 验证脚本，
另外 96 个位于 46 个未改文件。将这 46 个文件在未修改 UAT 上重跑得到相同的 96 个 error，
并逐文件确认两份源码字节完全一致。全库还有大量既有 CRLF/格式 warning，未进行无关的全仓格式化。
本次提交的四个代码/测试文件单独执行 ESLint 均为 0 error、0 warning，文档与变更代码的格式检查通过。

执行了 `npm test`，未全绿：默认并发下 Vitest 为 380 个文件中 344 通过、36 失败；
2857 项中 2758 通过、68 失败、31 跳过，另有 2 个 worker 错误。
为区分本次回归和基线/并发因素，对这 36 个文件分别在修复分支与未修改 UAT 上以
`--maxWorkers=2` 重跑：**两边均为 361 项、336 通过、21 失败、4 跳过，失败文件和断言名称集合完全一致**。
未新增失败断言。没有将降并发后消失的失败认定为产品修复。

剩余 21 个断言分布于 10 个文件：

| 文件                                                                      | 失败数 |
| ------------------------------------------------------------------------- | -----: |
| `src/main/harness-board/managed-run-store.test.ts`                        |      1 |
| `src/main/utils/open-in-ide.test.ts`                                      |      5 |
| `tests/browser/browser-script-execution-service.test.ts`                  |      1 |
| `tests/browser/chrome/browser-cookie-bridge-server.test.ts`               |      3 |
| `tests/browser/chrome/browser-extension-popup.test.ts`                    |      2 |
| `tests/browser/chrome/browser-extension-service-worker.test.ts`           |      3 |
| `src/main/services/im/native-adapter-integration.test.ts`                 |      3 |
| `src/renderer/src/lib/harness-plugin-run-artifacts-isolation.test.ts`     |      1 |
| `src/renderer/src/lib/theme-surface-policy.test.ts`                       |      1 |
| `src/renderer/src/components/harness-board/harness-settings-lazy.test.ts` |      1 |

由于 `npm test` 的串行链会在首个套件失败后停止，另外逐条执行了其后续 9 组脚本中的全部
84 条命令，78 条通过、6 条未通过；6 条均在未修改 UAT 上复现：

| 命令文件                                   | 基线与修复分支结果                                   |
| ------------------------------------------ | ---------------------------------------------------- |
| `workflow-worktree.spec.ts`                | 180 秒超时                                           |
| `local-sandbox-worktree-isolation.spec.ts` | Windows PowerShell 对 `-W` 参数的歧义错误            |
| `thread-checkpoint-cleanup.spec.ts`        | 写默认用户数据路径触发 EPERM                         |
| `sandbox-elevated.unit.spec.mjs`           | 同样的 2 个旧 workflow notification 源码约束断言失败 |
| `im-desktop-completion.spec.ts`            | 同样的 managed completion 源码约束断言失败           |
| `im-remote-approval.spec.ts`               | 同样的远程审批断言失败                               |

这些基线失败未混入本次展示修复。完整日志与 JSON 对照保存在本地 `output/workflow-output/`，不提交运行日志。

## Electron E2E

新增 `tests/workflow-output-e2e.spec.ts`，构建后运行：

```powershell
npx tsx tests/workflow-output-e2e.spec.ts
```

使用真实 Electron 窗口、preload、IPC 通道、生产 serializer/converter 与 React 面板；
fixture 替换 workflow hydrate、interest、历史读取的 main handlers，并用独立磁盘 sidecar 提供历史。
测试覆盖 UI 消费完整快照和重新读取磁盘历史，不覆盖生产 run-store writer、toolStreamKey 解析或真实模型生产者。
测试使用一次性用户目录，不读取用户会话，不调用模型。

开发版与用户提供的 1.5.2 包的隔离副本均通过：

1. 运行中修正第 0 条，旧正文仅在第 39 条保留一处，无需等运行结束。
2. 重复帧不产生新气泡；其他 run/agent 的事件不覆盖当前视图。
3. 两个子代理使用相同 provider ID 时来回切换，历史正确隔离。
4. 连续 60 个 400 条快照，DOM 消息行保持 240；尾页为 `160..399`，前一页为 `80..319`，返回最新恢复 `160..399`。
5. 完成后使用磁盘中的权威更正；重载页面后仍正确，历史读取至少 2 次，page errors 为空。

开发版 60 帧与分页约 11.54 秒，打包版约 11.66 秒；这个时间含 UI 等待和往返，不能当作 CPU 帧成本。
截图和结果位于 `output/workflow-output/e2e/` 与 `output/workflow-output/packaged-e2e/`。
旧 UAT 在相同 fixture 下等待 `Corrected earlier answer` 超时，截图位于对照工作树的
`output/workflow-output/baseline-e2e/`。

额外运行既有普通子代理工具顺序 E2E：原脚本存在窗口未就绪和开发入口路径问题；
仅在不提交的临时 fixture 副本中等待首窗口并使用项目根作为 Electron 入口后，全部断言通过，
包括工具 A/B 顺序、落库、重载、正文/reasoning 独立更正、显式清空、旧 ACK 和续写。
既有主聊天 `stream-snapshot-e2e.spec.ts` 在“reasoning-only snapshot preserves existing body”处超时，
未修改 UAT 上相同断言也超时，未宣称该套件通过。

## 性能对照

使用生产 serializer 生成 400 条、JSON 编码 888251 字符的快照，每条含嵌套工具参数。
比较旧通用 projector 与新专用 projector，六轮交替执行顺序，每轮先预热 20 帧，再测量 300 帧。
每帧重新 JSON 解码，再经过真实 workflow converter 和 projector，避免只复用输入引用的虚假快路径。

下表是六轮“每帧平均耗时”的中位数：

| 指标                              |   旧实现 |   修复后 |
| --------------------------------- | -------: | -------: |
| JSON 解码 + converter + projector | 2.539 ms | 3.173 ms |
| projector 自身                    | 0.006 ms | 0.540 ms |
| 尾消息更新时变化的消息对象引用数  |       32 |        1 |

全量校验有约 0.63 ms/帧的链路成本，换取正确的前部更正和更稳定的消息引用。
变化引用数不是实测 React 重渲染次数；该微基准不含 IPC、React 渲染和绘制，也不是所有合法结构的最坏情况上界。
实现线性检查有界快照，只保留上一份投影，不累积帧。独立性能检视认为成本符合预期，无需扩大修复范围。

## ASAR 验证包

从用户提供的 `C:/Users/87624/Downloads/CMBDevClaw-win-unpacked-1.5.2 (1)` 完整复制到隔离工作树的
`output/workflow-output/packaged/`，在副本中替换 app.asar，原包未修改。
保留原依赖与原生模块的 unpack 规则，使用本次 UAT 修复构建的 out 和 package.json。
原归档引用的 6 个实际缺失的开发元数据文件被显式忽略，未忽略运行时文件缺失。
Packaged fixture 使用与开发 launcher 相同的 GPU 测试参数。

- 原 ASAR SHA-256：`f5b3cf1e6b90bed55bd817cfda82ce354989314649910ad70539f5f53c179a64`
- 验证 ASAR SHA-256：`0cfad765f7923557c9d2e36e95b66e65608126a47e0d1cff2b3d23547e85cc3c`
- 本地程序：`output/workflow-output/packaged/CMBDevClaw.exe`
- 本地 ASAR：`output/workflow-output/packaged/resources/app.asar`

## 三个独立代码检视

按用户要求，三位子 agent 均以 **medium** 思考强度执行独立只读检视：

| 检视者               | 重点与结论                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `review_correctness` | 正确性、合法重复、作用域、生命周期、不可变数组；7/7 单测通过，无阻塞问题    |
| `review_performance` | 有界成本、上下游、memo 与范围；7/7 单测通过；复核性能原始数据后仍无阻塞问题 |
| `review_regression`  | 原缺陷回归、E2E 真实性和覆盖；7/7 单测通过；提出 P3 分页断言不足            |

P3 已修复：增加分页前后首尾 ID 断言和等待，开发与打包 E2E 重跑通过；
检视者再次复核并确认关闭。所有检视均无未解决的可行动问题。
三位未独立重跑全量与打包 E2E，结果由主 agent 执行并留存，报告没有将静态检视当作实际执行。
仅在上述检视完成并关闭建议后提交本次修复，提交说明使用详细中文，不推送或合并 UAT。
