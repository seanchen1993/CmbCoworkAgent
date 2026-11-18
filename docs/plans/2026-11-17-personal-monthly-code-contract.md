# 个人自然月代码入库数据契约

## 目的与交付边界

研发效能页面按人员展示自然月 devagent-ide、devagent-cli、DevClaw 入库行数、累计 AI 入库行数、个人全部 Push 行数及累计 AI 入库代码占比（硅碳比）。

客户端已增加个人月度事实读取；内网 Java 需要按本文补充写入能力。当前仓库不包含该 Java 实现，本文不是内网已完成部署的说明。

## 索引与唯一标识

继续使用 `devclaw_gitee_push_info`。新增 `orgLevel=user`，每人每自然月一条，文档 ID 为 `user:{sapId}:{timeRange}`，例如 `user:80000001:2026-10`。组织记录仍使用 `orgLevel=team/room`。

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| `orgLevel` | keyword | 固定 `user` |
| `timeRange` | keyword | 自然月，`YYYY-MM` |
| `sapId` | keyword | 员工号字符串，与代码遥测 sapId、项目 pm 中的 sapId 一致 |
| `userName` | keyword | 姓名 |
| `teamName` | keyword | 当月统计归属团队 |
| `roomName` | keyword | 当月统计归属室，用于组织筛选 |
| `totalPushedLines` | long | 个人当月全部 Push 行数，包含 AI 和非 AI 代码 |
| `devagentIdePushedLines` | long | devagent-ide 入库行数 |
| `devagentCliPushedLines` | long | devagent-cli 入库行数 |
| `updatedBy` | keyword | 已认证维护人 |
| `updatedAt` | date | GMT+8，`YYYY-MM-DD HH:mm:ss` |

新增字段应先核对并显式补齐 mapping，不依赖动态推断 sapId 的字段类型。已存在字段沿用实际 mapping，不重新创建索引。

## Java 写入要求

扩展现有月度接口，支持 `orgLevel=user` 和 `sapId/userName`，允许指标键 `total`、`devagent`、`devagent-cli`，分别写入上表三个行数字段。

- 计数为非负整数。未提交的指标保留原值，明确提交 0 才写入零。
- 不从组织汇总分摊个人数据，不维护个人 devagent-cloud 数据。
- 不人工维护 DevClaw 入库行数；客户端从代码事件统计。
- 不自动迁移或补造个人历史记录；历史补录使用同一唯一标识更新。
- 更新人员归属组织时更新同一文档，不按室额外创建该人同月的另一条记录。
- 月份边界按 GMT+8 推算。个人渠道月份归属须与客户端现有 DevClaw 口径对齐：代码生成于该自然月且已 Push 的采纳行数。若外部渠道只能提供实际 Push 月份的数据，需要单独确认，不能直接将不同时间口径混成完整结果。

记录示例：

```json
{
  "orgLevel": "user",
  "timeRange": "2026-10",
  "sapId": "80000001",
  "userName": "示例甲",
  "teamName": "零售客户经营开发团队",
  "roomName": "示例室",
  "totalPushedLines": 10000,
  "devagentIdePushedLines": 1000,
  "devagentCliPushedLines": 500,
  "updatedBy": "维护人",
  "updatedAt": "2026-11-17 10:00:00"
}
```

## 客户端计算与缺失处理

看板日期范围为单个完整自然月或连续多个完整自然月时查询个人月度记录。查询固定为 `orgLevel=user`、目标团队、所选月份集合及权限允许的所选室，按 sapId 和月份完整分页，发现同人同月重复记录时将月度数据标为不可用。跨月先逐月累计每个渠道和总 Push 行数，再计算各占比；任一月份或渠道缺失时，对应累计保持缺失。

- DevClaw 行数：本人在精益非测试项目中的已 Push 采纳行数，按生成时间和代码事件的室筛选。
- 累计 AI 入库行数：IDE、CLI、DevClaw 三渠道之和，任一渠道缺失时不展示完整累计值。
- 各渠道入库占比：对应渠道入库行数 ÷ 个人全部 Push 行数 × 100%。
- 硅碳比：累计 AI 入库行数 ÷ 个人全部 Push 行数 × 100%。缺失或零分母不产生比例，不将超过 100% 的事实比例截断。
- 自然月数据参与人员匹配，不单独扩大排名人员范围；人员仍来自有 PM 项目或有合格个人代码记录的并集。
- 月度读取失败不阻止项目和代码指标展示；缺失为“—”，不转换为零。

## 验收

1. 同人同月重复提交更新同一文档；真实零可读取，漏填字段仍为缺失。
2. IDE=100、CLI=40、遥测 DevClaw=60、total=1000 时，累计 AI 行数=200，硅碳比=20%。
3. 部分渠道缺失时保留其他渠道数字，累计及硅碳比不可用。
4. 组织汇总记录、其他月份和权限外室的个人记录不参与计算。
5. 包含不完整月份时不查询月度索引，页面、权重配置及导出均隐藏月度专属指标；项目和个人入库率继续按各自时间规则统计。
6. 选择 2026-07-01 至 2026-09-30 时累计三个月的行数后重算占比；选择 2026-07-01 至 2026-10-30 时不展示月度指标。
