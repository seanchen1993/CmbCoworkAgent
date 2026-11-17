# Bot 调度实验记录

开始时间：2026-11-17T07:32:45.058Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 5 | 3.1 | 未记录 | passed |
| 日常问答 | inline | inline | false | 1.4 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 3 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
