# F03 · 主代理早期审查

2026-10-02 01:52 UTC。审查对象：F03 工作树，HEAD `d590146a106e5fab7f4f672d4050baa31caed15f` 加 C 阶段未提交成果。不是验收报告；原实施者已接续，最终快照仍须独立复验。

## 已执行诊断

使用固定 Node 22，以 `--input-type=module -e` 导入真实 `tests/bot/reference-model.mjs`、`model-helpers.mjs` 与合成 fixtures。没有修改模型或测试文件，没有真实网络/凭据/发布副作用。

| 项目 | 操作及实际结果 | 要求 |
| --- | --- | --- |
| R1 时间比较 | Upload expiresAt=`2026-10-01T12:00:00Z`，now=`2026-10-01T12:00:00.100Z`，实际 `putContent` 成功 | 按实际时间判断，不按 UTC 字符串字典序；统一批准/租约/命令/游标/上传/截止时间，验证等价表示及过期边界 |
| R2 对账原子性 | `startAssessment` 后 Run=starting、Attempt=dispatched；可信 inspection=cancelled 且 lastEventSeq=0/current fence；抛 OUTCOME_UNKNOWN，但 Attempt 已变 accepted | 拒绝时对象、证据及计数不发生部分变更；不得放宽状态表来掩盖失败 |
| R3 Delivery 当前授权 | Delivery 指向当前 Run/Attempt、failed；主体 `resources=[]` 后 retryDelivery 仍成功 | 通过 Run 回溯 Task/Group 做当前资源权限验证；拒绝撤权重发，仍不新增 Run/Attempt |
| R4 工作区只读边界 | prototype 阶段具备准确 workspace.write 工具批准，但已解析 WorkspaceSpec.access=read；createRun 仍 queued | workspace.write 必须被只读工作区拒绝（FORBIDDEN），其他批准不能提升该资源访问边界；派发/恢复仍重新检查 |

以上四项已发给原 `/root/f03_contracts` 修复/补回归，主代理不写实现。修复后的通过结论必须对应后续精确代码快照。

## 接口语义已由主代理补充

- 二进制 If-Match 为严格强 ETag，真实收到字节的摘要参与命令指纹；有限大小校验不能因重试跳过。
- PUT 的 mediaType 来自真实 Content-Type，v1 无参数小写且与 UploadSession 一致。当前草稿 OpenAPI 只声明 application/octet-stream、模型用 text/plain，实施者须统一文档/fixture/验证，不留两个互相矛盾的接口。
- 成功 DevelopmentHandoff 的相同原命令在当前有权读取时返回历史不可变回执；PRD 更新和批准失效约束新写入，不重做历史成功。ApprovalDecision 的过期/失效拒绝仍为显式特殊规则。

## 已阅读及待验证

已阅读生成器、离线 schema/ref runner、类型消费测试、状态表、API 表面、参考模型及主要场景。schema/OpenAPI/生成类型的唯一来源、Bot/Group/Runtime 解耦、状态分层与非生产边界保持明确。package/lock 修改目前限于契约脚本及固定 Ajv 根依赖。

旧 IM 测试句柄 `86442` 已失效，不能记为通过；实施者需收齐新回归证据。待其交回 review_pending 后，主代理重新检查完整 diff、运行契约/类型/IM 回归，并逐项关闭本记录问题，才可接受。

## C4 最小复现独立复跑（02:07 UTC）

主代理再次用固定 Node 22 导入 C4 真实模型，执行原四项最小复现并加入断言，单命令退出 0：

- R1 过期 100ms、日期小数秒表示不同，得到 COMMAND_EXPIRED。
- R2 inspection 拒绝后 `assert.deepEqual(data,before)` 以及 serial 不变。
- R3 撤销任务资源后 Delivery 重试得到 FORBIDDEN。
- R4 只读工作区即使存在准确工具批准，workspace.write 仍得到 FORBIDDEN。

这是 `d590146a` 后 C4 dirty 快照的独立诊断，尚未接受：实施者还在补持久回归、生成类型与完整验证。最终候选提交仍须复跑，不能沿用 dirty 快照结果宣称已完成。

诊断后核对的 Git 内容对象摘要（`git hash-object`，没有写入对象库）：reference-model=`fd993944106e2c6e43c7fbfef7f31bbdd5cf3882`；model-helpers=`dbfe8167de61faa398ce4ba194d49be1d453e2cf`；positive fixtures=`d65ac5ba8a30d7cb09b99566f1076850ba4761f4`；schemas=`5ca4075aa69596671360ad828540e60825634de5`。
