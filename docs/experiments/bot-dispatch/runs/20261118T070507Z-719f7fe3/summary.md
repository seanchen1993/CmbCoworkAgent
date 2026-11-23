# Bot 调度实验记录

开始时间：2026-11-18T07:05:07.312Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 多材料筹备方案及交付 | independent | independent | false | 4.1 | 4 | 2.1 | passed |
| 修改既有方案 | continue | continue | false | 3 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 2.2 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 3.2 | 未记录 | 未记录 | passed |
| 自然要求后台推进方案 | independent | independent | false | 2.9 | 2.9 | 1.3 | 发生错误，见原始记录 |

运行错误：case failures; inspect JSON report
