# Bot 调度实验记录

开始时间：2026-11-17T03:07:21.689Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | independent | independent | false | 7.2 | 5 | 未记录 | passed |
| 不再选择技能，继续原任务修改并回传 | continue | continue | false | 6.4 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
