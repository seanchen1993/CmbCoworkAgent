# Bot 调度实验记录

开始时间：2026-11-17T10:28:11.834Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 日常问答 | inline | inline | false | 1.7 | 未记录 | 未记录 | passed |
| 多材料筹备方案及交付 | independent | independent | false | 3.2 | 3.1 | 2.1 | passed |
| 修改既有方案 | continue | continue | false | 2.8 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 1.8 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4.6 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
