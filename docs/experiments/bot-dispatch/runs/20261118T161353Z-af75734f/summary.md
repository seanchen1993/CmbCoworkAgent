# Bot 调度实验记录

开始时间：2026-11-18T16:13:53.473Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | independent | independent | false | 10 | 9.9 | 未记录 | passed |
| 复核后等本人批准再发送 | independent | independent | true | 8.8 | 8.7 | 未记录 | passed |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 8.3 | 4.1 | 2.1 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.6 | 2.6 | 2.3 | passed |
| 日常问答 | inline | inline | false | 6.7 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 17.9 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
