# Bot 调度实验记录

开始时间：2026-11-18T07:09:22.498Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然要求后台推进方案 | independent | independent | false | 4.8 | 4.7 | 2.7 | passed |
| 修改既有方案 | continue | continue | false | 2.3 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 1.5 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 2.3 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
